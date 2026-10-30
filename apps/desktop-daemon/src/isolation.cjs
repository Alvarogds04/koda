"use strict";

/**
 * Abito island isolation (U1).
 *
 * Everything the island agent touches lives under one private root
 * (`~/.abito-island` by default, overridable with `ABITO_ISLAND_DIR`):
 * its own HOME, XDG directories, agent directory for the installed pi
 * (`PI_CODING_AGENT_DIR`; pi has no supported `--home` flag), private
 * sessions and a private temp directory. The user's own Pi setup,
 * extensions, auth and provider variables are never inherited: the child
 * environment is built from a small allowlist plus explicit overrides.
 *
 * Paths fail closed: any symlink component, world-writable component
 * without the sticky bit, or component owned by a foreign user is refused;
 * the island root itself must be owned by the current user and is tightened
 * to mode 0700.
 *
 * Structure and approach adapted from the Gentle Dot daemon (MIT,
 * Copyright (c) 2026 Gentleman Programming); see THIRD-PARTY-NOTICES.md.
 */

const {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	fchmodSync,
	lstatSync,
	mkdirSync,
	openSync,
	renameSync,
	unlinkSync,
	writeSync,
} = require("node:fs");
const { homedir } = require("node:os");
const path = require("node:path");
// HU-061: on Windows (verified HU-047 helper) credential dirs/files are made and checked through the native helper.
// Always reached as `winfs.active()`: null off Windows (Unix paths below stay byte-identical), a backend on a trusted
// win32 install, and a THROW when the helper cannot be trusted — never a fall-back to loose Node writes.
const winfs = require("./win-fs.cjs");

/** Environment variable that moves the island root (used by tests and embeddings). */
const ISLAND_ROOT_ENV = "ABITO_ISLAND_DIR";

/** The memory project every memory the island assistant saves belongs to. */
const MEMORY_PROJECT = "abito-island";

/**
 * Parent environment keys copied into the child: OS essentials only.
 * Everything else — provider keys, PI_* setup, session state, foreign
 * agent homes, memory servers — is dropped; explicit overrides re-add
 * what the engine itself decides (see `isolatedEnv`).
 */
const ENV_ALLOWLIST = [
	"PATH",
	"USER",
	"LOGNAME",
	"SHELL",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TZ",
	"TERM",
	"COLORTERM",
	"GIT_CONFIG_GLOBAL",
];

function currentUid() {
	return typeof process.getuid === "function" ? process.getuid() : undefined;
}

/** The island root: `ABITO_ISLAND_DIR` or `~/.abito-island`. */
function defaultIslandRoot(env = process.env) {
	if (env[ISLAND_ROOT_ENV]) return env[ISLAND_ROOT_ENV];
	// Windows (W1): %LOCALAPPDATA%\\Abito is user-private by default (inherited ACL), which is the
	// only privacy node can rely on there; the Rust host verifies owner and DACL before trusting it.
	if (process.platform === "win32" && env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, "Abito");
	return path.join(env.HOME || homedir(), ".abito-island");
}

/**
 * Windows (B5/S6): is `root` a forbidden island root? Returns a fixed refusal
 * reason, or null when the root is acceptable. On Windows the root MUST be the
 * canonical protected `%LOCALAPPDATA%\\Abito` or sit inside it — the same
 * policy the Rust reader (`winpolicy::island_root`) and the native session
 * helper enforce — so a non-canonical, climbing or relative root is refused
 * BEFORE the daemon creates anything in it. Off Windows: null (Unix behavior
 * unchanged). Pure and platform-injected: production passes `process.env` and
 * the real platform; only tests inject them.
 */
function windowsIslandRootViolation(root, env = process.env, platform = process.platform) {
	if (platform !== "win32") return null;
	const local = env.LOCALAPPDATA;
	if (typeof local !== "string" || !absoluteDrivePath(local)) {
		return "LOCALAPPDATA is missing or not an absolute drive path";
	}
	if (typeof root !== "string" || !absoluteDrivePath(root)) {
		return "island root is not an absolute drive path";
	}
	const canonical = path.join(local, "Abito");
	if (!withinCanonicalRoot(root, canonical)) {
		return "island root bypasses the canonical protected root";
	}
	return null;
}

/** An absolute Windows drive path (no control characters), OS-free by shape. */
function absoluteDrivePath(s) {
	return (
		s.length >= 3 &&
		/[A-Za-z]/.test(s[0]) &&
		s[1] === ":" &&
		(s[2] === "\\" || s[2] === "/") &&
		!/\p{C}/u.test(s)
	);
}

/**
 * OS-free containment (mirrors the Rust `within_canonical`): true only when
 * `candidate` IS the canonical root or sits inside it, with no `.`/`..` and no
 * empty component that could climb out textually.
 */
function withinCanonicalRoot(candidate, canonical) {
	const norm = (s) => s.replaceAll("\\", "/");
	const c = norm(candidate);
	const base = norm(canonical).replace(/\/+$/, "");
	if (c === base) return true;
	if (!c.startsWith(`${base}/`)) return false;
	return c
		.slice(base.length + 1)
		.split("/")
		.every((part) => part !== "" && part !== "." && part !== "..");
}

