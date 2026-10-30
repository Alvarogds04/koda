"use strict";

// U2 tests: named accounts, native authentication through the SDK-helper seam,
// sanitized DTOs and secret hygiene. All child processes are local fixtures;
// no provider network, no real credentials, no login against a real provider.
// The one native smoke block runs offline against the installed SDK module.

const { once } = require("node:events");
const { chmodSync, existsSync, mkdirSync, readFileSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
	AccountManager,
	helperEnv,
	isStrictAccountId,
} = require("../src/auth.cjs");

const { assertPrivate } = require("./win-private.cjs");
const WIN = process.platform === "win32";

const FIXTURE = path.join(__dirname, "fixtures", "fake-auth.cjs");
const SECRET = "sk-fake-SECRET-2468-DO-NOT-LEAK";
const SECRET_MARKERS = [SECRET, "sk-fake-SECRET", "FAKE-INTERNAL-DETAIL"];

/** Windows twin helper: a file symlink as the Unix test does; if the runner cannot create one, fail with a clear message (never skip). */
function symlinkOrFail(target, link) {
	try {
		symlinkSync(target, link);
	} catch (error) {
		if (!WIN) throw error;
		throw new Error(`cannot create a symlink on this Windows runner (${error.code}); the reparse-refusal twin cannot run`);
	}
}

function tempRoot() {
	return mkdtempSync(path.join(require("node:fs").realpathSync.native(os.tmpdir()), "abito-auth-test-"));
}

function fixtureHelper(accountsRoot, extraEnv = {}) {
	return {
		command: process.execPath,
		args: [FIXTURE, "--accounts-root", accountsRoot],
		env: { ...helperEnv(process.env, { home: accountsRoot, tmp: accountsRoot }), ...extraEnv },
	};
}

function makeManager(root, options = {}) {
	return new AccountManager({
		accountsRoot: path.join(root, "accounts"),
		helper: fixtureHelper(path.join(root, "accounts"), options.helperEnv),
		log: options.log ?? (() => {}),
		...(options.promptTimeoutMs ? { promptTimeoutMs: options.promptTimeoutMs } : {}),
		...(options.inUse ? { inUse: options.inUse } : {}),
	});
}

function collectOutput(lines) {
	return lines.join("\n");
}

test("account ids are strict", () => {
	for (const good of ["work", "personal-2", "a.b_c-d"]) {
		if (!isStrictAccountId(good)) throw new Error(`${good} should be accepted`);
	}
	for (const bad of ["", "..", "../escape", "A B", "-lead", "x".repeat(65), "sl/ash"]) {
		if (isStrictAccountId(bad)) throw new Error(`${JSON.stringify(bad)} should be refused`);
	}
});

