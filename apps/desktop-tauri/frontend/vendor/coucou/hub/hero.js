// Adapted from Coucou src/hub/hero.ts @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT
import { h } from "../views/dom.js";
const live = /* @__PURE__ */ new Set();
let frame = null;
let last = typeof performance !== "undefined" ? performance.now() : 0;
const startedAt = last;
const visible = () => typeof document !== "undefined" && document.visibilityState === "visible" && typeof requestAnimationFrame === "function";
function loop(now) {
  frame = null;
  const dt = Math.min(0.05, (now - last) / 1e3);
  last = now;
  const t = (now - startedAt) / 1e3;
  for (const a of live) {
    if (!a.el.isConnected) {
      if (a.shown || now - (a.born ??= now) > 5e3) live.delete(a);
      continue;
    }
    a.shown = true;
    a.draw(dt, t);
  }
  if (live.size > 0 && visible()) frame = requestAnimationFrame(loop);
}
function wake() {
  if (frame === null && live.size > 0 && visible()) {
    last = performance.now();
    frame = requestAnimationFrame(loop);
  }
}
if (typeof document !== "undefined" && typeof document.addEventListener === "function") document.addEventListener("visibilitychange", wake);
function add(a) {
  live.add(a);
  wake();
}
function fit(canvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1), w = canvas.clientWidth, hh = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hh * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hh * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h: hh, ctx };
}
const rgb = (hex) => {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
};
function rgba(hex, alpha) {
  const [r, g, b] = rgb(hex);
  return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${Math.max(0, Math.min(1, alpha))})`;
}
function backdrop(canvas, color, pointerFrom, radius = 18) {
  let particles = [];
  let pointer = null;
  let strength = 0;
  pointerFrom.addEventListener("pointermove", (e) => {
    const r = canvas.getBoundingClientRect();
    pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
  });
  pointerFrom.addEventListener("pointerleave", () => pointer = null);
  const seed = (w, hh) => {
    const count = Math.round(Math.min(90, Math.max(24, w * hh / 2600)));
    particles = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      y: Math.random() * hh,
      vx: (Math.random() - 0.5) * 6,
      vy: -2 - Math.random() * 6,
      r: 0.5 + Math.random() * 1.4,
      depth: 0.35 + Math.random() * 0.65,
      phase: Math.random() * Math.PI * 2,
      white: Math.random() < 0.35
    }));
  };
  add({ el: canvas, draw(dt, t) {
    const { w, h: hh, ctx } = fit(canvas);
    if (!ctx || w === 0) return;
    if (particles.length === 0) seed(w, hh);
    strength += ((pointer ? 1 : 0) - strength) * Math.min(1, dt * 4);
    ctx.clearRect(0, 0, w, hh);
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(0, 0, w, hh, radius);
    ctx.clip();
    ctx.fillStyle = "#020203";
    ctx.fillRect(0, 0, w, hh);
    const lin = ctx.createLinearGradient(w, 0, w * 0.35, hh);
    lin.addColorStop(0, rgba(color, 0.1));
    lin.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = lin;
    ctx.fillRect(0, 0, w, hh);
    const breath = 0.85 + 0.15 * Math.sin(t * 0.9);
    const rad = ctx.createRadialGradient(w * 0.92, -hh * 0.15, 0, w * 0.92, -hh * 0.15, Math.max(w, hh) * 0.55 * breath);
    rad.addColorStop(0, rgba(color, 0.3 * breath));
    rad.addColorStop(0.5, rgba(color, 0.08));
    rad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = rad;
    ctx.fillRect(0, 0, w, hh);
    for (const p of particles) {
      p.x += p.vx * dt * p.depth;
      p.y += p.vy * dt * p.depth;
      let alpha = (0.22 + 0.5 * (0.5 + 0.5 * Math.sin(t * (1.2 + p.depth) + p.phase))) * p.depth;
      let r = p.r;
      if (pointer && strength > 0.01) {
        const dx = p.x - pointer.x, dy = p.y - pointer.y, d = Math.hypot(dx, dy);
        if (d < 140 && d > 0.1) {
          const push = (1 - d / 140) * 90 * strength * dt;
          p.x += dx / d * push;
          p.y += dy / d * push;
        }
        if (d < 200) {
          const near = (1 - d / 200) * strength;
          alpha += near * 0.6;
          r *= 1 + near * 0.8;
        }
      }
      if (p.y < -4) p.y = hh + 4;
      if (p.y > hh + 4) p.y = -4;
      if (p.x < -4) p.x = w + 4;
      if (p.x > w + 4) p.x = -4;
      const tint = p.white ? "#FFFFFF" : color;
      if (r > 1.1) {
        ctx.fillStyle = rgba(tint, Math.min(1, alpha) * 0.12);
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = rgba(tint, Math.min(1, alpha));
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  } });
}
const COLORS = {
  dictation: "#FB923C",
  notes: "#3B9EFF",
  insights: "#34D399",
  dictionary: "#A78BFA",
  snippets: "#F7B32B",
  styles: "#F472B6",
  flowsettings: "#8E939C",
  general: "#8E939C",
  pills: "#F5A524",
  agents: "#3B9EFF",
  chat: "#E07950",
  integrations: "#7C5CFF",
  phone: "#3DDC84",
  voice: "#F97316",
  shortcuts: "#6366F1"
};
function glowCard(color, ...content) {
  const canvas = h("canvas", {});
  const el = h("div", { class: "hub-glow" }, canvas, h("div", { class: "inner" }, ...content));
  el.style.setProperty("--glow-line", rgba(color, 0.18));
  backdrop(canvas, color, el, 14);
  return el;
}
function emptyState(text) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  liveMochi(svg, "#F5F6F8", "sleeping");
  return h("div", { class: "hub-empty" }, svg, h("div", { text }));
}
function liveMochi(svg, _color = "#F5F6F8", state = "idle") {
  if (typeof AbitoClay === "undefined") return null;
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("preserveAspectRatio", "xMaxYMid meet");
  return AbitoClay.create(svg, { state, live: false, viewBox: "0 0 200 200", shadow: false });
}
function hero(page, title, subtitle, actions = [], compact = false) {
  const el = document.createElement("div");
  el.className = compact ? "hub-hero compact" : "hub-hero";
  const color = COLORS[page] ?? COLORS.general;
  el.style.setProperty("--hero-line", rgba(color, 0.16));
  const back = document.createElement("canvas");
  back.className = "backdrop";
  const character = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  character.setAttribute("class", "troupe");
  liveMochi(character);
  const copy = document.createElement("div");
  copy.className = "copy";
  const h1 = document.createElement("h1");
  h1.textContent = title;
  copy.append(h1);
  if (subtitle) {
    const p = document.createElement("p");
    p.textContent = subtitle;
    copy.append(p);
  }
  if (actions.length) {
    const row = document.createElement("div");
    row.className = "actions";
    row.append(...actions);
    copy.append(row);
  }
  el.append(back, character, copy);
  backdrop(back, color, el);
  return el;
}
export {
  emptyState,
  glowCard,
  hero,
  liveMochi
};
