"use strict";

/**
 * Abito island isolation (U1).
 *
 * Everything the island agent touches lives under one private root
 * (`~/.abito-island` by default, overridable with `ABITO_ISLAND_DIR`):
 * its own HOME, XDG directories, the engine home for the bundled Gentle Shell
 * (passed to the engine as `--home`; T2), private sessions and a private temp
 * directory. The user's own Pi/Gentle Shell setup, extensions, auth and
 * provider variables are never inherited: the child environment is built from
 * a small allowlist plus explicit overrides.
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
	readFileSync,
	readlinkSync,
	renameSync,
	unlinkSync,
	writeSync,
} = require("node:fs");
const { execFile } = require("node:child_process");
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

/** Windows process-launch essentials, copied through on win32 (Gentle Dot keeps them). */
const ENV_WINDOWS_ALLOWLIST = ["SystemRoot", "windir", "ComSpec", "PATHEXT"];

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
		/** gentle-ai's own config home inside the island (T2). */
		gentleAi: path.join(absolute, "gentle-ai"),
	};
}

/**
 * Fail-closed path check. Walks every component of `target` from the root down
 * and refuses the path when an existing component:
 * - is a symbolic link — except (K2-01b, not on Windows) a TRUSTED SYSTEM LINK
 *   ancestor: the link is owned by root and its parent directory is owned by
 *   root and not group/world-writable, so no other user can have planted or
 *   swapped it (macOS /var → private/var, /tmp, /etc; merged-usr /lib → usr/lib).
 *   The walk then continues on the link's target, which must pass this whole
 *   rule again. The LEAF is never allowed to be a symlink;
 * - is world-writable without the sticky bit (no planted shared dirs), or
 * - is owned by neither the current user nor root.
 * Returns the resolved absolute path (as given, not the link target).
 * `options.fs` / `options.platform` are test seams (an injected lstat/readlink and platform).
 */
function assertSecurePath(target, options = {}) {
	const uid = options.uid ?? currentUid();
	const lstat = options.fs?.lstatSync ?? lstatSync;
	const readlink = options.fs?.readlinkSync ?? readlinkSync;
	const platform = options.platform ?? process.platform;
	const absolute = path.resolve(target);
	let pending = absolute;
	for (let hops = 0; ; hops++) {
		const next = walkSecure(pending, { uid, lstat, readlink, platform, followLinks: hops < MAX_TRUSTED_LINK_HOPS });
		if (next === null) return absolute;
		pending = next;
	}
}

/** Bound on followed trusted links (a loop of root-owned links is refused, never spun on). */
const MAX_TRUSTED_LINK_HOPS = 40;

/**
 * One top-down pass over `absolute`. Returns null when every existing component passes, or the path to walk next
 * when a trusted system link ancestor was met (its target joined with the remaining components). Throws on refusal.
 */
function walkSecure(absolute, { uid, lstat, readlink, platform, followLinks }) {
	const { root } = path.parse(absolute);
	const parts = absolute.slice(root.length).split(path.sep).filter(Boolean);
	const dirs = [root, ...parts.map((_, i) => path.join(root, ...parts.slice(0, i + 1)))];
	for (let i = 0; i < dirs.length; i++) {
		const dir = dirs[i];
		let stats;
		try {
			stats = lstat(dir);
		} catch (error) {
			if (error.code === "ENOENT") return null; // nothing below a missing component exists either
			if (error.code === "EACCES") throw new Error(`refusing island path: cannot inspect ${dir}`);
			throw error;
		}
		if (stats.isSymbolicLink()) {
			const leaf = i === dirs.length - 1;
			if (leaf || !followLinks || !trustedSystemLink(stats, dirs[i - 1], lstat, platform)) {
				throw new Error(`refusing symlink component in island path: ${dir}`);
			}
			// Compose without normalizing: a `..` in the target must be walked AFTER the components before it, exactly as the
			// OS traverses them (path.resolve would collapse `hop/..` and skip checking `hop`).
			const linkTarget = readlink(dir);
			const base = path.isAbsolute(linkTarget) ? linkTarget : `${dirs[i - 1]}${path.sep}${linkTarget}`;
			return [base, ...parts.slice(i)].join(path.sep); // dirs[i] is parts[i - 1]: the rest starts at parts[i]
		}
		// Windows has no POSIX mode bits (lstat reports 0o666/0o777): privacy there comes from the profile ACL.
		if (platform !== "win32" && (stats.mode & 0o002) !== 0 && (stats.mode & 0o1000) === 0) {
			throw new Error(`refusing world-writable component without the sticky bit: ${dir}`);
		}
		if (uid !== undefined && stats.uid !== uid && stats.uid !== 0) {
			throw new Error(`refusing component owned by uid ${stats.uid}: ${dir}`);
		}
	}
	return null;
}