test("createAccount derives a strict id and writes only public metadata", async () => {
	const root = tempRoot();
	try {
		const manager = makeManager(root);
		const account = await manager.createAccount({ label: "Trabajo Personal", provider: "anthropic" });
		if (!isStrictAccountId(account.accountId)) throw new Error("id not strict");
		if (JSON.stringify(Object.keys(account).sort()) !== JSON.stringify(["accountId", "authMethod", "configured", "label", "provider"])) {
			throw new Error(`unexpected DTO keys: ${Object.keys(account).sort()}`);
		}
		const metadata = JSON.parse(readFileSync(path.join(root, "accounts", account.accountId, "account.json"), "utf8"));
		for (const key of Object.keys(metadata)) {
			if (!["accountId", "authMethod", "configured", "createdAt", "label", "provider"].includes(key)) {
				throw new Error(`unexpected metadata key ${key}`);
			}
		}
		if (existsSync(path.join(root, "accounts", account.accountId, "auth.json"))) {
			throw new Error("fresh account must not contain credentials");
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("two named accounts on the same provider are fully separated", async () => {
	const root = tempRoot();
	try {
		const manager = makeManager(root);
		const a = await manager.createAccount({ label: "work", provider: "openai" });
		const b = await manager.createAccount({ label: "personal", provider: "openai" });
		if (a.accountId === b.accountId) throw new Error("ids must differ");
		await manager.enrollApiKey({ accountId: a.accountId, providerId: "openai", apiKey: SECRET });
		const statusA = await manager.status(a.accountId);
		const statusB = await manager.status(b.accountId);
		if (!statusA.configured) throw new Error("account A should be configured");
		if (statusB.configured) throw new Error("account B must stay unconfigured");
		const list = manager.listAccounts();
		if (list.length !== 2) throw new Error("expected two accounts");
		for (const dto of list) {
			if (JSON.stringify(Object.keys(dto).sort()) !== JSON.stringify(["accountId", "authMethod", "configured", "label", "provider"])) {
				throw new Error(`unexpected account DTO keys: ${Object.keys(dto).sort()}`);
			}
			for (const forbidden of ["apiKey", "key", "token", "baseUrl", "headers", "env"]) {
				if (forbidden in dto) throw new Error(`secret-adjacent field ${forbidden} in DTO`);
			}
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the helper child gets a clean environment: no provider keys, no PI_* setup", async () => {
	const root = tempRoot();
	try {
		const accountsRoot = path.join(root, "accounts");
		mkdirSync(accountsRoot, { recursive: true });
		const envOut = path.join(root, "env-out.json");
		const env = helperEnv(
			{
				...process.env,
				ANTHROPIC_API_KEY: "leak-me-1",
				OPENAI_API_KEY: "leak-me-2",
				GOOGLE_API_KEY: "leak-me-3",
				PI_CODING_AGENT_DIR: "/home/user/.pi/agent",
				PI_OFFLINE: "0",
				SOME_RANDOM_SECRET: "leak-me-4",
			},
			{ home: path.join(root, "home"), tmp: path.join(root, "tmp") },
		);
		const helper = new AccountManager({
			accountsRoot,
			helper: { command: process.execPath, args: [FIXTURE, "--accounts-root", accountsRoot], env: { ...env, FAKE_ENV_OUT: envOut } },
		});
		await helper.providers();
		{
			const childEnv = JSON.parse(readFileSync(envOut, "utf8"));
			for (const banned of Object.keys(childEnv)) {
				if (/API_KEY|SECRET|TOKEN|PI_/.test(banned)) throw new Error(`banned env key reached helper: ${banned}`);
			}
			if (childEnv.HOME !== path.join(root, "home")) throw new Error("helper HOME must be the island home");
			if (childEnv.TMPDIR !== path.join(root, "tmp")) throw new Error("helper TMPDIR must be the island tmp");
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("providers and models DTOs are allowlisted for local and cloud providers", async () => {
	const root = tempRoot();
	try {
		const manager = makeManager(root, { helperEnv: { FAKE_LOCAL_PROVIDER: "1" } });
		const providers = await manager.providers();
		const cloud = providers.find((p) => p.id === "openai");
		const local = providers.find((p) => p.id === "abito-local");
		if (!cloud || !local) throw new Error("expected cloud and local providers");
		for (const provider of providers) {
			if (JSON.stringify(Object.keys(provider).sort()) !== JSON.stringify(["configured", "id", "methods", "name"])) {
				throw new Error(`unexpected provider DTO keys: ${Object.keys(provider).sort()}`);
			}
		}
		const models = await manager.models();
		if (models.length < 3) throw new Error("expected cloud and local models");
		for (const model of models) {
			if (JSON.stringify(Object.keys(model).sort()) !== JSON.stringify(["contextWindow", "id", "input", "name", "provider", "reasoning"])) {
				throw new Error(`unexpected model DTO keys: ${Object.keys(model).sort()}`);
			}
			for (const forbidden of ["baseUrl", "cost", "headers", "apiKey"]) {
				if (forbidden in model) throw new Error(`secret-adjacent field ${forbidden} in model DTO`);
			}
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("native login flow: prompts correlate, answers never echo, output carries no secret markers", async () => {
	const root = tempRoot();
	try {
		const logLines = [];
		const manager = makeManager(root, { log: (line) => logLines.push(line) });
		const account = await manager.createAccount({ label: "cloud", provider: "anthropic" });
		const seen = [];
		manager.on("auth_prompt", (p) => seen.push(["prompt", p]));
		manager.on("auth_event", (e) => seen.push(["event", e]));
		const done = once(manager, "auth_done");
		const started = manager.startLogin({ accountId: account.accountId, method: "oauth" });
		const [firstPrompt] = await once(manager, "auth_prompt");
		if (!firstPrompt.flowId || !firstPrompt.promptId) throw new Error("prompt must carry correlation ids");
		if (firstPrompt.secret === true) throw new Error("oauth text prompt must not be flagged secret");
		await manager.reply(firstPrompt.flowId, { promptId: firstPrompt.promptId, value: "verification-code-123" });
		const [donePayload] = await done;
		if (!donePayload.ok) throw new Error(`login should succeed: ${JSON.stringify(donePayload)}`);
		if (started.then) await started;
		const status = await manager.status(account.accountId);
		if (!status.configured || status.authMethod !== "oauth") throw new Error("oauth credential missing");
		// Output surface: prompts, events, done payloads, log lines.
		const surface = JSON.stringify(seen) + JSON.stringify(donePayload) + collectOutput(logLines);
		for (const marker of [...SECRET_MARKERS, "verification-code-123"]) {
			if (surface.includes(marker)) throw new Error(`secret marker leaked: ${marker}`);
		}
		// Prompt payloads must not carry a value field at all.
		for (const [kind, payload] of seen) {
			if (kind === "prompt" && "value" in payload) throw new Error("prompt carries a value field");
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("api-key enrollment accepts the key privately and never echoes it", async () => {
	const root = tempRoot();
	try {
		const logLines = [];
		const manager = makeManager(root, { log: (line) => logLines.push(line) });
		const account = await manager.createAccount({ label: "keyed", provider: "openai" });
		const dto = await manager.enrollApiKey({ accountId: account.accountId, providerId: "openai", apiKey: SECRET });
		if (JSON.stringify(Object.keys(dto).sort()) !== JSON.stringify(["accountId", "authMethod", "configured", "label", "provider"])) {
			throw new Error(`unexpected enroll DTO keys: ${Object.keys(dto).sort()}`);
		}
		const status = await manager.status(account.accountId);
		if (!status.configured || status.authMethod !== "api_key") throw new Error("api key not stored");
		const stored = JSON.parse(readFileSync(path.join(root, "accounts", account.accountId, "auth.json"), "utf8"));
		if (stored.openai.key !== SECRET) throw new Error("key not stored in the private account auth.json");
		const surface = collectOutput(logLines) + JSON.stringify(dto) + JSON.stringify(status);
		for (const marker of SECRET_MARKERS) {
			if (surface.includes(marker)) throw new Error(`secret marker leaked: ${marker}`);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("login failure surfaces a generic message only", async () => {
	const root = tempRoot();
	try {
		const logLines = [];
		const manager = makeManager(root, { log: (line) => logLines.push(line), helperEnv: { FAKE_LOGIN_FAIL: "1" } });
		const account = await manager.createAccount({ label: "broken", provider: "anthropic" });
		const done = once(manager, "auth_done");
		manager.startLogin({ accountId: account.accountId, method: "api_key" });
		const [prompt] = await once(manager, "auth_prompt");
		if (prompt.secret !== true) throw new Error("api-key prompt must be flagged secret");
		await manager.reply(prompt.flowId, { promptId: prompt.promptId, value: SECRET });
		const [payload] = await done;
		if (payload.ok !== false) throw new Error("expected failure");
		if (typeof payload.message !== "string" || payload.message.trim() === "") throw new Error("failure must carry a message");
		if (payload.message.length > 140) throw new Error("failure message must be short");
		if (/anthropic|openai|stack|error:|\bat \S+:\d+|FAKE|sk-/i.test(payload.message)) throw new Error(`failure message must be generic: ${payload.message}`);
		const surface = collectOutput(logLines) + JSON.stringify(payload);
		for (const marker of SECRET_MARKERS) {
			if (surface.includes(marker)) throw new Error(`secret marker leaked: ${marker}`);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("cancel aborts the flow, cleans up, and a new flow can start", async () => {
	const root = tempRoot();
	try {
		const manager = makeManager(root, { helperEnv: { FAKE_LOGIN_HANG: "1" } });
		const account = await manager.createAccount({ label: "slow", provider: "anthropic" });
		const done = once(manager, "auth_done");
		manager.startLogin({ accountId: account.accountId, method: "oauth" });
		await once(manager, "auth_prompt");
		await manager.cancel(manager.currentFlowId);
		const [payload] = await done;
		if (payload.ok !== false || payload.cancelled !== true) throw new Error(`expected clean cancel: ${JSON.stringify(payload)}`);
		if (manager.currentFlowId !== undefined) throw new Error("flow must be cleared after cancel");
		// A new flow starts immediately afterwards.
		const done2 = once(manager, "auth_done");
		manager.startLogin({ accountId: account.accountId, method: "oauth" });
		const [prompt2] = await once(manager, "auth_prompt");
		await manager.reply(prompt2.flowId, { promptId: prompt2.promptId, value: "code" });
		const [payload2] = await done2;
		if (!payload2.ok) throw new Error("second flow should succeed after cancel cleanup");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a second login while one is active is refused with auth_busy", async () => {
	const root = tempRoot();
	try {
		const manager = makeManager(root, { helperEnv: { FAKE_LOGIN_HANG: "1" } });
		const a = await manager.createAccount({ label: "one", provider: "anthropic" });
		const b = await manager.createAccount({ label: "two", provider: "openai" });
		manager.startLogin({ accountId: a.accountId, method: "oauth" });
		await once(manager, "auth_prompt");
		let message = "";
		try {
			await manager.startLogin({ accountId: b.accountId, method: "oauth" });
			throw new Error("second flow must be refused");
		} catch (error) {
			message = error.message;
		}
		if (!/busy|progress/i.test(message)) throw new Error(`unexpected refusal: ${message}`);
		await manager.cancel(manager.currentFlowId);
		await once(manager, "auth_done");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("unanswered prompts are bounded: the flow times out and cancels", async () => {
	const root = tempRoot();
	try {
		const manager = makeManager(root, { helperEnv: { FAKE_LOGIN_HANG: "1" }, promptTimeoutMs: 250 });
		const account = await manager.createAccount({ label: "slow", provider: "anthropic" });
		const done = once(manager, "auth_done");
		manager.startLogin({ accountId: account.accountId, method: "oauth" });
		const [payload] = await done;
		if (payload.ok !== false || payload.cancelled !== true) throw new Error(`expected timeout cancel: ${JSON.stringify(payload)}`);
		if (manager.currentFlowId !== undefined) throw new Error("flow must be cleared after timeout");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("mutations serialize: enroll and login never interleave", async () => {
	const root = tempRoot();
	try {
		const manager = makeManager(root, { helperEnv: { FAKE_LOGIN_HANG: "1" } });
		const a = await manager.createAccount({ label: "serial", provider: "openai" });
		const b = await manager.createAccount({ label: "serial2", provider: "anthropic" });
		manager.startLogin({ accountId: b.accountId, method: "oauth" }); // occupies the queue
		let busyRefused = false;
		try {
			await manager.enrollApiKey({ accountId: a.accountId, providerId: "openai", apiKey: SECRET });
			throw new Error("enroll must wait behind an active login flow");
		} catch (error) {
			busyRefused = /busy|progress/i.test(error.message);
			if (!busyRefused) throw error;
		}
		await manager.cancel(manager.currentFlowId);
		await once(manager, "auth_done");
		const dto = await manager.enrollApiKey({ accountId: a.accountId, providerId: "openai", apiKey: SECRET });
		if (!dto.configured) throw new Error("enroll after flow end should work");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("logout removes the credential and updates the public metadata", async () => {
	const root = tempRoot();
	try {
		const manager = makeManager(root);
		const account = await manager.createAccount({ label: "gone", provider: "openai" });
		await manager.enrollApiKey({ accountId: account.accountId, providerId: "openai", apiKey: SECRET });
		if (!manager.listAccounts().find((a) => a.accountId === account.accountId).configured) {
			throw new Error("metadata should say configured");
		}
		await manager.logout(account.accountId);
		const status = await manager.status(account.accountId);
		if (status.configured) throw new Error("credential should be gone");
		const dto = manager.listAccounts().find((a) => a.accountId === account.accountId);
		if (dto.configured) throw new Error("metadata should say unconfigured");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("account removal is refused while a profile references it, allowed otherwise", async () => {
	const root = tempRoot();
	try {
		const manager = makeManager(root, { inUse: (accountId) => accountId === "kept" });
		const kept = await manager.createAccount({ accountId: "kept", label: "kept", provider: "openai" });
		const free = await manager.createAccount({ label: "free", provider: "openai" });
		try {
			await manager.removeAccount(kept.accountId);
			throw new Error("referenced account removal must be refused");
		} catch (error) {
			if (!/in use|referenced|profile/i.test(error.message)) throw error;
		}
		if (!existsSync(path.join(root, "accounts", kept.accountId))) throw new Error("kept account must survive");
		await manager.removeAccount(free.accountId);
		if (existsSync(path.join(root, "accounts", free.accountId))) throw new Error("removed account must be gone");
		if (manager.listAccounts().some((a) => a.accountId === free.accountId)) throw new Error("removed account must leave the list");
		void kept;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

const REAL_SDK = "/home/dev/.local/lib/node_modules/@earendil-works/pi-coding-agent";

test("real sdk-helper.mjs against the installed SDK: offline catalog and credential status", { skip: !existsSync(path.join(REAL_SDK, "package.json")) }, async () => {
	const root = tempRoot();
	try {
		const accountsRoot = path.join(root, "island", "accounts");
		// Real helper (default seam), real SDK, island-clean env, no login, no provider network.
		const manager = new AccountManager({
			accountsRoot,
			sdkModule: REAL_SDK,
			env: { PATH: process.env.PATH, PI_OFFLINE: "1" },
			log: () => {},
		});
		const account = await manager.createAccount({ label: "smoke", provider: "anthropic" });
		const PROVIDER_KEYS = ["configured", "id", "methods", "name"];
		const MODEL_KEYS = ["contextWindow", "id", "input", "name", "provider", "reasoning"];
		const providers = await manager.providers();
		const ids = providers.map((p) => p.id);
		if (!ids.includes("anthropic") || !ids.includes("openai")) throw new Error(`builtin providers missing: ${ids}`);
		for (const provider of providers) {
			if (JSON.stringify(Object.keys(provider).sort()) !== JSON.stringify(PROVIDER_KEYS)) {
				throw new Error(`unexpected provider DTO keys: ${Object.keys(provider).sort()}`);
			}
			if (provider.configured !== false) throw new Error("fresh island must have no configured provider");
		}
		const models = await manager.models("anthropic", account.accountId);
		if (models.length === 0) throw new Error("expected catalog models for anthropic");
		for (const model of models) {
			if (JSON.stringify(Object.keys(model).sort()) !== JSON.stringify(MODEL_KEYS)) {
				throw new Error(`unexpected model DTO keys: ${Object.keys(model).sort()}`);
			}
			if (model.provider !== "anthropic") throw new Error("models must be filtered by provider");
		}
		const status = await manager.status(account.accountId);
		if (status.configured || status.authMethod !== "none") throw new Error("smoke account must be unconfigured");
		// Key names (not values: provider names legitimately contain words like "token").
		const forbidden = new Set(["baseUrl", "apiKey", "key", "headers", "cost", "token", "access", "refresh", "env"]);
		const walk = (value) => {
			if (Array.isArray(value)) return value.forEach(walk);
			if (value && typeof value === "object") {
				for (const [k, v] of Object.entries(value)) {
					if (forbidden.has(k)) throw new Error(`secret-adjacent field ${k} in real-helper DTOs`);
					walk(v);
				}
			}
		};
		walk([providers, models, status]);
		if (existsSync(path.join(accountsRoot, account.accountId, "auth.json")) && readFileSync(path.join(accountsRoot, account.accountId, "auth.json"), "utf8").trim() !== "{}") {
			throw new Error("no credential may be written by a read-only smoke");
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});


// ----- credential file permissions are re-asserted by the daemon -------------

test("enroll and logout re-assert 0600 auth.json and 0700 account dir after a loose helper write", async () => {
	const root = tempRoot();
	try {
		const manager = makeManager(root, { helperEnv: { FAKE_LOOSE_MODE: "1" } });
		const account = await manager.createAccount({ label: "loose", provider: "openai" });
		const dir = path.join(root, "accounts", account.accountId);
		const file = path.join(dir, "auth.json");
		if (WIN) {
			// HU-061: the fixture leaves a REAL Everyone:F DACL on the file and dir. The helper cannot tighten an existing entry, so the daemon
			// must REFUSE the account store (fail closed): not trust it, not rewrite it loosely, and the failure carries no secret.
			let refused = false;
			await manager.enrollApiKey({ accountId: account.accountId, providerId: "openai", apiKey: SECRET }).catch((error) => { refused = true; assert.doesNotMatch(String(error?.message), /sk-fake/); });
			if (!refused) throw new Error("a loose credential store (Everyone:F) must be refused on Windows");
			return;
		}
		await manager.enrollApiKey({ accountId: account.accountId, providerId: "openai", apiKey: SECRET });
		{
			if ((statSync(file).mode & 0o777) !== 0o600) throw new Error(`auth.json mode ${(statSync(file).mode & 0o777).toString(8)} after enroll`);
			if ((statSync(dir).mode & 0o777) !== 0o700) throw new Error(`account dir mode ${(statSync(dir).mode & 0o777).toString(8)} after enroll`);
			chmodSync(file, 0o644);
			chmodSync(dir, 0o755);
		}
		await manager.logout(account.accountId);
		if ((statSync(file).mode & 0o777) !== 0o600) throw new Error("auth.json not 0600 after logout");
		if ((statSync(dir).mode & 0o777) !== 0o700) throw new Error("account dir not 0700 after logout");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a symlinked account auth.json is refused and its target left untouched", async () => {
	const root = tempRoot();
	try {
		const manager = makeManager(root);
		const account = await manager.createAccount({ label: "link", provider: "openai" });
		const dir = path.join(root, "accounts", account.accountId);
		const victim = path.join(root, "victim.json");
		writeFileSync(victim, "{}\n", { mode: 0o644 });
		symlinkOrFail(victim, path.join(dir, "auth.json"));
		let refused = false;
		await manager.enrollApiKey({ accountId: account.accountId, providerId: "openai", apiKey: SECRET }).catch(() => (refused = true));
		if (!refused) throw new Error("symlinked auth.json must be refused");
		if (WIN) return; // the refusal is the assertion: the fake SDK child writes through the link before the daemon looks, so only the Unix mode is comparable
		if ((statSync(victim).mode & 0o777) !== 0o644) throw new Error("victim mode must not be touched through the link");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ----- real helper: device id anti-symlink ------------------------------------

function helperDeviceId(accountsRoot) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [path.join(__dirname, "..", "src", "sdk-helper.mjs"), "--accounts-root", accountsRoot], {
			env: { PATH: process.env.PATH },
			stdio: ["pipe", "pipe", "ignore"],
		});
		let out = "";
		child.stdout.on("data", (d) => {
			out += d;
			if (out.includes("\n")) {
				child.stdin.end();
				resolve(JSON.parse(out.split("\n")[0]));
			}
		});
		child.stdin.write(`${JSON.stringify({ id: 1, cmd: "device_id" })}\n`);
		setTimeout(() => child.kill(), 10_000).unref();
	});
}

test("device-id creation is 0600 and a symlinked device-id is refused with the victim intact", async () => {
	const root = tempRoot();
	try {
		const accountsRoot = path.join(root, "island", "accounts");
		mkdirSync(accountsRoot, { recursive: true, mode: 0o700 });
		const ok = await helperDeviceId(accountsRoot);
		if (!ok.ok) throw new Error("device id should be created");
		const file = path.join(accountsRoot, "device-id");
		if (WIN) assertPrivate(file);
		else if ((statSync(file).mode & 0o777) !== 0o600) throw new Error("device-id must be 0600");
		const again = await helperDeviceId(accountsRoot);
		if (!again.ok) throw new Error("existing device id should be reused");
		rmSync(file);
		const victim = path.join(root, "victim.txt");
		writeFileSync(victim, "VICTIM\n", { mode: 0o644 });
		symlinkOrFail(victim, file);
		const refused = await helperDeviceId(accountsRoot);
		if (refused.ok) throw new Error("symlinked device-id must be refused");
		if (readFileSync(victim, "utf8") !== "VICTIM\n" || (!WIN && (statSync(victim).mode & 0o777) !== 0o644)) throw new Error("victim modified");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ----- V5: local OpenAI-compatible accounts ----------------------------------------

const LOCAL_PLACEHOLDER = "abito-local-endpoint";
const modeOf = (file) => statSync(file).mode & 0o777;
/** 0600/0700 on Unix; on Windows privacy of the real DACL through the verified helper (HU-061). */
function assertPrivateMode(file, unixMode, kind = "file") {
	if (WIN) assertPrivate(file, kind);
	else assert.equal(modeOf(file), unixMode, file);
}
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

test("createLocalAccount writes exactly the designed 0600 files and a public-only DTO", async () => {
	const root = tempRoot();
	try {
		const manager = makeManager(root);
		const account = await manager.createLocalAccount({ label: "Ollama local", accountId: "ollama", baseUrl: "http://127.0.0.1:11434/v1", modelIds: ["qwen2.5-coder:7b", "llama3"] });
		assert.deepEqual(account, { accountId: "ollama", label: "Ollama local", provider: "local-ollama", authMethod: "api_key", configured: true, local: true });
		const dir = path.join(root, "accounts", "ollama");
		assert.deepEqual(readJson(path.join(dir, "models.json")), {
			providers: {
				"local-ollama": {
					baseUrl: "http://127.0.0.1:11434/v1",
					api: "openai-completions",
					apiKey: LOCAL_PLACEHOLDER,
					models: [{ id: "qwen2.5-coder:7b" }, { id: "llama3" }],
				},
			},
		});
		assert.deepEqual(readJson(path.join(dir, "auth.json")), { "local-ollama": { type: "api_key", key: LOCAL_PLACEHOLDER } });
		for (const f of ["models.json", "auth.json", "account.json"]) assertPrivateMode(path.join(dir, f), 0o600);
		assertPrivateMode(dir, 0o700, "dir");
		const meta = readJson(path.join(dir, "account.json"));
		assert.equal(meta.kind, "local");
		assert.equal(meta.configured, true);
		assert.equal(meta.authMethod, "api_key");
		assert.equal(JSON.stringify(meta).includes("11434"), false, "endpoint never in account.json");
		assert.deepEqual(manager.listAccounts(), [account]);
		assert.equal(JSON.stringify(await manager.status("ollama")).includes("11434"), false);
		assert.equal((await manager.status("ollama")).local, true);
		assert.equal(readJson(path.join(dir, "account.json")).kind, "local", "status keeps kind");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("createLocalAccount derives the id, refuses bad input, duplicates and over-long provider ids", async () => {
	const root = tempRoot();
	try {
		const manager = makeManager(root);
		const input = { label: "LM Studio", baseUrl: "http://localhost:1234/v1", modelIds: ["m"] };
		const a = await manager.createLocalAccount(input);
		assert.equal(a.accountId, "lm-studio");
		assert.equal(a.provider, "local-lm-studio");
		assert.equal((await manager.createLocalAccount(input)).accountId, "lm-studio-2");
		await assert.rejects(manager.createLocalAccount({ ...input, accountId: "lm-studio" }), /already exists/);
		await assert.rejects(manager.createLocalAccount({ ...input, accountId: "x".repeat(60) }), /Invalid account id/);
		await manager.createLocalAccount({ ...input, accountId: "x".repeat(58) }); // local- + 58 = 64
		for (const bad of [{ baseUrl: "https://evil.com/v1" }, { baseUrl: "http://10.0.0.5/v1" }, { modelIds: [] }, { label: " " }, { accountId: "../x" }]) {
			await assert.rejects(manager.createLocalAccount({ ...input, ...bad }));
		}
		assert.equal(manager.listAccounts().length, 3, "failed creations leave nothing behind");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("local accounts refuse enroll and login so the placeholder cannot be replaced", async () => {
	const root = tempRoot();
	try {
		const manager = makeManager(root);
		await manager.createLocalAccount({ label: "L", accountId: "ollama", baseUrl: "http://localhost:11434/v1", modelIds: ["m"] });
		await assert.rejects(manager.enrollApiKey({ accountId: "ollama", apiKey: SECRET }), /Request failed|local/i);
		await assert.rejects(manager.startLogin({ accountId: "ollama", method: "api_key" }), /Request failed|local/i);
		await assert.rejects(manager.startLogin({ accountId: "ollama", method: "oauth" }));
		assert.equal(manager.currentFlowId, undefined);
		assert.deepEqual(readJson(path.join(root, "accounts", "ollama", "auth.json")), { "local-ollama": { type: "api_key", key: LOCAL_PLACEHOLDER } });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("local account logout clears auth.json, keeps models.json; remove still works", async () => {
	const root = tempRoot();
	try {
		const manager = makeManager(root);
		await manager.createLocalAccount({ label: "L", accountId: "ollama", baseUrl: "http://localhost:11434/v1", modelIds: ["m"] });
		const out = await manager.logout("ollama");
		assert.equal(out.configured, false);
		assert.equal(out.local, true);
		const dir = path.join(root, "accounts", "ollama");
		assert.deepEqual(readJson(path.join(dir, "auth.json")), {});
		assert.equal(readJson(path.join(dir, "models.json")).providers["local-ollama"].baseUrl, "http://localhost:11434/v1");
		assert.equal(readJson(path.join(dir, "account.json")).kind, "local");
		await manager.removeAccount("ollama");
		assert.equal(existsSync(dir), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("setLocalEndpoint re-enables a logged-out local account with the fixed placeholder credential (0600)", async () => {
	const root = tempRoot();
	try {
		const manager = makeManager(root);
		await manager.createLocalAccount({ label: "L", accountId: "ollama", baseUrl: "http://localhost:11434/v1", modelIds: ["m"] });
		const cloud = await manager.createAccount({ label: "Cloud", provider: "anthropic", accountId: "cloud" });
		const out = await manager.logout("ollama");
		assert.equal(out.configured, false);
		const dir = path.join(root, "accounts", "ollama");
		assert.deepEqual(readJson(path.join(dir, "auth.json")), {});
		const dto = await manager.setLocalEndpoint({ accountId: "ollama", baseUrl: "http://127.0.0.1:1/v1", modelIds: ["x"], key: "sk-evil", apiKey: "sk-evil" });
		assert.equal(dto.configured, true);
		assert.deepEqual(readJson(path.join(dir, "auth.json")), { "local-ollama": { type: "api_key", key: LOCAL_PLACEHOLDER } });
		assertPrivateMode(path.join(dir, "auth.json"), 0o600);
		assert.equal(readJson(path.join(dir, "account.json")).configured, true);
		await assert.rejects(manager.setLocalEndpoint({ accountId: cloud.accountId, baseUrl: "http://localhost:1/v1", modelIds: ["m"] }), /not a local/i);
		assert.equal(existsSync(path.join(root, "accounts", "cloud", "models.json")), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("setLocalEndpoint rewrites only models.json of a LOCAL account; cloud and unknown are refused", async () => {
	const root = tempRoot();
	try {
		const manager = makeManager(root);
		await manager.createLocalAccount({ label: "L", accountId: "ollama", baseUrl: "http://localhost:11434/v1", modelIds: ["m"] });
		const cloud = await manager.createAccount({ label: "Cloud", provider: "anthropic", accountId: "cloud" });
		const dir = path.join(root, "accounts", "ollama");
		const authBefore = readFileSync(path.join(dir, "auth.json"), "utf8");
		const dto = await manager.setLocalEndpoint({ accountId: "ollama", baseUrl: "http://[::1]:8080/v1", modelIds: ["a", "b"] });
		assert.deepEqual(dto, { accountId: "ollama", label: "L", provider: "local-ollama", authMethod: "api_key", configured: true, local: true });
		const models = readJson(path.join(dir, "models.json"));
		assert.equal(models.providers["local-ollama"].baseUrl, "http://[::1]:8080/v1");
		assert.deepEqual(models.providers["local-ollama"].models, [{ id: "a" }, { id: "b" }]);
		assert.equal(models.providers["local-ollama"].apiKey, LOCAL_PLACEHOLDER);
		assertPrivateMode(path.join(dir, "models.json"), 0o600);
		assert.equal(readFileSync(path.join(dir, "auth.json"), "utf8"), authBefore);
		await assert.rejects(manager.setLocalEndpoint({ accountId: cloud.accountId, baseUrl: "http://localhost:1/v1", modelIds: ["m"] }), /not a local/i);
		assert.equal(existsSync(path.join(root, "accounts", "cloud", "models.json")), false);
		await assert.rejects(manager.setLocalEndpoint({ accountId: "ghost", baseUrl: "http://localhost:1/v1", modelIds: ["m"] }), /Unknown account/);
		await assert.rejects(manager.setLocalEndpoint({ accountId: "ollama", baseUrl: "http://10.0.0.5/v1", modelIds: ["m"] }));
		assert.equal(readJson(path.join(dir, "models.json")).providers["local-ollama"].baseUrl, "http://[::1]:8080/v1");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ----- S5 (abito-avisos-ux): the managed `pi` launcher layout -------------------------------------------------------------------
// `~/.pi/agent/bin/pi` is a POSIX launcher (not a symlink into the package): it reads `../install/current-version` and runs
// `../install/releases/<v>/node_modules/.bin/pi`. The helper must resolve the SDK from that layout, or every account command fails
// («command providers_list failed» at startup).
test("sdk-helper resolves the SDK through the managed pi launcher layout (bin/pi + install/current-version)", async () => {
	const root = tempRoot();
	try {
		const agent = path.join(root, "agent");
		const pkg = path.join(agent, "install", "releases", "9.9.9", "node_modules", "@earendil-works", "pi-coding-agent");
		mkdirSync(pkg, { recursive: true });
		writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module", main: "index.js" }));
		// a fake SDK: just enough for the `providers` command
		// a fake SDK with only what the `providers` command touches; its provider id proves THIS package was loaded
		writeFileSync(path.join(pkg, "index.js"), `export class ModelRuntime { static async create() { return new ModelRuntime(); }
  getProviders() { return [{ id: "managed-layout-sdk", name: "Managed", auth: { apiKey: { login() {} } } }]; }
  getProviderAuthStatus() { return { configured: false }; } }`);
		mkdirSync(path.join(agent, "bin"), { recursive: true });
		writeFileSync(path.join(agent, "install", "current-version"), "9.9.9\n");
		writeFileSync(path.join(agent, "bin", "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		const accountsRoot = path.join(root, "island", "accounts");
		mkdirSync(accountsRoot, { recursive: true });
		const child = spawn(process.execPath, [path.join(__dirname, "..", "src", "sdk-helper.mjs"), "--accounts-root", accountsRoot], {
			env: { PATH: [path.join(agent, "bin"), ...(process.platform === "win32" ? [] : ["/usr/bin", "/bin"])].join(path.delimiter), HOME: root, USERPROFILE: root, PI_OFFLINE: "1" },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let out = "", err = "";
		child.stderr.on("data", (d) => { err += d; });
		const first = new Promise((resolve) => child.stdout.on("data", (d) => { out += d; if (out.includes("\n")) resolve(JSON.parse(out.split("\n")[0])); }));
		child.stdin.write(`${JSON.stringify({ id: 1, cmd: "providers" })}\n`);
		const timer = setTimeout(() => child.kill(), 15_000); timer.unref();
		const result = await first;
		child.kill();
		assert.equal(result.ok, true, `${JSON.stringify(result)} ${err}`);
		assert.deepEqual(result.providers.map((p) => p.id), ["managed-layout-sdk"], "the SDK of install/current-version was loaded");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// HU-062 (found on Windows CI, custom-provider 58-63): the helper looked for `pi` on PATH splitting by ":" and only for a file named `pi`, so on
// Windows (PATH uses ";", the npm shims are pi.cmd/pi.ps1, and the package sits at <prefix>\node_modules\@earendil-works\pi-coding-agent next to them)
// it never found the globally installed SDK and every account command failed with «Request failed». npm's global layout (shim next to node_modules) is
// resolved on every OS.
test("sdk-helper resolves the SDK from an npm global layout (shim next to node_modules) found through the platform PATH separator", async () => {
	const root = tempRoot();
	try {
		const prefix = path.join(root, "prefix");
		const pkg = path.join(prefix, "node_modules", "@earendil-works", "pi-coding-agent");
		mkdirSync(pkg, { recursive: true });
		writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module", main: "index.js" }));
		writeFileSync(path.join(pkg, "index.js"), `export class ModelRuntime { static async create() { return new ModelRuntime(); }
  getProviders() { return [{ id: "npm-global-sdk", name: "Global", auth: { apiKey: { login() {} } } }]; }
  getProviderAuthStatus() { return { configured: false }; } }`);
		writeFileSync(path.join(prefix, process.platform === "win32" ? "pi.cmd" : "pi"), "@echo off\r\n", { mode: 0o755 });
		const accountsRoot = path.join(root, "island", "accounts");
		mkdirSync(accountsRoot, { recursive: true });
		const child = spawn(process.execPath, [path.join(__dirname, "..", "src", "sdk-helper.mjs"), "--accounts-root", accountsRoot], {
			env: { PATH: [prefix, ...(process.platform === "win32" ? [] : ["/usr/bin", "/bin"])].join(path.delimiter), HOME: root, USERPROFILE: root, PI_OFFLINE: "1" },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let out = "", err = "";
		child.stderr.on("data", (d) => { err += d; });
		const first = new Promise((resolve) => child.stdout.on("data", (d) => { out += d; if (out.includes("\n")) resolve(JSON.parse(out.split("\n")[0])); }));
		child.stdin.write(`${JSON.stringify({ id: 1, cmd: "providers" })}\n`);
		const timer = setTimeout(() => child.kill(), 15_000); timer.unref();
		const result = await first;
		child.kill();
		assert.equal(result.ok, true, `${JSON.stringify(result)} ${err}`);
		assert.deepEqual(result.providers.map((p) => p.id), ["npm-global-sdk"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
