"use strict";

/**
 * Abito island user config (U4): `<island>/config.json`.
 *
 * Fail-closed loader/validator. Unknown keys, wrong types and unsafe values
 * are rejected with a generic `invalid config: <field>` error that never
 * echoes the offending value. The file itself must be a private (no group or
 * other bits), regular, non-symlink file owned by the current user; it is
 * written only through `writePrivateFile` (atomic, 0600).
 *
 * Schema (all optional):
 *   workspace      absolute existing directory (see validateWorkspace)
 *   command        executable name or absolute path, default "pi"
 *   thinking       default thinking level (profiles.cjs THINKING_LEVELS)
 *   profile        saved profile id activated at daemon start
 *   mcpConfigPath  absolute path of a private MCP source file (projectMcpConfig)
 *   connectorsCommand  connectors CLI: ABSOLUTE normalized path of the installed binary; NO default (unset => connectors_list is "unavailable", nothing executes)
 *   connectorsDir      absolute clean directory read by the connectors CLI, default <island>/connectors (0700, created on first use)
 *   hookInstallerBin   ABSOLUTE normalized path of apps/desktop-harness/bin/abito-hook.cjs; NO default (unset => every agent is "unavailable", nothing executes)
 *   connectorHostBin   ABSOLUTE normalized path of the abito-connector-host binary; NO default (unset => no host is spawned)
 *   hotkey         global show/hide combo, e.g. "Ctrl+Alt+Space" (validateHotkey); stored only, never captured here
 *   paused         global pause switch (#379): strict boolean, false when absent; stored only, restored at the next boot
 *   rotation       continuous conversation rotation (#386): object with optional subkeys
 *                  `enabled` (strict boolean, default FALSE: opt-in), `thresholdPercent` (50..100,
 *                  default 85) and `keepTurns` (1..100, default 12); unknown subkeys are rejected
 *
 * `ABITO_WORKSPACE` (the Abito analogue of Gentle Dot's GENTLE_DOT_WORKSPACE)
 * overrides the file's workspace and is validated the same way.
 */

const fs = require("node:fs");
const path = require("node:path");

const { MEMORY_PROJECT, assertSecurePath, islandPaths, writePrivateFile } = require("./isolation.cjs");
const { THINKING_LEVELS, isStrictProfileId } = require("./profiles.cjs");

const WORKSPACE_ENV = "ABITO_WORKSPACE";
const ALLOWED_KEYS = ["workspace", "command", "thinking", "profile", "mcpConfigPath", "hotkey", "paused", "connectorsCommand", "connectorsDir", "hookInstallerBin", "connectorHostBin", "rotation"];
const DEFAULT_COMMAND = "pi";
const MAX_CONFIG_BYTES = 16 * 1024;
const MAX_MCP_BYTES = 64 * 1024;

class ConfigError extends Error {
	constructor(field) {
		super(`invalid config: ${field}`);
		this.name = "ConfigError";
		this.field = field;
	}
}

const uid = () => (typeof process.getuid === "function" ? process.getuid() : undefined);

function isAbsoluteClean(value) {
	if (typeof value !== "string" || value === "" || value.length > 4096) return false;
	if (value.includes("\0") || !path.isAbsolute(value)) return false;
	return !value.split(path.sep).includes("..");
}

/**
 * A workspace is accepted only when it is an absolute path without `..`, an
 * existing directory owned by the current user, with NO symlink anywhere in
 * the path (realpath equals the path), and not the island root or anything
 * inside it — except the island's owned default workspace.
 * Returns the validated path; throws ConfigError(field) otherwise.
 */
