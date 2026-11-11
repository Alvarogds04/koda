"use strict";

// U1 runtime tests: supervised fake Pi-style RPC agent (no providers, no network).
// The fake child runs with process.execPath, so tests never touch a real pi install.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { AgentEngine, JsonlDecoder, bundledGentleShell, gentlePiVersion, runtimeRoot } = require("../src/runtime.cjs");
const { ensureIsland } = require("../src/isolation.cjs");
const { assertMode, unixOnly, win } = require("./platform-env.cjs");

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
		// The base env deliberately carries parent secrets, parent Pi setup and the
		// user's own Gentle Shell setup: the child must never see any of them.
		env: {
			...process.env,
			ANTHROPIC_API_KEY: "sk-parent-secret",
			PI_CODING_AGENT_DIR: "/opt/user-pi-agent",
			GENTLE_SHELL_PI: "/opt/user-pi/dist/cli.js",
			GENTLE_SHELL_CONFIG: "/home/user/.gentle-shell",
			GENTLE_PI_AGENT_HOME: "/home/user/.gentle",
			GENTLE_PI_AGENTS_CHILD: "1",
			GENTLE_PI_AGENTS_PI: "/opt/user-pi",
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

	// A custom `command` (this fake agent) keeps the pre-T2 argv shape (B2):
	// NO --home (plain Pi refuses unknown options), the private session dir and
	// the private identity file. Its engine home travels on PI_CODING_AGENT_DIR
	// in the child env instead; --home is the default bundled Gentle Shell's
	// shape only (see the default-engine test below).
	const argv = JSON.parse(fs.readFileSync(argvOut, "utf8"));
	const sessionIdx = argv.indexOf("--session-dir");
	const identityIdx = argv.indexOf("--append-system-prompt");
	assert.equal(argv.indexOf("--home"), -1, `a custom command gets no --home: ${JSON.stringify(argv)}`);
	assert.ok(sessionIdx > 0 && identityIdx > sessionIdx, `argv: ${JSON.stringify(argv)}`);
	assert.equal(argv[sessionIdx + 1], engine.island.sessions);
	assert.equal(argv[identityIdx + 1], path.join(engine.island.root, "identity.md"));
	assert.ok(fs.existsSync(argv[identityIdx + 1]));
	assert.equal(fs.statSync(argv[identityIdx + 1]).mode & 0o777, 0o600);

	// The child environment is isolated from the parent's secrets and Pi setup:
	// a custom command keeps the pre-T2 home transport (B2) — PI_CODING_AGENT_DIR
	// carries the island agent dir, never the parent's own value.
	const childEnv = JSON.parse(fs.readFileSync(envOut, "utf8"));
	assert.equal(childEnv.HOME, engine.island.home);
	assert.equal(childEnv.TMPDIR, engine.island.tmp);
	assert.equal(childEnv.XDG_CONFIG_HOME, path.join(engine.island.home, ".config"));
	assert.equal(childEnv.PI_CODING_AGENT_DIR, engine.island.agentDir);
	assert.equal(childEnv.GENTLE_SHELL_NO_AUTO_SETUP, "1");
	assert.equal(childEnv.GENTLE_PI_SKIP_GENTLE_AI_INSTALL, "1");
	assert.equal(childEnv.GENTLE_PI_CONFIG_HOME, path.join(engine.island.root, "gentle-ai"));
	assert.equal(childEnv.ANTHROPIC_API_KEY, undefined);
	assert.equal(childEnv.PI_OFFLINE, "1");
	for (const key of Object.keys(childEnv)) {
		if (key.startsWith("PI_")) {
			assert.ok(
				["PI_OFFLINE", "PI_SKIP_VERSION_CHECK", "PI_TELEMETRY", "PI_CODING_AGENT_DIR"].includes(key),
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

// F2 (verifier): a cancelled turn (abort/timeout/pause) never reaches
// message_end, so the daemon itself must flush the stream filter's held tail
// before the turn ends — as one final delta event the server can translate.
test("an aborted turn flushes the held stream tail before the turn ends (F2)", async (t) => {
	const { engine } = makeEngine(t, { extraArgs: ["--prompt-holds"] });
	await engine.start();
	const events = [];
	engine.on("event", (event) => events.push(event));
	await engine.request({ type: "prompt", message: "hola" });
	await waitFor(() => events.some((e) => e.type === "message_update"));
	const cancelled = [];
	engine.on("turn_cancelled", () => cancelled.push(true));
	await engine.request({ type: "abort" });
	const flushes = events.filter((e) => e.type === "message_flush");
	assert.equal(flushes.length, 1, `exactly one flush: ${JSON.stringify(events.map((e) => e.type))}`);
	assert.equal(typeof flushes[0].flush, "symbol", "the flush marker is a symbol the child could never forge");
	assert.equal(cancelled.length, 1, "the cancellation still ran");
	await engine.stop();
});

test("the engine child env never inherits GENTLE_SHELL_PI or the user's own Gentle Shell setup", async (t) => {
	// gentle-shell lets GENTLE_SHELL_PI override the bundled Pi (verifier finding on
	// gentle-pi lib/gentle-shell-launcher.ts); the user's own home/config/agent
	// variables must never reach Koda's engine either. The allowlist is the
	// mechanism; this test pins the rule so a future allowlist entry cannot undo it.
	const { engine, envOut } = makeEngine(t);
	await engine.start();
	const childEnv = JSON.parse(fs.readFileSync(envOut, "utf8"));
	for (const key of [
		"GENTLE_SHELL_PI",
		"GENTLE_SHELL_CONFIG",
		"GENTLE_PI_AGENT_HOME",
		"GENTLE_PI_AGENTS_CHILD",
		"GENTLE_PI_AGENTS_PI",
	]) {
		assert.equal(childEnv[key], undefined, `${key} must never reach the engine child`);
	}
	// PI_CODING_AGENT_DIR: the parent's own value never reaches the child. A
	// custom command (this fake) carries the island agent dir instead (B2);
	// Koda's default engine gets none at all (--home transports it, see above).
	assert.notEqual(childEnv.PI_CODING_AGENT_DIR, "/opt/user-pi-agent");
	assert.equal(childEnv.PI_CODING_AGENT_DIR, engine.island.agentDir);
	await engine.stop();
});

test("start claims the engine home with a .gentle-shell-home marker before the first spawn", async (t) => {
	const { engine, spawnLog } = makeEngine(t);
	const marker = path.join(engine.root, "agent", ".gentle-shell-home");
	await engine.start();
	assert.ok(fs.existsSync(marker), "the marker must exist in the --home agent dir before the first spawn");
	const claimed = JSON.parse(fs.readFileSync(marker, "utf8"));
	assert.equal(claimed.createdBy, "gentle-shell");
	assert.equal(claimed.version, gentlePiVersion()); // the bundled runtime's gentle-pi version (undefined on a dev tree)
	// POSIX mode bits only: the marker is a plain exclusive create (not a win-fs private write), and Windows
	// has no mode bits (lstat reports 0o666); its access boundary there is the island's private agent folder.
	if (!win) assert.equal(fs.statSync(marker).mode & 0o777, 0o600);

	// A marker already there is left exactly as it is (gentle-shell checks only
	// that the file exists); a restart must not rewrite it.
	const foreign = `${JSON.stringify({ createdBy: "someone-else", version: "9.9.9" })}\n`;
	fs.writeFileSync(marker, foreign);
	engine.send({ type: "crash" });
	await waitFor(() => engine.status === "ready" && spawnCount(spawnLog) === 2);
	assert.equal(fs.readFileSync(marker, "utf8"), foreign, "an existing marker is never overwritten");
	await engine.stop();
});

test("the default engine resolves Koda's bundled runtime, never PATH or npm (T2)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "abito-gentle-runtime-"));
	try {
		const scriptRel = "node_modules/gentle-pi/bin/gentle-shell.mjs";
		fs.writeFileSync(path.join(root, "koda-runtime.json"), `${JSON.stringify({ gentlePi: "4.3.0", gentleShell: scriptRel })}\n`);
		fs.mkdirSync(path.join(root, "node_modules", "gentle-pi", "bin"), { recursive: true });
		fs.writeFileSync(path.join(root, ...scriptRel.split("/")), "");
		fs.writeFileSync(path.join(root, "gentle-shell"), "#!/bin/sh\n");
		fs.chmodSync(path.join(root, "gentle-shell"), 0o755);
		// The POSIX layout is asserted as POSIX on every OS (platform: "linux"); the Windows layout below as win32.
		const deps = { execPath: path.join(root, "node"), existsSync: fs.existsSync, lstatSync: fs.lstatSync, readFileSync: fs.readFileSync, platform: "linux" };

		assert.equal(runtimeRoot(deps), root);
		assert.equal(runtimeRoot({ ...deps, execPath: "/usr/bin/node" }), undefined, "no koda-runtime.json, no runtime");
		assert.deepEqual(bundledGentleShell(deps), { command: path.join(root, "gentle-shell"), commandArgs: [] });
		assert.equal(gentlePiVersion(deps), "4.3.0");
		assert.equal(gentlePiVersion({ ...deps, execPath: "/usr/bin/node" }), undefined, "no runtime, no version");

		// Windows: the bundled node.exe plus the script koda-runtime.json names.
		fs.writeFileSync(path.join(root, "node.exe"), "");
		assert.deepEqual(bundledGentleShell({ ...deps, platform: "win32" }), {
			command: path.join(root, "node.exe"),
			commandArgs: [path.join(root, ...scriptRel.split("/"))],
		});
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("bundledGentleShell fails closed on an incomplete runtime, never falls back to PATH", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "abito-gentle-broken-"));
	try {
		// POSIX by default on every OS (platform: "linux"); the Windows checks pass platform: "win32".
		const deps = (over = {}) => ({ execPath: path.join(root, "node"), existsSync: fs.existsSync, lstatSync: fs.lstatSync, readFileSync: fs.readFileSync, platform: "linux", ...over });
		fs.writeFileSync(path.join(root, "koda-runtime.json"), `${JSON.stringify({ gentlePi: "4.3.0", gentleShell: "node_modules/gentle-pi/bin/gentle-shell.mjs" })}\n`);
		// POSIX: the launcher is missing -> refuse, never a PATH search.
		assert.throws(() => bundledGentleShell(deps()), /missing the gentle-shell launcher|bundled runtime/);
		// A launcher that is not a regular file is refused too.
		fs.mkdirSync(path.join(root, "gentle-shell"));
		assert.throws(() => bundledGentleShell(deps()), /missing the gentle-shell launcher/);
		fs.rmdirSync(path.join(root, "gentle-shell"));
		fs.writeFileSync(path.join(root, "gentle-shell"), "#!/bin/sh\n");
		// Windows: node.exe missing -> refuse.
		assert.throws(() => bundledGentleShell(deps({ platform: "win32" })), /node\.exe/);
		fs.writeFileSync(path.join(root, "node.exe"), "");
		// Windows: a climbing or absolute gentleShell is refused.
		for (const gentleShell of ["../evil.js", "/evil.js", ""]) {
			fs.writeFileSync(path.join(root, "koda-runtime.json"), `${JSON.stringify({ gentlePi: "4.3.0", gentleShell })}\n`);
			assert.throws(() => bundledGentleShell(deps({ platform: "win32" })), /gentleShell/);
		}
		fs.writeFileSync(path.join(root, "koda-runtime.json"), `${JSON.stringify({ gentlePi: "4.3.0", gentleShell: "node_modules/gentle-pi/bin/gentle-shell.mjs" })}\n`);
		// The named script itself missing -> refuse.
		assert.throws(() => bundledGentleShell(deps({ platform: "win32" })), /missing/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("the default engine (Koda's Gentle Shell) gets --home in the island and never PI_CODING_AGENT_DIR (B2)", unixOnly("needs a #!/bin/sh fake runtime launcher; the Windows twin resolves node.exe + the manifest script (pinned by the bundledGentleShell tests below), and the --home branch is platform-independent"), async (t) => {
	// A fake bundled runtime: the launcher execs Koda's Node on the same fake
	// RPC agent, so the recorded argv/env prove the default branch's shape.
	const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "abito-gentle-default-"));
	t.after(() => fs.rmSync(runtime, { recursive: true, force: true }));
	const scriptRel = "node_modules/gentle-pi/bin/gentle-shell.mjs";
	fs.mkdirSync(path.join(runtime, "node_modules", "gentle-pi", "bin"), { recursive: true });
	fs.writeFileSync(path.join(runtime, ...scriptRel.split("/")), "");
	fs.writeFileSync(path.join(runtime, "koda-runtime.json"), `${JSON.stringify({ gentlePi: "4.3.0", gentleShell: scriptRel })}\n`);
	const launcher = path.join(runtime, "gentle-shell");
	fs.writeFileSync(launcher, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_AGENT}' "$@"\n`);
	fs.chmodSync(launcher, 0o755);

	const { engine, argvOut, envOut } = makeEngine(t, {
		command: "gentle-shell",
		commandArgs: [],
		runtimeDeps: { execPath: path.join(runtime, "node"), existsSync: fs.existsSync, lstatSync: fs.lstatSync, readFileSync: fs.readFileSync },
	});
	await engine.start();
	assert.equal(engine.status, "ready");

	// Gentle Dot's argv shape for Koda's own engine: --home is the island agent
	// dir — the same directory Koda writes auth/mcp/extension files into.
	const argv = JSON.parse(fs.readFileSync(argvOut, "utf8"));
	const homeIdx = argv.indexOf("--home");
	const sessionIdx = argv.indexOf("--session-dir");
	assert.ok(homeIdx > 0 && sessionIdx > homeIdx, `argv: ${JSON.stringify(argv)}`);
	assert.equal(argv[homeIdx + 1], engine.island.agentDir);
	assert.equal(argv[sessionIdx + 1], engine.island.sessions);
	// The parent's own PI_CODING_AGENT_DIR never reaches the default engine:
	// --home is the only home transport for it.
	const childEnv = JSON.parse(fs.readFileSync(envOut, "utf8"));
	assert.equal(childEnv.PI_CODING_AGENT_DIR, undefined);
	await engine.stop();
});

test("the bundled gentleShell script refuses a symlink at any path segment between the runtime root and the script", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "abito-gentle-link-"));
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "abito-gentle-outside-"));
	try {
		const scriptRel = "node_modules/gentle-pi/bin/gentle-shell.mjs";
		fs.mkdirSync(path.join(root, "node_modules", "gentle-pi", "bin"), { recursive: true });
		fs.writeFileSync(path.join(root, ...scriptRel.split("/")), "");
		fs.writeFileSync(path.join(root, "koda-runtime.json"), `${JSON.stringify({ gentlePi: "4.3.0", gentleShell: scriptRel })}\n`);
		fs.writeFileSync(path.join(root, "node.exe"), "");
		const deps = { execPath: path.join(root, "node"), existsSync: fs.existsSync, lstatSync: fs.lstatSync, readFileSync: fs.readFileSync };
		// Sanity: the intact runtime resolves (Windows shape, where the script runs).
		assert.deepEqual(bundledGentleShell({ ...deps, platform: "win32" }), {
			command: path.join(root, "node.exe"),
			commandArgs: [path.join(root, ...scriptRel.split("/"))],
		});
		// A symlink at an INTERMEDIATE segment redirects the whole tail: refused,
		// like the Rust runtime's inside_file check.
		fs.rmSync(path.join(root, "node_modules"), { recursive: true, force: true });
		fs.symlinkSync(path.join(outside, "node_modules"), path.join(root, "node_modules"));
		assert.throws(() => bundledGentleShell({ ...deps, platform: "win32" }), /symlink/);
		// A symlink at the LEAF (the script itself) is refused too.
		fs.unlinkSync(path.join(root, "node_modules"));
		fs.mkdirSync(path.join(root, "node_modules", "gentle-pi", "bin"), { recursive: true });
		const leaf = path.join(root, ...scriptRel.split("/"));
		fs.writeFileSync(leaf, "");
		fs.rmSync(leaf);
		fs.symlinkSync(path.join(outside, "evil.js"), leaf);
		assert.throws(() => bundledGentleShell({ ...deps, platform: "win32" }), /symlink/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(outside, { recursive: true, force: true });
	}
});

test("the default engine command fails closed without the bundled runtime (never PATH)", async (t) => {
	const { engine } = makeEngine(t, { command: "gentle-shell" });
	await assert.rejects(() => engine.start(), /bundled runtime/);
	assert.equal(engine.status, "stopped");
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

// K2-05 boot reopen (L44, Windows CI 43071616377): the reopen of the conversation saved in
// state.json must never be replaced by the engine's fresh boot session while it is uncertain.
// The fake engine's --switch-script scripts the switch_session answers (fail / hang / late <ms>).
function readState(engine) {
	return JSON.parse(fs.readFileSync(path.join(engine.island.root, "state.json"), "utf8"));
}

/** Boots once to create the saved conversation, stops, and arms the switch script for the next boot. */
async function savedConversation(t, overrides, script) {
	const scriptFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "abito-switch-script-")), "switch.txt");
	t.after(() => fs.rmSync(path.dirname(scriptFile), { recursive: true, force: true }));
	const made = makeEngine(t, { ...overrides, extraArgs: ["--switch-script", scriptFile] });
	const readies = [];
	made.engine.on("status", ({ state }) => { if (state === "ready") readies.push(made.engine.sessionFile); });
	await made.engine.start();
	const saved = made.engine.sessionFile;
	fs.appendFileSync(saved, `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "hola" }] } })}\n`);
	assert.equal(readState(made.engine).sessionFile, saved);
	await made.engine.stop();
	fs.writeFileSync(scriptFile, script);
	readies.length = 0;
	return { ...made, saved, readies, scriptFile };
}

