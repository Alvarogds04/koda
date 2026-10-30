"use strict";

// U4 config tests: validation matrix, env override, setWorkspace, memory conflict, MCP projection.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../src/config.cjs");
const { ensureIsland } = require("../src/isolation.cjs");

function tmp() {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "abito-cfg-")));
}
function island() {
	const root = path.join(tmp(), "island");
	ensureIsland(root);
	return root;
}
function writeConfig(root, value, mode = 0o600) {
	const file = path.join(root, "config.json");
	fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value), { mode });
	fs.chmodSync(file, mode);
}
const load = (root, env = {}) => config.loadConfig(root, { env });
function rejects(fn, field) {
	assert.throws(fn, (error) => {
		assert.ok(error instanceof config.ConfigError, "ConfigError expected");
		assert.equal(error.field, field);
		assert.equal(error.message, `invalid config: ${field}`);
		return true;
	});
}

test("defaults when config.json is absent", () => {
	const root = island();
	const cfg = load(root);
	assert.equal(cfg.command, "pi");
	assert.equal(cfg.workspace, path.join(root, "workspace"));
	assert.equal(cfg.workspaceSource, "default");
	assert.equal(cfg.mcpConfigPath, undefined);
});

test("accepts a valid full config", () => {
	const root = island();
	const ws = tmp();
	writeConfig(root, { workspace: ws, command: "/usr/bin/env", thinking: "high", profile: "main-cloud" });
	const cfg = load(root);
	assert.equal(cfg.workspace, ws);
	assert.equal(cfg.workspaceSource, "file");
	assert.equal(cfg.command, "/usr/bin/env");
	assert.equal(cfg.thinking, "high");
	assert.equal(cfg.profile, "main-cloud");
});

test("workspace validation matrix", () => {
	const root = island();
	const base = tmp();
	const file = path.join(base, "afile");
	fs.writeFileSync(file, "x");
	const real = path.join(base, "real");
	fs.mkdirSync(real);
	const link = path.join(base, "link");
	fs.symlinkSync(real, link);
	const viaLink = path.join(link, "sub");
	fs.mkdirSync(path.join(real, "sub"));
	const inside = path.join(root, "home");
	const cases = {
		relative: "some/dir",
		dotdot: `${base}/real/../real`,
		missing: path.join(base, "nope"),
		fileNotDir: file,
		symlink: link,
		symlinkComponent: viaLink,
		islandRoot: root,
		insideIsland: inside,
		empty: "",
		nul: `${base}\0x`,
	};
	for (const [name, value] of Object.entries(cases)) {
		writeConfig(root, { workspace: value });
		rejects(() => load(root), "workspace");
		assert.ok(name);
	}
});

test("island default workspace is allowed explicitly", () => {
	const root = island();
	writeConfig(root, { workspace: path.join(root, "workspace") });
	assert.equal(load(root).workspace, path.join(root, "workspace"));
});

test("unknown keys, wrong types and bad command are rejected with the field name only", () => {
	const root = island();
	writeConfig(root, { workspace: tmp(), extra: 1 });
	rejects(() => load(root), "extra");
	for (const [key, value] of [
		["workspace", 5],
		["command", 5],
		["command", "rel/pi"],
		["command", "/abs/../pi"],
		["command", "pi; rm"],
		["command", ""],
		["thinking", "ultra"],
		["thinking", 3],
		["profile", "Bad Id"],
		["mcpConfigPath", "relative.json"],
		["mcpConfigPath", 7],
	]) {
		writeConfig(root, { [key]: value });
		rejects(() => load(root), key);
	}
	writeConfig(root, "[]");
	rejects(() => load(root), "config.json");
	writeConfig(root, "{not json");
	rejects(() => load(root), "config.json");
});

test("config.json must be a private regular file", () => {
	const root = island();
	writeConfig(root, { command: "pi" }, 0o644);
	rejects(() => load(root), "config.json");
	fs.unlinkSync(path.join(root, "config.json"));
	const other = path.join(tmp(), "c.json");
	fs.writeFileSync(other, "{}", { mode: 0o600 });
	fs.symlinkSync(other, path.join(root, "config.json"));
	rejects(() => load(root), "config.json");
});

