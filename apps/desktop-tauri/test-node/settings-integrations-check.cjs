'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { dom, Element, all, text } = require('./settings-accounts-check.cjs');
(async () => {
  dom();
  Element.prototype.getBoundingClientRect = () => ({left:20,bottom:30});
  Element.prototype.querySelector = function() { return all(this).find(e=>e.className.split(' ').includes('swatch')); };
  Element.prototype.remove = function() { document.body.removeChild(this); };
  document.removeEventListener = () => {};
  global.window = {innerWidth:1100,addEventListener(){},removeEventListener(){}};
  const base = path.resolve(__dirname,'../frontend/vendor/coucou/hub');
  const { renderIntegrations } = await import(pathToFileURL(path.join(base,'integrations.js')));
  const { renderShortcuts } = await import(pathToFileURL(path.join(base,'shortcuts.js')));
  const { renderRecapRows } = await import(pathToFileURL(path.join(base,'recap.js')));
  const V = require('../frontend/settings-view.js'), P = require('../frontend/pills.js'), C = require('../frontend/pill-catalog.js');
  let prefs={mainPill:'integration_claude',declaredPills:[],pillColors:{}}, ui, fail=false;
  const calls=[], events={};
  let hotkey={combo:'Ctrl+Space',enabled:true,status:'active'};
  const desktopHotkey={combo:'Ctrl+Alt+D',enabled:true,status:'active'};
  const actionHotkeys={};
  let failResetOf=null;
  const invoke=async(cmd,{payload:p})=>{
    if(cmd==='hotkey_action'&&p.action==='reset'&&p.id===failResetOf){calls.push([cmd,p]);throw Error('reset fixture');}
    if(cmd==='secret_action'&&p.action!=='present') assert.equal(all(ui).find(e=>e.id===`integration-key-${p.key}`).value,'','clear BEFORE IPC');
    calls.push([cmd,p]);
    if(fail) throw Error('fixture');
    if(cmd==='secret_action') return {present:p.action==='set'};
    if(cmd==='hotkey_action') { const binding=p.id==='desktopToggle'?desktopHotkey:!p.id?hotkey:(actionHotkeys[p.id]||={combo:'Ctrl+Alt+F9',enabled:true,status:'active'}); if(p.action==='set') {binding.combo=p.combo;binding.enabled=true;}if(p.action==='clear'){binding.combo='';binding.enabled=false;}if(p.action==='reset'){binding.enabled=true;binding.combo=SHORTCUTS.find(d=>d.id===(p.id||'toggleIsland')).defaultKeys;}if(p.action==='disable')binding.enabled=false;if(p.action==='enable')binding.enabled=true;return {...binding}; }
    if(cmd==='recap_action')return p.action==='prefs'?{enabled:true}:{ok:true};
    if(p.action==='toggle_declared_pill')prefs.declaredPills=P.toggle(P.normalize(prefs),p.id).declaredPills;
    if(p.action==='set_pill_color')prefs.pillColors[p.id]=p.color;
    if(p.action==='clear_pill_color')delete prefs.pillColors[p.id];
    return structuredClone(prefs);
  };
  const opts={invoke,V,P,C,listen:async(n,f)=>{events[n]=f;return()=>{delete events[n];};},timers:{setTimeout:()=>1,clearTimeout(){}}};
  const find=id=>all(ui).find(e=>e.id===id);
  const click=(b,trusted=true)=>{assert(b);b.fire('click',trusted);};
  // #503 S25: «Restablecer» asks first; the reset runs from the trusted confirmation button only
  const confirmReset=()=>{click(find('shortcut-reset'));click(all(find('shortcut-reset-confirm')).find(e=>e.tagName==='button'&&e.textContent==='Restablecer'));};
  ui=await renderIntegrations(opts);await ui.settled();
  assert.equal(text(ui.children[0].children[0].children[0]).trim(),'Servicios','the title is its own span; the keychain explanation is an ⓘ beside it');
  assert(!text(ui).includes('Elige las pestañas'),'0.2.1 S7: the count sentence is gone');
  assert(text(ui).includes('Las claves se quedan en el llavero del sistema.'));
  assert(text(ui).includes('Secret Service (GNOME Keyring, KWallet)'));
  assert(!/nunca en el disco|never on disk/i.test(text(ui)),'approved truthful-copy exception');
  const keys=['stripe-api-key','github-token','vercel-token','n8n-url','n8n-api-key','resend-api-key','resend-from','notion-api-key','calcom-api-key','smtp-host','smtp-user','smtp-password','smtp-from','imap-host','imap-user','imap-password'];
  assert.deepEqual(calls.filter(([c])=>c==='secret_action').map(([,p])=>p),keys.map(key=>({action:'present',key})));
  const list=find('integration-list');assert.equal(list.children.length,10);
  assert.deepEqual(list.children.map(e=>e.id),[...['stripe','github','vercel','n8n','resend','notion','calcom','spotify'].map(id=>`integration_${id}`),'mail_smtp','mail_imap']);
  for(const key of keys){
    const input=find(`integration-key-${key}`);assert.equal(input.type,'password','all keystore fields masked, including URL');
    const row=all(ui).find(e=>e.children.includes(input));assert.equal(row.children[0].tagName,'label');
    const save=row.children.find(e=>e.tagName==='button');assert.equal(save.textContent,'Guardar');
    input.value='fixture-only';calls.length=0;click(save,false);await ui.settled();assert.deepEqual(calls,[]);
    click(save);await ui.settled();assert.deepEqual(calls,[['secret_action',{action:'set',key,value:'fixture-only'}]]);
    assert.equal(input.value,'');calls.length=0;click(save);await ui.settled();assert.deepEqual(calls,[['secret_action',{action:'clear',key}]]);
  }
  calls.length=0;click(find('declare-integration_stripe'),false);await ui.settled();assert.deepEqual(calls,[]);
  click(find('declare-integration_stripe'));await ui.settled();assert.deepEqual(calls,[['prefs_action',{action:'toggle_declared_pill',id:'integration_stripe'}]]);
  for(const id of ['integration_github','integration_vercel','integration_n8n']){click(find(`declare-${id}`));await ui.settled();}
  calls.length=0;click(find('declare-integration_resend'));await ui.settled();assert.deepEqual(calls,[['prefs_action',{action:'toggle_declared_pill',id:'integration_resend'}]],'S32: the fifth pill is accepted');assert.equal(prefs.declaredPills.length,5);
  click(find('declare-integration_stripe'));await ui.settled();assert.equal(prefs.declaredPills.length,4,'removal stays possible');
  const dot=()=>all(find('integration_stripe')).find(e=>e.className.includes('color-dot'));
  calls.length=0;click(dot(),false);assert.equal(document.body.children.length,0);click(dot());
  let palette=document.body.children[0];const swatch=palette.children[0];click(swatch,false);await ui.settled();assert.deepEqual(calls,[]);click(swatch);await ui.settled();
  assert.deepEqual(calls,[['prefs_action',{action:'set_pill_color',id:'integration_stripe',color:'#F5F6F8'}]]);
  click(dot());palette=document.body.children[0];click(palette.children.find(e=>e.className==='reset'));await ui.settled();
  assert.deepEqual(calls.at(-1),['prefs_action',{action:'clear_pill_color',id:'integration_stripe'}]);
  fail=true;find('integration-key-github-token').value='fixture-only';click(all(ui).find(e=>e.children.includes(find('integration-key-github-token'))).children[2]);await ui.settled();
  assert.equal(find('integration-key-github-token').value,'');assert(!text(ui).includes('fixture-only'));fail=false;
  find('integration-key-github-token').value='discard';click(dot());ui.dispose();assert.equal(document.body.children.length,0);assert.equal(find('integration-key-github-token').value,'');assert.equal(Object.keys(events).length,0);
  ui=await renderIntegrations({...opts,V:{...V,KEY_IDS:V.KEY_IDS.filter(k=>k!=='n8n-url')}});await ui.settled();assert(find('integration-key-n8n-url').disabled);assert(text(ui).includes('No disponible todavía'));ui.dispose();
  // Every integration switch uses its own closed id.
  prefs.declaredPills=[];ui=await renderIntegrations(opts);await ui.settled();
  for(const id of ['stripe','github','vercel','n8n','resend','notion','calcom','spotify'].map(x=>'integration_'+x)) {
    calls.length=0;click(find('declare-'+id));await ui.settled();assert.deepEqual(calls,[['prefs_action',{action:'toggle_declared_pill',id}]]);
    click(find('declare-'+id));await ui.settled();assert.deepEqual(calls.at(-1),['prefs_action',{action:'toggle_declared_pill',id}]);
    const color=all(find(id)).find(e=>e.className.includes('color-dot'));
    calls.length=0;click(color);click(document.body.children[0].children[0]);await ui.settled();assert.deepEqual(calls,[['prefs_action',{action:'set_pill_color',id,color:'#F5F6F8'}]]);
    click(color);click(document.body.children[0].children.find(e=>e.className==='reset'));await ui.settled();assert.deepEqual(calls.at(-1),['prefs_action',{action:'clear_pill_color',id}]);
  }
  const draft=find('integration-key-stripe-api-key');draft.value='kept-only-in-field';events['prefs:state']({payload:{...prefs,sound:false}});assert.equal(draft.value,'kept-only-in-field','prefs updates do not discard key drafts');
  ui.dispose();calls.length=0;click(find('declare-integration_stripe'));await ui.settled();assert.deepEqual(calls,[],'disposed controls cannot write');
  ui=await renderShortcuts(opts);await ui.settled();
  const {SHORTCUTS,ISLAND_SHORTCUTS,displayKeys}=await import(pathToFileURL(path.resolve(base,'../core/shortcuts.js')));
  assert.equal((text(ui).match(/Atajo de X11/g)||[]).length,1,'shared backend footer appears once, not once per binding');
  assert(text(find('shortcut-desktopToggle')).includes('Enviar al personaje al escritorio'));
  assert(text(find('shortcut-muteToggle')).includes('Silenciar o activar al personaje'));
  const globalRows=find('global-shortcuts');assert.equal(globalRows.children.length,SHORTCUTS.filter(d=>d.ported).length);
  assert.equal(find('island-shortcuts').children.length,ISLAND_SHORTCUTS.length);
  assert.equal(find('shortcut-desktopToggle').children[0].disabled,false,'desktopToggle is supported');
  assert(text(find('shortcut-desktopToggle')).includes(displayKeys('Ctrl+Alt+D')));
  assert.equal(typeof events['hotkey-desktop:state'],'function','desktop status updates are subscribed');
  events['hotkey-desktop:state']({payload:{...desktopHotkey,status:'permission_denied'}});
  assert(text(find('shortcut-desktopToggle')).includes('Tu escritorio no lo activó'));
  assert(!text(find('shortcut-toggleIsland')).includes('Tu escritorio no lo activó'));
  events['hotkey-desktop:state']({payload:{...desktopHotkey}});
  for(const d of SHORTCUTS.filter(d=>d.ported)) {
    assert.equal(find(`shortcut-${d.id}`).children[0].disabled,false,`${d.id} has an independent live binding`);
  }
  assert.deepEqual(all(ui).filter(e=>e.className==='subhead').map(text),['Desde cualquier lugar','En la isla abierta']);
  calls.length=0;click(find('shortcut-toggleIsland').children[0],false);await ui.settled();assert.deepEqual(calls,[]);
  click(find('shortcut-toggleIsland').children[0]);await ui.settled();assert.deepEqual(calls,[['hotkey_action',{action:'disable'}]]);
  click(find('shortcut-toggleIsland').children[0]);await ui.settled();assert.deepEqual(calls.at(-1),['hotkey_action',{action:'enable'}]);
  const record=()=>find('shortcut-toggleIsland').children.at(-1);
  calls.length=0;click(record(),false);assert(!text(ui).includes('Pulsa las teclas…'));click(record());await ui.settled();
  record().fire('keydown',false,{key:'K',code:'KeyK',ctrlKey:true});await ui.settled();assert.deepEqual(calls,[['hotkey_action',{action:'suspend'}]]);
  record().fire('keydown',true,{key:'K',code:'KeyK',ctrlKey:true});await ui.settled();assert.deepEqual(calls,[['hotkey_action',{action:'suspend'}],['hotkey_action',{action:'set',combo:'Ctrl+K'}],['hotkey_action',{action:'resume'}]]);await new Promise(r=>setImmediate(r));
    calls.length=0;click(record());await ui.settled();await new Promise(r=>setImmediate(r));record().fire('keydown',true,{key:'Backspace',code:'Backspace'});await ui.settled();await new Promise(r=>setImmediate(r));
    assert(calls.some(([,p])=>p.action==='clear'&&!p.id),'Backspace clears the selected binding');
  assert.equal(record().disabled,false,'an unbound binding can be recorded again');
  assert.equal(find('shortcut-toggleIsland').children[0].disabled,true,'record a combo before enabling an unbound action');
  calls.length=0;click(record());await ui.settled();record().fire('keydown',true,{key:'K',code:'KeyK',ctrlKey:true});await ui.settled();
  calls.length=0;click(find('shortcut-desktopToggle').children[0],false);await ui.settled();assert.deepEqual(calls,[]);
  click(find('shortcut-desktopToggle').children[0]);await ui.settled();assert.deepEqual(calls,[['hotkey_action',{action:'disable',id:'desktopToggle'}]]);
  assert.equal(hotkey.enabled,true,'desktop switch does not change island binding');
  click(find('shortcut-desktopToggle').children[0]);await ui.settled();assert.deepEqual(calls.at(-1),['hotkey_action',{action:'enable',id:'desktopToggle'}]);
  const desktopRecord=()=>find('shortcut-desktopToggle').children.at(-1);
  calls.length=0;click(desktopRecord());await ui.settled();desktopRecord().fire('keydown',true,{key:'J',code:'KeyJ',ctrlKey:true});await ui.settled();
  assert.deepEqual(calls,[['hotkey_action',{action:'suspend'}],['hotkey_action',{action:'set',combo:'Ctrl+J',id:'desktopToggle'}],['hotkey_action',{action:'resume'}]]);
  assert.equal(hotkey.combo,'Ctrl+K','desktop recording does not change island binding');
  calls.length=0;click(find('shortcut-reset'),false);await ui.settled();assert.deepEqual(calls,[]);click(find('shortcut-reset'));await ui.settled();assert.deepEqual(calls,[],'asking writes nothing');click(all(find('shortcut-reset-confirm')).find(e=>e.tagName==='button'&&e.textContent==='Restablecer'));await ui.settled();assert.deepEqual(calls,['clear','reset'].flatMap(action=>SHORTCUTS.filter(d=>d.ported).map(d=>['hotkey_action',d.id==='toggleIsland'?{action}:{action,id:d.id}])),'full reset releases reservations before restoring defaults');ui.dispose();
  ui=await renderShortcuts(opts);await ui.settled();failResetOf=undefined;calls.length=0;confirmReset();await ui.settled();failResetOf=null;assert.equal(hotkey.enabled,false,'failed reset remains honestly cleared');assert(text(ui).includes('No se pudieron restablecer'));ui.dispose();hotkey.enabled=true;
  assert.equal(calls.filter(([,p])=>p.action==='reset').length,9,'a failing island reset still resets every other binding');
  desktopHotkey.status='taken';ui=await renderShortcuts(opts);await ui.settled();assert(text(find('shortcut-desktopToggle')).includes('En uso por otra app'));ui.dispose();desktopHotkey.status='active';
  hotkey.status='taken';ui=await renderShortcuts(opts);await ui.settled();assert(text(find('shortcut-toggleIsland')).includes('En uso por otra app'));ui.dispose();hotkey.status='active';
  ui=await renderRecapRows(opts);await ui.settled();assert.equal(ui.children.length,2,'0.2.1: switch row + clear row; the explanation is an ⓘ');assert(text(ui).includes('Resumen semanal'));
  calls.length=0;click(find('hub-recap'),false);await ui.settled();assert.deepEqual(calls,[]);click(find('hub-recap'));await ui.settled();assert.deepEqual(calls,[['recap_action',{action:'set_enabled',enabled:false}]]);
  calls.length=0;click(find('hub-recap-clear'),false);await ui.settled();assert.deepEqual(calls,[]);click(find('hub-recap-clear'));await ui.settled();assert.deepEqual(calls,[['recap_action',{action:'clear'}]]);assert(text(ui).includes('Historial borrado.'));ui.dispose();
  fail=true;ui=await renderRecapRows(opts);await ui.settled();assert(find('hub-recap').disabled&&find('hub-recap-clear').disabled);assert(!text(ui).includes('Historial borrado.'));ui.dispose();fail=false;
  for(const name of ['integrations','shortcuts','recap'])assert(!/innerHTML|setAttribute\(['"]style|console\.|localStorage|sessionStorage/.test(fs.readFileSync(path.join(base,name+'.ts'),'utf8')));
  console.log('PASS settings-integrations: exact integration rows, truthful copy, secrets, capacity, colours, shortcut controls, recap and trusted IPC');
})().catch(e=>{console.error(e);process.exitCode=1;});
