"use strict";

/**
 * Read-only MCP config import preview (#381, GD016): scans the KNOWN config locations of
 * other desktop clients (Claude Desktop, Claude Code, Cursor, VS Code) and maps their MCP
 * server entries to a bounded preview DTO the UI can show before an explicit accept.
 *
 * Nothing here writes, executes, spawns or resolves anything: it only reads the user's own
 * config files (≤ maxFileBytes, valid UTF-8) and never emits env values, header values,
 * args, file contents or paths. Semantics mirror the pure importer of
 * apps/desktop-connectors (src/import.rs, reference Gentle Dot semantics): transport
 * classification, rejection reasons, `${input:}`/`${env:}`/`${userHome}` handling,
 * whole-document duplicate-key rejection and the per-document entry cap. Per-file problems
 * (malformed JSON, unreadable, too large, too many entries) are reported in `files`,
 * never fatal.
 */

const { lstatSync, readFileSync } = require("node:fs");
const path = require("node:path");

const SCHEMA = "abito-mcp-import/preview/1";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SERVERS = 128;
/** Per document, across all scopes (root + projects), mirroring the Rust importer. */
const MAX_ENTRIES = 200;
const MAX_KEY_LEN = 64;
const MAX_NAME = 128;
const MAX_SCOPE = 256;
const MAX_DEPTH = 512;

/** Control (C0/C1), format (bidi, ZWSP...), line/paragraph separators and lone surrogates. */
const FORBIDDEN_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;
/** Canonical `${input:<key>}` placeholder; key alphabet mirrors find_placeholder in import.rs. */
const PLACEHOLDER = /\$\{input:([A-Za-z0-9_.:-]{1,64})\}/g;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const validText = (v) => typeof v === "string" && v.length > 0 && !FORBIDDEN_TEXT.test(v);

function isEnvName(name) {
	return (
		typeof name === "string" &&
		name.length > 0 &&
		name.length <= MAX_KEY_LEN &&
		/^[A-Za-z_]/.test(name) &&
		/^[A-Za-z0-9_]+$/.test(name)
	);
}

function isInputId(id) {
	return typeof id === "string" && id.length > 0 && id.length <= MAX_KEY_LEN && /^[A-Za-z0-9_.-]+$/.test(id);
}

const strField = (raw, key) => (isObject(raw) && typeof raw[key] === "string" ? raw[key] : undefined);

// --- strict JSON with duplicate-key rejection --------------------------------
// JSON.parse silently keeps the last of repeated object keys; a repeated key makes the
// effective document ambiguous, so the whole document is rejected instead.

function parseStrictJson(text) {
	let i = 0;
	const fail = () => {
		throw new SyntaxError("invalid json");
	};
	const ws = () => {
		while (i < text.length) {
			const c = text.charCodeAt(i);
			if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
			else break;
		}
	};
	const string = () => {
		// at text[i] === '"'
		let out = "";
		i++;
		for (;;) {
			if (i >= text.length) fail();
			const c = text[i];
			if (c === '"') {
				i++;
				return out;
			}
			if (c === "\\") {
				const e = text[i + 1];
				if (e === '"' || e === "\\" || e === "/") {
					out += e;
					i += 2;
				} else if (e === "b" || e === "f" || e === "n" || e === "r" || e === "t") {
					out += { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }[e];
					i += 2;
				} else if (e === "u") {
					const hex = text.slice(i + 2, i + 6);
					if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail();
					out += String.fromCharCode(parseInt(hex, 16));
					i += 6;
				} else fail();
			} else if (text.charCodeAt(i) < 0x20) fail();
			else {
				out += c;
				i++;
			}
		}
	};
	const NUM = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
	const number = () => {
		NUM.lastIndex = i;
		const m = NUM.exec(text);
		if (!m) fail();
		i += m[0].length;
		return Number(m[0]);
	};
	const value = (depth) => {
		if (depth > MAX_DEPTH) fail();
		ws();
		if (i >= text.length) fail();
		const c = text[i];
		if (c === "{") {
			i++;
			const obj = {};
			const seen = new Set();
			ws();
			if (text[i] === "}") {
				i++;
				return obj;
			}
			for (;;) {
				ws();
				if (text[i] !== '"') fail();
				const key = string();
				ws();
				if (text[i] !== ":") fail();
				i++;
				if (seen.has(key)) fail();
				seen.add(key);
				Object.defineProperty(obj, key, {
					value: value(depth + 1),
					writable: true,
					enumerable: true,
					configurable: true,
				});
				ws();
				if (text[i] === ",") {
					i++;
					continue;
				}
				if (text[i] === "}") {
					i++;
					return obj;
				}
				fail();
			}
		}
		if (c === "[") {
			i++;
			const arr = [];
			ws();
			if (text[i] === "]") {
				i++;
				return arr;
			}
			for (;;) {
				arr.push(value(depth + 1));
				ws();
				if (text[i] === ",") {
					i++;
					continue;
				}
				if (text[i] === "]") {
					i++;
					return arr;
				}
				fail();
			}
		}
		if (c === '"') return string();
		if (text.startsWith("true", i)) {
			i += 4;
			return true;
		}
		if (text.startsWith("false", i)) {
			i += 5;
			return false;
		}
		if (text.startsWith("null", i)) {
			i += 4;
			return null;
		}
		return number();
	};
	const out = value(0);
	ws();
	if (i !== text.length) fail();
	return out;
}

