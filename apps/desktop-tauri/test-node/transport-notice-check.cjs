'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const O = require('../frontend/overview-view.js');
const NV = require('../frontend/notify-view.js');
const transport = { id: 'transport-1', kind: 'transport', severity: 'error', title: 'Conexión caída', at: 100000, expiresAt: Number.MAX_SAFE_INTEGER };
const real = { ...transport, id: '12345678-1234-4abc-8abc-123456789abc', kind: 'settled', severity: 'info' };
let failed = 0;
function test(name, fn) { try { fn(); console.log('PASS ' + name); } catch (e) { failed++; console.error('FAIL ' + name + ': ' + e.message); } }
test('transport band opens the inbox, never a dead Abrir action', () => {
  assert.equal(O.noticeBandView([transport], 100000).action, 'list');
});
test('transport detail remains non-openable; the inbox and × stay available', () => {
  const src = fs.readFileSync(path.join(__dirname, '../frontend/island.js'), 'utf8');
  const paint = src.slice(src.indexOf('if (view) {', src.indexOf('noticesEl.dataset.grouped')), src.indexOf('// #437: the list view'));
  assert.match(paint, /noticeOpen\.disabled = view\.action == null/);
  assert(src.includes('noticeDismiss.hidden = !first;'));
  assert.equal(NV.openPayload({ isTrusted: true }, transport, 'finished'), null);
});
test('real UUID notice enters the list and its detail click reaches the native facade', () => {
  assert.equal(O.noticeBandView([real], 100000).action, 'list');
  const payload = NV.openPayload({ isTrusted: true }, real, 'finished');
  assert.deepEqual(payload, { id: real.id, kind: 'finished' });
  const calls = [];
  const window = { __TAURI__: { core: { invoke: (command, args) => { calls.push({ command, args }); return Promise.resolve({}); } } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../frontend/desktop.js'), 'utf8'), { window });
  window.desktop.click(payload);
  assert.equal(calls[0].args.payload.id, real.id);
  assert.equal(calls[0].args.payload.action, 'click');
});
process.exitCode = failed ? 1 : 0;
