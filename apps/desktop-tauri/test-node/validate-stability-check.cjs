'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { producerFailures } = require('../packaging/validate/producer.cjs');
const { buildReport, exitCode } = require('../packaging/validate/report.cjs');
const began = performance.now();
const failures = producerFailures('Broken pipe (forced)', [{name:'pi-aviso',verdict:'pass'}]);
assert(!failures.some(r=>r.name==='pi-aviso'), 'preserve completed evidence');
assert(failures.some(r=>r.name==='pi-pregunta' && r.reason.includes('Broken pipe (forced)')));
assert(!failures.some(r=>r.name==='integracion-github'), 'independent scenes must continue');
assert.equal(exitCode(buildReport(failures)),1,'broken producer blocks the gate');
assert(performance.now()-began<1000,'producer error does not wait for the scene timeout');
console.log(`validate-stability: forced producer failure exits nonzero in ${(performance.now()-began).toFixed(1)} ms`);
(async () => {
  // The settings renderer replaces its switch while an RPC/frame is pending.
  // A trusted click must resolve the LIVE control, not the detached old node.
  let live, clicked = 0, frames = 0;
  const node = shown => ({disabled:false,id:'switch',scrollIntoView(){},closest(){return null;},
    getBoundingClientRect:()=>({x:10,y:10,width:shown()?20:0,height:shown()?20:0})});
  const old=node(()=>false), fresh=node(()=>true); live=old;
  const window={__validateOrigin:{x:0,y:0,scale:1},__TAURI__:{event:{emit:async()=>{clicked++;}},core:{invoke:async()=>({})}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../packaging/validate/browser.js'),'utf8'),{
    window, document:{getElementById:()=>null}, addEventListener(){}, console:{error(){}},performance,
    setTimeout:fn=>{live=fresh;fn();},requestAnimationFrame:fn=>{frames++;live=fresh;fn();},
    getComputedStyle:()=>({display:'block',visibility:'visible'})
  });
  await window.AbitoValidate.click(()=>live);
  assert.equal(clicked,1); assert(frames>=2);
  // Direct stale elements remain failures; this must not weaken assertions.
  await assert.rejects(window.AbitoValidate.click(old),/control no visible/);
  console.log('validate-stability: live control resolution and strict stale-element rejection passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
