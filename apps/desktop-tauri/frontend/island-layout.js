'use strict';
/* Expanded island layout «A + E» (human decision 21/10, validacion/ESQUEMA-isla-A-E.md).
   A  = three columns: Abito's status | the centre (where everything is done) | the blobs (agent sessions AND declared pills).
   E  = focus mode while something waits for the human: a question/approval takes left + centre, the blobs shrink to mascots.
   Pure view-model first (Node-testable, no DOM): widths, the real counts, which row a pending question may be attributed to, the
   blob rows, the layout mode and the approval look. The browser-only mount at the tail feeds them from the events the island
   already has. Loaded as a classic script (window.AbitoIslandLayout) and by test-node/island-layout-check.cjs. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }
  root.AbitoIslandLayout = Object.freeze(api);
  mount(api);
})(typeof self !== 'undefined' ? self : this, () => {
  // ---- widths ---------------------------------------------------------------------------------------------------------------
  // The overview inner width is 700 (island 720 - 2 x 10). Left column = Abito's mascot + status (108, Coucou's 108px indent),
  // centre >= 330, blobs >= 150 (mascot 28 + a name of 12 characters + the status dot). Focus: the card takes left + centre and the
  // blobs keep a 64px mascot column. A width that cannot honour the minimums says so instead of squeezing the centre.
  const W = Object.freeze({ status: 108, gap: 8, centreMin: 330, blobsPref: 174, blobsMin: 150, focusBlobs: 64 });
  function columnWidths(total, focus) {
    const none = { fits: false, focus: !!focus, status: W.status, centre: 0, gap: W.gap, blobs: 0, main: 0 };
    if (!Number.isFinite(total) || total <= 0) return none;
    if (focus) {
      const centre = total - W.status - W.gap - W.focusBlobs;
      return centre >= W.centreMin ? { fits: true, focus: true, status: W.status, centre, gap: W.gap, blobs: W.focusBlobs, main: W.status + centre } : none;
    }
    const room = total - W.status - W.gap;
    let blobs = W.blobsPref, centre = room - blobs;
    if (centre < W.centreMin) { centre = W.centreMin; blobs = room - centre; }
    return blobs >= W.blobsMin ? { fits: true, focus: false, status: W.status, centre, gap: W.gap, blobs, main: W.status + centre } : none;
  }

  // ---- the real counts (sessions the daemon reports + the real queue), never rows rendered ----------------------------------------
  const MAX_QUEUED = 7; // the queue holds 8 in total: the one on screen + at most 7 waiting
  const isRunning = r => !!r && (r.state === 'running' || !!(r.tools && Array.isArray(r.tools.steps) && r.tools.steps.some(s => s.state === 'running')));
  function statusCounts(o) {
    const view = o && o.view && o.view.state === 'ready' && Array.isArray(o.view.rows) ? o.view : null;
    const approx = !!(view && view.truncated);
    const active = view ? view.rows.filter(isRunning).length : 0;
    const queued = Number.isInteger(o && o.queuedCount) && o.queuedCount >= 0 && o.queuedCount <= MAX_QUEUED ? o.queuedCount : 0;
    const waiting = o && o.pending ? 1 + queued : 0;
    const lines = [];
    if (active > 0) lines.push(`${active}${approx ? '+' : ''} ${active === 1 ? 'activa' : 'activas'}`);
    if (waiting > 0) lines.push(`${waiting} ${waiting === 1 ? 'espera' : 'esperan'}`);
    return { active, waiting, approx, lines: lines.length ? lines : ['En reposo'] };
  }

  // ---- attribution: the pending question belongs to a session row only when it is unambiguous -------------------------------------
  const SLUG = /^[a-z0-9][a-z0-9._-]{0,31}$/;
  const KIND_BY_SLUG = Object.freeze({ pi: 'Pi', 'claude-code': 'Claude Code', codex: 'Codex', opencode: 'OpenCode', gemini: 'Gemini' });
  function attribute(pending, rows) {
    if (!pending || typeof pending !== 'object' || !Array.isArray(rows)) return null;
    const slug = typeof pending.agent === 'string' && SLUG.test(pending.agent) ? pending.agent : null;
    const kind = slug && KIND_BY_SLUG[slug];
    if (!kind) return null;
    let candidates = rows.filter(r => r && r.kindLabel === kind);
    const project = typeof pending.project_name === 'string' && pending.project_name ? pending.project_name : (typeof pending.projectName === 'string' && pending.projectName ? pending.projectName : null);
    if (project) candidates = candidates.filter(r => r.cwd === project);
    return candidates.length === 1 && typeof candidates[0].id === 'string' ? candidates[0].id : null;
  }

  // ---- the right column ---------------------------------------------------------------------------------------------------------
  const NAME_MAX = 24;
  const bound = (t, max) => { const a = Array.from(String(t)); return a.length > max ? `${a.slice(0, max - 1).join('')}…` : a.join(''); };
  const STATUS_WORD = Object.freeze({ working: 'trabajando', idle: 'en reposo', needs: 'te necesita', news: 'con novedades' });
  /**
   * One row per blob. The human's DECLARED pills (Abito, specialists, integrations) always come first and are never pushed out;
   * the agent sessions follow. No cap of four: the column scrolls. Status dot: working / idle / needs (a pending question
   * attributed to THIS row) / news (an unseen integration event).
   */
  // S4 (abito-avisos-ux): the Abito project folder is shown as «Abito» (same rule as AbitoNotify.projectLabel; display only)
  const projectLabel = name => (typeof name === 'string' && /^sb-second-brain$/i.test(name.trim()) ? 'Koda' : name);
  function blobRows(o) {
    if (!o || typeof o !== 'object') return [];
    const badges = o.badges instanceof Set ? o.badges : new Set();
    const rows = [];
    for (const d of Array.isArray(o.declared) ? o.declared : []) {
      if (!d || typeof d !== 'object' || typeof d.id !== 'string' || typeof d.name !== 'string' || !d.name) continue;
      const status = badges.has(d.id) ? 'news' : 'idle';
      const name = bound(d.name, NAME_MAX);
      rows.push({ id: d.id, kind: d.kind || 'pill', name, color: d.color || 'blue', status, focused: d.id === o.focusId, aria: `${name} · ${STATUS_WORD[status]}` });
    }
    for (const s of Array.isArray(o.sessions) ? o.sessions : []) {
      if (!s || typeof s !== 'object' || typeof s.id !== 'string') continue;
      const name = bound(projectLabel(s.cwd) || s.kindLabel || 'Sesión', NAME_MAX);
      const status = o.attributedId && o.attributedId === s.id ? 'needs' : isRunning(s) ? 'working' : 'idle';
      rows.push({ id: s.id, kind: 'session', name, color: s.color || 'blue', status, focused: s.id === o.focusId,
        agent: s.kindLabel || '', aria: `${name} · ${s.kindLabel || 'Sesión'} · ${STATUS_WORD[status]}` });
    }
    return rows;
  }
  /** Focus mode keeps a 64px mascot column: up to four mascots, else three and «+N». */
  function focusOverflow(rows) {
    if (!Array.isArray(rows) || !rows.length) return { shown: [], more: 0 };
    return rows.length <= 4 ? { shown: rows.slice(), more: 0 } : { shown: rows.slice(0, 3), more: rows.length - 3 };
  }

  // ---- the mode ---------------------------------------------------------------------------------------------------------------
  /** Focus ONLY while something waits for the human; it ends with the question (answered, expired, cancelled, terminal won). */
  const layoutMode = d => (d && (d.question === 'pending' || d.card === 'pending') ? 'focus' : 'normal');

  // ---- approvals: «!», the command in a mono box, «Rechazar N / Aprobar Y» ---------------------------------------------------------
  // The harness (Claude Code / Codex / Copilot) words a permission as a QUESTION «<Agent> asks permission: <Tool>: <detail>» with the
  // exact options «Allow once» / «Deny». Only that exact pair maps to Aprobar / Rechazar, by LABEL never by position; a lossy request
  // («Decide in the terminal», no allow) or any other wording stays an ordinary numbered list. Pi's own kind=approval keeps its two
  // labels. The click always sends the option INDEX: the host maps it to the emitted option, nothing here decides anything.
  const ASKS = /^(.+?) asks permission(?: for)?:? (.*)$/s;
  const PIDE = /^([^\s¿¡?][^\n]*?) pide permiso para (\S.*)$/s;
  // a lossy request (details only in the terminal) never gets an approve button, whatever its labels
  const LOSSY_ES = /detalles solo en la terminal; decidir en la terminal\)\s*$/;
  const TOOL = /^([A-Za-z_][A-Za-z0-9_.-]{0,40}): (.*)$/s;
  function approvalView(n, agentLabel) {
    if (!n || typeof n !== 'object' || !Array.isArray(n.options) || n.options.length !== 2 || n.allowFreeText === true) return null;
    const label = typeof agentLabel === 'string' && agentLabel ? agentLabel : 'El agente';
    if (n.kind === 'approval') {
      // v8 S9: Pi's own approval. The exact pair «Aprobar»/«Rechazar» (matched by LABEL, never by position) gets the MD layout
      // (Rechazar N | Aprobar Y, Aprobar primary); any other wording keeps its own labels and order with numeric keys. The title is the
      // S28-short «Ejecutar:» when the text names a command, else «Permiso:».
      const text = String(n.text || '');
      const ex = /^[¿]?\s*(?:me das )?permiso para ejecutar:?\s*([\s\S]*?)\??\s*$/i.exec(text);
      const yes = n.options.find(o => o.label === 'Aprobar'), no = n.options.find(o => o.label === 'Rechazar');
      const known = yes && no && yes !== no;
      return { badge: '!', title: ex ? 'Ejecutar:' : 'Permiso:', tool: null, command: ex ? ex[1] : text, secretsHidden: false,
        actions: known ? [{ role: 'reject', label: 'Rechazar', key: 'N', index: no.index }, { role: 'approve', label: 'Aprobar', key: 'Y', index: yes.index }]
          : n.options.map((o, i) => ({ role: 'option', label: o.label, key: String(i + 1), index: o.index })) };
    }
    // Two producer wordings, each only with ITS OWN exact pair: English «asks permission» + Allow once/Deny (Copilot-style), and the
    // Claude Code / Codex hook's «<Agente> pide permiso para …» + «Aprobar una vez»/«Rechazar» (hook-common.cjs). The approve label is kept.
    const text = n.kind === 'question' && typeof n.text === 'string' ? n.text : '';
    const en = ASKS.exec(text), es = en ? null : (LOSSY_ES.test(text) ? null : PIDE.exec(text));
    const m = en || es;
    if (!m) return null;
    const pair = en ? ['Allow once', 'Deny', 'Aprobar'] : ['Aprobar una vez', 'Rechazar', 'Aprobar una vez'];
    const allow = n.options.find(o => o.label === pair[0]), deny = n.options.find(o => o.label === pair[1]);
    if (!allow || !deny || allow === deny) return null;
    let detail = m[2].trim();
    const hiddenTag = en ? / \(secrets hidden\)$/ : / \(secretos ocultos\)$/;
    const secretsHidden = hiddenTag.test(detail);
    if (secretsHidden) detail = detail.replace(hiddenTag, '');
    const t = TOOL.exec(detail);
    const tool = t ? t[1] : null, command = t ? t[2] : detail;
    return { badge: '!', title: tool === 'Bash' ? 'Ejecutar:' : 'Permiso:', tool, command, secretsHidden,
      actions: [{ role: 'reject', label: 'Rechazar', key: 'N', index: deny.index }, { role: 'approve', label: pair[2], key: 'Y', index: allow.index }] };
  }
  /** Y approves / N rejects, only for the known pair, from a trusted unmodified key, never while typing. -1 = not ours. */
  function approvalKey(event, view, ctx) {
    if (!view || !event || event.isTrusted !== true || event.isComposing || event.repeat || event.ctrlKey || event.altKey || event.metaKey) return -1;
    if (ctx && ctx.typing) return -1;
    const k = String(event.key).toLowerCase();
    const role = k === 'y' ? 'approve' : k === 'n' ? 'reject' : null;
    const action = role && view.actions.find(a => a.role === role);
    return action ? action.index : -1;
  }

  // ---- G: the state badge rides the mascot (Coucou core/layout.ts botPosition: centre - (20, 21); the badge is a 16px disc) ----
  /** `box` = the mascot's own rendered box { left, top, size } in the island's coordinates. */
  function badgePosition(box) {
    if (!box || ![box.left, box.top, box.size].every(Number.isFinite)) return null;
    return { left: box.left + box.size / 2 - 20 - 8, top: box.top + box.size / 2 - 21 - 8 };
  }

  // ---- E: the centre shows the focused session -----------------------------------------------------------------------------------
  /** The session the centre shows: the human's selection if it still exists, else the attributed pending question's session, else
   *  the first one that is working (a running tool counts), else the first the daemon lists (it sorts most recent first). */
  function pickFocus(rows, selectedId, attributedId, tickerId) {
    if (!Array.isArray(rows) || !rows.length) return null;
    const has = id => typeof id === 'string' && rows.some(r => r && r.id === id);
    // ONE source of truth: the ticker's own focus (sessions-ticker.js memory.focus). It also drives the ↗ jump and the terminal
    // shortcut, and it moves for every cause (a blob click, the compact bar's mini mascot, the «principal» preference), so the centre
    // can never name a different session than the one the jump opens (screen gate: focused «proyecto-beta», centre «workspace»).
    if (has(tickerId)) return tickerId;
    if (has(selectedId)) return selectedId;
    if (has(attributedId)) return attributedId;
    const working = rows.find(isRunning);
    return (working || rows[0]).id || null;
  }
  const STATE_WORD = Object.freeze({ working: 'Trabajando', idle: 'En reposo', waiting: 'Te espera', error: 'Con error' });
  const STEP_LINES = 2, CENTRE_NAME_MAX = 32;
  /** What the centre draws for one session: its real state (never invented) and its real tool steps (none -> no step lines at all). */
  function centreView(row, ctx) {
    if (!row || typeof row !== 'object' || typeof row.id !== 'string') return null;
    const name = bound(projectLabel(row.cwd) || row.kindLabel || 'Sesión', CENTRE_NAME_MAX), agent = row.kindLabel || '';
    const tools = row.tools && Array.isArray(row.tools.steps) ? row.tools : null;
    const raw = tools ? tools.steps : [];
    const running = raw.some(s => s.state === 'running');
    let state = running || row.state === 'running' ? 'working' : raw.at(-1) && raw.at(-1).state === 'error' ? 'error' : 'idle';
    if (ctx && ctx.attributedId && ctx.attributedId === row.id) state = 'waiting';
    const shown = raw.slice(-STEP_LINES);
    const cur = running ? shown.map(x => x.state).lastIndexOf('running') : shown.length - 1;
    const steps = shown.map((x, i) => ({ index: x.index, name: x.name, state: x.state, current: i === cur }));
    return { id: row.id, name, agent, state, stateWord: STATE_WORD[state], steps,
      count: tools && raw.length ? `${raw.at(-1).index}/${tools.total}` : '',
      aria: `${name} · ${agent} · ${STATE_WORD[state].toLowerCase()}` };
  }

  // ---- I: the empty centre ---------------------------------------------------------------------------------------------------------
  /** Calm + a way forward. A failed list is NOT calm (the engine row owns that), and anything waiting or finished owns the centre. */
  function emptyView(o) {
    if (!o || o.pending || o.finished) return null;
    const v = o.view;
    if (v && v.state === 'error') return null;
    if (v && v.state === 'ready' && Array.isArray(v.rows) && v.rows.length) return null;
    return { title: 'Todo tranquilo', sub: 'Arrastrá un archivo o preguntá.', cta: { label: 'Preguntar a Koda', action: 'new-chat' } };
  }

  // ---- D: «Pi terminó» in the centre, the result untruncated ----------------------------------------------------------------------
  const CARD_MIN = 108, FINISHED_MAX_ISLAND = 332, OFFSET = 52;
  /** The finished card wraps its result, so it may need more than the 108px overview card: it asks for the height it needs, capped
   *  like a question (and by what the host granted), then scrolls inside. */
  function finishedLayout(contentH, maxIslandH) {
    const h = Number.isFinite(contentH) && contentH > 0 ? Math.ceil(contentH) : 0;
    const cap = Number.isFinite(maxIslandH) && maxIslandH > 0 ? Math.floor(maxIslandH) : FINISHED_MAX_ISLAND;
    const max = Math.max(CARD_MIN, cap - OFFSET);
    const cardH = Math.min(max, Math.max(CARD_MIN, h));
    return { cardH, islandH: cardH + OFFSET, scroll: h > max };
  }

  // ---- the blobs list shows WHOLE rows: its height is n rows + (n-1) gaps; whatever is left of the card is padding, never a sliver ------
  const ROW = Object.freeze({ h: 22, gap: 2, min: 3, pad: 1 });
  function rowsViewport(avail) {
    const room = Number.isFinite(avail) && avail > 0 ? avail : 0;
    const rows = Math.max(ROW.min, Math.floor((room - ROW.pad * 2 + ROW.gap) / (ROW.h + ROW.gap)));
    const height = rows * ROW.h + (rows - 1) * ROW.gap + ROW.pad * 2; // the list's own 1px top/bottom padding is inside its box
    return { rows, height, rest: Math.max(0, Math.round(room - height)) };
  }

  // ---- tooltips: the island draws its own (WebKitGTK may not paint `title` in this undecorated, transparent, focus:false window) -----------
  const TIP_MAX = 160;
  const CTRL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;
  function tipFor(o) {
    if (!o || typeof o.title !== 'string') return '';
    const t = Array.from(o.title.replace(CTRL, ' ').replace(/\s+/g, ' ').trim());
    const text = t.length > TIP_MAX ? `${t.slice(0, TIP_MAX - 1).join('')}…` : t.join('');
    const seen = typeof o.visibleText === 'string' ? o.visibleText.replace(/\s+/g, ' ').trim() : '';
    return text && text !== seen ? text : '';
  }
  function tipPlacement(at, box) {
    const w = at.w || 120, h = at.h || 18, W = box.w, H = box.h;
    const left = Math.max(4, Math.min(at.x, W - w - 4));
    const below = at.y + h;
    return { left, top: below + 24 > H ? Math.max(4, at.y - h - 8) : below };
  }

  // ---- T1 · S1 (01 oculta, A): the hidden island is ONE thread whose colour is the most urgent state -----------------------------
  const EDGE_STRIP = Object.freeze({ w: 160, h: 3, zone: 8 });
  function edgeStripView(o) {
    const pending = o && (o.pending === 'question' || o.pending === 'approval') ? o.pending : null;
    const queued = o && Number.isInteger(o.queued) && o.queued > 0 && o.queued <= MAX_QUEUED ? o.queued : 0;
    if (pending) {
      const n = 1 + queued;
      const what = pending === 'approval' ? (n === 1 ? 'un permiso espera' : `${n} permisos esperan`) : (n === 1 ? 'una pregunta espera' : `${n} preguntas esperan`);
      return { state: pending, pulse: true, aria: `Koda: ${what}` };
    }
    if (o && o.finished) return { state: 'finished', pulse: true, aria: 'Koda: algo terminó' };
    return { state: 'rest', pulse: false, aria: 'Koda, en reposo' };
  }

  // ---- T1 · S2 (02 compacta, A): the mascot + up to 3 coloured mini-mascots + «+N», the real activity line, a state badge -----------
  const COMPACT_W = 288, COMPACT_WIDE = 440, COMPACT_ASK = 560, MINIS = 3;
  function compactView(o) {
    const rows = o && Array.isArray(o.rows) ? o.rows.filter(r => r && typeof r.id === 'string') : [];
    const pending = o && o.pending && typeof o.pending === 'object' ? o.pending : null;
    const focus = rows.find(r => r.id === (o && o.focusId)) || rows.find(isRunning) || rows[0] || null;
    const minis = rows.slice(0, MINIS).map(r => ({ id: r.id, color: r.color || 'blue', name: bound(projectLabel(r.cwd) || r.kindLabel || 'Sesión', NAME_MAX), pose: isRunning(r) ? 'working' : 'idle' }));
    let activity = '', badge = '';
    if (focus) {
      const name = bound(projectLabel(focus.cwd) || focus.kindLabel || 'Sesión', 18);
      const step = focus.tools && Array.isArray(focus.tools.steps) ? focus.tools.steps.find(s => s.state === 'running') : null;
      activity = step ? `${name} · ${step.name}…` : name;
      if (isRunning(focus)) badge = 'working';
    }
    // S3 (03 alerta, A): a waiting question/permission widens the pill and shows its first line + «Responder»; no separate toast
    let reply = false;
    if (pending) {
      badge = approvalView(pending, '') ? 'approval' : (pending.kind === 'approval' ? 'approval' : 'question');
      const first = String(pending.text || '').split(/\r?\n/).map(l => l.trim()).find(Boolean) || '';
      const av = approvalView(pending, '');
      activity = bound(av ? `${av.title} ${av.command}` : first, 44); reply = true;
    } else if (o && o.notice && typeof o.notice === 'object' && (o.notice.kind === 'settled' || o.notice.kind === 'attention') &&
      typeof o.notice.title === 'string' && o.notice.title.trim()) {
      // HU-006 S4: a notice reads inside the compact pill at the width it already has; opening it stays the human's click (S6).
      activity = bound(o.notice.title.trim(), 44); badge = o.notice.kind === 'attention' ? 'attention' : 'finished';
    }
    return { minis: reply ? [] : minis, more: reply ? 0 : Math.max(0, rows.length - MINIS), activity, badge, reply, width: reply ? COMPACT_ASK : rows.length ? COMPACT_WIDE : COMPACT_W };
  }

  return { isRunning, tipFor, tipPlacement, ROW, rowsViewport, EDGE_STRIP, edgeStripView, compactView, pickFocus, centreView, emptyView, finishedLayout, STATE_WORD, badgePosition, W, columnWidths, statusCounts, attribute, blobRows, focusOverflow, layoutMode, approvalView, approvalKey, MAX_QUEUED };
});

