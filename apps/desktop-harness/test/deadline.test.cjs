'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeDeadline } = require('../src/deadline.cjs');

test('boundaries', () => {
  assert.deepEqual(computeDeadline({ cliTimeoutMs: 34999 }), { mode: 'notice-only' });
  assert.deepEqual(computeDeadline({ cliTimeoutMs: 35000 }), { mode: 'ask', timeoutMs: 30000 });
  assert.deepEqual(computeDeadline({ cliTimeoutMs: 100000 }), { mode: 'ask', timeoutMs: 95000 });
  assert.deepEqual(computeDeadline({ cliTimeoutMs: 305000 }), { mode: 'ask', timeoutMs: 300000 });
  assert.deepEqual(computeDeadline({ cliTimeoutMs: 400000 }), { mode: 'ask', timeoutMs: 300000 });
  assert.deepEqual(computeDeadline({ cliTimeoutMs: 2e6, maxMs: 2e6, marginMs: 1000 }), { mode: 'ask', timeoutMs: 900000 });
});
test('invalid input is notice-only', () => {
  for (const cliTimeoutMs of [NaN, -1, 0, Infinity, '400000', null, undefined, 40000.5]) {
    assert.deepEqual(computeDeadline({ cliTimeoutMs }), { mode: 'notice-only' }, String(cliTimeoutMs));
  }
  assert.deepEqual(computeDeadline({ cliTimeoutMs: 400000, maxMs: 10000 }), { mode: 'notice-only' });
  assert.deepEqual(computeDeadline(undefined), { mode: 'notice-only' });
});

test('marginMs is clamped to >= 1000', () => {
  assert.deepEqual(computeDeadline({ cliTimeoutMs: 31000, marginMs: 0 }), { mode: 'ask', timeoutMs: 30000 });
  assert.deepEqual(computeDeadline({ cliTimeoutMs: 30999, marginMs: 0 }), { mode: 'notice-only' });
  assert.deepEqual(computeDeadline({ cliTimeoutMs: 31000, marginMs: -5 }), { mode: 'ask', timeoutMs: 30000 });
  assert.deepEqual(computeDeadline({ cliTimeoutMs: 100000, marginMs: 999 }), { mode: 'ask', timeoutMs: 99000 });
  assert.deepEqual(computeDeadline({ cliTimeoutMs: 100000, marginMs: 'x' }), { mode: 'notice-only' });
});
