'use strict';
/* #358 F044 — the n8n service card: workflow runs, run detail and an open-instance action. ONE
   file, the house pattern (integrations-view.js): pure view-model, textContent-only renderer, a
   LOUD fake provider, browser-only mount at the tail.

   FAKE DATA ONLY: no network, no account, no token. Every rendered view carries the visible
   «datos de ejemplo» marker while the frame says fake:true.

   MOUNT CONTRACT (index.html wiring — coordinator's approval needed): inert until the page has
     <section id="integrations-n8n" hidden></section>
   plus <script src="integrations-n8n.js" defer></script>. With the container absent it costs
   nothing.

   OPEN INSTANCE: the ONLY URL lives in the frozen ALLOWLIST below (a frame carrying a url, or any
   extra key, is refused whole). It opens only while the card is connected, and the renderer routes
   it through the EXISTING host command `open_chat_url`, which re-validates on the Rust side.
   test-node/integrations-n8n-check.cjs mirrors those rules on purpose. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = Object.freeze(api); return; }
  root.AbitoN8n = Object.freeze(api);
  mount(api);
})(typeof self !== 'undefined' ? self : this, () => {
  const SCHEMA = 'abito-integrations/n8n/1';
  const MAX_RUNS = 12;
  const MAX_WORKFLOW = 80;
  const MAX_MESSAGE = 240;
  const FAKE_BANNER = 'Datos de ejemplo — nada está conectado todavía.';
  const ID_RE = /^[a-z0-9-]{1,32}$/;

  const STATUSES = Object.freeze(['success', 'error', 'running', 'waiting']);
  const STATUS_LABELS = Object.freeze({ success: 'correcta', error: 'con error', running: 'en curso', waiting: 'en espera' });
  const STATES = Object.freeze(['disconnected', 'connected', 'error']);
  // closed URL allowlist: the frame NEVER carries a URL
  const ALLOWLIST = Object.freeze({ instance: 'https://n8n.io' });

  const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isStr = v => typeof v === 'string';
  const statusLabel = s => (STATUSES.includes(s) ? STATUS_LABELS[s] : null);
  const RUN_KEYS = ['id', 'workflow', 'status', 'startedAt', 'durationMs', 'message'];

  function ageLabel(ms) {
    if (!Number.isFinite(ms)) return null;
    if (ms < 60000) return 'hace un momento';
    if (ms < 3600000) return `hace ${Math.floor(ms / 60000)} min`;
    if (ms < 86400000) return `hace ${Math.floor(ms / 3600000)} h`;
    return `hace ${Math.floor(ms / 86400000)} d`;
  }
  function durationLabel(ms) {
    if (!Number.isFinite(ms) || ms < 0) return null;
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s} s`;
    if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
    return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  }

  const validRun = r => isObject(r)
    && Object.keys(r).length === RUN_KEYS.length && RUN_KEYS.every(k => k in r)
    && isStr(r.id) && ID_RE.test(r.id)
    && isStr(r.workflow) && r.workflow.length > 0 && r.workflow.length <= MAX_WORKFLOW
    && STATUSES.includes(r.status)
    && Number.isFinite(r.startedAt) && Number.isFinite(r.durationMs) && r.durationMs >= 0
    && isStr(r.message) && r.message.length <= MAX_MESSAGE;

  /** A closed `n8n` frame to a frozen list-mode store; anything off-shape is refused whole. */
  function storeFromFrame(frame) {
    if (!isObject(frame) || frame.type !== 'n8n' || frame.schema !== SCHEMA) return null;
    if (typeof frame.fake !== 'boolean' || !STATES.includes(frame.state) || !Array.isArray(frame.runs)) return null;
    if (!Object.keys(frame).every(k => ['type', 'schema', 'fake', 'state', 'runs'].includes(k))) return null;
    if (frame.runs.length > MAX_RUNS) return null;
    const seen = new Set();
    const runs = [];
    for (const r of frame.runs) {
      if (!validRun(r)) return null;
      if (seen.has(r.id)) continue; // duplicate: first wins
      seen.add(r.id);
      runs.push(Object.freeze(Object.fromEntries(RUN_KEYS.map(k => [k, r[k]]))));
    }
    return Object.freeze({ fake: frame.fake, state: frame.state, runs: Object.freeze(runs), selected: null });
  }

  const isStore = s => isObject(s) && typeof s.fake === 'boolean' && STATES.includes(s.state)
    && Array.isArray(s.runs) && (s.selected === null || isStr(s.selected));
  const withSelected = (store, selected) =>
    Object.freeze({ fake: store.fake, state: store.state, runs: store.runs, selected });

  function select(store, id) {
    if (!isStore(store) || !isStr(id) || !store.runs.some(r => r.id === id)) return null;
    return withSelected(store, id);
  }
  function back(store) {
    if (!isStore(store) || store.selected === null) return null;
    return withSelected(store, null);
  }

  /** The allowlisted instance URL, only for a connected card; nothing else ever opens. */
  function openTarget(store) {
    if (!isStore(store) || store.state !== 'connected') return null;
    return ALLOWLIST.instance;
  }

  function view(store, now) {
    if (!isStore(store) || !Number.isFinite(now)) return null;
    const rowOf = r => Object.freeze({ id: r.id, workflow: r.workflow, status: r.status,
      statusLabel: STATUS_LABELS[r.status], startedLabel: ageLabel(now - r.startedAt),
      durationLabel: durationLabel(r.durationMs), message: r.message });
    const rows = store.runs.map(rowOf);
    const detail = store.selected === null ? null : rows.find(r => r.id === store.selected) || null;
    return Object.freeze({ fake: store.fake, banner: store.fake ? FAKE_BANNER : null,
      mode: detail ? 'detail' : 'list', rows, detail, count: rows.length, canOpen: openTarget(store) !== null });
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
    if (id) b.dataset.id = id;
    return b;
  };

  function render(host, v) {
    if (!(host && typeof host.appendChild === 'function')) return;
    host.textContent = '';
    if (!v || !Array.isArray(v.rows)) { host.hidden = true; return; }
    host.hidden = false;
    const head = el('div', 'intw-head');
    head.append(el('span', 'intw-title', 'n8n'));
    head.append(el('span', 'intw-count', `${v.count} ejecuciones`));
    if (v.canOpen) head.append(btn('intw-open', 'open', null, 'Abrir instancia'));
    host.append(head);
    if (v.banner) host.append(el('p', 'intw-fake', v.banner));
    if (v.mode === 'detail' && v.detail) {
      const d = v.detail;
      const card = el('article', 'intw-card');
      card.append(el('h3', 'intw-card-title', d.workflow));
      card.append(el('span', `intw-status intw-status--${d.status}`, d.statusLabel));
      card.append(el('span', 'intw-meta', `Inició ${d.startedLabel} · duró ${d.durationLabel}`));
      card.append(el('p', 'intw-card-body', d.message || 'Sin mensajes.'));
      card.append(btn('intw-back', 'back', null, 'Volver a la lista'));
      host.append(card);
      return;
    }
    if (v.rows.length === 0) { host.append(el('p', 'intw-empty', 'No hay ejecuciones.')); return; }
    const list = el('ul', 'intw-list');
    for (const r of v.rows) {
      const li = el('li', 'intw-item');
      const b = btn('intw-row', 'select', r.id, null);
      b.append(el('span', 'intw-row-title', r.workflow),
        el('span', `intw-status intw-status--${r.status}`, r.statusLabel),
        el('span', 'intw-meta', r.startedLabel));
      li.append(b);
      list.append(li);
    }
    host.append(list);
  }

  // ---- fake provider (LOUD, deterministic, no network) -------------------------
  const FAKE_BASE = 1700000000000;
  const FAKE_RUNS = Object.freeze([
    ['ej-1', 'Alta de clientes', 'success', 2 * 60000, 2400, ''],
    ['ej-2', 'Backup nocturno', 'error', 3 * 3600000, 65000, 'Tiempo agotado en el nodo HTTP.'],
    ['ej-3', 'Resumen semanal', 'running', 30000, 12000, ''],
    ['ej-4', 'Aviso de facturas', 'waiting', 86400000, 0, 'Esperando aprobación manual.'],
  ]);
  function fakeFrame() {
    return { type: 'n8n', schema: SCHEMA, fake: true, state: 'connected',
      runs: FAKE_RUNS.map(([id, workflow, status, ago, durationMs, message]) =>
        ({ id, workflow, status, startedAt: FAKE_BASE - ago, durationMs, message })) };
  }

  return { SCHEMA, MAX_RUNS, MAX_WORKFLOW, MAX_MESSAGE, FAKE_BASE, STATUSES, STATES, ALLOWLIST,
    statusLabel, ageLabel, durationLabel, storeFromFrame, select, back, openTarget, view, render, fakeFrame };
});

// ---- browser-only wiring: self-mount into #integrations-n8n, FAKE provider only ----
function mount(N) {
  if (typeof document === 'undefined') return;
  const host = document.getElementById('integrations-n8n');
  if (!host) return; // inert until index.html carries the container (mount contract)
  const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)
    || (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) || null;
  let store = N.storeFromFrame(N.fakeFrame());
  const paint = () => N.render(host, N.view(store, N.FAKE_BASE)); // fake data is anchored: ages stay stable
  host.addEventListener('click', e => {
    if (!e || e.isTrusted !== true) return; // only trusted gestures change anything
    const target = e.target && typeof e.target.closest === 'function' ? e.target : null;
    const button = target ? target.closest('[data-action]') : null;
    if (!button || !host.contains(button)) return;
    const action = button.dataset.action;
    if (action === 'open') {
      // Through the EXISTING host command (re-validated in Rust). Without IPC: honest silence.
      const url = N.openTarget(store);
      if (url && invoke) invoke('open_chat_url', { payload: { url } }).catch(() => {});
      return;
    }
    const next = action === 'select' ? N.select(store, button.dataset.id) : action === 'back' ? N.back(store) : null;
    if (next) { store = next; paint(); }
  });
  paint();
}
