"use strict";

// Agent hooks catalogue (#361, F047, F048): preview / install / remove of the Abito
// island hooks for the agent clients the harness installer does not cover
// (gemini-cli, copilot-cli, opencode, amp). Preview is read-only; install writes
// ONLY after the caller echoes back the exact plan hash it was shown; remove
// deletes ONLY marker-tagged Abito artifacts; every overwrite or delete is backed
// up first and reversible. Every test runs with an injected HOME in a temp dir and
// an fs guard that records every path the module touches: nothing outside the temp
// root may ever be opened, and nothing may be written by a scan.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SCHEMA, CLIENT_IDS, scanAgentHooks, installAgentHook, removeAgentHook } = require("../src/agent-hooks.cjs");

const NODE = "/usr/bin/node-fake";
const HEX = /^[0-9a-f]{64}$/;
const MARKER = "abito-island-hooks/1";

function tmp() {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "abito-agenthooks-")));
}

/** fs seam: forwards to node:fs and records every path any operation touched. */
function guard(root) {
	const touched = [];
	const wrap = (name) => (target, ...rest) => {
		assert.equal(typeof target, "string", `${name} receives a path`);
		touched.push(path.resolve(target));
		return fs[name](target, ...rest);
	};
	const proxied = {};
	for (const name of [
		"lstatSync", "statSync", "readFileSync", "writeFileSync", "mkdirSync", "renameSync",
		"unlinkSync", "rmdirSync", "copyFileSync", "readdirSync", "realpathSync",
	]) proxied[name] = wrap(name);
	return { fs: proxied, touched, root };
}

const scan = (home, overrides = {}) => scanAgentHooks({ home, platform: "linux", nodeExe: NODE, ...overrides });
const entryOf = (result, id) => result.clients.find((c) => c.id === id);

// --- catalogue ---------------------------------------------------------------

test("schema and closed catalogue", () => {
	assert.equal(SCHEMA, "abito-agent-hooks/1");
	assert.deepEqual([...CLIENT_IDS], ["gemini-cli", "copilot-cli", "opencode", "amp", "cursor"]);
});

// --- preview: read-only states -------------------------------------------------

test("fresh home: every client is not_connected with an install plan and a noop remove plan", () => {
	const home = tmp();
	const g = guard(home);
	const result = scan(home, { fs: g.fs });
	for (const id of CLIENT_IDS) {
		const entry = entryOf(result, id);
		assert.equal(entry.mechanism, "artifact");
		assert.equal(entry.state, "not_connected");
		assert.equal(entry.detail, null);
		assert.equal(entry.install.changed, true);
		assert.match(entry.install.plan_hash, HEX);
		assert.equal(entry.install.reviewable, true);
		assert.ok(entry.install.diff.lines.length > 0);
		assert.equal(entry.remove.changed, false);
		assert.match(entry.remove.plan_hash, HEX);
	}
	// A scan touches files but writes nothing: every touched path stayed inside home.
	for (const p of g.touched) assert.ok(p === home || p.startsWith(home + path.sep), `outside home: ${p}`);
	assert.equal(fs.readdirSync(home).length, 0);
});

test("preview is deterministic: same state, same hash; different home, different hash", () => {
	const a = scan(tmp()).clients.find((c) => c.id === "copilot-cli");
	const b = scan(tmp()).clients.find((c) => c.id === "copilot-cli");
	assert.notEqual(a.install.plan_hash, b.install.plan_hash); // hash binds the target path
	const home = tmp();
	const one = scan(home).clients.find((c) => c.id === "copilot-cli").install.plan_hash;
	const two = scan(home).clients.find((c) => c.id === "copilot-cli").install.plan_hash;
	assert.equal(one, two);
});

test("install then scan: connected, idempotent install plan, removable remove plan", () => {
	const home = tmp();
	const first = scan(home).clients.find((c) => c.id === "opencode");
	const done = installAgentHook({ home, clientId: "opencode", planHash: first.install.plan_hash, platform: "linux", nodeExe: NODE });
	assert.equal(done.ok, true);
	assert.equal(done.changed, true);
	const after = scan(home).clients.find((c) => c.id === "opencode");
	assert.equal(after.state, "connected");
	assert.equal(after.install.changed, false);
	assert.equal(after.remove.changed, true);
	assert.ok(after.remove.diff.lines.every((line) => line.startsWith("@@") || line.startsWith("- ")));
	// idempotent: applying the fresh (changed:false) plan writes nothing new
	const again = installAgentHook({ home, clientId: "opencode", planHash: after.install.plan_hash, platform: "linux", nodeExe: NODE });
	assert.equal(again.ok, true);
	assert.equal(again.changed, false);
});

