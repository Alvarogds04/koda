'use strict';
/* S31: the EXPANDED island folds to the compact pill after 30 s without interaction (any view; pinned or opened by a click too).
   Interaction = pointer over the island, a click, a key press or typing inside it; each one resets the 30 s. A focused text field only
   keeps the island open while the pointer is also over it. The module owns the rule and the timer; it never reads or clears any typed text
   (folding leaves the page, and so whatever was typed, untouched) and never decides what a host refusal means: when the host refuses the
   fold (a pending question it protects) the clock simply starts another full period. Pure + injectable clock; loaded as a classic
   script (window.AbitoIslandIdle) and by test-node/island-idle-check.cjs. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AbitoIslandIdle = Object.freeze(api);
})(typeof self !== 'undefined' ? self : this, () => {
  const IDLE_MS = 30000;
  /** facts: { expanded, idleMs, fieldFocus, inside } */
  function shouldCollapse(f) {
    if (!f || f.expanded !== true || !Number.isFinite(f.idleMs)) return false;
    if (f.inside === true) return false; // the pointer parked on the island is interaction
    if (f.fieldFocus === true && f.inside === true) return false;
    return f.idleMs >= IDLE_MS;
  }
  function create(o) {
    for (const k of ['now', 'schedule', 'cancel', 'collapse']) if (typeof (o && o[k]) !== 'function') throw new TypeError(`${k} required`);
    let expanded = false, inside = false, fieldFocus = false, last = 0, timer = null, stopped = false;
    const clear = () => { if (timer !== null) { o.cancel(timer); timer = null; } };
    function arm() {
      clear();
      if (stopped || !expanded || inside) return;
      const wait = Math.max(0, last + IDLE_MS - o.now());
      timer = o.schedule(fire, wait);
    }
    function fire() {
      timer = null;
      if (stopped || !expanded) return;
      if (!shouldCollapse({ expanded, idleMs: o.now() - last, fieldFocus, inside })) { arm(); return; }
      last = o.now(); // whatever the host answers, the next attempt is one full period away (never a loop)
      let p; try { p = Promise.resolve(o.collapse()); } catch { p = Promise.reject(new Error('collapse failed')); }
      p.then(() => {}, () => {}).then(() => { if (!stopped && expanded) arm(); });
      arm();
    }
    return {
      touch() { last = o.now(); arm(); },
      setExpanded(v) { const next = v === true; if (next === expanded) return; expanded = next; last = o.now(); if (expanded) arm(); else clear(); },
      setInside(v) { const next = v === true; if (next === inside) return; inside = next; last = o.now(); if (inside) clear(); else arm(); },
      setFieldFocus(v) { fieldFocus = v === true; },
      stop() { stopped = true; clear(); },
    };
  }
  return { IDLE_MS, shouldCollapse, create };
});