test("error messages never echo values", () => {
	const root = island();
	writeConfig(root, { workspace: "/SECRET-LOOKING/../path" });
	try {
		load(root);
		assert.fail("should throw");
	} catch (error) {
		assert.ok(!error.message.includes("SECRET"));
	}
});

test("ABITO_WORKSPACE overrides the file and is validated", () => {
	const root = island();
	const fileWs = tmp();
	const envWs = tmp();
	writeConfig(root, { workspace: fileWs });
	const cfg = load(root, { ABITO_WORKSPACE: envWs });
	assert.equal(cfg.workspace, envWs);
	assert.equal(cfg.workspaceSource, "env");
	rejects(() => load(root, { ABITO_WORKSPACE: "relative" }), "ABITO_WORKSPACE");
	rejects(() => load(root, { ABITO_WORKSPACE: path.join(root, "home") }), "ABITO_WORKSPACE");
	// an empty env var is "not set"
	assert.equal(load(root, { ABITO_WORKSPACE: "" }).workspace, fileWs);
});

test("setWorkspace persists atomically at 0600, keeps other keys and clears the session pointer", () => {
	const root = island();
	writeConfig(root, { command: "pi", thinking: "low" });
	fs.writeFileSync(path.join(root, "state.json"), JSON.stringify({ sessionFile: path.join(root, "sessions", "old.jsonl") }), { mode: 0o600 });
	const ws = tmp();
	const result = config.setWorkspace(root, ws, { env: {} });
	assert.equal(result.restartRequired, true);
	assert.equal(result.workspace, ws);
	assert.equal(result.changed, true);
	const file = path.join(root, "config.json");
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	const saved = JSON.parse(fs.readFileSync(file, "utf8"));
	assert.deepEqual(saved, { command: "pi", thinking: "low", workspace: ws });
	assert.equal(JSON.parse(fs.readFileSync(path.join(root, "state.json"), "utf8")).sessionFile, undefined);
	assert.deepEqual(fs.readdirSync(root).filter((n) => n.includes(".tmp-")), []);
	// same value again: no session reset needed
	assert.equal(config.setWorkspace(root, ws, { env: {} }).changed, false);
});

test("setWorkspace refuses invalid input and leaves the file untouched", () => {
	const root = island();
	writeConfig(root, { thinking: "low" });
	const before = fs.readFileSync(path.join(root, "config.json"), "utf8");
	rejects(() => config.setWorkspace(root, "relative", { env: {} }), "workspace");
	rejects(() => config.setWorkspace(root, root, { env: {} }), "workspace");
	assert.equal(fs.readFileSync(path.join(root, "config.json"), "utf8"), before);
});

test("setWorkspace under ABITO_WORKSPACE persists but reports the override", () => {
	const root = island();
	const result = config.setWorkspace(root, tmp(), { env: { ABITO_WORKSPACE: tmp() } });
	assert.equal(result.overriddenByEnv, true);
});

test("memory conflict detection is read-only", () => {
	const root = island();
	const ws = tmp();
	assert.equal(config.detectMemoryPinConflict(ws), false);
	fs.mkdirSync(path.join(ws, ".engram"));
	fs.writeFileSync(path.join(ws, ".engram", "config.json"), JSON.stringify({ project_name: "other" }));
	const snapshot = () => fs.readdirSync(ws, { recursive: true }).sort().join("|");
	const before = snapshot();
	const mtime = fs.statSync(path.join(ws, ".engram", "config.json")).mtimeMs;
	assert.equal(config.detectMemoryPinConflict(ws), true);
	assert.equal(snapshot(), before);
	assert.equal(fs.statSync(path.join(ws, ".engram", "config.json")).mtimeMs, mtime);
	fs.writeFileSync(path.join(ws, ".engram", "config.json"), JSON.stringify({ project_name: "abito-island" }));
	assert.equal(config.detectMemoryPinConflict(ws), false);
	fs.writeFileSync(path.join(ws, ".engram", "config.json"), "garbage");
	assert.equal(config.detectMemoryPinConflict(ws), false);
	assert.ok(root);
});

// ----- MCP projection ---------------------------------------------------------

