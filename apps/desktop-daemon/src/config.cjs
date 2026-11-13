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
 *   command        executable name or absolute path; default "gentle-shell" (T2:
 *                  resolved by the runtime from Koda's bundled runtime, never PATH)
 *   thinking       default thinking level (profiles.cjs THINKING_LEVELS)
 *   profile        saved profile id activated at daemon start
 *   mcpConfigPath  absolute path of a private MCP source file (projectMcpConfig)
 *   connectorsCommand  connectors CLI: ABSOLUTE normalized path of the installed binary; NO default (unset => connectors_list is "unavailable", nothing executes)
 *   connectorsDir      absolute clean directory read by the connectors CLI, default <island>/connectors (0700, created on first use)
 *   hookInstallerBin   ABSOLUTE normalized path of apps/desktop-harness/bin/koda-hook.cjs; NO default (unset => every agent is "unavailable", nothing executes)
 *   connectorHostBin   ABSOLUTE normalized path of the abito-connector-host binary; NO default (unset => no host is spawned)
 *   hotkey         global show/hide combo, e.g. "Ctrl+Alt+Space" (validateHotkey); stored only, never captured here
 *   paused         global pause switch (#379): strict boolean, false when absent; stored only, restored at the next boot
 *   rotation       continuous conversation rotation (K2-05 T3, Gentle Dot's form): object with
 *                  optional subkeys `enabled` (strict boolean, default TRUE: rotation is on by
 *                  default), `bytes` (1024..2147483647 session-file bytes, default 20 MB) and
 *                  `compactions` (1..1000000, default 10); unknown subkeys are rejected; the env
 *                  KODA_ROTATE_BYTES / KODA_ROTATE_COMPACTIONS overrides win over the file; the
 *                  v0.1.0 #386 keys thresholdPercent/keepTurns are accepted and ignored
 *   transcription  K2-13 (S7, S18) how a Minikoda transcribes videos/audios (minikodas/transcribe-setting.cjs):
 *                  {mode: "local-parakeet"|"remote", language?, remote?: {accountId, model}};
 *                  default {mode: "local-parakeet", language: "es"}; an invalid stored value is a config error.
 *                  S18 (L32): Parakeet is the only local model; a `local-whisper-turbo` stored by an earlier build
 *                  is migrated to {mode: "local-parakeet", language} when the file is read, never rewritten here.
 *
 * `KODA_WORKSPACE` (the Abito analogue of Gentle Dot's GENTLE_DOT_WORKSPACE)
 * overrides the file's workspace and is validated the same way.
 */

const fs = require("node:fs");
const path = require("node:path");

const { DEFAULT_COMMAND } = require("./runtime.cjs");
const { MEMORY_PROJECT, assertSecurePath, islandPaths, writePrivateFile } = require("./isolation.cjs");
const { THINKING_LEVELS, isStrictProfileId } = require("./profiles.cjs");
const { TRANSCRIPTION_DEFAULT, validateTranscriptionSetting, migrateTranscriptionSetting } = require("./minikodas/transcribe-setting.cjs");
// K2-01b: on Windows private files are judged by the verified HU-047 helper (null off Windows; see readPrivateJson).
const winfs = require("./win-fs.cjs");

/** K2-05 T3: a positive safe integer from the env, or undefined when it is absent or invalid. */
const intFromEnv = (value) => {
	if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return undefined;
	const number = Number(value);
	return Number.isSafeInteger(number) && number > 0 ? number : undefined;
};

/** F7: the same 1024-byte minimum the rotation enforces for the env bytes override. */
const MIN_ROTATE_BYTES = 1024;

/** The v0.1.0 #386 rotation keys (B1): accepted and IGNORED, never a config error. */
const OBSOLETE_ROTATION_KEYS = ["thresholdPercent", "keepTurns"];

const WORKSPACE_ENV = "KODA_WORKSPACE";
const ALLOWED_KEYS = ["workspace", "command", "thinking", "profile", "mcpConfigPath", "hotkey", "paused", "connectorsCommand", "connectorsDir", "hookInstallerBin", "connectorHostBin", "rotation", "transcription"];
// T2: the default engine is Koda's bundled Gentle Shell (resolved by the
// runtime from the bundled runtime folder); re-exported from runtime.cjs.
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

/**
 * K2-01b (Windows): NTFS has no POSIX mode bits (lstat reports 0o666), so privacy is a fact of the verified HU-047
 * helper, never a mode comparison. Exists → must be a regular, single-link, non-reparse file private to this user under
 * a private parent, within maxBytes; absent → null (as on POSIX). Any helper failure, an untrusted helper or facts about
 * another path is the same ConfigError(field): fail closed, never a fall-back to the mode check. The bytes read are those
 * of exactly the path the helper checked (its long form when `file` used an 8.3 name), bounded by maxBytes.
 */
function winReadPrivateJson(w, file, field, maxBytes) {
	let facts;
	try {
		facts = w.checkPath(file);
	} catch {
		throw new ConfigError(field);
	}
	if (!facts || typeof facts !== "object" || facts.ok !== true || typeof facts.path !== "string") throw new ConfigError(field);
	if (facts.path !== file && facts.path !== winfs.longPath(file)) throw new ConfigError(field);
	if (facts.exists === false && facts.kind === "none") return null;
	if (facts.exists !== true || facts.kind !== "file" || facts.reparse !== false || facts.private !== true || facts.nlink !== 1 || facts.parent_ok !== true) throw new ConfigError(field);
	if (!Number.isSafeInteger(facts.size) || facts.size > maxBytes) throw new ConfigError(field);
	let text;
	try {
		const fd = fs.openSync(facts.path, "r");
		try {
			const buf = Buffer.alloc(maxBytes + 1);
			let length = 0;
			for (let n; length < buf.length && (n = fs.readSync(fd, buf, length, buf.length - length, null)) > 0; ) length += n;
			if (length > maxBytes) throw new ConfigError(field);
			text = buf.subarray(0, length).toString("utf8");
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		throw new ConfigError(field);
	}
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		throw new ConfigError(field);
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ConfigError(field);
	return value;
}

/** The verified Windows helper backend, null off Windows; an untrusted helper is ConfigError(field), never a fall-back. */
function activeWinFs(field) {
	try {
		return winfs.active();
	} catch {
		throw new ConfigError(field);
	}
}

/** Reads a private JSON object file; `null` when absent. Throws ConfigError(field) otherwise. */
function readPrivateJson(file, field, maxBytes) {
	const w = activeWinFs(field);
	if (w) return winReadPrivateJson(w, file, field, maxBytes);
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

/** K2-05 T3 defaults: rotation ON, Gentle Dot's limits (20 MB per session file or 10 compactions). */
const ROTATION_DEFAULTS = { enabled: true, bytes: 20 * 1024 * 1024, compactions: 10 };

/**
 * K2-05 T3 `rotation`: strict object with known optional subkeys only —
 * `enabled` (strict boolean), `bytes` (1024..2147483647) and `compactions`
 * (1..1000000). Unknown or mistyped subkeys are a config error, never a silent
 * flip. EXCEPTION (B1): the v0.1.0 #386 keys `thresholdPercent`/`keepTurns` are
 * accepted and IGNORED — their old types/ranges are not validated and they can
 * never fail the daemon; a one-line notice says they are obsolete. Any OTHER
 * unknown subkey keeps the strict refusal.
 */
function validateRotation(raw, log = () => {}) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError("rotation");
	const obsolete = Object.keys(raw).filter((key) => OBSOLETE_ROTATION_KEYS.includes(key));
	for (const key of Object.keys(raw)) {
		if (key === "enabled" || key === "bytes" || key === "compactions" || obsolete.includes(key)) continue;
		throw new ConfigError("rotation");
	}
	if (obsolete.length > 0) {
		// Logged once per load; the file itself is never rewritten behind the user's back.
		log(`config rotation: ${obsolete.join(", ")} ${obsolete.length === 1 ? "is" : "are"} obsolete (the visible-summary rotation is gone) and ignored; the chat rotates by size and compaction count`);
	}
	const out = {};
	if (raw.enabled !== undefined) {
		if (typeof raw.enabled !== "boolean") throw new ConfigError("rotation");
		out.enabled = raw.enabled;
	}
	for (const [key, min, max] of [["bytes", 1024, 2_147_483_647], ["compactions", 1, 1_000_000]]) {
		if (raw[key] === undefined) continue;
		if (!Number.isSafeInteger(raw[key]) || raw[key] < min || raw[key] > max) throw new ConfigError("rotation");
		out[key] = raw[key];
	}
	return out;
}

/** K2-13 `transcription`: the strict setting validator, as a ConfigError that never echoes the value. */
function validateTranscription(raw) {
	try {
		return validateTranscriptionSetting(raw);
	} catch {
		throw new ConfigError("transcription");
	}
}

/**
 * K2-13 (S18) `transcription` read back from disk: the same strict validator plus the one migration, so a config
 * written by a build that still offered `local-whisper-turbo` loads as `local-parakeet` instead of locking Ajustes.
 */
function migrateTranscription(raw) {
	try {
		return migrateTranscriptionSetting(raw);
	} catch {
		throw new ConfigError("transcription");
	}
}

/** The raw, validated file content (no defaults, no env). */
function readConfigFile(islandRoot, log = () => {}) {
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
	if (raw.rotation !== undefined) out.rotation = validateRotation(raw.rotation, log);
	if (raw.transcription !== undefined) out.transcription = migrateTranscription(raw.transcription);
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

/** Effective config: file values, defaults, and the KODA_WORKSPACE override (which wins). */
function loadConfig(islandRoot, options = {}) {
	const env = options.env ?? process.env;
	const file = readConfigFile(islandRoot, options.log ?? (() => {}));
	const fileRotation = file.rotation ?? {};
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
		rotation: {
			enabled: fileRotation.enabled ?? ROTATION_DEFAULTS.enabled,
			// The KODA_ROTATE_* env overrides win over the file (rotationLimits); an
			// invalid value never wins, like KODA_WORKSPACE never flips silently.
			bytes: (() => {
			// F7: the env override keeps the same 1024-byte minimum as the config;
			// a smaller or non-decimal value never wins (like KODA_WORKSPACE).
			const fromEnv = intFromEnv(env.KODA_ROTATE_BYTES);
			return (fromEnv !== undefined && fromEnv >= MIN_ROTATE_BYTES ? fromEnv : undefined) ?? fileRotation.bytes ?? ROTATION_DEFAULTS.bytes;
		})(),
			compactions: intFromEnv(env.KODA_ROTATE_COMPACTIONS) ?? fileRotation.compactions ?? ROTATION_DEFAULTS.compactions,
		},
		transcription: file.transcription ?? { ...TRANSCRIPTION_DEFAULT },
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

/**
 * K2-13: persists the global transcription setting (validated first; nothing is written when it is refused),
 * merging the other keys, atomically with 0600. Returns `{transcription, changed}`.
 */
function setTranscription(islandRoot, value) {
	const next = validateTranscription(value);
	const { hotkeyInvalid, transcription: old, ...current } = readConfigFile(islandRoot);
	const changed = JSON.stringify(old ?? TRANSCRIPTION_DEFAULT) !== JSON.stringify(next);
	if (changed || hotkeyInvalid === true || old === undefined) {
		writePrivateFile(islandPaths(islandRoot).configFile, `${JSON.stringify({ ...current, transcription: next }, null, 2)}\n`);
	}
	return { transcription: next, changed };
}

/** Forgets the persisted session pointer (overwrites `state.json`, never deletes the session itself). */
function clearSessionPointer(islandRoot) {
	writePrivateFile(path.join(islandPaths(islandRoot).root, "state.json"), "{}\n");
}

/**
 * READ-ONLY: true when `<workspace>/.engram/config.json` names a memory
 * project other than the Abito pin. The daemon never writes `.engram` into a
 * user folder; the pin for such folders is `KODA_MEMORY_PROJECT` + identity,
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

/** K2-06 T1: the Rust host's loopback window-capture endpoint, set at spawn (apps/desktop-tauri/src/daemonhost.rs). */
const WINDOW_MCP_URL_ENV = "KODA_WINDOW_MCP_URL";
const WINDOW_MCP_TOKEN_ENV = "KODA_WINDOW_MCP_TOKEN";
/** The one server id Koda projects itself: the host's screenshot tool reaches the agent as `mcp__computer__*`. */
const COMPUTER_SERVER_ID = "computer";

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
 * K2-06 T1: the host's window-capture endpoint, projected as the `computer` server.
 *
 * Both env vars must be present, and the result must satisfy the SAME proxy-only rule as any
 * imported server (http on a literal loopback host, exactly one Bearer header), so the island
 * keeps its one accepted entry shape. Anything else is no server at all: never an invalid
 * projection, never a crash. The token is a capability — it is only ever written into the 0600
 * projection, never logged.
 */
function windowMcpEntry(env) {
	if (env === null || typeof env !== "object") return undefined;
	const url = env[WINDOW_MCP_URL_ENV];
	const token = env[WINDOW_MCP_TOKEN_ENV];
	if (typeof url !== "string" || typeof token !== "string") return undefined;
	return projectEntry({ type: "http", url, headers: { Authorization: `Bearer ${token}` } });
}

/** True when the host set EITHER variable: a half-set endpoint is reported, never silently ignored. */
function hasWindowEnv(env) {
	if (env === null || typeof env !== "object") return false;
	return env[WINDOW_MCP_URL_ENV] !== undefined || env[WINDOW_MCP_TOKEN_ENV] !== undefined;
}

/**
 * Writes the projection to `<island>/agent/mcp.json` — the user-level MCP file
 * of the engine's own home (the directory passed to `--home`, T2), which the
 * engine reads natively (see docs/mcp.md). With no source it writes an empty
 * projection so a stale one never lingers.
 *
 * K2-06 T1: Koda's OWN window-capture endpoint (`options.env`) is added as the
 * `computer` server when the host configured it, through the very same
 * proxy-only rule — a non-loopback URL, another header or a malformed Bearer
 * token yields no server at all, never an invalid projection and never a
 * crash. Koda's own endpoint wins over an imported server of the same id. The
 * token is a capability: it is only ever written into this 0600 file, and the
 * refusal notice (`options.log`) is a fixed sentence that never carries it.
 */
function writeMcpProjection(islandRoot, sourceFile, options = {}) {
	const projection = sourceFile ? projectMcpConfig(sourceFile) : { mcpServers: {} };
	const window = windowMcpEntry(options.env);
	if (window) projection.mcpServers[COMPUTER_SERVER_ID] = window;
	else if (hasWindowEnv(options.env)) {
		(options.log ?? (() => {}))("window capture: KODA_WINDOW_MCP_URL / KODA_WINDOW_MCP_TOKEN were refused (the endpoint must be http on a loopback host with a Bearer token); no computer server projected");
	}
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
	COMPUTER_SERVER_ID,
	DEFAULT_COMMAND,
	WINDOW_MCP_TOKEN_ENV,
	WINDOW_MCP_URL_ENV,
	WORKSPACE_ENV,
	clearSessionPointer,
	detectMemoryPinConflict,
	loadConfig,
	projectMcpConfig,
	readConfigFile,
	removeMcpProjection,
	setHotkey,
	setPaused,
	setTranscription,
	setWorkspace,
	validateCommand,
	validateConnectorsCommand,
	validateConnectorsDir,
	validateHookInstallerBin,
	validateConnectorHostBin,
	validateHotkey,
	validateWorkspace,
	windowMcpEntry,
	writeMcpProjection,
};
