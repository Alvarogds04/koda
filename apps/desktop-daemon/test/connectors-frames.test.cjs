"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const P = require("../src/protocol.cjs");
const { IslandServer } = require("../src/server.cjs");
const { ConnectorsControlError } = require("../src/connectors.cjs");

const proposal = "ap-0123456789abcdef0123456789ab";
const digest = "a".repeat(64);
const commandFrames = [
	{ type: "connectors_pending" },
	{ type: "connectors_approve", proposal_id: proposal, digest: digest.toUpperCase() },
	{ type: "connectors_deny", proposal_id: proposal },
	{ type: "connectors_connect", connector_id: "notion" },
	{ type: "connectors_disconnect", connector_id: "notion" },
	{ type: "connectors_mode", connector_id: "notion", mode: "read_only" },
];

test("connector command validators rebuild six snake_case frames and reject secrets and bad ids", () => {
	for (const frame of commandFrames) assert.ok(P.validateClientFrame(frame), frame.type);
	assert.equal(P.validateClientFrame(commandFrames[1]).digest, digest);
	for (const type of ["connectors_approve", "connectors_deny"]) {
		assert.equal(P.validateClientFrame({ ...commandFrames.find((f) => f.type === type), proposal_id: "bad" }), undefined);
	}
	for (const frame of [
		{ type: "connectors_connect", connector_id: "__proto__" },
		{ type: "connectors_connect", connector_id: "constructor" },
		{ type: "connectors_disconnect", connector_id: "bad id" },
		{ type: "connectors_mode", connector_id: "x", mode: "send_all" },
		{ type: "connectors_approve", proposal_id: proposal, digest: "a".repeat(63) },
		{ type: "connectors_approve", proposal_id: proposal, digest: "g".repeat(64) },
		{ type: "connectors_connect", connector_id: "x", values: { token: "CANARY" } },
		{ type: "connectors_connect", connector_id: "x", secrets: {} },
		{ type: "connectors_connect", connector_id: "x", fields: {} },
		{ type: "connectors_connect", connector_id: "x", token: "CANARY" },
		{ type: "connectors_connect", connector_id: "x", password: "CANARY" },
		{ type: "connectors_deny", proposal_id: `${proposal}${"g".repeat(40)}` },
	]) assert.equal(P.validateClientFrame(frame), undefined, JSON.stringify(frame));
	const rebuilt = P.validateClientFrame({ ...commandFrames[0], ignored: "dropped" });
	assert.deepEqual(rebuilt, { type: "connectors_pending" });
	assert.deepEqual(P.validateClientFrame({ ...commandFrames[3], ignored: "dropped" }), commandFrames[3]);
});

test("pendingFrame rebuilds bounded entries, sanitizes honestly, caps at 64, and rejects invalid data", () => {
	const item = {
		proposal_id: proposal, connector_id: "notion", connector_label: "Notion", connector_label_truncated: false,
		tool: "search", arguments_preview: "ok\n\u0001\u000f\u000e", arguments_truncated: false,
		arguments_sensitive: true, digest, expires_in_ms: 30000, secret: "DROP",
	};
	const frame = P.pendingFrame({ items: [item], extra: "DROP" });
	assert.deepEqual(frame.items[0], {
		proposal_id: proposal, connector_id: "notion", connector_label: "Notion", connector_label_truncated: false,
		tool: "search", arguments_preview: "ok", arguments_truncated: true, arguments_sensitive: true, digest, expires_in_ms: 30000,
	});
	assert.equal(Object.keys(frame).sort().join(), "items,type");
	assert.equal(frame.items[0].secret, undefined);
	const clippedLabel = P.pendingFrame({ items: [{ ...item, connector_label: "L".repeat(129) }] }).items[0];
	assert.equal(clippedLabel.connector_label.length, 128);
	assert.equal(clippedLabel.connector_label_truncated, true);
	assert.equal(P.pendingFrame({ items: Array.from({ length: 64 }, () => item) }).items.length, 64);
	assert.throws(() => P.pendingFrame({ items: Array.from({ length: 65 }, () => item) }));
	for (const bad of [
		{ ...item, digest: "bad" }, { ...item, expires_in_ms: -1 }, { ...item, connector_label_truncated: 1 },
		{ ...item, arguments_preview: "x".repeat(513) }, { ...item, tool: "" }, { ...item, arguments_sensitive: false },
	]) assert.throws(() => P.pendingFrame({ items: [bad] }));
});

