"use strict";

// U1 runtime tests: supervised fake Pi-style RPC agent (no providers, no network).
// The fake child runs with process.execPath, so tests never touch a real pi install.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { AgentEngine, JsonlDecoder } = require("../src/runtime.cjs");
const { ensureIsland } = require("../src/isolation.cjs");

const FAKE_AGENT = path.join(__dirname, "fixtures", "fake-agent.cjs");

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await sleep(10);
	}
	assert.ok(predicate(), "waitFor timed out");
}

function spawnCount(spawnLog) {
	try {
		return fs.readFileSync(spawnLog, "utf8").split("\n").filter(Boolean).length;
	} catch {
		return 0;
	}
}

function makeEngine(t, overrides = {}) {
	const { extraArgs = [], ...rest } = overrides;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abito-engine-test-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const spawnLog = path.join(dir, "spawns.log");
	const argvOut = path.join(dir, "argv.json");
	const envOut = path.join(dir, "env.json");
	const cmdLog = path.join(dir, "commands.log");
	const engine = new AgentEngine({
		command: process.execPath,
		commandArgs: [FAKE_AGENT],
		root: path.join(dir, "island"),
		// The base env deliberately carries parent secrets and parent Pi setup:
		// the child must never see them.
		env: {
			...process.env,
			ANTHROPIC_API_KEY: "sk-parent-secret",
			PI_CODING_AGENT_DIR: "/opt/user-pi-agent",
		},
		backoffMs: [10, 10, 10, 10],
		stableMs: 60_000,
		startTimeoutMs: 5_000,
		requestTimeoutMs: 5_000,
		stopTimeoutMs: 1_000,
		extraArgs: [
			...extraArgs,
			"--argv-out",
			argvOut,
			"--env-out",
			envOut,
			"--spawn-log",
			spawnLog,
			"--cmd-log",
			cmdLog,
		],
		log: () => {},
		...rest,
	});
	return { engine, dir, spawnLog, argvOut, envOut, cmdLog };
}

test("start reaches ready and correlates a get_state request", async (t) => {
	const { engine, argvOut, envOut } = makeEngine(t);
	const statuses = [];
	engine.on("status", (status) => statuses.push(status.state));

	await engine.start();
	assert.equal(engine.status, "ready");
	assert.deepEqual(statuses, ["starting", "ready"]);
	assert.equal(typeof engine.pid, "number");

	const response = await engine.request({ type: "get_state" });
	assert.equal(response.success, true);
	assert.equal(response.command, "get_state");
	assert.ok(String(response.data.sessionFile).startsWith(engine.island.sessions));

	// The real child argv carries the private session dir and the private identity file.
	const argv = JSON.parse(fs.readFileSync(argvOut, "utf8"));
	const sessionIdx = argv.indexOf("--session-dir");
	const identityIdx = argv.indexOf("--append-system-prompt");
	assert.ok(sessionIdx > 0 && identityIdx > 0, `argv: ${JSON.stringify(argv)}`);
	assert.equal(argv[sessionIdx + 1], engine.island.sessions);
	assert.equal(argv[identityIdx + 1], path.join(engine.island.root, "identity.md"));
	assert.ok(fs.existsSync(argv[identityIdx + 1]));
	assert.equal(fs.statSync(argv[identityIdx + 1]).mode & 0o777, 0o600);

	// The child environment is isolated from the parent's secrets and Pi setup.
	const childEnv = JSON.parse(fs.readFileSync(envOut, "utf8"));
	assert.equal(childEnv.HOME, engine.island.home);
	assert.equal(childEnv.TMPDIR, engine.island.tmp);
	assert.equal(childEnv.XDG_CONFIG_HOME, path.join(engine.island.home, ".config"));
	assert.equal(childEnv.PI_CODING_AGENT_DIR, engine.island.agentDir);
	assert.equal(childEnv.ANTHROPIC_API_KEY, undefined);
	assert.equal(childEnv.PI_OFFLINE, "1");
	for (const key of Object.keys(childEnv)) {
		if (key.startsWith("PI_")) {
			assert.ok(
				["PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_SKIP_VERSION_CHECK", "PI_TELEMETRY"].includes(key),
				`unexpected child PI_ variable: ${key}`,
			);
		}
	}

	await engine.stop();
	assert.equal(engine.status, "stopped");
	assert.equal(engine.pid, undefined);
});

