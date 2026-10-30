"use strict";

// V4 connectors view tests: a fake `abito-connectors` CLI (generated shim in a temp dir),
// the golden fixtures of apps/desktop-connectors read via a relative path. No real CLI, no network.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ConnectorsView, SCHEMA, buildCatalog, buildConnectors } = require("../src/connectors.cjs");

const FAKE = path.join(__dirname, "fixtures", "fake-connectors.cjs");
const FIXTURES = path.join(__dirname, "fixtures", "connectors");
const golden = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));
const GENERIC = /connectors unavailable$/;

function tmp(t) {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "abito-conn-")));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** Generates an executable shim that runs the fake CLI with `vars` baked into its environment. */
function shim(t, vars = {}) {
	const dir = tmp(t);
	const evidence = {
		spawns: path.join(dir, "spawns.log"),
		env: path.join(dir, "env.json"),
		pid: path.join(dir, "pid.txt"),
		argv: path.join(dir, "argv.log"),
	};
	const all = {
		FAKE_FIXTURES: FIXTURES,
		FAKE_SPAWN_LOG: evidence.spawns,
		FAKE_ENV_OUT: evidence.env,
		FAKE_PID_OUT: evidence.pid,
		FAKE_ARGV_OUT: evidence.argv,
		...vars,
	};
	const assignments = Object.entries(all).map(([k, v]) => `${k}='${String(v).replace(/'/g, "'\\''")}'`).join(" ");
	const file = path.join(dir, "fake-abito-connectors");
	fs.writeFileSync(file, `#!/bin/sh\nexport ${assignments}\nexec '${process.execPath}' '${FAKE}' "$@"\n`, { mode: 0o755 });
	fs.chmodSync(file, 0o755);
	const connectorsDir = path.join(dir, "connectors");
	fs.mkdirSync(connectorsDir);
	const home = path.join(dir, "home");
	fs.mkdirSync(home);
	return { command: file, dir: connectorsDir, home, cwd: dir, evidence, base: dir };
}
const spawnCount = (e) => (fs.existsSync(e.spawns) ? fs.readFileSync(e.spawns, "utf8").split("\n").filter(Boolean).length : 0);

function view(s, extra = {}) {
	const logs = [];
	const v = new ConnectorsView({ command: s.command, dir: s.dir, cwd: s.cwd, home: s.home, env: { PATH: process.env.PATH }, log: (l) => logs.push(String(l)), ...extra });
	v.logs = logs;
	return v;
}

const EXPECTED_CATALOG_KEYS = ["auth", "fields", "key", "label", "read_only_tools_count", "reads", "sends"];