/**
 * K2-01b: a symlink the system owns — root-owned link in a root-owned parent that is not group/world-writable.
 * Never on Windows (lstat reports uid 0 for every file there; junctions stay refused as before). `parent` is the
 * already-verified real parent directory of the link.
 */
function trustedSystemLink(stats, parent, lstat, platform) {
	if (platform === "win32" || stats.uid !== 0 || parent === undefined) return false;
	let parentStats;
	try {
		parentStats = lstat(parent);
	} catch {
		return false;
	}
	return !parentStats.isSymbolicLink() && parentStats.uid === 0 && (parentStats.mode & 0o022) === 0;
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
 * K2-02 (S2): the Node running the daemon leads the engine child's PATH (`pathWithNodeFirst`),
 * so any `node` a child looks up resolves to Koda's own Node — the bundled one when the daemon
 * runs on the bundled runtime — never the user's. `delimiter` is path.delimiter (';' on Windows,
 * ':' elsewhere); with no inherited PATH the historical fallback tail is kept unchanged.
 */
const PATH_FALLBACK = "/usr/bin:/bin";
function pathWithNodeFirst(nodeDir, existing, delimiter = path.delimiter) {
	return `${nodeDir}${delimiter}${existing || PATH_FALLBACK}`;
}

/**
 * The engine's environment: allowlisted OS essentials from `base`, the private
 * HOME/XDG/TMPDIR, the offline/no-telemetry markers and the Gentle Shell launch
 * gates. Provider credentials, the parent's PI_* and GENTLE_* variables
 * (including GENTLE_SHELL_PI, which gentle-shell would honour over Koda's
 * bundled Pi) and foreign agent settings never pass through. `overrides`
 * carries explicit engine-owned additions (memory project pin now, provider
 * auth in U2) and always wins.
 */
