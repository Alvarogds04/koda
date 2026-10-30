// Adapted from Coucou src/hub/shell.ts @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT
import { h, clear } from "../views/dom.js";
import { t } from "./i18n-es.js";
import { onEvent } from "./bridge-shim.js";
import { FlowBridge } from "./flow-shim.js";
import { hero, liveMochi } from "./hero.js";
import { icon, keyLabel } from "./ui.js";
const FLOW_PAGES = [
  { id: "dictation", icon: "mic", title: () => t("Dictation") },
  { id: "notes", icon: "record", title: () => t("Notetaker") },
  { id: "insights", icon: "chart", title: () => t("Statistics") },
  { id: "dictionary", icon: "book", title: () => t("Dictionary") },
  { id: "snippets", icon: "bolt", title: () => t("Snippets") },
  { id: "styles", icon: "text", title: () => t("Styles") },
  { id: "flowsettings", icon: "sliders", title: () => "Ajustes de dictado" }
];
const NOTCH_PAGES = [
  { id: "general", icon: "gear", title: () => t("General"), subtitle: () => t("Koda, his sounds and how the island behaves.") },
  // 0.2.1 (S1, option B): «Integraciones» (services) and «Agentes» (the CLI hooks) are two pages.
  { id: "integrations", icon: "puzzle", title: () => "Integraciones", subtitle: () => "Los servicios que Koda usa y cuáles se ven en la isla." },
  { id: "agents", icon: "terminal", title: () => "Agentes", subtitle: () => "Los hooks de cada agente de línea de comandos." },
  { id: "chat", icon: "chat", title: () => t("Chat"), subtitle: () => t("The AI of the island's chat, with your own keys.") },
  { id: "voice", icon: "wave", title: () => "OK Koda" },
  { id: "phone", icon: "phone", title: () => t("Android phone"), subtitle: () => t("Your agents and their approvals on your Android phone, over your Wi-Fi.") },
  { id: "shortcuts", icon: "keyboard", title: () => t("Shortcuts"), subtitle: () => t("The keys that open the island and its actions.") },
  { id: "privacy", icon: "lock", title: () => "Privacidad", subtitle: () => "Avisos de fallos y reportes que vos decidís enviar." }
];
const ALL = [...FLOW_PAGES, ...NOTCH_PAGES];
const ACTIVE_PAGES = Object.freeze(["general", "agents", "chat", "shortcuts", "privacy"]);
const PAUSED_PAGES = Object.freeze(ALL.map((p) => p.id).filter((id) => !ACTIVE_PAGES.includes(id)));
const PAUSED_LABEL = "En pausa · próxima versión";
const isPaused = (id) => PAUSED_PAGES.includes(id);
const DEFAULT_STATUS = {
  prefs: {
    enabled: false,
    key: "right_ctrl",
    edge: "bottom",
    mic: "",
    keepDays: 30,
    cleanup: false,
    defaultStyle: "natural",
    summaryEngine: "off",
    openAtLaunch: false,
    voice: false,
    voiceOutput: "off",
    voiceGender: "female"
  },
  models: { parakeet: { state: "missing" }, downloadMb: 700 },
  keys: "ok",
  hasClaudeKey: false,
  mics: [],
  platform: navigator.userAgent.includes("Windows") ? "windows" : "linux",
  autostarted: false
};
async function startHub(root, opts) {
  document.body.classList.add("hub-window");
  const initialPage = opts.initialPage === "accounts" ? "chat" : opts.initialPage;
  const wanted = typeof initialPage === "string" ? ALL.find((p) => p.id === initialPage && !isPaused(p.id)) : void 0;
  let current = wanted ? wanted.id : "general";
  let status = DEFAULT_STATUS, statusKnown = false;
  const firstStatus = FlowBridge.status().then((real) => {
    if (real) status = real;
    statusKnown = true;
    drawStatus();
  });
  const items = /* @__PURE__ */ new Map();
  const statusLine = h("div", { class: "hub-status" });
  statusLine.hidden = isPaused("dictation");
  const scroll = h("div", { class: "hub-scroll" });
  let rendering = 0;
  let saving = Promise.resolve();
  const ctx = {
    get status() {
      return status;
    },
    navigate: (page) => void show(page),
    refresh: async () => {
      const real = await FlowBridge.status();
      if (real) {
        status = real;
        statusKnown = true;
      }
      drawStatus();
      return status;
    },
    setPrefs: (change) => {
      const task = saving.then(async () => {
        const next = { ...status.prefs };
        change(next);
        const saved = await FlowBridge.setPrefs(next);
        status = { ...status, prefs: { ...status.prefs, ...saved } };
        const real = await FlowBridge.status();
        if (real) {
          status = real;
          statusKnown = true;
        }
        drawStatus();
      });
      saving = task.catch(() => {
      });
      return task;
    },
    updateModels: (models) => {
      status = { ...status, models };
      drawStatus();
    },
    hero: (page, title, subtitle, actions = [], compact = false) => hero(page, title, subtitle, actions, compact)
  };
  function drawStatus() {
    clear(statusLine);
    const models = status.models.parakeet.state;
    let color = "#6b7079";
    let text;
    if (!statusKnown) {
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
  async function show(page) {
    if (isPaused(page)) page = "general";
    const def = ALL.find((p) => p.id === page) ?? NOTCH_PAGES[0];
    ctx.onLeave?.();
    ctx.onLeave = void 0;
    current = def.id;
    for (const [id, el] of items) el.classList.toggle("on", id === current);
    const token = ++rendering;
    const page_ = h("div", { class: "hub-page" });
    const renderer = opts.flowPages[def.id];
    if (renderer) {
      let leave;
      const pageCtx = {
        ...ctx,
        get status() {
          return status;
        },
        get onLeave() {
          return leave;
        },
        set onLeave(fn) {
          if (token !== rendering) fn?.();
          else leave = fn;
        }
      };
      ctx.onLeave = () => leave?.();
      await renderer(page_, pageCtx);
      if (token !== rendering) {
        leave?.();
        return;
      }
    } else {
      page_.append(hero(def.id, def.title(), def.subtitle?.() ?? null));
      const container = h("div", { id: "settings-root" });
      page_.append(container);
      const dispose = await opts.renderNotch(def.id, container, ctx.navigate);
      if (token !== rendering) {
        dispose?.();
        return;
      }
      if (dispose) ctx.onLeave = dispose;
    }
    if (token !== rendering) return;
    clear(scroll);
    scroll.append(page_);
    scroll.scrollTop = 0;
  }
  const side = h("nav", { class: "hub-side" });
  const logo = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  side.append(h("div", { class: "hub-brand" }, logo, h("span", { text: "Koda" })));
  liveMochi(logo);
  const group = (title, pages) => {
    const shown = pages.filter((p) => !isPaused(p.id));
    if (!shown.length) return;
    side.append(h("div", { class: "hub-group", text: title }));
    for (const p of shown) {
      const b = h("button", { class: "hub-item", "data-page": p.id, onclick: () => void show(p.id) });
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
  if (typeof document.addEventListener === "function") document.addEventListener("abito:hub-select", (e) => {
    const legacy = e.detail;
    const id = legacy === "accounts" ? "chat" : legacy;
    if (typeof id === "string" && ALL.some((p) => p.id === id)) void show(id);
  });
  void onEvent("hub-page", (page) => {
    const id = page === "settings" ? "flowsettings" : page;
    if (ALL.some((p) => p.id === id)) void show(id);
  });
  void onEvent("flow-prefs", () => {
  });
  void onEvent("dictation:models", (models) => {
    status = { ...status, models };
    drawStatus();
  });
  return { redraw: () => void show(current), current: () => current };
}
export {
  ACTIVE_PAGES,
  FLOW_PAGES,
  NOTCH_PAGES,
  PAUSED_LABEL,
  PAUSED_PAGES,
  startHub
};
