"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../src/protocol.cjs");

const line = (v) => Buffer.from(JSON.stringify(v));

test("client frames: valid ones are rebuilt with allowed fields only", () => {
	const d = P.decodeClientLine(line({ type: "send", text: "hi", extra: "x", images: [{ data: "AAAA", mimeType: "image/png", path: "/etc/passwd" }] }));
	assert.deepEqual(d.frame, { type: "send", text: "hi", images: [{ type: "image", data: "AAAA", mimeType: "image/png" }] });
	assert.deepEqual(P.decodeClientLine(line({ type: "ui_response", id: "a1", confirmed: true, junk: 1 })).frame, { type: "ui_response", id: "a1", confirmed: true });
	assert.deepEqual(P.decodeClientLine(line({ type: "profile_select", id: "work" })).frame, { type: "profile_select", id: "work" });
});

test("client frames: invalid, unknown and malformed are rejected without detail", () => {
	for (const bad of [
		{ type: "send", text: "" },
		{ type: "send", text: 5 },
		{ type: "send", text: "x", images: [{ data: "AAAA", mimeType: "text/html" }] },
		{ type: "send", text: "x", images: [{ data: "not base64!", mimeType: "image/png" }] },
		{ type: "profile_select", id: "../x" },
		{ type: "auth_start", accountId: "a", method: "magic" },
		{ type: "ui_response", id: "a1" },
		{ type: "get_history" },
		{ type: "hello", protocol: P.PROTOCOL, token: "t" },
		[],
		null,
	]) assert.deepEqual(P.decodeClientLine(line(bad)), { error: "bad_request" }, JSON.stringify(bad));
	assert.deepEqual(P.decodeClientLine(Buffer.from("{nope")), { error: "bad_request" });
});

test("hello decoding is separate from post-handshake decoding", () => {
	assert.deepEqual(P.decodeClientLine(line({ type: "hello", protocol: "x", token: "t", a: 1 }), { expectHello: true }).frame, { type: "hello", protocol: "x", token: "t" });
	assert.ok(P.decodeClientLine(line({ type: "send", text: "x" }), { expectHello: true }).error);
});

test("server frames carry seq and end with a single LF", () => {
	const out = P.encodeServerFrame({ type: "toast", message: "a\nb\u2028" }, 7).toString("utf8");
	assert.equal(out.indexOf("\n"), out.length - 1);
	assert.equal(JSON.parse(out).seq, 7);
});

test("translateEvent: allowlist, unknown dropped", () => {
	assert.deepEqual(P.translateEvent({ type: "agent_start" }), { frames: [], busy: true });
	assert.deepEqual(P.translateEvent({ type: "agent_settled" }), { frames: [], busy: false });
	assert.deepEqual(P.translateEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hel" } }, "m3").frames, [{ type: "message_delta", messageId: "m3", text: "hel" }]);
	assert.deepEqual(P.translateEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "secret thought" } }).frames, []);
	assert.deepEqual(P.translateEvent({ type: "message_end", message: { role: "user" } }).frames, []);
	assert.equal(P.translateEvent({ type: "message_end", message: { role: "assistant", content: "full" } }).messageDone, true);
	for (const type of ["turn_end", "agent_end", "session_info", "weird", "tool_execution_update", "__proto__"]) {
		assert.deepEqual(P.translateEvent({ type, payload: "x" }), { frames: [] }, type);
	}
	assert.deepEqual(P.translateEvent(null), { frames: [] });
});

test("translateEvent: tool activity never carries arguments or results", () => {
	const start = P.translateEvent({ type: "tool_execution_start", toolName: "read", args: { path: "/home/u/secret.txt", content: "TOPSECRET" } });
	const end = P.translateEvent({ type: "tool_execution_end", toolName: "bash\nrm -rf /", result: { content: "TOPSECRET" }, isError: true });
	assert.deepEqual(start.frames, [{ type: "activity", name: "read", state: "running" }]);
	assert.deepEqual(end.frames, [{ type: "activity", name: "tool", state: "error" }]);
	assert.ok(!JSON.stringify([start, end]).includes("TOPSECRET"));
});

test("translateEvent: tool activity carries a sanitized callId and a closed summary only when the engine names the call (#418)", () => {
	const start = P.translateEvent({ type: "tool_execution_start", toolCallId: "call_1", toolName: "read", args: { content: "TOPSECRET" } });
	const done = P.translateEvent({ type: "tool_execution_end", toolCallId: "call_1", toolName: "read", result: "TOPSECRET", isError: false });
	const failed = P.translateEvent({ type: "tool_execution_end", toolCallId: "call_2", toolName: "bash", result: "TOPSECRET", isError: true });
	assert.deepEqual(start.frames, [{ type: "activity", name: "read", state: "running", callId: "call_1" }]);
	assert.deepEqual(done.frames, [{ type: "activity", name: "read", state: "done", callId: "call_1" }]);
	assert.deepEqual(failed.frames, [{ type: "activity", name: "bash", state: "error", callId: "call_2", summary: "La herramienta terminó con error." }]);
	for (const bad of ["bad id!", "x".repeat(129), "", 7, null, { a: 1 }]) {
		const r = P.translateEvent({ type: "tool_execution_start", toolCallId: bad, toolName: "read" });
		assert.deepEqual(r.frames, [{ type: "activity", name: "read", state: "running" }], String(bad));
	}
	assert.ok(!JSON.stringify([start, done, failed]).includes("TOPSECRET"));
});

