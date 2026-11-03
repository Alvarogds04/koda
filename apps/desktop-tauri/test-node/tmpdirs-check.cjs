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
  // 0700 is the POSIX privacy; NTFS reports no mode bits (privacy is the per-user %TEMP% ACL), so Windows checks the kind only.
  if (process.platform === 'win32') assert.ok(fs.statSync(d).isDirectory()); else assert.equal(fs.statSync(d).mode & 0o777, 0o700);
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

test('K2-01b: liveness does not depend on /proc — on a system without it (macOS) a LIVE process\'s dir survives the sweep', () => {
  // Simulate macOS: no /proc entries exist. The sweep must still recognise the live parent and keep its dir.
  const b = base();
  const dead = deadPid();
  const mk = n => { const p = path.join(b, n); fs.mkdirSync(p, { mode: 0o700 }); return p; };
  const parent = mk(`abito-m-${process.ppid}-QqQqQq`);
  const abandoned = mk(`abito-m-${dead}-AbCdEf`);
  const zero = mk('abito-m-0-ZzZzZz');                       // pid 0 / huge pids address process groups in kill(2): never "alive"
  const huge = mk(`abito-m-${2 ** 32}-HhHhHh`);
  const realExists = fs.existsSync;
  fs.existsSync = (p) => (String(p).startsWith('/proc/') ? false : realExists(p));
  let fresh;
  try { fresh = T.make('abito-m-', { base: b }); } finally { fs.existsSync = realExists; }
  assert.ok(fs.existsSync(parent), 'the live parent\'s dir is kept without /proc');
  assert.equal(fs.existsSync(abandoned), false, 'a dead run\'s dir is still swept');
  assert.equal(fs.existsSync(zero), true, 'pid 0 never matches the sweep (as before)');
  assert.equal(fs.existsSync(huge), false, 'an impossible pid is not alive: its leftover dir is swept');
  assert.ok(fs.existsSync(fresh));
  fs.rmSync(b, { recursive: true, force: true });
});

test('K2-01b: Windows ownership without uid/mode — only marked dirs in the per-user temp are swept; anything unprovable stays', () => {
  // Driven with the platform seam so it runs on every OS. Windows has no process.getuid and no mode bits: a dir is
  // provably ours only when it is a real dir (no link/junction), carries the marker make() writes there, and sits in
  // the per-user temp dir. Everything else is left alone (fail closed).
  const realGetuid = process.getuid;
  process.getuid = () => { throw new Error('getuid must not be called on Windows'); };
  const tmp = fs.realpathSync.native(os.tmpdir());
  const dead = deadPid();
  const made = [];
  try {
    const mine = T.make('abito-w-', { platform: 'win32' });              // marker written
    made.push(mine);
    assert.ok(fs.existsSync(path.join(mine, T.MARKER)), 'make() marks its dir on Windows');
    const abandoned = path.join(tmp, `abito-w-${dead}-AbCdEf`); fs.mkdirSync(abandoned); fs.writeFileSync(path.join(abandoned, T.MARKER), ''); made.push(abandoned);
    const unmarked = path.join(tmp, `abito-w-${dead}-UnMaRk`); fs.mkdirSync(unmarked); made.push(unmarked);   // another run/tool: not provably ours
    const outsideBase = fs.mkdtempSync(path.join(tmp, 'tmpdirs-wbase-')); made.push(outsideBase);
    const foreignBase = path.join(outsideBase, `abito-w-${dead}-FoReIg`); fs.mkdirSync(foreignBase); fs.writeFileSync(path.join(foreignBase, T.MARKER), '');
    T.sweep('abito-w-', outsideBase, { platform: 'win32' });            // not the per-user temp: never swept
    assert.ok(fs.existsSync(foreignBase), 'a marked dir outside the per-user temp is not provably ours');
    const fresh = T.make('abito-w-', { platform: 'win32' }); made.push(fresh); // sweeps the per-user temp
    assert.equal(fs.existsSync(abandoned), false, 'a marked dead run is swept');
    assert.ok(fs.existsSync(unmarked), 'an unmarked dir of another run is left untouched');
    assert.ok(fs.existsSync(mine), 'our own live dir is kept');
  } finally {
    process.getuid = realGetuid;
    for (const d of made) fs.rmSync(d, { recursive: true, force: true });
  }
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
