'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
(async () => {
  const source = fs.readFileSync(path.join(__dirname, '../frontend/settings-app.js'), 'utf8');
  const calls = [];
  const context = { window: { __TAURI__: { core: { invoke: async (...args) => { calls.push(args); return {ok:true}; } } } }, TextEncoder };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('const rawInvoke ='), source.indexOf('setInvoke(invoke);')) + '\nglobalThis.invoke = invoke;', context);
  for (const payload of [{action:'copy_entry',id:'entry-1'}, {action:'copy_entry',id:'x'.repeat(64)}, {action:'copy_last'}]) {
    await context.invoke('dictation_action', {payload});
    assert.deepEqual(calls.pop(), ['dictation_action', {payload}]);
  }
  for (const payload of [null, [], {}, {action:'copy_entry'}, {action:'copy_entry',id:''},
    {action:'copy_entry',id:'x'.repeat(65)}, {action:'copy_entry',id:'../entry'},
    {action:'copy_entry',id:5}, {action:'copy_entry',id:'é'},
    {action:'copy_entry',id:'entry-1',text:'injected'}, {action:'copy_last',id:'entry-1'},
    {action:'copy_last',text:'injected'}, {action:'copy_unknown'}]) {
    await assert.rejects(context.invoke('dictation_action', {payload}));
  }
  await assert.rejects(context.invoke('dictation_action', {payload:{action:'copy_last'},extra:1}));
  assert.equal(calls.length, 0, 'rejected payloads never reach native IPC');
  console.log('PASS dictation-copy-gate: exact copy shapes only; malformed/extra fields never reach IPC');
})().catch(error => {console.error(error); process.exitCode = 1;});
