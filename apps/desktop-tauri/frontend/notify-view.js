'use strict';
/* N6 — pure notification view-model: a notification carries 1..N reply options
   (Pi questions QP/1 are one case; other agents plug in later through the
   connectors lane, not here). No DOM, no IPC, no network, NO AUDIO. Contracts:
   docs/pi-question-roundtrip.md §2.4-§2.7, docs/desktop-visual-language.md
   §1.1/§2.2/§3, docs/desktop-sound-catalog.md §2-§3. Loaded as a classic
   script (window.AbitoNotify) and by test-node/notify-view-check.cjs. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AbitoNotify = Object.freeze(api);
})(typeof self !== 'undefined' ? self : this, () => {
  const MAX_OPTIONS = 4; // QP/1 wire cap
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const SOUND_ENABLED_DEFAULT = true; // sound is ON by default (human decision); the stored preference, if any, wins

  // ---- model -----------------------------------------------------------------
  // `pending` is the host's PendingQuestionView (display text only: never a
  // wire token, scope or suggested option). Returns null for anything that is
  // not a well-formed, answerable notification.
  // P1: who is asking. The backend already refuses a bad slug, but this view never trusts a
  // string it is about to show: same closed shape, else the safe default `pi`.
  const AGENT_SLUG = /^[a-z0-9][a-z0-9._-]{0,31}$/;
  const KNOWN_AGENTS = { pi: 'Pi', 'claude-code': 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };
  function agentLabel(slug) {
    if (KNOWN_AGENTS[slug]) return KNOWN_AGENTS[slug];
    return slug.replace(/(^|[-_])([a-z0-9])/g, (_, sep, c) => (sep ? ' ' : '') + c.toUpperCase());
  }
  const askerName = n => agentLabel(n && AGENT_SLUG.test(n.agent) ? n.agent : 'pi');
  const askedBy = n => `${askerName(n)} pregunta`;
  // S3: «Agente · proyecto». The project name is display text from the host: shown only when it is a
  // well-formed name (same grammar the host enforces), else just the agent. Never trusted blindly.
  const PROJECT_NAME = /^[A-Za-z0-9._-](?:[A-Za-z0-9._ -]{0,62}[A-Za-z0-9._-])?$/;
  // S4 (abito-avisos-ux, human: «quita lo de sb y dejalo todo como abito»): the Abito project lives in the folder «sb-second-brain»;
  // on screen it is «Abito». Display only: ids, paths and wire fields keep the real folder name. Any other project keeps its own.
  const ABITO_FOLDERS = /^sb-second-brain$/i;
  const projectLabel = name => (typeof name === 'string' && ABITO_FOLDERS.test(name.trim()) ? 'Koda' : name);
  const askerLine = n => {
    const name = n && typeof n.projectName === 'string' && PROJECT_NAME.test(n.projectName) ? projectLabel(n.projectName) : null;
    return name ? `${askerName(n)} · ${name}` : askerName(n);
  };
  // S3: «1 de N» while others wait behind the question on screen (N = shown + waiting); empty otherwise.
  const MAX_QUEUE = 8;
  const queueLabel = snap => {
    if (!snap || !snap.pending) return '';
    const waiting = snap.queued_count;
    if (!Number.isInteger(waiting) || waiting < 1 || waiting + 1 > MAX_QUEUE) return '';
    return `1 de ${waiting + 1}`;
  };
  // Structured questions (contract fix/seguridad-app 5a57a4d): multi_select, a questionnaire `form`, free_text_max (2000 | 4000).
  const FORM_MAX_ITEMS = 4, HEADER_MAX = 32;
  const optionsOf = raw => (Array.isArray(raw) ? raw.slice(0, MAX_OPTIONS) : []).map((o, i) => ({
    index: Number.isInteger(o && o.index) ? o.index : i,
    key: String(i + 1),
    label: String((o && o.label) || ''),
    description: String((o && o.description) || ''),
  }));
  function formOf(raw) {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > FORM_MAX_ITEMS) return null;
    const items = [];
    for (const it of raw) {
      if (!it || typeof it !== 'object' || typeof it.text !== 'string' || !it.text) return null;
      const header = typeof it.header === 'string' ? it.header : '';
      if (Array.from(header).length > HEADER_MAX) return null;
      const options = optionsOf(it.options);
      if (options.length < 2 || options.length > MAX_OPTIONS || options.some(o => !o.label)) return null;
      items.push({ header, text: it.text, options, multiSelect: it.multi_select === true, allowFreeText: it.allow_free_text === true });
    }
    return items;
  }
  function fromPending(p) {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !UUID_V4.test(p.id)) return null;
    const kind = p.kind === 'approval' ? 'approval' : p.kind === 'question' ? 'question' : null;
    if (!kind || typeof p.text !== 'string' || !p.text) return null;
    const options = optionsOf(p.options);
    const allowFreeText = p.allow_free_text === true;
    const multiSelect = p.multi_select === true;
    const hasForm = p.form !== undefined && p.form !== null;
    if (kind === 'approval' && (options.length !== 2 || allowFreeText || multiSelect || hasForm)) return null;
    let form = null;
    if (hasForm) {
      form = formOf(p.form);
      if (!form || options.length || allowFreeText || multiSelect) return null; // every question lives in its item
    } else if (!options.length && !allowFreeText) return null;
    if (options.some(o => !o.label)) return null;
    const agent = typeof p.agent === 'string' && AGENT_SLUG.test(p.agent) ? p.agent : 'pi';
    const projectName = typeof p.project_name === 'string' ? p.project_name : null;
    const freeTextMax = p.free_text_max === 4000 ? 4000 : 2000;
    return { id: p.id, kind, agent, projectName, text: p.text, options, allowFreeText, multiSelect, form, freeTextMax,
      expiresAt: Number.isFinite(p.expires_at) ? p.expires_at : 0,
      // a Pi-session answer: it authorizes nothing in the backend and never uses the approval card
      approvesProposal: false };
  }

  // ---- trusted gate + keyboard ---------------------------------------------------
  const trusted = event => !!event && event.isTrusted === true;
  // Display-only opener. No normalization, answer, decline, or fallback expand:
  // the native adapter alone admits the current live UUID/kind pair.
  function openPayload(event, notice, kind) {
    if (!trusted(event) || !notice || typeof notice.id !== 'string' || !UUID_V4.test(notice.id) ||
      (kind !== 'question' && kind !== 'finished')) return null;
    return { id: notice.id, kind };
  }
  // Digit 1..N picks that option. Never while typing, never with a modifier, an
  // IME composition or a repeat, and never from a synthetic event. Enter on its
  // own picks nothing: no option is ever preselected.
  function optionForKey(notification, event, ctx) {
    if (!notification || !trusted(event) || (ctx && ctx.typing)) return -1;
    if (event.ctrlKey || event.altKey || event.metaKey || event.isComposing || event.repeat) return -1;
    if (!/^[1-9]$/.test(String(event.key))) return -1;
    const at = Number(event.key) - 1;
    return at < notification.options.length ? notification.options[at].index : -1;
  }

  // The notification can be answered ONLY while it is actually on screen:
  // expanded island, no approval card covering it. Questions paint above every
  // view, even before the incoming-question navigation settles.
  const onScreen = d => !!d && d.phase === 'expanded' && !d.card;

  // ---- expiry (epoch milliseconds) --------------------------------------------------
  const expired = (expiresAt, now) => !Number.isFinite(expiresAt) || expiresAt <= now;
  function expiryWord(expiresAt, now) {
    if (!Number.isFinite(expiresAt) || !Number.isFinite(now)) return '';
    const ms = expiresAt - now;
    if (ms <= 0) return 'Vencida';
    if (ms < 60000) return '<1 min';
    const min = Math.ceil(ms / 60000);
    if (min < 60) return `${min} min`;
    return `${Math.ceil(min / 60)} h`;
  }
  const fraction = (expiresAt, now, total) => (total > 0 && Number.isFinite(expiresAt)
    ? Math.max(0, Math.min(1, (expiresAt - now) / total)) : 0);

  // ---- outcomes (host QuestionOutcome → icon + one word) -------------------------------
  // «Enviada» is NEUTRAL (live plane): the result is not confirmed. Only the
  // producer's own acknowledgement (answered) is lime. A problem is never hidden.
  const OUTCOMES = Object.freeze({
    sent: { tone: 'live', icon: 'plane', word: 'Enviada', aria: 'Respuesta enviada; todavía sin confirmar', persistent: false },
    answered: { tone: 'go', icon: 'check', word: 'Recibida', aria: 'El agente recibió tu respuesta', persistent: false },
    human_cancelled: { tone: 'faint', icon: 'cross', word: 'Omitida', aria: 'Omitiste la pregunta del agente', persistent: false },
    expired: { tone: 'faint', icon: 'clock-off', word: 'Vencida', aria: 'La pregunta del agente venció sin respuesta', persistent: false },
    cancelled: { tone: 'faint', icon: 'cross', word: 'Cancelada', aria: 'El agente retiró la pregunta', persistent: false },
    // F4: Claude Code and Codex questions disconnect too; the outcome itself does not know which agent asked
    disconnected: { tone: 'faint', icon: 'plug-off', word: 'Sin conexión', aria: 'Se cortó la conexión con el agente; la pregunta se descartó', persistent: false },
    busy: { tone: 'faint', icon: 'lock', word: 'Ocupada', aria: 'Otra pregunta se rechazó porque ya había una abierta', persistent: false },
    rejected: { tone: 'red', icon: 'triangle', word: 'Rechazada', aria: 'El agente rechazó la respuesta; no se aplicó a ninguna otra pregunta', persistent: true },
    ack_lost: { tone: 'red', icon: 'triangle', word: 'Sin confirmar', aria: 'No llegó la confirmación del agente; no se sabe si recibió tu respuesta', persistent: true },
    outcome_unknown: { tone: 'red', icon: 'triangle', word: 'Sin confirmar', aria: 'No se pudo confirmar el envío de la respuesta', persistent: true },
  });
  const outcomeView = outcome => (typeof outcome === 'string' && Object.prototype.hasOwnProperty.call(OUTCOMES, outcome)
    ? { outcome, ...OUTCOMES[outcome] } : null);

  // ---- view phase ---------------------------------------------------------------------
  // Pending always beats a stale notice. Controls die on local expiry, while a
  // send is in flight and while the native window barrier is not idle.
  function phase(snapshot, ctx) {
    const c = ctx || {};
    const s = snapshot && snapshot.available !== false ? snapshot : null;
    if (!s) return { kind: 'none', controlsEnabled: false };
    const n = fromPending(s.pending);
    if (n) {
      const now = Number.isFinite(c.now) ? c.now : Date.now();
      if (expired(n.expiresAt, now)) return { kind: 'expired', notification: n, controlsEnabled: false, outcome: outcomeView('expired') };
      const barrier = s.native_transition && s.native_transition !== 'idle';
      return { kind: c.inFlight ? 'sending' : 'pending', notification: n, controlsEnabled: !c.inFlight && !barrier };
    }
    const outcome = outcomeView(s.notice);
    return outcome ? { kind: 'outcome', outcome, controlsEnabled: false } : { kind: 'none', controlsEnabled: false };
  }

  // ---- sound cues (catalog ids only; playing them is a separate OFF-by-default switch) --------
  const SILENT = new Set(['sent', 'ack_lost', 'outcome_unknown', 'answered', 'human_cancelled', 'rejected', 'busy', 'disconnected', 'cancelled']);
  function soundFor(prev, next) {
    if (!prev || !next) return null; // nothing sounds at start-up or without history
    const before = fromPending(prev.pending), after = fromPending(next.pending);
    if (after && (!before || before.id !== after.id)) return 'snd.attention';
    // an expiry is an EVENT: the question that was pending last time is gone and the host says expired
    // (a retained old notice must not swallow a second expiry, nor re-fire on an unrelated update)
    if (!after && before && next.notice === 'expired') return 'snd.expired';
    if (next.notice && SILENT.has(next.notice)) return null; // «Enviada»/«Sin confirmar» NEVER sound
    return null;
  }
  // ---- terminal-outcome EVENTS (Sileo toast): the EDGE into an outcome, never the retained notice -------------------------------
  // A question that was pending and is gone with the host saying expired/cancelled/disconnected is ONE event; «busy» is the notice
  // changing to busy while something else is open. human_cancelled is the human's own click (no toast); sent/answered never prove
  // the agent ran anything, so they are no events. A repeated snapshot (same notice, nothing pending before) is never an event.
  const GONE_OUTCOMES = new Set(['expired', 'cancelled', 'disconnected']);
  function outcomeEvent(prev, next) {
    if (!prev || !next || typeof next.notice !== 'string') return null;
    const before = fromPending(prev.pending), after = fromPending(next.pending);
    if (!after && before && GONE_OUTCOMES.has(next.notice)) return { outcome: next.notice, agent: before.agent };
    if (next.notice === 'busy' && prev.notice !== 'busy') return { outcome: 'busy', agent: after ? after.agent : null };
    return null;
  }
  // At most one cue per 250 ms; the same cue once per 2 s; the rest is dropped.
  function createCueLimiter() {
    let last = -Infinity; const byId = new Map();
    return { allow(id, now) {
      if (!id) return false;
      if (now - last < 250) return false;
      if (byId.has(id) && now - byId.get(id) < 2000) return false;
      last = now; byId.set(id, now); return true;
    } };
  }

  // ---- reveal (#266): an incoming question/notice opens a resting island -------
  // SILEO-STYLE REVEAL, decided here as pure policy so it is deterministic:
  // the gates say WHICH snapshots are new events, revealAction says whether the
  // visible capsule may act on one. Boot history is never an event — the first
  // observation of each channel is only the baseline, exactly like the sound
  // wiring's observeNotices — so a duplicated cached snapshot or an old notice
  // never reopens or re-animates the island. Revealing is opening and showing:
  // it never answers, never focuses, never touches an opaque value.
  const NOTICE_SEEN_MAX = 200; // insertion-ordered memory of notice ids already shown
  function createRevealGate() {
    let questionSeen; // undefined = no baseline; then the last live pending id (or null)
    let noticeSeen;   // undefined = no baseline; then a Set of ids already observed
    function arrivals(notices) {
      const list = (Array.isArray(notices) ? notices : []).filter(x => x && typeof x.id === 'string');
      if (noticeSeen === undefined) { noticeSeen = new Set(list.map(x => x.id)); return []; }
      const fresh = list.filter(x => !noticeSeen.has(x.id));
      if (noticeSeen.size > NOTICE_SEEN_MAX) {
        for (const old of noticeSeen) { noticeSeen.delete(old); if (noticeSeen.size <= NOTICE_SEEN_MAX / 2) break; }
      }
      for (const x of list) noticeSeen.add(x.id);
      return fresh;
    }
    return {
      // A live, well-formed pending question whose id differs from the last seen
      // one fires EXACTLY once. Expired or malformed pendings are no events; a
      // question that went away (answered/expired/cancelled/declined) frees its
      // id, so a genuine re-issue is a new event.
      question(snapshot, now) {
        const n = fromPending(snapshot && snapshot.pending);
        const id = n && !expired(n.expiresAt, now) ? n.id : null;
        if (questionSeen === undefined) { questionSeen = id; return false; }
        const fire = id !== null && id !== questionSeen;
        questionSeen = id;
        return fire;
      },
      // Host order is oldest-first. Admit new arrivals anywhere in a batch,
      // seed every retained row, and never mistake dismissal for arrival.
      // FIFO memory stays bounded; a pruned replay is honestly a new event.
      arrivals,
      notice(notices) { return arrivals(notices).length > 0; },
    };
  }
  // A04c: presentation lifetime only. Retained host notices are never deleted.
  // Coucou hooks.ts Stop retires the finished state after 5200ms; the caller
  // owns navigation/admission and must recheck protected state before folding.
  const FINISHED_MS = 5200;
  function createFinishedCycle(options) {
    const gate = createRevealGate();
    let id = null, timer = null, generation = 0, stopped = false;
    function end(expired) {
      generation++;
      if (timer !== null) options.cancel(timer);
      timer = null;
      const previous = id; id = null;
      if (previous !== null) options.end(previous, expired);
    }
    function start(next) {
      generation++;
      if (timer !== null) options.cancel(timer);
      timer = null; id = next;
      const serial = generation, due = options.now() + FINISHED_MS;
      options.start(id);
      function deliver() {
        if (stopped || serial !== generation) return;
        const remaining = due - options.now();
        if (remaining > 0) timer = options.schedule(deliver, Math.max(1, remaining));
        else end(true);
      }
      timer = options.schedule(deliver, FINISHED_MS);
    }
    return Object.freeze({
      observe(notices, allowed) {
        if (stopped) return false;
        const list = Array.isArray(notices) ? notices : [];
        const arrivals = gate.arrivals(list);
        if (id !== null && (!allowed || !list.some(n => n && n.id === id))) end(false);
        const latest = arrivals.at(-1);
        if (latest) {
          if (allowed && (!latest.kind || latest.kind === 'settled')) start(latest.id);
          else end(false); // a problem/pending context never remains under finished
        }
        return arrivals.length > 0;
      },
      cancel() { if (!stopped) end(false); },
      stop() { end(false); stopped = true; },
    });
  }
  // Only a resting compact island or a HIDDEN one expands: the reveal goes
  // through the host's own `expand` verb (Rust owns the native geometry; the
  // existing spring animates the reveal, and the M1 reduced-motion contract
  // snaps it instantly — the policy is deliberately preserved). #266 S2 Path
  // B (parent decision 2026-10-12): src/desktop.rs now lets `expand` reveal
  // from Hidden too, and src/main.rs SHOWS the window without ever requesting
  // focus, normalizing a stale expanded core instead of toggle-collapsing it.
  // While hidden the local phase attribute can be stale from before the hide,
  // so the host state wins; the host owns the geometry either way. A visible
  // mid-animation island is never double-poked (interruptible by design).
  function revealAction(capsule) {
    const c = capsule || {};
    if (c.state === 'hidden') return 'expand';
    // R23: only a new question interrupts an open view; notices keep their policy.
    if (c.question && c.phase === 'expanded') return c.view === 'chat' ? 'leave-chat' : 'show-question';
    if (c.phase !== 'compact') return 'none';
    if (c.state === 'expanded') return 'none';
    // HU-006 S4: a notice is shown inside a visible compact pill; growing it is the human's action (S6).
    if (c.notice && !c.question) return 'none';
    return 'expand';
  }

  // ---- free text -----------------------------------------------------------------------
  const utf8Bytes = text => {
    let n = 0;
    for (const ch of String(text)) { const c = ch.codePointAt(0); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; }
    return n;
  };
  function textWord(budget, text) {
    if (!text || !budget || budget.allowed !== false) return '';
    return budget.reason === 'frame_too_large' ? 'Muy largo' : 'No válido';
  }
  // The host's byte budget is authoritative: no answer yet, or «not allowed», means no send.
  const canSendText = (budget, text) => !!budget && budget.allowed === true && typeof text === 'string' && text.trim().length > 0;

  // ---- «Enviada» race ---------------------------------------------------------------------------------------------
  // The reply to a send is the view computed right after the write (notice «sent»); the producer's ack can push the newer
  // state (notice «answered») BEFORE that reply resolves. A reply is current only if no push arrived while it was in flight,
  // and a terminal outcome never rolls back to «sent» for the same send.
  const replyIsCurrent = (sentAt, now) => Number.isSafeInteger(sentAt) && Number.isSafeInteger(now) && sentAt === now;
  const TERMINAL = new Set(['answered', 'human_cancelled', 'rejected', 'ack_lost', 'outcome_unknown', 'cancelled', 'expired', 'disconnected']);
  function regressesToSent(previous, next) {
    if (!previous || !next || next.notice !== 'sent' || next.pending) return false;
    return !previous.pending && TERMINAL.has(previous.notice);
  }

  // ---- auto-size (human: «cuando son largas, abito se ajusta al tamaño») ---------------------------------------------
  // The native window is fixed at 340 high (geometry::ISLAND_WINDOW); the island is drawn inside it. The question card is 148 at
  // minimum (Coucou) and sits 52px below the top of the island (42 offset + 10 breathing room), so the island grows with the
  // card up to the window minus a margin, and a longer card scrolls inside itself instead of pushing the buttons out.
  const QUESTION_MIN_CARD_H = 148, QUESTION_CARD_OFFSET = 52, QUESTION_MAX_ISLAND_H = 332;
  // `maxIslandH` is what the host granted (Rust: the window grows on demand up to 70% of the work area); the default is the
  // fixed window. A nonsense cap falls back to the default, and never below the minimum card.
  function questionLayout(contentH, maxIslandH) {
    const h = Number.isFinite(contentH) && contentH > 0 ? Math.ceil(contentH) : 0;
    const cap = Number.isFinite(maxIslandH) && maxIslandH > 0 ? Math.floor(maxIslandH) : QUESTION_MAX_ISLAND_H;
    const max = Math.max(QUESTION_MIN_CARD_H, cap - QUESTION_CARD_OFFSET);
    const cardH = Math.min(max, Math.max(QUESTION_MIN_CARD_H, h));
    return { cardH, islandH: cardH + QUESTION_CARD_OFFSET, scroll: h > max };
  }
  // The native window is the island plus 8px of air; a closed question (0) gives the fixed 340 back (Rust clamps up to it).
  const WINDOW_AIR = 8, WINDOW_FIXED_H = 340;
  const windowHeightFor = islandH => (Number.isFinite(islandH) && islandH > 0 ? Math.max(WINDOW_FIXED_H, Math.ceil(islandH) + WINDOW_AIR) : WINDOW_FIXED_H);
  const TEXTAREA_MIN_H = 44, TEXTAREA_MAX_H = 120;
  function textareaHeight(scrollH) {
    const h = Number.isFinite(scrollH) && scrollH > 0 ? Math.ceil(scrollH) : 0;
    return { height: Math.min(TEXTAREA_MAX_H, Math.max(TEXTAREA_MIN_H, h)), scroll: h > TEXTAREA_MAX_H };
  }

  // ---- structured answers: drafts, multi-select, questionnaire wizard ----------------------------------------------
  // Pure and immutable. The wizard keeps one draft per question so Anterior/Siguiente never loses what was typed or picked;
  // nothing leaves the page until the human presses «Hecho» / «Enviar» (a trusted click or key), all-or-nothing.
  const newDraft = () => ({ picked: [], text: '', other: false });
  function toggleOption(item, draft, index) {
    if (!item || !Array.isArray(item.options) || !item.options.some(o => o.index === index)) return draft;
    const has = draft.picked.includes(index);
    if (item.multiSelect) return { picked: (has ? draft.picked.filter(i => i !== index) : [...draft.picked, index]).sort((a, b) => a - b), text: draft.text, other: draft.other };
    return { picked: has ? [] : [index], text: '', other: false }; // single: replace; a pick closes «Otra cosa…» and drops what was typed
  }
  // «N. Otra cosa…»: the last row, only when the question takes free text. Opening it reveals the growing textarea; closing it
  // (Esc / un-ticking) discards what was typed. In a single-select question it replaces the pick; in multi-select it adds to them.
  function toggleOther(item, draft) {
    if (!item || !item.allowFreeText) return draft;
    if (draft.other) return { picked: draft.picked, text: '', other: false };
    return { picked: item.multiSelect ? draft.picked : [], text: draft.text, other: true };
  }
  // Typing opens «Otra cosa…» by itself. A typed answer to a SINGLE-select question replaces its pick; multi keeps both.
  function setDraftText(item, draft, text) {
    if (!item || !item.allowFreeText) return draft;
    const t = typeof text === 'string' ? text : '';
    return { picked: !item.multiSelect && t.trim() ? [] : draft.picked, text: t, other: draft.other || t.trim().length > 0 };
  }
  const OTHER_LABEL = 'Otra cosa…';
  // The vertical list the card draws: «1. label» (description below, smaller), then «N. Otra cosa…» last when free text is allowed.
  function optionRows(item, draft) {
    const control = item.multiSelect ? 'checkbox' : 'row';
    const rows = item.options.map((o, i) => ({ kind: 'option', index: o.index, number: i + 1, label: o.label, description: o.description || '',
      checked: draft.picked.includes(o.index), control }));
    if (item.allowFreeText) rows.push({ kind: 'other', index: -1, number: rows.length + 1, label: OTHER_LABEL, description: '', checked: draft.other, control });
    return { rows, showText: !!item.allowFreeText && draft.other };
  }
  const singleItem = n => ({ header: '', text: n.text, options: n.options, multiSelect: false, allowFreeText: n.allowFreeText });
  const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
  const textFits = (text, max) => typeof text === 'string' && text.trim().length > 0 && !CONTROL.test(text) && Array.from(text).length <= max;
  const draftAnswered = (item, draft, max) => draft.picked.length > 0 || (!!item.allowFreeText && draft.other && textFits(draft.text, max));
  function itemPayload(item, draft, max) {
    const hasText = draft.other && draft.text.trim().length > 0;
    if (draft.text.trim() && !draft.other) return null; // text with «Otra cosa…» closed is not an answer
    if (hasText && (!item.allowFreeText || !textFits(draft.text, max))) return null; // over-long or malformed: refused, never trimmed
    const typed = hasText ? draft.text : null;
    if (item.multiSelect) {
      if (!draft.picked.length && !typed) return null;
      return { indexes: [...draft.picked].sort((a, b) => a - b), ...(typed ? { text: typed } : {}) };
    }
    if (draft.picked.length) return { index: draft.picked[0] };
    return typed ? { text: typed } : null;
  }
  const multiItem = n => ({ header: '', text: n.text, options: n.options, multiSelect: true, allowFreeText: n.allowFreeText });
  const multiView = (n, draft) => {
    const canDone = draftAnswered(multiItem(n), draft, n.freeTextMax);
    const count = draft.picked.length + (draft.other && draft.text.trim() ? 1 : 0);
    // S7: «Hecho (N)» counts what is marked; at 0 it stays «Hecho», disabled, with the reason as its accessible/tooltip text
    return { label: count > 0 ? `Hecho (${count})` : 'Hecho', canDone, reason: canDone ? '' : 'Marcá al menos una' };
  };
  function manyPayload(n, draft) {
    if (!n || !n.multiSelect || n.form) return null;
    const p = itemPayload(multiItem(n), draft, n.freeTextMax);
    return p ? { action: 'answer_many', id: n.id, ...p } : null;
  }
  const formStart = n => ({ step: 0, review: false, drafts: n.form.map(newDraft) });
  function formReduce(n, st, ev) {
    if (!n || !n.form || !st || !ev || typeof ev !== 'object') return st;
    const last = n.form.length - 1, item = n.form[st.step];
    const setDraft = d => ({ ...st, drafts: st.drafts.map((x, i) => (i === st.step ? d : x)) });
    switch (ev.type) {
      case 'toggle': return st.review ? st : setDraft(toggleOption(item, st.drafts[st.step], ev.index));
      case 'other': return st.review ? st : setDraft(toggleOther(item, st.drafts[st.step]));
      case 'text': return st.review ? st : setDraft(setDraftText(item, st.drafts[st.step], ev.text));
      case 'next':
        if (st.review || !draftAnswered(item, st.drafts[st.step], n.freeTextMax)) return st;
        return st.step === last ? { ...st, review: true } : { ...st, step: st.step + 1 };
      case 'prev':
      case 'back':
        if (st.review) return { ...st, review: false };
        return st.step > 0 ? { ...st, step: st.step - 1 } : st;
      default: return st;
    }
  }
  const describeAnswer = (item, draft) => {
    const labels = draft.picked.map(i => (item.options.find(o => o.index === i) || {}).label).filter(Boolean);
    const typed = draft.other && draft.text.trim() ? `«${draft.text.trim()}»` : '';
    return [labels.join(', '), typed].filter(Boolean).join(' · ');
  };
  function formView(n, st) {
    const total = n.form.length, max = n.freeTextMax;
    if (st.review) {
      return { mode: 'review', step: total, total, label: 'Resumen', header: '', text: '', item: null, draft: null, canPrev: true, canNext: false, dots: Array.from({ length: total }, () => 'done'),
        primary: { kind: 'send', label: 'Enviar', enabled: n.form.every((it, i) => draftAnswered(it, st.drafts[i], max)) },
        summary: n.form.map((it, i) => ({ header: it.header, text: it.text, answer: describeAnswer(it, st.drafts[i]) })) };
    }
    const item = n.form[st.step], draft = st.drafts[st.step], ok = draftAnswered(item, draft, max);
    return { mode: 'step', step: st.step, total, label: `${st.step + 1} de ${total}`, stepText: `Paso ${st.step + 1} de ${total}`, dots: Array.from({ length: total }, (_, i) => (i < st.step ? 'done' : i === st.step ? 'current' : 'todo')), header: item.header, text: item.text, item, draft,
      canPrev: st.step > 0, canNext: ok, primary: { kind: 'next', label: 'Siguiente', enabled: ok }, summary: null };
  }
  function formPayload(n, st) {
    if (!n || !n.form || !st) return null;
    const answers = n.form.map((it, i) => itemPayload(it, st.drafts[i], n.freeTextMax));
    return answers.every(Boolean) ? { action: 'answer_form', id: n.id, answers } : null;
  }
  // Space/Enter on a focused row use the native button/checkbox behaviour. Digits pick (the digit after the options is «Otra cosa…»),
  // arrows move between rows, Enter goes next / sends, Esc closes «Otra cosa…» or goes back. Never while composing, repeating, with
  // a modifier, or from a synthetic event.
  function keyIntent(event, ctx) {
    const c = ctx || {};
    if (!event || event.isTrusted !== true || event.isComposing || event.repeat || event.ctrlKey || event.altKey || event.metaKey) return null;
    if (event.key === 'Escape') {
      if (c.typing && c.otherOpen) return { type: 'other' };
      return c.canPrev ? { type: 'back' } : null;
    }
    if (event.key === 'Enter') {
      if (event.shiftKey && c.typing) return null;
      return c.primary && c.primary.enabled ? { type: c.primary.kind } : null;
    }
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !c.typing && !c.review) return { type: 'move', delta: event.key === 'ArrowDown' ? 1 : -1 };
    if (/^[1-9]$/.test(String(event.key)) && !c.typing && !c.review) {
      const at = Number(event.key) - 1, count = c.optionCount || 0;
      if (at < count) return { type: 'toggle', index: at };
      return c.hasOther && at === count ? { type: 'other' } : null;
    }
    return null;
  }

  // ONE rule for both sizes: a question on screen (pending or expired) asks for its measured layout; every other state - answered,
  // declined, cancelled, terminal won, expired-and-gone, an outcome word - gives the height back (island 0 = overview, window 340).
  function sizeSync(o) {
    const shown = !!o && (o.question === 'pending' || o.question === 'expired');
    const islandH = shown && Number.isFinite(o.islandH) && o.islandH > 0 ? Math.ceil(o.islandH) : 0;
    return { islandH, windowH: windowHeightFor(islandH) };
  }

  // L5: a click on the blobs column while «Recibida» (the question outcome) shows ends the outcome early; nothing else is dismissible this way.
  const outcomeDismissible = d => !!d && d.question === 'outcome';

  return { projectLabel, outcomeDismissible, sizeSync, optionRows, singleItem, toggleOther, OTHER_LABEL, newDraft, toggleOption, setDraftText, textFits, draftAnswered, itemPayload, multiView, manyPayload, formStart, formReduce, formView, formPayload, keyIntent, windowHeightFor, questionLayout, textareaHeight, QUESTION_MAX_ISLAND_H, QUESTION_MIN_CARD_H, replyIsCurrent, regressesToSent, MAX_OPTIONS, SOUND_ENABLED_DEFAULT, fromPending, askedBy, askerName, askerLine, queueLabel, agentLabel, trusted, openPayload, onScreen, optionForKey, expired, expiryWord, fraction,
    outcomeView, phase, soundFor, outcomeEvent, createCueLimiter, createRevealGate, createFinishedCycle, FINISHED_MS, revealAction, NOTICE_SEEN_MAX, utf8Bytes, textWord, canSendText };
});
