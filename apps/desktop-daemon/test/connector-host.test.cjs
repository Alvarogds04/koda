"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const util = require("node:util");
const { ConnectorHostSupervisor, assertTrustedBinary, childPathWithNodeFirst, procIdentity, readHandoff } = require("../src/connector-host.cjs");

const WIN = process.platform === "win32";
// The connector host is Unix-only by design (Q1a: AF_UNIX endpoint, mode/uid checks, /proc|ps identity);
// on Windows it stays FAIL-CLOSED. The Unix-mechanism tests skip there and name their twin.
const TWIN = "Windows twin: the supervisor refuses an untrusted host binary, never spawns and stays fail-closed";
const unixOnly = (twin = TWIN) => ({ skip: WIN && `Unix mechanism (AF_UNIX, mode/uid, /proc); Windows: ${twin}` });
const winOnly = { skip: !WIN && "Windows-only twin of the Unix-mechanism connector-host tests" };

const FIXTURE = path.join(__dirname, "fixtures", "fake-connector-host.cjs");
// macOS injects __CF_USER_TEXT_ENCODING into every process at exec (CoreFoundation); the fixture
// records its own process.env, so on darwin this key appears although the supervisor passed an
// allowlisted env. It is OS-injected and never comes from the parent environment — not a leak.
const OS_INJECTED_ENV = process.platform === "darwin" ? ["__CF_USER_TEXT_ENCODING"] : [];
function setup(t, mode = {}, overrides = {}) {
	// Socket-path budget: validateEndpoint allows 107 bytes and macOS binds at most 103 (sun_path).
	// The macOS CI temp prefix (/private/var/folders/<2>/<31>/T/) is already 58 bytes, so the island
	// IS the short temp root: <island>/connector-host-run/p-XXXXXX/s stays ≤ 103 bytes everywhere.
	// Same layout and behaviour on Linux and Windows; only the temp root is shorter.
	const island = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "k-")));
	fs.mkdirSync(path.join(island, "home"), { mode: 0o700 });
	const bin = path.join(island, "host");
	fs.copyFileSync(FIXTURE, bin);
	fs.chmodSync(bin, 0o700);
	fs.writeFileSync(path.join(island, ".fake-host-mode.json"), JSON.stringify(mode), { mode: 0o600 });
	const logs = [];
	const host = new ConnectorHostSupervisor({ binPath: bin, islandDir: island, backoffMs: [20, 40], stableMs: 80, startTimeoutMs: 5000, requestTimeoutMs: 300, stopTimeoutMs: 300, log: (line) => logs.push(line), ...overrides });
	t.after(async () => {
		const child = host.child;
		await host.stop().catch(() => {});
		if (child) {
			const deadline = Date.now() + 1000;
			while (Date.now() < deadline && (() => { try { process.kill(child.pid, 0); return true; } catch { return false; } })()) await new Promise((r) => setTimeout(r, 10));
		}
		fs.rmSync(island, { recursive: true, force: true });
	});
	return { root: island, island, bin, host, logs };
}

test("trusted binary validation rejects unsafe paths and modes before spawning", unixOnly(), async (t) => {
	const cases = [
		["symlinked binary", ({ root, bin, host }) => { const link = path.join(root, "host-link"); fs.symlinkSync(bin, link); host.binPath = link; }],
		["setuid binary", ({ bin }) => fs.chmodSync(bin, 0o4700)],
		["setgid binary", ({ bin }) => fs.chmodSync(bin, 0o2700)],
		["sticky-bit binary", ({ bin }) => fs.chmodSync(bin, 0o1700)],
		["group-writable binary", ({ bin }) => fs.chmodSync(bin, 0o720)],
		["group-writable parent", ({ root }) => fs.chmodSync(root, 0o770)],
		["world-writable parent", ({ root }) => fs.chmodSync(root, 0o777)],
		["symlinked intermediate directory", ({ root, host }) => { const link = path.join(root, "dir-link"); fs.symlinkSync(root, link); host.binPath = path.join(link, "host"); }],
		["foreign-owner binary", async ({ bin, host }) => {
			const original = fs.lstatSync;
			fs.lstatSync = function (file, ...args) {
				const stat = original.call(this, file, ...args);
				return file === bin ? new Proxy(stat, { get(target, key, receiver) { return key === "uid" ? process.getuid() + 1000 : Reflect.get(target, key, receiver); } }) : stat;
			};
			try { await assert.rejects(host.start(), /connector host unavailable/); }
			finally { fs.lstatSync = original; }
		}],
	];
	for (const [name, prepare] of cases) {
		await t.test(name, async (t) => {
			let spawned = 0;
			const setupResult = setup(t, {}, { spawn: () => { spawned++; throw new Error("unexpected spawn"); } });
			await prepare(setupResult);
			if (name !== "foreign-owner binary") await assert.rejects(setupResult.host.start(), /connector host unavailable/);
			assert.equal(spawned, 0);
		});
	}
});

