"use strict";
// K2-05 T3 (S2): Gentle Dot's transparent rotation, ported to Koda.
//
// The chat stays ONE continuous conversation: when the open session file passes
// the size or compaction limits, the daemon writes a NEW session file seeded
// with ONE hidden custom message (customType "abito.handoff", display:false)
// carrying the earlier conversation, switches the engine to it with
// `switch_session`, and verifies the handoff reached the engine's context. The
// island never sees a frame, a summary, or an extra user message — nothing to
// decorate a prompt with, unlike #386's visible Spanish frame.
//
// Offline and deterministic: a fake RPC engine stands in for Gentle Shell; the
// rotation itself must never trigger a model request (no prompt command), and
// any failure leaves the chat in the current session (no data loss).
//
// Port of gentle-dot packages/daemon/src/rotation.ts (MIT) — see
// THIRD-PARTY-NOTICES.md.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { AgentEngine } = require("../src/runtime.cjs");
const { Daemon, readSession } = require("../src/daemon.cjs");
const { writePrivateFile } = require("../src/isolation.cjs");
const { DEFAULT_ROTATION, HANDOFF_TYPE, SESSION_VERSION, SessionRotator, handoffText, writeHandoffSession, rotationLimits } = require("../src/rotation.cjs");

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

/** One previous session file: a v3 header plus pre-compacted entries. */
function writeSessionFile(dir, name, entries, header = {}) {
	const file = path.join(dir, name);
	const lines = [
		JSON.stringify({ type: "session", version: SESSION_VERSION, id: "prev", timestamp: new Date().toISOString(), cwd: dir, ...header }),
		...entries.map((entry) => JSON.stringify(entry)),
	];
	fs.writeFileSync(file, `${lines.join("\n")}\n`);
	return file;
}

const message = (role, text) => ({ type: "message", message: { role, content: text } });

/** 20 user/assistant messages as Pi records them (zero-padded: no prefix collisions). */
function twentyMessages() {
	return Array.from({ length: 20 }, (_, i) => [
		message("user", `mensaje usuario ${String(i + 1).padStart(2, "0")}`),
		message("assistant", `respuesta asistente ${String(i + 1).padStart(2, "0")}`),
	]).flat();
}

/** A session file that holds the given raw JSON records (compactions, ...). */
function writeCompactedFile(dir, name, compactions) {
	return writeSessionFile(dir, name, compactions.map((summary) => ({ type: "compaction", summary })));
}

/** A get_messages answer that contains the handoff, so verification passes. */
function writeHandoffMessages(dir, content = "handoff text") {
	const file = path.join(dir, "messages.json");
	fs.writeFileSync(file, JSON.stringify([{ role: "custom", customType: HANDOFF_TYPE, content, display: false }]));
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
	/** The handoff messages file lives next to the command log, in the rig dir. */
	const rotator = new SessionRotator(engine, {
		log: () => {},
		limits: { ...DEFAULT_ROTATION, ...(options.rotatorLimits ?? {}) },
		...(options.rotatorOptions ?? {}),
	});
	t.after(() => rotator.stop());
	return { engine, rotator, commands, dir, commandLog };
}

const switches = (commands) => commands().filter((c) => c.type === "switch_session");
const prompts = (commands) => commands().filter((c) => c.type === "prompt");
const resets = (commands) => commands().filter((c) => c.type === "new_session");
/** Makes the engine's open session file pass the size limit. */
const bloat = (engine, bytes = 4096) => fs.appendFileSync(engine.sessionFile, "x".repeat(bytes));

// ------------------------------------------------------------------ limits

