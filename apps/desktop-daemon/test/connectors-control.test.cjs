"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const util = require("node:util");
const { EventEmitter } = require("node:events");
const { ConnectorsControl, ConnectorsControlError } = require("../src/connectors.cjs");

const proposal = "ap-0123456789abcdef0123456789ab";
const digest = "a".repeat(64);
const entry = (over = {}) => ({ key: "notion", label: "Notion", reads: "read", sends: "send", auth: "none", fields: [], read_only_tools_count: 1, ...over });
const pending = (over = {}) => ({ proposalId: proposal, connectorId: "notion", tool: "search", argumentsPreview: "query", argumentsTruncated: false, argumentsSensitive: true, digest, expiresInMs: 5000, ...over });
const record = (over = {}) => ({ id: "notion", label: "Notion", catalog_key: "notion", mode: "read_only", enabled: true, status: { state: "needs_setup" }, revision: 7, configured: false, ...over });
const clone = (value) => structuredClone(value);

class FakeHost extends EventEmitter {
	constructor() {
		super();
		this.status = "ready";
		this.items = [pending()];
		this.records = [record()];
		this.calls = [];
		this.failures = {};
		this.stale = {};
		this.connectSteps = [];
		this.connectorsHook = undefined;
	}
	async pending() { this.calls.push(["pending"]); if (this.failures.pending) throw this.failures.pending; return clone(this.items); }
	async connectors() {
		this.calls.push(["connectors"]);
		if (this.connectorsHook) await this.connectorsHook();
		if (this.failures.connectors) throw this.failures.connectors;
		return { schema: "abito-connectors/view/1", catalog: [], connectors: clone(this.records) };
	}
	async subscribe(enabled) { this.calls.push(["subscribe", enabled]); if (this.failures.subscribe) throw this.failures.subscribe; return { ok: true }; }
	async approve(id, expected) {
		this.calls.push(["approve", id, expected]);
		if (this.failures.approve) throw this.failures.approve;
		if (this.stale.approve) { this.stale.approve = false; throw { code: "stale" }; }
		this.items = this.items.filter((p) => p.proposalId !== id);
		this.emit("pending", clone(this.items));
		return { ok: true };
	}
	async deny(id) {
		this.calls.push(["deny", id]);
		if (this.failures.deny) throw this.failures.deny;
		if (this.stale.deny) { this.stale.deny = false; throw { code: "stale" }; }
		this.items = this.items.filter((p) => p.proposalId !== id);
		this.emit("pending", clone(this.items));
		return { ok: true };
	}
	async connect(id, revision, values) {
		this.calls.push(["connect", id, revision, clone(values)]);
		const step = this.connectSteps.shift();
		if (typeof step === "function") return step.call(this, id, revision, values);
		if (step && Object.hasOwn(step, "throw")) throw step.throw;
		if (step !== undefined) return step;
		if (this.failures.connect) throw this.failures.connect;
		return { ok: true };
	}
	async disconnect(id, revision) {
		this.calls.push(["disconnect", id, revision]);
		if (this.stale.disconnect) { this.stale.disconnect = false; if (this.stale.advanceRevision) this.records[0].revision++; throw { code: "stale" }; }
		if (this.stale.disconnectAgain) { this.stale.disconnectAgain = false; throw { code: "stale" }; }
		if (this.failures.disconnect) throw this.failures.disconnect;
		return { ok: true };
	}
	async setMode(id, mode, revision) {
		this.calls.push(["setMode", id, mode, revision]);
		if (this.stale.setMode) { this.stale.setMode = false; if (this.stale.advanceRevision) this.records[0].revision++; throw { code: "stale" }; }
		if (this.stale.setModeAgain) { this.stale.setModeAgain = false; throw { code: "stale" }; }
		if (this.failures.setMode) throw this.failures.setMode;
		return { ok: true };
	}
	state(value) { this.status = value; this.emit("status", value); }
	changed() { this.emit("pending", clone(this.items)); }
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(fn) {
	for (let i = 0; i < 100; i++) { if (fn()) return; await tick(); }
	assert.ok(fn(), "timed out waiting for control operation");
}
function make(host = new FakeHost(), extra = {}) {
	const logs = [];
	const control = new ConnectorsControl({ host, catalog: async () => [entry()], log: (line) => logs.push(String(line)), ...extra });
	return { host, control, logs };
}
function makeQuiet(host, extra = {}) {
	host.status = "starting";
	const made = make(host, { catalog: async () => [entry({ fields: [{ key: "token", label: "Token", secret: true, optional: false }] })], ...extra });
	host.status = "ready";
	return made;
}
async function beginOneField(control, value = "CONNECT-RETRY-CANARY") {
	const { flowId } = await control.connect("notion");
	await until(() => control.flow?.promptId);
	const flow = control.flow;
	const reply = control.reply(flowId, flow.promptId, value);
	return { flowId, flow, reply };
}
function deferred() {
	let resolvePromise;
	let settled = false;
	const promise = new Promise((done) => { resolvePromise = done; });
	return { promise, resolve() { settled = true; resolvePromise(); }, get settled() { return settled; } };
}

test("subscribes on ready and every restart, removes listeners on close without restart leaks", async () => {
	const host = new FakeHost();
	const { control } = make(host);
	await until(() => host.calls.filter((call) => call[0] === "subscribe").length === 1);
	for (let i = 0; i < 5; i++) { host.state("restarting"); host.state("ready"); }
	await until(() => host.calls.filter((call) => call[0] === "subscribe").length === 6);
	await control.close();
	assert.equal(host.listenerCount("status"), 0);
	assert.equal(host.listenerCount("pending"), 0);
	assert.equal(host.listenerCount("connectors"), 0);
	assert.equal(host.calls.filter((call) => call[0] === "subscribe").length, 6);
});

test("pending refresh joins labels, fails closed, and deduplicates by the stable signature", async () => {
	const host = new FakeHost();
	const { control } = make(host);
	const events = [];
	control.on("pending", (items) => events.push(items));
	const initial = await control.pending();
	assert.equal(initial[0].connector_label, "Notion");
	assert.equal(initial[0].connector_label_truncated, false);
	assert.equal(initial[0].arguments_sensitive, true);
	assert.equal(events.length, 1);
	host.items[0].expiresInMs--;
	host.changed();
	await tick();
	assert.equal(events.length, 1, "expiry countdown alone is not a new card set");
	host.items[0].argumentsPreview = "changed preview";
	host.changed();
	await until(() => events.length === 2);
	host.items[0].argumentsTruncated = true;
	host.changed();
	await until(() => events.length === 3);
	host.records = [];
	host.changed();
	await until(() => events.length === 4);
	assert.equal(events.at(-1)[0].connector_label, "notion");
	host.items = [];
	host.changed();
	await until(() => events.length === 5);
	host.items = [pending()];
	host.state("restarting");
	await until(() => events.at(-1).length === 0);
	await control.close();
});

test("approve and deny force pending plus live connectors; stale is classified from fresh state", async () => {
	const host = new FakeHost();
	const { control } = make(host);
	const pendingEvents = [];
	const connectorEvents = [];
	control.on("pending", (items) => pendingEvents.push(items));
	control.on("connectors", (items) => connectorEvents.push(items));
	await control.approve(proposal, digest);
	assert.equal(pendingEvents.at(-1).length, 0);
	assert.equal(connectorEvents.at(-1).live, true);
	host.items = [pending({ proposalId: "ap-1123456789abcdef0123456789ab" })];
	await control.deny("ap-1123456789abcdef0123456789ab");
	assert.equal(pendingEvents.at(-1).length, 0);
	host.items = [pending({ proposalId: proposal, digest: digest.toUpperCase() })];
	host.stale.approve = true;
	await assert.rejects(control.approve(proposal, digest), (error) => error.code === "unknown_proposal");
	host.items = [pending({ proposalId: proposal, digest: "b".repeat(64) })];
	host.stale.approve = true;
	await assert.rejects(control.approve(proposal, digest), (error) => error.code === "digest_mismatch");
	host.items = [];
	host.stale.deny = true;
	await assert.rejects(control.deny(proposal), (error) => error.code === "unknown_proposal");
	assert.ok(pendingEvents.length >= 4);
	assert.ok(connectorEvents.length >= 4);
	await control.close();
});

test("disconnect and mode fetch revisions and retry one stale result only; no implicit mode changes", async () => {
	const host = new FakeHost();
	const { control } = make(host);
	host.stale.disconnect = true;
	host.stale.advanceRevision = true;
	await control.disconnect("notion");
	assert.deepEqual(host.calls.filter((call) => call[0] === "disconnect").map((call) => call.slice(1)), [["notion", 7], ["notion", 8]]);
	assert.equal(host.calls.filter((call) => call[0] === "setMode").length, 0, "start and disconnect never select a mode");
	await control.setMode("notion", "read_only");
	assert.deepEqual(host.calls.filter((call) => call[0] === "setMode").map((call) => call.slice(1)), [["notion", "read_only", 8]]);
	host.stale.setMode = true;
	host.stale.advanceRevision = true;
	await control.setMode("notion", "read_and_send");
	assert.deepEqual(host.calls.filter((call) => call[0] === "setMode").map((call) => call.slice(1)), [
		["notion", "read_only", 8], ["notion", "read_and_send", 8], ["notion", "read_and_send", 9],
	]);
	host.stale.disconnect = true;
	host.stale.disconnectAgain = true;
	await assert.rejects(control.disconnect("notion"), (error) => error.code === "busy");
	host.stale.setMode = true;
	host.stale.setModeAgain = true;
	await assert.rejects(control.setMode("notion", "read_only"), (error) => error.code === "busy");
	host.records = [];
	await assert.rejects(control.setMode("notion", "read_only"), (error) => error.code === "bad_request");
	await control.close();
});

test("connect setup prompts fields in order, omits empty optional fields, and keeps canaries private", async () => {
	const host = new FakeHost();
	const secret = "SETUP-CANARY-SECRET";
	const { control, logs } = make(host, { catalog: async () => [entry({ fields: [
		{ key: "token", label: "Access token", secret: true, optional: false },
		{ key: "nickname", label: "Nickname", secret: false, optional: true },
	] })] });
	const prompts = [];
	const done = [];
	control.on("auth_prompt", (frame) => prompts.push(frame));
	control.on("auth_done", (frame) => done.push(frame));
	const { flowId } = await control.connect("notion");
	const flowObject = control.flow;
	await until(() => prompts.length === 1);
	assert.equal(prompts[0].message, "Access token");
	assert.equal(prompts[0].secret, true);
	await control.reply(flowId, prompts[0].promptId, secret);
	await until(() => prompts.length === 2);
	assert.equal(prompts[1].optional, true);
	const dumpsDuringFlow = [JSON.stringify(control), util.inspect(control, { depth: 8, showHidden: true }), JSON.stringify(flowObject), util.inspect(flowObject, { depth: 8, showHidden: true })];
	assert.ok(dumpsDuringFlow.every((dump) => !dump.includes(secret)));
	await control.reply(flowId, prompts[1].promptId, "");
	await until(() => done.length === 1);
	assert.deepEqual(host.calls.find((call) => call[0] === "connect"), ["connect", "notion", 7, { token: secret }]);
	const dumps = [JSON.stringify(control), util.inspect(control, { depth: 8, showHidden: true }), JSON.stringify(flowObject), util.inspect(flowObject, { depth: 8, showHidden: true })];
	assert.ok(dumps.every((dump) => !dump.includes(secret)));
	assert.ok(!logs.join("\n").includes(secret));
	assert.ok(!JSON.stringify([...prompts, ...done]).includes(secret));
	assert.equal(done[0].ok, true);
	await control.close();
});

test("required empty answers and provider OAuth fail without host connect; second setup flow is busy", async () => {
	const host = new FakeHost();
	const { control } = make(host, { catalog: async () => [entry({ fields: [{ key: "key", label: "Key", secret: true, optional: false }] })] });
	const completed = [];
	control.on("auth_done", (frame) => completed.push(frame));
	const flow = await control.connect("notion");
	await until(() => control.flow?.promptId);
	await assert.rejects(control.connect("notion"), (error) => error.code === "busy");
	await control.reply(flow.flowId, control.flow.promptId, "");
	await until(() => completed.length === 1);
	assert.equal(completed[0].message, "needs_setup");
	assert.equal(host.calls.some((call) => call[0] === "connect"), false);
	await control.close();
	const oauth = make(new FakeHost(), { catalog: async () => [entry({ auth: "provider_oauth" })] });
	await assert.rejects(oauth.control.connect("notion"), (error) => error.code === "unavailable");
	assert.equal(oauth.control.listenerCount("auth_prompt"), 0);
	await oauth.control.close();
});

test("connect results use only closed auth_done codes, including the shipped fail-closed unavailable result", async () => {
	for (const [hostCode, expected] of [["unavailable", "unavailable"], ["bad_request", "needs_setup"], ["failed", "signin_failed"], ["busy", "busy"], ["rate_limited", "busy"], ["private-detail", "signin_failed"]]) {
		const host = new FakeHost();
		host.failures.connect = { code: hostCode, message: "SECRET-CANARY" };
		const { control } = make(host, { catalog: async () => [entry()] });
		const done = [];
		const connectorEvents = [];
		control.on("auth_done", (frame) => done.push(frame));
		control.on("connectors", (frame) => connectorEvents.push(frame));
		await control.connect("notion");
		await until(() => done.length === 1);
		await until(() => connectorEvents.length > 0);
		assert.equal(connectorEvents.at(-1).live, true, `refresh after connect result: ${hostCode}`);
		assert.equal(done[0].message, expected, hostCode);
		assert.equal(host.calls.filter((call) => call[0] === "connect").length, 1, hostCode);
		assert.ok(!JSON.stringify(done).includes("SECRET-CANARY"));
		await control.close();
	}
	const missing = make(new FakeHost(), { catalog: async () => { throw new Error("PRIVATE-PATH"); } });
	await assert.rejects(missing.control.connect("notion"), (error) => error.code === "bad_request");
	await missing.control.close();
});

test("connect never retries a stale: one host.connect, busy, values cleared, live list refreshed", async () => {
	const cases = [
		["pre-apply revision bump", function () { this.records[0].revision = 8; throw { code: "stale" }; }],
		["record absent", function () { this.records = []; throw { code: "stale" }; }],
		["configured meanwhile", function () { this.records[0].configured = true; throw { code: "stale" }; }],
		["unreadable re-read", function () { this.connectorsHook = async () => { throw new Error("PRIVATE-READ-DETAIL"); }; throw { code: "stale" }; }],
	];
	for (const [name, step] of cases) {
		const host = new FakeHost();
		const { control, logs } = makeQuiet(host);
		const secret = `NO-RETRY-SECRET-${name.length}`;
		const done = [];
		control.on("auth_done", (frame) => done.push(frame));
		host.connectSteps = [step, { ok: true }];
		const attempt = await beginOneField(control, secret);
		await attempt.reply;
		const calls = host.calls.filter((call) => call[0] === "connect");
		assert.equal(calls.length, 1, name);
		assert.equal(done.length, 1, name);
		assert.equal(done[0].ok, false, name);
		assert.equal(done[0].message, "busy", name);
		assert.equal(Object.keys(attempt.flow.values).length, 0, name);
		assert.ok(host.calls.some((call) => call[0] === "connectors"), `${name}: live list refreshed`);
		assert.ok(![JSON.stringify(done), logs.join("\n")].some((text) => text.includes(secret) || text.includes("PRIVATE-READ-DETAIL")), name);
		await control.close();
	}
});

test("regression: applied connect -> stale -> concurrent disconnect -> configured=false sends the secret exactly once", async () => {
	const host = new FakeHost();
	const { control } = makeQuiet(host);
	const secret = "APPLIED-THEN-DISCONNECTED-SECRET";
	const done = [];
	control.on("auth_done", (frame) => done.push(frame));
	// Post-seal stale: the host applied the values, then reports stale; a concurrent actor
	// disconnects before anything re-reads, so the record shows configured=false.
	host.connectSteps = [function () { this.records[0].configured = false; throw { code: "stale" }; }, { ok: true }];
	const attempt = await beginOneField(control, secret);
	await attempt.reply;
	const sends = host.calls.filter((call) => call[0] === "connect" && JSON.stringify(call[3]).includes(secret));
	assert.equal(sends.length, 1, "secret sent exactly once");
	assert.equal(host.calls.filter((call) => call[0] === "connect").length, 1);
	assert.equal(done.length, 1);
	assert.equal(done[0].message, "busy");
	assert.equal(Object.keys(attempt.flow.values).length, 0);
	await control.close();
});

test("cancel or close while connect is in flight does not send a second connect", async () => {
	for (const ending of ["cancel", "close"]) {
		const host = new FakeHost();
		const { control } = makeQuiet(host);
		const entered = deferred();
		const release = deferred();
		host.connectSteps = [async function () { entered.resolve(); await release.promise; throw { code: "stale" }; }];
		const done = [];
		control.on("auth_done", (frame) => done.push(frame));
		const attempt = await beginOneField(control, `${ending}-SECRET`);
		await until(() => entered.settled);
		if (ending === "cancel") await control.cancel(attempt.flowId);
		else await control.close();
		release.resolve();
		await attempt.reply;
		assert.equal(host.calls.filter((call) => call[0] === "connect").length, 1, ending);
		assert.equal(done.length, 1, ending);
		assert.equal(Object.keys(attempt.flow.values).length, 0, ending);
		assert.ok(!JSON.stringify(done).includes(`${ending}-SECRET`));
		await control.close();
	}
});

test("approve and deny never retry stale; refresh failure after applied approve is swallowed (outcome not announced until pending confirms; no blind repeat)", async () => {
	const host = new FakeHost();
	const { control, logs } = makeQuiet(host);
	host.stale.approve = true;
	await assert.rejects(control.approve(proposal, digest), (error) => error.code === "unknown_proposal");
	assert.equal(host.calls.filter((call) => call[0] === "approve").length, 1);
	host.stale.deny = true;
	await assert.rejects(control.deny(proposal), (error) => error.code === "unknown_proposal");
	assert.equal(host.calls.filter((call) => call[0] === "deny").length, 1);
	host.failures.pending = { code: "failed", message: "PRIVATE-REFRESH-DETAIL" };
	await control.approve(proposal, digest);
	assert.equal(host.calls.filter((call) => call[0] === "approve").length, 2);
	assert.ok(logs.includes("connector decision refresh failed"));
	assert.ok(!logs.join("\\n").includes("PRIVATE-REFRESH-DETAIL"));
	await control.close();
});

test("prompt timeout, cancel, close, host loss, and fail-closed host errors clear flows", async () => {
	const host = new FakeHost();
	const timers = [];
	const cleared = [];
	const { control } = make(host, {
		catalog: async () => [entry({ fields: [
			{ key: "token", label: "Token", secret: true, optional: false },
			{ key: "name", label: "Name", secret: false, optional: true },
		] })],
		setTimer(fn, ms) { const timer = { fn, ms }; timers.push(timer); return timer; },
		clearTimer(timer) { cleared.push(timer); },
		promptTimeoutMs: 100,
	});
	const ended = [];
	control.on("auth_done", (frame) => ended.push(frame));
	const first = await control.connect("notion");
	await until(() => control.flow?.promptId);
	const promptTimer = timers.find((timer) => timer.ms === 100);
	promptTimer.fn();
	await until(() => ended.length === 1);
	assert.equal(ended[0].message, "needs_setup");
	const second = await control.connect("notion");
	await until(() => control.flow?.promptId);
	const cancelledFlow = control.flow;
	await control.reply(second.flowId, control.flow.promptId, "CANCEL-CANARY");
	await until(() => control.flow?.promptId);
	await control.cancel(second.flowId);
	await until(() => ended.length === 2);
	assert.equal(JSON.parse(JSON.stringify(cancelledFlow)).collectedValues, 0, "cancel clears collected setup values");
	const third = await control.connect("notion");
	await until(() => control.flow?.promptId);
	host.state("restarting");
	await until(() => ended.length === 3);
	assert.equal(ended[2].message, "unavailable");
	assert.equal(control.flow?.promptId, undefined);
	assert.ok(cleared.length >= 2);
	await control.close();
	assert.notEqual(first.flowId, third.flowId);
});

test("closing an active setup flow clears values and detaches host listeners", async () => {
	const host = new FakeHost();
	const { control } = make(host, { catalog: async () => [entry({ fields: [
		{ key: "token", label: "Token", secret: true, optional: false },
		{ key: "name", label: "Name", secret: false, optional: true },
	] })] });
	const ended = [];
	control.on("auth_done", (frame) => ended.push(frame));
	const flow = await control.connect("notion");
	const flowObject = control.flow;
	await until(() => control.flow?.promptId);
	await control.reply(flow.flowId, control.flow.promptId, "CLOSE-CANARY");
	await until(() => control.flow?.promptId);
	await control.close();
	assert.equal(JSON.parse(JSON.stringify(flowObject)).collectedValues, 0);
	assert.equal(ended[0].message, "unavailable");
	assert.equal(host.listenerCount("status"), 0);
	assert.equal(host.listenerCount("pending"), 0);
	assert.equal(host.listenerCount("connectors"), 0);
	const diagnostic = JSON.parse(JSON.stringify(control));
	assert.equal(diagnostic.listeners, 0);
	assert.equal(diagnostic.activeFlows, 0);
});

test("host errors map to closed codes, and diagnostics reveal only state counts", async () => {
	const host = new FakeHost();
	const { control } = make(host);
	host.failures.approve = { code: "busy" };
	await assert.rejects(control.approve(proposal, digest), (error) => error instanceof ConnectorsControlError && error.code === "busy");
	host.failures.approve = { code: "unavailable" };
	await assert.rejects(control.approve(proposal, digest), (error) => error.code === "unavailable");
	const diagnostic = JSON.parse(JSON.stringify(control));
	assert.deepEqual(Object.keys(diagnostic).sort(), ["activeFlows", "listeners", "pendingItems"]);
	assert.equal(diagnostic.activeFlows, 0);
	assert.equal(typeof diagnostic.listeners, "number");
	await control.close();
});
