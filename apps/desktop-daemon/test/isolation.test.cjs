"use strict";

// U1 isolation tests: private island layout, fail-closed path checks, env allowlist.
// Everything runs against temporary fixtures; the user's real home is never touched.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
	ENGINE_HOME_MARKER,
	MEMORY_PROJECT,
	assertSecurePath,
	claimEngineHome,
	defaultIslandRoot,
	ensureIsland,
	ensurePrivateDir,
	islandPaths,
	isolatedEnv,
	pathWithNodeFirst,
	writePrivateFile,
} = require("../src/isolation.cjs");
const { win, assertMode, unixOnly } = require("./platform-env.cjs");

function tmpBase(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abito-island-test-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

const POSIX = typeof process.getuid === "function";

test("ensureIsland creates a private 0700 layout with the pinned memory project", (t) => {
	const base = tmpBase(t);
	const island = ensureIsland(path.join(base, "island"));

	for (const dir of [island.root, island.home, island.agentDir, island.sessions, island.workspace, island.tmp]) {
		assertMode(dir, 0o700);
	}
	// XDG directories live inside the private home.
	for (const dir of [".config", ".cache", path.join(".local", "share"), path.join(".local", "state")]) {
		assertMode(path.join(island.home, dir), 0o700);
	}
	// The owned default workspace pins the memory project.
	const config = JSON.parse(fs.readFileSync(path.join(island.workspace, ".engram", "config.json"), "utf8"));
	assert.equal(config.project_name, MEMORY_PROJECT);
	assert.equal(MEMORY_PROJECT, "koda");
});

test("isolatedEnv allowlists only OS essentials and applies explicit private overrides", (t) => {
	const base = tmpBase(t);
	const island = ensureIsland(path.join(base, "island"));
	const env = isolatedEnv(
		{
			PATH: "/usr/local/bin:/usr/bin:/bin",
			HOME: "/home/user",
			LANG: "es_ES.UTF-8",
			SHELL: "/bin/zsh",
			// Parent leftovers that must never reach the engine child:
			ANTHROPIC_API_KEY: "sk-parent-secret",
			OPENAI_API_KEY: "sk-openai",
			PI_CODING_AGENT_DIR: "/home/user/.pi/agent",
			PI_SESSION_ID: "parent-session",
			PI_SESSION_FILE: "/home/user/.pi/sessions/x.jsonl",
			GENTLE_PI_AGENT_HOME: "/home/user/.gentle",
			GENTLE_SHELL_PI: "/home/user/.local/bin/pi/dist/cli.js",
			GENTLE_SHELL_CONFIG: "/home/user/.gentle-shell",
			GENTLE_PI_AGENTS_CHILD: "1",
			ENGRAM_PORT: "7437",
		},
		island,
		{ KODA_MEMORY_PROJECT: "koda" },
	);

	assert.equal(env.HOME, island.home);
	assert.equal(env.TMPDIR, island.tmp);
	assert.equal(env.XDG_CONFIG_HOME, path.join(island.home, ".config"));
	assert.equal(env.XDG_DATA_HOME, path.join(island.home, ".local", "share"));
	assert.equal(env.XDG_CACHE_HOME, path.join(island.home, ".cache"));
	assert.equal(env.XDG_STATE_HOME, path.join(island.home, ".local", "state"));
	// T2: the engine home travels on --home; PI_CODING_AGENT_DIR is never set.
	assert.equal(env.PI_CODING_AGENT_DIR, undefined);
	assert.equal(env.PI_OFFLINE, "1");
	assert.equal(env.PI_SKIP_VERSION_CHECK, "1");
	assert.equal(env.PI_TELEMETRY, "0");
	// T2: gentle-shell's launch-time provisioning gates and gentle-ai's own config home.
	assert.equal(env.GENTLE_SHELL_NO_AUTO_SETUP, "1");
	assert.equal(env.GENTLE_PI_SKIP_GENTLE_AI_INSTALL, "1");
	assert.equal(env.GENTLE_PI_CONFIG_HOME, path.join(island.root, "gentle-ai"));

	// Inherited secrets, parent Pi setup, session state and foreign settings are dropped.
	assert.equal(env.ANTHROPIC_API_KEY, undefined);
	assert.equal(env.OPENAI_API_KEY, undefined);
	assert.equal(env.GENTLE_PI_AGENT_HOME, undefined);
	// gentle-shell would let GENTLE_SHELL_PI override Koda's bundled Pi (verifier
	// finding on gentle-pi lib/gentle-shell-launcher.ts); the user's own Gentle
	// Shell config and subagent variables never reach the engine either.
	assert.equal(env.GENTLE_SHELL_PI, undefined);
	assert.equal(env.GENTLE_SHELL_CONFIG, undefined);
	assert.equal(env.GENTLE_PI_AGENTS_CHILD, undefined);
	assert.equal(env.ENGRAM_PORT, undefined);
	for (const key of Object.keys(env)) {
		if (key.startsWith("PI_")) {
			assert.ok(
				["PI_OFFLINE", "PI_SKIP_VERSION_CHECK", "PI_TELEMETRY"].includes(key),
				`unexpected inherited PI_ variable: ${key}`,
				);
		}
	}
	// OS essentials survive, and explicit overrides are honoured.
	// K2-02 (S2): the Node running the daemon leads the child PATH, so any `node` a
	// child resolves is Koda's own (bundled on a bundled install), never the user's.
	assert.equal(env.PATH, pathWithNodeFirst(path.dirname(process.execPath), "/usr/local/bin:/usr/bin:/bin"));
	assert.equal(env.LANG, "es_ES.UTF-8");
	assert.equal(env.SHELL, "/bin/zsh");
	assert.equal(env.KODA_MEMORY_PROJECT, "koda");
});

// K2-02 (S2): with no inherited PATH the engine child still gets the daemon's node dir first.
test("the engine child PATH fallback leads with the daemon node dir and keeps the offline markers", (t) => {
	// isolatedEnv only reads the island PATHS: they are computed, never created, so the result does not depend on the
	// machine's temp layout (macOS /var -> /private/var, Windows profile ACLs; CI 41733396427).
	const island = islandPaths(path.join(tmpBase(t), "island"));
	const env = isolatedEnv({ HOME: "/home/user" }, island, {});
	const nodeDir = path.dirname(process.execPath);
	assert.equal(env.PATH, pathWithNodeFirst(nodeDir, undefined));
	assert.equal(env.PI_OFFLINE, "1");
	assert.equal(env.PI_SKIP_VERSION_CHECK, "1");
	assert.equal(env.PI_TELEMETRY, "0");
});

test("pathWithNodeFirst uses the right separator on every platform", () => {
	assert.equal(pathWithNodeFirst("/koda/runtime", "/usr/bin:/bin", ":"), "/koda/runtime:/usr/bin:/bin");
	assert.equal(pathWithNodeFirst("C:\\koda\\runtime", undefined, ";"), "C:\\koda\\runtime;/usr/bin:/bin");
	assert.equal(pathWithNodeFirst("/koda/runtime", undefined), `/koda/runtime${path.delimiter}/usr/bin:/bin`);
});

test("defaultIslandRoot honours KODA_ISLAND_DIR and defaults to ~/.koda", () => {
	assert.equal(defaultIslandRoot({ KODA_ISLAND_DIR: "/x/y" }), "/x/y");
	assert.equal(defaultIslandRoot({ HOME: "/home/user" }), path.join("/home/user", ".koda"));
});

// L4 (13 Nov, human): no ABITO_* alias and no fallback to a 0.1 variable. The 0.1 name is
// written out literally here on purpose (the only place the old name survives): it must not be
// read at all, so setting only it leaves the default root in place.
test("the 0.1 ABITO_ISLAND_DIR is no longer honoured (no alias, no fallback)", () => {
	const legacy = { HOME: "/home/user", ABITO_ISLAND_DIR: "/legacy/root" };
	assert.equal(defaultIslandRoot(legacy), path.join("/home/user", ".koda"));
	// and the new name still wins, even with the old one set beside it
	assert.equal(defaultIslandRoot({ ...legacy, KODA_ISLAND_DIR: "/x/y" }), "/x/y");
});

// Windows (Gentle Dot isolatedAgentEnv): the engine and its tools resolve the
// home/profile through USERPROFILE/HOMEDRIVE+HOMEPATH and state folders through
// APPDATA/LOCALAPPDATA/TEMP/TMP — with the parent's real profile they would
// read and keep state in the user's own setup. Injected platform: the mapping
// itself is proven on every OS (this is the Windows twin of the POSIX mapping
// above, which asserts the same island-internal rule through HOME/XDG/TMPDIR).
test("isolatedEnv maps the Windows profile variables into the island (win32, injected platform)", (t) => {
	const base = tmpBase(t);
	const island = ensureIsland(path.join(base, "island"));
	const env = isolatedEnv(
		{
			PATH: "C:\\bin",
			USERPROFILE: "C:\\Users\\a",
			SystemRoot: "C:\\Windows",
			windir: "C:\\Windows",
			ComSpec: "C:\\Windows\\system32\\cmd.exe",
			PATHEXT: ".COM;.EXE;.BAT",
			APPDATA: "C:\\Users\\a\\AppData\\Roaming",
			LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local",
			TEMP: "C:\\Users\\a\\AppData\\Local\\Temp",
			TMP: "C:\\Users\\a\\AppData\\Local\\Temp",
		},
		island,
		{},
		{ platform: "win32" },
	);
	assert.equal(env.HOME, island.home);
	assert.equal(env.USERPROFILE, island.home);
	// TEMP/TMP/TMPDIR all point at the island's private temp dir.
	assert.equal(env.TEMP, island.tmp);
	assert.equal(env.TMP, island.tmp);
	assert.equal(env.TMPDIR, island.tmp);
	// The user's real Roaming/Local state is never inherited: the engine gets
	// the island's own counterparts, created private like the rest of the home.
	assert.equal(env.APPDATA, path.join(island.home, "AppData", "Roaming"));
	assert.equal(env.LOCALAPPDATA, path.join(island.home, "AppData", "Local"));
	assertMode(env.APPDATA, 0o700);
	assertMode(env.LOCALAPPDATA, 0o700);
	// Windows process-launch essentials survive (Gentle Dot keeps them).
	assert.equal(env.SystemRoot, "C:\\Windows");
	assert.equal(env.windir, "C:\\Windows");
	assert.equal(env.ComSpec, "C:\\Windows\\system32\\cmd.exe");
	assert.equal(env.PATHEXT, ".COM;.EXE;.BAT");
});

test("claimEngineHome creates the marker exclusively and never rewrites or writes through an existing one", (t) => {
	const base = tmpBase(t);
	const island = ensureIsland(path.join(base, "island"));
	const marker = path.join(island.agentDir, ENGINE_HOME_MARKER);
	const logs = [];
	// Fresh: created exactly once, 0600, gentle-shell's own marker format.
	assert.equal(claimEngineHome(island.agentDir, "4.3.0", (l) => logs.push(l)), true);
	const claimed = JSON.parse(fs.readFileSync(marker, "utf8"));
	assert.equal(claimed.createdBy, "gentle-shell");
	assert.equal(claimed.version, "4.3.0");
	assertMode(marker, 0o600);
	// Already claimed: left byte-for-byte as it is, never rewritten.
	const kept = `${JSON.stringify({ createdBy: "gentle-shell", version: "kept" })}\n`;
	fs.writeFileSync(marker, kept, { mode: 0o600 });
	logs.length = 0;
	assert.equal(claimEngineHome(island.agentDir, "9.9.9", (l) => logs.push(l)), false);
	assert.equal(logs.join("\n"), "", "an existing regular marker is not a problem to log");
	assert.equal(fs.readFileSync(marker, "utf8"), kept);
	// A symlink at the marker is never written through (fail closed).
	const victim = path.join(base, "victim.json");
	fs.writeFileSync(victim, "keep\n");
	fs.rmSync(marker);
	fs.symlinkSync(victim, marker);
	logs.length = 0;
	assert.equal(claimEngineHome(island.agentDir, "4.3.0", (l) => logs.push(l)), false);
	assert.equal(fs.readFileSync(victim, "utf8"), "keep\n");
	assert.ok(fs.lstatSync(marker).isSymbolicLink(), "the symlink stays in place");
	assert.ok(logs.join("\n").includes(marker), "the refusal is logged for the operator");
	// A non-regular marker (a directory) is refused too.
	fs.rmSync(marker);
	fs.mkdirSync(marker);
	logs.length = 0;
	assert.equal(claimEngineHome(island.agentDir, "4.3.0", (l) => logs.push(l)), false);
	assert.ok(logs.join("\n").includes(marker));
});

test("refuses island roots behind symlink components", (t) => {
	const base = tmpBase(t);
	const real = path.join(base, "real");
	fs.mkdirSync(real);
	const link = path.join(base, "link");
	fs.symlinkSync(real, link);
	assert.throws(() => ensureIsland(path.join(link, "island")), /symlink/);
});

test("refuses to follow a symlinked island root itself", (t) => {
	const base = tmpBase(t);
	const real = path.join(base, "real");
	fs.mkdirSync(real);
	const link = path.join(base, "island");
	fs.symlinkSync(real, link);
	assert.throws(() => ensureIsland(link), /symlink/);
});

test("refuses world-writable path components without the sticky bit", unixOnly("Windows: the native helper refuses non-private ancestors (win-fs parent_ok / not-private refusals)"), (t) => {
	const base = tmpBase(t);
	const open = path.join(base, "open");
	fs.mkdirSync(open);
	fs.chmodSync(open, 0o777);
	assert.throws(() => ensureIsland(path.join(open, "island")), /world-writable/);
});

test("fails closed when the island root is owned by another user (root)", (t) => {
	if (!POSIX) return t.skip("POSIX ownership checks");
	const base = tmpBase(t);
	const root = path.join(base, "island");
	fs.mkdirSync(root, { mode: 0o700 });
	// Injecting a foreign uid emulates a root- or attacker-owned directory.
	assert.throws(() => ensurePrivateDir(root, { uid: process.getuid() + 1 }), /owned by uid/);
	assert.throws(() => assertSecurePath(path.join(root, "deep"), { uid: 0 }), /owned by uid|world-writable|not a directory|refusing/);
});

test("tightens an existing 0755 island root to 0700", (t) => {
	const base = tmpBase(t);
	const root = path.join(base, "island");
	fs.mkdirSync(root, { mode: 0o755 });
	const island = ensureIsland(root);
	assertMode(island.root, 0o700);
});

test("assertSecurePath accepts normal absolute system paths", () => {
	const absolute = assertSecurePath(path.join(os.tmpdir(), "does-not-exist-yet"));
	assert.ok(path.isAbsolute(absolute));
});

test("writePrivateFile writes 0600 atomically and re-enforces 0600 on permissive existing files", (t) => {
	const base = tmpBase(t);
	const dir = path.join(base, "d");
	fs.mkdirSync(dir, { mode: 0o700 });
	const target = path.join(dir, "f.json");
	writePrivateFile(target, '{"a":1}\n');
	assertMode(target, 0o600);
	assert.equal(fs.readFileSync(target, "utf8"), '{"a":1}\n');
	fs.chmodSync(target, 0o644);
	writePrivateFile(target, '{"a":2}\n');
	assertMode(target, 0o600);
	assert.equal(fs.readFileSync(target, "utf8"), '{"a":2}\n');
});

test("writePrivateFile refuses symlinked targets and leaves the victim intact", (t) => {
	const base = tmpBase(t);
	const dir = path.join(base, "d");
	fs.mkdirSync(dir);
	const victim = path.join(base, "victim.txt");
	fs.writeFileSync(victim, "keep\n");
	const target = path.join(dir, "f");
	fs.symlinkSync(victim, target);
	// Same refusal rule, platform message: POSIX names the symlink, the Windows helper names the reparse point.
	assert.throws(() => writePrivateFile(target, "evil\n"), win ? /reparse/ : /symlink/);
	assert.equal(fs.readFileSync(victim, "utf8"), "keep\n");
	assert.ok(fs.lstatSync(target).isSymbolicLink(), "symlink must be left in place, not replaced");
});

test("ensureIsland refuses a .engram/config.json replaced by a symlink and leaves the victim intact", (t) => {
	const base = tmpBase(t);
	const root = path.join(base, "island");
	const island = ensureIsland(root);
	const victim = path.join(base, "victim.json");
	fs.writeFileSync(victim, '{"project_name":"other"}\n');
	const config = path.join(island.workspace, ".engram", "config.json");
	fs.rmSync(config);
	fs.symlinkSync(victim, config);
	// Same refusal rule, platform message: POSIX says symlink, the Windows helper says reparse point.
	assert.throws(() => ensureIsland(root), win ? /reparse/ : /symlink/);
	assert.equal(fs.readFileSync(victim, "utf8"), '{"project_name":"other"}\n');
});

// ----- K2-05 T1c (S5/L11): Koda's private memory lifecycle ------------------
//
// Koda's memory is ALWAYS private (no user-store mode): the store lives inside
// the island (the engine's HOME is <island>/home and Engram defaults its store
// to <HOME>/.engram when ENGRAM_DATA_DIR is unset — exactly where Gentle Dot's
// private mode puts it) and the server runs on Koda's own port. Ported from
// Gentle Dot's privateMemory (packages/daemon/src/isolation.ts:155-300, MIT,
// Copyright (c) 2026 Gentleman Programming): the daemon owns cleanup only
// after confirming an EMPTY private port before startup; a failed or ambiguous
// lookup refuses ownership, not startup; and before SIGTERM both the private
// data identity (<island>/home/.engram/.instance-id) and a repeated stable
// listener PID must match. A server that is not Koda's is never touched.

const { PRIVATE_ENGRAM_PORT, PRIVATE_ENGRAM_PORT_ENV, assertPrivateMemoryPort, privateMemory, privateMemoryPort } = require("../src/isolation.cjs");

const INSTANCE_ID = "ab12".repeat(8); // 32 hex chars, like Engram writes it
const PID = 4242;

/**
 * A programmable lsof-style listener lookup seam. `lookup()` answers like
 * `lsof -w -t -n -P -iTCP:<port> -sTCP:LISTEN`: an empty stdout with exit 0
 * when nothing listens, the pid(s) when one does, a nonzero exit + stderr on
 * failure. `occupy(pids)` makes every later lookup answer those pids.
 */
function listenerSeam(extra = {}) {
	const seam = {
		calls: [],
		occupied: [],
		lookup: async (command, args) => {
			seam.calls.push({ command, args });
			const stdout = seam.occupied.join("\n");
			return { code: stdout === "" ? (extra.emptyCode ?? 0) : 0, stdout, stderr: stdout === "" ? (extra.emptyStderr ?? "") : "" , ...extra.result };
		},
	};
	return seam;
}

/** Writes the instance-id file the engine's own Engram server leaves behind. */
function writeInstanceId(island, id = INSTANCE_ID) {
	fs.mkdirSync(path.join(island.home, ".engram"), { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(island.home, ".engram", ".instance-id"), `${id}\n`, { mode: 0o600 });
}

test("privateMemoryPort defaults to Koda's private port and honours KODA_ENGRAM_PORT", () => {
	assert.equal(PRIVATE_ENGRAM_PORT, "7439", "one above Gentle Dot's own private port (7438): never the user's 7437/7438");
	assert.equal(privateMemoryPort({}), "7439");
	assert.equal(privateMemoryPort({ [PRIVATE_ENGRAM_PORT_ENV]: "7499" }), "7499");
	assert.equal(privateMemoryPort({ [PRIVATE_ENGRAM_PORT_ENV]: "" }), "7439");
});

test("privateMemory refuses an invalid port as a configuration error", async () => {
	for (const bad of ["0", "-1", "abc", "70000", "1.5"]) {
		await assert.rejects(
			() => privateMemory({ [PRIVATE_ENGRAM_PORT_ENV]: bad }, "/tmp/nowhere", () => {}, { runListenerCommand: async () => ({ code: 0, stdout: "", stderr: "" }) }),
			/port/,
			`port ${JSON.stringify(bad)} must be refused`,
		);
	}
});

test("privateMemory owns a confirmed-empty port and stops Koda's own listener after identity checks", async (t) => {
	const island = ensureIsland(path.join(tmpBase(t), "island"));
	writeInstanceId(island);
	const seam = listenerSeam();
	const kills = [];
	const logs = [];
	const memory = await privateMemory(
		{},
		island.root,
		(line) => logs.push(line),
		{
			runListenerCommand: (command, args) => seam.lookup(command, args),
			kill: (pid, signal) => kills.push({ pid, signal }),
			health: async () => ({ instance_id: INSTANCE_ID }),
		},
	);
	assert.ok(memory, "a confirmed-empty port is owned");
	assert.equal(seam.calls.length, 1, "the port is checked once BEFORE startup");
	// Now a listener appears (the engine's own Engram server), and the stop
	// verifies it three ways: same pid, the island's instance id, /health.
	seam.occupied = [PID];
	await memory.stop();
	assert.deepEqual(kills, [{ pid: PID, signal: "SIGTERM" }]);
	assert.ok(!logs.some((line) => /left running|serves other data/.test(line)), JSON.stringify(logs));
});

test("privateMemory refuses ownership when the port state is unknown, and never kills anything", async (t) => {
	const island = ensureIsland(path.join(tmpBase(t), "island"));
	writeInstanceId(island);
	for (const broken of [
		{ code: 1, stdout: "", stderr: "lsof complained" }, // failed lookup
		{ code: 0, stdout: "111\n222\n", stderr: "" }, // ambiguous: two listeners
		{ code: 0, stdout: "not-a-pid\n", stderr: "" }, // unparseable output
	]) {
		const kills = [];
		const logs = [];
		const memory = await privateMemory(
			{},
			island.root,
			(line) => logs.push(line),
			{
				runListenerCommand: async () => broken,
				kill: (pid, signal) => kills.push({ pid, signal }),
				health: async () => ({ instance_id: INSTANCE_ID }),
			},
		);
		assert.equal(memory, undefined, `${JSON.stringify(broken)} owns nothing`);
		assert.deepEqual(kills, [], "nothing is ever signalled from an unknown state");
		assert.ok(
			logs.some((line) => /cannot verify private memory listener/.test(line) && /will not stop it/.test(line)),
			`the refusal is reported: ${JSON.stringify(logs)}`,
		);
	}
});

test("privateMemory never owns a port that already has a listener at startup", async (t) => {
	const island = ensureIsland(path.join(tmpBase(t), "island"));
	const seam = listenerSeam();
	seam.occupied = [PID];
	const kills = [];
	const memory = await privateMemory(
		{},
		island.root,
		() => {},
		{
			runListenerCommand: (command, args) => seam.lookup(command, args),
			kill: (pid, signal) => kills.push({ pid, signal }),
			health: async () => ({ instance_id: INSTANCE_ID }),
		},
	);
	assert.equal(memory, undefined, "an existing listener is never claimed");
	assert.deepEqual(kills, []);
});

test("privateMemory never stops a listener that is not Koda's own (instance id, /health, pid stability)", async (t) => {
	const island = ensureIsland(path.join(tmpBase(t), "island"));

	// No ownership at all: the port was not empty before startup, so stop() is
	// never even reachable — a pre-taken port has no handle to stop.
	{
		const kills = [];
		const memory = await privateMemory(
			{},
			island.root,
			() => {},
			{
				runListenerCommand: async () => ({ code: 0, stdout: String(PID), stderr: "" }),
				kill: (pid, signal) => kills.push({ pid, signal }),
				health: async () => ({ instance_id: INSTANCE_ID }),
			},
		);
		assert.equal(memory, undefined);
		assert.deepEqual(kills, []);
	}

	// Owned at startup (empty port), then every stop-time refusal shape:
	writeInstanceId(island, INSTANCE_ID);
	// `stopLookups` feed the stop() lookups in order: first the listener pid,
	// then the stability re-check. The creation lookup is always empty.
	const stops = async (health, stopLookups) => {
		const lookups = ["", ...stopLookups];
		const owned = [];
		const memory = await privateMemory(
			{},
			island.root,
			() => {},
			{
				runListenerCommand: async () => ({ code: 0, stdout: lookups.length > 0 ? lookups.shift() : "", stderr: "" }),
				kill: (pid, signal) => owned.push({ pid, signal }),
				health,
			},
		);
		assert.ok(memory, "the empty port at startup is owned");
		await memory.stop();
		return owned;
	};
	assert.deepEqual(await stops(async () => ({ instance_id: "f".repeat(32) }), [String(PID), String(PID)]), [], "a foreign /health identity is never signalled");
	assert.deepEqual(await stops(async () => Promise.reject(new Error("boom")), [String(PID), String(PID)]), [], "an unreachable /health is never signalled");
	assert.deepEqual(await stops(async () => ({ instance_id: undefined }), [String(PID), String(PID)]), [], "an identity-less /health is never signalled");
	assert.deepEqual(
		await stops(
			async () => ({ instance_id: INSTANCE_ID }),
			[""], // the stop-time lookup finds NOTHING: gone already, nothing to kill
		),
		[],
		"a vanished listener is never signalled",
	);
	// The island identity file itself is gone (another daemon swept it, say):
	// ownership cannot be proven, so nothing is signalled.
	fs.rmSync(path.join(island.home, ".engram", ".instance-id"));
	assert.deepEqual(await stops(async () => ({ instance_id: INSTANCE_ID }), [String(PID), String(PID)]), [], "a missing instance-id file is never signalled");
	// The listener PID changed between the two stop-time lookups (pid reuse or a
	// handover): the repeated-PID check refuses, nothing is signalled.
	writeInstanceId(island);
	assert.deepEqual(await stops(async () => ({ instance_id: INSTANCE_ID }), [String(PID), "9999"]), [], "an unstable listener pid is never signalled");
});

// ----- F2/F3 (verifier follow-ups, K2-05 T1c, commit e141ed1) ----------------

test("privateMemory refuses the user's own Engram ports as a configuration error (F3)", async () => {
	for (const reserved of ["7437", "7438"]) {
		await assert.rejects(
			() => privateMemory({ [PRIVATE_ENGRAM_PORT_ENV]: reserved }, "/tmp/nowhere", () => {}, {}),
			new RegExp(`${reserved} belongs to the user's own Engram server`),
			`port ${reserved} must be refused`,
		);
	}
});

test("a zero-padded port is refused, so it can never reach the user's 7437/7438 (F3 follow-up)", async () => {
	// gentle-engram parses ENGRAM_PORT with Number.parseInt, so "07437" would mean the user's 7437.
	for (const padded of ["07437", "007438", "07439", "0"]) {
		await assert.rejects(
			() => privateMemory({ [PRIVATE_ENGRAM_PORT_ENV]: padded }, "/tmp/nowhere", () => {}, {}),
			/port must be an integer from 1 to 65535/,
			`port ${padded} must be refused`,
		);
		assert.throws(() => assertPrivateMemoryPort(padded), /port must be an integer from 1 to 65535/);
	}
});

test("privateMemory reclaims an orphaned listener that is provably Koda's own (F2)", async (t) => {
	const island = ensureIsland(path.join(tmpBase(t), "island"));
	writeInstanceId(island);
	const seam = listenerSeam();
	seam.occupied = [PID];
	const kills = [];
	const logs = [];
	const memory = await privateMemory(
		{},
		island.root,
		(line) => logs.push(line),
		{
			runListenerCommand: (command, args) => seam.lookup(command, args),
			kill: (pid, signal) => kills.push({ pid, signal }),
			health: async () => ({ instance_id: INSTANCE_ID }),
		},
	);
	assert.ok(memory, "an orphaned server proven to be Koda's own (instance id + /health + stable pid) is reclaimed");
	assert.ok(logs.some((line) => /reclaimed/.test(line)), JSON.stringify(logs));
	await memory.stop();
	assert.deepEqual(kills, [{ pid: PID, signal: "SIGTERM" }], "the reclaimed orphan is stopped at daemon shutdown");
});

test("privateMemory never reclaims a listener it cannot prove is Koda's own (F2)", async (t) => {
	const kills = [];
	const logs = [];
	const refuse = async (island, seamOptions, health) => {
		const memory = await privateMemory(
			{},
			island.root,
			(line) => logs.push(line),
			{ kill: (pid, signal) => kills.push({ pid, signal }), health, ...seamOptions },
		);
		assert.equal(memory, undefined);
	};

	// A listener without the island's identity file behind it: never proven Koda's own.
	const bare = ensureIsland(path.join(tmpBase(t), "bare"));
	await refuse(bare, { runListenerCommand: async () => ({ code: 0, stdout: String(PID), stderr: "" }) }, async () => ({ instance_id: INSTANCE_ID }));

	// /health answers with a DIFFERENT instance id: a foreign server on the port.
	const foreign = ensureIsland(path.join(tmpBase(t), "foreign"));
	writeInstanceId(foreign);
	await refuse(foreign, { runListenerCommand: async () => ({ code: 0, stdout: String(PID), stderr: "" }) }, async () => ({ instance_id: "f".repeat(32) }));

	// The listener pid changed between the claim lookups: not a stable orphan.
	const unstable = ensureIsland(path.join(tmpBase(t), "unstable"));
	writeInstanceId(unstable);
	let flip = false;
	await refuse(unstable, {
		runListenerCommand: async () => {
			flip = !flip;
			return { code: 0, stdout: flip ? String(PID) : "9999", stderr: "" };
		},
	}, async () => ({ instance_id: INSTANCE_ID }));

	assert.ok(
		logs.some((line) => /cannot read the private memory identity|serves other data|changed on port/.test(line)),
		`every refusal is reported: ${JSON.stringify(logs)}`,
	);
	assert.deepEqual(kills, [], "nothing is ever signalled from an unproven claim");
});

/** An lsof-missing + ss-answer seam for the Linux fallback (F2). */
function ssSeam({ ssCode = 0, ssStderr = "", ssLines = [], lsofMissing = true } = {}) {
	const calls = [];
	return {
		calls,
		runListenerCommand: async (command) => {
			calls.push(command);
			if (command === "lsof") return { code: lsofMissing ? -1 : 1, stdout: "", stderr: lsofMissing ? "" : "lsof complained", missing: lsofMissing };
			if (command !== "ss") throw new Error(`unexpected command ${command}`);
			return { code: ssCode, stdout: ssLines.join("\n"), stderr: ssStderr };
		},
	};
}

const SS_OWN = `LISTEN 0      4096        127.0.0.1:7439       0.0.0.0:*    users:(("engram",pid=${PID},fd=9))`;
const SS_FOREIGN_PORT = `LISTEN 0      4096        127.0.0.1:7437       0.0.0.0:*    users:(("engram",pid=4347,fd=9))`;
const SS_UNATTRIBUTABLE = "LISTEN 0      4096        0.0.0.0:7439         0.0.0.0:*";
const SS_SHARED = `LISTEN 0      4096        127.0.0.1:7439       0.0.0.0:*    users:(("engram",pid=${PID},fd=9),("other",pid=777,fd=2))`;

test("the listener lookup falls back to ss on Linux when lsof is missing, with the same fail-closed rules (F2)", async (t) => {
	const island = ensureIsland(path.join(tmpBase(t), "island"));
	writeInstanceId(island);
	const kills = [];
	const boot = async ({ seam, platform = "linux" }) =>
		privateMemory({}, island.root, () => {}, { platform, kill: (pid, signal) => kills.push({ pid, signal }), health: async () => ({ instance_id: INSTANCE_ID }), runListenerCommand: seam.runListenerCommand });

	// lsof missing + ss reports Koda's own orphan: reclaimed, stopped at shutdown.
	{
		const seam = ssSeam({ ssLines: [SS_OWN] });
		const memory = await boot({ seam });
		assert.deepEqual(seam.calls, ["lsof", "ss", "lsof", "ss"], "lsof first, then the ss fallback — for the claim lookup AND its stability re-check");
		assert.ok(memory, "the ss-parsed pid is reclaimed like an lsof one");
		await memory.stop();
		assert.deepEqual(kills, [{ pid: PID, signal: "SIGTERM" }]);
	}

	// ss shows only a foreign port: our port is empty, so a fresh boot owns it.
	{
		const seam = ssSeam({ ssLines: [SS_FOREIGN_PORT] });
		const memory = await boot({ seam });
		assert.ok(memory, "a port that is free for Koda is owned");
	}

	// ss shows a listener on our port it cannot attribute (no pid visible):
	// unknown state, never claimed, nothing signalled.
	{
		const logs = [];
		const seam = ssSeam({ ssLines: [SS_UNATTRIBUTABLE] });
		const memory = await privateMemory({}, island.root, (line) => logs.push(line), { platform: "linux", kill: (pid, signal) => kills.push({ pid, signal }), health: async () => ({ instance_id: INSTANCE_ID }), runListenerCommand: seam.runListenerCommand });
		assert.equal(memory, undefined, "an unattributable ss listener refuses ownership");
		assert.ok(logs.some((line) => /cannot verify private memory listener/.test(line) && /will not stop it/.test(line)), JSON.stringify(logs));
	}

	// ss shows TWO pids sharing our port: ambiguous, never claimed.
	{
		const seam = ssSeam({ ssLines: [SS_SHARED] });
		const memory = await boot({ seam });
		assert.equal(memory, undefined, "an ambiguous ss listener refuses ownership");
	}

	// ss itself is missing or fails: unknown state, never claimed.
	for (const broken of [{ ssCode: -1, ssStderr: "", lsofMissing: true, missing: true }, { ssCode: 1, ssStderr: "ss complained" }]) {
		const seam = ssSeam(broken);
		const memory = await boot({ seam });
		assert.equal(memory, undefined, `ss failure ${JSON.stringify(broken)} refuses ownership`);
	}

	// No platform crossover: without lsof on macOS the lookup is simply unknown.
	{
		const seam = ssSeam({ ssLines: [SS_OWN] });
		const memory = await boot({ seam, platform: "darwin" });
		assert.equal(memory, undefined, "the ss fallback is Linux-only");
	}
	assert.deepEqual(kills.slice(1), [], "refused shapes never signal anything");
});
