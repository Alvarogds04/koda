'use strict';
/* #354 F038/F039 — the Deployments service card: status, list and detail view. ONE
   file, the house pattern (integrations-view.js): the pure view-model, the
   textContent-only renderer, a FAKE dataset and a browser-only mount at the tail.

   FAKE DATA ONLY: nothing here talks to a network, opens an account, holds a token
   or touches a real service. Every rendered view carries the visible
   «Datos de ejemplo» marker. The card is fed by the #352 store: it shows data ONLY
   for an enabled, connected Deployments row; anything else yields no view.

   ---- MOUNT CONTRACT (index.html wiring — coordinator's approval needed) ----
   1. one container next to #integrations:  <section id="integrations-deployments" hidden></section>
   2. one script tag AFTER integrations-view.js:  <script src="integrations-deployments.js" defer></script>
   With the container absent the module costs nothing. Theme tokens only (style.css).

   Loaded as a classic script (window.AbitoDeployments) and by
   test-node/integrations-deployments-check.cjs through `module.exports`. */
(function (root, factory) {
  const V = typeof module === 'object' && module.exports ? require('./integrations-view.js') : root.AbitoIntegrations;
  const api = factory(V || null);
  if (typeof module === 'object' && module.exports) { module.exports = Object.freeze(api); return; }
  root.AbitoDeployments = Object.freeze(api);
  mount(api, V || null);
})(typeof self !== 'undefined' ? self : this, V => {
  const SCHEMA = 'abito-integrations/deployments/1';
  const MAX_ITEMS = 8;
  const MAX_TEXT = 60;

  const STATUSES = Object.freeze(['queued', 'building', 'ready', 'error']);
  const STATUS_LABELS = Object.freeze({ queued: 'en cola', building: 'construyendo', ready: 'listo', error: 'con error' });
  const ENVS = Object.freeze(['production', 'preview']);
  const ENV_LABELS = Object.freeze({ production: 'producción', preview: 'vista previa' });
  const FAKE_BANNER = 'Datos de ejemplo — nada está conectado todavía.';

  const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isStr = v => typeof v === 'string';
  const sameKeys = (o, keys) => Object.keys(o).length === keys.length && keys.every(k => Object.prototype.hasOwnProperty.call(o, k));
  const statusLabel = s => (isStr(s) && STATUSES.includes(s) ? STATUS_LABELS[s] : null);
  const envLabel = s => (isStr(s) && ENVS.includes(s) ? ENV_LABELS[s] : null);
  const text = v => isStr(v) && v.length > 0 && v.length <= MAX_TEXT;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  // ---- fake dataset (deterministic: no randomness, no clock) -------------------
  const ITEMS = [
    ['dpl-7f3a21', 'abito-web', 'main', '3fa91c2', 'production', 'ready', 74, 12],
    ['dpl-6b20de', 'abito-web', 'feat/island-drag', 'a07be45', 'preview', 'building', 18, 3],
    ['dpl-5c91b0', 'abito-docs', 'main', 'c4d8e10', 'production', 'error', 41, 95],
    ['dpl-4e17aa', 'abito-web', 'fix/settings-rail', '9b22f6d', 'preview', 'ready', 66, 240],
    ['dpl-3d08c5', 'abito-docs', 'docs/preview-channel', '1e5a7b3', 'preview', 'queued', 0, 1],
  ].map(([id, project, branch, sha, env, status, durationSec, ageMinutes]) =>
    Object.freeze({ id, project, branch, sha, env, status, durationSec, ageMinutes }));

  /** The deterministic FAKE dataset. Frozen, loud (fake:true), bounded. */
  function fakeDataset() {
    return Object.freeze({ schema: SCHEMA, fake: true, items: Object.freeze(ITEMS.slice()) });
  }

  /** Shape check: closed keys, closed vocabularies, unique ids, bounded sizes and text. */
  function isDataset(d) {
    if (!isObject(d) || !sameKeys(d, ['schema', 'fake', 'items'])) return false;
    if (d.schema !== SCHEMA || typeof d.fake !== 'boolean') return false;
    if (!Array.isArray(d.items) || d.items.length > MAX_ITEMS) return false;
    const ids = new Set();
    for (const i of d.items) {
      if (!isObject(i) || !sameKeys(i, ['id', 'project', 'branch', 'sha', 'env', 'status', 'durationSec', 'ageMinutes'])) return false;
      if (!text(i.id) || !text(i.project) || !text(i.branch) || ids.has(i.id)) return false;
      ids.add(i.id);
      if (!isStr(i.sha) || !/^[0-9a-f]{7}$/.test(i.sha)) return false;
      if (!ENVS.includes(i.env) || !STATUSES.includes(i.status)) return false;
      if (!Number.isInteger(i.durationSec) || i.durationSec < 0 || i.durationSec > 86400) return false;
      if (!Number.isInteger(i.ageMinutes) || i.ageMinutes < 0 || i.ageMinutes > 525600) return false;
    }
    return true;
  }

  // ---- view-model ----------------------------------------------------------------
  const ageLabel = m => (m < 1 ? 'hace instantes' : m < 60 ? `hace ${plural(m, 'minuto', 'minutos')}`
    : m < 1440 ? `hace ${plural(Math.floor(m / 60), 'hora', 'horas')}` : `hace ${plural(Math.floor(m / 1440), 'día', 'días')}`);
  const durationLabel = s => (s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`);
  const project = i => Object.freeze({
    id: i.id, project: i.project, branch: i.branch, sha: i.sha,
    env: i.env, envLabel: ENV_LABELS[i.env], status: i.status, statusLabel: STATUS_LABELS[i.status],
    durationLabel: durationLabel(i.durationSec), ageLabel: ageLabel(i.ageMinutes),
  });

  /** Whether the #352 store lets this card show data: enabled AND connected. */
  function available(store) {
    return !!(V && V.isStore(store) && store.services.deployments.enabled
      && store.services.deployments.state === 'connected');
  }

  /** One deployment in full; null for an unknown id or a bad dataset. */
  function detail(dataset, id) {
    if (!isDataset(dataset) || !isStr(id)) return null;
    const found = dataset.items.find(i => i.id === id);
    return found ? project(found) : null;
  }

  /**
   * The closed projection for the renderer. Null unless the store feeds the card
   * (enabled + connected Deployments row), the dataset is well-formed and `now` is
   * finite. `selected` is an optional deployment id whose detail rides along.
   */
  function view(store, dataset, now, selected) {
    if (!available(store) || !isDataset(dataset) || !Number.isFinite(now)) return null;
    const counts = { queued: 0, building: 0, ready: 0, error: 0 };
    for (const i of dataset.items) counts[i.status] += 1;
    const items = dataset.items.map(project);
    // headline = the newest deployment's status (the list is newest first)
    const head = items[0] || null;
    return Object.freeze({
      fake: dataset.fake, banner: dataset.fake ? FAKE_BANNER : null,
      items: Object.freeze(items), counts: Object.freeze(counts),
      headline: head ? Object.freeze({ status: head.status, statusLabel: head.statusLabel, project: head.project }) : null,
      detail: selected === undefined ? null : detail(dataset, selected),
    });
  }

  // ---- renderer (textContent only; events live in mount) -----------------------------
  const el = (tag, cls, txt) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt !== undefined && txt !== null) n.textContent = txt;
    return n;
  };

  /** Paints one closed view into `host`; null view clears and hides it. */
  function render(host, v) {
    if (!(host && typeof host.appendChild === 'function')) return;
    host.textContent = '';
    if (!v || !Array.isArray(v.items)) { host.hidden = true; return; }
    host.hidden = false;
    host.append(el('h3', 'id-title', 'Despliegues'));
    if (v.banner) host.append(el('p', 'id-fake', v.banner));
    const c = v.counts;
    host.append(el('p', 'id-status', v.headline
      ? `Último: ${v.headline.project} · ${v.headline.statusLabel} — ${c.ready} listos · ${c.building} construyendo · ${c.queued} en cola · ${c.error} con error`
      : 'Sin despliegues.'));
    const list = el('ul', 'id-list');
    for (const i of v.items) {
      const li = el('li', 'id-item');
      const b = el('button', 'id-row');
      b.type = 'button';
      b.dataset.action = 'select';
      b.dataset.id = i.id;
      b.setAttribute('aria-pressed', v.detail && v.detail.id === i.id ? 'true' : 'false');
      b.append(el('span', 'id-name', i.project), el('span', `id-chip id-chip--${i.status}`, i.statusLabel),
        el('span', 'id-meta', `${i.envLabel} · ${i.ageLabel}`));
      li.append(b);
      list.append(li);
    }
    host.append(list);
    if (v.detail) {
      const d = v.detail;
      const det = el('div', 'id-detail');
      det.setAttribute('role', 'status');
      det.append(el('span', 'id-detail-title', `${d.project} · ${d.statusLabel}`),
        el('span', 'id-meta', `Rama ${d.branch} · commit ${d.sha}`),
        el('span', 'id-meta', `${d.envLabel} · duración ${d.durationLabel} · ${d.ageLabel}`));
      host.append(det);
    }
  }

  return {
    SCHEMA, MAX_ITEMS, STATUSES, ENVS, statusLabel, envLabel,
    fakeDataset, isDataset, available, detail, view, render,
  };
});

// ---- browser-only wiring: self-mount into #integrations-deployments, FAKE dataset only ----
function mount(D, V) {
  if (typeof document === 'undefined' || !V) return;
  const host = document.getElementById('integrations-deployments');
  if (!host) return; // inert until index.html carries the container (mount contract)
  const dataset = D.fakeDataset();
  let selected;
  // The #352 store is not shared across modules yet: mirror a fake frame with Deployments
  // enabled + connected. The daemon frame replaces both providers at integration time.
  const store = V.storeFromFrame({ type: 'integrations', schema: V.SCHEMA, fake: true,
    services: [{ id: 'deployments', enabled: true, state: 'connected' }] });
  const paint = () => D.render(host, D.view(store, dataset, Date.now(), selected));
  host.addEventListener('click', e => {
    if (!e || e.isTrusted !== true) return; // only trusted gestures change anything
    const t = e.target && typeof e.target.closest === 'function' ? e.target.closest('[data-action="select"]') : null;
    if (!t || !host.contains(t)) return;
    const id = t.dataset.id;
    selected = selected === id ? undefined : id;
    paint();
  });
  paint();
}
