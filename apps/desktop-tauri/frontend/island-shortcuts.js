'use strict';
/* K2-09 · the shortcuts part of the island (design/k2-09-atajos/08-isla-unida.html, approved 10-nov): the shared shell where the
   music, mail, GitHub and calendar cards live, with the icon row at the bottom, centred. Pure model only (Node-testable, no DOM);
   classic script (window.AbitoShortcuts) and test-node module.

   MOUNT POINT for K2-10 (mail) and K2-11 (GitHub, calendar):
     AbitoShortcuts.registerCard({
       id: 'gmail',                   // one of ORDER, or any new [a-z0-9-] id (it goes after the known ones)
       label: 'Gmail',                // accessible name of its icon («Hablar con Koda» is reserved for the first icon)
       icon: 'mail',                  // icon key the mount paints
       available: () => boolean,      // true ONLY when the user really connected it: never sample data (K2-10/K2-11 criterion 3)
       mount: (el) => () => void,     // paints the card into `el` when it is focused; returns an unmount function
       badge: () => number,           // optional counter on the icon (0 = none)
     });
   A card that is not `available()` gets no icon and no card. With no available card there is no row: the island is the usual Nusa. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AbitoShortcuts = api;
})(typeof self !== 'undefined' ? self : this, () => {
  const ORDER = Object.freeze(['spotify', 'gmail', 'github', 'cal']);
  const KODA = Object.freeze({ id: 'koda', label: 'Hablar con Koda', icon: 'koda' });
  const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
  const ICON_W = 44, ROW_GAP = 4;
  const cards = new Map();
  const listeners = new Set();
  const changed = () => { for (const fn of listeners) { try { fn(); } catch { /* a listener never breaks the registry */ } } };

  function registerCard(def) {
    if (!def || typeof def !== 'object') throw new TypeError('registerCard: a card definition is required');
    const { id, label, icon, available, mount, badge } = def;
    if (typeof id !== 'string' || !ID.test(id) || id === KODA.id) throw new TypeError(`registerCard: invalid id ${String(id)}`);
    if (cards.has(id)) throw new Error(`registerCard: «${id}» is already registered`);
    if (typeof label !== 'string' || !label.trim()) throw new TypeError(`registerCard: «${id}» needs a label`);
    if (typeof icon !== 'string' || !icon) throw new TypeError(`registerCard: «${id}» needs an icon`);
    if (typeof available !== 'function' || typeof mount !== 'function') throw new TypeError(`registerCard: «${id}» needs available() and mount()`);
    if (badge !== undefined && typeof badge !== 'function') throw new TypeError(`registerCard: «${id}» badge must be a function`);
    cards.set(id, Object.freeze({ id, label: label.trim(), icon, available, mount, badge: badge || (() => 0) }));
    changed();
    return () => { if (cards.delete(id)) changed(); };
  }
  const rank = id => { const i = ORDER.indexOf(id); return i < 0 ? ORDER.length : i; };
  const isOn = c => { try { return c.available() === true; } catch { return false; } };
  // the cards the user really has, in the design order (known ids first, then registration order)
  function visible() {
    return [...cards.values()].map((c, i) => ({ c, i })).filter(x => isOn(x.c))
      .sort((a, b) => rank(a.c.id) - rank(b.c.id) || a.i - b.i).map(x => x.c);
  }
  // the icon row: «Hablar con Koda» first, then each available app; none at all when no app is available (the usual Nusa)
  function row() {
    const apps = visible();
    if (!apps.length) return [];
    return [KODA, ...apps].map((c, i) => {
      let n = 0;
      if (c !== KODA) { try { n = Math.max(0, Math.floor(Number(c.badge()) || 0)); } catch { n = 0; } }
      return Object.freeze({ id: c.id, label: c.label, icon: c.icon, num: i + 1, badge: n });
    });
  }
  // geometry from the design: n × 44 + 4, centred in the 720 notch
  const rowWidth = n => (n > 0 ? n * ICON_W + ROW_GAP : 0);
  // where focus goes when the focused card disappears: back to «Hablar con Koda»
  function focusAfter(focus, ids) { return ids.includes(focus) ? focus : KODA.id; }
  // Ctrl+←/→ (⌘ on macOS) walks the row and stops at the ends; Ctrl+1…N jumps by number
  function stepFocus(focus, ids, delta) {
    const i = ids.indexOf(focus);
    if (i < 0) return ids[0] || KODA.id;
    return ids[Math.max(0, Math.min(ids.length - 1, i + (delta > 0 ? 1 : delta < 0 ? -1 : 0)))];
  }
  function keyFocus(e, ids, os) {
    if (!e || e.isTrusted !== true || e.altKey || e.shiftKey) return null;
    const mod = os === 'macos' ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    if (!mod) return null;
    if (/^[1-9]$/.test(e.key)) { const n = Number(e.key); return n <= ids.length ? ids[n - 1] : null; }
    return e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : null;
  }
  const onChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };
  const _reset = () => { cards.clear(); listeners.clear(); };
  return { ORDER, KODA, registerCard, visible, row, rowWidth, focusAfter, stepFocus, keyFocus, onChange, _reset };
});
