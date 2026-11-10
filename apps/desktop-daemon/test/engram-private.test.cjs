"use strict";

// K2-05 T1c (S5/L11): Koda's memory is ALWAYS private — Gentle Dot's private
// mode, as Koda's only mode. The REAL engine is launched EXACTLY the way Koda
// launches it (AgentEngine, command DEFAULT_COMMAND, the runtime the engine
// resolves itself, --home <island>/agent --mode rpc, isolatedEnv + the T1c
// private memory env), from a fake bundled runtime carrying the real
// gentle-engram@0.4.2 companion and a REAL bundled-style Engram 3.4.0 binary:
// the linux-x64 release binary built by T1b-a when it is present at
// /tmp/koda-real-runtime/bin/engram, otherwise the pinned GitHub release asset
// (packaging/runtime/engram.sha256), downloaded into a temp dir and verified
// against its sha256.
//
// Proven here, with a temp HOME and a temp island (the user's real ~/.engram
// and the user's Engram servers on 7437/7438 are NEVER touched — nothing ever
// connects to those ports; listeners are only listed passively through lsof):
//  - the engine reaches ready offline, with the memory tools registered
//    (the companion's session_start lifecycle trace; no extension_error);
//  - the Engram server the companion spawns listens on KODA'S PRIVATE PORT
//    (7439, or ABITO_ENGRAM_PORT) and nowhere else (loopback-only binding,
//    checked passively), its /health reports the exact instance identity the
//    server left inside the island (<island>/home/.engram/.instance-id) and
//    version 3.4.0, and its store lives under the temp island's home;
//  - the engine's own network log records NO attempt at the user's ports
//    (7437/7438) and no non-loopback host during the whole boot;
//  - the private memory lifecycle works end to end with REAL seams: the daemon
//    shape of it (privateMemory before the engine starts) takes ownership of
//    the confirmed-empty port, and its stop() verifies the listener against
//    the island's instance id + GET /health before SIGTERM — the server is
//    gone afterwards, its island store untouched.
//
// Engine discovery / skip-require gate: the same convention as
// test/engram-seed.test.cjs — GENTLE_PI_ROOT (a gentle-pi package directory)
// or a real bundled runtime; skipped with the reason when absent, FAILED under
// ABITO_REQUIRE_GENTLE=1. Only private temp dirs are used.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const { AgentEngine, DEFAULT_COMMAND, runtimeRoot } = require("../src/runtime.cjs");
const { PRIVATE_ENGRAM_PORT, privateMemory } = require("../src/isolation.cjs");

const BOOT_TIMEOUT_MS = 180_000;
const ENGRAM_VERSION = "0.4.2";
const ENGRAM_CORE_VERSION = "3.4.0";

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeTemp(tag) {
	const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `abito-engram-private-${tag}-`)));
	process.on("exit", () => {
		try {
			fs.rmSync(base, { recursive: true, force: true });
		} catch {}
	});
	return base;
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

/**
 * The real gentle-engram package directory (F8, sha512-checked only): from
 * ABITO_ENGRAM_PKG when set, else the sibling of an installed engine closure
 * (CI: GENTLE_PI_ROOT points into the runtime lockfile install), else a fresh
 * `npm ci --ignore-scripts` from Koda's OWN runtime lockfile into a temp dir.
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
 * The REAL Engram core binary, in the shape the bundled runtime ships it
 * (`<runtime>/bin/engram[.exe]`, a real file). First choice: the linux-x64
 * release binary T1b-a built (its self-check passed). Otherwise: the pinned
 * GitHub release asset, downloaded into a temp dir and verified against the
 * per-target sha256 pin in packaging/runtime/engram.sha256. Returns
 * `{ file, source }` or `{ skip }` with the reason when neither is possible.
 */
