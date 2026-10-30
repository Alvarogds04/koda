'use strict';
// HU-057 S12 (human, 29-oct, canvas replica): the COMPACT pill in the real layout.
//  1) «esto no esta centrado koda»: Koda's DRAWN pixels are centred vertically in the 32px pill (±1px), with a real left padding.
//  2) «Koda no tiene espacio aqui»: Koda and the text never touch: >= 8px between their boxes in every compact variant.
//  15) «porque esto es de color azul?»: the legacy thread #edge-strip (cyan) is hidden while the pill is visible, and when the island
//      is hidden it wears ROLE colours (never the fixed cyan / green / amber of the vendor sheet).
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');

const NOTICE = t => ({ id: 'n-pill', title: t, detail: 'Listo', severity: 'info', kind: 'settled', expiresAt: Date.now() + 600000, agent: 'pi', projectName: 'workspace' });
const snap = (s, notices) => ({ state: s, notices, card: null, request: null, revision: Date.now(), motionOverride: false, unavailable: false, connections: 1 });

// page-side probe: boxes, Koda's opaque-pixel bbox (from the sprite sheet at the current frame), strip colours
const probe = () => page => page.evaluate(async () => {
  const R = e => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
  const isl = document.getElementById('island'), act = document.getElementById('compact-activity'), k = document.querySelector('.koda-sprite');
  const kb = R(k), s = k.style, img = new Image(); img.src = s.backgroundImage.slice(5, -2); await img.decode();
  const w = parseFloat(s.width), h = parseFloat(s.height), c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d'); const [bx, by] = s.backgroundPosition.split(' ').map(parseFloat), [sw, sh] = s.backgroundSize.split(' ').map(parseFloat);
  x.imageSmoothingEnabled = false; x.drawImage(img, bx, by, sw, sh);
  const d = x.getImageData(0, 0, w, h).data; let t = 1e9, b = -1, l = 1e9, r = -1;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (d[(j * w + i) * 4 + 3] > 40) { t = Math.min(t, j); b = Math.max(b, j); l = Math.min(l, i); r = Math.max(r, i); }
  const ib = R(isl), ink = { l: kb.l + l, r: kb.l + r + 1, t: kb.t + t, b: kb.t + b + 1 };
  const reply = document.getElementById('compact-reply'), rv = reply && reply.offsetWidth ? R(reply) : null;
  const strip = document.getElementById('edge-strip'), cs = getComputedStyle(strip), cap = document.getElementById('capsule');
  return { island: ib, koda: kb, ink, act: act.textContent ? R(act) : null, text: act.textContent, scrollW: act.scrollWidth, clientW: act.clientWidth, reply: rv,
    fit: cap.dataset.pillFit, phase: cap.dataset.phase, strip: { op: cs.opacity, disp: cs.display, bg: cs.backgroundColor, state: strip.dataset.state },
    shapes: (window.__shapes || []).slice(-1)[0] || null };
});
const P = probe();
const centreY = o => (o.ink.t + o.ink.b) / 2;

async function variant(name, scenario, drive, theme) {
  const ui = await H.open(Object.assign({ theme }, scenario));
  if (!ui) { console.log('SKIP island-nusa-pill: playwright unavailable'); process.exit(0); }
  const { page } = ui;
  try { await drive(page); await page.waitForTimeout(2600); /* HU-070: folding the island plays desaparecer→aparecer (1.6 s); measure the settled Koda */ return { ui, page, m: await P(page) }; } catch (e) { await ui.close(); throw e; }
}
const compact = async page => { await page.evaluate(() => window.__islandSetState('compact')); };
const withNotice = t => async page => { await compact(page); await page.evaluate(s => window.__emit('desktop:state', s), snap('compact', [])); await page.waitForTimeout(500); await page.evaluate(s => window.__emit('desktop:state', s), snap('compact', [NOTICE(t)])); };
const VARIANTS = [
  ['idle', { quick: true, sessions: [] }, compact, true],
  ['project', { compact: true }, compact, false],
  ['notice', { quick: true, sessions: [] }, withNotice('Pi terminó su turno'), false],
  ['notice-long', { quick: true, sessions: [] }, withNotice('Pi terminó su turno y dejó la migración aplicada con 14 tests pasando en el repositorio api'), false],
  ['question', { compact: true, question: 'plain' }, compact, false],
  ['permission', { compact: true, question: 'approvalPi' }, compact, false],
];

