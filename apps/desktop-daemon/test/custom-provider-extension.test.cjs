"use strict";

// HU-041 / T6a-2: the guarded Pi transport for custom (LiteLLM / OpenAI-compatible) providers.
// Loopback fixture gateways only (literal 127.0.0.1, ephemeral ports); neutral names (gateway.example,
// model-a). The extension is exercised (a) as a unit through the exact template Pi loads and (b) for
// real: installed `pi --mode rpc` in an isolated agent dir, activated through ProfileStore.

const http = require("node:http");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");

const { PROVIDER_ID, TEMPLATE, EXTENSION_FILE, RUNTIME_FILE, runtimeDocument } = require("../src/custom-provider-extension.cjs");
const { ProfileStore } = require("../src/profiles.cjs");
const { AccountManager, helperEnv } = require("../src/auth.cjs");
const { discoverModels } = require("../src/custom-provider.cjs");

const SECRET = "sk-fake-SECRET-2468-DO-NOT-LEAK";
const FIXTURE = path.join(__dirname, "fixtures", "fake-auth.cjs");
const tempRoot = () => mkdtempSync(path.join(require("node:fs").realpathSync.native(os.tmpdir()), "abito-custom-ext-"));

/**
 * Loopback fixture gateway. `hits` are requests that belong to the test; `strays` are unrelated local
 * Go clients that probe ephemeral loopback ports on this host (User-Agent `Go-http-client/*`, never
 * carrying a bearer key). B4 finding: those probes, not a retry in the guarded transport, were the
 * "extra gateway requests". They are recorded separately and asserted harmless, never silently dropped.
 */
const FOREIGN_PROBE = /^Go-http-client\//;
function listen(handler) {
	const hits = [];
	const strays = [];
	const server = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const hit = { method: req.method, url: req.url, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString("utf8"), agent: req.headers["user-agent"], from: req.socket.remotePort };
			if (FOREIGN_PROBE.test(hit.agent ?? "") && hit.authorization === undefined && hit.body === "") {
				strays.push(hit);
				res.writeHead(404);
				return res.end();
			}
			hits.push(hit);
			handler(req, res, hit);
		});
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, hits, strays, base: `http://127.0.0.1:${server.address().port}/v1` })));
}
/** Diagnostic: method/path only (never headers or bodies), so a count failure explains itself. */
const describeHits = (hits) => JSON.stringify(hits.map((h) => `${h.method} ${h.url} ua=${String(h.agent).slice(0, 40)} from=${h.from}`));
const close = (s) => new Promise((resolve) => { s.closeAllConnections?.(); s.close(resolve); });
const sse = (res, chunks) => {
	res.writeHead(200, { "content-type": "text/event-stream" });
	for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
	res.end("data: [DONE]\n\n");
};
const completion = (delta, finish = null) => ({ id: "c1", object: "chat.completion.chunk", created: 1, model: "model-a", choices: [{ index: 0, delta, finish_reason: finish }] });
const okStream = (res) =>
	sse(res, [completion({ role: "assistant", content: "pong" }), completion({}, "stop"), { id: "c1", object: "chat.completion.chunk", created: 1, model: "model-a", choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }]);

// ----- template: fixed code, runtime data only ----------------------------------------------

