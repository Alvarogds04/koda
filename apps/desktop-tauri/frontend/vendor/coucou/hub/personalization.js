// Abito-owned migration of settings.js/runIntent and pill-settings.js, using literal MIT hub controls.
import { h, clear } from "../views/dom.js";
import { pillDefinition } from "../core/pills.js";
import { t } from "./i18n-es.js";
import { notchSection, notchRow, notchTipRow, notchTipSection, infoTip } from "./notch.js";
import { row, select, toggle } from "./ui.js";
import { action, note, section, trusted, session, preserveFocus } from "./runtime.js";
function colors(V, A, prefs, identities, save) {
  const rows = [];
  for (const r of V.colorRows(prefs, identities, A)) {
    const options = h("div", { class: "palette", role: "group", "aria-label": `Color de ${r.name}` });
    options.className = "hub-segmented";
    for (const hex of A.HEX_PALETTE) {
      const o = { color: hex, label: A.label(hex), aria: `${r.name}: ${A.label(hex)}`, selected: A.normalizeChosenColor(r.color) === hex };
      const b = action(o.label, () => save({ action: "set_avatar_color", identity: r.id, color: o.color }));
      b.className = o.selected ? "swatch on" : "swatch";
      b.textContent = "";
      b.title = o.label;
      b.setAttribute("id", `identity-${r.id}-${o.color}`);
      b.setAttribute("aria-label", o.aria);
      b.setAttribute("aria-pressed", String(o.selected));
      b.style.setProperty("background", hex);
      options.append(b);
    }
    rows.push(row(r.name, r.label, options));
  }
  return section("Colores de identidad", ...rows);
}
async function renderAppearance({ invoke, listen, V, S, A }) {
  const s = session(invoke, listen), { root, call, work, watch, message } = s;
  let prefs = {}, store = null;
  let queue = Promise.resolve();
  const save = (p) => work(() => {
    queue = queue.catch(() => {
    }).then(() => call("prefs_action", p));
    return queue;
  }, (next) => {
    prefs = next;
    message.textContent = "Guardado.";
    paint();
  });
  function paint() {
    const restore = preserveFocus(root);
    clear(root);
    const theme = V.themeView(prefs), pick = trusted(select(theme.options.map((o) => [o.id, o.label]), theme.mode, (value) => save({ action: "set_theme", theme: value })));
    pick.setAttribute("id", "appearance-theme");
    pick.setAttribute("aria-label", "Tema");
    root.append(section("Tema", row("Tema", null, pick)), colors(V, A, prefs, [{ id: A.PRINCIPAL_ID, name: "Koda" }, ...S.identityView(store).identities], save), section("Movimiento", row("Animación reducida", "No disponible en esta ventana")), message);
    if (S.identityView(store).kind !== "ready") root.append(note("Colores de especialistas no disponibles: no se pudieron cargar sus identidades."));
    restore();
  }
  paint();
  watch("prefs:state", (p) => {
    prefs = p;
    paint();
  });
  watch("specialists:state", (p) => {
    store = p;
    paint();
  });
  work(() => call("prefs_action", { action: "view" }), (p) => {
    prefs = p;
    paint();
  });
  work(() => call("specialists_action", { action: "view" }), (p) => {
    store = p;
    paint();
  });
  return s.finish();
}
async function renderPills({ invoke, listen, V, S, A, P, C, part = "tools" }) {
  const s = session(invoke, listen), { root, call, work, watch, message } = s;
  if (part === "tools") {
    return s.finish();
  }
  let prefs = {}, store = null, saving = false;
  const listing = null;
  let lastKey = "";
  const owned = () => S.storeView(store, listing);
  const agents = () => S.agentsView(store, prefs, A);
  const prefsCall = async (p) => {
    const next = await call("prefs_action", p);
    if (s.alive()) prefs = next;
  };
  function run(i) {
    if (saving || owned().kind !== "ready") return;
    let plan = null;
    switch (i.type) {
      case "set_color":
        plan = () => prefsCall({ action: "set_avatar_color", identity: i.id, color: i.color });
        break;
      case "island_toggle": {
        const cmd = P.islandToggleCommand(P.islandModel(prefs, agents(), void 0), i.kind, i.id);
        if (!cmd) return;
        plan = () => prefsCall(cmd);
        break;
      }
      case "set_abito_instructions":
        plan = () => prefsCall({ action: "set_abito_instructions", text: String(i.text) });
        break;
      case "prefs":
        plan = () => prefsCall(i.payload);
        break;
      default:
        return;
    }
    saving = true;
    for (const b of root.querySelectorAll("button")) b.disabled = true;
    work(plan, () => {
      message.textContent = "Guardado.";
    }).finally(() => {
      saving = false;
      lastKey = "";
      if (s.alive()) paint();
    });
  }
  const principalInstructions = h("textarea", { id: "abito-instructions", class: "hub-input", "aria-label": "Instrucciones de Koda" });
  let instructionsDraft = false;
  principalInstructions.addEventListener("input", (e) => {
    if (e.isTrusted) instructionsDraft = true;
  });
  function paint() {
    const key = JSON.stringify([prefs.avatarColors, prefs.pillColors, prefs.declaredPills, prefs.mainPill, prefs.islandAgents, prefs.abitoInstructions, store, saving]);
    if (key === lastKey) return;
    lastKey = key;
    const restore = preserveFocus(root);
    clear(root);
    if (part === "tools") {
      const cur = P.normalize(prefs), choices = C.mainChoices();
      const options = choices.map((d) => [d.id, pillDefinition(d.id)?.name || d.name]);
      if (!options.some(([id]) => id === cur.mainPill)) options.push([cur.mainPill, pillDefinition(cur.mainPill)?.name || cur.mainPill]);
      const main = trusted(select(options, cur.mainPill, (id) => {
        if (P.chooseMain(cur, id)) run({ type: "prefs", payload: { action: "set_main_pill", id } });
      }));
      main.className = "";
      main.disabled = saving;
      main.setAttribute("aria-label", "Herramienta principal");
      root.append(notchSection(t("Main tool"), notchTipRow(t("Main tool"), "Aparece primero en la isla; no instala nada.", main)));
    }
    if (part === "island") {
      const m = P.islandModel(prefs, agents());
      const spec = notchTipSection("Especialistas", "Los especialistas se definen en el código de Koda. Elegí cuáles se ven en la isla (hasta " + m.specialistsMax + ").");
      const base = owned();
      if (base.kind !== "ready") spec.append(note(base.persistenceNote || "Leyendo especialistas…"));
      else {
        spec.append(h("div", { class: "hint", role: "status", text: `Especialistas ${m.specialistsOn}/${m.specialistsMax}` }));
        for (const e of m.specialists) {
          const sw = trusted(toggle(e.on, () => run({ type: "island_toggle", kind: "specialist", id: e.id })));
          sw.disabled = saving || !e.on && m.specialistsFull;
          sw.setAttribute("aria-label", `En la isla: ${e.name}`);
          sw.setAttribute("aria-pressed", String(e.on));
          spec.append(notchRow(e.name, sw));
        }
      }
      root.append(spec);
    }
    if (part === "abito") {
      if (!instructionsDraft) principalInstructions.value = prefs.abitoInstructions || "";
      principalInstructions.maxLength = S.MAX_INSTRUCTIONS;
      root.append(
        section("Koda", row("Instrucciones", null, infoTip("Se aplican a los próximos mensajes del chat de Koda.", "Más información: Instrucciones"), principalInstructions, action("Guardar instrucciones", () => {
          run({ type: "set_abito_instructions", text: principalInstructions.value });
        }))),
        colors(V, A, prefs, [{ id: A.PRINCIPAL_ID, name: "Koda" }, ...S.identityView(store).identities], (p) => run({ type: "prefs", payload: p }))
      );
    }
    root.append(message);
    restore();
  }
  paint();
  watch("prefs:state", (p) => {
    prefs = p;
    paint();
  });
  watch("specialists:state", (p) => {
    store = p;
    paint();
  });
  work(() => call("prefs_action", { action: "view" }), (p) => {
    prefs = p;
    paint();
  });
  work(() => call("specialists_action", { action: "view" }), (p) => {
    store = p;
    paint();
  });
  return s.finish();
}
export {
  renderAppearance,
  renderPills
};
