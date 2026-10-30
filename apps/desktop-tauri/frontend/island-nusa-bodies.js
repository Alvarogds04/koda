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
  paint(); refreshReply();
})();