test("template is fixed: user data never appears in executable source; runtime data is validated", () => {
	assert.equal(/\$\{|`/.test(TEMPLATE), false, "no interpolation points in the template");
	for (const hostile of ["https://gateway.example/v1", SECRET, "model-a", "custom-x"]) assert.equal(TEMPLATE.includes(hostile), false, hostile);
	const entry = { baseUrl: "https://gateway.example/v1/", models: [{ id: "model-a" }] };
	assert.deepEqual(runtimeDocument("custom-x", entry), { version: 1, provider: "custom-x", baseUrl: "https://gateway.example/v1", models: ["model-a"] });
	for (const bad of [
		{ baseUrl: "http://gateway.example/v1", models: [{ id: "model-a" }] },
		{ baseUrl: "https://u:p@gateway.example/v1", models: [{ id: "model-a" }] },
		{ baseUrl: "https://gateway.example/v1?x=1", models: [{ id: "model-a" }] },
		{ baseUrl: "https://gateway.example/v1", models: [] },
		{ baseUrl: "https://gateway.example/v1", models: [{ id: "a" }, { id: "a" }] },
		{ baseUrl: "https://gateway.example/v1", models: [{ id: "bad\u0007" }] },
		undefined,
	]) assert.equal(runtimeDocument("custom-x", bad), undefined, JSON.stringify(bad));
});

async function loadTemplate(root) {
	const file = path.join(root, "template.mjs");
	writeFileSync(file, TEMPLATE);
	return import(`${pathToFileURL(file).href}?${Math.random()}`);
}

test("template parseRuntime re-validates the runtime file (never trusts it)", async (t) => {
	const root = tempRoot();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const ext = await loadTemplate(root);
	const good = { version: 1, provider: "custom-x", baseUrl: "https://gateway.example/v1", models: ["model-a"] };
	assert.equal(ext.parseRuntime(JSON.stringify(good)).base.href, "https://gateway.example/v1");
	for (const bad of [
		{ ...good, baseUrl: "http://gateway.example/v1" },
		{ ...good, baseUrl: "https://u@gateway.example/v1" },
		{ ...good, baseUrl: "https://gateway.example/v1#f" },
		{ ...good, baseUrl: "http://localhost:4000/v1" },
		{ ...good, provider: "anthropic" },
		{ ...good, version: 2 },
		{ ...good, models: [] },
		{ ...good, models: ["a", "a"] },
	]) assert.equal(ext.parseRuntime(JSON.stringify(bad)), undefined, JSON.stringify(bad));
	assert.equal(ext.parseRuntime("not json"), undefined);
});

test("guarded fetch: pins origin/path/method; refuses before sending", async (t) => {
	const root = tempRoot();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const ext = await loadTemplate(root);
	const gw = await listen((req, res) => okStream(res));
	const other = await listen((req, res) => okStream(res));
	t.after(() => Promise.all([close(gw.server), close(other.server)]));
	const base = ext.normalizeBaseUrl(gw.base);
	const state = {};
	const guarded = ext.createGuardedFetch(base, state);
	for (const target of [`${other.base}/chat/completions`, `${gw.base}/chat/completions?x=1`, `${gw.base}/other`, `http://user:pw@127.0.0.1:${new URL(gw.base).port}/v1/chat/completions`, "http://[::1]:1/v1/chat/completions"]) {
		await assert.rejects(guarded(target, { method: "POST", body: "{}" }), /refused \(destination\)/);
	}
	await assert.rejects(guarded(`${gw.base}/chat/completions`, { method: "DELETE" }), /refused \(destination\)/);
	assert.equal(gw.hits.length + other.hits.length, 0, "nothing was sent for refused targets");
	const ok = await guarded(`${gw.base}/chat/completions`, { method: "POST", body: "{}", headers: { authorization: `Bearer ${SECRET}` } });
	assert.equal(ok.status, 200);
	assert.match(await ok.text(), /pong/);
	assert.equal(gw.hits.length, 1);
});

test("guarded fetch: a Request object input is refused before any side effect (its method/headers/body are never forwarded unchecked)", async (t) => {
	const root = tempRoot();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const ext = await loadTemplate(root);
	const gw = await listen((req, res) => okStream(res));
	t.after(() => close(gw.server));
	const guarded = ext.createGuardedFetch(ext.normalizeBaseUrl(gw.base), {});
	// init says GET (allowed for /models) but the Request would send POST: the check and the send must not disagree.
	const request = new Request(`${gw.base}/models`, { method: "POST", body: "{}" });
	await assert.rejects(guarded(request, { method: "GET" }), /refused \(request\)/);
	await assert.rejects(guarded(new Request(`${gw.base}/chat/completions`, { method: "POST", body: "{}" })), /refused \(request\)/);
	await assert.rejects(guarded({ url: `${gw.base}/models` }), /refused \(request\)/);
	assert.equal(gw.hits.length, 0, "zero gateway hits for refused input");
	// String and URL inputs (what the SDK passes) still work and are checked against the method that is sent.
	for (const response of [await guarded(`${gw.base}/models`, { method: "GET" }), await guarded(new URL(`${gw.base}/models`))]) {
		assert.equal(response.status, 200);
		await response.text(); // consume: an unread body would keep the idle timer (and socket) alive
	}
	assert.deepEqual(gw.hits.map((h) => h.method), ["GET", "GET"]);
});

test("fixture: foreign Go probes on a loopback port are recorded as strays, never counted as gateway hits; real requests always are", async (t) => {
	const gw = await listen((req, res) => okStream(res));
	t.after(() => close(gw.server));
	const url = `${gw.base}/models`;
	const probe = await fetch(url, { headers: { "user-agent": "Go-http-client/1.1" } });
	assert.equal(probe.status, 404);
	await fetch(url, { headers: { "user-agent": "Go-http-client/1.1", authorization: "Bearer x" } });
	await fetch(url, { method: "POST", body: "{}", headers: { "user-agent": "Go-http-client/1.1" } });
	await fetch(url, { headers: { "user-agent": "pi/1.4.0" } });
	assert.equal(gw.strays.length, 1);
	assert.deepEqual(gw.hits.map((h) => h.agent), ["Go-http-client/1.1", "Go-http-client/1.1", "pi/1.4.0"], "anything carrying a key/body or a non-probe agent still counts");
});

test("template limits are the approved named constants (300 s header, 300 s idle, 64 MiB) and the README documents the same numbers", async (t) => {
	const root = tempRoot();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const ext = await loadTemplate(root);
	assert.deepEqual({ ...ext.LIMITS }, { headersMs: 300_000, idleMs: 300_000, maxBytes: 64 * 1024 * 1024, maxModels: 128, maxIdChars: 200 });
	assert.equal((TEMPLATE.match(/300000/g) ?? []).length, 2, "each transport bound is defined once, in LIMITS");
	const readme = readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
	for (const documented of ["300 s", "64 MiB", "10 s", "256 KiB"]) assert.ok(readme.includes(documented), `README documents ${documented}`);
});

test("guarded fetch: 301/302/307/308 cross-origin send nothing to the destination; same-origin redirects are refused too", async (t) => {
	const root = tempRoot();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const ext = await loadTemplate(root);
	const dest = await listen((req, res) => okStream(res));
	t.after(() => close(dest.server));
	for (const status of [301, 302, 307, 308]) {
		const gw = await listen((req, res) => { res.writeHead(status, { location: `${dest.base}/chat/completions` }); res.end(); });
		const state = {};
		const response = await ext.createGuardedFetch(ext.normalizeBaseUrl(gw.base), state)(`${gw.base}/chat/completions`, { method: "POST", body: JSON.stringify({ k: SECRET }), headers: { authorization: `Bearer ${SECRET}` } });
		assert.equal(response.status, 400, "the 3xx is replaced by a fixed refusal");
		assert.equal(state.reason, "redirect");
		assert.equal((await response.text()).includes(SECRET), false);
		assert.equal(gw.hits.length, 1);
		await close(gw.server);
	}
	assert.equal(dest.hits.length, 0, "destination hit count 0");
	assert.equal(dest.hits.reduce((n, h) => n + h.body.length, 0), 0, "destination body bytes 0");
	for (const status of [301, 302, 307, 308]) {
		const same = await listen((req, res) => { res.writeHead(status, { location: "/v1/chat/completions" }); res.end(); });
		const state = {};
		const response = await ext.createGuardedFetch(ext.normalizeBaseUrl(same.base), state)(`${same.base}/chat/completions`, { method: "POST", body: "{}" });
		assert.equal(response.status, 400);
		assert.equal(state.reason, "redirect");
		assert.equal(same.hits.length, 1, "a same-origin redirect is not followed");
		await close(same.server);
	}
});

test("guarded fetch bounds time and bytes", async (t) => {
	const root = tempRoot();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const ext = await loadTemplate(root);
	const limits = { ...ext.LIMITS, headersMs: 200, idleMs: 200, maxBytes: 1000 };
	const hang = await listen(() => {});
	const big = await listen((req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.write("x".repeat(600)); setTimeout(() => res.end("y".repeat(600)), 20); });
	const declared = await listen((req, res) => { res.writeHead(200, { "content-length": "5000" }); res.end("z".repeat(5000)); });
	const stall = await listen((req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.write("a"); });
	t.after(() => Promise.all([hang, big, declared, stall].map((g) => close(g.server))));
	const call = (gw, state) => ext.createGuardedFetch(ext.normalizeBaseUrl(gw.base), state, limits)(`${gw.base}/chat/completions`, { method: "POST", body: "{}" });
	let state = {};
	await assert.rejects(call(hang, state), /refused \(timeout\)/);
	state = {};
	await assert.rejects(async () => { const r = await call(big, state); await r.text(); }, /too_large/);
	state = {};
	await assert.rejects(call(declared, state), /refused \(too_large\)/);
	state = {};
	await assert.rejects(async () => { const r = await call(stall, state); await r.text(); }, /timeout/);
});

// ----- journal-safe activation through ProfileStore -------------------------------------------

function engineStub({ failSetModel = false } = {}) {
	const calls = { requests: [], stops: 0, starts: 0 };
	return {
		calls, status: "ready", busy: false,
		async request(c) { calls.requests.push(c); if (c.type === "set_model" && failSetModel) throw new Error("FAKE-INTERNAL"); return { success: true }; },
		async stop() { calls.stops += 1; },
		async start() { calls.starts += 1; },
	};
}

function setupCustom(root, { baseUrl = "https://gateway.example/v1", models = ["model-a"], engine = engineStub() } = {}) {
	const island = path.join(root, "island");
	const accountsRoot = path.join(island, "accounts");
	const agentDir = path.join(island, "agent");
	for (const id of ["gw", "cloud"]) mkdirSync(path.join(accountsRoot, id), { recursive: true, mode: 0o700 });
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	writeFileSync(path.join(accountsRoot, "gw", "auth.json"), JSON.stringify({ "custom-gw": { type: "api_key", key: SECRET } }), { mode: 0o600 });
	writeFileSync(path.join(accountsRoot, "gw", "models.json"), JSON.stringify({ providers: { "custom-gw": { name: "Custom gateway", baseUrl, api: "openai-completions", models: models.map((id) => ({ id })) } } }), { mode: 0o600 });
	writeFileSync(path.join(accountsRoot, "cloud", "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "cloud-key" } }), { mode: 0o600 });
	const accounts = new Map([
		["gw", { accountId: "gw", provider: "custom-gw", configured: true, custom: true }],
		["cloud", { accountId: "cloud", provider: "anthropic", configured: true }],
	]);
	const store = new ProfileStore({ islandRoot: island, agentDir, accounts: () => accounts, engine, restart: async () => {} });
	return { store, island, agentDir, engine, accounts };
}
const GW = { id: "gw1", label: "G", role: "main", accountId: "gw", provider: "custom-gw", modelId: "model-a", thinkingLevel: "off" };
const CLOUD = { id: "c1", label: "C", role: "other", accountId: "cloud", provider: "anthropic", modelId: "claude-sonnet-5", thinkingLevel: "off" };

test("activation installs the fixed extension + validated runtime data; models.json never routes the custom provider unguarded", async (t) => {
	const root = tempRoot();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const { store, agentDir } = setupCustom(root);
	await store.save(GW);
	await store.select("gw1");
	assert.equal(readFileSync(path.join(agentDir, "extensions", EXTENSION_FILE), "utf8"), TEMPLATE, "byte-identical fixed template");
	const runtime = JSON.parse(readFileSync(path.join(agentDir, RUNTIME_FILE), "utf8"));
	assert.deepEqual(runtime, { version: 1, provider: "custom-gw", baseUrl: "https://gateway.example/v1", models: ["model-a"] });
	assert.deepEqual(JSON.parse(readFileSync(path.join(agentDir, "models.json"), "utf8")), { providers: {} });
	assert.equal(JSON.parse(readFileSync(path.join(agentDir, "auth.json"), "utf8"))["custom-gw"].key, SECRET);
	assert.equal(readFileSync(path.join(agentDir, RUNTIME_FILE), "utf8").includes(SECRET), false, "no key in the runtime data");
	assert.equal(TEMPLATE.includes(SECRET), false);
	if (process.platform !== "win32") for (const f of [path.join(agentDir, "extensions", EXTENSION_FILE), path.join(agentDir, RUNTIME_FILE)]) assert.equal(statSync(f).mode & 0o777, 0o600);
	assert.equal(JSON.stringify(store.list()).includes("gateway.example"), false);
	// Switching to an existing provider removes the extension; deactivation removes it too.
	await store.save(CLOUD);
	await store.select("c1");
	assert.equal(existsSync(path.join(agentDir, "extensions", EXTENSION_FILE)), false);
	assert.equal(existsSync(path.join(agentDir, RUNTIME_FILE)), false);
	await store.select("gw1");
	assert.ok(existsSync(path.join(agentDir, RUNTIME_FILE)));
	await store.deactivate();
	assert.equal(existsSync(path.join(agentDir, "extensions", EXTENSION_FILE)), false);
	assert.equal(existsSync(path.join(agentDir, RUNTIME_FILE)), false);
	assert.equal(existsSync(path.join(agentDir, "auth.json")), false);
});

test("activation rejects unusable custom accounts without touching any agent file", async (t) => {
	for (const [name, opts, profile, pattern] of [
		["no discovered models", { models: [] }, GW, /no discovered models/],
		["unknown model", {}, { ...GW, modelId: "model-z" }, /does not offer that model/],
		["unsafe stored URL", { baseUrl: "http://gateway.example/v1" }, GW, /no discovered models/],
	]) {
		const root = tempRoot();
		try {
			const { store, agentDir, engine } = setupCustom(root, opts);
			await store.save(profile);
			await assert.rejects(store.select(profile.id), pattern, name);
			assert.deepEqual(readdirSync(agentDir), [], name);
			assert.equal(engine.calls.starts + engine.calls.stops, 0, name);
			assert.equal(store.list().active, undefined);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

test("journal rollback restores a previous custom install exactly when a later step fails", async (t) => {
	const root = tempRoot();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const engine = engineStub();
	const { store, agentDir, accounts, island } = setupCustom(root, { engine });
	await store.save(GW);
	await store.save(CLOUD);
	await store.select("gw1");
	const snapshot = Object.fromEntries(["auth.json", "models.json", "settings.json", RUNTIME_FILE, path.join("extensions", EXTENSION_FILE)].map((f) => [f, readFileSync(path.join(agentDir, f), "utf8")]));
	const marker = readFileSync(path.join(island, "active-account.json"), "utf8");
	engine.request = async (c) => { if (c.type === "set_model") throw new Error("FAKE-INTERNAL"); return { success: true }; };
	await assert.rejects(store.select("c1"), /Could not activate/);
	for (const [f, text] of Object.entries(snapshot)) assert.equal(readFileSync(path.join(agentDir, f), "utf8"), text, `${f} restored byte for byte`);
	assert.equal(readFileSync(path.join(island, "active-account.json"), "utf8"), marker);
	assert.equal(existsSync(path.join(agentDir, ".switch.json")), false, "journal settled");
	// And a failed FIRST custom activation leaves no extension behind.
	const root2 = tempRoot();
	try {
		const second = setupCustom(root2, { engine: engineStub({ failSetModel: true }) });
		await second.store.save(GW);
		await assert.rejects(second.store.select("gw1"), /Could not activate/);
		assert.equal(existsSync(path.join(second.agentDir, "extensions", EXTENSION_FILE)), false);
		assert.equal(existsSync(path.join(second.agentDir, RUNTIME_FILE)), false);
		assert.equal(existsSync(path.join(second.agentDir, "auth.json")), false);
	} finally {
		rmSync(root2, { recursive: true, force: true });
	}
	void accounts;
});

test("existing providers: activation projects exactly auth/models/settings, no extension files", async (t) => {
	const root = tempRoot();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const { store, agentDir } = setupCustom(root);
	await store.save(CLOUD);
	await store.select("c1");
	assert.deepEqual(readdirSync(agentDir).sort(), ["auth.json", "models.json", "settings.json"]);
	assert.equal(readFileSync(path.join(agentDir, "models.json"), "utf8"), `${JSON.stringify({ providers: {} })}\n`);
});

// ----- B3: process-crash recovery is fail-closed for custom artifacts -------------------------

const CRASH_CHILD = String.raw`
const fs = require("node:fs"), path = require("node:path");
const [root, action, profileId, crashAt] = process.argv.slice(1);
const SRC = path.join(process.cwd(), "src");
const iso = require(path.join(SRC, "isolation.cjs"));
const realWrite = iso.writePrivateFile;
const die = () => { process.stderr.write("CRASHED\n"); process.exit(137); };
if (crashAt && crashAt.startsWith("write:")) iso.writePrivateFile = (target, ...rest) => { if (path.basename(String(target)) === crashAt.slice(6)) die(); return realWrite(target, ...rest); };
if (crashAt && crashAt.startsWith("unlink:")) { const realUnlink = fs.unlinkSync; fs.unlinkSync = (target, ...rest) => { if (String(target).endsWith(crashAt.slice(7))) die(); return realUnlink(target, ...rest); }; }
const { ProfileStore } = require(path.join(SRC, "profiles.cjs"));
const SECRET = process.env.SECRET;
const island = path.join(root, "island");
const accounts = new Map([["gw", { accountId: "gw", provider: "custom-gw", configured: true, custom: true }], ["cloud", { accountId: "cloud", provider: "anthropic", configured: true }]]);
const engine = { status: "ready", busy: false, async request() { return { success: true }; }, async stop() {}, async start() {} };
const store = new ProfileStore({ islandRoot: island, agentDir: path.join(island, "agent"), accounts: () => accounts, engine, restart: async () => {} });
if (crashAt === "before-restart") store.restartAndSwitch = async () => die();
if (crashAt === "after-restart") engine.request = async (c) => (c.type === "set_model" ? die() : { success: true });
if (crashAt === "after-state") { const persist = store.persist.bind(store); store.persist = (state) => { persist(state); store.clearJournal = () => die(); }; }
if (crashAt === "marker") { const orig = store.writeMarker.bind(store); store.writeMarker = (file, content) => { if (content !== null) die(); return orig(file, content); }; }
(async () => { if (action === "select") await store.select(profileId); else await store.deactivate(); process.stderr.write("NO_CRASH\n"); })().catch((e) => { process.stderr.write("ERR " + e.message + "\n"); process.exit(3); });
`;

function crashRun(root, action, profileId, crashAt) {
	const out = require("node:child_process").spawnSync(process.execPath, ["-e", CRASH_CHILD, root, action, profileId ?? "", crashAt ?? ""], { cwd: path.join(__dirname, ".."), encoding: "utf8", env: { PATH: process.env.PATH, SECRET } });
	assert.equal(out.status, 137, `child must crash: ${out.stderr}`);
}
const tree = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).filter((f) => !f.endsWith(".lock")).sort() : []);

for (const [name, from, crashAt] of [
	["at the marker write, fresh", undefined, "marker"],
	["at the marker write, from a cloud profile", "c1", "marker"],
	["mid-install (after the credential, before the runtime data)", undefined, "write:custom-provider.json"],
	["mid-install (after the runtime data, before the extension)", "c1", "write:abito-custom-provider.js"],
]) {
	test(`crash ${name}: after restart nothing custom stays usable and no profile is active`, async (t) => {
		const root = tempRoot();
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const { store, agentDir, island } = setupCustom(root);
		await store.save(GW);
		await store.save(CLOUD);
		if (from) await store.select(from);
		crashRun(root, "select", "gw1", crashAt);
		// A restart builds a fresh store: recovery runs at construction (no extra call needed).
		const restarted = setupCustom(root).store;
		assert.equal(restarted.list().active, undefined);
		assert.equal(existsSync(path.join(agentDir, "extensions", EXTENSION_FILE)), false, "extension removed");
		assert.equal(existsSync(path.join(agentDir, RUNTIME_FILE)), false, "runtime data removed");
		const auth = existsSync(path.join(agentDir, "auth.json")) ? readFileSync(path.join(agentDir, "auth.json"), "utf8") : "";
		assert.equal(auth.includes("custom-gw") || auth.includes(SECRET), false, "the custom credential is not left usable in the agent dir");
		const settings = existsSync(path.join(agentDir, "settings.json")) ? JSON.parse(readFileSync(path.join(agentDir, "settings.json"), "utf8")) : {};
		assert.equal(settings.defaultProvider === "custom-gw", false);
		assert.equal(existsSync(path.join(island, "active-account.json")), false);
		assert.equal(existsSync(path.join(agentDir, ".switch.json")), false, "journal settled");
		// The account's own private store is untouched, and the profile can be activated again normally.
		assert.equal(JSON.parse(readFileSync(path.join(island, "accounts", "gw", "auth.json"), "utf8"))["custom-gw"].key, SECRET);
		// The dead process left its credential lock behind; the store breaks it once stale (30 s), so age it.
		const lock = path.join(agentDir, "auth.json.lock");
		if (existsSync(lock)) fs.utimesSync(lock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
		await restarted.select("gw1");
		assert.ok(existsSync(path.join(agentDir, "extensions", EXTENSION_FILE)));
	});
}

// Windows of the activation transaction (journal -> apply -> restart -> save state -> clear journal):
// whatever the crash point, the end state after a restart is fully inactive with no custom remnants.
const RESIDUE = (agentDir) => {
	const auth = existsSync(path.join(agentDir, "auth.json")) ? readFileSync(path.join(agentDir, "auth.json"), "utf8") : "";
	const settings = existsSync(path.join(agentDir, "settings.json")) ? readFileSync(path.join(agentDir, "settings.json"), "utf8") : "";
	return {
		extension: existsSync(path.join(agentDir, "extensions", EXTENSION_FILE)),
		runtime: existsSync(path.join(agentDir, RUNTIME_FILE)),
		key: auth.includes("custom-gw") || auth.includes(SECRET) || settings.includes("custom-gw"),
	};
};
const NO_RESIDUE = { extension: false, runtime: false, key: false };
const ageLock = (agentDir) => {
	const lock = path.join(agentDir, "auth.json.lock");
	if (existsSync(lock)) fs.utimesSync(lock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
};

for (const [window, crashAt] of [["before the engine restart", "before-restart"], ["after the restart, before the state is saved", "after-restart"], ["after the state is saved, before the journal is cleared", "after-state"]]) {
	for (const from of [undefined, "c1"]) {
		test(`activation crash ${window}${from ? " (from a cloud profile)" : ""}: restart recovery leaves the custom profile fully inactive`, async (t) => {
			const root = tempRoot();
			t.after(() => rmSync(root, { recursive: true, force: true }));
			const { store, agentDir, island } = setupCustom(root);
			await store.save(GW);
			await store.save(CLOUD);
			if (from) await store.select(from);
			crashRun(root, "select", "gw1", crashAt);
			const restarted = setupCustom(root).store;
			assert.equal(restarted.list().active, undefined, "no stale active profile");
			assert.deepEqual(RESIDUE(agentDir), NO_RESIDUE);
			assert.equal(existsSync(path.join(island, "active-account.json")), false);
			assert.equal(existsSync(path.join(agentDir, ".switch.json")), false);
			assert.equal(JSON.parse(readFileSync(path.join(island, "accounts", "gw", "auth.json"), "utf8"))["custom-gw"].key, SECRET, "the account's own store is untouched");
			ageLock(agentDir);
			await restarted.select("gw1"); // and the profile still activates normally afterwards
			assert.equal(restarted.list().active, "gw1");
			assert.deepEqual(RESIDUE(agentDir), { extension: true, runtime: true, key: true });
		});
	}
}

test("recovery that keeps a surviving custom account keeps custom:true on the marker, so the next crash still tears the artifacts down", async (t) => {
	const root = tempRoot();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const { store, agentDir, island } = setupCustom(root);
	await store.save(GW);
	await store.save(CLOUD);
	await store.select("gw1");
	crashRun(root, "select", "c1", "write:auth.json"); // dies before the credential of c1 replaces gw's
	const restarted = setupCustom(root).store;
	assert.equal(JSON.parse(readFileSync(path.join(island, "active-account.json"), "utf8")).custom, true, "custom flag survives the marker rewrite");
	assert.equal(restarted.list().active, "gw1");
	assert.deepEqual(RESIDUE(agentDir), { extension: true, runtime: true, key: true }, "the unchanged custom activation is kept");
	ageLock(agentDir);
	crashRun(root, "select", "c1", "before-restart"); // next cycle: crash again after c1 was applied
	const again = setupCustom(root).store;
	assert.equal(again.list().active, undefined);
	assert.deepEqual(RESIDUE(agentDir), NO_RESIDUE, "no custom remnants after the second recovery");
	// The cloud credential was fully applied, so the marker names it (without any custom flag); no profile is active.
	assert.deepEqual(JSON.parse(readFileSync(path.join(island, "active-account.json"), "utf8")), { accountId: "cloud", provider: "anthropic" });
});

test("orphaned custom artifacts with no journal and no active profile are removed; unrelated credentials and user extensions stay; deactivate reports it", async (t) => {
	const root = tempRoot();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const { store, agentDir, island } = setupCustom(root);
	await store.save(GW);
	await store.select("gw1");
	// The state a crash used to leave: files in place, journal gone, no active profile.
	const profilesFile = path.join(island, "profiles.json");
	const doc = JSON.parse(readFileSync(profilesFile, "utf8"));
	delete doc.active;
	writeFileSync(profilesFile, JSON.stringify(doc));
	const auth = JSON.parse(readFileSync(path.join(agentDir, "auth.json"), "utf8"));
	auth.anthropic = { type: "api_key", key: "unrelated-key" };
	writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify(auth), { mode: 0o600 });
	writeFileSync(path.join(agentDir, "extensions", "user-ext.js"), "// user extension\n");
	assert.equal(existsSync(path.join(agentDir, ".switch.json")), false);
	const restarted = setupCustom(root).store; // recovery at startup
	assert.deepEqual(RESIDUE(agentDir), NO_RESIDUE);
	assert.equal(JSON.parse(readFileSync(path.join(agentDir, "auth.json"), "utf8")).anthropic.key, "unrelated-key");
	assert.equal(readFileSync(path.join(agentDir, "extensions", "user-ext.js"), "utf8"), "// user extension\n");
	assert.equal(existsSync(path.join(island, "active-account.json")), false);
	assert.equal(restarted.list().active, undefined);
	// deactivate with nothing active is explicit: it reports what an orphan cleanup removes, not a silent no-op.
	writeFileSync(profilesFile, JSON.stringify(doc));
	const e = path.join(agentDir, "extensions", EXTENSION_FILE);
	writeFileSync(e, TEMPLATE, { mode: 0o600 });
	const result = await restarted.deactivate();
	assert.equal(result.deactivated, false);
	assert.deepEqual(result.removed, ["extension"]);
	assert.equal(existsSync(e), false);
	assert.deepEqual((await restarted.deactivate()).removed, undefined, "plain 'nothing active' stays the old answer");
});

test("a failed teardown is fail-closed: the journal is kept, activation refuses, and a later recovery completes", async (t) => {
	const root = tempRoot();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const { store, agentDir } = setupCustom(root);
	await store.save(GW);
	crashRun(root, "select", "gw1", "before-restart");
	const ext = path.join(agentDir, "extensions", EXTENSION_FILE);
	rmSync(ext);
	mkdirSync(ext); // cannot be unlinked as a file: teardown fails
	writeFileSync(path.join(ext, "blocker"), "x");
	const stuck = setupCustom(root).store;
	assert.equal(existsSync(path.join(agentDir, ".switch.json")), true, "recovery evidence is not discarded");
	assert.equal(RESIDUE(agentDir).key, true, "credential still there: recovery has not happened (and says so)");
	ageLock(agentDir);
	await assert.rejects(stuck.select("gw1"), /could not be cleaned up/);
	rmSync(ext, { recursive: true });
	const fixed = setupCustom(root).store;
	assert.equal(existsSync(path.join(agentDir, ".switch.json")), false);
	assert.deepEqual(RESIDUE(agentDir), NO_RESIDUE);
	assert.equal(fixed.list().active, undefined);
});

test("advisory 1: a torn or garbage journal is unknown, so it is kept as evidence and activation is blocked (never silently cleared)", async (t) => {
	for (const torn of ['{"from":null,"to":{"accountId":"gw","provider":"custom-gw","cus', "garbage", ""]) {
		const root = tempRoot();
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const { store, agentDir } = setupCustom(root);
		await store.save(GW);
		await store.save(CLOUD);
		crashRun(root, "select", "gw1", "before-restart");
		writeFileSync(path.join(agentDir, ".switch.json"), torn, { mode: 0o600 });
		ageLock(agentDir);
		const stuck = setupCustom(root).store;
		assert.equal(readFileSync(path.join(agentDir, ".switch.json"), "utf8"), torn, "journal kept byte for byte");
		assert.equal(RESIDUE(agentDir).key, true, "nothing was guessed or removed");
		await assert.rejects(stuck.select("c1"), /could not be cleaned up/);
	}
});

test("the host's ownership pattern is the template's own PROVIDER_ID", () => {
	assert.ok(TEMPLATE.includes(`const PROVIDER_ID = ${PROVIDER_ID};`));
	for (const bad of ["anthropic", "openai", "custom-", "Custom-x", "custom-a b", ""]) assert.equal(PROVIDER_ID.test(bad), false, bad);
});

test("B-1: a corrupt agent auth.json during recovery keeps the journal as evidence and blocks activation (no fail-open)", async (t) => {
	const root = tempRoot();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const { store, agentDir } = setupCustom(root);
	await store.save(GW);
	crashRun(root, "select", "gw1", "before-restart");
	const authFile = path.join(agentDir, "auth.json");
	writeFileSync(authFile, "{ not json", { mode: 0o600 });
	ageLock(agentDir);
	const stuck = setupCustom(root).store;
	assert.equal(existsSync(path.join(agentDir, ".switch.json")), true, "journal kept as recovery evidence");
	assert.equal(readFileSync(authFile, "utf8"), "{ not json", "the unreadable file is not rewritten");
	await assert.rejects(stuck.select("gw1"), /could not be cleaned up/);
	// Once the file is repaired by hand, the next start completes the teardown.
	writeFileSync(authFile, JSON.stringify({ "custom-gw": { type: "api_key", key: SECRET } }), { mode: 0o600 });
	const fixed = setupCustom(root).store;
	assert.equal(existsSync(path.join(agentDir, ".switch.json")), false);
	assert.deepEqual(RESIDUE(agentDir), NO_RESIDUE);
	assert.equal(fixed.list().active, undefined);
});

test("B-2: orphan cleanup never trusts a provider name in the runtime file: a hand-written 'anthropic' leaves the cloud credential and default alone", async (t) => {
	const root = tempRoot();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const { store, agentDir, island } = setupCustom(root);
	await store.save(CLOUD);
	await store.select("c1");
	const authBefore = readFileSync(path.join(agentDir, "auth.json"), "utf8");
	const settingsBefore = readFileSync(path.join(agentDir, "settings.json"), "utf8");
	assert.ok(JSON.parse(authBefore).anthropic);
	writeFileSync(path.join(agentDir, RUNTIME_FILE), JSON.stringify({ provider: "anthropic", models: ["x"], base: "https://gateway.example/v1" }), { mode: 0o600 });
	const restarted = setupCustom(root).store;
	assert.equal(readFileSync(path.join(agentDir, "auth.json"), "utf8"), authBefore, "cloud credential untouched");
	assert.equal(readFileSync(path.join(agentDir, "settings.json"), "utf8"), settingsBefore, "default provider untouched");
	assert.equal(restarted.list().active, "c1", "active cloud profile unchanged");
	assert.ok(existsSync(path.join(island, "active-account.json")));
	const result = await restarted.deactivate(); // explicit path must be equally safe
	assert.equal(result.deactivated, true);
});

test("model limits live in one place: the template and discovery use the same constants", async (t) => {
	const root = tempRoot();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const { MODEL_LIMITS } = require("../src/custom-provider-extension.cjs");
	const { DISCOVERY_LIMITS } = require("../src/custom-provider.cjs");
	const ext = await loadTemplate(root);
	assert.deepEqual({ maxModels: MODEL_LIMITS.maxModels, maxIdChars: MODEL_LIMITS.maxIdChars }, { maxModels: 128, maxIdChars: 200 });
	assert.equal(DISCOVERY_LIMITS.maxModels, MODEL_LIMITS.maxModels);
	assert.equal(DISCOVERY_LIMITS.maxIdChars, MODEL_LIMITS.maxIdChars);
	assert.equal(ext.LIMITS.maxModels, MODEL_LIMITS.maxModels);
	assert.equal(ext.LIMITS.maxIdChars, MODEL_LIMITS.maxIdChars);
});

test("crash mid-deactivation (credential gone, extension still present): recovery removes the leftovers", async (t) => {
	const root = tempRoot();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const { store, agentDir } = setupCustom(root);
	await store.save(GW);
	await store.select("gw1");
	crashRun(root, "deactivate", "", "unlink:abito-custom-provider.js");
	const restarted = setupCustom(root).store;
	assert.deepEqual(tree(agentDir).filter((f) => /custom-provider|auth\.json/.test(f)), [], "no extension, runtime data or credential left");
	assert.equal(restarted.list().active, undefined);
});

test("old providers: a crash at the marker write keeps its pre-existing recovery semantics (cloud/local public behaviour unchanged)", async (t) => {
	const root = tempRoot();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const { store, agentDir } = setupCustom(root);
	await store.save(CLOUD);
	crashRun(root, "select", "c1", "marker");
	const restarted = setupCustom(root).store;
	assert.equal(restarted.list().active, undefined);
	assert.equal(JSON.parse(readFileSync(path.join(agentDir, "auth.json"), "utf8")).anthropic.key, "cloud-key", "base behaviour: the cloud credential stays in place");
	assert.equal(existsSync(path.join(agentDir, "extensions")), false);
});

// ----- real isolated Pi RPC ---------------------------------------------------------------

function piCommand() {
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		const candidate = path.join(dir, "pi");
		if (dir && existsSync(candidate)) return candidate;
	}
	throw new Error("the installed `pi` is required for the real extension proof (not found on PATH)");
}

/**
 * The installed Pi package, resolved the way the product does (node + the package's own CLI JS, never the
 * `pi` launcher shim, which is a POSIX sh script on Windows too): { cli, ai } absolute paths.
 * Layouts: managed (`bin/pi` + `install/releases/<v>/node_modules`) and npm (global or local node_modules).
 */
let piPackageCache;
function piPackage() {
	if (piPackageCache) return piPackageCache;
	const pkgDirs = [];
	try {
		// npm global install whose bin directory is not on PATH (e.g. a Windows runner): ask npm where it put it.
		const root = require("node:child_process").execFileSync("npm", ["root", "-g"], { encoding: "utf8", shell: process.platform === "win32", timeout: 30_000 }).trim();
		if (root) pkgDirs.push(path.join(root, "@earendil-works", "pi-coding-agent"));
	} catch {}
	let real;
	try { real = fs.realpathSync(piCommand()); } catch { real = undefined; }
	if (real) try {
		const version = readFileSync(path.join(path.dirname(real), "..", "install", "current-version"), "utf8").trim();
		pkgDirs.push(path.join(path.dirname(real), "..", "install", "releases", version, "node_modules", "@earendil-works", "pi-coding-agent"));
	} catch {}
	let dir = real ? path.dirname(real) : undefined;
	for (let i = 0; dir && i < 8; i++, dir = path.dirname(dir)) {
		pkgDirs.push(path.join(dir, "node_modules", "@earendil-works", "pi-coding-agent"), path.join(dir, "@earendil-works", "pi-coding-agent"));
	}
	for (const pkg of pkgDirs) {
		const cli = path.join(pkg, "dist", "bundle", "cli.js");
		const ai = [path.join(pkg, "node_modules", "@earendil-works", "pi-ai", "dist", "compat.js"), path.join(pkg, "..", "pi-ai", "dist", "compat.js")].find((c) => existsSync(c));
		if (existsSync(cli) && ai) return (piPackageCache = { cli, ai });
	}
	throw new Error("installed @earendil-works/pi-coding-agent (cli + pi-ai) not found next to pi");
}
const piAiCompat = () => piPackage().ai;

/**
 * The REAL-pi proofs need the installed `pi` (and its pi-ai). Without it they are skipped with a visible reason,
 * unless ABITO_REQUIRE_PI=1 (CI sets it where pi is installed): then absence is a failure, never a silent skip.
 */
const PI_SKIP = (() => {
	if (process.env.ABITO_REQUIRE_PI === "1") return false;
	try { piPackage(); return false; } catch (error) { return `installed pi not found (${error.message})`; }
})();

/** Runs `pi --mode rpc` in an isolated agent dir; resolves with the records seen until agent_settled. */
function runPi(agentDir, home, provider, modelId, message, timeoutMs = 60_000, hooks = {}) {
	return new Promise((resolve, reject) => {
		const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, TEMP: home, TMP: home } : {}), PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", NO_PROXY: "*" };
		const child = spawn(process.execPath, [piPackage().cli, "--mode", "rpc", "--session-dir", path.join(home, "sessions"), "--no-skills", "--no-prompt-templates", "--no-themes"], { cwd: home, env, stdio: ["pipe", "pipe", "pipe"] });
		const records = [];
		let buf = "";
		let stderr = "";
		const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`pi timed out; stderr=${stderr.slice(0, 500)}`)); }, timeoutMs);
		child.stderr.on("data", (d) => { stderr += d; });
		child.stdout.on("data", (d) => {
			buf += d.toString("utf8");
			let i;
			while ((i = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, i);
				buf = buf.slice(i + 1);
				try { records.push(JSON.parse(line)); } catch {}
				const last = records.at(-1);
				hooks.onRecord?.(last, (command) => child.stdin.write(`${JSON.stringify(command)}\n`));
				if (last?.type === "agent_settled") child.stdin.end();
			}
		});
		child.on("close", () => { clearTimeout(timer); resolve({ records, stderr }); });
		child.stdin.write(`${JSON.stringify({ id: "m", type: "set_model", provider, modelId })}\n`);
		child.stdin.write(`${JSON.stringify({ id: "p", type: "prompt", message })}\n`);
	});
}
/** Diagnostic: Pi-side retry events and per-attempt outcomes (no secrets: errorMessage is the fixed guard text). */
const describeRetries = (records) => JSON.stringify(records.filter((r) => /^auto_retry/.test(r.type ?? "")).map((r) => ({ type: r.type, attempt: r.attempt, error: r.errorMessage ?? r.finalError })));
const assistantEnd = (records) => records.filter((r) => r.type === "message_end" && r.message?.role === "assistant").at(-1)?.message;

