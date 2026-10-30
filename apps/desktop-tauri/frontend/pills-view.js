'use strict';
// #442: the island is Abito + at most three stored specialists. Selection uses the existing
// role target command; it never connects a service, starts work, or migrates legacy pill data.
(function (root) {
  const doc = typeof document === 'object' ? document : null;
  if (!doc || !root.AbitoAvatarColors) return;
  const get = id => doc.getElementById(id);
  const host = get('pill-choices'), name = get('pill-name'), state = get('pill-state');
  const detail = get('pill-detail'), live = get('pill-live'), capsule = get('capsule');
  if (!host || !name || !state || !detail || !capsule) return;
  function paintChosenColor(node, color) {
    const stops = A?.gradientStops(color);
    if (!node?.style?.setProperty) return;
    for (let i = 0; i < 3; i++) node.style.setProperty('--chosen-' + (i + 1), stops?.[i] || '');
    node.style.setProperty('--identity-color', stops?.[1] || '');
  }
  const A = root.AbitoAvatarColors;
  let prefs = {}, version = 0, busy = false, sessions = null, sessionFocus = null;
  // A+E: EVERY live session is a blob (the column scrolls); the old filter only let through sessions with tool steps, the focused
  // one or those of a declared source, so a plain Claude/Codex session never reached the right column.
  const sessionRows = () => root.AbitoSessionsTicker?.sessionRows(sessions, prefs) || [];
  const selectSession = id => {
    focused = null;
    doc.dispatchEvent(new CustomEvent('abito:integration-focus', { detail: { id: null } }));
    doc.dispatchEvent(new CustomEvent('abito:session-select', { detail: { id } }));
  };
  const mounted = new Map();
  const owner = () => root.AbitoSpecialistsPanel;
  const store = () => owner()?.state().store;
  const onScreen = () => {
    const d = capsule.dataset;
    return d.phase === 'expanded' && d.view === 'overview' && !d.card && d.settings !== 'open' &&
      !['pending', 'expired', 'outcome'].includes(d.question) && d.noticeView !== 'notices';
  };
  // L5: the blobs also work WHILE «Recibida» shows: the click ends the outcome (notify.js) and the selection applies at once, exactly as if it
  // had been clicked after the 3 s timer. Pending/expired questions still block (they own the screen).
  const outcomeShowing = () => !!root.AbitoNotify && root.AbitoNotify.outcomeDismissible({ question: capsule.dataset.question });
  const clickable = () => {
    if (onScreen()) return true;
    const d = capsule.dataset;
    return outcomeShowing() && d.phase === 'expanded' && d.view === 'overview' && !d.card && d.settings !== 'open' && d.noticeView !== 'notices';
  };
  const say = text => { if (live) live.textContent = text; };
  function syncClay(item) {
    // Per-instance lifecycle: never change the shared engine's global policy (Abito owns it).
    const mode = !onScreen() || doc.hidden ? 'hidden' : doc.documentElement.dataset.motion === 'reduce' ? 'static' : 'live';
    if (item.mode === mode && item.pose === item.row?.pose) return;
    item.pose = item.row?.pose;
    item.clay?.destroy(); item.clay = null; item.mode = mode;
    if (mode !== 'hidden' && typeof AbitoClay !== 'undefined') {
      item.clay = AbitoClay.create(item.svg, { state: item.row?.pose || 'idle', live: mode === 'live', viewBox: '36 32 128 128', shadow: false });
    }
  }
  const syncVisibility = () => { for (const item of mounted.values()) syncClay(item); };
  function choose(id) {
    if (focused) { focused = null; doc.dispatchEvent(new CustomEvent('abito:integration-focus', { detail: { id: null } })); paint(); }
    if (busy || !owner()) return;
    busy = true;
    owner().act({ action: 'select', id: id === A.PRINCIPAL_ID ? null : id }).then(() => {
      busy = false; paint(); say('Destino elegido. No se inició ninguna tarea.');
    }, () => { busy = false; paint(); say('No se pudo elegir el destino; se mantuvo el anterior.'); });
  }
  // Coucou (views.ts otherTasks.slice(0, 4)): the grid shows every pill but the focused one, at most four; the focused
  // integration pill is the card on the left, so main + every declared pill (no limit, S32).
  // A+E: the right column is ONE scrolling list. The human's declared pills (Abito, specialists, integrations) come FIRST and are
  // never pushed out; the live agent sessions follow. No cap of four: the column scrolls.
  // Design 16 (option A, «GitHub ◂»): the focused integration STAYS a row, marked pressed, exactly like the focused session: its card is the
  // centre, and the human needs the row to know which one it is and to pick another (screen-mcp validation: it used to vanish from the column).
  const gridRows = all => [...all.filter(r => !r.session), ...all.filter(r => r.session)];
  const CARD_PILLS = Object.freeze({ integration_github: 'GitHub', integration_n8n: 'n8n', integration_vercel: 'Vercel', integration_stripe: 'Stripe', integration_resend: 'Resend', integration_notion: 'Notion', integration_calcom: 'Cal.com' });
  let focused = null; const badges = new Set(), connected = new Set(), seenBySource = new Map();
  const integrationRows = () => {
    // abito-pausa: integrations are paused in this version — no rows in the right column (the stored prefs are kept)
    if (root.AbitoPaused && root.AbitoPaused.paused('integrations')) return [];
    const ids = [prefs.mainPill, ...(Array.isArray(prefs.declaredPills) ? prefs.declaredPills : [])];
    const colors = prefs.pillColors && typeof prefs.pillColors === 'object' ? prefs.pillColors : {};
    return [...new Set(ids)].filter(id => Object.prototype.hasOwnProperty.call(CARD_PILLS, id) && connected.has(id)).map(id => ({
      id, name: CARD_PILLS[id], integration: true,
      color: typeof colors[id] === 'string' && A.normalizeChosenColor(colors[id]) ? colors[id] : 'blue',
    }));
  };
  const blobStatus = row => {
    const L = root.AbitoIslandLayout;
    if (!L) return 'idle';
    const out = L.blobRows({ declared: row.session ? [] : [{ id: row.id, name: row.name || 'x', color: row.color }], sessions: row.session ? [row] : [],
      attributedId: attributedId, badges });
    return out[0] ? out[0].status : 'idle';
  };
  let attributedId = null;
  let layoutMode = 'normal';
  doc.addEventListener('abito:layout', e => {
    const next = e.detail ? e.detail.attributedId : null, mode = e.detail && e.detail.mode === 'focus' ? 'focus' : 'normal';
    if (next !== attributedId || mode !== layoutMode) { attributedId = next; layoutMode = mode; paint(); }
  });
  function focusIntegration(id) {
    focused = id; badges.delete(id);
    doc.dispatchEvent(new CustomEvent('abito:integration-focus', { detail: { id: focused } }));
    paint();
  }
  function paint() {
    const focusedEl = doc.activeElement && host.contains(doc.activeElement) ? doc.activeElement.id : null;
    const currentStore = store();
    const agents = root.AbitoSpecialists?.agentsView(currentStore, prefs, A).agents || [];
    const rows = [{ id: A.PRINCIPAL_ID, name: 'Koda', color: A.resolveColor(A.PRINCIPAL_ID, prefs.avatarColors) }, ...agents];
    const storedActive = currentStore?.specialists?.find(r => r.id === currentStore.active);
    const selected = storedActive ? storedActive.id : A.PRINCIPAL_ID;
    const pickedSession = !focused && sessionRows().find(r => r.id === sessionFocus);
    const picked = pickedSession || storedActive || rows[0];
    name.textContent = picked.name;
    state.textContent = storedActive && !rows.some(r => r.id === selected) ? 'Fuera de la isla' : 'En reposo';
    detail.textContent = 'Elegir un destino no inicia tareas.';
    detail.setAttribute('aria-label', `${picked.name}: destino de conversación. No se inició ninguna tarea.`);
    if (pickedSession) {
      state.textContent = pickedSession.kindLabel;
      detail.textContent = 'Sesión enfocada. El destino del chat no cambió.';
      detail.setAttribute('aria-label', `${picked.name}: sesión enfocada; el destino del chat no cambió.`);
    }
    const liveRows = sessionRows();
    const alive = new Set(gridRows([...liveRows, ...rows, ...integrationRows()]).map(r => r.id));
    for (const [id, item] of mounted) if (!alive.has(id)) { item.clay?.destroy(); mounted.delete(id); }
    // #489: declared integration pills with a card (Coucou's declared pills): their pill colour, the unseen-event
    // badge, and a click that only focuses the card (abito:integration-focus). They never become the chat target.
    const integ = integrationRows();
    const rowIds = new Set(gridRows([...liveRows, ...rows, ...integ]).map(r => r.id));
    for (const [id, item] of mounted) if (id.startsWith('integration_') && !rowIds.has(id)) { item.clay?.destroy(); mounted.delete(id); }
    const buttons = gridRows([...liveRows, ...rows, ...integ]).map(row => {
      let item = mounted.get(row.id);
      if (!item) {
        const button = doc.createElement('button'); button.type = 'button'; button.className = 'pill-choice';
        button.id = `pill-choice-${row.id}`; button.dataset.pillId = row.id;
        const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'island-agent-clay');
        svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('width', '28'); svg.setAttribute('height', '28');
        const label = doc.createElement('span'); button.append(svg, label);
        item = { button, label, svg, clay: null, mode: null }; mounted.set(row.id, item);
        button.addEventListener('click', event => {
          if (event.isTrusted !== true || !clickable()) return;
          if (outcomeShowing()) doc.dispatchEvent(new CustomEvent('abito:outcome-dismiss'));
          if (item.row.session) selectSession(item.row.id);
          else if (row.integration) focusIntegration(row.id); else choose(row.id);
        });
      }
      item.row = row;
      // status dot: working / idle / needs you / news (the pure rule lives in island-layout.js)
      if (!item.dot) { item.dot = doc.createElement('i'); item.dot.className = 'blob-dot'; item.dot.setAttribute('aria-hidden', 'true'); item.button.append(item.dot); }
      item.dot.dataset.status = blobStatus(row);
      item.label.textContent = row.name; item.button.dataset.color = row.color; item.svg.dataset.color = row.color;
      paintChosenColor(item.button, row.color); paintChosenColor(item.svg, row.color);
      if (row.session) {
        item.button.setAttribute('aria-pressed', String(sessionFocus === row.id));
        item.button.dataset.centre = sessionFocus === row.id && !focused ? 'true' : 'false';
        item.button.setAttribute('aria-label', `${row.name}: enfocar sesión ${row.kindLabel}`);
        item.button.dataset.sessionId = row.id;
      } else if (row.integration) {
        item.button.setAttribute('aria-pressed', focused === row.id ? 'true' : 'false');
        item.button.dataset.centre = focused === row.id ? 'true' : 'false';
        item.button.setAttribute('aria-label', `${row.name}: integración${badges.has(row.id) ? ', con novedades' : ''}`);
        item.button.dataset.badge = badges.has(row.id) ? 'true' : 'false';
      } else {
        item.button.setAttribute('aria-pressed', selected === row.id ? 'true' : 'false');
        item.button.setAttribute('aria-label', `${row.name}${row.id === A.PRINCIPAL_ID ? ', principal' : ''}: destino de conversación`);
      }
      syncClay(item);
      return item.button;
    });
    // Updating labels/colours must not detach surviving SVGs or restart browser animations.
    if (host.children.length !== buttons.length || buttons.some((button, i) => host.children[i] !== button)) {
      host.replaceChildren(...buttons);
    }
    // E (focus mode): the 64px column keeps up to four mascots and says «+N» for the rest; the others are hidden by CSS only here.
    const L = root.AbitoIslandLayout, more = get('blobs-more');
    if (L) {
      // «+N» only exists in focus mode (the 64px mascot column); in the normal column every row is reachable by scrolling
      const focusMode = capsule.dataset.layout === 'focus';
      const o = focusMode ? L.focusOverflow(buttons.map(b => ({ id: b.dataset.pillId }))) : { shown: buttons.map(b => ({ id: b.dataset.pillId })), more: 0 };
      const shown = new Set(o.shown.map(r => r.id));
      for (const b of buttons) b.dataset.overflow = shown.has(b.dataset.pillId) ? 'false' : 'true';
      if (more) { more.hidden = !o.more; more.textContent = o.more ? `+${o.more}` : ''; more.setAttribute('aria-label', o.more ? `${o.more} más` : ''); }
      const footer = get('blobs-footer'); if (footer) footer.hidden = !o.more;
    }
    if (focusedEl) (get(focusedEl) || get(`pill-choice-${selected}`) || get(`pill-choice-${A.PRINCIPAL_ID}`))?.focus();
  }
  function apply(raw) {
    const oldMain = prefs.mainPill;
    prefs = raw && typeof raw === 'object' ? raw : {};
    if (oldMain !== prefs.mainPill) {
      const main = sessionRows().find(r => r.sourcePill === prefs.mainPill);
      if (main) selectSession(main.id);
    }
    if (focused && !integrationRows().some(row => row.id === focused)) {
      focused = null; doc.dispatchEvent(new CustomEvent('abito:integration-focus', { detail: { id: null } }));
    }
    paint();
  }
  doc.addEventListener('abito:sessions-view', event => {
    sessions = event.detail?.view || null;
    sessionFocus = event.detail?.focusId || null;
    paint();
  });
  doc.addEventListener('abito:session-focused', () => { if (focused) { focused = null; paint(); } });
  doc.addEventListener('abito:specialists-changed', paint);
  // A service shows its pill once its poller answered (declared + key saved on the host); a pill with no key never appears.
  doc.addEventListener('abito:integration-seen', e => {
    const ids = Array.isArray(e?.detail?.ids) ? e.detail.ids : [];
    // GitHub uses its existing gh poller, independently of integration_action's snapshot.
    const source = e?.detail?.source === 'github' ? 'github' : 'integrations';
    seenBySource.set(source, ids.filter(id => typeof id === 'string' && Object.prototype.hasOwnProperty.call(CARD_PILLS, id)));
    const next = new Set([...seenBySource.values()].flat());
    if (next.size !== connected.size || [...next].some(id => !connected.has(id))) {
      connected.clear(); next.forEach(id => connected.add(id));
      if (focused && !connected.has(focused)) {
        focused = null; doc.dispatchEvent(new CustomEvent('abito:integration-focus', { detail: { id: null } }));
      }
      paint();
    }
  });
  doc.addEventListener('abito:integration-badge', e => { const id = e && e.detail && e.detail.id; if (typeof id === 'string' && id !== focused) { badges.add(id); paint(); } });
  doc.addEventListener('visibilitychange', syncVisibility);
  if (typeof MutationObserver !== 'undefined') {
    const visibility = new MutationObserver(syncVisibility);
    visibility.observe(capsule, { attributes: true, attributeFilter: ['data-phase', 'data-view', 'data-settings', 'data-card', 'data-question', 'data-notice-view'] });
    visibility.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
  }
  paint();
  const invoke = root.__TAURI__?.core?.invoke || root.__TAURI_INTERNALS__?.invoke;
  const listen = root.__TAURI__?.event?.listen;
  if (listen) listen('prefs:state', event => { version += 1; apply(event?.payload); }).catch(() => {});
  if (invoke) {
    const observed = version;
    invoke('prefs_action', { payload: { action: 'view' } }).then(raw => {
      if (version === observed) apply(raw);
    }, () => say('No se pudieron leer tus blobs guardados. Se muestra Koda sin guardar.'));
  } else say('Sin acceso a preferencias. Se muestra Koda sin guardar.');
})(typeof window !== 'undefined' ? window : this);
