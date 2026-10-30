"use strict";

// HU-015: the daemon-free Settings route. A fake installer runner stands in for the harness; temp dirs only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseArgs, main, packagedInstallerBin } = require("../src/agents-direct.cjs");

const HASH = "a".repeat(64);
const SCHEMA = "abito-hook-install/1";
const WIRE = {
	claude: ["PermissionRequest", "SessionStart", "Stop"],
	codex: ["PermissionRequest", "PreToolUse", "PostToolUse", "Stop"],
	copilot: ["permissionRequest", "sessionEnd"],
	opencode: ["permission.ask", "event"],
	recap: ["UserPromptSubmit", "PostToolUse", "Stop"],
	statusline: ["statusLine"],
	pi: ["extension"],
};
const FILES = { pi: ".pi/agent/extensions/abito-island", claude: ".claude/settings.json", codex: ".codex/hooks.json", copilot: ".copilot/hooks/abito-island.json", opencode: ".config/opencode/plugins/abito-island.js", recap: ".claude/settings.json", statusline: ".claude/settings.json" };

/** Fake installer: `installed` = harnesses whose hooks are already there; `broken` = harnesses that refuse. */
function fakeRun(home, { installed = [], broken = [] } = {}, seen = []) {
	return async (argv) => {
		seen.push(argv);
		const [, verb, harness] = argv;
		assert.equal(verb, "install");
		if (broken.includes(harness)) return { exit: 65, stdout: Buffer.from(`${JSON.stringify({ schema: SCHEMA, ok: false, code: "refused", message: "x" })}\n`) };
		const apply = argv.includes("--apply-plan");
		const remove = argv.includes("--remove");
		const op = installed.includes(harness) ? "keep" : "add";
		const body = apply
			? { schema: SCHEMA, ok: true, mode: "applied", harness, action: remove ? "remove" : "install", target: path.join(home, FILES[harness]), plan_hash: HASH, changed: true, backup: null, rollback: null, entries: [], requires_trust_review: false }
			: { schema: SCHEMA, ok: true, mode: "preview", harness, action: remove ? "remove" : "install", target: path.join(home, FILES[harness]), exists: true, changed: remove ? installed.includes(harness) : op !== "keep", entries: WIRE[harness].map((event) => ({ event, op })), backup_path: null, diff: { lines: ["+ x"], hidden: 0, outside_hooks_changed_lines: 0 }, requires_trust_review: false, plan_hash: HASH, notes: [] };
		return { exit: 0, stdout: Buffer.from(`${JSON.stringify(body)}\n`) };
	};
}

function setup(t) {
	const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "abito-direct-")));
	t.after(() => fs.rmSync(base, { recursive: true, force: true }));
	const home = path.join(base, "home");
	for (const d of [".claude", ".codex"]) fs.mkdirSync(path.join(home, d), { recursive: true });
	const island = path.join(base, "island");
	const env = { HOME: home, ABITO_ISLAND_DIR: island };
	const installerBin = path.join(base, "installer.cjs");
	fs.writeFileSync(installerBin, "// fake\n", { mode: 0o644 });
	const run = async (argv, behaviour, seen) => {
		let text = "";
		const code = await main(argv, env, { write: (s) => (text += s) }, { installerBin, agentsOptions: { run: fakeRun(home, behaviour, seen) } });
		assert.equal(text.split("\n").filter(Boolean).length, 1, "exactly one output line");
		return { code, json: JSON.parse(text) };
	};
	return { base, home, island, run };
}
const row = (frame, id) => frame.agents.find((a) => a.id === id);

test("Pi uses its own extension plan independent of sessions and non-Pi hooks", async t => {
 const s = setup(t);
 const pv = await s.run(["list"], {installed:["claude"]});
 assert.equal(row(pv.json.agents,"pi").state, "not_connected");
 const connected = await s.run(["connect","pi",HASH], {installed:["claude"]});
 assert.equal(connected.code,0); assert.equal(row(connected.json.agents,"pi").state,"connected");
 assert.equal(row(connected.json.agents,"claude-code").state,"connected");
});

test("parseArgs: closed grammar, allowlisted ids, 64-hex hash only", () => {
	assert.deepEqual(parseArgs(["list"]), { op: "list" });
	assert.equal(parseArgs(["connect", "codex"]), undefined);
	assert.deepEqual(parseArgs(["connect", "codex", HASH]), { op: "connect", id: "codex", planHash: HASH });
	assert.deepEqual(parseArgs(["disconnect", "claude-code"]), { op: "disconnect", id: "claude-code" });
	for (const bad of [[], ["list", "x"], ["connect"], ["connect", "pi"], ["connect", "../x"], ["connect", "codex", "zz"], ["connect", "codex", HASH, "x"], ["disconnect", "codex", HASH], ["install", "codex"], ["connect", "--help"]])
		assert.equal(parseArgs(bad), undefined, JSON.stringify(bad));
});

