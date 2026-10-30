'use strict';
/* U1 — pure chat view helpers (no DOM, no IPC, no network). Loaded by the
   island page as a classic script (window.AbitoChatView) and by
   test-node/chat-view-check.cjs through `module.exports`. Every value it
   renders is plain text; the page writes it with textContent only. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AbitoChatView = Object.freeze(api);
})(typeof self !== 'undefined' ? self : this, () => {
  const DRAFT_MAX = 8000; // Unicode scalars, same as chat.rs DRAFT_MAX_SCALARS

  const LABELS = Object.freeze({
    queued: 'En cola',
    thinking: 'Pensando…',
    streaming: 'Escribiendo…',
    waiting_approval: 'Esperando aprobación',
    completed: 'Respondió',
    cancelled: 'Cancelado',
    error: 'Error',
  });
  const stateLabel = state => LABELS[state] || '';

  const scalarCount = text => Array.from(text).length;

  // Mirrors chat.rs validate_text: C0/DEL/C1 except LF and TAB are refused.
  function draftProblem(text) {
    const normalized = String(text).replace(/\r\n?/g, '\n');
    if (scalarCount(normalized) > DRAFT_MAX) return 'El mensaje supera los 8.000 caracteres.';
    if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(normalized)) return 'El mensaje contiene caracteres de control.';
    if (!normalized.trim()) return 'El mensaje está vacío.';
    return null;
  }

  const SENDABLE = new Set(['ready', 'busy']);
  function canSend(view, draft, inFlight) {
    if (!view || inFlight || view.active_turn) return false;
    const a = view.availability;
    if (!a || !SENDABLE.has(a.state)) return false;
    return draftProblem(draft) === null;
  }

  // The chip says «checking» (a spinner) while the model's availability is still `unchecked`. The host resets it to `unchecked` whenever the
  // chosen model changes and only re-checks when the chat is OPENED; a model picked while the chat is already open used to leave the spinner
  // there for good (screen validation v4). The page therefore asks the host for the (metadata-only) check itself, a bounded number of times.
  const CHECK_TRIES = 3, CHECK_GAP_MS = 4000;
  function needsCheck(view) {
    if (!view || !view.target || view.active_turn) return false;
    return !!view.availability && view.availability.state === 'unchecked';
  }
  /** tries = asks already made in this «unchecked» episode, now/last = ms clocks: {ask, wait, giveUp?}. */
  function checkPlan(tries, now, last) {
    if (tries >= CHECK_TRIES) return { ask: false, wait: 0, giveUp: true };
    if (tries === 0) return { ask: true, wait: 0 };
    const due = last + CHECK_GAP_MS;
    return now >= due ? { ask: true, wait: 0 } : { ask: false, wait: due - now };
  }

  // Design 14 (option A): the send disc is grey ONLY when there is nothing to send (empty draft), a turn runs, or a submit is in flight.
  // A model that is not ready no longer greys it out silently: pressing it says why (`blocked`), and canSend() still decides what is sent.
  const BLOCKED = Object.freeze({ unavailable: 'El modelo no está disponible todavía.', blocked: 'El modelo está bloqueado.', unchecked: 'Todavía se está revisando el modelo.' });
  function sendState(view, draft, inFlight) {
    const empty = !String(draft).trim();
    if (empty || inFlight || (view && view.active_turn)) return { disabled: true, blocked: null };
    const a = view && view.availability;
    if (!a || !SENDABLE.has(a.state)) return { disabled: false, blocked: (a && BLOCKED[a.state]) || 'El modelo no está listo todavía.' };
    return { disabled: false, blocked: null };
  }

  // Rust increments a turn's seq for every accepted event. A delayed view
  // response or publisher must not undo an event already rendered. Turn ids
  // are scoped to the conversation, so switching conversations is never stale.
  function staleSnapshot(before, next) {
    if (!before || !next || !before.conversation_id || before.conversation_id !== next.conversation_id ||
        !Array.isArray(before.turns) || !Array.isArray(next.turns)) return false;
    const sequences = new Map(before.turns.map(t => [t.turn_id, t.seq]));
    return next.turns.some(t => Number.isSafeInteger(t.seq) &&
      Number.isSafeInteger(sequences.get(t.turn_id)) && t.seq < sequences.get(t.turn_id));
  }

  function activeTurn(view) {
    if (!view || !view.active_turn || !Array.isArray(view.turns)) return null;
    return view.turns.find(t => t.turn_id === view.active_turn) || null;
  }

  function statusLine(view) {
    if (!view) return 'Chat no disponible.';
    const active = activeTurn(view);
    if (active) {
      const label = stateLabel(active.state);
      return view.queue_note ? `${label} · ${view.queue_note}` : label;
    }
    return (view.availability && view.availability.message) || 'Chat no disponible.';
  }

  // UI.2 chat (docs/desktop-visual-language.md §2.3/§3): the header state as
  // {tone, icon, word, kind, aria}. A word stays ONLY for problems
  // («Modelo caído», «Error», «Bloqueado», «Ocupado»); the full sentence is aria.
  function statusView(view) {
    const aria = statusLine(view);
    const mk = (kind, tone, icon, word) => ({ kind, tone, icon, word, aria });
    if (!view) return mk('down', 'red', 'triangle', 'Modelo caído');
    const active = activeTurn(view);
    if (active) {
      if (active.state === 'waiting_approval') return mk('waiting', 'sun', '', '');
      if (active.state === 'queued') return mk('queued', 'live', 'clock', '');
      return mk('busy', 'live', 'ring', ''); // thinking / streaming: blue open arc, spun by the page
    }
    const state = view.availability && view.availability.state;
    if (state === 'ready') return mk('ready', 'go', '', 'Conectado'); // T7.3 isla-chat-*: the visible state chip
    if (state === 'busy') return mk('occupied', 'live', 'clock', 'Ocupado');
    if (state === 'blocked') return mk('blocked', 'red', 'triangle', 'Bloqueado');
    if (state === 'unavailable') return mk('down', 'red', 'triangle', 'Modelo caído');
    return mk('checking', 'live', 'ring', '');
  }
  // R6 pose for the chat lane, from real state only: a turn thinking -> think,
  // streaming -> speak; the model down/blocked or a failed last turn -> error;
  // everything else (ready, queued, waiting for approval) -> rest (null).
  function poseFor(view) {
    if (!view) return null;
    const active = activeTurn(view);
    if (active) return active.state === 'thinking' ? 'think' : active.state === 'streaming' ? 'speak' : null;
    const a = view.availability && view.availability.state;
    if (a === 'unavailable' || a === 'blocked') return 'error';
    const last = Array.isArray(view.turns) && view.turns.length ? view.turns[view.turns.length - 1] : null;
    return last && last.state === 'error' ? 'error' : null;
  }
  // Draft problem as one visible word; empty draft shows nothing.
  function draftWord(text) {
    const normalized = String(text).replace(/\r\n?/g, '\n');
    if (scalarCount(normalized) > DRAFT_MAX) return 'Muy largo';
    if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(normalized)) return 'Caracteres no válidos';
    return '';
  }
  const targetAria = t => (t ? `${t.alias}, ${String(t.profile_id || '').startsWith('cloud-') ? 'nube' : 'sólo local'}, ${String(t.origin || '').replace(/^https?:\/\//, '')}` : 'Sin modelo local elegido');

  const lastTurn = view => (view && Array.isArray(view.turns) && view.turns.length)
    ? view.turns[view.turns.length - 1] : null;

  // Polite live-region text: once per state change / completed turn, never
  // per streamed token.
  function announcement(previous, next) {
    const turn = lastTurn(next);
    if (!turn) return null;
    const before = lastTurn(previous);
    const sameTurn = before && before.turn_id === turn.turn_id;
    if (sameTurn && before.state === turn.state) return null;
    if (turn.state === 'completed') {
      const reply = turn.reply.length > 300 ? turn.reply.slice(0, 300) + '…' : turn.reply;
      return `Koda respondió: ${reply}`;
    }
    if (turn.state === 'error') return (turn.error && turn.error.safe_message) || 'Error';
    return stateLabel(turn.state) || null;
  }

  const atBottom = (scrollTop, scrollHeight, clientHeight) => scrollHeight - scrollTop - clientHeight <= 8;

  // ---- F027: the empty-conversation greeting ---------------------------------
  // The one explicit source of a person's name is the field the page receives
  // (`display_name`), from the explicit optional local preference in prefs.json
  // v1. Nothing here guesses a name from the OS, an account, another profile,
  // a provider or the branding: no explicit field, no greeting (S2).
  const DISPLAY_NAME_MAX = 80; // mirrors prefs.rs DISPLAY_NAME_MAX
  // T7.3 (design isla-chat-empty): the empty state is ONE visible line; the long honest sentence stays in aria.
  const EMPTY_ICONS = Object.freeze([]);
  const EMPTY_LINE = 'Escribile a Koda';
  const EMPTY_ARIA = 'Escribile a Koda. Responde el modelo local de esta máquina; no ve tu pantalla ni ejecuta nada.';

  // A name is text the person typed: never markup. A non-string is absent (fail
  // closed), control characters become spaces, the length is bounded in Unicode
  // scalars (never splitting a surrogate pair) and blank reads as absent. The
  // page writes the result with textContent only, never into HTML (S4).
  function cleanDisplayName(value) {
    if (typeof value !== 'string') return '';
    const plain = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ');
    return Array.from(plain).slice(0, DISPLAY_NAME_MAX).join('').trim();
  }

  // What the empty conversation shows: the shipped sentence, byte for byte, when
  // no explicit name is present (the neutral state stays icon-only), and
  // «Hola, <nombre>.» in front of it when one is. `greeting` is the visible line
  // ('' = nothing visible) and `aria` is what the whole row is announced as.
  function emptyGreeting(view) {
    const name = cleanDisplayName(view && view.display_name);
    if (!name) return { greeting: '', aria: EMPTY_ARIA, icons: EMPTY_ICONS, line: EMPTY_LINE };
    return { greeting: `Hola, ${name}.`, aria: `Hola, ${name}. ${EMPTY_ARIA}`, icons: EMPTY_ICONS, line: EMPTY_LINE };
  }

  function newRequestId(bytes) {
    return 'req-' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }

  // Rows for one turn: user, optional trim note, assistant/error, notes.

  // ---- #310: reconcile the history instead of rebuilding it ----------------------------------------------------
  // The log used to be emptied and redrawn on every state push (a streaming answer pushes many), which made
  // every row flash and the first row jump. Rows are now compared by a key that covers everything drawn:
  // the unchanged prefix is left alone, a changed row is patched in place, new rows are appended.
  const rowKey = row => JSON.stringify([row.kind, row.text, row.short || '', row.icon || '']);
  function reconcileRows(before, after) {
    const a = Array.isArray(before) ? before : [];
    const b = Array.isArray(after) ? after : [];
    let keep = 0;
    while (keep < a.length && keep < b.length && rowKey(a[keep]) === rowKey(b[keep])) keep += 1;
    const patch = [];
    let i = keep;
    for (; i < a.length && i < b.length; i += 1) patch.push({ index: i, row: b[i] });
    return { keep, patch, append: b.slice(i), remove: Math.max(0, a.length - b.length) };
  }

  // ---- #371 (OD002/OD024/GD031): tool-call receipts and approval cards ------
  // Field-driven: these rows exist ONLY when the turn carries `tool_calls` /
  // `approvals`. Today no producer emits them (the local-model lane is text
  // only), so a plain turn renders byte-identically; this contract is what the
  // future agent lane fills: `tool_calls: [{call_id, name, state:
  // 'running'|'done'|'failed', summary?}]`, `approvals: [{request_id,
  // operation, decision: 'approved'|'denied'|'expired'}]`. Everything renders
  // as ONE bounded plain-text line per card: control characters collapse to
  // spaces, the scalar count is capped (never splitting a surrogate pair), and
  // a receipt that cannot name its call never renders. An unmodelled state or
  // decision is announced as unknown, never guessed.
  const CARD_NAME_MAX = 80;
  const CARD_SUMMARY_MAX = 240;
  const TOOL_STATES = Object.freeze({
    running: { word: 'En curso', icon: 'clock' },
    done: { word: 'Listo', icon: 'check' },
    failed: { word: 'Falló', icon: 'triangle' },
  });
  const TOOL_UNKNOWN = { word: 'Desconocido', icon: 'info' };
  // The decision words reuse the #338 card vocabulary (Permitir/Denegar; the
  // honest expiry of a proposal that can no longer be decided).
  const APPROVAL_DECISIONS = Object.freeze({
    approved: { word: 'Permitida', icon: 'check' },
    denied: { word: 'Denegada', icon: 'cross' },
    expired: { word: 'Vencida', icon: 'clock-off' },
  });
  const APPROVAL_UNKNOWN = { word: 'Desconocida', icon: 'info' };

  // One bounded plain-text line: control characters become one space, runs of
  // spaces collapse, and the length is bounded in Unicode scalars.
  function cleanLine(value, max) {
    if (typeof value !== 'string') return '';
    const plain = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/ {2,}/g, ' ').trim();
    const chars = Array.from(plain);
    return chars.length <= max ? plain : chars.slice(0, max).join('') + '…';
  }

  function toolRows(turn) {
    const list = Array.isArray(turn.tool_calls) ? turn.tool_calls : [];
    const rows = [];
    for (const call of list) {
      const name = cleanLine(call && call.name, CARD_NAME_MAX);
      if (!name) continue; // a receipt that cannot name its call never renders
      const modelled = !!(call && TOOL_STATES[call.state]);
      const state = modelled ? TOOL_STATES[call.state] : TOOL_UNKNOWN;
      const summary = cleanLine(call && call.summary, CARD_SUMMARY_MAX);
      rows.push({
        kind: 'tool',
        name,
        state: modelled ? call.state : 'unknown',
        summary: summary || undefined,
        short: state.word,
        icon: state.icon,
        text: summary ? `Herramienta ${name}: ${state.word}. ${summary}` : `Herramienta ${name}: ${state.word}.`,
      });
    }
    return rows;
  }

  function approvalRows(turn) {
    const list = Array.isArray(turn.approvals) ? turn.approvals : [];
    const rows = [];
    for (const item of list) {
      const operation = cleanLine(item && item.operation, CARD_NAME_MAX);
      if (!operation) continue; // a card without its operation is not a card
      const modelled = !!(item && APPROVAL_DECISIONS[item.decision]);
      const decision = modelled ? APPROVAL_DECISIONS[item.decision] : APPROVAL_UNKNOWN;
      rows.push({
        kind: 'approval',
        operation,
        decision: modelled ? item.decision : 'unknown',
        short: decision.word,
        icon: decision.icon,
        text: `Aprobación ${operation}: ${decision.word}.`,
      });
    }
    return rows;
  }

  function turnRows(turn) {
    const rows = [{ kind: 'user', text: turn.user_text }];
    // #343: what the turn carried, named — the files live in the island's
    // uploads directory; the log names them, it never links or inlines them.
    if (Array.isArray(turn.attachments) && turn.attachments.length) {
      const names = turn.attachments.map(a => (a && typeof a.name === 'string') ? a.name : '?').join(', ');
      rows.push({
        kind: 'note', short: 'Adjuntos', icon: 'info',
        text: `Archivos adjuntos: ${names}`,
      });
    }
    // S3 (#503): «contexto» — exactly what the live-state context told the model on this turn.
    if (turn.live_context && typeof turn.live_context.text === 'string' && turn.live_context.text) {
      const omitted = Number(turn.live_context.trimmed_lines) > 0 ? ` (${turn.live_context.trimmed_lines} líneas recortadas)` : '';
      rows.push({
        kind: 'context', short: 'Contexto', icon: 'info',
        text: `Contexto enviado al modelo${omitted}: ${turn.live_context.text}`,
        detail: turn.live_context.text,
      });
    }
    rows.push(...toolRows(turn));
    rows.push(...approvalRows(turn));
    if (turn.trimmed_turns > 0) {
      rows.push({
        kind: 'note', short: 'Recortado', icon: 'info',
        text: `Para entrar en el contexto del modelo se dejaron afuera ${turn.trimmed_turns} mensajes anteriores.`,
      });
    }
    if (turn.reply) rows.push({ kind: 'assistant', text: turn.reply });
    if (turn.state === 'error') {
      rows.push({ kind: 'error', short: 'Error', icon: 'triangle', text: (turn.error && turn.error.safe_message) || 'Error.' });
    } else if (turn.finish_reason === 'limit') {
      rows.push({ kind: 'note', short: 'Cortado por largo', icon: 'info', text: 'La respuesta llegó al límite de largo y se cortó.' });
    } else if (turn.state === 'cancelled') {
      rows.push({ kind: 'note', short: 'Cancelado', icon: 'cross', text: 'Cancelado. Lo que el modelo ya procesó no se puede recuperar.' });
    }
    return rows;
  }

  // ---- U2: model picker (plain-text rows) ---------------------------------
  const GATES = Object.freeze({
    ready: 'Listo',
    queue: 'En cola',
    needs_load: 'Requiere cargarlo (Koda no lo hace)',
    unknown: 'Desconocido',
    unavailable: 'No disponible',
  });
  const gateLabel = state => GATES[state] || 'Desconocido';
  const thousands = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const decimal = (value, unit) => {
    const tenths = Math.round(value * 10);
    return `${Math.floor(tenths / 10)},${tenths % 10} ${unit}`;
  };
  const port = origin => String(origin || '').replace(/^http:\/\//, '');

  // Visual model row (docs/desktop-visual-language.md §2.4): chips carry the
  // numbers, the gate gets ONE word only when it is not «ready» (§3: never
  // hide a problem), and the full sentence stays in `aria`/`facts`.
  const GATE_WORDS = Object.freeze({
    queue: { word: 'En cola', icon: 'clock', tone: 'live' },
    needs_load: { word: 'Sin cargar', icon: 'load-off', tone: 'faint' },
    unknown: { word: 'Desconocido', icon: 'info', tone: 'faint' },
    unavailable: { word: 'No disponible', icon: 'triangle', tone: 'red' },
  });
  const oneDecimal = n => {
    const tenths = Math.round(n * 10);
    return tenths % 10 === 0 ? String(tenths / 10) : `${Math.floor(tenths / 10)},${tenths % 10}`;
  };
  const kTokens = n => (n >= 1024 ? `${Math.round(n / 1024)}k` : String(n));

  function modelChips(p) {
    const chips = p.cloud === true ? [{ icon: '', text: 'nube', label: `Nube · ${p.provider || ''}` }] : [{ icon: 'lock', text: 'local', label: 'Sólo local' }];
    if (Number.isFinite(p.context_tokens)) chips.push({ icon: '', text: kTokens(p.context_tokens), label: `Contexto ${thousands(p.context_tokens)} tokens` });
    if (Number.isFinite(p.size_bytes)) chips.push({ icon: '', text: `${oneDecimal(p.size_bytes / 1e9)} GB`, label: `${decimal(p.size_bytes / 1e9, 'GB')} en memoria` });
    if (Number.isFinite(p.params)) chips.push({ icon: '', text: `${oneDecimal(p.params / 1e9)}B`, label: `${decimal(p.params / 1e9, 'mil millones')} de parámetros` });
    if (p.vision === false) chips.push({ icon: 'eye-off', text: '', label: 'Sin visión' });
    if (p.vision === true) chips.push({ icon: 'eye', text: '', label: 'Con visión' });
    return chips;
  }

  // #414: the Ajustes → Modelos allowlist (typed pref `chosen_models`). The picker offers ONLY
  // the chosen models of the providers, falling back to ALL of them when nothing is chosen.
  // A row the allowlist cannot vouch for (no `provider` field — today's local profiles) is never
  // filtered out: the allowlist names provider models, not local ones.
  function filterChosen(rows, chosen) {
    const list = Array.isArray(rows) ? rows : [];
    const store = chosen && typeof chosen === 'object' && !Array.isArray(chosen) ? chosen : {};
    const ids = new Set();
    for (const value of Object.values(store)) {
      if (!Array.isArray(value)) continue;
      for (const id of value) if (typeof id === 'string') ids.add(id);
    }
    if (!ids.size) return list;
    return list.filter(r => !!r && typeof r === 'object' && (typeof r.provider !== 'string' || !r.provider || ids.has(r.id) || (r.cloud && ids.has(r.model))));
  }

  function modelRows(listing) {
    const profiles = listing && Array.isArray(listing.profiles) ? listing.profiles : [];
    return profiles.map(p => {
      const facts = p.cloud === true ? [`nube · ${p.provider || ''}`] : [`local ${port(p.origin)}`];
      if (Number.isFinite(p.context_tokens)) facts.push(`contexto ${thousands(p.context_tokens)} tokens`);
      if (Number.isFinite(p.max_output_tokens)) facts.push(`salida ≤${thousands(p.max_output_tokens)}`);
      if (Number.isFinite(p.size_bytes)) facts.push(`${decimal(p.size_bytes / 1e9, 'GB')} en memoria`);
      if (Number.isFinite(p.params)) facts.push(`${decimal(p.params / 1e9, 'mil millones')} de parámetros`);
      if (p.quantization) facts.push(p.quantization);
      if (p.vision === false) facts.push('sin visión');
      if (p.vision === true) facts.push('con visión');
      const title = p.alias || `Puerto ${port(p.origin).split(':').pop()}`;
      const gateState = p.gate && p.gate.state;
      const selectable = p.selectable === true && !!p.profile_id;
      let gate = GATE_WORDS[gateState] || (gateState === 'ready' ? null : GATE_WORDS.unknown);
      if (!gate && !selectable) gate = { word: 'Sin verificar', icon: 'lock', tone: 'faint' };
      const message = (p.gate && p.gate.message) || '';
      const note = p.note || '';
      return {
        id: p.profile_id || null,
        cloud: p.cloud === true,
        model: p.alias,
        title,
        // #414: the provenance the allowlist needs — a provider model row names its provider;
        // local profiles carry none and are never filtered out.
        provider: typeof p.provider === 'string' && p.provider ? p.provider : undefined,
        facts: facts.join(' · '),
        state: gateLabel(gateState),
        message,
        note,
        chips: modelChips(p),
        word: gate ? gate.word : '',
        wordIcon: gate ? gate.icon : '',
        tone: gate ? gate.tone : 'go',
        aria: `${title}: ${gateLabel(gateState)}. ${facts.join(', ')}. ${message} ${note}`.replace(/\s+/g, ' ').trim(),
        selectable,
        selected: !!p.profile_id && listing.selected === p.profile_id,
      };
    });
  }

  // Three meters (RAM, VRAM, GTT): fill = USED share; the numbers live in aria.
  const gb = bytes => decimal(bytes / 1e9, 'GB');
  function modelMeters(listing) {
    const r = (listing && listing.resources) || {};
    const gpu = r.gpu || null;
    const make = (key, label, used, total, unknownText) => {
      const known = Number.isFinite(used) && Number.isFinite(total) && total > 0;
      return {
        key, label, known,
        fraction: known ? Math.max(0, Math.min(1, used / total)) : 0,
        aria: known ? `${label}: ${gb(used)} en uso de ${gb(total)}` : `${label}: ${unknownText}`,
      };
    };
    const ramUsed = Number.isFinite(r.mem_total) && Number.isFinite(r.mem_available) ? r.mem_total - r.mem_available : NaN;
    return [
      make('ram', 'RAM', ramUsed, r.mem_total, 'desconocida'),
      make('vram', 'VRAM', gpu && gpu.vram_used, gpu && gpu.vram_total, 'desconocida'),
      make('gtt', 'GTT', gpu && gpu.gtt_used, gpu && gpu.gtt_total, 'desconocida'),
    ];
  }

  // «i» sentence for the panel: the paragraph that used to be on screen.
  function modelsInfo(listing) {
    if (!listing) return 'Leyendo modelos locales.';
    const kept = listing.persisted === false && listing.selected ? ' Elección sólo en memoria: se pierde al cerrar Koda.' : '';
    return `${listing.choice_note || ''} ${listing.remote || ''}${kept}`.replace(/\s+/g, ' ').trim();
  }
  const modelsCount = listing => (listing && Array.isArray(listing.profiles) ? listing.profiles.filter(p => p.selectable === true && p.profile_id).length : 0);

  // ---- Q1: notices + compact activation ----------------------------------
  // Announce a notice once, when a NEW first notice appears (never on
  // dismissal, never twice). Plain text.
  function noticeAnnouncement(lastId, notices) {
    const first = Array.isArray(notices) && notices.length ? notices[0] : null;
    if (!first || first.id === lastId) return null;
    const detail = first.detail ? ` ${first.detail}` : '';
    return `Aviso: ${first.title}.${detail}`;
  }
  const activates = e => !!e && !e.isComposing && !e.repeat && (e.key === 'Enter' || e.key === ' ');

  // History pages are presentation-only; live snapshots win on matching native turn IDs.
  function mergeHistory(older, current) {
    const turns = new Map();
    for (const t of [...(Array.isArray(older) ? older : []), ...(Array.isArray(current) ? current : [])]) {
      if (t && /^t-\d+$/.test(t.turn_id)) turns.set(t.turn_id, t);
    }
    return Array.from(turns.values()).sort((a,b) => Number(a.turn_id.slice(2)) - Number(b.turn_id.slice(2)));
  }
  // S6 (#503): who the human can talk to: Abito first, then every specialist (valid id + name only).
  function specialistRows(specialists) {
    const list = specialists && Array.isArray(specialists.specialists) ? specialists.specialists : [];
    const valid = list.filter(s => s && typeof s.id === 'string' && s.id && typeof s.name === 'string' && s.name.trim());
    const active = specialists && valid.some(s => s.id === specialists.active) ? specialists.active : null;
    return [{ id: null, text: 'Koda', aria: 'Hablar con Koda', current: active === null },
      ...valid.map(s => ({ id: s.id, text: s.name.trim(), aria: `Hablar con ${s.name.trim()}`, current: s.id === active }))];
  }
  function conversationRows(listing) {
    return ((listing && Array.isArray(listing.conversations)) ? listing.conversations : []).map(c => {
      const specialist = c.specialist && c.specialist.name || 'Koda';
      const activity = new Date(c.last_activity).toLocaleString('es-AR');
      return { id: c.id, text: `${c.title} · ${specialist} · ${activity}`, aria: `${c.title}. ${specialist}. Última actividad: ${activity}` };
    });
  }

  // ---- F024: the model row above the composer --------------------------------
  // What the row shows and when it may be used. Pure text: the page writes it
  // with textContent only. `view.target` is already the EFFECTIVE target
  // (chathost::current_target → specialistshost: the active role's own model
  // wins), so the row shows ONE model: the one the next turn will use (R1).
  const NO_MODEL_LABEL = 'Sin modelo local elegido';

  // The active role in the only shape the row needs, or null: a role that names
  // no local model changes nothing here (R4).
  function activeRole(specialists) {
    if (!specialists || !Array.isArray(specialists.specialists)) return null;
    const role = specialists.specialists.find(s => s && s.id === specialists.active);
    return role && typeof role.model === 'string' && role.model
      ? { id: role.id, name: role.name, model: role.model }
      : null;
  }

  // R1/R4: the target's alias (its profile id when it has none); the role is
  // named only when that role is what supplies THIS target.
  function modelButtonLabel(view, role) {
    const t = view && view.target;
    const name = t && (t.alias || t.profile_id || '');
    if (!name) return NO_MODEL_LABEL;
    return role && role.model && t.profile_id === role.model ? `${name} · ${role.name}` : name;
  }

  // R4: the ONE line the picker shows while the active role fixes the model.
  function modelRoleNote(view, role) {
    const t = view && view.target;
    if (!role || !t || t.profile_id !== role.model) return '';
    return `«${role.name}» fija este modelo: elegir acá no reemplaza el rol (el picker no lo cambia).`;
  }

  // R4/R5: the same identity as the accessible name — the origin without its
  // scheme (targetAria) plus who owns the model. Never an endpoint, a key, an
  // account or a provider name (S5).
  function modelButtonAria(view, role) {
    const base = targetAria(view && view.target);
    const note = modelRoleNote(view, role);
    return note ? `${base}. ${note}` : base;
  }

  // R2: the row is usable while no turn is running — the running turn keeps the
  // target it froze at submit and a selection applies to the NEXT turn, so a
  // frozen row protects nothing but still must not pretend to switch anything.
  // With no target chosen (or no preflight verdict) it stays open: that is
  // exactly the state where choosing is what unblocks the chat; an unavailable
  // or blocked CHOSEN target closes it, the same refusal Send shows.
  function modelButtonEnabled(view) {
    if (!view || view.active_turn) return false;
    if (!view.target) return true;
    const state = view.availability && view.availability.state;
    if (!state || state === 'unchecked') return true;
    return SENDABLE.has(state);
  }

  // #343: a byte size as one Spanish chip label (comma decimal, kB/MB).
  function formatSize(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n < 0) return '';
    const oneDecimal = value => {
      const tenths = Math.round(value * 10);
      return `${Math.floor(tenths / 10)},${tenths % 10}`;
    };
    if (n < 1024) return `${Math.round(n)} B`;
    if (n < 1024 * 1024) return `${oneDecimal(n / 1024)} kB`;
    return `${oneDecimal(n / (1024 * 1024))} MB`;
  }

  // S10 (human L35, «Alto de Coucou, crece con los mensajes»): Coucou's `chatPromptHeight(messageCount)` (windows/src/core/layout.ts
  // @434d6a2b, used as `chatPromptHeight(State.chatHistory.length)` in island.ts): `Math.min(300, 240 + messageCount * 40)`.
  // A message is what the log shows as a bubble: the human's text and the agent's reply (a turn with no reply yet counts one).
  const CHAT_MIN_H = 240, CHAT_MAX_H = 300, CHAT_GROWTH = 40;
  function messageCount(view) {
    if (!view || !Array.isArray(view.turns)) return 0;
    let n = 0;
    for (const t of view.turns) {
      if (!t || typeof t !== 'object') continue;
      n += 1; // the human's message
      if (typeof t.reply === 'string' && t.reply.length > 0) n += 1;
    }
    return n;
  }
  function chatHeight(view) { return Math.min(CHAT_MAX_H, CHAT_MIN_H + messageCount(view) * CHAT_GROWTH); }
  return { staleSnapshot, messageCount, chatHeight, CHAT_MIN_H, CHAT_MAX_H, mergeHistory, conversationRows, reconcileRows, rowKey, poseFor, statusView, draftWord, targetAria, noticeAnnouncement, activates, gateLabel, filterChosen, modelRows, modelMeters, modelsInfo, modelsCount, emptyGreeting, cleanDisplayName, cleanLine, CARD_NAME_MAX, CARD_SUMMARY_MAX, DRAFT_MAX, stateLabel, scalarCount, draftProblem, canSend, sendState, needsCheck, checkPlan, statusLine, announcement, atBottom, newRequestId, turnRows, specialistRows, toolRows, approvalRows, activeTurn, activeRole, modelButtonLabel, modelButtonAria, modelButtonEnabled, modelRoleNote, formatSize };
});