test("installed artifact contents match the verified client formats", () => {
	const home = tmp();
	for (const id of CLIENT_IDS) {
		const plan = scan(home).clients.find((c) => c.id === id).install;
		assert.equal(installAgentHook({ home, clientId: id, planHash: plan.plan_hash, platform: "linux", nodeExe: NODE }).ok, true);
	}
	// copilot: user-level hooks file, {version:1,hooks:{...}}, exec+args entries
	const copilot = JSON.parse(fs.readFileSync(path.join(home, ".copilot/hooks/abito-island.json"), "utf8"));
	assert.equal(copilot.version, 1);
	assert.ok(Array.isArray(copilot.hooks.sessionStart));
	assert.deepEqual(copilot.hooks.sessionStart[0].args.slice(-2), ["copilot", "session-start"]);
	assert.equal(copilot.hooks.sessionStart[0].exec, NODE);
	// gemini: extension manifest + hooks.json as the EVENT MAP directly (verified in hookRegistry.ts)
	const manifest = JSON.parse(fs.readFileSync(path.join(home, ".gemini/extensions/abito-island/gemini-extension.json"), "utf8"));
	assert.equal(manifest.name, "abito-island");
	const ghooks = JSON.parse(fs.readFileSync(path.join(home, ".gemini/extensions/abito-island/hooks/hooks.json"), "utf8"));
	assert.ok(Array.isArray(ghooks.Notification));
	assert.ok(Array.isArray(ghooks.SessionStart));
	assert.ok(Array.isArray(ghooks.SessionEnd));
	assert.equal(ghooks.Notification[0].hooks[0].type, "command");
	assert.ok(ghooks.Notification[0].hooks[0].command.includes("gemini notification"));
	// opencode / amp: whole-file plugins, marker first, node builtins only
	const oc = fs.readFileSync(path.join(home, ".config/opencode/plugins/abito-island.js"), "utf8");
	assert.ok(oc.startsWith(`// ${MARKER}`));
	assert.ok(oc.includes("export const AbitoIslandPlugin"));
	assert.ok(oc.includes(`"session.created"`));
	const amp = fs.readFileSync(path.join(home, ".config/amp/plugins/abito-island.js"), "utf8");
	assert.ok(amp.startsWith(`// ${MARKER}`));
	assert.ok(amp.includes("export default function"));
	assert.ok(amp.includes(`"session.start"`));
	assert.ok(amp.includes(`"agent.end"`));
	assert.ok(!amp.includes(`"session.end"`)); // Amp has no session.end event (docs)
	// shared notify script written exactly once for the two dependent clients
	const script = fs.readFileSync(path.join(home, ".abito/agent-hooks/island-notify.mjs"), "utf8");
	assert.ok(script.startsWith("#!/usr/bin/env node"));
	assert.ok(script.includes(MARKER));
});

// --- refusals: nothing unexpected is ever overwritten ---------------------------

test("foreign file at a target: error state, no plans, install refused", () => {
	const home = tmp();
	fs.mkdirSync(path.join(home, ".copilot/hooks"), { recursive: true });
	fs.writeFileSync(path.join(home, ".copilot/hooks/abito-island.json"), '{"version":1,"hooks":{}}');
	const entry = scan(home).clients.find((c) => c.id === "copilot-cli");
	assert.equal(entry.state, "error");
	assert.equal(entry.detail, "foreign_file");
	assert.equal(entry.install, null);
	assert.equal(entry.remove, null);
	const result = installAgentHook({ home, clientId: "copilot-cli", planHash: "0".repeat(64), platform: "linux", nodeExe: NODE });
	assert.equal(result.ok, false);
	assert.equal(result.code, "foreign_file");
	assert.equal(fs.readFileSync(path.join(home, ".copilot/hooks/abito-island.json"), "utf8"), '{"version":1,"hooks":{}}');
});

test("symlink at a target: error state, no plans", () => {
	const home = tmp();
	fs.mkdirSync(path.join(home, ".config/opencode/plugins"), { recursive: true });
	fs.symlinkSync("/etc/hostname", path.join(home, ".config/opencode/plugins/abito-island.js"));
	const entry = scan(home).clients.find((c) => c.id === "opencode");
	assert.equal(entry.state, "error");
	assert.equal(entry.detail, "unsafe_target");
	assert.equal(entry.install, null);
});

