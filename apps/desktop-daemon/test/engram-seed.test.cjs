"use strict";

// K2-05 T1b-b (S5): the engine uses the bundled Engram. The REAL engine is
// launched EXACTLY the way Koda launches it (AgentEngine, command
// DEFAULT_COMMAND, the runtime the engine resolves itself, --home
// <island>/agent --mode rpc, isolatedEnv + the T1b-b memory env), from a fake
// bundled runtime that carries what the installed runtime ships since T1b-a:
// the gentle-pi entry, `bin/engram` (a stub real file — the binary is never
// run here) and the REAL gentle-engram@0.4.2 companion in
// node_modules/gentle-engram. The daemon itself seeds the companion into the
// island (seedEngramCompanion, called by engine.start) and merges the pinned
// package into <island>/agent/settings.json; nothing in this test pre-seeds.
//
// Proven here, with a temp HOME and a temp ENGRAM_DATA_DIR (the user's real
// ~/.engram is never touched):
//  - the engine reaches ready and answers get_state;
//  - the seeded companion is LOADED by the engine offline: gentle-engram's
//    session_start lifecycle trace appears on the engine's stderr
//    (ENGRAM_PI_SESSION_TRACE=1 — the extension registers its mem_* tools and
//    hooks in the same registerEngram() call), and no extension_error arrives;
//  - ZERO non-loopback network connects during the whole boot (loopback is
//    allowed: gentle-engram probes its local Engram server); PI_OFFLINE makes
//    Pi resolve the pinned npm package from the island's npm folder;
//  - the memory project pin is untouched: ABITO_MEMORY_PROJECT=abito-island
//    and <workspace>/.engram/config.json still names it.
//
// Engine discovery / skip-require gate: the same convention as
// test/pi-offline.test.cjs — GENTLE_PI_ROOT (a gentle-pi package directory) or
// a real bundled runtime; skipped with the reason when absent, FAILED under
// ABITO_REQUIRE_GENTLE=1. The gentle-engram@0.4.2 package (F8) is NEVER fetched
// with an unpinned `npm pack`: it comes from ABITO_ENGRAM_PKG when set, from
// the sibling of an installed engine closure (CI: the runtime lockfile install
// GENTLE_PI_ROOT points into), or is installed with `npm ci --ignore-scripts`
// from Koda's OWN runtime lockfile (apps/desktop-tauri/packaging/runtime,
// sha512-pinned). Only private temp dirs are used.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { AgentEngine, DEFAULT_COMMAND, runtimeRoot } = require("../src/runtime.cjs");

const BOOT_TIMEOUT_MS = 150_000;
// R8 (K2-05 CI run 43025727185): on the Windows runner the real engine's session replacement
// (switch_session/new_session: teardown + runtime rebuild inside the engine) did not answer within the
// Linux budget, while on Linux it answers in ~0.1 s (start ~5 s). Koda's side of a switch is one JSONL
// request with no file handle kept open, the same on every OS, so Windows gets more time, not other
// behaviour: the switch budget is the product's own default (DEFAULT_SWITCH_TIMEOUT_MS, 30 s), so a
// Windows switch slower than what the shipped daemon waits for still fails here.
const WIN_REAL = process.platform === "win32";
const ENGRAM_VERSION = "0.4.2";

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeTemp(tag) {
	const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `abito-engram-seed-${tag}-`)));
	process.on("exit", () => {
		try {
			fs.rmSync(base, { recursive: true, force: true });
		} catch {}
	});
	return base;
}

/**
 * The real gentle-engram package directory (F8, sha512-checked only):
 * ABITO_ENGRAM_PKG when set, else the sibling of an installed engine closure
 * (CI: GENTLE_PI_ROOT points into the runtime lockfile install), else a fresh
 * `npm ci --ignore-scripts` from Koda's runtime lockfile into a temp dir.
 */
