"use strict";

// U3 server tests: fake engine/accounts/profiles + a real Unix socket in a temp dir.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const { IslandServer } = require("../src/server.cjs");
const P = require("../src/protocol.cjs");

const TOKEN = "t".repeat(43);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 3000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (fn()) return;
		await sleep(5);
	}
	assert.ok(fn(), "waitFor timed out");
}

class FakeEngine extends EventEmitter {
	constructor() {
		super();
		this.status = "ready";
		this.requests = [];
		this.sent = [];
		this.hold = false;
		// #378 fake turn lifecycle: agent_start events open a turn, interruptTurn
		// closes it; stuckAfterInterrupt models a cutoff whose safe point never
		// arrives (busy stays true).
		this.turnActive = false;
		this.interruptedWith = undefined;
		this.stuckAfterInterrupt = false;
	}
	/** Intercepts fake agent records to track the turn lifecycle without registering a listener. */
	emit(type, payload) {
		if (type === "event") {
			if (payload?.type === "agent_start") this.turnActive = true;
			if (payload?.type === "agent_settled") this.turnActive = false;
		}
		return super.emit(type, payload);
	}
	async request(command) {
		this.requests.push(command);
		if (command.type === "prompt") {
			this.turnActive = true;
			if (this.hold) await new Promise(() => {});
		}
		return { type: "response", success: true };
	}
	interruptTurn(reason) {
		this.interruptedWith = reason;
		if (this.turnActive !== true) return false;
		this.turnActive = false;
		this.emit("turn_cancelled", { reason });
		if (this.stuckAfterInterrupt !== true) this.emit("event", { type: "agent_settled" });
		return true;
	}
	send(record) {
		this.sent.push(record);
	}
}
class FakeAccounts extends EventEmitter {
	listAccounts() {
		return [{ accountId: "main", label: "Main", provider: "p", authMethod: "api_key", configured: true, apiKey: "sk-SECRETMARK" }];
	}
	async providers() {
		return [{ id: "p", name: "P", methods: ["api_key"], configured: true, baseUrl: "http://sk-SECRETMARK" }];
	}
	async models() {
		return [{ provider: "p", id: "m", name: "M", input: ["text"], contextWindow: 10, headers: { a: "sk-SECRETMARK" } }];
	}
	async startLogin() {
		return { flowId: "flow-1" };
	}
	async createAccount(input) {
		this.created = input;
		if (this.failWith) throw new Error(this.failWith);
		return { accountId: input.accountId ?? "new-1", label: input.label, provider: input.provider, authMethod: "none", configured: false, apiKey: "sk-SECRETMARK" };
	}
	async removeAccount(accountId) {
		this.removed = accountId;
		if (this.failWith) throw new Error(this.failWith);
		return { accountId, removed: true };
	}
	async logout(accountId) {
		this.loggedOut = accountId;
		if (this.failWith) throw new Error(this.failWith);
		return { accountId, label: "Main", provider: "p", authMethod: "none", configured: false };
	}
	async status(accountId) {
		this.statusOf = accountId;
		if (this.failWith) throw new Error(this.failWith);
		return { accountId, label: "Main", provider: "p", authMethod: "api_key", configured: true, token: "sk-SECRETMARK" };
	}
	async reply(flowId, body) {
		this.replied = { flowId, ...body };
		return { ok: true };
	}
	async cancel(flowId) {
		this.cancelled = flowId;
		return { ok: true };
	}
}
class FakeProfiles {
	constructor() {
		this.selected = [];
	}
	list() {
		return { profiles: [{ id: "work", label: "W", role: "main", accountId: "main", provider: "p", modelId: "m", thinkingLevel: "low", env: { K: "sk-SECRETMARK" } }], active: "work" };
	}
	roles() {
		return [{ role: "main", profileIds: ["work"] }];
	}
	async select(id) {
		this.selected.push(id);
	}
	async selectForRole(role) {
		this.selected.push(`role:${role}`);
	}
	async save(input) {
		this.saved = input;
		if (this.failWith) throw new Error(this.failWith);
		return input;
	}
	async remove(id) {
		this.removedId = id;
		if (this.failWith) throw new Error(this.failWith);
		return { id, removed: true };
	}
	async deactivate() {
		this.deactivations = (this.deactivations ?? 0) + 1;
		if (this.failWith) throw new Error(this.failWith);
		return { ok: true };
	}
}

function tmpRuntime(t) {
	const base = fs.mkdtempSync(path.join(require("node:fs").realpathSync.native(os.tmpdir()), "abito-srv-"));
	t.after(() => fs.rmSync(base, { recursive: true, force: true }));
	return path.join(base, "run");
}

async function setup(t, { limits = {}, token = TOKEN, paused = false, pausedStore, connectors, agents } = {}) {
	const engine = new FakeEngine();
	const accounts = new FakeAccounts();
	const profiles = new FakeProfiles();
	const runtimeDir = tmpRuntime(t);
	const server = new IslandServer({ runtimeDir, token, engine, accounts, profiles, limits, paused, ...(pausedStore ? { pausedStore } : {}), ...(connectors ? { connectors } : {}), ...(agents ? { agents } : {}) });
	const { endpoint } = await server.start();
	t.after(() => server.close().catch(() => {}));
	return { server, engine, accounts, profiles, endpoint, runtimeDir };
}

/** Raw client that parses LF frames. */
function connect(endpoint) {
	const socket = net.connect(endpoint);
	const c = { socket, frames: [], closed: false, buf: "" };
	socket.setEncoding("utf8");
	socket.on("data", (d) => {
		c.buf += d;
		let i;
		while ((i = c.buf.indexOf("\n")) !== -1) {
			c.frames.push(JSON.parse(c.buf.slice(0, i)));
			c.buf = c.buf.slice(i + 1);
		}
	});
	socket.on("error", () => {});
	socket.on("close", () => (c.closed = true));
	c.send = (f) => socket.write(`${JSON.stringify(f)}\n`);
	c.wait = (pred, ms) => waitFor(() => c.frames.some(pred), ms).then(() => c.frames.find(pred));
	return c;
}
async function login(t, endpoint) {
	const c = connect(endpoint);
	t.after(() => c.socket.destroy());
	await new Promise((r) => c.socket.once("connect", r));
	c.send({ type: "hello", protocol: P.PROTOCOL, token: TOKEN });
	await c.wait((f) => f.type === "ready");
	return c;
}
const hello = (over = {}) => ({ type: "hello", protocol: P.PROTOCOL, token: TOKEN, ...over });

test("handshake succeeds: ready with seq 1, then monotonic seq", async (t) => {
	const { endpoint } = await setup(t);
	const c = await login(t, endpoint);
	assert.equal(c.frames[0].type, "ready");
	assert.equal(c.frames[0].seq, 1);
	assert.equal(c.frames[0].protocol, "island-agent/1");
	c.send({ type: "status" });
	c.send({ type: "status" });
	await waitFor(() => c.frames.length === 3);
	assert.deepEqual(c.frames.map((f) => f.seq), [1, 2, 3]);
});

test("handshake: bad token, bad protocol, non-hello and garbage close silently", async (t) => {
	const { endpoint } = await setup(t);
	for (const first of [hello({ token: "x".repeat(43) }), hello({ protocol: "island-agent/2" }), { type: "status" }, "garbage"]) {
		const c = connect(endpoint);
		await new Promise((r) => c.socket.once("connect", r));
		c.socket.write(typeof first === "string" ? `${first}\n` : `${JSON.stringify(first)}\n`);
		await waitFor(() => c.closed);
		assert.equal(c.frames.length, 0, "no detail sent");
	}
});

test("handshake timeout closes an idle connection", async (t) => {
	const { endpoint } = await setup(t, { limits: { handshakeMs: 80 } });
	const c = connect(endpoint);
	await waitFor(() => c.closed);
	assert.equal(c.frames.length, 0);
});

test("oversized frames close the connection (hello and post-handshake)", async (t) => {
	const { endpoint } = await setup(t);
	const a = connect(endpoint);
	await new Promise((r) => a.socket.once("connect", r));
	a.socket.write(`{"type":"hello","token":"${"a".repeat(P.LIMITS.maxHelloBytes + 10)}"}\n`);
	await waitFor(() => a.closed);

	const c = await login(t, endpoint);
	c.socket.write(`${JSON.stringify({ type: "send", text: "x".repeat(P.LIMITS.maxFrameBytes + 10) })}\n`);
	await waitFor(() => c.closed);
	// Unterminated flood is bounded too.
	const d = await login(t, endpoint);
	d.socket.write("y".repeat(P.LIMITS.maxFrameBytes * 5));
	await waitFor(() => d.closed);
});

test("rate limit closes a flooding client", async (t) => {
	const { endpoint } = await setup(t, { limits: { framesPerMinute: 5 } });
	const c = await login(t, endpoint);
	for (let i = 0; i < 10; i++) c.send({ type: "status" });
	await waitFor(() => c.closed);
});

test("max clients is enforced", async (t) => {
	const { endpoint } = await setup(t, { limits: { maxClients: 1 } });
	await login(t, endpoint);
	const second = connect(endpoint);
	await waitFor(() => second.closed);
});

const WIN = process.platform === "win32";
test("socket is 0600 inside a 0700 private directory; path guard", { skip: WIN && "Unix socket mechanism; Windows twin: «Windows: the endpoint is a named pipe…» below" }, async (t) => {
	const { endpoint, runtimeDir } = await setup(t);
	assert.equal(fs.lstatSync(endpoint).mode & 0o7777, 0o600);
	assert.ok(fs.lstatSync(endpoint).isSocket());
	assert.equal(fs.lstatSync(path.dirname(endpoint)).mode & 0o7777, 0o700);
	assert.equal(fs.lstatSync(runtimeDir).mode & 0o7777, 0o700);
	const long = new IslandServer({ runtimeDir: path.join(tmpRuntime(t), "x".repeat(120)), token: TOKEN, engine: new FakeEngine() });
	await assert.rejects(long.start());
});
// Windows twins (W1): no socket file, no private directory, no leftovers: the endpoint is a named pipe whose exact shape the Rust client checks
// (winpolicy::pipe_endpoint_ok), the token gate is the access control, and a pipe vanishes with its server.
test("Windows: the endpoint is a named pipe abito-<32 hex>, nothing is created on disk, and it disappears with the server", { skip: !WIN && "Windows only; Unix twin: «socket is 0600 inside a 0700 private directory»" }, async (t) => {
	const { server, endpoint, runtimeDir } = await setup(t);
	assert.match(endpoint, /^\\\\\.\\pipe\\abito-[0-9a-f]{32}$/);
	const entries = fs.existsSync(runtimeDir) ? fs.readdirSync(runtimeDir) : [];
	assert.deepEqual(entries.filter((n) => n.startsWith("p-")), [], "no socket directory on Windows (the runtime root itself may exist)");
	const c = await login(t, endpoint);
	assert.ok(c);
	await server.close();
	await assert.rejects(new Promise((resolve, reject) => { const s = require("node:net").connect(endpoint); s.once("connect", () => { s.destroy(); resolve(); }); s.once("error", reject); }));
});