test("translateEvent: extension UI requests", () => {
	const sel = P.translateEvent({ type: "extension_ui_request", id: "u1", method: "select", title: "Pick", options: ["a", "b", 3] });
	assert.deepEqual(sel.ask, { id: "u1", kind: "select", title: "Pick", options: ["a", "b"] });
	assert.equal(P.translateEvent({ type: "extension_ui_request", id: "u2", method: "confirm", title: "Sure?" }).ask.kind, "confirm");
	assert.equal(P.translateEvent({ type: "extension_ui_request", id: "u3", method: "input", title: "Name" }).ask.kind, "input");
	assert.equal(P.translateEvent({ type: "extension_ui_request", id: "u4", method: "editor" }).cancelUi, "u4");
	assert.deepEqual(P.translateEvent({ type: "extension_ui_request", id: "u5", method: "notify", message: "hi", notifyType: "warning" }).frames, [{ type: "toast", level: "warning", message: "hi" }]);
	assert.deepEqual(P.translateEvent({ type: "extension_ui_request", id: "u6", method: "setWidget" }), { frames: [] });
	assert.deepEqual(P.translateEvent({ type: "extension_ui_request", id: "bad id!", method: "input" }), { frames: [] });
});

test("buildUiResponse validates against the pending ask", () => {
	const sel = { id: "u1", kind: "select", options: ["a"] };
	assert.deepEqual(P.buildUiResponse(sel, { value: "a" }), { type: "extension_ui_response", id: "u1", value: "a" });
	assert.equal(P.buildUiResponse(sel, { value: "zzz" }), undefined);
	assert.equal(P.buildUiResponse({ id: "c", kind: "confirm", options: [] }, { value: "yes" }), undefined);
	assert.deepEqual(P.buildUiResponse(sel, { cancelled: true }), { type: "extension_ui_response", id: "u1", cancelled: true });
});

test("DTO sanitizers drop everything outside the allowlist", () => {
	const dirty = { accountId: "a", label: "L", provider: "p", authMethod: "api_key", configured: true, apiKey: "sk-LEAK", baseUrl: "http://x", headers: { a: "b" }, env: { K: "v" } };
	const profile = { id: "p", label: "P", role: "r", accountId: "a", provider: "p", modelId: "m", thinkingLevel: "low", apiKey: "sk-LEAK", baseUrl: "u" };
	const wire = JSON.stringify([
		P.accountsFrame([dirty]),
		P.providersFrame([{ id: "p", name: "P", methods: ["oauth", "x"], configured: true, token: "sk-LEAK" }]),
		P.modelsFrame([{ provider: "p", id: "m", name: "M", input: ["text", "x"], contextWindow: 9, baseUrl: "sk-LEAK" }]),
		P.profilesFrame({ profiles: [profile], active: "p" }, [{ role: "r", profileIds: ["p"], env: "sk-LEAK" }]),
	]);
	assert.ok(!wire.includes("sk-LEAK") && !wire.includes("baseUrl") && !wire.includes("headers"));
});

test("auth passthrough frames are allowlisted", () => {
	const prompt = P.authPromptFrame({ flowId: "f", promptId: "p", accountId: "a", kind: "secret", message: "m", secret: true, internalToken: "sk-LEAK" });
	const event = P.authEventFrame({ flowId: "f", kind: "url", url: "http://auth", cookie: "sk-LEAK" });
	const done = P.authDoneFrame({ flowId: "f", accountId: "a", ok: true, account: { accountId: "a", label: "L", provider: "p", authMethod: "oauth", configured: true, refresh: "sk-LEAK" } });
	assert.ok(!JSON.stringify([prompt, event, done]).includes("sk-LEAK"));
	assert.equal(prompt.secret, true);
});

// ----- v0.2: provider settings frames ---------------------------------------

const PROFILE = { id: "work", label: "Work", role: "main", accountId: "acct", provider: "anthropic", modelId: "claude-x", thinkingLevel: "high" };

test("v0.2 client frames: valid ones are rebuilt, unknown fields dropped", () => {
	const dec = (v) => P.decodeClientLine(line(v)).frame;
	assert.deepEqual(dec({ type: "account_create", provider: "openai", label: "Mine", extra: 1 }), { type: "account_create", provider: "openai", label: "Mine" });
	assert.deepEqual(dec({ type: "account_create", provider: "openai", label: "Mine", accountId: "mine-1" }), { type: "account_create", provider: "openai", label: "Mine", accountId: "mine-1" });
	for (const type of ["account_remove", "account_logout", "account_status"]) {
		assert.deepEqual(dec({ type, accountId: "mine-1", x: 1 }), { type, accountId: "mine-1" });
	}
	assert.deepEqual(dec({ type: "profile_save", ...PROFILE, apiKey: "sk-LEAK" }), { type: "profile_save", ...PROFILE });
	const { thinkingLevel, ...noLevel } = PROFILE;
	assert.deepEqual(dec({ type: "profile_save", ...noLevel }), { type: "profile_save", ...noLevel });
	assert.deepEqual(dec({ type: "profile_remove", id: "work", z: 1 }), { type: "profile_remove", id: "work" });
	assert.deepEqual(dec({ type: "profile_deactivate", id: "work" }), { type: "profile_deactivate" });
	assert.deepEqual(dec({ type: "auth_state", flowId: "f" }), { type: "auth_state" });
});

