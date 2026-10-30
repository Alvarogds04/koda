'use strict';
/* T7.3 island controls (design §1/§2, design/export/png island frames):
   every island control is 32px VISUAL inside a 44px HIT area (the T6.1 hit-ring
   pattern: the visible pill is drawn on the ::after inset layer), the rail tab
   is 36px visual, the chat composer input row is 36px. CSS contract only (no
   browser): the declarations of each selector across style.css, in cascade
   order. Scoped to the island's own selectors — Ajustes (.sbtn/.sfield/.stab)
   is T7.2's surface and is NOT touched here. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(__dirname, '..', 'frontend');
const css = (fs.readFileSync(path.join(dir, 'style.css'), 'utf8') + '\n' + fs.readFileSync(path.join(dir, 'vendor/coucou/island/island.css'), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
function decls(sel) {
  const out = {};
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const group = m[1].replace(/\s+/g, ' ').trim();
    if (group !== sel && !group.split(',').map(s => s.trim()).includes(sel)) continue;
    for (const d of m[2].split(';')) { const i = d.indexOf(':'); if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).replace('!important', '').trim(); }
  }
  return out;
}
let failed = 0;
const test = (n, f) => { try { f(); console.log('PASS ' + n); } catch (e) { failed++; console.error('FAIL ' + n + ': ' + e.message); } };

test('header tabs keep the 44px hit area and draw Coucou\'s 30x22 r11 visual on ::after (S10: header on top, no rail)', () => {
  assert.equal(decls('#island-header .tab, #island-header .hdr-action')['height'], '44px');
  const a = decls('#island-header .tab::after');
  assert.equal(a.inset, '11px 7px', '44x44 hit - 2x7 / 2x11 inset = 30x22 visual');
  assert.equal(a['border-radius'], '11px');
  assert.equal(decls('#island-header .tab[aria-pressed="true"]').background, 'transparent', 'the visible tab fill moves to ::after');
  assert.equal(decls('#island-header .tab[aria-pressed="true"]::after').background, 'var(--tab-on)');
});

test('question options: a vertical full-width list, 36px visual row inside the 44px hit area (no pill chips)', () => {
  assert.equal(decls('.q-option')['min-height'], '44px');
  assert.equal(decls('.q-option').width, '100%');
  const a = decls('.q-option::after');
  assert.equal(a.inset, '4px 0', '44 hit - 2x4 inset = 36 visual; rows no longer overlap');
  assert.equal(a['border-radius'], '10px', 'a multi-line row is a rounded rectangle, not a pill');
  assert.equal(a['background'], 'var(--btn-bg)');
  assert.equal(decls('.q-option').background, 'transparent', 'the visible fill moves to ::after');
});

test('approval buttons: Coucou .btn pill, 30px visual inside the 44px hit area, «Permitir» primary', () => {
  for (const sel of ['#allow', '#deny']) {
    assert.equal(decls(sel)['min-height'], '44px');
    assert.equal(decls(sel + '::after').inset, '7px 0');
    assert.equal(decls(sel).background, 'transparent');
  }
  assert.equal(decls('#allow::after').background, 'var(--primary-bg)', 'Permitir is the primary');
  assert.equal(decls('#deny::after').background, 'var(--btn-bg)');
});

test('«Omitir» stays a ghost 32px visual in a 44px hit area (design §2)', () => {
  assert.equal(decls('#question-skip')['min-height'], '44px');
  assert.equal(decls('#question-skip::after').inset, '6px');
  assert.equal(decls('#question-skip').background, 'transparent');
  assert.equal(decls('#question-skip::after').background, 'var(--btn-bg)', 'visible ghost pill instead of an invisible exit');
});

test('island icon buttons draw a 32px visual on ::after and keep the 44px hit area', () => {
  assert.equal(decls('.icon-btn')['min-width'], '44px', 'base hit area unchanged');
  assert.equal(decls('.icon-btn').background, 'transparent');
  const a = decls('#capsule .icon-btn::after');
  assert.equal(a.inset, '6px', 'island-scoped 32px visual ring');
  assert.equal(a['border-radius'], '10px');
});

test('chat composer: 36px input row, 28px (Coucou .send-btn) round buttons in 44px hit areas', () => {
  assert.equal(decls('#chat-input')['min-height'], '36px');
  const round = decls('#chat-composer .round');
  assert.equal(round.width, '44px', 'hit area stays 44');
  assert.equal(round.height, '44px');
  assert.equal(decls('#chat-composer .round::after').inset, '8px', 'L32 #480: 44 hit - 2x8 inset = 28 visual, Coucou\'s send disc');
  const auto = fs.readFileSync(path.join(dir, 'chat.js'), 'utf8');
  assert.match(auto, /const MIN_INPUT = 36/, 'autosize grows from the 36px design row');
});

test('the free-text question field matches the 36px composer row (design §2)', () => {
  assert.equal(decls('#question-text')['min-height'], '36px');
});
test('island icon buttons never override the absolute placement of #card-info/#notice-info', () => {
  assert.equal(decls('#capsule .icon-btn').position, undefined, 'a (1,1,0) position rule would beat the (1,0,0) absolute rules');
  assert.equal(decls('.icon-btn').position, 'relative', 'the ::after ring anchors on the base class (0,1,0), which ids still override');
  assert.equal(decls('#card-info').position, 'absolute', 'the info button keeps its corner placement');
  assert.equal(decls('#permission #card-fold, #question #question-fold, #permission #card-info').position, 'absolute', 'S10: the fold chevron is anchored to the card corner, like Coucou');
});
test('chat top bar: visible title «Koda» before the gear/back buttons (design isla-chat-*)', () => {
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const header = html.slice(html.indexOf('<header id="chat-header">'), html.indexOf('</header>', html.indexOf('<header id="chat-header">')));
  assert.match(header, /<h2 id="chat-title">Koda<\/h2>[\s\S]*id="open-screen-settings"[\s\S]*id="chat-back"/); // Koda 0.1 T2
  const t = decls('#chat-title');
  assert.equal(t['font-size'], 'var(--fs-body)');
  assert.equal(t['font-weight'], '600');
});
test('chat body top row: «+» and history left-aligned, then the label «Conversación nueva» (existing verbs only)', () => {
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const row = html.slice(html.indexOf('id="chat-history-controls"'), html.indexOf('<ol id="chat-log"'));
  assert.match(row, /id="chat-create"[^>]*>[\s\S]*data-icon="plus"[\s\S]*id="chat-conversations"[\s\S]*id="chat-history-label"[^>]*>Conversación nueva</);
  assert.equal(decls('#chat-history-controls')['justify-content'], 'flex-start');
  assert.equal(decls('#chat-history-controls')['align-items'], 'center');
  assert.equal(decls('#chat-history-label')['font-size'], 'var(--fs-caption)');
  assert.match(fs.readFileSync(path.join(dir, 'chat.js'), 'utf8'), /chat-history-label[\s\S]{0,200}turns\.length/, 'the label shows only while the conversation has no turns');
  assert.ok(require(path.join(dir, 'icons.js')).NAMES.includes('plus'));
});
test('chat model chip keeps its 24px chip and wears Coucou\'s model-btn tokens (500 10.5px, rgba .06 fill, r999) (S10 L22)', () => {
  const c = decls('#chat-model-btn');
  assert.equal(c['min-height'], '24px');
  assert.equal(c.font, '500 10.5px var(--font)');
  assert.equal(c.background, 'rgba(255, 255, 255, 0.06)');
  assert.equal(c['border-radius'], 'var(--radius-full)');
});
console.log(`island-controls-check: ${failed ? failed + ' FAILED' : 'all passed'}`);
if (failed) process.exitCode = 1;
// The question card is a CSS grid (#question). Two children must never share a cell: «Omitir» was painted ON TOP of option 2.
function cell(sel) {
  const d = decls(sel);
  const col = (d['grid-column'] || '1').split('/').map(x => x.trim());
  const row = (d['grid-row'] || '1').split('/').map(x => x.trim());
  const n = x => (x === '-1' ? 99 : Number(x));
  const span = ([a, b]) => ({ from: n(a), to: b === undefined ? n(a) : n(b) - 1 });
  return { col: span(col), row: span(row), d };
}
const overlaps = (a, b) => a.col.from <= b.col.to && b.col.from <= a.col.to && a.row.from <= b.row.to && b.row.from <= a.row.to;
test('B the question card grid: head, options, nav, summary, freeform and «Omitir» each own distinct cells (no overlap)', () => {
  const names = ['#question-asker', '#question-body', '#question-options', '#question-skip', '#question-freeform', '#question-nav', '#question-summary', '#question-step'];
  const cells = Object.fromEntries(names.map(n => [n, cell(n)]));
  for (const a of names) for (const b of names) {
    if (a >= b) continue;
    // the asker line and the step header intentionally share row 1 (the step header replaces nothing: it is hidden outside a form)
    // the summary and the options list are mutually exclusive (a questionnaire's review step has no options)
    if ((a === '#question-options' && b === '#question-summary') || (a === '#question-summary' && b === '#question-options')) continue;
    assert.ok(!overlaps(cells[a], cells[b]), `${a} (${JSON.stringify(cells[a].col)}/${JSON.stringify(cells[a].row)}) overlaps ${b} (${JSON.stringify(cells[b].col)}/${JSON.stringify(cells[b].row)})`);
  }
});
test('B «Omitir» lives in the header line, to the right of the asker, never over the options list', () => {
  const skip = cell('#question-skip'), options = cell('#question-options'), asker = cell('#question-asker');
  assert.equal(skip.row.from, asker.row.from, 'same row as the asker line');
  assert.ok(skip.row.to < options.row.from, 'strictly above the options');
  assert.equal(skip.d['justify-self'], 'end', 'pushed to the right edge of the card');
  assert.notEqual(skip.d.position, 'absolute', 'out of the absolute flow');
});
test('B the card keeps room below the last option (Coucou ~35px of air, never 6px)', () => {
  const q = decls('#question');
  assert.match(String(q['padding-bottom'] || q.padding || ''), /\b(1[2-9]|[2-9]\d)px/, 'bottom padding of at least 12px');
});
// ---- F: the chat field's focus ring is thin and consistent (human audit: «anillo lima grueso desalineado con el tema») ---------------
test('F the chat input\'s focus ring is 1px in a muted accent, not the global 2px lime; it stays visible (>= 1px, not transparent, not none)', () => {
  const ring = decls('#chat-input:focus-visible');
  assert.ok(Object.keys(ring).length > 0, 'the chat field has its own focus rule');
  assert.equal(ring.outline, '1px solid var(--island-live)', 'design 14 A: a 1px accent edge');
  assert.equal(ring['outline-offset'], '0', 'drawn on the field\'s own edge, not floating 2px away');
  const base = decls(':focus-visible');
  assert.equal(base.outline, '2px solid var(--go)', 'the global ring is untouched for every other control');
});
test('F --focus-ring is a muted accent token defined once, never lime and never fully transparent', () => {
  const root = decls(':root');
  assert.ok(root['--focus-ring'], '--focus-ring defined in :root');
  assert.doesNotMatch(root['--focus-ring'], /var\(--go\)|#b8ff2e|transparent/i);
  assert.match(root['--focus-ring'], /rgba\(255, 255, 255, 0?\.[3-9]\d*\)|var\(--dim-[123]\)/, 'a muted white or a dim token');
});
test('F the same thin ring applies to the other text fields of the island (question free text, model search), not to buttons', () => {
  assert.equal(decls('#question-text:focus-visible').outline, '1px solid var(--focus-ring)');
  assert.equal(decls('#chat-input:focus-visible').outline, '1px solid var(--island-live)');
});
