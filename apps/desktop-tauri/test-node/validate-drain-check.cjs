'use strict';
// The validator's final JSONL wait must not depend on EVERY holder of the pipe closing it (flaky gate, run 1).
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { drained } = require('../packaging/validate/drain.cjs');

const exited = child => new Promise(resolve => (child.exitCode !== null ? resolve() : child.once('exit', resolve)));

test('a grandchild that keeps stdout open after the child exited does not stall the drain; the data is all there', async () => {
  // `sh` prints, leaves `sleep` holding the inherited pipe, and exits 0 at once: exactly the failing shape.
  const child = cp.spawn('sh', ['-c', 'echo line-1; echo line-2; sleep 6 & exit 0'], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
  let text = ''; child.stdout.on('data', d => { text += d; });
  await exited(child);
  const began = Date.now();
  const how = await drained(child, { quietMs: 300 });
  const took = Date.now() - began;
  try {
    assert.equal(how, 'quiet'); assert.ok(took < 2000, `took ${took} ms`);
    assert.equal(child.stdout.readableEnded, false, 'the pipe really was still held open');
    assert.equal(text, 'line-1\nline-2\n');
  } finally { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }
});

test('a clean exit ends at EOF at once; a still-writing holder keeps the drain waiting until it goes quiet', async () => {
  const clean = cp.spawn('sh', ['-c', 'echo a'], { stdio: ['ignore', 'pipe', 'ignore'] });
  clean.stdout.resume(); await exited(clean);
  assert.equal(await drained(clean, { quietMs: 5000 }), 'ended');
  // fake clock: data keeps arriving, so «quiet» is never reached before the cap
  let t = 0; const EventEmitter = require('node:events');
  const fake = { stdout: Object.assign(new EventEmitter(), { readableEnded: false }) };
  const how = await drained(fake, { quietMs: 100, maxMs: 1000, now: () => t, pause: async ms => { t += ms; fake.stdout.emit('data', 'x'); } });
  assert.equal(how, 'timeout');
  // and the listener is always removed
  assert.equal(fake.stdout.listenerCount('data'), 0);
});

test('validate.cjs drains with the quiet rule, reaps the startup group and scopes sessions to itself', () => {
  const src = fs.readFileSync(path.join(__dirname, '../packaging/validate.cjs'), 'utf8');
  assert.doesNotMatch(src, /readableEnded, 3000/, 'no more waiting for EOF with a 3 s limit');
  assert.equal((src.match(/await drained\(/g) || []).length, 2, "the final wait and the startup loop (manual + login)");
  assert.match(src, /ABITO_SESSIONS_SCOPE_PID = String\(process.pid\)/, "validation sees only its own sessions");
  assert.match(src, /stopGroup\(startup, 'SIGTERM'\)/);
});