test("v0.2 client frames: reject matrix", () => {
	const bad = [
		{ type: "account_create", provider: "OpenAI", label: "x" },
		{ type: "account_create", provider: "openai", label: "" },
		{ type: "account_create", provider: "openai", label: "   " },
		{ type: "account_create", provider: "openai", label: "a\nb" },
		{ type: "account_create", provider: "openai", label: "a\tb" },
		{ type: "account_create", provider: "openai", label: "x".repeat(81) },
		{ type: "account_create", provider: "openai", label: "ok", accountId: "../x" },
		{ type: "account_create", label: "ok" },
		{ type: "account_remove", accountId: "A B" },
		{ type: "account_logout" },
		{ type: "account_status", accountId: 5 },
		{ ...PROFILE, type: "profile_save", id: "../x" },
		{ ...PROFILE, type: "profile_save", label: "" },
		{ ...PROFILE, type: "profile_save", role: "Bad Role" },
		{ ...PROFILE, type: "profile_save", accountId: "Nope!" },
		{ ...PROFILE, type: "profile_save", provider: "" },
		{ ...PROFILE, type: "profile_save", modelId: "" },
		{ ...PROFILE, type: "profile_save", modelId: "m\u0000" },
		{ ...PROFILE, type: "profile_save", modelId: "m".repeat(201) },
		{ ...PROFILE, type: "profile_save", thinkingLevel: "ultra" },
		{ type: "profile_remove", id: "Bad Id" },
		{ type: "profile_remove" },
	];
	for (const frame of bad) assert.deepEqual(P.decodeClientLine(line(frame)), { error: "bad_request" }, JSON.stringify(frame));
	assert.ok(P.decodeClientLine(line({ ...PROFILE, type: "profile_save", modelId: "m".repeat(200) })).frame);
});

test("v0.2 server frames: account and auth_state are rebuilt from allowlists", () => {
	assert.deepEqual(P.accountFrame({ accountId: "a", label: "L", provider: "p", authMethod: "api_key", configured: true, apiKey: "sk-LEAK", baseUrl: "x" }), {
		type: "account",
		account: { accountId: "a", label: "L", provider: "p", authMethod: "api_key", configured: true },
	});
	assert.deepEqual(P.authStateFrame(undefined), { type: "auth_state", flow: null });
	assert.deepEqual(P.authStateFrame({ flowId: "f", accountId: "a", method: "oauth", phase: "prompt", value: "sk-LEAK" }), {
		type: "auth_state",
		flow: { flowId: "f", accountId: "a", method: "oauth", phase: "prompt" },
	});
	assert.deepEqual(P.authStateFrame({ flowId: "f", accountId: "a", method: "oauth", phase: "weird" }), { type: "auth_state", flow: null });
});

test("profile modelId round-trips at 190 chars (save bound and DTO clip agree)", () => {
	const modelId = "m".repeat(190);
	assert.ok(P.decodeClientLine(line({ ...PROFILE, type: "profile_save", modelId })).frame);
	const frame = P.profilesFrame({ profiles: [{ ...PROFILE, modelId }], active: "work" }, []);
	assert.equal(frame.profiles[0].modelId, modelId);
});

test("settings frames: settings_get/settings_set are rebuilt from an allowlist", () => {
	assert.deepEqual(P.decodeClientLine(line({ type: "settings_get", junk: 1 })).frame, { type: "settings_get" });
	assert.deepEqual(P.decodeClientLine(line({ type: "settings_set", hotkey: "Ctrl+Alt+Space", junk: 1 })).frame, { type: "settings_set", hotkey: "Ctrl+Alt+Space" });
	assert.deepEqual(P.decodeClientLine(line({ type: "settings_set", hotkey: null })).frame, { type: "settings_set", hotkey: null });
	// Grammar is validated by the server/config, the codec only bounds the type and length.
	for (const bad of [{ type: "settings_set" }, { type: "settings_set", hotkey: 5 }, { type: "settings_set", hotkey: {} }, { type: "settings_set", hotkey: "x".repeat(41) }]) {
		assert.deepEqual(P.decodeClientLine(line(bad)), { error: "bad_request" }, JSON.stringify(bad));
	}
});

test("settingsFrame: hotkey string or null only", () => {
	assert.deepEqual(P.settingsFrame({ hotkey: "Ctrl+Alt+Space", extra: "x" }), { type: "settings", hotkey: "Ctrl+Alt+Space" });
	assert.deepEqual(P.settingsFrame({}), { type: "settings", hotkey: null });
	assert.deepEqual(P.settingsFrame({ hotkey: 5 }), { type: "settings", hotkey: null });
	assert.deepEqual(P.settingsFrame(undefined), { type: "settings", hotkey: null });
});

// ----- connectors_list / connectors (V4) ---------------------------------------

const fsC = require("node:fs");
const pathC = require("node:path");
const GOLD = (name) => JSON.parse(fsC.readFileSync(pathC.join(__dirname, "fixtures", "connectors", `${name}.json`), "utf8"));

