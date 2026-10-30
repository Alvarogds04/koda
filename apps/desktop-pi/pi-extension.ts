/** Explicit opt-in: pi -e /absolute/path/to/pi-extension.ts */
import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import config from './config.cjs';
import adapter from './adapter.cjs';
import askTool from './ask-tool.cjs';
import nativeAsk from './native-ask.cjs';

export default function (pi: ExtensionAPI) {
  let options;
  try { options = { ...config.resolveConfig(process.env, process.getuid?.()),
    ...config.resolveQuestionConfig(process.env) }; }
  catch { return; } // Invalid configuration cannot register active transport.
  // Without an explicit ABITO_DESKTOP_SOCKET, the island's stable handoff (<runtime>/endpoint.json) is re-read on
  // EVERY connection attempt, with the same checks the Claude Code/Codex hooks use: the island binds a new
  // `p-XXXXXX/s` on each start, so a path resolved once would go stale.
  if (options.endpoint === undefined) {
    options.resolveEndpoint = () => config.resolveEndpoint(process.env, process.getuid?.());
  }
  let notify: ((message: string) => void) | undefined;
  const controller = adapter.registerAdapter(pi, { ...options, onTransportError: (error: { runtime: string }) => {
    notify?.(`The receiver at ${error.runtime} does not support the requested question capability level (handshake failed). Notices also stopped; no silent downgrade.`);
  } });
  // Pi's own ask tools (gentle-pi's ask_user_choice / one-question ask_user_question) are answerable from Abito too;
  // ABITO_NATIVE_ASK=0 turns this off. See README.
  pi.on('tool_call', nativeAsk.createNativeAskHandler({ controller, env: process.env }));
  // HU-042: Pi's own yes/no confirmations (ctx.ui.confirm) are answerable from Abito too, unless sensitive;
  // ABITO_NATIVE_CONFIRM=0 turns this off. Installed once per shared ui object, restored on shutdown. See README.
  let uninstallConfirm: () => void = () => {};
  pi.on('session_start', (_event, ctx) => {
    notify = ctx.hasUI ? message => ctx.ui.notify(message, 'warning') : undefined;
    uninstallConfirm();
    uninstallConfirm = nativeAsk.installConfirmRouter({ ctx, controller, env: process.env });
  });
  pi.on('session_shutdown', () => { notify = undefined; uninstallConfirm(); uninstallConfirm = () => {}; });
  const Option = Type.Object({
    value: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9_-]{1,128}$' })),
    label: Type.String({ minLength: 1, maxLength: 120 }),
    description: Type.Optional(Type.String({ maxLength: 400 })),
  }, { additionalProperties: false });
  pi.registerTool(defineTool({
    name: 'abito_ask',
    label: 'Ask through Koda',
    exposure: 'model-only',
    description: 'Ask a human through the local Koda island and wait for their answer. This blocks this tool until an answer, cancellation or deadline. Only a human answer decides; expiry is NOT approval. If the bridge is unavailable, ask through the normal chat instead. Does not intercept Pi tool permissions or provider consent. Approval requests must have explicit closed options and no free text. '
      + 'Three shapes: (1) ONE question, single choice: kind, text, options[{value,label,description}]. (2) ONE question where several options may be ticked: the same plus multiSelect:true; the answer lists every ticked option. '
      + '(3) A QUESTIONNAIRE (1-4 steps asked together, one answer per step): questions[{header (<=32 chars), question, options[2-4]{label,description?,value?}, multiSelect?, allowFreeText?}] — the same shape as Claude Code\'s AskUserQuestion; omit kind/options. '
      + 'Multi-select and questionnaires need the island to support structured questions; otherwise the call says so and you ask through normal chat. The answer reports the chosen labels per step (selected) and any free text.',
    parameters: Type.Object({
      kind: Type.Optional(Type.Union([Type.Literal('question'), Type.Literal('approval')])),
      text: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
      options: Type.Optional(Type.Array(Type.Object({
        value: Type.String({ pattern: '^[A-Za-z0-9_-]{1,128}$' }),
        label: Type.String({ minLength: 1, maxLength: 120 }),
        description: Type.String({ maxLength: 400 }),
      }, { additionalProperties: false }), { maxItems: 4 })),
      multiSelect: Type.Optional(Type.Boolean()),
      questions: Type.Optional(Type.Array(Type.Object({
        header: Type.String({ minLength: 1, maxLength: 32 }),
        question: Type.String({ minLength: 1, maxLength: 2000 }),
        options: Type.Array(Option, { minItems: 2, maxItems: 4 }),
        multiSelect: Type.Optional(Type.Boolean()),
        allowFreeText: Type.Optional(Type.Boolean()),
      }, { additionalProperties: false }), { minItems: 1, maxItems: 4 })),
      allowFreeText: Type.Optional(Type.Boolean()),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 30000, maximum: 900000 })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const out = await askTool.runAsk(controller, params, ctx, signal);
      if (out.isError && ctx.hasUI) ctx.ui.notify(out.text, 'warning');
      return { content: [{ type: 'text', text: out.text }], details: out.details, isError: out.isError };
    },
  }));
}
