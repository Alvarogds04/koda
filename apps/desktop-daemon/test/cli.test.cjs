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
const { assertMode } = require("./platform-env.cjs");
const { classifySession, pidState, procStartTicks } = require("../src/daemon.cjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tempDirs = new Set();

const WIN = process.platform === "win32";
// /proc identity and POSIX signals (SIGTERM/SIGINT graceful stop, the POSIX stale-file cleanup)
// are Unix mechanisms; every other behaviour here is daemon LIFECYCLE and runs on all 3 OS. On
// Windows the fake agent is provisioned through the product's real npm-prefix spawn path
// (windowsPackageCliJs, private AppData) and the native session helper publishes/verifies the
// session, so lifecycle tests exercise the real boot there too. The unixOnly tests skip on
// Windows and name their twin; twins assert Q2a product contracts: status/stop never confirm a
// daemon by a bare pid and never signal it.
const unixOnly = (twin) => ({ skip: WIN && `Unix mechanism (/proc identity, POSIX signals); Windows: ${twin}` });
const winOnly = (why = "needs Windows + the compiled, manifest-trusted abito-private-session.exe (present on the Windows CI runner)") => ({ skip: !WIN && why });

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
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(tmpBase(), "abito-cli-")));
	tempDirs.add(dir);
	return dir;
}
const tmpBase = () => fs.realpathSync.native(os.tmpdir());
/**
 * Island root for direct staging (no fake agent). On Windows an island may only live inside the
 * canonical protected %LOCALAPPDATA%\Abito root (windowsIslandRootViolation), so every island
 * gets a PRIVATE LOCALAPPDATA temp dir and sits at `<LOCALAPPDATA>\Abito\i`; cliEnv() puts the
 * matching LOCALAPPDATA into the child env. Linux/macOS: `<tmp>/i`, env unchanged as before.
 */
function islandRoot() {
	if (!WIN) return path.join(tmp(), "i");
	const local = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpBase(), "abito-local-")));
	tempDirs.add(local);
	// The app creates the protected root and the island inside it (ensureIsland); the fixture mirrors that
	// layout so the single-component mkdir of `i` below (fakeIsland, explicit mkdirs) always has its parent.
	fs.mkdirSync(path.join(local, "Abito"), { mode: 0o700 });
	return path.join(local, "Abito", "i");
}
/** Child env for `root`: private HOME, ABITO_ISLAND_DIR, and on Windows the private LOCALAPPDATA. */
function cliEnv(root, extra = {}) {
	const env = { PATH: process.env.PATH, HOME: tmp(), ABITO_ISLAND_DIR: root, ...extra };
	if (WIN) {
		// A child node cannot bootstrap without the Windows system variables; everything
		// user-identifying stays private: LOCALAPPDATA (and TEMP/TMP) point at the private
		// temp dirs, never at the runner's real profile.
		for (const key of ["SystemRoot", "windir", "SystemDrive", "ComSpec", "PATHEXT", "OS", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"]) {
			if (process.env[key] !== undefined && env[key] === undefined) env[key] = process.env[key];
		}
		if (env.ABITO_ISLAND_DIR === root) env.LOCALAPPDATA = path.dirname(path.dirname(root)); // <local>\Abito\i -> <local>
		const privateTemp = path.join(path.dirname(env.HOME), "tmp");
		fs.mkdirSync(privateTemp, { recursive: true });
		env.TEMP = privateTemp;
		env.TMP = privateTemp;
	}
	return env;
}
function cli(root, args, extraEnv = {}) {
	return spawnSync(process.execPath, [CLI, ...args], {
		env: cliEnv(root, extraEnv),
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
/** Island running the fake agent. On Windows the REAL product spawn path is used: the daemon
 * resolves bare `pi` through the npm prefixes (env.AppData\npm first, windowsPackageCliJs), so the
 * island gets a PRIVATE AppData npm prefix containing the fake agent as the package's `pi` bin —
 * never the runner's real AppData. Linux/macOS: a `#!/bin/sh` wrapper (the Unix exec mechanism). */
function fakeIsland(extraConfig = {}) {
	const root = islandRoot();
	const base = path.dirname(root);
	fs.mkdirSync(root, { mode: 0o700 });
	if (WIN) {
		const packageDir = path.join(base, "AppData", "npm", "node_modules", "@earendil-works", "pi-coding-agent");
		fs.mkdirSync(packageDir, { recursive: true });
		fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { pi: "fake-agent.cjs" } }));
		fs.copyFileSync(FAKE, path.join(packageDir, "fake-agent.cjs")); // only requires node:fs and node:path
		fs.writeFileSync(path.join(root, "config.json"), JSON.stringify(extraConfig), { mode: 0o600 });
		return { root, env: cliEnv(root, { AppData: path.join(base, "AppData") }) };
	}
	const wrapper = path.join(base, "fake-pi.sh");
	fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
	fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ command: wrapper, ...extraConfig }), { mode: 0o600 });
	return { root, env: cliEnv(root) };
}
const sessionOf = (root) => path.join(root, "runtime", "session.json");
const sessionPid = (root) => {
	try { return JSON.parse(fs.readFileSync(sessionOf(root), "utf8")).pid; }
	catch { return undefined; }
};
async function waitForSessionPid(root, pid) {
	await waitFor(() => sessionPid(root) === pid, 60000);
}
/** The same wait, for a daemon this test starts itself. CI 43352802736 (windows, test 123) failed with `waitFor timed
 *  out` where this wait reads session.json: a fixed 60 s bound for a boot that the runner was plainly stretching (the two
 *  tests either side of it took 7.9 s and 23.6 s), and a silence that could not say whether the daemon was slow or dead.
 *  So it waits for the EFFECT (this pid owns the island) with a generous bound, and fails at once, in the child's own
 *  words, if the daemon dies first. What it proves is unchanged: the successor owns the island before the assertions. */
