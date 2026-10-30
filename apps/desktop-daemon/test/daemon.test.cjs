"use strict";

// U4 daemon lifecycle tests with the fake RPC agent (no pi, no provider, no network).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const { Daemon, classifySession, isDaemonProcess, pidAlive, procStartTicks, readSession } = require("../src/daemon.cjs");
const { writePrivateFile } = require("../src/isolation.cjs");

/** The #390 launch ledger, one JSON object per line; [] when the daemon never booted here. */
function ledgerLines(root) {
	const file = path.join(root, "runtime", "launches.jsonl");
	if (!fs.existsSync(file)) return [];
	return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

const FAKE = path.join(__dirname, "fixtures", "fake-agent.cjs");
const TEST_BASES = new Set();
test.after(() => { for (const base of TEST_BASES) fs.rmSync(base, { recursive: true, force: true }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 5000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (fn()) return;
		await sleep(10);
	}
	assert.ok(fn(), "waitFor timed out");
}
function tmp() {
	const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "abito-d-")));
	TEST_BASES.add(base);
	return base;
}
/** Kills (if needed) and waits for a child's exit so nothing leaks. */
async function reap(child) {
	if (child.exitCode === null && child.signalCode === null) {
		const exited = new Promise((resolve) => child.once("exit", resolve));
		child.kill("SIGKILL");
		await exited;
	}
}

function make(extra = {}) {
	const base = tmp();
	const root = path.join(base, "i");
	const logs = [];
	const evidence = { cwd: path.join(base, "cwd.txt"), cmd: path.join(base, "cmd.log"), spawn: path.join(base, "spawn.log") };
	const daemon = new Daemon({
		root,
		env: { PATH: process.env.PATH, ...(extra.env ?? {}) },
		log: (line) => logs.push(String(line)),
		engineOptions: {
			command: process.execPath,
			commandArgs: [FAKE, "--cwd-out", evidence.cwd, "--cmd-log", evidence.cmd, "--spawn-log", evidence.spawn],
			backoffMs: [20],
			stopTimeoutMs: 500,
			requestTimeoutMs: 3000,
			startTimeoutMs: 5000,
		},
		...(extra.options ?? {}),
	});
	return { daemon, root, base, logs, evidence };
}

function connect(session) {
	return new Promise((resolve, reject) => {
		const socket = net.connect(session.endpoint);
		const frames = [];
		let buf = "";
		socket.on("data", (d) => {
			buf += d.toString("utf8");
			let i;
			while ((i = buf.indexOf("\n")) >= 0) {
				frames.push(JSON.parse(buf.slice(0, i)));
				buf = buf.slice(i + 1);
			}
		});
		socket.on("error", reject);
		socket.on("connect", () => {
			socket.write(`${JSON.stringify({ type: "hello", protocol: "island-agent/1", token: session.token })}\n`);
			resolve({ socket, frames });
		});
	});
}

test("start writes a private session.json, serves the protocol, stop removes it", async () => {
	const { daemon, root, logs } = make();
	await daemon.start();
	try {
		const file = path.join(root, "runtime", "session.json");
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		const session = JSON.parse(fs.readFileSync(file, "utf8"));
		assert.deepEqual(Object.keys(session).sort(), ["endpoint", "pid", "ppid", "procStart", "protocol", "startedAt", "token"]);
		assert.equal(session.protocol, "island-agent/1");
		assert.equal(session.pid, process.pid);
		assert.ok(session.token.length >= 32);
		assert.ok(session.endpoint.startsWith(path.join(root, "runtime")));
		assert.equal(fs.statSync(session.endpoint).isSocket(), true);
		const { socket, frames } = await connect(session);
		await waitFor(() => frames.some((f) => f.type === "ready"));
		socket.write(`${JSON.stringify({ type: "status" })}\n`);
		await waitFor(() => frames.some((f) => f.type === "agent_state"));
		socket.destroy();
		assert.deepEqual(readSession(root), session);
		await daemon.stop();
		assert.equal(fs.existsSync(file), false);
		assert.equal(fs.existsSync(session.endpoint), false);
		assert.equal(logs.some((l) => l.includes(session.token)), false, "token must never be logged");
	} finally {
		await daemon.stop();
	}
});

test("each launch generates a fresh token; double start is refused", async () => {
	const a = make();
	await a.daemon.start();
	const tokenA = readSession(a.root).token;
	await assert.rejects(() => a.daemon.start());
	await a.daemon.stop();
	const b = make();
	await b.daemon.start();
	assert.notEqual(readSession(b.root).token, tokenA);
	await b.daemon.stop();
});

test("a stale session.json of a dead pid is replaced; stop is idempotent", async () => {
	const { daemon, root } = make();
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	const dead = spawnSync(process.execPath, ["-e", ""]).pid;
	writePrivateFile(path.join(root, "runtime", "session.json"), JSON.stringify({ protocol: "island-agent/1", endpoint: "/x", token: "t".repeat(40), pid: dead, startedAt: 1 }));
	await daemon.start();
	assert.equal(readSession(root).pid, process.pid);
	await daemon.stop();
	await daemon.stop();
});

test("workspace change restarts the engine with the new cwd and forgets the old session", async () => {
	const { daemon, root, evidence, base } = make();
	await daemon.start();
	const first = fs.readFileSync(evidence.cwd, "utf8");
	assert.equal(first, path.join(root, "workspace"));
	const state = JSON.parse(fs.readFileSync(path.join(root, "state.json"), "utf8"));
	assert.ok(state.sessionFile);
	const token = readSession(root).token;
	const ws = path.join(base, "ws");
	fs.mkdirSync(ws);
	const result = await daemon.setWorkspace(ws);
	assert.equal(result.restarted, true);
	assert.equal(daemon.engine.status, "ready");
	assert.equal(fs.readFileSync(evidence.cwd, "utf8"), ws);
	const cmds = fs.readFileSync(evidence.cmd, "utf8");
	assert.equal(cmds.includes("switch_session"), false, "old session must not be reopened");
	assert.equal(readSession(root).token, token, "endpoint and token survive the engine restart");
	assert.equal(daemon.status().workspace, ws);
	assert.equal(JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8")).workspace, ws);
	assert.equal(fs.readFileSync(evidence.spawn, "utf8").trim().split("\n").length, 2);
	await daemon.stop();
});

test("ABITO_WORKSPACE wins: persisting a new workspace does not restart the engine", async () => {
	const base = tmp();
	const envWs = path.join(base, "envws");
	fs.mkdirSync(envWs);
	const { daemon, evidence } = make({ env: { ABITO_WORKSPACE: envWs } });
	await daemon.start();
	const other = path.join(base, "other");
	fs.mkdirSync(other);
	const result = await daemon.setWorkspace(other);
	assert.equal(result.restarted, false);
	assert.equal(result.overriddenByEnv, true);
	assert.equal(fs.readFileSync(evidence.cwd, "utf8"), envWs);
	assert.equal(daemon.status().workspaceSource, "env");
	await daemon.stop();
});

test("invalid workspace change is rejected and the engine keeps running untouched", async () => {
	const { daemon, evidence } = make();
	await daemon.start();
	await assert.rejects(() => daemon.setWorkspace("relative/path"), /invalid config: workspace/);
	assert.equal(daemon.engine.status, "ready");
	assert.equal(fs.readFileSync(evidence.spawn, "utf8").trim().split("\n").length, 1);
	await daemon.stop();
});

test("workspace change is refused while a turn is running", async () => {
	const { daemon, base } = make();
	await daemon.start();
	daemon.server.busy = true;
	const ws = path.join(base, "w");
	fs.mkdirSync(ws);
	await assert.rejects(() => daemon.setWorkspace(ws), /busy/);
	assert.equal(fs.existsSync(path.join(daemon.root, "config.json")), false);
	await daemon.stop();
});

test("agent crash restarts the engine while the server and session.json stay up", async () => {
	const { daemon, root } = make();
	await daemon.start();
	const session = readSession(root);
	const { socket, frames } = await connect(session);
	await waitFor(() => frames.some((f) => f.type === "ready"));
	daemon.engine.send({ type: "crash" });
	await waitFor(() => frames.some((f) => f.type === "agent_state" && f.status === "restarting"));
	await waitFor(() => daemon.engine.status === "ready");
	await waitFor(() => frames.filter((f) => f.type === "agent_state" && f.status === "ready").length >= 1);
	assert.deepEqual(readSession(root), session);
	assert.equal(socket.destroyed, false);
	socket.destroy();
	await daemon.stop();
});

test("memory pin conflict is surfaced in status without writing into the workspace", async () => {
	const base = tmp();
	const ws = path.join(base, "ws");
	fs.mkdirSync(path.join(ws, ".engram"), { recursive: true });
	fs.writeFileSync(path.join(ws, ".engram", "config.json"), JSON.stringify({ project_name: "someone-else" }));
	const { daemon } = make({ env: { ABITO_WORKSPACE: ws } });
	await daemon.start();
	const status = daemon.status();
	assert.equal(status.memoryPinConflict, true);
	assert.deepEqual(fs.readdirSync(ws).sort(), [".engram"]);
	assert.deepEqual(fs.readdirSync(path.join(ws, ".engram")), ["config.json"]);
	await daemon.stop();
	const clean = make();
	await clean.daemon.start();
	assert.equal(clean.daemon.status().memoryPinConflict, false);
	await clean.daemon.stop();
});

test("AccountManager.inUse is wired to ProfileStore.usesAccount", async () => {
	const { daemon, root } = make();
	writePrivateFile(
		path.join(root, "profiles.json"),
		JSON.stringify({ profiles: [{ id: "p1", label: "P", role: "main", accountId: "main", provider: "x", modelId: "m", thinkingLevel: "low" }] }),
	);
	await daemon.start();
	assert.equal(daemon.accounts.inUse("main"), true);
	assert.equal(daemon.accounts.inUse("other"), false);
	await daemon.stop();
});

test("configured thinking default is applied once the engine is ready", async () => {
	const { daemon, root, evidence } = make();
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	writePrivateFile(path.join(root, "config.json"), JSON.stringify({ thinking: "high" }));
	await daemon.start();
	await waitFor(() => fs.existsSync(evidence.cmd) && fs.readFileSync(evidence.cmd, "utf8").includes("set_thinking_level"));
	assert.ok(fs.readFileSync(evidence.cmd, "utf8").includes('"level":"high"'));
	await daemon.stop();
});

test("MCP: a valid private source is projected into the agent dir; an unsafe one aborts start", async () => {
	const base = tmp();
	const good = path.join(base, "mcp.json");
	fs.writeFileSync(good, JSON.stringify({ mcpServers: { notes: { type: "http", url: "http://127.0.0.1:4821/notes", headers: { Authorization: "Bearer cap_abcdef123456" } } } }), { mode: 0o600 });
	const a = make();
	fs.mkdirSync(a.root, { recursive: true, mode: 0o700 });
	writePrivateFile(path.join(a.root, "config.json"), JSON.stringify({ mcpConfigPath: good }));
	await a.daemon.start();
	const projected = path.join(a.root, "agent", "mcp.json");
	assert.equal(fs.statSync(projected).mode & 0o777, 0o600);
	assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(projected, "utf8")).mcpServers), ["notes"]);
	assert.equal(a.daemon.status().mcpServers, 1);
	await a.daemon.stop();

	const evil = path.join(base, "evil.json");
	fs.writeFileSync(evil, JSON.stringify({ mcpServers: { x: { command: "sh", args: ["-c", "id"] } } }), { mode: 0o600 });
	const b = make();
	fs.mkdirSync(b.root, { recursive: true, mode: 0o700 });
	writePrivateFile(path.join(b.root, "config.json"), JSON.stringify({ mcpConfigPath: evil }));
	await assert.rejects(() => b.daemon.start(), /invalid config: mcpConfigPath/);
	assert.equal(fs.existsSync(path.join(b.root, "runtime", "session.json")), false);
	assert.equal(fs.existsSync(path.join(b.root, "agent", "mcp.json")) && fs.readFileSync(path.join(b.root, "agent", "mcp.json"), "utf8").includes("command"), false);
});

