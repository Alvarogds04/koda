'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AbitoSound = require('../sound-engine.js');

const PKG = path.join(__dirname, '..');

test('docs/CUES.md table matches CUES (ids, durations, priorities, levels)', () => {
  const md = fs.readFileSync(path.join(PKG, 'docs', 'CUES.md'), 'utf8');
  const rows = md.split('\n').filter((l) => /^\|\s*`snd\./.test(l)).map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));
  assert.equal(rows.length, AbitoSound.CUE_IDS.length);
  const seen = new Set();
  for (const [id, name, trigger, synth, dur, level, prio] of rows) {
    const key = id.replace(/`/g, '');
    seen.add(key);
    const c = AbitoSound.CUES[key];
    assert.ok(c, key + ' exists in CUES');
    assert.equal(name.replace(/`/g, ''), c.name, key + ' name');
    assert.ok(trigger.length > 5 && synth.length > 5);
    assert.equal(Number(dur), c.durationMs, key + ' duration');
    assert.equal(Number(level), c.level, key + ' level');
    assert.equal(Number(prio), AbitoSound.PRIORITY[key], key + ' priority');
  }
  assert.deepEqual([...seen].sort(), [...AbitoSound.CUE_IDS].sort());
});

test('README documents every reason, every cue and the unverified items', () => {
  const md = fs.readFileSync(path.join(PKG, 'README.md'), 'utf8');
  for (const r of AbitoSound.REASONS) assert.ok(md.includes('`' + r + '`'), 'reason ' + r);
  for (const id of AbitoSound.CUE_IDS) assert.ok(md.includes(id), id);
  assert.match(md, /sin trigger todavia/);
  assert.match(md, /sha256/);
  assert.match(md, /WebKitGTK/);
});

test('package.json: private, main, explicit test paths', () => {
  const p = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
  assert.equal(p.private, true);
  assert.equal(p.name, 'abito-desktop-sound');
  assert.equal(p.main, 'sound-engine.js');
  assert.match(p.scripts.test, /test\/engine\.test\.cjs/);
  assert.equal(p.dependencies, undefined);
});

test('sound-engine.js is dependency-free UMD (no require/import, classic-script safe)', () => {
  const src = fs.readFileSync(path.join(PKG, 'sound-engine.js'), 'utf8');
  assert.match(src, /^'use strict';/m);
  assert.ok(!/\brequire\s*\(/.test(src));
  assert.ok(!/^\s*(import|export)\s/m.test(src));
  assert.ok(!/\bdocument\b|\bwindow\b|\bfetch\b|XMLHttpRequest/.test(src), 'no DOM/network');
  // loads as a classic script into a bare global
  const vm = require('node:vm');
  const sandbox = {};
  sandbox.self = sandbox;
  vm.runInNewContext(src, sandbox);
  assert.equal(typeof sandbox.AbitoSound.createSoundEngine, 'function');
  assert.ok(Object.isFrozen(sandbox.AbitoSound));
});

test('no audio files anywhere in the package', () => {
  const bad = /\.(wav|ogg|mp3|flac|m4a|aiff?|opus)$/i;
  const found = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (bad.test(e.name)) found.push(p);
    }
  })(PKG);
  assert.deepEqual(found, []);
});
