"use strict";

// U4 CLI tests: real child processes against the fake agent; no pi, no provider.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const CLI = path.join(__dirname, "..", "src", "cli.cjs");
const FAKE = path.join(__dirname, "fixtures", "fake-agent.cjs");
const { pidState, procStartTicks } = require("../src/daemon.cjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tempDirs = new Set();

test.after(() => {
	for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** First frame of a raw hello on `endpoint`; "ready" only for the exact token. Never throws. */
async function helloProbe(endpoint, token) {
	return new Promise((resolve) => {
		const socket = net.connect(endpoint);
		let buf = "";
		let settled = false;
		const done = (value) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(value);
		};
		socket.setTimeout(3000, () => done("timeout"));
		socket.on("error", () => done("refused"));
		socket.on("close", () => done("closed"));
		socket.on("data", (d) => {
			buf += d.toString("utf8");
			const i = buf.indexOf("\n");
			if (i < 0) return;
			try {
				done(JSON.parse(buf.slice(0, i)).type);
			} catch {
				done("bad");
			}
		});
		socket.on("connect", () => socket.write(`${JSON.stringify({ type: "hello", protocol: "island-agent/1", token })}\n`));
	});
}

function tmp() {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "abito-cli-")));
	tempDirs.add(dir);
	return dir;
}
function cli(root, args, extraEnv = {}) {
	return spawnSync(process.execPath, [CLI, ...args], {
		env: { PATH: process.env.PATH, HOME: tmp(), ABITO_ISLAND_DIR: root, ...extraEnv },
		encoding: "utf8",
		timeout: 60000,
	});
}
async function waitFor(fn, ms = 60000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (fn()) return;
		await sleep(20);
	}
	assert.ok(fn(), "waitFor timed out");
}
/** Kills (if needed) and waits for the exit of a child so nothing leaks. */
async function reap(child) {
	if (child.exitCode === null && child.signalCode === null) {
		const exited = new Promise((resolve) => child.once("exit", resolve));
		child.kill("SIGKILL");
		await exited;
	}
}
/** Island whose config.json points `command` at a wrapper script running the fake agent. */
function fakeIsland(extraConfig = {}) {
	const base = tmp();
	const root = path.join(base, "i");
	const wrapper = path.join(base, "fake-pi.sh");
	fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
	fs.mkdirSync(root, { mode: 0o700 });
	fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ command: wrapper, ...extraConfig }), { mode: 0o600 });
	const env = { PATH: process.env.PATH, HOME: tmp(), ABITO_ISLAND_DIR: root };
	return { root, env };
}
const sessionOf = (root) => path.join(root, "runtime", "session.json");
async function waitForSessionPid(root, pid) {
	await waitFor(() => {
		try { return JSON.parse(fs.readFileSync(sessionOf(root), "utf8")).pid === pid; }
		catch { return false; }
	}, 60000);
}

test("app-owned run stops on stdin EOF and removes its session handoff", async () => {
	const { root, env } = fakeIsland();
	const child = spawn(process.execPath, [CLI, "run", "--app-owned"], { env, stdio: ["pipe", "pipe", "pipe"] });
	let output = "";
	child.stderr.on("data", (d) => { output += d; });
	try {
		await waitFor(() => fs.existsSync(sessionOf(root)) || child.exitCode !== null);
		assert.equal(child.exitCode, null, output);
		child.stdin.end();
		await waitFor(() => child.exitCode !== null);
		assert.equal(child.exitCode, 0, output);
		assert.equal(fs.existsSync(sessionOf(root)), false);
		assert.equal(output.includes("token"), false);
	} finally { await reap(child); }
});

test("app-owned run with immediate EOF never publishes a live session", async () => {
	const { root, env } = fakeIsland();
	const child = spawn(process.execPath, [CLI, "run", "--app-owned"], { env, stdio: ["pipe", "pipe", "pipe"] });
	child.stderr.resume(); child.stdout.resume(); child.stdin.end();
	try {
		await waitFor(() => child.exitCode !== null);
		assert.equal(child.exitCode, 0);
		assert.equal(fs.existsSync(sessionOf(root)), false);
	} finally { await reap(child); }
});

test("usage errors exit 2 with a generic message", () => {
	const root = path.join(tmp(), "i");
	for (const args of [[], ["bogus"], ["config"], ["config", "set-workspace"], ["config", "nope"], ["run", "--x"]]) {
		const r = cli(root, args);
		assert.equal(r.status, 2, args.join(" "));
		assert.match(r.stderr, /usage:/);
	}
});