test("marker-tagged but edited file: outdated, updatable with a fresh plan", () => {
	const home = tmp();
	const plan = scan(home).clients.find((c) => c.id === "copilot-cli").install;
	assert.equal(installAgentHook({ home, clientId: "copilot-cli", planHash: plan.plan_hash, platform: "linux", nodeExe: NODE }).ok, true);
	const file = path.join(home, ".copilot/hooks/abito-island.json");
	fs.writeFileSync(file, `${fs.readFileSync(file, "utf8").trimEnd()}\n// local edit\n`);
	const entry = scan(home).clients.find((c) => c.id === "copilot-cli");
	assert.equal(entry.state, "outdated");
	assert.equal(entry.install.changed, true);
});

test("unsupported platform: listed, unavailable, no plans", () => {
	const home = tmp();
	const entry = scan(home, { platform: "win32" }).clients.find((c) => c.id === "amp");
	assert.equal(entry.state, "error");
	assert.equal(entry.detail, "unsupported_platform");
	assert.equal(entry.install, null);
});

// --- install: hash binding, backup, idempotence ----------------------------------

test("wrong or malformed hash: plan_changed / bad_request, nothing written", () => {
	const home = tmp();
	const g = guard(home);
	const before = scan(home, { fs: g.fs });
	const stale = scan(tmp()).clients.find((c) => c.id === "amp").install.plan_hash;
	for (const [hash, code] of [[stale, "plan_changed"], ["nothex", "bad_request"], [undefined, "bad_request"]]) {
		const result = installAgentHook({ home, clientId: "amp", planHash: hash, platform: "linux", nodeExe: NODE, fs: g.fs });
		assert.equal(result.ok, false);
		assert.equal(result.code, code);
	}
	assert.equal(fs.readdirSync(home).length, 0);
	for (const p of g.touched) assert.ok(p === home || p.startsWith(home + path.sep));
});

test("unknown client id: bad_request", () => {
	const result = installAgentHook({ home: tmp(), clientId: "claude-code", planHash: "0".repeat(64), platform: "linux", nodeExe: NODE });
	assert.equal(result.ok, false);
	assert.equal(result.code, "bad_request");
});

test("install backs up the replaced marker-tagged file with the old bytes", () => {
	const home = tmp();
	const plan = scan(home).clients.find((c) => c.id === "copilot-cli").install;
	installAgentHook({ home, clientId: "copilot-cli", planHash: plan.plan_hash, platform: "linux", nodeExe: NODE });
	const file = path.join(home, ".copilot/hooks/abito-island.json");
	const old = fs.readFileSync(file, "utf8");
	fs.writeFileSync(file, `${old.trimEnd()}\n// local edit\n`);
	const fresh = scan(home).clients.find((c) => c.id === "copilot-cli").install;
	const done = installAgentHook({ home, clientId: "copilot-cli", planHash: fresh.plan_hash, platform: "linux", nodeExe: NODE, now: Date.UTC(2026, 0, 2, 3, 4, 5) });
	assert.equal(done.ok, true);
	const backups = fs.readdirSync(path.join(home, ".copilot/hooks")).filter((n) => n.includes(".abito-backup-"));
	assert.deepEqual(backups, ["abito-island.json.abito-backup-2026-01-02T03-04-05-000Z"]);
	assert.equal(fs.readFileSync(path.join(home, ".copilot/hooks", backups[0]), "utf8"), `${old.trimEnd()}\n// local edit\n`);
	const mode = fs.statSync(path.join(home, ".copilot/hooks", backups[0])).mode & 0o777;
	assert.equal(mode, 0o600);
});

// --- remove: marker-only, hash-bound, script kept while a dependent remains ------

