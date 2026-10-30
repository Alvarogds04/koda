#!/usr/bin/env node
"use strict";

/**
 * abito-island-daemon — foreground CLI for the island agent daemon (U4).
 *
 *   run [--app-owned]           start in foreground; app-owned adds a stdin lifetime lease
 *   status                      sanitized JSON incl. the health verdict {state,reason,ready} (never
 *                               the token); exit 3 if not running, naming the classification
 *   stop                        SIGTERM the running daemon (pid from session.json, ownership-checked)
 *   config get                  print the effective config as JSON
 *   config set-workspace <abs>  validate + persist the workspace (SIGHUP the live daemon to apply it)
 *   config set-hotkey <combo>   validate + persist the global show/hide hotkey (e.g. Ctrl+Alt+Space); --clear removes it
 *
 * Exit codes: 0 ok, 1 error (config errors print only `invalid config: <field>`),
 * 2 usage, 3 not running. No auto-start, no services.
 */

const fs = require("node:fs");
const path = require("node:path");

const config = require("./config.cjs");
const { Daemon, classifySession, isDaemonProcess, pidAlive, pidState, readSession, sessionPath } = require("./daemon.cjs");
const { ensureIsland, defaultIslandRoot, windowsIslandRootViolation } = require("./isolation.cjs");

const USAGE = "usage: abito-island-daemon run [--app-owned] | status | stop | config get | config set-workspace <absolute-path> | config set-hotkey <combo>|--clear";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(code, message) {
	process.stderr.write(`abito-island-daemon: ${message}\n`);
	return code;
}

function genericError(error) {
	if (error instanceof config.ConfigError) return error.message;
	if (/already running/.test(String(error?.message))) return "daemon already running";
	if (/^busy/.test(String(error?.message))) return "busy: finish or abort the current turn first";
	// Closed diagnostic vocabulary: arbitrary exception text can contain paths,
	// credentials or model content. Never echo it, even after regex redaction.
	const name = ["Error", "TypeError", "RangeError", "SyntaxError"].includes(error?.name) ? error.name : "Error";
	const code = ["EACCES", "EPERM", "ENOENT", "EEXIST", "ENOTDIR", "EISDIR", "EINVAL", "ENOSPC", "EPIPE", "ECONNREFUSED", "ETIMEDOUT", "ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"].includes(error?.code) ? error.code : "unknown";
	const prefixes = ["refusing island root", "refusing symlink component in island path", "refusing island path, not a directory", "refusing island path", "refusing world-writable component without the sticky bit", "refusing to write through a symlink", "refusing to write, not a regular file"];
	const prefix = prefixes.find(text => String(error?.message).startsWith(`${text}:`));
	const fixed = ["agent exited during startup", "agent session is unavailable", "agent recovery session is unavailable", "agent recovery session was not confirmed", "engine is not ready", "native session helper not found (abito-private-session.exe)", "session payload over the helper size bound", "native session helper failed to run", "native session helper refused the session"].find(text => error?.message === text);
	const detail = fixed ?? (prefix ? `${prefix} [details redacted]` : code !== "unknown" ? "system operation failed" : "details redacted");
	const operation = ["spawn", "open", "mkdir", "chmod", "read", "write", "rename", "lstat", "stat", "realpath", "unlink", "scandir"].includes(error?.syscall) ? `${error.syscall}; ` : "";
	return `failed (see the island directory permissions and the daemon log) [${name}/${code}: ${operation}${detail}]`;
}

/** The live daemon's session, or undefined; a stale session.json of a dead pid is removed. */
function liveSession(root) {
	const session = readSession(root);
	if (!session) return undefined;
	if (isDaemonProcess(session.pid, session.procStart)) return session;
	// Unlink only when the pid is CONFIRMED gone; an unconfirmable pid keeps its file.
	if (pidState(session.pid) === "dead") {
		try {
			fs.unlinkSync(sessionPath(root));
		} catch {}
	}
	return undefined;
}

/**
 * The hook installer that ships NEXT TO this daemon: <package>/desktop-daemon/src -> <package>/desktop-harness/bin/abito-hook.cjs
 * (the same relative layout in the repo and in the installed package). Only when the file is there: a package without it
 * keeps every agent "unavailable" instead of a guessed path. It is a DEFAULT: `hookInstallerBin` in config.json wins, and
 * nothing here comes from the page.
 */
function packagedInstallerBin(srcDir = __dirname) {
	const file = path.resolve(srcDir, "..", "..", "desktop-harness", "bin", "abito-hook.cjs");
	try {
		return fs.statSync(file).isFile() ? file : undefined;
	} catch {
		return undefined;
	}
}

