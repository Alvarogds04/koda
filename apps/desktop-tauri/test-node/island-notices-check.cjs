'use strict';
/* L37 (human): «los avisos en la isla ... estan muy mal a nivel visual, eso se puede cambiar igual que coucou».
   Every notice surface of the island wears Coucou's notification look (windows/src/style.css @434d6a2b: .pill, .pill-badge, .icon-btn,
   .btn.secondary, .gh-row, .int-status), Abito's texts, aria and behaviour unchanged. CSS/markup contracts only (no browser). */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const read = f => fs.readFileSync(path.join(frontend, f), 'utf8');
const island = read('vendor/coucou/island/island.css');
const css = island.replace(/\/\*[\s\S]*?\*\//g, '');
const decls = sel => {
  const out = {};
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!m[1].replace(/\s+/g, ' ').trim().split(',').map(s => s.trim()).includes(sel)) continue;
    for (const d of m[2].split(';')) { const i = d.indexOf(':'); if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim(); }
  }
  return out;
};
let failed = 0;
const test = (n, f) => { try { f(); console.log('PASS ' + n); } catch (e) { failed++; console.error('FAIL ' + n + ': ' + e.message); } };

// F7 (SN2: «terminó» no es éxito): the vendored Coucou sheet stays untouched; question-toast.css (loaded after it) overrides only
// the «finished/info» marks so they read as a neutral notice, never as a green success check.
const sileoCss = read('question-toast.css').replace(/\/\*[\s\S]*?\*\//g, '');
const sileoDecls = sel => {
  const out = {};
  for (const m of sileoCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!m[1].replace(/\s+/g, ' ').trim().split(',').map(s => s.trim()).includes(sel)) continue;
    for (const d of m[2].split(';')) { const i = d.indexOf(':'); if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim(); }
  }
  return out;
};
test('F7: an info/finished notice and the finished badge on Abito are neutral, never a green ✓ success mark', () => {
  const html = read('index.html');
  assert.ok(html.indexOf('vendor/coucou/island/island.css') < html.indexOf('question-toast.css'), 'the override sheet loads after the vendor one');
  assert.equal(sileoDecls('#notices #notice-ring::after').content, '"i"', 'info notice reads «i», not ✓');
  assert.equal(sileoDecls('#notices:not([data-tone="sun"]):not([data-tone="red"])')['--notice-tone'], 'var(--dim-2)', 'info tone is neutral grey, not success green');
  assert.equal(sileoDecls('#clay-badge[data-kind="finished"] i::before').content, '"i"');
  assert.equal(sileoDecls('#clay-badge[data-kind="finished"] i').background, 'var(--dim-2)');
  assert.equal(sileoDecls('#clay-badge[data-kind="finished"]')['box-shadow'], 'none');
  // warnings and errors keep their own marks (unchanged)
  assert.equal(decls('#notices[data-tone="sun"] #notice-ring::after').content, '"!"');
  assert.equal(decls('#notices[data-tone="red"] #notice-ring::after').content, '"✕"');
  assert.equal(sileoDecls('#notices[data-tone="sun"] #notice-ring::after').content, undefined, 'no override of the warning mark');
});