// --- reference semantics (mirrors import.rs) ---------------------------------

function replaceBraced(text, f) {
	let out = "";
	let rest = text;
	for (;;) {
		const idx = rest.indexOf("${");
		if (idx === -1) return out + rest;
		out += rest.slice(0, idx);
		const after = rest.slice(idx);
		const close = after.indexOf("}");
		if (close === -1) return out + after;
		const replacement = f(after.slice(2, close));
		out += replacement ?? after.slice(0, close + 1);
		rest = after.slice(close + 1);
	}
}

/**
 * Builds the fields list: registered setup fields (from value conversion) win; every
 * unresolved placeholder key without a registration falls back to the default secret
 * field. Keys are sorted and deduplicated (BTreeSet semantics).
 */
function finishEntry(source, name, scope, transport, emitted, values, fields) {
	const keys = new Set();
	for (const v of values) {
		for (const m of v.matchAll(PLACEHOLDER)) keys.add(m[1]);
	}
	const head = scope === undefined ? { source, name } : { source, name, scope };
	if (keys.size === 0) return { ...head, transport, ...emitted, status: "ready" };
	const out = [];
	for (const key of [...keys].sort()) {
		const found = fields.find((f) => f.key === key);
		out.push(found ?? { key, label: key, secret: true, optional: false });
	}
	return { ...head, transport, ...emitted, status: "needs_setup", fields: out };
}

function registerField(fields, key, label, secret, optional) {
	if (!fields.some((f) => f.key === key)) fields.push({ key, label, secret, optional });
}

/** VS Code `inputs` array: labels/secret flags for `${input:}` placeholders. */
function parseInputs(value) {
	if (!Array.isArray(value)) return undefined;
	const out = new Map();
	for (const item of value) {
		if (!isObject(item)) return undefined; // one bad member invalidates all inputs
		const id = typeof item.id === "string" ? item.id : undefined;
		if (id === undefined || !isInputId(id)) continue;
		const label = typeof item.description === "string" && item.description !== "" ? item.description : id;
		const secret = typeof item.password === "boolean" ? item.password : true;
		out.set(id, { label, secret });
	}
	return out;
}

function validHttpUrl(url) {
	const rest = url.startsWith("https://") ? url.slice(8) : url.startsWith("http://") ? url.slice(7) : undefined;
	return rest !== undefined && rest !== "" && !/[\p{Cc}\p{Zs}\p{Zl}\p{Zp}]/u.test(rest);
}

