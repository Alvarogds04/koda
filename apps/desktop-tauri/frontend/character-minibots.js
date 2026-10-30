'use strict';
/* #347 F060 mini-bots: one small neutral Abito per real NON-TERMINAL local chat turn, keyed by
   conversation_id + turn_id. Keyed create/release/prune mechanics informed by Coucou
   windows/src/mochi/minibots.ts, Copyright 2026 Louis Raillé, MIT; no Mochi look, canvas
   renderer, names or assets. The public chat view carries no per-turn specialist identity, so
   nothing is inferred about specialists or parallel agents: the honest label is «Turno». */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AbitoMinis = Object.freeze(api);
})(typeof self !== 'undefined' ? self : this, () => {
  // turn state -> engine state + short Spanish word. Terminal/unknown states have no mini.
  const MAP = {
    queued: ['idle', 'En cola'], thinking: ['think', 'Piensa'],
    streaming: ['speak', 'Responde'], waiting_approval: ['approval', 'Espera tu decisión'],
  };
  const MAX_MINIS = 6;
  function plan(view) {
    if (!view || typeof view.conversation_id !== 'string' || !Array.isArray(view.turns)) return [];
    const out = [], seen = new Set();
    for (const t of view.turns) {
      const m = t && typeof t.turn_id === 'string' && Object.prototype.hasOwnProperty.call(MAP, t.state) ? MAP[t.state] : null;
      if (!m) continue;
      const key = JSON.stringify([view.conversation_id, t.turn_id]);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, state: m[0], word: m[1] });
      if (out.length >= MAX_MINIS) break;
    }
    return out;
  }
  const NS = 'http://www.w3.org/2000/svg';
  function create({ container, makeClay, doc }) {
    const items = new Map();
    let seq = 0;
    function release(key) { const it = items.get(key); if (!it) return; try { it.clay.destroy(); } catch (_) { /* engine teardown is best effort */ } it.li.remove(); items.delete(key); }
    function clear() { for (const key of [...items.keys()]) release(key); container.hidden = true; }
    function sync(view) {
      const wanted = plan(view), keep = new Set(wanted.map(w => w.key));
      for (const key of [...items.keys()]) if (!keep.has(key)) release(key);
      for (const w of wanted) {
        let it = items.get(w.key);
        if (!it) {
          const li = doc.createElement('li'), svg = doc.createElementNS(NS, 'svg'), label = doc.createElement('span');
          svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
          li.setAttribute('class', 'minibot'); label.setAttribute('class', 'minibot-word');
          li.appendChild(svg); li.appendChild(label); container.appendChild(li);
          it = { li, label, clay: makeClay(svg, 505 + ++seq), word: '' };
          items.set(w.key, it);
        }
        if (it.clay.state !== w.state) it.clay.setState(w.state);
        if (it.word !== w.word) { it.word = w.word; it.label.textContent = `Turno · ${w.word}`; }
      }
      container.hidden = items.size === 0;
    }
    return { sync, clear, get size() { return items.size; }, keys: () => [...items.keys()] };
  }
  return { plan, create, MAX_MINIS };
});