test("a config error at start aborts before any process is spawned", async () => {
	const { daemon, root, evidence } = make();
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	writePrivateFile(path.join(root, "config.json"), JSON.stringify({ bogus: 1 }));
	await assert.rejects(() => daemon.start(), /invalid config: bogus/);
	assert.equal(fs.existsSync(evidence.spawn), false);
});

function wrapperFor(base, name, spawnLog) {
	const wrapper = path.join(base, name);
	fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" --spawn-log "${spawnLog}" "$@"\n`, { mode: 0o755 });
	return wrapper;
}
function bareDaemon(root) {
	return new Daemon({
		root,
		env: { PATH: process.env.PATH },
		engineOptions: { backoffMs: [20], stopTimeoutMs: 500, requestTimeoutMs: 3000, startTimeoutMs: 5000 },
	});
}

test("session.json records the daemon's own procStart and process identity requires it", async () => {
	const { daemon, root } = make();
	await daemon.start();
	const session = readSession(root);
	assert.equal(typeof session.procStart, "string");
	assert.equal(session.procStart, procStartTicks(process.pid));
	assert.equal(isDaemonProcess(process.pid, "1"), false, "mismatching start time");
	assert.equal(isDaemonProcess(process.pid, undefined), false, "missing start time fails closed");
	assert.equal(procStartTicks(2 ** 22 + 12345), undefined);
	assert.equal(pidAlive(process.pid), true);
	await daemon.stop();
});

test("after a profile is selected, a crash restart does not re-apply the thinking default", async () => {
	const { daemon, root, evidence } = make();
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	writePrivateFile(path.join(root, "config.json"), JSON.stringify({ thinking: "high" }));
	await daemon.start();
	const count = () => (fs.readFileSync(evidence.cmd, "utf8").match(/set_thinking_level/g) ?? []).length;
	await waitFor(() => fs.existsSync(evidence.cmd) && count() === 1);
	const state = daemon.profiles.load();
	daemon.profiles.persist({
		profiles: [{ id: "p1", label: "P", role: "main", accountId: "main", provider: "x", modelId: "m", thinkingLevel: "low" }],
		active: "p1",
	});
	assert.equal(state.active, undefined);
	daemon.engine.send({ type: "crash" });
	await waitFor(() => daemon.engine.status === "restarting");
	await waitFor(() => daemon.engine.status === "ready");
	await daemon.engine.request({ type: "get_state" }); // ordered after any handler-issued request
	assert.equal(count(), 1, "selected profile thinking must win");
	await daemon.stop();
});

test("cleanupSync removes session.json only when the token matches (abnormal exit path)", async () => {
	const { daemon } = make();
	await daemon.start();
	const file = daemon.sessionFile;
	const original = fs.readFileSync(file, "utf8");
	const saved = daemon.token;
	daemon.token = "someone-else";
	daemon.cleanupSync();
	assert.equal(fs.existsSync(file), true, "foreign token must not be unlinked");
	daemon.token = saved;
	daemon.cleanupSync();
	assert.equal(fs.existsSync(file), false);
	assert.ok(original.includes(saved));
	daemon.cleanupSync(); // idempotent
	await daemon.stop();
});

test("an explicit engine cwd is the effective cwd: a workspace change does not restart", async () => {
	const base = tmp();
	const fixed = path.join(base, "fixed");
	fs.mkdirSync(fixed);
	const evidence = { cwd: path.join(base, "cwd.txt"), spawn: path.join(base, "spawn.log") };
	const daemon = new Daemon({
		root: path.join(base, "i"),
		env: { PATH: process.env.PATH },
		engineOptions: { command: process.execPath, commandArgs: [FAKE, "--cwd-out", evidence.cwd, "--spawn-log", evidence.spawn], cwd: fixed, backoffMs: [20], stopTimeoutMs: 500, startTimeoutMs: 5000 },
	});
	await daemon.start();
	const ws = path.join(base, "ws");
	fs.mkdirSync(ws);
	const result = await daemon.setWorkspace(ws);
	assert.equal(result.restarted, false);
	assert.equal(fs.readFileSync(evidence.cwd, "utf8"), fixed);
	assert.equal(fs.readFileSync(evidence.spawn, "utf8").trim().split("\n").length, 1);
	await daemon.stop();
});

test("SIGHUP/applyConfig restarts the engine when command changes", async () => {
	const base = tmp();
	const root = path.join(base, "i");
	const a = wrapperFor(base, "a.sh", path.join(base, "a.log"));
	const b = wrapperFor(base, "b.sh", path.join(base, "b.log"));
	fs.mkdirSync(root, { mode: 0o700 });
	writePrivateFile(path.join(root, "config.json"), JSON.stringify({ command: a }));
	const daemon = bareDaemon(root);
	await daemon.start();
	assert.equal((await daemon.applyConfig()).restarted, false);
	writePrivateFile(path.join(root, "config.json"), JSON.stringify({ command: b }));
	assert.equal((await daemon.applyConfig()).restarted, true);
	assert.equal(daemon.engine.status, "ready");
	assert.equal(fs.existsSync(path.join(base, "b.log")), true, "new command was spawned");
	assert.equal(fs.readFileSync(path.join(base, "a.log"), "utf8").trim().split("\n").length, 1);
	await daemon.stop();
});

