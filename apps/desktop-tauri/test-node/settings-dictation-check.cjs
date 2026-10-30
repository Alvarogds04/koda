'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { dom, Element, all, text } = require('./settings-accounts-check.cjs');
(async () => {
  dom();
  Object.defineProperty(global, 'navigator', { value: { userAgent: 'Linux' }, configurable: true });
  const base = path.resolve(__dirname, '../frontend/vendor/coucou/hub');
  const { dictationPage, flowSettingsPage } = await import(pathToFileURL(path.join(base, 'dictation-pages.js')));
  const { FlowBridge, setInvoke } = await import(pathToFileURL(path.join(base, 'flow-shim.js')));
  const { startHub } = await import(pathToFileURL(path.join(base, 'shell.js')));
  const { hero } = await import(pathToFileURL(path.join(base, 'hero.js')));
  const events = new Map(), calls = [];
  global.window = { __TAURI__: { event: { listen: async (name, fn) => { const list = events.get(name) || new Set(); events.set(name, list); list.add(fn); return () => list.delete(fn); } } } };
  const emit = (name, payload) => { for (const fn of events.get(name) || []) fn({ payload }); };
  let state = { prefs: { enabled:false,key:'right_ctrl',edge:'bottom',mic:'',keepDays:30,cleanup:false,defaultStyle:'natural',summaryEngine:'off',openAtLaunch:false,voice:false,voiceOutput:'off',voiceGender:'female' }, models:{ parakeet:{state:'missing'},downloadMb:612 }, keys:'ok',platform:'linux',mics:[{name:'USB',default:true}] };
  let rejectWrite = false;
  let history = [];
  setInvoke(async (cmd, {payload:p}) => {
    calls.push([cmd, structuredClone(p)]);
    if (p.action === 'status') return structuredClone(state);
    if (p.action === 'history') return structuredClone(history);
    if (p.action === 'copy_entry' || p.action === 'copy_last') return {ok:true,copied:true};
    if (p.action === 'delete_entry') {history=history.filter(e=>e.id!==p.id);return {ok:true};}
    if (p.action === 'stats') return {all:{words:0,wordsPerMinute:0},streak:0};
    if (p.action === 'set_prefs') { if (rejectWrite) throw Error('test write failure'); state.prefs = {...state.prefs,...p.prefs}; return p.prefs; }
    state.models.parakeet = {state:p.action === 'remove_model' ? 'missing' : 'downloading',fraction:0}; return structuredClone(state.models);
  });
  assert.deepEqual(await FlowBridge.status(), state); assert.deepEqual(calls.pop(), ['dictation_action',{action:'status'}]);
  await FlowBridge.setPrefs({...state.prefs,cleanup:true,unexpected:1});
  const expectedPrefs = () => Object.fromEntries(['enabled','key','edge','mic','keepDays','cleanup','defaultStyle'].map(k=>[k,state.prefs[k]]));
  assert.deepEqual(calls.pop(), ['dictation_action',{action:'set_prefs',prefs:expectedPrefs()}]);
  for (const [enabled,model,keys,copy] of [[false,'missing','ok','Dictado desactivado'],[true,'missing','ok','Descarga el modelo de voz para dictar'],[true,'ready','ok','Listo · mantén Ctrl+Alt+V'],[true,'ready','pending','Usa el micrófono'],[true,'ready','denied','Usa el micrófono'],[true,'ready','unsupported','Usa el micrófono']]) {
    state.prefs.enabled=enabled; state.models.parakeet={state:model}; state.keys=keys;
    const host=new Element('div'); await startHub(host,{version:'test',flowPages:{},renderNotch:async()=>{}});
    assert(text(all(host).find(e=>e.className==='hub-status')).includes(copy), copy);
  }
  state.prefs.enabled=false; state.models.parakeet={state:'missing'}; state.keys='ok';
  let status=structuredClone(state), leave;
  const ctx={get status(){return status;},hero,navigate(){},refresh:async()=>{status=await FlowBridge.status();return status;},setPrefs:async change=>{const p={...status.prefs};change(p);await FlowBridge.setPrefs(p);status={...status,prefs:p};},set onLeave(fn){leave=fn;}};
  let launchEnabled=false, launchFail=false; const launchCalls=[];
  const launchInvoke=async (cmd,{payload:p})=>{launchCalls.push([cmd,p]);if(p.action==='set_open_settings_at_launch'){if(launchFail)throw Error('refused');launchEnabled=p.enabled;}return {openSettingsAtLaunch:launchEnabled};};
  const page = new Element('div'); await flowSettingsPage(page,ctx,launchInvoke); await Promise.resolve(); await Promise.resolve();
  assert(text(page).includes('Ctrl+V'), 'Flow settings must explain manual clipboard paste');
  assert(!text(page).includes('si Koda puede escribir por ti'), 'Koda never asks to type automatically');
  assert(String(page.children[0].className).includes('hub-hero'), 'D3: the hero is the first thing on the page; the feedback line must not sit above it');
  const labels = all(page).filter(e=>e.className==='hub-label').map(e=>e.textContent);
  assert.deepEqual(labels,['Probar','Activación','Audio','Datos'], '0.2.1 L2 (Ajustes de dictado: A): Probar first, then Activación, Audio, Datos');
  assert.deepEqual(all(page).filter(e=>e.className==='title').map(e=>e.textContent),['Mantén una tecla para dictar en cualquier lugar','Mantener para dictar','Posición de la píldora','Manos libres','Volver a pegar el último dictado','Cancelar un dictado','Micrófono','Parakeet, en tu ordenador','Guardar el historial']);
  assert(text(page).includes('612')); assert(text(page).includes('Ctrl+Alt+V')); assert(!all(page).some(e=>e.tagName==='option'&&e.attrs.value==='right_ctrl'));
  const row = title => all(page).find(e=>e.className==='hub-row' && all(e).some(n=>n.textContent===title));
  const control=(title,tag)=>all(row(title)).find(e=>e.tagName===tag);
  const repaste=control('Volver a pegar el último dictado','button');
  assert(!repaste.disabled, 'copy last is enabled');
  calls.length=0; repaste.fire('click',false); await new Promise(r=>setImmediate(r)); assert.deepEqual(calls,[]);
  repaste.fire('click'); await new Promise(r=>setImmediate(r));
  assert.deepEqual(calls.splice(0),[['dictation_action',{action:'copy_last'}]]);
  assert(text(page).includes('Ctrl+V'));
  assert(!all(page).some(e=>e.attrs.id==='hub-open-at-launch') && !text(page).includes('Abrir esta ventana'),'0.2.1: the manual-open switch moved to General');
  assert(!text(page).includes('Resúmenes') && !text(page).includes('No disponible todavía'),'0.2.1: the inactive Notetaker summaries are gone');
  calls.length=0;
  for(const e of all(page).filter(e=>['button','select','input'].includes(e.tagName))) { e.fire(e.tagName==='button'?'click':'change',false); }
  await new Promise(r=>setImmediate(r)); assert.deepEqual(calls,[],'synthetic gestures never invoke');
  control('Mantén una tecla para dictar en cualquier lugar','button').fire('click'); await new Promise(r=>setImmediate(r));
  assert.deepEqual(calls.splice(0),[['dictation_action',{action:'set_prefs',prefs:expectedPrefs()}]]);
  for(const [title,value] of [['Micrófono','USB'],['Guardar el historial','7'],['Guardar el historial','0'],['Guardar el historial','30'],['Guardar el historial','365'],['Guardar el historial','-1']]) {
    const el=control(title,'select'); el.value=value;el.fire('change'); await new Promise(r=>setImmediate(r));
    assert.deepEqual(calls.splice(0),[['dictation_action',{action:'set_prefs',prefs:expectedPrefs()}]]);
  }
  const edges=all(row('Posición de la píldora')).filter(e=>e.tagName==='button');
  for(const [i,edge] of ['bottom','left','right'].entries()){edges[i].fire('click');await new Promise(r=>setImmediate(r));assert.equal(state.prefs.edge,edge);assert.deepEqual(calls.splice(0),[['dictation_action',{action:'set_prefs',prefs:expectedPrefs()}]]);}
  for(const el of all(page).filter(e=>e.disabled)) {el.fire(el.tagName==='select'?'change':'click');} await new Promise(r=>setImmediate(r)); assert.deepEqual(calls,[],'disabled rows have no IPC');
  let download=all(page).find(e=>e.textContent==='Descargar'); download.fire('click',false); assert.deepEqual(calls,[]);download.fire('click');await new Promise(r=>setImmediate(r));assert.deepEqual(calls.splice(0),[['dictation_action',{action:'download_model'}]]);
  emit('dictation:models',{parakeet:{state:'downloading',fraction:.42},downloadMb:612});assert(text(page).includes('42 %'));
  emit('dictation:models',{parakeet:{state:'ready'},downloadMb:612});
  const installed=()=>all(page).find(e=>e.textContent==='✓ Instalado'); installed().fire('click',false); assert(!all(page).some(e=>e.textContent==='Eliminar los modelos'));
  installed().fire('click'); assert.deepEqual(calls,[],'installed click only asks confirmation');
  all(page).find(e=>e.textContent==='Cancelar').fire('click'); assert.deepEqual(calls,[]);
  installed().fire('click');all(page).find(e=>e.textContent==='Eliminar los modelos').fire('click',false);assert.deepEqual(calls,[]);
  all(page).find(e=>e.textContent==='Eliminar los modelos').fire('click');await new Promise(r=>setImmediate(r));assert.deepEqual(calls.splice(0),[['dictation_action',{action:'remove_model'}]]);
  rejectWrite=true;control('Micrófono','select').fire('change');await new Promise(r=>setImmediate(r));assert(text(page).includes('No se pudo completar'));rejectWrite=false;calls.length=0;
  leave();assert.equal(events.get('dictation:models').size,6,'page listener disposed, shell listeners remain');
  const home=new Element('div');status=structuredClone(state);status.prefs.enabled=false;await dictationPage(home,ctx); await Promise.resolve(); await Promise.resolve();
  assert(String(home.children[0].className).includes('hub-hero'), 'D3: dictation hero first');
  assert(!all(home).some(e=>e.className==='hub-columns')&&!all(home).some(e=>e.tagName==='b'&&e.textContent==='0'),'0.2.1 L2 (Dictado: A): history only, no totals card');
  assert(!text(home).includes('Ilimitado')&&!text(home).includes('Abrir el Notetaker')&&!text(home).includes('Grabar una llamada'),'no promo, no call button');
  assert(text(home).includes('Tus dictados aparecerán aquí'));
  assert(!all(home).some(e=>e.attrs.id==='hub-open-at-launch')&&!all(home).some(e=>e.textContent==='Descargar'),'no second switch or download here');
  let went=null;const linkCtx={...ctx,navigate:p=>{went=p;}};const linked=new Element('div');await dictationPage(linked,linkCtx);
  const goto=all(linked).find(e=>e.tagName==='button'&&e.textContent==='Ir a Ajustes de dictado');assert(goto,'link to the one place that prepares dictation');
  goto.fire('click',false);assert.equal(went,null);goto.fire('click');assert.equal(went,'flowsettings');leave();
  calls.length=0;
  for(const keys of ['pending','denied','unsupported']) { state.keys=keys; const p=new Element('div'); await flowSettingsPage(p,ctx);assert(text(p).includes('Koda no puede vigilar el teclado aquí'));leave(); }
  history=[{id:'saved-1',date:Date.now(),text:'Dictado guardado',words:2,seconds:1}];
  const populated=new Element('div'); await dictationPage(populated,ctx);
  const copy=all(populated).find(e=>e.attrs.title==='Copiar');
  assert(copy && !copy.disabled,'stored dictation has a usable Copy');
  calls.length=0; copy.fire('click',false); await new Promise(r=>setImmediate(r)); assert.deepEqual(calls,[]);
  copy.fire('click'); await new Promise(r=>setImmediate(r));
  assert.deepEqual(calls.splice(0),[['dictation_action',{action:'copy_entry',id:'saved-1'}]]);
  history.push({id:'saved-2',date:Date.now(),text:'Nuevo dictado',words:2,seconds:1});
  emit('dictation:phase',{phase:'copied'}); await new Promise(r=>setImmediate(r));
  assert(text(populated).includes('Nuevo dictado'),'history refreshes after dictation');
  leave();
  state.prefs.keepDays=0;state.prefs.enabled=true;state.models.parakeet={state:'ready'};
  const readyHome=new Element('div');await dictationPage(readyHome,ctx);assert(!text(readyHome).includes('Falta preparar el dictado'));assert(text(readyHome).includes('El historial está desactivado'));leave();
  setInvoke(async()=>{throw Error('status unavailable');}); assert.equal(await FlowBridge.status(),null);await assert.rejects(FlowBridge.setPrefs(state.prefs));
  for(const f of ['dictation-pages.ts','flow-shim.ts'])assert(!/innerHTML|setAttribute\(['"]style|console\.|localStorage/.test(fs.readFileSync(path.join(base,f),'utf8')),f);
  console.log('PASS settings-dictation: upstream layout, exact IPC, portal key, model progress/confirmation, trusted-only and unavailable rows');
})().catch(e=>{console.error(e);process.exitCode=1;});