function validateWorkspace(value, islandRoot, field = "workspace") {
	if (!isAbsoluteClean(value)) throw new ConfigError(field);
	const resolved = path.resolve(value);
	let stats;
	let real;
	try {
		stats = fs.lstatSync(resolved);
		real = fs.realpathSync(resolved);
	} catch {
		throw new ConfigError(field);
	}
	if (stats.isSymbolicLink() || !stats.isDirectory() || real !== resolved) throw new ConfigError(field);
	if (uid() !== undefined && stats.uid !== uid()) throw new ConfigError(field);
	const paths = islandPaths(islandRoot);
	let realRoot = paths.root;
	try {
		realRoot = fs.realpathSync(paths.root);
	} catch {}
	const within = (base) => resolved === base || resolved.startsWith(`${base}${path.sep}`);
	const isDefault = within(paths.workspace) || within(path.join(realRoot, "workspace"));
	if ((within(paths.root) || within(realRoot)) && !isDefault) throw new ConfigError(field);
	return resolved;
}

function validateCommand(value) {
	if (typeof value !== "string" || value.length === 0 || value.length > 4096) throw new ConfigError("command");
	if (path.isAbsolute(value)) {
		if (!/^\/[A-Za-z0-9._+\-/]+$/.test(value) || value.split("/").includes("..")) throw new ConfigError("command");
	} else if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(value)) {
		throw new ConfigError("command");
	}
	return value;
}

/**
 * `connectorsCommand`: an absolute, normalized path (`path.normalize(x) === x`, no `..`, no shell
 * metacharacters). Bare names are refused: resolving them through PATH would let a planted binary run.
 * The configured binary is TRUSTED code executed as the user (config.json is 0600, fail-closed);
 * spawn-time checks live in connectors.cjs. Never a shell string; spawned with shell:false.
 */
function validateConnectorsCommand(value) {
	if (typeof value !== "string" || value.length === 0 || value.length > 4096) throw new ConfigError("connectorsCommand");
	if (!path.isAbsolute(value) || !/^\/[A-Za-z0-9._+\-/]+$/.test(value) || path.normalize(value) !== value || value.endsWith("/")) throw new ConfigError("connectorsCommand");
	if (value.split("/").some((part) => part === ".." || part === ".")) throw new ConfigError("connectorsCommand");
	return value;
}

/**
 * `hookInstallerBin`: absolute, normalized path of the Abito hook installer script (run with node by
 * agents.cjs: [node, script, ...args], shell:false). Same shape rules as connectorsCommand; the use-time
 * trust check (regular non-symlink file, owner, not group/world-writable, secure parents) lives in agents.cjs.
 */
function validateHookInstallerBin(value) {
	if (typeof value !== "string" || value.length === 0 || value.length > 4096) throw new ConfigError("hookInstallerBin");
	if (!path.isAbsolute(value) || !/^\/[A-Za-z0-9._+\-/]+$/.test(value) || path.normalize(value) !== value || value.endsWith("/")) throw new ConfigError("hookInstallerBin");
	if (value.split("/").some((part) => part === ".." || part === ".")) throw new ConfigError("hookInstallerBin");
	return value;
}

/** `connectorHostBin`: absolute normalized executable path; trust is checked before every spawn. */
function validateConnectorHostBin(value) {
	if (typeof value !== "string" || value.length === 0 || value.length > 4096) throw new ConfigError("connectorHostBin");
	if (!path.isAbsolute(value) || !/^\/[A-Za-z0-9._+\-/]+$/.test(value) || path.normalize(value) !== value || value.endsWith("/")) throw new ConfigError("connectorHostBin");
	if (value.split("/").some((part) => part === ".." || part === ".")) throw new ConfigError("connectorHostBin");
	return value;
}

/** `connectorsDir`: absolute, clean (no `..`, no NUL, normalized). Existence/ownership is enforced at first use. */
function validateConnectorsDir(value) {
	if (!isAbsoluteClean(value) || path.normalize(value) !== value) throw new ConfigError("connectorsDir");
	return path.resolve(value);
}

// ----- hotkey -------------------------------------------------------------------

const HOTKEY_MODIFIERS = ["Ctrl", "Alt", "Shift", "Super"]; // canonical order
const HOTKEY_NAMED_KEYS = ["Space", "Enter", "Tab", "Escape", "Backspace", "Delete", "Insert", "Home", "End", "PageUp", "PageDown", "Up", "Down", "Left", "Right"];
const MAX_HOTKEY_CHARS = 40;

