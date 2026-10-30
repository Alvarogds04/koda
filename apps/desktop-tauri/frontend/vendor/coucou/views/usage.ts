// Adapted from Coucou windows/src/views/usage.ts @434d6a2b — Copyright (c) 2026 Louis Raillé, MIT.
// Plan usage in the island: the Claude and Codex pills in the header and the card behind each (ClaudePlanHeaderPill,
// ClaudePlanCardView, CodexPlanCardView on the Mac). The DOM, the classes and every label are Coucou's.
// Adapted for Abito: the module-level `State` singleton and `Bridge` of Coucou are replaced by a plain model the
// host (frontend/island-plan.js) owns and an injected `askCodex`; the numbers come from Abito's `plan_action`,
// never from here. A missing number is "—", never a guess.

import {
  PLAN_TEXT, claudeSubtitle, codexResetsLabel, codexSubtitle, dominantPct,
  effectivePct, pillLabel, planColor, resetLabel,
  type CodexPlanUsage, type PlanUsage, type PlanWindow,
} from "../core/plan.js";
import { clear, dot, h, svg } from "./dom.js";
import { ICONS } from "./icons.js";
import { language, tl } from "../i18n/i18n.js";

/** What the pills and the card read; the host mutates it and calls `sync`. */
export interface PlanModel {
  planUsage: PlanUsage | null;
  codexPlanUsage: CodexPlanUsage | null;
  showingPlanDetail: boolean;
  /** Which plan the open card shows. */
  planDetailIsCodex: boolean;
}

export const newPlanModel = (): PlanModel => ({
  planUsage: null, codexPlanUsage: null, showingPlanDetail: false, planDetailIsCodex: false,
});

const claudeColor = (m: PlanModel, now = Date.now()) => planColor(dominantPct(m.planUsage, now));
const codexColor = (m: PlanModel, now = Date.now()) => planColor(dominantPct(m.codexPlanUsage, now));

/** The colour of the open card's plan. */
export function openPlanColor(m: PlanModel): string {
  return m.planDetailIsCodex ? codexColor(m) : claudeColor(m);
}

// ── Pill ──────────────────────────────────────────────────────────────────────

export interface PlanPill {
  el: HTMLElement;
  sync(): void;
}

/** One pill: colour dot and label, lit while hovered or while its card is open. `onToggle` runs after the model changed. */
export function buildPlanPill(m: PlanModel, codex: boolean, onToggle: () => void): PlanPill {
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
    },
  }, dotEl, label);
  return {
    el,
    sync() {
      const color = codex ? codexColor(m) : claudeColor(m);
      el.style.setProperty("--plan", color);
      el.classList.toggle("active", isOpen());
      dotEl.style.background = color;
      label.textContent = codex ? pillLabel("Codex", m.codexPlanUsage) : pillLabel("Claude", m.planUsage);
    },
  };
}

// ── Card ──────────────────────────────────────────────────────────────────────

function gaugeRow(label: string, w: PlanWindow | undefined, weekly: boolean, now: number): HTMLElement {
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
    h("span", { class: "plan-reset", text: resetLabel(w, weekly, now) }),
  );
  return row;
}

function head(color: string, title: string, subtitle: string): HTMLElement {
  return h("div", { class: "plan-head" },
    dot(color, 7),
    h("span", { class: "plan-title", text: title }),
    h("span", { class: "plan-sub", text: subtitle }),
  );
}

/** The card that stands in for the overview's left card while a pill is open. */
export class PlanCard {
  readonly el = h("div", { class: "plan-card" });
  private key = "";
  constructor(private readonly m: PlanModel) {}

  /** Re-renders when the numbers change, or every 30 s for the countdowns. */
  sync(now = Date.now()) {
    const codex = this.m.planDetailIsCodex;
    const u = codex ? this.m.codexPlanUsage : this.m.planUsage;
    const key = `${language()}|${codex}|${JSON.stringify(u)}|${Math.floor(now / 30_000)}`;
    if (key === this.key) return;
    this.key = key;
    clear(this.el);
    if (codex) this.drawCodex(this.m.codexPlanUsage, now);
    else this.drawClaude(this.m.planUsage, now);
  }

  private drawClaude(u: PlanUsage | null, now: number) {
    this.el.append(
      head(claudeColor(this.m, now), PLAN_TEXT.claudeTitle, claudeSubtitle(u, now)),
      h("div", { class: "plan-rows" },
        gaugeRow(PLAN_TEXT.fiveHours, u?.fiveHour, false, now),
        gaugeRow(PLAN_TEXT.week, u?.sevenDay, true, now),
      ),
    );
  }

  private drawCodex(u: CodexPlanUsage | null, now: number) {
    const rows = h("div", { class: "plan-rows" });
    // Codex plans without a 5-hour window show the week alone, as on the Mac.
    if (u?.fiveHour) rows.append(gaugeRow(PLAN_TEXT.fiveHours, u.fiveHour, false, now));
    rows.append(
      gaugeRow(PLAN_TEXT.week, u?.sevenDay, true, now),
      h("div", { class: "plan-row" },
        h("span", { class: "plan-label", text: PLAN_TEXT.resets }),
        h("span", { class: "plan-credits", text: codexResetsLabel(u) }),
      ),
    );
    this.el.append(head(codexColor(this.m, now), PLAN_TEXT.codexTitle, codexSubtitle(u, now)), rows);
  }
}
