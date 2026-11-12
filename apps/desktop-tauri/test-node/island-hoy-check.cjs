'use strict';
/* K2-13 T6b-1 «Hoy»: structure, wiring and tokens of the island's day view (no browser).
   Design: design/k2-13-minikodas/02-hoy-todo-en-la-isla.html (the human's choice, L38), mapped onto the real island:
   the notch grows to 300 (the height the chat already reaches), the Hoy panel takes its left column and Koda keeps the
   92px one. Run: node test-node/island-hoy-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const F = path.join(__dirname, '..', 'frontend');
const read = f => fs.readFileSync(path.join(F, f), 'utf8');
let passed = 0;
const test = (_n, fn) => { fn(); passed += 1; };

const html = read('index.html');
const css = read('island-nusa.css');
const bodies = read('island-nusa-bodies.js');
const mount = read('island-nusa-mount.js');
const header = read('island-header.js');
const hoy = (() => { const a = html.indexOf('<section id="hoy"'); const b = html.indexOf('</section>', a); return a < 0 ? '' : html.slice(a, b + '</section>'.length); })();
const hoyCss = (() => { const a = css.indexOf('K2-13 T6b-1'); return a < 0 ? '' : css.slice(a); })();
const hoyMount = (() => { const a = bodies.indexOf('K2-13 T6b-1'); return a < 0 ? '' : bodies.slice(a); })();

test('the Hoy view is a real section of the island, next to the notch (not inside it)', () => {
  assert.ok(hoy, '<section id="hoy"> exists');
  assert.ok(html.indexOf('<section id="hoy"') > html.indexOf('<div id="island">'));
  assert.ok(html.indexOf('<section id="hoy"') > html.indexOf('<section id="nusa"'), 'after the notch');
  assert.ok(html.indexOf('<section id="hoy"') > html.indexOf('</section>', html.indexOf('<section id="nusa"')), 'never nested in #nusa (its tablist is the pager dots)');
  for (const id of ['hoy-head', 'hoy-summary', 'hoy-problem', 'hoy-tabs', 'hoy-panel', 'hoy-list', 'hoy-empty', 'hoy-foot', 'hoy-live'])
    assert.ok(hoy.includes(`id="${id}"`), id);
});

test('the entry lives in the notch\'s ONE visible control cluster and uses a shipped icon', () => {
  const btn = html.match(/<button id="open-hoy"[^>]*>([\s\S]*?)<\/button>/);
  assert.ok(btn, '#open-hoy exists');
  const tag = btn[0];
  // HU-057 hides .tabs (home / «+») inside the notch, so a view entry cannot live there: it is a fourth hdr-action disc,
  // the same box and ::after disc as Ajustes / Silenciar / Plegar, in .header-actions.
  assert.match(tag, /class="hdr-action"/, 'the same control as Ajustes / Silenciar / Plegar');
  const actions = (() => { const a = html.indexOf('class="header-actions"'); const b = html.indexOf('</div>', a); return html.slice(a, b); })();
  assert.ok(actions.includes('id="open-hoy"'), 'inside .header-actions, the cluster the notch really shows');
  const tabsDiv = (() => { const a = html.indexOf('class="tabs"'); const b = html.indexOf('</div>', a); return html.slice(a, b); })();
  assert.ok(!tabsDiv.includes('id="open-hoy"'), 'never inside .tabs (hidden in the notch)');
  assert.match(tag, /aria-pressed="false"/, 'a toggle, so its state is spoken');
  assert.match(tag, /aria-label="Hoy"/);
  const icon = tag.match(/data-cc-icon="(\w+)"/);
  assert.ok(icon, 'drawn from the header icon set');
  const names = header.match(/ICON_NAMES = Object\.freeze\(\[([^\]]*)\]\)/);
  assert.ok(names, 'ICON_NAMES stays a closed allowlist');
  assert.ok(names[1].includes(`'${icon[1]}'`), `${icon[1]} must be in ICON_NAMES`);
  assert.ok(new RegExp(`${icon[1]}: \\d+`).test(header), 'and it has a size');
});

test('the three tabs are a tablist with one selection and a roving tabindex', () => {
  const tabs = hoy.match(/role="tab"/g) || [];
  assert.equal(tabs.length, 3);
  for (const id of ['propuestas', 'resultados', 'errores']) assert.ok(hoy.includes(`data-tab="${id}"`), id);
  assert.equal((hoy.match(/aria-selected="true"/g) || []).length, 1, 'exactly one tab is selected');
  const tablist = (() => { const a = hoy.indexOf('id="hoy-tabs"'); const b = hoy.indexOf('</div>', a); return hoy.slice(a, b); })();
  assert.equal((tablist.match(/tabindex="0"/g) || []).length, 1, 'roving focus: one tab is reachable with Tab');
  assert.equal((tablist.match(/tabindex="-1"/g) || []).length, 2, 'the other two are reached with the arrow keys');
  assert.match(hoy, /id="hoy-tabs"[^>]*role="tablist"/);
  assert.match(hoy, /id="hoy-panel"[^>]*role="tabpanel"/);
  assert.match(hoy, /id="hoy-live"[^>]*aria-live="polite"/, 'a tab change and a decision are announced');
});

test('nothing that executes is reachable from the markup: rows and their buttons are built at runtime', () => {
  assert.ok(!/Aprobar|Rechazar/.test(hoy), 'no Aprobar / Rechazar in the HTML: they only exist for a real pending row');
  assert.ok(!/autofocus/.test(html), 'Aprobar is never the default focus');
});

test('the mount wires only the closed verbs, every action needs a trusted event, and nothing carries a PIN', () => {
  assert.ok(hoyMount, 'the Hoy mount lives in island-nusa-bodies.js');
  for (const v of ['hoy_list', 'hoy_approve', 'hoy_reject']) assert.ok(hoyMount.includes(`'${v}'`), v);
  // L17: the human removed the PIN, so the Hoy code must carry no PIN FIELD (the comment that records the decision stays)
  const hoyCode = (hoyMount.split('K2-13 T6b-1')[1].split('paint();')[0] || '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/pin/i.test(hoyCode), 'no PIN field anywhere in the Hoy code (L17)');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment/.test(hoyMount), 'item text is never markup');
  assert.ok(!/\.\.\.|Object\.assign\(\{\}, *item/.test(hoyMount), 'the page never re-sends what the daemon folded');
  const gates = (hoyMount.match(/isTrusted !== true/g) || []).length;
  const handlers = (hoyMount.match(/addEventListener\('click'/g) || []).length;
  assert.ok(gates >= handlers, `every click handler checks isTrusted (${gates} gates / ${handlers} handlers)`);
});

test('a decision is read back from the daemon, never assumed from the click', () => {
  // the command's reply is the state at WRITE time (agentconn.rs returns self.view() right after sending), so the
  // outcome only exists in a later `agent:state` — the same contract settings.js documents. The mount holds the
  // decision until the model says ok/refused; the deadline says it does not know, it never guesses (B1/B2).
  assert.match(hoyMount, /N\.hoyDecision\(/, 'the judgement is the pure model\'s');
  assert.match(hoyMount, /N\.HOY_WAIT_MS/, 'with a deadline');
  assert.match(hoyMount, /pending\b/, 'and one decision in flight at a time');
  assert.match(hoyMount, /agent:state[\s\S]{0,200}(observeHoy|hoyDecision|applyHoy)/, 'the daemon\'s own state is the answer');
  assert.match(hoyMount, /hoyBusy/, 'a decision in flight holds the panel');
  assert.match(hoyMount, /yes\.disabled = no\.disabled = !!hoyBusy/, 'EVERY Aprobar / Rechazar is disabled while one is in flight');
  assert.match(hoyMount, /N\.hoyOrder\(/, 'a decided row keeps its place while the panel is open (no re-sort under the cursor)');
  assert.match(hoyMount, /N\.hoyGuardOpen\(/, 'and clicks are ignored for a moment after a repaint moved rows');
  assert.match(hoyMount, /N\.hoyReadProblem\(/, 'a refused or unavailable read is said (F5)');
  assert.ok(!/now\.status === want/.test(hoyMount), 'nothing is judged from the write-time view any more');
  assert.match(hoyMount, /hoyRefusal/, 'a refusal is shown from the closed code');
  assert.match(hoyMount, /N\.hoyErrorN\(/, 'the refusal travels as the daemon\'s counter + code, never as text');
  assert.match(read('island-nusa.js'), /last_error/, 'the code comes from the state the client already publishes');
});

test('the island reports its own 300 box, or the lower half of Hoy would take no clicks', () => {
  assert.match(hoyMount, /island_shape/, 'the page reports the grown box to the host');
  assert.match(hoyMount, /HOY_GROWN = 300/, 'true at 300 (the chat\'s own maximum)');
  assert.match(hoyMount, /NOTCH_FLAT = 150/, 'false back to the 150 notch');
  assert.match(hoyMount, /open && !flatDay\(\) \? HOY_GROWN : NOTCH_FLAT/, 'the report follows the open attribute and an empty day gives the room back');
  assert.match(hoyMount, /settled/, 'destination and settled box, like island.js');
});

test('css: the notch and the island grow to 300 and come back, and the body gives way', () => {
  assert.ok(hoyCss, 'the Hoy block is in island-nusa.css (no new stylesheet to package)');
  assert.match(hoyCss, /\[data-hoy="open"\][^{]*#island \{[^}]*height: 300px !important/, '#island is sized inline by island.js: the Hoy box wins only with !important');
  assert.match(hoyCss, /\[data-hoy="open"\][^{]*#nusa \{[^}]*height: 300px/);
  assert.match(hoyCss, /\[data-hoy="open"\] #nusa-panel \{[^}]*visibility: hidden/, 'the Inicio body yields but keeps its grid cell (Koda never moves)');
  assert.match(hoyCss, /#hoy \{ display: none; \}/, 'closed by default');
  assert.match(hoyCss, /#island-header #open-hoy \{[^}]*width: 36px/, 'the entry is a 36x44 zone like the other header discs');
  assert.match(hoyCss, /#open-hoy::after \{[^}]*border-radius: 50%/, 'with the same 24px disc');
  const gate = hoyCss.match(/#capsule\[data-phase="expanded"\]\[data-view="overview"\]\[data-hoy="open"\][^{]*\{/);
  assert.ok(gate, 'Hoy shows only in the idle expanded overview');
  for (const not of ['[data-card]', '[data-question="pending"]']) assert.ok(gate[0].includes(`:not(${not})`), `Hoy hides under ${not}`);
});

test('css: tokens only for colour, and the artboard\'s sizes', () => {
  const colours = [...hoyCss.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)].map(m => m[0]);
  const allowed = new Set(['#000', '#fff', '#e6e6e6', 'rgba(255,255,255,.06)', 'rgba(255,255,255,.12)', 'rgba(255,255,255,.2)', 'rgba(255,255,255,.62)', 'rgba(255,255,255,.78)', 'rgba(255,255,255,.4)', 'rgba(255,255,255,.08)']);
  for (const c of colours) assert.ok(allowed.has(c), `${c} is not a token of design/system.md nor of the shipped notch`);
  for (const t of ['--go', '--sun', '--island-live', '--red-11']) assert.ok(hoyCss.includes(t), t);
  assert.match(hoyCss, /\.hoy-btn \{[^}]*height: 24px/, 'Aprobar / Rechazar are 24 high (the artboard)');
  assert.match(hoyCss, /\.hoy-btn::after \{[^}]*inset: -2px/, 'and keep a >= 24 hit area');
  assert.match(hoyCss, /\.hoy-row \{[^}]*min-height: 32px/, 'a proposal row is two lines (32)');
  assert.match(hoyCss, /\.hoy-row\[data-kind="result"\] \{[^}]*min-height: 44px/, 'a result with its summary is 44');
  assert.match(hoyCss, /border-radius: 10px/, 'row radius 10 (the notch\'s own rows)');
  assert.match(hoyCss, /html\[data-motion="reduce"\]/, 'reduced motion is respected');
  assert.match(hoyCss, /font-size: 11px|font-size: 12px|font-size: 13px/, 'the notch type scale');
});

test('the notch title says «Hoy» while it is open, and the pager stays out of the way', () => {
  assert.match(mount, /dataset\.hoy === 'open'/, 'the mount knows the Hoy state');
  assert.match(mount, /paintTitle[\s\S]{0,400}Hoy/, 'and the header title follows it');
  assert.match(mount, /const active = \(\) =>[\s\S]{0,400}dataset\.hoy !== 'open'/, 'arrow keys never navigate hidden tabs behind Hoy');
});

test('packaging needs no new frontend file: the Hoy code lives in files that already ship', () => {
  const lib = fs.readFileSync(path.join(__dirname, '..', 'packaging', 'lib.cjs'), 'utf8');
  for (const f of ['island-nusa.js', 'island-nusa-bodies.js', 'island-nusa-mount.js', 'island-nusa.css']) assert.ok(lib.includes(`'${f}'`), f);
});

console.log(`island-hoy-check: ${passed} passed`);
