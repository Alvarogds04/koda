// Adapted from Coucou src/settings/main.ts @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT.
import { h } from "../views/dom.js";
const notchSection = (title, ...children) => h("section", {}, h("h2", {}, h("span", { text: title })), ...children);
const notchTipSection = (title, tip, ...children) => h("section", {}, h("h2", {}, h("span", { text: title }), infoTip(tip, `Más información: ${title}`)), ...children);
const notchRow = (title, ...controls) => h("div", { class: "row" }, h("label", { text: title }), ...controls);
const notchTipRow = (title, tip, ...controls) => h("div", { class: "row" }, h("label", { text: title }), ...tip ? [infoTip(tip, `Más información: ${title}`)] : [], ...controls);
const notchHint = (text) => h("div", { class: "hint", text });
const notchCard = (title, ...children) => h("section", { class: "abito-card", "aria-label": title }, h("h2", {}, h("span", { text: title })), ...children);
let tipSeq = 0;
const infoTip = (text, label = "Más información") => {
  const id = `hub-tip-${++tipSeq}`;
  const tip = h("span", { class: "hub-tip", id, role: "tooltip", text });
  const button = h("button", { class: "hub-info", type: "button", "aria-label": label, "aria-describedby": id, text: "ⓘ" });
  const wrap = h("span", { class: "hub-info-wrap" }, button, tip);
  button.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    wrap.classList.toggle("dismissed", true);
    e.stopPropagation();
  });
  const rearm = () => wrap.classList.toggle("dismissed", false);
  button.addEventListener("blur", rearm);
  wrap.addEventListener("mouseleave", rearm);
  return wrap;
};
const withTip = (title, tip) => h("span", { class: "hub-titled" }, h("span", { class: "hub-titled-text", text: title }), ...tip ? [infoTip(tip, `Más información: ${title}`)] : []);
export {
  infoTip,
  notchCard,
  notchHint,
  notchRow,
  notchSection,
  notchTipRow,
  notchTipSection,
  withTip
};