function realEngramBinary() {
	const prebuilt = "/tmp/koda-real-runtime/bin/engram";
	const name = process.platform === "win32" ? "engram.exe" : "engram";
	if (process.platform === "linux" && fs.existsSync(prebuilt)) {
		const probe = spawnSync(prebuilt, ["version"], { encoding: "utf8", timeout: 15_000 });
		if (probe.status === 0 && String(probe.stdout).includes(ENGRAM_CORE_VERSION)) {
			return { file: prebuilt, source: "T1b-a build (/tmp/koda-real-runtime/bin/engram)" };
		}
		return { skip: `the T1b-a binary at ${prebuilt} does not answer version ${ENGRAM_CORE_VERSION}` };
	}
	// Pinned release asset per packaging/runtime/engram.sha256 (verified).
	const target = {
		linux: { asset: `engram_${ENGRAM_CORE_VERSION}_linux_amd64.tar.gz`, extract: "tar" },
		darwin: { asset: `engram_${ENGRAM_CORE_VERSION}_darwin_arm64.tar.gz`, extract: "tar" },
		win32: { asset: `engram_${ENGRAM_CORE_VERSION}_windows_amd64.zip`, extract: "zip" },
	}[process.platform];
	if (!target) return { skip: `no pinned Engram asset mapping for ${process.platform}` };
	const pinFile = path.join(__dirname, "..", "..", "desktop-tauri", "packaging", "runtime", "engram.sha256");
	const pins = fs.readFileSync(pinFile, "utf8").split("\n").filter(Boolean);
	const pin = pins.find((line) => line.endsWith(target.asset));
	if (!pin) return { skip: `no sha256 pin for ${target.asset} in engram.sha256` };
	const expectedSha = pin.split(/\s+/)[0];
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abito-engram-bin-"));
	process.on("exit", () => {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {}
	});
	const archive = path.join(dir, target.asset);
	let ok = false;
	try {
		execFileSync(
			"curl",
			["-fsSL", "-o", archive, `https://github.com/Gentleman-Programming/engram/releases/download/v${ENGRAM_CORE_VERSION}/${target.asset}`],
			{ timeout: 120_000, stdio: ["ignore", "ignore", "inherit"] },
		);
		ok = true;
	} catch {
		return { skip: `could not download the pinned ${target.asset} (offline?)` };
	}
	if (ok) {
		const sha = spawnSync("sha256sum", [archive], { encoding: "utf8" }).stdout.trim().split(/\s+/)[0];
		assert.equal(sha, expectedSha, `the downloaded ${target.asset} matches engram.sha256`);
		if (target.extract === "tar") {
			execFileSync("tar", ["xzf", archive, "-C", dir, name], { timeout: 60_000 });
		} else {
			execFileSync("powershell.exe", ["-NoLogo", "-Command", `Expand-Archive -Path '${archive}' -DestinationPath '${dir}'`], { timeout: 60_000 });
		}
		const file = path.join(dir, name);
		if (process.platform !== "win32") fs.chmodSync(file, 0o755);
		return { file, source: `pinned release asset ${target.asset} (sha256 verified)` };
	}
	return { skip: "no Engram binary available" };
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

/** Passive listener listing (NEVER a connect): the pids listening on `port`, or []. */
function listenerPids(port) {
	const probe = spawnSync("lsof", ["-w", "-t", "-n", "-P", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8", timeout: 15_000 });
	const text = (probe.stdout ?? "").trim();
	if (!text) return [];
	return text.split("\n").map((line) => Number(line.trim())).filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}

/** Every TCP address the pid is LISTENING on (passive listing; never a connect). */
function listenAddresses(pid) {
	const probe = spawnSync("lsof", ["-w", "-n", "-P", "-p", String(pid), "-a", "-iTCP", "-sTCP:LISTEN"], { encoding: "utf8", timeout: 15_000 });
	return (probe.stdout ?? "")
		.split("\n")
		.slice(1)
		.filter(Boolean)
		.map((line) => line.trim().split(/\s+/).find((token) => /:\d+$/.test(token) && !token.startsWith("(")))
		.filter(Boolean);
}

/** A fake Koda bundled runtime shaped like the installed one, with the REAL Engram binary. */
function fakeKodaRuntime(t, gentleRoot, engramRoot, preload, engramFile) {
	const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "abito-engram-private-runtime-"));
	t.after(() => fs.rmSync(runtime, { recursive: true, force: true }));
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
	fs.cpSync(engramRoot, path.join(runtime, "node_modules", "gentle-engram"), { recursive: true });
	fs.mkdirSync(path.join(runtime, "bin"), { recursive: true });
	fs.copyFileSync(engramFile, path.join(runtime, "bin", process.platform === "win32" ? "engram.exe" : "engram"));
	if (process.platform !== "win32") fs.chmodSync(path.join(runtime, "bin", "engram"), 0o755);
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

if (gentleSkip) {
	test("real engine: Koda's private memory serves the island on its own port", { skip: gentleSkip }, () => {});
} else {
	const binary = realEngramBinary();
	if (binary.skip) {
		test("real engine: Koda's private memory serves the island on its own port", { skip: binary.skip }, () => {});
	} else {
		test("real engine: Koda's private memory serves the island on its own port", { skip: gentleSkip, timeout: BOOT_TIMEOUT_MS }, async (t) => {
			const base = makeTemp("green");
			const netLog = path.join(base, "net-attempts.jsonl");
			const preload = writePreload(base);
			const engramRoot = engramPackageDir();
			const { runtimeDeps } = fakeKodaRuntime(t, gentleRoot, engramRoot, preload, binary.file);
			const islandRoot = path.join(base, "island");
			// Temp HOME (never the user's). NO ENGRAM_DATA_DIR: the private memory's
			// store follows the engine's island HOME, exactly like production.
			// The parent env deliberately carries the user's Engram variables: none
			// of them may reach the engine or the private memory.
			const baseEnv = {
				PATH: process.env.PATH,
				HOME: base,
				ENGRAM_URL: "http://127.0.0.1:7437",
				ENGRAM_PORT: "7437",
				ENGRAM_DATA_DIR: path.join(base, "never-used"),
			};
			// The daemon shape: privateMemory BEFORE the engine starts, with REAL
			// seams (real lsof, real /health, real SIGTERM on Koda's own listener).
			const logs = [];
			const memory = await privateMemory(baseEnv, islandRoot, (line) => logs.push(line));
			assert.ok(memory, `port ${PRIVATE_ENGRAM_PORT} was empty before startup, so the daemon owns cleanup; logs: ${JSON.stringify(logs)}`);

			const engine = new AgentEngine({
				command: DEFAULT_COMMAND,
				commandArgs: [],
				runtimeDeps,
				root: islandRoot,
				env: baseEnv,
				envOverrides: {
					ABITO_NET_LOG: netLog,
					ENGRAM_PI_SESSION_TRACE: "1",
				},
				backoffMs: [10_000, 10_000],
				stableMs: 60_000,
				startTimeoutMs: 150_000,
				requestTimeoutMs: 15_000,
				switchTimeoutMs: 15_000,
				stopTimeoutMs: 2_000,
				log: (line) => engineLogs.push(line),
			});
			const engineLogs = [];
			const events = [];
			engine.on("event", (event) => events.push(event));
			// Test-owned cleanup that runs even when an assertion fails: any listener
			// left on the private port whose EXECUTABLE is the temp runtime's engram
			// binary (proven through the passive lsof listing, never by name alone)
			// is this test's own orphan and is stopped; anything else is never touched.
			const ownRuntimeBin = path.join(runtimeDeps.execPath, "..", "bin", process.platform === "win32" ? "engram.exe" : "engram");
			t.after(async () => {
				for (const pid of listenerPids(Number(PRIVATE_ENGRAM_PORT))) {
					const probe = spawnSync("lsof", ["-w", "-n", "-P", "-p", String(pid)], { encoding: "utf8", timeout: 15_000 });
					if ((probe.stdout ?? "").split("\n").some((line) => line.includes("txt ") && line.includes(ownRuntimeBin))) {
						try {
							process.kill(pid, "SIGTERM");
						} catch {}
					}
				}
			});
			try {
				await engine.start();
				assert.equal(engine.status, "ready");

				// The memory project pin is untouched (S4/L5).
				assert.equal(
					JSON.parse(fs.readFileSync(path.join(engine.island.workspace, ".engram", "config.json"), "utf8")).project_name,
					"abito-island",
				);

				// Trigger the companion's session_start, which brings the private
				// memory server up on Koda's port with its store under the island home.
				await engine.request({ type: "new_session" });
				const port = Number(PRIVATE_ENGRAM_PORT);
				const deadline = Date.now() + 60_000;
				let health;
				while (Date.now() < deadline) {
					health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })
						.then((response) => response.json())
						.catch(() => undefined);
					if (health?.instance_id) break;
					await sleep(500);
				}
				assert.ok(health?.instance_id, `the private memory server answers /health on ${port}; logs: ${JSON.stringify(engineLogs).slice(0, 2000)}`);
				assert.equal(health.version, ENGRAM_CORE_VERSION, "the private server IS the pinned core");
				const storeDir = path.join(engine.island.home, ".engram");
				const instanceFile = path.join(storeDir, ".instance-id");
				const instanceId = fs.readFileSync(instanceFile, "utf8").trim();
				assert.equal(health.instance_id, instanceId, "/health reports the identity of the ISLAND store");
				assert.ok(fs.existsSync(path.join(storeDir, "engram.db")), "the private store lives under the island home");
				const pids = listenerPids(port);
				assert.equal(pids.length, 1, `exactly one listener on ${port}`);
				const addresses = listenAddresses(pids[0]);
				assert.ok(
					addresses.length > 0 && addresses.every((a) => a === `127.0.0.1:${port}`),
					`the private server binds loopback-only on ${port}: ${JSON.stringify(addresses)}`,
				);

				// The companion is loaded and its memory tools registered.
				const trace = engineLogs.filter((line) => line.includes("[engram:session-trace]") && line.includes('"event":"session_start"'));
				assert.ok(trace.length >= 1, `no engram session_start trace on the engine stderr; logs: ${JSON.stringify(engineLogs).slice(0, 2000)}`);
				const extensionErrors = events.filter((event) => event.type === "extension_error" && JSON.stringify(event).toLowerCase().includes("engram"));
				assert.deepEqual(extensionErrors, []);
			} finally {
				await engine.stop();
			}

			// The engine's own network log: no attempt at the USER's ports, nothing
			// non-loopback. (Loopback is expected: the companion probes its local
			// private server on Koda's port.)
			const attempts = readAttempts(netLog);
			const userPorts = attempts.filter((a) => a.port === 7437 || a.port === 7438);
			assert.deepEqual(userPorts, [], `nothing ever targeted the user's Engram ports: ${JSON.stringify(attempts)}`);
			const external = attempts.filter((a) => !isLoopback(a.host));
			assert.deepEqual(
				external,
				[],
				`Koda's launch of the engine reached non-loopback hosts: ${JSON.stringify(external)} (all attempts: ${JSON.stringify(attempts)})`,
			);

			// The daemon shape, end to end: stop() verifies the listener against the
			// island identity + /health (REAL lsof, REAL fetch, REAL SIGTERM).
			await memory.stop();
			assert.ok(logs.some((line) => /stopped the private memory server/.test(line)), `the private server was stopped: ${JSON.stringify(logs)}`);
			const stillUp = listenerPids(Number(PRIVATE_ENGRAM_PORT)).filter((pid) => !isGone(pid));
			assert.deepEqual(stillUp, [], "port is empty again after the daemon-shaped stop");
		});
	}
}

/** True when the pid no longer answers (not alive or gone). */
function isGone(pid) {
	try {
		process.kill(pid, 0);
		return false;
	} catch {
		return true;
	}
}
