'use strict';
// Node-only suite, discovered alongside the other test-node/*-check.cjs suites.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const vendor = path.join(root, 'frontend/vendor/coucou');

class Target {
  constructor() { this.listeners = new Map(); }
  addEventListener(k, fn) { if (!this.listeners.has(k)) this.listeners.set(k, new Set()); this.listeners.get(k).add(fn); }
  removeEventListener(k, fn) { this.listeners.get(k)?.delete(fn); }
  fire(k, props = {}) { const e = { target: this, preventDefault() { this.prevented = true; }, ...props }; for (const fn of [...(this.listeners.get(k) || [])]) fn(e); return e; }
  count() { return [...this.listeners.values()].reduce((n, s) => n + s.size, 0); }
}
class Element extends Target {
  constructor(tag) { super(); this.tagName = tag; this.children = []; this.attrs = {}; this.styleCalls = []; this.style = { setProperty: (k, v) => { this.styleCalls.push([k, v]); this.style[k] = v; } }; this.nodeType = 1; this.offsetWidth = 180; }
  setAttribute(k, v) { if (k === 'style') throw new Error("CSP style-src 'self': style attribute forbidden"); this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  append(...nodes) { for (const n of nodes) { n.parent = this; this.children.push(n); } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(n => n !== this); this.parent = null; }
  contains(n) { return n === this || this.children.some(c => c.contains?.(n)); }
  querySelector(selector) { const classes = selector.slice(1).split('.'); return this.children.find(n => classes.every(c => n.className?.split(' ').includes(c))) || null; }
  getBoundingClientRect() { return { left: 1000, bottom: 30 }; }
  focus() { document.activeElement = this; }
}
const document = Object.assign(new Target(), {
  body: new Element('body'), createElement: tag => new Element(tag),
  createTextNode: data => ({ nodeType: 3, data }),
});
global.document = document;
global.window = Object.assign(new Target(), { innerWidth: 320 });
const palette = () => document.body.children.find(n => n.className === 'palette');
const load = file => import(pathToFileURL(path.join(vendor, file)).href);
function hashTree() {
  const hash = crypto.createHash('sha256');
  function walk(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file); else hash.update(path.relative(vendor, file)).update(fs.readFileSync(file)); } }
  walk(vendor); return hash.digest('hex');
}
(async () => {
  // Pure modules must import and run without even the minimal DOM below.
  delete global.document; delete global.window;
  const pills = await load('core/pills.js');
  const keys = await load('core/shortcuts.js');
  const providers = await load('core/providers.js');
  const { N_, t: translate } = await load('i18n/i18n.js');
  assert.equal(N_('Untranslated marker'), 'Untranslated marker');
  assert.throws(() => translate('Untranslated marker'), /Traducción/);
  for (const name of keys.KEY_NAMES) {
    const text = `Ctrl+Alt+Shift+Super+${name}`;
    assert.equal(keys.formatKeys(keys.parseKeys(text)), text);
  }
  assert.equal(keys.normalizeKeys(' option + control + ArrowRight '), 'Ctrl+Alt+Right');
  assert.equal(keys.displayKeys('Super+Right'), 'Win+→');
  for (const text of ['', 'A', 'Shift+A', 'Ctrl', 'Ctrl++A', 'Ctrl+A+B', 'Ctrl+Escape', 'Ctrl+F25', 'Ctrl+Unknown']) {
    assert.equal(keys.parseKeys(text), null, `invalid accelerator: ${text}`);
  }
  assert.deepEqual([...keys.duplicates([['a', 'Control+A'], ['b', 'Ctrl+A'], ['c', 'Alt+A'], ['d', 'invalid']])].sort(), ['a', 'b']);
  const shortcut = keys.SHORTCUTS[0];
  assert.deepEqual(keys.effective(shortcut), { keys: shortcut.defaultKeys, enabled: shortcut.enabledByDefault });
  assert.deepEqual(keys.effective(shortcut, { [shortcut.id]: { keys: '', enabled: false } }), { keys: '', enabled: false });
  assert(!/Coucou|Mochi/i.test(JSON.stringify(keys.SHORTCUT_TEXT)));
  assert.equal(keys.SHORTCUT_TEXT.muteToggle, 'Mute or unmute Koda');
  assert.equal(keys.SHORTCUT_TEXT.desktopToggle, 'Send Koda to the desktop');
  for (const [raw, expected] of [
    ['', 'local'], ['localhost:11434', 'local'], ['http://127.1.2.3', 'local'], ['http://[::1]', 'local'],
    ['https://example.org', 'remote'], ['example.org:8080', 'remote-http'],
    ['ftp://localhost', 'invalid'], ['http://u:p@localhost', 'invalid'], ['http://', 'invalid'], ['not a url', 'invalid'],
  ]) assert.equal(providers.urlExposure(raw), expected, raw);
  for (const host of ['LOCALHOST', 'app.localhost', '127.0.0.2', '0.0.0.0', '[::1]', '::', '::ffff:127.0.0.1', '::ffff:7f00:1']) assert(providers.isLoopbackHost(host), host);
  for (const host of ['localhost.example.org', 'example.org', '192.168.1.1', '::2']) assert(!providers.isLoopbackHost(host), host);
  const settings = { chatProvider: 'anthropic', model: '', chatModels: {}, ollamaUrl: '', lmstudioUrl: '', customUrl: '' };
  assert.equal(providers.activeModel(settings), providers.providerDef('anthropic').defaultModel);
  assert.equal(providers.activeModel(providers.withModel(settings, 'anthropic', 'chosen')), 'chosen');
  const openai = providers.withModel({ ...settings, chatProvider: 'openai' }, 'openai', 'other');
  assert.equal(providers.activeModel(openai), 'other');
  assert.deepEqual(settings.chatModels, {});
  assert.equal(providers.pickModel(providers.providerDef('openai'), [], ''), null);
  assert.equal(providers.pickModel(providers.providerDef('openai'), ['saved', 'mini'], 'saved'), 'saved');
  assert.equal(providers.pickModel(providers.providerDef('openai'), ['first', 'gpt-mini'], ''), 'gpt-mini');
  assert.equal(providers.pickModel(providers.providerDef('custom'), ['first', 'second'], ''), 'first');
  assert.deepEqual(providers.visibleProviders(settings).map(p => p.id), ['anthropic', 'google', 'openai', 'openrouter']);
  assert(providers.visibleProviders({ ...settings, chatProvider: 'ollama' }).some(p => p.id === 'ollama'));
  assert(providers.visibleProviders({ ...settings, customUrl: 'https://example.org' }).some(p => p.id === 'custom'));
  const prefs = fs.readFileSync(path.join(root, 'src/prefs.rs'), 'utf8');
  const rustIds = prefs.match(/pub const PILL_IDS: \[&str; \d+\] = \[([\s\S]*?)\];/);
  assert(rustIds, 'Rust PILL_IDS declaration must remain readable');
  assert.deepEqual(pills.PILL_CATALOG.map(p => p.id), [...rustIds[1].matchAll(/"([^"]+)"/g)].map(m => m[1]));
  assert.equal(pills.DEFAULT_MAIN_PILL, 'integration_claude');
  assert.equal(pills.DEFAULT_MAIN_PILL, prefs.match(/pub const DEFAULT_MAIN_PILL: &str = "([^"]+)";/)?.[1]);
  assert.equal(pills.MAX_DECLARED, undefined, 'S32: no declared-pill limit in the vendored core');
  assert(!/MAX_DECLARED_PILLS/.test(prefs), 'S32: nor in Rust');
  for (const os of ['windows', 'linux']) {
    const ids = pills.availablePills(os).map(p => p.id);
    assert.equal(ids.length, os === 'windows' ? 24 : 23);
    assert.equal(ids.includes('agent_claude-desktop'), os === 'windows');
    assert(!ids.includes('integration_music'));
    assert(ids.includes('integration_spotify'));
  }
  assert(!/Coucou|Mochi/i.test(JSON.stringify(pills.PILL_CATALOG)));
  global.document = document; global.window = Object.assign(new Target(), { innerWidth: 320 });
  console.log('PASS pure modules: shortcuts, providers, OS catalog, Rust parity (25 IDs)');
  const { h } = await load('views/dom.js');
  const styled = h('div', { style: 'background:#F4505E;--x:1' });
  assert.deepEqual(styled.styleCalls, [['background', '#F4505E'], ['--x', '1']]);
  assert.equal(styled.getAttribute('style'), null);
  const complex = h('div', { style: '; background:url("data:image/svg+xml;a:b"); --label:"a;b:c";width:calc(1px + var(--x, 2px)); ;bad;:empty' });
  assert.deepEqual(complex.styleCalls, [['background', 'url("data:image/svg+xml;a:b")'], ['--label', '"a;b:c"'], ['width', 'calc(1px + var(--x, 2px))']]);
  for (const style of ['bad', 'width:', 'background:url(unclosed', '--x:"unclosed', 'not a property:1']) assert.deepEqual(h('div', { style }).styleCalls, []);
  assert.deepEqual(h('div', { style: String.raw`--label:'a\';b';background:url(data:image/svg+xml;a:b);--x:1` }).styleCalls, [['--label', String.raw`'a\';b'`], ['background', 'url(data:image/svg+xml;a:b)'], ['--x', '1']]);
  const createElement = document.createElement;
  document.createElement = tag => { const el = createElement(tag); el.style.setProperty = () => { throw new Error('invalid CSS'); }; return el; };
  try { assert.doesNotThrow(() => h('div', { style: 'background:invalid' })); } finally { document.createElement = createElement; }
  const { colorDot } = await load('settings/colors.js');
  const { statusDot, renderDiff } = await load('settings/parts.js');
  const { PILL_PALETTE, parsePillColors } = await load('core/pill-colors.js');
  execFileSync(process.execPath, [path.join(__dirname, 'coucou-bridge-check.cjs')], { stdio: 'inherit' });
  execFileSync(process.execPath, [path.join(__dirname, 'settings-hub-check.cjs')], { stdio: 'inherit' });
  execFileSync(process.execPath, [path.join(__dirname, 'settings-accounts-check.cjs')], { stdio: 'inherit' });
  execFileSync(process.execPath, [path.join(__dirname, 'settings-pills-check.cjs')], { stdio: 'inherit' });
  execFileSync(process.execPath, [path.join(__dirname, 'settings-pages-check.cjs')], { stdio: 'inherit' });
  execFileSync(process.execPath, [path.join(__dirname, 'settings-dictation-check.cjs')], { stdio: 'inherit' });
  execFileSync(process.execPath, [path.join(__dirname, 'settings-data-pages-check.cjs')], { stdio: 'inherit' });
  execFileSync(process.execPath, [path.join(__dirname, 'settings-model-rows-check.cjs')], { stdio: 'inherit' });
  execFileSync(process.execPath, [path.join(__dirname, 'settings-agents-check.cjs')], { stdio: 'inherit' });
  execFileSync(process.execPath, [path.join(__dirname, 'settings-integrations-check.cjs')], { stdio: 'inherit' });
  let colors = {}, picks = 0;
  const dot = colorDot({ id: 'agent_amp', name: 'Agente', color: '#F5F6F8' }, 'width:8px', () => colors, next => { colors = next; picks++; });
  assert.deepEqual(dot.styleCalls, [['background', '#F5F6F8'], ['width', '8px']]);
  document.body.append(dot);
  assert.equal(dot.getAttribute('role'), 'button');
  assert.equal(dot.getAttribute('tabindex'), '0');
  assert.equal(dot.getAttribute('aria-label'), 'Agente · Color');
  dot.fire('click');
  assert.equal(palette().getAttribute('role'), 'group');
  assert.equal(palette().children.length, PILL_PALETTE.length);
  assert.deepEqual(palette().children[1].styleCalls, [['background', '#F4505E']]);
  assert.equal(document.activeElement.getAttribute('aria-pressed'), '');
  assert.equal(palette().style.left, '132px');
  palette().children[1].fire('click');
  assert.equal(picks, 1); assert.equal(colors.agent_amp, '#F4505E');
  assert.equal(palette(), undefined); assert.equal(document.activeElement, dot);
  assert.equal(dot.style.background, '#F4505E');
  assert(dot.fire('keydown', { key: 'Enter' }).prevented);
  assert.equal(palette().children.at(-1).textContent, 'Predeterminado');
  palette().children.at(-1).fire('click'); assert.deepEqual(colors, {});
  dot.fire('keydown', { key: ' ' }); document.fire('keydown', { key: 'Escape' });
  assert.equal(palette(), undefined); assert.equal(document.activeElement, dot);
  dot.fire('click'); dot.fire('click'); assert.equal(palette(), undefined);
  dot.fire('click'); document.fire('mousedown'); assert.equal(palette(), undefined);
  dot.fire('click'); window.fire('resize'); assert.equal(palette(), undefined);
  dot.fire('keydown', { key: 'Tab' }); assert.equal(palette(), undefined);
  dot.fire('click'); dot.fire('keydown', { key: 'Enter' });
  assert.equal(document.body.children.filter(n => n.className === 'palette').length, 1);
  document.fire('keydown', { key: 'Escape' });
  assert.equal(document.count(), 0); assert.equal(window.count(), 0);
  assert.deepEqual(statusDot(true).styleCalls, [['background', '#22c55e']]);
  assert.deepEqual(statusDot(false).styleCalls, [['background', '#f4505e']]);
  const diff = renderDiff('+nuevo\n-viejo\n<img src=x>');
  assert.deepEqual(diff.children.map(n => n.className), ['add', 'del', 'ctx']);
  assert.equal(diff.children[2].textContent, '<img src=x>');
  assert.deepEqual(parsePillColors({ a: 'bad', b: '#abcdef' }), { b: '#ABCDEF' });
  const { t } = await load('i18n/i18n.js');
  assert.throws(() => t('Unknown'), /Traducción/);
  const before = hashTree();
  for (let i = 0; i < 2; i++) {
    execFileSync(process.execPath, [path.join(root, 'scripts/build-coucou.cjs')], { stdio: 'inherit' });
    assert.equal(hashTree(), before, 'checked-in output and two builds must match');
  }
  console.log(`PASS coucou-vendor: palette, keyboard, focus, cleanup, parts, closed bridge; deterministic SHA256 ${before}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
