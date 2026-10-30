"use strict";

// MCP config import preview (#381, GD016): read-only scan of other desktop clients'
// known config locations, mapped to a preview DTO. Semantics mirror the pure importer
// of apps/desktop-connectors (src/import.rs): transport classification, rejection
// reasons, `${input:}`/`${env:}`/`${userHome}` handling and whole-document duplicate-key
// rejection. The preview NEVER carries env values, header values, args or file contents.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { scanMcpConfigs, SCHEMA } = require("../src/mcp-import.cjs");

function tmp() {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "abito-mcpimport-")));
}
function write(home, rel, text) {
	const file = path.join(home, rel);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
	return file;
}

// --- known locations ------------------------------------------------------

test("schema constant is stable", () => {
	assert.equal(SCHEMA, "abito-mcp-import/preview/1");
});

test("linux locations: claude desktop, claude code, cursor, vscode", () => {
	const home = tmp();
	write(home, ".config/Claude/claude_desktop_config.json", JSON.stringify({ mcpServers: { a: { command: "x" } } }));
	write(home, ".claude.json", JSON.stringify({ mcpServers: { b: { command: "y" } } }));
	write(home, ".cursor/mcp.json", JSON.stringify({ mcpServers: { c: { command: "z" } } }));
	write(home, ".config/Code/User/mcp.json", JSON.stringify({ servers: { d: { command: "w" } } }));

	const result = scanMcpConfigs({ home, platform: "linux" });
	assert.deepEqual(
		result.files.map((f) => [f.source, f.status]).sort(),
		[["claude-code", "ok"], ["claude-desktop", "ok"], ["cursor", "ok"], ["vscode", "ok"]],
	);
	assert.deepEqual(
		result.servers.map((s) => [s.source, s.name, s.status]).sort(),
		[["claude-code", "b", "ready"], ["claude-desktop", "a", "ready"], ["cursor", "c", "ready"], ["vscode", "d", "ready"]],
	);
	assert.equal(result.truncated, false);
});

test("darwin locations", () => {
	const home = tmp();
	write(home, "Library/Application Support/Claude/claude_desktop_config.json", JSON.stringify({ mcpServers: { a: { command: "x" } } }));
	write(home, "Library/Application Support/Code/User/mcp.json", JSON.stringify({ servers: { d: { command: "w" } } }));

	const result = scanMcpConfigs({ home, platform: "darwin" });
	assert.deepEqual(result.files.map((f) => f.source).sort(), ["claude-desktop", "vscode"]);
	assert.deepEqual(result.servers.map((s) => s.name).sort(), ["a", "d"]);
});

test("unsupported platform scans nothing; missing files are simply absent", () => {
	const home = tmp();
	assert.deepEqual(scanMcpConfigs({ home, platform: "win32" }), { files: [], servers: [], truncated: false });
	assert.deepEqual(scanMcpConfigs({ home, platform: "linux" }), { files: [], servers: [], truncated: false });
});

// --- mapping: ready / rejected --------------------------------------------

