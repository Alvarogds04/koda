"use strict";

// U1 isolation tests: private island layout, fail-closed path checks, env allowlist.
// Everything runs against temporary fixtures; the user's real home is never touched.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
	MEMORY_PROJECT,
	assertSecurePath,
	defaultIslandRoot,
	ensureIsland,
	ensurePrivateDir,
	isolatedEnv,
	writePrivateFile,
} = require("../src/isolation.cjs");

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
		assert.equal(fs.statSync(dir).mode & 0o777, 0o700, `0700 expected for ${dir}`);
	}
	// XDG directories live inside the private home.
	for (const dir of [".config", ".cache", path.join(".local", "share"), path.join(".local", "state")]) {
		assert.equal(fs.statSync(path.join(island.home, dir)).mode & 0o777, 0o700);
	}
	// The owned default workspace pins the memory project.
	const config = JSON.parse(fs.readFileSync(path.join(island.workspace, ".engram", "config.json"), "utf8"));
	assert.equal(config.project_name, MEMORY_PROJECT);
	assert.equal(MEMORY_PROJECT, "abito-island");
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
			ENGRAM_PORT: "7437",
		},
		island,
		{ ABITO_MEMORY_PROJECT: "abito-island" },
	);

	assert.equal(env.HOME, island.home);
	assert.equal(env.TMPDIR, island.tmp);
	assert.equal(env.XDG_CONFIG_HOME, path.join(island.home, ".config"));
	assert.equal(env.XDG_DATA_HOME, path.join(island.home, ".local", "share"));
	assert.equal(env.XDG_CACHE_HOME, path.join(island.home, ".cache"));
	assert.equal(env.XDG_STATE_HOME, path.join(island.home, ".local", "state"));
	assert.equal(env.PI_CODING_AGENT_DIR, island.agentDir);
	assert.equal(env.PI_OFFLINE, "1");
	assert.equal(env.PI_SKIP_VERSION_CHECK, "1");
	assert.equal(env.PI_TELEMETRY, "0");

	// Inherited secrets, parent Pi setup, session state and foreign settings are dropped.
	assert.equal(env.ANTHROPIC_API_KEY, undefined);
	assert.equal(env.OPENAI_API_KEY, undefined);
	assert.equal(env.GENTLE_PI_AGENT_HOME, undefined);
	assert.equal(env.ENGRAM_PORT, undefined);
	for (const key of Object.keys(env)) {
		if (key.startsWith("PI_")) {
			assert.ok(
				["PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_SKIP_VERSION_CHECK", "PI_TELEMETRY"].includes(key),
				`unexpected inherited PI_ variable: ${key}`,
			);
		}
	}
	// OS essentials survive, and explicit overrides are honoured.
	assert.equal(env.PATH, "/usr/local/bin:/usr/bin:/bin");
	assert.equal(env.LANG, "es_ES.UTF-8");
	assert.equal(env.SHELL, "/bin/zsh");
	assert.equal(env.ABITO_MEMORY_PROJECT, "abito-island");
});

test("defaultIslandRoot honours ABITO_ISLAND_DIR and defaults to ~/.abito-island", () => {
	assert.equal(defaultIslandRoot({ ABITO_ISLAND_DIR: "/x/y" }), "/x/y");
	assert.equal(defaultIslandRoot({ HOME: "/home/user" }), path.join("/home/user", ".abito-island"));
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

test("refuses world-writable path components without the sticky bit", (t) => {
	const base = tmpBase(t);
	const open = path.join(base, "open");
	fs.mkdirSync(open);
	fs.chmodSync(open, 0o777);
	assert.throws(() => ensureIsland(path.join(open, "island")), /world-writable/);
});

test("fails closed when the island root is owned by another user (root)", (t) => {
	if (!POSIX) t.skip("POSIX ownership checks");
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
	assert.equal(fs.statSync(island.root).mode & 0o777, 0o700);
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
	assert.equal(fs.statSync(target).mode & 0o777, 0o600);
	assert.equal(fs.readFileSync(target, "utf8"), '{"a":1}\n');
	fs.chmodSync(target, 0o644);
	writePrivateFile(target, '{"a":2}\n');
	assert.equal(fs.statSync(target).mode & 0o777, 0o600);
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
	assert.throws(() => writePrivateFile(target, "evil\n"), /symlink/);
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
	assert.throws(() => ensureIsland(root), /symlink/);
	assert.equal(fs.readFileSync(victim, "utf8"), '{"project_name":"other"}\n');
});
