// Source: reference/coucou windows/src/core/pills.ts @434d6a2b — Copyright (c) 2026 Louis Raillé, MIT
import { N_ } from "../i18n/i18n.js";
const PILL_CATEGORIES = [
  { id: "workspace", title: N_("Where you code") },
  { id: "agent", title: N_("Agents") },
  { id: "ai", title: N_("AI for the chat") },
  { id: "service", title: N_("Services") }
];
const hooks = { kind: "hooks" };
const key = (k) => ({ kind: "key", key: k });
const none = { kind: "none" };
const server = (field) => ({ kind: "server", field });
const ACCENT = {
  anthropic: "#E07950",
  google: "#4285F4",
  openai: "#10A37F",
  ollama: "#FACC15",
  lmstudio: "#A3E635"
};
const PILL_CATALOG = [
  // ── Where you code ─────────────────────────────────────────────────────────
  {
    id: "integration_claude",
    name: "Claude Code",
    color: "#F5F6F8",
    category: "workspace",
    subtitle: N_("Integration"),
    source: "claudeCode",
    support: "yes",
    connect: hooks
  },
  // Claude Code in Cursor's terminal: the same hooks as Claude Code.
  {
    id: "agent_cursor",
    name: "Cursor",
    color: "#C0C4CC",
    category: "workspace",
    subtitle: N_("Integration"),
    source: "agent",
    support: "yes",
    connect: hooks
  },
  {
    id: "agent_antigravity",
    name: "Antigravity",
    color: "#E879F9",
    category: "workspace",
    subtitle: N_("Integration"),
    source: "agent",
    support: "yes",
    connect: hooks
  },
  {
    id: "agent_codex",
    name: "Codex",
    color: "#2DD4BF",
    category: "workspace",
    subtitle: N_("Integration"),
    source: "agent",
    support: "yes",
    connect: hooks
  },
  // ── Agents ─────────────────────────────────────────────────────────────────
  {
    id: "agent_gemini",
    name: "Gemini CLI",
    color: "#8AB4F8",
    category: "agent",
    subtitle: N_("Agent"),
    source: "agent",
    support: "yes",
    connect: hooks
  },
  {
    id: "agent_copilot",
    name: "Copilot CLI",
    color: "#818CF8",
    category: "agent",
    subtitle: N_("Agent"),
    source: "agent",
    support: "yes",
    connect: hooks
  },
  {
    id: "agent_muse",
    name: "Muse Code",
    color: "#38BDF8",
    category: "agent",
    subtitle: N_("Agent"),
    source: "agent",
    support: "yes",
    connect: hooks
  },
  // A plugin that starts the relay, written from Settings → Agents (agents.rs).
  {
    id: "agent_opencode",
    name: "OpenCode",
    color: "#4ADE80",
    category: "agent",
    subtitle: N_("Agent"),
    source: "agent",
    support: "yes",
    connect: hooks
  },
  {
    id: "agent_amp",
    name: "Amp",
    color: "#F59E0B",
    category: "agent",
    subtitle: N_("Agent"),
    source: "agent",
    support: "yes",
    connect: hooks
  },
  {
    id: "agent_hermes",
    name: "Hermes",
    color: "#C084FC",
    category: "agent",
    subtitle: N_("Agent"),
    source: "agent",
    support: "yes",
    connect: hooks
  },
  // Claude Code sessions run from the Claude desktop app: the relay tags them
  // from CLAUDE_CODE_ENTRYPOINT, so there is nothing to install. The app has no
  // Linux build.
  {
    id: "agent_claude-desktop",
    name: "Claude Desktop",
    color: "#D97757",
    category: "agent",
    subtitle: N_("Agent"),
    source: "agent",
    support: "windows",
    connect: none
  },
  // ── AI for the chat ────────────────────────────────────────────────────────
  {
    id: "ai_anthropic",
    name: "Anthropic",
    color: ACCENT.anthropic,
    category: "ai",
    subtitle: N_("Chat"),
    source: "n8n",
    support: "yes",
    connect: key("anthropic-api-key")
  },
  // The chat talks to each of them (src-tauri/src/chat.rs): a key for the
  // cloud ones, a connected server for the local ones.
  {
    id: "ai_google",
    name: "Google AI",
    color: ACCENT.google,
    category: "ai",
    subtitle: N_("Chat"),
    source: "n8n",
    support: "yes",
    connect: key("google-api-key")
  },
  {
    id: "ai_openai",
    name: "OpenAI",
    color: ACCENT.openai,
    category: "ai",
    subtitle: N_("Chat"),
    source: "n8n",
    support: "yes",
    connect: key("openai-api-key")
  },
  {
    id: "ai_ollama",
    name: "Ollama",
    color: ACCENT.ollama,
    category: "ai",
    subtitle: N_("Chat"),
    source: "n8n",
    support: "yes",
    connect: server("ollamaUrl")
  },
  {
    id: "ai_lmstudio",
    name: "LM Studio",
    color: ACCENT.lmstudio,
    category: "ai",
    subtitle: N_("Chat"),
    source: "n8n",
    support: "yes",
    connect: server("lmstudioUrl")
  },
  // ── Services ───────────────────────────────────────────────────────────────
  {
    id: "integration_resend",
    name: "Resend",
    color: "#22C55E",
    category: "service",
    subtitle: N_("Integration"),
    source: "n8n",
    support: "yes",
    connect: key("resend-api-key")
  },
  {
    id: "integration_n8n",
    name: "n8n",
    color: "#F29B38",
    category: "service",
    subtitle: N_("Integration"),
    source: "n8n",
    support: "yes",
    connect: key("n8n-api-key")
  },
  {
    id: "integration_vercel",
    name: "Vercel",
    color: "#7C5CFF",
    category: "service",
    subtitle: N_("Integration"),
    source: "n8n",
    support: "yes",
    connect: key("vercel-token")
  },
  {
    id: "integration_github",
    name: "GitHub",
    color: "#F4505E",
    category: "service",
    subtitle: N_("Integration"),
    source: "n8n",
    support: "yes",
    connect: key("github-token")
  },
  {
    id: "integration_notion",
    name: "Notion",
    color: "#8C8C8C",
    category: "service",
    subtitle: N_("Integration"),
    source: "n8n",
    support: "yes",
    connect: key("notion-api-key")
  },
  {
    id: "integration_calcom",
    name: "Cal.com",
    color: "#C9956A",
    category: "service",
    subtitle: N_("Integration"),
    source: "n8n",
    support: "yes",
    connect: key("calcom-api-key")
  },
  {
    id: "integration_stripe",
    name: "Stripe",
    color: "#0570DE",
    category: "service",
    subtitle: N_("Integration"),
    source: "n8n",
    support: "yes",
    connect: key("stripe-api-key")
  },
  {
    id: "integration_music",
    name: "Apple Music",
    color: "#FA2D48",
    category: "service",
    subtitle: N_("Integration"),
    source: "n8n",
    support: "no",
    connect: none
  },
  // Spotify through MPRIS on Linux and the system media controls on Windows
  // (src-tauri/src/spotify.rs).
  {
    id: "integration_spotify",
    name: "Spotify",
    color: "#1DB954",
    category: "service",
    subtitle: N_("Integration"),
    source: "n8n",
    support: "yes",
    connect: none
  }
];
const DEFAULT_MAIN_PILL = "integration_claude";
const HOST_OS = typeof navigator !== "undefined" && /Windows/.test(navigator.userAgent ?? "") ? "windows" : "linux";
function pillDefinition(id) {
  return PILL_CATALOG.find((p) => p.id === id);
}
function offeredOn(def, os) {
  return def.support === "yes" || def.support === "soon" || def.support === os;
}
function availablePills(os = HOST_OS) {
  return PILL_CATALOG.filter((p) => offeredOn(p, os));
}
function isComingSoon(id) {
  return pillDefinition(id)?.support === "soon";
}
function isHookPill(id) {
  return pillDefinition(id)?.connect.kind === "hooks";
}
function mainPillChoices(os = HOST_OS) {
  return availablePills(os).filter((p) => p.category === "workspace" && p.support !== "soon");
}
function sessionSubtitle(id) {
  switch (id) {
    case "integration_claude":
      return "Claude Code";
    case "agent_cursor":
      return "Cursor";
    case "agent_codex":
      return "Codex";
    case "agent_hermes":
      return "Hermes";
    case "agent_claude-desktop":
      return "Claude Desktop";
    default:
      return N_("Agent");
  }
}
function sanitizeDeclared(d, os = HOST_OS) {
  const mains = new Set(mainPillChoices(os).map((p) => p.id));
  const mainPill = mains.has(d.mainPill) ? d.mainPill : DEFAULT_MAIN_PILL;
  const offered = new Set(availablePills(os).map((p) => p.id));
  const activeIntegrations = [];
  for (const id of d.activeIntegrations ?? []) {
    if (id !== mainPill && offered.has(id) && !activeIntegrations.includes(id)) {
      activeIntegrations.push(id);
    }
  }
  return { mainPill, activeIntegrations };
}
function toggleDeclared(d, id, os = HOST_OS) {
  if (id === d.mainPill) return null;
  if (!availablePills(os).some((p) => p.id === id)) return null;
  if (d.activeIntegrations.includes(id)) return d.activeIntegrations.filter((x) => x !== id);
  return [...d.activeIntegrations, id];
}
function chooseMainPill(d, id, os = HOST_OS) {
  if (!mainPillChoices(os).some((p) => p.id === id)) return null;
  return { mainPill: id, activeIntegrations: d.activeIntegrations.filter((x) => x !== id) };
}
function orderPills(tasks, mainPill) {
  const index = new Map(PILL_CATALOG.map((p, i) => [p.id, i]));
  const rank = (t) => t.id === mainPill ? -2 : index.has(t.id) ? index.get(t.id) : -1;
  return tasks.map((t, i) => ({ t, i })).sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i).map(({ t }) => t);
}
export {
  DEFAULT_MAIN_PILL,
  HOST_OS,
  PILL_CATALOG,
  PILL_CATEGORIES,
  availablePills,
  chooseMainPill,
  isComingSoon,
  isHookPill,
  mainPillChoices,
  orderPills,
  pillDefinition,
  sanitizeDeclared,
  sessionSubtitle,
  toggleDeclared
};