/**
 * Strict global-hotkey grammar: 1+ distinct modifiers (Ctrl, Alt, Shift,
 * Super; case-insensitive) joined by '+', then exactly one key: an ASCII
 * letter/digit, F1-F24 or a named key. Returns the canonical string
 * (modifiers in Ctrl+Alt+Shift+Super order); throws ConfigError("hotkey")
 * without echoing the input.
 */
function validateHotkey(value) {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_HOTKEY_CHARS) throw new ConfigError("hotkey");
	if (!/^[A-Za-z0-9+]+$/.test(value)) throw new ConfigError("hotkey"); // no whitespace, control or non-ASCII
	const parts = value.split("+");
	if (parts.length < 2) throw new ConfigError("hotkey"); // a bare key is refused
	const key = parts.pop();
	const seen = new Set();
	for (const part of parts) {
		const modifier = HOTKEY_MODIFIERS.find((m) => m.toLowerCase() === part.toLowerCase());
		if (!modifier || seen.has(modifier)) throw new ConfigError("hotkey");
		seen.add(modifier);
	}
	let canonicalKey;
	if (/^[A-Za-z0-9]$/.test(key)) canonicalKey = key.toUpperCase();
	else if (/^[Ff]([1-9]|1[0-9]|2[0-4])$/.test(key)) canonicalKey = `F${key.slice(1)}`;
	else canonicalKey = HOTKEY_NAMED_KEYS.find((k) => k.toLowerCase() === key.toLowerCase());
	if (!canonicalKey) throw new ConfigError("hotkey");
	return [...HOTKEY_MODIFIERS.filter((m) => seen.has(m)), canonicalKey].join("+");
}

/** Reads a private JSON object file; `null` when absent. Throws ConfigError(field) otherwise. */
function readPrivateJson(file, field, maxBytes) {
	let stats;
	try {
		stats = fs.lstatSync(file);
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw new ConfigError(field);
	}
	if (stats.isSymbolicLink() || !stats.isFile() || stats.size > maxBytes) throw new ConfigError(field);
	if ((stats.mode & 0o077) !== 0 || (uid() !== undefined && stats.uid !== uid())) throw new ConfigError(field);
	let value;
	try {
		value = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		throw new ConfigError(field);
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ConfigError(field);
	return value;
}

/** #386 rotation defaults: disabled until the user opts in. */
const ROTATION_DEFAULTS = { enabled: false, thresholdPercent: 85, keepTurns: 12 };

/**
 * #386 `rotation`: strict object with known optional subkeys only — `enabled`
 * (strict boolean), `thresholdPercent` (50..100) and `keepTurns` (1..100).
 * Unknown or mistyped subkeys are a config error, never a silent flip.
 */
function validateRotation(raw) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError("rotation");
	for (const key of Object.keys(raw)) if (key !== "enabled" && key !== "thresholdPercent" && key !== "keepTurns") throw new ConfigError("rotation");
	const out = {};
	if (raw.enabled !== undefined) {
		if (typeof raw.enabled !== "boolean") throw new ConfigError("rotation");
		out.enabled = raw.enabled;
	}
	for (const [key, min, max] of [["thresholdPercent", 50, 100], ["keepTurns", 1, 100]]) {
		if (raw[key] === undefined) continue;
		if (!Number.isSafeInteger(raw[key]) || raw[key] < min || raw[key] > max) throw new ConfigError("rotation");
		out[key] = raw[key];
	}
	return out;
}

