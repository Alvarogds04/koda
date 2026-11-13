"use strict";

// AgentsManager unit tests against a FAKE installer (test/fixtures/fake-installer.cjs). Temp dirs only:
// the real ~/.claude, ~/.codex and ~/.koda are never touched.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { spawnSync } = require("node:child_process");
const { AgentsManager } = require("../src/agents.cjs");
const { win, unixOnly } = require("./platform-env.cjs");

const FIXTURE = path.join(__dirname, "fixtures", "fake-installer.cjs");
/**
 * The keys a process gets BEYOND the env block it was handed, asked to this same OS instead of being listed by hand.
 * The fake installer records its own process.env, so the OS-injected keys show up in what it recorded even though the
 * product passed an allowlisted env: Windows adds profile and system facts (HOMEDRIVE/HOMEPATH, LOGONSERVER,
 * SYSTEMDRIVE, SYSTEMROOT, ...) and darwin adds __CF_USER_TEXT_ENCODING at exec (CoreFoundation). Adding those names one
 * CI failure at a time is a treadmill (CI 41729969464, 43263659882, 43319173068 each added one) and a hand-written list is
 * always one runner image behind, so the set is DERIVED: this Node is spawned once with a single marker variable and the
 * keys that come back are exactly what the OS injects. It stays non-tautological: a leaked marker of the parent (a real
 * variable the product did not pass) is in neither the pinned set nor this one, so the leak assertion still fails.
 */
const ENV_PROBE_KEY = "ABITO_ENV_PROBE";
const OS_INJECTED_ENV = (() => {
	const probe = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(Object.keys(process.env)))"], {
		env: { [ENV_PROBE_KEY]: "1" }, encoding: "utf8", timeout: 60_000, windowsHide: true,
	});
	if (probe.status !== 0 || typeof probe.stdout !== "string") throw new Error(`env probe failed: ${probe.status} ${probe.stderr ?? probe.error ?? ""}`);
	const keys = JSON.parse(probe.stdout);
	if (!Array.isArray(keys) || !keys.includes(ENV_PROBE_KEY)) throw new Error("env probe did not report its own marker");
	return keys.filter((key) => key !== ENV_PROBE_KEY);
})();
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_R = "c".repeat(64);
const SCHEMA = "abito-hook-install/1";

function preview({ harness = "claude", action = "install", ops = ["add", "add"], changed, hash = HASH_A, hidden = 0, lines = ["@@ -1 +1 @@", "+ x"], target } = {}) {
	const file = { claude: "settings.json", copilot: "abito-island.json", opencode: "abito-island.js" }[harness] ?? "hooks.json";
	const dir = { claude: ".claude", copilot: ".copilot/hooks", opencode: ".config/opencode/plugins" }[harness] ?? ".codex";
	return {
		schema: SCHEMA,
		ok: true,
		mode: "preview",
		harness,
		action,
		target: target ?? path.join("@HOME@", dir, file),
		exists: true,
		changed: changed ?? ops.some((o) => o !== "keep"),
		entries: {
			claude: [
				{ event: "PermissionRequest", op: ops[0] },
				{ event: "SessionStart", op: ops[0] },
				{ event: "Stop", op: ops[1] },
			],
			codex: [
				{ event: "PermissionRequest", op: ops[0] },
				{ event: "PreToolUse", op: ops[0] },
				{ event: "PostToolUse", op: ops[0] },
				{ event: "Stop", op: ops[1] },
			],
			copilot: [
				{ event: "permissionRequest", op: ops[0] },
				{ event: "sessionEnd", op: ops[1] },
			],
			opencode: [
				{ event: "permission.ask", op: ops[0] },
				{ event: "event", op: ops[1] },
			],
		}[harness] ?? [
			{ event: "PermissionRequest", op: ops[0] },
			{ event: "Stop", op: ops[1] },
		],
		backup_path: null,
		diff: { lines, hidden, outside_hooks_changed_lines: 0 },
		requires_trust_review: harness === "codex" && action === "install",
		plan_hash: hash,
		notes: [],
	};
}
const applied = (o = {}) => ({
	schema: SCHEMA,
	ok: true,
	mode: "applied",
	harness: o.harness ?? "claude",
	action: o.action ?? "install",
	target: path.join("@HOME@", ".claude", "settings.json"),
	plan_hash: o.hash ?? HASH_A,
	changed: true,
	backup: null,
	rollback: null,
	entries: [],
	requires_trust_review: false,
});
const refusal = (code, exit) => ({ exit, stdout: { schema: SCHEMA, ok: false, code, message: "fixed" } });