function mcpFile(content, mode = 0o600) {
	const file = path.join(tmp(), "mcp-source.json");
	fs.writeFileSync(file, JSON.stringify(content), { mode });
	fs.chmodSync(file, mode);
	return file;
}
const good = { type: "http", url: "http://127.0.0.1:4821/notes", headers: { Authorization: "Bearer cap_abcdef123456" } };

test("MCP projection accepts proxy-only loopback entries and keeps every valid server", () => {
	const projection = config.projectMcpConfig(mcpFile({ mcpServers: { notes: good, calendar: { url: "http://localhost:9/cal", headers: { Authorization: "Bearer cap_abcdef123456" } } } }));
	assert.deepEqual(JSON.parse(JSON.stringify(projection)), {
		mcpServers: {
			notes: good,
			calendar: { type: "http", url: "http://localhost:9/cal", headers: { Authorization: "Bearer cap_abcdef123456" } },
		},
	});
});

test("MCP projection rejects every unsafe shape (fail closed, whole file)", () => {
	const bad = {
		command: { ...good, command: "npx" },
		env: { ...good, env: { A: "b" } },
		args: { ...good, args: ["x"] },
		cwd: { ...good, cwd: "/" },
		oauth: { ...good, oauth: {} },
		remote: { ...good, url: "https://example.com/mcp" },
		remoteHttp: { ...good, url: "http://10.0.0.5:80/x" },
		lookalike: { ...good, url: "http://127.0.0.1.evil.com/x" },
		credsInUrl: { ...good, url: "http://u:p@127.0.0.1:1/x" },
		stdioType: { ...good, type: "stdio" },
		sse: { ...good, type: "sse" },
		noHeaders: { type: "http", url: good.url },
		basic: { ...good, headers: { Authorization: "Basic abcdefgh1234" } },
		extraHeader: { ...good, headers: { Authorization: "Bearer cap_abcdef123456", "X-A": "b" } },
		shellValue: { ...good, headers: { Authorization: "!echo Bearer abc" } },
		envValue: { ...good, headers: { Authorization: "Bearer ${TOKEN}" } },
		short: { ...good, headers: { Authorization: "Bearer x" } },
		notObject: "oops",
	};
	for (const [name, entry] of Object.entries(bad)) {
		assert.throws(() => config.projectMcpConfig(mcpFile({ mcpServers: { ok: good, evil: entry } })), (e) => e instanceof config.ConfigError && e.field === "mcpConfigPath", name);
	}
	assert.throws(() => config.projectMcpConfig(mcpFile({ mcpServers: { "bad id!": good } })), config.ConfigError);
	assert.throws(() => config.projectMcpConfig(mcpFile({ mcpServers: {}, autoEnableCodemode: true })), config.ConfigError);
	assert.throws(() => config.projectMcpConfig(mcpFile({ servers: {} })), config.ConfigError);
	assert.throws(() => config.projectMcpConfig(mcpFile({ mcpServers: { notes: good } }, 0o644)), config.ConfigError);
	assert.throws(() => config.projectMcpConfig(path.join(tmp(), "missing.json")), config.ConfigError);
});

test("MCP projection refuses a symlinked source", () => {
	const real = mcpFile({ mcpServers: { notes: good } });
	const link = path.join(tmp(), "l.json");
	fs.symlinkSync(real, link);
	assert.throws(() => config.projectMcpConfig(link), config.ConfigError);
});

test("writeMcpProjection lands at <agent>/mcp.json 0600; unset path writes an empty projection", () => {
	const root = island();
	const agentFile = path.join(root, "agent", "mcp.json");
	config.writeMcpProjection(root, mcpFile({ mcpServers: { notes: good } }));
	assert.equal(fs.statSync(agentFile).mode & 0o777, 0o600);
	assert.deepEqual(JSON.parse(fs.readFileSync(agentFile, "utf8")), { mcpServers: { notes: good } });
	config.writeMcpProjection(root, undefined);
	assert.deepEqual(JSON.parse(fs.readFileSync(agentFile, "utf8")), { mcpServers: {} });
});

