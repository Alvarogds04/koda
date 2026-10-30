'use strict';
/* #357 F042/F043 — the Notion service card: a pages list and a page card. ONE file, the house
   pattern (integrations-view.js): pure view-model, textContent-only renderer, a LOUD fake
   provider, browser-only mount at the tail.

   FAKE DATA ONLY: no network, no account, no token. Every rendered view carries the visible
   «datos de ejemplo» marker while the frame says fake:true.

   MOUNT CONTRACT (index.html wiring — coordinator's approval needed): inert until the page has
     <section id="integrations-notion" hidden></section>
   plus <script src="integrations-notion.js" defer></script>. With the container absent it
   costs nothing. Navigation (list <-> card) is pure state in the store. Notion has no open
   action here: the framework (integrations-view.js) owns the allowlisted open target. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = Object.freeze(api); return; }
  root.AbitoNotion = Object.freeze(api);
  mount(api);
})(typeof self !== 'undefined' ? self : this, () => {
  const SCHEMA = 'abito-integrations/notion/1';
  const MAX_PAGES = 12;
  const MAX_TITLE = 80;
  const MAX_SNIPPET = 240;
  const FAKE_BANNER = 'Datos de ejemplo — nada está conectado todavía.';
  const ID_RE = /^[a-z0-9-]{1,32}$/;

  const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isStr = v => typeof v === 'string';
  const PAGE_KEYS = ['id', 'title', 'snippet', 'updatedAt'];

  /** Spanish relative age for a non-negative millisecond gap; null for junk. */
  function ageLabel(ms) {
    if (!Number.isFinite(ms)) return null;
    if (ms < 60000) return 'hace un momento';
    if (ms < 3600000) return `hace ${Math.floor(ms / 60000)} min`;
    if (ms < 86400000) return `hace ${Math.floor(ms / 3600000)} h`;
    return `hace ${Math.floor(ms / 86400000)} d`;
  }

  const validPage = p => isObject(p)
    && Object.keys(p).length === PAGE_KEYS.length && PAGE_KEYS.every(k => k in p)
    && isStr(p.id) && ID_RE.test(p.id)
    && isStr(p.title) && p.title.length > 0 && p.title.length <= MAX_TITLE
    && isStr(p.snippet) && p.snippet.length <= MAX_SNIPPET
    && Number.isFinite(p.updatedAt);

  /** A closed `notion` frame to a frozen list-mode store; anything off-shape is refused whole. */
  function storeFromFrame(frame) {
    if (!isObject(frame) || frame.type !== 'notion' || frame.schema !== SCHEMA) return null;
    if (typeof frame.fake !== 'boolean' || !Array.isArray(frame.pages)) return null;
    if (!Object.keys(frame).every(k => ['type', 'schema', 'fake', 'pages'].includes(k))) return null;
    if (frame.pages.length > MAX_PAGES) return null;
    const seen = new Set();
    const pages = [];
    for (const p of frame.pages) {
      if (!validPage(p)) return null;
      if (seen.has(p.id)) continue; // duplicate: first wins
      seen.add(p.id);
      pages.push(Object.freeze({ id: p.id, title: p.title, snippet: p.snippet, updatedAt: p.updatedAt }));
    }
    return Object.freeze({ fake: frame.fake, pages: Object.freeze(pages), selected: null });
  }

  const isStore = s => isObject(s) && typeof s.fake === 'boolean' && Array.isArray(s.pages)
    && (s.selected === null || isStr(s.selected));

  /** Opens the card of one page; unknown ids are refused with the store untouched. */
  function select(store, id) {
    if (!isStore(store) || !isStr(id) || !store.pages.some(p => p.id === id)) return null;
    return Object.freeze({ fake: store.fake, pages: store.pages, selected: id });
  }

  /** Back to the list; only meaningful from a card. */
  function back(store) {
    if (!isStore(store) || store.selected === null) return null;
    return Object.freeze({ fake: store.fake, pages: store.pages, selected: null });
  }

  /** The closed projection for the renderer; null for a bad store or timestamp. */
  function view(store, now) {
    if (!isStore(store) || !Number.isFinite(now)) return null;
    const label = p => ageLabel(now - p.updatedAt);
    const rows = store.pages.map(p => Object.freeze({ id: p.id, title: p.title, updatedLabel: label(p) }));
    const page = store.selected === null ? null : store.pages.find(p => p.id === store.selected) || null;
    const card = page ? Object.freeze({ id: page.id, title: page.title, snippet: page.snippet, updatedLabel: label(page) }) : null;
    return Object.freeze({ fake: store.fake, banner: store.fake ? FAKE_BANNER : null,
      mode: card ? 'card' : 'list', rows, card, count: rows.length });
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
    const head = el('div', 'intn-head');
    head.append(el('span', 'intn-title', 'Notion'));
    head.append(el('span', 'intn-count', `${v.count} páginas`));
    host.append(head);
    if (v.banner) host.append(el('p', 'intn-fake', v.banner));
    if (v.mode === 'card' && v.card) {
      const card = el('article', 'intn-card');
      card.append(el('h3', 'intn-card-title', v.card.title));
      card.append(el('p', 'intn-card-body', v.card.snippet || 'Sin contenido.'));
      card.append(el('span', 'intn-age', `Editada ${v.card.updatedLabel}`));
      card.append(btn('intn-back', 'back', null, 'Volver a la lista'));
      host.append(card);
      return;
    }
    if (v.rows.length === 0) { host.append(el('p', 'intn-empty', 'No hay páginas.')); return; }
    const list = el('ul', 'intn-list');
    for (const r of v.rows) {
      const li = el('li', 'intn-item');
      const b = btn('intn-row', 'select', r.id, null);
      b.append(el('span', 'intn-row-title', r.title), el('span', 'intn-age', r.updatedLabel));
      li.append(b);
      list.append(li);
    }
    host.append(list);
  }

  // ---- fake provider (LOUD, deterministic, no network) -------------------------
  const FAKE_BASE = 1700000000000;
  const FAKE_PAGES = Object.freeze([
    ['hoja-de-ruta', 'Hoja de ruta Q4', 'Prioridades del trimestre y responsables.', 5 * 60000],
    ['notas-reunion', 'Notas de reunión', 'Acuerdos de la semana y próximos pasos.', 3 * 3600000],
    ['ideas', 'Ideas sueltas', 'Borradores para revisar el viernes.', 2 * 86400000],
  ]);
  function fakeFrame() {
    return { type: 'notion', schema: SCHEMA, fake: true,
      pages: FAKE_PAGES.map(([id, title, snippet, ago]) => ({ id, title, snippet, updatedAt: FAKE_BASE - ago })) };
  }

  return { SCHEMA, MAX_PAGES, MAX_TITLE, MAX_SNIPPET, FAKE_BASE, ageLabel, storeFromFrame, select, back, view, render, fakeFrame };
});

// ---- browser-only wiring: self-mount into #integrations-notion, FAKE provider only ----
function mount(N) {
  if (typeof document === 'undefined') return;
  const host = document.getElementById('integrations-notion');
  if (!host) return; // inert until index.html carries the container (mount contract)
  let store = N.storeFromFrame(N.fakeFrame());
  // The fake data is anchored at FAKE_BASE, so ages stay stable instead of drifting with the clock.
  const paint = () => N.render(host, N.view(store, N.FAKE_BASE));
  host.addEventListener('click', e => {
    if (!e || e.isTrusted !== true) return; // only trusted gestures change anything
    const target = e.target && typeof e.target.closest === 'function' ? e.target : null;
    const button = target ? target.closest('[data-action]') : null;
    if (!button || !host.contains(button)) return;
    const next = button.dataset.action === 'select' ? N.select(store, button.dataset.id)
      : button.dataset.action === 'back' ? N.back(store) : null;
    if (next) { store = next; paint(); }
  });
  paint();
}
