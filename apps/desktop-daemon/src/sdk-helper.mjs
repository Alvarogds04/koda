#!/usr/bin/env node

// Abito island SDK auth helper (U2).
//
// A small child process that owns the ONLY contact with the installed
// `@earendil-works/pi-coding-agent` SDK for account authentication. It runs in
// a clean environment (the parent strips provider keys, PI_* setup and every
// other ambient variable), so the host's provider credentials or Pi settings
// can never leak into, or out of, the island's account stores.
//
// Protocol: strict JSONL over stdin/stdout (one record per LF-terminated line).
//
//   Requests (parent -> helper):
//     { id, cmd: "providers" }
//     { id, cmd: "models", accountId?, providerId? }
//     { id, cmd: "status", accountId }
//     { id, cmd: "login", accountId, providerId, method: "api_key" | "oauth", flowId }
//     { id, cmd: "enroll_api_key", accountId, providerId, apiKey }
//     { id, cmd: "logout", accountId, providerId }
//     { id, cmd: "device_id" }                       (creates/validates the installation id; id never returned)
//     { cmd: "answer", flowId, promptId, value }   (login prompt reply)
//     { cmd: "cancel", flowId }                    (abort a login flow)
//
//   Emissions (helper -> parent):
//     { type: "result", id, ok, ... }              (exactly one per request id)
//     { type: "prompt", flowId, promptId, kind, message, ... , secret }
//     { type: "event", flowId, event }
//
// Secrecy contract (enforced here, tested by the daemon suite):
// - Credentials are never serialized back: results carry no key material.
// - Prompt answers travel parent -> helper only and are never echoed.
// - Errors are reported as fixed generic phrases; exception details and
//   anything a provider flow produced are never forwarded.
// - One credential per provider per account, stored in
//   `<accounts-root>/<accountId>/auth.json` (the SDK's own auth.json format).

import { createInterface } from "node:readline";
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const ACCOUNTS_ROOT = process.argv[process.argv.indexOf("--accounts-root") + 1];
if (!ACCOUNTS_ROOT) {
	process.stderr.write("sdk-helper: --accounts-root is required\n");
	process.exit(2);
}

/** Entry file of an SDK package directory (ESM cannot import a directory). */
function packageEntry(dir) {
	try {
		const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
		if (pkg.name !== "@earendil-works/pi-coding-agent") return undefined;
		const entry = pkg.exports?.["."]?.import ?? pkg.main;
		return entry ? pathToFileURL(join(dir, entry)).href : undefined;
	} catch {
		return undefined;
	}
}

/** Configurable SDK module: ABITO_SDK_MODULE may be a package directory or an entry file. */
function resolveSdkModule() {
	const explicit = process.env.ABITO_SDK_MODULE;
	if (explicit && existsSync(explicit)) {
		return packageEntry(explicit) ?? pathToFileURL(explicit).href;
	}
	return "@earendil-works/pi-coding-agent";
}

/**
 * Fallback: locate the installed `pi` executable on PATH (no shell, no login
 * profile) and resolve its package entry. Read-only; never touches setup.
 */
function resolveInstalledPiPackage() {
	try {
		// PATH uses ";" on Windows; the npm shims there are pi.cmd / pi.ps1 / pi.exe (HU-062).
		const names = process.platform === "win32" ? ["pi.cmd", "pi.exe", "pi.ps1", "pi"] : ["pi"];
		for (const dir of (process.env.PATH ?? "").split(delimiter)) {
			if (!dir) continue;
			const candidate = names.map((name) => join(dir, name)).find((file) => existsSync(file));
			if (!candidate) continue;
			// npm's global layout: the shim sits next to node_modules/<package> (the Windows prefix, and Unix <prefix>/lib/node_modules via the realpath walk below).
			const sibling = packageEntry(join(dir, "node_modules", "@earendil-works", "pi-coding-agent"));
			if (sibling) return sibling;
			let current = realpathSync(candidate);
			// The managed launcher (`<agent>/bin/pi`, a POSIX script, not a link into the package) runs
			// `<agent>/install/releases/<install/current-version>/node_modules/.bin/pi`: resolve the same package, read-only.
			const agentDir = dirname(dirname(current));
			try {
				const version = readFileSync(join(agentDir, "install", "current-version"), "utf8").split("\n")[0];
				if (/^[0-9A-Za-z._+-]+$/.test(version) && version !== "." && version !== "..") {
					const entry = packageEntry(join(agentDir, "install", "releases", version, "node_modules", "@earendil-works", "pi-coding-agent"));
					if (entry) return entry;
				}
			} catch {}
			for (let i = 0; i < 10; i++) {
				current = dirname(current);
				const entry = packageEntry(current);
				if (entry) return entry;
			}
		}
	} catch {}
	return undefined;
}