(async () => {
  let ran = 0;
  for (const theme of ['dark', 'light']) {
    for (const [name, scenario, drive, bare] of VARIANTS) {
      const { ui, page, m } = await variant(name, scenario, drive, theme);
      try {
        ran++;
        const tag = `${theme}/${name}`;
        const pillCy = (m.island.t + m.island.b) / 2;
        assert.equal(m.phase, 'compact', `${tag}: compact`);
        // 1) vertical centre of the DRAWN Koda within 1px of the pill centre
        assert.ok(Math.abs(centreY(m) - pillCy) <= 1.01, `${tag}: Koda's drawn centre y ${centreY(m)} vs pill centre ${pillCy}`);
        // the drawn Koda sits inside the pill with real air on its left (never hugging the rounded edge)
        const padL = m.ink.l - m.island.l;
        if (bare) assert.ok(Math.abs(padL - (m.island.r - m.ink.r)) <= 1.01, `${tag}: Koda-only capsule is horizontally balanced (${padL} vs ${m.island.r - m.ink.r})`);
        else assert.ok(padL >= 6 && (m.fit !== 'true' || padL <= 12), `${tag}: Koda has real air on its left, 6..12px in the fitted pill (${padL})`);
        assert.ok(m.ink.t >= m.island.t && m.ink.b <= m.island.b, `${tag}: Koda is inside the pill vertically`);
        // 2) Koda and the text never touch: >= 8px apart (the text ellipsises instead)
        if (m.act) {
          const gap = m.act.l - m.koda.r;
          assert.ok(gap >= 8, `${tag}: >= 8px between Koda's box and the text (${gap})`);
          assert.ok(m.act.r <= m.island.r + 0.5, `${tag}: the text stays inside the pill`);
          if (m.reply) assert.ok(m.reply.l - m.act.r >= 8 || m.act.r <= m.reply.l, `${tag}: the text does not run under the button`);
        }
        // the pill never exceeds the reported box (width of the shape the host receives) and the idle Koda-only capsule is 40
        if (m.shapes) { const rw = Array.isArray(m.shapes) ? m.shapes[0] : m.shapes.w; if (rw) assert.ok(m.island.w <= rw + 0.5, `${tag}: pill ${m.island.w} <= reported ${rw}`); }
        assert.ok(m.island.w <= 560.5, `${tag}: <= 560`);
        if (bare) assert.equal(Math.round(m.island.w), 40, `${tag}: the idle Koda-only capsule stays 40px`);
        // 15) the legacy thread is hidden while the pill is visible
        assert.ok(m.strip.op === '0' || m.strip.disp === 'none', `${tag}: edge thread hidden under the visible pill (opacity ${m.strip.op}, state ${m.strip.state})`);
        if (theme === 'dark') await ui.screenshot(`/tmp/pill-fix-${name}-dark.png`); else await ui.screenshot(`/tmp/pill-fix-${name}-light.png`);
      } finally { await ui.close(); }
    }
  }
  // 15b) the island IS hidden: the thread is the only indicator, with ROLE colours
  for (const theme of ['dark', 'light']) {
    for (const [state, sc, role] of [['question', { compact: true, question: 'plain' }, '--sun'], ['approval', { compact: true, question: 'approvalPi' }, '--sun'], ['finished', { compact: true }, '--go'], ['error', { compact: true }, '--red-11'], ['working', { compact: true }, '--pill-dot']]) {
      const ui = await H.open(Object.assign({ theme }, sc));
      try {
        const { page } = ui; ran++;
        await page.evaluate(() => window.__islandSetState('compact')); await page.waitForTimeout(1000);
        await page.evaluate(() => window.__islandConceal(true)); await page.waitForTimeout(1200);
        const r = await page.evaluate(({ state, role }) => {
          const strip = document.getElementById('edge-strip'), cap = document.getElementById('capsule');
          if (!['question', 'approval'].includes(state) || strip.dataset.state !== state) { strip.dataset.state = state; strip.dataset.pulse = 'false'; }
          const probeEl = document.createElement('i'); cap.append(probeEl); probeEl.style.background = `var(${role}, var(--island-live))`;
          const want = getComputedStyle(probeEl).backgroundColor; probeEl.remove();
          const cs = getComputedStyle(strip); return { hidden: cap.dataset.edgeHidden, got: cs.backgroundColor, want, op: cs.opacity, st: strip.dataset.state };
        }, { state, role });
        const tag = `${theme}/hidden-${state}`;
        assert.equal(r.hidden, 'true', `${tag}: island concealed`);
        await page.waitForTimeout(400);
        const got = await page.evaluate(() => getComputedStyle(document.getElementById('edge-strip')).backgroundColor);
        for (const bad of ['rgb(34, 211, 238)', 'rgb(34, 197, 94)', 'rgb(245, 165, 36)']) assert.notEqual(got, bad, `${tag}: the thread never wears the vendor colour ${bad}`);
        assert.equal(got, r.want, `${tag}: the thread wears the role colour ${role} (${got} vs ${r.want})`);
        assert.ok(Number(r.op) > 0.3, `${tag}: the thread is visible when the island is hidden (${r.op})`);
        await ui.screenshot(`/tmp/pill-fix-hidden-${state}-${theme}.png`);
      } finally { await ui.close(); }
    }
  }
  console.log(`island-nusa-pill: ${ran} scenarios ok`);
})().catch(e => { console.error(e); process.exit(1); });
