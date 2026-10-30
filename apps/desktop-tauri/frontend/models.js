'use strict';
/* U2 — the self-hosted model picker, an internal panel of the chat view
   (same island). Talks to Rust only through `models_action` with the closed
   set list/refresh/select{profile_id}: it can never add an endpoint, enter
   a key or name a remote model. Selecting is explicit (a click on a
   registered, selectable profile) and applies from the next message.
   Plain text only (textContent). Silence. */
(() => {
  const V = window.AbitoChatView;
  const $ = id => document.getElementById(id);
  const panel = $('models');
  const list = $('models-list');
  const note = $('models-note');
  const noteButton = $('models-info');
  const meters = $('models-meters');
  const countWord = $('models-count-word');
  const countChip = $('models-count');
  const resources = $('models-resources');
  const refreshButton = $('models-refresh');
  const live = $('chat-live');
  if (!V || !panel) return;
  const ICONS = window.AbitoIcons;
  const icon = name => (ICONS ? ICONS.svg(name) : '');
  // Icons are built as DOM nodes from the CLOSED own registry (an unknown name yields nothing):
  // no markup is ever written with innerHTML, so no data can ever become markup (#414 follow-up
  // of the same rule settings.js applies).
  const parser = new DOMParser();
  function putIcon(host, name) {
    host.textContent = '';
    const markup = name ? icon(name) : null;
    if (!markup) return;
    const doc = parser.parseFromString(markup, 'image/svg+xml');
    if (doc.documentElement && doc.documentElement.nodeName === 'svg') {
      host.append(document.importNode(doc.documentElement, true));
    }
  }
  // Static own icons (closed registry, never data).
  for (const el of panel.querySelectorAll('[data-icon]')) putIcon(el, el.dataset.icon);
  const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)
    || (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) || null;
  const listen = (window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen) || null;
  const action = payload => (invoke ? invoke('models_action', { payload }) : Promise.reject(new Error('no ipc')));

  let listing = null;
  let busy = false;

  // ---- #414: Ajustes → Modelos, the provider groups ------------------------------------------------
  // The tab now leads with the CONNECTED providers' models (the human's words: "acá directamente
  // lo de los proveedores"). The engine reports the catalogue (`models_list` → the folded `models`
  // frame in the agent view); the typed pref `chosen_models` holds what the human marked. The
  // pure view-model lives in settings-view.js (AbitoSettings, loaded after this file — read lazily);
  // this only shapes rows the panel can render, in text the page owns. Plain textContent only.
  let agentState = null;      // `agent_action view` + `agent:state`
  let prefsView = null;       // `prefs_action view` + `prefs:state`
  let provSection = null;
  let localLabel = null;
  const agent = payload => (invoke ? invoke('agent_action', { payload }) : Promise.reject(new Error('no ipc')));
  const prefsAction = payload => (invoke ? invoke('prefs_action', { payload }) : Promise.reject(new Error('no ipc')));
  const currentChosen = () => (prefsView && prefsView.chosenModels && typeof prefsView.chosenModels === 'object'
    && !Array.isArray(prefsView.chosenModels) ? prefsView.chosenModels : {});
  function askProviders() {
    agent({ action: 'view' }).then(v => {
      if (v && typeof v === 'object') { agentState = v; renderProviders(); }
    }, () => {});
    // the chosen ones come from the typed pref: one read-only view, then the stream keeps it current
    prefsAction({ action: 'view' }).then(p => {
      if (p && typeof p === 'object') { prefsView = p; renderProviders(); }
    }, () => {});
    // one metadata ask per open: cheap, and it re-reads the catalogue after a daemon
    // restart or a fresh login so the groups never show a stale provider set
    agent({ action: 'models_list' }).catch(() => {});
  }
  function toggleModel(providerId, modelId) {
    const S = window.AbitoSettings;
    if (!S) return;
    const next = S.chosenToggle(currentChosen(), providerId, modelId);
    prefsAction(S.chosenModelsPayload(next, providerId)).then(p => {
      if (p && typeof p === 'object') prefsView = p;
      renderProviders();
    }, () => { renderProviders(); say('No se pudo guardar la elección; se mantuvo la anterior.'); });
  }
  function renderProviders() {
    const S = window.AbitoSettings;
    if (!S || !panel || !list) return;
    if (!provSection) {
      provSection = el('section', 'models-prov');
      provSection.id = 'models-providers';
      panel.insertBefore(provSection, list); // leads the tab, above the local picker
    }
    provSection.replaceChildren();
    provSection.append(el('h3', 'models-prov-title', 'Cuentas conectadas'));
    const view = S.modelsTabView(agentState, currentChosen());
    if (view.kind !== 'ready') {
      provSection.append(chipNode({ icon: view.icon, text: view.word, label: view.word || view.aria }));
      return;
    }
    // T7.2 design (ajustes-ventana-modelos-*.png): ONE flat list of radio rows — the model name,
    // its provider chip and the capability chips the engine frame already carries. A provider
    // the engine does not name as connected draws nothing (no row, no hint — the design wins).
    const ul = el('ul', 'models-prov-models');
    ul.setAttribute('aria-label', 'Modelos de tus cuentas conectadas');
    for (const g of view.groups) {
      if (!g.connected) continue;
      for (const m of g.models) {
        const li = el('li', 'models-prov-model');
        const b = el('button', 'choose');
        b.type = 'button';
        b.setAttribute('aria-pressed', m.chosen ? 'true' : 'false');
        b.setAttribute('aria-label', `${m.chosen ? 'Elegido' : 'Elegir'} ${m.name} de ${g.name}`);
        if (m.chosen) putIcon(b, 'check');
        b.addEventListener('click', () => toggleModel(g.id, m.id));
        li.append(b);
        const titles = el('span', 'model-titles');
        titles.append(el('span', 'model-title', m.name));
        if (m.sub) titles.append(el('span', 'model-sub', m.sub));
        li.append(titles);
        const prov = chipNode({ icon: '', text: g.name, label: `${m.name} de ${g.name}` });
        prov.className = 'chip models-prov-chip';
        li.append(prov);
        const caps = el('span', 'model-chips');
        for (const c of capabilityChips(m)) caps.append(chipNode(c));
        li.append(caps);
        ul.append(li);
      }
    }
    provSection.append(ul);
    // T7.2: the local picker keeps its «Locales» group label (design section LOCALES).
    if (!localLabel) {
      localLabel = el('h3', 'models-local-label', 'Locales');
      panel.insertBefore(localLabel, list);
    }
  }

  // Capability chips read ONLY the closed fields the engine frame already carries
  // (agentclient `models` fold: reasoning, contextWindow). Nothing is invented: an
  // absent/zero context and a false reasoning draw no chip. No new wire fields.
  const capWindow = n => !Number.isFinite(n) || n <= 0 ? null
    : n >= 1e6 ? `${+(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : `${Math.round(n / 1e3)}k`;
  function capabilityChips(m) {
    const chips = [];
    const w = capWindow(m.contextWindow);
    if (w) chips.push({ icon: '', text: w, label: `Contexto ${w}` });
    if (m.reasoning === true) chips.push({ icon: '', text: 'Razonamiento', label: 'Razona paso a paso' });
    return chips;
  }

  function say(text) { if (text) { live.textContent = ''; requestAnimationFrame(() => { live.textContent = text; }); } }

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  function chipNode(c) {
    const chip = el('span', 'chip');
    chip.setAttribute('role', 'img');
    chip.setAttribute('aria-label', c.label);
    if (c.icon) { const i = el('span', 'ico'); putIcon(i, c.icon); chip.append(i); }
    if (c.text) chip.append(el('span', 'word', c.text));
    return chip;
  }

  function render() {
    list.textContent = '';
    list.setAttribute('aria-busy', listing ? 'false' : 'true');
    const count = V.modelsCount(listing);
    countWord.textContent = listing ? String(count) : '';
    countChip.setAttribute('aria-label', listing ? `${count} modelo${count === 1 ? '' : 's'} local${count === 1 ? '' : 'es'} verificado${count === 1 ? '' : 's'}` : 'Leyendo modelos locales');
    note.textContent = V.modelsInfo(listing);
    resources.textContent = listing && listing.resources_text ? `Recursos: ${listing.resources_text}` : '';
    meters.textContent = '';
    for (const m of V.modelMeters(listing)) {
      const li = el('li', 'meter');
      li.dataset.key = m.key;
      li.dataset.known = m.known ? 'true' : 'false';
      li.setAttribute('role', 'img');
      li.setAttribute('aria-label', m.aria);
      li.append(el('span', 'meter-label', m.label));
      const bar = el('span', 'meter-bar');
      if (ICONS) putIcon(bar, ICONS.meter(m.fraction));
      li.append(bar);
      meters.append(li);
    }
    if (!listing) { // skeleton: two rows, shape only (still under reduced motion)
      for (let n = 0; n < 2; n++) { const li = el('li', 'skeleton'); li.setAttribute('aria-hidden', 'true'); list.append(li); }
    }
    for (const row of V.modelRows(listing)) {
      const li = el('li', row.selectable ? '' : 'disabled');
      li.setAttribute('aria-label', row.aria);
      li.append(el('span', 'model-title', row.title));
      const chips = el('span', 'model-chips');
      for (const c of row.chips) chips.append(chipNode(c));
      li.append(chips);
      if (row.word) {
        const state = el('span', 'chip model-word');
        state.dataset.tone = row.tone;
        const i = el('span', 'ico'); putIcon(i, row.wordIcon);
        state.append(i, el('span', 'word', row.word));
        li.append(state);
      } else {
        const ok = el('span', 'model-ok'); // «ready»: filled dot, shape = filled circle
        ok.setAttribute('aria-hidden', 'true');
        li.append(ok);
      }
      const choose = el('button', 'choose');
      choose.type = 'button';
      if (row.selected) putIcon(choose, 'check');
      choose.setAttribute('aria-pressed', row.selected ? 'true' : 'false');
      choose.setAttribute('aria-label', `${row.selected ? 'Elegido' : 'Elegir'} ${row.title}`);
      choose.disabled = !row.selectable || row.selected || busy;
      if (row.selectable && !row.selected) {
        choose.addEventListener('click', () => select(row.id, row.title));
      }
      li.append(choose);
      list.appendChild(li);
    }
    refreshButton.disabled = busy;
    refreshButton.dataset.kind = busy ? 'busy' : '';
  }

  function apply(next) { if (next && typeof next === 'object') { listing = next; render(); } }

  function refresh() {
    busy = true; render();
    action({ action: 'refresh' }).then(next => { busy = false; apply(next); say('Modelos locales actualizados.'); },
      () => { busy = false; render(); });
  }
  function select(id, title) {
    busy = true; render();
    action({ action: 'select', profile_id: id }).then(
      next => { busy = false; apply(next); say(`${title} elegido. Se usa desde el próximo mensaje.`); },
      error => { busy = false; render(); say((error && error.message) || 'No se pudo elegir.'); });
  }
  function setInfo(open) {
    noteButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    note.classList.toggle('sr-only', !open);
  }
  noteButton.addEventListener('click', () => setInfo(noteButton.getAttribute('aria-expanded') !== 'true'));
  // #408: the picker is the «Modelos» sub-tab of Ajustes; settings.js announces the active tab.
  function open() {
    panel.inert = false;
    panel.dataset.open = 'true';
    setInfo(false);
    refresh(); // metadata only, never inference
    askProviders(); // #414: the provider groups and their catalogue, from the same engine
  }
  function close() {
    panel.inert = true;
    delete panel.dataset.open;
    setInfo(false);
  }
  document.addEventListener('abito:settings-tab', e => (e.detail === 'models' ? open() : close()));
  refreshButton.addEventListener('click', refresh);
  document.addEventListener('island:view', e => { if (e.detail !== 'chat') close(); });
  if (listen) {
    listen('models:state', ev => apply(ev && ev.payload)).catch(() => {});
    // #414: the provider groups render from the streams — the agent view (providers, folded
    // models) and the typed prefs (the chosen ones) — so a login or a toggle in another
    // tab reaches this panel without a new command.
    listen('agent:state', ev => {
      if (ev && ev.payload && typeof ev.payload === 'object') { agentState = ev.payload; renderProviders(); }
    }).catch(() => {});
    listen('prefs:state', ev => {
      if (ev && ev.payload && typeof ev.payload === 'object') { prefsView = ev.payload; renderProviders(); }
    }).catch(() => {});
  }
  action({ action: 'list' }).then(apply, () => {});
})();
