'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.className = '';
    this.style = { setProperty() {} };
    this.classList = { add: c => { this.className += ` ${c}`; }, contains: c => this.className.split(' ').includes(c), toggle: (c, on) => {
      const s = new Set(this.className.split(' ')); if (on) s.add(c); else s.delete(c); this.className = [...s].join(' ');
    } };
  }
  setAttribute(k, v) { assert.notEqual(k, 'style'); this.attrs[k] = String(v); if (k === 'value') this.value = String(v); }
  append(...nodes) { this.children.push(...nodes); }
  removeChild(n) { this.children.splice(this.children.indexOf(n), 1); }
  get firstChild() { return this.children[0]; }
  addEventListener(k, f, capture) { (this.listeners[k] ||= []).push({ f, capture }); }
  querySelectorAll(tag) { return all(this).filter(e => e !== this && e.tagName === tag); }
  fire(k, trusted = true, props = {}) {
    const e = { target: this, isTrusted: trusted, preventDefault() {}, stopImmediatePropagation() { this.stopped = true; }, ...props };
    for (const { f } of [...(this.listeners[k] || [])].sort((a, b) => Number(!!b.capture) - Number(!!a.capture))) { f(e); if (e.stopped) break; }
  }
}
const all = e => [e, ...e.children.flatMap(all)];
const text = e => [e.textContent || '', ...e.children.map(text)].join(' ');
(async () => {
  global.document = { createElement: t => new Element(t), createElementNS: (_, t) => new Element(t), documentElement: { lang: 'es' }, body: new Element('body') };
  Object.defineProperty(global, 'navigator', { value: { userAgent: 'Linux' }, configurable: true });
  const base = path.join(root, 'frontend/vendor/coucou/hub');
  const { FLOW_PAGES, NOTCH_PAGES, startHub } = await import(pathToFileURL(path.join(base, 'shell.js')));
  const { renderGeneral } = await import(pathToFileURL(path.join(base, 'general.js')));
  const hash = text => crypto.createHash('sha256').update(text).digest('hex');
  const css = fs.readFileSync(path.join(base, 'hub.css'), 'utf8').split('\n').slice(1).join('\n');
  assert.equal(hash(css), '9f63d2944c7e4e267c863a8121b48e64a3cf7609fcaf24573f84c87c182f2ed8');
  const upstreamUi = fs.readFileSync(path.join(base, 'ui.ts'), 'utf8').split('\n').slice(1).join('\n')
    .replace('"../views/dom.js"', '"../views/dom"').replace('"./i18n-es.js"', '"../i18n/i18n"')
    .replace('"./flow-shim.js"', '"../core/flow"').replace('the keys the app suggests.', 'the keys Coucou suggests.');
  assert.equal(hash(upstreamUi), '67c5f63da4a672ddc74649f28fe17f032d49af5bbb1efcddbbc6eaea46ea6269');
  assert.deepEqual(FLOW_PAGES.map(p => [p.id, p.icon]), [['dictation','mic'],['notes','record'],['insights','chart'],['dictionary','book'],['snippets','bolt'],['styles','text'],['flowsettings','sliders']]);
  assert.deepEqual(NOTCH_PAGES.map(p => [p.id,p.icon]), [['general','gear'],['integrations','puzzle'],['agents','terminal'],['chat','chat'],['voice','wave'],['phone','phone'],['shortcuts','keyboard'],['privacy','lock']]);
  const events = {};
  global.window = { __TAURI__: { event: { listen: async (name, handler) => { events[name] = handler; return () => {}; } } } };
  const pages = [], host = new Element('div');
  await startHub(host, { version: 'test', flowPages: {}, renderNotch: async p => { pages.push(p); } });
  const items = all(host).filter(e => e.className.split(' ').includes('hub-item'));
  // 0.1.2 (human: «vale todo lo que este en pausa se puede ocultar?» → yes; supersedes 26-oct «Visibles en gris y apagadas»):
  // only Chat, Agentes, General, Atajos and Privacidad are in the menu; every paused page is HIDDEN and never opened
  // (not by click, hub-page, abito:hub-select or initialPage: those land on General)
  const ACTIVE = ['general', 'agents', 'chat', 'shortcuts', 'privacy'];
  const PAUSED = [...FLOW_PAGES, ...NOTCH_PAGES].map(p => p.id).filter(id => !ACTIVE.includes(id));
  assert.deepEqual(items.map(e => e.children[1].textContent), ['General','Agentes','Chat','Atajos','Privacidad'], 'paused pages are not in the menu');
  assert.deepEqual(items.map(e => e.attrs?.['data-page']), ['general','agents','chat','shortcuts','privacy'], 'each entry names its page');
  assert(!all(host).some(e => e.className === 'hub-paused' || (e.className || '').split(' ').includes('paused')), 'no grey «En pausa» rows');
  const { PAUSED_PAGES } = await import(pathToFileURL(path.join(base, 'shell.js')));
  assert.deepEqual([...PAUSED_PAGES].sort(), [...PAUSED].sort(), 'the single source of truth is unchanged');
  assert.deepEqual(pages, ['general'], 'the window opens on General, never on a paused page');
  for (const item of items) { item.fire('click'); await Promise.resolve(); }
  assert.deepEqual(pages.slice(1), ACTIVE, 'every entry opens its page');
  events['hub-page']({ payload: 'dictation' }); await Promise.resolve(); await Promise.resolve();
  assert.equal(pages.at(-1), 'general', 'hub-page to a paused page lands on General, not a blank');
  events['hub-page']({ payload: 'chat' }); await Promise.resolve();
  events['hub-page']({ payload: 'settings' }); await Promise.resolve(); await Promise.resolve();
  assert.equal(pages.at(-1), 'general', 'the legacy settings alias (flowsettings, paused) lands on General');
  events['hub-page']({ payload: 'chat' }); await Promise.resolve();
  events['hub-page']({ payload: 'future-page' }); await Promise.resolve();
  assert.equal(pages.at(-1), 'chat', 'an unknown id never moves the window');
  events['hub-page']({ payload: 'privacy' }); await Promise.resolve();
  assert.equal(pages.at(-1), 'privacy');
  const hostB = new Element('div'), pagesB = [];
  await startHub(hostB, { version: 'test', initialPage: 'voice', flowPages: {}, renderNotch: async p => { pagesB.push(p); } });
  assert.deepEqual(pagesB, ['general'], 'a paused initialPage falls back to General');
  const pausedCss = fs.readFileSync(path.join(base, 'abito.css'), 'utf8');
  assert(!/\.hub-item\.paused|\.hub-paused/.test(pausedCss), 'the grey paused styles are gone');
  assert.deepEqual(all(host).filter(e => e.className === 'hub-group').map(e => e.textContent), ['Notch'], 'a group with no active page has no header');
  const status = all(host).find(e => e.className === 'hub-status');
  // 0.1.2: dictation is paused, so its status line is hidden from the sidebar (the line itself still tracks the real status)
  assert.equal(status.hidden, true, 'the paused dictation status line is not shown');
  assert.match(pausedCss, /\.hub-status\[hidden\]\s*\{[^}]*display:\s*none/, 'hidden really hides it (hub.css gives .hub-status its own display)');
  assert(['Comprobando el dictado…', 'Dictado desactivado'].includes(status.children[1].textContent), 'until the real status lands the line says it is checking, never a made-up «off»');
  // the window no longer waits for the dictation status (#503): the real answer repaints the same line
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
  assert.equal(status.children[0].className, 'dot');
  assert.equal(status.children[1].textContent, 'Dictado desactivado');
  assert.equal(all(host).find(e => e.className === 'hub-version').textContent, 'Koda test');
  for (const cls of ['hub-panel', 'hub-scroll', 'hub-page', 'hub-hero']) assert(all(host).some(e => e.className === cls));
  assert(!/Coucou|Mochi/.test(text(host)));
  const { t: hubT, N_ } = await import(pathToFileURL(path.join(base, 'i18n-es.js')));
  assert.equal(hubT('Future English key'), 'Future English key');
  assert.equal(N_('Future English key'), 'Future English key');
  assert.equal(hubT('Ready · hold {0}', { 0: 'Ctrl' }), 'Listo · mantén Ctrl');
  const html = fs.readFileSync(path.join(root, 'frontend/settings.html'), 'utf8');
  assert(html.includes('lang="es"')); assert(html.includes('<title>Ajustes</title>'));
  assert(!/\sstyle\s*=|<style\b/i.test(html));
  assert.equal((html.match(/<script\b/g) || []).length, 2);
  assert(/<script type="module" src="\.\/settings-app\.js"><\/script>/.test(html));
  for (const css of ['settings/settings.css', 'hub/hub.css']) assert(html.includes(`vendor/coucou/${css}`));
  const entry = fs.readFileSync(path.join(root, 'frontend/settings-app.js'), 'utf8');
  // HU-045 (human: «veo que la version que me sale es esta Abito 0.1.0»): the version is the package's, set by Rust before the
  // page runs (window.__abitoVersion), never a literal written in the page.
  assert.doesNotMatch(entry, /version:\s*['"]\d/, 'no hardcoded version literal in Ajustes');
  assert.match(entry, /version:\s*window\.__abitoVersion\b/, 'the shell gets the package version Rust hands the window');
  assert(entry.includes("import { renderAgentSettings }")); assert(entry.includes("import { renderChatSettings }"));
  assert.equal(entry.match(/const allowed = new Set\(([^;]+)\);/)[1], "['prefs_action', 'hotkey_action', 'settings_window_action', 'agent_action', 'secret_action', 'oauth_action', 'models_action', 'specialists_action', 'daemon_action', 'pi_install_action', 'plan_action', 'recap_action', 'monitor_action', 'sound_action', 'dictation_action', 'voice_action', 'failure_action']", 'only closed host commands, including subscription OAuth and the closed «Instalar Pi» command of HU-046');
  const guardCalls = [], guardContext = { window: { __TAURI__: { core: { invoke: async (...args) => guardCalls.push(args) } } }, document: {getElementById: () => ({})},
    setInvoke() {}, dictationPage() {}, flowSettingsPage() {}, dictionaryPage() {}, snippetsPage() {}, stylesPage() {}, insightsPage() {}, voicePage() {}, inactivePages: {}, startHub: async () => {}, TextEncoder };
  require('node:vm').runInNewContext(entry.replace(/^import .*;\n/gm, '') + '\nglobalThis.closedInvoke = invoke;', guardContext);
  const seven = { enabled:true,key:'right_ctrl',edge:'bottom',mic:'',keepDays:30,cleanup:false,defaultStyle:'natural' };
  for (const payload of [{action:'status'}, {action:'download_model'}, {action:'remove_model'}, {action:'running_apps'}, {action:'set_prefs',prefs:seven}, {action:'set_prefs',prefs:{...seven,cleanup:true}}]) {
    await guardContext.closedInvoke('dictation_action', {payload}); assert.deepEqual(guardCalls.pop(), ['dictation_action',{payload}]);
  }
  for (const payload of [{action:'hands_free'}, {action:'finish'}, {action:'cancel'}, {action:'status',extra:1}, {action:'download_model',prefs:seven},
    {action:'set_prefs',prefs:{...seven,cleanup:'true'}}, {action:'set_prefs',prefs:{...seven,cleanup:1}}, {action:'running_apps',extra:1}, {action:'set_prefs',prefs:{...seven,summaryEngine:'off'}}, {action:'set_prefs',prefs:{...seven,voice:false}},
    {action:'set_prefs',prefs:{...seven,keepDays:90}}, {action:'set_prefs',prefs:{...seven,enabled:1}}, {action:'set_prefs',prefs:{...seven,key:'wayland'}},
    {action:'set_prefs',prefs:{...seven,edge:'top'}}, {action:'set_prefs',prefs:{...seven,mic:'é'.repeat(101)}}, {action:'set_prefs',prefs:{...seven,defaultStyle:'other'}},
    {action:'set_prefs',prefs:Object.fromEntries(Object.entries(seven).filter(([k])=>k!=='mic'))}, {action:'set_prefs',prefs:[]}, {action:'set_prefs',prefs:seven,extra:0}]) await assert.rejects(guardContext.closedInvoke('dictation_action',{payload}));
  for (const args of [undefined, {}, {payload:{action:'status'},extra:1}, {payload:null}, {payload:[]}]) await assert.rejects(guardContext.closedInvoke('dictation_action',args));
  assert.deepEqual(guardCalls, [], 'dictation guard rejects extras, malformed preferences and capture actions before IPC');
  for(const payload of [{action:'autostart_view'},{action:'set_autostart',enabled:true},{action:'set_open_settings_at_launch',enabled:false}]) {
    await guardContext.closedInvoke('prefs_action',{payload});assert.deepEqual(guardCalls.pop(),['prefs_action',{payload}]);
  }
  for(const payload of [{action:'autostart_view',enabled:false},{action:'set_autostart',enabled:'yes'},{action:'set_autostart',enabled:true,extra:1},{action:'set_open_settings_at_launch',enabled:null}]) await assert.rejects(guardContext.closedInvoke('prefs_action',{payload}));
  assert.deepEqual(guardCalls,[],'startup malformed payloads never cross IPC');
  assert(entry.includes("command === 'recap_action'"), 'closed recap guard');
  assert(entry.includes("['claude', 'codex'].includes(args.payload.action)"), 'plan_action payload guard');
  assert(entry.includes('set_show_plan_in_notch') && entry.includes('set_show_codex_plan_in_notch'), 'exact plan-in-notch pref guards');
  for (const file of ['agents.ts','chat.ts','integrations.ts','shortcuts.ts','recap.ts']) {
    const source = fs.readFileSync(path.join(base,file),'utf8');
    assert(!/innerHTML|setAttribute\(['"]style|console\.|localStorage|sessionStorage/.test(source), file);
    assert(!/call\(['"](?:hooks_apply|statusline_preview|statusline_apply|local_connect|open_chat_url)/.test(source), file);
  }
  const gate = fs.readFileSync(path.join(root, 'src/bridge.rs'), 'utf8');
  assert(gate.includes('tauri://localhost/settings.html'));
  const native = fs.readFileSync(path.join(root, 'src/settingswindow.rs'), 'utf8');
  assert(native.includes('WebviewUrl::App(std::path::PathBuf::from("settings.html"))'));
  const V = require('../frontend/settings-view.js');
  let prefs = { sound: true, gain: .12, autoCloseSeconds: 15, openOnHover: false, declaredPills: [], pillColors: {}, mainPill: 'integration_claude', theme: 'system', displayName: '', monitor: 'DP-1' };
  const calls = []; let autostart = false; let rejectAutostart = false; let rejectGain = false; let rejectReveal = false; let customSounds = ['finish', 'greet'];
  const invoke = async (cmd, { payload: p }) => {
    calls.push([cmd, p]);
    if (cmd === 'prefs_action' && p.action === 'autostart_view') return {enabled:autostart};
    if (cmd === 'prefs_action' && p.action === 'set_autostart') { if(rejectAutostart) throw Error('write refused'); autostart=p.enabled; return {enabled:autostart}; }
    if (cmd === 'recap_action') return p.action === 'prefs' ? {enabled:true} : {ok:true};
    if (cmd === 'monitor_action') return { monitors: [{ key: 'DP-1', x: 0, y: 0, width: 1920, height: 1080 }, { key: 'HDMI-1', x: 1920, y: 0, width: 1280, height: 720 }] };
    if (cmd === 'sound_action' && p.action === 'reveal' && rejectReveal) throw Error('xdg-open failed');
    if (cmd === 'sound_action') return p.action === 'list' ? { names: customSounds } : { ok: true };
    if (cmd === 'hotkey_action') return { combo: 'Ctrl+Space', enabled: true, status: 'active' };
    if (p.action === 'sound_off') prefs.sound = false;
    if (p.action === 'sound_on') prefs.sound = true;
    if (p.action === 'clear_monitor') prefs.monitor = null;
    if (p.action === 'set_monitor') prefs.monitor = p.monitor;
    if (p.action === 'set_sound_gain') { if (rejectGain) throw Error('simulated write failure'); prefs.gain = p.gain; }
    if (p.action === 'set_absence_seconds') prefs.absenceSeconds = p.seconds;
    if (p.action === 'set_theme') prefs.theme = p.theme;
    if (p.action === 'set_display_name') prefs.displayName = p.display_name;
    if (p.action === 'set_island_interaction') { prefs.autoCloseSeconds = p.auto_close_seconds; prefs.openOnHover = p.open_on_hover; }
    return structuredClone(prefs);
  };
  const ui = await renderGeneral({ invoke, V }); await ui.settled();
  assert(calls.some(([c,p])=>c==='recap_action'&&p.action==='prefs'));
  assert(calls.some(([c,p])=>c==='monitor_action'&&p.action==='list'&&Object.keys(p).length===1), 'real display list');
  assert(calls.some(([c,p])=>c==='sound_action'&&p.action==='list'&&Object.keys(p).length===1), 'custom sound count');
  calls.length = 0;
  assert.equal(ui.firstChild.tagName, 'section', 'General is made of settings sections (#503 S18: three task cards)');
  assert.deepEqual(all(ui).filter(e => e.tagName === 'h2').map(text), [' Apariencia', ' Isla', ' Sonido']);
  assert.deepEqual(all(ui).filter(e => e.tagName === 'label').map(e => e.textContent), ['Idioma','Tema','Nombre visible','Abrir al iniciar sesión','Abrir Ajustes al abrir Koda','Abrir al pasar el cursor','Plegar tras (s)','Ocultar plegada tras (s)','La isla vive en','Atajo global','Resumen semanal','','Sonido']);
  // #503 S18: the theme IS a segmented control now (the MD's «Oscuro / Claro / Sistema»); it must be the only one
  assert.equal(all(ui).filter(e => e.className === 'hub-segmented').length, 1);
  for (const id of ['hub-language']) {
    const el = all(ui).find(e => e.attrs.id === id); assert(el?.disabled, id);
    el.fire(el.tagName === 'select' ? 'change' : 'click'); await ui.settled(); assert.deepEqual(calls, []);
  }
  assert(text(ui).includes('No disponible todavía'));
  assert(!text(ui).includes('0 means never'), 'D6: Coucou shows no such line under Auto-close');
  assert.equal(all(ui).find(e=>e.attrs.id==='hub-language').children.length,11);
  const field = id => all(ui).find(e => e.attrs.id === id);
  assert.equal(String(field('hub-absence').value), '10');
  field('hub-absence').value='45'; field('hub-absence').fire('change', false); await ui.settled(); assert.deepEqual(calls, []);
  field('hub-absence').fire('change'); await ui.settled(); assert.deepEqual(calls.pop(), ['prefs_action',{action:'set_absence_seconds',seconds:45}]);
  assert.equal(prefs.absenceSeconds, 45);
  assert(!field('hub-autostart').disabled, 'startup toggle is usable');
  field('hub-autostart').fire('click', false); await ui.settled(); assert.equal(autostart,false);
  field('hub-autostart').fire('click'); await ui.settled(); assert.equal(autostart,true);
  assert.equal(field('hub-autostart').attrs['aria-pressed'],'true');
  rejectAutostart=true; field('hub-autostart').fire('click'); await ui.settled();
  assert.equal(autostart,true); assert.equal(field('hub-autostart').attrs['aria-pressed'],'true');
  assert(text(ui).includes('No se pudo guardar')); rejectAutostart=false;
  field('hub-autostart').fire('click'); await ui.settled(); assert.equal(autostart,false);
  const reopened=await renderGeneral({invoke,V}); await reopened.settled();
  assert.equal(all(reopened).find(e=>e.attrs.id==='hub-autostart').attrs['aria-pressed'],'false'); reopened.dispose(); calls.length=0;
  // 5a: real display list and custom sounds on the existing closed hosts.
  assert.deepEqual(field('hub-screen').children.map(e => e.attrs.value), ['primary', 'cursor', 'DP-1', 'HDMI-1'], 'monitor_action list feeds the select');
  assert(field('hub-screen').children[1].disabled, 'cursor-following stays unavailable');
  assert(text(ui).includes('2 personalizados'), 'custom sound count from sound_action list');
  for (const id of ['hub-sounds-folder', 'hub-sounds-reload']) assert(!field(id).disabled, id);
  field('hub-sounds-folder').fire('click', false); await ui.settled(); assert.deepEqual(calls, []);
  field('hub-sounds-folder').fire('click'); await ui.settled(); assert.deepEqual(calls.splice(0), [['sound_action', { action: 'reveal' }]]);
  // L42 F3: when the file manager cannot be opened the page says so, in words about the FOLDER (never «No se pudo guardar»)
  rejectReveal = true; field('hub-sounds-folder').fire('click'); await ui.settled();
  assert(text(ui).includes('No se pudo abrir la carpeta de sonidos'), 'a failed open is said');
  assert(text(ui).includes('sounds'), 'and the folder name is given so it can be opened by hand');
  assert(!text(ui).includes('No se pudo guardar.'), 'never the save wording for a folder that did not open');
  rejectReveal = false; field('hub-sounds-folder').fire('click'); await ui.settled();
  assert(!text(ui).includes('No se pudo abrir la carpeta'), 'the note clears on the next success');
  calls.length = 0;
  customSounds = ['finish']; field('hub-sounds-reload').fire('click', false); await ui.settled(); assert.deepEqual(calls, []);
  field('hub-sounds-reload').fire('click'); await ui.settled();
  assert.deepEqual(calls.splice(0), [['sound_action', { action: 'reload' }], ['sound_action', { action: 'list' }]]);
  assert(text(ui).includes('1 personalizados'));
  calls.length = 0;
  field('hub-recap').fire('click',false);await ui.settled();assert.deepEqual(calls,[]);
  field('hub-recap').fire('click');await ui.settled();assert.deepEqual(calls.pop(),['recap_action',{action:'set_enabled',enabled:false}]);
  field('hub-recap-clear').fire('click',false);await ui.settled();assert.deepEqual(calls,[]);
  field('hub-recap-clear').fire('click');await ui.settled();assert.deepEqual(calls.pop(),['recap_action',{action:'clear'}]);
  field('hub-sound').fire('click', false); await ui.settled(); assert.deepEqual(calls, []);
  field('hub-sound').fire('click'); await ui.settled(); assert.deepEqual(calls.pop(), ['prefs_action', { action: 'sound_off' }]);
  field('hub-sound').fire('click'); await ui.settled(); assert.deepEqual(calls.pop(), ['prefs_action', { action: 'sound_on' }]);
  assert.equal(field('hub-screen').value,'DP-1');
  field('hub-screen').value='primary'; field('hub-screen').fire('change',false); await ui.settled(); assert.deepEqual(calls,[]);
  field('hub-screen').fire('change'); await ui.settled(); assert.deepEqual(calls.pop(),['prefs_action',{action:'clear_monitor'}]);
  field('hub-screen').value='DP-1'; field('hub-screen').fire('change'); await ui.settled(); assert.deepEqual(calls.pop(),['prefs_action',{action:'set_monitor',monitor:'DP-1'}]);
  field('hub-screen').value='cursor'; field('hub-screen').fire('change'); await ui.settled(); assert.deepEqual(calls,[]);
  field('hub-screen').value='HDMI-1'; field('hub-screen').fire('change'); await ui.settled(); assert.deepEqual(calls.pop(),['prefs_action',{action:'set_monitor',monitor:'HDMI-1'}], 'a listed display is selectable');
  const vol = field('hub-volume'); vol.value = '0.08'; vol.fire('input', false); await ui.settled(); assert.equal(calls.length, 0);
  vol.fire('input'); await ui.settled(); assert.deepEqual(calls.pop(), ['prefs_action', { action: 'set_sound_gain', gain: .08 }]);
  assert.equal(field('hub-volume'), vol, 'live volume must not replace the slider during a drag');
  vol.value = '0.055'; vol.fire('input'); vol.value = '0.025'; vol.fire('input'); await ui.settled();
  assert.equal(prefs.gain, .025, 'last live value wins'); calls.length = 0;
  vol.fire('change'); await ui.settled(); assert.equal(prefs.gain, .025); calls.length = 0;
  assert.equal(field('hub-volume'), vol, 'keyboard change must preserve focus and the live slider too');
  field('hub-hover').fire('click'); await ui.settled(); assert.deepEqual(calls.pop(), ['prefs_action', { action: 'set_island_interaction', auto_close_seconds: 15, open_on_hover: true }]);
  assert.equal(field('hub-motion'), undefined, 'no inert motion toggle');
  assert(text(ui).includes('El movimiento no se puede configurar en Koda.'), 'no claim of a working motion preference');
  assert.equal(calls.length, 0);
  const number = () => all(ui).find(e => e.attrs.type === 'number');
  for (const value of ['4', '121', '2.5', '']) { const n = number(); n.value = value; n.fire('change'); await ui.settled(); assert.deepEqual(calls, []); }
  number().value = '0'; number().fire('change'); await ui.settled();
  assert.deepEqual(calls.pop(), ['prefs_action', { action: 'set_island_interaction', auto_close_seconds: 0, open_on_hover: true }]);
  // #503 S18 (screen validation): the theme is three segmented pills, not a dropdown
  const dark = () => all(all(ui).find(e => e.attrs.id === 'hub-theme')).find(e => e.tagName === 'button' && e.textContent === 'Oscuro');
  dark().fire('click', false); await ui.settled(); assert.deepEqual(calls, []);
  dark().fire('click'); await ui.settled(); assert.deepEqual(calls.pop(), ['prefs_action', { action: 'set_theme', theme: 'dark' }]);
  const name = () => all(ui).find(e => e.attrs['aria-label'] === 'Nombre visible');
  const saveName = () => all(ui).find(e => e.textContent === 'Guardar nombre');
  name().value = 'Ana'; name().fire('input'); saveName().fire('click', false); await ui.settled(); assert.deepEqual(calls, []);
  saveName().fire('click'); await ui.settled(); assert.deepEqual(calls.pop(), ['prefs_action', { action: 'set_display_name', display_name: 'Ana' }]);
  // 0.2.1 (propuesta General): the global shortcut is edited ONLY in Atajos (same hotkey_action, covered by settings-integrations-check); here it is a value and a link
  assert(!all(ui).some(e => e.attrs['aria-label'] === 'Atajo activo' || e.textContent === 'Cambiar' || e.textContent === 'Original'), 'no shortcut editor in General');
  { const link = all(ui).find(e => e.textContent === 'Ir a Atajos'); assert(link, 'link to Atajos'); calls.length = 0; link.fire('click', false); assert.deepEqual(calls, []); }
  const volume = field('hub-volume'); volume.value = '0.04'; volume.fire('change'); volume.value = '0.06'; volume.fire('change'); await ui.settled();
  assert.deepEqual(calls.splice(0), [['prefs_action', { action: 'set_sound_gain', gain: .04 }], ['prefs_action', { action: 'set_sound_gain', gain: .06 }]]);
  rejectGain = true; field('hub-volume').value = '0.1'; field('hub-volume').fire('change'); await ui.settled();
  assert(text(ui).includes('No se pudo guardar.'));
  assert.equal(field('hub-volume').attrs.value, '0.06');
  assert(calls.every(([cmd]) => ['prefs_action','hotkey_action','recap_action','monitor_action','sound_action'].includes(cmd)));
  assert(entry.includes("command === 'monitor_action'") && entry.includes("command === 'sound_action'"), '5a closed guards');
  assert(!/action: 'read'|'read'/.test(fs.readFileSync(path.join(base,'general.ts'),'utf8')), 'general never reads sound bytes');
  const abitoCss = fs.readFileSync(path.join(base, 'abito.css'), 'utf8');
  assert(/\.hub-empty svg\s*\{[^}]*width:\s*64px[^}]*height:\s*64px/.test(abitoCss), 'D2: the empty-state character is sized like Coucou\'s canvas (64px)');
  assert.equal(fs.readFileSync(path.join(base, 'i18n-es.ts'), 'utf8').match(/'Dictation is off': '([^']*)'/)[1], 'Dictado desactivado', 'D5: Coucou\'s own Spanish string');
  // D1: the band's colour and particles are code (Coucou's backdrop), not an Abito flat black.
  {
    const props = [];
    const mk = tag => { const e = new Element(tag); e.style = { setProperty: (k, v) => props.push([tag, k, v]) }; e.getContext = () => null; return e; };
    global.document = { createElement: mk, createElementNS: (_, t) => mk(t), documentElement: { lang: 'es' }, body: new Element('body'), addEventListener() {}, visibilityState: 'hidden' };
    const heroMod = await import(pathToFileURL(path.join(base, 'hero.js')) + '?d1');
    const band = heroMod.hero('dictation', 'Hola', null);
    assert(props.some(([, k, v]) => k === '--hero-line' && v === 'rgba(251,146,60,0.16)'), 'D1: dictation band line is its orange at .16 alpha');
    assert(all(band).some(e => e.tagName === 'canvas' && e.className === 'backdrop'), 'D1: backdrop canvas present');
    props.length = 0; heroMod.hero('chat', 'Chat', null);
    assert(props.some(([, k, v]) => k === '--hero-line' && v === 'rgba(224,121,80,0.16)'), 'D1: chat band uses the chat colour');
    props.length = 0; heroMod.hero('unknown-page', 'x', null);
    assert(props.some(([, k, v]) => k === '--hero-line' && v === 'rgba(142,147,156,0.16)'), 'D1: unknown pages fall back to the general colour');
    props.length = 0; heroMod.glowCard('#FB923C', new Element('div'));
    assert(props.some(([, k, v]) => k === '--glow-line' && v === 'rgba(251,146,60,0.18)'), 'D1: glow card line from its colour');
    const src = fs.readFileSync(path.join(base, 'hero.ts'), 'utf8');
    const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    assert(!/wardrobe|outfit|roundGlasses|sunglasses|partyHat|BotEngine/.test(code), 'D1: no Coucou characters or wardrobe in the ported code');
  }
  console.log('PASS settings-hub: sidebar parity, CSP, page gate, trusted gestures, bridge payloads, volume commit, unavailable motion');
})().catch(e => { console.error(e); process.exitCode = 1; });
