// Adapted from Coucou src/hub/shell.ts @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT
// The window: a sidebar with Flow and Notch, and the page under its coloured band.
// Adapted for Abito: external CSS, closed shims, Spanish copy, no reserved branding.
import { h, clear } from "../views/dom.js";
import { t } from "./i18n-es.js";
import { onEvent } from "./bridge-shim.js";
import { FlowBridge, type FlowPrefs, type FlowStatus, type ModelsStatus } from "./flow-shim.js";
import { hero, liveMochi } from "./hero.js";
import { icon, keyLabel } from "./ui.js";

export type PageId =
  | "dictation" | "notes" | "insights" | "dictionary" | "snippets" | "styles" | "flowsettings"
  | "general" | "agents" | "chat" | "voice" | "integrations" | "phone" | "shortcuts" | "privacy";

interface PageDef {
  id: PageId;
  icon: string;
  title: () => string;
  /** The band's line; none for pages that draw their own band. */
  subtitle?: () => string;
}

export const FLOW_PAGES: PageDef[] = [
  { id: "dictation", icon: "mic", title: () => t("Dictation") },
  { id: "notes", icon: "record", title: () => t("Notetaker") },
  { id: "insights", icon: "chart", title: () => t("Statistics") },
  { id: "dictionary", icon: "book", title: () => t("Dictionary") },
  { id: "snippets", icon: "bolt", title: () => t("Snippets") },
  { id: "styles", icon: "text", title: () => t("Styles") },
  { id: "flowsettings", icon: "sliders", title: () => "Ajustes de dictado" },
];

export const NOTCH_PAGES: PageDef[] = [
  { id: "general", icon: "gear", title: () => t("General"), subtitle: () => t("Koda, his sounds and how the island behaves.") },
  // 0.2.1 (S1, option B): «Integraciones» (services) and «Agentes» (the CLI hooks) are two pages.
  { id: "integrations", icon: "puzzle", title: () => "Integraciones", subtitle: () => "Los servicios que Koda usa y cuáles se ven en la isla." },
  { id: "agents", icon: "terminal", title: () => "Agentes", subtitle: () => "Los hooks de cada agente de línea de comandos." },
  { id: "chat", icon: "chat", title: () => t("Chat"), subtitle: () => t("The AI of the island's chat, with your own keys.") },
  { id: "voice", icon: "wave", title: () => "OK Koda" },
  { id: "phone", icon: "phone", title: () => t("Android phone"), subtitle: () => t("Your agents and their approvals on your Android phone, over your Wi-Fi.") },
  { id: "shortcuts", icon: "keyboard", title: () => t("Shortcuts"), subtitle: () => t("The keys that open the island and its actions.") },
  { id: "privacy", icon: "lock", title: () => "Privacidad", subtitle: () => "Avisos de fallos y reportes que vos decidís enviar." },
];

const ALL = [...FLOW_PAGES, ...NOTCH_PAGES];
// abito-pausa (human 0.1.2: «vale todo lo que este en pausa se puede ocultar?» → yes; supersedes 26-oct «Visibles en gris y apagadas»):
// this version works on Chat and Agentes. Every other page is HIDDEN from the menu and never opened; a request for one
// (hub-page, abito:hub-select, initialPage) lands on General. This list stays the single source of truth.
export const ACTIVE_PAGES: readonly string[] = Object.freeze(["general", "agents", "chat", "shortcuts", "privacy"]);
export const PAUSED_PAGES: readonly string[] = Object.freeze(ALL.map((p) => p.id).filter((id) => !ACTIVE_PAGES.includes(id)));
export const PAUSED_LABEL = "En pausa · próxima versión";
const isPaused = (id: string) => PAUSED_PAGES.includes(id);

