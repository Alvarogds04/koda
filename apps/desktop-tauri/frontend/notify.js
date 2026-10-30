'use strict';
/* N6 — the notification surface (Pi question with 1..N reply options).
   - Talks to Rust ONLY through `question_action` with the closed set
     view / answer{id,index} / text{id,text} / decline{id} / budget{id,text}.
     It never names a route, a wire token, a scope or a session, and sends no
     label back: the host maps the index to the emitted option.
   - Only a TRUSTED human gesture (event.isTrusted === true) on this view's own
     controls or the digits 1..N answers. No timer, rule or model output ever
     does. Escape only leaves the free-text field; it never declines.
   - Plain text only (textContent). Nothing is persisted in the page.
   - SILENCE: no audio exists. Sound cues are pure ids (N.soundFor) and stay
     unplayed until the human enables sound in a future setting.
   - #266: a NEW question is a reveal event dispatched through `abito:question`
     (the gate is the pure N.createRevealGate); a boot replay of the same
     pending is history and never reveals. Revealing opens the island — it is
     never an answer and never touches the trusted-input rules above. */
(() => {
  const N = window.AbitoNotify;
  const ICONS = window.AbitoIcons;
  const $ = id => document.getElementById(id);
  const root = $('question');
  const capsule = $('capsule');
  if (!N || !root || !ICONS) return;
  const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)
    || (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) || null;
  const listen = (window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen) || null;
  const action = payload => (invoke ? invoke('question_action', { payload }) : Promise.reject(new Error('no ipc')));
  const icon = name => ICONS.svg(name);
  // Icons are DOM NODES parsed from the CLOSED own registry's literal markup (never data), like island.js: no markup sink in this file.
  const svgParser = typeof DOMParser === 'function' ? new DOMParser() : null;
  function putIcon(host, name) {
    if (!host) return;
    const markup = icon(name);
    const parsed = svgParser && markup ? svgParser.parseFromString(markup, 'image/svg+xml').documentElement : null;
    const nodes = parsed && parsed.nodeName === 'svg' ? [document.importNode(parsed, true)] : [];
    if (typeof host.replaceChildren === 'function') host.replaceChildren(...nodes); else host.textContent = '';
  }
  for (const el of root.querySelectorAll('[data-icon]')) putIcon(el, el.dataset.icon);

  const body = $('question-body');
  const optionsEl = $('question-options');
  const freeform = $('question-freeform');
  const textEl = $('question-text');
  const wordEl = $('question-word');
  const sendEl = $('question-send');
  const skipEl = $('question-skip');
  const live = $('question-live');
  const expiryEl = $('question-expiry');
  const stateEl = $('question-state');
  const askerName = $('question-asker-name');
  const queueEl = $('question-queue');
  const stepEl = $('question-step'), stepHeader = $('question-step-header'), summaryEl = $('question-summary');
  const navEl = $('question-nav'), prevEl = $('question-prev'), primaryEl = $('question-primary');
  // structured answers: the wizard state for a questionnaire, the draft for a multi-select (both die with the question)
  let wizard = null, multiDraft = N.newDraft(), structuredId = null;

  let expiryTimer = null;
  function syncExpiryTimer() {
    const pending = snapshot && N.fromPending(snapshot.pending);
    const active = pending && Date.now() < pending.expiresAt;
    if (active && expiryTimer === null) expiryTimer = setInterval(() => render(), 5000);
    else if (!active && expiryTimer !== null) { clearInterval(expiryTimer); expiryTimer = null; }
  }
  let snapshot = null;
  let previous = null;
  let inFlight = false;
  let budget = null;
  let budgetSeq = 0;
  let renderedId = null;
  const limiter = N.createCueLimiter();
  const revealGate = N.createRevealGate ? N.createRevealGate() : null;

  const say = text => { if (text) { live.textContent = ''; requestAnimationFrame(() => { live.textContent = text; }); } };
  const el = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text) n.textContent = text; return n; };

  // D1 (human ruling): a finished question outcome is a CONFIRMATION, not a state. It shows for
  // OUTCOME_MS (3 s; 4 s for the problem outcomes the host marks persistent) and then the island
  // returns to its previous view by itself. The host keeps `notice` in its snapshot; only a NEW
  // outcome (a question that was pending is gone, or the notice word changed) restarts the clock.
  const OUTCOME_MS = 3000, OUTCOME_PROBLEM_MS = 4000;
  let outcomeKey = null, outcomeUntil = 0, outcomeTimer = 0, outcomeAgent = ''; // HU-075: who asked the question that just went away («<Agente> sigue con tu respuesta»)
  function trackOutcome(prev, next) {
    const view = N.phase(next, { inFlight: false, now: Date.now() });
    if (view.kind !== 'outcome') { outcomeKey = null; outcomeUntil = 0; outcomeAgent = ''; return; }
    const word = view.outcome.outcome;
    const before = prev ? N.fromPending(prev.pending) : null;
    if (before) outcomeAgent = N.askerName(before);
    const fresh = !!before || (prev && prev.notice !== next.notice) || (outcomeKey !== null && outcomeKey !== word);
    if (fresh) {
      outcomeKey = word;
      outcomeUntil = Date.now() + (view.outcome.persistent ? OUTCOME_PROBLEM_MS : OUTCOME_MS);
      clearTimeout(outcomeTimer);
      outcomeTimer = setTimeout(() => render(), outcomeUntil - Date.now() + 30);
    } else if (outcomeKey === null) { outcomeKey = word; outcomeUntil = 0; } // boot replay: history, never shown
  }
  function current() {
    const view = N.phase(snapshot, { inFlight, now: Date.now() });
    if (view.kind === 'outcome' && Date.now() >= outcomeUntil) return { kind: 'none', controlsEnabled: false };
    return view;
  }
  // Every answering path (click, key, text, skip) requires the notification to be
  // visible: expanded + overview + no covering card. Hidden never answers.
  const onScreen = () => N.onScreen({ phase: capsule.dataset.phase, view: capsule.dataset.view, card: capsule.dataset.card });

  // ---- the options: ONE vertical numbered list for every question (human: «Pregunta / 1. respuesta / 2. respuesta / N. otra cosa») ----
  // plain question: a row answers at once; multi-select: rows are checkboxes + «Hecho»; questionnaire: one question per step with
  // Anterior / Siguiente and a final summary. The LAST row is «N. Otra cosa…» when the question takes free text: selecting it
  // reveals the growing textarea inline; Enter sends, Esc closes it.
  const isStructured = n => !!(n && (n.form || n.multiSelect));
  const stepItem = n => (n.form ? (wizard && !wizard.review ? n.form[wizard.step] : null) : (n.multiSelect ? multiItemOf(n) : N.singleItem(n)));
  const multiItemOf = n => ({ header: '', text: n.text, options: n.options, multiSelect: true, allowFreeText: n.allowFreeText });
  const stepDraft = n => (n.form ? (wizard && !wizard.review ? wizard.drafts[wizard.step] : null) : multiDraft);
  const setStepDraft = (n, draft) => { if (n.form) wizard = { ...wizard, drafts: wizard.drafts.map((d, i) => (i === wizard.step ? draft : d)) }; else multiDraft = draft; };
  // E: a permission request (harness «asks permission», or Pi's kind=approval with two labels) wears the approval look instead of a
  // numbered list. It is the SAME answer path: the buttons send the option index through choose().
  const approvalEl = $('question-approval');
  const layout = () => window.AbitoIslandLayout;
  const approvalOf = n => (layout() && n ? layout().approvalView(n, N.askerName(n)) : null);
  function renderApproval(n, view) {
    const a = approvalOf(n);
    const on = !!a && !isStructured(n);
    approvalEl.hidden = !on;
    root.dataset.look = on ? 'approval' : '';
    if (!on) return false;
    $('question-approval-title').textContent = a.title;
    const cmd = $('question-approval-cmd'); cmd.textContent = a.command; cmd.title = a.command;
    $('question-approval-note').hidden = !a.secretsHidden;
    const box = $('question-approval-actions'); box.textContent = '';
    for (const act of a.actions) {
      const b = el('button', `q-approval-btn q-${act.role}`);
      b.type = 'button'; b.disabled = !view.controlsEnabled; b.dataset.index = String(act.index);
      b.append(el('span', 'q-label', act.label), el('span', 'q-kbd', act.key));
      b.setAttribute('aria-label', `${act.label} (${act.key})`);
      b.setAttribute('aria-keyshortcuts', act.key);
      b.addEventListener('click', event => choose(event, act.index));
      box.append(b);
    }
    return true;
  }
  let rowsKey = '';
  function rowNode(r, enabled) {
    const b = el('button', r.kind === 'other' ? 'q-option q-other' : 'q-option');
    b.type = 'button'; b.disabled = !enabled; b.dataset.number = String(r.number); b.dataset.kind = r.kind;
    if (r.kind === 'option') b.dataset.index = String(r.index);
    // EVERY row says whether it is chosen, without hover: a checkbox row is role=checkbox, a single-choice row of a questionnaire step is a
    // radio (the chosen option showed only the hover highlight before; it only appeared in the final summary)
    const inStep = r.control === 'row' && !!(snapshot && N.fromPending(snapshot.pending) && (N.fromPending(snapshot.pending).form || N.fromPending(snapshot.pending).multiSelect));
    b.dataset.selected = r.checked ? 'true' : 'false';
    if (r.control === 'checkbox') { b.setAttribute('role', 'checkbox'); b.setAttribute('aria-checked', r.checked ? 'true' : 'false'); b.append(el('span', 'q-box')); }
    else if (inStep && r.kind === 'option') { b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', r.checked ? 'true' : 'false'); b.append(el('span', 'q-dot')); }
    else if (r.kind === 'other') b.setAttribute('aria-expanded', r.checked ? 'true' : 'false');
    b.append(el('span', 'q-key', `${r.number}.`), el('span', 'q-label', r.label));
    if (r.description) b.append(el('span', 'q-desc', r.description));
    b.setAttribute('aria-label', r.description ? `${r.number}. ${r.label}. ${r.description}` : `${r.number}. ${r.label}`);
    b.setAttribute('aria-keyshortcuts', String(r.number));
    b.title = r.label;
    b.addEventListener('click', event => activateRow(event, r));
    return b;
  }
  function renderOptions(n, enabled) {
    if (renderApproval(n, { controlsEnabled: enabled })) { rowsKey = ''; optionsEl.textContent = ''; return; }
    const item = stepItem(n), draft = stepDraft(n);
    if (!item) { rowsKey = ''; optionsEl.textContent = ''; if (n.form && wizard && wizard.review) renderSummary(n); return; }
    const model = N.optionRows(item, draft);
    // rebuilt only when what it shows changes: a rebuild between mouse-down and mouse-up would swallow the click
    const key = [n.id, n.form ? wizard.step : 0, enabled, model.rows.map(r => `${r.checked ? 1 : 0}${r.label}`).join('|')].join(':');
    if (key === rowsKey) return;
    rowsKey = key;
    const focused = optionsEl.contains && optionsEl.contains(document.activeElement) ? document.activeElement.dataset && document.activeElement.dataset.number : null;
    optionsEl.textContent = '';
    for (const r of model.rows) optionsEl.append(rowNode(r, enabled));
    if (focused && optionsEl.querySelectorAll) { const back = [...optionsEl.querySelectorAll('button')].find(b => b.dataset.number === focused); if (back) back.focus(); }
  }
  function renderSummary(n) {
    const v = N.formView(n, wizard);
    summaryEl.textContent = '';
    for (const row of v.summary) {
      const r = el('div', 'q-sum-row'); r.setAttribute('role', 'listitem');
      r.append(el('strong', 'q-sum-head', row.header || row.text), el('span', 'q-sum-text', row.header ? row.text : ''), el('span', 'q-sum-answer', row.answer));
      summaryEl.append(r);
    }
  }
  // one row was activated (trusted click, or the digit that names it)
  function activateRow(event, r) {
    const n = snapshot && N.fromPending(snapshot.pending);
    if (!n || !N.trusted(event) || !onScreen()) return;
    const item = stepItem(n);
    if (!item) return;
    if (r.kind === 'other') { toggleOtherRow(n); return; }
    if (!isStructured(n)) { choose(event, r.index); return; } // plain question: a row IS the answer
    pick(r.index);
  }
  function pick(index) {
    const n = snapshot && N.fromPending(snapshot.pending);
    if (!n || !onScreen()) return;
    if (n.form) wizard = N.formReduce(n, wizard, { type: 'toggle', index });
    else multiDraft = N.toggleOption(stepItem(n), multiDraft, index);
    render();
  }
  function toggleOtherRow(n) {
    const item = stepItem(n);
    if (!item || !item.allowFreeText) return;
    const draft = stepDraft(n), next = N.toggleOther(item, draft);
    setStepDraft(n, next);
    if (!next.other) textEl.value = '';
    render();
    if (next.other) textEl.focus(); else { const row = optionsEl.querySelectorAll ? [...optionsEl.querySelectorAll('button')].find(b => b.dataset.kind === 'other') : null; if (row) row.focus(); }
  }
  function paintCard(n, view) {
    const structured = isStructured(n);
    stepEl.hidden = !(structured && n.form); summaryEl.hidden = !(structured && n.form && wizard && wizard.review);
    navEl.hidden = !structured;
    textEl.maxLength = n ? n.freeTextMax : 2000;
    const item = n ? stepItem(n) : null, draft = n ? stepDraft(n) : null;
    const showText = !!(item && N.optionRows(item, draft).showText);
    freeform.hidden = !showText;
    if (n && n.form) {
      const v = N.formView(n, wizard);
      stepHeader.textContent = v.mode === 'review' ? v.label : `${v.stepText}${v.header ? ` · ${v.header}` : ''}`;
      // S8: progress dots (decoration) next to the text «Paso N de M»; Atrás keeps every answer (drafts)
      let dotsEl = $('question-dots');
      if (!dotsEl) { dotsEl = document.createElement('span'); dotsEl.id = 'question-dots'; dotsEl.setAttribute('aria-hidden', 'true'); stepEl.append(dotsEl); }
      dotsEl.replaceChildren(...(v.dots || []).map(d => { const i = document.createElement('i'); i.dataset.state = d; return i; }));
      body.textContent = v.mode === 'review' ? 'Revisá tus respuestas antes de enviarlas.' : v.text;
      body.title = body.textContent;
      prevEl.hidden = !v.canPrev; prevEl.disabled = !view.controlsEnabled || !v.canPrev;
      primaryEl.textContent = v.primary.label; primaryEl.dataset.kind = v.primary.kind;
      primaryEl.disabled = !view.controlsEnabled || !v.primary.enabled;
    } else if (n && n.multiSelect) {
      const v = N.multiView(n, multiDraft);
      prevEl.hidden = true;
      primaryEl.textContent = v.label; primaryEl.dataset.kind = 'done'; primaryEl.disabled = !view.controlsEnabled || !v.canDone;
      // v8 S7: the reason is visible text beside the disabled button (and its accessible description), gone once it can be pressed
      const why = $('question-reason'); if (why) { why.textContent = v.reason || ''; why.hidden = !v.reason; }
      if (v.reason) primaryEl.setAttribute('aria-description', v.reason); else primaryEl.removeAttribute('aria-description');
      primaryEl.removeAttribute('title');
    }
    if (item && showText && textEl.value !== draft.text && document.activeElement !== textEl) { textEl.value = draft.text; growText(); } // each step keeps its own draft
  }
  // The keyboard context for whatever question is on screen.
  function keyContext(n) {
    const item = stepItem(n), draft = stepDraft(n);
    const structured = isStructured(n);
    let primary, canPrev = false, review = false;
    if (n.form) { const v = N.formView(n, wizard); primary = v.primary; canPrev = v.canPrev; review = v.mode === 'review'; }
    else if (n.multiSelect) primary = { kind: 'done', enabled: N.multiView(n, multiDraft).canDone };
    else primary = { kind: 'text', enabled: !sendEl.disabled && !freeform.hidden };
    return { typing: document.activeElement === textEl, optionCount: item ? item.options.length : 0, hasOther: !!(item && item.allowFreeText),
      review, canPrev, otherOpen: !!(draft && draft.other), primary, structured };
  }
  function cardKey(event) {
    const n = snapshot && N.fromPending(snapshot.pending);
    const view = current();
    if (!n || !view.controlsEnabled || root.inert || !onScreen()) return false;
    const ctx = keyContext(n);
    const intent = N.keyIntent(event, ctx);
    if (!intent) return false;
    event.preventDefault(); event.stopPropagation();
    runIntent(event, n, intent);
    return true;
  }
  function moveFocus(delta) {
    const rows = optionsEl.querySelectorAll ? [...optionsEl.querySelectorAll('button')] : [];
    if (!rows.length) return;
    const at = rows.indexOf(document.activeElement);
    rows[(at < 0 ? (delta > 0 ? 0 : rows.length - 1) : (at + delta + rows.length) % rows.length)].focus();
  }
  function runIntent(event, n, intent) {
    const item = stepItem(n);
    if (intent.type === 'toggle') {
      const o = item && item.options[intent.index];
      if (o) activateRow(event, { kind: 'option', index: o.index });
      return;
    }
    if (intent.type === 'other') { toggleOtherRow(n); return; }
    if (intent.type === 'move') { moveFocus(intent.delta); return; }
    if (intent.type === 'next' || intent.type === 'back' || intent.type === 'prev') { wizard = N.formReduce(n, wizard, { type: intent.type }); render(); return; }
    if (intent.type === 'text') { if (!sendEl.disabled) freeform.requestSubmit(); return; }
    if (intent.type === 'done') sendStructured(event, N.manyPayload(n, multiDraft));
    if (intent.type === 'send') sendStructured(event, N.formPayload(n, wizard));
  }
  function sendStructured(event, payload) {
    if (!N.trusted(event) || !onScreen() || !payload) return;
    const view = current();
    if (!view.notification || !view.controlsEnabled) return;
    const sent = pushSeq;
    inFlight = true; render();
    action(payload).then(next => finish(next, sent), error => { finish(null, sent); say((error && error.message) || 'No se pudo enviar.'); });
  }

  // Flash fix V2: the auto-return is a CROSS-fade. The overview layers normally enter after a 160ms delay
  // (the island grows first); right after an outcome that delay left a dark gap, so `data-crossfade`
  // cancels it for one enter duration (read from the --dur-view-in token, never a literal).
  let outcomeOnScreen = false, crossfadeTimer = 0;
  function crossfade() {
    const raw = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dur-view-in'));
    capsule.dataset.crossfade = 'true';
    clearTimeout(crossfadeTimer);
    crossfadeTimer = setTimeout(() => { delete capsule.dataset.crossfade; }, (Number.isFinite(raw) ? raw : 400) + 100);
  }
  let shownSent = null;
  function announceShown() {
    const show = !!capsule.dataset.question;
    if (show === shownSent) return;
    shownSent = show;
    document.dispatchEvent(new CustomEvent('abito:question', { detail: { pending: !!(snapshot && N.fromPending(snapshot.pending)), show, reveal: false } }));
  }
  function render() {
    syncExpiryTimer();
    const view = current();
    const n = view.notification || null;
    if (outcomeOnScreen && view.kind !== 'outcome' && !n) crossfade();
    outcomeOnScreen = view.kind === 'outcome';
    const showing = !!n && onScreen();
    const outcome = view.outcome || null;
    root.inert = !(showing || (outcome && capsule.dataset.view === 'overview'));
    capsule.dataset.question = n ? (view.kind === 'expired' ? 'expired' : 'pending') : (outcome ? 'outcome' : '');
    // S2 (abito-avisos-ux): which outcome is on screen, so the island can make Abito react to it (presentation only)
    const word = !n && outcome ? outcome.outcome : '';
    if ((capsule.dataset.outcome || '') !== word) { if (word) capsule.dataset.outcome = word; else delete capsule.dataset.outcome; }
    // The island's «a question is shown» flag (height, mascot position, «?» badge) used to be told only when a snapshot ARRIVED. The
    // «Recibida» timer and the local expiry clear data-question from render() alone, so the flag stayed true: the island kept its
    // 200px height with the mascot 26px lower and the «?» badge (screen gate). Every change of data-question now tells it.
    announceShown();
    if (n) {
      if (renderedId !== n.id) {
        renderedId = n.id; textEl.value = ''; budget = null; multiDraft = N.newDraft(); wizard = n.form ? N.formStart(n) : null; rowsKey = '';
        say(`${N.askedBy(n)}: ${n.text}`);
      }
      body.textContent = n.text;
      renderOptions(n, view.controlsEnabled); // keyed: rebuilt only when what it shows changes
      // #266 S2: the visible asker, slug-derived via textContent only; display-only,
      // so a page without the chip must still answer (same guard style as island.js).
      if (askerName) askerName.textContent = N.askerLine(n); // Coucou's who-row: bold name + «pregunta» (askedBy stays the announcement text)
      if (queueEl) { queueEl.textContent = N.queueLabel(snapshot); queueEl.hidden = !queueEl.textContent; }
      body.title = n.text; // the full text stays reachable when the view cuts it to two lines
      for (const b of optionsEl.querySelectorAll('button')) b.disabled = !view.controlsEnabled;
      skipEl.disabled = !view.controlsEnabled;
      expiryEl.hidden = false;
      $('question-expiry-word').textContent = N.expiryWord(n.expiresAt, Date.now());
      expiryEl.setAttribute('aria-label', `Vence en ${N.expiryWord(n.expiresAt, Date.now())}`);
      expiryEl.dataset.tone = view.kind === 'expired' ? 'faint' : 'sun';
    } else {
      renderedId = null; rowsKey = ''; body.textContent = ''; if (askerName) askerName.textContent = ''; if (queueEl) { queueEl.textContent = ''; queueEl.hidden = true; } optionsEl.textContent = ''; freeform.hidden = true; expiryEl.hidden = true; skipEl.disabled = true;
    }
    paintCard(n, view);
    skipEl.hidden = !n; // no pending notification: nothing to skip (outcome states show only icon + word)
    paintState(view);
    paintText(view);
    growText();
    fitCard();
  }

  function paintState(view) {
    const o = view.outcome || null;
    stateEl.hidden = !o;
    if (!o) return;
    stateEl.dataset.tone = o.tone;
    stateEl.dataset.kind = o.outcome === 'sent' ? 'sent' : '';
    stateEl.setAttribute('aria-label', o.aria);
    putIcon($('question-state-icon'), o.icon);
    $('question-state-word').textContent = o.word;
    // HU-075: «Recibida · <Agente> sigue con tu respuesta» — only the producer's own acknowledgement carries the phrase
    if (!noteEl) { noteEl = el('span', ''); noteEl.id = 'question-state-note'; stateEl.parentNode.insertBefore(noteEl, stateEl.nextSibling); }
    noteEl.textContent = o.outcome === 'answered' && outcomeAgent ? `${outcomeAgent} sigue con tu respuesta` : '';
    noteEl.hidden = !noteEl.textContent;
  }
  let noteEl = null;

  // Auto-size: the card is as tall as its content (min 148), the island follows through `abito:question-size`; past the cap the card
  // scrolls inside itself. Measured with height:auto, so nothing is ever clipped and the buttons stay inside the card.
  let sizedKey = '', maxIslandH = N.QUESTION_MAX_ISLAND_H, askedWindowH = 0;
  // The page only ASKS for a window height; Rust clamps it (never below 340, never above 70% of the work area) and answers with
  // the height it granted. The card then fits inside what was granted and scrolls beyond it.
  function askWindow(islandH) {
    const want = N.windowHeightFor(islandH);
    if (!invoke || want === askedWindowH) return Promise.resolve(false);
    askedWindowH = want;
    return invoke('island_window_height', { payload: { h: want } }).then(res => {
      const granted = res && Number.isFinite(res.h) ? res.h : N.windowHeightFor(0);
      maxIslandH = Math.max(N.QUESTION_MAX_ISLAND_H, granted - 8);
      return true;
    }, () => false);
  }
  let sentIslandH = -1;
  function publishSize(islandH) {
    // always tell the island, even the first time: a stale larger height must never survive a question that closed
    if (islandH !== sentIslandH) { sentIslandH = islandH; document.dispatchEvent(new CustomEvent('abito:question-size', { detail: { islandH } })); }
  }
  function fitCard() {
    const state = capsule.dataset.question;
    // HU-075: «Recibida» keeps the height the pending question had (no 255 -> 224 -> 150); the close below publishes the closed size once
    if (state === 'outcome') return;
    if (state !== 'pending' && state !== 'expired') {
      const closed = N.sizeSync({ question: state, islandH: 0 });
      sizedKey = ''; root.style.height = ''; root.style.overflowY = '';
      publishSize(closed.islandH);
      askWindow(closed.islandH); maxIslandH = N.QUESTION_MAX_ISLAND_H; // closed: the fixed window again
      return;
    }
    root.style.height = 'auto'; root.style.overflowY = 'hidden';
    const content = root.offsetHeight;
    const layout = N.questionLayout(content, maxIslandH);
    root.style.height = `${layout.cardH}px`; root.style.overflowY = layout.scroll ? 'auto' : 'hidden';
    const key = `${layout.cardH}:${layout.scroll}`;
    if (key !== sizedKey) { sizedKey = key; publishSize(N.sizeSync({ question: state, islandH: layout.islandH }).islandH); }
    // does the content want more than the window granted so far? ask once for the uncapped size, then refit inside the grant
    const wanted = N.questionLayout(content, 10000);
    if (wanted.islandH > maxIslandH) askWindow(wanted.islandH).then(changed => { if (changed) { sizedKey = ''; fitCard(); } });
  }
  function growText() {
    textEl.style.height = 'auto';
    const fit = N.textareaHeight(textEl.scrollHeight);
    textEl.style.height = `${fit.height}px`; textEl.style.overflowY = fit.scroll ? 'auto' : 'hidden';
  }

  function paintText(view) {
    const text = textEl.value;
    const word = N.textWord(budget, text);
    wordEl.hidden = !word; wordEl.textContent = word;
    textEl.dataset.invalid = word ? 'true' : 'false';
    const sn = snapshot && N.fromPending(snapshot.pending);
    sendEl.hidden = !!(sn && (sn.form || sn.multiSelect));
    sendEl.disabled = sendEl.hidden || !(view.controlsEnabled && N.canSendText(budget, text));
  }

  // ---- answering: trusted gestures only -------------------------------------
  function finish(next, sent) {
    inFlight = false;
    // a state pushed while the send was in flight is newer than this reply: keep it (the ack can beat the invoke)
    if (next && typeof next === 'object' && N.replyIsCurrent(sent, pushSeq)) apply(next); else render();
  }
  let pushSeq = 0;
  function choose(event, index) {
    if (!N.trusted(event)) return;
    if (!onScreen()) return;
    const view = current();
    if (!view.notification || !view.controlsEnabled) return;
    const sent = pushSeq;
    inFlight = true; render();
    action({ action: 'answer', id: view.notification.id, index }).then(next => finish(next, sent), error => { finish(null, sent); say((error && error.message) || 'No se pudo enviar.'); });
  }
  function decline(event) {
    if (!N.trusted(event)) return;
    if (!onScreen()) return;
    const view = current();
    if (!view.notification || !view.controlsEnabled) return;
    const sent = pushSeq;
    inFlight = true; render();
    action({ action: 'decline', id: view.notification.id }).then(next => finish(next, sent), error => { finish(null, sent); say((error && error.message) || 'No se pudo omitir.'); });
  }
  function submitText(event) {
    event.preventDefault();
    if (!N.trusted(event) || !onScreen()) return;
    const view = current();
    if (!view.notification || !view.controlsEnabled || !N.canSendText(budget, textEl.value)) return;
    const text = textEl.value;
    const sent = pushSeq;
    inFlight = true; render();
    action({ action: 'text', id: view.notification.id, text }).then(next => { textEl.value = ''; budget = null; finish(next, sent); },
      error => { finish(null, sent); say((error && error.message) || 'No se pudo enviar.'); });
  }
  skipEl.addEventListener('click', decline);
  prevEl.addEventListener('click', event => { const n = structuredNow(); if (n && N.trusted(event) && onScreen()) runIntent(event, n, { type: 'prev' }); });
  primaryEl.addEventListener('click', event => {
    const n = structuredNow();
    if (n && N.trusted(event) && onScreen() && !primaryEl.disabled) runIntent(event, n, { type: primaryEl.dataset.kind || 'next' });
  });
  freeform.addEventListener('submit', submitText);
  const structuredNow = () => { const n = snapshot && N.fromPending(snapshot.pending); return isStructured(n) ? n : null; };
  textEl.addEventListener('input', () => {
    growText(); fitCard();
    const view = current();
    if (!view.notification) return;
    const sn = snapshot && N.fromPending(snapshot.pending);
    if (sn) { // the draft lives in the page; a structured answer is validated again by the host on send (all-or-nothing)
      if (sn.form) wizard = N.formReduce(sn, wizard, { type: 'text', text: textEl.value });
      else multiDraft = N.setDraftText(stepItem(sn), multiDraft, textEl.value);
      paintCard(sn, view);
      if (isStructured(sn)) return;
    }
    const seq = ++budgetSeq;
    const value = textEl.value;
    if (!value) { budget = null; paintText(view); return; }
    action({ action: 'budget', id: view.notification.id, text: value }).then(b => { if (seq === budgetSeq) { budget = b; paintText(current()); } },
      () => { if (seq === budgetSeq) { budget = null; paintText(current()); } });
    paintText(view);
  });
  textEl.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    // Esc closes «Otra cosa…» (never declines); Enter = Enviar / Siguiente / Hecho; Shift+Enter is a newline
    if (cardKey(event)) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); textEl.blur(); }
  });
  // Digits 1..N pick an option (never while typing, never with modifiers).
  document.addEventListener('keydown', event => {
    const view = current();
    if (!view.notification || !view.controlsEnabled || root.inert || !onScreen()) return;
    if (/^(INPUT|TEXTAREA)$/.test((document.activeElement || {}).tagName || '') && document.activeElement !== textEl) return;
    const pend = snapshot && N.fromPending(snapshot.pending), look = pend && approvalOf(pend);
    if (look && layout()) {
      const at = layout().approvalKey(event, look, { typing: document.activeElement === textEl });
      if (at >= 0) { event.preventDefault(); choose(event, at); return; }
    }
    cardKey(event);
  });

  // ---- state stream ------------------------------------------------------------------
  function apply(next) {
    if (!next || typeof next !== 'object') return;
    if (N.regressesToSent(snapshot, next)) return; // never roll a delivered answer back to «Enviada»
    previous = snapshot; snapshot = next;
    trackOutcome(previous, next);
    // Cue ids go to the sound engine through the page event (see sound-wiring.js).
    const cue = N.soundFor(previous, snapshot);
    // #313: the gate is the sound ENGINE (off until the human enables it, silent until ready), not a constant
    if (cue && limiter.allow(cue, Date.now())) document.dispatchEvent(new CustomEvent('abito:cue', { detail: cue }));
    render();
    // a pending question is also a compact signal (sun dot): island.js reads capsule.dataset.question
    // #266: a genuinely NEW live question additionally asks the island to reveal itself;
    // the pure gate says which snapshots are events (boot replays and churn are not).
    const reveal = revealGate ? revealGate.question(snapshot, Date.now()) : false;
    document.dispatchEvent(new CustomEvent('abito:question', { detail: { pending: !!(N.fromPending(snapshot.pending)), show: !!capsule.dataset.question, reveal } }));
  }
  // L5 (human): a click on a blob during «Recibida» dismisses the outcome at once (the state the 3 s timer reaches) so the selection applies now.
  document.addEventListener('abito:outcome-dismiss', () => {
    if (!N.outcomeDismissible({ question: capsule.dataset.question })) return;
    outcomeUntil = 0; clearTimeout(outcomeTimer);
    render();
  });
  document.addEventListener('island:view', render);
  new MutationObserver(render).observe(capsule, { attributes: true, attributeFilter: ['data-card', 'data-view', 'data-phase'] });
  if (listen) listen('question:state', event => { pushSeq += 1; apply(event && event.payload); }).catch(() => {});
  action({ action: 'view' }).then(apply, () => {});
})();
