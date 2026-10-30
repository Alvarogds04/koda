"use strict";

// U2 tests: configurable role profiles, safe activation of an account
// credential into the engine's private files, live switch discipline
// (settled/idle only), and rollback on failure. Fake engine seam only; no
// real agent, no provider network.

const { spawn } = require("node:child_process");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { assertPrivate } = require("./win-private.cjs");

const { ProfileStore, THINKING_LEVELS, isStrictProfileId } = require("../src/profiles.cjs");

function tempRoot() {
	return mkdtempSync(path.join(require("node:fs").realpathSync.native(os.tmpdir()), "abito-profiles-test-"));
}

function setup(root, { engine, restart, lockWaitMs } = {}) {
	const islandRoot = path.join(root, "island");
	const accountsRoot = path.join(islandRoot, "accounts");
	const agentDir = path.join(islandRoot, "agent");
	mkdirSync(path.join(accountsRoot, "cloud"), { recursive: true, mode: 0o700 });
	mkdirSync(path.join(accountsRoot, "local"), { recursive: true, mode: 0o700 });
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	// Two named accounts: a cloud oauth one and a local OpenAI-compatible one.
	writeFileSync(
		path.join(accountsRoot, "cloud", "account.json"),
		JSON.stringify({ accountId: "cloud", label: "Cloud", provider: "anthropic", authMethod: "oauth", configured: true }),
	);
	writeFileSync(
		path.join(accountsRoot, "cloud", "auth.json"),
		JSON.stringify({ anthropic: { type: "oauth", refresh: "cloud-refresh", access: "cloud-access", expires: Date.now() + 3600_000 } }),
		{ mode: 0o600 },
	);
	writeFileSync(
		path.join(accountsRoot, "local", "account.json"),
		JSON.stringify({ accountId: "local", label: "Local", provider: "abito-local", authMethod: "api_key", configured: true }),
	);
	writeFileSync(path.join(accountsRoot, "local", "auth.json"), JSON.stringify({ "abito-local": { type: "api_key", key: "sk-fake-SECRET-2468" } }), {
		mode: 0o600,
	});
	writeFileSync(
		path.join(accountsRoot, "local", "models.json"),
		JSON.stringify({ providers: { "abito-local": { baseUrl: "http://127.0.0.1:11434/v1", api: "openai-completions", apiKey: "ollama", models: [{ id: "qwen2.5-coder:7b" }] } } }),
		{ mode: 0o600 },
	);
	const accounts = new Map([
		["cloud", { accountId: "cloud", provider: "anthropic", configured: true }],
		["local", { accountId: "local", provider: "abito-local", configured: true }],
	]);
	const store = new ProfileStore({
		islandRoot,
		agentDir,
		accounts: () => accounts,
		engine: engine ?? defaultEngine(),
		restart: restart ?? (async () => {}),
		...(lockWaitMs !== undefined ? { lockWaitMs } : {}),
	});
	return { store, islandRoot, accountsRoot, agentDir };
}

function defaultEngine({ busy = false, failSetModel = false, failStart = false } = {}) {
	const calls = { requests: [], restarts: 0, stops: 0 };
	return {
		calls,
		status: "ready",
		busy,
		async request(command) {
			calls.requests.push(command);
			if (command.type === "set_model" && failSetModel) throw new Error("FAKE-INTERNAL model unavailable");
			return { success: true };
		},
		async stop() {
			calls.stops += 1;
		},
		async start() {
			if (failStart) throw new Error("FAKE-INTERNAL start failed");
			calls.restarts += 1;
		},
	};
}

const PROFILE_FIELDS = ["accountId", "id", "label", "modelId", "provider", "role", "thinkingLevel"];

test("profile ids are strict", () => {
	for (const good of ["main", "reviewer-2", "code.local"]) {
		if (!isStrictProfileId(good)) throw new Error(`${good} should be accepted`);
	}
	for (const bad of ["", "../x", "Bad Name", "-lead", "x".repeat(65)]) {
		if (isStrictProfileId(bad)) throw new Error(`${JSON.stringify(bad)} should be refused`);
	}
});

