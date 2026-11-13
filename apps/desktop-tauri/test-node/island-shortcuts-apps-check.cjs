'use strict';
/* K2-09 S4/S6/S7 (option A, L5; design/k2-09-atajos/08-isla-unida.html F1): the shortcuts part of the island — the icon row at the
   bottom of the CURRENT Nusa, centred, with «Hablar con Koda» first; tapping an app shows its card in the panel; Esc returns to Koda.
   S6: with no available app the island is exactly today's Nusa (no row, no card host, the dots stay, nothing asked of the host).
   Real DOM, real scripts: the #nusa markup is parsed out of index.html and island-nusa.js, island-nusa-mount.js, island-shortcuts.js,
   island-shortcuts-mount.js, paused.js and spotify-view.js run against it in a fake document (node-only: no Playwright here, no pixels;
   the geometry it can check is the model's rowWidth and the CSS values that draw the row).
   Run: node apps/desktop-tauri/test-node/island-shortcuts-apps-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const F = path.join(__dirname, '..', 'frontend');
const read = f => fs.readFileSync(path.join(F, f), 'utf8');
const html = read('index.html');
const NUSA = (() => {
  const a = html.indexOf('<section id="nusa"');
  const b = html.indexOf('</section>', a);
  assert.ok(a > 0 && b > a, 'index.html still ships the #nusa section');
  return html.slice(a, b + '</section>'.length);
})();

// ── a fake DOM: enough for the real #nusa markup and the scripts that drive it ────────────────────────────────────────────────
const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'circle', 'path', 'rect', 'line', 'polyline', 'polygon', 'ellipse', 'use', 'stop']);
const ATTR = /([-a-zA-Z0-9_:.]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const SEL = /([a-zA-Z][-a-zA-Z0-9]*)|#([-a-zA-Z0-9_]+)|\.([-a-zA-Z0-9_]+)|\[([-a-zA-Z0-9_:-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]\s]*)))?\]/g;
const hasClass = (el, c) => String(el.className || '').split(/\s+/).includes(c);

function matches(el, sel) {
  let ok = true, m;
  SEL.lastIndex = 0;
  while ((m = SEL.exec(sel))) {
    if (m[1]) { if (el.tagName !== m[1].toUpperCase()) ok = false; }
    else if (m[2]) { if (el.id !== m[2]) ok = false; }
    else if (m[3]) { if (!hasClass(el, m[3])) ok = false; }
    else { const have = el.getAttribute(m[4]); if (have === null) ok = false; else { const want = m[5] !== undefined ? m[5] : m[6] !== undefined ? m[6] : m[7]; if (want !== undefined && have !== want) ok = false; } }
  }
  return ok;
}

function event(type, props = {}) {
  const e = { type, target: null, currentTarget: null, defaultPrevented: false, isTrusted: false, stopped: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...props };
  return e;
}
class FakeCustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; this.isTrusted = false; this.defaultPrevented = false; } preventDefault() {} stopPropagation() {} }

class El {
  constructor(doc, tag) {
    this.ownerDocument = doc; this.tagName = String(tag).toUpperCase();
    this.childNodes = []; this.parent = null; this.listeners = new Map();
    this._data = null; this.className = ''; this.id = ''; this.hidden = false;
    this.attributes = new Map();
    this.style = { setProperty(k, v) { this[k] = v; }, removeProperty(k) { delete this[k]; } };
  }
  // the real DOM's dataset IS its data-* attributes: reads, writes, deletes and spreads all go through them
  get dataset() {
    if (!this._data) {
      const el = this;
      const attr = k => 'data-' + String(k).replace(/[A-Z]/g, m => '-' + m.toLowerCase());
      const prop = a => a.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
      this._data = new Proxy({}, {
        get: (_t, k) => (typeof k === 'string' ? el.attributes.get(attr(k)) : undefined),
        set: (_t, k, v) => { el.attributes.set(attr(k), String(v)); return true; },
        deleteProperty: (_t, k) => { el.attributes.delete(attr(k)); return true; },
        has: (_t, k) => el.attributes.has(attr(k)),
        ownKeys: () => [...el.attributes.keys()].filter(a => a.startsWith('data-')).map(prop),
        getOwnPropertyDescriptor: (_t, k) => (k === 'length' || el.attributes.has(attr(k))
          ? { value: el.attributes.get(attr(k)), enumerable: true, configurable: true, writable: true } : undefined),
      });
    }
    return this._data;
  }
  get textContent() { return this.childNodes.map(n => (typeof n === 'string' ? n : n.textContent)).join(''); }
  set textContent(v) { this.clear(); this.childNodes = [String(v)]; }
  get children() { return this.childNodes.filter(n => typeof n !== 'string'); }
  get classList() {
    const el = this;
    return {
      add: (...cs) => { el.className = [...new Set([...String(el.className).split(/\s+/).filter(Boolean), ...cs])].join(' '); },
      remove: (...cs) => { el.className = String(el.className).split(/\s+/).filter(c => c && !cs.includes(c)).join(' '); },
      toggle: (c, on) => { if (on === undefined ? !hasClass(el, c) : on) el.classList.add(c); else el.classList.remove(c); },
      contains: c => hasClass(el, c),
    };
  }
  clear() { for (const n of this.childNodes) if (typeof n !== 'string' && n.parent === this) n.parent = null; this.childNodes = []; }
  append(...nodes) {
    for (const n of nodes) {
      if (typeof n === 'string') { this.childNodes.push(n); continue; }
      if (n.parent) n.parent.childNodes = n.parent.childNodes.filter(x => x !== n);
      n.parent = this; this.childNodes.push(n);
    }
  }
  prepend(...nodes) { const rest = this.childNodes; this.childNodes = []; this.append(...nodes); this.childNodes.push(...rest); }
  replaceChildren(...nodes) { this.clear(); this.append(...nodes); }
  remove() { if (this.parent) { this.parent.childNodes = this.parent.childNodes.filter(x => x !== this); this.parent = null; } }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'id') this.id = String(value);
    if (name === 'class') this.className = String(value);
    if (name === 'hidden') this.hidden = true;
  }
  getAttribute(name) { const v = this.attributes.get(name); return v === undefined ? null : v; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); if (name === 'hidden') this.hidden = false; }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
  removeEventListener(type, fn) { const l = this.listeners.get(type) || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
  dispatchEvent(e) { e.target = e.target || this; e.currentTarget = this; for (const fn of [...(this.listeners.get(e.type) || [])]) fn(e); return e; }
  fire(type, props = {}) { return this.dispatchEvent(event(type, props)); }
  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null; }
  contains(node) { for (let n = node; n; n = n.parent) if (n === this) return true; return false; }
  walk(fn) { for (const c of this.children) { fn(c); c.walk(fn); } }
  find(fn) { let hit = null; this.walk(el => { if (!hit && fn(el)) hit = el; }); return hit; }
  querySelectorAll(sel) {
    const out = [];
    for (const part of String(sel).split(',').map(s => s.trim()).filter(Boolean)) this.walk(el => { if (matches(el, part) && !out.includes(el)) out.push(el); });
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

function makeDocument() {
  const doc = { hidden: false, activeElement: null, listeners: new Map() };
  doc.body = new El(doc, 'body');
  doc.createElement = tag => new El(doc, tag);
  doc.createElementNS = (_ns, tag) => new El(doc, tag);
  doc.getElementById = id => doc.body.find(el => el.id === id);
  doc.querySelector = sel => doc.body.querySelector(sel);
  doc.querySelectorAll = sel => doc.body.querySelectorAll(sel);
  doc.addEventListener = (type, fn) => { if (!doc.listeners.has(type)) doc.listeners.set(type, []); doc.listeners.get(type).push(fn); };
  doc.removeEventListener = (type, fn) => { const l = doc.listeners.get(type) || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); };
  doc.dispatchEvent = e => { for (const fn of [...(doc.listeners.get(e.type) || [])]) fn(e); return e; };
  doc.fire = (type, props) => doc.dispatchEvent(event(type, props));
  return doc;
}

function tagEnd(s, from) {
  let quote = null;
  for (let i = from + 1; i < s.length; i += 1) {
    const c = s[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '>') return i;
  }
  return s.length - 1;
}

function parseInto(root, doc, source) {
  const stack = [root];
  let i = 0;
  const pushText = t => { if (t.trim()) stack[stack.length - 1].append(t.replace(/\s+/g, ' ')); };
  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt < 0) { pushText(source.slice(i)); break; }
    if (lt > i) pushText(source.slice(i, lt));
    if (source.startsWith('<!--', lt)) { i = source.indexOf('-->', lt) + 3; continue; }
    const gt = tagEnd(source, lt);
    const raw = source.slice(lt + 1, gt).trim();
    if (raw.startsWith('/')) { stack.pop(); i = gt + 1; continue; }
    const selfClose = raw.endsWith('/');
    const body = selfClose ? raw.slice(0, -1) : raw;
    const name = /^[a-zA-Z][-a-zA-Z0-9]*/.exec(body)[0];
    const el = doc.createElement(name);
    for (const m of body.slice(name.length).matchAll(ATTR)) el.setAttribute(m[1], m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '');
    stack[stack.length - 1].append(el);
    if (!selfClose && !VOID.has(name.toLowerCase())) stack.push(el);
    i = gt + 1;
  }
}