async function realSetup(t, gwHandler) {
	const gw = await listen(gwHandler);
	t.after(() => close(gw.server));
	const root = tempRoot();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const home = path.join(root, "home");
	mkdirSync(home, { recursive: true });
	const s = setupCustom(root, { baseUrl: gw.base });
	await s.store.save(GW);
	await s.store.select("gw1");
	return { gw, home, ...s };
}

test("REAL pi RPC: the activated extension loads and a prompt streams through the guarded transport", { skip: PI_SKIP, timeout: 120_000 }, async (t) => {
	const r = await realSetup(t, (req, res) => (req.url === "/v1/chat/completions" ? okStream(res) : (res.writeHead(404), res.end())));
	const { records, stderr } = await runPi(r.agentDir, r.home, "custom-gw", "model-a", "ping");
	const setModel = records.find((x) => x.id === "m");
	assert.equal(setModel?.success, true, `extension provider registered in Pi: ${JSON.stringify(setModel)} ${stderr.slice(0, 300)}`);
	const msg = assistantEnd(records);
	assert.equal(msg?.stopReason, "stop", JSON.stringify(msg));
	assert.equal(msg.content.map((c) => c.text ?? "").join(""), "pong");
	assert.equal(msg.provider, "custom-gw");
	const chat = r.gw.hits.filter((h) => h.url === "/v1/chat/completions");
	assert.equal(chat.length, 1);
	assert.equal(chat[0].authorization, `Bearer ${SECRET}`);
	assert.equal(JSON.parse(chat[0].body).model, "model-a");
	assert.equal(r.gw.hits.length, 1, `no request other than the single chat completion: ${describeHits(r.gw.hits)} retries=${describeRetries(records)}`);
});

