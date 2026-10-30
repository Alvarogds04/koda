'use strict';
// Supplemental sound check runs every test file under strace; command idea: `strace -f -e trace=connect,openat npm test`
// and inspect that socket connections and handoff reads stay in test-owned temporary directories.
// Structural guard: no test may resolve the REAL island runtime (/run/user/<uid>/abito-island), because with a
// live island a test could read its handoff and send a real question to the human's screen. Every test that
// calls a hook handler, resolveConfig or spawns the hook binary must pin ABITO_SOCKET_DIR or ABITO_DESKTOP_SOCKET.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dir = __dirname;
const files = fs.readdirSync(dir).filter(f => f.endsWith('.test.cjs') && f !== 'no-live-island.test.cjs');

test('no test passes an empty or unpinned env to a hook handler or resolveConfig', () => {
  const offenders = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const calls = /handle(Claude|Codex)Hook\(|resolveConfig\(/.test(line) || /\bcall\(/.test(line) && f.startsWith('codex');
      if (!calls) return;
      const emptyHandlerEnv = /env:\s*\{\s*\}/.test(line);
      // resolveConfig({}, uid) is only safe for a uid that is not ours (4321 never exists here) or for the invalid-uid
      // loop, which throws before reading anything
      const emptyResolve = /resolveConfig\(\s*\{\s*\}\s*,/.test(line) && !/,\s*4321\b/.test(line) && !/for \(const uid of \[/.test(line);
      if (emptyHandlerEnv || emptyResolve) offenders.push(`${f}:${i + 1} empty env`);
      // default-runtime lookups must use a uid that cannot be the real one
      const m = line.match(/resolveConfig\([^)]*?,\s*(\d+)\b/);
      if (m && Number(m[1]) === process.getuid?.() && !/ABITO_SOCKET_DIR|ABITO_DESKTOP_SOCKET/.test(line)) offenders.push(`${f}:${i + 1} real uid with default runtime`);
    });
  }
  assert.deepEqual(offenders, []);
});

test('hook-binary spawn helpers default to a nonexistent runtime', () => {
  const offenders = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of text.matchAll(/spawn\(process\.execPath,\s*\[bin[^\]]*\],\s*\{\s*env:\s*\{([^}]*)\}/g)) {
      if (!/ABITO_SOCKET_DIR|ABITO_DESKTOP_SOCKET/.test(m[1])) offenders.push(`${f}: spawn env without a pinned runtime`);
    }
  }
  assert.deepEqual(offenders, []);
});