let sdkPromise;
function loadSdk() {
	sdkPromise ??= (async () => {
		const primary = resolveSdkModule();
		try {
			return await import(primary);
		} catch (error) {
			const fallback = resolveInstalledPiPackage();
			if (!fallback) throw error;
			return import(fallback);
		}
	})();
	return sdkPromise;
}

/** One ModelRuntime per account dir; created offline, never refreshed on create. */
const runtimes = new Map();
async function runtimeFor(accountId) {
	if (runtimes.has(accountId)) return runtimes.get(accountId);
	const { ModelRuntime } = await loadSdk();
	const accountDir = join(ACCOUNTS_ROOT, accountId);
	mkdirSync(accountDir, { recursive: true, mode: 0o700 });
	const runtime = await ModelRuntime.create({
		authPath: join(accountDir, "auth.json"),
		modelsPath: join(accountDir, "models.json"),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	runtimes.set(accountId, runtime);
	return runtime;
}

/** Stable installation id for login flows that need one (private, not a secret). */
function deviceIdPath() {
	return join(ACCOUNTS_ROOT, "device-id");
}
function getOrCreateDeviceId() {
	// Anti-symlink law, same as the daemon: never read or write through a link.
	const file = deviceIdPath();
	let stats;
	try {
		stats = lstatSync(file);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	if (stats) {
		if (stats.isSymbolicLink() || !stats.isFile()) throw new Error("device id is not a regular file");
		if (typeof process.getuid === "function" && stats.uid !== process.getuid()) throw new Error("device id has a foreign owner");
		const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			const existing = readFileSync(fd, "utf8").trim();
			if (existing) return existing;
		} finally {
			closeSync(fd);
		}
	}
	const id = randomUUID();
	// O_EXCL|O_NOFOLLOW temp file at 0600, renamed over the target (never written through a link).
	const { writePrivateFile } = createRequire(import.meta.url)("./isolation.cjs");
	writePrivateFile(file, `${id}\n`);
	return id;
}

const writeRecord = (record) => process.stdout.write(Buffer.from(`${JSON.stringify(record)}\n`, "utf8"));

const GENERIC_FAILURE = "authentication did not complete";

/** Login flows in progress: flowId -> { controller, pending: Map<promptId, {resolve,reject}>, cancelled }. */
const flows = new Map();
let promptSeq = 0;

/** Reduces a provider to what the account UI may show; login-capable methods only. */
function providerDto(runtime, provider) {
	const methods = [];
	if (provider.auth?.oauth?.login) methods.push("oauth");
	if (provider.auth?.apiKey?.login) methods.push("api_key");
	if (methods.length === 0) return undefined;
	const status = runtime.getProviderAuthStatus(provider.id);
	return { id: provider.id, name: provider.name, methods, configured: status.configured === true };
}

/** Model catalog reduced to the allowlisted UI fields; never endpoints, headers, or costs. */
function modelDto(model) {
	return {
		provider: model.provider,
		id: model.id,
		name: model.name,
		reasoning: model.reasoning === true,
		input: Array.isArray(model.input) ? [...model.input].filter((v) => v === "text" || v === "image") : [],
		contextWindow: typeof model.contextWindow === "number" ? model.contextWindow : 0,
	};
}

/**
 * Builds the AuthInteraction the SDK expects, translating prompts and events
 * into JSONL records. `autoAnswer` (used by api-key enrollment) resolves
 * secret prompts locally without emitting them.
 */
function makeInteraction(flow, { autoAnswer } = {}) {
	return {
		signal: flow.controller.signal,
		prompt: (prompt) =>
			new Promise((resolve, reject) => {
				if (flow.controller.signal.aborted) return reject(new Error("cancelled"));
				if (autoAnswer && prompt.type === "secret") {
					resolve(autoAnswer);
					return;
				}
				if (autoAnswer) {
					reject(new Error("unexpected prompt"));
					return;
				}
				const promptId = `p${++promptSeq}`;
				flow.pending.set(promptId, { resolve, reject });
				const payload = { type: "prompt", flowId: flow.id, promptId, kind: prompt.type, message: prompt.message };
				if (prompt.placeholder) payload.placeholder = prompt.placeholder;
				if (prompt.options) payload.options = prompt.options.map((o) => ({ id: o.id, label: o.label, ...(o.description ? { description: o.description } : {}) }));
				payload.secret = prompt.type === "secret";
				writeRecord(payload);
			}),
		notify: (event) => {
			if (!flow || autoAnswer) return;
			const safe = { kind: event.type };
			switch (event.type) {
				case "info":
					safe.message = event.message;
					if (event.links) safe.links = event.links.map((l) => ({ url: l.url, ...(l.label ? { label: l.label } : {}) }));
					break;
				case "auth_url":
					safe.url = event.url;
					if (event.instructions) safe.instructions = event.instructions;
					break;
				case "device_code":
					safe.userCode = event.userCode;
					safe.verificationUri = event.verificationUri;
					if (event.intervalSeconds) safe.intervalSeconds = event.intervalSeconds;
					if (event.expiresInSeconds) safe.expiresInSeconds = event.expiresInSeconds;
					break;
				case "progress":
					safe.message = event.message;
					break;
				default:
					return;
			}
			writeRecord({ type: "event", flowId: flow.id, event: safe });
		},
	};
}

async function handle(msg) {
	const { id, cmd } = msg;
	try {
		switch (cmd) {
			case "providers": {
				const runtime = await runtimeFor(msg.accountId ?? firstAccountDir() ?? ensureScratchAccount());
				const providers = runtime.getProviders().flatMap((provider) => {
					const dto = providerDto(runtime, provider);
					return dto ? [dto] : [];
				});
				writeRecord({ type: "result", id, ok: true, providers });
				return;
			}
			case "models": {
				const runtime = await runtimeFor(msg.accountId ?? firstAccountDir() ?? ensureScratchAccount());
				const models = msg.providerId
					? runtime.getAllModels(msg.providerId)
					: runtime.getAllModels();
				writeRecord({ type: "result", id, ok: true, models: models.map(modelDto) });
				return;
			}
			case "status": {
				const runtime = await runtimeFor(msg.accountId);
				const credentials = (await runtime.listCredentials()).map((info) => ({
					provider: info.providerId,
					authMethod: info.type,
					configured: true,
				}));
				writeRecord({ type: "result", id, ok: true, credentials });
				return;
			}
			case "login": {
				const flow = {
					id: msg.flowId,
					controller: new AbortController(),
					pending: new Map(),
					cancelled: false,
				};
				flows.set(flow.id, flow);
				flow.controller.signal.addEventListener("abort", () => {
					for (const pending of [...flow.pending.values()]) pending.reject(new Error("cancelled"));
					flow.pending.clear();
				});
				try {
					const runtime = await runtimeFor(msg.accountId);
					await runtime.login(msg.providerId, msg.method, makeInteraction(flow), {
						getDeviceId,
						agentName: "Abito",
					});
					writeRecord({ type: "result", id, ok: true });
				} catch {
					if (flow.cancelled) writeRecord({ type: "result", id, ok: false, cancelled: true });
					else writeRecord({ type: "result", id, ok: false, error: GENERIC_FAILURE });
				} finally {
					flows.delete(flow.id);
				}
				return;
			}
			case "device_id": {
				// Creates/validates the installation id; the id itself is never returned.
				try {
					getOrCreateDeviceId();
					writeRecord({ type: "result", id, ok: true });
				} catch {
					writeRecord({ type: "result", id, ok: false, error: GENERIC_FAILURE });
				}
				return;
			}
			case "enroll_api_key": {
				// Direct private CLI enrollment: the key arrives over the private
				// pipe, goes straight into the SDK login flow, and is never echoed.
				const flow = { id: `enroll-${id}`, controller: new AbortController(), pending: new Map(), cancelled: false };
				try {
					const runtime = await runtimeFor(msg.accountId);
					await runtime.login(msg.providerId, "api_key", makeInteraction(flow, { autoAnswer: msg.apiKey }), {
						getDeviceId,
						agentName: "Abito",
					});
					writeRecord({ type: "result", id, ok: true });
				} catch {
					writeRecord({ type: "result", id, ok: false, error: GENERIC_FAILURE });
				}
				return;
			}
			case "logout": {
				const runtime = await runtimeFor(msg.accountId);
				await runtime.logout(msg.providerId);
				writeRecord({ type: "result", id, ok: true });
				return;
			}
			default:
				writeRecord({ type: "result", id, ok: false, error: "unknown command" });
		}
	} catch {
		// Storage/import/unknown failures: generic result, never details.
		writeRecord({ type: "result", id, ok: false, error: "request failed" });
	}
}

function firstAccountDir() {
	try {
		for (const entry of readdirSync(ACCOUNTS_ROOT, { withFileTypes: true })) {
			if (entry.isDirectory() && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(entry.name)) return entry.name;
		}
	} catch {}
	return undefined;
}

function ensureScratchAccount() {
	mkdirSync(ACCOUNTS_ROOT, { recursive: true, mode: 0o700 });
	return "__catalog__";
}

function getDeviceId() {
	return getOrCreateDeviceId();
}

const readline = createInterface({ input: process.stdin, terminal: false });
readline.on("line", (line) => {
	if (line.trim() === "") return;
	let record;
	try {
		record = JSON.parse(line);
	} catch {
		return;
	}
	if (record.cmd === "answer") {
		const flow = flows.get(record.flowId);
		const pending = flow?.pending.get(record.promptId);
		if (pending) {
			flow.pending.delete(record.promptId);
			pending.resolve(record.value);
		}
		return;
	}
	if (record.cmd === "cancel") {
		const flow = flows.get(record.flowId);
		if (flow) {
			flow.cancelled = true;
			flow.controller.abort();
		}
		return;
	}
	void handle(record);
});
readline.on("close", () => process.exit(0));
