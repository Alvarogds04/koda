// Adapted from Coucou src/hub/pages/{words,styles,insights}.ts @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT.
import { h, clear } from "../views/dom.js";
import { t } from "./i18n-es.js";
import { FlowBridge } from "./flow-shim.js";
import { emptyState } from "./hero.js";
import { button, card, divider, icon, iconButton, label, row, select, toggle, number, shortCount, segmented } from "./ui.js";
import { trusted } from "./runtime.js";
import { infoTip } from "./notch.js";
const newId = () => `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`;
const length = (s) => [...s].length;
const bounded = (s, n) => length(s) <= n;
function dataLife(page, ctx) {
  let alive = true, busy = false, shown = false;
  const message = h("div", { class: "hub-note", role: "status" });
  ctx.onLeave = () => {
    alive = false;
  };
  const say = (text) => {
    if (alive) {
      message.textContent = text;
      if (!shown) {
        page.append(message);
        shown = true;
      }
    }
  };
  const failure = () => say("No se pudo completar. No se anuncia ningún cambio como guardado.");
  const live = (el) => {
    trusted(el);
    for (const node of [el, ...el.querySelectorAll("button")]) for (const type of ["click", "change", "input", "keydown"])
      node.addEventListener(type, (e) => {
        if (!alive || node.disabled) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      }, true);
    return el;
  };
  return {
    alive: () => alive,
    live,
    hint: () => say("Límite o formato no válido. No se ha enviado ningún cambio."),
    load: async (read) => {
      try {
        return await read();
      } catch {
        failure();
      }
    },
    // Only one mutation in flight per mount: an older failure cannot overwrite a newer optimistic edit.
    change: (apply, write, recover, draw, done = () => {
    }) => {
      if (!alive || busy) return;
      busy = true;
      apply();
      draw();
      const locked = ["button", "select", "input", "textarea"].flatMap((tag) => [...page.querySelectorAll(tag)]);
      const enabled = locked.filter((el) => !el.disabled);
      for (const el of enabled) el.disabled = true;
      void (async () => {
        try {
          await write();
          if (alive) done();
        } catch {
          failure();
          if (alive) try {
            await recover();
            if (alive) draw();
          } catch {
            failure();
          }
        } finally {
          busy = false;
          if (alive) for (const el of enabled) el.disabled = false;
        }
      })();
    }
  };
}
function input(placeholder, onEnter) {
  const el = h("input", { class: "hub-input", placeholder });
  if (onEnter) el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") onEnter();
  });
  return el;
}
async function dictionaryPage(page, ctx) {
  const life = dataLife(page, ctx), data = await life.load(FlowBridge.words);
  if (!life.alive() || !data) return;
  let { words, replacements } = data;
  const save = (apply, draw) => life.change(apply, () => FlowBridge.setWords({ words, replacements }), async () => {
    ({ words, replacements } = await FlowBridge.words());
  }, draw);
  page.append(ctx.hero("dictionary", t("Dictionary"), null));
  const chips = h("div", { class: "hub-chips" });
  const wordInput = life.live(input(t("Add a word, e.g. Supabase"), () => addWord()));
  const addWord = () => {
    const w = wordInput.value.trim();
    if (!w || words.some((x) => x.toLowerCase() === w.toLowerCase())) return;
    if (words.length >= 500 || !bounded(w, 80) || !/^[\p{L}\p{N} '\u2019-]+$/u.test(w) || [...w].filter((c) => /[\p{L}\p{N}]/u.test(c)).length < 2) return life.hint();
    save(() => {
      words = [...words, w];
      wordInput.value = "";
    }, drawWords);
  };
  const drawWords = () => {
    clear(chips);
    if (!words.length) {
      chips.append(h("div", { class: "hub-note", text: t("No word yet. Add the names, brands and jargon Koda gets wrong.") }));
      return;
    }
    for (const w of words) {
      const remove = life.live(h("button", { title: t("Delete"), "aria-label": t("Delete") }));
      remove.append(icon("x"));
      remove.addEventListener("click", () => save(() => {
        words = words.filter((x) => x !== w);
      }, drawWords));
      chips.append(h("span", { class: "hub-chip" }, h("span", { text: w }), remove));
    }
  };
  wordInput.style.flex = "1";
  page.append(h("div", { class: "hub-row" }, label("Palabras"), infoTip(t("Names and words Koda must always spell right.") + " Ej.: Supabase.", "Más información: Palabras")), card(h("div", { class: "hub-row" }, wordInput, life.live(button(t("Add"), addWord, "primary"))), chips));
  drawWords();
  page.append(h("div", { class: "hub-row" }, label(t("Replacements")), infoTip(t("When Koda hears the words on the left, it writes the ones on the right."), "Más información: Reemplazos")));
  const list = h("div", {}), from = life.live(input("Se escucha")), to = life.live(input("Se escribe", () => addReplacement()));
  const addReplacement = () => {
    const f = from.value.trim(), w = to.value.trim();
    if (!f || !w) return;
    const kept = replacements.filter((r) => r.from.toLowerCase() !== f.toLowerCase());
    if (kept.length >= 500 || !bounded(f, 200) || !bounded(w, 200)) return life.hint();
    save(() => {
      replacements = [...kept, { id: newId(), from: f, to: w }];
      from.value = "";
      to.value = "";
    }, drawReplacements);
  };
  const drawReplacements = () => {
    clear(list);
    for (const r of replacements) list.append(h("div", { class: "hub-list-row" }, h(
      "div",
      { class: "grow hub-pair" },
      h("span", { text: r.from }),
      h("span", { class: "arrow", text: "→" }),
      h("b", { text: r.to, style: "font-weight:600" }),
      life.live(iconButton("trash", t("Delete"), () => save(() => {
        replacements = replacements.filter((x) => x.id !== r.id);
      }, drawReplacements)))
    )));
  };
  page.append(card(h("div", { class: "hub-pair" }, from, h("span", { class: "arrow", text: "→" }), to, life.live(button(t("Add"), addReplacement))), list));
  drawReplacements();
}
async function snippetsPage(page, ctx) {
  const life = dataLife(page, ctx), data = await life.load(FlowBridge.snippets);
  if (!life.alive() || !data) return;
  let snippets = data, editing = null;
  const save = (apply) => life.change(apply, () => FlowBridge.setSnippets(snippets), async () => {
    snippets = await FlowBridge.snippets();
  }, draw);
  page.append(ctx.hero("snippets", t("Snippets"), null));
  const formTitle = h("div", { style: "font:700 14px var(--font)" });
  const trigger = life.live(input("Cuando digo"));
  const text = life.live(h("textarea", { class: "hub-textarea", placeholder: "Pegá esto" }));
  const cancel = life.live(button(t("Cancel"), () => edit(null, false)));
  const saveButton = life.live(button(t("Save"), () => {
    const tr = trigger.value.trim(), tx = text.value;
    if (!tr || !tx.trim() || !bounded(tr, 80) || !bounded(tx, 4e3) || !editing && snippets.length >= 200 || snippets.some((s) => s.id !== editing?.id && s.trigger === tr)) return life.hint();
    save(() => {
      snippets = editing ? snippets.map((s) => s.id === editing.id ? { ...s, trigger: tr, text: tx } : s) : [...snippets, { id: newId(), trigger: tr, text: tx }];
      edit(null, false);
    });
  }, "primary"));
  const form = card(formTitle, h("div", { class: "hub-row" }, trigger), text, h("div", { class: "hub-row", style: "justify-content:flex-end" }, cancel, saveButton));
  form.hidden = true;
  trigger.style.flex = "1";
  const edit = (s, open = true) => {
    editing = s;
    formTitle.textContent = s ? t("Edit the snippet") : t("New snippet");
    trigger.value = s?.trigger ?? "";
    text.value = s?.text ?? "";
    form.hidden = !open;
  };
  const create = life.live(button("Nuevo fragmento", () => {
    edit(null, true);
    trigger.focus();
  }, "primary"));
  page.append(h("div", { class: "hub-row" }, label(t("Snippets")), infoTip(t("Say the trigger while dictating: Koda pastes the whole text in its place.") + " Ej.: tu firma o tu dirección.", "Más información: Fragmentos"), h("span", { class: "spacer", style: "flex:1" }), create), form);
  const list = h("div", {});
  page.append(card(list));
  function draw() {
    clear(list);
    if (!snippets.length) {
      list.append(emptyState("Todavía no hay fragmentos."));
      return;
    }
    for (const s of snippets) list.append(h(
      "div",
      { class: "hub-list-row" },
      h("div", { class: "grow" }, h("div", { style: "font:600 13.5px var(--font)", text: `« ${s.trigger} »` }), h("div", { class: "hub-snippet-text", text: s.text.length > 80 ? s.text.slice(0, 79) + "…" : s.text })),
      life.live(iconButton("pencil", t("Edit"), () => {
        edit(s);
        trigger.focus();
      })),
      life.live(iconButton("trash", t("Delete"), () => save(() => {
        snippets = snippets.filter((x) => x.id !== s.id);
      })))
    ));
  }
  draw();
}
const styleOptions = () => [["verbatim", t("As said")], ["natural", t("Natural")], ["polished", t("Polished")]];
async function stylesPage(page, ctx) {
  const life = dataLife(page, ctx), status = await life.load(() => ctx.refresh()), data = await life.load(FlowBridge.styles);
  if (!life.alive() || !status || !data) return;
  let styles = data;
  const valid = (s) => s.length <= 100 && s.every((x) => bounded(x.id, 80) && bounded(x.name, 80) && styleOptions().some(([v]) => v === x.style));
  const save = (next) => {
    if (!valid(next)) return life.hint();
    life.change(() => {
      styles = next;
    }, () => FlowBridge.setStyles(styles), async () => {
      styles = await FlowBridge.styles();
    }, drawApps);
  };
  page.append(ctx.hero("styles", t("Styles"), null));
  const perApp = h("div", {});
  const drawApps = () => {
    clear(perApp);
    perApp.classList.toggle("dimmed", status.prefs.cleanup !== true);
    styles.forEach((s, i) => {
      if (i) perApp.append(divider());
      perApp.append(row(
        s.name,
        null,
        life.live(select(styleOptions(), s.style, (style) => save(styles.map((x) => x.id === s.id ? { ...x, style } : x)))),
        life.live(iconButton("x", t("Delete"), () => save(styles.filter((x) => x.id !== s.id))))
      ));
    });
  };
  const keyNote = h("div", { class: "hub-warn", text: "Falta clave de Claude." });
  const toChat = life.live(button("Ir a Chat", () => ctx.navigate("chat"), "", true));
  keyNote.append(toChat);
  const hasKey = status.hasClaudeKey === true;
  keyNote.hidden = hasKey;
  const cleanup = life.live(toggle(status.prefs.cleanup === true, (on) => life.change(() => {
  }, () => ctx.setPrefs((p) => {
    p.cleanup = on;
  }), async () => {
    const next = await ctx.refresh();
    if (life.alive()) {
      cleanup.classList.toggle("on", next.prefs.cleanup === true);
      cleanup.setAttribute("aria-pressed", String(next.prefs.cleanup === true));
      perApp.classList.toggle("dimmed", next.prefs.cleanup !== true);
    }
  }, () => {
  }, () => {
    cleanup.classList.toggle("on", ctx.status.prefs.cleanup === true);
    cleanup.setAttribute("aria-pressed", String(ctx.status.prefs.cleanup === true));
  })));
  if (!hasKey) {
    cleanup.disabled = true;
    cleanup.title = "Falta la clave de Claude: guárdala en Notch → Chat";
  }
  const defaultSelect = life.live(select(styleOptions(), status.prefs.defaultStyle, (style) => life.change(() => {
  }, () => ctx.setPrefs((p) => {
    p.defaultStyle = style;
  }), async () => {
    const next = await ctx.refresh();
    if (life.alive()) defaultSelect.value = next.prefs.defaultStyle;
  }, () => {
  }, () => {
    defaultSelect.value = ctx.status.prefs.defaultStyle;
  })));
  page.append(card(
    row(t("Clean up with Claude"), null, cleanup, infoTip(t("Removes the “um”, the repeats and the corrections you made while speaking, and fixes the punctuation.") + " " + t("Claude cleans up what you say, in the style of the app you write in."), "Más información: Limpiar con Claude")),
    keyNote,
    divider(),
    row(t("Other apps"), null, defaultSelect),
    h("div", { class: "hub-note", text: "Envía texto a Anthropic." })
  ));
  const add = life.live(h("select", { class: "hub-select" }, h("option", { value: "", text: `+ ${t("Add an app")}` })));
  const fillAdd = async () => {
    const running = (await life.load(FlowBridge.runningApps) ?? []).filter((a) => !styles.some((s) => s.id === a.id)).slice(0, 64);
    clear(add);
    add.append(h("option", { value: "", text: `+ ${t("Add an app")}` }));
    if (!running.length) add.append(h("option", { value: "-", text: t("No other open app"), disabled: true }));
    for (const a of running) add.append(h("option", { value: `${a.id}
${a.name}`, text: a.name }));
    add.value = "";
  };
  add.addEventListener("focus", () => {
    void fillAdd();
  });
  add.addEventListener("change", () => {
    const [id, name] = add.value.split("\n");
    if (!id || id === "-") return;
    save([...styles, { id, name: name ?? id, style: status.prefs.defaultStyle }]);
    void fillAdd();
  });
  page.append(h("div", { class: "hub-row" }, label("Excepciones por app"), h("span", { class: "spacer", style: "flex:1" }), add), card(perApp));
  drawApps();
}
async function insightsPage(page, ctx) {
  const life = dataLife(page, ctx), stats = await life.load(FlowBridge.stats);
  if (!life.alive() || !stats) return;
  let period = "month";
  const body = h("div", { style: "display:flex;flex-direction:column;gap:14px" });
  const picker = life.live(segmented([["week", t("Week")], ["month", t("Month")], ["all", t("All")]], period, (p) => {
    period = p;
    draw();
  }));
  page.append(ctx.hero("insights", t("Statistics"), null, [picker]), body);
  const stat = (text, value, sub, tip) => h("div", { class: "hub-stat" }, h("div", { class: "label" }, h("span", { text }), ...tip ? [infoTip(tip, `Más información: ${text}`)] : []), h("b", { text: value }), ...sub ? [h("div", { class: "sub", text: sub })] : []);
  function draw() {
    clear(body);
    const totals = stats[period], m = Math.round(totals.minutesSaved), duration = m >= 60 ? t("{0} h {1}", { 0: Math.floor(m / 60), 1: String(m % 60).padStart(2, "0") }) : t("{0} min", { 0: m });
    body.append(h("div", { class: "hub-stat-row" }, stat(t("Words dictated"), shortCount(totals.words), null), stat(t("Time saved"), duration, null, "Comparado con escribir a 45 palabras por minuto."), stat(t("Speed"), number(totals.wordsPerMinute), t("words/min")), stat(t("Dictations"), number(totals.dictations), null)));
    const days = stats.daily.slice(period === "week" ? -7 : -30), max = Math.max(1, ...days.map(([, w]) => w));
    const bars = h("div", { class: "hub-bars" }), axis = h("div", { class: "hub-axis" });
    for (const [key, words] of days) bars.append(h("i", { class: words === 0 ? "zero" : "", title: `${key} · ${number(words)}`, style: `height:${Math.max(words === 0 ? 0 : 3, words / max * 100)}%` }));
    days.forEach(([key], i) => {
      if (i % (period === "week" ? 1 : 5) === 0 || i === days.length - 1) axis.append(h("span", { text: String(Number(key.split("-")[2])) }));
    });
    const chart = h("div", { class: "hub-card" }, h("div", { class: "title", style: "font:700 14px var(--font)", text: t("Words per day") }), bars, axis);
    const apps = Object.entries(stats.apps).sort((a, b) => b[1] - a[1]).slice(0, 8), total = apps.reduce((s, [, w]) => s + w, 0);
    const appsCard = h("div", { class: "hub-card" }, h("div", { class: "title", style: "font:700 14px var(--font)", text: "Dónde dictás · acumulado" }));
    if (!apps.length) appsCard.append(emptyState(t("Dictate in an app and it shows here.")));
    else for (const [name, words] of apps) {
      const share = total > 0 ? words / total : 0;
      appsCard.append(h("div", { class: "hub-app-bar" }, h("div", { class: "top" }, h("b", { text: name, style: "font-weight:500" }), h("span", { text: `${Math.round(share * 100)} %` })), h("div", { class: "track" }, h("i", { style: `width:${Math.max(2, share * 100)}%` }))));
    }
    body.append(h("div", { class: "hub-chart-row" }, chart, appsCard), h("div", { class: "hub-row" }, infoTip(t("Counted on this computer, never sent anywhere.") + " «Todo» muestra hasta 30 días.", "Más información: Estadísticas")));
  }
  draw();
}
export {
  dataLife,
  dictionaryPage,
  insightsPage,
  snippetsPage,
  styleOptions,
  stylesPage
};
