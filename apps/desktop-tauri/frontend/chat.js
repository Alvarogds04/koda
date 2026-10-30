'use strict';
/* U1 — the chat surface inside the island (same window, same surface).
   - Talks to Rust through `chat_action` with the closed command set
     (view/open/back/check/submit/cancel) and, for the F024 model row, through
     two more CLOSED sets: `models_action` (list/select of the verified local
     registry — the same verbs Ajustes → Modelos uses) and `specialists_action`
     (view only, to name the role that fixes a model). It never names an
     endpoint, a key, an account, a provider or an approval: Rust owns the
     local target.
   - Message rows use the small F025 markdown DOM renderer (text nodes only).
     Safe web links use open_chat_url, which independently validates in Rust.
     Greeting, notifications and error/system text retain their plain handlers.
   - Focus moves to the composer only on a deliberate typing intent (the
     human clicks it, or opens the chat from the keyboard). Escape first
     leaves the composer, a second Escape collapses the island; the draft is
     never discarded and lives in page memory only (never storage/disk).
   - Polite live region: one announcement per state change / finished
     answer, never per token. Total silence: no sound anywhere.
   - Motion is island.js's (contract spring/curve, reduced-motion snaps). */
(() => {
  const V = window.AbitoChatView;
  const M = window.AbitoChatMarkdown;
  // #371: the transcript's tool receipts and approval cards (text nodes only).
  const Cards = window.AbitoChatCards;
  const $ = id => document.getElementById(id);
  const capsule = $('capsule');
  const chat = $('chat');
  const openButton = $('open-chat');
  const backButton = $('chat-back');
  const log = $('chat-log');
  const input = $('chat-input');
  const send = $('chat-send');
  const cancel = $('chat-cancel');
  const form = $('chat-composer');
  const status = $('chat-status');
  const targetEl = $('chat-target');
  // F024: the model row above the composer (index.html `chat-model-row`).
  const modelBtn = $('chat-model-btn');
  const modelName = $('chat-model-name');
  const modelPicker = $('chat-model-picker');
  const modelNote = $('chat-model-note');
  const problem = $('chat-problem');
  const live = $('chat-live');
  const newer = $('chat-new');
  const stateChip = $('chat-state');
  const draftWord = $('chat-draft-word');
  const ICONS = window.AbitoIcons;
  const icon = name => (ICONS ? ICONS.svg(name) : '');
  // Parse only the closed, trusted icon registry, never message bytes.
  // Greeting and message content are constructed separately as text nodes.
  const svgParser = new DOMParser();
  function iconNode(name) {
    const doc = svgParser.parseFromString(icon(name), 'image/svg+xml');
    return doc.documentElement && doc.documentElement.nodeName === 'svg'
      ? document.importNode(doc.documentElement, true) : null;
  }
  for (const el of chat.querySelectorAll('[data-icon]')) {
    const node = iconNode(el.dataset.icon);
    el.replaceChildren(...(node ? [node] : []));
  }
  if (!V || !chat || !input) return;

  const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)
    || (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke)
    || null;
  const listen = (window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen) || null;
  const call = (cmd, payload) => (invoke ? invoke(cmd, { payload }) : Promise.reject(new Error('no ipc')));
  const action = payload => call('chat_action', payload);
  const modelsAction = payload => call('models_action', payload);
  const specialistsAction = payload => call('specialists_action', payload);

  let view = null;
  let inFlight = false;
  let pendingId = null; // reused if the same draft is re-sent after an IPC failure
  let localProblem = '';
  const createButton = $('chat-create');
  const conversationsButton = $('chat-conversations');
  const conversationsPanel = $('conversations');
  const conversationsList = $('conversations-list');
  let olderTurns = [];
  let historyBefore = null;
  let paging = false;
  let historyGeneration = 0;

  function setLive(text) {
    if (!text) return;
    live.textContent = '';
    // a new node per message so screen readers announce repeats too
    requestAnimationFrame(() => { live.textContent = text; });
  }

  function renderTarget() {
    const t = view && view.target;
    targetEl.textContent = V.targetAria(t);
    $('chat-target-chip').setAttribute('aria-label', V.targetAria(t));
  }

  // ---- F024: the model row above the composer ---------------------------------
  // The row shows the EFFECTIVE target of the next turn (Rust already resolved
  // the active role into it) and opens a picker over the SAME closed
  // `models_action` set Ajustes → Modelos uses (R3): a click selects a
  // registered, selectable local profile and it applies from the NEXT message.
  // The page never learns or sends an endpoint, a key or a provider (S5).
  let specialistsView = null; // `specialists_action view` + `specialists:state`
  let modelListing = null;    // `models_action list` + `models:state`
  let modelBusy = false;      // one selection in flight
  let pickerOpen = false;
  // #414: the Ajustes → Modelos allowlist (typed pref, read-only here). The picker offers only
  // the chosen models, falling back to all when none is chosen; the host republishes it as
  // `prefs:state`, so a change in Ajustes reaches the row without a new command.
  let chosenModels = null;
  function applyChosenModels(p) {
    if (!p || typeof p !== 'object') return;
    chosenModels = p.chosenModels && typeof p.chosenModels === 'object' && !Array.isArray(p.chosenModels) ? p.chosenModels : {};
    if (pickerOpen) renderPicker();
  }

  function renderPicker() {
    if (!modelPicker || !modelNote) return;
    modelPicker.replaceChildren();
    // R4: ONE line, inside the picker, re-appended after every repaint (the
    // children were just cleared). The node itself lives in index.html.
    const note = V.modelRoleNote(view, V.activeRole(specialistsView));
    modelNote.textContent = note;
    modelNote.hidden = !note;
    if (note) modelPicker.append(modelNote);
    const enabled = V.modelButtonEnabled(view);
    for (const row of V.filterChosen(V.modelRows(modelListing), chosenModels)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'picker-row';
      const name = document.createElement('span');
      name.className = 'picker-name';
      name.textContent = row.title;
      const state = document.createElement('span');
      state.className = 'picker-state';
      state.textContent = row.cloud ? `${row.provider} · nube` : row.state;
      b.append(name, state);
      b.setAttribute('aria-pressed', row.selected ? 'true' : 'false');
      b.setAttribute('aria-label', `${row.selected ? 'Elegido. ' : 'Elegir. '}${row.aria}`);
      b.disabled = !row.selectable || row.selected || modelBusy || !enabled;
      if (row.selectable && !row.selected) b.addEventListener('click', () => selectModel(row.id, row.title));
      modelPicker.append(b);
    }
  }

  function renderModelRow() {
    if (!modelBtn || !modelName) return;
    const role = V.activeRole(specialistsView);
    modelName.textContent = V.modelButtonLabel(view, role); // R1: text, never markup
    modelBtn.setAttribute('aria-label', V.modelButtonAria(view, role)); // R4/R5
    const availability = view && view.availability ? view.availability.state : 'unchecked';
    modelBtn.dataset.avail = view && view.target ? availability : 'unchecked';
    const enabled = V.modelButtonEnabled(view); // R2
    modelBtn.disabled = !enabled || modelBusy;
    if (!enabled && pickerOpen) {
      // A running turn freezes the target; a down/blocked chosen one refuses
      // like Send does. The row closes instead of offering a dead choice.
      pickerOpen = false;
      if (modelPicker) { modelPicker.hidden = true; modelPicker.inert = true; }
      modelBtn.setAttribute('aria-expanded', 'false');
      if (modelNote) { modelNote.textContent = ''; modelNote.hidden = true; }
      return;
    }
    if (!pickerOpen && modelNote) { modelNote.textContent = ''; modelNote.hidden = true; }
    if (pickerOpen) renderPicker();
  }

  function loadModelListing() {
    modelsAction({ action: 'list' }).then(next => {
      modelListing = next;
      if (pickerOpen) renderPicker();
    }, () => { /* the picker keeps the last listing it has, if any */ });
  }

  function setPicker(open) {
    pickerOpen = !!open && V.modelButtonEnabled(view);
    if (modelPicker) {
      modelPicker.hidden = !pickerOpen;
      modelPicker.inert = !pickerOpen;
    }
    modelBtn.setAttribute('aria-expanded', pickerOpen ? 'true' : 'false');
    renderModelRow();
    if (pickerOpen) loadModelListing();
  }

  function selectModel(id, title) {
    if (modelBusy) return;
    modelBusy = true;
    renderModelRow();
    modelsAction({ action: 'select', profile_id: id }).then(() => {
      modelBusy = false;
      setPicker(false); // upstream parity: the picker closes on a choice
      renderModelRow(); // the republished chat:state carries the new target
      setLive(`${title} elegido. Se usa desde el próximo mensaje.`);
    }, error => {
      modelBusy = false;
      renderModelRow();
      setLive((error && error.message) || 'No se pudo elegir el modelo.');
    });
  }

  function applySpecialists(next) {
    if (!next || typeof next !== 'object') return;
    specialistsView = next;
    renderModelRow();
  }

  if (modelBtn) modelBtn.addEventListener('click', () => setPicker(!pickerOpen));

  // #310: the history is reconciled against what is drawn, never rebuilt. Measured before the fix: sending one
  // message removed 23 nodes to go from 2 to 4 rows and moved the first row twice (the flash).
  let drawn = [];            // the rows as last drawn, in order
  function paintRow(li, row) {
    li.className = row.kind;
    li.textContent = '';
    li.removeAttribute('aria-label'); delete li.dataset.tone;
    delete li.dataset.state; delete li.dataset.decision; // #371: a patched row never keeps the previous card's state
    if ((row.kind === 'tool' || row.kind === 'approval') && Cards) {
      Cards.render(li, row, iconNode);
    } else if (row.kind === 'context') { // S3 (#503): a closed disclosure with the exact text the model got
      const d = document.createElement('details');
      const s = document.createElement('summary');
      s.textContent = 'Contexto';
      const pre = document.createElement('pre');
      pre.textContent = row.detail;
      d.append(s, pre);
      li.append(d);
    } else if (row.short) { // note/error: icon + ONE word; the full text is the accessible name
      li.setAttribute('aria-label', row.text);
      const i = document.createElement('span');
      i.className = 'ico';
      const node = iconNode(row.icon); if (node) i.append(node);
      const w = document.createElement('span');
      w.className = 'word'; w.textContent = row.kind === 'error' ? row.text : row.short;
      li.append(i, w);
      if (row.kind === 'error') li.dataset.tone = 'red';
    } else if (M && (row.kind === 'assistant' || row.kind === 'user')) {
      M.render(li, row.text, {
        openUrl: url => (invoke ? invoke('open_chat_url', { payload: { url } }) : Promise.reject(new Error('no ipc')))
          .catch(() => { setLive('No se pudo abrir el enlace.'); }),
        copyCode: text => {
          if (!navigator.clipboard || !navigator.clipboard.writeText) {
            setLive('No se pudo copiar el código.'); return Promise.reject(new Error('clipboard unavailable'));
          }
          return navigator.clipboard.writeText(text).then(() => { setLive('Código copiado.'); }, () => {
            setLive('No se pudo copiar el código.'); throw new Error('clipboard refused');
          });
        },
      });
    } else li.textContent = row.text;
  }
  function renderLog() {
    const pinned = V.atBottom(log.scrollTop, log.scrollHeight, log.clientHeight);
    const before = log.scrollHeight;
    const turns = V.mergeHistory(olderTurns, (view && Array.isArray(view.turns)) ? view.turns : []);
    const rows = [];
    for (const turn of turns) for (const row of V.turnRows(turn)) rows.push(row);
    const placeholder = log.querySelector('li.empty');
    const g = turns.length ? null : V.emptyGreeting(view);
    const historyLabel = $('chat-history-label'); // T7.3: «Conversación nueva» only while the conversation has no turns
    if (historyLabel) historyLabel.hidden = turns.length > 0;
    if (!turns.length) {
      // §2.3: lock «local» + eye-off, centred; the whole sentence is aria.
      // F027: an explicit display name adds «Hola, <nombre>.» as visible text. The
      // name arrives with a later state push, so the row is redrawn whenever the
      // sentence it must announce changed — never emptied while turns exist. The
      // name is text: textContent only, never into HTML.
      if (!placeholder || placeholder.getAttribute('aria-label') !== g.aria) {
        if (placeholder) placeholder.remove();
        log.textContent = '';
        const li = document.createElement('li');
        li.className = 'empty';
        li.setAttribute('role', 'img');
        li.setAttribute('aria-label', g.aria);
        const icons = document.createElement('span');
        icons.className = 'empty-icons';
        for (const name of g.icons) {
          const i = document.createElement('span');
          i.className = 'ico';
          const node = iconNode(name);
          if (node) i.append(node);
          icons.append(i);
        }
        if (g.icons.length) li.append(icons);
        const line = document.createElement('p'); // T7.3: the one visible line of the design
        line.className = 'empty-line';
        line.textContent = g.line;
        li.append(line);
        if (g.greeting) {
          const word = document.createElement('p');
          word.className = 'empty-greeting';
          word.textContent = g.greeting;
          li.append(word);
        }
        log.appendChild(li);
      }
      drawn = [];
    } else {
      if (placeholder) { placeholder.remove(); drawn = []; }
      const plan = V.reconcileRows(drawn, rows);
      const hadRows = drawn.length > 0;
      for (const { index, row } of plan.patch) paintRow(log.children[index], row);
      for (let k = 0; k < plan.remove; k += 1) log.lastElementChild.remove();
      for (const row of plan.append) {
        const li = document.createElement('li');
        paintRow(li, row);
        if (hadRows) li.classList.add('enter'); // only NEW rows animate
        log.appendChild(li);
      }
      drawn = rows;
    }
    if (!turns.length) {
      newer.hidden = true; // nothing left to scroll to (conversation reset)
    } else if (pinned) {
      log.scrollTop = log.scrollHeight;
      newer.hidden = true;
    } else if (log.scrollHeight > before) {
      newer.hidden = false;
    }
  }

  function renderControls() {
    const active = V.activeTurn(view);
    cancel.hidden = !active;
    send.disabled = V.sendState(view, input.value, inFlight).disabled;
    const draftIssue = input.value ? V.draftProblem(input.value) : null;
    const historyProblem = view && view.history_problem;
    problem.textContent = localProblem || historyProblem || draftIssue || '';
    if (createButton) createButton.disabled = active !== null || inFlight;
    if (conversationsButton) conversationsButton.disabled = active !== null || inFlight;
    if ($('chat-history-warning')) {
      const warning = historyProblem || (view && view.history_skipped ? `Se omitieron ${view.history_skipped} registros dañados.` : '');
      $('chat-history-warning').hidden = !warning;
      $('chat-history-warning').textContent = warning;
    }
    const availability = view && view.availability ? view.availability.state : 'unchecked';
    capsule.dataset.chatAvailability = availability;
    status.textContent = localProblem || V.statusLine(view);
    const sv = V.statusView(view);
    stateChip.dataset.tone = sv.tone;
    stateChip.dataset.kind = sv.kind;
    stateChip.setAttribute('aria-label', localProblem || sv.aria);
    const stateIcon = sv.icon ? iconNode(sv.icon) : document.createElement('span');
    if (!sv.icon) stateIcon.className = `dot ${sv.kind === 'ready' ? 'go' : ''}`;
    $('chat-state-icon').replaceChildren(...(stateIcon ? [stateIcon] : []));
    $('chat-state-word').textContent = sv.word;
    const dw = input.value ? V.draftWord(input.value) : '';
    draftWord.hidden = !dw;
    draftWord.textContent = dw;
    input.dataset.invalid = dw ? 'true' : 'false';
    // R6 pose from REAL lane state only (docs/r6-states-mapping.md): thinking,
    // streaming a reply, or the model down/blocked. Anything else = rest.
    const pose = V.poseFor(view);
    document.dispatchEvent(new CustomEvent('abito:pose', { detail: pose }));

  }

  function resetHistory(next) {
    olderTurns = []; historyBefore = next.history_before || null; historyGeneration += 1; paging = false;
    log.textContent = ''; drawn = [];
  }
  // S10 (L35): Coucou's growing chat. The page computes the height its conversation wants (240 + 40 per message, up to 300) and
  // reports it through the closed `height` verb; Rust clamps it again and resizes the native window. Only while the chat is the
  // visible view, and only when the number changed.
  let reportedHeight = 0, reporting = false;
  function reportHeight() {
    if (capsule.dataset.view !== 'chat' || reporting) return;
    const wanted = V.chatHeight(view);
    if (wanted === reportedHeight) return;
    reporting = true;
    action({ action: 'height', height: wanted }).then(() => { reportedHeight = wanted; }, () => {}).finally(() => { reporting = false; });
  }
  document.addEventListener('island:view', event => { if (event.detail === 'chat') { reportedHeight = 0; reportHeight(); } else reportedHeight = 0; });
  // The «checking» spinner never outlives the chat's own look at the model: while the chat is open and the availability is still
  // `unchecked`, ask the host for its metadata-only check (never a prompt), at most V.CHECK_TRIES times, 4 s apart. A re-pick of the model
  // (which resets the state to `unchecked`) starts a new episode.
  let checkTries = 0, checkLast = 0, checkTimer = 0;
  function scheduleCheck() {
    const wanted = capsule.dataset.view === 'chat' && V.needsCheck(view);
    if (!wanted) { checkTries = 0; clearTimeout(checkTimer); checkTimer = 0; return; }
    const plan = V.checkPlan(checkTries, Date.now(), checkLast);
    if (plan.ask) {
      checkTries += 1; checkLast = Date.now();
      action({ action: 'check' }).then(apply, () => {});
    } else if (!plan.giveUp && !checkTimer) {
      checkTimer = setTimeout(() => { checkTimer = 0; scheduleCheck(); }, plan.wait);
    }
  }
  document.addEventListener('island:view', () => scheduleCheck());

  function apply(next) {
    if (!next || typeof next !== 'object') return;
    // Events and view RPCs can arrive out of capture order. Never resurrect a
    // running turn over a newer (possibly terminal) state of that same turn.
    if (V.staleSnapshot(view, next)) return;
    const changed = !view || view.conversation_id !== next.conversation_id;
    const said = changed ? null : V.announcement(view, next);
    if (changed) {
      resetHistory(next);
      if (view) { input.value = ''; pendingId = null; localProblem = ''; autosize(); attachments = []; renderAttachments(); }
    }
    view = next;
    reportHeight();
    renderTarget();
    renderLog();
    renderControls();
    renderModelRow();
    scheduleCheck();
    if (capsule.dataset.view === 'chat') setLive(said);
    // #313: turns and the model going down become cues by TRANSITION (history and the first snapshot are baselines)
    try { const w = window.AbitoSoundWiringInstance; if (w) w.observeChat(next); } catch { /* sound never breaks the chat */ }
  }

  // ---- #341: local conversations -----------------------------------------
  function closeConversations() {
    if (!conversationsPanel) return;
    conversationsPanel.hidden = true;
    conversationsPanel.inert = true;
    conversationsButton.setAttribute('aria-expanded', 'false');
    log.inert = false; form.inert = false;
  }
  function createConversation() {
    if (inFlight || V.activeTurn(view)) return;
    inFlight = true; renderControls();
    action({ action: 'new' }).then(next => {
      closeConversations(); apply(next); input.value = ''; pendingId = null; autosize(); input.focus();
    }, error => { localProblem = error.message || 'No se pudo crear la conversación.'; setLive(localProblem); })
      .finally(() => { inFlight = false; renderControls(); });
  }
  if (createButton) createButton.addEventListener('click', createConversation);
  if (conversationsButton) conversationsButton.addEventListener('click', () => {
    if (inFlight || V.activeTurn(view)) return;
    action({ action: 'list' }).then(listing => {
      conversationsList.replaceChildren();
      for (const row of V.conversationRows(listing)) {
        const li = document.createElement('li');
        const button = document.createElement('button'); button.type = 'button';
        button.textContent = row.text; button.setAttribute('aria-label', row.aria);
        button.setAttribute('aria-current', row.id === (view && view.conversation_id) ? 'true' : 'false');
        button.addEventListener('click', () => {
          if (inFlight) return;
          inFlight = true; renderControls();
          action({ action: 'restore', conversation_id: row.id }).then(next => {
            closeConversations(); resetHistory(next); input.value = ''; pendingId = null; localProblem = ''; autosize(); apply(next); log.focus();
          }, error => { $('conversations-note').textContent = error.message || 'No se pudo abrir la conversación.'; })
            .finally(() => { inFlight = false; renderControls(); });
        });
        li.append(button); conversationsList.append(li);
      }
      const specialistsList = $('specialists-list');
      if (specialistsList) {
        specialistsList.replaceChildren();
        for (const row of V.specialistRows(specialistsView)) {
          const li = document.createElement('li');
          const button = document.createElement('button'); button.type = 'button';
          button.textContent = row.text; button.setAttribute('aria-label', row.aria);
          button.setAttribute('aria-current', row.current ? 'true' : 'false');
          button.addEventListener('click', () => {
            if (inFlight) return;
            inFlight = true; renderControls();
            action({ action: 'new_with', specialist_id: row.id }).then(next => {
              closeConversations(); resetHistory(next); input.value = ''; pendingId = null; localProblem = ''; autosize(); apply(next); input.focus();
            }, error => { $('conversations-note').textContent = error.message || 'No se pudo abrir la conversación.'; })
              .finally(() => { inFlight = false; renderControls(); });
          });
          li.append(button); specialistsList.append(li);
        }
      }
      let note = listing.conversations.length ? '' : 'Todavía no hay conversaciones guardadas.';
      if (listing.skipped) note = `Se omitieron ${listing.skipped} registros o archivos dañados.`;
      $('conversations-note').textContent = note;
      conversationsPanel.hidden = false; conversationsPanel.inert = false;
      conversationsButton.setAttribute('aria-expanded', 'true'); log.inert = true; form.inert = true;
      $('conversations-close').focus();
    }, error => { localProblem = error.message || 'No se pudo leer el historial.'; renderControls(); setLive(localProblem); });
  });
  if ($('conversations-close')) $('conversations-close').addEventListener('click', () => { closeConversations(); conversationsButton.focus(); });
  function loadOlder() {
    if (!view || !historyBefore || paging || log.scrollTop > 8 || log.inert) return;
    paging = true;
    const id = view.conversation_id, generation = historyGeneration;
    const height = log.scrollHeight, top = log.scrollTop;
    action({ action: 'history', conversation_id: id, before: historyBefore }).then(page => {
      if (!view || view.conversation_id !== id || generation !== historyGeneration) return;
      olderTurns = V.mergeHistory(page.turns, olderTurns);
      historyBefore = page.before || null;
      if (page.skipped) view.history_skipped = page.skipped;
      renderLog(); renderControls();
      log.scrollTop = top + log.scrollHeight - height; // keep the same message under the reader's eye
      newer.hidden = true;
    }, error => {
      if (generation !== historyGeneration) return;
      localProblem = error.message || 'No se pudo cargar el historial anterior.'; renderControls(); setLive(localProblem);
    }).finally(() => { if (generation === historyGeneration) paging = false; });
  }

  // ---- open / back --------------------------------------------------------
  let openedByKeyboard = false;
  function openChat(byKeyboard) {
    openedByKeyboard = byKeyboard;
    action({ action: 'open' }).then(apply, () => {});
  }
  openButton.addEventListener('click', event => openChat(event.detail === 0));
  backButton.addEventListener('click', event => {
    const byKeyboard = event.detail === 0;
    action({ action: 'back' }).then(next => {
      apply(next);
      if (byKeyboard) openButton.focus(); // keep keyboard users oriented
    }, () => {});
  });
  let inertTimer = 0;
  document.addEventListener('island:view', event => {
    // NOT `hidden` (display:none would kill the enter/exit transition): the
    // view is hidden by CSS (visibility/opacity, with the §9.2 motion) and
    // `inert` takes it out of focus order and accessibility.
    clearTimeout(inertTimer);
    if (event.detail === 'chat') chat.inert = false;
    else inertTimer = setTimeout(() => { if (capsule.dataset.view !== 'chat') chat.inert = true; }, 220); // after the 160ms exit
    if (event.detail !== 'chat' && pickerOpen) setPicker(false); // F024: the row belongs to the chat view
    if (event.detail === 'chat') {
      renderLog();
      renderControls();
      if (openedByKeyboard) input.focus(); // deliberate keyboard intent to type
      setLive('Conversación abierta. ' + V.statusLine(view));
    }
    openedByKeyboard = false;
  });

  // ---- composer ---------------------------------------------------------------
  // #309: the composer grows with what is typed (a few lines, then it scrolls), like a column chat.
  const MIN_INPUT = 36, MAX_INPUT = 120;
  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.max(MIN_INPUT, Math.min(MAX_INPUT, input.scrollHeight)) + 'px';
  }

  // ---- #343: file attachments in the composer ------------------------------
  // Dropped or picked files never become page data: Rust validates (MIME
  // allowlist, size cap) and stores them in the island's OWN uploads
  // directory — a dropped path goes to `chat_attach`, a picked file as raw
  // bytes (`chat_attach_data`: one-line JSON header, LF, file bytes). The
  // composer only holds the returned metadata; the ids ride with the next
  // submit. A REJECTED file calls nothing, stores nothing, shows no chip.
  const ATTACH_MAX = 5; // mirrors chat.rs MAX_ATTACHMENTS_PER_TURN
  const PAPERCLIP_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M13.5 7l-5.2 5.2a1.8 1.8 0 0 0 2.5 2.5l5.7-5.7a4 4 0 0 0-5.7-5.7L5 9.1a6.2 6.2 0 0 0 8.8 8.8"/></svg>';
  const ATTACH_TOO_MANY = 'Son demasiados archivos adjuntos: hasta 5 por mensaje.';
  let attachments = []; // metadata only, page memory like the draft
  const attachStrip = document.createElement('div');
  attachStrip.id = 'chat-attachments';
  attachStrip.className = 'composer-attachments';
  attachStrip.setAttribute('role', 'list');
  attachStrip.setAttribute('aria-label', 'Archivos adjuntos');
  attachStrip.hidden = true;
  const pickButton = document.createElement('button');
  pickButton.type = 'button';
  pickButton.id = 'chat-attach';
  pickButton.className = 'round';
  pickButton.setAttribute('aria-label', 'Adjuntar archivo');
  // Same rule as every icon: parsed from a source constant with DOMParser,
  // never assigned as markup.
  {
    const doc = svgParser.parseFromString(PAPERCLIP_SVG, 'image/svg+xml');
    const node = doc.documentElement && doc.documentElement.nodeName === 'svg'
      ? document.importNode(doc.documentElement, true) : null;
    if (node) pickButton.append(node);
  }
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.id = 'chat-attach-input';
  fileInput.multiple = true;
  fileInput.hidden = true;
  fileInput.setAttribute('tabindex', '-1');
  fileInput.setAttribute('aria-hidden', 'true');
  form.append(attachStrip, pickButton, fileInput); // flex `order` places them

  // T7.3 (design isla-chat-atterr): a refused file is shown as a display-only error chip + ONE
  // reason line. It is NOT an attachment: no id, never sent, never counted, cleared by the next
  // successful attach, a removal or a send.
  let attachError = null; // { name, reason }
  function errorChip() {
    const chip = document.createElement('div');
    chip.className = 'composer-attachment composer-attachment-error';
    chip.setAttribute('role', 'status');
    const warn = iconNode('triangle');
    if (warn) chip.append(warn);
    const name = document.createElement('span');
    name.className = 'composer-attachment-name';
    name.textContent = attachError.name;
    chip.append(name);
    const reason = document.createElement('p');
    reason.className = 'composer-attachment-reason';
    reason.textContent = attachError.reason;
    return [chip, reason];
  }
  function renderAttachments() {
    attachStrip.replaceChildren();
    attachStrip.hidden = attachments.length === 0 && !attachError;
    for (const a of attachments) {
      const chip = document.createElement('span');
      chip.className = 'composer-attachment';
      chip.setAttribute('role', 'listitem');
      const name = document.createElement('span');
      name.className = 'composer-attachment-name';
      name.textContent = a.name; // text, never markup
      const size = document.createElement('span');
      size.className = 'composer-attachment-size';
      size.textContent = V.formatSize(a.size);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'composer-attachment-remove';
      remove.setAttribute('aria-label', `Quitar ${a.name}`);
      const x = iconNode('cross');
      if (x) remove.append(x);
      remove.addEventListener('click', () => {
        attachments = attachments.filter(other => other.id !== a.id);
        attachError = null;
        renderAttachments();
      });
      chip.append(name, size, remove);
      attachStrip.append(chip);
    }
    if (attachError) attachStrip.append(...errorChip());
  }
  function refuse(name, error) {
    const reason = (error && error.message) || 'No se pudo adjuntar el archivo.';
    attachError = { name: String(name || '').slice(0, 80) || 'archivo', reason };
    renderAttachments();
    setLive(reason);
  }

  function addAttachment(att) {
    if (!att || typeof att.id !== 'string' || typeof att.name !== 'string') return;
    attachError = null;
    if (attachments.some(other => other.id === att.id)) return;
    attachments.push({
      id: att.id,
      name: att.name,
      mime: typeof att.mime === 'string' ? att.mime : '',
      size: att.size,
    });
    renderAttachments();
    setLive(`${att.name} adjuntado. Se envía con el próximo mensaje.`);
  }

  async function attachPath(path) {
    if (typeof path !== 'string' || !path) return;
    if (attachments.length >= ATTACH_MAX) { setLive(ATTACH_TOO_MANY); return; }
    try {
      addAttachment(await call('chat_attach', { path }));
    } catch (error) {
      refuse(path.split(/[\\/]/).pop(), error);
    }
  }

  async function attachPicked(file) {
    if (!file || typeof file.name !== 'string') return;
    if (attachments.length >= ATTACH_MAX) { setLive(ATTACH_TOO_MANY); return; }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const header = new TextEncoder().encode(`${JSON.stringify({ name: file.name })}\n`);
      const body = new Uint8Array(header.length + bytes.length);
      body.set(header, 0);
      body.set(bytes, header.length);
      addAttachment(await invoke('chat_attach_data', body));
    } catch (error) {
      refuse(file.name, error);
    }
  }

  // Design 14: the microphone (44 px) starts a hands-free dictation through the closed Flow verb; it exists only when dictation is on.
  const mic = $('chat-mic');
  if (mic) {
    const say = verb => call('dictation_action', { action: verb }).catch(() => null);
    say('status').then(s => { mic.hidden = !(s && s.prefs && s.prefs.enabled === true); });
    mic.addEventListener('click', e => { if (e.isTrusted === true) say('hands_free'); });
  }
  pickButton.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const files = Array.prototype.slice.call(fileInput.files || []);
    fileInput.value = '';
    for (const file of files) attachPicked(file);
  });
  input.addEventListener('input', () => { localProblem = ''; autosize(); renderControls(); });
  input.addEventListener('keydown', event => {
    // IME owns the key: `isComposing` while it composes, and the legacy 229 sentinel for
    // the keydown that confirms a candidate where the engine delivers it after
    // `compositionend` (WebKit bug 165004; 229 is what that keydown carries on Safari 26).
    // Where such a keydown arrives with a plain 13 there is NO signal that tells it apart
    // from an intentional Enter, so it sends: Enter always sends, and the README records
    // that gap rather than papering over it with a time window, which swallows real
    // Enters (TaskView #372, parent decision 2026-10-13).
    if (event.isComposing || event.keyCode === 229) return; // IME owns the key
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!send.disabled) form.requestSubmit();
    }
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!V.canSend(view, input.value, inFlight)) {
      // the disc is live for a non-empty draft: say why nothing was sent instead of staying silent
      const why = V.sendState(view, input.value, inFlight).blocked || V.draftProblem(input.value);
      if (why && !inFlight) { localProblem = why; setLive(why); }
      renderControls(); return;
    }
    if (pickerOpen) setPicker(false); // upstream parity: choosing ends the row's job
    const text = input.value;
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    pendingId = pendingId || V.newRequestId(bytes);
    inFlight = true;
    localProblem = '';
    renderControls();
    const payload = { action: 'submit', text, client_request_id: pendingId };
    if (attachments.length) payload.attachments = attachments.map(a => a.id);
    action(payload).then(
      () => {
        inFlight = false;
        pendingId = null;
        if (input.value === text) { input.value = ''; autosize(); } // accepted: the draft became a turn
        if (attachments.length || attachError) { attachments = []; attachError = null; renderAttachments(); } // the files went with the turn
        renderControls();
        action({ action: 'view' }).then(apply, () => {});
      },
      error => {
        inFlight = false;
        // typed refusal: keep the draft, say why; a new draft gets a new id
        pendingId = null;
        localProblem = (error && error.message) || 'No se pudo enviar.';
        renderControls();
        setLive(localProblem);
      });
  });
  cancel.addEventListener('click', () => {
    const active = V.activeTurn(view);
    if (!active) return;
    action({ action: 'cancel', turn_id: active.turn_id }).then(
      () => action({ action: 'view' }).then(apply, () => {}), () => {});
  });
  newer.addEventListener('click', () => {
    log.scrollTop = log.scrollHeight;
    newer.hidden = true;
  });
  log.addEventListener('scroll', () => {
    loadOlder();
    if (V.atBottom(log.scrollTop, log.scrollHeight, log.clientHeight)) newer.hidden = true;
  });

  // ---- keyboard: Enter opens from the overview, Escape steps out -----------
  document.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    const expanded = capsule.dataset.phase === 'expanded';
    const inChat = capsule.dataset.view === 'chat';
    const typing = document.activeElement === input;
    if (expanded && inChat && event.ctrlKey && !event.altKey && !event.metaKey && String(event.key).toLowerCase() === 'n') {
      event.preventDefault(); if (!event.repeat) createConversation(); return;
    }
    if (event.key === 'Escape') {
      if (conversationsPanel && !conversationsPanel.hidden) { event.preventDefault(); closeConversations(); conversationsButton.focus(); return; }
      if (pickerOpen) { event.preventDefault(); setPicker(false); modelBtn.focus(); return; } // F024: first Escape leaves the picker
      // #408: the model picker is a tab of Ajustes; settings.js closes Ajustes on Escape (capture phase) before this runs.
      if (typing) { input.blur(); log.focus(); event.preventDefault(); return; } // leave typing mode
      if (expanded && window.desktop) { event.preventDefault(); window.desktop.close().catch(() => {}); }
      return;
    }
    if (event.key === 'Enter' && expanded && !inChat) {
      const focused = document.activeElement;
      // Enter on another control (allow/deny/dismiss) keeps its own meaning.
      if (focused && focused !== document.body && focused !== openButton) return;
      // A question card on screen owns Enter (Siguiente / Hecho / Enviar in notify.js): never also open the chat over it.
      if (capsule.dataset.question === 'pending' || capsule.dataset.question === 'expired') return;
      event.preventDefault();
      openChat(true);
    }
  });

  // Q1: the deliberate "Open Abito chat and type" activation (second launch
  // with --chat) ends here: Rust already opened the chat and focused the
  // window; put the caret in the composer.
  window.__islandFocusComposer = () => {
    openedByKeyboard = false;
    requestAnimationFrame(() => input.focus());
  };

  // ---- state stream -------------------------------------------------------------
  if (listen) {
    listen('chat:state', event => apply(event && event.payload)).catch(() => {});
    // #343: a file dropped on the island is offered to the chat — only while
    // the chat view is open, and only well-formed payloads reach the IPC.
    listen('tauri://drag-drop', event => {
      if (capsule.dataset.view !== 'chat') return;
      const paths = event && event.payload && event.payload.paths;
      if (!Array.isArray(paths)) return;
      for (const path of paths) attachPath(path);
    }).catch(() => {});
    // T7.3 (design isla-chat-drag): the drag-over card only while the chat view is open.
    const drop = $('chat-drop');
    const showDrop = on => { if (drop) drop.hidden = !on || capsule.dataset.view !== 'chat'; };
    listen('tauri://drag-enter', () => showDrop(true)).catch(() => {});
    listen('tauri://drag-leave', () => showDrop(false)).catch(() => {});
    listen('tauri://drag-drop', () => showDrop(false)).catch(() => {});
    listen('specialists:state', event => applySpecialists(event && event.payload)).catch(() => {});
    listen('models:state', event => {
      const next = event && event.payload;
      if (next && typeof next === 'object') { modelListing = next; if (pickerOpen) renderPicker(); }
    }).catch(() => {});
    // #414: the allowlist arrives with the prefs stream; the host republishes it on every change.
    listen('prefs:state', event => applyChosenModels(event && event.payload)).catch(() => {});
  }
  action({ action: 'view' }).then(apply, () => {});
  // R4 needs to know whether the ACTIVE role fixes a model: one read-only
  // `view` (the section issues the same one); the page never writes a role.
  specialistsAction({ action: 'view' }).then(applySpecialists, () => {});
  // #414: the allowlist the row honours — one read-only view; nothing here ever writes a pref.
  call('prefs_action', { action: 'view' }).then(applyChosenModels, () => {});
})();
