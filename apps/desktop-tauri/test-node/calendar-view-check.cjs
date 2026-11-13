'use strict';
/* K2-11 S2/S3/S6 — the calendar card of the island's shortcuts row (design/k2-09-atajos/08-isla-unida.html F5):
   `calendar_action {action:'refresh'}` → today's and tomorrow's events in the USER's zone, with their time, and
   NOTHING when the calendar is not configured (criterion 3: never a sample event).
   The window filter and the time zone work are pure, so the two zones that matter are checked in a child process
   with TZ pinned: America/Argentina/Buenos_Aires (UTC-3) and UTC.
   Run: node apps/desktop-tauri/test-node/calendar-view-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const frontend = path.join(__dirname, '..', 'frontend');
const SELF = __filename;

// ── the answer shape src/calendar.rs serialises ────────────────────────────────────────────────────────────────
const ev = (o = {}) => ({ title: 'Daily del equipo', location: null, allDay: false,
  start: { date: '2026-05-12', time: '14:30:00', tz: 'UTC' }, end: { date: '2026-05-12', time: '15:00:00', tz: 'UTC' }, ...o });
const answer = (events, extra = {}) => ({ available: true, events, fetchedAt: Date.UTC(2026, 4, 12, 15, 0), ...extra });
const NOW = Date.UTC(2026, 4, 12, 15, 0); // 12 May 2026 15:00 UTC

/** The fixture every zone reads: mixing UTC, TZID, floating, all-day and out-of-window events. */
const FIXTURE = () => answer([
  ev({ title: 'UTC hoy', start: { date: '2026-05-12', time: '14:30:00', tz: 'UTC' }, end: { date: '2026-05-12', time: '15:00:00', tz: 'UTC' } }),
  ev({ title: 'UTC que cae hoy en local', start: { date: '2026-05-13', time: '02:00:00', tz: 'UTC' }, end: { date: '2026-05-13', time: '03:00:00', tz: 'UTC' } }),
  ev({ title: 'UTC de ayer en local', start: { date: '2026-05-12', time: '01:00:00', tz: 'UTC' }, end: { date: '2026-05-12', time: '02:00:00', tz: 'UTC' } }),
  ev({ title: 'Flotante mañana', location: 'Oficina', start: { date: '2026-05-13', time: '09:00:00', tz: null }, end: { date: '2026-05-13', time: '09:30:00', tz: null } }),
  ev({ title: 'Con zona escrita', start: { date: '2026-05-12', time: '18:00:00', tz: 'Europe/Madrid' }, end: { date: '2026-05-12', time: '19:00:00', tz: 'Europe/Madrid' } }),
  ev({ title: 'Zona desconocida', start: { date: '2026-05-12', time: '20:00:00', tz: 'Mars/Olympus' }, end: { date: '2026-05-12', time: '21:00:00', tz: 'Mars/Olympus' } }),
  ev({ title: 'Feriado', allDay: true, start: { date: '2026-05-12', time: null, tz: null }, end: { date: '2026-05-13', time: null, tz: null } }),
  ev({ title: 'Todo el día mañana', allDay: true, start: { date: '2026-05-13', time: null, tz: null }, end: { date: '2026-05-14', time: null, tz: null } }),
  ev({ title: 'La semana que viene', start: { date: '2026-05-15', time: '10:00:00', tz: 'UTC' }, end: { date: '2026-05-15', time: '11:00:00', tz: 'UTC' } }),
  ev({ title: 'La semana pasada', start: { date: '2026-05-10', time: '10:00:00', tz: 'UTC' }, end: { date: '2026-05-10', time: '11:00:00', tz: 'UTC' } }),
]);

