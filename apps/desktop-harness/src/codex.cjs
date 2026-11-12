'use strict';
// Codex command-hook adapter. K2-08 T1 (S1, S4, S6, S7) reverses the former code-only decision S4/T2 «Solo aviso para
// Codex»: a Codex `PermissionRequest` is answered from the island like Claude's.
//
// Codex's hook contract (vault «Contrato-hooks-Codex»): `PermissionRequest` runs when Codex is about to ask for approval.
// `{"behavior":"allow"}` runs the request without Codex's own dialog, `deny` + message refuses it, and NO output (or a
// timeout) leaves Codex's normal dialog in charge. `updatedPermissions`, `updatedInput` and `interrupt` are reserved and
// FAIL CLOSED, so they are never emitted here (and there is no «Siempre permitir», S6).
//
// permission-request: ONE approval question (agent `codex`) joins the island's FIFO queue and the hook waits for it
// within the hook budget (`--timeout-sec` less a 5 s margin, capped at 115 s: the installed entry gives 120 s, K2-08 T3). Only an explicit «Aprobar una vez» on a
// request shown in full prints `allow`; «Rechazar» prints `deny`; every other outcome — island closed, busy (queue
// full), no answer in time, connection lost, «Decidir en la terminal» — prints NOTHING and exits 0, so Codex asks in
// its terminal. Only `Bash` (the full redacted command) and `apply_patch` (the bounded file preview of T4: path(s) and
// change, approvable only for one file shown in full) reach the island; MCP, network and any other tool never do (S7).
//
// pre-tool-use: plan-mode questions (`request_user_input`) can only be observed, never answered (openai/codex#19328),
// so they still send ONE bounded, fire-and-forget notice «Codex te pregunta … Respondé en la terminal».
// post-tool-use / stop: the same session-scoped `attention_clear` frame takes that notice away (a completed tool or an
// ended turn means nothing is pending); `stop` also sends the finished notice, as before.
// Automatic review (K2-08 T2, S3): a permission request that Codex's own automatic reviewer handles (codex-reviewer.cjs)
// sends no card and prints nothing. Only there are transcript_path and turn_id read, locally: the rollout under
// $CODEX_HOME/sessions, bounded; they never travel.
// Never read or forwarded: tool_input.description (written by Codex, may be model-influenced), last_assistant_message,
// model, permission_suggestions. Never forwarded: transcript_path, turn_id.
const { parseArgs, watchdogMs, startWatchdog, none, isObject, validCwd, toolDescription, defaultFactory, optionSets, questionText,
  MAX_STDIN_BYTES, DEFAULT_TIMEOUT_SEC, CODEX_MAX_ISLAND_WAIT_MS, ALLOW, DENY, resolveConfig, computeDeadline, sessionToken } = require('./hook-common.cjs');
const { redactCommand } = require('./redact.cjs');
const { sanitizeText } = require('./projection.cjs');
const { codexAutoReviewed } = require('./codex-reviewer.cjs');
const { describePatchPermission } = require('./file-permission.cjs');

const EVENTS = { 'permission-request': 'PermissionRequest', 'pre-tool-use': 'PreToolUse',
  'post-tool-use': 'PostToolUse', stop: 'Stop' };
// Plan-mode questions: the only PreToolUse observation that is a question rather than a permission.
const ASK_TOOL = 'request_user_input';
const TERMINAL_TAIL = 'Respondé en la terminal';
const TITLE_QUESTION = 'Codex te pregunta';
// Fire-and-forget bounds. A notice is a display-only line: it must never hold the terminal.
const NOTICE_CONNECT_MS = 1000, NOTICE_HANDSHAKE_MS = 500;
const { OPTIONS, LOSSY_OPTIONS } = optionSets('Codex');