test("REAL pi RPC: 301/302/307/308 redirects (cross-origin and same-origin) are refused; the destination is never contacted", { skip: PI_SKIP, timeout: 240_000 }, async (t) => {
	const dest = await listen((req, res) => okStream(res));
	t.after(() => close(dest.server));
	for (const status of [301, 302, 307, 308]) {
		for (const kind of ["cross", "same"]) {
			const r = await realSetup(t, (req, res) => {
				res.writeHead(status, { location: kind === "cross" ? `${dest.base}/chat/completions` : "/v1/chat/completions" });
				res.end();
			});
			const { records } = await runPi(r.agentDir, r.home, "custom-gw", "model-a", "ping");
			const msg = assistantEnd(records);
			assert.equal(msg?.stopReason, "error", `${status}/${kind}: ${JSON.stringify(msg)}`);
			assert.match(msg.errorMessage, /^Custom gateway request refused \(redirect\)$/, `${status}/${kind}`);
			assert.equal(msg.errorMessage.includes(SECRET), false);
			assert.equal(r.gw.hits.length, 1, `${status}/${kind}: the redirect was not followed (no retry either): ${describeHits(r.gw.hits)} retries=${describeRetries(records)} msgs=${JSON.stringify(records.filter((x) => x.type === "message_end" && x.message?.role === "assistant").map((x) => x.message.errorMessage))}`);
		}
	}
	assert.equal(dest.hits.length, 0, "cross-origin destination hit count 0");
});