test("remove with the remove-plan hash deletes only Abito artifacts; script outlives a dependent", () => {
	const home = tmp();
	for (const id of ["gemini-cli", "copilot-cli"]) {
		const plan = scan(home).clients.find((c) => c.id === id).install;
		assert.equal(installAgentHook({ home, clientId: id, planHash: plan.plan_hash, platform: "linux", nodeExe: NODE }).ok, true);
	}
	// remove copilot: its artifact goes, the shared script stays (gemini still uses it)
	const rm = scan(home).clients.find((c) => c.id === "copilot-cli").remove;
	const done = removeAgentHook({ home, clientId: "copilot-cli", planHash: rm.plan_hash, platform: "linux", nodeExe: NODE });
	assert.equal(done.ok, true);
	assert.ok(!fs.existsSync(path.join(home, ".copilot/hooks/abito-island.json")));
	assert.ok(fs.existsSync(path.join(home, ".abito/agent-hooks/island-notify.mjs")));
	// remove gemini: extension dir goes and the script goes with the last dependent
	const rm2 = scan(home).clients.find((c) => c.id === "gemini-cli").remove;
	assert.equal(removeAgentHook({ home, clientId: "gemini-cli", planHash: rm2.plan_hash, platform: "linux", nodeExe: NODE }).ok, true);
	// reversible: only backups remain next to the removed artifacts, never a live one
	const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [d.name]));
	const left = walk(path.join(home, ".gemini/extensions/abito-island"));
	assert.ok(left.length > 0 && left.every((n) => n.includes(".abito-backup-")), `live artifact left: ${left}`);
	assert.ok(!fs.existsSync(path.join(home, ".gemini/extensions/abito-island/hooks/hooks.json")));
	assert.ok(!fs.existsSync(path.join(home, ".abito/agent-hooks/island-notify.mjs")));
	const after = scan(home);
	assert.ok(after.clients.every((c) => c.state === "not_connected"));
});

test("remove refuses when the gemini extension directory holds foreign content", () => {
	const home = tmp();
	const plan = scan(home).clients.find((c) => c.id === "gemini-cli").install;
	installAgentHook({ home, clientId: "gemini-cli", planHash: plan.plan_hash, platform: "linux", nodeExe: NODE });
	fs.writeFileSync(path.join(home, ".gemini/extensions/abito-island/user-file.txt"), "mine");
	const entry = scan(home).clients.find((c) => c.id === "gemini-cli");
	assert.equal(entry.state, "error");
	assert.equal(entry.detail, "unexpected_content");
	const rmHash = entry.remove?.plan_hash ?? "0".repeat(64);
	const result = removeAgentHook({ home, clientId: "gemini-cli", planHash: rmHash, platform: "linux", nodeExe: NODE });
	assert.equal(result.ok, false);
	assert.equal(result.code, "unexpected_content");
	assert.ok(fs.existsSync(path.join(home, ".gemini/extensions/abito-island/gemini-extension.json")));
});

test("remove with a wrong hash: plan_changed, nothing removed", () => {
	const home = tmp();
	const plan = scan(home).clients.find((c) => c.id === "opencode").install;
	installAgentHook({ home, clientId: "opencode", planHash: plan.plan_hash, platform: "linux", nodeExe: NODE });
	const other = scan(tmp()).clients.find((c) => c.id === "opencode").remove.plan_hash;
	const result = removeAgentHook({ home, clientId: "opencode", planHash: other, platform: "linux", nodeExe: NODE });
	assert.equal(result.ok, false);
	assert.equal(result.code, "plan_changed");
	assert.ok(fs.existsSync(path.join(home, ".config/opencode/plugins/abito-island.js")));
});

// --- composed service + protocol frames (wiring) ----------------------------------

const P = require("../src/protocol.cjs");
const { createAgentHooks } = require("../src/agent-hooks.cjs");

function fakeAgents() {
	const calls = [];
	const entry = (id, state, extra = {}) => ({ id, name: id, state, backup: false, detail: null, ...extra });
	return {
		calls,
		available: true,
		async list() {
			return [entry("claude-code", "not_connected", { plan_hash: "a".repeat(64), summary: "Adds the Abito hooks.", reviewable: true }), entry("codex", "unavailable"), entry("copilot-cli", "unavailable"), entry("opencode", "unavailable")];
		},
		async connect(id, hash) {
			calls.push(["connect", id, hash]);
			return [entry("claude-code", "connected"), entry("codex", "unavailable"), entry("copilot-cli", "unavailable"), entry("opencode", "unavailable")];
		},
		async disconnect(id) {
			calls.push(["disconnect", id]);
			return [entry("claude-code", "not_connected"), entry("codex", "unavailable"), entry("copilot-cli", "unavailable"), entry("opencode", "unavailable")];
		},
	};
}

