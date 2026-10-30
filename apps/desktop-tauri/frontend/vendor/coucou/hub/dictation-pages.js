// Adapted from Coucou src/hub/pages/{dictation,flowsettings}.ts @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT.
import { h, clear } from "../views/dom.js";
import { t } from "./i18n-es.js";
import { onEvent } from "./bridge-shim.js";
import { dataLife } from "./data-pages.js";
import { FlowBridge } from "./flow-shim.js";
import { button, card, divider, keyKeycap, keyLabel, keycap, label, number, row, segmented, select, toggle, iconButton } from "./ui.js";
import { trusted } from "./runtime.js";
import { infoTip } from "./notch.js";
import { emptyState } from "./hero.js";
const unavailable = (el) => {
  el.disabled = true;
  el.title = "No disponible todavía";
  return el;
};
function mount(page, ctx) {
  let alive = true;
  const cleanups = [];
  const message = h("div", { class: "hub-note", role: "status" });
  const life = {
    alive: () => alive,
    dispose: () => {
      alive = false;
      for (const off of cleanups.splice(0)) off();
    },
    listen: async (name, fn) => {
      const off = await onEvent(name, (p) => {
        if (alive) fn(p);
      });
      if (alive) cleanups.push(off);
      else off();
    },
    watch: async (fn) => {
      const off = await onEvent("dictation:models", (m) => {
        if (alive) fn(m);
      });
      if (alive) cleanups.push(off);
      else off();
    },
    work: async (fn) => {
      if (!alive) return;
      try {
        return await fn();
      } catch {
        if (alive) {
          message.textContent = "No se pudo completar. No se anuncia ningún cambio como guardado.";
          if (!message.isConnected) page.append(message);
        }
      }
    }
  };
  ctx.onLeave = life.dispose;
  return life;
}
function modelsControl(ctx, life, onReady) {
  const el = h("div", { style: "display:flex;align-items:center;gap:8px" });
  let models = ctx.status.models, confirming = false, busy = false;
  const run = (fn) => void life.work(async () => {
    if (busy) return;
    busy = true;
    try {
      const next = await fn();
      if (life.alive()) {
        models = next;
        ctx.status.models = next;
        ctx.updateModels?.(next);
        confirming = false;
        draw();
      }
    } finally {
      busy = false;
    }
  });
  const click = (text, fn, kind = "", small = false) => trusted(button(text, fn, kind, small));
  const draw = () => {
    clear(el);
    const m = models.parakeet;
    if (m.state === "missing") el.append(click(t("Download"), () => run(FlowBridge.download), "primary"));
    else if (m.state === "downloading") {
      const percent = Math.round(Math.max(0, Math.min(1, m.fraction ?? 0)) * 100);
      el.append(h("div", { class: "hub-progress" }, h("i", { style: `width:${percent}%` })), h("span", { class: "hub-note", text: `${percent} %` }));
    } else if (m.state === "failed") el.append(h("span", { class: "hub-note", text: m.error, title: m.error, style: "max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }), click(t("Retry"), () => run(FlowBridge.download)));
    else if (confirming) el.append(click(t("Remove the models"), () => run(FlowBridge.removeModels), "danger", true), click(t("Cancel"), () => {
      confirming = false;
      draw();
    }, "", true));
    else el.append(trusted(h("button", { class: "hub-link", style: "color:var(--hub-green)", text: `✓ ${t("Installed")}`, title: t("Remove the models"), onclick: () => {
      confirming = true;
      draw();
    } })));
  };
  draw();
  void life.watch((next) => {
    const wasReady = models.parakeet.state === "ready";
    models = next;
    ctx.status.models = next;
    ctx.updateModels?.(next);
    draw();
    if (!wasReady && next.parakeet.state === "ready") onReady?.();
  });
  return el;
}
async function flowSettingsPage(page, ctx, _invoke) {
  const life = mount(page, ctx);
  const status = await ctx.refresh();
  if (!life.alive()) return;
  const save = (change) => life.work(() => ctx.setPrefs(change));
  const prefs = status.prefs;
  const copied = h("div", { class: "hub-note", role: "status" });
  page.append(ctx.hero("flowsettings", "Ajustes de dictado", null));
  const keyName = keyLabel("wayland", status.platform), micName = prefs.mic || "";
  const mic = status.mics.find((m) => m.name === prefs.mic);
  const tryField = h("textarea", { id: "dictation-try-field", class: "hub-input", rows: "3", readonly: "true", "aria-label": "Lo que dictaste", placeholder: "Lo que dictes aparece acá" });
  const tryStatus = h("div", { id: "dictation-try-status", class: "hub-note", role: "status", "aria-live": "polite" });
  const checks = h("div", { id: "dictation-try-checks", class: "dictation-checks" });
  const check = (ok, text) => h("span", { class: ok ? "dictation-check ok" : "dictation-check bad" }, h("span", { class: "state-ico", "aria-hidden": "true", text: ok ? "✓" : "✗" }), h("span", { class: "state-word", text }));
  const parakeetReady = status.models.parakeet.state === "ready", keysOk = status.keys === "ok" || status.keys === "wayland";
  checks.append(
    // «predeterminado del sistema» is a valid choice even with no list; a stored mic that is no longer present is not.
    check(!micName || !!mic, !micName ? "Micrófono: predeterminado del sistema" : mic ? `Micrófono: ${mic.name}` : `Micrófono: ${micName} (no está conectado)`),
    check(keysOk, keysOk ? `Tecla: ${keyName}` : "Tecla: no disponible aquí"),
    check(parakeetReady, parakeetReady ? "Reconocimiento: Parakeet" : "Reconocimiento: falta descargar Parakeet")
  );
  const SEGMENTS = 5, NO_SIGNAL_MS = 1200;
  const segs = Array.from({ length: SEGMENTS }, () => h("span", { class: "mic-seg" }));
  const meterWord = h("span", { class: "mic-meter-word", text: "sin señal" });
  const meter = h(
    "div",
    { id: "dictation-mic-meter", class: "mic-meter", role: "meter", "aria-label": "Nivel del micrófono", "aria-valuemin": "0", "aria-valuemax": "1", "aria-valuenow": "0", "data-state": "none" },
    h("span", { class: "mic-meter-title", text: "Micrófono" }),
    h("span", { class: "mic-segs" }, ...segs),
    meterWord
  );
  let quiet;
  const noSignal = () => {
    meter.dataset.state = "none";
    meter.setAttribute("aria-valuenow", "0");
    segs.forEach((sg) => sg.classList.remove("on"));
    meterWord.textContent = "sin señal";
  };
  void life.listen("dictation:level", (p) => {
    const v = typeof p?.level === "number" && Number.isFinite(p.level) ? Math.min(1, Math.max(0, p.level)) : null;
    if (v === null) return;
    meter.dataset.state = "live";
    meter.setAttribute("aria-valuenow", v.toFixed(2));
    meterWord.textContent = "";
    const lit = Math.round(v * SEGMENTS);
    segs.forEach((sg, i) => sg.classList.toggle("on", i < lit));
    clearTimeout(quiet);
    quiet = setTimeout(() => {
      if (life.alive()) noSignal();
    }, NO_SIGNAL_MS);
  });
  const refreshTry = () => void life.work(async () => {
    const entries = await FlowBridge.history();
    if (!life.alive()) return;
    tryField.value = entries[0]?.text ?? "";
    tryStatus.textContent = entries[0] ? "Último dictado." : "";
  });
  void life.listen("dictation:history", () => refreshTry());
  page.append(label("Probar"), h(
    "div",
    { id: "dictation-try", class: "dictation-try" },
    h("div", { class: "dictation-try-title", text: `Probar: mantené ${keyName} y hablá` }),
    tryField,
    meter,
    tryStatus,
    h("div", { class: "hub-row" }, infoTip("Se copia al portapapeles: pegá con Ctrl+V donde escribas.", "Más información: Probar")),
    checks
  ));
  const edges = [["bottom", t("Bottom")], ["left", t("Left")], ["right", t("Right")]];
  page.append(label("Activación"));
  const keysCard = card(
    row(t("Hold a key to dictate anywhere"), null, trusted(toggle(prefs.enabled, (on) => save((p) => p.enabled = on)))),
    divider(),
    row(t("Hold to dictate"), null, keyKeycap("wayland", status.platform)),
    divider(),
    row(t("Where the pill is"), null, trusted(segmented(edges, prefs.edge, (edge) => save((p) => p.edge = edge)))),
    divider(),
    row(t("Hands-free"), null, keyKeycap("wayland", status.platform, true), infoTip(t("Tap twice, speak as long as you like, tap once to paste."), "Más información: Manos libres")),
    divider(),
    row(t("Paste the last dictation again"), null, trusted(button(t("Paste again"), () => void life.work(async () => {
      await FlowBridge.copyLast();
      if (life.alive()) {
        copied.textContent = "Copiado · presiona Ctrl+V para pegar";
      }
    }), "", true)), infoTip(t("When the words went to the wrong place."), "Más información: Pegar de nuevo")),
    divider(),
    row(t("Cancel a dictation"), null, keycap(t("Esc")))
  );
  if (status.keys === "ok") {
    keysCard.append(h("div", {
      class: "hub-warn",
      text: t("On Wayland, the desktop holds the dictation key for Koda: Ctrl+Alt+V, or the keys you picked when it asked. The first paste asks once to let Koda type for you.")
    }));
  } else if (status.keys !== "ok") {
    keysCard.append(h("div", { class: "hub-warn", text: t("Koda can't watch the keyboard here: use the pill's microphone to dictate.") }));
  }
  page.append(keysCard, copied);
  page.append(label("Audio"));
  const mics = [["", t("System default")], ...status.mics.map((m) => [m.name, m.name])];
  if (prefs.mic && !mics.some(([id]) => id === prefs.mic)) mics.push([prefs.mic, prefs.mic]);
  const toVoice = trusted(h("button", { class: "hub-link", text: "Administrar en OK Koda", onclick: () => ctx.navigate("voice") }));
  page.append(card(
    row(t("Microphone"), null, trusted(select(mics, prefs.mic, (mic2) => save((p) => p.mic = mic2))), infoTip(t("The one Koda listens to for dictation and calls."), "Más información: Micrófono")),
    divider(),
    row(t("Parakeet, on your computer"), null, modelsControl(ctx, life), infoTip(t("The most accurate, offline, 25 languages. Downloaded once (about {0} MB).", { 0: number(status.models.downloadMb) }) + " " + t("Your voice never leaves this computer: Parakeet turns it into text here, and the recording is dropped as soon as it is pasted."), "Más información: Parakeet")),
    h("div", { class: "hub-row" }, toVoice)
  ));
  page.append(label("Datos"));
  const keep = [["0", t("Don't keep")], ["7", t("7 days")], ["30", t("30 days")], ["365", t("1 year")], ["-1", t("Forever")]];
  const confirmRow = h("div", { class: "hub-row" });
  const erase = () => {
    clear(confirmRow);
    confirmRow.append(
      trusted(button(t("Erase the history"), () => void life.work(() => FlowBridge.clear(false)), "", true)),
      trusted(button(t("Erase everything"), () => {
        if (!life.alive()) return;
        clear(confirmRow);
        confirmRow.append(
          h("span", { class: "hub-note", style: "flex:1", text: t("Erase the history and the statistics?") }),
          trusted(button(t("Erase everything"), () => void life.work(async () => {
            await FlowBridge.clear(true);
            if (life.alive()) erase();
          }), "danger", true)),
          trusted(button(t("Cancel"), () => {
            if (life.alive()) erase();
          }, "", true))
        );
      }, "", true))
    );
  };
  erase();
  page.append(card(
    row(t("Keep the history"), null, trusted(select(keep, String(prefs.keepDays), (v) => save((p) => p.keepDays = Number(v))))),
    divider(),
    confirmRow,
    h("div", { class: "hub-row" }, infoTip(t("The history, the statistics and your notes stay on this computer, in Koda's folder. Dictations are never saved as audio; a call's audio is deleted as soon as its transcript is written."), "Más información: Datos"))
  ));
}
async function dictationPage(page, ctx) {
  const life = mount(page, ctx), status = await ctx.refresh(), key = "Ctrl+Alt+V";
  if (!life.alive()) return;
  page.append(ctx.hero("dictation", "Dictado", null));
  if (!status.prefs.enabled || status.models.parakeet.state !== "ready") {
    page.append(card(row("Falta preparar el dictado", null, trusted(button("Ir a Ajustes de dictado", () => ctx.navigate("flowsettings"), "primary", true)))));
  }
  const data = dataLife(page, { ...ctx, set onLeave(fn) {
    ctx.onLeave = () => {
      life.dispose();
      fn?.();
    };
  } });
  const snapshots = await data.load(() => Promise.all([FlowBridge.history()]));
  if (!life.alive() || !snapshots) return;
  let [entries] = snapshots, query = "";
  const copied = h("div", { class: "hub-note", role: "status" });
  const search = data.live(h("input", { class: "hub-input", placeholder: t("Search dictations"), type: "search" }));
  const list = h("div", { style: "display:flex;flex-direction:column;gap:10px" });
  const dayKey = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  };
  const dayTitle = (ms) => dayKey(ms) === dayKey(Date.now()) ? t("Today") : dayKey(ms) === dayKey(Date.now() - 864e5) ? t("Yesterday") : new Date(ms).toLocaleDateString(document.documentElement.lang || void 0, { weekday: "long", day: "numeric", month: "long" });
  const draw = () => {
    clear(list);
    if (status.prefs.keepDays === 0) {
      list.append(emptyState(t("The history is off. Turn it on in Settings → Privacy.")));
      return;
    }
    const shown = query ? entries.filter((e) => e.text.toLowerCase().includes(query)) : entries;
    if (!shown.length) {
      list.append(emptyState(query ? t("No dictation matches.") : t("Your dictations will show here. Hold {0} in any app and speak.", { 0: key })));
      return;
    }
    let group, groupDay = "";
    for (const e of shown.slice(0, 300)) {
      const d = dayKey(e.date);
      if (d !== groupDay) {
        groupDay = d;
        list.append(h("div", { class: "hub-day", text: dayTitle(e.date) }));
        group = h("div", { class: "hub-entries" });
        list.append(group);
      }
      const when = h("div", { class: "when" }, h("span", { text: new Date(e.date).toLocaleTimeString(document.documentElement.lang || void 0, { hour: "2-digit", minute: "2-digit" }) }));
      if (e.app) when.append(h("span", { class: "hub-tag", text: e.app, title: e.app }));
      group.append(h("div", { class: "hub-entry" }, when, h("div", { class: "words", text: e.text }), h(
        "div",
        { class: "tools" },
        data.live(iconButton("copy", t("Copy"), () => void life.work(async () => {
          await FlowBridge.copyEntry(e.id);
          if (life.alive()) copied.textContent = "Copiado · presiona Ctrl+V para pegar";
        }))),
        data.live(iconButton("trash", t("Delete"), () => data.change(() => {
          entries = entries.filter((x) => x.id !== e.id);
        }, () => FlowBridge.deleteEntry(e.id), async () => {
          entries = await FlowBridge.history();
        }, draw)))
      )));
    }
  };
  let refreshGeneration = 0;
  const refresh = () => void life.work(async () => {
    const generation = ++refreshGeneration;
    const fresh = await FlowBridge.history();
    if (life.alive() && generation === refreshGeneration) {
      entries = fresh;
      draw();
    }
  });
  await life.listen("dictation:phase", (p) => {
    if (p.phase === "copied" || p.phase === "idle") refresh();
  });
  await life.listen("dictation:history", refresh);
  if (!life.alive()) return;
  search.addEventListener("input", () => {
    query = search.value.trim().toLowerCase();
    draw();
  });
  draw();
  const left = h("div", { style: "display:flex;flex-direction:column;gap:10px;min-width:0" }, h("div", { class: "hub-history-head" }, label(t("History")), search), copied, list);
  page.append(left);
}
export {
  dictationPage,
  flowSettingsPage,
  modelsControl,
  mount
};