test("REAL pi RPC: user cancellation closes the upstream request promptly (header wait and stalled stream), not after the 300 s limits", { skip: PI_SKIP, timeout: 120_000 }, async (t) => {
	for (const mode of ["header_wait", "body_stall"]) {
		let upstreamClosed;
		const closed = new Promise((resolve) => { upstreamClosed = resolve; });
		let requestSeen;
		const seen = new Promise((resolve) => { requestSeen = resolve; });
		const r = await realSetup(t, (req, res) => {
			res.on("close", () => upstreamClosed(Date.now()));
			requestSeen();
			if (mode === "body_stall") {
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.write(`data: ${JSON.stringify(completion({ role: "assistant", content: "part" }))}\n\n`);
			}
			// header_wait: never respond; body_stall: never finish.
		});
		let abortedAt;
		let aborting = false;
		const run = runPi(r.agentDir, r.home, "custom-gw", "model-a", "ping", 60_000, {
			onRecord(record, send) {
				if (aborting || record?.id !== "p") return; // the prompt was accepted: the run is starting
				aborting = true;
				seen.then(() => new Promise((resolve) => setTimeout(resolve, mode === "body_stall" ? 500 : 100))).then(() => { abortedAt = Date.now(); send({ id: "a", type: "abort" }); });
			},
		});
		const { records } = await run;
		const settledAt = Date.now();
		const msg = assistantEnd(records);
		assert.equal(msg?.stopReason, "aborted", `${mode}: ${JSON.stringify(msg)}`);
		assert.ok(abortedAt, `${mode}: abort was sent`);
		assert.ok(settledAt - abortedAt < 10_000, `${mode}: settled ${settledAt - abortedAt} ms after the abort`);
		let giveUp;
		const upstreamAt = await Promise.race([closed, new Promise((resolve) => { giveUp = setTimeout(() => resolve(undefined), 5000); })]);
		clearTimeout(giveUp);
		assert.ok(upstreamAt !== undefined, `${mode}: the upstream connection was closed`);
		assert.ok(upstreamAt - abortedAt < 5000, `${mode}: upstream closed ${upstreamAt - abortedAt} ms after the abort`);
		assert.equal(r.gw.hits.filter((h) => h.url === "/v1/chat/completions").length, 1, `${mode}: exactly one inference request, no retry after the abort: ${describeHits(r.gw.hits)}`);
		assert.equal(JSON.stringify(records).includes(SECRET), false);
	}
});