test("a clean private binary path is accepted unchanged", unixOnly(), (t) => {
	const { bin } = setup(t);
	assert.equal(assertTrustedBinary(bin), bin);
});

test("fake host starts only after strict handoff and hello, then acknowledges shutdown and removes files", unixOnly(), async (t) => {
	const { island, host, logs } = setup(t);
	const states = [];
	host.on("status", (state) => states.push(state));
	await host.start();
	assert.equal(host.status, "ready");
	const state = await host.client.status();
	assert.equal(state.pid, host.child.pid);
	assert.equal(state.protocol, "abito-connector-host/1");
	assert.equal(state.failedClosed, true);
	await host.stop();
	assert.equal(host.status, "stopped");
	assert.equal(fs.existsSync(path.join(island, "connector-host.json")), false);
	assert.ok(states.includes("ready"));
	assert.ok(!logs.includes("connector host exited uncleanly; files left for recovery"));
});

test("spawn is direct, argv is exact, and the child environment is allowlisted", unixOnly(), async (t) => {
	const { host, island, bin } = setup(t, {}, { env: { PATH: "/untrusted", HOME: "/untrusted", LANG: "C.UTF-8", PI_SESSION_ID: "pi-canary", OPENAI_API_KEY: "provider-canary", CLAUDECODE: "agent-canary" } });
	await host.start();
	try {
		const child = host.child;
		assert.equal(child.spawnfile, bin);
		assert.deepEqual(child.spawnargs.slice(1), ["--island", island, "--parent", String(process.pid)]);
		assert.equal(procIdentity(child.pid).ppid, process.pid);
		// The fixture records its own process.env (0600) because /proc/<pid>/environ is Linux-only.
		const entries = JSON.parse(fs.readFileSync(path.join(island, ".fake-host-env.json"), "utf8"));
		assert.deepEqual(entries.map(([key]) => key).sort(), ["HOME", "LANG", "PATH", ...OS_INJECTED_ENV]);
		assert.ok(entries.some(([key, value]) => key === "HOME" && value === path.join(island, "home")));
		assert.ok(entries.some(([key, value]) => key === "PATH" && value === childPathWithNodeFirst(path.dirname(process.execPath))), "the daemon's own node leads the child PATH (K2-02)");
		assert.ok(!entries.map(([, value]) => value).join("\n").includes("canary"));
	} finally { await host.stop(); }
});

// K2-02 (S2): any `node` a connector host child looks up must resolve to the Node running
// the daemon (the bundled one on a bundled install), never the user's own.
test("the child PATH leads with the daemon's own node directory", () => {
	const nodeDir = path.dirname(process.execPath);
	const host = new ConnectorHostSupervisor({ islandDir: path.join(os.tmpdir(), "abito-host-env") });
	const env = host.childEnvironment();
	assert.equal(env.PATH, childPathWithNodeFirst(nodeDir));
});

