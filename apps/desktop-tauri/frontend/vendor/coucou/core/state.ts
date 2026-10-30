// Abito-owned shim; Settings types follow windows/src/core/state.ts @434d6a2b (MIT).
import type { ProviderId } from "./providers.js";
import type { Bindings } from "./shortcuts.js";
export type AgentSource = "claudeCode" | "n8n" | "agent";
export interface Settings {
  soundEnabled: boolean;
  soundVolume: number;
  autoCloseInterval: number;
  openOnHover: boolean;
  absenceInterval: number;
  activeIntegrations: string[];
  mainPill: string;
  screen: string;
  autostart: boolean;
  hooksInstalled: boolean;
  model: string;
  showPlanInNotch: boolean;
  planRelayInstalled: boolean;
  showCodexPlanInNotch: boolean;
  chatProvider: ProviderId;
  chatModels: Record<string, string>;
  ollamaUrl: string;
  lmstudioUrl: string;
  customUrl: string;
  shortcuts: Bindings;
  mochiOutfit: string;
  pillColors: Record<string, string>;
  language: string;
  phoneLink?: boolean;
  phoneChat?: boolean;
  phoneDetails?: boolean;
  phoneChatModels?: string[];
}
// Own inert defaults, not upstream defaults: no wardrobe, services or runtime state.
// Supported values are replaced by the host view; unsupported ones cannot be saved.
export const DEFAULT_SETTINGS: Settings = {
  soundEnabled: false, soundVolume: 0, autoCloseInterval: 0, openOnHover: false,
  absenceInterval: 0, activeIntegrations: [], mainPill: '', screen: 'primary',
  autostart: false, hooksInstalled: false, model: '', showPlanInNotch: false,
  planRelayInstalled: false, showCodexPlanInNotch: false, chatProvider: 'anthropic',
  chatModels: {}, ollamaUrl: '', lmstudioUrl: '', customUrl: '', shortcuts: {},
  mochiOutfit: '', pillColors: {}, language: '',
};
