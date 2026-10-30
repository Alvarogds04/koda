"use strict";

/**
 * Abito island accounts and native authentication (U2).
 *
 * Named accounts live under `<island>/accounts/<strict-id>/` with one private
 * `auth.json` each (written only by the SDK helper child) and a public
 * `account.json` that never contains secrets. All contact with the installed
 * Pi SDK happens in a short-lived helper child (`sdk-helper.mjs`) started in a
 * clean environment: no provider keys, no PI_* setup, island HOME/TMPDIR.
 * The user's own Pi credentials are never imported.
 *
 * Seams: `helper` ({command,args,env}) replaces the child (tests use a local
 * fixture); `sdkModule` points the helper at a specific SDK package.
 *
 * Secrecy: secrets travel parent -> helper only (stdin), are never logged,
 * emitted, or returned; every error that reaches a caller is a fixed phrase.
 */

const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const { chmodSync, existsSync, lstatSync, readdirSync, readFileSync, rmSync } = require("node:fs");
const path = require("node:path");
const { validateCustomBaseUrl, validateLocalBaseUrl, validateLocalModelIds } = require("./protocol.cjs");
const { CustomProviderError, discoverModels } = require("./custom-provider.cjs");
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const winfs = require("./win-fs.cjs");
const { ENV_ALLOWLIST, assertSecurePath, ensurePrivateDir, writePrivateFile } = require("./isolation.cjs");

const STRICT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DEFAULT_PROMPT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_FLOW_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const CANCEL_GRACE_MS = 2_000;
const MAX_RECORD_BYTES = 1024 * 1024;

/**
 * Fixed, NON-secret apiKey of local endpoints: it only makes the model "available" to Pi (Ollama,
 * LM Studio, llama.cpp and vLLM ignore it). Never taken from a client; real keys only travel via
 * auth_start / auth_reply, which are refused for local accounts.
 */
const LOCAL_PLACEHOLDER = "abito-local-endpoint";
const LOCAL_API = "openai-completions";

const GENERIC_LOGIN_FAILURE = "Sign-in did not complete";
const GENERIC_REQUEST_FAILURE = "Request failed";

function isStrictAccountId(value) {
	return typeof value === "string" && STRICT_ID.test(value) && value !== "." && value !== "..";
}

/**
 * Clean environment for the helper child: OS essentials only, island HOME,
 * XDG and TMPDIR. Provider keys, PI_* variables and any other ambient
 * variable are dropped.
 */
function helperEnv(base, { home, tmp }) {
	const env = {};
	for (const key of ENV_ALLOWLIST) {
		const value = base[key];
		if (typeof value === "string" && value !== "") env[key] = value;
	}
	if (!env.PATH) env.PATH = "/usr/bin:/bin";
	env.HOME = home;
	env.TMPDIR = tmp;
	env.XDG_CONFIG_HOME = path.join(home, ".config");
	env.XDG_DATA_HOME = path.join(home, ".local", "share");
	env.XDG_CACHE_HOME = path.join(home, ".cache");
	env.XDG_STATE_HOME = path.join(home, ".local", "state");
	return env;
}

const fail = (message) => new Error(message);

/** The human-facing refusal when the account's credential files are not private to this user (Windows, HU-061). Fixed text, no paths, no secrets. */
const STORE_NOT_PRIVATE_MESSAGE = "Los archivos de tu cuenta no son privados en este equipo. Quitá la cuenta y volvé a iniciar sesión.";
class CredentialStoreError extends Error {
	constructor() {
		super(STORE_NOT_PRIVATE_MESSAGE);
		this.name = "CredentialStoreError";
		this.code = "store_not_private";
	}
}

function accountDto(meta) {
	return {
		accountId: meta.accountId,
		label: meta.label,
		provider: meta.provider,
		authMethod: meta.authMethod,
		configured: meta.configured === true,
		...(meta.kind === "local" ? { local: true } : {}),
		...(meta.kind === "custom" ? { custom: true } : {}),
	};
}

function providerDto(p) {
	const methods = Array.isArray(p.methods) ? p.methods.filter((m) => m === "oauth" || m === "api_key") : [];
	return { id: String(p.id), name: String(p.name ?? p.id), methods, configured: p.configured === true };
}