/** The raw, validated file content (no defaults, no env). */
function readConfigFile(islandRoot) {
	// Same parent-chain policy as writes: no symlinked/world-writable/foreign-owned island path.
	try {
		assertSecurePath(path.dirname(islandPaths(islandRoot).configFile));
	} catch {
		throw new ConfigError("config.json");
	}
	const raw = readPrivateJson(islandPaths(islandRoot).configFile, "config.json", MAX_CONFIG_BYTES);
	if (raw === null) return {};
	for (const key of Object.keys(raw)) if (!ALLOWED_KEYS.includes(key)) throw new ConfigError(key);
	const out = {};
	if (raw.workspace !== undefined) out.workspace = validateWorkspace(raw.workspace, islandRoot, "workspace");
	if (raw.command !== undefined) out.command = validateCommand(raw.command);
	if (raw.thinking !== undefined) {
		if (typeof raw.thinking !== "string" || !THINKING_LEVELS.includes(raw.thinking)) throw new ConfigError("thinking");
		out.thinking = raw.thinking;
	}
	if (raw.profile !== undefined) {
		if (typeof raw.profile !== "string" || !isStrictProfileId(raw.profile)) throw new ConfigError("profile");
		out.profile = raw.profile;
	}
	if (raw.mcpConfigPath !== undefined) {
		if (!isAbsoluteClean(raw.mcpConfigPath)) throw new ConfigError("mcpConfigPath");
		out.mcpConfigPath = raw.mcpConfigPath;
	}
	if (raw.connectorsCommand !== undefined) out.connectorsCommand = validateConnectorsCommand(raw.connectorsCommand);
	if (raw.connectorsDir !== undefined) out.connectorsDir = validateConnectorsDir(raw.connectorsDir);
	if (raw.hookInstallerBin !== undefined) out.hookInstallerBin = validateHookInstallerBin(raw.hookInstallerBin);
	if (raw.paused !== undefined) {
		// Strict boolean like the other keys: a hand-edited non-boolean is a config error, never a silent flip.
		if (typeof raw.paused !== "boolean") throw new ConfigError("paused");
		out.paused = raw.paused;
	}
	if (raw.rotation !== undefined) out.rotation = validateRotation(raw.rotation);
	if (raw.connectorHostBin !== undefined) out.connectorHostBin = validateConnectorHostBin(raw.connectorHostBin);
	if (raw.hotkey !== undefined) {
		// Inert metadata: an invalid value must never lock the user out of recovery. Drop it, flag it.
		try {
			out.hotkey = validateHotkey(raw.hotkey);
		} catch {
			out.hotkeyInvalid = true;
		}
	}
	return out;
}

/** Effective config: file values, defaults, and the ABITO_WORKSPACE override (which wins). */
function loadConfig(islandRoot, options = {}) {
	const env = options.env ?? process.env;
	const file = readConfigFile(islandRoot);
	const cfg = {
		command: file.command ?? DEFAULT_COMMAND,
		thinking: file.thinking,
		profile: file.profile,
		mcpConfigPath: file.mcpConfigPath,
		hotkey: file.hotkey,
		paused: file.paused === true,
		connectorsCommand: file.connectorsCommand,
		hookInstallerBin: file.hookInstallerBin,
		connectorHostBin: file.connectorHostBin,
		connectorsDir: file.connectorsDir ?? path.join(islandPaths(islandRoot).root, "connectors"),
		rotation: { ...ROTATION_DEFAULTS, ...(file.rotation ?? {}) },
		...(file.hotkeyInvalid ? { hotkeyInvalid: true } : {}),
		workspace: islandPaths(islandRoot).workspace,
		workspaceSource: "default",
	};
	if (file.workspace) {
		cfg.workspace = file.workspace;
		cfg.workspaceSource = "file";
	}
	const fromEnv = env[WORKSPACE_ENV];
	if (typeof fromEnv === "string" && fromEnv !== "") {
		cfg.workspace = validateWorkspace(fromEnv, islandRoot, WORKSPACE_ENV);
		cfg.workspaceSource = "env";
	}
	return cfg;
}

/**
 * Persists a new workspace atomically (merging the other keys, 0600) and
 * returns `{workspace, changed, restartRequired:true, overriddenByEnv}`.
 *
 * Restart semantics: the running engine keeps its old cwd until restarted
 * (Daemon.applyConfig does it). When the workspace changes, the pointer in
 * `state.json` is reset so the new engine NEVER reopens a session created for
 * the old workspace; the old session files stay in `<island>/sessions`.
 * Validation happens before any write, so a rejected path changes nothing.
 */