async function waitForOwnSession(root, child) {
	const tail = () => child.output || "(no output)";
	const end = Date.now() + 180000;
	while (Date.now() < end) {
		if (sessionPid(root) === child.pid) return;
		if (child.exitCode !== null || child.signalCode !== null) {
			assert.fail(`the daemon exited (${child.exitCode ?? child.signalCode}) before owning the island: ${tail()}`);
		}
		await sleep(20);
	}
	assert.equal(sessionPid(root), child.pid, `the daemon did not own the island within 180 s: ${tail()}`);
}
/** Waits for the verdict the NEXT boot itself requires before it may replace a session: `stale`, i.e. a confirmed dead
 *  pid. A hard kill leaves session.json behind (a documented Windows limit: POSIX status cleans it), and Windows answers
 *  signal 0 for a pid the OS has not released yet, so a successor started too early is refused with words. Waiting for
 *  this verdict waits for the effect; it does not relax anything the assertions below prove. */
async function waitForReplaceable(root) {
	const end = Date.now() + 60000;
	let verdict = await classifySession(root);
	while (verdict.state !== "stale" && Date.now() < end) {
		await sleep(200);
		verdict = await classifySession(root);
	}
	assert.equal(verdict.state, "stale", `the island cannot be replaced 60 s after a hard kill: ${JSON.stringify(verdict)}`);
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
	const root = islandRoot();
	for (const args of [[], ["bogus"], ["config"], ["config", "set-workspace"], ["config", "nope"], ["run", "--x"]]) {
		const r = cli(root, args);
		assert.equal(r.status, 2, args.join(" "));
		assert.match(r.stderr, /usage:/);
	}
});

test("config errors exit 1 naming only the field", () => {
	const root = islandRoot();
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
	const root = islandRoot();
	const ws = tmp();
	let r = cli(root, ["config", "get"]);
	assert.equal(r.status, 0);
	const got = JSON.parse(r.stdout);
	assert.equal(got.command, "pi");
	assert.equal(got.workspaceSource, "default");
	r = cli(root, ["config", "set-workspace", ws]);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(JSON.parse(cli(root, ["config", "get"]).stdout).workspace, ws);
	assertMode(path.join(root, "config.json"), 0o600);
	r = cli(root, ["config", "set-workspace", "relative"]);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /invalid config: workspace/);
	assert.equal(JSON.parse(cli(root, ["config", "get"]).stdout).workspace, ws);
});