function mount(L) {
  const doc = document;
  const capsule = doc.getElementById('capsule');
  const overview = doc.getElementById('overview-view');
  if (!capsule || !overview) return;
  const status = doc.getElementById('col-status');
  const centre = doc.getElementById('col-centre'), cState = doc.getElementById('centre-state'), cSteps = doc.getElementById('centre-steps');
  const cEmpty = doc.getElementById('centre-empty'), cta = doc.getElementById('centre-cta');
  let view = null, pending = null, queuedCount = 0, focusId = null, selectedId = null, finished = false, compactNotice = null;
  const state = { mode: 'normal', attributedId: null, counts: null };
  // the list is sized to a whole number of rows from the card's real inner height (it changes with the notices band and focus mode)
  const blobsCard = doc.getElementById('blobs'), blobsList = doc.getElementById('pill-choices');
  function fitList() {
    if (!blobsCard || !blobsList || typeof getComputedStyle !== 'function') return;
    const cs = getComputedStyle(blobsCard);
    const links = doc.getElementById('blobs-links');
    const avail = blobsCard.clientHeight - parseFloat(cs.paddingTop || 0) - parseFloat(cs.paddingBottom || 0) - (links && !links.hidden ? 16 : 0);
    const v = L.rowsViewport(avail);
    blobsList.style.maxHeight = `${v.height}px`; blobsList.style.flex = '0 0 auto'; blobsList.style.height = `${v.height}px`;
  }
  function publish() {
    fitList();
    const rows = view && view.state === 'ready' ? view.rows : [];
    const attributedId = L.attribute(pending, rows);
    const counts = L.statusCounts({ view, pending, queuedCount });
    state.attributedId = attributedId; state.counts = counts;
    if (status) {
      status.textContent = '';
      for (const line of counts.lines.slice(0, 2)) { const s = doc.createElement('span'); s.textContent = line; status.append(s); }
      status.setAttribute('aria-label', counts.lines.join(', '));
    }
    paintCentre(rows, attributedId);
    // the centre card already says «En reposo» for an idle focused session: the status column must not repeat it
    if (status && centre && centre.dataset.state === 'idle' && !counts.active && !counts.waiting) status.textContent = '';
    paintCompact(rows);
    doc.dispatchEvent(new CustomEvent('abito:layout', { detail: { attributedId, counts, mode: state.mode, focusId, running: rows.filter(L.isRunning).map(r => ({ kind: String(r.kindLabel || '').toLowerCase().replace(/\s+/g, '-'), cwd: r.cwd })) } }));
  }
  // One delegated tooltip for every element of the island that carries a title: hover (after a short delay) and keyboard focus show it,
  // leave/blur/Escape hide it. It never takes the pointer, so it cannot swallow a click.
  const tip = doc.getElementById('island-tip');
  if (tip) {
    let tipTimer = 0, tipFor = null;
    const hideTip = () => { clearTimeout(tipTimer); tipFor = null; tip.hidden = true; };
    // v6: WebKitGTK also paints the NATIVE title tooltip (a second, wrapped one that lingers). Inside the island every title moves to
    // data-tip (aria-label stays), so only #island-tip shows.
    const moveTitles = el => {
      for (let p = el; p && p.id !== 'island' && p.getAttribute; p = p.parentElement) {
        if (p.hasAttribute('title')) { const t = p.getAttribute('title'); if (t) p.setAttribute('data-tip', t); p.removeAttribute('title'); }
      }
    };
    const titled = el => { if (el && doc.getElementById('island') && doc.getElementById('island').contains(el)) moveTitles(el); return el && el.closest ? el.closest('[data-tip]') : null; };
    function showTip(el) {
      const text = L.tipFor({ title: el.getAttribute('data-tip'), visibleText: el.textContent });
      if (!text) return;
      const island = doc.getElementById('island').getBoundingClientRect(), b = el.getBoundingClientRect();
      tip.textContent = text; tip.hidden = false; tipFor = el; shownAt = Date.now();
      const p = L.tipPlacement({ x: b.left - island.left, y: b.top - island.top, w: Math.min(tip.offsetWidth || 160, 220), h: b.height }, { w: island.width, h: island.height });
      tip.style.left = `${p.left}px`; tip.style.top = `${p.top}px`;
    }
    // v8: a lost/synthetic pointer never sends pointerout: poll the row's hover/focus state and cap the tip at 6 s
    let shownAt = 0;
    setInterval(() => { if (tip.hidden || !tipFor) return; const active = (tipFor.matches && (tipFor.matches(':hover') || tipFor.matches(':focus-visible') || tipFor.contains(doc.activeElement))); if (!active || Date.now() - shownAt > 6000) hideTip(); }, 400);
    const arm = el => { clearTimeout(tipTimer); if (!el || el === tipFor) return; hideTip(); tipTimer = setTimeout(() => showTip(el), 350); };
    doc.addEventListener('pointerover', e => { const el = titled(e.target); if (el && doc.getElementById('island').contains(el)) arm(el); else hideTip(); });
    doc.addEventListener('pointerleave', hideTip); doc.addEventListener('pointerdown', hideTip, true);
    doc.addEventListener('pointerout', e => { const to = e.relatedTarget; if (!to || !doc.getElementById('island').contains(to)) hideTip(); });
    window.addEventListener('blur', hideTip);
    doc.addEventListener('focusin', e => { const el = titled(e.target); if (el && doc.getElementById('island').contains(el)) arm(el); });
    doc.addEventListener('focusout', hideTip);
    doc.addEventListener('keydown', e => { if (e.key === 'Escape') hideTip(); }, true);
  }
  // S1 + S2 + S3: the compact pill and the hidden thread, from the same real data.
  const strip = doc.getElementById('edge-strip');
  function paintCompact(rows) {
    const kind = pending ? (approvalView(pending, '') || pending.kind === 'approval' ? 'approval' : 'question') : null;
    const c = L.compactView({ rows, focusId, pending, notice: compactNotice });
    doc.dispatchEvent(new CustomEvent('abito:compact-view', { detail: c }));
    if (strip) {
      const e = L.edgeStripView({ pending: kind, queued: queuedCount, finished });
      strip.dataset.state = e.state; strip.dataset.pulse = String(e.pulse); strip.setAttribute('aria-label', e.aria);
    }
  }
  function approvalView(p, label) { return L.approvalView(p && Object.assign({}, p, { options: Array.isArray(p.options) ? p.options.map((o, i) => ({ index: Number.isInteger(o && o.index) ? o.index : i, label: String((o && o.label) || '') })) : [], allowFreeText: p && p.allow_free_text === true }), label); }
  // E + I: the centre column. Real state, real tool steps only; nothing waiting and nothing running -> the calm state with a CTA.
  function paintCentre(rows, attributedId) {
    if (!centre) return;
    const id = L.pickFocus(rows, selectedId, attributedId, focusId);
    const row = id ? rows.find(r => r.id === id) : null;
    const v = row ? L.centreView(row, { attributedId }) : null;
    const empty = v ? null : L.emptyView({ view, pending, finished });
    cState.hidden = !v; cSteps.hidden = !(v && v.steps.length); cEmpty.hidden = !empty;
    centre.dataset.state = v ? v.state : (empty ? 'empty' : 'none');
    if (v) {
      cState.children[0].textContent = v.name; cState.children[1].textContent = v.agent; cState.children[2].textContent = v.stateWord;
      cState.children[3].hidden = !v.count; cState.children[3].textContent = v.count;
      cState.dataset.state = v.state; cState.setAttribute('aria-label', v.aria);
      cSteps.replaceChildren(...v.steps.map(step => {
        const li = doc.createElement('li'); li.textContent = step.name; li.dataset.state = step.state; li.dataset.current = String(step.current); return li;
      }));
    }
    doc.dispatchEvent(new CustomEvent('abito:empty-shown', { detail: { shown: !!empty } }));
    if (empty) {
      cEmpty.querySelector('.centre-empty-title').textContent = empty.title;
      cEmpty.querySelector('.centre-empty-sub').textContent = empty.sub;
      cta.firstElementChild.textContent = empty.cta.label; cta.setAttribute('aria-label', empty.cta.label);
    }
  }
  doc.addEventListener('abito:finished-shown', e => { finished = !!(e.detail && e.detail.shown); publish(); });
  // HU-006: the notice the compact pill shows (display title only); null clears it
  doc.addEventListener('abito:compact-notice', e => { const n = e.detail; compactNotice = n && typeof n === 'object' ? { kind: n.kind, title: n.title } : null; publish(); });
  // the CTA is the header's own «+» (a new conversation): no new host verb
  if (cta) cta.addEventListener('click', event => { if (event.isTrusted === true) doc.dispatchEvent(new CustomEvent('abito:centre-new')); });
  function syncMode() {
    const mode = L.layoutMode({ question: capsule.dataset.question, card: capsule.dataset.card });
    if (mode === state.mode && capsule.dataset.layout === mode) return;
    state.mode = mode; capsule.dataset.layout = mode;
    publish();
  }
  doc.addEventListener('abito:sessions-view', e => { view = e.detail ? e.detail.view : null; focusId = e.detail ? e.detail.focusId : null; publish(); });
  const listen = window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen;
  const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) || (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) || null;
  const apply = snap => {
    if (!snap || typeof snap !== 'object') return;
    pending = snap.pending && typeof snap.pending === 'object' ? snap.pending : null;
    queuedCount = Number.isInteger(snap.queued_count) ? snap.queued_count : 0;
    publish();
  };
  if (listen) listen('question:state', e => apply(e && e.payload)).catch(() => {});
  if (invoke) invoke('question_action', { payload: { action: 'view' } }).then(apply, () => {});
  new MutationObserver(syncMode).observe(capsule, { attributes: true, attributeFilter: ['data-question', 'data-card'] });
  const linksBox = doc.getElementById('blobs-links'); if (linksBox) new MutationObserver(fitList).observe(linksBox, { attributes: true, attributeFilter: ['hidden'] });
  new MutationObserver(fitList).observe(capsule, { attributes: true, attributeFilter: ['data-notices-calm', 'data-layout', 'data-phase', 'data-view'] });
  syncMode(); publish();
}