test("config errors exit 1 naming only the field", () => {
	const root = path.join(tmp(), "i");
	fs.mkdirSync(root, { mode: 0o700 });
	fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ workspace: "/SECRET-VALUE/../x" }), { mode: 0o600 });
	for (const args of [["config", "get"], ["run"]]) {
		const r = cli(root, args);
		assert.equal(r.status, 1);
		assert.match(r.stderr, /invalid config: workspace/);
		assert.ok(!r.stderr.includes("SECRET-VALUE") && !r.stdout.includes("SECRET-VALUE"));
	}
});

test("config get prints the effective config; set-workspace persists it", () => {
	const root = path.join(tmp(), "i");
	const ws = tmp();
	let r = cli(root, ["config", "get"]);
	assert.equal(r.status, 0);
	const got = JSON.parse(r.stdout);
	assert.equal(got.command, "pi");
	assert.equal(got.workspaceSource, "default");
	r = cli(root, ["config", "set-workspace", ws]);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(JSON.parse(cli(root, ["config", "get"]).stdout).workspace, ws);
	assert.equal(fs.statSync(path.join(root, "config.json")).mode & 0o777, 0o600);
	r = cli(root, ["config", "set-workspace", "relative"]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /invalid config: workspace/);
	assert.equal(JSON.parse(cli(root, ["config", "get"]).stdout).workspace, ws);
});

test("status and stop with no daemon exit 3", () => {
	const root = path.join(tmp(), "i");
	assert.equal(cli(root, ["status"]).status, 3);
	assert.equal(cli(root, ["stop"]).status, 3);
});

test("stale session.json of a dead pid: status 3, stop 3 and the stale file is cleaned", () => {
	const root = path.join(tmp(), "i");
	cli(root, ["config", "get"]);
	const dead = spawnSync(process.execPath, ["-e", ""]).pid;
	fs.mkdirSync(path.join(root, "runtime"), { recursive: true, mode: 0o700 });
	fs.writeFileSync(sessionOf(root), JSON.stringify({ protocol: "island-agent/1", endpoint: "/x", token: "t".repeat(40), pid: dead, startedAt: 1 }), { mode: 0o600 });
	assert.equal(cli(root, ["status"]).status, 3);
	assert.equal(cli(root, ["stop"]).status, 3);
	assert.equal(fs.existsSync(sessionOf(root)), false);
});

test("stop refuses a live pid that is not the daemon (ownership check)", async () => {
	const root = path.join(tmp(), "i");
	cli(root, ["config", "get"]);
	const bystander = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
	try {
		fs.mkdirSync(path.join(root, "runtime"), { recursive: true, mode: 0o700 });
		fs.writeFileSync(sessionOf(root), JSON.stringify({ protocol: "island-agent/1", endpoint: "/x", token: "t".repeat(40), pid: bystander.pid, startedAt: 1 }), { mode: 0o600 });
		const r = cli(root, ["stop"]);
		assert.equal(r.status, 1);
		assert.equal(process.kill(bystander.pid, 0), true, "bystander must survive");
	} finally {
		await reap(bystander);
	}
});

test("stop does not SIGTERM a same-user `node .../cli.cjs` sleeper that merely has a session.json pointing at it", async () => {
	const root = path.join(tmp(), "i");
	cli(root, ["config", "get"]);
	const dir = path.join(tmp(), "x");
	fs.mkdirSync(dir);
	const script = path.join(dir, "cli.cjs");
	fs.writeFileSync(script, "setInterval(()=>{},1000)");
	const sleeper = spawn(process.execPath, [script], { stdio: "ignore" });
	try {
		fs.mkdirSync(path.join(root, "runtime"), { recursive: true, mode: 0o700 });
		for (const extra of [{}, { procStart: "1" }, { procStart: 12 }]) {
			fs.writeFileSync(sessionOf(root), JSON.stringify({ protocol: "island-agent/1", endpoint: "/x", token: "t".repeat(40), pid: sleeper.pid, startedAt: 1, ...extra }), { mode: 0o600 });
			const r = cli(root, ["stop"]);
			assert.equal(r.status, 1, JSON.stringify(extra));
			assert.equal(cli(root, ["status"]).status, 3, "status must not confirm it either");
			assert.equal(sleeper.exitCode, null);
			assert.equal(sleeper.signalCode, null, "sleeper must not be signalled");
			assert.equal(process.kill(sleeper.pid, 0), true);
		}
	} finally {
		await reap(sleeper);
	}
});

