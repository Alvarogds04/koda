'use strict';
// HU-063 T1: the additive «sidebar Koda» layer of the Ajustes window (settings-nusa*.{css,js}).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

// Koda 0.1 T2: the visible rename legitimately edits vendor/ and settings-view.js. "Untouched" now means: the only change is Abito -> Koda in text
// (every removed line equals its added line once «Abito» becomes «Koda»); anything else still fails.
function onlyRenamed(files) {
  const out = [];
  for (const p of files) {
    const d = execFileSync('git', ['diff', '-U0', 'HEAD', '--', require('node:path').join(root, '..', '..', p)], { cwd: root, encoding: 'utf8' }).split('\n');
    const minus = d.filter(l => l.startsWith('-') && !l.startsWith('---')).map(l => l.slice(1).replace(/Abito|Koda/g, 'N'));
    const plus = d.filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1).replace(/Abito|Koda/g, 'N'));
    if (JSON.stringify(minus) !== JSON.stringify(plus)) out.push(p);
  }
  return out;
}
const read = f => fs.readFileSync(path.join(root, 'frontend', f), 'utf8');
const N = require('../frontend/settings-nusa.js');
const { CATALOG } = require('../frontend/koda-catalog.js');

// phrase + mood per page; unknown page falls back to General
for (const id of ['general', 'agents', 'chat', 'shortcuts', 'privacy', 'island']) {
  const v = N.pageVoice(id);
  assert.ok(typeof v.phrase === 'string' && v.phrase.length > 0 && v.phrase.length <= 48, `${id} phrase`);
  assert.ok(CATALOG[v.mood], `${id} mood ${v.mood} must be a real Koda animation`);
}
assert.equal(N.pageVoice('general').phrase, 'Todo a tu medida');
assert.equal(new Set(['general', 'agents', 'chat', 'shortcuts', 'privacy'].map(i => N.pageVoice(i).phrase)).size, 5);
for (const bad of ['', 'nope', null, undefined, 42, '__proto__', 'constructor', {}]) {
  assert.deepEqual(N.pageVoice(bad), N.pageVoice('general'), `fallback for ${String(bad)}`);
}
assert.ok(Object.isFrozen(N.pageVoice('chat')));

// agent colour for the veil
assert.equal(N.agentVeil('pi'), '#2dffac');
assert.equal(N.agentVeil('Pi'), '#2dffac');
assert.equal(N.agentVeil('claude-code'), '#b04dff');
assert.equal(N.agentVeil('Claude Code'), '#b04dff');
assert.equal(N.agentVeil('codex'), '#f472b6');
for (const x of ['', 'gemini', null, undefined, '__proto__', 7]) assert.equal(N.agentVeil(x), '#4d9fff');
assert.equal(N.agentVeil('pi', '#F29B38'), '#f29b38', 'a valid human hex wins');
assert.equal(N.agentVeil('pi', 'red;}'), '#2dffac', 'an invalid hex is ignored');

// sprite: 32 px sheet at integer scale 3 = 96 px
assert.deepEqual(N.spriteLayout(), { cell: 32, k: 3, px: 96 });

// source checks
const html = read('settings.html');
const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(m => m[1]);
const nusa = links.indexOf('settings-nusa.css');
assert.ok(nusa > links.indexOf('vendor/coucou/hub/abito.css') && links.indexOf('vendor/coucou/hub/abito.css') > links.indexOf('vendor/coucou/hub/hub.css'), `settings-nusa.css after vendor sheets: ${links}`);
assert.equal((html.match(/<script\b[^>]*>/g) || []).filter(s => !/\bsrc=/.test(s)).length, 0, 'no inline script');
assert.ok(!/<style\b/i.test(html) && !/\sstyle=/i.test(html) && !/\son[a-z]+=/i.test(html), 'no inline style/handler');
const entry = read('settings-app.js');
const order = ['./koda-catalog.js', './koda-logic.js', './settings-nusa.js', './settings-nusa-mount.js'].map(f => entry.indexOf(`import '${f}';`));
assert.ok(order.every(i => i > 0) && order.every((v, i) => !i || v > order[i - 1]), 'settings-app.js imports the Koda + nusa modules in order');
for (const f of ['settings-nusa.css', 'settings-nusa.js', 'settings-nusa-mount.js']) {
  const src = read(f);
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(src), `${f}: no HTML injection`);
}
const css = read('settings-nusa.css');
assert.ok(/196px/.test(css) && /html\[data-theme=["']?light/.test(css) && /body\.hub-window/.test(css));
assert.ok(!/url\(\s*['"]?https?:/.test(css) && !/@import/.test(css));

// R1: nothing under vendor/ was touched, and the new files ship
const changed = execFileSync('git', ['diff', '--name-only', 'HEAD', '--', '.'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
assert.deepEqual(onlyRenamed(changed.filter(p => /\/vendor\//.test(p))), [], 'vendor/ must stay untouched except Abito -> Koda (Koda 0.1 T2)');
const lib = fs.readFileSync(path.join(root, 'packaging/lib.cjs'), 'utf8');
for (const f of ['settings-nusa.css', 'settings-nusa.js', 'settings-nusa-mount.js']) assert.ok(lib.includes(`'${f}'`), `packaging lists ${f}`);
console.log('settings-nusa-check ok');
