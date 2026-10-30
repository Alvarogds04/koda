// Abito-owned lifecycle and trusted-gesture adapter for the literal MIT hub controls.
import { h } from "../views/dom.js";
import { button, label, card, row } from "./ui.js";
function trusted(el) {
  for (const node of [el, ...el.querySelectorAll("button")]) for (const type of ["click", "change", "input", "submit", "keydown"]) {
    node.addEventListener(type, (e) => {
      if (e.isTrusted !== true) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }, true);
  }
  return el;
}
function action(text, fn, disabled = false) {
  const b = trusted(button(text, fn));
  b.type = "button";
  b.disabled = disabled;
  return b;
}
const field = (id, title, type = "text", value = "") => h("input", { id, class: "hub-input", type, value, "aria-label": title, autocomplete: type === "password" ? "new-password" : "off" });
const note = (text) => h("p", { class: "hub-note", role: "status", text });
const foldOpen = /* @__PURE__ */ new Map();
function foldable(card2, key, forceOpen = false) {
  const title = card2.children[0];
  const fold = h("button", { type: "button", class: "card-fold", "aria-expanded": "false", "aria-label": "Desplegar apartado", text: "▸" });
  const show = (open) => {
    card2.classList.toggle("folded", !open);
    fold.setAttribute("aria-expanded", String(open));
    fold.setAttribute("aria-label", open ? "Plegar apartado" : "Desplegar apartado");
    fold.textContent = open ? "▾" : "▸";
  };
  const toggleOpen = () => {
    const open = fold.getAttribute("aria-expanded") !== "true";
    foldOpen.set(key, open);
    show(open);
  };
  fold.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleOpen();
  });
  title.addEventListener("click", (e) => {
    if (!e.target.closest(".hub-info-wrap, .card-fold, a, input, select")) toggleOpen();
  });
  card2.classList.add("foldable");
  title.append(fold);
  show(forceOpen || foldOpen.get(key) === true);
  return card2;
}
const section = (title, ...children) => children.some(Boolean) ? h("section", {}, label(title), card(...children)) : h("section", {}, label(title));
const status = (v) => row(v?.word || v?.say || "Leyendo…", v?.note || null);
function preserveFocus(root) {
  const active = document.activeElement;
  const fields = () => [...root.querySelectorAll("input"), ...root.querySelectorAll("textarea"), ...root.querySelectorAll("select")];
  if (!active?.id || !fields().includes(active)) return () => {
  };
  const start = active.selectionStart, end = active.selectionEnd;
  return () => {
    const next = fields().find((n) => n.id === active.id);
    next?.focus();
    if (typeof start === "number") try {
      next?.setSelectionRange(start, end);
    } catch {
    }
  };
}
function session(invoke, listen, timers = globalThis) {
  let active = true;
  const pending = /* @__PURE__ */ new Set(), cleanups = [];
  const root = h("div", {});
  const message = note("");
  const track = (p) => {
    pending.add(p);
    p.finally(() => pending.delete(p)).catch(() => {
    });
    return p;
  };
  const call = (cmd, payload) => active ? track(Promise.resolve().then(() => {
    if (!active) throw new Error("Página cerrada");
    return invoke(cmd, { payload });
  })) : Promise.reject(new Error("Página cerrada"));
  const work = (fn, done = () => {
  }, failed) => track((async () => {
    try {
      const v = await fn();
      if (active) done(v);
    } catch (error) {
      if (active) {
        message.textContent = "No se pudo completar. No se anuncia ningún cambio como guardado.";
        failed?.(error);
      }
    }
  })());
  const watch = (name, fn) => {
    if (!listen) return;
    work(async () => {
      const off = await listen(name, (e) => {
        if (active && e?.payload) fn(e.payload);
      });
      if (active) cleanups.push(off);
      else off();
    });
  };
  const later = (fn, ms) => {
    const id = timers.setTimeout(() => {
      if (active) fn();
    }, ms);
    cleanups.push(() => timers.clearTimeout(id));
    return id;
  };
  const dispose = () => {
    active = false;
    for (const off of cleanups.splice(0)) off();
    for (const input of root.querySelectorAll("input")) if (input.type === "password") input.value = "";
  };
  return { root, message, call, work, watch, later, alive: () => active, finish: () => Object.assign(root, { dispose, settled: async () => {
    while (pending.size) await Promise.allSettled([...pending]);
  } }) };
}
export {
  action,
  field,
  foldable,
  note,
  preserveFocus,
  section,
  session,
  status,
  trusted
};