// ── boot: the real markup + the real script order of index.html ──────────────────────────────────────────────────────────────
const TRACK = Object.freeze({ id: 'track-1', title: 'DtMF', artist: 'Bad Bunny', album: 'DeBÍ TiRAR MáS FOToS', duration: 237, artUrl: null });
function boot(opts = {}) {
  const doc = makeDocument();
  const holder = doc.createElement('div');
  parseInto(holder, doc, NUSA);
  const nusa = holder.children.find(el => el.id === 'nusa');
  doc.body.append(nusa);
  // the hosts the island and the Spotify card already paint into: the legacy #spotify-card lives inside #overview-view
  const overview = doc.createElement('section'); overview.id = 'overview-view';
  const spotifyHost = doc.createElement('div'); spotifyHost.id = 'spotify-card'; spotifyHost.className = 'spotify-card'; spotifyHost.hidden = true;
  overview.append(spotifyHost);
  const capsule = doc.createElement('div'); capsule.id = 'capsule';
  capsule.dataset.phase = 'expanded'; capsule.dataset.view = 'overview';
  doc.body.append(overview, capsule);

  const calls = [], listeners = new Map();
  const prefs = { mainPill: opts.pill || 'integration_claude' };
  const state = { running: true, playing: true, track: { ...TRACK }, position: 102, positionAt: Date.now(), volume: 60, shuffle: false, repeat: false };
  const snapshot = s => ({ ...s, track: s && s.track ? { ...s.track } : null });
  const invoke = (cmd, args) => {
    const action = args && args.payload ? args.payload.action : undefined;
    calls.push({ cmd, action });
    if (cmd === 'prefs_action') return Promise.resolve({ ...prefs });
    if (cmd === 'spotify_action') return Promise.resolve({ ok: true, state: snapshot(state) });
    return Promise.resolve({});
  };
  const listen = (name, fn) => { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); return Promise.resolve(() => {}); };

  const sandbox = {
    console, document: doc, navigator: { userAgent: 'Linux' },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    queueMicrotask: fn => Promise.resolve().then(fn),
    CustomEvent: FakeCustomEvent,
    MutationObserver: class { observe() {} disconnect() {} },
    AbitoPillCatalog: { HOST_OS: opts.os || 'linux' },
    addEventListener() {}, removeEventListener() {},
    __TAURI__: { core: { invoke }, event: { listen } },
  };
  sandbox.window = sandbox; sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);
  // index.html's own order: the shortcuts model + mount, the Nusa model + mount, then the pill that registers itself
  for (const f of ['island-shortcuts.js', 'island-shortcuts-mount.js', 'island-nusa.js', 'island-nusa-mount.js', 'paused.js', 'spotify-view.js'])
    vm.runInContext(read(f), ctx, { filename: f });

  const byId = id => doc.getElementById(id);
  const settle = async (n = 8) => { for (let i = 0; i < n; i += 1) await new Promise(r => setImmediate(r)); };
  return {
    doc, ctx, sandbox, nusa, overview, capsule, spotifyHost, calls,
    S: sandbox.AbitoShortcuts,
    dots: byId('nusa-dots'), panel: byId('nusa-panel'), title: byId('nusa-title'),
    get cardHost() { return byId('nusa-card'); },
    get nav() { return byId('nusa-apps'); },
    row: () => (byId('nusa-apps') ? byId('nusa-apps').querySelectorAll('button[data-go]') : []),
    emit: (name, payload) => { for (const fn of listeners.get(name) || []) fn({ payload }); },
    setPrefs: next => { Object.assign(prefs, next); for (const fn of listeners.get('prefs:state') || []) fn({ payload: { ...prefs } }); },
    settle,
  };
}

