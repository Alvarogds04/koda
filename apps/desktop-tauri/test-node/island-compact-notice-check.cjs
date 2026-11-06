'use strict';
// HU-006 S4-S6 in a real browser: a notice arriving while the island is compact shows INSIDE the compact pill and the
// island does not grow; expanded keeps today's behaviour; opening is the human's own press on the pill.
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');

const NOTICE = { id: 'n-hu006', title: 'Pi terminó su turno', detail: 'Listo', severity: 'info', kind: 'settled', expiresAt: Date.now() + 600000, agent: 'pi', projectName: 'workspace' };
const state = (s, notices) => ({ state: s, notices, card: null, request: null, revision: Date.now(), motionOverride: false, unavailable: false, connections: 1 });

(async () => {
  const ui = await H.open({ quick: true, sessions: [] });
  if (!ui) { console.log('SKIP island-compact-notice: playwright unavailable'); return; }
  const { page } = ui;
  try {
    // rest compact with an empty notice list (the baseline: boot rows are never arrivals)
    await page.evaluate(s => { window.__islandSetState('compact'); window.__emit('desktop:state', s); }, state('compact', []));
    await page.waitForTimeout(900);
    const before = await page.evaluate(() => ({ w: document.getElementById('island').getBoundingClientRect().width, h: document.getElementById('island').getBoundingClientRect().height, phase: document.getElementById('capsule').dataset.phase }));
    assert.equal(before.phase, 'compact');
    await page.evaluate(() => { window.__desktopCalls = []; });
    // S4: a new finished notice while compact
    await page.evaluate(s => window.__emit('desktop:state', s), state('compact', [NOTICE]));
    await page.waitForTimeout(1200);
    const after = await page.evaluate(() => ({
      calls: (window.__desktopCalls || []).map(c => c.action),
      phase: document.getElementById('capsule').dataset.phase,
      w: document.getElementById('island').getBoundingClientRect().width, h: document.getElementById('island').getBoundingClientRect().height,
      activity: document.getElementById('compact-activity').textContent,
      shown: getComputedStyle(document.getElementById('compact-activity')).display !== 'none',
      badge: document.getElementById('compact-badge').dataset.kind, badgeHidden: document.getElementById('compact-badge').hidden,
    }));
    assert.ok(!after.calls.includes('expand'), `S4: no automatic expand (${after.calls})`);
    assert.equal(after.phase, 'compact', 'S4: still compact');
    // island-free-drag S3/S5: compact is the DISC (40x32) in every state — a notice never widens it and never draws its text; the
    // disc carries the notice as its own state signal (--pill-dot tone) and the text is read when the human opens the island.
    assert.deepEqual([after.w, after.h], [40, 32], `S3: the disc, unchanged (${after.w}x${after.h})`);
    assert.equal(after.activity, '', 'S3: no compact text line');
    assert.equal(after.shown, false, 'S3: and it is never drawn');
    assert.deepEqual([after.badge, after.badgeHidden], ['finished', false], 'S5: the model still publishes the signal kind');
    // S6 + S3: the human's own press on the DISC opens it, through the same host verb (a click, under the 6 px move threshold)
    const box = await page.evaluate(() => { const b = document.getElementById('island').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
    await page.mouse.click(box.x, box.y);
    await page.waitForTimeout(300);
    assert.ok((await page.evaluate(() => (window.__desktopCalls || []).map(c => c.action))).includes('expand'), 'S6: the press expands');
    // S5: expanded behaves as today: a new notice opens the Avisos lane without any host expand
    await page.evaluate(() => window.__islandSetState('overview'));
    await page.evaluate(s => window.__emit('desktop:state', s), state('expanded', [NOTICE]));
    await page.waitForTimeout(1500);
    await page.evaluate(() => { window.__desktopCalls = []; });
    const second = { ...NOTICE, id: 'n-hu006-b', title: 'Codex terminó' };
    await page.evaluate(s => window.__emit('desktop:state', s), state('expanded', [second, NOTICE]));
    await page.waitForTimeout(1200);
    const open = await page.evaluate(() => ({ view: document.getElementById('capsule').dataset.view, phase: document.getElementById('capsule').dataset.phase, calls: (window.__desktopCalls || []).map(c => c.action) }));
    assert.deepEqual([open.phase, open.view], ['expanded', 'notices'], 'S5: the expanded island shows the notice as today');
    assert.ok(!open.calls.includes('expand'));
    console.log('PASS island-compact-notice: compact stays compact with the notice inside; press opens; expanded unchanged');
  } finally { await ui.close(); }
})().catch(e => { console.error('FAIL island-compact-notice:', e.message); process.exitCode = 1; });
