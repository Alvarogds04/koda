'use strict';
/* #355 F040 — the Correo card: an activity pulse (24 hourly buckets) plus a
   summary (counts and the latest senders). ONE file, the house pattern
   (integrations-view.js): pure view-model, textContent-only renderer, a FAKE
   provider, browser-only mount at the tail.

   FAKE DATA ONLY: nothing here talks to a network, opens an account, holds a
   token or touches a real service. Every rendered view carries the visible
   «datos de ejemplo» marker while the frame is fake, so sample senders can never
   be mistaken for real mail.

   ---- MOUNT CONTRACT (index.html wiring — coordinator's approval needed) ----
   1. one container inside the Ajustes body:  <section id="integrations-email" hidden></section>
   2. one script tag after integrations-view.js:  <script src="integrations-email.js" defer></script>
   With the container absent the module costs nothing. Styling: the append-only
   `.em-*` block in style.css uses theme tokens only (light + dark).

   Loaded as a classic script (window.AbitoEmail) and by
   test-node/integrations-email-check.cjs through `module.exports`. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = Object.freeze(api); return; }
  root.AbitoEmail = Object.freeze(api);
  mount(api);
})(typeof self !== 'undefined' ? self : this, () => {
  const SCHEMA = 'abito-email/view/1';
  const MAX_BUCKETS = 24; // one bucket per hour of the last day
  const MAX_SENDERS = 5;
  const MAX_NAME = 40;
  const MAX_COUNT = 9999;
  const MAX_AGO = 60 * 24 * 365; // minutes; a year is the horizon of the label
  const LEVELS = 4; // bar levels 1..4; 0 is silence
  const FAKE_BANNER = 'Datos de ejemplo — nada está conectado todavía.';
  const COUNT_LABELS = Object.freeze([['unread', 'sin leer'], ['received', 'recibidos'], ['sent', 'enviados']]);

  const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isCount = v => Number.isInteger(v) && v >= 0 && v <= MAX_COUNT;
  const onlyKeys = (o, keys) => Object.keys(o).every(k => keys.includes(k));

  /** A closed `email-activity` frame to a frozen store; anything off-shape is null. */
  function storeFromFrame(frame) {
    if (!isObject(frame) || frame.type !== 'email-activity' || frame.schema !== SCHEMA) return null;
    if (!onlyKeys(frame, ['type', 'schema', 'fake', 'pulse', 'counts', 'senders'])) return null;
    if (typeof frame.fake !== 'boolean') return null;
    if (!Array.isArray(frame.pulse) || frame.pulse.length !== MAX_BUCKETS || !frame.pulse.every(isCount)) return null;
    const c = frame.counts;
    if (!isObject(c) || Object.keys(c).length !== 3 || !COUNT_LABELS.every(([id]) => isCount(c[id]))) return null;
    if (!Array.isArray(frame.senders) || frame.senders.length > MAX_SENDERS) return null;
    for (const s of frame.senders) {
      if (!isObject(s) || !onlyKeys(s, ['name', 'minutesAgo']) || Object.keys(s).length !== 2) return null;
      if (typeof s.name !== 'string' || !s.name.trim() || Array.from(s.name).length > MAX_NAME) return null;
      if (!Number.isInteger(s.minutesAgo) || s.minutesAgo < 0 || s.minutesAgo > MAX_AGO) return null;
    }
    return Object.freeze({
      fake: frame.fake,
      pulse: Object.freeze(frame.pulse.slice()),
      counts: Object.freeze({ unread: c.unread, received: c.received, sent: c.sent }),
      senders: Object.freeze(frame.senders.map(s => Object.freeze({ name: s.name, minutesAgo: s.minutesAgo }))),
    });
  }

  /** «ahora» / «hace 5 min» / «hace 2 h» / «hace 2 d»; junk is null. */
  function agoLabel(minutes) {
    if (!Number.isInteger(minutes) || minutes < 0) return null;
    if (minutes === 0) return 'ahora';
    if (minutes < 60) return `hace ${minutes} min`;
    if (minutes < 60 * 24) return `hace ${Math.floor(minutes / 60)} h`;
    return `hace ${Math.floor(minutes / (60 * 24))} d`;
  }

  const levelOf = (count, peak) => (count <= 0 || peak <= 0 ? 0 : Math.max(1, Math.ceil((count / peak) * LEVELS)));

  /** The closed projection for the renderer; null for anything that is not a store. */
  function view(store) {
    if (!isObject(store) || typeof store.fake !== 'boolean' || !Array.isArray(store.pulse) ||
      store.pulse.length !== MAX_BUCKETS || !isObject(store.counts) || !Array.isArray(store.senders)) return null;
    const peak = Math.max(0, ...store.pulse);
    const total = store.pulse.reduce((a, b) => a + b, 0);
    return Object.freeze({
      fake: store.fake, banner: store.fake ? FAKE_BANNER : null, peak, total,
      pulse: Object.freeze(store.pulse.map((count, i) => Object.freeze({
        count, level: levelOf(count, peak), hoursAgo: MAX_BUCKETS - 1 - i }))),
      counts: Object.freeze(COUNT_LABELS.map(([id, label]) => Object.freeze({ id, label, value: store.counts[id] }))),
      senders: Object.freeze(store.senders.map(s => Object.freeze({ name: s.name, ago: agoLabel(s.minutesAgo) }))),
    });
  }

  // ---- fake provider (LOUD, deterministic, no network) ------------------------
  const FAKE_PULSE = Object.freeze([0, 0, 0, 0, 1, 0, 2, 5, 8, 6, 4, 3, 2, 3, 5, 4, 2, 1, 1, 0, 2, 1, 0, 0]);
  const FAKE_SENDERS = Object.freeze([
    ['Lucía Fernández', 4], ['Equipo de Facturación', 38], ['Martín Gómez', 95],
    ['Soporte Ejemplo', 410], ['Valentina Ruiz', 1500],
  ]);
  /** Deterministic fake frame; the tick rotates the pulse. Junk ticks yield null. */
  function fakeFrame(tick) {
    if (!Number.isInteger(tick) || tick < 0) return null;
    const shift = tick % MAX_BUCKETS;
    const pulse = FAKE_PULSE.map((_, i) => FAKE_PULSE[(i + shift) % MAX_BUCKETS]);
    return { type: 'email-activity', schema: SCHEMA, fake: true, pulse,
      counts: { unread: 7, received: pulse.reduce((a, b) => a + b, 0), sent: 6 },
      senders: FAKE_SENDERS.map(([name, minutesAgo]) => ({ name, minutesAgo })) };
  }

  // ---- renderer (textContent only) ---------------------------------------------
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  };

  function render(host, v) {
    if (!(host && typeof host.appendChild === 'function')) return;
    host.textContent = '';
    if (!v || !Array.isArray(v.pulse)) { host.hidden = true; return; }
    host.hidden = false;
    const head = el('div', 'em-head');
    head.append(el('span', 'em-title', 'Correo'));
    head.append(el('span', 'em-total', `${v.total} mensajes en 24 h`));
    host.append(head);
    if (v.banner) host.append(el('p', 'em-fake', v.banner));
    const pulse = el('div', 'em-pulse');
    pulse.setAttribute('role', 'img');
    pulse.setAttribute('aria-label', `Actividad de correo en las últimas 24 horas: ${v.total} mensajes, máximo ${v.peak} por hora`);
    for (const b of v.pulse) {
      const bar = el('span', `em-bar em-bar--${b.level}`);
      bar.dataset.count = String(b.count);
      pulse.append(bar);
    }
    host.append(pulse);
    const counts = el('dl', 'em-counts');
    for (const c of v.counts) {
      const item = el('div', 'em-count');
      item.append(el('dd', 'em-count-value', String(c.value)), el('dt', 'em-count-label', c.label));
      counts.append(item);
    }
    host.append(counts);
    host.append(el('h3', 'em-senders-title', 'Últimos remitentes'));
    const list = el('ul', 'em-senders');
    for (const s of v.senders) {
      const li = el('li', 'em-sender');
      li.append(el('span', 'em-sender-name', s.name), el('span', 'em-sender-ago', s.ago));
      list.append(li);
    }
    host.append(list);
  }

  return { SCHEMA, MAX_BUCKETS, MAX_SENDERS, MAX_NAME, MAX_COUNT, storeFromFrame, view, agoLabel, fakeFrame, render };
});

// ---- browser-only wiring: self-mount into #integrations-email, FAKE provider only ----
function mount(V) {
  if (typeof document === 'undefined') return;
  const host = document.getElementById('integrations-email');
  if (!host) return; // inert until index.html carries the container (mount contract)
  V.render(host, V.view(V.storeFromFrame(V.fakeFrame(0))));
}
