"use strict";

/**
 * Abito island protocol "island-agent/1" (U3): pure codec, validators, DTO
 * sanitizers and Pi RPC event translation. No I/O, no state.
 *
 * Everything that leaves the daemon is rebuilt field by field from an
 * allowlist; unknown Pi events are dropped and never forwarded raw. Tool
 * arguments and results are never copied (only a short, sanitized tool name).
 *
 * Message names and the handshake shape follow the Gentle Dot protocol
 * (MIT, Copyright (c) 2026 Gentleman Programming); see THIRD-PARTY-NOTICES.md.
 */

const { SCHEMA: CONNECTORS_SCHEMA, buildCatalog, buildConnectors } = require("./connectors.cjs");
const { SCHEMA: MCP_IMPORT_SCHEMA, buildFiles, buildServers } = require("./mcp-import.cjs");
const { SCHEMA: SESSIONS_SCHEMA, buildSessions } = require("./sessions.cjs");

const PROTOCOL = "island-agent/1";

const LIMITS = Object.freeze({
	/** Largest inbound frame after the handshake (bytes, excluding LF). */
	maxFrameBytes: 256 * 1024,
	/** Largest hello frame. */
	maxHelloBytes: 4 * 1024,
	maxTextChars: 64 * 1024,
	maxAnswerChars: 8 * 1024,
	maxImages: 4,
	maxImageChars: 150 * 1024,
	maxDeltaChars: 16 * 1024,
	maxTitleChars: 300,
	maxOptions: 50,
	maxOptionChars: 200,
	maxIdChars: 128,
});

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const STRICT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SAFE_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** Any control character (tabs and newlines included) is refused in short labels/ids. */
const CONTROL = /[\u0000-\u001f\u007f]/;
/** Hook-managed agents (agents.cjs); the closed set of agent_connect/agent_disconnect targets. */
const AGENT_IDS = Object.freeze(["pi", "claude-code", "codex", "recap", "statusline", "copilot-cli", "opencode"]);
const PLAN_HASH = /^[0-9a-f]{64}$/;
/** #361 agent hooks catalogue: harness-driven (claude-code, codex) plus native adapters. */
const HOOK_CLIENT_IDS = Object.freeze(["claude-code", "codex", "recap", "statusline", "gemini-cli", "copilot-cli", "opencode", "amp", "cursor"]);
const CONNECTOR_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const PROPOSAL_ID = /^ap-[0-9a-f]{28,}$/;
const DIGEST = /^[0-9a-f]{64}$/i;
const RESERVED_CONNECTOR_IDS = new Set(["__proto__", "constructor", "prototype"]);
const CONNECTOR_FORBIDDEN_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const AUTH_PHASES = ["starting", "prompt", "progress", "done"];

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isString = (v, max) => typeof v === "string" && v.length <= max;
const strictId = (v) => isString(v, 64) && STRICT_ID.test(v);
const safeLabel = (v) => isString(v, 80) && v.trim() !== "" && !CONTROL.test(v);
const clip = (v, max) => {
	const s = typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
	// Control characters (except tab/newline) never travel to the UI.
	return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, max);
};

// ----- local OpenAI-compatible endpoint (V5) ---------------------------------

const LOCAL_URL_MAX = 200;
const LOCAL_MODELS_MAX = 32;
const LOCAL_MODEL_ID_MAX = 200;
/** Whole-string grammar: scheme, bare host, optional numeric port, explicit path. No userinfo/query/fragment/space. */
const LOCAL_URL_SHAPE = /^(https?):\/\/(localhost|\[::1\]|127\.\d{1,3}\.\d{1,3}\.\d{1,3})(?::(\d{1,5}))?(\/[A-Za-z0-9._~/-]*)$/i;
const DOTTED_BYTE = /^(0|[1-9]\d{0,2})$/;

/**
 * The single baseUrl policy for local accounts. The agent sends prompts to this URL, so it is
 * limited to THIS computer (no cloud, no LAN): http/https, host exactly `localhost`, 127.0.0.0/8
 * in canonical dotted form, or `[::1]`; explicit path (never guessed); no userinfo, query or
 * fragment. The host is checked on the RAW text too, because WHATWG URL would silently rewrite
 * decimal/hex/octal tricks (2130706433, 0x7f.1, 0177.0.0.1) to 127.0.0.1.
 * Returns the normalized `url.href`, or undefined.
 */
function validateLocalBaseUrl(value) {
	if (!isString(value, LOCAL_URL_MAX)) return undefined;
	const m = LOCAL_URL_SHAPE.exec(value);
	if (!m) return undefined;
	const host = m[2].toLowerCase();
	if (host.startsWith("127.") && !host.split(".").every((p) => DOTTED_BYTE.test(p) && Number(p) <= 255)) return undefined;
	if (m[3] !== undefined) {
		const port = Number(m[3]);
		if (!(port >= 1 && port <= 65535)) return undefined;
	}
	const pathPart = m[4];
	if (pathPart.includes("//") && pathPart !== "/") return undefined;
	if (pathPart.split("/").some((seg) => seg === "." || seg === "..")) return undefined;
	let url;
	try {
		url = new URL(value);
	} catch {
		return undefined;
	}
	if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return undefined;
	if (url.hostname !== host || url.pathname !== pathPart) return undefined;
	return url.href;
}

// ----- custom OpenAI-compatible provider (HU-041) -----------------------------------------

