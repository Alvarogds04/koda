#!/usr/bin/env node
'use strict';
/* Re-hash a STAGED directory against its receipt WITHOUT launching anything.
   Usage: node packaging/verify.cjs <stage-dir>
   (K2-02 T2: the stage carries the runtime archive as a hashed file. An INSTALLED
   prefix is verified by install.sh/checkInstalledLayout instead: there runtime/
   replaces the archive, so the stage's exact file set does not apply.) */
const path = require('node:path');
const L = require('./lib.cjs');
const dir = process.argv[2];
if (!dir) { console.error('usage: verify.cjs <stage-dir>'); process.exit(2); }
const crate = path.resolve(__dirname, '..');
const problems = L.verifyStage(path.resolve(dir), { sourceCrate: crate });
if (problems.length) { console.error('FAIL:\n - ' + problems.join('\n - ')); process.exit(1); }
console.log('OK: every file matches the receipt; launcher/desktop are the closed templates; no devtools markers; no source-tree path in the binary');
