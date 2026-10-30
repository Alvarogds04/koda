'use strict';
const { tmpBase } = require('./platform-env.cjs');
// HU-015 unit B: exercise the shipped installer CLI on isolated user directories only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const CLI = path.resolve(__dirname, '../bin/abito-hook.cjs');
const MANIFEST = '.abito-manifest.json';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const base = fs.mkdtempSync(path.join(tmpBase(), 'abito-pi-install-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home'); fs.mkdirSync(home, {mode:0o700});
  // Reproduce the packaged sibling layout/modes, not a group-writable development checkout.
  const bundle = path.join(base, 'bundle');
  for (const dir of ['src', 'bin']) fs.cpSync(path.resolve(__dirname, '..', dir), path.join(bundle, 'desktop-harness', dir), {recursive:true});
  fs.mkdirSync(path.join(bundle, 'desktop-daemon/src'), {recursive:true});
  fs.copyFileSync(path.resolve(__dirname, '../../desktop-daemon/src/procinfo.cjs'), path.join(bundle, 'desktop-daemon/src/procinfo.cjs'));
  fs.mkdirSync(path.join(bundle, 'desktop-pi'));
  for (const file of ['pi-extension.ts','adapter.cjs','ask-tool.cjs','config.cjs','native-ask.cjs','questions.cjs','security.cjs','windows-transport.cjs']) {
    const target = path.join(bundle, 'desktop-pi', file);
    fs.copyFileSync(path.resolve(__dirname, '../../desktop-pi', file), target); fs.chmodSync(target, 0o644);
  }
  const cli = path.join(bundle, 'desktop-harness/bin/abito-hook.cjs');
  const audit = path.join(home, 'audit'); fs.mkdirSync(audit, { mode: 0o700 });
  const target = path.join(home, '.pi/agent/extensions/abito-island');
  const extraEnv = {};
  const run = (...args) => {
    const result = spawnSync(process.execPath, [cli, 'install', 'pi', '--user', '--json', ...args], {
      env: { HOME: home, USERPROFILE: home, PATH: '/usr/bin:/bin', ABITO_ISLAND_EXE: process.execPath, ...extraEnv }, encoding: 'utf8', timeout: 10000,
    });
    assert.ifError(result.error);
    assert.equal(result.stderr, '', 'machine mode uses one JSON line, never stderr');
    assert.equal(result.stdout.trim().split('\n').length, 1);
    return { code: result.status, value: JSON.parse(result.stdout) };
  };
  const apply = (hash, ...args) => run(...args, '--apply-plan', hash, '--audit-dir', audit);
  return { home, target, audit, run, apply, bundle, extraEnv };
}
function snapshot(dir) {
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir).sort().map(name => {
    const file = path.join(dir, name), st = fs.lstatSync(file);
    return [name, st.isSymbolicLink() ? ['symlink', fs.readlinkSync(file)] : st.isDirectory() ? snapshot(file) : fs.readFileSync(file).toString('base64')];
  });
}

test('Pi preview writes nothing; confirmed install owns a closed loadable payload; remove keeps unrelated user files', t => {
  const f = fixture(t), before = snapshot(f.home);
  const preview = f.run();
  assert.equal(preview.code, 0); assert.equal(preview.value.mode, 'preview');
  assert.equal(preview.value.target, f.target); assert.equal(preview.value.changed, true);
  assert.deepEqual(snapshot(f.home), before);
  const applied = f.apply(preview.value.plan_hash);
  assert.equal(applied.code, 0); assert.equal(applied.value.mode, 'applied');
  const manifest = JSON.parse(fs.readFileSync(path.join(f.target, MANIFEST), 'utf8'));
  assert.equal(manifest.schema, 'abito-pi-extension/1');
  assert(Object.hasOwn(manifest.files, 'index.ts'));
  for (const [name, hash] of Object.entries(manifest.files)) {
    assert.equal(digest(fs.readFileSync(path.join(f.target, name))), hash);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(f.target, name)).mode & 0o077, 0);
  }
  assert.equal(f.run().value.changed, false);
  const unrelated = path.join(path.dirname(f.target), 'my-extension.ts'); fs.writeFileSync(unrelated, '// untouched');
  const remove = f.run('--remove'); assert.equal(remove.code, 0);
  const gone = f.apply(remove.value.plan_hash, '--remove'); assert.equal(gone.code, 0);
  assert.equal(fs.existsSync(f.target), false); assert.equal(fs.readFileSync(unrelated, 'utf8'), '// untouched');
  assert(fs.readFileSync(path.join(f.audit, 'hook-installs.jsonl'), 'utf8').includes('"result"'));
});