const CUSTOM_URL_SHAPE = /^(https?):\/\/(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(?::(\d{1,5}))?((?:\/[A-Za-z0-9._~-]+)*)\/?$/;

/**
 * Base URL policy of a custom (LiteLLM / OpenAI-compatible) provider: https, or http only for a
 * LITERAL loopback address (127.0.0.0/8 canonical, [::1]; the name `localhost` is not a literal).
 * No userinfo, query, fragment (even empty), percent-escapes, empty or dot path segments. The host
 * must survive WHATWG parsing unchanged, so decimal/hex/octal IPv4 tricks are refused. Returns the
 * normalized URL without a trailing slash, or undefined.
 */
function validateCustomBaseUrl(value) {
	if (!isString(value, LOCAL_URL_MAX)) return undefined;
	const m = CUSTOM_URL_SHAPE.exec(value);
	if (!m) return undefined;
	const scheme = m[1].toLowerCase();
	const host = m[2].toLowerCase();
	if (m[3] !== undefined && !(Number(m[3]) >= 1 && Number(m[3]) <= 65535)) return undefined;
	if (m[4].split("/").some((seg) => seg === "." || seg === "..")) return undefined;
	if (scheme === "http") {
		const loopback = host === "[::1]" || (/^127(\.\d{1,3}){3}$/.test(host) && host.split(".").every((p) => DOTTED_BYTE.test(p) && Number(p) <= 255));
		if (!loopback) return undefined;
	}
	let url;
	try {
		url = new URL(value);
	} catch {
		return undefined;
	}
	if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.hostname !== host) return undefined;
	return `${url.origin}${url.pathname}`.replace(/\/$/, "");
}

/** 1..32 unique model ids (exact-match duplicates rejected) of 1..200 chars: no control characters, not whitespace-only. */
function validateLocalModelIds(value) {
	if (!Array.isArray(value) || value.length < 1 || value.length > LOCAL_MODELS_MAX) return undefined;
	for (const id of value) {
		if (!isString(id, LOCAL_MODEL_ID_MAX) || id.trim() === "" || CONTROL.test(id)) return undefined;
	}
	if (new Set(value).size !== value.length) return undefined;
	return [...value];
}

// ----- client -> server --------------------------------------------------

function validImages(images) {
	if (images === undefined) return [];
	if (!Array.isArray(images) || images.length > LIMITS.maxImages) return null;
	const out = [];
	for (const image of images) {
		if (!isObject(image) || !IMAGE_MIMES.has(image.mimeType)) return null;
		if (!isString(image.data, LIMITS.maxImageChars) || image.data === "" || !BASE64.test(image.data)) return null;
		out.push({ type: "image", data: image.data, mimeType: image.mimeType });
	}
	return out;
}

/**
 * Validates one decoded client frame (after hello) and rebuilds it with only
 * the allowed fields. Returns undefined for anything invalid or unknown.
 */
