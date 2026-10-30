'use strict';
// Codex command-hook adapter — NOTICE ONLY (S4/T2, human decision L3 option A «Solo aviso para Codex»).
//
// Codex's official hook contract (learn.chatgpt.com/docs/hooks): `PermissionRequest` runs BEFORE the approval prompt,
// so a hook that waited for an island answer would delay the prompt itself; plan-mode questions (`request_user_input`)
// can only be observed — never answered — by `PreToolUse` (openai/codex#19328). The island therefore never decides and
// never waits: every event below sends ONE bounded, fire-and-forget notice («Codex te pide permiso / Codex te pregunta
// … Respondé en la terminal») and returns at once with EMPTY stdout and exit 0, leaving Codex's own prompt in charge.
//
// A synchronous short notify is preferred over Codex's `async: true` on purpose: the notice must reach the island
// BEFORE the human sees the prompt (a detached process would race it), and the bound is real — a local AF_UNIX connect
// plus handshake is milliseconds, NOTICE_CONNECT_MS + NOTICE_HANDSHAKE_MS cap a hung island at ~1.5 s, and the
// installer's own entry timeout (5 s) is the hard stop. Nothing here can produce a decision: never emitted are
// hookSpecificOutput, decision, updatedInput, updatedPermissions, interrupt or `decision:block`.
//
// The notice clears when the prompt is resolved, with two signals:
//  - `PostToolUse` (any tool): Codex runs one tool at a time and a pending approval blocks the turn, so a completed
//    tool means the prompt it was waiting on is resolved — the earliest possible moment (mid-turn approvals included);
//  - `Stop`: the turn ended, so nothing can be pending; it also sends the finished notice, as before.
// Both send the same session-scoped `attention_clear` frame; the island also expires an attention notice on its own.
// Never read or forwarded: tool_input.description (written by Codex, may be model-influenced), last_assistant_message,
// transcript_path, model, turn_id.
const { parseArgs, watchdogMs, startWatchdog, none, isObject, validCwd, toolDescription, defaultFactory,
  MAX_STDIN_BYTES, DEFAULT_TIMEOUT_SEC, resolveConfig, sessionToken } = require('./hook-common.cjs');
const { redactCommand } = require('./redact.cjs');
const { sanitizeText } = require('./projection.cjs');

const EVENTS = { 'permission-request': 'PermissionRequest', 'pre-tool-use': 'PreToolUse',
  'post-tool-use': 'PostToolUse', stop: 'Stop' };
// Plan-mode questions: the only PreToolUse observation that is a question rather than a permission.
const ASK_TOOL = 'request_user_input';
const TERMINAL_TAIL = 'Respondé en la terminal';
const TITLE_PERMISSION = 'Codex te pide permiso';
const TITLE_QUESTION = 'Codex te pregunta';
// Fire-and-forget bounds. A notice is a display-only line: it must never hold the terminal.
const NOTICE_CONNECT_MS = 1000, NOTICE_HANDSHAKE_MS = 500;

