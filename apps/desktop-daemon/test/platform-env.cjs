'use strict';
// Cross-OS test helpers for the desktop-daemon suite (mirrors apps/desktop-harness/test/platform-env.cjs).
// Nothing here skips a cross-OS behaviour silently: `unixOnly` prints the named Windows twin (or registered
// gap) in the CI output, and `assertMode` asserts the SAME privacy rule through each platform's own mechanism.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');

const win = process.platform === 'win32';

// os.tmpdir() on Windows runners is the 8.3 short form (C:\Users\RUNNER~1\...); fixtures that feed the
// product's path rules or %LOCALAPPDATA% use the canonical long form (identity on Linux/macOS).
const tmpBase = () => fs.realpathSync.native(os.tmpdir());

// 0600/0700 on Unix (mode bits); on Windows the same privacy rule through the verified helper's real DACL
// check (HU-061, test/win-private.cjs). Other modes have no Windows meaning and stay Unix-only.
function assertMode(p, mode) {
	if (!win) return assert.equal(fs.statSync(p).mode & 0o777, mode, `${p} must have mode ${mode.toString(8)}`);
	assert.ok(mode === 0o600 || mode === 0o700, `no Windows twin for mode ${mode.toString(8)}`);
	require('./win-private.cjs').assertPrivate(p, mode === 0o700 ? 'dir' : 'file');
}

// Tests of a Unix-only MECHANISM (mode bits, uid, #!/bin/sh fixtures). `twin` names the Windows twin test
// or the registered gap; the skip reason is printed by CI so nothing is skipped silently.
const unixOnly = (twin) => ({ skip: win && `Unix mechanism; Windows: ${twin}` });

module.exports = { win, tmpBase, assertMode, unixOnly };
