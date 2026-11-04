"use strict";

// K2-02 S3: «Dado que uso Koda, cuando abro el asistente, entonces Koda no se conecta a pi.dev.»
//
// The REAL Pi is launched EXACTLY the way Koda launches it: the daemon's AgentEngine
// (src/runtime.cjs) spawning Node with the package's own CLI JS — the same argv shape
// runtime.cjs builds on Windows and the same entry the POSIX `pi` shim runs — with the
// environment `isolatedEnv` builds (private HOME, private PI_CODING_AGENT_DIR and the three
// offline switches PI_OFFLINE=1, PI_SKIP_VERSION_CHECK=1, PI_TELEMETRY=0). A test-only
// preload (--require, the only injection) records EVERY outbound network attempt the child
// makes (dns.lookup, dns.resolve*, net.connect, net.createConnection, tls.connect, fetch)
// while Pi starts and serves a model-free RPC exchange (get_state).
//
// Assert: no attempt reaches any pi.dev host — ideally no outbound attempt at all.
//
// RED: with ABITO_PI_OFFLINE_RED=1 the same spawn is run with the three offline switches
// REMOVED from the env; the same assertion is then expected to FAIL and name the pi.dev
// attempt (run once by hand for evidence; never part of the default suite).
//
// Skipped (never silently passed) when no real Pi is available: PI_CODING_AGENT_ROOT, then
// the installed `pi` on PATH (pi-loader convention). CI installs Pi on all 3 OS, so the test
// runs on Linux, macOS and Windows there; with ABITO_REQUIRE_PI=1 absence FAILS instead.
// Only private temp dirs are used: the island HOME/agent dir is isolatedEnv's own; the
// user's ~/.pi and real config are never read or written.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { AgentEngine } = require("../src/runtime.cjs");
const { ensureIsland, isolatedEnv } = require("../src/isolation.cjs");

const BOOT_TIMEOUT_MS = 90_000;

function findPiRoot() {
	if (process.env.PI_CODING_AGENT_ROOT) return process.env.PI_CODING_AGENT_ROOT;
	// pi-loader convention: resolve the installed `pi` launcher back to its package directory.
	const marker = "/@earendil-works/pi-coding-agent/";
	for (const dir of (process.env.PATH || "").split(path.delimiter)) {
		try {
			const real = fs.realpathSync(path.join(dir, "pi"));
			const i = real.indexOf(marker);
			if (i >= 0) return real.slice(0, i + marker.length - 1);
		} catch {
			// read-only discovery: keep looking
		}
	}
	return undefined;
}

const piRoot = findPiRoot();
// No real Pi: a dev machine reports the real-Pi tests as SKIPPED with this reason (never a bare pass); with
// ABITO_REQUIRE_PI=1 (every CI desktop-daemon job) the run FAILS instead: the S3 proof may never be silently absent.
const PI_MISSING = "Installed Pi not found; set PI_CODING_AGENT_ROOT";
if (!piRoot && process.env.ABITO_REQUIRE_PI === "1") {
	test("a real Pi is required here (ABITO_REQUIRE_PI=1)", () => {
		assert.fail("ABITO_REQUIRE_PI=1 but no installed Pi was found (set PI_CODING_AGENT_ROOT or put `pi` on PATH)");
	});
}
const piSkip = piRoot ? undefined : PI_MISSING;

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The test-only network recorder, injected with --require BEFORE Pi's code runs. */
function writePreload(dir) {
	const preload = path.join(dir, "net-recorder.cjs");
	fs.writeFileSync(
		preload,
		`
try {
	const fs = require("node:fs");
	const dns = require("node:dns");
	const net = require("node:net");
	const tls = require("node:tls");
	const file = process.env.ABITO_NET_LOG;
	const record = (via, host, port) => {
		if (!file || !host) return;
		const h = String(host);
		if (!h || h.includes("/") || h.startsWith("/")) return; // unix sockets are not network attempts
		try { fs.appendFileSync(file, JSON.stringify({ via, host: h, port: port ?? null }) + "\\n"); } catch {}
	};
	const hostOf = (a) => (typeof a === "string" ? a : a && (a.host ?? a.hostname));
	const portOf = (a, b) => (typeof a === "object" && a ? (a.port ?? a.defaultPort) : b);
	const origLookup = dns.lookup;
	dns.lookup = function (host, a, b) {
		record("dns.lookup", host);
		return arguments.length === 2 ? origLookup.call(dns, host, a) : origLookup.call(dns, host, a, b);
	};
	for (const name of ["resolve4", "resolve6", "resolveSrv", "resolveTxt", "resolveNs", "resolveCname"]) {
		const orig = dns[name];
		if (orig) dns[name] = function (host, ...rest) { record("dns." + name, host); return orig.call(dns, host, ...rest); };
	}
	for (const name of ["connect", "createConnection"]) {
		const orig = net[name];
		net[name] = function (...args) {
			record("net." + name, hostOf(args[0]), portOf(args[0], args[1]));
			return orig.apply(net, args);
		};
	}
	{
		const orig = tls.connect;
		tls.connect = function (...args) {
			record("tls.connect", hostOf(args[0]), portOf(args[0], args[1]));
			return orig.apply(tls, args);
		};
	}
	if (globalThis.fetch) {
		const origFetch = globalThis.fetch;
		globalThis.fetch = function (input, init) {
			try {
				const url = typeof input === "string" ? input : input && input.url;
				if (url) record("fetch", new URL(url).host);
			} catch {}
			return origFetch.call(globalThis, input, init);
		};
	}
} catch {}
`,
	);
	return preload;
}