// ── the two zones, each in its own process (TZ is read at startup) ─────────────────────────────────────────────
function zone(tz) {
  const r = spawnSync(process.execPath, [SELF, '--zone', tz], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
  if (r.status !== 0) { console.error(`TZ=${tz} failed\n${r.stdout}\n${r.stderr}`); process.exit(1); }
  return r.stdout.trim();
}

if (process.argv[2] === '--zone') {
  const tz = process.argv[3];
  const C = require(path.join(frontend, 'calendar-view.js'));
  const v = C.cardView(FIXTURE(), NOW);
  assert.equal(v.kind, 'card', `${tz}: an available answer shows the card`);
  const labels = v.rows.map(r => `${r.day} ${r.time} ${r.title}`);
  if (tz === 'America/Argentina/Buenos_Aires') {
    // A TZID is converted with the WebView's own zone database: 18:00 in Europe/Madrid (CEST, UTC+2) is 16:00Z, 13:00 here. A zone
    // the database does not know (a Windows name, a typo) keeps its written wall time (20:00).
    // UTC-3: 14:30Z is 11:30 local; 13 May 02:00Z is 12 May 23:00 local (today!); 12 May 01:00Z is 11 May 22:00 (yesterday, dropped)
    assert.deepEqual(labels, [
      'Hoy Todo el día Feriado',
      'Hoy 11:30 UTC hoy',
      'Hoy 13:00 Con zona escrita',
      'Hoy 20:00 Zona desconocida',
      'Hoy 23:00 UTC que cae hoy en local',
      'Mañana Todo el día Todo el día mañana',
      'Mañana 09:00 Flotante mañana',
    ], `${tz}: ${JSON.stringify(labels)}`);
    assert.equal(v.rows.find(r => r.title === 'Flotante mañana').location, 'Oficina', 'the location rides along');
  } else {
    // UTC: nothing moves, so the same fixture gives another set of days
    assert.deepEqual(labels, [
      'Hoy Todo el día Feriado',
      'Hoy 01:00 UTC de ayer en local',
      'Hoy 14:30 UTC hoy',
      'Hoy 16:00 Con zona escrita',
      'Hoy 20:00 Zona desconocida',
      'Mañana Todo el día Todo el día mañana',
      'Mañana 02:00 UTC que cae hoy en local',
      'Mañana 09:00 Flotante mañana',
    ], `${tz}: ${JSON.stringify(labels)}`);
  }
  // the day label of every row is a local today/tomorrow, never anything else
  for (const r of v.rows) assert.ok(['Hoy', 'Mañana'].includes(r.day), `${tz}: ${r.day}`);
  for (const r of v.rows) assert.match(r.time, /^(Todo el día|[0-2][0-9]:[0-5][0-9])$/, `${tz}: ${r.time}`);
  // a card is never a sample: with no events in the window it is empty and says so
  const empty = C.cardView(answer([ev({ title: 'Pasado', start: { date: '2026-05-01', time: '10:00:00', tz: 'UTC' }, end: { date: '2026-05-01', time: '11:00:00', tz: 'UTC' } })]), NOW);
  assert.equal(empty.kind, 'card');
  assert.deepEqual(empty.rows, []);
  assert.ok(empty.empty);
  console.log(`zone ${tz} ok`);
  process.exit(0);
}

// ── the parent process: availability, closed reasons, off-shape answers, the DOM ────────────────────────────────
// ── a minimal DOM: the renderer only creates elements and sets textContent ─────────────────────────────────────
function text(el) { return el.childNodes.map(n => (typeof n === 'string' ? n : text(n))).join(''); }
function fakeDocument() {
  const doc = { createElement: tag => new El(doc, tag), createElementNS: (_ns, tag) => new El(doc, tag) };
  return doc;
}
class El {
  constructor(doc, tag) { this.ownerDocument = doc; this.tagName = String(tag).toUpperCase(); this.childNodes = []; this.attributes = new Map(); this.className = ''; this.hidden = false; this.listeners = new Map(); }
  get children() { return this.childNodes.filter(n => typeof n !== 'string'); }
  set textContent(v) { this.childNodes = [String(v)]; }
  get textContent() { return text(this); }
  append(...nodes) { for (const n of nodes) this.childNodes.push(n); }
  replaceChildren(...nodes) { this.childNodes = nodes; }
  setAttribute(k, v) { this.attributes.set(k, String(v)); if (k === 'hidden') this.hidden = true; }
  getAttribute(k) { const v = this.attributes.get(k); return v === undefined ? null : v; }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
}

const C = require(path.join(frontend, 'calendar-view.js'));
let passed = 0;
const test = (_name, fn) => { fn(); passed += 1; };

test('available() is true ONLY for a real available:true answer (criterion 3: never sample data)', () => {
  assert.equal(C.available(answer([])), true);
  for (const reason of C.REASONS) assert.equal(C.available({ available: false, reason }), false, reason);
  for (const bad of [null, undefined, 'x', [], {}, { available: 'yes' }, { available: 1 }, { reason: 'not_configured' }, { available: false }]) {
    assert.equal(C.available(bad), false, JSON.stringify(bad));
  }
});

test('every unavailable reason is closed: the card is not built and the reason is never echoed raw', () => {
  for (const reason of C.REASONS) {
    const v = C.cardView({ available: false, reason }, NOW);
    assert.equal(v.kind, 'unavailable', reason);
    assert.equal(v.reason, reason);
  }
  for (const bad of [{ available: false, reason: 'nope' }, { available: false }, { available: false, reason: 7 }]) {
    assert.deepEqual(C.cardView(bad, NOW), { kind: 'unavailable', reason: 'bad_answer' }, JSON.stringify(bad));
  }
});

test('off-shape answers are refused whole: never a guess, never a half card', () => {
  const ok = FIXTURE();
  const bads = [null, [], 'x', {}, { available: true }, { ...ok, events: 'x' }, { ...ok, fetchedAt: 'hoy' },
    { ...ok, events: [{ ...ev(), title: 7 }] }, { ...ok, events: [{ ...ev(), allDay: 'yes' }] },
    { ...ok, events: [{ ...ev(), start: 'hoy' }] }, { ...ok, events: [{ ...ev(), start: { date: '2026-13-01', time: '10:00:00', tz: 'UTC' } }] },
    { ...ok, events: [{ ...ev(), start: { date: '2026-05-12', time: '25:00:00', tz: 'UTC' } }] },
    { ...ok, events: [{ ...ev(), start: null }] }, { ...ok, events: [{ ...ev(), start: { date: '2026-05-12', time: '10:00:00', tz: 7 } }] },
    // F2: the end is read now, so an end we cannot place refuses the answer too
    { ...ok, events: [{ ...ev(), end: null }] }, { ...ok, events: [{ ...ev(), end: { date: '2026-02-30', time: '10:00:00', tz: 'UTC' } }] },
    { ...ok, events: [{ ...ev(), end: { date: '2026-05-12', time: '25:00:00', tz: 'UTC' } }] },
    { ...ok, events: [{ ...ev(), allDay: true, start: { date: '2026-05-12', time: null, tz: null } }] },
    { ...ok, events: [{ ...ev(), end: { date: '2026-05-12', time: null, tz: null } }] }];
  for (const bad of bads) assert.equal(C.cardView(bad, NOW).kind, 'unavailable', JSON.stringify(bad));
  assert.equal(C.cardView(ok, 'now').kind, 'unavailable', 'a bad clock is refused too');
});

test('the rows carry only the closed fields: a title, a location, a day and a time', () => {
  const v = C.cardView(answer([ev({ title: 'Daily', location: 'Sala 2' })]), NOW);
  assert.deepEqual(Object.keys(v.rows[0]).sort(), ['allDay', 'aria', 'day', 'location', 'time', 'title']);
  // a long title and a private extra field: the title is cut, the extra never reaches a row
  const long = C.cardView(answer([ev({ title: 'x'.repeat(400), url: 'https://privado.example/cal?token=abc' })]), NOW);
  assert.equal(long.rows[0].title.length, 200);
  assert.doesNotMatch(JSON.stringify(long.rows), /privado\.example|token=/, 'nothing but the closed fields is projected');
});

// ── F2 · an event covers days, not only its start day ─────────────────────────────────────────────────────────
// Floating stamps (no TZID) keep their written wall day in every zone, so these run in the ambient TZ of this process.
const COVER_NOW = Date.now();
const dayAt = offset => { const d = new Date(COVER_NOW); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const floatingAt = (o = {}) => ({ title: 'Feriado', location: null, allDay: false,
  start: { date: dayAt(0), time: '22:00:00', tz: null }, end: { date: dayAt(0), time: '23:00:00', tz: null }, ...o });
const allDayAt = (o = {}) => ({ title: 'Congreso', location: null, allDay: true,
  start: { date: dayAt(0), time: null, tz: null }, end: { date: dayAt(1), time: null, tz: null }, ...o });

test('F2: an all-day event shows on every day of the window it covers — its end is exclusive', () => {
  const v = C.cardView(answer([
    allDayAt({ title: 'Congreso', start: { date: dayAt(-1), time: null, tz: null }, end: { date: dayAt(2), time: null, tz: null } }),
    allDayAt({ title: 'Termina hoy', start: { date: dayAt(-2), time: null, tz: null }, end: { date: dayAt(0), time: null, tz: null } }),
    allDayAt({ title: 'Empieza mañana', start: { date: dayAt(1), time: null, tz: null }, end: { date: dayAt(2), time: null, tz: null } }),
  ]), COVER_NOW);
  assert.equal(v.kind, 'card');
  assert.deepEqual(v.rows.map(r => `${r.day} ${r.time} ${r.title}`), [
    'Hoy Todo el día Congreso', 'Mañana Todo el día Congreso', 'Mañana Todo el día Empieza mañana',
  ], 'a 30-jun→03-jul event is on both days; an end at 00:00 today covers nothing of today');
  for (const r of v.rows) assert.equal(r.allDay, true, 'an all-day event still says «Todo el día»');
});

test('F2: a timed event that began before today and still covers it shows under «Hoy» with its end', () => {
  const v = C.cardView(answer([
    floatingAt({ title: 'Guardia', start: { date: dayAt(-1), time: '22:00:00', tz: null }, end: { date: dayAt(0), time: '01:30:00', tz: null } }),
    floatingAt({ title: 'Ya pasó', start: { date: dayAt(-1), time: '10:00:00', tz: null }, end: { date: dayAt(-1), time: '11:00:00', tz: null } }),
    floatingAt({ title: 'Terminó a medianoche', start: { date: dayAt(-1), time: '20:00:00', tz: null }, end: { date: dayAt(0), time: '00:00:00', tz: null } }),
  ]), COVER_NOW);
  assert.deepEqual(v.rows.map(r => `${r.day} ${r.time} ${r.title}`), ['Hoy Hasta 01:30 Guardia'],
    'an event entirely before today is dropped, and one that ends at 00:00 does not cover today');
  assert.equal(v.rows[0].allDay, false);
  assert.equal(v.rows[0].aria, 'Hoy, hasta las 01:30, Guardia');
});

test('F2: all-day rows stay «Todo el día» and sort before the timed ones of the same day', () => {
  const v = C.cardView(answer([
    floatingAt({ title: 'Reunión', start: { date: dayAt(0), time: '09:00:00', tz: null }, end: { date: dayAt(0), time: '10:00:00', tz: null } }),
    allDayAt({ title: 'Feriado' }),
    floatingAt({ title: 'Guardia', start: { date: dayAt(-1), time: '22:00:00', tz: null }, end: { date: dayAt(0), time: '01:30:00', tz: null } }),
  ]), COVER_NOW);
  assert.deepEqual(v.rows.map(r => `${r.day} ${r.time}`), ['Hoy Todo el día', 'Hoy Hasta 01:30', 'Hoy 09:00']);
  assert.deepEqual(v.rows.map(r => r.allDay), [true, false, false]);
});

test('F4: a DST gap resolves with the offset before it, an overlap to its FIRST occurrence (RFC 5545)', () => {
  const table = [
    ['Europe/Madrid', [2026, 3, 29, 2, 30], '2026-03-29T01:30:00.000Z'], // 02:30 does not exist that night: +01:00, the offset before the gap
    ['America/New_York', [2026, 3, 8, 2, 30], '2026-03-08T07:30:00.000Z'], // idem: -05:00
    ['Europe/Madrid', [2026, 10, 25, 2, 30], '2026-10-25T00:30:00.000Z'], // 02:30 happens twice: the first one, +02:00
    ['America/New_York', [2026, 11, 1, 1, 30], '2026-11-01T05:30:00.000Z'], // idem: -04:00
  ];
  for (const [zone, [y, m, d, h, mi], expected] of table) {
    assert.equal(new Date(C.zonedInstant(zone, Date.UTC(y, m - 1, d, h, mi))).toISOString(), expected, `${zone} ${y}-${m}-${d} ${h}:${mi}`);
  }
  // a zone the WebView does not know stays null, never a guess (a Windows name, a typo)
  assert.equal(C.zonedInstant('Mars/Olympus', Date.UTC(2026, 0, 1)), null);
});

const BIDI = /[\u0000-\u001f\u007f-\u009f\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;

test('F7: the sanitiser strips bidi controls and separators too, not only C0/C1 (titles come from outside invitations)', () => {
  // U+202E right-to-left override, U+2066/U+2069 isolates, U+200E mark, U+FEFF, U+200B, U+2028 line separator
  const hostile = 'Factura\u202E\u2066gpj.exe\u2069\u200E\uFEFF\u200B\u061C\u180E y\u2028algo';
  const v = C.cardView(answer([floatingAt({ title: hostile, location: 'Sala\u202Etxt\u200F' })]), COVER_NOW);
  assert.equal(v.rows.length, 1);
  assert.doesNotMatch(v.rows[0].title, BIDI, JSON.stringify(v.rows[0].title));
  assert.doesNotMatch(v.rows[0].location, BIDI, JSON.stringify(v.rows[0].location));
  assert.match(v.rows[0].title, /^Factura/);
  assert.match(v.rows[0].title, /gpj\.exe/);
  assert.match(v.rows[0].title, /algo$/);
  // and the font of all of it is textContent: what the row carries is what the DOM paints, hostile characters included or not
  const doc2 = fakeDocument();
  const host = doc2.createElement('div');
  C.render(host, v);
  assert.doesNotMatch(text(host), BIDI);
});

test('the card DOM is textContent only and hides itself when there is no real answer', () => {
  const doc = fakeDocument();
  const host = doc.createElement('div');
  C.render(host, C.cardView(FIXTURE(), NOW));
  assert.equal(host.hidden, false);
  assert.equal(text(host).includes('Calendario'), true);
  assert.ok(host.children.length > 0, 'a head and the rows');
  // the private URL of an event is never painted: it is not part of the answer shape the card projects
  const withUrl = C.cardView(answer([ev({ title: 'Daily', url: 'https://privado.example/cal?token=abc' })]), NOW);
  const host2 = doc.createElement('div');
  C.render(host2, withUrl);
  assert.doesNotMatch(text(host2), /privado\.example|token=/, 'the ICS URL never appears in the DOM');
  const host3 = doc.createElement('div');
  C.render(host3, C.cardView({ available: false, reason: 'not_configured' }, NOW));
  assert.equal(host3.hidden, true, 'not configured: no card');
  assert.equal(text(host3), '', 'and nothing painted');
  const host4 = doc.createElement('div');
  C.render(host4, C.cardView(answer([]), NOW));
  assert.equal(host4.hidden, false, 'configured with nothing today: the card says so instead of inventing an event');
  assert.match(text(host4), /Nada para hoy ni mañana/);
});

test('the wiring: one registered card, a 60 s poll, the shortcuts refresh and the closed host verb', () => {
  const src = fs.readFileSync(path.join(frontend, 'calendar-view.js'), 'utf8');
  assert.match(src, /registerCard\(\{/);
  assert.match(src, /id: 'cal'/);
  assert.match(src, /icon: 'cal'/);
  assert.match(src, /invoke\('calendar_action', \{ payload: \{ action: 'refresh' \} \}\)/);
  assert.match(src, /AbitoShortcuts\.refresh\(\)|shortcuts\.refresh\(\)/);
  assert.equal(C.POLL_MS, 60000);
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|outerHTML|document\.write|window\.open/);
  assert.doesNotMatch(src, /fetch\(|XMLHttpRequest|WebSocket|localStorage|https?:\/\//);
  assert.match(src, /paused\('calendar'\)/, 'the pause entry of K2-11 S6 is its own switch');
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  assert.equal((html.match(/src="calendar-view\.js"/g) || []).length, 1, 'one defer script in index.html');
  assert.match(html, /<script defer src="calendar-view\.js"><\/script>/);
  assert.ok(require('../packaging/lib.cjs').FRONTEND_FILES.includes('calendar-view.js'), 'the file ships');
});

// ── the mount tail, on a sandboxed page: register, poll, paint, unmount ─────────────────────────────────────────
const zone0 = 'America/Argentina/Buenos_Aires', zone1 = 'UTC';
for (const tz of [zone0, zone1]) zone(tz);

async function mounted(answer, opts = {}) {
  const vm = require('node:vm');
  const doc = fakeDocument();
  const registry = { card: null, refreshes: 0 };
  const calls = [];
  const state = { paused: opts.paused === true, tick: null };
  const handlers = {};
  doc.hidden = false;
  doc.addEventListener = (type, fn) => { handlers[type] = fn; };
  const shortcuts = { registerCard: def => { registry.card = def; }, refresh: () => { registry.refreshes += 1; } };
  const sandbox = {
    document: doc, AbitoShortcuts: shortcuts, AbitoPaused: { paused: () => state.paused },
    setInterval: fn => { state.tick = fn; return 1; }, clearInterval: () => {}, addEventListener: () => {},
    __TAURI__: { core: { invoke: (cmd, args) => { calls.push({ cmd, args }); return Promise.resolve(typeof answer === 'function' ? answer() : answer); } } },
  };
  sandbox.window = sandbox; sandbox.self = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(frontend, 'calendar-view.js'), 'utf8'), sandbox, { filename: 'calendar-view.js' });
  for (let i = 0; i < 6; i += 1) await new Promise(r => setImmediate(r));
  return { doc, registry, calls, state, handlers };
}
const todayKey = () => {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};
// a floating stamp (no TZID) shows its written wall time as written, in every zone this check runs in
const todayAnswer = title => ({ available: true, fetchedAt: Date.now(), events: [
  { title, location: 'Sala 2', allDay: false, start: { date: todayKey(), time: '09:30:00', tz: null }, end: { date: todayKey(), time: '10:00:00', tz: null } },
] });

(async () => {
  const ok = await mounted(todayAnswer('Daily del equipo'));
  assert.deepEqual(ok.calls.map(c => c.cmd), ['calendar_action'], 'one closed host verb, nothing else');
  assert.equal(JSON.stringify(ok.calls[0].args), JSON.stringify({ payload: { action: 'refresh' } }), 'the payload is exactly the closed verb');
  assert.equal(ok.registry.card.id, 'cal');
  assert.equal(ok.registry.card.label, 'Calendario');
  assert.equal(ok.registry.card.icon, 'cal');
  assert.equal(ok.registry.card.available(), true, 'a real available:true answer makes the icon appear');
  assert.ok(ok.registry.refreshes >= 1, 'and asks the row to repaint (AbitoShortcuts.refresh)');
  const host = ok.doc.createElement('div');
  const off = ok.registry.card.mount(host);
  assert.equal(host.hidden, false);
  assert.match(text(host), /Daily del equipo/);
  assert.match(text(host), /09:30/);
  assert.match(text(host), /Sala 2/);
  off();
  assert.equal(text(host), '', 'unmount leaves nothing behind');

  // S3: not configured (or any closed reason) → no icon, no card, nothing asked twice twice
  const off2 = await mounted({ available: false, reason: 'not_configured' });
  assert.equal(off2.registry.card.available(), false, 'not configured: the card does not exist');
  assert.equal(off2.registry.refreshes, 0, 'an unavailable card never asks for a repaint of the row it is not in');
  assert.equal(off2.calls.length, 1);
  // an unreadable answer is the same: never a card built from a guess
  const bad = await mounted({ available: true, events: 'x', fetchedAt: 1 });
  assert.equal(bad.registry.card.available(), false);
  passed += 2;

  // F5: the card's own pause entry silences its 60 s poll, exactly as the GitHub card does (K2-11 S6)
  const paused = await mounted(() => todayAnswer('Daily del equipo'), { paused: true });
  const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise(r => setImmediate(r)); };
  assert.deepEqual(paused.calls, [], 'F5: paused, the card does not even ask the host');
  paused.state.tick(); // the 60 s poll fires while it is still paused
  await settle();
  assert.deepEqual(paused.calls, [], 'F5: and the 60 s poll skips the host too, not only a hidden page');
  paused.state.paused = false;
  paused.state.tick();
  await settle();
  assert.equal(paused.calls.length, 1, 'F5: a poll after the pause is lifted does ask');
  passed += 1;
  console.log(`calendar-view-check: ${passed} checks ok + 2 zones (Buenos Aires, UTC)`);
})().catch(e => { console.error('FAIL', e.stack); process.exit(1); });
