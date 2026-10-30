'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { dom, all, text } = require('./settings-accounts-check.cjs');
(async () => {
  dom();
  const base = path.resolve(__dirname, '../frontend/vendor/coucou/hub');
  const { renderAgentSettings } = await import(pathToFileURL(path.join(base, 'agents.js')));
  const { renderChatSettings } = await import(pathToFileURL(path.join(base, 'chat.js')));
  const V = require('../frontend/settings-view.js');
  const C = require('../frontend/chat-view.js');
  const calls = [], events = {};
  const hash = 'a'.repeat(64), hash2 = 'b'.repeat(64), hash3 = 'c'.repeat(64);
  let state = { connection:'connected', agents:[{id:'claude-code',state:'not_connected',plan_hash:hash,summary:'Add managed hooks',reviewable:true},{id:'codex',state:'connected',backup:true},{id:'recap',state:'not_connected',plan_hash:hash2,summary:'Adds notify-only hooks that only count activity for the weekly recap. No command text, path or prompt is kept. A backup is made first.',reviewable:true},{id:'statusline',state:'not_connected',plan_hash:hash3,summary:'Adds the status-line relay in ~/.claude/settings.json. An existing status line keeps working (the relay prints it). A backup is made first.',reviewable:true}], providers:[],accounts:[],models:null };
  const keychain = new Set();
  let ui, secretFailure = false, accountFailure = false; const planPrefs = { claude: false, codex: false };
  const soon = Date.now() + 3600e3;
  let planReply = {
    claude: { available: true, updatedAt: Date.now(), fiveHour: { usedPct: 42, resetsAt: soon }, sevenDay: { usedPct: 61, resetsAt: soon } },
    codex: { available: true, rateLimits: { primary: { usedPercent: 7, resetsAt: Math.floor(soon / 1000), windowDurationMins: 300 }, secondary: { usedPercent: 33, resetsAt: Math.floor(soon / 1000), windowDurationMins: 10080 } } },
  };
  const invoke = async (cmd,{payload:p}) => {
    if (cmd === 'secret_action' && p.action === 'set') assert.equal(all(ui).find(e => e.attrs.id === `chat-key-${p.key}`).value, '', 'clear masked key BEFORE IPC');
    calls.push([cmd,p]);
    if (cmd === 'secret_action') { if (secretFailure) throw new Error('fixture-secret-error'); if (p.action === 'set') keychain.add(p.key); if (p.action === 'clear') keychain.delete(p.key); return {present:keychain.has(p.key)}; }
    if (cmd === 'plan_action') return planReply[p.action];
    if (cmd === 'agent_action' && /^abito_account_/.test(p.action)) { if (accountFailure) throw new Error('fixture-account-error'); const secretNow = p.config?.apiKey; calls.push(['__secret_seen', secretNow ? 'yes' : 'no']); if (p.action === 'abito_account_remove') state.ownedAccounts = { accounts: (state.ownedAccounts?.accounts || []).filter(a => a.accountId !== p.accountId) }; else state.ownedAccounts = { accounts: [...(state.ownedAccounts?.accounts || []).filter(a => a.accountId !== p.accountId), { accountId: p.accountId, provider: p.provider, hasCredential: keychain.has(`${p.provider}-api-key`), config: { nombre: p.config.nombre, baseUrl: p.config.baseUrl, api: p.config.api, compat: {}, models: p.config.models, defaultModel: p.config.defaultModel } }] }; return structuredClone(state); }
    if (cmd === 'prefs_action' && p.action === 'view') return {chosenModels:{}, showPlanInNotch: planPrefs.claude, showCodexPlanInNotch: planPrefs.codex};
    if (cmd === 'prefs_action' && p.action === 'set_show_plan_in_notch') { planPrefs.claude = p.show_plan_in_notch; return {showPlanInNotch: planPrefs.claude, showCodexPlanInNotch: planPrefs.codex}; }
    if (cmd === 'prefs_action' && p.action === 'set_show_codex_plan_in_notch') { planPrefs.codex = p.show_codex_plan_in_notch; return {showPlanInNotch: planPrefs.claude, showCodexPlanInNotch: planPrefs.codex}; }
    if (cmd === 'prefs_action') return {chosenModels:{}};
    if (cmd === 'models_action') return {profiles:[]};
    return structuredClone(state);
  };
  const opts = { invoke,V,C,listen:async (n,f) => {events[n]=f;return () => {delete events[n];};},timers:{setTimeout:()=>1,clearTimeout(){}} };
  const heads = () => all(ui).filter(e => e.tagName === 'h2').map(text).map(s=>s.trim());
  const button = (scope,word) => {const b=all(scope).find(e=>e.tagName==='button'&&e.textContent===word);assert(b,word);return b;};
  ui = await renderAgentSettings(opts); await ui.settled();
  assert.deepEqual(heads().map(h=>h.replace(/\s*ⓘ.*$/,'')), ['Agentes','Uso del plan','Resumen semanal']); // #503 S20: Claude Code is a row of the Agentes table
  assert(calls.some(([c,p])=>c==='agent_action'&&p.action==='hooks_preview'));
  assert(calls.some(([c,p])=>c==='agent_action'&&p.action==='agents_list'));
  const hookList=all(ui).find(e=>e.attrs.id==='agent-hook-list');
  assert(hookList, 'only host-reported agents belong in the expanded upstream list');
  assert.deepEqual(hookList.children.map(e=>e.attrs.id),['agent-row-pi','agent-row-claude-code','agent-row-codex','agent-row-gemini-cli','agent-row-copilot-cli','agent-row-opencode'], 'HU-076: only the agents that work in this version');
  // HU-076 (Human 30-oct («Tambien la parte de agentes de ajustes la podemos diseñar de una manera mucho mas comodo, hay mucho texto y la ui es confusa» → «Ocultar lo no disponible + textos de una línea»)): rows that cannot work in this version are hidden, not greyed
  for(const id of ['hermes','muse','antigravity','cursor','amp']) assert(!all(ui).some(e=>e.attrs.id===`agent-row-${id}`),`${id} hidden`);
  assert(!text(ui).includes('No disponible en esta versión'));
  assert(text(all(ui).find(e=>e.attrs.id==='agent-row-copilot-cli')).includes('GitHub Copilot CLI'));
  const plan=ui.children[1];
  assert(all(plan).filter(e=>e.tagName==='button'&&!String(e.className).includes('switch')&&!String(e.className).includes('hub-info')&&e.textContent!=='Instalar…').every(e=>e.disabled), 'only the relay installer is a live button here');
  assert.deepEqual(calls.filter(([c])=>c==='plan_action'),[], '0.2.1 S5/L4: no plan reads here; Codex plan usage is for 0.3');
  assert(!/\d+ %/.test(text(plan)), 'numbers belong to the island usage view, not to settings');
  assert(text(plan).includes('Claude Code · uso del plan') && !text(plan).includes('Codex'),'only Claude Code plan usage is shown');
  // HU-076: one line per row; the long explanation lives in the ⓘ, never as visible paragraph text
  assert(!all(plan).some(e=>String(e.className).includes('detail')&&text(e).includes('Koda agrega un relay')),'plan explanation is not a visible paragraph');
  assert(all(plan).some(e=>e.attrs['aria-label']==='Más información: Claude Code · uso del plan'),'plan explanation is in an ⓘ');
  assert(all(plan).some(e=>e.attrs.id==='agent-integration-statusline'), 'the relay is an installable integration block');
  const planSwitches=all(plan).filter(e=>e.tagName==='button'&&String(e.className).includes('switch'));
  assert.equal(planSwitches.length,1);assert(planSwitches.every(e=>!e.disabled), 'the plan switch follows its Abito pref');
  calls.length=0;planSwitches[0].fire('click',false);await ui.settled();assert.deepEqual(calls,[],'untrusted click sends nothing');
  planSwitches[0].fire('click');await ui.settled();assert.deepEqual(calls.splice(0),[['prefs_action',{action:'set_show_plan_in_notch',show_plan_in_notch:true}]]);
  planSwitches[0].fire('click');await ui.settled();assert.deepEqual(calls.splice(0),[['prefs_action',{action:'set_show_plan_in_notch',show_plan_in_notch:false}]]);
  calls.length=0;
  const claude=all(ui).find(e=>e.attrs.id==='agent-row-claude-code');
  button(claude,'Instalar…').fire('click',false);await ui.settled();assert.deepEqual(calls,[]);
  button(claude,'Instalar…').fire('click');await ui.settled(); // one trusted click writes the plan the row showed (23-oct)
  assert.deepEqual(calls.filter(([c])=>c==='agent_action'),[['agent_action',{action:'agent_connect',agentId:'claude-code',plan_hash:hash}]]);
  assert(!calls.some(([,p])=>p.action==='hooks_apply'));
  // L32e: the recap hooks and the status-line relay install from Ajustes with the same review-and-confirm flow.
  {
    const section = title => all(ui).find(e=>e.tagName==='section'&&text(e).includes(title));
    const recap = all(ui).find(e=>e.attrs.id==='agent-integration-recap'), relay = all(ui).find(e=>e.attrs.id==='agent-integration-statusline');
    assert(recap&&relay,'both integrations render a block with a stable id');
    assert(text(relay).includes('Relay'));
    calls.length=0;
    button(recap,'Instalar…').fire('click',false);await ui.settled();assert.deepEqual(calls,[]);
    button(recap,'Instalar…').fire('click');await ui.settled();assert.equal(calls.length,0,'opening the review writes nothing');
    assert(text(recap).includes(V.planSummary('Adds notify-only hooks that only count activity for the weekly recap. No command text, path or prompt is kept. A backup is made first.')),'the plan summary is shown before anything is written');
    button(recap,'Respaldar y escribir').fire('click',false);await ui.settled();assert.deepEqual(calls,[]);
    button(recap,'Respaldar y escribir').fire('click');await ui.settled();
    assert.deepEqual(calls,[['agent_action',{action:'agent_connect',agentId:'recap',plan_hash:hash2}]],'the click carries the hash the user saw');
    calls.length=0;
    button(relay,'Instalar…').fire('click');await ui.settled();button(relay,'Respaldar y escribir').fire('click');await ui.settled();
    assert.deepEqual(calls,[['agent_action',{action:'agent_connect',agentId:'statusline',plan_hash:hash3}]]);
    state.agents.find(a=>a.id==='recap').state='connected';state.agents.find(a=>a.id==='recap').backup=true;
    ui.dispose();ui=await renderAgentSettings(opts);await ui.settled();
    const recap2=all(ui).find(e=>e.attrs.id==='agent-integration-recap');calls.length=0;
    button(recap2,'Desinstalar…').fire('click');await ui.settled();button(recap2,'Respaldar y quitar').fire('click');await ui.settled();
    assert.deepEqual(calls,[['agent_action',{action:'agent_disconnect',agentId:'recap'}]]);
    state.agents.find(a=>a.id==='recap').state='not_connected';ui.dispose();ui=await renderAgentSettings(opts);await ui.settled();
  }
  const codex = all(ui).find(e=>e.attrs.id==='agent-row-codex');
  calls.length=0;all(codex).find(e=>e.tagName==='button'&&e.attrs['aria-label']==='Más opciones de Codex').fire('click');button(codex,'Desinstalar…').fire('click');await ui.settled();assert.deepEqual(calls,[]);
  button(codex,'Respaldar y quitar').fire('click',false);await ui.settled();assert.deepEqual(calls,[]);
  button(codex,'Respaldar y quitar').fire('click');await ui.settled();assert.deepEqual(calls,[['agent_action',{action:'agent_disconnect',agentId:'codex'}]]);
  ui.dispose();assert.equal(Object.keys(events).length,0);
  state.agents[0]={id:'claude-code',state:'not_connected',reviewable:true};
  ui=await renderAgentSettings(opts);await ui.settled();
  assert.equal(button(all(ui).find(e=>e.attrs.id==='agent-row-claude-code'),'Instalar…').disabled,true,'no hash never authorizes a write');
  ui.dispose();
  ui=await renderAgentSettings(opts);await ui.settled();
  assert(all(ui.children[1]).some(e=>e.attrs.id==='agent-integration-statusline'), 'available=false: the relay can still be installed');
  assert(all(ui.children[1]).filter(e=>e.tagName==='button'&&String(e.className).includes('switch')).every(e=>!e.disabled), 'the plan switch is a pref, independent of the data');
  ui.dispose();
  state.agents=[];state.hooks=[];
  ui=await renderAgentSettings(opts);await ui.settled();
  // #503 S20: with nothing reported the table still lists Claude Code and Pi (each honest about its state); nothing is invented
  assert.deepEqual(all(ui).find(e=>e.attrs.id==='agent-hook-list').children.map(e=>e.attrs.id),['agent-row-pi','agent-row-claude-code','agent-row-codex','agent-row-gemini-cli','agent-row-copilot-cli','agent-row-opencode']);
  assert(text(all(ui).find(e=>e.attrs.id==='agent-row-claude-code')).includes('No disponible todavía'),'an unreported agent says so');
  assert(!text(ui.children[0]).includes('No disponible todavía No disponible todavía'));
  ui.dispose();
  // HU-015: real rendered rows, daemon down, independent of Pi and engine pushes.
  {
    const previous = state;
    state = { connection:'no_daemon', last_error:{code:'pi_missing'}, agentsRuntime:'ok', directHooks:[], directAgents:[
      {id:'claude-code',state:'not_connected',plan_hash:hash,summary:'Add managed hooks',reviewable:true},
      {id:'codex',state:'connected',backup:true},
      {id:'copilot-cli',state:'not_connected',plan_hash:hash2,summary:'Add managed hooks',reviewable:true},
      {id:'opencode',state:'not_connected',plan_hash:hash3,summary:'Add managed hooks',reviewable:true},
    ] };
    const P = { normalize:() => ({mainPill:'clock',declaredPills:['integration_claude','agent_codex','agent_copilot','agent_opencode']}), toggle:() => true };
    ui=await renderAgentSettings({...opts,P});await ui.settled();
    for (const id of ['claude-code','copilot-cli','opencode']) {
      const row=all(ui).find(e=>e.attrs.id===`agent-row-${id}`);
      assert.equal(button(row,'Instalar…').disabled,false,`${id}: install without Pi/daemon`);
      const sw=all(row).find(e=>String(e.className).includes('switch'));
      assert.equal(sw.disabled,true,`${id}: absent hooks disable its own switch`);
      assert.equal(sw.attrs['aria-pressed'],'false');
    }
    const codex=all(ui).find(e=>e.attrs.id==='agent-row-codex');
    assert.equal(all(codex).find(e=>String(e.className).includes('switch')).disabled,false);
    assert(!text(ui).includes('Falta Pi'));
    calls.length=0;
    button(all(ui).find(e=>e.attrs.id==='agent-row-copilot-cli'),'Instalar…').fire('click');await ui.settled();
    assert.deepEqual(calls,[['agent_action',{action:'agent_connect',agentId:'copilot-cli',plan_hash:hash2}]]);
    events['agent:state']({payload:{connection:'no_daemon',last_error:{code:'pi_missing'},agents:[]}});
    assert.equal(button(all(ui).find(e=>e.attrs.id==='agent-row-opencode'),'Instalar…').disabled,false);
    ui.dispose();state=previous;
  }
  ui=await renderChatSettings(opts);await ui.settled();
  assert.deepEqual(heads().map(h=>h.replace(/ [▾▸]$/,'').replace(/ [✓✗·].*$/,'').replace(/\s*ⓘ.*$/,'')),['Claude','Google AI','OpenAI','OpenRouter','NaN','OpenCode Go','Modelos locales','Contexto de la ventana activa']); // #503 S21: one card per provider
  assert.deepEqual(calls.filter(([c,p])=>c==='secret_action'&&p.action==='present').map(([,p])=>p.key),['anthropic-api-key','google-api-key','openai-api-key','openrouter-api-key','nan-api-key','opencode-go-api-key']);
  for(const id of ['anthropic-api-key','google-api-key','openai-api-key','openrouter-api-key','nan-api-key','opencode-go-api-key']) {
    const input=all(ui).find(e=>e.attrs.id===`chat-key-${id}`);assert.equal(input.type,'password');
    const scope=all(ui).find(e=>e.className==='row'&&e.children.includes(input));
    calls.length=0;input.value='fixture-only';button(scope,id==='anthropic-api-key'?'Guardar clave':'Guardar').fire('click',false);await ui.settled();assert.deepEqual(calls,[]);
    button(scope,id==='anthropic-api-key'?'Guardar clave':'Guardar').fire('click');await ui.settled();
    assert.deepEqual(calls.filter(([c])=>c==='secret_action'),[['secret_action',{action:'set',key:id,value:'fixture-only'}]]); assert(calls.some(([c,p])=>c==='agent_action'&&p.action==='abito_account_create'&&p.accountId.startsWith('key-')),'the key also creates its provider account');
    assert.equal(input.value,'');assert(!text(ui).includes('fixture-only'));
    calls.length=0;button(scope,'Quitar').fire('click',false);await ui.settled();assert.deepEqual(calls,[]);
    button(scope,'Quitar').fire('click');await ui.settled();assert.deepEqual(calls.filter(([c])=>c==='secret_action'),[['secret_action',{action:'clear',key:id}]]);
  }
  // L32b: a saved provider key also becomes a provider account the chat can use (alongside Cuentas).
  {
    const scopeOf = id => all(ui).find(e=>e.className==='row'&&e.children.includes(all(ui).find(x=>x.attrs.id===`chat-key-${id}`)));
    const field = id => all(ui).find(e=>e.attrs.id===`chat-key-${id}`);
    const presets = { 'anthropic-api-key': ['anthropic','Anthropic','https://api.anthropic.com/v1','anthropic-messages'], 'google-api-key': ['google','Google','https://generativelanguage.googleapis.com/v1beta','google-generative-ai'], 'openai-api-key': ['openai','OpenAI','https://api.openai.com/v1','openai-completions'], 'openrouter-api-key': ['openrouter','OpenRouter','https://openrouter.ai/api/v1','openai-completions'] };
    state.ownedAccounts = { accounts: [] };
    for (const [key, [provider, nombre, baseUrl, api]] of Object.entries(presets)) {
      calls.length = 0; field(key).value = 'sk-fixture-1';
      button(scopeOf(key), key === 'anthropic-api-key' ? 'Guardar clave' : 'Guardar').fire('click'); await ui.settled();
      const account = calls.filter(([c]) => c === 'agent_action' && /^abito_account_/.test(c === 'agent_action' ? '' : '')).length;
      const created = calls.find(([c, p]) => c === 'agent_action' && p.action === 'abito_account_create');
      assert(created, `${key} creates its provider account`);
      assert.equal(created[1].accountId, `key-${provider}`); assert.equal(created[1].provider, provider);
      assert.equal(created[1].config.nombre, nombre); assert.equal(created[1].config.baseUrl, baseUrl); assert.equal(created[1].config.api, api);
      assert(!Object.hasOwn(created[1].config, 'apiKey'), 'account carries config only, never the chat key'); assert(created[1].config.models.includes(created[1].config.defaultModel));
      assert.equal(state.ownedAccounts.accounts.find(a => a.accountId === `key-${provider}`).hasCredential, true);
      assert.deepEqual(calls.map(([c, p]) => c === 'secret_action' ? `secret:${p.action}` : c === 'agent_action' ? p.action : c).filter(x => x !== '__secret_seen'), [`secret:set`, 'abito_account_create'], 'keychain first, then the account');
      assert.equal(field(key).value, '', 'field cleared');
      assert(!text(ui).includes('sk-fixture-1'), 'secret never rendered');
    }
    // again: the account exists, so it is saved (key replaced), not created twice
    calls.length = 0; field('openai-api-key').value = 'sk-fixture-2';
    button(scopeOf('openai-api-key'), 'Guardar').fire('click'); await ui.settled();
    const saved = calls.find(([c, p]) => c === 'agent_action' && /^abito_account_/.test(p.action));
    assert.equal(saved[1].action, 'abito_account_save'); assert.equal(saved[1].accountId, 'key-openai'); assert(!Object.hasOwn(saved[1].config, 'apiKey'), 'replacement goes only to the keychain');
    // remove: the keychain entry AND the account we created
    calls.length = 0; button(scopeOf('openai-api-key'), 'Quitar').fire('click'); await ui.settled();
    assert.deepEqual(calls.map(([c, p]) => c === 'secret_action' ? `secret:${p.action}` : p.action).filter(x => x !== undefined), ['secret:clear', 'abito_account_remove']);
    assert.deepEqual(calls.find(([c, p]) => p?.action === 'abito_account_remove')[1], { action: 'abito_account_remove', accountId: 'key-openai' });
    // untrusted click does nothing
    calls.length = 0; field('google-api-key').value = 'sk-x'; button(scopeOf('google-api-key'), 'Guardar').fire('click', false); await ui.settled(); assert.deepEqual(calls, []);
    // an account failure is said, never hidden: the key stays saved
    accountFailure = true; calls.length = 0; field('openrouter-api-key').value = 'sk-fixture-3';
    button(scopeOf('openrouter-api-key'), 'Guardar').fire('click'); await ui.settled();
    assert(text(ui).includes('no se pudo crear la cuenta'), 'honest note when the account step fails'); accountFailure = false;
    state.ownedAccounts = { accounts: [] };
  }
  const anthKey=all(ui).find(e=>e.attrs.id==='chat-key-anthropic-api-key');
  const anthRow=all(ui).find(e=>e.className==='row'&&e.children.includes(anthKey));
  secretFailure=true;anthKey.value='fixture-only';button(anthRow,'Guardar clave').fire('click');await ui.settled();
  assert.equal(anthKey.value,'');assert(!text(ui).includes('fixture-secret-error'));secretFailure=false;
  const pick=all(ui).find(e=>e.attrs.id==='chat-anthropic-model');assert.equal(pick.disabled,true);
  events['agent:state']({payload:{connection:'connected',providers:[{id:'anthropic',name:'Anthropic',configured:true}],accounts:[],models:[{provider:'anthropic',id:'m1',name:'First'},{provider:'anthropic',id:'m2',name:'Second'}]}});
  events['prefs:state']({payload:{chosenModels:{anthropic:['m1']}}});
  assert.equal(pick.tagName,'select');assert.equal(pick.disabled,false);calls.length=0;pick.value='m2';pick.fire('change',false);await ui.settled();assert.deepEqual(calls,[]);
  pick.fire('change');await ui.settled();assert.deepEqual(calls,[['prefs_action',{action:'set_chosen_models',provider:'anthropic',models:['m1','m2']}]]);
  const local=all(ui).find(e=>e.attrs.id==='chat-local-models');
  assert(text(local).includes('Ollama'));assert(text(local).includes('LM Studio'));assert(text(local).includes('Compatible con OpenAI'));
  for(const b of all(local).filter(e=>e.textContent==='Conectar')) assert.equal(b.disabled,true,'arbitrary endpoint connection has no host command');
  const urls=all(local).filter(e=>e.tagName==='input'&&e.type==='text');assert.equal(urls.length,3);
  urls[2].value='http://example.com';urls[2].fire('input');assert(text(local).includes('sin cifrar'));
  anthKey.value='discard-on-navigation';ui.dispose();assert.equal(anthKey.value,'');assert.equal(Object.keys(events).length,0);
  state = {agentsRuntime:'ok', directAgents:[{id:'claude-code', state:'unavailable',detail:'unsupported_platform',backup:false}],directHooks:[]};
  calls.length = 0;
  ui = await renderAgentSettings(opts); await ui.settled();
  const unavailable = all(ui).find(e => e.attrs.id === 'agent-row-claude-code');
  assert(text(unavailable).includes('No disponible en esta plataforma todavía'));
  assert(text(unavailable).includes('La instalación automática todavía no está disponible en Windows.'));
  assert(text(unavailable).includes('README · https://github.com/Alvarogds04/abito#windows-limitations'));
  assert(!calls.some(([cmd]) => cmd === 'open_chat_url'), 'settings cannot invoke the main-window-only Linux opener');
  ui.dispose();
  // Windows report (29-oct): with Node not found by the host (agentsRuntime node_missing/failed) the WHOLE table vanished — a row
  // the host never reports (hermes) was read as undefined after the section had been cleared. Every row still renders.
  for (const runtime of ['node_missing', 'failed']) {
    state = { connection:'no_daemon', agentsRuntime: runtime, directAgents:[], directHooks:[] };
    ui = await renderAgentSettings(opts); await ui.settled();
    const list = all(ui).find(e => e.attrs.id === 'agent-hook-list');
    assert(list, `${runtime}: the agents table is drawn`);
    for (const id of ['pi','claude-code','codex','gemini-cli','copilot-cli','opencode']) assert(all(list).some(e => e.attrs.id === `agent-row-${id}`), `${runtime}: row ${id}`);
    // a later push with the same runtime repaints, never empties the section
    events['agent:state']({ payload: { agentsRuntime: runtime, directAgents: [] } });
    assert(all(ui).find(e => e.attrs.id === 'agent-hook-list'), `${runtime}: still drawn after a push`);
    ui.dispose();
  }
  for(const name of ['agents.ts','chat.ts']) {const src=fs.readFileSync(path.join(base,name),'utf8');assert(!/innerHTML|setAttribute\(['"]style/.test(src));}
  console.log('PASS settings-agents: exact section order, closed hook review, four key payloads, trust, lifecycle and disabled missing backends');
})().catch(e=>{console.error(e);process.exitCode=1;});