/** What a page gets to draw itself and reach the rest of the window. */
export interface HubContext {
  status: FlowStatus;
  navigate(page: PageId): void;
  refresh(): Promise<FlowStatus>;
  setPrefs(change: (p: FlowPrefs) => void): Promise<void>;
  hero(page: PageId, title: string, subtitle: string | null, actions?: HTMLElement[], compact?: boolean): HTMLElement;
  updateModels?(models: ModelsStatus): void;
  onLeave?: () => void;
}
export type FlowPageRenderer = (container: HTMLElement, ctx: HubContext) => void | Promise<void>;
export interface HubOptions {
  version: string;
  flowPages: Partial<Record<PageId, FlowPageRenderer>>;
  renderNotch(page: PageId, container: HTMLElement, navigate?: (page: PageId) => void): Promise<void | (() => void)>;
  /** The page to open first (a deep link). Anything that is not one of ALL's ids is ignored: the closed list decides. */
  initialPage?: unknown;
}
const DEFAULT_STATUS: FlowStatus = {
  prefs: {
    enabled: false, key: "right_ctrl", edge: "bottom", mic: "", keepDays: 30, cleanup: false,
    defaultStyle: "natural", summaryEngine: "off", openAtLaunch: false, voice: false, voiceOutput: "off", voiceGender: "female",
  },
  models: { parakeet: { state: "missing" }, downloadMb: 700 },
  keys: "ok",
  hasClaudeKey: false,
  mics: [],
  platform: navigator.userAgent.includes("Windows") ? "windows" : "linux",
  autostarted: false,
};

