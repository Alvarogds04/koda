"use strict";

// Live agent sessions discovery (#360, F046/F049): read-only scan of Linux process
// metadata for RUNNING agent sessions (Pi first). The scan exposes ONLY: a derived
// id, a closed agent kind, the cwd BASENAME, a closed process state and a terminal
// origin when a known terminal host is found on the parent chain. It never emits
// command lines, arguments, environment, full paths or anything else it read.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SCHEMA, scanSessions, buildSessions } = require("../src/sessions.cjs");

function tmp() {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "abito-sessions-")));
}

/** One fake /proc/<pid> entry: cmdline (NUL-separated), stat line, optional cwd symlink and comm. */
function proc(root, pid, { cmdline, stat, cwd, comm } = {}) {
	const dir = path.join(root, String(pid));
	fs.mkdirSync(dir, { recursive: true });
	if (cmdline !== undefined) fs.writeFileSync(path.join(dir, "cmdline"), cmdline);
	if (stat !== undefined) fs.writeFileSync(path.join(dir, "stat"), stat);
	if (comm !== undefined) fs.writeFileSync(path.join(dir, "comm"), comm);
	if (cwd !== undefined) fs.symlinkSync(cwd, path.join(dir, "cwd"));
}

// pi agent under tmux; claude agent under a bare zsh; an unrelated vim process.
function fixture(root) {
	proc(root, 1, { stat: "1 (systemd) S 0 1 1 0 -1 4194560 0 0 0 0 1 0 0 0 20 0 1 0 100 1 1 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0" });
	// terminal host: tmux server, parent of the shell
	proc(root, 90, { stat: "90 (tmux: server) S 1 90 90 0 -1 4194560 0 0 0 0 1 0 0 0 20 0 1 0 200 1 1 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0" });
	// shell under tmux
	proc(root, 95, { stat: "95 (zsh) S 90 95 95 0 -1 4194560 0 0 0 0 1 0 0 0 20 0 1 0 250 1 1 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0", comm: "zsh" });
	// the pi agent
	proc(root, 100, {
		cmdline: "/usr/local/bin/pi\0--mode\0json\0",
		stat: "100 (pi) S 95 100 100 0 -1 4194560 0 0 0 0 1 0 0 0 20 0 1 0 300 1 1 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0",
		cwd: "/home/dev/Apps/my-project/worktrees/sessions-ticker-360",
	});
	// claude under a plain shell (no known terminal ancestor)
	proc(root, 199, { stat: "199 (zsh) S 1 199 199 0 -1 4194560 0 0 0 0 1 0 0 0 20 0 1 0 400 1 1 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0", comm: "zsh" });
	const cwd = "/home/dev/proyectos/bar-42";
	proc(root, 200, {
		cmdline: "claude\0",
		stat: "200 (claude) R 199 200 200 0 -1 4194560 0 0 0 0 1 0 0 0 20 0 1 0 500 1 1 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0",
		cwd,
	});
	// unrelated process: never listed
	proc(root, 300, { cmdline: "vim\0notes.txt\0", stat: "300 (vim) S 1 300 300 0 -1 4194560 0 0 0 0 1 0 0 0 20 0 1 0 600 1 1 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0", comm: "vim" });
}

// --- discovery ---------------------------------------------------------------

test("schema constant is stable", () => {
	assert.equal(SCHEMA, "abito-sessions/view/1");
});

test("discovers a running pi session with closed fields only", () => {
	const root = tmp();
	fixture(root);
	const result = scanSessions({ procDir: root });
	assert.equal(result.truncated, false);
	const pi = result.sessions.find((s) => s.kind === "pi");
	assert.ok(pi, "pi session listed");
	assert.match(pi.id, /^s-[0-9a-f]{8}$/);
	assert.equal(pi.cwd, "sessions-ticker-360", "cwd basename only");
	assert.equal(pi.state, "sleeping");
	assert.equal(pi.origin, "tmux", "terminal host from the parent chain");
	// the derived id is stable for the same pid+starttime
	const again = scanSessions({ procDir: root });
	assert.equal(again.sessions.find((s) => s.kind === "pi").id, pi.id);
});