function isolatedEnv(base, paths, overrides = {}, options = {}) {
	const platform = options.platform ?? process.platform;
	const env = {};
	const allowlist = platform === "win32" ? [...ENV_ALLOWLIST, ...ENV_WINDOWS_ALLOWLIST] : ENV_ALLOWLIST;
	for (const key of allowlist) {
		const value = base[key];
		if (typeof value === "string" && value !== "") env[key] = value;
	}
	env.PATH = pathWithNodeFirst(path.dirname(process.execPath), env.PATH);
	// On Windows the engine (and its tools) resolve the home and state folders
	// through USERPROFILE/APPDATA/LOCALAPPDATA/TEMP/TMP, not HOME: without these
	// the child would read and keep state in the user's real profile — the exact
	// leak the private island exists to prevent (Gentle Dot isolatedAgentEnv, win32).
	const realHome = platform === "win32" ? base.USERPROFILE || base.HOME || homedir() : base.HOME || homedir();
	env.HOME = paths.home;
	env.TMPDIR = paths.tmp;
	env.XDG_CONFIG_HOME = path.join(paths.home, ".config");
	env.XDG_DATA_HOME = path.join(paths.home, ".local", "share");
	env.XDG_CACHE_HOME = path.join(paths.home, ".cache");
	env.XDG_STATE_HOME = path.join(paths.home, ".local", "state");
	if (platform === "win32") {
		env.USERPROFILE = paths.home;
		env.TEMP = env.TMP = paths.tmp;
		// Windows' counterparts of the XDG folders, created private inside the
		// island home so the engine's tools keep no state in the user's own.
		env.APPDATA = path.join(paths.home, "AppData", "Roaming");
		env.LOCALAPPDATA = path.join(paths.home, "AppData", "Local");
		ensurePrivateDir(env.APPDATA);
		ensurePrivateDir(env.LOCALAPPDATA);
	}
	// T2 (B2): for Koda's default bundled Gentle Shell the engine home travels on
	// the `--home` argv flag (Gentle Dot's shape), so PI_CODING_AGENT_DIR is never
	// set and never inherited here. A non-default `command` (a plain Pi override)
	// cannot take --home and carries its home in PI_CODING_AGENT_DIR, which the
	// engine's spawn adds as an explicit override for that branch only.
	// Offline by default: no model catalog refreshes, no version check, no telemetry.
	env.PI_OFFLINE = "1";
	env.PI_SKIP_VERSION_CHECK = "1";
	env.PI_TELEMETRY = "0";
	// gentle-shell's first-run companion provisioning gate and its missing
	// package-local gentle-ai self-heal/installer gate (Gentle Dot agentSpawnEnv):
	// the installed engine must never try to install or self-heal anything.
	env.GENTLE_SHELL_NO_AUTO_SETUP = "1";
	env.GENTLE_PI_SKIP_GENTLE_AI_INSTALL = "1";
	// gentle-ai's own config home inside the island.
	env.GENTLE_PI_CONFIG_HOME = paths.gentleAi;
	// Keep the user's git identity without exposing their real HOME.
	if (!base.GIT_CONFIG_GLOBAL) {
		const gitConfig = path.join(realHome, ".gitconfig");
		if (existsSync(gitConfig)) env.GIT_CONFIG_GLOBAL = gitConfig;
	}
	return { ...env, ...overrides };
}

/** The file gentle-shell writes into a home it created (gentle-pi `bin/gentle-shell.mjs`). */
const ENGINE_HOME_MARKER = ".gentle-shell-home";

/**
 * Marks Koda's own engine home (`<island>/agent`, the directory passed to
 * `--home`) as gentle-shell's, before the engine's first spawn (Gentle Dot
 * `claimEngineHome`): gentle-shell runs its first-run setup only in a home it
 * created — one that holds its marker. Koda writes auth/mcp/extension files
 * there before the engine's first start, so without the marker the engine took
 * the home for someone else's. The marker has gentle-shell's own format
 * (`{"createdBy":"gentle-shell","version":…}`; it checks only that the file
 * exists); `version` is the bundled runtime's gentle-pi version, informational
 * only. One already there is left exactly as it is. Called ONLY for Koda's own
 * island agent dir — never for any other home. Written through the same
 * fail-closed private write as identity.md; a failure is logged, never fatal
 * (the launch gates in `isolatedEnv` keep the engine from provisioning anyway).
 */
