'use strict';
/* #486 — the desktop character's pure logic. Adapted from Coucou windows/src/mochi/desktop-logic.ts
   @71b773f (port of NotchBuddy DesktopMochiLogic.swift / DesktopMochiController),
   Copyright (c) 2026 Louis Raillé, MIT. No DOM, no Tauri: island-desktop.js wires it to the app and
   the character window draws Abito's clay character (never Mochi art, LICENSE-ASSETS.md). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = Object.freeze(api);
  else root.AbitoCharacterDesktop = Object.freeze(api);
})(typeof self !== 'undefined' ? self : this, () => {
  const PANEL_SIZE = 120;
  const SLEEP_TIMEOUT = 120;
  const SLEEP_MOUSE_DISTANCE = 150;
  const BODY_RADIUS_FRACTION = 0.24;
  /** Surprised, then off to the island (0.45 s). */
  const RETRACT_DELAY_MS = 450;
  /** Pause in the island after the alert is answered, before flying back (0.6 s). */
  const RETURN_DELAY_MS = 600;
  const DOUBLE_CLICK_MS = 300;
  /** A press that moves farther than this is a drag, not a click. */
  const DRAG_THRESHOLD = 3;

  const shouldSleep = (sinceAgentActive, mouseDistance) => sinceAgentActive > SLEEP_TIMEOUT && mouseDistance >= SLEEP_MOUSE_DISTANCE;
  function isOverBody(local, size = PANEL_SIZE) {
    const c = size / 2, r = size * BODY_RADIUS_FRACTION, dx = local.x - c, dy = local.y - c;
    return dx * dx + dy * dy <= r * r;
  }
  /** BotCanvasView.lookX / lookY: x right +, y up +. */
  function gaze(bot, mouse) {
    return { lookX: Math.tanh((mouse.x - bot.x) / 260), lookY: -Math.tanh((mouse.y - bot.y) / 200) };
  }
  /** The island's card waiting for an answer, or a question by notification (Coucou `alertActive`). */
  function alertActive(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return false;
    const card = snapshot.card;
    if (card && typeof card === 'object' && card.state === 'pending') return true;
    return !!snapshot.pending && snapshot.available !== false;
  }

  /** Everything the life cycle does to the world is injected so it can be tested. */
  function create(port) {
    const self = {
      phase: 'home', // home | flyingOut | onDesktop | retracting | alertResolvedDuringRetract | atNotchForAlert
      enabled: false, // lives on the desktop (the saved preference)
    };
    let lastState = null;
    let alertWas = false;

    async function launchFlyIfNeeded(anywhere = false) {
      if (!self.enabled || self.phase !== 'home') return;
      if (port.alertActive()) { self.phase = 'atNotchForAlert'; return; }
      self.phase = 'flyingOut';
      port.setAway(true);
      const ok = await port.flyOut(anywhere);
      if (self.phase !== 'flyingOut') return;
      if (!ok) { self.phase = 'home'; self.enabled = false; port.setAway(false); return; }
      landed();
    }
    function installed() {
      if (self.phase !== 'home') return;
      self.enabled = true;
      port.setAway(true);
      port.emote('happy');
      landed();
    }
    async function flyHome() {
      if (!['onDesktop', 'retracting', 'alertResolvedDuringRetract'].includes(self.phase)) return;
      self.phase = 'home';
      self.enabled = false;
      await port.flyHome(true);
      port.setAway(false);
    }
    async function flyOutOrHome() {
      if (self.phase === 'home') { self.enabled = true; await launchFlyIfNeeded(true); }
      else if (self.phase === 'onDesktop') await flyHome();
    }
    function updateAlert(active) {
      if (active === alertWas) return;
      alertWas = active;
      if (active) { if (self.phase === 'onDesktop') beginRetract(); return; }
      if (self.phase === 'atNotchForAlert') {
        self.phase = 'home';
        port.later(() => launchFlyIfNeeded(), RETURN_DELAY_MS);
      } else if (self.phase === 'retracting') self.phase = 'alertResolvedDuringRetract';
    }
    function updateState(state) {
      const prev = lastState;
      lastState = state;
      if (prev == null || prev === state) return;
      if (state === 'finished' && self.phase === 'onDesktop') port.emote('happy');
    }
    function landed() {
      self.phase = 'onDesktop';
      alertWas = !!port.alertActive();
      if (alertWas) beginRetract();
    }
    function beginRetract() {
      port.emote('surprised');
      self.phase = 'retracting';
      port.later(() => {
        if (self.phase === 'retracting') return retractForAlert();
        if (self.phase === 'alertResolvedDuringRetract') self.phase = 'onDesktop';
        return undefined;
      }, RETRACT_DELAY_MS);
    }
    async function retractForAlert() {
      await port.flyHome(false);
      port.setAway(false);
      if (self.phase === 'alertResolvedDuringRetract') { self.phase = 'home'; await launchFlyIfNeeded(); }
      else if (self.phase === 'retracting') { self.phase = 'atNotchForAlert'; port.revealIsland(); }
    }
    return Object.assign(self, { launchFlyIfNeeded, installed, flyHome, flyOutOrHome, updateAlert, updateState });
  }

  return {
    PANEL_SIZE, SLEEP_TIMEOUT, SLEEP_MOUSE_DISTANCE, BODY_RADIUS_FRACTION, RETRACT_DELAY_MS, RETURN_DELAY_MS,
    DOUBLE_CLICK_MS, DRAG_THRESHOLD, shouldSleep, isOverBody, gaze, alertActive, create,
  };
});