function setup(t, scenario = {}, extra = {}) {
	const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "abito-agents-")));
	t.after(() => fs.rmSync(base, { recursive: true, force: true }));
	const home = path.join(base, "home");
	fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
	fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
	const islandDir = path.join(base, "island");
	fs.mkdirSync(islandDir, { mode: 0o700 });
	const scenarioFile = path.join(base, "scenario.json");
	const write = (s) => {
		// The @HOME@ placeholder is replaced INSIDE JSON string values, so the home path must be JSON-escaped:
		// a raw Windows path (C:\Users\...) puts invalid \U escapes into scenario.json and the fake installer
		// dies on JSON.parse before recording or answering anything (the whole Windows failure class of CI run
		// 41718553579). JSON.stringify-escaping is identity on Linux/macOS (no backslashes or quotes in paths).
		const text = JSON.stringify({ pidFile: path.join(base, "grandchild.pid"), ...s }).replaceAll("@HOME@", JSON.stringify(home).slice(1, -1));
		fs.writeFileSync(scenarioFile, text);
	};
	write(scenario);
	const installerBin = path.join(base, "installer.cjs");
	fs.writeFileSync(installerBin, `require(${JSON.stringify(FIXTURE)})(${JSON.stringify(scenarioFile)});\n`, { mode: 0o644 });
	fs.chmodSync(installerBin, 0o644);
	// The product's Windows trust path verifies the script against the install manifest (HU-047); a test
	// fixture is never in that manifest, so on Windows the tests inject the product's own verifier seam.
	// The POSIX ownership/mode trust check below stays the real one on Linux/macOS.
	const manager = new AgentsManager({ installerBin, home, islandDir, ...(win ? { verifyBundled: () => {} } : {}), ...extra });
	const calls = () => (fs.existsSync(`${scenarioFile}.calls`) ? fs.readFileSync(`${scenarioFile}.calls`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
	return { base, home, islandDir, manager, write, calls, installerBin, scenarioFile };
}
test("Windows (HU-047): the installer runs with a Windows-shaped env, the bundled script is manifest-verified, and refusal reasons surface", async t => {
  const calls = [];
  const verified = [];
  const s = setup(t, {}, { platform: "win32", verifyBundled: (file) => verified.push(file), run: async (argv, env) => {
    calls.push({ argv, env });
    return { exit: 0, stdout: Buffer.from(JSON.stringify(preview({ harness: "claude", ops: ["keep", "keep"], target: path.join(s.home, ".claude/settings.json") }))) };
  } });
  const list = await s.manager.list();
  assert.ok(list.length >= 6);
  assert.ok(calls.length >= 1, "the installer preview runs on Windows");
  assert.ok(verified.length >= 1 && verified.every((f) => f === s.installerBin), "the registered script is verified against the install manifest");
  for (const { env } of calls) {
    assert.equal(env.HOME, s.home);
    assert.equal(env.USERPROFILE, s.home);
    assert.ok(!("PATH" in env && env.PATH.includes("/usr/bin")), "no POSIX PATH on Windows");
    assert.ok(typeof env.SystemRoot === "string" || process.platform !== "win32");
  }
});
test("Windows (HU-047): an installer script that fails the manifest check never runs", async t => {
  const calls = [];
  const s = setup(t, {}, { platform: "win32", verifyBundled: () => { throw new Error("script_untrusted"); }, run: async (argv) => { calls.push(argv); return { exit: 0, stdout: "" }; } });
  const list = await s.manager.list();
  assert.deepEqual(calls, []);
  assert.ok(list.every((a) => a.state === "error" || a.state === "unavailable"));
});
test("Windows (HU-047): unsafe_target and install_unverified installer codes map to fixed details", async t => {
  const P = require("../src/protocol.cjs");
  for (const code of ["unsafe_target", "install_unverified"]) {
    const s = setup(t, {}, { platform: "win32", verifyBundled: () => {}, run: async (argv) => {
      if (argv.includes("--apply-plan")) return { exit: 65, stdout: Buffer.from(JSON.stringify({ schema: SCHEMA, ok: false, code, message: "x" }) + "\n") };
      return { exit: 0, stdout: Buffer.from(JSON.stringify(preview({ harness: "claude", target: path.join(s.home, ".claude/settings.json") }))) };
    } });
    const out = await s.manager.connect("claude-code", HASH_A);
    const row = out.find((a) => a.id === "claude-code");
    assert.equal(row.state, "error");
    assert.equal(row.detail, code);
    assert.doesNotThrow(() => P.agentsFrame(out));
  }
});
const byId = (list, id) => list.find((a) => a.id === id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const keepKeep = (harness) => ({ exit: 0, stdout: preview({ harness, ops: ["keep", "keep"] }) });

for (const [id, events] of [['statusline', ['statusLine']]]) {
 test(`${id}: closed wire, event contract, exact argv/env and stale plan refusal`, async t => {
  const P = require('../src/protocol.cjs');
  const frame = P.validateClientFrame({ type: 'agent_connect', agentId: id, plan_hash: HASH_A, argv: ['--apply'], env: { EVIL: '1' } });
  assert.deepEqual(frame, { type: 'agent_connect', agentId: id, plan_hash: HASH_A });
  assert.equal(P.validateClientFrame({ type: 'agent_connect', agentId: id }), undefined);
  const calls = [];
  const s = setup(t, {}, { run: async (argv, env) => {
   calls.push({ argv, env });
   const harness = argv[2];
   const pv = preview({ harness, target: path.join(s.home, harness === 'codex' ? '.codex/hooks.json' : '.claude/settings.json') });
   pv.entries = harness === id ? events.map(event => ({ event, op: 'add' })) : pv.entries;
   return { exit: 0, stdout: Buffer.from(JSON.stringify(pv)) };
  }});
  const item = byId(await s.manager.list(), id);
  assert.equal(item.state, 'not_connected');
  assert.match(item.summary, /backup is made first/);
  assert.doesNotThrow(() => P.agentsFrame([item]));
  const stale = byId(await s.manager.connect(id, HASH_B), id);
  assert.equal(stale.detail, 'plan_changed');
  assert.ok(calls.every(c => !c.argv.includes('--apply-plan')));
  const call = calls.find(c => c.argv[2] === id);
  assert.deepEqual(call.argv, [s.installerBin, 'install', id, '--user', '--json']);
  // The recorded child env is each platform's own closed allowlist: POSIX PATH+HOME (+LANG), the Windows
  // SystemRoot-shaped env with USERPROFILE (the product's HU-047 contract, asserted the same way above).
  const allowedEnv = win ? ['HOME', 'USERPROFILE', 'SystemRoot', 'PATH', 'LANG', 'ABITO_ISLAND_EXE'] : ['PATH', 'HOME', 'LANG', 'ABITO_ISLAND_EXE'];
  assert.ok(Object.keys(call.env).every(k => allowedEnv.includes(k)));
  await assert.rejects(s.manager.connect(id), e => e.code === 'bad_request');
  for (const entries of [events.slice(1).map(event => ({ event, op: 'add' })), events.map(event => ({ event, op: 'execute' })), events.map(() => ({ event: 'PermissionRequest', op: 'add' }))]) {
   s.manager.runner = async () => ({ exit: 0, stdout: Buffer.from(JSON.stringify({ ...preview({ harness: id, target: path.join(s.home, '.claude/settings.json') }), entries })) });
   s.manager.invalidate();
   assert.equal(byId(await s.manager.list(), id).detail, 'install_failed');
  }
 });
 }

// K2-03 S1: Recap is gone, not paused: `agent_connect` naming it is refused at the door (unknown id) and
// the manager refuses it like any id outside the closed set, with or without a plan hash.
test('recap is no longer an agent: the protocol and the manager refuse it like any unknown id', async t => {
	const P = require('../src/protocol.cjs');
	assert.equal(P.validateClientFrame({ type: 'agent_connect', agentId: 'recap', plan_hash: HASH_A }), undefined);
	assert.equal(P.validateClientFrame({ type: 'agent_disconnect', agentId: 'recap' }), undefined);
	assert.equal(P.validateClientFrame({ type: 'hooks_install', clientId: 'recap', plan_hash: HASH_A }), undefined);
	assert.equal(P.validateClientFrame({ type: 'hooks_remove', clientId: 'recap', plan_hash: HASH_A }), undefined);
	const s = setup(t, {});
	await assert.rejects(s.manager.connect('recap', HASH_A), e => e.code === 'bad_request');
	await assert.rejects(s.manager.connect('recap'), e => e.code === 'bad_request');
	await assert.rejects(s.manager.disconnect('recap'), e => e.code === 'bad_request');
	assert.ok(!s.calls().length, 'nothing reached the installer');
	assert.ok(!(await s.manager.list()).some(a => a.id === 'recap'), 'no recap row in the agents list');
});

// ----- K2-03 T3 (S2): removeLegacyRecap through the installer seam (same on Linux, macOS and Windows) -------------------
// The file effects (only the 0.1 recap entries go, backup first, everything else byte-identical) are proven through the
// REAL installer by desktop-harness test/install-recap.test.cjs and test/install-ui.test.cjs on all three OS. Here: the
// daemon side asks for a REMOVAL preview, applies exactly that plan only when it changes something, and never rejects.
const recapPreview = (changed, hash = HASH_R) => ({ schema: SCHEMA, ok: true, mode: "preview", harness: "recap", action: "remove", target: "x", exists: true, changed,
	entries: ["UserPromptSubmit", "PostToolUse", "Stop"].map((event) => ({ event, op: changed ? "remove" : "keep" })), backup_path: null,
	diff: { lines: [], hidden: 0, outside_hooks_changed_lines: 0 }, requires_trust_review: false, plan_hash: hash, notes: [] });
function legacy(t, answer) {
	const argvs = [], logs = [];
	const s = setup(t, {}, { verifyBundled: () => {}, log: (l) => logs.push(l), run: async (argv) => {
		argvs.push(argv.slice(1));
		const out = answer(argv);
		if (out instanceof Error) throw out;
		return { exit: out.exit ?? (out.ok === false ? 65 : 0), stdout: Buffer.from(typeof out === "string" ? out : `${JSON.stringify(out.stdout ?? out)}\n`) };
	} });
	return { s, argvs, logs };
}
const PREVIEW_ARGS = ["install", "recap", "--user", "--remove", "--json"];

test("legacy recap: preview removes something -> apply that exact plan (hash, audit dir), removed, one fixed log line", async (t) => {
	const { s, argvs, logs } = legacy(t, (argv) => (argv.includes("--apply-plan") ? applied({ harness: "recap", action: "remove", hash: HASH_R }) : recapPreview(true)));
	assert.equal(await s.manager.removeLegacyRecap(), "removed");
	assert.deepEqual(argvs, [PREVIEW_ARGS, ["install", "recap", "--user", "--remove", "--apply-plan", HASH_R, "--audit-dir", path.join(s.islandDir, "audit"), "--json"]]);
	assert.deepEqual(logs, ["legacy recap hooks removed"]);
});

test("legacy recap: nothing to remove -> clean, no apply, nothing logged (a second start is a no-op)", async (t) => {
	const { s, argvs, logs } = legacy(t, () => recapPreview(false));
	assert.equal(await s.manager.removeLegacyRecap(), "clean");
	assert.deepEqual(argvs, [PREVIEW_ARGS]);
	assert.deepEqual(logs, []);
});

test("legacy recap: an installer refusal (preview or apply) writes nothing more, logs a fixed line and is retried next start", async (t) => {
	const atPreview = legacy(t, () => ({ ok: false, schema: SCHEMA, code: "refused", message: "fixed" }));
	assert.equal(await atPreview.s.manager.removeLegacyRecap(), "refused");
	assert.deepEqual(atPreview.argvs, [PREVIEW_ARGS], "no apply after a refused preview");
	assert.deepEqual(atPreview.logs, ["legacy recap hooks: cleanup refused; retrying next start"]);
	const atApply = legacy(t, (argv) => (argv.includes("--apply-plan") ? { ok: false, schema: SCHEMA, code: "plan_changed", message: "fixed" } : recapPreview(true)));
	assert.equal(await atApply.s.manager.removeLegacyRecap(), "refused");
	assert.equal(atApply.argvs.length, 2);
	assert.ok(!atApply.logs.join("").includes(atApply.s.home), "no path in the log");
});

test("legacy recap: an install-shaped or mismatched answer is never applied", async (t) => {
	const install = legacy(t, () => ({ ...recapPreview(true), action: "install" }));
	assert.equal(await install.s.manager.removeLegacyRecap(), "failed");
	assert.deepEqual(install.argvs, [PREVIEW_ARGS], "an install preview is never applied");
	const mismatch = legacy(t, (argv) => (argv.includes("--apply-plan") ? applied({ harness: "recap", action: "remove", hash: HASH_B }) : recapPreview(true)));
	assert.equal(await mismatch.s.manager.removeLegacyRecap(), "failed", "an apply answer for another plan is not success");
});

test("legacy recap: never rejects — garbage, a throwing run and a throwing logger all resolve (the daemon's void call is safe)", async (t) => {
	assert.equal(await legacy(t, () => "garbage, not one JSON line\n").s.manager.removeLegacyRecap(), "failed");
	assert.equal(await legacy(t, () => new Error("spawn exploded")).s.manager.removeLegacyRecap(), "failed");
	const s = setup(t, {}, { verifyBundled: () => {}, run: async () => { throw new Error("x"); }, log: () => { throw new Error("log exploded"); } });
	assert.equal(await s.manager.removeLegacyRecap(), "failed");
	assert.equal(await new AgentsManager({ home: s.home, islandDir: s.islandDir, run: () => assert.fail("must not spawn") }).removeLegacyRecap(), "unavailable");
});

test("installerBin unset: every agent unavailable, no spawn", async () => {
	const m = new AgentsManager({ home: os.tmpdir(), islandDir: os.tmpdir(), run: () => { assert.fail('must never spawn without installerBin'); } });
	for (const id of ['statusline']) {
		assert.equal(byId(await m.connect(id, HASH_A), id).state, 'unavailable');
		assert.equal(byId(await m.disconnect(id), id).state, 'unavailable');
	}
	const list = await m.list();
	assert.deepEqual(
		list.map((a) => [a.id, a.name, a.state, a.detail, a.backup]),
		[
			["claude-code", "Claude Code", "unavailable", null, false],
			["codex", "Codex", "unavailable", null, false],
			["statusline", "Uso del plan (relay)", "unavailable", null, false],
			["copilot-cli", "Copilot CLI", "unavailable", null, false],
			["opencode", "OpenCode", "unavailable", null, false],
			["pi", "Pi", "unavailable", null, false],
		],
	);
	assert.equal(m.available, false);
});

test("state mapping: not_connected with plan_hash and closed summaries", async (t) => {
	const s = setup(t, { claude: { preview: { exit: 0, stdout: preview() } }, codex: { preview: { exit: 0, stdout: preview({ harness: "codex", hash: HASH_B }) } } });
	const list = await s.manager.list();
	const claude = byId(list, "claude-code");
	assert.equal(claude.state, "not_connected");
	assert.equal(claude.detail, null);
	assert.equal(claude.plan_hash, HASH_A);
	assert.equal(claude.summary, "Adds the Abito hooks (PermissionRequest, Stop) to ~/.claude/settings.json. A backup is made first.");
	assert.equal(claude.reviewable, true);
	assert.equal(claude.trust_review, false);
	const codex = byId(list, "codex");
	assert.equal(codex.plan_hash, HASH_B);
	assert.equal(codex.summary, "Adds the Abito hooks (PermissionRequest, Stop) to ~/.codex/hooks.json. A backup is made first. Koda answers Codex permission requests from the island; Codex waits up to 120 s for your answer. Trust the Koda hooks again in Codex /hooks after every install or update.");
	assert.equal(codex.trust_review, true);
	assert.equal(byId(list, "opencode").state, "unavailable", "no OpenCode settings dir in the private HOME: not installed");
	assert.equal(byId(list, "copilot-cli").state, "unavailable");
	assert.equal(s.calls().length, 6, "one read-only preview per agent");
});

test("state mapping: connected has no plan fields; replace and mixed ops are outdated", async (t) => {
	const s = setup(t, { claude: { preview: keepKeep("claude") }, codex: { preview: { exit: 0, stdout: preview({ harness: "codex", ops: ["replace", "keep"] }) } } });
	let list = await s.manager.list();
	const claude = byId(list, "claude-code");
	assert.equal(claude.state, "connected");
	for (const k of ["plan_hash", "summary", "reviewable", "trust_review"]) assert.equal(k in claude, false, k);
	const codex = byId(list, "codex");
	assert.equal(codex.state, "outdated");
	assert.equal(codex.summary, "Updates the Abito hooks in ~/.codex/hooks.json. A backup is made first. Koda answers Codex permission requests from the island; Codex waits up to 120 s for your answer. Trust the Koda hooks again in Codex /hooks after every install or update.");
	assert.equal(codex.plan_hash, HASH_A);
	s.write({ claude: { preview: { exit: 0, stdout: preview({ ops: ["add", "keep"] }) } }, codex: { preview: { exit: 0, stdout: preview({ harness: "codex" }) } } });
	s.manager.invalidate();
	list = await s.manager.list();
	assert.equal(byId(list, "claude-code").state, "outdated");
});

test("reviewable false: hidden diff lines or sanitized lines add the large-change sentence", async (t) => {
	const s = setup(t, {
		claude: { preview: { exit: 0, stdout: preview({ hidden: 3 }) } },
		codex: { preview: { exit: 0, stdout: preview({ harness: "codex", lines: ["@@ -1 +1 @@", "+ a?b"] }) } },
	});
	const list = await s.manager.list();
	for (const id of ["claude-code", "codex"]) {
		assert.equal(byId(list, id).reviewable, false, id);
		assert.match(byId(list, id).summary, / This change is large: review it in the file\.$/);
	}
});

test("refusals and failures map to closed states, nothing from the child surfaces", async (t) => {
	const s = setup(t, { claude: { preview: { ...refusal("refused", 65), stderr: "SECRET-STDERR /etc/shadow" } }, codex: { preview: refusal("not_writable", 65) } });
	let list = await s.manager.list();
	assert.deepEqual([byId(list, "claude-code").state, byId(list, "claude-code").detail], ["error", "config_invalid"]);
	assert.deepEqual([byId(list, "codex").state, byId(list, "codex").detail], ["error", "not_writable"]);
	// refusal + settings dir missing = the tool is not installed
	fs.rmSync(path.join(s.home, ".claude"), { recursive: true });
	s.manager.invalidate();
	list = await s.manager.list();
	assert.deepEqual([byId(list, "claude-code").state, byId(list, "claude-code").detail], ["unavailable", null]);
	for (const spec of [
		{ exit: 0, stdout: "not json\n" },
		{ exit: 0, stdout: "{}\n{}\n" },
		{ exit: 3, stdout: preview() },
		{ exit: 0, stdout: preview({ hash: "XYZ" }) },
		{ exit: 0, stdout: preview({ target: "/etc/passwd" }) },
		{ exit: 70, stdout: { schema: SCHEMA, ok: false, code: "internal", message: "x" } },
		{ exit: 0, stdout: refusal("refused", 0).stdout },
	]) {
		s.write({ claude: { preview: spec }, codex: { preview: spec } });
		s.manager.invalidate();
		list = await s.manager.list();
		const a = byId(list, "codex");
		assert.deepEqual([a.state, a.detail], ["error", "install_failed"], JSON.stringify(spec).slice(0, 60));
		assert.doesNotMatch(JSON.stringify(list), /SECRET|shadow|passwd|not json/);
	}
});

test("backup flag: a regular <target>.abito-backup-* file next to the target", async (t) => {
	const s = setup(t, { claude: { preview: keepKeep("claude") }, codex: { preview: keepKeep("codex") } });
	let list = await s.manager.list();
	assert.equal(byId(list, "claude-code").backup, false);
	fs.writeFileSync(path.join(s.home, ".claude", "settings.json.abito-backup-20260101T000000Z"), "{}");
	fs.mkdirSync(path.join(s.home, ".codex", "hooks.json.abito-backup-dir")); // a directory does not count
	s.manager.invalidate();
	list = await s.manager.list();
	assert.equal(byId(list, "claude-code").backup, true);
	assert.equal(byId(list, "codex").backup, false);
});

test("list is cached for 1 s and concurrent calls are single-flight", async (t) => {
	let clock = 1000;
	const s = setup(
		t,
		{ claude: { preview: { exit: 0, stdout: preview(), delayMs: 100 } }, codex: { preview: { exit: 0, stdout: preview({ harness: "codex" }), delayMs: 100 } } },
		{ now: () => clock },
	);
	const [a, b, c] = await Promise.all([s.manager.list(), s.manager.list(), s.manager.list()]);
	assert.deepEqual(a, b);
	assert.deepEqual(b, c);
	assert.equal(s.calls().length, 6);
	clock += 900;
	await s.manager.list();
	assert.equal(s.calls().length, 6, "served from cache inside 1 s");
	clock += 200;
	await s.manager.list();
	assert.equal(s.calls().length, 12, "expired cache re-previews");
});

test("argv is exactly the contract: preview, apply with --audit-dir, optional --timeout-sec", async (t) => {
	const s = setup(t, { claude: { preview: { exit: 0, stdout: preview() }, apply: { exit: 0, stdout: applied() } }, codex: { preview: keepKeep("codex") } });
	await s.manager.connect("claude-code");
	const calls = s.calls().map((c) => c.argv).filter((a) => a[1] === "claude");
	assert.deepEqual(calls[0], ["install", "claude", "--user", "--json"]);
	assert.deepEqual(calls[1], ["install", "claude", "--user", "--apply-plan", HASH_A, "--audit-dir", path.join(s.islandDir, "audit"), "--json"]);
	const t2 = setup(t, { claude: { preview: { exit: 0, stdout: preview() } } }, { timeoutSec: 12 });
	await t2.manager.list();
	assert.deepEqual(t2.calls().find((c) => c.argv[1] === "claude").argv, ["install", "claude", "--user", "--timeout-sec", "12", "--json"]);
});

test("K2-02 (S2): the Node that runs the installer leads its PATH, so a bare `node` resolves to Koda's, never the user's", { skip: process.platform === "win32" && "POSIX branch; the Windows branch keeps PATH=System32 only (twin: the Windows HU-047 test above)" }, async (t) => {
	const s0 = setup(t, { claude: { preview: { exit: 0, stdout: preview() } } });
	// A fake bundled runtime dir: its `node` is a wrapper around this Node, so the installer really runs.
	const runtimeDir = path.join(s0.base, "koda-runtime");
	fs.mkdirSync(runtimeDir);
	const nodeExe = path.join(runtimeDir, "node");
	fs.writeFileSync(nodeExe, `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
	const s = setup(t, { claude: { preview: { exit: 0, stdout: preview() } } }, { nodeExe });
	await s.manager.list();
	const calls = s.calls();
	assert.ok(calls.length >= 1, "the installer ran through the bundled node");
	for (const call of calls) {
		assert.equal(call.env.PATH, `${runtimeDir}:/usr/bin:/bin`);
		assert.equal(call.env.ABITO_ISLAND_EXE, fs.realpathSync(nodeExe), "hooks are written with the bundled node path (new installs)");
	}
});

test("child env: allowlist + ABITO_ISLAND_EXE only, HOME is the real home passed in", async (t) => {
	const s = setup(t, { claude: { preview: { exit: 0, stdout: preview() } }, codex: { preview: { exit: 0, stdout: preview({ harness: "codex" }) } } });
	const names = ["PI_SESSION_ID", "OPENAI_API_KEY", "CLAUDECODE", "CODEX_THREAD_ID", "GENTLE_PI_SESSION", "ABITO_SOCKET_DIR"];
	const saved = Object.fromEntries(names.map((k) => [k, process.env[k]]));
	for (const k of names) process.env[k] = "leak-value";
	try {
		await s.manager.list();
	} finally {
		for (const k of names) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	}
	assert.equal(s.calls().length, 6);
	// The product allowlist is DERIVED from src/agents.cjs childEnv (never guessed): what the manager
	// passes is exactly childEnv(), plus the keys this OS injects into a child on its own (OS_INJECTED_ENV asks the OS;
	// it is never a hand-written list of names, and the injected-run HU-047 tests pin the env OPTION itself).
	// Review (non-tautological): the CLOSED set is pinned here as literals per OS. A key added to childEnv() itself must
	// fail this test, not widen it; the derived set must equal the pinned one, and the recorded child env stays inside it.
	const PINNED_ENV = (win ? ["HOME", "USERPROFILE", "SystemRoot", "PATH", "ABITO_ISLAND_EXE"] : ["PATH", "HOME", "ABITO_ISLAND_EXE"]).concat(process.env.LANG ? ["LANG"] : []);
	assert.deepEqual(Object.keys(s.manager.childEnv()).sort(), [...PINNED_ENV].sort(), "the product's child env is exactly the pinned closed set");
	const allowedEnv = [...PINNED_ENV, ...OS_INJECTED_ENV];
	for (const call of s.calls()) {
		for (const k of Object.keys(call.env)) assert.ok(allowedEnv.includes(k), `unexpected env ${k}`);
		assert.equal(call.env.HOME, s.home);
		if (win) {
			assert.equal(call.env.USERPROFILE, s.home);
			assert.equal(call.env.PATH, path.win32.join(process.env.SystemRoot, "System32"));
		} else {
			assert.equal(call.env.PATH, `${path.dirname(process.execPath)}:/usr/bin:/bin`, "the Node that runs the installer leads PATH (K2-02)");
		}
		assert.equal(call.env.ABITO_ISLAND_EXE, fs.realpathSync(process.execPath));
		assert.equal(call.ppid, process.pid, "direct child of the daemon process");
	}
});

test("connect with a stale plan_hash: plan_changed, nothing applied, new plan returned", async (t) => {
	const s = setup(t, { claude: { preview: { exit: 0, stdout: preview({ hash: HASH_B }) }, apply: { exit: 0, stdout: applied({ hash: HASH_B }) } } });
	const a = byId(await s.manager.connect("claude-code", HASH_A), "claude-code");
	assert.deepEqual([a.state, a.detail, a.plan_hash], ["error", "plan_changed", HASH_B]);
	assert.match(a.summary, /^Adds the Abito hooks/);
	assert.equal(s.calls().filter((c) => c.argv.includes("--apply-plan")).length, 0);
});

test("connect without plan_hash applies the fresh preview hash; result connected + backup", async (t) => {
	const s = setup(t, { claude: { preview: { exit: 0, stdout: preview({ hash: HASH_B }) }, apply: { exit: 0, stdout: applied({ hash: HASH_B }) } } });
	const seen = [];
	s.manager.on("change", (l) => seen.push(byId(l, "claude-code").state));
	fs.writeFileSync(path.join(s.home, ".claude", "settings.json.abito-backup-1"), "{}");
	const a = byId(await s.manager.connect("claude-code"), "claude-code");
	assert.deepEqual([a.state, a.backup, "plan_hash" in a], ["connected", true, false]);
	assert.deepEqual(seen, ["working"]);
	assert.equal(s.calls().filter((c) => c.argv.includes(HASH_B)).length, 1, "preview result hash is used for the apply");
});

test("connect with the matching plan_hash applies; already connected is a no-op", async (t) => {
	const s = setup(t, { claude: { preview: { exit: 0, stdout: preview() }, apply: { exit: 0, stdout: applied() } } });
	assert.equal(byId(await s.manager.connect("claude-code", HASH_A), "claude-code").state, "connected");
	assert.equal(s.calls().filter((c) => c.argv.includes("--apply-plan")).length, 1);
	s.write({ claude: { preview: keepKeep("claude") } });
	const list = await s.manager.connect("claude-code");
	assert.equal(byId(list, "claude-code").state, "connected");
	assert.equal(s.calls().filter((c) => c.argv.includes("--apply-plan")).length, 1, "no second apply");
});

test("HU-047: an unsafe folder keeps its own detail with the folder and the closed reason, on preview and apply", async (t) => {
	const unsafe = (folder, folder_reason) => ({ exit: 65, stdout: { schema: SCHEMA, ok: false, code: "unsafe_folder", message: "fixed", folder, folder_reason } });
	const s = setup(t, { claude: { preview: unsafe("/home/u/.claude", "writable") } });
	const a = byId(await s.manager.list(), "claude-code");
	assert.deepEqual([a.state, a.detail, a.folder, a.folder_reason], ["error", "unsafe_folder", "/home/u/.claude", "writable"]);
	const s2 = setup(t, { claude: { preview: { exit: 0, stdout: preview() }, apply: unsafe("/home/u/.claude", "bogus") } });
	const b = byId(await s2.manager.connect("claude-code"), "claude-code");
	assert.deepEqual([b.detail, b.folder], ["unsafe_folder", undefined], "an unknown reason never forwards the folder");
});

test("HU-047: a folder that does not exist reads 'unavailable', never an unsafe-folder error", async (t) => {
	// Windows (CI 43319173068 tests 44/46): the native helper reports parent_ok=false when the parent directory is absent,
	// so a tool that is simply NOT INSTALLED there is refused as unsafe_folder and the manager showed state 'error'. A
	// folder that does not exist cannot be unsafe, so the honest answer is the one POSIX already gave ('refused' with no
	// settings directory => unavailable). A refusal about an EXISTING folder keeps its error, folder and reason.
	const unsafe = { exit: 65, stdout: { schema: SCHEMA, ok: false, code: "unsafe_folder", message: "fixed", folder: "/home/u/.config/opencode/plugins", folder_reason: "acl" } };
	const s = setup(t, { opencode: { preview: unsafe }, claude: { preview: unsafe } });
	const list = await s.manager.list();
	assert.deepEqual([byId(list, "opencode").state, byId(list, "opencode").detail, byId(list, "opencode").folder], ["unavailable", null, undefined], "no ~/.config/opencode/plugins in this HOME: not installed");
	assert.deepEqual([byId(list, "claude-code").state, byId(list, "claude-code").detail, byId(list, "claude-code").folder_reason], ["error", "unsafe_folder", "acl"], "an existing ~/.claude keeps its refusal");
	// The same reading for the plain POSIX refusal: no settings directory means "not installed", nothing else.
	const s2 = setup(t, { opencode: { preview: refusal("refused", 65) } });
	assert.equal(byId(await s2.manager.list(), "opencode").state, "unavailable");
});

test("apply failures map to closed details", async (t) => {
	const cases = [
		[{ exit: 70, stdout: { schema: SCHEMA, ok: false, code: "plan_changed", message: "m" } }, "plan_changed"],
		[{ exit: 73, stdout: { schema: SCHEMA, ok: false, code: "audit_unavailable", message: "m" } }, "audit_unavailable"],
		[refusal("not_writable", 65), "not_writable"],
		[refusal("foreign_extension", 65), "foreign_extension"], // HU-052: a hand-copied Pi extension folder keeps its own detail
		[refusal("backup_failed", 70), "backup_failed"],
		[refusal("apply_failed", 70), "install_failed"],
		[refusal("not_island", 77), "install_failed"],
		[{ exit: 0, stdout: "garbage\n", stderr: "LEAK" }, "install_failed"],
		[{ exit: 0, stdout: applied({ hash: HASH_B }) }, "install_failed"], // result for a different plan
	];
	for (const [spec, detail] of cases) {
		const s = setup(t, { claude: { preview: { exit: 0, stdout: preview() }, apply: spec } });
		const a = byId(await s.manager.connect("claude-code"), "claude-code");
		assert.deepEqual([a.state, a.detail], ["error", detail], detail);
		assert.doesNotMatch(JSON.stringify(a), /LEAK|garbage/);
	}
});

test("disconnect: nothing to remove => not_connected; otherwise applies the REMOVE plan hash", async (t) => {
	const s = setup(t, { claude: { preview: { exit: 0, stdout: preview({ hash: HASH_B }) }, previewRemove: { exit: 0, stdout: preview({ action: "remove", ops: ["keep", "keep"] }) } } });
	let a = byId(await s.manager.disconnect("claude-code"), "claude-code");
	assert.equal(a.state, "not_connected");
	assert.equal(a.plan_hash, HASH_B, "fresh install plan for the next Connect click");
	assert.equal(s.calls().filter((c) => c.argv.includes("--apply-plan")).length, 0);
	s.write({
		claude: {
			preview: { exit: 0, stdout: preview({ hash: HASH_B }) },
			previewRemove: { exit: 0, stdout: preview({ action: "remove", ops: ["remove", "remove"], hash: HASH_R }) },
			applyRemove: { exit: 0, stdout: applied({ action: "remove", hash: HASH_R }) },
		},
	});
	a = byId(await s.manager.disconnect("claude-code"), "claude-code");
	assert.equal(a.state, "not_connected");
	const apply = s.calls().find((c) => c.argv.includes("--apply-plan"));
	assert.deepEqual(apply.argv, ["install", "claude", "--user", "--remove", "--apply-plan", HASH_R, "--audit-dir", path.join(s.islandDir, "audit"), "--json"]);
});

test("copilot-cli and opencode drive their own harness installers with the same plan/hash contract; unknown ids are bad_request", async (t) => {
	const s = setup(t, {
		copilot: { preview: { exit: 0, stdout: preview({ harness: "copilot", hash: HASH_B }) }, apply: { exit: 0, stdout: applied({ harness: "copilot", hash: HASH_B }) } },
		opencode: { preview: { exit: 0, stdout: preview({ harness: "opencode", hash: HASH_B }) } },
	});
	const list = await s.manager.list();
	const copilot = byId(list, "copilot-cli");
	assert.deepEqual([copilot.state, copilot.plan_hash, copilot.trust_review], ["not_connected", HASH_B, false]);
	assert.equal(copilot.summary, "Adds the Abito hooks (permissionRequest, sessionEnd) to ~/.copilot/hooks/abito-island.json. A backup is made first.");
	assert.equal(byId(list, "opencode").summary, "Adds the Abito plugin to ~/.config/opencode/plugins/abito-island.js. A backup is made first.");
	await assert.rejects(s.manager.connect("copilot-cli", undefined).then(() => s.manager.connect("copilot-cli", "zz")), (e) => e.code === "bad_request");
	const done = byId(await s.manager.connect("copilot-cli", HASH_B), "copilot-cli");
	assert.equal(done.state, "connected");
	const apply = s.calls().find((c) => c.argv.includes("--apply-plan"));
	assert.deepEqual(apply.argv, ["install", "copilot", "--user", "--apply-plan", HASH_B, "--audit-dir", path.join(s.islandDir, "audit"), "--json"]);
	const stale = byId(await s.manager.connect("opencode", HASH_A), "opencode");
	assert.deepEqual([stale.state, stale.detail], ["error", "plan_changed"]);
	await assert.rejects(s.manager.connect("nope"), (e) => e.code === "bad_request");
});

test("global single operation: working state, busy for further connect/disconnect", async (t) => {
	const s = setup(t, {
		claude: { preview: { exit: 0, stdout: preview() }, apply: { exit: 0, stdout: applied(), delayMs: 600 } },
		codex: { preview: { exit: 0, stdout: preview({ harness: "codex" }) } },
	});
	const first = s.manager.connect("claude-code");
	await sleep(250);
	await assert.rejects(s.manager.connect("codex"), (e) => e.code === "busy");
	await assert.rejects(s.manager.disconnect("claude-code"), (e) => e.code === "busy");
	const during = await s.manager.list();
	assert.equal(byId(during, "claude-code").state, "working");
	assert.equal(byId(during, "codex").state, "not_connected");
	assert.equal(byId(await first, "claude-code").state, "connected");
	s.write({ codex: { preview: keepKeep("codex") } });
	assert.equal(byId(await s.manager.connect("codex"), "codex").state, "connected", "lock released");
});

test("a failed operation releases the global lock", async (t) => {
	const s = setup(t, { claude: { preview: { exit: 0, stdout: "garbage\n" } } });
	assert.equal(byId(await s.manager.connect("claude-code"), "claude-code").state, "error");
	assert.equal(byId(await s.manager.connect("claude-code"), "claude-code").state, "error");
});

test("hung installer: killed on timeout (whole group), generic failure", async (t) => {
	const s = setup(t, { claude: { preview: { exit: 0, stdout: preview(), mode: "hang" } }, codex: { preview: { exit: 0, stdout: preview({ harness: "codex" }) } } }, { timeoutMs: 600 });
	const list = await s.manager.list();
	assert.deepEqual([byId(list, "claude-code").state, byId(list, "claude-code").detail], ["error", "install_failed"]);
	const pid = Number(fs.readFileSync(path.join(s.base, "grandchild.pid"), "utf8"));
	for (let i = 0; i < 40 && alive(pid); i++) await sleep(50);
	assert.equal(alive(pid), false, "grandchild killed with the group");
	// The killed installer itself can answer kill(0) for a moment on macOS: the pid is dead but not yet
	// reaped (a zombie answers signal 0) — the same bounded wait the grandchild line uses. Pre-existing
	// flaky race (CI 41729969464 macOS job-126245055334, test 70); test-only, never observed on Linux.
	for (let i = 0; i < 40 && alive(s.calls()[0].pid); i++) await sleep(50);
	assert.equal(alive(s.calls()[0].pid), false);
});

test("oversized stdout and stderr floods fail generically and leave no process", async (t) => {
	for (const mode of ["oversize", "stderr-flood"]) {
		const s = setup(t, { claude: { preview: { exit: 0, stdout: preview(), mode } }, codex: { preview: { exit: 0, stdout: preview({ harness: "codex" }) } } }, { maxBytes: 64 * 1024 });
		const list = await s.manager.list();
		assert.deepEqual([byId(list, "claude-code").state, byId(list, "claude-code").detail], ["error", "install_failed"], mode);
		assert.doesNotMatch(JSON.stringify(list), /xxxx|EEEE/);
		await sleep(150);
		assert.equal(alive(s.calls()[0].pid), false, mode);
	}
});

test("installer trust check: group-writable or symlinked script is refused before spawning", unixOnly("Windows (HU-047): an installer script that fails the manifest check never runs"), async (t) => {
	const s = setup(t, { claude: { preview: { exit: 0, stdout: preview() } } });
	fs.chmodSync(s.installerBin, 0o664);
	let a = byId(await s.manager.list(), "claude-code");
	assert.deepEqual([a.state, a.detail], ["error", "install_failed"]);
	assert.equal(s.calls().length, 0);
	fs.chmodSync(s.installerBin, 0o644);
	const link = path.join(s.base, "link.cjs");
	fs.symlinkSync(s.installerBin, link);
	const m = new AgentsManager({ installerBin: link, home: s.home, islandDir: s.islandDir });
	a = byId(await m.list(), "claude-code");
	assert.deepEqual([a.state, a.detail], ["error", "install_failed"]);
	assert.equal(s.calls().length, 0);
});

test("a pending migration (old Abito PreToolUse entry to remove, every wire row keep) is outdated, not an error", async (t) => {
	const json = preview({ ops: ["keep", "keep"], changed: true });
	json.entries.push({ event: "PreToolUse", op: "remove" });
	const s = setup(t, { claude: { preview: { exit: 0, stdout: json } } });
	const claude = byId(await s.manager.list(), "claude-code");
	assert.equal(claude.state, "outdated", "the human can apply the migration from the island");
	assert.equal(claude.plan_hash, HASH_A);
});

test("HU-047 L4: a timed-out installer is killed as a TREE on Windows (taskkill /T /F, no shell) and by group elsewhere", () => {
	const { killTree } = require("../src/agents.cjs");
	const calls = [];
	const run = (...a) => calls.push(a);
	killTree({ pid: 4321 }, "win32", run);
	assert.equal(calls.length, 1);
	assert.match(calls[0][0], /System32\\taskkill\.exe$/i);
	assert.deepEqual(calls[0][1], ["/PID", "4321", "/T", "/F"]);
	assert.equal(calls[0][2].shell, false);
	for (const bad of [[{ pid: 4 }, "win32"], [{ pid: "1; calc" }, "win32"], [null, "win32"], [{ pid: 4321 }, "linux"], [{ pid: 4321 }, "darwin"]]) killTree(bad[0], bad[1], run);
	assert.equal(calls.length, 1, "never for a bogus pid or off Windows (POSIX uses the process group)");
	assert.doesNotThrow(() => killTree({ pid: 4321 }, "win32", () => { throw new Error("x"); }));
});
