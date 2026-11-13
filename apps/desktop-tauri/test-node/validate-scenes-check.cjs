'use strict';
const assert = require('node:assert/strict');
const { classify, extraScenes, hubPages } = require('../packaging/validate/scenes.cjs');
const expected = ['integracion-github', 'correo-keyring', 'spotify-reproductor', 'sonidos-controles', 'sonidos-audible', 'dictado-sin-modelo', 'voz-sin-modelo', 'voz-reconocimiento', 'bandeja-menu', 'autoinicio', 'personaje-escritorio', 'chat-segundo-turno', 'dictado-inactivo', 'sesiones-motor', 'sin-motor-sin-productor', 'sin-motor-con-productor', 'pi-aviso', 'pi-pregunta'];
for (const name of expected) assert(extraScenes.includes(name), `missing ${name}`);
for (const page of ['general','chat','integrations','shortcuts','voice','dictation','flowsettings','dictionary','snippets','styles','insights','phone']) assert(hubPages.includes(page), `missing hub page ${page}`);
// K2-03 S1: the Notetaker page is removed from the hub and from the packaging scene list.
assert(!hubPages.includes('notes'), 'no notes page in the packaging scene list');
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
  const fs = require('node:fs');
  const path = require('node:path');
  const clicks = [];
  const element = (x, shown) => ({
    disabled: false, scrollIntoView() {}, addEventListener() {},
    getBoundingClientRect: () => ({ x, y: 10, width: shown() ? 20 : 0, height: shown() ? 20 : 0 }),
    closest: () => null,
  });
  // The island ignores blob clicks while it is busy (pills-view onScreen: a question outcome is on screen for 3-4 s after an answer). The GitHub
  // scene runs right after «pi-pregunta», so it must WAIT for the calm overview before it clicks the icon (gate: the click was dropped and the
  // card never opened). The capsule below reads «outcome» for its first reads, then calm.
  let capsuleReads = 0;
  const capsule = { dataset: new Proxy({}, { get: (_t, key) => { capsuleReads += 1; const calm = capsuleReads > 6; return { phase: 'expanded', view: 'overview', question: calm ? '' : 'outcome' }[key]; } }) };
  const calmNow = () => capsuleReads > 6;

  // K2-11 S5/S6: GitHub is a card of the shortcuts row (island-shortcuts.js), not a pill of the column and not the overview's left card. The
  // scene may only drive what the cards render today: the row's icon, the #nusa-card host, the three .gh-tile counters, a .gh-row list,
  // .gh-back and the .gh-strip of the contribution graph.
  let focused = false, section = 'pulse';
  // x is the element's left edge and the trusted click lands in its centre (+10), so the emitted payload.x is x+10
  const githubIcon = element(10, () => !focused);
  const cardHost = element(80, () => focused);
  const tile = (key, x) => { const el = element(x, () => focused && section === 'pulse'); el.getAttribute = name => (name === 'data-tile' ? key : null); return el; };
  const tiles = [tile('review', 140), tile('pr', 150), tile('issue', 160)];
  const back = element(170, () => focused && section === 'pr');
  const strip = element(180, () => focused && section === 'pulse');
  const list = element(190, () => focused && section === 'pr');
  Object.defineProperty(cardHost, 'textContent', { get: () => (section === 'pr' ? 'Tus PR · 1 Fixture PR fallando' : 'GitHub me 1 Revisión pedida 1 Tus PR 0 Issues 23 repos') });
  cardHost.querySelectorAll = selector => (selector === '.gh-tile' && focused && section === 'pulse' ? tiles : []);
  cardHost.querySelector = selector => {
    if (selector === '.gh-pulse-card') return focused ? element(100, () => focused) : null;
    if (selector === '.gh-row') return focused && section === 'pr' ? list : null;
    if (selector === '.gh-back') return section === 'pr' ? back : null;
    if (selector === '.gh-strip') return focused && section === 'pulse' ? strip : null;
    return null;
  };
  const activity = { available: true, activity: { total: 17 } };
  const window = { __validateOrigin: { x: 0, y: 0, scale: 1 }, __TAURI__: {
    core: { invoke: async (command,args) => command === 'prefs_action' ? { declaredPills: [] } : command === 'github_action' ? (args.payload.section === 'pulse' ? { available: true, stats: { totalStars: 18, totalRepos: 23 } } : activity) : {} },
    event: { emit: async (event, payload) => {
      assert.equal(event, 'validate-input'); assert.equal(payload.kind, 'click');
      clicks.push(payload.x);
      if (payload.x === 20) { assert.equal(calmNow(), true, 'the GitHub icon was clicked while the island still showed a question outcome (the click is dropped there)'); focused = true; }
      else if (payload.x === 160) { assert.equal(section, 'pulse', 'a counter of the pulse opens its list'); section = 'pr'; }
      else if (payload.x === 180) { assert.equal(section, 'pr', '「‹ Pulso» only exists on a list'); section = 'pulse'; }
      else assert.fail('unexpected click target');
    } },
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../packaging/validate/browser.js'), 'utf8'), {
    window, document: {
      getElementById: id => ({ capsule })[id],
      querySelector: selector => selector === '#nusa-apps button[data-go="github"]' ? githubIcon : selector === '#nusa-card .gh-host' ? cardHost : null,
    },
    addEventListener() {}, console: { error() {} }, performance,
    setTimeout: fn => { fn(); return 1; }, requestAnimationFrame: fn => fn(),
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
  });
  const result = await window.AbitoValidate.github();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.text, 'GitHub me 1 Revisión pedida 1 Tus PR 0 Issues 23 repos');
  assert.equal(result.data, activity);
  assert.equal(focused, true, 'the pulse stays visible for its PNG; Spotify releases the row');
  assert.deepEqual(clicks, [20, 160, 180], 'the icon, a counter and 「‹ Pulso»: every one a trusted click');
  // F3 (K2-11 verifier): no scene may drive DOM that left the island — the Cal.com agenda and the old GitHub overview card are gone
  const browser = fs.readFileSync(path.join(__dirname, '../packaging/validate/browser.js'), 'utf8');
  for (const gone of ['.gh-card', '.gh-open', '.gh-ci-main', '.gh-spark', '[data-calendar', "button('Semana')", "button('Día')"]) assert(!browser.includes(gone), `a scene still drives removed DOM: ${gone}`);
  console.log('validate-scenes: GitHub scene drives the shortcuts row with trusted input');
})().catch(error => { console.error(error); process.exitCode = 1; });