test('Pi refuses foreign targets and symlinks without touching their bytes', t => {
  for (const kind of ['foreign', 'symlink']) {
    const f = fixture(t); fs.mkdirSync(path.dirname(f.target), { recursive: true });
    if (kind === 'foreign') { fs.mkdirSync(f.target); fs.writeFileSync(path.join(f.target, 'index.ts'), '// user extension'); }
    else { const other = path.join(f.home, 'other'); fs.mkdirSync(other); fs.symlinkSync(other, f.target); }
    const before = snapshot(f.home), result = f.run();
    assert.equal(result.code, 65, kind); assert.equal(result.value.ok, false);
    assert.deepEqual(snapshot(f.home), before, kind);
  }
});

// HU-052: a hand-copied extension (no manifest) is refused with its OWN code and sentence, never adopted and never touched.
const FOREIGN_SENTENCE = 'Ya hay una extensión de Pi en ~/.pi/agent/extensions/abito-island que Koda no instaló: borrala o renombrala y volvé a conectar.';
// HU-047: a folder another user or group can change is refused with its own code, naming THAT folder and the exact chmod.
test('Pi names the exact group-writable folder and the chmod that fixes it (preview and apply)', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); fs.mkdirSync(path.dirname(f.target), { recursive: true, mode: 0o700 });
  const dir = path.dirname(f.target); fs.chmodSync(dir, 0o775);
  const before = snapshot(f.home);
  for (const args of [[], ['--remove']]) {
    const r = f.run(...args);
    assert.equal(r.code, 65); assert.equal(r.value.ok, false);
    assert.equal(r.value.code, 'unsafe_folder');
    assert.equal(r.value.message, `La carpeta ${dir} la puede modificar otro usuario o grupo; quitale el permiso de escritura (chmod g-w,o-w ${dir}) y volvé a intentar.`);
  }
  assert.deepEqual(snapshot(f.home), before);
  fs.chmodSync(dir, 0o700);
  assert.equal(f.run().code, 0, 'after the fix the install plans normally');
});
test('Pi keeps the generic refusal for a symlinked folder (not a permission problem)', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.home, 'real'), { mode: 0o700 }); fs.symlinkSync(path.join(f.home, 'real'), path.join(f.home, '.pi'));
  const r = f.run(); assert.equal(r.code, 65); assert.equal(r.value.code, 'refused');
});

test('Pi names a hand-copied extension folder (no manifest) as foreign_extension, preview and apply, and never touches it', t => {
  const f = fixture(t); fs.mkdirSync(f.target, { recursive: true, mode: 0o700 });
  // the layout of the real pre-release hand copy: other file names, a SOURCE_COMMIT, no manifest
  for (const name of ['SOURCE_COMMIT', 'adapter.cjs', 'pi-extension.ts', 'protocol.ts', 'index.ts']) fs.writeFileSync(path.join(f.target, name), `// hand copy ${name}`);
  const before = snapshot(f.home);
  for (const args of [[], ['--remove']]) {
    const r = f.run(...args);
    assert.equal(r.code, 65, args.join(' ')); assert.equal(r.value.ok, false);
    assert.equal(r.value.code, 'foreign_extension', args.join(' '));
    assert.equal(r.value.message, FOREIGN_SENTENCE);
  }
  assert.deepEqual(snapshot(f.home), before, 'not a byte of the user folder changed');
});

test('Pi keeps the generic refusal for a symlink target and for a modified Abito copy (only a folder WITHOUT a manifest is foreign_extension)', t => {
  const f = fixture(t); for (const d of ['.pi', '.pi/agent', '.pi/agent/extensions']) fs.mkdirSync(path.join(f.home, d), { mode: 0o700 }); // private folders: only the link is the problem
  const other = path.join(f.home, 'other'); fs.mkdirSync(other); fs.symlinkSync(other, f.target);
  assert.equal(f.run().value.code, 'refused');
  const g = fixture(t); assert.equal(g.apply(g.run().value.plan_hash).code, 0);
  fs.writeFileSync(path.join(g.target, 'user.txt'), 'keep');                    // an Abito folder with an extra file: it HAS a manifest
  const r = g.run('--remove'); assert.equal(r.code, 65); assert.equal(r.value.code, 'refused');
});

