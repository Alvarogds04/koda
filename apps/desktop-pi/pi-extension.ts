/** Explicit opt-in: pi -e /absolute/path/to/pi-extension.ts */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import config from './config.cjs';
import adapter from './adapter.cjs';
import nativeAsk from './native-ask.cjs';

// K3-04 (human, 19-nov, permanent requirement): NO custom ask tool. Every question, permission or confirmation the
// human answers goes through the agent's GENERIC mechanism. In Pi that is Pi's own ask tools (`ask_user_choice` /
// `ask_user_question`, intercepted below by `native-ask.cjs`) and Pi's own `ctx.ui.confirm`; nothing is added to the
// model's tool list, so the old `abito_ask` no longer exists and no id can call it. This file is loaded as TypeScript
// by Pi's own jiti loader (there is no tsconfig or node_modules in this directory); `test/pi-loader.test.cjs` proves
// the registrations through Pi's real extension loader.
export default function (pi: ExtensionAPI) {
  let options;
  try { options = { ...config.resolveConfig(process.env, process.getuid?.()),
    ...config.resolveQuestionConfig(process.env) }; }
  catch { return; } // Invalid configuration cannot register active transport.
  // Without an explicit KODA_DESKTOP_SOCKET, the island's stable handoff (<runtime>/endpoint.json) is re-read on
  // EVERY connection attempt, with the same checks the Claude Code/Codex hooks use: the island binds a new
  // `p-XXXXXX/s` on each start, so a path resolved once would go stale.
  if (options.endpoint === undefined) {
    options.resolveEndpoint = () => config.resolveEndpoint(process.env, process.getuid?.());
  }
  let notify: ((message: string) => void) | undefined;
  // Adapter contract (adapter.cjs): endpoint discovery, notices and the QP/1 broker. The extension only wires it.
  const controller = adapter.registerAdapter(pi, { ...options, onTransportError: (error: { runtime: string }) => {
    notify?.(`The receiver at ${error.runtime} does not support the requested question capability level (handshake failed). Notices also stopped; no silent downgrade.`);
  } });
  // Pi's own ask tools (gentle-pi's ask_user_choice / one-question ask_user_question) are answerable from Abito too;
  // KODA_NATIVE_ASK=0 turns this off. See README.
  pi.on('tool_call', nativeAsk.createNativeAskHandler({ controller, env: process.env }));
  // HU-042: Pi's own yes/no confirmations (ctx.ui.confirm) are answerable from Abito too, unless sensitive;
  // KODA_NATIVE_CONFIRM=0 turns this off. Installed once per shared ui object, restored on shutdown. See README.
  let uninstallConfirm: () => void = () => {};
  pi.on('session_start', (_event, ctx) => {
    notify = ctx.hasUI ? message => ctx.ui.notify(message, 'warning') : undefined;
    uninstallConfirm();
    uninstallConfirm = nativeAsk.installConfirmRouter({ ctx, controller, env: process.env });
  });
  pi.on('session_shutdown', () => { notify = undefined; uninstallConfirm(); uninstallConfirm = () => {}; });
}