test("Gentle Dot's limits: 20 MB or 10 compactions, env-overridable", () => {
	assert.deepEqual(DEFAULT_ROTATION, { bytes: 20 * 1024 * 1024, compactions: 10 });
	assert.deepEqual(rotationLimits({}), DEFAULT_ROTATION);
	assert.deepEqual(
		rotationLimits({ ABITO_ROTATE_BYTES: "4096", ABITO_ROTATE_COMPACTIONS: "3" }),
		{ bytes: 4096, compactions: 3 },
	);
	// Invalid values fall back to the default, never to zero or nonsense.
	assert.deepEqual(rotationLimits({ ABITO_ROTATE_BYTES: "lots", ABITO_ROTATE_COMPACTIONS: "0" }), DEFAULT_ROTATION);
	// A config value wins over the default; the env wins over the config.
	assert.deepEqual(rotationLimits({}, { bytes: 1000, compactions: 2 }), { bytes: 1000, compactions: 2 });
	assert.deepEqual(
		rotationLimits({ ABITO_ROTATE_BYTES: "4096" }, { bytes: 1000, compactions: 2 }),
		{ bytes: 4096, compactions: 2 },
	);
});

test("rotates by size, not by context percent", async (t) => {
	const dir = tmp("abito-rot-size-");
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const messagesFile = writeHandoffMessages(dir);
	const { engine, rotator, commands } = await rig(t, { rotatorLimits: { bytes: 1000 } }, ["--messages-file", messagesFile]);
	const first = engine.sessionFile;
	bloat(engine, 1001);
	const rotated = await rotator.maybeRotate();
	assert.equal(rotated, true);
	assert.equal(resets(commands).length, 0, "rotation never resets the engine");
	assert.equal(prompts(commands).length, 0, "rotation itself triggers no model request");
	assert.equal(switches(commands).length, 1, "the engine is told to switch to the seeded session");
	await until(() => engine.sessionFile !== first && engine.sessionFile !== undefined);
	assert.equal(engine.sessionFile, switches(commands)[0].sessionPath);
});

test("rotates after enough compactions; one below the limit does nothing", async (t) => {
	const dir = tmp("abito-rot-comp-");
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const messagesFile = writeHandoffMessages(dir);
	const { engine, rotator, commands } = await rig(t, { rotatorLimits: { compactions: 2 } }, ["--messages-file", messagesFile]);
	const first = engine.sessionFile;
	fs.writeFileSync(first, `${JSON.stringify({ type: "session", version: SESSION_VERSION, id: "p", timestamp: new Date().toISOString(), cwd: dir })}\n${JSON.stringify({ type: "compaction", summary: "one" })}\n`);
	assert.equal(await rotator.maybeRotate(), false, "one compaction is below the limit");
	assert.equal(switches(commands).length, 0);
	fs.appendFileSync(first, `${JSON.stringify({ type: "compaction", summary: "two" })}\n`);
	assert.equal(await rotator.maybeRotate(), true);
	await until(() => engine.sessionFile !== first);
});

test("does nothing below both limits: no engine request at all", async (t) => {
	const dir = tmp("abito-rot-below-");
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const { engine, rotator, commands } = await rig(t);
	bloat(engine, 64);
	assert.equal(await rotator.maybeRotate(), false);
	// The spawn and the engine's own boot get_state are not the rotation's doing.
	const rotationCommands = commands().filter((c) => c.type !== "fixture_spawn" && c.type !== "get_state");
	assert.deepEqual(rotationCommands, [], "below the limits the engine is never touched");
});

test("fail closed: a session header of another version skips rotation", async (t) => {
	const dir = tmp("abito-rot-ver-");
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const messagesFile = writeHandoffMessages(dir);
	const logs = [];
	const { engine, rotator, commands } = await rig(t, { rotatorLimits: { bytes: 100 }, rotatorOptions: { log: (line) => logs.push(line) } }, ["--messages-file", messagesFile]);
	const first = engine.sessionFile;
	fs.writeFileSync(first, `${JSON.stringify({ type: "session", version: 4, id: "p", timestamp: new Date().toISOString(), cwd: dir })}\n`);
	assert.equal(await rotator.maybeRotate(), false, "an unknown session version never rotates");
	assert.equal(switches(commands).length, 0);
	assert.ok(logs.some((line) => line.includes("version")), "the skip is logged");
	// With the engine's own version the same session rotates.
	fs.writeFileSync(first, `${JSON.stringify({ type: "session", version: SESSION_VERSION, id: "p", timestamp: new Date().toISOString(), cwd: dir })}\n`);
	assert.equal(await rotator.maybeRotate(), true);
});