test("SIGKILLed daemon leaves a stale session.json that status classifies and unlinks", async () => {
	const { root, env } = fakeIsland();
	const child = spawn(process.execPath, [CLI, "run"], { env, stdio: "ignore", timeout: 120000 });
	try {
		await waitForSessionPid(root, child.pid);
		child.kill("SIGKILL");
		await waitFor(() => child.exitCode !== null || child.signalCode !== null);
		assert.equal(fs.existsSync(sessionOf(root)), true, "SIGKILL cannot be handled");
		assert.equal(cli(root, ["status"], env).status, 3);
		assert.equal(fs.existsSync(sessionOf(root)), false);
	} finally {
		await reap(child);
	}
});

test("run (foreground) -> status -> stop; SIGTERM shuts down gracefully and removes session.json", async () => {
	const ws = tmp();
	const { root, env } = fakeIsland();
	assert.equal(cli(root, ["config", "set-workspace", ws]).status, 0);
	const child = spawn(process.execPath, [CLI, "run"], { env, stdio: ["ignore", "pipe", "pipe"], timeout: 120000 });
	let out = "";
	child.stdout.on("data", (d) => (out += d));
	child.stderr.on("data", (d) => (out += d));
	try {
		await waitForSessionPid(root, child.pid);
		const token = JSON.parse(fs.readFileSync(sessionOf(root), "utf8")).token;
		const st = cli(root, ["status"], env);
		assert.equal(st.status, 0, st.stderr);
		const status = JSON.parse(st.stdout);
		assert.equal(status.running, true);
		assert.equal(status.pid, child.pid);
		assert.equal(status.workspace, ws);
		assert.ok(!st.stdout.includes(token), "status must not print the token");
		const stop = cli(root, ["stop"], env);
		assert.equal(stop.status, 0, stop.stderr);
		await waitFor(() => child.exitCode !== null);
		assert.equal(child.exitCode, 0);
		assert.equal(fs.existsSync(sessionOf(root)), false);
		assert.ok(!out.includes(token), "token must not be printed");
	} finally {
		await reap(child);
	}
});

test("SIGINT also shuts down cleanly", async () => {
	const { root, env } = fakeIsland();
	const child = spawn(process.execPath, [CLI, "run"], { env, stdio: ["ignore", "ignore", "pipe"], timeout: 120000 });
	let stderr = "";
	child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
	try {
		await waitForSessionPid(root, child.pid);
		await waitFor(() => stderr.includes(`running (pid ${child.pid})`), 60000);
		child.kill("SIGINT");
		await waitFor(() => child.exitCode !== null || child.signalCode !== null, 60000);
		assert.equal(child.exitCode, 0);
		assert.equal(fs.existsSync(sessionOf(root)), false);
	} finally {
		await reap(child);
	}
});

test("a second run while one is live exits 1", async () => {
	const { root, env } = fakeIsland();
	const child = spawn(process.execPath, [CLI, "run"], { env, stdio: "ignore", timeout: 120000 });
	try {
		await waitForSessionPid(root, child.pid);
		const second = cli(root, ["run"], env);
		assert.equal(second.status, 1);
		assert.match(second.stderr, /already running/);
	} finally {
		child.kill("SIGTERM");
		await waitFor(() => child.exitCode !== null || child.signalCode !== null, 60000);
		await reap(child);
	}
});

test("MCP projection: deleted on SIGTERM; after SIGKILL it stays and the next start overwrites it (known limit)", async () => {
	const src = path.join(tmp(), "mcp-src.json");
	const entry = (id) => JSON.stringify({ mcpServers: { [id]: { type: "http", url: "http://127.0.0.1:4821/n", headers: { Authorization: "Bearer cap_abcdef123456" } } } });
	fs.writeFileSync(src, entry("first"), { mode: 0o600 });
	const { root, env } = fakeIsland({ mcpConfigPath: src });
	const projected = path.join(root, "agent", "mcp.json");
	const children = [];
	const run = () => {
		const child = spawn(process.execPath, [CLI, "run"], { env, stdio: "ignore", timeout: 120000 });
		children.push(child);
		return child;
	};

	let child = run();
	try {
		await waitForSessionPid(root, child.pid);
		assert.equal(fs.statSync(projected).mode & 0o777, 0o600);
		child.kill("SIGTERM");
		await waitFor(() => child.exitCode !== null || child.signalCode !== null, 60000);
		assert.equal(fs.existsSync(projected), false, "clean stop removes the projection");

		child = run();
		await waitForSessionPid(root, child.pid);
		child.kill("SIGKILL");
		await waitFor(() => child.exitCode !== null || child.signalCode !== null, 60000);
		assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(projected, "utf8")).mcpServers), ["first"], "SIGKILL cannot be handled: file stays");

		fs.writeFileSync(src, entry("second"), { mode: 0o600 });
		child = run();
		// The SIGKILLed daemon left a stale session.json: wait for THIS child's own session.
		await waitForSessionPid(root, child.pid);
		assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(projected, "utf8")).mcpServers), ["second"], "next start overwrites the stale file");
		child.kill("SIGTERM");
		await waitFor(() => child.exitCode !== null || child.signalCode !== null, 60000);
		assert.equal(fs.existsSync(projected), false);
	} finally {
		for (const child of children) await reap(child);
	}
});