function claimEngineHome(agentDir, version, log = () => {}) {
	const marker = path.join(agentDir, ENGINE_HOME_MARKER);
	// Exclusive create (no check-then-write window): the marker either does not
	// exist and is created here, or something (another daemon, an attacker's
	// planted link) already holds the name and is never touched. O_EXCL|O_NOFOLLOW
	// keeps the fail-closed private-file semantics end to end.
	try {
		const fd = openSync(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
		try {
			writeSync(fd, `${JSON.stringify({ createdBy: "gentle-shell", version })}\n`);
			fchmodSync(fd, 0o600);
		} finally {
			closeSync(fd);
		}
		return true;
	} catch (error) {
		if (error?.code !== "EEXIST") {
			log(`could not mark the engine's home as its own: ${error.message}`);
			return false;
		}
	}
	// The name is taken: refused unless it is exactly the marker this daemon
	// (or a previous run of it) already wrote — a symlink, directory or any
	// other file is never written through, and the refusal is logged.
	let existing;
	try {
		existing = lstatSync(marker);
	} catch (error) {
		log(`could not mark the engine's home as its own: ${error.message}`);
		return false;
	}
	if (existing.isFile() && !existing.isSymbolicLink()) {
		try {
			const claimed = JSON.parse(readFileSync(marker, "utf8"));
			if (claimed.createdBy === "gentle-shell") return false; // already claimed: left exactly as it is
		} catch {}
	}
	log(`could not mark the engine's home as its own: ${marker} exists and is not gentle-shell's marker`);
	return false;
}

// ----- K2-05 T1c (S5/L11): Koda's private memory ----------------------------

/**
 * The memory server port of Koda's own private memory. Koda's memory is ALWAYS
 * private (no user-store mode): the store lives inside the island — the engine's
 * HOME is `<island>/home` and Engram defaults its store to `<HOME>/.engram` when
 * `ENGRAM_DATA_DIR` is unset, exactly where Gentle Dot's private mode puts it —
 * and the server runs on this port. 7439 is one above Gentle Dot's own private
 * memory port (7438), which is itself one above Engram's global default (7437):
 * a user's own Engram server on 7437/7438 can never collide with it, and the
 * lifecycle below never touches a server that is not Koda's. Overridable for
 * tests/embeddings with `ABITO_ENGRAM_PORT`.
 */
const PRIVATE_ENGRAM_PORT = "7439";

/** The parent-env variable that overrides `PRIVATE_ENGRAM_PORT`. */
const PRIVATE_ENGRAM_PORT_ENV = "ABITO_ENGRAM_PORT";

/** The private memory port for `base`: the override, or Koda's default. */
function privateMemoryPort(base = {}) {
	const value = base[PRIVATE_ENGRAM_PORT_ENV];
	return typeof value === "string" && value !== "" ? value : PRIVATE_ENGRAM_PORT;
}

/** The seams `privateMemory` accepts (all optional; production runs the real ones). */

/** How long the listener lookup may take (Gentle Dot: Windows CIM is slow). */
function listenerLookupTimeoutMs(platform) {
	return platform === "win32" ? 15000 : 5000;
}

function runListenerCommand(command, args) {
	return new Promise((resolve) => {
		execFile(
			command,
			[...args],
			{
				encoding: "utf8",
				timeout: listenerLookupTimeoutMs(command === "powershell.exe" ? "win32" : process.platform),
				windowsHide: true,
			},
			(error, stdout, stderr) => {
				let code = 0;
				if (error && typeof error.code === "number") code = error.code;
				else if (error) code = -1;
				// F2: a missing binary (ENOENT) is reported distinctly — it is the one
				// failure the Linux ss fallback may answer, never a listener fact.
				resolve({
					code,
					stdout: String(stdout),
					stderr: String(stderr),
					missing: error !== undefined && error !== null && error.code === "ENOENT",
				});
			},
		);
	});
}

/**
 * F2 (Linux only): parse `ss -ltnpH` when lsof is missing, keeping the same
 * fail-closed rules as the lsof lookup — a listener on the port with no visible
 * pid (a foreign process an unprivileged ss cannot attribute) is a FAILED
 * lookup, never "empty"; two pids sharing the port are ambiguous; a missing or
 * failing ss is a failure too. Every line is `State Recv-Q Send-Q Local:Port
 * Peer:Port [Process]`; only lines whose LOCAL column ends in `:<port>` count.
 */
async function listeningPidViaSs(port, options) {
	try {
		const result = await (options.runListenerCommand ?? runListenerCommand)("ss", ["-ltnpH"]);
		if (result.missing || result.code !== 0 || result.stderr.trim()) return { kind: "failed" };
		const pids = new Set();
		let sawPortListener = false;
		for (const line of result.stdout.split(/\r?\n/)) {
			const fields = line.trim().split(/\s+/);
			if (fields.length < 4 || fields[0] !== "LISTEN" || !fields[3].endsWith(`:${port}`)) continue;
			sawPortListener = true;
			for (const match of fields.slice(4).join(" ").matchAll(/pid=(\d+)/g)) pids.add(Number(match[1]));
		}
		if (!sawPortListener) return { kind: "empty" };
		if (pids.size === 0) return { kind: "failed" };
		if (pids.size > 1) return { kind: "ambiguous" };
		return { kind: "one", pid: [...pids][0] };
	} catch {
		return { kind: "failed" };
	}
}

/** Enumerate Windows listeners before filtering, so an unused port is not a query error. */
async function listeningPid(port, options) {
	const windows = (options.platform ?? process.platform) === "win32";
	const command = windows ? "powershell.exe" : "lsof";
	const args = windows
		? [
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; try { Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq ${Number(port)} } | Select-Object -ExpandProperty OwningProcess } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`,
			]
		: ["-w", "-t", "-n", "-P", `-iTCP:${port}`, "-sTCP:LISTEN"];
	try {
		const result = await (options.runListenerCommand ?? runListenerCommand)(command, args);
		// F2: only a MISSING lsof on Linux may be answered by the ss fallback —
		// every other lsof failure stays a failure (fail closed, same as before).
		if (result.missing && (options.platform ?? process.platform) === "linux") {
			return listeningPidViaSs(port, options);
		}
		const text = result.stdout.trim();
		// lsof exits 1 for no matches. Missing commands, diagnostics and timeouts are failures.
		if (!windows && result.code === 1 && !text && !result.stderr.trim()) return { kind: "empty" };
		if (result.code !== 0 || result.stderr.trim()) return { kind: "failed" };
		if (!text) return { kind: "empty" };
		const values = text.split(/\r?\n/).map((value) => value.trim());
		if (values.some((value) => !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))) {
			return { kind: "failed" };
		}
		const pids = [...new Set(values.map(Number))];
		return pids.length === 1 ? { kind: "one", pid: pids[0] } : { kind: "ambiguous" };
	} catch {
		return { kind: "failed" };
	}
}

function memoryHealth(port) {
	return fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })
		.then((response) => response.json())
		.catch(() => undefined);
}

/**
 * The island identity file the engine's own Engram server leaves behind
 * (`<island>/home/.engram/.instance-id`): read fail-closed — regular,
 * non-symlink, owner-only, small, owned by the current user. Any refusal
 * yields undefined, and undefined ownership never signals anything.
 */
function readInstanceIdFile(file, options) {
	const fsOps = options.fs ?? { lstatSync, readFileSync };
	try {
		const stats = fsOps.lstatSync(file);
		if (!stats.isFile() || stats.isSymbolicLink() || (process.platform !== "win32" && (stats.mode & 0o077) !== 0) || stats.size > 4096) {
			return undefined;
		}
		if (typeof process.getuid === "function" && stats.uid !== process.getuid()) return undefined;
		const value = fsOps.readFileSync(file, "utf8").trim();
		return /^[0-9a-f]{32}$/i.test(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Owns cleanup of Koda's private memory: after confirming an EMPTY private port
 * before startup (Gentle Dot `privateMemory`, isolation.ts:155-300), or — F2 —
 * after reclaiming an orphaned server from a crashed daemon that is PROVEN to
 * be Koda's own (same identity proof as the stop path). A failed or ambiguous
 * lookup refuses ownership, not startup: the daemon starts, logs it, and leaves
 * that memory server running when it closes. An invalid port (including the
 * user's own Engram ports 7437/7438, F3) is a configuration error and does stop
 * startup. Before termination, both the private data identity
 * (`<dataDir>/home/.engram/.instance-id`) and a repeated stable listener PID
 * must match. PID reuse after the final check remains possible; nothing is
 * killed by name, and a server that is not Koda's own is never touched. Pure
 * seams (`options.runListenerCommand`, `options.kill`, `options.health`,
 * `options.fs`, `options.platform`) are for tests only.
 */
/**
 * F3: the port of Koda's private memory is validated wherever it is used — the
 * lifecycle below and the engine env (runtime.cjs, defence in depth). Anything
 * non-numeric is invalid; the USER's own Engram defaults (7437 global, 7438
 * Gentle Dot's private port) are refused as a configuration error with a clear
 * message, never silently inherited.
 */
const FORBIDDEN_PRIVATE_PORTS = new Set(["7437", "7438"]);
function assertPrivateMemoryPort(port) {
	// Canonical decimal only: no sign, no leading zeros. gentle-engram reads the port with
	// Number.parseInt, so "07437" would silently mean the user's own 7437.
	if (!/^[1-9]\d*$/.test(port) || !Number.isSafeInteger(Number(port)) || Number(port) > 65535) {
		throw new Error("Cannot start private memory: port must be an integer from 1 to 65535");
	}
	if (FORBIDDEN_PRIVATE_PORTS.has(port)) {
		throw new Error(`Cannot start private memory: port ${port} belongs to the user's own Engram server; set ${PRIVATE_ENGRAM_PORT_ENV} to another port`);
	}
}

