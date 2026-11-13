'use strict';
/* K2-11 S2/S3/S6 (design/k2-09-atajos/08-isla-unida.html F5/F6, decision 9a) — the CALENDAR card of the island's shortcuts row
   (island-shortcuts.js, the part built by K2-09). One ICS subscription URL in the keychain (src/calendar.rs, never here), one
   read-only verb:

     invoke('calendar_action', {payload:{action:'refresh'}})
       -> {available:true, events:[{title,location,allDay,start:{date,time,tz},end:{...}}], fetchedAt}
       -> {available:false, reason:'not_configured'|'bad_url'|'unreachable'|'refused'|'bad_answer'}

   The host fetches a UTC window of [today-1, today+3]; THIS file keeps the events that COVER today or tomorrow in the user's own
   zone (L5) and paints them with their time. An event covers days, not only its start day: an all-day event spans
   [start day, end day) — the end is EXCLUSIVE, so 30-jun→03-jul is on every day in between — and a timed event that began before
   today still covers it, shown under «Hoy» as «Hasta HH:MM» with the time it ends. A stamp with tz 'UTC' is an instant, so it is
   converted to local; a stamp with a TZID or none (floating) has no zone database behind it, so its written wall time is shown as
   written. An all-day stamp is a date, never an instant.
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
  const HASTA = 'Hasta';
  const MAX_TEXT = 200;
  const POLL_MS = 60000; // the host caches a fetch for 5 min; a minute is what shows a new event soon after it is added
  const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  /** C0/C1 controls PLUS the bidi overrides, zero-width and separator characters a title can carry from outside (an invitation
      writes the title, not us): control characters are text, never direction, so each one becomes a space and the result is capped. */
  const HOSTILE = /[\u0000-\u001f\u007f-\u009f\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;
  const clean = (v, max = MAX_TEXT) => (typeof v === 'string' ? [...v.replace(HOSTILE, ' ').trim()].slice(0, max).join('') : '');
  const pad = n => String(n).padStart(2, '0');
  const DAY_MS = 86400000;
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

  /** Milliseconds that `zone` is ahead of UTC at `instant`, read from the WebView's own zone database; null for a zone it does not know. */
  function zoneOffset(zone, instant) {
    try {
      const parts = {};
      for (const p of new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(instant))) parts[p.type] = Number(p.value);
      return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(instant / 1000) * 1000;
    } catch { return null; }
  }

  /** The instant (ms) of a wall time written in `zone` (a TZID), or null when the zone is unknown. A local time that exists once
      resolves to that instant; a DST gap (a time that never happens) resolves with the offset in force BEFORE the gap, and an
      overlap (a time that happens twice) to its FIRST occurrence — the larger offset — as RFC 5545 asks. */
  function zonedInstant(zone, wallUtc) {
    const before = zoneOffset(zone, wallUtc - DAY_MS), after = zoneOffset(zone, wallUtc + DAY_MS);
    if (before === null || after === null) return null;
    // every offset around this wall time is a candidate; the ones that read back as themselves are the real occurrences
    const real = [before, after].filter((offset, i, all) => all.indexOf(offset) === i)
      .filter(offset => zoneOffset(zone, wallUtc - offset) === offset);
    if (real.length) return wallUtc - Math.max(...real); // ambiguous (fall back): the first occurrence has the larger offset
    return wallUtc - before; // the gap: the offset before it, as RFC 5545 says
  }

  const localPlace = at => ({ day: key(at.getFullYear(), at.getMonth() + 1, at.getDate()), minutes: at.getHours() * 60 + at.getMinutes(), allDay: false });

  /** One Stamp of the answer → {day, minutes, allDay} in the user's zone, or null when it is not the shape we know. */
  function place(stamp) {
    if (!isObject(stamp)) return null;
    const date = parseDate(stamp.date);
    if (!date) return null;
    if (stamp.time === null || stamp.time === undefined) return { day: key(date.y, date.m, date.d), minutes: 0, allDay: true };
    const time = parseTime(stamp.time);
    if (!time) return null;
    if (stamp.tz !== null && stamp.tz !== undefined && typeof stamp.tz !== 'string') return null;
    // 'UTC' is an instant and a TZID is a wall time in that zone: both move to this machine's zone. A floating stamp, or a zone the
    // database does not know (a Windows name, a typo), stays as written.
    if (typeof stamp.tz === 'string' && stamp.tz) {
      const wall = Date.UTC(date.y, date.m - 1, date.d, time.h, time.mi, time.s);
      const instant = stamp.tz === 'UTC' ? wall : zonedInstant(stamp.tz, wall);
      if (instant !== null) {
        const at = new Date(instant);
        if (Number.isNaN(at.getTime())) return null;
        return localPlace(at);
      }
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

  /** One event of the answer → the closed row data, or null when it is not the shape we know. The end is read as well as the
      start: the days an event covers come from both. */
  function readEvent(event) {
    if (!isObject(event) || typeof event.title !== 'string' || typeof event.allDay !== 'boolean') return null;
    if (event.location !== null && event.location !== undefined && typeof event.location !== 'string') return null;
    const placed = place(event.start), ended = place(event.end);
    if (!placed || !ended) return null;
    // an all-day event has all-day ends and a timed one has timed ends: anything else is a shape we do not know
    if (placed.allDay !== event.allDay || ended.allDay !== event.allDay) return null;
    return { title: clean(event.title), location: clean(event.location) || null, placed, ended };
  }

  const clock = placed => `${pad(Math.floor(placed.minutes / 60))}:${pad(placed.minutes % 60)}`;
  /** One covered day → one row of the card (the fields are closed; nothing of the event rides along beyond them). */
  function rowAt(read, at, time, spoken, rank) {
    return {
      day: DAYS[at], title: read.title, location: read.location, time, allDay: rank[1] === 0,
      aria: `${DAYS[at]}, ${spoken}, ${read.title}${read.location ? ', ' + read.location : ''}`, rank,
    };
  }

  /** The read event → the rows it paints, one for each of today/tomorrow it COVERS (zero, one or two). */
  function rowsOf(read, days) {
    const out = [];
    if (read.placed.allDay) {
      // an all-day event spans [start day, end day), end exclusive; the keys are YYYY-MM-DD, so comparing them is comparing dates
      for (let at = 0; at < days.length; at += 1) {
        if (days[at] >= read.placed.day && days[at] < read.ended.day) out.push(rowAt(read, at, ALL_DAY, ALL_DAY, [at, 0, 0]));
      }
      return out;
    }
    const at = days.indexOf(read.placed.day);
    if (at >= 0) {
      const time = clock(read.placed);
      out.push(rowAt(read, at, time, `a las ${time}`, [at, 1, read.placed.minutes]));
      return out;
    }
    // it began before today: it still covers today while its end is after 00:00 here, and the time column says until when
    const today = days[0];
    const covers = read.ended.day > today || (read.ended.day === today && read.ended.minutes > 0);
    if (read.placed.day < today && covers) {
      const until = clock(read.ended);
      out.push(rowAt(read, 0, `${HASTA} ${until}`, `hasta las ${until}`, [0, 1, 0]));
    }
    return out;
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
      for (const row of rowsOf(read, days)) rows.push(row); // readable, just outside today and tomorrow
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

  return { CARD_ID, LABEL, ICON, NOTE, EMPTY, REASONS, DAYS, ALL_DAY, MAX_TEXT, POLL_MS, available, cardView, readEvent, render, place, windowDays, zonedInstant, pausedNow };
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
    // a hidden page and a paused card both stay quiet: GitHub does exactly the same with its own switch (K2-11 S6)
    if (inFlight || doc.hidden || api.pausedNow()) return;
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