test("config set-hotkey: set, show in config get, clear, invalid and usage exit codes", () => {
	const root = path.join(tmp(), "i");
	assert.equal(JSON.parse(cli(root, ["config", "get"]).stdout).hotkey, null);
	let r = cli(root, ["config", "set-hotkey", "ctrl+alt+space"]);
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(JSON.parse(r.stdout), { hotkey: "Ctrl+Alt+Space", changed: true, appliedToRunningDaemon: false });
	assert.equal(JSON.parse(cli(root, ["config", "get"]).stdout).hotkey, "Ctrl+Alt+Space");
	assert.equal(fs.statSync(path.join(root, "config.json")).mode & 0o777, 0o600);
	r = cli(root, ["config", "set-hotkey", "Ctrl+Alt+Space"]);
	assert.equal(r.status, 0);
	assert.equal(JSON.parse(r.stdout).changed, false);
	for (const bad of ["Space", "Ctrl+F25", "Ctrl+Ctrl+A", "Ctrl + A"]) {
		r = cli(root, ["config", "set-hotkey", bad]);
		assert.equal(r.status, 1, bad);
		assert.match(r.stderr, /invalid config: hotkey/);
	}
	assert.equal(JSON.parse(cli(root, ["config", "get"]).stdout).hotkey, "Ctrl+Alt+Space", "invalid input changed nothing");
	r = cli(root, ["config", "set-hotkey", "--clear"]);
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(JSON.parse(r.stdout), { hotkey: null, changed: true, appliedToRunningDaemon: false });
	assert.equal(JSON.parse(cli(root, ["config", "get"]).stdout).hotkey, null);
	for (const args of [["config", "set-hotkey"], ["config", "set-hotkey", "Ctrl+A", "extra"], ["config", "set-hotkey", "--clear", "x"]]) {
		r = cli(root, args);
		assert.equal(r.status, 2, args.join(" "));
		assert.match(r.stderr, /usage:/);
	}
});

test("config set-hotkey does not echo the rejected value", () => {
	const root = path.join(tmp(), "i");
	const r = cli(root, ["config", "set-hotkey", "Ctrl+SECRETVALUE"]);
	assert.equal(r.status, 1);
	assert.ok(!r.stderr.includes("SECRETVALUE") && !r.stdout.includes("SECRETVALUE"));
});

test("invalid hotkey in config.json never locks the CLI: get warns, set-workspace drops, --clear repairs", () => {
	const root = path.join(tmp(), "i");
	cli(root, ["config", "get"]);
	const file = path.join(root, "config.json");
	const write = () => fs.writeFileSync(file, JSON.stringify({ hotkey: "Ctrl+SECRETVALUE" }), { mode: 0o600 });
	write();
	let r = cli(root, ["config", "get"]);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stderr, /hotkey: invalid \(ignored\)/);
	assert.equal(JSON.parse(r.stdout).hotkeyInvalid, true);
	assert.ok(!r.stdout.includes("SECRETVALUE") && !r.stderr.includes("SECRETVALUE"));
	const ws = tmp();
	r = cli(root, ["config", "set-workspace", ws]);
	assert.equal(r.status, 0, r.stderr);
	assert.ok(!fs.readFileSync(file, "utf8").includes("SECRETVALUE"));
	write();
	r = cli(root, ["config", "set-hotkey", "--clear"]);
	assert.equal(r.status, 0, r.stderr);
	assert.ok(!fs.readFileSync(file, "utf8").includes("hotkey"));
	r = cli(root, ["config", "get"]);
	assert.equal(r.status, 0);
	assert.ok(!r.stderr.includes("invalid (ignored)"));
});

// ---- #390 GD014/GD029: status health fields, arbitration and the launch ledger ----

