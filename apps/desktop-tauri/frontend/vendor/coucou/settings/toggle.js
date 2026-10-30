// Source: reference/coucou windows/src/settings/main.ts:55-63 @434d6a2b — Copyright (c) 2026 Louis Raillé, MIT
import { h } from "../views/dom.js";
function toggle(on, onChange) {
  const el = h("button", { class: on ? "switch on" : "switch", "aria-pressed": on });
  el.addEventListener("click", () => {
    const next = !el.classList.contains("on");
    el.classList.toggle("on", next);
    onChange(next);
  });
  return el;
}
export {
  toggle
};