function engramPackageDir() {
	if (process.env.ABITO_ENGRAM_PKG) {
		const dir = process.env.ABITO_ENGRAM_PKG;
		const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
		assert.equal(pkg.name, "gentle-engram");
		return dir;
	}
	if (gentleRoot) {
		const sibling = path.join(path.dirname(gentleRoot), "gentle-engram");
		try {
			const pkg = JSON.parse(fs.readFileSync(path.join(sibling, "package.json"), "utf8"));
			if (pkg.name === "gentle-engram" && pkg.version === ENGRAM_VERSION) return sibling;
		} catch {}
	}
	const lockDir = path.join(__dirname, "..", "..", "desktop-tauri", "packaging", "runtime");
	const cache = path.join(os.tmpdir(), "abito-engram-pkg-cache", "ci-install");
	const installed = path.join(cache, "node_modules", "gentle-engram");
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(installed, "package.json"), "utf8"));
		if (pkg.name === "gentle-engram" && pkg.version === ENGRAM_VERSION) return installed;
	} catch {}
	const staging = fs.mkdtempSync(path.join(os.tmpdir(), "abito-engram-ci-"));
	process.on("exit", () => {
		try {
			fs.rmSync(staging, { recursive: true, force: true });
		} catch {}
	});
	fs.copyFileSync(path.join(lockDir, "package.json"), path.join(staging, "package.json"));
	fs.copyFileSync(path.join(lockDir, "package-lock.json"), path.join(staging, "package-lock.json"));
	execFileSync("npm", ["ci", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"], {
		cwd: staging,
		stdio: ["ignore", "ignore", "inherit"],
		timeout: 300_000,
	});
	// Move the fresh install into the reused cache slot (a partial or stale one
	// is replaced whole; this is the test's own /tmp cache, nothing else's).
	fs.mkdirSync(cache, { recursive: true });
	fs.rmSync(cache, { recursive: true, force: true });
	fs.mkdirSync(cache, { recursive: true });
	fs.renameSync(path.join(staging, "node_modules"), path.join(cache, "node_modules"));
	const pkg = JSON.parse(fs.readFileSync(path.join(installed, "package.json"), "utf8"));
	assert.equal(pkg.name, "gentle-engram");
	assert.equal(pkg.version, ENGRAM_VERSION);
	return installed;
}

/**
 * A fake Koda bundled runtime shaped like the installed one (T1b-a): the
 * gentleShell wrapper script that runs the REAL gentle-shell entry, the
 * manifest with engram + engramBin (the stub `bin/engram` is a real file,
 * never a link), and the REAL gentle-engram companion. The launcher is the
 * shipped shape (POSIX exec file; Windows node.exe + the manifest script).
 */