function validateClientFrame(raw) {
	if (!isObject(raw) || typeof raw.type !== "string") return undefined;
	switch (raw.type) {
		case "send": {
			if (!isString(raw.text, LIMITS.maxTextChars) || raw.text.trim() === "") return undefined;
			const images = validImages(raw.images);
			if (images === null) return undefined;
			return { type: "send", text: raw.text, images };
		}
		case "steer":
			if (!isString(raw.text, LIMITS.maxTextChars) || raw.text.trim() === "") return undefined;
			return { type: "steer", text: raw.text };
		case "abort":
		case "new_conversation":
		case "status":
		case "interrupted_ack": // R5: acknowledges the interrupted-work record exposed in the ready frame

		case "accounts_list":
		case "providers_list":
		case "profiles_list":
		case "connectors_list":
		case "mcp_import_preview":
		case "connectors_pending":
		case "agents_list":
		case "sessions_list":
			return { type: raw.type };
		case "set_paused":
			// Global pause switch (#379): a closed boolean, nothing else travels.
			if (typeof raw.paused !== "boolean") return undefined;
			return { type: "set_paused", paused: raw.paused };
		case "connectors_approve": {
			if (typeof raw.proposal_id !== "string" || !PROPOSAL_ID.test(raw.proposal_id)) return undefined;
			if (typeof raw.digest !== "string" || !DIGEST.test(raw.digest)) return undefined;
			return { type: raw.type, proposal_id: raw.proposal_id, digest: raw.digest.toLowerCase() };
		}
		case "connectors_deny":
			if (typeof raw.proposal_id !== "string" || !PROPOSAL_ID.test(raw.proposal_id)) return undefined;
			return { type: raw.type, proposal_id: raw.proposal_id };
		case "connectors_connect": {
			if (["values", "secrets", "fields", "token", "password"].some((key) => Object.hasOwn(raw, key))) return undefined;
			if (typeof raw.connector_id !== "string" || !CONNECTOR_ID.test(raw.connector_id) || RESERVED_CONNECTOR_IDS.has(raw.connector_id)) return undefined;
			return { type: raw.type, connector_id: raw.connector_id };
		}
		case "connectors_disconnect":
			case "connectors_mode": {
			if (typeof raw.connector_id !== "string" || !CONNECTOR_ID.test(raw.connector_id) || RESERVED_CONNECTOR_IDS.has(raw.connector_id)) return undefined;
			if (raw.type === "connectors_mode") {
				if (raw.mode !== "read_only" && raw.mode !== "read_and_send") return undefined;
				return { type: raw.type, connector_id: raw.connector_id, mode: raw.mode };
			}
			return { type: raw.type, connector_id: raw.connector_id };
		}
		case "agent_connect":
		case "agent_disconnect": {
			// Reachable ONLY through this authenticated channel (see agents.cjs). Closed id set; unknown keys dropped.
			if (typeof raw.agentId !== "string" || !AGENT_IDS.includes(raw.agentId)) return undefined;
			if (raw.type === "agent_connect" && ["recap", "statusline"].includes(raw.agentId) && raw.plan_hash === undefined) return undefined;
			const frame = { type: raw.type, agentId: raw.agentId };
			if (raw.type === "agent_connect" && raw.plan_hash !== undefined) {
				if (typeof raw.plan_hash !== "string" || !PLAN_HASH.test(raw.plan_hash)) return undefined;
				frame.plan_hash = raw.plan_hash;
			}
			return frame;
		}
		case "hooks_preview":
			return { type: "hooks_preview" };
		case "hooks_install":
		case "hooks_remove": {
			// #361: closed client set; install REQUIRES the exact plan hash the caller was shown.
			if (typeof raw.clientId !== "string" || !HOOK_CLIENT_IDS.includes(raw.clientId)) return undefined;
			const frame = { type: raw.type, clientId: raw.clientId };
			if (raw.plan_hash !== undefined) {
				if (typeof raw.plan_hash !== "string" || !PLAN_HASH.test(raw.plan_hash)) return undefined;
				frame.plan_hash = raw.plan_hash;
			} else if (raw.type === "hooks_install") return undefined;
			return frame;
		}
		case "models_list": {
			const frame = { type: "models_list" };
			if (raw.providerId !== undefined) {
				if (!isString(raw.providerId, 64) || !STRICT_ID.test(raw.providerId)) return undefined;
				frame.providerId = raw.providerId;
			}
			if (raw.accountId !== undefined) {
				if (!isString(raw.accountId, 64) || !STRICT_ID.test(raw.accountId)) return undefined;
				frame.accountId = raw.accountId;
			}
			return frame;
		}
		case "settings_get":
			return { type: "settings_get" };
		case "settings_set":
			// Grammar is enforced by config.validateHotkey; here only type and size.
			if (raw.hotkey === null) return { type: "settings_set", hotkey: null };
			if (!isString(raw.hotkey, 40) || raw.hotkey === "") return undefined;
			return { type: "settings_set", hotkey: raw.hotkey };
		case "profile_select":
			if (!isString(raw.id, 64) || !STRICT_ID.test(raw.id)) return undefined;
			return { type: "profile_select", id: raw.id };
		case "role_select":
			if (!isString(raw.role, 64) || raw.role === "") return undefined;
			return { type: "role_select", role: raw.role };
		case "ui_response": {
			if (!isString(raw.id, LIMITS.maxIdChars) || !SAFE_ID.test(raw.id)) return undefined;
			if (raw.cancelled === true) return { type: "ui_response", id: raw.id, cancelled: true };
			if (typeof raw.confirmed === "boolean") return { type: "ui_response", id: raw.id, confirmed: raw.confirmed };
			if (isString(raw.value, LIMITS.maxAnswerChars)) return { type: "ui_response", id: raw.id, value: raw.value };
			return undefined;
		}
		case "account_create": {
			if (!strictId(raw.provider) || !safeLabel(raw.label)) return undefined;
			const frame = { type: "account_create", provider: raw.provider, label: raw.label };
			if (raw.accountId !== undefined) {
				if (!strictId(raw.accountId)) return undefined;
				frame.accountId = raw.accountId;
			}
			return frame;
		}
		case "local_account_create": {
			if (!safeLabel(raw.label)) return undefined;
			const baseUrl = validateLocalBaseUrl(raw.baseUrl);
			const modelIds = validateLocalModelIds(raw.modelIds);
			if (!baseUrl || !modelIds) return undefined;
			const frame = { type: "local_account_create", label: raw.label, baseUrl, modelIds };
			if (raw.accountId !== undefined) {
				if (!strictId(raw.accountId)) return undefined;
				frame.accountId = raw.accountId;
			}
			return frame;
		}
		case "local_endpoint_set": {
			if (!strictId(raw.accountId)) return undefined;
			const baseUrl = validateLocalBaseUrl(raw.baseUrl);
			const modelIds = validateLocalModelIds(raw.modelIds);
			if (!baseUrl || !modelIds) return undefined;
			return { type: "local_endpoint_set", accountId: raw.accountId, baseUrl, modelIds };
		}
		case "custom_account_create": {
			if (!safeLabel(raw.label)) return undefined;
			const baseUrl = validateCustomBaseUrl(raw.baseUrl);
			if (!baseUrl) return undefined;
			const frame = { type: "custom_account_create", label: raw.label, baseUrl };
			if (raw.accountId !== undefined) {
				if (!strictId(raw.accountId)) return undefined;
				frame.accountId = raw.accountId;
			}
			return frame;
		}
		case "custom_endpoint_set": {
			if (!strictId(raw.accountId)) return undefined;
			const baseUrl = validateCustomBaseUrl(raw.baseUrl);
			if (!baseUrl) return undefined;
			return { type: "custom_endpoint_set", accountId: raw.accountId, baseUrl };
		}
		case "custom_models_refresh":
		case "account_remove":
		case "account_logout":
		case "account_status":
			if (!strictId(raw.accountId)) return undefined;
			return { type: raw.type, accountId: raw.accountId };
		case "profile_save": {
			if (!strictId(raw.id) || !safeLabel(raw.label) || !strictId(raw.role)) return undefined;
			if (!strictId(raw.accountId) || !strictId(raw.provider)) return undefined;
			if (!isString(raw.modelId, 200) || raw.modelId === "" || CONTROL.test(raw.modelId)) return undefined;
			const frame = {
				type: "profile_save",
				id: raw.id,
				label: raw.label,
				role: raw.role,
				accountId: raw.accountId,
				provider: raw.provider,
				modelId: raw.modelId,
			};
			if (raw.thinkingLevel !== undefined) {
				if (!THINKING_LEVELS.includes(raw.thinkingLevel)) return undefined;
				frame.thinkingLevel = raw.thinkingLevel;
			}
			return frame;
		}
		case "profile_remove":
			if (!strictId(raw.id)) return undefined;
			return { type: "profile_remove", id: raw.id };
		case "profile_deactivate":
		case "auth_state":
			return { type: raw.type };
		case "auth_start":
			if (!isString(raw.accountId, 64) || !STRICT_ID.test(raw.accountId)) return undefined;
			if (raw.method !== "oauth" && raw.method !== "api_key") return undefined;
			return { type: "auth_start", accountId: raw.accountId, method: raw.method };
		case "auth_reply":
			if (!isString(raw.flowId, 128) || !isString(raw.promptId, 128) || !isString(raw.value, LIMITS.maxAnswerChars)) {
				return undefined;
			}
			return { type: "auth_reply", flowId: raw.flowId, promptId: raw.promptId, value: raw.value };
		case "auth_cancel":
			if (!isString(raw.flowId, 128)) return undefined;
			return { type: "auth_cancel", flowId: raw.flowId };
		default:
			return undefined;
	}
}

