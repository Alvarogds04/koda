"use strict";

/**
 * K2-06 (S1/S2/S3) · «preguntarle a Koda por mi ventana» — the daemon half.
 *
 * The Rust host already serves a loopback MCP server with ONE tool, `screenshot_my_window` (the agent
 * sees it as `mcp__computer__screenshot_my_window`), and hands its endpoint to the daemon at spawn
 * through KODA_WINDOW_MCP_URL / KODA_WINDOW_MCP_TOKEN (apps/desktop-tauri/src/daemonhost.rs). This
 * module owns everything the daemon contributes to it:
 *
 *   T1 · the projection. `config.writeMcpProjection` adds the endpoint as the `computer` server of
 *        the engine's own `<island>/agent/mcp.json` (0600), through the same proxy-only rule as any
 *        imported server: http on a literal loopback host and exactly one Bearer header. The token is
 *        a capability: it lives only in that file, is never interpolated into the extension and is
 *        never logged.
 *   T3 · the extension. `koda-window-capture.js` is installed next to the engine's other extensions
 *        (the same place and mechanism the custom-provider extension uses) and is a copy of Gentle
 *        Dot's `packages/daemon/src/extensions/screenshot-context.ts` (MIT; see
 *        THIRD-PARTY-NOTICES.md): only the LAST screenshot of a conversation travels to the model as
 *        an image, each earlier one becomes a one-line note.
 *   T2 · the no-vision guard. The same extension refuses the capture in Pi's `tool_call` hook — which
 *        can block, so nothing is captured and then discarded — when the active model declares no
 *        image input, answering with the one sentence that says what the user has to change.
 *
 * Lifecycle: installed only while the host configured the endpoint, like the projection; a stale copy
 * is removed. Both files are Koda's own generated artifacts, and the custom-provider teardown
 * (profiles.cjs) only ever removes the files it names itself, so this one never moves under it.
 */

const fs = require("node:fs");
const path = require("node:path");

const config = require("./config.cjs");
const { islandPaths, writePrivateFile } = require("./isolation.cjs");

/** The extension's file name: distinct from the custom provider's, so the two lifetimes never mix. */
const EXTENSION_FILE = "koda-window-capture.js";
/** The host's MCP server id (projected in config.cjs as `computer`) and the tool prefix Pi gives it. */
const TOOL_PREFIX = "mcp__computer__";
const SCREENSHOT_TOOL = `${TOOL_PREFIX}screenshot_my_window`;
/** S2: what the user reads instead of a capture their model could never see. */
const NO_VISION_MESSAGE = "Your current model cannot see images. Choose a provider or model with image input (vision) in Ajustes → Cuentas and ask again.";

// The template is plain ESM loaded by Pi (jiti), exactly like the custom-provider one. Keep it free of
// backticks and dollar-brace sequences: it is a constant, never a template that receives data.
const TEMPLATE = String.raw`// Koda window capture extension (template v1). Generated file: do not edit.
// Adapted from Gentle Dot's packages/daemon/src/extensions/screenshot-context.ts
// (MIT, Copyright (c) 2026 Gentleman Programming; see THIRD-PARTY-NOTICES.md).
//
// The engine resends the whole history on every call, so a long window-capture session would carry
// every screenshot it ever took. Only the LAST one travels as an image; each earlier one becomes a
// one-line note built from what the tool already returned (no extra model calls). The saved session
// keeps every image: this only shapes what one request carries.
//
// The same extension refuses a capture the active model could never see, BEFORE the host captures
// anything, and answers with the sentence that tells the user what to change.
const TOOL_PREFIX = "mcp__computer__";
const SCREENSHOT_TOOL = TOOL_PREFIX + "screenshot_my_window";
export const NO_VISION_MESSAGE = ${JSON.stringify(NO_VISION_MESSAGE)};

/** The front app from the helper's metadata block, when there is one. */
function frontApp(content) {
	for (const block of content) {
		if (!block || block.type !== "text" || typeof block.text !== "string" || block.text.charAt(0) !== "{") continue;
		try {
			const app = JSON.parse(block.text).frontApp;
			if (typeof app === "string" && app !== "") return app;
		} catch {
			// Not the metadata block.
		}
	}
	return undefined;
}

function isMetadata(block) {
	return block !== null && typeof block === "object" && frontApp([block]) !== undefined;
}

function isScreenshotResult(message) {
	return (
		message !== null &&
		typeof message === "object" &&
		message.role === "toolResult" &&
		typeof message.toolName === "string" &&
		message.toolName.indexOf(TOOL_PREFIX) === 0 &&
		Array.isArray(message.content) &&
		message.content.some((block) => block && block.type === "image")
	);
}

function logLine(message, content) {
	const tool = (message.toolName || "").slice(TOOL_PREFIX.length) || "action";
	const app = frontApp(content);
	return { type: "text", text: "[earlier screenshot omitted: " + tool + (app ? " in " + app : "") + "]" };
}

/**
 * The messages for one model call: every computer screenshot but the last is replaced by a note,
 * keeping the action's own text. The input array itself is returned when nothing changes, so Pi keeps
 * its cached prefix.
 */
export function pruneScreenshots(messages) {
	if (!Array.isArray(messages)) return messages;
	let last = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (isScreenshotResult(messages[i])) {
			last = i;
			break;
		}
	}
	if (last < 0 || !messages.slice(0, last).some(isScreenshotResult)) return messages;
	return messages.map((message, i) => {
		if (i === last || !isScreenshotResult(message)) return message;
		const kept = message.content.filter((block) => block && block.type !== "image" && !isMetadata(block));
		return { ...message, content: [...kept, logLine(message, message.content)] };
	});
}

/**
 * The reason a capture must not happen, or undefined. Only an ACTIVE model that declares its input
 * capabilities and lacks images is refused: an unknown model is never refused on a guess.
 */
export function refusedReason(model) {
	if (model === null || typeof model !== "object" || !Array.isArray(model.input)) return undefined;
	return model.input.indexOf("image") === -1 ? NO_VISION_MESSAGE : undefined;
}

export default function (pi) {
	pi.on("tool_call", async (event, ctx) => {
		if (!event || event.toolName !== SCREENSHOT_TOOL) return undefined;
		const reason = refusedReason(ctx ? ctx.model : undefined);
		return reason ? { block: true, reason } : undefined;
	});
	pi.on("context", async (event) => {
		const input = event ? event.messages : undefined;
		const messages = pruneScreenshots(input);
		return messages === input ? undefined : { messages };
	});
}
`;

/** Removes our own generated extension when the host no longer configured the endpoint. Never throws. */
function removeInstalled(target) {
	try {
		const stats = fs.lstatSync(target);
		if (!stats.isFile() || stats.isSymbolicLink()) return false;
		if (typeof process.getuid === "function" && stats.uid !== process.getuid()) return false;
		fs.unlinkSync(target);
		return true;
	} catch {
		return false;
	}
}

/**
 * Projects the host's endpoint (through `config.writeMcpProjection`, called by the daemon) and
 * installs the extension into `<island>/agent/extensions` while it exists. Without the endpoint there
 * is nothing to install, so a copy left by an earlier run is removed. Returns true when installed.
 */
function install(islandRoot, env) {
	const target = path.join(islandPaths(islandRoot).agentDir, "extensions", EXTENSION_FILE);
	if (config.windowMcpEntry(env)) {
		writePrivateFile(target, TEMPLATE);
		return true;
	}
	removeInstalled(target);
	return false;
}

module.exports = { EXTENSION_FILE, NO_VISION_MESSAGE, SCREENSHOT_TOOL, TEMPLATE, TOOL_PREFIX, install };
