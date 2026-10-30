'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.value = ''; this.className = ''; this.dataset = {};
    this.style = { setProperty() {} };
    this.classList = { contains: c => this.className.split(' ').includes(c), add: c => { this.className += ` ${c}`; }, toggle: (c, on) => { const s = new Set(this.className.split(' ')); if (on === undefined) on = !s.has(c); if (on) s.add(c); else s.delete(c); this.className = [...s].join(' '); } };
  }
  setAttribute(k,v) { assert.notEqual(k, 'style'); this.attrs[k] = String(v); if (['value','type','id'].includes(k)) this[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  get ownerDocument() { return global.document; }
  append(...nodes) { this.children.push(...nodes); }
  prepend(...nodes) { this.children.unshift(...nodes); }
  appendChild(node) { this.append(node); return node; }
  replaceChildren(...nodes) { this.children = nodes; }
  removeChild(n) { this.children.splice(this.children.indexOf(n),1); }
  get firstChild() { return this.children[0]; }
  addEventListener(k,f,capture) { (this.listeners[k] ||= []).push({f,capture}); }
  querySelectorAll(tag) { return all(this).filter(e => e !== this && (e.tagName === tag || tag === 'input' && e.tagName === 'input')); }
  focus() {}
  fire(k, trusted = true, props = {}) { const e = { target: this, isTrusted: trusted, preventDefault() {}, stopImmediatePropagation() { this.stopped = true; }, ...props }; for (const {f} of [...(this.listeners[k] || [])].sort((a,b) => Number(!!b.capture)-Number(!!a.capture))) { f(e); if (e.stopped) break; } }
}
const all = e => [e, ...e.children.flatMap(all)];
const text = e => [e.textContent || '', ...e.children.map(text)].join(' ');
function dom() { global.document = { createElement: t => new Element(t), createElementNS: (_,t) => new Element(t), documentElement: { lang: 'es' }, body: new Element('body'), addEventListener() {} }; }
module.exports = { Element, all, text, dom };
if (require.main === module) (async () => {
  dom();
  const { renderAccounts, renderModels } = await import(pathToFileURL(path.resolve(__dirname, '../frontend/vendor/coucou/hub/accounts.js')));
  const V = require('../frontend/settings-view.js');
  let state = { connection: 'connected', ownedAccounts: { accounts: [] }, providers: [], accounts: [], auth: {}, connectors: { items: [] } };
  const calls = [], events = {}, timers = [];
  let ui, modelListing = {profiles:[]};
  const invoke = async (cmd, {payload}) => {
    if (payload.action === 'abito_account_create') assert.equal(all(ui).find(e => e.attrs.id === 'account-secret').value, '', 'account key cleared BEFORE invoke');
    if (payload.action === 'set' && cmd === 'secret_action') assert.equal(all(ui).find(e => e.attrs.id === `key-input-${payload.key}`).value, '', 'keychain field cleared BEFORE invoke');
    calls.push([cmd, payload]);
    if (cmd === 'secret_action') return { present: payload.action === 'set' };
    if (cmd === 'daemon_action') return { outcome: 'restarted' };
    if (cmd === 'prefs_action') return { chosenModels: {} };
    if (cmd === 'models_action') return structuredClone(modelListing);
    return structuredClone(state);
  };
  const options = { invoke, V, page: 'all', listen: async (name,f) => { events[name] = f; return () => { delete events[name]; }; }, timers: { setTimeout: (f,ms) => { timers.push({f,ms}); return timers.length; }, clearTimeout() {} } };
  ui = await renderAccounts(options); await ui.settled();
  assert(calls.some(([c,p]) => c === 'agent_action' && p.action === 'view'));
  assert(!calls.some(([c,p]) => c === 'agent_action' && ['connectors_list','agents_list','hooks_preview'].includes(p.action)), 'removed connectors never query the host');
  assert(timers.some(t => t.ms === V.CONNECT_WAIT_MS));
  assert.deepEqual(calls.filter(([c]) => c === 'secret_action').map(([,p]) => p), V.KEY_IDS.map(id => V.keyPayload('present', id)));
  // #503 S26: the login buttons now read «Conectar…» on the card; the closed words API / Auth are their accessible names' ends
  const ACCESSIBLE = { API: /^Conectar con clave de API: /, Auth: /^Conectar con autentificación: /, 'Cerrar sesión': /^Cerrar sesión: / };
  const click = (word, trusted = true) => { const b = all(ui).find(e => e.tagName === 'button' && (e.textContent === word || (ACCESSIBLE[word] && ACCESSIBLE[word].test(e.attrs['aria-label'] || '')))); assert(b, word); b.fire('click', trusted); };
  calls.length = 0; click('Reiniciar', false); await ui.settled(); assert.deepEqual(calls, []);
  click('Reiniciar'); await ui.settled(); assert.deepEqual(calls[0], ['daemon_action', { action: 'restart' }]);
  calls.length = 0; click('Configurar proveedor');
  const field = id => all(ui).find(e => e.attrs.id === id);
  const providerValues = () => all(field('account-provider')).filter(e => e.tagName === 'option').map(e => e.attrs.value ?? e.value);
  assert(!providerValues().includes('custom'), 'HU-041 deferred: a new account offers no custom endpoint preset');
  assert(providerValues().includes('openai'));
  field('account-credential').value = 'set'; field('account-credential').fire('change');
  field('account-secret').value = 'test-only-placeholder';
  field('account-form').fire('submit', false); await ui.settled(); assert.deepEqual(calls, []);
  field('account-form').fire('submit'); await ui.settled();
  const created = calls.find(([c,p]) => c === 'agent_action' && p.action === 'abito_account_create')[1];
  assert.match(created.accountId, /^account-/); assert.equal(created.provider, 'openai');
  assert.deepEqual(created.config, { nombre: 'OpenAI', baseUrl: 'https://api.openai.com/v1', api: 'openai-completions', compat: {}, models: [], defaultModel: '', apiKey: 'test-only-placeholder' });
  calls.length = 0;
  const key = field(`key-input-${V.KEY_IDS[0]}`); key.value = 'test-only-placeholder'; key.fire('input');
  const form = all(ui).find(e => e.tagName === 'form' && all(e).includes(key));
  form.fire('submit', false); await ui.settled(); assert.deepEqual(calls, []);
  key.value = 'test-only-placeholder'; form.fire('submit'); await ui.settled();
  assert.deepEqual(calls.pop(), ['secret_action', V.keyPayload('set', V.KEY_IDS[0], 'test-only-placeholder')]);
  assert(!text(ui).includes('test-only-placeholder'));
  click('Quitar');await ui.settled();assert.deepEqual(calls.pop(),['secret_action',V.keyPayload('clear',V.KEY_IDS[0])]);
  const saved={accountId:'saved-one',provider:'openai',hasCredential:true,config:{nombre:'Guardada',baseUrl:'https://api.openai.com/v1',api:'openai-completions',compat:{supportsStore:false},models:['test-model'],defaultModel:'test-model'}};
  state.ownedAccounts={accounts:[saved]};events['agent:state']({payload:structuredClone(state)});
  click('Editar');field('account-form').fire('submit');await ui.settled();assert.deepEqual(calls.pop(),['agent_action',{action:'abito_account_save',accountId:'saved-one',provider:'openai',config:saved.config}]);
  click('Editar');click('Guardar endpoint');await ui.settled();assert.deepEqual(calls.pop(),['agent_action',{action:'abito_account_endpoint_set',accountId:'saved-one',provider:'openai',config:saved.config}]);
  click('Quitar conexión',false);await ui.settled();assert.deepEqual(calls,[]);click('Quitar conexión');await ui.settled();assert.deepEqual(calls.pop(),['agent_action',{action:'abito_account_remove',accountId:'saved-one'}]);
  const custom={accountId:'mine',provider:'custom',hasCredential:false,config:{nombre:'Mio',baseUrl:'https://llm.example/v1',api:'openai-completions',compat:{},models:[],defaultModel:''}};
  state.ownedAccounts={accounts:[custom]};events['agent:state']({payload:structuredClone(state)});
  click('Editar');assert(providerValues().includes('custom'),'a saved custom account still renders its provider');assert.equal(field('account-provider').value,'custom');
  click('Cancelar');await ui.settled();
  assert(!text(ui).includes('Conectores'));
  assert(text(ui).includes('Claves'));
  ui.dispose(); assert.equal(Object.keys(events).length, 0);
  ui = await renderAccounts({ ...options, page: 'integrations' }); await ui.settled(); calls.length = 0;
  assert(!text(ui).includes('Conectores')); assert(!text(ui).includes('Claves')); assert(!text(ui).includes('Configurar proveedor'));
  ui.dispose(); assert.equal(Object.keys(events).length, 0);
  calls.length = 0;
  ui = await renderAccounts({ ...options, page:'chat', keys:false }); await ui.settled();
  assert(!text(ui).includes('Claves'), 'Coucou key controls own the Chat page; no duplicate key editor');
  assert(!calls.some(([cmd]) => cmd === 'secret_action'), 'the additional account section does not re-query keys');
  assert(text(ui).includes('Configurar proveedor') && text(ui).includes('Otros endpoints'), 'saved/custom account functionality remains available in one card');
  for (const removed of ['Configuración de proveedores', 'Buscar proveedor', 'Conectores', 'Claves']) assert(!text(ui).includes(removed), removed);
  ui.dispose();
  // Frame-driven authentication: reuse the existing account, never invent a command.
  state = { connection:'connected', providers:[{id:'anthropic',name:'Anthropic',methods:['api_key','oauth'],configured:false}], accounts:[{accountId:'personal',provider:'anthropic',label:'Personal',authMethod:'none',configured:false}], ownedAccounts:{accounts:[]}, auth:{} };
  ui = await renderAccounts(options); await ui.settled(); calls.length = 0;
  click('API',false); await ui.settled(); assert.deepEqual(calls,[]);
  click('API'); await ui.settled(); assert.deepEqual(calls.pop(),['agent_action',{action:'auth_start',accountId:'personal',method:'api_key'}]);
  state.auth = { flowId:'flow-one',prompt:{flowId:'flow-one',promptId:'prompt-one',kind:'input',message:'API key',secret:true} };
  events['agent:state']({payload:structuredClone(state)});
  const replyInput = field('settings-secret'); assert.equal(replyInput.attrs.type,'password'); replyInput.value='test-only-auth';
  // An unrelated push preserves the actual masked DOM field, not a secret snapshot.
  events['agent:state']({payload:{connection:'connected'}}); assert.equal(field('settings-secret'),replyInput);
  const replyForm=all(ui).find(e=>e.tagName==='form'&&all(e).includes(replyInput));
  replyForm.fire('submit',false); await ui.settled(); assert.deepEqual(calls,[]);
  replyForm.fire('submit'); assert.equal(replyInput.value,''); await ui.settled();
  assert.deepEqual(calls.pop(),['agent_action',{action:'auth_reply',flowId:'flow-one',promptId:'prompt-one',value:'test-only-auth'}]);
  click('Cancelar');await ui.settled();assert.deepEqual(calls.pop(),['agent_action',{action:'auth_cancel',flowId:'flow-one'}]);
  state.auth={flowId:'flow-one',event:{kind:'url',url:'https://example.com/device',userCode:'TEST-CODE'}};
  events['agent:state']({payload:structuredClone(state)});assert(text(ui).includes('Abrir enlaces no está disponible'));assert(!calls.some(([c])=>c==='open_chat_url'));
  ui.dispose();assert.equal(replyInput.value,'');
  state.auth={};state.accounts=[];
  ui=await renderAccounts(options);await ui.settled();calls.length=0;click('Auth');await ui.settled();assert.deepEqual(calls.pop(),['agent_action',{action:'account_create',provider:'anthropic',label:'Anthropic'}]);
  state.accounts=[{accountId:'new-account',provider:'anthropic',label:'Anthropic',authMethod:'none',configured:false}];events['agent:state']({payload:structuredClone(state)});await ui.settled();assert.deepEqual(calls.pop(),['agent_action',{action:'auth_start',accountId:'new-account',method:'oauth'}]);
  state.auth={flowId:'flow-two',prompt:{flowId:'flow-two',promptId:'choice',kind:'select',message:'Elegir',options:[{id:'one',label:'Opción uno'}]}};events['agent:state']({payload:structuredClone(state)});click('Opción uno');await ui.settled();assert.deepEqual(calls.pop(),['agent_action',{action:'auth_reply',flowId:'flow-two',promptId:'choice',value:'one'}]);
  state.auth={flowId:'flow-two',prompt:{flowId:'flow-two',promptId:'confirm',kind:'confirm',message:'Confirmar'}};events['agent:state']({payload:structuredClone(state)});click('Sí');await ui.settled();assert.deepEqual(calls.pop(),['agent_action',{action:'auth_reply',flowId:'flow-two',promptId:'confirm',value:'yes'}]);
  state.auth={last:{ok:true}};state.providers[0].configured=true;state.accounts[0].configured=true;events['agent:state']({payload:structuredClone(state)});click(V.LOGOUT_WORD);await ui.settled();assert.deepEqual(calls.pop(),['agent_action',{action:'account_logout',accountId:'new-account'}]);
  ui.dispose();
  modelListing={profiles:[{profile_id:'local-one',alias:'Local uno',selectable:true,gate:{state:'ready'}}]};
  calls.length = 0;
  ui = await renderModels({ ...options, C: require('../frontend/chat-view.js') }); await ui.settled();
  assert(calls.some(([c,p]) => c === 'models_action' && p.action === 'refresh'));
  assert(calls.some(([c,p]) => c === 'agent_action' && p.action === 'models_list'));
  calls.length = 0; click('Actualizar', false); await ui.settled(); assert.deepEqual(calls, []);
  click('Actualizar'); await ui.settled(); assert.deepEqual(calls.pop(), ['models_action', {action:'refresh'}]);
  calls.length=0;click('Elegir',false);await ui.settled();assert.deepEqual(calls,[]);click('Elegir');await ui.settled();assert.deepEqual(calls.pop(),['models_action',{action:'select',profile_id:'local-one'}]);
  state.models=[{provider:'anthropic',id:'model-one',name:'Modelo uno'}];events['agent:state']({payload:structuredClone(state)});calls.length=0;
  const modelRow=all(ui).find(e=>e.className==='hub-row'&&text(e).includes('Modelo uno'));assert(modelRow);all(modelRow).find(e=>e.tagName==='button').fire('click');await ui.settled();assert.deepEqual(calls.pop(),['prefs_action',V.chosenModelsPayload(V.chosenToggle({},'anthropic','model-one'),'anthropic')]);
  ui.dispose();
  // Execute the entry's actual allow-list without loading any legacy DOM renderer.
  const fs = require('node:fs'), vm = require('node:vm');
  const entry = fs.readFileSync(path.resolve(__dirname,'../frontend/settings-app.js'),'utf8');
  const forwarded=[];
  const context={window:{__TAURI__:{core:{invoke:async(c,a)=>{forwarded.push([c,a]);}}}},document:{getElementById:()=>new Element('div')},startHub:async()=>{},inactivePages:{},renderUnavailable(){},renderAccounts(){},renderModels(){},renderPills(){},renderAppearance(){},setInvoke(){},dictationPage(){},flowSettingsPage(){},dictionaryPage(){},snippetsPage(){},stylesPage(){},insightsPage(){},voicePage(){}};
  vm.runInNewContext(entry.replace(/^import .*;\n/gm,'')+'\nglobalThis.closedInvoke=invoke;',context);
  await context.closedInvoke('daemon_action',{payload:{action:'restart'}});assert.equal(forwarded.length,1);
  for(const args of [{payload:{action:'status'}},{payload:{action:'restart',extra:true}},{payload:{action:'restart'},extra:true},{}]) await assert.rejects(context.closedInvoke('daemon_action',args),/No disponible/);
  await assert.rejects(context.closedInvoke('open_chat_url',{payload:{url:'https://example.com'}}),/No disponible/);
  await assert.rejects(context.closedInvoke('desktop_action',{}),/No disponible/);
  for(const [cmd,file] of [['models_action','modelshost.rs'],['specialists_action','specialistshost.rs'],['secret_action','secretshost.rs'],['daemon_action','settingshost.rs']]) {
    const src=fs.readFileSync(path.resolve(__dirname,'../src',file),'utf8'); const body=src.slice(src.indexOf(`async fn ${cmd}(`));assert(body.includes('bridge::sender_ok(webview.label(), &url)?'));assert(!body.split('#[tauri::command]')[0].includes('main_window_only'));
  }
  console.log('PASS settings-accounts: account/key clearing, exact payloads, trusted guards, asks/timers, lifecycle, models');
})().catch(e => { console.error(e); process.exitCode = 1; });