test("makeStream: an AbortSignal closes the upstream and ends the stream aborted in well under the transport limits", { skip: PI_SKIP }, async (t) => {
	const root = tempRoot();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const ext = await loadTemplate(root);
	const piAi = () => import(pathToFileURL(piAiCompat()).href);
	for (const mode of ["header_wait", "body_stall"]) {
		const closes = [];
		const gw = await listen((req, res) => {
			res.on("close", () => closes.push(Date.now()));
			if (mode === "body_stall") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(`data: ${JSON.stringify(completion({ role: "assistant", content: "part" }))}\n\n`); }
		});
		try {
			const controller = new AbortController();
			const model = { id: "model-a", name: "model-a", api: "abito-custom-openai", provider: "custom-gw", baseUrl: new URL(gw.base).href.replace(/\/$/, ""), reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 };
			const stream = ext.makeStream({ provider: "custom-gw", models: ["model-a"], base: ext.normalizeBaseUrl(gw.base) }, piAi)(model, { messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }] }, { signal: controller.signal, apiKey: SECRET });
			let t0 = Date.now();
			// Abort only once the gateway has actually received the request (the SDK import can be slow on a cold runner).
			const abortWhenSeen = setInterval(() => { if (gw.hits.length > 0) { clearInterval(abortWhenSeen); t0 = Date.now(); controller.abort(); } }, 10);
			const abortGiveUp = setTimeout(() => { clearInterval(abortWhenSeen); controller.abort(); }, 20_000);
			let giveUp;
			const result = await Promise.race([stream.result(), new Promise((resolve) => { giveUp = setTimeout(() => resolve("HANG"), 40_000); })]);
			clearTimeout(giveUp);
			clearTimeout(abortGiveUp);
			clearInterval(abortWhenSeen);
			assert.notEqual(result, "HANG", `${mode}: the stream settled`);
			assert.equal(result.stopReason, "aborted", `${mode}: ${JSON.stringify(result).slice(-250)}`);
			assert.ok(Date.now() - t0 < 4000, `${mode}: settled in ${Date.now() - t0} ms`);
			for (let i = 0; i < 200 && closes.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 25));
			assert.equal(closes.length, 1, `${mode}: upstream closed`);
			assert.equal(gw.hits.length, 1);
		} finally {
			await close(gw.server);
		}
	}
});