test("connectorsFrame emits live only for host data; connector auth builders stay additive", () => {
	const data = { catalog: [], connectors: [] };
	assert.equal("live" in P.connectorsFrame(data), false);
	assert.equal(P.connectorsFrame({ ...data, live: true }).live, true);
	assert.throws(() => P.connectorsFrame({ ...data, live: 1 }));
	assert.deepEqual(P.authPromptFrame({ flowId: "f", promptId: "p", accountId: "a", kind: "secret", message: "Key", secret: true }), {
		type: "auth_prompt", flowId: "f", promptId: "p", accountId: "a", kind: "secret", message: "Key", secret: true,
	});
	const prompt = P.authPromptFrame({ flowId: "connector-setup-0123456789abcdef", promptId: "p", accountId: "", connector_id: "notion", kind: "secret", message: "Token", secret: true, optional: false });
	assert.equal(prompt.connector_id, "notion");
	assert.equal(prompt.optional, false);
	const done = P.authDoneFrame({ flowId: "connector-setup-0123456789abcdef", accountId: "", connector_id: "notion", ok: false, message: "needs_setup" });
	assert.equal(done.connector_id, "notion");
	assert.equal(done.message, "needs_setup");
});

class Engine extends EventEmitter {
	constructor() { super(); this.status = "ready"; this.requests = []; this.sent = []; }
	async request(value) { this.requests.push(value); }
	send(value) { this.sent.push(value); }
}
class Control extends EventEmitter {
	constructor() { super(); this.calls = []; }
	async pending() { this.calls.push(["pending"]); return []; }
	async approve(...args) { this.calls.push(["approve", ...args]); this.emit("pending", []); this.emit("connectors", { catalog: [], connectors: [], live: true }); }
	async deny(...args) { this.calls.push(["deny", ...args]); this.emit("pending", []); this.emit("connectors", { catalog: [], connectors: [], live: true }); }
	async connect(...args) { this.calls.push(["connect", ...args]); return { flowId: "connector-setup-0123456789abcdef" }; }
	async disconnect(...args) { this.calls.push(["disconnect", ...args]); this.emit("connectors", { catalog: [], connectors: [], live: true }); }
	async setMode(...args) { this.calls.push(["setMode", ...args]); this.emit("connectors", { catalog: [], connectors: [], live: true }); }
	isSetupFlow(id) { return id.startsWith("connector-setup-"); }
	async reply(...args) { this.calls.push(["reply", ...args]); }
	async cancel(...args) { this.calls.push(["cancel", ...args]); }
}

