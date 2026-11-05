"use strict";
// K2-02 follow-up (RDD advisory 6): the S3 proof (pi-offline.test.cjs) must never pass silently when no real Pi is
// available. Run as a user runs it (`node --test`, a child process) with NO Pi anywhere (no PI_CODING_AGENT_ROOT, a PATH
// without `pi`):
//   - default (a dev machine): the two real-Pi tests are reported as SKIPPED with the reason — never a bare pass;
//   - ABITO_REQUIRE_PI=1 (what CI sets in every desktop-daemon job): the run FAILS and says that Pi is required.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const TARGET = path.join(__dirname, "pi-offline.test.cjs");

function runWithoutPi(t, extraEnv) {
	const empty = fs.mkdtempSync(path.join(os.tmpdir(), "abito-no-pi-"));
	t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
	const env = { ...process.env, ...extraEnv };
	delete env.PI_CODING_AGENT_ROOT;
	// A child `node --test` that inherits NODE_TEST_CONTEXT reports to this runner instead of printing its TAP.
	delete env.NODE_TEST_CONTEXT;
	delete env.ABITO_PI_OFFLINE_RED;
	if (!("ABITO_REQUIRE_PI" in extraEnv)) delete env.ABITO_REQUIRE_PI;
	// No `pi` reachable: the runner's node dir may also hold an npm-global `pi`, so it stays off PATH (the child is
	// spawned by absolute path).
	env.PATH = empty;
	return spawnSync(process.execPath, ["--test", "--test-reporter=tap", TARGET], { encoding: "utf8", env, timeout: 60_000 });
}

test("no Pi on a dev machine: the S3 proof reports its two real-Pi tests as SKIPPED with the reason, never a bare pass", (t) => {
	const r = runWithoutPi(t, {});
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.match(r.stdout, /^# skipped 2$/m, r.stdout);
	assert.match(r.stdout, /^# pass 0$/m, r.stdout);
	assert.match(r.stdout, /# SKIP Installed Pi not found; set PI_CODING_AGENT_ROOT/, r.stdout);
});

test("no Pi with ABITO_REQUIRE_PI=1 (CI): the S3 proof FAILS loudly and names the reason", (t) => {
	const r = runWithoutPi(t, { ABITO_REQUIRE_PI: "1" });
	assert.notEqual(r.status, 0, "must fail");
	assert.match(r.stdout + r.stderr, /ABITO_REQUIRE_PI=1 but no installed Pi was found \(set PI_CODING_AGENT_ROOT or put `pi` on PATH\)/);
	assert.doesNotMatch(r.stdout + r.stderr, /ERR_INVALID_ARG_TYPE/, "not a TypeError from path.join(undefined)");
});

test("the S3 proof and this guard are part of `npm test`, the script every CI desktop-daemon job runs", () => {
	let pkg;
	try { pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")); } catch (e) { assert.fail(`cannot read package.json: ${e.message}`); }
	const script = pkg.scripts.test;
	for (const file of ["test/pi-offline.test.cjs", "test/pi-offline-guard.test.cjs"]) {
		assert.ok(script.split(/\s+/).includes(file), `${file} is run by npm test`);
	}
});