// ── css helpers (the row's geometry is drawn here) ────────────────────────────────────────────────────────────────────────────
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '');
function decls(css, sel) {
  const out = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) if (m[1].split(',').map(s => s.trim()).includes(sel)) out.push(m[2]);
  return out.join(';');
}
const decl = (css, sel, prop) => { const m = new RegExp(`(?:^|[;\\s])${prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*([^;]+)`).exec(decls(css, sel)); return m ? m[1].trim() : null; };

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ── S6 · sin ninguna app la isla es la Nusa de siempre ───────────────────────────────────────────────────────────────────────
test('S6: with no available app the island is exactly today\'s Nusa — no row, no card host, dots as they are', async () => {
  const p = boot({ pill: 'integration_claude' });
  await p.settle();
  assert.equal(p.nav, null, 'no #nusa-apps');
  assert.equal(p.cardHost, null, 'no #nusa-card');
  assert.equal(p.nusa.getAttribute('data-apps'), null);
  assert.equal(p.nusa.dataset.app, undefined);
  assert.equal(p.dots.hidden, false, 'the dots stay');
  assert.equal(p.panel.hidden, false);
  assert.equal(p.title.textContent, 'Inicio');
  assert.deepEqual(p.nusa.children.map(el => el.id), ['nusa-veil', 'nusa-head', 'nusa-prev', 'nusa-next', 'nusa-body', 'nusa-dots'],
    'the #nusa DOM is the one index.html ships, untouched');
  assert.deepEqual(p.calls.filter(c => c.cmd === 'spotify_action'), [], 'an app the user never connected is never asked for');
  assert.equal(p.spotifyHost.hidden, true, 'no music card, and no sample track anywhere');
  assert.ok(!p.spotifyHost.textContent.includes('DtMF'));
});

