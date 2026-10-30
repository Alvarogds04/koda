/* Abito clay engine — R7. The seven R6 poses and public names stay intact.
   Additional state/timing mechanics informed by Coucou windows/src/mochi/engine.ts,
   Copyright 2026 Louis Raillé, MIT. No Mochi character paths, palette, assets,
   sounds or appendages: geometry and lid language remain Abito's own. */
const AbitoClay = (() => {
  'use strict';
  const REVISION = 'R7';
  const TAU = Math.PI * 2, K = 5, DIM = 2 * K + 1, N = 144;
  const CX = 100, CY = 102, R0 = 54;
  const NS = 'http://www.w3.org/2000/svg';
  const MQ = matchMedia('(prefers-reduced-motion: reduce)');
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const approach = (c, t, rate, dt) => c + (t - c) * (1 - Math.exp(-rate * dt));
  const ci = (k, sin) => 2 * k - 1 + (sin ? 1 : 0);
  function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  const coeffs = spec => { const v = new Float64Array(DIM); for (const [k, a, b] of spec) { v[ci(k, 0)] = a; v[ci(k, 1)] = b; } return v; };

  // eye: sx/sy size, uL/uR upper lid, tilt lid slope, uc lid curvature, l/bow lower lid, asym left/right offset
  const STATES = {
    idle:    { name: 'Reposo', caption: 'Redondo y tranquilo, parpadea con calma.', v: coeffs([[1, 0, .03], [2, .035, 0], [4, -.01, 0]]),
               eye: { sx: 1, sy: 1, uL: .04, uR: .04, tilt: 0, uc: 0, l: 0, bow: 0, asym: 0 }, lift: 0, lean: 0, knead: .04 },
    listen:  { name: 'Escucha', caption: 'Atento: abre un poco más los ojos y se inclina hacia vos.', v: coeffs([[1, 0, .02], [2, .025, .045], [3, 0, -.012]]),
               eye: { sx: 1.1, sy: 1.12, uL: 0, uR: 0, tilt: 0, uc: 0, l: 0, bow: 0, asym: 0 }, lift: -1, lean: 3.2, knead: .034 },
    think:   { name: 'Piensa', caption: 'Un poco más alto, mira hacia arriba y un ojo se entrecierra.', v: coeffs([[1, 0, -.015], [2, -.085, -.03], [3, .012, 0]]),
               eye: { sx: 1.02, sy: 1.02, uL: .26, uR: .03, tilt: .08, uc: .1, l: .05, bow: .2, asym: .08 }, lift: -3, lean: 0, knead: .036 },
    speak:   { name: 'Habla', caption: 'Más ancho, late al ritmo de las sílabas (simulación, sin audio).', v: coeffs([[1, 0, .035], [2, .095, 0], [4, -.012, 0]]),
               eye: { sx: 1.08, sy: 1.04, uL: 0, uR: 0, tilt: 0, uc: 0, l: .06, bow: .3, asym: 0 }, lift: 0, lean: 0, knead: .036 },
    reject:  { name: 'Rechaza', caption: 'Se recoge un poco, entrecierra los ojos y niega con suavidad.', v: coeffs([[1, 0, .065], [2, .03, .012], [4, -.02, 0]]),
               eye: { sx: 1.08, sy: .95, uL: .4, uR: .4, tilt: .22, uc: .25, l: .16, bow: .35, asym: 0 }, lift: 4, lean: 0, knead: .03 },
    confirm: { name: 'Confirma', caption: 'Se eleva un poco, sonríe con los ojos y asiente.', v: coeffs([[1, 0, -.025], [2, -.03, 0], [3, 0, -.01]]),
               eye: { sx: 1.45, sy: .72, uL: 0, uR: 0, tilt: 0, uc: 0, l: .58, bow: .45, asym: 0 }, lift: -6, lean: 0, knead: .036 },
    error:   { name: 'Error', caption: 'Confundido: ladea la cabeza, un ojo más alto que el otro y parpadea dos veces.', v: coeffs([[1, 0, .05], [2, .015, -.05], [3, -.012, 0]]),
               eye: { sx: .94, sy: .9, uL: 0, uR: .2, tilt: -.1, uc: .12, l: .04, bow: .2, asym: -.14 }, lift: 2, lean: -2.4, knead: .032 },
  };
  // Append only: callers consuming the seven original names/order keep working.
  const ORDER = ['idle', 'listen', 'think', 'speak', 'reject', 'confirm', 'error', 'working', 'searching', 'approval', 'question', 'finished', 'ratelimit', 'sleeping', 'dizzy'];
  Object.assign(STATES, {
    working: { name: 'Trabaja', caption: 'Amasa suavemente mientras trabaja.', v: coeffs([[1, 0, .015], [2, .055, 0], [3, .009, -.008]]),
      eye: { ...STATES.idle.eye, sy: 1.04, l: .04 }, lift: -1, lean: 0, knead: .047 },
    searching: { name: 'Busca', caption: 'Recorre de lado a lado con la mirada.', v: coeffs([[1, 0, .02], [2, -.035, .025]]),
      eye: { ...STATES.idle.eye, sx: 1.04, sy: 1.06, uL: .08, uR: .08 }, lift: -2, lean: 1, knead: .032 },
    approval: { name: 'Espera tu decisión', caption: 'Atento a tu decisión, sin aprobar nada.', v: coeffs([[1, 0, -.01], [2, -.025, .02]]),
      eye: { ...STATES.idle.eye, sx: 1.12, sy: 1.14, uL: 0, uR: 0 }, lift: -2.5, lean: 1.4, knead: .03 },
    question: { name: 'Pregunta', caption: 'Se inclina con curiosidad mientras espera tu respuesta.', v: coeffs([[1, 0, .025], [2, .012, -.035]]),
      eye: { ...STATES.idle.eye, uL: .03, uR: .18, asym: .065 }, lift: -1, lean: -3, knead: .03 },
    finished: { name: 'Turno terminado', caption: 'El turno terminó; no confirma éxito.', v: coeffs([[1, 0, .03], [2, .025, 0], [4, -.009, 0]]),
      eye: { ...STATES.idle.eye, uL: .14, uR: .14 }, lift: 1.5, lean: 0, knead: .026 },
    ratelimit: { name: 'En espera por límite', caption: 'Pose de espera; sólo cuando haya un productor de límite.', v: coeffs([[1, 0, .055], [2, .065, .018]]),
      eye: { ...STATES.idle.eye, sy: .94, uL: .38, uR: .38 }, lift: 3, lean: -1, knead: .024 },
    sleeping: { name: 'Duerme', caption: 'Descansa tras la inactividad; despierta con actividad real.', v: coeffs([[1, 0, .07], [2, .065, 0]]),
      eye: { ...STATES.idle.eye, sy: .92, uL: .94, uR: .94 }, lift: 4, lean: 0, knead: .012 },
    dizzy: { name: 'Mareado', caption: 'Se balancea después de un arrastre rápido de ida y vuelta.', v: coeffs([[1, 0, .045], [2, -.015, .035]]),
      eye: { ...STATES.idle.eye, uL: .18, uR: .36, asym: .12, tilt: .08 }, lift: 1, lean: 0, knead: .036 },
  });

  /* Emote overlays (#347 F058): finite, cancellable presentation layers over the current
     state. Envelope timing informed by Coucou mochi/engine.ts reaction lifetimes; every
     offset below is Abito's own eye/lid/body language (no heart/star eyes, no appendages).
     rise/fall are fractions of dur; fx(e) returns additive offsets for envelope e in 0..1. */
  const EMOTES = {
    love:      { dur: 1.8, rise: .09, fall: .17, motes: 4, fx: e => ({ lift: -2.5 * e, lean: 0, eye: { uL: -.04 * e, uR: -.04 * e, l: .1 * e } }) },
    surprised: { dur: 1.0, rise: .14, fall: .38, motes: 0, fx: e => ({ lift: -4 * e, lean: 0, eye: { sx: .22 * e, sy: .3 * e, uL: -.04 * e, uR: -.04 * e } }) },
    proud:     { dur: 1.3, rise: .17, fall: .22, motes: 3, fx: e => ({ lift: -2 * e, lean: 1.5 * e, eye: { uL: -.04 * e, uR: -.04 * e, l: .06 * e } }) },
    wink:      { dur: .8, rise: .2, fall: .3, motes: 0, fx: e => ({ lift: 0, lean: 1.6 * e, eye: { winkR: .95 * e } }) },
    yawn:      { dur: 1.0, rise: .5, fall: .5, motes: 0, fx: e => ({ lift: -3 * e, lean: 0, eye: { uL: .55 * e, uR: .55 * e, sy: .08 * e } }) },
    happy:     { dur: 1.0, rise: .2, fall: .4, motes: 0, fx: e => ({ lift: -1.5 * e, lean: 0, eye: { l: .26 * e, sy: -.12 * e, sx: .1 * e } }) },
    annoyed:   { dur: .8, rise: .25, fall: .3, motes: 0, fx: e => ({ lift: 0, lean: -2 * e, eye: { uL: .3 * e, uR: .3 * e, tilt: .15 * e } }) },
  };
  const EMOTE_NAMES = Object.keys(EMOTES);
  /* Greeting (#347 F063): a 2 s body-only timeline (rise, two sways, two lid blinks), staged as in
     Coucou mochi/engine.ts greeting timings (lift, blinks at ~0.55 s / 1.5 s, settle by 2 s). Not an
     emote: it is not in EMOTES and never carries particles, hands or layout changes. */
  const bump = (p, c, w) => Math.max(0, 1 - Math.abs(p - c) / w);
  const GREETING = { dur: 2.0, rise: .11, fall: .15, motes: 0, fx: (e, p) => {
    const blink = Math.max(bump(p, .275, .04), bump(p, .75, .04));
    return { lift: -3.5 * e, lean: 2.2 * e * Math.sin(Math.PI * 4 * p), eye: { uL: blink, uR: blink, l: .06 * e } };
  } };
  const emoteDef = name => name === 'greeting' ? GREETING : EMOTES[name];
  const smooth = x => x * x * (3 - 2 * x);
  function envelope(em, p) {
    if (p <= 0 || p >= 1) return 0;
    if (p < em.rise) return smooth(p / em.rise);
    if (p > 1 - em.fall) return smooth((1 - p) / em.fall);
    return 1;
  }

  function superellipse(rx, ry, n = 4.2) {
    const s = Math.min(1, (8 * Math.pow(2, -1 / n) - 4) / 3), l = rx * s, m = ry * s, f = v => v.toFixed(2);
    const u = [[rx, 0], [rx, m], [l, ry], [0, ry], [-l, ry], [-rx, m], [-rx, 0], [-rx, -m], [-l, -ry], [0, -ry], [l, -ry], [rx, -m], [rx, 0]];
    let d = `M${f(u[0][0])} ${f(u[0][1])}`; for (let i = 1; i < 13; i += 3) d += `C${f(u[i][0])} ${f(u[i][1])} ${f(u[i + 1][0])} ${f(u[i + 1][1])} ${f(u[i + 2][0])} ${f(u[i + 2][1])}`; return d + 'Z';
  }
  function lidRegion(e) {
    const W = e.rx + 2, H = 2 * e.ry + 2, top = -e.ry - 1, bot = e.ry + 1, f = v => v.toFixed(2), pts = [];
    const yu = x => top + e.upper * H + e.slope * x + e.uc * e.upper * H * (x / W) ** 2;
    const yl = x => bot - e.lower * H * (1 - e.bow * (x / W) ** 2);
    for (let k = 0; k <= 8; k++) { const x = -W + 2 * W * k / 8; pts.push([x, yu(x)]); }
    for (let k = 8; k >= 0; k--) { const x = -W + 2 * W * k / 8; pts.push([x, Math.max(yl(x), yu(x) + .01)]); }
    return 'M' + pts.map(p => `${f(p[0])} ${f(p[1])}`).join('L') + 'Z';
  }
  function pathFrom(p) {
    const n = p.length, f = v => v.toFixed(2);
    let d = `M${f(p[0][0])} ${f(p[0][1])}`;
    for (let i = 0; i < n; i++) { const p0 = p[(i - 1 + n) % n], p1 = p[i], p2 = p[(i + 1) % n], p3 = p[(i + 2) % n]; d += `C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`; }
    return d + 'Z';
  }
  const TH = Array.from({ length: N }, (_, i) => i / N * TAU);
  const CS = TH.map(th => Array.from({ length: K + 1 }, (_, k) => [Math.cos(k * th), Math.sin(k * th)]));
  let uid = 0;

  function create(svg, opts = {}) {
    const id = 'clay' + (++uid);
    const rng = mulberry32(opts.seed || 505);
    const rand = (a, b) => a + rng() * (b - a);
    svg.setAttribute('viewBox', opts.viewBox || '0 0 200 200');
    svg.replaceChildren();
    const doc = svg.ownerDocument;
    const mk = (tag, attrs, parent) => { const e = doc.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); (parent || svg).appendChild(e); return e; };
    const defs = mk('defs', {});
    const skin = mk('radialGradient', { id: id + 'skin', cx: '.36', cy: '.28', r: '.95' }, defs);
    [['0', '#acdd96'], ['.55', '#8fcb78'], ['1', '#78b562']].forEach(([o, c]) => mk('stop', { offset: o, 'stop-color': c }, skin));
    const shade = mk('radialGradient', { id: id + 'shade' }, defs);
    mk('stop', { offset: '0', 'stop-color': '#2d4a22', 'stop-opacity': opts.shadow === false ? '0' : '.2' }, shade);
    mk('stop', { offset: '1', 'stop-color': '#2d4a22', 'stop-opacity': '0' }, shade);
    const shadowEl = mk('ellipse', { cx: 100, cy: 176, rx: 52, ry: 7, fill: `url(#${id}shade)` });
    const bodyEl = mk('path', { 'data-abito-body': '', fill: `url(#${id}skin)` });
    const eyeEls = ['L', 'R'].map(s => {
      const g = mk('g', {});
      const cp = mk('clipPath', { id: id + 'lid' + s }, g);
      const lid = mk('path', {}, cp);
      const e = mk('path', { fill: '#0f1d0b', 'clip-path': `url(#${id}lid${s})` }, g);
      return { g, e, lid };
    });
    const knead = Array.from({ length: 2 * (DIM - 3) }, (_, i) => ({ j: 3 + (i % (DIM - 3)), f: rand(.11, .3), p: rand(0, TAU) }));
    const start = STATES[opts.state] ? opts.state : 'idle';
    const S = {
      t: 0, state: start, from: start, x: Float64Array.from(STATES[start].v), morph: 1, knead: STATES[start].knead, ghost: null,
      eye: { ...STATES[start].eye }, lift: STATES[start].lift, lean: STATES[start].lean, shakeX: 0, nodY: 0, tiltB: 0,
      reaction: null, env: 0, envT: 0, nextSyl: 0, voice: 0, voiceT: 0, nextVoice: 0,
      gaze: { x: 0, y: 0 }, gazeT: { x: 0, y: 0 }, nextGaze: 1, blink: null, nextBlink: 1.6, gestureT0: 0,
    };
    let lastGeo = null, motes = null;
    function ensureMotes() {
      if (motes) return motes;
      const g = mk('g', { 'data-abito-motes': '', 'aria-hidden': 'true' });
      motes = Array.from({ length: 4 }, () => mk('circle', { r: 2.4, fill: '#acdd96', opacity: 0, cx: 100, cy: 100 }, g));
      return motes;
    }
    const reactionP = () => S.reaction ? (S.t - S.reaction.t0) / emoteDef(S.reaction.name).dur : 0;
    // A cancelled emote (state change, drag, pause...) fades its offsets out over FADE_S instead of
    // vanishing in one frame: lift/lean/eye offsets of up to ~4 px would otherwise pop. A reaction
    // that ran to its end has envelope 0 already and needs no ghost.
    const FADE_S = .25, fxOf = (name, p) => { const em = emoteDef(name); return em.fx(envelope(em, p), p); };
    const scaleFx = (fx, w) => ({ lift: fx.lift * w, lean: fx.lean * w, eye: Object.fromEntries(Object.entries(fx.eye).map(([k, v]) => [k, v * w])) });
    const addFx = (a, b) => { const eye = { ...a.eye }; for (const k in b.eye) eye[k] = (eye[k] || 0) + b.eye[k]; return { lift: a.lift + b.lift, lean: a.lean + b.lean, eye }; };
    function cancelReaction() { if (!S.reaction) return false; const p = reactionP(); if (p < 1) S.ghost = { name: S.reaction.name, p, w: 1 }; S.reaction = null; if (motes) motes.forEach(m => m.setAttribute('opacity', 0)); return true; }

    function tick(dt) {
      S.t += dt;
      const st = STATES[S.state], t = S.t, g = t - S.gestureT0;
      let shake = 0, nod = 0, tiltB = 0;
      if (S.state === 'reject') { const c = g % 2.6; if (c < 1.1) shake = 3.6 * Math.sin(TAU * 1.8 * c) * Math.sin(Math.PI * c / 1.1); }
      if (S.state === 'confirm') { const c = g % 1.9; if (c < .7) nod = 3.2 * Math.sin(Math.PI * c / .7) ** 2; }
      if (S.state === 'listen') nod = .9 * S.voice * Math.sin(TAU * .9 * t) ** 2;          // small attentive nods with the voice
      if (S.state === 'error') { tiltB = .014 * Math.sin(TAU * .32 * g); shake = .9 * Math.sin(TAU * .32 * g + 1); }  // slow puzzled sway
      if (S.state === 'working') nod = -.9 * Math.sin(t * 4.4);
      if (S.state === 'approval') nod = -.8 * Math.abs(Math.sin(t * 5.2));
      if (S.state === 'question') tiltB = -.014;
      if (S.state === 'finished' && g < 1.8) nod = 1.2 * Math.sin(Math.PI * g / 1.8);
      if (S.state === 'sleeping') nod = .65 * Math.sin(t * 1.8);
      if (S.state === 'dizzy') { shake = 2.4 * Math.sin(g * 9) * Math.exp(-g / 3.3); tiltB = .025 * Math.sin(g * 7); }
      if (S.reaction && reactionP() >= 1) cancelReaction();
      if (S.ghost) { S.ghost.w -= dt / FADE_S; if (S.ghost.w <= 0) S.ghost = null; }
      S.shakeX = approach(S.shakeX, shake, 14, dt); S.nodY = approach(S.nodY, nod, 14, dt); S.tiltB = approach(S.tiltB, tiltB, 6, dt);
      if (S.state === 'speak') { if (t >= S.nextSyl) { S.envT = rng() < .16 ? 0 : rand(.35, 1); S.nextSyl = t + rand(.12, .22); } } else S.envT = 0;
      S.env = approach(S.env, S.envT, S.state === 'speak' ? 14 : 6, dt); // syllables stay snappy; closing the mouth after speech eases off
      if (S.state === 'listen') { if (t >= S.nextVoice) { S.voiceT = rng() < .25 ? .1 : rand(.4, 1); S.nextVoice = t + rand(.25, .55); } } else S.voiceT = 0;
      S.voice = approach(S.voice, S.voiceT, 5, dt);
      for (let j = 1; j < DIM; j++) S.x[j] = approach(S.x[j], st.v[j], 1.7, dt);
      S.morph = approach(S.morph, 1, 1.7, dt);
      S.knead = approach(S.knead, st.knead, 1.7, dt); // same rate as the pose blend: no pop on a state change
      S.lift = approach(S.lift, st.lift, 2.2, dt); S.lean = approach(S.lean, st.lean, 2.2, dt);
      for (const k in st.eye) S.eye[k] = approach(S.eye[k], st.eye[k], 3.2, dt);
      if (t >= S.nextGaze) {
        const s = S.state;
        if (s === 'think') { S.gazeT = { x: rand(.45, .95), y: rand(-1, -.7) }; S.nextGaze = t + rand(1.4, 2.8); }
        else if (s === 'listen') { S.gazeT = { x: rand(.05, .35), y: rand(-.2, .05) }; S.nextGaze = t + rand(1.2, 2.4); }
        else if (s === 'speak') { S.gazeT = { x: rand(-.5, .5), y: rand(-.25, .2) }; S.nextGaze = t + rand(.6, 1.3); }
        else if (s === 'reject') { S.gazeT = { x: rng() < .5 ? -.8 : .8, y: rand(.1, .35) }; S.nextGaze = t + rand(1.2, 2.2); }
        else if (s === 'confirm') { S.gazeT = { x: rand(-.2, .2), y: rand(-.2, 0) }; S.nextGaze = t + rand(1.5, 2.5); }
        else if (s === 'error') { S.gazeT = { x: rand(-.9, -.3), y: rand(-.1, .45) }; S.nextGaze = t + rand(1.6, 3); }
        else { S.gazeT = rng() < .3 ? { x: 0, y: 0 } : { x: rand(-1, 1), y: rand(-.5, .45) }; S.nextGaze = t + rand(1.2, 3); }
      }
      if (S.state === 'searching') S.gazeT = { x: Math.sin(t * 2.6) * .8, y: -.06 };
      if (S.state === 'sleeping') S.gazeT = { x: 0, y: .1 };
      if (S.state === 'dizzy') S.gazeT = { x: -.35 * Math.sin(t * 9), y: .15 };
      S.gaze.x = approach(S.gaze.x, S.gazeT.x - .25 * S.shakeX / 3.6, 9, dt); S.gaze.y = approach(S.gaze.y, S.gazeT.y, 9, dt);
      if (!S.blink && t >= S.nextBlink && S.eye.l < .35) S.blink = { t0: t, dur: S.state === 'think' ? .24 : .16 };
      if (S.blink && t - S.blink.t0 > S.blink.dur + .04) {
        S.blink = null;
        const dbl = S.state === 'error' ? .6 : .14;
        S.nextBlink = rng() < dbl ? t + .17 : t + rand(2.4, 5.2) * (S.state === 'think' ? 1.4 : 1);
      }
    }
    function compose() {
      const st = STATES[S.state], t = S.t, c = Float64Array.from(S.x);
      for (const n of knead) c[n.j] += S.knead * .55 * Math.sin(TAU * n.f * t + n.p) / Math.sqrt(Math.ceil(n.j / 2));
      c[ci(2, 0)] += .06 * S.env + .012 * S.nodY + .015 * S.voice;
      c[ci(1, 1)] += .035 * S.env;
      c[ci(2, 1)] += .006 * S.shakeX + S.tiltB;
      let area = 0; const r = new Float64Array(N);
      for (let i = 0; i < N; i++) { let v = 1; for (let k = 1; k <= K; k++) v += c[ci(k, 0)] * CS[i][k][0] + c[ci(k, 1)] * CS[i][k][1]; r[i] = clamp(v, .7, 1.35); area += r[i] * r[i]; }
      area *= .5 * TAU / N;
      const scale = R0 * Math.sqrt(Math.PI / area) * (1 + .012 * Math.sin(TAU * t / 4.2));
      const rp = S.reaction ? reactionP() : 0, rem = S.reaction && emoteDef(S.reaction.name);
      let rf = rem ? rem.fx(envelope(rem, rp), rp) : null;
      if (S.ghost) { const gf = scaleFx(fxOf(S.ghost.name, S.ghost.p), smooth(S.ghost.w)); rf = rf ? addFx(rf, gf) : gf; }
      const ox = CX + S.shakeX + S.lean + (rf ? rf.lean : 0), oy = CY + S.lift + S.nodY + (rf ? rf.lift : 0);
      const pts = new Array(N);
      for (let i = 0; i < N; i++) pts[i] = [ox + scale * r[i] * CS[i][1][0], oy + scale * r[i] * CS[i][1][1]];
      const E = { ...S.eye }, wink = rf && rf.eye.winkR || 0;
      if (rf) for (const k in rf.eye) if (k !== 'winkR') E[k] = k === 'sx' || k === 'sy' ? E[k] * (1 + rf.eye[k]) : E[k] + rf.eye[k];
      const fx = ox + S.gaze.x * 3.2 + S.shakeX * .4 + S.lean * .5, fy = oy - 8 + S.gaze.y * 2.4 + S.nodY * .6;
      let closed = 0; if (S.blink) { const p = (t - S.blink.t0) / S.blink.dur; if (p > 0 && p < 1) closed = Math.sin(p * Math.PI); }
      const talk = S.env;
      const eyes = [-1, 1].map(side => ({
        cx: fx + side * 16.5 + S.gaze.x * 2.2, cy: fy + side * E.asym * -6,
        rx: 6 * E.sx * (1 + .05 * talk), ry: 14.2 * E.sy * (side < 0 ? 1 - E.asym : 1 + E.asym * .4) * (1 + .1 * talk), uc: E.uc,
        rot: side * -3, upper: clamp(Math.max(side < 0 ? E.uL : E.uR, closed * .98, side > 0 ? wink : 0), 0, 1), slope: side * E.tilt,
        lower: clamp(E.l + .1 * talk, 0, .9), bow: E.bow,
      }));
      const mt = [];
      if (rem && rem.motes) for (let i = 0; i < rem.motes; i++) {
        // staggered round motes rising off the body; positions are deterministic in (state, i, time)
        const life = .9, born = i * .18, a = S.t - S.reaction.t0 - born;
        if (a <= 0 || a >= life) { mt.push(null); continue; }
        const q = a / life, side = i % 2 ? 1 : -1;
        mt.push({ x: ox + side * (14 + 5 * i) + 4 * Math.sin(q * 5 + i), y: oy - 30 - 22 * q, o: Math.sin(Math.PI * q) * .85 });
      }
      return { pts, eyes, motes: mt };
    }
    function render() {
      const g = compose(); lastGeo = g;
      if (motes || g.motes.length) { ensureMotes().forEach((m, i) => { const p = g.motes[i]; if (p) { m.setAttribute('cx', p.x.toFixed(2)); m.setAttribute('cy', p.y.toFixed(2)); m.setAttribute('opacity', p.o.toFixed(2)); } else m.setAttribute('opacity', 0); }); }
      bodyEl.setAttribute('d', pathFrom(g.pts));
      g.eyes.forEach((e, i) => {
        const el = eyeEls[i];
        el.g.setAttribute('transform', `translate(${e.cx.toFixed(2)} ${e.cy.toFixed(2)}) rotate(${e.rot.toFixed(2)})`);
        el.e.setAttribute('d', superellipse(e.rx, e.ry)); el.lid.setAttribute('d', lidRegion(e));
      });
      let minX = 1e9, maxX = -1e9, maxY = -1e9;
      for (const [x, y] of g.pts) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
      shadowEl.setAttribute('rx', ((maxX - minX) * .44).toFixed(2)); shadowEl.setAttribute('cy', Math.min(192, maxY + 8).toFixed(2));
      shadowEl.setAttribute('opacity', clamp(1 + S.lift / 14, .5, 1).toFixed(2));
    }
    function staticPose(state) {
      if (state && STATES[state]) S.state = state;
      const st = STATES[S.state];
      S.x = Float64Array.from(st.v); S.eye = { ...st.eye }; S.lift = st.lift; S.lean = st.lean; S.morph = 1; S.knead = st.knead; S.ghost = null;
      S.env = S.state === 'speak' ? .5 : 0; S.voice = S.state === 'listen' ? .5 : 0; S.shakeX = 0; S.nodY = 0; S.tiltB = S.state === 'error' ? .01 : 0; S.blink = null;
      S.gaze = S.state === 'think' ? { x: .7, y: -.85 } : S.state === 'reject' ? { x: -.6, y: .25 } : S.state === 'error' ? { x: -.6, y: .2 } : S.state === 'listen' ? { x: .2, y: -.05 } : { x: 0, y: 0 };
      cancelReaction(); const t0 = S.t; S.t = 0; render(); S.t = t0;
    }
    const inst = {
      id, svg, live: opts.live !== false, S,
      get state() { return S.state; }, get morph() { return S.morph; }, get from() { return S.from; },
      setState(s) { if (!STATES[s]) return; if (s !== S.state) { cancelReaction(); S.from = S.state; S.morph = 0; S.gestureT0 = S.t; } S.state = s; S.nextGaze = S.t; S.nextSyl = S.t; S.nextVoice = S.t; if (!inst.live || reducedNow()) staticPose(); },
      tick, render, staticPose, cancelReaction,
      // Emote overlay: one at a time, never queued; refused when motion is static/paused/hidden.
      triggerEmote(name) {
        const em = EMOTES[name];
        if (!em || S.reaction || reducedNow() || G.paused || document.hidden || G.error) return false;
        S.reaction = { name, t0: S.t }; return true;
      },
      greet() {
        if (S.reaction || reducedNow() || G.paused || document.hidden || G.error) return false;
        S.reaction = { name: 'greeting', t0: S.t }; return true;
      },
      get reaction() { return S.reaction ? S.reaction.name : null; },
      sample() { const g = lastGeo || compose(); return { t: S.t, state: S.state, morph: S.morph, reaction: S.reaction ? { name: S.reaction.name, progress: reactionP() } : null, d: bodyEl.getAttribute('d'), pts: g.pts.map(p => [p[0], p[1]]), eyes: g.eyes }; },
      step(n = 1, dt = 1 / 60) { for (let i = 0; i < n; i++) tick(dt); render(); return inst.sample(); },
      destroy() { instances.delete(inst); },
    };
    if (inst.live) instances.add(inst);
    if (!inst.live || reducedNow()) staticPose(); else render();
    loop.sync();
    return inst;
  }

  /* ---------- one shared loop for every live instance ---------- */
  const instances = new Set();
  const G = { paused: false, forced: false, osReduced: MQ.matches, manual: false, error: null, frames: 0, lastFrameAt: 0, scheduled: false };
  const reducedNow = () => G.osReduced && !G.forced;
  const listeners = new Set();
  const notify = () => listeners.forEach(fn => { try { fn(); } catch { /* listener errors are not the loop's */ } });
  let raf = 0, lastTs = null;
  const shouldRun = () => !G.manual && !reducedNow() && !G.paused && !document.hidden && !G.error && instances.size > 0;
  function frame(ts) {
    raf = 0;
    try {
      if (lastTs == null) lastTs = ts;
      const dt = clamp((ts - lastTs) / 1000, 0, 1 / 20); lastTs = ts;
      for (const i of instances) { i.tick(dt); i.render(); }
      G.frames++; G.lastFrameAt = performance.now();
    } catch (err) { fail(err); return; }
    schedule();
  }
  function schedule() { G.scheduled = shouldRun(); if (G.scheduled && !raf) raf = requestAnimationFrame(frame); }
  function halt() { if (raf) cancelAnimationFrame(raf); raf = 0; lastTs = null; G.scheduled = false; }
  const loop = { sync() { if (shouldRun()) { lastTs = null; schedule(); } else halt(); notify(); } };
  function fail(err) { G.error = String(err && err.message || err).slice(0, 140); halt(); notify(); }
  // Window events are not proof that this engine failed. Keep the last bounded diagnostic,
  // without suppressing browser reporting or stopping unrelated, healthy clay instances.
  let externalError = null;
  const observeExternalError = err => { externalError = String(err && err.message || err).slice(0, 140); };
  addEventListener('error', e => observeExternalError(e.error || e.message));
  addEventListener('unhandledrejection', e => observeExternalError(e.reason));
  document.addEventListener('visibilitychange', () => { if (document.hidden) instances.forEach(i => i.cancelReaction()); loop.sync(); });
  MQ.addEventListener('change', e => { G.osReduced = e.matches; if (reducedNow()) instances.forEach(i => i.staticPose()); loop.sync(); });
  const running = () => G.scheduled && performance.now() - G.lastFrameAt < 600;
  function statusKind() {
    if (G.error) return ['error', 'Error: ' + G.error];
    if (reducedNow()) return ['reduced', 'Pose fija: tu sistema pide reducir el movimiento'];
    if (document.hidden) return ['hidden', 'Oculta: pausa automática'];
    if (G.paused) return ['paused', 'En pausa'];
    if (G.manual) return ['paused', 'Modo de prueba manual'];
    if (running()) return ['animating', 'Animando'];
    if (G.scheduled && G.frames === 0) return ['boot', 'Esperando el primer cuadro…'];
    return ['stalled', 'Detenida: el navegador no está dibujando cuadros'];
  }
  return {
    REVISION, STATES, ORDER, EMOTES: EMOTE_NAMES, create, statusKind, running, reducedNow,
    get paused() { return G.paused; }, get forced() { return G.forced; }, get osReduced() { return G.osReduced; }, get error() { return G.error; }, get externalError() { return externalError; }, get frames() { return G.frames; },
    setPaused(p) { G.paused = !!p; if (G.paused) instances.forEach(i => i.cancelReaction()); loop.sync(); },
    setForced(f) { G.forced = !!f; if (reducedNow()) instances.forEach(i => i.staticPose()); loop.sync(); },
    setManual(m) { G.manual = !!m; loop.sync(); },
    onChange(fn) { listeners.add(fn); },
    fail,
  };
})();
