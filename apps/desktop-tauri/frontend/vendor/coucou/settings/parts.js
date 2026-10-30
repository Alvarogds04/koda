// Source: reference/coucou windows/src/settings/parts.ts @434d6a2b — Copyright (c) 2026 Louis Raillé, MIT
import { h } from "../views/dom.js";
function statusDot(ok) {
  return h("i", { class: "dot", style: `background:${ok ? "#22c55e" : "#f4505e"}` });
}
function renderDiff(text) {
  const box = h("div", { class: "diff" });
  for (const line of text.split("\n")) {
    const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
    box.append(h("div", { class: cls, text: line }));
  }
  return box;
}
export {
  renderDiff,
  statusDot
};
