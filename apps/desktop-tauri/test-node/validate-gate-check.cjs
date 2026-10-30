'use strict';
const assert = require('node:assert/strict');
const { allowPreview, gate } = require('../packaging/preview.cjs');
(async () => {
  for (const status of [1, 2, null, undefined, '0', -1]) {
    assert.equal(allowPreview(status), false);
    let staged = false;
    assert.notEqual(await gate(async () => status, async () => { staged = true; }), 0);
    assert.equal(staged, false, 'failure must never stage');
  }
  assert.equal(allowPreview(0), true);
  const events = [];
  assert.equal(await gate(async () => { events.push('validate'); return 0; }, async () => events.push('stage')), 0);
  assert.deepEqual(events, ['validate', 'stage']);
  await assert.rejects(() => gate(async () => { throw Error('validator'); }, async () => assert.fail('staged')), /validator/);
  console.log('validate-gate: pass decision = validate → stage; six forced-fail statuses never stage; thrown validator never stages');
})().catch(e => { console.error(e); process.exitCode = 1; });
