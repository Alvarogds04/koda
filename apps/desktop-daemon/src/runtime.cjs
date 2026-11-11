"use strict";

/**
 * Abito island engine runtime (U1).
 *
 * Supervises the island agent (the installed `pi` behind the configured
 * executable) in `--mode rpc` as a child process inside the private island
 * (see isolation.cjs), speaks strict JSONL framing, correlates commands with
 * responses, forwards session events, times requests out, rejects pending
 * work when the child exits, respawns after a crash with exponential bounded
 * backoff, and stops without restarting on demand.
 *
 * The engine is an EventEmitter so the transport (U3) and profile lane (U2)
 * can subscribe: "status" ({state}), "event" (agent records), "exit"
 * ({code, signal}) and log lines through the `log` option.
 *
 * Framing, correlation and supervision adapted from the Gentle Dot daemon
 * (MIT, Copyright (c) 2026 Gentleman Programming); see THIRD-PARTY-NOTICES.md.
 */

const { EventEmitter } = require("node:events");
const { performance } = require("node:perf_hooks");
const { spawn } = require("node:child_process");
const { existsSync, lstatSync, readFileSync, readdirSync, renameSync, rmSync } = require("node:fs");
const { createHash } = require("node:crypto");
const path = require("node:path");

const {
	MEMORY_PROJECT,
	assertPrivateMemoryPort,
	claimEngineHome,
	defaultIslandRoot,
	ensureIsland,
	ensurePrivateDir,
	isolatedEnv,
	privateMemoryPort,
	writePrivateFile,
} = require("./isolation.cjs");
// F2: the daemon-owned flush marker for a cancelled turn. A Symbol cannot be
// produced by JSON.parse, so a child record can never forge this event.
const { MESSAGE_FLUSH } = require("./protocol.cjs");

const DEFAULT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
/**
 * F4: the only ENGRAM_* keys a caller may still set on Koda's own engine —
 * diagnostics that move no memory state (the companion logs richer stderr
 * traces when set). Everything else ENGRAM_* is stripped from envOverrides for
 * the default engine: the memory selection (binary, URL, data dir, port,
 * socket, database URL, startup policy, update check) is daemon-owned.
 */
const ENGRAM_DIAGNOSTIC_OVERRIDES = new Set(["ENGRAM_PI_SESSION_TRACE"]);
const DEFAULT_START_TIMEOUT_MS = 60_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_STABLE_MS = 30_000;
const DEFAULT_SWITCH_TIMEOUT_MS = 30_000;
/**
 * K2-05 boot reopen (L44): how many times the engine tries to reopen the
 * conversation saved in state.json (each try on a fresh child, with the restart
 * backoff between tries) before it gives up on it and takes the rotation's own
 * fallback: a fresh session linked as the continuation of the saved one.
 */
const DEFAULT_REOPEN_ATTEMPTS = 3;
// Abito technical policy, not upstream AG-UI/TanStack constants.
const DEFAULT_TURN_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_TURN_ITERATIONS = 32;
const DEFAULT_ABORT_GRACE_MS = 2_000;

/** The npm global package that provides Pi on Windows (custom bare commands only since T2). */
const PI_PACKAGE_SEGMENTS = ["node_modules", "@earendil-works", "pi-coding-agent"];

/**
 * The default engine (T2): Gentle Shell, Koda's bundled Gentle Pi. Never a
 * binary from PATH or an npm prefix; config.json `command` overrides it.
 */
const DEFAULT_COMMAND = "gentle-shell";

/** The manifest T1 ships in Koda's bundled runtime folder. */
const RUNTIME_MANIFEST = "koda-runtime.json";

/**
 * Windows (T2): Pi's npm install is a `.cmd` shim backed by JS. A shim is NEVER
 * executed (no cmd.exe, ever); the engine instead spawns Node with the package's
 * own CLI JS, resolved from the installed package's `package.json` `bin` map in
 * the bounded npm global prefixes (`%AppData%\npm`, then this Node's directory).
 * The entry must be relative, stay inside the package and be a real file —
 * anything else is refused (`undefined`, fail closed).
 */
function windowsPackageCliJs(binName, deps = {}) {
	const env = deps.env ?? process.env;
	const execPath = deps.execPath ?? process.execPath;
	const readFile = deps.readFileSync ?? readFileSync;
	const stat = deps.statSync ?? lstatSync;
	const prefixes = [];
	if (typeof env.AppData === "string" && path.isAbsolute(env.AppData)) prefixes.push(path.join(env.AppData, "npm"));
	if (typeof execPath === "string" && path.isAbsolute(execPath)) {
		const nodeDir = path.dirname(execPath);
		if (!prefixes.includes(nodeDir)) prefixes.push(nodeDir);
	}
	for (const prefix of prefixes) {
		const packageDir = path.join(prefix, ...PI_PACKAGE_SEGMENTS);
		let bin;
		try {
			const manifest = JSON.parse(readFile(path.join(packageDir, "package.json"), "utf8"));
			bin = manifest?.bin?.[binName];
		} catch {
			continue;
		}
		if (typeof bin !== "string" || bin.length === 0 || path.isAbsolute(bin)) continue;
		const resolved = path.resolve(packageDir, bin);
		const relative = path.relative(packageDir, resolved);
		if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
		try {
			const stats = stat(resolved);
			if (stats.isFile() && !stats.isSymbolicLink()) return resolved;
		} catch {}
	}
	return undefined;
}

/** The parsed `koda-runtime.json` of `runtime`, or undefined when absent/unreadable. */
function readRuntimeManifest(runtime, deps = {}) {
	try {
		return JSON.parse((deps.readFileSync ?? readFileSync)(path.join(runtime, RUNTIME_MANIFEST), "utf8"));
	} catch {
		return undefined;
	}
}

/**
 * T1b-b (S5): the `engramBin` of the runtime's manifest, validated like the
 * gentleShell script (relative, inside the runtime, real file, no symlinks).
 * Throws on a manifest that names an invalid one; callers skip the call when
 * the manifest does not name one at all.
 */
function engramBinPath(manifest, runtime, deps) {
	return runtimeScript(manifest?.engramBin, runtime, deps, "engramBin");
}

/**
 * T1b-b (S5), reshaped by T1c (S5/L11): the private memory environment of
 * Koda's DEFAULT bundled engine, in the shape of Gentle Dot's private mode
 * (isolation.ts:208-211). Koda's memory is ALWAYS private — there is no
 * user-store mode anymore: the store follows the engine's own HOME
 * (`<island>/home/.engram`, Engram's default when `ENGRAM_DATA_DIR` is unset),
 * the server runs on Koda's own port (`privateMemoryPort`: 7439, or the
 * parent's `ABITO_ENGRAM_PORT`), and the ONLY binary Koda resolves is the
 * pinned one its runtime manifest names (`engramBin`) — the former Gentle Dot
 * user-binary order (the parent's ENGRAM_BIN, the login shell, the known dirs)
 * is deleted, so the user's own Engram server and store (7437/7438, ~/.engram)
 * are never read, probed or inherited: the allowlist in isolatedEnv never copies
 * them in the first place, ENGRAM_* caller overrides are stripped for the
 * default engine (spawnChild, F4), and a missing or invalid `engramBin` never
 * blocks the engine (F7): the degradation (ENGRAM_STARTUP_POLICY=disabled, F1 —
 * the companion never falls back to a PATH `engram`) is logged, and the chat
 * starts without memory tools.
 * GENTLE_SHELL_PREFIX is NEVER set: the engine's companion comes from the
 * island seed, not from a user prefix. This env is only ever built for the
 * default engine (see spawnChild); a foreign `command` learns nothing about
 * Koda's memory.
 */