test("SIGHUP/applyConfig re-projects MCP and restarts when mcpConfigPath changes; a bad source changes nothing", async () => {
	const base = tmp();
	const root = path.join(base, "i");
	const wrapper = wrapperFor(base, "w.sh", path.join(base, "w.log"));
	const src = (name, id) => {
		const file = path.join(base, name);
		fs.writeFileSync(file, JSON.stringify({ mcpServers: { [id]: { type: "http", url: "http://127.0.0.1:1/x", headers: { Authorization: "Bearer cap_abcdef123456" } } } }), { mode: 0o600 });
		return file;
	};
	const one = src("one.json", "one");
	const two = src("two.json", "two");
	fs.mkdirSync(root, { mode: 0o700 });
	writePrivateFile(path.join(root, "config.json"), JSON.stringify({ command: wrapper, mcpConfigPath: one }));
	const daemon = bareDaemon(root);
	await daemon.start();
	const projected = path.join(root, "agent", "mcp.json");
	writePrivateFile(path.join(root, "config.json"), JSON.stringify({ command: wrapper, mcpConfigPath: two }));
	assert.equal((await daemon.applyConfig()).restarted, true);
	assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(projected, "utf8")).mcpServers), ["two"]);
	assert.equal(fs.readFileSync(path.join(base, "w.log"), "utf8").trim().split("\n").length, 2);
	const evil = path.join(base, "evil.json");
	fs.writeFileSync(evil, JSON.stringify({ mcpServers: { x: { command: "sh" } } }), { mode: 0o600 });
	writePrivateFile(path.join(root, "config.json"), JSON.stringify({ command: wrapper, mcpConfigPath: evil }));
	await assert.rejects(() => daemon.applyConfig(), /invalid config: mcpConfigPath/);
	assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(projected, "utf8")).mcpServers), ["two"]);
	assert.equal(daemon.engine.status, "ready");
	await daemon.stop();
});

// ----- U5: MCP projection lifecycle ------------------------------------------------
function mcpSource(base, id = "notes") {
	const file = path.join(base, `src-${id}.json`);
	fs.writeFileSync(file, JSON.stringify({ mcpServers: { [id]: { type: "http", url: "http://127.0.0.1:4821/n", headers: { Authorization: "Bearer cap_abcdef123456" } } } }), { mode: 0o600 });
	return file;
}
function withMcp(extra = {}) {
	const m = make(extra);
	fs.mkdirSync(m.root, { recursive: true, mode: 0o700 });
	writePrivateFile(path.join(m.root, "config.json"), JSON.stringify({ mcpConfigPath: mcpSource(m.base) }));
	m.file = path.join(m.root, "agent", "mcp.json");
	return m;
}

test("MCP projection: written 0600 at boot, deleted by stop, regenerated by the next boot", async () => {
	const m = withMcp();
	await m.daemon.start();
	assert.equal(fs.statSync(m.file).mode & 0o777, 0o600);
	assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(m.file, "utf8")).mcpServers), ["notes"]);
	await m.daemon.stop();
	assert.equal(fs.existsSync(m.file), false);
	await m.daemon.start();
	assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(m.file, "utf8")).mcpServers), ["notes"]);
	await m.daemon.stop();
	assert.equal(fs.existsSync(m.file), false);
});

test("MCP projection: cleanupSync deletes it synchronously (process exit path)", async () => {
	const m = withMcp();
	await m.daemon.start();
	m.daemon.cleanupSync();
	assert.equal(fs.existsSync(m.file), false);
	assert.equal(fs.existsSync(path.join(m.root, "runtime", "session.json")), false);
	await m.daemon.stop();
});

test("MCP projection: a boot that fails after writing it cleans it up", async () => {
	const m = withMcp({ options: { engineOptions: { command: path.join(tmp(), "nope"), commandArgs: [], backoffMs: [20], stopTimeoutMs: 200, startTimeoutMs: 300 } } });
	await assert.rejects(() => m.daemon.start());
	assert.equal(fs.existsSync(m.file), false);
	assert.equal(fs.existsSync(path.join(m.root, "runtime", "session.json")), false);
});

test("MCP projection: a planted symlink is never followed or deleted through", async () => {
	const m = withMcp();
	await m.daemon.start();
	fs.unlinkSync(m.file);
	const victim = path.join(m.base, "victim.txt");
	fs.writeFileSync(victim, "precious");
	fs.symlinkSync(victim, m.file);
	m.daemon.cleanupSync();
	assert.equal(fs.readFileSync(victim, "utf8"), "precious");
	await m.daemon.stop();
	assert.equal(fs.readFileSync(victim, "utf8"), "precious");
	assert.equal(fs.lstatSync(m.file).isSymbolicLink(), true);
});

test("MCP projection: an invalid source at start leaves no mcp.json", async () => {
	const m = withMcp();
	const evil = path.join(m.base, "evil.json");
	fs.writeFileSync(evil, JSON.stringify({ mcpServers: { x: { command: "sh" } } }), { mode: 0o600 });
	writePrivateFile(path.join(m.root, "config.json"), JSON.stringify({ mcpConfigPath: evil }));
	await assert.rejects(() => m.daemon.start(), /invalid config: mcpConfigPath/);
	assert.equal(fs.existsSync(m.file), false);
});

// ----- hotkey (V2) ---------------------------------------------------------------

async function rpc(session, frame, pred) {
	const c = await connect(session);
	await waitFor(() => c.frames.some((f) => f.type === "ready"));
	c.socket.write(`${JSON.stringify(frame)}\n`);
	await waitFor(() => c.frames.some(pred));
	const found = c.frames.find(pred);
	c.socket.destroy();
	return found;
}

test("hotkey: status, getHotkey/setHotkey, and the settings frames are wired through the server", async () => {
	const { daemon, root } = make();
	await daemon.start();
	assert.equal(daemon.status().hotkey, null);
	assert.equal(daemon.getHotkey(), null);
	const session = readSession(root);
	const a = await connect(session);
	await waitFor(() => a.frames.some((f) => f.type === "ready"));
	a.socket.write(`${JSON.stringify({ type: "settings_set", hotkey: "ctrl+alt+space" })}\n`);
	await waitFor(() => a.frames.some((f) => f.type === "settings"));
	assert.equal(a.frames.find((f) => f.type === "settings").hotkey, "Ctrl+Alt+Space");
	assert.equal(daemon.getHotkey(), "Ctrl+Alt+Space");
	assert.equal(daemon.status().hotkey, "Ctrl+Alt+Space");
	assert.equal(JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8")).hotkey, "Ctrl+Alt+Space");
	assert.equal(fs.statSync(path.join(root, "config.json")).mode & 0o777, 0o600);
	assert.equal((await rpc(session, { type: "settings_get" }, (f) => f.type === "settings")).hotkey, "Ctrl+Alt+Space");
	a.socket.write(`${JSON.stringify({ type: "settings_set", hotkey: "Space" })}\n`);
	await waitFor(() => a.frames.some((f) => f.type === "error"));
	assert.equal(a.frames.find((f) => f.type === "error").code, "bad_request");
	assert.equal(daemon.getHotkey(), "Ctrl+Alt+Space", "invalid value changed nothing");
	assert.deepEqual(daemon.setHotkey(null), { hotkey: null, changed: true });
	assert.equal(daemon.status().hotkey, null);
	assert.equal(daemon.engine.status, "ready", "no engine restart");
	a.socket.destroy();
	await daemon.stop();
});

test("hotkey: applyConfig picks up a file edit, emits 'settings' and broadcasts; unchanged does not", async () => {
	const { daemon, root } = make();
	await daemon.start();
	const events = [];
	daemon.on("settings", (s) => events.push(s));
	const a = await connect(readSession(root));
	await waitFor(() => a.frames.some((f) => f.type === "ready"));
	assert.equal((await daemon.applyConfig()).restarted, false);
	assert.deepEqual(events, []);
	writePrivateFile(path.join(root, "config.json"), JSON.stringify({ hotkey: "super+h" }));
	assert.equal((await daemon.applyConfig()).restarted, false, "hotkey never restarts the engine");
	assert.deepEqual(events, [{ hotkey: "Super+H" }]);
	assert.equal(daemon.getHotkey(), "Super+H");
	await waitFor(() => a.frames.some((f) => f.type === "settings" && f.hotkey === "Super+H"));
	await daemon.applyConfig();
	assert.equal(events.length, 1);
	writePrivateFile(path.join(root, "config.json"), JSON.stringify({ hotkey: "Space" }));
	assert.equal((await daemon.applyConfig()).restarted, false, "invalid hotkey degrades, no throw");
	assert.equal(daemon.getHotkey(), null);
	assert.equal(daemon.status().hotkeyInvalid, true);
	a.socket.destroy();
	await daemon.stop();
});

test("hotkey: an invalid hotkey in config.json does not abort start", async () => {
	const { daemon, root, evidence } = make();
	fs.mkdirSync(root, { mode: 0o700 });
	writePrivateFile(path.join(root, "config.json"), JSON.stringify({ hotkey: "Ctrl+F25" }));
	await daemon.start();
	assert.equal(fs.existsSync(evidence.spawn), true);
	await daemon.stop();
});

test("invalid hotkey in config.json: daemon starts, status flags it, settings frame is null, value never logged", async () => {
	const { daemon, root, logs } = make();
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	require("../src/isolation.cjs").ensureIsland(root);
	fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ hotkey: "Ctrl+SECRETVALUE" }), { mode: 0o600 });
	await daemon.start();
	assert.equal(daemon.status().hotkeyInvalid, true);
	assert.equal(daemon.status().hotkey, null);
	const session = readSession(root);
	assert.equal((await rpc(session, { type: "settings_get" }, (f) => f.type === "settings")).hotkey, null);
	assert.ok(!JSON.stringify(daemon.status()).includes("SECRETVALUE"));
	assert.ok(!logs.join("\n").includes("SECRETVALUE"));
	daemon.setHotkey("Ctrl+K");
	assert.equal(daemon.status().hotkeyInvalid, false);
	await daemon.stop();
});

