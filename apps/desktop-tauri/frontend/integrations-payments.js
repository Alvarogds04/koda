'use strict';
/* #356 F041 — the Payments service card: a connection status plus a read-only
   summary of recent payments. ONE file, the house pattern (integrations-view.js):
   the pure model, the textContent-only renderer and a FAKE provider, browser-only
   at the tail.

   STRICTLY READ-ONLY: there is no verb here. Nothing charges, refunds, pays out,
   transfers or cancels; the only control is «Actualizar», which cycles the FAKE
   provider's connection state. FAKE DATA ONLY: no network, no account, no token,
   no real service. Every rendered view of a fake model carries the visible
   «Datos de ejemplo» banner (the same copy as the #352 framework).

   Plugs into the #352 framework (integrations-view.js, window.AbitoIntegrations)
   for the closed connection vocabulary (STATES / stateLabel) and the fake refresh
   outcomes. It never modifies it. Load it AFTER integrations-view.js.

   ---- MOUNT CONTRACT (index.html wiring — coordinator's approval needed) ----
   1. a container of its own (the framework repaints #integrations wholesale, so a
      sibling is required):   <section id="integrations-payments" hidden></section>
   2. one script tag after integrations-view.js:
        <script src="integrations-payments.js" defer></script>
   With the container absent the module costs nothing. Styling: the append-only
   `.pay-*` block in style.css (theme tokens only).

   Loaded as a classic script (window.AbitoPayments) and by
   test-node/integrations-payments-check.cjs through `module.exports`. */
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const F = isNode ? require('./integrations-view.js') : root.AbitoIntegrations;
  if (!F) return; // the framework is not loaded: inert, never half-working
  const api = factory(F);
  if (isNode) { module.exports = Object.freeze(api); return; }
  root.AbitoPayments = Object.freeze(api);
  mount(api, F);
})(typeof self !== 'undefined' ? self : this, F => {
  const SCHEMA = 'abito-integrations/payments/1';
  const TYPE = 'integrations-payments';
  const MAX_PAYMENTS = 8;
  const MAX_LABEL = 40;
  const ID_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;

  const BANNER = 'Datos de ejemplo — nada está conectado todavía.';

  // ---- closed vocabularies ------------------------------------------------------
  const PAYMENT_STATUSES = Object.freeze(['succeeded', 'pending', 'failed', 'refunded']);
  const STATUS_LABELS = Object.freeze({
    succeeded: 'cobrado', pending: 'pendiente', failed: 'fallido', refunded: 'reembolsado',
  });
  const CURRENCIES = Object.freeze({ EUR: { symbol: '€', after: true }, USD: { symbol: 'US$', after: true } });
  const NOTES = Object.freeze({
    disconnected: 'Pagos está sin conectar.',
    error: 'No se pudo leer Pagos.',
    paused: 'En pausa: se muestra la última lectura.',
  });

  const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const statusLabel = s => (typeof s === 'string' && has(STATUS_LABELS, s) ? STATUS_LABELS[s] : null);

  // ---- money: integer minor units -> «1.234,50 €» (deterministic, no Intl) ------
  function formatMoney(minor, currency) {
    if (!Number.isSafeInteger(minor) || typeof currency !== 'string' || !has(CURRENCIES, currency)) return null;
    const abs = Math.abs(minor);
    const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    const cents = String(abs % 100).padStart(2, '0');
    return `${minor < 0 ? '-' : ''}${whole},${cents} ${CURRENCIES[currency].symbol}`;
  }

  // ---- frame -> frozen model ------------------------------------------------------
  /**
   * A closed payments frame to a frozen model. Anything off-shape (unknown key,
   * off-enum status, non-integer or negative amount, oversized list, duplicate id,
   * a smuggled URL or token) returns null: nothing is half-built or repaired.
   */
  function modelFromFrame(frame) {
    if (!isObject(frame) || frame.type !== TYPE || frame.schema !== SCHEMA) return null;
    if (!Object.keys(frame).every(k => ['type', 'schema', 'fake', 'state', 'currency', 'payments'].includes(k))) return null;
    if (typeof frame.fake !== 'boolean' || !F.STATES.includes(frame.state)) return null;
    if (typeof frame.currency !== 'string' || !has(CURRENCIES, frame.currency)) return null;
    if (!Array.isArray(frame.payments) || frame.payments.length > MAX_PAYMENTS) return null;
    const seen = new Set();
    const payments = [];
    for (const raw of frame.payments) {
      if (!isObject(raw)) return null;
      if (!Object.keys(raw).every(k => ['id', 'label', 'amountMinor', 'status'].includes(k))) return null;
      if (typeof raw.id !== 'string' || !ID_RE.test(raw.id) || seen.has(raw.id)) return null;
      if (typeof raw.label !== 'string' || raw.label.length === 0 || raw.label.length > MAX_LABEL) return null;
      if (!Number.isSafeInteger(raw.amountMinor) || raw.amountMinor < 0) return null;
      if (!PAYMENT_STATUSES.includes(raw.status)) return null;
      seen.add(raw.id);
      payments.push(Object.freeze({ id: raw.id, label: raw.label, amountMinor: raw.amountMinor, status: raw.status }));
    }
    return Object.freeze({ fake: frame.fake, state: frame.state, currency: frame.currency, payments: Object.freeze(payments) });
  }

  const isModel = m => isObject(m) && typeof m.fake === 'boolean' && F.STATES.includes(m.state)
    && typeof m.currency === 'string' && has(CURRENCIES, m.currency) && Array.isArray(m.payments);

  /** The refresh outcome: a copy with a new closed connection state, or null. */
  function withState(model, state) {
    if (!isModel(model) || !F.STATES.includes(state)) return null;
    return Object.freeze({ fake: model.fake, state, currency: model.currency, payments: model.payments });
  }

  // ---- view (what the renderer paints) ---------------------------------------------
  function view(model) {
    if (!isModel(model)) return null;
    const showData = model.state === 'connected' || model.state === 'paused';
    const money = n => formatMoney(n, model.currency);
    let summary = [];
    let rows = [];
    if (showData) {
      summary = PAYMENT_STATUSES.map(key => {
        const of = model.payments.filter(p => p.status === key);
        return Object.freeze({ key, label: STATUS_LABELS[key], count: of.length,
          amount: money(of.reduce((a, p) => a + p.amountMinor, 0)) });
      });
      rows = model.payments.map(p => Object.freeze({
        id: p.id, label: p.label, status: p.status, statusLabel: STATUS_LABELS[p.status], amount: money(p.amountMinor),
      }));
    }
    return Object.freeze({
      fake: model.fake, banner: model.fake ? BANNER : null,
      state: model.state, stateLabel: F.stateLabel(model.state), showData,
      note: has(NOTES, model.state) ? NOTES[model.state] : null,
      summary: Object.freeze(summary), rows: Object.freeze(rows),
    });
  }

  // ---- renderer (textContent only; the click lives in mount) -------------------------
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  };

  function render(host, v) {
    if (!(host && typeof host.appendChild === 'function')) return;
    if (!v || !Array.isArray(v.rows) || !Array.isArray(v.summary)) {
      host.textContent = '';
      host.hidden = true;
      return;
    }
    host.textContent = '';
    host.hidden = false;
    const head = el('div', 'pay-head');
    head.append(el('span', 'pay-title', 'Pagos'));
    head.append(el('span', `pay-state pay-state--${v.state}`, v.stateLabel));
    const refresh = el('button', 'pay-refresh', 'Actualizar');
    refresh.type = 'button';
    refresh.dataset.action = 'refresh';
    head.append(refresh);
    host.append(head);
    if (v.banner) host.append(el('p', 'pay-fake', v.banner));
    if (v.note) host.append(el('p', 'pay-note', v.note));
    if (v.summary.length) {
      const sums = el('div', 'pay-sums');
      for (const s of v.summary) {
        const box = el('div', `pay-sum pay-sum--${s.key}`);
        box.append(el('span', 'pay-sum-label', `${s.label} · ${s.count}`));
        box.append(el('span', 'pay-sum-amount', s.amount));
        sums.append(box);
      }
      host.append(sums);
    }
    if (v.rows.length) {
      const list = el('ul', 'pay-list');
      for (const r of v.rows) {
        const li = el('li', 'pay-row');
        li.dataset.paymentId = r.id;
        li.append(el('span', 'pay-label', r.label));
        li.append(el('span', `pay-status pay-status--${r.status}`, r.statusLabel));
        li.append(el('span', 'pay-amount', r.amount));
        list.append(li);
      }
      host.append(list);
    }
  }

  // ---- fake provider (LOUD, deterministic, no network) --------------------------------
  function fakeFrame() {
    return {
      type: TYPE, schema: SCHEMA, fake: true, state: 'connected', currency: 'EUR',
      payments: [
        { id: 'ej-001', label: 'Cuota mensual (ejemplo)', amountMinor: 4900, status: 'succeeded' },
        { id: 'ej-002', label: 'Plan anual (ejemplo)', amountMinor: 49000, status: 'succeeded' },
        { id: 'ej-003', label: 'Cuota mensual (ejemplo)', amountMinor: 4900, status: 'pending' },
        { id: 'ej-004', label: 'Complemento (ejemplo)', amountMinor: 1250, status: 'failed' },
        { id: 'ej-005', label: 'Plan anual (ejemplo)', amountMinor: 49000, status: 'refunded' },
      ],
    };
  }

  return {
    SCHEMA, MAX_PAYMENTS, BANNER, PAYMENT_STATUSES, statusLabel, formatMoney,
    modelFromFrame, withState, view, render, fakeFrame,
  };
});

// ---- browser-only wiring: self-mount into #integrations-payments, FAKE provider only ----

function mount(P, F) {
  if (typeof document === 'undefined') return;
  const host = document.getElementById('integrations-payments');
  if (!host) return; // inert until index.html carries the container (mount contract)

  let model = P.modelFromFrame(P.fakeFrame());
  let tick = 0;
  const paint = () => P.render(host, P.view(model));

  host.addEventListener('click', e => {
    if (!e || e.isTrusted !== true) return; // only trusted gestures change anything
    const target = e.target && typeof e.target.closest === 'function' ? e.target : null;
    const button = target ? target.closest('[data-action="refresh"]') : null;
    if (!button || !host.contains(button)) return;
    const outcome = F.fakeOutcome(tick);
    tick += 1;
    const next = outcome && P.withState(model, outcome);
    if (next) { model = next; paint(); }
  });

  paint();
}