test("connectors_list: no fields; extras are dropped", () => {
	assert.deepEqual(P.decodeClientLine(line({ type: "connectors_list" })).frame, { type: "connectors_list" });
	assert.deepEqual(P.decodeClientLine(line({ type: "connectors_list", dir: "/etc", command: "sh" })).frame, { type: "connectors_list" });
});

test("connectorsFrame rebuilds the golden data and drops everything off-allowlist", () => {
	const data = { catalog: GOLD("catalog").entries, connectors: GOLD("status").connectors };
	const frame = P.connectorsFrame(data);
	assert.deepEqual(frame, { type: "connectors", schema: "abito-connectors/view/1", catalog: data.catalog, connectors: data.connectors });
	const dirty = structuredClone(data);
	dirty.catalog[0].url = "https://SECRETMARK";
	dirty.connectors[0].token = "SECRETMARK";
	dirty.connectors[0].status.env = { A: "SECRETMARK" };
	dirty.capability = "SECRETMARK";
	assert.ok(!JSON.stringify(P.connectorsFrame(dirty)).includes("SECRETMARK"));
	assert.deepEqual(Object.keys(P.connectorsFrame(dirty)).sort(), ["catalog", "connectors", "schema", "type"]);
});

test("connectorsFrame throws on invalid data (the server turns it into error{failed})", () => {
	assert.throws(() => P.connectorsFrame(undefined));
	assert.throws(() => P.connectorsFrame({ catalog: "x", connectors: [] }));
	assert.throws(() => P.connectorsFrame({ catalog: [], connectors: [{ id: "a" }] }));
});

test("R3: connectorsFrame emission caps: 128 realistic ok, 129 or >200 KiB serialized -> throws", () => {
	const c = GOLD("status").connectors[0];
	const mk = (n) => Array.from({ length: n }, (_, i) => ({ ...c, id: `c${i}` }));
	assert.equal(P.connectorsFrame({ catalog: GOLD("catalog").entries, connectors: mk(128) }).connectors.length, 128);
	assert.throws(() => P.connectorsFrame({ catalog: GOLD("catalog").entries, connectors: mk(129) }));
	assert.throws(() => P.connectorsFrame({ catalog: GOLD("catalog").entries, connectors: mk(256) }));
	// worst legal catalog: 32 entries x 8 fields x 16 steps of max text
	const big = { key: "k", label: "l".repeat(128), reads: "r".repeat(512), sends: "s".repeat(512), auth: "none", read_only_tools_count: 1,
		fields: Array.from({ length: 8 }, (_, i) => ({ key: `f${i}`, label: "x".repeat(128), secret: false, optional: false })),
		guide: { steps: Array.from({ length: 16 }, () => "g".repeat(512)), note: "n".repeat(512) } };
	const catalog = Array.from({ length: 32 }, (_, i) => ({ ...big, key: `k${i}` }));
	assert.throws(() => P.connectorsFrame({ catalog, connectors: [] }));
});

// ----- V5: local OpenAI-compatible endpoint (loopback only) -----------------------

test("validateLocalBaseUrl: loopback http(s) with explicit full path only", () => {
	const ok = {
		"http://localhost:11434/v1": "http://localhost:11434/v1",
		"http://127.0.0.1:11434/v1": "http://127.0.0.1:11434/v1",
		"http://127.1.2.3:8080/v1/": "http://127.1.2.3:8080/v1/",
		"http://[::1]:1234/v1": "http://[::1]:1234/v1",
		"https://localhost/v1": "https://localhost/v1",
		"http://127.0.0.1:80/v1": "http://127.0.0.1/v1",
		"HTTP://LocalHost:8000/api/v1.2": "http://localhost:8000/api/v1.2",
	};
	for (const [input, href] of Object.entries(ok)) assert.equal(P.validateLocalBaseUrl(input), href, input);
	const bad = [
		"https://evil.com/v1", "http://10.0.0.5/v1", "http://user:pw@127.0.0.1/v1", "http://:pw@127.0.0.1/v1", "http://127.0.0.1/v1?q=1",
		"http://127.0.0.1/v1?", "http://127.0.0.1/v1#f", "http://2130706433/v1", "http://0x7f.1/v1", "http://0x7f000001/v1", "http://0177.0.0.1/v1",
		"http://[::ffff:127.0.0.1]/v1", "http://[::ffff:7f00:1]/v1", "http://0.0.0.0/v1", "http://localhost.evil.com/v1",
		"http://127.0.0.1.evil.com/v1", "http://127.0.0.1/v 1", "http://127.0.0.1/../x", "http://127.0.0.1/v1/../x", "http://127.0.0.1/v1//x",
		"http://127.0.0.1/%2e%2e/x", "http://127.0.0.1:0/v1", "http://127.0.0.1:65536/v1", "http://127.0.0.1:/v1", "http://127.0.0.1", "http://127.0.0.1:11434",
		"", "javascript:alert(1)", "ftp://127.0.0.1/v1", "file:///v1", "//127.0.0.1/v1", "http://127.0.0.1\\@evil.com/v1", "http://127.0.0.1/v1\n",
		" http://127.0.0.1/v1", "http://127.0.0.256/v1", "http://127.0.0.1/" + "a".repeat(200), 5, null, undefined, {}, ["http://127.0.0.1/v1"],
	];
	for (const input of bad) assert.equal(P.validateLocalBaseUrl(input), undefined, String(JSON.stringify(input)));
});

