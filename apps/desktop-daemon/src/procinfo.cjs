"use strict";

/**
 * macOS process identity (S1). Linux reads /proc; macOS has none, so the same facts come from
 * `/bin/ps` run by absolute path with a fixed argv, no shell and LC_ALL=C. Every failure (ps
 * missing, pid gone, unexpected output) is `undefined`, which every caller treats as "cannot
 * confirm" and therefore fails closed, exactly like an unreadable /proc.
 */
const { execFileSync } = require("node:child_process");

const PS = "/bin/ps";
const PS_ARGS = ["-ww", "-o", "lstart=", "-o", "ppid=", "-o", "state=", "-o", "uid=", "-o", "command="];
/** `lstart` in the C locale is always exactly 24 characters: `Mon Jan  2 15:04:05 2006`. */
const LSTART_LENGTH = 24;

/** Pure parser of one `ps` line. Returns {start, ppid, state, uid, command} or undefined. */
function parsePsLine(line) {
	if (typeof line !== "string") return undefined;
	const text = line.replace(/\r?\n$/, "");
	if (text.length <= LSTART_LENGTH) return undefined;
	const millis = Date.parse(text.slice(0, LSTART_LENGTH).trim());
	if (!Number.isFinite(millis)) return undefined;
	const match = /^\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(text.slice(LSTART_LENGTH));
	if (!match) return undefined;
	const ppid = Number(match[1]);
	const uid = Number(match[3]);
	if (!Number.isSafeInteger(ppid) || !Number.isSafeInteger(uid)) return undefined;
	// Whole seconds since the epoch, decimal digits only: the same shape as the Linux clock ticks.
	return { start: String(Math.floor(millis / 1000)), ppid, state: match[2][0], uid, command: match[4] };
}

function runPs(pid, exec = execFileSync) {
	if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
	try {
		const out = exec(PS, [...PS_ARGS, "-p", String(pid)], {
			encoding: "utf8", env: { LC_ALL: "C", PATH: "/usr/bin:/bin" }, timeout: 2000, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024,
		});
		const lines = String(out).split("\n").filter((entry) => entry.trim() !== "");
		return lines.length === 1 ? parsePsLine(lines[0]) : undefined;
	} catch {
		return undefined;
	}
}

/** Parent executable identity, not command-line text: comm preserves spaces and carries no argv. */
function runPsExecutable(pid, exec = execFileSync) {
	if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
	try {
		const out = exec(PS, ['-ww', '-o', 'uid=', '-o', 'comm=', '-p', String(pid)], {
			encoding: 'utf8', env: { LC_ALL: 'C', PATH: '/usr/bin:/bin' }, timeout: 2000,
			stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8192,
		});
		const lines = String(out).split('\n').filter(line => line.trim() !== '');
		if (lines.length !== 1) return undefined;
		const match = /^\s*(\d+)\s+(\/[^\r\n\0]+)$/.exec(lines[0]);
		if (!match || !Number.isSafeInteger(Number(match[1]))) return undefined;
		return { uid: Number(match[1]), executable: match[2] };
	} catch { return undefined; }
}

module.exports = { PS, PS_ARGS, parsePsLine, runPs, runPsExecutable };