// HU-052 / platform parity: HU-047 made the Pi extension install work on Windows too, so the usage text must not say otherwise.
test('the Pi install usage line (no --json) is a usage error that names all three systems and never claims «Linux/macOS only»', () => {
  const r = spawnSync(process.execPath, [CLI, 'install', 'pi'], { encoding: 'utf8', timeout: 10000, env: { PATH: '/usr/bin:/bin' } });
  assert.equal(r.status, 64);
  assert.match(r.stderr, /^usage: abito-hook install pi --user /);
  assert.doesNotMatch(r.stderr, /Linux\/macOS only/);
  assert.match(r.stderr, /Linux, macOS and Windows/);
});

test('Pi rejects stale shown plans before changing the target', t => {
  const f = fixture(t), preview = f.run(); assert.equal(preview.code, 0);
  fs.mkdirSync(f.target, { recursive: true }); fs.writeFileSync(path.join(f.target, 'index.ts'), '// foreign arrived');
  const before = snapshot(f.target), result = f.apply(preview.value.plan_hash);
  assert.notEqual(result.code, 0); assert.equal(result.value.ok, false);
  assert.deepEqual(snapshot(f.target), before);
});

test('Pi refuses unknown entries and changed shipped payload without changing user data', t => {
  const f = fixture(t), pv = f.run(); assert.equal(pv.code,0);
  const source = path.join(f.bundle,'desktop-pi/config.cjs');
  fs.appendFileSync(source, '\\n// new release');
  const before = snapshot(f.home);
  const stale = f.apply(pv.value.plan_hash);
  assert.equal(stale.code,70); assert.equal(stale.value.code,'plan_changed');
  assert.equal(fs.existsSync(f.target),false);
  assert.deepEqual(snapshot(f.home).filter(([n])=>n!=='audit'),before.filter(([n])=>n!=='audit'));
  assert.equal(f.apply(f.run().value.plan_hash).code,0);
  fs.writeFileSync(path.join(f.target,'user.txt'),'keep');
  const owned = snapshot(f.target), refused = f.run('--remove');
  assert.equal(refused.code,65); assert.deepEqual(snapshot(f.target),owned);
});

test('Pi failed replacement restores the prior owned directory and preserves unrelated files', t => {
  const f = fixture(t); assert.equal(f.apply(f.run().value.plan_hash).code,0);
  const before = snapshot(f.target);
  fs.appendFileSync(path.join(f.bundle,'desktop-pi/config.cjs'), '\\n// new release');
  const pv = f.run(); assert.equal(pv.code,0);
  const inject = path.join(f.bundle,'fail.cjs');
  fs.writeFileSync(inject, "const fs=require('fs');const original=fs.renameSync;fs.renameSync=function(a,b){if(a.includes('.abito-island-stage-'))throw Error('fixture');return original(a,b);};");
  f.extraEnv.NODE_OPTIONS = '--require=' + inject;
  const failed = f.apply(pv.value.plan_hash);
  assert.equal(failed.code,70); assert.equal(failed.value.ok,false);
  assert.deepEqual(snapshot(f.target),before);
  assert.deepEqual(fs.readdirSync(path.dirname(f.target)),['abito-island']);
});

test('installed Pi payload loads through the real offline Pi extension loader', async t => {
  const root = process.env.PI_CODING_AGENT_ROOT;
  if (!root) { t.skip('Real Pi root unavailable; set PI_CODING_AGENT_ROOT for installed-payload proof'); return; }
  const f = fixture(t); assert.equal(f.apply(f.run().value.plan_hash).code,0);
  const {pathToFileURL} = require('node:url');
  const loader = await import(pathToFileURL(path.join(root,'dist/core/extensions/loader.js')));
  const result = await loader.loadExtensions([path.join(f.target,'index.ts')], f.home,
    {on:()=>()=>{},emit:()=>{}},loader.createExtensionRuntime());
  assert.deepEqual(result.errors,[]); assert.deepEqual(result.warnings,[]);
  assert.equal(result.extensions.length,1);
  assert.equal(result.extensions[0].tools.has('abito_ask'),true);
  assert.equal(result.extensions[0].tools.size,1);
});