/**
 * Parses one LF-delimited line into a frame. `hello` is only accepted when
 * `expectHello` is set and everything else only when it is not.
 * Returns { frame } or { error: "bad_request" } (never details).
 */
function decodeClientLine(bytes, { expectHello = false } = {}) {
	let value;
	try {
		value = JSON.parse(Buffer.from(bytes).toString("utf8"));
	} catch {
		return { error: "bad_request" };
	}
	if (expectHello) {
		if (!isObject(value) || value.type !== "hello" || typeof value.protocol !== "string" || typeof value.token !== "string") {
			return { error: "bad_request" };
		}
		return { frame: { type: "hello", protocol: value.protocol, token: value.token } };
	}
	const frame = validateClientFrame(value);
	return frame ? { frame } : { error: "bad_request" };
}

// ----- server -> client --------------------------------------------------

/** Adds the per-client monotonic sequence number and frames the record with LF. */
function encodeServerFrame(frame, seq) {
	return Buffer.from(`${JSON.stringify({ ...frame, seq })}\n`, "utf8");
}

const EMITTED_ERROR_CODES = new Set([
	"bad_request", "busy", "not_busy", "unavailable", "rate_limited", "unknown_ask", "paused", "failed",
	"unknown_proposal", "digest_mismatch", "needs_setup", "signin_failed", "store_not_private",
]);
// Recognized by the host's broader enum, but collapsed to stale/failed before H2c can emit them.
const RESERVED_CONNECTOR_ERROR_CODES = new Set(["already_decided", "session_mismatch", "pending_full"]);
const errorFrame = (code) => ({ type: "error", code: RESERVED_CONNECTOR_ERROR_CODES.has(code) ? "failed" : EMITTED_ERROR_CODES.has(code) ? code : "failed" });

// ----- DTO sanitizers (allowlists; never keys, baseUrl, headers, env) ------

function accountDto(a) {
	return {
		accountId: clip(a?.accountId, 64),
		label: clip(a?.label, 80),
		provider: clip(a?.provider, 64),
		authMethod: a?.authMethod === "oauth" || a?.authMethod === "api_key" ? a.authMethod : "none",
		configured: a?.configured === true,
		// Present (true) only for local-endpoint accounts; never the endpoint itself.
		...(a?.local === true ? { local: true } : {}),
		// Present (true) only for custom-provider accounts; never the Base URL. Not selectable for inference yet.
		...(a?.custom === true ? { custom: true } : {}),
	};
}

function providerDto(p) {
	const methods = Array.isArray(p?.methods) ? p.methods.filter((m) => m === "oauth" || m === "api_key") : [];
	return { id: clip(p?.id, 64), name: clip(p?.name ?? p?.id, 120), methods, configured: p?.configured === true };
}

function modelDto(m) {
	return {
		provider: clip(m?.provider, 64),
		id: clip(m?.id, 128),
		name: clip(m?.name ?? m?.id, 160),
		reasoning: m?.reasoning === true,
		input: Array.isArray(m?.input) ? m.input.filter((v) => v === "text" || v === "image") : [],
		contextWindow: Number.isFinite(m?.contextWindow) ? m.contextWindow : 0,
	};
}

function profileDto(p) {
	return {
		id: clip(p?.id, 64),
		label: clip(p?.label, 80),
		role: clip(p?.role, 64),
		accountId: clip(p?.accountId, 64),
		provider: clip(p?.provider, 64),
		modelId: clip(p?.modelId, 200),
		thinkingLevel: clip(p?.thinkingLevel, 16),
	};
}

/** Reply to settings_get / broadcast after settings_set: the hotkey (non-secret) or null. */
const settingsFrame = (s) => ({ type: "settings", hotkey: typeof s?.hotkey === "string" ? clip(s.hotkey, 40) : null });

/** Reply to account_create / account_status. */
const accountFrame = (a) => ({ type: "account", account: accountDto(a) });

/** Reply to auth_state: the current/last flow as tracked by the server, or null. */
function authStateFrame(flow) {
	if (!isObject(flow) || !AUTH_PHASES.includes(flow.phase)) return { type: "auth_state", flow: null };
	return {
		type: "auth_state",
		flow: {
			flowId: clip(flow.flowId, 128),
			accountId: clip(flow.accountId, 64),
			method: flow.method === "oauth" || flow.method === "api_key" ? flow.method : "api_key",
			phase: flow.phase,
		},
	};
}