test("service composes harness clients with native ones in a closed order", async () => {
	const svc = createAgentHooks({ home: tmp(), nodeExe: NODE, platform: "linux", agents: fakeAgents() });
	const { clients } = await svc.preview();
	assert.deepEqual(clients.map((c) => c.id), ["claude-code", "codex", "copilot-cli", "opencode", "gemini-cli", "amp", "cursor"]);
	assert.equal(clients[0].mechanism, "harness");
	assert.equal(clients[2].mechanism, "harness", "copilot-cli and opencode are driven by the harness installer now, never by the notify-only native adapter");
	assert.equal(clients[0].install.plan_hash, "a".repeat(64));
	assert.equal(clients[4].mechanism, "artifact");
});

test("service routes harness ids to AgentsManager and requires a hash for install", async () => {
	const agents = fakeAgents();
	const svc = createAgentHooks({ home: tmp(), nodeExe: NODE, platform: "linux", agents });
	const bad = await svc.install("claude-code", undefined);
	assert.equal(bad.result.ok, false);
	assert.equal(bad.result.code, "bad_request");
	assert.deepEqual(agents.calls, []); // rejected input: nothing delegated
	const ok = await svc.install("claude-code", "a".repeat(64));
	assert.equal(ok.result.ok, true);
	assert.deepEqual(agents.calls, [["connect", "claude-code", "a".repeat(64)]]);
	await svc.remove("claude-code", undefined);
	assert.deepEqual(agents.calls.at(-1), ["disconnect", "claude-code"]);
});

test('notify integrations are composed, routable and accepted in the bounded hooks frame', async () => {
 const agents = fakeAgents();
 const oldList = agents.list;
 agents.list = async () => [...await oldList(), ...['recap', 'statusline'].map(id => ({ id, name: id, state: 'not_connected', detail: null, backup: false, plan_hash: 'a'.repeat(64), summary: 'A backup is made first.', reviewable: true }))];
 const svc = createAgentHooks({ home: tmp(), nodeExe: NODE, platform: 'linux', agents });
 const data = await svc.preview();
 assert.equal(P.hooksFrame(data).clients.length, 9);
 for (const id of ['recap', 'statusline']) {
  assert.deepEqual(P.validateClientFrame({ type: 'hooks_install', clientId: id, plan_hash: 'a'.repeat(64), argv: ['evil'], env: { EVIL: '1' } }), { type: 'hooks_install', clientId: id, plan_hash: 'a'.repeat(64) });
  await svc.install(id, 'a'.repeat(64));
  assert.deepEqual(agents.calls.at(-1), ['connect', id, 'a'.repeat(64)]);
  await svc.remove(id);
  assert.deepEqual(agents.calls.at(-1), ['disconnect', id]);
 }
});

test("service never installs on preview and rejects unknown ids", async () => {
	const home = tmp();
	const svc = createAgentHooks({ home, nodeExe: NODE, platform: "linux" });
	await svc.preview();
	assert.equal(fs.readdirSync(home).length, 0);
	assert.equal((await svc.install("windsurf", "a".repeat(64))).result.code, "bad_request");
	assert.equal((await svc.remove("amp", "nothex")).result.code, "bad_request");
});

test("client frames: closed ids, hash grammar, unknown keys dropped", () => {
	assert.deepEqual(P.validateClientFrame({ type: "hooks_preview", x: 1 }), { type: "hooks_preview" });
	assert.deepEqual(P.validateClientFrame({ type: "hooks_install", clientId: "amp", plan_hash: "b".repeat(64), x: 1 }), { type: "hooks_install", clientId: "amp", plan_hash: "b".repeat(64) });
	assert.deepEqual(P.validateClientFrame({ type: "hooks_remove", clientId: "claude-code" }), { type: "hooks_remove", clientId: "claude-code" });
	assert.equal(P.validateClientFrame({ type: "hooks_install", clientId: "windsurf", plan_hash: "b".repeat(64) }), undefined);
	assert.deepEqual(P.validateClientFrame({ type: "hooks_install", clientId: "cursor", plan_hash: "b".repeat(64) }), { type: "hooks_install", clientId: "cursor", plan_hash: "b".repeat(64) });
	assert.equal(P.validateClientFrame({ type: "hooks_install", clientId: "amp", plan_hash: "XYZ" }), undefined);
	assert.equal(P.validateClientFrame({ type: "hooks_install", clientId: "amp" }), undefined);
});

