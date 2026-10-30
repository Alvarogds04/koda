"use strict";

// HU-041 / T6a-1: custom LiteLLM / OpenAI-compatible provider accounts.
// Loopback fixture servers only (literal 127.0.0.1, ephemeral ports); neutral
// fixtures (gateway.example, model-a). No real endpoint, no real credential.

const http = require("node:http");
const { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const P = require("../src/protocol.cjs");
const { AccountManager, helperEnv } = require("../src/auth.cjs");
const { discoverModels, DISCOVERY_LIMITS } = require("../src/custom-provider.cjs");

const SECRET = "sk-fake-SECRET-2468-DO-NOT-LEAK";
const FIXTURE = path.join(__dirname, "fixtures", "fake-auth.cjs");

// ----- Base URL policy -----------------------------------------------------------------

test("validateCustomBaseUrl: https, or http only for literal loopback; no userinfo/query/fragment", () => {
	const ok = {
		"https://gateway.example/v1": "https://gateway.example/v1",
		"https://Gateway.Example:8443/v1/": "https://gateway.example:8443/v1",
		"https://gateway.example": "https://gateway.example",
		"http://127.0.0.1:4000/v1": "http://127.0.0.1:4000/v1",
		"http://[::1]:4000/v1": "http://[::1]:4000/v1",
	};
	for (const [input, want] of Object.entries(ok)) assert.equal(P.validateCustomBaseUrl(input), want, input);
	for (const bad of [
		"http://gateway.example/v1", // plain http to a remote host
		"http://localhost:4000/v1", // a name, not a literal loopback
		"http://127.0.0.2.evil.example/v1",
		"ftp://gateway.example/v1",
		"https://user:pass@gateway.example/v1",
		"https://user@gateway.example/v1",
		"https://gateway.example/v1?x=1",
		"https://gateway.example/v1?",
		"https://gateway.example/v1#frag",
		"https://gateway.example/v1#",
		"https://gateway.example/a/../v1",
		"https://gateway.example//v1",
		"https://gateway.example/v1 ",
		"https://gateway.example:0/v1",
		"https://gateway.example:99999/v1",
		"https://gateway.example/%2e%2e/v1",
		"https://2130706433/v1",
		"http://2130706433/v1",
		"http://0x7f.1/v1",
		"",
		42,
		undefined,
		`https://${"a".repeat(250)}.example/v1`,
	]) {
		assert.equal(P.validateCustomBaseUrl(bad), undefined, JSON.stringify(bad));
	}
});

// ----- bounded, redirect-refusing discovery ----------------------------------------------

function listen(handler) {
	const hits = [];
	const server = http.createServer((req, res) => {
		hits.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
		handler(req, res, hits);
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, hits, base: `http://127.0.0.1:${server.address().port}/v1` })));
}
const json = (res, body, status = 200) => {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(typeof body === "string" ? body : JSON.stringify(body));
};
const close = (s) => new Promise((resolve) => { s.closeAllConnections?.(); s.close(resolve); });

test("discoverModels: GET <base>/models with the bearer key; returns bounded unique ids", async (t) => {
	const gw = await listen((req, res) => json(res, { object: "list", data: [{ id: "model-a" }, { id: "model-b", owned_by: "x" }] }));
	t.after(() => close(gw.server));
	assert.deepEqual(await discoverModels({ baseUrl: gw.base, apiKey: SECRET }), ["model-a", "model-b"]);
	assert.deepEqual(gw.hits, [{ method: "GET", url: "/v1/models", authorization: `Bearer ${SECRET}` }]);
});

test("discoverModels refuses every redirect (301/302/307/308), cross-host included; the destination is never contacted", async (t) => {
	const dest = await listen((req, res) => json(res, { data: [{ id: "stolen" }] }));
	t.after(() => close(dest.server));
	for (const status of [301, 302, 307, 308]) {
		const gw = await listen((req, res) => {
			res.writeHead(status, { location: `${dest.base}/models` });
			res.end();
		});
		await assert.rejects(discoverModels({ baseUrl: gw.base, apiKey: SECRET }), (e) => e.reason === "redirect");
		await close(gw.server);
	}
	const same = await listen((req, res, hits) => {
		res.writeHead(307, { location: "/v1/models?again=1" });
		res.end();
	});
	await assert.rejects(discoverModels({ baseUrl: same.base, apiKey: SECRET }), (e) => e.reason === "redirect");
	assert.equal(same.hits.length, 1, "same-origin redirects are not followed either");
	await close(same.server);
	assert.equal(dest.hits.length, 0, "nothing reached the redirect destination");
});