test("validateLocalModelIds: 1..32 ids of 1..200 printable chars", () => {
	assert.deepEqual(P.validateLocalModelIds(["qwen2.5-coder:7b", "a b"]), ["qwen2.5-coder:7b", "a b"]);
	assert.deepEqual(P.validateLocalModelIds(["a", "A", "a "]), ["a", "A", "a "]);
	assert.equal(P.validateClientFrame({ type: "local_endpoint_set", accountId: "o", baseUrl: "http://127.0.0.1:1/v1", modelIds: ["a", "a"] }), undefined);
	assert.equal(P.validateLocalModelIds(Array.from({ length: 32 }, (_, i) => `m${i}`)).length, 32);
	for (const bad of [[], Array.from({ length: 33 }, (_, i) => `m${i}`), [""], ["   "], ["a\nb"], ["a\u0000"], ["x".repeat(201)], [5], [null], ["a", "a"], ["a", "b", "a"], "m", undefined, { 0: "a", length: 1 }]) {
		assert.equal(P.validateLocalModelIds(bad), undefined, JSON.stringify(bad));
	}
});

test("local_account_create / local_endpoint_set frames are rebuilt from an allowlist", () => {
	const good = { type: "local_account_create", label: "Ollama", baseUrl: "HTTP://localhost:11434/v1", modelIds: ["m1"], junk: 1 };
	assert.deepEqual(P.validateClientFrame(good), { type: "local_account_create", label: "Ollama", baseUrl: "http://localhost:11434/v1", modelIds: ["m1"] });
	assert.equal(P.validateClientFrame({ ...good, accountId: "ollama" }).accountId, "ollama");
	for (const bad of [{ ...good, accountId: "Bad Id" }, { ...good, label: "a\nb" }, { ...good, label: "x".repeat(81) }, { ...good, baseUrl: "http://10.0.0.5/v1" }, { ...good, modelIds: [] }, { ...good, label: undefined }]) {
		assert.equal(P.validateClientFrame(bad), undefined);
	}
	const set = { type: "local_endpoint_set", accountId: "ollama", baseUrl: "http://127.0.0.1:1/v1", modelIds: ["a"] };
	assert.deepEqual(P.validateClientFrame(set), set);
	for (const bad of [{ ...set, accountId: "../x" }, { ...set, baseUrl: "https://evil.com/v1" }, { ...set, modelIds: [""] }, { ...set, accountId: undefined }]) {
		assert.equal(P.validateClientFrame(bad), undefined);
	}
});

test("account DTO adds local:true only for local accounts and never an endpoint", () => {
	assert.deepEqual(Object.keys(P.accountDto({ accountId: "a", label: "A", provider: "p", configured: true })).sort(), ["accountId", "authMethod", "configured", "label", "provider"]);
	const dto = P.accountDto({ accountId: "a", label: "A", provider: "local-a", configured: true, local: true, baseUrl: "http://127.0.0.1:1/v1", kind: "local" });
	assert.deepEqual(Object.keys(dto).sort(), ["accountId", "authMethod", "configured", "label", "local", "provider"]);
	assert.equal(dto.local, true);
});

// ----- agents_list / agent_connect / agent_disconnect / agents (H2b) -----------------

test("agents frames: closed agentId set, plan_hash 64 lowercase hex, unknown keys dropped", () => {
	const hash = "0123456789abcdef".repeat(4);
	assert.deepEqual(P.decodeClientLine(line({ type: "agents_list", x: 1 })).frame, { type: "agents_list" });
	for (const agentId of ["claude-code", "codex", "opencode"]) {
		assert.deepEqual(P.decodeClientLine(line({ type: "agent_connect", agentId, path: "/etc", cmd: "sh" })).frame, { type: "agent_connect", agentId });
		assert.deepEqual(P.decodeClientLine(line({ type: "agent_disconnect", agentId, plan_hash: hash })).frame, { type: "agent_disconnect", agentId });
	}
	assert.deepEqual(P.decodeClientLine(line({ type: "agent_connect", agentId: "codex", plan_hash: hash })).frame, { type: "agent_connect", agentId: "codex", plan_hash: hash });
	for (const bad of [
		{ type: "agent_connect" },
		{ type: "agent_connect", agentId: "claude" },
		{ type: "agent_connect", agentId: "Codex" },
		{ type: "agent_connect", agentId: ["codex"] },
		{ type: "agent_connect", agentId: "codex", plan_hash: hash.toUpperCase() },
		{ type: "agent_connect", agentId: "codex", plan_hash: hash.slice(1) },
		{ type: "agent_connect", agentId: "codex", plan_hash: hash + "0" },
		{ type: "agent_connect", agentId: "codex", plan_hash: null },
		{ type: "agent_connect", agentId: "codex", plan_hash: 5 },
		{ type: "agent_disconnect", agentId: "__proto__" },
	]) assert.equal(P.decodeClientLine(line(bad)).error, "bad_request", JSON.stringify(bad));
});

