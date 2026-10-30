"use strict";
// #386 Continuous conversation rotation by summary.
// Deterministic, bounded, offline: a fake RPC engine stands in for Pi; the
// rotation itself must never trigger a model request (no prompt command).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const { AgentEngine } = require("../src/runtime.cjs");
const { IslandServer } = require("../src/server.cjs");
const { Daemon, readSession } = require("../src/daemon.cjs");
const { writePrivateFile } = require("../src/isolation.cjs");
const { buildSummary, SessionRotator } = require("../src/rotation.cjs");

const FAKE = path.join(__dirname, "fixtures", "turn-agent.cjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
	const end = Date.now() + ms;
	while (!fn() && Date.now() < end) await sleep(5);
	assert.ok(fn(), "public observation timed out");
}
function tmp(prefix) {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** 20 user/assistant turns as Pi get_messages would report them (zero-padded: no prefix collisions). */
function twentyTurns() {
	return Array.from({ length: 20 }, (_, i) => [
		{ role: "user", content: `mensaje usuario ${String(i + 1).padStart(2, "0")}` },
		{ role: "assistant", content: `respuesta asistente ${String(i + 1).padStart(2, "0")}` },
	]).flat();
}

function writeMessagesFile(dir, messages) {
	const file = path.join(dir, "messages.json");
	fs.writeFileSync(file, JSON.stringify(messages));
	return file;
}

/** AgentEngine rig over the turn-agent fixture, mirroring turn-budget.test.cjs. */
async function rig(t, options = {}, flags = []) {
	const dir = tmp("abito-rot-");
	const commandLog = path.join(dir, "commands");
	const engine = new AgentEngine({
		command: process.execPath,
		commandArgs: [FAKE, "--command-log", commandLog, ...flags],
		root: path.join(dir, "island"), identityPath: null,
		backoffMs: [10], startTimeoutMs: 2000, stopTimeoutMs: 50, requestTimeoutMs: 2000,
		turnTimeoutMs: 10_000, maxTurnIterations: 32, abortGraceMs: 100,
		...options,
	});
	t.after(async () => { await engine.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
	await engine.start();
	const commands = () => fs.existsSync(commandLog)
		? fs.readFileSync(commandLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
		: [];
	const rotator = new SessionRotator({
		engine,
		log: () => {},
		...(options.rotatorOptions ?? {}),
	});
	t.after(() => rotator.stop());
	return { engine, rotator, commands, dir, commandLog };
}

const settled = () => ({ type: "agent_settled" });
const prompts = (commands) => commands().filter((c) => c.type === "prompt");
const resets = (commands) => commands().filter((c) => c.type === "new_session");

// ---------------------------------------------------------------- buildSummary

test("buildSummary is deterministic for identical input", () => {
	const messages = twentyTurns();
	assert.equal(buildSummary(messages), buildSummary(messages));
	assert.equal(buildSummary(messages, { keepTurns: 3 }), buildSummary(messages, { keepTurns: 3 }));
});

test("buildSummary keeps the last N turns; the total cap drops only older ones", () => {
	// keepTurns is a floor: the last 12 turns are always retained. With a tiny
	// total cap none of the 8 older turns fit, so all of them are dropped.
	const summary = buildSummary(twentyTurns(), { keepTurns: 12, maxChars: 50 });
	assert.ok(summary.includes("mensaje usuario 09"), "first kept turn present");
	assert.ok(summary.includes("respuesta asistente 20"), "last turn present");
	assert.ok(!summary.includes("mensaje usuario 08"), "older turn dropped");
	assert.ok(summary.includes("8 turnos anteriores"), "dropped count is stated");
});

test("buildSummary truncates each message to the per-message cap", () => {
	const long = "x".repeat(500);
	const summary = buildSummary(
		[{ role: "user", content: long }, { role: "assistant", content: "ok" }],
		{ keepTurns: 10, maxCharsPerMessage: 100 },
	);
	assert.ok(summary.length < 400);
	assert.ok(summary.includes("…"), "truncation marker present");
});

test("buildSummary total cap drops only OLDER turns, never the last N, newest older first", () => {
	const messages = twentyTurns();
	const summary = buildSummary(messages, { keepTurns: 3, maxCharsPerMessage: 2000, maxChars: 200 });
	for (let i = 18; i <= 20; i++) assert.ok(summary.includes(`mensaje usuario ${String(i).padStart(2, "0")}`), `turn ${i} retained under the cap`);
	assert.ok(summary.includes("mensaje usuario 17"), "newest older turn fits and is kept");
	assert.ok(!summary.includes("mensaje usuario 14"), "oldest turns are dropped first");
});

test("buildSummary understands string and block content, ignores non-text roles", () => {
	const messages = [
		{ role: "toolResult", content: [{ type: "text", text: "tool noise" }] },
		{ role: "user", content: [{ type: "text", text: "parte uno" }, { type: "image", data: "x" }, { type: "text", text: "parte dos" }] },
		{ role: "assistant", content: [{ type: "thinking", thinking: "secreto" }, { type: "text", text: "respuesta visible" }] },
	];
	const summary = buildSummary(messages, { keepTurns: 5 });
	assert.ok(summary.includes("parte uno\nparte dos"));
	assert.ok(summary.includes("respuesta visible"));
	assert.ok(!summary.includes("tool noise"));
	assert.ok(!summary.includes("secreto"));
});

test("buildSummary returns empty for a message-free conversation", () => {
	assert.equal(buildSummary([]), "");
	assert.equal(buildSummary([{ role: "toolResult", content: "noise" }]), "");
});

// ------------------------------------------------------------ SessionRotator

test("rotation on settled: new session, bounded summary pending, ZERO model requests", async (t) => {
	const dir = tmp("abito-rot-msgs-");
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const messagesFile = writeMessagesFile(dir, twentyTurns());
	const { engine, rotator, commands } = await rig(t, { rotatorOptions: { maxChars: 50 } }, ["--usage-percent", "90", "--messages-file", messagesFile]);
	const before = engine.sessionFile;
	await engine.request({ type: "emit", events: [settled()] });
	await until(() => resets(commands).length === 1);
	assert.equal(prompts(commands).length, 0, "rotation itself triggers no model request");
	assert.equal(engine.status, "ready");
	assert.notEqual(engine.sessionFile, before, "a fresh session is active");
	const decorated = rotator.decoratePrompt("mi mensaje");
	assert.ok(decorated.includes("[Resumen de la conversación anterior"), "Spanish framing");
	assert.ok(decorated.includes("mensaje usuario 20"), "last turn kept");
	assert.ok(!decorated.includes("mensaje usuario 08"), "older turn dropped");
	assert.ok(decorated.endsWith("mi mensaje"), "the user's message follows the summary");
	// Cleared once sent: the next prompt goes through untouched.
	assert.equal(rotator.decoratePrompt("otro"), "otro");
});

test("usage below threshold: no rotation, prompt undecorated", async (t) => {
	const { engine, rotator, commands } = await rig(t, {}, ["--usage-percent", "40"]);
	await engine.request({ type: "emit", events: [settled()] });
	await sleep(150);
	assert.equal(resets(commands).length, 0);
	const result = await rotator.rotateOnce();
	assert.equal(result.rotated, false);
	assert.equal(rotator.decoratePrompt("hola"), "hola");
});

test("missing or null contextUsage fails safe: no rotation", async (t) => {
	{
		const { engine, rotator, commands } = await rig(t, {}, []);
		const result = await rotator.rotateOnce();
		assert.equal(result.rotated, false);
		await engine.request({ type: "emit", events: [settled()] });
		await sleep(100);
		assert.equal(resets(commands).length, 0);
	}
	{
		const { rotator, commands } = await rig(t, {}, ["--usage-null"]);
		const result = await rotator.rotateOnce();
		assert.equal(result.rotated, false);
		assert.equal(resets(commands).length, 0);
	}
});

test("failed summary keeps the old session instead of losing history", async (t) => {
	for (const flags of [["--messages-error"], ["--messages-garbage"]]) {
		const { engine, rotator, commands } = await rig(t, {}, ["--usage-percent", "95", ...flags]);
		const session = engine.sessionFile;
		const result = await rotator.rotateOnce();
		assert.equal(result.rotated, false);
		assert.equal(resets(commands).length, 0, "no new_session when the summary fails");
		assert.equal(engine.sessionFile, session, "old session kept");
		assert.equal(rotator.decoratePrompt("hola"), "hola");
	}
});

test("empty summary (no user/assistant text) does not rotate", async (t) => {
	const dir = tmp("abito-rot-empty-");
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const messagesFile = writeMessagesFile(dir, [{ role: "toolResult", content: "noise" }]);
	const { rotator, commands } = await rig(t, {}, ["--usage-percent", "95", "--messages-file", messagesFile]);
	const result = await rotator.rotateOnce();
	assert.equal(result.rotated, false);
	assert.equal(resets(commands).length, 0);
});

test("rotation is skipped while the engine is busy", async (t) => {
	const dir = tmp("abito-rot-msgs2-");
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const messagesFile = writeMessagesFile(dir, twentyTurns());
	const { engine, rotator, commands } = await rig(t, {}, ["--usage-percent", "90", "--messages-file", messagesFile]);
	await engine.request({ type: "prompt", message: "held" });
	const result = await rotator.rotateOnce();
	assert.equal(result.rotated, false);
	assert.equal(result.reason, "busy");
	assert.equal(resets(commands).length, 0);
	await engine.request({ type: "abort" });
});

test("rotation is skipped while paused (#379)", async (t) => {
	const dir = tmp("abito-rot-msgs3-");
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const messagesFile = writeMessagesFile(dir, twentyTurns());
	const { engine, rotator, commands } = await rig(t, { rotatorOptions: { isPaused: () => true } },
		["--usage-percent", "90", "--messages-file", messagesFile]);
	const result = await rotator.rotateOnce();
	assert.equal(result.rotated, false);
	assert.equal(result.reason, "paused");
	assert.equal(resets(commands).length, 0);
	await engine.request({ type: "echo", value: 1 }); // engine itself was never touched
});

test("failed new_session: the engine recovers the previous session, nothing pending", async (t) => {
	const dir = tmp("abito-rot-msgs4-");
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const messagesFile = writeMessagesFile(dir, twentyTurns());
	const { engine, rotator, commands } = await rig(t, {}, ["--usage-percent", "90", "--messages-file", messagesFile, "--reset-fail"]);
	const session = engine.sessionFile;
	await engine.request({ type: "emit", events: [settled()] });
	await until(() => resets(commands).length === 1);
	await until(() => engine.status === "ready", 5000);
	assert.equal(engine.sessionFile, session, "previous session reopened");
	assert.equal(rotator.decoratePrompt("hola"), "hola", "no summary pending after a failed reset");
});

test("at most one rotation per session, and a pending summary blocks further rotation", async (t) => {
	const dir = tmp("abito-rot-msgs5-");
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const messagesFile = writeMessagesFile(dir, twentyTurns());
	const { engine, rotator, commands } = await rig(t, {}, ["--usage-percent", "90", "--messages-file", messagesFile]);
	await engine.request({ type: "emit", events: [settled()] });
	await until(() => resets(commands).length === 1);
	// Same session, usage still high (fake engine), pending summary already stored.
	rotator.discardPending();
	await engine.request({ type: "emit", events: [settled()] });
	await sleep(150);
	assert.equal(resets(commands).length, 1, "no second rotation for the same session");
	// A pending (never delivered) summary blocks a new rotation: it must not be overwritten.
	rotator.decoratePrompt("consume"); // delivered, pending cleared
	await engine.request({ type: "emit", events: [settled()] });
	await sleep(150);
	assert.equal(resets(commands).length, 1);
});

// --------------------------------------------------------------- config key

const { loadConfig } = require("../src/config.cjs");

test("config rotation key: disabled by default, defaults applied, strict validation", () => {
	const dir = tmp("abito-rot-cfg-");
	process.on("exit", () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
	// Absent key: rotation stays disabled (zero-config behavior unchanged).
	let cfg = loadConfig(dir);
	assert.deepEqual(cfg.rotation, { enabled: false, thresholdPercent: 85, keepTurns: 12 });
	// Explicit opt-in with bounds.
	writePrivateFile(path.join(dir, "config.json"), `${JSON.stringify({ rotation: { enabled: true, thresholdPercent: 70, keepTurns: 5 } })}\n`);
	cfg = loadConfig(dir);
	assert.deepEqual(cfg.rotation, { enabled: true, thresholdPercent: 70, keepTurns: 5 });
	// Invalid subkey, type or range -> ConfigError("rotation"), never a silent flip.
	for (const rotation of [
		{ nope: 1 }, { enabled: "yes" }, { thresholdPercent: 10 }, { thresholdPercent: 101 },
		{ keepTurns: 0 }, { keepTurns: 1.5 }, "yes",
	]) {
		writePrivateFile(path.join(dir, "config.json"), `${JSON.stringify({ rotation })}\n`);
		assert.throws(() => loadConfig(dir), (error) => error.name === "ConfigError" && error.field === "rotation");
	}
});

// ------------------------------------------------- Server wiring (public frames)

async function socketClient(t, endpoint, token) {
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

test("server send frames go through the pending-summary decorator", async (t) => {
	const dir = tmp("abito-rot-srv-");
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const commandLog = path.join(dir, "commands");
	const messagesFile = writeMessagesFile(dir, twentyTurns());
	const engine = new AgentEngine({
		command: process.execPath,
		commandArgs: [FAKE, "--command-log", commandLog, "--usage-percent", "90", "--messages-file", messagesFile, "--settle-all"],
		root: path.join(dir, "island"), identityPath: null,
		backoffMs: [10], startTimeoutMs: 2000, stopTimeoutMs: 50, requestTimeoutMs: 2000,
		turnTimeoutMs: 10_000, abortGraceMs: 100,
	});
	t.after(async () => { await engine.stop(); });
	await engine.start();
	const rotator = new SessionRotator({ engine, log: () => {} });
	t.after(() => rotator.stop());
	const server = new IslandServer({
		runtimeDir: path.join(dir, "run"), token: "t".repeat(43), engine,
		promptDecorator: (message) => rotator.decoratePrompt(message),
	});
	const { endpoint } = await server.start();
	t.after(() => server.close());
	const { send } = await socketClient(t, endpoint, "t".repeat(43));
	const commands = () => fs.readFileSync(commandLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
	// First user turn: no summary pending yet, message goes through as-is.
	send({ type: "send", text: "primero" });
	await until(() => prompts(commands).some((c) => c.message === "primero"));
	await until(() => resets(commands).length === 1, 5000);
	await until(() => engine.sessionFile !== undefined && engine.status === "ready" && !engine.busy);
	// Second user turn: the pending summary is prepended exactly once.
	send({ type: "send", text: "segundo" });
	await until(() => prompts(commands).some((c) => c.message.includes("segundo") && c.message.includes("[Resumen")));
	assert.equal(prompts(commands).filter((c) => c.message === "primero").length, 1, "first prompt undecorated");
	assert.equal(prompts(commands).filter((c) => c.message.includes("segundo")).length, 1);
});

// ------------------------------------------------------- Daemon wiring (public)

test("daemon wiring: rotation after settle decorates only the next send", async (t) => {
	const base = tmp("abito-rot-daemon-");
	t.after(() => fs.rmSync(base, { recursive: true, force: true }));
	const root = path.join(base, "i");
	const commandLog = path.join(base, "commands");
	const messagesFile = writeMessagesFile(base, twentyTurns());
	const logs = [];
	const daemon = new Daemon({
		root,
		env: { PATH: process.env.PATH },
		log: (line) => logs.push(String(line)),
		engineOptions: {
			command: process.execPath,
			commandArgs: [FAKE, "--command-log", commandLog, "--usage-percent", "90", "--messages-file", messagesFile, "--settle-all"],
			backoffMs: [20], stopTimeoutMs: 500, requestTimeoutMs: 3000, startTimeoutMs: 5000,
			turnTimeoutMs: 10_000, abortGraceMs: 200,
		},
	});
	t.after(async () => { await daemon.stop(); });
	// Opt in explicitly: rotation is disabled by default.
	writePrivateFile(path.join(root, "config.json"), `${JSON.stringify({ rotation: { enabled: true, thresholdPercent: 50 } })}\n`);
	await daemon.start();
	const session = readSession(root);
	const { send } = await socketClient(t, session.endpoint, session.token);
	const commands = () => fs.readFileSync(commandLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
	// First turn: undecorated.
	send({ type: "send", text: "primero" });
	await until(() => prompts(commands).some((c) => c.message === "primero"));
	// The settle rotates the conversation.
	await until(() => resets(commands).length === 1, 5000);
	await until(() => daemon.engine.status === "ready" && !daemon.engine.busy && daemon.engine.sessionFile !== undefined);
	// Second turn: carries the summary, exactly once.
	send({ type: "send", text: "segundo" });
	await until(() => prompts(commands).some((c) => c.message.includes("segundo") && c.message.includes("[Resumen")));
	assert.equal(prompts(commands).filter((c) => c.message === "primero").length, 1);
	// The conversation keeps working after rotation.
	send({ type: "send", text: "tercero" });
	await until(() => prompts(commands).some((c) => c.message === "tercero"));
});

test("daemon wiring: a rejected prompt keeps the pending summary for the retry (R6)", async (t) => {
	const base = tmp("abito-rot-r6-");
	t.after(() => fs.rmSync(base, { recursive: true, force: true }));
	const root = path.join(base, "i");
	const commandLog = path.join(base, "commands");
	const messagesFile = writeMessagesFile(base, twentyTurns());
	const daemon = new Daemon({
		root,
		env: { PATH: process.env.PATH },
		log: () => {},
		engineOptions: {
			command: process.execPath,
			commandArgs: [FAKE, "--command-log", commandLog, "--usage-percent", "90", "--messages-file", messagesFile, "--settle-all"],
			backoffMs: [20], stopTimeoutMs: 500, requestTimeoutMs: 3000, startTimeoutMs: 5000,
			turnTimeoutMs: 10_000, abortGraceMs: 200,
		},
	});
	t.after(async () => { await daemon.stop(); });
	writePrivateFile(path.join(root, "config.json"), `${JSON.stringify({ rotation: { enabled: true, thresholdPercent: 50 } })}\n`);
	await daemon.start();
	const session = readSession(root);
	const { frames, send } = await socketClient(t, session.endpoint, session.token);
	const commands = () => fs.readFileSync(commandLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
	send({ type: "send", text: "primero" });
	await until(() => resets(commands).length === 1, 5000);
	await until(() => daemon.engine.status === "ready" && !daemon.engine.busy && daemon.engine.sessionFile !== undefined);
	// The next prompt is rejected by the engine (busy / not ready / lost ACK).
	const realRequest = daemon.engine.request.bind(daemon.engine);
	let rejectNext = true;
	daemon.engine.request = async (command) => {
		if (rejectNext && command.type === "prompt") { rejectNext = false; throw new Error("rejected"); }
		return realRequest(command);
	};
	send({ type: "send", text: "segundo" });
	await until(() => frames.some((f) => f.type === "error" && f.code === "failed"));
	assert.equal(prompts(commands).some((c) => c.message.includes("segundo")), false, "the rejected prompt never reached the engine");
	// The retry still carries the summary: it was not lost with the rejection.
	await until(() => !daemon.engine.busy);
	send({ type: "send", text: "tercero" });
	await until(() => prompts(commands).some((c) => c.message.includes("tercero")));
	assert.ok(prompts(commands).find((c) => c.message.includes("tercero")).message.includes("[Resumen"), "summary delivered on the retry");
	// And exactly once.
	await until(() => !daemon.engine.busy);
	send({ type: "send", text: "cuarto" });
	await until(() => prompts(commands).some((c) => c.message === "cuarto"));
});