test("boot: a failed reopen of the saved conversation never overwrites state.json and is retried", async (t) => {
	const { engine, saved, readies, cmdLog, spawnLog } = await savedConversation(t, {}, "fail\n");
	try {
		await engine.start();
		assert.equal(engine.sessionFile, saved, "the chat reopens on the saved conversation");
		assert.equal(readState(engine).sessionFile, saved, "state.json still names the saved conversation");
		assert.deepEqual(readies, [saved], "ready is reported once, only on the saved conversation");
		assert.equal(readCommands(cmdLog).filter((c) => c.type === "switch_session").length, 2, "the failed reopen is retried");
		assert.equal(spawnCount(spawnLog), 3, "the uncertain child is replaced, never reused");
		const state = await engine.request({ type: "get_state" });
		assert.equal(state.data.sessionFile, saved, "the engine and Koda agree");
	} finally {
		await engine.stop();
	}
});

test("boot: the reopen gets the rotation switch budget (requestTimeoutMs), not the short switch budget", async (t) => {
	const { engine, saved, readies, cmdLog } = await savedConversation(t, { switchTimeoutMs: 100, requestTimeoutMs: 3000 }, "late 400\n");
	try {
		await engine.start();
		assert.equal(engine.sessionFile, saved);
		assert.equal(readState(engine).sessionFile, saved);
		assert.deepEqual(readies, [saved]);
		assert.equal(readCommands(cmdLog).filter((c) => c.type === "switch_session").length, 1, "a slow reopen is waited for, not retried");
		const state = await engine.request({ type: "get_state" });
		assert.equal(state.data.sessionFile, saved, "the engine and Koda agree after the slow switch");
	} finally {
		await engine.stop();
	}
});