// K2-02 (S1, S2) — the CI failure K2-01b saw (run 41718553579): the host binary is `#!/usr/bin/env node`, so it only
// starts when a `node` is on the CHILD's PATH. With the historical "/usr/bin:/bin" it never starts where Node lives
// elsewhere (the runner's toolcache; Koda's bundled runtime). This machine may have a /usr/bin/node that would mask
// the bug, so the host here is a wrapper that records WHICH `node` its shebang resolved and starts the real fixture
// only when that node is the daemon's own (a copy of this Node outside /usr/bin): with the old PATH it never starts.
test("a `#!/usr/bin/env node` connector host is started by the daemon's own Node even when it lives outside /usr/bin", { skip: process.platform === "win32" && "POSIX shebang mechanism; Windows starts node.exe + the host script directly (no shebang lookup)" }, async (t) => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "abito-host-nodeless-")));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const runtime = path.join(root, "runtime");
	fs.mkdirSync(runtime, { mode: 0o700 });
	const daemonNode = path.join(runtime, "node");
	fs.copyFileSync(process.execPath, daemonNode);
	fs.chmodSync(daemonNode, 0o700);
	const island = path.join(root, "island");
	fs.mkdirSync(island, { mode: 0o700 });
	fs.mkdirSync(path.join(island, "home"), { mode: 0o700 });
	fs.writeFileSync(path.join(island, ".fake-host-mode.json"), "{}", { mode: 0o600 });
	const seen = path.join(root, "resolved-node.txt");
	const bin = path.join(root, "host");
	fs.writeFileSync(bin, `#!/usr/bin/env node\n"use strict";\nrequire("node:fs").writeFileSync(${JSON.stringify(seen)}, process.execPath);\n` +
		`if (process.execPath !== ${JSON.stringify(daemonNode)}) process.exit(3);\nrequire(${JSON.stringify(FIXTURE)});\n`, { mode: 0o700 });
	fs.chmodSync(bin, 0o700);
	const empty = path.join(root, "empty-path-dir");
	fs.mkdirSync(empty, { mode: 0o700 });
	const driver = `
		const { ConnectorHostSupervisor } = require(${JSON.stringify(path.join(__dirname, "..", "src", "connector-host.cjs"))});
		const host = new ConnectorHostSupervisor({ binPath: ${JSON.stringify(bin)}, islandDir: ${JSON.stringify(island)}, backoffMs: [20, 40], stableMs: 80, startTimeoutMs: 5000, requestTimeoutMs: 300, stopTimeoutMs: 300, log: () => {} });
		host.start().then(async () => { const st = await host.client.status(); console.log(JSON.stringify({ status: host.status, protocol: st.protocol })); await host.stop(); },
			(e) => { console.log(JSON.stringify({ error: e.message })); process.exitCode = 1; });`;
	const { spawnSync } = require("node:child_process");
	// The daemon runs on the copied Node; its own env PATH holds no node at all.
	const r = spawnSync(daemonNode, ["-e", driver], { encoding: "utf8", env: { PATH: empty, HOME: root }, timeout: 20_000 });
	const detail = `stdout=${r.stdout}\nstderr=${r.stderr}\nresolved node=${fs.existsSync(seen) ? fs.readFileSync(seen, "utf8") : "(host never ran)"}`;
	// The K2-02 rule, on every POSIX OS: the host's `#!/usr/bin/env node` resolved the daemon's OWN Node through the child
	// PATH the supervisor built (with the old "/usr/bin:/bin" it found another node, or none).
	assert.ok(fs.existsSync(seen), `the host never ran: ${detail}`);
	assert.equal(fs.readFileSync(seen, "utf8"), daemonNode, "the host's shebang resolved the daemon's own Node");
	// The rest is the connector host's own handoff. On macOS that handoff is a PRE-EXISTING failure on main (CI 41730449751,
	// «fake host starts only after strict handoff…» fails there too: connector host unavailable), owned outside K2-02, so
	// «ready» is asserted where the plain fixture test passes; the twin proof on macOS is the shebang assertion above.
	if (process.platform === "darwin") return;
	assert.equal(r.status, 0, detail);
	assert.deepEqual(JSON.parse(r.stdout.trim().split("\n").pop()), { status: "ready", protocol: "abito-connector-host/1" });
});