test("a non-private runtime directory is refused", { skip: WIN && "no runtime directory on Windows (named pipe); twin: «Windows: the endpoint is a named pipe…»" }, async (t) => {
	const dir = tmpRuntime(t);
	fs.mkdirSync(dir, { mode: 0o755 });
	fs.chmodSync(dir, 0o755);
	await assert.rejects(new IslandServer({ runtimeDir: dir, token: TOKEN, engine: new FakeEngine() }).start());
});

test("stale socket of a dead server is cleaned; a live one is kept", { skip: WIN && "pipes vanish with their server: no stale endpoint exists; twin: «Windows: the endpoint is a named pipe…»" }, async (t) => {
	const runtimeDir = tmpRuntime(t);
	fs.mkdirSync(runtimeDir, { mode: 0o700 });
	const stale = path.join(runtimeDir, "p-abc123");
	fs.mkdirSync(stale, { mode: 0o700 });
	// A server process killed with SIGKILL leaves its socket file behind.
	const { spawnSync } = require("node:child_process");
	spawnSync(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(path.join(stale, "s"))}, () => process.kill(process.pid, "SIGKILL"))`], { timeout: 10000 });
	assert.ok(fs.lstatSync(path.join(stale, "s")).isSocket(), "stale socket left behind");

	const live = new IslandServer({ runtimeDir, token: TOKEN, engine: new FakeEngine() });
	const { endpoint } = await live.start();
	t.after(() => live.close());
	assert.ok(!fs.existsSync(stale), "stale dir removed");
	// A second server must not touch the first one's live endpoint.
	const other = new IslandServer({ runtimeDir, token: TOKEN, engine: new FakeEngine() });
	await other.start();
	assert.ok(fs.existsSync(endpoint));
	await other.close();
	assert.ok(fs.existsSync(endpoint));
});

test("prompt flow: busy rejected, deltas translated, settle frees the turn", async (t) => {
	const { endpoint, engine } = await setup(t);
	const c = await login(t, endpoint);
	c.send({ type: "send", text: "hello" });
	await c.wait((f) => f.type === "agent_state" && f.busy === true);
	assert.deepEqual(engine.requests[0], { type: "prompt", message: "hello" });
	c.send({ type: "send", text: "again" });
	await c.wait((f) => f.type === "error" && f.code === "busy");
	assert.equal(engine.requests.filter((r) => r.type === "prompt").length, 1);

	engine.emit("event", { type: "agent_start" });
	engine.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hi" } });
	engine.emit("event", { type: "message_end", message: { role: "assistant" } });
	const d = await c.wait((f) => f.type === "message_delta");
	const done = await c.wait((f) => f.type === "message_done");
	assert.equal(d.text, "Hi");
	assert.equal(d.messageId, done.messageId);
	// The prompt response does not free the turn; agent_settled does.
	assert.equal(c.frames.filter((f) => f.type === "agent_state").at(-1).busy, true);
	engine.emit("event", { type: "agent_settled" });
	await waitFor(() => c.frames.filter((f) => f.type === "agent_state").at(-1).busy === false);
	c.send({ type: "send", text: "next" });
	await waitFor(() => engine.requests.filter((r) => r.type === "prompt").length === 2);
});

test("steer needs a busy turn; abort and new_conversation reach the engine", async (t) => {
	const { endpoint, engine } = await setup(t);
	const c = await login(t, endpoint);
	c.send({ type: "steer", text: "x" });
	await c.wait((f) => f.type === "error" && f.code === "not_busy");
	engine.emit("event", { type: "agent_start" });
	await c.wait((f) => f.type === "agent_state" && f.busy);
	c.send({ type: "steer", text: "left" });
	c.send({ type: "abort" });
	await waitFor(() => engine.requests.some((r) => r.type === "abort") && engine.requests.some((r) => r.type === "steer"));
	c.send({ type: "new_conversation" });
	await c.wait((f) => f.type === "error" && f.code === "busy");
	engine.emit("event", { type: "agent_settled" });
	await waitFor(() => c.frames.filter((f) => f.type === "agent_state").at(-1).busy === false);
	c.send({ type: "new_conversation" });
	await waitFor(() => engine.requests.some((r) => r.type === "new_session"));
});

test("event allowlist on the wire: unknown dropped, tool args and secret markers never leak", async (t) => {
	const { endpoint, engine } = await setup(t);
	const c = await login(t, endpoint);
	engine.emit("event", { type: "something_new", data: "sk-SECRETMARK" });
	engine.emit("event", { type: "tool_execution_start", toolName: "read", args: { path: "/x", content: "sk-SECRETMARK" } });
	engine.emit("event", { type: "tool_execution_update", toolName: "read", partialResult: "sk-SECRETMARK" });
	engine.emit("event", { type: "tool_execution_end", toolName: "read", result: "sk-SECRETMARK", isError: false });
	engine.emit("event", { type: "turn_end", message: "sk-SECRETMARK" });
	await c.wait((f) => f.type === "activity" && f.state === "done");
	c.send({ type: "accounts_list" });
	c.send({ type: "providers_list" });
	c.send({ type: "models_list" });
	c.send({ type: "profiles_list" });
	await c.wait((f) => f.type === "profiles");
	await c.wait((f) => f.type === "models");
	assert.ok(!JSON.stringify(c.frames).includes("SECRETMARK"));
	assert.deepEqual(c.frames.filter((f) => f.type === "activity").map((f) => f.state), ["running", "done"]);
	assert.ok(!c.frames.some((f) => f.type === "something_new" || f.type === "turn_end"));
});

test("profile and role selection go to the store; refused while busy", async (t) => {
	const { server, endpoint, engine, profiles } = await setup(t);
	const c = await login(t, endpoint);
	c.send({ type: "profile_select", id: "work" });
	await waitFor(() => profiles.selected.length === 1);
	await waitFor(() => c.frames.some((f) => f.type === "profiles"));
	await waitFor(() => c.frames.filter((f) => f.type === "agent_state").pop()?.busy === false && !server.switching);
	c.send({ type: "role_select", role: "main" });
	await waitFor(() => profiles.selected.length === 2);
	assert.deepEqual(profiles.selected, ["work", "role:main"]);
	engine.emit("event", { type: "agent_start" });
	await c.wait((f) => f.type === "agent_state" && f.busy);
	c.send({ type: "profile_select", id: "work" });
	await c.wait((f) => f.type === "error" && f.code === "busy");
	assert.equal(profiles.selected.length, 2);
});

test("ask round-trip: select answered; invalid and unknown answers rejected", async (t) => {
	const { endpoint, engine } = await setup(t);
	const c = await login(t, endpoint);
	engine.emit("event", { type: "extension_ui_request", id: "u1", method: "select", title: "Pick", options: ["a", "b"] });
	const ask = await c.wait((f) => f.type === "ask");
	assert.deepEqual({ id: ask.id, kind: ask.kind, title: ask.title, options: ask.options }, { id: "u1", kind: "select", title: "Pick", options: ["a", "b"] });
	c.send({ type: "ui_response", id: "u1", value: "zzz" });
	await c.wait((f) => f.type === "error" && f.code === "bad_request");
	c.send({ type: "ui_response", id: "nope", value: "a" });
	await c.wait((f) => f.type === "error" && f.code === "unknown_ask");
	assert.equal(engine.sent.length, 0);
	c.send({ type: "ui_response", id: "u1", value: "b" });
	await c.wait((f) => f.type === "ask_resolved");
	assert.deepEqual(engine.sent, [{ type: "extension_ui_response", id: "u1", value: "b" }]);
	// A late duplicate is unknown.
	c.send({ type: "ui_response", id: "u1", value: "b" });
	await waitFor(() => c.frames.filter((f) => f.code === "unknown_ask").length === 2);
});

test("ask timeout cancels toward the agent; editor dialogs are cancelled at once", async (t) => {
	const { endpoint, engine } = await setup(t, { limits: { askTimeoutMs: 60 } });
	const c = await login(t, endpoint);
	engine.emit("event", { type: "extension_ui_request", id: "u2", method: "confirm", title: "Sure?" });
	await c.wait((f) => f.type === "ask");
	await c.wait((f) => f.type === "ask_resolved");
	assert.deepEqual(engine.sent.at(-1), { type: "extension_ui_response", id: "u2", cancelled: true });
	engine.emit("event", { type: "extension_ui_request", id: "u3", method: "editor", title: "E" });
	assert.deepEqual(engine.sent.at(-1), { type: "extension_ui_response", id: "u3", cancelled: true });
});

test("engine restart: agent_state restarting, no half answer replayed, asks closed", async (t) => {
	const { endpoint, engine } = await setup(t);
	const c = await login(t, endpoint);
	engine.emit("event", { type: "agent_start" });
	engine.emit("event", { type: "extension_ui_request", id: "u9", method: "input", title: "N" });
	await c.wait((f) => f.type === "ask");
	engine.status = "restarting";
	engine.emit("exit", { code: 1 });
	engine.emit("status", { state: "restarting" });
	const st = await c.wait((f) => f.type === "agent_state" && f.status === "restarting");
	assert.equal(st.busy, false);
	await c.wait((f) => f.type === "ask_resolved");
	c.send({ type: "send", text: "x" });
	await c.wait((f) => f.type === "error" && f.code === "unavailable");
	// A late client sees no replay of the old turn or the closed ask.
	const late = await login(t, endpoint).catch(() => undefined);
	assert.ok(!late || !late.frames.some((f) => f.type === "ask" || f.type === "message_delta"));
});

test("auth: passthrough events, replies go to the manager only", async (t) => {
	const { endpoint, accounts } = await setup(t);
	const c = await login(t, endpoint);
	accounts.emit("auth_prompt", { flowId: "f", promptId: "p1", accountId: "main", kind: "secret", message: "Key?", secret: true, leak: "sk-SECRETMARK" });
	accounts.emit("auth_event", { flowId: "f", kind: "url", url: "http://auth.example", leak: "sk-SECRETMARK" });
	accounts.emit("auth_done", { flowId: "f", accountId: "main", ok: true, leak: "sk-SECRETMARK" });
	await c.wait((f) => f.type === "auth_done");
	c.send({ type: "auth_start", accountId: "main", method: "api_key" });
	await c.wait((f) => f.type === "auth_started" && f.flowId === "flow-1");
	c.send({ type: "auth_reply", flowId: "flow-1", promptId: "p1", value: "typed-secret-value" });
	c.send({ type: "auth_cancel", flowId: "flow-1" });
	await waitFor(() => accounts.replied && accounts.cancelled);
	assert.equal(accounts.replied.value, "typed-secret-value");
	const wire = JSON.stringify(c.frames);
	assert.ok(!wire.includes("SECRETMARK") && !wire.includes("typed-secret-value"));
});

test("a slow client is dropped; the others keep working", async (t) => {
	const { server, endpoint, engine } = await setup(t, { limits: { maxOutboundBytes: 64 * 1024 } });
	const slow = await login(t, endpoint);
	slow.socket.pause();
	const fast = await login(t, endpoint);
	const chunk = "z".repeat(15000);
	for (let i = 0; i < 400 && server.clients.size === 2; i++) {
		engine.emit("event", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: chunk } });
		await sleep(2);
	}
	await waitFor(() => server.clients.size === 1, 5000); // server side: the slow client was dropped
	assert.ok(fast.frames.length > 1);
	assert.equal(fast.closed, false);
});

test("malformed post-handshake frames get a generic error, not a close", async (t) => {
	const { endpoint } = await setup(t);
	const c = await login(t, endpoint);
	c.socket.write("{broken\n");
	c.send({ type: "nonsense", stack: "x" });
	await waitFor(() => c.frames.filter((f) => f.type === "error").length === 2);
	assert.ok(c.frames.filter((f) => f.type === "error").every((f) => f.code === "bad_request" && Object.keys(f).sort().join() === "code,seq,type"));
	assert.equal(c.closed, false);
});

test("shutdown removes socket and directory, drops clients, leaves no timers", async (t) => {
	const { server, engine, endpoint, runtimeDir } = await setup(t);
	const c = await login(t, endpoint);
	engine.emit("event", { type: "extension_ui_request", id: "u7", method: "input", title: "N" });
	await c.wait((f) => f.type === "ask");
	await server.close();
	await waitFor(() => c.closed);
	assert.ok(!fs.existsSync(endpoint));
	assert.deepEqual(fs.readdirSync(runtimeDir), []);
	assert.equal(engine.listenerCount("event"), 0);
	assert.equal(server.asks.size, 0);
	await server.close(); // idempotent
});

test("tokens: generated tokens are random and long; short ones refused", () => {
	assert.notEqual(IslandServer.generateToken(), IslandServer.generateToken());
	assert.ok(IslandServer.generateToken().length >= 43);
	assert.throws(() => new IslandServer({ runtimeDir: "/tmp/x", token: "short", engine: new FakeEngine() }));
});

test("selection is serialized: send/steer/second select are busy while a switch is in flight", async (t) => {
	const { endpoint, engine, profiles } = await setup(t);
	let release;
	profiles.select = async (id) => {
		profiles.selected.push(id);
		await new Promise((r) => (release = r));
	};
	const c = await login(t, endpoint);
	c.send({ type: "profile_select", id: "work" });
	await waitFor(() => profiles.selected.length === 1);
	const state = await c.wait((f) => f.type === "agent_state" && f.busy);
	assert.equal(state.busy, true);
	c.send({ type: "send", text: "hi" });
	c.send({ type: "steer", text: "hi" });
	c.send({ type: "profile_select", id: "other" });
	c.send({ type: "role_select", role: "main" });
	await waitFor(() => c.frames.filter((f) => f.type === "error" && f.code === "busy").length >= 3);
	assert.equal(engine.requests.filter((r) => r.type === "prompt" || r.type === "steer").length, 0);
	assert.deepEqual(profiles.selected, ["work"]);
	// A stray engine event cannot clear the switch guard.
	engine.emit("event", { type: "agent_settled" });
	c.send({ type: "send", text: "again" });
	await waitFor(() => c.frames.filter((f) => f.type === "error" && f.code === "busy").length >= 4);
	release();
	await c.wait((f) => f.type === "agent_state" && f.busy === false);
	c.send({ type: "send", text: "ok" });
	await waitFor(() => engine.requests.some((r) => r.type === "prompt"));
});

test("a failed selection releases the switch guard", async (t) => {
	const { endpoint, profiles } = await setup(t);
	profiles.select = async () => {
		throw new Error("boom");
	};
	const c = await login(t, endpoint);
	c.send({ type: "profile_select", id: "work" });
	await c.wait((f) => f.type === "error" && f.code === "failed");
	c.send({ type: "status" });
	await waitFor(() => c.frames.filter((f) => f.type === "agent_state").length >= 2);
	assert.equal(c.frames.filter((f) => f.type === "agent_state").pop().busy, false);
});

// ----- v0.2: provider settings frames ----------------------------------------

const types = (c, type) => c.frames.filter((f) => f.type === type);
const errorCodes = (c) => types(c, "error").map((f) => f.code);
const nextError = async (c, from) => (await c.wait((f) => f.type === "error" && c.frames.indexOf(f) >= from)).code;

test("account_create: replies account to the caller and broadcasts accounts to every client; extras never reach the store", async (t) => {
	const { endpoint, accounts } = await setup(t);
	const a = await login(t, endpoint);
	const b = await login(t, endpoint);
	a.send({ type: "account_create", provider: "p", label: "Mine", accountId: "mine", extra: "x" });
	const account = await a.wait((f) => f.type === "account");
	assert.deepEqual(account.account, { accountId: "mine", label: "Mine", provider: "p", authMethod: "none", configured: false });
	assert.deepEqual(accounts.created, { provider: "p", label: "Mine", accountId: "mine" });
	await a.wait((f) => f.type === "accounts");
	await b.wait((f) => f.type === "accounts");
	assert.equal(types(b, "account").length, 0, "the account reply is not broadcast");
	a.send({ type: "account_create", provider: "p", label: "No id" });
	await waitFor(() => types(a, "account").length === 2);
	assert.deepEqual(accounts.created, { provider: "p", label: "No id" });
});

test("account_remove/logout/status: broadcast or reply, with generic busy|failed errors", async (t) => {
	const { endpoint, accounts } = await setup(t);
	const a = await login(t, endpoint);
	const b = await login(t, endpoint);
	a.send({ type: "account_remove", accountId: "main" });
	await b.wait((f) => f.type === "accounts");
	assert.equal(accounts.removed, "main");
	a.send({ type: "account_logout", accountId: "main" });
	await waitFor(() => types(b, "accounts").length === 2);
	assert.equal(accounts.loggedOut, "main");
	a.send({ type: "account_status", accountId: "main" });
	const status = await a.wait((f) => f.type === "account");
	assert.deepEqual(status.account, { accountId: "main", label: "Main", provider: "p", authMethod: "api_key", configured: true });
	assert.equal(types(b, "account").length, 0);
	// in use by a profile -> failed; sign-in in progress -> busy; nothing else leaks
	accounts.failWith = "Account in use by a profile";
	let from = a.frames.length;
	a.send({ type: "account_remove", accountId: "main" });
	assert.equal(await nextError(a, from), "failed");
	accounts.failWith = "Authentication busy: a sign-in is in progress";
	from = a.frames.length;
	a.send({ type: "account_logout", accountId: "main" });
	assert.equal(await nextError(a, from), "busy");
	assert.ok(!JSON.stringify(a.frames).includes("in use by a profile"));
	assert.equal(types(b, "accounts").length, 2, "failures broadcast nothing");
});

test("account_logout of the active profile's account deactivates it first; busy leaves the credential untouched", async (t) => {
	const { endpoint, profiles, accounts, engine } = await setup(t);
	const a = await login(t, endpoint);
	a.send({ type: "account_logout", accountId: "main" });
	await a.wait((f) => f.type === "accounts");
	assert.equal(accounts.loggedOut, "main");
	assert.equal(profiles.deactivations, 1);
	// non-active account: active profile untouched
	accounts.loggedOut = undefined;
	a.send({ type: "account_logout", accountId: "other" });
	await waitFor(() => accounts.loggedOut === "other");
	assert.equal(profiles.deactivations, 1);
	// busy: #378 the in-flight turn yields first; the logout then proceeds
	accounts.loggedOut = undefined;
	const accountsBefore = types(a, "accounts").length;
	engine.emit("event", { type: "agent_start" });
	a.send({ type: "account_logout", accountId: "main" });
	// A FRESH accounts frame proves the logout ran after the interrupt (a stale one would race it).
	await waitFor(() => types(a, "accounts").length === accountsBefore + 1);
	assert.equal(engine.interruptedWith, "access_revoked");
	assert.equal(accounts.loggedOut, "main");
	assert.ok(a.frames.some((f) => f.type === "toast" && f.message === "Se revocó el acceso: se interrumpió el turno del agente."), "a closed event explains the interruption");
});

test("account_logout while busy keeps the old guarantee when no safe point is reached (#378)", async (t) => {
	const store = makePausedStore();
	const { engine, accounts, profiles, endpoint } = await setup(t, { pausedStore: store, limits: { interruptSafePointMs: 80 } });
	const a = await login(t, endpoint);
	engine.hold = true;
	a.send({ type: "send", text: "long turn" });
	await a.wait((f) => f.type === "agent_state" && f.busy === true);
	engine.stuckAfterInterrupt = true; // the cutoff never reaches a safe point
	const from = a.frames.length;
	a.send({ type: "account_logout", accountId: "main" });
	assert.equal(await nextError(a, from), "busy");
	assert.equal(accounts.loggedOut, undefined, "the credential is untouched on the timeout path");
	assert.equal(profiles.deactivations, undefined, "the active profile is untouched on the timeout path");
});

test("profile_save / profile_remove broadcast profiles; validation errors are generic failed", async (t) => {
	const { endpoint, profiles } = await setup(t);
	const a = await login(t, endpoint);
	const b = await login(t, endpoint);
	const frame = { type: "profile_save", id: "work", label: "W", role: "main", accountId: "main", provider: "p", modelId: "m", thinkingLevel: "low" };
	a.send({ ...frame, junk: 1 });
	await b.wait((f) => f.type === "profiles");
	assert.deepEqual(profiles.saved, { id: "work", label: "W", role: "main", accountId: "main", provider: "p", modelId: "m", thinkingLevel: "low" });
	a.send({ type: "profile_remove", id: "work" });
	await waitFor(() => types(b, "profiles").length === 2);
	assert.equal(profiles.removedId, "work");
	profiles.failWith = "Unknown account FAKE-INTERNAL";
	const from = a.frames.length;
	a.send(frame);
	assert.equal(await nextError(a, from), "failed");
	assert.ok(!JSON.stringify(a.frames).includes("FAKE-INTERNAL"));
	assert.equal(types(b, "profiles").length, 2);
});

test("profile_deactivate: guarded like profile_select, broadcasts profiles and agent_state", async (t) => {
	const { endpoint, profiles, engine, server } = await setup(t);
	const a = await login(t, endpoint);
	const b = await login(t, endpoint);
	a.send({ type: "profile_deactivate" });
	await b.wait((f) => f.type === "profiles");
	assert.equal(profiles.deactivations, 1);
	await waitFor(() => types(a, "agent_state").length >= 2);
	// during a turn
	engine.emit("event", { type: "agent_start" });
	const from = a.frames.length;
	a.send({ type: "profile_deactivate" });
	assert.equal(await nextError(a, from), "busy");
	assert.equal(profiles.deactivations, 1);
	// store refusal (engine busy inside the store) maps to busy, other failures to failed
	engine.emit("event", { type: "agent_settled" });
	profiles.failWith = "Engine busy: finish or abort the current turn first";
	let n = a.frames.length;
	a.send({ type: "profile_deactivate" });
	assert.equal(await nextError(a, n), "busy");
	profiles.failWith = "Could not deactivate the profile";
	await waitFor(() => !server.switching);
	n = a.frames.length;
	a.send({ type: "profile_deactivate" });
	assert.equal(await nextError(a, n), "failed");
});

test("profile_deactivate during a switch is busy; a deactivate in flight blocks send and select", async (t) => {
	const { endpoint, profiles, server } = await setup(t);
	const c = await login(t, endpoint);
	let release;
	profiles.select = async (id) => {
		profiles.selected.push(id);
		await new Promise((r) => (release = r));
	};
	c.send({ type: "profile_select", id: "work" });
	await waitFor(() => profiles.selected.length === 1);
	c.send({ type: "profile_deactivate" });
	await c.wait((f) => f.type === "error" && f.code === "busy");
	assert.equal(profiles.deactivations ?? 0, 0);
	release();
	await waitFor(() => !server.switching);
	// now a slow deactivate blocks others
	let free;
	profiles.deactivate = async () => {
		profiles.deactivations = (profiles.deactivations ?? 0) + 1;
		await new Promise((r) => (free = r));
	};
	c.send({ type: "profile_deactivate" });
	await waitFor(() => profiles.deactivations === 1);
	assert.equal(server.state().busy, true);
	const before = c.frames.length;
	c.send({ type: "send", text: "hi" });
	c.send({ type: "profile_select", id: "other" });
	await waitFor(() => c.frames.slice(before).filter((f) => f.type === "error" && f.code === "busy").length === 2);
	free();
	await waitFor(() => !server.switching);
});

test("auth_state: null, then phases starting -> prompt -> progress -> done; a late client recovers the flow", async (t) => {
	const { endpoint, accounts } = await setup(t);
	const a = await login(t, endpoint);
	const ask = async (c) => {
		const from = c.frames.length;
		c.send({ type: "auth_state" });
		await waitFor(() => c.frames.slice(from).some((f) => f.type === "auth_state"));
		return c.frames.slice(from).find((f) => f.type === "auth_state").flow;
	};
	assert.equal(await ask(a), null);
	a.send({ type: "auth_start", accountId: "main", method: "api_key" });
	await a.wait((f) => f.type === "auth_started");
	assert.deepEqual(await ask(a), { flowId: "flow-1", accountId: "main", method: "api_key", phase: "starting" });
	accounts.emit("auth_prompt", { flowId: "flow-1", promptId: "p1", accountId: "main", kind: "secret", message: "Key?", secret: true });
	await a.wait((f) => f.type === "auth_prompt");
	assert.equal((await ask(a)).phase, "prompt");
	accounts.emit("auth_event", { flowId: "flow-1", kind: "info", message: "working" });
	await a.wait((f) => f.type === "auth_event");
	const late = await login(t, endpoint);
	assert.deepEqual(await ask(late), { flowId: "flow-1", accountId: "main", method: "api_key", phase: "progress" });
	accounts.emit("auth_done", { flowId: "flow-1", accountId: "main", ok: true });
	await a.wait((f) => f.type === "auth_done");
	assert.deepEqual(await ask(late), { flowId: "flow-1", accountId: "main", method: "api_key", phase: "done" });
	// auth_start and auth_done frames are unchanged: no method on the wire outside auth_state
	assert.ok(!("method" in a.frames.find((f) => f.type === "auth_started")));
	assert.ok(!("method" in a.frames.find((f) => f.type === "auth_done")));
	// a rejected start (flow already running) does not replace the tracked flow
	accounts.startLogin = async () => {
		throw new Error("Authentication busy");
	};
	a.send({ type: "auth_start", accountId: "main", method: "oauth" });
	await a.wait((f) => f.type === "error" && f.code === "busy");
	assert.equal((await ask(a)).method, "api_key");
});

test("auth events that arrive before auth_start resolves are not lost", async (t) => {
	const { endpoint, accounts } = await setup(t);
	const a = await login(t, endpoint);
	accounts.startLogin = async () => {
		accounts.emit("auth_prompt", { flowId: "flow-9", promptId: "p1", accountId: "main", kind: "secret", message: "k", secret: true });
		return { flowId: "flow-9" };
	};
	a.send({ type: "auth_start", accountId: "main", method: "api_key" });
	await a.wait((f) => f.type === "auth_started");
	a.send({ type: "auth_state" });
	const state = await a.wait((f) => f.type === "auth_state");
	assert.deepEqual(state.flow, { flowId: "flow-9", accountId: "main", method: "api_key", phase: "prompt" });
});

test("new frames answer unavailable without the managers", async (t) => {
	const runtimeDir = tmpRuntime(t);
	const server = new IslandServer({ runtimeDir, token: TOKEN, engine: new FakeEngine() });
	const { endpoint } = await server.start();
	t.after(() => server.close().catch(() => {}));
	const c = await login(t, endpoint);
	for (const f of [
		{ type: "account_create", provider: "p", label: "L" },
		{ type: "account_remove", accountId: "a" },
		{ type: "account_logout", accountId: "a" },
		{ type: "account_status", accountId: "a" },
		{ type: "profile_save", id: "w", label: "W", role: "r", accountId: "a", provider: "p", modelId: "m" },
		{ type: "profile_remove", id: "w" },
		{ type: "profile_deactivate" },
		{ type: "auth_state" },
	]) c.send(f);
	await waitFor(() => errorCodes(c).length === 8);
	assert.deepEqual([...new Set(errorCodes(c))], ["unavailable"]);
});

test("wire-wide secret scan: accounts/profiles/auth frames carry no key, baseUrl, headers or env", async (t) => {
	const { endpoint, accounts } = await setup(t);
	const a = await login(t, endpoint);
	const typed = "sk-TYPED-BY-USER-9999";
	a.send({ type: "accounts_list" });
	a.send({ type: "profiles_list" });
	a.send({ type: "providers_list" });
	a.send({ type: "models_list" });
	a.send({ type: "account_create", provider: "p", label: "Mine" });
	a.send({ type: "account_status", accountId: "main" });
	a.send({ type: "account_logout", accountId: "main" });
	a.send({ type: "profile_save", id: "work", label: "W", role: "main", accountId: "main", provider: "p", modelId: "m" });
	a.send({ type: "profile_deactivate" });
	a.send({ type: "auth_start", accountId: "main", method: "api_key" });
	await a.wait((f) => f.type === "auth_started");
	accounts.emit("auth_prompt", { flowId: "flow-1", promptId: "p1", accountId: "main", kind: "secret", message: "Key?", secret: true, apiKey: "sk-SECRETMARK" });
	a.send({ type: "auth_reply", flowId: "flow-1", promptId: "p1", value: typed });
	a.send({ type: "auth_state" });
	await waitFor(() => accounts.replied && types(a, "auth_state").length === 1 && types(a, "models").length === 1);
	accounts.emit("auth_done", { flowId: "flow-1", accountId: "main", ok: true, account: { accountId: "main", label: "M", provider: "p", authMethod: "api_key", configured: true, apiKey: "sk-SECRETMARK" } });
	await a.wait((f) => f.type === "auth_done");
	assert.equal(accounts.replied.value, typed, "the secret reached the account manager");
	const wire = JSON.stringify(a.frames);
	for (const marker of ["sk-", "SECRETMARK", "TYPED-BY-USER", "baseUrl", "headers", "apiKey", "\"env\"", "\"token\"", "\"key\""]) {
		assert.ok(!wire.includes(marker), `wire contains ${marker}`);
	}
});

test("real AccountManager + fake helper: account_create -> accounts frame end to end (no secrets)", async (t) => {
	const { AccountManager, helperEnv } = require("../src/auth.cjs");
	const root = fs.mkdtempSync(path.join(require("node:fs").realpathSync.native(os.tmpdir()), "abito-srv-real-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const accountsRoot = path.join(root, "accounts");
	const manager = new AccountManager({
		accountsRoot,
		helper: {
			command: process.execPath,
			args: [path.join(__dirname, "fixtures", "fake-auth.cjs"), "--accounts-root", accountsRoot],
			env: helperEnv(process.env, { home: root, tmp: root }),
		},
	});
	t.after(() => manager.close());
	const server = new IslandServer({ runtimeDir: tmpRuntime(t), token: TOKEN, engine: new FakeEngine(), accounts: manager, profiles: new FakeProfiles() });
	const { endpoint } = await server.start();
	t.after(() => server.close().catch(() => {}));
	const c = await login(t, endpoint);
	c.send({ type: "account_create", provider: "openai", label: "Work OpenAI" });
	const reply = await c.wait((f) => f.type === "account");
	assert.deepEqual(reply.account, { accountId: "work-openai", label: "Work OpenAI", provider: "openai", authMethod: "none", configured: false });
	const listing = await c.wait((f) => f.type === "accounts");
	assert.deepEqual(listing.accounts.map((x) => x.accountId), ["work-openai"]);
	c.send({ type: "account_status", accountId: "work-openai" });
	await waitFor(() => types(c, "account").length === 2);
	c.send({ type: "account_remove", accountId: "work-openai" });
	await waitFor(() => types(c, "accounts").length === 2);
	assert.deepEqual(types(c, "accounts")[1].accounts, []);
});

// ----- settings frames (V2 hotkey) -------------------------------------------------

class FakeSettings {
	constructor(hotkey = null) {
		this.hotkey = hotkey;
		this.calls = [];
	}
	get() {
		return { hotkey: this.hotkey };
	}
	setHotkey(value) {
		this.calls.push(value);
		if (this.failWith) {
			const error = new Error(this.failWith.message);
			error.name = this.failWith.name;
			throw error;
		}
		this.hotkey = value === null ? null : String(value).toUpperCase();
		return { hotkey: this.hotkey, changed: true };
	}
}

async function setupSettings(t, settings) {
	const runtimeDir = tmpRuntime(t);
	const server = new IslandServer({ runtimeDir, token: TOKEN, engine: new FakeEngine(), ...(settings ? { settings } : {}) });
	const { endpoint } = await server.start();
	t.after(() => server.close().catch(() => {}));
	return { server, endpoint };
}

test("settings_get replies settings{hotkey} to the caller only; null when unset", async (t) => {
	const { endpoint } = await setupSettings(t, new FakeSettings());
	const a = await login(t, endpoint);
	const b = await login(t, endpoint);
	a.send({ type: "settings_get" });
	const frame = await a.wait((f) => f.type === "settings");
	assert.equal(frame.hotkey, null);
	await sleep(40);
	assert.equal(b.frames.some((f) => f.type === "settings"), false);
	const { endpoint: e2 } = await setupSettings(t, new FakeSettings("Ctrl+Alt+Space"));
	const c = await login(t, e2);
	c.send({ type: "settings_get" });
	assert.equal((await c.wait((f) => f.type === "settings")).hotkey, "Ctrl+Alt+Space");
});

test("settings_set persists and broadcasts settings to every client; null clears", async (t) => {
	const settings = new FakeSettings();
	const { endpoint } = await setupSettings(t, settings);
	const a = await login(t, endpoint);
	const b = await login(t, endpoint);
	a.send({ type: "settings_set", hotkey: "ctrl+alt+space" });
	const fa = await a.wait((f) => f.type === "settings");
	const fb = await b.wait((f) => f.type === "settings");
	assert.equal(fa.hotkey, "CTRL+ALT+SPACE");
	assert.equal(fb.hotkey, "CTRL+ALT+SPACE");
	assert.deepEqual(settings.calls, ["ctrl+alt+space"]);
	assert.equal(a.frames.filter((f) => f.type === "settings").length, 1, "caller gets exactly one frame");
	b.send({ type: "settings_set", hotkey: null });
	await a.wait((f) => f.type === "settings" && f.hotkey === null);
	await b.wait((f) => f.type === "settings" && f.hotkey === null);
	assert.deepEqual(settings.calls, ["ctrl+alt+space", null]);
});

test("settings_set: invalid hotkey -> bad_request, other failure -> failed, nothing broadcast", async (t) => {
	const settings = new FakeSettings();
	const { endpoint } = await setupSettings(t, settings);
	const a = await login(t, endpoint);
	const b = await login(t, endpoint);
	settings.failWith = { name: "ConfigError", message: "invalid config: hotkey" };
	a.send({ type: "settings_set", hotkey: "Space" });
	assert.equal((await a.wait((f) => f.type === "error")).code, "bad_request");
	settings.failWith = { name: "Error", message: "EACCES /secret/path" };
	a.send({ type: "settings_set", hotkey: "Ctrl+A" });
	await waitFor(() => a.frames.filter((f) => f.type === "error").length === 2);
	const errors = a.frames.filter((f) => f.type === "error");
	assert.deepEqual(errors.map((f) => f.code), ["bad_request", "failed"]);
	assert.ok(!JSON.stringify(a.frames).includes("secret"));
	await sleep(40);
	assert.equal(b.frames.some((f) => f.type === "settings"), false);
	// Malformed frames never reach the dependency.
	const before = settings.calls.length;
	a.send({ type: "settings_set", hotkey: 5 });
	await waitFor(() => a.frames.filter((f) => f.type === "error").length === 3);
	assert.equal(settings.calls.length, before);
});

test("settings frames without a settings dependency -> unavailable", async (t) => {
	const { endpoint } = await setupSettings(t, undefined);
	const a = await login(t, endpoint);
	a.send({ type: "settings_get" });
	a.send({ type: "settings_set", hotkey: "Ctrl+Alt+Space" });
	await waitFor(() => a.frames.filter((f) => f.type === "error").length === 2);
	assert.deepEqual(a.frames.filter((f) => f.type === "error").map((f) => f.code), ["unavailable", "unavailable"]);
});

test("broadcastSettings pushes the current settings to all clients", async (t) => {
	const settings = new FakeSettings("Ctrl+Alt+Space");
	const { server, endpoint } = await setupSettings(t, settings);
	const a = await login(t, endpoint);
	server.broadcastSettings();
	assert.equal((await a.wait((f) => f.type === "settings")).hotkey, "Ctrl+Alt+Space");
});

// ----- connectors_list / connectors (V4) ------------------------------------------

const GOLDEN = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "connectors", `${name}.json`), "utf8"));

class FakeConnectors {
	constructor(over = {}) {
		this.calls = 0;
		this.delay = over.delay ?? 0;
		this.fail = over.fail;
		this.data = over.data ?? { catalog: GOLDEN("catalog").entries, connectors: GOLDEN("status").connectors };
	}
	async snapshot() {
		this.calls += 1;
		if (this.delay) await sleep(this.delay);
		if (this.fail) throw new Error("FAKE-INTERNAL /home/secret sk-SECRETMARK");
		return this.data;
	}
}
async function setupConnectors(t, connectors, limits = {}) {
	const runtimeDir = tmpRuntime(t);
	const server = new IslandServer({ runtimeDir, token: TOKEN, engine: new FakeEngine(), connectors, limits });
	const { endpoint } = await server.start();
	t.after(() => server.close().catch(() => {}));
	return { server, endpoint };
}

test("connectors_list replies the sanitized connectors frame to the caller only", async (t) => {
	const dep = new FakeConnectors();
	const { endpoint } = await setupConnectors(t, dep);
	const a = await login(t, endpoint);
	const b = await login(t, endpoint);
	a.send({ type: "connectors_list" });
	const frame = await a.wait((f) => f.type === "connectors");
	assert.equal(frame.schema, "abito-connectors/view/1");
	assert.deepEqual(frame.catalog, GOLDEN("catalog").entries);
	assert.deepEqual(frame.connectors, GOLDEN("status").connectors);
	assert.equal(typeof frame.seq, "number");
	await sleep(60);
	assert.equal(b.frames.some((f) => f.type === "connectors"), false);
});

test("connectors_list: wire never carries secret-looking data even if the dependency returns it", async (t) => {
	const data = { catalog: GOLDEN("catalog").entries.map((e) => ({ ...e, url: "SECRETMARK", env: { K: "SECRETMARK" } })), connectors: GOLDEN("status").connectors.map((c) => ({ ...c, token: "SECRETMARK", capability: "SECRETMARK", status: { ...c.status, ref: "SECRETMARK" } })) };
	const { endpoint } = await setupConnectors(t, new FakeConnectors({ data }));
	const a = await login(t, endpoint);
	a.send({ type: "connectors_list" });
	const frame = await a.wait((f) => f.type === "connectors");
	assert.ok(!JSON.stringify(frame).includes("SECRETMARK"));
	assert.deepEqual(frame.connectors, GOLDEN("status").connectors);
});

test("connectors_list without a dependency -> unavailable; a failing dependency -> generic failed", async (t) => {
	const none = await setupConnectors(t, undefined);
	const a = await login(t, none.endpoint);
	a.send({ type: "connectors_list" });
	assert.equal((await a.wait((f) => f.type === "error")).code, "unavailable");

	const failing = await setupConnectors(t, new FakeConnectors({ fail: true }));
	const b = await login(t, failing.endpoint);
	b.send({ type: "connectors_list" });
	const err = await b.wait((f) => f.type === "error");
	assert.deepEqual(Object.keys(err).sort(), ["code", "seq", "type"]);
	assert.equal(err.code, "failed");
	assert.ok(!JSON.stringify(b.frames).match(/SECRETMARK|FAKE-INTERNAL|home/));
});

test("connectors_list: invalid dependency data -> failed (rebuilt strictly)", async (t) => {
	const { endpoint } = await setupConnectors(t, new FakeConnectors({ data: { catalog: [], connectors: [{ id: 1 }] } }));
	const a = await login(t, endpoint);
	a.send({ type: "connectors_list" });
	assert.equal((await a.wait((f) => f.type === "error")).code, "failed");
});

test("connectors_list single-flight: N concurrent requests from 2 clients -> exactly 1 snapshot", async (t) => {
	const dep = new FakeConnectors({ delay: 150 });
	const { endpoint } = await setupConnectors(t, dep);
	const a = await login(t, endpoint);
	const b = await login(t, endpoint);
	for (let i = 0; i < 5; i++) a.send({ type: "connectors_list" });
	for (let i = 0; i < 4; i++) b.send({ type: "connectors_list" });
	await waitFor(() => a.frames.filter((f) => f.type === "connectors").length === 5 && b.frames.filter((f) => f.type === "connectors").length === 4);
	assert.equal(dep.calls, 1);
});

test("connectors_list min interval: cached for the window (success and failure), then a new spawn", async (t) => {
	const dep = new FakeConnectors();
	const { endpoint } = await setupConnectors(t, dep, { connectorsMinIntervalMs: 250 });
	const a = await login(t, endpoint);
	a.send({ type: "connectors_list" });
	await a.wait((f) => f.type === "connectors");
	a.send({ type: "connectors_list" });
	await waitFor(() => a.frames.filter((f) => f.type === "connectors").length === 2);
	assert.equal(dep.calls, 1, "second request served from cache");
	await sleep(300);
	a.send({ type: "connectors_list" });
	await waitFor(() => a.frames.filter((f) => f.type === "connectors").length === 3);
	assert.equal(dep.calls, 2);

	const bad = new FakeConnectors({ fail: true });
	const f = await setupConnectors(t, bad, { connectorsMinIntervalMs: 250 });
	const c = await login(t, f.endpoint);
	c.send({ type: "connectors_list" });
	c.send({ type: "connectors_list" });
	await waitFor(() => c.frames.filter((x) => x.type === "error").length === 2);
	assert.equal(bad.calls, 1, "a failure is not retried inside the window");
	assert.deepEqual(c.frames.filter((x) => x.type === "error").map((x) => x.code), ["failed", "failed"]);
});

test("connectors_list counts toward the rate limit", async (t) => {
	const dep = new FakeConnectors();
	const { endpoint } = await setupConnectors(t, dep, { framesPerMinute: 4 });
	const a = await login(t, endpoint);
	for (let i = 0; i < 10; i++) a.send({ type: "connectors_list" });
	await waitFor(() => a.closed);
	assert.equal(dep.calls, 1);
});

test("R3: connectors_list caps what is emitted: 128 realistic -> frame, 256 -> generic failed", async (t) => {
	const c = GOLDEN("status").connectors[0];
	const mk = (n) => Array.from({ length: n }, (_, i) => ({ ...c, id: `c${i}` }));
	const ok = await setupConnectors(t, new FakeConnectors({ data: { catalog: GOLDEN("catalog").entries, connectors: mk(128) } }));
	const a = await login(t, ok.endpoint);
	a.send({ type: "connectors_list" });
	assert.equal((await a.wait((f) => f.type === "connectors")).connectors.length, 128);
	const big = await setupConnectors(t, new FakeConnectors({ data: { catalog: GOLDEN("catalog").entries, connectors: mk(256) } }));
	const b = await login(t, big.endpoint);
	b.send({ type: "connectors_list" });
	assert.equal((await b.wait((f) => f.type === "error")).code, "failed");
	assert.equal(b.frames.some((f) => f.type === "connectors"), false);
});

// ----- V5: local OpenAI-compatible endpoint frames ----------------------------------------

const LOCAL_URL = "http://127.0.0.1:11434/v1";
function withLocal(accounts) {
	accounts.localCalls = [];
	accounts.createLocalAccount = async (input) => {
		accounts.localCalls.push(["create", input]);
		if (accounts.failWith) throw new Error(accounts.failWith);
		return { accountId: input.accountId ?? "ollama", label: input.label, provider: "local-ollama", authMethod: "api_key", configured: true, local: true, baseUrl: LOCAL_URL, kind: "local", models: ["m"] };
	};
	accounts.setLocalEndpoint = async (input) => {
		accounts.localCalls.push(["set", input]);
		if (accounts.failWith) throw new Error(accounts.failWith);
		return { accountId: input.accountId, label: "L", provider: "local-ollama", authMethod: "api_key", configured: true, local: true, baseUrl: LOCAL_URL };
	};
	return accounts;
}

test("local_account_create replies account + broadcasts accounts; no endpoint on any frame", async (t) => {
	const { endpoint, accounts } = await setup(t);
	withLocal(accounts);
	const a = await login(t, endpoint);
	const b = await login(t, endpoint);
	a.send({ type: "local_account_create", label: "Ollama", baseUrl: LOCAL_URL, modelIds: ["qwen2.5-coder:7b"] });
	const reply = await a.wait((f) => f.type === "account");
	assert.equal(reply.account.local, true);
	assert.deepEqual(accounts.localCalls[0], ["create", { label: "Ollama", baseUrl: LOCAL_URL, modelIds: ["qwen2.5-coder:7b"] }]);
	await b.wait((f) => f.type === "accounts");
	await a.wait((f) => f.type === "accounts");
	for (const c of [a, b]) {
		const wire = JSON.stringify(c.frames);
		for (const banned of ["11434", "127.0.0.1", "baseUrl", "abito-local-endpoint", "qwen2.5"]) assert.equal(wire.includes(banned), false, banned);
	}
	assert.equal(b.frames.some((f) => f.type === "account"), false, "reply goes to the caller only");
});

test("local frames: invalid shape/URL is bad_request; manager failure is failed; nothing leaks", async (t) => {
	const { endpoint, accounts } = await setup(t);
	withLocal(accounts);
	const c = await login(t, endpoint);
	for (const bad of [
		{ type: "local_account_create", label: "x", baseUrl: "http://10.0.0.5/v1", modelIds: ["m"] },
		{ type: "local_account_create", label: "x", baseUrl: LOCAL_URL, modelIds: [] },
		{ type: "local_endpoint_set", accountId: "ollama", baseUrl: "https://evil.com/v1", modelIds: ["m"] },
	]) c.send(bad);
	await waitFor(() => c.frames.filter((f) => f.type === "error" && f.code === "bad_request").length === 3);
	assert.equal(accounts.localCalls.length, 0);
	accounts.failWith = "Account is not a local endpoint 11434";
	c.send({ type: "local_endpoint_set", accountId: "main", baseUrl: LOCAL_URL, modelIds: ["m"] });
	const err = await c.wait((f) => f.type === "error" && f.code === "failed");
	assert.deepEqual(Object.keys(err).sort(), ["code", "seq", "type"]);
	assert.equal(JSON.stringify(c.frames).includes("11434"), false);
});

test("local_endpoint_set: ok replies account; busy while its account backs the ACTIVE profile and a turn runs", async (t) => {
	const { endpoint, accounts, server } = await setup(t); // profiles: active "work" backed by account "main"
	withLocal(accounts);
	const c = await login(t, endpoint);
	c.send({ type: "local_endpoint_set", accountId: "main", baseUrl: LOCAL_URL, modelIds: ["m"] });
	await c.wait((f) => f.type === "account");
	await c.wait((f) => f.type === "accounts");
	assert.equal(accounts.localCalls.length, 1);
	server.busy = true; // a turn is running
	c.send({ type: "local_endpoint_set", accountId: "main", baseUrl: LOCAL_URL, modelIds: ["m"] });
	await c.wait((f) => f.type === "error" && f.code === "busy");
	assert.equal(accounts.localCalls.length, 1, "refused before touching the store");
	// A different account (not backing the active profile) is unaffected by a running turn.
	c.send({ type: "local_endpoint_set", accountId: "other", baseUrl: LOCAL_URL, modelIds: ["m"] });
	await waitFor(() => accounts.localCalls.length === 2);
	// A selection in flight also refuses.
	server.busy = false;
	server.switching = new Promise(() => {});
	c.send({ type: "local_endpoint_set", accountId: "main", baseUrl: LOCAL_URL, modelIds: ["m"] });
	await waitFor(() => c.frames.filter((f) => f.type === "error" && f.code === "busy").length === 2);
	server.switching = undefined;
});

test("local_endpoint_set never touches the live agent files (profiles untouched)", async (t) => {
	const { endpoint, accounts, profiles } = await setup(t);
	withLocal(accounts);
	const c = await login(t, endpoint);
	c.send({ type: "local_endpoint_set", accountId: "main", baseUrl: LOCAL_URL, modelIds: ["m"] });
	await c.wait((f) => f.type === "account");
	assert.deepEqual(profiles.selected, []);
	assert.equal(profiles.deactivations, undefined);
});

// ----- agents_list / agent_connect / agent_disconnect / agents (H2b) -----------------

class FakeAgents extends EventEmitter {
	constructor(over = {}) {
		super();
		this.calls = [];
		this.delay = over.delay ?? 0;
		this.busy = false;
		this.fail = over.fail;
		this.state = "not_connected";
	}
	entries(state = this.state, extra = {}) {
		return [
			{ id: "claude-code", name: "Claude Code", state, backup: false, detail: null, ...extra },
			{ id: "codex", name: "Codex", state: "not_connected", backup: false, detail: null },
			{ id: "opencode", name: "OpenCode", state: "unavailable", backup: false, detail: null },
		];
	}
	async list() {
		this.calls.push(["list"]);
		return this.entries();
	}
	async connect(id, hash) {
		this.calls.push(["connect", id, hash]);
		if (this.busy) throw Object.assign(new Error("agents busy"), { code: "busy" });
		if (this.fail) throw new Error("FAKE-INTERNAL /home/secret sk-SECRETMARK stderr text");
		this.busy = true;
		this.emit("change", this.entries("working"));
		if (this.delay) await sleep(this.delay);
		this.busy = false;
		this.state = "connected";
		return this.entries("connected", { backup: true });
	}
	async disconnect(id) {
		this.calls.push(["disconnect", id]);
		this.state = "not_connected";
		return this.entries("not_connected");
	}
}
async function setupAgents(t, agents, limits = {}) {
	const runtimeDir = tmpRuntime(t);
	const server = new IslandServer({ runtimeDir, token: TOKEN, engine: new FakeEngine(), agents, limits });
	const { endpoint } = await server.start();
	t.after(() => server.close().catch(() => {}));
	return { server, endpoint };
}

test("agents_list replies to the caller only; agent_connect broadcasts working then the result to ALL clients", async (t) => {
	const dep = new FakeAgents({ delay: 80 });
	const { endpoint } = await setupAgents(t, dep);
	const a = await login(t, endpoint);
	const b = await login(t, endpoint);
	a.send({ type: "agents_list" });
	const listed = await a.wait((f) => f.type === "agents");
	assert.equal(listed.agents.length, 3);
	await sleep(40);
	assert.equal(b.frames.some((f) => f.type === "agents"), false);
	const hash = "ab".repeat(32);
	a.send({ type: "agent_connect", agentId: "claude-code", plan_hash: hash });
	for (const c of [a, b]) {
		await c.wait((f) => f.type === "agents" && f.agents[0].state === "working");
		await c.wait((f) => f.type === "agents" && f.agents[0].state === "connected" && f.agents[0].backup === true);
	}
	assert.deepEqual(dep.calls.find((c) => c[0] === "connect"), ["connect", "claude-code", hash]);
	b.send({ type: "agent_disconnect", agentId: "claude-code" });
	for (const c of [a, b]) await c.wait((f) => f.type === "agents" && f.agents[0].state === "not_connected" && c.frames.length > 0 && f.seq > 3);
});

test("agent_connect while an operation runs -> error busy", async (t) => {
	const dep = new FakeAgents({ delay: 200 });
	const { endpoint } = await setupAgents(t, dep);
	const a = await login(t, endpoint);
	const b = await login(t, endpoint);
	a.send({ type: "agent_connect", agentId: "claude-code" });
	await b.wait((f) => f.type === "agents" && f.agents[0].state === "working");
	b.send({ type: "agent_connect", agentId: "codex" });
	assert.equal((await b.wait((f) => f.type === "error")).code, "busy");
	await a.wait((f) => f.type === "agents" && f.agents[0].state === "connected");
});

test("agents without a dependency -> unavailable; invalid frames -> bad_request", async (t) => {
	const { endpoint } = await setupAgents(t, undefined);
	const a = await login(t, endpoint);
	for (const frame of [{ type: "agents_list" }, { type: "agent_connect", agentId: "codex" }, { type: "agent_disconnect", agentId: "codex" }]) a.send(frame);
	await waitFor(() => a.frames.filter((f) => f.type === "error").length === 3);
	assert.ok(a.frames.filter((f) => f.type === "error").every((f) => f.code === "unavailable"));
	a.send({ type: "agent_connect", agentId: "nope" });
	assert.equal((await a.wait((f) => f.type === "error" && f.code === "bad_request")).code, "bad_request");
});

test("agents: a failing dependency -> generic failed; no path, secret or stderr on the wire", async (t) => {
	const dep = new FakeAgents({ fail: true });
	const { endpoint } = await setupAgents(t, dep);
	const a = await login(t, endpoint);
	a.send({ type: "agent_connect", agentId: "codex" });
	assert.equal((await a.wait((f) => f.type === "error")).code, "failed");
	await sleep(30);
	assert.doesNotMatch(JSON.stringify(a.frames), /SECRETMARK|\/home\/secret|stderr text|FAKE-INTERNAL/);
});

test("agents frames count toward the per-client rate limit", async (t) => {
	const { endpoint } = await setupAgents(t, new FakeAgents(), { framesPerMinute: 4 });
	const a = await login(t, endpoint);
	for (let i = 0; i < 6; i++) a.send({ type: "agents_list" });
	await a.wait((f) => f.type === "error" && f.code === "rate_limited");
});

// ----- mcp_import_preview (#381) ------------------------------------------------

class FakeMcpImport {
	constructor(over = {}) {
		this.calls = 0;
		this.delay = over.delay ?? 0;
		this.fail = over.fail;
		this.data = over.data ?? {
			files: [{ source: "cursor", status: "ok" }],
			servers: [{ source: "cursor", name: "fs", transport: "stdio", command: "npx", status: "ready" }],
			truncated: false,
		};
	}
	async preview() {
		this.calls += 1;
		if (this.delay) await sleep(this.delay);
		if (this.fail) throw new Error("FAKE-INTERNAL /home/secret sk-SECRETMARK");
		return this.data;
	}
}
async function setupMcpImport(t, mcpImport) {
	const runtimeDir = tmpRuntime(t);
	const server = new IslandServer({ runtimeDir, token: TOKEN, engine: new FakeEngine(), mcpImport });
	const { endpoint } = await server.start();
	t.after(() => server.close().catch(() => {}));
	return { server, endpoint };
}

test("mcp_import_preview without a dependency -> unavailable; a failing dependency -> generic failed", async (t) => {
	const none = await setupMcpImport(t, undefined);
	const a = await login(t, none.endpoint);
	a.send({ type: "mcp_import_preview" });
	assert.equal((await a.wait((f) => f.type === "error")).code, "unavailable");

	const failing = await setupMcpImport(t, new FakeMcpImport({ fail: true }));
	const b = await login(t, failing.endpoint);
	b.send({ type: "mcp_import_preview" });
	const err = await b.wait((f) => f.type === "error");
	assert.deepEqual(Object.keys(err).sort(), ["code", "seq", "type"]);
	assert.equal(err.code, "failed");
	assert.ok(!JSON.stringify(b.frames).match(/SECRETMARK|FAKE-INTERNAL|\/home/));
});

test("mcp_import_preview replies the sanitized preview frame to the caller only", async (t) => {
	const dep = new FakeMcpImport();
	const { endpoint } = await setupMcpImport(t, dep);
	const a = await login(t, endpoint);
	const b = await login(t, endpoint);
	a.send({ type: "mcp_import_preview" });
	await waitFor(() => a.frames.some((f) => f.type === "mcp_import"));
	assert.equal(dep.calls, 1);
	const frame = a.frames.find((f) => f.type === "mcp_import");
	assert.equal(frame.schema, "abito-mcp-import/preview/1");
	assert.deepEqual(frame.files, [{ source: "cursor", status: "ok" }]);
	assert.deepEqual(frame.servers, [{ source: "cursor", name: "fs", transport: "stdio", command: "npx", status: "ready" }]);
	assert.equal(frame.truncated, false);
	assert.ok(!b.frames.some((f) => f.type === "mcp_import"), "not broadcast");
	// invalid dependency data -> failed (rebuilt strictly)
	const bad = await setupMcpImport(t, new FakeMcpImport({ data: { files: [], servers: [{ id: 1 }], truncated: false } }));
	const c = await login(t, bad.endpoint);
	c.send({ type: "mcp_import_preview" });
	assert.equal((await c.wait((f) => f.type === "error")).code, "failed");
});

// ----- sessions_list (#360, F046/F049) ------------------------------------------

class FakeSessions {
	constructor(over = {}) {
		this.calls = 0;
		this.delay = over.delay ?? 0;
		this.fail = over.fail;
		this.data = over.data ?? { sessions: [{ id: "s-0123abcd", kind: "pi", cwd: "mi-proyecto", state: "sleeping", origin: "herdr" }], truncated: false };
	}
	async snapshot() {
		this.calls += 1;
		if (this.delay) await sleep(this.delay);
		if (this.fail) throw new Error("FAKE-INTERNAL /home/secret sk-SECRETMARK");
		return this.data;
	}
}
async function setupSessions(t, sessions, limits = {}) {
	const runtimeDir = tmpRuntime(t);
	const server = new IslandServer({ runtimeDir, token: TOKEN, engine: new FakeEngine(), sessions, limits });
	const { endpoint } = await server.start();
	t.after(() => server.close().catch(() => {}));
	return { server, endpoint };
}

test("sessions_list replies the closed sessions frame to the caller only", async (t) => {
	const dep = new FakeSessions();
	const { endpoint } = await setupSessions(t, dep);
	const a = await login(t, endpoint);
	const b = await login(t, endpoint);
	a.send({ type: "sessions_list" });
	const frame = await a.wait((f) => f.type === "sessions");
	assert.equal(frame.schema, "abito-sessions/view/1");
	assert.deepEqual(frame.sessions, dep.data.sessions);
	assert.equal(frame.truncated, false);
	await sleep(60);
	assert.ok(!b.frames.some((f) => f.type === "sessions"), "not broadcast");
});

test("sessions_list without a dependency -> unavailable; a failing dependency -> generic failed; the wire never carries secrets", async (t) => {
	const none = await setupSessions(t, undefined);
	const a = await login(t, none.endpoint);
	a.send({ type: "sessions_list" });
	assert.equal((await a.wait((f) => f.type === "error")).code, "unavailable");

	const failing = await setupSessions(t, new FakeSessions({ fail: true }));
	const b = await login(t, failing.endpoint);
	b.send({ type: "sessions_list" });
	const err = await b.wait((f) => f.type === "error");
	assert.deepEqual(Object.keys(err).sort(), ["code", "seq", "type"]);
	assert.equal(err.code, "failed");
	await sleep(30);
	assert.ok(!JSON.stringify(b.frames).match(/SECRETMARK|FAKE-INTERNAL|\/home/));

	// invalid dependency data -> failed (rebuilt strictly)
	const bad = await setupSessions(t, new FakeSessions({ data: { sessions: [{ id: "x", kind: "bash" }], truncated: false } }));
	const c = await login(t, bad.endpoint);
	c.send({ type: "sessions_list" });
	assert.equal((await c.wait((f) => f.type === "error")).code, "failed");
});

test("sessions_list serves the snapshot from the cache inside the min interval", async (t) => {
	const dep = new FakeSessions();
	const { endpoint } = await setupSessions(t, dep, { sessionsMinIntervalMs: 250 });
	const a = await login(t, endpoint);
	a.send({ type: "sessions_list" });
	await a.wait((f) => f.type === "sessions");
	a.send({ type: "sessions_list" });
	await waitFor(() => a.frames.filter((f) => f.type === "sessions").length === 2);
	assert.equal(dep.calls, 1, "second request served from cache");
	await sleep(300);
	a.send({ type: "sessions_list" });
	await waitFor(() => a.frames.filter((f) => f.type === "sessions").length === 3);
	assert.equal(dep.calls, 2);
});

test("sessions_list is a read: it still answers while the global pause is on", async (t) => {
	const store = makePausedStore();
	const { endpoint } = await setupSessions(t, new FakeSessions(), { pausedStore: store });
	const a = await login(t, endpoint);
	a.send({ type: "set_paused", paused: true });
	await a.wait((f) => f.type === "agent_state" && f.paused === true);
	a.send({ type: "sessions_list" });
	const frame = await a.wait((f) => f.type === "sessions");
	assert.equal(frame.schema, "abito-sessions/view/1");
});

// ----- global pause (#379) ------------------------------------------------------

const makePausedStore = () => {
	const store = { paused: false, writes: [], get() { return store.paused; }, set(value) { store.writes.push(value); store.paused = value; } };
	return store;
};
const fakeConnectors = () => ({ snapshot: async () => ({ catalog: [], connectors: [] }) });
const fakeAgents = (log = {}) => ({
	log,
	async list() { log.listed = (log.listed ?? 0) + 1; return [{ id: "claude-code", state: "not_connected", backup: false, detail: null }]; },
	async connect(id) { log.connected = id; return [{ id, state: "working", backup: false, detail: null }]; },
	async disconnect(id) { log.disconnected = id; return [{ id, state: "not_connected", backup: false, detail: null }]; },
});

test("set_paused: persists, broadcasts agent_state{paused} to every client, resume restores", async (t) => {
	const store = makePausedStore();
	const { server, endpoint } = await setup(t, { pausedStore: store, limits: { maxClients: 5 } });
	const a = await login(t, endpoint);
	const b = await login(t, endpoint);
	a.send({ type: "set_paused", paused: true });
	await b.wait((f) => f.type === "agent_state" && f.paused === true);
	const state = a.frames.find((f) => f.type === "agent_state" && f.paused === true);
	assert.equal(state.busy, false);
	assert.equal(server.paused, true);
	assert.deepEqual(store.writes, [true]);
	// visible to a late client through ready and status
	const c = await login(t, endpoint);
	assert.equal(c.frames[0].state.paused, true);
	a.send({ type: "set_paused", paused: false });
	await a.wait((f) => f.type === "agent_state" && f.paused === false);
	assert.equal(server.paused, false);
	assert.deepEqual(store.writes, [true, false]);
});

test("set_paused: non-boolean reaches the server as bad_request (validator) and changes nothing", async (t) => {
	const store = makePausedStore();
	const { server, endpoint } = await setup(t, { pausedStore: store });
	const a = await login(t, endpoint);
	a.send({ type: "set_paused", paused: "yes" });
	a.send({ type: "set_paused" });
	await waitFor(() => a.frames.filter((f) => f.type === "error").length >= 2);
	assert.ok(a.frames.filter((f) => f.type === "error").every((f) => f.code === "bad_request"));
	assert.equal(server.paused, false);
	assert.deepEqual(store.writes, []);
});

test("while paused, admission verbs are refused with error{paused} and change nothing", async (t) => {
	const store = makePausedStore();
	const connectorCalls = [];
	const connectors = { snapshot: async () => { connectorCalls.push("snap"); return { catalog: [], connectors: [] }; } };
	const agentLog = {};
	const agents = fakeAgents(agentLog);
	const { engine, endpoint } = await setup(t, { pausedStore: store, connectors, agents });
	const a = await login(t, endpoint);
	a.send({ type: "set_paused", paused: true });
	await a.wait((f) => f.type === "agent_state" && f.paused === true);
	const before = a.frames.length;
	for (const frame of [
		{ type: "send", text: "hi" },
		{ type: "steer", text: "go" },
		{ type: "new_conversation" },
		{ type: "agent_connect", agentId: "claude-code" },
		{ type: "connectors_list" },
		{ type: "agents_list" },
	]) a.send(frame);
	await waitFor(() => a.frames.slice(before).filter((f) => f.type === "error").length >= 6);
	assert.ok(a.frames.slice(before).filter((f) => f.type === "error").every((f) => f.code === "paused"), JSON.stringify(a.frames.slice(before)));
	// No turn was admitted, no process-spawning list ran, nothing was persisted again.
	assert.deepEqual(engine.requests, []);
	assert.deepEqual(connectorCalls, []);
	assert.deepEqual(agentLog, {});
	assert.deepEqual(store.writes, [true]);
	// A rejected send never flips busy.
	const st = a.frames.filter((f) => f.type === "agent_state").at(-1);
	assert.equal(st.busy, false);
});

test("while paused, agent_disconnect, abort and read-only verbs stay allowed; resume restores admission", async (t) => {
	const store = makePausedStore();
	const agentLog = {};
	const { engine, endpoint } = await setup(t, { pausedStore: store, connectors: fakeConnectors(), agents: fakeAgents(agentLog) });
	const a = await login(t, endpoint);
	a.send({ type: "set_paused", paused: true });
	await a.wait((f) => f.type === "agent_state" && f.paused === true);
	a.send({ type: "agent_disconnect", agentId: "claude-code" });
	await a.wait((f) => f.type === "agents");
	assert.equal(agentLog.disconnected, "claude-code");
	a.send({ type: "abort" });
	await waitFor(() => engine.requests.some((r) => r.type === "abort"));
	a.send({ type: "accounts_list" });
	await a.wait((f) => f.type === "accounts");
	// resume: a turn is admitted again
	a.send({ type: "set_paused", paused: false });
	await a.wait((f) => f.type === "agent_state" && f.paused === false);
	a.send({ type: "send", text: "hi" });
	await waitFor(() => engine.requests.at(-1)?.type === "prompt");
	assert.deepEqual(engine.requests.at(-1), { type: "prompt", message: "hi" });
});

test("pausing while a turn is active interrupts it (#378): daemon-level cancel, explained closed event, no raw abort", async (t) => {
	const store = makePausedStore();
	const { server, engine, endpoint } = await setup(t, { pausedStore: store });
	const a = await login(t, endpoint);
	engine.hold = true;
	a.send({ type: "send", text: "long turn" });
	await a.wait((f) => f.type === "agent_state" && f.busy === true);
	a.send({ type: "set_paused", paused: true });
	await a.wait((f) => f.type === "agent_state" && f.paused === true);
	assert.equal(engine.interruptedWith, "paused");
	assert.deepEqual(engine.sent, [], "the interruption goes through the cancellation path, not a raw abort");
	const toast = a.frames.find((f) => f.type === "toast" && f.message === "La pausa interrumpió el turno del agente.");
	assert.ok(toast, "a closed event explains why the turn stopped");
	a.send({ type: "send", text: "again" });
	await waitFor(() => a.frames.some((f) => f.type === "error"));
	assert.equal(a.frames.find((f) => f.type === "error").code, "paused");
	assert.equal(engine.requests.length, 1, "no second turn admitted");
	// pausing when idle sends no interrupt
	assert.deepEqual(server.paused, true);
});

test("a boot that starts paused reports it in ready and status; pause without a store still switches in memory", async (t) => {
	const { server, endpoint } = await setup(t, { paused: true });
	const a = await login(t, endpoint);
	assert.equal(a.frames[0].state.paused, true);
	a.send({ type: "status" });
	const st = await a.wait((f) => f.type === "agent_state" && f.paused === true);
	assert.equal(st.busy, false);
	// no persisted store wired: the switch still works in memory
	a.send({ type: "set_paused", paused: false });
	await a.wait((f) => f.type === "agent_state" && f.paused === false);
	assert.equal(server.paused, false);
	a.send({ type: "set_paused", paused: true });
	await waitFor(() => server.paused === true && a.frames.filter((f) => f.type === "agent_state" && f.paused === true).length >= 2);
	assert.equal(server.paused, true);
});

test("set_paused: a persistence failure answers failed, keeps the previous state and changes nothing", async (t) => {
	const store = makePausedStore();
	store.set = () => { throw new Error("disk gone"); };
	const { server, endpoint } = await setup(t, { pausedStore: store });
	const a = await login(t, endpoint);
	a.send({ type: "set_paused", paused: true });
	await a.wait((f) => f.type === "error");
	assert.equal(a.frames.find((f) => f.type === "error").code, "failed");
	assert.equal(server.paused, false);
	// admission still open
	a.send({ type: "send", text: "hi" });
	await waitFor(() => a.frames.some((f) => f.type === "agent_state" && f.busy === true));
});

// ----- HU-041 T6a-1: custom provider account frames, end to end (real manager + store) -----

test("custom provider: create -> key via auth_start/auth_reply -> discovery; guarded activation; nothing secret on the wire", async (t) => {
	const http = require("node:http");
	const { AccountManager, helperEnv } = require("../src/auth.cjs");
	const { ProfileStore } = require("../src/profiles.cjs");
	const root = fs.mkdtempSync(path.join(require("node:fs").realpathSync.native(os.tmpdir()), "abito-srv-custom-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const KEY = "sk-fake-SECRET-2468-DO-NOT-LEAK";
	const hits = [];
	const gateway = http.createServer((req, res) => {
		hits.push(req.headers.authorization);
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ data: [{ id: "model-a" }] }));
	});
	await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
	t.after(() => gateway.close());
	const baseUrl = `http://127.0.0.1:${gateway.address().port}/v1`;
	const accountsRoot = path.join(root, "island", "accounts");
	const manager = new AccountManager({
		accountsRoot,
		helper: { command: process.execPath, args: [path.join(__dirname, "fixtures", "fake-auth.cjs"), "--accounts-root", accountsRoot], env: helperEnv(process.env, { home: root, tmp: root }) },
	});
	t.after(() => manager.close());
	const engine = { status: "ready", async request() { return { success: true }; }, async stop() {}, async start() {} };
	const profiles = new ProfileStore({ islandRoot: path.join(root, "island"), agentDir: path.join(root, "island", "agent"), accounts: () => new Map(manager.listAccounts().map((a) => [a.accountId, a])), engine, restart: async () => {} });
	fs.mkdirSync(path.join(root, "island", "agent"), { recursive: true, mode: 0o700 });
	const server = new IslandServer({ runtimeDir: tmpRuntime(t), token: TOKEN, engine: new FakeEngine(), accounts: manager, profiles });
	const { endpoint } = await server.start();
	t.after(() => server.close().catch(() => {}));
	const c = await login(t, endpoint);

	for (const bad of [{ baseUrl: "http://gateway.example/v1" }, { baseUrl: "https://u:p@gateway.example/v1" }]) c.send({ type: "custom_account_create", label: "GW", ...bad });
	await waitFor(() => c.frames.filter((f) => f.type === "error" && f.code === "bad_request").length === 2);
	assert.deepEqual(manager.listAccounts(), []);

	c.send({ type: "custom_account_create", label: "Gateway", baseUrl });
	assert.deepEqual((await c.wait((f) => f.type === "account")).account, { accountId: "gateway", label: "Gateway", provider: "custom-gateway", authMethod: "none", configured: false, custom: true });
	c.send({ type: "custom_models_refresh", accountId: "gateway" });
	await c.wait((f) => f.type === "error" && f.code === "failed");
	assert.equal(hits.length, 0, "no key: nothing is contacted");

	c.send({ type: "auth_start", accountId: "gateway", method: "api_key" });
	const started = await c.wait((f) => f.type === "auth_started");
	const prompt = await c.wait((f) => f.type === "auth_prompt");
	assert.equal(prompt.secret, true);
	c.send({ type: "auth_reply", flowId: started.flowId, promptId: prompt.promptId, value: KEY });
	assert.equal((await c.wait((f) => f.type === "auth_done")).ok, true);
	c.send({ type: "custom_models_refresh", accountId: "gateway" });
	await waitFor(() => types(c, "account").length === 2);
	assert.equal(hits.at(-1), `Bearer ${KEY}`);
	c.send({ type: "models_list", providerId: "custom-gateway", accountId: "gateway" });
	await c.wait((f) => f.type === "models");

	// T6a-2: the guarded transport is installed on activation (profile frames carry no URL/key).
	c.send({ type: "profile_save", id: "gw", label: "G", role: "main", accountId: "gateway", provider: "custom-gateway", modelId: "model-a" });
	await c.wait((f) => f.type === "profiles" && f.profiles.length === 1);
	c.send({ type: "profile_select", id: "gw" });
	await waitFor(() => profiles.list().active === "gw");
	assert.equal(fs.existsSync(path.join(root, "island", "agent", "extensions", "abito-custom-provider.js")), true);
	assert.equal(JSON.parse(fs.readFileSync(path.join(root, "island", "agent", "custom-provider.json"), "utf8")).baseUrl, baseUrl);
	c.send({ type: "profile_save", id: "bad", label: "B", role: "main", accountId: "gateway", provider: "custom-gateway", modelId: "model-z" });
	await c.wait((f) => f.type === "profiles" && f.profiles.length === 2);
	c.send({ type: "profile_select", id: "bad" });
	await c.wait((f) => f.type === "error" && f.code === "failed");
	assert.equal(profiles.list().active, "gw", "a refused activation changes nothing");

	c.send({ type: "accounts_list" });
	await c.wait((f) => f.type === "accounts" && f.accounts.length === 1 && f.accounts[0].configured === true);
	const wire = JSON.stringify(c.frames);
	for (const banned of [KEY, "sk-fake", "127.0.0.1", "baseUrl"]) assert.equal(wire.includes(banned), false, banned);
});

test("a refused (non-private) credential store reaches the client as the closed code store_not_private, not as a generic failure", async (t) => {
	const { endpoint, accounts } = await setup(t);
	const { CredentialStoreError } = require("../src/auth.cjs");
	accounts.createAccount = async () => { throw new CredentialStoreError(); };
	const c = await login(t, endpoint);
	c.send({ type: "account_create", label: "x", provider: "p" });
	await c.wait((f) => f.type === "error" && f.code === "store_not_private");
});