// What the island may show for a Codex permission, or null when the request stays in the terminal (S7: MCP, network and
// anything that is not a shell command or a file edit). apply_patch (K2-08 T4) gets the file preview: the path(s) and the
// change under the same R9 rules as Claude's Write/Edit, resolved against the request's cwd (file-permission.cjs).
function codexToolDescription(name, toolInput, cwd) {
  if (name === 'apply_patch') return describePatchPermission(toolInput, cwd);
  // Bash: the projection reads only tool_input.command (redacted in full); tool_input.description is never read or shown.
  if (name === 'Bash') return toolDescription(name, toolInput);
  return null;
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
    if (!args) return none();
    if (typeof input !== 'string' || Buffer.byteLength(input) > MAX_STDIN_BYTES) return none();
    let data;
    try { data = JSON.parse(input); } catch { return none(); }
    if (!isObject(data) || data.hook_event_name !== expected) return none();
    const cwd = data.cwd;
    if (!validCwd(cwd)) return none();
    if (event === 'stop' && data.stop_hook_active === true) return none(); // a re-entrant stop sends nothing

    let notice = null, detail = null, budget = null;
    if (event === 'permission-request') {
      if (typeof data.tool_name !== 'string' || data.tool_name.length === 0) return none();
      detail = codexToolDescription(data.tool_name, data.tool_input, cwd);
      if (!detail) return none(); // MCP, network, anything else: Codex asks in its terminal (S7)
      // K2-08 T2 (S3): Codex's own automatic reviewer handles this turn — no card, nothing printed; unknown → the card.
      if (codexAutoReviewed(data, env)) return none();
      // The island may only hold the card as long as Codex waits for this hook, less a 5 s margin, capped at 115 s (T3, S5:
      // the installed entry gives 120 s). Claude's 60 s cap is not Codex's.
      const deadline = computeDeadline({ cliTimeoutMs: args.timeoutSec * 1000, maxMs: CODEX_MAX_ISLAND_WAIT_MS });
      if (deadline.mode !== 'ask') return none();
      budget = deadline.timeoutMs;
    } else if (event === 'pre-tool-use') {
      if (data.tool_name !== ASK_TOOL) return none(); // every other PreToolUse belongs to Codex alone
      notice = { title: TITLE_QUESTION, detail: noticeDetail(questionShown(data.tool_input)) };
    }

    let config;
    try { config = resolveConfig(env, process.getuid?.()); } catch { return none(); }
    if (!config.endpoint) return none(); // no island: Codex's own prompt is still the only prompt, nothing breaks
    const options = { endpoint: config.endpoint, runtime: config.runtime, cwd, sessionId: sessionToken(data.session_id),
      agent: 'codex', onDiagnostic: () => {} };
    // A notice is fire-and-forget: short connect/handshake bounds. A permission question keeps the client defaults.
    if (!detail) Object.assign(options, { connectTimeoutMs: NOTICE_CONNECT_MS, handshakeTimeoutMs: NOTICE_HANDSHAKE_MS });
    if (typeof now === 'function') options.clock = { now, setTimer: setTimeout, clearTimer: clearTimeout };
    const client = clientFactory(options);

    if (event === 'permission-request') {
      const choices = detail.lossy ? LOSSY_OPTIONS : OPTIONS;
      const result = await client.ask({ kind: 'question', text: questionText('Codex', detail),
        options: choices.map(o => ({ ...o })), allowFreeText: false, timeoutMs: budget });
      return decisionFor(result, detail.lossy);
    }
    if (event === 'stop') {
      // The finished notice is unchanged; the clearing frame removes a pending «Codex te pregunta».
      await client.notify();
      await client.clearAttention();
      return none();
    }
    if (event === 'post-tool-use') {
      // The tool ran (or was refused) — a plan-mode question it waited on is resolved, so its notice goes away now.
      await client.clearAttention();
      return none();
    }
    await client.attention(notice);
    return none();
  } catch {
    return none();
  }
}
// Only an explicit human answer to our own card decides: «Aprobar una vez» on a card shown in full → allow, «Rechazar» →
// deny. Everything else (terminal, busy, expired, unavailable, a forged allow on a lossy card) prints nothing — not even
// on stderr — so Codex shows its own dialog.
function decisionFor(result, lossy) {
  if (result && result.status === 'answered' && result.answer && result.answer.type === 'option') {
    if (result.answer.value === 'allow' && !lossy) return { stdout: ALLOW, stderr: '', exitCode: 0 };
    if (result.answer.value === 'deny') return { stdout: DENY, stderr: '', exitCode: 0 };
  }
  return none();
}
module.exports = { handleCodexHook, codexToolDescription, noticeDetail, planQuestion, parseArgs, watchdogMs, startWatchdog,
  MAX_STDIN_BYTES, DEFAULT_TIMEOUT_SEC, ALLOW, DENY, ASK_TOOL, TITLE_QUESTION, TERMINAL_TAIL };