function setWorkspace(islandRoot, workspace, options = {}) {
	const env = options.env ?? process.env;
	const next = validateWorkspace(workspace, islandRoot, "workspace");
	const paths = islandPaths(islandRoot);
	const { hotkeyInvalid, ...current } = readConfigFile(islandRoot);
	const changed = current.workspace !== next || hotkeyInvalid === true;
	const overriddenByEnv = typeof env[WORKSPACE_ENV] === "string" && env[WORKSPACE_ENV] !== "";
	if (changed) {
		writePrivateFile(paths.configFile, `${JSON.stringify({ ...current, workspace: next }, null, 2)}\n`);
		// Under an env override the effective workspace does not move: keep the session.
		if (!overriddenByEnv && current.workspace !== next) clearSessionPointer(islandRoot);
	}
	return { workspace: next, changed: current.workspace !== next, restartRequired: true, overriddenByEnv };
}

/**
 * Persists the global hotkey (canonical form; null removes the key), merging
 * the other keys, atomically with 0600. Validation precedes any write.
 * No engine restart is involved. Returns `{hotkey: string|null, changed}`.
 */
function setHotkey(islandRoot, hotkey) {
	const next = hotkey === null ? null : validateHotkey(hotkey);
	const { hotkeyInvalid, hotkey: _old, ...rest } = readConfigFile(islandRoot);
	const changed = (_old ?? null) !== next;
	if (changed || hotkeyInvalid === true) {
		writePrivateFile(islandPaths(islandRoot).configFile, `${JSON.stringify(next === null ? rest : { ...rest, hotkey: next }, null, 2)}\n`);
	}
	return { hotkey: next, changed };
}

/**
 * Persists the global pause switch (#379), merging the other keys, atomically with 0600.
 * A strict boolean is required. No engine restart is involved. Returns `{paused, changed}`;
 * `paused:false` removes the key. Validation precedes any write.
 */
function setPaused(islandRoot, value) {
	if (typeof value !== "boolean") throw new ConfigError("paused");
	const { hotkeyInvalid, paused: _old, ...current } = readConfigFile(islandRoot);
	const changed = (_old === true) !== value;
	if (changed || hotkeyInvalid === true) {
		writePrivateFile(islandPaths(islandRoot).configFile, `${JSON.stringify(value ? { ...current, paused: true } : current, null, 2)}\n`);
	}
	return { paused: value, changed };
}

/** Forgets the persisted session pointer (overwrites `state.json`, never deletes the session itself). */
function clearSessionPointer(islandRoot) {
	writePrivateFile(path.join(islandPaths(islandRoot).root, "state.json"), "{}\n");
}

/**
 * READ-ONLY: true when `<workspace>/.engram/config.json` names a memory
 * project other than the Abito pin. The daemon never writes `.engram` into a
 * user folder; the pin for such folders is `ABITO_MEMORY_PROJECT` + identity,
 * so the conflict is surfaced as a status warning instead.
 */
function detectMemoryPinConflict(workspace) {
	const file = path.join(workspace, ".engram", "config.json");
	try {
		const stats = fs.lstatSync(file);
		if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_CONFIG_BYTES) return false;
		const value = JSON.parse(fs.readFileSync(file, "utf8"));
		return typeof value?.project_name === "string" && value.project_name !== MEMORY_PROJECT;
	} catch {
		return false;
	}
}

// ----- MCP projection ---------------------------------------------------------

