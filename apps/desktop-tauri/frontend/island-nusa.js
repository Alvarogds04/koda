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

  // island-free-drag S3: the fitted compact pill (HU-057 S12) is GONE — compact is only the disc, whose box lives in ONE place
  // (island-layout.js COMPACT_DOT_W/H = geometry::COMPACT_DOT). No width model here.

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

  // ---- K2-13 T6b-1 «Hoy» (S2/S3/S5/S13/S17/S19): the island's day ----
  // The daemon's folded `hoy` view (agentclient.rs) says what happened; this model only decides how it is SAID. Everything the
  // daemon or a model wrote is untrusted text: it is cleaned of control characters, of the WHOLE Unicode Cf category
  // (\p{Cf}: bidi overrides, zero-width, word joiners, tag letters, soft hyphens…) and of the U+2028/U+2029 line and
  // paragraph separators (Zl/Zp), collapsed and capped here, and the mount writes it with textContent — never as markup.
  // The first version listed only the bidi ranges (U+200B-200F, 202A-202E, 2066-2069, FEFF) and let the rest through (F2).
  const HOY_TABS = Object.freeze([
    Object.freeze({ id: 'propuestas', title: 'Propuestas' }),
    Object.freeze({ id: 'resultados', title: 'Resultados' }),
    Object.freeze({ id: 'errores', title: 'Errores' }),
  ]);
  const HOY_GROUP = Object.freeze({ proposal: 'propuestas', result: 'resultados', error: 'errores' });
  // the closed Spanish verbs («action label in Spanish») — the wire words buy / sell / send are never shown
  const HOY_ACTION = Object.freeze({ buy: 'Comprar', sell: 'Vender', send: 'Enviar' });
  const HOY_VERB = Object.freeze({ buy: 'Proponer una compra', sell: 'Proponer una venta', send: 'Proponer un envío' });
  // S19: where the text of a video result came from. The daemon does not send it yet; the chip appears when it does.
  // S19/F4: the closed list the daemon sends on a result item; unknown values draw no chip
  const HOY_PROVENANCE = Object.freeze({ youtube_subtitles: 'subtítulos de YouTube', local_transcription: 'transcripto en esta PC', remote_transcription: 'transcripto con tu cuenta' });
  // a refused approval is read by its CLOSED code (protocol.cjs), never by free text from the daemon
  const HOY_REFUSAL = Object.freeze({
    not_pending: 'Esa propuesta ya no espera tu respuesta.',
    unknown_item: 'El daemon ya no tiene esa propuesta.',
    not_active: 'Ese Minikoda no está activo.',
    unknown_minikoda: 'Ese Minikoda ya no existe.',
    paused: 'Los Minikodas están en pausa: no se aprobó nada.',
    unavailable: 'El daemon no está disponible ahora.',
    failed: 'El daemon no pudo registrar la decisión.',
  });
  const FORMAT_CHARS = /[\p{Cf}\u2028\u2029]/gu;
  const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
  function hoyClean(text, max) {
    const s = String(text == null ? '' : text).replace(FORMAT_CHARS, '').replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
    const a = Array.from(s);
    const cap = Number.isFinite(max) && max > 1 ? max : 120;
    return a.length > cap ? `${a.slice(0, cap - 1).join('').trimEnd()}…` : s;
  }
  function hoyTime(iso, now) {
    const d = new Date(String(iso == null ? '' : iso));
    if (Number.isNaN(d.getTime())) return '';
    const t = new Date(Number.isFinite(now) ? now : Date.now());
    const p = n => String(n).padStart(2, '0');
    const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    if (same(d, t)) return `${p(d.getHours())}:${p(d.getMinutes())}`;
    if (same(d, new Date(t.getFullYear(), t.getMonth(), t.getDate() - 1))) return 'ayer';
    return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  }
  function hoyCounts(view) {
    const items = view && Array.isArray(view.items) ? view.items : [];
    const c = { pending: 0, propuestas: 0, resultados: 0, errores: 0, truncated: !!(view && view.truncated === true) };
    for (const i of items) {
      if (!i || typeof i !== 'object') continue;
      const tab = HOY_GROUP[i.kind];
      if (!tab) continue;
      // the Propuestas number is what WAITS, not what happened (the artboard): a decided proposal keeps its row all day
      // but stops being counted, and the tab can read 0 while it still lists yesterday's decisions as history.
      if (tab === 'propuestas') { if (i.status === 'pending') { c.pending += 1; c.propuestas += 1; } } else c[tab] += 1;
    }
    return c;
  }
  // Propuestas is the opening tab only while something waits (the artboard); the human's own tab is kept otherwise.
  function hoyTab(counts, current) {
    const ids = HOY_TABS.map(t => t.id);
    if (typeof current === 'string' && ids.includes(current)) return current;
    return counts && counts.pending > 0 ? 'propuestas' : 'resultados';
  }
  function hoyTabKey(e, index) {
    if (!e || e.isTrusted !== true || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return null;
    const last = HOY_TABS.length - 1;
    const at = Number.isInteger(index) && index >= 0 && index <= last ? index : 0;
    if (e.key === 'ArrowRight') return Math.min(last, at + 1);
    if (e.key === 'ArrowLeft') return Math.max(0, at - 1);
    if (e.key === 'Home') return 0;
    if (e.key === 'End') return last;
    return null;
  }
  const HOY_STATE = Object.freeze({ approved: 'Aprobada · se ejecutó', rejected: 'Rechazada · no se hizo nada' });
  /** One sentence into «what failed» + «what was kept»: the daemon already writes it as prose; we never invent a word. */
  function hoySplit(text) {
    const s = hoyClean(text, 400);
    const at = s.indexOf('. ');
    if (at > 12 && at <= 140) return [s.slice(0, at + 1), s.slice(at + 2)];
    return [hoyClean(s, 140), ''];
  }
  // B3: the target of a proposal is what a buy / sell / send is ABOUT, and the recipient of a send lives at its end. The
  // daemon bounds it at 200, so the page shows all 200 and lets the row grow and the list scroll: a cut target is a
  // decision made blind. The row's other lines keep their own bounds.
  const HOY_TARGET_MAX = 200, HOY_TITLE_MAX = 140, HOY_SUB_MAX = 220, HOY_FULL_MAX = 1200;
  function hoyRow(item, now) {
    const tab = HOY_GROUP[item && item.kind];
    if (!tab || typeof item.id !== 'string' || !item.id) return null;
    const when = hoyTime(item.createdAt, now);
    const source = hoyClean(item.minikoda, 40);
    const stamp = [source, when].filter(Boolean).join(' · ');
    const text = hoyClean(item.text, HOY_FULL_MAX);
    const pending = tab === 'propuestas' && item.status === 'pending';
    const action = tab === 'propuestas' && Object.prototype.hasOwnProperty.call(HOY_ACTION, item.action) ? item.action : '';
    let title = '', sub = '', chip = '', state = '';
    if (tab === 'propuestas') {
      const target = hoyClean(item.target, HOY_TARGET_MAX);
      title = action ? `${HOY_ACTION[action]} ${target}` : `${HOY_VERB[item.action] || 'Propuesta'}${target ? `: ${target}` : ''}`;
      sub = [stamp, hoyClean(text, 60)].filter(Boolean).join(' · ');
      // the artboard's words: «Aprobada · se ejecutó · 09:46» (when it ran) and «Rechazada · no se hizo nada» (no time: nothing ran)
      if (!pending && HOY_STATE[item.status]) state = `${HOY_STATE[item.status]}${item.status === 'approved' && item.decidedAt ? ` · ${hoyTime(item.decidedAt, now)}` : ''}`.trim();
    } else if (tab === 'resultados') {
      title = stamp || 'Resultado';
      sub = text;
      chip = Object.prototype.hasOwnProperty.call(HOY_PROVENANCE, item.provenance) ? HOY_PROVENANCE[item.provenance] : '';
    } else {
      const [head, rest] = hoySplit(text);
      title = hoyClean(head, HOY_TITLE_MAX) || 'Un Minikoda falló';
      sub = [stamp, rest].filter(Boolean).join(' · ');
    }
    if (tab !== 'propuestas') title = hoyClean(title, HOY_TITLE_MAX); // a proposal's title IS its target: shown whole
    sub = hoyClean(sub, HOY_SUB_MAX);
    const full = hoyClean(text, HOY_FULL_MAX);
    // `status` is the CLOSED state the CSS keys on (pending / approved / rejected, and `info` for what is only read):
    // `state` is the sentence a person reads («Aprobada · se ejecutó · 09:46»), never a value selector.
    const status = tab === 'propuestas' ? (item.status === 'approved' || item.status === 'rejected' ? item.status : 'pending') : 'info';
    return {
      id: item.id, tab, kind: item.kind, action, pending, status, state, title, sub, chip, full, when,
      approve: `Aprobar: ${title}`, reject: `Rechazar: ${title}`,
      actions: pending,
      aria: [title, sub, pending ? 'Espera tu sí.' : state].filter(Boolean).join('. '),
    };
  }
  function hoyRows(view, now) {
    const items = view && Array.isArray(view.items) ? view.items : [];
    const out = [];
    for (const item of items) {
      const row = hoyRow(item, now);
      if (row) out.push(row);
    }
    return out;
  }
  function hoySummary(counts) {
    const c = counts || { pending: 0, resultados: 0 };
    const wait = c.pending === 0 ? 'Nada espera tu sí' : `${c.pending} ${c.pending === 1 ? 'espera' : 'esperan'} tu sí`;
    return `${wait} · ${c.resultados} ${c.resultados === 1 ? 'resultado' : 'resultados'}`;
  }
  function hoyEmpty(tab) {
    if (tab === 'propuestas') return 'Nada espera tu sí.';
    if (tab === 'resultados') return 'Todavía no hay resultados hoy.';
    if (tab === 'errores') return 'Ningún aviso: todo salió bien.';
    return 'Nada en esta pestaña.';
  }
  const hoyRefusal = code => (Object.prototype.hasOwnProperty.call(HOY_REFUSAL, typeof code === 'string' ? code : '') ? HOY_REFUSAL[code] : HOY_REFUSAL.failed);

  // ---- a decision in flight (verifier mwdtsadz B1/B2) ----
  // AgentConn::command hands the page the state at WRITE time (`self.view()` right after sending), and the daemon's
  // answer to a decision arrives later as `agent:state` — the contract settings.js documents. So NOTHING is judged from
  // the reply: the decision is held until the daemon's own state shows that row moved or its error counter moved, and
  // the deadline says it does not know instead of guessing either way. Until then every decision on the panel is closed.
  const HOY_WAIT_MS = 3000;        // how long one decision waits for the daemon before its outcome is «no sabemos»
  const HOY_CLICK_GUARD_MS = 400;  // a click this soon after a repaint that moved rows hits a row nobody chose
  /** The daemon's error counter: how the page tells «an error arrived AFTER my command» without reading its text. */
  function hoyErrorN(view) {
    const n = view && view.last_error ? view.last_error.n : 0;
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }
  /**
   * One decision against one view the page received (the write-time reply or an `agent:state`).
   * `beforeN` is `hoyErrorN` captured when the command left. `{state:'ok'}` only when the daemon's row carries the
   * wanted status; `{state:'refused', code}` only when its counter moved; anything else is still waiting.
   */
  function hoyDecision(beforeN, after, id, want) {
    const items = after && after.hoy && Array.isArray(after.hoy.items) ? after.hoy.items : null;
    const row = items ? items.find(i => i && i.id === id) : null;
    if (row && row.status === want) return { state: 'ok' };
    const from = Number.isFinite(beforeN) && beforeN > 0 ? beforeN : 0;
    if (hoyErrorN(after) > from) return { state: 'refused', code: after.last_error && after.last_error.code };
    return { state: 'waiting' };
  }
  /** A read («hoy_list» / «view») has no click to confirm: it either brings the day or the daemon's closed reason (F5). */
  function hoyReadProblem(beforeN, view) {
    if (!view || typeof view !== 'object') return HOY_REFUSAL.unavailable;
    if (typeof view.connection === 'string' && view.connection !== 'connected') return HOY_REFUSAL.unavailable;
    const from = Number.isFinite(beforeN) && beforeN > 0 ? beforeN : 0;
    if (hoyErrorN(view) > from) return hoyRefusal(view.last_error && view.last_error.code);
    return '';
  }
  /**
   * The order rows are DRAWN in: ids already on screen keep the place they had (a decided row never sinks while the
   * panel is open, so the buttons under the cursor never become another proposal's), and ids seen for the first time
   * follow in the daemon's own order.
   */
  function hoyOrder(previous, rows) {
    const list = Array.isArray(rows) ? rows.filter(r => r && typeof r.id === 'string') : [];
    const seen = Array.isArray(previous) ? previous : [];
    if (!seen.length) return list;
    const rank = new Map(seen.map((id, i) => [id, i]));
    const kept = list.filter(r => rank.has(r.id)).sort((a, b) => rank.get(a.id) - rank.get(b.id));
    return kept.concat(list.filter(r => !rank.has(r.id)));
  }
  /**
   * F6: motion is reduced when the app's own switch says so OR when the OS asks for it. The first version read only
   * `html[data-motion="reduce"]`, so a system set to reduce motion still animated the grown box.
   */
  const motionReduced = (motionAttr, mediaMatches) => motionAttr === 'reduce' || mediaMatches === true;
  /** A click is honoured only once the rows have been still for `HOY_CLICK_GUARD_MS` (an armed guard, not a moving one). */
  const hoyGuardOpen = (movedAt, now) => !(Number.isFinite(movedAt) && movedAt > 0) || !Number.isFinite(now) || now - movedAt >= HOY_CLICK_GUARD_MS;

  return { dismissAll, dismissFeedback, TABS, step, arrows, wheelStep, keyStep, VEIL, veilState, agentRows, AGENT_ROWS, AGENT_ROWS_LINKED, moreAgents, STATE_WORD, clockText, noticeLines, agentHex, focusView, veilColor, noticeAgentColor, takeoverState, chatInert, takeoverTitle, sendCheck, requestId, replyLine, DRAFT_MAX, SIZES, sizeScale, shortTitle,
    HOY_TABS, HOY_ACTION, HOY_STATE, HOY_PROVENANCE, hoyClean, hoyCounts, hoyTab, hoyTabKey, hoyRows, hoySummary, hoyEmpty, hoyRefusal, hoySplit,
    HOY_WAIT_MS, HOY_CLICK_GUARD_MS, HOY_TARGET_MAX, motionReduced, hoyErrorN, hoyDecision, hoyReadProblem, hoyOrder, hoyGuardOpen };
});