/**
 * Reply to connectors_list: rebuilt field by field from the strict allowlist builders of
 * connectors.cjs (persisted, read-only values). THROWS on invalid data; the server answers
 * `failed`. Nothing off-allowlist (urls, commands, env, secrets, capabilities) can pass.
 */
const CONNECTORS_EMIT = Object.freeze({ maxConnectors: 128, maxCatalog: 32, maxFrameBytes: 200 * 1024 });
const connectorsFrame = (data) => {
	const frame = {
		type: "connectors",
		schema: CONNECTORS_SCHEMA,
		catalog: buildCatalog(data?.catalog),
		connectors: buildConnectors(data?.connectors),
	};
	// Nothing is truncated silently: an over-cap result is a failure, never a partial frame.
	if (data?.live === true) frame.live = true;
	else if (data?.live !== undefined && data.live !== false) throw new Error("connectors frame invalid");
	if (frame.catalog.length > CONNECTORS_EMIT.maxCatalog || frame.connectors.length > CONNECTORS_EMIT.maxConnectors) throw new Error("connectors frame too large");
	if (Buffer.byteLength(JSON.stringify(frame)) > CONNECTORS_EMIT.maxFrameBytes) throw new Error("connectors frame too large");
	return frame;
};

/**
 * Reply to mcp_import_preview: rebuilt field by field from the strict allowlist builders of
 * mcp-import.cjs (read-only scan of other clients' MCP configs, #381). THROWS on invalid
 * data; the server answers `failed`. Nothing off-allowlist (env, headers, args, paths,
 * secrets) can pass.
 */
const MCP_IMPORT_EMIT = Object.freeze({ maxServers: 128, maxFiles: 8, maxFrameBytes: 200 * 1024 });
const mcpImportFrame = (data) => {
	if (typeof data?.truncated !== "boolean") throw new Error("mcp import frame invalid");
	const frame = {
		type: "mcp_import",
		schema: MCP_IMPORT_SCHEMA,
		files: buildFiles(data?.files),
		servers: buildServers(data?.servers),
		truncated: data.truncated,
	};
	// Nothing is truncated silently: an over-cap result is a failure, never a partial frame.
	if (frame.files.length > MCP_IMPORT_EMIT.maxFiles || frame.servers.length > MCP_IMPORT_EMIT.maxServers) throw new Error("mcp import frame too large");
	if (Buffer.byteLength(JSON.stringify(frame)) > MCP_IMPORT_EMIT.maxFrameBytes) throw new Error("mcp import frame too large");
	return frame;
};

/**
 * Reply to sessions_list (#360): rebuilt field by field from the strict builders of
 * sessions.cjs (read-only /proc discovery of live agent sessions). THROWS on invalid
 * data; the server answers `failed`. Nothing off-allowlist (command lines, arguments,
 * environment, full paths, pids) can pass.
 */
const SESSIONS_EMIT = Object.freeze({ maxSessions: 64, maxFrameBytes: 64 * 1024 });
const sessionsFrame = (data) => {
	if (typeof data?.truncated !== "boolean") throw new Error("sessions frame invalid");
	const frame = {
		type: "sessions",
		schema: SESSIONS_SCHEMA,
		sessions: buildSessions(data?.sessions),
		truncated: data.truncated,
	};
	// The real number of sessions when the list was cut: only when truncated, only a sane integer
	// (at least the rows shown, at most the scanner's pid bound). Absent otherwise: never invented.
	if (data.truncated && data.total !== undefined) {
		if (!Number.isSafeInteger(data.total) || data.total < frame.sessions.length || data.total > 4096) throw new Error("sessions frame invalid");
		frame.total = data.total;
	}
	// Nothing is truncated silently: an over-cap result is a failure, never a partial frame.
	if (frame.sessions.length > SESSIONS_EMIT.maxSessions || Buffer.byteLength(JSON.stringify(frame)) > SESSIONS_EMIT.maxFrameBytes) throw new Error("sessions frame too large");
	return frame;
};
/** Rebuilds a bounded live approval list. Sanitization changes are explicit because the digest covers the original preview. */
function pendingFrame(data) {
	const items = Array.isArray(data) ? data : data?.items;
	if (!Array.isArray(items) || items.length > 64) throw new Error("pending frame invalid");
	const safeText = (value, max, allowEmpty = false, allowForbidden = false) => {
		if (typeof value !== "string" || (!allowEmpty && value.length === 0) || Array.from(value).length > max || (!allowForbidden && CONNECTOR_FORBIDDEN_TEXT.test(value))) throw new Error("pending frame invalid");
		return value;
	};
	return {
		type: "pending",
		items: items.map((item) => {
			if (!isObject(item) || typeof item.proposal_id !== "string" || !PROPOSAL_ID.test(item.proposal_id) ||
				typeof item.connector_id !== "string" || !CONNECTOR_ID.test(item.connector_id) || RESERVED_CONNECTOR_IDS.has(item.connector_id) ||
				typeof item.connector_label_truncated !== "boolean" || typeof item.arguments_truncated !== "boolean" || item.arguments_sensitive !== true ||
				typeof item.digest !== "string" || !DIGEST.test(item.digest) || !Number.isSafeInteger(item.expires_in_ms) || item.expires_in_ms < 0) throw new Error("pending frame invalid");
			const labelChars = Array.from(safeText(item.connector_label, Number.MAX_SAFE_INTEGER));
			const connectorLabelTruncated = item.connector_label_truncated || labelChars.length > 128;
			const connectorLabel = labelChars.slice(0, 128).join("");
			const originalPreview = safeText(item.arguments_preview, 512, true, true);
			const argumentsPreview = originalPreview.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu, "");
			return {
				proposal_id: item.proposal_id,
				connector_id: item.connector_id,
				connector_label: connectorLabel,
				connector_label_truncated: connectorLabelTruncated,
				tool: safeText(item.tool, 128),
				arguments_preview: argumentsPreview,
				arguments_truncated: item.arguments_truncated || argumentsPreview !== originalPreview,
				arguments_sensitive: true,
				digest: item.digest.toLowerCase(),
				expires_in_ms: item.expires_in_ms,
			};
		}),
	};
}