async function run(root, appOwned = false) {
	const daemon = new Daemon({ root, log: (line) => process.stderr.write(`[abito] ${line}\n`), defaultInstallerBin: packagedInstallerBin() });
	let closing = false;
	let finish;
	const stopped = new Promise((resolve) => { finish = resolve; });
	// Install the lifetime handlers BEFORE boot: parent EOF/signals during startup
	// must not turn into a host which finishes boot after its owner has gone.
	const shutdown = () => { closing = true; finish(); };
	const cleanup = () => daemon.cleanupSync();
	const reload = () => {
		if (!closing) daemon.applyConfig().catch((error) => process.stderr.write(`[abito] config reload refused: ${genericError(error)}\n`));
	};
	process.on("exit", cleanup);
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
	process.on("SIGHUP", reload);
	if (appOwned) {
		process.stdin.on("end", shutdown);
		process.stdin.on("error", shutdown);
		process.stdin.resume();
	}
	// macOS has no parent-death signal: besides the stdin lease and the app's kqueue sentinel, an
	// orphaned host notices its reparenting (ppid changes) within about a second and shuts down.
	let ppidWatch;
	if (appOwned && process.platform === "darwin") {
		const parent = process.ppid;
		ppidWatch = setInterval(() => { if (process.ppid !== parent) shutdown(); }, 1000);
		ppidWatch.unref();
	}
	try {
		await daemon.start();
		if (!closing) {
			process.stderr.write(`abito-island-daemon: running (pid ${process.pid}); session.json in ${path.join(daemon.root, "runtime")}\n`);
			await stopped;
		}
		await daemon.stop();
		return 0;
	} catch (error) {
		await daemon.stop().catch(() => {});
		return fail(1, genericError(error));
	} finally {
		if (ppidWatch) clearInterval(ppidWatch);
		process.removeListener("exit", cleanup);
		process.removeListener("SIGTERM", shutdown);
		process.removeListener("SIGINT", shutdown);
		process.removeListener("SIGHUP", reload);
		if (appOwned) {
			process.stdin.removeListener("end", shutdown);
			process.stdin.removeListener("error", shutdown);
			process.stdin.pause();
		}
	}
}

async function stop(root) {
	const session = liveSession(root);
	if (!session) {
		const stale = readSession(root);
		if (stale && pidState(stale.pid) !== "dead") return fail(1, "session.json does not belong to a confirmed daemon; refusing to signal it");
		return fail(3, "not running");
	}
	try {
		process.kill(session.pid, "SIGTERM");
	} catch {
		return fail(1, "could not signal the daemon");
	}
	for (let i = 0; i < 150; i += 1) {
		if (pidState(session.pid) === "dead") return 0;
		await sleep(100);
	}
	return fail(1, "daemon did not stop in time");
}

async function main(argv) {
	const [command, sub, arg, ...rest] = argv;
	const root = defaultIslandRoot(process.env);
	// Windows (B5/S6): no command may create or touch an island outside the
	// canonical protected root — refused before any ensureIsland/config write.
	const violation = windowsIslandRootViolation(root);
	if (violation) return fail(1, `refusing island root: ${violation}`);
	try {
		if (command === "run" && (argv.length === 1 || (argv.length === 2 && sub === "--app-owned"))) return await run(root, sub === "--app-owned");
		if (command === "status" && argv.length === 1) {
			// #390 GD014: classify BEFORE liveSession (its stale cleanup may unlink the file)
			const verdict = await classifySession(root);
			// Windows status is read-only after native proof. Never run the
			// POSIX liveSession stale-file cleanup or enable bare-pid signalling.
			const session = process.platform === "win32"
				? (verdict.state === "healthy" && verdict.ready === true ? readSession(root) : undefined)
				: liveSession(root);
			if (!session) return fail(3, `not running (${verdict.state}: ${verdict.reason})`);
			const cfg = config.loadConfig(root);
			process.stdout.write(
				`${JSON.stringify({
					running: true,
					pid: session.pid,
					startedAt: session.startedAt,
					endpoint: session.endpoint,
					workspace: cfg.workspace,
					workspaceSource: cfg.workspaceSource,
					memoryPinConflict: config.detectMemoryPinConflict(cfg.workspace),
					state: verdict.state,
					reason: verdict.reason,
					ready: verdict.ready === true,
				})}\n`,
			);
			return 0;
		}
		if (command === "stop" && argv.length === 1) return await stop(root);
		if (command === "config" && sub === "get" && argv.length === 2) {
			ensureIsland(root);
			const cfg = config.loadConfig(root);
			process.stdout.write(`${JSON.stringify({ ...cfg, hotkey: cfg.hotkey ?? null }, null, 2)}\n`);
			if (cfg.hotkeyInvalid) process.stderr.write("hotkey: invalid (ignored)\n");
			return 0;
		}
		if (command === "config" && sub === "set-workspace" && arg !== undefined && rest.length === 0) {
			ensureIsland(root);
			const result = config.setWorkspace(root, arg);
			const live = liveSession(root);
			if (live && result.changed) process.kill(live.pid, "SIGHUP");
			process.stdout.write(`${JSON.stringify({ workspace: result.workspace, changed: result.changed, appliedToRunningDaemon: Boolean(live && result.changed), overriddenByEnv: result.overriddenByEnv })}\n`);
			return 0;
		}
		if (command === "config" && sub === "set-hotkey" && arg !== undefined && rest.length === 0) {
			ensureIsland(root);
			const result = config.setHotkey(root, arg === "--clear" ? null : arg);
			const live = liveSession(root);
			if (live && result.changed) process.kill(live.pid, "SIGHUP");
			process.stdout.write(`${JSON.stringify({ hotkey: result.hotkey, changed: result.changed, appliedToRunningDaemon: Boolean(live && result.changed) })}\n`);
			return 0;
		}
	} catch (error) {
		return fail(1, genericError(error));
	}
	return fail(2, USAGE);
}

if (require.main === module) {
	main(process.argv.slice(2)).then((code) => {
		process.exitCode = code;
	});
}

module.exports = { main, packagedInstallerBin };