test("discoverModels bounds time, bytes, model count and ids; errors carry a fixed reason, never the key or URL", async (t) => {
	const cases = [
		["status", (req, res) => json(res, { error: SECRET }, 500)],
		["invalid_response", (req, res) => json(res, "not json " + SECRET)],
		["invalid_response", (req, res) => json(res, { data: [{ id: "model-a" }, { id: "model-a" }] })],
		["invalid_response", (req, res) => json(res, { data: [{ id: "bad\u0007id" }] })],
		["invalid_response", (req, res) => json(res, { data: [{ id: "x".repeat(DISCOVERY_LIMITS.maxIdChars + 1) }] })],
		["invalid_response", (req, res) => json(res, { data: [] })],
		["too_many", (req, res) => json(res, { data: Array.from({ length: DISCOVERY_LIMITS.maxModels + 1 }, (_, i) => ({ id: `m${i}` })) })],
		["too_large", (req, res) => json(res, { data: [{ id: "a" }], pad: "x".repeat(DISCOVERY_LIMITS.maxBytes + 10) })],
		["timeout", () => {}],
	];
	for (const [reason, handler] of cases) {
		const gw = await listen(handler);
		await assert.rejects(
			discoverModels({ baseUrl: gw.base, apiKey: SECRET, timeoutMs: 300 }),
			(e) => {
				assert.equal(e.reason, reason);
				const text = `${e.message} ${e.stack}`;
				assert.equal(text.includes(SECRET) || text.includes("127.0.0.1"), false, "no key/URL in the error");
				return true;
			},
			reason,
		);
		await close(gw.server);
	}
	await assert.rejects(discoverModels({ baseUrl: "http://gateway.example/v1", apiKey: SECRET }), (e) => e.reason === "invalid_url");
	await assert.rejects(discoverModels({ baseUrl: "https://127.0.0.1:1/v1", apiKey: SECRET, timeoutMs: 500 }), (e) => e.reason === "unreachable");
});

// ----- account lifecycle through the manager --------------------------------------------

function makeManager(root) {
	const accountsRoot = path.join(root, "accounts");
	return new AccountManager({
		accountsRoot,
		helper: { command: process.execPath, args: [FIXTURE, "--accounts-root", accountsRoot], env: helperEnv(process.env, { home: root, tmp: root }) },
	});
}
const tempRoot = () => mkdtempSync(path.join(require("node:fs").realpathSync.native(os.tmpdir()), "abito-custom-test-"));
const read = (root, id, file) => readFileSync(path.join(root, "accounts", id, file), "utf8");

test("createCustomAccount: public DTO has no URL/key; models.json is private; bad input creates nothing", async (t) => {
	const root = tempRoot();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const manager = makeManager(root);
	const account = await manager.createCustomAccount({ label: "Gateway", baseUrl: "https://gateway.example/v1/" });
	assert.deepEqual(account, { accountId: "gateway", label: "Gateway", provider: "custom-gateway", authMethod: "none", configured: false, custom: true });
	const listed = JSON.stringify(manager.listAccounts());
	const meta = read(root, "gateway", "account.json");
	for (const text of [listed, meta, JSON.stringify(P.accountsFrame(manager.listAccounts()))]) {
		assert.equal(text.includes("gateway.example"), false, "the Base URL is not public");
	}
	assert.deepEqual(P.accountDto(account), account);
	const models = JSON.parse(read(root, "gateway", "models.json"));
	assert.equal(models.providers["custom-gateway"].baseUrl, "https://gateway.example/v1");
	assert.equal(models.providers["custom-gateway"].api, "openai-completions");
	assert.equal(models.providers["custom-gateway"].apiKey, undefined, "the key only ever lives in auth.json");
	if (process.platform !== "win32") assert.equal(statSync(path.join(root, "accounts", "gateway", "models.json")).mode & 0o777, 0o600);
	const before = readdirSync(path.join(root, "accounts")).sort();
	for (const bad of [
		{ label: "X", baseUrl: "http://gateway.example/v1" },
		{ label: "X", baseUrl: "https://u:p@gateway.example/v1" },
		{ label: "", baseUrl: "https://gateway.example/v1" },
		{ label: "X", baseUrl: "https://gateway.example/v1", accountId: "../x" },
		{ label: "Gateway", baseUrl: "https://gateway.example/v1", accountId: "gateway" },
	]) await assert.rejects(manager.createCustomAccount(bad));
	assert.deepEqual(readdirSync(path.join(root, "accounts")).sort(), before);
});

