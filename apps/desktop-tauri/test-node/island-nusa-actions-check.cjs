'use strict';
/* HU-063 T4 (S3): in every Nusa take-over state (permission, finished, error notice, engine band) NO legacy action is lost or covered:
   each interactive control present has document.elementFromPoint at its centre = the control or a child. Also: the finished veil takes the
   notice agent's colour (--agent-notice), waiting/error keep --sun / --red-11, and Koda is big at the LEFT of the card. Real layout, Playwright. */
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-nusa-actions-check: no playwright — NOT a pass'); process.exit(0); }
const CONTROLS = 'button, a[href], input, textarea, select, [role="button"], [tabindex="0"]';
// controls that are legitimately the notch's own chrome (tabs/arrows live under the veil in a take-over and are hidden)
// Koda sits BIG on the island's LEFT (human, 29-oct), inside the island, integer scale of the 32px cell (k>=3 in a take-over), intersecting no visible control
function kodaLeft(st, c, name, minK = 3) {
  const k = st.koda; assert.ok(k, `${name}: Koda present`);
  assert.ok(k.left >= 0 && k.right <= k.mid && k.t >= k.it && k.b <= k.it + k.ih, `${name}: Koda sits in the left half of the island: ${JSON.stringify(k)}`);
  assert.ok(k.w === k.h && k.w % 32 === 0 && k.w / 32 >= minK, `${name}: Koda is an integer multiple of 32 (k>=${minK}): ${k.w}x${k.h}`);
  const hit = c.filter(x => x.box && x.box.l < k.r && x.box.r > k.l && x.box.t < k.b && x.box.b > k.t).map(x => x.text);
  assert.deepEqual(hit, [], `${name}: Koda box intersects controls`);
}
async function controls(r, within) {
  return r.page.evaluate(({ sel, within }) => [...document.querySelectorAll(sel)].filter(el => {
    if (!el.closest(within)) return false;
    const b = el.getBoundingClientRect(), s = getComputedStyle(el);
    return b.width > 0 && b.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && +s.opacity > 0 && !el.disabled && !el.closest('[hidden], [inert]');
  }).map(el => {
    const b = el.getBoundingClientRect(), x = b.left + b.width / 2, y = b.top + b.height / 2, top = document.elementFromPoint(x, y);
    return { id: el.id || (el.textContent || '').trim().slice(0, 20) || el.className, text: (el.textContent || '').trim(), box: { l: b.left, r: b.right, t: b.top, b: b.bottom }, ok: !!top && (top === el || el.contains(top)), got: top ? (top.id || top.className || top.tagName) : null };
  }), { sel: CONTROLS, within });
}
const state = r => r.page.evaluate(() => ({ take: document.getElementById('capsule').dataset.takeover || null, veil: document.getElementById('nusa').style.getPropertyValue('--veil'),
  agent: document.getElementById('nusa').style.getPropertyValue('--agent-notice'),
  koda: (() => { const k = document.querySelector('.koda-sprite[data-koda-slot="nusa"]'); if (!k) return null; const b = k.getBoundingClientRect(), i = document.getElementById('island').getBoundingClientRect(); return { left: b.left - i.left, right: b.right - i.left, l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, h: b.height, mid: i.width / 2, iw: i.width, ih: i.height, it: i.top }; })() }));
