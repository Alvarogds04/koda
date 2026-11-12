'use strict';
/* Human 5hn6xmav, «Centrado bajo la isla»: the pill (Koda + title), the gooey neck and the card are CENTRED horizontally under the island
   (a notch stretching downward), symmetric, in EVERY variant, open (spring settled) and reduced motion. Real layout in Chromium.
   Run: node test-node/question-toast-center-check.cjs */
const assert = require('node:assert/strict');
const path = require('node:path');
const T = require(path.join(__dirname, '..', 'frontend', 'question-toast.js'));
let passed = 0;
const test = (_n, fn) => { fn(); passed += 1; };
test('morphFrame: pill, neck and body are centred on the 350 axis at every progress, open or not, reduced or not', () => {
  for (const o of [{ progress: 1, open: true }, { progress: 1, openP: 0.5, open: true }, { progress: 0.3, openP: 0.2, open: true }, { progress: 1.04, openP: 1.04, open: true }, { progress: 0, open: true, reduce: true }, { progress: 1, open: false }]) {
    const f = T.morphFrame({ ...o, island: { w: 288, r: 14 }, pillW: 150 });
    for (const k of ['pill', 'neck', 'body']) assert.ok(Math.abs(f[k].x + f[k].width / 2 - T.TOAST.w / 2) < 1e-9, `${JSON.stringify(o)} ${k} centred`);
  }
});
// ---- the REAL layout (Playwright; SKIPPED loudly when absent) -----------------------------------------------------------------------
const H = require('./island-geometry-harness.cjs');
const ID = '0b3a5c9e-8f27-4d11-9a0e-1c2d3e4f5a6b';
const perm = text => ({ available: true, queued: [], queued_count: 0, deliveries: [], notice: null, pending: { id: ID, kind: 'approval', agent: 'claude-code', agent_label: 'Claude Code', project_name: 'api', text, allow_free_text: false,
  options: [{ index: 0, label: 'Aprobar', description: '' }, { index: 1, label: 'Rechazar', description: '' }], expires_at: Date.now() + 600000, free_text_max: 2000 } });