/** R21: the preview shows scheme, host and path only: userinfo, query and fragment may carry secrets. */
function redactUrl(url) {
	const idx = url.indexOf("://");
	const scheme = url.slice(0, idx + 3);
	const rest = url.slice(idx + 3);
	const cut = rest.search(/[/?#]/);
	let authority = cut === -1 ? rest : rest.slice(0, cut);
	let tail = cut === -1 ? "" : rest.slice(cut);
	authority = authority.slice(authority.lastIndexOf("@") + 1);
	tail = tail.replace(/[?#].*$/s, "");
	return scheme + authority + tail;
}

const SECRET_FLAG = /^(-{0,2}[\w.-]*(?:token|key|secret|passw|auth|bearer|credential)[\w.-]*)=(.+)$/i;
const SECRET_FLAG_NAME = /^-{1,2}[\w.-]*(?:token|key|secret|passw|auth|bearer|credential)[\w.-]*$/i;
const HIGH_ENTROPY = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_-]{24,}$/;

/** R21: mask inline secrets of a stdio command (`--token=x`, a flag's next word, long random words). */
function maskCommand(command) {
	const words = command.split(/(\s+)/);
	let maskNext = false;
	return words
		.map((w) => {
			if (/^\s*$/.test(w)) return w;
			if (maskNext) {
				maskNext = false;
				return "***";
			}
			const m = SECRET_FLAG.exec(w);
			if (m) return `${m[1]}=***`;
			if (SECRET_FLAG_NAME.test(w)) {
				maskNext = true;
				return w;
			}
			return HIGH_ENTROPY.test(w) ? "***" : w;
		})
		.join("");
}

function isSsePath(url) {
	const idx = url.indexOf("://");
	if (idx === -1) return false;
	const rest = url.slice(idx + 3);
	const m = /[/?#]/.exec(rest);
	let p = "/";
	if (m && m[0] === "/") {
		const after = rest.slice(m.index);
		const end = /[?#]/.exec(after);
		p = end ? after.slice(0, end.index) : after;
	}
	const lower = p.toLowerCase();
	return lower === "/sse" || lower === "/sse/";
}

/**
 * Maps one server entry to its preview DTO (or a rejection). `values` collects every
 * converted configuration string that must be scanned for placeholders but never emitted.
 */
function mapServer(source, name, scope, raw, syntax, inputs, home) {
	const rejected = (reason) => ({ source, name, ...(scope === undefined ? {} : { scope }), status: "rejected", reason });
	if (!isObject(raw)) return rejected("invalid_entry");
	if (!validText(name) || name.length > MAX_NAME) return rejected("invalid_entry");
	if (scope !== undefined && (!validText(scope) || scope.length > MAX_SCOPE)) return rejected("invalid_entry");

	const type = typeof raw.type === "string" ? raw.type : undefined;
	let command = strField(raw, "command");
	if (command !== undefined && command === "") command = undefined;
	let url = strField(raw, "url") ?? strField(raw, "serverUrl");
	if (url !== undefined && url === "") url = undefined;

	if (type === "sse") return rejected("sse_transport");
	if (type !== "http" && type !== "streamable-http" && type !== "stdio" && type !== undefined) {
		return rejected("unsupported_transport");
	}
	if (type === "stdio" && command === undefined) return rejected("invalid_entry");
	if (command !== undefined && url !== undefined) return rejected("conflicting_transports");

	const fields = [];
	const values = [];
	const convertValue = (text) => {
		if (syntax === "literal") return text;
		if (syntax === "claude-code") {
			return replaceBraced(text, (inner) => {
				const envName = inner.split(":-")[0];
				if (!isEnvName(envName)) return null;
				registerField(fields, `env:${envName}`, `Environment variable ${envName}`, true, false);
				return `\${input:env:${envName}}`;
			});
		}
		return replaceBraced(text, (inner) => {
			if (inner.startsWith("env:")) {
				const envName = inner.slice(4);
				if (!isEnvName(envName)) return null;
				registerField(fields, `env:${envName}`, `Environment variable ${envName}`, true, false);
				return `\${input:env:${envName}}`;
			}
			if (inner.startsWith("input:")) {
				const id = inner.slice(6);
				if (!isInputId(id)) return null;
				const desc = inputs?.get(id);
				registerField(fields, id, desc ? desc.label : id, desc ? desc.secret : true, false);
				return `\${input:${id}}`;
			}
			if (inner === "userHome") return home;
			return null;
		});
	};
	// Written values (command, args, cwd): only ${input:} and ${userHome}; env references
	// stay literal, matching the reference semantics.
	const convertRaw = (text) => {
		if (syntax !== "vscode") return text;
		return replaceBraced(text, (inner) => {
			if (inner.startsWith("input:")) {
				const id = inner.slice(6);
				if (!isInputId(id)) return null;
				const desc = inputs?.get(id);
				registerField(fields, id, desc ? desc.label : id, desc ? desc.secret : true, false);
				return `\${input:${id}}`;
			}
			if (inner === "userHome") return home;
			return null;
		});
	};

	if (command !== undefined) {
		if (type !== undefined && type !== "stdio") return rejected("unsupported_transport");
		let args;
		if (raw.args === undefined) args = [];
		else if (Array.isArray(raw.args)) {
			args = [];
			for (const item of raw.args) {
				if (typeof item !== "string") return rejected("invalid_entry");
				args.push(item);
			}
		} else return rejected("invalid_entry");
		const convertedCommand = convertRaw(command);
		if (!validText(convertedCommand)) return rejected("invalid_entry");
		values.push(convertedCommand);
		for (const a of args) values.push(convertRaw(a));
		if (typeof raw.cwd === "string" && raw.cwd !== "") values.push(convertRaw(raw.cwd));
		if (raw.env !== undefined) {
			if (!isObject(raw.env)) return rejected("invalid_entry");
			for (const [key, v] of Object.entries(raw.env)) {
				if (typeof v !== "string") return rejected("invalid_entry");
				if (!isEnvName(key.replace(/-/g, "_"))) return rejected("invalid_entry");
				values.push(convertValue(v));
			}
		}
		return finishEntry(source, name, scope, "stdio", { command: maskCommand(convertedCommand) }, values, fields);
	}

	if (url !== undefined) {
		if (type !== undefined && type !== "http" && type !== "streamable-http") return rejected("unsupported_transport");
		if (!validHttpUrl(url)) return rejected("invalid_entry");
		if (!validText(url)) return rejected("invalid_entry");
		if (type === undefined && isSsePath(url)) return rejected("sse_transport");
		if (raw.headers !== undefined) {
			if (!isObject(raw.headers)) return rejected("invalid_entry");
			for (const v of Object.values(raw.headers)) {
				if (typeof v !== "string") return rejected("invalid_entry");
				values.push(convertValue(v));
			}
		}
		// The url is kept verbatim (reference semantics: it is never converted).
		values.push(url);
		return finishEntry(source, name, scope, "http", { url: redactUrl(url) }, values, fields);
	}

	return rejected("invalid_entry");
}

/** Where each client keeps its MCP config, per supported platform. */
const LOCATIONS = Object.freeze({
	linux: Object.freeze([
		{ source: "claude-desktop", rel: ".config/Claude/claude_desktop_config.json" },
		{ source: "claude-code", rel: ".claude.json" },
		{ source: "cursor", rel: ".cursor/mcp.json" },
		{ source: "vscode", rel: ".config/Code/User/mcp.json" },
	]),
	darwin: Object.freeze([
		{ source: "claude-desktop", rel: "Library/Application Support/Claude/claude_desktop_config.json" },
		{ source: "claude-code", rel: ".claude.json" },
		{ source: "cursor", rel: ".cursor/mcp.json" },
		{ source: "vscode", rel: "Library/Application Support/Code/User/mcp.json" },
	]),
});

/** Extracts the `mcpServers`-style map of a document for one client; undefined when absent. */
function serversMap(root, keys) {
	let node = root;
	for (const key of keys) {
		if (!isObject(node)) return undefined;
		node = node[key];
	}
	return isObject(node) ? node : undefined;
}

/** Maps one document to `{ status, servers }`; status is "ok" or a per-file problem code. */
function mapDocument(source, text, ctx) {
	let root;
	try {
		root = parseStrictJson(text);
	} catch {
		return { status: "malformed", servers: [] };
	}
	if (!isObject(root)) return { status: "malformed", servers: [] };

	const groups = [];
	let inputs;
	switch (source) {
		case "claude-desktop":
			groups.push({ scope: undefined, map: serversMap(root, ["mcpServers"]), syntax: "literal" });
			break;
		case "claude-code": {
			groups.push({ scope: undefined, map: serversMap(root, ["mcpServers"]), syntax: "claude-code" });
			const projects = serversMap(root, ["projects"]);
			if (projects !== undefined) {
				for (const [key, project] of Object.entries(projects)) {
					groups.push({ scope: key, map: serversMap(project, ["mcpServers"]), syntax: "claude-code" });
				}
			}
			break;
		}
		case "cursor":
			groups.push({ scope: undefined, map: serversMap(root, ["mcpServers"]), syntax: "vscode" });
			break;
		case "vscode": {
			const mcp = isObject(root.mcp) ? root.mcp : undefined;
			const map = serversMap(root, ["servers"]) ?? serversMap(root, ["mcp", "servers"]);
			const rawInputs = root.inputs ?? (mcp && mcp.inputs);
			inputs = parseInputs(rawInputs);
			groups.push({ scope: undefined, map, syntax: "vscode" });
			break;
		}
		default:
			return { status: "malformed", servers: [] };
	}

	const total = groups.reduce((n, g) => n + (g.map ? Object.keys(g.map).length : 0), 0);
	if (total > MAX_ENTRIES) return { status: "too_many", servers: [] };

	const servers = [];
	for (const g of groups) {
		if (!g.map) continue;
		for (const [name, raw] of Object.entries(g.map)) {
			servers.push(mapServer(source, name, g.scope, raw, g.syntax, inputs, ctx.home));
		}
	}
	return { status: "ok", servers };
}

function validateHome(home) {
	if (
		typeof home !== "string" ||
		home.length === 0 ||
		home.length > 4096 ||
		!path.isAbsolute(home) ||
		path.normalize(home) !== home ||
		(home !== path.sep && home.endsWith(path.sep)) ||
		home.split(path.sep).includes("..") ||
		/\p{Cc}/u.test(home)
	) {
		throw new Error("invalid home");
	}
	return home;
}

function boundedOption(value, fallback, name) {
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || value < 1 || value > 1e6) throw new Error(`invalid ${name}`);
	return value;
}

/**
 * Scans the known client config locations under `home` (read-only).
 *
 * @param {object} options
 * @param {string} options.home  absolute, clean user home folder (never read from the environment here)
 * @param {string} [options.platform]  "linux" | "darwin"; anything else scans nothing
 * @param {number} [options.maxFileBytes]  per-file read cap (default 2 MiB); larger files report "too_large"
 * @param {number} [options.maxServers]  preview cap (default 128); exceeding it sets `truncated`
 * @returns {{files: {source: string, status: string}[], servers: object[], truncated: boolean}}
 *   `files` lists only the locations where a file exists ("ok", "malformed", "unreadable",
 *   "too_large", "too_many"); `servers` is the deterministic (source, name, scope) sorted
 *   preview DTO list; `truncated` marks a bounded preview.
 */
function scanMcpConfigs(options = {}) {
	const home = validateHome(options.home);
	const platform = options.platform ?? process.platform;
	const maxFileBytes = boundedOption(options.maxFileBytes, MAX_FILE_BYTES, "maxFileBytes");
	const maxServers = boundedOption(options.maxServers, MAX_SERVERS, "maxServers");

	const files = [];
	let servers = [];
	let truncated = false;
	const locations = LOCATIONS[platform];
	if (!locations) return { files, servers, truncated };

	for (const loc of locations) {
		const file = path.join(home, loc.rel);
		let text;
		try {
			const stat = lstatSync(file); // R22: never follow a symlinked foreign config
			if (stat.isSymbolicLink() || !stat.isFile()) {
				files.push({ source: loc.source, status: "unreadable" });
				continue;
			}
			if (stat.size > maxFileBytes) {
				files.push({ source: loc.source, status: "too_large" });
				continue;
			}
			text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(file));
		} catch (error) {
			if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) continue; // simply absent
			files.push({ source: loc.source, status: "unreadable" });
			continue;
		}
		const mapped = mapDocument(loc.source, text, { home });
		files.push({ source: loc.source, status: mapped.status });
		if (mapped.status === "ok") servers = servers.concat(mapped.servers);
	}

	servers.sort((a, b) =>
		a.source < b.source ? -1 : a.source > b.source ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : (a.scope ?? "") < (b.scope ?? "") ? -1 : (a.scope ?? "") > (b.scope ?? "") ? 1 : 0,
	);
	if (servers.length > maxServers) {
		servers = servers.slice(0, maxServers);
		truncated = true;
	}
	return { files, servers, truncated };
}

// --- strict allowlist rebuild for protocol emission -----------------------------------------

const SOURCES = new Set(["claude-desktop", "claude-code", "cursor", "vscode"]);
const FILE_STATUSES = new Set(["ok", "malformed", "unreadable", "too_large", "too_many"]);
const STATUSES = new Set(["ready", "needs_setup", "rejected"]);
const TRANSPORTS = new Set(["stdio", "http"]);
const REASONS = new Set(["sse_transport", "conflicting_transports", "unsupported_transport", "invalid_entry"]);
const FIELD_KEY = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_FILES = 8;
const MAX_BUILD_SERVERS = 256;
const MAX_VALUE = 1024;

const previewFail = () => {
	throw new Error("mcp import preview invalid");
};
const previewText = (v, max) => {
	if (!validText(v) || v.length > max) previewFail();
	return v;
};

/** Rebuilt per-file results; unknown sources/statuses are rejected. */
function buildFiles(raw) {
	if (!Array.isArray(raw) || raw.length > MAX_FILES) previewFail();
	return raw.map((f) => {
		if (!isObject(f) || !SOURCES.has(f.source) || !FILE_STATUSES.has(f.status)) previewFail();
		return { source: f.source, status: f.status };
	});
}

/** Rebuilt preview entries; wrong types, closed-vocabulary violations and secret-bearing
 * shapes (fields on ready, reasons outside rejections) are rejected, never coerced. */
function buildServers(raw) {
	if (!Array.isArray(raw) || raw.length > MAX_BUILD_SERVERS) previewFail();
	return raw.map((s) => {
		if (!isObject(s) || !SOURCES.has(s.source)) previewFail();
		const out = { source: s.source, name: previewText(s.name, MAX_NAME) };
		if (s.scope !== undefined) out.scope = previewText(s.scope, MAX_SCOPE);
		if (!STATUSES.has(s.status)) previewFail();
		if (s.status === "rejected") {
			if (s.reason === undefined || !REASONS.has(s.reason) || s.transport !== undefined || s.fields !== undefined) previewFail();
			return { ...out, status: "rejected", reason: s.reason };
		}
		if (!TRANSPORTS.has(s.transport) || s.reason !== undefined) previewFail();
		out.transport = s.transport;
		if (s.transport === "stdio") {
			if (s.url !== undefined) previewFail();
			out.command = previewText(s.command, MAX_VALUE);
		} else {
			if (s.command !== undefined) previewFail();
			out.url = previewText(s.url, MAX_VALUE);
		}
		if (s.status === "needs_setup") {
			if (!Array.isArray(s.fields) || s.fields.length < 1 || s.fields.length > 16) previewFail();
			out.fields = s.fields.map((f) => {
				if (!isObject(f) || !FIELD_KEY.test(f.key)) previewFail();
				const field = { key: f.key, label: previewText(f.label, 128) };
				if (typeof f.secret !== "boolean" || typeof f.optional !== "boolean") previewFail();
				field.secret = f.secret;
				field.optional = f.optional;
				return field;
			});
			return { ...out, status: "needs_setup", fields: out.fields };
		}
		if (s.fields !== undefined) previewFail();
		return { ...out, status: "ready" };
	});
}

module.exports = { SCHEMA, scanMcpConfigs, validateHome, buildFiles, buildServers };