test("REAL pi RPC: gateway errors reach Pi as fixed, key-free text", { skip: PI_SKIP, timeout: 120_000 }, async (t) => {
	const r = await realSetup(t, (req, res) => { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: `leak ${SECRET} gateway.example` } })); });
	const { records } = await runPi(r.agentDir, r.home, "custom-gw", "model-a", "ping");
	const msg = assistantEnd(records);
	assert.equal(msg?.stopReason, "error");
	assert.equal(msg.errorMessage, "Custom gateway returned HTTP 500");
	assert.equal(JSON.stringify(records).includes(SECRET), false, "the key is not echoed anywhere in the RPC stream");
});

// ----- real SDK helper enrollment: no network, no provider lookup ----------------------------

test("REAL sdk-helper enroll_api_key for a custom provider performs no network request", { skip: PI_SKIP, timeout: 120_000 }, async (t) => {
	const gw = await listen((req, res) => okStream(res));
	t.after(() => close(gw.server));
	const root = tempRoot();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const accountsRoot = path.join(root, "island", "accounts");
	const manager = new AccountManager({ accountsRoot, env: { PATH: process.env.PATH, PI_OFFLINE: "1" }, log: () => {} });
	t.after(() => manager.close());
	await manager.createCustomAccount({ label: "Gateway", baseUrl: gw.base });
	const before = readFileSync(path.join(accountsRoot, "gateway", "models.json"), "utf8");
	const account = await manager.enrollApiKey({ accountId: "gateway", apiKey: SECRET });
	assert.deepEqual(account, { accountId: "gateway", label: "Gateway", provider: "custom-gateway", authMethod: "api_key", configured: true, custom: true });
	assert.equal(gw.hits.length, 0, "enrollment contacted no server");
	assert.equal(JSON.parse(readFileSync(path.join(accountsRoot, "gateway", "auth.json"), "utf8"))["custom-gateway"].key, SECRET);
	assert.equal(readFileSync(path.join(accountsRoot, "gateway", "models.json"), "utf8"), before, "enrollment leaves the models config untouched");
	assert.equal(JSON.stringify(manager.listAccounts()).includes(SECRET), false);
});