test("the full cwd path and the command line never reach the output", () => {
	const root = tmp();
	fixture(root);
	const out = JSON.stringify(scanSessions({ procDir: root }));
	assert.ok(!out.includes("alvaro"), "no home fragment, not even in a path");
	assert.ok(!out.includes("proyectos"), "no path fragment with a separator: the basename alone travels");
	assert.ok(!out.includes("cmdline") && !out.includes("--mode"), "no command line data");
});

test("closed kind table: pi first, then the other known agents; unknown processes are never listed", () => {
	const root = tmp();
	proc(root, 1, { stat: "1 (systemd) S 0 1 1 0 -1 4194560 0 0 0 0 1 0 0 0 20 0 1 0 100 1 1 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0" });
	let n = 10;
	const add = (argv0, expected) => {
		proc(root, n, {
			cmdline: `${argv0}\0`,
			stat: `${n} (${expected}) S 1 ${n} ${n} 0 -1 4194560 0 0 0 0 1 0 0 0 20 0 1 0 ${n * 10} 1 1 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0`,
		});
		n += 1;
	};
	add("/usr/bin/pi", "pi");
	add("claude", "claude-code");
	add("codex", "codex");
	add("opencode", "opencode");
	add("gemini", "gemini");
	add("vim", null);
	const result = scanSessions({ procDir: root });
	assert.deepEqual(result.sessions.map((s) => s.kind).sort(), ["claude-code", "codex", "gemini", "opencode", "pi"]);
});

test("node-shebang style invocation (binary as second argument) is still classified", () => {
	const root = tmp();
	proc(root, 1, { stat: "1 (systemd) S 0 1 1 0 -1 4194560 0 0 0 0 1 0 0 0 20 0 1 0 100 1 1 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0" });
	proc(root, 42, {
		cmdline: "node\0/usr/local/bin/pi\0",
		stat: "42 (node) S 1 42 42 0 -1 4194560 0 0 0 0 1 0 0 0 20 0 1 0 420 1 1 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0",
		cwd: "/home/dev/Apps/mi-proyecto",
	});
	const result = scanSessions({ procDir: root });
	assert.deepEqual(result.sessions.map((s) => [s.kind, s.cwd]), [["pi", "mi-proyecto"]]);
});

test("terminal origin: known host on the parent chain; null when there is none", () => {
	const root = tmp();
	fixture(root);
	const result = scanSessions({ procDir: root });
	assert.equal(result.sessions.find((s) => s.kind === "pi").origin, "tmux");
	assert.equal(result.sessions.find((s) => s.kind === "claude-code").origin, null);
});

test("process state maps to the closed list (R, S, D, Z, T)", () => {
	const root = tmp();
	proc(root, 1, { stat: "1 (systemd) S 0 1 1 0 -1 4194560 0 0 0 0 1 0 0 0 20 0 1 0 100 1 1 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0" });
	const mk = (pid, stateChar) => proc(root, pid, {
		cmdline: "pi\0",
		stat: `${pid} (pi) ${stateChar} 1 ${pid} ${pid} 0 -1 4194560 0 0 0 0 1 0 0 0 20 0 1 0 ${pid} 1 1 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0`,
	});
	mk(11, "R"); mk(12, "S"); mk(13, "D"); mk(14, "Z"); mk(15, "T");
	const rows = scanSessions({ procDir: root }).sessions;
	assert.deepEqual(rows.map((s) => s.state), ["running", "sleeping", "running", "zombie", "stopped"]);
});

