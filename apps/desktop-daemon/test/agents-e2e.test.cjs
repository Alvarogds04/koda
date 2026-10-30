"use strict";

// REAL end-to-end: AgentsManager drives the actual apps/desktop-harness/bin/abito-hook.cjs against a
// temp HOME (fake .claude/.codex with third-party hooks). The real ~/.claude, ~/.codex and
// ~/.abito-island are never written: only their mtimes are READ (stat) before/after to prove it.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { AgentsManager } = require("../src/agents.cjs");

const HARNESS = path.join(__dirname, "..", "..", "desktop-harness");
const byId = (list, id) => list.find((a) => a.id === id);
const mtimeOf = (file) => {
	try {
		return fs.statSync(file).mtime.toISOString();
	} catch {
		return null;
	}
};
const REAL = [path.join(os.homedir(), ".claude", "settings.json"), path.join(os.homedir(), ".codex", "hooks.json")];

/** Private copy of bin/ + src/ with 0644/0755 modes: the use-time trust check refuses group-writable scripts. */
function copyInstaller(dest) {
	for (const sub of ["bin", "src"]) {
		fs.cpSync(path.join(HARNESS, sub), path.join(dest, sub), { recursive: true });
	}
	const walk = (dir) => {
		fs.chmodSync(dir, 0o755);
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else fs.chmodSync(p, 0o644);
		}
	};
	walk(path.join(dest, "bin"));
	walk(path.join(dest, "src"));
	return path.join(dest, "bin", "abito-hook.cjs");
}

const THIRD = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/usr/bin/true" }] }] }, theme: "dark" };

function setup(t) {
	const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "abito-agents-e2e-")));
	t.after(() => fs.rmSync(base, { recursive: true, force: true }));
	fs.chmodSync(base, 0o700);
	const home = path.join(base, "home");
	fs.mkdirSync(path.join(home, ".claude"), { recursive: true, mode: 0o700 });
	fs.mkdirSync(path.join(home, ".codex"), { recursive: true, mode: 0o700 });
	const claudeFile = path.join(home, ".claude", "settings.json");
	const codexFile = path.join(home, ".codex", "hooks.json");
	fs.writeFileSync(claudeFile, `${JSON.stringify(THIRD, null, 2)}\n`, { mode: 0o600 });
	fs.writeFileSync(codexFile, `${JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "/usr/bin/true" }] }] } }, null, 2)}\n`, { mode: 0o600 });
	const islandDir = path.join(base, "island");
	fs.mkdirSync(islandDir, { mode: 0o700 });
	const installerBin = copyInstaller(base);
	const manager = new AgentsManager({ installerBin, home, islandDir });
	const audit = () => {
		const file = path.join(islandDir, "audit", "hook-installs.jsonl");
		return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
	};
	return { base, home, claudeFile, codexFile, islandDir, manager, audit };
}

test('packaged installer: Claude preview in a private HOME never reports install_failed', async t => {
 const s = setup(t);
 // A fresh user has the directory, but no settings file yet (as in validation).
 const home = path.join(s.base, 'fresh-home');
 fs.mkdirSync(path.join(home, '.claude'), {recursive:true, mode:0o700});
 const packaged = path.join(s.base, 'package', 'desktop-harness');
 const {HARNESS_FILES} = require('../../desktop-tauri/packaging/lib.cjs');
 for (const file of HARNESS_FILES) {
  const dest = path.join(packaged, file);
  const source = path.join(s.base, 'checkout', file);
  fs.mkdirSync(path.dirname(source), {recursive:true, mode:0o700});
  fs.copyFileSync(path.join(HARNESS, file), source);
  // Model a group-writable checkout independently of the developer's umask.
  fs.chmodSync(source, 0o664);
  require('../../desktop-tauri/packaging/validate/layout.cjs').copyRuntimeFile(source, dest);
  assert.equal(fs.statSync(dest).mode & 0o777, 0o644);
 }
 const manager = new AgentsManager({installerBin:path.join(packaged, 'bin/abito-hook.cjs'), home, islandDir:s.islandDir});
 const list = await manager.list();
 const claude = byId(list, 'claude-code');
 assert.notEqual(claude.detail, 'install_failed');
 assert.equal(claude.state, 'not_connected');
 assert.match(claude.plan_hash, /^[0-9a-f]{64}$/);
 assert.equal(byId(list, 'codex').state, 'unavailable');
 assert.equal(fs.existsSync(path.join(home, '.claude/settings.json')), false);
});