test("#390 GD014: status reports state/reason/ready, and a killed daemon explains itself", async () => {
	const { root, env } = fakeIsland();
	const child = spawn(process.execPath, [CLI, "run"], { env, stdio: "ignore" });
	try {
		await waitFor(() => fs.existsSync(sessionOf(root)));
		const st = cli(root, ["status"], env);
		assert.equal(st.status, 0, st.stderr);
		const out = JSON.parse(st.stdout);
		assert.equal(out.running, true);
		assert.equal(out.state, "healthy");
		assert.equal(out.reason, "ready");
		assert.equal(out.ready, true);

		child.kill("SIGKILL");
		await waitFor(() => child.exitCode !== null || child.signalCode !== null);
		const st2 = cli(root, ["status"], env);
		assert.equal(st2.status, 3);
		assert.match(st2.stderr, /pid_dead/, `the exit-3 message must name the classification: ${st2.stderr}`);
		assert.equal(fs.existsSync(sessionOf(root)), false, "the stale session is still cleaned");
	} finally {
		await reap(child);
	}
});

test("#390 GD029 check (3): a live pid whose endpoint refuses is never replaced; the refusal is recorded", async () => {
	const { root, env } = fakeIsland();
	const bystander = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
	try {
		fs.mkdirSync(path.join(root, "runtime"), { recursive: true, mode: 0o700 });
		const file = sessionOf(root);
		fs.writeFileSync(file, JSON.stringify({ protocol: "island-agent/1", endpoint: "/x", token: "t".repeat(40), pid: bystander.pid, startedAt: 1 }), { mode: 0o600 });
		const before = fs.statSync(file);
		// Own timeout so a blind replacement fails FAST (RED would otherwise block 60 s in a live daemon).
		const r = spawnSync(process.execPath, [CLI, "run"], { env, encoding: "utf8", timeout: 15000 });
		assert.equal(r.status, 1, `run must refuse; got status=${r.status} signal=${r.signal} stderr=${r.stderr}`);
		assert.match(r.stderr, /already running/);
		const after = fs.statSync(file);
		assert.equal(after.ino, before.ino, "the live session must not be rewritten");
		assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).pid, bystander.pid, "the incumbent session is untouched");
		assert.equal(bystander.exitCode, null);
		assert.equal(process.kill(bystander.pid, 0), true, "the bystander must survive");
		const ledger = path.join(root, "runtime", "launches.jsonl");
		const text = fs.readFileSync(ledger, "utf8");
		const last = text.trim().split("\n").map((line) => JSON.parse(line)).at(-1);
		assert.equal(last.outcome, "refused");
		assert.equal(last.reason, "foreign_session");
		assert.equal(last.incumbentPid, bystander.pid);
		assert.equal(typeof last.pid, "number");
		assert.equal(typeof last.procStart, "string");
		assert.equal(fs.statSync(ledger).mode & 0o777, 0o600);
		assert.ok(!text.includes("ttttt"), "the ledger never carries the token");
	} finally {
		await reap(bystander);
	}
});

test("#390 check (5): a restart leaves the old pid dead, a fresh procStart and the old token refused", async () => {
	const { root, env } = fakeIsland();
	const child1 = spawn(process.execPath, [CLI, "run"], { env, stdio: "ignore" });
	let child2;
	try {
		await waitFor(() => fs.existsSync(sessionOf(root)));
		const s1 = JSON.parse(fs.readFileSync(sessionOf(root), "utf8"));
		assert.equal(cli(root, ["stop"], env).status, 0);
		await waitFor(() => child1.exitCode !== null);
		assert.equal(child1.exitCode, 0);
		// the exit event means OUR child was reaped: no zombie, no live pid
		assert.equal(pidState(s1.pid), "dead", "the old daemon pid is dead and reaped");

		child2 = spawn(process.execPath, [CLI, "run"], { env, stdio: "ignore" });
		await waitFor(() => {
			try {
				return JSON.parse(fs.readFileSync(sessionOf(root), "utf8")).pid === child2.pid;
			} catch {
				return false;
			}
		});
		const s2 = JSON.parse(fs.readFileSync(sessionOf(root), "utf8"));
		assert.notEqual(s2.pid, s1.pid);
		assert.equal(s2.procStart, procStartTicks(s2.pid), "the new session records the new pid's start time");
		assert.notEqual(s2.token, s1.token, "every launch gets a fresh token");
		assert.equal(await helloProbe(s2.endpoint, s1.token), "closed", "the old token must never handshake after a restart");
		assert.equal(await helloProbe(s2.endpoint, s2.token), "ready", "the new token proves the replacement is healthy");
		const lines = fs.readFileSync(path.join(root, "runtime", "launches.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		const last = lines.at(-1);
		assert.equal(last.outcome, "started");
		assert.equal(last.pid, child2.pid, "the ledger records who launched");
	} finally {
		if (child2) await reap(child2);
		await reap(child1);
	}
});