// ----- connectors wiring (V4) ----------------------------------------------------------

const FIXTURES_DIR = path.join(__dirname, "fixtures", "connectors");
function connectorsShim(base, vars = {}) {
	const file = path.join(base, "fake-abito-connectors");
	const all = { FAKE_FIXTURES: FIXTURES_DIR, FAKE_SPAWN_LOG: path.join(base, "cspawn.log"), FAKE_ARGV_OUT: path.join(base, "cargv.log"), FAKE_ENV_OUT: path.join(base, "cenv.json"), ...vars };
	const assignments = Object.entries(all).map(([k, v]) => `${k}='${v}'`).join(" ");
	fs.writeFileSync(file, `#!/bin/sh\nexport ${assignments}\nexec '${process.execPath}' '${path.join(__dirname, "fixtures", "fake-connectors.cjs")}' "$@"\n`, { mode: 0o755 });
	fs.chmodSync(file, 0o755);
	return file;
}
async function configure(root, value) {
	const { ensureIsland } = require("../src/isolation.cjs");
	ensureIsland(root);
	writePrivateFile(path.join(root, "config.json"), JSON.stringify(value));
}

test("connectors_list through the daemon: fake CLI, private 0700 dir created at first use, status flag", async () => {
	const { daemon, root, base } = make();
	const command = connectorsShim(base);
	const dir = path.join(base, "cdata");
	await configure(root, { connectorsCommand: command, connectorsDir: dir });
	await daemon.start();
	try {
		assert.equal(daemon.status().connectorsAvailable, true);
		assert.equal(fs.existsSync(dir), false, "not created at boot");
		const { socket, frames } = await connect(readSession(root));
		await waitFor(() => frames.some((f) => f.type === "ready"));
		socket.write(`${JSON.stringify({ type: "connectors_list" })}\n`);
		await waitFor(() => frames.some((f) => f.type === "connectors" || f.type === "error"));
		const frame = frames.find((f) => f.type === "connectors");
		assert.ok(frame, JSON.stringify(frames));
		assert.equal(frame.schema, "abito-connectors/view/1");
		assert.equal(frame.catalog.length, 6);
		assert.equal(frame.connectors.length, 4);
		assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
		const argv = fs.readFileSync(path.join(base, "cargv.log"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
		assert.ok(argv.some((a) => a.argv[0] === "status" && a.argv[2] === dir));
		assert.ok(argv.every((a) => fs.realpathSync(a.cwd) === fs.realpathSync(root)));
		const env = JSON.parse(fs.readFileSync(path.join(base, "cenv.json"), "utf8"));
		assert.equal(env.HOME, path.join(root, "home"));
		assert.ok(!Object.keys(env).some((k) => /^PI_/.test(k)));
		socket.destroy();
	} finally {
		await daemon.stop();
	}
});

test("connectors_list through the daemon: a failing CLI or a symlinked dir -> generic failed", async () => {
	const { daemon, root, base } = make();
	const real = path.join(base, "real");
	fs.mkdirSync(real);
	const link = path.join(base, "link");
	fs.symlinkSync(real, link);
	await configure(root, { connectorsCommand: connectorsShim(base), connectorsDir: link });
	await daemon.start();
	try {
		const { socket, frames } = await connect(readSession(root));
		await waitFor(() => frames.some((f) => f.type === "ready"));
		socket.write(`${JSON.stringify({ type: "connectors_list" })}\n`);
		await waitFor(() => frames.some((f) => f.type === "error"));
		assert.equal(frames.find((f) => f.type === "error").code, "failed");
		assert.ok(!fs.existsSync(path.join(base, "cspawn.log")), "CLI never ran against an unsafe directory");
		assert.ok(!JSON.stringify(frames).includes(base));
		socket.destroy();
	} finally {
		await daemon.stop();
	}
});

test("daemon refuses to start on an invalid connectorsCommand (no shell metacharacters)", async () => {
	const { daemon, root } = make();
	await configure(root, { connectorsCommand: "abito-connectors; rm x" });
	await assert.rejects(() => daemon.start(), /invalid config: connectorsCommand/);
});

test("R1/R5: no connectorsCommand -> no execution, unavailable, connectorsAvailable=false", async () => {
	const { daemon, root } = make();
	await daemon.start();
	try {
		assert.equal(daemon.status().connectorsAvailable, false);
		const { socket, frames } = await connect(readSession(root));
		await waitFor(() => frames.some((f) => f.type === "ready"));
		socket.write(`${JSON.stringify({ type: "connectors_list" })}\n`);
		await waitFor(() => frames.some((f) => f.type === "error"));
		assert.equal(frames.find((f) => f.type === "error").code, "unavailable");
		socket.destroy();
	} finally {
		await daemon.stop();
	}
});

test("R1: a bare-name connectorsCommand is rejected at start", async () => {
	const { daemon, root } = make();
	await configure(root, { connectorsCommand: "abito-connectors" });
	await assert.rejects(() => daemon.start(), /invalid config: connectorsCommand/);
});

// ----- agents wiring (H2b) ---------------------------------------------------------------

function agentsInstaller(base) {
	const scenario = path.join(base, "agents-scenario.json");
	const hash = "d".repeat(64);
	const home = path.join(base, "home");
	fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
	fs.writeFileSync(scenario, JSON.stringify({
		preview: { exit: 0, stdout: { schema: "abito-hook-install/1", ok: true, mode: "preview", harness: "claude", action: "install", target: path.join(home, ".claude", "settings.json"), exists: true, changed: true, entries: ["PermissionRequest", "PreToolUse", "SessionStart", "Stop"].map((event) => ({ event, op: "add" })), backup_path: null, diff: { lines: ["@@"], hidden: 0, outside_hooks_changed_lines: 0 }, requires_trust_review: false, plan_hash: hash, notes: [] } },
	}));
	const file = path.join(base, "fake-hook-installer.cjs");
	fs.writeFileSync(file, `require(${JSON.stringify(path.join(__dirname, "fixtures", "fake-installer.cjs"))})(${JSON.stringify(scenario)});\n`, { mode: 0o644 });
	fs.chmodSync(file, 0o644);
	return { file, home, hash };
}

test("agents through the daemon: hookInstallerBin wires AgentsManager, agentsAvailable flag, frames over the socket", async () => {
	const { daemon, root, base } = make({ options: { agentsOptions: {} } });
	const inst = agentsInstaller(base);
	daemon.options.agentsOptions = { home: inst.home };
	await configure(root, { hookInstallerBin: inst.file });
	await daemon.start();
	try {
		assert.equal(daemon.status().agentsAvailable, true);
		const { socket, frames } = await connect(readSession(root));
		await waitFor(() => frames.some((f) => f.type === "ready"));
		socket.write(`${JSON.stringify({ type: "agents_list" })}\n`);
		await waitFor(() => frames.some((f) => f.type === "agents"));
		const claude = frames.find((f) => f.type === "agents").agents.find((a) => a.id === "claude-code");
		assert.equal(claude.state, "not_connected");
		assert.equal(claude.plan_hash, inst.hash);
		assert.ok(!JSON.stringify(frames).includes(base));
		socket.destroy();
	} finally {
		await daemon.stop();
	}
});

test("agents: no hookInstallerBin -> agentsAvailable false, every agent unavailable (no execution)", async () => {
	const { daemon, root } = make();
	await daemon.start();
	try {
		assert.equal(daemon.status().agentsAvailable, false);
		const { socket, frames } = await connect(readSession(root));
		await waitFor(() => frames.some((f) => f.type === "ready"));
		socket.write(`${JSON.stringify({ type: "agents_list" })}\n`);
		await waitFor(() => frames.some((f) => f.type === "agents" || f.type === "error"));
		const frame = frames.find((f) => f.type === "agents");
		assert.ok(frame, JSON.stringify(frames));
		assert.ok(frame.agents.every((a) => a.state === "unavailable" && a.detail === null));
		socket.destroy();
	} finally {
		await daemon.stop();
	}
});

test("daemon refuses to start on an invalid hookInstallerBin", async () => {
	const { daemon, root } = make();
	await configure(root, { hookInstallerBin: "abito-hook.cjs" });
	await assert.rejects(() => daemon.start(), /invalid config: hookInstallerBin/);
});

// ---- #390 GD014: classifySession — healthy | orphaned | foreign | stale, with a reason ----

test("GD014: classifySession distinguishes stale, foreign, orphaned and healthy with explicit reasons", async () => {
	// stale: no session at all — and classify is read-only (it never creates the root)
	const missing = path.join(tmp(), "missing-island");
	const v0 = await classifySession(missing);
	assert.equal(v0.state, "stale");
	assert.equal(v0.reason, "no_session");
	assert.equal(fs.existsSync(missing), false, "classifySession must never create directories");

	// stale: the recorded pid is confirmed dead (spawnSync reaps it)
	const deadRoot = path.join(tmp(), "i");
	fs.mkdirSync(path.join(deadRoot, "runtime"), { recursive: true, mode: 0o700 });
	const dead = spawnSync(process.execPath, ["-e", ""]).pid;
	writePrivateFile(path.join(deadRoot, "runtime", "session.json"), JSON.stringify({ protocol: "island-agent/1", endpoint: "/x", token: "t".repeat(40), pid: dead, startedAt: 1 }));
	const v1 = await classifySession(deadRoot);
	assert.equal(v1.state, "stale");
	assert.equal(v1.reason, "pid_dead");
	assert.equal(v1.ready, false);

	const writeSession = (root, session) => {
		fs.mkdirSync(path.join(root, "runtime"), { recursive: true, mode: 0o700 });
		writePrivateFile(path.join(root, "runtime", "session.json"), JSON.stringify({ protocol: "island-agent/1", token: "t".repeat(40), startedAt: 1, ...session }));
	};
	const bystander = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
	const dir = path.join(tmp(), "x");
	fs.mkdirSync(dir);
	const script = path.join(dir, "cli.cjs");
	fs.writeFileSync(script, "setInterval(()=>{},1000)", { mode: 0o600 });
	const lookalike = spawn(process.execPath, [script], { stdio: "ignore" });
	try {
		// foreign: a live pid that is not this daemon's command at all
		const foreignRoot = path.join(tmp(), "i-foreign");
		writeSession(foreignRoot, { endpoint: "/x", pid: bystander.pid });
		const v2 = await classifySession(foreignRoot);
		assert.equal(v2.state, "foreign");
		assert.equal(v2.reason, "other_process");
		assert.equal(v2.ready, false);

		// foreign: the cmdline looks like this daemon but the start time does not match the session
		const unverifiedRoot = path.join(tmp(), "i-unverified");
		writeSession(unverifiedRoot, { endpoint: "/x", pid: lookalike.pid, procStart: "1" });
		const v3 = await classifySession(unverifiedRoot);
		assert.equal(v3.state, "foreign");
		assert.equal(v3.reason, "identity_unconfirmed");
		assert.equal(v3.ready, false);

		// stale: a confirmed daemon process (cmdline + start time match) whose endpoint refuses
		const unreadyRoot = path.join(tmp(), "i-unready");
		writeSession(unreadyRoot, { endpoint: "/x", pid: lookalike.pid, procStart: procStartTicks(lookalike.pid) });
		const v4 = await classifySession(unreadyRoot);
		assert.equal(v4.state, "stale");
		assert.equal(v4.reason, "endpoint_refused");
		assert.equal(v4.ready, false);
	} finally {
		await reap(bystander);
		await reap(lookalike);
	}

	// healthy (and the orphaned variant through the ppid seam: no live test can give ppid 1)
	const { daemon, root } = make();
	await daemon.start();
	try {
		const v5 = await classifySession(root);
		assert.equal(v5.state, "healthy");
		assert.equal(v5.reason, "ready");
		assert.equal(v5.ready, true);
		const v6 = await classifySession(root, { ppid: () => 1 });
		assert.equal(v6.state, "orphaned");
		assert.equal(v6.reason, "parent_gone");
		assert.equal(v6.ready, true, "an orphaned daemon can still be serving");
	} finally {
		await daemon.stop();
	}
});

// ---- #390 GD029: never overwrite a session whose endpoint answers ready ----

test("GD029 check (1): a healthy session is never overwritten; the refusal is recorded", async () => {
	const a = make();
	await a.daemon.start();
	try {
		const file = path.join(a.root, "runtime", "session.json");
		const before = fs.statSync(file);
		const incumbent = JSON.parse(fs.readFileSync(file, "utf8"));
		const b = new Daemon({
			root: a.root,
			env: { PATH: process.env.PATH },
			log: () => {},
			engineOptions: { command: process.execPath, commandArgs: [FAKE, "--cwd-out", path.join(a.base, "b.cwd"), "--cmd-log", path.join(a.base, "b.cmd"), "--spawn-log", path.join(a.base, "b.spawn")], backoffMs: [20], stopTimeoutMs: 500, requestTimeoutMs: 3000, startTimeoutMs: 5000 },
		});
		await assert.rejects(() => b.start(), /daemon already running/);
		const after = fs.statSync(file);
		assert.equal(after.ino, before.ino, "the session file must not be rewritten");
		assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).token, incumbent.token, "the healthy incumbent keeps its token");
		const lines = ledgerLines(a.root);
		assert.equal(lines[0].outcome, "started", "the first launch records itself");
		const last = lines.at(-1);
		assert.equal(last.outcome, "refused");
		assert.equal(last.reason, "endpoint_ready");
		assert.equal(last.incumbentPid, incumbent.pid);
		assert.equal(typeof last.at, "number");
		assert.equal(typeof last.pid, "number");
		assert.equal(typeof last.procStart, "string");
		const ledger = path.join(a.root, "runtime", "launches.jsonl");
		assert.equal(fs.statSync(ledger).mode & 0o777, 0o600);
		assert.ok(!fs.readFileSync(ledger, "utf8").includes(incumbent.token), "the ledger never carries a token");
	} finally {
		await a.daemon.stop();
	}
});

