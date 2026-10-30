'use strict';
/* HU-057 «isla Nusa» (design/hu-057-isla-koda/01-notch-nusa-puro.html): the expanded island as a black notch with the tabs
   Inicio · Agentes · Avisos. Pure view-model first (Node-testable, no DOM): tabs and navigation, the state veil, the agent
   rows (name + colour + live action, never an avatar), the notices lines, the clock, the size setting and the compact pill
   width. The browser-only mount lives in island-nusa-mount.js. Classic script (window.AbitoNusa) and test-node module. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AbitoNusa = Object.freeze(api);
})(typeof self !== 'undefined' ? self : this, () => {
  const TABS = Object.freeze([
    Object.freeze({ id: 'inicio', title: 'Inicio', icon: 'house' }),
    Object.freeze({ id: 'agentes', title: 'Agentes', icon: 'plug' }),
    Object.freeze({ id: 'avisos', title: 'Avisos', icon: 'bell' }),
  ]);
  const last = TABS.length - 1;
  const index = i => (Number.isInteger(i) && i >= 0 && i <= last ? i : 0);
  const step = (i, delta) => Math.max(0, Math.min(last, index(i) + (delta > 0 ? 1 : delta < 0 ? -1 : 0)));
  const arrows = i => ({ prev: index(i) > 0, next: index(i) < last });
  const WHEEL_MIN = 12;
  function wheelStep(e) {
    if (!e) return 0;
    const dy = Number(e.deltaY) || 0, dx = Number(e.deltaX) || 0;
    const d = Math.abs(dx) > Math.abs(dy) ? dx : dy;
    return Math.abs(d) < WHEEL_MIN ? 0 : d > 0 ? 1 : -1;
  }
  function keyStep(e, ctx) {
    if (!e || e.isTrusted !== true || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || (ctx && ctx.typing)) return 0;
    return e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
  }

  // ---- the veil (C3): the human's own turn outranks a failure only in the sense that a real error wins over waiting ----
  const VEIL = Object.freeze({ working: '--veil-working', waiting: '--veil-waiting', finished: '--veil-finished', error: '--veil-error' });
  function veilState(f) {
    if (!f) return 'idle';
    if (f.error) return 'error';
    if (f.waiting) return 'waiting';
    if (f.finished) return 'finished';
    return f.working ? 'working' : 'idle';
  }

  // ---- agents (C1): one row per agent; name + colour distinguish it, no avatar ----
  const TICKER_MAX = 3, TEXT_MAX = 48;
  const bound = (t, max) => { const a = Array.from(String(t == null ? '' : t)); return a.length > max ? `${a.slice(0, max - 1).join('')}…` : a.join(''); };
  const projectLabel = name => (typeof name === 'string' && /^sb-second-brain$/i.test(name.trim()) ? 'Koda' : name);
  const STATE_WORD = Object.freeze({ working: 'Trabaja', idle: 'En reposo', waiting: 'Te espera', error: 'Error' });
  // S13: one hex per agent (design 01-notch-nusa-puro); a human-chosen hex wins, a palette name maps to its hex
  const AGENT_HEX = Object.freeze({ Pi: '#2dffac', 'Claude Code': '#b04dff', Codex: '#f472b6', Gemini: '#5eead4', OpenCode: '#4d9fff' });
  const PALETTE_HEX = Object.freeze({ green: '#2dffac', blue: '#4d9fff', mint: '#5eead4', orange: '#ff9a3c', purple: '#b04dff' });
  const HEX = /^#[0-9a-fA-F]{6}$/;
  const agentHex = (kindLabel, color) => (HEX.test(color) ? color : AGENT_HEX[kindLabel] || PALETTE_HEX[color] || '#4d9fff');
  function agentRows(rows, ctx) {
    if (!Array.isArray(rows)) return [];
    const attributed = ctx && ctx.attributedId;
    return rows.filter(r => r && typeof r.id === 'string').map(r => {
      const steps = r.tools && Array.isArray(r.tools.steps) ? r.tools.steps : [];
      const running = steps.some(s => s.state === 'running');
      let state = running || r.state === 'running' ? 'working' : steps.length && steps[steps.length - 1].state === 'error' ? 'error' : 'idle';
      if (attributed && attributed === r.id) state = 'waiting';
      const shown = steps.slice(-TICKER_MAX);
      const live = state === 'working' || state === 'error' ? (shown.length ? bound(shown[shown.length - 1].name, TEXT_MAX) : '') : '';
      const name = bound(projectLabel(r.cwd) || r.kindLabel || 'Sesión', 24);
      return { id: r.id, name, kind: r.kindLabel || '', color: r.color || 'blue', hex: agentHex(r.kindLabel, r.color), state, stateWord: STATE_WORD[state], live,
        ticker: state === 'idle' ? [] : shown.map(s => bound(s.name, TEXT_MAX)),
        aria: `${name} · ${r.kindLabel || 'Sesión'} · ${STATE_WORD[state].toLowerCase()}` };
    });
  }

  // «Ver todas (N)»: the Agentes tab lists AGENT_ROWS agents; when more exist the link opens the full sessions overlay. The 104px panel
  // holds 3 rows OR 2 rows + the link (rows are 30px), so a needed link takes the 3rd row's place (AGENT_ROWS_LINKED) - never clipped.
  const AGENT_ROWS = 3, AGENT_ROWS_LINKED = 2;
  function moreAgents(view) {
    const rows = view && Array.isArray(view.rows) ? view.rows.length : 0;
    const total = view && Number.isSafeInteger(view.total) && view.total >= rows ? view.total : rows;
    const show = rows > 0 && (total > AGENT_ROWS || (view && view.truncated === true));
    return { show, total, label: show ? `Ver todas (${total})` : '' };
  }

  // ---- focus (S4/S13): the agent the island names, the veil takes its colour. Same order as island-layout pickFocus ----
  const CHIP_WORD = Object.freeze({ ...STATE_WORD, finished: 'Terminó' });
  const VERB = Object.freeze({ working: 'trabaja', idle: 'en reposo', waiting: 'te espera', error: 'con error', finished: 'terminó' });
  function focusView(rows, focusId, ctx) {
    const list = agentRows(rows, ctx);
    if (!list.length) return null;
    const row = list.find(r => r.id === focusId) || list.find(r => r.state === 'working') || list[0];
    const flags = ctx || {};
    const state = veilState({ error: row.state === 'error', waiting: !!flags.waiting || row.state === 'waiting', finished: !!flags.finished && row.state !== 'waiting', working: row.state === 'working' });
    const agent = row.kind || 'Sesión';
    return { id: row.id, agent, name: row.name, color: row.hex, state, veil: state, chip: CHIP_WORD[state], live: row.live,
      line: `${agent} · ${VERB[state]} · ${row.name}` };
  }
  function veilColor(state, agentColor) {
    if (state === 'waiting') return 'var(--sun)';
    if (state === 'error') return 'var(--red-11)';
    if (HEX.test(agentColor)) return agentColor;
    return state === 'finished' ? 'var(--go)' : 'var(--island-live)';
  }

  // ---- HU-063 T4: the colour of a take-over. Waiting / error keep their role colour (never the agent's); «Terminó» takes the agent of the notice ----
  const AGENT_ID_HEX = Object.freeze({ pi: AGENT_HEX.Pi, 'claude-code': AGENT_HEX['Claude Code'], codex: AGENT_HEX.Codex, gemini: AGENT_HEX.Gemini, opencode: AGENT_HEX.OpenCode });
  const ownHex = (map, k) => (typeof k === 'string' && Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null);
  function noticeAgentColor(notice, state) {
    if (state === 'waiting') return 'var(--sun)';
    if (state === 'error') return 'var(--red-11)';
    const a = notice && typeof notice.agent === 'string' ? notice.agent.trim() : '';
    return ownHex(AGENT_ID_HEX, a.toLowerCase()) || ownHex(AGENT_HEX, a) || ownHex(AGENT_ID_HEX, a.toLowerCase().replace(/\s+/g, '-')) || 'var(--go)';
  }

  // ---- T5 (S7/S8): Pregunta / Permiso / Terminó / Error take the notch look; the legacy cards stay the body ----
  // d = the capsule's data-* (phase, view, question, card, noticeView, engineBand) + `look` (#question data-look) + `severity` (#notice-card data-severity).
  // waiting (the human's turn) outranks error, which outranks finished; each keeps its role colour (never the agent's, S13).
  function takeoverState(d) {
    if (!d || d.phase !== 'expanded') return null;
    // HU-063: the chat is a view of its own and stays under the question (dimmed, inert); no second take-over under it
    if (d.view === 'chat') return null;
    if (d.question === 'pending' || d.question === 'expired' || d.question === 'outcome' || d.card) return 'waiting';
    // an open lane whose card is not shown (d.cardShown === false) takes nothing over: «un "Terminó" nunca sin contenido» (absent = unknown, today's behaviour)
    const lane = d.view === 'notices' && d.noticeView === 'notices' && d.cardShown !== false;
    if (lane && d.severity === 'error') return 'error';
    if (d.engineBand === 'on') return 'error';
    return lane ? 'finished' : null;
  }
  // HU-063 (decision A): the question wins over the chat; while one (or a permission card) is pending the open chat is dimmed and inert
  function chatInert(d) {
    return !!d && d.view === 'chat' && (d.question === 'pending' || d.question === 'expired' || d.question === 'outcome' || !!d.card);
  }
  function takeoverTitle(d) {
    const s = takeoverState(d);
    if (s === 'waiting' && d.question === 'outcome' && d.outcomeWord) return d.outcomeWord; // HU-075: the header says what the card says («Recibida»)
    if (s === 'waiting') return d.card || d.look === 'approval' ? 'Permiso' : 'Pregunta';
    if (s === 'finished') return 'Terminó';
    return s === 'error' && d.view === 'notices' && d.noticeView === 'notices' ? 'Error' : '';
  }

  // ---- Inicio field: the same draft rules as chat.js / chat-view.js ----
  const DRAFT_MAX = 8000;
  function sendCheck(text) {
    const t = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    if (Array.from(t).length > DRAFT_MAX) return 'El mensaje supera los 8.000 caracteres.';
    if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(t)) return 'El mensaje contiene caracteres de control.';
    if (!t.trim()) return 'El mensaje está vacío.';
    return null;
  }
  const requestId = bytes => 'req-' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  function replyLine(view, max) {
    const turns = view && Array.isArray(view.turns) ? view.turns : [];
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const r = turns[i] && typeof turns[i].reply === 'string' ? turns[i].reply.replace(/\s+/g, ' ').trim() : '';
      if (r) return bound(r, max > 1 ? max : 90);
    }
    return '';
  }

  // ---- clock ----
  const DAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
  const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  function clockText(d) {
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) return { date: '', time: '' };
    const p = n => String(n).padStart(2, '0');
    return { date: `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`, time: `${p(d.getHours())}:${p(d.getMinutes())}` };
  }

  // ---- notices (one line each) ----
  const SHORT = { 'Pi terminó su turno': 'Pi terminó', 'Pi espera tu decisión': 'Pi espera', 'Atajo limitado (sin permiso)': 'Atajo limitado',
    'Codex te pide permiso': 'Codex pide permiso', 'Codex te pregunta': 'Codex pregunta' };
  const shortTitle = title => { const t = String(title || '').trim(); return SHORT[t] || t.split(/\s+/).slice(0, 3).join(' '); };
  const TONE = { warning: 'sun', error: 'red' };
  function noticeLines(notices, now) {
    const list = (Array.isArray(notices) ? notices : []).filter(n => n && typeof n === 'object');
    const lines = list.map(n => ({ id: n.id, kind: n.kind, text: shortTitle(n.title), tone: TONE[n.severity] || '', at: Number.isFinite(n.at) ? n.at : null,
      age: Number.isFinite(n.at) && Number.isFinite(now) ? ageWord(now - n.at) : '' }));
    return { lines, markAll: lines.length > 0 };
  }
  function ageWord(ms) {
    if (!(ms >= 0)) return '';
    if (ms < 60000) return 'ahora';
    const m = Math.floor(ms / 60000);
    return m < 60 ? `hace ${m} min` : `hace ${Math.floor(m / 60)} h`;
  }

  // ---- N8: size setting ----
  const SIZES = Object.freeze([{ id: 's', label: 'S' }, { id: 'm', label: 'M' }, { id: 'l', label: 'L' }, { id: 'auto', label: 'Auto' }].map(Object.freeze));
  const BASE_WINDOW_W = 752; // geometry::ISLAND_WINDOW.0: the notch can never outgrow the window it is drawn in
  function sizeScale(setting, areaW, _areaH) {
    const fixed = { s: 0.85, m: 1, l: 1.25 };
    let k = 1;
    if (setting === 'auto') k = areaW >= 2400 ? 1.25 : areaW >= 1800 ? 1.1 : 1;
    else if (Object.prototype.hasOwnProperty.call(fixed, setting)) k = fixed[setting];
    if (Number.isFinite(areaW) && areaW > 0 && BASE_WINDOW_W * k > areaW) k = areaW / BASE_WINDOW_W;
    return k;
  }

  // ---- S12: the compact pill fits its content ----
  const COMPACT = Object.freeze({ h: 32, radius: 16, padLeft: 8, padRight: 10, gap: 16, koda: 24, min: 96, max: 420, kodaOnly: 40 });
  function compactWidth(textW) {
    const t = Number.isFinite(textW) && textW > 0 ? Math.ceil(textW) : 0;
    if (!t) return COMPACT.kodaOnly; // nothing to say: just Koda in a small capsule (8 + 24 + 8); text pill: padLeft 8 + Koda 24 + gap 16 (the state dot lives in that gap) + text + padRight 10
    return Math.max(COMPACT.min, Math.min(COMPACT.max, COMPACT.padLeft + t + COMPACT.gap + COMPACT.koda + COMPACT.padRight));
  }

  // ---- «Marcar todo como leído»: the exact-id verb once per notice; one refusal never stops the rest and is reported ----
  async function dismissAll(dismiss, ids) {
    const list = Array.isArray(ids) ? ids : [];
    if (typeof dismiss !== 'function') return { done: 0, failed: list.length, snapshot: null };
    const results = await Promise.allSettled(list.map(id => { try { return Promise.resolve(dismiss(id)); } catch (e) { return Promise.reject(e); } }));
    const ok = results.filter(r => r.status === 'fulfilled');
    const snaps = ok.map(r => r.value).filter(v => v && Array.isArray(v.notices));
    return { done: ok.length, failed: results.length - ok.length, snapshot: snaps.length ? snaps[snaps.length - 1] : null };
  }
  const dismissFeedback = r => (!r || !r.failed ? '' : r.failed === 1 ? '1 aviso no se pudo marcar como leído.' : `${r.failed} avisos no se pudieron marcar como leídos.`);

  return { dismissAll, dismissFeedback, TABS, step, arrows, wheelStep, keyStep, VEIL, veilState, agentRows, AGENT_ROWS, AGENT_ROWS_LINKED, moreAgents, STATE_WORD, clockText, noticeLines, agentHex, focusView, veilColor, noticeAgentColor, takeoverState, chatInert, takeoverTitle, sendCheck, requestId, replyLine, DRAFT_MAX, SIZES, sizeScale, COMPACT, compactWidth, shortTitle };
});
