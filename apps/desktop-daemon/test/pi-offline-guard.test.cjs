"use strict";
// K2-02 follow-up (RDD advisory 6), K2-05 T2: the S1/S3 proof (pi-offline.test.cjs) must never pass
// silently when no real engine is available. Run as a user runs it (`node --test`, a child process)
// with NO Gentle Shell anywhere (no GENTLE_PI_ROOT, no bundled runtime next to this Node, a PATH
// without `pi`):
//   - default (a dev machine): the real-engine test is reported as SKIPPED with the reason — never a
//     bare pass; the pure env test still runs;
//   - KODA_REQUIRE_GENTLE=1: the run FAILS and says that Gentle Shell is required.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const TARGET = path.join(__dirname, "pi-offline.test.cjs");

function runWithoutEngine(t, extraEnv) {
	const empty = fs.mkdtempSync(path.join(os.tmpdir(), "abito-no-gentle-"));
	t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
	const env = { ...process.env, ...extraEnv };
	delete env.PI_CODING_AGENT_ROOT;
	delete env.GENTLE_PI_ROOT;
	// A child `node --test` that inherits NODE_TEST_CONTEXT reports to this runner instead of printing its TAP.
	delete env.NODE_TEST_CONTEXT;
	delete env.KODA_PI_OFFLINE_RED;
	if (!("KODA_REQUIRE_PI" in extraEnv)) delete env.KODA_REQUIRE_PI;
	if (!("KODA_REQUIRE_GENTLE" in extraEnv)) delete env.KODA_REQUIRE_GENTLE;
	// No `pi` reachable either: the runner's node dir may also hold an npm-global `pi`, so it stays
	// off PATH (the child is spawned by absolute path).
	env.PATH = empty;
	return spawnSync(process.execPath, ["--test", "--test-reporter=tap", TARGET], { encoding: "utf8", env, timeout: 60_000 });
}

test("no engine on a dev machine: the real-engine test is SKIPPED with the reason, the pure env test still runs", (t) => {
	const r = runWithoutEngine(t, {});
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.match(r.stdout, /^# skipped 1$/m, r.stdout);
	assert.match(r.stdout, /^# pass 1$/m, r.stdout);
	assert.match(r.stdout, /# SKIP Gentle Shell \(gentle-pi\) not found; set GENTLE_PI_ROOT/, r.stdout);
});

test("no engine with KODA_REQUIRE_GENTLE=1: the proof FAILS loudly and names the reason", (t) => {
	const r = runWithoutEngine(t, { KODA_REQUIRE_GENTLE: "1" });
	assert.notEqual(r.status, 0, "must fail");
	assert.match(r.stdout + r.stderr, /KODA_REQUIRE_GENTLE=1 but no Gentle Shell was found \(set GENTLE_PI_ROOT or build the bundled runtime\)/);
	assert.doesNotMatch(r.stdout + r.stderr, /ERR_INVALID_ARG_TYPE/, "not a TypeError from path.join(undefined)");
});

test("the engine proof and this guard are part of `npm test`, the script every CI desktop-daemon job runs", () => {
	let pkg;
	try { pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")); } catch (e) { assert.fail(`cannot read package.json: ${e.message}`); }
	const script = pkg.scripts.test;
	for (const file of ["test/pi-offline.test.cjs", "test/pi-offline-guard.test.cjs", "test/white-label.test.cjs"]) {
		assert.ok(script.split(/\s+/).includes(file), `${file} is run by npm test`);
	}
});
