'use strict';
/* SN1/SN2/SN5/SN6 (vault «Specs/Sileo-notificacion»): the floating toast has the SHAPE and MOTION of the approved Sileo prototype
   (docs/prototypes/agent-island-sileo.html): the pill sits at the TOP-CENTRE of the card (human 5hn6xmav: centred under the island) and joins the body through the gooey neck, it
   stretches/opens into the card and folds back (spring), the title is coloured by state, the decision controls are the numbered rows.
   Pure functions first (timing table, title colour, pill geometry), then the REAL layout in Chromium (island concealed, toast alone).
   Run: node test-node/question-toast-sileo-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const T = require(path.join(frontend, 'question-toast.js'));
let passed = 0;
const test = (_n, fn) => { fn(); passed += 1; };

// ---- SN6: the measured timings are ONE named table ------------------------------------------------------------------------------
test('SN6 timing table: spring 600 ms overshoot 1.038 at 45 %, content 360 ms delay 180, exit 48 ms delay 24, presence 396', () => {
  assert.deepEqual({ ...T.TIMING }, { springMs: 600, overshoot: 1.038, overshootAt: 0.45, contentInMs: 360, contentInDelayMs: 180, contentOutMs: 48, contentOutDelayMs: 24, presenceMs: 396 });
  assert.ok(Object.isFrozen(T.TIMING));
  assert.equal(T.SPRING.duration * 1000, T.TIMING.springMs, 'the spring clock IS the table');
  assert.equal(T.TIMING.presenceMs, Math.round(0.66 * T.TIMING.springMs), 'presence = 0.66 x 600');
  assert.equal(T.TIMING.contentInMs, 0.6 * T.TIMING.springMs); assert.equal(T.TIMING.contentInDelayMs, 0.3 * T.TIMING.springMs);
});
test('SN6 measured easing curve: 0 -> 1 with the 1.038 overshoot at 45 %', () => {
  assert.equal(T.easeAt(0), 0); assert.equal(T.easeAt(-1), 0); assert.equal(T.easeAt(1), 1); assert.equal(T.easeAt(5), 1);
  assert.equal(T.easeAt(T.TIMING.overshootAt), T.TIMING.overshoot);
  const peak = Math.max(...Array.from({ length: 101 }, (_, i) => T.easeAt(i / 100)));
  assert.equal(peak, 1.038);
  assert.ok(Math.abs(T.easeAt(0.137) - 0.467) < 1e-9, 'a point read off the measured table');
  for (const bad of [NaN, Infinity, 'x', undefined]) assert.equal(T.easeAt(bad), 0, String(bad));
});

// ---- SN1: the title colour is the STATE's colour ---------------------------------------------------------------------------------
const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
test('titleColour: amber for permission and question, green for finished, red for error/disconnected, neutral otherwise', () => {
  assert.equal(T.titleColour('sun'), '#ffe100'); assert.equal(T.titleColour('agent'), '#ffe100', 'a question is amber; the asker colour is only secondary');
  assert.equal(T.titleColour('go'), '#b8ff2e'); assert.equal(T.titleColour('red'), '#ff5c75'); assert.equal(T.titleColour('neutral'), '#d4d4d8');
  assert.equal(T.titleColour({ kind: 'finished', role: 'neutral' }), '#b8ff2e', 'finished is green though its role stays neutral (never a success claim in the words)');
  assert.equal(T.titleColour({ kind: 'expired', role: 'neutral' }), '#d4d4d8'); assert.equal(T.titleColour({ kind: 'disconnected', role: 'red' }), '#ff5c75');
  for (const bad of [null, undefined, 'blue', {}, 7, '__proto__', 'constructor']) assert.equal(T.titleColour(bad), '#d4d4d8', `fallback for ${JSON.stringify(bad)}`);
  for (const r of ['sun', 'agent', 'go', 'red', 'neutral']) assert.ok(ratio(rgb(T.titleColour(r)), [0, 0, 0]) >= 4.5, `${r} title colour passes AA on the black body`);
  const q = T.toastView({ available: true, queued_count: 0, pending: { id: 'a'.repeat(8) + '-0000-4000-8000-' + 'b'.repeat(12), kind: 'question', text: '¿Café?', agent: 'pi', options: [{ index: 0, label: 'a' }, { index: 1, label: 'b' }], expires_at: Date.now() + 60000 } }, {});
  assert.equal(T.titleColour(q), '#ffe100');
});

// ---- SN1 geometry: the pill is at the TOP-CENTRE of the open card and the neck joins it to the body with no gap -------------------------
test('morphFrame: open card -> pill at the top-centre (human 5hn6xmav); closed -> centred under the island; the open pill overlaps the body (the gooey neck)', () => {
  const island = { w: 288, r: 14 };
  const closed = T.morphFrame({ progress: 1, island, pillW: 150, open: false });
  assert.equal(closed.pill.x, (T.TOAST.w - 150) / 2, 'closed (Sileo): centred like the island');
  const open = T.morphFrame({ progress: 1, island, pillW: 150, open: true });
  assert.equal(open.pill.x, (T.TOAST.w - 150) / 2, 'open: the pill stays centred on the card (no slide to the left)'); assert.equal(open.pill.y, 0);
  assert.ok(open.pill.y + open.pill.height > open.body.y, 'the pill reaches below the body top: the gooey filter melts the junction into a curved neck, no gap');
  assert.equal(open.body.x, 0); assert.equal(open.body.width, T.TOAST.w);
  assert.ok(open.pill.y + open.pill.height <= T.TOAST.hMax, 'inside the 96px box');
  const mid = T.morphFrame({ progress: 1, openP: 0.5, island, pillW: 150, open: true });
  assert.equal(mid.pill.x, closed.pill.x, 'the pill does not travel sideways with the open progress');
  const gone = T.morphFrame({ progress: 1, openP: 0, island, pillW: 150, open: true });
  assert.deepEqual([gone.pill.x, gone.pill.height], [closed.pill.x, T.TOAST.h], 'folded back: exactly the closed pill again');
  for (const p of [0, 0.25, 0.5, 1, 1.04]) { const f = T.morphFrame({ progress: p, openP: Math.min(1, p), island, pillW: 200, open: true }); assert.ok(f.pill.y <= f.neck.y + f.neck.height + (p > 1 ? 1 : 0.0001), `p=${p}: the pill touches the island edge, no gap (the overshoot is < 1px, inside the gooey blur)`); }
  const r = T.morphFrame({ progress: 0, island, pillW: 150, open: true, reduce: true });
  assert.deepEqual([r.pill.x, r.pill.width, r.pill.height > T.TOAST.h], [100, 150, true], 'reduced motion: the final open geometry at once, centred, no travel');
  assert.deepEqual(T.PILL_OPEN_H, 64);
});

// ---- source contract: ordinals decorative, no 1/2 shortcut, reduced motion path, timings in the stylesheet --------------------------
test('source contract: aria-hidden ordinals, no keyboard shortcut for 1/2, the stylesheet carries the SN6 table', () => {
  const js = fs.readFileSync(path.join(frontend, 'question-toast.js'), 'utf8'), css = fs.readFileSync(path.join(frontend, 'question-toast.css'), 'utf8');
  assert.match(js, /q-toast-ord/); assert.match(js, /setAttribute\('aria-hidden', 'true'\)/);
  assert.doesNotMatch(js, /key(down|press|up)'[^;]*['"][12]['"]/i, 'no shortcut for the ordinals');
  assert.doesNotMatch(js, /event\.key === ['"][12]['"]|\.key === '1'|\.key === '2'/);
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML/);
  const v = n => { const m = new RegExp(`--${n}:\\s*(\\d+)ms`).exec(css); return m ? +m[1] : null; };
  assert.deepEqual([v('sileo-content-in'), v('sileo-content-in-delay'), v('sileo-content-out'), v('sileo-content-out-delay'), v('sileo-presence')],
    [T.TIMING.contentInMs, T.TIMING.contentInDelayMs, T.TIMING.contentOutMs, T.TIMING.contentOutDelayMs, T.TIMING.presenceMs]);
  assert.match(css, /--sileo-duration:\s*600ms/); assert.match(css, /1\.038 45%/);
  assert.match(css, /html\[data-motion="reduce"\] \.q-toast, html\[data-motion="reduce"\] \.q-toast \* \{ animation: none; transition: none; \}/);
  assert.match(css, /\.q-toast-ord/);
});

// ---- the REAL layout (Playwright; SKIPPED loudly when absent) -----------------------------------------------------------------------
const H = require('./island-geometry-harness.cjs');
const parse = c => { const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(c); return m ? { rgb: [+m[1], +m[2], +m[3]], a: m[4] === undefined ? 1 : +m[4] } : null; };
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
async function layout() {
  if (!H.findPlaywright()) { console.log('SKIPPED question-toast-sileo-check (real layout): no playwright — NOT a pass'); return 0; }
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
      const conceal = () => r.page.evaluate(() => { document.getElementById('capsule').dataset.edgeHidden = 'true'; });
      const feedLate = async () => {
        if (c.arrival) await r.page.evaluate(d => document.dispatchEvent(new CustomEvent('abito:notice-arrival', { detail: d })), c.arrival);
        if (c.disconnect) await r.page.evaluate(() => window.__emit('question:state', { available: true, pending: null, queued: [], queued_count: 0, deliveries: [], notice: 'disconnected' }));
      };
      const tag = `${theme}/${c.name}/${mode}`;
      if (mode === 'mid') { // mid-animation frame: the pill is still travelling
        await conceal(); await feedLate(); await r.page.waitForTimeout(420);
        await r.screenshot(`/tmp/toast-sileo-${c.name}-${theme}-mid.png`); n += 1; return;
      }
      await conceal(); await feedLate(); await r.page.waitForTimeout(2200);
      const m = await r.page.evaluate(() => {
        const t = document.getElementById('question-toast'), acts = document.getElementById('question-toast-actions'), cs = e => getComputedStyle(e), tb = t.getBoundingClientRect();
        const rel = e => { const b = e.getBoundingClientRect(); return { left: b.left - tb.left, top: b.top - tb.top, right: b.right - tb.left, bottom: b.bottom - tb.top, w: b.width, h: b.height }; };
        const all = [t, ...t.querySelectorAll('*'), acts, ...acts.querySelectorAll('*')].filter(e => !(e.closest('[hidden]')));
        const moving = all.filter(e => { const s = cs(e); return (s.animationName !== 'none' && s.animationDuration !== '0s') || (s.transform !== 'none' && !(e instanceof SVGElement)); }).map(e => `${e.tagName}.${e.getAttribute('class')} anim=${cs(e).animationName} tf=${cs(e).transform}`);
        const rects = [...t.querySelectorAll('.q-toast-pill, .q-toast-bodyrect, .q-toast-neck')].map(e => cs(e).transitionDuration);
        const btn = [...acts.querySelectorAll('button')].filter(b => !b.hidden);
        return { hidden: t.hidden, expanded: t.dataset.expanded, opacity: cs(t).opacity, tbox: { w: tb.width, h: tb.height }, pill: rel(t.querySelector('.q-toast-pill')), bodyrect: rel(t.querySelector('.q-toast-bodyrect')),
          title: cs(t.querySelector('.q-toast-title')).color, titleBox: rel(t.querySelector('.q-toast-title')), badge: rel(t.querySelector('.q-toast-badge')), moving, rects,
          boxes: all.filter(e => !(e instanceof SVGElement) && !e.classList.contains('q-toast-canvas') && e.getBoundingClientRect().width > 0).map(e => ({ cls: e.getAttribute('class') || e.tagName, b: rel(e) })),
          btns: btn.map(b => { const o = acts.querySelector(b.classList.contains('q-toast-approve') ? '.q-toast-ord-approve' : b.classList.contains('q-toast-reject') ? '.q-toast-ord-reject' : '.none'); return { cls: b.className, ord: o && !o.hidden ? o.textContent : null, ordHidden: o ? o.getAttribute('aria-hidden') : null, ordBox: o ? rel(o) : null, name: b.textContent, box: rel(b), border: cs(b).borderTopColor }; }),
          shot: !!document.querySelector('#question-toast .q-toast-abito') };
      });
      assert.equal(m.hidden, false, `${tag}: shown`); assert.equal(m.expanded, 'true', `${tag}: expanded`); assert.equal(+m.opacity, 1, `${tag}: fully visible`);
      assert.equal(m.title, c.title, `${tag}: title colour is the state colour`);
      assert.ok(Math.abs((m.pill.left + m.pill.right) / 2 - 175) <= 1, `${tag}: the pill is CENTRED on the 350 box (centre ${((m.pill.left + m.pill.right) / 2).toFixed(1)})`);
      assert.ok(m.pill.top <= 0.5, `${tag}: the pill is at the TOP`);
      assert.ok(m.pill.w < m.tbox.w - 20 || m.titleBox.w > 220, `${tag}: a pill, not a full-width box (${m.pill.w})`);
      assert.ok(m.pill.bottom > 40, `${tag}: the pill reaches into the body (neck)`);
      assert.ok(m.badge.left >= m.pill.left - 0.5 && m.badge.right <= m.pill.right + 0.5, `${tag}: the Koda circle sits inside the pill`);
      assert.ok(m.titleBox.left >= m.badge.right - 0.5 && m.titleBox.right <= m.pill.right + 0.5, `${tag}: the title sits inside the pill`);
      assert.equal(m.tbox.w, 350, `${tag}: width 350`); assert.ok(m.tbox.h <= 96 && m.tbox.h >= 40, `${tag}: height ${m.tbox.h} in 40..96`);
      for (const e of m.boxes) assert.ok(e.b.left >= -0.5 && e.b.right <= 350.5 && e.b.top >= -0.5 && e.b.bottom <= 96.5, `${tag}: ${e.cls} inside 350x96 ${JSON.stringify(e.b)}`);
      assert.ok(m.pill.bottom <= 96.5 && m.bodyrect.bottom <= 96.5, `${tag}: shapes inside 96`);
      const decide = m.btns.filter(b => !/viewall/.test(b.cls));
      if (c.rows) {
        assert.equal(decide.length, 2, `${tag}: two numbered rows`);
        const byName = Object.fromEntries(decide.map(b => [/approve/.test(b.cls) ? 'approve' : 'reject', b]));
        assert.equal(byName.approve.ord, '1.', `${tag}: «1.» on Aprobar`); assert.equal(byName.reject.ord, '2.', `${tag}: «2.» on Rechazar`);
        for (const b of decide) { assert.equal(b.ordHidden, 'true', `${tag}: ordinal decorative (aria-hidden)`); assert.ok(b.ordBox.left >= b.box.left && b.ordBox.right <= b.box.right, `${tag}: the ordinal sits inside its row`); assert.ok(!/^\d\./.test(b.name), `${tag}: the button label is untouched by the ordinal`); }
        assert.deepEqual([byName.approve.name, byName.reject.name], ['Aprobar', 'Rechazar']);
        assert.ok(byName.approve.box.left < byName.reject.box.left, `${tag}: 1. then 2. in reading order`);
        assert.ok(byName.approve.box.right <= byName.reject.box.left + 0.5 || byName.approve.box.bottom <= byName.reject.box.top + 0.5, `${tag}: rows do not overlap`);
      } else assert.equal(decide.length, 0, `${tag}: no decision rows`);
      if (c.viewAll) assert.equal(m.btns.filter(b => /viewall/.test(b.cls)).length, 1, `${tag}: single «Ver todo»`);
      if (mode !== 'motion') { if (c.name === 'plain' || c.name === 'permission-short' || c.name === 'permission-long') assert.equal(m.btns.length, c.rows ? 2 : c.viewAll ? 1 : 0, `${tag}: buttons`); }
      if (mode === 'media' || mode === 'attr') {
        assert.deepEqual(m.moving, [], `${tag}: reduced motion: nothing animates or transforms`);
        for (const d of m.rects) assert.equal(d, '0s', `${tag}: reduced motion: the shape has no transition`);
      }
      if (mode === 'motion') await r.screenshot(`/tmp/toast-sileo-${c.name}-${theme}.png`);
      if (mode === 'attr' && theme === 'dark') await r.screenshot(`/tmp/toast-sileo-${c.name}-${theme}-reducido.png`);
      n += 1;
    } finally { await r.close(); }
  };
  for (const theme of ['dark', 'light']) for (const c of CASES) await run(c, theme, 'motion');
  for (const c of CASES.filter(x => ['plain', 'permission-short', 'finished'].includes(x.name))) await run(c, 'dark', 'mid');
  for (const c of CASES) { await run(c, 'dark', 'attr'); }
  for (const c of CASES.filter(x => ['plain', 'permission-short', 'finished'].includes(x.name))) await run(c, 'light', 'media');
  return n;
}
layout().then(n => { console.log(`question-toast-sileo-check: ${passed} ok + ${n} layout`); }).catch(e => { console.error('FAIL', e.message); process.exit(1); });