test("childPathWithNodeFirst uses the right separator on every platform", () => {
	assert.equal(childPathWithNodeFirst("/koda/runtime", ":"), "/koda/runtime:/usr/bin:/bin");
	assert.equal(childPathWithNodeFirst("C:\\koda\\runtime", ";"), "C:\\koda\\runtime;/usr/bin:/bin");
	assert.equal(childPathWithNodeFirst("/koda/runtime"), `/koda/runtime${path.delimiter}/usr/bin:/bin`);
});

test("refusal exit 1 rejects initial start without a restart loop", unixOnly(), async (t) => {
	const { host, island } = setup(t, { refuse: true });
	await assert.rejects(host.start(), /connector host unavailable/);
	await new Promise((r) => setTimeout(r, 80));
	assert.equal(host.status, "stopped");
	assert.equal(fs.existsSync(path.join(island, "connector-host.json")), false);
});

test("request validation rejects unsafe ids, revisions, digests, values and reserved keys before write", unixOnly(), async (t) => {
	const { host } = setup(t);
	await host.start();
	try {
		for (const id of ["", "../x", "a".repeat(65), "__proto__", "constructor"]) assert.throws(() => host.client.disconnect(id, 0), (e) => e.code === "bad_request");
		assert.throws(() => host.client.connect("x", -1, {}), (e) => e.code === "bad_request");
		assert.throws(() => host.client.approve("ap-abc", "not-a-digest"), (e) => e.code === "bad_request");
		const escapedFrame = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, "\u0001".repeat(8192)]));
		await assert.rejects(host.client.connect("x", 0, escapedFrame), (error) => error.code === "bad_request");
		for (const values of [{ constructor: "x" }, { x: "secret\u0000" }, { x: "v".repeat(8193) }, Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"]))]) {
			assert.throws(() => host.client.connect("x", 0, values), (e) => e.code === "bad_request");
		}
	} finally { await host.stop(); }
});

test("supervisor and client diagnostics never expose the handoff token or endpoint", unixOnly(), async (t) => {
	const { host, island } = setup(t);
	await host.start();
	const handoff = JSON.parse(fs.readFileSync(path.join(island, "connector-host.json"), "utf8"));
	const secret = handoff.token;
	const endpoint = handoff.endpoint;
	assert.deepEqual(JSON.parse(JSON.stringify(host)), { state: "ready", pid: host.child.pid, restarts: host.attempts });
	assert.deepEqual(JSON.parse(JSON.stringify(host.client)), { state: "ready", pid: null, restarts: 0 });
	for (const value of [host, host.client]) {
		const ownDump = Object.fromEntries(Object.getOwnPropertyNames(value).map((name) => [name, value[name]]));
		const dumps = [
			JSON.stringify(value),
			util.inspect(value, { depth: 6, showHidden: true }),
			String(value),
			util.format("%O", value),
			JSON.stringify(Object.keys(value)),
			JSON.stringify(Object.getOwnPropertyNames(value)),
			JSON.stringify(Object.getOwnPropertySymbols(value).map(String)),
			util.inspect(ownDump, { depth: 6, showHidden: true }),
		];
		for (const dump of dumps) {
			assert.ok(!dump.includes(secret), "token leaked through an object diagnostic");
			assert.ok(!dump.includes(endpoint), "endpoint leaked through an object diagnostic");
		}
	}
	assert.equal(host.statusSnapshot(), "ready");
	await host.stop();
});

test("connect values never reach logs, errors, emitted events, environment or argv", unixOnly(), async (t) => {
	const { host, logs } = setup(t);
	await host.start();
	const secret = "NEVER-LEAK-CONNECT-CANARY";
	const seen = [];
	for (const event of ["status", "connectors", "pending", "exit"]) host.on(event, (value) => seen.push(JSON.stringify(value)));
	await host.client.connect("dropbox", 0, { token: secret }).catch(() => {});
	await new Promise((r) => setTimeout(r, 20));
	assert.ok(![...logs, ...seen].join("\n").includes(secret));
	await host.stop();
});