/** The OD066 interrupted-work record, a single JSON object in <root>/runtime. */
function interruptedRecord(root) {
	const file = path.join(root, "runtime", "interrupted.json");
	if (!fs.existsSync(file)) return undefined;
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

test("#385 OD066: stop with a busy turn and an open ask records the interrupted work; the next boot keeps it unconsumed (R5)", async () => {
	const a = make();
	await a.daemon.start();
	try {
		const session = readSession(a.root);
		const { socket, frames } = await connect(session);
		await waitFor(() => frames.some((f) => f.type === "ready"));
		a.daemon.engine.emit("event", { type: "agent_start" });
		a.daemon.engine.emit("event", { type: "extension_ui_request", id: "u1", method: "select", title: "Pick", options: ["a", "b"] });
		await waitFor(() => a.daemon.server.busy === true && a.daemon.server.asks.size === 1);
		socket.destroy();
		await a.daemon.stop();
		const file = path.join(a.root, "runtime", "interrupted.json");
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		const record = interruptedRecord(a.root);
		assert.deepEqual(Object.keys(record).sort(), ["asks", "at", "consumed", "pid", "procStart", "turnActive"]);
		assert.equal(typeof record.at, "number");
		assert.equal(record.pid, process.pid);
		assert.equal(typeof record.procStart, "string");
		assert.equal(record.turnActive, true);
		assert.deepEqual(record.asks, [{ id: "u1", kind: "select", title: "Pick" }]);
		assert.equal(record.consumed, false);
		assert.equal(record.token, undefined, "the record never carries a token");
		// session.json is gone; the #390 launch ledger is untouched by the record.
		assert.equal(fs.existsSync(path.join(a.root, "runtime", "session.json")), false);
		assert.deepEqual(ledgerLines(a.root).map((l) => l.reason), ["ok"]);
	} finally {
		await a.daemon.stop();
	}
	// The next boot that starts well keeps the record as evidence, unconsumed
	// (R5: consumption happens only after a client's interrupted_ack).
	const b = make({ options: { root: a.root } });
	await b.daemon.start();
	try {
		const record = interruptedRecord(a.root);
		assert.equal(record.consumed, false);
		assert.equal(record.turnActive, true);
		assert.deepEqual(record.asks, [{ id: "u1", kind: "select", title: "Pick" }]);
	} finally {
		await b.daemon.stop();
	}
	// The unconsumed record survives the next clean stop; exactly ONE record is kept.
	assert.equal(interruptedRecord(a.root).consumed, false);
	assert.deepEqual(ledgerLines(a.root).map((l) => l.reason), ["ok", "ok"]);
});

test("#385 OD066: a newer interruption replaces the single record; a clean stop writes none", async () => {
	const a = make();
	await a.daemon.start();
	try {
		const session = readSession(a.root);
		const { socket, frames } = await connect(session);
		await waitFor(() => frames.some((f) => f.type === "ready"));
		// Turn-only interruption: asks stay empty.
		a.daemon.engine.emit("event", { type: "agent_start" });
		await waitFor(() => a.daemon.server.busy === true);
		socket.destroy();
		await a.daemon.stop();
		assert.deepEqual(interruptedRecord(a.root).asks, []);
		assert.equal(interruptedRecord(a.root).turnActive, true);
	} finally {
		await a.daemon.stop();
	}
	// Ask-only interruption, newer than the previous record: it wins as the single record.
	const c = make({ options: { root: a.root } });
	await c.daemon.start();
	try {
		const session = readSession(a.root);
		const { socket, frames } = await connect(session);
		await waitFor(() => frames.some((f) => f.type === "ready"));
		c.daemon.engine.emit("event", { type: "extension_ui_request", id: "u2", method: "confirm", title: "Sure?" });
		await waitFor(() => c.daemon.server.asks.size === 1);
		socket.destroy();
		await c.daemon.stop();
		const record = interruptedRecord(a.root);
		assert.equal(record.consumed, false, "the newer record is fresh evidence, not consumed");
		assert.equal(record.turnActive, false);
		assert.deepEqual(record.asks, [{ id: "u2", kind: "confirm", title: "Sure?" }]);
	} finally {
		await c.daemon.stop();
	}
	// A clean stop records nothing and keeps the single existing record.
	const d = make({ options: { root: a.root } });
	await d.daemon.start();
	try {
		assert.equal(interruptedRecord(a.root).consumed, false, "boot never consumes the record (R5)");
		await d.daemon.stop();
		assert.equal(interruptedRecord(a.root).turnActive, false);
		assert.deepEqual(interruptedRecord(a.root).asks, [{ id: "u2", kind: "confirm", title: "Sure?" }]);
	} finally {
		await d.daemon.stop();
	}
});

test("#385 OD066: a failed record write never blocks teardown nor boot", async () => {
	const a = make();
	await a.daemon.start();
	// A directory at the record path makes the private write fail (O_NOFOLLOW/EISDIR).
	fs.mkdirSync(path.join(a.root, "runtime", "interrupted.json"), { recursive: true });
	try {
		a.daemon.server.busy = true;
		await a.daemon.stop();
		assert.equal(fs.existsSync(path.join(a.root, "runtime", "session.json")), false);
		assert.equal(fs.existsSync(path.join(a.root, "runtime", "launches.jsonl")), true);
	} finally {
		await a.daemon.stop();
	}
	const b = make({ options: { root: a.root } });
	await b.daemon.start();
	assert.equal(b.daemon.state, "running");
	await b.daemon.stop();
});

test("GD029 check (2): a dead-pid stale session is replaced and the replacement is recorded", async () => {
	const { daemon, root } = make();
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	const dead = spawnSync(process.execPath, ["-e", ""]).pid;
	writePrivateFile(path.join(root, "runtime", "session.json"), JSON.stringify({ protocol: "island-agent/1", endpoint: "/x", token: "t".repeat(40), pid: dead, startedAt: 1 }));
	await daemon.start();
	try {
		assert.equal(readSession(root).pid, process.pid, "the stale session was replaced");
		const last = ledgerLines(root).at(-1);
		assert.equal(last.outcome, "started");
		assert.equal(last.reason, "stale_replaced");
		assert.equal(last.incumbentPid, dead);
		assert.equal(last.pid, process.pid);
	} finally {
		await daemon.stop();
	}
});

// ----- mcp import preview wiring (#381) ------------------------------------------

test("mcp_import_preview through the daemon: reads the real HOME configs read-only, status flag", async () => {
	// Without HOME in the daemon env the verb is unavailable and the status flag is false.
	const plain = make();
	await plain.daemon.start();
	try {
		assert.equal(plain.daemon.status().mcpImportAvailable, false);
	} finally {
		await plain.daemon.stop();
	}

	const { daemon, root, base } = make();
	const home = path.join(base, "realhome");
	// boot() reads this.env: HOME must be set before start()
	daemon.env = { PATH: process.env.PATH, HOME: home };
	fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
	fs.writeFileSync(path.join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { fs: { command: "npx" } } }));
	fs.writeFileSync(path.join(home, ".claude.json"), "{broken");
	await daemon.start();
	try {
		assert.equal(daemon.status().mcpImportAvailable, true);
		const { socket, frames } = await connect(readSession(root));
		await waitFor(() => frames.some((f) => f.type === "ready"));
		socket.write(`${JSON.stringify({ type: "mcp_import_preview" })}\n`);
		await waitFor(() => frames.some((f) => f.type === "mcp_import" || f.type === "error"));
		const frame = frames.find((f) => f.type === "mcp_import");
		assert.ok(frame, JSON.stringify(frames));
		assert.equal(frame.schema, "abito-mcp-import/preview/1");
		assert.deepEqual(frame.files, [{ source: "claude-code", status: "malformed" }, { source: "cursor", status: "ok" }]);
		assert.deepEqual(frame.servers, [{ source: "cursor", name: "fs", transport: "stdio", command: "npx", status: "ready" }]);
		// read-only: the scanned files are untouched and nothing new appeared in HOME
		assert.equal(fs.readFileSync(path.join(home, ".cursor", "mcp.json"), "utf8"), JSON.stringify({ mcpServers: { fs: { command: "npx" } } }));
		assert.deepEqual(fs.readdirSync(home).sort(), [".claude.json", ".cursor"]);
		socket.destroy();
	} finally {
		await daemon.stop();
	}
});

