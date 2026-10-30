'use strict';
/* #347 R7 presentation controller. State/finite recovery mechanics informed by
   Coucou windows/src/mochi/engine.ts and island/island.ts, Copyright 2026
   Louis Raillé, MIT. No reserved character designs, eye paths, assets or audio.
   Public producer inputs only; no approval/answer/geometry authority. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AbitoCharacter = Object.freeze(api);
})(typeof self !== 'undefined' ? self : this, () => {
  const SLEEP_MS = 60000, FINISHED_MS = 1800, YAWN_MS = 58000, HOVER_DWELL_MS = 1900, HOVER_COOLDOWN_MS = 6000, GREETING_COOLDOWN_MS = 6000;
  const SHAKE_REVERSALS = 3, SHAKE_LEG_PX = 24, SHAKE_WINDOW_MS = 700, DIZZY_MS = 3300;
  function create(options) {
    const { clay, choosePose, validCard, notification } = options;
    // SN2: a permission the card shows with the approval look (the harness words it as kind 'question') is approval for Abito too
    const isApproval = typeof options.isApproval === 'function' ? options.isApproval : () => false;
    const now = options.now || Date.now;
    const setTimer = options.setTimer || setTimeout, clearTimer = options.clearTimer || clearTimeout;
    const applyState = options.applyState || (next => { if (clay && clay.state !== next) clay.setState(next); });
    const blocked = options.blocked || (() => false);
    let snapshot = null, question = null, chat = null, host = null, occupied = false, resting = false;
    let lastActivity = now(), finishedUntil = 0, timer = 0, destroyed = false;
    let baseline = false;
    // hold(): a transient surface (the Sileo toast) shows ONE explicit pose, nothing else. Presentation only, like the rest.
    let held = null;
    // Shake: horizontal back-and-forth of a pressed drag (screen x, so the moving window does not
    // hide it). Three reversals, each leg >= 24 px, inside 700 ms; once per press. Frontend only.
    let dragging = false, shakeFired = false, extreme = 0, dir = 0, reversals = [], dizzyUntil = 0;
    function resetShake() { dragging = false; shakeFired = false; dir = 0; reversals = []; }
    function shakeMove(x, at) {
      if (!dragging || shakeFired || !Number.isFinite(x)) return;
      if (dir === 0) { if (Math.abs(x - extreme) >= SHAKE_LEG_PX) { dir = x > extreme ? 1 : -1; extreme = x; } return; }
      if (dir * (x - extreme) > 0) { extreme = x; return; }
      if (Math.abs(x - extreme) >= SHAKE_LEG_PX) {
        dir = -dir; extreme = x; reversals.push(at);
        reversals = reversals.filter(t => at - t <= SHAKE_WINDOW_MS);
        if (reversals.length >= SHAKE_REVERSALS) {
          shakeFired = true; reversals = [];
          if (!occupied && !blocked() && producer() === 'idle') { dizzyUntil = at + DIZZY_MS; lastActivity = at; finishedUntil = 0; sync(); }
        }
      }
    }
    let hovering = false, hoverTimer = 0, lastLove = -Infinity, yawned = false, greeted = false, lastGreet = -Infinity;
    const emote = name => !!(clay && clay.triggerEmote && clay.triggerEmote(name));
    // Decorations only on a calm idle character; never over attention, a turn, a drag or reduced/hidden motion.
    const calm = () => !destroyed && !occupied && !blocked() && clay && clay.state === 'idle' && producer() === 'idle';
    function greet() { if (calm() && clay.greet && clay.greet()) { lastGreet = now(); return true; } return false; }
    function clearHover() { clearTimer(hoverTimer); hoverTimer = 0; }
    function armHover() {
      clearHover();
      if (!hovering) return;
      const wait = clay && clay.reaction === 'greeting' ? 100 : Math.max(HOVER_DWELL_MS, lastLove + HOVER_COOLDOWN_MS - now());
      hoverTimer = setTimer(() => { hoverTimer = 0;
        if (hovering && clay && clay.reaction === 'greeting') { armHover(); return; } // never stack on the greeting
        if (hovering && calm() && now() - lastLove >= HOVER_COOLDOWN_MS && emote('love')) lastLove = now(); }, Math.min(2147483647, wait));
    }
    const seen = new Set();
    const noticeKey = n => n && typeof n.id === 'string' && typeof n.sessionId === 'string' &&
      Number.isFinite(n.expiresAt) && n.expiresAt > now() ? JSON.stringify([n.sessionId, n.id]) : null;
    function attention() {
      const card = snapshot && snapshot.card;
      const expiry = card && Date.parse(card.expires_at);
      if (validCard(card) && card.state === 'pending' && expiry > now()) return { state: 'approval', expiry };
      const n = notification(question);
      if (n && (n.kind === 'approval' || n.kind === 'question') && n.expiresAt > now()) return { state: n.kind === 'question' && isApproval(n) ? 'approval' : n.kind, expiry: n.expiresAt };
      return null;
    }
    function producer() { const pending = attention(); return pending ? pending.state : choosePose(chat, host); }
    function sync() {
      if (destroyed) return;
      clearTimer(timer); timer = 0;
      if (held) { applyState(held); if (clay && clay.cancelReaction) clay.cancelReaction(); return; }
      const at = now(), source = producer(), pending = attention();
      // Urgent/active facts cancel decorations, never defer them until later.
      if (source !== 'idle' || blocked()) dizzyUntil = 0;
      if (source !== 'idle' || occupied || dragging || blocked()) { finishedUntil = 0; lastActivity = at; }
      let state = source;
      if (source === 'idle' && !blocked() && dizzyUntil > at) state = 'dizzy';
      else if (source === 'idle' && !occupied && !dragging && !blocked()) {
        if (finishedUntil > at) state = 'finished';
        else if (resting || at - lastActivity >= SLEEP_MS) state = 'sleeping';
      }
      applyState(state);
      if (state !== 'idle' && clay && clay.cancelReaction) clay.cancelReaction();
      if (at - lastActivity < YAWN_MS) yawned = false;
      else if (!yawned && state === 'idle' && source === 'idle' && !occupied && !blocked() && finishedUntil <= at) { yawned = true; emote('yawn'); }
      let due = Infinity;
      if (pending) due = pending.expiry;
      if (finishedUntil > at) due = Math.min(due, finishedUntil);
      if (dizzyUntil > at) due = Math.min(due, dizzyUntil);
      if (source === 'idle' && !occupied && !blocked() && state !== 'sleeping') due = Math.min(due, lastActivity + (yawned ? SLEEP_MS : YAWN_MS));
      // Browsers/Node coerce delays above signed int32 to 1 ms: cap, then recheck.
      if (Number.isFinite(due)) timer = setTimer(sync, Math.min(2147483647, Math.max(1, due - at)));
    }
    function observe(next) {
      snapshot = next || {};
      let fresh = false;
      for (const n of Array.isArray(snapshot.notices) ? snapshot.notices : []) {
        const key = noticeKey(n); if (!key) continue;
        if (baseline && !seen.has(key)) fresh = true;
        seen.add(key);
      }
      baseline = true;
      // Host store dedupes 256 identities; keep presentation memory bounded too.
      while (seen.size > 256) seen.delete(seen.values().next().value);
      if (fresh) {
        lastActivity = now();
        if (producer() === 'idle' && !occupied && !blocked()) finishedUntil = now() + FINISHED_MS;
      }
      sync();
      // Launch greeting: retried on later snapshots until greet() actually plays it once, then
      // never again. A refusal (urgent, busy, reduced/paused/hidden) is never forced and never
      // deferred onto a timer — only a later snapshot retries it.
      if (!greeted && snapshot.available !== false && greet()) greeted = true;
    }
    return {
      snapshot: observe,
      question(next) { question = next; lastActivity = now(); sync(); },
      chat(next) { chat = next === 'think' || next === 'speak' || next === 'error' ? next : null; sync(); },
      hold(next) { // a pose name holds it (no sleep, greeting or emote); null releases to the normal producer
        if (next === null) { held = null; sync(); } else if (typeof next === 'string' && /^[a-z]{2,16}$/.test(next)) { held = next; sync(); }
      },
      rest(on) { resting = !!on; sync(); }, // S5: the empty island («Todo tranquilo») shows Abito asleep
      host(next) { host = next === 'error' ? next : null; sync(); },
      busy(value) { occupied = !!value; lastActivity = now(); sync(); },
      activity() { lastActivity = now(); finishedUntil = 0; sync(); },
      motionChanged() { lastActivity = now(); finishedUntil = 0; sync(); },
      get state() { return clay ? clay.state : producer(); },
      dragStart(x) { resetShake(); dragging = true; extreme = x; if (clay && clay.cancelReaction) clay.cancelReaction(); lastActivity = now(); clearHover(); sync(); },
      dragMove(x) { shakeMove(x, now()); },
      dragEnd() { resetShake(); lastActivity = now(); sync(); },
      hover(inside) {
        inside = !!inside; if (inside === hovering) return;
        hovering = inside;
        if (inside) { if (now() - lastGreet >= GREETING_COOLDOWN_MS && greet()) lastGreet = now(); armHover(); }
        else { clearHover(); if (clay && clay.reaction === 'love' && clay.cancelReaction) clay.cancelReaction(); }
      },
      destroy() { destroyed = true; held = null; clearTimer(timer); timer = 0; clearHover(); },
    };
  }
  return { create, SLEEP_MS, FINISHED_MS, DIZZY_MS, YAWN_MS, HOVER_DWELL_MS, HOVER_COOLDOWN_MS, GREETING_COOLDOWN_MS };
});
