'use strict';
/* P3 — self-cleaning temp dirs for the node checks (same idea as the N7 UDS leaves):
   every dir is removed when the process exits (also after a failure), dirs left by DEAD
   runs are swept on the next use, and only dirs of our exact shape are ever touched.
   Run: node apps/desktop-tauri/test-node/tmpdirs-check.cjs */
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const T = require('./tmpdirs.cjs');
let passed = 0;
const test = (name, fn) => { fn(); passed += 1; };
const base = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tmpdirs-test-')));
const names = b => fs.readdirSync(b).sort();
// the pid of a process that has already exited (so /proc/<pid> is gone)
const deadPid = () => Number(cp.spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString());

test('make() creates a private dir named <prefix><pid>-<random> inside the base', () => {
  const b = base();
  const d = T.make('abito-x-', { base: b });
  assert.equal(path.dirname(d), b);
  assert.match(path.basename(d), new RegExp(`^abito-x-${process.pid}-[A-Za-z0-9]{6}$`));
  assert.equal(fs.statSync(d).mode & 0o777, 0o700);
  fs.rmSync(d, { recursive: true }); fs.rmdirSync(b);
});

test('a child process that makes dirs leaves NONE behind when it exits, even after throwing', () => {
  const b = base();
  const run = (code) => cp.spawnSync(process.execPath, ['-e', code], { env: { ...process.env, TMPDIRS_BASE: b }, encoding: 'utf8' });
  const prog = fail => `const T=require(${JSON.stringify(path.join(__dirname, 'tmpdirs.cjs'))}); for (let i=0;i<5;i++){ const d=T.make('abito-c-',{base:process.env.TMPDIRS_BASE}); require('fs').writeFileSync(d+'/f','x'); require('fs').mkdirSync(d+'/sub'); } ${fail ? "throw new Error('boom')" : ''}`;
  assert.equal(run(prog(false)).status, 0);
  assert.deepEqual(names(b), [], 'normal exit cleans');
  assert.notEqual(run(prog(true)).status, 0);
  assert.deepEqual(names(b), [], 'an uncaught error still cleans (exit handler)');
  fs.rmdirSync(b);
});

test('dirs of DEAD runs are swept on the next use; dirs of LIVE processes and foreign shapes are never touched', () => {
  const b = base();
  const dead = deadPid();
  const mk = n => { const p = path.join(b, n); fs.mkdirSync(p, { mode: 0o700 }); fs.writeFileSync(path.join(p, 'junk'), 'x'); return p; };
  const abandoned = mk(`abito-s-${dead}-AbCdEf`);
  const alive = mk(`abito-s-${process.pid}-ZzZzZz`);      // ours: alive
  const parent = mk(`abito-s-${process.ppid}-QqQqQq`);    // another LIVE process
  const otherPrefix = mk(`other-s-${dead}-AbCdEf`);       // another prefix: not ours to sweep
  const badName = mk(`abito-s-notapid-AbCdEf`);
  const tooShort = mk(`abito-s-${dead}-Ab`);
  const wide = mk(`abito-s-${dead}-WwWwWw`); fs.chmodSync(wide, 0o755); // not 0700: not provably ours
  const file = path.join(b, `abito-s-${dead}-FfFfFf`); fs.writeFileSync(file, 'a plain file');
  const outside = base(); fs.writeFileSync(path.join(outside, 'precious'), 'keep');
  fs.symlinkSync(outside, path.join(b, `abito-s-${dead}-LlLlLl`));
  const fresh = T.make('abito-s-', { base: b });          // triggers the sweep
  assert.equal(fs.existsSync(abandoned), false, 'the dead run\'s dir is gone');
  for (const keep of [alive, parent, otherPrefix, badName, tooShort, wide, file, fresh]) assert.ok(fs.existsSync(keep), keep);
  assert.ok(fs.existsSync(path.join(outside, 'precious')), 'a symlinked «dir» is never followed');
  fs.rmSync(b, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true });
});

test('repeated runs do not pile up: after 3 child runs the base is empty', () => {
  const b = base();
  for (let i = 0; i < 3; i++) cp.spawnSync(process.execPath, ['-e', `const T=require(${JSON.stringify(path.join(__dirname, 'tmpdirs.cjs'))}); for (let i=0;i<20;i++) T.make('abito-r-',{base:${JSON.stringify(b)}});`]);
  assert.deepEqual(names(b), []);
  fs.rmdirSync(b);
});

test('the node checks themselves use the helper (no raw mkdtemp left behind)', () => {
  for (const f of ['install-check.cjs', 'packaging-check.cjs']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    assert.doesNotMatch(src, /fs\.mkdtempSync\(path\.join\(os\.tmpdir\(\)/, `${f} must create temp dirs through tmpdirs.cjs`);
    assert.match(src, /require\('\.\/tmpdirs\.cjs'\)/, f);
  }
});

console.log(`tmpdirs-check: ${passed} passed`);
