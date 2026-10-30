'use strict';
// Regression for a renamed function left behind in island.js: the 5 s timer called
// paintRing() after #437 renamed it to paintBand(), throwing a ReferenceError every
// 5 s and skipping refreshHost() in that tick. Every bare paint*/render*/refresh*
// call in island.js must have a matching local function declaration.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'island.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');

const declared = new Set();
for (const m of src.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) declared.add(m[1]);
for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g)) declared.add(m[1]);

const called = new Set();
for (const m of src.matchAll(/(?<![.\w$])((?:paint|render|refresh)[A-Z][\w$]*)\s*\(/g)) called.add(m[1]);

const missing = [...called].filter(name => !declared.has(name)).sort();
let failed = 0;
try {
  assert.deepEqual(missing, [], `island.js calls undeclared functions: ${missing.join(', ')}`);
  console.log(`PASS every paint/render/refresh call in island.js is declared (${called.size} names)`);
} catch (e) {
  failed++;
  console.error('FAIL ' + e.message);
}
process.exit(failed ? 1 : 0);
