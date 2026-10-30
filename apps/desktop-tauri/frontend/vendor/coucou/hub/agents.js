// Adapted from Coucou src/settings/{main,agents}.ts @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT.
import { h, clear } from "../views/dom.js";
import { statusDot } from "../settings/parts.js";
import { toggle } from "./ui.js";
import { notchSection as section, notchTipRow as row, notchHint as hint, infoTip, notchTipSection } from "./notch.js";
import { session, trusted } from "./runtime.js";
import { piInstallControl } from "./piinstall.js";
import { t } from "./i18n-es.js";
const UNAVAILABLE = "No disponible todavía";
const NOT_IN_VERSION = "No disponible en esta versión";
const CLI_AGENTS = [["claude-code", "Claude Code"], ["codex", "Codex"], ["gemini-cli", "Gemini CLI"]];
const OTHER_AGENTS = [["copilot-cli", "GitHub Copilot CLI"], ["opencode", "OpenCode"]];
const flex = (gap) => h("div", { style: `display:flex;flex-direction:column;gap:${gap}px` });
const unknownDot = () => {
  const n = statusDot(false);
  n.style.setProperty("background", "#6b7079");
  n.title = UNAVAILABLE;
  return n;
};
const button = (key, fn, kind = "", disabled = false) => {
  const b = trusted(h("button", { class: kind, text: t(key), onclick: fn }));
  b.disabled = disabled;
  if (disabled) b.title = UNAVAILABLE;
  return b;
};
const AGENT_PILL = {
  "claude-code": "integration_claude",
  codex: "agent_codex",
  "copilot-cli": "agent_copilot",
  muse: "agent_muse",
  "gemini-cli": "agent_gemini",
  antigravity: "agent_antigravity",
  cursor: "agent_cursor",
  opencode: "agent_opencode",
  amp: "agent_amp",
  hermes: "agent_hermes"
};
const TONE_ICON = { go: "✓", red: "✗", sun: "!", faint: "○", live: "…" };
async function renderAgentSettings({ invoke, V, P, listen, timers }) {
  const s = session(invoke, listen, timers), { root, call, work, watch } = s;
  root.style.setProperty("display", "contents");
  s.message.className = "abito-settings-feedback notice err";
  let state = null, reviewing = false, busy = false;
  const actionStatus = h("div", { id: "agent-action-status", class: "hint", role: "status", "aria-live": "polite" });
  const piControl = piInstallControl({ call, watch, work, onDone: () => work(() => call("agent_action", { action: "view" }), (next) => {
    state = { ...state, ...next };
    paint();
  }) });
  let prefs = {}, prefsKnown = false;
  function applyNow(cell, r, label) {
    if (busy || !r?.primary?.command?.plan_hash || !r.summary || !r.reviewable) return;
    const command = { ...r.primary.command };
    busy = true;
    actionStatus.textContent = "";
    clear(cell);
    cell.append(h(
      "span",
      { class: "agent-progress", role: "status" },
      h("span", { class: "hub-progress indeterminate", "aria-hidden": "true" }, h("i")),
      h("span", { class: "hub-note", text: label })
    ));
    work(
      () => call("agent_action", command),
      (next) => {
        state = { ...state, ...next };
      },
      () => {
        actionStatus.textContent = V.agentActionFailure(r.id);
      }
    ).finally(() => {
      busy = false;
      if (s.alive()) paint();
    });
  }
  function reviewChange(body, r, install, redraw) {
    if (busy || !r || install && (!r.primary?.command?.plan_hash || !r.summary || !r.reviewable)) return;
    const command = install ? { ...r.primary.command } : r.secondary?.command;
    if (!command) return;
    reviewing = true;
    clear(body);
    body.append(
      hint("Vista previa de Koda: resumen del plan; el backend no expone el diff ni la ruta de respaldo."),
      h("pre", { class: "diff", text: install ? r.summary : "Se quitarán los hooks administrados por Koda." })
    );
    const confirm = button(install ? "Back up and write" : "Back up and remove", () => {
      if (busy) return;
      busy = true;
      confirm.disabled = true;
      actionStatus.textContent = "";
      work(() => call("agent_action", command), (next) => {
        state = { ...state, ...next };
        reviewing = false;
      }, () => {
        actionStatus.textContent = V.agentActionFailure(r.id);
      }).finally(() => {
        busy = false;
        reviewing = false;
        if (s.alive()) paint();
      });
    }, install ? "primary" : "danger");
    body.append(h("div", { class: "row" }, confirm, button("Cancel", () => {
      reviewing = false;
      redraw();
    })));
  }
  function integrationBlock(id, name, tip) {
    const r = V.agentsView(state, { timedOut: true }).rows?.find((a) => a.id === id);
    const installed = r?.state === "connected" || r?.state === "outdated";
    const dot = !r || r.state === "unknown" ? unknownDot() : statusDot(installed);
    const body = flex(10), head = h("div", { class: "row" });
    const block = flex(8);
    block.setAttribute("id", `agent-integration-${id}`);
    block.append(head, body);
    const installable = !!r?.primary?.command?.plan_hash && !!r?.summary && r?.reviewable && !busy;
    const install = button(installed ? "Reinstall…" : "Install…", () => reviewChange(body, r, true, () => paint()), "primary", !installable);
    const remove = r?.secondary ? button("Uninstall…", () => reviewChange(body, r, false, () => paint()), "danger", busy) : null;
    head.append(
      h("div", { style: "display:flex;align-items:center;gap:8px;min-width:132px" }, dot, h("span", { style: "font-size:12.5px", text: name }), infoTip(tip, `Más información: ${name}`)),
      h("span", { class: "spacer" }),
      install
    );
    if (remove) head.append(remove);
    if (r?.helpUrl) body.append(h("p", { class: "hint", style: "user-select:text;overflow-wrap:anywhere", text: `README · ${r.helpUrl}` }));
    if (r?.note && r.state !== "error") body.append(hint(r.note));
    return block;
  }
  const stateCell = (icon, word) => h("span", { class: "agent-state", role: "cell" }, h("span", { class: "state-ico", "aria-hidden": "true", text: icon }), h("span", { class: "state-word", text: word }));
  function islandSwitch(id, installed) {
    if (id === "pi") {
      const sw2 = trusted(toggle(installed, () => {
      }));
      sw2.disabled = true;
      sw2.setAttribute("aria-label", "En la isla: Pi");
      sw2.setAttribute("aria-pressed", String(installed));
      sw2.setAttribute("title", installed ? "Extensión instalada en la carpeta predeterminada." : "Instalá la extensión de Pi primero.");
      return h("span", { class: "agent-island", role: "cell" }, sw2);
    }
    const pill = AGENT_PILL[id], cur = P && prefsKnown ? P.normalize(prefs) : null;
    const isMain = !!cur && cur.mainPill === pill, on = installed && (isMain || !!cur?.declaredPills.includes(pill));
    const sw = trusted(toggle(on, () => {
      if (installed && cur && pill && !isMain && P.toggle(P.normalize(prefs), pill)) work(() => call("prefs_action", { action: "toggle_declared_pill", id: pill }), (next) => {
        prefs = next;
        paint();
      }, () => paint());
    }));
    sw.setAttribute("aria-label", `En la isla: ${id}`);
    sw.setAttribute("aria-pressed", String(on));
    sw.disabled = !installed || !cur || !pill || isMain;
    if (!installed) sw.setAttribute("title", "Instalá los hooks de este agente primero.");
    else if (isMain) sw.setAttribute("title", "Es la píldora principal de la isla.");
    else if (!cur || !pill) sw.setAttribute("title", UNAVAILABLE);
    return h("span", { class: "agent-island", role: "cell" }, sw);
  }
  function agentRow(id, name) {
    const r = V.agentsView(state, { timedOut: true }).rows?.find((a) => a.id === id);
    const installed = r?.state === "connected" || r?.state === "outdated";
    const unknown = !r || r.state === "unknown";
    const detail = flex(10), actions = h("span", { class: "agent-actions", role: "cell" }), menu = h("div", { class: "agent-menu", role: "group" });
    let open = false;
    const entry = h("div", { class: "agent-entry", id: `agent-row-${id}` });
    const line = h(
      "div",
      { class: "agent-row", role: "row" },
      h("span", { class: "agent-name", role: "cell", text: name }),
      !r || unknown && !["node_missing", "failed"].includes(state?.agentsRuntime) ? stateCell("·", UNAVAILABLE) : stateCell(TONE_ICON[r.tone] || "○", r.word),
      islandSwitch(id, installed),
      actions
    );
    entry.append(line, menu, detail);
    if (id === "pi") {
      piControl.update(state);
      entry.append(piControl.element);
    }
    const redraw = () => {
      clear(actions);
      clear(menu);
      clear(detail);
      const installable = !!r?.primary?.command?.plan_hash && !!r?.summary && r?.reviewable && !busy;
      const outdated = r?.state === "outdated";
      const install = button(outdated ? "Update…" : installed ? "Reinstall…" : "Install…", () => {
        open = false;
        applyNow(actions, r, outdated || installed ? "Actualizando…" : "Instalando…");
      }, installed && !outdated ? "" : "primary", !installable);
      const remove = r?.secondary ? button("Uninstall…", () => reviewChange(detail, r, false, redraw), "danger", busy) : null;
      if (installed || remove) {
        const more = trusted(h("button", { class: "agent-more", text: "⋮", onclick: () => {
          open = !open;
          redraw();
        } }));
        more.type = "button";
        more.setAttribute("aria-label", `Más opciones de ${name}`);
        more.setAttribute("aria-haspopup", "true");
        more.setAttribute("aria-expanded", String(open));
        if (outdated) actions.append(install);
        actions.append(more);
        if (open) {
          if (!outdated) menu.append(install);
          if (remove) menu.append(remove);
        }
      } else if (!unknown) actions.append(install);
      if (r?.note && r.state !== "error") detail.append(hint(r.note));
      if (r?.helpUrl) detail.append(h("p", { class: "hint", style: "user-select:text;overflow-wrap:anywhere", text: `README · ${r.helpUrl}` }));
    };
    redraw();
    return entry;
  }
  function unavailableRow(id, name) {
    const sw = trusted(toggle(false, () => {
    }));
    sw.disabled = true;
    sw.setAttribute("aria-label", `En la isla: ${name}`);
    sw.setAttribute("title", NOT_IN_VERSION);
    return h("div", { class: "agent-entry agent-off", id: `agent-row-${id}`, "aria-disabled": "true" }, h(
      "div",
      { class: "agent-row", role: "row" },
      h("span", { class: "agent-name", role: "cell", text: name }),
      stateCell("·", NOT_IN_VERSION),
      h("span", { class: "agent-island", role: "cell" }, sw),
      h("span", { class: "agent-actions", role: "cell" })
    ));
  }
  function piRow() {
    return agentRow("pi", "Pi");
  }
  function paint() {
    if (reviewing) return;
    clear(root);
    const list = flex(0);
    list.setAttribute("id", "agent-hook-list");
    list.append(piRow());
    for (const [id, name] of CLI_AGENTS) list.append(agentRow(id, name));
    for (const [id, name] of OTHER_AGENTS) list.append(["copilot-cli", "opencode"].includes(id) ? agentRow(id, name) : unavailableRow(id, name));
    const header = h(
      "div",
      { class: "agent-row agent-head", role: "row" },
      ...["Agente", "Estado", "En isla", "Acciones"].map((c) => h("span", { role: "columnheader", text: c }))
    );
    const table = h("div", { class: "agent-table", role: "table", "aria-label": "Agentes" }, header, list);
    const planSwitch = trusted(toggle(prefs.showPlanInNotch === true, (value) => {
      work(() => call("prefs_action", { action: "set_show_plan_in_notch", show_plan_in_notch: value }), (next) => {
        prefs = next;
        prefsKnown = true;
        paint();
      }, () => paint());
    }));
    planSwitch.disabled = !prefsKnown;
    const planTip = "Muestra en la isla el uso de tu plan de Claude (límite de 5 horas y semanal). Koda agrega un relay a la línea de estado de ~/.claude/settings.json; si ya tenías una, sigue funcionando. Solo planes Pro y Max. Los datos vienen de Claude Code en la terminal, no de la app de escritorio.";
    const plan = flex(12);
    plan.append(row("Claude Code · uso del plan", planTip, planSwitch), integrationBlock("statusline", "Relay", "Lee el uso del plan; tu línea de estado sigue igual."));
    root.append(
      notchTipSection(t("Agents"), "Koda agrega sus entradas a la configuración de cada agente. Desinstalar quita solo lo que Koda agregó; antes se guarda un respaldo.", table, actionStatus),
      section(t("Plan usage"), plan),
      section(t("Weekly recap"), integrationBlock("recap", t("Weekly recap"), "Cuenta tu actividad de Claude Code; nunca guarda comandos ni prompts.")),
      s.message
    );
  }
  const apply = (next) => {
    state = { ...state, ...next };
    paint();
  };
  paint();
  watch("agent:state", apply);
  watch("prefs:state", (next) => {
    prefs = next;
    prefsKnown = true;
    paint();
  });
  work(() => call("prefs_action", { action: "view" }), (next) => {
    prefs = next;
    prefsKnown = true;
    paint();
  });
  for (const action of ["view", "agents_list", "hooks_preview"]) work(() => call("agent_action", { action }), apply);
  return s.finish();
}
export {
  renderAgentSettings
};
