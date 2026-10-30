'use strict';
/* Abito island host — unit M1a.
   - Renders the frozen R6 clay engine (clay-engine.js, SVG-DOM) scaled and
     positioned inside the native window; never redrawn, no extra poses.
   - Animates compact<->overview with the approved contract motion:
     grow = spring response 0.5s / damping 0.72, shrink = 340ms
     cubic-bezier(.45,0,.2,1), prefers-reduced-motion snaps instantly, silence.
   - Forwards raw pointer events to the Rust core handlers, which own every
     decision (click-vs-drag cancellation and fixed native placement).
     The desktop character has its own independent pick-up path.
   - Reports frontend evidence (SVG element count, canvas absence) to Rust.
   - Reads the motion override through the window.desktop facade (M1b):
     `animateAnyway` forces motion even under prefers-reduced-motion;
     everything else fails CLOSED to accessibility (M1a behaviour).
   - #266: an incoming question or NEW notice opens a RESTING COMPACT island
     through the host's own `expand` verb — the human decision that overrides
     the old no-reveal-on-notice rule. Native geometry, the hidden-state
     policy and the spring stay Rust's/contract's; the reveal never focuses,
     never answers and never replays boot history.
   No sounds, no Coucou assets. */
(() => {
  // #366 F093: the settings window runs this same page; the island's pointer, hover,
  // timer and host-verb machinery must never run there (the label is Rust's, exact).
  const __label = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.metadata
    && window.__TAURI_INTERNALS__.metadata.currentWindow && window.__TAURI_INTERNALS__.metadata.currentWindow.label;
  if (__label === 'settings') return;
  const $ = id => document.getElementById(id);
  const capsule = $('capsule');
  const island = $('island');
  const clayEl = $('clay');
  let current = null;
  let countdownTimer = null;
  // Native-confirmed notice lane is separate from approval-card selection.
  let noticeLane = null;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)'); // the SYSTEM value: informative only (#304)
  // #304: Abito's own motion state. Default «full»: the system preference is honored
  // only when the human opted in (snapshot.motionOverride === false). Every snap /
  // animate decision, the CSS (html[data-motion]) and the frozen engine follow it.
  let honorSystem = false;
  const motionReduced = () => window.AbitoOverview.motionState({ systemReduced: reduced.matches, honorSystem }) === 'reduce';
  const applyMotion = () => {
    document.documentElement.dataset.motion = motionReduced() ? 'reduce' : 'full';
    if (typeof AbitoClay !== 'undefined' && AbitoClay.forced !== !honorSystem) AbitoClay.setForced(!honorSystem);
  };
  reduced.addEventListener('change', applyMotion);

  // Visible geometry inside the ONE 672x340 logical native window (geometry.rs).
  // The resting island is Coucou's 288x32 bar, square on top, radius 14 below.
  // The character keeps Coucou's botPosition('compact'): cx 40, cy 16, diameter 20.
  const COMPACT = { w: 288, h: 32, r: 16, gap: 0, clay: 23, clayX: 40, drop: 1 };
  // S10 (L19): Coucou's own bot placement (core/layout.ts VIEW_LAYOUTS): overview botX 68 / diameter 58,
  // approval, question, error and finished botX 62 / diameter 56, centred on the 84pt card row
  // (cy 101 from the island top). The box is diameter * 128/112 because the engine draws ~112 of 128
  // viewBox units; only scale/position change, the engine is frozen. `cy` is the visible blob centre.
  // S10 (L24, «Notch pegado arriba como Coucou»): the expanded island is stuck to the top edge of the screen (gap 0) with
  // Coucou's corners 0 0 14 14; Rust pins every view with geometry::island_window_rect.
  const GAP_TOP = 0; // S29 (human: «No lo separes, me gusta que esté pegada»): the shell is flush to the top edge again
  const OVERVIEW = { w: 720, h: 150, r: 26, gap: 0, clay: 64, clayX: 598, cy: 74 }; // HU-057 Nusa notch (bottom corners only)
  const RECAP_H = 208; // Coucou VIEW_LAYOUTS.recap: the recap card needs two more text lines than the overview card
  const QUESTION_H = 224; // default; a long question grows it (abito:question-size), capped by the fixed window
  let questionH = QUESTION_H;
  let compactW = COMPACT.w; // S2/S3: the compact pill widens for the minis, the activity line and a waiting question (island-layout.js compactView)
  let engineBandOn = false; // S11: the engine/account band under the overview (+36px island)
  let noticeStripOn = false; // S1 (abito-avisos-ux): the Avisos strip takes the same bottom slot (+36px island)
  let cardH = 0; // the island height the desktop bridge approval card needs in the Nusa take-over (0 = the normal overview)
  let finishedH = 0; // D: the island height a long «terminó» result needs (0 = the normal overview). Only honoured while the notices lane is open (HU-057: several paths clear the lane without resetting it, which left the strip outside the 150px notch)
  // const QUESTION_H doc: // Coucou QUESTION_PICKER_H: the fixed window already has room
  const LEGACY_CARD_H = 184; // HU-057: OVERVIEW_CARD.cy (113) was measured on the 184-high legacy overview; the question card keeps that anchor
  const OVERVIEW_CARD = { clay: 64, clayX: 62, cy: 113 };
  const BLOB_DROP = 10 / 140; // the drawn blob sits this fraction of the box below the box centre (measured, was drop 10 at box 140)
  // The engine draws its body ~112 viewBox units wide inside its 200x160
  // canvas (measured from the captures), so a box of 128px shows a ~70px
  // character. In the overview the SVG viewBox is tightened (attribute only,
  // engine bytes untouched) so box 136 shows ~127px and box 77 shows ~72px.
  const BASE_VB = [0, 20, 200, 160];
  const OVERVIEW_VB = [36, 32, 128, 128];
  // #309: the chat is a vertical COLUMN of the SAME expanded island. Its size arrives from Rust
  // (geometry::chat_visible through __islandSetView; the height follows the work area); this is
  // only the pre-first-push default and must match geometry::CHAT_COLUMN_W / CHAT_MIN_H.
  // §5: the character is ~40px VISIBLE in the chat header: with the tight framing
  // (128 units show ~112) a 46px box shows ~40px.
  const CHAT = { w: 720, h: 240, r: 22, clay: 46, clayLeft: 52, clayTop: 3 }; // S10 #480: 640 wide like the overview (geometry::CHAT_COLUMN_W); clayLeft is replaced below

  // Tauri IPC bridge (app.withGlobalTauri in tauri.conf.json).
  const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)
    || (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke)
    || null;

  // ---- frozen R6 ---------------------------------------------------------
  let clay = null;
  if (typeof AbitoClay !== 'undefined') {
    clay = AbitoClay.create(clayEl, { seed: 505, viewBox: '0 20 200 160' });
  }
  // #486: the desktop character (island-desktop.js); null where it is unavailable.
  const desktopCharacter = window.AbitoIslandDesktop || null;
  {
    const listen = window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen;
    if (listen) listen('desktop-character-toggle', () => {
      if (desktopCharacter) desktopCharacter.flyOutOrHome();
    }).catch(() => {});
  }
  // The session the overview focuses (its daemon row id), kept for the Ctrl+Alt+T shortcut. Display state only.
  let focusedSessionKey = null;
  document.addEventListener('abito:sessions-view', event => {
    const id = event && event.detail && event.detail.focusId;
    focusedSessionKey = typeof id === 'string' && /^s-[0-9a-f]{8}$/.test(id) ? id : null;
  });
  // #347: presentation-only producers; pending human requests outrank decorations.
  const character = window.AbitoCharacter.create({
    clay, applyState: next => { if (clay && clay.state !== next) clay.setState(next); }, choosePose: (chat, host) => O.choosePose(chat, host), validCard, setTimer: setTimeout, clearTimer: clearTimeout,
    notification: snap => snap && snap.available !== false ? NV.fromPending(snap.pending) : null,
    // SN2: the exact rule the card uses for its approval look (harness «pide permiso» pair, Pi kind=approval); never a guess
    isApproval: n => !!(window.AbitoIslandLayout && !n.multiSelect && !n.form && window.AbitoIslandLayout.approvalView(n, NV.askerName(n))),
    blocked: () => motionReduced() || document.hidden || (typeof AbitoClay !== 'undefined' && AbitoClay.paused),
  });
  applyMotion(); // from the first frame: Abito's own motion state, never the inherited one (#304)
  // S2 (abito-avisos-ux): «Recibida» — Abito comes forward and nods (the engine's own confirm pose) while the agent's receipt shows,
  // then goes back to its normal producer. Only for `answered` (the producer acknowledged): «Enviada» proves nothing and stays neutral.
  let outcomeHeld = false;
  function syncOutcomePose() {
    const want = capsule.dataset.question === 'outcome' && capsule.dataset.outcome === 'answered';
    if (want === outcomeHeld) return;
    outcomeHeld = want;
    character.hold(want ? 'confirm' : null);
    if (clayEl) { if (want) clayEl.dataset.pose = 'confirm'; else delete clayEl.dataset.pose; }
  }
  new MutationObserver(syncOutcomePose).observe(capsule, { attributes: true, attributeFilter: ['data-question', 'data-outcome'] });

  // ---- R6 pose (Q2): only REAL events drive it, through the engine's own
  // setState (no new poses, no redraw). Sources: the chat lane (chat.js
  // dispatches `abito:pose`: think/speak/error while a turn or the model is in
  // that state) and the human's decision once the host says it was SENT
  // A SENT decision keeps the character at rest (O.gestureFor): confirm/reject
  // wait for a real host confirmation.
  let chatPose = null;
  let hostPose = null; // host failures (bridge/transport) — time-boxed by O.hostPoseView
  let hostTracker = { failing: false, since: 0 };
  let hostTimer = 0;
  function refreshHost(snapshot) {
    if (!O) return;
    const r = O.hostPoseView(snapshot, hostTracker, Date.now());
    hostTracker = r.tracker;
    hostPose = r.pose;
    character.snapshot(snapshot);
    if (desktopCharacter) desktopCharacter.snapshot(snapshot); // #486: an alert sends the desktop character home
    clearTimeout(hostTimer);
    if (r.pose && r.expiresAt) hostTimer = setTimeout(() => refreshHost(current), Math.max(50, r.expiresAt - Date.now() + 50));
    applyPose();
  }
  const POSES = new Set(['think', 'speak', 'error']);
  function applyPose() {
    // Priority (night review): active chat turn > time-boxed host error > the
    // chat's own error > rest (see O.choosePose).
    const next = O ? O.choosePose(chatPose, hostPose) : (chatPose || 'idle');
    // Keep the legacy resolver unchanged; the controller layers real human requests above it.
    character.chat(next);
  }
  document.addEventListener('abito:empty-shown', event => { character.rest(!!(event.detail && event.detail.shown)); });
  document.addEventListener('abito:pose', event => {
    const state = event.detail;
    chatPose = POSES.has(state) ? state : null;
    applyPose();
  });

  // ---- motion (contract numbers, JS-driven per frame) --------------------
  const W0 = 2 * Math.PI / 0.5; // spring response: 0.5 s
  const ZETA = 0.72;             // spring damping ratio: 0.72
  const SHRINK_MS = 340;         // shrink duration: 340 ms
  const easeShrink = cubicBezier(0.45, 0, 0.2, 1);

  let cardShown = false; // UI.1: a valid approval card is on screen
  let recapShown = false; // L32: the weekly recap card is open (Coucou's recap view is 184 high)
  let questionShown = false; // N6: a Pi question/notification is on screen (R6 shrinks like with a card)
  let p = 0;            // progress 0 = compact, 1 = overview
  let v = 0;            // spring velocity
  let target = 0;
  let mode = 'idle';    // 'idle' | 'spring' | 'shrink'
  let t0 = 0, p0 = 0, last = 0, raf = 0;
  let settledPhase = null; // #439: the landed phase this animation reached (see O.viewPhase)
  const edge = 'top';   // fixed to the work area's top edge
  // U1: second channel, 0 = overview, 1 = chat (same contract motion).
  const q = { x: 0, v: 0, target: 0, mode: 'idle', t0: 0, x0: 0, last: 0 };

  function cubicBezier(x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const sampleX = t => ((ax * t + bx) * t + cx) * t;
    const sampleY = t => ((ay * t + by) * t + cy) * t;
    const dX = t => (3 * ax * t + 2 * bx) * t + cx;
    return x => {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      let t = x;
      for (let i = 0; i < 8; i++) {
        const err = sampleX(t) - x;
        if (Math.abs(err) < 1e-5) break;
        const d = dX(t);
        if (Math.abs(d) < 1e-6) break;
        t -= err / d;
      }
      if (!(t >= 0 && t <= 1)) { // bisection fallback
        let lo = 0, hi = 1;
        for (let i = 0; i < 24 && Math.abs(sampleX(t) - x) > 1e-5; i++) {
          if (sampleX(t) < x) lo = t; else hi = t;
          t = (lo + hi) / 2;
        }
      }
      return sampleY(t);
    };
  }

  const lerp = (a, b, t) => a + (b - a) * t;
  // #493: a write only when the value changed. The viewBox is constant, and a frame that moves one of the island's edges does not
  // touch the others; an unchanged attribute/style write still invalidates style and (for the SVG) its layout.
  const written = new WeakMap();
  const put = (el, key, value) => {
    let m = written.get(el); if (!m) { m = new Map(); written.set(el, m); }
    if (m.get(key) === value) return;
    m.set(key, value);
    if (key === 'viewBox') el.setAttribute(key, value); else el.style[key] = value;
  };

  // Only transition boundaries cross IPC, never the animation's per-frame samples.
  function shapeReporter(invoke) {
    let lastTarget = '', lastSettled = '', active = false;
    const send = (size, settled) => {
      if (!invoke) return;
      const payload = { w: Math.round(size[0]), h: Math.round(size[1]), settled };
      try { invoke('island_shape', { payload }).catch(() => {}); } catch { /* optional bridge */ }
    };
    return (destination, rendered, settled) => {
      const key = destination.map(Math.round).join(',');
      if (key !== lastTarget || (!settled && !active)) {
        send(destination, false); lastTarget = key; lastSettled = '';
      }
      active = !settled;
      if (settled) {
        const renderedKey = rendered.map(Math.round).join(',');
        if (renderedKey !== lastSettled) { send(rendered, true); lastSettled = renderedKey; }
      }
    };
  }
  const reportShape = shapeReporter(invoke);
  const conceal = { x:0, target:0, from:0, start:0, moving:false };
  function setConcealed(hidden) {
    const next = hidden ? 1 : 0;
    if (conceal.target === next) return;
    conceal.target = next; conceal.from = conceal.x; conceal.start = performance.now();
    conceal.moving = !motionReduced();
    if (!conceal.moving) conceal.x = next;
    capsule.dataset.edgeHidden = String(hidden);
    render();
    if (conceal.moving && !raf) raf = requestAnimationFrame(tick);
  }

  let compactAsk = false, measureCtx = null;
  const compactHasText = () => { const a = $('compact-activity'); return !!(a && a.textContent); };
  function compactTextWidth() {
    const a = $('compact-activity'); if (!a || !a.textContent) return 0;
    try {
      measureCtx = measureCtx || document.createElement('canvas').getContext('2d');
      const cs = getComputedStyle(a); measureCtx.font = `${cs.fontWeight} 12px ${cs.fontFamily}`;
      return measureCtx.measureText(a.textContent).width;
    } catch { return a.textContent.length * 7; }
  }
  function render() {
    // HU-057 S12: the compact pill fits its text + Koda (AbitoNusa.compactWidth). Visual only: the reported shape keeps the
    // island-layout widths (288/440/560), so geometry::COMPACT_WIDTHS and the native input shape do not move.
    const fitOn = !!window.AbitoNusa && compactAsk === false && p < 0.001 && q.x < 0.001;
    const fitW = fitOn ? window.AbitoNusa.compactWidth(compactTextWidth()) : 0;
    if ((capsule.dataset.pillFit === 'true') !== fitOn) capsule.dataset.pillFit = String(fitOn);
    const w = fitOn ? fitW : lerp(compactW, lerp(OVERVIEW.w, CHAT.w, q.x), p);
    const compactClayX = fitOn ? (compactHasText() ? window.AbitoNusa.COMPACT.padLeft + window.AbitoNusa.COMPACT.koda / 2 : fitW / 2) /* #clay is translated -50% by the vendor sheet: `left` is its CENTRE */ : COMPACT.clayX;
    if ((capsule.dataset.pillBare === 'true') !== (fitOn && !compactHasText())) capsule.dataset.pillBare = String(fitOn && !compactHasText());
    const overviewHeight = recapShown ? RECAP_H : questionShown ? questionH : cardShown && cardH ? cardH : (noticeLane && noticeLane.view === 'notices' ? finishedH : 0) || (engineBandOn || noticeStripOn ? OVERVIEW.h + FINISHED_BAND_H : OVERVIEW.h);
    const h = lerp(COMPACT.h, lerp(overviewHeight, CHAT.h, q.x), p);
    const QT = window.AbitoQuestionToast, withToast = (shape) => (QT && toastShown ? QT.shapeWithToast(shape, true) : shape);
    reportShape(withToast([lerp(compactW, lerp(OVERVIEW.w, CHAT.w, q.target), target),
      lerp(COMPACT.h, lerp(overviewHeight, CHAT.h, q.target), target) + GAP_TOP * (1 - conceal.target) - 24 * conceal.target]), withToast([w, h + GAP_TOP * (1 - conceal.x) - 24 * conceal.x]), mode === 'idle' && q.mode === 'idle' && !conceal.moving);
    // corners (HU-057): the compact pill is r16 on all four; the expanded island is the Nusa notch, square on top (the ears are
    // drawn by island-nusa-mount.js) and r26 (OVERVIEW.r) at the bottom.
    const rBottom = lerp(COMPACT.r, OVERVIEW.r, p), rTop = lerp(COMPACT.r, 0, p), rTopUsed = fitOn ? 0 : rTop; // S12: the fitted pill hangs from the edge, bottom corners only
    const gap = lerp(COMPACT.gap, OVERVIEW.gap, p);
    // the question card is 148 high (200 island): the character centres on it, 15px lower than on the 108 cards
    const ovBase = recapShown ? { ...OVERVIEW_CARD, cy: 42 + (RECAP_H - 52) / 2 } : questionShown ? { ...OVERVIEW_CARD, cy: OVERVIEW_CARD.cy + (questionH - LEGACY_CARD_H) / 2 } : cardShown ? OVERVIEW_CARD : OVERVIEW;
    // the confirmed finished-notice lane (pane starts at x=108) uses the small R6 too, or the 128px blob covers the pane
    const ov = (noticeLane && noticeLane.view === 'notices') ? OVERVIEW_CARD : ovBase;
    const cs = lerp(COMPACT.clay, ov.clay, p);
    put(island, 'width', w + 'px');
    put(island, 'height', h + 'px');
    put(island, 'borderRadius', `${rTopUsed}px ${rTopUsed}px ${rBottom}px ${rBottom}px`);
    put(island, 'top', (gap * (1 - conceal.x) - 24 * conceal.x - 0 * conceal.x) + 'px');
    put(island, 'bottom', 'auto');
    // R6 is only scaled and positioned (never redrawn): centred in the
    // overview, small at the left of the header in the chat view.
    const csv = lerp(cs, CHAT.clay, q.x);
    const overviewTop = lerp(COMPACT.h / 2 - COMPACT.drop, ov.cy - cs * BLOB_DROP, p) - cs / 2;
    const z = 1; // tight framing in the dot, the overview AND the chat (the dot's character fills the disc, #302)
    put(clayEl, 'viewBox', BASE_VB.map((b, i) => +(b + (OVERVIEW_VB[i] - b) * z).toFixed(2)).join(' '));
    put(clayEl, 'width', csv + 'px');
    put(clayEl, 'height', csv + 'px');
    put(clayEl, 'left', lerp(lerp(compactClayX, ov.clayX, p), CHAT.clayLeft, q.x) + 'px'); // chat: the bot sits at the composer's left, inside the 640 island
    // Coucou companion follows the live composer, not a demo success pose.
    put(clayEl, 'top', lerp(overviewTop, CHAT.h - 76, q.x) + 'px');
    // Coucou's badge sits on the character's top-left (core/layout.ts botPosition: centre - (20, 21)); 16px circle.
    const badge = $('clay-badge');
    if (badge) {
      // S2: an outcome on screen is no longer a question: no «?» on Abito while «Recibida» shows
      const questionLook = capsule.dataset.question === 'outcome' ? '' : questionShown && $('question') && $('question').dataset.look === 'approval' ? 'approval' : 'question';
      const kind = noticeLane && noticeLane.view === 'notices' ? 'finished' : cardShown ? 'approval' : questionShown ? questionLook : '';
      badge.hidden = !kind || p < 1;
      if (badge.dataset.kind !== kind) badge.dataset.kind = kind;
      // G: the badge rides the mascot's OWN rendered box (the same left/top/size just written above), in every view
      const clayLeft = lerp(lerp(compactClayX, ov.clayX, p), CHAT.clayLeft, q.x), clayTop = lerp(overviewTop, CHAT.h - 76, q.x);
      const at = window.AbitoIslandLayout && window.AbitoIslandLayout.badgePosition({ left: clayLeft, top: clayTop, size: csv });
      if (at) { badge.style.left = at.left + 'px'; badge.style.top = at.top + 'px'; }
    }
    if (capsule.dataset.edge !== edge) capsule.dataset.edge = edge;
    const view = q.target === 1 ? 'chat' : noticeLane && noticeLane.view === 'notices' ? 'notices' : 'overview';
    if (capsule.dataset.view !== view) capsule.dataset.view = view;
    const home = $('home-tab');
    // Coucou: the home tab is lit only on the overview itself, not behind an approval or a question card
    const homeOn = q.target === 0 && !noticeLane && !cardShown && !questionShown ? 'true' : 'false';
    if (home && home.getAttribute('aria-pressed') !== homeOn) home.setAttribute('aria-pressed', homeOn);
    const chatTab = $('open-chat');
    if (chatTab && chatTab.getAttribute('aria-pressed') !== (q.target === 1 ? 'true' : 'false'))
      chatTab.setAttribute('aria-pressed', q.target === 1 ? 'true' : 'false');
    // M1 semantics unchanged: expanded as soon as the island reached it
    // (spring overshoot included); the chat is a VIEW of the expanded phase.
    // #439: the settled phase latches while an animation runs — the spring's
    // overshoot dip used to toggle expanded/expanding (and compact/collapsing)
    // per frame, which re-applied every delayed view rule and re-fired the
    // capsule observers mid-resize: the navigation flashes. See O.viewPhase.
    const landed = mode !== 'idle'
      ? (target === 1 && p >= 1 ? 'expanded' : target === 0 && p <= 0 ? 'compact' : null)
      : null;
    if (mode === 'idle') settledPhase = null;
    else if (landed) settledPhase = landed;
    const phase = O.viewPhase(p, target, mode, settledPhase);
    if (capsule.dataset.phase !== phase) capsule.dataset.phase = phase;
  }

  function tick(now) {
    raf = 0;
    if (mode === 'spring') {
      const dt = last ? (now - last) / 1000 : 1 / 60; // #493: sub-stepped and capped at 50 ms inside springStep (Coucou's Spring)
      last = now;
      ({ p, v } = O.springStep(p, v, target, dt, W0, ZETA));
      if (Math.abs(p - target) < 0.002 && Math.abs(v) < 0.03) {
        p = target; v = 0; mode = 'idle';
      }
    } else if (mode === 'shrink') {
      const t = Math.min(1, (now - t0) / SHRINK_MS);
      p = p0 * (1 - easeShrink(t));
      if (t >= 1) { p = target; mode = 'idle'; }
    }
    if (q.mode === 'spring') {
      const dt = q.last ? (now - q.last) / 1000 : 1 / 60;
      q.last = now;
      ({ p: q.x, v: q.v } = O.springStep(q.x, q.v, q.target, dt, W0, ZETA));
      if (Math.abs(q.x - q.target) < 0.002 && Math.abs(q.v) < 0.03) {
        q.x = q.target; q.v = 0; q.mode = 'idle';
      }
    } else if (q.mode === 'shrink') {
      const t = Math.min(1, (now - q.t0) / SHRINK_MS);
      q.x = q.target + (q.x0 - q.target) * (1 - easeShrink(t));
      if (t >= 1) { q.x = q.target; q.mode = 'idle'; }
    }
    if (conceal.moving) {
      const t = Math.min(1, (now - conceal.start) / SHRINK_MS);
      conceal.x = lerp(conceal.from, conceal.target, easeShrink(t));
      if (t >= 1) { conceal.x = conceal.target; conceal.moving = false; }
    }
    render();
    if (mode !== 'idle' || q.mode !== 'idle' || conceal.moving) raf = requestAnimationFrame(tick);
  }

  // U1: move the chat channel with the contract motion (grow = spring,
  // shrink = 340 ms curve, reduced motion snaps).
  function moveView(t) {
    q.target = t;
    if (motionReduced() || Math.abs(t - q.x) < 1e-9) {
      q.x = t; q.v = 0; q.mode = 'idle'; return;
    }
    if (t > q.x) { q.mode = 'spring'; q.last = 0; }
    else { q.mode = 'shrink'; q.t0 = performance.now(); q.x0 = q.x; }
  }

  // ---- motion override via the window.desktop facade (M1b) --------------
  // Contract 2026-10-07: one machine-wide boolean; only an explicit
  // `animateAnyway` snapshot (motionOverride === true) may animate against
  // prefers-reduced-motion. A missing facade, a failed snapshot or
  // `respectSystemMotion` all leave this false — accessibility wins.
  const applyMotionPref = snap => {
    honorSystem = window.AbitoOverview.honorSystemMotion(snap);
    applyMotion(); // CSS state + the frozen engine (forced unless the human honors the system)
  };
  if (window.desktop) {
    try { window.desktop.onState(applyMotionPref); } catch { /* facade optional */ }
    try { window.desktop.snapshot().then(applyMotionPref, () => {}); } catch { /* facade optional */ }
  }

  // Called from Rust (WebviewWindow::eval) after every core toggle.
  function setPhase(phase) {
    settledPhase = null; // a new transition never inherits the previous latch
    const t = phase === 'overview' ? 1 : 0;
    target = t;
    // A collapse always leaves the chat view (Rust resets it too).
    if (t === 0) {
      noticeLane = null; delete capsule.dataset.noticeView; moveView(0);
      // a collapse leaves the chat view: panels (models/settings) close with it, or they pin the dot's character out of place
      document.dispatchEvent(new CustomEvent('island:view', { detail: 'overview' }));
    }
    if (motionReduced() || Math.abs(t - p) < 1e-9) {
      p = t; v = 0; mode = 'idle'; render();
      if (q.mode !== 'idle' && !raf) raf = requestAnimationFrame(tick);
      return;
    }
    if (t === 1) { mode = 'spring'; last = 0; }
    else { mode = 'shrink'; t0 = performance.now(); p0 = p; }
    render();
    if (!raf) raf = requestAnimationFrame(tick);
  }
  window.__islandSetState = setPhase;
  window.__islandConceal = setConcealed; // the page-side hidden state (the host drives it through the edge interaction); also lets the real-layout harness reach it
  // U1: called from Rust (chathost::apply_view) with the chat height from
  // geometry::CHAT_VISIBLE — the frontend never owns that number.
  window.__islandSetView = (view, vw, vh) => {
    noticeLane = null;
    delete capsule.dataset.noticeView;
    // Rust also sends the OVERVIEW target size on return. Retain outgoing
    // chat geometry until q shrinks; replacing it here snaps before animation.
    if (view === 'chat' && Number.isInteger(vw) && Number.isInteger(vh) && vw > 0 && vh > 0) { CHAT.w = vw; CHAT.h = vh; }
    moveView(view === 'chat' ? 1 : 0);
    render();
    if (q.mode !== 'idle' && !raf) raf = requestAnimationFrame(tick);
    document.dispatchEvent(new CustomEvent('island:view', { detail: view === 'chat' ? 'chat' : 'overview' }));
  };

  // ---- frontend evidence for the read-back probe -------------------------
  function reportEvidence(attempt) {
    if (!invoke) return;
    const svgs = clayEl.querySelectorAll('*').length;
    const canvases = document.querySelectorAll('canvas').length;
    const revision = typeof AbitoClay !== 'undefined' ? AbitoClay.REVISION : 'unavailable';
    try {
      invoke('record_frontend_evidence', { svgs, canvases, revision }).catch(err => {
        console.error('record_frontend_evidence failed', err);
        if (attempt < 3) setTimeout(() => reportEvidence(attempt + 1), 500);
      });
    } catch (err) {
      console.error('record_frontend_evidence threw', err);
      if (attempt < 3) setTimeout(() => reportEvidence(attempt + 1), 500);
    }
  }

  // ---- pointer tracking (webview reports; Rust decides) ------------------
  let pressed = false;
  let botPress = null; // #486: a press on the character not yet decided: pick-up or (below the threshold) a click
  let botCarry = false;
  // #336 L18: one press may carry a spent hover engagement (see release).
  let hoverEngagePress = false;
  let lastPoint = { x: 0, y: 0 };
  const send = (cmd, args) => {
    if (!invoke) return;
    try { invoke(cmd, args).catch(err => console.error(cmd, err)); }
    catch (err) { console.error(cmd, err); }
  };
  const release = (pt, cancelled) => {
    if (!pressed) return;
    pressed = false;
    // #486: the drag out to the desktop ends here; a press that never moved was a click on the character.
    if (botCarry) {
      botCarry = false;
      desktopCharacter.carryEnd(pt.x, pt.y);
      character.dragEnd(); document.body.classList.remove('is-dragging'); syncInteraction();
      return;
    }
    if (botPress) {
      // the press was held back from drag_press: replay it so Rust sees the same press/release pair as ever
      send('drag_press', { x: botPress.x, y: botPress.y });
      botPress = null;
    }
    // #336 L18: a spent hover engagement cancels ONLY this release, so the
    // island stays open. Later presses use the ordinary click policy.
    // Merged BEFORE the send: the native IPC arguments stay byte-identical
    // (character-states-check pins that exact line and must not change).
    cancelled = cancelled || hoverEngagePress;
    hoverEngagePress = false;
    character.dragEnd();
    document.body.classList.remove('is-dragging');
    send('drag_release', { x: pt.x, y: pt.y, cancelled });
    syncInteraction();
  };
  const onCharacter = e => !!(e.target && e.target.closest && e.target.closest('#clay'));
  const PICKUP_THRESHOLD = 3; // Coucou DRAG_THRESHOLD
  window.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !e.isPrimary) return;
    // Coucou's positive state model: a collapsed bar opens on press; an
    // expanded island leaves every control (including divs) alone. Only #clay
    // participates in the independent desktop-character pickup/slap path.
    if (!onCharacter(e)) {
      if (current && current.state === 'compact' && window.desktop) {
        window.desktop.expand().catch(err => console.error('expand', err));
      }
      return;
    }
    pressed = true;
    // #336 L18: capture the engagement at PRESS time (the native release
    // happens before any click event): the module's hoverOnly state says
    // whether this is the first press after a hover-open.
    hoverEngagePress = !!(interaction && interaction.snapshot().hoverOnly);
    character.dragStart(e.screenX);
    syncInteraction();
    lastPoint = { x: e.clientX, y: e.clientY };
    document.body.classList.add('is-dragging');
    try { if (e.target.setPointerCapture) e.target.setPointerCapture(e.pointerId); }
    catch { /* pointer capture is best-effort; X11 has an implicit grab */ }
    // #486: a press that starts ON the character may become a drag out to the desktop (Coucou); it is held
    // back from click reporting until it moves. A character click is reported
    // to Rust, which can open a compact island but never collapse an expanded one.
    if (onCharacter(e) && desktopCharacter && desktopCharacter.canPickUp()) botPress = { x: e.clientX, y: e.clientY };
    else send('drag_press', { x: e.clientX, y: e.clientY });
  });
  // §9.2 hover on the character: scale only (pure O.hoverScale), no state.
  function updateHover(point) {
    if (!O) return;
    const r = clayEl.getBoundingClientRect();
    // the box is already scaled by --hover: test against the unscaled centre box
    const scale = parseFloat(clayEl.style.getPropertyValue('--hover')) || 1;
    const w = r.width / scale, h = r.height / scale;
    const box = { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, width: w, height: h };
    const next = O.hoverScale(point, box, { reduced: motionReduced(), dragging: pressed });
    if (next !== scale) clayEl.style.setProperty('--hover', String(next));
    character.hover(!!point && !pressed && next > 1);
  }
  window.addEventListener('pointermove', e => {
    if (!pressed) { updateHover({ x: e.clientX, y: e.clientY }); return; }
    updateHover(null);
    lastPoint = { x: e.clientX, y: e.clientY };
    if (botCarry) { desktopCharacter.carry(e.clientX, e.clientY); return; }
    if (botPress) {
      if (Math.hypot(e.clientX - botPress.x, e.clientY - botPress.y) <= PICKUP_THRESHOLD) return;
      const at = botPress; botPress = null; botCarry = true;
      character.dragEnd(); document.body.classList.remove('is-dragging');
      desktopCharacter.pickUp(at.x, at.y);
      return;
    }
    character.dragMove(e.screenX);
    send('drag_move', { x: e.clientX, y: e.clientY });
  });
  document.addEventListener('pointerleave', () => updateHover(null));
  window.addEventListener('pointerup', e => release({ x: e.clientX, y: e.clientY }, false));
  window.addEventListener('pointercancel', e => release({ x: e.clientX, y: e.clientY }, true));
  // Focus loss mid-drag (e.g. alt-tab): reconcile without toggling.
  window.addEventListener('blur', () => release(lastPoint, true));

  // ---- #336 F003/F004: the inactivity interaction feed (T1b-b) -------------
  // One controller from the T1a module (policy/scheduler only): the module
  // owns eligibility, the monotonic deadline and the ONE hosted timer; this
  // file feeds live facts/events and calls back ONLY through the existing
  // facade verbs — `expand` for hover-open, the new atomic `autoClose` for
  // the close. The facts are advisory input, never permission: Rust rechecks
  // protected state atomically inside the verb. The countdown VISUAL is not
  // wired here (no approved surface owns its markup/style yet), so
  // onCountdown stays silent — the close itself does not depend on it.
  let composingIME = false;
  // countdown VISUAL (#419): the approved decoration surface is one element;
  // the adapter renders the published fraction into it and never drives the
  // close from it. A missing module, export or element keeps it a no-op.
  const countdownEl = document.getElementById('island-countdown');
  const countdownView = window.AbitoIslandInteraction &&
    typeof window.AbitoIslandInteraction.createCountdownView === 'function' && countdownEl
    ? window.AbitoIslandInteraction.createCountdownView(countdownEl) : null;
  const interaction = window.AbitoIslandInteraction
    ? window.AbitoIslandInteraction.createController({
        now: () => performance.now(),
        schedule: (fn, ms) => setTimeout(fn, ms),
        cancel: id => clearTimeout(id),
        open: () => (window.desktop ? window.desktop.expand() : Promise.reject(new Error('host unavailable'))),
        autoClose: () => (window.desktop ? window.desktop.autoClose() : Promise.reject(new Error('host unavailable'))),
        onCountdown: value => { if (countdownView) countdownView.update(value); },
      })
    : null;
  // S31: after 30 s without interaction the EXPANDED island (any view, pinned or not) folds to the compact pill. The fold goes through the
  // host's atomically guarded `autoClose` (it refuses while a question/permission is pending: that stays visible through S3's pill).
  const idleFold = window.AbitoIslandIdle?.create({
    now: () => performance.now(), schedule: (fn, ms) => setTimeout(fn, ms), cancel: id => clearTimeout(id),
    collapse: () => (window.desktop && window.desktop.autoClose ? window.desktop.autoClose() : Promise.reject(new Error('host unavailable'))),
  });
  if (idleFold) {
    const touch = event => { if (event.isTrusted === true) idleFold.touch(); };
    // #capsule is the whole transparent window: only the island's own box counts as «over the island»
    for (const type of ['pointermove', 'pointerdown', 'keydown', 'input', 'wheel']) island.addEventListener(type, touch, true);
    island.addEventListener('pointerenter', () => idleFold.setInside(true));
    island.addEventListener('pointerleave', () => idleFold.setInside(false));
    const typing = el => !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable === true);
    document.addEventListener('focusin', event => idleFold.setFieldFocus(typing(event.target)));
    document.addEventListener('focusout', () => idleFold.setFieldFocus(typing(document.activeElement)));
    new MutationObserver(() => idleFold.setExpanded(capsule.dataset.phase === 'expanded')).observe(capsule, { attributes: true, attributeFilter: ['data-phase'] });
    idleFold.setExpanded(capsule.dataset.phase === 'expanded');
  }
  const edgeInteraction = window.AbitoIslandInteraction?.createEdgeController({
    now: () => performance.now(), schedule: (fn, ms) => setTimeout(fn, ms), cancel: id => clearTimeout(id), onHidden: setConcealed,
  });
  const TEXT_FIELD = 'input, textarea, [contenteditable="true"]';
  const NON_TEXT_INPUT = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image']);
  function interactionFacts() {
    const snap = current;
    const active = document.activeElement;
    // «Editing» = a VISIBLE text field holds the focus. A checkbox/radio/button <input> holds no text, and a field inside a hidden
    // or inert card (a closed question) is not being typed in: neither may keep the island open forever.
    const editing = !!(active && active.matches && active.matches(TEXT_FIELD) &&
      !(active.tagName === 'INPUT' && NON_TEXT_INPUT.has(active.type)) && !(active.closest && active.closest('[inert], [hidden]')));
    const field = $('chat-input');
    const permission = $('permission');
    const models = $('models');
    return {
      state: snap ? snap.state : 'unknown',
      view: capsule.dataset.view || 'unknown',
      settled: capsule.dataset.phase === 'expanded' || capsule.dataset.phase === 'compact',
      nativeReady: snap !== null && snap !== undefined,
      pointerInside: typeof capsule.matches === 'function' ? capsule.matches(':hover') : undefined,
      question: capsule.dataset.question === 'pending',
      approval: !!(permission && !permission.hidden && pendingCard(snap && snap.card)),
      request: !!(snap && snap.request),
      decision: !!cardFlight,
      card: !!(snap && pendingCard(snap.card)),
      dragging: pressed,
      editing: editing,
      composing: composingIME || editing,
      draft: !!(field && field.value),
      settings: capsule.dataset.settings === 'open',
      models: !!(models && models.dataset.open === 'true'),
    };
  }
  // A manual pin is local to this expansion; protected cards have independent
  // guards and cannot be unpinned by this control. Keep the existing header slot
  // styling and keyboard activation rather than installing another global hook.
  const pinButton = document.createElement('button');
  pinButton.id = 'island-pin'; pinButton.type = 'button'; pinButton.className = 'hdr-action';
  pinButton.textContent = '⌖';
  const foldButton = $('header-fold');
  if (foldButton) foldButton.before(pinButton);
  function paintPin() {
    const pinned = !!(interaction && interaction.snapshot().pinned);
    pinButton.setAttribute('aria-pressed', String(pinned));
    pinButton.setAttribute('aria-label', pinned ? 'Desfijar isla' : 'Fijar isla');
    pinButton.title = pinned ? 'Desfijar isla' : 'Fijar isla';
    pinButton.disabled = !interaction || !window.AbitoIslandInteraction.eligible(interactionFacts());
  }
  pinButton.addEventListener('click', event => {
    if (interaction) { interaction.update(interactionFacts()); interaction.togglePin(event); paintPin(); }
  });
  function syncInteraction() {
    if (interaction) interaction.update(interactionFacts());
    // WHY the island is (not) auto-closing, readable from outside (the live preview is validated through the screen): the
    // controller's one-word reason. Diagnostic only; nothing reads it back.
    if (interaction) { const why = interaction.snapshot().why; if (capsule.dataset.autoClose !== why) capsule.dataset.autoClose = why; }
    paintPin();
    if (edgeInteraction) {
      // Native input-mask changes may swallow pointerleave. Reconcile against
      // WebKit's live hover hit-test before arming another idle deadline.
      const facts = { ...interactionFacts(), pointerInside: typeof island.matches === 'function' ? island.matches(':hover') : undefined, pinned: !!interaction?.snapshot().pinned };
      edgeInteraction.update(facts);
      // Diagnostic only: no layout, and an unavailable diagnostic must never break interaction.
      try { const why = edgeInteraction.snapshot().why; if (capsule.dataset.edgeWhy !== why) capsule.dataset.edgeWhy = why; } catch { /* optional diagnostic */ }
    }
  }
  // HU-057 S9: S/M/L/Auto. The scale is AbitoNusa.sizeScale(setting, work-area width) published as --nusa-size on #capsule
  // (the expanded notch scales as one piece, origin top-centre). The native window is 752 wide and the notch 720, so anything
  // above 752/720 is clamped: the notch can never outgrow the window it is drawn in (geometry::ISLAND_WINDOW is untouched).
  const NUSA_MAX_SCALE = 752 / 720;
  function applyIslandSize(setting) {
    const N = window.AbitoNusa; if (!N || !capsule) return;
    const area = (window.screen && Number(window.screen.availWidth)) || 0;
    const k = Math.min(N.sizeScale(N.SIZES.some(x => x.id === setting) ? setting : 'auto', area, 0), NUSA_MAX_SCALE);
    capsule.style.setProperty('--nusa-size', String(+k.toFixed(4)));
  }
  function applyInteractionPrefs(p) {
    if (!interaction || !p) return;
    applyIslandSize(p.islandSize);
    if (edgeInteraction) edgeInteraction.setPreferences({ sound:p.sound !== false, absenceSeconds:p.absenceSeconds ?? 10 });
    // An absent/foreign pair (a host without #336) keeps the module defaults.
    if (Number.isInteger(p.autoCloseSeconds) && typeof p.openOnHover === 'boolean') {
      try { interaction.setPreferences({ autoCloseSeconds: p.autoCloseSeconds, openOnHover: p.openOnHover }); }
      catch { /* an invalid pair never reaches the module */ }
    }
  }
  if (interaction) {
    // Native phase/view + the panel/question/card flags are DOM truth already;
    // the module consumes them through one entry point, never a frame loop.
    new MutationObserver(syncInteraction).observe(capsule, { attributes: true, attributeFilter: ['data-phase', 'data-view', 'data-settings', 'data-question', 'data-card'] });
    document.addEventListener('focusin', syncInteraction);
    document.addEventListener('focusout', syncInteraction);
    document.addEventListener('input', syncInteraction);
    document.addEventListener('compositionstart', () => { composingIME = true; syncInteraction(); });
    document.addEventListener('compositionend', () => { composingIME = false; syncInteraction(); });
    // Trusted-mouse filtering is the module's own public contract (enter/leave/
    // engage reject anything synthetic); these listeners only forward events.
    capsule.addEventListener('pointerenter', e => { interaction.enter(e); });
    capsule.addEventListener('pointerleave', e => { interaction.leave(e); });
    island.addEventListener('pointerenter', e => { edgeInteraction?.enter(e); syncInteraction(); });
    island.addEventListener('pointerleave', e => { edgeInteraction?.leave(e); syncInteraction(); });
    document.addEventListener('click', e => { interaction.engage(e); });
    document.addEventListener('keydown', e => { interaction.engage(e); });
    window.addEventListener('pagehide', () => { interaction.stop(); edgeInteraction?.stop(); });
    // No event follows a swallowed pointerleave: while the island believes the pointer is inside, re-read the live hover once a second.
    setInterval(() => { if (interaction.snapshot().inside && !document.hidden) syncInteraction(); }, 1000);
  }

  // ---- notices (M2): DISPLAY text only ---------------------------------
  // Sileo-style local notice in the island, own code, total silence: the
  // snapshot carries the text, this block renders it, and nothing here ever
  // decides, approves or opens anything. `dismiss` only clears what is
  // shown; the approval card above is the ONLY thing that can reach
  // `/execute`, and only through a trusted human click.
  const noticesEl = $('notices');
  const connectionEl = $('connection');
  let lastConn = null, piState = null, engineRow = null;
  // Coucou's idle-card pair (status dot + label, one link) for every state in which Pi is not working; two mounts of the same
  // row: the idle card and the strip under the ticker (the ticker covers the idle card while sessions are listed).
  const OMIT_KEY = 'abito.engineOmit';
  const omitted = () => { try { return localStorage.getItem(OMIT_KEY); } catch { return null; } };
  const setOmitted = v => { try { if (v) localStorage.setItem(OMIT_KEY, v); else localStorage.removeItem(OMIT_KEY); } catch { /* storage may be unavailable */ } };
  function paintEngine() {
    engineRow = O.engineRowView(lastConn, piState);
    const centreEl = $('col-centre'); if (centreEl) centreEl.dataset.engine = engineRow ? 'on' : 'off';
    // the in-centre rows stay in the DOM (state + tests) but are never drawn: the band below is the one place this is shown
    for (const [box, label, link] of [['overview-engine', 'overview-engine-label', 'overview-engine-link'], ['overview-engine-live', 'overview-engine-live-label', 'overview-engine-live-link']]) {
      const el = $(box);
      if (!el) continue;
      el.hidden = !engineRow;
      if (engineRow) { $(label).textContent = engineRow.label; $(link).textContent = engineRow.link; $(link).setAttribute('aria-label', engineRow.aria); el.dataset.kind = engineRow.kind; }
    }
    // S11: a resolved problem forgets its «Omitir»; a skipped one stays silent until it resolves and comes back
    if (!engineRow && omitted()) setOmitted(null);
    const band = $('engine-band'), on = !!engineRow && omitted() !== engineRow.kind;
    capsule.dataset.engineBand = engineRow ? (on ? 'on' : 'omitted') : 'off';
    if (band) {
      band.hidden = !on;
      if (engineRow) {
        band.dataset.kind = engineRow.kind;
        $('engine-band-label').textContent = engineRow.label; $('engine-band-link').textContent = engineRow.link; $('engine-band-link').setAttribute('aria-label', engineRow.aria);
        $('engine-band-skip').setAttribute('aria-label', `Omitir aviso: ${engineRow.label}`);
      }
    }
    if (on !== engineBandOn) { engineBandOn = on; render(); }
  }
  const skipEngine = $('engine-band-skip');
  if (skipEngine) skipEngine.addEventListener('click', event => { if (event.isTrusted === true && engineRow) { setOmitted(engineRow.kind); paintEngine(); } });
  const linkEngine = $('engine-band-link');
  if (linkEngine) linkEngine.addEventListener('click', event => { if (event.isTrusted === true && engineRow) document.dispatchEvent(new CustomEvent('abito:settings-select', { detail: engineRow.target })); });
  const openPiSection = event => { if (event.isTrusted === true && engineRow) document.dispatchEvent(new CustomEvent('abito:settings-select', { detail: engineRow.target })); };
  for (const id of ['overview-engine-link', 'overview-engine-live-link']) { const b = $(id); if (b) b.addEventListener('click', openPiSection); }
  document.addEventListener('abito:pi-state', event => { piState = event.detail || null; paintEngine(); });
  connectionEl.addEventListener('click', event => { if (event.isTrusted === true && lastConn && lastConn.action) document.dispatchEvent(new CustomEvent('abito:settings-select', { detail: lastConn.action.target })); });
  const noticeTitle = $('notice-title');
  const noticeDetail = $('notice-detail');
  const noticeDismiss = $('notice-dismiss');
  const noticePill = $('notice-pill');
  const noticeInfo = $('notice-info');
  // #437: the design band state. `noticeBand` is the pure band view currently
  // painted; `noticeListOpen` is the local «Ver» list (presentation only —
  // never part of the native-confirmed navigation contract).
  let noticeBand = null;
  let noticeListOpen = false;
  const O = window.AbitoOverview;
  const NV = window.AbitoNotify;
  const ICONS = window.AbitoIcons;
  const icon = name => (ICONS ? ICONS.svg(name) : '');
  // #411 (S2 of settings.js): icons are DOM NODES built from the CLOSED own
  // registry through DOMParser — the parser only ever receives ICONS literal
  // markup (`icon(name)` / `ICONS.ring(fraction)`), never data, so no string
  // can become markup. An empty/unknown registry entry answers null and
  // clears the host, exactly like the empty string the old write got.
  const svgParser = new DOMParser();
  function iconNode(markup) {
    if (!markup) return null;
    const doc = svgParser.parseFromString(markup, 'image/svg+xml');
    return doc.documentElement && doc.documentElement.nodeName === 'svg'
      ? document.importNode(doc.documentElement, true) : null;
  }
  const putIcon = (host, node) => { if (host) host.replaceChildren(...(node ? [node] : [])); };
  // The waiting/status dot is an element too, never a literal `<span>`.
  const dotNode = () => { const dot = document.createElement('span'); dot.className = 'dot'; return dot; };
  // ---- #437: the design band and the notices list (DOM nodes only, never markup) ----
  // The band keeps the native-confirmed opener (#notice-open: ring + stacked
  // title/age) and its own × (#notice-dismiss); the design's one action rides
  // #notice-action («Abrir» keeps the native contract, «Ver» opens the local
  // list). The old count badge is gone: the title says «N avisos» itself. The
  // list view («Avisos · N» + «Descartar todos» + 32 px rows) is presentation
  // only: every dismissal still rides the closed desktop verbs.
  const noticeSub = document.createElement('span');
  noticeSub.id = 'notice-sub';
  const noticeAction = document.createElement('button');
  noticeAction.type = 'button';
  noticeAction.id = 'notice-action';
  const noticeList = document.createElement('div');
  noticeList.id = 'notice-list';
  noticeList.hidden = true;
  noticeList.setAttribute('role', 'group');
  noticeList.setAttribute('aria-label', 'Avisos');
  const noticeListHead = document.createElement('div');
  noticeListHead.id = 'notice-list-head';
  const noticeListTitle = document.createElement('strong');
  noticeListTitle.id = 'notice-list-title';
  const noticeClear = document.createElement('button');
  noticeClear.type = 'button';
  noticeClear.id = 'notice-clear';
  noticeClear.textContent = 'Descartar todos';
  noticeClear.setAttribute('aria-label', 'Descartar todos los avisos');
  const noticeRows = document.createElement('div');
  noticeRows.id = 'notice-rows';
  noticeListHead.replaceChildren(noticeListTitle, noticeClear);
  noticeList.replaceChildren(noticeListHead, noticeRows);
  // Rebuild the strip's children ONCE at boot: the same static elements, the
  // list rides last. The opener swallows the stacked title/age; the action and
  // the × follow it inside the band.
  const noticeChips = $('notice-row');
  if (noticesEl && noticePill && noticeDetail && noticeChips) {
    const noticeText = document.createElement('span');
    noticeText.className = 'notice-text';
    noticeText.replaceChildren(noticeTitle, noticeSub);
    $('notice-open').replaceChildren($('notice-ring'), noticeText);
    noticePill.replaceChildren($('notice-open'), noticeAction, noticeDismiss);
    noticesEl.replaceChildren(noticeChips, noticePill, noticeDetail, noticeList, ...($('notice-card') ? [$('notice-card')] : []));
  }
  // #266: incoming-event reveal (Sileo-style). The pure gates in notify-view.js
  // decide WHICH snapshots are events (boot replays and churn are not); the pure
  // revealAction decides whether this capsule may act: a resting compact island
  // and a HIDDEN one expand, through the host's own verb — Rust owns the native
  // geometry, the existing contract spring animates the reveal, and the M1
  // reduced-motion policy snaps it instantly (deliberately preserved). #266 S2
  // Path B: `expand` reveals from Hidden too (src/desktop.rs), and the host
  // shows the window WITHOUT focus (src/main.rs: unminimize+show, never
  // set_focus; a stale expanded core is shown in place, never toggle-collapsed).
  // Only genuinely new events reach this: boot/cached/duplicate snapshots never
  // call the verb, so nothing restores on start-up.
  const revealGate = NV && NV.createRevealGate ? NV.createRevealGate() : null;
  const toastGate = NV && NV.createRevealGate ? NV.createRevealGate() : null; // the toast has its own boot baseline, independent of the finished cycle's
  let automaticExpansion = false;
  function finishedAllowed() {
    const f = interactionFacts();
    const guards = window.AbitoIslandInteraction?.BLOCKERS;
    return !!guards && f.nativeReady && !current?.unavailable && !(O && O.bridgeView(current)) && ['overview','notices'].includes(f.view) &&
      guards.every(key => f[key] === false) && !interaction?.snapshot().pinned;
  }
  const finishedCycle = NV?.createFinishedCycle?.({
    now: () => performance.now(), schedule: (fn, ms) => setTimeout(fn, ms), cancel: id => clearTimeout(id),
    start(id) {
      // HU-006: a visible compact island no longer grows on its own, so only a hidden reveal is an automatic expansion
      automaticExpansion = !!noticeLane?.automatic || current?.state === 'hidden';
      revealIsland(false, true);
      noticeLane = { id, view:'notices', automatic:true };
      capsule.dataset.noticeView = 'notices';
      moveView(0); renderCard(); paintNoticeCard(null); render();
      document.dispatchEvent(new CustomEvent('island:view', {detail:'notices'}));
    },
    end(id, expired) {
      const ownsView = noticeLane?.automatic && noticeLane.id === id;
      const fold = ownsView && expired && automaticExpansion && finishedAllowed() &&
        capsule.dataset.phase === 'expanded' && !capsule.matches(':hover');
      automaticExpansion = false;
      if (compactNoticeId === id) showCompactNotice(null);
      if (!ownsView) return;
      noticeLane = null; delete capsule.dataset.noticeView;
      moveView(0); renderCard(); render(); syncInteraction();
      document.dispatchEvent(new CustomEvent('island:view', {detail:'overview'}));
      // Same atomically guarded host verb as ordinary inactivity. Never dismiss.
      if (fold && window.desktop?.autoClose) window.desktop.autoClose().catch(() => {});
    },
  });
  const engageFinished = event => { if (event.isTrusted && (event.type === 'click' || !event.repeat && !event.isComposing)) automaticExpansion = false; };
  document.addEventListener('click', engageFinished);
  document.addEventListener('keydown', engageFinished);
  window.addEventListener('pagehide', () => finishedCycle?.stop());
  let revealFlight = false;
  // HU-006 S4: the notice the compact pill shows (display title only); the human opens it with the pill's own click (S6)
  let compactNoticeId = null;
  function showCompactNotice(n) {
    compactNoticeId = n ? n.id : null;
    document.dispatchEvent(new CustomEvent('abito:compact-notice', { detail: n ? { kind: n.kind === 'attention' ? 'attention' : 'settled', title: n.title } : null }));
  }
  if (desktopCharacter) desktopCharacter.attach({ clay, reveal: () => revealIsland() }); // #486
  function revealIsland(question = false, notice = false) {
    edgeInteraction?.alert();
    if (!NV || typeof NV.revealAction !== 'function' || revealFlight) return;
    const action = NV.revealAction({ state: current && current.state, phase: capsule.dataset.phase, view: capsule.dataset.view, question, notice });
    if (action === 'leave-chat' || action === 'show-question') { openQuestion(); return; }
    if (action !== 'expand') return;
    if (!window.desktop || typeof window.desktop.expand !== 'function') return;
    revealFlight = true; // one host call at a time; the spring itself is interruptible
    window.desktop.expand().then(snap => {
      revealFlight = false;
      if (snap) { current = snap; syncToggle(snap.state); }
    }, () => { revealFlight = false; });
  }
  // Static own icons: closed registry, never data.
  for (const el of document.querySelectorAll('[data-icon]')) putIcon(el, iconNode(icon(el.dataset.icon)));

  // «i» buttons reveal the long sentence that used to be on screen (§2.1);
  // the same text is also the aria name/description of the chip.
  function toggleInfo(button, panel, force) {
    const open = force === undefined ? button.getAttribute('aria-expanded') !== 'true' : force;
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
    panel.hidden = !open;
    return open;
  }
  if (noticeInfo) noticeInfo.addEventListener('click', () => toggleInfo(noticeInfo, noticeDetail));

  // Q1: polite announcement of a NEW notice (once), plain text.
  const noticeLive = $('notice-live');
  let lastNoticeId = null;
  // #313: the sound wiring (sound-wiring.js) is optional: no engine, no cue, no error.
  function soundCue(method, arg) {
    const w = window.AbitoSoundWiringInstance;
    try { if (w && typeof w[method] === 'function') w[method](arg); } catch { /* sound never breaks the island */ }
  }
  function announceNotice(notices) {
    const V = window.AbitoChatView;
    if (!V || !noticeLive) return;
    const text = V.noticeAnnouncement(lastNoticeId, notices);
    lastNoticeId = notices.length ? notices[0].id : null;
    if (text) {
      noticeLive.textContent = '';
      requestAnimationFrame(() => { noticeLive.textContent = text; });
    }
  }

  function paintBand(notices) {
    const view = O.noticeBandView(notices, Date.now());
    if (view) putIcon($('notice-ring'), iconNode(ICONS.ring(view.fraction)));
    // L37: Coucou's 2px countdown bar under the capsule is drawn from the same 60 s window the ring used
    if (view) $('notice-pill').style.setProperty('--left', String(view.fraction));
    return view;
  }
  function renderNotices(snapshot) {
    syncCountdownTimer();
    if (!snapshot || !noticesEl || !O) return;
    const notices = Array.isArray(snapshot.notices) ? snapshot.notices : [];
    announceNotice(notices);
    soundCue('observeNotices', notices); // #313: only a NEW top notice sounds, never the ones already there at start-up
    const arrivals = toastGate ? toastGate.arrivals(notices) : []; // the toast's own baseline gate: boot/retained rows are not arrivals
    const fresh = finishedCycle ? finishedCycle.observe(notices, finishedAllowed()) : revealGate?.notice(notices);
    // F6 (SN1): an attention notice alone (Codex asks in its own terminal) is signalled by the Sileo pill, not by forcing the island open
    const attentionOnly = arrivals.length > 0 && arrivals.every(x => x.kind === 'attention');
    // human 26-oct: Sileo toasts only while Abito is hidden; a visible island shows the attention notice itself (its Avisos strip)
    if (fresh) { if (attentionOnly && capsule.dataset.edgeHidden === 'true') edgeInteraction?.alert(); else revealIsland(false, true); } // boot, retained rows and snapshot churn are not arrivals
    // HU-006 S4: the latest new notice reads inside the compact pill; a notice that left the list leaves the pill
    const shownArrival = arrivals.filter(x => !x.kind || x.kind === 'settled' || x.kind === 'attention').at(-1);
    if (shownArrival) showCompactNotice(shownArrival);
    else if (compactNoticeId && !notices.some(n => n && n.id === compactNoticeId)) showCompactNotice(null);
    // Sileo toast: ONE «terminó» event per NEW settled notice; display text only
    const settled = arrivals.filter(x => !x.kind || x.kind === 'settled').at(-1);
    if (settled) document.dispatchEvent(new CustomEvent('abito:notice-arrival', { detail: { id: settled.id, kind: 'settled', title: settled.title, agent: settled.agent, projectName: settled.projectName } }));
    // ... and ONE «<Agente> te pide permiso / te pregunta» event per NEW attention notice: its one validated display line, never a decision
    const attention = arrivals.filter(x => x.kind === 'attention').at(-1);
    if (attention) document.dispatchEvent(new CustomEvent('abito:notice-arrival', { detail: { id: attention.id, kind: 'attention', title: attention.title, detail: attention.detail, agent: attention.agent, projectName: attention.projectName } }));
    const conn = O.connectionView(snapshot);
    const overviewStatus = $('overview-status'), overviewDetail = $('overview-detail');
    if (overviewStatus) overviewStatus.textContent = conn.word || 'Conexión local';
    if (overviewDetail) overviewDetail.textContent = conn.detail;
    connectionEl.dataset.tone = conn.tone;
    connectionEl.setAttribute('aria-label', conn.action ? conn.actionAria : conn.aria);
    connectionEl.disabled = !conn.action;
    lastConn = conn;
    connectionEl.dataset.kind = conn.kind;
    putIcon($('connection-icon'), iconNode(icon(conn.icon)));
    $('connection-word').textContent = conn.word;
    paintEngine();
    const bridge = O.bridgeView(snapshot);
    const bridgeChip = $('bridge');
    bridgeChip.hidden = !bridge;
    if (bridge) {
      bridgeChip.dataset.tone = bridge.tone;
      bridgeChip.setAttribute('aria-label', bridge.aria);
      putIcon($('bridge-icon'), iconNode(icon(bridge.icon)));
      $('bridge-word').textContent = bridge.word;
    }
    const first = notices[0] || null;
    const opener = $('notice-open');
    if (opener) {
      opener.disabled = !first;
      opener.setAttribute('aria-label', first ? `Ver Avisos · ${notices.length}` : 'Sin avisos');
    }
    // Human L39 (verbatim): «tambien en la preview dejame usar abito y soluciona lo de sin conexion».
    // Deliberate behaviour change approved by the human: with no Pi session the island shows
    // Coucou's idle look and a quiet «Sin motor» status line, NOT the old red «Sin conexión» band.
    // Red stays only for a real failure (the receiver did not start). Pinned in island-notices-check.
    const view = paintBand(notices);
    noticeBand = view;
    // #373 GD032: the strip carries the view's severity tone (error → red,
    // warning → sun); plain dataset writes below, never markup.
    noticesEl.dataset.tone = (view && view.tone) || '';
    noticesEl.dataset.count = view ? String(view.count) : ''; // #437: no badge — the title says «N avisos» itself
    // Keep the inbox open across 2→1 pushes; only an empty inbox closes it.
    const list = O.noticeListView(notices, Date.now());
    if (!list) noticeListOpen = false;
    // S10 (L22): Coucou's overview has no connection strip. A healthy connection with nothing to say draws nothing here;
    // a problem (no engine, bridge down, hotkey) or a notice keeps its honest strip.
    noticesEl.dataset.calm = (!first && conn.tone === 'go' && !bridge && !view) ? 'true' : 'false';
    // quiet: only the connection status line is left (no band, no list): Coucou draws its status as a line, not a card
    noticesEl.dataset.quiet = !view ? 'true' : 'false';
    noticesEl.dataset.grouped = view && view.grouped ? 'true' : 'false';
    noticesEl.dataset.list = noticeListOpen ? 'open' : 'closed';
    if (capsule.dataset.noticeList !== noticesEl.dataset.list) capsule.dataset.noticeList = noticesEl.dataset.list;
    noticePill.hidden = !view || noticeListOpen;
    // S1 (abito-avisos-ux): the Avisos band lives in the bottom slot «Sin cuenta» uses (a compact 32px strip), never over the sessions
    const strip = !!view && !noticeListOpen ? 'on' : 'off';
    if (capsule.dataset.noticeStrip !== strip) { capsule.dataset.noticeStrip = strip; noticeStripOn = strip === 'on'; render(); }
    if (view) {
      noticePill.setAttribute('aria-label', view.aria);
      noticeTitle.textContent = view.title;
      noticeTitle.dataset.icon = view.icon;
      noticeSub.hidden = true; // the inbox entry stays readable in the narrow column
      noticeSub.textContent = view.detail || '';
      // R14: every admitted notice leads to the local inbox, including transport errors.
      noticeOpen.disabled = view.action == null;
      noticeAction.hidden = view.action == null;
      noticeAction.textContent = view.grouped ? 'Ver' : 'Abrir';
      noticeAction.setAttribute('aria-label', view.grouped ? `Ver los ${view.count} avisos` : `Abrir aviso: ${first ? first.title : ''}`);
    }
    // R14/R20: «Avisos · N», clear-all and scrollable 44px rows replace the band.
    if (noticeListOpen && list) {
      noticeListTitle.textContent = `Avisos · ${list.count}`;
      noticeRows.replaceChildren(...list.rows.map(noticeRowNode));
      noticeList.hidden = false;
      noticeChips.hidden = true;
    } else {
      noticeListOpen = false; // no notices: back to the quiet overview
      noticeList.hidden = true;
      noticeChips.hidden = false;
    }
    noticeDetail.textContent = first ? `${first.title}. ${first.detail || ''}`.trim() : (bridge ? `${conn.detail} ${bridge.detail}` : conn.detail);
    noticeInfo.setAttribute('aria-label', O.infoLabel(first ? 'Ver detalle del aviso' : 'Ver detalle de la conexión', first ? view.aria : conn.aria));
    noticeDismiss.hidden = !first;
    paintNoticeCard(first);
    syncCalm();
    noticesEl.hidden = false;
    paintCardConn(conn, bridge);
  }
  // The strip is calm (drawn as nothing) only when the connection is healthy, there is no notice and the hotkey chip is quiet too.
  function syncCalm() {
    const calm = !!noticesEl && noticesEl.dataset.calm === 'true' && !!$('hotkey') && $('hotkey').hidden;
    capsule.dataset.noticesCalm = calm ? 'true' : 'false';
  }
  // S10 (L22): Coucou's finished card for the confirmed-notice lane. «OK» is the same dismissal as the band's ×.
  const noticeCard = $('notice-card'), noticeCardOk = $('notice-card-ok');
  // A+E CTA of the calm centre: it presses the header's own «+» (a new conversation), exactly as the human would
  document.addEventListener('abito:centre-new', () => { const plus = $('open-new'); if (plus && !plus.disabled) plus.click(); });
  // D: the finished result wraps (never a truncated line), so the card may need more than the 108px overview card. It asks the island
  // for the height it needs (capped like a question, then it scrolls inside); the window grows through the existing on-demand verb.
  // S10 (10 «Pi terminó», B): the notice is a fixed 32px band UNDER the overview, so the island is 36px taller while it shows.
  const FINISHED_BAND_H = 36;
  // HU-063 (human, 29-oct): in the Nusa take-over the island ADJUSTS to the card: 36px header strip + the card as tall as its wrapped
  // message needs + a 16px bottom air, never above the frozen 340 window less its 16px air. Other cases keep the fixed overview height.
  const FINISHED_HEAD = 36, FINISHED_AIR = 16, FINISHED_MAX = 340 - 16;
  function fitFinished(shown) {
    let next = shown || capsule.dataset.noticeBand === 'true' ? OVERVIEW.h + FINISHED_BAND_H : 0;
    if (next && shown && capsule.dataset.takeover && noticeCard && !noticeCard.hidden && noticeCard.offsetHeight > 0)
      next = Math.min(FINISHED_MAX, Math.max(OVERVIEW.h - 2, Math.ceil(FINISHED_HEAD + noticeCard.offsetHeight + FINISHED_AIR)));
    if (next !== finishedH) { finishedH = next; render(); }
  }
  if (noticeCard && typeof ResizeObserver === 'function') {
    new ResizeObserver(() => { if (noticeLane?.view === 'notices') fitFinished(true); }).observe(noticeCard);
    new MutationObserver(() => { if (noticeLane?.view === 'notices') fitFinished(true); }).observe(capsule, { attributes: true, attributeFilter: ['data-takeover'] });
  }
  // the band appears when an agent finished and goes away while THAT agent runs again (human note: «aparece y se oculta dependiendo si terminó, o si está corriendo»)
  let runningNow = [];
  document.addEventListener('abito:layout', event => {
    const r = event.detail && Array.isArray(event.detail.running) ? event.detail.running : [];
    const same = r.length === runningNow.length && r.every((x, i) => x.kind === runningNow[i].kind && x.cwd === runningNow[i].cwd);
    runningNow = r;
    if (!same && noticeLane?.view === 'notices') paintNoticeCard(null);
  });
  const agentRunning = n => !!n && typeof n.agent === 'string' && runningNow.some(r => r.kind === n.agent && (!n.projectName || !r.cwd || r.cwd === n.projectName));
  let noticeTerminalId = null;
  function paintNoticeCard(first) {
    if (!noticeCard) return;
    const selected = noticeLane?.view === 'notices' ? current?.notices?.find(n => n.id === noticeLane.id) : first;
    const v = selected && !agentRunning(selected) && O.finishedCardView ? O.finishedCardView(selected, NV && NV.agentLabel) : null;
    noticeCard.hidden = !v;
    noticeCard.dataset.severity = selected && selected.severity === 'error' ? 'error' : 'info'; // HU-057 T5: display data only (the Nusa takeover reads it; no behaviour)
    noticeTerminalId = v && selected ? selected.id : null;
    // R14: retained history uses Avisos; the S10 band remains for native-confirmed detail only.
    capsule.dataset.noticeBand = 'false';
    document.dispatchEvent(new CustomEvent('abito:finished-shown', { detail: { shown: !!v && noticeLane?.view === 'notices' } }));
    if (!v) {
      fitFinished(false);
      // «un "Terminó" nunca debe mostrarse sin contenido»: the lane is only open while its card is shown; close it like the other lane exits (end / question-open)
      if (noticeLane?.view === 'notices') {
        noticeLane = null; delete capsule.dataset.noticeView;
        moveView(0); renderCard(); render(); syncInteraction();
        document.dispatchEvent(new CustomEvent('island:view', { detail: 'overview' }));
      }
      return;
    }
    $('notice-card-name').textContent = v.name;
    $('notice-card-verb').textContent = v.verb;
    const msg = $('notice-card-message'); // human 29-oct: the notch card wraps the WHOLE result; the model's one-line cut («…») only applies without the Nusa look
    const whole = window.AbitoNusa && v.message && /…$/.test(v.message) && v.full && v.full.length > v.message.length ? v.full : v.message;
    msg.textContent = whole; msg.hidden = !v.message; msg.setAttribute('data-tip', v.full);
    const t = $('notice-card-terminal'); t.disabled = !v.terminal.available;
    fitFinished(noticeLane?.view === 'notices');
  }
  // «Ver» selects only the displayed notice id; the host owns and revalidates its terminal origin.
  // The closed host verb `focus_host {target:'terminal', origin:'notice', id}` (focushost.rs): no command, path or window id
  // ever leaves the page; a refusal is the host's public Spanish reason, shown on the button and announced politely.
  const noticeCardTerminal = $('notice-card-terminal');
  if (noticeCardTerminal) noticeCardTerminal.addEventListener('click', event => {
    if (event.isTrusted !== true || !invoke) return;
    const id = noticeTerminalId;
    if (!id || noticeCard.hidden) return;
    noticeCardTerminal.disabled = true;
    invoke('focus_host', { payload: { target: 'terminal', origin: 'notice', id } }).then(() => { noticeCardTerminal.title = ''; }, error => {
      const reason = typeof error === 'string' ? error : (error && typeof error.message === 'string' ? error.message : 'No se pudo abrir la terminal.');
      noticeCardTerminal.title = reason;
      const live = $('notice-live'); if (live) live.textContent = reason;
    }).finally(() => { noticeCardTerminal.disabled = false; });
  });
  if (noticeCardOk) noticeCardOk.addEventListener('click', event => {
    const id = noticeLane?.id;
    if (event.isTrusted !== true || !id || !window.desktop?.dismiss) return;
    window.desktop.dismiss(id).then(snap => {
      if (snap) current = snap;
      renderNotices(current); renderCard();
    }, () => {});
  });
  // «Preguntar» is the chat tab (Coucou: Ask Claude → prompt view).
  const askButton = $('overview-ask');
  if (askButton) askButton.addEventListener('click', event => { if (event.isTrusted === true) { const t = $('open-chat'); if (t) t.click(); } });
  // §3: the card hides the notices strip, so a missing Pi / downed channel
  // stays visible beside it (icon + word; nothing when healthy).
  function paintCardConn(conn, bridge) {
    const bchip = $('card-bridge');
    if (bchip) {
      bchip.hidden = !bridge;
      if (bridge) {
        bchip.dataset.tone = bridge.tone;
        bchip.setAttribute('aria-label', bridge.aria);
        putIcon($('card-bridge-icon'), iconNode(icon(bridge.icon)));
        $('card-bridge-word').textContent = bridge.word;
      }
    }
    const chip = $('card-conn');
    if (!chip) return;
    const shown = O.cardConnection(conn);
    chip.hidden = !shown;
    if (!shown) return;
    chip.dataset.tone = shown.tone;
    chip.setAttribute('aria-label', shown.aria);
    putIcon($('card-conn-icon'), iconNode(icon(shown.icon)));
    $('card-conn-word').textContent = shown.word;
  }
  if (window.desktop) {
    try { window.desktop.onState(snapshot => { current = snapshot; refreshHost(snapshot); renderNotices(snapshot); renderCard(); syncInteraction(); }); } catch { /* facade optional */ }
    try { window.desktop.snapshot().then(snapshot => { current = snapshot; refreshHost(snapshot); renderNotices(snapshot); renderCard(); soundCue('firstSnapshotRendered'); syncInteraction(); }, () => {}); } catch { /* facade optional */ }
  }
  // #305: the global shortcut status (READ only: changing it is the settings panel's job, #308).
  function paintHotkey(view) {
    const chip = $('hotkey');
    const h = O && O.hotkeyView(view);
    chip.hidden = !h;
    syncCalm();
    if (!h) return;
    chip.dataset.tone = h.tone;
    chip.setAttribute('aria-label', h.aria);
    putIcon($('hotkey-icon'), iconNode(icon(h.icon)));
    $('hotkey-word').textContent = h.word;
  }
  if (invoke) {
    invoke('hotkey_action', { payload: { action: 'view' } }).then(paintHotkey, () => {});
    const listen = window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen;
    if (listen) listen('hotkey:state', event => paintHotkey(event && event.payload)).catch(() => {});
  }
  const noticeOpen = $('notice-open');
  // The entry opens local history. Only an individual UUID row requests native detail.
  if (noticeOpen) noticeOpen.addEventListener('click', event => {
    event.preventDefault();
    if (event.isTrusted === true) toggleNoticeList();
  });
  // Both entry targets open the same local inbox, even with one notice.
  function toggleNoticeList(force) {
    noticeListOpen = force === undefined ? !noticeListOpen : !!force;
    renderNotices(current);
  }
  noticeAction.addEventListener('click', event => {
    if (event.isTrusted !== true) return;
    if (noticeBand) toggleNoticeList();
  });
  // One 44px row. Its UUID button opens exactly that notice; × dismisses EXACTLY that notice
  // (desktop.dismiss(id)); Rust refuses an unknown id with zero mutation and
  // the refusal path never falls back — it only refreshes what is shown.
  function noticeRowNode(row) {
    const li = document.createElement('div');
    li.className = 'notice-list-row';
    li.dataset.tone = row.tone || '';
    const dot = document.createElement('span');
    dot.className = 'notice-list-dot';
    // S4/T2: an «attention» row is never openable either. The agent's own prompt is the only place to answer, so the
    // row is a pointer, not a button: its one line («… · Respondé en la terminal») names the terminal.
    const openable = row.kind !== 'transport' && row.kind !== 'attention' && NV && NV.openPayload({ isTrusted: true }, row, 'finished');
    const body = document.createElement(openable ? 'button' : 'div');
    body.className = 'notice-list-open';
    const title = document.createElement('span');
    title.className = 'notice-list-title';
    title.textContent = row.title;
    if (openable) {
      body.type = 'button';
      body.addEventListener('click', event => {
        const payload = NV.openPayload(event, row, 'finished');
        if (!payload || !window.desktop || typeof window.desktop.click !== 'function') return;
        try { window.desktop.click(payload).catch(() => {}); } catch { /* native refusal never falls back */ }
      });
    }
    const time = document.createElement('span');
    time.className = 'notice-list-time';
    time.textContent = [NV && NV.projectLabel ? NV.projectLabel(row.projectName) : row.projectName, row.agent && !row.title.toLowerCase().includes(row.agent.toLowerCase()) ? row.agent : '',
      row.detail, row.time].filter(Boolean).join(' · ');
    const text = document.createElement('span');
    text.className = 'notice-list-text';
    text.replaceChildren(title, time);
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'notice-list-dismiss';
    x.setAttribute('aria-label', `Descartar: ${row.title}`);
    x.addEventListener('click', event => {
      if (event.isTrusted !== true || !window.desktop || typeof window.desktop.dismiss !== 'function') return;
      window.desktop.dismiss(row.id).then(snap => {
        if (snap) { current = snap; syncToggle(snap.state); }
        renderNotices(current); renderCard();
      }, () => { renderNotices(current); }); // never falls back: refresh only
    });
    body.replaceChildren(dot, text);
    li.replaceChildren(body, x);
    return li;
  }
  // «Descartar todos»: the argument-free verb drops the FIRST notice, so the
  // loop repeats it until the store is empty, bounded by the queue (8).
  // Display-only; a dismissal never decides or approves anything.
  noticeClear.addEventListener('click', event => {
    if (event.isTrusted !== true || !window.desktop || typeof window.desktop.dismiss !== 'function') return;
    let snap = current;
    let guard = 8; // the notice queue is bounded at 8; never loop past it
    const step = () => {
      if (!snap || !Array.isArray(snap.notices) || !snap.notices.length || guard-- <= 0) {
        if (snap) { current = snap; syncToggle(snap.state); }
        renderNotices(current); renderCard();
        return;
      }
      window.desktop.dismiss().then(next => { snap = next; step(); }, () => { renderNotices(current); });
    };
    step();
  });
  // The list is transient: Escape returns to the band; a view change closes it.
  document.addEventListener('keydown', e => { if (e && e.key === 'Escape' && noticeListOpen) toggleNoticeList(false); });
  document.addEventListener('island:view', () => { if (noticeListOpen) toggleNoticeList(false); });
  const listenNotice = window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen;
  if (listenNotice) listenNotice('desktop:notice-open', event => {
    const payload = event && event.payload;
    const view = O && O.noticeOpenView(payload);
    if (!view) return;
    finishedCycle?.cancel(); // an explicit native-confirmed opener owns its view
    noticeLane = { id: payload.id, view };
    capsule.dataset.noticeView = view;
    moveView(0);
    renderCard();
    paintNoticeCard(null); // S10: the band is painted by the lane itself, not only by the next snapshot
    render();
    if (q.mode !== 'idle' && !raf) raf = requestAnimationFrame(tick);
    // The existing question controller rerenders through its public view event.
    document.dispatchEvent(new CustomEvent('island:view', { detail: capsule.dataset.view }));
  }).catch(() => {});
  // #384: the Dot's colour. The principal is green unless the HUMAN chose another colour in
  // Ajustes; a pose, an agent, a notice or a card is never an input (avatar-colors.js owns that
  // rule). The default green writes NO attribute, so the frozen engine paints exactly what it
  // always painted; any other colour comes from the CSS tint over the engine's own gradient.
  function paintChosenColor(node, color) {
    const stops = AVATAR?.gradientStops(color);
    if (!node?.style?.setProperty) return;
    for (let i = 0; i < 3; i++) node.style.setProperty('--chosen-' + (i + 1), stops?.[i] || '');
    node.style.setProperty('--identity-color', stops?.[1] || '');
  }
  const AVATAR = window.AbitoAvatarColors;
  function paintDotColor(prefsView) {
    if (!AVATAR || !island) return;
    const view = AVATAR.principalFrom(prefsView && prefsView.avatarColors);
    if (view.color === AVATAR.PRINCIPAL_COLOR) delete island.dataset.dotColor;
    else island.dataset.dotColor = view.color;
    paintChosenColor(island, view.color);
  }
  if (invoke) {
    invoke('prefs_action', { payload: { action: 'view' } }).then(p => { paintDotColor(p); applyInteractionPrefs(p); }, () => {});
    const listenPrefs = window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen;
    if (listenPrefs) listenPrefs('prefs:state', event => { paintDotColor(event && event.payload); applyInteractionPrefs(event && event.payload); }).catch(() => {});
  }
  if (noticeDismiss) {
    noticeDismiss.addEventListener('click', event => {
      event.preventDefault();
      // Wired with M2: clears the first notice; a dismissal is never a
      // decision and never reaches Pi as approval.
      try { if (window.desktop) { window.desktop.dismiss().then(renderNotices, () => {}); } } catch { /* facade optional */ }
    });
  }

  // ---- approval card (M3): DISPLAY only; the host is the boundary ------
  // The card fields come from the snapshot; the renderer sends NOTHING but
  // the human's click (`allow`/`deny`, zero arguments — never an id or a
  // hash). Rust re-validates card id, expiry and payload_hash before any
  // `/execute`. A notice never approves anything, an untrusted event never
  // reaches the host, and controls are locked while a decision is in
  // flight. Ported guards from the legacy renderer.js (validCard shape +
  // calendar, cardFeedback reasons, isTrusted + flight lock).
  let cardFlight = null;
  let cardFailure = null;

  function validCard(card) {
    if (!card || Array.isArray(card) || Object.keys(card).sort().join(',') !== 'expires_at,operation,reason,state' ||
      typeof card.operation !== 'string' || !card.operation.trim() || card.operation.length > 120 ||
      /[\x00-\x1f\x7f-\x9f]/.test(card.operation) || typeof card.expires_at !== 'string') return false;
    const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(card.expires_at);
    if (!parts || parts[0] !== card.expires_at || !Number.isFinite(Date.parse(card.expires_at))) return false;
    const [, y, m, d, h, min, s, oh, om] = parts;
    const leap = +y % 4 === 0 && (+y % 100 !== 0 || +y % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return +m >= 1 && +m <= 12 && +d >= 1 && +d <= days[+m - 1] && +h <= 23 && +min <= 59 &&
      +s <= 59 && (oh === undefined || (+oh <= 23 && +om <= 59)) &&
      ((card.state === 'pending' && card.reason === null) ||
        (card.state === 'inert' && typeof card.reason === 'string' && Boolean(card.reason.trim())));
  }
  // Match the existing host expiry projection's wall-clock rule (Date.now).
  // Invalid/missing timestamps cannot establish a live blocker; Rust still
  // validates every decision. Keep validCard's shape check for inert feedback.
  function pendingCard(card) {
    return validCard(card) && card.state === 'pending' && Date.now() < Date.parse(card.expires_at);
  }
  function cardKey(card) { return JSON.stringify([card.operation, card.expires_at]); }
  function cardFeedback(card) {
    if (noticeLane) return 'Abrí la tarjeta para decidir.';
    if (card.state === 'inert') return card.reason;
    if (Date.now() >= Date.parse(card.expires_at)) return 'Propuesta vencida.';
    if (cardFlight) return 'Decisión en curso.';
    if (cardFailure && cardFailure.key === cardKey(card) && current.revision <= cardFailure.revision)
      return 'No se pudo confirmar la decisión. Esperá una actualización.';
    if (current.state !== 'expanded' || capsule.dataset.phase !== 'expanded' ||
      capsule.dataset.view !== 'overview') return 'Abrí la tarjeta para decidir.';
    return null;
  }
  function paintExpiry(card) {
    const now = Date.now();
    const expiry = $('expiry');
    expiry.textContent = O.expiryLabel(card.expires_at, now);
    expiry.setAttribute('datetime', card.expires_at);
    $('card-expiry').setAttribute('aria-label', O.expiryAria(card.expires_at, now));
  }
  // UI.2 §6 compact indicator: waiting card -> sun dot, channel down -> red
  // triangle. Pure shape+colour; the accessible name says what it means.
  function paintCompactFlag() {
    const flag = $('compact-flag');
    if (!flag) return;
    const card = current && current.card;
    const waiting = validCard(card) && Date.now() < Date.parse(card.expires_at) &&
      (card.state === 'pending' || card.reason === 'Abrí la tarjeta para decidir.'); // covered = still waiting for you
    const questionWaiting = !!(capsule.dataset.question === 'pending');
    const bridgeDown = !!(O && O.bridgeView(current));
    const down = !!(current && current.unavailable === true) || bridgeDown;
    flag.hidden = !(waiting || questionWaiting || down);
    if (flag.hidden) return;
    flag.dataset.tone = (waiting || questionWaiting) ? 'sun' : 'red';
    flag.setAttribute('aria-label', questionWaiting && !waiting ? 'Pi espera tu respuesta' : waiting ? 'Algo espera tu decisión' : (bridgeDown ? 'Sin puente' : 'Avisos caídos'));
    putIcon($('compact-flag-icon'), (waiting || questionWaiting) ? dotNode() : iconNode(icon('triangle')));
  }
  // The bridge approval card (#permission) ADJUSTS the island like the finished card: the lowest control + a 16px air, never above the
  // frozen 340 window less its 16px air. Only in the Nusa «waiting» take-over; everything else keeps the fixed overview height.
  function fitCard() {
    let next = 0;
    const perm = $('permission');
    if (cardShown && perm && !perm.hidden && capsule.dataset.takeover === 'waiting' && capsule.dataset.phase === 'expanded') {
      const top = island.getBoundingClientRect().top; let low = 0;
      for (const id of ['allow', 'deny', 'card-fold', 'card-actions']) { const e = $(id); if (e && e.offsetHeight > 0) low = Math.max(low, e.getBoundingClientRect().bottom - top); }
      if (low > 0) next = Math.min(FINISHED_MAX, Math.max(OVERVIEW.h, Math.ceil(low + FINISHED_AIR)));
    }
    if (next !== cardH) { cardH = next; render(); }
  }
  for (const id of ['operation', 'card-actions']) { const e = $(id); if (e && typeof ResizeObserver === 'function') new ResizeObserver(() => fitCard()).observe(e); }
  new MutationObserver(() => fitCard()).observe(capsule, { attributes: true, attributeFilter: ['data-takeover', 'data-phase'] });
  function renderCard() {
    syncCountdownTimer();
    paintCompactFlag();
    const card = current && current.card;
    const valid = validCard(card);
    soundCue('observeCard', valid && card.state === 'pending' && typeof card.id === 'string' ? card.id : null); // #313: a card BECOMING pending
    const permission = $('permission');
    if (!permission || !O) return;
    const visible = valid && !noticeLane;
    permission.hidden = !visible;
    permission.inert = !visible;
    for (const id of ['operation', 'expiry', 'card-status-word', 'card-reason']) { const el = $(id); if (el) el.textContent = ''; }
    $('expiry').removeAttribute('datetime');
    const allow = $('allow'), deny = $('deny');
    allow.disabled = true;
    deny.disabled = true;
    if (cardShown !== visible) { cardShown = visible; render(); }
    if (!visible) { delete capsule.dataset.card; delete capsule.dataset.cardTone; return; }
    const reason = cardFeedback(card);
    const view = O.cardView(reason);
    $('operation').textContent = card.operation;
    paintExpiry(card);
    $('card-expiry').hidden = view.kind === 'expired' || view.kind === 'sent';
    const status = $('card-status');
    status.dataset.tone = view.tone;
    status.dataset.kind = view.kind;
    status.setAttribute('aria-label', view.aria);
    putIcon($('card-status-icon'), view.icon ? iconNode(icon(view.icon)) : dotNode());
    $('card-status-word').textContent = view.kind === 'pending' ? 'necesita permiso' : view.word; // Coucou: «<name> needs permission»
    capsule.dataset.card = view.kind;
    capsule.dataset.cardTone = view.tone;
    const detail = $('card-reason');
    detail.textContent = reason || '';
    detail.hidden = !reason;
    detail.classList.toggle('sr-only', $('card-info').getAttribute('aria-expanded') !== 'true');
    $('card-info').hidden = !reason;
    $('card-info').setAttribute('aria-label', O.infoLabel('Ver detalle de la decisión', view.aria));
    allow.disabled = deny.disabled = Boolean(reason || cardFlight);
    const wait = $('card-wait'); // T7.3: «Espera tu respuesta» only while the human may still decide
    if (wait) wait.hidden = Boolean(reason);
    fitCard();
  }
  const cardInfo = $('card-info');
  if (cardInfo) cardInfo.addEventListener('click', () => {
    const open = cardInfo.getAttribute('aria-expanded') !== 'true';
    cardInfo.setAttribute('aria-expanded', open ? 'true' : 'false');
    $('card-reason').classList.toggle('sr-only', !open);
  });
  // The countdown texts (expiry label, 60 s ring) follow the clock without
  // touching the live regions.
  function syncCountdownTimer() {
    const now = Date.now();
    const card = current && current.card;
    const active = current && O && ((validCard(card) && now < Date.parse(card.expires_at)) ||
      (Array.isArray(current.notices) && current.notices.some(n => now < n.expiresAt)));
    if (active && countdownTimer === null) countdownTimer = setInterval(() => {
      if (validCard(current.card)) paintExpiry(current.card);
      syncInteraction(); // expiry releases blockers without changing card visibility
      paintBand(Array.isArray(current.notices) ? current.notices : []);
      paintCompactFlag(); // an expired card must stop saying «waiting»
      refreshHost(current);
      syncCountdownTimer();
    }, 5000);
    else if (!active && countdownTimer !== null) { clearInterval(countdownTimer); countdownTimer = null; }
  }

  async function decideCard(verb, event) {
    renderCard(); // Recheck expiry/phase even without a newer snapshot.
    const card = current && current.card;
    if (event.isTrusted !== true || !validCard(card) || cardFeedback(card) || cardFlight) return;
    const intent = { key: cardKey(card), revision: current.revision };
    cardFlight = intent;
    renderCard(); // Lock BOTH controls before invoking the host verb.
    try {
      const state = await window.desktop[verb](); // zero arguments; never a proposal id
      cardFlight = null;
      if (state && Number.isSafeInteger(state.revision) && state.revision > intent.revision &&
        state.revision > current.revision) {
        current = state;
        renderCard();
        renderNotices(state);
      } else if (validCard(current.card) && cardKey(current.card) === intent.key && current.card.state === 'pending')
        cardFailure = { key: intent.key, revision: current.revision };
    } catch {
      cardFlight = null;
      if (validCard(current.card) && cardKey(current.card) === intent.key)
        cardFailure = { key: intent.key, revision: current.revision };
    }
    renderCard(); // Never blindly revive controls or infer success.
  }
  const allowButton = $('allow');
  const denyButton = $('deny');
  if (allowButton) allowButton.addEventListener('click', event => { void decideCard('allow', event); });
  if (denyButton) denyButton.addEventListener('click', event => { void decideCard('deny', event); });
  // S10 (L22): the key hints on Coucou's buttons are real — Y allows, N denies (Coucou island/hooks.ts). Same gate as a click:
  // trusted event only, and decideCard still refuses unless the card is pending, visible and not in flight.
  document.addEventListener('keydown', event => {
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const t = event.target, tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
    const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
    if (key !== 'y' && key !== 'n') return;
    const permission = $('permission');
    if (!permission || permission.hidden || permission.inert) return;
    void decideCard(key === 'y' ? 'allow' : 'deny', event);
  });

  // F014 (#338): fold the waiting card down to the compact island WITHOUT
  // deciding it (upstream `foldApproval`, windows/src/island/island.ts:144-154
  // and the "Later — keep it waiting" button, views.ts:496-504). `close` is
  // the host's own collapse verb and never touches the decision lane: the host
  // keeps the card, the request keeps waiting (the compact sun flag carries
  // it), and reopening the island shows the same card again.
  // S10 (L22): Coucou's question card carries the same fold chevron; it is the same host collapse, nothing is answered.
  // The header exposes that same explicit fold action while the overview is empty, too.
  for (const foldButton of [$('header-fold'), $('card-fold'), $('question-fold')].filter(Boolean)) foldButton.addEventListener('click', event => {
    if (event.isTrusted !== true || !window.desktop || !current || current.state !== 'expanded') return;
    focusAfterPhase = 'island-toggle'; // folding moves focus with the view, like Escape
    window.desktop.close().then(snap => {
      if (snap) { current = snap; syncToggle(snap.state); }
    }, () => { /* host refused the collapse: the card stays exactly as it was */ });
  });

  // U1: the card's actionability depends on the visible view too.
  document.addEventListener('island:view', () => { if (current) renderCard(); });
  // L32: the recap card (island-recap.js) asks for its own 184px island; closing gives the overview height back
  document.addEventListener('abito:recap', event => {
    const show = !!(event.detail && event.detail.show);
    if (show !== recapShown) { recapShown = show; render(); }
  });
  // Sileo-style toast (question-toast.js) below the island: a trusted click opens the island on the question; the card answers.
  let toastShown = false;
  document.addEventListener('abito:question-toast', event => {
    const shown = !!(event.detail && event.detail.shown);
    if (shown !== toastShown) { toastShown = shown; render(); }
  });
  document.addEventListener('abito:question-open', openQuestion);
  function openQuestion() {
    // From the CHAT view the island is already expanded, so «expand» did nothing and the question stayed hidden behind the chat (the human
    // had to press ⌂). Leave the chat through the same closed verb the «ir a la alerta» shortcut uses, then make sure the island is open.
    const showQuestion = () => {
      noticeLane = null; delete capsule.dataset.noticeView;
      renderCard(); render();
      document.dispatchEvent(new CustomEvent('island:view', { detail: 'overview' }));
    };
    const leaveChat = capsule.dataset.view === 'chat' && invoke
      ? invoke('chat_action', { payload: { action: 'back' } }).then(() => {
        showQuestion();
      }, () => {})
      : Promise.resolve().then(showQuestion);
    leaveChat.then(() => {
      if (capsule.dataset.phase === 'expanded' && current?.state !== 'hidden') return;
      if (!window.desktop || typeof window.desktop.expand !== 'function') return;
      return window.desktop.expand().then(snap => { if (snap) { current = snap; syncToggle(snap.state); } }, () => {});
    });
  }
  // S2/S3 (02 compacta A, 03 alerta A): the compact pill's width follows what it shows; the layout module computes it from real data.
  document.addEventListener('abito:compact-view', event => {
    const v = event.detail || {};
    const next = Number.isFinite(v.width) && v.width >= COMPACT.w ? v.width : COMPACT.w;
    const badge = $('compact-badge'), act = $('compact-activity');
    if (act && act.textContent !== (v.activity || '')) act.textContent = v.activity || '';
    if (badge) { badge.hidden = !v.badge; badge.dataset.kind = v.badge || ''; }
    const reply = $('compact-reply'); if (reply) reply.hidden = !v.reply;
    capsule.dataset.compactAsk = v.reply ? 'true' : 'false';
    compactAsk = !!v.reply;
    compactW = next; render(); // always: the fitted pill follows the text, not only the reported width
  });
  // S3: «Responder» on the widened pill opens the island on the question (the same verb the toast used)
  const compactReply = $('compact-reply');
  if (compactReply) compactReply.addEventListener('click', event => {
    event.stopPropagation();
    if (event.isTrusted === true) document.dispatchEvent(new CustomEvent('abito:question-open', { detail: { id: 'compact' } }));
  });
  document.addEventListener('abito:question-size', event => {
    const h = Number(event.detail && event.detail.islandH);
    const next = Number.isFinite(h) && h >= QUESTION_H ? h : QUESTION_H;
    if (next !== questionH) { questionH = next; render(); }
  });
  document.addEventListener('abito:question', event => {
    const show = !!(event.detail && event.detail.show);
    if (show) finishedCycle?.cancel(); // never cover a pending question with finished content
    if (!show) questionH = QUESTION_H; // closing the question resets the island height regardless of the size event
    if (show !== questionShown) { questionShown = show; render(); }
    paintCompactFlag();
    if (event.detail && event.detail.reveal) {
      // #266: a genuinely new question reveals. With the toast the island stays as it is (the human opens it from the toast).
      const T = window.AbitoQuestionToast;
      if (T && T.revealByToast({ phase: capsule.dataset.phase })) edgeInteraction?.alert(); else revealIsland(true);
    }
  });

  // ---- Q1: keyboard control of the island itself -------------------------
  // The island never takes focus by itself (tauri.conf focus:false, no
  // set_focus on restore). Once the human has focused it (click), Tab
  // reaches #island-toggle: Enter/Space opens the overview and moves focus
  // to its primary control; in the overview it closes. Escape (chat.js)
  // steps out of the composer, then closes.
  const toggleButton = $('island-toggle');
  let focusAfterPhase = null;
  function syncToggle(state) {
    if (!toggleButton) return;
    const open = state === 'expanded';
    toggleButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggleButton.textContent = open ? 'Cerrar Koda' : 'Abrir Koda';
  }
  if (toggleButton) {
    toggleButton.addEventListener('click', () => {
      if (!window.desktop) return;
      const open = current && current.state === 'expanded';
      focusAfterPhase = open ? 'island-toggle' : 'open-chat';
      (open ? window.desktop.close() : window.desktop.expand()).then(snap => {
        if (snap) { current = snap; syncToggle(snap.state); }
      }, () => {});
    });
  }
  // Move focus only after the visible phase settled (a hidden control
  // cannot take focus) and only after a keyboard request.
  new MutationObserver(() => {
    const phase = capsule.dataset.phase;
    if (!focusAfterPhase || (phase !== 'expanded' && phase !== 'compact')) return;
    const target = $(focusAfterPhase);
    focusAfterPhase = null;
    if (target) target.focus();
  }).observe(capsule, { attributes: true, attributeFilter: ['data-phase'] });
  if (window.desktop) {
    try { window.desktop.onState(s => syncToggle(s && s.state)); } catch { /* facade optional */ }
  }
  document.addEventListener('keydown', event => {
    // Escape that collapses the island returns focus to the island control.
    if (event.key === 'Escape' && capsule.dataset.phase === 'expanded' &&
      document.activeElement !== $('chat-input')) focusAfterPhase = 'island-toggle';
  }, true);

  // Coucou home tab requests the EXISTING host-owned overview transition; it
  // does not resize locally or bypass the pending-question collapse barrier.
  const homeTab = $('home-tab');
  if (homeTab) homeTab.addEventListener('click', event => {
    if (!NV || !NV.trusted(event)) return;
    if (capsule.dataset.view === 'chat') {
      const back = $('chat-back');
      if (back) back.click();
      return;
    }
    noticeLane = null;
    delete capsule.dataset.noticeView;
    renderCard(); render();
    document.dispatchEvent(new CustomEvent('island:view', { detail: 'overview' }));
  });
  // Native X11/portal callbacks emit this closed action ID to the main window.
  // Never synthesize an approval click: jumping only changes presentation.
  const globalShortcutListen = window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen;
  if (globalShortcutListen && invoke) globalShortcutListen('global-shortcut', event => {
    const id = event && event.payload;
    const feedback = message => { const live = $('notice-live'); if (live) live.textContent = message; };
    if (id === 'openChat') {
      const button = $('open-chat'); if (button) button.click();
    } else if (id === 'goToAlert') {
      const pending = capsule.dataset.question === 'pending' || (current && validCard(current.card) && current.card.state === 'pending');
      if (!pending) { feedback('No hay permisos ni preguntas pendientes.'); return; }
      invoke('chat_action', { payload: { action: 'back' } }).then(() => {
        noticeLane = null; delete capsule.dataset.noticeView;
        renderCard(); render();
        document.dispatchEvent(new CustomEvent('island:view', { detail: 'overview' }));
      }, () => feedback('No se pudo mostrar la solicitud pendiente.'));
    } else if (id === 'jumpToTerminal') {
      capsule.dataset.shortcutTerminal = 'pending';
      // The focused session's key (see sessions-ticker.js) lets the host open THAT session's terminal; without a
      // well-formed key it is the plain closed verb. Nothing else ever travels.
      invoke('focus_host', { payload: focusedSessionKey ? { target: 'terminal', session: focusedSessionKey } : { target: 'terminal' } }).then(() => {
        capsule.dataset.shortcutTerminal = focusedSessionKey ? 'focused-session' : 'focused-class';
      }, error => {
        capsule.dataset.shortcutTerminal = 'unavailable';
        feedback(error && typeof error.message === 'string' ? error.message : 'No se pudo enfocar una terminal.');
      });
    }
  }).catch(() => {});
  // Filter the real model list only. The existing controller remains the sole
  // owner of refresh, readiness, selection and host calls; no sample accounts.
  const search = $('models-search'), modelList = $('models-list');
  function filterModels() {
    if (!search || !modelList) return;
    const needle = String(search.value || '').trim().toLocaleLowerCase();
    for (const row of modelList.querySelectorAll('li')) row.hidden = !!needle && !String(row.textContent || '').toLocaleLowerCase().includes(needle);
  }
  if (search && modelList) {
    search.addEventListener('input', filterModels);
    new MutationObserver(filterModels).observe(modelList, { childList: true });
  }

  // #347 idle clock: real interaction, queued turns and focused/drafted composer keep Abito awake.
  let characterTurnBusy = false;
  function characterBusy() {
    const field = $('chat-input');
    character.busy(characterTurnBusy || !!(field && (field.value || document.activeElement === field)));
  }
  for (const name of ['pointerdown', 'pointermove', 'keydown', 'input', 'focusin', 'focusout']) {
    document.addEventListener(name, () => { character.activity(); characterBusy(); });
  }
  for (const name of ['pointerup', 'pointercancel', 'blur']) window.addEventListener(name, characterBusy);
  const characterListen = window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen;
  let questionStreamSeen = false, chatStreamSeen = false;
  const characterQuestion = snap => { character.question(snap); };
  // #347 mini-bots: only in the overview; leaving it (or the page) releases every instance.
  let characterView = null;
  const minisEl = $('minibots');
  const minis = minisEl && window.AbitoMinis && typeof AbitoClay !== 'undefined'
    ? AbitoMinis.create({ container: minisEl, doc: document, makeClay: (svg, seed) => AbitoClay.create(svg, { seed, viewBox: '36 32 128 128', shadow: false }) }) : null;
  const syncMinis = () => {
    if (!minis) return;
    if (capsule.dataset.phase === 'expanded' && capsule.dataset.view === 'overview') minis.sync(characterView); else minis.clear();
  };
  // #439: at most ONE minis render per frame — the capsule observers used to
  // fire per frame during the spring and re-sync the minis mid-transition.
  let minisFrame = 0;
  const syncMinisSoon = () => {
    if (minisFrame) return;
    minisFrame = requestAnimationFrame(() => { minisFrame = 0; syncMinis(); });
  };
  new MutationObserver(syncMinisSoon).observe(capsule, { attributes: true, attributeFilter: ['data-phase', 'data-view'] });
  const characterChat = view => {
    characterView = view;
    syncMinisSoon();
    characterTurnBusy = !!(view && view.active_turn && Array.isArray(view.turns) &&
      view.turns.some(t => t.turn_id === view.active_turn && ['queued', 'thinking', 'streaming', 'waiting_approval'].includes(t.state)));
    characterBusy();
  };
  if (characterListen) {
    characterListen('question:state', event => { questionStreamSeen = true; characterQuestion(event && event.payload); }).catch(() => {});
    characterListen('chat:state', event => { chatStreamSeen = true; characterChat(event && event.payload); }).catch(() => {});
  }
  if (invoke) {
    invoke('question_action', { payload: { action: 'view' } }).then(snap => { if (!questionStreamSeen) characterQuestion(snap); }, () => {});
    invoke('chat_action', { payload: { action: 'view' } }).then(view => { if (!chatStreamSeen) characterChat(view); }, () => {});
  }
  window.addEventListener('pagehide', () => { character.destroy(); if (minis) minis.clear(); });
  // ---- boot ---------------------------------------------------------------
  if (typeof AbitoClay !== 'undefined') AbitoClay.onChange(() => character.motionChanged());
  character.activity();
  render();
  renderCard();
  requestAnimationFrame(() => reportEvidence(0));
})();