function fakeKodaRuntime(t, gentleRoot, engramRoot, preload) {
	const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "abito-engram-runtime-"));
	// Retries: on Windows the engine's own child (the runtime node.exe) may still be exiting just after stop() (EPERM).
	t.after(() => fs.rmSync(runtime, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
	const scriptRel = "node_modules/gentle-pi/bin/gentle-shell.mjs";
	const script = path.join(runtime, ...scriptRel.split("/"));
	fs.mkdirSync(path.dirname(script), { recursive: true });
	fs.writeFileSync(
		script,
		`// Test wrapper: inject the optional preload, then run the REAL engine entry.\n` +
			`import { createRequire } from "node:module";\n` +
			`import { pathToFileURL } from "node:url";\n` +
			(preload ? `createRequire(import.meta.url)(${JSON.stringify(preload)});\n` : "") +
			`await import(pathToFileURL(${JSON.stringify(path.join(gentleRoot, "bin", "gentle-shell.mjs"))}).href);\n`,
	);
	// The real companion, copied into the runtime layout (a real copy: the
	// engine refuses to seed from links).
	fs.cpSync(engramRoot, path.join(runtime, "node_modules", "gentle-engram"), { recursive: true });
	// The pinned Engram binary slot: a stub real file (never executed here).
	fs.mkdirSync(path.join(runtime, "bin"), { recursive: true });
	fs.writeFileSync(path.join(runtime, "bin", process.platform === "win32" ? "engram.exe" : "engram"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	fs.writeFileSync(
		path.join(runtime, "koda-runtime.json"),
		`${JSON.stringify({
			gentlePi: "4.3.0",
			gentleShell: scriptRel,
			engram: ENGRAM_VERSION,
			engramBin: process.platform === "win32" ? "bin/engram.exe" : "bin/engram",
		})}\n`,
	);
	if (process.platform === "win32") {
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
			return path.dirname(path.dirname(path.join(runtime, manifest.gentleShell)));
		} catch {
			// read-only discovery: fall through
		}
	}
	return undefined;
}

const gentleRoot = findGentleRoot();
const GENTLE_MISSING = "Gentle Shell (gentle-pi) not found; set GENTLE_PI_ROOT or build the bundled runtime";
if (!gentleRoot && process.env.ABITO_REQUIRE_GENTLE === "1") {
	test("Gentle Shell is required here (ABITO_REQUIRE_GENTLE=1)", () => {
		assert.fail("ABITO_REQUIRE_GENTLE=1 but no Gentle Shell was found (set GENTLE_PI_ROOT or build the bundled runtime)");
	});
}
const gentleSkip = gentleRoot ? undefined : GENTLE_MISSING;

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

const isLoopback = (host) =>
	/^(localhost|127\.|::1|\[::1\]|\[::ffff:127\.)/i.test(host) || host.toLowerCase().endsWith(".localhost");

if (gentleSkip) {
	// Report the real-engine proof as skipped (with the reason) instead of declaring nothing.
	test("real engine: Koda seeds the bundled Engram companion and loads it offline", { skip: gentleSkip }, () => {});
} else {
	test("real engine: Koda seeds the bundled Engram companion and loads it offline", { skip: gentleSkip, timeout: BOOT_TIMEOUT_MS }, async (t) => {
		const base = makeTemp("green");
		const netLog = path.join(base, "net-attempts.jsonl");
		const preload = writePreload(base);
		const engramRoot = engramPackageDir();
		const { runtimeDeps } = fakeKodaRuntime(t, gentleRoot, engramRoot, preload);
		// Temp HOME (never the user's) and a temp ENGRAM_DATA_DIR (never the real
		// ~/.engram): the parent's ENGRAM_* variables are overridden away.
		const engine = new AgentEngine({
			command: DEFAULT_COMMAND,
			commandArgs: [],
			runtimeDeps,
			root: path.join(base, "island"),
			env: { PATH: process.env.PATH, HOME: base },
			envOverrides: {
				ABITO_NET_LOG: netLog,
				ENGRAM_DATA_DIR: path.join(base, "engram-store"),
				ENGRAM_PI_SESSION_TRACE: "1",
			},
			backoffMs: [10_000, 10_000],
			stableMs: 60_000,
			startTimeoutMs: 120_000,
			requestTimeoutMs: WIN_REAL ? 60_000 : 15_000, // R8: new_session runs on the request budget
			switchTimeoutMs: WIN_REAL ? 30_000 : 15_000,
			stopTimeoutMs: 2_000,
			log: (line) => engineLogs.push(line),
		});
		const engineLogs = [];
		const events = [];
		engine.on("event", (event) => events.push(event));
		try {
			await engine.start();
			assert.equal(engine.status, "ready");

			// The daemon seeded the companion into the engine's own home.
			const agentDir = engine.island.agentDir;
			const seeded = path.join(agentDir, "npm", "node_modules", "gentle-engram", "package.json");
			assert.ok(fs.existsSync(seeded), "the companion was copied into <island>/agent/npm/node_modules");
			assert.equal(JSON.parse(fs.readFileSync(seeded, "utf8")).version, ENGRAM_VERSION);
			const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
			assert.ok(
				settings.packages.some((entry) => (typeof entry === "string" ? entry : entry?.source) === `npm:gentle-engram@${ENGRAM_VERSION}`),
				`settings.json pins the companion: ${JSON.stringify(settings.packages)}`,
			);
			// The memory project is untouched (S4/L5).
			assert.equal(
				JSON.parse(fs.readFileSync(path.join(engine.island.workspace, ".engram", "config.json"), "utf8")).project_name,
				"abito-island",
			);

			// A model-free RPC exchange, exactly what the daemon exchanges on its own,
			// then a new session: session_start fires the companion's lifecycle hook.
			const state = await engine.request({ type: "get_state" });
			assert.equal(state.success, true);
			await engine.request({ type: "new_session" });
			await sleep(2_000); // a window for the extension's session_start work

			// The companion is loaded: its session_start trace runs on the engine's
			// stderr (registerEngram registers the mem_* tools in the same call), and
			// no extension_error was emitted.
			const trace = engineLogs.filter((line) => line.includes("[engram:session-trace]") && line.includes('"event":"session_start"'));
			assert.ok(trace.length >= 1, `no engram session_start trace on the engine stderr; logs: ${JSON.stringify(engineLogs).slice(0, 2000)}`);
			const extensionErrors = events.filter((event) => event.type === "extension_error" && JSON.stringify(event).toLowerCase().includes("engram"));
			assert.deepEqual(extensionErrors, []);
		} finally {
			await engine.stop();
		}

		// Zero non-loopback connects during the whole boot. Loopback is allowed:
		// gentle-engram probes its LOCAL Engram server (none is running here —
		// those attempts fail fast and harmlessly).
		const attempts = readAttempts(netLog);
		const external = attempts.filter((a) => !isLoopback(a.host));
		assert.deepEqual(
			external,
			[],
			`Koda's launch of the engine reached non-loopback hosts: ${JSON.stringify(external)} (all attempts: ${JSON.stringify(attempts)})`,
		);
	});
}