test("boot: after the reopen attempts run out the chat continues in a new session linked to the saved one, which is kept", async (t) => {
	const { engine, saved, readies, cmdLog, spawnLog } = await savedConversation(
		t, { switchTimeoutMs: 150, requestTimeoutMs: 150, reopenAttempts: 2 }, "hang\nhang\n",
	);
	try {
		await engine.start();
		const fresh = engine.sessionFile;
		assert.notEqual(fresh, saved);
		assert.equal(readCommands(cmdLog).filter((c) => c.type === "switch_session").length, 2, "exactly reopenAttempts reopens");
		assert.equal(spawnCount(spawnLog), 4, "the last child never received a switch it could finish later");
		assert.deepEqual(readies, [fresh], "ready is never reported while a reopen was in flight");
		assert.deepEqual(engine.previousSessions, [saved], "the saved conversation heads the chain, so its history keeps reading");
		assert.deepEqual(readState(engine), { sessionFile: fresh, chains: { [fresh]: [saved] } });
		assert.ok(fs.readFileSync(saved, "utf8").includes("hola"), "the saved conversation file is kept as it was");
	} finally {
		await engine.stop();
	}
});

test("crash restart: a failed reopen of the saved conversation keeps state.json and is retried with backoff", async (t) => {
	const scriptFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "abito-switch-script-")), "switch.txt");
	t.after(() => fs.rmSync(path.dirname(scriptFile), { recursive: true, force: true }));
	const { engine, cmdLog, spawnLog } = makeEngine(t, { extraArgs: ["--switch-script", scriptFile] });
	try {
		await engine.start();
		const saved = engine.sessionFile;
		const readies = [];
		engine.on("status", ({ state }) => { if (state === "ready") readies.push(engine.sessionFile); });
		fs.writeFileSync(scriptFile, "fail\n");
		engine.send({ type: "crash" });
		await waitFor(() => engine.status === "ready" && spawnCount(spawnLog) === 3);
		assert.equal(engine.sessionFile, saved);
		assert.equal(readState(engine).sessionFile, saved);
		assert.deepEqual(readies, [saved]);
		assert.equal(readCommands(cmdLog).filter((c) => c.type === "switch_session").length, 2);
	} finally {
		await engine.stop();
	}
});

test("boot: stop() during the reopen retry wait ends start() promptly with nothing persisted over the saved conversation", async (t) => {
	const { engine, saved, spawnLog } = await savedConversation(t, { backoffMs: [60_000] }, "fail\n");
	const starting = engine.start();
	starting.catch(() => {});
	try {
		await waitFor(() => spawnCount(spawnLog) === 2 && !engine.child);
		const began = Date.now();
		await engine.stop();
		await starting.catch(() => {});
		assert.ok(Date.now() - began < 5000, "stop does not wait for the retry backoff");
		assert.equal(engine.status, "stopped");
		assert.equal(readState(engine).sessionFile, saved);
		assert.equal(spawnCount(spawnLog), 2, "no retry after stop");
	} finally {
		// Never leave a live child behind (it would keep the test file running).
		await engine.stop();
		await starting.catch(() => {});
	}
});

// K2-05 T4 U1 verifier fix (S1/S2): a chain is read from the sessions dir only, so a
// symlinked or outside path must never be persisted as a chain entry in the first place.
test("linkSessions refuses chain entries that are not owned session files before persisting them", async (t) => {
	const { engine, dir } = makeEngine(t);
	try {
		await engine.start();
		const sessions = engine.island.sessions;
		const good = path.join(sessions, "good-chain.jsonl");
		fs.writeFileSync(good, "", { mode: 0o600 });
		const outside = path.join(dir, "outside-secret.jsonl");
		fs.writeFileSync(outside, "OUTSIDE-SECRET\n");
		const planted = path.join(sessions, "planted.jsonl");
		fs.symlinkSync(outside, planted);
		engine.linkSessions(engine.sessionFile, [good, planted, outside]);
		assert.deepEqual(engine.chains[engine.sessionFile], [good], "only the owned file enters the in-memory chain");
		const saved = JSON.parse(fs.readFileSync(path.join(engine.island.root, "state.json"), "utf8"));
		assert.deepEqual(saved.chains[engine.sessionFile], [good], "and the persisted chain carries only owned files");
		assert.ok(!JSON.stringify(saved).includes("outside-secret"), "the planted path is never written to state.json");
	} finally {
		await engine.stop();
	}
});

