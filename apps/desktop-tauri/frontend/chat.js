'use strict';
/* U1 — the chat surface inside the island (same window, same surface).
   - Talks to Rust through `chat_action` with the closed command set
     (view/open/back/check/submit/cancel, and K2-05 U4b `answer` for the agent's
     questions) and, for the F024 model row, through
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
  // K2-05 T4 S2 (Gentle Dot's model): ONE continuous chat (L3/L4/L11) held as ONE contiguous run of turns: the
  // earlier pages the reader loaded (oldest first), then the live window. Earlier turns load by scrolling to the top
  // or with the visible «Cargar anteriores» control, one daemon page per request, with the cursor the last answer
  // gave (the daemon's own position of the run's first turn). Everything loaded stays loaded, like Gentle Dot.
  const loadEarlierButton = $('chat-load-earlier');
  let olderTurns = [];
  let historyBefore = null;
  let paging = false;
  let historyGeneration = 0;
  let lastPage = 0, pageTimer = 0, pendingPage = null;
  // Once an earlier page answered (even with no whole turn), the cursor is the one the pages returned, never the
  // window's again (F2: a page that adds no rows must not lose its place). `autoFor` = the cursor the page asked for by
  // itself because the newest page held only a lone reply (F1: one read per such cursor, never a loop).
  let runStarted = false, autoFor = null;
  let pageProblem = ''; // F7: the paging error on screen, cleared when a page loads
  let following = true; // the log follows the newest message («Ir al final» hidden)

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
  let drawnKeys = [];        // F5: their keys, position-matched
  let turnCache = new Map(); // F5: turn id -> { turn, rows, keys } as last drawn
  function paintRow(li, row) {
    li.className = row.kind;
    li.textContent = '';
    li.removeAttribute('aria-label'); delete li.dataset.tone;
    delete li.dataset.state; delete li.dataset.decision; // #371: a patched row never keeps the previous card's state
    if ((row.kind === 'tool' || row.kind === 'approval') && Cards) {
      Cards.render(li, row, iconNode);
    } else if (row.kind === 'attachments') { // K2-05: the files the message carried (Gentle Dot's chips)
      li.setAttribute('aria-label', row.text);
      const list = document.createElement('ul');
      list.className = 'message-attachments';
      for (const file of row.files) {
        const chip = document.createElement('li');
        chip.className = 'message-attachment';
        const name = document.createElement('span');
        name.className = 'message-attachment-name';
        name.textContent = file.name; // text, never markup
        name.setAttribute('title', file.name);
        const size = document.createElement('span');
        size.className = 'message-attachment-size';
        size.textContent = file.size;
        chip.append(name, size);
        list.append(chip);
      }
      li.append(list);
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
    const turns = V.mergeHistory(olderTurns, view && Array.isArray(view.turns) ? view.turns : []);
    // F5: a turn the host re-sent unchanged keeps its rows and their keys; only a changed turn is rendered again
    const rows = [], keys = [], cache = new Map(), turnRowCounts = [];
    for (const turn of turns) {
      let entry = turnCache.get(turn.turn_id);
      if (entry && V.sameTurn(entry.turn, turn)) entry.turn = turn;
      else { const r = V.turnRows(turn); entry = { turn, rows: r, keys: r.map(V.rowKey) }; }
      cache.set(turn.turn_id, entry);
      for (let k = 0; k < entry.rows.length; k += 1) { rows.push(entry.rows[k]); keys.push(entry.keys[k]); }
      turnRowCounts.push({ id: turn.turn_id, count: entry.rows.length }); // U4b: where each turn's rows end
    }
    turnCache = cache;
    const placeholder = log.querySelector('li.empty');
    // F1: the greeting is for a chat with no history at all — never while earlier turns exist (a newest page that is
    // only a lone reply has no whole turn yet, but its cursor says the history is there)
    const empty = !turns.length && !historyBefore;
    const g = empty ? V.emptyGreeting(view) : null;
    const historyLabel = $('chat-history-label'); // T7.3: «Conversación nueva» only while the conversation has no turns
    if (historyLabel) historyLabel.hidden = turns.length > 0 || !!historyBefore;
    if (empty) {
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
      drawn = []; drawnKeys = [];
    } else {
      if (placeholder) { placeholder.remove(); drawn = []; drawnKeys = []; }
      const plan = V.reconcileRows(drawn, rows, drawnKeys, keys);
      const hadRows = drawn.length > 0;
      // U4b: the ask cards live in the log too; the turn rows are reconciled among themselves only
      const els = rowEls();
      for (const { index, row } of plan.patch) paintRow(els[index], row);
      for (let k = 0; k < plan.remove; k += 1) els[els.length - 1 - k].remove();
      for (const row of plan.append) {
        const li = document.createElement('li');
        paintRow(li, row);
        if (hadRows) li.classList.add('enter'); // only NEW rows animate
        log.appendChild(li);
      }
      if (plan.prepend) { // an earlier page: its rows go on top, nothing drawn is repainted
        log.prepend(...plan.prepend.map(row => { const li = document.createElement('li'); paintRow(li, row); return li; }));
      }
      drawn = rows; drawnKeys = keys;
    }
    placeAsks(turnRowCounts);
    if (!turns.length) {
      newer.hidden = true; // nothing left to scroll to (conversation reset)
      following = true;
    } else if (pinned) {
      log.scrollTop = log.scrollHeight;
    } else if (log.scrollHeight > before) {
      setFollowing(false);
    }
  }
  // «Ir al final»: shown while the reader is away from the newest message; the page says so once when the log
  // stops following the newest message and once when it follows it again.
  function setFollowing(next) {
    if (next === following) return;
    following = next;
    newer.hidden = next;
    setLive(next ? 'Estás viendo lo último de la conversación.' : 'Ya no estás viendo lo último. «Ir al final» te lleva abajo.');
  }

  function renderControls() {
    const active = V.activeTurn(view);
    cancel.hidden = !active;
    send.disabled = V.sendState(view, input.value, inFlight, attachments.length).disabled;
    const draftIssue = input.value ? V.draftProblem(input.value) : null;
    const historyProblem = view && view.history_problem;
    problem.textContent = localProblem || pageProblem || historyProblem || draftIssue || '';
    if (loadEarlierButton) { loadEarlierButton.hidden = !historyBefore; loadEarlierButton.disabled = paging; }
    if ($('chat-history-warning')) {
      const warning = historyProblem || (view && view.history_skipped ? `Se omitieron ${view.history_skipped} registros dañados.` : '');
      $('chat-history-warning').hidden = !warning;
      $('chat-history-warning').textContent = warning;
    }
    const availability = view && view.availability ? view.availability.state : 'unchecked';
    capsule.dataset.chatAvailability = availability;
    status.textContent = localProblem || pageProblem || V.statusLine(view);
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

  // ---- K2-05 U4b: the agent's questions inside the chat (Gentle Dot AskCard) ---------------------------------------
  // One card per pending ask (`chat:state.asks`), drawn in the log right after the turn that asked. select = one button
  // per option (arrows move, Enter chooses), confirm = Sí / No, input = a field (Enter sends, the text goes exactly as
  // typed). «Omitir» or Escape cancels. A question is answered ONCE (the card locks at the first answer; Rust refuses a
  // second one too). The card closes when the daemon resolves it (answered here or elsewhere, expired) and keeps its
  // outcome. While the chat is offline a pending card stays visible and waits; the daemon replays it on reconnect.
  const ASK_TRUTH = new Set(['ready', 'busy', 'blocked']); // connected states: the ask list is the daemon's own
  const ASK_KEEP_CLOSED = 16;
  const askRecs = new Map(); // ask id -> { ask, anchor, li, phase: open|sending|closed, sent, problem, closedText, … }
  function rowEls() { return Array.prototype.filter.call(log.children, li => !(li.dataset && li.dataset.askCard)); }
  function askLabel(tag, cls, text) { const n = document.createElement(tag); n.className = cls; n.textContent = text; return n; }
  function askControl(tag, name, rec) {
    const n = document.createElement(tag);
    n.dataset.askControl = name;
    if (tag === 'button') n.type = 'button';
    n.disabled = rec.phase !== 'open' || !!rec.waiting;
    return n;
  }
  function askControls(rec, name) {
    return Array.prototype.filter.call(rec.li.querySelectorAll('[data-ask-control]'), n => !name || n.dataset.askControl === name);
  }
  function firstAskControl(rec) {
    return askControls(rec).find(n => !n.disabled && n.dataset.askControl !== 'options' && (n.dataset.askControl !== 'option' || n.tabIndex === 0)) || null;
  }
  function askSig(rec) {
    const a = rec.ask;
    return JSON.stringify([rec.phase, !!rec.waiting, rec.problem || '', rec.closedText || '', rec.phase === 'closed' ? V.askOutcome(a, rec.sent) : '',
      a.kind, a.title, a.message, a.placeholder, a.options]);
  }
  function paintAsk(rec) {
    const sig = askSig(rec);
    if (rec.paintSig === sig) return; // unchanged: keep the DOM (and the human's focus and typing) as it is
    const hadFocus = rec.li.contains(document.activeElement) ? document.activeElement.dataset.askControl : '';
    rec.paintSig = sig;
    const { li, ask } = rec;
    li.textContent = '';
    li.className = 'ask';
    li.dataset.askCard = ask.id;
    li.dataset.state = rec.phase;
    li.setAttribute('role', 'group');
    if (rec.phase === 'closed') {
      const outcome = rec.closedText || V.askOutcome(ask, rec.sent);
      li.setAttribute('aria-label', V.askClosedAria(ask, outcome));
      li.append(askLabel('p', 'ask-eyebrow', 'Pregunta de Koda'));
      if (ask.title) li.append(askLabel('p', 'ask-title', ask.title));
      li.append(askLabel('p', 'ask-outcome', outcome));
      return;
    }
    li.setAttribute('aria-label', V.askAria(ask));
    li.append(askLabel('p', 'ask-eyebrow', 'Necesita tu respuesta'));
    if (ask.title) li.append(askLabel('p', 'ask-title', ask.title));
    if (ask.message) { // the whole text the human approves; a long one scrolls inside the card
      const m = askLabel('p', 'ask-message', ask.message);
      m.tabIndex = 0; m.setAttribute('aria-label', `Detalles: ${ask.message}`);
      li.append(m);
    }
    if (ask.kind === 'select') {
      const group = document.createElement('div');
      group.className = 'ask-options';
      group.dataset.askControl = 'options';
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', 'Opciones');
      const roving = Math.min(rec.focusIndex || 0, Math.max(0, ask.options.length - 1));
      ask.options.forEach((option, i) => {
        const b = askControl('button', 'option', rec);
        b.textContent = option;
        b.dataset.index = String(i);
        b.tabIndex = i === roving ? 0 : -1;
        b.addEventListener('click', () => sendAsk(rec, { value: option }));
        group.append(b);
      });
      li.append(group);
    } else if (ask.kind === 'confirm') {
      const group = document.createElement('div');
      group.className = 'ask-options';
      for (const [word, confirmed] of [['Sí', true], ['No', false]]) {
        const b = askControl('button', 'confirm', rec);
        b.textContent = word;
        if (confirmed) b.className = 'primary';
        b.addEventListener('click', () => sendAsk(rec, { confirmed }));
        group.append(b);
      }
      li.append(group);
    } else {
      const form = document.createElement('form');
      form.className = 'ask-form';
      const field = askControl('input', 'input', rec);
      field.type = 'text';
      field.value = rec.draft || ''; // what the human typed survives a repaint
      field.maxLength = 8192; // chat.rs ANSWER_MAX_UNITS (UTF-16 units, like maxlength)
      field.placeholder = ask.placeholder || '';
      field.setAttribute('aria-label', ask.title || 'Tu respuesta');
      field.addEventListener('input', () => { rec.draft = field.value; });
      const submit = askControl('button', 'submit', rec);
      submit.type = 'submit';
      submit.className = 'primary';
      submit.textContent = 'Enviar respuesta';
      form.addEventListener('submit', event => { event.preventDefault(); sendAsk(rec, { value: field.value }); });
      form.append(field, submit);
      li.append(form);
    }
    const skip = askControl('button', 'skip', rec);
    skip.className = 'ask-skip';
    skip.textContent = 'Omitir';
    skip.setAttribute('aria-label', 'Omitir la pregunta');
    skip.addEventListener('click', () => sendAsk(rec, { cancelled: true }));
    li.append(skip);
    const note = rec.waiting ? 'Esperando la conexión con Koda…' : rec.phase === 'sending' ? 'Enviando respuesta…' : rec.problem || '';
    if (note) li.append(askLabel('p', 'ask-status', note));
    if (hadFocus) { const again = askControls(rec, hadFocus).find(n => !n.disabled && (hadFocus !== 'option' || n.tabIndex === 0)); if (again) again.focus(); }
  }
  function askKeydown(rec, event) {
    if (event.isComposing || event.keyCode === 229) return; // IME owns the key
    if (rec.phase !== 'open' || rec.waiting) return;
    const target = event.target;
    const role = target && target.dataset ? target.dataset.askControl : '';
    if (event.key === 'Escape') { // the first Escape skips the question, it never collapses the island
      event.preventDefault(); event.stopPropagation();
      sendAsk(rec, { cancelled: true });
      return;
    }
    if (role === 'option') {
      const buttons = askControls(rec, 'option');
      const index = Number(target.dataset.index) || 0;
      if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); sendAsk(rec, { value: rec.ask.options[index] }); return; }
      const next = V.askNextOption(index, buttons.length, event.key);
      if (next < 0) return;
      event.preventDefault();
      rec.focusIndex = next;
      buttons.forEach((b, i) => { b.tabIndex = i === next ? 0 : -1; });
      buttons[next].focus();
    } else if (role === 'input' && event.key === 'Enter') {
      event.preventDefault(); event.stopPropagation();
      sendAsk(rec, { value: target.value });
    }
  }
  function sendAsk(rec, answer) {
    if (rec.phase !== 'open' || rec.waiting || rec.inflight) return; // answered once: a double click sends nothing
    rec.hadFocus = rec.li.contains(document.activeElement);
    rec.phase = 'sending'; rec.inflight = true; rec.sent = answer; rec.problem = '';
    paintAsk(rec);
    if (rec.hadFocus) rec.li.focus(); // the disabled control drops the focus: keep it on the card
    action(V.askPayload(rec.ask.id, answer)).then(() => { rec.inflight = false; }, error => {
      rec.inflight = false;
      const code = error && error.code;
      const message = (error && error.message) || 'No se pudo enviar la respuesta.';
      if (code === 'ask_closed') { removeAsk(rec); setLive(message); return; } // U4b F2: gone, like Gentle Dot
      if (code === 'ask_answered' || rec.phase !== 'sending') return; // already answered: the card waits for its resolution
      rec.phase = 'open'; rec.sent = null; rec.problem = message; rec.seenAnswering = false;
      paintAsk(rec);
      setLive(message);
      if (rec.hadFocus) { const first = firstAskControl(rec); if (first) first.focus(); }
    });
  }
  function closeAsk(rec, closedText) {
    const had = rec.hadFocus || rec.li.contains(document.activeElement);
    rec.phase = 'closed'; rec.waiting = false; rec.closedText = closedText || '';
    paintAsk(rec);
    if (had && capsule.dataset.view === 'chat') input.focus(); // the question is gone: back to the composer
    const closed = [...askRecs.values()].filter(r => r.phase === 'closed');
    for (const old of closed.slice(0, Math.max(0, closed.length - ASK_KEEP_CLOSED))) { old.li.remove(); askRecs.delete(old.ask.id); }
  }
  /** U4b verifier F2: a question that closed without this page's answer being accepted leaves the chat (Gentle Dot). */
  function removeAsk(rec) {
    const had = rec.hadFocus || rec.li.contains(document.activeElement);
    rec.li.remove();
    if (askRecs.get(rec.ask.id) === rec) askRecs.delete(rec.ask.id);
    if (had && capsule.dataset.view === 'chat') input.focus(); // the question is gone: back to the composer
  }
  function clearAsks() {
    for (const rec of askRecs.values()) rec.li.remove();
    askRecs.clear();
  }
  /** Fold the view's pending asks into the cards (before the log is drawn). */
  function syncAsks(next) {
    const list = V.askCards(next);
    const live = new Set(list.map(a => a.id));
    const truth = !!(next.availability && ASK_TRUTH.has(next.availability.state));
    const accepted = V.answeredAsks(next); // U4b F2: the answers from this island the daemon accepted
    const lastId = Array.isArray(next.turns) && next.turns.length ? next.turns[next.turns.length - 1].turn_id : null;
    for (const ask of list) {
      let rec = askRecs.get(ask.id);
      if (!rec) {
        const li = document.createElement('li');
        li.tabIndex = -1;
        rec = { ask, anchor: next.active_turn || lastId, li, phase: 'open', fresh: true };
        const own = rec;
        li.addEventListener('keydown', event => askKeydown(own, event));
        askRecs.set(ask.id, rec);
      } else if (rec.phase === 'closed' && !rec.sent) {
        rec.phase = 'open'; rec.closedText = ''; // a replayed ask the page closed while it reconnected: open again
      }
      rec.ask = ask; rec.waiting = false;
      if (ask.answering && rec.phase !== 'closed') { rec.phase = 'sending'; rec.seenAnswering = true; if (!rec.sent) rec.sent = { answered: true }; }
      else if (rec.phase === 'sending' && !rec.inflight) {
        // the daemon refused the answer, or its write failed (chatclient freed the ask; U4b F3: whether or not
        // this page saw the mark): the card may be answered again
        rec.phase = 'open'; rec.sent = null; rec.seenAnswering = false; rec.problem = 'No se pudo enviar la respuesta.';
      }
      paintAsk(rec);
    }
    for (const rec of askRecs.values()) {
      if (live.has(rec.ask.id) || rec.phase === 'closed') continue;
      if (truth && !accepted.has(rec.ask.id)) removeAsk(rec); // U4b F2: expired, elsewhere, engine restart
      else if (truth) {
        if (!rec.sent) rec.sent = { answered: true };
        closeAsk(rec);
        if (capsule.dataset.view === 'chat') setLive(V.askOutcome(rec.ask, rec.sent));
      } else if (!rec.waiting) { rec.waiting = true; paintAsk(rec); } // offline: the daemon replays it on reconnect
    }
  }
  /** Put each card right after the last row of the turn that asked (only the nodes out of place move). */
  function placeAsks(turnRowCounts) {
    if (!askRecs.size) return;
    const focused = document.activeElement;
    const recs = [...askRecs.values()];
    const rowsNow = rowEls();
    const desired = [], placed = new Set();
    let at = 0;
    for (const { id, count } of turnRowCounts) {
      for (let k = 0; k < count && at < rowsNow.length; k += 1) desired.push(rowsNow[at++]);
      for (const rec of recs) if (rec.anchor === id) { desired.push(rec.li); placed.add(rec); }
    }
    while (at < rowsNow.length) desired.push(rowsNow[at++]);
    for (const rec of recs) if (!placed.has(rec)) desired.push(rec.li);
    for (let i = 0; i < desired.length; i += 1) if (log.children[i] !== desired[i]) log.insertBefore(desired[i], log.children[i] || null);
    if (focused && document.activeElement !== focused && recs.some(r => r.li.contains(focused))) focused.focus({ preventScroll: true });
  }
  /** A new card is scrolled into view and announced; it takes the focus unless the human is typing. */
  function presentAsks() {
    const fresh = [...askRecs.values()].filter(r => r.fresh);
    if (!fresh.length) return;
    for (const rec of fresh) { rec.fresh = false; if (rec.li.scrollIntoView) rec.li.scrollIntoView({ block: 'nearest' }); }
    if (capsule.dataset.view !== 'chat') return;
    const first = fresh.find(r => r.phase === 'open' && !r.waiting);
    if (!first) return;
    setLive(V.askAria(first.ask));
    const active = document.activeElement;
    const typing = active === input || !!(active && active.dataset && active.dataset.askControl === 'input');
    if (!typing) { const control = firstAskControl(first); if (control) control.focus(); }
  }
  // ---- end U4b

  function resetHistory(next) {
    olderTurns = []; historyBefore = next.history_before || null; historyGeneration += 1; paging = false;
    runStarted = false; autoFor = null; pageProblem = ''; clearTimeout(pageTimer); pageTimer = 0; pendingPage = null;
    log.textContent = ''; drawn = []; drawnKeys = []; turnCache = new Map();
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
      if (view) { input.value = ''; pendingId = null; localProblem = ''; autosize(); discardAll(); clearAsks(); }
    }
    restoreRefused(next);
    syncAsks(next); // U4b: the agent's questions (from `next` only), placed by renderLog after the turn that asked
    followWindow(next);
    view = next;
    reportHeight();
    renderTarget();
    renderLog();
    renderControls();
    renderModelRow();
    scheduleCheck();
    if (capsule.dataset.view === 'chat') setLive(said);
    presentAsks();
    autoPage();
    // #313: turns and the model going down become cues by TRANSITION (history and the first snapshot are baselines)
    try { const w = window.AbitoSoundWiringInstance; if (w) w.observeChat(next); } catch { /* sound never breaks the chat */ }
  }

  // ---- K2-05 T4 S2: load earlier turns (Gentle Dot's `get_earlier`) ---------------------------
  // While nothing older is loaded the cursor follows the host's `history_before`; once a page is loaded it is the
  // cursor that page returned (the daemon's position of the run's first turn), so a page is only ever asked for
  // the turns right above the run: it always joins it. Turns that slide out of the live window stay in the run.
  function followWindow(next) {
    if (!runStarted) { historyBefore = next.history_before || null; return; }
    const left = V.leftWindow(view && view.turns, next.turns);
    if (left.length) olderTurns = olderTurns.concat(left);
  }
  // Every page request — scroll, «Cargar anteriores» (F3) or the one extra after an empty page (F2) — is coalesced:
  // at most one request per V.PAGE_GAP_MS, never two in flight. A press while a request is pending upgrades it to
  // a control request (it no longer needs the reader at the top).
  function schedulePage(mode, extra) {
    if (paging || !historyBefore) return;
    if (pageTimer) { if (mode === 'control' && pendingPage) pendingPage = { mode, extra: false }; return; }
    const wait = V.pageWait(Date.now(), lastPage);
    if (!wait) { loadOlder(mode, extra); return; }
    pendingPage = { mode, extra: !!extra };
    pageTimer = setTimeout(() => { pageTimer = 0; const p = pendingPage; pendingPage = null; if (p) loadOlder(p.mode, p.extra); }, wait);
  }
  // F1: the newest page held only a lone reply (no whole turn, history behind it): ask for the ONE earlier page that
  // holds its prompt, by itself — once per cursor, before any page was loaded, never a loop.
  function autoPage() {
    if (runStarted || paging || !view || !historyBefore || autoFor === historyBefore) return;
    if (Array.isArray(view.turns) && view.turns.length) return;
    autoFor = historyBefore;
    loadOlder('auto', true);
  }
  // mode: 'scroll' (the reader is at the top), 'control' («Cargar anteriores»), 'auto' (F1). `extra` = this request
  // is already the one follow-up a user action may get (F2), or needs none.
  function loadOlder(mode, extra) {
    if (!view || !historyBefore || paging || log.inert || (mode === 'scroll' && log.scrollTop > 8)) return;
    paging = true;
    lastPage = Date.now();
    renderControls();
    const id = view.conversation_id, generation = historyGeneration, cursor = historyBefore;
    const height = log.scrollHeight, top = log.scrollTop;
    let again = false;
    action({ action: 'history', conversation_id: id, before: cursor }).then(page => {
      if (!view || view.conversation_id !== id || generation !== historyGeneration || cursor !== historyBefore) return;
      const had = olderTurns.length;
      olderTurns = V.mergeHistory(page.turns, olderTurns);
      historyBefore = page.before || null;
      runStarted = true;
      pageProblem = ''; // F7: a page loaded, the earlier failure is over
      if (page.skipped) view.history_skipped = page.skipped;
      renderLog(); renderControls();
      log.scrollTop = top + log.scrollHeight - height; // keep the same message under the reader's eye
      // F2: a page that added no rows leaves the reader where it was (no new scroll event): the next page is asked
      // for once more by itself, inside the same rate limit — at most one extra per user action
      again = !extra && olderTurns.length === had && !!historyBefore;
      if (mode === 'control') {
        setLive(historyBefore ? 'Mensajes anteriores cargados.' : 'Mensajes anteriores cargados. Es el comienzo del chat.');
        if (!historyBefore) log.focus(); // the control went away: keep keyboard users in the history
      }
    }, error => {
      if (generation !== historyGeneration) return;
      pageProblem = (error && error.message) || 'No se pudo cargar el historial anterior.'; renderControls(); setLive(pageProblem);
    }).finally(() => {
      if (generation !== historyGeneration) return;
      paging = false; renderControls();
      if (again) schedulePage(mode, true);
    });
  }
  if (loadEarlierButton) loadEarlierButton.addEventListener('click', () => schedulePage('control', false));

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

  // ---- K2-05 attachments (L11 2a, like Gentle Dot) ---------------------------
  // Any file. A dropped path goes to `chat_attach` (Rust reads it only when the OS reported it
  // dropped on the island), a picked or pasted file as raw bytes (`chat_attach_data`: one-line JSON
  // header, LF, file bytes). Rust hands the file to the DAEMON, which stores it in the engine
  // workspace and answers its own opaque id; the composer only holds that id plus the chip
  // (name, size). The ids ride with the next submit; a removed chip asks the daemon to delete its
  // file. Gentle Dot's limits are checked here first (the daemon enforces them again): a refused
  // file is read by nobody, sent nowhere and shows no chip.
  // files per message: chat.rs MAX_ATTACHMENTS_PER_TURN (5, pinned by chat_tests.rs) — stricter than
  // Gentle Dot's 10; the daemon counts the same 5 (uploads.cjs ATTACHMENT_LIMITS.files) and its
  // refusal says «hasta 5»; raising it needs chat.rs, uploads.cjs and their tests together.
  const ATTACH_MAX = 5;
  const ATTACH_FILE_BYTES = 25 * 1024 * 1024;    // per file
  const ATTACH_MESSAGE_BYTES = 50 * 1024 * 1024; // together
  const ATTACH_TOO_LARGE = 'El archivo es demasiado grande: hasta 25 MB por archivo.';
  const ATTACH_TOO_LARGE_TOGETHER = 'Los archivos juntos son demasiado grandes: hasta 50 MB por mensaje.';
  const PAPERCLIP_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M13.5 7l-5.2 5.2a1.8 1.8 0 0 0 2.5 2.5l5.7-5.7a4 4 0 0 0-5.7-5.7L5 9.1a6.2 6.2 0 0 0 8.8 8.8"/></svg>';
  const ATTACH_TOO_MANY = 'Demasiados archivos: hasta 5 por mensaje.';
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
        renderControls();
        // the daemon deletes the unsent file it stored for this island (only its own id can name it)
        action({ action: 'discard', id: a.id }).catch(() => {});
      });
      chip.append(name, size, remove);
      attachStrip.append(chip);
    }
    if (attachError) attachStrip.append(...errorChip());
  }
  // A refusal is cleared by an attach STARTED after it, never by one already on its way (several
  // files picked at once: the over-limit one must stay explained while the others finish).
  let refusals = 0;
  function refuse(name, error) {
    refusals += 1;
    const reason = (error && error.message) || 'No se pudo adjuntar el archivo.';
    attachError = { name: String(name || '').slice(0, 80) || 'archivo', reason };
    renderAttachments();
    setLive(reason);
  }

  function addAttachment(att, since) {
    if (!att || typeof att.id !== 'string' || typeof att.name !== 'string') return;
    if (since === undefined || since === refusals) attachError = null;
    if (attachments.some(other => other.id === att.id)) return;
    attachments.push({
      id: att.id,
      name: att.name,
      mime: typeof att.mime === 'string' ? att.mime : '',
      size: att.size,
    });
    renderAttachments();
    renderControls();
    setLive(`${att.name} adjuntado. Se envía con el próximo mensaje.`);
  }

  // Files on their way to the daemon count toward the limits too (picked several at once).
  let attaching = 0, attachingBytes = 0;
  const heldBytes = () => attachments.reduce((sum, a) => sum + (Number(a.size) || 0), 0) + attachingBytes;
  /** Gentle Dot's useAttachments checks, in Spanish: null when the file may go to the daemon. */
  function overLimit(size) {
    if (attachments.length + attaching >= ATTACH_MAX) return ATTACH_TOO_MANY;
    if (Number.isFinite(size) && size > ATTACH_FILE_BYTES) return ATTACH_TOO_LARGE;
    if (Number.isFinite(size) && heldBytes() + size > ATTACH_MESSAGE_BYTES) return ATTACH_TOO_LARGE_TOGETHER;
    return null;
  }

  // K2-05 follow-up: chips the page drops without sending ask the daemon to delete their unsent
  // files (no quota lingers until the one-hour expiry); a conversation change is such a drop.
  function discardAll() {
    const gone = attachments;
    attachments = []; attachError = null; sentFiles = null;
    renderAttachments();
    for (const a of gone) action({ action: 'discard', id: a.id }).catch(() => {});
  }
  // K2-05 follow-up: the files of an ACCEPTED submit wait here until its turn ends. A turn the
  // daemon refused (it ends in an error, nothing ran, no reply) never spent them: the chips come
  // back to the composer so the user can resend the same files. A turn that ran, was interrupted
  // (the engine may have taken it) or whose files are gone keeps nothing.
  const SPENT_CODES = new Set(['interrupted', 'attachment_not_found']);
  let sentFiles = null; // { turnId, files }
  function restoreRefused(next) {
    if (!sentFiles || !next || !Array.isArray(next.turns)) return;
    const turn = next.turns.find(t => t && t.turn_id === sentFiles.turnId);
    if (!turn || turn.state === 'thinking' || turn.state === 'streaming' || turn.state === 'live') return;
    const files = sentFiles.files;
    sentFiles = null;
    const code = turn.error && turn.error.code;
    if (turn.state !== 'error' || String(turn.reply || '') !== '' || !code || SPENT_CODES.has(code)) return;
    for (const f of files) {
      if (attachments.some(a => a.id === f.id)) continue;
      if (attachments.length >= ATTACH_MAX) { action({ action: 'discard', id: f.id }).catch(() => {}); continue; }
      attachments.push(f);
    }
    renderAttachments();
    setLive('Los archivos adjuntos siguen listos para enviar.');
  }

  async function attachPath(path) {
    if (typeof path !== 'string' || !path) return;
    const over = overLimit(NaN);
    if (over) { refuse(path.split(/[\\/]/).pop(), { message: over }); return; }
    attaching += 1;
    const since = refusals;
    try {
      addAttachment(await call('chat_attach', { path }), since);
    } catch (error) {
      refuse(path.split(/[\\/]/).pop(), error);
    } finally {
      attaching -= 1;
    }
  }

  async function attachPicked(file) {
    if (!file || typeof file.name !== 'string') return;
    const size = Number(file.size);
    const over = overLimit(size);
    if (over) { refuse(file.name, { message: over }); return; }
    attaching += 1;
    attachingBytes += Number.isFinite(size) ? size : 0;
    const since = refusals;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const header = new TextEncoder().encode(`${JSON.stringify({ name: file.name })}\n`);
      const body = new Uint8Array(header.length + bytes.length);
      body.set(header, 0);
      body.set(bytes, header.length);
      addAttachment(await invoke('chat_attach_data', body), since);
    } catch (error) {
      refuse(file.name, error);
    } finally {
      attaching -= 1;
      attachingBytes -= Number.isFinite(size) ? size : 0;
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
  // K2-05 (Gentle Dot Composer onPaste): a pasted image becomes an attachment; pasted text stays text.
  input.addEventListener('paste', event => {
    const files = Array.prototype.slice.call((event.clipboardData && event.clipboardData.files) || []);
    const images = files.filter(f => f && typeof f.type === 'string' && f.type.startsWith('image/'));
    if (!images.length) return;
    event.preventDefault();
    for (const image of images) attachPicked(image);
  });
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
    if (!V.canSend(view, input.value, inFlight, attachments.length) || attaching > 0) {
      // the disc is live for a non-empty draft: say why nothing was sent instead of staying silent
      const why = (attaching > 0 && 'Todavía se está adjuntando un archivo.') || V.sendState(view, input.value, inFlight, attachments.length).blocked || V.draftProblem(input.value);
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
    const sending = attachments.slice();
    action(payload).then(
      answer => {
        inFlight = false;
        pendingId = null;
        if (input.value === text) { input.value = ''; autosize(); } // accepted: the draft became a turn
        // the files went with the turn; kept aside until it ends, in case the daemon refuses it
        sentFiles = sending.length && answer && typeof answer.turn_id === 'string' ? { turnId: answer.turn_id, files: sending } : null;
        if (sending.length) attachments = attachments.filter(a => !sending.some(f => f.id === a.id));
        if (sending.length || attachError) { attachError = null; renderAttachments(); }
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
    setFollowing(true);
  });
  log.addEventListener('scroll', () => {
    if (log.scrollTop <= 8) schedulePage('scroll', false);
    setFollowing(V.atBottom(log.scrollTop, log.scrollHeight, log.clientHeight));
  });

  // ---- keyboard: Enter opens from the overview, Escape steps out -----------
  document.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    const expanded = capsule.dataset.phase === 'expanded';
    const inChat = capsule.dataset.view === 'chat';
    const typing = document.activeElement === input;
    if (event.key === 'Escape') {
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