function runtime(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abito-connector-frames-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return path.join(dir, "runtime");
}
function socket(endpoint) {
	const client = net.connect(endpoint);
	const result = { client, frames: [], buffer: "" };
	client.setEncoding("utf8");
	client.on("data", (chunk) => {
		result.buffer += chunk;
		let at;
		while ((at = result.buffer.indexOf("\n")) >= 0) {
			result.frames.push(JSON.parse(result.buffer.slice(0, at)));
			result.buffer = result.buffer.slice(at + 1);
		}
	});
	client.on("error", () => {});
	result.send = (frame) => client.write(`${JSON.stringify(frame)}\n`);
	return result;
}
async function until(fn) {
	const end = Date.now() + 3000;
	while (Date.now() < end) { if (fn()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
	assert.ok(fn(), "timed out waiting for connector frame");
}
async function login(t, server) {
	const c = socket(server.endpoint);
	t.after(() => c.client.destroy());
	await new Promise((resolve) => c.client.once("connect", resolve));
	c.send({ type: "hello", protocol: P.PROTOCOL, token: "t".repeat(43) });
	await until(() => c.frames.some((f) => f.type === "ready"));
	return c;
}

test("IslandServer routes six commands, broadcasts mutations, isolates auth flows, and drops control listeners", async (t) => {
	const engine = new Engine();
	const accounts = { replied: [], cancelled: [], async reply(...args) { this.replied.push(args); }, async cancel(...args) { this.cancelled.push(args); } };
	const control = new Control();
	const server = new IslandServer({ runtimeDir: runtime(t), token: "t".repeat(43), engine, accounts, connectorsControl: control });
	await server.start();
	t.after(() => server.close());
	const a = await login(t, server);
	const b = await login(t, server);
	const start = a.frames.length;
	for (const frame of commandFrames) a.send(frame);
	await until(() => control.calls.length >= 6 && a.frames.some((f) => f.type === "auth_started"));
	await until(() => b.frames.some((f) => f.type === "connectors"));
	control.emit("auth_prompt", { flowId: "connector-setup-0123456789abcdef", promptId: "p", accountId: "", connector_id: "notion", kind: "secret", message: "Token", secret: true, optional: true });
	control.emit("auth_done", { flowId: "connector-setup-0123456789abcdef", accountId: "", connector_id: "notion", ok: false, message: "needs_setup" });
	await until(() => a.frames.some((f) => f.type === "auth_prompt") && b.frames.some((f) => f.type === "auth_prompt") && a.frames.some((f) => f.type === "auth_done") && b.frames.some((f) => f.type === "auth_done"));
	assert.ok(a.frames.slice(start).some((f) => f.type === "pending"));
	assert.deepEqual(control.calls.slice(0, 5).map((c) => c[0]), ["pending", "approve", "deny", "connect", "disconnect"]);
	assert.ok(control.calls.some((c) => c[0] === "setMode"));
	assert.equal(a.frames.filter((f) => f.type === "error").length, 0);
	const before = control.calls.length;
	a.send({ type: "auth_reply", flowId: "connector-setup-0123456789abcdef", promptId: "p", value: "SENSITIVE-CANARY" });
	a.send({ type: "auth_reply", flowId: "account-flow", promptId: "q", value: "ACCOUNT-CANARY" });
	a.send({ type: "auth_cancel", flowId: "connector-setup-0123456789abcdef" });
	a.send({ type: "auth_cancel", flowId: "account-flow" });
	await until(() => control.calls.length >= before + 2 && accounts.replied.length === 1 && accounts.cancelled.length === 1);
	assert.equal(accounts.replied[0][1].value, "ACCOUNT-CANARY");
	assert.equal(control.calls.some((c) => c[0] === "reply" && c[3] === "SENSITIVE-CANARY"), true);
	const wire = JSON.stringify([...a.frames, ...b.frames]);
	assert.ok(!wire.includes("CANARY") && !wire.includes("/home/") && !wire.includes("connector-host-run") && !wire.includes('"token"'));
	const canary = "WIRE-CANARY";
	const badFrom = a.frames.length;
	a.send({ type: "connectors_connect", connector_id: "notion", values: { token: canary } });
	await until(() => a.frames.slice(badFrom).some((f) => f.type === "error"));
	assert.equal(a.frames.slice(badFrom).find((f) => f.type === "error").code, "bad_request");
	assert.ok(!JSON.stringify([...a.frames, ...b.frames]).includes(canary));
	assert.ok(!control.calls.some((call) => JSON.stringify(call).includes(canary)));
	assert.equal([...a.frames, ...b.frames].some((frame) => frame.type === "result"), false, "control actions have no bare ack");
	await server.close();
	assert.equal(control.listenerCount("pending"), 0);
	assert.equal(control.listenerCount("connectors"), 0);
});

test("connector controls are unavailable without a dependency and remain per-client rate limited", async (t) => {
	const server = new IslandServer({ runtimeDir: runtime(t), token: "t".repeat(43), engine: new Engine() });
	await server.start();
	t.after(() => server.close());
	const c = await login(t, server);
	for (const frame of commandFrames) c.send(frame);
	await until(() => c.frames.filter((f) => f.type === "error" && f.code === "unavailable").length === 6);
	const limited = new IslandServer({ runtimeDir: runtime(t), token: "t".repeat(43), engine: new Engine(), limits: { framesPerMinute: 3 } });
	await limited.start();
	t.after(() => limited.close());
	const d = await login(t, limited);
	d.send({ type: "connectors_pending" });
	d.send({ type: "connectors_pending" });
	d.send({ type: "connectors_pending" });
	await until(() => d.client.destroyed || limited.clients.size === 0);
});

test("connector errors separate emitted codes from host-reserved codes", async () => {
	for (const code of ["unknown_proposal", "digest_mismatch", "needs_setup", "signin_failed"]) {
		assert.equal(P.errorFrame(code).code, code);
	}
	for (const code of ["already_decided", "session_mismatch", "pending_full"]) {
		assert.equal(P.errorFrame(code).code, "failed");
		assert.equal(P.authDoneFrame({ flowId: "connector-setup-0123456789abcdef", accountId: "", connector_id: "notion", ok: false, message: code }).message, "failed");
		assert.equal(new ConnectorsControlError(code).code, "failed");
	}
	const err = new ConnectorsControlError("digest_mismatch");
	assert.equal(err.code, "digest_mismatch");
	assert.equal(err.message.includes("secret"), false);
});