test('real recap/statusline CLI: preview is read-only, coexist, hash-bound apply and marker-only remove', async t => {
 const s = setup(t);
 const original = { ...THIRD, statusLine: { type: 'command', command: 'mine' } };
 fs.writeFileSync(s.claudeFile, JSON.stringify(original) + '\n');
 const before = fs.readFileSync(s.claudeFile, 'utf8');
 let list = await s.manager.list();
 assert.equal(fs.readFileSync(s.claudeFile, 'utf8'), before);
 assert.equal(s.audit().length, 0);
 for (const id of ['recap', 'statusline']) {
  s.manager.invalidate(); list = await s.manager.list();
  assert.equal(byId(list, id).state, id === 'statusline' ? 'outdated' : 'not_connected');
  const hash = byId(list, id).plan_hash;
  assert.equal(byId(await s.manager.connect(id, 'f'.repeat(64)), id).detail, 'plan_changed');
  assert.equal(byId(await s.manager.connect(id, hash), id).state, 'connected');
 }
 const installed = JSON.parse(fs.readFileSync(s.claudeFile));
 assert.ok(installed.hooks.UserPromptSubmit && installed.hooks.PostToolUse && installed.hooks.Stop);
 assert.match(installed.statusLine.command, /abito-statusline\.cjs/);
 assert.equal(JSON.parse(fs.readFileSync(path.join(s.home, '.abito/statusline-previous.json'))).command, 'mine');
 for (const id of ['recap', 'statusline']) assert.equal(byId(await s.manager.disconnect(id), id).state, id === 'statusline' ? 'outdated' : 'not_connected');
 assert.deepEqual(JSON.parse(fs.readFileSync(s.claudeFile)), original);
 assert.deepEqual(s.audit().map(x => x.event), ['intent', 'result', 'intent', 'result', 'intent', 'result', 'intent', 'result']);
 assert.doesNotMatch(JSON.stringify(s.audit()), /mine|PreToolUse|theme|command/);
});