test("pause: set_paused persists to config.json, refuses admission, and is restored across a restart", async () => {
	const { daemon, root } = make();
	await daemon.start();
	try {
		const session = readSession(root);
		const a = await connect(session);
		await waitFor(() => a.frames.some((f) => f.type === "ready"));
		assert.equal(a.frames.find((f) => f.type === "ready").state.paused, false);
		a.socket.write(`${JSON.stringify({ type: "set_paused", paused: true })}\n`);
		await waitFor(() => a.frames.some((f) => f.type === "agent_state" && f.paused === true));
		assert.equal(JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8")).paused, true);
		assert.equal(fs.statSync(path.join(root, "config.json")).mode & 0o777, 0o600);
		assert.equal(daemon.status().paused, true);
		a.socket.write(`${JSON.stringify({ type: "send", text: "hi" })}\n`);
		await waitFor(() => a.frames.some((f) => f.type === "error"));
		assert.equal(a.frames.find((f) => f.type === "error").code, "paused");
		a.socket.destroy();
		await daemon.stop();
		// Restart restores the persisted pause through the public interface.
		await daemon.start();
		const b = await connect(readSession(root));
		await waitFor(() => b.frames.some((f) => f.type === "ready"));
		assert.equal(b.frames.find((f) => f.type === "ready").state.paused, true);
		assert.equal(daemon.status().paused, true);
		b.socket.write(`${JSON.stringify({ type: "set_paused", paused: false })}\n`);
		await waitFor(() => b.frames.some((f) => f.type === "agent_state" && f.paused === false));
		assert.equal(daemon.status().paused, false);
		assert.equal(JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8")).paused, undefined);
		b.socket.destroy();
	} finally {
		await daemon.stop();
	}
});
test("connector host is optional, starts after the engine, and is stopped before daemon cleanup", async () => {
	const absent = make();
	await absent.daemon.start();
	assert.equal(absent.daemon.connectorHost, undefined);
	assert.equal(absent.daemon.status().connectorHost, "unavailable");
	assert.equal(absent.daemon.status().connectorHostAvailable, false);
	await absent.daemon.stop();

	const configured = make();
	const fixture = path.join(__dirname, "fixtures", "fake-connector-host.cjs");
	const binary = path.join(configured.base, "abito-connector-host");
	fs.copyFileSync(fixture, binary);
	fs.chmodSync(binary, 0o700);
	await configure(configured.root, { connectorHostBin: binary });
	await configured.daemon.start();
	try {
		assert.equal(configured.daemon.engine.status, "ready");
		assert.equal(configured.daemon.status().connectorHost, "ready");
		assert.equal(configured.daemon.status().connectorHostAvailable, true);
		assert.equal(configured.daemon.status().mcpServers, 0, "the host source is not auto-projected");
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(configured.root, "agent", "mcp.json"), "utf8")), { mcpServers: {} });
		assert.deepEqual(configured.daemon.connectorHost.child.spawnargs.slice(1), ["--island", configured.root, "--parent", String(process.pid)]);
	} finally {
		await configured.daemon.stop();
	}
	assert.equal(fs.existsSync(path.join(configured.root, "connector-host.json")), false);
});

