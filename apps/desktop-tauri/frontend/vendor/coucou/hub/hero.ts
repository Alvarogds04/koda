// Adapted from Coucou src/hub/hero.ts @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT
// Adapted for Abito: the classic lexical engine API is visible to ESM. SVG,
// not canvas: create(svg, opts) is the real API. Static instances own no RAF/timer.
import { h } from '../views/dom.js';
// The backdrop below (deep black, the page's colour breathing in a corner, drifting particles that move away from
// the pointer) is Coucou's code from src/hub/hero.ts; its Mochi walkers, outfits and cast are NOT ported.
interface Animated { el: HTMLCanvasElement; draw(dt: number, t: number): void; shown?: boolean; born?: number }
const live = new Set<Animated>();
let frame: number | null = null;
let last = typeof performance !== 'undefined' ? performance.now() : 0;
const startedAt = last;
const visible = () => typeof document !== 'undefined' && document.visibilityState === 'visible' && typeof requestAnimationFrame === 'function';
function loop(now: number) {
  frame = null;
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const t = (now - startedAt) / 1000;
  for (const a of live) {
    if (!a.el.isConnected) { if (a.shown || now - (a.born ??= now) > 5000) live.delete(a); continue; }
    a.shown = true;
    a.draw(dt, t);
  }
  if (live.size > 0 && visible()) frame = requestAnimationFrame(loop);
}
function wake() { if (frame === null && live.size > 0 && visible()) { last = performance.now(); frame = requestAnimationFrame(loop); } }
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') document.addEventListener('visibilitychange', wake);
function add(a: Animated) { live.add(a); wake(); }
function fit(canvas: HTMLCanvasElement) {
  const dpr = Math.min(2, window.devicePixelRatio || 1), w = canvas.clientWidth, hh = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hh * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(hh * dpr); }
  const ctx = canvas.getContext('2d');
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h: hh, ctx };
}
const rgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
function rgba(hex: string, alpha: number): string {
  const [r, g, b] = rgb(hex);
  return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${Math.max(0, Math.min(1, alpha))})`;
}
interface Particle { x: number; y: number; vx: number; vy: number; r: number; depth: number; phase: number; white: boolean }
function backdrop(canvas: HTMLCanvasElement, color: string, pointerFrom: HTMLElement, radius = 18) {
  let particles: Particle[] = [];
  let pointer: { x: number; y: number } | null = null;
  let strength = 0;
  pointerFrom.addEventListener('pointermove', (e: any) => { const r = canvas.getBoundingClientRect(); pointer = { x: e.clientX - r.left, y: e.clientY - r.top }; });
  pointerFrom.addEventListener('pointerleave', () => (pointer = null));
  const seed = (w: number, hh: number) => {
    const count = Math.round(Math.min(90, Math.max(24, (w * hh) / 2600)));
    particles = Array.from({ length: count }, () => ({ x: Math.random() * w, y: Math.random() * hh, vx: (Math.random() - 0.5) * 6, vy: -2 - Math.random() * 6,
      r: 0.5 + Math.random() * 1.4, depth: 0.35 + Math.random() * 0.65, phase: Math.random() * Math.PI * 2, white: Math.random() < 0.35 }));
  };
  add({ el: canvas, draw(dt, t) {
    const { w, h: hh, ctx } = fit(canvas);
    if (!ctx || w === 0) return;
    if (particles.length === 0) seed(w, hh);
    strength += ((pointer ? 1 : 0) - strength) * Math.min(1, dt * 4);
    ctx.clearRect(0, 0, w, hh);
    ctx.save(); ctx.beginPath(); ctx.roundRect(0, 0, w, hh, radius); ctx.clip();
    ctx.fillStyle = '#020203'; ctx.fillRect(0, 0, w, hh);
    const lin = ctx.createLinearGradient(w, 0, w * 0.35, hh);
    lin.addColorStop(0, rgba(color, 0.1)); lin.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = lin; ctx.fillRect(0, 0, w, hh);
    const breath = 0.85 + 0.15 * Math.sin(t * 0.9);
    const rad = ctx.createRadialGradient(w * 0.92, -hh * 0.15, 0, w * 0.92, -hh * 0.15, Math.max(w, hh) * 0.55 * breath);
    rad.addColorStop(0, rgba(color, 0.3 * breath)); rad.addColorStop(0.5, rgba(color, 0.08)); rad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = rad; ctx.fillRect(0, 0, w, hh);
    for (const p of particles) {
      p.x += p.vx * dt * p.depth; p.y += p.vy * dt * p.depth;
      let alpha = (0.22 + 0.5 * (0.5 + 0.5 * Math.sin(t * (1.2 + p.depth) + p.phase))) * p.depth;
      let r = p.r;
      if (pointer && strength > 0.01) {
        const dx = p.x - pointer.x, dy = p.y - pointer.y, d = Math.hypot(dx, dy);
        if (d < 140 && d > 0.1) { const push = (1 - d / 140) * 90 * strength * dt; p.x += (dx / d) * push; p.y += (dy / d) * push; }
        if (d < 200) { const near = (1 - d / 200) * strength; alpha += near * 0.6; r *= 1 + near * 0.8; }
      }
      if (p.y < -4) p.y = hh + 4; if (p.y > hh + 4) p.y = -4; if (p.x < -4) p.x = w + 4; if (p.x > w + 4) p.x = -4;
      const tint = p.white ? '#FFFFFF' : color;
      if (r > 1.1) { ctx.fillStyle = rgba(tint, Math.min(1, alpha) * 0.12); ctx.beginPath(); ctx.arc(p.x, p.y, r * 2.6, 0, Math.PI * 2); ctx.fill(); }
      ctx.fillStyle = rgba(tint, Math.min(1, alpha)); ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  } });
}
// The page colours of Coucou's THEMES (colours only).
const COLORS: Record<string, string> = {
  dictation: '#FB923C', notes: '#3B9EFF', insights: '#34D399', dictionary: '#A78BFA', snippets: '#F7B32B', styles: '#F472B6',
  flowsettings: '#8E939C', general: '#8E939C', pills: '#F5A524', agents: '#3B9EFF', chat: '#E07950', integrations: '#7C5CFF',
  phone: '#3DDC84', voice: '#F97316', shortcuts: '#6366F1',
};
// MIT helper layouts from src/hub/hero.ts; character remains Abito's static clay SVG.
export function glowCard(color: string, ...content: HTMLElement[]): HTMLElement {
  const canvas = h('canvas', {}) as HTMLCanvasElement;
  const el = h('div', {class:'hub-glow'}, canvas, h('div', {class:'inner'}, ...content));
  el.style.setProperty('--glow-line', rgba(color, 0.18));
  backdrop(canvas, color, el, 14);
  return el;
}
export function emptyState(text: string): HTMLElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  liveMochi(svg, '#F5F6F8', 'sleeping');
  return h('div', {class:'hub-empty'}, svg, h('div', {text}));
}
declare const AbitoClay: { create(svg: SVGSVGElement, options: any): any };
export function liveMochi(svg: SVGSVGElement, _color = '#F5F6F8', state = 'idle'): any {
  if (typeof AbitoClay === 'undefined') return null;
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('preserveAspectRatio', 'xMaxYMid meet');
  return AbitoClay.create(svg, { state, live: false, viewBox: '0 0 200 200', shadow: false });
}
export function hero(page: string, title: string, subtitle: string | null, actions: HTMLElement[] = [], compact = false): HTMLElement {
  const el = document.createElement('div');
  el.className = compact ? 'hub-hero compact' : 'hub-hero';
  const color = COLORS[page] ?? COLORS.general;
  el.style.setProperty('--hero-line', rgba(color, 0.16));
  const back = document.createElement('canvas');
  back.className = 'backdrop';
  const character = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  character.setAttribute('class', 'troupe');
  liveMochi(character);
  const copy = document.createElement('div');
  copy.className = 'copy';
  const h1 = document.createElement('h1');
  h1.textContent = title;
  copy.append(h1);
  if (subtitle) {
    const p = document.createElement('p');
    p.textContent = subtitle;
    copy.append(p);
  }
  if (actions.length) {
    const row = document.createElement('div');
    row.className = 'actions';
    row.append(...actions);
    copy.append(row);
  }
  el.append(back, character, copy);
  backdrop(back, color, el);
  return el;
}