test("decodes chunked JSONL and keeps U+2028/U+2029 and Unicode intact in events", async (t) => {
	const { engine } = makeEngine(t, { extraArgs: ["--chunked-events"] });
	await engine.start();
	const events = [];
	engine.on("event", (event) => events.push(event));

	const response = await engine.request({ type: "prompt", message: "hola" });
	assert.equal(response.data.disposition, "started");

	// The fake writes agent_start, one message_update split across three byte
	// chunks containing U+2028/U+2029 and an emoji, then agent_end/agent_settled.
	// The delayed chunked writes can land after agent_settled, so wait for the
	// update itself.
	await waitFor(() => events.some((event) => event.type === "agent_settled"));
	await waitFor(() => events.some((event) => event.type === "message_update"));
	const update = events.find((event) => event.type === "message_update");
	assert.ok(update, "expected a message_update event");
	const delta = update.assistantMessageEvent.delta;
	assert.ok(delta.includes("\u2028"), "U+2028 must survive framing");
	assert.ok(delta.includes("\u2029"), "U+2029 must survive framing");
	assert.ok(delta.includes("😀"), "emoji must survive framing");
	assert.equal(events.some((event) => event.type === "agent_start"), true);
	await engine.stop();
});

test("correlates interleaved concurrent requests", async (t) => {
	const { engine } = makeEngine(t);
	await engine.start();
	const [a, b, c] = await Promise.all([
		engine.request({ type: "get_state" }),
		engine.request({ type: "echo", value: "uno" }),
		engine.request({ type: "echo", value: "dos" }),
	]);
	assert.equal(a.command, "get_state");
	assert.equal(b.data.value, "uno");
	assert.equal(c.data.value, "dos");
	await engine.stop();
});

test("times out a request the agent never answers and stays usable", async (t) => {
	const { engine } = makeEngine(t);
	await engine.start();
	await assert.rejects(() => engine.request({ type: "hang" }, 100), /did not answer/);
	const response = await engine.request({ type: "get_state" });
	assert.equal(response.success, true);
	await engine.stop();
});

test("restarts after a crash with bounded backoff and rejects pending requests", async (t) => {
	const { engine, spawnLog } = makeEngine(t);
	await engine.start();
	const statuses = [];
	engine.on("status", (status) => statuses.push(status.state));

	const hung = engine.request({ type: "hang" }, 60_000);
	engine.send({ type: "crash" });
	await assert.rejects(() => hung, /exited/);

	await waitFor(() => engine.status === "ready" && spawnCount(spawnLog) === 2);
	assert.ok(statuses.includes("restarting"), `statuses: ${JSON.stringify(statuses)}`);
	const response = await engine.request({ type: "get_state" });
	assert.equal(response.success, true);
	await engine.stop();
});

test("stop terminates the child, disables restarts and rejects new requests", async (t) => {
	const { engine, spawnLog } = makeEngine(t);
	await engine.start();
	await engine.stop();
	assert.equal(engine.status, "stopped");
	assert.equal(engine.pid, undefined);

	const spawns = spawnCount(spawnLog);
	await sleep(150);
	assert.equal(spawnCount(spawnLog), spawns, "stop must disable crash restarts");
	await assert.rejects(() => engine.request({ type: "get_state" }), /not ready/);
	assert.throws(() => engine.send({ type: "echo" }), /not ready/);
});

test("start refuses to run twice and propagates an unspawnable command", async (t) => {
	const { engine } = makeEngine(t);
	await engine.start();
	await assert.rejects(() => engine.start(), /cannot start/);
	await engine.stop();

	const broken = makeEngine(t, { command: "/nonexistent/abito-fake-bin" });
	await assert.rejects(() => broken.engine.start(), (error) => error instanceof Error);
	assert.equal(broken.engine.status, "stopped");
});

test("start refuses an identity target replaced by a symlink and leaves the victim intact", async (t) => {
	const { engine, dir } = makeEngine(t);
	const island = ensureIsland(engine.root);
	const victim = path.join(dir, "victim.md");
	fs.writeFileSync(victim, "keep\n");
	fs.symlinkSync(victim, path.join(island.root, "identity.md"));
	await assert.rejects(() => engine.start(), /symlink|refusing/);
	assert.equal(fs.readFileSync(victim, "utf8"), "keep\n");
	assert.ok(fs.lstatSync(path.join(island.root, "identity.md")).isSymbolicLink());
});

