'use strict';
/* S10 slice 4: the pure Coucou island modules vendored for Abito (core/anim, core/diff, views/icons,
   views/ticker). Behaviour of the pure parts; the views are only imported (no DOM here). */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const vendor = path.join(__dirname, '..', 'frontend/vendor/coucou');
const imp = f => import(pathToFileURL(path.join(vendor, f)));
(async () => {
  for (const f of ['views/icons', 'core/anim', 'core/diff', 'views/ticker']) {
    const head = fs.readFileSync(path.join(vendor, `${f}.ts`), 'utf8').split('\n')[0];
    assert.match(head, /@434d6a2b — Copyright \(c\) 2026 Louis Raillé, MIT$/, f);
    assert.ok(fs.existsSync(path.join(vendor, `${f}.js`)), `${f}.js built`);
  }
  const D = await imp('core/diff.js');
  const e = D.fromEdit('a\nb\nc\n', 'a\nB\nc\nd\n', '/p/x.js');
  assert.deepEqual([e.added, e.removed, e.tooLarge, e.isNewFile], [2, 1, false, false]);
  assert.equal(D.fileName('/p/x.js'), 'x.js');
  const n = D.fromNew('one\ntwo\n', '/p/n.txt');
  assert.deepEqual([n.added, n.removed, n.isNewFile], [2, 0, true]);
  const step = D.makeDiffStep('x.js', 2, 1, 7);
  assert.deepEqual(D.parseDiffStep(step), { filename: 'x.js', added: 2, removed: 1, diffId: 7 });
  assert.equal(D.parseDiffStep('plain text'), null);
  assert.equal(D.lastTextStep(['hi', step]), 'hi');
  assert.equal(D.fromEdit('x'.repeat(D.DIFF_MAX_BYTES), 'y', '/p/big').hunks.length, 0, 'size guard: count only');
  const A = await imp('core/anim.js');
  assert.equal(A.clamp(5, 0, 1), 1); assert.equal(A.lerp(0, 10, 0.5), 5);
  const ease = A.cubicBezier(0.45, 0, 0.2, 1);
  assert.ok(Math.abs(ease(0)) < 1e-6 && Math.abs(ease(1) - 1) < 1e-6 && ease(0.5) > 0.4 && ease(0.5) < 0.9);
  const { ICONS } = await imp('views/icons.js');
  for (const k of ['house', 'bubble', 'gear', 'arrowUpRight', 'chevronUp', 'check', 'xmark', 'bang']) assert.ok(ICONS[k], `icon ${k}`);
  const T = await imp('views/ticker.js'); assert.equal(typeof T.Ticker, 'function');
  const { t, tl } = await imp('i18n/i18n.js');
  for (const k of ['Back', 'Open in VS Code', 'Diff too large', 'No changes']) assert.ok(t(k) && t(k) !== k, k);
  assert.equal(String(tl('Back')), 'Volver');
  console.log('PASS coucou-views');
})().catch(err => { console.error('FAIL', err.stack); process.exit(1); });
