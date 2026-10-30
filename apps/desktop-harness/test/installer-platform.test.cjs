'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parentIdentityMatches, darwinParentExecutable, windowsParentExecutable } = require('../src/installer-platform.cjs');

test('shared parent policy accepts only an exact executable and own uid/SID on every platform', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const identity = platform === 'win32' ? 'S-1-5-21-1000' : 1000;
    const facts = { platform, expected: '/trusted/node', executable: '/trusted/node', current: identity, parent: identity };
    assert.equal(parentIdentityMatches(facts), true);
    for (const patch of [{ executable:'/other/node' }, { parent:null }, { current:null }, { expected:'' }, { parent:platform === 'win32' ? 'S-1-5-21-2000' : 2000 }])
      assert.equal(parentIdentityMatches({...facts,...patch}), false);
  }
  assert.equal(parentIdentityMatches({platform:'unknown', expected:'x', executable:'x', current:1, parent:1}), false);
});

test('macOS parent lookup uses fixed ps, own uid, and preserves spaces in executable paths', () => {
  const calls = [];
  const exec = (bin, args, options) => {
    calls.push([bin,args,options]);
    return '1000 /Applications/Node Runtime/node\n';
  };
  assert.equal(darwinParentExecutable(42, {uid:1000, exec}), '/Applications/Node Runtime/node');
  assert.equal(calls[0][0], '/bin/ps');
  assert.deepEqual(calls[0][1], ['-ww','-o','uid=','-o','comm=','-p','42']);
  assert.equal(calls[0][2].shell, undefined);
  assert.equal(calls[0][2].timeout, 2000);
  assert.equal(darwinParentExecutable(42, {uid:2000, exec}), undefined);
  assert.equal(darwinParentExecutable(42, {uid:1000, exec:()=>{throw Error('gone');}}), undefined);
  assert.equal(darwinParentExecutable(42, {uid:1000, exec:()=> '1000 /node\n1000 /evil\n'}), undefined);
  assert.equal(darwinParentExecutable(-1, {uid:1000, exec}), undefined);
});

test('Windows parent lookup accepts only closed helper evidence for the requested pid and matching SID', () => {
  const good = {schema:'abito-parent/1',pid:42,executable:'C:\\Program Files\\nodejs\\node.exe',currentSid:'S-1-5-21-1000',parentSid:'S-1-5-21-1000'};
  const deps = {helper:'C:\\Abito\\abito-private-session.exe',exec:(bin,args,options)=>{
    assert.equal(bin, 'C:\\Abito\\abito-private-session.exe');
    assert.deepEqual(args,['--parent-check','42']); assert.equal(options.timeout,2000);
    return JSON.stringify(good)+'\n';
  }};
  assert.equal(windowsParentExecutable(42,deps),good.executable);
  for(const patch of [{pid:43},{parentSid:'S-1-5-21-2000'},{schema:'bad'},{executable:'relative.exe'},{extra:true},{currentSid:null}]) {
    assert.equal(windowsParentExecutable(42,{...deps,exec:()=>JSON.stringify({...good,...patch})}),undefined);
  }
  assert.equal(windowsParentExecutable(42,{...deps,exec:()=>{throw Error('missing helper');}}),undefined);
});