function bundledMemoryEnv(baseEnv, runtime, deps = {}) {
	const env = {};
	let bin;
	if (runtime !== undefined) {
		const manifest = readRuntimeManifest(runtime, deps);
		try {
			bin = engramBinPath(manifest, runtime, deps);
		} catch (error) {
			(deps.log ?? (() => {}))(`the bundled memory binary is not available (${error.message}); the chat starts without memory`);
		}
	} else {
		(deps.log ?? (() => {}))("the bundled runtime is unavailable; the chat starts without memory");
	}
	if (bin !== undefined) {
		env.ENGRAM_BIN = bin;
	} else {
		// F1: without the pinned binary the companion's ENGRAM_BIN would fall back
		// to `engram` on the inherited PATH (gentle-engram index.ts:27) — the user's
		// binary on a real machine. ENGRAM_STARTUP_POLICY=disabled makes the
		// companion fail closed (index.ts:30-31): no tools, no server spawn, no
		// PATH lookup — the bundled pinned binary stays the ONLY engram the default
		// engine can ever run, and the degradation log above stays true.
		env.ENGRAM_STARTUP_POLICY = "disabled";
	}
	// F3 (defence in depth): the port is validated here too, exactly like the
	// lifecycle in isolation.cjs — the user's own Engram ports (7437/7438) and
	// anything non-numeric are a configuration error, never an env the engine sees.
	const port = privateMemoryPort(baseEnv);
	assertPrivateMemoryPort(port);
	env.ENGRAM_PORT = port;
	// The private memory never phones home for updates (offline by design).
	env.ENGRAM_NO_UPDATE_CHECK = "1";
	return env;
}

/**
 * B1/F5: every path segment from `base` down through `parts` must be a real
 * directory (never a symlink or a file that would redirect work outside
 * `base`); absent segments are fine (they are created later, fail closed).
 * Throws on any symlink or non-directory segment; a missing segment ends the
 * walk (nothing can exist below it).
 */
function validateRealSegments(base, parts, deps) {
	const lstat = deps.lstatSync ?? lstatSync;
	const resolvedBase = path.resolve(base);
	for (let i = 0; i <= parts.length; i++) {
		const at = i === 0 ? resolvedBase : path.join(resolvedBase, ...parts.slice(0, i));
		const rel = path.relative(resolvedBase, at);
		if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
			throw new Error(`refusing a path outside ${resolvedBase}`);
		}
		let stats;
		try {
			stats = lstat(at);
		} catch (error) {
			if (error?.code === "ENOENT") return; // later segments will be created
			throw error;
		}
		if (stats.isSymbolicLink()) throw new Error(`refusing symlinked segment: ${at}`);
		if (!stats.isDirectory()) throw new Error(`refusing non-directory segment: ${at}`);
	}
}

/**
 * F4 (re-verified): a content-shaped fingerprint of a real file tree — the
 * package version plus one line per file as `<relative-path>:<size>:<sha256>`
 * (sorted), hashed once, computed with lstat + file reads (a symlink or a
 * non-regular entry anywhere, or an unreadable/unhashable tree, yields
 * undefined so the caller treats it as "not equal" and repairs). Size alone is
 * NOT enough: a companion upgrade with same-size files (0.4.2 → 0.4.3) and a
 * zero-filled same-size file must both fail the equality and be repaired; the
 * version is folded in so a version bump can never pass on identical bytes.
 * The seed idempotency check compares the bundled companion's fingerprint with
 * the installed one, so a partial or corrupt copy is always repaired instead
 * of surviving on version or size equality alone.
 */
function treeFingerprint(dir, deps = {}, version = "") {
	const lstat = deps.lstatSync ?? lstatSync;
	const readdir = deps.readdirSync ?? readdirSync;
	const readFile = deps.readFileSync ?? readFileSync;
	try {
		const stats = lstat(dir);
		if (stats.isSymbolicLink() || !stats.isDirectory()) return undefined;
		const lines = [];
		const walk = (abs, rel) => {
			for (const entry of readdir(abs)) {
				const child = path.join(abs, entry);
				const childRel = rel === "" ? entry : `${rel}/${entry}`;
				const childStats = lstat(child);
				if (childStats.isSymbolicLink() || (!childStats.isDirectory() && !childStats.isFile())) return undefined;
				if (childStats.isDirectory()) {
					const nested = walk(child, childRel);
					if (nested === undefined) return undefined;
				} else {
					const hash = createHash("sha256").update(readFile(child)).digest("hex");
					lines.push(`${childRel}:${childStats.size}:${hash}`);
				}
			}
			return lines;
		};
		const out = walk(dir, "");
		if (out === undefined) return undefined;
		return createHash("sha256").update(`${version}\n${out.sort().join("\n")}`).digest("hex");
	} catch {
		return undefined;
	}
}

/**
 * T1b-b (S5): seeds the bundled Engram companion into the island's agent dir
 * before the first spawn, the result gentle-shell's auto-setup would produce
 * (Gentle Dot isolation.ts:104-137, 208-217) but offline: the companion
 * `<runtime>/node_modules/gentle-engram` is copied — real files, never links,
 * any symlink refused, everything through the fail-closed private writes — to
 * `<agentDir>/npm/node_modules/gentle-engram`, and
 * `packages: ["npm:gentle-engram@<version>"]` is merged into
 * `<agentDir>/settings.json` (PI_OFFLINE makes Pi load it with no network;
 * profiles.cjs preserves foreign keys when it writes its model defaults).
 *
 * B1 (verifier): every component from the island's agent dir down to the
 * target — and from the runtime root down to the source (F5) — is validated
 * BEFORE any destructive operation, so a symlinked segment can never make the
 * seed delete or write a gentle-engram folder outside the island. F4: the copy
 * itself is atomic — staged in a temp sibling inside the validated parent,
 * verified against the source's fingerprint, then renamed into place; a
 * failing copy leaves no partial target, and the refresh never follows a link
 * (an existing target is first renamed to a sibling of the validated parent,
 * then removed — rmSync never walks a path that could leave the island).
 * Idempotent: a tree-equal install is left as it is; anything else (a partial
 * copy among them) is repaired whole. Throws on refused/refusing targets (a
 * planted symlink is never written through); a runtime without the companion
 * is a `{ ok: false }` report, never a hard error (the engine still starts).
 */
