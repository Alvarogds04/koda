'use strict';
/* #359 F045 — the Calendario (Cal.com) service card: bookings with month/day navigation and a
   booking detail. ONE file, the house pattern (integrations-view.js): pure view-model, textContent
   -only renderer, a LOUD fake provider, browser-only mount at the tail.

   Navigation is PURE STATE in the store (year, month, day, selected): every action returns a new
   frozen store or null, and rejected input leaves the old store untouched. Dates are read as UTC on
   purpose, so the fake data and the checks never depend on the machine's timezone.

   FAKE DATA ONLY: no network, no account, no token. Every rendered view carries the visible
   «datos de ejemplo» marker while the frame says fake:true.

   MOUNT CONTRACT (index.html wiring — coordinator's approval needed): inert until the page has
     <section id="integrations-calendar" hidden></section>
   plus <script src="integrations-calendar.js" defer></script>. With the container absent it costs
   nothing. The open-in-Cal.com target stays with the framework (integrations-view.js allowlist). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = Object.freeze(api); return; }
  root.AbitoCalendar = Object.freeze(api);
  mount(api);
})(typeof self !== 'undefined' ? self : this, () => {
  const SCHEMA = 'abito-integrations/calendar/1';
  const MAX_BOOKINGS = 40;
  const MAX_TITLE = 80;
  const MAX_ATTENDEE = 60;
  const MIN_YEAR = 2000;
  const MAX_YEAR = 2100;
  const FAKE_BANNER = 'Datos de ejemplo — nada está conectado todavía.';
  const ID_RE = /^[a-z0-9-]{1,32}$/;
  const MONTHS = Object.freeze(['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']);
  const WEEKDAYS = Object.freeze(['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom']);
  const WEEKDAYS_LONG = Object.freeze(['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']);
  const KEYS = ['id', 'title', 'attendee', 'start', 'durationMin'];

  const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isStr = v => typeof v === 'string';
  const isInt = v => Number.isInteger(v);
  const daysIn = (year, month) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const pad = n => String(n).padStart(2, '0');
  const hhmm = ms => { const d = new Date(ms); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
  const range = b => `${hhmm(b.start)}–${hhmm(b.start + b.durationMin * 60000)}`;
  const inMonth = (b, year, month) => { const d = new Date(b.start); return d.getUTCFullYear() === year && d.getUTCMonth() === month; };

  const validBooking = b => isObject(b)
    && Object.keys(b).length === KEYS.length && KEYS.every(k => k in b)
    && isStr(b.id) && ID_RE.test(b.id)
    && isStr(b.title) && b.title.length > 0 && b.title.length <= MAX_TITLE
    && isStr(b.attendee) && b.attendee.length <= MAX_ATTENDEE
    && Number.isFinite(b.start) && isInt(b.durationMin) && b.durationMin >= 1 && b.durationMin <= 1440;

  const make = (fake, bookings, year, month, day, selected) =>
    Object.freeze({ fake, bookings, year, month, day, selected });
  const isStore = s => isObject(s) && typeof s.fake === 'boolean' && Array.isArray(s.bookings)
    && isInt(s.year) && s.year >= MIN_YEAR && s.year <= MAX_YEAR && isInt(s.month) && s.month >= 0 && s.month <= 11
    && (s.day === null || isInt(s.day)) && (s.selected === null || isStr(s.selected));

  /**
   * A closed `calendar` frame to a frozen store showing the month of `now` (a finite timestamp the
   * caller owns); anything off-shape — frame or clock — is refused whole.
   */
  function storeFromFrame(frame, now) {
    if (!isObject(frame) || frame.type !== 'calendar' || frame.schema !== SCHEMA) return null;
    if (typeof frame.fake !== 'boolean' || !Array.isArray(frame.bookings) || !Number.isFinite(now)) return null;
    if (!Object.keys(frame).every(k => ['type', 'schema', 'fake', 'bookings'].includes(k))) return null;
    if (frame.bookings.length > MAX_BOOKINGS) return null;
    const at = new Date(now);
    const year = at.getUTCFullYear();
    if (!(year >= MIN_YEAR && year <= MAX_YEAR)) return null;
    const seen = new Set();
    const bookings = [];
    for (const b of frame.bookings) {
      if (!validBooking(b)) return null;
      if (seen.has(b.id)) continue; // duplicate: first wins
      seen.add(b.id);
      bookings.push(Object.freeze(Object.fromEntries(KEYS.map(k => [k, b[k]]))));
    }
    return make(frame.fake, Object.freeze(bookings), year, at.getUTCMonth(), null, null);
  }

  function shiftMonth(store, delta) {
    if (!isStore(store)) return null;
    const idx = store.year * 12 + store.month + delta;
    const year = Math.floor(idx / 12);
    if (year < MIN_YEAR || year > MAX_YEAR) return null;
    return make(store.fake, store.bookings, year, idx - year * 12, null, null);
  }
  const nextMonth = store => shiftMonth(store, 1);
  const prevMonth = store => shiftMonth(store, -1);

  /** Picks a day of the SHOWN month; picking the same day again clears it. */
  function selectDay(store, day) {
    if (!isStore(store) || !isInt(day) || day < 1 || day > daysIn(store.year, store.month)) return null;
    return make(store.fake, store.bookings, store.year, store.month, store.day === day ? null : day, null);
  }

  function openBooking(store, id) {
    if (!isStore(store) || !isStr(id) || !store.bookings.some(b => b.id === id)) return null;
    return make(store.fake, store.bookings, store.year, store.month, store.day, id);
  }
  function closeBooking(store) {
    if (!isStore(store) || store.selected === null) return null;
    return make(store.fake, store.bookings, store.year, store.month, store.day, null);
  }

  const durationLabel = min => (min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`);

  /** The closed projection for the renderer; null for a bad store or timestamp. */
  function view(store, now) {
    if (!isStore(store) || !Number.isFinite(now)) return null;
    const { year, month } = store;
    const today = new Date(now);
    const isTodayMonth = today.getUTCFullYear() === year && today.getUTCMonth() === month;
    const monthBookings = store.bookings.filter(b => inMonth(b, year, month)).sort((a, b) => a.start - b.start);
    const lead = (new Date(Date.UTC(year, month, 1)).getUTCDay() + 6) % 7; // Monday-first
    const total = daysIn(year, month);
    const cells = [];
    for (let i = 0; i < lead; i += 1) cells.push(Object.freeze({ day: null, count: 0, selected: false, isToday: false }));
    for (let d = 1; d <= total; d += 1) {
      const count = monthBookings.filter(b => new Date(b.start).getUTCDate() === d).length;
      cells.push(Object.freeze({ day: d, count, selected: store.day === d, isToday: isTodayMonth && today.getUTCDate() === d }));
    }
    while (cells.length % 7 !== 0) cells.push(Object.freeze({ day: null, count: 0, selected: false, isToday: false }));
    const shown = store.day === null ? monthBookings : monthBookings.filter(b => new Date(b.start).getUTCDate() === store.day);
    const rows = shown.map(b => Object.freeze({ id: b.id, title: b.title, attendee: b.attendee,
      dayShort: new Date(b.start).getUTCDate(), timeLabel: range(b) }));
    const picked = store.selected === null ? null : store.bookings.find(b => b.id === store.selected) || null;
    const detail = picked ? (() => {
      const d = new Date(picked.start);
      return Object.freeze({ id: picked.id, title: picked.title, attendee: picked.attendee,
        whenLabel: `${WEEKDAYS_LONG[d.getUTCDay()]} ${d.getUTCDate()} de ${MONTHS[d.getUTCMonth()]} · ${range(picked)}`,
        durationLabel: durationLabel(picked.durationMin) });
    })() : null;
    return Object.freeze({ fake: store.fake, banner: store.fake ? FAKE_BANNER : null,
      mode: detail ? 'detail' : 'list', monthLabel: `${MONTHS[month]} de ${year}`, weekdays: WEEKDAYS,
      cells: Object.freeze(cells), dayLabel: store.day === null ? null : `${store.day} de ${MONTHS[month]}`,
      rows: Object.freeze(rows), detail });
  }

  // ---- renderer (textContent only; events live in mount) ----------------------
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  };
  const btn = (cls, action, id, label) => {
    const b = el('button', cls, label);
    b.type = 'button';
    b.dataset.action = action;
    if (id !== null && id !== undefined) b.dataset.id = String(id);
    return b;
  };

  function render(host, v) {
    if (!(host && typeof host.appendChild === 'function')) return;
    host.textContent = '';
    if (!v || !Array.isArray(v.rows)) { host.hidden = true; return; }
    host.hidden = false;
    const head = el('div', 'intc-head');
    head.append(el('span', 'intc-title', 'Calendario'));
    host.append(head);
    if (v.banner) host.append(el('p', 'intc-fake', v.banner));
    if (v.mode === 'detail' && v.detail) {
      const card = el('article', 'intc-card');
      card.append(el('h3', 'intc-card-title', v.detail.title));
      card.append(el('span', 'intc-meta', v.detail.whenLabel));
      card.append(el('span', 'intc-meta', `Duración: ${v.detail.durationLabel}`));
      card.append(el('span', 'intc-meta', v.detail.attendee ? `Con ${v.detail.attendee}` : 'Sin invitado'));
      card.append(btn('intc-nav', 'close', null, 'Volver al calendario'));
      host.append(card);
      return;
    }
    const nav = el('div', 'intc-nav-row');
    nav.append(btn('intc-nav', 'prev-month', null, '‹ Anterior'));
    nav.append(el('span', 'intc-month', v.monthLabel));
    nav.append(btn('intc-nav', 'next-month', null, 'Siguiente ›'));
    host.append(nav);
    const grid = el('div', 'intc-grid');
    for (const w of v.weekdays) grid.append(el('span', 'intc-wd', w));
    for (const c of v.cells) {
      if (c.day === null) { grid.append(el('span', 'intc-blank')); continue; }
      const b = btn(`intc-day${c.selected ? ' intc-day--sel' : ''}${c.isToday ? ' intc-day--today' : ''}`, 'day', c.day, String(c.day));
      b.setAttribute('aria-pressed', c.selected ? 'true' : 'false');
      if (c.count > 0) {
        b.dataset.count = String(c.count);
        b.setAttribute('aria-label', `${c.day}, ${c.count} ${c.count === 1 ? 'reserva' : 'reservas'}`);
      }
      grid.append(b);
    }
    host.append(grid);
    host.append(el('p', 'intc-sub', v.dayLabel ? `Reservas del ${v.dayLabel}` : 'Reservas del mes'));
    if (v.rows.length === 0) { host.append(el('p', 'intc-empty', 'No hay reservas.')); return; }
    const list = el('ul', 'intc-list');
    for (const r of v.rows) {
      const li = el('li', 'intc-item');
      const b = btn('intc-row', 'open', r.id, null);
      b.append(el('span', 'intc-row-title', r.title), el('span', 'intc-meta', `${r.dayShort} · ${r.timeLabel}`));
      li.append(b);
      list.append(li);
    }
    host.append(list);
  }

  // ---- fake provider (LOUD, deterministic, no network) -------------------------
  const FAKE_BASE = Date.UTC(2023, 10, 14, 12, 0);
  const FAKE_BOOKINGS = Object.freeze([
    ['ej-1', 'Llamada de descubrimiento', 'Ana Pérez', Date.UTC(2023, 10, 6, 14, 0), 30],
    ['ej-2', 'Revisión de proyecto', 'Luis Gómez', Date.UTC(2023, 10, 14, 9, 30), 45],
    ['ej-3', 'Demo del producto', 'Marta Ruiz', Date.UTC(2023, 10, 14, 16, 0), 60],
    ['ej-4', 'Seguimiento', 'Ana Pérez', Date.UTC(2023, 10, 21, 15, 0), 30],
    ['ej-5', 'Cierre de año', 'Equipo', Date.UTC(2023, 11, 5, 10, 0), 90],
  ]);
  function fakeFrame() {
    return { type: 'calendar', schema: SCHEMA, fake: true,
      bookings: FAKE_BOOKINGS.map(([id, title, attendee, start, durationMin]) => ({ id, title, attendee, start, durationMin })) };
  }

  return { SCHEMA, MAX_BOOKINGS, MAX_TITLE, MAX_ATTENDEE, MIN_YEAR, MAX_YEAR, FAKE_BASE,
    storeFromFrame, nextMonth, prevMonth, selectDay, openBooking, closeBooking, view, render, fakeFrame };
});

// ---- browser-only wiring: self-mount into #integrations-calendar, FAKE provider only ----
function mount(C) {
  if (typeof document === 'undefined') return;
  const host = document.getElementById('integrations-calendar');
  if (!host) return; // inert until index.html carries the container (mount contract)
  let store = C.storeFromFrame(C.fakeFrame(), C.FAKE_BASE);
  const paint = () => C.render(host, C.view(store, C.FAKE_BASE)); // fake data is anchored: «hoy» stays stable
  host.addEventListener('click', e => {
    if (!e || e.isTrusted !== true) return; // only trusted gestures change anything
    const target = e.target && typeof e.target.closest === 'function' ? e.target : null;
    const button = target ? target.closest('[data-action]') : null;
    if (!button || !host.contains(button)) return;
    const { action, id } = button.dataset;
    const next = action === 'prev-month' ? C.prevMonth(store)
      : action === 'next-month' ? C.nextMonth(store)
        : action === 'day' ? C.selectDay(store, Number(id))
          : action === 'open' ? C.openBooking(store, id)
            : action === 'close' ? C.closeBooking(store) : null;
    if (next) { store = next; paint(); }
  });
  paint();
}
