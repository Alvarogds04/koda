// Source: reference/coucou windows/src/core/providers.ts @434d6a2b — Copyright (c) 2026 Louis Raillé, MIT
import { N_ } from "../i18n/i18n.js";
const PROVIDERS = [
  { id: "anthropic", name: "Anthropic", accent: "#E07950", key: "anthropic-api-key", urlField: null, defaultModel: "claude-opus-5", prefer: "opus" },
  { id: "google", name: "Google", accent: "#4285F4", key: "google-api-key", urlField: null, defaultModel: "gemini-2.0-flash", prefer: "flash" },
  { id: "openai", name: "OpenAI", accent: "#10A37F", key: "openai-api-key", urlField: null, defaultModel: "gpt-4o", prefer: "mini" },
  { id: "openrouter", name: "OpenRouter", accent: "#6467F2", key: "openrouter-api-key", urlField: null, defaultModel: "openrouter/auto", prefer: null },
  { id: "ollama", name: "Ollama", accent: "#FACC15", key: null, urlField: "ollamaUrl", defaultModel: "", prefer: null },
  { id: "lmstudio", name: "LM Studio", accent: "#A3E635", key: null, urlField: "lmstudioUrl", defaultModel: "", prefer: null },
  { id: "custom", name: N_("Custom server"), accent: "#C0C4CC", key: null, urlField: "customUrl", defaultModel: "", prefer: null }
];
const CUSTOM_SERVER_KEY = "openai-compatible-key";
function providerDef(id) {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
}
function activeModel(settings) {
  const p = providerDef(settings.chatProvider);
  if (p.id === "anthropic") return settings.model || p.defaultModel;
  return settings.chatModels[p.id] || p.defaultModel;
}
function withModel(settings, provider, model) {
  if (provider === "anthropic") return { ...settings, model };
  return { ...settings, chatModels: { ...settings.chatModels, [provider]: model } };
}
function visibleProviders(settings) {
  return PROVIDERS.filter(
    (p) => !p.urlField || settings[p.urlField] !== "" || settings.chatProvider === p.id
  );
}
function pickModel(provider, offered, current) {
  if (offered.length === 0) return null;
  if (offered.includes(current)) return current;
  const preferred = provider.prefer ? offered.find((id) => id.includes(provider.prefer)) : void 0;
  if (preferred) return preferred;
  return offered.includes(provider.defaultModel) ? provider.defaultModel : offered[0];
}
function isLoopbackHost(host) {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return h === "0.0.0.0" || h === "::1" || h === "::" || h === "::ffff:127.0.0.1" || h === "::ffff:7f00:1";
}
function urlExposure(raw) {
  const text = raw.trim();
  if (!text) return "local";
  let url;
  try {
    url = new URL(text.includes("://") ? text : `http://${text}`);
  } catch {
    return "invalid";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "invalid";
  if (!url.hostname || url.username || url.password) return "invalid";
  if (isLoopbackHost(url.hostname)) return "local";
  return url.protocol === "https:" ? "remote" : "remote-http";
}
export {
  CUSTOM_SERVER_KEY,
  PROVIDERS,
  activeModel,
  isLoopbackHost,
  pickModel,
  providerDef,
  urlExposure,
  visibleProviders,
  withModel
};
