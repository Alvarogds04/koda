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
  // K2-05 attachments (Gentle Dot parseClientMessage): with files attached the text may be empty;
  // `files` = how many attachments wait in the composer (0 when omitted).
  function canSend(view, draft, inFlight, files) {
    if (!view || inFlight || view.active_turn) return false;
    const a = view.availability;
    if (!a || !SENDABLE.has(a.state)) return false;
    if (files > 0 && !String(draft).trim()) return true;
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
  // K2-05 boot order = Gentle Dot (ChatSurface statusText): the daemon answers while its engine starts or
  // restarts; that is a WAIT said in Spanish, never «Modelo caído». The host's sentence is the reason.
  const BOOTING = Object.freeze({ starting: 'Arrancando…', restarting: 'Reiniciando…' });
  const BOOT_SAY = Object.freeze({ starting: 'Koda está arrancando… abriendo tu conversación.', restarting: 'Koda se está reiniciando… abriendo tu conversación.' });
  function sendState(view, draft, inFlight, files) {
    const empty = !String(draft).trim() && !(files > 0);
    if (empty || inFlight || (view && view.active_turn)) return { disabled: true, blocked: null };
    const a = view && view.availability;
    if (a && BOOTING[a.state]) return { disabled: false, blocked: a.message || BOOT_SAY[a.state] };
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
    // kind `checking` keeps the page's existing spinner (style.css #chat-state[data-kind="checking"])
    if (BOOTING[state]) return mk('checking', 'live', 'ring', BOOTING[state]);
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
  const rowKey = row => JSON.stringify([row.kind, row.text, row.short || '', row.icon || '']); // `attachments` rows: the text names every chip
  // S2 follow-up F5: the keys may come precomputed (the page keys each turn's rows once and reuses them while the turn
  // is unchanged), so a push over a long loaded chat never re-serialises every row.
  function reconcileRows(before, after, beforeKeys, afterKeys) {
    const a = Array.isArray(before) ? before : [];
    const b = Array.isArray(after) ? after : [];
    const ka = Array.isArray(beforeKeys) && beforeKeys.length === a.length ? beforeKeys : a.map(rowKey);
    const kb = Array.isArray(afterKeys) && afterKeys.length === b.length ? afterKeys : b.map(rowKey);
    let keep = 0;
    while (keep < a.length && keep < b.length && ka[keep] === kb[keep]) keep += 1;
    // S2 paging: an earlier page adds rows ON TOP; when everything drawn is still the tail, only the new
    // rows are inserted before it (nothing already drawn is repainted, so the reader's place holds)
    const top = b.length - a.length;
    if (keep < a.length && top > 0 && ka.every((key, i) => key === kb[top + i])) {
      return { keep: a.length, patch: [], append: [], remove: 0, prepend: b.slice(0, top) };
    }
    const patch = [];
    let i = keep;
    for (; i < a.length && i < b.length; i += 1) patch.push({ index: i, row: b[i] });
    return { keep, patch, append: b.slice(i), remove: Math.max(0, a.length - b.length) };
  }

  // S2 follow-up F5: whether a turn draws exactly the same rows as before (everything turnRows reads). A turn the
  // host re-sent unchanged keeps its drawn rows and their keys; only a changed turn is keyed again.
  const sameList = (a, b) => (a === b) || (!a && !b) || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && JSON.stringify(a) === JSON.stringify(b));
  function sameTurn(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    const err = t => (t.error && t.error.safe_message) || '';
    const ctx = t => (t.live_context && typeof t.live_context.text === 'string') ? `${t.live_context.text}\u0000${t.live_context.trimmed_lines}` : '';
    return a.turn_id === b.turn_id && a.user_text === b.user_text && a.reply === b.reply && a.state === b.state &&
      err(a) === err(b) && a.finish_reason === b.finish_reason && a.trimmed_turns === b.trimmed_turns && ctx(a) === ctx(b) &&
      sameList(a.attachments && a.attachments.length ? a.attachments.map(x => x && `${x.name}\u0000${x.size}`) : null, b.attachments && b.attachments.length ? b.attachments.map(x => x && `${x.name}\u0000${x.size}`) : null) &&
      sameList(a.tool_calls, b.tool_calls) && sameList(a.approvals, b.approvals);
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

  // K2-05 attachments (Gentle Dot MessageList `message-attachments`): the chips of the files a
  // prompt carried, name + size, under the user's text. The files live in the engine workspace on
  // the daemon side; the log names them, it never links, opens or inlines them.
  const ATTACH_NAME_MAX = 128;
  function attachmentChips(list) {
    if (!Array.isArray(list)) return [];
    return list.slice(0, 16).flatMap(a => {
      const name = cleanLine(a && a.name, ATTACH_NAME_MAX);
      return name ? [{ name, size: formatSize(a.size) }] : [];
    });
  }

  function turnRows(turn) {
    const files = attachmentChips(turn.attachments);
    // a files-only message has no text bubble, only its chips (Gentle Dot shows text only when present)
    const rows = files.length && !String(turn.user_text || '').trim() ? [] : [{ kind: 'user', text: turn.user_text }];
    if (files.length) {
      rows.push({
        kind: 'attachments', files,
        text: `Archivos adjuntos: ${files.map(f => `${f.name} (${f.size})`).join(', ')}`,
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

  // S2 paging (Gentle Dot's model): the page holds ONE contiguous run of turns, oldest first: the earlier pages it
  // loaded, then the live window. Turn ids are the daemon's own record positions, so the same turn has the same id
  // on every page; the run is joined in the order the host gave it (never re-sorted: an unrecorded island turn sits
  // where it was sent), and the live window wins on a shared id.
  function mergeHistory(older, current) {
    const valid = list => (Array.isArray(list) ? list : []).filter(t => t && /^t-\d+$/.test(t.turn_id));
    const live = valid(current);
    const ids = new Set(live.map(t => t.turn_id));
    const seen = new Set();
    const run = valid(older).filter(t => !ids.has(t.turn_id) && !seen.has(t.turn_id) && seen.add(t.turn_id));
    return run.concat(live);
  }
  // The turns of the previous live window that left it at its top (the window slides as new turns arrive).
  function leftWindow(previous, next) {
    const before = Array.isArray(previous) ? previous : [];
    const after = Array.isArray(next) ? next : [];
    const ids = new Set(after.map(t => t && t.turn_id));
    const at = after.length ? before.findIndex(t => t && t.turn_id === after[0].turn_id) : -1;
    return (at >= 0 ? before.slice(0, at) : before).filter(t => t && !ids.has(t.turn_id));
  }
  // One daemon page per request, and scroll-triggered requests at most one per PAGE_GAP_MS: a fast scroll through
  // a long chat stays inside the island's read share (chatclient.rs CHAT_FRAMES_PER_MINUTE − CHAT_FRAMES_RESERVED =
  // 100/min), so a send is never refused because paging spent the budget.
  const PAGE_GAP_MS = 650;
  const pageWait = (now, last) => Math.max(0, (Number(last) || 0) + PAGE_GAP_MS - now);
  // K2-05 T4 U4: one continuous chat (L3/L4/L11) — the conversation list (conversationRows) and the «Hablar con…»
  // specialist rows (specialistRows) are gone with their UI.

  // ---- K2-05 U5c: which model answers (read-only) ---------------------------
  // The ENGINE owns the model: the daemon reports it (`get_state`) and Rust projects it as
  // `view.engine_model` ({ provider?, id, name? }, or null while unknown). The page only
  // shows it: no picker, no choice, no endpoint, key or account. Unknown → nothing at all
  // (never a placeholder name). Plain text only: the page writes it with textContent.
  function engineModelName(view) {
    const m = view && view.engine_model;
    if (!m || typeof m !== 'object') return '';
    const clean = value => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 128) : '');
    return clean(m.name) || clean(m.id);
  }
  function engineModelLine(view) {
    const name = engineModelName(view);
    return name ? { text: name, aria: `Koda responde con el modelo ${name}` } : null;
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

  // ---- K2-05 U4b: the agent's questions inside the chat (Gentle Dot AskCard) -------------------------------------
  // `chat:state.asks` carries the daemon's pending asks (chatclient.rs asks_view): select (options), confirm (yes/no)
  // or input (free text). Titles, details and options are harness text the daemon already white-labelled; what the
  // human TYPES is theirs and is sent exactly as typed. Everything here is plain text (textContent only).
  const ASK_KINDS = new Set(['select', 'confirm', 'input']);
  const ASK_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
  const MAX_ASK_CARDS = 16; // chatclient.rs MAX_ASKS
  const ASK_OUTCOME_MAX = 300;
  const askText = value => (typeof value === 'string' ? value : '');
  /** The well-formed pending asks of a view, bounded, as the card needs them. */
  function askCards(view) {
    const list = view && Array.isArray(view.asks) ? view.asks : [];
    const out = [];
    for (const a of list) {
      if (out.length >= MAX_ASK_CARDS) break;
      if (!a || typeof a !== 'object' || typeof a.id !== 'string' || !ASK_ID.test(a.id) || !ASK_KINDS.has(a.kind)) continue;
      out.push({
        id: a.id, kind: a.kind, title: askText(a.title), message: askText(a.message), placeholder: askText(a.placeholder),
        options: a.kind === 'select' && Array.isArray(a.options) ? a.options.filter(o => typeof o === 'string') : [],
        answering: a.answering === true,
      });
    }
    return out;
  }
  /** U4b verifier F2: the asks whose answer from this island the daemon accepted (`chat:state.answered_asks`), bounded. */
  function answeredAsks(view) {
    const list = view && Array.isArray(view.answered_asks) ? view.answered_asks : [];
    return new Set(list.filter(id => typeof id === 'string' && ASK_ID.test(id)).slice(0, MAX_ASK_CARDS));
  }
  /** The ONE closed `answer` verb for an answer: `{value}` (select/input), `{confirmed}` or `{cancelled}`. */
  function askPayload(askId, answer) {
    if (answer && typeof answer.value === 'string') return { action: 'answer', ask_id: askId, value: answer.value };
    if (answer && typeof answer.confirmed === 'boolean') return { action: 'answer', ask_id: askId, confirmed: answer.confirmed };
    return { action: 'answer', ask_id: askId, cancelled: true };
  }
  /** What happened to a question, in one Spanish sentence (`sent` = this page's answer; null = closed elsewhere). */
  function askOutcome(ask, sent) {
    if (!sent) return 'La pregunta se cerró: se respondió en otro lugar o venció.';
    if (sent.answered === true) return 'Se envió tu respuesta.';
    if (sent.cancelled) return 'Omitiste la pregunta.';
    if (typeof sent.confirmed === 'boolean') return `Respondiste: ${sent.confirmed ? 'Sí' : 'No'}`;
    const shown = cleanLine(sent.value, ASK_OUTCOME_MAX);
    if (ask && ask.kind === 'select') return `Elegiste: ${shown}`;
    return shown ? `Respondiste: ${shown}` : 'Respondiste sin texto.';
  }
  /** Roving focus in a select: the arrows wrap, Home/End jump; -1 = not a navigation key. */
  function askNextOption(index, count, key) {
    if (!(count > 0)) return -1;
    if (key === 'ArrowDown' || key === 'ArrowRight') return (index + 1) % count;
    if (key === 'ArrowUp' || key === 'ArrowLeft') return (index - 1 + count) % count;
    if (key === 'Home') return 0;
    if (key === 'End') return count - 1;
    return -1;
  }
  const askAria = ask => (ask && ask.title ? `Koda necesita tu respuesta: ${ask.title}` : 'Koda necesita tu respuesta');
  const askClosedAria = (ask, outcome) => `Pregunta de Koda${ask && ask.title ? `: ${ask.title}` : ''}. ${outcome}`;
  return { askCards, answeredAsks, askPayload, askOutcome, askNextOption, askAria, askClosedAria, staleSnapshot, messageCount, chatHeight, CHAT_MIN_H, CHAT_MAX_H, mergeHistory, leftWindow, PAGE_GAP_MS, pageWait, reconcileRows, rowKey, sameTurn, poseFor, statusView, draftWord, targetAria, noticeAnnouncement, activates, engineModelLine, emptyGreeting, cleanDisplayName, cleanLine, CARD_NAME_MAX, CARD_SUMMARY_MAX, DRAFT_MAX, stateLabel, scalarCount, draftProblem, canSend, sendState, needsCheck, checkPlan, statusLine, announcement, atBottom, newRequestId, turnRows, toolRows, approvalRows, activeTurn, formatSize, attachmentChips };
});
