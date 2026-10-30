'use strict';
/* #369 F101/F102 — the Finance service card: price tiles with text sparklines,
   alert thresholds as a pure model, and a portfolio list of accounts/wallets.
   ONE file, the house pattern (integrations-view.js): the pure model, the
   textContent-only renderer and a FAKE provider, browser-only at the tail.

   STRICTLY READ-ONLY: no trading verb exists. Nothing buys, sells, swaps,
   transfers, withdraws or places an order; the only control is «Actualizar»,
   which cycles the FAKE provider's connection state. FAKE DATA ONLY: no network,
   no account, no token, no real service, no account identifiers. Every rendered
   view of a fake model carries the visible «Datos de ejemplo» banner (the same
   copy as the #352 framework).

   The sparkline is pure text (block characters 8 levels) written with
   textContent: no canvas, no SVG, no markup. Alert thresholds are DATA in the
   model (above / below a price, inclusive) evaluated by a pure function; nothing
   here notifies, schedules or acts on one — it only marks the tile.

   Plugs into the #352 framework (window.AbitoIntegrations) for the closed
   connection vocabulary and the fake refresh outcomes. Never modifies it. Load it
   AFTER integrations-view.js.

   ---- MOUNT CONTRACT (index.html wiring — coordinator's approval needed) ----
   1. a container of its own (the framework repaints #integrations wholesale):
        <section id="integrations-finance" hidden></section>
   2. one script tag after integrations-view.js:
        <script src="integrations-finance.js" defer></script>
   With the container absent the module costs nothing. Styling: the append-only
   `.fin-*` block in style.css (theme tokens only).

   Loaded as a classic script (window.AbitoFinance) and by
   test-node/integrations-finance-check.cjs through `module.exports`. */
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const F = isNode ? require('./integrations-view.js') : root.AbitoIntegrations;
  if (!F) return; // the framework is not loaded: inert, never half-working
  const api = factory(F);
  if (isNode) { module.exports = Object.freeze(api); return; }
  root.AbitoFinance = Object.freeze(api);
  mount(api, F);
})(typeof self !== 'undefined' ? self : this, F => {
  const SCHEMA = 'abito-integrations/finance/1';
  const TYPE = 'integrations-finance';
  const MAX_QUOTES = 8;
  const MAX_ACCOUNTS = 8;
  const MAX_THRESHOLDS = 16;
  const MAX_POINTS = 24;
  const MAX_TEXT = 40;
  const SYMBOL_RE = /^[A-Z0-9]{1,8}$/;
  const ID_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;

  const BANNER = 'Datos de ejemplo — nada está conectado todavía.';
  const BLOCKS = '▁▂▃▄▅▆▇█';

  const ACCOUNT_KINDS = Object.freeze(['account', 'wallet']);
  const KIND_LABELS = Object.freeze({ account: 'cuenta', wallet: 'billetera' });
  const CURRENCIES = Object.freeze({ EUR: '€', USD: 'US$' });
  const NOTES = Object.freeze({
    disconnected: 'Finanzas está sin conectar.',
    error: 'No se pudo leer Finanzas.',
    paused: 'En pausa: se muestra la última lectura.',
  });

  const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const isCurrency = c => typeof c === 'string' && has(CURRENCIES, c);
  const isMinor = n => Number.isSafeInteger(n) && n >= 0;
  const onlyKeys = (o, keys) => Object.keys(o).every(k => keys.includes(k));
  const kindLabel = k => (typeof k === 'string' && has(KIND_LABELS, k) ? KIND_LABELS[k] : null);

  // ---- text formatting (deterministic, no Intl) ---------------------------------
  const group = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  /** Integer minor units to «1.234,50 €»; null for anything else. */
  function formatMoney(minor, currency) {
    if (!Number.isSafeInteger(minor) || !isCurrency(currency)) return null;
    const abs = Math.abs(minor);
    return `${minor < 0 ? '-' : ''}${group(Math.floor(abs / 100))},${String(abs % 100).padStart(2, '0')} ${CURRENCIES[currency]}`;
  }
  /** Signed percent between two minor-unit prices: «+1,25 %»; null without a positive base. */
  function formatChange(base, now) {
    if (!Number.isSafeInteger(base) || base <= 0 || !Number.isSafeInteger(now) || now < 0) return null;
    const bp = Math.round(((now - base) * 10000) / base);
    const abs = Math.abs(bp);
    const sign = bp > 0 ? '+' : bp < 0 ? '-' : '';
    return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')} %`;
  }

  /** Pure text sparkline over 1..MAX_POINTS safe integers; null for anything else. */
  function sparkline(series) {
    if (!Array.isArray(series) || series.length === 0 || series.length > MAX_POINTS) return null;
    if (!series.every(Number.isSafeInteger)) return null;
    const min = Math.min(...series);
    const max = Math.max(...series);
    return series.map(v => BLOCKS[max === min ? 3 : Math.round(((v - min) / (max - min)) * 7)]).join('');
  }

  // ---- frame -> frozen model -------------------------------------------------------
  /**
   * A closed finance frame to a frozen model. Anything off-shape (unknown key, bad
   * symbol, non-integer or negative amount, oversized list, duplicate id, a
   * threshold without a known quote or a bound, any trading or identifier key)
   * returns null: nothing is half-built or repaired.
   */
  function modelFromFrame(frame) {
    if (!isObject(frame) || frame.type !== TYPE || frame.schema !== SCHEMA) return null;
    if (!onlyKeys(frame, ['type', 'schema', 'fake', 'state', 'quotes', 'thresholds', 'accounts'])) return null;
    if (typeof frame.fake !== 'boolean' || !F.STATES.includes(frame.state)) return null;
    if (!Array.isArray(frame.quotes) || frame.quotes.length > MAX_QUOTES) return null;
    if (!Array.isArray(frame.thresholds) || frame.thresholds.length > MAX_THRESHOLDS) return null;
    if (!Array.isArray(frame.accounts) || frame.accounts.length > MAX_ACCOUNTS) return null;

    const symbols = new Set();
    const quotes = [];
    for (const q of frame.quotes) {
      if (!isObject(q) || !onlyKeys(q, ['symbol', 'name', 'currency', 'priceMinor', 'series'])) return null;
      if (typeof q.symbol !== 'string' || !SYMBOL_RE.test(q.symbol) || symbols.has(q.symbol)) return null;
      if (typeof q.name !== 'string' || q.name.length === 0 || q.name.length > MAX_TEXT) return null;
      if (!isCurrency(q.currency) || !isMinor(q.priceMinor)) return null;
      if (sparkline(q.series) === null || !q.series.every(isMinor)) return null;
      symbols.add(q.symbol);
      quotes.push(Object.freeze({ symbol: q.symbol, name: q.name, currency: q.currency,
        priceMinor: q.priceMinor, series: Object.freeze(q.series.slice()) }));
    }

    const thresholds = [];
    for (const t of frame.thresholds) {
      if (!isObject(t) || !onlyKeys(t, ['symbol', 'above', 'below'])) return null;
      if (typeof t.symbol !== 'string' || !symbols.has(t.symbol)) return null;
      const hasAbove = has(t, 'above');
      const hasBelow = has(t, 'below');
      if (!hasAbove && !hasBelow) return null;
      if (hasAbove && !isMinor(t.above)) return null;
      if (hasBelow && !isMinor(t.below)) return null;
      const out = { symbol: t.symbol };
      if (hasAbove) out.above = t.above;
      if (hasBelow) out.below = t.below;
      thresholds.push(Object.freeze(out));
    }

    const ids = new Set();
    const accounts = [];
    for (const a of frame.accounts) {
      if (!isObject(a) || !onlyKeys(a, ['id', 'label', 'kind', 'currency', 'balanceMinor'])) return null;
      if (typeof a.id !== 'string' || !ID_RE.test(a.id) || ids.has(a.id)) return null;
      if (typeof a.label !== 'string' || a.label.length === 0 || a.label.length > MAX_TEXT) return null;
      if (!ACCOUNT_KINDS.includes(a.kind) || !isCurrency(a.currency) || !isMinor(a.balanceMinor)) return null;
      ids.add(a.id);
      accounts.push(Object.freeze({ id: a.id, label: a.label, kind: a.kind, currency: a.currency, balanceMinor: a.balanceMinor }));
    }

    return Object.freeze({ fake: frame.fake, state: frame.state, quotes: Object.freeze(quotes),
      thresholds: Object.freeze(thresholds), accounts: Object.freeze(accounts) });
  }

  const isModel = m => isObject(m) && typeof m.fake === 'boolean' && F.STATES.includes(m.state)
    && Array.isArray(m.quotes) && Array.isArray(m.thresholds) && Array.isArray(m.accounts);

  /** The refresh outcome: a copy with a new closed connection state, or null. */
  function withState(model, state) {
    if (!isModel(model) || !F.STATES.includes(state)) return null;
    return Object.freeze({ fake: model.fake, state, quotes: model.quotes, thresholds: model.thresholds, accounts: model.accounts });
  }

  // ---- alerts: a pure function of prices and thresholds ------------------------------
  /**
   * Which thresholds are crossed right now. `above` fires when price >= limit,
   * `below` when price <= limit (both inclusive), in threshold order and above
   * before below. A threshold whose quote is absent never fires. Pure and
   * deterministic: it only reports, it never notifies or acts.
   */
  function evaluateAlerts(quotes, thresholds) {
    if (!Array.isArray(quotes) || !Array.isArray(thresholds)) return null;
    const out = [];
    for (const t of thresholds) {
      const q = quotes.find(x => x && x.symbol === t.symbol);
      if (!q) continue;
      if (has(t, 'above') && q.priceMinor >= t.above) out.push(Object.freeze({ symbol: t.symbol, kind: 'above', limit: t.above }));
      if (has(t, 'below') && q.priceMinor <= t.below) out.push(Object.freeze({ symbol: t.symbol, kind: 'below', limit: t.below }));
    }
    return Object.freeze(out);
  }

  // ---- view (what the renderer paints) --------------------------------------------------
  function view(model) {
    if (!isModel(model)) return null;
    const showData = model.state === 'connected' || model.state === 'paused';
    let tiles = [];
    let alerts = [];
    let portfolio = [];
    let totals = [];
    if (showData) {
      alerts = evaluateAlerts(model.quotes, model.thresholds) || [];
      tiles = model.quotes.map(q => {
        const hit = alerts.find(a => a.symbol === q.symbol);
        const limit = hit ? formatMoney(hit.limit, q.currency) : null;
        return Object.freeze({
          symbol: q.symbol, name: q.name, price: formatMoney(q.priceMinor, q.currency),
          change: formatChange(q.series[0], q.priceMinor), spark: sparkline(q.series),
          alert: hit ? `${hit.kind === 'above' ? 'Sobre el techo de' : 'Bajo el piso de'} ${limit}` : null,
        });
      });
      portfolio = model.accounts.map(a => Object.freeze({
        id: a.id, label: a.label, kind: a.kind, kindLabel: KIND_LABELS[a.kind], balance: formatMoney(a.balanceMinor, a.currency),
      }));
      const sums = new Map();
      for (const a of model.accounts) sums.set(a.currency, (sums.get(a.currency) || 0) + a.balanceMinor);
      totals = [...sums].map(([currency, sum]) => Object.freeze({ currency, total: formatMoney(sum, currency) }));
    }
    return Object.freeze({
      fake: model.fake, banner: model.fake ? BANNER : null,
      state: model.state, stateLabel: F.stateLabel(model.state), showData,
      note: has(NOTES, model.state) ? NOTES[model.state] : null,
      tiles: Object.freeze(tiles), alerts: Object.freeze(alerts), alertCount: alerts.length,
      portfolio: Object.freeze(portfolio), totals: Object.freeze(totals),
    });
  }

  // ---- renderer (textContent only; the click lives in mount) ------------------------------
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  };

  function render(host, v) {
    if (!(host && typeof host.appendChild === 'function')) return;
    if (!v || !Array.isArray(v.tiles) || !Array.isArray(v.portfolio)) {
      host.textContent = '';
      host.hidden = true;
      return;
    }
    host.textContent = '';
    host.hidden = false;
    const head = el('div', 'fin-head');
    head.append(el('span', 'fin-title', 'Finanzas'));
    head.append(el('span', `fin-state fin-state--${v.state}`, v.stateLabel));
    const refresh = el('button', 'fin-refresh', 'Actualizar');
    refresh.type = 'button';
    refresh.dataset.action = 'refresh';
    head.append(refresh);
    host.append(head);
    if (v.banner) host.append(el('p', 'fin-fake', v.banner));
    if (v.note) host.append(el('p', 'fin-note', v.note));
    if (v.tiles.length) {
      const grid = el('div', 'fin-tiles');
      for (const t of v.tiles) {
        const tile = el('article', t.alert ? 'fin-tile fin-tile--alert' : 'fin-tile');
        tile.dataset.symbol = t.symbol;
        const top = el('div', 'fin-tile-top');
        top.append(el('span', 'fin-symbol', t.symbol));
        top.append(el('span', 'fin-name', t.name));
        tile.append(top);
        tile.append(el('span', 'fin-price', t.price));
        tile.append(el('span', 'fin-change', t.change === null ? '—' : t.change));
        const spark = el('span', 'fin-spark', t.spark);
        spark.setAttribute('aria-hidden', 'true'); // decorative: price and change carry the meaning
        tile.append(spark);
        if (t.alert) tile.append(el('span', 'fin-alert', t.alert));
        grid.append(tile);
      }
      host.append(grid);
    }
    if (v.portfolio.length) {
      host.append(el('h3', 'fin-subtitle', 'Cartera'));
      const list = el('ul', 'fin-list');
      for (const r of v.portfolio) {
        const li = el('li', 'fin-row');
        li.dataset.accountId = r.id;
        li.append(el('span', 'fin-label', r.label));
        li.append(el('span', 'fin-kind', r.kindLabel));
        li.append(el('span', 'fin-balance', r.balance));
        list.append(li);
      }
      host.append(list);
      const totals = el('div', 'fin-totals');
      for (const t of v.totals) totals.append(el('span', 'fin-total', `Total ${t.total}`));
      host.append(totals);
    }
  }

  // ---- fake provider (LOUD, deterministic, no network) -------------------------------------
  function fakeFrame() {
    return {
      type: TYPE, schema: SCHEMA, fake: true, state: 'connected',
      quotes: [
        { symbol: 'EJA', name: 'Acción de ejemplo A', currency: 'EUR', priceMinor: 10125,
          series: [10000, 10040, 9980, 10060, 10110, 10090, 10125] },
        { symbol: 'EJB', name: 'Acción de ejemplo B', currency: 'USD', priceMinor: 9500,
          series: [10000, 9900, 9850, 9700, 9750, 9600, 9500] },
        { symbol: 'EJC', name: 'Fondo de ejemplo', currency: 'EUR', priceMinor: 5000,
          series: [5000, 5000, 5000, 5000] },
      ],
      thresholds: [{ symbol: 'EJB', below: 9600 }, { symbol: 'EJA', above: 11000 }],
      accounts: [
        { id: 'ej-cta', label: 'Cuenta de ejemplo', kind: 'account', currency: 'EUR', balanceMinor: 125000 },
        { id: 'ej-bil', label: 'Billetera de ejemplo', kind: 'wallet', currency: 'EUR', balanceMinor: 25050 },
        { id: 'ej-usd', label: 'Cuenta en dólares de ejemplo', kind: 'account', currency: 'USD', balanceMinor: 9900 },
      ],
    };
  }

  return {
    SCHEMA, MAX_QUOTES, MAX_ACCOUNTS, MAX_THRESHOLDS, MAX_POINTS, BANNER, ACCOUNT_KINDS,
    kindLabel, formatMoney, formatChange, sparkline, modelFromFrame, withState, evaluateAlerts,
    view, render, fakeFrame,
  };
});

// ---- browser-only wiring: self-mount into #integrations-finance, FAKE provider only ----

function mount(M, F) {
  if (typeof document === 'undefined') return;
  const host = document.getElementById('integrations-finance');
  if (!host) return; // inert until index.html carries the container (mount contract)

  let model = M.modelFromFrame(M.fakeFrame());
  let tick = 0;
  const paint = () => M.render(host, M.view(model));

  host.addEventListener('click', e => {
    if (!e || e.isTrusted !== true) return; // only trusted gestures change anything
    const target = e.target && typeof e.target.closest === 'function' ? e.target : null;
    const button = target ? target.closest('[data-action="refresh"]') : null;
    if (!button || !host.contains(button)) return;
    const outcome = F.fakeOutcome(tick);
    tick += 1;
    const next = outcome && M.withState(model, outcome);
    if (next) { model = next; paint(); }
  });

  paint();
}