test("caps: at most 64 sessions, truncated=true when there are more", () => {
	const root = tmp();
	proc(root, 1, { stat: "1 (systemd) S 0 1 1 0 -1 4194560 0 0 0 0 1 0 0 0 20 0 1 0 100 1 1 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0" });
	for (let pid = 100; pid < 100 + 70; pid++) {
		proc(root, pid, {
			cmdline: "pi\0",
			stat: `${pid} (pi) S 1 ${pid} ${pid} 0 -1 4194560 0 0 0 0 1 0 0 0 20 0 1 0 ${pid} 1 1 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0`,
		});
	}
	const result = scanSessions({ procDir: root });
	assert.equal(result.sessions.length, 64);
	assert.equal(result.truncated, true);
	assert.equal(result.total, 70, "the scan counts every session it saw past the cap");
});

test("total is absent unless the result was truncated", () => {
	const root = tmp();
	proc(root, 100, { cmdline: "pi\0", stat: "100 (pi) S 1 100 100 0 -1 4194560 0 0 0 0 1 0 0 0 20 0 1 0 100 1 1 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0" });
	const result = scanSessions({ procDir: root });
	assert.equal(result.truncated, false);
	assert.equal("total" in result, false);
});

test("broken entries are skipped, unreadable cwd becomes null, and a missing proc dir yields an empty result", () => {
	const root = tmp();
	proc(root, 1, { stat: "1 (systemd) S 0 1 1 0 -1 4194560 0 0 0 0 1 0 0 0 20 0 1 0 100 1 1 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0" });
	// an agent process with no cmdline and a bogus stat
	proc(root, 111, { stat: "garbage" });
	proc(root, 112, { cmdline: "pi\0" }); // no stat
	const withCwd = { cmdline: "pi\0", stat: "113 (pi) S 1 113 113 0 -1 4194560 0 0 0 0 1 0 0 0 20 0 1 0 113 1 1 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0" };
	proc(root, 113, withCwd);
	const result = scanSessions({ procDir: root });
	assert.equal(result.sessions.length, 1);
	assert.equal(result.sessions[0].cwd, null);
	assert.equal(result.sessions[0].state, "sleeping");
	assert.deepEqual(scanSessions({ procDir: path.join(root, "missing") }), { sessions: [], truncated: false });
});

test("non-linux platforms scan nothing (honest empty result)", () => {
	const root = tmp();
	fixture(root);
	assert.deepEqual(scanSessions({ procDir: root, platform: "darwin" }), { sessions: [], truncated: false });
});

// --- strict frame builders (protocol-side revalidation) ----------------------

const row = (over = {}) => ({ id: "s-0123abcd", kind: "pi", cwd: "mi-proyecto", state: "sleeping", origin: "tmux", ...over });

test("buildSessions: valid rows pass unchanged, unknown fields are dropped", () => {
	const rows = buildSessions([row({ secret: "x" })]);
	assert.deepEqual(rows, [{ id: "s-0123abcd", kind: "pi", cwd: "mi-proyecto", state: "sleeping", origin: "tmux" }]);
	assert.deepEqual(buildSessions([row({ cwd: null, origin: null })]), [{ id: "s-0123abcd", kind: "pi", cwd: null, state: "sleeping", origin: null }]);
});

test("buildSessions: rejects bad ids, kinds, states, cwd with separators and control characters", () => {
	assert.throws(() => buildSessions([row({ id: "not-an-id" })]));
	assert.throws(() => buildSessions([row({ kind: "bash" })]));
	assert.throws(() => buildSessions([row({ state: "dancing" })]));
	assert.throws(() => buildSessions([row({ cwd: "a/b" })]));
	assert.throws(() => buildSessions([row({ cwd: "a\u0000b" })]));
	assert.throws(() => buildSessions([row({ origin: "tmux\nserver" })]));
	assert.throws(() => buildSessions([{ id: "s-0123abcd" }]));
	assert.throws(() => buildSessions("nope"));
});

