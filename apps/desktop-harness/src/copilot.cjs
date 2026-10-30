'use strict';
// GitHub Copilot CLI `permissionRequest` hook adapter. Contract (docs.github.com/copilot/reference/hooks-configuration):
//   stdout {"behavior":"allow"|"deny","message"?} decides; empty output or {} falls through to Copilot's own permission flow;
//   exit code 2 means DENY, so this adapter exits 0 ALWAYS; a hook timeout is fail-open to the normal flow.
// The island never decides: only an explicit human answer to our own question becomes a decision line. A sandbox-bypass
// request (toolInput.requestSandboxBypass) is never offered `allow` (Copilot ignores a hook allow there; the human confirms in its UI).
const { parseArgs, watchdogMs, startWatchdog, none, isObject, validCwd, toolDescription, defaultFactory, optionSets, questionText,
  MAX_STDIN_BYTES, MAX_ISLAND_WAIT_MS, formatNoDecision, resolveConfig, computeDeadline, sessionToken } = require('./hook-common.cjs');

const COPILOT_ALLOW = '{"behavior":"allow"}\n';
const COPILOT_DENY = JSON.stringify({ behavior: 'deny', message: 'Denied from the Koda island by the user.' }) + '\n';
const { OPTIONS, LOSSY_OPTIONS } = optionSets('Copilot CLI', 'Copilot');
const EVENTS = { 'permission-request': 'PermissionRequest', stop: 'SessionEnd' };
// Copilot's runtime tool names -> the names the shared projection knows. Everything else keeps its name and is lossy.
const TOOL_ALIASES = { bash: 'Bash' };

function field(data, camel, snake) { return data[camel] !== undefined ? data[camel] : data[snake]; }
function parseToolInput(v) {
  if (typeof v !== 'string') return v;
  try { const parsed = JSON.parse(v); return isObject(parsed) ? parsed : v; } catch { return v; }
}

async function handleCopilotHook({ event, input, env = {}, argv = [], now, clientFactory = defaultFactory } = {}) {
  try {
    if (!EVENTS[event]) return none();
    const args = parseArgs(argv);
    if (!args) return none();
    if (typeof input !== 'string' || Buffer.byteLength(input) > MAX_STDIN_BYTES) return none();
    let data;
    try { data = JSON.parse(input); } catch { return none(); }
    if (!isObject(data)) return none();
    // The PascalCase (VS Code compatible) payload names its event; the camelCase one does not. A named event must be ours.
    if (data.hook_event_name !== undefined && data.hook_event_name !== EVENTS[event]) return none();
    const cwd = data.cwd;
    if (!validCwd(cwd)) return none();
    if (event === 'stop') { // sessionEnd: one settled notice, never any output
      let cfg;
      try { cfg = resolveConfig(env, process.getuid?.()); } catch { return none(); }
      if (!cfg.endpoint) return none();
      const c = clientFactory({ endpoint: cfg.endpoint, runtime: cfg.runtime, cwd, agent: 'copilot-cli', onDiagnostic: () => {}, sessionId: sessionToken(field(data, 'sessionId', 'session_id')) });
      await c.notify();
      return none();
    }
    const toolName = field(data, 'toolName', 'tool_name');
    if (typeof toolName !== 'string' || toolName.length === 0) return none();
    const toolInput = parseToolInput(field(data, 'toolInput', 'tool_input'));

    const deadline = computeDeadline({ cliTimeoutMs: args.timeoutSec * 1000, maxMs: MAX_ISLAND_WAIT_MS });
    if (deadline.mode !== 'ask') return none('Koda island: hook timeout too short for a question. Answer in the terminal.\n');

    let config;
    try { config = resolveConfig(env, process.getuid?.()); } catch { return none('Koda island: invalid configuration.\n'); }
    if (!config.endpoint) return none('Koda island unavailable. Answer in the terminal.\n');
    const options = { endpoint: config.endpoint, runtime: config.runtime, cwd, agent: 'copilot-cli', onDiagnostic: () => {},
      sessionId: sessionToken(field(data, 'sessionId', 'session_id')) };
    if (typeof now === 'function') options.clock = { now, setTimer: setTimeout, clearTimer: clearTimeout };
    const client = clientFactory(options);

    const detail = toolDescription(TOOL_ALIASES[toolName] || toolName, toolInput);
    const bypass = isObject(toolInput) && toolInput.requestSandboxBypass === true;
    const lossy = detail.lossy || bypass;
    const result = await client.ask({ kind: 'question', text: questionText('Copilot CLI', bypass ? { ...detail, lossy: true } : detail),
      options: (lossy ? LOSSY_OPTIONS : OPTIONS).map(o => ({ ...o })), allowFreeText: false, timeoutMs: deadline.timeoutMs });
    if (result && result.status === 'answered' && result.answer && result.answer.type === 'option') {
      if (result.answer.value === 'allow' && !lossy) return { stdout: COPILOT_ALLOW, stderr: '', exitCode: 0 };
      if (result.answer.value === 'deny') return { stdout: COPILOT_DENY, stderr: '', exitCode: 0 };
    }
    if (result && result.status === 'unavailable') return none('Koda island unavailable. Answer in the terminal.\n');
    return none(formatNoDecision(result) + '\n');
  } catch {
    return none();
  }
}
module.exports = { handleCopilotHook, COPILOT_ALLOW, COPILOT_DENY, parseArgs, watchdogMs, startWatchdog };