// ----- T1b-b: the engine uses the bundled Engram (companion seeding + env) ----

const { bundledMemoryEnv, seedEngramCompanion } = require("../src/runtime.cjs");
const { islandPaths } = require("../src/isolation.cjs");

/** A minimal but real-shaped gentle-engram companion inside a fake runtime. */
function fakeCompanion(runtime, version = "0.4.2") {
	const root = path.join(runtime, "node_modules", "gentle-engram");
	fs.mkdirSync(path.join(root, "assets"), { recursive: true });
	fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify({ name: "gentle-engram", version, engram: { startupPolicy: 1 } })}\n`);
	fs.writeFileSync(path.join(root, "index.ts"), "export default () => {};\n");
	fs.writeFileSync(path.join(root, "assets", "logo.svg"), "<svg/>\n");
	return root;
}

function fakeRuntimeWithEngram(t, { version = "0.4.2", engramBin = "bin/engram" } = {}) {
	const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "abito-engram-runtime-"));
	// Retries: Windows releases a just-exited runtime node.exe a moment later (EPERM/EBUSY on unlink).
	t.after(() => fs.rmSync(runtime, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
	fakeCompanion(runtime, version);
	if (engramBin !== null) {
		fs.mkdirSync(path.join(runtime, "bin"), { recursive: true });
		// The file the manifest names, on every OS (the Windows engram.exe mapping has its own fixture below).
		fs.writeFileSync(path.join(runtime, ...engramBin.split("/")), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	}
	fs.writeFileSync(
		path.join(runtime, "koda-runtime.json"),
		`${JSON.stringify({ gentlePi: "4.3.0", gentleShell: "node_modules/gentle-pi/bin/gentle-shell.mjs", engram: version, ...(engramBin === null ? {} : { engramBin }) })}\n`,
	);
	return runtime;
}

const runtimeDepsFor = (runtime) => ({ execPath: path.join(runtime, "node"), existsSync: fs.existsSync, lstatSync: fs.lstatSync, readFileSync: fs.readFileSync });

test("seedEngramCompanion copies the bundled companion into the island and pins it in settings.json", (t) => {
	const runtime = fakeRuntimeWithEngram(t);
	const island = ensureIsland(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "abito-engram-island-")), "island"));
	t.after(() => fs.rmSync(path.join(island.root, ".."), { recursive: true, force: true }));

	const result = seedEngramCompanion(runtime, island.agentDir, runtimeDepsFor(runtime));
	assert.deepEqual(result, { ok: true });

	const target = path.join(island.agentDir, "npm", "node_modules", "gentle-engram");
	assert.equal(JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8")).version, "0.4.2");
	assert.equal(fs.readFileSync(path.join(target, "index.ts"), "utf8"), "export default () => {};\n");
	assert.equal(fs.readFileSync(path.join(target, "assets", "logo.svg"), "utf8"), "<svg/>\n");
	// Real copies, never links, private modes.
	assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
	assert.equal(fs.lstatSync(path.join(target, "index.ts")).isSymbolicLink(), false);
	// POSIX 0600/0700; on Windows the same privacy rule through the helper's real DACL check.
	assertMode(path.join(target, "index.ts"), 0o600);
	assertMode(target, 0o700);

	// settings.json: the pinned companion, every other key preserved.
	const settings = JSON.parse(fs.readFileSync(path.join(island.agentDir, "settings.json"), "utf8"));
	assert.deepEqual(settings.packages, ["npm:gentle-engram@0.4.2"]);
	assertMode(path.join(island.agentDir, "settings.json"), 0o600);
});

test("seedEngramCompanion is idempotent and refreshes when the bundled version differs", (t) => {
	const runtime = fakeRuntimeWithEngram(t);
	const island = ensureIsland(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "abito-engram-island2-")), "island"));
	t.after(() => fs.rmSync(path.join(island.root, ".."), { recursive: true, force: true }));
	const deps = runtimeDepsFor(runtime);
	const target = path.join(island.agentDir, "npm", "node_modules", "gentle-engram");
	const settingsFile = path.join(island.agentDir, "settings.json");

	assert.deepEqual(seedEngramCompanion(runtime, island.agentDir, deps), { ok: true });
	// Simulate the profile store writing its model defaults beside our pin
	// (profiles.cjs spreads the existing settings): the merge must keep both.
	fs.writeFileSync(settingsFile, `${JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-x", packages: ["npm:gentle-engram@0.4.2"] }, null, 2)}\n`, { mode: 0o600 });
	const indexBytes = fs.readFileSync(path.join(target, "index.ts"), "utf8");

	assert.deepEqual(seedEngramCompanion(runtime, island.agentDir, deps), { ok: true });
	assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, "utf8")).packages, ["npm:gentle-engram@0.4.2"], "no duplicate pin");
	assert.equal(JSON.parse(fs.readFileSync(settingsFile, "utf8")).defaultProvider, "anthropic", "other keys survive");
	assert.equal(fs.readFileSync(path.join(target, "index.ts"), "utf8"), indexBytes, "same version: no rewrite churn");

	// A different bundled version refreshes the copy and the pin.
	fs.writeFileSync(path.join(runtime, "node_modules", "gentle-engram", "package.json"), `${JSON.stringify({ name: "gentle-engram", version: "0.5.0" })}\n`);
	fs.writeFileSync(path.join(runtime, "node_modules", "gentle-engram", "extra.mjs"), "export const fresh = true;\n");
	assert.deepEqual(seedEngramCompanion(runtime, island.agentDir, deps), { ok: true });
	assert.equal(JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8")).version, "0.5.0");
	assert.ok(fs.existsSync(path.join(target, "extra.mjs")));
	assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, "utf8")).packages, ["npm:gentle-engram@0.5.0"], "stale pins are replaced");
});

test("seedEngramCompanion refuses symlinks in the companion and a planted settings link", (t) => {
	const runtime = fakeRuntimeWithEngram(t);
	const island = ensureIsland(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "abito-engram-island3-")), "island"));
	t.after(() => fs.rmSync(path.join(island.root, ".."), { recursive: true, force: true }));
	const deps = runtimeDepsFor(runtime);
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "abito-engram-outside-"));
	t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
	fs.writeFileSync(path.join(outside, "evil.ts"), "pwned\n");

	// A symlink inside the bundled companion tree is refused, nothing copied.
	fs.rmSync(path.join(runtime, "node_modules", "gentle-engram", "assets", "logo.svg"));
	fs.symlinkSync(path.join(outside, "evil.ts"), path.join(runtime, "node_modules", "gentle-engram", "assets", "logo.svg"));
	assert.throws(() => seedEngramCompanion(runtime, island.agentDir, deps), /symlink/);
	assert.equal(fs.existsSync(path.join(island.agentDir, "npm", "node_modules", "gentle-engram")), false);
	fs.unlinkSync(path.join(runtime, "node_modules", "gentle-engram", "assets", "logo.svg"));

	// A settings.json replaced by a symlink is never written through.
	fs.symlinkSync(path.join(outside, "evil.ts"), path.join(island.agentDir, "settings.json"));
	assert.throws(() => seedEngramCompanion(runtime, island.agentDir, deps), /symlink|refusing/);
	assert.equal(fs.readFileSync(path.join(outside, "evil.ts"), "utf8"), "pwned\n", "the victim is intact");
});

