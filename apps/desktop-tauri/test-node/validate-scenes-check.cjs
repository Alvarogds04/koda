'use strict';
const assert = require('node:assert/strict');
const { classify, extraScenes, hubPages } = require('../packaging/validate/scenes.cjs');
const expected = ['integracion-github', 'correo-keyring', 'spotify-reproductor', 'sonidos-controles', 'sonidos-audible', 'dictado-sin-modelo', 'voz-sin-modelo', 'voz-reconocimiento', 'bandeja-menu', 'autoinicio', 'personaje-escritorio', 'chat-segundo-turno', 'dictado-inactivo', 'sesiones-motor', 'sin-motor-sin-productor', 'sin-motor-con-productor', 'pi-aviso', 'pi-pregunta'];
for (const name of expected) assert(extraScenes.includes(name), `missing ${name}`);
for (const page of ['general','chat','integrations','shortcuts','voice','dictation','flowsettings','dictionary','snippets','styles','insights','notes','phone']) assert(hubPages.includes(page), `missing hub page ${page}`);
assert.equal(classify({ok:true}).verdict, 'pass');
assert.equal(classify({ok:false,reason:'composer locked'}).verdict, 'fail');
assert.equal(classify({ok:true,errors:['uncaught']}).verdict, 'fail');
assert.equal(classify({}).verdict, 'fail', 'missing evidence cannot pass');
assert.equal(classify({ok:true,unverifiable:'no keyring'}).verdict, 'unverifiable');
assert.equal(classify({ok:false,reason:'blank',unverifiable:'no keyring'}).verdict, 'fail', 'render failure wins over environmental limitation');
assert.equal(classify(null).verdict, 'fail');
assert(extraScenes.includes('ajustes-engranaje'));
for (const page of hubPages) assert(extraScenes.includes(`ajustes-${page}`));
// Detect hub additions rather than silently skipping them.
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../frontend/vendor/coucou/hub/shell.js'), 'utf8');
const ids = [...source.matchAll(/\{ id: "([a-z]+)", icon:/g)].map(m => m[1]);
assert.deepEqual([...hubPages].sort(), ids.sort());
// #503 S26: the Conexiones scene must have its OWN branch: the generic one clicks the first `.switch`, and this page has none (the gate
// failed with «no se encontró control seguro en accounts»). The branch is read-only: it may never press a button of the page.
{
  const browser = fs.readFileSync(path.join(__dirname, '../packaging/validate/browser.js'), 'utf8');
  const at = browser.indexOf("page==='chat'"); assert(at > 0, 'ajustes-chat has no explicit read-only engine branch');
  const branch = browser.slice(at, browser.indexOf("page==='styles'", at));
  assert(/agent_action[^)]*view/.test(branch), 'it reads the host state');
  assert(!/click\(|key\(|daemon_action|account_logout|auth_start|account_create|secret_action|set_prefs/.test(branch), 'the scene must never act: no click, no restart, no login/logout, no key');
  assert(!hubPages.includes('accounts') && !extraScenes.includes('ajustes-accounts'), 'Conexiones is no longer a page');
  assert(extraScenes.includes('ajustes-chat'), 'the read-only engine checks moved to Chat');
  // the island deep link («Configurar Pi…») names this page, and Rust accepts exactly that id
  assert(/PI_SECTIONS, e\.detail\) \|\| e\.detail === 'accounts:oauth'[^\n]*'chat'/.test(fs.readFileSync(path.join(__dirname, '../frontend/settings.js'), 'utf8')), 'the deep link opens the window on Chat');
  const native = fs.readFileSync(path.join(__dirname, '../src/settingswindow.rs'), 'utf8').match(/const PAGES[^=]*= &\[([\s\S]*?)\];/)[1];
  assert(!native.includes('"accounts"') && native.includes('"chat"'), 'Rust admits Chat, not accounts');
}
console.log(`validate-scenes: verdict and catalog checks passed (${extraScenes.length + 6} scenes)`);

// Exercise the real browser scene driver; emulate only the external trusted-input boundary.
(async () => {
  const vm = require('node:vm');
  let focused = false;
  const clicks = [];
  const element = (x, shown) => ({
    disabled: false, textContent: 'GitHub 17', scrollIntoView() {}, addEventListener() {},
    getBoundingClientRect: () => ({ x, y: 10, width: shown() ? 20 : 0, height: shown() ? 20 : 0 }),
    closest: () => null,
  });
  // The island ignores blob clicks while it is busy (pills-view onScreen: a question outcome is on screen for 3-4 s after an answer). The GitHub
  // scene runs right after «pi-pregunta», so it must WAIT for the calm overview before it clicks the row (gate: the click was dropped and the
  // card never opened). The capsule below reads «outcome» for its first reads, then calm.
  let capsuleReads = 0;
  const capsule = { dataset: new Proxy({}, { get: (_t, key) => { capsuleReads += 1; const calm = capsuleReads > 6; return { phase: 'expanded', view: 'overview', question: calm ? '' : 'outcome' }[key]; } }) };
  const calmNow = () => capsuleReads > 6;
  const githubPill = element(10, () => !focused);
  const abitoPill = element(50, () => true);
  const card = element(90, () => focused);
  const control = x => element(x, () => focused);
  let section = 'pulse';
  Object.defineProperty(card,'textContent',{get:()=>section==='pulse'?'GitHub 17 ★ 18 Fixture PR':section==='ci'?'main':'23 repos'});
  card.querySelectorAll = () => [];
  card.querySelector = selector => selector === '.gh-back' && section !== 'pulse' ? control(160) : selector === '.gh-spark' && section === 'pulse' ? control(180) : selector === '.gh-ci-main' && section === 'pulse' ? control(140) : ['.gh-row', '.gh-open'].includes(selector) && ['pulse', 'ci'].includes(section) ? control(200) : null;
  const activity = { available: true, activity: { total: 17 } };
  const window = { __validateOrigin: { x: 0, y: 0, scale: 1 }, __TAURI__: {
    core: { invoke: async (command,args) => command === 'prefs_action' ? { declaredPills: ['integration_github'] } : command === 'github_action' ? (args.payload.section==='pulse'?{available:true,stats:{totalStars:18,totalRepos:23}}:activity) : {} },
    event: { emit: async (event, payload) => {
      assert.equal(event, 'validate-input'); assert.equal(payload.kind, 'click');
      clicks.push(payload.x);
      if (payload.x === 20) { assert.equal(calmNow(), true, 'the GitHub row was clicked while the island still showed a question outcome (the click is dropped there)'); focused = true; }
      else if (payload.x === 60) focused = false;
      else if (payload.x === 150) section='ci';
      else if (payload.x === 170) section='pulse';
      else if (payload.x === 190) section='activity';
      else assert.fail('unexpected click target');
    } },
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../packaging/validate/browser.js'), 'utf8'), {
    window, document: {
      getElementById: id => ({ 'pill-choice-integration_github': githubPill, 'pill-choice-abito': abitoPill, capsule })[id],
      querySelector: selector => selector === '.gh-card' ? card : null,
    },
    addEventListener() {}, console: { error() {} }, performance,
    setTimeout: fn => { fn(); return 1; }, requestAnimationFrame: fn => fn(),
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
  });
  const result = await window.AbitoValidate.github();
  assert.equal(result.ok, true); assert.equal(result.text, 'GitHub 17 ★ 18 Fixture PR'); assert.equal(result.data, activity);
  assert.equal(focused, true, 'GitHub detail stays visible for its PNG; Spotify releases focus');
  assert.deepEqual(clicks, [20, 150, 170, 190, 170], 'focus and cleanup both use the external trusted-click helper');
  console.log('validate-scenes: GitHub scene isolates focus with trusted input');
})().catch(error => { console.error(error); process.exitCode = 1; });