function readAttempts(file) {
	try {
		return fs
			.readFileSync(file, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

function makeTemp(tag) {
	const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `abito-pi-offline-${tag}-`)));
	process.on("exit", () => {
		try {
			fs.rmSync(base, { recursive: true, force: true });
		} catch {}
	});
	return base;
}

if (piSkip) {
	// Report BOTH real-Pi proofs as skipped (with the reason) instead of declaring nothing.
	test("real pi: a Koda launch of Pi reaches no pi.dev host (PI_OFFLINE/PI_SKIP_VERSION_CHECK/PI_TELEMETRY kept)", { skip: piSkip }, () => {});
	test("the env Koda builds carries exactly the three offline switches", { skip: piSkip }, () => {});
} else {
	const cli = path.join(piRoot, "dist", "bundle", "cli.js");
	if (!fs.existsSync(cli)) throw new Error(`PI_CODING_AGENT_ROOT has no dist/bundle/cli.js: ${piRoot}`);

	test("real pi: a Koda launch of Pi reaches no pi.dev host (PI_OFFLINE/PI_SKIP_VERSION_CHECK/PI_TELEMETRY kept)", { skip: piSkip, timeout: BOOT_TIMEOUT_MS }, async () => {
		const base = makeTemp("green");
		const netLog = path.join(base, "net-attempts.jsonl");
		const preload = writePreload(base);
		const engine = new AgentEngine({
			command: process.execPath,
			// Exactly the daemon's argv shape for the real package CLI, plus the test-only recorder.
			commandArgs: ["--require", preload, cli],
			root: path.join(base, "island"),
			env: { PATH: process.env.PATH, HOME: base },
			envOverrides: { ABITO_NET_LOG: netLog },
			backoffMs: [10_000, 10_000],
			stableMs: 60_000,
			startTimeoutMs: 60_000,
			requestTimeoutMs: 10_000,
			switchTimeoutMs: 10_000,
			stopTimeoutMs: 2_000,
			log: () => {},
		});
		try {
			await engine.start();
			assert.equal(engine.status, "ready");
			// A model-free RPC exchange, exactly what the daemon exchanges on its own.
			const response = await engine.request({ type: "get_state" });
			assert.equal(response.success, true);
			assert.equal(response.command, "get_state");
			await sleep(4_000); // a window for anything Pi does after the first exchange
		} finally {
			await engine.stop();
		}
		const attempts = readAttempts(netLog);
		const piDev = attempts.filter((a) => /(^|\.)pi\.dev$/i.test(a.host) || a.host.toLowerCase().includes("pi.dev"));
		assert.deepEqual(
			piDev,
			[],
			`Koda's launch of Pi contacted pi.dev: ${JSON.stringify(piDev)} (all attempts: ${JSON.stringify(attempts)})`,
		);
		// Ideally there is NO outbound attempt at all while Pi boots and serves get_state.
		assert.deepEqual(
			attempts,
			[],
			`Koda's launch of Pi made outbound network attempts: ${JSON.stringify(attempts)}`,
		);
	});

	test("the env Koda builds carries exactly the three offline switches", { skip: piSkip }, () => {
		const base = makeTemp("env");
		const island = ensureIsland(path.join(base, "island"));
		const env = isolatedEnv({ PATH: process.env.PATH, HOME: base }, island);
		assert.equal(env.PI_OFFLINE, "1");
		assert.equal(env.PI_SKIP_VERSION_CHECK, "1");
		assert.equal(env.PI_TELEMETRY, "0");
		assert.equal(env.PI_CODING_AGENT_DIR, island.agentDir);
		assert.equal(env.HOME, island.home);
		for (const key of Object.keys(env)) {
			if (key.startsWith("PI_")) {
				assert.ok(
					["PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_SKIP_VERSION_CHECK", "PI_TELEMETRY"].includes(key),
					`unexpected child PI_ variable: ${key}`,
				);
			}
		}
	});

	// RED harness: never part of the default suite. Same spawn, same argv, same env builder —
	// but with the three offline switches REMOVED, to prove this test can FAIL.
	test("RED: without the offline switches the same launch is expected to reach pi.dev", { skip: process.env.ABITO_PI_OFFLINE_RED === "1" ? false : "set ABITO_PI_OFFLINE_RED=1 (evidence run only)", timeout: BOOT_TIMEOUT_MS }, async () => {
		const base = makeTemp("red");
		const netLog = path.join(base, "net-attempts.jsonl");
		const preload = writePreload(base);
		const island = ensureIsland(path.join(base, "island"));
		const env = isolatedEnv({ PATH: process.env.PATH, HOME: base }, island, { ABITO_NET_LOG: netLog });
		delete env.PI_OFFLINE;
		delete env.PI_SKIP_VERSION_CHECK;
		delete env.PI_TELEMETRY;
		const child = spawn(
			process.execPath,
			["--require", preload, cli, "--mode", "rpc", "--session-dir", island.sessions],
			{ cwd: island.workspace, env, stdio: ["pipe", "pipe", "pipe"] },
		);
		let stderr = "";
		child.stderr.on("data", (d) => {
			stderr += d;
		});
		const records = [];
		let buf = "";
		child.stdout.on("data", (d) => {
			buf += d.toString("utf8");
			let i;
			while ((i = buf.indexOf("\n")) >= 0) {
				try {
					records.push(JSON.parse(buf.slice(0, i)));
				} catch {}
				buf = buf.slice(i + 1);
			}
		});
		// The engine sends get_state as soon as the child is spawned (rawRequest in spawnAndInitialize);
		// real Pi in rpc mode is silent until a request arrives, so send immediately and await the answer.
		child.stdin.write(`${JSON.stringify({ id: "s", type: "get_state" })}\n`);
		const deadline = Date.now() + 60_000;
		while (!records.some((r) => r.id === "s" && r.success)) {
			assert.ok(Date.now() < deadline, `real pi never answered get_state; stderr=${stderr.slice(0, 400)}`);
			if (child.exitCode !== null) assert.fail(`real pi exited early (${child.exitCode}); stderr=${stderr.slice(0, 400)}`);
			await sleep(50);
		}
		// The same model-free exchange the GREEN run makes, plus a set_model like the daemon can send:
		// the window in which rpc's catalog refresh would fetch pi.dev if it were going to.
		child.stdin.write(`${JSON.stringify({ id: "m", type: "set_model", provider: "anthropic", modelId: "claude-sonnet-4-5" })}\n`);
		await sleep(15_000);
		child.kill("SIGKILL");
		await new Promise((resolve) => child.once("close", resolve));
		const attempts = readAttempts(netLog);
		const piDev = attempts.filter((a) => /(^|\.)pi\.dev$/i.test(a.host) || a.host.toLowerCase().includes("pi.dev"));
		assert.deepEqual(
			piDev,
			[],
			`with the offline switches removed Pi contacted pi.dev: ${JSON.stringify(piDev)} (all attempts: ${JSON.stringify(attempts)})`,
		);
		assert.deepEqual(attempts, [], `with the offline switches removed Pi made outbound network attempts: ${JSON.stringify(attempts)}`);
	});
}
