'use strict';
/* #313 — the island's half of the sound wiring. The engine (sound-engine.js, vendored from apps/desktop-sound)
   only turns a cue id into audio. THIS file decides WHEN: it feeds the engine the human's preference, tells it when
   the first snapshot is on screen, opens a quiet window on reconnect, and turns real island EVENTS into cue ids.

   Rules it keeps (docs/desktop-sound-catalog.md §2, odd/tasks/island-sounds.md):
   - A cue follows a TRANSITION, never a state. The first sight of anything is a baseline, not an event, so old
     turns, a model that is already down and a notice that was already there at start-up make no sound.
   - Sound is ON by default (the human's stored preference, if any, wins; Rust sends it in `prefs_action view`), but
     SILENCE is the engine's failure mode: it plays nothing until applyPrefs({v:1,sound:true}) AND
     ready(). If a cue is dropped for one of those two reasons the page logs engine.state() ONCE, so a forgotten
     condition is visible instead of silently muting everything.
   - It never listens to the character's pose and never to «Enviada»/«Sin confirmar»: those do not sound.
   Page cue contract (no bubbling required):
   document.dispatchEvent(new CustomEvent('abito:cue', { detail: 'snd.pop' }));
   detail is the exact cue-id string, not an object. Use snd.pop after picking an option,
   snd.tick on attachment progress / shortcut toggle-on. Producers are not installed here.
   All cues pass through engine preference, gain, quiet, priority and rate gates.
   Loaded as a classic script (window.AbitoSoundWiring) and by test-node/sound-wiring-check.cjs. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AbitoSoundWiring = api;
})(typeof self !== 'undefined' ? self : this, () => {
  const RECONNECT_QUIET_MS = 3000;
  const ACTIVE = new Set(['queued', 'thinking', 'streaming']);

  function wire(options) {
    const o = options || {};
    const engine = o.engine;
    const doc = o.document;
    let disposed = false;
    const cleanups = [];
    const listen = typeof o.listen === 'function' ? (name, fn) => {
      const subscription = o.listen(name, e => { if (!disposed) fn(e); });
      Promise.resolve(subscription).then(off => {
        if (typeof off !== 'function') return;
        if (disposed) off(); else cleanups.push(off);
      }).catch(() => {});
      return subscription;
    } : null;
    const now = typeof o.now === 'function' ? o.now : Date.now;
    const setTimer = typeof o.setTimer === 'function' ? o.setTimer : (fn, ms) => setTimeout(fn, ms);
    const clearTimer = typeof o.clearTimer === 'function' ? o.clearTimer : h => clearTimeout(h);
    function onDocument(name, fn) {
      if (!doc || typeof doc.addEventListener !== 'function') return;
      const handler = e => { if (!disposed) fn(e); };
      doc.addEventListener(name, handler);
      cleanups.push(() => { if (typeof doc.removeEventListener === 'function') doc.removeEventListener(name, handler); });
    }
    const log = typeof o.log === 'function' ? o.log : () => {};
    let warned = false;

    // ---- the engine never rejects, but a dropped cue for a WIRING reason is worth ONE line --------------------
    function request(id) {
      if (disposed) return undefined;
      let result;
      try { result = engine.play(id); } catch { return undefined; }
      if (result && typeof result.then === 'function') {
        result.then(r => {
          if (!warned && r && (r.reason === 'disabled' || r.reason === 'not_ready')) {
            warned = true;
            try { log(`sound: ${r.reason} ${JSON.stringify(engine.state())}`); } catch { /* diagnostics must never throw */ }
          }
        }, () => {});
      }
      return result;
    }

    // ---- 1) the page's own events become `engine.play` ------------------------------------------------------------
    onDocument('abito:cue', e => { request(e && e.detail); });

    // The host DTO is deliberately unversioned; adapt only this seam, not other consumers.
    // Explicit versions still fail closed unless v1. Gain uses the engine's separate API.
    const applyPrefs = payload => {
      try {
        const valid = payload && typeof payload === 'object' && !Array.isArray(payload)
          && (payload.v === undefined || payload.v === 1);
        const gain = valid && typeof payload.gain === 'number' && Number.isFinite(payload.gain)
          && payload.gain >= 0 && payload.gain <= 0.2 ? payload.gain : 0.12;
        engine.setGain(gain);
        engine.applyPrefs({ v: 1, sound: !!valid && payload.sound === true });
      } catch { /* no audio capability: silence */ }
    };
    if (listen) {
      try { listen('prefs:state', e => applyPrefs(e && e.payload)); } catch { /* no event bus: stays silent */ }
    }

    // Optional custom files: closed stems, <=2 MiB (the host's MAX_BYTES), no paths or MIME trust.
    const stems = ['notice', 'attention', 'confirm', 'reject', 'error', 'sent', 'think', 'reply', 'listen', 'expired',
      'open', 'close', 'peek', 'hover', 'pop', 'tick', 'love',
      'blip', 'slap', 'annoyed', 'dizzy', 'greet', 'work', 'finish', 'approval', 'question', 'approve',
      'gulp', 'send', 'proud', 'wink', 'yawn', 'attach', 'search', 'rate', 'sleep', 'greeting'];
    const invoke = typeof o.invoke === 'function' ? o.invoke : null;
    let sampleLoad = Promise.resolve();
    async function reloadSamples() {
      if (disposed) return;
      try {
        engine.clearSamples(); // removal, read/decode/list failure all restore built-ins
        const c = o.getAudioContext();
        if (!c || typeof c.decodeAudioData !== 'function') return;
        const listed = await invoke('sound_action', { payload: { action: 'list' } });
        const names = listed && Array.isArray(listed.names) ? listed.names : [];
        // Iterate our list, not host input: bounded to thirty-seven unique reads.
        for (const name of stems) {
          if (disposed) return;
          if (!names.includes(name)) continue;
          try {
            const file = await invoke('sound_action', { payload: { action: 'read', name } });
            const data = file && file.data;
            if (typeof data !== 'string' || !data.length || data.length > 4 * Math.ceil(2097152 / 3)
                || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) continue;
            const raw = o.decodeBase64(data);
            if (!raw.length || raw.length > 2097152) continue;
            const bytes = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
            const buffer = await c.decodeAudioData(bytes.buffer);
            if (!disposed) engine.setSample('snd.' + name, buffer);
          } catch { /* a missing or undecodable file leaves the synthesized cue */ }
        }
      } catch { /* host/audio unavailable: never break the island */ }
    }
    // Serialize reloads so a slow earlier decode cannot resurrect a removed override.
    function queueSamples() { sampleLoad = sampleLoad.then(reloadSamples, reloadSamples); }
    if (invoke && typeof o.getAudioContext === 'function' && typeof o.decodeBase64 === 'function') {
      queueSamples();
      if (listen) {
        try {
          const subscription = listen('sounds:changed', queueSamples);
          if (subscription && typeof subscription.catch === 'function') subscription.catch(() => {});
        } catch { /* optional event bus */ }
      }
    }

    // ---- 3) start-up / reconnect --------------------------------------------------------------------------------
    let chatSeen = null;   // turn_id -> last state we saw; null = no baseline yet
    let noticeTop;         // undefined = no baseline yet
    let cardSeen;          // undefined = no baseline yet
    let desktopSeen;
    let cancelHover = () => {};
    let started = false;
    function firstSnapshotRendered() {
      if (started) return;
      started = true;
      try { engine.ready(); } catch { /* silence */ }
    }
    function reconnected() {
      try { engine.quiet(RECONNECT_QUIET_MS); engine.resetTransitions(); } catch { /* silence */ }
      chatSeen = null; noticeTop = undefined; cardSeen = undefined; desktopSeen = undefined;
      cancelHover();
    }

    // Host Snapshot.state, not animated data-phase or Snapshot.view.
    function observeDesktop(payload) {
      if (disposed || !payload || typeof payload !== 'object' || Array.isArray(payload)
          || !['compact', 'expanded', 'hidden'].includes(payload.state)) return;
      const next = payload.state, before = desktopSeen;
      desktopSeen = next;
      if (before === undefined || before === next) return;
      if (before === 'hidden') request('snd.peek'); // reveal wins over open; one cue only
      else if (before === 'expanded') request('snd.close');
      else if (next === 'expanded') request('snd.open');
    }
    if (listen) { try { listen('desktop:state', e => observeDesktop(e && e.payload)); } catch { /* optional */ } }

    // Character hover is an edge of --hover, never the character's pose.
    const clay = doc && typeof doc.getElementById === 'function' ? doc.getElementById('clay') : null;
    const Observer = o.MutationObserver || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
    if (clay && typeof Observer === 'function') {
      const isHovered = () => Number(clay.style.getPropertyValue('--hover')) > 1;
      let hovered = isHovered(), timer = null, lastLove = -Infinity;
      const cancel = () => { if (timer !== null) clearTimer(timer); timer = null; };
      cancelHover = () => { cancel(); hovered = isHovered(); };
      const observer = new Observer(() => {
        if (disposed) return;
        const next = isHovered();
        if (next === hovered) return;
        hovered = next;
        cancel();
        if (!next) return;
        request('snd.hover'); // the engine's same-id gate bounds quick reentries
        timer = setTimer(() => {
          timer = null;
          if (disposed || !hovered || !isHovered() || now() - lastLove < 6000) return;
          lastLove = now(); // one attempt per entry, no delayed replay after quiet/off
          request('snd.love');
        }, 1900);
      });
      observer.observe(clay, { attributes: true, attributeFilter: ['style'] });
      cleanups.push(() => { cancel(); observer.disconnect(); });
    }
    function dispose() {
      if (disposed) return;
      disposed = true;
      for (const off of cleanups.splice(0)) { try { off(); } catch { /* best effort */ } }
    }

    // ---- 4) chat: the model going down, and the turns ------------------------------------------------------------
    function observeChat(view) {
      if (!view || typeof view !== 'object') return undefined;
      const down = !!view.availability && (view.availability.state === 'unavailable' || view.availability.state === 'blocked');
      // «enters the state»: the engine remembers the baseline per key and only sounds false -> true
      let modelCue;
      try { modelCue = engine.transition('model-error', down, 'snd.error'); } catch { modelCue = undefined; }
      const turns = Array.isArray(view.turns) ? view.turns : [];
      if (chatSeen === null) {            // first snapshot, or the first after a reconnect: history, not events
        chatSeen = new Map();
        for (const t of turns) if (t && typeof t.turn_id === 'string') chatSeen.set(t.turn_id, t.state);
        return modelCue;
      }
      for (const t of turns) {
        if (!t || typeof t.turn_id !== 'string') continue;
        const before = chatSeen.get(t.turn_id);
        if (before === t.state) continue;
        chatSeen.set(t.turn_id, t.state);
        if (before === undefined && ACTIVE.has(t.state)) request('snd.sent');          // a NEW turn of the human's
        if (t.state === 'thinking' && before !== 'thinking') request('snd.think');     // once per turn
        if (t.state === 'completed' && before !== 'completed') request('snd.reply');   // the stream ended
        if (t.state === 'error' && before !== 'error') request('snd.error');           // ended in error, not reply
      }
      if (chatSeen.size > 200) chatSeen = new Map(turns.filter(t => t && typeof t.turn_id === 'string').map(t => [t.turn_id, t.state]));
      return modelCue;
    }

    // ---- 5) a NEW notice in the overview (never the ones that were there at start-up) --------------------------
    function observeNotices(notices) {
      const list = Array.isArray(notices) ? notices : [];
      const top = list.length && list[0] && typeof list[0].id === 'string' ? list[0].id : null;
      if (noticeTop === undefined) { noticeTop = top; return; }
      if (top !== null && top !== noticeTop) request('snd.notice');
      noticeTop = top;
    }

    // ---- 6) an approval card that becomes pending (a question is handled by notify.js through soundFor) ---------
    function observeCard(cardId) {
      const id = typeof cardId === 'string' && cardId ? cardId : null;
      if (cardSeen === undefined) { cardSeen = id; return; }
      if (id !== null && id !== cardSeen) request('snd.attention');
      cardSeen = id;
    }

    // ---- 7) reconnects the page can see: the engine connection coming back after it was lost ---------------------
    if (listen) {
      let wasUp = null;
      try {
        listen('agent:state', e => {
          const up = !!(e && e.payload && e.payload.connection === 'connected');
          if (wasUp === false && up) reconnected();
          if (wasUp === null || up !== wasUp) wasUp = up;
        });
      } catch { /* optional */ }
    }
    // The page resuming re-baselines without replaying accumulated events.
    onDocument('visibilitychange', () => { if (doc.visibilityState === 'visible') reconnected(); });

    return { firstSnapshotRendered, reconnected, observeChat, observeNotices, observeCard, applyPrefs, observeDesktop, dispose,
      samplesLoaded: () => sampleLoad };
  }

  // ---- the real page: one instance, started on load ----------------------------------------------------------------
  function boot(win) {
    const E = win.AbitoSound;
    if (!E || typeof E.createSoundEngine !== 'function') return null;
    let context = null;
    const C = win.AudioContext || win.webkitAudioContext;
    const getAudioContext = () => {
      if (!context) { if (!C) return null; context = new C(); }
      return context;
    };
    const engine = E.createSoundEngine({ enabled: false, createContext: getAudioContext, onDiagnostic: reason => { try { console.debug('sound:', reason); } catch { /* none */ } } });
    const listen = win.__TAURI__ && win.__TAURI__.event && win.__TAURI__.event.listen;
    const invoke = (win.__TAURI__ && win.__TAURI__.core && win.__TAURI__.core.invoke)
      || (win.__TAURI_INTERNALS__ && win.__TAURI_INTERNALS__.invoke) || null;
    const wiring = wire({ engine, document: win.document, listen: listen ? (n, f) => listen(n, f) : null,
      invoke, getAudioContext: C ? getAudioContext : null,
      decodeBase64: typeof win.atob === 'function' ? s => win.atob(s) : null,
      log: line => console.debug(line) });
    // the persisted preference, once: `prefs:state` only arrives on a CHANGE
    if (invoke) invoke('prefs_action', { payload: { action: 'view' } }).then(p => wiring.applyPrefs(p), () => {});
    win.AbitoSoundWiringInstance = wiring;
    return wiring;
  }
  if (typeof window !== 'undefined' && window.document) {
    const start = () => boot(window);
    if (window.document.readyState === 'loading') window.document.addEventListener('DOMContentLoaded', start); else start();
  }

  return { RECONNECT_QUIET_MS, wire, boot };
});
