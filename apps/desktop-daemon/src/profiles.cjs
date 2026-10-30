"use strict";

/**
 * Abito island role profiles (U2).
 *
 * A profile is an explicit, user-made binding: role -> account + provider +
 * model + thinking level. Nothing is ever chosen automatically: listing,
 * roles and account changes never activate anything; only `select` /
 * `selectForRole` do, and only on an idle engine.
 *
 * Activation copies exactly one credential (the profile's provider, from the
 * profile's account) into the engine's owned `agent/auth.json` at 0600, brings
 * the account's private `models.json` (custom/local endpoints stay private),
 * writes the model defaults into the owned `settings.json`, restarts the
 * engine so it reloads them, and finally switches the live model/thinking
 * level. Any failure restores every file exactly as it was. All mutations
 * are serialized. Public DTOs carry no key, endpoint, header or token.
 */

const { existsSync, lstatSync, mkdirSync, readFileSync, rmdirSync, statSync, unlinkSync } = require("node:fs");
const path = require("node:path");
const { writePrivateFile } = require("./isolation.cjs");
const { isStrictAccountId } = require("./auth.cjs");
const { PROVIDER_ID, EXTENSION_FILE, RUNTIME_FILE, TEMPLATE, runtimeDocument } = require("./custom-provider-extension.cjs");

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const DEFAULT_THINKING_LEVEL = "medium";
const STRICT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;
const MAX_PROFILES = 64;

const isStrictProfileId = (value) => typeof value === "string" && STRICT_ID.test(value);
const fail = (message) => new Error(message);

function profileDto(p) {
	return {
		id: p.id,
		label: p.label,
		role: p.role,
		accountId: p.accountId,
		provider: p.provider,
		modelId: p.modelId,
		thinkingLevel: p.thinkingLevel,
	};
}