function modelDto(m) {
	return {
		provider: String(m.provider),
		id: String(m.id),
		name: String(m.name ?? m.id),
		reasoning: m.reasoning === true,
		input: Array.isArray(m.input) ? m.input.filter((v) => v === "text" || v === "image") : [],
		contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : 0,
	};
}

function slugify(label) {
	const slug = label
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return slug || "account";
}

/** One short-lived helper child: JSONL out, correlated results, optional stream callback. */
class HelperSession {
	constructor(spec, onRecord, onClose) {
		this.pending = new Map();
		this.nextId = 0;
		this.closed = false;
		this.buffer = "";
		this.onRecord = onRecord;
		this.onClose = onClose;
		this.child = spawn(spec.command, spec.args ?? [], { env: spec.env, stdio: ["pipe", "pipe", "pipe"] });
		this.child.stdout.setEncoding("utf8");
		this.child.stdout.on("data", (chunk) => this.push(chunk));
		this.child.stderr.on("data", () => {}); // drained, never surfaced or logged
		this.child.stdin.on("error", () => {});
		this.child.on("error", () => this.finish());
		this.child.on("close", () => this.finish());
	}

	push(chunk) {
		this.buffer += chunk;
		if (this.buffer.length > MAX_RECORD_BYTES * 2) {
			this.buffer = "";
			this.kill();
			return;
		}
		for (;;) {
			const lf = this.buffer.indexOf("\n");
			if (lf === -1) break;
			const line = this.buffer.slice(0, lf);
			this.buffer = this.buffer.slice(lf + 1);
			if (line.trim() === "") continue;
			let record;
			try {
				record = JSON.parse(line);
			} catch {
				continue;
			}
			if (record.type === "result") {
				const entry = this.pending.get(record.id);
				if (entry) {
					this.pending.delete(record.id);
					clearTimeout(entry.timer);
					entry.resolve(record);
				}
			} else {
				this.onRecord?.(record);
			}
		}
	}

	/** Sends a request; resolves with the result record, never rejects with helper detail. */
	request(command, timeoutMs) {
		return new Promise((resolve, reject) => {
			if (this.closed) return reject(fail(GENERIC_REQUEST_FAILURE));
			const id = ++this.nextId;
			const entry = { resolve, reject, timer: undefined };
			if (timeoutMs) {
				entry.timer = setTimeout(() => {
					this.pending.delete(id);
					this.kill();
					reject(fail(GENERIC_REQUEST_FAILURE));
				}, timeoutMs);
			}
			this.pending.set(id, entry);
			this.write({ id, ...command });
		});
	}

	write(record) {
		if (this.closed || !this.child.stdin.writable) return;
		this.child.stdin.write(`${JSON.stringify(record)}\n`);
	}

	kill() {
		try {
			this.child.kill("SIGKILL");
		} catch {}
	}

	/** Ends the child: close stdin so it exits, and force it if it lingers. */
	end() {
		if (this.closed) return;
		try {
			this.child.stdin.end();
		} catch {}
		const timer = setTimeout(() => this.kill(), 1_000);
		timer.unref?.();
	}

	finish() {
		if (this.closed) return;
		this.closed = true;
		for (const [, entry] of this.pending) {
			clearTimeout(entry.timer);
			entry.reject(fail(GENERIC_REQUEST_FAILURE));
		}
		this.pending.clear();
		this.onClose?.();
	}
}

class AccountManager extends EventEmitter {
	/**
	 * @param {object} options
	 * @param {string} options.accountsRoot  `<island>/accounts`
	 * @param {{command:string,args?:string[],env:object}} [options.helper]  child seam
	 * @param {string} [options.sdkModule]  SDK package dir/entry for the default helper
	 * @param {(accountId:string)=>boolean} [options.inUse]  true when a profile references the account
	 */
	constructor(options) {
		super();
		this.accountsRoot = path.resolve(options.accountsRoot);
		this.log = options.log ?? (() => {});
		this.inUse = options.inUse ?? (() => false);
		this.promptTimeoutMs = options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
		this.flowTimeoutMs = options.flowTimeoutMs ?? DEFAULT_FLOW_TIMEOUT_MS;
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.helper = options.helper ?? this.defaultHelper(options);
		this.flow = undefined;
		this.mutating = 0;
		this.queue = Promise.resolve();
		this.sessions = new Set();
	}