test("custom account: key via the existing enrollment path, discovery writes the models, failure keeps the previous config", async (t) => {
	const root = tempRoot();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	let mode = "ok";
	const gw = await listen((req, res) => {
		if (mode === "redirect") {
			res.writeHead(307, { location: "https://other.example/v1/models" });
			return res.end();
		}
		json(res, { data: [{ id: "model-a" }, { id: "model-b" }] });
	});
	t.after(() => close(gw.server));
	const manager = makeManager(root);
	await manager.createCustomAccount({ label: "Gateway", baseUrl: gw.base });
	// Not signed in yet: discovery refuses before any request leaves.
	await assert.rejects(manager.refreshCustomModels({ accountId: "gateway" }), /not signed in/i);
	assert.equal(gw.hits.length, 0);
	await manager.enrollApiKey({ accountId: "gateway", apiKey: SECRET });
	const refreshed = await manager.refreshCustomModels({ accountId: "gateway" });
	assert.deepEqual(refreshed, { accountId: "gateway", label: "Gateway", provider: "custom-gateway", authMethod: "api_key", configured: true, custom: true });
	assert.deepEqual(JSON.parse(read(root, "gateway", "models.json")).providers["custom-gateway"].models, [{ id: "model-a" }, { id: "model-b" }]);
	assert.equal(gw.hits.at(-1).authorization, `Bearer ${SECRET}`);
	const good = read(root, "gateway", "models.json");

	mode = "redirect";
	const hitsBefore = gw.hits.length;
	await assert.rejects(manager.refreshCustomModels({ accountId: "gateway" }), (e) => {
		assert.match(e.message, /^Model discovery failed \(redirect\)$/);
		return true;
	});
	assert.equal(gw.hits.length, hitsBefore + 1);
	assert.equal(read(root, "gateway", "models.json"), good, "previous valid configuration preserved");
	for (const text of [JSON.stringify(manager.listAccounts()), read(root, "gateway", "account.json")]) assert.equal(text.includes(SECRET), false);
});

test("setCustomEndpoint: same-origin update re-discovers; a host change is refused while a key is stored; local/static accounts are not custom", async (t) => {
	const root = tempRoot();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const gw = await listen((req, res) => json(res, { data: [{ id: req.url.startsWith("/v2") ? "model-v2" : "model-a" }] }));
	t.after(() => close(gw.server));
	const manager = makeManager(root);
	await manager.createCustomAccount({ label: "Gateway", baseUrl: gw.base });
	// Unsigned account: URL is just stored, nothing is contacted.
	const next = gw.base.replace("/v1", "/v2");
	await manager.setCustomEndpoint({ accountId: "gateway", baseUrl: next });
	assert.equal(JSON.parse(read(root, "gateway", "models.json")).providers["custom-gateway"].baseUrl, next);
	assert.equal(gw.hits.length, 0);
	await manager.enrollApiKey({ accountId: "gateway", apiKey: SECRET });
	await manager.setCustomEndpoint({ accountId: "gateway", baseUrl: gw.base });
	assert.deepEqual(JSON.parse(read(root, "gateway", "models.json")).providers["custom-gateway"].models, [{ id: "model-a" }]);
	// Different host while a key is stored: refused, nothing changes, nothing is contacted.
	const before = read(root, "gateway", "models.json");
	const hits = gw.hits.length;
	await assert.rejects(manager.setCustomEndpoint({ accountId: "gateway", baseUrl: "https://other.example/v1" }), /sign out/i);
	await assert.rejects(manager.setCustomEndpoint({ accountId: "gateway", baseUrl: "http://other.example/v1" }));
	assert.equal(read(root, "gateway", "models.json"), before);
	assert.equal(gw.hits.length, hits);
	// Local and static accounts keep their behaviour.
	await manager.createLocalAccount({ label: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", modelIds: ["m1"] });
	await assert.rejects(manager.refreshCustomModels({ accountId: "ollama" }), /not a custom/i);
	await assert.rejects(manager.setCustomEndpoint({ accountId: "ollama", baseUrl: gw.base }), /not a custom/i);
	await assert.rejects(manager.enrollApiKey({ accountId: "ollama", apiKey: SECRET }), /Local accounts do not take API keys/);
	const cloud = await manager.createAccount({ label: "Cloud", provider: "anthropic" });
	await assert.rejects(manager.refreshCustomModels({ accountId: cloud.accountId }), /not a custom/i);
	const enrolled = await manager.enrollApiKey({ accountId: cloud.accountId, apiKey: SECRET });
	assert.deepEqual(enrolled, { accountId: "cloud", label: "Cloud", provider: "anthropic", authMethod: "api_key", configured: true });
	assert.deepEqual(manager.listAccounts().map((a) => [a.accountId, a.custom === true, a.local === true]), [["cloud", false, false], ["gateway", true, false], ["ollama", false, true]]);
});