// apply_patch is a file edit: its patch cannot be shown in a short line, so only the fixed label is shown.
function codexToolDescription(name, toolInput) {
  if (name === 'apply_patch') return { text: 'apply_patch (file edit)', lossy: true };
  // Bash: the projection reads only tool_input.command (redacted in full); tool_input.description is never read or shown.
  // MCP: `description` is just another argument; any non-empty arguments object is lossy.
  return toolDescription(name, toolInput);
}
// The short text the island shows: the same Spanish label mapping the question path used, then fail-closed redaction
// and a hard bound (the notice detail cap is 200 chars; this keeps it well inside one 512-byte frame).
function shownText(detail) {
  const raw = typeof detail.text === 'string' ? detail.text : '';
  const mapped = raw.replace(/^mcp tool /, 'herramienta MCP ').replace('(file edit)', '(edición de archivo)')
    .replace(/^tool$/, 'herramienta');
  return sanitizeText(redactCommand(mapped).text, { max: 120 });
}
// «<detalle> · Respondé en la terminal» — the sentence the human can act on never changes, whatever the detail is.
function noticeDetail(shown) {
  return shown ? `${shown} · ${TERMINAL_TAIL}` : TERMINAL_TAIL;
}
// A plan-mode question's text, read defensively: Codex's `request_user_input` arguments are not ours to trust, so
// several shapes are tried and anything unreadable degrades to the plain «Respondé en la terminal».
const QUESTION_KEYS = ['question', 'text', 'prompt', 'message'];
function planQuestion(toolInput) {
  if (!isObject(toolInput)) return '';
  const questions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
  for (const item of questions) {
    if (!isObject(item)) continue;
    for (const key of QUESTION_KEYS) {
      if (typeof item[key] === 'string' && item[key].trim()) return item[key];
    }
  }
  for (const key of QUESTION_KEYS) {
    if (typeof toolInput[key] === 'string' && toolInput[key].trim()) return toolInput[key];
  }
  return '';
}
const questionShown = toolInput => sanitizeText(redactCommand(planQuestion(toolInput)).text, { max: 120 });

async function handleCodexHook({ event, input, env = {}, argv = [], now, clientFactory = defaultFactory } = {}) {
  try {
    const expected = EVENTS[event];
    if (!expected) return none();
    const args = parseArgs(argv);
    // The flag stays validated for old installed entries, and buys nothing: a notice never waits for an answer.
    if (!args) return none();
    if (typeof input !== 'string' || Buffer.byteLength(input) > MAX_STDIN_BYTES) return none();
    let data;
    try { data = JSON.parse(input); } catch { return none(); }
    if (!isObject(data) || data.hook_event_name !== expected) return none();
    const cwd = data.cwd;
    if (!validCwd(cwd)) return none();
    if (event === 'stop' && data.stop_hook_active === true) return none(); // a re-entrant stop sends nothing

    let notice = null;
    if (event === 'permission-request') {
      if (typeof data.tool_name !== 'string' || data.tool_name.length === 0) return none();
      notice = { title: TITLE_PERMISSION, detail: noticeDetail(shownText(codexToolDescription(data.tool_name, data.tool_input))) };
    } else if (event === 'pre-tool-use') {
      if (data.tool_name !== ASK_TOOL) return none(); // every other PreToolUse belongs to Codex alone
      notice = { title: TITLE_QUESTION, detail: noticeDetail(questionShown(data.tool_input)) };
    }

    let config;
    try { config = resolveConfig(env, process.getuid?.()); } catch { return none(); }
    if (!config.endpoint) return none(); // no island: Codex's own prompt is still the only prompt, nothing breaks
    const options = { endpoint: config.endpoint, runtime: config.runtime, cwd, sessionId: sessionToken(data.session_id),
      agent: 'codex', onDiagnostic: () => {}, connectTimeoutMs: NOTICE_CONNECT_MS, handshakeTimeoutMs: NOTICE_HANDSHAKE_MS };
    if (typeof now === 'function') options.clock = { now, setTimer: setTimeout, clearTimer: clearTimeout };
    const client = clientFactory(options);

    if (event === 'stop') {
      // The finished notice is unchanged; the clearing frame is what removes a pending «Codex te pide permiso».
      await client.notify();
      await client.clearAttention();
      return none();
    }
    if (event === 'post-tool-use') {
      // The tool ran (or was refused) — the prompt it waited on is resolved, so its notice goes away now.
      await client.clearAttention();
      return none();
    }
    await client.attention(notice);
    return none();
  } catch {
    return none();
  }
}
module.exports = { handleCodexHook, codexToolDescription, noticeDetail, shownText, planQuestion, parseArgs, watchdogMs, startWatchdog,
  MAX_STDIN_BYTES, DEFAULT_TIMEOUT_SEC, ASK_TOOL, TITLE_PERMISSION, TITLE_QUESTION, TERMINAL_TAIL };