test('provenance: the notice block cites Coucou and the commit', () => {
  assert.match(island, /Notices \(L37 [\s\S]*@434d6a2b/);
});

test('the notice band is Coucou\'s .pill: 28px capsule, r999, card-flat, 1px border tinted 14% by the severity (info green / warning amber / error red)', () => {
  const p = decls('#notice-pill');
  assert.equal(p.height, '28px'); assert.equal(p['border-radius'], '999px'); assert.equal(p.background, 'var(--card-flat)');
  assert.equal(p.border, '1px solid color-mix(in srgb, var(--notice-tone) 14%, transparent)');
  assert.equal(decls('#notices')['--notice-tone'], '#22c55e', 'info = Coucou\'s finished green');
  assert.equal(decls('#notices[data-tone="sun"]')['--notice-tone'], '#f5a524', 'warning = approval amber');
  assert.equal(decls('#notices[data-tone="red"]')['--notice-tone'], '#f4505e', 'error = Coucou red');
  assert.equal(decls('#notice-pill:hover')['background'], 'color-mix(in srgb, var(--notice-tone) 18%, transparent)');
});

test('the severity is Coucou\'s pill-badge: 14px dark ring, 12px coloured disc, ✓ / ! / ✕; the title stays ink (the tone lives in the badge and the border)', () => {
  const r = decls('#notice-ring');
  assert.equal(r.width, '14px'); assert.equal(r.height, '14px'); assert.equal(r.background, '#0b0c0e'); assert.equal(r['border-radius'], '50%');
  assert.equal(decls('#notice-ring::before').background, 'var(--notice-tone)');
  assert.equal(decls('#notice-ring::before').width, '12px');
  assert.equal(decls('#notices #notice-ring::after').content, '"✓"');
  assert.equal(decls('#notices[data-tone="sun"] #notice-ring::after').content, '"!"');
  assert.equal(decls('#notices[data-tone="red"] #notice-ring::after').content, '"✕"');
  assert.equal(decls('#notices #notice-title').color, 'var(--ink)', 'no red/amber title: Coucou\'s who name is ink');
  assert.equal(decls('#notices[data-tone] #notice-title').color, 'var(--ink)', 'a tone never recolours the title either (it out-ranks the old tone rules)');
  assert.equal(decls('#notice-ring svg').display, 'none', 'the old ring drawing is not shown');
});

test('title + muted detail share the capsule\'s one line (Coucou .who: 600 12px ink, 400 11px dim-2); the countdown is Coucou\'s 2px bar under it', () => {
  assert.equal(decls('.notice-text')['flex-direction'], 'row');
  assert.equal(decls('#notices #notice-title').font, '600 12px var(--font)');
  assert.equal(decls('#notices #notice-sub').font, '400 11px var(--font)'); assert.equal(decls('#notices #notice-sub').color, 'var(--dim-2)');
  const bar = decls('#notice-pill::after');
  assert.equal(bar.height, '2px'); assert.equal(bar.background, 'rgba(255, 255, 255, 0.35)'); assert.equal(bar.transform, 'scaleX(var(--left, 1))');
  assert.match(read('island.js'), /\$\('notice-pill'\)\.style\.setProperty\('--left', String\(view\.fraction\)\)/, 'the 60 s window drives the bar');
});

test('«Abrir» / «Ver» is Coucou\'s .btn.secondary (500 11px, rgba .09 pill, hover .15) and × / «i» are its 16px round .icon-btn (rgba .07, dim-4, 8px glyph), all with 44px hit areas', () => {
  const a = decls('#notice-action');
  assert.equal(a['border-radius'], '999px'); assert.equal(a.background, 'rgba(255, 255, 255, 0.09)'); assert.equal(a.font, '500 11px var(--font)'); assert.equal(a.color, 'var(--ink-2)');
  assert.equal(decls('#notice-action:hover').background, 'rgba(255, 255, 255, 0.15)');
  assert.equal(decls('#notice-action::after').inset, '-10px -2px', '28px visual + 44 hit');
  for (const id of ['#notice-dismiss', '#notice-info']) {
    const b = decls(`#capsule ${id}`);
    assert.equal(b['min-width'], '44px'); assert.equal(b['min-height'], '44px', id + ' keeps the 44px hit');
    assert.equal(decls(`#capsule ${id}::after`).inset, '14px', id + ' 16px visual');
    assert.equal(decls(`#capsule ${id}::after`).background, 'rgba(255, 255, 255, 0.07)');
    assert.equal(decls(`#capsule ${id} .ico svg`).width, '8px');
  }
});

test('the connection status line is quiet: Coucou .int-status (400 11px dim-3), icon faint, no red unless the receiver really failed; the strip box disappears when only that line is left', () => {
  const chip = decls('#notice-row .chip');
  assert.equal(chip.font, '400 11px var(--font)'); assert.equal(chip.color, 'var(--dim-3)');
  assert.equal(decls('#notice-row .chip[data-tone="faint"] .ico').color, 'var(--dim-3)');
  assert.equal(decls('#notices[data-quiet="true"]').background, 'transparent');
  assert.equal(decls('#notices[data-quiet="true"]')['box-shadow'], 'none');
  const src = read('island.js');
  assert.match(src, /noticesEl\.dataset\.quiet = /);
});

test('the inbox keeps Coucou list chrome with theme-aware opaque title and time', () => {
  assert.equal(decls('#notice-list-title').font, '600 12px var(--font)');
  const c = decls('#notice-clear'); assert.equal(c.background, 'transparent'); assert.equal(c.font, '400 11px var(--font)'); assert.equal(c.color, 'var(--dim-2)');
  const row = decls('.notice-list-row'); assert.equal(row.background, 'transparent'); assert.equal(row.border, '0'); assert.equal(row['border-radius'], '4px');
  assert.equal(decls('.notice-list-row:hover').background, 'rgba(255, 255, 255, 0.05)');
  assert.equal(decls('.notice-list-dot').width, '5px');
  assert.equal(decls('.notice-list-title').color, 'var(--ink)'); assert.equal(decls('.notice-list-title').font, '400 11px var(--font)');
  assert.equal(decls('.notice-list-time').font, '400 10px var(--font)'); assert.equal(decls('.notice-list-time').color, 'var(--ink)');
});

test('the idle card (no session) is a column that fits the 322px card, so «Nada en ejecución ahora mismo.» is not squeezed into a 90px strip', () => {
  const e = decls('#overview-empty');
  assert.equal(e['flex-direction'], 'column'); assert.equal(e['align-items'], 'flex-start');
  assert.equal(decls('#overview-empty .title').font, '600 13px/1.25 var(--font)');
});

test('Avisos preserves DOM ids and closed verbs without adding a competing entry button', () => {
  const html = read('index.html');
  for (const id of ['notices', 'notice-row', 'connection', 'hotkey', 'bridge', 'notice-info', 'notice-pill', 'notice-open', 'notice-ring', 'notice-title', 'notice-dismiss', 'notice-detail', 'notice-live'])
    assert.match(html, new RegExp(`id="${id}"`), id);
  const notices = html.slice(html.indexOf('<div id="notices"'), html.indexOf('<p id="notice-live"'));
  assert.equal((notices.match(/<button/g) || []).length, 6, 'info, open, dismiss, the finished card\'s two buttons and the «Sin motor» action: no other invented one');
  const src = read('island.js');
  assert.match(src, /noticeAction\.hidden = view\.action == null;/);
  assert.match(src, /aria-label', view\.grouped \? `Ver los \$\{view\.count\} avisos`/);
});

test('«Sin motor» is a real button (keyboard + mouse), enabled only when the connection view carries an action, and it opens Ajustes through the existing seam', () => {
  const html = read('index.html');
  assert.match(html, /<button id="connection" class="chip" type="button"/);
  const src = read('island.js');
  assert.match(src, /connectionEl\.disabled = !conn\.action;/);
  assert.match(src, /connectionEl\.addEventListener\('click', event => \{ if \(event\.isTrusted === true && lastConn && lastConn\.action\) document\.dispatchEvent\(new CustomEvent\('abito:settings-select', \{ detail: lastConn\.action\.target \}\)\); \}\);/);
  assert.match(src, /connectionEl\.setAttribute\('aria-label', conn\.action \? conn\.actionAria : conn\.aria\);/);
  const css = read('style.css');
  assert.match(css, /#notice-row button\.chip:not\(:disabled\)\s*\{[^}]*cursor: pointer/);
  assert.match(css, /#notice-row button\.chip:focus-visible/);
});

test('the Pi status row (dot + label + link) is mounted twice (idle card, under the ticker), fed by abito:pi-state, trusted click deep-links, keyboard focusable', () => {
  const html = read('index.html');
  for (const id of ['overview-engine', 'overview-engine-live']) assert.match(html, new RegExp(`id="${id}" class="engine-row[^"]*" hidden><span class="engine-dot"`));
  const src = read('island.js');
  assert.match(src, /O\.engineRowView\(lastConn, piState\)/);
  assert.match(src, /document\.addEventListener\('abito:pi-state'/);
  assert.match(src, /openPiSection = event => \{ if \(event\.isTrusted === true && engineRow\)/);
  const ticker = read('sessions-ticker.js');
  assert.match(ticker, /CustomEvent\('abito:pi-state'/);
  const settings = read('settings.js');
  assert.match(settings, /V\.PI_SECTIONS, e\.detail/);
  assert.match(settings, /scrollIntoView/);
  const css = read('style.css') + read('vendor/coucou/island/island.css');
  assert.match(css, /\.engine-dot \{[^}]*width: 5px/);
  assert.match(css, /\.engine-link \{[^}]*font: 500 11px/);
  assert.match(css, /\.engine-link:focus-visible/);
  assert.match(css, /#overview-view:not\(\[data-ticker="on"\]\):not\(\[data-spotify="on"\]\) ~ #notices #connection\[data-kind="down"\]/);
});

test('every deep-link target the island can emit resolves to a real section id in Conexiones', () => {
  const V = require('../frontend/settings-view.js'), O = require('../frontend/overview-view.js');
  const settings = read('settings.js');
  for (const target of ['accounts:agentes', 'accounts:motor', 'accounts:proveedores']) {
    assert.ok(V.PI_SECTIONS[target], target);
    assert.ok(settings.includes(`.id = '${V.PI_SECTIONS[target]}'`), V.PI_SECTIONS[target]);
  }
  assert.equal(O.connectionView({ connections: 0 }).action.target, 'accounts:agentes');
});

test('T2: island reports a NEW settled notice to the Sileo toast through its own baseline gate, display text only, after the finished cycle', () => {
  const src = read('island.js');
  assert.match(src, /const toastGate = NV && NV\.createRevealGate \? NV\.createRevealGate\(\) : null;/);
  assert.match(src, /arrivals\.filter\(x => !x\.kind \|\| x\.kind === 'settled'\)\.at\(-1\)/, 'only settled arrivals, the latest one');
  assert.match(src, /new CustomEvent\('abito:notice-arrival', \{ detail: \{ id: settled\.id, kind: 'settled', title: settled\.title, agent: settled\.agent, projectName: settled\.projectName \} \}\)/, 'no detail/body leaks');
  // F6 (SN1): a Codex attention notice («te pide permiso / te pregunta») reaches the Sileo pill with its one display line
  assert.match(src, /arrivals\.filter\(x => x\.kind === 'attention'\)\.at\(-1\)/, 'the latest attention arrival');
  assert.match(src, /new CustomEvent\('abito:notice-arrival', \{ detail: \{ id: attention\.id, kind: 'attention', title: attention\.title, detail: attention\.detail, agent: attention\.agent, projectName: attention\.projectName \} \}\)/);
  assert.match(src, /const attentionOnly = arrivals\.length > 0 && arrivals\.every\(x => x\.kind === 'attention'\);/);
  assert.match(src, /if \(fresh\) \{ if \(attentionOnly && capsule\.dataset\.edgeHidden === 'true'\) edgeInteraction\?\.alert\(\); else revealIsland\(false, true\); \}/, 'attention alone while Abito is hidden: the Sileo pill is the signal; otherwise a notice reveal (HU-006: never grows a compact island)');
  assert.ok(src.indexOf('finishedCycle.observe(notices, finishedAllowed())') < src.indexOf("'abito:notice-arrival'"), 'the existing finished cycle runs first and is untouched');
  assert.match(src, /else revealIsland\(false, true\); \}/, 'every other arrival is a notice reveal');
  assert.match(src, /start\(id\) \{[\s\S]{0,300}revealIsland\(false, true\);/, 'HU-006: the finished cycle is a notice reveal too');
  assert.match(src, /NV\.revealAction\(\{[^}]*notice \}\)/, 'the notice flag reaches the pure policy');
  assert.match(src, /'abito:compact-notice'/, 'HU-006: the compact pill receives the attention notice');
  const NV = require('../frontend/notify-view.js'), g = NV.createRevealGate();
  const n = id => ({ id, kind: 'settled', title: 't' });
  assert.deepEqual(g.arrivals([n('a')]), [], 'boot history is the baseline, not an arrival');
  assert.deepEqual(g.arrivals([n('a'), n('b')]).map(x => x.id), ['b'], 'only the new one');
  assert.deepEqual(g.arrivals([n('a'), n('b')]), [], 'an unrelated re-render repeats nothing');
});

if (failed) process.exit(1);
