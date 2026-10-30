'use strict';
// Real playwright layout: the bounded runner must allow Chromium's virtual address space.
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED avisos-interaction: no real layout engine — NOT a pass'); process.exit(0); }
const id = '3f2b8a40-1c2d-4e5f-8a6b-7c8d9e0f1a2b';
const second = '4f2b8a40-1c2d-4e5f-8a6b-7c8d9e0f1a2b';
const notice = (id, kind, title) => ({id,kind,title,detail:'Resultado',severity:'info',at:Date.now(),expiresAt:Date.now()+600000});
(async () => {
  for (const theme of ['light','dark']) {
    const r = await H.open({theme, noticeRows:[notice('transport-1','transport','Conexión caída')], quick:true});
    try {
      assert.equal(await r.page.locator('#notice-title').textContent(), 'Avisos · 1');
      const fits = await r.page.locator('#notice-title').evaluate(el => el.scrollWidth <= el.clientWidth + 1);
      assert.equal(fits,true,'bell + count must fit the entry');
      await r.page.locator('#notice-open').click();
      assert.equal(await r.page.locator('#notice-list-title').textContent(),'Avisos · 1');
      const surface = await r.page.locator('#notices').evaluate(el => {
        const b = el.getBoundingClientRect();
        const hits = [0.1, 0.5, 0.9].flatMap(x => [0.2, 0.5, 0.8].map(y => {
          const hit = document.elementFromPoint(b.left + b.width * x, b.top + b.height * y);
          return !!hit && el.contains(hit);
        }));
        return { background: getComputedStyle(el).backgroundColor, hits };
      });
      assert.ok(!/rgba\(|transparent|\/\s*0?\./.test(surface.background), `list must be opaque: ${surface.background}`);
      assert.ok(surface.hits.every(Boolean), 'list surface wins hit testing over selector siblings');
      // A stale custom tooltip is pointer-transparent: hit testing alone cannot detect its paint.
      await r.page.evaluate(() => {
        const tip = document.getElementById('island-tip');
        if (tip) { tip.hidden = false; tip.textContent = 'un momento'; }
      });
      assert.equal(await r.page.locator('#island-tip').isVisible(), false, 'project tooltip cannot paint over the open list');
      assert.equal(await r.page.locator('.notice-list-row button').count(),1,'transport only offers dismiss');
      await r.page.locator('.notice-list-dismiss').click();
      assert.equal(await r.page.locator('#notice-list').isVisible(),false,'last dismissal closes the list');
    } finally { await r.close(); }
  }
  const identity = await H.open({noticeRows: ['repo', 'api'].map((projectName, i) => ({
    ...notice(i ? second : id, 'settled', 'Codex terminó'), projectName, agent: 'codex',
  })), quick:true});
  try {
    await identity.page.locator('#notice-action').click();
    const rows = identity.page.locator('.notice-list-row');
    assert.match(await rows.nth(0).textContent(), /repo/);
    assert.match(await rows.nth(1).textContent(), /api/);
    assert.notEqual(await rows.nth(0).textContent(), await rows.nth(1).textContent());
    for (const row of await rows.all()) {
      const layout = await row.evaluate(el => {
        const title = el.querySelector('.notice-list-title').getBoundingClientRect();
        const meta = el.querySelector('.notice-list-time').getBoundingClientRect();
        return { height: el.getBoundingClientRect().height, separated: title.bottom <= meta.top, fits: el.scrollWidth <= el.clientWidth + 1 };
      });
      assert.ok(layout.height >= 44 && layout.separated && layout.fits, 'stacked identity never overlaps title');
    }
  } finally { await identity.close(); }
  const long = 'Codex terminó: ' + 'resultado largo que pasa a la línea siguiente '.repeat(3);
  const r = await H.open({noticeRows:[notice(id,'settled','Pi terminó su turno'),notice(second,'settled',long),notice('transport-2','transport','Conexión caída')],quick:true});
  try {
    await r.page.locator('#notice-action').click();
    const target = r.page.locator('button.notice-list-open').nth(1);
    await target.scrollIntoViewIfNeeded();
    const text = await target.evaluate(el => ({wraps:getComputedStyle(el).whiteSpace, fits:el.scrollWidth<=el.clientWidth+1}));
    assert.equal(text.wraps,'normal'); assert.equal(text.fits,true);
    assert.deepEqual((await r.hitEdges('button.notice-list-open')).filter(h => !h.ok), [], 'row body edges never hit their neighbour or dismiss');
    await target.click();
    let calls = await r.page.evaluate(() => window.__desktopCalls);
    assert.deepEqual(calls.filter(x=>x.action==='click'),[{action:'click',id:second,kind:'finished'}],'click selects the second UUID, never the first');
    await r.page.locator('.notice-list-dismiss').nth(2).click();
    calls = await r.page.evaluate(() => window.__desktopCalls);
    assert.equal(calls.filter(x=>x.action==='click').length,1,'dismiss does not open any detail');
    assert.equal(await r.page.locator('.notice-list-row').count(),2);
    await r.page.locator('#notice-clear').click();
    await r.page.waitForTimeout(100);
    assert.equal(await r.page.locator('#notice-list').isVisible(),false);
  } finally { await r.close(); }
  console.log('PASS avisos-interaction: single transport in light/dark, readable count, wrap, exact UUID click, exact dismiss and clear-all');
})().catch(e => {console.error(e);process.exitCode=1;});
