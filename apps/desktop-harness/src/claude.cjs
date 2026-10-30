'use strict';
// Claude Code command-hook adapter. Hook JSON in -> hook JSON out. The island never decides:
// only an explicit human answer to our own question becomes a PermissionRequest decision;
// every other outcome is EMPTY stdout (the CLI's own prompt stays in charge). Never exits non-zero here.
//
// S2 (code.claude.com/docs/en/hooks): PermissionRequest runs CONCURRENTLY with Claude's own terminal dialog and
// the first answer wins, so it is the event that makes a question visible in the terminal and in the island at
// the same time. AskUserQuestion also fires it, and it is answered there with behavior "allow" + updatedInput
// (echoed `questions` + `answers`). The former PreToolUse question path is gone: it fired BEFORE the tool ran, so
// the terminal question could not appear while the island waited.
const { parseArgs, watchdogMs, startWatchdog, none, isObject, validCwd, toolDescription, defaultFactory, mapResult, optionSets, questionText,
  MAX_STDIN_BYTES, DEFAULT_TIMEOUT_SEC, MAX_ISLAND_WAIT_MS, ALLOW, DENY, formatNoDecision, resolveConfig, computeDeadline, sessionToken } = require('./hook-common.cjs');

const { describeFilePermission } = require('./file-permission.cjs');
const ask = require('./claude-ask.cjs');
const { planSuggestions, suggestionOutput } = require('./claude-suggestions.cjs');
const titles = require('./title-cache.cjs');

const EVENTS = { 'permission-request': 'PermissionRequest', 'session-start': 'SessionStart', stop: 'Stop' };
const TITLE_KIND = 'claude-titles';
const ASK_USER_QUESTION = 'AskUserQuestion';
const { OPTIONS, LOSSY_OPTIONS } = optionSets('Claude Code', 'Claude');

// PermissionRequest `decision.behavior: "allow"` + `updatedInput` is the documented way to answer AskUserQuestion
// from a hook: `updatedInput` REPLACES the whole tool input, so the original object is echoed and `answers`
// (question text -> chosen label; a multi-select answer is its labels joined with commas) is added.
// Background subagents await this same event (anthropics/claude-code#82150): there no terminal can answer, so the
// island answer is simply the only one; no special handling is needed here.
function questionOutput(toolInput, answers) {
  const previous = isObject(toolInput.answers) ? toolInput.answers : null;
  const merged = previous ? { ...previous, ...answers } : { ...answers };
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest',
    decision: { behavior: 'allow', updatedInput: { ...toolInput, answers: merged } } } }) + '\n';
}

async function handleClaudeHook({ event, input, env = {}, argv = [], now, clientFactory = defaultFactory } = {}) {
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

    // SessionStart only caches the title Claude gives us here (it is never repeated in later events). No island, no output.
    if (event === 'session-start') {
      titles.saveTitle(env, TITLE_KIND, sessionToken(data.session_id), data.session_title);
      return none();
    }
    // ONE handler, no matcher, dispatched by tool_name: a second PermissionRequest entry (even matcher-scoped)
    // would spawn a second hook process for the same question, so the island would show two cards for one question
    // and two decisions would race. Anything that is not a representable AskUserQuestion keeps the permission path.
    let askPlan = null;
    if (event === 'permission-request' && data.tool_name === ASK_USER_QUESTION) {
      askPlan = ask.plan(data.tool_input);
      if (!askPlan) return none(); // shapes the island cannot answer: Claude's own dialog stays in charge
    }

    let budget = null;
    if (event === 'permission-request') {
      if (typeof data.tool_name !== 'string' || data.tool_name.length === 0) return none();
      const deadline = computeDeadline({ cliTimeoutMs: args.timeoutSec * 1000, maxMs: MAX_ISLAND_WAIT_MS });
      if (deadline.mode !== 'ask') return none('Koda island: hook timeout too short for a question. Answer in the terminal.\n');
      budget = deadline.timeoutMs;
    } else if (data.stop_hook_active === true) return none();

    let config;
    try { config = resolveConfig(env, process.getuid?.()); } catch { return none('Koda island: invalid configuration.\n'); }
    if (!config.endpoint) return none('Koda island unavailable. Answer in the terminal.\n');
    const session = sessionToken(data.session_id);
    const options = { endpoint: config.endpoint, runtime: config.runtime, cwd, sessionId: session, agent: 'claude-code',
      projectName: titles.loadTitle(env, TITLE_KIND, session) || undefined, onDiagnostic: () => {} };
    if (typeof now === 'function') options.clock = { now, setTimer: setTimeout, clearTimer: clearTimeout };
    const client = clientFactory(options);

    if (event === 'stop') {
      await client.notify();
      return none();
    }
    if (askPlan) {
      // One queue slot and one deadline, including the questionnaire summary. No partial answers.
      const result = await client.ask(ask.requestFor(askPlan, budget));
      const answers = ask.answersFor(askPlan, result);
      if (answers === null) return result && result.status === 'unavailable' ? none('Koda island unavailable. Answer in the terminal.\n') : none(formatNoDecision(result) + '\n');
      return { stdout: questionOutput(data.tool_input, answers), stderr: '', exitCode: 0 };
    }
    const detail = describeFilePermission(data.tool_name, data.tool_input, cwd) || toolDescription(data.tool_name, data.tool_input);
    const suggestions = planSuggestions(data, detail);
    const choices = detail.lossy ? LOSSY_OPTIONS : [OPTIONS[0], ...suggestions.map(s => s.option), OPTIONS[1]];
    const result = await client.ask({ kind: 'question', text: questionText('Claude Code', detail),
      options: choices.map(o => ({ ...o })), allowFreeText: false, timeoutMs: budget });
    return suggestionOutput(suggestions, result) || mapResult(result, detail.lossy);
  } catch {
    return none();
  }
}
module.exports = { handleClaudeHook, parseArgs, watchdogMs, startWatchdog, MAX_STDIN_BYTES, DEFAULT_TIMEOUT_SEC, ALLOW, DENY };
