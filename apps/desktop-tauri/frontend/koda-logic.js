'use strict';
/* HU-056: Koda's pure rules (no DOM). Inputs are what the app really does (the Dot's own pose, island phase/view, notices, engine health,
   a running agent, the chat composer); the output is one animation id of KodaCatalog. Human decisions (28-oct): calm idle is AWAKE
   (`respirar`, never the sleeping `reposo` row); yawn after 30 s without activity, asleep after 45 s. */
(function (root) {
  const KC = typeof require === 'function' && typeof module !== 'undefined' ? require('./koda-catalog.js') : root.KodaCatalog;
  const { CATALOG, SMALL } = KC;
  const YAWN_MS = 30000, SLEEP_MS = 45000;
  const POSE_TO_ANIM = { listen: 'escucha', think: 'piensa', speak: 'piensa', reject: 'triste', confirm: 'feliz', working: 'trabaja', searching: 'trabaja',
    approval: 'espera', question: 'espera', finished: 'termino', ratelimit: 'aburrido', dizzy: 'confundido' };
  const REACTION_TO_ANIM = { greeting: 'saludar', love: 'carinoso', yawn: 'bostezar', surprised: 'sorprendido', proud: 'orgulloso', wink: 'timido', happy: 'feliz', annoyed: 'enojado' };
  // Awake-rest variety (HU-056 + HU-070): short, low-priority beats; `respirar` is the base between them.
  const EXTRAS = [['parpadear', 650], ['tic-oreja', 650], ['cola', 1500], ['estirarse', 1700], ['lamerse', 2000], ['sentarse', 1600], ['parpadear', 650]];
  const MISCHIEF = [['jugueton', 2400], ['perseguir-cola', 2400]];
  const MISCHIEF_FROM_MS = 20000, MISCHIEF_TO_MS = 27000, MISCHIEF_EVERY_MS = 60000, OVILLO_MS = 4000, LONG_RUN_MS = 120000;
  const calm = pose => pose === 'idle' || pose === 'sleeping' || !pose;

  function frameAt(id, elapsedMs, reduced) {
    const a = CATALOG[id]; if (!a) return 0;
    const seq = a.sequence; if (reduced) return seq[0];
    const ticks = Math.floor(Math.max(0, elapsedMs) / 1000 * a.fps);
    return a.loop ? seq[ticks % seq.length] : seq[Math.min(ticks, seq.length - 1)];
  }
  const isDone = (id, elapsedMs) => { const a = CATALOG[id]; return !!a && !a.loop && Math.floor(elapsedMs / 1000 * a.fps) >= a.sequence.length; };
  // HU-070: caminar/correr slide Koda in from the left for a short, bounded distance (never more than `room` px, so never out of the island);
  // 0 with reduced motion, 0 for every other animation, 0 once settled.
  const MOVES = { caminar: { ms: 900, max: 12 }, correr: { ms: 800, max: 24 } };
  function moveOffset(id, elapsedMs, reduced, room) {
    const m = MOVES[id]; if (!m || reduced || !(room > 0)) return 0;
    const p = Math.min(1, Math.max(0, elapsedMs / m.ms));
    return Math.round(-(1 - p) * Math.min(room, m.max)) + 0;
  }
  // HU-070 review: the per-frame driver of moveOffset. Layout (`room()`) is measured once when a walk/run starts, and a CSS value is
  // returned only when it changes (null = nothing to write), so a calm Koda costs no layout read and no style write per frame.
  function createMover() {
    let cur = null, room = 0, last = '';
    return { update(id, elapsedMs, reduced, measureRoom) {
      if (id !== cur) { cur = id; room = MOVES[id] && !reduced ? Math.max(0, measureRoom()) : 0; }
      const x = MOVES[id] ? moveOffset(id, elapsedMs, reduced, room) : 0, css = x ? `translateX(${x}px)` : '';
      if (css === last) return null;
      last = css; return css;
    } };
  }
  // Integer scale only. The 24 px sheet exists for the seven Abito states; everything else uses the 32 px sheet.
  function layoutFor(id, pref, boxPx) {
    // human 29-oct: in the take-over cards Koda is BIG on the left: the largest integer scale of the 32 px cell that fits the column box (x2..x4)
    if (pref === 'nusa-big') return { cell: 32, k: Math.max(2, Math.min(4, Math.floor(boxPx / 32))) };
    if (pref === 'nusa-chat') return { cell: 32, k: Math.max(2, Math.min(4, Math.floor(boxPx / 32))) }; // human 29-oct: BIG Koda in the empty left column of the chat
    if (pref === 'nusa') return { cell: 32, k: 2 }; // HU-057: the Nusa notch forces 32 px x2 = 64 px
    if (pref === 'small') return { cell: SMALL.includes(id) ? 24 : 32, k: 1 };
    return { cell: 32, k: boxPx >= 56 ? 2 : 1 };
  }

  function createBrain({ now, rand = Math.random }) {
    const S = { idleSince: now(), prev: null, trans: null, cele: null, fright: 0, nextExtra: now() + 4500, nextMischief: 0, yawned: false, asleep: false,
      runSince: null, runErr: false, reduced: false };
    const idleMs = () => now() - S.idleSince;
    // transient beat; `next` chains one more beat when it ends (never under reduced motion: callers skip the chain)
    const beat = (id, ms, low, next) => { S.trans = { id, until: now() + ms, low: !!low, next: next || null }; };
    const celebrate = (id, ms) => { S.cele = { id, until: now() + ms }; };
    function poke() {
      if (S.asleep) { S.asleep = false; beat('aparecer', 900); }
      S.idleSince = now(); S.yawned = false; S.nextExtra = now() + 4500 + rand() * 5500;
    }
    // HU-070 S5: a click on Koda kneads (a calm, low-priority beat); waking a sleeper is just the wake-up beat.
    function click() {
      if (S.reduced) return;
      const wasAsleep = S.asleep; poke();
      if (!wasAsleep) beat('amasar', 2000, true);
    }
    function step(i) {
      const t = now(), P = S.prev, chatTurn = i.pose === 'think' || i.pose === 'speak', bad = !!i.engineBad || i.pose === 'error', reduced = !!i.reduced;
      S.reduced = reduced;
      const done = !!i.progress && i.progress.total > 0 && i.progress.done === i.progress.total;
      const busy = !calm(i.pose) || i.running || i.noticeView === 'notices' || bad || i.composerFocused || !!i.reaction || !!i.pointerOver;
      if (i.running && !(P && P.running)) { S.runSince = t; S.runErr = false; }
      if (S.runSince != null && (bad || i.noticeError)) S.runErr = true; // a failure at any point of the run, also the very step it stops
      if (P) {
        if (P.phase !== i.phase || P.hidden !== i.hidden || P.view !== i.view || busy) poke();
        if (P.phase === 'compact' && i.phase === 'open' && !i.hidden) {
          if (reduced) beat('saludar', 1400); else beat('correr', 800, false, { id: 'saludar', ms: 1400 });   // HU-070 S9: run in, then wave
        }
        if (P.phase === 'open' && i.phase === 'open' && P.view !== i.view && !reduced) beat('caminar', 900);       // HU-070 S9: a short walk on a tab change
        if (P.phase === 'open' && i.phase === 'compact' && !i.hidden && !reduced) beat('desaparecer', 700, false, { id: 'aparecer', ms: 900 }); // HU-070 S10
        if (!P.hidden && i.hidden) beat('esconderse', 1100);
        if (P.hidden && !i.hidden) beat('asomarse', 2200);
        if (P.bad && !bad) beat('feliz', 2600);
        if (!P.bad && bad && !reduced) S.fright = t + 1200;                                                       // HU-070 S4: startle, then error
        if (P.chatTurn && !chatTurn && i.view === 'chat' && i.pose !== 'error') beat('feliz', 2600);
        if (i.pose === 'finished' && P.pose !== 'finished') beat('termino', 3400);
        if (!reduced) {
          if (P.running && !i.running && S.runSince != null && t - S.runSince >= LONG_RUN_MS && !S.runErr) celebrate('muy-feliz', 3000); // S1
          if (done && P.progress && i.progress && P.progress.id === i.progress.id && P.progress.done < P.progress.total) celebrate('saltar', 1500); // S2: that session's own transition
          if (P.notice !== 'notices' && i.noticeView === 'notices' && i.phase === 'open' && !i.noticeAttention && !i.noticeError) celebrate('curioso', 1200); // S3
        }
      } else if (busy) poke();
      S.prev = { phase: i.phase, hidden: i.hidden, view: i.view, pose: i.pose, bad, chatTurn, running: !!i.running, done, notice: i.noticeView, progress: i.progress ? { id: i.progress.id, done: i.progress.done, total: i.progress.total } : null };
      return choose(i, t, bad, reduced);
    }
    function choose(i, t, bad, reduced) {
      S.asleepNow = false;
      // 1 · states that need the human or report a failure always win (HU-070 criterion 2)
      if (bad) return S.fright > t ? 'asustado' : 'error';
      if (i.pose === 'approval' || i.pose === 'question') return 'espera';
      if (i.noticeView === 'notices' && i.noticeError) return 'error';
      if (i.noticeView === 'notices' && i.noticeAttention) return 'espera';
      // 2 · a celebration may play over a calm «terminó» notice or a running state, then the state resumes
      if (S.cele) { if (t < S.cele.until) return S.cele.id; S.cele = null; }
      if (i.noticeView === 'notices') return 'termino';
      if (i.pose === 'confirm') return 'feliz';   // HU-075: «Recibida» — an explicit confirm outranks a decorative beat/emote (the greeting wave)
      if (S.trans && t >= S.trans.until) { const nx = S.trans.next; S.trans = nx ? { id: nx.id, until: t + nx.ms, low: !!nx.low, next: null } : null; }
      if (S.trans) { if (!(S.trans.low && (!calm(i.pose) || i.running))) return S.trans.id; S.trans = null; }
      if (i.reaction && REACTION_TO_ANIM[i.reaction]) return REACTION_TO_ANIM[i.reaction];
      if (i.pose === 'finished') return 'termino';
      if (i.running && calm(i.pose) && !i.composerFocused) return 'trabaja';
      if (!calm(i.pose)) return POSE_TO_ANIM[i.pose] || 'respirar';
      if (i.composerFocused) return 'escucha';
      // 3 · Koda's own life: only in calm rest, never with reduced motion
      if (i.pointerOver && !reduced) return 'ronronear';
      const idle = idleMs();
      if (idle >= SLEEP_MS) { S.asleep = true; return 'dormir'; }
      if (idle >= SLEEP_MS - OVILLO_MS && !reduced) return 'ovillo';
      if (idle >= YAWN_MS) {
        if (!S.yawned) { S.yawned = true; beat('bostezar', 1300); return 'bostezar'; }
        return 'somnoliento';
      }
      if (reduced) return 'respirar';
      if (idle >= MISCHIEF_FROM_MS && idle < MISCHIEF_TO_MS && t >= S.nextMischief) {
        const [id, ms] = MISCHIEF[Math.floor(rand() * MISCHIEF.length) % MISCHIEF.length];
        S.nextMischief = t + MISCHIEF_EVERY_MS; beat(id, ms, true); return id;
      }
      if (t >= S.nextExtra) {
        const [id, ms] = EXTRAS[Math.floor(rand() * EXTRAS.length) % EXTRAS.length];
        S.nextExtra = t + 4500 + rand() * 5500; beat(id, ms, true); return id;
      }
      return 'respirar';
    }
    return { step, poke, click, get idleMs() { return idleMs(); } };
  }
  const api = { YAWN_MS, SLEEP_MS, createBrain, frameAt, isDone, layoutFor, moveOffset, createMover, POSE_TO_ANIM, REACTION_TO_ANIM };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.KodaLogic = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
