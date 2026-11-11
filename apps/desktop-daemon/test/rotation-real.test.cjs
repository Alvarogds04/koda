"use strict";
// K2-05 T3 (S2): the REAL engine accepts the rotated session and reads the
// hidden handoff in its context.
//
// The engine is launched EXACTLY the way Koda launches it: the daemon's
// AgentEngine (src/runtime.cjs) spawns Gentle Shell (the bundled gentle-pi)
// with the argv the engine builds itself (--home <island>/agent --mode rpc
// --session-dir ...; the fakeKodaRuntime helper mirrors test/pi-offline.test.cjs
// so `command` is DEFAULT_COMMAND and the engine resolves the runtime itself).
//
// The rotation is forced with tiny limits (ABITO limits, 1 byte): the daemon's
// SessionRotator writes a v3 session seeded with ONE hidden custom message
// (customType "abito.handoff", display:false) next to the open session, the
// engine switches to it, and `get_messages` (the engine's own RPC) answers with
// the handoff in its context.
//
// Engine discovery follows test/pi-offline.test.cjs: GENTLE_PI_ROOT (a
// gentle-pi package directory) or Koda's bundled runtime; SKIPPED (never
// silently passed) when neither exists; with ABITO_REQUIRE_GENTLE=1 absence
// FAILS instead. Only private temp dirs are used: the user's ~/.pi, ~/.engram
// and real config are never read or written.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { AgentEngine, DEFAULT_COMMAND, runtimeRoot } = require("../src/runtime.cjs");
const { HANDOFF_TYPE, SESSION_VERSION, SessionRotator } = require("../src/rotation.cjs");

// R8 (K2-05 CI run 43025727185): on the Windows runner the real engine's session replacement
// (switch_session/new_session: teardown + runtime rebuild inside the engine) did not answer within the
// Linux budget, while on Linux it answers in ~0.1 s (start ~5 s). Koda's side of a switch is one JSONL
// request with no file handle kept open, the same on every OS, so Windows gets more time, not other
// behaviour: every budget stays at or below the product's own default, so a Windows switch slower
// than what the shipped daemon waits for still fails here.
const WIN_REAL = process.platform === "win32";
// K2-05 boot reopen (L44, Windows CI 43071616377): the restart's reopen of the saved session used the
// short switch budget (30 s) while the rotation's switch had the request budget (300 s); a Windows reopen
// slower than 30 s was dropped and the fresh boot session overwrote state.json. The product now gives the
// reopen the SAME budget as the rotation's switch (requestTimeoutMs), so this test gives both one budget
// too: 60 s on Windows (below the product's 300 s, so it stays stricter than the shipped daemon and fits
// npm test's 600 s per-test cap), 10 s elsewhere. switchTimeoutMs now only bounds the get_state that
// confirms the reopen. One reopen attempt here (the product default retries 3 times; runtime.test.cjs
// covers the retries): a failed reopen ends in the linked fallback inside the cap, and the assertion
// prints the engine and daemon logs so CI shows the cause.
const REOPEN_ATTEMPTS = 1;
const BOOT_TIMEOUT_MS = WIN_REAL ? 540_000 : 120_000;