test("real installer end-to-end: list, connect with the shown plan, tamper, disconnect, codex trust, busy", async (t) => {
	const before = REAL.map(mtimeOf);
	const s = setup(t);
	const originalClaude = fs.readFileSync(s.claudeFile, "utf8");

	// 1. list: both not_connected with a plan, opencode unavailable
	let list = await s.manager.list();
	assert.equal(byId(list, "claude-code").state, "not_connected");
	assert.equal(byId(list, "codex").state, "not_connected");
	assert.equal(byId(list, "opencode").state, "unavailable", "no ~/.config/opencode/plugins in this HOME");
	const shown = byId(list, "claude-code").plan_hash;
	assert.match(shown, /^[0-9a-f]{64}$/);
	assert.equal(byId(list, "codex").trust_review, true);
	assert.equal(byId(list, "claude-code").backup, false);

	// 2. connect with the plan the human saw
	list = await s.manager.connect("claude-code", shown);
	assert.equal(byId(list, "claude-code").state, "connected");
	assert.equal(byId(list, "claude-code").backup, true);
	const settings = JSON.parse(fs.readFileSync(s.claudeFile, "utf8"));
	assert.ok(settings.hooks.PermissionRequest && settings.hooks.Stop, "our hooks are installed");
	assert.deepEqual(settings.hooks.PreToolUse, [THIRD.hooks.PreToolUse[0]], "third-party PreToolUse hook preserved, first and untouched");
	assert.equal(JSON.stringify(settings.hooks).split('pre-tool-use').length - 1, 0, "our old PreToolUse/AskUserQuestion entry is migrated away");
	assert.equal(settings.hooks.PermissionRequest.length, 1, "one PermissionRequest handler answers permissions and AskUserQuestion alike");
	assert.equal(settings.hooks.PermissionRequest[0].matcher, undefined, "no matcher: it must see every tool");
	assert.ok(settings.hooks.SessionStart, "session title cache hook installed");
	assert.equal(settings.theme, "dark");
	const backups = fs.readdirSync(path.join(s.home, ".claude")).filter((n) => n.startsWith("settings.json.abito-backup-"));
	assert.equal(backups.length, 1);
	assert.equal(fs.readFileSync(path.join(s.home, ".claude", backups[0]), "utf8"), originalClaude);
	const audit = s.audit();
	assert.deepEqual(audit.map((l) => l.event), ["intent", "result"]);
	assert.equal(audit[0].plan_hash, shown);
	assert.equal(audit[1].ok, true);
	assert.doesNotMatch(JSON.stringify(audit), /PreToolUse|dark|\/usr\/bin\/true/, "audit carries metadata only");

	// 3. list again => connected (fresh preview)
	s.manager.invalidate();
	list = await s.manager.list();
	assert.equal(byId(list, "claude-code").state, "connected");
	assert.equal(byId(list, "claude-code").backup, true);
	assert.equal("plan_hash" in byId(list, "claude-code"), false);

	// 4. disconnect restores the original semantics, third-party untouched
	list = await s.manager.disconnect("claude-code");
	assert.equal(byId(list, "claude-code").state, "not_connected");
	assert.deepEqual(JSON.parse(fs.readFileSync(s.claudeFile, "utf8")), THIRD);
	const fresh = byId(list, "claude-code").plan_hash;
	assert.match(fresh, /^[0-9a-f]{64}$/);

	// 5. tamper after the human saw `fresh`: the OLD hash must not apply
	const tampered = `${JSON.stringify({ ...THIRD, model: "tampered" }, null, 2)}\n`;
	fs.writeFileSync(s.claudeFile, tampered);
	const auditLines = s.audit().length;
	list = await s.manager.connect("claude-code", fresh);
	const stale = byId(list, "claude-code");
	assert.deepEqual([stale.state, stale.detail], ["error", "plan_changed"]);
	assert.notEqual(stale.plan_hash, fresh, "the new plan is handed back");
	assert.equal(fs.readFileSync(s.claudeFile, "utf8"), tampered, "nothing written");
	assert.equal(s.audit().length, auditLines, "no apply was even attempted");

	// 6. codex: connect works and asks for a trust review
	list = await s.manager.connect("codex");
	const codex = byId(list, "codex");
	assert.deepEqual([codex.state, codex.trust_review], ["connected", true]);
	const hooks = JSON.parse(fs.readFileSync(s.codexFile, "utf8")).hooks;
	assert.ok(hooks.SessionStart && hooks.PermissionRequest && hooks.Stop);
	assert.equal(fs.existsSync(path.join(s.home, ".codex", "config.toml")), false, "config.toml never touched");

	// 7. two simultaneous connects: exactly one wins, the other is busy
	await s.manager.disconnect("codex");
	const results = await Promise.allSettled([s.manager.connect("claude-code"), s.manager.connect("codex")]);
	assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
	const rejected = results.find((r) => r.status === "rejected");
	assert.equal(rejected.reason.code, "busy");

	// everything stayed under the temp HOME; the real files were never touched
	assert.deepEqual(REAL.map(mtimeOf), before);
	console.log(`real mtimes before/after: ${JSON.stringify(before)} / ${JSON.stringify(REAL.map(mtimeOf))}`);
});