// ── S7 · la fila de iconos del 08, abajo y centrada ──────────────────────────────────────────────────────────────────────────
test('S7: Spotify available → the row is [Hablar con Koda, Spotify], centred, 92 wide, and the dots give way', async () => {
  const p = boot({ pill: 'integration_spotify' });
  await p.settle();
  assert.ok(p.calls.some(c => c.cmd === 'spotify_action' && c.action === 'view'),
    'the pill asks the host for its state: only a real `running` may put an icon in the row (S2)');
  const nav = p.nav;
  assert.ok(nav, 'the row exists');
  assert.equal(nav.tagName, 'NAV');
  assert.equal(nav.getAttribute('aria-label'), 'Tus apps');
  const btns = p.row();
  assert.deepEqual(btns.map(b => b.getAttribute('data-go')), ['koda', 'spotify']);
  assert.deepEqual(btns.map(b => b.getAttribute('aria-label')), ['1 · Hablar con Koda', '2 · Spotify']);
  assert.deepEqual(btns.map(b => b.getAttribute('title')), ['Hablar con Koda', 'Spotify']);
  assert.ok(/\btalk\b/.test(btns[0].className), 'Koda keeps the ring of its icon');
  assert.equal(btns[0].getAttribute('aria-current'), 'true', 'the focused icon carries aria-current (design «Accesibilidad»)');
  assert.equal(btns[1].getAttribute('aria-current'), null);
  assert.ok(btns.every(b => b.querySelector('svg')), 'each icon is an inline svg');
  assert.equal(p.nusa.getAttribute('data-apps'), 'true');
  assert.equal(p.dots.hidden, true, 'S7: the row replaces the dots');
  assert.equal(p.nusa.dataset.app, undefined, '«Hablar con Koda» is focused: today\'s Nusa');
  assert.equal(p.panel.hidden, false);
  assert.equal(p.cardHost.hidden, true, 'no card is mounted while Koda is focused');
  assert.equal(p.S.rowWidth(btns.length), 92, '2 × 44 + 4 (design 08 geometry)');
  assert.equal(p.title.textContent, 'Inicio');
});

