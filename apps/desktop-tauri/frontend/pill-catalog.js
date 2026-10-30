'use strict';
// #345 F031: immutable mechanics/identities only. No copied upstream appearance,
// credentials, connector installation or palette overrides (#346 owns colors).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AbitoPillCatalog = Object.freeze(api);
})(typeof self !== 'undefined' ? self : this, () => {
  const CATEGORIES = Object.freeze([
    ['workspace', 'Dónde programás'], ['agent', 'Agentes'],
    ['ai', 'IA para el chat'], ['service', 'Servicios'],
  ].map(([id, name]) => Object.freeze({ id, name })));
  const CATALOG = Object.freeze([
    ['integration_claude', 'VS Code', 'workspace', 'both'],
    ['agent_cursor', 'Cursor', 'workspace', 'both'],
    ['agent_antigravity', 'Antigravity', 'workspace', 'both'],
    ['agent_codex', 'Codex', 'workspace', 'both'],
    ['agent_gemini', 'Gemini CLI', 'agent', 'both'],
    ['agent_copilot', 'Copilot CLI', 'agent', 'both'],
    ['agent_muse', 'Muse Code', 'agent', 'both'],
    ['agent_opencode', 'OpenCode', 'agent', 'both'],
    ['agent_amp', 'Amp', 'agent', 'both'],
    ['agent_hermes', 'Hermes', 'agent', 'both'],
    ['agent_claude-desktop', 'Claude Desktop', 'agent', 'windows'],
    ['ai_anthropic', 'Anthropic', 'ai', 'both'],
    ['ai_google', 'Google AI', 'ai', 'both'],
    ['ai_openai', 'OpenAI', 'ai', 'both'],
    ['ai_ollama', 'Ollama', 'ai', 'both'],
    ['ai_lmstudio', 'LM Studio', 'ai', 'both'],
    ['integration_resend', 'Resend', 'service', 'both'],
    ['integration_n8n', 'n8n', 'service', 'both'],
    ['integration_vercel', 'Vercel', 'service', 'both'],
    ['integration_github', 'GitHub', 'service', 'both'],
    ['integration_notion', 'Notion', 'service', 'both'],
    ['integration_calcom', 'Cal.com', 'service', 'both'],
    ['integration_stripe', 'Stripe', 'service', 'both'],
    ['integration_music', 'Apple Music', 'service', 'excluded'],
    ['integration_spotify', 'Spotify', 'service', 'linux'],
  ].map(([id, name, category, platform]) => Object.freeze({ id, name, category, platform })));
  const HOST_OS = typeof navigator !== 'undefined' && /Windows/.test(navigator.userAgent || '') ? 'windows' : 'linux';
  const definition = id => CATALOG.find(def => def.id === id) || null;
  const offered = (id, os = HOST_OS) => {
    const def = definition(id);
    return !!def && ['linux', 'windows'].includes(os) && (def.platform === 'both' || def.platform === os);
  };
  const available = (os = HOST_OS) => CATALOG.filter(def => offered(def.id, os));
  // 0.2.1 (S3): «Herramienta principal» offers the CLIs only. What a stored file may already hold stays ACCEPTED (src/prefs.rs MAIN_PILLS),
  // so a saved Cursor/Antigravity choice is read back, not silently reset; it is just not offered any more.
  const CLI_MAIN = Object.freeze(['integration_claude', 'agent_codex', 'agent_gemini', 'agent_hermes']);
  const ACCEPTED_MAIN = Object.freeze(['integration_claude', 'agent_cursor', 'agent_antigravity', 'agent_codex', 'agent_gemini', 'agent_hermes']);
  const mainChoices = (os = HOST_OS) => CLI_MAIN.map(id => available(os).find(def => def.id === id)).filter(Boolean);
  const acceptedMain = (os = HOST_OS) => ACCEPTED_MAIN.map(id => available(os).find(def => def.id === id)).filter(Boolean);
  return { CATEGORIES, CATALOG, HOST_OS, definition, offered, available, mainChoices, acceptedMain };
});