test("MCP projection writes the WHATWG-normalized URL, not the raw input", () => {
	const raw = { ...good, url: "http://LOCALHOST:0080/a/../b" };
	const projection = config.projectMcpConfig(mcpFile({ mcpServers: { n: raw } }));
	assert.equal(projection.mcpServers.n.url, "http://localhost/b");
	const v6 = config.projectMcpConfig(mcpFile({ mcpServers: { n: { ...good, url: "http://[::1]:8080" } } }));
	assert.equal(v6.mcpServers.n.url, "http://[::1]:8080/");
});

test("MCP projection rejects prototype-polluting ids and builds a null-prototype map", () => {
	for (const id of ["__proto__", "constructor", "prototype"]) {
		const file = mcpFile({});
		fs.writeFileSync(file, `{"mcpServers":{"${id}":${JSON.stringify(good)}}}`);
		rejects(() => config.projectMcpConfig(file), "mcpConfigPath");
	}
	const projection = config.projectMcpConfig(mcpFile({ mcpServers: { notes: good } }));
	assert.equal(Object.getPrototypeOf(projection.mcpServers), null);
	assert.equal(Object.prototype.polluted, undefined);
});

test("readConfigFile refuses a symlinked island directory (parent chain check)", () => {
	const base = tmp();
	const real = path.join(base, "real");
	ensureIsland(real);
	writeConfig(real, { command: "pi" });
	const link = path.join(base, "link");
	fs.symlinkSync(real, link);
	rejects(() => config.readConfigFile(link), "config.json");
	rejects(() => config.loadConfig(link, { env: {} }), "config.json");
});

test("removeMcpProjection unlinks only a regular, non-symlink file; ENOENT is fine; never throws", () => {
	const root = path.join(tmp(), "i");
	const agentFile = path.join(root, "agent", "mcp.json");
	assert.doesNotThrow(() => config.removeMcpProjection(root)); // no island at all
	config.writeMcpProjection(root, mcpFile({ mcpServers: { notes: good } }));
	assert.equal(config.removeMcpProjection(root), true);
	assert.equal(fs.existsSync(agentFile), false);
	assert.equal(config.removeMcpProjection(root), false); // ENOENT
	const victim = path.join(tmp(), "victim.txt");
	fs.writeFileSync(victim, "keep");
	fs.symlinkSync(victim, agentFile);
	assert.equal(config.removeMcpProjection(root), false);
	assert.equal(fs.readFileSync(victim, "utf8"), "keep");
	assert.equal(fs.lstatSync(agentFile).isSymbolicLink(), true, "symlink is left alone");
	fs.unlinkSync(agentFile);
	fs.mkdirSync(agentFile); // a directory is not a regular file
	assert.equal(config.removeMcpProjection(root), false);
	fs.rmdirSync(agentFile);
});

// ----- hotkey (V2) ---------------------------------------------------------------

test("hotkey grammar: accepted forms are canonicalized", () => {
	const ok = {
		"Ctrl+Alt+Space": "Ctrl+Alt+Space",
		"ctrl+alt+space": "Ctrl+Alt+Space",
		"SUPER+shift+ctrl+alt+a": "Ctrl+Alt+Shift+Super+A",
		"super+z": "Super+Z",
		"alt+0": "Alt+0",
		"Ctrl+f1": "Ctrl+F1",
		"Ctrl+F24": "Ctrl+F24",
		"shift+PAGEUP": "Shift+PageUp",
		"ctrl+pagedown": "Ctrl+PageDown",
		"ctrl+ESCAPE": "Ctrl+Escape",
		"alt+up": "Alt+Up",
	};
	for (const [input, canonical] of Object.entries(ok)) assert.equal(config.validateHotkey(input), canonical, input);
	for (const key of ["Space", "Enter", "Tab", "Escape", "Backspace", "Delete", "Insert", "Home", "End", "PageUp", "PageDown", "Up", "Down", "Left", "Right"]) {
		assert.equal(config.validateHotkey(`Ctrl+${key.toLowerCase()}`), `Ctrl+${key}`);
	}
});

