'use strict';
/* K2-11 S2/S3/S6 (design/k2-09-atajos/08-isla-unida.html F5/F6, decision 9a) — the CALENDAR card of the island's shortcuts row
   (island-shortcuts.js, the part built by K2-09). One ICS subscription URL in the keychain (src/calendar.rs, never here), one
   read-only verb:

     invoke('calendar_action', {payload:{action:'refresh'}})
       -> {available:true, events:[{title,location,allDay,start:{date,time,tz},end:{...}}], fetchedAt}
       -> {available:false, reason:'not_configured'|'bad_url'|'unreachable'|'refused'|'bad_answer'}

   The host fetches a UTC window of [today-1, today+3]; THIS file keeps the events that are today or tomorrow in the user's own
   zone (L5) and paints them with their time. A stamp with tz 'UTC' is an instant, so it is converted to local; a stamp with a
   TZID or none (floating) has no zone database behind it, so its written wall time is shown as written. An all-day stamp is a
   date, never an instant.
   Criterion 3 (S3): the card exists only while the answer really is available:true. There is no sample event anywhere in this
   file, and nothing but title, location, day and time is projected (the private URL never leaves the host).
   Pure view-model first (Node-testable), then the browser-only mount at the tail (house pattern: spotify-view.js). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = Object.freeze(api); return; }
  root.AbitoCalendarView = Object.freeze(api);
  mount(api);
})(typeof self !== 'undefined' ? self : this, () => {
  const CARD_ID = 'cal';
  const LABEL = 'Calendario';
  const ICON = 'cal';
  const NOTE = 'Hoy y mañana';
  const EMPTY = 'Nada para hoy ni mañana';
  /** The closed set of «no card» answers src/calendar.rs can give (never echoed raw, never invented). */
  const REASONS = Object.freeze(['not_configured', 'bad_url', 'unreachable', 'refused', 'bad_answer']);
  const DAYS = Object.freeze(['Hoy', 'Mañana']);
  const ALL_DAY = 'Todo el día';
  const MAX_TEXT = 200;
  const POLL_MS = 60000; // the host caches a fetch for 5 min; a minute is what shows a new event soon after it is added
  const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const clean = (v, max = MAX_TEXT) => (typeof v === 'string' ? [...v.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim()].slice(0, max).join('') : '');
  const pad = n => String(n).padStart(2, '0');
  const key = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
  const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

  /** 'YYYY-MM-DD' → {y, m, d}, or null (a day that does not exist is never read as another one). */
  function parseDate(raw) {
    if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
    const y = Number(raw.slice(0, 4)), m = Number(raw.slice(5, 7)), d = Number(raw.slice(8, 10));
    if (m < 1 || m > 12 || d < 1 || d > daysIn(y, m)) return null;
    return { y, m, d };
  }
  /** 'HH:MM:SS' → minutes and seconds of the wall clock, or null. */
  function parseTime(raw) {
    if (typeof raw !== 'string' || !/^\d{2}:\d{2}:\d{2}$/.test(raw)) return null;
    const h = Number(raw.slice(0, 2)), mi = Number(raw.slice(3, 5)), s = Number(raw.slice(6, 8));
    return h > 23 || mi > 59 || s > 59 ? null : { h, mi, s };
  }

  /** One Stamp of the answer → {day, minutes, allDay} in the user's zone, or null when it is not the shape we know. */
  function place(stamp) {
    if (!isObject(stamp)) return null;
    const date = parseDate(stamp.date);
    if (!date) return null;
    if (stamp.time === null || stamp.time === undefined) return { day: key(date.y, date.m, date.d), minutes: 0, allDay: true };
    const time = parseTime(stamp.time);
    if (!time) return null;
    if (stamp.tz !== null && stamp.tz !== undefined && typeof stamp.tz !== 'string') return null;
    // 'UTC' is an instant: the wall time moves to this machine's zone. A TZID or a floating stamp stays as written.
    if (stamp.tz === 'UTC') {
      const at = new Date(Date.UTC(date.y, date.m - 1, date.d, time.h, time.mi, time.s));
      if (Number.isNaN(at.getTime())) return null;
      return { day: key(at.getFullYear(), at.getMonth() + 1, at.getDate()), minutes: at.getHours() * 60 + at.getMinutes(), allDay: false };
    }
    return { day: key(date.y, date.m, date.d), minutes: time.h * 60 + time.mi, allDay: false };
  }

  /** The local days the card shows: today and tomorrow, as YYYY-MM-DD keys. */
  function windowDays(now) {
    const today = new Date(now);
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return [key(today.getFullYear(), today.getMonth() + 1, today.getDate()), key(tomorrow.getFullYear(), tomorrow.getMonth() + 1, tomorrow.getDate())];
  }

  /** True only for a real available:true answer (criterion 3: no card, and no sample data, otherwise). */
  const available = answer => isObject(answer) && answer.available === true;

  /** One event of the answer → the closed row data, or null when it is not the shape we know. */
  function readEvent(event) {
    if (!isObject(event) || typeof event.title !== 'string' || typeof event.allDay !== 'boolean') return null;
    if (event.location !== null && event.location !== undefined && typeof event.location !== 'string') return null;
    const placed = place(event.start);
    if (!placed || placed.allDay !== event.allDay) return null;
    return { title: clean(event.title), location: clean(event.location) || null, placed };
  }

  /** The read event → one row of the card, or null when it is not today or tomorrow where the user is. */
  function rowOf(read, days) {
    const placed = read.placed;
    const at = days.indexOf(placed.day);
    if (at < 0) return null;
    const time = placed.allDay ? ALL_DAY : `${pad(Math.floor(placed.minutes / 60))}:${pad(placed.minutes % 60)}`;
    return {
      day: DAYS[at], title: read.title, location: read.location, time, allDay: placed.allDay,
      aria: `${DAYS[at]}, ${time === ALL_DAY ? ALL_DAY : 'a las ' + time}, ${read.title}${read.location ? ', ' + read.location : ''}`,
      rank: [at, placed.allDay ? 0 : 1, placed.minutes],
    };
  }

  /** A `calendar_action` answer → what the card paints. Off-shape is «unavailable», never a guess. */
  function cardView(answer, now) {
    if (!Number.isFinite(now)) return { kind: 'unavailable', reason: 'bad_answer' };
    if (!available(answer)) {
      const reason = isObject(answer) && REASONS.includes(answer.reason) ? answer.reason : 'bad_answer';
      return { kind: 'unavailable', reason };
    }
    if (!Array.isArray(answer.events) || !Number.isFinite(answer.fetchedAt)) return { kind: 'unavailable', reason: 'bad_answer' };
    const days = windowDays(now);
    const rows = [];
    for (const event of answer.events) {
      const read = readEvent(event);
      // an event we cannot read is a shape we do not know: the whole answer is refused, never a half card
      if (!read) return { kind: 'unavailable', reason: 'bad_answer' };
      const row = rowOf(read, days);
      if (row) rows.push(row); // readable, just outside today and tomorrow
    }
    rows.sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2]);
    return {
      kind: 'card', label: LABEL, note: NOTE, empty: rows.length === 0,
      emptyText: EMPTY, fetchedAt: answer.fetchedAt,
      rows: rows.map(r => ({ day: r.day, title: r.title, location: r.location, time: r.time, allDay: r.allDay, aria: r.aria })),
    };
  }

  // ── renderer: textContent only, no remote anything ─────────────────────────────────────────────────────────
  function render(host, view) {
    const doc = host && host.ownerDocument;
    if (!doc || typeof doc.createElement !== 'function' || typeof host.replaceChildren !== 'function') return;
    if (!isObject(view) || view.kind !== 'card') { host.replaceChildren(); host.hidden = true; return; }
    const el = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
    const card = el('div', 'int-card cal-card');
    const head = el('div', 'int-head');
    head.append(el('i', 'dot'), el('b', '', view.label), el('span', '', view.note));
    card.append(head);
    if (view.empty) card.append(el('div', 'int-empty', view.emptyText));
    else {
      const list = el('div', 'int-rows');
      for (const row of view.rows) {
        const line = el('div', 'int-row cal-row');
        line.setAttribute('aria-label', row.aria);
        const when = el('span', 'cal-day', row.day), time = el('span', 'cal-time', row.time);
        line.append(when, time, el('span', 'int-name', row.title));
        if (row.location) line.append(el('span', 'cal-where', row.location));
        list.append(line);
      }
      card.append(list);
    }
    host.replaceChildren(card);
    host.hidden = false;
  }

  const pausedNow = () => {
    const P = typeof module === 'object' && module.exports ? require('./paused.js') : (typeof window !== 'undefined' ? window.AbitoPaused : null);
    return !!(P && P.paused('calendar'));
  };

  return { CARD_ID, LABEL, ICON, NOTE, EMPTY, REASONS, DAYS, ALL_DAY, MAX_TEXT, POLL_MS, available, cardView, readEvent, render, place, windowDays, pausedNow };
});

