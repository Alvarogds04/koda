'use strict';
/* Sileo-style toast for a NEW question / permission (human request: «una notificación con sileo» below the island).
   Port of the LOOK and MOTION of hiaaryan/sileo (MIT) in vanilla JS: a 350x40 pill that morphs into a body through a gooey SVG
   filter (feGaussianBlur + feColorMatrix), spring easing as CSS linear(), badge + title header, body on expand. No React, no npm.
   It shows «<Agente> pregunta» + the first line, and a trusted click asks the island to open on that question. It answers ONLY
   for the exact permission pair (HU-063 T3: «Aprobar» / «Rechazar», decisionFor), through the same host path as the card. Pure view functions first (Node tests), DOM mount last.
   Loaded as a classic script (window.AbitoQuestionToast) and by test-node/question-toast-check.cjs. */
(function (root, factory) {
  const N = typeof module === 'object' && module.exports ? require('./notify-view.js') : root.AbitoNotify;
  const L = typeof module === 'object' && module.exports ? require('./island-layout.js') : root.AbitoIslandLayout;
  const api = factory(N, L);
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }
  root.AbitoQuestionToast = Object.freeze(api);
  mount(api);
})(typeof self !== 'undefined' ? self : this, (N, L) => {
  // Sileo: HEIGHT 40, WIDTH 350. hMax = pill + the expanded body, the area the host's input region must cover.
  const TOAST = Object.freeze({ w: 350, h: 40, hMax: 96, gap: 0, bodyMax: 120, decideMax: 46, ms: 8000, transientMs: 5200 }); // S13: an action toast closes after 8 s (info would be 3-5 s); hover/focus pause it

  // Direction B (HU-063 S3): the accent is the ASKER's colour; amber = permission / waiting for a yes, red = error outcome, neutral = finished.
  // Closed hex tables (same values as island-nusa AGENT_HEX / --sun / --red-11): nothing from the data ever reaches a style.
  const AGENT_ACCENT = Object.freeze({ pi: '#2dffac', 'claude-code': '#b04dff', codex: '#f472b6' });
  const DEFAULT_ACCENT = '#4d9fff';
  const ROLE_ACCENT = Object.freeze({ sun: '#ffe100', red: '#ff5c75', neutral: '#d4d4d8', agent: DEFAULT_ACCENT });
  // SN1: the TITLE is coloured by STATE (the Abito palette: --sun waiting for a yes, --go finished, --red-11 error); the asker's colour stays secondary (dot, bar).
  // All four pass AA (>= 4.5:1) on the black body. A question is amber like a permission. Closed table: nothing from the data reaches a style.
  const TITLE_COLOUR = Object.freeze({ sun: '#ffe100', agent: '#ffe100', go: '#b8ff2e', red: '#ff5c75', neutral: '#d4d4d8' });
  /** A role name, or a toast view (finished is green; every other view by its role). Unknown -> neutral. */
  function titleColour(x) {
    const role = x && typeof x === 'object' ? (x.kind === 'finished' ? 'go' : x.role) : x;
    return typeof role === 'string' && Object.hasOwn(TITLE_COLOUR, role) ? TITLE_COLOUR[role] : TITLE_COLOUR.neutral;
  }
  /** The asker's colour from its slug; anything unknown, hostile or not a string is the default blue. */
  const agentAccent = slug => (typeof slug === 'string' && Object.hasOwn(AGENT_ACCENT, slug) ? AGENT_ACCENT[slug] : DEFAULT_ACCENT);

  const firstLine = text => {
    const lines = String(text || '').split(/\r?\n/).map(l => l.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim());
    const line = lines.find(Boolean) || '';
    return line.length > TOAST.bodyMax ? `${line.slice(0, TOAST.bodyMax - 1)}…` : line;
  };

  // R1-toast-clamp-hides-command-tail: Aprobar/Rechazar only when the WHOLE request text is what the toast shows: ONE line, nothing
  // normalised away (no control / zero-width / bidi / separator character, no second line), at most TOAST.decideMax chars so it fits
  // the 96px area unclamped. Anything else sends the human to the island card («Ver todo»), where the full command is read.
  const HIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/;
  function fullyShown(n) {
    if (!n || typeof n.text !== 'string') return false;
    const t = n.text.replace(/^[ \r\n]+|[ \r\n]+$/g, ''); // only plain padding may be dropped
    return !!t && t.length <= TOAST.decideMax && !HIDDEN_CHARS.test(t) && t === firstLine(t); // firstLine = exactly what the toast paints
  }

  /** The toast for the pending question, or null. ctx: { now, onScreen (the card is visible), dismissedId }. */
  function toastView(snapshot, ctx) {
    const c = ctx || {};
    const s = snapshot && snapshot.available !== false ? snapshot : null;
    const n = s && N.fromPending(s.pending);
    if (!n) return null;
    const now = Number.isFinite(c.now) ? c.now : Date.now();
    if (N.expired(n.expiresAt, now) || c.onScreen === true || c.dismissedId === n.id) return null;
    const body = firstLine(n.text);
    if (!body) return null;
    const approval = n.kind === 'approval';
    const name = N.askerName(n);
    const steps = Array.isArray(n.form) ? n.form.length : 0;
    const title = approval ? `${name} pide permiso` : `${name} pregunta${steps ? ` (${steps} ${steps === 1 ? 'pregunta' : 'preguntas'})` : ''}`;
    const queued = Number.isInteger(s.queued_count) && s.queued_count > 0 ? s.queued_count : 0;
    const queue = queued ? `1 de ${queued + 1}` : null;
    return { id: n.id, kind: n.kind, actionable: true, ms: TOAST.ms, tone: approval ? 'warning' : 'action', icon: approval ? 'lock' : 'bubble', title, body, queue,
      agent: n.agent, role: approval ? 'sun' : 'agent', accent: approval ? ROLE_ACCENT.sun : agentAccent(n.agent),
      aria: `${title}: ${body}${queue ? ` (${queue})` : ''}. Abrir la isla para responder.` };
  }

  /** A trusted click asks to open the island on this question. The id only; no answer, no option. Finished/outcome toasts are not actionable. */
  const openRequest = (event, view) => (event && event.isTrusted === true && view && view.actionable === true && view.id ? { id: view.id } : null);

  // ---- HU-063 T3: «Aprobar» / «Rechazar» on the toast. The SAME host path as the permission card (question_action answer, index from the exact label match; the
  // host validates id, index, expiry and transport). Only the exact reject/approve pair that island-layout's approvalView recognises.
  /** The decision the toast may offer for the pending request, or null. Never lossy, free text, multi-select, form, 3+ options or other labels. */
  function permissionPair(snapshot, ctx) {
    if (!toastView(snapshot, ctx) || !L || typeof L.approvalView !== 'function') return null;
    const n = N.fromPending(snapshot.pending);
    if (!n || n.multiSelect === true || n.allowFreeText === true || n.form || !Array.isArray(n.options) || n.options.length !== 2) return null;
    const v = L.approvalView({ kind: n.kind, text: n.text, allowFreeText: false, options: n.options.map(o => ({ index: o.index, label: o.label })) }, N.askerName(n));
    const acts = v && Array.isArray(v.actions) ? v.actions : null;
    if (!acts || acts.length !== 2 || acts[0].role !== 'reject' || acts[1].role !== 'approve') return null;
    const [no, yes] = acts;
    if (!Number.isInteger(no.index) || !Number.isInteger(yes.index) || no.index === yes.index) return null;
    return { text: n.text, decision: { id: n.id, approve: { index: yes.index, label: yes.label }, reject: { index: no.index, label: no.label } } };
  }
  function decisionFor(snapshot, ctx) {
    const p = permissionPair(snapshot, ctx);
    return p && fullyShown(p) ? p.decision : null;
  }
  /** The exact permission pair whose text the toast does NOT show whole: no buttons, one «Ver todo» that opens the island card. */
  function needsFullView(snapshot, ctx) {
    const p = permissionPair(snapshot, ctx);
    return !!p && !fullyShown(p);
  }
  /** Click time: the decision the toast showed must still be THE current request (same id and options, not expired, host idle, not in flight). */
  function currentDecision(shown, latest, ctx) {
    const c = ctx || {};
    if (!shown || c.inFlight === true || !latest || (latest.native_transition && latest.native_transition !== 'idle')) return null;
    const now = decisionFor(latest, c);
    return now && now.id === shown.id && now.approve.index === shown.approve.index && now.reject.index === shown.reject.index
      && now.approve.label === shown.approve.label && now.reject.label === shown.reject.label ? now : null;
  }
  /** The exact host payload for one trusted click: answer{id,index} for both buttons (exactly the permission card's path; never decline). */
  function decisionRequest(event, decision, which) {
    if (!event || event.isTrusted !== true || !decision || typeof decision.id !== 'string') return null;
    if (which === 'approve') return { action: 'answer', id: decision.id, index: decision.approve.index };
    if (which === 'reject') return { action: 'answer', id: decision.id, index: decision.reject.index };
    return null;
  }

  // ---- transient toasts: «terminó» + the terminal outcomes. Informational ONLY: no question card, no click, no answer. ----------
  // «Terminó» is not «salió bien»: the wording never claims success, and sent/answered are never toasted (they prove nothing ran).
  const SLUG = /^[a-z0-9][a-z0-9._-]{0,31}$/;
  const transient = (id, kind, tone, icon, title, body, note, role) => ({ id, kind, actionable: false, ms: TOAST.transientMs, tone, icon, title, body, queue: null,
    role: role || 'neutral', accent: ROLE_ACCENT[role || 'neutral'],
    aria: `${title}: ${body}${note ? `. ${note}` : ''}.` });
  /** A NEW settled notice (arrival detail from the island: id, title, agent, projectName) -> finished toast, or null. */
  function finishedToast(notice) {
    if (!notice || typeof notice.id !== 'string' || !notice.id || (notice.kind && notice.kind !== 'settled')) return null;
    const who = typeof notice.agent === 'string' && SLUG.test(notice.agent) ? N.askerName(notice) : null;
    const body = firstLine(notice.title) || firstLine(N.projectLabel ? N.projectLabel(notice.projectName) : notice.projectName);
    if (!body) return null;
    return transient(`finished:${notice.id}`, 'finished', 'neutral', 'info', who ? `${who} terminó` : 'Una tarea terminó', body, 'Terminó; el resultado no está confirmado', 'neutral');
  }
  /** F6 (SN1): a NEW attention notice (Codex «te pide permiso / te pregunta») -> a Sileo pill that only POINTS at the terminal.
      Informational like «terminó»: no click target, no answer, no decision; the producer's own one display line is the body. */
  function attentionToast(notice) {
    if (!notice || notice.kind !== 'attention' || typeof notice.id !== 'string' || !notice.id) return null;
    const title = firstLine(notice.title);
    if (!title) return null;
    return transient(`attention:${notice.id}`, 'attention', 'warning', 'lock', title, firstLine(notice.detail) || 'Respondé en la terminal', '', 'sun');
  }
  /** An outcome EDGE from N.outcomeEvent (+ a serial that makes each event distinct) -> toast, or null for anything else. */
  function outcomeToast(event, serial) {
    if (!event || typeof event.outcome !== 'string') return null;
    const known = typeof event.agent === 'string' && SLUG.test(event.agent), name = known ? N.askerName(event) : 'El agente';
    const text = {
      expired: ['Pregunta vencida', `La pregunta${known ? ` de ${name}` : ''} venció sin respuesta`],
      cancelled: ['Pregunta cancelada', `${name} retiró la pregunta`],
      disconnected: ['Conexión cortada', `Se cortó la conexión${known ? ` con ${name}` : ''}; la pregunta se descartó`],
      busy: ['Pregunta rechazada', 'Otra pregunta se rechazó porque ya había una abierta'],
    }[event.outcome];
    if (!text) return null;
    return transient(`outcome:${event.outcome}:${serial}`, event.outcome, event.outcome === 'busy' ? 'warning' : 'neutral',
      N.outcomeView(event.outcome).icon, text[0], text[1], '', event.outcome === 'disconnected' ? 'red' : event.outcome === 'busy' ? 'sun' : 'neutral');
  }

  // ---- Abito on the LEFT of every toast: the real clay character, in an EXISTING pose that matches the real state. -------------------
  // Finished is neutral («terminó», never success): no confirm/happy/proud pose is mapped to anything. Expired = nobody answered (rests),
  // cancelled = the agent withdrew (calm), disconnected = the link broke (error pose), busy = the other question was turned away (reject).
  const ABITO_POSE = Object.freeze({ question: 'question', approval: 'approval', attention: 'approval', finished: 'finished', expired: 'sleeping', cancelled: 'idle', disconnected: 'error', busy: 'reject' });
  const abitoPose = view => (view && Object.hasOwn(ABITO_POSE, view.kind) ? ABITO_POSE[view.kind] : 'idle');
  const ABITO_VIEWBOX = '36 42 128 128'; // the body (r ~54, lift/lean +-6) fills the 28px badge

  /** The host input region is one rectangle: grow the reported island shape to include the toast. */
  const shapeWithToast = (shape, shown) => (shown
    ? [Math.max(shape[0], TOAST.w), shape[1] + TOAST.gap + TOAST.hMax] : [shape[0], shape[1]]);

  /** A new question used to expand the island by itself; now the toast is the signal while compact. */
  const revealByToast = ctx => !ctx || ctx.phase !== 'expanded';

  // ---- Sileo's motion (hiaaryan/sileo, MIT): constants.ts SPRING = { duration 0.6 s, bounce 0.25 }, sileo.tsx morph ------------------
  // SN6 (vault «Specs/Sileo-notificacion»): the MEASURED timings of sileo.aaryan.design, ONE named table (the stylesheet mirrors the content/presence ones).
  const TIMING = Object.freeze({ springMs: 600, overshoot: 1.038, overshootAt: 0.45, contentInMs: 360, contentInDelayMs: 180, contentOutMs: 48, contentOutDelayMs: 24, presenceMs: 396 });
  const SPRING = Object.freeze({ duration: TIMING.springMs / 1000, bounce: 0.25 });
  // --sileo-spring-easing as measured: [fraction of the 600 ms, fraction of the travel]; overshoot 1.038 at 45 %
  const EASE = Object.freeze([[0, 0], [0.006, 0.002], [0.012, 0.007], [0.018, 0.015], [0.024, 0.026], [0.031, 0.041], [0.038, 0.06], [0.053, 0.108], [0.066, 0.157], [0.08, 0.214],
    [0.137, 0.467], [0.163, 0.577], [0.177, 0.631], [0.191, 0.682], [0.205, 0.73], [0.218, 0.771], [0.231, 0.808], [0.245, 0.844], [0.258, 0.874], [0.272, 0.903],
    [0.286, 0.928], [0.301, 0.952], [0.316, 0.972], [0.331, 0.988], [0.357, 1.01], [0.385, 1.025], [0.416, 1.034], [0.45, 1.038], [0.501, 1.035], [0.642, 1.012],
    [0.73, 1.003], [0.837, 0.999], [1, 1]]);
  /** The measured easing curve at `p` (0..1 of the spring duration), piecewise linear between the measured points. */
  function easeAt(p) {
    if (!Number.isFinite(p) || p <= 0) return 0;
    if (p >= 1) return 1;
    for (let i = 1; i < EASE.length; i++) {
      const a = EASE[i - 1], b = EASE[i];
      if (p === b[0]) return b[1];
      if (p < b[0]) return a[1] + (b[1] - a[1]) * ((p - a[0]) / (b[0] - a[0]));
    }
    return 1;
  }
  /** motion's spring(): fraction of the travel done after `t` seconds (0 -> 1, a little overshoot). damping ratio = 1 - bounce. */
  function springAt(t, spring) {
    if (!Number.isFinite(t) || t <= 0) return 0;
    const sp = spring || SPRING;
    const zeta = Math.min(1, Math.max(0, 1 - sp.bounce)), w0 = (2 * Math.PI) / sp.duration;
    if (t > sp.duration * 6) return 1;
    if (zeta >= 1) return 1 - (1 + w0 * t) * Math.exp(-w0 * t);
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
  }
  const lerp = (a, b, p) => a + (b - a) * p;
  const NECK_H = 12, START_H = 6, PILL_OPEN_H = 64; // PILL_OPEN_H: the open card's pill reaches 24px into the body (the reference's measured 40 -> 64)
  /**
   * The SVG geometry for one frame (x/y in the toast's own space: y = 0 is the island's bottom edge, x = 0 its left axis of a 350 box).
   * At progress 0 the pill is exactly the island's flat bottom edge (the `neck`), so the gooey filter joins them with no gap; the
   * spring then widens it to the content-wide pill and drops it to 40px, centred. `openP` (0..1, default = progress while `open`) unfolds
   * the 350px body below AND deepens the pill by 24px (it stays CENTRED on the island axis, like a notch stretching down: human 5hn6xmav), so it overlaps the body: the gooey filter melts that
   * junction into the curved neck of the Sileo card. progress/openP may exceed 1 (the spring overshoot). Reduced motion skips the travel.
   */
  function morphFrame(o) {
    const island = o.island || { w: 288, r: 14 };
    const pillW = Math.min(TOAST.w, Math.max(TOAST.h, Number.isFinite(o.pillW) ? o.pillW : TOAST.h));
    const p = o.reduce ? 1 : (Number.isFinite(o.progress) ? o.progress : 0);
    const openP = o.reduce ? (o.open ? 1 : 0) : Math.max(0, Number.isFinite(o.openP) ? o.openP : (o.open ? p : 0));
    const edgeW = Math.max(TOAST.h, island.w - 2 * island.r);
    const width = lerp(edgeW, pillW, p), height = lerp(START_H, TOAST.h, p);
    const bodyH = TOAST.hMax - TOAST.h;
    return {
      neck: { x: (TOAST.w - edgeW) / 2, y: -NECK_H, width: edgeW, height: NECK_H },
      pill: { x: (TOAST.w - width) / 2, y: lerp(-START_H, 0, p), width, height: height + (PILL_OPEN_H - TOAST.h) * openP },
      body: { x: 0, y: TOAST.h, width: TOAST.w, height: bodyH * openP },
    };
  }
  const motionPlan = reduce => (reduce ? { mode: 'fade', springs: false } : { mode: 'morph', springs: true });
  /** The toast hangs from the island's own bottom edge (its box in the capsule): flush, and it follows the island as it grows. */
  const toastTop = box => (box && Number.isFinite(box.top) && Number.isFinite(box.height) ? box.top + box.height : 0);

  return { TIMING, EASE, easeAt, TITLE_COLOUR, titleColour, PILL_OPEN_H, ABITO_POSE, ABITO_VIEWBOX, abitoPose, SPRING, springAt, morphFrame, motionPlan, toastTop, NECK_H, TOAST, AGENT_ACCENT, ROLE_ACCENT, agentAccent, toastView, finishedToast, attentionToast, outcomeToast, openRequest, decisionFor, needsFullView, fullyShown, currentDecision, decisionRequest, shapeWithToast, revealByToast, firstLine };
});