test("HU-047: agentsFrame carries the unsafe folder only with its closed reason and only for that detail", () => {
	const ok = { id: "pi", state: "error", backup: false, detail: "unsafe_folder", folder: "/home/u/.pi/agent/extensions", folder_reason: "writable" };
	const f = P.agentsFrame([ok]);
	assert.deepEqual([f.agents[0].folder, f.agents[0].folder_reason], [ok.folder, "writable"]);
	for (const bad of [{ folder_reason: "bogus" }, { folder: "a\nb" }, { folder: "" }, { folder: "x".repeat(401) }, { detail: "install_failed" }]) {
		const r = P.agentsFrame([{ ...ok, ...bad }]); // never throws: one odd folder must not break the whole agents list
		assert.deepEqual([r.agents[0].folder, r.agents[0].folder_reason], [undefined, undefined], JSON.stringify(bad).slice(0, 40));
	}
	assert.equal(P.agentsFrame([{ ...ok, folder: "é".repeat(400) }]).agents[0].folder.length, 400, "the limit counts characters, like the Rust side");
});

test("agentsFrame rebuilds from the closed vocabulary; nothing off-allowlist survives", () => {
	const hash = "ab".repeat(32);
	const frame = P.agentsFrame([
		{ id: "claude-code", name: "EVIL", state: "not_connected", backup: true, detail: null, plan_hash: hash, summary: "Adds the Abito hooks.", reviewable: true, trust_review: false, path: "/home/x", stderr: "SECRET" },
		{ id: "codex", name: "Codex", state: "error", backup: false, detail: "install_failed", token: "SECRET" },
		{ id: "opencode", name: "OpenCode", state: "unavailable", backup: false, detail: null },
	]);
	assert.equal(frame.type, "agents");
	assert.equal(frame.agents[0].name, "Claude Code", "names come from the fixed table");
	assert.deepEqual(Object.keys(frame.agents[0]).sort(), ["backup", "detail", "id", "name", "plan_hash", "reviewable", "state", "summary", "trust_review"]);
	assert.deepEqual(Object.keys(frame.agents[1]).sort(), ["backup", "detail", "id", "name", "state"]);
	assert.doesNotMatch(JSON.stringify(frame), /SECRET|\/home|EVIL/);
	// invalid pieces are rejected, never coerced
	assert.throws(() => P.agentsFrame([{ id: "x", state: "connected", backup: false, detail: null }]));
	assert.throws(() => P.agentsFrame([{ id: "codex", state: "weird", backup: false, detail: null }]));
	assert.throws(() => P.agentsFrame([{ id: "codex", state: "error", backup: false, detail: "stderr text" }]));
	assert.throws(() => P.agentsFrame([{ id: "codex", state: "not_connected", backup: false, detail: null, plan_hash: "nothex" }]));
	assert.throws(() => P.agentsFrame([{ id: "codex", state: "not_connected", backup: false, detail: null, summary: "a\u0000b" }]));
});

// ----- mcp_import_preview / mcp import preview (#381) --------------------------

const previewServer = (over = {}) => ({
	source: "cursor", name: "fs", transport: "stdio", command: "npx", status: "ready", ...over,
});

test("mcp_import_preview: no fields; extras are dropped", () => {
	assert.deepEqual(P.decodeClientLine(line({ type: "mcp_import_preview" })).frame, { type: "mcp_import_preview" });
	assert.deepEqual(P.decodeClientLine(line({ type: "mcp_import_preview", path: "/etc", command: "sh" })).frame, { type: "mcp_import_preview" });
});

test("mcpImportFrame rebuilds the preview and drops everything off-allowlist", () => {
	const data = {
		files: [{ source: "cursor", status: "ok" }, { source: "claude-code", status: "malformed" }],
		servers: [
			previewServer(),
			{ source: "claude-code", name: "n", scope: "/home/u/p", transport: "http", url: "https://x.example/mcp", status: "needs_setup", fields: [{ key: "env:TOKEN", label: "Environment variable TOKEN", secret: true, optional: false }] },
			{ source: "vscode", name: "old", status: "rejected", reason: "sse_transport" },
		],
		truncated: false,
	};
	const frame = P.mcpImportFrame(data);
	assert.deepEqual(frame, { type: "mcp_import", schema: "abito-mcp-import/preview/1", files: data.files, servers: data.servers, truncated: false });
	const dirty = structuredClone(data);
	dirty.servers[0].env = { A: "SECRETMARK" };
	dirty.servers[1].headers = { A: "SECRETMARK" };
	dirty.servers[2].args = ["SECRETMARK"];
	dirty.files[0].path = "/home/u/SECRETMARK";
	assert.ok(!JSON.stringify(P.mcpImportFrame(dirty)).includes("SECRETMARK"));
	assert.deepEqual(Object.keys(P.mcpImportFrame(dirty)).sort(), ["files", "schema", "servers", "truncated", "type"]);
});

