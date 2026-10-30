'use strict';
// Exercise the real scene with native state arriving before the renderer settles.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
(async () => {
  const ids = ['toggleIsland','openChat','goToAlert','jumpToTerminal','nextPill','prevPill','muteToggle','desktopToggle','wardrobeToggle'];
  const bindings = Object.fromEntries(ids.map((id,i) => [id,{enabled:true,combo:`Ctrl+F${i+1}`} ]));
  let pending = null, clicks = 0, resets = 0, settling = 0;
  const element = () => ({disabled:false, scrollIntoView(){}, closest(){return null;}, getBoundingClientRect(){return {x:10,y:10,width:20,height:20};}});
  const switches = Object.fromEntries(ids.map(id => [id,element()]));
  const nav = element(), reset = element();
  let selected;
  const rows = Object.fromEntries(ids.map(id => [`shortcut-${id}`,{querySelector(){selected=id;return switches[id];}}]));
  const window = {__validatePages:['shortcuts'],__validateOrigin:{x:0,y:0,scale:1},__TAURI__:{
    core:{async invoke(command,{payload:p}) {
      assert.equal(command,'hotkey_action');
      const id=p.id||'toggleIsland';
      if(p.action==='set') throw {code:'combo_in_use'};
      if(p.action==='view' && pending===id) {
        bindings[id].enabled=!bindings[id].enabled;
        // The host has updated config, but rebind and the UI promise are pending.
        switches[id].disabled=true;pending=null;settling++;
      }
      return {...bindings[id]};
    }},
    event:{async emit(_event,payload) {
      assert.equal(payload.kind,'click');
      if(selected) {assert.equal(switches[selected].disabled,false,'never click a busy renderer control');pending=selected;clicks++;selected=null;}
      else resets++;
    }}
  }};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../packaging/validate/browser.js'),'utf8'),{
    window, document:{getElementById:id=>id==='shortcut-reset'?reset:rows[id],querySelectorAll:()=>[nav],
      // 0.1.2: the page button is found by its data-page (paused pages are hidden, so positions shift)
      querySelector:sel=>sel==='.hub-side .hub-item[data-page="shortcuts"]'?nav:null},
    addEventListener(){},console:{error(){}},performance,
    setTimeout(fn,ms){if(ms===250)for(const sw of Object.values(switches))sw.disabled=false;fn();return 1;},
    requestAnimationFrame:fn=>fn(),getComputedStyle:()=>({display:'block',visibility:'visible'})
  });
  // Selecting a switch happens in querySelector; navigation/reset have no row id.
  // The initial readiness query must not accidentally select the last switch.
  nav.scrollIntoView=()=>{selected=null;};reset.scrollIntoView=()=>{selected=null;};
  const result=await window.AbitoValidate.hotkeys();
  assert.equal(result.ok,true);assert.equal(clicks,18);assert.equal(settling,18);
  assert(ids.every(id=>bindings[id].enabled),'all nine bindings restored after both toggle directions');
  assert.equal(resets,2,'navigation and full reset remain trusted external clicks');
  console.log('PASS shortcut-validation: native readback cannot outrun renderer readiness (18 toggle transitions)');
})().catch(error=>{console.error(error);process.exitCode=1;});