test("hotkey grammar: rejected forms throw ConfigError('hotkey') without echoing the value", () => {
	const bad = [
		"Space", // bare key
		"A",
		"F5",
		"Ctrl", // modifier only
		"Ctrl+",
		"+A",
		"Ctrl++A",
		"Hyper+A", // unknown modifier
		"Control+A",
		"Meta+A",
		"Ctrl+Ctrl+A", // duplicate
		"ctrl+CTRL+a",
		"Ctrl+F25",
		"Ctrl+F0",
		"Ctrl+F01",
		"Ctrl+AB", // two chars
		"Ctrl+A+B", // two keys
		"Ctrl+Plus",
		"Ctrl+Nope",
		"Ctrl + A", // whitespace
		" Ctrl+A",
		"Ctrl+A ",
		"Ctrl+\tA",
		"Ctrl+A\n",
		"Ctrl+A\u0000",
		"Ctrl+\u00e9", // unicode letter
		"Ctrl+\u0661", // arabic-indic digit
		"Ctrl+\uff21", // fullwidth A
		`Ctrl+${"A".repeat(40)}`, // over-long
		`${"Ctrl+".repeat(10)}A`,
		"",
		5,
		null,
		undefined,
		["Ctrl+A"],
		{},
	];
	for (const value of bad) rejects(() => config.validateHotkey(value), "hotkey");
	// Exactly 40 chars of otherwise valid grammar is impossible; the limit is checked up front.
	rejects(() => config.validateHotkey(`Ctrl+Alt+Shift+Super+${"x".repeat(19)}`), "hotkey");
});

test("hotkey in config.json: loaded canonical, undefined when unset, invalid rejected", () => {
	const root = island();
	assert.equal(load(root).hotkey, undefined);
	writeConfig(root, { hotkey: "ctrl+alt+space" });
	assert.equal(load(root).hotkey, "Ctrl+Alt+Space");
	for (const hotkey of ["Space", "Ctrl+F25", 5, null, "Ctrl+Alt+Space\n"]) {
		writeConfig(root, { hotkey });
		const cfg = load(root);
		assert.equal(cfg.hotkey, undefined);
		assert.equal(cfg.hotkeyInvalid, true);
		assert.ok(!JSON.stringify(cfg).includes("F25"));
	}
	writeConfig(root, { hotkey: "Ctrl+A" });
	assert.notEqual(load(root).hotkeyInvalid, true);
	writeConfig(root, { hotkey: "Space", thinking: "bogus" });
	rejects(() => load(root), "thinking");
	writeConfig(root, { hotkey: "Space", extra: 1 });
	rejects(() => load(root), "extra");
	writeConfig(root, { hotkeyy: "Ctrl+A" });
	rejects(() => load(root), "hotkeyy");
});

test("setHotkey: roundtrip, merge keeps the other keys, 0600, changed flag, null removes", () => {
	const root = island();
	const ws = tmp();
	writeConfig(root, { workspace: ws, thinking: "high" });
	let r = config.setHotkey(root, "ctrl+alt+space");
	assert.deepEqual(r, { hotkey: "Ctrl+Alt+Space", changed: true });
	const file = path.join(root, "config.json");
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { workspace: ws, thinking: "high", hotkey: "Ctrl+Alt+Space" });
	assert.equal(load(root).hotkey, "Ctrl+Alt+Space");
	r = config.setHotkey(root, "Ctrl+Alt+Space");
	assert.deepEqual(r, { hotkey: "Ctrl+Alt+Space", changed: false });
	r = config.setHotkey(root, null);
	assert.deepEqual(r, { hotkey: null, changed: true });
	assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { workspace: ws, thinking: "high" });
	assert.equal(load(root).hotkey, undefined);
	assert.deepEqual(config.setHotkey(root, null), { hotkey: null, changed: false });
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("setHotkey: invalid value changes nothing and no temp file lingers; works without a config file", () => {
	const root = island();
	rejects(() => config.setHotkey(root, "Space"), "hotkey");
	assert.equal(fs.existsSync(path.join(root, "config.json")), false);
	assert.equal(config.setHotkey(root, "Super+H").changed, true);
	const before = fs.readFileSync(path.join(root, "config.json"), "utf8");
	rejects(() => config.setHotkey(root, "Ctrl+Ctrl+A"), "hotkey");
	assert.equal(fs.readFileSync(path.join(root, "config.json"), "utf8"), before);
	assert.deepEqual(fs.readdirSync(root).filter((n) => n !== "tmp" && (n.includes("tmp") || n.endsWith(".tmp"))), []);
});

