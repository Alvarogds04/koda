'use strict';
/* HU-057 T3/T4: the three bodies of the Nusa notch (Inicio · Agentes · Avisos), drawn into #nusa-panel with DOM nodes and
   textContent only. Decisions live in the pure model (island-nusa.js). No host verb is added: chat_action (submit/view),
   dictation_action (status/hands_free) and window.desktop (snapshot/onState/dismiss/click) are the ones chat.js and island.js
   already use. Every action needs a trusted event. */
(function () {
  const N = window.AbitoNusa, doc = document;
  const panel = doc.getElementById('nusa-panel'), chip = doc.getElementById('nusa-state'), capsule = doc.getElementById('capsule');
  if (!N || !panel) return;
  const invoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
  const call = (cmd, payload) => (invoke ? invoke(cmd, { payload }) : Promise.reject(new Error('no ipc')));
  const el = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const NS = 'http://www.w3.org/2000/svg';
  function icon(paths) {
    const svg = doc.createElementNS(NS, 'svg');
    for (const [k, v] of [['viewBox', '0 0 20 20'], ['width', '14'], ['height', '14'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '1.8'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true']]) svg.setAttribute(k, v);
    for (const d of paths) { const p = doc.createElementNS(NS, 'path'); p.setAttribute('d', d); svg.append(p); }
    return svg;
  }

  // ---- shared state: sessions view, notices snapshot, flags ----
  let view = null, focusId = null, tab = 'inicio', notices = [], noticeProblem = '';
  const flags = () => ({
    waiting: !!capsule && capsule.dataset.question === 'pending',
    finished: !!capsule && capsule.dataset.noticeBand === 'true',
  });
  const rows = () => (view && view.state === 'ready' && Array.isArray(view.rows) ? view.rows : []);
  const focus = () => N.focusView(rows(), focusId, flags());

  // ---- Inicio ----
  const home = { built: false };
  function buildHome() {
    home.root = el('div', 'nusa-home');
    home.sub = el('div', 'nusa-sub'); home.live = el('div', 'nusa-live');
    const form = el('form', 'nusa-field'); form.autocomplete = 'off';
    home.input = el('input', 'nusa-input'); home.input.type = 'text'; home.input.maxLength = N.DRAFT_MAX;
    home.input.placeholder = 'Pedile algo a Koda… (o dictalo)'; home.input.setAttribute('aria-label', 'Pedile algo a Koda');
    home.mic = el('button', 'nusa-fbtn'); home.mic.type = 'button'; home.mic.hidden = true; home.mic.setAttribute('aria-label', 'Dictar');
    home.mic.append(icon(['M10 3a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 10 3z', 'M5 9.5a5 5 0 0 0 10 0M10 14.5V17']));
    home.send = el('button', 'nusa-fbtn nusa-send'); home.send.type = 'submit'; home.send.setAttribute('aria-label', 'Enviar'); home.send.disabled = true;
    home.send.append(icon(['M4 10h11M10.5 5 15.5 10l-5 5']));
    form.append(home.input, home.mic, home.send);
    home.reply = el('button', 'nusa-reply'); home.reply.type = 'button'; home.reply.hidden = true;
    home.reply.setAttribute('aria-label', 'Abrir la conversación completa');
    home.problem = el('div', 'nusa-problem'); home.problem.setAttribute('role', 'status'); home.problem.hidden = true;
    home.root.append(home.sub, home.live, form, home.problem, home.reply);
    let pendingId = null, inFlight = false;
    const sync = () => { home.send.disabled = inFlight || N.sendCheck(home.input.value) !== null; };
    home.input.addEventListener('input', () => { pendingId = null; home.problem.hidden = true; sync(); }); // a changed draft is a new request: never reuse the old id
    home.input.addEventListener('keydown', e => e.stopPropagation()); // arrows move the caret, never the tabs
    form.addEventListener('submit', e => {
      e.preventDefault();
      if (e.isTrusted !== true || inFlight) return;
      const text = home.input.value, why = N.sendCheck(text);
      if (why) { home.problem.textContent = why; home.problem.hidden = false; return; }
      const bytes = new Uint8Array(12); crypto.getRandomValues(bytes);
      pendingId = pendingId || N.requestId(bytes); // a failed send retries with the same id
      inFlight = true; sync();
      call('chat_action', { action: 'submit', text, client_request_id: pendingId }).then(() => {
        inFlight = false; pendingId = null;
        if (home.input.value === text) home.input.value = '';
        sync(); refreshReply();
      }, error => {
        inFlight = false; // keep the text and the id
        home.problem.textContent = (error && error.message) || 'No se pudo enviar.'; home.problem.hidden = false; sync();
      });
    });
    home.reply.addEventListener('click', e => {
      if (e.isTrusted !== true) return;
      const open = doc.getElementById('open-chat'); // the same entry the chat tab uses: opens the full conversation
      if (open) open.click();
    });
    call('dictation_action', { action: 'status' }).then(s => { home.mic.hidden = !(s && s.prefs && s.prefs.enabled === true); }, () => {});
    home.mic.addEventListener('click', e => { if (e.isTrusted === true) call('dictation_action', { action: 'hands_free' }).catch(() => {}); });
    home.built = true;
  }
  function refreshReply() {
    call('chat_action', { action: 'view' }).then(v => { applyReply(N.replyLine(v)); }, () => {});
  }
  function applyReply(text) {
    if (!home.built) return;
    home.reply.hidden = !text; home.reply.textContent = text;
    if (text) home.reply.title = 'Abrir la conversación completa';
  }
  function paintHome() {
    if (!home.built) buildHome();
    const f = focus();
    home.sub.textContent = f ? f.line : 'Koda · en reposo';
    home.live.textContent = f && f.live ? f.live : '';
    home.live.hidden = !(f && f.live);
    panel.replaceChildren(home.root);
  }

  // ---- Agentes ----
  const JUMPABLE = /^s-[0-9a-f]{8}$/; // the same shape the ticker accepts for the closed focus_host verb
  function paintAgents() {
    const list = N.agentRows(rows(), {}), f = focus();
    const wrap = el('div', 'nusa-agents');
    if (!list.length) wrap.append(el('div', 'nusa-empty', 'Sin agentes conectados'));
    const more = N.moreAgents(view);
    for (const r of list.slice(0, more.show ? N.AGENT_ROWS_LINKED : N.AGENT_ROWS)) {
      const row = el('div', 'nusa-agent'); row.dataset.state = r.state; row.dataset.id = r.id; row.dataset.focus = f && f.id === r.id ? 'true' : 'false';
      row.style.setProperty('--agent', r.hex); row.setAttribute('aria-label', r.aria);
      const bar = el('i', 'nusa-agent-bar'); bar.setAttribute('aria-hidden', 'true');
      const name = el('span', 'nusa-agent-name', r.kind ? `${r.kind} · ${r.name}` : r.name);
      const st = el('span', 'nusa-chip nusa-agent-chip', r.stateWord);
      const tick = el('span', 'nusa-ticker');
      const shown = r.ticker.slice(-2); // two lines fit the 30px row: the previous action rises, the current one is highlighted
      shown.forEach((t, i) => { tick.append(el('span', i === shown.length - 1 ? 'nusa-tick nusa-tick-now' : 'nusa-tick', t)); });
      row.append(bar, name, st, tick);
      row.setAttribute('role', 'button'); row.tabIndex = 0; row.setAttribute('aria-label', r.aria + ' — seleccionar');
      const select = () => doc.dispatchEvent(new CustomEvent('abito:session-select', { detail: { id: row.dataset.id } })); // the ticker re-checks canFocus and the id
      row.addEventListener('click', e => { if (e.isTrusted === true) select(); });
      row.addEventListener('keydown', e => { if (e.target === row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); select(); } });
      if (JUMPABLE.test(r.id)) {
        const go = el('button', 'nusa-link nusa-jump', '↗'); go.type = 'button';
        go.setAttribute('aria-label', 'Abrir la terminal de ' + r.name); go.title = 'Abrir la terminal de ' + r.name;
        go.addEventListener('click', e => { // deterministic: select this session, then open its terminal; never also a row click
          e.stopPropagation();
          if (e.isTrusted !== true) return;
          select(); doc.dispatchEvent(new CustomEvent('abito:session-jump', { detail: { id: row.dataset.id } }));
        });
        go.addEventListener('keydown', e => { e.stopPropagation(); });
        row.append(go);
      }
      wrap.append(row);
    }
    if (more.show) wrap.append(allLink(more.label));
    panel.replaceChildren(wrap);
  }

  // «Ver todas (N)»: opens the existing sessions overlay (sessions-ticker.js) through ONE document event, dispatched only from a
  // trusted click here (the ticker re-checks canFocus). data-nusa-sessions="open" shows the overlay in the notch (island-nusa.css)
  // and is cleared when the overlay's `hidden` comes back; closing returns to this tab with the focus on the link.
  let overlayWatch = null;
  function allLink(label) {
    const b = el('button', 'nusa-link nusa-all', label); b.type = 'button';
    b.addEventListener('click', e => {
      if (e.isTrusted !== true) return;
      const ov = doc.querySelector('.sessions-all');
      if (!ov || !capsule) return;
      capsule.dataset.nusaSessions = 'open'; // before the dispatch: the overlay takes focus on open and must already be visible
      doc.dispatchEvent(new CustomEvent('abito:sessions-all-open'));
      if (ov.hidden) { delete capsule.dataset.nusaSessions; return; } // the ticker refused (canFocus): nothing changes
      if (overlayWatch) overlayWatch.disconnect();
      overlayWatch = new MutationObserver(() => {
        if (!ov.hidden) return;
        overlayWatch.disconnect(); overlayWatch = null; delete capsule.dataset.nusaSessions;
        const back = panel.querySelector('.nusa-all'); if (back) back.focus();
      });
      overlayWatch.observe(ov, { attributes: true, attributeFilter: ['hidden'] });
    });
    return b;
  }

  // same rows (ids, order) -> refresh only state, focus and tickers in place; any structural change returns false (full repaint)
  function updateAgents() {
    const wrap = panel.firstChild;
    if (!wrap || wrap.className !== 'nusa-agents') return false;
    const more = N.moreAgents(view), list = N.agentRows(rows(), {}).slice(0, more.show ? N.AGENT_ROWS_LINKED : N.AGENT_ROWS), nodes = Array.from(wrap.querySelectorAll('.nusa-agent')), f = focus();
    if (!list.length || list.length !== nodes.length || list.some((r, i) => nodes[i].dataset.id !== r.id)) return false;
    list.forEach((r, i) => {
      const row = nodes[i];
      row.dataset.state = r.state; row.dataset.focus = f && f.id === r.id ? 'true' : 'false';
      row.querySelector('.nusa-agent-chip').textContent = r.stateWord;
      const shown = r.ticker.slice(-2), tick = row.querySelector('.nusa-ticker');
      const same = Array.from(tick.children).map(c => c.textContent).join('\n') === shown.join('\n');
      if (!same) { tick.replaceChildren(...shown.map((t, k) => el('span', k === shown.length - 1 ? 'nusa-tick nusa-tick-now' : 'nusa-tick', t))); }
    });
    const link = wrap.querySelector('.nusa-all'); // the link follows the model in place: no full repaint for a count change
    if (!more.show && link) { link.remove(); } else if (more.show && !link) { wrap.append(allLink(more.label)); } else if (link && link.textContent !== more.label) { link.textContent = more.label; }
    return true;
  }

  // ---- Avisos ----
  function paintNotices() {
    const v = N.noticeLines(notices, Date.now()), wrap = el('div', 'nusa-notices');
    if (!v.lines.length) wrap.append(el('div', 'nusa-empty', 'Sin avisos'));
    const byId = new Map(notices.map(n => [n && n.id, n]));
    for (const l of v.lines.slice(0, 3)) {
      const row = el('div', 'nusa-notice'); row.dataset.tone = l.tone || '';
      row.append(el('i', 'nusa-notice-dot'), el('span', 'nusa-notice-text', l.text), el('span', 'nusa-notice-age', l.age || (byId.get(l.id) || {}).time || ''));
      const n = byId.get(l.id), openable = n && (n.kind === 'finished' || n.kind === 'question') && window.desktop && typeof window.desktop.click === 'function';
      if (openable) {
        const open = el('button', 'nusa-link', 'Ver'); open.type = 'button';
        open.addEventListener('click', e => { if (e.isTrusted === true) { try { window.desktop.click({ id: n.id, kind: n.kind }).catch(() => {}); } catch { /* native refusal never falls back */ } } });
        row.append(open);
      }
      const x = el('button', 'nusa-link', 'Descartar'); x.type = 'button';
      x.addEventListener('click', e => { if (e.isTrusted === true) dismiss([l.id]); });
      row.append(x);
      wrap.append(row);
    }
    if (v.markAll) {
      const all = el('button', 'nusa-markall', 'Marcar todo como leído'); all.type = 'button';
      all.addEventListener('click', e => { if (e.isTrusted === true) dismiss(notices.map(n => n && n.id).filter(Boolean)); });
      wrap.append(all);
    }
    if (noticeProblem) { const bad = el('div', 'nusa-problem', noticeProblem); bad.setAttribute('role', 'status'); wrap.append(bad); }
    panel.replaceChildren(wrap);
  }
  function dismiss(ids) { // the existing exact-id verb, once per notice (Rust refuses an unknown id with zero mutation)
    const d = window.desktop;
    N.dismissAll(d && typeof d.dismiss === 'function' ? id => d.dismiss(id) : null, ids).then(r => {
      if (r.snapshot) setNotices(r.snapshot.notices);
      noticeProblem = N.dismissFeedback(r);
      if (tab === 'avisos') paintNotices();
    });
  }
  function setNotices(list) { notices = Array.isArray(list) ? list : []; if (tab === 'avisos') paintNotices(); }

  // ---- state chip (right column, under Koda) ----
  function paintChip() {
    if (!chip) return;
    const f = focus(), fl = flags();
    const state = f ? f.state : fl.waiting ? 'waiting' : fl.finished ? 'finished' : 'idle';
    chip.hidden = false; chip.replaceChildren();
    const dot = el('i', 'nusa-chip-dot'); dot.style.background = N.veilColor(state, f && f.color);
    chip.append(dot, doc.createTextNode(f ? f.chip : (N.STATE_WORD[state] || (state === 'finished' ? 'Terminó' : 'En reposo'))));
    if (f) chip.title = f.agent;
  }

  function paint() {
    if (tab === 'agentes') paintAgents();
    else if (tab === 'avisos') paintNotices();
    else paintHome();
    paintChip();
  }
  doc.addEventListener('abito:sessions-view', e => {
    view = e.detail ? e.detail.view : null; focusId = e.detail ? e.detail.focusId : null;
    if (tab === 'avisos') { paintChip(); return; } // notices come from their own snapshot: a session event never rebuilds them (it would eat a click)
    if (tab === 'agentes') { if (!updateAgents()) paintAgents(); paintChip(); return; }
    if (home.built && doc.activeElement === home.input) { const f = focus(); home.sub.textContent = f ? f.line : 'Koda · en reposo'; home.live.textContent = f && f.live ? f.live : ''; home.live.hidden = !(f && f.live); paintChip(); } else paint();
  });
  doc.addEventListener('abito:nusa-tab', e => { tab = e.detail.tab; paint(); if (tab === 'inicio') refreshReply(); });
  if (capsule) new MutationObserver(paintChip).observe(capsule, { attributes: true, attributeFilter: ['data-question', 'data-notice-band'] });
  try { if (window.desktop) { window.desktop.onState(s => setNotices(s && s.notices)); window.desktop.snapshot().then(s => setNotices(s && s.notices), () => {}); } } catch { /* facade optional */ }
  try { const listen = window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen; if (listen) listen('chat:state', ev => applyReply(N.replyLine(ev && ev.payload))).catch(() => {}); } catch { /* optional */ }

  // ---- K2-13 T6b-1 «Hoy» (S2/S3/S5/S13/S17/S19): the island's day ------------------------------------------------
  // The data arrives already folded by the client (agentclient.rs: one bounded, closed `hoy` view per frame). This mount
  // only DRAWS it: every string is written with textContent from the pure model (island-nusa.js) — the item text comes
  // from models and Telegram posts, so it is never markup. A decision asks the daemon (`hoy_approve` / `hoy_reject {id}`,
  // no PIN, L17) and the row's word comes BACK from the daemon: a click never announces its own success. The notch grows to
  // 300 (the height the chat already reaches) with ONE attribute; because #island is sized inline by island.js, the page
  // reports the grown box to the host itself (`island_shape`), or the lower half of Hoy would take no clicks at all.
  (function hoyMount() {
    const root = doc.getElementById('hoy');
    if (!root || !capsule || !N || !N.hoyRows) return;
    const island = doc.getElementById('island');
    const byId = id => doc.getElementById(id);
    const HOY_GROWN = 300, NOTCH_FLAT = 150;
    const parts = { summary: byId('hoy-summary'), problem: byId('hoy-problem'), tabs: byId('hoy-tabs'), panel: byId('hoy-panel'),
      list: byId('hoy-list'), empty: byId('hoy-empty'), foot: byId('hoy-foot'), live: byId('hoy-live'), open: byId('open-hoy') };
    const GLYPHS = {
      buy: ['M4 16 16 4', 'M9 4h7v7'], sell: ['M16 4 4 16', 'M11 16H4V9'], send: ['M3 10 17 4 13 17 9 12z'],
      result: ['M6 3h7l3 3v11H6z', 'M8 9h6M8 12h6M8 15h4'], error: ['M10 3.5 18 17H2z', 'M10 8v4', 'M10 14.4v.1'],
    };
    let hoyView = null, hoyTabId = null, tabChosen = false, hoyBusy = '', shapeTimer = 0, refusal = '', rowNodes = new Map(), hoySig = 'none';
    // B1/B2: one decision in flight at a time, judged only by the daemon's own later state
    let pending = null, errorN = 0, readFrom = -1, movedAt = 0;
    const rowOrder = new Map(); // tab id -> the ids in the order they were FIRST drawn (a repaint never re-sorts)
    const isOpen = () => capsule.dataset.hoy === 'open';
    // the artboard's fifth frame: a day with nothing in it needs no room, so the notch stays 150 and the empty line says why.
    // Before the first answer arrives we keep the grown box (there IS something until the daemon says otherwise).
    const flatDay = () => hoyView !== null && !(Array.isArray(hoyView.items) && hoyView.items.length > 0);
    const grownHeight = open => (open && !flatDay() ? HOY_GROWN : NOTCH_FLAT);
    const shown = () => root.offsetHeight > 0;
    // F6: the app's own switch (html[data-motion]) AND the OS preference, like the notch's own mounts
    // (settings-nusa-mount.js, question-toast.js): a system set to reduce motion is not overruled by a default switch.
    const osCalm = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
    const reduced = () => N.motionReduced(doc.documentElement.dataset.motion, osCalm());
    const say = text => { if (parts.live) parts.live.textContent = text || ''; };
    const problem = text => { refusal = text || ''; if (!parts.problem) return; parts.problem.textContent = refusal; parts.problem.hidden = !refusal; };

    // ---- the grown box, reported to the host (the only thing the page cannot let island.js decide here) ----
    const box = () => { const r = island ? island.getBoundingClientRect() : null; return r && r.width > 0 ? { w: Math.round(r.width), h: Math.round(r.height) } : { w: 720, h: isOpen() ? HOY_GROWN : NOTCH_FLAT }; };
    const shape = (settled, size) => { if (!invoke) return; try { invoke('island_shape', { payload: { w: size.w, h: size.h, settled } }).catch(() => {}); } catch { /* optional bridge */ } };
    const settle = () => { clearTimeout(shapeTimer); shape(true, box()); };
    function report(open) {                     // the destination first (the host draws air and shadow from it), then the settled box
      if (!invoke) return;
      shape(false, { w: 720, h: grownHeight(open) });
      clearTimeout(shapeTimer);
      shapeTimer = setTimeout(settle, reduced() ? 0 : 340);
    }
    function reassert() {                        // island.js reports its own 150 box on its transitions: restore ours
      if (!isOpen() || !shown()) return;
      clearTimeout(shapeTimer);
      shapeTimer = setTimeout(settle, 80);
    }

    // ---- paint ----
    function rowNode(row) {
      const li = el('li', 'hoy-row');
      li.dataset.kind = row.kind; li.dataset.state = row.status; li.dataset.id = row.id;
      if (row.action) li.dataset.action = row.action;
      li.tabIndex = 0;                            // a row is readable with the keyboard; Enter on it NEVER decides (no handler)
      li.setAttribute('aria-label', row.aria);
      if (row.full) li.title = row.full;          // the whole stored sentence, on hover, as plain text
      const glyph = el('i', 'hoy-glyph'); glyph.setAttribute('aria-hidden', 'true');
      glyph.append(icon(GLYPHS[row.kind === 'proposal' ? (row.action || 'buy') : row.kind === 'error' ? 'error' : 'result']));
      const body = el('div', 'hoy-body');
      body.append(el('span', 'hoy-tt', row.title), el('span', 'hoy-sub', row.sub));
      if (row.chip) { const chip = el('span', 'hoy-chip', row.chip); chip.title = 'De dónde salió el texto'; body.append(chip); }
      li.append(glyph, body);
      if (row.state) li.append(stateNode(row));
      if (row.actions) li.append(actions(row));
      return li;
    }
    function stateNode(row) {
      const wrap = el('span', 'hoy-state');
      wrap.append(icon(row.state.startsWith('Aprobada') ? ['M3.5 10.5l4 4 8-9'] : ['M5 5l10 10', 'M15 5 5 15']));
      wrap.append(doc.createTextNode(row.state));
      return wrap;
    }
    function actions(row) {
      const wrap = el('div', 'hoy-acts');
      const yes = el('button', 'hoy-btn hoy-approve', 'Aprobar');
      const no = el('button', 'hoy-btn', 'Rechazar');
      yes.type = 'button'; yes.setAttribute('aria-label', row.approve);
      no.type = 'button'; no.setAttribute('aria-label', row.reject);
      // a decision in flight closes EVERY decision on the panel, not only its own row: the daemon re-sorts its day, so
      // the next button under the cursor may belong to another proposal (the verifier's double approval, B1)
      yes.disabled = no.disabled = !!hoyBusy;
      yes.addEventListener('click', e => { if (e.isTrusted !== true) return; decide(row.id, 'approve'); });
      no.addEventListener('click', e => { if (e.isTrusted !== true) return; decide(row.id, 'reject'); });
      wrap.append(yes, no);
      return wrap;
    }
    function paintHoy() {
      const counts = N.hoyCounts(hoyView);
      // the opening tab is the model's choice (pending first) until the human picks one: before the first answer there is
      // no data to choose from, so nothing is frozen then
      hoyTabId = N.hoyTab(counts, tabChosen ? hoyTabId : null);
      const active = N.HOY_TABS.find(t => t.id === hoyTabId) || N.HOY_TABS[0];
      if (parts.summary) parts.summary.textContent = N.hoySummary(counts);
      for (const t of N.HOY_TABS) {
        const b = byId('hoy-tab-' + t.id);
        if (!b) continue;
        const on = t.id === hoyTabId, n = counts[t.id] || 0;
        b.setAttribute('aria-selected', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
        b.setAttribute('aria-label', `${t.title}, ${n} ${t.id === 'propuestas' ? (n === 1 ? 'espera tu sí' : 'esperan tu sí') : t.id === 'errores' ? (n === 1 ? 'aviso' : 'avisos') : (n === 1 ? 'resultado' : 'resultados')}`);
        const num = b.querySelector('.hoy-n');
        if (num) num.textContent = String(n);
      }
      if (parts.panel) parts.panel.setAttribute('aria-labelledby', 'hoy-tab-' + active.id);
      // the order is the page's own while the panel stays on this tab: a decided row (or a row the daemon moved) keeps
      // the place it had, so the Aprobar / Rechazar under the cursor always belongs to the proposal it was aimed at
      const seen = rowOrder.get(active.id) || [];
      const rows = N.hoyOrder(seen, N.hoyRows(hoyView, Date.now()).filter(r => r.tab === active.id));
      const ids = rows.map(r => r.id).join('\n');
      if (seen.length && ids && ids !== seen.join('\n')) movedAt = Date.now(); // they moved: hold the clicks a moment
      rowOrder.set(active.id, rows.map(r => r.id));
      rowNodes = new Map();
      if (parts.list) {
        parts.list.textContent = '';
        for (const row of rows) { const node = rowNode(row); rowNodes.set(row.id, node); parts.list.append(node); }
      }
      if (parts.empty) { parts.empty.hidden = rows.length > 0; parts.empty.textContent = N.hoyEmpty(active.id); }
      if (parts.foot) {
        const cut = counts.truncated;
        parts.foot.hidden = !cut;
        parts.foot.textContent = cut ? '«Hoy» guarda más de lo que cabe: se ven los primeros elementos.' : '';
      }
      if (parts.open) parts.open.setAttribute('aria-label', counts.pending ? `Hoy · ${counts.pending} ${counts.pending === 1 ? 'propuesta espera' : 'propuestas esperan'} tu sí` : 'Hoy');
      const flat = flatDay();                  // an empty day gives the room back, and the host hears about it
      if ((capsule.dataset.hoyEmpty === 'true') !== flat) {
        if (flat) capsule.dataset.hoyEmpty = 'true'; else delete capsule.dataset.hoyEmpty;
        if (isOpen()) report(true);
      }
      problem(refusal);
    }

    // ---- data ----
    // The client publishes its whole state on every change (the sessions ticker polls too), so a repaint only happens when
    // «Hoy» itself moved: a rebuild resets the list's scroll and the focused row, and nothing else may do that.
    function applyHoy(next) {
      if (!next || typeof next !== 'object' || !Array.isArray(next.items)) return;
      const sig = JSON.stringify(next.items) + (next.truncated === true ? '+' : '');
      if (sig === hoySig) return;
      hoySig = sig;
      hoyView = { items: next.items, truncated: next.truncated === true };
      if (isOpen()) paintHoy();
    }
    // `keep`: the caller already said something true (the deadline's «no sabemos») that a successful read must not erase
    function load(keep) {
      const unavailable = () => { readFrom = -1; problem(N.hoyRefusal('unavailable')); say(N.hoyRefusal('unavailable')); };
      call('agent_action', { action: 'view' }).then(v => {
        observeHoy(v);                                                // the first ask also connects the client
        const n0 = errorN;                                            // an error already there is not THIS read's answer
        readFrom = n0;
        return call('agent_action', { action: 'hoy_list' }).then(list => {
          observeHoy(list);
          const p = N.hoyReadProblem(n0, list);                       // F5: a refused or unavailable read is said
          if (p || !keep) { problem(p); if (p) say(p); }
          readFrom = -1;
        }, unavailable);
      }, unavailable);
    }
    // One view from ANY path — the command's write-time reply, a read's answer, an `agent:state` push — goes through
    // here: the day follows the daemon, and a decision is finished only by the daemon's own state (B1/B2).
    function observeHoy(view, snapshot) {
      if (!view || typeof view !== 'object') return;
      if (snapshot !== false) applyHoy(view.hoy);   // a write-time reply is the day BEFORE the command: it never replaces it
      errorN = Math.max(errorN, N.hoyErrorN(view));
      if (pending) {
        const d = pending;
        const r = N.hoyDecision(d.n0, view, d.id, d.want);
        if (r.state === 'waiting') return;
        finishDecision();
        if (r.state === 'ok') say(d.how === 'approve' ? `Aprobada: ${d.label}. Se ejecutó una vez.` : `Rechazada: ${d.label}. No se hizo nada.`);
        else { const t = N.hoyRefusal(r.code); problem(t); say(t); }
        return;
      }
      if (readFrom >= 0) {                          // a read was asked and the daemon refused it afterwards (F5)
        const p = N.hoyReadProblem(readFrom, view);
        if (p) { readFrom = -1; problem(p); say(p); }
      }
    }
    function finishDecision() {
      const d = pending;
      pending = null;
      if (d) clearTimeout(d.timer);
      hoyBusy = '';
      paintHoy();
      const node = d ? rowNodes.get(d.id) : null;   // the buttons just left: keep the keyboard on the row it acted on
      if (node && typeof node.focus === 'function') node.focus();
    }
    const UNKNOWN = 'No sabemos si el daemon registró la decisión.';
    function decide(id, how) {
      if (hoyBusy || pending) return;
      if (!N.hoyGuardOpen(movedAt, Date.now())) return; // the rows moved this instant: this button may be another proposal's
      const row = N.hoyRows(hoyView, Date.now()).find(r => r.id === id);
      const d = { id, how, want: how === 'approve' ? 'approved' : 'rejected', label: row ? row.title : 'la propuesta', n0: errorN, timer: 0 };
      hoyBusy = id; problem(''); say(''); pending = d;
      // the deadline: silence is not a success and not a failure — say it does not know, and ask the day again
      d.timer = setTimeout(() => {
        if (pending !== d) return;
        pending = null; hoyBusy = '';
        problem(UNKNOWN); say(UNKNOWN); paintHoy(); load(true);
      }, N.HOY_WAIT_MS);
      paintHoy();
      call('agent_action', { action: how === 'approve' ? 'hoy_approve' : 'hoy_reject', id }).then(v => observeHoy(v, false), () => {
        if (pending !== d) return;
        finishDecision();
        const t = N.hoyRefusal('unavailable');
        problem(t); say(t);
      });
    }
    function focusTab() { const b = byId('hoy-tab-' + (hoyTabId || 'propuestas')); if (b && typeof b.focus === 'function') b.focus(); }
    function setOpen(on, focus) {
      if (isOpen() === on) return;
      if (on) capsule.dataset.hoy = 'open'; else delete capsule.dataset.hoy;
      if (parts.open) parts.open.setAttribute('aria-pressed', on ? 'true' : 'false');
      report(on);
      rowOrder.clear(); movedAt = 0;  // closed: the day follows the daemon's own order again when it is opened
      if (!on) { problem(''); return; }
      problem(''); paintHoy(); load();
      if (focus) focusTab();
    }

    // ---- wiring (every action needs a trusted event) ----
    for (const t of N.HOY_TABS) {
      const b = byId('hoy-tab-' + t.id);
      if (!b) continue;
      b.addEventListener('click', e => {
        if (e.isTrusted !== true) return;
        tabChosen = true; hoyTabId = t.id; paintHoy(); say(`Pestaña ${t.title}. ${N.hoyEmpty(t.id)}`);
      });
      b.addEventListener('keydown', e => {
        if (e.isTrusted !== true) return;
        const to = N.hoyTabKey(e, N.HOY_TABS.findIndex(x => x.id === t.id));
        if (to === null) return;
        e.preventDefault(); e.stopPropagation();
        tabChosen = true; hoyTabId = N.HOY_TABS[to].id; paintHoy();
        const next = byId('hoy-tab-' + hoyTabId); if (next && typeof next.focus === 'function') next.focus();
        say(`Pestaña ${N.HOY_TABS[to].title}.`);
      });
    }
    if (parts.open) parts.open.addEventListener('click', e => { if (e.isTrusted !== true) return; setOpen(!isOpen(), true); });
    const homeTab = byId('home-tab');
    if (homeTab) homeTab.addEventListener('click', () => { if (isOpen()) setOpen(false, false); }, true);
    doc.addEventListener('abito:nusa-tab', () => { if (isOpen()) { setOpen(false, false); const b = byId('open-hoy'); if (b && typeof b.focus === 'function') b.focus(); } });
    doc.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || !isOpen()) return;
      setOpen(false, false);
      const b = byId('open-hoy'); if (b && typeof b.focus === 'function') b.focus();
    }, true);
    // a take-over (question, permission, finished card) hides Hoy by CSS; the title and the box must follow it back
    if (capsule) new MutationObserver(() => { if (isOpen()) { reassert(); } }).observe(capsule, { attributes: true, attributeFilter: ['data-question', 'data-card', 'data-takeover', 'data-phase', 'data-view'] });
    window.addEventListener('resize', () => { if (isOpen()) settle(); });
    try {
      const listen = window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen;
      if (listen) listen('agent:state', ev => { const p = ev && ev.payload; if (p) observeHoy(p); }).catch(() => {});
    } catch { /* optional facade */ }
    paintHoy();
  })();
  paint(); refreshReply();
})();