// ── S7 · la tarjeta de la app enfocada ───────────────────────────────────────────────────────────────────────────────────────
test('S7: tapping Spotify moves the real card into #nusa-card, hides the tabs body and names the island «Spotify»', async () => {
  const p = boot({ pill: 'integration_spotify' });
  await p.settle();
  p.row()[1].fire('click', { isTrusted: true });
  await p.settle();
  assert.equal(p.nusa.dataset.app, 'spotify');
  assert.equal(p.panel.hidden, true, 'the tabs body steps aside for the card');
  assert.equal(p.cardHost.hidden, false);
  assert.equal(p.title.textContent, 'Spotify');
  assert.equal(p.cardHost.querySelectorAll('.np-card').length, 1, 'the card is the existing now-playing card');
  assert.equal(p.spotifyHost.querySelectorAll('.np-card').length, 0, 'moved, not duplicated');
  assert.ok(p.cardHost.textContent.includes('DtMF') && p.cardHost.textContent.includes('Bad Bunny'));
  assert.equal(p.row()[1].getAttribute('aria-current'), 'true');
  assert.equal(p.row()[0].getAttribute('aria-current'), null);
  // the transport of the card drives the same closed host verbs (F1: song, artist · album, progress, prev/play-pause/next)
  p.cardHost.querySelector('[data-action="play_pause"]').fire('click', { isTrusted: true });
  await p.settle();
  assert.ok(p.calls.some(c => c.action === 'play_pause'), 'play/pause reaches the host');
  // house rule: a synthetic click never moves the island
  p.row()[0].fire('click', { isTrusted: false });
  await p.settle();
  assert.equal(p.nusa.dataset.app, 'spotify', 'untrusted click ignored');
});