	defaultHelper(options) {
		const island = path.dirname(this.accountsRoot);
		const home = path.join(island, "home");
		const tmp = path.join(island, "tmp");
		const env = helperEnv(options.env ?? process.env, { home, tmp });
		if (options.sdkModule) env.ABITO_SDK_MODULE = options.sdkModule;
		return {
			command: process.execPath,
			args: [path.join(__dirname, "sdk-helper.mjs"), "--accounts-root", this.accountsRoot],
			env,
		};
	}

	get currentFlowId() {
		return this.flow?.id;
	}

	// ----- account store -------------------------------------------------

	accountDir(accountId) {
		if (!isStrictAccountId(accountId)) throw fail("Invalid account id");
		return path.join(this.accountsRoot, accountId);
	}

	readMeta(accountId) {
		let dir;
		try {
			dir = this.accountDir(accountId);
			const stats = lstatSync(path.join(dir, "account.json"));
			if (!stats.isFile()) return undefined;
			const meta = JSON.parse(readFileSync(path.join(dir, "account.json"), "utf8"));
			if (meta?.accountId !== accountId || typeof meta.provider !== "string") return undefined;
			return meta;
		} catch {
			return undefined;
		}
	}

	requireMeta(accountId) {
		const meta = this.readMeta(accountId);
		if (!meta) throw fail("Unknown account");
		return meta;
	}

	writeMeta(meta) {
		const clean = {
			accountId: meta.accountId,
			label: meta.label,
			provider: meta.provider,
			authMethod: meta.authMethod,
			configured: meta.configured === true,
			createdAt: meta.createdAt,
			...(meta.kind === "local" || meta.kind === "custom" ? { kind: meta.kind } : {}),
		};
		writePrivateFile(path.join(this.accountDir(meta.accountId), "account.json"), `${JSON.stringify(clean, null, 2)}\n`);
		return clean;
	}

	/** Public DTOs of every account, sorted by id. */
	listAccounts() {
		let entries;
		try {
			entries = readdirSync(this.accountsRoot, { withFileTypes: true });
		} catch {
			return [];
		}
		return entries
			.filter((e) => e.isDirectory() && isStrictAccountId(e.name))
			.map((e) => this.readMeta(e.name))
			.filter(Boolean)
			.map(accountDto)
			.sort((a, b) => a.accountId.localeCompare(b.accountId));
	}

	/** Serializes mutations of the store; each runs only after the previous one settled. */
	mutate(fn) {
		this.mutating += 1;
		const run = this.queue.then(fn, fn);
		this.queue = run.then(
			() => {},
			() => {},
		);
		return run.finally(() => {
			this.mutating -= 1;
		});
	}

	assertIdle() {
		if (this.flow) throw fail("Authentication busy: a sign-in is in progress");
	}

	async createAccount({ accountId, label, provider } = {}) {
		if (typeof label !== "string" || label.trim() === "" || label.length > 80 || /[\u0000-\u001f]/.test(label)) {
			throw fail("Invalid account label");
		}
		if (typeof provider !== "string" || !STRICT_ID.test(provider)) throw fail("Invalid provider");
		return this.mutate(async () => {
			ensurePrivateDir(this.accountsRoot);
			let id = accountId;
			if (id !== undefined) {
				if (!isStrictAccountId(id)) throw fail("Invalid account id");
				if (existsSync(this.accountDir(id))) throw fail("Account already exists");
			} else {
				const base = slugify(label);
				id = base;
				for (let n = 2; existsSync(this.accountDir(id)); n++) id = `${base.slice(0, 56)}-${n}`;
			}
			ensurePrivateDir(this.accountDir(id));
			const meta = this.writeMeta({
				accountId: id,
				label: label.trim(),
				provider,
				authMethod: "none",
				configured: false,
				createdAt: new Date().toISOString(),
			});
			return accountDto(meta);
		});
	}

	/** Private models.json of a local account: endpoint + model ids + the fixed placeholder. */
	writeLocalModels(accountId, provider, baseUrl, modelIds) {
		const doc = { providers: { [provider]: { baseUrl, api: LOCAL_API, apiKey: LOCAL_PLACEHOLDER, models: modelIds.map((id) => ({ id })) } } };
		writePrivateFile(path.join(this.accountDir(accountId), "models.json"), `${JSON.stringify(doc, null, 2)}\n`);
	}

