'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const {pathToFileURL} = require('node:url');
const {all, text, dom, Element} = require('./settings-accounts-check.cjs');
(async () => {
  dom();
  Element.prototype.getBoundingClientRect = () => ({left:20,bottom:30});
  Element.prototype.querySelector = function(selector) { return all(this).find(e=>selector==='.'+e.className.split(' ').join('.')) || (selector==='.swatch' ? all(this).find(e=>e.className.split(' ').includes('swatch')) : null); };
  Element.prototype.remove = function() { document.body.removeChild(this); };
  document.removeEventListener = () => {};
  global.window = { innerWidth:1100, addEventListener() {}, removeEventListener() {} };
  const {renderPills, renderAppearance} = await import(pathToFileURL(path.resolve(__dirname, '../frontend/vendor/coucou/hub/personalization.js')));
  const V = require('../frontend/settings-view.js'), S = require('../frontend/specialists-view.js'), A = require('../frontend/avatar-colors.js');
  const P = require('../frontend/pills.js'), C = require('../frontend/pill-catalog.js');
  let prefs = { theme:'system', avatarColors:{}, pillColors:{}, declaredPills:[], mainPill:'integration_claude', islandAgents:['esp-one'], abitoInstructions:'' };
  let store = {specialists:[{id:'esp-one',name:'Uno',instructions:'Ayuda local',model:null,space:null,spaces:[],permissions:['read']}],active:null};
  const calls=[], events={};
  const invoke = async (cmd,{payload:p}) => {
    calls.push([cmd,p]);
    if(cmd==='specialists_action') {
      if(p.action==='create') store.specialists.push({...p});
      if(p.action==='update') Object.assign(store.specialists.find(x=>x.id===p.id),p);
      if(p.action==='delete') store.specialists=store.specialists.filter(x=>x.id!==p.id);
      return structuredClone(store);
    }
    if(cmd==='models_action') return {profiles:[]};
    if(p.action==='set_theme') prefs.theme=p.theme;
    if(p.action==='set_avatar_color') prefs.avatarColors[p.identity]=p.color;
    if(p.action==='set_pill_color') prefs.pillColors[p.id]=p.color;
    if(p.action==='clear_pill_color') delete prefs.pillColors[p.id];
    if(p.action==='toggle_declared_pill') prefs.declaredPills=P.toggle(P.normalize(prefs),p.id).declaredPills;
    if(p.action==='set_main_pill') { prefs.mainPill=p.id; prefs.declaredPills=prefs.declaredPills.filter(id=>id!==p.id); }
    if(p.action==='set_island_agents') prefs.islandAgents=p.order;
    if(p.action==='set_abito_instructions') prefs.abitoInstructions=p.text;
    return structuredClone(prefs);
  };
  const options={invoke,V,S,A,P,C,listen:async (name,f)=>{events[name]=f;return ()=>{delete events[name];};}};
  let ui=await renderAppearance(options); await ui.settled(); calls.length=0;
  const find=id=>all(ui).find(e=>e.attrs.id===id);
  find('appearance-theme').value='dark'; find('appearance-theme').fire('change',false); await ui.settled(); assert.deepEqual(calls,[]);
  find('appearance-theme').fire('change'); await ui.settled(); assert.deepEqual(calls.pop(),['prefs_action',{action:'set_theme',theme:'dark'}]);
  const color=A.HEX_PALETTE[0];
  find(`identity-abito-${color}`).fire('click',false); await ui.settled(); assert.deepEqual(calls,[]);
  find(`identity-abito-${color}`).fire('click'); await ui.settled(); assert.deepEqual(calls.pop(),['prefs_action',{action:'set_avatar_color',identity:'abito',color}]);
  assert(text(ui).includes('No disponible en esta ventana')); ui.dispose();
  // 0.2.1 T2 (S1, S3, S4; L1 «que el usuario no pueda crear uno»): the specialists are read-only definitions; only «En la isla» is switchable.
  ui=await renderPills({...options,part:'island'}); await ui.settled(); calls.length=0;
  assert(text(ui).includes('Especialistas 1/3'),'the count is shown');
  for(const gone of ['Nuevo agente','Convertir en agente','Editar','Eliminar','Subir','Bajar','Guardar agente']) assert(!all(ui).some(e=>e.tagName==='button'&&e.textContent===gone),`${gone} is gone`);
  const first = ui.firstChild; events['prefs:state']({payload:{...prefs,sound:false}}); assert.equal(ui.firstChild,first,'unrelated prefs must not rebuild the island switches');
  const islandSwitch=name=>all(ui).find(e=>e.attrs['aria-label']===`En la isla: ${name}`);
  islandSwitch('Uno').fire('click',false);await ui.settled();assert.deepEqual(calls,[]);
  islandSwitch('Uno').fire('click');await ui.settled();assert.deepEqual(calls.pop(),['prefs_action',{action:'set_island_agents',order:[]}]);
  assert.deepEqual(prefs.declaredPills,[],'the pills list is untouched by a specialist switch');
  islandSwitch('Uno').fire('click');await ui.settled();assert.deepEqual(calls.pop(),['prefs_action',{action:'set_island_agents',order:['esp-one']}]);
  ui.dispose();
  // «Modelo principal» left this page: it stays editable in Chat (models_action select), never here.
  ui=await renderPills({...options,part:'abito'}); await ui.settled(); calls.length=0;
  assert(!text(ui).includes('Modelo principal') && !text(ui).includes('Reposo') && !text(ui).includes('Vista previa'),'no model picker, no preview');
  assert(all(ui).filter(e=>e.attrs.role==='tooltip'&&e.textContent.includes('Se aplican a los próximos mensajes')).length===1&&!all(ui).some(e=>(e.className==='detail'||e.className==='hint')&&e.textContent.includes('Se aplican')),'the hint is an ⓘ now, not standing copy');
  find(`identity-abito-${color}`).fire('click',false); await ui.settled(); assert.deepEqual(calls,[]);
  find(`identity-abito-${color}`).fire('click'); await ui.settled(); assert.deepEqual(calls.pop(),['prefs_action',{action:'set_avatar_color',identity:'abito',color}]);
  find('abito-instructions').value='Instrucciones propias';
  const click=(word,trusted=true)=>{const b=all(ui).find(e=>e.tagName==='button'&&e.textContent===word);assert(b,word);b.fire('click',trusted);};
  click('Guardar instrucciones',false);await ui.settled();assert.deepEqual(calls,[]);
  click('Guardar instrucciones');await ui.settled();assert.deepEqual(calls.pop(),['prefs_action',{action:'set_abito_instructions',text:'Instrucciones propias'}]);
  ui.dispose();
  // 0.2.4: replace the old CLI option/change assertions with a read-only unavailable row.
  // Both a current CLI main and a legacy main must survive the mount without any IPC.
  for (const mainPill of ['integration_claude', 'agent_cursor']) {
    prefs.mainPill = mainPill;
    const before = structuredClone(prefs); calls.length = 0;
    ui=await renderPills({...options,part:'tools'}); await ui.settled();
    assert(!text(ui).includes('Herramienta principal'), 'HU-076: the unavailable main tool is hidden');
    assert(!all(ui).some(e=>['select','button','input','textarea'].includes(e.tagName)));
    assert.deepEqual(calls,[], 'the dormant tools slot neither reads nor writes preferences');
    assert.deepEqual(prefs,before, 'stored main pill and all other preferences are unchanged');
    ui.dispose();
  }
  ui.dispose();assert.equal(Object.keys(events).length,0);
  const html=fs.readFileSync(path.resolve(__dirname,'../frontend/settings.html'),'utf8');
  assert(html.indexOf('src="./clay-engine.js"')>=0);assert(html.indexOf('src="./clay-engine.js"')<html.indexOf('src="./settings-app.js"'));
  const {hero}=await import(pathToFileURL(path.resolve(__dirname,'../frontend/vendor/coucou/hub/hero.js')));
  const mounts=[];global.AbitoClay={create:(svg,opts)=>{mounts.push([svg,opts]);return {destroy(){}};}};
  const band=hero('appearance','Apariencia','Tema y colores');assert(mounts.length===1);assert.equal(mounts[0][0].tagName,'svg');assert.equal(mounts[0][1].live,false);assert(text(band).includes('Apariencia'));
  // Mount the real hash-pinned classic API as well, not only a permissive mock.
  const engine=fs.readFileSync(path.resolve(__dirname,'../frontend/clay-engine.js'),'utf8');
  global.AbitoClay=require('node:vm').runInNewContext(engine+'\nAbitoClay;', {document:global.document,matchMedia:()=>({matches:false,addEventListener(){}}),addEventListener(){},performance:{now:()=>0},requestAnimationFrame(){throw Error('static settings must not schedule RAF');},cancelAnimationFrame(){}});
  const realBand=hero('pills','Blobs','Especialistas');assert(all(realBand).some(e=>e.tagName==='path'&&e.attrs['data-abito-body']===''&&e.attrs.d));
  delete global.AbitoClay;
  console.log('PASS settings-pills: trusted theme/identity, read-only specialists with island switches, instructions, unavailable main tool preserving prefs, classic clay mounting');
})().catch(e=>{console.error(e);process.exitCode=1;});