test('Pi discovery sees one extension after upgrade and zero after removal, never backups', async t => {
  const root = process.env.PI_CODING_AGENT_ROOT;
  if (!root) { t.skip('Set PI_CODING_AGENT_ROOT for real discovery'); return; }
  const f = fixture(t), {pathToFileURL} = require('node:url');
  const loader = await import(pathToFileURL(path.join(root,'dist/core/extensions/loader.js')));
  const discover = async count => {
    const r = await loader.discoverAndLoadExtensions([], f.home, path.join(f.home,'.pi/agent'), {on:()=>()=>{},emit:()=>{}});
    assert.deepEqual(r.errors,[]); assert.equal(r.extensions.length,count);
    for (const ext of r.extensions) assert.equal(ext.tools.has('abito_ask'),true);
  };
  assert.equal(f.apply(f.run().value.plan_hash).code,0); await discover(1);
  for (let i=0;i<2;i++) {
    fs.appendFileSync(path.join(f.bundle,'desktop-pi/config.cjs'), '\n// release '+i);
    assert.equal(f.apply(f.run().value.plan_hash).code,0); await discover(1);
  }
  assert.equal(f.apply(f.run('--remove').value.plan_hash,'--remove').code,0); await discover(0);
  const backups = path.join(f.home,'.pi/agent/abito-backups');
  assert.equal(fs.readdirSync(backups).filter(n=>n.startsWith('abito-island.abito-backup-')).length,1);
  assert.equal(fs.statSync(backups).mode & 0o077,0);
});

test('Pi post-publication verification failure quarantines new bytes and restores prior payload', t => {
  const f = fixture(t); assert.equal(f.apply(f.run().value.plan_hash).code,0);
  const before = snapshot(f.target);
  fs.appendFileSync(path.join(f.bundle,'desktop-pi/config.cjs'), '\n// release');
  const pv = f.run(), inject = path.join(f.bundle,'corrupt.cjs');
  fs.writeFileSync(inject, "const fs=require('fs'),p=require('path');const old=fs.renameSync;fs.renameSync=function(a,b){const r=old(a,b);if(a.includes('.abito-island-stage-'))fs.appendFileSync(p.join(b,'config.cjs'),'corrupt');return r;};");
  f.extraEnv.NODE_OPTIONS='--require='+inject;
  const result=f.apply(pv.value.plan_hash);
  assert.equal(result.code,70); assert.equal(result.value.code,'verification_failed');
  assert.deepEqual(snapshot(f.target),before);
  const root=path.join(f.home,'.pi/agent/abito-backups');
  const quarantined=fs.readdirSync(root).find(n=>n.startsWith('.abito-island-quarantine-'));
  assert(quarantined); assert(fs.readFileSync(path.join(root,quarantined,'config.cjs'),'utf8').endsWith('corrupt'));
});

test('Pi rejects hardlinks and conflicting target options without changing installed files', t => {
  const f=fixture(t); assert.equal(f.apply(f.run().value.plan_hash).code,0);
  fs.linkSync(path.join(f.target,'config.cjs'),path.join(f.home,'linked-config'));
  const before=snapshot(f.home);
  assert.equal(f.run('--remove').code,65);
  assert.equal(f.run('--settings',path.join(f.home,'foreign')).code,64);
  assert.deepEqual(snapshot(f.home),before);
});