/** Fixed agent table: names never come from the dependency. */
const AGENT_NAMES = Object.freeze({ pi: "Pi", "claude-code": "Claude Code", codex: "Codex", recap: "Resumen semanal", statusline: "Uso del plan (relay)", "copilot-cli": "Copilot CLI", opencode: "OpenCode" });
const AGENT_STATES = new Set(["not_connected", "connected", "outdated", "working", "unavailable", "error"]);
const AGENT_DETAILS = new Set(["config_invalid", "not_writable", "foreign_extension", "unsafe_folder", "backup_failed", "plan_changed", "audit_unavailable", "install_failed", "unsupported_platform", "unsafe_target", "install_unverified"]);
const AGENT_SUMMARY_MAX = 400;
/**
 * Reply/broadcast `agents`: rebuilt field by field from closed vocabularies. THROWS on invalid data
 * (the server answers `failed`). Never a path, command, stderr, file content or secret.
 */
function agentsFrame(items) {
	if (!Array.isArray(items) || items.length > AGENT_IDS.length) throw new Error("agents frame invalid");
	const agents = items.map((a) => {
		if (!isObject(a) || !AGENT_IDS.includes(a.id) || !AGENT_STATES.has(a.state) || typeof a.backup !== "boolean") throw new Error("agents frame invalid");
		if (a.detail !== null && !AGENT_DETAILS.has(a.detail)) throw new Error("agents frame invalid");
		const out = { id: a.id, name: AGENT_NAMES[a.id], state: a.state, backup: a.backup, detail: a.detail };
		if (a.plan_hash !== undefined) {
			if (typeof a.plan_hash !== "string" || !PLAN_HASH.test(a.plan_hash)) throw new Error("agents frame invalid");
			out.plan_hash = a.plan_hash;
		}
		if (a.summary !== undefined) {
			if (typeof a.summary !== "string" || a.summary === "" || a.summary.length > AGENT_SUMMARY_MAX || CONTROL.test(a.summary)) throw new Error("agents frame invalid");
			out.summary = a.summary;
		}
		// HU-047: the one place a folder path travels (the user's own, bounded, no control characters) so Ajustes can name it.
		// A bad folder never takes the whole list down: it is just not forwarded (the row then says the generic sentence).
		if (a.detail === "unsafe_folder" && typeof a.folder === "string" && a.folder !== "" && [...a.folder].length <= 400 && !CONTROL.test(a.folder) && ["writable", "foreign_owner", "acl"].includes(a.folder_reason)) {
			out.folder = a.folder;
			out.folder_reason = a.folder_reason;
		}
		for (const key of ["reviewable", "trust_review"]) {
			if (a[key] === undefined) continue;
			if (typeof a[key] !== "boolean") throw new Error("agents frame invalid");
			out[key] = a[key];
		}
		return out;
	});
	return { type: "agents", agents };
}

// ----- #361 hooks frame ----------------------------------------------------------------------

const HOOKS_STATES = new Set(["not_connected", "connected", "outdated", "working", "unavailable", "error"]);
const HOOKS_DETAILS = new Set([
	"config_invalid", "not_writable", "backup_failed", "plan_changed", "audit_unavailable", "install_failed",
	"foreign_file", "unsafe_target", "unexpected_content", "unsupported_platform",
]);
const HOOKS_CODES = new Set(["bad_request", "plan_changed", "foreign_file", "unsafe_target", "unexpected_content", "unsupported_platform", "write_failed", "busy", "unavailable", "failed"]);
const HOOKS_MECHANISMS = new Set(["harness", "artifact"]);
const HOOKS_EMIT = Object.freeze({ maxClients: 9, maxDiffLines: 200, maxLineChars: 320, maxSummary: 400, maxFrameBytes: 1024 * 1024 });
/** Control characters except tab (diff lines carry indentation). */
const HOOKS_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const hooksFail = () => {
	throw new Error("hooks frame invalid");
};

function hooksPlan(plan, requireHash) {
	if (plan === null || plan === undefined) return null;
	if (!isObject(plan) || typeof plan.changed !== "boolean") hooksFail();
	const out = { changed: plan.changed };
	if (plan.plan_hash !== undefined) {
		if (typeof plan.plan_hash !== "string" || !PLAN_HASH.test(plan.plan_hash)) hooksFail();
		out.plan_hash = plan.plan_hash;
	} else if (requireHash) hooksFail();
	if (typeof plan.summary !== "string" || plan.summary.length > HOOKS_EMIT.maxSummary || HOOKS_CONTROL.test(plan.summary)) hooksFail();
	out.summary = plan.summary;
	if (typeof plan.reviewable !== "boolean") hooksFail();
	out.reviewable = plan.reviewable;
	const diff = plan.diff;
	if (!isObject(diff) || !Array.isArray(diff.lines) || diff.lines.length > HOOKS_EMIT.maxDiffLines || !Number.isInteger(diff.hidden) || diff.hidden < 0) hooksFail();
	out.diff = {
		lines: diff.lines.map((l) => {
			if (typeof l !== "string" || l.length > HOOKS_EMIT.maxLineChars || HOOKS_CONTROL.test(l)) hooksFail();
			return l;
		}),
		hidden: diff.hidden,
	};
	return out;
}