test("mcpImportFrame throws on invalid data (the server turns it into error{failed})", () => {
	assert.throws(() => P.mcpImportFrame(undefined));
	assert.throws(() => P.mcpImportFrame({ files: "x", servers: [] }));
	assert.throws(() => P.mcpImportFrame({ files: [{ source: "nope", status: "ok" }], servers: [] }));
	assert.throws(() => P.mcpImportFrame({ files: [{ source: "cursor", status: "wat" }], servers: [] }));
	assert.throws(() => P.mcpImportFrame({ files: [], servers: [previewServer({ command: 3 })] }));
	assert.throws(() => P.mcpImportFrame({ files: [], servers: [previewServer({ status: "weird" })] }));
	assert.throws(() => P.mcpImportFrame({ files: [], servers: [previewServer({ transport: "ftp" })] }));
	// rejected entries carry a closed reason and no transport detail
	assert.throws(() => P.mcpImportFrame({ files: [], servers: [{ source: "cursor", name: "a", status: "rejected" }] }));
	assert.throws(() => P.mcpImportFrame({ files: [], servers: [{ source: "cursor", name: "a", status: "rejected", reason: "h4x", transport: "stdio", command: "x" }] }));
	assert.throws(() => P.mcpImportFrame({ files: [], servers: [previewServer({ fields: [{ key: "a b", label: "l", secret: true, optional: false }] })] }));
	// ready entries must not carry fields or reasons
	assert.throws(() => P.mcpImportFrame({ files: [], servers: [previewServer({ fields: [] })] }));
	assert.throws(() => P.mcpImportFrame({ files: [], servers: [previewServer({ reason: "invalid_entry" })] }));
});

test("set_paused: required boolean; extras dropped; error code `paused` is in the closed set", () => {
	assert.deepEqual(P.decodeClientLine(line({ type: "set_paused", paused: true, junk: 1 })).frame, { type: "set_paused", paused: true });
	assert.deepEqual(P.decodeClientLine(line({ type: "set_paused", paused: false })).frame, { type: "set_paused", paused: false });
	for (const bad of [{ type: "set_paused" }, { type: "set_paused", paused: "true" }, { type: "set_paused", paused: 1 }, { type: "set_paused", paused: null }, { type: "set_paused", paused: {} }]) {
		assert.deepEqual(P.decodeClientLine(line(bad)), { error: "bad_request" }, JSON.stringify(bad));
	}
	assert.deepEqual(P.errorFrame("paused"), { type: "error", code: "paused" });
	assert.deepEqual(P.errorFrame("store_not_private"), { type: "error", code: "store_not_private" });
});

test("mcpImportFrame emission caps: 128 servers ok, 129 or >200 KiB serialized -> throws", () => {
	const mk = (n) => Array.from({ length: n }, (_, i) => previewServer({ name: `s${i}` }));
	assert.equal(P.mcpImportFrame({ files: [], servers: mk(128), truncated: true }).servers.length, 128);
	assert.throws(() => P.mcpImportFrame({ files: [], servers: mk(129) }));
	// 128 worst-case entries (scope + url + 16 max-size fields) exceed the byte cap
	const big = {
		source: "claude-code", name: "n".repeat(128), scope: "/".repeat(256), transport: "http",
		url: `https://x/${"u".repeat(940)}`, status: "needs_setup",
		fields: Array.from({ length: 16 }, (_, i) => ({ key: `f${i}`.padEnd(6, "x"), label: "l".repeat(128), secret: true, optional: false })),
	};
	assert.throws(() => P.mcpImportFrame({ files: [], servers: Array.from({ length: 128 }, (_, i) => ({ ...big, name: `${big.name.slice(0, 120)}${i}` })) }));
});

// ----- sessions_list / sessions (#360, F046/F049) -------------------------------

const sessionRow = (over = {}) => ({ id: "s-0123abcd", kind: "pi", cwd: "mi-proyecto", state: "sleeping", origin: "tmux", ...over });

test("sessions_list: no fields; extras are dropped", () => {
	assert.deepEqual(P.decodeClientLine(line({ type: "sessions_list" })).frame, { type: "sessions_list" });
	assert.deepEqual(P.decodeClientLine(line({ type: "sessions_list", cwd: "/etc", env: "x" })).frame, { type: "sessions_list" });
});

test("sessionsFrame rebuilds rows from the closed vocabulary; nothing off-allowlist survives", () => {
	const data = { sessions: [sessionRow(), sessionRow({ id: "s-ffffffff", kind: "claude-code", cwd: null, origin: null })], truncated: false };
	const frame = P.sessionsFrame(data);
	assert.deepEqual(frame, { type: "sessions", schema: "abito-sessions/view/1", sessions: data.sessions, truncated: false });
	const dirty = structuredClone(data);
	dirty.sessions[0].cmdline = "SECRETMARK";
	dirty.sessions[0].env = { A: "SECRETMARK" };
	dirty.sessions[0].cwdFull = "/home/SECRETMARK";
	dirty.pidSeed = 1;
	assert.ok(!JSON.stringify(P.sessionsFrame(dirty)).includes("SECRETMARK"));
	assert.deepEqual(Object.keys(P.sessionsFrame(dirty)).sort(), ["schema", "sessions", "truncated", "type"]);
});

