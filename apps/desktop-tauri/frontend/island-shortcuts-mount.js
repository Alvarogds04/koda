'use strict';
/* K2-09 S4/S6/S7 (option A, decided provisionally in L5; design/k2-09-atajos/08-isla-unida.html F1): the icon row of the 08 inside the
   CURRENT Nusa. Every decision — which apps, their order, their numbered keys, where focus goes when the focused card disappears — comes
   from the pure model island-shortcuts.js (window.AbitoShortcuts); this file only draws and wires, and sends nothing to the host.

   - S6: with no available app it builds NOTHING: no <nav>, no card host, the dots stay, and the island is exactly today's Nusa.
   - S7: with at least one app the row appears at the bottom, centred, «Hablar con Koda» first with its ring, and #nusa-dots steps aside
     (#nusa[data-apps="true"]). Each icon is 22px visible inside its 44x24 hit zone, so the row is n x 44 + 4 wide (model rowWidth).
   - Focus: Koda is today's Nusa (its tabs, panel and arrows). Tapping an app writes #nusa data-app, hides #nusa-panel, paints that card
     into #nusa-card and keeps its unmount. Ctrl+arrow and Ctrl+1..N (Cmd on macOS, AbitoPillCatalog.HOST_OS) walk the row; Esc returns
     to Koda; plain arrows stay the tabs' keys and only work while Koda is focused (island-nusa-mount.js guards them).
   - The only real card today is Spotify (spotify-view.js registers it). Mail, GitHub and calendar only need their key added to ICONS
     below: nothing else, and never a sample row (S4). */