test("seedEngramCompanion reports a runtime without the companion instead of failing the engine", (t) => {
	const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "abito-engram-empty-"));
	t.after(() => fs.rmSync(runtime, { recursive: true, force: true }));
	const island = islandPaths(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "abito-engram-island4-")), "island"));
	t.after(() => fs.rmSync(path.join(island.root, ".."), { recursive: true, force: true }));
	assert.deepEqual(seedEngramCompanion(runtime, island.agentDir, runtimeDepsFor(runtime)).ok, false);
});

// B1 (verifier): the version refresh used to rmSync the target BEFORE checking
// the path from the island to it, so a symlinked <island>/agent/npm or
// <agent>/npm/node_modules made it delete — and rewrite into — a gentle-engram
// folder OUTSIDE the island (reproduced by the verifier with user data lost).
// Every component must be validated before anything is destroyed.
test("seedEngramCompanion refuses a symlinked island segment and never touches the outside folder (B1)", (t) => {
	const runtime = fakeRuntimeWithEngram(t, { version: "0.4.2" });
	const island = ensureIsland(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "abito-engram-island5-")), "island"));
	t.after(() => fs.rmSync(path.join(island.root, ".."), { recursive: true, force: true }));
	// The victim lives OUTSIDE the island: an npm node_modules with an installed
	// older gentle-engram and a user-data file inside it.
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "abito-engram-victim-"));
	t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
	fs.mkdirSync(path.join(outside, "node_modules", "gentle-engram"), { recursive: true });
	fs.writeFileSync(path.join(outside, "node_modules", "gentle-engram", "package.json"), `${JSON.stringify({ name: "gentle-engram", version: "0.4.1" })}\n`);
	fs.writeFileSync(path.join(outside, "node_modules", "gentle-engram", "USER-DATA.txt"), "user data\n");
	const deps = runtimeDepsFor(runtime);
	const agentDir = island.agentDir;

	// 1. <agent>/npm itself is a symlink out of the island.
	fs.symlinkSync(outside, path.join(agentDir, "npm"));
	assert.throws(() => seedEngramCompanion(runtime, agentDir, deps), /symlink/);
	assert.equal(fs.readFileSync(path.join(outside, "node_modules", "gentle-engram", "USER-DATA.txt"), "utf8"), "user data\n", "the outside folder survived");

	// 2. <agent>/npm/node_modules is a symlink out of the island.
	fs.rmSync(path.join(agentDir, "npm"));
	fs.mkdirSync(path.join(agentDir, "npm"));
	fs.symlinkSync(path.join(outside, "node_modules"), path.join(agentDir, "npm", "node_modules"));
	assert.throws(() => seedEngramCompanion(runtime, agentDir, deps), /symlink/);
	assert.equal(fs.readFileSync(path.join(outside, "node_modules", "gentle-engram", "USER-DATA.txt"), "utf8"), "user data\n", "the outside folder survived");

	// 3. the companion target itself is a symlink: refused, victim intact.
	fs.rmSync(path.join(agentDir, "npm", "node_modules"));
	fs.mkdirSync(path.join(agentDir, "npm", "node_modules"));
	fs.symlinkSync(path.join(outside, "node_modules", "gentle-engram"), path.join(agentDir, "npm", "node_modules", "gentle-engram"));
	assert.throws(() => seedEngramCompanion(runtime, agentDir, deps), /symlink/);
	assert.equal(fs.readFileSync(path.join(outside, "node_modules", "gentle-engram", "USER-DATA.txt"), "utf8"), "user data\n", "the outside folder survived");

	// No debris was written into the island either.
	assert.deepEqual(fs.readdirSync(path.join(agentDir, "npm", "node_modules")), ["gentle-engram"]);
	assert.equal(fs.lstatSync(path.join(agentDir, "npm", "node_modules", "gentle-engram")).isSymbolicLink(), true);
});

// F5 (verifier): the copy's SOURCE must be validated the way runtimeScript
// validates gentleShell: a symlink at any segment between the runtime root and
// the companion may not redirect the bundled copy from outside the runtime.
test("seedEngramCompanion refuses a symlinked runtime segment before copying (F5)", (t) => {
	const runtime = fakeRuntimeWithEngram(t);
	const island = ensureIsland(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "abito-engram-island6-")), "island"));
	t.after(() => fs.rmSync(path.join(island.root, ".."), { recursive: true, force: true }));
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "abito-engram-outsource-"));
	t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
	fs.mkdirSync(path.join(outside, "node_modules", "gentle-engram"), { recursive: true });
	fs.writeFileSync(path.join(outside, "node_modules", "gentle-engram", "package.json"), `${JSON.stringify({ name: "gentle-engram", version: "9.9.9" })}\n`);
	fs.writeFileSync(path.join(outside, "node_modules", "gentle-engram", "USER-DATA.txt"), "user data\n");
	// Point the runtime's node_modules at the outside tree.
	fs.rmSync(path.join(runtime, "node_modules"), { recursive: true, force: true });
	fs.symlinkSync(path.join(outside, "node_modules"), path.join(runtime, "node_modules"));
	assert.throws(() => seedEngramCompanion(runtime, island.agentDir, runtimeDepsFor(runtime)), /symlink/);
	assert.equal(fs.readFileSync(path.join(outside, "node_modules", "gentle-engram", "USER-DATA.txt"), "utf8"), "user data\n", "nothing outside was touched");
	assert.equal(fs.existsSync(path.join(island.agentDir, "npm", "node_modules", "gentle-engram")), false, "nothing was copied");
});

// F4 (verifier): the idempotency check must verify the tree, not just the
// version, so a partial/corrupt copy from a failed run is repaired.
test("a partial companion target is repaired whole on the next seed (F4)", (t) => {
	const runtime = fakeRuntimeWithEngram(t);
	const island = ensureIsland(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "abito-engram-island7-")), "island"));
	t.after(() => fs.rmSync(path.join(island.root, ".."), { recursive: true, force: true }));
	const deps = runtimeDepsFor(runtime);
	const target = path.join(island.agentDir, "npm", "node_modules", "gentle-engram");
	assert.deepEqual(seedEngramCompanion(runtime, island.agentDir, deps), { ok: true });
	// Damage WITHOUT changing the version the old check looked at: one file gone,
	// another corrupted in place (what a failed copy leaves behind).
	fs.rmSync(path.join(target, "assets", "logo.svg"));
	fs.writeFileSync(path.join(target, "index.ts"), "corrupt" );
	assert.deepEqual(seedEngramCompanion(runtime, island.agentDir, deps), { ok: true });
	assert.equal(fs.readFileSync(path.join(target, "index.ts"), "utf8"), "export default () => {};\n", "the corrupted file was restored");
	assert.equal(fs.readFileSync(path.join(target, "assets", "logo.svg"), "utf8"), "<svg/>\n", "the removed file came back");
});

// F4: the copy itself is atomic — staged inside the validated parent, verified,
// renamed into place. A failure midway must leave no partial target and no
// staging debris, and a later seed must succeed.
test("a copy that fails midway leaves no partial target and repairs on a later seed (F4)", unixOnly("chmod 000 needs POSIX permissions"), (t) => {
	const runtime = fakeRuntimeWithEngram(t);
	const island = ensureIsland(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "abito-engram-island8-")), "island"));
	t.after(() => fs.rmSync(path.join(island.root, ".."), { recursive: true, force: true }));
	const deps = runtimeDepsFor(runtime);
	const modules = path.join(island.agentDir, "npm", "node_modules");
	fs.chmodSync(path.join(runtime, "node_modules", "gentle-engram", "index.ts"), 0o000); // readFile of the SOURCE fails midway through the copy
	assert.throws(() => seedEngramCompanion(runtime, island.agentDir, deps), (error) => error.code === "EACCES" || /access/i.test(error.message));
	fs.chmodSync(path.join(runtime, "node_modules", "gentle-engram", "index.ts"), 0o644);
	assert.equal(fs.existsSync(path.join(modules, "gentle-engram")), false, "no partial companion at the real target");
	assert.deepEqual(fs.readdirSync(modules).filter((n) => n.startsWith(".gentle-engram.")), [], "no staging debris");
	assert.deepEqual(seedEngramCompanion(runtime, island.agentDir, deps), { ok: true }, "a later seed succeeds completely");
	assert.equal(fs.readFileSync(path.join(modules, "gentle-engram", "assets", "logo.svg"), "utf8"), "<svg/>\n");
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(island.agentDir, "settings.json"), "utf8")).packages, ["npm:gentle-engram@0.4.2"]);
});