/**
 * Reply/broadcast `hooks` (#361): the agent hooks catalogue, rebuilt field by field from
 * closed vocabularies. THROWS on invalid data (the server answers `failed`). Diff lines are
 * the bytes of Abito-owned artifacts only: never a secret, token or foreign file content.
 */
function hooksFrame(data) {
	if (!isObject(data) || !Array.isArray(data.clients) || data.clients.length > HOOKS_EMIT.maxClients) hooksFail();
	const clients = data.clients.map((c) => {
		if (!isObject(c) || !HOOK_CLIENT_IDS.includes(c.id) || !HOOKS_STATES.has(c.state) || !HOOKS_MECHANISMS.has(c.mechanism)) hooksFail();
		if (typeof c.name !== "string" || c.name === "" || c.name.length > 64 || HOOKS_CONTROL.test(c.name)) hooksFail();
		if (c.detail !== null && c.detail !== undefined && !HOOKS_DETAILS.has(c.detail)) hooksFail();
		const out = { id: c.id, name: c.name, mechanism: c.mechanism, state: c.state, detail: c.detail ?? null };
		if (c.backup !== undefined) {
			if (typeof c.backup !== "boolean") hooksFail();
			out.backup = c.backup;
		}
		out.install = hooksPlan(c.install, c.mechanism === "artifact");
		out.remove = hooksPlan(c.remove, c.mechanism === "artifact");
		return out;
	});
	const frame = { type: "hooks", clients };
	if (data.result !== undefined) {
		const r = data.result;
		if (!isObject(r) || !HOOK_CLIENT_IDS.includes(r.clientId) || (r.action !== "install" && r.action !== "remove") || typeof r.ok !== "boolean") hooksFail();
		frame.result = { clientId: r.clientId, action: r.action, ok: r.ok };
		if (r.code !== undefined) {
			if (!HOOKS_CODES.has(r.code)) hooksFail();
			frame.result.code = r.code;
		}
	}
	if (Buffer.byteLength(JSON.stringify(frame)) > HOOKS_EMIT.maxFrameBytes) hooksFail();
	return frame;
}

const list = (items, fn, max = 500) => (Array.isArray(items) ? items.slice(0, max).map(fn) : []);

const accountsFrame = (items) => ({ type: "accounts", accounts: list(items, accountDto) });
const providersFrame = (items) => ({ type: "providers", providers: list(items, providerDto) });
const modelsFrame = (items) => ({ type: "models", models: list(items, modelDto, 2000) });
function profilesFrame(listing, roles) {
	return {
		type: "profiles",
		profiles: list(listing?.profiles, profileDto, 64),
		active: typeof listing?.active === "string" ? clip(listing.active, 64) : null,
		roles: list(roles, (r) => ({
			role: clip(r?.role, 64),
			profileIds: list(r?.profileIds, (id) => clip(id, 64), 64),
		}), 64),
	};
}

/** Auth passthrough: rebuilt from an allowlist; the daemon never answers a prompt. */
function authPromptFrame(p) {
	const frame = {
		type: "auth_prompt",
		flowId: clip(p?.flowId, 128),
		promptId: clip(p?.promptId, 128),
		accountId: clip(p?.accountId, 64),
		kind: clip(p?.kind, 32),
		message: clip(p?.message, 1000),
		secret: p?.secret === true,
	};
	if (typeof p?.connector_id === "string") frame.connector_id = clip(p.connector_id, 64);
	if (typeof p?.optional === "boolean") frame.optional = p.optional;
	if (typeof p?.placeholder === "string") frame.placeholder = clip(p.placeholder, 200);
	if (Array.isArray(p?.options)) {
		frame.options = p.options.slice(0, LIMITS.maxOptions).map((o) => ({
			id: clip(o?.id, 128),
			label: clip(o?.label ?? o?.id, LIMITS.maxOptionChars),
			...(o?.description ? { description: clip(o.description, 300) } : {}),
		}));
	}
	return frame;
}

function authEventFrame(e) {
	const frame = { type: "auth_event", flowId: clip(e?.flowId, 128), kind: clip(e?.kind, 32) };
	for (const [key, max] of [["message", 1000], ["url", 2000], ["instructions", 1000], ["userCode", 100], ["verificationUri", 2000]]) {
		if (e?.[key] !== undefined) frame[key] = clip(e[key], max);
	}
	if (Array.isArray(e?.links)) {
		frame.links = e.links.slice(0, 10).map((l) => ({ url: clip(l?.url, 2000), ...(l?.label ? { label: clip(l.label, 200) } : {}) }));
	}
	return frame;
}

function authDoneFrame(d) {
	const frame = {
		type: "auth_done",
		flowId: clip(d?.flowId, 128),
		accountId: clip(d?.accountId, 64),
		ok: d?.ok === true,
	};
	if (d?.cancelled === true) frame.cancelled = true;
	if (typeof d?.connector_id === "string") frame.connector_id = clip(d.connector_id, 64);
	if (typeof d?.message === "string") frame.message = typeof d?.connector_id === "string" ? (EMITTED_ERROR_CODES.has(d.message) ? d.message : "failed") : clip(d.message, 300);
	if (d?.ok === true && isObject(d.account)) frame.account = accountDto(d.account);
	return frame;
}

// ----- Pi RPC event translation -------------------------------------------

const safeToolName = (name) => (typeof name === "string" && SAFE_NAME.test(name) ? name : "tool");