test("list works with no daemon and no Pi: each agent row depends only on its own hooks", async (t) => {
	const s = setup(t);
	const { code, json } = await s.run(["list"], { installed: ["claude"] });
	assert.equal(code, 0);
	assert.equal(row(json.agents, "claude-code").state, "connected");
	assert.equal(row(json.agents, "codex").state, "not_connected");
	assert.ok(row(json.agents, "codex").plan_hash, "an uninstalled agent offers the plan the human will confirm");
	assert.ok(fs.existsSync(path.join(s.island, "audit")), "audit dir ready for apply");
	assert.ok(!JSON.stringify(json).includes("pi_missing"), "Pi runtime absence never becomes another agent\'s state");
	assert.equal(row(json.agents, "pi").state, "not_connected", "Pi has its own extension row");
});

test("one agent broken or missing never changes another row", async (t) => {
	const s = setup(t);
	const { json } = await s.run(["list"], { installed: ["codex"], broken: ["claude"] });
	assert.equal(row(json.agents, "codex").state, "connected");
	assert.notEqual(row(json.agents, "claude-code").state, "connected");
	assert.equal(row(json.agents, "opencode").state, "not_connected");
});

test("connect: previews again, applies only the plan the human saw, then reports the new list", async (t) => {
	const s = setup(t);
	const seen = [];
	const stale = await s.run(["connect", "codex", "b".repeat(64)], {}, seen);
	assert.equal(row(stale.json.agents, "codex").detail, "plan_changed");
	assert.ok(seen.every((a) => !a.includes("--apply-plan")), "a stale hash applies nothing");
	seen.length = 0;
	const ok = await s.run(["connect", "codex", HASH], {}, seen);
	assert.equal(ok.code, 0);
	const apply = seen.find((a) => a.includes("--apply-plan"));
	assert.deepEqual(apply.slice(1, 4), ["install", "codex", "--user"]);
	assert.equal(apply[apply.indexOf("--apply-plan") + 1], HASH);
	assert.ok(apply.includes("--audit-dir") && apply.includes(path.join(s.island, "audit")));
});

test("disconnect and notify-only ids go through the same guard (recap needs the shown plan)", async (t) => {
	const s = setup(t);
	const seen = [];
	const gone = await s.run(["disconnect", "claude-code"], { installed: ["claude"] }, seen);
	assert.equal(gone.code, 0);
	assert.ok(seen.some((a) => a.includes("--remove") && a.includes("--apply-plan")));
	const recap = await s.run(["connect", "recap"], {});
	assert.equal(recap.code, 2);
	assert.deepEqual(recap.json, { error: "bad_request" });
});

test("bad arguments and a missing installer fail closed with one closed line", async (t) => {
	const s = setup(t);
	let text = "";
	assert.equal(await main(["connect", "pi"], {}, { write: (v) => (text += v) }), 2);
	assert.deepEqual(JSON.parse(text), { error: "bad_request" });
	text = "";
	await main(["list"], { HOME: s.home, ABITO_ISLAND_DIR: "relative" }, { write: (v) => (text += v) });
	assert.deepEqual(JSON.parse(text), { error: "failed" });
	text = "";
	const code = await main(["list"], { HOME: s.home, ABITO_ISLAND_DIR: s.island }, { write: (v) => (text += v) }, { installerBin: undefined });
	assert.equal(code, 0);
	assert.ok(JSON.parse(text).agents.agents.every((a) => a.state === "unavailable"));
});

test("plan-less connect is refused before any installer or user-state write", async (t) => {
	const s = setup(t);
	const seen = [];
	const result = await s.run(["connect", "codex"], {}, seen);
	assert.equal(result.code, 2);
	assert.deepEqual(result.json, { error: "bad_request" });
	assert.deepEqual(seen, []);
	assert.equal(fs.existsSync(s.island), false);
	assert.equal(fs.existsSync(path.join(s.home, ".codex/hooks.json")), false);
});

test("the installer is the harness next to the daemon, never from argv/env", () => {
	const bin = packagedInstallerBin();
	assert.ok(bin && bin.endsWith(path.join("desktop-harness", "bin", "abito-hook.cjs")));
});