test("sessionsFrame throws on invalid data (the server turns it into error{failed})", () => {
	assert.throws(() => P.sessionsFrame(undefined));
	assert.throws(() => P.sessionsFrame({ sessions: "x", truncated: false }));
	assert.throws(() => P.sessionsFrame({ sessions: [{ id: "nope", kind: "pi", cwd: "a", state: "sleeping", origin: null }], truncated: false }));
	assert.throws(() => P.sessionsFrame({ sessions: [sessionRow({ kind: "bash" })], truncated: false }));
	assert.throws(() => P.sessionsFrame({ sessions: [sessionRow({ state: "dancing" })], truncated: false }));
	assert.throws(() => P.sessionsFrame({ sessions: [sessionRow({ cwd: "/full/path" })], truncated: false }));
	assert.throws(() => P.sessionsFrame({ sessions: [sessionRow({ origin: "herdr\npane" })], truncated: false }));
	assert.throws(() => P.sessionsFrame({ sessions: [sessionRow()], truncated: "yes" }));
	assert.throws(() => P.sessionsFrame({ sessions: [sessionRow()], truncated: undefined }));
});

test("sessionsFrame emission caps: 64 sessions ok, 65 -> throws; the worst legal frame stays under the byte cap", () => {
	const mk = (n) => Array.from({ length: n }, (_, i) => sessionRow({ id: `s-${String(i).padStart(8, "0")}`, cwd: "d".repeat(64), origin: "o".repeat(32) }));
	assert.equal(P.sessionsFrame({ sessions: mk(64), truncated: true }).sessions.length, 64);
	assert.throws(() => P.sessionsFrame({ sessions: mk(65) }));
	// 64 worst-case rows (~11 KiB serialized) can never exceed the 64 KiB byte cap: it is
	// defense in depth against a dependency that ignores the row cap, not the row bound.
	const worst = P.sessionsFrame({
		sessions: Array.from({ length: 64 }, (_, i) => sessionRow({ id: `s-${String(i).padStart(8, "0")}`, cwd: "d".repeat(64), origin: "o".repeat(32), kind: "claude-code" })),
		truncated: false,
	});
	assert.ok(Buffer.byteLength(JSON.stringify(worst)) < P.SESSIONS_EMIT.maxFrameBytes);
});

test("sessionsFrame carries the total only when truncated, and only a sane integer", () => {
	const rows = P.sessionsFrame({ sessions: [], truncated: false }).sessions;
	assert.deepEqual(rows, []);
	assert.equal("total" in P.sessionsFrame({ sessions: [], truncated: false, total: 99 }), false, "not truncated: no total");
	const many = Array.from({ length: 64 }, (_, i) => ({ id: `s-${i.toString(16).padStart(8, "0")}`, kind: "pi", cwd: null, state: "running", origin: null }));
	assert.equal(P.sessionsFrame({ sessions: many, truncated: true, total: 70 }).total, 70);
	assert.equal("total" in P.sessionsFrame({ sessions: many, truncated: true }), false, "truncated without a total: honest, absent");
	for (const bad of [63, 4097, -1, 70.5, "70", NaN, null]) assert.throws(() => P.sessionsFrame({ sessions: many, truncated: true, total: bad }), /sessions frame invalid/, String(bad));
});

test("custom_account_create / custom_endpoint_set / custom_models_refresh frames are rebuilt from an allowlist", () => {
	const good = { type: "custom_account_create", label: "Gateway", baseUrl: "https://Gateway.example/v1/", junk: 1, apiKey: "sk-x" };
	assert.deepEqual(P.validateClientFrame(good), { type: "custom_account_create", label: "Gateway", baseUrl: "https://gateway.example/v1" });
	assert.equal(P.validateClientFrame({ ...good, accountId: "gw" }).accountId, "gw");
	for (const bad of [{ ...good, accountId: "Bad Id" }, { ...good, label: "a\nb" }, { ...good, baseUrl: "http://gateway.example/v1" }, { ...good, baseUrl: "https://u:p@gateway.example/v1" }, { ...good, baseUrl: undefined }]) {
		assert.equal(P.validateClientFrame(bad), undefined);
	}
	const set = { type: "custom_endpoint_set", accountId: "gw", baseUrl: "http://127.0.0.1:4000/v1" };
	assert.deepEqual(P.validateClientFrame(set), set);
	for (const bad of [{ ...set, accountId: "../x" }, { ...set, baseUrl: "https://gateway.example/v1?x=1" }, { ...set, accountId: undefined }]) {
		assert.equal(P.validateClientFrame(bad), undefined);
	}
	assert.deepEqual(P.validateClientFrame({ type: "custom_models_refresh", accountId: "gw", baseUrl: "https://evil.example/v1" }), { type: "custom_models_refresh", accountId: "gw" });
	assert.equal(P.validateClientFrame({ type: "custom_models_refresh", accountId: "../x" }), undefined);
});

test("account DTO adds custom:true only for custom accounts and never a Base URL or key", () => {
	const dto = P.accountDto({ accountId: "a", label: "A", provider: "custom-a", configured: true, custom: true, baseUrl: "https://gateway.example/v1", apiKey: "sk-x" });
	assert.deepEqual(Object.keys(dto).sort(), ["accountId", "authMethod", "configured", "custom", "label", "provider"]);
	assert.equal(JSON.stringify(dto).includes("gateway.example"), false);
	assert.equal("custom" in P.accountDto({ accountId: "a", label: "A", provider: "p", configured: true }), false);
	assert.equal("custom" in P.accountDto({ accountId: "a", label: "A", provider: "p", configured: true, custom: "yes" }), false);
});