function seedEngramCompanion(runtime, agentDir, deps = {}) {
	const lstat = deps.lstatSync ?? lstatSync;
	const readFile = deps.readFileSync ?? readFileSync;
	const source = path.join(runtime, "node_modules", "gentle-engram");
	// F5: validate the runtime side first, like runtimeScript validates
	// gentleShell — missing segments mean no bundled companion (a report, not
	// an error); a symlink there is a corrupted runtime and fails closed.
	let sourceMissing = false;
	try {
		validateRealSegments(runtime, ["node_modules", "gentle-engram"], deps);
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
		sourceMissing = true;
	}
	if (sourceMissing) {
		return { ok: false, reason: `the bundled runtime has no gentle-engram companion (ENOENT)` };
	}
	let sourceStats;
	try {
		sourceStats = lstat(source);
	} catch (error) {
		if (error?.code === "ENOENT") return { ok: false, reason: "the bundled runtime has no gentle-engram companion (ENOENT)" };
		throw error;
	}
	if (sourceStats.isSymbolicLink() || !sourceStats.isDirectory()) {
		return { ok: false, reason: "the bundled gentle-engram companion is not a real directory" };
	}
	let pkg;
	try {
		pkg = JSON.parse(readFile(path.join(source, "package.json"), "utf8"));
	} catch (error) {
		return { ok: false, reason: `cannot read the companion's package.json: ${error.message}` };
	}
	if (pkg?.name !== "gentle-engram" || typeof pkg.version !== "string" || pkg.version === "") {
		return { ok: false, reason: "the bundled companion package.json does not name gentle-engram" };
	}
	// B1: validate the whole island path down to the parent BEFORE anything is
	// read, renamed or destroyed: a symlinked <agentDir>/npm or .../node_modules
	// is refused and the folder it leads to is never touched.
	validateRealSegments(agentDir, ["npm", "node_modules"], deps);
	const modules = path.join(agentDir, "npm", "node_modules");
	const target = path.join(modules, "gentle-engram");
	let existing;
	try {
		existing = lstat(target);
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
	if (existing?.isSymbolicLink()) throw new Error(`refusing symlinked companion target: ${target}`);
	if (existing && !existing.isDirectory()) throw new Error(`refusing non-directory companion target: ${target}`);
	// F4: same version + same content (sha256 per file) -> nothing to repair.
	const sourceFingerprint = treeFingerprint(source, deps, pkg.version);
	if (existing && sourceFingerprint !== undefined && treeFingerprint(target, deps, pkg.version) === sourceFingerprint) {
		mergeCompanionSettings(agentDir, pkg.version, deps);
		return { ok: true };
	}
	// Real copy, staged whole and renamed into place; the source tree is fully
	// validated BEFORE anything is written, so a refused copy leaves the island
	// untouched.
	validateRealTree(source, deps);
	ensurePrivateDir(modules);
	const staging = path.join(modules, `.gentle-engram.new-${process.pid}-${Date.now()}`);
	try {
		copyPrivateTree(source, staging, deps);
		if (sourceFingerprint === undefined || treeFingerprint(staging, deps, pkg.version) !== sourceFingerprint) {
			throw new Error("the staged companion copy does not match the bundled one");
		}
	} catch (error) {
		try {
			rmSync(staging, { recursive: true, force: true });
		} catch (cleanup) {
			error.cleanUpError = cleanup;
		}
		throw error;
	}
	if (existing) {
		// Refresh (F4/B1): the old tree is renamed to a sibling inside the
		// validated parent and only then removed — never a path rmSync could
		// follow out of the island, never a link followed.
		const replaced = path.join(modules, `.gentle-engram.old-${process.pid}-${Date.now()}`);
		renameSync(target, replaced);
		try {
			renameSync(staging, target);
		} catch (error) {
			try {
				renameSync(replaced, target); // restore the previous install
			} catch (restore) {
				error.restoreError = restore;
			}
			throw error;
		}
		rmSync(replaced, { recursive: true, force: true });
	} else {
		renameSync(staging, target);
	}
	mergeCompanionSettings(agentDir, pkg.version, deps);
	return { ok: true };
}

/** Refuses any symlink (or non-regular, non-directory entry) inside `dir`. */
function validateRealTree(dir, deps) {
	const lstat = deps.lstatSync ?? lstatSync;
	const readdir = deps.readdirSync ?? readdirSync;
	const stats = lstat(dir);
	if (stats.isSymbolicLink()) throw new Error(`refusing symlink in the companion: ${dir}`);
	if (!stats.isDirectory()) {
		if (!stats.isFile()) throw new Error(`refusing non-regular companion entry: ${dir}`);
		return;
	}
	for (const entry of readdir(dir)) validateRealTree(path.join(dir, entry), deps);
}

/** Recursively copies a real file tree through the fail-closed private writes. */
function copyPrivateTree(source, target, deps) {
	const lstat = deps.lstatSync ?? lstatSync;
	const readFile = deps.readFileSync ?? readFileSync;
	const readdir = deps.readdirSync ?? readdirSync;
	const stats = lstat(source);
	if (stats.isSymbolicLink()) throw new Error(`refusing symlink in the companion: ${source}`);
	if (stats.isDirectory()) {
		ensurePrivateDir(target);
		for (const entry of readdir(source)) copyPrivateTree(path.join(source, entry), path.join(target, entry), deps);
		return;
	}
	if (!stats.isFile()) throw new Error(`refusing non-regular companion entry: ${source}`);
	writePrivateFile(target, readFile(source), { mode: 0o600 });
}

/**
 * Merges the pinned companion into `<agentDir>/settings.json`: every other key
 * is preserved, stale `npm:gentle-engram@…` pins are replaced by the bundled
 * one, and anything else in `packages` (and every other key — the model
 * defaults profiles.cjs writes, gentle-shell's own `extensions` entries) stays.
 */
function mergeCompanionSettings(agentDir, version, deps = {}) {
	const settingsFile = path.join(agentDir, "settings.json");
	// Fail closed before reading: a symlink planted at settings.json is never
	// followed (its content would land in the parse error otherwise).
	const lstat = deps.lstatSync ?? lstatSync;
	let existing;
	try {
		existing = lstat(settingsFile);
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
	if (existing !== undefined && (existing.isSymbolicLink() || !existing.isFile())) {
		throw new Error(`refusing to merge through a non-regular settings.json: ${settingsFile}`);
	}
	let settings = {};
	try {
		const parsed = JSON.parse((deps.readFileSync ?? readFileSync)(settingsFile, "utf8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("settings.json is not an object; refusing to touch it");
		}
		settings = parsed;
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
	const pin = `npm:gentle-engram@${version}`;
	const packages = Array.isArray(settings.packages) ? settings.packages.filter((entry) => !/^npm:gentle-engram@/.test(typeof entry === "string" ? entry : entry?.source ?? "")) : [];
	if (!packages.some((entry) => (typeof entry === "string" ? entry : entry?.source) === pin)) packages.push(pin);
	settings.packages = packages;
	writePrivateFile(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
}

function positiveBudget(value, name, max = 2_147_483_647) {
	if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`invalid ${name}`);
	return value;
}

/**
 * Koda's bundled runtime root (T1): the directory of the Node running the
 * daemon when it carries `koda-runtime.json` — the installed app always runs
 * the daemon on its own bundled Node, so this finds the runtime without any
 * PATH or npm-prefix search. Pure and injectable for tests; undefined when the
 * daemon does not run on a bundled runtime (a dev checkout).
 */
function runtimeRoot(deps = {}) {
	const execPath = deps.execPath ?? process.execPath;
	const exists = deps.existsSync ?? existsSync;
	if (typeof execPath === "string" && path.isAbsolute(execPath) && exists(path.join(path.dirname(execPath), RUNTIME_MANIFEST))) {
		return path.dirname(execPath);
	}
	return undefined;
}

/** A real, non-symlink regular file (the runtime build ships no links; fail closed). */
function isRealFile(file, deps) {
	try {
		const stats = (deps.lstatSync ?? lstatSync)(file);
		return stats.isFile() && !stats.isSymbolicLink();
	} catch {
		return false;
	}
}

/**
 * A relative path inside the runtime that must be a real file — anything else
 * is refused (undefined shape, fail closed, like windowsPackageCliJs). A
 * symlink at ANY path segment between the runtime root and the file is refused
 * too (like the Rust runtime's inside_file): a link part-way down could
 * redirect the file outside the runtime. `what` names the manifest key in
 * errors ("gentleShell", "engramBin").
 */
function runtimeScript(rel, runtime, deps, what) {
	if (typeof rel !== "string" || rel.length === 0 || path.isAbsolute(rel)) {
		throw new Error(`${RUNTIME_MANIFEST} names no ${what}`);
	}
	const script = path.resolve(runtime, rel);
	const within = path.relative(runtime, script);
	if (within === "" || within === ".." || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) {
		throw new Error(`${RUNTIME_MANIFEST} names a ${what} outside the runtime`);
	}
	const lstat = deps.lstatSync ?? lstatSync;
	const parts = within.split(path.sep);
	for (let i = 0; i < parts.length; i++) {
		const segment = path.join(runtime, ...parts.slice(0, i + 1));
		let stats;
		try {
			stats = lstat(segment);
		} catch (error) {
			throw new Error(`the bundled runtime is missing ${parts.slice(0, i + 1).join(path.sep)} (${error.code ?? error.message})`);
		}
		if (stats.isSymbolicLink()) {
			throw new Error(`${RUNTIME_MANIFEST} names a ${what} behind a symlink: ${segment}`);
		}
	}
	if (!isRealFile(script, deps)) {
		throw new Error(`the bundled runtime is missing ${rel}`);
	}
	return script;
}

function gentleShellScript(manifest, runtime, deps) {
	return runtimeScript(manifest?.gentleShell, runtime, deps, "gentleShell");
}

/**
 * The engine Koda launches by default: Gentle Shell from Koda's own bundled
 * runtime, never one from PATH or an npm prefix (Gentle Dot
 * `bundledGentleShell`). Linux/macOS: the runtime's `gentle-shell` launcher.
 * Windows: the bundled node.exe plus the script `koda-runtime.json` names
 * (`gentleShell`), mirroring how the old default `pi` resolved on Windows.
 * Anything missing from an existing runtime is a hard error, never a fall-back.
 * Pure and injectable for tests.
 */
function bundledGentleShell(deps = {}) {
	const platform = deps.platform ?? process.platform;
	const runtime = runtimeRoot(deps);
	if (!runtime) {
		throw new Error(
			`no bundled runtime found next to the daemon's Node (${deps.execPath ?? process.execPath}); set "command" in the island config.json to override the default engine`,
		);
	}
	if (platform === "win32") {
		const nodeExe = path.join(runtime, "node.exe");
		if (!isRealFile(nodeExe, deps)) {
			throw new Error(`the bundled runtime is missing node.exe: ${runtime}`);
		}
		let manifest;
		try {
			manifest = JSON.parse((deps.readFileSync ?? readFileSync)(path.join(runtime, RUNTIME_MANIFEST), "utf8"));
		} catch (error) {
			throw new Error(`cannot read ${path.join(runtime, RUNTIME_MANIFEST)}: ${error.message}`);
		}
		return { command: nodeExe, commandArgs: [gentleShellScript(manifest, runtime, deps)] };
	}
	const launcher = path.join(runtime, "gentle-shell");
	if (!isRealFile(launcher, deps)) {
		throw new Error(`the bundled runtime is missing the gentle-shell launcher: ${runtime}`);
	}
	return { command: launcher, commandArgs: [] };
}

/**
 * The bundled runtime's gentle-pi version (T1 manifest), or undefined when the
 * daemon is not on a bundled runtime or the manifest cannot be read:
 * informational only (the `.gentle-shell-home` marker names it).
 */
function gentlePiVersion(deps = {}) {
	const runtime = runtimeRoot(deps);
	if (!runtime) return undefined;
	try {
		const manifest = JSON.parse((deps.readFileSync ?? readFileSync)(path.join(runtime, RUNTIME_MANIFEST), "utf8"));
		return typeof manifest.gentlePi === "string" ? manifest.gentlePi : undefined;
	} catch {
		return undefined;
	}
}
/** Cap for one unframed child record; anything larger is discarded, never buffered. */
const DEFAULT_MAX_RECORD_BYTES = 1_048_576;

/**
 * Strict JSONL framing for the RPC protocol: records are split on LF bytes
 * only. Node's `readline` is deliberately avoided because it also splits on
 * U+2028 and U+2029, which are valid inside JSON strings.
 */
class JsonlDecoder {
	constructor(onRecord, onMalformed = () => {}, onOversized = () => {}, maxBytes = DEFAULT_MAX_RECORD_BYTES) {
		/** Buffered bytes as a list of chunks; never concatenated beyond one line (≤ cap). */
		this.chunks = [];
		this.buffered = 0;
		/** While true, everything up to the next LF belongs to an oversized line and is dropped. */
		this.discarding = false;
		this.onRecord = onRecord;
		this.onMalformed = onMalformed;
		this.onOversized = onOversized;
		this.maxBytes = maxBytes;
	}

	push(chunk) {
		if (this.discarding) {
			// Remainder of an oversized fragmented line: consume up to its LF,
			// never treating the tail as a new record.
			const lf = chunk.indexOf(0x0a);
			if (lf === -1) return;
			this.discarding = false;
			chunk = chunk.subarray(lf + 1);
			if (chunk.length === 0) return;
		}
		this.chunks.push(chunk);
		this.buffered += chunk.length;
		this.drain();
	}

	drain() {
		for (;;) {
			const lfOffset = this.indexOfLf();
			if (lfOffset === -1) {
				// No complete line buffered: reject on length BEFORE any framing
				// attempt if the unframed bytes already exceed the cap.
				if (this.buffered > this.maxBytes) {
					this.reset();
					this.discarding = true;
					this.onOversized();
				}
				return;
			}
			// A complete line is buffered: check its byte length BEFORE
			// toString/JSON.parse, then keep whatever follows intact.
			if (lfOffset > this.maxBytes) {
				this.consume(lfOffset + 1);
				this.onOversized();
				continue;
			}
			let end = lfOffset;
			if (end > 0 && this.byteAt(end - 1) === 0x0d) end -= 1;
			const line = this.takeBytes(end);
			this.consume(lfOffset + 1);
			if (line.trim() !== "") this.emit(line);
		}
	}

	indexOfLf() {
		let offset = 0;
		for (const chunk of this.chunks) {
			const index = chunk.indexOf(0x0a);
			if (index !== -1) return offset + index;
			offset += chunk.length;
		}
		return -1;
	}

	byteAt(index) {
		for (const chunk of this.chunks) {
			if (index < chunk.length) return chunk[index];
			index -= chunk.length;
		}
		return undefined;
	}

	/** Drops the first `n` buffered bytes without decoding them. */
	consume(n) {
		let taken = 0;
		while (n > 0 && this.chunks.length > 0) {
			const first = this.chunks[0];
			if (first.length <= n) {
				taken += first.length;
				n -= first.length;
				this.chunks.shift();
			} else {
				this.chunks[0] = first.subarray(n);
				taken += n;
				n = 0;
			}
		}
		this.buffered -= taken;
	}

	/** The first `n` buffered bytes as text (≤ cap, so any join is bounded). */
	takeBytes(n) {
		if (n === 0) return "";
		const first = this.chunks[0];
		if (first.length >= n) return first.toString("utf8", 0, n);
		const parts = [];
		let left = n;
		for (const chunk of this.chunks) {
			if (left <= 0) break;
			const use = Math.min(left, chunk.length);
			parts.push(use === chunk.length ? chunk : chunk.subarray(0, use));
			left -= use;
		}
		return Buffer.concat(parts).toString("utf8");
	}

	reset() {
		this.chunks = [];
		this.buffered = 0;
	}

	emit(line) {
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			this.onMalformed(line);
			return;
		}
		this.onRecord(record);
	}
}

function encodeRecord(record) {
	return Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
}

/**
 * The island agent engine. Start with `start()`, send commands with
 * `request()` (correlated, timeout-bounded) or `send()` (no response
 * expected), stop with `stop()`.
 */
class AgentEngine extends EventEmitter {
	constructor(options = {}) {
		super();
		/**
		 * Executable to run. The default is Koda's own bundled Gentle Shell
		 * (DEFAULT_COMMAND, resolved only from Koda's runtime, never PATH — see
		 * spawnCommandPrefix); the island config.json `command` overrides it.
		 */
		this.command = options.command ?? DEFAULT_COMMAND;
		this.commandArgs = options.commandArgs ?? [];
		this.extraArgs = options.extraArgs ?? [];
		/** Working directory override; defaults to the owned island workspace. */
		this.cwdOption = options.cwd;
		/**
		 * Arbitrary working folder the user prefers (U4 refines validation and
		 * restart semantics). When set, nothing is ever written there; the
		 * memory-project pin travels via `ABITO_MEMORY_PROJECT` and the
		 * identity prompt instead. See README.md for enforcement limits.
		 */
		this.workspacePath = options.workspacePath;
		this.root = options.root ?? defaultIslandRoot(options.env ?? process.env);
		this.baseEnv = options.env ?? process.env;
		this.envOverrides = options.envOverrides ?? {};
		this.identityPath = options.identityPath ?? path.join(__dirname, "..", "identity.md");
		/** Dependency injection for bundled-runtime resolution (tests); production resolves against the real process. */
		this.runtimeDeps = options.runtimeDeps ?? {};
		this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
		this.stableMs = options.stableMs ?? DEFAULT_STABLE_MS;
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
		this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
		this.switchTimeoutMs = options.switchTimeoutMs ?? DEFAULT_SWITCH_TIMEOUT_MS;
		this.reopenAttempts = positiveBudget(options.reopenAttempts ?? DEFAULT_REOPEN_ATTEMPTS, "reopenAttempts");
		/** Consecutive uncertain reopens of one saved conversation: { sessionFile, count }. */
		this.reopenFailures = undefined;
		/** The pending first-start retry wait ({ timer, resolve }), cancelled by stop(). */
		this.startRetry = undefined;
		this.maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
		this.turnTimeoutMs = positiveBudget(options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS, "turnTimeoutMs");
		this.maxTurnIterations = positiveBudget(options.maxTurnIterations ?? DEFAULT_MAX_TURN_ITERATIONS, "maxTurnIterations");
		this.abortGraceMs = positiveBudget(options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS, "abortGraceMs");
		this.turn = undefined;
		this.recycling = false;
		this.sessionFile = undefined;
		// K2-05 T3 (S2): the earlier session files of the open chat, oldest first
		// (Gentle Dot's chains): rotation links the files so history keeps reading
		// across the boundary, and the chain survives restarts in state.json.
		this.chains = {};
		this.sessionChange = undefined;
		this.recoverySessionFile = undefined;
		this.sessionEpoch = 0;
		this.turnCounter = 0;
		this.log = options.log ?? (() => {});
		this.status = "stopped";
		this.child = undefined;
		this.island = undefined;
		this.identityFile = undefined;
		this.pending = new Map();
		this.closeWaiters = [];
		this.nextId = 0;
		this.attempts = 0;
		this.spawnedAt = 0;
		this.stopping = false;
		this.restarting = false;
		this.restartTimer = undefined;
		this.initialization = undefined;
		this.initialStartPending = false;
	}

	get pid() {
		return this.child?.pid;
	}

	/** The earlier session files of the open chat, oldest first (K2-05 T3 rotation chains). */
	get previousSessions() {
		return (this.sessionFile && this.chains[this.sessionFile]) || [];
	}

	/** Records that `sessionFile` continues the chat held in `previous` (oldest first). */
	linkSessions(sessionFile, previous) {
		if (typeof sessionFile !== "string" || !Array.isArray(previous) || previous.length === 0) return;
		// K2-05 T4 U1 verifier fix: only owned session files enter a chain — the same
		// rule the history read applies (regular, non-symlink, inside the sessions dir)
		// — so a planted symlink or an outside path is refused BEFORE it is ever
		// persisted to state.json, not just skipped at read time.
		const chain = previous.filter((p) => typeof p === "string" && this.isOwnedSessionFile(p));
		if (chain.length === 0) {
			this.log(`session chain refused: none of the ${previous.length} linked paths is an owned session file`);
			return;
		}
		if (chain.length !== previous.length) this.log(`session chain: ${previous.length - chain.length} linked path(s) refused, not owned session files`);
		this.chains[sessionFile] = chain;
		// Gentle Dot (supervisor.ts:137): linking alone never persists the seed.
		// state.json keeps pointing at the session the engine actually holds, so
		// a crash or a failed switch before the seed is opened makes the next
		// boot reopen the USER's session, never an orphan seed. When the engine
		// confirms the switch (changeSession / startup reopen), persistSession
		// writes the new open session together with the chain.
		if (this.sessionFile) this.persistSession(this.sessionFile);
		// T4 U1: the server re-broadcasts history once the open session carries the
		// linked chain (sessions_linked fires only when the linked file becomes or
		// already is the open one; see server.cjs onEngineHistoryEvent).
		this.emit("sessions_linked", { sessionFile });
	}

	/** Ensures the private island, spawns the agent and waits for its first `get_state`. */
	async start() {
		if (this.status !== "stopped") throw new Error(`cannot start from status "${this.status}"`);
		this.stopping = false;
		// An initial spawn that never becomes ready surfaces to the caller; only
		// a child that reached ready is supervised with crash restarts.
		this.initialStartPending = true;
		this.island = ensureIsland(this.root);
		// Mark Koda's own engine home as gentle-shell's BEFORE the first spawn
		// (T2): gentle-shell runs its first-run setup only in a home it created,
		// and Koda writes auth/mcp/extension files there first. Informational,
		// logged-only on failure; an existing marker is left as it is.
		claimEngineHome(this.island.agentDir, gentlePiVersion(), this.log);
		// T1b-b (S5): seed the bundled Engram companion into the engine's home
		// before the first spawn — the offline equivalent of gentle-shell's auto
		// setup. Only for Koda's own default engine, only from the bundled
		// runtime. Logged-only on failure: the chat still works without memory.
		if (this.command === DEFAULT_COMMAND) {
			const runtime = runtimeRoot(this.runtimeDeps);
			if (runtime !== undefined) {
				try {
					const seeded = seedEngramCompanion(runtime, this.island.agentDir, this.runtimeDeps);
					if (!seeded.ok) this.log(`could not seed the bundled memory companion: ${seeded.reason}`);
				} catch (error) {
					this.log(`could not seed the bundled memory companion: ${error.message}`);
				}
			}
		}
		this.setStatus("starting");
		try {
			// K2-05 boot reopen (L44): an uncertain reopen of the saved conversation
			// is never reported ready on another session; the first start retries it
			// on a fresh child with the restart backoff (crash restarts already do),
			// until the reopen attempts run out and the linked fallback takes over.
			for (let attempt = 0; ; attempt += 1) {
				try {
					await this.spawnAndInitialize();
					break;
				} catch (error) {
					if (!error?.reopenUncertain || this.stopping) throw error;
					this.log(`${error.message}; retrying on a fresh engine`);
					if (this.child) await new Promise((resolve) => this.closeWaiters.push(resolve));
					if (this.stopping) break;
					const delay = this.backoffMs[Math.min(attempt, this.backoffMs.length - 1)] ?? 1000;
					await new Promise((resolve) => {
						this.startRetry = { resolve, timer: setTimeout(resolve, delay) };
					});
					this.startRetry = undefined;
					if (this.stopping) break;
					this.initialStartPending = true;
				}
			}
			if (this.stopping && this.status !== "ready") this.setStatus("stopped");
		} catch (error) {
			this.initialStartPending = false;
			this.setStatus("stopped");
			throw error;
		}
	}

	/** Busy includes cancellation/draining until the replacement child has reached ready. */
	get busy() {
		return this.turn !== undefined || this.sessionChange !== undefined || this.recycling;
	}

	/** RPC ACKs remain separate from a prompt's full-turn lifecycle. */
	async request(command, timeoutMs = this.requestTimeoutMs) {
		if (this.status !== "ready") throw new Error("engine is not ready");
		if (command.type === "abort" && this.turn) return this.cancelTurn(this.turn, "cancelled", timeoutMs);
		if (["prompt", "new_session", "switch_session"].includes(command.type) && this.busy) throw new Error("engine is busy");
		if (command.type === "new_session" || command.type === "switch_session") return this.changeSession(command, timeoutMs);
		const child = this.child;
		if (command.type === "prompt" && !this.sessionFile) {
			const state = await this.rawRequest({ type: "get_state" }, this.switchTimeoutMs);
			if (child !== this.child || this.status !== "ready" || this.busy) throw new Error("engine is busy or not ready");
			this.sessionFile = state?.data?.sessionFile;
		}
		const turn = command.type === "prompt" ? this.beginTurn(child) : undefined;
		try {
			return await this.rawRequest(command, timeoutMs);
		} catch (error) {
			// Timeout/ACK loss is not proof that Pi did not apply the prompt. Cut off,
			// never replay, and do not let an old rejection cancel a newer generation.
			if (turn && this.turn === turn && !turn.cancelled) this.cancelTurn(turn, "failed").catch(() => {});
			throw error;
		}
	}

	async changeSession(command, timeoutMs) {
		// K2-05 F3: only a switch_session (the rotation's move; no server verb ever
		// sends one) marks a holdable switch. A user reset (new_session, the
		// new_conversation verb) keeps answering busy with no side effects.
		const change = { child: this.child, sessionFile: this.sessionFile, switching: command.type === "switch_session" };
		this.sessionChange = change; // Acquire before the first write/await.
		this.emit("status", { state: this.status }); // Canonical daemon/server busy guard.
		const checkGeneration = () => {
			if (this.sessionChange !== change || this.child !== change.child || this.stopping) {
				throw new Error("agent generation changed during session switch");
			}
		};
		try {
			const response = await this.rawRequest(command, timeoutMs);
			checkGeneration();
			// A reset ACK alone does not prove which session Pi now owns.
			const state = await this.rawRequest({ type: "get_state" }, this.switchTimeoutMs);
			checkGeneration();
			const sessionFile = state?.data?.sessionFile;
			if (!this.isOwnedSessionFile(sessionFile, true)) throw new Error("agent session is unavailable");
			if (command.type === "switch_session" && path.resolve(sessionFile) !== path.resolve(command.sessionPath)) {
				throw new Error("agent session switch was not confirmed");
			}
			this.sessionFile = sessionFile;
			this.sessionEpoch += 1;
			this.persistSession(sessionFile);
			this.sessionChange = undefined;
			this.emit("status", { state: this.status });
			// T4 U1: the open session changed (a rotation switch confirmed, or the
			// rotation fallback's fresh session). The server decides whether the
			// change carries a chain worth re-broadcasting.
			this.emit("session_changed", { sessionFile });
			return response;
		} catch (error) {
			if (this.sessionChange === change && this.child === change.child && !this.stopping) {
				// Applied-but-unacknowledged resets are ambiguous: cut off, reopen
				// the last verified session, and NEVER retry the reset automatically.
				this.recycling = true;
				this.recoverySessionFile = change.sessionFile;
				this.sessionFile = undefined;
				this.setStatus("restarting");
				change.child.kill("SIGKILL");
			}
			throw error;
		}
	}

	beginTurn(child) {
		if (!child || !this.isOwnedSessionFile(this.sessionFile, true)) throw new Error("agent session is unavailable");
		const turn = { child, sessionFile: this.sessionFile, epoch: this.sessionEpoch,
			id: ++this.turnCounter, startedAt: performance.now(), iterations: 0, cancelled: false };
		this.turn = turn;
		this.persistSession(turn.sessionFile);
		const deadline = () => {
			if (this.turn !== turn || turn.cancelled) return;
			const remaining = this.turnTimeoutMs - (performance.now() - turn.startedAt);
			if (remaining > 0) turn.timer = setTimeout(deadline, remaining);
			else this.cancelTurn(turn, "time_limit").catch(() => {});
		};
		turn.timer = setTimeout(deadline, this.turnTimeoutMs);
		return turn;
	}

	clearTurn() {
		clearTimeout(this.turn?.timer);
		clearTimeout(this.turn?.graceTimer);
		this.turn = undefined;
	}

	cancelTurn(turn, reason, timeoutMs = this.requestTimeoutMs) {
		if (turn.cancelled) return turn.abort;
		if (this.turn !== turn || this.child !== turn.child || this.stopping) return Promise.resolve();
		turn.cancelled = true;
		this.recycling = true;
		this.recoverySessionFile = turn.sessionFile;
		clearTimeout(turn.timer);
		// F2: a cancelled turn never reaches message_end, so the held delta tail
		// the stream filter still holds would be dropped. Flush it once, as a
		// final delta, BEFORE the rest of the turn is shut down. Daemon-owned: the
		// marker is a Symbol and child records of this type are dropped below.
		this.emit("event", { type: "message_flush", flush: MESSAGE_FLUSH });
		// Admission closes synchronously, before any asynchronous abort ACK.
		this.setStatus("restarting");
		this.emit("turn_cancelled", { reason });
		turn.graceTimer = setTimeout(() => this.recycleTurn(turn), this.abortGraceMs);
		turn.abort = this.rawRequest({ type: "abort" }, timeoutMs);
		turn.abort.catch(() => {});
		return turn.abort;
	}

	/**
	 * #378 live interruption: interrupts the active turn for a daemon-level
	 * reason (the global pause turned on, or the user's access was revoked).
	 * Same path as an explicit abort: admission closes, open asks resolve, the
	 * child is recycled and the session reopens; no prompt is ever replayed.
	 * Returns false (and sends nothing) when no turn is active.
	 */
	interruptTurn(reason) {
		if (!this.turn || this.turn.cancelled) return false;
		this.cancelTurn(this.turn, reason).catch(() => {});
		return true;
	}

	recycleTurn(turn) {
		if (this.turn !== turn || this.child !== turn.child || this.stopping) return;
		clearTimeout(turn.graceTimer);
		// Recycle even after settlement: untagged Pi events cannot safely cross a
		// cancelled turn boundary. Existing close supervision reopens the session.
		turn.child.kill("SIGKILL");
	}

	/** Writes a record that has no correlated response (control records, extension UI answers). */
	send(record) {
		const stdin = this.child?.stdin;
		if (this.status !== "ready" || !stdin?.writable) throw new Error("engine is not ready");
		stdin.write(encodeRecord(record));
	}

	/** Stops the agent, disables crash restarts, and terminates it gracefully then forcibly. */
	async stop() {
		this.stopping = true;
		this.clearTurn();
		this.sessionChange = undefined;
		this.recoverySessionFile = undefined;
		this.recycling = false;
		clearTimeout(this.restartTimer);
		this.restartTimer = undefined;
		if (this.startRetry) {
			clearTimeout(this.startRetry.timer);
			this.startRetry.resolve();
			this.startRetry = undefined;
		}
		const initializing = this.initialization?.promise;
		const child = this.child;
		if (!child) {
			if (initializing) await initializing.catch(() => {});
			this.setStatus("stopped");
			return;
		}
		const closed = new Promise((resolve) => this.closeWaiters.push(resolve));
		child.stdin?.end();
		const term = setTimeout(() => child.kill("SIGTERM"), this.stopTimeoutMs);
		const kill = setTimeout(() => child.kill("SIGKILL"), this.stopTimeoutMs + 2000);
		await closed;
		clearTimeout(term);
		clearTimeout(kill);
		if (initializing) await initializing.catch(() => {});
	}

	/** Runs before every spawn (first start, restart): regenerates private files in the island. */
	prepareSpawn() {
		if (this.identityPath) {
			this.identityFile = path.join(this.island.root, "identity.md");
			// Fail-closed private write: refuses symlinked/permissive/foreign targets,
			// lands via O_EXCL|O_NOFOLLOW temp rename at 0600.
			writePrivateFile(this.identityFile, readFileSync(this.identityPath));
		} else {
			this.identityFile = undefined;
		}
	}

	/** The persisted session file of the open conversation, if any; the rotation chains ride along. */
	readPersistedSession() {
		try {
			const saved = JSON.parse(readFileSync(path.join(this.island.root, "state.json"), "utf8"));
			// K2-05 T3: every restored chain entry must be an owned session path —
			// anything else is dropped, never honoured.
			if (saved.chains && typeof saved.chains === "object" && !Array.isArray(saved.chains)) {
				for (const [file, previous] of Object.entries(saved.chains)) {
					if (
						Array.isArray(previous) && previous.length > 0 && previous.every((p) => typeof p === "string")
						&& this.isOwnedSessionFile(file, true) && previous.every((p) => this.isOwnedSessionFile(p, true))
					) {
						this.chains[file] = previous;
					}
				}
			}
			return typeof saved.sessionFile === "string" ? saved.sessionFile : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * A session path is honoured only inside the private sessions dir, regular, owned, no symlink.
	 * `allowMissing` accepts a not-yet-written file directly in that dir: real Pi reports its
	 * session path at startup/reset but writes the file only after the first message.
	 */
	isOwnedSessionFile(sessionFile, allowMissing = false) {
		if (typeof sessionFile !== "string") return false;
		const resolved = path.resolve(sessionFile);
		if (!resolved.startsWith(`${this.island.sessions}${path.sep}`)) return false;
		let stats;
		try {
			stats = lstatSync(resolved);
		} catch (error) {
			return allowMissing && error?.code === "ENOENT" && path.dirname(resolved) === path.resolve(this.island.sessions);
		}
		if (stats.isSymbolicLink() || !stats.isFile()) return false;
		return typeof process.getuid !== "function" || stats.uid === process.getuid();
	}

	persistSession(sessionFile) {
		if (typeof sessionFile !== "string" || sessionFile === "") return;
		try {
			writePrivateFile(path.join(this.island.root, "state.json"), `${JSON.stringify({ sessionFile, chains: this.chains })}\n`);
		} catch (error) {
			this.log(`could not persist the session file: ${error.message}`);
		}
	}

	spawnAndInitialize() {
		if (this.initialization || this.child) return Promise.reject(new Error("agent initialization is already owned"));
		const child = this.spawnChild();
		const initialization = { child };
		this.initialization = initialization;
		const run = async () => {
			const state = await this.rawRequest({ type: "get_state" }, this.startTimeoutMs);
			if (this.child !== child) throw new Error("agent exited during startup");
			if (this.stopping) {
				child.kill("SIGKILL");
				return;
			}
			// Session continuity: reopen the conversation the previous child held.
			const expected = this.recoverySessionFile;
			const saved = expected ?? this.readPersistedSession();
			if (expected && !this.isOwnedSessionFile(expected)) throw new Error("agent recovery session is unavailable");
			const current = state?.data?.sessionFile;
			const reopen = saved && saved !== current && this.isOwnedSessionFile(saved);
			// K2-05 boot reopen (L44): the saved conversation (state.json, not an in-memory
			// recovery) that could not be reopened `reopenAttempts` times in a row is given
			// up on THIS child, which never receives a switch it could finish later.
			const giveUp = reopen && !expected && this.reopenFailures?.sessionFile === saved
				&& this.reopenFailures.count >= this.reopenAttempts;
			if (reopen && !giveUp) {
				// The reopen is the same engine operation as the rotation's switch, so it
				// gets the same budget (requestTimeoutMs), never the short switchTimeoutMs.
				// Until the engine answers AND get_state confirms the saved file, the
				// reopen is uncertain: Pi handles RPC lines concurrently and keeps
				// reporting its boot session while a switch is still running, so a
				// failure or timeout is never followed by adopting that boot session —
				// the child is killed (no late switch can land) and state.json is kept.
				try {
					await this.rawRequest({ type: "switch_session", sessionPath: saved }, this.requestTimeoutMs);
					const confirmed = await this.rawRequest({ type: "get_state" }, this.switchTimeoutMs);
					const opened = confirmed?.data?.sessionFile;
					if (typeof opened !== "string" || path.resolve(opened) !== path.resolve(saved)) {
						throw new Error("the engine did not confirm the switch");
					}
				} catch (error) {
					if (expected) throw error;
					const count = this.reopenFailures?.sessionFile === saved ? this.reopenFailures.count + 1 : 1;
					this.reopenFailures = { sessionFile: saved, count };
					const uncertain = new Error(
						`could not reopen the previous session (attempt ${count} of ${this.reopenAttempts}): ${error.message}`,
					);
					uncertain.reopenUncertain = true;
					throw uncertain;
				}
			}
			const after = giveUp || !reopen
				? await this.rawRequest({ type: "get_state" }, this.switchTimeoutMs).catch((error) => {
					if (expected) throw error;
					return undefined;
				})
				: { data: { sessionFile: saved } };
			if (this.child !== child) throw new Error("agent exited during startup");
			if (this.stopping) {
				child.kill("SIGKILL");
				return;
			}
			this.sessionFile = after?.data?.sessionFile ?? current;
			if (!this.isOwnedSessionFile(this.sessionFile, true)) throw new Error("agent session is unavailable");
			if (expected && this.sessionFile !== expected) throw new Error("agent recovery session was not confirmed");
			if (giveUp && this.sessionFile !== saved) {
				// The rotation's own fallback (rotation.cjs: a fresh session linked as the
				// continuation of the old one): the saved conversation heads the chain, so
				// its history keeps reading, and its file is kept — never deleted.
				const chain = [...(this.chains[saved] ?? []), saved].filter((p) => this.isOwnedSessionFile(p));
				if (chain.length > 0) this.chains[this.sessionFile] = chain;
				this.log(`could not reopen the previous session after ${this.reopenAttempts} attempts; the chat continues in a new session linked to it (the file is kept)`);
			}
			this.reopenFailures = undefined;
			this.sessionEpoch += 1;
			this.persistSession(this.sessionFile);
			this.initialStartPending = false;
			this.spawnedAt = Date.now();
			this.recycling = false;
			this.recoverySessionFile = undefined;
			this.setStatus("ready");
			// K2-05 T4 U1 verifier fix: the reopen's session_changed fires only once the
			// engine is ready — before, the server's history re-broadcast guard (status
			// must be ready) dropped it silently. The server still decides whether the
			// confirmed session carries a chain worth re-broadcasting.
			this.emit("session_changed", { sessionFile: this.sessionFile });
		};
		initialization.promise = run().catch((error) => {
			if (this.child === child) child.kill("SIGKILL");
			throw error;
		}).finally(() => {
			if (this.initialization === initialization) this.initialization = undefined;
		});
		return initialization.promise;
	}

	/**
	 * The argv prefix that starts the engine. An absolute command runs as it is.
	 * The default `gentle-shell` (T2) resolves ONLY from Koda's bundled runtime —
	 * the launcher on Linux/macOS, node.exe + the manifest script on Windows —
	 * and fails closed when the runtime is absent or incomplete: never a PATH or
	 * npm search. Any other bare command name keeps the historical Windows
	 * resolution through the npm package's own CLI JS (a `.cmd` shim is never
	 * executed), and fails closed when it cannot resolve.
	 */
	spawnCommandPrefix() {
		if (path.isAbsolute(this.command)) return [this.command];
		if (this.command === DEFAULT_COMMAND) {
			const resolved = bundledGentleShell(this.runtimeDeps);
			return [resolved.command, ...resolved.commandArgs];
		}
		if (process.platform !== "win32") return [this.command];
		const cli = windowsPackageCliJs(this.command);
		if (!cli) {
			throw new Error(`the "${this.command}" command is not available on Windows; install it with npm install -g @earendil-works/pi-coding-agent`);
		}
		return [process.execPath, cli];
	}

	spawnChild() {
		if (this.child) throw new Error("agent child is already owned");
		const cwd = this.cwdOption ?? this.workspacePath ?? this.island.workspace;
		// Regenerate private files first so the identity argument can point at them.
		this.prepareSpawn();
		// Home transport (B2, Gentle Dot's shape): only Koda's default engine — the
		// bundled Gentle Shell — gets its home on the argv (--home <island>/agent,
		// the same directory Koda writes auth/mcp/extension files into) and never
		// sees PI_CODING_AGENT_DIR. Any other `command` (a plain Pi override, for
		// instance) refuses unknown options like --home, so it keeps the pre-T2
		// transport: no --home, PI_CODING_AGENT_DIR=<agentDir> in the child env.
		const defaultEngine = this.command === DEFAULT_COMMAND;
		// F4: envOverrides is applied last, so an ENGRAM_* key a caller re-added
		// would silently break the «no user ENGRAM_* for the default engine» rule
		// (the parent's server/store/binary choice must never reach Koda's own
		// engine). Enforced, not just documented: for the default engine EVERY
		// ENGRAM_* caller override is dropped except the diagnostic-only stderr
		// trace flag (ENGRAM_PI_SESSION_TRACE moves no memory state); a custom
		// command (no private memory) keeps the caller's env as is.
		const callerOverrides = defaultEngine
			? Object.fromEntries(
					Object.entries(this.envOverrides).filter(([key]) => !key.startsWith("ENGRAM_") || ENGRAM_DIAGNOSTIC_OVERRIDES.has(key)),
			  )
			: this.envOverrides;
		const args = [
			...this.commandArgs,
			...(defaultEngine ? ["--home", this.island.agentDir] : []),
			"--mode",
			"rpc",
			"--session-dir",
			this.island.sessions,
			...(this.identityFile ? ["--append-system-prompt", this.identityFile] : []),
			...this.extraArgs,
		];
		const env = {
			...isolatedEnv(this.baseEnv, this.island, {
				ABITO_MEMORY_PROJECT: MEMORY_PROJECT,
				...(defaultEngine ? {} : { PI_CODING_AGENT_DIR: this.island.agentDir }),
				// T1b-b/T1c (S5): the bundled Engram binary and Koda's private memory
				// store and port travel ONLY with Koda's default engine. F7: a missing or
				// invalid engramBin never blocks the engine — the degradation
				// (ENGRAM_STARTUP_POLICY=disabled, F1) is logged by the resolution
				// itself. F4: ENGRAM_* caller overrides are stripped above.
				...(defaultEngine ? bundledMemoryEnv(this.baseEnv, runtimeRoot(this.runtimeDeps), { ...this.runtimeDeps, log: this.log }) : {}),
				...callerOverrides,
			}),
		};
		const prefix = this.spawnCommandPrefix();
		const child = spawn(prefix[0], [...prefix.slice(1), ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
		this.child = child;
		const decoder = new JsonlDecoder(
			(record) => { if (this.child === child) this.handleRecord(record); },
			() => { if (this.child === child) this.log("agent wrote a malformed record (discarded)"); },
			() => { if (this.child === child) this.log(`agent wrote an oversized record (discarded, over ${this.maxRecordBytes} bytes)`); },
			this.maxRecordBytes,
		);
		child.stdout?.on("data", (chunk) => decoder.push(chunk));
		child.stderr?.on("data", (chunk) => { if (this.child === child) this.log(chunk.toString("utf8").trimEnd()); });
		child.stdin?.on("error", () => {});
		child.on("error", (error) => { if (this.child === child) this.log(`agent process error: ${error.message}`); });
		child.on("close", (code, signal) => this.handleClose(child, code, signal));
		return child;
	}

	rawRequest(command, timeoutMs) {
		const stdin = this.child?.stdin;
		if (!stdin?.writable) return Promise.reject(new Error("engine is not ready"));
		const id = `d${++this.nextId}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`agent did not answer ${command.type} within ${timeoutMs} ms`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			stdin.write(encodeRecord({ ...command, id }));
		});
	}

	handleRecord(record) {
		if (record === null || typeof record !== "object") {
			this.log("agent wrote a non-object record (discarded)");
			return;
		}
		if (record.type === "response") {
			const pending = record.id === undefined ? undefined : this.pending.get(record.id);
			if (!pending) return;
			this.pending.delete(record.id);
			clearTimeout(pending.timer);
			if (record.success) pending.resolve(record);
			else pending.reject(new Error(record.error ?? `${record.command} failed`));
			return;
		}
		if (record.type === "message_flush") {
			// F2: `message_flush` belongs to the daemon (cancelTurn emits it); the
			// child can never send it through.
			this.log("agent wrote a daemon-reserved record (discarded)");
			return;
		}
		if (this.sessionChange || (this.recycling && !this.turn)) return;
		const turn = this.turn;
		if (turn?.cancelled) {
			if (record.type === "agent_settled") this.recycleTurn(turn);
			return; // No output, asks, or late busy state after cancellation.
		}
		if (turn && record.type === "turn_start" && ++turn.iterations >= this.maxTurnIterations) {
			this.cancelTurn(turn, "iteration_limit").catch(() => {});
			return;
		}
		if (record.type === "agent_settled") this.clearTurn();
		this.emit("event", record);
	}

	handleClose(child, code, signal) {
		if (child !== this.child) return;
		if (this.sessionChange && !this.stopping) {
			this.recycling = true;
			this.recoverySessionFile = this.sessionChange.sessionFile;
		}
		this.sessionChange = undefined;
		this.clearTurn();
		this.sessionFile = undefined;
		this.child = undefined;
		const reason = new Error(`agent exited (${signal ?? `code ${code}`})`);
		for (const pending of [...this.pending.values()]) {
			clearTimeout(pending.timer);
			pending.reject(reason);
		}
		this.pending.clear();
		this.emit("exit", { code, signal });
		for (const resolve of this.closeWaiters.splice(0)) resolve();
		if (this.initialization?.child === child) {
			// Startup close rejects its owner; only that initialization failure
			// may schedule the next attempt. Never race a second retry here.
			if (this.stopping) this.setStatus("stopped");
			return;
		}
		if (this.restarting) {
			this.restarting = false;
			return;
		}
		if (this.initialStartPending) {
			this.initialStartPending = false;
			return;
		}
		if (this.stopping) {
			this.setStatus("stopped");
			return;
		}
		this.log(`agent exited unexpectedly (${signal ?? `code ${code}`})`);
		this.scheduleRestart();
	}

	scheduleRestart() {
		if (this.stopping || this.restartTimer !== undefined || this.initialization || this.child) return;
		if (this.spawnedAt && Date.now() - this.spawnedAt > this.stableMs) this.attempts = 0;
		const delay = this.backoffMs[Math.min(this.attempts, this.backoffMs.length - 1)] ?? 1000;
		this.attempts += 1;
		this.restartTimer = setTimeout(() => {
			this.restartTimer = undefined;
			if (this.stopping || this.child || this.initialization) return;
			this.spawnAndInitialize().catch((error) => {
				this.log(`agent restart failed: ${error.message}`);
				if (!this.child && !this.stopping) this.scheduleRestart();
			});
		}, delay);
		this.setStatus("restarting");
	}

	setStatus(state) {
		if (this.status === state) return;
		this.status = state;
		this.emit("status", { state });
	}
}

module.exports = { AgentEngine, JsonlDecoder, DEFAULT_COMMAND, bundledGentleShell, bundledMemoryEnv, encodeRecord, gentlePiVersion, runtimeRoot, seedEngramCompanion, windowsPackageCliJs };
