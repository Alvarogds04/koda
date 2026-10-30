'use strict';
/* HU-073 (human choice «02 · Ajustes, sonido y plegar en la cabecera», design/hu-073-controles-isla/02-ajustes-sonido-plegar.html):
   regression of HU-057 — the notch hid #island-header, so Ajustes / Silenciar / Plegar had NO entry on Inicio, Agentes and Avisos.
   In the notch header (right side, next to the animated bars) the SAME three nodes (#open-settings, #toggle-sound, #header-fold: their listeners are
   bound by id, so they are not duplicated nor re-parented) must be: 24px circles, 12px apart, 36x44 click zones, inside the island, not covered at the
   centre nor at the edges of their zone, not overlapping title/clock/bars, and a REAL click must do what it did in the old island. Real layout, dark+light.
   The button's own box is the 36x44 click zone; the 24px disc is its ::after (6px in from the sides, 10px from top and bottom): a zone is hit-tested, a bare overflowing
   pseudo-element was measured NOT to be.
   The chat view keeps them too (they already lived there). */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-nusa-header-controls-check: no playwright — NOT a pass'); process.exit(0); }
const IDS = ['open-settings', 'toggle-sound', 'header-fold'];
const SCENARIOS = [
  ['inicio', {}, null], ['agentes', {}, 1], ['avisos', {}, 2],
  ['pregunta', { question: 'plain' }, null], ['permiso', { question: 'approvalPi' }, null],
  ['terminó', { finishedCard: 'pi', sessions: [], quick: true }, null], ['motor caído', { engine: 'down' }, null],
];
async function measure(page) {
  return page.evaluate(ids => {
    const isl = document.getElementById('island').getBoundingClientRect(), box = e => { const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, h: b.height }; };
    const vis = e => { const s = getComputedStyle(e); let n = e, op = 1; for (; n && n !== document.body; n = n.parentElement) { const cs = getComputedStyle(n); op *= +cs.opacity; if (cs.visibility === 'hidden' || cs.display === 'none') return false; } return op > 0.05; };
    const ctl = ids.map(id => { const e = document.getElementById(id); if (!e) return { id, missing: true }; const a = getComputedStyle(e, '::after'); return { id, ...box(e), visible: vis(e), disc: { w: parseFloat(a.width) - 0, h: parseFloat(a.height) - 0, radius: a.borderTopLeftRadius, inset: [a.top, a.right, a.bottom, a.left] } }; });
    const named = id => { const e = document.getElementById(id); return e && vis(e) ? box(e) : null; };
    return { isl: { l: isl.left, r: isl.right, t: isl.top, b: isl.bottom }, ctl, title: named('nusa-title'), clock: named('nusa-clock'), bars: named('nusa-bars') };
  }, IDS);
}
// the click zone of a control = its own 36x44 box; its 24px disc is the ::after inset 10px 6px
const zone = c => ({ l: c.l, r: c.r, t: c.t, b: c.b });
const disc = c => ({ l: c.l + 6, r: c.r - 6, t: c.t + 10, b: c.b - 10, w: c.w - 12, h: c.h - 20 });
async function hitAll(page, m) {
  return page.evaluate(({ ids, zones, isl }) => ids.flatMap((id, i) => {
    const e = document.getElementById(id), z = zones[i], cx = (z.l + z.r) / 2, cy = (z.t + z.b) / 2, out = [];
    const probes = [[cx, cy], [z.l + 1, cy], [z.r - 1, cy], [cx, z.b - 1], [cx, Math.max(z.t + 1, isl.t + 1)]];
    for (const [x, y] of probes) { const top = document.elementFromPoint(x, y); if (!(top === e || (top && e.contains(top)))) out.push({ id, at: [Math.round(x), Math.round(y)], got: top ? (top.id || top.className || top.tagName) + '' : null }); }
    return out;
  }), { ids: IDS, zones: m.ctl.map(zone), isl: m.isl });
}
function checkLayout(name, theme, m) {
  const tag = `${theme}/${name}`;
  assert.ok(m.ctl.every(c => !c.missing), `${tag}: the three nodes exist`);
  assert.ok(m.ctl.every(c => c.visible), `${tag}: Ajustes, Silenciar and Plegar are visible: ${JSON.stringify(m.ctl.map(c => [c.id, c.visible]))}`);
  for (const c of m.ctl) {
    const d = disc(c);
    assert.ok(Math.abs(c.w - 36) <= 1 && Math.abs(c.h - 44) <= 1, `${tag}: ${c.id} click zone is 36x44 (${Math.round(c.w)}x${Math.round(c.h)})`);
    assert.ok(Math.abs(d.w - 24) <= 1 && Math.abs(d.h - 24) <= 1, `${tag}: ${c.id} disc is 24px (${Math.round(d.w)}x${Math.round(d.h)})`);
    assert.ok(Math.abs(parseFloat(c.disc.w) - 24) <= 1 && Math.abs(parseFloat(c.disc.h) - 24) <= 1 && /50%|12px/.test(c.disc.radius), `${tag}: the ::after disc is a 24px circle (${c.disc.w}x${c.disc.h} r=${c.disc.radius})`);
    assert.ok(d.l >= m.isl.l && d.r <= m.isl.r && d.t >= m.isl.t && d.b <= m.isl.b, `${tag}: ${c.id} disc inside the island`);
    assert.ok(c.l >= m.isl.l && c.r <= m.isl.r, `${tag}: ${c.id} zone inside the island horizontally`);
    assert.ok(Math.min(c.b, m.isl.b) - Math.max(c.t, m.isl.t) >= 30, `${tag}: ${c.id} zone mostly inside the island vertically`);
    assert.ok(d.t < m.isl.t + 30, `${tag}: ${c.id} sits in the header band`);
  }
  for (let i = 1; i < m.ctl.length; i++) assert.ok(Math.abs(disc(m.ctl[i]).l - disc(m.ctl[i - 1]).r - 12) <= 1, `${tag}: 12px between the discs of ${m.ctl[i - 1].id} and ${m.ctl[i].id} (${Math.round(disc(m.ctl[i]).l - disc(m.ctl[i - 1]).r)})`);
  for (let i = 1; i < m.ctl.length; i++) assert.ok(m.ctl[i].l >= m.ctl[i - 1].r - 0.5, `${tag}: neighbouring zones do not overlap`);
  assert.deepEqual(m.ctl.map(c => c.id), IDS, `${tag}: order Ajustes · Silenciar · Plegar`);
  assert.ok(m.ctl[0].l < m.ctl[1].l && m.ctl[1].l < m.ctl[2].l, `${tag}: left to right`);
  const sep = (a, b) => a.r <= b.l - 4 || b.r <= a.l - 4 || a.b <= b.t || b.b <= a.t;
  for (const [n, other] of [['title', m.title], ['clock', m.clock], ['bars', m.bars]]) if (other) for (const c of m.ctl) assert.ok(sep(disc(c), other), `${tag}: ${c.id} does not overlap the ${n}`);
}
(async () => {
  for (const theme of ['dark', 'light']) {
    for (const [name, sc, step] of SCENARIOS) {
      const r = await H.open({ ...sc, theme });
      try {
        await r.page.waitForTimeout(700);
        for (let i = 0; i < (step || 0); i++) { const bb = await (await r.page.$('#nusa-next')).boundingBox(); await r.page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2); await r.page.waitForTimeout(350); }
        const m = await measure(r.page);
        checkLayout(name, theme, m);
        const bad = await hitAll(r.page, m);
        assert.deepEqual(bad, [], `${theme}/${name}: every control receives its own click at the centre and at the edges of its zone`);
        // a long title (error / question) never reaches the controls
        const longM = await r.page.evaluate(() => { const t = document.getElementById('nusa-title'); const before = t.textContent; t.textContent = 'Se cortó la conexión con Pi y no sé cuánto va a tardar en volver a estar disponible'; const b = t.getBoundingClientRect(); const out = { r: b.right, w: b.width, ov: t.scrollWidth > t.clientWidth }; t.textContent = before; return out; });
        assert.ok(longM.r <= m.ctl[0].l - 2, `${theme}/${name}: a long title ends before the controls (${Math.round(longM.r)} vs ${Math.round(m.ctl[0].l)})`);
        if (name === 'inicio') {
          // REAL clicks do what the old island did; an untrusted click does nothing
          await r.page.evaluate(() => document.getElementById('open-settings').click());
          assert.equal(await r.page.evaluate(() => (window.__allCalls || []).filter(c => c.cmd === 'settings_window_action').length), 0, `${theme}: a synthetic click on Ajustes does nothing`);
          const click = async id => { const c = (await measure(r.page)).ctl.find(x => x.id === id); const d = disc(c); await r.page.mouse.click((d.l + d.r) / 2, (d.t + d.b) / 2); await r.page.waitForTimeout(250); };
          await click('open-settings');
          assert.deepEqual(await r.page.evaluate(() => (window.__allCalls || []).filter(c => c.cmd === 'settings_window_action').map(c => c.payload)), [{ action: 'open' }], `${theme}: Ajustes opens the window (settings_window_action open)`);
          await click('toggle-sound');
          assert.ok(await r.page.evaluate(() => (window.__allCalls || []).some(c => c.cmd === 'prefs_action' && c.payload && c.payload.action === 'sound_off')), `${theme}: Silenciar toggles the sound pref (prefs_action sound_off)`);
          await click('header-fold');
          assert.ok(await r.page.evaluate(() => (window.__desktopCalls || []).some(c => c.action === 'close')), `${theme}: Plegar collapses the island (desktop close)`);
        }
        console.log(`ok ${theme}/${name}`);
      } finally { await r.close(); }
    }
    // the chat view already had them: they stay reachable there
    const r = await H.open({ theme });
    try { await r.page.waitForTimeout(600); await r.page.evaluate(() => window.__islandSetView('chat', 720, 240)); await r.page.waitForTimeout(900);
      const m = await measure(r.page); assert.ok(m.ctl.every(c => !c.missing && c.visible), `${theme}/chat: the three controls stay visible in the chat view`);
      const bad = await r.page.evaluate(ids => ids.filter(id => { const e = document.getElementById(id), b = e.getBoundingClientRect(), t = document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2); return !(t === e || e.contains(t)); }), IDS);
      assert.deepEqual(bad, [], `${theme}/chat: not covered`);
    } finally { await r.close(); }
  }
  console.log('island-nusa-header-controls-check: ok');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
