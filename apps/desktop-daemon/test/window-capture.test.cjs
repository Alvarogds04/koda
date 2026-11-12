"use strict";

// K2-06 (daemon half): «preguntarle a Koda por mi ventana».
//
//   T1 · the Rust host's loopback MCP endpoint (KODA_WINDOW_MCP_URL / KODA_WINDOW_MCP_TOKEN, set at
//        spawn) becomes the `computer` server of the engine's own <island>/agent/mcp.json, through the
//        existing proxy-only projection; the token lives only in that 0600 file and never in the log.
//   T3 · the Pi extension installed next to the engine's other extensions, a copy of Gentle Dot's
//        screenshot-context.ts (MIT): only the LAST screenshot travels as an image.
//   T2 · that same extension refuses a capture before it happens when the active model has no image
//        input, answering with the sentence that tells the user what to fix.
//
// The extension is exercised as the exact template Pi loads (unit), never a rewrite of it.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");

const config = require("../src/config.cjs");
const windowCapture = require("../src/window-capture.cjs");
const { ensureIsland } = require("../src/isolation.cjs");
const { ProfileStore } = require("../src/profiles.cjs");
const { EXTENSION_FILE: CUSTOM_EXTENSION_FILE } = require("../src/custom-provider-extension.cjs");
const { assertMode } = require("./platform-env.cjs");

const URL_ENV = "KODA_WINDOW_MCP_URL";
const TOKEN_ENV = "KODA_WINDOW_MCP_TOKEN";
const ENDPOINT = "http://127.0.0.1:48217/mcp";
const TOKEN = "cap_0123456789abcdef";
const windowEnv = () => ({ [URL_ENV]: ENDPOINT, [TOKEN_ENV]: TOKEN });
const COMPUTER = { type: "http", url: ENDPOINT, headers: { Authorization: `Bearer ${TOKEN}` } };
const NOTES = { type: "http", url: "http://127.0.0.1:4821/notes", headers: { Authorization: "Bearer cap_abcdef123456" } };

const tempDirs = new Set();
test.after(() => {
	for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});
function tmp() {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "koda-window-")));
	tempDirs.add(dir);
	return dir;
}
function island() {
	const root = path.join(tmp(), "island");
	ensureIsland(root);
	return root;
}
function mcpSource(servers) {
	const file = path.join(tmp(), "mcp-source.json");
	fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
	fs.chmodSync(file, 0o600);
	return file;
}
const projectionAt = (root) => JSON.parse(fs.readFileSync(path.join(root, "agent", "mcp.json"), "utf8"));

// ----- T1: projection --------------------------------------------------------

test("T1: the host endpoint is projected as the `computer` server, 0600, next to the configured servers", () => {
	const root = island();
	const source = mcpSource({ notes: NOTES });
	config.writeMcpProjection(root, source, { env: windowEnv() });
	const file = path.join(root, "agent", "mcp.json");
	assertMode(file, 0o600);
	assert.deepEqual(projectionAt(root), { mcpServers: { notes: NOTES, computer: COMPUTER } });
	// No mcpConfigPath at all: the endpoint is still projected (it is Koda's own server, not an import).
	config.writeMcpProjection(root, undefined, { env: windowEnv() });
	assert.deepEqual(projectionAt(root), { mcpServers: { computer: COMPUTER } });
});

test("T1: with no endpoint in the environment the projection is exactly what it was (no `computer` server)", () => {
	const root = island();
	const source = mcpSource({ notes: NOTES });
	config.writeMcpProjection(root, source, { env: {} });
	assert.deepEqual(projectionAt(root), { mcpServers: { notes: NOTES } });
	// A previous run's endpoint never lingers.
	config.writeMcpProjection(root, source, { env: windowEnv() });
	assert.deepEqual(Object.keys(projectionAt(root).mcpServers), ["notes", "computer"]);
	config.writeMcpProjection(root, source, { env: { HOME: "/home/x" } });
	assert.deepEqual(projectionAt(root), { mcpServers: { notes: NOTES } });
	config.writeMcpProjection(root, undefined, { env: {} });
	assert.deepEqual(projectionAt(root), { mcpServers: {} });
});