// F4 re-verify (verifier): the fingerprint was only `path:size`, so a
// companion upgrade with SAME-SIZE files (0.4.2 -> 0.4.3) kept the old copy
// while settings.json pinned the new version, and a zero-filled same-size
// file was never repaired. The fingerprint must include the package version
// AND a sha256 content hash of every file.
test("a same-size version bump refreshes the companion copy and the pin (F4)", (t) => {
	const runtime = fakeRuntimeWithEngram(t);
	const island = ensureIsland(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "abito-engram-island9-")), "island"));
	t.after(() => fs.rmSync(path.join(island.root, ".."), { recursive: true, force: true }));
	const deps = runtimeDepsFor(runtime);
	const target = path.join(island.agentDir, "npm", "node_modules", "gentle-engram");
	assert.deepEqual(seedEngramCompanion(runtime, island.agentDir, deps), { ok: true });
	// 0.4.2 -> 0.4.3: same file sizes everywhere, version is the only change.
	fs.writeFileSync(path.join(runtime, "node_modules", "gentle-engram", "package.json"), `${JSON.stringify({ name: "gentle-engram", version: "0.4.3", engram: { startupPolicy: 1 } })}\n`);
	assert.deepEqual(seedEngramCompanion(runtime, island.agentDir, deps), { ok: true });
	assert.equal(JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8")).version, "0.4.3", "the same-size upgrade was copied");
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(island.agentDir, "settings.json"), "utf8")).packages, ["npm:gentle-engram@0.4.3"], "the pin follows the copied version");
});

test("a same-size corrupted file is repaired (F4)", (t) => {
	const runtime = fakeRuntimeWithEngram(t);
	const island = ensureIsland(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "abito-engram-island10-")), "island"));
	t.after(() => fs.rmSync(path.join(island.root, ".."), { recursive: true, force: true }));
	const deps = runtimeDepsFor(runtime);
	const target = path.join(island.agentDir, "npm", "node_modules", "gentle-engram");
	assert.deepEqual(seedEngramCompanion(runtime, island.agentDir, deps), { ok: true });
	// Zero-fill style corruption: same byte length, different content.
	const original = fs.readFileSync(path.join(target, "index.ts"), "utf8");
	fs.writeFileSync(path.join(target, "index.ts"), "0".repeat(original.length));
	assert.deepEqual(seedEngramCompanion(runtime, island.agentDir, deps), { ok: true });
	assert.equal(fs.readFileSync(path.join(target, "index.ts"), "utf8"), "export default () => {};\n", "the zero-filled same-size file was repaired");
});

test("an unchanged companion tree is a no-op: nothing is re-copied (F4)", (t) => {
	const runtime = fakeRuntimeWithEngram(t);
	const island = ensureIsland(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "abito-engram-island11-")), "island"));
	t.after(() => fs.rmSync(path.join(island.root, ".."), { recursive: true, force: true }));
	const deps = runtimeDepsFor(runtime);
	const target = path.join(island.agentDir, "npm", "node_modules", "gentle-engram");
	assert.deepEqual(seedEngramCompanion(runtime, island.agentDir, deps), { ok: true });
	const before = fs.lstatSync(target).ino;
	const fileBefore = fs.lstatSync(path.join(target, "index.ts")).ino;
	assert.deepEqual(seedEngramCompanion(runtime, island.agentDir, deps), { ok: true });
	assert.equal(fs.lstatSync(target).ino, before, "the directory was not replaced (no copy happened)");
	assert.equal(fs.lstatSync(path.join(target, "index.ts")).ino, fileBefore, "no file was rewritten");
});

// T1c (S5/L11): the user-binary resolution order is GONE — the ONLY engram
// binary Koda ever uses is the pinned one its runtime ships. The user's own
// Engram (their ~/.engram, their server on 7437/7438) is never read, probed
// or inherited.

test("bundledMemoryEnv runs Koda's private memory: the bundled binary, Koda's port, never the user's server or store", (t) => {
	const runtime = fakeRuntimeWithEngram(t);
	const deps = runtimeDepsFor(runtime);
	const env = bundledMemoryEnv(
		{
			HOME: "/home/user",
			ENGRAM_URL: "http://127.0.0.1:9999",
			ENGRAM_PORT: "7437",
			ENGRAM_DATA_DIR: "/home/user/.engram",
			ENGRAM_BIN: "/custom/user-engram",
			ABITO_ENGRAM_PORT: "7499",
		},
		runtime,
		deps,
	);
	assert.equal(env.ENGRAM_BIN, path.join(runtime, "bin", "engram"), "ONLY the bundled binary: the parent's ENGRAM_BIN is ignored");
	assert.equal(env.ENGRAM_PORT, "7499", "ABITO_ENGRAM_PORT overrides Koda's private port");
	assert.equal(env.ENGRAM_URL, undefined, "the user's server is never inherited");
	assert.equal(env.ENGRAM_DATA_DIR, undefined, "the user's store is never inherited: the store follows the island HOME");
	assert.equal(env.GENTLE_SHELL_PREFIX, undefined, "GENTLE_SHELL_PREFIX is never set");
	assert.equal(env.ENGRAM_NO_UPDATE_CHECK, "1", "the private memory never phones home for updates");
	assert.equal(env.ENGRAM_STARTUP_POLICY, undefined, "with the bundled binary the startup policy stays unset (memory on)");
	assert.equal(bundledMemoryEnv({ HOME: "/home/user" }, runtime, deps).ENGRAM_PORT, "7439", "default private port");

	// Windows resolves the real home through USERPROFILE (Gentle Dot isolation)
	// and names engram.exe; the mapping is otherwise identical.
	fs.mkdirSync(path.join(runtime, "bin"), { recursive: true });
	fs.writeFileSync(path.join(runtime, "bin", "engram.exe"), "#!exit\n", { mode: 0o755 });
	fs.writeFileSync(path.join(runtime, "koda-runtime.json"), `${JSON.stringify({ gentlePi: "4.3.0", gentleShell: "node_modules/gentle-pi/bin/gentle-shell.mjs", engramBin: "bin/engram.exe" })}\n`);
	const winEnv = bundledMemoryEnv({ USERPROFILE: "C:\\Users\\u" }, runtime, { ...deps, platform: "win32" });
	assert.equal(winEnv.ENGRAM_BIN, path.join(runtime, "bin", "engram.exe"));
	assert.equal(winEnv.ENGRAM_PORT, "7439");
	assert.equal(winEnv.ENGRAM_DATA_DIR, undefined);
	assert.equal(winEnv.ENGRAM_URL, undefined);
	assert.equal(winEnv.ENGRAM_STARTUP_POLICY, undefined, "memory on: the policy is never set to disabled");
});