test("rotation is skipped while the engine is busy or the chat is not idle", async (t) => {
	const dir = tmp("abito-rot-busy-");
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const messagesFile = writeHandoffMessages(dir);
	const { engine, rotator, commands } = await rig(t, { rotatorLimits: { bytes: 100 } }, ["--messages-file", messagesFile]);
	bloat(engine);
	await engine.request({ type: "prompt", message: "held" });
	assert.equal(await rotator.maybeRotate(), false, "never rotates under a running turn");
	assert.equal(switches(commands).length, 0);
	await engine.request({ type: "abort" });
	{
		const logs = [];
		const idle = new SessionRotator(engine, {
			limits: { ...DEFAULT_ROTATION, bytes: 100 },
			canRotate: () => false,
			log: (line) => logs.push(line),
		});
		t.after(() => idle.stop());
		assert.equal(await idle.maybeRotate(), false, "canRotate()=false blocks the rotation");
		assert.equal(switches(commands).length, 0);
	}
});

test("only one rotation at a time; a session already rotated is left alone", async (t) => {
	const dir = tmp("abito-rot-once-");
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const messagesFile = writeHandoffMessages(dir);
	const { engine, rotator, commands } = await rig(t, { rotatorLimits: { bytes: 100 } }, ["--messages-file", messagesFile]);
	const first = engine.sessionFile;
	bloat(engine);
	assert.equal(await rotator.maybeRotate(), true);
	// The seed is also over the tiny size limit, but only one rotation runs at a time:
	const inFlight = rotator.maybeRotate();
	assert.equal(await rotator.maybeRotate(), false, "a second concurrent rotation is refused");
	assert.equal(await inFlight, true, "the in-flight rotation completes on the oversized session");
	assert.notEqual(engine.sessionFile, first);
});

// ----------------------------------------------------- handoff content/limits

test("handoffText prefers the latest compaction summary", async (t) => {
	const dir = tmp("abito-rot-hcomp-");
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const file = writeCompactedFile(dir, "s.jsonl", ["primero", "segundo", "tercero"]);
	const text = handoffText(file);
	assert.ok(text.startsWith("This conversation continues from an earlier session"), "Gentle Dot's intro");
	assert.ok(text.includes("Summary of the conversation so far:"), "compaction framing");
	assert.ok(text.includes("tercero"), "the LATEST summary travels");
	assert.ok(!text.includes("primero\n\nSummary"), "earlier summaries are not re-summarized");
});

test("handoffText without compactions: the last 12 user/assistant messages, 2000 chars each", async (t) => {
	const dir = tmp("abito-rot-hmsg-");
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const file = writeSessionFile(dir, "s.jsonl", twentyMessages());
	const text = handoffText(file);
	assert.ok(text.includes("User: mensaje usuario 20"), "the newest message is kept");
	assert.ok(text.includes("User: usuario 15".replace("usuario", "mensaje usuario")), "the last 12 messages start here");
	assert.ok(text.includes("Assistant: respuesta asistente 15"), "the last 12 messages (of 40) are kept");
	assert.ok(!text.includes("mensaje usuario 14"), "older messages are dropped");
	// A 3000-char message inside the last 12 is truncated at 2000 chars with Gentle Dot's marker.
	const filler = Array.from({ length: 11 }, (_, i) => [message("user", `lleno ${i}`), message("assistant", `ok ${i}`)]).flat();
	const file2 = writeSessionFile(dir, "long.jsonl", [...filler, message("user", "y".repeat(3000))]);
	const text3 = handoffText(file2);
	assert.match(text3, /^User: y{2000}…$/m, "truncation marker from Gentle Dot");
	assert.ok(!text3.includes("yyyyyyyy" + "y".repeat(2000) + "y"), "nothing beyond 2000 chars survives");
});