/** Where everything private lives inside the island. */
function islandPaths(root) {
	const absolute = path.resolve(root);
	return {
		root: absolute,
		home: path.join(absolute, "home"),
		agentDir: path.join(absolute, "agent"),
		sessions: path.join(absolute, "sessions"),
		workspace: path.join(absolute, "workspace"),
		tmp: path.join(absolute, "tmp"),
		configFile: path.join(absolute, "config.json"),
	};
}

/**
 * Fail-closed path check. Walks every component of `target` (deepest first)
 * and refuses the path when an existing component:
 * - is a symbolic link,
 * - is world-writable without the sticky bit (no planted shared dirs), or
 * - is owned by neither the current user nor root.
 * Returns the resolved absolute path.
 */
function assertSecurePath(target, options = {}) {
	const uid = options.uid ?? currentUid();
	const absolute = path.resolve(target);
	const components = [];
	let probe = absolute;
	while (true) {
		components.push(probe);
		const parent = path.dirname(probe);
		if (parent === probe) break;
		probe = parent;
	}
	for (const dir of components) {
		let stats;
		try {
			stats = lstatSync(dir);
		} catch (error) {
			if (error.code === "ENOENT") continue;
			if (error.code === "EACCES") throw new Error(`refusing island path: cannot inspect ${dir}`);
			throw error;
		}
		if (stats.isSymbolicLink()) throw new Error(`refusing symlink component in island path: ${dir}`);
		// Windows has no POSIX mode bits (lstat reports 0o666/0o777): privacy there comes from the profile ACL.
		if (process.platform !== "win32" && (stats.mode & 0o002) !== 0 && (stats.mode & 0o1000) === 0) {
			throw new Error(`refusing world-writable component without the sticky bit: ${dir}`);
		}
		if (uid !== undefined && stats.uid !== uid && stats.uid !== 0) {
			throw new Error(`refusing component owned by uid ${stats.uid}: ${dir}`);
		}
	}
	return absolute;
}

/**
 * Creates `dir` (with any missing parents) as a private 0700 directory owned
 * by the current user and tightens an existing one to 0700. Fails closed on
 * insecure path components (see `assertSecurePath`) and refuses a directory
 * owned by another user — including root.
 */
function ensurePrivateDir(dir, options = {}) {
	const uid = options.uid ?? currentUid();
	const absolute = assertSecurePath(dir, options);
	const w = winfs.active();
	if (w) return winEnsurePrivateDir(w, absolute);
	let stats;
	try {
		stats = lstatSync(absolute);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		mkdirSync(absolute, { recursive: true, mode: 0o700 });
		stats = lstatSync(absolute);
	}
	if (!stats.isDirectory()) throw new Error(`refusing island path, not a directory: ${absolute}`);
	if (uid !== undefined && stats.uid !== uid) {
		throw new Error(`refusing island path owned by uid ${stats.uid}, not the current user: ${absolute}`);
	}
	chmodSync(absolute, 0o700);
	return absolute;
}

/**
 * Windows: creates every missing component one level at a time (outermost first, below the deepest existing
 * ancestor) with the helper, then requires the target to be a private, non-reparse directory under a private parent.
 */
function winEnsurePrivateDir(w, absolute) {
	const missing = [];
	let probe = absolute;
	while (!w.checkPath(probe).exists) {
		missing.unshift(probe);
		const parent = path.dirname(probe);
		if (parent === probe) throw new Error(`refusing island path, no existing ancestor: ${absolute}`);
		probe = parent;
	}
	for (const part of missing) w.makeDir(part);
	const facts = w.checkPath(absolute);
	if (!facts.exists || facts.kind !== "dir") throw new Error(`refusing island path, not a directory: ${absolute}`);
	if (facts.reparse) throw new Error(`refusing island path, reparse point: ${absolute}`);
	if (!facts.private || !facts.parent_ok) throw new Error(`refusing island path, not private to this user: ${absolute}`);
	return absolute;
}

/** Bounded retries when the helper reports that the file changed under us (expect-hash race). */
const WIN_WRITE_ATTEMPTS = 4;

/** Windows: read the current private bytes (throws on reparse / not private) and replace them against their hash. */
function winWritePrivateFile(w, absolute, content) {
	const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
	if (buf.length > winfs.MAX_FILE) throw new winfs.WinFsError("too_large");
	for (let attempt = 1; ; attempt++) {
		const current = w.readPrivate(absolute);
		try {
			w.writePrivate(absolute, buf, current ? current.sha256 : null);
			return absolute;
		} catch (error) {
			const retry = error && (error.reason === "mismatch" || error.reason === "exists" || error.reason === "missing");
			if (!retry || attempt >= WIN_WRITE_ATTEMPTS) throw error;
		}
	}
}

/** O_NOFOLLOW when the platform has it; without it the O_EXCL temp name still races safely. */
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

let privateFileSeq = 0;