test('Pi refuses cross-device publication and preserves foreign backup entries when pruning', t => {
  const f=fixture(t); assert.equal(f.apply(f.run().value.plan_hash).code,0);
  const root=path.join(f.home,'.pi/agent/abito-backups');
  const foreign=path.join(root,'abito-island.abito-backup-20000101T000000000Z');
  fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign,'index.ts'),'// user file');
  fs.appendFileSync(path.join(f.bundle,'desktop-pi/config.cjs'),'\n// next');
  const before=snapshot(f.target), pv=f.run(), inject=path.join(f.bundle,'device.cjs');
  fs.writeFileSync(inject,"const fs=require('fs');const old=fs.statSync;fs.statSync=function(p,...rest){const st=old(p,...rest);if(String(p).endsWith('/abito-backups'))st.dev+=1;return st;};");
  f.extraEnv.NODE_OPTIONS='--require='+inject;
  const refused=f.apply(pv.value.plan_hash); assert.equal(refused.code,70); assert.deepEqual(snapshot(f.target),before);
  delete f.extraEnv.NODE_OPTIONS;
  assert.equal(f.apply(pv.value.plan_hash).code,0);
  assert.equal(fs.readFileSync(path.join(foreign,'index.ts'),'utf8'),'// user file');
  fs.chmodSync(root,0o755);
  const unsafe=snapshot(f.home); assert.equal(f.run().code,65); assert.deepEqual(snapshot(f.home),unsafe);
});

test('Pi upgrades an older owned payload with backup and refuses modified or unlisted files', t => {
  const f = fixture(t), preview = f.run(); assert.equal(preview.code, 0);
  assert.equal(f.apply(preview.value.plan_hash).code, 0);
  const file = path.join(f.target, 'config.cjs'), manifestPath = path.join(f.target, MANIFEST);
  fs.writeFileSync(file, '// older Abito release\n' + fs.readFileSync(file, 'utf8'), { mode: 0o600 });
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.files['config.cjs'] = digest(fs.readFileSync(file));
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  const older = snapshot(f.target), upgrade = f.run();
  assert.equal(upgrade.code, 0); assert.equal(upgrade.value.changed, true);
  const result = f.apply(upgrade.value.plan_hash); assert.equal(result.code, 0);
  assert(result.value.backup); assert.deepEqual(snapshot(result.value.backup), older);
  assert.equal(f.run().value.changed, false);
  fs.appendFileSync(file, '\n// user-modified');
  const changed = snapshot(f.target), refused = f.run('--remove');
  assert.equal(refused.code, 65); assert.deepEqual(snapshot(f.target), changed);
});

test('a folder owned by someone else gets its own sentence, naming the folder and NOT suggesting a chmod that cannot fix it', () => {
  const { unsafeFolderMessage } = require('../src/install-ui.cjs');
  const m = unsafeFolderMessage({ dir: '/home/a b/.pi', reason: 'foreign_owner' });
  assert.match(m, /^La carpeta \/home\/a b\/\.pi pertenece a otro usuario/); assert.doesNotMatch(m, /chmod/);
  assert.match(unsafeFolderMessage({ dir: '/home/a b/.pi', reason: 'writable' }), /chmod g-w,o-w '\/home\/a b\/\.pi'/);
});

// HU-047 L2: a failure after the installer created folders leaves none of them behind (only ones THIS run made, only if empty).
test('Pi apply that fails after creating ~/.pi/agent/... removes the empty folders it made and nothing else', { skip: process.platform === 'win32' }, async t => {
  const run = async (f, existing) => {
    const home = f.home, pi = require(path.join(f.bundle, 'desktop-harness/src/install-pi.cjs'));
    for (const d of existing) fs.mkdirSync(path.join(home, d), { mode: 0o700 });
    const plan = pi.planPi({ home, uid: process.getuid?.(), remove: false, execPath: process.execPath, binPath: '/x' });
    const real = fs.chmodSync; let n = 0;
    fs.chmodSync = (...a) => { if (n++ === 0) throw new Error('boom'); return real(...a); }; // the staging step fails, after every folder exists
    try { return await pi.applyPi(plan, { backupPath: plan.backupRoot + '/b', out() {}, err() {} }); } finally { fs.chmodSync = real; }
  };
  const a = fixture(t); assert.equal(await run(a, []), 70);
  assert.equal(fs.existsSync(path.join(a.home, '.pi')), false, 'no empty .pi left');
  const b = fixture(t); assert.equal(await run(b, ['.pi', '.pi/agent']), 70);
  assert.equal(fs.existsSync(path.join(b.home, '.pi/agent')), true, 'a folder that already existed stays');
  assert.equal(fs.existsSync(path.join(b.home, '.pi/agent/extensions')), false, 'the one this run made goes');
  assert.equal(fs.existsSync(path.join(b.home, '.pi/agent/abito-backups')), false);
});