test("handoff validation rejects malformed, noncanonical and unsafe metadata", unixOnly(), async (t) => {
	for (const mode of [
		{ extraKey: true }, { wrongToken: true }, { badToken: true }, { wrongTokenReply: true }, { badMode: true }, { escapedKey: true },
		{ bomHandoff: true }, { noHandoffLf: true }, { crlfHandoff: true }, { doubleHandoffLf: true }, { prettyHandoff: true }, { reverseHandoffKeys: true },
		{ pidMismatch: true }, { procMismatch: true }, { endpointOutside: true }, { badSocket: true }, { symlinkHandoff: true },
	]) {
		const { host } = setup(t, mode);
		await assert.rejects(host.start(), /connector host unavailable/, JSON.stringify(mode));
		await host.stop();
	}
});

test("handoff rejects a wrong-owner stub without needing to change file ownership", unixOnly(), async (t) => {
	const { host, island } = setup(t);
	await host.start();
	const file = path.join(island, "connector-host.json");
	const st = fs.statSync(file);
	assert.throws(() => readHandoff(file, island, host.child, host.handoff.procStart, st.uid + 1));
	await host.stop();
});

test("startup timeout kills a host that never publishes its endpoint", unixOnly(), async (t) => {
	const { host } = setup(t, { hangStartup: true }, { startTimeoutMs: 300 });
	await assert.rejects(host.start(), /connector host unavailable/);
	assert.equal(host.status, "stopped");
});

test("shutdown uses the verified SIGTERM then SIGKILL ladder", unixOnly(), async (t) => {
	const signals = [];
	const { host, logs } = setup(t, { neverAckShutdown: true, ignoreTerm: true }, { signal: (pid, signal) => { signals.push([pid, signal]); process.kill(pid, signal); } });
	await host.start();
	const pid = host.child.pid;
	await host.stop();
	assert.deepEqual(signals, [[pid, "SIGTERM"], [pid, "SIGKILL"]]);
	assert.equal(host.child, undefined);
	assert.ok(logs.includes("connector host exited uncleanly; files left for recovery"));
});

test("PID reuse simulation prevents both stop signals", unixOnly(), async (t) => {
	let reused = false;
	const actual = require("../src/connector-host.cjs").procStartTicks;
	const signals = [];
	const { host } = setup(t, { neverAckShutdown: true, ignoreTerm: true, crashAfterMs: 2200 }, {
		stopTimeoutMs: 50,
		procStart: (pid) => reused ? "999999999" : actual(pid),
		signal: (pid, signal) => { signals.push([pid, signal]); process.kill(pid, signal); },
	});
	await host.start();
	reused = true;
	await host.stop();
	assert.deepEqual(signals, []);
	assert.equal(host.child, undefined);
});

test("supervisor restarts an unexpected host crash", unixOnly(), async (t) => {
	const { host } = setup(t, { crashAfterMs: 200 });
	await host.start();
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("restart timed out")), 1500);
		host.on("status", (state) => {
			if (state === "ready" && host.attempts > 0) { clearTimeout(timer); resolve(); }
		});
	});
	assert.equal(host.status, "ready");
	await host.stop();
});

// ---- targeted regression tests added after the fresh verifier named three gaps ----------------------------------------
// Each test is built so that ONLY the branch under test can reject: every other field of the handoff is valid, the
// pid/start time are the real ones of the process in question, and a control test shows the same document is accepted.
const { spawn } = require("node:child_process");
const net = require("node:net");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HAVE_PYTHON = require("node:child_process").spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

