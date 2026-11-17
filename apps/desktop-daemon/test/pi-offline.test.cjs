"use strict";

// K2-05 T2 (S1) + K2-02 S3: the engine Koda launches reaches no pi.dev host.
//
// The REAL engine is launched EXACTLY the way Koda launches it: the daemon's
// AgentEngine (src/runtime.cjs) spawns Gentle Shell (the bundled gentle-pi) with
// the argv the engine builds itself (--home <island>/agent --mode rpc
// --session-dir ... --append-system-prompt identity; T2 replaced
// PI_CODING_AGENT_DIR with --home, and since B2 --home rides ONLY on the
// default bundled-Gentle-Shell engine command) and the environment isolatedEnv builds
// (private HOME, the offline switches PI_OFFLINE=1, PI_SKIP_VERSION_CHECK=1,
// PI_TELEMETRY=0 and the launch gates GENTLE_SHELL_NO_AUTO_SETUP=1,
// GENTLE_PI_SKIP_GENTLE_AI_INSTALL=1 plus GENTLE_PI_CONFIG_HOME). A test-only
// preload (--require, the only injection) records EVERY outbound network
// attempt the child makes (dns.lookup, dns.resolve*, net.connect,
// net.createConnection, tls.connect, fetch) while the engine starts and serves
// a model-free RPC exchange (get_state).
//
// Assert: no attempt reaches any pi.dev host — ideally no outbound attempt at all.
//
// RED: with KODA_PI_OFFLINE_RED=1 the same spawn is run with the three offline
// switches REMOVED from the env; the same assertion is then expected to FAIL and
// name the pi.dev attempt (run once by hand for evidence; never part of the
// default suite).
//
// Engine discovery: Koda's bundled runtime (koda-runtime.json next to the
// daemon's Node — the installed app's layout), else GENTLE_PI_ROOT (a gentle-pi
// package directory, the CI convention like PI_CODING_AGENT_ROOT). Skipped
// (never silently passed) when neither exists: a dev machine reports the
// real-engine test as SKIPPED with this reason; with KODA_REQUIRE_GENTLE=1
// absence FAILS instead. CI note (reported, not editable here): the
// desktop-daemon CI job must install gentle-pi and set KODA_REQUIRE_GENTLE=1.
// Only private temp dirs are used: the island HOME/agent dir is isolatedEnv's
// own; the user's ~/.pi, ~/.gentle* and real config are never read or written.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { AgentEngine, DEFAULT_COMMAND, runtimeRoot } = require("../src/runtime.cjs");
const { ensureIsland, isolatedEnv } = require("../src/isolation.cjs");

const BOOT_TIMEOUT_MS = 90_000;

/**
 * A minimal fake Koda bundled runtime (T2-fix): the layout the engine's
 * runtimeRoot/bundledGentleShell accept through the runtimeDeps seam, so the
 * real-engine test drives the PRODUCTION launch path — `command` is
 * DEFAULT_COMMAND, the engine resolves the runtime itself and appends
 * --home <island>/agent (B2). The manifest's gentleShell is a real WRAPPER file
 * (never a symlink: the engine refuses links) that injects the optional test
 * preload and then imports the REAL gentle-shell entry, so the engine code
 * under test is the real one. POSIX mirrors the shipped `gentle-shell` launcher
 * (a real exec file, not a link); Windows mirrors node.exe + the manifest
 * script.
 */