test("hooks frame rebuilds from an allowlist and throws on invalid data", async () => {
	const svc = createAgentHooks({ home: tmp(), nodeExe: NODE, platform: "linux", agents: fakeAgents() });
	const { clients } = await svc.preview();
	const frame = P.hooksFrame({ clients: clients.map((c) => ({ ...c, secret: "leak" })), result: { clientId: "amp", action: "install", ok: false, code: "plan_changed" } });
	assert.equal(frame.type, "hooks");
	assert.equal(frame.clients.length, 7);
	assert.ok(!JSON.stringify(frame).includes("leak"));
	assert.deepEqual(frame.result, { clientId: "amp", action: "install", ok: false, code: "plan_changed" });
	assert.throws(() => P.hooksFrame({ clients: [{ id: "cursor" }] }));
	assert.throws(() => P.hooksFrame({ clients: [{ ...clients[4], state: "weird" }] }));
});

// --- backups: always 0600, never overwrite an existing backup ------------------------

test("backup of a 0644 source is exactly 0600 and an existing backup name is never overwritten", () => {
	const home = tmp();
	const plan = scan(home).clients.find((c) => c.id === "copilot-cli").install;
	installAgentHook({ home, clientId: "copilot-cli", planHash: plan.plan_hash, platform: "linux", nodeExe: NODE });
	const dir = path.join(home, ".copilot/hooks");
	const file = path.join(dir, "abito-island.json");
	fs.writeFileSync(file, `${fs.readFileSync(file, "utf8").trimEnd()}\n// local edit\n`);
	fs.chmodSync(file, 0o644);
	const now = Date.UTC(2026, 0, 2, 3, 4, 5);
	const taken = path.join(dir, "abito-island.json.abito-backup-2026-01-02T03-04-05-000Z");
	fs.writeFileSync(taken, "precious", { mode: 0o644 });
	const fresh = scan(home).clients.find((c) => c.id === "copilot-cli").install;
	assert.equal(installAgentHook({ home, clientId: "copilot-cli", planHash: fresh.plan_hash, platform: "linux", nodeExe: NODE, now }).ok, true);
	assert.equal(fs.readFileSync(taken, "utf8"), "precious");
	const backups = fs.readdirSync(dir).filter((n) => n.includes(".abito-backup-") && path.join(dir, n) !== taken);
	assert.equal(backups.length, 1);
	assert.equal(fs.statSync(path.join(dir, backups[0])).mode & 0o777, 0o600);
});

// --- cursor (#467): ~/.cursor/hooks.json is the USER'S file, merged not owned ------------

const CURSOR_FILE = ".cursor/hooks.json";
const cursorEntry = (home, overrides = {}) => scan(home, overrides).clients.find((c) => c.id === "cursor");
const cursorInstall = (home, extra = {}) => {
	const plan = cursorEntry(home).install;
	return installAgentHook({ home, clientId: "cursor", planHash: plan.plan_hash, platform: "linux", nodeExe: NODE, ...extra });
};
const cursorRemove = (home, extra = {}) => {
	const plan = cursorEntry(home).remove;
	return removeAgentHook({ home, clientId: "cursor", planHash: plan.plan_hash, platform: "linux", nodeExe: NODE, ...extra });
};
const ours = (c) => typeof c.command === "string" && c.command.includes(MARKER);

test("cursor: fresh home creates hooks.json {version:1} with notify-only camelCase events", () => {
	const home = tmp();
	const entry = cursorEntry(home);
	assert.equal(entry.mechanism, "artifact");
	assert.equal(entry.state, "not_connected");
	assert.equal(entry.remove.changed, false);
	assert.equal(cursorInstall(home).ok, true);
	const json = JSON.parse(fs.readFileSync(path.join(home, CURSOR_FILE), "utf8"));
	assert.equal(json.version, 1);
	assert.deepEqual(Object.keys(json.hooks).sort(), ["sessionEnd", "sessionStart", "stop"]);
	for (const list of Object.values(json.hooks)) {
		assert.equal(list.length, 1);
		assert.ok(ours(list[0]));
		assert.ok(list[0].command.includes(path.join(home, ".abito/agent-hooks/island-notify.mjs")));
		assert.ok(list[0].command.includes(" cursor "));
	}
	assert.ok(fs.existsSync(path.join(home, ".abito/agent-hooks/island-notify.mjs")));
	assert.equal(cursorEntry(home).state, "connected");
	assert.equal(cursorEntry(home).install.changed, false); // a second plan is a noop
});

