'use strict';
/* #359 F045 — pure checks for frontend/integrations-calendar.js (Cal.com bookings with month/day
   navigation and a detail view; navigation is pure state). Times are UTC on purpose: the fake data
   and the checks never depend on the machine's timezone. FAKE data only: no network, no accounts.
   Run: node apps/desktop-tauri/test-node/integrations-calendar-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const C = require(path.join(frontend, 'integrations-calendar.js'));

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; } catch (e) { console.error(`FAIL: ${name}`); throw e; }
};
const at = (y, m, d, h = 15, min = 0) => Date.UTC(y, m, d, h, min);
const NOW = at(2023, 10, 14); // 14 nov 2023 (a Tuesday)
const bk = (o = {}) => ({ id: 'b1', title: 'Llamada de descubrimiento', attendee: 'Ana', start: at(2023, 10, 14), durationMin: 30, ...o });
const okFrame = (o = {}) => ({ type: 'calendar', schema: C.SCHEMA, fake: true,
  bookings: [bk(), bk({ id: 'b2', title: 'Revisión', start: at(2023, 10, 14, 9, 30), durationMin: 45 }),
    bk({ id: 'b3', title: 'Demo', start: at(2023, 10, 21) }), bk({ id: 'b4', title: 'Cierre', start: at(2023, 11, 5) })], ...o });
const store = () => C.storeFromFrame(okFrame(), NOW);

test('fake provider: loud, closed shape, bounded, deterministic', () => {
  const f = C.fakeFrame();
  assert.equal(f.fake, true);
  assert.ok(f.bookings.length > 0 && f.bookings.length <= C.MAX_BOOKINGS);
  for (const b of f.bookings) assert.deepEqual(Object.keys(b).sort(), ['attendee', 'durationMin', 'id', 'start', 'title']);
  assert.deepEqual(C.fakeFrame(), f);
  assert.ok(C.storeFromFrame(f, C.FAKE_BASE));
});

test('storeFromFrame: builds a frozen store on the month of `now`, no day, no detail', () => {
  const s = store();
  assert.ok(Object.isFrozen(s) && Object.isFrozen(s.bookings));
  assert.deepEqual([s.year, s.month, s.day, s.selected], [2023, 10, null, null]);
  assert.equal(s.bookings.length, 4);
});

test('storeFromFrame: malformed frames and a bad clock are refused whole', () => {
  const ok = okFrame();
  const b = bk();
  const bads = [null, [], 'x', {}, { ...ok, type: 'x' }, { ...ok, schema: 'foreign/1' }, { ...ok, fake: 0 },
    { ...ok, bookings: 'x' }, { ...ok, extra: 1 }, { ...ok, bookings: [{ ...b, url: 'https://x' }] },
    { ...ok, bookings: [{ ...b, id: 'A B' }] }, { ...ok, bookings: [{ ...b, title: '' }] },
    { ...ok, bookings: [{ ...b, title: 'x'.repeat(C.MAX_TITLE + 1) }] },
    { ...ok, bookings: [{ ...b, attendee: 'x'.repeat(C.MAX_ATTENDEE + 1) }] },
    { ...ok, bookings: [{ ...b, start: 'hoy' }] }, { ...ok, bookings: [{ ...b, start: NaN }] },
    { ...ok, bookings: [{ ...b, durationMin: 0 }] }, { ...ok, bookings: [{ ...b, durationMin: 1441 }] },
    { ...ok, bookings: [{ ...b, durationMin: 1.5 }] },
    { ...ok, bookings: Array.from({ length: C.MAX_BOOKINGS + 1 }, (_, i) => ({ ...b, id: `b${i}` })) }];
  for (const bad of bads) assert.equal(C.storeFromFrame(bad, NOW), null, JSON.stringify(bad));
  assert.equal(C.storeFromFrame(ok, 'now'), null);
  assert.equal(C.storeFromFrame(ok, Date.UTC(1969, 0, 1)), null, 'months outside the supported window are refused');
});

test('month navigation is pure: next/prev cross year boundaries and clear day and detail', () => {
  let s = C.selectDay(store(), 14);
  assert.equal(s.day, 14);
  const next = C.nextMonth(s);
  assert.deepEqual([next.year, next.month, next.day, next.selected], [2023, 11, null, null]);
  assert.deepEqual([s.year, s.month, s.day], [2023, 10, 14], 'the old store is never mutated');
  const jan = C.nextMonth(next);
  assert.deepEqual([jan.year, jan.month], [2024, 0]);
  const dec = C.prevMonth(jan);
  assert.deepEqual([dec.year, dec.month], [2023, 11]);
  const lo = C.storeFromFrame(okFrame(), Date.UTC(C.MIN_YEAR, 0, 1));
  assert.equal(C.prevMonth(lo), null, 'the window floor is a refusal, not a wrap');
  const hi = C.storeFromFrame(okFrame(), Date.UTC(C.MAX_YEAR, 11, 1));
  assert.equal(C.nextMonth(hi), null);
  assert.equal(C.nextMonth(null), null);
  assert.equal(C.nextMonth({}), null);
});

test('day selection: valid days of the shown month only; the same day again clears it', () => {
  const s = store();
  assert.equal(C.selectDay(s, 14).day, 14);
  assert.equal(C.selectDay(C.selectDay(s, 14), 14).day, null);
  for (const bad of [0, 31, 32, -1, 1.5, '14', null, NaN]) assert.equal(C.selectDay(s, bad), null, String(bad));
  assert.equal(C.selectDay(s, 30).day, 30, 'november has 30 days');
  const feb = C.storeFromFrame(okFrame(), at(2024, 1, 10));
  assert.equal(C.selectDay(feb, 29).day, 29, '2024 is a leap year');
  assert.equal(C.selectDay(feb, 30), null);
  assert.equal(C.selectDay(C.storeFromFrame(okFrame(), at(2023, 1, 10)), 29), null, '2023 is not');
});

test('detail: openBooking needs an existing id; closeBooking returns to the list; changing month closes it', () => {
  const s = store();
  const d = C.openBooking(s, 'b3');
  assert.equal(d.selected, 'b3');
  assert.equal(C.closeBooking(d).selected, null);
  assert.equal(C.closeBooking(s), null);
  for (const bad of ['nope', '', null, 3, '__proto__']) assert.equal(C.openBooking(s, bad), null, String(bad));
  assert.equal(C.nextMonth(d).selected, null);
});

test('view: month grid is Monday-first with honest per-day counts', () => {
  const v = C.view(store(), NOW);
  assert.equal(v.monthLabel, 'noviembre de 2023');
  assert.deepEqual(v.weekdays, ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom']);
  assert.equal(v.cells.length % 7, 0);
  assert.equal(v.cells.filter(c => c.day !== null).length, 30);
  assert.equal(v.cells.findIndex(c => c.day === 1), 2, '1 nov 2023 was a Wednesday: two leading blanks');
  assert.equal(v.cells.find(c => c.day === 14).count, 2);
  assert.equal(v.cells.find(c => c.day === 21).count, 1);
  assert.equal(v.cells.find(c => c.day === 15).count, 0);
  assert.equal(v.cells.find(c => c.day === 14).isToday, true);
  assert.equal(v.cells.find(c => c.day === 15).isToday, false);
  assert.match(v.banner, /datos de ejemplo/i);
  assert.equal(C.view(C.storeFromFrame(okFrame({ fake: false }), NOW), NOW).banner, null);
});

test('view: the list shows the month sorted by start, or only the chosen day', () => {
  const month = C.view(store(), NOW);
  assert.equal(month.mode, 'list');
  assert.deepEqual(month.rows.map(r => r.id), ['b2', 'b1', 'b3'], 'sorted by start; december is out');
  const day = C.view(C.selectDay(store(), 14), NOW);
  assert.deepEqual(day.rows.map(r => r.id), ['b2', 'b1']);
  assert.equal(day.dayLabel, '14 de noviembre');
  assert.equal(day.rows[0].timeLabel, '09:30–10:15');
  assert.equal(C.view(C.selectDay(store(), 15), NOW).rows.length, 0);
});

test('view: detail mode carries the booking; bad input yields null', () => {
  const v = C.view(C.openBooking(store(), 'b3'), NOW);
  assert.equal(v.mode, 'detail');
  assert.equal(v.detail.title, 'Demo');
  assert.equal(v.detail.attendee, 'Ana');
  assert.equal(v.detail.whenLabel, 'martes 21 de noviembre · 15:00–15:30');
  assert.equal(v.detail.durationLabel, '30 min');
  assert.equal(C.view(null, NOW), null);
  assert.equal(C.view(store(), 'now'), null);
});

test('hygiene: frozen API, textContent only, no network, guarded trusted mount', () => {
  assert.ok(Object.isFrozen(C));
  const src = fs.readFileSync(path.join(frontend, 'integrations-calendar.js'), 'utf8');
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|outerHTML|document\.write|window\.open/);
  assert.doesNotMatch(src, /fetch\(|XMLHttpRequest|WebSocket|localStorage/);
  assert.doesNotMatch(src, /(api[_-]?key|secret|token)\s*[:=]\s*['"][^'"]{8,}/i);
  assert.match(src, /Datos de ejemplo/);
  assert.match(src, /getElementById\('integrations-calendar'\)/);
  assert.match(src, /if \(!host\) return/);
  assert.match(src, /e\.isTrusted !== true/);
});

test('render: month grid, day buttons and detail are keyboard buttons (browser only)', () => {
  if (typeof document === 'undefined') return;
  const host = document.createElement('div');
  C.render(host, C.view(store(), NOW));
  assert.ok(host.querySelector('.intc-fake').textContent.includes('datos de ejemplo'));
  assert.ok(host.querySelector('[data-action="prev-month"]') && host.querySelector('[data-action="next-month"]'));
  assert.equal(host.querySelectorAll('button[data-action="day"]').length, 30);
  assert.deepEqual([...host.querySelectorAll('button[data-action="open"]')].map(b => b.dataset.id), ['b2', 'b1', 'b3']);
  C.render(host, C.view(C.openBooking(store(), 'b3'), NOW));
  assert.ok(host.querySelector('[data-action="close"]'));
  C.render(host, null);
  assert.equal(host.hidden, true);
});

console.log(`integrations-calendar-check: ${passed} checks ok`);