test("handoffText links the previous handoff so history keeps crossing rotations", async (t) => {
	const dir = tmp("abito-rot-hprev-");
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const handoff = { type: "custom_message", customType: HANDOFF_TYPE, content: "This conversation continues from an earlier session that grew too long. The user sees one continuous chat and cannot see this note; carry on naturally and do not mention it.\n\nEarlier context:\n\nAntes del rotado anterior.", display: false };
	const file = writeSessionFile(dir, "s.jsonl", [handoff, message("user", "hola")]);
	const text = handoffText(file);
	assert.ok(text.includes("Earlier context:"), "the earlier context is carried");
	assert.ok(text.includes("Antes del rotado anterior."), "the previous handoff's knowledge survives");
	assert.ok(text.includes("User: hola"), "the latest messages ride along");
	assert.equal(text.split("This conversation continues").length - 1, 1, "exactly one intro line");
});

test("handoffText skips torn or non-message lines", async (t) => {
	const dir = tmp("abito-rot-htorn-");
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const file = path.join(dir, "torn.jsonl");
	fs.writeFileSync(file, `${JSON.stringify({ type: "session", version: SESSION_VERSION, id: "p", timestamp: new Date().toISOString(), cwd: dir })}\n${JSON.stringify(message("user", "visible"))}\n{"type":"message","mess\nnot json at all\n${JSON.stringify({ type: "toolResult", content: "ruido" })}\n`);
	const text = handoffText(file);
	assert.ok(text.includes("User: visible"), "the intact message is read");
	assert.ok(!text.includes("ruido"), "tool results are not conversation");
});

// --------------------------------------------------------- handoff file shape

test("writeHandoffSession: one hidden custom_message in a v3 session next to the previous one", async (t) => {
	const dir = tmp("abito-rot-seed-");
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const previous = writeSessionFile(dir, "prev.jsonl", twentyMessages());
	const file = await writeHandoffSession(previous, "Summary: el usuario planea un viaje.");
	assert.equal(path.dirname(file), dir, "the seed lives next to the previous session");
	const id = path.basename(file);
	assert.match(
		id,
		/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z_[0-9a-f-]{36}\.jsonl$/,
		"Pi's own naming: <ISO timestamp with : and . as ->_<uuid>.jsonl",
	);
	const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(lines.length, 2, "header + the handoff, nothing else");
const [header, handoff] = lines;
assert.equal(header.type, "session");
assert.equal(header.version, SESSION_VERSION, "pi-coding-agent 1.4.0 CURRENT_SESSION_VERSION");
assert.equal(header.parentSession, previous, "the files are linked");
assert.equal(header.cwd, dir, "the engine's working folder comes from the previous session");
assert.equal(handoff.type, "custom_message");
assert.equal(handoff.customType, HANDOFF_TYPE);
assert.equal(handoff.display, false, "hidden from the island");
assert.equal(handoff.parentId, null);
assert.match(handoff.id, /^[0-9a-f]{8}$/);
assert.equal(handoff.content, "Summary: el usuario planea un viaje.");
assert.equal(fs.statSync(file).mode & 0o777, 0o600, "private like every session write");
// The seed is never an overwrite: a second rotation writes its own file and leaves the first intact.
await assert.rejects(() => fs.promises.writeFile(file, "x", { flag: "wx" }), { code: "EEXIST" });
const file2 = await writeHandoffSession(previous, "otra ronda");
assert.notEqual(file2, file, "each rotation seeds its own session file");
assert.ok(JSON.parse(fs.readFileSync(file, "utf8").split("\n")[1]).content.includes("el usuario planea"), "the first seed is untouched");

});

// ---------------------------------------------------- switch and verification