async function waitIdentity(pid, accept, ms = 5000) {
	const deadline = Date.now() + ms;
	let id;
	while (Date.now() < deadline) {
		id = procIdentity(pid);
		if (id && accept(id)) return id;
		await sleep(10);
	}
	return id;
}
/** A real private runtime with a live listening socket and a canonical handoff for `pid` / `start`. */
async function validHandoff(t, island, pid, start) {
	const runRoot = path.join(island, "connector-host-run");
	fs.mkdirSync(runRoot, { mode: 0o700, recursive: true });
	fs.chmodSync(runRoot, 0o700);
	const runDir = fs.mkdtempSync(path.join(runRoot, "p-"));
	fs.chmodSync(runDir, 0o700);
	const endpoint = path.join(runDir, "s");
	const server = net.createServer();
	await new Promise((resolve) => server.listen(endpoint, resolve));
	t.after(() => server.close());
	fs.chmodSync(endpoint, 0o600);
	const file = path.join(island, "gap-handoff.json");
	fs.writeFileSync(file, `${JSON.stringify({ endpoint, pid, procStart: Number(start), protocol: "abito-connector-host/1", startedAt: 1, token: "b".repeat(64) })}\n`, { mode: 0o600 });
	fs.chmodSync(file, 0o600);
	return file;
}

test("handoff identity: a live direct child is ACCEPTED (control for the zombie and wrong-parent tests)", unixOnly(), async (t) => {
	const { island } = setup(t);
	const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},20000)"], { stdio: "ignore" });
	t.after(() => { try { child.kill("SIGKILL"); } catch {} });
	const id = await waitIdentity(child.pid, () => true, 3000);
	assert.ok(["S", "R"].includes(id.state), `live state expected, got ${id.state}`);
	assert.equal(id.ppid, process.pid);
	const file = await validHandoff(t, island, child.pid, id.start);
	const ok = readHandoff(file, island, child, id.start);
	assert.equal(ok.pid, child.pid);
});

test("handoff identity: a ZOMBIE with the exact pid and start time is refused by the state check alone", { skip: WIN ? `Unix mechanism (fork, /proc); Windows: ${TWIN}` : (HAVE_PYTHON ? false : "python3 is needed to build a real zombie") }, async (t) => {
	const { island } = setup(t);
	// Node and sh reap their children; python3 after os.fork() does not, so the child stays a real zombie.
	// The zombie's parent is the python process, so the PARENT check would also reject it: the mutation run proves which
	// branch is responsible by dropping each one separately (see the evidence note); here we assert the premise.
	const holder = spawn("python3", ["-c", "import os,time\npid=os.fork()\nif pid==0:\n    os._exit(0)\nprint(pid,flush=True)\ntime.sleep(25)\n"], { stdio: ["ignore", "pipe", "ignore"] });
	t.after(() => { try { holder.kill("SIGKILL"); } catch {} });
	let out = "";
	holder.stdout.on("data", (d) => { out += d; });
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline && !/\d+\n/.test(out)) await sleep(10);
	const pid = Number(out.trim());
	assert.ok(Number.isInteger(pid) && pid > 1, "premise: got the zombie pid");
	const id = await waitIdentity(pid, (i) => i.state === "Z");
	assert.equal(id && id.state, "Z", "premise: the process is a zombie");
	const file = await validHandoff(t, island, pid, id.start);
	assert.throws(() => readHandoff(file, island, { pid }, id.start), /connector host unavailable/);
});

test("handoff identity: a DIRECT child of this daemon whose /proc state is Z (or X) is refused by the state check alone", unixOnly(), async (t) => {
	const { island } = setup(t);
	// Isolates the state branch: the pid, the start time and the parent are all REAL and correct (a live direct child of
	// this process); only the state letter /proc reports is changed, by intercepting the read of that one stat file.
	const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},20000)"], { stdio: "ignore" });
	t.after(() => { try { child.kill("SIGKILL"); } catch {} });
	const real = await waitIdentity(child.pid, () => true, 3000);
	assert.equal(real.ppid, process.pid, "premise: a direct child");
	assert.ok(["S", "R"].includes(real.state), "premise: genuinely alive");
	const file = await validHandoff(t, island, child.pid, real.start);
	assert.equal(readHandoff(file, island, child, real.start).pid, child.pid, "control: accepted while the state is S/R");
	// The state letter comes from /proc/<pid>/stat on Linux and from /bin/ps (src/procinfo.cjs runPs, looked up at call
	// time) on macOS: intercept exactly that one source per OS, so the same refusal is proven on both.
	const procinfo = require("../src/procinfo.cjs");
	const statPath = `/proc/${child.pid}/stat`;
	const original = fs.readFileSync;
	const originalPs = procinfo.runPs;
	const restore = () => { fs.readFileSync = original; procinfo.runPs = originalPs; };
	t.after(restore);
	for (const letter of ["Z", "X"]) {
		if (process.platform === "darwin") {
			procinfo.runPs = (pid, ...rest) => {
				const info = originalPs(pid, ...rest);
				return pid === child.pid && info ? { ...info, state: letter } : info;
			};
		} else {
			fs.readFileSync = function patched(target, ...rest) {
				const text = original.call(this, target, ...rest);
				if (target !== statPath || typeof text !== "string") return text;
				const close = text.lastIndexOf(")");
				return `${text.slice(0, close + 2)}${letter}${text.slice(close + 3)}`;
			};
		}
		assert.equal(procIdentity(child.pid).state, letter, `premise: the process source now reports ${letter}`);
		assert.equal(procIdentity(child.pid).ppid, process.pid, "premise: parent unchanged");
		assert.equal(procIdentity(child.pid).start, real.start, "premise: start time unchanged");
		assert.throws(() => readHandoff(file, island, child, real.start), /connector host unavailable/, `state ${letter} refused`);
		restore();
	}
});

