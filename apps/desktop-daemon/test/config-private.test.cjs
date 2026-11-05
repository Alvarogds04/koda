"use strict";

// K2-01b D1: config.json and the mcpConfigPath source are "private JSON" files. NTFS has no POSIX mode bits (lstat reports
// 0o666), so on Windows privacy is a fact of the verified HU-047 helper (`--check-path`), never a mode comparison.
// These tests drive that branch on every OS through a SCRIPTED backend (winfs.useForTests): it answers exactly the facts
// each case needs, so the same assertions run on Linux, macOS and Windows. The real helper is exercised on Windows by
// the last test (round trip through the product writer).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../src/config.cjs");
const winfs = require("../src/win-fs.cjs");

function tmp() {
	return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "abito-cfgpriv-")));
}
/**
 * A JSON file whose POSIX mode CONTRADICTS the helper's verdict in each test, so only the helper can decide:
 * 0o644 (a POSIX check would refuse) where the helper accepts, 0o600 (a POSIX check would accept) where it refuses.
 */
function plainFile(value, mode = 0o644) {
	const file = path.join(tmp(), "data.json");
	fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
	if (process.platform !== "win32") fs.chmodSync(file, mode);
	return file;
}
const facts = (p, extra = {}) => ({ schema: "abito-fs/1", ok: true, path: p, parent_ok: true, exists: true, kind: "file", reparse: false, private: true, nlink: 1, size: fs.existsSync(p) ? fs.statSync(p).size : 0, mtime_ms: 1, elevated: false, ...extra });
/** Scripted backend: checkPath answers `answer(p)`; every call is recorded. */
function scripted(answer) {
	const calls = [];
	const backend = { checkPath: (p) => (calls.push(p), answer(p)) };
	return { backend, calls };
}
function withBackend(backend, fn) {
	winfs.useForTests(backend);
	try {
		return fn();
	} finally {
		winfs.useForTests(null);
	}
}
function rejects(fn, field) {
	assert.throws(fn, (error) => {
		assert.ok(error instanceof config.ConfigError, `ConfigError expected, got ${error && error.message}`);
		assert.equal(error.field, field);
		assert.equal(error.message, `invalid config: ${field}`);
		return true;
	});
}
const MCP = { mcpServers: { notes: { type: "http", url: "http://127.0.0.1:4821/notes", headers: { Authorization: "Bearer cap_abcdef123456" } } } };

test("K2-01b D1: with the verified helper, a private file is read whatever its POSIX mode bits say (the Windows branch)", () => {
	const file = plainFile(MCP);
	const { backend, calls } = scripted((p) => facts(p));
	const out = withBackend(backend, () => config.projectMcpConfig(file));
	assert.deepEqual(Object.keys(out.mcpServers), ["notes"]);
	assert.deepEqual(calls, [file], "the helper is asked about exactly this file");
});

test("K2-01b D1: config.json through loadConfig uses the same helper verdict", () => {
	const root = tmp();
	fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ command: "pi" }));
	if (process.platform !== "win32") fs.chmodSync(path.join(root, "config.json"), 0o644);
	const { backend } = scripted((p) => facts(p));
	const cfg = withBackend(backend, () => config.loadConfig(root, { env: {} }));
	assert.equal(cfg.command, "pi");
	fs.chmodSync(path.join(root, "config.json"), 0o600);
	const refused = scripted((p) => facts(p, { private: false }));
	rejects(() => withBackend(refused.backend, () => config.loadConfig(root, { env: {} })), "config.json");
});

test("K2-01b D1: the helper's refusals hold — not private, reparse, hard link, unsafe parent, not a file, too large", () => {
	const file = plainFile(MCP, 0o600);
	for (const extra of [{ private: false }, { reparse: true, private: false }, { reparse: true }, { nlink: 2 }, { parent_ok: false }, { kind: "dir" }, { kind: "other" }, { size: 2 * 1024 * 1024 }]) {
		const { backend } = scripted((p) => facts(p, extra));
		rejects(() => withBackend(backend, () => config.projectMcpConfig(file)), "mcpConfigPath");
	}
});

test("K2-01b D1: helper failure or an untrusted helper fails closed with the same ConfigError — never a mode fallback", () => {
	const file = plainFile(MCP, 0o600);
	const throwing = { checkPath: () => { throw new winfs.WinFsError("helper_failed"); } };
	rejects(() => withBackend(throwing, () => config.projectMcpConfig(file)), "mcpConfigPath");
	const malformed = scripted(() => ({ ok: true })); // not the closed fact shape
	rejects(() => withBackend(malformed.backend, () => config.projectMcpConfig(file)), "mcpConfigPath");
	const otherPath = scripted((p) => facts(`${p}.other`)); // facts about a different path
	rejects(() => withBackend(otherPath.backend, () => config.projectMcpConfig(file)), "mcpConfigPath");
});

test("K2-01b D1: an absent file is still `null` (defaults apply), as on POSIX; a vanished file after the check is refused", () => {
	const root = tmp();
	const absent = scripted((p) => facts(p, { exists: false, kind: "none", private: false, nlink: 0, size: 0 }));
	const cfg = withBackend(absent.backend, () => config.loadConfig(root, { env: {} }));
	assert.equal(cfg.command, "pi", "defaults when config.json is absent");
	const gone = path.join(root, "gone.json");
	const lying = scripted((p) => facts(p, { size: 10 }));
	rejects(() => withBackend(lying.backend, () => config.projectMcpConfig(gone)), "mcpConfigPath");
});

test("K2-01b D1: the bytes read are bounded even if the file grew after the helper's check", () => {
	const file = plainFile(MCP);
	fs.writeFileSync(file, `${JSON.stringify(MCP)}${" ".repeat(2 * 1024 * 1024)}`);
	const { backend } = scripted((p) => facts(p, { size: 10 }));
	rejects(() => withBackend(backend, () => config.projectMcpConfig(file)), "mcpConfigPath");
});

test("K2-01b D1 (Windows, real helper): config.json written by the product is read back", { skip: process.platform !== "win32" && "real HU-047 helper (Windows CI layout); the scripted tests above cover this branch on every OS" }, () => {
	const local = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "abito-cfgpriv-local-")));
	const root = path.join(local, "Abito", "i");
	const { ensureIsland } = require("../src/isolation.cjs");
	ensureIsland(root);
	const ws = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "abito-cfgpriv-ws-")));
	config.setWorkspace(root, ws, { env: {} });
	assert.equal(config.loadConfig(root, { env: {} }).workspace, ws);
});

test("K2-01b D1: an untrusted helper (winfs.active() throws) is ConfigError(field) through loadConfig and projectMcpConfig", () => {
	const root = tmp();
	fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ command: "pi" }), { mode: 0o600 });
	const file = plainFile(MCP, 0o600); // a POSIX check would accept both: only the helper path decides
	let calls = 0;
	const untrusted = () => {
		calls++;
		throw new winfs.WinFsError("helper_untrusted");
	};
	rejects(() => withBackend(untrusted, () => config.loadConfig(root, { env: {} })), "config.json");
	rejects(() => withBackend(untrusted, () => config.projectMcpConfig(file)), "mcpConfigPath");
	assert.equal(calls, 2, "the helper trust was consulted on each read, never skipped");
	// Control: the same seam returning a trusted backend reads normally.
	const trusted = scripted((p) => facts(p));
	assert.equal(withBackend(() => trusted.backend, () => config.loadConfig(root, { env: {} })).command, "pi");
});