test("rotate: switch_session is verified against the engine's context", async (t) => {
	const dir = tmp("abito-rot-verify-");
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const previousFile = writeSessionFile(dir, "prev.jsonl", twentyMessages());
	const messagesFile = writeHandoffMessages(dir, "El usuario planea un viaje.");
	const { engine, rotator, commands } = await rig(t, { rotatorLimits: { bytes: 100 } }, ["--messages-file", messagesFile]);
	// Point the rotator at a hand-built previous file: copy the fake engine's session aside.
	const first = engine.sessionFile;
	fs.copyFileSync(previousFile, first);
	bloat(engine, 1); // over the byte limit of 100
	assert.equal(await rotator.maybeRotate(), true);
	assert.equal(switches(commands).length, 1);
	const seed = switches(commands)[0].sessionPath;
	assert.equal(engine.sessionFile, seed, "the engine owns the seeded session");
	const header = JSON.parse(fs.readFileSync(seed, "utf8").split("\n")[0]);
	assert.equal(header.parentSession, first, "the chain is linked");
	assert.deepEqual(engine.previousSessions, [first], "Gentle Dot's chain, oldest first");
	const state = JSON.parse(fs.readFileSync(path.join(path.dirname(first), "..", "state.json"), "utf8"));
	assert.equal(state.sessionFile, seed);
	assert.deepEqual(state.chains, { [seed]: [first] }, "the chain survives on disk");
});

test("verify failure: the chat goes back to the previous session, nothing is lost", async (t) => {
	const dir = tmp("abito-rot-verfail-");
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const logs = [];
	// The engine never reports the handoff in its context (--messages-file absent → empty).
	const { engine, rotator, commands } = await rig(t, { rotatorLimits: { bytes: 100 }, rotatorOptions: { log: (line) => logs.push(line) } });
	const first = engine.sessionFile;
	bloat(engine);
	assert.equal(await rotator.maybeRotate(), false);
	assert.ok(switches(commands).length >= 1, "the switch was attempted");
	assert.equal(engine.sessionFile, first, "the chat stays in the previous session");
	assert.ok(logs.some((line) => line.includes("context") || line.includes("handoff")), "the failure is logged");
	// The chat still works: a prompt arrives on the previous session undecorated.
	await engine.request({ type: "prompt", message: "seguimos" });
	assert.equal(prompts(commands).at(-1).sessionFile, first);
	assert.equal(prompts(commands).at(-1).message, "seguimos");
});

// ------------------------------------------------------------- failure paths

test("write failure: the rotation is skipped, the session and its history stay", async (t) => {
	const dir = tmp("abito-rot-wfail-");
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const messagesFile = writeHandoffMessages(dir);
	const { engine, rotator, commands } = await rig(t, { rotatorLimits: { bytes: 100 } }, ["--messages-file", messagesFile]);
	const first = engine.sessionFile;
	bloat(engine);
	if (process.platform !== "win32") {
		fs.chmodSync(path.dirname(first), 0o500);
		try {
			assert.equal(await rotator.maybeRotate(), false);
			assert.equal(switches(commands).length, 0, "nothing is switched when the seed cannot be written");
			assert.equal(engine.sessionFile, first);
		} finally {
			fs.chmodSync(path.dirname(first), 0o700);
		}
	} else {
		// Windows: no chmod; prove the guard through an unwritable target name instead.
		const broken = new SessionRotator({ sessionFile: first, request: async (_command) => { throw new Error("no"); }, status: "ready", busy: false, previousSessions: [], linkSessions: () => {} }, {
			limits: { ...DEFAULT_ROTATION, bytes: 100 },
			log: () => {},
		});
		t.after(() => broken.stop());
		assert.equal(await broken.maybeRotate(), false, "an engine that refuses requests costs nothing");
	}
	await engine.request({ type: "prompt", message: "aún aquí" });
	assert.equal(prompts(commands).at(-1).message, "aún aquí", "the chat keeps working");
});

