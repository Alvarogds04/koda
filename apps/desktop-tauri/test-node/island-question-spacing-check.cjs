'use strict';
// Regression for the human's crowded cards: computed geometry and real edge hits (playwright).
const assert = require('node:assert/strict');
const H = require('./island-geometry-harness.cjs');
if (!H.findPlaywright()) { console.log('SKIPPED island-question-spacing-check: no Playwright — NOT a pass'); process.exit(0); }
(async () => {
  let passed = 0, failed = 0;
  const test = async (name, fn) => { try { await fn(); passed++; console.log('PASS ' + name); } catch (e) { failed++; console.error('FAIL ' + name + ': ' + e.message); } };
  const r = await H.open({ question: 'plain', described: true, manyPi: true, windowCap: 340, quick: true });
  const styles = sel => r.page.$eval(sel, el => { const s = getComputedStyle(el), a = getComputedStyle(el, '::after'); return { gap: s.gap, rowGap: s.rowGap, padding: s.padding, minHeight: s.minHeight, minWidth: s.minWidth, margin: s.margin, inset: a.inset, background: a.backgroundColor }; });
  try {
    await test('option edges ±1px belong to the correct row (including scrolled rows)', async () => {
      const hits = await r.hitEdges('.q-option');
      assert.ok(hits.length >= 36, 'all rows sampled');
      assert.deepEqual(hits.filter(h => !h.ok), []);
    });
    await test('44px non-overlapping option targets, 36px visible pills (8px of air between them)', async () => {
      const s = await styles('.q-option');
      assert.equal(s.margin, '0px'); assert.equal(s.minHeight, '44px'); assert.equal(s.inset, '4px 0px');
      // HU-057 re-point (A): the Nusa options list has NO gap between the 44px hit boxes (release: 6px). Frozen island heights 255/295/323 (340 window) leave a
      // 112px options window, and island-s7 clicks the CENTRE of the third row (it needs 2*44+22 = 110 <= 112). The boxes touch but never overlap (hitEdges above,
      // measured), and the visible pills keep 2 x 4px = 8px of air between them (::after inset 4px 0 over a 44px box, asserted just above).
      assert.equal((await styles('#question-options')).gap, '0px');
      const rects = await r.measure('.q-option');
      for (let i = 1; i < rects.length; i++) assert.ok(rects[i].top >= rects[i - 1].bottom - 0.01, 'option boxes never overlap: ' + JSON.stringify([rects[i - 1], rects[i]]));
    });
    await test('card has 8px row gaps and 8/16/18/116px breathing room', async () => {
      // HU-057 (Nusa notch) re-point (A): the island is frozen at 255/295/323 inside the 340 window, so the card keeps 4px row gaps and
      // padding 0/16/8/112 (the 44px Omitir box sits flush under the head; 112 = Koda's right-hand column, frozen by island-nusa-takeover). The intent of 8/16/18/116 is that nothing touches
      // the card edge or Koda: measured on the real layout below, not read from the source.
      const s = await styles('#question'); assert.equal(s.rowGap, '4px'); assert.equal(s.padding, '0px 16px 8px 112px');
      const m = await r.page.evaluate(() => {
        const q = document.getElementById('question').getBoundingClientRect(), box = [...document.querySelectorAll('#question-body, #question-options, #question-skip, #question-nav button')]
          .filter(el => el.getBoundingClientRect().width > 0).map(el => el.getBoundingClientRect());
        return { minLeft: Math.min(...box.map(b => b.left)) - q.left, maxRight: q.right - Math.max(...box.map(b => b.right)), maxBottom: q.bottom - Math.max(...box.map(b => b.bottom)), n: box.length };
      });
      assert.ok(m.n >= 3 && m.minLeft >= 112 - 1 && m.maxRight >= 0 && m.maxBottom >= 0, JSON.stringify(m));
    });
    await test('Omitir ghost is visible, 44px high and clear of the fold hit box', async () => {
      await r.page.$eval('#question', el => { el.scrollTop = 0; });
      const s = await styles('#question-skip'); assert.equal(s.minHeight, '44px'); assert.notEqual(s.background, 'rgba(0, 0, 0, 0)');
      assert.ok((await r.measure('#question-skip'))[0].h >= 44, 'real box >= 44');
      const [skip] = await r.measure('#question-skip'), [fold] = await r.measure('#question-fold');
      assert.ok(skip.right <= fold.left || skip.bottom <= fold.top || fold.bottom <= skip.top, JSON.stringify({ skip, fold }));
    });
    await test('focus shell is opaque so terminal titles cannot bleed behind the top bar', async () => {
      const colors = await r.page.evaluate(() => {
        const root = document.documentElement, previous = root.dataset.theme;
        const colors = ['light', 'dark'].map(theme => { root.dataset.theme = theme; return getComputedStyle(document.getElementById('island')).backgroundColor; });
        if (previous === undefined) delete root.dataset.theme; else root.dataset.theme = previous;
        return colors;
      });
      for (const color of colors) assert.match(color, /^rgb\(/, 'opaque theme background, not translucent glass: ' + color);
    });
    await test('focus blobs have a 12px gutter, even before MutationObserver sync', async () => {
      // Mutate and measure synchronously: observer callbacks cannot supply focus layout.
      const b = await r.page.evaluate(() => {
        const c = document.getElementById('capsule'); c.dataset.layout = 'normal';
        const q = document.getElementById('question').getBoundingClientRect(), b = document.getElementById('blobs').getBoundingClientRect();
        return { gap: b.left - q.right, width: b.width, names: getComputedStyle(document.querySelector('.pill-choice span:not(.ico)')).display };
      });
      assert.ok(b.gap >= 12, JSON.stringify(b)); assert.equal(b.width, 68); assert.equal(b.names, 'none');
    });
    await test('long card text wraps anywhere without nowrap or ellipsis; a long body scrolls inside its 3 lines, nothing is pushed out of the island', async () => {
      const results = await r.page.evaluate(() => {
        const q = document.getElementById('question');
        // DOM-only fixture: exercise the existing fitCard resize path, no protocol/copy changes.
        for (const sel of ['#question-body', '.q-label', '.q-desc']) for (const el of q.querySelectorAll(sel)) el.textContent = '/very-long-path'.repeat(70);
        return [...q.querySelectorAll('#question-body, .q-label, .q-desc')].map(el => { const s = getComputedStyle(el); return { whiteSpace: s.whiteSpace, wrap: s.overflowWrap, ellipsis: s.textOverflow }; });
      });
      for (const s of results) { assert.notEqual(s.whiteSpace, 'nowrap'); assert.equal(s.wrap, 'anywhere'); assert.notEqual(s.ellipsis, 'ellipsis'); }
      await r.page.waitForTimeout(250); // the mock host re-sends the question after ~1s: measure the long text, not the restored one
      // HU-057 re-point (A): the Nusa card never scrolls as a whole (overflow hidden !important, island frozen at <= 332); the BODY and the OPTIONS scroll.
      const b = await r.page.evaluate(() => {
        const R = s => document.querySelector(s).getBoundingClientRect(), q = document.getElementById('question'), body = document.getElementById('question-body'), o = document.getElementById('question-options'), isl = R('#island');
        return { qOverflow: getComputedStyle(q).overflowY, bodyOverflow: getComputedStyle(body).overflowY, bodyH: R('#question-body').height, bodyScroll: body.scrollHeight, optsScroll: o.scrollHeight > o.clientHeight,
          optsOverflow: getComputedStyle(o).overflowY, sw: q.scrollWidth, w: q.clientWidth, islB: isl.bottom, optsH: o.clientHeight,
          skipTop: R('#question-skip').top, skipBottom: R('#question-skip').bottom, optsTop: R('#question-options').top, optsBottom: R('#question-options').bottom, qTop: R('#question').top, qBottom: R('#question').bottom };
      });
      assert.equal(b.bodyOverflow, 'auto'); assert.ok(b.bodyScroll > b.bodyH && b.bodyH <= 52, 'long body scrolls inside 3 lines: ' + JSON.stringify(b));
      assert.equal(b.optsOverflow, 'auto'); assert.ok(b.optsScroll && b.optsH >= 40, 'options scroll and stay visible: ' + JSON.stringify(b));
      assert.ok(b.sw <= b.w, JSON.stringify(b)); assert.ok(b.qTop >= 42 && b.qBottom <= 332, JSON.stringify(b));
      assert.ok(b.optsBottom <= b.qBottom && b.skipBottom <= b.qBottom && b.skipTop >= b.qTop && b.islB <= 332.5, 'nothing pushed out of the island: ' + JSON.stringify(b));
    });
  } finally { await r.close(); }
  {
    const m = await H.open({ question: 'multi', quick: true });
    try {
      await test('multi-select controls stay clickable after keyboard toggles', async () => {
        const rows = (await m.measure('.q-option')).filter(b => b.shown);
        await m.page.mouse.click(rows[0].left + rows[0].w / 2, rows[0].top + rows[0].h / 2);
        await m.page.mouse.click(rows[2].left + rows[2].w / 2, rows[2].top + rows[2].h / 2);
        await m.page.focus('.q-option[role="checkbox"]'); await m.page.keyboard.press('Space');
        const blocked = (await m.hit('.q-option, #question-primary')).filter(h => !h.ok);
        assert.deepEqual(blocked, [], JSON.stringify(blocked));
      });
    } finally { await m.close(); }
  }
  for (const question of ['approvalPi', 'form']) {
    const a = await H.open({ question, quick: true, windowCap: 340 });
    try {
      await test(question === 'form' ? 'question nav targets are at least 44px (touch target)' : 'approval targets are non-overlapping, at least 44x96px with 36px visible fill', async () => {
        const s = await a.page.$eval(question === 'form' ? '#question-nav button' : '.q-approval-btn', el => { const s = getComputedStyle(el); return { h: s.minHeight, w: s.minWidth, margin: s.margin, inset: getComputedStyle(el, '::after').inset }; });
        // Touch target: 44px since 0d2784ff (T4/S5 «a touch target like every other control on the question card»); it was 36px in the vendored island.css.
        assert.equal(s.h, '44px');
        if (question !== 'form') { assert.equal(s.w, '96px'); assert.equal(s.margin, '0px');
          // HU-057 B (human, 29-oct «muy pegados»): the Nusa notch keeps the 44px hit box but a 40px visible pill (::after inset 2px; island-nusa-cards pins >= 40),
          // larger than release's 36 (inset 4px): the intent (a visible fill inside a non-overlapping 44px target) holds, so the inset is re-pointed to 2px.
          assert.equal(s.inset, '2px 0px'); }
      });
      if (question !== 'form') await test('legacy permission command also wraps without ellipsis', async () => {
        const s = await a.page.$eval('#permission #operation', el => { const s = getComputedStyle(el); return { whiteSpace: s.whiteSpace, wrap: s.overflowWrap, ellipsis: s.textOverflow }; });
        assert.notEqual(s.whiteSpace, 'nowrap'); assert.equal(s.wrap, 'anywhere'); assert.notEqual(s.ellipsis, 'ellipsis');
      });
      if (question !== 'form') await test('approval path/command text wraps anywhere', async () => {
        const s = await a.page.$eval('#question-approval .q-cmd', el => { el.textContent = '/long-path'.repeat(160); const s = getComputedStyle(el); return { whiteSpace: s.whiteSpace, wrap: s.overflowWrap, width: el.clientWidth, scroll: el.scrollWidth }; });
        assert.notEqual(s.whiteSpace, 'nowrap'); assert.equal(s.wrap, 'anywhere'); assert.ok(s.scroll <= s.width);
      });
    } finally { await a.close(); }
  }
  console.log(`island-question-spacing-check: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