// F1 (verifier): without a usable engramBin the companion's ENGRAM_BIN falls
// back to `engram` on the inherited PATH (gentle-engram index.ts:27), which on
// a real machine resolves the USER's binary (~/.local/bin/engram) — breaking
// «bundled pinned binary only» and making the «chat starts without memory»
// log false. gentle-engram honours ENGRAM_STARTUP_POLICY (index.ts:30-31):
// anything but unset/"allow" fails closed — no tools, no spawn, no PATH lookup
// — so the degraded case pins the policy to "disabled" and the log stays true.
test("bundledMemoryEnv pins ENGRAM_STARTUP_POLICY=disabled whenever ENGRAM_BIN cannot be resolved (F1)", () => {
	const deps = { existsSync: fs.existsSync, lstatSync: fs.lstatSync, readFileSync: fs.readFileSync };
	// No runtime at all.
	const noRuntime = bundledMemoryEnv({ HOME: "/home/user" }, undefined, deps);
	assert.equal(noRuntime.ENGRAM_BIN, undefined);
	assert.equal(noRuntime.ENGRAM_STARTUP_POLICY, "disabled", "no bundled binary: the companion must never fall back to the PATH's engram");
});

// A manifest without engramBin (pre-T1b runtimes, test doubles): the private
// memory env still travels (port, no user store) — only the binary degrades.
test("bundledMemoryEnv without a manifest binary still runs the private memory", (t) => {
	const noBin = fakeRuntimeWithEngram(t, { engramBin: null });
	const env = bundledMemoryEnv({ HOME: "/home/user", ENGRAM_DATA_DIR: "/data/engram" }, noBin, runtimeDepsFor(noBin));
	assert.equal(env.ENGRAM_BIN, undefined);
	assert.equal(env.ENGRAM_PORT, "7439");
	assert.equal(env.ENGRAM_DATA_DIR, undefined, "the parent's ENGRAM_DATA_DIR is never honoured");
	assert.equal(env.ENGRAM_STARTUP_POLICY, "disabled", "F1: no bundled binary — the companion is disabled, never the PATH's engram");
});

// F7: a bad or symlinked engramBin no longer fails the spawn (the old
// hard-error pinned by the previous version of this test): it degrades — no
// ENGRAM_BIN, private memory env still travels, chat still starts. Fail closed
// about WHAT is used, never about WHETHER the engine runs.
test("bundledMemoryEnv degrades without ENGRAM_BIN on a bad or symlinked engramBin in the manifest", (t) => {
	const runtime = fakeRuntimeWithEngram(t);
	const deps = runtimeDepsFor(runtime);
	for (const bad of ["../evil/engram", "/evil/engram", ""]) {
		fs.writeFileSync(path.join(runtime, "koda-runtime.json"), `${JSON.stringify({ gentlePi: "4.3.0", gentleShell: "node_modules/gentle-pi/bin/gentle-shell.mjs", engramBin: bad })}\n`);
		const env = bundledMemoryEnv({ HOME: "/home/user" }, runtime, deps);
		assert.equal(env.ENGRAM_BIN, undefined, `no ENGRAM_BIN for engramBin ${JSON.stringify(bad)}`);
		assert.equal(env.ENGRAM_PORT, "7439", "the private memory env survives the degradation");
		assert.equal(env.ENGRAM_DATA_DIR, undefined);
		assert.equal(env.ENGRAM_STARTUP_POLICY, "disabled", "F1: the PATH fallback can never resolve the user's engram");
	}
	// A symlinked binary is refused too: refused as a BINARY, degraded as an env.
	fs.writeFileSync(path.join(runtime, "koda-runtime.json"), `${JSON.stringify({ gentlePi: "4.3.0", gentleShell: "node_modules/gentle-pi/bin/gentle-shell.mjs", engramBin: "bin/engram" })}\n`);
	fs.rmSync(path.join(runtime, "bin", "engram"));
	fs.symlinkSync("/evil/engram", path.join(runtime, "bin", "engram"));
	const symlinked = bundledMemoryEnv({ HOME: "/home/user" }, runtime, deps);
	assert.equal(symlinked.ENGRAM_BIN, undefined);
	assert.equal(symlinked.ENGRAM_STARTUP_POLICY, "disabled");
});

// T1c (S5/L11): the F6 user-binary order (ENGRAM_BIN / login shell / known
// dirs) is deleted together with its tests — the bundled binary named by the
// runtime manifest is the ONLY one Koda resolves. Its former tests
// (resolveEngramBin, engramKnownDirs) are gone with the code.

// F7 (verifier): a missing/invalid engramBin used to throw at spawn so the
// chat never started; instead it degrades like seeding: log, no ENGRAM_BIN,
// engine ready.
test("a bad engramBin degrades: the engine starts without memory tools and says so (F7)", unixOnly("needs a #!/bin/sh fake runtime launcher"), async (t) => {
	const runtime = fakeRuntimeWithEngram(t, { engramBin: null });
	const scriptRel = "node_modules/gentle-pi/bin/gentle-shell.mjs";
	fs.mkdirSync(path.join(runtime, "node_modules", "gentle-pi", "bin"), { recursive: true });
	fs.writeFileSync(path.join(runtime, ...scriptRel.split("/")), "");
	const launcher = path.join(runtime, "gentle-shell");
	fs.writeFileSync(launcher, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_AGENT}' "$@"\n`);
	fs.chmodSync(launcher, 0o755);
	// A manifest that NAMES an engramBin that is not there.
	fs.writeFileSync(path.join(runtime, "koda-runtime.json"), `${JSON.stringify({ gentlePi: "4.3.0", gentleShell: scriptRel, engramBin: "bin/engram" })}\n`);
	const logs = [];
	const { engine, envOut } = makeEngine(t, {
		command: "gentle-shell",
		commandArgs: [],
		runtimeDeps: runtimeDepsFor(runtime),
		log: (line) => logs.push(line),
	});
	await engine.start();
	assert.equal(engine.status, "ready", "the engine starts with a broken engramBin");
	const childEnv = JSON.parse(fs.readFileSync(envOut, "utf8"));
	assert.equal(childEnv.ENGRAM_BIN, undefined, "no ENGRAM_BIN when the manifest's binary is absent");
	assert.equal(childEnv.ENGRAM_STARTUP_POLICY, "disabled", "F1: the engine env disables the companion instead of inviting a PATH engram");
	assert.ok(logs.some((l) => /memory/i.test(l)), `the degradation is logged: ${JSON.stringify(logs)}`);
	const response = await engine.request({ type: "get_state" });
	assert.equal(response.success, true, "the chat still works, no memory tools");
	await engine.stop();
});