test("switch failure: the engine recovers the previous session and the chat continues", async (t) => {
	const dir = tmp("abito-rot-sfail-");
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const messagesFile = writeHandoffMessages(dir);
	const logs = [];
	const { engine, rotator, commands } = await rig(t, { rotatorLimits: { bytes: 100 }, rotatorOptions: { log: (line) => logs.push(line) } }, ["--messages-file", messagesFile, "--switch-unconfirm-once"]);
	const first = engine.sessionFile;
	bloat(engine);
	assert.equal(await rotator.maybeRotate(), false);
	assert.ok(logs.some((line) => line.includes("rotation")), "the failure is logged");
	await until(() => engine.status === "ready" && engine.sessionFile === first, 8000);
	await until(() => !engine.busy, 8000);
	await engine.request({ type: "prompt", message: "de nuevo" });
	assert.equal(prompts(commands).at(-1).message, "de nuevo");
});

// ------------------------------------------------------- settle trigger (B2)

test("rotation runs after a settled turn, with no prompt of its own", async (t) => {
	const dir = tmp("abito-rot-settle-");
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const messagesFile = writeHandoffMessages(dir);
	const { engine, commands } = await rig(t, { rotatorLimits: { bytes: 100 } }, ["--messages-file", messagesFile, "--settle-all"]);
	const first = engine.sessionFile;
	bloat(engine);
	await engine.request({ type: "prompt", message: "primero" });
	await until(() => engine.sessionFile !== first, 8000);
	assert.equal(prompts(commands).length, 1, "exactly the island's prompt");
	assert.equal(prompts(commands)[0].message, "primero", "undecorated");
	await until(() => engine.status === "ready" && !engine.busy);
	await engine.request({ type: "prompt", message: "segundo" });
	await until(() => prompts(commands).some((c) => c.sessionFile === engine.sessionFile), 8000);
	// The conversation continues in the same session file: one continuous chat.
	assert.equal(prompts(commands).filter((c) => c.message === "segundo").length, 1);
});

// ------------------------------------------------------------------ config key

const { loadConfig } = require("../src/config.cjs");