	/**
	 * Creates a named account bound to a loopback OpenAI-compatible endpoint. No secret is involved:
	 * auth.json holds only the fixed placeholder so activation's "signed in" check passes.
	 */
	async createLocalAccount({ accountId, label, baseUrl, modelIds } = {}) {
		if (typeof label !== "string" || label.trim() === "" || label.length > 80 || /[\u0000-\u001f]/.test(label)) {
			throw fail("Invalid account label");
		}
		const url = validateLocalBaseUrl(baseUrl);
		const models = validateLocalModelIds(modelIds);
		if (!url || !models) throw fail("Invalid local endpoint");
		if (accountId !== undefined && !isStrictAccountId(accountId)) throw fail("Invalid account id");
		return this.mutate(async () => {
			ensurePrivateDir(this.accountsRoot);
			let id = accountId;
			if (id !== undefined) {
				if (existsSync(this.accountDir(id))) throw fail("Account already exists");
			} else {
				const base = slugify(label);
				id = base;
				for (let n = 2; existsSync(this.accountDir(id)); n++) id = `${base.slice(0, 56)}-${n}`;
			}
			const provider = `local-${id}`;
			if (!STRICT_ID.test(provider)) throw fail("Invalid account id");
			ensurePrivateDir(this.accountDir(id));
			try {
				this.writeLocalModels(id, provider, url, models);
				writePrivateFile(
					path.join(this.accountDir(id), "auth.json"),
					`${JSON.stringify({ [provider]: { type: "api_key", key: LOCAL_PLACEHOLDER } }, null, 2)}\n`,
				);
				const meta = this.writeMeta({
					accountId: id,
					label: label.trim(),
					provider,
					authMethod: "api_key",
					configured: true,
					createdAt: new Date().toISOString(),
					kind: "local",
				});
				this.enforceCredentialPermissions(id);
				return accountDto(meta);
			} catch (error) {
				rmSync(assertSecurePath(this.accountDir(id)), { recursive: true, force: true });
				throw error;
			}
		});
	}

	/** Replaces the endpoint of an existing LOCAL account and restores the fixed placeholder credential (re-enables after logout). */
	async setLocalEndpoint({ accountId, baseUrl, modelIds } = {}) {
		const url = validateLocalBaseUrl(baseUrl);
		const models = validateLocalModelIds(modelIds);
		if (!url || !models) throw fail("Invalid local endpoint");
		this.requireLocal(accountId);
		this.assertIdle();
		return this.mutate(async () => {
			this.assertIdle();
			const meta = this.requireLocal(accountId);
			this.writeLocalModels(accountId, meta.provider, url, models);
			// Re-enable a logged-out account: the credential is always the fixed
			// placeholder, never a client-supplied value.
			writePrivateFile(
				path.join(this.accountDir(accountId), "auth.json"),
				`${JSON.stringify({ [meta.provider]: { type: "api_key", key: LOCAL_PLACEHOLDER } }, null, 2)}\n`,
			);
			const updated = this.writeMeta({ ...meta, configured: true });
			this.enforceCredentialPermissions(accountId);
			return accountDto(updated);
		});
	}

	// ----- custom (LiteLLM / OpenAI-compatible) provider accounts -----------------------

	/** Private models.json of a custom account: Base URL + discovered ids, never a key (that lives in auth.json). */
	writeCustomModels(accountId, provider, baseUrl, modelIds) {
		const doc = { providers: { [provider]: { name: "Custom gateway", baseUrl, api: LOCAL_API, models: modelIds.map((id) => ({ id })) } } };
		writePrivateFile(path.join(this.accountDir(accountId), "models.json"), `${JSON.stringify(doc, null, 2)}\n`);
	}

	requireCustom(accountId) {
		const meta = this.requireMeta(accountId);
		if (meta.kind !== "custom") throw fail("Account is not a custom provider");
		return meta;
	}

	customConfig(meta) {
		try {
			const doc = JSON.parse(readFileSync(path.join(this.accountDir(meta.accountId), "models.json"), "utf8"));
			const entry = doc.providers?.[meta.provider];
			const baseUrl = validateCustomBaseUrl(entry?.baseUrl);
			if (baseUrl) return { baseUrl, models: Array.isArray(entry.models) ? entry.models : [] };
		} catch {}
		throw fail("Custom provider configuration is unreadable");
	}

