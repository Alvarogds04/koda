'use strict';
/* UI.1 — pure checks for frontend/overview-view.js + frontend/icons.js
   (no DOM, no network). Visual contract: docs/desktop-visual-language.md
   §1.2 icons, §2.1/§2.2 text -> visual map, §3 never-remove.
   Run: node apps/desktop-tauri/test-node/overview-view-check.cjs
   Also run by `cargo test` (tests/frontend_overview.rs). */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const I = require(path.join(frontend, 'icons.js'));
const O = require(path.join(frontend, 'overview-view.js'));

let passed = 0;
const test = (_name, fn) => { fn(); passed += 1; };

// ---- icons ---------------------------------------------------------------
const CONTRACT = ['bubble', 'arrow-up', 'square', 'arrow-left', 'chip', 'plug', 'plug-off',
  'check', 'cross', 'clock', 'triangle', 'eye-off', 'lock', 'refresh', 'info', 'plane', 'arrow-right'];

test('registry has every contract icon (14 rows, plug/unplugged = 2 shapes)', () => {
  for (const name of CONTRACT) assert.ok(I.NAMES.includes(name), name);
});

test('every icon is own inline SVG: 20px grid, currentColor, 2px round stroke, no external refs', () => {
  for (const name of I.NAMES) {
    const svg = I.svg(name);
    assert.match(svg, /^<svg [^>]*viewBox="0 0 20 20"/, name);
    assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, name);
    assert.match(svg, /aria-hidden="true"/, name);
    assert.match(svg, /stroke="currentColor"/, name);
    assert.match(svg, /stroke-width="2"/, name);
    assert.match(svg, /stroke-linecap="round"/, name);
    assert.doesNotMatch(svg, /<script|href=|url\(|style=|\son\w+=|<image|<use|#[0-9a-f]{3,6}\b/i, name);
    assert.ok((svg.match(/</g) || []).length === (svg.match(/>/g) || []).length, name);
  }
});

test('the settings screens have their icons (user = Cuentas)', () => {
  for (const name of ['user', 'gear', 'plug', 'ring']) assert.ok(I.NAMES.includes(name), name);
});

test('unknown icon yields an empty string, never throws', () => {
  assert.equal(I.svg('nope'), '');
  assert.equal(I.svg(undefined), '');
});

// ---- expiry --------------------------------------------------------------
const NOW = Date.parse('2026-10-09T12:00:00Z');
test('expiry label is short and relative', () => {
  assert.equal(O.expiryLabel('2026-10-09T12:04:00Z', NOW), '4 min');
  assert.equal(O.expiryLabel('2026-10-09T12:03:30Z', NOW), '4 min'); // rounds up
  assert.equal(O.expiryLabel('2026-10-09T12:00:30Z', NOW), '<1 min');
  assert.equal(O.expiryLabel('2026-10-09T13:30:00Z', NOW), '2 h');
  assert.equal(O.expiryLabel('2026-10-12T12:00:00Z', NOW), '3 d');
  assert.equal(O.expiryLabel('2999-12-31T23:59:59Z', NOW), '+99 d');
});

test('expiry: past or invalid is "Vencida" / empty, never a negative time', () => {
  assert.equal(O.expiryLabel('2026-10-09T12:00:00Z', NOW), 'Vencida');
  assert.equal(O.expiryLabel('2026-10-09T11:00:00Z', NOW), 'Vencida');
  assert.equal(O.expiryLabel('not a date', NOW), '');
  assert.equal(O.expiryLabel(undefined, NOW), '');
});

test('expiry aria keeps the exact ISO date', () => {
  assert.equal(O.expiryAria('2026-10-09T12:04:00Z', NOW), 'Vence en 4 min: 2026-10-09T12:04:00Z');
  assert.equal(O.expiryAria('2026-10-09T11:00:00Z', NOW), 'Vencida: 2026-10-09T11:00:00Z');
});

// ---- approval card state -------------------------------------------------
test('pending: sun tone, the design chip word «Decisión pendiente», actionable', () => {
  const v = O.cardView(null);
  assert.equal(v.kind, 'pending');
  assert.equal(v.tone, 'sun');
  assert.equal(v.word, 'Decisión pendiente'); // T7.3 isla-approval chip (was '')
  assert.equal(v.actionable, true);
});

test('SENT is "Enviada": neutral live paper plane, never a go check (contract §1.1/§8.4)', () => {
  const v = O.cardView('Decisión enviada.');
  assert.equal(v.kind, 'sent');
  assert.equal(v.word, 'Enviada');
  assert.equal(v.icon, 'plane');
  assert.equal(v.tone, 'live');
  assert.notEqual(v.tone, 'go');
  assert.notEqual(v.icon, 'check');
  assert.equal(v.actionable, false);
  assert.doesNotMatch(JSON.stringify(v), /No disponible/);
});

test('expired -> clock slash + "Vencida", faint', () => {
  const v = O.cardView('Propuesta vencida.');
  assert.deepEqual([v.kind, v.icon, v.word, v.tone], ['expired', 'clock-off', 'Vencida', 'faint']);
});

test('failed confirmation -> red triangle + "Sin confirmar"', () => {
  for (const r of ['No se pudo confirmar la decisión. Esperá una actualización.', 'No se pudo confirmar la decisión.']) {
    const v = O.cardView(r);
    assert.deepEqual([v.kind, v.icon, v.word, v.tone], ['unconfirmed', 'triangle', 'Sin confirmar', 'red']);
  }
});

test('in flight -> live ring, no word, aria "Enviando decisión"', () => {
  const v = O.cardView('Decisión en curso.');
  assert.deepEqual([v.kind, v.icon, v.word, v.tone], ['busy', 'ring', '', 'live']);
  assert.equal(v.aria, 'Enviando decisión');
});

test('covered (compact) shows only the sun dot', () => {
  const v = O.cardView('Abrí la tarjeta para decidir.');
  assert.deepEqual([v.kind, v.word, v.tone, v.actionable], ['covered', '', 'sun', false]);
});

test('any other inert reason stays honest: faint lock + "No disponible", full text in aria', () => {
  const v = O.cardView('Puente no disponible.');
  assert.deepEqual([v.kind, v.icon, v.word, v.tone], ['unavailable', 'lock', 'No disponible', 'faint']);
  assert.match(v.aria, /Puente no disponible\./);
});

test('every non-pending view has a visible word or is an explicit dot/ring', () => {
  for (const r of ['Decisión enviada.', 'Propuesta vencida.', 'No se pudo confirmar la decisión.', 'Puente no disponible.']) {
    assert.ok(O.cardView(r).word.length > 0, r);
  }
});

// ---- connection ----------------------------------------------------------
test('no Pi -> unplugged icon + "Sin motor" (design ov-error chip; the duplicate sentence is gone)', () => {
  const v = O.connectionView({ unavailable: false, connections: 0 });
  // L37: no Pi session is Coucou's normal idle, not an error: the word stays (honest), the tone is the quiet one (settings' «Sin motor» is faint too)
  assert.deepEqual([v.kind, v.icon, v.word, v.tone], ['down', 'plug-off', 'Sin motor', 'faint']);
  assert.doesNotMatch(JSON.stringify(v), /Sin conexión con Pi/);
  // T7.3 design diet: the visible detail is one short line; the long honest
  // sentence stays reachable in aria (was a two-sentence visible disclaimer).
  assert.equal(v.detail, 'Conectá Pi.');
  assert.match(v.aria, /solo si conectás/);
  assert.doesNotMatch(v.aria, /conectas/);
});

test('connected -> plug, go, no word; the "declared identity" caveat lives in aria/detail', () => {
  const v = O.connectionView({ unavailable: false, connections: 1 });
  assert.deepEqual([v.kind, v.icon, v.word, v.tone], ['connected', 'plug', '', 'go']);
  assert.match(v.aria, /identidad declarada como Pi/);
  // T7.3 design diet (isla-ov-normal): the idle overview line replaces the
  // visible disclaimer; the honest caveat stays in aria.
  assert.equal(v.detail, 'Pi espera tu próxima tarea.');
  assert.match(v.aria, /no confirma/i);
});

test('channel down -> red triangle + "Avisos caídos"', () => {
  const v = O.connectionView({ unavailable: true, connections: 0 });
  assert.deepEqual([v.kind, v.icon, v.word, v.tone], ['unavailable', 'triangle', 'Avisos caídos', 'red']);
  // T7.3 design diet: one short visible line; the cause stays in aria.
  assert.equal(v.detail, 'Sin avisos locales.');
  assert.match(v.aria, /no pudo iniciarse/);
});

test('connection view tolerates a missing snapshot', () => {
  assert.equal(O.connectionView(null).kind, 'down');
});

// ---- L37: «no Pi session» is Coucou's idle, never an error band ------------------------------------------------------
test('L37: with no Pi session connected there is NO red band and no «Sin conexión» title; the honest status stays quiet (word + aria)', () => {
  const down = O.connectionView({ unavailable: false, connections: 0 });
  assert.equal(down.tone, 'faint', 'quiet, not red');
  assert.equal(down.word, 'Sin motor', 'the honest word stays');
  assert.match(down.aria, /Sin motor: no hay una sesión conectada/, 'the aria sentence is kept verbatim');
  assert.equal(down.detail, 'Conectá Pi.');
  // the band that used to be built for it is gone (Coucou has no «disconnected» state: nothing running is idle)
  assert.equal(typeof O.connectionBandView, 'undefined', 'no transport-error band for an idle island');
  for (const f of ['overview-view.js', 'island.js']) assert.doesNotMatch(fs.readFileSync(path.join(frontend, f), 'utf8'), /Sin conexión'|connectionBandView/, f);
  // a missing snapshot is the same idle, not an error
  assert.equal(O.connectionView(null).tone, 'faint');
});

test('L37: the ONLY red is a real failure: the receiver that failed to start keeps its red tone, word and the error notice', () => {
  const failed = O.connectionView({ unavailable: true, connections: 0 });
  assert.deepEqual([failed.kind, failed.tone, failed.word], ['unavailable', 'red', 'Avisos caídos']);
  assert.match(failed.aria, /no pudo iniciarse/);
  // Rust queues an error-severity transport notice for it: that notice keeps the red tone through the band view
  const band = O.noticeBandView([{ id: 'transport-1', kind: 'transport', title: 'Avisos caídos', detail: '', severity: 'error', at: 1000, expiresAt: Number.MAX_SAFE_INTEGER }], 2000);
  assert.equal(band.tone, 'red'); assert.equal(band.title, 'Avisos · 1');
  // a healthy connection is the calm green (nothing drawn), unchanged
  assert.equal(O.connectionView({ connections: 1 }).tone, 'go');
});


// ---- notice pill ---------------------------------------------------------
test('notice pill: short text, badge, 60 s ring fraction, full text in aria', () => {
  const n = [{ id: 'a', title: 'Pi terminó su turno', detail: 'No confirma que la tarea haya salido bien.', at: NOW - 15000, expiresAt: NOW + 45000 }];
  const v = O.noticeView(n, NOW);
  assert.equal(v.text, 'Pi terminó');
  assert.equal(v.badge, 1);
  assert.equal(v.fraction, 0.75);
  assert.match(v.aria, /Pi terminó su turno/);
  assert.match(v.aria, /1 aviso reciente/);
});

test('notice pill: unknown titles are cut to 3 words; plural; ring clamps', () => {
  const n = [{ id: 'a', title: 'Una cosa muy larga pasó', expiresAt: NOW - 1 }, { id: 'b', title: 'x', expiresAt: NOW }];
  const v = O.noticeView(n, NOW);
  assert.equal(v.text, 'Una cosa muy');
  assert.equal(v.badge, 2);
  assert.equal(v.fraction, 0);
  assert.match(v.aria, /2 avisos recientes/);
  assert.equal(O.noticeView([], NOW), null);
});

// ---- #373 GD032: severity/kind (Rust is the single admission source) ------
test('existing settled notices render identically (regression: info severity changes nothing)', () => {
  const n = [{ id: 'a', title: 'Pi terminó su turno', detail: 'No confirma que la tarea haya salido bien.', at: NOW - 15000, expiresAt: NOW + 45000 }];
  assert.deepEqual(O.noticeView(n, NOW), {
    text: 'Pi terminó',
    badge: 1,
    fraction: 0.75,
    aria: 'Aviso: Pi terminó su turno. No confirma que la tarea haya salido bien. 1 aviso reciente; se descartan al minuto.',
    tone: '',
  });
  // the Rust model now labels it explicitly: same rendering
  assert.deepEqual(O.noticeView([{ ...n[0], severity: 'info', kind: 'settled' }], NOW), O.noticeView(n, NOW));
});

test('severity classification: error renders red, warning sun, info neutral', () => {
  const failure = [{
    id: 'transport-1', kind: 'transport', severity: 'error',
    title: 'Conexión caída', detail: 'Se cortó la conexión con Pi.',
    at: NOW - 1000, expiresAt: NOW + 60000,
  }];
  const v = O.noticeView(failure, NOW);
  assert.equal(v.tone, 'red', 'an error notice is never neutral');
  assert.equal(v.text, 'Conexión caída');
  assert.match(v.aria, /^Error:/, 'the severity is announced, not only colored');
  assert.match(v.aria, /Conexión caída/);
  const warn = O.noticeView([{ id: 'w', kind: 'settled', severity: 'warning', title: 'Aviso', expiresAt: NOW + 60000 }], NOW);
  assert.equal(warn.tone, 'sun');
  assert.match(warn.aria, /^Advertencia:/);
  // an unknown/absent severity is never a crash and never invents a tone
  assert.equal(O.noticeView([{ id: 'x', title: 'Pi terminó su turno', expiresAt: NOW }], NOW).tone, '');
  assert.equal(O.noticeView([{ id: 'x', severity: 'loud', kind: 'settled', title: 'Pi terminó su turno', expiresAt: NOW }], NOW).tone, '');
});

test('filtered kinds never show: only what Rust admits (settled|transport) reaches the strip', () => {
  const engine = [{ id: 't', kind: 'toast', severity: 'info', title: 'engine toast', expiresAt: NOW + 60000 }];
  assert.equal(O.noticeView(engine, NOW), null, 'an engine-facing toast is never rendered');
  const mixed = [
    { id: 'e', kind: 'engine', title: 'internal', expiresAt: NOW + 60000 },
    { id: 'k', kind: 'heartbeat', title: 'hb', expiresAt: NOW + 60000 },
    { id: 'a', kind: 'settled', severity: 'info', title: 'Pi terminó su turno', expiresAt: NOW + 60000 },
  ];
  const v = O.noticeView(mixed, NOW);
  assert.equal(v.badge, 1, 'only the admitted notice counts');
  assert.equal(v.text, 'Pi terminó');
  // an admitted transport failure renders on its own
  assert.equal(O.noticeView([{ id: 'transport-2', kind: 'transport', severity: 'error', title: 'Conexión caída', expiresAt: NOW + 60000 }], NOW).badge, 1);
});

// ---- #373 wiring: the strip paints the view's tone --------------------------
test('island.js paints the notice strip tone from the view (textContent only)', () => {
  const src = fs.readFileSync(path.join(frontend, 'island.js'), 'utf8');
  assert.match(src, /noticesEl\.dataset\.tone\s*=/, 'the strip carries the view tone');
  assert.doesNotMatch(src, /noticesEl\.innerHTML/, 'the strip never writes markup');
});

// ---- #437 wiring: the design band, the grouped «N avisos» + «Ver», the list view ----
test('#437 island.js renders the design band and the list view through the pure views', () => {
  const src = fs.readFileSync(path.join(frontend, 'island.js'), 'utf8');
  // the band and the list come from the pure views (one admission source)
  assert.match(src, /O\.noticeBandView\(/);
  assert.match(src, /O\.noticeListView\(/);
  // the band's one action: «Abrir» (native contract) or «Ver» (local list)
  assert.match(src, /noticeAction\.textContent\s*=/);
  // «Ver» toggles the local list; row detail still requires native confirmation
  assert.match(src, /toggleNoticeList/);
  const opener = src.slice(src.indexOf("const noticeOpen = $('notice-open')"), src.indexOf('const listenNotice'));
  assert.match(opener, /window\.desktop\.click\(payload\)/, 'native-confirmed navigation remains available for individual rows');
  // per-row × dismisses the EXACT id; a refusal refreshes, never falls back to the first
  assert.match(src, /dismiss\(row\.id\)/);
  assert.match(src, /never falls back/, 'the refusal path is documented and honest');
  // «Descartar todos» loops the argument-free verb, bounded by the queue (8)
  assert.match(src, /notice-clear/);
  // the list closes itself when empty, and on Escape
  assert.match(src, /noticeListOpen\s*=\s*false/);
  // no badge: the design's title says «N avisos» itself
  assert.doesNotMatch(src, /noticeCount\.textContent/, 'the old count badge is gone from the band');
});

// ---- #437: the notice BAND (design: one 40 px band; several collapse into «N avisos» + «Ver») ----
test('notice age: un momento / N min / hoy / ayer / N d; absent clocks say nothing', () => {
  assert.equal(O.noticeAge(NOW - 30000, NOW), 'un momento');
  assert.equal(O.noticeAge(NOW - 120000, NOW), '2 min');
  assert.equal(O.noticeAge(NOW - 3 * 3600000, NOW), 'hoy');
  assert.equal(O.noticeAge(NOW - 30 * 3600000, NOW), 'ayer');
  assert.equal(O.noticeAge(NOW - 4 * 86400000, NOW), '4 d');
  assert.equal(O.noticeAge(NOW + 5000, NOW), 'un momento', 'a future clock never goes negative');
  assert.equal(O.noticeAge(undefined, NOW), '');
  assert.equal(O.noticeAge(NOW, 'junk'), '');
  assert.equal(O.noticeAgeDetail(NOW - 120000, NOW), 'Hace 2 min');
  assert.equal(O.noticeAgeDetail(NOW - 30000, NOW), 'Hace un momento');
  assert.equal(O.noticeAgeDetail(NOW - 3 * 3600000, NOW), 'Hoy');
  assert.equal(O.noticeAgeDetail(NOW - 30 * 3600000, NOW), 'Ayer');
  assert.equal(O.noticeAgeDetail(NOW - 4 * 86400000, NOW), 'Hace 4 d');
  assert.equal(O.noticeAgeDetail(undefined, NOW), '');
});

test('Avisos entry, one notice: labelled count, local list, severity tone and ring', () => {
  const n = [{ id: 'a', kind: 'settled', severity: 'warning', title: 'Pi terminó su turno',
    detail: 'No confirma que la tarea haya salido bien.', at: NOW - 120000, expiresAt: NOW + 45000 }];
  const v = O.noticeBandView(n, NOW);
  assert.equal(v.count, 1);
  assert.equal(v.grouped, true);
  assert.equal(v.title, 'Avisos · 1');
  assert.equal(v.detail, 'Pi terminó');
  assert.equal(v.action, 'list');
  assert.equal(v.tone, 'sun');
  assert.equal(v.fraction, 0.75);
  assert.match(v.aria, /Pi terminó su turno/, 'the full honest sentence stays in the aria');
  assert.equal(O.noticeBandView([], NOW), null);
  assert.equal(O.noticeBandView(null, NOW), null);
});

test('Avisos entry, several notices: labelled count + «Ver» with the short titles', () => {
  const n = [
    { id: 'a', kind: 'settled', severity: 'warning', title: 'Pi terminó su turno', at: NOW - 120000, expiresAt: NOW + 45000 },
    { id: 'b', kind: 'settled', severity: 'info', title: 'Pi espera tu decisión', at: NOW - 60000, expiresAt: NOW + 50000 },
    { id: 'c', kind: 'settled', severity: 'error', title: 'Atajo limitado (sin permiso)', at: NOW - 30000, expiresAt: NOW + 55000 },
  ];
  const v = O.noticeBandView(n, NOW);
  assert.equal(v.count, 3);
  assert.equal(v.grouped, true);
  assert.equal(v.title, 'Avisos · 3');
  assert.equal(v.detail, 'Pi terminó · Pi espera · Atajo limitado', 'the design\'s short titles, joined with ·');
  assert.equal(v.action, 'list');
  assert.equal(v.tone, 'sun', 'the band wears the FIRST notice\'s severity, like the existing ring');
  assert.match(v.aria, /3 avisos recientes/);
});

test('notice band: the 60 s window and kind admission ride the same noticeView rules', () => {
  const engine = [{ id: 't', kind: 'toast', severity: 'info', title: 'engine toast', at: NOW, expiresAt: NOW + 60000 }];
  assert.equal(O.noticeBandView(engine, NOW), null, 'an engine-facing toast never renders');
  const expired = [{ id: 'x', kind: 'settled', title: 'Pi terminó su turno', at: NOW - 60000, expiresAt: NOW }];
  const v = O.noticeBandView(expired, NOW);
  assert.equal(v.fraction, 0, 'the ring clamps, the window is unchanged');
});

test('notice list view: rows carry id, FULL title, age and tone; count for the header', () => {
  const n = [
    { id: 'a', kind: 'settled', severity: 'warning', title: 'Pi terminó su turno', at: NOW - 120000, expiresAt: NOW + 45000 },
    { id: 'b', kind: 'settled', severity: 'info', title: 'Pi espera tu decisión', at: NOW - 60000, expiresAt: NOW + 50000 },
    { id: 'c', kind: 'transport', severity: 'error', title: 'Atajo limitado (sin permiso)', at: NOW - 30 * 3600000, expiresAt: NOW + 55000 },
  ];
  const v = O.noticeListView(n, NOW);
  assert.equal(v.count, 3);
  assert.deepEqual(v.rows.map(r => [r.id, r.title, r.time, r.tone]), [
    ['a', 'Pi terminó su turno', '2 min', 'sun'],
    ['b', 'Pi espera tu decisión', '1 min', ''],
    ['c', 'Atajo limitado (sin permiso)', 'ayer', 'red'],
  ], 'rows keep the FULL title; the row age says «un momento», never a bare «ahora»');
  assert.equal(O.noticeListView([], NOW), null);
  assert.equal(O.noticeListView(null, NOW), null);
  // unadmitted kinds never reach the list either
  assert.equal(O.noticeListView([{ id: 'e', kind: 'engine', title: 'x', at: NOW, expiresAt: NOW + 60000 }], NOW), null);
});

// ---- S4/T2: the «attention» notice (Codex asks in its own terminal) --------------------------
test('attention: admitted, sun tone, actionable detail, never a card', () => {
  const n = [{ id: '3f2b8a40-1c2d-4e5f-8a6b-7c8d9e0f1a2b', kind: 'attention', severity: 'warning',
    title: 'Codex te pide permiso', detail: 'Bash: npm install · Respondé en la terminal',
    agent: 'codex', projectName: 'my-project', at: NOW, expiresAt: NOW + 60000 }];
  const v = O.noticeView(n, NOW);
  assert.equal(v.text, 'Codex pide permiso');
  assert.equal(v.tone, 'sun', 'the Codex notice is the sun tone, never red');
  assert.match(v.aria, /^Atención:/, 'the kind is announced, not only coloured');
  assert.match(v.aria, /Respondé en la terminal/, 'the actionable sentence stays reachable');
  const band = O.noticeBandView(n, NOW);
  assert.equal(band.tone, 'sun');
  assert.equal(band.action, 'list', 'the one band action is «Ver» (the local list)');
  assert.equal(band.detail, 'Codex pide permiso: Bash: npm install · Respondé en la terminal');
  const row = O.noticeListView(n, NOW).rows[0];
  assert.equal(row.kind, 'attention');
  assert.equal(row.tone, 'sun');
  assert.equal(row.detail, 'Bash: npm install · Respondé en la terminal');
  assert.equal(row.projectName, 'my-project'); assert.equal(row.agent, 'codex');
  // no question card for Codex: its prompt is Codex's own terminal dialog
  assert.equal(O.finishedCardView(n[0], () => 'Codex'), null);
  // a settled notice keeps its old rendering (no detail in the list, no kind tone)
  const settled = [{ id: 'a', kind: 'settled', severity: 'info', title: 'Pi terminó su turno', detail: 'x', at: NOW, expiresAt: NOW + 60000 }];
  assert.equal(O.noticeBandView(settled, NOW).detail, 'Pi terminó');
  assert.ok(!Object.hasOwn(O.noticeListView(settled, NOW).rows[0], 'detail'));
  assert.equal(O.noticeView(settled, NOW).tone, '');
});
test('attention: an unknown kind is still filtered out (Rust stays the single admission source)', () => {
  for (const kind of ['toast', 'engine', 'heartbeat', 'attention_v2']) {
    assert.equal(O.noticeView([{ id: 'x', kind, title: 'Codex te pide permiso', at: NOW, expiresAt: NOW + 60000 }], NOW), null, kind);
  }
});

// ---- markup contract -----------------------------------------------------
test('every icon-only control in index.html has an aria-label', () => {
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  for (const id of ['open-chat', 'notice-dismiss', 'notice-info', 'card-info']) {
    const m = new RegExp(`<button[^>]*id="${id}"[^>]*>`).exec(html);
    assert.ok(m, `#${id} present`);
    assert.match(m[0], /aria-label="[^"]{3,}"/, `#${id} aria-label`);
  }
  for (const id of ['allow', 'deny']) { // icon + WORD (human decision)
    assert.match(html, new RegExp(`id="${id}"[^>]*>[\\s\\S]*?<span class="btn-word">(Permitir|Rechazar)</span>`), id); // T7.3: «Denegar» -> «Rechazar» (isla-approval)
  }
  assert.match(html, /<script defer src="icons\.js"><\/script>/);
  assert.match(html, /<script defer src="overview-view\.js"><\/script>/);
});

test('overview copy keeps voseo and drops the old duplicated sentences', () => {
  const src = fs.readFileSync(path.join(frontend, 'island.js'), 'utf8') +
    fs.readFileSync(path.join(frontend, 'overview-view.js'), 'utf8');
  assert.doesNotMatch(src, /No disponible'\s*:\s*'Pendiente'/);
  assert.doesNotMatch(src, /Sin conexión con Pi\./);
  assert.doesNotMatch(src, /conectas /);
});

// ---- UI.1 correction pass --------------------------------------------------
// S10: the island's geometry lives in vendor/coucou/island/island.css, loaded after style.css (cascade order = concatenation order).
const css = fs.readFileSync(path.join(frontend, 'style.css'), 'utf8') + '\n' + fs.readFileSync(path.join(frontend, 'vendor/coucou/island/island.css'), 'utf8');
const islandSrc = fs.readFileSync(path.join(frontend, 'island.js'), 'utf8');
// Declarations of the LAST rule whose selector list contains `sel` exactly,
// outside @media blocks; later rules win like in the cascade.
function decls(sel, source = css) {
  const out = {};
  const plain = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@keyframes[^{]*\{[^{}]*\{[^{}]*\}\s*\}/g, '').replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  for (const m of plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!m[1].split(',').map(x => x.trim()).includes(sel)) continue;
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim();
    }
  }
  return out;
}
const px = v => (v === undefined ? NaN : parseFloat(v));

test('44px: every control (incl. the card «i») measures >= 44x44', () => {
  const base = decls('.icon-btn');
  const controls = {
    '.icon-btn': base, '#notice-info': { ...base, ...decls('#notice-info') },
    '#notice-dismiss': { ...base, ...decls('#notice-dismiss') }, '#card-info': { ...base, ...decls('#card-info') },
    '#allow': decls('#allow'), '#deny': decls('#deny'), '#open-chat': decls('#open-chat'),
  };
  for (const [name, d] of Object.entries(controls)) {
    const w = Math.max(px(d['min-width']) || 0, px(d.width) || 0);
    const h = Math.max(px(d['min-height']) || 0, px(d.height) || 0);
    assert.ok(w >= 44 && h >= 44, `${name} is ${w}x${h}`);
  }
});

// ---- #335 F002 composition, re-pinned to Coucou's geometry (S10 / L19) --------
// Frames: .agentline/.overview-detail/.pill-summary live inside .card-left (322px) of the 620x108 overview
// box (island x10..630, y42..150, Coucou's row under its 34px header) and #pill-choices lives in the same
// box from x332; #notices is anchored to the ISLAND (640x160) through calc(50% + 22px), so
// island = overview + 10 horizontally and + 42 vertically. Same rules as before (budget, zero overlap,
// disjoint rects, bounded band), now measured on Coucou's numbers.
const OVH = 132; // overview box height (Coucou's card row)
const OV_TOP = 42; // overview box top inside the island

test('R2: the active content keeps its vertical budget in the central column', () => {
  const a = decls('.agentline'), d = decls('.overview-detail'), s = decls('.pill-summary');
  assert.equal(px(a.left), 108, 'agentline opens the content column (Coucou .who padding-left 108)');
  assert.equal(px(a.top), 10, 'agentline y10..25');
  assert.equal(px(d.left), 108);
  assert.equal(px(d.top), 31, 'connection detail / ticker y31..75');
  assert.equal(px(d.height), 44, 'Coucou .ticker height 44');
  assert.equal(px(s.left), 108);
  assert.equal(px(s.top), 78, 'pill summary y78');
  assert.equal(s.overflow, 'hidden', 'the slot clips: its text can never claim the band below');
  const cap = px(s['max-height']);
  assert.ok(cap > 0, '.pill-summary needs an explicit max-height (a bounded slot, not content height)');
  assert.ok(px(s.top) >= px(d.top) + px(d.height), 'the summary starts after the ticker/detail slot');
  assert.ok(px(s.top) + cap <= OVH, `summary ${px(s.top)}+${cap} exceeds the ${OVH}px card`);
});

test('R3: the pill-summary slot never reaches the mini-bots (zero overlap)', () => {
  const s = decls('.pill-summary'), mb = decls('#minibots');
  assert.equal(px(mb.top), 8, 'the active-turn mini-Abitos ride the who row (where Coucou puts the session count)');
  const rowEnd = px(mb.top) + px(decls('.minibot svg')['height']); // 24px mini-Abot
  assert.ok(rowEnd <= px(decls('.overview-detail').top) + 4, 'mini-bots end where the ticker/detail slot starts');
  assert.ok(px(s.top) >= rowEnd, 'the summary slot starts below the mini-bots');
  assert.equal(String(mb['pointer-events'] || decls('#minibots')['pointer-events']), 'none');
});

test('R4 (A+E): the strip band sits over the blobs card\'s x range only and the blobs list owns its own card (no overlap with the band)', () => {
  const n = decls('#notices'), blobs = decls('#blobs'), p = decls('#pill-choices'), mb = decls('#minibots');
  assert.equal(p.display, 'flex');
  assert.equal(p['pointer-events'] || blobs['pointer-events'], 'auto', 'the blob choices stay clickable');
  // the blobs card is its own element in the overview frame: top 42, height 108
  assert.equal(px(blobs.top), OV_TOP); assert.equal(px(blobs.height), OVH);
  assert.equal(n.left, 'calc(50% + 176px)'); assert.equal(n.right, 'auto'); assert.equal(n.width, '174px');
  assert.ok(px(mb.right) >= 36 && mb.left === 'auto', `#minibots right ${mb.right} reaches into the blobs card`);
});

test('R5 (A+E): the notices band is ONE 28px row over the top of the blobs card — the capsule or the chips row, never both stacked — and scrolls inside, never growing', () => {
  const n = decls('#notices'), p = decls('#pill-choices');
  assert.equal(px(n.height), 28, 'band = one 28px row (Coucou\'s .pill capsule); the card pads 32px under it');
  assert.match(String(n['overflow-y'] || n.overflow || ''), /(auto|scroll)/, 'overflow scrolls INSIDE the band instead of growing the box');
  assert.match(css, /#capsule\[data-view="overview"\] #notices:has\(#notice-pill:not\(\[hidden\]\)\) #notice-row \{ display: none; \}/,
    'with a notice capsule the chips row is not drawn: nothing stacks inside 28px (the screen gate showed the «4 avisos» chip over the blobs)');
  assert.equal(px(decls('#notice-row')['min-height']), 28);
  assert.equal(String(decls('#notice-pill').order), '-1', 'the actionable notice is the first thing in the band');
  assert.equal(px(decls('#blobs')['padding-top']), 0, 'padding is conditional: calm gives the room back');
  assert.equal(p.overflow, 'hidden', 'the list clips its own box, it never grows upward');
  assert.equal(p['flex-direction'], 'column', 'A+E: one blob per row');
  assert.doesNotMatch(css, /#pill-choices \.pill-choice:nth-child\(n\+5\)/, 'A+E: no CSS belt hides the fifth blob any more; the column scrolls');
});

test('notices strip: its box stays inside the overview card and its content never escapes the box', () => {
  // #335 F002 re-scope (S6.3). The strip is the approved 44px band on top of the right card; the SAME
  // assertion — content/height of the strip may never leave its bound — is proven through the box: it stays
  // inside the 132px card, one visible row fits the band exactly, and the stacked content is carried by
  // internal overflow (it scrolls inside; it can never grow the box toward the grid).
  const n = decls('#notices');
  const top = px(n.top) - OV_TOP, height = px(n.height);
  const row = px(decls('#notice-row')['min-height']); // 44px: what ONE visible row needs
  const contentH = row + (px(n.gap) || 0) + px(decls('#notice-pill')['min-height']);
  assert.ok(height >= row, `band ${height}px < one row ${row}px`);
  assert.match(String(n['overflow-y'] || n.overflow || ''), /(auto|scroll)/, 'stacked content must scroll INSIDE the box');
  assert.ok(contentH > height, 'model: stacked content exceeds the band, so the box (not the content) is the bound');
  assert.ok(top >= 0 && top + height <= OVH, 'the band lies inside the 132px card');
  const lane = decls('#capsule[data-phase="expanded"][data-notice-view="notices"] #notices');
  assert.equal(lane.height, '32px', 'S10: the confirmed-notice lane is a fixed 32px band under the overview');
  assert.equal(px(lane.top), 178, 'S10: it starts under the 132px card row (42 + 132 + 4)');
});

test('reduced motion: the in-flight ring does not rotate (cue kept by blue ring shape)', () => {
  const joined = [...css.matchAll(/html\[data-motion="reduce"\][^{]*\{[^}]*\}/g)].map(m => m[0]).join('\n');
  assert.ok(joined, 'reduced-motion rules exist, keyed on html[data-motion="reduce"]');
  assert.match(joined, /\[data-kind="busy"\] \.ico svg\s*\{[^}]*animation:\s*none/);
  assert.doesNotMatch(css, /even under reduced motion/);
});

test('«i» aria-label announces the real state', () => {
  const card = O.cardView('No se pudo confirmar la decisión. Esperá una actualización.');
  assert.equal(O.infoLabel('Ver detalle de la decisión', card.aria),
    'Ver detalle de la decisión: No se pudo confirmar la decisión. Esperá una actualización.');
  const conn = O.connectionView({ connections: 0 });
  assert.match(O.infoLabel('Ver detalle de la conexión', conn.aria), /^Ver detalle de la conexión: Sin motor/);
  assert.equal(O.infoLabel('Ver', ''), 'Ver');
  assert.match(islandSrc, /\$\('card-info'\)\.setAttribute\('aria-label', O\.infoLabel\(/);
  assert.match(islandSrc, /noticeInfo\.setAttribute\('aria-label', O\.infoLabel\(/);
});

test('§3: a card never hides a missing Pi / downed notices channel', () => {
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  assert.match(html, /id="card-conn"[^>]*role="img"/);
  assert.match(html, /id="card-conn-word"/);
  assert.match(islandSrc, /card-conn/);
  assert.equal(O.cardConnection(O.connectionView({ connections: 1 })), null);
  assert.equal(O.cardConnection(O.connectionView({ connections: 0 })).word, 'Sin motor');
  assert.equal(O.cardConnection(O.connectionView({ unavailable: true })).word, 'Avisos caídos');
});

test('R6 visible size: Coucou botDiameter 58 plain overview, 56 with a card (scale/viewBox only; S10 L19)', () => {
  const num = re => { const m = re.exec(islandSrc); assert.ok(m, String(re)); return m.slice(1).map(Number); };
  const units = 112; // R6 artwork's measured extent; not an unused runtime constant.
  const vb = num(/OVERVIEW_VB = \[(\d+), (\d+), (\d+), (\d+)\]/);
  const [plain] = num(/OVERVIEW = \{[^}]*clay: (\d+)/);
  const [card] = num(/OVERVIEW_CARD = \{ clay: (\d+)/);
  const scale = Math.min(1, 1) / Math.max(vb[2], vb[3]);
  assert.ok(Math.abs(units * scale * plain - 58) <= 2, `plain visible ${units * scale * plain}`);
  assert.ok(Math.abs(units * scale * card - 56) <= 2, `card visible ${units * scale * card}`);
  assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(frontend, 'clay-engine.js'))).digest('hex').slice(0, 8), '40625d7f');
});

test('R6 margins: card box keeps >=20px from the island edge (reject shake ~2px), viewBox top air', () => {
  const [clay, clayX] = /OVERVIEW_CARD = \{ clay: (\d+), clayX: (\d+)/.exec(islandSrc).slice(1).map(Number);
  assert.ok(clayX - clay / 2 >= 20, `box left ${clayX - clay / 2}`);
  // HU-057 (odd/tasks/isla-nusa.md): the plain overview is the Nusa notch (OVERVIEW {w:720,h:150,r:26,clay:64,clayX:598,cy:74}), no longer Coucou's
  // botX 68 / cy 113. That half is asserted on the REAL rendered island in the browser block at the end of this file (not copied from island.js);
  // the card variant (OVERVIEW_CARD clayX 62, cy 113) is unchanged and stays pinned here.
  assert.deepEqual([clayX, /OVERVIEW_CARD = \{[^}]*cy: (\d+)/.exec(islandSrc)[1] * 1], [62, 113], 'Coucou VIEW_LAYOUTS botX 62, cy 101 (card variant)');
  const vb = /OVERVIEW_VB = \[(\d+), (\d+), (\d+), (\d+)\]/.exec(islandSrc).slice(1).map(Number);
  assert.deepEqual(vb, [36, 32, 128, 128]);
});

test('Q2 pose wiring: engine setState only, from abito:pose; no gesture on a SENT/unconfirmed decision', () => {
  assert.match(islandSrc, /clay\.setState\(next\)/);
  assert.match(islandSrc, /'abito:pose'/);
  assert.doesNotMatch(islandSrc, /staticPose|AbitoClay\.STATES|flash\(/);
  // behaviour: every card outcome the host can report keeps R6 at rest
  for (const reason of ['Decisión enviada.', 'No se pudo confirmar la decisión. Esperá una actualización.', 'Decisión en curso.', 'Propuesta vencida.', null]) {
    const kind = O.cardView(reason).kind;
    for (const verb of ['allow', 'deny']) assert.equal(O.gestureFor(kind, verb), null, `${kind}/${verb}`);
  }
});

test('UI.3: compact only carries the sun contour; Escape closes models first; new-answer dot is neutral; rows animate 160ms, still under reduced motion', () => {
  const compactOnly = [...css.matchAll(/#capsule\[data-card-tone="(go|red|faint|live)"\] #island/g)];
  assert.equal(compactOnly.length, 0, 'non-sun contours need data-phase="expanded"');
  assert.match(css, /#capsule\[data-card-tone="sun"\] #island/);
  const chatSrc = fs.readFileSync(path.join(frontend, 'chat.js'), 'utf8');
  assert.ok(chatSrc.indexOf("dataset.models === 'open'") < chatSrc.indexOf('if (typing)'), 'models closes before leaving the composer');
  assert.match(css, /#chat-new \.dot \{ background: var\(--island-live\)/);
  assert.match(css, /#chat-log li\.enter \{ animation: row-in 160ms/);
  assert.match(css, /html\[data-motion="reduce"\] #chat-log li\.enter \{ animation: none/);
  assert.match(islandSrc, /paintCompactFlag\(\); \/\/ an expired card/);
});

test('R6 pose from the host snapshot: only REAL persistent failures give error; the rest never touches the pose', () => {
  const bridge = state => ({ unavailable: false, bridgeStatus: { state } });
  assert.equal(O.snapshotPose(bridge('unhealthy')), 'error');
  assert.equal(O.snapshotPose(bridge('stopped')), 'error');
  assert.equal(O.snapshotPose({ unavailable: true, bridgeStatus: { state: 'healthy' } }), 'error');
  for (const ok of ['disabled', 'starting', 'healthy']) assert.equal(O.snapshotPose(bridge(ok)), null, ok);
  assert.equal(O.snapshotPose(null), null);
  assert.equal(O.snapshotPose({}), null);
  // a sent/conflict card or a notice never changes the pose
  assert.equal(O.snapshotPose({ ...bridge('healthy'), card: { state: 'inert', reason: 'Decisión enviada.' }, notices: [{}] }), null);
  assert.equal(O.snapshotPose({ ...bridge('healthy'), card: { state: 'inert', reason: 'No se pudo confirmar la decisión.' } }), null);
});

test('R6 liveness (#304): the island never pauses the engine; idle is alive by default and the SYSTEM reduced-motion value no longer freezes it unless the human opted in', () => {
  assert.doesNotMatch(islandSrc, /setPaused|setManual/);
  // the engine is forced from ONE place: the motion state (forced unless the human honors the system)
  const forced = islandSrc.match(/setForced\([^)]*\)/g) || [];
  assert.deepEqual(forced, ['setForced(!honorSystem)']);
  assert.match(islandSrc, /honorSystem = window\.AbitoOverview\.honorSystemMotion\(snap\)/);
  assert.match(islandSrc, /AbitoClay\.create\(clayEl, \{ seed: 505/);
  assert.doesNotMatch(islandSrc, /live: false/);
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /animar|animate/i, 'no «animate» button in the UI');
  // priority order: host error > chat pose > rest
  assert.match(islandSrc, /O\.choosePose\(chatPose, hostPose\)/);
});

test('§9.2 hover: ~1.06 only inside the R6 box, never reduced/dragging, no meaning', () => {
  const box = { left: 20, top: 10, width: 100, height: 100 };
  assert.equal(O.HOVER_SCALE, 1.06);
  assert.equal(O.hoverScale({ x: 50, y: 50 }, box), 1.06);
  assert.equal(O.hoverScale({ x: 5, y: 50 }, box), 1);
  assert.equal(O.hoverScale({ x: 50, y: 50 }, box, { reduced: true }), 1);
  assert.equal(O.hoverScale({ x: 50, y: 50 }, box, { dragging: true }), 1);
  assert.equal(O.hoverScale(null, box), 1);
  assert.doesNotMatch(islandSrc.slice(islandSrc.indexOf('function updateHover'), islandSrc.indexOf("window.addEventListener('pointermove'")), /setState|applyPose|dispatchEvent/);
});

test('§9.2 motion table in CSS: view enter spring after 160ms delay, exit 160ms ease-in, control 300ms, focus 120ms; only transform/opacity; reduced jumps', () => {
  const root = css.slice(css.indexOf(':root'), css.indexOf('}', css.indexOf(':root')));
  for (const [name, value] of [['--dur-view-delay', '160ms'], ['--dur-view-in', '400ms'], ['--dur-view-out', '160ms'], ['--dur-control', '300ms'], ['--dur-focus', '120ms']]) {
    assert.match(root, new RegExp(`${name}:\\s*${value}`), name);
  }
  assert.match(root, /--ease-in: cubic-bezier\(\.4, 0, 1, 1\)/);
  for (const sel of ['#capsule[data-phase="expanded"][data-view="chat"] #chat', '#capsule[data-phase="expanded"][data-view="overview"] #open-chat', '#capsule[data-phase="expanded"] #permission', '#capsule[data-phase="expanded"] #notices']) {
    const rule = new RegExp(sel.replace(/[[\]().*+?^${}|\\]/g, '\\$&') + ' \\{([^}]*)\\}').exec(css);
    assert.ok(rule, sel);
    assert.match(rule[1], /var\(--dur-view-delay\)/, `${sel} delays 160ms`);
    assert.match(rule[1], /transform var\(--dur-view-in\) var\(--spring\)/, sel);
  }
  // exit: the hidden state of every view uses the 160ms ease-in (and keeps visibility until it ends)
  assert.equal((css.match(/transition: opacity var\(--dur-view-out\) var\(--ease-in\), transform var\(--dur-view-out\) var\(--ease-in\), visibility 0s linear var\(--dur-view-out\)/g) || []).length >= 4, true);
  // nothing animates width/height/left/top in these transitions
  // (S10: the dictation pill's own capsule grows in width/height like Coucou's pill; it is a 34px element inside the header, not a view)
  for (const m of css.replace(/\.dcapsule \{[^}]*\}/, '').matchAll(/transition:([^;]*);/g)) assert.doesNotMatch(m[1], /\b(width|height|left|top|right|bottom|margin|padding)\b/, m[1]);
  assert.match(css, /#clay \{[^}]*scale\(var\(--hover, 1\)\)[^}]*transition: transform var\(--dur-state\)/);
  assert.match(css, /:where\(button, textarea\) \{[^}]*outline: 2px solid transparent[^}]*var\(--dur-focus\)/);
  assert.match(css, /#models-list \.choose\[aria-pressed="true"\] \.ico \{ animation: control-pop var\(--dur-control\) var\(--spring\)/);
  const reduced = [...css.matchAll(/html\[data-motion="reduce"\][^{]*\{[^}]*\}/g)].map(m => m[0]).join('\n');
  assert.match(reduced, /html\[data-motion="reduce"\] #notices, html\[data-motion="reduce"\] #permission, html\[data-motion="reduce"\] #open-chat, html\[data-motion="reduce"\] #chat, html\[data-motion="reduce"\] #models, html\[data-motion="reduce"\] #chat-body, html\[data-motion="reduce"\] #question \{ transition: none !important; transform: none !important/);
  assert.match(reduced, /html\[data-motion="reduce"\] #clay \{ transition: none !important/);
});

test('#439 viewPhase latches the settled phase: the overshoot dip never toggles the attribute back mid-animation', () => {
  assert.equal(typeof O.viewPhase, 'function');
  // The island-side bookkeeping under test: per frame, `landed` is the settled
  // phase the animation reached (null otherwise), the latch survives while the
  // animation runs and resets with it. viewPhase must never regress the phase.
  const landed = (p, target) => {
    if (target === 1 && p >= 1) return 'expanded';
    if (target === 0 && p <= 0) return 'compact';
    return null;
  };
  const simulate = frames => {
    let settled = null;
    return frames.map(([p, mode, target]) => {
      const hit = landed(p, target);
      if (mode === 'idle') settled = null;
      else if (hit) settled = hit;
      return O.viewPhase(p, target, mode, settled);
    });
  };
  // grow with overshoot: expanding until the spring first reaches 1, then
  // expanded for good — never expanding again while the spring oscillates.
  assert.deepEqual(simulate([[0.3, 'spring', 1], [0.99, 'spring', 1], [1.02, 'spring', 1],
    [0.97, 'spring', 1], [1.001, 'spring', 1], [1, 'idle', 1]]),
    ['expanding', 'expanding', 'expanded', 'expanded', 'expanded', 'expanded']);
  // shrink with a bounce near 0: collapsing until it lands, then compact —
  // the bounce never turns the attribute back to collapsing.
  assert.deepEqual(simulate([[1, 'shrink', 0], [0.5, 'shrink', 0], [0.02, 'shrink', 0],
    [0, 'shrink', 0], [-0.01, 'shrink', 0], [0.03, 'shrink', 0], [0, 'idle', 0]]),
    ['expanded', 'collapsing', 'collapsing', 'compact', 'compact', 'compact', 'compact']);
  // interrupted: collapse mid-expand. setPhase resets the latch, so the old
  // settled phase never outlives its animation and the shrink reaches compact.
  assert.deepEqual(simulate([[0.9, 'spring', 1], [1.02, 'spring', 1], [0.97, 'shrink', 0],
    [0, 'shrink', 0], [0.02, 'shrink', 0], [0, 'idle', 0]]),
    ['expanding', 'expanded', 'collapsing', 'compact', 'compact', 'compact']);
  // with no animation state the helper stays the plain computed value
  assert.equal(O.viewPhase(0.5, 1, 'idle', null), 'expanding');
  assert.equal(O.viewPhase(1, 0, 'idle', null), 'expanded');
  assert.equal(O.viewPhase(0, 0, 'idle', null), 'compact');
  // island.js delegates the phase write to the helper and never re-writes the
  // same dataset value (a repeated write re-fires every capsule observer); a new
  // setPhase resets the latch so an interrupted animation cannot inherit it
  assert.match(islandSrc, /O\.viewPhase\(p, target, mode, settledPhase\)/);
  assert.match(islandSrc, /if \(capsule\.dataset\.phase !== phase\)/);
  assert.match(islandSrc, /settledPhase = null; \/\/ a new transition never inherits the previous latch/);
});

test('§5 chat header: R6 ~40px VISIBLE (box x 112/128 within 4px) and inside the header', () => {
  const [box, left, top] = /CHAT = \{[^}]*clay: (\d+), clayLeft: (\d+), clayTop: (\d+)/.exec(islandSrc).slice(1).map(Number);
  const vb = /OVERVIEW_VB = \[(\d+), (\d+), (\d+), (\d+)\]/.exec(islandSrc).slice(1).map(Number);
  const visible = box * 112 / vb[2];
  assert.ok(Math.abs(visible - 40) <= 4, `visible ${visible}`);
  assert.ok(left - box / 2 >= 4 && top >= 2 && top + box <= 56, 'box inside the 48-56px header band');
  assert.match(islandSrc, /const z = 1; \/\/ tight framing in the dot, the overview AND the chat/);
});

test('night review: the bridge is shown (chip «Sin puente», compact triangle) and the host error face is time-boxed', () => {
  const snap = (state, card) => ({ unavailable: false, bridgeStatus: { state }, card: card || null });
  const view = O.bridgeView(snap('unhealthy'));
  assert.equal(view.word, 'Sin puente'); assert.equal(view.icon, 'triangle'); assert.equal(view.tone, 'red');
  assert.equal(O.bridgeView(snap('stopped')).word, 'Sin puente');
  for (const ok of ['healthy', 'starting', 'disabled']) assert.equal(O.bridgeView(snap(ok)), null, ok);
  assert.match(islandSrc, /bridge-word/); assert.match(islandSrc, /card-bridge/); assert.match(islandSrc, /bridgeDown/);
  // time box: error face only ~7s after the failure BEGINS (or while a card depends on the bridge)
  const T0 = 1000000;
  let r = O.hostPoseView(snap('unhealthy'), null, T0);
  assert.equal(r.pose, 'error');
  r = O.hostPoseView(snap('unhealthy'), r.tracker, T0 + 6900); assert.equal(r.pose, 'error');
  r = O.hostPoseView(snap('unhealthy'), r.tracker, T0 + 7100); assert.equal(r.pose, null, 'calms down after the box');
  assert.equal(r.tracker.since, T0, 'the clock started at the first failure, not at every snapshot');
  r = O.hostPoseView(snap('unhealthy', { state: 'pending' }), r.tracker, T0 + 60000); assert.equal(r.pose, 'error', 'a card that depends on the bridge keeps the face');
  r = O.hostPoseView(snap('healthy'), r.tracker, T0 + 61000); assert.equal(r.pose, null); assert.equal(r.tracker.failing, false);
  r = O.hostPoseView(snap('unhealthy'), r.tracker, T0 + 70000); assert.equal(r.pose, 'error', 'a NEW failure restarts the box');
  // priority: the local chat wins over the bridge
  assert.equal(O.choosePose('think', 'error'), 'think');
  assert.equal(O.choosePose('speak', 'error'), 'speak');
  assert.equal(O.choosePose('error', null), 'error');
  assert.equal(O.choosePose(null, 'error'), 'error');
  assert.equal(O.choosePose(null, null), 'idle');
});

test('night review: views are NOT display:none while animating (inert instead), so the §9.2 motion actually runs', () => {
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  assert.match(html, /<section id="chat" inert/); assert.doesNotMatch(html, /<section id="chat"[^>]*\shidden/);
  assert.match(html, /<div id="models" inert/); assert.doesNotMatch(html, /<div id="models"[^>]*\shidden/);
  const chatSrc = fs.readFileSync(path.join(frontend, 'chat.js'), 'utf8');
  const modelsSrc = fs.readFileSync(path.join(frontend, 'models.js'), 'utf8');
  assert.doesNotMatch(chatSrc, /\bchat\.hidden\s*=/);
  assert.doesNotMatch(modelsSrc, /panel\.hidden\s*=/);
  assert.match(chatSrc, /chat\.inert = false/); assert.match(chatSrc, /chat\.inert = true; \}, 220\)/);
  assert.match(css, /#models\[data-open="true"\] \{[^}]*var\(--dur-view-delay\)/);
  assert.doesNotMatch(css, /#models\[hidden\]/);
  assert.doesNotMatch(css, /#capsule\[data-models="open"\] #chat-body \{ display: none/);
});

test('N8 vertical chat entrance: the chat (and its models panel) travel along the docked edge, with the contract timing, no display:none', () => {
  const root = css.slice(css.indexOf(':root'), css.indexOf('}', css.indexOf(':root')));
  // a variable distance, a direction per docked edge
  assert.match(root, /--view-shift:\s*16px/);
  assert.match(css, /#capsule\[data-edge="top"\]\s*\{[^}]*--view-dir:\s*-1/);
  assert.match(css, /#capsule\[data-edge="bottom"\]\s*\{[^}]*--view-dir:\s*1/);
  for (const sel of ['#chat', '#models']) {
    const rule = new RegExp(`\\n${sel} \\{([^}]*)\\}`).exec(css);
    assert.ok(rule, sel);
    assert.match(rule[1], /transform: translateY\(calc\(var\(--view-dir\) \* var\(--view-shift\)\)\)/, `${sel} starts displaced along the edge`);
    assert.match(rule[1], /opacity: 0/); assert.match(rule[1], /visibility: hidden/);
    assert.doesNotMatch(rule[1], /display:\s*none/);
  }
  // enter keeps the §9.2 timing: 160ms delay + 400ms spring on transform
  assert.match(css, /data-view="chat"\] #chat \{[^}]*transform var\(--dur-view-in\) var\(--spring\) var\(--dur-view-delay\)/);
  // the old 6px nudge no longer drives the chat/models
  const chatRule = /\n#chat \{([^}]*)\}/.exec(css)[1];
  assert.doesNotMatch(chatRule, /translateY\(6px\)/);
  // reduced motion still jumps
  assert.match(css, /html\[data-motion="reduce"\] #chat, html\[data-motion="reduce"\] #models/);
});

test('#304 motionState: Abito animates ALWAYS by default; the system preference counts only when the human opted to honor it', () => {
  // the human's real session: the system (via GTK/WebKit) says «reduced», Abito must still move
  assert.equal(O.motionState({ systemReduced: true, honorSystem: false }), 'full');
  assert.equal(O.motionState({ systemReduced: false, honorSystem: false }), 'full');
  assert.equal(O.motionState({ systemReduced: true, honorSystem: true }), 'reduce');
  assert.equal(O.motionState({ systemReduced: false, honorSystem: true }), 'full');
  // missing facade / snapshot / junk: the DEFAULT is full, never inherited
  assert.equal(O.motionState({ systemReduced: true }), 'full');
  assert.equal(O.motionState({}), 'full');
  assert.equal(O.motionState(null), 'full');
  // the snapshot field: motionOverride true (the new default) = do NOT honor the system
  assert.equal(O.honorSystemMotion({ motionOverride: true }), false);
  assert.equal(O.honorSystemMotion({ motionOverride: false }), true);
  assert.equal(O.honorSystemMotion(null), false, 'no snapshot yet: animate');
  assert.equal(O.honorSystemMotion({}), false);
});

test('#304 wiring: the page decides motion itself (data-motion on <html>), starts in «full», forces the engine, no inherited media query in JS decisions', () => {
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  assert.match(html, /<html lang="es" data-motion="full">/);
  assert.match(islandSrc, /let honorSystem = false;/);
  assert.match(islandSrc, /AbitoOverview\.motionState\(\{ systemReduced: reduced\.matches, honorSystem \}\)/);
  assert.match(islandSrc, /document\.documentElement\.dataset\.motion = /);
  // every snap/animate decision goes through the single motion state
  assert.doesNotMatch(islandSrc, /reduced\.matches && !forceMotion/);
  assert.match(islandSrc, /motionReduced\(\)/);
  // the frozen engine is forced from the first frame unless the human honors the system
  assert.match(islandSrc, /AbitoClay\.setForced\(!honorSystem\)/);
});

test('L34 Coucou\'s bar: the collapsed island is 288x32 with corners 0 0 14 14 inside the fixed native window', () => {
  const geo = fs.readFileSync(path.join(__dirname, '..', 'src', 'geometry.rs'), 'utf8');
  assert.match(geo, /pub const COMPACT_BAR: \(i32, i32\) = \(288, 32\);/);
  assert.match(geo, /pub const ISLAND_WINDOW: \(i32, i32\) = \(752, 340\);/);
  assert.doesNotMatch(geo, /pub const DOT_DIAMETER/, 'the disc is gone');
  const m = /const COMPACT = \{ w: (\d+), h: (\d+), r: (\d+), gap: (\d+), clay: (\d+), clayX: (\d+), drop: (\d+) \}/.exec(islandSrc);
  assert.ok(m, 'COMPACT constant');
  const [w, h, r, gap, clay, clayX] = m.slice(1, 7).map(Number);
  assert.deepEqual([w, h, r, gap], [288, 32, 16, 0], 'S29: the compact pill is a Sileo-family pill (r16), flush to the top edge (human: «pegada»)');
  assert.equal(clayX, 40, 'Coucou botPosition(compact): cx 40');
  const vbx = /OVERVIEW_VB = \[(\d+), (\d+), (\d+), (\d+)\]/.exec(islandSrc).slice(1).map(Number);
  const visible = clay * 112 / vbx[2];
  assert.ok(Math.abs(visible - 20) <= 1, `the visible character (${visible.toFixed(1)}px) is Coucou's 20px bot`);
  assert.ok(clayX - clay / 2 >= 0 && clay <= h, 'the character box sits inside the bar');
  // HU-057: the corner expression changed (rTop/rBottom now lerp separately: square top, rounded bottom); the corner contract is asserted on the
  // rendered island (compact r16 below / expanded r26 below, square top) in the browser block at the end of this file.
});

test('L34 the bar keeps the badge/contour vocabulary: the sun badge rides the character, the contour is inside the bar (no window margin to draw outside)', () => {
  const flag = /#compact-flag \{([^}]*)\}/.exec(css)[1];
  const left = Number(/left:\s*(\d+)px/.exec(flag)[1]), top = Number(/top:\s*(\d+)px/.exec(flag)[1]), size = Number(/width:\s*(\d+)px/.exec(flag)[1]);
  const cx = left + size / 2, cy = top + size / 2;
  assert.ok(Math.abs(cx - 47) <= 1.5 && Math.abs(cy - 8) <= 1.5, `badge centre (${cx}, ${cy}) rides the top-right of the character (47, 8)`);
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  const chat = html.indexOf('id="chat-live"'); // last element inside #island
  assert.ok(html.indexOf('id="compact-flag"') > chat, 'the badge is after the last #island child');
  assert.match(html.slice(chat, html.indexOf('id="compact-flag"')), /<\/section>\s*<\/div>/, '#island closes before the badge');
  assert.match(css, /#capsule\[data-card-tone="sun"\] #island \{ box-shadow: inset 0 0 0 2px var\(--sun\)/);
  const isl = fs.readFileSync(path.join(frontend, 'vendor/coucou/island/island.css'), 'utf8');
  assert.match(isl, /\[data-dictation\] #island \{ box-shadow: inset 0 0 0 2px/, 'the dictation ring is inset: the window has no margin');
});

test('L34 mini grid: up to four small characters on the bar, 13px cells 3px apart at x233.5 (Coucou #mini-grid), shown only while collapsed', () => {
  const isl = fs.readFileSync(path.join(frontend, 'vendor/coucou/island/island.css'), 'utf8');
  assert.match(isl, /#mini-grid \{[^}]*left: 233\.5px; top: 1\.5px; width: 29px; height: 29px;[^}]*grid-template-columns: 13px 13px; grid-auto-rows: 13px; gap: 3px;/);
  assert.match(isl, /#capsule\[data-phase="compact"\] #mini-grid\[data-count\]:not\(\[data-count="0"\]\) \{ display: grid; \}/);
  const t = fs.readFileSync(path.join(frontend, 'sessions-ticker.js'), 'utf8');
  assert.match(t, /rows = all\.slice\(0, 3\)/); assert.match(t, /AbitoClay\.create\(svg/);
  assert.match(fs.readFileSync(path.join(frontend, 'index.html'), 'utf8'), /<div id="mini-grid" aria-hidden="true"><\/div>/);
});

test('fixed-window gestures retain click reporting and character pick-up without frontend docking policy', () => {
  assert.doesNotMatch(islandSrc, /snap_to_edge|nearest_vertical_edge|anchor_toggle/);
  assert.match(islandSrc, /send\('drag_press'/); assert.match(islandSrc, /send\('drag_release'/);
  // HU-057: the borderRadius source line is now `${rTopUsed}… ${rBottom}…`; «square top corners, rounded bottom» is asserted on the rendered island
  // (browser block at the end of this file), compact and expanded.
});

test('CSS structure: braces balance (no stray «}» swallowing the next rule) and every critical top-level rule exists', () => {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let depth = 0;
  for (let i = 0; i < plain.length; i += 1) {
    if (plain[i] === '{') depth += 1;
    else if (plain[i] === '}') { depth -= 1; assert.ok(depth >= 0, `stray «}» near line ${plain.slice(0, i).split('\n').length} (comment-stripped)`); }
  }
  assert.equal(depth, 0, 'unclosed «{»');
  // a real parse of the top-level rule list: the rule right after a stray brace is the one that dies
  const top = []; let d = 0, start = 0;
  for (let i = 0; i < plain.length; i += 1) {
    if (plain[i] === '{') { if (d === 0) top.push(plain.slice(start, i).trim()); d += 1; }
    else if (plain[i] === '}') { d -= 1; if (d === 0) start = i + 1; }
  }
  for (const sel of ['.sr-only', '#clay', '#island', '#compact-flag', '#open-chat', '#chat', '#models', '#question']) assert.ok(top.includes(sel), `top-level rule ${sel} must exist; got ${top.length} rules`);
  assert.ok(top.some(t => t.startsWith('html[data-motion="reduce"] #notices')), 'the reduced-motion rules are top-level rules');
});

test('the window is BORN at ISLAND_WINDOW, independent of the visible compact bar', () => {
  let conf;
  try {
    conf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tauri.conf.json'), 'utf8')).app.windows[0];
  } catch (error) {
    assert.fail(`tauri.conf.json unreadable: ${error}`);
  }
  const geo = fs.readFileSync(path.join(__dirname, '..', 'src', 'geometry.rs'), 'utf8');
  const fixed = /pub const ISLAND_WINDOW: \(i32, i32\) = \((\d+), (\d+)\);/.exec(geo).slice(1).map(Number);
  assert.deepEqual([conf.width, conf.height], fixed);
  assert.deepEqual([conf.width, conf.height], [752, 340]);
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /All sizes land exactly 304x44/, 'README must not document the old compact size as the contract');
});

test('#305 hotkey feedback: a taken/unsupported/invalid grab is VISIBLE (icon + one word), active is silent, Wayland says «limitado»', () => {
  const v = (status, extra = {}) => ({ combo: 'Ctrl+Alt+A', enabled: true, status, limited: false, ...extra });
  assert.equal(O.hotkeyView(v('active')), null, 'a working shortcut shows nothing');
  assert.equal(O.hotkeyView(v('disabled', { enabled: false })), null, 'a shortcut the human turned off is not a problem');
  const taken = O.hotkeyView(v('taken'));
  assert.deepEqual([taken.word, taken.icon, taken.tone], ['Atajo ocupado', 'triangle', 'red']);
  assert.match(taken.aria, /Ctrl\+Alt\+A/); assert.match(taken.aria, /otra aplicación/);
  assert.equal(O.hotkeyView(v('unsupported')).word, 'Atajo sin soporte');
  assert.equal(O.hotkeyView(v('invalid')).word, 'Atajo inválido');
  const limited = O.hotkeyView(v('active', { limited: true }));
  assert.deepEqual([limited.word, limited.tone], ['Atajo limitado', 'faint']);
  assert.match(limited.aria, /ventana de X11/);
  assert.equal(O.hotkeyView(null), null); assert.equal(O.hotkeyView({}), null); assert.equal(O.hotkeyView(v('nope')), null);
  // honesty: a problem is never hidden behind «limited»
  assert.equal(O.hotkeyView(v('taken', { limited: true })).word, 'Atajo ocupado');
});

test('U3a win32 hotkey feedback: «Atajo sin soporte» says so WITHOUT the X11 excuse; taken stays «otra aplicación»; a working grab is silent', () => {
  const wv = (status, extra = {}) => ({ combo: 'Ctrl+Alt+A', enabled: true, status, limited: false, backend: 'win32', portal_note: null, ...extra });
  const unsup = O.hotkeyView(wv('unsupported'));
  assert.equal(unsup.word, 'Atajo sin soporte');
  assert.doesNotMatch(unsup.aria, /X11/, 'there is no X server on Windows; blaming one is the lie U3a kills');
  assert.match(unsup.aria, /no se pudo registrar/);
  const taken = O.hotkeyView(wv('taken'));
  assert.equal(taken.word, 'Atajo ocupado'); assert.match(taken.aria, /otra aplicación/);
  const mac = O.hotkeyView(wv('unsupported', { backend: 'macos' }));
  assert.equal(mac.word, 'Atajo sin soporte'); assert.doesNotMatch(mac.aria, /X11/, 'no X server on macOS either');
  assert.equal(O.hotkeyView(wv('active', { backend: 'macos' })), null);
  assert.equal(O.hotkeyView(wv('active')), null, 'a real Win32 grab that works says nothing');
  assert.equal(O.hotkeyView(wv('disabled')), null);
});

test('#305 wiring: the island listens to hotkey:state and paints the chip; the page never grabs or answers anything', () => {
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  assert.match(html, /id="hotkey" class="chip" role="img" hidden/);
  assert.match(islandSrc, /listen\('hotkey:state'/);
  assert.match(islandSrc, /hotkey_action', \{ payload: \{ action: 'view' \} \}/);
  assert.doesNotMatch(islandSrc, /hotkey_action', \{ payload: \{ action: '(set|enable|disable|reset)'/, 'the island only READS the status; changing it belongs to the settings panel (#308)');
});

test('#305b hotkey feedback: the OS permission dialog is explained (accept once), a decline is visible, and the portal route is never «limited»', () => {
  const v = (status, extra = {}) => ({ combo: 'Ctrl+Alt+A', enabled: true, status, limited: false, backend: 'portal', ...extra });
  const pending = O.hotkeyView(v('permission_pending'));
  assert.deepEqual([pending.word, pending.icon, pending.tone], ['Aceptá el permiso', 'info', 'sun']);
  assert.match(pending.aria, /sistema/); assert.match(pending.aria, /una sola vez/); assert.match(pending.aria, /Ctrl\+Alt\+A/);
  const denied = O.hotkeyView(v('permission_denied'));
  assert.deepEqual([denied.word, denied.icon, denied.tone], ['Atajo sin permiso', 'triangle', 'red']);
  assert.match(denied.aria, /rechazaste|rechazó|no diste/i);
  // T7.3 design diet: the long disclaimer sentence is gone; the meaning stays
  // short and honest (the decline fact + the X11 fallback, one clause each).
  assert.doesNotMatch(denied.aria, /no se activó porque/);
  // the portal route working = silence (never «limitado»); the X11 fallback on Wayland = limited
  assert.equal(O.hotkeyView(v('active', { backend: 'portal', limited: false })), null);
  assert.equal(O.hotkeyView(v('active', { backend: 'x11', limited: true })).word, 'Atajo limitado');
  assert.match(O.hotkeyView(v('active', { backend: 'x11', limited: true })).aria, /ventana de X11/);
  // a permission prompt for a shortcut the human turned off is not shown
  assert.equal(O.hotkeyView(v('permission_pending', { enabled: false })), null);
});

test('#305b the reason the portal was dropped stays visible after the X11 fallback took over (not a 400 ms flash)', () => {
  const v = (extra) => ({ combo: 'Ctrl+Alt+A', enabled: true, status: 'active', limited: true, backend: 'x11', portal_note: null, ...extra });
  const declined = O.hotkeyView(v({ portal_note: 'permission_denied' }));
  assert.equal(declined.word, 'Atajo limitado'); assert.equal(declined.tone, 'faint');
  assert.match(declined.aria, /rechazaste el permiso/i); assert.match(declined.aria, /ventana de X11/);
  const failed = O.hotkeyView(v({ portal_note: 'unsupported' }));
  assert.match(failed.aria, /portal del sistema no respondió|no pudo/);
  // no note = the plain limited message; a working X11 session with a note still explains it
  assert.doesNotMatch(O.hotkeyView(v()).aria, /rechazaste/);
  assert.equal(O.hotkeyView(v({ limited: false, portal_note: 'permission_denied' })).word, 'Atajo sin permiso', 'on a full X11 session the decline is the only thing worth saying');
});

test('#423 the notice title keeps a readable width in the 228px band (measured 15px in Chromium before the fix)', () => {
  // Measured in Chromium (verify/notice-band-before.png): band 228, padding 8+8, classic scrollbar 15,
  // pill margin-right 48 (clears the «i»), dismiss 44, border 2, ring 28 => «Avisos caídos» (87px of text)
  // was squeezed into a 15px box. The contract models the same budget from the declared boxes.
  const band = 'body #capsule:not([data-notice-view="notices"]) #notices';
  const n = decls(band);
  assert.equal(n['scrollbar-width'], 'none', 'the band scrolls by wheel/keys but never spends 15px on a scrollbar track');
  const open = decls('body #capsule:not([data-notice-view="notices"]) #notice-open');
  const pad = px(open['padding-inline']), gap = px(open.gap);
  assert.ok(pad >= 0 && gap >= 0, 'band-scoped padding-inline and gap are declared');
  const RING = 28; // measured box of #notice-ring (svg min-content)
  const avail = 228 - 16 - px(decls('#notice-pill')['margin-right']) - 2 - px(decls('#notice-dismiss').flex.split(' ')[2]);
  const title = avail - 2 * pad - RING - gap; // #437: the design drops the count badge — the title says «N avisos» itself
  assert.ok(title >= 64, `title box ${title}px must show most of «Avisos caídos» (87px at 14px; was 15px); the full text stays in the aria name and the «i» detail`);
  assert.doesNotMatch(css, /#notice-count/, 'the design band has no count badge to hide');
  assert.match(islandSrc, /noticesEl\.dataset\.count\s*=/, 'renderNotices still publishes the notice count for the aria/CSS');
});

test('Sin motor is actionable: the down view carries a real action (open Conexiones); connected/unavailable carry none', () => {
  const down = O.connectionView({ unavailable: false, connections: 0 });
  assert.deepEqual(down.action, { target: 'accounts:agentes', label: 'Abrir Ajustes' });
  assert.match(down.actionAria, /Sin motor.*Ajustes/);
  assert.equal(O.connectionView({ connections: 1 }).action, undefined);
  assert.equal(O.connectionView({ unavailable: true, connections: 0 }).action, undefined);
});

test('Pi status row (Coucou idle card): one short line + one link per real failing state, deep-linking to Pi\'s section; none when Pi works', () => {
  const down = O.connectionView({ connections: 0 }), up = O.connectionView({ connections: 1 });
  const acct = [{ configured: true, local: false }];
  // not connected (existing): the Agentes row
  assert.deepEqual(O.engineRowView(down), { kind: 'down', label: 'Sin motor', link: 'Conectar', target: 'accounts:agentes', aria: 'Conectar Pi: abrir Ajustes → Agentes' });
  assert.deepEqual(O.engineRowView(down, { connection: 'connected', accounts: acct, sessions: 'ready' }).kind, 'down');
  // engine failures the agent state really reports -> the Motor card (Reiniciar)
  for (const [connection, label] of [['lost', 'Motor caído'], ['refused', 'Motor no responde'], ['bad_session', 'Sesión no válida'], ['no_daemon', 'Sin motor']]) {
    const r = O.engineRowView(up, { connection, accounts: null, sessions: 'error' });
    assert.deepEqual([r.kind, r.label, r.link, r.target], ['engine', label, 'Revisar', 'accounts:motor'], connection);
  }
  // engine up but no account/key configured (and none local) -> Proveedores
  const none = O.engineRowView(up, { connection: 'connected', accounts: [{ configured: false, local: false }], sessions: 'ready' });
  assert.deepEqual([none.kind, none.label, none.link, none.target], ['account', 'Sin cuenta', 'Configurar', 'accounts:proveedores']);
  assert.equal(O.engineRowView(up, { connection: 'connected', accounts: [{ configured: false, local: true }], sessions: 'ready' }), null, 'a local account is enough');
  assert.equal(O.engineRowView(up, { connection: 'connected', accounts: [], sessions: 'ready' }).kind, 'account', 'no accounts at all');
  // the session list failed while the engine is up
  const sess = O.engineRowView(up, { connection: 'connected', accounts: acct, sessions: 'error' });
  assert.deepEqual([sess.kind, sess.label, sess.link, sess.target], ['sessions', 'Sesiones no disponibles', 'Revisar', 'accounts:motor']);
  // Pi works / unknown: no link, nothing invented
  assert.equal(O.engineRowView(up, { connection: 'connected', accounts: acct, sessions: 'ready' }), null);
  assert.equal(O.engineRowView(up, { connection: 'connected', accounts: acct, sessions: 'pending' }), null);
  assert.equal(O.engineRowView(up, { connection: 'connecting', accounts: null, sessions: 'pending' }), null);
  assert.equal(O.engineRowView(up, { connection: 'connected', accounts: null, sessions: 'ready' }), null, 'accounts unknown is not «sin cuenta»');
  assert.equal(O.engineRowView(up), null);
  assert.equal(O.engineRowView(O.connectionView({ unavailable: true, connections: 0 }), { connection: 'lost' }), null, 'notice channel down is not a Pi problem');
  assert.equal(O.engineRowView(null), null);
});

console.log(`overview-view-check: ${passed} passed`);

test('T7.3 approval card markup: «Espera tu respuesta» caption, fold inside the action row, command strip', () => {
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  const perm = html.slice(html.indexOf('<div id="permission"'), html.indexOf('<div id="question"'));
  const actions = perm.slice(perm.indexOf('id="card-actions"'));
  assert.match(actions, /id="allow"[\s\S]*id="deny"[\s\S]*id="card-fold"[\s\S]*id="card-wait"[^>]*>Espera tu respuesta</, 'Permitir, Rechazar, fold, caption in design order');
  assert.doesNotMatch(perm, /Denegar/);
  const css = fs.readFileSync(path.join(frontend, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '') + fs.readFileSync(path.join(frontend, 'vendor/coucou/island/island.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /#permission #operation \{[^}]*background: rgba\(255, 255, 255, 0\.07\)/, 'the command sits in Coucou\'s .code well');
  assert.match(css, /#card-wait \{[^}]*font: 400 11px var\(--font\)/, 'caption is Coucou\'s 11 px');
  assert.match(fs.readFileSync(path.join(frontend, 'island.js'), 'utf8'), /card-wait/, 'island.js shows the caption only while the human may decide');
});

// HU-057 — the plain overview contract measured on the REAL island (real CSS + JS, headless Chromium via the shared harness), replacing the old
// source-regex pin of OVERVIEW clayX 68 / cy 113: Nusa notch 720x150, square top / r26 bottom, Koda (64px, the only character) in the right column
// and fully inside the notch. Fails if any of that regresses. SKIPPED loudly (never a silent pass) when Playwright is absent.
(async () => {
  const H = require('./island-geometry-harness.cjs');
  if (!H.findPlaywright()) { console.log('SKIPPED overview-view-check (HU-057 real-layout block): no playwright — NOT a pass'); return; }
  const ui = await H.open({ quick: true, sessions: [] });
  try {
    const [isl] = await ui.measure('#island');
    const radii = await ui.page.evaluate(() => { const c = getComputedStyle(document.getElementById('island')); return [c.borderTopLeftRadius, c.borderTopRightRadius, c.borderBottomRightRadius, c.borderBottomLeftRadius].map(parseFloat); });
    assert.deepEqual([Math.round(isl.w), Math.round(isl.h)], [720, 150], 'HU-057 plain overview is the 720x150 Nusa notch');
    assert.deepEqual(radii, [0, 0, 26, 26], 'HU-057 notch: square top, r26 bottom');
    // the same corner contract on the compact pill (hangs from the top edge: square top, r16 below = COMPACT.r)
    await ui.page.evaluate(() => window.__islandSetState('compact')); await ui.page.waitForTimeout(1500);
    const compactRadii = await ui.page.evaluate(() => { const c = getComputedStyle(document.getElementById('island')); return [c.borderTopLeftRadius, c.borderTopRightRadius, c.borderBottomRightRadius, c.borderBottomLeftRadius].map(parseFloat); });
    assert.deepEqual(compactRadii, [0, 0, 16, 16], 'compact pill: square top, r16 below');
    await ui.page.evaluate(() => window.__islandSetState('overview')); await ui.page.waitForTimeout(1500);
    const kodas = (await ui.measure('.koda-sprite')).filter(b => b.shown);
    assert.equal(kodas.length, 1, 'only Koda is drawn in the plain overview: ' + JSON.stringify(kodas));
    const k = kodas[0], relX = k.left - isl.left, relY = k.top - isl.top;
    assert.deepEqual([Math.round(k.w), Math.round(k.h)], [64, 64], 'Koda is 64px (OVERVIEW.clay)');
    assert.ok(Math.abs(relX - 598) <= 2, 'Koda column: box left 598 from the island edge, measured ' + relX);
    assert.ok(Math.abs(relY - 49) <= 2, 'Koda sits in the notch body (box top ~49), measured ' + relY);
    assert.ok(relX + k.w <= isl.w - 20 && relY + k.h <= isl.h - 20, 'Koda keeps >=20px of air to the right/bottom edge of the notch');
  } finally { await ui.close(); }
  console.log('overview-view-check (HU-057 real layout): ok');
})().catch(e => { console.error('FAIL', e.stack); process.exit(1); });