function readText(file) {
	try {
		return readFileSync(file, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
}

function parseJsonObject(text, what) {
	if (text === null) return {};
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		throw fail(`${what} is unreadable`);
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw fail(`${what} is unreadable`);
	return value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class ProfileStore {
	/**
	 * @param {object} options
	 * @param {string} options.islandRoot  private island root (profiles.json lives here)
	 * @param {string} options.agentDir    the engine's owned agent directory
	 * @param {() => Map<string, {accountId:string, provider:string, configured:boolean}>} options.accounts
	 * @param {object} options.engine      AgentEngine-like: status, busy?, request, stop, start
	 */
	constructor(options) {
		this.options = options;
		this.queue = Promise.resolve();
		// Startup recovery of an interrupted switch (see reconcileJournal).
		try {
			this.reconcileJournal();
			this.removeCustomOrphans();
		} catch {}
	}

	get journalPath() {
		return path.join(this.options.agentDir, ".switch.json");
	}

	get accountsRoot() {
		return path.join(this.options.islandRoot, "accounts");
	}
	get profilesPath() {
		return path.join(this.options.islandRoot, "profiles.json");
	}
	get activeAccountPath() {
		return path.join(this.options.islandRoot, "active-account.json");
	}

	// ----- storage ---------------------------------------------------------

	load() {
		const raw = readText(this.profilesPath);
		if (raw === null) return { profiles: [], active: undefined };
		const data = parseJsonObject(raw, "Profiles file");
		const profiles = Array.isArray(data.profiles) ? data.profiles.filter((p) => p && isStrictProfileId(p.id) && isStrictAccountId(p.accountId)) : [];
		return { profiles, active: typeof data.active === "string" ? data.active : undefined };
	}

	persist(state) {
		writePrivateFile(this.profilesPath, `${JSON.stringify(state, null, 2)}\n`);
	}

	/** Serializes every mutation. */
	mutate(fn) {
		const run = this.queue.then(fn, fn);
		this.queue = run.then(
			() => {},
			() => {},
		);
		return run;
	}

	// ----- public read API (sanitized) -------------------------------------

	list() {
		const { profiles, active } = this.load();
		return { profiles: profiles.map(profileDto), active };
	}

	roles() {
		const { profiles } = this.load();
		const byRole = new Map();
		for (const p of profiles) byRole.set(p.role, [...(byRole.get(p.role) ?? []), p.id]);
		return [...byRole].map(([role, profileIds]) => ({ role, profileIds }));
	}

	/** True when any saved profile references the account (removal guard for AccountManager). */
	usesAccount(accountId) {
		try {
			return this.load().profiles.some((p) => p.accountId === accountId);
		} catch {
			return true; // fail closed
		}
	}

	// ----- profile CRUD ----------------------------------------------------

	async save(input = {}) {
		const { id, label, role, accountId, provider, modelId } = input;
		const thinkingLevel = input.thinkingLevel ?? DEFAULT_THINKING_LEVEL;
		if (!isStrictProfileId(id)) throw fail("Invalid profile id");
		if (typeof label !== "string" || label.trim() === "" || label.length > 80 || /[\u0000-\u001f]/.test(label)) {
			throw fail("Invalid profile label");
		}
		if (!isStrictProfileId(role)) throw fail("Invalid profile role");
		if (!THINKING_LEVELS.includes(thinkingLevel)) throw fail("Invalid thinking level");
		if (typeof modelId !== "string" || modelId === "" || modelId.length > 200 || /[\u0000-\u001f]/.test(modelId)) {
			throw fail("Invalid model id");
		}
		const account = this.options.accounts().get(accountId);
		if (!account) throw fail("Unknown account");
		if (provider !== account.provider) throw fail("Provider does not match the account");
		return this.mutate(async () => {
			const state = this.load();
			const next = { id, label: label.trim(), role, accountId, provider, modelId, thinkingLevel };
			const index = state.profiles.findIndex((p) => p.id === id);
			if (index === -1 && state.profiles.length >= MAX_PROFILES) throw fail("Too many profiles");
			if (index === -1) state.profiles.push(next);
			else state.profiles[index] = next;
			this.persist(state);
			return profileDto(next);
		});
	}

	async remove(profileId) {
		return this.mutate(async () => {
			const state = this.load();
			if (!state.profiles.some((p) => p.id === profileId)) throw fail("Unknown profile");
			if (state.active === profileId) throw fail("Profile is active");
			state.profiles = state.profiles.filter((p) => p.id !== profileId);
			this.persist(state);
			return { id: profileId, removed: true };
		});
	}

	// ----- activation ------------------------------------------------------

	async selectForRole(role) {
		const matches = this.load().profiles.filter((p) => p.role === role);
		if (matches.length === 0) throw fail("No profile for that role");
		if (matches.length > 1) throw fail("Ambiguous role: multiple profiles match");
		return this.select(matches[0].id);
	}

	async select(profileId) {
		return this.mutate(() => this.activate(profileId));
	}

	/**
	 * Deactivates the active profile with the same machinery as activation:
	 * busy guard, credential lock, write-ahead journal, refreshed credential
	 * preserved first, then the private agent files that activation wrote are
	 * removed, the marker is cleared and the engine restarts. Every file is
	 * restored on failure. No active profile: no-op.
	 */
	async deactivate() {
		return this.mutate(() => this.doDeactivate());
	}

	async doDeactivate() {
		const state = this.load();
		if (state.active === undefined) {
			// Never a silent no-op: orphaned custom artifacts (no journal, nothing active) are removed and reported.
			if (this.findCustomOrphans().length === 0) return { ok: true, deactivated: false, ...this.list() };
			if (await this.isBusy()) throw fail("Engine busy: finish or abort the current turn first");
			const release = await this.acquireLock(path.join(this.options.agentDir, "auth.json.lock"));
			try {
				this.settleCustomRecovery();
				const removed = this.removeCustomOrphans();
				if (removed.length > 0) await this.restartEngine();
				return { ok: true, deactivated: false, ...(removed.length > 0 ? { removed } : {}), ...this.list() };
			} finally {
				release();
			}
		}
		if (await this.isBusy()) throw fail("Engine busy: finish or abort the current turn first");

		const { agentDir } = this.options;
		const files = {
			auth: path.join(agentDir, "auth.json"),
			models: path.join(agentDir, "models.json"),
			settings: path.join(agentDir, "settings.json"),
			marker: this.activeAccountPath,
			extension: path.join(agentDir, "extensions", EXTENSION_FILE),
			runtime: path.join(agentDir, RUNTIME_FILE),
		};
		const releaseLock = await this.acquireLock(path.join(agentDir, "auth.json.lock"));
		const wasRunning = this.options.engine.status !== "stopped";
		let snapshot;
		try {
			this.settleCustomRecovery();
			this.removeCustomOrphans();
			const current = this.load();
			if (current.active === undefined) return { ok: true, deactivated: false, ...this.list() };
			snapshot = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, readText(file)]));
			const settings = parseJsonObject(snapshot.settings, "Settings file");
			const currentAuth = parseJsonObject(snapshot.auth, "Agent credentials");
			try {
				const from = this.markerIdentity(snapshot.marker);
				writePrivateFile(this.journalPath, `${JSON.stringify({ from, to: null, startedAt: Date.now() })}\n`);
				this.preserveRefreshedCredential(snapshot.marker, currentAuth);
				for (const key of ["auth", "models", "extension", "runtime"]) if (existsSync(files[key])) unlinkSync(files[key]);
				delete settings.defaultProvider;
				delete settings.defaultModel;
				delete settings.defaultThinkingLevel;
				if (snapshot.settings !== null) writePrivateFile(files.settings, `${JSON.stringify(settings, null, 2)}\n`);
				this.writeMarker(files.marker, null);
				await this.restartEngine();
				current.active = undefined;
				this.persist(current);
				this.clearJournal();
			} catch (error) {
				await this.rollback(files, snapshot, wasRunning);
				throw fail(error?.message && /^(Engine busy|Account|Provider|Settings|Agent)/.test(error.message) ? error.message : "Could not deactivate the profile");
			}
			return { ok: true, deactivated: true, ...this.list() };
		} finally {
			releaseLock();
		}
	}

	async restartEngine() {
		const { engine } = this.options;
		if (engine.status === "stopped") return;
		await engine.stop();
		await engine.start();
	}

	async isBusy() {
		const engine = this.options.engine;
		if (engine.busy === true) return true;
		if (engine.status !== "ready") return false;
		try {
			const response = await engine.request({ type: "get_state" });
			return response?.data?.isStreaming === true || response?.data?.isCompacting === true;
		} catch {
			return true; // cannot prove idle: refuse
		}
	}

	async activate(profileId) {
		const state = this.load();
		const profile = state.profiles.find((p) => p.id === profileId);
		if (!profile) throw fail("Unknown profile");
		if (!isStrictAccountId(profile.accountId)) throw fail("Invalid account id");
		const account = this.options.accounts().get(profile.accountId);
		if (!account) throw fail("Unknown account");
		if (account.provider !== profile.provider) throw fail("Provider does not match the account");
		if (account.configured !== true) throw fail("Account is not signed in");
		if (await this.isBusy()) throw fail("Engine busy: finish or abort the current turn first");

		const { agentDir } = this.options;
		const files = {
			auth: path.join(agentDir, "auth.json"),
			models: path.join(agentDir, "models.json"),
			settings: path.join(agentDir, "settings.json"),
			marker: this.activeAccountPath,
			extension: path.join(agentDir, "extensions", EXTENSION_FILE),
			runtime: path.join(agentDir, RUNTIME_FILE),
		};
		const releaseLock = await this.acquireLock(path.join(agentDir, "auth.json.lock"));
		const wasRunning = this.options.engine.status !== "stopped";
		let snapshot;
		try {
			// A leftover journal means an earlier switch died mid-way: settle it first.
			this.settleCustomRecovery();
			this.removeCustomOrphans();
			// Read and validate everything BEFORE the first write.
			snapshot = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, readText(file)]));
			const settings = parseJsonObject(snapshot.settings, "Settings file");
			const currentAuth = parseJsonObject(snapshot.auth, "Agent credentials");
			const accountDir = path.join(this.accountsRoot, profile.accountId);
			const accountAuth = parseJsonObject(readText(path.join(accountDir, "auth.json")), "Account credentials");
			const credential = accountAuth[profile.provider];
			if (!credential) throw fail("Account is not signed in");
			const accountModels = readText(path.join(accountDir, "models.json"));
			// A custom provider is served ONLY by the guarded extension: its models.json entry (which would
			// route through the SDK's unguarded, redirect-following transport) is never projected.
			const customRuntime = account.custom === true ? this.customRuntime(profile, accountModels) : undefined;

			try {
				const from = this.markerIdentity(snapshot.marker);
				// Write-ahead journal: lets a restart tell which account auth.json belongs to.
				writePrivateFile(this.journalPath, `${JSON.stringify({ from, to: { accountId: profile.accountId, provider: profile.provider, ...(customRuntime ? { custom: true } : {}) }, startedAt: Date.now() })}\n`);
				this.preserveRefreshedCredential(snapshot.marker, currentAuth);
				writePrivateFile(files.auth, `${JSON.stringify({ [profile.provider]: credential }, null, 2)}\n`);
				// Always rewritten so a previous account's custom endpoints never linger.
				writePrivateFile(files.models, customRuntime ? `${JSON.stringify({ providers: {} })}\n` : (accountModels ?? `${JSON.stringify({ providers: {} })}\n`));
				if (customRuntime) {
					writePrivateFile(files.runtime, `${JSON.stringify(customRuntime, null, 2)}\n`);
					writePrivateFile(files.extension, TEMPLATE);
				} else {
					for (const key of ["extension", "runtime"]) if (existsSync(files[key])) unlinkSync(files[key]);
				}
				writePrivateFile(
					files.settings,
					`${JSON.stringify({ ...settings, defaultProvider: profile.provider, defaultModel: profile.modelId, defaultThinkingLevel: profile.thinkingLevel }, null, 2)}\n`,
				);
				this.writeMarker(files.marker, `${JSON.stringify({ accountId: profile.accountId, provider: profile.provider, ...(customRuntime ? { custom: true } : {}) })}\n`);
				// The journal stays until the whole transaction is committed (journal -> apply -> restart ->
				// save state -> clear journal): a crash anywhere before that is settled by reconcileJournal.
				await this.restartAndSwitch(profile);
				state.active = profile.id;
				this.persist(state);
				this.clearJournal();
			} catch (error) {
				await this.rollback(files, snapshot, wasRunning);
				throw fail(error?.message && /^(Engine busy|Account|Provider|Settings|Agent)/.test(error.message) ? error.message : "Could not activate the profile");
			}
			return { ok: true, profile: profileDto(profile) };
		} finally {
			releaseLock();
		}
	}

	/** Validated runtime data for a custom profile: Base URL + discovered ids, and the chosen model must be one of them. */
	customRuntime(profile, accountModelsText) {
		let entry;
		try {
			entry = JSON.parse(accountModelsText ?? "").providers?.[profile.provider];
		} catch {}
		const runtime = runtimeDocument(profile.provider, entry);
		if (!runtime) throw fail("Account has no discovered models; refresh the models first");
		if (!runtime.models.includes(profile.modelId)) throw fail("Account does not offer that model");
		return runtime;
	}

	/** Writes the active-account marker; `null` content clears it. Single seam for crash tests. */
	writeMarker(file, content) {
		if (content === null) {
			if (existsSync(file)) unlinkSync(file);
			return;
		}
		writePrivateFile(file, content);
	}

	clearJournal() {
		try {
			unlinkSync(this.journalPath);
		} catch {}
	}

	markerIdentity(markerText) {
		if (markerText === null) return null;
		try {
			const m = JSON.parse(markerText);
			if (m && isStrictAccountId(m.accountId) && typeof m.provider === "string") return { accountId: m.accountId, provider: m.provider, ...(m.custom === true ? { custom: true } : {}) };
		} catch {}
		return null;
	}

	/**
	 * Crash recovery. A journal means the process died between touching
	 * auth.json and persisting the active-account marker, so the marker may
	 * name the wrong account. preserveRefreshedCredential is never run here:
	 * auth.json is compared with the stored credential of `from` and `to`,
	 * the marker is repaired to the match, and when neither (or both)
	 * match, no account is active (fail closed). The journal is then deleted.
	 */
	reconcileJournal() {
		const raw = readText(this.journalPath);
		if (raw === null) return;
		let target; // account the marker should name; undefined = none
		try {
			JSON.parse(raw);
		} catch {
			return; // torn or garbage journal: unknown, so it stays as recovery evidence (settleCustomRecovery blocks on it)
		}
		try {
			const journal = JSON.parse(raw);
			const sameCred = (side) => {
				if (!side || !isStrictAccountId(side.accountId) || typeof side.provider !== "string") return false;
				const stored = parseJsonObject(readText(path.join(this.accountsRoot, side.accountId, "auth.json")), "Account credentials")[side.provider];
				const current = parseJsonObject(readText(path.join(this.options.agentDir, "auth.json")), "Agent credentials")[side.provider];
				return stored !== undefined && current !== undefined && JSON.stringify(stored) === JSON.stringify(current);
			};
			const isFrom = sameCred(journal.from);
			const isTo = sameCred(journal.to);
			if (isTo && !isFrom) target = journal.to;
			else if (isFrom && !isTo) target = journal.from;
			// HU-041 fail closed: an interrupted switch TO a custom account never counts as completed (the
			// guarded transport, its data and the credential are torn down below), and the custom
			// artifacts survive only when the unchanged previous custom account is still the active one.
			if (target && target === journal.to && journal.to.custom === true) target = undefined;
			if (journal.to?.custom === true || journal.from?.custom === true) {
				const keep = target !== undefined && target === journal.from && journal.from.custom === true;
				if (!keep) this.tearDownCustom([journal.to, journal.from]);
			}
		} catch (error) {
			// fail closed: keep the journal as recovery evidence, retry later. Also when a custom journal could not be
			// evaluated at all (e.g. the agent auth.json is unreadable): never clear evidence while custom bytes may remain.
			if (error?.customTeardown === true || /"custom":\s*true/.test(raw)) return;
		}
		try {
			if (target) this.writeMarker(this.activeAccountPath, `${JSON.stringify({ accountId: target.accountId, provider: target.provider, ...(target.custom === true ? { custom: true } : {}) })}\n`);
			else if (existsSync(this.activeAccountPath)) unlinkSync(this.activeAccountPath);
		} catch {
			return; // keep the journal: retry on the next start rather than guess
		}
		try {
			// The recorded active profile may no longer match the repaired state.
			const state = this.load();
			if (state.active !== undefined) {
				const active = state.profiles.find((p) => p.id === state.active);
				if (!active || !target || active.accountId !== target.accountId) {
					state.active = undefined;
					this.persist(state);
				}
			}
		} catch {}
		this.clearJournal();
	}

	/**
	 * Removes the custom transport artifacts an interrupted switch may have left (extension, runtime
	 * data) and the custom credential/defaults from the engine's private files. Only the providers the
	 * journal flags as custom are touched; cloud/local semantics stay as they were.
	 */
	tearDownCustom(sides) {
		try {
			this.tearDownCustomFiles(sides);
		} catch (error) {
			const wrapped = fail("A previous custom provider switch could not be cleaned up");
			wrapped.customTeardown = true;
			wrapped.cause = error;
			throw wrapped;
		}
	}

	tearDownCustomFiles(sides) {
		const { agentDir } = this.options;
		for (const file of [path.join(agentDir, "extensions", EXTENSION_FILE), path.join(agentDir, RUNTIME_FILE)]) {
			if (existsSync(file)) unlinkSync(file);
		}
		const providers = sides.filter((side) => side && side.custom === true && typeof side.provider === "string" && PROVIDER_ID.test(side.provider)).map((side) => side.provider);
		const authFile = path.join(agentDir, "auth.json");
		const auth = parseJsonObject(readText(authFile), "Agent credentials");
		if (providers.some((provider) => auth[provider] !== undefined)) {
			for (const provider of providers) delete auth[provider];
			writePrivateFile(authFile, `${JSON.stringify(auth, null, 2)}\n`);
		}
		const settingsFile = path.join(agentDir, "settings.json");
		const settingsText = readText(settingsFile);
		if (settingsText !== null) {
			const settings = parseJsonObject(settingsText, "Settings file");
			if (providers.includes(settings.defaultProvider)) {
				delete settings.defaultProvider;
				delete settings.defaultModel;
				delete settings.defaultThinkingLevel;
				writePrivateFile(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
			}
		}
	}

	/** A custom switch whose cleanup failed leaves the journal: refuse to build on top of it. */
	settleCustomRecovery() {
		this.reconcileJournal();
		if (readText(this.journalPath) !== null) {
			try {
				const text = readText(this.journalPath);
				let readable = true;
				try { JSON.parse(text); } catch { readable = false; }
				if (!readable || /"custom":\s*true/.test(text)) throw fail("A previous custom provider switch could not be cleaned up");
			} catch (error) {
				if (/could not be cleaned up/.test(error.message)) throw error;
			}
		}
	}

	/** Abito-owned custom artifacts that no committed custom activation justifies (no journal, nothing custom active). */
	findCustomOrphans() {
		if (readText(this.journalPath) !== null) return [];
		const { agentDir } = this.options;
		const marker = this.markerIdentity(readText(this.activeAccountPath));
		const state = this.load();
		if (state.active !== undefined && marker?.custom === true) return [];
		const found = [];
		if (existsSync(path.join(agentDir, "extensions", EXTENSION_FILE))) found.push("extension");
		if (existsSync(path.join(agentDir, RUNTIME_FILE))) found.push("runtime");
		if (marker?.custom === true) found.push("marker");
		return found;
	}

	/** Removes them (and the custom credential/defaults the runtime data names). Throws, keeping evidence, on failure. */
	removeCustomOrphans() {
		const found = this.findCustomOrphans();
		if (found.length === 0) return [];
		const { agentDir } = this.options;
		let provider;
		try {
			provider = JSON.parse(readText(path.join(agentDir, RUNTIME_FILE)) ?? "").provider;
		} catch {}
		const marker = this.markerIdentity(readText(this.activeAccountPath));
		const providers = [provider, marker?.custom === true ? marker.provider : undefined].filter((p) => typeof p === "string");
		this.tearDownCustom(providers.map((p) => ({ provider: p, custom: true })));
		const removed = found.filter((what) => what !== "marker");
		if (found.includes("marker")) {
			this.writeMarker(this.activeAccountPath, null);
			removed.push("marker");
		}
		return removed;
	}

	/**
	 * Before replacing the agent credential, writes the previously active
	 * account's latest (SDK-refreshed) credential back into its own store.
	 */
	preserveRefreshedCredential(markerText, currentAuth) {
		if (markerText === null) return;
		let marker;
		try {
			marker = JSON.parse(markerText);
		} catch {
			return;
		}
		if (!marker || typeof marker.accountId !== "string" || typeof marker.provider !== "string") return;
		if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(marker.accountId)) return;
		const fresh = currentAuth[marker.provider];
		if (!fresh) return;
		const accountDir = path.join(this.accountsRoot, marker.accountId);
		if (!existsSync(path.join(accountDir, "account.json"))) return;
		const file = path.join(accountDir, "auth.json");
		const stored = parseJsonObject(readText(file), "Account credentials");
		// Logout is authoritative: an emptied store must never be refilled from the agent.
		if (stored[marker.provider] === undefined) return;
		writePrivateFile(file, `${JSON.stringify({ ...stored, [marker.provider]: fresh }, null, 2)}\n`);
	}

	async restartAndSwitch(profile) {
		const { engine } = this.options;
		if (engine.status === "stopped") return; // files are ready; the next start loads them
		await engine.stop();
		await engine.start();
		// Fresh process, nothing in flight: the live switch is safe now.
		const model = await engine.request({ type: "set_model", provider: profile.provider, modelId: profile.modelId });
		if (model?.success === false) throw fail("Model switch failed");
		const level = await engine.request({ type: "set_thinking_level", level: profile.thinkingLevel });
		if (level?.success === false) throw fail("Thinking level switch failed");
	}

	async rollback(files, snapshot, wasRunning) {
		let restored = true;
		for (const key of Object.keys(files)) {
			try {
				if (snapshot[key] === null) {
					if (existsSync(files[key])) unlinkSync(files[key]);
				} else {
					writePrivateFile(files[key], snapshot[key]);
				}
			} catch {
				restored = false;
			}
		}
		if (restored) this.clearJournal(); // marker and auth.json agree again; otherwise startup reconciles
		const { engine } = this.options;
		try {
			if (wasRunning) {
				// A running engine may hold the activated credential in memory:
				// restart so memory matches the restored files.
				if (engine.status !== "stopped") await engine.stop();
				await engine.start();
			} else if (engine.status === "stopped") {
				await engine.start(); // best effort: bring the old setup back
			}
		} catch {}
	}

	/** Same lock directory the SDK's file credential store uses; stale locks are broken. */
	async acquireLock(lockDir) {
		const deadline = Date.now() + (this.options.lockWaitMs ?? LOCK_WAIT_MS);
		mkdirSync(path.dirname(lockDir), { recursive: true, mode: 0o700 });
		for (;;) {
			try {
				mkdirSync(lockDir, { mode: 0o700 });
				return () => {
					try {
						rmdirSync(lockDir);
					} catch {}
				};
			} catch (error) {
				if (error.code !== "EEXIST") throw error;
			}
			try {
				const stats = lstatSync(lockDir);
				if (Date.now() - stats.mtimeMs > LOCK_STALE_MS) {
					try {
						rmdirSync(lockDir);
					} catch {}
					continue;
				}
			} catch {}
			if (Date.now() > deadline) throw fail("Credential store is locked");
			await sleep(50);
		}
	}
}

module.exports = { ProfileStore, THINKING_LEVELS, isStrictProfileId };