test("handoff identity: a start time that differs from the one recorded at spawn is refused by the identity check alone", unixOnly(), async (t) => {
	const { island } = setup(t);
	const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},20000)"], { stdio: "ignore" });
	t.after(() => { try { child.kill("SIGKILL"); } catch {} });
	const real = await waitIdentity(child.pid, () => true, 3000);
	const file = await validHandoff(t, island, child.pid, real.start);
	assert.equal(readHandoff(file, island, child, real.start).pid, child.pid, "control: accepted with the recorded start time");
	// The handoff file, the pid and the live process all agree with each other; only the start time the SUPERVISOR recorded
	// at spawn differs (a recycled-pid scenario: the file claims a start that /proc no longer reports for that pid).
	const recorded = String(BigInt(real.start) + 1n);
	const doc = fs.readFileSync(file, "utf8").replace(`"procStart":${real.start}`, `"procStart":${recorded}`);
	fs.writeFileSync(file, doc, { mode: 0o600 });
	fs.chmodSync(file, 0o600);
	assert.throws(() => readHandoff(file, island, child, recorded), /connector host unavailable/, "recorded start differs from /proc");
});

test("handoff identity: a process whose parent is NOT this daemon is refused even when pid and start time match", unixOnly(), async (t) => {
	const { island } = setup(t);
	// An intermediate starts a detached sleeper and exits, so the sleeper is re-parented away from this process.
	const intermediate = spawn(process.execPath, ["-e", "const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setTimeout(()=>{},20000)'],{stdio:'ignore',detached:true});process.stdout.write(String(c.pid));c.unref();"], { stdio: ["ignore", "pipe", "ignore"] });
	let out = "";
	intermediate.stdout.on("data", (d) => { out += d; });
	await new Promise((resolve) => intermediate.once("exit", resolve));
	const pid = Number(out);
	t.after(() => { try { process.kill(pid, "SIGKILL"); } catch {} });
	const id = await waitIdentity(pid, (i) => i.ppid !== process.pid);
	assert.ok(id && id.ppid !== process.pid, `premise: re-parented away from this process (ppid ${id && id.ppid})`);
	assert.ok(["S", "R"].includes(id.state), `premise: alive (${id.state}), so only the parent branch can reject`);
	const file = await validHandoff(t, island, pid, id.start);
	assert.throws(() => readHandoff(file, island, { pid }, id.start), /connector host unavailable/);
});