async function privateMemory(base, dataDir, log = () => {}, options = {}) {
	const port = privateMemoryPort(base);
	assertPrivateMemoryPort(port);
	const before = await listeningPid(port, options);
	if (before.kind === "one") {
		// F2: an orphaned server left by a crashed daemon used to run until reboot
		// (on Linux without lsof, a stop could never even look). Reclaim it ONLY
		// with the same proof the stop path demands — the island's .instance-id, a
		// matching /health and a stable listener pid; anything else is never ours.
		if (await verifyOwnMemoryListener(port, dataDir, before.pid, options, log)) {
			log(`reclaimed the private memory server of a previous run (pid ${before.pid})`);
		} else {
			return undefined;
		}
	} else if (before.kind !== "empty") {
		// Not knowing is no reason to keep the assistant from starting, nor to claim the server.
		log(`cannot verify private memory listener on port ${port} (${before.kind} lookup); will not stop it`);
		return undefined;
	}
	return {
		async stop() {
			const listener = await listeningPid(port, options);
			if (listener.kind !== "one") {
				if (listener.kind !== "empty") {
					log(`cannot verify private memory listener on port ${port}; left running`);
				}
				return;
			}
			if (!(await verifyOwnMemoryListener(port, dataDir, listener.pid, options, log))) return;
			try {
				(options.kill ?? process.kill)(listener.pid, "SIGTERM");
				log(`stopped the private memory server (pid ${listener.pid})`);
			} catch (error) {
				log(`could not stop private memory server (pid ${listener.pid}): ${String(error)}`);
			}
		},
	};
}

