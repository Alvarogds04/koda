'use strict';
/* HU-057 T1+T2: static structure of the Nusa notch in index.html + its css/mount (no browser).
   Run: node test-node/island-nusa-dom-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const F = path.join(__dirname, '..', 'frontend');
const read = f => fs.readFileSync(path.join(F, f), 'utf8');
const html = read('index.html');
let passed = 0;
const test = (_n, fn) => { fn(); passed += 1; };
const nusa = (() => { const a = html.indexOf('<section id="nusa"'); const b = html.indexOf('</section>', a); return a < 0 ? '' : html.slice(a, b); })();

test('scripts and css load in order', () => {
  const i = s => html.indexOf(s);
  assert.ok(i('island-nusa.js') > 0 && i('island-nusa-mount.js') > i('island-nusa.js'), 'model before mount');
  assert.ok(i('island-nusa-mount.js') > i('island-layout.js'), 'mount after island-layout.js');
  assert.ok(/<script defer src="island-nusa-mount\.js">/.test(html));
  assert.ok(i('island-nusa.css') > i('koda-skin.css'), 'css after koda-skin.css');
});
test('#nusa lives inside #island with the required ids', () => {
  assert.ok(nusa, '<section id="nusa"> exists');
  assert.ok(html.indexOf('<section id="nusa"') > html.indexOf('<div id="island">'));
  for (const id of ['nusa-veil', 'nusa-title', 'nusa-ring', 'nusa-date', 'nusa-time', 'nusa-bars', 'nusa-prev', 'nusa-next', 'nusa-body', 'nusa-panel', 'nusa-right', 'nusa-dots'])
    assert.ok(nusa.includes(`id="${id}"`), id);
});
test('three tabs, tablist semantics, no Chat tab', () => {
  assert.ok(/id="nusa-dots"[^>]*role="tablist"/.test(nusa));
  const tabs = nusa.match(/role="tab"/g) || [];
  assert.equal(tabs.length, 3);
  for (const t of ['inicio', 'agentes', 'avisos']) assert.ok(nusa.includes(`data-tab="${t}"`), t);
  assert.ok(!/chat/i.test(nusa));
  assert.equal((nusa.match(/aria-selected="true"/g) || []).length, 1);
});
test('no minibot or blob inside #nusa', () => {
  assert.ok(!/minibot|blobs|overview-view/.test(nusa));
});
test('css: black notch, bottom corners 26, ears, veil tokens, legacy hidden in the idle overview only', () => {
  const css = read('island-nusa.css');
  assert.ok(/border-radius:\s*0 0 26px 26px/.test(css));
  assert.ok(/#000/.test(css));
  for (const t of ['--island-live', '--sun', '--go', '--red-11']) assert.ok(css.includes(t), t);
  assert.ok(/#nusa-ear/.test(css));
  const sel = ':not([data-card]):not([data-question="pending"]):not([data-question="expired"]):not([data-question="outcome"])';
  assert.ok(css.includes(`#capsule[data-phase="expanded"][data-view="overview"]${sel}`));
  for (const hidden of ['#overview-view', '#blobs', '#minibots', '#island-header']) assert.ok(css.includes(hidden), hidden);
});
test('mount: uses the model, 30 s clock, wheel and keys, not while typing', () => {
  const js = read('island-nusa-mount.js');
  for (const s of ['AbitoNusa', 'clockText', '30000', 'wheelStep', 'keyStep', 'arrows', 'veilState', 'typing']) assert.ok(js.includes(s), s);
});
test('island.js: notch geometry 720x150 r26, bottom-only radius', () => {
  const js = read('island.js');
  assert.ok(/const OVERVIEW = \{ w: 720, h: 150, r: 26, gap: 0, clay: 64, clayX: 598, cy: 74 \}/.test(js));
  assert.ok(/rTop = lerp\(COMPACT\.r, 0, p\)/.test(js), 'top radius goes to 0');
});

const bodies = (() => { try { return read('island-nusa-bodies.js'); } catch { return ''; } })();
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
test('T3/T4: bodies script loads between the model and the mount', () => {
  const i = s => html.indexOf(s);
  assert.ok(i('island-nusa-bodies.js') > i('island-nusa.js') && i('island-nusa-bodies.js') < i('island-nusa-mount.js'));
  assert.ok(/<script defer src="island-nusa-bodies\.js">/.test(html));
});
test('T3/T4: bodies build DOM with textContent only (no markup sink) and never invent a host verb', () => {
  assert.ok(bodies, 'island-nusa-bodies.js exists');
  assert.doesNotMatch(strip(bodies) + strip(read('island-nusa-mount.js')), /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.match(bodies, /textContent/);
  const verbs = [...strip(bodies).matchAll(/call\(\s*'([a-z_]+)'/g)].map(m => m[1]).sort();
  assert.deepEqual([...new Set(verbs)], ['chat_action', 'dictation_action']);
});
test('T3: Inicio — the one field, mic only with dictation on, trusted-only send, id reuse, 8000, chat opens from the reply line', () => {
  for (const s of ['Pedile algo a Koda… (o dictalo)', "'submit'", 'client_request_id', 'getRandomValues', 'requestId', 'sendCheck', "'status'", "'hands_free'", 'prefs.enabled === true', // Koda 0.1 T2
    'isTrusted', "'view'", 'replyLine', 'open-chat', 'focusView', 'maxLength', 'DRAFT_MAX']) assert.ok(bodies.includes(s), s);
  assert.equal((bodies.match(/placeholder/g) || []).length >= 1, true);
});
test('T4: Agentes rows (bar, name, chip, ticker) with no avatar, and Avisos one line + mark all through desktop.dismiss', () => {
  for (const s of ['agentRows', 'abito:sessions-view', 'noticeLines', 'Marcar todo como leído', 'desktop.click', 'onState']) assert.ok(bodies.includes(s), s);
  assert.ok(/window\.desktop/.test(bodies) && /\.dismiss\(id\)/.test(bodies) && bodies.includes('N.dismissAll'), 'mark-all goes through window.desktop.dismiss via dismissAll');
  assert.doesNotMatch(strip(bodies), /AbitoClay|minibot|blob/i);
  assert.ok(!/pausa|pause/i.test(strip(bodies)), 'no pause button: the host has no per-session pause verb');
});
test('S13: the mount paints the veil colour from the model onto #nusa, following abito:sessions-view', () => {
  const js = read('island-nusa-mount.js');
  for (const s of ['veilColor', 'focusView', 'abito:sessions-view', "setProperty('--veil'"]) assert.ok(js.includes(s), s);
});
test('T3/T4 css: type scale 13/12/11, field and rows exist', () => {
  const css = read('island-nusa.css');
  for (const s of ['.nusa-field', '.nusa-agent', '.nusa-notice', '.nusa-reply', 'font-size: 13px', 'font-size: 12px', 'font-size: 11px']) assert.ok(css.includes(s), s);
});
test('Ver todas: the opener event is dispatched only from a trusted click; the ticker listens and re-checks canFocus; no innerHTML', () => {
  const b = read('island-nusa-bodies.js'), t = read('sessions-ticker.js'), css = read('island-nusa.css');
  assert.match(b, /class="?nusa-link nusa-all|'nusa-link nusa-all'/, 'the link');
  const at = b.indexOf("abito:sessions-all-open");
  assert.ok(at > 0, 'event dispatched');
  assert.equal(b.split("abito:sessions-all-open").length - 1, 1, 'dispatched in exactly one place');
  assert.match(b.slice(Math.max(0, at - 520), at), /addEventListener\('click',[^]*isTrusted !== true\) return/, 'only inside a click handler gated on isTrusted');
  assert.match(t, /document\.addEventListener\('abito:sessions-all-open', \(\) => \{ if \(canFocus\(\)\) openOverlay\(\); \}\);/, 'ticker listener re-checks canFocus');
  assert.equal(t.split('abito:sessions-all-open').length - 1, 1);
  assert.doesNotMatch(b, /innerHTML|outerHTML|insertAdjacentHTML/);
  assert.match(b, /data-nusa-sessions|dataset\.nusaSessions/, 'state attribute set by our code');
  assert.match(css, /#capsule\[data-nusa-sessions="open"\][^{]*#overview-view[^{]*\{[^}]*visibility:\s*visible/, 'css carve-out');
});
console.log(`island-nusa-dom-check: ${passed} passed`);