/**
 * #418: the activity frame. `callId` (the engine's tool call id, only when it matches SAFE_ID) lets the
 * island pair running->done/error; `summary` is a CLOSED sentence, never derived from arguments or results.
 * Both keys are absent when not applicable, so a frame without an id keeps its historical shape.
 */
function activityFrame(event, state) {
	const frame = { type: "activity", name: safeToolName(event.toolName), state };
	if (typeof event.toolCallId === "string" && SAFE_ID.test(event.toolCallId)) {
		frame.callId = event.toolCallId;
		if (state === "error") frame.summary = "La herramienta terminó con error.";
	}
	return frame;
}

/** Splits a long delta so no server frame exceeds LIMITS.maxDeltaChars. */
function deltaFrames(text, messageId) {
	const frames = [];
	for (let i = 0; i < text.length; i += LIMITS.maxDeltaChars) {
		frames.push({ type: "message_delta", messageId, text: text.slice(i, i + LIMITS.maxDeltaChars) });
	}
	return frames;
}

/**
 * Translates one Pi RPC event. Returns
 *   { frames: [...], busy?: boolean, messageDone?: true, ask?: {...}, cancelUi?: id }
 * `frames` need messageId/seq filled by the caller only where noted.
 * Anything not on the allowlist yields { frames: [] }.
 */
function translateEvent(event, messageId = "m0") {
	const none = { frames: [] };
	if (!isObject(event) || typeof event.type !== "string") return none;
	switch (event.type) {
		case "agent_start":
			return { frames: [], busy: true };
		case "agent_settled":
			return { frames: [], busy: false };
		case "message_update": {
			const inner = event.assistantMessageEvent;
			if (!isObject(inner) || inner.type !== "text_delta" || typeof inner.delta !== "string" || inner.delta === "") return none;
			return { frames: deltaFrames(clip(inner.delta, 1_000_000), messageId) };
		}
		case "message_end":
			if (event.message?.role !== "assistant") return none;
			return { frames: [{ type: "message_done", messageId }], messageDone: true };
		case "tool_execution_start":
			return { frames: [activityFrame(event, "running")] };
		case "tool_execution_end":
			return { frames: [activityFrame(event, event.isError === true ? "error" : "done")] };
		case "queue_update":
			return {
				frames: [{
					type: "queue",
					steering: Array.isArray(event.steering) ? Math.min(event.steering.length, 100) : 0,
					followUp: Array.isArray(event.followUp) ? Math.min(event.followUp.length, 100) : 0,
				}],
			};
		case "extension_ui_request":
			return translateUiRequest(event);
		default:
			return none;
	}
}

function translateUiRequest(event) {
	const none = { frames: [] };
	if (typeof event.id !== "string" || !SAFE_ID.test(event.id)) return none;
	switch (event.method) {
		case "notify": {
			const level = event.notifyType === "error" ? "error" : event.notifyType === "warning" ? "warning" : "info";
			return { frames: [{ type: "toast", level, message: clip(event.message, 300) }] };
		}
		case "select": {
			if (!Array.isArray(event.options)) return { frames: [], cancelUi: event.id };
			const options = event.options
				.filter((o) => typeof o === "string")
				.slice(0, LIMITS.maxOptions)
				.map((o) => clip(o, LIMITS.maxOptionChars));
			return { frames: [], ask: { id: event.id, kind: "select", title: clip(event.title, LIMITS.maxTitleChars), options } };
		}
		case "confirm":
			return {
				frames: [],
				ask: { id: event.id, kind: "confirm", title: clip(event.title, LIMITS.maxTitleChars), options: [] },
			};
		case "input":
			return {
				frames: [],
				ask: { id: event.id, kind: "input", title: clip(event.title, LIMITS.maxTitleChars), options: [] },
			};
		case "editor":
			// A dialog we cannot show must not hang the agent: the server cancels it.
			return { frames: [], cancelUi: event.id };
		default:
			// setStatus / setWidget / setTitle / set_editor_text: UI chrome, dropped.
			return none;
	}
}

/** Validates an answer against its pending ask; returns the Pi extension_ui_response or undefined. */
function buildUiResponse(ask, answer) {
	if (answer.cancelled === true) return { type: "extension_ui_response", id: ask.id, cancelled: true };
	if (ask.kind === "confirm") {
		return typeof answer.confirmed === "boolean" ? { type: "extension_ui_response", id: ask.id, confirmed: answer.confirmed } : undefined;
	}
	if (typeof answer.value !== "string") return undefined;
	if (ask.kind === "select" && !ask.options.includes(answer.value)) return undefined;
	return { type: "extension_ui_response", id: ask.id, value: answer.value };
}

module.exports = {
	PROTOCOL,
	LIMITS,
	validateClientFrame,
	validateLocalBaseUrl,
	validateCustomBaseUrl,
	validateLocalModelIds,
	decodeClientLine,
	encodeServerFrame,
	errorFrame,
	accountDto,
	providerDto,
	modelDto,
	profileDto,
	accountFrame,
	settingsFrame,
	authStateFrame,
	connectorsFrame,
	mcpImportFrame,
	sessionsFrame,
	pendingFrame,
	agentsFrame,
	hooksFrame,
	HOOK_CLIENT_IDS,
	AGENT_IDS,
	CONNECTORS_EMIT,
	MCP_IMPORT_EMIT,
	SESSIONS_EMIT,
	accountsFrame,
	providersFrame,
	modelsFrame,
	profilesFrame,
	authPromptFrame,
	authEventFrame,
	authDoneFrame,
	translateEvent,
	buildUiResponse,
};