// ----- key hygiene and setup-error cleanup -----------------------------------------------------

function fixtureManager(root) {
	const accountsRoot = path.join(root, "accounts");
	return new AccountManager({ accountsRoot, helper: { command: process.execPath, args: [FIXTURE, "--accounts-root", accountsRoot], env: helperEnv(process.env, { home: root, tmp: root }) } });
}

test("control characters in a custom API key are rejected before any side effect (enroll and auth_reply)", async (t) => {
	const root = tempRoot();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const gw = await listen((req, res) => okStream(res));
	t.after(() => close(gw.server));
	const manager = fixtureManager(root);
	t.after(() => manager.close());
	await manager.createCustomAccount({ label: "Gateway", baseUrl: gw.base });
	const authPath = path.join(root, "accounts", "gateway", "auth.json");
	const meta = readFileSync(path.join(root, "accounts", "gateway", "account.json"), "utf8");
	for (const bad of ["sk-a\tb", "sk-a\u0001b", "sk-a\u007fb", "sk-a\r\nX: y", "sk-a\nb", "sk-a\u0000b"]) {
		await assert.rejects(manager.enrollApiKey({ accountId: "gateway", apiKey: bad }), (e) => e.message === "Invalid API key");
	}
	assert.equal(existsSync(authPath), false, "no credential written");
	assert.equal(readFileSync(path.join(root, "accounts", "gateway", "account.json"), "utf8"), meta);
	assert.equal(gw.hits.length, 0);
	// auth_reply: rejected with the prompt still open; a clean retry on the same prompt succeeds.
	const prompts = [];
	manager.emit = ((orig) => (name, payload) => { if (name === "auth_prompt") prompts.push(payload); return orig?.call(manager, name, payload); })(manager.emit);
	const { flowId } = await manager.startLogin({ accountId: "gateway", method: "api_key" });
	for (let i = 0; i < 100 && prompts.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
	const prompt = prompts[0];
	assert.ok(prompt, "prompt opened");
	await assert.rejects(manager.reply(flowId, { promptId: prompt.promptId, value: "sk-bad\r\nHost: evil" }), (e) => e.message === "Invalid API key");
	assert.equal(existsSync(authPath), false);
	await manager.reply(flowId, { promptId: prompt.promptId, value: SECRET });
	for (let i = 0; i < 100 && !existsSync(authPath); i++) await new Promise((r) => setTimeout(r, 20));
	assert.equal(JSON.parse(readFileSync(authPath, "utf8"))["custom-gateway"].key, SECRET);
	for (let i = 0; i < 100 && manager.flow; i++) await new Promise((r) => setTimeout(r, 20));
	// Existing providers keep their old key rules (control characters other than CR/LF/NUL stay accepted).
	const cloud = await manager.createAccount({ label: "Cloud", provider: "anthropic" });
	assert.equal((await manager.enrollApiKey({ accountId: cloud.accountId, apiKey: "sk-a\tb" })).configured, true);
});

test("a synchronous HTTP setup error rejects with a fixed reason and clears the timeout", async () => {
	// A header value Node refuses makes client.request() throw synchronously.
	const started = Date.now();
	await assert.rejects(discoverModels({ baseUrl: "http://127.0.0.1:9/v1", apiKey: "bad\u0001key", timeoutMs: 600_000 }), (e) => e.reason === "unreachable" && !/bad|127\.0\.0\.1/.test(`${e.message}${e.stack}`));
	assert.ok(Date.now() - started < 2000);
	// If the timer leaked, an active handle would keep this child alive for the 10 minutes.
	const code = `const {discoverModels}=require(${JSON.stringify(path.join(__dirname, "..", "src", "custom-provider.cjs"))});discoverModels({baseUrl:"http://127.0.0.1:9/v1",apiKey:"bad\\u0001key",timeoutMs:600000}).catch(()=>{});`;
	const exit = await new Promise((resolve) => { const c = spawn(process.execPath, ["-e", code]); const k = setTimeout(() => { c.kill("SIGKILL"); resolve("leaked"); }, 5000); c.on("close", (n) => { clearTimeout(k); resolve(n); }); });
	assert.equal(exit, 0, "process exits promptly: no pending timeout");
});
