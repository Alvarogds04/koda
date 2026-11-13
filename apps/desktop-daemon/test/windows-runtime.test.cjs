"use strict";

/**
 * Windows daemon runtime (T2): session publication through the NATIVE helper.
 *
 * The launch token lives in session.json; on Windows that file must be created
 * with an explicit protected owner-only DACL — something Node cannot do — so
 * the daemon invokes the fixed-location native helper and publishes the session
 * ONLY after it succeeds. The token travels on the helper's STDIN, never on
 * argv, never in the environment.
 *
 * The pure fail-closed logic runs on every platform. The live-helper tests run
 * only on Windows (they need the compiled abito-private-session.exe); elsewhere
 * they skip with an explicit "missing native proof" note.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { PROTOCOL, publishSessionWindows, sessionHelperCandidates } = require("../src/daemon.cjs");
const { Daemon } = require("../src/daemon.cjs");
const { windowsIslandRootViolation } = require("../src/isolation.cjs");
const { windowsPackageCliJs } = require("../src/runtime.cjs");

const WIN = process.platform === "win32";
const PAYLOAD = () => ({
	protocol: PROTOCOL,
	endpoint: "\\\\.\\pipe\\abito-0123456789abcdef0123456789abcdef",
	token: "c2Vzc2lvbi10b2tlbi1iYXNlNjR1cmw",
	pid: process.pid,
	startedAt: Date.now(),
});

test("native Windows verification maps only a silent successful helper to true", () => {
    const { verifySessionWindows } = require("../src/daemon.cjs");
    for (const [result, expected] of [
        [{ status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, true],
        [{ status: 1 }, false], [{ status: null, error: new Error("timeout") }, false],
        [{ status: 0, stdout: Buffer.from("unexpected") }, false],
    ]) {
        assert.equal(verifySessionWindows(os.tmpdir(), { helperPath: "fixed-helper.exe", spawnSync(exe, args, options) {
            assert.equal(exe, "fixed-helper.exe");
            assert.deepEqual(args, ["--verify"]);
            assert.equal(options.input, undefined, "no token on stdin");
            assert.equal(options.timeout, 5000);
            return result;
        } }), expected);
    }
});

test("Windows classify is read-only and healthy only after native verification", async () => {
    const { classifySession } = require("../src/daemon.cjs");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "abito-classify-"));
    const runtime = path.join(root, "runtime");
    fs.mkdirSync(runtime, { mode: 0o700 });
    const file = path.join(runtime, "session.json");
    fs.writeFileSync(file, JSON.stringify(PAYLOAD()), { mode: 0o600 });
    const before = fs.readFileSync(file);
    try {
        let calls = 0;
        const verdict = await classifySession(root, { platform: "win32", nativeVerify: () => { calls++; return true; } });
        assert.deepEqual(verdict, { state: "healthy", reason: "ready", ready: true });
        assert.equal(calls, 1);
        const denied = await classifySession(root, { platform: "win32", nativeVerify: () => false });
        assert.notEqual(denied.state, "healthy");
        assert.equal(denied.ready, false);
        assert.deepEqual(fs.readFileSync(file), before);
        assert.deepEqual(fs.readdirSync(runtime), ["session.json"]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("sessionHelperCandidates is fixed (no PATH, no CWD) and empty off Windows", () => {
	const candidates = sessionHelperCandidates();
	if (WIN) {
		assert.ok(candidates.length >= 1, "at least the installed sibling location");
	} else {
		assert.deepEqual(candidates, [], "no helper lookup off Windows");
	}
	for (const candidate of candidates) {
		assert.ok(path.isAbsolute(candidate), "every candidate is absolute");
		assert.ok(candidate.endsWith("abito-private-session.exe"), "candidate names the helper");
		assert.ok(!candidate.includes(process.cwd()), "never resolved through the working directory");
	}
});

test("publishSessionWindows fails closed without a helper", () => {
	// resolveHelper is the product's injection seam: injecting "nothing found" makes the no-helper case
	// deterministic on every OS (on Windows the real installed helper would otherwise be found first).
	assert.throws(() => publishSessionWindows(os.tmpdir(), PAYLOAD(), { helperPath: undefined, resolveHelper: () => undefined }), /helper not found/);
});

test("publishSessionWindows refuses a non-zero helper exit", () => {
	const seen = [];
	const spawnSync = (exe, args, opts) => {
		seen.push({ exe, args, opts });
		return { status: 1, stderr: Buffer.from("abito-private-session: runtime directory missing or not private") };
	};
	assert.throws(() => publishSessionWindows(os.tmpdir(), PAYLOAD(), { spawnSync, helperPath: "H.exe" }), /refused the session/);
	// The token never travels on argv and never in the environment.
	assert.deepEqual(seen[0].args, []);
	if ("env" in seen[0].opts) {
		assert.ok(!JSON.stringify(seen[0].opts.env).includes("c2Vzc2lvbi10b2tlbi1iYXNlNjR1cmw"), "the token never travels in the environment");
	}
	assert.ok(seen[0].opts.input.includes("c2Vzc2lvbi10b2tlbi1iYXNlNjR1cmw"), "the token travels on stdin");
	assert.ok(!JSON.stringify(seen[0].opts.input ?? "").includes("undefined"), "payload is plain JSON");
});

test("publishSessionWindows refuses a helper that cannot run", () => {
	const spawnSync = () => ({ status: null, error: new Error("EACCES") });
	assert.throws(() => publishSessionWindows(os.tmpdir(), PAYLOAD(), { spawnSync, helperPath: "H.exe" }), /failed to run/);
});

test("publishSessionWindows succeeds only on a zero exit and bounds the payload", () => {
	const seen = [];
	const spawnSync = (exe, args, opts) => {
		seen.push(opts);
		return { status: 0 };
	};
	assert.equal(publishSessionWindows(os.tmpdir(), PAYLOAD(), { spawnSync, helperPath: "H.exe" }), true);
	// An oversized payload is refused BEFORE the helper ever runs.
	const huge = { ...PAYLOAD(), token: "x".repeat(8192) };
	assert.throws(() => publishSessionWindows(os.tmpdir(), huge, { spawnSync, helperPath: "H.exe" }), /size bound/);
	assert.equal(seen.length, 1, "the oversized payload never reached a helper");
});

// ---- engine command resolution (Windows spawns Node + the package CLI JS) --

test("windowsPackageCliJs resolves the pi package's own bin entry from the npm prefixes", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "abito-pi-"));
	try {
		const packageDir = path.join(root, "npm", "node_modules", "@earendil-works", "pi-coding-agent");
		fs.mkdirSync(path.join(packageDir, "dist"), { recursive: true });
		fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ bin: { pi: "dist/pi.js" } }));
		fs.writeFileSync(path.join(packageDir, "dist", "pi.js"), "");
		const deps = {
			env: { AppData: root },
			execPath: path.join(root, "nodejs", "node.exe"),
			readFileSync: fs.readFileSync,
			statSync: fs.lstatSync,
		};
		assert.equal(windowsPackageCliJs("pi", deps), path.join(packageDir, "dist", "pi.js"));
		// Without AppData, the Node directory is the fallback prefix: the package sits under it.
		fs.mkdirSync(path.join(root, "npm", "nodejs"), { recursive: true });
		assert.equal(windowsPackageCliJs("pi", { ...deps, env: {}, execPath: path.join(root, "npm", "node.exe") }), path.join(packageDir, "dist", "pi.js"));
		// A foreign command name has no bin entry in this package.
		assert.equal(windowsPackageCliJs("other-agent", deps), undefined);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("windowsPackageCliJs refuses absolute and climbing bin entries and missing files", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "abito-pi-"));
	try {
		const packageDir = path.join(root, "npm", "node_modules", "@earendil-works", "pi-coding-agent");
		fs.mkdirSync(packageDir, { recursive: true });
		fs.writeFileSync(path.join(root, "evil.js"), "");
		const deps = { env: { AppData: root }, execPath: "node", readFileSync: fs.readFileSync, statSync: fs.lstatSync };
		for (const bin of ["../evil.js", path.join(root, "evil.js"), "dist/missing.js", "dist"] ) {
			fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ bin: { pi: bin } }));
			assert.equal(windowsPackageCliJs("pi", deps), undefined, bin);
		}
		assert.equal(windowsPackageCliJs("pi", { ...deps, env: {} }), undefined, "nothing installed");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

// ---- B5: the Windows root is validated BEFORE anything is created ----------

test("windowsIslandRootViolation mirrors the canonical policy (win semantics)", () => {
	const local = "C:\\Users\\a\\AppData\\Local";
	const win = { platform: "win32", env: { LOCALAPPDATA: local } };
	// The canonical root itself and anything inside it are accepted.
	assert.equal(windowsIslandRootViolation(path.join(local, "Koda"), win.env, win.platform), null);
	assert.equal(windowsIslandRootViolation(path.join(local, "Koda", "test-island"), win.env, win.platform), null);
	for (const bad of [
		path.join(local, "Elsewhere"),
		"D:\\island",
		path.join(local, "Koda", "..", "..", "steal"),
		path.join(local, "AbitoEvil"),
		"relative\\root",
		"",
	]) {
		assert.match(windowsIslandRootViolation(bad, win.env, win.platform), /canonical|absolute/,
			`refused: ${bad}`);
	}
	// Missing LOCALAPPDATA: nothing canonical to anchor on — refused.
	assert.match(windowsIslandRootViolation(path.join(local, "Koda"), {}, win.platform), /LOCALAPPDATA/);
	// Off Windows (injected platform): no Windows rule, root passes through.
	assert.equal(windowsIslandRootViolation("/any/root", {}, "linux"), null);
	// The DEFAULT platform call must accept the canonical root of THIS platform (a POSIX path is only
	// acceptable where the POSIX rule applies; Windows requires the %LOCALAPPDATA%\Koda anchor).
	const defaultRoot = process.platform === "win32"
		? path.join(process.env.LOCALAPPDATA, "Koda")
		: "/any/root";
	assert.equal(windowsIslandRootViolation(defaultRoot), null);
});

test("Daemon refuses a forbidden Windows root BEFORE creating anything", async () => {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "abito-root-"));
	try {
		const forbidden = path.join(base, "elsewhere");
		const daemon = new Daemon({ root: forbidden, platform: "win32", env: { LOCALAPPDATA: base } });
		await assert.rejects(() => daemon.start(), /refusing island root/);
		// Nothing was created in the forbidden root and the state is untouched.
		assert.equal(fs.existsSync(forbidden), false, "the forbidden root must stay untouched");
		assert.equal(fs.existsSync(path.join(base, "Koda")), false);
		assert.equal(daemon.status().state, "stopped");
	} finally {
		fs.rmSync(base, { recursive: true, force: true });
	}
});

test("live Windows OS: a non-canonical root is refused before any write", { skip: WIN ? false : "needs real Windows" }, async () => {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "abito-root-live-"));
	try {
		// Real drive paths: the canonical-bypass refusal itself (root outside
		// %LOCALAPPDATA%\Koda) fires before anything is created.
		const local = path.join(base, "Users", "a", "AppData", "Local");
		fs.mkdirSync(local, { recursive: true });
		const daemon = new Daemon({
			root: path.win32.join(local, "Elsewhere"),
			env: { ...process.env, LOCALAPPDATA: local },
		});
		await assert.rejects(() => daemon.start(), /refusing island root.*canonical/s);
		assert.equal(fs.existsSync(path.join(local, "Elsewhere")), false);
		assert.equal(fs.existsSync(path.join(local, "Koda")), false);
	} finally {
		fs.rmSync(base, { recursive: true, force: true });
	}
});

// ---- live helper (Windows + compiled helper only): the native ACL proof -----

const helper = WIN
	? path.resolve(__dirname, "..", "..", "desktop-tauri", "target", "debug", "abito-private-session.exe")
	: undefined;
const hasHelper = WIN && helper && fs.existsSync(helper) && fs.statSync(helper).isFile();

test("live helper writes the canonical session file and refuses unsafe input", { skip: !hasHelper && "needs Windows + compiled abito-private-session.exe (missing native proof on this platform)" }, () => {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "abito-session-"));
	try {
		const runtime = path.join(base, "Koda", "runtime");
		fs.mkdirSync(runtime, { recursive: true });
		const spawnSync = require("node:child_process").spawnSync;
		const run = (input, env = {}) =>
			spawnSync(helper, [], { input, timeout: 5000, windowsHide: true, env: { ...process.env, LOCALAPPDATA: base, ...env } });
		// Happy path: the session lands exactly at <canonical>/runtime/session.json.
		let result = run(JSON.stringify(PAYLOAD()));
		assert.equal(result.status, 0, String(result.stderr));
		const file = path.join(base, "Koda", "runtime", "session.json");
		const written = JSON.parse(fs.readFileSync(file, "utf8"));
		assert.equal(written.protocol, PROTOCOL);
		assert.equal(written.token, PAYLOAD().token);
		// Malformed input: refused, nothing written.
		result = run("{ not json");
		assert.notEqual(result.status, 0);
		// Unsafe override outside the canonical root: refused, nothing written anywhere.
		const outside = path.join(base, "elsewhere");
		fs.mkdirSync(path.join(outside, "runtime"), { recursive: true });
		result = run(JSON.stringify(PAYLOAD()), { KODA_ISLAND_DIR: outside });
		assert.notEqual(result.status, 0);
		assert.equal(fs.existsSync(path.join(outside, "runtime", "session.json")), false);
	} finally {
		fs.rmSync(base, { recursive: true, force: true });
	}
});

// K2-01b P1: the daemon validates its island root against ITS env's %LOCALAPPDATA% (options.env), so the native helper,
// which re-checks the same canonical-root policy, must be given that same LOCALAPPDATA — not the process's. Production
// passes process.env, so the helper env stays exactly process.env + KODA_ISLAND_DIR there.
test("K2-01b: the session helper gets the daemon env's LOCALAPPDATA; without an injected env it is process.env + KODA_ISLAND_DIR", async () => {
	const { verifySessionWindows, classifySession } = require("../src/daemon.cjs");
	const root = path.join(os.tmpdir(), "abito-p1-root");
	const env = { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local-private", PATH: "x" };
	const seen = [];
	const spawnSync = (exe, args, opts) => (seen.push(opts.env), { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
	publishSessionWindows(root, PAYLOAD(), { spawnSync, helperPath: "H.exe", env });
	assert.equal(verifySessionWindows(root, { spawnSync, helperPath: "H.exe", env }), true);
	for (const e of seen) {
		assert.equal(e.LOCALAPPDATA, env.LOCALAPPDATA, "the helper checks the root against the daemon's LOCALAPPDATA");
		assert.equal(e.KODA_ISLAND_DIR, path.resolve(root));
	}
	// An injected env WITHOUT LOCALAPPDATA never inherits the process's: the helper fails closed like the daemon did.
	seen.length = 0;
	publishSessionWindows(root, PAYLOAD(), { spawnSync, helperPath: "H.exe", env: { PATH: "x" } });
	assert.equal("LOCALAPPDATA" in seen[0], false);
	// Production: no env injected -> exactly process.env plus KODA_ISLAND_DIR.
	seen.length = 0;
	publishSessionWindows(root, PAYLOAD(), { spawnSync, helperPath: "H.exe" });
	verifySessionWindows(root, { spawnSync, helperPath: "H.exe" });
	for (const e of seen) assert.deepEqual(e, { ...process.env, KODA_ISLAND_DIR: path.resolve(root) });
	// classifySession forwards its env to the native verification (a well-formed session file makes it ask).
	const island = fs.mkdtempSync(path.join(os.tmpdir(), "abito-p1-"));
	fs.mkdirSync(path.join(island, "runtime"), { mode: 0o700 });
	fs.writeFileSync(path.join(island, "runtime", "session.json"), JSON.stringify({ protocol: PROTOCOL, endpoint: "x", token: "t", pid: 2, startedAt: 1 }), { mode: 0o600 });
	const verified = [];
	try {
		await classifySession(island, { platform: "win32", env, nativeVerify: (r, deps) => (verified.push([r, deps && deps.env]), false) });
	} finally {
		fs.rmSync(island, { recursive: true, force: true });
	}
	assert.deepEqual(verified, [[island, env]]);
});