const MCP_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MCP_BEARER = /^Bearer [A-Za-z0-9._~+/=-]{8,512}$/;
const FORBIDDEN_IDS = new Set(["__proto__", "constructor", "prototype"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function projectEntry(entry) {
	if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return undefined;
	for (const key of Object.keys(entry)) if (!["type", "url", "headers"].includes(key)) return undefined;
	if (entry.type !== undefined && entry.type !== "http" && entry.type !== "streamable-http") return undefined;
	if (typeof entry.url !== "string" || entry.url.length > 2048 || /\s/.test(entry.url)) return undefined;
	let url;
	try {
		url = new URL(entry.url);
	} catch {
		return undefined;
	}
	if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password) return undefined;
	const headers = entry.headers;
	if (headers === null || typeof headers !== "object" || Array.isArray(headers)) return undefined;
	const names = Object.keys(headers);
	if (names.length !== 1 || names[0] !== "Authorization") return undefined;
	if (typeof headers.Authorization !== "string" || !MCP_BEARER.test(headers.Authorization)) return undefined;
	return { type: "http", url: url.href, headers: { Authorization: headers.Authorization } };
}

/**
 * Validated projection of a private MCP source file into the only shape the
 * island accepts: proxy-only entries `{type:"http", url:<loopback>, headers:
 * {Authorization:"Bearer <capability>"}}`. Anything else (command/env/args/
 * cwd/oauth, non-loopback URL, credentials in the URL, other headers, header
 * indirection such as `${VAR}` or `!cmd`, other top-level keys) rejects the
 * WHOLE file.
 */
function projectMcpConfig(file) {
	const raw = readPrivateJson(file, "mcpConfigPath", MAX_MCP_BYTES);
	if (raw === null) throw new ConfigError("mcpConfigPath");
	const keys = Object.keys(raw);
	if (keys.length !== 1 || keys[0] !== "mcpServers") throw new ConfigError("mcpConfigPath");
	const servers = raw.mcpServers;
	if (servers === null || typeof servers !== "object" || Array.isArray(servers)) throw new ConfigError("mcpConfigPath");
	const out = Object.create(null);
	for (const [id, entry] of Object.entries(servers)) {
		const projected = MCP_ID.test(id) && !FORBIDDEN_IDS.has(id) ? projectEntry(entry) : undefined;
		if (!projected) throw new ConfigError("mcpConfigPath");
		out[id] = projected;
	}
	return { mcpServers: out };
}

/**
 * Writes the projection to `<island>/agent/mcp.json` — the user-level MCP file
 * of the engine's private pi agent dir (`PI_CODING_AGENT_DIR`), which pi reads
 * natively (see docs/mcp.md). With no source it writes an empty projection so
 * a stale one never lingers.
 */
function writeMcpProjection(islandRoot, sourceFile) {
	const projection = sourceFile ? projectMcpConfig(sourceFile) : { mcpServers: {} };
	const target = path.join(islandPaths(islandRoot).agentDir, "mcp.json");
	writePrivateFile(target, `${JSON.stringify(projection, null, 2)}\n`);
	return projection;
}

/**
 * Removes <agent>/mcp.json (it holds the MCP Bearer capability) only when it is a
 * regular, non-symlink file owned by this user. Synchronous, never throws.
 * Returns true when a file was unlinked.
 */
function removeMcpProjection(islandRoot) {
	try {
		const target = path.join(islandPaths(islandRoot).agentDir, "mcp.json");
		const stats = fs.lstatSync(target);
		if (!stats.isFile() || stats.isSymbolicLink()) return false;
		if (uid() !== undefined && stats.uid !== uid()) return false;
		fs.unlinkSync(target);
		return true;
	} catch {
		return false;
	}
}

module.exports = {
	ConfigError,
	DEFAULT_COMMAND,
	WORKSPACE_ENV,
	clearSessionPointer,
	detectMemoryPinConflict,
	loadConfig,
	projectMcpConfig,
	readConfigFile,
	removeMcpProjection,
	setHotkey,
	setPaused,
	setWorkspace,
	validateCommand,
	validateConnectorsCommand,
	validateConnectorsDir,
	validateHookInstallerBin,
	validateConnectorHostBin,
	validateHotkey,
	validateWorkspace,
	writeMcpProjection,
};