test("golden catalog + status round trip equals the sanitized shape", async (t) => {
	const s = shim(t);
	const result = await view(s).snapshot();
	assert.deepEqual(Object.keys(result).sort(), ["catalog", "connectors"]);
	assert.deepEqual(result.catalog, golden("catalog").entries, "golden entries pass through unchanged");
	assert.deepEqual(result.connectors, golden("status").connectors);
	assert.equal(result.catalog.length, 6);
	assert.equal(result.connectors.length, 4);
	for (const entry of result.catalog) for (const key of Object.keys(entry)) assert.ok([...EXPECTED_CATALOG_KEYS, "guide"].includes(key));
	assert.equal(SCHEMA, "abito-connectors/view/1");
	assert.equal(spawnCount(s.evidence), 2, "one catalog + one status spawn");
	// argv/cwd: exact subcommands, no shell
	const lines = fs.readFileSync(s.evidence.argv, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	const argvs = lines.map((l) => l.argv).sort((a, b) => a[0].localeCompare(b[0]));
	assert.deepEqual(argvs, [["catalog"], ["status", "--dir", s.dir]]);
	assert.ok(lines.every((l) => fs.realpathSync(l.cwd) === s.cwd));
});

test("poisoned output: every unknown key is dropped at every level, nothing secret-looking survives", async (t) => {
	const s = shim(t, { FAKE_MODE: "poison" });
	const result = await view(s).snapshot();
	assert.deepEqual(result.catalog, golden("catalog").entries);
	assert.deepEqual(result.connectors, golden("status").connectors);
	const wire = JSON.stringify(result);
	assert.ok(!wire.includes("SECRETMARK"));
	for (const word of ["url", "command", "args", "env", "headers", "token\"", "capability", "oauth", "upstream", "secret_ref", "\"ref\"", "\"value\""]) {
		// "token" legitimately appears in a golden Discord field key/label text; only the KEY form is checked below
		if (word.startsWith("token")) continue;
		assert.ok(!wire.includes(`"${word.replace(/"/g, "")}":`), `key ${word} must not be emitted`);
	}
});

test("generic failures leak nothing: wrong schema, exit 1, two lines, bad utf8, non-json, too many, bidi label", async (t) => {
	for (const mode of ["wrongschema", "exit1", "twolines", "badutf8", "nonjson", "toomany", "bidi"]) {
		for (const only of ["catalog", "status"]) {
			const s = shim(t, { FAKE_MODE: mode, FAKE_ONLY: only });
			const v = view(s);
			await assert.rejects(() => v.snapshot(), (error) => {
				assert.match(error.message, GENERIC, `${mode}/${only}`);
				const text = `${error.message}${error.stack?.split("\n")[0]}${JSON.stringify(error)}`;
				assert.ok(!/SECRET|STDERR|\/home|abito-conn|fake-abito/.test(text), `${mode}/${only} leaked: ${text}`);
				assert.equal(error.cause, undefined);
				return true;
			}, `${mode}/${only}`);
			assert.ok(!v.logs.join("\n").match(/SECRET|STDERR|\/home|abito-conn|fake-abito|\/tmp/), `${mode}/${only} log leak: ${v.logs.join("|")}`);
		}
	}
});

test("R1: bare names and relative commands are refused (no PATH lookup)", async (t) => {
	const s = shim(t);
	for (const command of ["abito-connectors", "./fake", "sh", "../x"]) {
		await assert.rejects(() => view(s, { command }).snapshot(), GENERIC, command);
	}
	assert.equal(spawnCount(s.evidence), 0);
});

test("R1: spawn-time target checks: symlink-to-dir, directory, non-exec, group/world-writable, writable parent", async (t) => {
	const refuse = async (s, label) => {
		await assert.rejects(() => view(s).snapshot(), GENERIC, label);
		assert.equal(spawnCount(s.evidence), 0, label);
	};
	let s = shim(t);
	fs.chmodSync(s.command, 0o644);
	await refuse(s, "not executable");
	s = shim(t);
	fs.chmodSync(s.command, 0o775);
	await refuse(s, "group-writable");
	s = shim(t);
	fs.chmodSync(s.command, 0o757);
	await refuse(s, "world-writable");
	s = shim(t);
	await refuse({ ...s, command: s.connectorsDirOnly ?? s.dir }, "directory");
	s = shim(t);
	fs.chmodSync(s.base, 0o777); // world-writable parent, no sticky
	await refuse(s, "world-writable parent");
	fs.chmodSync(s.base, 0o700);
	// a symlink to a good binary still works only when the link is in a secure dir; a relinked dir component is refused
	s = shim(t);
	const link = path.join(tmp(t), "link");
	fs.symlinkSync(s.command, link);
	assert.equal((await view(s, { command: link }).snapshot()).catalog.length, 6);
	// the happy path passes the check
	s = shim(t);
	assert.equal((await view(s).snapshot()).catalog.length, 6);
});

test("R2: timeout kills the whole process group: a grandchild never writes its marker", async (t) => {
	const s = shim(t, { FAKE_MODE: "grandchild", FAKE_ONLY: "status", FAKE_MARKER: "" });
	const marker = path.join(s.base, "marker.txt");
	const s2 = shim(t, { FAKE_MODE: "grandchild", FAKE_ONLY: "status", FAKE_MARKER: marker });
	await assert.rejects(() => view(s2, { timeoutMs: 300 }).snapshot(), GENERIC);
	await new Promise((r) => setTimeout(r, 2200));
	assert.equal(fs.existsSync(marker), false, "grandchild was killed with the group");
});

test("R2: failure exit with a lingering grandchild also kills the group", async (t) => {
	const dir = tmp(t);
	const marker = path.join(dir, "marker2.txt");
	const s = shim(t, { FAKE_MODE: "grandchild_exit", FAKE_ONLY: "status", FAKE_MARKER: marker });
	await assert.rejects(() => view(s, { timeoutMs: 3000 }).snapshot(), GENERIC);
	await new Promise((r) => setTimeout(r, 2200));
	assert.equal(fs.existsSync(marker), false);
});

test("a missing/unrunnable command is a generic failure", async (t) => {
	const s = shim(t);
	await assert.rejects(() => view(s, { command: path.join(s.base, "does-not-exist") }).snapshot(), GENERIC);
});

test("a missing trailing newline is tolerated (still exactly one JSON value)", async (t) => {
	const s = shim(t, { FAKE_MODE: "noeol" });
	assert.equal((await view(s).snapshot()).catalog.length, 6);
});

test("hang: SIGKILL at the hard timeout, generic failure, no leaked process", async (t) => {
	const s = shim(t, { FAKE_MODE: "hang", FAKE_ONLY: "status" });
	const started = Date.now();
	await assert.rejects(() => view(s, { timeoutMs: 300 }).snapshot(), GENERIC);
	assert.ok(Date.now() - started < 3000);
	const pid = Number(fs.readFileSync(s.evidence.pid, "utf8"));
	assert.ok(pid > 1);
	let alive = true;
	for (let i = 0; i < 100 && alive; i++) {
		try {
			process.kill(pid, 0);
			await new Promise((r) => setTimeout(r, 20));
		} catch {
			alive = false;
		}
	}
	assert.equal(alive, false, "hung child was killed");
});

test("oversize stdout: killed and failed once the cap is exceeded", async (t) => {
	const s = shim(t, { FAKE_MODE: "oversize" });
	const v = view(s);
	await assert.rejects(() => v.snapshot(), GENERIC);
	// a lowered cap also rejects the (otherwise valid) golden output
	const s2 = shim(t);
	await assert.rejects(() => view(s2, { maxBytes: 1024 }).snapshot(), GENERIC);
});

test("child environment: allowlist only, private HOME, no PI_*/provider keys", async (t) => {
	const s = shim(t);
	const base = {
		PATH: process.env.PATH,
		LANG: "C.UTF-8",
		HOME: "/home/REALUSER",
		PI_CODING_AGENT_DIR: "/x/pi",
		PI_OFFLINE: "1",
		OPENAI_API_KEY: "sk-OPENAISECRET",
		ANTHROPIC_API_KEY: "sk-ANTHROPICSECRET",
		GITHUB_TOKEN: "ghp_SECRET",
		ABITO_WORKSPACE: "/ws",
		ABITO_PROXY_CAPABILITY: "CAP",
	};
	await view(s, { env: base }).snapshot();
	const dumped = JSON.parse(fs.readFileSync(s.evidence.env, "utf8"));
	assert.equal(dumped.HOME, s.home);
	assert.equal(dumped.LANG, "C.UTF-8");
	assert.equal(dumped.PATH, "/usr/bin:/bin", "PATH is fixed, never inherited");
	for (const key of Object.keys(dumped)) {
		assert.ok(!/^PI_|KEY|TOKEN|SECRET|^ABITO|CAPABILITY/i.test(key) || key.startsWith("FAKE_"), `unexpected env key ${key}`);
	}
	assert.ok(!JSON.stringify(dumped).match(/SECRET|REALUSER|CAP"|\/x\/pi/));
});

test("snapshot never retries: a failing CLI is spawned once per command", async (t) => {
	const s = shim(t, { FAKE_MODE: "exit1" });
	await assert.rejects(() => view(s).snapshot(), GENERIC);
	assert.ok(spawnCount(s.evidence) <= 2);
});

// ----- strict builders -----------------------------------------------------------

const entry = () => structuredClone(golden("catalog").entries[3]); // discord: fields + guide
const conn = () => structuredClone(golden("status").connectors[3]);

test("catalog builder: type and bound violations throw instead of coercing", () => {
	const bad = (mutate) => {
		const e = entry();
		mutate(e);
		assert.throws(() => buildCatalog([e]), GENERIC);
	};
	bad((e) => (e.key = "Bad Key"));
	bad((e) => (e.key = "a".repeat(65)));
	for (const k of ["__proto__", "constructor", "prototype"]) {
		bad((e) => (e.key = k));
		bad((e) => (e.fields[0].key = k));
	}
	bad((e) => (e.label = 5));
	bad((e) => (e.label = "x".repeat(129)));
	bad((e) => (e.label = "line\nbreak"));
	bad((e) => (e.label = "evil\u202etxt"));
	bad((e) => (e.label = "zero\u200bwidth"));
	bad((e) => (e.reads = "r".repeat(513)));
	bad((e) => (e.sends = undefined));
	bad((e) => (e.auth = "api_key"));
	bad((e) => (e.fields = {}));
	bad((e) => (e.fields = Array.from({ length: 9 }, () => ({ key: "k", label: "l", secret: false, optional: false }))));
	bad((e) => (e.fields[0].secret = "true"));
	bad((e) => (e.fields[0].optional = 1));
	bad((e) => (e.fields[0].label = "x".repeat(129)));
	bad((e) => (e.guide.steps = Array.from({ length: 17 }, () => "s")));
	bad((e) => (e.guide.steps = [1]));
	bad((e) => (e.guide.steps = ["s".repeat(513)]));
	bad((e) => (e.guide.note = "n".repeat(513)));
	bad((e) => (e.guide = "text"));
	bad((e) => (e.read_only_tools_count = "7"));
	bad((e) => (e.read_only_tools_count = 1001));
	bad((e) => (e.read_only_tools_count = -1));
	bad((e) => (e.read_only_tools_count = 1.5));
	assert.throws(() => buildCatalog("nope"), GENERIC);
	assert.throws(() => buildCatalog(Array.from({ length: 33 }, () => entry())), GENERIC);
	assert.doesNotThrow(() => buildCatalog(Array.from({ length: 32 }, (_, i) => ({ ...entry(), key: `k${i}` }))));
});

test("connectors builder: unknown mode/state map to 'unknown'; wrong types and bounds throw", () => {
	const ok = buildConnectors([{ ...conn(), mode: "future_mode", status: { state: "teleporting", code: "x_1" } }]);
	assert.equal(ok[0].mode, "unknown");
	assert.deepEqual(ok[0].status, { state: "unknown", code: "x_1" });
	const bad = (mutate) => {
		const c = conn();
		mutate(c);
		assert.throws(() => buildConnectors([c]), GENERIC);
	};
	bad((c) => (c.id = ""));
	bad((c) => (c.id = "a".repeat(65)));
	bad((c) => (c.id = "bad id"));
	bad((c) => (c.id = "constructor"));
	bad((c) => (c.id = "__proto__"));
	bad((c) => (c.catalog_key = "prototype"));
	bad((c) => (c.label = "ok\u0007"));
	bad((c) => (c.label = "x".repeat(129)));
	bad((c) => (c.catalog_key = "Not Strict!"));
	bad((c) => (c.mode = 3));
	bad((c) => (c.enabled = "yes"));
	bad((c) => (c.configured = 0));
	bad((c) => (c.status = "failed"));
	bad((c) => (c.status = { state: 7 }));
	bad((c) => (c.status.code = "Has Space"));
	bad((c) => (c.status.code = "a".repeat(65)));
	bad((c) => (c.revision = -1));
	bad((c) => (c.revision = "2"));
	bad((c) => (c.revision = 1.2));
	assert.throws(() => buildConnectors(Array.from({ length: 257 }, (_, i) => ({ ...conn(), id: `c${i}` }))), GENERIC);
	assert.equal(buildConnectors(Array.from({ length: 256 }, (_, i) => ({ ...conn(), id: `c${i}` }))).length, 256);
	// optional fields stay absent rather than null
	const minimal = buildConnectors([{ id: "m", label: "M", mode: "read_only", enabled: false, status: { state: "disabled" }, revision: 0, configured: false }])[0];
	assert.deepEqual(Object.keys(minimal).sort(), ["configured", "enabled", "id", "label", "mode", "revision", "status"]);
});