(function () {
  const S = window.AbitoShortcuts, doc = document;
  const nusa = doc.getElementById('nusa');
  if (!S || !nusa) return;
  const $ = id => doc.getElementById(id);
  const body = $('nusa-body'), panel = $('nusa-panel'), dots = $('nusa-dots');
  const capsule = $('capsule');
  const KODA = S.KODA.id;
  const OS = (window.AbitoPillCatalog && window.AbitoPillCatalog.HOST_OS) || 'linux';

  // Icon map, drawn like island-nusa-mount.js ICONS (own inline SVG, 16px stroke grid, `currentColor`): the design's `#i-koda` and
  // `#i-note`. K2-10/K2-11 add 'mail' (Gmail), 'pr' (GitHub) and 'cal' (Calendario) here — one entry each, no other change.
  const ICONS = {
    koda: { d: ['M3 2.5l3 3h4l3-3V10a4.5 4.5 0 0 1-4.5 4h-1A4.5 4.5 0 0 1 3 10z'], c: [[6.2, 9, 1], [9.8, 9, 1]] },
    note: { d: ['M6 12V3.6l7-1.6v8.5'], c: [[4.3, 12, 1.7], [11.3, 10.5, 1.7]] },
    // K2-11: GitHub (a pull request: two nodes joined by a line, one arm bending to a third) and the calendar (a page with two rings).
    pr: { d: ['M4.5 5v6', 'M11.5 11V7.5a2 2 0 0 0-2-2H8'], c: [[4.5, 3.5, 1.5], [4.5, 12.5, 1.5], [11.5, 12.5, 1.5]] },
    cal: { d: ['M3 4.5h10v8.5H3z', 'M3 7.5h10', 'M5.5 2.5v3', 'M10.5 2.5v3'] },
    mail: { d: ['M2.5 4.5h11v7a.5.5 0 0 1-.5.5h-10a.5.5 0 0 1-.5-.5z', 'M2.5 4.5L8 8.5l5.5-4'] }, // K2-10: the envelope the Gmail card registers as `mail`
    app: { d: ['M6 4h4a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z'] }, // a key nobody drew yet still shows a shape
  };
  const NS = 'http://www.w3.org/2000/svg';
  function icon(key) {
    const spec = ICONS[key] || ICONS.app;
    const svg = doc.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('width', '12'); svg.setAttribute('height', '12'); svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.5');
    svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('stroke-linecap', 'round');
    for (const d of spec.d || []) { const p = doc.createElementNS(NS, 'path'); p.setAttribute('d', d); svg.append(p); }
    for (const [cx, cy, r] of spec.c || []) {
      const c = doc.createElementNS(NS, 'circle');
      c.setAttribute('cx', String(cx)); c.setAttribute('cy', String(cy)); c.setAttribute('r', String(r));
      c.setAttribute('fill', 'currentColor'); c.setAttribute('stroke', 'none'); svg.append(c);
    }
    return svg;
  }

  let nav = null, cardHost = null, focus = KODA, mounted = null, unmount = null;
  const row = () => S.row();
  const ids = () => row().map(it => it.id);
  const buttons = () => (nav ? nav.querySelectorAll('button[data-go]') : []);
  const button = id => buttons().find(b => b.getAttribute('data-go') === id) || null;
  const focusButton = id => { const b = button(id); if (b && typeof b.focus === 'function') b.focus(); };

  function ensureChrome() {
    if (!nav) {
      nav = doc.createElement('nav');
      nav.id = 'nusa-apps'; nav.setAttribute('aria-label', 'Tus apps');
      nusa.append(nav);
    }
    if (!cardHost && body) {
      cardHost = doc.createElement('div');
      cardHost.id = 'nusa-card'; cardHost.hidden = true;
      body.append(cardHost);
    }
    nusa.dataset.apps = 'true';
    if (dots) dots.hidden = true;
  }

  // welcome-minikodas (odd/tasks/welcome-minikodas.md S1-S3, S6; design 10, comment m8eankv9): on the plain Inicio the row is the RIGHT column, 5 discs per
  // row, each row centred; the island grows 70 per extra row up to 290 (the Hoy pattern: island.js writes the box inline, CSS wins with !important and the
  // host is told the destination, then the settled box). At most 15 discs: beyond that the last one reads «+N más» and the rest stay out of the row.
  const PER_ROW = 5, MAX_DISCS = 15, BASE_H = 150, ROW_H = 70, CEIL_H = 290;
  const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) || null;
  let shownApps = 0, grownRows = 1, shapeTimer = 0;
  const rowsFor = n => Math.max(1, Math.ceil(Math.min(n, MAX_DISCS) / PER_ROW));
  const plainInicio = () => !!capsule && nusa.dataset.apps === 'true' && nusa.dataset.tab === 'inicio' && !nusa.dataset.app
    && capsule.dataset.phase === 'expanded' && capsule.dataset.view === 'overview' && capsule.dataset.hoy !== 'open' && !capsule.dataset.card
    && !['waiting', 'finished', 'error'].includes(capsule.dataset.takeover || '') && !['pending', 'expired', 'outcome'].includes(capsule.dataset.question || '');
  const shape = (h, settled) => { if (!invoke) return; try { invoke('island_shape', { payload: { w: 720, h, settled } }).catch(() => {}); } catch { /* optional bridge */ } };
  function syncGrowth() {
    const rows = plainInicio() ? rowsFor(shownApps) : 1;
    if (rows === grownRows) return;
    grownRows = rows;
    if (rows > 1) capsule.dataset.appRows = String(rows); else delete capsule.dataset.appRows;
    const h = Math.min(CEIL_H, BASE_H + (rows - 1) * ROW_H);
    shape(h, false);
    clearTimeout(shapeTimer);
    shapeTimer = setTimeout(() => { const i = $('island'), r = i ? i.getBoundingClientRect() : null; shape(r && r.height > 0 ? Math.round(r.height) : h, true); }, 340);
  }

  function paintRow(rows) {
    const had = !!doc.activeElement && !!nav && nav.contains(doc.activeElement);
    const apps = rows.filter(it => it.id !== KODA);
    shownApps = apps.length;
    const hidden = apps.length > MAX_DISCS ? new Set(apps.slice(MAX_DISCS - 1).map(it => it.id)) : null;
    nav.replaceChildren(...rows.filter(it => !hidden || !hidden.has(it.id)).map(it => {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = it.id === KODA ? 'sb talk' : 'sb';
      b.setAttribute('data-go', it.id);
      b.setAttribute('title', it.label);
      b.setAttribute('aria-label', it.badge > 0 ? `${it.num} · ${it.label}: ${it.badge}` : `${it.num} · ${it.label}`);
      b.append(icon(it.icon));
      if (it.badge > 0) {
        const badge = doc.createElement('span');
        badge.className = 'bdg'; badge.setAttribute('aria-hidden', 'true'); badge.textContent = String(it.badge);
        b.append(badge);
      }
      b.addEventListener('click', e => { if (e.isTrusted !== true) return; setFocus(it.id); });
      return b;
    }).concat(hidden ? [(() => {
      const more = doc.createElement('button');
      more.type = 'button'; more.className = 'sb more'; more.disabled = true;
      more.setAttribute('title', `+${hidden.size} más`); more.setAttribute('aria-label', `${hidden.size} apps más, que no caben en la fila`);
      more.textContent = `+${hidden.size}`;
      return more;
    })()] : []));
    if (had) focusButton(focus);
  }

  // the focused app's card lives in #nusa-card; the tabs' body steps aside while one is up
  function leaveCard() {
    if (unmount) { try { unmount(); } catch { /* an unmount never breaks the row */ } }
    unmount = null; mounted = null;
    if (cardHost) cardHost.replaceChildren();
  }
  function mountCard(app) {
    if (mounted === app.id) return;
    leaveCard();
    if (!cardHost) return;
    let off = null;
    try { off = app.mount(cardHost); } catch { off = null; }
    mounted = app.id;
    unmount = typeof off === 'function' ? off : null;
  }

  function paintFocus() {
    const rows = row();
    focus = S.focusAfter(focus, rows.map(it => it.id));
    // the card DEFINITION (label, mount) comes from the registry: row() carries only what the icon paints
    const app = focus === KODA ? null : S.card(focus);
    for (const b of buttons()) {
      const on = b.getAttribute('data-go') === focus;
      b.classList.toggle('on', on);
      if (on) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
    }
    if (app) { nusa.dataset.app = app.id; mountCard(app); } else { delete nusa.dataset.app; leaveCard(); }
    if (panel) panel.hidden = !!app;
    if (cardHost) cardHost.hidden = !app;
    // island-nusa-mount.js repaints the title and the arrows from this event (the app's label, or the tab's)
    doc.dispatchEvent(new CustomEvent('abito:nusa-app', { detail: { app: app ? app.id : null } }));
  }

  function setFocus(id, move) {
    focus = S.focusAfter(id, ids());
    paintFocus();
    if (move) focusButton(focus);
  }

  // S6: nothing is available — the row and the card host are gone and the island is today's Nusa again
  function teardown() {
    leaveCard();
    if (nav) { nav.remove(); nav = null; }
    if (cardHost) { cardHost.remove(); cardHost = null; }
    delete nusa.dataset.apps; delete nusa.dataset.app;
    focus = KODA;
    shownApps = 0; syncGrowth();
    if (dots) dots.hidden = false;
    if (panel) panel.hidden = false;
    doc.dispatchEvent(new CustomEvent('abito:nusa-app', { detail: { app: null } }));
  }

  function render() {
    const rows = row();
    if (!rows.length) { teardown(); return; }
    ensureChrome();
    focus = S.focusAfter(focus, rows.map(it => it.id));
    paintRow(rows);
    paintFocus();
    syncGrowth();
  }

  const isShown = () => !capsule || (capsule.dataset.phase === 'expanded' && capsule.dataset.view === 'overview' && !capsule.dataset.card
    && !['pending', 'expired', 'outcome'].includes(capsule.dataset.question || ''));
  const typingIn = el => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  doc.addEventListener('keydown', e => {
    if (e.isTrusted !== true) return;
    const list = ids();
    if (!list.length || !isShown()) return;
    if (e.key === 'Escape' && focus !== KODA && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); setFocus(KODA, true); return; }
    if (typingIn(doc.activeElement)) return; // inside a text field the arrows keep moving the cursor (design «Teclas»)
    const key = S.keyFocus(e, list, OS);
    if (key === null) return;
    e.preventDefault();
    setFocus(typeof key === 'number' ? S.stepFocus(focus, list, key) : key, true);
  });

  // the growth follows WHERE the human is (tab, take-over, Hoy, a focused app), not only the apps list
  doc.addEventListener('abito:nusa-tab', syncGrowth);
  doc.addEventListener('abito:nusa-app', syncGrowth);
  if (typeof MutationObserver === 'function') {
    const watch = new MutationObserver(syncGrowth);
    if (capsule) watch.observe(capsule, { attributes: true, attributeFilter: ['data-hoy', 'data-takeover', 'data-card', 'data-question', 'data-view', 'data-phase'] });
    watch.observe(nusa, { attributes: true, attributeFilter: ['data-tab', 'data-app'] });
  }
  S.onChange(render);
  render();
})();