const GOLD = 'rgb(255, 225, 0)', GREEN = 'rgb(184, 255, 46)', RED = 'rgb(255, 92, 117)';
// name, harness scenario, how the toast is fed after the island is concealed, expected title colour, buttons expected
const CASES = [
  { name: 'plain', scenario: { question: 'plain' }, title: GOLD },
  { name: 'multi', scenario: { question: 'multi' }, title: GOLD },
  { name: 'form', scenario: { question: 'form' }, title: GOLD },
  { name: 'permission-short', scenario: { question: 'plain' }, feed: perm('Permiso para ejecutar: ls'), title: GOLD, rows: 2 },
  { name: 'permission-long', scenario: { question: 'plain' }, feed: perm('Permiso para ejecutar: rm -rf build/ && npm run build --prefix apps/desktop-tauri'), title: GOLD, viewAll: true },
  { name: 'finished', scenario: { question: null }, arrival: { id: 'f1', kind: 'settled', title: 'Migración aplicada', agent: 'claude-code', projectName: 'api' }, title: GREEN },
  { name: 'error', scenario: { question: null }, disconnect: true, title: RED },
];
const TOL = 1;
async function layout() {
  if (!H.findPlaywright()) { console.log('SKIPPED question-toast-center-check (real layout): no playwright — NOT a pass'); return 0; }
  let n = 0;
  const run = async (c, theme, mode) => {
    const r = await H.open({ ...c.scenario, theme, quick: true });
    try {
      if (mode === 'media') await r.page.emulateMedia({ reducedMotion: 'reduce' });
      if (mode === 'attr') await r.page.evaluate(() => { document.documentElement.dataset.motion = 'reduce'; });
      await r.page.evaluate(() => window.__islandSetState('compact')); await r.page.waitForTimeout(700);
      if (c.feed) await r.page.evaluate(p => window.__emit('question:state', p), c.feed);
      if (c.disconnect) {
        await r.page.evaluate(({ id }) => window.__emit('question:state', { available: true, queued: [], queued_count: 0, deliveries: [], notice: null,
          pending: { id, kind: 'question', agent: 'pi', agent_label: 'Pi', project_name: 'api', text: '¿Café o té?', allow_free_text: false, options: [{ index: 0, label: 'Café', description: '' }, { index: 1, label: 'Té', description: '' }], expires_at: Date.now() + 600000, free_text_max: 2000 } }), { id: ID });
        await r.page.waitForTimeout(100);
      }
      // isla-cualquier-lado S3/S5 (T6): the toast hangs from the FOLDED disc, so switching the island to compact above IS the trigger.
      if (c.arrival) await r.page.evaluate(d => document.dispatchEvent(new CustomEvent('abito:notice-arrival', { detail: d })), c.arrival);
      if (c.disconnect) await r.page.evaluate(() => window.__emit('question:state', { available: true, pending: null, queued: [], queued_count: 0, deliveries: [], notice: 'disconnected' }));
      const tag = `${theme}/${c.name}/${mode}`;
      if (mode === 'mid') { await r.page.waitForTimeout(420); await r.screenshot(`/tmp/toast-center-${c.name}-${theme}-mid.png`); n += 1; return; }
      await r.page.waitForTimeout(2200);
      const m = await r.page.evaluate(() => {
        const t = document.getElementById('question-toast'), acts = document.getElementById('question-toast-actions'), isl = document.getElementById('island');
        const cx = e => { const b = e.getBoundingClientRect(); return { c: (b.left + b.right) / 2, l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width }; };
        const tb = t.getBoundingClientRect();
        const content = [...t.querySelectorAll('.q-toast-badge, .q-toast-dot, .q-toast-title, .q-toast-queue')].filter(e => !e.hidden && e.getBoundingClientRect().width > 0).map(cx);
        const hl = Math.min(...content.map(x => x.l)), hr = Math.max(...content.map(x => x.r));
        const btns = [...acts.querySelectorAll('button')].filter(b => !b.hidden).map(cx);
        const all = [...t.querySelectorAll('*'), ...acts.querySelectorAll('*')].filter(e => !e.closest('[hidden]') && !(e instanceof SVGElement) && !e.classList.contains('q-toast-canvas') && e.getBoundingClientRect().width > 0).map(e => ({ cls: e.getAttribute('class') || e.tagName, b: (b => ({ l: b.left - tb.left, r: b.right - tb.left, t: b.top - tb.top, b: b.bottom - tb.top }))(e.getBoundingClientRect()) }));
        const neck = t.querySelector('.q-toast-neck');
        return { expanded: t.dataset.expanded, hidden: t.hidden, island: cx(isl), pill: cx(t.querySelector('.q-toast-pill')), body: cx(t.querySelector('.q-toast-bodyrect')), neck: cx(neck), tbox: { w: tb.width, h: tb.height },
          header: { c: (hl + hr) / 2, l: hl, r: hr }, btns: btns.length ? { c: (Math.min(...btns.map(x => x.l)) + Math.max(...btns.map(x => x.r))) / 2, n: btns.length } : null, all };
      });
      assert.equal(m.hidden, false, `${tag}: shown`); assert.equal(m.expanded, 'true', `${tag}: expanded`);
      const near = (a, what) => assert.ok(Math.abs(a - m.island.c) <= TOL, `${tag}: ${what} centre ${a.toFixed(2)} vs island centre ${m.island.c.toFixed(2)}`);
      if (process.env.DBG) console.log(tag, JSON.stringify({p:m.pill,h:m.header}));
      near(m.pill.c, 'pill'); near(m.body.c, 'card body'); near(m.neck.c, 'neck'); near(m.header.c, 'header (Koda + title)');
      if (m.btns) near(m.btns.c, 'decision buttons row');
      assert.equal(m.tbox.w, 350, `${tag}: width 350`); assert.ok(m.tbox.h <= 96, `${tag}: height`);
      assert.ok(m.pill.w < 350, `${tag}: a pill`); assert.ok(m.body.w >= 349, `${tag}: body 350 wide`);
      for (const e of m.all) assert.ok(e.b.l >= -0.5 && e.b.r <= 350.5 && e.b.t >= -0.5 && e.b.b <= 96.5, `${tag}: ${e.cls} inside 350x96`);
      if (mode === 'motion') await r.screenshot(`/tmp/toast-center-${c.name}-${theme}.png`);
      if (mode === 'attr' && theme === 'dark') await r.screenshot(`/tmp/toast-center-${c.name}-${theme}-reducido.png`);
      n += 1;
    } finally { await r.close(); }
  };
  for (const theme of ['dark', 'light']) for (const c of CASES) await run(c, theme, 'motion');
  for (const c of CASES.filter(x => ['plain', 'permission-short', 'finished'].includes(x.name))) await run(c, 'dark', 'mid');
  for (const c of CASES) await run(c, 'dark', 'attr');
  for (const c of CASES.filter(x => ['plain', 'permission-short', 'finished'].includes(x.name))) await run(c, 'light', 'media');
  n += await disc();
  return n;
}
/** T6: the toast hangs from the DISC on the side that faces the centre of the screen, and never shows with the island open. */
async function disc() {
  let n = 0;
  const show = (edge) => async () => {
    const r = await H.open({ question: 'plain', theme: 'dark', quick: true });
    try {
      await r.page.evaluate(e => window.__islandSetState('compact', e), edge);
      await r.page.waitForTimeout(1600);
      const m = await r.page.evaluate(() => {
        const t = document.getElementById('question-toast'), i = document.getElementById('island'), c = document.getElementById('capsule');
        const box = e => { const b = e.getBoundingClientRect(); return { t: b.top, b: b.bottom, l: b.left, r: b.right, w: b.width, h: b.height }; };
        const shape = k => box(t.querySelector('.q-toast-' + k));
        return { hidden: t.hidden, edge: t.dataset.edge, expanded: t.dataset.expanded, phase: c.dataset.phase, capsule: box(c),
          toast: box(t), island: box(i), badge: box(t.querySelector('.q-toast-badge')), slot: box(t.querySelector('.q-toast-koda')),
          neck: shape('neck'), pill: shape('pill'), body: shape('bodyrect') };
      });
      assert.equal(m.hidden, false, `${edge}/folded: the question arrives as the toast hanging from the disc`);
      assert.equal(m.phase, 'compact', `${edge}: the island stayed folded`);
      assert.equal(m.edge, edge, `${edge}: it hangs from the side the page's own data-edge names`);
      assert.equal(m.toast.w, 350, `${edge}: width 350`);
      if (edge === 'top') assert.ok(Math.abs(m.toast.t - m.island.b) <= 1, `${edge}: below the disc (toast top ${m.toast.t.toFixed(1)} vs disc bottom ${m.island.b.toFixed(1)})`);
      else assert.ok(Math.abs(m.toast.b - m.island.t) <= 1, `${edge}: above the disc (toast bottom ${m.toast.b.toFixed(1)} vs disc top ${m.island.t.toFixed(1)})`);
      assert.ok(Math.abs((m.island.l + m.island.r) / 2 - 376) <= 1, `${edge}: the disc stays centred in the 752 window`);
      // T6b: the gooey pill, neck and body are PAINTED on the disc side the edge names (the shape was mirrored about the wrong line
      // and the whole card was drawn one box height away from its text), and all of it inside the native window's capsule
      if (edge === 'top') {
        assert.ok(Math.abs(m.neck.b - m.island.b) <= 1, `${edge}: the neck joins the disc at its bottom edge (neck bottom ${m.neck.b.toFixed(1)} vs disc ${m.island.b.toFixed(1)})`);
        assert.ok(Math.abs(m.pill.t - m.island.b) <= 1, `${edge}: the pill sits under the disc (pill top ${m.pill.t.toFixed(1)})`);
        assert.ok(m.body.b - m.island.b >= 32, `${edge}: the body grows down, away from the disc`);
      } else {
        assert.ok(Math.abs(m.neck.t - m.island.t) <= 1, `${edge}: the neck joins the disc at its top edge (neck top ${m.neck.t.toFixed(1)} vs disc ${m.island.t.toFixed(1)})`);
        assert.ok(Math.abs(m.pill.b - m.island.t) <= 1, `${edge}: the pill sits above the disc (pill bottom ${m.pill.b.toFixed(1)})`);
        assert.ok(m.island.t - m.body.t >= 32, `${edge}: the body grows up, away from the disc`);
      }
      for (const k of ['neck', 'pill', 'body']) assert.ok(m[k].t >= m.capsule.t - 1 && m[k].b <= m.capsule.b + 1, `${edge}: the painted ${k} is inside the native window`);
      // T6b (R3-koda-slot-position-unproved): the toast's Koda is drawn INSIDE the 28 px badge, never spilling out of it
      assert.ok(m.slot.w >= 1 && m.slot.h >= 1, `${edge}: the toast badge paints Koda`);
      assert.ok(m.badge.w <= 28.5 && m.badge.h <= 28.5, `${edge}: the badge is the 28 px circle (${m.badge.w}x${m.badge.h})`);
      assert.ok(m.slot.l >= m.badge.l - 1 && m.slot.r <= m.badge.r + 1 && m.slot.t >= m.badge.t - 1 && m.slot.b <= m.badge.b + 1,
        `${edge}: the Koda sprite (${m.slot.l.toFixed(1)}..${m.slot.r.toFixed(1)}, ${m.slot.t.toFixed(1)}..${m.slot.b.toFixed(1)}) stays inside the badge (${m.badge.l.toFixed(1)}..${m.badge.r.toFixed(1)}, ${m.badge.t.toFixed(1)}..${m.badge.b.toFixed(1)})`);
      assert.ok(m.slot.w <= 28.5 && m.slot.h <= 28.5, `${edge}: the Koda sprite is ${m.slot.w}x${m.slot.h}, not 32x32 in a 28 px badge`);
      if (edge === 'top') await r.screenshot('/tmp/toast-disc-below.png'); else await r.screenshot('/tmp/toast-disc-above.png');
      n += 1;
    } finally { await r.close(); }
  };
  await show('top')(); await show('bottom')();
  // with the island OPEN the toast never shows: the card is the signal
  const r = await H.open({ question: 'plain', theme: 'dark', quick: true });
  try {
    await r.page.evaluate(() => window.__islandSetState('overview'));
    await r.page.waitForTimeout(1600);
    const m = await r.page.evaluate(() => {
      const t = document.getElementById('question-toast'), slot = t.querySelector('.q-toast-koda'), b = slot.getBoundingClientRect();
      return { hidden: t.hidden, phase: document.getElementById('capsule').dataset.phase, slot: { w: b.width, h: b.height } };
    });
    assert.equal(m.phase, 'expanded'); assert.equal(m.hidden, true, 'open island: no toast (the card itself shows the question)');
    // T6b (R2-koda-slot-hidden-toast): the slot exists in the DOM but a hidden toast paints nothing — its sprite has no box at all
    assert.equal(m.slot.w, 0); assert.equal(m.slot.h, 0);
    n += 1;
  } finally { await r.close(); }
  return n;
}
layout().then(n => { console.log(`question-toast-center-check: ${passed} ok + ${n} layout`); }).catch(e => { console.error('FAIL', e.message); process.exit(1); });