	/** The stored key, read straight from the account's private auth.json (the only secret store). */
	storedApiKey(meta) {
		this.enforceCredentialPermissions(meta.accountId);
		try {
			const credential = JSON.parse(readFileSync(path.join(this.accountDir(meta.accountId), "auth.json"), "utf8"))[meta.provider];
			if (credential?.type === "api_key" && typeof credential.key === "string" && credential.key !== "") return credential.key;
		} catch {}
		throw fail("Account is not signed in");
	}

	/** Bounded discovery; the previous configuration is left untouched unless it fully succeeds. */
	async discoverInto(meta, baseUrl) {
		const apiKey = this.storedApiKey(meta);
		try {
			this.writeCustomModels(meta.accountId, meta.provider, baseUrl, await discoverModels({ baseUrl, apiKey }));
		} catch (error) {
			throw error instanceof CustomProviderError ? error : fail(GENERIC_REQUEST_FAILURE);
		}
	}

	/**
	 * Creates a custom-provider account bound to a validated Base URL. No credential and no network:
	 * the key arrives later through auth_start / auth_reply, models through refreshCustomModels.
	 */
	async createCustomAccount({ accountId, label, baseUrl } = {}) {
		if (typeof label !== "string" || label.trim() === "" || label.length > 80 || /[\u0000-\u001f]/.test(label)) {
			throw fail("Invalid account label");
		}
		const url = validateCustomBaseUrl(baseUrl);
		if (!url) throw fail("Invalid Base URL");
		if (accountId !== undefined && !isStrictAccountId(accountId)) throw fail("Invalid account id");
		return this.mutate(async () => {
			ensurePrivateDir(this.accountsRoot);
			let id = accountId;
			if (id !== undefined) {
				if (existsSync(this.accountDir(id))) throw fail("Account already exists");
			} else {
				const base = slugify(label);
				id = base;
				for (let n = 2; existsSync(this.accountDir(id)); n++) id = `${base.slice(0, 56)}-${n}`;
			}
			const provider = `custom-${id}`;
			if (!STRICT_ID.test(provider)) throw fail("Invalid account id");
			ensurePrivateDir(this.accountDir(id));
			try {
				this.writeCustomModels(id, provider, url, []);
				const meta = this.writeMeta({
					accountId: id,
					label: label.trim(),
					provider,
					authMethod: "none",
					configured: false,
					createdAt: new Date().toISOString(),
					kind: "custom",
				});
				return accountDto(meta);
			} catch (error) {
				rmSync(assertSecurePath(this.accountDir(id)), { recursive: true, force: true });
				throw error;
			}
		});
	}

	/** Re-discovers the gateway's models (requires the stored key). Failure keeps the previous models. */
	async refreshCustomModels({ accountId } = {}) {
		this.requireCustom(accountId);
		this.assertIdle();
		return this.mutate(async () => {
			this.assertIdle();
			const meta = this.requireCustom(accountId);
			await this.discoverInto(meta, this.customConfig(meta).baseUrl);
			return this.status(accountId);
		});
	}

	/**
	 * Changes the Base URL. While a key is stored it may only move within the SAME origin (the key is
	 * never re-pointed at another host without signing out and entering it again); the models are then
	 * re-discovered, and any failure keeps the previous configuration.
	 */
	async setCustomEndpoint({ accountId, baseUrl } = {}) {
		const url = validateCustomBaseUrl(baseUrl);
		if (!url) throw fail("Invalid Base URL");
		this.requireCustom(accountId);
		this.assertIdle();
		return this.mutate(async () => {
			this.assertIdle();
			const meta = this.requireCustom(accountId);
			if (meta.configured === true) {
				if (new URL(url).origin !== new URL(this.customConfig(meta).baseUrl).origin) {
					throw fail("Sign out before changing the gateway host");
				}
				await this.discoverInto(meta, url);
				return this.status(accountId);
			}
			this.writeCustomModels(accountId, meta.provider, url, []);
			return accountDto(meta);
		});
	}

	requireLocal(accountId) {
		const meta = this.requireMeta(accountId);
		if (meta.kind !== "local") throw fail("Account is not a local endpoint");
		return meta;
	}

	async removeAccount(accountId) {
		this.requireMeta(accountId);
		if (this.inUse(accountId)) throw fail("Account in use by a profile");
		this.assertIdle();
		return this.mutate(async () => {
			this.assertIdle();
			if (this.inUse(accountId)) throw fail("Account in use by a profile");
			const dir = assertSecurePath(this.accountDir(accountId));
			rmSync(dir, { recursive: true, force: true });
			return { accountId, removed: true };
		});
	}