test("profiles validate thinking levels and account/provider/model references", async () => {
	if (JSON.stringify(THINKING_LEVELS) !== JSON.stringify(["off", "minimal", "low", "medium", "high", "xhigh", "max"])) {
		throw new Error(`unexpected thinking levels: ${THINKING_LEVELS}`);
	}
	const root = tempRoot();
	try {
		const { store } = setup(root);
		{
			await store.save({ id: "main", label: "Main", role: "orchestrator", accountId: "cloud", provider: "anthropic", modelId: "claude-sonnet-5", thinkingLevel: "high" });
			for (const bad of [
				{ id: "x1", label: "X", role: "r", accountId: "ghost", provider: "anthropic", modelId: "m" },
				{ id: "x2", label: "X", role: "r", accountId: "cloud", provider: "openai", modelId: "m" },
				{ id: "x3", label: "X", role: "r", accountId: "cloud", provider: "anthropic", modelId: "claude-sonnet-5", thinkingLevel: "ultra" },
			]) {
				try {
					await store.save(bad);
					throw new Error(`invalid profile ${bad.id} must be refused`);
				} catch (error) {
					if (/FAKE|internal/i.test(error.message)) throw error;
				}
			}
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("list returns only allowlisted profile DTO fields", async () => {
	const root = tempRoot();
	try {
		const { store } = setup(root);
		await store.save({ id: "main", label: "Main", role: "orchestrator", accountId: "cloud", provider: "anthropic", modelId: "claude-sonnet-5", thinkingLevel: "high" });
		const { profiles } = store.list();
		for (const dto of profiles) {
			if (JSON.stringify(Object.keys(dto).sort()) !== JSON.stringify(PROFILE_FIELDS)) {
				throw new Error(`unexpected profile DTO keys: ${Object.keys(dto).sort()}`);
			}
			for (const forbidden of ["apiKey", "key", "token", "baseUrl", "headers", "cost"]) {
				if (forbidden in dto) throw new Error(`secret-adjacent field ${forbidden} in profile DTO`);
			}
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("activation copies the account credential, private models.json, and settings defaults; restart preserves the session", async () => {
	const root = tempRoot();
	try {
		const engine = defaultEngine();
		const { store, islandRoot, accountsRoot, agentDir } = setup(root, { engine });
		writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ theme: "dark", defaultTools: ["read"] }), { mode: 0o600 });
		await store.save({ id: "main", label: "Main", role: "orchestrator", accountId: "cloud", provider: "anthropic", modelId: "claude-sonnet-5", thinkingLevel: "high" });
		const result = await store.select("main");
		if (!result.ok) throw new Error(`activation failed: ${result.message ?? ""}`);
		// Credential landed in the owned agent auth.json at 0600.
		const agentAuth = JSON.parse(readFileSync(path.join(agentDir, "auth.json"), "utf8"));
		if (!agentAuth.anthropic || agentAuth.anthropic.refresh !== "cloud-refresh") throw new Error("credential not activated");
		if (process.platform === "win32") assertPrivate(path.join(agentDir, "auth.json"));
		else if ((statSync(path.join(agentDir, "auth.json")).mode & 0o777) !== 0o600) throw new Error("agent auth.json must be 0600");
		// Local account models.json is copied so the custom provider is available; endpoint stays private.
		const agentModels = JSON.parse(readFileSync(path.join(agentDir, "models.json"), "utf8"));
		void agentModels;
		// Settings defaults written, unrelated keys preserved.
		const settings = JSON.parse(readFileSync(path.join(agentDir, "settings.json"), "utf8"));
		if (settings.defaultProvider !== "anthropic" || settings.defaultModel !== "claude-sonnet-5") throw new Error("defaults not written");
		if (settings.defaultThinkingLevel !== "high") throw new Error("thinking default not written");
		if (settings.theme !== "dark" || JSON.stringify(settings.defaultTools) !== JSON.stringify(["read"])) throw new Error("unrelated settings lost");
		// Engine restarted once and switched live only after settling.
		if (engine.calls.restarts !== 1 || engine.calls.stops !== 1) throw new Error(`expected one clean restart, got ${JSON.stringify(engine.calls)}`);
		const setModel = engine.calls.requests.find((r) => r.type === "set_model");
		if (!setModel || setModel.provider !== "anthropic" || setModel.modelId !== "claude-sonnet-5") throw new Error("set_model not sent");
		const thinking = engine.calls.requests.find((r) => r.type === "set_thinking_level");
		if (!thinking || thinking.level !== "high") throw new Error("set_thinking_level not sent");
		// Profiles store marks the active profile; no subagent role routing files are written.
		const list = store.list();
		if (list.active !== "main") throw new Error("active marker missing");
		if (existsSync(path.join(agentDir, "subagents.json"))) throw new Error("no subagent role routing may be written");
		void islandRoot;
		void accountsRoot;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("local account activation brings the private OpenAI-compatible endpoint, never into DTOs", async () => {
	const root = tempRoot();
	try {
		const { store, agentDir } = setup(root);
		await store.save({ id: "coder", label: "Coder", role: "orchestrator", accountId: "local", provider: "abito-local", modelId: "qwen2.5-coder:7b" });
		const result = await store.select("coder");
		if (!result.ok) throw new Error("local activation failed");
		const agentModels = JSON.parse(readFileSync(path.join(agentDir, "models.json"), "utf8"));
		if (agentModels.providers["abito-local"].baseUrl !== "http://127.0.0.1:11434/v1") throw new Error("private endpoint not carried");
		const surface = JSON.stringify(store.list()) + JSON.stringify(result);
		if (surface.includes("127.0.0.1") || surface.includes("sk-fake")) throw new Error("private endpoint or key leaked into public surface");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the latest SDK-refreshed credential of the previous account is preserved before switching", async () => {
	const root = tempRoot();
	try {
		const { store, agentDir, accountsRoot } = setup(root);
		// The agent had account "cloud" active and its SDK refreshed the token there.
		writeFileSync(
			path.join(agentDir, "auth.json"),
			JSON.stringify({ anthropic: { type: "oauth", refresh: "REFRESHED-IN-AGENT", access: "a2", expires: Date.now() + 3600_000 } }),
			{ mode: 0o600 },
		);
		writeFileSync(path.join(store.activeAccountPath), JSON.stringify({ accountId: "cloud", provider: "anthropic" }), { mode: 0o600 });
		await store.save({ id: "coder", label: "Coder", role: "orchestrator", accountId: "local", provider: "abito-local", modelId: "qwen2.5-coder:7b" });
		const result = await store.select("coder");
		if (!result.ok) throw new Error("switch failed");
		const cloudAuth = JSON.parse(readFileSync(path.join(accountsRoot, "cloud", "auth.json"), "utf8"));
		if (cloudAuth.anthropic.refresh !== "REFRESHED-IN-AGENT") throw new Error("refreshed credential was lost or stale-overwritten");
		const agentAuth = JSON.parse(readFileSync(path.join(agentDir, "auth.json"), "utf8"));
		if (!agentAuth["abito-local"]) throw new Error("new account credential not activated");
		if (agentAuth.anthropic) throw new Error("old provider credential must not stay active in the agent");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("busy engine: switch is rejected, nothing is written, no restart", async () => {
	const root = tempRoot();
	try {
		const engine = defaultEngine({ busy: true });
		const { store, agentDir } = setup(root, { engine });
		writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }), { mode: 0o600 });
		await store.save({ id: "main", label: "Main", role: "orchestrator", accountId: "cloud", provider: "anthropic", modelId: "claude-sonnet-5" });
		let message = "";
		try {
			await store.select("main");
			throw new Error("busy switch must be rejected");
		} catch (error) {
			message = error.message;
		}
		if (!/busy/i.test(message)) throw new Error(`unexpected refusal: ${message}`);
		const settings = JSON.parse(readFileSync(path.join(agentDir, "settings.json"), "utf8"));
		if (settings.defaultProvider) throw new Error("settings must be untouched while busy");
		if (existsSync(path.join(agentDir, "auth.json"))) throw new Error("auth.json must not be written while busy");
		if (engine.calls.restarts !== 0 || engine.calls.requests.length !== 0) throw new Error("no restart or commands while busy");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("failure rolls back agent auth/models/settings and the active-account marker", async () => {
	const root = tempRoot();
	try {
		const engine = defaultEngine({ failStart: true });
		const { store, agentDir } = setup(root, { engine });
		writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "oauth", refresh: "keep-me", access: "a", expires: 1 } }), { mode: 0o600 });
		writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }), { mode: 0o600 });
		await store.save({ id: "main", label: "Main", role: "orchestrator", accountId: "local", provider: "abito-local", modelId: "qwen2.5-coder:7b" });
		let message = "";
		try {
			await store.select("main");
			throw new Error("activation must fail when the engine restart fails");
		} catch (error) {
			message = error.message;
		}
		if (/FAKE-INTERNAL/.test(message)) throw new Error("internal error details leaked to the caller");
		const agentAuth = JSON.parse(readFileSync(path.join(agentDir, "auth.json"), "utf8"));
		if (!agentAuth.anthropic || agentAuth.anthropic.refresh !== "keep-me") throw new Error("auth.json not restored");
		const settings = JSON.parse(readFileSync(path.join(agentDir, "settings.json"), "utf8"));
		if (settings.defaultProvider) throw new Error("settings not restored");
		if (existsSync(path.join(agentDir, "models.json"))) throw new Error("models.json must not remain after rollback");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a corrupted settings.json refuses activation without losing auth", async () => {
	const root = tempRoot();
	try {
		const { store, agentDir } = setup(root);
		writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "oauth", refresh: "keep", access: "a", expires: 1 } }), { mode: 0o600 });
		writeFileSync(path.join(agentDir, "settings.json"), "{not json", { mode: 0o600 });
		await store.save({ id: "main", label: "Main", role: "orchestrator", accountId: "local", provider: "abito-local", modelId: "qwen2.5-coder:7b" });
		try {
			await store.select("main");
			throw new Error("corrupt settings must refuse activation");
		} catch (error) {
			if (/FAKE/i.test(error.message)) throw error;
		}
		const agentAuth = JSON.parse(readFileSync(path.join(agentDir, "auth.json"), "utf8"));
		if (agentAuth.anthropic.refresh !== "keep") throw new Error("auth.json must be untouched on settings failure");
		if (existsSync(path.join(agentDir, "models.json"))) throw new Error("models.json must not remain");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a stale lock is broken, not deadlocked", async () => {
	const root = tempRoot();
	try {
		const { store, agentDir } = setup(root);
		await store.save({ id: "main", label: "Main", role: "orchestrator", accountId: "cloud", provider: "anthropic", modelId: "claude-sonnet-5" });
		// Stale lock (older than the stale window) must be broken, not deadlock.
		const lockDir = path.join(agentDir, "auth.json.lock");
		mkdirSync(lockDir);
		const stale = new Date(Date.now() - 60_000);
		const { utimesSync } = require("node:fs");
		utimesSync(lockDir, stale, stale);
		const result = await store.select("main");
		if (!result.ok) throw new Error(`stale lock must be broken: ${result.message ?? ""}`);
		if (existsSync(lockDir)) throw new Error("lock must be released");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("selection is explicit: no automatic preferred provider, no implicit switching", async () => {
	const root = tempRoot();
	try {
		const engine = defaultEngine();
		const { store } = setup(root, { engine });
		await store.save({ id: "main", label: "Main", role: "orchestrator", accountId: "cloud", provider: "anthropic", modelId: "claude-sonnet-5" });
		store.list();
		store.roles();
		if (engine.calls.restarts !== 0 || engine.calls.requests.length !== 0) throw new Error("listing/roles must never activate anything");
		// Explicit role mapping: exactly one profile per role selects; ambiguity is refused.
		const outcome = await store.selectForRole("orchestrator");
		if (!outcome.ok) throw new Error(`explicit role selection failed: ${outcome.message ?? ""}`);
		await store.save({ id: "second", label: "Second", role: "orchestrator", accountId: "local", provider: "abito-local", modelId: "qwen2.5-coder:7b" });
		try {
			await store.selectForRole("orchestrator");
			throw new Error("ambiguous role must be refused");
		} catch (error) {
			if (!/ambiguous|multiple/i.test(error.message)) throw error;
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("profiles referencing a removed account are refused at selection", async () => {
	const root = tempRoot();
	try {
		const { store } = setup(root);
		await store.save({ id: "main", label: "Main", role: "orchestrator", accountId: "cloud", provider: "anthropic", modelId: "claude-sonnet-5" });
		// Simulate the account disappearing between save and select.
		store.options.accounts = () => new Map();
		try {
			await store.select("main");
			throw new Error("missing account must refuse selection");
		} catch (error) {
			if (!/account/i.test(error.message)) throw error;
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a lock held by another process refuses activation within a bounded wait and writes nothing", async () => {
	const root = tempRoot();
	let holder;
	try {
		const engine = defaultEngine();
		const { store, agentDir } = setup(root, { engine, lockWaitMs: 300 });
		await store.save({ id: "main", label: "Main", role: "orchestrator", accountId: "cloud", provider: "anthropic", modelId: "claude-sonnet-5" });
		const lockDir = path.join(agentDir, "auth.json.lock");
		// A genuinely separate process holds the SDK-style lock directory.
		holder = spawn(process.execPath, ["-e", `require("fs").mkdirSync(${JSON.stringify(lockDir)}); console.log("held"); setInterval(()=>{}, 1000)`], { stdio: ["ignore", "pipe", "ignore"] });
		await new Promise((resolve, reject) => {
			holder.stdout.once("data", resolve);
			holder.once("error", reject);
		});
		const started = Date.now();
		let message = "";
		try {
			await store.select("main");
			throw new Error("a held lock must refuse activation");
		} catch (error) {
			message = error.message;
		}
		const elapsed = Date.now() - started;
		if (!/locked/i.test(message)) throw new Error(`unexpected refusal: ${message}`);
		if (elapsed < 250 || elapsed > 3000) throw new Error(`wait must be bounded by lockWaitMs, took ${elapsed}ms`);
		if (!existsSync(lockDir)) throw new Error("a foreign lock must not be removed");
		if (existsSync(path.join(agentDir, "auth.json"))) throw new Error("nothing may be written while locked");
		if (engine.calls.restarts !== 0) throw new Error("no restart while locked");
	} finally {
		if (holder) {
			holder.kill();
			await new Promise((resolve) => holder.once("exit", resolve));
		}
		rmSync(root, { recursive: true, force: true });
	}
});

test("a tampered profile accountId (traversal) is refused at selection and dropped on load", async () => {
	const root = tempRoot();
	try {
		const engine = defaultEngine();
		const { store, islandRoot, agentDir, accountsRoot } = setup(root, { engine });
		// An attacker-controlled directory outside accounts/ that a traversal id would reach.
		mkdirSync(path.join(islandRoot, "evil"), { recursive: true });
		writeFileSync(path.join(islandRoot, "evil", "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "STOLEN" } }));
		writeFileSync(
			path.join(islandRoot, "profiles.json"),
			JSON.stringify({ profiles: [{ id: "bad", label: "Bad", role: "r", accountId: "../evil", provider: "anthropic", modelId: "m", thinkingLevel: "low" }] }),
		);
		store.options.accounts = () => new Map([["../evil", { accountId: "../evil", provider: "anthropic", configured: true }]]);
		if (store.list().profiles.length !== 0) throw new Error("profile with a traversal accountId must be dropped on load");
		// Even if it were loaded, activation must refuse before touching anything.
		writeFileSync(
			path.join(islandRoot, "profiles.json"),
			JSON.stringify({ profiles: [{ id: "bad", label: "Bad", role: "r", accountId: "../evil", provider: "anthropic", modelId: "m", thinkingLevel: "low" }] }),
		);
		try {
			await store.select("bad");
			throw new Error("traversal accountId must be refused");
		} catch (error) {
			if (!/unknown|invalid/i.test(error.message)) throw error;
		}
		if (existsSync(path.join(agentDir, "auth.json"))) throw new Error("no credential may be copied");
		if (engine.calls.restarts !== 0) throw new Error("no restart");
		void accountsRoot;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("rollback after a post-restart failure restarts the running engine so memory matches disk", async () => {
	const root = tempRoot();
	try {
		const engine = defaultEngine({ failSetModel: true });
		const { store, agentDir } = setup(root, { engine });
		writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "oauth", refresh: "keep-me", access: "a", expires: 1 } }), { mode: 0o600 });
		await store.save({ id: "main", label: "Main", role: "orchestrator", accountId: "local", provider: "abito-local", modelId: "qwen2.5-coder:7b" });
		try {
			await store.select("main");
			throw new Error("set_model failure must fail activation");
		} catch (error) {
			if (/FAKE-INTERNAL/.test(error.message)) throw new Error("internal details leaked");
		}
		const agentAuth = JSON.parse(readFileSync(path.join(agentDir, "auth.json"), "utf8"));
		if (agentAuth.anthropic?.refresh !== "keep-me" || agentAuth["abito-local"]) throw new Error("auth.json not restored");
		// One restart to activate, one more to drop the activated credential from memory.
		if (engine.calls.stops !== 2 || engine.calls.restarts !== 2) throw new Error(`engine must be restarted after rollback: ${JSON.stringify({ s: engine.calls.stops, r: engine.calls.restarts })}`);
		if (store.list().active !== undefined) throw new Error("no active profile after a failed activation");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ----- crash window: write-ahead switch journal -----------------------------

async function crashedSwitch(root, { corruptAuth } = {}) {
	const ctx = setup(root);
	const { store, agentDir, accountsRoot } = ctx;
	await store.save({ id: "main", label: "Main", role: "orchestrator", accountId: "cloud", provider: "anthropic", modelId: "m1" });
	await store.save({ id: "coder", label: "Coder", role: "coder", accountId: "local", provider: "abito-local", modelId: "m2" });
	await store.select("main");
	// The SDK refreshed the cloud token inside the agent dir only.
	writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "oauth", refresh: "cloud-REFRESHED", access: "a", expires: 1 } }), { mode: 0o600 });
	// Simulate the process dying right after the auth write: marker write throws, nothing is rolled back.
	store.writeMarker = () => {
		throw new Error("simulated crash");
	};
	store.rollback = async () => {};
	await store.select("coder").then(
		() => {
			throw new Error("crash simulation must fail");
		},
		() => {},
	);
	if (corruptAuth) writeFileSync(path.join(agentDir, "auth.json"), "{ not json", { mode: 0o600 });
	const marker = () => JSON.parse(readFileSync(path.join(ctx.islandRoot, "active-account.json"), "utf8"));
	return { ...ctx, marker, cloudStored: () => readFileSync(path.join(accountsRoot, "cloud", "auth.json"), "utf8") };
}

test("crash after the auth write: a new store repairs the marker to the new account and never writes the wrong account", async () => {
	const root = tempRoot();
	try {
		const ctx = await crashedSwitch(root);
		const cloudBefore = ctx.cloudStored();
		if (ctx.marker().accountId !== "cloud") throw new Error("precondition: marker still names the old account");
		if (!existsSync(path.join(ctx.agentDir, ".switch.json"))) throw new Error("journal must exist after the crash");
		const fresh = new ProfileStore(ctx.store.options);
		if (ctx.marker().accountId !== "local") throw new Error(`marker not repaired: ${JSON.stringify(ctx.marker())}`);
		if (existsSync(path.join(ctx.agentDir, ".switch.json"))) throw new Error("journal must be deleted after reconcile");
		if (ctx.cloudStored() !== cloudBefore) throw new Error("reconcile must not run preserveRefreshedCredential");
		if (ctx.cloudStored().includes("sk-fake")) throw new Error("local credential leaked into cloud account");
		void fresh;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("crash with undecidable auth.json: no active account (fail closed), nothing preserved", async () => {
	const root = tempRoot();
	try {
		const ctx = await crashedSwitch(root, { corruptAuth: true });
		const cloudBefore = ctx.cloudStored();
		new ProfileStore(ctx.store.options);
		if (existsSync(path.join(ctx.islandRoot, "active-account.json"))) throw new Error("marker must be removed when undecidable");
		if (existsSync(path.join(ctx.agentDir, ".switch.json"))) throw new Error("journal must be deleted");
		if (ctx.cloudStored() !== cloudBefore) throw new Error("account store must be untouched");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a journal found on the first mutation is reconciled before any preserve", async () => {
	const root = tempRoot();
	try {
		const ctx = await crashedSwitch(root);
		const cloudBefore = ctx.cloudStored();
		const later = new ProfileStore(ctx.store.options);
		// Journal re-planted after construction (e.g. another process died): reconciled at the next switch.
		writeFileSync(path.join(ctx.agentDir, ".switch.json"), JSON.stringify({ from: { accountId: "cloud", provider: "anthropic" }, to: { accountId: "local", provider: "abito-local" }, startedAt: 1 }), { mode: 0o600 });
		writeFileSync(path.join(ctx.islandRoot, "active-account.json"), JSON.stringify({ accountId: "cloud", provider: "anthropic" }));
		await later.select("coder");
		if (ctx.cloudStored() !== cloudBefore) throw new Error("preserve ran against a journaled (ambiguous) state");
		if (existsSync(path.join(ctx.agentDir, ".switch.json"))) throw new Error("journal must be gone after a clean switch");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ----- v0.2: deactivate -----------------------------------------------------

const MAIN = { id: "main", label: "Main", role: "orchestrator", accountId: "cloud", provider: "anthropic", modelId: "claude-sonnet-5", thinkingLevel: "high" };
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

async function activated(root, engine) {
	const ctx = setup(root, { engine });
	writeFileSync(path.join(ctx.agentDir, "settings.json"), JSON.stringify({ theme: "dark" }), { mode: 0o600 });
	await ctx.store.save(MAIN);
	await ctx.store.select("main");
	return ctx;
}

test("deactivate removes what activation wrote, keeps unrelated settings, clears marker/journal/active and restarts", async () => {
	const root = tempRoot();
	try {
		const engine = defaultEngine();
		const { store, agentDir, islandRoot } = await activated(root, engine);
		if (!existsSync(path.join(agentDir, "auth.json"))) throw new Error("precondition: activated");
		const before = engine.calls.restarts;
		const result = await store.deactivate();
		if (result.deactivated !== true || result.active !== undefined || result.profiles.length !== 1) throw new Error(`unexpected result ${JSON.stringify(result)}`);
		for (const f of ["auth.json", "models.json", ".switch.json"]) if (existsSync(path.join(agentDir, f))) throw new Error(`${f} must be gone`);
		if (existsSync(path.join(islandRoot, "active-account.json"))) throw new Error("marker must be cleared");
		const settings = readJson(path.join(agentDir, "settings.json"));
		if (JSON.stringify(settings) !== JSON.stringify({ theme: "dark" })) throw new Error(`settings defaults must be removed, rest kept: ${JSON.stringify(settings)}`);
		if (store.list().active !== undefined) throw new Error("active must be cleared");
		if (store.list().profiles.length !== 1) throw new Error("profiles must stay saved");
		if (engine.calls.restarts !== before + 1 || engine.calls.stops < 1) throw new Error("engine must restart once");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("deactivate first preserves the refreshed credential into the active account's store", async () => {
	const root = tempRoot();
	try {
		const { store, agentDir, accountsRoot } = await activated(root);
		writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "oauth", refresh: "REFRESHED-LATE", access: "a9", expires: 1 } }), { mode: 0o600 });
		await store.deactivate();
		if (readJson(path.join(accountsRoot, "cloud", "auth.json")).anthropic.refresh !== "REFRESHED-LATE") throw new Error("refresh was lost");
		if (existsSync(path.join(agentDir, "auth.json"))) throw new Error("agent auth.json must be removed");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a logged-out account store is authoritative: deactivate does not resurrect the revoked credential", async () => {
	const root = tempRoot();
	try {
		const { store, agentDir, accountsRoot } = await activated(root);
		writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "oauth", refresh: "STILL-IN-AGENT", access: "a", expires: 1 } }), { mode: 0o600 });
		writeFileSync(path.join(accountsRoot, "cloud", "auth.json"), "{}\n", { mode: 0o600 });
		await store.deactivate();
		const stored = readJson(path.join(accountsRoot, "cloud", "auth.json"));
		if (stored.anthropic !== undefined) throw new Error("revoked credential was resurrected");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("deactivate without an active profile is a no-op returning the profiles", async () => {
	const root = tempRoot();
	try {
		const engine = defaultEngine();
		const { store, agentDir } = setup(root, { engine });
		await store.save(MAIN);
		writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultModel: "x" }), { mode: 0o600 });
		const result = await store.deactivate();
		if (result.deactivated !== false || result.profiles.length !== 1 || result.active !== undefined) throw new Error(`unexpected ${JSON.stringify(result)}`);
		if (engine.calls.stops !== 0 || engine.calls.restarts !== 0) throw new Error("no restart on a no-op");
		if (readJson(path.join(agentDir, "settings.json")).defaultModel !== "x") throw new Error("settings must stay untouched");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("deactivate refuses while the engine is busy and writes nothing", async () => {
	const root = tempRoot();
	try {
		const engine = defaultEngine();
		const { store, agentDir, islandRoot } = await activated(root, engine);
		engine.busy = true;
		const auth = readFileSync(path.join(agentDir, "auth.json"), "utf8");
		const restarts = engine.calls.restarts;
		await store.deactivate().then(
			() => {
				throw new Error("must refuse");
			},
			(error) => {
				if (!/busy/i.test(error.message)) throw error;
			},
		);
		if (readFileSync(path.join(agentDir, "auth.json"), "utf8") !== auth) throw new Error("auth.json changed");
		if (!existsSync(path.join(islandRoot, "active-account.json")) || store.list().active !== "main") throw new Error("still active");
		if (engine.calls.restarts !== restarts || existsSync(path.join(agentDir, ".switch.json"))) throw new Error("no restart/journal on refusal");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("deactivate failure rolls back every file and keeps the profile active", async () => {
	const root = tempRoot();
	try {
		const engine = defaultEngine();
		const { store, agentDir, islandRoot } = await activated(root, engine);
		const names = ["auth.json", "models.json", "settings.json"].map((n) => path.join(agentDir, n));
		const snap = names.map((f) => readFileSync(f, "utf8"));
		const marker = readFileSync(path.join(islandRoot, "active-account.json"), "utf8");
		let first = true;
		engine.start = async () => {
			if (first) {
				first = false;
				throw new Error("FAKE-INTERNAL start failed");
			}
			engine.calls.restarts += 1;
		};
		await store.deactivate().then(
			() => {
				throw new Error("must fail");
			},
			(error) => {
				if (/FAKE-INTERNAL/.test(error.message)) throw new Error("internal detail leaked");
			},
		);
		names.forEach((f, i) => {
			if (readFileSync(f, "utf8") !== snap[i]) throw new Error(`${path.basename(f)} not restored`);
		});
		if (readFileSync(path.join(islandRoot, "active-account.json"), "utf8") !== marker) throw new Error("marker not restored");
		if (store.list().active !== "main") throw new Error("active must stay");
		if (existsSync(path.join(agentDir, ".switch.json"))) throw new Error("journal must be cleared after rollback");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("crash during deactivate (writeMarker seam): journal remains and a new store settles to no active account", async () => {
	const root = tempRoot();
	try {
		const ctx = await activated(root);
		const { store, agentDir, islandRoot } = ctx;
		store.writeMarker = () => {
			throw new Error("simulated crash");
		};
		store.rollback = async () => {};
		await store.deactivate().then(
			() => {
				throw new Error("crash simulation must fail");
			},
			() => {},
		);
		if (!existsSync(path.join(agentDir, ".switch.json"))) throw new Error("journal must exist in the crash window");
		if (!existsSync(path.join(islandRoot, "active-account.json"))) throw new Error("marker survives the crash");
		new ProfileStore(store.options);
		if (existsSync(path.join(agentDir, ".switch.json"))) throw new Error("journal must be reconciled away");
		if (existsSync(path.join(islandRoot, "active-account.json"))) throw new Error("no account may stay active");
		if (new ProfileStore(store.options).list().active !== undefined) throw new Error("active profile must be cleared");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ----- V5: a local account activates through the existing machinery ---------------------

test("a local account (created by AccountManager) saves, selects and copies its private models.json", async () => {
	const root = tempRoot();
	try {
		const { AccountManager, helperEnv } = require("../src/auth.cjs");
		const islandRoot = path.join(root, "island");
		const accountsRoot = path.join(islandRoot, "accounts");
		const agentDir = path.join(islandRoot, "agent");
		mkdirSync(agentDir, { recursive: true, mode: 0o700 });
		const manager = new AccountManager({
			accountsRoot,
			helper: { command: process.execPath, args: [path.join(__dirname, "fixtures", "fake-auth.cjs"), "--accounts-root", accountsRoot], env: helperEnv(process.env, { home: accountsRoot, tmp: accountsRoot }) },
		});
		await manager.createLocalAccount({ label: "Ollama", accountId: "ollama", baseUrl: "http://127.0.0.1:11434/v1", modelIds: ["qwen2.5-coder:7b"] });
		const engine = defaultEngine();
		const store = new ProfileStore({
			islandRoot,
			agentDir,
			accounts: () => new Map(manager.listAccounts().map((a) => [a.accountId, a])),
			engine,
			restart: async () => {},
		});
		await store.save({ id: "loc", label: "Local", role: "worker", accountId: "ollama", provider: "local-ollama", modelId: "qwen2.5-coder:7b" });
		await store.select("loc");
		assert.equal(store.list().active, "loc");
		const models = JSON.parse(readFileSync(path.join(agentDir, "models.json"), "utf8"));
		assert.equal(models.providers["local-ollama"].baseUrl, "http://127.0.0.1:11434/v1");
		assert.deepEqual(JSON.parse(readFileSync(path.join(agentDir, "auth.json"), "utf8")), { "local-ollama": { type: "api_key", key: "abito-local-endpoint" } });
		if (process.platform === "win32") assertPrivate(path.join(agentDir, "models.json"));
		else assert.equal(statSync(path.join(agentDir, "models.json")).mode & 0o777, 0o600);
		assert.equal(JSON.parse(readFileSync(path.join(agentDir, "settings.json"), "utf8")).defaultProvider, "local-ollama");
		assert.equal(JSON.stringify(store.list()).includes("11434"), false);
		// A logged-out local account cannot be activated (existing check).
		await store.deactivate();
		await manager.logout("ollama");
		await assert.rejects(store.select("loc"), /not signed in/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ----- HU-041 T6a-2: custom-provider accounts activate only through the guarded extension ----

test("custom-provider account activates with the fixed extension; unusable ones are refused without touching any agent file", async () => {
	const root = tempRoot();
	try {
		const { store, accountsRoot, agentDir } = setup(root);
		mkdirSync(path.join(accountsRoot, "gw"), { mode: 0o700 });
		writeFileSync(path.join(accountsRoot, "gw", "auth.json"), JSON.stringify({ "custom-gw": { type: "api_key", key: "sk-fake-SECRET-2468" } }), { mode: 0o600 });
		writeFileSync(path.join(accountsRoot, "gw", "models.json"), JSON.stringify({ providers: { "custom-gw": { baseUrl: "https://gateway.example/v1", api: "openai-completions", models: [] } } }));
		const accounts = new Map([["gw", { accountId: "gw", provider: "custom-gw", configured: true, custom: true }]]);
		const custom = new ProfileStore({ islandRoot: path.join(root, "island"), agentDir, accounts: () => accounts, engine: defaultEngine(), restart: async () => {} });
		await custom.save({ id: "gw1", label: "G", role: "main", accountId: "gw", provider: "custom-gw", modelId: "model-a" });
		// Before discovery there are no models: refused, nothing written.
		await assert.rejects(custom.select("gw1"), /no discovered models/);
		assert.equal(custom.list().active, undefined);
		assert.equal(existsSync(path.join(agentDir, "auth.json")), false);
		assert.equal(existsSync(path.join(agentDir, "extensions")), false);
		assert.equal(existsSync(path.join(root, "island", "active-account.json")), false);
		writeFileSync(path.join(accountsRoot, "gw", "models.json"), JSON.stringify({ providers: { "custom-gw": { baseUrl: "https://gateway.example/v1", api: "openai-completions", models: [{ id: "model-a" }] } } }));
		await custom.select("gw1");
		assert.ok(existsSync(path.join(agentDir, "extensions", "abito-custom-provider.js")));
		// Existing static and local accounts behave exactly as before (and drop the extension again).
		await store.save({ id: "main", label: "Main", role: "orchestrator", accountId: "cloud", provider: "anthropic", modelId: "claude-sonnet-5" });
		await store.select("main");
		assert.ok(JSON.parse(readFileSync(path.join(agentDir, "auth.json"), "utf8")).anthropic);
		assert.equal(existsSync(path.join(agentDir, "extensions", "abito-custom-provider.js")), false);
		await store.save({ id: "loc", label: "Loc", role: "local", accountId: "local", provider: "abito-local", modelId: "qwen2.5-coder:7b" });
		await store.select("loc");
		assert.equal(JSON.parse(readFileSync(path.join(agentDir, "models.json"), "utf8")).providers["abito-local"].models[0].id, "qwen2.5-coder:7b");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
