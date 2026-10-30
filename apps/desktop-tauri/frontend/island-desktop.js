'use strict';
/* #486 — island side of the desktop character. Adapted from Coucou windows/src/island/desktop.ts
   @71b773f, Copyright (c) 2026 Louis Raillé, MIT. Runs the life cycle (character-desktop-logic.js)
   against the closed Rust verbs (character_*), hides the island's own character while it is out, and
   tells the character window what to show. Rust owns where the window is. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) { module.exports = Object.freeze(api); return; }
  root.AbitoIslandDesktopFactory = Object.freeze(api);
  api.mount();
})(typeof self !== 'undefined' ? self : this, root => {
  /** Who handles a press+drag: a press ON the character picks it up (Coucou); anything else moves the island. */
  function pickUpDecision({ onCharacter, available }) {
    return onCharacter && available ? 'pickup' : 'island';
  }

  function create(deps) {
    const { invoke, listen, clayEl, getClayState, setTimer, clearTimer } = deps;
    const Logic = deps.logic || (root.AbitoCharacterDesktop) || require('./character-desktop-logic.js');
    let supported = false, carrying = false, last = null, pushedState = '', poll = null;
    const call = (cmd, args) => (invoke ? Promise.resolve(invoke(cmd, args)).catch(() => undefined) : Promise.resolve(undefined));
    const setAway = away => { if (clayEl) clayEl.style.visibility = away ? 'hidden' : ''; if (away) startPush(); else stopPush(); };
    function pushState() {
      const s = getClayState && getClayState();
      if (typeof s === 'string' && s !== pushedState) { pushedState = s; call('character_push', { state: s }); }
    }
    function startPush() { if (poll == null && setTimer) { pushState(); const tick = () => { pushState(); poll = setTimer(tick, 300); }; poll = setTimer(tick, 300); } }
    function stopPush() { if (poll != null && clearTimer) clearTimer(poll); poll = null; pushedState = ''; }
    const controller = Logic.create({
      flyOut: async anywhere => (await call('character_fly_out', { anywhere })) === true,
      flyHome: async forget => (await call('character_fly_home', { forget })) !== false,
      setAway,
      emote: emote => { call('character_push', { emote }); },
      alertActive: () => Logic.alertActive(last),
      revealIsland: () => { if (deps.reveal) deps.reveal(); },
      later: (fn, ms) => { setTimer(fn, ms); },
    });

    async function init() {
      const info = invoke ? await call('character_info', {}) : null;
      if (!info || info.mode === 'off') return;
      supported = true;
      controller.enabled = info.onDesktop === true;
      if (listen) {
        await listen('desktop-character-dropped', e => {
          const p = e && e.payload;
          if (!p || typeof p.home !== 'boolean' || (p.from !== 'island' && p.from !== 'desktop')) return;
          if (p.from === 'island') {
            carrying = false;
            if (p.home) setAway(false); else controller.installed();
          } else if (p.home) controller.flyHome();
        });
      }
    }
    return {
      init,
      canPickUp: () => supported && !carrying && controller.phase === 'home' && !controller.enabled,
      carrying: () => carrying,
      phase: () => controller.phase,
      /** (x, y): the pointer, island-window css px. */
      pickUp(x, y) {
        carrying = true;
        setAway(true);
        call('character_pick_up', { x, y }).then(ok => { if (ok !== true) { carrying = false; setAway(false); } });
      },
      carry(x, y) { if (carrying) call('character_carry', { x, y }); },
      carryEnd(x, y) { if (carrying) call('character_carry_end', { x, y }); },
      /** The shortcut: out to its spot, or home. Not in the middle of a drag out of the island. */
      flyOutOrHome() { if (supported && !carrying) controller.flyOutOrHome(); },
      launch() { if (supported) controller.launchFlyIfNeeded(); },
      snapshot(s) { last = s; controller.updateAlert(Logic.alertActive(s)); controller.updateState(getClayState ? getClayState() : null); },
    };
  }

  function mount() {
    if (typeof window === 'undefined' || !window.__TAURI__ || !window.__TAURI__.core) return null;
    const label = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.metadata && window.__TAURI_INTERNALS__.metadata.currentWindow && window.__TAURI_INTERNALS__.metadata.currentWindow.label;
    if (label !== 'main') return null; // the island only (the settings window runs other pages)
    const holder = { clay: null, reveal: null };
    const d = create({
      invoke: window.__TAURI__.core.invoke, listen: window.__TAURI__.event && window.__TAURI__.event.listen,
      clayEl: document.getElementById('clay'), getClayState: () => (holder.clay ? holder.clay.state : null),
      setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: id => clearTimeout(id),
      reveal: () => { if (holder.reveal) holder.reveal(); },
    });
    window.AbitoIslandDesktop = Object.freeze(Object.assign({ attach(o) { holder.clay = o.clay; holder.reveal = o.reveal; }, ready: d.init().then(() => d.launch()) }, d));
    return window.AbitoIslandDesktop;
  }
  return { create, pickUpDecision, mount };
});