	/**
	 * The per-account auth.json is written by the SDK inside the helper, not by
	 * writePrivateFile. The SDK creates it 0600 already; the daemon re-asserts
	 * it (and the account dir at 0700) after every helper operation that can
	 * write. Symlinks and foreign owners are refused, never chmod-ed through.
	 */
	enforceCredentialPermissions(accountId) {
		// HU-061: with the verified Windows helper the privacy is checked and repaired by the helper, never by chmod.
		const w = winfs.active();
		if (w) return this.enforceCredentialPermissionsWin(w, accountId);
		const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
		const dir = assertSecurePath(this.accountDir(accountId));
		const dirStat = lstatSync(dir);
		if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw fail("Account store is not a private directory");
		if (uid !== undefined && dirStat.uid !== uid) throw fail("Account store has a foreign owner");
		const file = path.join(dir, "auth.json");
		let fileStat;
		try {
			fileStat = lstatSync(file);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		if (fileStat) {
			if (fileStat.isSymbolicLink() || !fileStat.isFile()) throw fail("Account credentials are not a regular file");
			if (uid !== undefined && fileStat.uid !== uid) throw fail("Account credentials have a foreign owner");
			if ((fileStat.mode & 0o777) !== 0o600) chmodSync(file, 0o600);
		}
		if ((dirStat.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
	}

	/**
	 * Windows twin of enforceCredentialPermissions (HU-061): the helper's facts decide. Reparse points (symlink/junction),
	 * hard links, a non-file, a non-private account dir and a non-private auth.json are all refused (fail closed).
	 */
	enforceCredentialPermissionsWin(w, accountId) {
		const dir = assertSecurePath(this.accountDir(accountId));
		const dirFacts = w.checkPath(dir);
		if (!dirFacts.exists || dirFacts.kind !== "dir" || dirFacts.reparse || !dirFacts.private || !dirFacts.parent_ok) {
			throw new CredentialStoreError();
		}
		const file = path.join(dir, "auth.json");
		const facts = w.checkPath(file);
		if (!facts.exists) return;
		if (facts.reparse || facts.kind !== "file" || facts.nlink !== 1) throw new CredentialStoreError();
		// The helper has no operation that tightens an existing entry (delete/move/write all require a private source), so a
		// credential file that is not private is REFUSED, never trusted and never loosely rewritten: sign in again after removing it.
		if (!facts.private) throw new CredentialStoreError();
	}

	// ----- helper child client -------------------------------------------

	openSession(onRecord, onClose) {
		const session = new HelperSession(this.helper, onRecord, () => {
			this.sessions.delete(session);
			onClose?.();
		});
		this.sessions.add(session);
		return session;
	}

	async call(command) {
		const session = this.openSession();
		try {
			const result = await session.request(command, this.requestTimeoutMs);
			if (!result.ok) throw fail(GENERIC_REQUEST_FAILURE);
			return result;
		} finally {
			session.end();
		}
	}

	async providers() {
		const result = await this.call({ cmd: "providers" });
		return (result.providers ?? []).map(providerDto);
	}

	async models(providerId, accountId) {
		if (accountId !== undefined) this.requireMeta(accountId);
		const result = await this.call({
			cmd: "models",
			...(providerId ? { providerId: String(providerId) } : {}),
			...(accountId ? { accountId } : {}),
		});
		return (result.models ?? []).map(modelDto);
	}

	/** Reads the credential status from the account's own store and syncs the public metadata. */
	async status(accountId) {
		const meta = this.requireMeta(accountId);
		const result = await this.call({ cmd: "status", accountId });
		const credential = (result.credentials ?? []).find((c) => c.provider === meta.provider);
		const authMethod = credential ? (credential.authMethod === "oauth" ? "oauth" : "api_key") : "none";
		const configured = credential?.configured === true;
		if (meta.configured !== configured || meta.authMethod !== authMethod) {
			return accountDto(this.writeMeta({ ...meta, configured, authMethod }));
		}
		return accountDto(meta);
	}

	async enrollApiKey({ accountId, providerId, apiKey } = {}) {
		const meta = this.requireMeta(accountId);
		if (meta.kind === "local") throw fail("Local accounts do not take API keys");
		if (providerId !== undefined && providerId !== meta.provider) throw fail("Provider does not match the account");
		if (typeof apiKey !== "string" || apiKey.trim() === "" || apiKey.length > 8192 || /[\r\n\u0000]/.test(apiKey)) {
			throw fail("Invalid API key");
		}
		if (meta.kind === "custom" && CONTROL_CHARS.test(apiKey)) throw fail("Invalid API key");
		this.assertIdle();
		return this.mutate(async () => {
			this.assertIdle();
			try {
				await this.call({ cmd: "enroll_api_key", accountId, providerId: meta.provider, apiKey });
			} finally {
				this.enforceCredentialPermissions(accountId);
			}
			return this.status(accountId);
		});
	}

	async logout(accountId) {
		const meta = this.requireMeta(accountId);
		this.assertIdle();
		return this.mutate(async () => {
			this.assertIdle();
			try {
				await this.call({ cmd: "logout", accountId, providerId: meta.provider });
			} finally {
				this.enforceCredentialPermissions(accountId);
			}
			return this.status(accountId);
		});
	}

	// ----- native login flow ---------------------------------------------

	/**
	 * Starts the (single) login flow. Resolves with `{flowId}` as soon as the
	 * flow is registered; progress arrives as `auth_prompt`, `auth_event` and
	 * a final `auth_done` event. No secret value is ever emitted.
	 */
	async startLogin({ accountId, method } = {}) {
		this.assertIdle();
		if (this.mutating > 0) throw fail("Authentication busy: a change is in progress");
		const meta = this.requireMeta(accountId);
		if (meta.kind === "local") throw fail("Local accounts do not sign in");
		if (method !== "oauth" && method !== "api_key") throw fail("Invalid sign-in method");
		if (meta.kind === "custom" && method !== "api_key") throw fail("Custom providers sign in with an API key");
		const flow = {
			id: `flow-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
			accountId,
			prompts: new Set(),
			cancelRequested: false,
			timedOut: false,
			finished: false,
			promptTimer: undefined,
			flowTimer: undefined,
			session: undefined,
		};
		this.flow = flow;
		this.log(`auth flow ${flow.id} started`);
		flow.flowTimer = setTimeout(() => {
			flow.timedOut = true;
			void this.cancel(flow.id);
		}, this.flowTimeoutMs);
		try {
			flow.session = this.openSession(
				(record) => this.onFlowRecord(flow, record),
				() => this.endFlow(flow, { ok: false, message: GENERIC_LOGIN_FAILURE }),
			);
			flow.session
				.request({ cmd: "login", accountId, providerId: meta.provider, method, flowId: flow.id })
				.then(
					(result) => this.onLoginResult(flow, result),
					() => this.endFlow(flow, { ok: false, message: GENERIC_LOGIN_FAILURE }),
				);
		} catch {
			this.endFlow(flow, { ok: false, message: GENERIC_LOGIN_FAILURE });
		}
		return { flowId: flow.id };
	}

	onFlowRecord(flow, record) {
		if (flow.finished || record.flowId !== flow.id) return;
		if (record.type === "prompt") {
			flow.prompts.add(record.promptId);
			const payload = {
				flowId: flow.id,
				promptId: String(record.promptId),
				accountId: flow.accountId,
				kind: String(record.kind),
				message: String(record.message ?? ""),
				secret: record.secret === true,
			};
			if (typeof record.placeholder === "string") payload.placeholder = record.placeholder;
			if (Array.isArray(record.options)) {
				payload.options = record.options.map((o) => ({
					id: String(o.id),
					label: String(o.label ?? o.id),
					...(o.description ? { description: String(o.description) } : {}),
				}));
			}
			this.armPromptTimer(flow);
			this.emit("auth_prompt", payload);
		} else if (record.type === "event" && record.event && typeof record.event === "object") {
			const { kind, message, url, instructions, userCode, verificationUri, links } = record.event;
			this.emit("auth_event", {
				flowId: flow.id,
				kind: String(kind),
				...(message !== undefined ? { message: String(message) } : {}),
				...(url !== undefined ? { url: String(url) } : {}),
				...(instructions !== undefined ? { instructions: String(instructions) } : {}),
				...(userCode !== undefined ? { userCode: String(userCode) } : {}),
				...(verificationUri !== undefined ? { verificationUri: String(verificationUri) } : {}),
				...(Array.isArray(links) ? { links: links.map((l) => ({ url: String(l.url), ...(l.label ? { label: String(l.label) } : {}) })) } : {}),
			});
		}
	}

	armPromptTimer(flow) {
		clearTimeout(flow.promptTimer);
		flow.promptTimer = setTimeout(() => {
			flow.timedOut = true;
			void this.cancel(flow.id);
		}, this.promptTimeoutMs);
	}

	async onLoginResult(flow, result) {
		if (flow.finished) return;
		try {
			this.enforceCredentialPermissions(flow.accountId);
		} catch (error) {
			this.endFlow(flow, { ok: false, message: error instanceof CredentialStoreError ? STORE_NOT_PRIVATE_MESSAGE : GENERIC_LOGIN_FAILURE });
			return;
		}
		if (flow.cancelRequested || result.cancelled) {
			this.endFlow(flow, { ok: false, cancelled: true, message: flow.timedOut ? "Sign-in timed out" : "Sign-in cancelled" });
			return;
		}
		if (!result.ok) {
			this.endFlow(flow, { ok: false, message: GENERIC_LOGIN_FAILURE });
			return;
		}
		let account;
		try {
			// The flow slot is still held: no other mutation can interleave.
			const status = await this.statusWhileFlow(flow.accountId);
			account = status;
		} catch {
			this.endFlow(flow, { ok: false, message: GENERIC_LOGIN_FAILURE });
			return;
		}
		this.endFlow(flow, { ok: true, account });
	}

	/** Status sync used by the active flow itself (the public one is queued behind it). */
	async statusWhileFlow(accountId) {
		return this.status(accountId);
	}

	/** Answers an open prompt. The value goes to the helper only and is never echoed. */
	async reply(flowId, { promptId, value } = {}) {
		const flow = this.flow;
		if (!flow || flow.id !== flowId || flow.finished) throw fail("No such sign-in flow");
		if (!flow.prompts.has(promptId)) throw fail("No such prompt");
		if (typeof value !== "string" || value.length > 8192) throw fail("Invalid answer");
		// A custom gateway key goes into an HTTP header: refuse control characters before any side effect
		// (the prompt stays open so the user can try again).
		if (this.requireMeta(flow.accountId).kind === "custom" && CONTROL_CHARS.test(value)) throw fail("Invalid API key");
		flow.prompts.delete(promptId);
		clearTimeout(flow.promptTimer);
		flow.session.write({ cmd: "answer", flowId, promptId, value });
		return { ok: true };
	}

	/** Aborts the flow: asks the helper to cancel, then forces it after a short grace. */
	async cancel(flowId) {
		const flow = this.flow;
		if (!flow || flow.id !== flowId || flow.finished) return { ok: true };
		if (flow.cancelRequested) return { ok: true };
		flow.cancelRequested = true;
		clearTimeout(flow.promptTimer);
		flow.session?.write({ cmd: "cancel", flowId });
		const grace = setTimeout(() => {
			flow.session?.kill();
			this.endFlow(flow, { ok: false, cancelled: true, message: flow.timedOut ? "Sign-in timed out" : "Sign-in cancelled" });
		}, CANCEL_GRACE_MS);
		grace.unref?.();
		flow.graceTimer = grace;
		return { ok: true };
	}

	endFlow(flow, outcome) {
		if (flow.finished) return;
		flow.finished = true;
		clearTimeout(flow.promptTimer);
		clearTimeout(flow.flowTimer);
		clearTimeout(flow.graceTimer);
		if (flow.cancelRequested && outcome.ok !== true) {
			outcome = { ok: false, cancelled: true, message: flow.timedOut ? "Sign-in timed out" : "Sign-in cancelled" };
		}
		flow.session?.end();
		if (this.flow === flow) this.flow = undefined;
		this.log(`auth flow ${flow.id} ended ok=${outcome.ok === true}`);
		this.emit("auth_done", { flowId: flow.id, accountId: flow.accountId, ...outcome });
	}

	/** Cancels any flow and kills every helper child (clean shutdown). */
	async close() {
		if (this.flow) {
			const flow = this.flow;
			flow.cancelRequested = true;
			flow.session?.kill();
			this.endFlow(flow, { ok: false, cancelled: true, message: "Sign-in cancelled" });
		}
		for (const session of [...this.sessions]) session.kill();
	}
}

module.exports = { AccountManager, CredentialStoreError, STORE_NOT_PRIVATE_MESSAGE, LOCAL_PLACEHOLDER, helperEnv, isStrictAccountId };