function fakeKodaRuntime(t, gentleRoot, preload) {
	const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "abito-fake-runtime-"));
	// Retries: on Windows the engine's own child (the runtime node.exe) may still be exiting just after stop() (EPERM).
	t.after(() => fs.rmSync(runtime, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
	const scriptRel = "node_modules/gentle-pi/bin/gentle-shell.mjs";
	const script = path.join(runtime, ...scriptRel.split("/"));
	fs.mkdirSync(path.dirname(script), { recursive: true });
	const realEntry = path.join(gentleRoot, "bin", "gentle-shell.mjs");
	fs.writeFileSync(
		script,
		`// Test wrapper: inject the optional preload, then run the REAL engine entry.\n` +
			`import { createRequire } from "node:module";\n` +
			`import { pathToFileURL } from "node:url";\n` +
			(preload ? `createRequire(import.meta.url)(${JSON.stringify(preload)});\n` : "") +
			`await import(pathToFileURL(${JSON.stringify(realEntry)}).href);\n`,
	);
	fs.writeFileSync(
		path.join(runtime, "koda-runtime.json"),
		`${JSON.stringify({ gentlePi: "4.3.0", gentleShell: scriptRel })}\n`,
	);
	if (process.platform === "win32") {
		// The shipped Windows runtime shape: the runtime's own node.exe runs the
		// script the manifest names. A real copy (never a link).
		fs.copyFileSync(process.execPath, path.join(runtime, "node.exe"));
	} else {
		const launcher = path.join(runtime, "gentle-shell");
		fs.writeFileSync(launcher, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`);
		fs.chmodSync(launcher, 0o755);
	}
	return {
		runtime,
		runtimeDeps: {
			execPath: path.join(runtime, process.platform === "win32" ? "node.exe" : "node"),
			existsSync: fs.existsSync,
			lstatSync: fs.lstatSync,
			readFileSync: fs.readFileSync,
		},
	};
}

/** A gentle-pi package directory (it holds bin/gentle-shell.mjs), or undefined. */
function findGentleRoot() {
	if (process.env.GENTLE_PI_ROOT) return process.env.GENTLE_PI_ROOT;
	const runtime = runtimeRoot();
	if (runtime) {
		try {
			const manifest = JSON.parse(fs.readFileSync(path.join(runtime, "koda-runtime.json"), "utf8"));
			// gentleShell is the script path relative to the runtime root (T1); its
			// package directory is two levels up (.../node_modules/gentle-pi).
			return path.dirname(path.dirname(path.join(runtime, manifest.gentleShell)));
		} catch {
			// read-only discovery: fall through
		}
	}
	return undefined;
}

const gentleRoot = findGentleRoot();
// No real engine: a dev machine reports the real-engine test as SKIPPED with this
// reason (never a bare pass); with KODA_REQUIRE_GENTLE=1 the run FAILS instead:
// the S1/S3 proof may never be silently absent.
const GENTLE_MISSING = "Gentle Shell (gentle-pi) not found; set GENTLE_PI_ROOT or build the bundled runtime";
if (!gentleRoot && process.env.KODA_REQUIRE_GENTLE === "1") {
	test("Gentle Shell is required here (KODA_REQUIRE_GENTLE=1)", () => {
		assert.fail("KODA_REQUIRE_GENTLE=1 but no Gentle Shell was found (set GENTLE_PI_ROOT or build the bundled runtime)");
	});
}
const gentleSkip = gentleRoot ? undefined : GENTLE_MISSING;

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The test-only network recorder, injected with --require BEFORE the engine's code runs. */
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
	const file = process.env.KODA_NET_LOG;
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
	const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `abito-gentle-offline-${tag}-`)));
	process.on("exit", () => {
		try {
			fs.rmSync(base, { recursive: true, force: true });
		} catch {}
	});
	return base;
}

/** The gentle-shell entry script of the discovered engine (bin/gentle-shell.mjs). */
function gentleScript(root) {
	const script = path.join(root, "bin", "gentle-shell.mjs");
	if (!fs.existsSync(script)) throw new Error(`gentle-pi root has no bin/gentle-shell.mjs: ${root}`);
	return script;
}

// The env test needs no engine binary: it always runs, on every machine.
test("the env Koda builds keeps the offline switches and adds the Gentle Shell gates", () => {
	const base = makeTemp("env");
	const island = ensureIsland(path.join(base, "island"));
	const env = isolatedEnv({ PATH: process.env.PATH, HOME: base }, island);
	assert.equal(env.PI_OFFLINE, "1");
	assert.equal(env.PI_SKIP_VERSION_CHECK, "1");
	assert.equal(env.PI_TELEMETRY, "0");
	// T2: the engine home travels on --home; PI_CODING_AGENT_DIR is never set.
	assert.equal(env.PI_CODING_AGENT_DIR, undefined);
	assert.equal(env.GENTLE_SHELL_NO_AUTO_SETUP, "1");
	assert.equal(env.GENTLE_PI_SKIP_GENTLE_AI_INSTALL, "1");
	assert.equal(env.GENTLE_PI_CONFIG_HOME, path.join(island.root, "gentle-ai"));
	assert.equal(env.HOME, island.home);
	for (const key of Object.keys(env)) {
		if (key.startsWith("PI_")) {
			assert.ok(
				["PI_OFFLINE", "PI_SKIP_VERSION_CHECK", "PI_TELEMETRY"].includes(key),
				`unexpected child PI_ variable: ${key}`,
			);
		}
	}
});

if (gentleSkip) {
	// Report the real-engine proof as skipped (with the reason) instead of declaring nothing.
	test("real engine: a Koda launch of Gentle Shell reaches no pi.dev host (offline switches and launch gates kept)", { skip: gentleSkip }, () => {});
} else {
	const script = gentleScript(gentleRoot);

	test("real engine: a Koda launch of Gentle Shell reaches no pi.dev host (offline switches and launch gates kept)", { skip: gentleSkip, timeout: BOOT_TIMEOUT_MS }, async (t) => {
		const base = makeTemp("green");
		const netLog = path.join(base, "net-attempts.jsonl");
		const preload = writePreload(base);
		const { runtimeDeps } = fakeKodaRuntime(t, gentleRoot, preload);
		const engine = new AgentEngine({
			// Exactly the daemon's default launch shape (T2-fix): command =
			// DEFAULT_COMMAND, so the engine itself resolves Koda's bundled runtime
			// through runtimeDeps (here a fake runtime whose launcher/wrapper execs
			// the REAL gentle-shell entry with the test-only net recorder injected —
			// the only injection) and appends --home <island>/agent --mode rpc
			// --session-dir/--append-system-prompt as production does (B2).
			command: DEFAULT_COMMAND,
			commandArgs: [],
			runtimeDeps,
			root: path.join(base, "island"),
			env: { PATH: process.env.PATH, HOME: base },
			envOverrides: { KODA_NET_LOG: netLog },
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
			await sleep(4_000); // a window for anything the engine does after the first exchange
		} finally {
			await engine.stop();
		}
		const attempts = readAttempts(netLog);
		const piDev = attempts.filter((a) => /(^|\.)pi\.dev$/i.test(a.host) || a.host.toLowerCase().includes("pi.dev"));
		assert.deepEqual(
			piDev,
			[],
			`Koda's launch of the engine contacted pi.dev: ${JSON.stringify(piDev)} (all attempts: ${JSON.stringify(attempts)})`,
		);
		// Ideally there is NO outbound attempt at all while the engine boots and serves get_state.
		assert.deepEqual(
			attempts,
			[],
			`Koda's launch of the engine made outbound network attempts: ${JSON.stringify(attempts)}`,
		);
	});

	// RED harness: never part of the default suite. Same spawn, same argv, same env builder —
	// but with the three offline switches REMOVED, to prove this test can FAIL.
	test("RED: without the offline switches the same launch is expected to reach pi.dev", { skip: process.env.KODA_PI_OFFLINE_RED === "1" ? false : "set KODA_PI_OFFLINE_RED=1 (evidence run only)", timeout: BOOT_TIMEOUT_MS }, async () => {
		const base = makeTemp("red");
		const netLog = path.join(base, "net-attempts.jsonl");
		const preload = writePreload(base);
		const island = ensureIsland(path.join(base, "island"));
		const env = isolatedEnv({ PATH: process.env.PATH, HOME: base }, island, { KODA_NET_LOG: netLog });
		delete env.PI_OFFLINE;
		delete env.PI_SKIP_VERSION_CHECK;
		delete env.PI_TELEMETRY;
		const child = spawn(
			process.execPath,
			// The same argv the engine builds: --home (T2), rpc mode, private sessions.
			["--require", preload, script, "--home", island.agentDir, "--mode", "rpc", "--session-dir", island.sessions],
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
		// the engine in rpc mode is silent until a request arrives, so send immediately and await the answer.
		child.stdin.write(`${JSON.stringify({ id: "s", type: "get_state" })}\n`);
		const deadline = Date.now() + 60_000;
		while (!records.some((r) => r.id === "s" && r.success)) {
			assert.ok(Date.now() < deadline, `the engine never answered get_state; stderr=${stderr.slice(0, 400)}`);
			if (child.exitCode !== null) assert.fail(`the engine exited early (${child.exitCode}); stderr=${stderr.slice(0, 400)}`);
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
			`with the offline switches removed the engine contacted pi.dev: ${JSON.stringify(piDev)} (all attempts: ${JSON.stringify(attempts)})`,
		);
		assert.deepEqual(attempts, [], `with the offline switches removed the engine made outbound network attempts: ${JSON.stringify(attempts)}`);
	});
}
