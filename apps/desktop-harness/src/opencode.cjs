'use strict';
// OpenCode `permission.ask` adapter. The installed plugin (install-opencode.cjs) runs this as a child process: request JSON on stdin,
// at most one line on stdout: {"status":"allow"|"deny"}. Empty stdout = no decision, the plugin leaves output.status as OpenCode set it
// ("ask"), so OpenCode's own TUI prompt appears. Never emits anything else; exit 0 always.
// UNVERIFIED against a real OpenCode (not installed here): the request fields below follow its documented Permission object.
const { parseArgs, none, isObject, validCwd, toolDescription, defaultFactory, optionSets, questionText,
  MAX_STDIN_BYTES, MAX_ISLAND_WAIT_MS, formatNoDecision, resolveConfig, computeDeadline, sessionToken } = require('./hook-common.cjs');

const OC_ALLOW = '{"status":"allow"}\n';
const OC_DENY = '{"status":"deny"}\n';
const { OPTIONS, LOSSY_OPTIONS } = optionSets('OpenCode');

// Only a bash command whose metadata is exactly {command} can be shown whole. Everything else (edit, webfetch, unknown) is lossy.
function describe(type, title, metadata) {
  if (type === 'bash' && isObject(metadata) && typeof metadata.command === 'string') return toolDescription('Bash', metadata);
  return toolDescription(typeof type === 'string' && type ? type : 'tool', { _unshown: true });
}

async function handleOpencodeHook({ event, input, env = {}, argv = [], now, clientFactory = defaultFactory } = {}) {
  try {
    if (event !== 'permission-request' && event !== 'stop') return none();
    const args = parseArgs(argv);
    if (!args) return none();
    if (typeof input !== 'string' || Buffer.byteLength(input) > MAX_STDIN_BYTES) return none();
    let data;
    try { data = JSON.parse(input); } catch { return none(); }
    if (!isObject(data) || !validCwd(data.directory) || typeof data.sessionID !== 'string' || (event === 'permission-request' && typeof data.type !== 'string')) return none();
    if (event === 'stop') { // session.idle: one settled notice, never any output
      let cfg;
      try { cfg = resolveConfig(env, process.getuid?.()); } catch { return none(); }
      if (!cfg.endpoint) return none();
      await clientFactory({ endpoint: cfg.endpoint, runtime: cfg.runtime, cwd: data.directory, sessionId: sessionToken(data.sessionID), agent: 'opencode', onDiagnostic: () => {} }).notify();
      return none();
    }
    const deadline = computeDeadline({ cliTimeoutMs: args.timeoutSec * 1000, maxMs: MAX_ISLAND_WAIT_MS });
    if (deadline.mode !== 'ask') return none('Koda island: hook timeout too short for a question. Answer in the terminal.\n');
    let config;
    try { config = resolveConfig(env, process.getuid?.()); } catch { return none('Koda island: invalid configuration.\n'); }
    if (!config.endpoint) return none('Koda island unavailable. Answer in the terminal.\n');
    const options = { endpoint: config.endpoint, runtime: config.runtime, cwd: data.directory, sessionId: sessionToken(data.sessionID), agent: 'opencode', onDiagnostic: () => {} };
    if (typeof now === 'function') options.clock = { now, setTimer: setTimeout, clearTimer: clearTimeout };
    const detail = describe(data.type, data.title, data.metadata);
    const result = await clientFactory(options).ask({ kind: 'question', text: questionText('OpenCode', detail),
      options: (detail.lossy ? LOSSY_OPTIONS : OPTIONS).map(o => ({ ...o })), allowFreeText: false, timeoutMs: deadline.timeoutMs });
    if (result && result.status === 'answered' && result.answer && result.answer.type === 'option') {
      if (result.answer.value === 'allow' && !detail.lossy) return { stdout: OC_ALLOW, stderr: '', exitCode: 0 };
      if (result.answer.value === 'deny') return { stdout: OC_DENY, stderr: '', exitCode: 0 };
    }
    if (result && result.status === 'unavailable') return none('Koda island unavailable. Answer in the terminal.\n');
    return none(formatNoDecision(result) + '\n');
  } catch { return none(); }
}
module.exports = { handleOpencodeHook, OC_ALLOW, OC_DENY };