test("malformed records are discarded without raw content in diagnostics", async (t) => {
	const logs = [];
	const { engine } = makeEngine(t, { extraArgs: ["--malformed-first"], log: (line) => logs.push(line) });
	await engine.start();
	const response = await engine.request({ type: "get_state" });
	assert.equal(response.success, true);
	const all = logs.join("\n");
	assert.ok(!all.includes("MALFORMED-SECRET"), `raw content leaked: ${all}`);
	assert.ok(all.includes("malformed"), "a safe malformed notice is expected");
	await engine.stop();
});

test("oversized records are discarded at the buffer cap without raw content", async (t) => {
	const logs = [];
	const { engine } = makeEngine(t, { extraArgs: ["--oversized-first"], log: (line) => logs.push(line) });
	await engine.start();
	const response = await engine.request({ type: "echo", value: "ok" });
	assert.equal(response.data.value, "ok");
	const all = logs.join("\n");
	assert.ok(all.includes("oversized"), "a safe oversize notice is expected");
	assert.ok(!all.includes("OVERSIZE-SECRET"), "raw oversize content leaked");
	await engine.stop();
});

test("JsonlDecoder rejects a complete framed record over the cap before parsing and keeps following records", () => {
	const records = [];
	let oversized = 0;
	const malformed = [];
	const decoder = new JsonlDecoder(
		(record) => records.push(record),
		(line) => malformed.push(line),
		() => oversized++,
		1024,
	);
	// One valid JSON record larger than the cap plus its LF, then a valid record.
	const big = JSON.stringify({ type: "note", note: `SECRET-${"x".repeat(2000)}` });
	decoder.push(Buffer.from(`${big}\n{"type":"ok"}\n`, "utf8"));
	assert.equal(oversized, 1);
	assert.deepEqual(records, [{ type: "ok" }]);
	assert.equal(malformed.length, 0, "rejected by length before toString/parse, not as malformed");
	assert.equal(JSON.stringify(records).includes("SECRET-"), false);
});

test("JsonlDecoder discards an oversized fragmented line until its LF, then parses the next record", () => {
	const records = [];
	let oversized = 0;
	const malformed = [];
	const decoder = new JsonlDecoder(
		(record) => records.push(record),
		(line) => malformed.push(line),
		() => oversized++,
		1024,
	);
	decoder.push(Buffer.from("x".repeat(900))); // under cap, no LF
	decoder.push(Buffer.from("x".repeat(300))); // crosses cap without LF
	assert.equal(oversized, 1);
	decoder.push(Buffer.from("tail bytes without lf")); // remainder of the oversized line
	decoder.push(Buffer.from(`${"y".repeat(50)}\n{"type":"after"}\n`)); // LF ends the oversized line; next record parses
	assert.equal(oversized, 1, "one discard, not one per chunk");
	assert.deepEqual(records, [{ type: "after" }]);
	assert.equal(malformed.length, 0, "tail must not surface as a new record");
});

function readCommands(cmdLog) {
	return fs
		.readFileSync(cmdLog, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

test("restart reopens the persisted session via switch_session", async (t) => {
	const { engine, spawnLog, cmdLog } = makeEngine(t);
	await engine.start();
	engine.send({ type: "crash" });
	await waitFor(() => engine.status === "ready" && spawnCount(spawnLog) === 2);
	const switches = readCommands(cmdLog).filter((c) => c.type === "switch_session");
	assert.equal(switches.length, 1);
	assert.ok(switches[0].sessionPath.startsWith(engine.island.sessions));
	assert.ok(fs.existsSync(switches[0].sessionPath));
	await engine.stop();
});

test("restart ignores persisted session paths outside the island sessions dir", async (t) => {
	const { engine, dir, spawnLog, cmdLog } = makeEngine(t);
	await engine.start();
	const outside = path.join(dir, "outside.jsonl");
	fs.writeFileSync(outside, "", { mode: 0o600 });
	fs.writeFileSync(path.join(engine.island.root, "state.json"), `${JSON.stringify({ sessionFile: outside })}\n`);
	engine.send({ type: "crash" });
	await waitFor(() => engine.status === "ready" && spawnCount(spawnLog) === 2);
	assert.equal(readCommands(cmdLog).filter((c) => c.type === "switch_session").length, 0);
	await engine.stop();
});
