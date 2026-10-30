"use strict";
// Public AgentEngine + authenticated Unix-socket tests; no installed Pi/provider.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { AgentEngine } = require("../src/runtime.cjs");
const { IslandServer } = require("../src/server.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
	const end = Date.now() + ms;
	while (!fn() && Date.now() < end) await sleep(5);
	assert.ok(fn(), "public observation timed out");
}
async function rig(t, options = {}, flags = []) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abito-turn-"));
	const commandLog = path.join(dir, "commands");
	const engine = new AgentEngine({
		command: process.execPath,
		commandArgs: [path.join(__dirname, "fixtures", "turn-agent.cjs"), "--command-log", commandLog, ...flags],
		root: path.join(dir, "island"), identityPath: null,
		backoffMs: [10], startTimeoutMs: 2000, stopTimeoutMs: 50, requestTimeoutMs: 2000,
		turnTimeoutMs: 1000, maxTurnIterations: 32, abortGraceMs: 100,
		...options,
	});
	t.after(async () => { await engine.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
	await engine.start();
	const commands = () => fs.readFileSync(commandLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
	const events = [];
	engine.on("event", (e) => events.push(e));
	const emit = (...events) => engine.request({ type: "emit", events });
	const replaced = async (pid) => until(() => engine.status === "ready" && engine.pid !== pid);
	return { engine, commands, emit, events, replaced, dir };
}
const starts = (n) => Array.from({ length: n }, () => ({ type: "turn_start" }));
const delta = (text) => ({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });

test("full-turn deadline survives prompt ACK and steering; abort ACK cannot free admission", async (t) => {
	const { engine, commands, emit, replaced } = await rig(t, { turnTimeoutMs: 150, abortGraceMs: 250 });
	const pid = engine.pid;
	await engine.request({ type: "prompt", message: "held" });
	await emit({ type: "turn_start" }, { type: "turn_end" }, { type: "agent_end" });
	await sleep(80);
	await engine.request({ type: "steer", message: "do not reset the deadline" });
	await until(() => commands().some((c) => c.type === "abort"));
	assert.equal(engine.status, "restarting");
	await assert.rejects(engine.request({ type: "prompt", message: "denied" }), /not ready|busy/);
	assert.equal(commands().filter((c) => c.type === "prompt").length, 1);
	await replaced(pid);
	assert.equal(commands().filter((c) => c.type === "abort").length, 1);
	assert.equal(commands().filter((c) => c.type === "prompt").length, 1, "no replay");
	await engine.request({ type: "prompt", message: "healthy" });
});

test("abort on the 32nd observed turn_start, not tool/delta/turn_end/agent_start signals", async (t) => {
	const { engine, commands, emit, replaced } = await rig(t, { turnTimeoutMs: 10000 });
	const pid = engine.pid;
	await engine.request({ type: "prompt", message: "held" });
	await emit(...starts(31), ...Array.from({ length: 40 }, () => delta("text")),
		{ type: "tool_execution_start", toolName: "read" }, { type: "tool_execution_end", toolName: "read" },
		{ type: "turn_end" }, { type: "agent_start" });
	assert.equal(commands().filter((c) => c.type === "abort").length, 0);
	await emit({ type: "turn_start" }).catch(() => {});
	await until(() => commands().some((c) => c.type === "abort"));
	await replaced(pid);
	assert.equal(commands().filter((c) => c.type === "abort").length, 1);
	assert.equal(commands().filter((c) => c.type === "prompt").length, 1);
});

test("healthy agent_settled clears the full-turn timer, leaves the same child and legacy RPC usable", async (t) => {
	const { engine, commands } = await rig(t, { turnTimeoutMs: 80 });
	const pid = engine.pid;
	await engine.request({ type: "prompt", message: "healthy" });
	await sleep(150);
	assert.equal(engine.pid, pid);
	assert.equal(engine.status, "ready");
	assert.equal(commands().filter((c) => c.type === "abort").length, 0);
	assert.equal((await engine.request({ type: "echo", value: "legacy" })).success, true);
	await engine.request({ type: "new_session" });
	await engine.request({ type: "prompt", message: "healthy" });
	assert.equal(engine.pid, pid);
});

for (const flags of [[], ["--abort-settle"], ["--abort-no-ack"]]) {
	test(`explicit cancellation recycles before a fresh prompt (${flags.join(",") || "ACK only"})`, async (t) => {
		const { engine, commands, events, emit, replaced } = await rig(t, { turnTimeoutMs: 10000 }, flags);
		const pid = engine.pid;
		const session = (await engine.request({ type: "get_state" })).data.sessionFile;
		await engine.request({ type: "prompt", message: "held" });
		await emit({ type: "extension_ui_request", id: "open", method: "confirm", title: "Open" });
		const aborted = engine.request({ type: "abort" }).catch(() => undefined);
		await assert.rejects(engine.request({ type: "prompt", message: "denied" }), /not ready|busy/);
		await replaced(pid);
		await aborted;
		assert.equal(commands().filter((c) => c.type === "abort").length, 1);
		assert.equal(commands().filter((c) => c.type === "prompt").length, 1);
		assert.equal((await engine.request({ type: "get_state" })).data.sessionFile, session);
		assert.ok(!JSON.stringify(events).includes("STALE"), "cancelled child's late output/asks suppressed");
		await engine.request({ type: "prompt", message: "healthy" });
		assert.equal(commands().filter((c) => c.type === "prompt").length, 2);
	});
}

test("lost prompt ACK is ambiguous: one owned cutoff, no replay, then recovery", async (t) => {
	const { engine, commands, replaced } = await rig(t, { requestTimeoutMs: 60, turnTimeoutMs: 10000 });
	const pid = engine.pid;
	await assert.rejects(engine.request({ type: "prompt", message: "lost-ack" }), /did not answer/);
	await replaced(pid);
	assert.equal(commands().filter((c) => c.type === "abort").length, 1);
	assert.equal(commands().filter((c) => c.type === "prompt").length, 1);
});

test("stop cancels turn/grace timers without restart; a later start has no inherited budget", async (t) => {
	const { engine, commands } = await rig(t, { turnTimeoutMs: 100, abortGraceMs: 200 });
	await engine.request({ type: "prompt", message: "held" });
	await engine.request({ type: "abort" });
	await engine.stop();
	const before = commands().length;
	await sleep(350);
	assert.equal(engine.status, "stopped");
	assert.equal(engine.pid, undefined);
	assert.equal(commands().length, before);
	await engine.start();
	await engine.request({ type: "prompt", message: "healthy" });
	await sleep(150);
	assert.equal(engine.status, "ready");
	assert.equal(commands().filter((c) => c.type === "abort").length, 1);
});

test("crash discards the previous turn's timer, restores session and never replays prompt", async (t) => {
	const { engine, commands, replaced } = await rig(t, { turnTimeoutMs: 180 });
	const pid = engine.pid;
	await engine.request({ type: "prompt", message: "held" });
	process.kill(pid, "SIGKILL");
	await replaced(pid);
	await sleep(250);
	assert.equal(engine.status, "ready");
	assert.equal(commands().filter((c) => c.type === "abort").length, 0);
	assert.equal(commands().filter((c) => c.type === "prompt").length, 1);
	await engine.request({ type: "prompt", message: "healthy" });
});

async function socketClient(t, endpoint, token = "t".repeat(43)) {
	const socket = net.connect(endpoint);
	const frames = [];
	let pending = "";
	socket.setEncoding("utf8");
	socket.on("data", (data) => {
		pending += data;
		let lf;
		while ((lf = pending.indexOf("\n")) !== -1) {
			frames.push(JSON.parse(pending.slice(0, lf)));
			pending = pending.slice(lf + 1);
		}
	});
	t.after(() => socket.destroy());
	await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
	const send = (frame) => socket.write(JSON.stringify(frame) + "\n");
	send({ type: "hello", protocol: "island-agent/1", token });
	await until(() => frames.some((f) => f.type === "ready"));
	return { frames, send };
}

test("socket budget cancellation closes asks, preserves busy guards, sanitizes output and permits next conversation only after readiness", async (t) => {
	const { engine, commands, emit, replaced, dir } = await rig(t, { turnTimeoutMs: 10000, maxTurnIterations: 2, abortGraceMs: 200 });
	const profiles = { selected: 0, async select() { this.selected++; }, list() { return { profiles: [] }; }, roles() { return []; } };
	const server = new IslandServer({ engine, profiles, runtimeDir: path.join(dir, "run"), token: "t".repeat(43) });
	const { endpoint } = await server.start();
	t.after(() => server.close());
	const { frames, send } = await socketClient(t, endpoint);
	const pid = engine.pid;
	send({ type: "send", text: "held" });
	await until(() => commands().some((c) => c.type === "prompt"));
	await emit({ type: "extension_ui_request", id: "ask-1", method: "confirm", title: "Confirm" }, ...starts(2),
		delta("STALE"), { type: "extension_ui_request", id: "late", method: "confirm", title: "STALE" });
	await until(() => frames.some((f) => f.type === "ask_resolved" && f.id === "ask-1"));
	send({ type: "profile_select", id: "work" });
	send({ type: "new_conversation" });
	send({ type: "send", text: "denied" });
	await until(() => frames.filter((f) => f.type === "error").length >= 3);
	assert.equal(profiles.selected, 0);
	assert.equal(commands().filter((c) => c.type === "new_session").length, 0);
	assert.equal(commands().filter((c) => c.type === "prompt").length, 1);
	assert.ok(!JSON.stringify(frames).includes("STALE"));
	await replaced(pid);
	send({ type: "new_conversation" });
	await until(() => commands().filter((c) => c.type === "new_session").length === 1);
	send({ type: "send", text: "healthy" });
	await until(() => commands().filter((c) => c.type === "prompt").length === 2);
	await until(() => frames.at(-1)?.type === "agent_state" && frames.at(-1)?.busy === false);
});

test("daemon's existing workspace/config/status guards stay busy through cancellation and replacement readiness", async (t) => {
	const { Daemon, readSession } = require("../src/daemon.cjs");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abito-dturn-"));
	const root = path.join(dir, "i");
	const log = path.join(dir, "commands");
	const daemon = new Daemon({ root, env: { PATH: process.env.PATH }, engineOptions: {
		command: process.execPath,
		commandArgs: [path.join(__dirname, "fixtures", "turn-agent.cjs"), "--command-log", log],
		identityPath: null, turnTimeoutMs: 10000, abortGraceMs: 250, backoffMs: [30], stopTimeoutMs: 50,
	} });
	t.after(async () => { await daemon.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
	const { endpoint } = await daemon.start();
	const { frames, send } = await socketClient(t, endpoint, readSession(root).token);
	send({ type: "send", text: "held" });
	await until(() => daemon.status().busy);
	send({ type: "abort" });
	await until(() => daemon.status().state === "restarting");
	assert.equal(daemon.status().busy, true);
	const saved = fs.readFileSync(path.join(root, "state.json"));
	await assert.rejects(daemon.setWorkspace(dir), /busy: finish or abort the current turn first/);
	await assert.rejects(daemon.applyConfig(), /busy: finish or abort the current turn first/);
	assert.equal(fs.existsSync(path.join(root, "config.json")), false);
	assert.deepEqual(fs.readFileSync(path.join(root, "state.json")), saved);
	await until(() => daemon.status().state === "ready");
	assert.equal(daemon.status().busy, false);
	send({ type: "send", text: "healthy" });
	await until(() => frames.filter((f) => f.type === "agent_state" && f.status === "ready" && !f.busy).length >= 2);
});

test("rejected legacy frames leave persisted session, action counts and public state unchanged", async (t) => {
	const { engine, commands, dir } = await rig(t);
	const server = new IslandServer({ engine, runtimeDir: path.join(dir, "run"), token: "t".repeat(43) });
	const { endpoint } = await server.start();
	t.after(() => server.close());
	const { frames, send } = await socketClient(t, endpoint);
	const savedPath = path.join(dir, "island", "state.json");
	const saved = fs.readFileSync(savedPath);
	const before = commands().length;
	for (const frame of [{ type: "send", text: "" }, { type: "send", text: "x", images: [{ mimeType: "invalid", data: "AA==" }] }, { type: "steer", text: "" }]) send(frame);
	await until(() => frames.filter((f) => f.type === "error").length === 3);
	assert.deepEqual(frames.filter((f) => f.type === "error").map((f) => f.code), ["bad_request", "bad_request", "bad_request"]);
	assert.equal(commands().length, before);
	assert.deepEqual(fs.readFileSync(savedPath), saved);
	send({ type: "status" });
	await until(() => frames.at(-1)?.type === "agent_state");
	assert.equal(frames.at(-1).busy, false);
	assert.equal(frames.at(-1).status, "ready");
});

async function resetDaemon(t, flags = [], options = {}) {
	const { Daemon, readSession } = require("../src/daemon.cjs");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abito-reset-"));
	const root = path.join(dir, "i");
	const log = path.join(dir, "commands");
	const daemon = new Daemon({ root, env: { PATH: process.env.PATH }, engineOptions: {
		command: process.execPath,
		commandArgs: [path.join(__dirname, "fixtures", "turn-agent.cjs"), "--command-log", log, ...flags],
		identityPath: null, turnTimeoutMs: 10000, stopTimeoutMs: 50, backoffMs: [100],
		requestTimeoutMs: 1000, ...options,
	} });
	t.after(async () => { await daemon.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
	const { endpoint } = await daemon.start();
	const client = await socketClient(t, endpoint, readSession(root).token);
	const commands = () => fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
	const saved = () => fs.readFileSync(path.join(root, "state.json"), "utf8");
	return { daemon, root, dir, commands, saved, ...client };
}

test("delayed reset guards public daemon status/send/profile/config/workspace without rejected side effects, then binds the next prompt to its verified session", async (t) => {
	const { daemon, root, dir, commands, saved, send, frames } = await resetDaemon(t, ["--reset-delay"]);
	const before = saved();
	send({ type: "new_conversation" });
	await until(() => commands().some((c) => c.type === "new_session"));
	assert.equal(daemon.status().busy, true);
	send({ type: "send", text: "denied" });
	send({ type: "profile_select", id: "work" });
	send({ type: "new_conversation" });
	await until(() => frames.filter((f) => f.type === "error").length === 3);
	assert.deepEqual(frames.filter((f) => f.type === "error").map((f) => f.code), ["busy", "busy", "busy"]);
	await assert.rejects(daemon.setWorkspace(dir), /busy: finish or abort the current turn first/);
	await assert.rejects(daemon.applyConfig(), /busy: finish or abort the current turn first/);
	assert.equal(saved(), before);
	assert.equal(fs.existsSync(path.join(root, "config.json")), false);
	assert.equal(fs.existsSync(path.join(root, "profiles.json")), false);
	assert.equal(commands().filter((c) => c.type === "prompt").length, 0);
	assert.equal(commands().filter((c) => c.type === "new_session").length, 1);
	await until(() => !daemon.status().busy);
	const after = JSON.parse(saved()).sessionFile;
	assert.notEqual(after, JSON.parse(before).sessionFile);
	send({ type: "send", text: "healthy" });
	await until(() => commands().some((c) => c.type === "prompt"));
	assert.equal(commands().find((c) => c.type === "prompt").sessionFile, after);
	await until(() => !daemon.status().busy);
});

for (const type of ["new_session", "switch_session"]) {
	test(`public engine ${type} takes admission before writing and verifies identity before release`, async (t) => {
		const { engine, commands } = await rig(t, {}, ["--reset-delay"]);
		const original = (await engine.request({ type: "get_state" })).data.sessionFile;
		const changing = engine.request({ type, ...(type === "switch_session" ? { sessionPath: original } : {}) });
		await assert.rejects(engine.request({ type: "prompt", message: "denied" }), /busy/);
		await assert.rejects(engine.request({ type: "new_session" }), /busy/);
		assert.equal((await engine.request({ type: "get_state" })).success, true, "ordinary state reads remain usable");
		await changing;
		const expected = (await engine.request({ type: "get_state" })).data.sessionFile;
		await engine.request({ type: "prompt", message: "healthy" });
		assert.equal(commands().filter((c) => c.type === type).length, 1);
		assert.equal(commands().find((c) => c.type === "prompt").sessionFile, expected);
	});
}

for (const flag of ["--reset-lost", "--reset-fail", "--reset-crash"]) {
	test(`reset failure ${flag} cuts off its owned generation without retry or unverified session admission`, async (t) => {
		const { daemon, commands, saved, send, frames } = await resetDaemon(t, [flag], { requestTimeoutMs: 70 });
		const previous = saved();
		send({ type: "new_conversation" });
		await until(() => frames.some((f) => f.type === "error" && f.code === "failed"));
		assert.equal(daemon.status().busy, true);
		send({ type: "send", text: "denied" });
		await until(() => frames.filter((f) => f.type === "error").length === 2);
		assert.ok(["busy", "unavailable"].includes(frames.filter((f) => f.type === "error").at(-1).code));
		assert.equal(saved(), previous);
		assert.equal(commands().filter((c) => c.type === "new_session").length, 1);
		assert.equal(commands().filter((c) => c.type === "prompt").length, 0);
		await until(() => daemon.status().state === "ready" && !daemon.status().busy);
		assert.equal(saved(), previous, "replacement reopens last verified session, never retries ambiguous reset");
		send({ type: "send", text: "healthy" });
		await until(() => commands().some((c) => c.type === "prompt"));
		assert.equal(commands().find((c) => c.type === "prompt").sessionFile, JSON.parse(previous).sessionFile);
	});
}

test("stop during delayed reset invalidates old callbacks and clears the gate for a later generation", async (t) => {
	const { engine, commands } = await rig(t, {}, ["--reset-delay"]);
	const resetting = engine.request({ type: "new_session" });
	const rejected = assert.rejects(resetting, /exited|stopped|generation/);
	await until(() => commands().some((c) => c.type === "new_session"));
	await engine.stop();
	await rejected;
	assert.equal(engine.status, "stopped");
	assert.equal(engine.busy, false);
	await engine.start();
	const pid = engine.pid;
	await engine.request({ type: "prompt", message: "healthy" });
	await sleep(220);
	assert.equal(engine.pid, pid);
	assert.equal(engine.status, "ready");
	assert.equal(engine.busy, false);
	assert.equal(commands().filter((c) => c.type === "new_session").length, 1);
});

test("cancelled recovery cannot release admission when replacement ACKs reopening but reports another session", async (t) => {
	const { engine, commands } = await rig(t, { backoffMs: [100] }, ["--switch-unconfirmed"]);
	const pid = engine.pid;
	await engine.request({ type: "prompt", message: "held" });
	await engine.request({ type: "abort" });
	await until(() => commands().some((c) => c.type === "switch_session") &&
		commands().filter((c) => c.type === "get_state" && c.pid !== pid).length >= 2);
	await sleep(20);
	assert.notEqual(engine.status, "ready");
	assert.equal(engine.busy, true);
	await assert.rejects(engine.request({ type: "prompt", message: "denied" }), /not ready|busy/);
	assert.equal(commands().filter((c) => c.type === "prompt").length, 1);
});

test("one initialization owns recovery after its first reopen crashes: exact spawns, verified session, no children or timers after stop", { timeout: 10000 }, async (t) => {
	const timeouts = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
	const before = timeouts();
	let observedCommands = () => [];
	// Safety-only cleanup for a failing RED: never hide an orphan from assertions.
	// Register before rig cleanup so its private command log still exists.
	t.after(() => {
		for (const { pid } of observedCommands().filter((c) => c.type === "fixture_spawn")) {
			try {
				const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
				if (cmdline.includes(path.join(__dirname, "fixtures", "turn-agent.cjs"))) process.kill(pid, "SIGKILL");
			} catch {}
		}
	});
	const { engine, commands } = await rig(t, { backoffMs: [40], startTimeoutMs: 300, switchTimeoutMs: 300 }, ["--reopen-crash-once"]);
	observedCommands = commands;
	const initialPid = engine.pid;
	const session = (await engine.request({ type: "get_state" })).data.sessionFile;
	await engine.request({ type: "prompt", message: "held" });
	await engine.request({ type: "abort" });
	await until(() => engine.status === "ready" && engine.pid !== initialPid);
	await sleep(100);
	const spawned = commands().filter((c) => c.type === "fixture_spawn").map((c) => c.pid);
	assert.equal(spawned.length, 3, "initial + failed recovery + exactly one successful recovery");
	assert.equal(new Set(spawned).size, 3);
	assert.equal((await engine.request({ type: "get_state" })).data.sessionFile, session);
	assert.equal(commands().filter((c) => c.type === "prompt").length, 1, "no replay");
	assert.equal(commands().filter((c) => c.type === "switch_session").length, 2);
	await engine.stop();
	for (const pid of spawned) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
	const stoppedCount = commands().length;
	await sleep(350);
	assert.equal(commands().length, stoppedCount, "no stale timer may spawn after stop");
	assert.equal(engine.status, "stopped");
	assert.equal(engine.pid, undefined);
	assert.equal(timeouts(), before, "no runtime timeout remains after stop");
});

test("real-Pi lazy session file: start, prompt and reset work before the file exists", async (t) => {
	const { engine, commands } = await rig(t, {}, ["--lazy-session"]);
	assert.equal(engine.status, "ready");
	const reported = commands().find((c) => c.type === "get_state").sessionFile;
	assert.equal(fs.existsSync(reported), false, "fixture must not pre-create the session file");
	await engine.request({ type: "prompt", message: "healthy" });
	await until(() => !engine.busy);
	assert.equal(fs.existsSync(reported), true);
	await engine.request({ type: "new_session" });
	assert.equal(engine.status, "ready");
});

test("a reported session path outside the private sessions dir is still refused", async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abito-turn-out-"));
	const engine = new AgentEngine({
		command: process.execPath,
		commandArgs: [path.join(__dirname, "fixtures", "turn-agent.cjs"), "--command-log", path.join(dir, "commands"), "--lazy-session", "--session-dir", dir],
		root: path.join(dir, "island"), identityPath: null,
		backoffMs: [10], startTimeoutMs: 2000, stopTimeoutMs: 50, requestTimeoutMs: 2000,
	});
	t.after(async () => { await engine.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
	await assert.rejects(engine.start(), /session is unavailable/);
});

// #378 live interruption: a daemon-level reason (pause, revoked access) must
// interrupt the active turn through the same cancellation path as an explicit
// abort: admission closes, the child is recycled, the session reopens and no
// prompt is ever replayed.
for (const reason of ["paused", "access_revoked"]) {
	test(`daemon-level interruption (${reason}) recycles like cancellation and never replays`, async (t) => {
		const { engine, commands, events, emit, replaced } = await rig(t, { turnTimeoutMs: 10000 }, ["--abort-no-ack"]);
		const pid = engine.pid;
		const session = (await engine.request({ type: "get_state" })).data.sessionFile;
		await engine.request({ type: "prompt", message: "held" });
		await emit({ type: "extension_ui_request", id: "open", method: "confirm", title: "Open" });
		const cancellations = [];
		engine.on("turn_cancelled", (payload) => cancellations.push(payload));
		assert.equal(engine.interruptTurn(reason), true, "an active turn is interrupted");
		await assert.rejects(engine.request({ type: "prompt", message: "denied" }), /not ready|busy/);
		assert.deepEqual(cancellations, [{ reason }], "the closed event carries the daemon-level reason");
		await replaced(pid);
		assert.equal(commands().filter((c) => c.type === "abort").length, 1);
		assert.equal(commands().filter((c) => c.type === "prompt").length, 1, "no replay");
		assert.equal((await engine.request({ type: "get_state" })).data.sessionFile, session);
	});
}

test("daemon-level interruption is a no-op without an active turn", async (t) => {
	const { engine, commands } = await rig(t, { turnTimeoutMs: 10000 });
	assert.equal(engine.interruptTurn("paused"), false);
	assert.equal(commands().filter((c) => c.type === "abort").length, 0);
});
