'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
async function scene(band, late = false, page = 'agents', shownPages = [page]) {
  let current = null, changed = false, instructions = '';
  const element = (id, textContent = '') => ({id, textContent, disabled:false, value:'',
    classList:{contains:()=>true}, scrollIntoView(){}, closest:()=>null,
    getBoundingClientRect:()=>({x:id==='tab'?10:30,y:0,width:10,height:10})});
  const tab = element('tab'), toggle = element('toggle'), save = element('save','Guardar instrucciones');
  const field = element('abito-instructions');
  const root = {get textContent() {return `Agentes. Se aplican a los próximos mensajes del chat de Abito. ${!late || changed ? band : ''}`;},
    scrollIntoView(){}, querySelector:()=>toggle, querySelectorAll:selector=>selector==='button'?[save]:[toggle,save,field]};
  const window = {__validateOrigin:{x:0,y:0,scale:1},__TAURI__:{core:{invoke:async(command)=>
    command==='prefs_action'?{changed,abitoInstructions:instructions}:{prefs:{}}},event:{emit:async()=>{
      if (!current) current=root;
      else {changed=true; instructions=field.value;}
    }}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../packaging/validate/browser.js'),'utf8'),{
    // 0.1.2: the validator finds a page by its data-page; a paused (hidden) page has no button in the menu
    window, document:{querySelector:sel=>{const m=/data-page="([a-z]+)"/.exec(sel);return m?(shownPages.includes(m[1])?tab:null):current;},
      querySelectorAll:()=>[tab],getElementById:()=>field},
    addEventListener(){},console:{error(){}},performance,
    setTimeout:fn=>{fn();return 1;},requestAnimationFrame:fn=>fn(),
    getComputedStyle:()=>({display:'block',visibility:'visible'})});
  return window.AbitoValidate.hub(0,page);
}
(async()=>{
  // agent rows live on Agentes; Integraciones keeps the same rule for the day it is active again
  for (const page of ['agents', 'integrations']) {
    for (const band of ['No se pudo completar; no se tocó nada.', 'install_failed', 'No se pudo completar']) {
      for (const late of [false,true]) {
        const result = await scene(band, late, page);
        assert.equal(result.ok,false,`ajustes-${page} must reject ${band} (late=${late})`);
      }
    }
    assert.equal((await scene('Codex no disponible', false, page)).ok,true,`${page}: unavailable is not an installer error`);
  }
  // 0.1.2 (human: «vale todo lo que este en pausa se puede ocultar?» → yes): a paused page is hidden, so the scene reports it as such
  const hidden = await scene('install_failed', false, 'integrations', ['agents']);
  assert.deepEqual([hidden.ok, hidden.hidden], [true, true], 'a hidden paused page is reported hidden, never «verified»');
  console.log('validate-agents: 15 scene checks passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