/**
 * Writes a private file inside the island, fail-closed:
 * - the parent directory must pass `ensurePrivateDir` (no symlink components);
 * - an existing target must be a regular, non-symlink file owned by the
 *   current user, or the write is refused (never written through);
 * - content lands in an O_EXCL|O_NOFOLLOW temp file (mode 0600) that is
 *   renamed over the target, so readers never see partial content;
 * - the target ends up with exactly `mode` (default 0600).
 * Exported for U2 (profile/secret stores) and U4 (user config.json).
 */
function writePrivateFile(target, content, options = {}) {
	const uid = options.uid ?? currentUid();
	const mode = options.mode ?? 0o600;
	const absolute = path.resolve(target);
	ensurePrivateDir(path.dirname(absolute), options);
	const w = winfs.active();
	if (w) return winWritePrivateFile(w, absolute, content);
	let existing;
	try {
		existing = lstatSync(absolute);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	if (existing) {
		if (existing.isSymbolicLink()) throw new Error(`refusing to write through a symlink: ${absolute}`);
		if (!existing.isFile()) throw new Error(`refusing to write, not a regular file: ${absolute}`);
		if (uid !== undefined && existing.uid !== uid) {
			throw new Error(`refusing file owned by uid ${existing.uid}, not the current user: ${absolute}`);
		}
	}
	const temp = `${absolute}.tmp-${process.pid}-${++privateFileSeq}`;
	const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
	try {
		writeSync(fd, content);
		fchmodSync(fd, mode);
	} finally {
		closeSync(fd);
	}
	try {
		renameSync(temp, absolute);
	} catch (error) {
		try {
			unlinkSync(temp);
		} catch {}
		throw error;
	}
	return absolute;
}

/**
 * Creates the island: private root, HOME, agent dir for the installed pi,
 * session and temp directories, the XDG tree under HOME, and the owned
 * default workspace whose `.engram/config.json` pins the memory project.
 * The memory pin is written ONLY in this owned workspace — never in a
 * user-chosen workspace (see the U4 note in README.md).
 */
function ensureIsland(root, options = {}) {
	const paths = islandPaths(root);
	ensurePrivateDir(paths.root, options);
	for (const dir of [
		paths.home,
		paths.agentDir,
		paths.sessions,
		paths.tmp,
		paths.workspace,
		path.join(paths.home, ".config"),
		path.join(paths.home, ".cache"),
		path.join(paths.home, ".local", "share"),
		path.join(paths.home, ".local", "state"),
	]) {
		ensurePrivateDir(dir, options);
	}
	const engramDir = ensurePrivateDir(path.join(paths.workspace, ".engram"), options);
	writePrivateFile(path.join(engramDir, "config.json"), `${JSON.stringify({ project_name: MEMORY_PROJECT })}\n`, {
		mode: 0o600,
	});
	return paths;
}

/**
 * The engine child's environment: allowlisted OS essentials from `base`,
 * the private HOME/XDG/TMPDIR, the explicit private pi agent directory, and
 * offline/no-telemetry markers. Provider credentials, the parent's PI_*
 * variables and foreign agent settings never pass through. `overrides`
 * carries explicit engine-owned additions (memory project pin now, provider
 * auth in U2) and always wins.
 */
function isolatedEnv(base, paths, overrides = {}) {
	const env = {};
	for (const key of ENV_ALLOWLIST) {
		const value = base[key];
		if (typeof value === "string" && value !== "") env[key] = value;
	}
	if (!env.PATH) env.PATH = "/usr/bin:/bin";
	const realHome = base.HOME || homedir();
	env.HOME = paths.home;
	env.TMPDIR = paths.tmp;
	env.XDG_CONFIG_HOME = path.join(paths.home, ".config");
	env.XDG_DATA_HOME = path.join(paths.home, ".local", "share");
	env.XDG_CACHE_HOME = path.join(paths.home, ".cache");
	env.XDG_STATE_HOME = path.join(paths.home, ".local", "state");
	// The installed pi keeps its agent directory here; the unsupported
	// `--home` flag is never used.
	env.PI_CODING_AGENT_DIR = paths.agentDir;
	// Offline by default: no model catalog refreshes, no version check, no telemetry.
	env.PI_OFFLINE = "1";
	env.PI_SKIP_VERSION_CHECK = "1";
	env.PI_TELEMETRY = "0";
	// Keep the user's git identity without exposing their real HOME.
	if (!base.GIT_CONFIG_GLOBAL) {
		const gitConfig = path.join(realHome, ".gitconfig");
		if (existsSync(gitConfig)) env.GIT_CONFIG_GLOBAL = gitConfig;
	}
	return { ...env, ...overrides };
}

module.exports = {
	ENV_ALLOWLIST,
	ISLAND_ROOT_ENV,
	MEMORY_PROJECT,
	assertSecurePath,
	defaultIslandRoot,
	ensureIsland,
	ensurePrivateDir,
	islandPaths,
	isolatedEnv,
	windowsIslandRootViolation,
	writePrivateFile,
};