test("setHotkey does not reset the session pointer or touch state.json", () => {
	const root = island();
	fs.writeFileSync(path.join(root, "state.json"), '{"sessionFile":"x"}\n', { mode: 0o600 });
	config.setHotkey(root, "Ctrl+Alt+Space");
	assert.equal(fs.readFileSync(path.join(root, "state.json"), "utf8"), '{"sessionFile":"x"}\n');
});

test("invalid hotkey on disk: set-workspace drops it, setHotkey(null)/valid repairs, writes stay strict", () => {
	const root = island();
	const ws = tmp();
	writeConfig(root, { hotkey: "BADVALUE", thinking: "high" });
	config.setWorkspace(root, ws);
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8")), { thinking: "high", workspace: ws });
	writeConfig(root, { hotkey: "BADVALUE" });
	assert.deepEqual(config.setHotkey(root, null), { hotkey: null, changed: false }); // effective value was already null, file still repaired
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8")), {});
	assert.equal(load(root).hotkeyInvalid, undefined);
	writeConfig(root, { hotkey: "BADVALUE" });
	assert.deepEqual(config.setHotkey(root, "ctrl+k"), { hotkey: "Ctrl+K", changed: true });
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8")), { hotkey: "Ctrl+K" });
	rejects(() => config.setHotkey(root, "Space"), "hotkey");
});

// ----- connectorsCommand / connectorsDir (V4) ------------------------------------

test("connectors keys: defaults (no default command: nothing executes unless configured)", () => {
	const root = island();
	const cfg = load(root);
	assert.equal(cfg.connectorsCommand, undefined);
	assert.equal(cfg.connectorsDir, path.join(root, "connectors"));
});

test("connectors keys: valid values are accepted", () => {
	const root = island();
	const dir = path.join(tmp(), "conn");
	for (const command of ["/usr/local/bin/abito-connectors", "/opt/abito/bin/x", "/opt/a.b_c+d/x-1"]) {
		writeConfig(root, { connectorsCommand: command, connectorsDir: dir });
		const cfg = load(root);
		assert.equal(cfg.connectorsCommand, command);
		assert.equal(cfg.connectorsDir, dir);
	}
});

test("connectors keys: validation matrix, field-name-only errors, value never echoed", () => {
	const root = island();
	const cases = {
		connectorsCommand: ["abito-connectors", "my.tool_1", "a", "/usr//bin/x", "/usr/bin/", "/usr/lib/../bin/x", "/", "", "a b", "a;b", "a|b", "$(x)", "`x`", "a&b", "a>b", "x\ny", "a/b", "./x", "..", ".", "rel/path", "x".repeat(65), "/a/../b", "/a b/c", "/usr/bin/x;y", "/usr/bin/$HOME", 5, null, ["x"], {}, true],
		connectorsDir: ["", "rel", "./rel", "/a/../b", "a\0b", "/ok\0x", "x".repeat(5000), 5, null, ["/x"], {}],
	};
	for (const [field, values] of Object.entries(cases)) {
		for (const value of values) {
			writeConfig(root, { [field]: value });
			assert.throws(() => load(root), (error) => {
				assert.ok(error instanceof config.ConfigError);
				assert.equal(error.field, field);
				assert.equal(error.message, `invalid config: ${field}`);
				return true;
			}, `${field}=${JSON.stringify(value)}`);
		}
	}
});

test("connectors keys: validators are exported and the connectors dir is never created by config", () => {
	const root = island();
	assert.equal(config.validateConnectorsCommand("/usr/local/bin/abito-connectors"), "/usr/local/bin/abito-connectors");
	assert.throws(() => config.validateConnectorsCommand("abito-connectors"), config.ConfigError);
	assert.throws(() => config.validateConnectorsCommand("/usr//bin/x"), config.ConfigError);
	assert.equal(config.validateConnectorsDir("/tmp/x/y"), "/tmp/x/y");
	assert.throws(() => config.validateConnectorsDir("x"), config.ConfigError);
	load(root);
	assert.equal(fs.existsSync(path.join(root, "connectors")), false);
});