test("buildSessions: over the emission cap it throws (never a partial frame)", () => {
	assert.throws(() => buildSessions(Array.from({ length: 65 }, (_, i) => row({ id: `s-${String(i).padStart(8, "0")}` }))));
});

// --- scope: a validation run must only see ITS OWN sessions ---------------------------------------------

test("scopePid keeps only sessions whose ancestor chain contains that pid, however deep", () => {
	const root = tmp();
	const stat = (pid, ppid) => `${pid} (x) S ${ppid} ${pid} ${pid} 0 -1 4194560 0 0 0 0 1 0 0 0 20 0 1 0 ${pid} 1 1 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0`;
	proc(root, 1, { stat: stat(1, 0) });
	proc(root, 50, { stat: stat(50, 1), comm: "validator" });          // the scope root
	proc(root, 60, { stat: stat(60, 50), comm: "sh" });                // a shell under it
	proc(root, 100, { cmdline: "pi\0", stat: stat(100, 50), cwd: "/work/direct" });
	proc(root, 101, { cmdline: "codex\0", stat: stat(101, 60), cwd: "/work/nested" });
	proc(root, 200, { cmdline: "pi\0", stat: stat(200, 1), cwd: "/work/foreign-a" });   // the human's own sessions
	proc(root, 201, { cmdline: "claude\0", stat: stat(201, 77), cwd: "/work/foreign-b" });
	const all = scanSessions({ procDir: root }).sessions.map((s) => s.cwd).sort();
	assert.deepEqual(all, ["direct", "foreign-a", "foreign-b", "nested"], "unscoped: everything, as in production");
	const scoped = scanSessions({ procDir: root, scopePid: 50 });
	assert.deepEqual(scoped.sessions.map((s) => s.cwd).sort(), ["direct", "nested"]);
	assert.equal(scoped.truncated, false);
	// the root itself is not a member of its own scope unless it is a session
	assert.deepEqual(scanSessions({ procDir: root, scopePid: 999 }).sessions, []);
});

test("scopePid is exact and safe: a cycle in the parent chain, a bad value or none never widens the scan", () => {
	const root = tmp();
	const stat = (pid, ppid) => `${pid} (x) S ${ppid} ${pid} ${pid} 0 -1 4194560 0 0 0 0 1 0 0 0 20 0 1 0 ${pid} 1 1 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0`;
	proc(root, 1, { stat: stat(1, 0) });
	proc(root, 300, { cmdline: "pi\0", stat: stat(300, 301), cwd: "/work/loop" });
	proc(root, 301, { stat: stat(301, 300) });                         // 300 <-> 301
	proc(root, 400, { cmdline: "pi\0", stat: stat(400, 1), cwd: "/work/plain" });
	assert.deepEqual(scanSessions({ procDir: root, scopePid: 50 }).sessions, [], "a cycle terminates and is not in scope");
	for (const bad of [0, -1, 1.5, NaN, "50", null, 4194305]) {
		assert.equal(scanSessions({ procDir: root, scopePid: bad }).sessions.length, 2, `${bad}: ignored, never a filter that hides or widens by accident`);
	}
});

test("sessionScope(env): only a plain pid from ABITO_SESSIONS_SCOPE_PID counts", () => {
	const { sessionScope } = require("../src/sessions.cjs");
	assert.equal(sessionScope({ ABITO_SESSIONS_SCOPE_PID: "1234" }), 1234);
	for (const bad of [undefined, "", "0", "-5", "12.5", "abc", "1234 ", "99999999", " 7"]) assert.equal(sessionScope({ ABITO_SESSIONS_SCOPE_PID: bad }), null, String(bad));
	assert.equal(sessionScope({}), null);
});

test("the daemon wires the scope into its sessions snapshot", () => {
	const src = fs.readFileSync(path.join(__dirname, "../src/daemon.cjs"), "utf8");
	assert.match(src, /scanSessions\(\{ scopePid: sessionScope\(this\.env\) \}\)/);
});
