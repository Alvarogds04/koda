'use strict';
/* #327 — the specialists section of Ajustes and the chat's role chip (DOM only).
   The human creates a role by hand (name, specialty, and optionally which verified LOCAL model it
   uses), chooses it explicitly and can go back to Abito, the principal. Nothing here delegates,
   spawns or widens anything; the section talks to Rust ONLY through the closed `specialists_action`
   command set and reads the model catalogue through the existing `models_action`.
   - Plain text only (textContent): no innerHTML, so no data can ever become markup;
   - only trusted gestures (event.isTrusted) change anything;
   - the avatar contract (#384) resolves indicator colours for the SAME stable id.
   Silence. Same island, same motion. */
(() => {
  const V = window.AbitoSpecialists;      // the pure view-model (specialists-view.js)
  const ICONS = window.AbitoIcons;
  const $ = id => document.getElementById(id);
  if (!V || !ICONS) return;
  const parser = new DOMParser();
  const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)
    || (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) || null;
  const listen = (window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen) || null;
  const call = (cmd, payload) => (invoke ? invoke(cmd, { payload }) : Promise.reject(new Error('no ipc')));

  let store = null;        // `specialists:state` from Rust, or null while it is on its way
  let listing = null;      // the model listing (metadata only: the picker already reads it)
  let busy = false;        // a select/delete is in flight
  function paintChosenColor(node, color) {
    const stops = AVATAR?.gradientStops(color);
    if (!node?.style?.setProperty) return;
    for (let i = 0; i < 3; i++) node.style.setProperty('--chosen-' + (i + 1), stops?.[i] || '');
    node.style.setProperty('--identity-color', stops?.[1] || '');
  }
  const AVATAR = window.AbitoAvatarColors;
  let avatarColors = {};
  const identityView = () => V.identityView(store);
  const notifyIdentities = () => document.dispatchEvent(new Event('abito:specialist-identities'));
  function applyPrefs(next) {
    if (!next || typeof next !== 'object') return;
    avatarColors = AVATAR ? AVATAR.sanitizeOverrides(next.avatarColors) : {};
    renderSection(); renderChip();
  }
  function indicatorColor(node, id) {
    if (node && AVATAR) { node.dataset.color = AVATAR.resolveColor(id, avatarColors); paintChosenColor(node, node.dataset.color); }
  }
  const form = V.makeForm(); // ALL form logic lives in the view-model; this page only paints it

  const say = text => {
    const live = $('settings-live');
    if (!live || !text) return;
    live.textContent = '';
    requestAnimationFrame(() => { live.textContent = text; });
  };
  const word = text => { const s = document.createElement('span'); s.className = 'word'; s.textContent = text; return s; };
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };
  function putIcon(host, name) {
    host.textContent = '';
    const markup = ICONS.svg(name);
    if (!markup) return;
    const doc = parser.parseFromString(markup, 'image/svg+xml');
    if (doc.documentElement && doc.documentElement.nodeName === 'svg') host.append(document.importNode(doc.documentElement, true));
  }
  function wordBtn(text, onClick, opts) {
    const o = opts || {};
    const b = el('button', 'sbtn' + (o.primary ? ' primary' : ''));
    b.type = 'button';
    if (o.icon) { const i = el('span', 'ico'); putIcon(i, o.icon); b.append(i); }
    b.append(word(text));
    if (o.aria) b.setAttribute('aria-label', o.aria);
    b.disabled = busy || store?.load_error === true || !!o.disabled;
    b.addEventListener('click', e => { if (e.isTrusted === true) onClick(); });
    return b;
  }

  const selectableIds = () => ((listing && listing.profiles) || []).filter(p => p && p.selectable === true && typeof p.profile_id === 'string').map(p => p.profile_id);

  // #436 D8: the card's colour is the SAME human choice the Apariencia tab edits — the palette
  // and the resolution come from the one contract (#384) for the SAME stable id, and the write
  // goes through the existing preferences command. A failed save keeps the previous colour and
  // says so; the selected choice never rides on colour alone (aria-pressed + a visible word).
  function colorChoices(id, name) {
    if (!AVATAR || !Array.isArray(AVATAR.PALETTE)) return null;
    const current = AVATAR.resolveColor(id, avatarColors);
    const group = el('span', 'srole-colors');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', `Color de ${name}`);
    for (const color of AVATAR.PALETTE) {
      const b = el('button', 'sdot sm');
      b.type = 'button';
      b.dataset.color = color; paintChosenColor(b, color);
      b.title = AVATAR.label(color);
      b.setAttribute('aria-label', `${AVATAR.label(color)} para ${name}`);
      b.setAttribute('aria-pressed', AVATAR.normalizeChosenColor(color) === AVATAR.normalizeChosenColor(current) ? 'true' : 'false');
      b.disabled = busy || store?.load_error === true;
      b.append(el('span', 'sdot-swatch'));
      b.addEventListener('click', e => { if (e.isTrusted === true) chooseCardColor(id, color); });
      group.append(b);
    }
    // the current colour repeated as a word: the meaning never rides on colour alone (C5)
    group.append(el('span', 'srole-color-word', AVATAR.label(current)));
    return group;
  }
  function chooseCardColor(id, color) {
    call('prefs_action', { action: 'set_avatar_color', identity: id, color }).then(
      p => { applyPrefs(p); say('Color guardado.'); },
      () => say('No se pudo guardar el color; se mantuvo el anterior.'));
  }

  // ---- IPC -------------------------------------------------------------------------------------------
  const notifyChanged = () => document.dispatchEvent(new Event('abito:specialists-changed'));
  function apply(next) { if (next && typeof next === 'object') { store = next; renderSection(); renderChip(); notifyIdentities(); notifyChanged(); } }
  // select / delete: no form involved.
  function send(payload, okSay, focusId) {
    if (busy || store?.load_error === true) return;
    busy = true; renderSection();
    call('specialists_action', payload).then(next => {
      busy = false; apply(next); if (focusId) $(focusId)?.focus(); if (okSay) say(okSay);
    }, error => {
      busy = false; renderSection(); if (focusId) $(focusId)?.focus();
      say((error && error.message) || 'No se pudo completar.');
    });
  }
  // create / update: the form stays open with its draft until the backend CONFIRMS; a refusal keeps it.
  function save() {
    if (store?.load_error === true) return;
    const out = form.submit(selectableIds());
    if (!out.ok) { paintForm(); return; }
    let payload;
    if (out.editing) payload = { action: 'update', id: out.editing, name: out.draft.name, instructions: out.draft.instructions, model: out.draft.model, space: out.draft.space, permissions: out.draft.permissions };
    else {
      const id = V.randomId();
      if (!V.validId(id) || V.idTaken(store, id)) { form.settle(false, 'No se pudo generar la identidad del especialista.'); paintForm(); return; }
      payload = { action: 'create', id, name: out.draft.name, instructions: out.draft.instructions, model: out.draft.model, space: out.draft.space, permissions: out.draft.permissions };
    }
    paintForm();
    call('specialists_action', payload).then(next => {
      form.settle(true, ''); apply(next); say(out.editing ? 'Cambios guardados.' : 'Especialista creado.');
    }, error => {
      const message = (error && error.message) || 'No se pudo completar; no se cambió nada.';
      form.settle(false, message); renderSection(); say(message);
    });
  }
  function refreshModels() {
    call('models_action', { action: 'list' }).then(next => { listing = next; renderSection(); notifyChanged(); }, () => {});
  }
  if (listen) {
    listen('specialists:state', e => apply(e && e.payload)).catch(() => {});
    listen('prefs:state', e => applyPrefs(e && e.payload)).catch(() => {});
    listen('models:state', e => { if (e && e.payload) { listing = e.payload; renderSection(); notifyChanged(); } }).catch(() => {});
  }
  call('specialists_action', { action: 'view' }).then(apply, () => apply({ load_error: true }));
  call('prefs_action', { action: 'view' }).then(applyPrefs, () => {});
  refreshModels();

  // ---- the chat's role chip (display only: the section is where a role is chosen) ---------------------
  function renderChip() {
    const chip = $('chat-specialist');
    if (!chip) return;
    const view = V.roleChip(store);
    const host = $('chat-specialist-word');
    if (!view) { chip.hidden = true; delete chip.dataset.color; paintChosenColor(chip, ''); if (host) host.textContent = ''; return; }
    indicatorColor(chip, store.active);
    putIcon($('chat-specialist-icon'), 'user');
    chip.hidden = false;
    chip.setAttribute('aria-label', view.aria);
    if (host) host.textContent = view.word;
  }

  // ---- the section ----------------------------------------------------------------------------------
  function openNew() { if (store?.load_error === true) return; form.openNew(); renderSection(); const f = $('specialists-name'); if (f) f.focus(); }
  function openEdit(row) { if (store?.load_error === true) return; form.openEdit(row); renderSection(); const f = $('specialists-name'); if (f) f.focus(); }
  function cancelForm() { form.cancel(); renderSection(); }

  // Paints ONLY what depends on the draft (button state + the one-line problem), in place. Called on
  // every keystroke: no DOM rebuild, so focus and caret stay where the human put them.
  function paintForm() {
    const st = form.status(selectableIds());
    const btn = $('specialists-save');
    const canSave = st.canSave && store?.load_error !== true;
    if (btn) { btn.disabled = !canSave; btn.setAttribute('aria-disabled', canSave ? 'false' : 'true'); }
    const word = $('specialists-problem');
    if (word) {
      const text = form.state.error || (st.showProblem ? st.word : '');
      word.textContent = text;
      word.hidden = !text;
      word.dataset.tone = form.state.error ? 'red' : 'sun';
    }
    for (const id of ['specialists-name', 'specialists-instructions', 'specialists-model', 'specialists-space', ...V.PERMISSIONS.map(p => 'specialists-perm-' + p)]) {
      const f = $(id);
      if (f) f.disabled = form.state.pending || store?.load_error === true;
    }
    const cancel = $('specialists-cancel');
    if (cancel) cancel.disabled = form.state.pending;
  }

  function renderSection(target) {
    const host = target || $('specialists-section');
    if (!host) return;
    const view = V.storeView(store, listing);
    const active = document.activeElement;
    const focused = active && active.id ? active.id : null;
    const caret = active && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    host.textContent = '';
    const sec = el('section', 'ssec');
    sec.append(el('h3', 'ssection', 'Especialistas'));
    // #436 design: the declarative disclaimer is ONE chip in the section header (was a fixed
    // paragraph plus repeated wording in the Space/permissions fields).
    const declarativo = el('span', 'chip', 'Declarativo: todavía no se aplica');
    declarativo.id = 'specialists-declarativo';
    sec.append(declarativo);
    if (view.kind === 'loading') {
      sec.append(el('p', 'snote', 'Leyendo tus especialistas…'));
      host.append(sec);
      restoreFocus(host, focused, caret);
      return;
    }
    if (view.kind === 'unavailable') {
      const notice = el('p', 'snote strust', view.persistenceNote);
      notice.id = 'specialists-load-error'; notice.setAttribute('role', 'status'); notice.dataset.tone = 'red';
      sec.append(notice);
      if (form.state.open) sec.append(renderForm());
      else sec.append(wordBtn('Nuevo especialista', () => openNew(), { disabled: true }));
      host.append(sec); paintForm(); restoreFocus(host, focused, caret);
      return;
    }
    if (view.persistenceNote) sec.append(el('p', 'snote strust', view.persistenceNote));
    sec.append(el('p', 'snote', V.catalogNote(listing)));
    sec.append(el('span', 'chip', view.countWord));

    // The explicit choice: a radiogroup, Abito first, exactly one checked. Arrow keys move AND choose
    // (native radio behaviour); the principal comes back with `select {id:null}`.
    const group = el('div', 'sroles');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'Quién responde en el chat');
    const choices = V.roleChoices(view);
    const choose = (choice, focusId) => {
      if (busy || form.state.pending || store?.load_error === true || choice.checked) return;
      send({ action: 'select', id: choice.id }, choice.id === null ? 'Volviste a Koda, el principal.' : `Ahora responde ${choice.label}.`, focusId);
    };
    for (const choice of choices) {
      const rowEl = el('div', 'srole');
      rowEl.dataset.checked = choice.checked ? 'true' : 'false';
      const radio = el('button', 'srole-pick');
      radio.type = 'button';
      radio.id = 'specialists-role-' + (choice.id === null ? 'principal' : choice.id);
      radio.setAttribute('role', 'radio');
      radio.setAttribute('aria-checked', choice.checked ? 'true' : 'false');
      radio.setAttribute('aria-label', choice.aria);
      radio.tabIndex = choice.checked ? 0 : -1;
      radio.disabled = busy || form.state.pending;
      const dot = el('span', 'srole-dot');
      indicatorColor(dot, choice.id === null ? AVATAR?.PRINCIPAL_ID : choice.id);
      dot.setAttribute('aria-hidden', 'true');
      radio.append(dot, el('b', 'srow-title', choice.label));
      const row = choice.id === null ? null : view.rows.find(r => r.id === choice.id);
      if (row) {
        radio.append(el('span', 'chip', row.modelLabel));
        if (!row.modelReady) radio.append(el('span', 'chip', 'Modelo no disponible'));
      } else radio.append(el('span', 'chip', 'Principal'));
      radio.addEventListener('click', e => {
        if (e.isTrusted !== true || radio.disabled) return;
        choose(choice);
      });
      radio.addEventListener('keydown', e => {
        if (e.isTrusted !== true || radio.disabled) return;
        const all = [...group.querySelectorAll('[role="radio"]')];
        const nextIndex = V.roleKeyIndex(e.key, all.indexOf(radio), all.length);
        if (nextIndex < 0 || all[nextIndex].disabled) return;
        e.preventDefault(); all[nextIndex].focus();
        // Trusted keydown already authorizes selection; never manufacture a click event.
        choose(choices[nextIndex], all[nextIndex].id);
      });
      rowEl.append(radio);
      if (row) {
        if (!(form.state.open && form.state.editing === row.id)) rowEl.append(el('p', 'srow-sub', row.instructions));
        // #436 D8: the SAME colour choice the Apariencia tab edits, surfaced on the card so both stay in sync.
        const colors = colorChoices(row.id, row.name);
        if (colors) rowEl.append(colors);
        const actions = el('span', 'srow-actions');
        actions.append(wordBtn('Editar', () => openEdit(row), { aria: `Editar ${row.name}`, disabled: form.state.open }));
        actions.append(wordBtn('Borrar', () => send({ action: 'delete', id: row.id }, `${row.name}: borrado.`), { aria: `Borrar ${row.name}`, disabled: form.state.open }));
        rowEl.append(actions);
      }
      group.append(rowEl);
    }
    sec.append(group);
    if (view.active) sec.append(el('p', 'snote', 'Mientras un especialista está en uso, el chat le pide a ese rol y usa su modelo si tiene uno.'));
    if (!form.state.open) {
      const add = el('div', 'srow');
      const actions = el('span', 'srow-actions');
      actions.append(wordBtn('Nuevo especialista', () => openNew(), { primary: true, icon: 'user', disabled: view.count >= V.MAX_SPECIALISTS }));
      add.append(actions);
      sec.append(add);
      if (view.count >= V.MAX_SPECIALISTS) sec.append(el('p', 'snote', `Llegaste al máximo de ${V.MAX_SPECIALISTS} especialistas.`));
    } else {
      sec.append(renderForm());
    }
    host.append(sec);
    paintForm();
    restoreFocus(host, focused, caret);
  }

  // The panel rebuilds its DOM on every state push; a half-typed specialty must survive it.
  function restoreFocus(host, focused, caret) {
    if (!focused) return;
    const node = $(focused);
    if (!node || !host.contains(node)) return;
    node.focus();
    if (caret) { try { node.setSelectionRange(caret[0], caret[1]); } catch { /* not a text field */ } }
  }

  function renderForm() {
    const d = form.state.draft;
    const editing = form.state.editing;
    const box = el('form', 'sflow');
    box.id = 'specialists-form';
    box.noValidate = true;
    box.setAttribute('aria-label', editing ? 'Editar especialista' : 'Nuevo especialista');
    const name = el('input', 'sfield');
    name.type = 'text'; name.id = 'specialists-name'; name.maxLength = V.MAX_NAME; name.autocomplete = 'off'; name.required = true;
    name.placeholder = 'Nombre (obligatorio), por ejemplo Investigador';
    name.setAttribute('aria-label', 'Nombre del especialista, obligatorio');
    name.value = d.name;
    name.addEventListener('input', () => { form.input('name', name.value); paintForm(); });
    const instructions = el('textarea', 'sfield');
    instructions.id = 'specialists-instructions'; instructions.rows = 3; instructions.maxLength = V.MAX_INSTRUCTIONS; instructions.spellcheck = true; instructions.required = true;
    instructions.placeholder = 'Su especialidad: cómo tiene que trabajar este rol.';
    instructions.setAttribute('aria-label', 'Especialidad del especialista, obligatoria');
    instructions.value = d.instructions;
    instructions.addEventListener('input', () => { form.input('instructions', instructions.value); paintForm(); });
    const model = el('select', 'sfield');
    model.id = 'specialists-model';
    model.setAttribute('aria-label', 'Modelo local del especialista');
    for (const o of V.modelOptions(listing, d.model)) {
      const option = el('option', null, o.label);
      option.value = o.id === null ? '' : o.id;
      if (o.selected) option.selected = true;
      model.append(option);
    }
    model.addEventListener('change', () => { form.input('model', model.value); paintForm(); });
    const space = el('input', 'sfield');
    space.type = 'text'; space.id = 'specialists-space'; space.maxLength = V.MAX_SPACE; space.autocomplete = 'off';
    space.placeholder = 'Espacio por defecto (opcional)';
    space.setAttribute('aria-label', 'Espacio por defecto del especialista, opcional');
    space.value = d.space;
    space.addEventListener('input', () => { form.input('space', space.value); paintForm(); });
    const perms = el('div', 'sfield');
    perms.setAttribute('role', 'group');
    perms.setAttribute('aria-label', 'Permisos del especialista');
    perms.append(el('span', 'snote', 'Permisos:'));
    for (const p of V.PERMISSIONS) {
      const lab = el('label', 'sperm');
      const box = el('input'); box.type = 'checkbox'; box.id = 'specialists-perm-' + p; box.checked = d.permissions.includes(p);
      box.addEventListener('change', () => {
        const picked = V.PERMISSIONS.filter(x => (x === p ? box.checked : $('specialists-perm-' + x)?.checked));
        form.input('permissions', picked); paintForm();
      });
      lab.append(box, word(V.permissionLabel(p)));
      perms.append(lab);
    }
    const problem = el('p', 'snote strust');
    problem.id = 'specialists-problem'; problem.setAttribute('role', 'status'); problem.hidden = true;
    const actions = el('div', 'sform');
    const saveBtn = wordBtn(editing ? 'Guardar' : 'Crear', () => {}, { primary: true, icon: 'check' });
    saveBtn.id = 'specialists-save'; saveBtn.type = 'submit';
    const cancelBtn = wordBtn('Cancelar', () => cancelForm(), { icon: 'cross' });
    cancelBtn.id = 'specialists-cancel';
    actions.append(saveBtn, cancelBtn);
    box.addEventListener('submit', e => { e.preventDefault(); if (e.isTrusted === true) save(); });
    box.append(name, instructions, model, space, perms, problem, actions);
    return box;
  }

  // The section is rendered by the settings panel inside Ajustes (#327: no new screen, no new icon).
  // #442 T7.4: the Blobs screen (Ajustes) reads the ONE store/listing cache from here and sends its
  // closed commands through here: Settings never loads a second role cache.
  const act = payload => call('specialists_action', payload).then(next => { apply(next); return next; });
  const selectModel = profileId => call('models_action', { action: 'select', profile_id: profileId })
    .then(next => { if (next && typeof next === 'object') { listing = next; notifyChanged(); } return next; });
  window.AbitoSpecialistsPanel = Object.freeze({ renderSection, renderChip, identityView,
    state: () => ({ store, listing }), act, selectModel });
  notifyIdentities();
})();
