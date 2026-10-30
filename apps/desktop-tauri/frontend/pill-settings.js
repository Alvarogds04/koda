'use strict';
// #442 T7.4: Blobs = agents (design page «3 Blobs», DESIGN-NOTES §4/§4.1).
// Every blob is an Abito clay character (the same engine as the island, one shared loop) in one
// of the five closed-palette colours: the principal card (Abito, name fixed), up to three agent
// tiles, the editor header, the island strip and the chooser rows. An agent is a specialist
// record + its avatar colour + its place on the island (prefs.islandAgents, max three).
//
// This renderer is PURE with respect to data: it never talks to Rust. It receives
// { prefs, store, listing } and reports what the human wants as closed INTENTS through
// options.onIntent (settings.js maps them onto the existing closed commands). Plain text only
// (textContent), only trusted gestures change anything.
//
// Lifecycle: the clay characters a paint mounts are tracked per host and destroyed before the next
// paint and on dispose(), so none leaks a timer or a frame. A state push that changes nothing
// the screen shows is skipped entirely (no rebuild, no animation restart).
(function (root) {
  function paintChosenColor(node, color) {
    const stops = A?.gradientStops(color);
    if (!node?.style?.setProperty) return;
    for (let i = 0; i < 3; i++) node.style.setProperty('--chosen-' + (i + 1), stops?.[i] || '');
    node.style.setProperty('--identity-color', stops?.[1] || '');
  }
  const C = root.AbitoPillCatalog, P = root.AbitoPills, A = root.AbitoAvatarColors;
  if (!C || !P || !A) return;
  const NS = 'http://www.w3.org/2000/svg';
  const entries = new WeakMap();
  const freshUi = () => ({ key: null, mode: 'edit', preview: 'idle', createKind: 'catalog', createName: '', createColor: '',
    createWhat: '', createModel: '', catalogSearch: '', catalogCat: 'all', catalogPick: '', awaitNew: null });
  function entryOf(host) {
    let e = entries.get(host);
    if (!e) { e = { ui: freshUi(), args: null, sig: '', clays: [], drag: null }; entries.set(host, e); }
    return e;
  }
  function destroyAll(list) {
    while (list.length) { const c = list.pop(); try { if (c && typeof c.destroy === 'function') c.destroy(); } catch { /* never block a repaint */ } }
  }
  const seedOf = text => { let h = 505; for (const ch of String(text)) h = (h * 31 + ch.charCodeAt(0)) | 0; return Math.abs(h) || 505; };

  // Shared semantic input key: unrelated preferences must not restart this screen or its clay.
  // Keep this list aligned with build() and savedBefore/catalogPrefill in specialists-view.js.
  function inputKey(input) {
    const raw = input || {}, p = raw.prefs || {};
    return JSON.stringify([
      p.avatarColors, p.islandAgents, p.abitoInstructions, p.mainPill,
      p.declaredPills, p.customBlobs, p.pillColors, raw.store, raw.listing,
    ]);
  }

  function render(host, input, options) {
    const e = entryOf(host);
    e.args = [input, options || {}];
    const o = options || {};
    // Draft fields are typed in place (no rebuild per keystroke), so they stay out of the signature:
    // an identical push while the human types must not rebuild the screen under the caret.
    const sigOf = () => {
      const { createName, createColor, createWhat, createModel, catalogSearch, catalogPick, ...stable } = e.ui; // eslint-disable-line no-unused-vars
      return JSON.stringify([inputKey(input), stable, o.saving === true, o.error || '']);
    };
    if (e.sig && sigOf() === e.sig) return;
    build(host, e);
    // computed AFTER the build: it normalises the selection, and the next identical push must match
    e.sig = sigOf();
  }
  function paint(host) { const e = entries.get(host); if (!e || !e.args) return; e.sig = ''; render(host, ...e.args); }
  function dispose(host) { const e = entries.get(host); if (!e) return; destroyAll(e.clays); e.sig = ''; e.args = null; }

  function build(host, e) {
    const [input, o] = e.args;
    const V = root.AbitoSpecialists;
    destroyAll(e.clays);
    host.textContent = '';
    if (!V) return;
    const doc = host.ownerDocument || document;
    const ui = e.ui;
    const raw = input && typeof input === 'object' ? input : {};
    const prefs = raw.prefs && typeof raw.prefs === 'object' ? raw.prefs : {};
    const store = raw.store === undefined ? null : raw.store, listing = raw.listing || null;
    const put = (node, name) => (o.putIcon || (() => {}))(node, name);
    const el = (tag, cls, text) => {
      const node = doc.createElement(tag); node.className = cls || '';
      if (text) node.textContent = text;
      return node;
    };
    const trusted = fn => event => { if (event && event.isTrusted === true) fn(event); };
    const intent = payload => { if (typeof o.onIntent === 'function') o.onIntent(payload); };

    // One clay character. `scope` is the list its instance is destroyed with.
    function clay(scope, { blob, color, state, live, seed }) {
      const svg = doc.createElementNS(NS, 'svg');
      svg.setAttribute('class', 'blob-clay'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
      svg.dataset.blob = blob; svg.dataset.color = (A.PALETTE.includes(color) || A.normalizeChosenColor(color)) ? color : A.PRINCIPAL_COLOR; paintChosenColor(svg, svg.dataset.color);
      let inst = null;
      if (typeof o.makeClay === 'function') {
        inst = o.makeClay(svg, { seed: seedOf(seed || blob), state: state || 'idle', live: live !== false, viewBox: '36 32 128 128', shadow: false });
        if (inst) scope.push(inst);
      }
      return { svg, inst };
    }

    const view = V.agentsView(store, prefs, A);
    const base = V.storeView(store, listing);
    const principalColor = A.resolveColor(A.PRINCIPAL_ID, prefs.avatarColors);
    const agents = view.agents, stored = view.stored;
    const everyone = [...agents, ...stored];

    // ---- selection reconciliation ---------------------------------------------------------------
    if (ui.awaitNew) {
      const fresh = everyone.find(a => !ui.awaitNew.includes(a.id));
      if (fresh) { ui.key = fresh.id; ui.mode = 'edit'; ui.awaitNew = null; }
    }
    if (ui.mode === 'create' && (view.kind !== 'ready' || view.full)) ui.mode = 'edit';
    if (ui.mode !== 'create' && !(ui.key === 'principal' || everyone.some(a => a.id === ui.key))) {
      ui.key = agents[0] ? agents[0].id : 'principal'; ui.mode = 'edit';
    }
    if (ui.mode === 'delete' && ui.key === 'principal') ui.mode = 'edit';
    const selected = ui.key === 'principal' ? null : everyone.find(a => a.id === ui.key) || null;

    // ---- left column ------------------------------------------------------------------------------
    const left = el('div', 'pills-main');
    left.append(el('span', 'psection-label', 'Principal'));
    const card = el('button', 'blob-principal'); card.type = 'button'; card.id = 'blob-principal-card';
    card.setAttribute('aria-pressed', ui.mode !== 'create' && ui.key === 'principal' ? 'true' : 'false');
    card.setAttribute('aria-label', 'Koda: siempre en la isla');
    card.append(clay(e.clays, { blob: 'principal', color: principalColor, seed: 'abito' }).svg);
    const cardText = el('span', 'blob-principal-text');
    cardText.append(el('span', 'blob-name', 'Koda'));
    const chips = el('span', 'blob-chips');
    const rest = el('span', 'chip', 'En reposo'); rest.dataset.tone = 'go';
    chips.append(rest, el('span', 'chip', 'Siempre en la isla'));
    cardText.append(chips);
    card.append(cardText);
    const crown = el('span', 'ico ico-crown'); put(crown, 'crown'); card.append(crown);
    card.addEventListener('click', trusted(() => { ui.key = 'principal'; ui.mode = 'edit'; paint(host); }));
    left.append(card);

    const head = el('div', 'pills-declared-head');
    head.append(el('span', 'psection-label', 'Agentes'));
    const count = el('span', 'pill-count', `${view.count}/${view.max}`); count.id = 'blob-count';
    count.setAttribute('aria-label', `${view.count} de ${view.max} agentes en la isla`);
    if (view.full) count.dataset.tone = 'sun';
    head.append(count);
    left.append(head);

    const note = (text, id) => { const p = el('p', 'snote', text); if (id) p.id = id; p.setAttribute('role', 'status'); return p; };
    if (view.kind === 'loading') left.append(note('Leyendo tus agentes…'));
    else if (view.kind === 'unavailable') left.append(note(base.persistenceNote, 'blob-load-error'));
    else if (base.persistenceNote) left.append(note(base.persistenceNote));

    const grid = el('div', 'pills-grid'); grid.id = 'blob-agent-grid';
    for (const agent of agents) {
      const tile = el('button', 'blob-tile'); tile.type = 'button'; tile.dataset.agentId = agent.id; tile.dataset.color = agent.color; paintChosenColor(tile, agent.color);
      tile.id = `blob-tile-${agent.id}`;
      tile.setAttribute('aria-pressed', ui.mode !== 'create' && ui.key === agent.id ? 'true' : 'false');
      tile.setAttribute('aria-label', agent.name);
      tile.append(clay(e.clays, { blob: agent.id, color: agent.color, seed: agent.id }).svg);
      tile.append(el('span', 'blob-name', agent.name), el('span', 'blob-role', agent.role));
      const state = el('span', 'chip', agent.stateWord); state.dataset.tone = 'go'; tile.append(state);
      tile.addEventListener('click', trusted(() => { ui.key = agent.id; ui.mode = 'edit'; paint(host); }));
      // D5: drag to order — the same closed intent the arrows send.
      tile.addEventListener('pointerdown', trusted(() => { e.drag = { id: agent.id, node: tile }; tile.dataset.dragging = 'true'; }));
      tile.addEventListener('pointerup', trusted(() => {
        const d = e.drag; e.drag = null;
        if (!d) return;
        delete d.node.dataset.dragging;
        if (d.id === agent.id) return;
        const order = agents.map(a => a.id).filter(id => id !== d.id);
        order.splice(order.indexOf(agent.id), 0, d.id);
        intent({ type: 'reorder', order });
      }));
      tile.addEventListener('pointercancel', () => { if (e.drag) { delete e.drag.node.dataset.dragging; e.drag = null; } });
      grid.append(tile);
    }
    if (view.kind === 'ready' && !view.full) {
      const fresh = el('button', 'blob-tile-new'); fresh.type = 'button'; fresh.id = 'blob-tile-new';
      fresh.setAttribute('aria-pressed', ui.mode === 'create' ? 'true' : 'false');
      fresh.setAttribute('aria-label', 'Nuevo agente');
      fresh.append(el('span', 'pill-plus', '+'), el('span', 'blob-name', 'Nuevo agente'));
      fresh.addEventListener('click', trusted(() => {
        Object.assign(ui, { mode: 'create', createKind: 'catalog', createName: '', createColor: '', createWhat: '', createModel: '',
          catalogSearch: '', catalogCat: 'all', catalogPick: '' });
        paint(host);
      }));
      grid.append(fresh);
    }
    left.append(grid);

    if (stored.length) {
      const box = el('div', 'blob-stored'); box.id = 'blob-stored';
      box.append(el('span', 'psection-label', 'Guardados'));
      for (const agent of stored) {
        const row = el('div', 'blob-stored-row');
        row.append(clay(e.clays, { blob: agent.id, color: agent.color, state: 'sleeping', live: false, seed: agent.id }).svg);
        row.append(el('span', 'blob-name', agent.name));
        const on = el('button', 'sbtn', 'Activar'); on.type = 'button'; on.disabled = o.saving === true || view.full;
        on.setAttribute('aria-label', `Activar a ${agent.name} en la isla`);
        on.addEventListener('click', trusted(() => { if (!on.disabled) intent({ type: 'set_active', id: agent.id, on: true }); }));
        row.append(on); box.append(row);
      }
      left.append(box);
    }

    left.append(el('span', 'psection-label', 'Así se ve en la isla'));
    const strip = el('div', 'pill-strip'); strip.id = 'blob-island-strip';
    const stripItem = (blob, name, color) => {
      const item = el('div', 'blob-strip-item'); item.dataset.color = color; paintChosenColor(item, color);
      item.append(clay(e.clays, { blob: `strip-${blob}`, color, seed: blob }).svg, el('span', 'blob-name', name));
      strip.append(item);
    };
    stripItem('principal', 'Koda', principalColor);
    for (const agent of agents) stripItem(agent.id, agent.name, agent.color);
    left.append(strip);
    left.append(el('span', 'blob-hint', 'Arrastrá o usá las flechas para ordenar'));

    const savedRows = view.kind === 'ready' ? V.savedBefore(store, prefs, C, A) : [];
    if (savedRows.length) {
      const box = el('div', 'blob-saved'); box.id = 'blob-saved-before';
      box.append(el('span', 'psection-label', 'Guardados de antes'));
      for (const item of savedRows) {
        const row = el('div', 'blob-saved-row');
        row.append(clay(e.clays, { blob: `saved-${item.key}`, color: item.color || A.PRINCIPAL_COLOR, state: 'sleeping', live: false, seed: item.key }).svg);
        row.append(el('span', 'blob-name', item.name));
        const go = el('button', 'sbtn blob-convert', 'Convertir en agente'); go.type = 'button';
        go.disabled = o.saving === true || view.full;
        go.setAttribute('aria-label', `Convertir en agente: ${item.name}`);
        go.addEventListener('click', trusted(() => { if (!go.disabled) intent({ type: 'convert_saved', key: item.key }); }));
        row.append(go); box.append(row);
      }
      left.append(box);
    }
    const issue = el('p', 'snote', o.error || ''); issue.id = 'blob-settings-error'; issue.setAttribute('role', 'status');
    left.append(issue);

    // ---- editor panel ---------------------------------------------------------------------------------
    const editor = el('aside', 'pills-editor'); editor.id = 'blob-editor';
    const modelSelect = (id, rows, current) => {
      const select = el('select', 'sfield'); select.id = id; select.disabled = o.saving === true;
      select.setAttribute('aria-label', 'Modelo');
      for (const row of rows) {
        const option = el('option', null, row.label); option.value = row.id === null ? '' : row.id;
        if (row.id === current || (row.id === null && !current)) option.selected = true;
        select.append(option);
      }
      select.value = current || '';
      return select;
    };
    const field = (label, node) => { const wrap = el('div', 'blob-field'); wrap.append(el('span', 'srow-title', label), node); return wrap; };
    const swatchRow = (current, label, pick) => {
      const row = el('div', 'swatch-row'); row.setAttribute('role', 'radiogroup'); row.setAttribute('aria-label', label);
      // R3-keyboard-swatch-entry: roving tabindex with an entry point — with no colour yet the FIRST
      // swatch keeps tabindex 0 so the radiogroup is reachable by Tab; a selection moves the entry point.
      const set = color => { const kids = [...row.children]; const entry = color || (kids[0] ? kids[0].dataset.color : '');
        for (const b of kids) { const on = A.normalizeChosenColor(b.dataset.color) === A.normalizeChosenColor(color); b.setAttribute('aria-checked', on ? 'true' : 'false'); b.tabIndex = A.normalizeChosenColor(b.dataset.color) === A.normalizeChosenColor(entry) ? 0 : -1; } };
      for (const color of A.PALETTE) {
        const b = el('button', 'swatch'); b.type = 'button'; b.dataset.color = color; paintChosenColor(b, color); b.setAttribute('role', 'radio');
        b.setAttribute('aria-label', A.label(color)); b.disabled = o.saving === true;
        b.append(clay(e.clays, { blob: `swatch-${color}`, color, live: false, seed: color }).svg);
        b.addEventListener('click', trusted(() => { if (!b.disabled && color !== row.current) pick(color); }));
        b.addEventListener('keydown', trusted(event => {
          if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const buttons = [...row.children]; const at = buttons.indexOf(b);
          let next = at + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1);
          if (event.key === 'Home') next = 0; else if (event.key === 'End') next = buttons.length - 1;
          next = (next + buttons.length) % buttons.length;
          buttons[next].focus(); pick(buttons[next].dataset.color);
        }));
        row.append(b);
      }
      row.current = current; row.setCurrent = color => { row.current = color; set(color); };
      set(current);
      return row;
    };
    // the header: character 72 + name + «Animado como Abito» + the Reposo | Trabaja preview
    const header = (title, color, blob) => {
      const bar = el('div', 'blob-editor-head');
      const made = clay(e.clays, { blob, color, state: ui.preview === 'working' ? 'working' : 'idle', seed: blob });
      bar.append(made.svg);
      const text = el('div', 'blob-editor-title');
      text.append(el('span', 'blob-name', title));
      const anim = el('span', 'chip', 'Animado como Koda'); anim.dataset.tone = 'live'; text.append(anim);
      const seg = el('div', 'segmented'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'Vista previa');
      const rest = el('button', 'seg', 'Reposo'); rest.type = 'button'; rest.id = 'blob-preview-rest';
      const work = el('button', 'seg', 'Trabaja'); work.type = 'button'; work.id = 'blob-preview-work';
      const sync = () => { rest.setAttribute('aria-pressed', ui.preview === 'working' ? 'false' : 'true'); work.setAttribute('aria-pressed', ui.preview === 'working' ? 'true' : 'false'); };
      const go = state => trusted(() => { ui.preview = state === 'working' ? 'working' : 'idle'; sync(); if (made.inst && typeof made.inst.setState === 'function') made.inst.setState(state); });
      rest.addEventListener('click', go('idle')); work.addEventListener('click', go('working'));
      sync(); seg.append(rest, work); text.append(seg); bar.append(text);
      return bar;
    };

    if (ui.mode === 'create') {
      const segKind = el('div', 'segmented'); segKind.setAttribute('role', 'group'); segKind.setAttribute('aria-label', 'Tipo de agente');
      const catSeg = el('button', 'seg', 'Del catálogo'); catSeg.type = 'button'; catSeg.id = 'create-kind-catalog';
      catSeg.setAttribute('aria-pressed', ui.createKind !== 'custom' ? 'true' : 'false');
      catSeg.addEventListener('click', trusted(() => { if (ui.createKind !== 'catalog') { ui.createKind = 'catalog'; paint(host); } }));
      const ownSeg = el('button', 'seg', 'Propio'); ownSeg.type = 'button'; ownSeg.id = 'create-kind-custom';
      ownSeg.setAttribute('aria-pressed', ui.createKind === 'custom' ? 'true' : 'false');
      ownSeg.addEventListener('click', trusted(() => { if (ui.createKind !== 'custom') { ui.createKind = 'custom'; paint(host); } }));
      segKind.append(catSeg, ownSeg); editor.append(segKind);
      const close = () => { ui.mode = 'edit'; ui.catalogPick = ''; ui.catalogSearch = ''; ui.catalogCat = 'all'; paint(host); };

      if (ui.createKind !== 'custom') {
        // §4.1 Mode A: the offered catalog; «Agregar» declares through today's gates and creates the prefilled agent.
        const search = el('input', 'sfield'); search.id = 'pill-catalog-search'; search.placeholder = 'Buscar…';
        search.setAttribute('aria-label', 'Buscar en el catálogo'); search.value = ui.catalogSearch;
        const cats = el('div', 'pill-catalog-cats');
        const catLabels = { workspace: 'Dónde programás', agent: 'Agentes', ai: 'IA', service: 'Servicios' };
        for (const cat of [{ id: 'all', name: 'Todos' }, ...C.CATEGORIES]) {
          const chip = el('button', 'pill-catalog-cat', cat.id === 'all' ? cat.name : catLabels[cat.id] || cat.name); chip.type = 'button';
          chip.dataset.cat = cat.id; chip.setAttribute('aria-pressed', ui.catalogCat === cat.id ? 'true' : 'false');
          chip.addEventListener('click', trusted(() => { if (ui.catalogCat !== cat.id) { ui.catalogCat = cat.id; paint(host); } }));
          cats.append(chip);
        }
        const list = el('div', 'pill-catalog-list'); list.id = 'pill-catalog-list';
        const add = el('button', 'sbtn primary', 'Agregar'); add.type = 'button'; add.id = 'pill-catalog-add';
        const cancel = el('button', 'sbtn', 'Cancelar'); cancel.type = 'button'; cancel.id = 'pill-catalog-cancel';
        const listClays = [];
        e.clays.push({ destroy: () => destroyAll(listClays) });
        const have = new Set(everyone.map(a => a.name.toLowerCase()));
        const fill = () => {
          destroyAll(listClays);
          add.disabled = o.saving === true || !ui.catalogPick;
          const q = ui.catalogSearch.trim().toLowerCase();
          // abito-pausa 0.1.2: paused services are hidden from the chooser (listing only; stored declarations and offered() are untouched)
          const P = window.AbitoPaused, pausedPill = id => !!P && ((id === 'integration_spotify' && P.paused('spotify')) || (/^integration_/.test(id) && id !== 'integration_claude' && id !== 'integration_spotify' && C.definition(id)?.category === 'service' && P.paused('integrations')));
          const defs = C.available().filter(d => !pausedPill(d.id) && (ui.catalogCat === 'all' || d.category === ui.catalogCat) && (!q || d.name.toLowerCase().includes(q)));
          list.textContent = '';
          if (!defs.length) { list.append(el('span', 'pill-catalog-empty', 'Sin resultados')); return; }
          for (const d of defs) {
            const isMain = d.id === prefs.mainPill, isThere = have.has(d.name.toLowerCase());
            const row = el(isMain || isThere ? 'div' : 'button', 'pill-catalog-row'); row.dataset.pillId = d.id;
            if (!isMain && !isThere) {
              row.type = 'button'; row.id = `pill-catalog-row-${d.id}`;
              row.setAttribute('aria-pressed', ui.catalogPick === d.id ? 'true' : 'false');
              row.addEventListener('click', trusted(() => { ui.catalogPick = d.id; fill(); }));
              if (ui.catalogPick === d.id) { const ico = el('span', 'ico'); put(ico, 'check'); row.append(ico); }
            }
            const pre = V.catalogPrefill(C, d.id, prefs, A);
            row.append(clay(listClays, { blob: `catalog-${d.id}`, color: pre ? pre.color : A.PRINCIPAL_COLOR, live: false, seed: d.id }).svg);
            row.append(el('span', 'pill-catalog-name', d.name));
            if (isMain) row.append(el('span', 'chip', 'Principal')); else if (isThere) row.append(el('span', 'chip', 'Ya está'));
            list.append(row);
          }
        };
        search.addEventListener('input', trusted(() => { ui.catalogSearch = search.value; fill(); }));
        add.addEventListener('click', trusted(() => {
          if (add.disabled) return;
          const pre = V.catalogPrefill(C, ui.catalogPick, prefs, A);
          if (!pre) return;
          ui.awaitNew = everyone.map(a => a.id); ui.mode = 'edit'; ui.catalogPick = ''; ui.catalogSearch = ''; ui.catalogCat = 'all';
          intent({ type: 'create_agent', fromCatalog: pre.id, name: pre.name, color: pre.color, instructions: pre.instructions, model: null });
          paint(host);
        }));
        cancel.addEventListener('click', trusted(close));
        editor.append(search, cats, list, el('span', 'pill-catalog-note', 'Trae nombre, color y qué hace; editables después. No conecta la cuenta.'));
        const actions = el('div', 'editor-actions'); actions.append(add, cancel); editor.append(actions);
        fill();
      } else {
        // §4.1 Mode B: Propio — Crear stays disabled until name + colour.
        const color = ui.createColor || A.PRINCIPAL_COLOR;
        const preview = clay(e.clays, { blob: 'create', color, seed: 'create' });
        preview.svg.setAttribute('class', 'blob-clay blob-clay-preview'); editor.append(preview.svg);
        const name = el('input', 'sfield'); name.id = 'blob-create-input'; name.placeholder = 'Nombre'; name.maxLength = V.MAX_NAME;
        name.setAttribute('aria-label', 'Nombre del nuevo agente'); name.disabled = o.saving === true; name.value = ui.createName;
        const what = el('textarea', 'sfield'); what.id = 'blob-create-what'; what.rows = 3; what.maxLength = V.MAX_INSTRUCTIONS;
        what.placeholder = 'Ej.: pone música según lo que estés haciendo'; what.setAttribute('aria-label', 'Qué hace'); what.value = ui.createWhat;
        what.disabled = o.saving === true;
        const model = modelSelect('blob-create-model', V.modelOptions(listing, ui.createModel || null), ui.createModel || null);
        const create = el('button', 'sbtn primary', 'Crear'); create.type = 'button'; create.id = 'blob-create-button';
        const paintCreate = () => { create.disabled = o.saving === true || !ui.createName.trim() || !ui.createColor; };
        const row = swatchRow(ui.createColor, 'Color del nuevo agente', picked => {
          ui.createColor = picked; row.setCurrent(picked); preview.svg.dataset.color = picked; paintChosenColor(preview.svg, picked); paintCreate();
        });
        name.addEventListener('input', trusted(() => { ui.createName = name.value; paintCreate(); }));
        what.addEventListener('input', trusted(() => { ui.createWhat = what.value; }));
        model.addEventListener('change', trusted(() => { ui.createModel = model.value; }));
        const cancel = el('button', 'sbtn', 'Cancelar'); cancel.type = 'button'; cancel.id = 'blob-create-cancel';
        cancel.addEventListener('click', trusted(() => { Object.assign(ui, { mode: 'edit', createName: '', createColor: '', createWhat: '', createModel: '' }); paint(host); }));
        create.addEventListener('click', trusted(() => {
          if (create.disabled) return;
          const nm = ui.createName.trim();
          ui.awaitNew = everyone.map(a => a.id);
          const payload = { type: 'create_agent', name: nm, instructions: ui.createWhat.trim() || `Ayuda con ${nm}.`, model: ui.createModel || null, color: ui.createColor };
          Object.assign(ui, { mode: 'edit', createName: '', createColor: '', createWhat: '', createModel: '' });
          intent(payload); paint(host);
        }));
        paintCreate();
        editor.append(field('Nombre', name), field('Color', row), field('Qué hace', what), field('Modelo', model));
        const actions = el('div', 'editor-actions'); actions.append(create, cancel); editor.append(actions);
      }
    } else if (ui.mode === 'delete' && selected) {
      editor.className += ' blob-editor-danger';
      editor.append(clay(e.clays, { blob: 'editor', color: selected.color, seed: selected.id }).svg);
      editor.append(el('strong', 'pill-editor-question', `¿Eliminar «${selected.name}»?`));
      editor.append(el('span', 'pill-editor-detail', 'Se quita de la isla y deja de trabajar.'));
      const confirm = el('button', 'sbtn danger', 'Eliminar'); confirm.type = 'button'; confirm.id = 'blob-delete-confirm';
      confirm.disabled = o.saving === true; confirm.setAttribute('aria-label', `Eliminar: ${selected.name}`);
      confirm.addEventListener('click', trusted(() => { if (confirm.disabled) return; ui.mode = 'edit'; intent({ type: 'delete_agent', id: selected.id }); paint(host); }));
      const cancel = el('button', 'sbtn', 'Cancelar'); cancel.type = 'button'; cancel.id = 'blob-delete-cancel';
      cancel.addEventListener('click', trusted(() => { ui.mode = 'edit'; paint(host); }));
      const actions = el('div', 'editor-actions'); actions.append(confirm, cancel); editor.append(actions);
    } else if (ui.key === 'principal') {
      // Abito: name fixed, colour (D4: it changes the island character), «Qué hace» (declarative), model.
      editor.append(header('Koda', principalColor, 'editor'));
      const name = el('input', 'sfield'); name.id = 'blob-editor-name'; name.value = 'Koda'; name.disabled = true; name.setAttribute('aria-label', 'Nombre');
      const fixed = el('span', 'chip', 'Fijo'); const nameWrap = field('Nombre', name); nameWrap.append(fixed);
      editor.append(nameWrap);
      editor.append(field('Color', swatchRow(principalColor, 'Color de Koda', color => intent({ type: 'set_color', id: A.PRINCIPAL_ID, color }))));
      const what = el('textarea', 'sfield'); what.id = 'blob-editor-what'; what.rows = 3; what.maxLength = V.MAX_INSTRUCTIONS;
      what.value = typeof prefs.abitoInstructions === 'string' ? prefs.abitoInstructions : ''; what.disabled = o.saving === true;
      what.setAttribute('aria-label', 'Qué hace');
      what.addEventListener('change', trusted(() => intent({ type: 'set_abito_instructions', text: what.value })));
      const whatWrap = field('Qué hace', what);
      const declarative = el('span', 'chip', 'Declarativo: todavía no se aplica'); declarative.id = 'blob-declarativo'; whatWrap.append(declarative);
      editor.append(whatWrap);
      const rows = V.modelOptions(listing, listing && listing.selected).filter(r => r.id !== null);
      const model = modelSelect('blob-editor-model', rows, listing && listing.selected);
      model.addEventListener('change', trusted(() => { if (model.value) intent({ type: 'set_abito_model', profile_id: model.value }); }));
      editor.append(field('Modelo', model));
    } else if (selected) {
      editor.append(header(selected.name, selected.color, 'editor'));
      const name = el('input', 'sfield'); name.id = 'blob-editor-name'; name.value = selected.name; name.maxLength = V.MAX_NAME;
      name.disabled = o.saving === true; name.setAttribute('aria-label', 'Nombre');
      const what = el('textarea', 'sfield'); what.id = 'blob-editor-what'; what.rows = 3; what.maxLength = V.MAX_INSTRUCTIONS;
      what.value = selected.instructions; what.disabled = o.saving === true; what.setAttribute('aria-label', 'Qué hace');
      const model = modelSelect('blob-editor-model', V.modelOptions(listing, selected.model), selected.model);
      const update = patch => intent({ type: 'update_agent', id: selected.id, name: selected.name, instructions: selected.instructions, model: selected.model, ...patch });
      name.addEventListener('change', trusted(() => {
        const v = name.value.trim();
        if (!v) { name.value = selected.name; return; }
        if (v !== selected.name) update({ name: v });
      }));
      what.addEventListener('change', trusted(() => {
        const v = what.value.trim();
        if (!v) { what.value = selected.instructions; return; }
        if (v !== selected.instructions) update({ instructions: v });
      }));
      model.addEventListener('change', trusted(() => { const v = model.value || null; if (v !== selected.model) update({ model: v }); }));
      editor.append(field('Nombre', name));
      editor.append(field('Color', swatchRow(selected.color, `Color de ${selected.name}`, color => intent({ type: 'set_color', id: selected.id, color }))));
      editor.append(field('Qué hace', what), field('Modelo', model));
      const active = el('button', 'blob-toggle'); active.type = 'button'; active.id = 'blob-editor-active'; active.setAttribute('role', 'switch');
      active.setAttribute('aria-checked', selected.active ? 'true' : 'false'); active.setAttribute('aria-label', 'Activo');
      active.disabled = o.saving === true || (!selected.active && view.full);
      active.append(el('span', 'srow-title', 'Activo'), el('span', 'blob-switch'));
      active.addEventListener('click', trusted(() => { if (!active.disabled) intent({ type: 'set_active', id: selected.id, on: !selected.active }); }));
      editor.append(active);
      const actions = el('div', 'editor-actions');
      const at = agents.findIndex(a => a.id === selected.id);
      const move = (id, label, icon, by, disabled) => {
        const b = el('button', 'sbtn'); b.type = 'button'; b.id = id; b.disabled = o.saving === true || disabled;
        b.setAttribute('aria-label', label); const ico = el('span', 'ico'); put(ico, icon); b.append(ico);
        b.addEventListener('click', trusted(() => { if (!b.disabled) intent({ type: 'move', id: selected.id, by }); }));
        return b;
      };
      actions.append(move('blob-editor-left', `Mover ${selected.name} antes`, 'arrow-left', -1, at <= 0),
        move('blob-editor-right', `Mover ${selected.name} después`, 'arrow-right', 1, at < 0 || at >= agents.length - 1));
      const remove = el('button', 'sbtn danger'); remove.type = 'button'; remove.id = 'blob-editor-delete'; remove.disabled = o.saving === true;
      remove.setAttribute('aria-label', `Eliminar: ${selected.name}`);
      const trash = el('span', 'ico'); put(trash, 'cross'); remove.append(trash, el('span', 'btn-word', 'Eliminar'));
      remove.addEventListener('click', trusted(() => { ui.mode = 'delete'; paint(host); }));
      actions.append(remove); editor.append(actions);
    }

    const layout = el('div', 'pills-layout'); layout.append(left, editor);
    host.append(layout);
  }

  root.AbitoPillSettings = Object.freeze({ render, dispose, inputKey });
})(typeof window !== 'undefined' ? window : this);
