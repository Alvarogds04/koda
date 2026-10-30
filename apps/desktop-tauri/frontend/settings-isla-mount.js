'use strict';
/* HU-063 T2: browser mount of the «Isla» page in the Ajustes hub. Additive: the vendor shell (vendor/coucou/hub/shell.js) knows nothing of it.
   It injects ONE rail item (same markup as the vendor ones) after the last page and, on click, replaces the hub panel content like the shell
   does. The page = «Tamaño de la isla» (S/M/L/Auto + live preview, closed prefs verb set_island_size) + «Colores de identidad» + the vendor
   «Isla» card, both rendered by the vendor renderers and confined to those cards (the same renderers, so no control and no command is lost).
   The vendor owns the rail's `.on`: ours is set when selected and dropped as soon as the vendor selects or paints another page.
   Classic script: window.AbitoSettingsIslaMount.mount(deps) is called by settings-app.js. No HTML-string injection. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AbitoSettingsIslaMount = Object.freeze(api);
})(typeof self !== 'undefined' ? self : this, root => {
  const SVG = 'http://www.w3.org/2000/svg';
  const ICON = 'M3.5 6.5h17a2 2 0 0 1 2 2v1a2 2 0 0 1-2 2h-17a2 2 0 0 1-2-2v-1a2 2 0 0 1 2-2zM8 15.5h8M10 19h4';
  const FAIL = 'No se pudo guardar. El tamaño sigue sin cambios; probá de nuevo.';
  const SAVED = 'Tamaño de la isla guardado.';
  const SUBTITLE = 'Su tamaño, sus colores y cómo se comporta.';

  function mount(deps) {
    const { doc, invoke, renderGeneral, renderPills, personal, V, hero } = deps;
    const S = deps.model || root.AbitoSettingsIsla || (typeof module === 'object' && module.exports ? require('./settings-isla.js') : null);
    const Observer = Object.hasOwn(deps, 'Observer') ? deps.Observer : (typeof MutationObserver === 'function' ? MutationObserver : null);
    const areaW = deps.areaW || (() => (root.screen && (root.screen.availWidth || root.screen.width)) || 0);
    if (!doc || !S || !V || !invoke || !renderGeneral || !renderPills) return null;

    const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
    const item = el('button', 'hub-item');
    item.setAttribute('data-page', 'isla');
    item.setAttribute('type', 'button');
    const svg = doc.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    const path = doc.createElementNS(SVG, 'path'); path.setAttribute('d', ICON); svg.append(path);
    const label = el('span', '', 'Isla');
    item.append(svg, label);

    let active = false, shown = false, token = 0, page = null, leave = [], pending = Promise.resolve();
    const q = sel => doc.querySelector(sel);
    const kids = n => Array.from((n && n.children) || []);
    const hasOn = e => String(e.className || '').split(/\s+/).includes('on');
    const setOn = (e, on) => { if (e.classList && e.classList.toggle) e.classList.toggle('on', on); else e.className = on ? `${e.className} on` : String(e.className).replace(/\bon\b/g, '').trim(); };
    const side = () => q('#hub .hub-side');
    const scroll = () => q('#hub .hub-scroll');

    function dispose() {
      const fns = leave; leave = []; page = null; shown = false;
      for (const f of fns) { try { f(); } catch { /* a page that is already gone */ } }
    }
    function deactivate() {
      active = false; ++token; setOn(item, false); dispose();
    }

    // the page content (built off-DOM, swapped in when ready)
    async function build() {
      const mine = [];
      const root_ = el('div', 'hub-page');
      const container = el('div'); container.setAttribute('id', 'settings-root');
      if (hero) root_.append(hero('isla', 'Isla', SUBTITLE));
      root_.append(container);
      try {
        container.append(await sizeCard(mine));
        const colours = await renderPills({ ...personal, part: 'abito' });
        mine.push(() => colours.dispose && colours.dispose());
        mine.push(S.confine(colours, S.KEEP.abitoIsla, Observer));
        const general = await renderGeneral({ invoke, V, navigate: id => { try { doc.dispatchEvent(new CustomEvent('abito:hub-select', { detail: id })); } catch { /* no event bus */ } } });
        mine.push(() => general.dispose && general.dispose());
        mine.push(S.confine(general, S.KEEP.islaCard, Observer));
        container.append(colours, general);
      } catch {
        for (const f of mine.splice(0)) { try { f(); } catch { /* best effort */ } }
        const card = el('section', 'abito-card'); card.setAttribute('aria-label', 'Isla');
        card.append(el('p', 'hub-note', 'No se pudieron leer los ajustes. Vuelve a abrir esta página.'));
        container.append(card);
      }
      return { node: root_, mine };
    }

    async function sizeCard(mine) {
      let size = 'auto', issue = '';
      try {
        const p = await invoke('prefs_action', { payload: { action: 'view' } });
        size = S.preview(p && p.islandSize, 0).id;
      } catch { issue = 'No se pudo leer el tamaño actual.'; }
      const card = el('section', 'abito-card'); card.setAttribute('aria-label', 'Tamaño de la isla');
      const h2 = el('h2'); h2.append(el('span', '', 'Tamaño de la isla')); card.append(h2);
      const rowEl = el('div', 'row');
      const lab = el('label', '', 'Tamaño'); rowEl.append(lab);
      const group = el('div', 'hub-segmented'); group.setAttribute('id', 'settings-island-size-options');
      group.setAttribute('role', 'radiogroup'); group.setAttribute('aria-label', 'Tamaño de la isla');
      const stage = el('div', 'isla-stage'); stage.setAttribute('aria-hidden', 'true');
      const notch = el('div', 'isla-notch'); stage.append(notch);
      const caption = el('p', 'hint', ''); caption.setAttribute('id', 'isla-preview-caption');
      const status = el('p', 'hub-note', issue); status.setAttribute('role', 'status');
      const buttons = new Map();
      let queue = Promise.resolve(), gone = false;
      mine.push(() => { gone = true; });
      const paint = () => {
        const pv = S.preview(size, areaW());
        notch.style.setProperty('--k', String(pv.k));
        caption.textContent = pv.caption;
        for (const seg of V.islandSizeSegments(size)) {
          const b = buttons.get(seg.id);
          b.setAttribute('aria-checked', seg.selected ? 'true' : 'false'); b.setAttribute('tabindex', seg.selected ? '0' : '-1');
          setOn(b, seg.selected);
        }
      };
      for (const seg of V.islandSizeSegments(size)) {
        const b = el('button', '', seg.label); b.setAttribute('type', 'button'); b.setAttribute('id', `island-size-${seg.id}`); b.setAttribute('role', 'radio');
        buttons.set(seg.id, b);
        b.addEventListener('click', e => {
          if (e.isTrusted !== true || V.islandSizeProblem(seg.id)) return;
          queue = queue.then(async () => {
            if (gone || size === seg.id) return;
            try {
              const p = await invoke('prefs_action', { payload: { action: 'set_island_size', island_size: seg.id } });
              size = S.preview(p && typeof p.islandSize === 'string' ? p.islandSize : seg.id, 0).id;
              status.textContent = SAVED;
            } catch { status.textContent = FAIL; }
            if (!gone) paint();
          });
        });
        group.append(b);
      }
      rowEl.append(group);
      card.append(rowEl, stage, caption, status);
      paint();
      return card;
    }

    async function open() {
      const id = ++token;
      if (active) dispose();
      active = true; shown = false;
      for (const b of kids(side())) if (b !== item && hasOn(b)) setOn(b, false);
      setOn(item, true);
      const built = await build();
      const target = scroll();
      if (id !== token || !active || !target) { for (const f of built.mine) { try { f(); } catch { /* ignore */ } } return; }
      leave = built.mine; page = built.node; shown = true;
      target.replaceChildren(built.node);
      if ('scrollTop' in target) target.scrollTop = 0;
    }

    function inject() {
      const s = side();
      if (!s || kids(s).includes(item)) return;
      const items = kids(s).filter(c => String(c.className || '').split(/\s+/).includes('hub-item') && c !== item);
      if (!items.length) return;
      const list = kids(s), after = list[list.indexOf(items[items.length - 1]) + 1] || null;
      s.insertBefore(item, after);
    }
    // the vendor selected/painted something else: ours steps aside
    function sync() {
      inject();
      if (!active) return;
      const s = side();
      if (kids(s).some(c => c !== item && hasOn(c))) return deactivate();
      const target = scroll();
      if (shown && target && !kids(target).includes(page)) deactivate();
    }

    item.addEventListener('click', () => { if (!active || !shown) pending = open(); });
    const hub = doc.getElementById && doc.getElementById('hub');
    if (Observer && hub) new Observer(sync).observe(hub, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
    sync();
    return { item, sync, open: () => (pending = open()), idle: () => pending, isActive: () => active };
  }
  return { mount };
});