test("config rotation key: ON by default with Gentle Dot's limits, strict validation", () => {
	const dir = tmp("abito-rot-cfg-");
	process.on("exit", () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
	// Absent key: rotation is ON by default (K2-05 T3), Gentle Dot's limits.
	let cfg = loadConfig(dir);
	assert.deepEqual(cfg.rotation, { enabled: true, bytes: 20 * 1024 * 1024, compactions: 10 });
	// Explicit values and opt-out.
	writePrivateFile(path.join(dir, "config.json"), `${JSON.stringify({ rotation: { enabled: false } })}\n`);
	cfg = loadConfig(dir);
	assert.deepEqual(cfg.rotation, { enabled: false, bytes: 20 * 1024 * 1024, compactions: 10 });
	writePrivateFile(path.join(dir, "config.json"), `${JSON.stringify({ rotation: { enabled: true, bytes: 4096, compactions: 3 } })}\n`);
	cfg = loadConfig(dir);
	assert.deepEqual(cfg.rotation, { enabled: true, bytes: 4096, compactions: 3 });
	// Env overrides win over the file (like ABITO_WORKSPACE).
	cfg = loadConfig(dir, { env: { ABITO_ROTATE_BYTES: "8192", ABITO_ROTATE_COMPACTIONS: "5" } });
	assert.deepEqual(cfg.rotation, { enabled: true, bytes: 8192, compactions: 5 });
	// Invalid subkey, type or range -> ConfigError("rotation"), never a silent flip.
	for (const rotation of [
		{ nope: 1 }, { enabled: "yes" }, { bytes: 0 }, { bytes: 1.5 }, { bytes: 10 }, { compactions: 0 },
		{ compactions: 2 ** 53 }, { thresholdPercent: 85 }, { keepTurns: 12 }, "yes",
	]) {
		writePrivateFile(path.join(dir, "config.json"), `${JSON.stringify({ rotation })}\n`);
		assert.throws(() => loadConfig(dir), (error) => error.name === "ConfigError" && error.field === "rotation");
	}
	// Invalid env values never win and never crash: the file/default stands.
	writePrivateFile(path.join(dir, "config.json"), `${JSON.stringify({ rotation: { bytes: 4096 } })}\n`);
	cfg = loadConfig(dir, { env: { ABITO_ROTATE_BYTES: "lots" } });
	assert.deepEqual(cfg.rotation, { enabled: true, bytes: 4096, compactions: 10 });
});

// ------------------------------------------------- Daemon wiring (default ON)

async function socketClient(t, endpoint, token) {
	const net = require("node:net");
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

test("daemon wiring: rotation is ON by default and the island keeps one continuous chat", async (t) => {
	const base = tmp("abito-rot-daemon-");
	t.after(() => fs.rmSync(base, { recursive: true, force: true }));
	const root = path.join(base, "i");
	const commandLog = path.join(base, "commands");
	const messagesFile = writeHandoffMessages(base, "contexto previo de la conversación");
	const daemon = new Daemon({
		root,
		env: { PATH: process.env.PATH },
		log: () => {},
		engineOptions: {
			command: process.execPath,
			commandArgs: [FAKE, "--command-log", commandLog, "--messages-file", messagesFile, "--settle-all"],
			backoffMs: [20], stopTimeoutMs: 500, requestTimeoutMs: 3000, startTimeoutMs: 5000,
			turnTimeoutMs: 10_000, abortGraceMs: 200,
		},
	});
	t.after(async () => { await daemon.stop(); });
	// Tiny limits through the config file; `enabled` is absent: rotation is ON by default.
	writePrivateFile(path.join(root, "config.json"), `${JSON.stringify({ rotation: { bytes: 1024 } })}\n`);
	await daemon.start();
	const session = readSession(root);
	const { frames, send } = await socketClient(t, session.endpoint, session.token);
	const commands = () => fs.readFileSync(commandLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
	// The next prompt must run in an oversized session: bloat the engine's open file.
	bloat(daemon.engine, 4096);
	send({ type: "send", text: "primero" });
	await until(() => prompts(commands).some((c) => c.message === "primero"));
	await until(() => switches(commands).length === 1, 8000);
	const first = prompts(commands)[0].sessionFile;
	const seed = switches(commands)[0].sessionPath;
	await until(() => daemon.engine.status === "ready" && !daemon.engine.busy && daemon.engine.sessionFile === seed);
	// ONE continuous chat: the island's own messages are sent one by one, undecorated.
	send({ type: "send", text: "segundo" });
	await until(() => prompts(commands).some((c) => c.message === "segundo" && c.sessionFile === seed));
	assert.deepEqual(prompts(commands).map((c) => c.message), ["primero", "segundo"], "no extra user message, no visible frame");
	for (const frame of frames) {
		const text = JSON.stringify(frame);
		assert.ok(!text.includes("HANDOFF") && !text.includes("abito.handoff") && !text.includes("[Resumen"), `no rotation artifact in an island frame: ${text.slice(0, 120)}`);
	}
	assert.deepEqual(daemon.engine.previousSessions, [first], "history stays linked across the rotation");
	// The rotation itself never resets or prompts.
	assert.equal(resets(commands).length, 0);
});

test("daemon wiring: rotation.enabled=false keeps #0 rotation off", async (t) => {
	const base = tmp("abito-rot-off-");
	t.after(() => fs.rmSync(base, { recursive: true, force: true }));
	const root = path.join(base, "i");
	const commandLog = path.join(base, "commands");
	const daemon = new Daemon({
		root,
		env: { PATH: process.env.PATH },
		log: () => {},
		engineOptions: {
			command: process.execPath,
			commandArgs: [FAKE, "--command-log", commandLog, "--settle-all"],
			backoffMs: [20], stopTimeoutMs: 500, requestTimeoutMs: 3000, startTimeoutMs: 5000,
			turnTimeoutMs: 10_000, abortGraceMs: 200,
		},
	});
	t.after(async () => { await daemon.stop(); });
	writePrivateFile(path.join(root, "config.json"), `${JSON.stringify({ rotation: { enabled: false } })}\n`);
	await daemon.start();
	const session = readSession(root);
	const { send } = await socketClient(t, session.endpoint, session.token);
	const commands = () => fs.readFileSync(commandLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
	fs.appendFileSync(daemon.engine.sessionFile, "x".repeat(4096));
	send({ type: "send", text: "primero" });
	await until(() => prompts(commands).some((c) => c.message === "primero"));
	await until(() => daemon.engine.status === "ready" && !daemon.engine.busy);
	await sleep(150);
	assert.equal(switches(commands).length, 0, "the user opted out: no rotation");
});

test("daemon wiring: the island pause also pauses the rotation", async (t) => {
	const base = tmp("abito-rot-pause-");
	t.after(() => fs.rmSync(base, { recursive: true, force: true }));
	const root = path.join(base, "i");
	const commandLog = path.join(base, "commands");
	const messagesFile = writeHandoffMessages(base);
	const daemon = new Daemon({
		root,
		env: { PATH: process.env.PATH },
		log: () => {},
		engineOptions: {
			command: process.execPath,
			commandArgs: [FAKE, "--command-log", commandLog, "--messages-file", messagesFile, "--settle-all"],
			backoffMs: [20], stopTimeoutMs: 500, requestTimeoutMs: 3000, startTimeoutMs: 5000,
			turnTimeoutMs: 10_000, abortGraceMs: 200,
		},
	});
	t.after(async () => { await daemon.stop(); });
	writePrivateFile(path.join(root, "config.json"), `${JSON.stringify({ rotation: { bytes: 1024 } })}\n`);
	await daemon.start();
	const session = readSession(root);
	const { frames, send } = await socketClient(t, session.endpoint, session.token);
	const commands = () => fs.readFileSync(commandLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
	send({ type: "set_paused", paused: true });
	await until(() => frames.some((f) => f.type === "agent_state" && f.paused === true));
	bloat(daemon.engine, 4096);
	// A settled turn arrives while the island is paused: no rotation.
	await daemon.engine.request({ type: "emit", events: [{ type: "agent_settled" }] });
	await sleep(300);
	assert.equal(switches(commands).length, 0, "paused: no rotation despite the settle");
	send({ type: "set_paused", paused: false });
	await until(() => frames.some((f) => f.type === "agent_state" && f.paused === false));
	// Once the chat is unpaused the pending rotation goes through.
	assert.ok(daemon.rotator, "the daemon owns a rotator");
	assert.equal(await daemon.rotator.maybeRotate(), true, "unpaused: the rotation goes through");
	await until(() => switches(commands).length === 1, 8000);
});

// ------------------------------------------------------- history continuity

test("the chain of session files survives an engine restart", async (t) => {
	const dir = tmp("abito-rot-chain-");
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const messagesFile = writeHandoffMessages(dir);
	const root = path.join(dir, "island");
	const engineOptions = () => ({
		command: process.execPath,
		commandArgs: [FAKE, "--command-log", path.join(dir, "commands"), "--messages-file", messagesFile],
		root, identityPath: null,
		backoffMs: [10], startTimeoutMs: 2000, stopTimeoutMs: 50, requestTimeoutMs: 2000,
		turnTimeoutMs: 10_000, abortGraceMs: 100,
	});
	const engine = new AgentEngine(engineOptions());
	t.after(async () => { await engine.stop(); });
	await engine.start();
	const first = engine.sessionFile;
	bloat(engine, 100);
	const rotator = new SessionRotator(engine, { limits: { ...DEFAULT_ROTATION, bytes: 100 }, log: () => {} });
	assert.equal(await rotator.maybeRotate(), true);
	const seed = engine.sessionFile;
	assert.deepEqual(engine.previousSessions, [first]);
	await engine.stop();
	// A fresh engine reopens the chat where it was, chain included.
	const again = new AgentEngine(engineOptions());
	await again.start();
	assert.equal(again.sessionFile, seed, "the chat reopens on the seeded session");
	assert.deepEqual(again.previousSessions, [first], "the chain is restored");
	await again.stop();
	fs.rmSync(dir, { recursive: true, force: true });
});
