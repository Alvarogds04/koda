'use strict';
/* #336 policy/scheduler only. This module never owns native phase, geometry,
   click-vs-drag classification, focus, persistence or approval admission.
   T1b must supply current host/UI facts and atomically guarded host callbacks. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AbitoIslandInteraction = api;
})(typeof window === 'object' ? window : globalThis, function () {
  const DEFAULTS = Object.freeze({ autoCloseSeconds: 15, openOnHover: false });
  const HOVER_DELAY_MS = 600;
  // G16: whole seconds the FOLDED island waits before it hides at the edge (Ajustes -> General -> «Ocultar tras»).
  const EDGE_ABSENCE = Object.freeze({ min: 5, max: 300, default: 10 });
  const EDGE_BLOCKERS = Object.freeze(['question', 'approval', 'request', 'decision', 'card']);
  const BLOCKERS = Object.freeze(['question', 'approval', 'request', 'decision', 'card',
    'dragging', 'editing', 'composing', 'draft', 'settings', 'models']);

  // #438: accepted values are {0} («Nunca») ∪ 5..=120 — the same closed shape
  // the stored contract now knows. Everything else is refused.
  function validPreferences(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value) &&
      Object.keys(value).sort().join(',') === 'autoCloseSeconds,openOnHover' &&
      Number.isInteger(value.autoCloseSeconds) &&
      (value.autoCloseSeconds === 0 || (value.autoCloseSeconds >= 5 && value.autoCloseSeconds <= 120)) &&
      typeof value.openOnHover === 'boolean';
  }

  // Missing guard facts are not permission. This is only a local policy check;
  // the host MUST recheck live protected state atomically when applying a plan.
  function clearGuards(facts) {
    return !!facts && facts.view === 'overview' && facts.settled === true && facts.nativeReady === true &&
      BLOCKERS.every(key => facts[key] === false);
  }
  function eligible(facts) { return clearGuards(facts) && facts.state === 'expanded'; }

  function createClock(read) {
    if (typeof read !== 'function') throw new TypeError('Clock required.');
    let last = 0;
    return () => {
      const raw = read();
      // Leave enough exact integer range for the largest relative deadline.
      if (Number.isFinite(raw)) last = Math.max(last, Math.min(raw, Number.MAX_SAFE_INTEGER - 120000));
      return last;
    };
  }

  function countdown(deadline, now, seconds) {
    // #438: «Nunca» (0) never produces a countdown object — its window would be
    // a zero-length bar of NaN noise, and the bar must stay away entirely.
    if (!Number.isFinite(deadline) || !Number.isFinite(now) || seconds === 0 ||
      !validPreferences({ autoCloseSeconds: seconds, openOnHover: false })) return null;
    const remainingMs = Math.max(0, Math.min(120000, deadline - now));
    const windowMs = Math.min(10000, seconds * 600);
    return { remainingMs, seconds: Math.ceil(remainingMs / 1000),
      fraction: Math.min(1, remainingMs / windowMs), visible: remainingMs > 0 && remainingMs <= windowMs };
  }

  // #419: pure decoration renderer for the published countdown values. The
  // module still owns no DOM, listeners or rendering lifecycle: the adapter
  // creates the view with its approved element and feeds it from onCountdown.
  // update(null) and any value without a visible:true finite fraction hide
  // the element; a visible value shows it and writes the clamped fraction as
  // a CSS custom property (style.setProperty, CSP-safe). It never throws on
  // values and never reads native/window state.
  function createCountdownView(element) {
    if (!element || typeof element !== 'object' || !element.style ||
      typeof element.style.setProperty !== 'function')
      throw new TypeError('Countdown view element required.');
    function update(value) {
      if (!value || typeof value !== 'object' || value.visible !== true ||
        !Number.isFinite(value.fraction)) { element.hidden = true; return; }
      element.hidden = false;
      element.style.setProperty('--island-countdown-fraction',
        String(Math.min(1, Math.max(0, value.fraction))));
    }
    return Object.freeze({ update });
  }

  function mouse(event) {
    return !!event && event.isTrusted === true && event.pointerType === 'mouse' && event.buttons === 0;
  }
  function deliberate(event) {
    if (!event || event.isTrusted !== true) return false;
    if (event.type === 'click') return event.button === 0;
    return event.type === 'keydown' && typeof event.key === 'string' && event.key.length > 0 &&
      !['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock', 'Unidentified', 'Process', 'Dead'].includes(event.key) &&
      event.repeat !== true && event.isComposing !== true && event.keyCode !== 229;
  }

  function createController(options) {
    for (const key of ['now', 'schedule', 'cancel', 'open', 'autoClose', 'onCountdown']) {
      if (!options || typeof options[key] !== 'function') throw new TypeError(`Interaction callback required: ${key}.`);
    }
    const now = createClock(options.now);
    let preferences = DEFAULTS, facts = {}, inside = false, hoverOnly = false;
    let timer = null, deadline = null, stopped = false, opening = false, closing = false;
    let exhausted = false, generation = 0, timerGeneration = 0, published = 'null';
    let pinned = false, closeFailures = 0;

    function emit(value) {
      const key = JSON.stringify(value);
      if (key !== published) { published = key; options.onCountdown(value); }
    }
    function cancelTimer() {
      timerGeneration++;
      if (timer !== null) options.cancel(timer);
      timer = null;
    }
    function clearDeadline() { cancelTimer(); deadline = null; emit(null); }
    function invalidate() { generation++; opening = false; closing = false; }

    // Promise settlement conveys no phase/focus/approval evidence. Only update()
    // can supply authoritative state; generation prevents late resurrection.
    function request(kind) {
      const epoch = generation;
      if (kind === 'open') opening = true; else closing = true;
      function settled(ok) {
        if (stopped || epoch !== generation) return;
        if (kind === 'open') {
          opening = false;
          if (!ok) { hoverOnly = false; exhausted = true; }
          reconcile();
        } else {
          closing = false;
          if (ok) { closeFailures = 0; return; }
          // The host refused (or failed) the close. It used to be spent for the rest of the expansion, so ONE transient refusal
          // disabled the auto-close for good. Now the CLOCK retries it on a backoff (one period, then x2, capped at 120 s); snapshot
          // churn never does, and a user action or a fresh expansion starts again at one period.
          closeFailures++;
          const seconds = preferences.autoCloseSeconds;
          if (seconds === 0 || !eligible(facts)) return;
          exhausted = false;
          deadline = now() + Math.min(120000, seconds * 1000 * 2 ** (closeFailures - 1));
          reconcile();
        }
      }
      try { Promise.resolve(options[kind]()).then(() => settled(true), () => settled(false)); }
      catch { settled(false); }
    }

    function reconcile(restart = false) {
      if (stopped) return;
      if (restart) { cancelTimer(); deadline = null; }
      if (pinned || !eligible(facts) || inside || opening || closing || exhausted) { clearDeadline(); return; }
      const seconds = preferences.autoCloseSeconds;
      // #438: 0 («Nunca») disables ONLY the inactivity close. A pinned/clicked-open
      // island never gets a deadline and never publishes a countdown. The hover-open
      // grace below is the hover contract, not inactivity, and still closes.
      if (seconds === 0 && !hoverOnly) { clearDeadline(); return; }
      const time = now();
      if (deadline === null) deadline = time + (hoverOnly ? HOVER_DELAY_MS : seconds * 1000);
      // #438: with «Nunca» only the hover grace reaches here; countdown() is never
      // called with 0 seconds, so the grace publishes NO countdown at all.
      const value = seconds === 0 ? null : countdown(deadline, time, seconds);
      const remainingMs = deadline - time;
      const epoch = generation, due = deadline;
      if (remainingMs <= 0) {
        exhausted = true; clearDeadline();
        if (!stopped && epoch === generation && deadline === null && eligible(facts) && !inside && !opening && !closing)
          request('autoClose');
        return;
      }
      emit(value);
      // Publication may synchronously close/stop, change guards or re-arm.
      if (stopped || epoch !== generation || due !== deadline || !eligible(facts) ||
        inside || opening || closing || exhausted || timer !== null) return;
      // #438: with «Nunca» there is no countdown window — 0 is never a windowMs.
      const windowMs = value === null ? 0 : Math.min(10000, seconds * 600);
      // Sleep until the final countdown window, then integer-second changes.
      // Relative bounded delays avoid epoch/future-date timeout overflow.
      const delay = remainingMs > windowMs ? remainingMs - windowMs :
        Math.min(remainingMs, remainingMs % 1000 || 1000);
      const serial = ++timerGeneration;
      timer = options.schedule(() => {
        if (stopped || serial !== timerGeneration) return;
        timer = null; reconcile();
      }, Math.max(1, Math.min(120000, delay)));
    }

    function update(next) {
      if (stopped) return;
      const before = eligible(facts), previousState = facts.state;
      facts = next && typeof next === 'object' ? { ...next } : {};
      // A pointerleave can be swallowed (the native input shape changes under the pointer; remote desktops drop it). The live
      // :hover hit-test is the truth: when it says the pointer is NOT over the island, an `inside` that never got its leave is
      // stale and must not hold the island open forever. It never turns `inside` ON (only a real enter does, for hover-open).
      if (inside && facts.pointerInside === false) inside = false;
      if ((previousState === 'expanded' && facts.state !== 'expanded') || facts.state === 'hidden') {
        hoverOnly = false; pinned = false; invalidate(); clearDeadline();
      }
      if (!before && eligible(facts)) { exhausted = false; closeFailures = 0; }
      reconcile();
    }
    function setPreferences(next) {
      if (stopped) return;
      if (!validPreferences(next)) throw new TypeError('Invalid island interaction preferences.');
      const changedDelay = preferences.autoCloseSeconds !== next.autoCloseSeconds;
      preferences = Object.freeze({ ...next });
      reconcile(changedDelay && deadline !== null && !hoverOnly);
    }
    function enter(event) {
      if (stopped || !mouse(event) || inside) return false;
      inside = true; exhausted = false; clearDeadline();
      if (!preferences.openOnHover || facts.state !== 'compact' || !clearGuards(facts) || opening) return false;
      // Coucou mouseEntered: open immediately. The 600ms delay belongs only
      // to mouseLeft on an island opened by hover, never to entry.
      hoverOnly = true; request('open'); return true;
    }
    function leave(event) {
      if (stopped || !mouse(event) || !inside) return false;
      inside = false; exhausted = false;
      reconcile(); return true;
    }
    function engage(event) {
      if (stopped || !deliberate(event) || facts.state !== 'expanded') return false;
      const consumedHover = hoverOnly;
      hoverOnly = false; exhausted = false; closeFailures = 0; reconcile(true);
      // Native adapter uses this intent, but still classifies real short-click
      // versus drag itself. This return value is NOT permission to cancel drag.
      return consumedHover;
    }
    function togglePin(event) {
      if (stopped || !deliberate(event) || !eligible(facts)) return false;
      pinned = !pinned; hoverOnly = false; exhausted = false;
      reconcile(true); return true;
    }
    function reset() {
      if (stopped) return;
      invalidate(); hoverOnly = false; pinned = false; exhausted = true; clearDeadline();
    }
    function stop() {
      if (stopped) return;
      stopped = true; invalidate(); hoverOnly = false; pinned = false; exhausted = true; clearDeadline();
    }
    // WHY the island is (not) closing, as one short word for the live preview to show (capsule.dataset.autoClose).
    function why() {
      if (stopped) return 'detenido';
      if (!facts || Object.keys(facts).length === 0) return 'sin-hechos';
      if (facts.state !== 'expanded') return `estado:${facts.state}`;
      if (facts.view !== 'overview') return `vista:${facts.view}`;
      if (facts.settled !== true) return 'sin-asentar';
      if (facts.nativeReady !== true) return 'nativo-no-listo';
      const blocker = BLOCKERS.find(key => facts[key] !== false);
      if (blocker) return blocker;
      if (pinned) return 'fijada';
      if (inside) return 'puntero-dentro';
      if (opening) return 'abriendo';
      if (closing) return 'cerrando';
      if (preferences.autoCloseSeconds === 0 && !hoverOnly) return 'nunca';
      if (deadline === null) return exhausted ? 'agotado' : 'sin-plazo';
      const left = Math.max(0, Math.ceil((deadline - now()) / 1000));
      return closeFailures > 0 ? `rechazado:reintento ${left}s` : `armado:${left}s`;
    }
    function snapshot() {
      return { why: why(), preferences: { ...preferences }, inside, hoverOnly, pinned, deadline, stopped, opening, closing,
        eligible: eligible(facts), countdown: deadline === null ? null : countdown(deadline, now(), preferences.autoCloseSeconds) };
    }
    return Object.freeze({ update, setPreferences, enter, leave, engage, togglePin, reset, stop, snapshot });
  }
  // L40: visual concealment only, never native Hide or card admission.
  function createEdgeController(options) {
    const now = createClock(options.now);
    let facts = {}, inside = false, hidden = false, stopped = false;
    let sound = true, seconds = EDGE_ABSENCE.default, timer = null, generation = 0;
    function cancel() { generation++; if (timer !== null) options.cancel(timer); timer = null; }
    function show(value) { if (hidden !== value) { hidden = value; options.onHidden(value); } }
    // Human: «solo lo frena una pregunta pendiente». The edge hide waits only for a pending question/permission (a queued one is the
    // same flag: the head is pending) and for a pointer over the island. Status notices («Sin motor», the hotkey chip, a downed
    // bridge), a pin, a draft, an open field or panel, a drag and the stale `data-view` of a just-folded island do not.
    // A missing `state`/`settled`/`nativeReady`/`question` fact is still not permission (fail closed).
    function why() {
      if (stopped) return 'stopped';
      if (facts.state !== 'compact') return `state:${facts.state}`;
      if (facts.settled !== true) return 'unsettled';
      if (facts.nativeReady !== true) return 'native';
      const blocker = EDGE_BLOCKERS.find(key => facts[key] !== false);
      if (blocker) return blocker;
      return inside ? 'pointer' : 'clear';
    }
    function allowed() { return why() === 'clear'; }
    function reconcile(restart = false) {
      if (stopped) return;
      if (restart) cancel();
      if (!allowed()) { cancel(); show(false); return; }
      if (hidden || timer !== null) return;
      const serial = ++generation;
      const due = now() + (sound ? seconds * 1000 : 1000);
      function deliver() {
        if (stopped || serial !== generation) return;
        timer = null;
        if (!allowed()) return;
        const remaining = due - now();
        // Browser timers can deliver a fraction early. Preserve the deadline,
        // rather than silently spending the hide or restarting a full delay.
        if (remaining > 0) timer = options.schedule(deliver, Math.max(1, remaining));
        else show(true);
      }
      timer = options.schedule(deliver, Math.max(1, due - now()));
    }
    return Object.freeze({
      update(next) { if (!stopped) { facts = { ...next }; if (typeof facts.pointerInside === 'boolean') inside = facts.pointerInside; reconcile(); } },
      setPreferences(p) {
        if (stopped) return;
        if (!p || typeof p.sound !== 'boolean' || !Number.isInteger(p.absenceSeconds) || p.absenceSeconds < EDGE_ABSENCE.min || p.absenceSeconds > EDGE_ABSENCE.max) throw new TypeError('Invalid absence preferences.');
        const changed = sound !== p.sound || seconds !== p.absenceSeconds;
        sound = p.sound; seconds = p.absenceSeconds; reconcile(changed);
      },
      enter(event) { if (!stopped && mouse(event)) { inside = true; reconcile(); } },
      leave(event) { if (!stopped && mouse(event)) { inside = false; reconcile(true); } },
      alert() { if (!stopped) { cancel(); show(false); reconcile(); } },
      stop() { stopped = true; cancel(); },
      snapshot() { return { hidden, inside, why: why() }; },
    });
  }
  return Object.freeze({ DEFAULTS, HOVER_DELAY_MS, BLOCKERS, EDGE_ABSENCE, EDGE_BLOCKERS, validPreferences, eligible, createClock, countdown, createCountdownView, createController, createEdgeController });
});
