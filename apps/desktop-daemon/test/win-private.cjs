"use strict";

// HU-061: Windows privacy assertion with the REAL HU-047 helper (never a mode comparison: lstat has no POSIX bits there).
// Used only by the win32 twins of the Unix 0600/0700 assertions; on Windows a missing helper layout makes them FAIL (never skip).
const assert = require("node:assert/strict");

function assertPrivate(p, kind = "file") {
	const winfs = require("../src/win-fs.cjs");
	const w = winfs.active();
	assert.ok(w, "the verified Windows helper must be active (CI layout: abito-private-session.exe + abito-install.json)");
	const f = w.checkPath(p);
	assert.equal(f.exists, true, `${p} must exist`);
	assert.equal(f.kind, kind, `${p} must be a ${kind}`);
	assert.equal(f.reparse, false, `${p} must not be a reparse point`);
	assert.equal(f.private, true, `${p} must be private to this user (real DACL)`);
	return f;
}

module.exports = { assertPrivate };
