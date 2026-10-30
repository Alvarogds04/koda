// Adapted from Coucou windows/src/views/usage.ts @434d6a2b — Copyright (c) 2026 Louis Raillé, MIT.
var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
import {
  PLAN_TEXT,
  claudeSubtitle,
  codexResetsLabel,
  codexSubtitle,
  dominantPct,
  effectivePct,
  pillLabel,
  planColor,
  resetLabel
} from "../core/plan.js";
import { clear, dot, h, svg } from "./dom.js";
import { ICONS } from "./icons.js";
import { language, tl } from "../i18n/i18n.js";
const newPlanModel = () => ({
  planUsage: null,
  codexPlanUsage: null,
  showingPlanDetail: false,
  planDetailIsCodex: false
});
const claudeColor = (m, now = Date.now()) => planColor(dominantPct(m.planUsage, now));
const codexColor = (m, now = Date.now()) => planColor(dominantPct(m.codexPlanUsage, now));
function openPlanColor(m) {
  return m.planDetailIsCodex ? codexColor(m) : claudeColor(m);
}
function buildPlanPill(m, codex, onToggle) {
  const label = h("span", { class: "plan-pill-label" });
  const dotEl = h("i", { class: "plan-pill-dot" });
  const isOpen = () => m.showingPlanDetail && m.planDetailIsCodex === codex;
  const el = h("button", {
    class: "plan-pill",
    title: codex ? tl("Codex plan usage") : tl("Claude plan usage"),
    onclick: () => {
      const open = isOpen();
      m.planDetailIsCodex = codex;
      m.showingPlanDetail = !open;
      onToggle();
    }
  }, dotEl, label);
  return {
    el,
    sync() {
      const color = codex ? codexColor(m) : claudeColor(m);
      el.style.setProperty("--plan", color);
      el.classList.toggle("active", isOpen());
      dotEl.style.background = color;
      label.textContent = codex ? pillLabel("Codex", m.codexPlanUsage) : pillLabel("Claude", m.planUsage);
    }
  };
}
function gaugeRow(label, w, weekly, now) {
  const row = h("div", { class: "plan-row" }, h("span", { class: "plan-label", text: label }));
  if (!w) {
    row.append(h("span", { class: "plan-none", text: PLAN_TEXT.none }));
    return row;
  }
  const pct = effectivePct(w, now);
  const fill = h("i", { class: "plan-fill" });
  fill.style.width = `${pct}%`;
  fill.style.background = planColor(pct);
  row.append(
    h("span", { class: "plan-bar" }, fill),
    h("span", { class: "plan-pct", text: `${Math.round(pct)}%` }),
    h("span", { class: "plan-reset-icon" }, svg(ICONS.arrowClockwise, 8, { stroke: 2.6 })),
    h("span", { class: "plan-reset", text: resetLabel(w, weekly, now) })
  );
  return row;
}
function head(color, title, subtitle) {
  return h(
    "div",
    { class: "plan-head" },
    dot(color, 7),
    h("span", { class: "plan-title", text: title }),
    h("span", { class: "plan-sub", text: subtitle })
  );
}
class PlanCard {
  constructor(m) {
    __publicField(this, "m", m);
    __publicField(this, "el", h("div", { class: "plan-card" }));
    __publicField(this, "key", "");
  }
  /** Re-renders when the numbers change, or every 30 s for the countdowns. */
  sync(now = Date.now()) {
    const codex = this.m.planDetailIsCodex;
    const u = codex ? this.m.codexPlanUsage : this.m.planUsage;
    const key = `${language()}|${codex}|${JSON.stringify(u)}|${Math.floor(now / 3e4)}`;
    if (key === this.key) return;
    this.key = key;
    clear(this.el);
    if (codex) this.drawCodex(this.m.codexPlanUsage, now);
    else this.drawClaude(this.m.planUsage, now);
  }
  drawClaude(u, now) {
    this.el.append(
      head(claudeColor(this.m, now), PLAN_TEXT.claudeTitle, claudeSubtitle(u, now)),
      h(
        "div",
        { class: "plan-rows" },
        gaugeRow(PLAN_TEXT.fiveHours, u?.fiveHour, false, now),
        gaugeRow(PLAN_TEXT.week, u?.sevenDay, true, now)
      )
    );
  }
  drawCodex(u, now) {
    const rows = h("div", { class: "plan-rows" });
    if (u?.fiveHour) rows.append(gaugeRow(PLAN_TEXT.fiveHours, u.fiveHour, false, now));
    rows.append(
      gaugeRow(PLAN_TEXT.week, u?.sevenDay, true, now),
      h(
        "div",
        { class: "plan-row" },
        h("span", { class: "plan-label", text: PLAN_TEXT.resets }),
        h("span", { class: "plan-credits", text: codexResetsLabel(u) })
      )
    );
    this.el.append(head(codexColor(this.m, now), PLAN_TEXT.codexTitle, codexSubtitle(u, now)), rows);
  }
}
export {
  PlanCard,
  buildPlanPill,
  newPlanModel,
  openPlanColor
};
