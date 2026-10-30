// Source: reference/coucou windows/src/settings/colors.ts @434d6a2b — Copyright (c) 2026 Louis Raillé, MIT
import { PILL_PALETTE, pillColor, withPillColor } from "../core/pill-colors.js";
import { h } from "../views/dom.js";
import { t } from "../i18n/i18n.js";
let closeOpen = null;
function colorDot(def, size, colors, pick, trustedOnly = false) {
  let release = () => {
  };
  const current = () => pillColor(def.id, def.color, colors());
  const dot = h("i", {
    class: "dot color-dot",
    role: "button",
    tabindex: "0",
    style: `background:${current()};${size}`,
    title: t("Color"),
    "aria-label": `${def.name} · ${t("Color")}`,
    "aria-haspopup": "true"
  });
  const open = () => {
    closeOpen?.();
    const palette = h("div", { class: "palette", role: "group", "aria-label": t("Color") });
    const close = () => {
      palette.remove();
      document.removeEventListener("mousedown", outside, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", close);
      closeOpen = null;
    };
    const outside = (e) => {
      const at2 = e.target;
      if (!palette.contains(at2) && at2 !== dot) close();
    };
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      close();
      dot.focus();
    };
    const choose = (hex) => {
      pick(withPillColor(colors(), def.id, hex, def.color));
      dot.style.background = current();
      close();
      dot.focus();
    };
    const now = current();
    for (const hex of PILL_PALETTE) {
      const swatch = h("button", {
        class: hex === now ? "swatch on" : "swatch",
        style: `background:${hex}`,
        title: hex,
        "aria-label": hex,
        "aria-pressed": hex === now
      });
      swatch.addEventListener("click", (e) => {
        if (!trustedOnly || e.isTrusted) choose(hex);
      });
      palette.append(swatch);
    }
    if (now !== pillColor(def.id, def.color, null)) {
      const reset = h("button", { class: "reset", text: t("Default") });
      reset.addEventListener("click", (e) => {
        if (!trustedOnly || e.isTrusted) choose(null);
      });
      palette.append(reset);
    }
    document.body.append(palette);
    const at = dot.getBoundingClientRect();
    const left = Math.max(8, Math.min(at.left - 10, window.innerWidth - palette.offsetWidth - 8));
    palette.style.left = `${left}px`;
    palette.style.top = `${at.bottom + 8}px`;
    document.addEventListener("mousedown", outside, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", close);
    closeOpen = close;
    release = () => {
      if (closeOpen === close) close();
    };
    (palette.querySelector(".swatch.on") ?? palette.querySelector(".swatch"))?.focus();
  };
  dot.addEventListener("click", (e) => {
    if (!trustedOnly || e.isTrusted) closeOpen ? closeOpen() : open();
  });
  dot.addEventListener("keydown", (e) => {
    if (trustedOnly && !e.isTrusted) return;
    const key = e.key;
    if (key !== "Enter" && key !== " ") return;
    e.preventDefault();
    open();
  });
  return Object.assign(dot, { dispose: () => release(), open: () => closeOpen ? closeOpen() : open() });
}
export {
  colorDot
};