test("a configured but untrusted connector host does not prevent daemon startup", async () => {
	const { daemon, root, base, logs } = make();
	await configure(root, { connectorHostBin: path.join(base, "missing-host") });
	await daemon.start();
	try {
		assert.equal(daemon.engine.status, "ready");
		assert.equal(daemon.status().connectorHost, "unavailable");
		assert.equal(daemon.status().connectorHostAvailable, false);
		assert.ok(logs.includes("connector host unavailable"));
	} finally { await daemon.stop(); }
});

test("H2c controls reach the fake host through a real daemon and teardown clears setup state", async (t) => {
	const { ConnectorsView } = require("../src/connectors.cjs");
	const configured = make({ options: { connectorHostOptions: { backoffMs: [20], stableMs: 100, startTimeoutMs: 5000, requestTimeoutMs: 3000, stopTimeoutMs: 3000 } } });
	t.after(async () => { await configured.daemon.stop(); fs.rmSync(configured.base, { recursive: true, force: true }); });
	const command = connectorsShim(configured.base);
	const connectorsDir = path.join(configured.base, "connector-data");
	fs.mkdirSync(connectorsDir, { mode: 0o700 });
	const catalogView = new ConnectorsView({ command, dir: connectorsDir, cwd: configured.base, home: configured.base });
	const catalog = (await catalogView.snapshot()).catalog;
	const selected = catalog.find((item) => item.fields.length > 0 && item.auth !== "provider_oauth");
	assert.ok(selected, "the fixture catalog includes an interactive setup entry");
	const transcriptFile = path.join(configured.base, "host-transcript.jsonl");
	const proposals = ["1", "2", "3"].map((n) => ({
		proposal_id: `ap-${n.repeat(28)}`, connector_id: selected.key, tool: "search", arguments_preview: "{}",
		arguments_truncated: false, arguments_sensitive: true, digest: n.repeat(64), expires_in_ms: 25000,
	}));
	const connectorItems = [{ id: selected.key, label: selected.label, catalog_key: selected.key, mode: "read_only", enabled: true, status: { state: "needs_setup" }, revision: 0, configured: false }];
	await configure(configured.root, { connectorHostBin: path.join(configured.base, "abito-connector-host"), connectorsCommand: command, connectorsDir });
	const hostBinary = path.join(configured.base, "abito-connector-host");
	fs.copyFileSync(path.join(__dirname, "fixtures", "fake-connector-host.cjs"), hostBinary);
	fs.chmodSync(hostBinary, 0o700);
	writePrivateFile(path.join(configured.root, ".fake-host-mode.json"), JSON.stringify({ pendingItems: proposals, connectorItems, connectorLabel: selected.label, connectorCatalogKey: selected.key, transcriptFile }));
	await configured.daemon.start();
	const a = await connect(readSession(configured.root));
	const b = await connect(readSession(configured.root));
	try {
		await waitFor(() => a.frames.some((frame) => frame.type === "ready") && b.frames.some((frame) => frame.type === "ready"));
		let from = a.frames.length;
		a.socket.write(`${JSON.stringify({ type: "connectors_pending" })}\n`);
		await waitFor(() => a.frames.slice(from).some((frame) => frame.type === "pending" && frame.items.length === 3));
		assert.equal(a.frames.slice(from).find((frame) => frame.type === "pending" && frame.items.length === 3).items[0].connector_label, selected.label);
		from = b.frames.length;
		a.socket.write(`${JSON.stringify({ type: "connectors_approve", proposal_id: proposals[0].proposal_id, digest: proposals[0].digest.toUpperCase() })}\n`);
		await waitFor(() => b.frames.slice(from).some((frame) => frame.type === "pending" && frame.items.length === 2) && b.frames.slice(from).some((frame) => frame.type === "connectors" && frame.live === true));
		from = a.frames.length;
		a.socket.write(`${JSON.stringify({ type: "connectors_deny", proposal_id: proposals[1].proposal_id })}\n`);
		await waitFor(() => a.frames.slice(from).some((frame) => frame.type === "pending" && frame.items.length === 1));
		from = b.frames.length;
		a.socket.write(`${JSON.stringify({ type: "connectors_mode", connector_id: selected.key, mode: "read_and_send" })}\n`);
		await waitFor(() => b.frames.slice(from).some((frame) => frame.type === "connectors" && frame.live === true));
		from = a.frames.length;
		a.socket.write(`${JSON.stringify({ type: "connectors_connect", connector_id: selected.key })}\n`);
		await waitFor(() => a.frames.slice(from).some((frame) => frame.type === "auth_started"));
		const started = a.frames.slice(from).find((frame) => frame.type === "auth_started");
		const canary = "DAEMON-CONNECT-SECRET-CANARY";
		let promptCount = 0;
		for (let index = 0; index < selected.fields.length; index++) {
			await waitFor(() => a.frames.filter((frame) => frame.type === "auth_prompt" && frame.flowId === started.flowId).length > promptCount);
			const prompt = a.frames.filter((frame) => frame.type === "auth_prompt" && frame.flowId === started.flowId).at(-1);
			promptCount++;
			a.socket.write(`${JSON.stringify({ type: "auth_reply", flowId: started.flowId, promptId: prompt.promptId, value: canary })}\n`);
		}
		await waitFor(() => a.frames.some((frame) => frame.type === "auth_done" && frame.flowId === started.flowId));
		let transcript = fs.readFileSync(transcriptFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.ok(transcript.some((frame) => frame.type === "approve"));
		assert.ok(transcript.some((frame) => frame.type === "deny"));
		assert.ok(transcript.some((frame) => frame.type === "set_mode"));
		assert.ok(transcript.some((frame) => frame.type === "connect" && Object.values(frame.values).includes(canary)));
		assert.ok(transcript.filter((frame) => frame.type !== "connect").every((frame) => !JSON.stringify(frame).includes(canary)));
		assert.ok(!JSON.stringify([...a.frames, ...b.frames, configured.logs]).includes(canary));
		from = b.frames.length;
		const disconnectFromA = a.frames.length;
		a.socket.write(`${JSON.stringify({ type: "connectors_disconnect", connector_id: selected.key })}\n`);
		await waitFor(() => b.frames.slice(from).some((frame) => frame.type === "connectors" && frame.live === true));
		await waitFor(() => fs.readFileSync(transcriptFile, "utf8").includes('"type":"disconnect"'));
		assert.ok(a.frames.length > disconnectFromA);
		transcript = fs.readFileSync(transcriptFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.ok(transcript.some((frame) => frame.type === "disconnect"));
		const oldPid = configured.daemon.connectorHost.child.pid;
		const restartFromA = a.frames.length;
		process.kill(oldPid, "SIGKILL");
		await waitFor(() => a.frames.slice(restartFromA).some((frame) => frame.type === "pending" && frame.items.length === 0));
		await waitFor(() => configured.daemon.connectorHost.status === "ready" && configured.daemon.connectorHost.child?.pid !== oldPid, 8000);
		await waitFor(() => fs.readFileSync(transcriptFile, "utf8").split("\n").filter((line) => line.includes('"type":"subscribe"')).length >= 2, 8000);
		const flowEnds = [];
		configured.daemon.connectorsControl.on("auth_done", (frame) => flowEnds.push(frame));
		from = a.frames.length;
		a.socket.write(`${JSON.stringify({ type: "connectors_connect", connector_id: selected.key })}\n`);
		await waitFor(() => a.frames.slice(from).some((frame) => frame.type === "auth_prompt"));
		await configured.daemon.stop();
		assert.ok(flowEnds.some((frame) => frame.message === "unavailable" && frame.cancelled === true));
		assert.equal(configured.daemon.connectorHost.child, undefined);
		assert.equal(configured.daemon.connectorsControl, undefined);
	} finally {
		a.socket.destroy();
		b.socket.destroy();
		await configured.daemon.stop();
	}
});

test("all six live connector commands are unavailable without a configured host", async (t) => {
	const { daemon, root, base } = make();
	t.after(async () => { await daemon.stop(); fs.rmSync(base, { recursive: true, force: true }); });
	await daemon.start();
	const c = await connect(readSession(root));
	try {
		await waitFor(() => c.frames.some((frame) => frame.type === "ready"));
		for (const frame of [
			{ type: "connectors_pending" }, { type: "connectors_approve", proposal_id: "ap-0123456789abcdef0123456789ab", digest: "a".repeat(64) },
			{ type: "connectors_deny", proposal_id: "ap-0123456789abcdef0123456789ab" }, { type: "connectors_connect", connector_id: "notion" },
			{ type: "connectors_disconnect", connector_id: "notion" }, { type: "connectors_mode", connector_id: "notion", mode: "read_only" },
		]) c.socket.write(`${JSON.stringify(frame)}\n`);
		await waitFor(() => c.frames.filter((frame) => frame.type === "error" && frame.code === "unavailable").length === 6);
	} finally { c.socket.destroy(); await daemon.stop(); }
});

// ---- R5: the interrupted-work record is exposed once and consumed only after an explicit ack ----

test("R5: the unconsumed record travels in the ready frame (counts only) and is consumed only after interrupted_ack", async () => {
	const a = make();
	await a.daemon.start();
	try {
		const session = readSession(a.root);
		const { socket, frames } = await connect(session);
		await waitFor(() => frames.some((f) => f.type === "ready"));
		a.daemon.engine.emit("event", { type: "agent_start" });
		a.daemon.engine.emit("event", { type: "extension_ui_request", id: "u1", method: "select", title: "Pick", options: ["a", "b"] });
		await waitFor(() => a.daemon.server.busy === true && a.daemon.server.asks.size === 1);
		socket.destroy();
		await a.daemon.stop();
		assert.equal(interruptedRecord(a.root).consumed, false);
	} finally {
		await a.daemon.stop();
	}
	// The next healthy boot exposes the record but does NOT consume it.
	const b = make({ options: { root: a.root } });
	await b.daemon.start();
	try {
		assert.equal(interruptedRecord(a.root).consumed, false, "boot never consumes the record");
		const session = readSession(a.root);
		const c1 = await connect(session);
		await waitFor(() => c1.frames.some((f) => f.type === "ready"));
		const ready = c1.frames.find((f) => f.type === "ready");
		assert.deepEqual(Object.keys(ready.interrupted ?? {}).sort(), ["asks", "at", "turnActive"], "closed field: counts and time only");
		assert.equal(ready.interrupted.turnActive, true);
		assert.equal(ready.interrupted.asks, 1);
		assert.equal(ready.interrupted.title, undefined, "no ask titles, ids, prompts or args");
		// The ack consumes it, and only then.
		c1.socket.write(`${JSON.stringify({ type: "interrupted_ack" })}\n`);
		await waitFor(() => c1.frames.some((f) => f.type === "interrupted_acknowledged"));
		assert.equal(interruptedRecord(a.root).consumed, true);
		// Idempotent: a second ack is still answered, nothing breaks.
		c1.socket.write(`${JSON.stringify({ type: "interrupted_ack" })}\n`);
		await waitFor(() => c1.frames.filter((f) => f.type === "interrupted_acknowledged").length === 2);
		// A later client sees no interrupted field: the record was consumed once.
		const c2 = await connect(session);
		await waitFor(() => c2.frames.some((f) => f.type === "ready"));
		assert.equal(c2.frames.find((f) => f.type === "ready").interrupted, undefined);
		c1.socket.destroy();
		c2.socket.destroy();
	} finally {
		await b.daemon.stop();
	}
});

// R4 (RDD): persistence failure must not be reported as success; the record stays pending so a retry persists it.
test("R5/R4: interrupted_ack answers failed when the record cannot be persisted and a retry after the fault is removed persists it", async () => {
	const a = make();
	await a.daemon.start();
	try {
		a.daemon.engine.emit("event", { type: "agent_start" });
		a.daemon.engine.emit("event", { type: "extension_ui_request", id: "u1", method: "select", title: "Pick", options: ["a", "b"] });
		await waitFor(() => a.daemon.server.busy === true && a.daemon.server.asks.size === 1);
	} finally {
		await a.daemon.stop();
	}
	assert.equal(interruptedRecord(a.root).consumed, false);
	const b = make({ options: { root: a.root } });
	await b.daemon.start();
	const session = readSession(a.root);
	const c1 = await connect(session);
	try {
		await waitFor(() => c1.frames.some((f) => f.type === "ready"));
		assert.ok(c1.frames.find((f) => f.type === "ready").interrupted);
		// Fault: the record becomes unreadable, so persisting `consumed: true` fails.
		const file = path.join(a.root, "runtime", "interrupted.json");
		fs.chmodSync(file, 0o000);
		c1.socket.write(`${JSON.stringify({ type: "interrupted_ack" })}\n`);
		await waitFor(() => c1.frames.some((f) => f.type === "error" && f.code === "failed"));
		// The record stays pending: a fresh client still sees it in the ready frame.
		const c2 = await connect(session);
		await waitFor(() => c2.frames.some((f) => f.type === "ready"));
		assert.ok(c2.frames.find((f) => f.type === "ready").interrupted, "a failed ack leaves the record pending");
		c2.socket.destroy();
		// Fault removed: the retry persists the record and acknowledges.
		fs.chmodSync(file, 0o600);
		assert.equal(interruptedRecord(a.root).consumed, false);
		c1.socket.write(`${JSON.stringify({ type: "interrupted_ack" })}\n`);
		await waitFor(() => c1.frames.some((f) => f.type === "interrupted_acknowledged"));
		assert.equal(interruptedRecord(a.root).consumed, true);
	} finally {
		c1.socket.destroy();
		await b.daemon.stop();
	}
});

// ---- R8: reparenting to a user subreaper (ppid != 1) is still orphaned ----

test("R8: a daemon reparented away from its boot-time parent is orphaned even when ppid != 1", async () => {
	const { daemon, root } = make();
	await daemon.start();
	try {
		const session = readSession(root);
		assert.equal(typeof session.ppid, "number", "session.json records the boot-time parent pid");
		const same = await classifySession(root, { ppid: () => session.ppid });
		assert.equal(same.state, "healthy", "unchanged parent: healthy");
		// Under a systemd --user session an orphan is reparented to the user
		// subreaper, whose pid is never 1 (the injected seam simulates it).
		const subreaperPpid = session.ppid === 4242 ? 4243 : 4242;
		const reparented = await classifySession(root, { ppid: () => subreaperPpid });
		assert.equal(reparented.state, "orphaned", "reparented away from the boot-time parent: orphaned");
		assert.equal(reparented.reason, "parent_gone");
		assert.equal(reparented.ready, true, "an orphaned daemon can still be serving");
		// ppid 1 stays an accepted orphan shape (the old rule).
		const classic = await classifySession(root, { ppid: () => 1 });
		assert.equal(classic.state, "orphaned");
		assert.equal(classic.reason, "parent_gone");
		// A legacy session without a recorded ppid keeps the old rule only.
		const legacy = { ...session };
		delete legacy.ppid;
		writePrivateFile(path.join(root, "runtime", "session.json"), `${JSON.stringify(legacy)}\n`);
		const old = await classifySession(root, { ppid: () => subreaperPpid });
		assert.equal(old.state, "healthy", "no recorded ppid: no reparenting evidence, old rules apply");
		// A platform without /proc degrades honestly: no crash, no false orphan.
		const blind = await classifySession(root, { ppid: () => undefined });
		assert.equal(blind.state, "healthy");
	} finally {
		await daemon.stop();
	}
});

// Human L52 «Sesiones no disponibles», found live by the screen validator (#502): the daemon
// served sessions_list without a sessions provider, so every ask answered `unavailable`.
test("the daemon wires a sessions provider: sessions_list answers a sessions frame", async () => {
	const { daemon, root } = make();
	await daemon.start();
	try {
		const { socket, frames } = await connect(readSession(root));
		await waitFor(() => frames.some((f) => f.type === "ready"));
		socket.write(`${JSON.stringify({ type: "sessions_list" })}\n`);
		await waitFor(() => frames.some((f) => f.type === "sessions" || f.type === "error"));
		const err = frames.find((f) => f.type === "error");
		assert.equal(err, undefined, `sessions_list must not fail: ${JSON.stringify(err)}`);
		const frame = frames.find((f) => f.type === "sessions");
		assert.ok(Array.isArray(frame.sessions));
		socket.destroy();
	} finally {
		await daemon.stop();
	}
});