function mount(api) {
  const doc = typeof document === 'object' ? document : null;
  const root = typeof window === 'object' ? window : null;
  if (!doc || !root) return;
  const internals = root.__TAURI_INTERNALS__;
  const label = internals && internals.metadata && internals.metadata.currentWindow && internals.metadata.currentWindow.label;
  const invoke = (root.__TAURI__ && root.__TAURI__.core && root.__TAURI__.core.invoke) || (internals && internals.invoke);
  // the host refuses any window but the island's; the settings window runs this same page, so stay inert there
  if (!invoke || label === 'settings') return;
  const shortcuts = root.AbitoShortcuts || null;
  if (!shortcuts) return;

  let view = { kind: 'unavailable', reason: 'not_configured' };
  let cardHost = null, timer = null, inFlight = false, drawn = null;
  const on = () => view.kind === 'card' && !api.pausedNow();
  const paint = () => {
    if (!cardHost) return;
    // a poll that changed nothing must not repaint the rows the user is looking at
    const next = JSON.stringify(view);
    if (next === drawn) return;
    drawn = next;
    api.render(cardHost, view);
  };
  // S3: the icon exists only while the answer is really available:true; a change repaints the row
  function settle(next) {
    const before = on();
    view = next;
    paint();
    if (on() !== before) shortcuts.refresh();
  }
  function refresh() {
    if (inFlight || doc.hidden) return;
    inFlight = true;
    invoke('calendar_action', { payload: { action: 'refresh' } })
      .then(answer => api.cardView(answer, Date.now()), () => api.cardView(null, Date.now()))
      .then(v => { inFlight = false; settle(v); }, () => { inFlight = false; });
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  shortcuts.registerCard({
    id: 'cal', label: 'Calendario', icon: 'cal',
    available: () => on(),
    mount: el => {
      const card = doc.createElement('div');
      card.className = 'cal-host';
      el.append(card);
      cardHost = card;
      drawn = null;
      paint();
      return () => { cardHost = null; drawn = null; card.replaceChildren(); if (card.parentNode) card.parentNode.removeChild(card); };
    },
  });

  doc.addEventListener('visibilitychange', () => { if (!doc.hidden) refresh(); });
  root.addEventListener('pagehide', stop);
  timer = setInterval(refresh, api.POLL_MS);
  refresh();
}
