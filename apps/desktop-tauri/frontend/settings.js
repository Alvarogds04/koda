'use strict';
/* #306 — the settings panel (providers, connectors, general), an internal panel of the
   chat view like the model picker (same island, same motion). It talks to Rust ONLY
   through three closed commands: `agent_action` (accounts / sign-in / connectors),
   `prefs_action` (sound/gain/name/avatar and local catalog choices) and
   `hotkey_action` (the global shortcut), plus the existing
   window.desktop verbs for system motion. It never sees the agent's token or socket.
   - Plain text only (textContent). No innerHTML anywhere: icons are DOM nodes built from the
     closed own registry (DOMParser), so no data can ever become markup.
   - A key is typed into a MASKED field and sent once through auth_reply (daemon)
     or abito_account_* (local store). The field clears before IPC; keys are never
     placed in snapshots, persistent page drafts, logs or browser storage.
   - Only trusted gestures (event.isTrusted) change anything. */
(() => {
  const V = window.AbitoSettings;
  const ICONS = window.AbitoIcons;
  const $ = id => document.getElementById(id);
  const capsule = $('capsule');
  const panel = $('settings');
  const body = $('settings-body');
  if (!V || !ICONS || !panel || !body) return;
  // Icons are built as DOM nodes from the CLOSED own registry (an unknown name yields nothing):
  // no markup is ever written with innerHTML, so no data can become markup.
  const parser = new DOMParser();
  function icon(name) {
    const markup = ICONS.svg(name);
    if (!markup) return null;
    const doc = parser.parseFromString(markup, 'image/svg+xml');
    return doc.documentElement && doc.documentElement.nodeName === 'svg' ? document.importNode(doc.documentElement, true) : null;
  }
  function putIcon(host, name) {
    host.textContent = '';
    const node = name ? icon(name) : null;
    if (node) host.append(node);
  }
  for (const holder of panel.querySelectorAll('[data-icon]')) putIcon(holder, holder.dataset.icon);
  const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)
    || (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) || null;
  const listen = (window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen) || null;
  const call = (cmd, payload) => (invoke ? invoke(cmd, { payload }) : Promise.reject(new Error('no ipc')));
  const agent = payload => call('agent_action', payload);

  const openers = [$('open-screen-settings')].filter(Boolean); // the chat header gear: the ONE entry (#408)
  // #366 F093: the SAME page runs inside the Rust-created settings window. There the panel
  // fills the window (body[data-window="settings"] CSS) and the island's size is not this
  // page's business. The label is the exact one the sender gate admits (narrow approval).
  const WINDOW_MODE = V.isSettingsWindow(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.metadata
    && window.__TAURI_INTERNALS__.metadata.currentWindow && window.__TAURI_INTERNALS__.metadata.currentWindow.label);
  // Adapted from Coucou windows/src/hub/shell.ts and windows/src/settings/main.ts.
  // Copyright (c) 2026 Louis Raillé, MIT. Abito keeps its own icons, copy and character.
  if (WINDOW_MODE) {
    document.body.dataset.window = 'settings';
    document.body.append(panel); // the settings window has no island ancestor or clipping
    $('coucou-settings-style').media = 'all'; // never apply the vendor reset to the island
  }
  const moreGroup = $('connections-more'); // FAKE services cards; render() wipes the body, so it is re-appended per render
  const tabsHost = $('settings-tabs');
  const live = $('settings-live');
  let screen = 'general'; // #442 T7.4: Ajustes opens on General (design §3 order, flows lane 4)
  let filter = '';
  let agentsAsk = null;   // { at: engine error counter when agents_list was sent, timer, timedOut }
  let loginTarget = null;  // #408: { providerId, phase: 'active'|'error'|'cancelled', sawFlow } — the login this page started
  let pendingLogin = null; // a login that waits for the account it just asked the engine to create
  let agentState = null;
  let ownedAccounts = null; // masked host projection only, independent of daemon pushes
  let accountForm = null;
  let accountSaving = false;
  let accountError = '';
  let accountNote = null; // #409 T2: outcome of the last removal attempt, in words we own
  let accountGeneration = 0;
  // #467 Claves: presence only ({id: boolean}); a value lives in the field until the save click and is cleared before IPC.
  let keyPresence = {};
  let keyLoad = 'idle'; // idle | loading | done
  let keyBusy = '';     // the key id with a request in flight
  let keyNotes = {};    // id -> { tone, say } outcome in OUR words
  function discardAccountForm() {
    const secret = accountForm && accountForm.querySelector('#account-secret');
    if (secret) secret.value = '';
    accountForm = null; accountError = ''; accountGeneration += 1;
  }
  const SV = window.AbitoSpecialists, AbitoPills = window.AbitoPills;
  let prefs = { sound: false };
  let pillSaving = false;
  let pillError = '';
  let gainDraft = null;
  let gainSaving = false;
  let gainPending = null; // latest slider value moved while a volume save was in flight
  let gainError = '';
  // #336 F003: same draft/saving/error pattern as the volume field.
  let autoSaving = false;
  let autoError = '';
  let nameDraft = null; // null follows saved prefs; edited text survives state pushes
  let nameSaving = false;
  let nameError = '';
  let hotkey = null;
  // #390 GD027: the manual restart of the daemon (Ajustes → Conexiones), one in-flight flag
  let daemonBusy = false;
  let daemonNote = null;
  // #327 owns the sole role cache; Settings reads only its immutable id/name projection.
  function paintChosenColor(node, color) {
    const stops = AVATAR?.gradientStops(color);
    if (!node?.style?.setProperty) return;
    for (let i = 0; i < 3; i++) node.style.setProperty('--chosen-' + (i + 1), stops?.[i] || '');
    node.style.setProperty('--identity-color', stops?.[1] || '');
  }
  const AVATAR = window.AbitoAvatarColors;
  const specialistIdentities = () => window.AbitoSpecialistsPanel?.identityView() || { kind: 'loading', identities: [] };
  document.addEventListener('abito:specialist-identities', () => render());
  // F1: feedback belongs to its identity and survives renders/retries until a save succeeds.
  const colorErrors = Object.create(null);
  let motionOverride = true;
  let themeError = ''; // #380: a failed theme save keeps the previous theme and says so
  let capturing = false;
  let pendingOpen = false;
  const drafts = V.makeDrafts(); // what is being typed survives the re-renders (memory only)
  let busy = false;

  const say = text => { if (text) { live.textContent = ''; requestAnimationFrame(() => { live.textContent = text; }); } };
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };
  // Frame adapted from windows/src/hub/shell.ts: sidebar + existing settings page.
  // Copyright (c) 2026 Louis Raillé, MIT. No Flow, reserved artwork or new IPC.
  function mountSettingsFrame() {
    const side = el('nav', 'hub-side');
    side.append(el('div', 'hub-brand', 'Abito'), $('settings-tabs'));
    const page = el('main', 'hub-panel');
    page.append($('settings-bar'), $('settings-hint'), $('settings-body'), $('models'));
    panel.append(side, page);
  }
  // ---- settings frame end
  if (WINDOW_MODE) mountSettingsFrame();

  function wordBtn(word, onClick, opts) {
    const o = opts || {};
    const b = el('button', 'sbtn' + (o.primary ? ' primary' : ''));
    b.type = 'button';
    if (o.icon) { const i = el('span', 'ico'); putIcon(i, o.icon); b.append(i); }
    b.append(el('span', 'btn-word', word));
    if (o.aria) b.setAttribute('aria-label', o.aria);
    b.disabled = !!o.disabled;
    b.addEventListener('click', e => { if (e.isTrusted === true) onClick(e); });
    return b;
  }
  function chipNode(view) {
    const c = el('span', 'chip'); c.dataset.tone = view.tone; c.setAttribute('role', 'img'); c.setAttribute('aria-label', view.aria || view.word);
    if (view.icon) { const i = el('span', 'ico'); putIcon(i, view.icon); c.append(i); }
    if (view.word) c.append(el('span', 'word', view.word));
    return c;
  }

  // #384: the Dot's colour, one row per identity the human can colour. The swatches are a
  // radiogroup of real buttons (keyboard reachable, each with its own name) and the CURRENT
  // colour is also written as a word: the meaning never rides on colour alone
  // (docs/desktop-visual-language.md §1.1 C5).
  const avatarName = id => (AVATAR && AVATAR.isPrincipal(id) ? 'Abito' : specialistIdentities().identities.find(identity => identity.id === id)?.name || String(id));
  function colorRow(row) {
    const line = el('div', 'srow scolors');
    line.dataset.identity = row.id;
    line.dataset.color = row.color; paintChosenColor(line, row.color);
    line.append(el('span', 'srow-title', row.name));
    const options = el('span', 'sdot-options');
    options.setAttribute('role', 'radiogroup');
    options.setAttribute('aria-label', `Color de ${avatarName(row.id)}`);
    for (const option of row.options) {
      const b = el('button', 'sdot');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', option.selected ? 'true' : 'false');
      b.setAttribute('aria-label', option.aria);
      b.dataset.color = option.color; paintChosenColor(b, option.color);
      // render() restores focused IDs on both invoke responses and prefs:state events.
      b.id = `dot-color-${row.id}-${option.color}`;
      b.tabIndex = option.selected ? 0 : -1;
      b.append(el('span', 'sdot-swatch'));
      b.append(el('span', 'sdot-label', option.label));
      b.addEventListener('keydown', e => {
        if (e.isTrusted !== true || !['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault();
        const buttons = [...options.querySelectorAll('[role="radio"]')];
        const at = buttons.indexOf(b);
        let next = (at + (['ArrowRight', 'ArrowDown'].includes(e.key) ? 1 : -1) + buttons.length) % buttons.length;
        if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = buttons.length - 1;
        buttons.forEach((button, i) => { button.tabIndex = i === next ? 0 : -1; });
        buttons[next].focus();
        chooseColor(row.id, buttons[next].dataset.color);
      });
      b.addEventListener('click', e => { if (e.isTrusted === true) chooseColor(row.id, option.color); });
      options.append(b);
    }
    line.append(options);
    line.append(chipNode({ tone: 'faint', icon: 'check', word: row.label, aria: row.aria }));
    if (colorErrors[row.id]) {
      const error = el('span', 'sdot-error', colorErrors[row.id]);
      error.id = `dot-color-error-${row.id}`;
      options.setAttribute('aria-describedby', error.id);
      error.setAttribute('role', 'status');
      line.append(error);
    }
    return line;
  }
  // The engine and the file are the truth: a failed save says so and keeps the previous colour.
  function chooseColor(identity, color) {
    call('prefs_action', { action: 'set_avatar_color', identity, color }).then(
      p => {
        const saved = AVATAR.resolveColor(identity, p.avatarColors);
        delete colorErrors[identity];
        prefs = p; render();
        say(`Color de ${avatarName(identity)}: ${AVATAR.label(saved)}.`);
      },
      () => {
        colorErrors[identity] = 'No se pudo guardar el color; se mantuvo el anterior.';
        render();
        say(colorErrors[identity]);
      });
  }

  // #380: system / light / dark. The click only SENDS the choice: the host validates the closed
  // enum, persists it and publishes `prefs:state`; theme.js paints from that saved state. So a
  // failed save leaves the previous theme on screen (no optimistic paint, no false «guardado»).
  function chooseTheme(mode) {
    return call('prefs_action', { action: 'set_theme', theme: mode }).then(p => {
      themeError = '';
      prefs = p;
      render();
      const view = V.themeView(p);
      const chosen = view.options.find(o => o.selected) || view.options[0];
      say(`Tema guardado: ${chosen.label}.`);
    }, () => {
      themeError = 'No se pudo guardar el tema; se mantuvo el anterior.';
      render();
      say(themeError);
    });
  }

  // ---- open / close ---------------------------------------------------------------------------------------
  // #408: the sub-tab strip, built once from V.TABS. Roving tabindex + arrow keys (WAI-ARIA tablist).
  function buildTabs() {
    if (!tabsHost) return;
    for (const def of V.TABS) {
      const b = el('button', 'stab');
      b.type = 'button'; b.id = `settings-tab-${def.id}`; b.dataset.tab = def.id;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-controls', def.id === 'models' ? 'models' : 'settings-body');
      const i = el('span', 'ico'); putIcon(i, def.icon);
      b.append(i, el('span', 'word', def.label));
      b.addEventListener('click', e => { if (e.isTrusted === true) showScreen(def.id); });
      b.addEventListener('keydown', e => {
        if (e.isTrusted !== true || e.isComposing) return;
        const next = V.tabKeyTarget(def.id, e.key);
        if (!next) return;
        e.preventDefault(); e.stopPropagation();
        showScreen(next);
        const nb = $(`settings-tab-${next}`); if (nb) nb.focus();
      });
      tabsHost.append(b);
    }
  }
  buildTabs();
  // #408: at the Settings size (wide) the tabs are a vertical rail; in the 400 column a wrapping row.
  const RAIL_MIN_W = 600;
  function syncRail() {
    const wide = WINDOW_MODE || (typeof panel.clientWidth === 'number' && panel.clientWidth >= RAIL_MIN_W);
    panel.dataset.rail = WINDOW_MODE ? 'window' : (wide ? 'true' : 'false');
    if (tabsHost) tabsHost.setAttribute('aria-orientation', wide ? 'vertical' : 'horizontal');
  }
  window.addEventListener('resize', syncRail);
  let pendingSection = null;
  function focusPendingSection() {
    if (!pendingSection) return;
    const target = document.getElementById(pendingSection);
    if (!target) return; // the section renders later: render() calls this again
    pendingSection = null;
    target.setAttribute('tabindex', '-1');
    target.scrollIntoView({ block: 'start' });
    target.focus({ preventScroll: true });
  }
  function showScreen(id) {
    screen = id;
    id = V.tabAlias(id) || 'general';
    screen = id;
    if (id !== 'accounts') { filter = ''; discardAccountForm(); }
    const def = V.tabById(id);
    $('settings-title').textContent = WINDOW_MODE ? def.title : 'Ajustes';
    $('settings-hint').textContent = def.hint;
    $('settings-hint').hidden = !def.hint;
    panel.setAttribute('aria-label', `Ajustes: ${def.title}`);
    if (tabsHost) for (const b of tabsHost.children) {
      const on = b.dataset.tab === id;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
    body.hidden = id === 'models'; // the model picker is its own panel (models.js), shown by the event below
    // #410: the open sub-tab is a PUBLIC DOM attribute of the tabpanel. The compact Conexiones rules
    // (#410 block in style.css) are scoped to it, so every other Ajustes tab keeps its own look.
    body.dataset.screen = id;
    body.setAttribute('aria-labelledby', `settings-tab-${id}`);
    body.scrollTop = 0;
    document.dispatchEvent(new CustomEvent('abito:settings-tab', { detail: id }));
    if (id === 'accounts') { agent({ action: 'connectors_list' }).catch(() => {}); askAgents(); }
    render();
  }
  // The engine answers `agents_list` with an `agents` frame — or, if it does not know the command, with
  // error{bad_request}, or with silence. All three end the wait (see V.agentsView).
  // #436 T6.5: the read-only hooks preview rides the SAME ask: one extra closed command when the
  // Conexiones tab opens (and never on a timer), so the six rows get their real state cheaply.
  function askAgents() {
    if (agentsAsk) clearTimeout(agentsAsk.timer);
    const ask = { at: (agentState && agentState.last_error && agentState.last_error.n) || 0, timedOut: false, timer: 0 };
    ask.timer = setTimeout(() => { ask.timedOut = true; if (isOpen() && screen === 'accounts') render(); }, V.AGENTS_WAIT_MS);
    agentsAsk = ask;
    agent({ action: 'agents_list' }).catch(() => {});
    agent({ action: 'hooks_preview' }).catch(() => {});
  }
  // The first state normally arrives within a few ms. If it never does, stop saying «Conectando»: the engine
  // is not there, and the screen says so (the same honest word as before, just not before it was asked).
  let connectTimer = 0;
  // #408: Ajustes asks Rust for the Settings size on open and gives it back on close. Rust owns the number
  // (geometry::settings_visible, clamped to the work area); the page only says open/closed. A failure
  // leaves the chat size, which still works (scrolling), so it is never fatal.
  function askSize(openNow) { call('settings_view', { open: openNow }).catch(() => {}); }
  function open(id) {
    if (!WINDOW_MODE) return openSettingsWindow();
    clearTimeout(connectTimer);
    if (agentState === null) connectTimer = setTimeout(() => { if (agentState === null) { agentState = { connection: 'no_daemon' }; if (isOpen()) render(); } }, V.CONNECT_WAIT_MS);
    panel.inert = false; panel.dataset.open = 'true'; capsule.dataset.settings = 'open';
    for (const b of openers) b.setAttribute('aria-expanded', 'true');
    if (!WINDOW_MODE) askSize(true); // #366: the own window never resizes the island
    syncRail();
    refreshAll();
    showScreen(id || screen);
    $('settings-close').focus();
  }
  function close(byKeyboard) {
    lastRenderKey = null;
    // Stop every mounted character, including in the dedicated Settings window.
    if (blobsMounted && window.AbitoPillSettings) {
      window.AbitoPillSettings.dispose(blobsHost);
      blobsMounted = false;
    }
    // #366 F093: in the own window the panel close IS the window close: the ONE closed
    // command asks Rust (the island's size and focus are never this window's business).
    if (WINDOW_MODE) {
      call('settings_window_action', { action: 'close' }).catch(() => {});
      panel.inert = true; delete panel.dataset.open;
      document.dispatchEvent(new CustomEvent('abito:settings-tab', { detail: null }));
      if (agentsAsk) { clearTimeout(agentsAsk.timer); agentsAsk = null; }
      discardAccountForm();
      drafts.reset();
      return;
    }
    if (isOpen()) askSize(false);
    panel.inert = true; delete panel.dataset.open; delete capsule.dataset.settings;
    document.dispatchEvent(new CustomEvent('abito:settings-tab', { detail: null })); // closes the model picker with it
    capturing = false; filter = ''; pendingLogin = null; loginTarget = null; accountNote = null;
    if (agentsAsk) { clearTimeout(agentsAsk.timer); agentsAsk = null; }
    for (const b of openers) b.setAttribute('aria-expanded', 'false');
    discardAccountForm();
    drafts.reset(); // a half-typed key never outlives the panel
    if (waiting) { clearTimeout(waiting.timer); waiting = null; }
    // #408: focus returns to the control that opened Ajustes (the gear in the chat header)
    if (byKeyboard) { const g = $('open-screen-settings'); if (g) g.focus(); }
  }
  const isOpen = () => panel.dataset.open === 'true';

  // #455 S8: one route, regardless of legacy placement. Failure never mounts island settings.
  // `page` is one of the window's own page ids (Rust re-checks it against its closed list and ignores anything else).
  function openSettingsWindow(page) {
    return call('settings_window_action', typeof page === 'string' ? { action: 'open', page } : { action: 'open' }).then(result => {
      if (!result || result.open !== true) throw new Error('window unavailable');
    }).catch(() => {
      const feedback = $('chat-live') || live;
      feedback.textContent = 'No se pudo abrir Ajustes. Probá de nuevo.';
    });
  }
  for (const b of [...openers, $('open-settings')].filter(Boolean)) b.addEventListener('click', e => {
    if (e.isTrusted === true) openSettingsWindow();
  });
  const gear = $('open-settings');
  document.addEventListener('island:view', e => {
    if (e.detail === 'chat' && pendingOpen) { const id = pendingOpen; pendingOpen = false; open(id); }
    else if (e.detail !== 'chat' && isOpen()) close(false);
  });
  $('settings-close').addEventListener('click', e => { if (e.isTrusted === true) close(e.detail === 0); });

  // The inert seam for the visual probe (a script click is rightly not a trusted gesture): a CustomEvent
  // that only opens a screen, never a setting. The shipped binary has no probe, so nothing ever fires it.
  document.addEventListener('abito:settings-select', e => {
    // #503 S5: engine/account deep links land on Chat, not on the window's default page
    if (!WINDOW_MODE) { openSettingsWindow(Object.prototype.hasOwnProperty.call(V.PI_SECTIONS, e.detail) || e.detail === 'accounts:oauth' || e.detail === 'accounts:api_key' ? 'chat' : undefined); return; }
    if (e.detail === 'open') open(screen);
    else if (V.tabAlias(e.detail) && !String(e.detail).includes(':')) { filter = ''; if (isOpen()) showScreen(e.detail); else open(V.tabAlias(e.detail)); }
    // Pi deep links from the island's status row: land on Conexiones, then scroll/focus the right section
    else if (Object.prototype.hasOwnProperty.call(V.PI_SECTIONS, e.detail)) { pendingSection = V.PI_SECTIONS[e.detail]; if (isOpen()) showScreen('accounts'); else open('accounts'); focusPendingSection(); }
    // the old accounts:<method> deep links still land on Conexiones; the method choice now lives in each row
    else if (e.detail === 'accounts:oauth' || e.detail === 'accounts:api_key') { if (isOpen()) showScreen('accounts'); else open('accounts'); }
  });
  // Escape: the shortcut capture first, then the panel (never the island)
  document.addEventListener('keydown', e => {
    if (!isOpen() || e.isComposing) return;
    if (capturing) {
      const r = V.captureCombo(e);
      if (r.kind === 'ignore') return;
      e.preventDefault(); e.stopPropagation();
      if (r.kind === 'wait') return;
      capturing = false;
      if (r.kind === 'combo') setHotkey(r.text);
      else if (r.kind === 'needs_modifier') say('El atajo necesita Ctrl, Alt o Súper.');
      else if (r.kind === 'unsupported') say('Esa tecla no se puede usar en un atajo.');
      render();
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
  }, true);

  // ---- data ---------------------------------------------------------------------------------------------------------------
  function refreshAll() {
    agent({ action: 'view' }).then(applyAgent, () => {});
    call('prefs_action', { action: 'view' }).then(p => { prefs = p; render(); }, () => {});
    call('hotkey_action', { action: 'view' }).then(h => { hotkey = h; render(); }, () => {});
    if (window.desktop) window.desktop.snapshot().then(s => { motionOverride = s.motionOverride !== false; render(); }, () => {});
  }
  // #366 F093: the gear consults the placement pref even before the panel was ever
  // opened, so the typed choice survives a page reload: one honest view fetch at startup.
  if (!WINDOW_MODE) call('prefs_action', { action: 'view' }).then(p => { prefs = p; }, () => {});
  function applyAgent(next) {
    if (next && typeof next === 'object') {
      if (Object.hasOwn(next, 'ownedAccounts')) ownedAccounts = next.ownedAccounts === null ? null : { accounts: V.ownedAccounts(next.ownedAccounts) };
      // Partial local snapshots cannot erase the independent OAuth/connector state.
      agentState = Object.assign({}, agentState || {}, next);
      settle(agentState); render();
    }
  }
  if (listen) {
    const warnListen = name => err => console.error(`settings: live ${name} events unavailable`, err); // R1: never swallowed again
    listen('agent:state', e => applyAgent(e && e.payload)).catch(warnListen('agent:state'));
    listen('prefs:state', e => { if (e && e.payload) { prefs = e.payload; render(); } }).catch(warnListen('prefs:state'));
    listen('hotkey:state', e => { if (e && e.payload) { hotkey = e.payload; render(); } }).catch(warnListen('hotkey:state'));
  }
  // A command is only «done» when the engine says so: the invoke result is the state at WRITE time, the answer
  // arrives later as `agent:state`. `waiting` holds what we sent; the next state either carries a newer
  // engine error (say it, with icon+word) or a real change (say the success). Silence past the deadline is
  // reported honestly, never as success.
  const WAIT_MS = 5000;
  let waiting = null;
  const withoutError = st => JSON.stringify(Object.assign({}, st, { last_error: null }));
  function settle(after) {
    if (!waiting) return;
    const w = waiting;
    const out = V.commandOutcome(w.before, after, w.okSay);
    if (out.ok === false) { waiting = null; clearTimeout(w.timer); say(out.say); showFailure(out); return; }
    if (after && withoutError(after) !== w.beforeJson) { waiting = null; clearTimeout(w.timer); if (w.okSay) say(w.okSay); }
  }
  function showFailure(out) {
    const chip = $('settings-conn');
    chip.hidden = false; chip.dataset.tone = out.tone; chip.setAttribute('aria-label', out.say);
    putIcon($('settings-conn-icon'), out.icon); $('settings-conn-word').textContent = out.word;
    clearTimeout(failureTimer); failureTimer = setTimeout(() => { failureTimer = 0; render(); }, 6000);
  }
  let failureTimer = 0;
  function send(payload, okSay) {
    if (busy) return;
    // HU-015: agent hook changes use the daemon-free host route only; the engine's connection says nothing about them.
    if (payload && (payload.action === 'agent_connect' || payload.action === 'agent_disconnect')) {
      busy = true;
      agent(payload).then(next => {
        busy = false; applyAgent(next);
        const out = V.directOutcome(next, payload.agentId, okSay);
        say(out.say); if (!out.ok) showFailure({ word: 'No se pudo', icon: 'triangle', tone: 'red', say: out.say });
      }, error => { busy = false; say((error && error.message) || 'No se pudo completar.'); render(); });
      return;
    }
    busy = true;
    const before = agentState;
    if (waiting) clearTimeout(waiting.timer);
    waiting = okSay ? { before, beforeJson: withoutError(before), okSay, timer: setTimeout(() => { waiting = null; say('El motor no respondió.'); showFailure({ word: 'Sin respuesta', icon: 'clock', tone: 'sun', say: 'Sin respuesta.' }); }, WAIT_MS) } : null;
    agent(payload).then(next => { busy = false; applyAgent(next); }, error => {
      busy = false;
      if (waiting) { clearTimeout(waiting.timer); waiting = null; }
      if (loginTarget && loginTarget.phase === 'active' && !loginTarget.sawFlow && /^(auth_start|account_create)$/.test(payload.action)) { loginTarget.phase = 'error'; pendingLogin = null; }
      say((error && error.message) || 'No se pudo completar.'); render();
    });
  }
  function setHotkey(text) {
    call('hotkey_action', { action: 'set', combo: text }).then(h => {
      hotkey = h; render();
      const out = V.hotkeySetOutcome(h, text); // «cambiado» only when the backend really took it
      say(out.say);
    }, error => say((error && error.message) || 'No se pudo cambiar el atajo.'));
  }

  // DEBT (#306): the engine also pushes a `settings` frame that holds ITS copy of the shortcut. This panel
  // ignores it and keeps the island's own hotkey.json as the only store, so the two can drift. Reconciling
  // them needs a decision about which store wins, not a patch here.

  // ---- rendering --------------------------------------------------------------------------------------------------------------
  // #439: the portal pushes state about every 400 ms. A push that changes nothing
  // the panel renders must not rebuild the DOM — every rebuild replays the view
  // transitions and blinks Ajustes while the human navigates. The key is derived
  // from the SAME inputs render() reads (keep the two in sync when editing either);
  // live DRAFT VALUES (nameDraft, gainDraft, the makeDrafts fields) are
  // deliberately excluded: the user's keystrokes are already in the DOM and every
  // rebuild re-reads the same drafts, so they can never make the output stale.
  // busy/waiting/accountGeneration render nothing and stay out too. There is no
  // clock-driven text in this panel; the one timed visual is the failure chip,
  // whose 6 s callback resets the failureTimer bit below before rendering.
  let lastRenderKey = null;
  function renderKey() {
    // Blobs owns its visible-input projection. A sound/account push must not detach this screen.
    if (screen === 'pills' && window.AbitoPillSettings) {
      return JSON.stringify([screen, window.AbitoPillSettings.inputKey({ prefs, ...ownerState() }), pillSaving, pillError]);
    }
    return JSON.stringify([
      screen, filter, prefs, hotkey, motionOverride, ownedAccounts,
      accountForm ? 'form' : null, accountSaving, accountError, accountNote,
      agentState && { connection: agentState.connection, providers: agentState.providers,
        accounts: agentState.accounts, profiles: agentState.profiles, connectors: agentState.connectors,
        agents: agentState.agents, hooks: agentState.hooks, last_error: agentState.last_error,
        auth: agentState.auth, unavailable: agentState.unavailable },
      agentsAsk ? [agentsAsk.at, agentsAsk.timedOut] : null,
      keyPresence, keyLoad, keyBusy, keyNotes,
      loginTarget, pendingLogin, daemonBusy, daemonNote,
      nameSaving, nameError, gainSaving, gainError, autoSaving, autoError, capturing,
      themeError, colorErrors, pillSaving, pillError,
      specialistIdentities(), screen === 'pills' ? ownerState() : null, failureTimer !== 0,
    ]);
  }
  function render() {
    if (!isOpen()) return;
    queueMicrotask(focusPendingSection);
    // Every tab exit disposes Blobs, including Models/Connections, which bypass renderGeneral().
    if (screen !== 'pills' && blobsMounted) {
      window.AbitoPillSettings?.dispose(blobsHost);
      blobsMounted = false;
    }
    const key = renderKey();
    if (key === lastRenderKey) return;
    lastRenderKey = key;
    const keep = body.scrollTop;
    const active = document.activeElement;
    const focused = active && active.id;
    const caret = active && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    body.textContent = '';
    const conn = V.connectionView(agentState);
    const chip = $('settings-conn');
    chip.hidden = !conn || screen !== 'accounts';
    if (conn) { chip.dataset.tone = conn.tone; chip.setAttribute('aria-label', conn.aria); putIcon($('settings-conn-icon'), conn.icon); $('settings-conn-word').textContent = conn.word; }
    if (screen === 'accounts') { renderAccounts(); renderConnectors(); renderKeys(); }
    else if (screen === 'models') { /* models.js owns this panel */ }
    else renderGeneral(); // pills / appearance / general: each section names its tab
    if (moreGroup) { moreGroup.hidden = !V.servicesGroupVisible(screen); if (!moreGroup.hidden) body.append(moreGroup); }
    body.scrollTop = keep;
    if (focused && $(focused) && body.contains($(focused))) {
      $(focused).focus();
      if (caret) { try { $(focused).setSelectionRange(caret[0], caret[1]); } catch { /* not a text field */ } }
    }
  }

  // #308: Abito-owned configuration, not a daemon login or a readiness claim.
  function accountTarget(node) {
    node.style.minHeight = '44px'; node.style.minWidth = '44px';
    node.style.maxWidth = '100%'; node.style.boxSizing = 'border-box';
    return node;
  }
  function renderOwnedAccounts() {
    const section = el('section', 'ssec'); section.id = 'owned-accounts';
    section.append(sectionTitle('Configuración de proveedores'));
    if (ownedAccounts === null) {
      section.append(el('p', 'snote', 'El almacén de cuentas no está disponible. No se modificó ninguna cuenta.'));
    } else if (accountForm) {
      // Keep the same masked DOM field across unrelated daemon/prefs pushes; never copy its value into drafts.
      section.append(accountForm);
    } else {
      for (const account of ownedAccounts.accounts) {
        const row = el('div', 'srow'); row.style.flexWrap = 'wrap';
        const title = el('b', 'srow-title', account.config.nombre); title.style.overflowWrap = 'anywhere';
        // #410 S2: the credential state is an icon chip from the closed registry (same two words as
        // before) instead of a bare line of muted text. Faint tone: a stored key is CONFIGURATION,
        // never a connection claim (#308).
        row.append(title, chipNode({ tone: 'faint', icon: account.hasCredential ? 'lock' : 'plug-off',
          word: account.hasCredential ? 'Clave guardada' : 'Sin clave' }));
        row.append(accountTarget(wordBtn('Editar', () => { accountForm = makeAccountForm(account); render(); }, { disabled: accountSaving, aria: `Editar ${account.config.nombre}` })));
        // #409 T2 / S5: deletion stays reachable now that the Pi card is gone (same sentences, same non-mutation).
        row.append(accountTarget(wordBtn('Quitar conexión', () => removeAccount(account.accountId), { icon: 'plug-off', disabled: accountSaving, aria: `Quitar conexión: ${account.config.nombre}` })));
        section.append(row);
      }
      const add = accountTarget(wordBtn('Configurar proveedor', () => { accountForm = makeAccountForm(null); render(); }, { disabled: accountSaving }));
      add.id = 'account-add'; section.append(add);
    }
    if (accountNote) { const n = el('p', accountNote.tone === 'red' ? 'snote sproblem' : 'snote', accountNote.say); n.setAttribute('role', accountNote.tone === 'red' ? 'alert' : 'status'); section.append(n); }
    if (accountError) { const error = el('p', 'snote', accountError); error.setAttribute('role', 'alert'); section.append(error); }
    body.append(section);
  }
  // #409 T2: removing an owned account from its row. Success updates the masked snapshot from the
  // reply; failure changes nothing and says so. The verb and sentences are the ones of the removed card.
  function removeAccount(accountId) {
    if (accountSaving) return;
    accountSaving = true; accountNote = null; render();
    agent({ action: 'abito_account_remove', accountId }).then(r => {
      accountSaving = false;
      if (r && Object.hasOwn(r, "ownedAccounts") && r.ownedAccounts) ownedAccounts = { accounts: V.ownedAccounts(r.ownedAccounts) };
      accountNote = { tone: 'go', say: 'Conexión quitada. La clave se borró del almacén de Abito.' }; render(); say(accountNote.say);
    }, () => { accountSaving = false; accountNote = { tone: 'red', say: 'No se pudo quitar la conexión. No se cambió nada.' }; render(); });
  }
  function makeAccountForm(saved) {
    accountError = '';
    const form = el('form', 'sform'); form.id = 'account-form'; form.autocomplete = 'off';
    // Existing sform is horizontal for short auth replies; configuration needs a single narrow column.
    form.style.display = 'flex'; form.style.flexDirection = 'column'; form.style.flexWrap = 'nowrap';
    form.style.alignItems = 'stretch'; form.style.gap = '8px'; form.style.minWidth = '0';
    const field = (id, title, kind, value) => {
      const label = el('label', 'snote', title); label.htmlFor = id;
      const node = accountTarget(el(kind === 'select' ? 'select' : 'input', 'sfield'));
      // Neutralize the auth form's text-input order/flex rule only inside this editor.
      node.id = id; node.style.width = '100%'; node.style.order = '0'; node.style.flex = 'none'; node.autocomplete = 'off';
      if (kind !== 'select') { node.type = kind; node.value = value || ''; node.maxLength = 2048; }
      form.append(label, node); return node;
    };
    const option = (select, value, text) => { const node = el('option', '', text); node.value = value; select.append(node); };
    const provider = field('account-provider', 'Proveedor', 'select');
    const presets = [
      ['anthropic', 'Anthropic', 'https://api.anthropic.com/v1', 'anthropic-messages'],
      ['google', 'Google', 'https://generativelanguage.googleapis.com/v1beta', 'google-generative-ai'],
      ['openai', 'OpenAI', 'https://api.openai.com/v1', 'openai-completions'],
      ['openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1', 'openai-completions'],
      ['ollama', 'Ollama (local)', 'http://127.0.0.1:11434/v1', 'openai-completions'],
      ['lmstudio', 'LM Studio (local)', 'http://127.0.0.1:1234/v1', 'openai-completions'],
      // HU-041 (deferred to after 0.1.2): no new custom endpoint; saved custom accounts still render via the fallback below.
    ];
    for (const [id, title] of presets) option(provider, id, title);
    if (saved && !presets.some(p => p[0] === saved.provider)) option(provider, saved.provider, saved.provider);
    provider.value = saved ? saved.provider : 'openai'; provider.disabled = !!saved;
    const config = saved ? saved.config : {};
    const name = field('account-name', 'Nombre de la cuenta', 'text', config.nombre || 'OpenAI'); name.maxLength = 80;
    const url = field('account-url', 'URL base (HTTPS remota / HTTP de loopback local)', 'text', config.baseUrl || 'https://api.openai.com/v1');
    const api = field('account-api', 'API', 'select');
    for (const id of ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']) option(api, id, id);
    api.value = config.api || 'openai-completions';
    const models = field('account-models', 'Modelos (separados por comas)', 'text', (config.models || []).join(', '));
    const defaultModel = field('account-default', 'Modelo predeterminado de esta cuenta', 'text', config.defaultModel); defaultModel.maxLength = 200;
    const credential = field('account-credential', saved && saved.hasCredential ? 'Clave guardada' : 'Sin clave guardada', 'select');
    option(credential, 'keep', 'Conservar'); option(credential, 'set', 'Establecer clave'); option(credential, 'clear', 'Borrar clave');
    const secret = field('account-secret', 'Clave (oculta; nunca se recupera del almacén)', 'password');
    secret.maxLength = 4096; secret.spellcheck = false; secret.disabled = true;
    secret.setAttribute('autocapitalize', 'off'); secret.setAttribute('autocomplete', 'new-password');
    credential.addEventListener('change', e => { if (e.isTrusted === true) { secret.value = ''; secret.disabled = credential.value !== 'set'; } });
    provider.addEventListener('change', e => {
      if (e.isTrusted !== true) return;
      const preset = presets.find(p => p[0] === provider.value);
      if (preset) { name.value = preset[1]; url.value = preset[2]; api.value = preset[3]; }
      secret.value = ''; credential.value = 'keep'; secret.disabled = true;
    });
    const controls = el('div', 'srow-actions'); controls.style.flexWrap = 'wrap'; controls.style.gap = '8px';
    const save = accountTarget(wordBtn('Guardar configuración', () => {}, { primary: true })); save.type = 'submit'; save.id = 'account-save';
    controls.append(save);
    if (saved) {
      const endpoint = accountTarget(wordBtn('Guardar endpoint', () => submit('abito_account_endpoint_set')));
      endpoint.id = 'account-endpoint'; controls.append(endpoint);
    }
    controls.append(accountTarget(wordBtn('Cancelar', () => { discardAccountForm(); render(); })));
    form.append(controls);
    form.addEventListener('submit', e => {
      e.preventDefault(); if (e.isTrusted === true) submit(saved ? 'abito_account_save' : 'abito_account_create');
    });
    function submit(action) {
      if (accountSaving) return;
      const value = { nombre: name.value, baseUrl: url.value, api: api.value, compat: config.compat || {},
        models: models.value.split(',').map(x => x.trim()).filter(Boolean), defaultModel: defaultModel.value };
      if (credential.value === 'set') value.apiKey = secret.value;
      else if (credential.value === 'clear') value.apiKey = null;
      secret.value = ''; // clear BEFORE IPC, including on failure; never keep a retry credential
      const payload = { action, accountId: saved ? saved.accountId : `account-${Date.now().toString(36)}`, provider: provider.value, config: value };
      accountSaving = true; accountError = '';
      const generation = accountGeneration;
      const buttons = [...controls.querySelectorAll('button')]; buttons.forEach(b => { b.disabled = true; });
      agent(payload).then(next => {
        accountSaving = false;
        if (generation === accountGeneration) discardAccountForm();
        applyAgent(next); say('Configuración guardada. Conexión no probada.');
      }, () => {
        accountSaving = false;
        if (generation !== accountGeneration) return;
        buttons.forEach(b => { b.disabled = false; });
        accountError = 'No se pudo guardar. Revisá la URL, los modelos y los permisos. Se mantuvo la configuración anterior; volvé a ingresar la clave si corresponde.';
        render(); say(accountError);
      });
      // Payload is only retained by the one IPC invocation, never in the page's persistent draft state.
    }
    return form;
  }

  // ---- Cuentas (gentle-dot AccountsPanel): Conectadas → dos tarjetas de método → lista de proveedores con buscador ----
  function sectionTitle(text) { return el('h3', 'ssection', text); }
  // #390 GD027: ONE closed command stops and relaunches the daemon (Rust owns the whole
  // lifecycle: bounded stop, fresh spawn, bounded wait). The wording is ours; a failure is
  // shown, never hidden; the button disables itself while a restart is in flight.
  function renderDaemonSection() {
    const v = V.daemonRestartView(daemonBusy);
    const sec = el('section', 'ssec'); sec.id = 'daemon-restart';
    sec.append(sectionTitle(v.title));
    // T7.2 design (ajustes-ventana-conexiones-*.png): one card row — «Motor local» over the
    // «Último estado conocido» sub, the LAST KNOWN state as a chip (honest: it is what the page
    // last heard, not a live probe), then the design's «Reiniciar» button.
    const row = el('div', 'srow sdaemon-row');
    const titles = el('span', 'srow-titles');
    titles.append(el('span', 'srow-title', v.rowTitle));
    titles.append(el('span', 'srow-sub', v.rowSub));
    row.append(titles);
    const conn = V.connectionView(agentState);
    if (conn) row.append(chipNode({ tone: conn.tone, icon: conn.icon, word: conn.word, aria: conn.aria }));
    const actions = el('span', 'srow-actions');
    actions.append(wordBtn(v.action.label, () => restartDaemon(), { icon: 'refresh', disabled: v.action.disabled, aria: v.action.aria }));
    row.append(actions);
    sec.append(row);
    if (daemonNote) {
      const note = el('p', daemonNote.tone === 'red' ? 'snote sproblem' : 'snote', daemonNote.say);
      note.id = 'daemon-restart-note';
      note.setAttribute('role', daemonNote.tone === 'red' ? 'alert' : 'status');
      sec.append(note);
    }
    body.append(sec);
  }
  function restartDaemon() {
    if (daemonBusy) return;
    daemonBusy = true; daemonNote = null; render();
    call('daemon_action', { action: 'restart' }).then(result => {
      daemonBusy = false;
      daemonNote = V.daemonRestartOutcome(result);
      render();
      say(daemonNote.say);
      agent({ action: 'view' }).then(applyAgent, () => {}); // the fresh daemon's state, through the normal channel
    }, error => {
      daemonBusy = false;
      daemonNote = V.daemonRestartOutcome(null, error);
      render();
      say(daemonNote.say);
    });
  }
  function renderAccounts() {
    renderDaemonSection();
    renderOwnedAccounts();
    const st = agentState || { connection: 'connecting', providers: [], accounts: [], profiles: { profiles: [], active: null }, auth: {} };
    const auth = st.auth || {};
    const prompt = V.promptView(auth.prompt);
    drafts.scope(prompt ? `${prompt.flowId}:${prompt.promptId}` : '');
    const eventV = V.eventView(auth.event);
    // a login that was waiting for its brand-new account starts the moment that account shows up
    const ready = V.pendingLoginReady(st, pendingLogin);
    if (ready) { pendingLogin = null; queueMicrotask(() => send({ action: 'auth_start', accountId: ready.accountId, method: ready.method })); }
    const flowLive = !!(prompt || eventV || (auth.flowId && !auth.last));
    // #408: the page remembers WHICH provider started the login, so status, progress and error sit on its card.
    if (loginTarget && loginTarget.phase === 'active') {
      if (flowLive) { loginTarget.sawFlow = true; if (!loginTarget.flowId && auth.flowId) loginTarget.flowId = String(auth.flowId); }
      else if (loginTarget.sawFlow && auth.last) {
        const out = V.flowOutcome(auth.last);
        if (out.word === 'Conectada') loginTarget = null;
        else loginTarget.phase = out.word === 'Cancelado' ? 'cancelled' : 'error';
      }
    }
    if (flowLive && !loginTarget) { body.append(renderFlow(auth, prompt, eventV)); return; } // a flow started elsewhere
    const outcome = loginTarget ? null : V.flowOutcome(auth.last);
    if (outcome && outcome.word === 'Conectada') body.append(chipNode({ tone: outcome.tone, icon: outcome.icon, word: outcome.word, aria: `Inicio de sesión: ${outcome.word}` }));
    // #410 round 2: the compact provider LIST (one row per provider, two buttons: API / Auth).
    // The method filter bar is gone: the two per-row buttons ARE the method choice. The search
    // stays, so a long engine list is still usable.
    const search = el('input', 'sfield'); search.type = 'search'; search.id = 'settings-filter'; search.placeholder = 'Buscar proveedor';
    search.setAttribute('aria-label', 'Buscar proveedor'); search.autocomplete = 'off'; search.maxLength = 80; search.value = filter;
    search.addEventListener('input', () => { filter = search.value; render(); });
    body.append(search);
    const sec = el('section', 'ssec'); sec.id = 'provider-list'; sec.append(sectionTitle('Proveedores'));
    const rows = V.providerRows(st, { filter, flow: loginTarget });
    const list = el('ul', 'srows sconn'); list.setAttribute('aria-label', 'Proveedores');
    for (const r of rows) {
      const li = el('li', 'srow sconn-row'); li.dataset.state = r.status.kind; li.dataset.provider = r.id;
      const head = el('span', 'sconn-head'); head.append(el('b', 'srow-title', r.name), chipNode({ tone: r.status.tone, icon: r.status.icon, word: r.status.word, aria: `${r.name}: ${r.status.word}` }));
      li.append(head);
      if (r.error) { const e = el('p', 'snote sproblem', r.error); e.setAttribute('role', 'alert'); li.append(e); }
      if (r.note) li.append(el('p', 'snote', r.note));
      if (r.status.kind === 'progress' && flowLive) li.append(renderFlow(auth, prompt, eventV, true));
      else if (r.status.kind === 'progress') li.append(el('p', 'snote', 'Preparando el inicio de sesión…'));
      const actions = el('span', 'srow-actions');
      // the two connect words ride the view-model (the human's own: API / Auth); the row's
      // cancel/logout are the same closed verbs as before, just behind state
      const connect = a => wordBtn(a.word, () => loginWith(r.id, a.method), { aria: a.aria, disabled: a.disabled });
      if (r.api) actions.append(connect(r.api));
      if (r.auth) actions.append(connect(r.auth));
      if (r.cancel) actions.append(wordBtn(r.cancel.word, () => cancelLogin(), { icon: 'cross', aria: r.cancel.aria }));
      if (r.logout) actions.append(wordBtn(V.LOGOUT_WORD, () => send({ action: 'account_logout', accountId: r.accountId }, `${r.name}: sesión cerrada.`), { icon: 'plug-off', aria: `${V.LOGOUT_WORD}: ${r.name}` }));
      if (actions.children.length) li.append(actions);
      list.append(li);
    }
    if (!rows.length) list.append(el('li', 'sempty', V.connectionView(st) ? V.connectionView(st).word : 'Sin resultados'));
    sec.append(list); body.append(sec);
  }
  function cancelLogin() {
    const plan = V.cancelPlan(loginTarget);
    if (plan.kind === 'send') { send({ action: 'auth_cancel', flowId: plan.flowId }); return; }
    loginTarget = null; pendingLogin = null; render();
  }
  // «Iniciar sesión» / «Usar una clave»: reuse the provider's account, or create one named after the provider first
  function loginWith(providerId, m) {
    const plan = V.loginPlan(agentState, providerId, m);
    if (!plan) return;
    loginTarget = { providerId, phase: 'active', sawFlow: false };
    render();
    if (plan.kind === 'start') { send({ action: 'auth_start', accountId: plan.accountId, method: plan.method }); return; }
    pendingLogin = V.pendingLogin(agentState, plan.provider, plan.method);
    send({ action: 'account_create', provider: plan.provider, label: plan.label }, `${plan.label}: cuenta creada.`);
  }

  // The sign-in flow. The ONLY secret path: a masked field -> auth_reply -> cleared.
  function renderFlow(auth, prompt, eventV, embedded) {
    const box = el('div', 'sflow'); box.setAttribute('role', 'group'); box.setAttribute('aria-label', 'Inicio de sesión en curso');
    if (eventV) {
      if (eventV.message) box.append(el('p', 'sline', eventV.message));
      if (eventV.userCode) box.append(Object.assign(el('code', 'scode', eventV.userCode), { title: 'Código de verificación' }));
      if (eventV.link) {
        // #421: a real anchor, but href never carries the remote URL (the webview must not navigate away).
        // Every gesture (click, Ctrl/Meta/Shift+click, Enter, middle click, context-menu) is cancelled and
        // only a trusted one opens, through the validated host command. Text via textContent only.
        const a = el('a', 'slink', eventV.link);
        a.setAttribute('href', '#'); a.setAttribute('role', 'link'); a.title = 'Abrir el enlace';
        const open = e => {
          e.preventDefault(); e.stopPropagation();
          if (e.isTrusted === true && invoke) invoke('open_chat_url', { payload: { url: eventV.link } }).catch(() => {});
        };
        a.addEventListener('click', open); a.addEventListener('auxclick', open);
        a.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); });
        box.append(a);
      } else if (eventV.linkRejected) {
        box.append(el('p', 'sline sub', 'No se pudo abrir el enlace desde acá.')); // never echoes the rejected URL
      }
    }
    if (prompt) {
      box.append(el('p', 'sline', prompt.message));
      if (prompt.control === 'select') {
        for (const o of prompt.options) box.append(wordBtn(o.label, () => reply(prompt, o.id)));
      } else if (prompt.control === 'confirm') {
        box.append(wordBtn('Sí', () => reply(prompt, 'yes'), { primary: true }), wordBtn('No', () => reply(prompt, 'no')));
      } else {
        const f = el('form', 'sform');
        const inp = el('input', 'sfield'); inp.id = 'settings-secret';
        inp.type = prompt.masked ? 'password' : 'text';
        inp.autocomplete = 'off'; inp.spellcheck = false; inp.setAttribute('autocapitalize', 'off'); inp.maxLength = 4096;
        inp.placeholder = prompt.placeholder || (prompt.masked ? 'Pegá tu clave' : 'Escribí…');
        inp.setAttribute('aria-label', prompt.masked ? 'Clave (se oculta al escribir)' : 'Respuesta');
        const send1 = wordBtn('Enviar', () => {}, { icon: 'arrow-up', primary: true, disabled: true });
        send1.type = 'submit';
        inp.value = drafts.get('settings-secret'); // a re-render (the portal pushes every 400 ms) never eats a half-typed key
        send1.disabled = !V.replyValid(inp.value);
        inp.addEventListener('input', () => { drafts.set('settings-secret', inp.value); send1.disabled = !V.replyValid(inp.value); });
        f.addEventListener('submit', e => {
          e.preventDefault();
          if (e.isTrusted !== true || !V.replyValid(inp.value)) return;
          const value = inp.value;
          inp.value = ''; // gone from the page before the round trip even starts
          drafts.clear('settings-secret');
          reply(prompt, value);
        });
        f.append(inp, send1);
        box.append(f);
      }
    }
    if (!embedded) box.append(wordBtn('Cancelar', () => send({ action: 'auth_cancel', flowId: prompt ? prompt.flowId : String((auth && auth.flowId) || '') }), { icon: 'cross' }));
    return box;
  }
  function reply(prompt, value) {
    agent({ action: 'auth_reply', flowId: prompt.flowId, promptId: prompt.promptId, value }).then(applyAgent, () => say('No se pudo enviar la respuesta.'));
  }

  // ---- Conectores (gentle-dot ConnectorsPanel): your code agents with ONE click, then the services ----------------------
  function renderConnectors() {
    // 1) agents: Conectar / Actualizar / Desconectar. The click IS the confirmation; the engine installs with a
    //    backup. Nothing here asks the human to open a terminal.
    const av = V.agentsView(agentState, agentsAsk ? { askedAtError: agentsAsk.at, timedOut: agentsAsk.timedOut } : {});
    const sec = el('section', 'ssec'); sec.append(sectionTitle('Agentes')); sec.id = 'connections-agents';
    if (av.kind === 'unsupported') { sec.append(chipNode(av), el('p', 'snote', av.note)); }
    else if (av.kind !== 'ready') sec.append(chipNode(av.kind === 'loading' ? { tone: 'live', icon: 'ring', word: '', aria: 'Leyendo agentes' } : av));
    else {
      const list = el('ul', 'srows'); list.setAttribute('aria-label', 'Agentes');
      for (const r of av.rows) {
        const li = el('li', 'srow sagent'); li.dataset.state = r.state;
        const head = el('span', 'sagent-head'); head.append(el('b', 'srow-title', r.name), chipNode({ tone: r.tone, icon: r.icon, word: r.word, aria: r.aria }));
        li.append(head);
        // the plan the human is about to approve, in OUR words, right above the button that approves it
        if (r.summary) li.append(el('p', 'splan', r.summary));
        if (r.note) li.append(el('p', r.trust ? 'snote strust' : 'snote', r.note));
        const actions = el('span', 'srow-actions');
        if (r.primary) actions.append(wordBtn(r.primary.label, () => send(r.primary.command, `${r.name}: ${r.primary.label === 'Actualizar' ? 'actualizado' : 'conectado'}.`), { primary: true, aria: `${r.primary.label} ${r.name}. ${r.summary || ''}` }));
        if (r.secondary) actions.append(wordBtn(r.secondary.label, () => send(r.secondary.command, `${r.name}: desconectado.`), { aria: `${r.secondary.label} ${r.name}` }));
        li.append(actions); list.append(li);
      }
      if (!av.rows.length) list.append(el('li', 'sempty', 'Sin agentes'));
      // Honest limit of asking from the island: a Claude Code run that cannot show its own prompt (`claude -p`, background subagents) treats "no answer" as DENIED.
      list.append(el('li', 'snote', 'Claude Code en modo no interactivo (claude -p, subagentes): si no respondés a tiempo desde Abito, el permiso se niega. Abito nunca lo acepta por vos.'));
      sec.append(list);
    }
    body.append(sec);
    // 2) services (read-only until the engine can connect them)
    const v = V.connectorsView(agentState);
    const svc = el('section', 'ssec'); svc.append(sectionTitle('Servicios')); svc.id = 'connections-services';
    if (v.kind !== 'ready') svc.append(chipNode(v));
    else {
      const list = el('ul', 'srows'); list.setAttribute('aria-label', 'Servicios');
      for (const i of v.items) {
        const li = el('li', 'srow'); li.append(el('b', 'srow-title', i.label));
        if (i.sends) li.append(chipNode({ tone: 'sun', icon: 'arrow-up', word: 'Puede enviar', aria: 'Este conector puede enviar, no sólo leer' }));
        if (i.word || i.icon) li.append(chipNode({ tone: i.tone, icon: i.icon, word: i.word, aria: i.word || 'Conectado' }));
        list.append(li);
      }
      if (v.empty) list.append(el('li', 'sempty', 'Sin servicios'));
      svc.append(list);
    }
    body.append(svc);
  }


  // ---- Claves (#467): secret_action, presence only. Layout adapted from Coucou src/settings/main.ts (API keys),
  // Copyright (c) 2026 Louis Raillé, MIT. The value is never read back, never kept past the save click.
  function keyCall(payload) { return call('secret_action', payload); }
  function loadKeys() {
    if (keyLoad !== 'idle') return;
    keyLoad = 'loading';
    const next = {};
    const step = i => {
      if (i >= V.KEY_IDS.length) { keyPresence = next; keyLoad = 'done'; render(); return Promise.resolve(); }
      const id = V.KEY_IDS[i];
      return keyCall(V.keyPayload('present', id)).then(r => { next[id] = !!(r && r.present === true); return step(i + 1); });
    };
    step(0).catch(error => {
      keyLoad = 'done';
      const id = V.KEY_IDS[0];
      keyNotes = { [id]: { tone: 'red', say: V.keyError(error) } };
      render();
    });
  }
  function changeKey(id, payload, okSay) {
    if (keyBusy || !payload) return;
    keyBusy = id; keyNotes = {}; render();
    keyCall(payload).then(r => {
      keyBusy = '';
      keyPresence = { ...keyPresence, [id]: !!(r && r.present === true) };
      keyNotes = { [id]: { tone: 'go', say: okSay } };
      render(); say(okSay);
    }, error => {
      keyBusy = '';
      keyNotes = { [id]: { tone: 'red', say: V.keyError(error) } };
      render(); say(keyNotes[id].say);
    });
  }
  function renderKeys() {
    const sec = el('section', 'ssec'); sec.id = 'connections-keys'; sec.append(sectionTitle('Claves'));
    sec.append(el('p', 'snote', 'Se guardan en el llavero del sistema. Acá sólo ves si hay una guardada; el valor no se muestra nunca.'));
    const list = el('ul', 'srows'); list.setAttribute('aria-label', 'Claves');
    for (const r of V.keyRows(keyLoad === 'done' ? keyPresence : null)) {
      const li = el('li', 'srow sagent'); li.dataset.state = r.state;
      const head = el('span', 'sagent-head');
      head.append(el('b', 'srow-title', r.label), chipNode({ tone: r.state === 'present' ? 'go' : 'faint', icon: r.state === 'present' ? 'check' : 'plug-off', word: r.word, aria: `${r.label}: ${r.word}` }));
      li.append(head);
      const form = el('form', 'sform'); form.noValidate = true;
      const inp = el('input', 'sfield'); inp.id = `key-input-${r.id}`; inp.type = 'password';
      inp.autocomplete = 'new-password'; inp.spellcheck = false; inp.setAttribute('autocapitalize', 'off'); inp.maxLength = 2048;
      inp.placeholder = r.state === 'present' ? 'Reemplazar…' : 'Pegá el valor';
      inp.setAttribute('aria-label', `${r.label}: valor nuevo (se oculta al escribir)`);
      inp.value = drafts.get(inp.id);
      const save = wordBtn('Guardar', () => {}, { primary: true, disabled: !inp.value || !!keyBusy, aria: `Guardar ${r.label}` });
      save.type = 'submit';
      inp.addEventListener('input', () => { drafts.set(inp.id, inp.value); save.disabled = !inp.value || !!keyBusy; });
      form.addEventListener('submit', e => {
        e.preventDefault();
        const payload = e.isTrusted === true ? V.keyPayload('set', r.id, inp.value) : null;
        inp.value = ''; drafts.clear(inp.id); // gone from the page before the round trip, failure included
        if (payload) changeKey(r.id, payload, `${r.label}: guardada.`);
      });
      form.append(inp, save);
      if (r.state === 'present') form.append(wordBtn('Quitar', () => changeKey(r.id, V.keyPayload('clear', r.id), `${r.label}: quitada.`), { disabled: !!keyBusy, aria: `Quitar ${r.label}` }));
      li.append(form);
      const note = keyNotes[r.id];
      if (note) { const n = el('p', note.tone === 'red' ? 'snote sproblem' : 'snote', note.say); n.setAttribute('role', note.tone === 'red' ? 'alert' : 'status'); li.append(n); }
      list.append(li);
    }
    sec.append(list);
    body.append(sec);
    loadKeys();
  }

  function toggleRow(id, word, on, onClick, extraChip) {
    const row = el('div', 'srow');
    row.append(el('span', 'srow-title', word));
    if (extraChip) row.append(extraChip);
    const b = el('button', 'switch'); b.type = 'button'; b.id = id; b.setAttribute('role', 'switch'); b.setAttribute('aria-checked', on ? 'true' : 'false'); b.setAttribute('aria-label', word);
    b.append(el('span', 'knob'));
    b.addEventListener('click', e => { if (e.isTrusted === true) onClick(); });
    row.append(b);
    return row;
  }
  // General row/section pattern adapted from windows/src/settings/main.ts (generalSection)
  // and windows/src/settings/settings.css (.row / section).
  // Copyright (c) 2026 Louis Raillé, MIT. Abito copy, controls, icons and synthesized sound only.
  function renderGeneral() {
    const g = V.generalView({ sound: prefs.sound, gain: prefs.gain, motionOverride, hotkey });
    // T6: General also exposes motion/theme; Appearance retains its existing content.
    // Other tabs' sections stay detached, including Appearance's identity colours.
    const group = (tab, title, hint, inGeneral = false) => { const sec = el('section', 'ssec'); sec.append(sectionTitle(title)); if (hint) sec.append(el('p', 'snote', hint)); if (tab === screen || (screen === 'general' && inGeneral)) body.append(sec); return sec; };
    // #460 E2: clear groups, with sound toggle + volume in one row like the MIT pattern.
    // Keep Abito's persisted values and validation, including «Nunca» and custom intervals.
    const perfil = group('general', 'Perfil');
    const isla = group('general', 'Isla');
    const sound = group('general', 'Sonido');
    const shortcut = group('general', 'Atajo global');
    const personal = perfil;
    const nameForm = el('form', 'sname-form sperfil-form'); nameForm.noValidate = true;
    const label = el('label', 'srow-title', 'Nombre'); label.htmlFor = 'settings-display-name';
    const nameInput = el('input', 'sfield'); nameInput.type = 'text'; nameInput.id = 'settings-display-name';
    nameInput.autocomplete = 'off'; nameInput.spellcheck = false;
    nameInput.setAttribute('placeholder', 'Tu nombre (opcional)');
    nameInput.value = nameDraft === null ? (prefs.displayName || '') : nameDraft;
    nameInput.setAttribute('aria-describedby', 'settings-name-error');
    const error = el('p', 'snote'); error.id = 'settings-name-error'; error.setAttribute('role', 'status');
    const save = el('button', 'sbtn primary', nameSaving ? 'Guardando…' : 'Guardar nombre'); save.type = 'submit';
    const paint = () => {
      const issue = V.displayNameProblem(nameInput.value);
      error.textContent = nameError || issue;
      nameInput.setAttribute('aria-invalid', issue ? 'true' : 'false');
      save.disabled = nameSaving || !!issue;
    };
    nameInput.addEventListener('input', () => { nameDraft = nameInput.value; nameError = ''; paint(); });
    nameForm.addEventListener('submit', e => {
      e.preventDefault();
      if (!e.isTrusted || nameSaving || V.displayNameProblem(nameInput.value)) return;
      const typed = nameInput.value;
      nameDraft = typed; nameError = ''; nameSaving = true; paint(); save.textContent = 'Guardando…';
      call('prefs_action', { action: 'set_display_name', display_name: typed }).then(p => {
        nameSaving = false; prefs = p;
        if (nameDraft === typed) nameDraft = null;
        render(); say(p.displayName ? 'Nombre guardado.' : 'Saludo sin nombre guardado.');
        const field = $('settings-display-name'); if (field) field.focus();
      }, () => {
        nameSaving = false; nameError = 'No se pudo guardar. Tu nombre sigue sin cambios; probá de nuevo.';
        render();
        const field = $('settings-display-name'); if (field) field.focus();
      });
    });
    nameForm.append(label, nameInput, error, save); personal.append(nameForm); paint();
    const volRow = toggleRow('sw-sound', 'Sonido', g.sound.on, () =>
      call('prefs_action', { action: g.sound.on ? 'sound_off' : 'sound_on' }).then(
        p => { prefs = p; render(); say(p.sound ? 'Sonido activado.' : 'Sonido apagado.'); },
        () => say('No se pudo guardar. El sonido sigue sin cambios; probá de nuevo.')));
    const volActions = el('span', 'srow-actions');
    const gainLabel = el('label', 'srow-sub', 'Volumen'); gainLabel.htmlFor = 'settings-sound-gain';
    volActions.append(gainLabel);
    const gainInput = el('input', 'sfield srange'); gainInput.type = 'range'; gainInput.id = 'settings-sound-gain';
    gainInput.min = '0'; gainInput.max = '0.2'; gainInput.step = '0.01';
    gainInput.value = gainDraft === null ? String(g.sound.gain) : gainDraft;
    gainInput.setAttribute('aria-label', 'Volumen');
    gainInput.setAttribute('aria-describedby', 'settings-gain-error');
    const gainValue = el('span', 'svolume-value'); gainValue.id = 'settings-sound-gain-value';
    const gainIssue = el('p', 'snote'); gainIssue.id = 'settings-gain-error'; gainIssue.setAttribute('role', 'status');
    const paintGain = () => {
      const percent = `${V.gainPercent(Number(gainInput.value))}%`;
      gainValue.textContent = percent;
      gainInput.setAttribute('aria-valuemin', '0');
      gainInput.setAttribute('aria-valuemax', '0.2');
      gainInput.setAttribute('aria-valuenow', String(gainInput.value));
      gainInput.setAttribute('aria-valuetext', percent);
      const problem = V.soundGainProblem(gainInput.value);
      gainIssue.textContent = gainError || problem;
      gainInput.setAttribute('aria-invalid', (gainError || problem) ? 'true' : 'false');
    };
    gainInput.addEventListener('input', e => {
      if (!e.isTrusted) return;
      gainDraft = gainInput.value; gainError = ''; paintGain();
    });
    // A change made while a save is in flight is kept (latest wins) and saved when that save ends,
    // instead of being dropped while the slider keeps showing a value that was never stored.
    const saveGain = typed => {
      gainDraft = typed; gainError = ''; gainSaving = true; paintGain();
      call('prefs_action', { action: 'set_sound_gain', gain: Number(typed) }).then(p => {
        gainSaving = false; prefs = p;
        const next = gainPending; gainPending = null;
        if (next !== null && Number(next) !== p.gain && !V.soundGainProblem(next)) { saveGain(next); return; }
        if (gainDraft === typed || gainDraft === next) gainDraft = null;
        render(); say('Volumen guardado.');
      }, () => {
        gainSaving = false; gainPending = null; gainError = 'No se pudo guardar. El volumen sigue sin cambios; probá de nuevo.';
        render();
        const field = $('settings-sound-gain'); if (field) field.focus();
      });
    };
    gainInput.addEventListener('change', e => {
      if (!e.isTrusted || V.soundGainProblem(gainInput.value)) return;
      if (gainSaving) { gainPending = gainInput.value; gainDraft = gainPending; paintGain(); return; }
      saveGain(gainInput.value);
    });
    volActions.append(gainInput, gainValue);
    volRow.append(volActions);
    sound.append(volRow, gainIssue); paintGain();
    // Atajo global: same behaviour (capture, reset, enable/disable), restyled to the design row;
    // the backend note becomes the row's sub line instead of a paragraph.
    if (g.hotkey) {
      const h = g.hotkey;
      const row = el('div', 'srow');
      const titles = el('span', 'srow-titles');
      titles.append(el('span', 'srow-title', 'Atajo global'));
      if (h.note) titles.append(el('span', 'srow-sub', h.note));
      row.append(titles);
      row.append(Object.assign(el('kbd', 'skbd', capturing ? 'Pulsá el atajo…' : h.combo), { id: 'settings-combo' }));
      row.append(chipNode({ tone: h.status === 'active' ? 'go' : 'faint', icon: h.backend === 'portal' ? 'check' : 'info', word: h.backendLabel, aria: h.note ? `${h.backendLabel}. ${h.note}` : h.backendLabel }));
      const actions = el('span', 'srow-actions');
      actions.append(wordBtn(capturing ? 'Cancelar' : 'Cambiar', () => { capturing = !capturing; render(); if (capturing) say('Pulsá la combinación nueva; Escape cancela.'); }, { icon: 'refresh' }));
      actions.append(wordBtn('Original', () => call('hotkey_action', { action: 'reset' }).then(r => { hotkey = r; render(); }, () => {})));
      row.append(actions);
      shortcut.append(row);
      shortcut.append(toggleRow('sw-hotkey', 'Atajo activo', h.enabled, () => call('hotkey_action', { action: h.enabled ? 'disable' : 'enable' }).then(r => { hotkey = r; render(); }, () => {})));
    }
    // #336 F003/F004: la isla se cierra sola tras la inactividad configurada y se abre al
    // pasar el mouse. The closed command always carries the FULL typed pair (exact keys,
    // 0 («Nunca») or 5..120 validated by the view-model BEFORE any rate or persistence).
    // T6.3 #434, #438 (coordinator split): Auto-cierre is the design's segmented control
    // «8 s / 15 s / 30 s / Nunca» on the contract's {0} ∪ 5..=120: presets save through the
    // closed pair, a stored non-preset value renders as its own selected segment (never
    // rewritten), and «Nunca» is a real choice that stores 0.
    const island = V.islandInteractionView(prefs);
    const autoRow = el('div', 'srow');
    autoRow.append(el('span', 'srow-title', 'Auto-cierre'));
    const autoOptions = el('span', 'sseg'); autoOptions.id = 'settings-autoclose-options';
    autoOptions.setAttribute('role', 'radiogroup');
    autoOptions.setAttribute('aria-label', 'Auto-cierre');
    const autoIssue = el('p', 'snote'); autoIssue.id = 'settings-autoclose-error'; autoIssue.setAttribute('role', 'status');
    const renderAutoSegments = () => {
      autoOptions.textContent = '';
      for (const seg of V.autoCloseSegments(island.autoCloseSeconds)) {
        const b = el('button', 'sseg-btn');
        b.type = 'button';
        b.textContent = seg.label;
        b.id = `autoclose-${seg.seconds === 0 ? 'never' : seg.seconds}`;
        if (seg.disabled) {
          b.disabled = true;
          b.setAttribute('title', seg.title);
        } else {
          b.setAttribute('role', 'radio');
          b.setAttribute('aria-checked', seg.selected ? 'true' : 'false');
          b.tabIndex = seg.selected ? 0 : -1;
          b.addEventListener('click', e => {
            if (e.isTrusted !== true || autoSaving || seg.selected) return;
            const seconds = seg.seconds;
            const problem = V.autoCloseProblem(String(seconds));
            if (problem) { autoError = problem; paintAuto(); return; }
            autoSaving = true; autoError = ''; paintAuto();
            call('prefs_action', { action: 'set_island_interaction', auto_close_seconds: seconds, open_on_hover: island.openOnHover }).then(p => {
              autoSaving = false; prefs = p;
              render(); say('Cierre automático guardado.');
            }, () => {
              autoSaving = false; autoError = 'No se pudo guardar. La interacción sigue sin cambios; probá de nuevo.';
              render();
            });
          });
        }
        autoOptions.append(b);
      }
    };
    const paintAuto = () => {
      renderAutoSegments();
      autoIssue.textContent = autoError;
    };
    autoRow.append(autoOptions);
    isla.append(autoRow, autoIssue);
    // HU-057 S9: «Tamaño de la isla» S / M / L / Auto — same segmented pattern; saved through the closed prefs verb set_island_size.
    const sizeRow = el('div', 'srow');
    sizeRow.append(el('span', 'srow-title', 'Tamaño de la isla'));
    const sizeOptions = el('span', 'sseg'); sizeOptions.id = 'settings-island-size-options';
    sizeOptions.setAttribute('role', 'radiogroup');
    sizeOptions.setAttribute('aria-label', 'Tamaño de la isla');
    for (const seg of V.islandSizeSegments(prefs && prefs.islandSize)) {
      const b = el('button', 'sseg-btn');
      b.type = 'button'; b.textContent = seg.label; b.id = `island-size-${seg.id}`;
      b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', seg.selected ? 'true' : 'false'); b.tabIndex = seg.selected ? 0 : -1;
      b.addEventListener('click', e => {
        if (e.isTrusted !== true || seg.selected || V.islandSizeProblem(seg.id)) return;
        call('prefs_action', { action: 'set_island_size', island_size: seg.id }).then(p => { prefs = p; render(); say('Tamaño de la isla guardado.'); },
          () => say('No se pudo guardar. El tamaño sigue sin cambios; probá de nuevo.'));
      });
      sizeOptions.append(b);
    }
    sizeRow.append(sizeOptions);
    isla.append(sizeRow);
    isla.append(toggleRow('sw-island-hover', 'Abrir al pasar el mouse', island.openOnHover, () => {
      const payload = { action: 'set_island_interaction', auto_close_seconds: island.autoCloseSeconds, open_on_hover: !island.openOnHover };
      call('prefs_action', payload).then(
        p => { prefs = p; render(); say(island.openOnHover ? 'La isla ya no se abre al pasar el mouse.' : 'La isla se abre al pasar el mouse.'); },
        () => say('No se pudo guardar. La interacción sigue sin cambios; probá de nuevo.'));
    }));

    paintAuto();
    const motion = group('appearance', 'Movimiento', '', true);
    motion.append(toggleRow('sw-motion', 'Animación reducida', g.motion.respectSystem, () => {
      if (!window.desktop) return;
      (g.motion.respectSystem ? window.desktop.animateAnyway() : window.desktop.respectSystemMotion()).then(s => { motionOverride = s.motionOverride !== false; render(); say(motionOverride ? 'Abito se anima siempre.' : 'Abito respeta el movimiento del sistema.'); }, () => {});
    }));
    // #380: the theme. Three fixed choices; the SAVED mode is the truth (the row renders from
    // `prefs`), and applying it is theme.js's job after the host confirms the write.
    const theme = group('appearance', 'Tema', '', true);
    const themePick = V.themeView(prefs);
    const picker = el('span', 'stheme-options');
    picker.setAttribute('role', 'radiogroup');
    picker.setAttribute('aria-label', 'Tema');
    for (const option of themePick.options) {
      const b = el('button', 'stheme stheme-card');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', option.selected ? 'true' : 'false');
      b.setAttribute('aria-label', option.aria);
      b.id = `theme-mode-${option.id}`;
      b.dataset.mode = option.id;
      b.tabIndex = option.selected ? 0 : -1;
      // T7.2 design (ajustes-ventana-apariencia-*.png): a LIVE thumbnail per theme — the dot,
      // one ink line, one muted line and two chips drawn with that theme's palette. Sistema
      // follows the CURRENT theme tokens; Claro/Oscuro are the literal palettes of DESIGN-NOTES
      // §1, because a preview must not flip with the theme it sits in. Decorative: the words and
      // aria-labels carry the meaning.
      const thumb = el('span', 'stheme-thumb');
      thumb.setAttribute('aria-hidden', 'true');
      thumb.append(el('span', 't-dot'), el('span', 't-line t-line-1'), el('span', 't-line t-line-2'));
      const mini = el('span', 't-chips');
      mini.append(el('span'), el('span'));
      thumb.append(mini);
      b.append(thumb, el('span', 'stheme-label', option.label));
      b.addEventListener('keydown', e => {
        if (e.isTrusted !== true || !['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault();
        const all = [...picker.querySelectorAll('[role="radio"]')];
        const at = all.indexOf(b);
        let next = (at + (['ArrowRight', 'ArrowDown'].includes(e.key) ? 1 : -1) + all.length) % all.length;
        if (e.key === 'Home') next = 0;
        if (e.key === 'End') next = all.length - 1;
        all.forEach((x, i) => { x.tabIndex = i === next ? 0 : -1; });
        all[next].focus();
        chooseTheme(all[next].dataset.mode);
      });
      b.addEventListener('click', e => { if (e.isTrusted === true) chooseTheme(option.id); });
      picker.append(b);
    }
    theme.append(picker);
    if (themeError) {
      const problem = el('p', 'snote', themeError);
      problem.id = 'theme-error';
      problem.setAttribute('role', 'status');
      theme.append(problem);
    }
    // #384: the colour of the Dot. Green is the default and this choice is the ONLY input to it:
    // nothing on screen (a pose, an agent, a notice) repaints it. Sub-Abito rows appear when real
    // identities exist — the list above is the single place they will come from.
    const identities = specialistIdentities();
    const rows = V.colorRows(prefs, AVATAR ? [{ id: AVATAR.PRINCIPAL_ID, name: 'Abito' }, ...identities.identities] : [], AVATAR);
    if (rows.length) {
      const color = group('appearance', 'Color', 'Abito mantiene su color en la isla.');
      for (const row of rows) color.append(colorRow(row));
      if (identities.kind !== 'ready') {
        const notice = el('p', 'snote', identities.kind === 'loading' ? 'Leyendo los colores de tus especialistas…' : 'Colores de especialistas no disponibles: no se pudieron cargar sus identidades.');
        notice.id = 'specialist-colors-status'; notice.setAttribute('role', 'status'); color.append(notice);
      }
    }
    // #442 T7.4: Blobs = agents. Only the open tab paints (a detached paint would mount clay
    // characters nobody can see); the host node is persistent so an identical state push is a no-op.
    const pills = window.AbitoPillSettings;
    if (pills) {
      if (screen === 'pills') {
        const section = group('pills', 'Blobs', '');
        section.append(blobsHost);
        pills.render(blobsHost, { prefs, store: ownerState().store, listing: ownerState().listing }, { saving: pillSaving, error: pillError, putIcon,
          makeClay: (svg, opts) => (typeof AbitoClay !== 'undefined' ? AbitoClay.create(svg, opts) : null),
          onIntent: runIntent });
      } else if (blobsMounted) pills.dispose(blobsHost);
      blobsMounted = screen === 'pills';
    }
  }

  // ---- #442 T7.4: the closed intents of the Blobs screen, mapped onto the EXISTING closed commands ----
  // An agent is a specialist record (`specialists_action`) + its avatar colour (`prefs_action
  // set_avatar_color`) + its place on the island (`prefs_action set_island_agents`, at most three).
  // Steps run in order and stop at the first refusal: nothing is reported saved that was not.
  const blobsHost = el('div', 'blobs-host');
  let blobsMounted = false;
  // The store and the model listing have ONE owner (specialists.js): this screen reads them from
  // there and sends its commands through there, so Settings never loads a second role cache.
  const owner = () => window.AbitoSpecialistsPanel || null;
  const ownerState = () => (owner() ? owner().state() : { store: null, listing: null });
  const applyPrefs = next => { if (next && typeof next === 'object') prefs = next; };
  document.addEventListener('abito:specialists-changed', () => { if (isOpen() && screen === 'pills') render(); });
  const specRecord = id => ((ownerState().store && ownerState().store.specialists) || []).find(r => r && r.id === id) || null;
  const shownIds = () => SV.agentsView(ownerState().store, prefs, AVATAR).agents.map(a => a.id);
  const storedIds = () => ((ownerState().store && ownerState().store.specialists) || []).map(r => r.id);
  const specCall = payload => (owner() ? owner().act(payload) : Promise.reject(new Error('no specialists')));
  const prefsCall = payload => call('prefs_action', payload).then(applyPrefs);
  const setIsland = order => prefsCall({ action: 'set_island_agents', order });
  // Idempotent: with no stored island order the default projection (first three stored) can already
  // include the agent that was just created, and the backend refuses an order with a repeated id.
  const joinIsland = id => {
    const shown = shownIds();
    return shown.includes(id) || shown.length >= SV.MAX_ISLAND ? Promise.resolve() : setIsland([...shown, id]);
  };
  function createAgent(draft) {
    const id = SV.randomId();
    if (!SV.validId(id) || SV.idTaken(ownerState().store, id)) return Promise.reject(new Error('id'));
    const steps = [];
    // The catalog declaration keeps today's gates: a refused or already-declared pill is simply not toggled
    // (toggling a declared one would REMOVE it), and the agent is created either way.
    if (draft.fromCatalog && AbitoPills) {
      const cur = AbitoPills.normalize(prefs);
      if (!cur.declaredPills.includes(draft.fromCatalog) && AbitoPills.toggle(cur, draft.fromCatalog)) {
        steps.push(() => prefsCall({ action: 'toggle_declared_pill', id: draft.fromCatalog }));
      }
    }
    steps.push(() => specCall({ action: 'create', id, name: draft.name, instructions: draft.instructions, model: draft.model || null }));
    if (draft.color) steps.push(() => prefsCall({ action: 'set_avatar_color', identity: id, color: draft.color }));
    steps.push(() => joinIsland(id));
    return steps.reduce((p, step) => p.then(step), Promise.resolve());
  }
  function intentPlan(i) {
    if (!i || typeof i !== 'object') return null;
    switch (i.type) {
      case 'update_agent': {
        const r = specRecord(i.id); if (!r) return null;
        return () => specCall({ action: 'update', id: i.id, name: i.name, instructions: i.instructions, model: i.model || null,
          space: r.space, spaces: r.spaces || [], permissions: r.permissions });
      }
      case 'set_color': return () => prefsCall({ action: 'set_avatar_color', identity: i.id, color: i.color });
      case 'set_active': {
        const next = SV.islandOrderAfter(shownIds(), storedIds(), { toggle: i.id }); if (!next) return null;
        return () => setIsland(next);
      }
      case 'move': {
        const next = SV.islandOrderAfter(shownIds(), storedIds(), { move: i.id, by: i.by }); if (!next) return null;
        return () => setIsland(next);
      }
      case 'reorder': {
        const cur = shownIds();
        if (!Array.isArray(i.order) || i.order.length !== cur.length || !i.order.every(id => cur.includes(id))) return null;
        return () => setIsland(i.order);
      }
      case 'delete_agent': {
        const r = specRecord(i.id); if (!r) return null;
        // An agent that came from the catalog also leaves the declared list (same gates, same toggle),
        // otherwise it would come back as a «Guardado de antes». The remove/re-add path stays intact.
        const C = window.AbitoPillCatalog, cur = AbitoPills && AbitoPills.normalize(prefs);
        const def = C && cur ? cur.declaredPills.map(C.definition).find(d => d && d.name.toLowerCase() === r.name.toLowerCase()) : null;
        return () => specCall({ action: 'delete', id: i.id }).then(() => (def && AbitoPills.toggle(AbitoPills.normalize(prefs), def.id)
          ? prefsCall({ action: 'toggle_declared_pill', id: def.id }) : undefined));
      }
      case 'create_agent': return () => createAgent(i);
      case 'convert_saved': {
        const item = SV.savedBefore(ownerState().store, prefs, window.AbitoPillCatalog, AVATAR).find(x => x.key === i.key); if (!item) return null;
        return () => createAgent({ name: item.name, instructions: item.instructions, model: null, color: item.color });
      }
      case 'set_abito_instructions': return () => prefsCall({ action: 'set_abito_instructions', text: String(i.text) });
      case 'set_abito_model': return owner() ? () => owner().selectModel(i.profile_id) : null;
      default: return null;
    }
  }
  function runIntent(i) {
    if (pillSaving || !isOpen() || screen !== 'pills') return;
    const plan = intentPlan(i);
    if (!plan) return;
    pillSaving = true; pillError = ''; render();
    plan().then(() => {
      pillSaving = false; render();
      say(i.type === 'create_agent' || i.type === 'convert_saved' ? 'Agente creado.' : i.type === 'delete_agent' ? 'Agente eliminado.' : 'Agente guardado.');
    }, () => {
      pillSaving = false;
      pillError = i.type === 'create_agent' || i.type === 'convert_saved' ? 'No se pudo crear el agente; se mantuvo la lista anterior.' : 'No se pudo guardar el agente; se mantuvo el anterior.';
      render(); say(pillError);
    });
  }

  // #366 F094 — the quick panel: right-click on an Ajustes gear opens a small popover INSIDE the
  // island with the three most-used toggles (sound, theme, auto-close). A normal click keeps the
  // #408 behaviour untouched. Only the existing closed prefs commands are used; the saved
  // projection is the truth, a failed save keeps the previous value and says so.
  let quick = null;
  function closeQuick() { if (quick) { quick.remove(); quick = null; } }
  function quickSay(text) { say(text); }
  function renderQuick() {
    if (!quick) return;
    const v = V.quickPanelView(prefs);
    const island = V.islandInteractionView(prefs);
    quick.textContent = '';
    quick.append(el('h3', 'ssection', 'Ajustes rápidos'));
    quick.append(toggleRow('quick-sound', 'Sonido', v.sound.on, () =>
      call('prefs_action', { action: v.sound.on ? 'sound_off' : 'sound_on' }).then(
        p => { prefs = p; renderQuick(); quickSay(p.sound ? 'Sonido activado.' : 'Sonido apagado.'); },
        () => quickSay('No se pudo guardar. El sonido sigue sin cambios; probá de nuevo.'))));
    const picker = el('span', 'stheme-options');
    picker.setAttribute('role', 'radiogroup'); picker.setAttribute('aria-label', 'Tema');
    for (const option of v.theme) {
      const b = el('button', 'stheme'); b.type = 'button'; b.id = `quick-theme-${option.id}`;
      b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', option.selected ? 'true' : 'false');
      b.setAttribute('aria-label', option.aria); b.append(el('span', 'stheme-label', option.label));
      b.addEventListener('click', e => { if (e.isTrusted === true) chooseTheme(option.id).then(renderQuick); });
      picker.append(b);
    }
    quick.append(picker);
    const form = el('form', 'sname-form'); form.noValidate = true;
    const label = el('label', 'srow-title', 'Cerrar a los (segundos)'); label.htmlFor = 'quick-autoclose';
    const input = el('input', 'sfield'); input.type = 'number'; input.id = 'quick-autoclose';
    input.min = '0'; input.max = '120'; input.step = '1'; input.value = String(v.autoCloseSeconds); // 0 = «Nunca» (#438)
    const issue = el('p', 'snote'); issue.setAttribute('role', 'status');
    const save = el('button', 'sbtn primary', 'Guardar cierre'); save.type = 'submit';
    const paint = () => { const problem = V.autoCloseProblem(input.value); issue.textContent = problem; save.disabled = !!problem; };
    input.addEventListener('input', paint);
    form.addEventListener('submit', e => {
      e.preventDefault();
      if (!e.isTrusted || V.autoCloseProblem(input.value)) return;
      call('prefs_action', { action: 'set_island_interaction', auto_close_seconds: Number(input.value), open_on_hover: island.openOnHover }).then(
        p => { prefs = p; renderQuick(); quickSay('Cierre automático guardado.'); },
        () => { issue.textContent = 'No se pudo guardar. La interacción sigue sin cambios; probá de nuevo.'; });
    });
    form.append(label, input, issue, save); quick.append(form); paint();
    quick.append(wordBtn('Todos los ajustes', () => { closeQuick(); openSettingsWindow(); }));
  }
  function openQuick() {
    if (WINDOW_MODE) return;
    if (quick) { closeQuick(); return; }
    quick = el('div', 'squick'); quick.id = 'settings-quick'; quick.setAttribute('role', 'dialog'); quick.setAttribute('aria-label', 'Ajustes rápidos');
    (document.getElementById('island') || document.body).append(quick);
    renderQuick();
    call('prefs_action', { action: 'view' }).then(p => { prefs = p; renderQuick(); }, () => {});
  }
  for (const g of [...openers, $('open-settings')].filter(Boolean)) g.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (e.isTrusted === true) openQuick();
  });
  document.addEventListener('keydown', e => { if (quick && e.key === 'Escape') { e.stopPropagation(); closeQuick(); } }, true);
  document.addEventListener('pointerdown', e => { if (quick && e.isTrusted === true && !quick.contains(e.target) && !e.target.closest('#open-screen-settings, #open-settings')) closeQuick(); }, true);
  document.addEventListener('island:view', closeQuick);
  // #366 F093: inside the Rust-created settings window the SAME page opens
  // Ajustes at once — the panel IS the window (the island chrome stays hidden
  // by CSS, and the island's own phase machinery is never driven from here).
  if (WINDOW_MODE) open('general');
})();
