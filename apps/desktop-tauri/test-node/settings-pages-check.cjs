'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { dom, Element, all, text } = require('./settings-accounts-check.cjs');
(async () => {
  dom();
  const base = path.resolve(__dirname, '../frontend/vendor/coucou/hub');
  const { inactivePages, renderUnavailable } = await import(pathToFileURL(path.join(base, 'pages.js')));
  const { hero } = await import(pathToFileURL(path.join(base, 'hero.js')));
  const ids = ['dictation','notes','insights','dictionary','snippets','styles','flowsettings','general','integrations','agents','chat','voice','phone','shortcuts'];
  const invoked = [], disposed = [];
  let config;
  const fake = name => async opts => { invoked.push([name, opts.page]); return Object.assign(new Element('section'), { dispose() { disposed.push(name); } }); };
  const source = fs.readFileSync(path.resolve(__dirname, '../frontend/settings-app.js'), 'utf8').replace(/^import .*;\n/gm, '');
  const host = new Element('div'); document.getElementById = () => host;
  const rawCalls=[];
  const context = { window: {__TAURI__:{core:{invoke:async(c,a)=>{rawCalls.push([c,a]);return {};}}}}, document, inactivePages, renderUnavailable,
    renderAccounts: fake('accounts'), renderModels: fake('models'), renderPills: fake('pills'),
    renderAgentSettings: fake('agent-settings'), renderChatSettings: fake('chat-settings'),
    renderIntegrations: fake('integrations'), renderShortcuts: fake('shortcuts'),
    setInvoke() {}, dictationPage: fake('dictation'), flowSettingsPage: fake('flowsettings'),
    dictionaryPage: fake('dictionary'), snippetsPage: fake('snippets'), stylesPage: fake('styles'), insightsPage: fake('insights'), voicePage: fake('voice'),
    renderGeneral: fake('general'), card: x => x, row: () => new Element('div'),
    startHub: async (_root, opts) => { config = opts; }, Set, Promise };
  vm.runInNewContext(source+'\nglobalThis.closedInvoke = invoke;',context);
  // Main-pill configuration is dormant in Settings, even if a retained renderer tries the old action.
  await assert.rejects(context.closedInvoke('prefs_action', {payload:{action:'set_main_pill',id:'agent_codex'}}), /No disponible/);
  assert.equal(rawCalls.length, 0, 'set_main_pill never crosses the Settings bridge');
  for (const payload of [{action:'prefs'},{action:'set_enabled',enabled:true},{action:'set_enabled',enabled:false},{action:'clear'}]) {
    await context.closedInvoke('recap_action',{payload});assert.deepEqual(rawCalls.pop(),['recap_action',{payload}]);
  }
  for (const args of [undefined,{}, {payload:{action:'view',since:0}}, {payload:{action:'clear',extra:1}}, {payload:{action:'set_enabled',enabled:1}}, {payload:{action:'set_enabled'}}, {payload:{action:'prefs'},extra:1}]) await assert.rejects(context.closedInvoke('recap_action',args));
  for (const command of ['shortcuts_action','spotify_action','flow_status','phone_link_status']) await assert.rejects(context.closedInvoke(command,{}));
  assert.equal(rawCalls.length,0,'unreachable commands and out-of-slice recap verbs never cross IPC');
  for (const id of ids) {
    const container = new Element('div');
    invoked.length = 0;
    if (['dictation','flowsettings','dictionary','snippets','styles','insights'].includes(id)) {
      assert(!inactivePages[id], 'wired FLOW routes are no longer inactive');
      await config.flowPages[id](container, {});
      assert.deepEqual(invoked, [[id, undefined]]);
    } else if (id === 'voice') {
      assert(!inactivePages.voice || config.flowPages.voice !== inactivePages.voice, 'OK Koda is wired (voice-page-check.cjs covers it)');
      continue;
    } else if (config.flowPages[id]) {
      await config.flowPages[id](container, { hero, status: { prefs: { key: 'right_ctrl' }, platform: 'linux', models: { parakeet: { state: 'missing' }, downloadMb: 670 } }, navigate() {}, set onLeave(_) {} });
      assert(all(container).some(e => e.className.includes('hub-hero')), id);
      assert(text(container).includes(id === 'notes' ? 'No disponible todavía' : 'pendiente de conectar'), id);
      if (id === 'notes') {
        // 0.2.1 (propuesta «Notetaker»): «No disponible todavía», nothing that looks like it can record or download.
        assert(all(container).some(e => e.className === 'hub-hero compact'), 'compact band');
        assert(text(container).includes('No disponible todavía'));
        assert(!all(container).some(e => e.tagName === 'button' && !String(e.className).includes('hub-info')), 'no record or download button');
        assert(!all(container).some(e => e.className === 'hub-notes'), 'no calls layout');
      }
      if (id === 'voice') {
        assert.deepEqual(all(container).filter(e=>e.className==='hub-label').map(text),['Escucha','Respuestas','Privacidad']);
        assert.equal(all(container).filter(e=>e.className==='hub-card').length,3);
        assert(text(container).includes('Escuchar « OK Koda »'));
        assert(text(container).includes('Parakeet, en tu ordenador'));
        assert(text(container).includes('Koda responde en voz alta'));
        assert(text(container).includes('Koda nunca envía un correo'));
      }
    } else {
      const cleanup = await config.renderNotch(id, container);
      const expected = {general:[['general',undefined],['pills',undefined]], chat:[['chat-settings',undefined],['accounts','chat'],['models',undefined]], integrations:[['integrations',undefined]], agents:[['pills',undefined],['agent-settings',undefined],['pills',undefined]], shortcuts:[['shortcuts',undefined]]}[id];
      if (expected) { assert.deepEqual(invoked, expected); assert(container.children.length); cleanup?.(); }
      else {
        assert(text(container).includes(id === 'phone' ? 'No disponible' : 'pendiente de conectar'));
        if(id==='phone') {
          assert.deepEqual(all(container).filter(e=>e.tagName==='h2').map(e=>text(e).trim()),['Teléfono Android']);
          assert(text(container).includes('Enlace con el teléfono'));
          // #503 S24: the designed layout (steps, devices, unlink with confirmation) without QR; every control stays inert (checked below for all pages)
          assert(all(container).filter(e=>e.tagName==='button').length>=1);
          assert(!all(container).some(e=>['canvas','img','svg'].includes(e.tagName)),'no QR in 0.2');
        }
      }
    }
    // L42: the voice-model control (Notetaker, OK Koda) is live; everything else is disabled
    for (const e of all(container).filter(e => ['button','input','select','textarea'].includes(e.tagName) && !String(e.className).includes('hub-info') && !(['notes','voice'].includes(id) && String(e.textContent || '').trim() === 'Descargar'))) assert.equal(e.disabled, true, id);
  }
  assert(source.includes("page === 'agents'") && source.includes("part: 'tools'") && source.includes("part: 'island'") && source.includes("part: 'abito'"), '0.2.1 S1 (option B): Agentes composes the main tool, the CLI table, the island switches and the Abito part; Integraciones is the services only');
  assert(disposed.includes('agent-settings') && disposed.includes('chat-settings'), 'new page adapters are disposed');
  const generalSource = fs.readFileSync(path.join(base,'general.ts'),'utf8');
  assert(generalSource.includes('renderRecapRows({ invoke })'), 'General reuses the wired upstream recap rows in their original position');
  assert(disposed.includes('accounts') && disposed.includes('models') && disposed.includes('pills'));
  console.log('PASS settings-pages: 16 routes, mapped renderer lifecycles, inactive controls and hero bands');
})().catch(e => { console.error(e); process.exitCode = 1; });