export async function startHub(root: HTMLElement, opts: HubOptions) {
  document.body.classList.add("hub-window");
  const initialPage = opts.initialPage === "accounts" ? "chat" : opts.initialPage;
  const wanted = typeof initialPage === "string" ? ALL.find((p) => p.id === initialPage && !isPaused(p.id)) : undefined;
  let current: PageId = wanted ? wanted.id : "general";
  // The window must not wait for the dictation status: that host answer enumerates audio devices and reads the keychain, and
  // took ~3 s with the sidebar still on «Cargando…». Draw now with the defaults; the real status lands when it arrives. `hasStatus`
  // (FlowBridge) still refuses writes until a real status was read, so nothing can overwrite unread preferences.
  let status: FlowStatus = DEFAULT_STATUS, statusKnown = false;
  // «checking» lasts only while the read is in flight; a read that fails keeps the defaults exactly as before (never stuck).
  const firstStatus = FlowBridge.status().then((real) => { if (real) status = real; statusKnown = true; drawStatus(); });
  const items = new Map<PageId, HTMLElement>();
  const statusLine = h("div", { class: "hub-status" });
  // abito-pausa 0.1.2: the sidebar line is dictation's own status; while dictation is paused it is hidden (it still tracks the real status)
  statusLine.hidden = isPaused("dictation");
  const scroll = h("div", { class: "hub-scroll" });
  let rendering = 0;
  let saving: Promise<any> = Promise.resolve();
  const ctx: HubContext = {
    get status() { return status; },
    navigate: (page) => void show(page),
    refresh: async () => {
      const real = await FlowBridge.status();
      if (real) { status = real; statusKnown = true; }
      drawStatus();
      return status;
    },
    setPrefs: (change) => {
      const task = saving.then(async () => {
        const next = { ...status.prefs };
        change(next);
        const saved = await FlowBridge.setPrefs(next);
        status = { ...status, prefs: { ...status.prefs, ...saved } };
        // The seven-field write reply does not include the live portal key state.
        const real = await FlowBridge.status();
        if (real) { status = real; statusKnown = true; }
        drawStatus();
      });
      saving = task.catch(() => {});
      return task;
    },
    updateModels: (models) => { status = { ...status, models }; drawStatus(); },
    hero: (page, title, subtitle, actions = [], compact = false) => hero(page, title, subtitle, actions, compact),
  };
  function drawStatus() {
    clear(statusLine);
    const models = status.models.parakeet.state;
    let color = "#6b7079";
    let text: string;
    if (!statusKnown) {
      // not read yet: never claim «off» from the defaults
      text = "Comprobando el dictado…";
    } else if (!status.prefs.enabled) {
      text = t("Dictation is off");
    } else if (models !== "ready") {
      color = "#f7b32b";
      text = models === "downloading" ? t("Downloading the voice model…") : t("Download the voice model to dictate");
    } else if (status.keys !== "ok" && status.keys !== "wayland") {
      color = "#f7b32b";
      text = t("Use the pill's microphone to dictate");
    } else {
      color = "#34d399";
      text = t("Ready · hold {0}", { 0: keyLabel("wayland", status.platform) });
    }
    statusLine.append(h("i", { class: "dot", style: `background:${color}` }), h("span", { text }));
  }
  async function show(page: PageId) {
    if (isPaused(page)) page = "general" as PageId; // paused: never opened; whatever asked for it lands on General
    const def = ALL.find((p) => p.id === page) ?? NOTCH_PAGES[0];
    ctx.onLeave?.();
    ctx.onLeave = undefined;
    current = def.id;
    for (const [id, el] of items) el.classList.toggle("on", id === current);
    const token = ++rendering;
    const page_ = h("div", { class: "hub-page" });
    const renderer = opts.flowPages[def.id];
    if (renderer) {
      // Isolate each page's late async listeners/disposal from a newer navigation.
      let leave: (() => void) | undefined;
      const pageCtx: HubContext = {
        ...ctx, get status() { return status; },
        get onLeave() { return leave; },
        set onLeave(fn) { if (token !== rendering) fn?.(); else leave = fn; },
      };
      ctx.onLeave = () => leave?.();
      await renderer(page_, pageCtx);
      if (token !== rendering) { leave?.(); return; }
    } else {
      page_.append(hero(def.id, def.title(), def.subtitle?.() ?? null));
      const container = h("div", { id: "settings-root" });
      page_.append(container);
      const dispose = await opts.renderNotch(def.id, container, ctx.navigate);
      if (token !== rendering) { dispose?.(); return; }
      if (dispose) ctx.onLeave = dispose;
    }
    if (token !== rendering) return;
    clear(scroll);
    scroll.append(page_);
    scroll.scrollTop = 0;
  }
  // ── The sidebar ──
  const side = h("nav", { class: "hub-side" });
  const logo = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  side.append(h("div", { class: "hub-brand" }, logo, h("span", { text: "Koda" })));
  liveMochi(logo);
  const group = (title: string, pages: PageDef[]) => {
    const shown = pages.filter((p) => !isPaused(p.id)); // paused pages are hidden, not greyed
    if (!shown.length) return;
    side.append(h("div", { class: "hub-group", text: title }));
    for (const p of shown) {
      const b = h("button", { class: "hub-item", "data-page": p.id, onclick: () => void show(p.id) }) as HTMLButtonElement;
      b.append(icon(p.icon), h("span", { text: p.title() }));
      items.set(p.id, b);
      side.append(b);
    }
  };
  group("Flow", FLOW_PAGES);
  group(t("Notch"), NOTCH_PAGES);
  side.append(h("div", { class: "spacer" }), statusLine, h("div", { class: "hub-version", text: `Koda ${opts.version}` }));
  clear(root);
  scroll.append(h("p", { class: "hub-loading", text: "Cargando…" }));
  root.append(side, h("main", { class: "hub-panel" }, scroll));
  drawStatus();
  void firstStatus;
  await show(current);
  // Rust tells an ALREADY OPEN window which page to show (a deep link from the island); only ids of this shell are honoured.
  if (typeof document.addEventListener === "function") document.addEventListener("abito:hub-select", (e) => {
    const legacy = (e as CustomEvent).detail;
    const id = legacy === "accounts" ? "chat" : legacy;
    if (typeof id === "string" && ALL.some((p) => p.id === id)) void show(id as PageId);
  });
  void onEvent<string>("hub-page", (page) => {
    const id = (page === "settings" ? "flowsettings" : page) as PageId;
    if (ALL.some((p) => p.id === id)) void show(id);
  });
  // Legacy upstream pushes are not authoritative for Abito's closed preferences.
  void onEvent<FlowPrefs>("flow-prefs", () => {});
  void onEvent<ModelsStatus>("dictation:models", (models) => {
    status = { ...status, models };
    drawStatus();
  });
  return { redraw: () => void show(current), current: () => current };
}