const vscodeDesktopConfig = JSON.stringify({
	mcpServers: {
		filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"], env: { HOME_DIR: "/home/u" } },
		notes: { command: "notes", env: { API_KEY: "sk-live-secret" } },
		remote: { type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer bearer-secret" } },
		old: { type: "sse", url: "https://mcp.example.com/sse" },
		weird: { type: "websocket", url: "wss://x" },
		both: { command: "x", url: "https://y" },
		nocmd: { type: "stdio" },
		badargs: { command: "x", args: ["ok", 3] },
		badenv: { command: "x", env: "yes" },
		badurl: { type: "http", url: "ftp://x/y" },
		empty: {},
	},
});

test("claude desktop mapping: ready, rejected reasons, bounded DTO", () => {
	const home = tmp();
	write(home, ".config/Claude/claude_desktop_config.json", vscodeDesktopConfig);
	const result = scanMcpConfigs({ home, platform: "linux" });
	const byName = Object.fromEntries(result.servers.map((s) => [s.name, s]));

	assert.deepEqual(byName.filesystem, {
		source: "claude-desktop", name: "filesystem", transport: "stdio",
		command: "npx", status: "ready",
	});
	assert.deepEqual(byName.notes, { source: "claude-desktop", name: "notes", transport: "stdio", command: "notes", status: "ready" });
	assert.deepEqual(byName.remote, {
		source: "claude-desktop", name: "remote", transport: "http",
		url: "https://mcp.example.com/mcp", status: "ready",
	});
	assert.equal(byName.old.status, "rejected");
	assert.equal(byName.old.reason, "sse_transport");
	assert.equal(byName.weird.status, "rejected");
	assert.equal(byName.weird.reason, "unsupported_transport");
	assert.equal(byName.both.status, "rejected");
	assert.equal(byName.both.reason, "conflicting_transports");
	assert.equal(byName.nocmd.status, "rejected");
	assert.equal(byName.nocmd.reason, "invalid_entry");
	assert.equal(byName.badargs.status, "rejected");
	assert.equal(byName.badargs.reason, "invalid_entry");
	assert.equal(byName.badenv.status, "rejected");
	assert.equal(byName.badenv.reason, "invalid_entry");
	assert.equal(byName.badurl.status, "rejected");
	assert.equal(byName.badurl.reason, "invalid_entry");
	assert.equal(byName.empty.status, "rejected");
	assert.equal(byName.empty.reason, "invalid_entry");

	// Every server carries only the allowlisted keys; rejected entries carry no transport detail.
	for (const s of result.servers) {
		assert.ok(Object.keys(s).every((k) => ["source", "name", "scope", "transport", "command", "url", "status", "fields", "reason"].includes(k)), JSON.stringify(s));
	}
	// Non-stdio/http entries have no transport.
	assert.equal(byName.old.transport, undefined);
	assert.equal(byName.weird.transport, undefined);
});

test("claude desktop: no env values, header values or args ever appear in the output", () => {
	const home = tmp();
	write(home, ".config/Claude/claude_desktop_config.json", vscodeDesktopConfig);
	const result = scanMcpConfigs({ home, platform: "linux" });
	const text = JSON.stringify(result);
	assert.ok(!text.includes("sk-live-secret"), "env value leaked");
	assert.ok(!text.includes("Bearer bearer-secret"), "header value leaked");
	assert.ok(!text.includes("server-filesystem"), "arg value leaked");
	assert.ok(!text.includes("API_KEY") && !text.includes("Authorization"), "env/header key leaked");
});

test("claude code: root servers plus project scopes; env references become setup fields", () => {
	const home = tmp();
	write(home, ".claude.json", JSON.stringify({
		mcpServers: { local: { command: "srv", env: { TOKEN: "${MY_TOKEN}", DEFAULTED: "${OTHER:-x}" } } },
		projects: {
			"/home/u/work": { mcpServers: { local: { command: "srv2" } } },
			"/home/u/other": { mcpServers: { deep: { url: "https://m.example/srv" } } },
			empty: {},
		},
	}));
	const result = scanMcpConfigs({ home, platform: "linux" });
	const scoped = result.servers.filter((s) => s.source === "claude-code");
	assert.deepEqual(scoped.map((s) => [s.name, s.scope, s.status]).sort(),
		// note: Array#sort stringifies; "local,,needs_setup" sorts before "local,/home/u/work,ready"
		[["deep", "/home/u/other", "ready"], ["local", undefined, "needs_setup"], ["local", "/home/u/work", "ready"]]);

	const needsSetup = scoped.find((s) => s.status === "needs_setup");
	// Field keys name the referenced VARIABLE (env:OTHER), not the config map key (DEFAULTED).
	assert.deepEqual(needsSetup.fields, [
		{ key: "env:MY_TOKEN", label: "Environment variable MY_TOKEN", secret: true, optional: false },
		{ key: "env:OTHER", label: "Environment variable OTHER", secret: true, optional: false },
	]);
	// The referenced values never appear.
	assert.ok(!JSON.stringify(result).includes("MY_TOKEN_VALUE"));
});

test("claude code: literal (non-reference) env values stay invisible but keep the entry ready", () => {
	const home = tmp();
	write(home, ".claude.json", JSON.stringify({ mcpServers: { s: { command: "c", env: { PLAIN: "plain-value-secret" } } } }));
	const result = scanMcpConfigs({ home, platform: "linux" });
	assert.deepEqual(result.servers, [{ source: "claude-code", name: "s", transport: "stdio", command: "c", status: "ready" }]);
	assert.ok(!JSON.stringify(result).includes("plain-value-secret"));
});

// --- vscode/cursor syntax: inputs, env refs, userHome ----------------------

const vscodeMcpConfig = JSON.stringify({
	inputs: [
		{ id: "apiToken", description: "API token", password: true },
		{ id: "region", description: "Region", password: false },
	],
	servers: {
		needsInputs: { type: "http", url: "https://${input:region}.example.com/${input:apiToken}" },
		homey: { command: "${userHome}/bin/srv" },
		envHeader: { type: "http", url: "https://x.example", headers: { "X-Key": "${env:MY_KEY}" } },
		// unknown ${...} refs in written values stay verbatim (reference semantics)
		badRef: { command: "x-${mystery}-y" },
	},
});

test("vscode: ${input:} needs_setup fields, ${userHome} expansion, ${env:} field, unknown ref", () => {
	const home = tmp();
	write(home, ".config/Code/User/mcp.json", vscodeMcpConfig);
	const result = scanMcpConfigs({ home, platform: "linux" });
	const byName = Object.fromEntries(result.servers.map((s) => [s.name, s]));

	assert.equal(byName.needsInputs.status, "needs_setup");
	assert.equal(byName.needsInputs.transport, "http");
	// The url is kept verbatim; input descriptions do not apply to urls (reference
	// semantics): unresolved keys fall back to the default secret field.
	assert.equal(byName.needsInputs.url, "https://${input:region}.example.com/${input:apiToken}");
	assert.deepEqual(byName.needsInputs.fields, [
		{ key: "apiToken", label: "apiToken", secret: true, optional: false },
		{ key: "region", label: "region", secret: true, optional: false },
	]);

	assert.equal(byName.homey.status, "ready");
	assert.equal(byName.homey.command, `${home}/bin/srv`);

	assert.equal(byName.envHeader.status, "needs_setup");
	assert.deepEqual(byName.envHeader.fields, [{ key: "env:MY_KEY", label: "Environment variable MY_KEY", secret: true, optional: false }]);

	assert.equal(byName.badRef.status, "ready");
	assert.equal(byName.badRef.command, "x-${mystery}-y");
	assert.equal(byName.badRef.fields, undefined);
});

test("vscode: mcp.servers / mcp.inputs nesting also works", () => {
	const home = tmp();
	write(home, ".config/Code/User/mcp.json", JSON.stringify({ mcp: { inputs: [{ id: "pw" }], servers: { s: { url: "https://${input:pw}" } } } }));
	const result = scanMcpConfigs({ home, platform: "linux" });
	assert.deepEqual(result.servers, [{
		source: "vscode", name: "s", transport: "http", url: "https://${input:pw}", status: "needs_setup",
		fields: [{ key: "pw", label: "pw", secret: true, optional: false }],
	}]);
});

test("cursor uses the vscode syntax on its own location", () => {
	const home = tmp();
	write(home, ".cursor/mcp.json", JSON.stringify({ mcpServers: { s: { command: "${userHome}/c" } } }));
	const result = scanMcpConfigs({ home, platform: "linux" });
	assert.deepEqual(result.servers, [{ source: "cursor", name: "s", transport: "stdio", command: `${home}/c`, status: "ready" }]);
});

test("http url ending in /sse without explicit type is rejected as sse_transport", () => {
	const home = tmp();
	write(home, ".cursor/mcp.json", JSON.stringify({ mcpServers: { s: { url: "https://x.example/SSE/" } } }));
	const result = scanMcpConfigs({ home, platform: "linux" });
	assert.equal(result.servers[0].status, "rejected");
	assert.equal(result.servers[0].reason, "sse_transport");
});

// --- per-file problems are reported, not fatal -----------------------------

test("malformed json, non-object root, duplicate keys, unreadable", () => {
	const home = tmp();
	write(home, ".config/Claude/claude_desktop_config.json", "{not json");
	write(home, ".claude.json", JSON.stringify([1, 2]));
	// A duplicate object key anywhere rejects the whole document (reference semantics).
	write(home, ".cursor/mcp.json", '{"mcpServers":{"a":{"command":"x"}},"mcpServers":{"b":{"command":"y"}}}');
	write(home, ".config/Code/User/mcp.json", "{}");
	fs.chmodSync(path.join(home, ".config/Code/User/mcp.json"), 0o000);
	const result = scanMcpConfigs({ home, platform: "linux" });
	fs.chmodSync(path.join(home, ".config/Code/User/mcp.json"), 0o600);
	assert.deepEqual(
		result.files.map((f) => [f.source, f.status]).sort(),
		[["claude-code", "malformed"], ["claude-desktop", "malformed"], ["cursor", "malformed"], ["vscode", "unreadable"]],
	);
	assert.deepEqual(result.servers, []);
});

test("file larger than maxFileBytes is reported too_large, never read", () => {
	const home = tmp();
	write(home, ".cursor/mcp.json", JSON.stringify({ mcpServers: { a: { command: "x" } } }));
	const result = scanMcpConfigs({ home, platform: "linux", maxFileBytes: 5 });
	assert.deepEqual(result.files, [{ source: "cursor", status: "too_large" }]);
	assert.deepEqual(result.servers, []);
});

test("more than 200 entries in one file is reported too_many with no servers", () => {
	const home = tmp();
	const servers = {};
	for (let i = 0; i < 201; i++) servers[`s${i}`] = { command: "x" };
	write(home, ".cursor/mcp.json", JSON.stringify({ mcpServers: servers }));
	const result = scanMcpConfigs({ home, platform: "linux" });
	assert.deepEqual(result.files, [{ source: "cursor", status: "too_many" }]);
	assert.deepEqual(result.servers, []);
});

// --- bounds and hygiene -----------------------------------------------------

test("server names over 128 chars or with control characters are rejected as invalid_entry", () => {
	const home = tmp();
	write(home, ".cursor/mcp.json", JSON.stringify({
		mcpServers: {
			[("x").repeat(129)]: { command: "a" },
			["bad\tname"]: { command: "b" },
			good: { command: "c" },
		},
	}));
	const result = scanMcpConfigs({ home, platform: "linux" });
	// Rejected entries are reported, not silently dropped: bad name, good, over-long name.
	assert.deepEqual(result.servers, [
		{ source: "cursor", name: "bad\tname", status: "rejected", reason: "invalid_entry" },
		{ source: "cursor", name: "good", transport: "stdio", command: "c", status: "ready" },
		{ source: "cursor", name: ("x").repeat(129), status: "rejected", reason: "invalid_entry" },
	]);
});

test("command or url with control characters is rejected as invalid_entry", () => {
	const home = tmp();
	write(home, ".cursor/mcp.json", JSON.stringify({ mcpServers: { s: { command: "a\nb" } } }));
	const result = scanMcpConfigs({ home, platform: "linux" });
	assert.equal(result.servers[0].status, "rejected");
	assert.equal(result.servers[0].reason, "invalid_entry");
});

test("output is deterministic (sorted by source, name, scope) regardless of document order", () => {
	const one = JSON.stringify({ mcpServers: { zeta: { command: "1" }, alpha: { command: "2" }, mid: { command: "3" } } });
	const two = JSON.stringify({ mcpServers: { mid: { command: "3" }, zeta: { command: "1" }, alpha: { command: "2" } } });
	const homeA = tmp();
	const homeB = tmp();
	write(homeA, ".cursor/mcp.json", one);
	write(homeB, ".cursor/mcp.json", two);
	assert.deepEqual(scanMcpConfigs({ home: homeA, platform: "linux" }), scanMcpConfigs({ home: homeB, platform: "linux" }));
	assert.deepEqual(scanMcpConfigs({ home: homeA, platform: "linux" }).servers.map((s) => s.name), ["alpha", "mid", "zeta"]);
});

test("server count beyond maxServers sets truncated and keeps the first bounded slice", () => {
	const home = tmp();
	const servers = {};
	for (let i = 0; i < 9; i++) servers[`s${i}`] = { command: "x" };
	write(home, ".cursor/mcp.json", JSON.stringify({ mcpServers: servers }));
	const result = scanMcpConfigs({ home, platform: "linux", maxServers: 4 });
	assert.equal(result.servers.length, 4);
	assert.equal(result.truncated, true);
});

test("home must be an absolute clean path; scan never mutates anything", () => {
	const home = tmp();
	assert.throws(() => scanMcpConfigs({ home: "relative", platform: "linux" }), /home/);
	assert.throws(() => scanMcpConfigs({ home: `${home}/a/../b`, platform: "linux" }), /home/);
	const file = write(home, ".cursor/mcp.json", "{\"mcpServers\":{\"s\":{\"command\":\"c\"}}}");
	const before = fs.readFileSync(file, "utf8");
	scanMcpConfigs({ home, platform: "linux" });
	// nothing written anywhere: the only entry is the config the test itself created
	assert.equal(fs.readdirSync(home).sort().join(","), ".cursor");
	assert.equal(fs.readFileSync(file, "utf8"), before);
});

// --- security review R21 / R22 ---------------------------------------------------

test("R21: the preview never shows url userinfo, query or fragment", () => {
	const home = tmp();
	write(home, ".cursor/mcp.json", JSON.stringify({ mcpServers: {
		a: { url: "https://user:pa55w0rd@mcp.example.com/v1/mcp?api_key=SECRETKEY123&x=1#frag" },
		b: { url: "https://token@mcp.example.com:8443/path" },
	} }));
	const result = scanMcpConfigs({ home, platform: "linux" });
	const byName = Object.fromEntries(result.servers.map((s) => [s.name, s]));
	assert.equal(byName.a.url, "https://mcp.example.com/v1/mcp");
	assert.equal(byName.b.url, "https://mcp.example.com:8443/path");
	assert.equal(byName.a.status, "ready");
	assert.ok(!JSON.stringify(result).match(/pa55w0rd|SECRETKEY123|api_key/));
});

test("R21: the preview masks inline secrets in a stdio command but keeps a plain command intact", () => {
	const home = tmp();
	write(home, ".cursor/mcp.json", JSON.stringify({ mcpServers: {
		a: { command: "npx server --token=abc123 --api-key abcdefghijklmnopqrstuvwxyz0123456789" },
		b: { command: "/usr/local/bin/my-server" },
		c: { command: "npx -y @scope/server-name" },
	} }));
	const result = scanMcpConfigs({ home, platform: "linux" });
	const byName = Object.fromEntries(result.servers.map((s) => [s.name, s]));
	assert.ok(!JSON.stringify(byName.a).match(/abc123|abcdefghijklmnop/));
	assert.match(byName.a.command, /^npx server --token=\*\*\* --api-key \*\*\*$/);
	assert.equal(byName.b.command, "/usr/local/bin/my-server");
	assert.equal(byName.c.command, "npx -y @scope/server-name");
});

test("R22: a symlinked foreign config is never followed", () => {
	const home = tmp();
	const outside = tmp();
	const target = path.join(outside, "secret.json");
	fs.writeFileSync(target, JSON.stringify({ mcpServers: { leaked: { command: "x" } } }));
	fs.mkdirSync(path.join(home, ".cursor"));
	fs.symlinkSync(target, path.join(home, ".cursor/mcp.json"));
	const result = scanMcpConfigs({ home, platform: "linux" });
	assert.deepEqual(result.files, [{ source: "cursor", status: "unreadable" }]);
	assert.deepEqual(result.servers, []);
});