/**
 * The ownership proof shared by the stop path and the F2 reclaim: the private
 * data identity (`<dataDir>/home/.engram/.instance-id`), a matching /health and
 * a repeated stable listener pid. Returns true only when every check passes;
 * every refusal is logged and nothing is ever signalled.
 */
async function verifyOwnMemoryListener(port, dataDir, pid, options, log) {
	const expected = readInstanceIdFile(path.join(dataDir, "home", ".engram", ".instance-id"), options);
	if (!expected) {
		log(`cannot read the private memory identity of port ${port}; left running`);
		return false;
	}
	const health = await (options.health ?? memoryHealth)(port).catch(() => undefined);
	if (health?.instance_id !== expected) {
		log(`the memory server on port ${port} serves other data; left running`);
		return false;
	}
	const again = await listeningPid(port, options);
	if (again.kind !== "one" || again.pid !== pid) {
		log(`the private memory listener changed on port ${port}; left running`);
		return false;
	}
	return true;
}

module.exports = {
	ENGINE_HOME_MARKER,
	ENV_ALLOWLIST,
	ENV_WINDOWS_ALLOWLIST,
	ISLAND_ROOT_ENV,
	MEMORY_PROJECT,
	PRIVATE_ENGRAM_PORT,
	PRIVATE_ENGRAM_PORT_ENV,
	assertPrivateMemoryPort,
	assertSecurePath,
	claimEngineHome,
	defaultIslandRoot,
	ensureIsland,
	ensurePrivateDir,
	islandPaths,
	isolatedEnv,
	pathWithNodeFirst,
	privateMemory,
	privateMemoryPort,
	windowsIslandRootViolation,
	writePrivateFile,
};