test("T1: an unsafe or half-set endpoint projects no `computer` server, never throws, and never echoes the token", () => {
	const root = island();
	const refused = {
		remote: { [URL_ENV]: "http://10.0.0.5:48217/mcp", [TOKEN_ENV]: TOKEN },
		https: { [URL_ENV]: "https://127.0.0.1:48217/mcp", [TOKEN_ENV]: TOKEN },
		lookalike: { [URL_ENV]: "http://127.0.0.1.evil.com/mcp", [TOKEN_ENV]: TOKEN },
		credsInUrl: { [URL_ENV]: "http://u:p@127.0.0.1:48217/mcp", [TOKEN_ENV]: TOKEN },
		shortToken: { [URL_ENV]: ENDPOINT, [TOKEN_ENV]: "abc" },
		emptyToken: { [URL_ENV]: ENDPOINT, [TOKEN_ENV]: "" },
		injectedToken: { [URL_ENV]: ENDPOINT, [TOKEN_ENV]: "cap_0123456789\nX-Evil: 1" },
		missingToken: { [URL_ENV]: ENDPOINT },
		missingUrl: { [TOKEN_ENV]: TOKEN },
	};
	for (const [name, env] of Object.entries(refused)) {
		const logs = [];
		config.writeMcpProjection(root, undefined, { env, log: (line) => logs.push(String(line)) });
		assert.deepEqual(projectionAt(root), { mcpServers: {} }, name);
		assert.ok(logs.length > 0, `${name}: a refusal is reported`);
		for (const line of logs) {
			assert.ok(!line.includes(TOKEN), `${name}: the log never carries the token`);
			assert.match(line, /^window capture: /, name);
		}
	}
	// A successful projection says nothing at all.
	const logs = [];
	config.writeMcpProjection(root, undefined, { env: windowEnv(), log: (line) => logs.push(String(line)) });
	assert.deepEqual(logs, []);
});

// ----- T3: the installed extension ------------------------------------------

test("T3: the extension is installed 0600 under the agent's extensions dir and its file is not the custom provider's", () => {
	const root = island();
	assert.equal(windowCapture.install(root, windowEnv()), true);
	const file = path.join(root, "agent", "extensions", windowCapture.EXTENSION_FILE);
	assertMode(file, 0o600);
	assert.equal(fs.readFileSync(file, "utf8"), windowCapture.TEMPLATE);
	assert.notEqual(windowCapture.EXTENSION_FILE, CUSTOM_EXTENSION_FILE, "two independent extensions, two lifetimes");
	// Gentle Dot's MIT notice travels with the copied code.
	assert.match(windowCapture.TEMPLATE, /Gentle Dot/);
	assert.match(windowCapture.TEMPLATE, /MIT/);
	assert.match(windowCapture.TEMPLATE, /Copyright \(c\) 2026 Gentleman Programming/);
	// Without the endpoint there is nothing to install: a copy from an earlier run is gone.
	assert.equal(windowCapture.install(root, {}), false);
	assert.equal(fs.existsSync(file), false);
	assert.equal(windowCapture.install(root, { [URL_ENV]: "http://10.0.0.5/mcp", [TOKEN_ENV]: TOKEN }), false);
	assert.equal(fs.existsSync(file), false);
});

test("T3: the custom-provider sweeps never remove the window-capture extension", async () => {
	const root = island();
	const agentDir = path.join(root, "agent");
	windowCapture.install(root, windowEnv());
	const file = path.join(agentDir, "extensions", windowCapture.EXTENSION_FILE);
	assert.equal(fs.existsSync(file), true);
	const store = new ProfileStore({
		islandRoot: root,
		agentDir,
		accounts: () => new Map(),
		engine: { status: "stopped", busy: false },
		restart: async () => {},
	});
	// Neither the orphan sweep nor a full deactivation may claim it: it is not a custom-provider artifact.
	assert.deepEqual(store.findCustomOrphans(), []);
	assert.deepEqual(store.removeCustomOrphans(), []);
	assert.equal(fs.existsSync(file), true);
	const result = await store.deactivate();
	assert.equal(result.ok, true);
	assert.equal(fs.existsSync(file), true);
});

// ----- the template Pi loads -------------------------------------------------

async function loadTemplate(root) {
	const file = path.join(root, "template.mjs");
	fs.writeFileSync(file, windowCapture.TEMPLATE);
	return import(`${pathToFileURL(file).href}?${Math.random()}`);
}

/** A Pi stand-in: records the handlers the extension registers. */
function fakePi() {
	const handlers = new Map();
	return {
		handlers,
		on(event, handler) {
			handlers.set(event, handler);
		},
	};
}