/** A minimal fake Koda bundled runtime: the production launch path through runtimeDeps (see test/pi-offline.test.cjs). */
function fakeKodaRuntime(t, gentleRoot) {
	const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "abito-fake-runtime-"));
	// Retries: on Windows the engine's own child (the runtime node.exe) may still be exiting just after stop() (EPERM).
	t.after(() => fs.rmSync(runtime, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
	const scriptRel = "node_modules/gentle-pi/bin/gentle-shell.mjs";
	const script = path.join(runtime, ...scriptRel.split("/"));
	fs.mkdirSync(path.dirname(script), { recursive: true });
	const realEntry = path.join(gentleRoot, "bin", "gentle-shell.mjs");
	fs.writeFileSync(
		script,
		`// Test wrapper: run the REAL engine entry.\n` +
			`import { pathToFileURL } from "node:url";\n` +
			`await import(pathToFileURL(${JSON.stringify(realEntry)}).href);\n`,
	);
	fs.writeFileSync(
		path.join(runtime, "koda-runtime.json"),
		`${JSON.stringify({ gentlePi: "4.3.0", gentleShell: scriptRel })}\n`,
	);
	if (process.platform === "win32") {
		fs.copyFileSync(process.execPath, path.join(runtime, "node.exe"));
	} else {
		const launcher = path.join(runtime, "gentle-shell");
		fs.writeFileSync(launcher, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`);
		fs.chmodSync(launcher, 0o755);
	}
	return {
		runtimeDeps: {
			execPath: path.join(runtime, process.platform === "win32" ? "node.exe" : "node"),
			existsSync: fs.existsSync,
			lstatSync: fs.lstatSync,
			readFileSync: fs.readFileSync,
		},
	};
}

/** A gentle-pi package directory (it holds bin/gentle-shell.mjs), or undefined. */
function findGentleRoot() {
	if (process.env.GENTLE_PI_ROOT) return process.env.GENTLE_PI_ROOT;
	const runtime = runtimeRoot();
	if (runtime) {
		try {
			const manifest = JSON.parse(fs.readFileSync(path.join(runtime, "koda-runtime.json"), "utf8"));
			return path.dirname(path.dirname(path.join(runtime, manifest.gentleShell)));
		} catch {
			// read-only discovery: fall through
		}
	}
	return undefined;
}

const gentleRoot = findGentleRoot();
if (!gentleRoot && process.env.ABITO_REQUIRE_GENTLE === "1") {
	test("Gentle Shell is required here (ABITO_REQUIRE_GENTLE=1)", () => {
		assert.fail("ABITO_REQUIRE_GENTLE=1 but no Gentle Shell was found (set GENTLE_PI_ROOT or build the bundled runtime)");
	});
}
const gentleSkip = gentleRoot ? undefined : "Gentle Shell (gentle-pi) not found; set GENTLE_PI_ROOT or build the bundled runtime";

function makeTemp(tag) {
	const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `abito-gentle-rotate-${tag}-`)));
	process.on("exit", () => {
		try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
	});
	return base;
}

test("real engine: a forced rotation switches it to the handoff session and the handoff is in its context", { skip: gentleSkip, timeout: BOOT_TIMEOUT_MS }, async (t) => {
	const base = makeTemp("green");
	const logs = [];
	// Registered BEFORE the fake runtime's removal (t.after runs first-in first-out): every engine is stopped
	// before its runtime folder goes, or Windows refuses to delete the node.exe a live engine runs (EPERM).
	const engines = [];
	t.after(async () => { for (const running of engines) await running.stop(); });
	const { runtimeDeps } = fakeKodaRuntime(t, gentleRoot);
	const engineOptions = () => ({
		// Exactly the daemon's default launch shape (T2): command = DEFAULT_COMMAND,
		// so the engine itself resolves Koda's bundled runtime and appends
		// --home <island>/agent --mode rpc --session-dir as production does.
		command: DEFAULT_COMMAND,
		commandArgs: [],
		runtimeDeps,
		root: path.join(base, "island"),
		env: { PATH: process.env.PATH, HOME: base },
		backoffMs: [10_000, 10_000],
		stableMs: 60_000,
		startTimeoutMs: 60_000,
		requestTimeoutMs: WIN_REAL ? 60_000 : 10_000, // the rotation's switch_session AND the restart's reopen (L44)
		switchTimeoutMs: WIN_REAL ? 30_000 : 10_000, // the get_state that confirms a switch
		reopenAttempts: REOPEN_ATTEMPTS,
		stopTimeoutMs: 2_000,
		log: (line) => logs.push(String(line)),
	});
	const engine = new AgentEngine(engineOptions());
	engines.push(engine);
	await engine.start();
	assert.equal(engine.status, "ready");
	const first = engine.sessionFile;
	assert.equal(typeof first, "string");

	// The engine's own open session, made old enough to rotate: a v3 header with
	// one real compaction summary (what the engine itself writes; the handoff
	// carries the SUMMARY, so no extra model call is needed). The header's cwd is
	// a real folder — the engine refuses to open a session whose cwd is missing.
	fs.writeFileSync(first, [
		JSON.stringify({ type: "session", version: SESSION_VERSION, id: "kodarot", timestamp: new Date().toISOString(), cwd: path.join(base, "island", "workspace"), parentSession: null }),
		JSON.stringify({ type: "compaction", summary: "El usuario planea un viaje a Kyoto con presupuesto concreto." }),
		"",
	].join("\n"));

	const rotator = new SessionRotator(engine, {
		limits: { bytes: 1, compactions: 10 }, // forced: any open session rotates
		canRotate: () => true,
		log: (line) => logs.push(`[rotation] ${line}`),
	});
	t.after(() => rotator.stop());
	const rotated = await rotator.maybeRotate();
	assert.equal(rotated, true, `rotation failed; logs: ${logs.join(" | ").slice(0, 2000)}`);

	const seed = engine.sessionFile;
	assert.equal(typeof seed, "string");
	assert.notEqual(seed, first, "the engine switched to the seeded session");
	const header = JSON.parse(fs.readFileSync(seed, "utf8").split("\n")[0]);
	assert.equal(header.type, "session");
	assert.equal(header.version, SESSION_VERSION, "pi-coding-agent 1.4.0 CURRENT_SESSION_VERSION");
	assert.equal(header.parentSession, first, "the files are linked");
	const handoffEntry = fs.readFileSync(seed, "utf8").split("\n").map((line) => {
		try { return JSON.parse(line); } catch { return undefined; }
	}).filter((entry) => entry && entry.type === "custom_message");
	assert.equal(handoffEntry.length, 1, "exactly one hidden custom message");
	assert.equal(handoffEntry[0].customType, HANDOFF_TYPE);
	assert.equal(handoffEntry[0].display, false);
	assert.ok(handoffEntry[0].content.includes("Kyoto"), "the compaction summary travels");

	// The engine's OWN RPC answers with the handoff inside its context.
	const response = await engine.request({ type: "get_messages" });
	assert.equal(response.success, true);
	const messages = response.data?.messages;
	assert.ok(Array.isArray(messages));
	assert.ok(
		messages.some((m) => m && m.customType === HANDOFF_TYPE),
		`the handoff is missing from the engine's context: ${JSON.stringify(messages).slice(0, 500)}`,
	);

	// History continuity: a fresh engine reopens the chat where it was, chain included.
	await engine.stop();
	const again = new AgentEngine(engineOptions());
	engines.push(again);
	// L44 proof step: when the reopen fails, CI shows the engine's and the daemon's own logs.
	const withLogs = (what) => `${what}; logs: ${logs.join(" | ").slice(-6000)}`;
	await again.start().catch((error) => assert.fail(withLogs(`the second engine did not start: ${error.message}`)));
	assert.equal(again.sessionFile, seed, withLogs("the chat reopens on the seeded session"));
	assert.deepEqual(again.previousSessions, [first], withLogs("the chain of files survives the restart"));
	const saved = JSON.parse(fs.readFileSync(path.join(base, "island", "state.json"), "utf8"));
	assert.equal(saved.sessionFile, seed, withLogs("state.json keeps naming the seeded session"));
});