const covered = list => list.filter(c => !c.ok);
(async () => {
  {
    const r = await H.open({ question: 'approvalPi' });
    try {
      const st = await state(r); assert.equal(st.take, 'waiting');
      const c = await controls(r, '#question'); const words = c.map(x => x.text);
      assert.ok(words.some(w => /Aprobar/.test(w)) && words.some(w => /Rechazar/.test(w)) && words.some(w => /Omitir/.test(w)), `permission: Aprobar/Rechazar/Omitir present: ${JSON.stringify(words)}`);
      assert.deepEqual(covered(c), [], 'permission: no control covered'); kodaLeft(await state(r), c, 'permission');
      assert.equal(st.veil.trim(), 'var(--sun)', 'waiting keeps --sun');
      await r.page.waitForTimeout(500); assert.equal(await r.page.evaluate(() => window.__koda.current), 'espera', 'permission: Koda waits');
      await r.screenshot('/tmp/nusa-t4-permission.png');
    } finally { await r.close(); }
  }
  for (const [agent, hex] of [['pi', '#2dffac'], ['claude-code', '#b04dff'], ['codex', '#f472b6']]) {
    const r = await H.open({ finishedCard: agent, sessions: [], quick: true });
    try {
      const st = await state(r); assert.equal(st.take, 'finished', 'finished takeover');
      const c = await controls(r, '#notices'); const words = c.map(x => x.text);
      assert.ok(words.some(w => /^Ver$/.test(w)) && words.some(w => /^OK$/.test(w)), `finished: Ver + OK present: ${JSON.stringify(words)}`);
      assert.deepEqual(covered(c), [], 'finished: no control covered');
      assert.equal(st.agent.trim(), hex, `--agent-notice = ${agent} colour`);
      assert.equal(st.veil.trim(), hex, 'finished veil takes the agent colour');
      kodaLeft(st, c, 'finished');
      assert.equal(await r.page.evaluate(() => window.__koda.current), 'termino', 'finished: Koda neutral «termino», never feliz');
      if (agent === 'pi') await r.screenshot('/tmp/nusa-t4-finished.png');
    } finally { await r.close(); }
  }
  {
    const r = await H.open({ noticeRows: [{ id: '0b3a5c9e-8f27-4d11-9a0e-1c2d3e4f5a6b', title: 'Pi falló', detail: 'Error al compilar', severity: 'error', kind: 'settled', expiresAt: Date.now() + 600000, agent: 'codex', projectName: 'api' }], sessions: [], quick: true });
    try {
      await r.page.evaluate(() => window.__emit('desktop:notice-open', { id: '0b3a5c9e-8f27-4d11-9a0e-1c2d3e4f5a6b', kind: 'finished' })); await r.page.waitForTimeout(1500);
      const st = await state(r); assert.equal(st.take, 'error', 'error takeover');
      const c = await controls(r, '#notices'); assert.ok(c.length >= 2, `error notice keeps its controls: ${JSON.stringify(c.map(x => x.text))}`);
      assert.deepEqual(covered(c), [], 'error: no control covered'); kodaLeft(st, c, 'error');
      assert.equal(st.veil.trim(), 'var(--red-11)', 'error ignores the agent colour');
      // KNOWN GAP (needs koda-*.js, not editable here): an error NOTICE leaves Koda on «termino»; koda-logic.choose() has no notice-severity input.
      await r.screenshot('/tmp/nusa-t4-error.png');
    } finally { await r.close(); }
  }
  {
    const r = await H.open({ engine: 'down' });
    try {
      const c = await controls(r, '#engine-band'); const words = c.map(x => x.text);
      assert.deepEqual(words.sort(), ['Omitir', 'Revisar'], 'engine band: Revisar + Omitir');
      assert.deepEqual(covered(c), [], 'engine band: no control covered');
      const ik = await r.page.evaluate(() => { const k = document.querySelector('.koda-sprite[data-koda-slot="nusa"]'); const b = k && k.getBoundingClientRect(), i = document.getElementById('island').getBoundingClientRect(); return b && { w: b.width, h: b.height, right: b.left > i.left + i.width / 2 }; });
      assert.deepEqual(ik, { w: 64, h: 64, right: true }, 'Inicio keeps Koda k=2 on the right');
      await r.page.waitForTimeout(500); assert.equal(await r.page.evaluate(() => window.__koda.current), 'error', 'engine band: Koda error');
      await r.screenshot('/tmp/nusa-t4-engine.png');
    } finally { await r.close(); }
  }
  console.log('island-nusa-actions-check: ok');
})().catch(e => { console.error('FAIL', e.message, e.actual, e.expected); process.exit(1); });