// ----- hookInstallerBin (H2b) ------------------------------------------------------

test("hookInstallerBin: unset by default; absolute normalized path accepted", () => {
	const root = island();
	assert.equal(load(root).hookInstallerBin, undefined);
	writeConfig(root, { hookInstallerBin: "/opt/abito/apps/desktop-harness/bin/abito-hook.cjs" });
	assert.equal(load(root).hookInstallerBin, "/opt/abito/apps/desktop-harness/bin/abito-hook.cjs");
	assert.equal(config.validateHookInstallerBin("/opt/x/abito-hook.cjs"), "/opt/x/abito-hook.cjs");
});

test("hookInstallerBin: validation matrix, field-name-only errors, value never echoed", () => {
	const root = island();
	for (const value of ["abito-hook.cjs", "./x", "/a/../b", "/a//b", "/a/", "/a b/c", "/x;y", "/x$HOME", "", "x\ny", "/".concat("a".repeat(5000)), 5, null, ["/x"], {}, true]) {
		writeConfig(root, { hookInstallerBin: value });
		assert.throws(() => load(root), (error) => {
			assert.ok(error instanceof config.ConfigError);
			assert.equal(error.field, "hookInstallerBin");
			assert.equal(error.message, "invalid config: hookInstallerBin");
			return true;
		}, JSON.stringify(value)?.slice(0, 40));
	}
});

// ----- global pause (#379) ------------------------------------------------------

test("setPaused: roundtrip, merge keeps the other keys, 0600, changed flag; loadConfig reads it", () => {
	const root = island();
	const ws = tmp();
	writeConfig(root, { workspace: ws, thinking: "high" });
	let r = config.setPaused(root, true);
	assert.deepEqual(r, { paused: true, changed: true });
	const file = path.join(root, "config.json");
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { workspace: ws, thinking: "high", paused: true });
	assert.equal(load(root).paused, true);
	r = config.setPaused(root, true);
	assert.deepEqual(r, { paused: true, changed: false });
	r = config.setPaused(root, false);
	assert.deepEqual(r, { paused: false, changed: true });
	assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { workspace: ws, thinking: "high" });
	assert.equal(load(root).paused, false, "key removed, effective false");
});

test("setPaused: non-boolean is a ConfigError changing nothing; a non-boolean on disk is refused; no session reset", () => {
	const root = island();
	for (const value of ["true", 1, null, {}, [true]]) {
		rejects(() => config.setPaused(root, value), "paused");
	}
	assert.equal(fs.existsSync(path.join(root, "config.json")), false);
	config.setPaused(root, true);
	const before = fs.readFileSync(path.join(root, "config.json"), "utf8");
	rejects(() => config.setPaused(root, "no"), "paused");
	assert.equal(fs.readFileSync(path.join(root, "config.json"), "utf8"), before);
	writeConfig(root, { paused: "yes" });
	rejects(() => load(root), "paused");
	// state.json is untouched, like every other no-restart setting
	fs.writeFileSync(path.join(root, "state.json"), '{"sessionFile":"x"}\n', { mode: 0o600 });
	writeConfig(root, { paused: true, thinking: "high" });
	config.setPaused(root, false);
	assert.equal(fs.readFileSync(path.join(root, "state.json"), "utf8"), '{"sessionFile":"x"}\n');
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8")), { thinking: "high" });
});

test("connectorHostBin is optional and validates the same absolute normalized path shape", () => {
	const root = island();
	assert.equal(load(root).connectorHostBin, undefined);
	for (const value of ["/usr/local/bin/abito-connector-host", "/opt/abito/bin/host-1"]) {
		writeConfig(root, { connectorHostBin: value });
		assert.equal(load(root).connectorHostBin, value);
		assert.equal(config.validateConnectorHostBin(value), value);
	}
	for (const value of ["host", "./host", "../host", "/a/../host", "/a//host", "/a/", "/a b/host", "/a;host", "", "x\0y", 7, null, [], {}]) {
		writeConfig(root, { connectorHostBin: value });
		assert.throws(() => load(root), (error) => error instanceof config.ConfigError && error.field === "connectorHostBin" && error.message === "invalid config: connectorHostBin");
	}
});