test("cursor: install merges into the user's hooks.json, keeps their hooks, backs up the old bytes", () => {
	const home = tmp();
	fs.mkdirSync(path.join(home, ".cursor"));
	const mine = '{"version":2,"hooks":{"afterFileEdit":[{"command":"./format.sh"}],"stop":[{"command":"./notify.sh"}]}}\n';
	fs.writeFileSync(path.join(home, CURSOR_FILE), mine);
	const entry = cursorEntry(home);
	assert.equal(entry.state, "not_connected");
	assert.equal(entry.detail, null);
	assert.equal(cursorInstall(home, { now: Date.UTC(2026, 0, 2, 3, 4, 5) }).ok, true);
	const json = JSON.parse(fs.readFileSync(path.join(home, CURSOR_FILE), "utf8"));
	assert.equal(json.version, 2); // a version the user set is theirs
	assert.deepEqual(json.hooks.afterFileEdit, [{ command: "./format.sh" }]);
	assert.deepEqual(json.hooks.stop[0], { command: "./notify.sh" });
	assert.ok(ours(json.hooks.stop[1]));
	const backups = fs.readdirSync(path.join(home, ".cursor")).filter((n) => n.includes(".abito-backup-"));
	assert.equal(backups.length, 1);
	assert.equal(fs.readFileSync(path.join(home, ".cursor", backups[0]), "utf8"), mine);
});

test("cursor: remove takes out only Abito's entries and leaves the user's file as it was", () => {
	const home = tmp();
	fs.mkdirSync(path.join(home, ".cursor"));
	const mine = { version: 1, hooks: { afterFileEdit: [{ command: "./format.sh" }], stop: [{ command: "./notify.sh" }] } };
	fs.writeFileSync(path.join(home, CURSOR_FILE), `${JSON.stringify(mine, null, 2)}\n`);
	cursorInstall(home);
	assert.equal(cursorRemove(home).ok, true);
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, CURSOR_FILE), "utf8")), mine);
	assert.equal(cursorEntry(home).state, "not_connected");
	assert.ok(!fs.existsSync(path.join(home, ".abito/agent-hooks/island-notify.mjs")));
});

test("cursor: remove of a file Abito created deletes it (backup stays)", () => {
	const home = tmp();
	cursorInstall(home);
	assert.equal(cursorRemove(home).ok, true);
	assert.ok(!fs.existsSync(path.join(home, CURSOR_FILE)));
	assert.ok(fs.readdirSync(path.join(home, ".cursor")).every((n) => n.includes(".abito-backup-")));
});

test("cursor: invalid JSON or non-object hooks are refused, never rewritten", () => {
	for (const text of ["{not json", "[]", '{"hooks":[]}', '{"hooks":{"stop":"x"}}']) {
		const home = tmp();
		fs.mkdirSync(path.join(home, ".cursor"));
		fs.writeFileSync(path.join(home, CURSOR_FILE), text);
		const entry = cursorEntry(home);
		assert.equal(entry.state, "error", text);
		assert.equal(entry.install, null);
		const result = installAgentHook({ home, clientId: "cursor", planHash: "0".repeat(64), platform: "linux", nodeExe: NODE });
		assert.equal(result.ok, false);
		assert.equal(fs.readFileSync(path.join(home, CURSOR_FILE), "utf8"), text);
	}
});

test("cursor: shared notify script is kept while another dependent uses it, and vice versa", () => {
	const home = tmp();
	const plan = scan(home).clients.find((c) => c.id === "copilot-cli").install;
	installAgentHook({ home, clientId: "copilot-cli", planHash: plan.plan_hash, platform: "linux", nodeExe: NODE });
	cursorInstall(home);
	cursorRemove(home);
	assert.ok(fs.existsSync(path.join(home, ".abito/agent-hooks/island-notify.mjs")));
	cursorInstall(home);
	const rm = scan(home).clients.find((c) => c.id === "copilot-cli").remove;
	removeAgentHook({ home, clientId: "copilot-cli", planHash: rm.plan_hash, platform: "linux", nodeExe: NODE });
	assert.ok(fs.existsSync(path.join(home, ".abito/agent-hooks/island-notify.mjs"))); // cursor still uses it
});

test("cursor: edited Abito entries read as outdated and a re-install repairs them", () => {
	const home = tmp();
	cursorInstall(home);
	const file = path.join(home, CURSOR_FILE);
	const json = JSON.parse(fs.readFileSync(file, "utf8"));
	json.hooks.stop[0].command = json.hooks.stop[0].command.replace("cursor stop", "cursor stale");
	fs.writeFileSync(file, JSON.stringify(json));
	assert.equal(cursorEntry(home).state, "outdated");
	assert.equal(cursorInstall(home).ok, true);
	assert.equal(cursorEntry(home).state, "connected");
	assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).hooks.stop.filter(ours).length, 1);
});

