'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname, '..', 'frontend', name), 'utf8');
function clock() {
  let id = 0;
  const jobs = new Map();
  return { jobs, setInterval(fn, ms) { const key = ++id; jobs.set(key, { fn, ms }); return key; }, clearInterval(key) { jobs.delete(key); } };
}
let failed = 0;
function test(name, fn) { try { fn(); console.log('PASS', name); } catch (e) { failed++; console.error('FAIL', name, e.message.split('\n')[0]); } }
test('notify expiry timer exists only for a pending question', () => {
  const src = read('notify.js');
  const body = src.match(/  let expiryTimer = null;[\s\S]*?\n  function syncExpiryTimer\(\) \{[\s\S]*?\n  \}/);
  assert.ok(body, 'notify timer lifecycle missing');
  const c = clock();
  const run = new Function('setInterval', 'clearInterval', 'N', `${body[0]}\nlet snapshot = null, paints = 0; function render() { paints++; syncExpiryTimer(); } return { apply(v) { snapshot = v; syncExpiryTimer(); }, paints: () => paints };`)(c.setInterval, c.clearInterval, { fromPending: v => v || null });
  run.apply({ pending: null }); assert.equal(c.jobs.size, 0);
  run.apply({ pending: { id: 'q', expiresAt: Date.now() + 60000 } }); assert.equal(c.jobs.size, 1);
  run.apply({ pending: { id: 'q', expiresAt: Date.now() + 60000 } }); assert.equal(c.jobs.size, 1);
  [...c.jobs.values()][0].fn(); assert.equal(run.paints(), 1);
  run.apply({ pending: null }); assert.equal(c.jobs.size, 0);
  run.apply({ pending: { id: 'next', expiresAt: Date.now() + 60000 } }); assert.equal(c.jobs.size, 1);
});
test('island countdown timer stops when no live card or notice remains', () => {
  const src = read('island.js');
  const body = src.match(/  function syncCountdownTimer\(\) \{[\s\S]*?\n  \}/);
  if (body) body[0] = 'let countdownTimer = null;\n' + body[0];
  assert.ok(body, 'card/notice timer lifecycle missing');
  const c = clock();
  const api = new Function('setInterval', 'clearInterval', `${body[0]}\nlet current = null; const O = {}; const validCard = c => !!c; const paintExpiry = () => {}; const paintBand = () => {}; const paintCompactFlag = () => {}; const refreshHost = () => {}; return { apply(v) { current = v; syncCountdownTimer(); } };`)(c.setInterval, c.clearInterval);
  api.apply({ notices: [] }); assert.equal(c.jobs.size, 0);
  api.apply({ card: { expires_at: new Date(Date.now() + 60000).toISOString() }, notices: [] }); assert.equal(c.jobs.size, 1);
  api.apply({ notices: [{ expiresAt: Date.now() + 60000 }] }); assert.equal(c.jobs.size, 1);
  api.apply({ notices: [{ expiresAt: Date.now() - 1 }] }); assert.equal(c.jobs.size, 0);
  api.apply({ card: { expires_at: new Date(Date.now() - 1).toISOString() } }); assert.equal(c.jobs.size, 0);
});
test('sessions polling pauses hidden/compact and resumes without overlap', () => {
  const src = read('sessions-ticker.js');
  const body = src.slice(src.indexOf('  let timer = null;'), src.lastIndexOf('\n}'));
  const c = clock(), events = {}, capsule = { dataset: { phase: 'compact' } };
  let changed, asks = 0;
  const document = { hidden: false, getElementById: () => capsule, addEventListener: (n, f) => { events[n] = f; } };
  class Observer { constructor(f) { changed = f; } observe() {} }
  new Function('document', 'MutationObserver', 'setInterval', 'clearInterval', 'invoke', 'show', 'V', 'toFrame', 'POLL_MS', body)(document, Observer, c.setInterval, c.clearInterval, () => { asks++; return new Promise(() => {}); }, () => {}, { requestSessions: invoke => invoke('agent_action', { payload: { action: 'view' } }) }, () => {}, 2000);
  assert.equal(c.jobs.size, 0, 'compact boot must not poll'); assert.equal(asks, 0);
  capsule.dataset.phase = 'expanded'; changed(); assert.equal(c.jobs.size, 1); assert.equal(asks, 1);
  changed(); [...c.jobs.values()][0].fn(); assert.equal(asks, 1, 'only one in flight');
  document.hidden = true; events.visibilitychange(); assert.equal(c.jobs.size, 0);
  document.hidden = false; events.visibilitychange(); assert.equal(c.jobs.size, 1);
  capsule.dataset.phase = 'compact'; changed(); assert.equal(c.jobs.size, 0);
});
if (failed) process.exitCode = 1;
