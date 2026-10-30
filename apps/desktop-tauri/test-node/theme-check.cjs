'use strict';
/* #380 — checks for frontend/theme.js (the system/light/dark controller), plus the theme's
   public surface: the CSS palettes, the settings selector wiring and the script registration.
   The DOM checks drive the REAL production module through fake DOM objects that speak the
   same interface (setAttribute, MediaQueryList add/removeEventListener, the `change` event,
   the `prefs:state` publication and the `prefs_action` invoke) — real events, real code paths,
   not regexes over the source. Regexes are used only where no DOM exists to drive (CSS rules,
   script tags, the settings panel's own source wiring, which settings-view-check.cjs owns).
   Run: node apps/desktop-tauri/test-node/theme-check.cjs (also under cargo test). */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const frontend = path.join(__dirname, '..', 'frontend');
const T = require(path.join(frontend, 'theme.js'));
const S = require(path.join(frontend, 'settings-view.js'));
const css = fs.readFileSync(path.join(frontend, 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
const settingsSrc = fs.readFileSync(path.join(frontend, 'settings.js'), 'utf8');
const lib = require(path.join(__dirname, '..', 'packaging', 'lib.cjs'));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---- fakes that speak the real interfaces ----------------------------------------------------------
const makeRoot = () => {
  const attrs = Object.create(null);
  return {
    attrs, writes: 0,
    setAttribute(name, value) { attrs[name] = String(value); this.writes += 1; },
    getAttribute(name) { return Object.hasOwn(attrs, name) ? attrs[name] : null; },
    get dataset() { return attrs; }, // theme.js writes through setAttribute; tests read attrs
  };
};
const makeMedia = (matches) => {
  const listeners = [];
  return {
    matches, listeners,
    media: '(prefers-color-scheme: dark)',
    addEventListener(type, cb) { if (type === 'change') listeners.push(cb); },
    removeEventListener(type, cb) { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); },
    // the OS flipping its own theme: this is the real `change` event shape
    systemFlipsTo(value) { this.matches = value; for (const cb of [...listeners]) cb({ matches: value, media: this.media }); },
  };
};
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(r => setImmediate(r));

// ---- the closed enum -------------------------------------------------------------------------------
test('#380 modes: exactly system/light/dark, and an unknown value never invents a fourth theme', () => {
  assert.deepEqual([...T.MODES], ['system', 'light', 'dark']);
  for (const mode of T.MODES) { assert.equal(T.isMode(mode), true); assert.equal(T.normalize(mode), mode); }
  for (const bad of ['', 'sepia', 'System', 'DARK', 'auto', null, undefined, 1, {}, ['dark']]) {
    assert.equal(T.isMode(bad), false, JSON.stringify(bad));
    assert.equal(T.normalize(bad), 'system', JSON.stringify(bad));
  }
});

test('#380 resolve: an explicit mode wins over the OS; system follows the OS; an unknown OS keeps Abito dark', () => {
  assert.equal(T.resolve('light', true), 'light', 'explicit light ignores a dark OS');
  assert.equal(T.resolve('light', false), 'light');
  assert.equal(T.resolve('dark', false), 'dark', 'explicit dark ignores a light OS');
  assert.equal(T.resolve('dark', true), 'dark');
  assert.equal(T.resolve('system', true), 'dark');
  assert.equal(T.resolve('system', false), 'light');
  assert.equal(T.resolve('system', undefined), 'dark', 'no OS value = Abito own palette');
  assert.equal(T.resolve('system', null), 'dark');
  assert.equal(T.resolve('sepia', false), 'light', 'unknown mode reads as system');
});

// ---- mode selection: the controller paints the document --------------------------------------------
test('#380 selection: choosing a mode paints <html data-theme> immediately, and only that', () => {
  const root = makeRoot();
  const media = makeMedia(false);
  const ctl = T.createController({ root, media });
  assert.equal(ctl.mode(), 'system');
  assert.equal(ctl.applied(), null, 'nothing is painted before the first set');
  assert.equal(ctl.set('light'), true);
  assert.equal(root.getAttribute('data-theme'), 'light');
  assert.equal(ctl.set('dark'), true);
  assert.equal(root.getAttribute('data-theme'), 'dark');
  assert.equal(ctl.set('system'), true);
  assert.equal(root.getAttribute('data-theme'), 'light', 'the OS says light here');
  assert.equal(root.writes, 3, 'one write per real change, no repaint storms');
});

test('#380 idempotence: re-selecting the mode that is already painted writes nothing', () => {
  const root = makeRoot();
  const media = makeMedia(true);
  const ctl = T.createController({ root, media });
  ctl.set('dark');
  assert.equal(root.writes, 1);
  assert.equal(ctl.set('dark'), false);
  assert.equal(ctl.set('system'), false, 'system resolves to the same dark');
  assert.equal(root.writes, 1);
});

// ---- system mode follows the OS, exactly once, no polling -----------------------------------------
test('#380 system: the OS change event repaints, and only while the mode is «system»', () => {
  const root = makeRoot();
  const media = makeMedia(false);
  const ctl = T.createController({ root, media });
  ctl.set('system');
  assert.equal(root.getAttribute('data-theme'), 'light');
  assert.equal(media.listeners.length, 1, 'one listener, attached by the controller');
  media.systemFlipsTo(true);
  assert.equal(root.getAttribute('data-theme'), 'dark');
  media.systemFlipsTo(false);
  assert.equal(root.getAttribute('data-theme'), 'light');
  assert.equal(root.writes, 3, 'only real flips repaint');
  assert.equal(ctl.listening(), true);
});

test('#380 explicit: after leaving «system» the OS can never repaint the page', () => {
  const root = makeRoot();
  const media = makeMedia(true);
  const ctl = T.createController({ root, media });
  ctl.set('system');
  assert.equal(media.listeners.length, 1);
  ctl.set('dark');
  assert.equal(media.listeners.length, 0, 'the watcher is released: one owner, no leaks');
  media.systemFlipsTo(false); // the human changes the OS anyway
  assert.equal(root.getAttribute('data-theme'), 'dark', 'the explicit choice ignores the OS');
  assert.equal(root.writes, 1, 'dark was already painted: the ignored flip writes nothing');
  ctl.set('system'); // back to following the OS
  assert.equal(root.getAttribute('data-theme'), 'light');
  assert.equal(root.writes, 2);
  assert.equal(media.listeners.length, 1, 'the watcher comes back only for «system»');
  assert.equal(ctl.listening(), true);
});

test('#380 teardown: destroy() removes the listener; a second destroy is a no-op', () => {
  const root = makeRoot();
  const media = makeMedia(false);
  const ctl = T.createController({ root, media });
  ctl.set('system');
  assert.equal(media.listeners.length, 1);
  ctl.destroy();
  assert.equal(media.listeners.length, 0);
  assert.equal(ctl.listening(), false);
  ctl.destroy();
  assert.equal(media.listeners.length, 0);
  media.systemFlipsTo(true);
  assert.equal(root.getAttribute('data-theme'), 'light', 'a destroyed controller never paints again');
});

test('#380 no media object: the theme still works and never throws', () => {
  const root = makeRoot();
  const ctl = T.createController({ root, media: null });
  ctl.set('system');
  assert.equal(root.getAttribute('data-theme'), 'dark', 'unknown OS = Abito dark');
  assert.equal(ctl.listening(), false);
  assert.equal(ctl.set('light'), true);
  assert.equal(root.getAttribute('data-theme'), 'light');
});

// ---- saved state: the ONLY input to a paint --------------------------------------------------------
test('#380 applySaved: only a saved payload paints; a partial or hostile one reads as system', () => {
  const root = makeRoot();
  const media = makeMedia(true);
  const ctl = T.createController({ root, media });
  assert.equal(T.applySaved(ctl, { sound: true }), false, 'a payload without theme changes nothing');
  assert.equal(root.writes, 0);
  for (const bad of [null, undefined, 'dark', 42]) {
    assert.equal(T.applySaved(ctl, bad), false, JSON.stringify(bad));
  }
  assert.equal(T.applySaved(ctl, { theme: 'sepia' }), true, 'a damaged value is installed as…');
  assert.equal(root.getAttribute('data-theme'), 'dark', '…system, which here resolves dark');
  assert.equal(ctl.mode(), 'system');
  assert.equal(T.applySaved(ctl, { theme: 'light' }), true);
  assert.equal(root.getAttribute('data-theme'), 'light');
});

// ---- startup: default system, saved reload, live publication, honest failures ----------------------
test('#380 start: paints system before the host answers, then the SAVED mode (saved reload)', async () => {
  const root = makeRoot();
  const media = makeMedia(false);
  const pending = deferred();
  const events = [];
  const ctl = T.start({
    root, media,
    invoke: (cmd, args) => { assert.equal(cmd, 'prefs_action'); assert.deepEqual(args, { payload: { action: 'view' } }); return pending.promise; },
    listen: (event, cb) => { events.push([event, cb]); return Promise.resolve(); },
  });
  assert.equal(root.getAttribute('data-theme'), 'light', 'system (OS light) is painted at once: no flash');
  assert.equal(events.length, 1, 'one subscription');
  assert.equal(events[0][0], 'prefs:state');
  pending.resolve({ sound: false, theme: 'dark' });
  await tick();
  assert.equal(root.getAttribute('data-theme'), 'dark', 'a saved explicit dark survives a reload');
  assert.equal(ctl.mode(), 'dark');
  // a later publication is applied live (this is what a successful save publishes)
  events[0][1]({ payload: { sound: false, theme: 'light' } });
  assert.equal(root.getAttribute('data-theme'), 'light');
  assert.equal(media.listeners.length, 0, 'explicit mode: no OS watcher');
  ctl.destroy();
});

test('#380 start: a failed save/read keeps the previous visible theme (no optimistic paint)', async () => {
  const root = makeRoot();
  const media = makeMedia(true);
  const pending = deferred();
  const ctl = T.start({ root, media, invoke: () => pending.promise, listen: null });
  assert.equal(root.getAttribute('data-theme'), 'dark');
  pending.reject(new Error('save_failed')); // the host refused the write
  await tick();
  assert.equal(root.getAttribute('data-theme'), 'dark', 'the visible theme did not move');
  assert.equal(ctl.mode(), 'system');
  // and a publication that never carries a theme never repaints
  ctl.set('light');
  T.applySaved(ctl, { sound: true });
  assert.equal(root.getAttribute('data-theme'), 'light');
  ctl.destroy();
});

test('#380 start: with no invoke/listen at all (no engine, no event bus) the default holds', () => {
  const root = makeRoot();
  const media = makeMedia(false);
  const ctl = T.start({ root, media });
  assert.equal(root.getAttribute('data-theme'), 'light');
  assert.equal(media.listeners.length, 1, 'system still follows the OS');
  ctl.destroy();
});

// ---- the classic-script install path (how the page actually loads it) ------------------------------
test('#380 install: as a classic script the module exposes window.AbitoTheme and paints the document', async () => {
  const root = makeRoot();
  const media = makeMedia(true);
  const pending = deferred();
  const listeners = [];
  const win = {
    document: { documentElement: root },
    matchMedia: q => { assert.equal(q, '(prefers-color-scheme: dark)'); return media; },
    __TAURI__: { core: { invoke: () => pending.promise }, event: { listen: (e, cb) => { listeners.push([e, cb]); return Promise.resolve(); } } },
  };
  win.window = win;
  const source = fs.readFileSync(path.join(frontend, 'theme.js'), 'utf8');
  const context = { console, Promise, Object, String, Array, module: undefined, exports: undefined, self: win, window: win, document: win.document };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'theme.js' });
  assert.equal(typeof win.AbitoTheme, 'object', 'the classic script publishes window.AbitoTheme');
  assert.equal(root.getAttribute('data-theme'), 'dark', 'system painted immediately');
  assert.equal(listeners.length, 1, 'one subscription');
  assert.equal(listeners[0][0], 'prefs:state');
  pending.resolve({ theme: 'light' });
  await tick();
  assert.equal(root.getAttribute('data-theme'), 'light', 'the saved mode takes over');
});