test("status and stop with no daemon exit 3", () => {
	const root = islandRoot();
	assert.equal(cli(root, ["status"]).status, 3);
	assert.equal(cli(root, ["stop"]).status, 3);
});

test("stale session.json of a dead pid: status 3 and stop 3, never a bare-pid confirmation", () => {
	const root = islandRoot();
	cli(root, ["config", "get"]);
	const dead = spawnSync(process.execPath, ["-e", ""]).pid;
	fs.mkdirSync(path.join(root, "runtime"), { recursive: true, mode: 0o700 });
	fs.writeFileSync(sessionOf(root), JSON.stringify({ protocol: "island-agent/1", endpoint: "/x", token: "t".repeat(40), pid: dead, startedAt: 1 }), { mode: 0o600 });
	const status = cli(root, ["status"]);
	assert.equal(status.status, 3, status.stderr);
	assert.match(status.stderr, /pid_dead/, "the classification names the dead pid, never a bare-pid confirmation");
	assert.equal(fs.existsSync(sessionOf(root)), WIN, WIN ? "Windows status is read-only: the stale file survives status" : "POSIX status cleans the stale session (liveSession)");
	const stop = cli(root, ["stop"]);
	assert.equal(stop.status, 3, stop.stderr);
	// stop() classifies the dead pid through liveSession on every OS and removes the confirmed-stale file
	// before reporting «not running» (cli.cjs stop has no Windows gate; observed in CI run 41718553579).
	assert.equal(fs.existsSync(sessionOf(root)), false, "the stale file is gone after stop on every OS");
});

test("stop refuses a live pid that is not the daemon (ownership check)", async () => {
	const root = islandRoot();
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
	const root = islandRoot();
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

test("a hard-killed daemon leaves a stale session.json that status classifies (POSIX cleans it; Windows status keeps it)", async () => {
	const { root, env } = fakeIsland();
	const child = spawn(process.execPath, [CLI, "run"], { env, stdio: "ignore", timeout: 120000 });
	try {
		await waitForSessionPid(root, child.pid);
		child.kill("SIGKILL"); // hard kill works on every OS; no shutdown handler can run
		await waitFor(() => child.exitCode !== null || child.signalCode !== null);
		assert.equal(fs.existsSync(sessionOf(root)), true, "a hard kill cannot be handled: the file stays");
		const st = cli(root, ["status"], env);
		assert.equal(st.status, 3, st.stderr);
		assert.match(st.stderr, /pid_dead/, `the exit-3 message must name the classification: ${st.stderr}`);
		assert.equal(fs.existsSync(sessionOf(root)), WIN, WIN ? "Windows status is read-only: the stale file is kept, never POSIX-unlinked" : "the stale session is still cleaned");
	} finally {
		await reap(child);
	}
});

test("run (foreground) -> status -> stop; SIGTERM shuts down gracefully and removes session.json", unixOnly("POSIX SIGTERM graceful stop; Windows twins: app-owned EOF clean shutdown + native-proof status with stop refusal"), async () => {
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

test("SIGINT also shuts down cleanly", unixOnly("POSIX SIGINT; Windows twin: app-owned run stops cleanly on stdin EOF, without signals"), async () => {
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

test("MCP projection: written from mcpConfigPath, kept across a hard kill, overwritten by the next start, removed on a clean stop", async () => {
	const src = path.join(tmp(), "mcp-src.json");
	const entry = (id) => JSON.stringify({ mcpServers: { [id]: { type: "http", url: "http://127.0.0.1:4821/n", headers: { Authorization: "Bearer cap_abcdef123456" } } } });
	fs.writeFileSync(src, entry("first"), { mode: 0o600 });
	const { root, env } = fakeIsland({ mcpConfigPath: src });
	const projected = path.join(root, "agent", "mcp.json");
	const children = [];
	const runOwned = () => {
		const child = spawn(process.execPath, [CLI, "run", "--app-owned"], { env, stdio: ["pipe", "pipe", "pipe"] });
		child.output = "";
		child.stderr.on("data", (d) => { child.output += d; }); // a refusal must reach the failure message, not a 60 s silence
		children.push(child);
		return child;
	};
	try {
		let child = runOwned();
		await waitForOwnSession(root, child);
		assert.equal(fs.existsSync(projected), true, "the boot writes the projection from mcpConfigPath");
		if (!WIN) assert.equal(fs.statSync(projected).mode & 0o777, 0o600, "the projection is private");
		assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(projected, "utf8")).mcpServers), ["first"]);
		child.kill("SIGKILL"); // hard kill works on every OS; nothing can clean up
		await waitFor(() => child.exitCode !== null || child.signalCode !== null);
		assert.equal(fs.existsSync(projected), true, "a hard kill cannot be handled: the projection stays");

		fs.writeFileSync(src, entry("second"), { mode: 0o600 });
		// The hard kill left a stale session.json: wait until the island really is replaceable, then for THIS child's own session.
		await waitForReplaceable(root);
		child = runOwned();
		await waitForOwnSession(root, child);
		assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(projected, "utf8")).mcpServers), ["second"], "next start overwrites the stale projection");
		child.stdin.end(); // clean stop, no POSIX signals
		await waitFor(() => child.exitCode !== null);
		assert.equal(child.exitCode, 0);
		assert.equal(fs.existsSync(projected), false, "a clean stop removes the projection");
	} finally {
		for (const child of children) await reap(child);
	}
});

