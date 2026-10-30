// Source: reference/coucou windows/src/views/dom.ts @434d6a2b — Copyright (c) 2026 Louis Raillé, MIT
import { Msg, onLanguageChange } from "../i18n/i18n.js";
const bindings = /* @__PURE__ */ new Set();
let sincePrune = 0;
function read(node, attr) {
  if (attr === "text") return node.nodeType === 3 ? node.data : node.textContent;
  return node.getAttribute(attr);
}
function write(node, attr, value) {
  if (attr === "text") {
    if (node.nodeType === 3) node.data = value;
    else node.textContent = value;
  } else {
    node.setAttribute(attr, value);
  }
}
function bind(node, attr, msg, shown) {
  bindings.add({ node: new WeakRef(node), attr, msg, shown });
  if (++sincePrune >= 500) {
    sincePrune = 0;
    for (const b of bindings) if (!b.node.deref()) bindings.delete(b);
  }
}
function relabel() {
  for (const b of bindings) {
    const node = b.node.deref();
    if (!node || read(node, b.attr) !== b.shown) {
      bindings.delete(b);
      continue;
    }
    const next = String(b.msg);
    if (next !== b.shown) {
      write(node, b.attr, next);
      b.shown = next;
    }
  }
}
function liveTextCount() {
  return bindings.size;
}
onLanguageChange(() => relabel());
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (v instanceof Msg) {
      const text = String(v);
      write(el, k, text);
      bind(el, k, v, text);
      continue;
    }
    if (k === "class") el.className = String(v);
    else if (k === "text") el.textContent = String(v);
    else if (k.startsWith("on") && typeof v === "function") {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === "style" && typeof v === "string") {
      let start = 0, depth = 0, quote = "", escaped = false;
      for (let i = 0; i <= v.length; i++) {
        const c = v[i] ?? ";";
        if (escaped) {
          escaped = false;
          continue;
        }
        if (c === "\\") {
          escaped = true;
          continue;
        }
        if (quote) {
          if (c === quote) quote = "";
          continue;
        }
        if (c === '"' || c === "'") {
          quote = c;
          continue;
        }
        if (c === "(") depth++;
        if (c === ")") depth--;
        if (c !== ";" || depth !== 0) continue;
        const declaration = v.slice(start, i), colon = declaration.indexOf(":");
        start = i + 1;
        if (colon < 1) continue;
        const name = declaration.slice(0, colon).trim();
        const value = declaration.slice(colon + 1).trim();
        if (!/^(-{0,2}[a-zA-Z_][\w-]*)$/.test(name) || !value) continue;
        try {
          el.style.setProperty(name, value);
        } catch {
        }
      }
    } else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    if (c instanceof Msg) {
      const node = document.createTextNode(String(c));
      bind(node, "text", c, String(c));
      el.append(node);
      continue;
    }
    el.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}
function svg(path, size = 14, opts = {}) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", "0 0 24 24");
  el.setAttribute("width", String(size));
  el.setAttribute("height", String(size));
  el.setAttribute("aria-hidden", "true");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", path);
  if (opts.stroke) {
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", String(opts.stroke));
    p.setAttribute("stroke-linecap", "round");
    p.setAttribute("stroke-linejoin", "round");
  } else {
    p.setAttribute("fill", opts.fill ?? "currentColor");
    if (opts.evenOdd) p.setAttribute("fill-rule", "evenodd");
  }
  el.append(p);
  return el;
}
function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}
function dot(color, size = 7) {
  return h("i", {
    class: "dot",
    style: `width:${size}px;height:${size}px;background:${color}`
  });
}
export {
  clear,
  dot,
  h,
  liveTextCount,
  relabel,
  svg
};