const screenshot = (id, app) => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "mcp__computer__screenshot_my_window",
	content: [
		{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
		{ type: "text", text: JSON.stringify({ frontApp: app }) },
	],
	isError: false,
	timestamp: 1,
});
const hasImage = (message) => message.content.some((block) => block.type === "image");

test("T3: only the last screenshot travels as an image; each earlier one becomes a one-line note", async () => {
	const root = tmp();
	const ext = await loadTemplate(root);
	const first = screenshot("call_1", "Mail");
	const second = screenshot("call_2", "Mail");
	const last = screenshot("call_3", "Firefox");
	const planner = { role: "assistant", content: [{ type: "text", text: "looking" }] };
	const messages = [planner, first, planner, second, planner, last];
	const pruned = ext.pruneScreenshots(messages);
	assert.equal(pruned.length, messages.length, "nothing is dropped: the same turn structure stays");
	assert.equal(hasImage(pruned[1]), false);
	assert.equal(hasImage(pruned[3]), false);
	assert.equal(hasImage(pruned[5]), true, "the last screenshot still reaches the model");
	assert.deepEqual(pruned[1].content, [{ type: "text", text: "[earlier screenshot omitted: screenshot_my_window in Mail]" }]);
	assert.deepEqual(pruned[3].content, [{ type: "text", text: "[earlier screenshot omitted: screenshot_my_window in Mail]" }]);
	assert.deepEqual(pruned[5].content, last.content, "the last one keeps its image and its metadata");
	assert.deepEqual(pruned[0], planner);
	// The input is not mutated: the saved session keeps every image.
	assert.equal(hasImage(first), true);
	// Nothing to prune ⇒ the very same array, so Pi keeps its cached prefix.
	const alone = [planner, last];
	assert.equal(ext.pruneScreenshots(alone), alone);
	const noMetadata = [{ ...screenshot("call_4", "Notes"), content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }] }, screenshot("call_5", "Notes")];
	const prunedNoMetadata = ext.pruneScreenshots(noMetadata);
	assert.deepEqual(prunedNoMetadata[0].content, [{ type: "text", text: "[earlier screenshot omitted: screenshot_my_window]" }]);
	// Non-screenshot tool results are left alone.
	const other = { role: "toolResult", toolCallId: "call_6", toolName: "bash", content: [{ type: "image", data: "aGk=", mimeType: "image/png" }], isError: false };
	const mixed = ext.pruneScreenshots([other, screenshot("call_7", "Mail"), screenshot("call_8", "Mail")]);
	assert.equal(hasImage(mixed[0]), true);
});

test("T2: a model without image input is refused before any capture, with the sentence that fixes it", async () => {
	const root = tmp();
	const ext = await loadTemplate(root);
	const pi = fakePi();
	ext.default(pi);
	const toolCall = pi.handlers.get("tool_call");
	assert.equal(typeof toolCall, "function", "the guard rides Pi's tool_call hook, which can block");
	const call = { toolName: "mcp__computer__screenshot_my_window", toolCallId: "call_1", input: {} };
	const blocked = await toolCall(call, { model: { input: ["text"] } });
	assert.deepEqual(blocked, { block: true, reason: windowCapture.NO_VISION_MESSAGE });
	assert.match(windowCapture.NO_VISION_MESSAGE, /cannot see images/);
	assert.match(windowCapture.NO_VISION_MESSAGE, /image input \(vision\)/);
	// A model that sees images, an unknown model and any other tool are never blocked.
	assert.equal(await toolCall(call, { model: { input: ["text", "image"] } }), undefined);
	assert.equal(await toolCall(call, { model: undefined }), undefined);
	assert.equal(await toolCall(call, {}), undefined);
	assert.equal(await toolCall({ ...call, toolName: "mcp__computer__something_else" }, { model: { input: ["text"] } }), undefined);
	assert.equal(await toolCall({ ...call, toolName: "bash" }, { model: { input: ["text"] } }), undefined);
	const context = pi.handlers.get("context");
	assert.equal(typeof context, "function");
	const messages = [screenshot("call_1", "Mail"), screenshot("call_2", "Mail")];
	assert.deepEqual(await context({ messages }), { messages: ext.pruneScreenshots(messages) });
	const unchanged = [screenshot("call_9", "Mail")];
	assert.equal(await context({ messages: unchanged }), undefined, "an unchanged list is not returned at all");
});