test("MCP projection: deleted on SIGTERM; after SIGKILL it stays and the next start overwrites it (known limit)", unixOnly("POSIX SIGTERM graceful deletion; Windows twin: the projection lifecycle above (create, hard-kill, overwrite, clean-stop removal)"), async () => {
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
	const root = islandRoot();
	assert.equal(JSON.parse(cli(root, ["config", "get"]).stdout).hotkey, null);
	let r = cli(root, ["config", "set-hotkey", "ctrl+alt+space"]);
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(JSON.parse(r.stdout), { hotkey: "Ctrl+Alt+Space", changed: true, appliedToRunningDaemon: false });
	assert.equal(JSON.parse(cli(root, ["config", "get"]).stdout).hotkey, "Ctrl+Alt+Space");
	assertMode(path.join(root, "config.json"), 0o600);
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
	const root = islandRoot();
	const r = cli(root, ["config", "set-hotkey", "Ctrl+SECRETVALUE"]);
	assert.equal(r.status, 1);
	assert.ok(!r.stderr.includes("SECRETVALUE") && !r.stdout.includes("SECRETVALUE"));
});

test("invalid hotkey in config.json never locks the CLI: get warns, set-workspace drops, --clear repairs", () => {
	const root = islandRoot();
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

test("#390 GD014: status reports state/reason/ready for a RUNNING daemon (native proof on Windows)", async () => {
	const { root, env } = fakeIsland();
	const child = spawn(process.execPath, [CLI, "run", "--app-owned"], { env, stdio: ["pipe", "pipe", "pipe"] });
	try {
		await waitForSessionPid(root, child.pid);
		const st = cli(root, ["status"], env);
		assert.equal(st.status, 0, st.stderr);
		const out = JSON.parse(st.stdout);
		assert.equal(out.running, true);
		assert.equal(out.pid, child.pid);
		assert.equal(out.state, "healthy");
		assert.equal(out.reason, "ready");
		assert.equal(out.ready, true);
		const token = JSON.parse(fs.readFileSync(sessionOf(root), "utf8")).token;
		assert.ok(!st.stdout.includes(token), "status must not print the token");
	} finally {
		child.stdin.end();
		await reap(child);
	}
});

test("#390 GD014: a hard-killed daemon explains itself (stale: pid_dead)", async () => {
	const { root, env } = fakeIsland();
	const child = spawn(process.execPath, [CLI, "run", "--app-owned"], { env, stdio: ["pipe", "pipe", "pipe"] });
	try {
		await waitForSessionPid(root, child.pid);
		child.kill("SIGKILL"); // hard kill works on every OS
		await waitFor(() => child.exitCode !== null || child.signalCode !== null);
		const st2 = cli(root, ["status"], env);
		assert.equal(st2.status, 3, st2.stderr);
		assert.match(st2.stderr, /pid_dead/, `the exit-3 message must name the classification: ${st2.stderr}`);
	} finally {
		await reap(child);
	}
});

test("Windows twin: status confirms a live daemon only through the native helper, and stop still refuses the bare pid", winOnly(), async () => {
	// Q2a product contract: confirmation NEVER comes from the bare pid. The helper proves file ACL,
	// pipe server identity and hello→ready; stop on Windows never signals (isDaemonProcess is
	// always false there), even for a daemon status has just confirmed as healthy.
	const { root, env } = fakeIsland();
	const child = spawn(process.execPath, [CLI, "run", "--app-owned"], { env, stdio: ["pipe", "pipe", "pipe"] });
	try {
		await waitForSessionPid(root, child.pid);
		const st = cli(root, ["status"], env);
		assert.equal(st.status, 0, st.stderr);
		const out = JSON.parse(st.stdout);
		assert.equal(out.running, true);
		assert.equal(out.pid, child.pid);
		const stop = cli(root, ["stop"], env);
		assert.equal(stop.status, 1, stop.stderr);
		assert.equal(child.exitCode, null, "the daemon was not signalled");
		assert.equal(process.kill(child.pid, 0), true, "the daemon is still alive after the refused stop");
	} finally {
		child.stdin.end();
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
		// The launch ledger is a POSIX 0600 private append-only file. On Windows the daemon cannot
		// make it private, so it refuses to record (fail closed): assert exactly that instead of
		// the 0600 record shape (registered gap: Windows daemon identity via the native helper).
		const ledger = path.join(root, "runtime", "launches.jsonl");
		if (WIN) {
			assert.ok(!fs.existsSync(ledger) || fs.readFileSync(ledger, "utf8").trim() === "", "no ledger record without a private (0600) file");
			// The refused run wrote nothing anywhere else. The incumbent session — planted by this test,
			// token included — is untouched (the ino/pid asserts above), so the only file in runtime that
			// still carries the token is that untouched session; nothing NEW carries it. This is the
			// Windows twin of the POSIX ledger token-hygiene assert below (the ledger records nothing on
			// Windows — registered gap — so the hygiene assert moves to the runtime directory itself).
			assert.deepEqual(fs.readdirSync(path.join(root, "runtime")).filter((n) => n !== "launches.jsonl").sort(), ["session.json"], "the refused run wrote nothing into runtime");
			assert.ok(!`${r.stdout}${r.stderr}`.includes("ttttt"), "the refused run never prints the incumbent token");
		} else {
			const text = fs.readFileSync(ledger, "utf8");
			const last = text.trim().split("\n").map((line) => JSON.parse(line)).at(-1);
			assert.equal(last.outcome, "refused");
			assert.equal(last.reason, "foreign_session");
			assert.equal(last.incumbentPid, bystander.pid);
			assert.equal(typeof last.pid, "number");
			assert.equal(typeof last.procStart, "string");
			assert.equal(fs.statSync(ledger).mode & 0o777, 0o600);
			assert.ok(!text.includes("ttttt"), "the ledger never carries the token");
		}
	} finally {
		await reap(bystander);
	}
});

test("#390 check (5): a restart leaves the old pid dead, a fresh procStart and the old token refused", unixOnly("POSIX SIGTERM stop + /proc procStart identity; Windows twin: native-proof status with stop refusal"), async () => {
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