// ---- the settings panel: sends the closed command, never paints ------------------------------------
test('#380 settings: the selector sends set_theme through prefs_action only, and never paints data-theme itself', () => {
  assert.match(settingsSrc, /\{ action: 'set_theme', theme: mode \}/);
  const calls = settingsSrc.match(/action: 'set_theme'/g) || [];
  assert.equal(calls.length, 1, 'one sender for the theme command');
  assert.doesNotMatch(settingsSrc, /dataset\.theme|data-theme|setAttribute\('data-theme'/, 'only theme.js paints the document');
  assert.match(settingsSrc, /No se pudo guardar el tema; se mantuvo el anterior\./);
  assert.match(settingsSrc, /role', 'radiogroup'/);
  assert.match(settingsSrc, /aria-checked/);
  // the row renders from the SAVED prefs, so a refused save re-renders the old truth
  assert.match(settingsSrc, /const themePick = V\.themeView\(prefs\)/);
});

test('#380 settings-view: the view-model offers exactly the three closed choices, in Spanish', () => {
  assert.deepEqual([...S.THEME_MODES], ['system', 'light', 'dark']);
  assert.deepEqual(S.THEME_LABELS, { system: 'Sistema', light: 'Claro', dark: 'Oscuro' });
  const view = S.themeView({ theme: 'light' });
  assert.equal(view.mode, 'light');
  assert.deepEqual(view.options.map(o => o.id), ['system', 'light', 'dark']);
  assert.deepEqual(view.options.filter(o => o.selected).map(o => o.id), ['light']);
  for (const o of view.options) assert.ok(o.label && o.aria, o.id);
  assert.equal(view.aria, view.options.find(o => o.selected).aria);
  // an absent or damaged stored value renders as «Sistema», never as a fourth choice
  for (const prefs of [null, undefined, {}, { theme: 'sepia' }, { theme: 7 }, { theme: null }]) {
    assert.equal(S.themeView(prefs).mode, 'system', JSON.stringify(prefs));
    assert.equal(S.themeView(prefs).options.filter(o => o.selected).map(o => o.id)[0], 'system');
  }
  // and it collides with no other control id in index.html
  assert.equal(html.includes('id="theme-mode-'), false, 'the ids are built per render, not in the markup');
});

// ---- CSS: two palettes, one design ------------------------------------------------------------------
test('#380 css: the dark palette is Abito\'s own palette, verbatim (the default looks unchanged)', () => {
  const darkBlock = css.slice(css.lastIndexOf(':root {'));
  assert.match(darkBlock, /color-scheme:\s*dark/);
  assert.match(darkBlock, /--surface:\s*#18181b/, 'the dark panel colour stays byte-identical');
  assert.match(darkBlock, /--line:\s*rgba\(255, 255, 255, \.25\)/);
  assert.match(darkBlock, /--fill:\s*rgba\(255, 255, 255, \.06\)/);
  // role and identity colours are NOT themed (same meanings on both palettes)
  for (const role of ['--go: #b8ff2e', '--sun: #ffe100', '--red-11: #ff5c75', '--island-live: #2eb4ff', '--faint: #6f6d66']) {
    assert.ok(css.includes(role), role);
  }
  for (const dot of ['--dot-green-1', '--dot-blue-1', '--dot-mint-1', '--dot-orange-1', '--dot-purple-1']) assert.ok(css.includes(dot), dot);
});

test('#380 css: the light palette overrides every surface/ink/line token AFTER the dark ones', () => {
  const light = css.indexOf('html[data-theme="light"] {');
  const dark = css.lastIndexOf(':root {');
  assert.ok(light > 0 && light > dark, 'the light block must come after every :root block it overrides');
  const body = css.slice(light, css.indexOf('}', light));
  for (const token of ['color-scheme: light', '--island:', '--island-bg:', '--surface:', '--card-bg:', '--ink:', '--muted:',
    '--island-ink:', '--island-muted:', '--line:', '--line-soft:', '--fill:', '--bubble:', '--btn-bg:', '--primary-bg:', '--primary-ink:']) {
    assert.ok(body.includes(token), `light block misses ${token}`);
  }
  assert.doesNotMatch(body, /#b8ff2e|#ffe100|#ff5c75/, 'role colours never flip with the theme');
  // the native form controls of #309 flip too (the dark `color-scheme: dark` rule stays for dark)
  assert.match(css, /html\[data-theme="light"\] \.sfield \{ color-scheme:\s*light;?\s*\}/);
  assert.match(css.slice(css.indexOf('.sfield {')), /color-scheme:\s*dark/, 'the dark fix of #309 is untouched');
});

test('#380 css: nothing reads the OS colour preference from CSS — the page owns the mode', () => {
  assert.doesNotMatch(css, /@media[^{]*prefers-color-scheme/, 'one owner: theme.js paints data-theme');
  assert.match(css, /This section owns the palette only; no rule below may read the OS media query\./);
});

// ---- registration ------------------------------------------------------------------------------------
test('#380 registration: theme.js loads with the page, before the island, and ships in the curated list', () => {
  assert.match(html, /<script defer src="theme\.js"><\/script>/);
  assert.ok(html.indexOf('src="theme.js"') < html.indexOf('src="island.js"'), 'the palette is painted before the island draws');
  assert.ok(lib.FRONTEND_FILES.includes('theme.js'));
  assert.equal(new Set(lib.FRONTEND_FILES).size, lib.FRONTEND_FILES.length);
});

(async () => {
  let passed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed += 1;
    } catch (error) {
      console.error(`FAIL: ${name}`);
      throw error;
    }
  }
  console.log(`theme-check: ${passed} passed`);
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