function mount(T) {
  const doc = document, N = window.AbitoNotify;
  const capsule = doc.getElementById('capsule');
  if (!capsule) return;
  const SVG = 'http://www.w3.org/2000/svg';
  const mk = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
  const sv = (tag, attrs) => { const e = doc.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v); return e; };

  // <button>: keyboard reachable (Tab, Enter/Space), one control, text only.
  const toast = mk('button', 'q-toast'); toast.id = 'question-toast'; toast.type = 'button'; toast.hidden = true;
  toast.dataset.sileoToast = 'true'; toast.dataset.state = 'action';
  // gooey canvas (Sileo): the island's bottom edge (neck), the pill and the body are blurred and thresholded so they melt into ONE
  // shape: the pill grows OUT of the island instead of sitting under it. y = 0 of the SVG is the island's bottom edge.
  const canvas = mk('div', 'q-toast-canvas'); canvas.setAttribute('aria-hidden', 'true');
  const H = T.TOAST.hMax + T.NECK_H;
  const svg = sv('svg', { width: String(T.TOAST.w), height: String(H), viewBox: `0 ${-T.NECK_H} ${T.TOAST.w} ${H}`, class: 'q-toast-svg' });
  const blur = 8; // Sileo: blur = roundness(16) * BLUR_RATIO(0.5)
  const defs = sv('defs'), filter = sv('filter', { id: 'q-toast-gooey', filterUnits: 'userSpaceOnUse', x: String(-blur * 2), y: String(-T.NECK_H - blur * 2), width: String(T.TOAST.w + blur * 4), height: String(H + blur * 4), 'color-interpolation-filters': 'sRGB' });
  filter.append(sv('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: String(blur), result: 'blur' }),
    sv('feColorMatrix', { in: 'blur', mode: 'matrix', values: '1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -10', result: 'goo' }),
    sv('feComposite', { in: 'SourceGraphic', in2: 'goo', operator: 'atop' }));
  defs.append(filter);
  const group = sv('g', { filter: 'url(#q-toast-gooey)' });
  const neckRect = sv('rect', { class: 'q-toast-neck', rx: '0' });
  const pillRect = sv('rect', { class: 'q-toast-pill', rx: '16', ry: '16' });
  const bodyRect = sv('rect', { class: 'q-toast-bodyrect', rx: '16', ry: '16' });
  group.append(neckRect, pillRect, bodyRect); svg.append(defs, group); canvas.append(svg);
  const header = mk('span', 'q-toast-header');
  const badge = mk('span', 'q-toast-badge'); badge.setAttribute('aria-hidden', 'true');
  const dot = mk('i', 'q-toast-dot'); dot.setAttribute('aria-hidden', 'true');
  const title = mk('span', 'q-toast-title'), queue = mk('span', 'q-toast-queue');
  const bar = mk('span', 'q-toast-progress'); bar.setAttribute('aria-hidden', 'true');
  header.append(badge, title, queue, dot, bar); // dot is painted before the title by CSS order (the title stays child 1)
  // S13: a polite live region announces the toast once (the toast itself is a button with its own label)
  const live = mk('p', 'sr-only'); live.id = 'question-toast-live'; live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite');
  const content = mk('span', 'q-toast-content'); const bodyText = mk('span', 'q-toast-body'); content.append(bodyText);
  toast.append(canvas, header, content);
  // HU-063 T3: a <button> cannot contain buttons, so the decision buttons live in a SIBLING group laid over the expanded body
  const actions = mk('div', 'q-toast-actions'); actions.id = 'question-toast-actions'; actions.hidden = true;
  actions.setAttribute('role', 'group'); actions.setAttribute('aria-label', 'Decidir el permiso');
  const rejectBtn = mk('button', 'q-toast-act q-toast-reject'), approveBtn = mk('button', 'q-toast-act q-toast-approve');
  rejectBtn.type = approveBtn.type = 'button'; rejectBtn.disabled = approveBtn.disabled = false;
  // R1: a request the toast cannot show whole offers NO decision, only this one button: it opens the island card (same event as the toast click)
  const viewAllBtn = mk('button', 'q-toast-act q-toast-viewall', 'Ver todo'); viewAllBtn.type = 'button'; viewAllBtn.hidden = true;
  // SN1: the numbered rows of the reference. The ordinals are DECORATIVE siblings (aria-hidden, no pointer, no shortcut), not part of the buttons:
  // the buttons keep their exact label text and handlers. «1.» sits on Aprobar, «2.» on Rechazar, in the same grid cell as their button.
  const ordApprove = mk('span', 'q-toast-ord q-toast-ord-approve', '1.'), ordReject = mk('span', 'q-toast-ord q-toast-ord-reject', '2.');
  ordApprove.setAttribute('aria-hidden', 'true'); ordReject.setAttribute('aria-hidden', 'true'); ordApprove.hidden = ordReject.hidden = true;
  actions.append(rejectBtn, approveBtn, viewAllBtn, ordApprove, ordReject);
  capsule.append(toast, actions, live);

  const icons = window.AbitoIcons;
  // like island.js: the parser only ever receives the CLOSED own registry's literal markup, never data
  const parser = new DOMParser();
  const paintIcon = name => {
    try {
      const markup = icons ? icons.svg(name) : '';
      const parsed = markup ? parser.parseFromString(markup, 'image/svg+xml').documentElement : null;
      badge.replaceChildren(...(parsed && parsed.nodeName === 'svg' ? [doc.importNode(parsed, true)] : []));
    } catch { badge.replaceChildren(); }
  };

  // The actual Abito (clay-engine + the character-motion controller). Created when the toast appears, DISPOSED when it is hidden, so a
  // hidden toast leaves no instance in the shared clay loop (it halts when nothing is left). No engine -> the generic icon, as before.
  let abito = null;
  const disposeAbito = () => {
    if (!abito) return;
    const a = abito; abito = null;
    try { a.character.destroy(); a.clay.destroy(); } catch { /* nothing left to release */ }
    badge.replaceChildren(); delete badge.dataset.pose;
  };
  function paintAbito(pose) {
    const Clay = typeof AbitoClay !== 'undefined' ? AbitoClay : null, Character = window.AbitoCharacter;
    if (!Clay || !Character) return false;
    try {
      if (!abito) {
        const svg = sv('svg', { class: 'q-toast-abito', width: '28', height: '28', 'aria-hidden': 'true', focusable: 'false' });
        const clay = Clay.create(svg, { seed: 505, viewBox: T.ABITO_VIEWBOX, shadow: false, state: pose });
        const character = Character.create({ clay, choosePose: () => 'idle', validCard: () => false, notification: () => null, blocked: () => reduced() });
        abito = { clay, character }; badge.replaceChildren(svg);
      }
      abito.character.hold(pose); badge.dataset.pose = abito.clay.state;
      return true;
    } catch { disposeAbito(); return false; }
  }

  // HU-063 T3 state: the decision on offer for the pending toast, one decision per toast (inFlight), and the host-error line
  const ACTION_H = 32, ONE_LINE_PX = 24; // body line-height is 1.15rem (~18px): two lines are ~37px
  // A request that REPLACES the one on the buttons arms them only after ARM_MS, so a click aimed at the old one can never land on the new one.
  const ARM_MS = 500;
  let decision = null, fullView = false, inFlight = false, sendError = null, armedAt = 0, armTimer = 0;
  const armed = () => Date.now() >= armedAt;
  function paintActions() {
    const show = (!!decision || fullView) && !!view && (!decision || view.id === decision.id) && toast.dataset.expanded === 'true' && !toast.hidden;
    actions.hidden = !show; toast.dataset.decide = decision ? 'true' : 'false'; toast.dataset.fullview = fullView ? 'true' : 'false';
    rejectBtn.hidden = approveBtn.hidden = ordApprove.hidden = ordReject.hidden = !decision; viewAllBtn.hidden = !fullView;
    if (!decision) return;
    rejectBtn.textContent = decision.reject.label; approveBtn.textContent = decision.approve.label;
    rejectBtn.disabled = approveBtn.disabled = inFlight || !armed();
    actions.dataset.busy = inFlight ? 'true' : 'false';
  }
  let transientView = null, transientTimer = 0, serial = 0;
  let snapshot = null, view = null, dismissedId = null, shownId = null, expandTimer = 0, collapseTimer = 0, hot = false;
  // S3: compact uses its pill; expanded questions paint above every view (R23).
  const onScreen = () => (capsule.dataset.phase === 'expanded' && !capsule.dataset.card)
    || (capsule.dataset.phase === 'compact' && capsule.dataset.compactAsk === 'true' && capsule.dataset.edgeHidden !== 'true');
  const reduced = () => doc.documentElement.dataset.motion === 'reduce' || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const clear = () => { clearTimeout(expandTimer); clearTimeout(collapseTimer); };
  // S13 countdown: remaining ms survive a pause (hover / focus); the bar is a CSS animation that pauses with it
  let closeTimer = 0, remaining = T.TOAST.ms, startedAt = 0, running = false;
  const stopClose = () => { clearTimeout(closeTimer); closeTimer = 0; };
  const runClose = () => {
    stopClose(); if (!view) return;
    running = true; startedAt = Date.now(); bar.style.animationPlayState = 'running';
    // v8: in the chat view and on the hidden strip the toast is the ONLY click target to the question, so the 8 s only FOLDS its body
    // (the pill stays); only Escape dismisses it
    closeTimer = setTimeout(() => { running = false; if (view) { setExpanded(false); bar.style.opacity = '0'; } }, Math.max(0, remaining));
  };
  const pauseClose = () => { if (!running) return; running = false; stopClose(); remaining = Math.max(0, remaining - (Date.now() - startedAt)); bar.style.animationPlayState = 'paused'; };
  const restartClose = () => { const life = (view && view.ms) || T.TOAST.ms; bar.style.opacity = ''; remaining = life; bar.style.animation = 'none'; void bar.offsetWidth; bar.style.animation = ''; bar.style.animationDuration = `${life}ms`; runClose(); };
  const island = doc.getElementById('island');
  const set = (el, o) => { for (const k of ['x', 'y', 'width', 'height']) el.setAttribute(k, String(Math.round(o[k] * 100) / 100)); };

  // ---- Sileo's motion: ONE spring clock drives the pill's width/height/position and the body, every frame -------------------
  const anim = { from: 0, to: 0, start: 0, raf: 0, open: false, pillW: T.TOAST.h, progress: 0, bodyProgress: 0, bodyFrom: 0, bodyTo: 0, bodyStart: 0 };
  const islandBox = () => {
    const box = island ? island.getBoundingClientRect() : null;
    const r = island ? parseFloat(getComputedStyle(island).borderBottomLeftRadius) : 14;
    return { box, w: box ? box.width : 288, r: Number.isFinite(r) ? r : 14 };
  };
  // The toast hangs from the island's REAL bottom edge: re-placed on every layout change of the island (its own spring included).
  function place() {
    const { box, w, r } = islandBox();
    const top = Math.round(T.toastTop(box ? { top: box.top - capsule.getBoundingClientRect().top, height: box.height } : null));
    toast.style.top = `${top}px`; actions.style.top = `${top + T.TOAST.hMax - ACTION_H - 4}px`; // inside the existing 96px body: bottom edge 4px above hMax (room for the focus ring)
    paintFrame(w, r);
  }
  function paintFrame(w, r) {
    const f = T.morphFrame({ progress: anim.progress, openP: anim.bodyProgress, open: anim.bodyTo > 0, island: { w, r }, pillW: anim.pillW, reduce: reduced() });
    set(neckRect, f.neck); set(pillRect, f.pill); set(bodyRect, f.body);
    header.style.left = `${f.pill.x}px`; header.style.width = `${f.pill.width}px`; // the header (Koda circle + title) is centred ON the pill (flex centring in CSS)
  }
  function frame(now) {
    anim.raf = 0;
    const t = (now - anim.start) / 1000;
    // opening: the MEASURED Sileo curve (overshoot 1.038 at 45 %); folding back: the same spring without bounce (it never goes past the target)
    const curve = (up, sec) => (up ? T.easeAt(sec / T.SPRING.duration) : T.springAt(sec, { duration: T.SPRING.duration, bounce: 0 }));
    anim.progress = anim.from + (anim.to - anim.from) * curve(anim.to >= anim.from, t);
    const tb = (now - anim.bodyStart) / 1000;
    anim.bodyProgress = anim.bodyFrom + (anim.bodyTo - anim.bodyFrom) * curve(anim.bodyTo >= anim.bodyFrom, tb);
    place();
    if (t < T.SPRING.duration * 3 || tb < T.SPRING.duration * 3) anim.raf = requestAnimationFrame(frame);
  }
  const kick = () => { if (!anim.raf) anim.raf = requestAnimationFrame(frame); };
  // reduced motion: the toast does not travel, it fades in place (the CSS opacity transition); otherwise the spring morphs it out
  function morphTo(target) {
    anim.from = anim.progress; anim.to = target; anim.start = performance.now();
    if (T.motionPlan(reduced()).springs) kick(); else { anim.progress = target; place(); }
  }
  const setExpanded = open => {
    toast.dataset.expanded = open ? 'true' : 'false';
    toast.setAttribute('aria-expanded', open ? 'true' : 'false');
    paintActions();
    anim.open = open; anim.bodyFrom = anim.bodyProgress; anim.bodyTo = open ? 1 : 0; anim.bodyStart = performance.now();
    if (T.motionPlan(reduced()).springs) kick(); else { anim.bodyProgress = anim.bodyTo; place(); }
  };
  // Follow the island every frame of ITS spring (it grows for a long question, shrinks, conceals): a ResizeObserver on the island
  // plus the capsule's own attribute changes. No fixed tracking window.
  if (island && typeof ResizeObserver === 'function') new ResizeObserver(() => { if (!toast.hidden) place(); }).observe(island);
  if (island) new MutationObserver(() => { if (!toast.hidden) place(); }).observe(island, { attributes: true, attributeFilter: ['style'] });
  // A finished/outcome toast is shown only at its event, for a short time, and never over a pending question toast (that one stays the
  // actionable signal; an event that finds it showing is dropped, not queued). A new pending question replaces it at once.
  const dropTransient = () => { clearTimeout(transientTimer); transientView = null; };
  // human (26-oct): «que las notificaciones de sileo salgan solo si abito está oculto»: while the island is on screen (compact pill or
  // expanded) it shows the question/notice itself, so no toast at all; an informational event that finds it visible is dropped.
  const islandHidden = () => capsule.dataset.edgeHidden === 'true';
  function pushTransient(next) {
    if (!next) return;
    if (!islandHidden()) return; // dropped, not queued: the visible island already shows it
    // dropped, not queued: judged on the toast ACTUALLY showing (a pending card on screen or an Esc-dismissed toast does not block it)
    if (T.toastView(snapshot, { now: Date.now(), onScreen: onScreen(), dismissedId })) { render(); return; }
    clearTimeout(transientTimer);
    transientView = { ...next, until: Date.now() + next.ms };
    transientTimer = setTimeout(() => { if (transientView && transientView.id === next.id) { transientView = null; render(); } }, next.ms);
    render();
  }
  function render() {
    const pendingToast = islandHidden() ? T.toastView(snapshot, { now: Date.now(), onScreen: onScreen(), dismissedId }) : null;
    if (pendingToast) dropTransient();
    if (!islandHidden()) dropTransient(); // shown again by the island: a stale informational toast never comes back // replaced by the actionable toast: gone for good, never revealed again after the answer
    const fresh0 = !pendingToast && transientView && Date.now() < transientView.until && dismissedId !== transientView.id ? transientView : null;
    const next = pendingToast || fresh0;
    view = next;
    const nextDecision = pendingToast ? T.decisionFor(snapshot, { now: Date.now(), onScreen: onScreen(), dismissedId }) : null;
    if (!nextDecision || !decision || nextDecision.id !== decision.id) { // a new request starts clean and disarmed
      inFlight = false; sendError = null; clearTimeout(armTimer);
      if (nextDecision) { armedAt = Date.now() + ARM_MS; armTimer = setTimeout(paintActions, ARM_MS + 20); }
    }
    decision = nextDecision;
    fullView = !!pendingToast && !decision && T.needsFullView(snapshot, { now: Date.now(), onScreen: onScreen(), dismissedId });
    const visible = !!next;
    if (!visible) {
      clear(); stopClose(); running = false; shownId = null; setExpanded(false);
      if (!toast.hidden) {
        // leaving: the pill is pulled back INTO the island (the spring in reverse), then hidden
        toast.dataset.exiting = 'true'; morphTo(0);
        const done = () => { if (!view) { disposeAbito(); toast.hidden = true; delete toast.dataset.exiting; delete toast.dataset.ready; } };
        setTimeout(done, reduced() ? 0 : 320); // the 396 ms presence curve is >= 99.9 % done at 320 ms (0.837 -> 0.999); kept as before so the Abito loop is released at the same moment
      }
      doc.dispatchEvent(new CustomEvent('abito:question-toast', { detail: { shown: false } }));
      return;
    }
    delete toast.dataset.exiting;
    toast.style.setProperty('--q-accent', next.accent); toast.style.setProperty('--q-title', T.titleColour(next)); toast.dataset.role = next.role; // closed hex table: never data
    toast.dataset.state = next.tone; toast.dataset.kind = next.kind; toast.dataset.actionable = next.actionable ? 'true' : 'false';
    title.textContent = next.title; queue.textContent = next.queue || ''; queue.hidden = !next.queue; bodyText.textContent = decision && sendError === decision.id ? 'No se pudo enviar.' : next.body;
    toast.setAttribute('aria-label', decision ? `${next.title}: ${next.body}. Abrir la isla, o decidir con Aprobar o Rechazar.` : fullView ? `${next.title}: ${next.body}. Es largo: abrir la isla para leerlo todo y decidir allí.` : next.aria);
    if (!paintAbito(T.abitoPose(next))) paintIcon(next.icon);
    const fresh = shownId !== next.id;
    const wasHidden = toast.hidden;
    if (wasHidden) toast.hidden = false; // measured VISIBLE: a hidden header has no scrollWidth (the pill shrank to 40px under the title)
    // R1 safety net: the body is painted UNclamped while buttons show; if it still does not fit one line (wide glyphs wrap, or one unbreakable run overflows), no decision is offered
    if (decision) {
      toast.dataset.decide = 'true';
      if ((Number.isFinite(bodyText.offsetHeight) && bodyText.offsetHeight > ONE_LINE_PX) || bodyText.scrollWidth > bodyText.clientWidth + 1) { decision = null; fullView = true; paintActions(); }
    }
    // the pill is as wide as its header (badge + title + queue), Sileo's measured pill width
    header.style.width = ''; // natural width for the measurement; place() sets the pill width again
    anim.pillW = Math.min(T.TOAST.w, Math.max(T.TOAST.h, Math.ceil(header.scrollWidth) + 4));
    // the header sits ON the pill wherever the pill is (always centred under the island): place() moves it with the shape
    if (wasHidden) { anim.progress = 0; place(); void toast.offsetWidth; morphTo(1); }
    else if (fresh) { morphTo(1); }
    toast.dataset.ready = 'true';
    place();
    if (fresh) {
      shownId = next.id; clear(); live.textContent = next.aria; restartClose();
      // Sileo: auto-expand shortly after arriving, auto-collapse after a few seconds unless hovered/focused
      expandTimer = setTimeout(() => { setExpanded(true); collapseTimer = setTimeout(() => { if (!hot) setExpanded(false); }, 4500); }, 250);
    }
    paintActions();
    doc.dispatchEvent(new CustomEvent('abito:question-toast', { detail: { shown: true } }));
  }
  const hold = on => { hot = on; if (on) { clear(); setExpanded(true); pauseClose(); } else { collapseTimer = setTimeout(() => setExpanded(false), 800); if (view && !running) runClose(); } };
  toast.addEventListener('pointerenter', () => hold(true));
  toast.addEventListener('pointerleave', () => hold(false));
  toast.addEventListener('focus', () => hold(true));
  toast.addEventListener('blur', () => hold(false));
  toast.addEventListener('click', event => {
    const req = T.openRequest(event, view);
    if (req) doc.dispatchEvent(new CustomEvent('abito:question-open', { detail: req }));
  });
  const dismissOnEscape = event => {
    if (event.key === 'Escape' && view) { event.preventDefault(); event.stopPropagation(); dismissedId = view.id; render(); }
  };
  toast.addEventListener('keydown', dismissOnEscape);
  // the sibling group keeps the toast open while it is hovered/focused (a pause, never a decision) and shares Escape
  actions.addEventListener('pointerenter', () => hold(true));
  actions.addEventListener('pointerleave', () => hold(false));
  actions.addEventListener('focusin', () => hold(true));
  actions.addEventListener('focusout', () => hold(false));
  actions.addEventListener('keydown', dismissOnEscape);
  // The ONLY place the toast answers: a trusted click on one of the two buttons, re-checked against the CURRENT request, once.
  const decide = which => event => {
    const shown = decision;
    if (!shown || inFlight || !armed() || !T.decisionRequest(event, shown, which)) return;
    const cur = T.currentDecision(shown, snapshot, { now: Date.now(), onScreen: onScreen(), dismissedId, inFlight });
    const payload = cur && view && view.id === cur.id ? T.decisionRequest(event, cur, which) : null;
    if (!payload || typeof invoke !== 'function') return;
    inFlight = true; sendError = null; paintActions();
    const fail = () => { if (decision && decision.id === payload.id) { inFlight = false; sendError = payload.id; bodyText.textContent = 'No se pudo enviar.'; paintActions(); } };
    try { Promise.resolve(invoke('question_action', { payload })).then(() => {}, fail); } catch { fail(); }
  };
  // «Ver todo»: the SAME trusted open-the-island event as the toast click; it answers nothing
  viewAllBtn.addEventListener('click', event => {
    const req = fullView ? T.openRequest(event, view) : null;
    if (req) doc.dispatchEvent(new CustomEvent('abito:question-open', { detail: req }));
  });
  rejectBtn.addEventListener('click', decide('reject'));
  approveBtn.addEventListener('click', decide('approve'));
  const listen = window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen;
  const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)
    || (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) || null;
  const apply = next => {
    if (!next || typeof next !== 'object') return;
    const prev = snapshot; snapshot = next;
    const event = N.outcomeEvent(prev, next); // only the EDGE into an outcome; a retained notice or a repeat is nothing
    if (event) pushTransient(T.outcomeToast(event, ++serial)); else render();
  };
  // the island reports a settled or attention notice that is NEW (never boot history): one «terminó» / «te pide permiso» event
  document.addEventListener('abito:notice-arrival', event => { const d = event && event.detail; pushTransient(d && d.kind === 'attention' ? T.attentionToast(d) : T.finishedToast(d)); });
  if (listen) listen('question:state', event => apply(event && event.payload)).catch(() => {});
  if (invoke) invoke('question_action', { payload: { action: 'view' } }).then(apply, () => {});
  new MutationObserver(render).observe(capsule, { attributes: true, attributeFilter: ['data-phase', 'data-view', 'data-card', 'data-compact-ask', 'data-edge-hidden'] });
  setInterval(() => { if (view) render(); }, 5000); // local expiry hides it without a host event
}