test("cursor: a symlinked hooks.json is unsafe_target and no path leaves home", () => {
	const home = tmp();
	fs.mkdirSync(path.join(home, ".cursor"));
	fs.writeFileSync(path.join(home, "elsewhere.json"), "{}");
	fs.symlinkSync(path.join(home, "elsewhere.json"), path.join(home, CURSOR_FILE));
	const g = guard(home);
	const entry = cursorEntry(home, { fs: g.fs });
	assert.equal(entry.detail, "unsafe_target");
	for (const p of g.touched) assert.ok(p === home || p.startsWith(home + path.sep));
});

// --- security review R17 / R18 -------------------------------------------------

test("R17: a quote in HOME or the node path cannot break out of the gemini hook command", () => {
	const { execFileSync } = require("node:child_process");
	const base = tmp();
	const home = path.join(base, "it's $HOME");
	fs.mkdirSync(home);
	const nodeExe = "/opt/o'brien/bin/node";
	const entry = scanAgentHooks({ home, platform: "linux", nodeExe }).clients.find((c) => c.id === "gemini-cli");
	const done = installAgentHook({ home, clientId: "gemini-cli", planHash: entry.install.plan_hash, platform: "linux", nodeExe });
	assert.equal(done.ok, true);
	const hooks = JSON.parse(fs.readFileSync(path.join(home, ".gemini/extensions/abito-island/hooks/hooks.json"), "utf8"));
	const command = hooks.SessionStart[0].hooks[0].command;
	// the shell must see exactly four words: node, script, client, event
	const words = execFileSync("sh", ["-c", `printf '%s|' ${command}`], { encoding: "utf8" }).split("|").slice(0, -1);
	assert.equal(words.length, 4);
	assert.equal(words[0], nodeExe);
	assert.ok(words[1].startsWith(home + path.sep));
	assert.deepEqual(words.slice(2), ["gemini", "session-start"]);
});

test("R17: control characters in the node path or HOME are refused and nothing is written", () => {
	const home = tmp();
	assert.throws(() => scan(home, { nodeExe: "/usr/bin/no\nde" }), /invalid nodeExe/);
	const evil = path.join(home, "a\nb");
	fs.mkdirSync(evil);
	assert.throws(() => scanAgentHooks({ home: evil, platform: "linux", nodeExe: NODE }), /invalid home/);
	assert.deepEqual(fs.readdirSync(evil), []);
});

test("R18: a symlinked intermediate directory never lets a write or backup leave HOME", () => {
	const home = tmp();
	const outside = tmp();
	fs.symlinkSync(outside, path.join(home, ".gemini"));
	const entry = scan(home).clients.find((c) => c.id === "gemini-cli");
	assert.equal(entry.state, "error");
	assert.equal(entry.detail, "unsafe_target");
	assert.equal(entry.install, null);
	const result = installAgentHook({ home, clientId: "gemini-cli", planHash: "0".repeat(64), platform: "linux", nodeExe: NODE });
	assert.equal(result.ok, false);
	assert.deepEqual(fs.readdirSync(outside), []);
});

test("R18: the same holds when an already-installed tree is later replaced by a symlinked parent", () => {
	const home = tmp();
	const outside = tmp();
	const first = scan(home).clients.find((c) => c.id === "opencode");
	assert.equal(installAgentHook({ home, clientId: "opencode", planHash: first.install.plan_hash, platform: "linux", nodeExe: NODE }).ok, true);
	// dotfile-manager style: ~/.config/opencode becomes a link to a directory outside HOME
	fs.cpSync(path.join(home, ".config/opencode"), path.join(outside, "oc"), { recursive: true });
	fs.rmSync(path.join(home, ".config/opencode"), { recursive: true });
	fs.symlinkSync(path.join(outside, "oc"), path.join(home, ".config/opencode"));
	const snapshot = JSON.stringify(fs.readdirSync(path.join(outside, "oc/plugins")));
	const entry = scan(home).clients.find((c) => c.id === "opencode");
	assert.equal(entry.state, "error");
	const removed = removeAgentHook({ home, clientId: "opencode", planHash: "0".repeat(64), platform: "linux", nodeExe: NODE });
	assert.equal(removed.ok, false);
	assert.equal(JSON.stringify(fs.readdirSync(path.join(outside, "oc/plugins"))), snapshot);
});