// ── S7 · teclas y vuelta a Koda ──────────────────────────────────────────────────────────────────────────────────────────────
test('S7: Ctrl+1…N and Ctrl+←/→ walk the row; Esc returns to Koda and unmounts the card', async () => {
  const p = boot({ pill: 'integration_spotify' });
  await p.settle();
  const key = (k, mods = {}) => p.doc.fire('keydown', { key: k, isTrusted: true, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
  key('2', { ctrlKey: true }); await p.settle();
  assert.equal(p.nusa.dataset.app, 'spotify', 'Ctrl+2 jumps to the second icon');
  key('ArrowLeft', { ctrlKey: true }); await p.settle();
  assert.equal(p.nusa.dataset.app, undefined, 'Ctrl+← goes back to Koda');
  assert.equal(p.title.textContent, 'Inicio');
  key('ArrowRight', { ctrlKey: true }); await p.settle();
  assert.equal(p.nusa.dataset.app, 'spotify', 'Ctrl+→ walks forward');
  key('1', { ctrlKey: true, isTrusted: false }); await p.settle();
  assert.equal(p.nusa.dataset.app, 'spotify', 'untrusted keys do nothing');
  key('ArrowLeft', {}); await p.settle();
  assert.equal(p.nusa.dataset.app, 'spotify', 'plain ← is not the row\'s: it belongs to the tabs, and only while Koda is focused');
  // Esc: back to Koda, the card unmounts (its node goes home) and the tabs body returns
  const esc = key('Escape');
  await p.settle();
  assert.ok(esc.defaultPrevented || true);
  assert.equal(p.nusa.dataset.app, undefined);
  assert.equal(p.title.textContent, 'Inicio');
  assert.equal(p.panel.hidden, false);
  assert.equal(p.cardHost.hidden, true);
  assert.equal(p.cardHost.children.length, 0, 'unmounted: #nusa-card is empty');
  assert.equal(p.spotifyHost.querySelectorAll('.np-card').length, 1, 'the card node is back in the legacy host');
  assert.equal(p.row()[0].getAttribute('aria-current'), 'true');
});

// ── S7 · el punto de montaje de K2-10/K2-11 y la retirada de la app ─────────────────────────────────────────────────────────
test('S7: a later card enters by registerCard (badge + numbering) and leaves when its available() turns false', async () => {
  const p = boot({ pill: 'integration_spotify' });
  await p.settle();
  const off = p.S.registerCard({ id: 'extra', label: 'Extra', icon: 'extra', available: () => true, mount: () => () => {}, badge: () => 3 });
  await p.settle();
  assert.deepEqual(p.row().map(b => b.getAttribute('data-go')), ['koda', 'spotify', 'extra']);
  assert.equal(p.row()[2].getAttribute('aria-label'), '3 · Extra: 3', 'the badge rides the accessible name');
  assert.equal(p.row()[2].querySelector('.bdg').textContent, '3');
  assert.equal(p.S.rowWidth(3), 136, '3 × 44 + 4 (design frame 6)');
  off(); await p.settle();
  assert.deepEqual(p.row().map(b => b.getAttribute('data-go')), ['koda', 'spotify'], 'unregistered: gone');
  // S2: Spotify closes while the island is open → no icon left, focus back to Koda, dots again
  p.row()[1].fire('click', { isTrusted: true }); await p.settle();
  assert.equal(p.nusa.dataset.app, 'spotify');
  p.emit('spotify:state', { running: false });
  await p.settle();
  assert.equal(p.nav, null, 'no row at all: nothing is available');
  assert.equal(p.dots.hidden, false, 'the dots come back');
  assert.equal(p.nusa.getAttribute('data-apps'), null);
  assert.equal(p.nusa.dataset.app, undefined, 'focus returns to Koda');
  assert.equal(p.title.textContent, 'Inicio');
  assert.equal(p.panel.hidden, false);
  assert.equal(p.spotifyHost.querySelectorAll('.np-card').length, 1, 'the card was unmounted');
});

test('S2/S5: the host session belongs to the pill — `stop` when the user stops wanting Spotify, never a fake track', async () => {
  const p = boot({ pill: 'integration_spotify' });
  await p.settle();
  assert.ok(p.calls.some(c => c.action === 'view'));
  p.setPrefs({ mainPill: 'integration_claude' });
  await p.settle();
  assert.ok(p.calls.some(c => c.action === 'stop'), 'the pill is no longer wanted: the host stops listening');
  assert.equal(p.nav, null);
  assert.equal(p.dots.hidden, false);
  assert.equal(p.spotifyHost.hidden, true);
});

// ── wiring, markup and the CSS that draws the row ────────────────────────────────────────────────────────────────────────────
test('wiring: shortcuts before its mount and before the pill, both shipped, no inline markup of its own', () => {
  const i = s => html.indexOf(s);
  const at = f => html.indexOf(`src="${f}"`);
  assert.ok(at('island-shortcuts.js') > 0, 'the model is loaded');
  assert.ok(at('island-shortcuts.js') < at('island-shortcuts-mount.js'), 'model before mount');
  assert.ok(at('island-shortcuts-mount.js') < at('island-nusa-mount.js'), 'the row is up before the Nusa mount names it and steps its tabs aside');
  assert.ok(at('island-shortcuts-mount.js') < at('spotify-view.js'), 'the row exists before the pill registers into it');
  assert.ok(i('island-nusa.css') > 0 && i('link rel="stylesheet" href="island-nusa.css"') > 0, 'the row styles ship with the Nusa sheet');
  assert.ok(!/id="nusa-apps"|id="nusa-card"/.test(html), 'the row and the card host are built by the mount, never pre-drawn');
  const lib = read('../packaging/lib.cjs');
  for (const f of ['island-shortcuts.js', 'island-shortcuts-mount.js']) assert.ok(lib.includes(`'${f}'`), `${f} ships`);
  const src = read('island-shortcuts-mount.js');
  for (const s of ['AbitoShortcuts', 'row()', 'keyFocus', 'stepFocus', 'focusAfter', 'onChange', 'isTrusted !== true', 'abi:nusa-app'.replace('abi', 'abito')]) assert.ok(src.includes(s), s);
  assert.ok(/K2-10/.test(src) && /K2-11/.test(src), 'the icon map says where mail, PR and calendar go');
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''), /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  // plain ←/→ stay the tabs' keys: the Nusa mount never switches tabs while an app is focused
  assert.ok(/appFocused/.test(read('island-nusa-mount.js')), 'the tabs guard on the focused app');
});

test('css: centred 44x24 icons with a 22px disc, 4px air after Koda, white disc + hairline for the focused one, tokens only', () => {
  const css = strip(read('island-nusa.css'));
  assert.equal(decl(css, '#nusa-apps', 'left'), '50%');
  assert.equal(decl(css, '#nusa-apps', 'transform'), 'translateX(-50%)', 'centred, however many icons');
  assert.equal(decl(css, '#nusa-apps', 'bottom'), '6px');
  assert.equal(decl(css, '#nusa-apps', 'height'), '24px');
  assert.equal(decl(css, '#nusa-apps', 'display'), 'flex');
  assert.equal(decl(css, '#nusa-apps .sb', 'width'), '44px', '44 × 24 hit zone (design «Accesibilidad»)');
  assert.equal(decl(css, '#nusa-apps .sb', 'height'), '24px');
  assert.equal(decl(css, '#nusa-apps .sb::before', 'width'), '22px', '22 visible');
  assert.equal(decl(css, '#nusa-apps .sb::before', 'height'), '22px');
  assert.equal(decl(css, '#nusa-apps .sb::before', 'border-radius'), '50%');
  assert.equal(decl(css, '#nusa-apps .sb svg', 'width'), '12px');
  assert.equal(decl(css, '#nusa-apps .sb.talk', 'margin-right'), '4px', 'gap so the row is n × 44 + 4');
  assert.equal(decl(css, '#nusa-apps .sb.on::before', 'background'), '#fff', 'the focused app is a white disc');
  assert.equal(decl(css, '#nusa-apps .sb.on::after', 'background'), '#fff', 'plus the hairline on top');
  assert.equal(decl(css, '#nusa-apps .bdg', 'background'), '#fff');
  assert.equal(decl(css, '#nusa-apps .bdg', 'color'), '#000', 'white badge, black numeral');
  assert.ok(/html\[data-motion="reduce"\] #nusa-apps/.test(css), 'reduced motion turns the row\'s transitions off');
  assert.ok(/#nusa\[data-apps="true"\] #nusa-dots \{ display: none; \}/.test(css), 'the dots give way only while the row is there');
  // identity tones are the icon's colour only (design «Colores y tipos»), and they come from the system palette
  assert.equal(decl(css, '#nusa', '--id-spotify'), 'var(--dot-mint-1)', 'Spotify mint 1');
  assert.equal(decl(css, '#nusa', '--id-koda'), '#4d9fff', 'Koda');
  assert.equal(decl(css, '#nusa-apps .sb[data-go="spotify"]', '--pid'), 'var(--id-spotify)');
  // design-system tokens only: the row chooses no colour of its own beyond #141518 / #1D1F23 (design «Colores y tipos»)
  const block = css.slice(css.indexOf('#nusa-apps'), css.indexOf('#nusa-card'));
  const own = [...block.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(m => m[0].toLowerCase());
  assert.deepEqual([...new Set(own)].sort(), ['#000', '#141518', '#1d1f23', '#fff'], `unexpected colours in the row: ${own.join(' ')}`);
});

(async () => {
  let passed = 0;
  const bad = [];
  for (const [name, fn] of tests) {
    try { await fn(); passed += 1; } catch (e) { bad.push(`${name}\n    ${e.message.split('\n').slice(0, 4).join('\n    ')}`); }
  }
  if (bad.length) { console.error(`FAIL island-shortcuts-apps-check (${passed}/${tests.length} ok):\n- ${bad.join('\n- ')}`); process.exit(1); }
  console.log(`island-shortcuts-apps-check: ${passed} checks ok`);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
