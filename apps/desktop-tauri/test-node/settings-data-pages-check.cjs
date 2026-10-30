'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {pathToFileURL} = require('node:url');
const {dom, Element, all, text} = require('./settings-accounts-check.cjs');
const tick = () => new Promise(r => setImmediate(r));
(async () => {
  dom();
  const create=document.createElement;
  document.createElement=tag=>{const el=create(tag);el.styleCalls=[];el.style.setProperty=(key,value)=>el.styleCalls.push([key,value]);return el;};
  const base = path.resolve(__dirname, '../frontend/vendor/coucou/hub');
  const pages = await import(pathToFileURL(path.join(base, 'data-pages.js')));
  const {dictationPage, flowSettingsPage} = await import(pathToFileURL(path.join(base, 'dictation-pages.js')));
  const {FlowBridge, setInvoke} = await import(pathToFileURL(path.join(base, 'flow-shim.js')));
  const {hero} = await import(pathToFileURL(path.join(base, 'hero.js')));
  let data, calls = [], fail = '', refuse = '', leave;
  const totals = words => ({words, seconds:60, dictations:3, wordsPerMinute:70, minutesSaved:65});
  const reset = () => { data = {words:{words:[],replacements:[]}, snippets:[], styles:[{id:'editor',name:'Editor',style:'natural'}],
    history:[{id:'today',date:Date.now(),text:'Hello today',app:'Editor',words:2,seconds:1},{id:'old',date:Date.now()-86400000,text:'Yesterday words',app:null,words:2,seconds:1}],
    stats:{week:totals(7),month:totals(30),all:totals(3000),streak:4,daily:Array.from({length:30},(_,i)=>[`2026-06-${String(i+1).padStart(2,'0')}`,i]),apps:{Editor:30,Terminal:10}},
    status:{prefs:{enabled:true,key:'right_ctrl',edge:'bottom',mic:'',keepDays:30,cleanup:false,defaultStyle:'natural',summaryEngine:'off'},models:{parakeet:{state:'ready'},downloadMb:612},keys:'ok',platform:'linux',hasClaudeKey:false,mics:[]},running:[{id:'slack',name:'Slack'},{id:'editor',name:'Editor'},{id:'kitty',name:'kitty'}]}; calls=[]; };
  reset();
  setInvoke(async (cmd,{payload:p}) => {
    assert.equal(cmd,'dictation_action'); calls.push(structuredClone(p));
    if (p.action === fail) throw Error('test failure');
    if (p.action === refuse) return {ok:false};
    if (p.action==='running_apps') return structuredClone(data.running);
    if (p.action==='set_prefs') {data.status.prefs={...data.status.prefs,...p.prefs};return p.prefs;}
    if (p.action.startsWith('set_')) {const key=p.action.slice(4); data[key]=structuredClone(p[key]); return {ok:true};}
    if (p.action==='delete_entry') {data.history=data.history.filter(e=>e.id!==p.id);return {ok:true};}
    if (p.action==='clear_history') {data.history=[];return {ok:true};}
    return structuredClone(data[p.action]);
  });
  const ctx = {get status(){return data.status;},hero,navigate(){},refresh:async()=>FlowBridge.status(),setPrefs:async change=>{const p={...data.status.prefs};change(p);await FlowBridge.setPrefs(p);},set onLeave(fn){leave=fn;}};
  const mount = async name => { leave?.(); const root=new Element('div'); await (pages[name] || {dictationPage,flowSettingsPage}[name])(root,ctx);await tick();return root; };
  const find = (root,tag,label) => {const el=all(root).find(e=>e.tagName===tag && (e.textContent===label || e.attrs.placeholder===label || e.attrs.title===label));assert(el,`${tag}: ${label}`);return el;};
  const click=(r,label,trusted=true)=>find(r,'button',label).fire('click',trusted);
  const inputs=r=>all(r).filter(e=>e.tagName==='input');
  const writes=()=>calls.filter(p=>p.action.startsWith('set_')||['delete_entry','clear_history'].includes(p.action));
  let root=await mount('dictionaryPage');
  assert.equal(root.children[0].className,'hub-hero','no extra blank rows precede the upstream hero');
  assert.equal(all(root).filter(e=>e.className==='hub-card').length,2);assert(text(root).includes('Sustituciones'));assert(text(root).includes('Los nombres y palabras'));
  inputs(root)[0].value='Supabase'; click(root,'Añadir',false);inputs(root)[0].fire('keydown',false,{key:'Enter'});await tick();assert.deepEqual(writes(),[]);
  inputs(root)[0].fire('keydown',true,{key:'Enter'});await tick();assert.deepEqual(writes().at(-1),{action:'set_words',words:{words:['Supabase'],replacements:[]}});
  inputs(root)[0].value='SUPABASE';inputs(root)[0].fire('keydown',true,{key:'Enter'});await tick();assert.equal(writes().length,1,'case-insensitive word dedupe');
  click(root,'Eliminar');await tick();assert.deepEqual(data.words.words,[]);
  for(const [from,to] of [['cloud code','Claude Code'],['CLOUD CODE','Claude']]) {inputs(root)[1].value=from;inputs(root)[2].value=to;inputs(root)[2].fire('keydown',true,{key:'Enter'});await tick();}
  assert.equal(data.words.replacements.length,1);assert.equal(data.words.replacements[0].to,'Claude');assert.match(data.words.replacements[0].id,/^[A-Za-z0-9_-]{1,64}$/);
  fail='set_words';inputs(root)[0].value='Failure';inputs(root)[0].fire('keydown',true,{key:'Enter'});await tick();assert.equal(calls.at(-1).action,'words');assert(!text(root).includes('Failure'));assert(text(root).includes('No se pudo completar'));fail='';
  for(const invalid of ['x','invalid!','a'.repeat(81)]) {calls=[];inputs(root)[0].value=invalid;inputs(root)[0].fire('keydown',true,{key:'Enter'});await tick();assert.deepEqual(calls,[]);assert(text(root).includes('Límite'));
  }
  data.words.words=Array.from({length:500},(_,i)=>`Word ${i}`);root=await mount('dictionaryPage');calls=[];inputs(root)[0].value='Overflow';inputs(root)[0].fire('keydown',true,{key:'Enter'});await tick();assert.deepEqual(calls,[]);
  data.words.replacements=Array.from({length:500},(_,i)=>({id:`r${i}`,from:`from${i}`,to:'to'}));root=await mount('dictionaryPage');calls=[];inputs(root)[1].value='extra';inputs(root)[2].value='to';inputs(root)[2].fire('keydown',true,{key:'Enter'});await tick();assert.deepEqual(calls,[]);
  root=await mount('snippetsPage');assert(text(root).includes('Nuevo fragmento'));{const form=all(root).find(e=>e.className==='hub-card'&&all(e).some(n=>n.tagName==='textarea'));assert(form.hidden,'0.2.1 L2 (Fragmentos: A): the editor is closed until asked');click(root,'Nuevo fragmento');assert(!form.hidden);click(root,'Cancelar');assert(form.hidden);}
  let trigger=inputs(root)[0], content=all(root).find(e=>e.tagName==='textarea');trigger.value='signature';content.value='Regards';click(root,'Guardar',false);await tick();assert.equal(data.snippets.length,0);
  click(root,'Guardar');await tick();const id=data.snippets[0].id;assert.deepEqual(writes().at(-1),{action:'set_snippets',snippets:[{id,trigger:'signature',text:'Regards'}]});
  click(root,'Editar');trigger.value='edited';content.value='New text';click(root,'Guardar');await tick();assert.deepEqual(data.snippets,[{id,trigger:'edited',text:'New text'}]);
  trigger.value='edited';content.value='duplicate';calls=[];click(root,'Guardar');await tick();assert.deepEqual(calls,[]);assert(text(root).includes('Límite'));
  fail='set_snippets';click(root,'Eliminar');await tick();assert.equal(calls.at(-1).action,'snippets');assert(text(root).includes('New text'));assert(text(root).includes('No se pudo completar'));fail='';
  click(root,'Eliminar');await tick();assert.deepEqual(data.snippets,[]);
  for(const [tr,tx] of [['x'.repeat(81),'text'],['ok','x'.repeat(4001)],['   ','text']]){trigger.value=tr;content.value=tx;calls=[];click(root,'Guardar');await tick();assert.deepEqual(calls,[]);}
  data.snippets=Array.from({length:200},(_,i)=>({id:`s${i}`,trigger:`trigger${i}`,text:'text'}));root=await mount('snippetsPage');inputs(root)[0].value='extra';all(root).find(e=>e.tagName==='textarea').value='text';calls=[];click(root,'Guardar');await tick();assert.deepEqual(calls,[]);
  { // 0.2.1 T3 (S7, L2): explanations are ⓘ tips, the labels are the approved short ones
    const tips = r => all(r).filter(e => e.attrs.role === 'tooltip').map(e => e.textContent);
    root=await mount('insightsPage'); assert(tips(root).some(x => x.includes('45 palabras por minuto')),'time saved: the 45 wpm comparison is an ⓘ'); assert(!text(root).includes('vs typing')&&text(root).includes('Dónde dictás · acumulado'));
    assert(tips(root).some(x => x.includes('hasta 30 días')),'«Todo» says it charts up to 30 days');
    root=await mount('dictionaryPage'); assert(tips(root).length>=2,'words and replacements explained by ⓘ'); assert(all(root).some(e=>e.attrs.placeholder==='Se escucha')&&all(root).some(e=>e.attrs.placeholder==='Se escribe'));
    root=await mount('snippetsPage'); assert(all(root).some(e=>e.attrs.placeholder==='Cuando digo')&&all(root).some(e=>e.attrs.placeholder==='Pegá esto'));
    data.status.hasClaudeKey=false; let went=null; root=await mount('stylesPage'); assert(text(root).includes('Ir a Chat'),'missing key links to Chat');
  }
  root=await mount('stylesPage');assert.equal(all(root).filter(e=>e.className==='hub-card').length,2);assert(text(root).includes('Falta clave de Claude')&&text(root).includes('Envía texto a Anthropic'),'0.2.1 L2: the key warning and where the text goes stay visible, short');calls=[];
  // L32b: without a saved Claude key the clean-up switch is disabled and the warning shows; with one it is a real switch.
  const sw = r => all(r).find(e=>e.tagName==='button'&&String(e.className).includes('switch'));
  assert(sw(root).disabled,'no Claude key: switch disabled');
  for(const e of all(root).filter(e=>e.disabled)){e.fire('click');e.fire('change');}await tick();assert.deepEqual(calls,[]);
  data.status.hasClaudeKey=true;root=await mount('stylesPage');calls=[];
  assert(!sw(root).disabled,'Claude key saved: switch enabled');
  assert.equal(all(root).find(e=>String(e.className).includes('hub-warn')).hidden,true,'warning hidden once the key is saved');
  sw(root).fire('click',false);await tick();assert.deepEqual(calls,[]);
  sw(root).fire('click');await tick();assert.deepEqual(writes().at(-1),{action:'set_prefs',prefs:{enabled:true,key:'right_ctrl',edge:'bottom',mic:'',keepDays:30,cleanup:true,defaultStyle:'natural'}});
  // Add an app: the open apps not already styled come from running_apps and are added with the default style.
  const add = all(root).find(e=>e.tagName==='select'&&e.children.some(o=>String(o.textContent).includes('Añadir una app')));
  assert(add&&!add.disabled,'add-an-app is real now');
  add.fire('focus');await tick();assert(calls.some(p=>p.action==='running_apps'));
  assert.deepEqual(add.children.map(o=>o.attrs.value).filter(Boolean),['slack\nSlack','kitty\nkitty'].filter(Boolean).concat([]).slice(0,2),'editor already has a style');
  data.status.hasClaudeKey=false;data.status.prefs.cleanup=false;root=await mount('stylesPage');calls=[];
  const selects=all(root).filter(e=>e.tagName==='select');selects[0].value='polished';selects[0].fire('change',false);await tick();assert.deepEqual(calls,[]);selects[0].fire('change');await tick();assert.deepEqual(writes().at(-1),{action:'set_prefs',prefs:{enabled:true,key:'right_ctrl',edge:'bottom',mic:'',keepDays:30,cleanup:false,defaultStyle:'polished'}});
  selects[2].value='verbatim';selects[2].fire('change');await tick();assert.deepEqual(writes().at(-1),{action:'set_styles',styles:[{id:'editor',name:'Editor',style:'verbatim'}]});
  fail='set_styles';click(root,'Eliminar');await tick();assert.equal(calls.at(-1).action,'styles');assert(text(root).includes('Editor'));assert(text(root).includes('No se pudo completar'));fail='';click(root,'Eliminar');await tick();assert.deepEqual(data.styles,[]);
  root=await mount('insightsPage');assert.equal(all(root).filter(e=>e.className==='hub-stat').length,4);assert.equal(all(root).find(e=>e.className==='hub-bars').children.length,30);assert(text(root).includes('Palabras por día'));const bars=all(root).find(e=>e.className==='hub-bars');assert.deepEqual(bars.children[0].styleCalls,[['height','0%']]);assert.deepEqual(bars.children.at(-1).styleCalls,[['height','100%']]);assert(text(root).includes('75 %'));calls=[];click(root,'Semana');assert.equal(all(root).find(e=>e.className==='hub-bars').children.length,7);click(root,'Todo');assert.equal(all(root).find(e=>e.className==='hub-bars').children.length,30);assert.deepEqual(calls,[],'periods use the open-page snapshot');
  root=await mount('dictationPage');assert.deepEqual(all(root).filter(e=>e.className==='hub-day').map(e=>e.textContent),['Hoy','Ayer']);assert(!text(root).includes(new Intl.NumberFormat('es').format(3000))&&!text(root).includes('Ilimitado'),'0.2.1 L2 (Dictado: A): the history stands alone, no totals');
  const search=inputs(root)[0];search.value='yesterday';search.fire('input');assert.equal(all(root).filter(e=>e.className==='hub-entry').length,1);search.value='missing';search.fire('input');assert(text(root).includes('Ningún dictado coincide'));search.value='';search.fire('input');
  calls=[];click(root,'Copiar',false);click(root,'Eliminar',false);await tick();assert.deepEqual(calls,[]);
  click(root,'Copiar');await tick();assert.deepEqual(calls,[{action:'copy_entry',id:'today'}]);calls=[];
  click(root,'Eliminar');await tick();assert.deepEqual(calls,[{action:'delete_entry',id:'today'}]);
  root=await mount('flowSettingsPage');calls=[];click(root,'Borrar el historial',false);click(root,'Borrar todo',false);await tick();assert.deepEqual(calls,[]);click(root,'Borrar el historial');await tick();assert.deepEqual(calls,[{action:'clear_history',everything:false}]);calls=[];
  click(root,'Borrar todo');assert(text(root).includes('¿Borrar el historial y las estadísticas?'));assert.deepEqual(calls,[]);click(root,'Cancelar');assert(!text(root).includes('¿Borrar el historial y las estadísticas?'));click(root,'Borrar todo');click(root,'Borrar todo',false);await tick();assert.deepEqual(calls,[]);click(root,'Borrar todo');await tick();assert.deepEqual(calls,[{action:'clear_history',everything:true}]);
  leave();calls=[];click(root,'Borrar el historial');await tick();assert.deepEqual(calls,[],'disposed page cannot write');
  reset();
  root=await mount('dictionaryPage');inputs(root)[1].value='a'.repeat(201);inputs(root)[2].value='written';calls=[];inputs(root)[2].fire('keydown',true,{key:'Enter'});await tick();assert.deepEqual(calls,[]);
  // Count Unicode scalars rather than UTF-16 units.
  inputs(root)[0].value='\u{10400}'.repeat(80);inputs(root)[0].fire('keydown',true,{key:'Enter'});await tick();assert.equal(data.words.words[0].length,160);
  refuse='set_words';inputs(root)[0].value='Refused';inputs(root)[0].fire('keydown',true,{key:'Enter'});await tick();assert.equal(calls.at(-1).action,'words');assert(!text(root).includes('Refused'));refuse='';
  leave();calls=[];inputs(root)[0].value='After leaving';inputs(root)[0].fire('keydown',true,{key:'Enter'});await tick();assert.deepEqual(calls,[]);
  root=await mount('stylesPage');const other=all(root).filter(e=>e.tagName==='select')[0];other.value='verbatim';other.fire('change');assert.equal(other.value,'verbatim');await tick();assert.equal(other.value,'verbatim');
  fail='set_prefs';other.value='polished';other.fire('change');await tick();assert.equal(other.value,'verbatim');assert.equal(calls.at(-1).action,'status');assert(text(root).includes('No se pudo completar'));fail='';
  data.styles=Array.from({length:101},(_,i)=>({id:`a${i}`,name:'App',style:'natural'}));root=await mount('stylesPage');calls=[];const perAppSelect=all(root).filter(e=>e.tagName==='select')[2];perAppSelect.value='polished';perAppSelect.fire('change');await tick();assert.deepEqual(calls,[]);assert(text(root).includes('Límite'));
  reset();root=await mount('dictationPage');fail='delete_entry';click(root,'Eliminar');await tick();assert.equal(calls.at(-1).action,'history');assert.equal(all(root).filter(e=>e.className==='hub-entry').length,2);assert(text(root).includes('No se pudo completar'));fail='';
  root=await mount('flowSettingsPage');fail='clear_history';click(root,'Borrar todo');click(root,'Borrar todo');await tick();assert(text(root).includes('No se pudo completar'));assert(text(root).includes('¿Borrar el historial y las estadísticas?'));fail='';
  // Stale open-page reads must not attach controls after navigation.
  leave();let release;setInvoke(()=>new Promise(r=>{release=r;}));const late=new Element('div');const opening=pages.dictionaryPage(late,ctx);leave();release({words:[],replacements:[]});await opening;assert.equal(all(late).filter(e=>e.tagName==='button').length,0);
  // Execute the real entry guard, independent of the bridge's trusted callers.
  const entry=fs.readFileSync(path.resolve(__dirname,'../frontend/settings-app.js'),'utf8').replace(/^import .*;\n/gm,'');
  const forwarded=[], context={window:{__TAURI__:{core:{invoke:async(_c,a)=>forwarded.push(a.payload)}}},document:{getElementById:()=>({})},setInvoke(){},startHub:async()=>{},inactivePages:{},dictationPage(){},flowSettingsPage(){},voicePage(){},...pages,TextEncoder};
  vm.runInNewContext(entry+'\nglobalThis.closedInvoke=invoke;',context);
  const good=[...['history','stats','words','snippets','styles'].map(action=>({action})),{action:'delete_entry',id:'a_-9'},{action:'clear_history',everything:false},{action:'set_words',words:{words:['Word'],replacements:[{id:'r',from:'a',to:'b'}]}},{action:'set_snippets',snippets:[{id:'s',trigger:'a',text:'b'}]},{action:'set_styles',styles:[{id:'a',name:'App',style:'natural'}]}];
  for(const payload of good){await context.closedInvoke('dictation_action',{payload});assert.deepEqual(forwarded.pop(),payload);await assert.rejects(context.closedInvoke('dictation_action',{payload:{...payload,extra:1}}));}
  const bad=[...['hands_free','finish','cancel','copy'].map(action=>({action})),{action:'delete_entry',id:''},{action:'delete_entry',id:'a'.repeat(65)},{action:'delete_entry',id:'é'},{action:'delete_entry',id:'a b'},{action:'clear_history',everything:0},{action:'set_words',words:{words:[],replacements:[{id:'r',from:'a',to:'b',extra:0}]}},{action:'set_words',words:{words:[7],replacements:[]}},{action:'set_words',words:{words:[]}},{action:'set_snippets',snippets:[{id:'s',trigger:'a',text:7}]},{action:'set_styles',styles:[{id:'a',name:'App',style:'natural',extra:0}]}];
  bad.push({action:'delete_entry',id:'id\n'},{action:'set_words',words:{words:new Array(1),replacements:[]}},{action:'set_snippets',snippets:new Array(1)},{action:'set_styles',styles:new Array(1)});
  for(const payload of bad)await assert.rejects(context.closedInvoke('dictation_action',{payload}));assert.deepEqual(forwarded,[]);
  await context.closedInvoke('dictation_action',{payload:{action:'running_apps'}});assert.deepEqual(forwarded.pop(),{action:'running_apps'});await assert.rejects(context.closedInvoke('dictation_action',{payload:{action:'running_apps',extra:1}}));
  assert.equal(FlowBridge.copy,undefined);
  setInvoke(async (_cmd,{payload}) => {if(payload.action===fail)throw Error('test failure');return {ok:true};});
  for(const name of ['setWords','setSnippets','setStyles','deleteEntry','clear']){fail={setWords:'set_words',setSnippets:'set_snippets',setStyles:'set_styles',deleteEntry:'delete_entry',clear:'clear_history'}[name];await assert.rejects(FlowBridge[name]({}));}fail='';
  for(const file of ['data-pages.ts','dictation-pages.ts'])assert(!/innerHTML|setAttribute\(['"]style/.test(fs.readFileSync(path.join(base,file),'utf8')));
  console.log('PASS settings-data-pages: upstream structure/copy, CRUD IPC, guards, recovery, limits, periods/history/privacy and disposal');
})().catch(e=>{console.error(e);process.exitCode=1;});