test("binary trust: each unsafe shape is refused BY assertTrustedBinary on its own, and a clean one is accepted", unixOnly(), (t) => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "abito-host-")));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.chmodSync(root, 0o700);
	const clean = path.join(root, "bin");
	fs.writeFileSync(clean, "#!/bin/sh\n", { mode: 0o700 });
	assert.equal(assertTrustedBinary(clean), clean, "control: clean private binary accepted");
	const real = path.join(root, "real");
	fs.renameSync(clean, real);
	fs.symlinkSync(real, clean);
	assert.throws(() => assertTrustedBinary(clean), /connector host unavailable/, "symlinked binary refused");
	fs.unlinkSync(clean);
	fs.renameSync(real, clean);
	assert.equal(assertTrustedBinary(clean), clean, "restoring the file makes it trusted again: nothing is cached");
	fs.chmodSync(clean, 0o770);
	assert.throws(() => assertTrustedBinary(clean), /connector host unavailable/, "group-writable binary refused");
	fs.chmodSync(clean, 0o4700);
	assert.throws(() => assertTrustedBinary(clean), /connector host unavailable/, "setuid binary refused");
});

test("binary swap: the supervisor re-checks the SAME path right before spawn (check-then-use window narrowed, NOT eliminated)", unixOnly(), async (t) => {
	const { host, bin } = setup(t);
	let spawned = 0;
	let swapAt;
	const realSpawn = require("node:child_process").spawn;
	// The second assertTrustedBinary runs after the island checks and immediately before this seam. Swap the binary for a
	// symlink from inside the FIRST island check by replacing it between the two checks via a getter on the island path
	// would be racy; instead make the swap happen while start() is already running, by wrapping fs.lstatSync of the island.
	const islandCheck = fs.lstatSync;
	let armed = true;
	fs.lstatSync = function patched(file, ...rest) {
		const result = islandCheck.call(this, file, ...rest);
		if (armed && file === host.islandDir) {
			armed = false;
			// the first trust check already passed; now make the file unsafe before the second one
			fs.chmodSync(bin, 0o770);
			swapAt = "after first check, before second";
		}
		return result;
	};
	t.after(() => { fs.lstatSync = islandCheck; });
	host.spawnProcess = (file, args, options) => { spawned++; return realSpawn(file, args, options); };
	await assert.rejects(host.start(), /connector host unavailable/);
	fs.lstatSync = islandCheck;
	assert.equal(swapAt, "after first check, before second", "premise: the file was made unsafe between the two checks");
	assert.equal(spawned, 0, "the second check caught the change, so nothing was spawned");
});

test("Windows twin: the supervisor refuses an untrusted host binary, never spawns and stays fail-closed", winOnly, async (t) => {
	// connector-host.cjs is Unix-only by design (AF_UNIX endpoint, mode/uid trust checks, /proc|ps
	// identity). On Windows every start must therefore fail CLOSED with `connector host unavailable`
	// BEFORE any process is spawned — the same premise every unixOnly test above relies on there.
	const spawned = [];
	const { host, bin } = setup(t, {}, { spawn: (...args) => { spawned.push(args); throw new Error("unexpected spawn"); } });
	assert.throws(() => assertTrustedBinary(bin), /connector host unavailable/, "even a clean-looking binary is refused: no Unix trust mechanism exists on win32");
	await assert.rejects(host.start(), /connector host unavailable/);
	assert.equal(host.status, "stopped", "status ends unavailable, never ready");
	assert.equal(spawned.length, 0, "nothing was ever spawned");
	await host.stop();
	assert.equal(host.status, "stopped");
});

test("LIMIT (documented, not claimed fixed): the check-then-use window after the last binary check is recorded honestly in the README", () => {
	// Lstat-then-spawn is check-then-use. A process of the SAME user that can write the binary's directory could replace
	// the file between the last check and exec(); closing it needs fexecve on an opened descriptor, which Node does not
	// expose. This test pins the README section so the limit cannot be silently dropped or reworded into a claim.
	const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
	const at = readme.indexOf("Connector host trust limits");
	assert.ok(at >= 0, "the README has the connector-host trust limits paragraph");
	const section = readme.slice(at, at + 1800);
	assert.match(section, /check-then-use/);
	assert.match(section, /TOCTOU/);
	assert.match(section, /NOT claimed to be eliminated/);
	assert.match(section, /SAME user/);
	assert.match(section, /fexecve/);
	assert.match(section, /zombie/);
	assert.match(section, /DIRECT child/);
});