test("the default engine's child gets the memory env and the seeded companion; a custom command gets neither", unixOnly("needs a #!/bin/sh fake runtime launcher; the env rules are platform-independent (bundledMemoryEnv tests above pin the Windows mapping)"), async (t) => {
	const runtime = fakeRuntimeWithEngram(t);
	const scriptRel = "node_modules/gentle-pi/bin/gentle-shell.mjs";
	fs.mkdirSync(path.join(runtime, "node_modules", "gentle-pi", "bin"), { recursive: true });
	fs.writeFileSync(path.join(runtime, ...scriptRel.split("/")), "");
	const launcher = path.join(runtime, "gentle-shell");
	fs.writeFileSync(launcher, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_AGENT}' "$@"\n`);
	fs.chmodSync(launcher, 0o755);

	const home = fs.mkdtempSync(path.join(os.tmpdir(), "abito-engram-home-"));
	t.after(() => fs.rmSync(home, { recursive: true, force: true }));
	// The parent env carries the user's own Engram server/store: none of it may
	// reach the child — the private memory replaces it (T1c).
	const { engine, envOut } = makeEngine(t, {
		command: "gentle-shell",
		commandArgs: [],
		runtimeDeps: runtimeDepsFor(runtime),
		env: { HOME: home, PATH: process.env.PATH, ENGRAM_DATA_DIR: path.join(home, "store"), ENGRAM_URL: "http://127.0.0.1:9999", ENGRAM_PORT: "7437", ENGRAM_BIN: "/custom/user-engram", GENTLE_SHELL_PREFIX: "/evil/prefix" },
	});
	try {
		await engine.start();
		const childEnv = JSON.parse(fs.readFileSync(envOut, "utf8"));
		assert.equal(childEnv.ENGRAM_BIN, path.join(runtime, "bin", "engram"), "only the bundled binary");
		assert.equal(childEnv.ENGRAM_PORT, "7439", "Koda's private port, not the parent's ENGRAM_PORT");
		assert.equal(childEnv.ENGRAM_DATA_DIR, undefined, "the user's store is never inherited");
		assert.equal(childEnv.ENGRAM_URL, undefined, "the user's server is never inherited");
		assert.equal(childEnv.ABITO_MEMORY_PROJECT, "abito-island");
		assert.equal(childEnv.GENTLE_SHELL_PREFIX, undefined, "never GENTLE_SHELL_PREFIX");
		// The companion was seeded into the engine's own home before the first spawn.
		assert.equal(JSON.parse(fs.readFileSync(path.join(engine.island.agentDir, "npm", "node_modules", "gentle-engram", "package.json"), "utf8")).version, "0.4.2");
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(engine.island.agentDir, "settings.json"), "utf8")).packages, ["npm:gentle-engram@0.4.2"]);
		// The memory project pin is untouched.
		assert.equal(JSON.parse(fs.readFileSync(path.join(engine.island.workspace, ".engram", "config.json"), "utf8")).project_name, "abito-island");
	} finally {
		await engine.stop().catch(() => {});
	}

	// A custom (non-default) command gets NO memory env at all: the bundled
	// Engram travels only with Koda's own engine.
	const plain = makeEngine(t, {
		env: { HOME: home, PATH: process.env.PATH, ENGRAM_DATA_DIR: path.join(home, "store") },
	});
	try {
		await plain.engine.start();
		const plainEnv = JSON.parse(fs.readFileSync(plain.envOut, "utf8"));
		assert.equal(plainEnv.ENGRAM_BIN, undefined);
		assert.equal(plainEnv.ENGRAM_DATA_DIR, undefined, "the user's store is never exposed to a foreign command");
		assert.equal(plainEnv.ENGRAM_URL, undefined);
		assert.equal(plainEnv.ENGRAM_PORT, undefined);
		assert.equal(plainEnv.ABITO_MEMORY_PROJECT, "abito-island");
	} finally {
		await plain.engine.stop().catch(() => {});
	}
});

// ----- F3/F4 (verifier follow-ups, K2-05 T1c, commit e141ed1) ----------------

test("bundledMemoryEnv refuses the user's own Engram ports as a configuration error (F3)", (t) => {
	const runtime = fakeRuntimeWithEngram(t);
	const deps = runtimeDepsFor(runtime);
	for (const reserved of ["7437", "7438"]) {
		assert.throws(
			() => bundledMemoryEnv({ HOME: "/home/user", ABITO_ENGRAM_PORT: reserved }, runtime, deps),
			new RegExp(`${reserved} belongs to the user's own Engram server`),
			`ABITO_ENGRAM_PORT=${reserved} must be refused, not inherited into the engine`,
		);
	}
});

// F4 (verifier): envOverrides is applied LAST in the child env, so a caller
// re-adding ENGRAM_* there would silently break the «no user ENGRAM_* for the
// default engine» rule the bundledMemoryEnv comment claims. Enforced, not just
// documented: for Koda's own engine every ENGRAM_* caller override is dropped;
// a custom command (no private memory) keeps the caller's env as before.
test("the default engine drops ENGRAM_* caller overrides; a custom command keeps them (F4)", async (t) => {
	const runtime = fakeRuntimeWithEngram(t);
	const scriptRel = "node_modules/gentle-pi/bin/gentle-shell.mjs";
	fs.mkdirSync(path.join(runtime, "node_modules", "gentle-pi", "bin"), { recursive: true });
	if (win) {
		// The shipped Windows runtime shape (bundledGentleShell): the runtime's own node.exe runs the script the
		// manifest names; here that script hands over to the fake agent with the engine's argv unchanged.
		fs.copyFileSync(process.execPath, path.join(runtime, "node.exe"));
		fs.writeFileSync(
			path.join(runtime, ...scriptRel.split("/")),
			`import { createRequire } from "node:module";\ncreateRequire(import.meta.url)(${JSON.stringify(FAKE_AGENT)});\n`,
		);
	} else {
		fs.writeFileSync(path.join(runtime, ...scriptRel.split("/")), "");
		const launcher = path.join(runtime, "gentle-shell");
		fs.writeFileSync(launcher, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_AGENT}' "$@"\n`);
		fs.chmodSync(launcher, 0o755);
	}
	const overrides = { ENGRAM_BIN: "/custom/user-engram", ENGRAM_PORT: "7437", ENGRAM_URL: "http://127.0.0.1:9999", ENGRAM_DATA_DIR: "/home/user/.engram", ENGRAM_STARTUP_POLICY: "allow", ENGRAM_NO_UPDATE_CHECK: "0", ENGRAM_PI_SESSION_TRACE: "1", OTHER_OVERRIDE: "kept" };

	const { engine, envOut } = makeEngine(t, {
		command: "gentle-shell",
		commandArgs: [],
		runtimeDeps: runtimeDepsFor(runtime),
		envOverrides: overrides,
	});
	try {
		await engine.start();
		const childEnv = JSON.parse(fs.readFileSync(envOut, "utf8"));
		assert.equal(childEnv.ENGRAM_BIN, path.join(runtime, "bin", "engram"), "the bundled binary wins over the caller's ENGRAM_BIN");
		assert.equal(childEnv.ENGRAM_PORT, "7439", "Koda's private port wins over the caller's ENGRAM_PORT");
		assert.equal(childEnv.ENGRAM_URL, undefined, "the caller cannot re-add the user's server");
		assert.equal(childEnv.ENGRAM_DATA_DIR, undefined, "the caller cannot re-add the user's store");
		assert.equal(childEnv.ENGRAM_STARTUP_POLICY, undefined, "memory is on with the bundled binary; no caller policy");
		assert.equal(childEnv.ENGRAM_NO_UPDATE_CHECK, "1", "the offline pin wins over the caller's ENGRAM_NO_UPDATE_CHECK");
		assert.equal(childEnv.ENGRAM_PI_SESSION_TRACE, "1", "the diagnostic-only stderr trace flag still passes (F4 exception)");
		assert.equal(childEnv.OTHER_OVERRIDE, "kept", "non-memory overrides still pass");
	} finally {
		await engine.stop().catch(() => {});
	}

	const plain = makeEngine(t, { envOverrides: overrides });
	try {
		await plain.engine.start();
		const plainEnv = JSON.parse(fs.readFileSync(plain.envOut, "utf8"));
		assert.equal(plainEnv.ENGRAM_PORT, "7437", "a custom command has no private memory; the caller's env passes unchanged");
	} finally {
		await plain.engine.stop().catch(() => {});
	}
});

// F5 (verifier): the identity told the agent to «search broadly… the user keeps
// knowledge from many projects there» — written for the OLD shared-store shape.
// Koda's memory is now its own private store (T1c, L11) that starts empty, and
// the hidden-names list stays intact. The SAVE rule (project abito-island,
// never another) is a product decision (L5) and must stay byte-identical.
test("identity.md fits the private memory store: no broad cross-project search, the save rule intact (F5)", () => {
	const identity = fs.readFileSync(path.join(__dirname, "..", "identity.md"), "utf8");
	assert.equal(
		identity.split("\n").includes("- When you save a memory, always save it to the project `abito-island` and never pass a different one."),
		true,
		"the save rule stays byte-identical (L5)",
	);
	assert.doesNotMatch(identity, /all projects|match_mode|search broadly|knowledge from many projects/, "no shared-store cross-project search advice");
	assert.match(identity, /abito-island/, "the memory rules still name the one project");
});
