// Adapted from Coucou src/settings/main.ts shortcutsSection @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT.
import { h, clear } from "../views/dom.js";
import { SHORTCUTS, SHORTCUT_TEXT, ISLAND_SHORTCUTS, displayKeys, duplicates, normalizeKeys } from "../core/shortcuts.js";
import { toggle } from "./ui.js";
import { notchHint as hint, notchTipSection } from "./notch.js";
import { session, trusted } from "./runtime.js";
import { t } from "./i18n-es.js";
const PORTAL_MODIFIERS = { shift: "Shift", control: "Ctrl", ctrl: "Ctrl", primary: "Ctrl", alt: "Alt", mod1: "Alt", super: "Super", meta: "Super", mod4: "Super", hyper: "Super" };
function portalTriggerKeys(text) {
  if (typeof text !== "string" || text.length > 200) return null;
  const m = /((?:<[A-Za-z0-9_]{1,12}>)+)\s*([^\s<>]{1,16})\s*$/.exec(text.trim());
  if (!m) return null;
  const rest = text.trim().slice(0, m.index).trim();
  if (rest.split(/\s+/).length > 3 && rest.length > 40) return null;
  const mods = [];
  for (const raw of m[1].slice(1, -1).split("><")) {
    const mapped = PORTAL_MODIFIERS[raw.toLowerCase()];
    if (!mapped) return null;
    if (!mods.includes(mapped)) mods.push(mapped);
  }
  const order = ["Ctrl", "Alt", "Shift", "Super"];
  mods.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return normalizeKeys([...mods, m[2]].join("+"));
}
function keyText(effective, combo, fallback) {
  const translated = effective ? portalTriggerKeys(effective) ?? normalizeKeys(effective) : null;
  if (translated) return displayKeys(translated);
  const configured = combo ? normalizeKeys(combo) : null;
  if (configured) return displayKeys(configured);
  const base = fallback ? normalizeKeys(fallback) : null;
  return base ? displayKeys(base) : "—";
}
async function renderShortcuts({ invoke, V, listen, timers }) {
  const s = session(invoke, listen, timers), { root, call, work } = s;
  root.style.setProperty("display", "contents");
  const views = Object.fromEntries(SHORTCUTS.filter((d) => d.ported).map((d) => [d.id, null]));
  let recording = null, busy = false, capturing = false, missed = false;
  const refreshAll = () => {
    for (const id of Object.keys(views)) work(() => call("hotkey_action", payloadFor(id, { action: "view" })), (next) => {
      views[id] = next;
      if (!capturing) draw();
    });
  };
  const resume = () => call("hotkey_action", { action: "resume" }).finally(() => {
    capturing = false;
    if (missed) {
      missed = false;
      if (s.alive()) refreshAll();
    }
  });
  function stopRecording() {
    recording = null;
    work(resume).finally(() => {
      if (s.alive()) draw();
    });
    draw();
  }
  function startRecording(id) {
    if (recording === id) {
      stopRecording();
      return;
    }
    busy = true;
    capturing = true;
    draw();
    work(() => call("hotkey_action", { action: "suspend" }), () => {
      recording = id;
    }, () => {
      recording = null;
      capturing = false;
    }).finally(() => {
      busy = false;
      if (s.alive()) {
        draw();
        list.querySelector(".recording")?.focus();
      } else invoke("hotkey_action", { payload: { action: "resume" } }).catch(() => {
      });
    });
  }
  const payloadFor = (id, payload) => id === "toggleIsland" ? payload : { ...payload, id };
  const list = h("div", { id: "global-shortcuts", class: "shortcut-list" }), feedback = hint("");
  const guide = h("div", { id: "shortcut-capture-help", class: "hint capture-help", role: "status", "aria-live": "polite", text: "Pulsá las teclas… Esc cancela · ⌫ quita" });
  guide.hidden = true;
  function save(id, payload) {
    if (busy || !views[id] || !s.alive()) return;
    const wasRecording = recording !== null;
    busy = true;
    recording = null;
    draw();
    work(() => call("hotkey_action", payloadFor(id, payload)), (next) => {
      views[id] = next;
    }, (error) => {
      if (error?.code === "combo_in_use") s.message.textContent = "Esa combinación ya está asignada a otro atajo. El anterior sigue guardado.";
    }).finally(async () => {
      if (wasRecording) await resume().catch(() => {
      });
      busy = false;
      if (s.alive()) draw();
    });
  }
  function draw() {
    clear(list);
    guide.hidden = recording === null;
    const dups = duplicates(Object.entries(views).filter(([, v]) => v?.enabled).map(([id, v]) => [id, v.combo]));
    for (const d of SHORTCUTS.filter((d2) => d2.ported)) {
      const supported = Object.hasOwn(views, d.id), hotkey = views[d.id], known = supported && !!hotkey;
      const enabled = supported ? hotkey?.enabled === true : d.enabledByDefault;
      const keys = hotkey ? hotkey.effective || hotkey.combo : d.defaultKeys;
      const shownKeys = keyText(hotkey?.effective, hotkey?.combo, d.defaultKeys);
      const sw = trusted(toggle(enabled, (on) => {
        if (known && !busy) save(d.id, { action: on ? "enable" : "disable" });
      }));
      sw.disabled = !known || busy || !keys;
      sw.setAttribute("aria-label", t(SHORTCUT_TEXT[d.id]));
      if (known && !keys) sw.title = "Graba una combinación antes de activar este atajo.";
      const isRecording = recording === d.id;
      const keycap = trusted(h("button", { class: isRecording ? "keycap recording" : "keycap", text: isRecording ? t("Press keys…") : shownKeys }));
      keycap.disabled = !known || busy;
      if (supported) keycap.title = "Esc: cancelar · Backspace: borrar";
      keycap.addEventListener("click", (e) => {
        if (!e.isTrusted || keycap.disabled) return;
        startRecording(d.id);
      });
      keycap.addEventListener("keydown", (e) => {
        if (!e.isTrusted || recording !== d.id || !known || busy) return;
        e.preventDefault();
        const result = e.key === "Backspace" && !e.repeat && !e.isComposing ? { kind: "clear" } : V.captureCombo(e);
        if (result.kind === "cancel") stopRecording();
        else if (result.kind === "clear") save(d.id, { action: "clear" });
        else if (result.kind === "combo") save(d.id, { action: "set", combo: result.text });
      });
      keycap.addEventListener("blur", () => {
        if (recording === d.id) stopRecording();
      });
      const r = h("div", { id: `shortcut-${d.id}`, role: "row", class: enabled ? "row shortcut" : "row shortcut off" }, sw, h("span", { class: "shortcut-name", role: "cell", text: t(SHORTCUT_TEXT[d.id]) }));
      const [kind, icon, word] = !known ? ["unknown", "·", "No disponible todavía"] : !enabled ? ["off", "○", "apagado"] : dups.has(d.id) ? ["err", "✗", t("Used twice")] : hotkey.status === "taken" ? ["warn", "⚠", t("In use by another app")] : hotkey.status === "invalid" ? ["err", "✗", t("Not a valid shortcut")] : hotkey.status === "unsupported" ? ["none", "·", t("Not available")] : hotkey.status === "permission_denied" ? ["warn", "⚠", t("Not set by your desktop")] : ["ok", "✓", "activo"];
      const stateCell = h("span", { class: `shortcut-state ${kind}`, role: "cell" }, h("span", { class: "state-ico", "aria-hidden": "true", text: icon }), h("span", { class: "state-word", text: word }));
      if (!supported) {
        sw.title = keycap.title = "No disponible todavía";
      }
      r.append(stateCell, keycap);
      list.append(r);
    }
    feedback.textContent = Object.values(views).some((v) => v?.status === "permission_pending") ? t("Asking your desktop to register the shortcuts. It may show its own window to confirm them.") : [...new Set(Object.values(views).map((hotkey) => V.generalView({ hotkey }).hotkey).flatMap((view) => [view?.backendLabel, view?.note]).filter(Boolean))].join(" — ");
    reset.disabled = Object.values(views).some((v) => !v) || busy;
  }
  const reset = trusted(h("button", { id: "shortcut-reset", type: "button", text: "Restablecer" }));
  const confirmBox = h("div", { id: "shortcut-reset-confirm", class: "row confirm", role: "group" });
  confirmBox.hidden = true;
  const doReset = trusted(h("button", { type: "button", class: "danger", text: "Restablecer" }));
  const cancelReset = trusted(h("button", { type: "button", text: "Cancelar" }));
  confirmBox.append(h("span", { text: "¿Restablecer todos los atajos a sus teclas originales?" }), doReset, cancelReset);
  reset.addEventListener("click", (e) => {
    if (!e.isTrusted || reset.disabled) return;
    confirmBox.hidden = !confirmBox.hidden;
  });
  cancelReset.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    confirmBox.hidden = true;
  });
  doReset.addEventListener("click", (e) => {
    if (!e.isTrusted || reset.disabled) return;
    confirmBox.hidden = true;
    busy = true;
    recording = null;
    draw();
    work(async () => {
      for (const action of ["clear", "reset"]) for (const id of Object.keys(views)) {
        try {
          views[id] = await call("hotkey_action", payloadFor(id, { action }));
        } catch {
          s.message.textContent = "No se pudieron restablecer todos los atajos. Revisa las filas e inténtalo otra vez.";
        }
      }
    }, () => {
    }, () => {
    }).finally(() => {
      busy = false;
      if (s.alive()) draw();
    });
  });
  const head = h("div", { class: "row shortcut shortcut-head", role: "row" }, ...["Acción", "Tecla", "Estado"].map((c) => h("span", { role: "columnheader", text: c })));
  const table = h("div", { class: "shortcut-table", role: "table", "aria-label": "Atajos" }, head, list);
  const island = h("div", { id: "island-shortcuts", class: "shortcut-list" });
  for (const r of ISLAND_SHORTCUTS) island.append(h("div", { class: "row shortcut" }, h("span", { class: "shortcut-name", text: t(r.description) }), h("span", { class: "keycap static", text: r.keys })));
  root.append(notchTipSection(
    t("Shortcuts"),
    t("Work from any app. Click a shortcut to change it, then press the new keys — Esc cancels, Backspace removes it."),
    h("div", { class: "subhead", text: t("From anywhere") }),
    table,
    guide,
    feedback,
    h("div", { class: "row" }, reset),
    confirmBox,
    h("div", { class: "subhead", text: t("In the open island") }),
    island
  ), s.message);
  draw();
  for (const id of Object.keys(views)) {
    work(() => call("hotkey_action", payloadFor(id, { action: "view" })), (next) => {
      views[id] = next;
      draw();
    });
    s.watch(id === "toggleIsland" ? "hotkey:state" : id === "desktopToggle" ? "hotkey-desktop:state" : `hotkey-${id}:state`, (next) => {
      if (capturing || recording) {
        missed = true;
        return;
      }
      views[id] = next;
      draw();
    });
  }
  const mounted = s.finish(), dispose = mounted.dispose, settled = mounted.settled;
  mounted.dispose = () => {
    if (recording) invoke("hotkey_action", { payload: { action: "resume" } }).catch(() => {
    });
    recording = null;
    dispose();
  };
  mounted.settled = async () => {
    await settled();
  };
  return mounted;
}
export {
  keyText,
  portalTriggerKeys,
  renderShortcuts
};
