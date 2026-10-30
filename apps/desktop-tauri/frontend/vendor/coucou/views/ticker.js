// Source: reference/coucou windows/src/views/ticker.ts @434d6a2b — Copyright (c) 2026 Louis Raillé, MIT
var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
import { h, svg } from "./dom.js";
import { ICONS } from "./icons.js";
import { cubicBezier, clamp, lerp } from "../core/anim.js";
import { parseDiffStep } from "../core/diff.js";
const ROW_H = 22;
const DURATION = 380;
const MAX_QUEUE = 4;
const COMPLETED_SCALE = 11.5 / 13;
const EASE = cubicBezier(0.4, 0, 0.2, 1);
const STILL_CURRENT = "#c9cdd4";
const DIM = "#6b7079";
function makeRow() {
  const chevron = svg(ICONS.chevronRight, 9, { stroke: 2.4 });
  const check = svg(ICONS.check, 8, { stroke: 2.2 });
  check.style.color = "#454850";
  check.style.position = "absolute";
  chevron.style.position = "absolute";
  const shimmer = h("span", { class: "tick-text shimmer" });
  const dim = h("span", {
    class: "tick-text",
    // top:0 is where a one-line row already put it; it also keeps a text wider
    // than the row on that line instead of dropping it below the row.
    style: `position:absolute;top:0;left:0;right:0;color:${DIM}`
  });
  const body = h("span", { style: "position:relative;flex:1 1 auto;min-width:0" }, shimmer, dim);
  const plus = h("span", { class: "plus" });
  const minus = h("span", { class: "minus" });
  const counts = h("span", { class: "tick-count" }, plus, minus);
  const el = h(
    "div",
    { class: "ticker-row" },
    h("span", { class: "tick-icon", style: "position:relative" }, chevron, check),
    body
  );
  return { el, chevron, check, body, shimmer, dim, counts, plus, minus, text: "", diff: null };
}
function setText(row, text) {
  if (row.text === text) return;
  row.text = text;
  const diff = parseDiffStep(text);
  row.diff = diff;
  const shown = diff ? diff.filename : text;
  row.shimmer.textContent = shown;
  row.dim.textContent = shown;
  if (diff) {
    row.body.style.flex = "0 1 auto";
    row.plus.textContent = diff.added > 0 ? ` +${diff.added}` : "";
    row.minus.textContent = diff.removed > 0 ? ` −${diff.removed}` : "";
    if (row.counts.parentNode !== row.el) row.el.append(row.counts);
    row.el.classList.add("diff");
  } else if (row.el.classList.contains("diff")) {
    row.body.style.flex = "1 1 auto";
    row.counts.remove();
    row.el.classList.remove("diff");
  }
}
function place(row, y, phase, opacity, still) {
  const scale = 1 - phase * (1 - COMPLETED_SCALE);
  row.el.style.transform = `translate(${-phase * 10}px, ${y}px) scale(${scale})`;
  row.el.style.opacity = String(opacity);
  if (still) {
    row.chevron.style.opacity = "0";
    row.check.style.opacity = "1";
    row.shimmer.style.opacity = "0";
    row.dim.style.opacity = "1";
    row.dim.style.color = phase < 0.5 ? STILL_CURRENT : DIM;
  } else {
    row.chevron.style.opacity = String(clamp(1 - phase * 2, 0, 1));
    row.check.style.opacity = String(clamp(phase * 2 - 1, 0, 1));
    row.shimmer.style.opacity = String(clamp(1 - phase * 1.6, 0, 1));
    row.dim.style.opacity = String(clamp(phase * 2 - 0.4, 0, 1));
    row.dim.style.color = DIM;
  }
  row.shimmer.style.animationPlayState = still ? "paused" : "";
}
class Ticker {
  /** `onDiffTap` receives the diff id of a clicked diff row. */
  constructor(onDiffTap) {
    __publicField(this, "el");
    __publicField(this, "a", makeRow());
    // completed
    __publicField(this, "b", makeRow());
    // current
    __publicField(this, "c", makeRow());
    // incoming
    __publicField(this, "queue", []);
    __publicField(this, "startMs", null);
    __publicField(this, "displayIndex", -1);
    /** True once Claude has finished: the final message holds still. */
    __publicField(this, "still", false);
    this.el = h("div", { class: "ticker" }, this.a.el, this.b.el, this.c.el);
    for (const row of [this.a, this.b]) {
      row.el.addEventListener("click", () => {
        if (row.diff && onDiffTap) onDiffTap(row.diff.diffId);
      });
    }
    this.rest();
  }
  /** The state between transitions: completed on top, current below. */
  rest() {
    place(this.a, 0, 1, 1, this.still);
    place(this.b, ROW_H, 0, 1, this.still);
    place(this.c, ROW_H * 2, 0, 0, this.still);
  }
  get animating() {
    return this.startMs != null || this.queue.length > 0;
  }
  sync(task) {
    const steps = task?.steps ?? [];
    const newest = steps.length === 0 ? -1 : task?.stepSeq ?? steps.length - 1;
    const still = !!task?.finalLine;
    if (still !== this.still) {
      this.still = still;
      if (this.startMs == null) this.rest();
    }
    if (this.displayIndex < 0 || newest < this.displayIndex) {
      this.queue = [];
      this.startMs = null;
      this.displayIndex = newest;
      setText(this.a, steps.at(-2) ?? "…");
      setText(this.b, steps.at(-1) ?? "…");
      this.rest();
      return;
    }
    const fresh = Math.min(newest - this.displayIndex, steps.length);
    if (fresh > 0) this.queue.push(...steps.slice(-fresh));
    this.displayIndex = newest;
    if (this.queue.length > MAX_QUEUE) {
      this.queue = this.queue.slice(-MAX_QUEUE);
    }
  }
  /** Called every frame by the island while the overview is on screen. */
  tick(nowMs) {
    if (this.startMs == null) {
      if (this.queue.length === 0) return;
      setText(this.c, this.queue[0]);
      place(this.c, ROW_H * 2, 0, 0, this.still);
      this.startMs = nowMs;
    }
    const p = clamp((nowMs - this.startMs) / DURATION, 0, 1);
    const e = EASE(p);
    place(this.a, lerp(0, -ROW_H, e), 1, clamp(1 - p * 1.35, 0, 1), this.still);
    place(this.b, lerp(ROW_H, 0, e), e, 1, this.still);
    place(this.c, lerp(ROW_H * 2, ROW_H, e), 0, e, this.still);
    if (p < 1) return;
    setText(this.a, this.b.text);
    setText(this.b, this.c.text);
    this.queue.shift();
    this.startMs = null;
    this.rest();
  }
}
export {
  Ticker
};
