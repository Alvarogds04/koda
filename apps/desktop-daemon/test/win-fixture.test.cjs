'use strict';
// HU-061 daemon twin of apps/desktop-harness/test/win-fixture.test.cjs. Windows CI lays the checkout out like an install (apps/abito-private-session.exe + apps/abito-install.json written by
// packaging/windows/install-manifest.cjs; see the «Windows install layout» step of preview-pi-pruebas.yml / preview-native-tests-litellm.yml) so the installer tests run the
// real HU-047 path. If that layout is missing the install tests would all fail with helper_untrusted for the wrong reason: fail here, loudly,
// never skip. Linux/macOS never use the helper; this test is the Windows twin of «the installer has a trusted backend».
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const winfs = require('../src/win-fs.cjs');

test('Windows: the install layout and the real ACL helper are present and hash-verified (ABITO_TEST_HELPER)', { skip: process.platform !== 'win32' && 'Windows only; Linux/macOS have no helper' }, () => {
  assert.ok(process.env.ABITO_TEST_HELPER, 'ABITO_TEST_HELPER must be set by the CI step that builds abito-private-session.exe');
  assert.ok(fs.statSync(process.env.ABITO_TEST_HELPER).isFile());
  const trusted = winfs.trustedHelper();
  assert.equal(fs.realpathSync(trusted).toLowerCase(), fs.realpathSync(process.env.ABITO_TEST_HELPER).toLowerCase());
  assert.ok(winfs.active(), 'the real backend is active');
});
