'use strict';
// Public-engine harness: isolated DOM, seeded geometry, explicit frame/timer clock.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function engine(reduced = false) {
  let at = 0, mediaListener; let next = 1;
  const frames = new Map(), events = new Map(), windowEvents = new Map();
  const document = { hidden: false, addEventListener(name, fn) { events.set(name, fn); } };
  const context = vm.createContext({ matchMedia: () => ({ matches: reduced, addEventListener(_, fn) { mediaListener = fn; } }),
    addEventListener(name, fn) { windowEvents.set(name, fn); }, document, performance: { now: () => at },
    requestAnimationFrame(fn) { const id = next++; frames.set(id, fn); return id; },
    cancelAnimationFrame(id) { frames.delete(id); } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/clay-engine.js'), 'utf8') + '\nthis.clay = AbitoClay;', context);
  const doc = { createElementNS: (_ns, tag) => element(tag) };
  function element(tag = 'svg') {
    const attrs = {}, children = [];
    return { tag, children, ownerDocument: doc, setAttribute(k, v) { attrs[k] = String(v); }, getAttribute: k => attrs[k],
      replaceChildren() { children.length = 0; }, appendChild(e) { children.push(e); }, remove() {}, attrs };
  }
  return { api: context.clay, svg: element(), element,
    emitWindow(name, event) { windowEvents.get(name)?.(event); },
    os(value) { mediaListener({ matches: value }); },
    hide(value) { document.hidden = value; events.get('visibilitychange')(); },
    frame(ms = 17) { at += ms; const list = [...frames.values()]; frames.clear(); for (const fn of list) fn(at); },
    pending: () => frames.size };
}
function clock() {
  let now = 0, next = 1;
  const timers = new Map();
  return { now: () => now, setTimer(fn, ms) { const id = next++; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimer(id) { timers.delete(id); }, count: () => timers.size,
    advance(ms) { const end = now + ms; let guard = 0;
      while (true) { const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break; if (++guard > 1000) throw new Error('timer loop');
        now = due[1].at; timers.delete(due[0]); due[1].fn(); }
      now = end;
    } };
}
module.exports = { engine, clock };
