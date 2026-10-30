'use strict';
/* HU-057 T1/T2: browser mount of the Nusa notch (#nusa). All decisions come from the pure model (island-nusa.js,
   window.AbitoNusa); this file only paints the clock, the veil and the tab state and wires click / wheel / keys.
   It never touches the legacy overview and sends nothing to the host. */
(function () {
  const N = window.AbitoNusa, doc = document;
  const nusa = doc.getElementById('nusa');
  if (!N || !nusa) return;
  const $ = id => doc.getElementById(id);
  const capsule = $('capsule'), island = $('island');
  let current = 0, tabTitle = 'Inicio';
  // T5: the state a Pregunta / Permiso / Terminó / Error takes over, read from the data the island already publishes
  const qEl = $('question'), noticeCardEl = $('notice-card');
  const takeoverData = () => ({ ...capsule.dataset, look: qEl ? qEl.dataset.look : '', outcomeWord: ($('question-state-word') || {}).textContent || '', severity: noticeCardEl ? noticeCardEl.dataset.severity : '', cardShown: !!noticeCardEl && !noticeCardEl.hidden });
  function paintTitle() { $('nusa-title').textContent = (capsule && N.takeoverTitle(takeoverData())) || tabTitle; }

  // hover icons (20px grid, stroke), one per tab id
  const ICONS = {
    house: ['M3 9.5 10 3l7 6.5', 'M5 8.5V17h10V8.5'],
    plug: ['M7 2v4M13 2v4M5 6h10v3a5 5 0 0 1-10 0zM10 14v4'],
    bell: ['M5 14V9a5 5 0 0 1 10 0v5l1.5 2h-13z', 'M8.5 18a1.5 1.5 0 0 0 3 0'],
  };
  const NS = 'http://www.w3.org/2000/svg';
  for (const tab of N.TABS) {
    const btn = nusa.querySelector(`[role="tab"][data-tab="${tab.id}"] .ni`);
    if (!btn || !ICONS[tab.icon]) continue;
    const svg = doc.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 20 20'); svg.setAttribute('width', '12'); svg.setAttribute('height', '12'); svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
    for (const d of ICONS[tab.icon]) { const path = doc.createElementNS(NS, 'path'); path.setAttribute('d', d); svg.append(path); }
    btn.replaceChildren(svg);
  }

  function select(i, focus) {
    const next = N.step(i, 0);
    current = next;
    const tab = N.TABS[next];
    nusa.dataset.tab = tab.id;
    tabTitle = tab.title; paintTitle();
    for (const b of nusa.querySelectorAll('[role="tab"]')) {
      const on = b.dataset.tab === tab.id;
      b.setAttribute('aria-selected', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    }
    const panel = $('nusa-panel'); if (panel) panel.setAttribute('aria-labelledby', `nusa-tab-${tab.id}`);
    const a = N.arrows(next);
    $('nusa-prev').hidden = !a.prev; $('nusa-next').hidden = !a.next;
    doc.dispatchEvent(new CustomEvent('abito:nusa-tab', { detail: { tab: tab.id, index: next } }));
  }
  const go = (delta, focus) => { const to = N.step(current, delta); if (to !== current) select(to, focus); };

  nusa.querySelectorAll('[role="tab"]').forEach(b => b.addEventListener('click', e => {
    if (e.isTrusted !== true) return;
    select(N.TABS.findIndex(t => t.id === b.dataset.tab));
  }));
  $('nusa-prev').addEventListener('click', e => { if (e.isTrusted === true) go(-1); });
  $('nusa-next').addEventListener('click', e => { if (e.isTrusted === true) go(1); });
  nusa.addEventListener('wheel', e => { const d = N.wheelStep(e); if (d) { e.preventDefault(); go(d); } }, { passive: false });

  const active = () => capsule && capsule.dataset.phase === 'expanded' && capsule.dataset.view === 'overview' && !capsule.dataset.card
    && !['pending', 'expired', 'outcome'].includes(capsule.dataset.question || '');
  const typingIn = el => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  doc.addEventListener('keydown', e => {
    if (!active()) return;
    const d = N.keyStep(e, { typing: typingIn(doc.activeElement) });
    if (d) { e.preventDefault(); go(d, nusa.contains(doc.activeElement)); }
  });

  // clock: progress ring of the day + date + bold time, refreshed every 30 s
  function paintClock() {
    const now = new Date(), c = N.clockText(now);
    $('nusa-date').textContent = c.date; $('nusa-time').textContent = c.time;
    const arc = $('nusa-ring-arc');
    if (arc) { const f = Math.round(((now.getHours() * 60 + now.getMinutes()) / 1440) * 100); arc.setAttribute('stroke-dasharray', `${f} 100`); }
  }
  paintClock();
  setInterval(paintClock, 30000);

  // veil: derived from the state the island already publishes (never a second source of truth)
  // HU-063 T4: the agent of the current notice, read from the snapshot the host already publishes (island.js is not touched)
  let noticeAgent = null;
  const readNotices = snap => { noticeAgent = snap && Array.isArray(snap.notices) && snap.notices[0] ? snap.notices[0] : null; paintVeil(); };
  try { window.desktop.onState(readNotices); } catch { /* facade optional */ }
  try { window.desktop.snapshot().then(readNotices, () => {}); } catch { /* facade optional */ }
  let running = false, svRows = [], svFocus = null;
  function paintVeil() {
    const q = capsule && capsule.dataset.question;
    const take = capsule ? N.takeoverState(takeoverData()) : null;
    if (capsule && (capsule.dataset.takeover || '') !== (take || '')) { if (take) capsule.dataset.takeover = take; else delete capsule.dataset.takeover; }
    paintTitle();
    const f = { error: take === 'error', waiting: q === 'pending' || take === 'waiting' || (!!capsule && ['pending', 'covered'].includes(capsule.dataset.card)), finished: take === 'finished' || !!(capsule && capsule.dataset.noticeBand === 'true'), working: running };
    const s = N.veilState(f);
    if (nusa.dataset.veil !== s) nusa.dataset.veil = s;
    // S13: the veil takes the colour of the FOCUSED agent (working / idle / finished); waiting and error keep their role colour
    const fv = N.focusView(svRows, svFocus, { waiting: f.waiting, finished: f.finished });
    nusa.dataset.agent = fv ? 'true' : 'false';
    // S13: the compact pill's dot/veil use the focused agent's colour (working/idle/finished); question = --sun, error = --red-11
    if (capsule) capsule.style.setProperty('--pill-dot', N.veilColor(f.error ? 'error' : f.waiting ? 'waiting' : s, take ? undefined : fv && fv.color));
    // a takeover keeps its role colour; «Terminó» alone takes the colour of the agent that triggered the notice (HU-063 T4)
    const an = N.noticeAgentColor(noticeAgent, take === 'error' || f.error ? 'error' : f.waiting ? 'waiting' : 'finished');
    nusa.style.setProperty('--agent-notice', an);
    nusa.style.setProperty('--veil', take === 'finished' ? an : N.veilColor(s, take ? undefined : fv && fv.color));
  }
  // HU-063 (decision A): the open chat under a pending question/card is inert (unfocusable, unclickable) and hidden from AT; the draft is never touched
  const chatEl = $('chat');
  function paintChatInert() {
    if (!capsule || !chatEl) return;
    const on = N.chatInert(takeoverData());
    if (chatEl.inert === on) return;
    chatEl.inert = on;
    if (on) {
      chatEl.setAttribute('aria-hidden', 'true');
      if (chatEl.contains(doc.activeElement)) {
        const t = qEl && qEl.querySelector('button, input, textarea, select, [tabindex]:not([tabindex="-1"])');
        if (t && typeof t.focus === 'function') t.focus(); else if (doc.activeElement && doc.activeElement.blur) doc.activeElement.blur();
      }
    } else chatEl.removeAttribute('aria-hidden');
  }
  doc.addEventListener('abito:sessions-view', e => {
    const v = e.detail && e.detail.view;
    svRows = v && v.state === 'ready' && Array.isArray(v.rows) ? v.rows : []; svFocus = e.detail ? e.detail.focusId : null; paintVeil();
  });
  doc.addEventListener('abito:layout', e => { running = !!(e.detail && Array.isArray(e.detail.running) && e.detail.running.length); paintVeil(); });
  paintVeil();
  paintChatInert();
  if (capsule) new MutationObserver(paintChatInert).observe(capsule, { attributes: true, attributeFilter: ['data-view', 'data-question', 'data-card', 'data-phase'] });
  if (capsule) new MutationObserver(paintVeil).observe(capsule, { attributes: true });
  for (const el of [qEl, noticeCardEl]) if (el) new MutationObserver(paintVeil).observe(el, { attributes: true, attributeFilter: ['data-look', 'data-severity'] });

  // ears: #island clips its children, so the concave corners live in a sibling of #island, positioned from its box
  if (capsule && island) {
    const ear = doc.createElement('div'); ear.id = 'nusa-ear'; ear.setAttribute('aria-hidden', 'true');
    ear.append(doc.createElement('i'), doc.createElement('i'));
    island.after(ear);
    const place = () => {
      // human, 29-oct: the island is the Nusa notch in EVERY expanded phase (chat included), so it wears the ears whenever it hangs expanded from the top
      const on = active() || !!capsule.dataset.takeover || capsule.dataset.phase === 'expanded';
      ear.dataset.on = on ? 'true' : 'false';
      if (!on) return;
      const r = { left: island.offsetLeft, top: island.offsetTop, width: island.offsetWidth };
      const rect = island.getBoundingClientRect(), cr = capsule.getBoundingClientRect();
      ear.style.left = `${rect.left - cr.left - 12}px`; ear.style.top = `${rect.top - cr.top}px`; ear.style.width = `${(r.width || rect.width) + 24}px`;
    };
    new MutationObserver(place).observe(capsule, { attributes: true });
    new MutationObserver(place).observe(island, { attributes: true, attributeFilter: ['style'] });
    window.addEventListener('resize', place);
    place();
  }
  select(0);
})();
