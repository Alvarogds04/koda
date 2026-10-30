'use strict';
/* #353 F037 — the GitHub service card: own PRs, reviews, CI state and an activity
   grid with per-day detail. ONE file, the house pattern (integrations-view.js): the
   pure view-model, the textContent-only renderer, a FAKE dataset and a browser-only
   mount at the tail.

   FAKE DATA ONLY: nothing here talks to a network, opens an account, holds a token
   or touches a real service. Every rendered view carries the visible
   «Datos de ejemplo» marker. The card is fed by the #352 store: it shows data ONLY
   for an enabled, connected GitHub row; anything else yields no view.

   ---- MOUNT CONTRACT (index.html wiring — coordinator's approval needed) ----
   1. one container next to #integrations:  <section id="integrations-github" hidden></section>
   2. one script tag AFTER integrations-view.js:  <script src="integrations-github.js" defer></script>
   With the container absent the module costs nothing. Theme tokens only (style.css).

   Loaded as a classic script (window.AbitoGithub) and by
   test-node/integrations-github-check.cjs through `module.exports`. */
(function (root, factory) {
  const V = typeof module === 'object' && module.exports ? require('./integrations-view.js') : root.AbitoIntegrations;
  const api = factory(V || null);
  if (typeof module === 'object' && module.exports) { module.exports = Object.freeze(api); return; }
  root.AbitoGithub = Object.freeze(api);
  mount(api, V || null);
})(typeof self !== 'undefined' ? self : this, V => {
  const SCHEMA = 'abito-integrations/github/1';
  const MAX_PRS = 8;
  const MAX_REVIEWS = 8;
  const GRID_DAYS = 35; // five weeks, oldest first, today last
  const DAY_MS = 86400000;
  const MAX_TEXT = 80;

  const CI_STATES = Object.freeze(['pass', 'fail', 'pending']);
  const CI_LABELS = Object.freeze({ pass: 'CI verde', fail: 'CI roto', pending: 'CI en curso' });
  const PR_STATES = Object.freeze(['open', 'draft', 'merged']);
  const PR_LABELS = Object.freeze({ open: 'abierto', draft: 'borrador', merged: 'integrado' });
  const FAKE_BANNER = 'Datos de ejemplo — nada está conectado todavía.';

  const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isStr = v => typeof v === 'string';
  const isCount = v => Number.isInteger(v) && v >= 0 && v <= 999;
  const sameKeys = (o, keys) => Object.keys(o).length === keys.length && keys.every(k => Object.prototype.hasOwnProperty.call(o, k));
  const ciLabel = s => (isStr(s) && CI_STATES.includes(s) ? CI_LABELS[s] : null);
  const prLabel = s => (isStr(s) && PR_STATES.includes(s) ? PR_LABELS[s] : null);

  // ---- fake dataset (deterministic: no randomness, no clock) -------------------
  const PRS = [
    [412, 'Add retry budget to the sync worker', 'open', 'pass', 2, 0],
    [409, 'Fix island drag on secondary monitor', 'open', 'fail', 1, 1],
    [405, 'Refactor settings tab rail', 'draft', 'pending', 0, 0],
    [398, 'Docs: describe the preview channel', 'open', 'pending', 0, 0],
    [391, 'Bump tauri plugin versions', 'merged', 'pass', 2, 0],
  ].map(([number, title, state, ci, approvals, changes]) =>
    Object.freeze({ number, title, state, ci, approvals, changes }));
  const REVIEWS = [
    [417, 'Handle empty transcript in digest', 'sample-dev-a', 1],
    [414, 'Throttle the sessions ticker', 'sample-dev-b', 3],
    [410, 'Compact the connections list', 'sample-dev-c', 6],
  ].map(([number, title, author, ageDays]) => Object.freeze({ number, title, author, ageDays }));
  const DAYS = Array.from({ length: GRID_DAYS }, (_, i) => Object.freeze({
    commits: (i * 7 + 3) % 6 === 0 ? 0 : (i * 7 + 3) % 6,
    prs: i % 5 === 2 ? 1 : 0,
    reviews: i % 4 === 1 ? 1 + (i % 2) : 0,
  }));

  /** The deterministic FAKE dataset. Frozen, loud (fake:true), bounded. */
  function fakeDataset() {
    return Object.freeze({ schema: SCHEMA, fake: true,
      prs: Object.freeze(PRS.slice()), reviews: Object.freeze(REVIEWS.slice()), days: Object.freeze(DAYS.slice()) });
  }

  /** Shape check: closed keys, closed vocabularies, bounded sizes and text. */
  function isDataset(d) {
    if (!isObject(d) || !sameKeys(d, ['schema', 'fake', 'prs', 'reviews', 'days'])) return false;
    if (d.schema !== SCHEMA || typeof d.fake !== 'boolean') return false;
    if (!Array.isArray(d.prs) || d.prs.length > MAX_PRS) return false;
    if (!Array.isArray(d.reviews) || d.reviews.length > MAX_REVIEWS) return false;
    if (!Array.isArray(d.days) || d.days.length !== GRID_DAYS) return false;
    const text = v => isStr(v) && v.length > 0 && v.length <= MAX_TEXT;
    for (const p of d.prs) {
      if (!isObject(p) || !sameKeys(p, ['number', 'title', 'state', 'ci', 'approvals', 'changes'])) return false;
      if (!isCount(p.number) || !text(p.title) || !PR_STATES.includes(p.state) || !CI_STATES.includes(p.ci)) return false;
      if (!isCount(p.approvals) || !isCount(p.changes)) return false;
    }
    for (const r of d.reviews) {
      if (!isObject(r) || !sameKeys(r, ['number', 'title', 'author', 'ageDays'])) return false;
      if (!isCount(r.number) || !text(r.title) || !text(r.author) || !isCount(r.ageDays)) return false;
    }
    return d.days.every(x => isObject(x) && sameKeys(x, ['commits', 'prs', 'reviews'])
      && isCount(x.commits) && isCount(x.prs) && isCount(x.reviews));
  }

  // ---- view-model ----------------------------------------------------------------
  const isoDay = (now, index) => new Date(Math.floor(now / DAY_MS) * DAY_MS - (GRID_DAYS - 1 - index) * DAY_MS)
    .toISOString().slice(0, 10);
  const levelOf = n => (n <= 0 ? 0 : n <= 2 ? 1 : n <= 4 ? 2 : n <= 6 ? 3 : 4);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  /** Whether the #352 store lets this card show data: enabled AND connected. */
  function available(store) {
    return !!(V && V.isStore(store) && store.services.github.enabled && store.services.github.state === 'connected');
  }

  /** One day of the grid, broken down by kind; null for a bad index/timestamp/dataset. */
  function dayDetail(dataset, index, now) {
    if (!isDataset(dataset) || !Number.isInteger(index) || index < 0 || index >= GRID_DAYS || !Number.isFinite(now)) return null;
    const x = dataset.days[index];
    const count = x.commits + x.prs + x.reviews;
    return Object.freeze({
      index, date: isoDay(now, index), count,
      label: `${isoDay(now, index)} · ${plural(count, 'contribución', 'contribuciones')}`,
      items: Object.freeze([
        Object.freeze({ kind: 'commits', label: plural(x.commits, 'commit', 'commits') }),
        Object.freeze({ kind: 'prs', label: plural(x.prs, 'pull request', 'pull requests') }),
        Object.freeze({ kind: 'reviews', label: plural(x.reviews, 'revisión', 'revisiones') }),
      ]),
    });
  }

  /**
   * The closed projection for the renderer. Null unless the store feeds the card
   * (enabled + connected GitHub row), the dataset is well-formed and `now` is finite.
   * `selected` is an optional grid index whose detail rides along.
   */
  function view(store, dataset, now, selected) {
    if (!available(store) || !isDataset(dataset) || !Number.isFinite(now)) return null;
    const ci = { pass: 0, fail: 0, pending: 0 };
    for (const p of dataset.prs) if (p.state !== 'merged') ci[p.ci] += 1;
    const days = dataset.days.map((x, index) => {
      const count = x.commits + x.prs + x.reviews;
      return Object.freeze({ index, date: isoDay(now, index), count, level: levelOf(count) });
    });
    return Object.freeze({
      fake: dataset.fake, banner: dataset.fake ? FAKE_BANNER : null,
      prs: Object.freeze(dataset.prs.map(p => Object.freeze({
        number: p.number, title: p.title, state: p.state, stateLabel: PR_LABELS[p.state],
        ci: p.ci, ciLabel: CI_LABELS[p.ci], approvals: p.approvals, changes: p.changes,
        reviewsLabel: `${plural(p.approvals, 'aprobación', 'aprobaciones')} · ${plural(p.changes, 'cambio pedido', 'cambios pedidos')}`,
      }))),
      reviews: Object.freeze(dataset.reviews.map(r => Object.freeze({
        number: r.number, title: r.title, author: r.author,
        ageLabel: r.ageDays === 0 ? 'hoy' : `hace ${plural(r.ageDays, 'día', 'días')}`,
      }))),
      ci: Object.freeze(ci),
      grid: Object.freeze({ days: Object.freeze(days), total: days.reduce((n, d) => n + d.count, 0) }),
      detail: selected === undefined ? null : dayDetail(dataset, selected, now),
    });
  }

  // ---- renderer (textContent only; events live in mount) -----------------------------
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  };

  /** Paints one closed view into `host`; null view clears and hides it. */
  function render(host, v) {
    if (!(host && typeof host.appendChild === 'function')) return;
    host.textContent = '';
    if (!v || !Array.isArray(v.prs)) { host.hidden = true; return; }
    host.hidden = false;
    host.append(el('h3', 'ig-title', 'GitHub'));
    if (v.banner) host.append(el('p', 'ig-fake', v.banner));
    const ciLine = `${v.ci.pass} verdes · ${v.ci.fail} rotos · ${v.ci.pending} en curso`;
    host.append(el('p', 'ig-ci', ciLine));

    host.append(el('h4', 'ig-sub', 'Mis pull requests'));
    const prs = el('ul', 'ig-list');
    for (const p of v.prs) {
      const li = el('li', 'ig-row');
      li.append(el('span', 'ig-num', `#${p.number}`), el('span', 'ig-name', p.title),
        el('span', `ig-chip ig-chip--${p.ci}`, p.ciLabel), el('span', 'ig-meta', `${p.stateLabel} · ${p.reviewsLabel}`));
      prs.append(li);
    }
    host.append(prs);

    host.append(el('h4', 'ig-sub', 'Revisiones pendientes'));
    const reviews = el('ul', 'ig-list');
    for (const r of v.reviews) {
      const li = el('li', 'ig-row');
      li.append(el('span', 'ig-num', `#${r.number}`), el('span', 'ig-name', r.title),
        el('span', 'ig-meta', `${r.author} · ${r.ageLabel}`));
      reviews.append(li);
    }
    host.append(reviews);

    host.append(el('h4', 'ig-sub', `Actividad · ${v.grid.total} en cinco semanas`));
    const grid = el('div', 'ig-grid');
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', 'Actividad de los últimos 35 días');
    for (const d of v.grid.days) {
      const b = el('button', `ig-day ig-day--${d.level}`);
      b.type = 'button';
      b.dataset.action = 'day';
      b.dataset.index = String(d.index);
      b.setAttribute('aria-label', `${d.date}: ${d.count}`);
      b.setAttribute('aria-pressed', v.detail && v.detail.index === d.index ? 'true' : 'false');
      grid.append(b);
    }
    host.append(grid);
    if (v.detail) {
      const det = el('div', 'ig-detail');
      det.setAttribute('role', 'status');
      det.append(el('span', 'ig-detail-title', v.detail.label));
      for (const i of v.detail.items) det.append(el('span', 'ig-meta', i.label));
      host.append(det);
    }
  }

  return {
    SCHEMA, MAX_PRS, MAX_REVIEWS, GRID_DAYS, CI_STATES, PR_STATES,
    ciLabel, prLabel, fakeDataset, isDataset, available, dayDetail, view, render,
  };
});

// ---- browser-only wiring: self-mount into #integrations-github, FAKE dataset only ----
function mount(G, V) {
  if (typeof document === 'undefined' || !V) return;
  const host = document.getElementById('integrations-github');
  if (!host) return; // inert until index.html carries the container (mount contract)
  const dataset = G.fakeDataset();
  let selected;
  // The #352 store is not shared across modules yet: mirror its fake frame so the card
  // follows the same seed (GitHub enabled + connected). The daemon frame replaces both.
  const store = V.storeFromFrame(V.fakeFrame());
  const paint = () => G.render(host, G.view(store, dataset, Date.now(), selected));
  host.addEventListener('click', e => {
    if (!e || e.isTrusted !== true) return; // only trusted gestures change anything
    const t = e.target && typeof e.target.closest === 'function' ? e.target.closest('[data-action="day"]') : null;
    if (!t || !host.contains(t)) return;
    const i = Number(t.dataset.index);
    if (!Number.isInteger(i)) return;
    selected = selected === i ? undefined : i;
    paint();
  });
  paint();
}
