'use strict';
/* K2-10 T5 (S1, S2, S3, S5, S6, S7, S9, S12) — pure checks for frontend/gmail-view.js, the Gmail card of the island's icon row
   (design/k2-09-atajos/08-isla-unida.html, «Gmail · solo lo nuevo»). No DOM, no IPC, no network: the card's model is driven with
   a fake `gmail_action` whose answers are the closed shapes src/gmailcmd.rs produces, and the registration is exercised against
   the real frontend/island-shortcuts.js.
   Run: node apps/desktop-tauri/test-node/gmail-view-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const frontend = path.join(__dirname, '..', 'frontend');
const G = require(path.join(frontend, 'gmail-view.js'));
const S = require(path.join(frontend, 'island-shortcuts.js'));
const src = fs.readFileSync(path.join(frontend, 'gmail-view.js'), 'utf8');
const css = fs.readFileSync(path.join(frontend, 'gmail-view.css'), 'utf8');
const NOW = new Date(2026, 10, 13, 15, 0, 0).getTime(); // 13-nov-2026, 15:00 local
const at = (h, m, day) => new Date(2026, 10, day || 13, h, m, 0).getTime();

let passed = 0;
const queue = [];
const test = (name, fn) => { queue.push([name, fn]); };

/** A fake host: records every (command, payload) and answers from the handler. */
const host = handler => {
  const calls = [];
  const invoke = async (cmd, args) => {
    calls.push([cmd, args && args.payload]);
    return handler(cmd, (args && args.payload) || {}, calls.length);
  };
  return { calls, invoke, payloads: () => calls.map(c => c[1]) };
};
const answers = list => {
  const rest = list.slice();
  return host(() => (rest.length ? rest.shift() : undefined));
};
const statusAnswer = state => ({ ok: true, state, clientId: null, hasSecret: false });
const inboxAnswer = (n = 2) => ({
  ok: true,
  messages: Array.from({ length: n }, (_, i) => ({
    id: `id${i}`, from: `Remitente ${i}`, address: `r${i}@example.test`, subject: `Asunto ${i}`,
    snippet: `Vista previa ${i}`, dateMs: at(9, 30 - i), unread: i === 0, important: false,
  })),
  newCount: n, newCountCapped: false, unreadCount: 5, lastSeenMs: 0,
});
const detailAnswer = {
  ok: true,
  detail: {
    id: 'id0', from: 'Lucía Pérez', address: 'lucia.perez@estudiolua.es', subject: 'Presupuesto Q4',
    replySubject: 'Re: Presupuesto Q4', body: 'Hola **Álvaro**:\n- versión 3\n- antes del viernes',
    bodyTruncated: false, dateMs: at(9, 31), unread: true, important: true,
    links: [
      { text: 'Ver documento', url: 'https://docs.google.com/document/d/1', domain: 'docs.google.com', sameAsSender: false },
      { text: 'Hoja', url: 'https://estudiolua.es/q4', domain: 'estudiolua.es', sameAsSender: true },
    ],
  },
};

// ---- harness: a host that answers on command, a fake DOM and fake timers ----------------------
// D1, D2, D3 and D6 are about WHAT the card asks and WHEN, so the checks below drive the controller (makeCard) and the real
// paintCard against a host that answers only when the test says so, and the real browser mount against a fake document,
// window and clock. No jsdom, no browser, no network.
const flush = () => new Promise(r => setImmediate(r));

/** A host that answers on command: stale, racing and out-of-order answers are the point of D2 and D3. */
const pendingHost = (sink, opts) => {
  const autoSeen = !opts || opts.autoSeen !== false;
  const calls = [];
  const invoke = (cmd, args) => new Promise(resolve => {
    const payload = (args && args.payload) || null;
    if (sink && payload) sink.push(payload.action);
    const call = { cmd, payload, resolve, done: false };
    calls.push(call);
    // a visit is not what most of these checks are about: the host accepts it at once unless the test says otherwise
    if (autoSeen && payload && payload.action === 'seen') { call.done = true; call.resolve({ ok: true, lastSeenMs: payload.atMs }); }
  });
  const take = action => calls.find(c => !c.done && c.payload && c.payload.action === action) || null;
  const answer = async (action, reply) => {
    const call = take(action);
    assert.ok(call, `the card never sent «${action}»`);
    call.done = true; call.resolve(reply); await flush();
    return call;
  };
  const actions = () => calls.map(c => (c.payload && c.payload.action) || null);
  const count = action => calls.filter(c => c.payload && c.payload.action === action).length;
  const pending = () => calls.filter(c => !c.done).map(c => (c.payload && c.payload.action) || null);
  return { invoke, calls, take, answer, actions, count, pending };
};

/** The subset of the DOM paintCard touches: nodes, children, attributes, listeners and a `.class` lookup. */
function fakeDom(sink) {
  const log = [];
  const mark = what => { log.push(what); if (sink) sink.push(what); };
  const walk = node => (node ? [node, ...node.children.flatMap(walk)] : []);
  const mk = (tag, kind) => {
    const node = {
      kind: kind || 'element', tagName: String(tag).toUpperCase(), className: '', dataset: {}, attrs: {},
      textContent: '', title: '', type: '', hidden: false, children: [], listeners: {}, parent: null, firstChild: null,
      setAttribute(k, v) { node.attrs[k] = String(v); },
      removeAttribute(k) { delete node.attrs[k]; },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(node.attrs, k) ? node.attrs[k] : null; },
      append(...kids) { for (const k of kids) { k.parent = node; node.children.push(k); } node.firstChild = node.children[0] || null; },
      replaceChildren(...kids) {
        node.children = []; node.firstChild = null;
        if (node.className === 'gm-list' && kids.length) mark('paint'); // the rows reached the screen
        node.append(...kids);
      },
      remove() {
        const p = node.parent;
        if (!p) return;
        p.children = p.children.filter(c => c !== node);
        if (p.firstChild === node) p.firstChild = p.children[0] || null;
        node.parent = null;
      },
      addEventListener(type, fn) { (node.listeners[type] = node.listeners[type] || []).push(fn); },
      querySelector(sel) { return find(node, sel); },
      focus() {},
      fire(type, ev) { for (const fn of (node.listeners[type] || []).slice()) fn(ev || { isTrusted: true }); },
    };
    return node;
  };
  const match = (node, sel) => {
    const want = sel.startsWith('.') ? sel.slice(1) : '';
    return walk(node).filter(n => (want ? n.className.split(/\s+/).includes(want) : n.tagName === sel.toUpperCase()));
  };
  const find = (node, sel) => match(node, sel).find(n => n !== node) || null;
  const doc = {
    hidden: false, listeners: {},
    createElement: tag => mk(tag),
    createTextNode: text => { const n = mk('#text', 'text'); n.textContent = String(text); return n; },
    getElementById: () => null,
    addEventListener(type, fn) { (doc.listeners[type] = doc.listeners[type] || []).push(fn); },
    fire(type) { for (const fn of (doc.listeners[type] || []).slice()) fn({}); },
  };
  return { doc, mk, find, match, log, walk };
}

/** Runs `fn` with the fake document installed as the page's `document` (paintCard reads it at call time). */
const withDom = async (fn, sink) => {
  const dom = fakeDom(sink);
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'document');
  const prev = globalThis.document;
  globalThis.document = dom.doc;
  try { await fn(dom); } finally { if (had) globalThis.document = prev; else delete globalThis.document; }
};

/** Fake intervals on a virtual clock: the card's 15 s status read and 60 s list refresh, without waiting a minute. */
function fakeTimers() {
  let seq = 0, clock = 0;
  const jobs = new Map();
  const set = (fn, ms) => {
    const every = Math.max(1, Math.round(Number(ms) || 0));
    const job = { id: ++seq, fn, every, due: clock + every };
    jobs.set(job.id, job);
    return job.id;
  };
  const clear = id => { jobs.delete(id); };
  const advance = async ms => {
    const end = clock + Math.max(0, Number(ms) || 0);
    for (let guard = 0; guard < 10000; guard += 1) {
      let next = null;
      for (const job of jobs.values()) if (job.due <= end && (!next || job.due < next.due)) next = job;
      if (!next) break;
      clock = next.due;
      next.due += next.every;
      next.fn();
      await flush();
    }
    clock = end;
    await flush();
  };
  return { set, clear, advance, jobs };
}

/** The REAL browser mount of the card (the tail of gmail-view.js) on a fake document, window and clock. */
function bootIsland(handler, sink) {
  const dom = fakeDom(sink);
  const capsule = dom.mk('div');
  capsule.dataset.phase = 'expanded';
  capsule.dataset.view = 'overview';
  dom.doc.getElementById = id => (id === 'capsule' ? capsule : null);
  const timers = fakeTimers();
  const calls = [];
  const invoke = (cmd, args) => {
    const payload = (args && args.payload) || null;
    calls.push({ cmd, payload });
    if (sink && payload) sink.push(payload.action);
    return Promise.resolve(handler(payload, calls.length));
  };
  const state = { refreshes: 0, def: null };
  const shortcuts = {
    KODA: { id: 'koda' },
    refresh: () => { state.refreshes += 1; },
    registerCard: d => { state.def = d; return () => {}; },
    card: () => null,
  };
  const root = {
    AbitoShortcuts: shortcuts,
    __TAURI__: { core: { invoke } },
    listeners: {},
    addEventListener(type, fn) { (root.listeners[type] = root.listeners[type] || []).push(fn); },
    fire(type) { for (const fn of (root.listeners[type] || []).slice()) fn({}); },
  };
  const sandbox = { self: root, window: root, document: dom.doc, setInterval: timers.set, clearInterval: timers.clear };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'gmail-view.js' });
  return {
    dom, capsule, timers, calls, state, win: root,
    get def() { return state.def; },
    refreshes: () => state.refreshes,
    actions: () => calls.map(c => (c.payload && c.payload.action) || null),
    count: action => calls.filter(c => c.payload && c.payload.action === action).length,
    paints: () => dom.log.filter(what => what === 'paint').length,
  };
}

/** The row buttons paintRows put on screen, by the message id they open. */
const rowButton = (dom, el, id) => dom.match(el, '.gm-row').find(b => b.dataset.id === id) || null;

// ---- S5: the head counter and the icon count -------------------------------------------------
test('S5 counter: «N nuevos · M sin leer», singular, and «100+» when the host capped its page', () => {
  assert.equal(G.counterText({ newCount: 4, newCountCapped: false, unreadCount: 128 }), '4 nuevos · 128 sin leer');
  assert.equal(G.counterText({ newCount: 1, unreadCount: 1 }), '1 nuevo · 1 sin leer');
  assert.equal(G.counterText({ newCount: 0, unreadCount: 0 }), '0 nuevos · 0 sin leer');
  assert.equal(G.counterText({ newCount: 100, newCountCapped: true, unreadCount: 128 }), '100+ nuevos · 128 sin leer');
  assert.equal(G.counterText({}), '0 nuevos · 0 sin leer', 'an empty answer is zero, never a guess');
  assert.equal(G.counterText({ newCount: '3', unreadCount: -1 }), '3 nuevos · 0 sin leer');
  assert.equal(G.counterText({ newCount: -2, unreadCount: 2.9 }), '0 nuevos · 2 sin leer');
  assert.equal(G.counterText(null), '0 nuevos · 0 sin leer');
});

test('S12 badge: the icon counts «nuevos» (a number, whole and >= 0); a capped page reads 100', () => {
  assert.equal(G.badgeOf({ newCount: 4 }), 4);
  assert.equal(G.badgeOf({ newCount: 100, newCountCapped: true }), 100, 'the mount paints a number, so 100 stands for «100+»');
  assert.equal(G.badgeOf({ newCount: 3.7 }), 3);
  assert.equal(G.badgeOf({ newCount: -4 }), 0);
  assert.equal(G.badgeOf({}), 0);
  assert.equal(G.badgeOf(null), 0);
  assert.equal(G.BADGE_CAP, 100);
});

// ---- S5/S12: the four filters ----------------------------------------------------------------
test('S5 filters: Nuevos · Importantes · De personas · Todos — Nuevos by default, the closed payload', () => {
  assert.deepEqual(G.FILTERS.map(f => f.id), ['nuevos', 'importantes', 'personas', 'todos']);
  assert.deepEqual(G.FILTERS.map(f => f.label), ['Nuevos', 'Importantes', 'De personas', 'Todos']);
  assert.equal(G.DEFAULT_FILTER, 'nuevos');
  for (const f of G.FILTERS) assert.deepEqual(G.inboxPayload(f.id), { action: 'inbox', filter: f.id });
  for (const bad of ['Nuevos', 'imp', '', null, undefined, 5, {}, 'todos ']) {
    assert.deepEqual(G.inboxPayload(bad), { action: 'inbox', filter: 'nuevos' }, JSON.stringify(bad));
  }
  // the empty line speaks of the filter that is showing
  assert.equal(G.EMPTY.nuevos, 'No tenés correos nuevos');
  for (const f of G.FILTERS) assert.match(G.EMPTY[f.id], /^No /);
});

// ---- S1: a row is sender, subject and a one-line preview -------------------------------------
test('S1 rows: sender, subject, one-line preview, unread flag, and a readable line for a screen reader', () => {
  const now = NOW, today = at(9, 31);
  assert.equal(G.whenText(today, now), '09:31');
  assert.equal(G.whenText(at(9, 31, 12), now), 'ayer');
  assert.equal(G.whenText(at(9, 31, 11), now), '11/11');
  assert.equal(G.whenText(0, now), '');
  const r = G.rowView({ id: 'abc', from: 'Lucía Pérez', address: 'lucia.perez@estudiolua.es', subject: 'Presupuesto Q4',
    snippet: 'Hola\n\nÁlvaro:   te paso la versión 3', dateMs: today, unread: true, important: true }, now);
  assert.equal(r.id, 'abc');
  assert.equal(r.from, 'Lucía Pérez');
  assert.equal(r.subject, 'Presupuesto Q4');
  assert.equal(r.preview, 'Hola Álvaro: te paso la versión 3', 'one line: the newlines collapse');
  assert.equal(r.when, '09:31');
  assert.equal(r.unread, true);
  assert.match(r.aria, /^Sin leer/);
  assert.match(r.aria, /Lucía Pérez, Presupuesto Q4, 09:31/);
  const read = G.rowView({ id: 'x', from: '', address: 'r@example.test', subject: '', snippet: '', dateMs: today, unread: false }, now);
  assert.equal(read.from, 'r@example.test', 'no name: the address stands in');
  assert.equal(read.subject, '(Sin asunto)');
  assert.match(read.aria, /^Leído/);
  assert.equal(G.rowView({ id: 'y', from: 'A', snippet: '<b>x</b> y' }, now).preview, '<b>x</b> y', 'text stays text');
  assert.ok(G.rowView({ id: 'z', from: 'A', snippet: 'x'.repeat(400) }, now).preview.length <= G.MAX_PREVIEW);
});

test('S1/S3 inbox: up to 20 rows, the counter, and the empty state — never a sample row', () => {
  const many = inboxAnswer(40);
  const view = G.rowsOf(many, NOW, 'nuevos');
  assert.equal(view.ok, true);
  assert.equal(view.rows.length, G.MAX_ROWS, 'the host pages 20 and the card never paints more');
  assert.equal(G.MAX_ROWS, 20);
  assert.equal(view.counter, '40 nuevos · 5 sin leer');
  assert.equal(view.empty, false);
  const empty = G.rowsOf({ ok: true, messages: [], newCount: 0, newCountCapped: false, unreadCount: 128, lastSeenMs: 0 }, NOW, 'nuevos');
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.rows, [], 'nothing connected to invent: an empty inbox paints no row');
  assert.equal(empty.empty, true);
  assert.equal(empty.emptyText, 'No tenés correos nuevos');
  assert.equal(G.rowsOf({ ok: true, messages: [] }, NOW, 'personas').emptyText, 'No tenés correos de personas');
  assert.equal(G.rowsOf(inboxAnswer(1), NOW, 'nope').filter, 'nuevos', 'an unknown filter falls back to the default');
});

test('S3 errors: one honest Spanish line per code, never the raw code nor an HTTP body', () => {
  const bad = G.rowsOf({ ok: false, reason: 'network' }, NOW);
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'network');
  assert.match(bad.message, /conexión/);
  assert.match(bad.message, /reintentá|Probá/i);
  assert.match(G.errorText('rate_limited'), /esperar|rato/i);
  assert.match(G.errorText('forbidden'), /permiso/);
  assert.match(G.errorText('needs_sign_in'), /Ajustes|conectar/i);
  assert.equal(G.errorText('failed'), 'No pude traer tus correos. Reintentá en un rato.');
  for (const code of ['network', 'rate_limited', 'forbidden', 'needs_sign_in', 'invalid', 'server', 'keychain', 'prefs', 'failed']) {
    const text = G.errorText(code);
    assert.ok(text.length > 12, code);
    assert.doesNotMatch(text, new RegExp(code), `${code} is not shown to a person`);
    assert.doesNotMatch(text, /[<>{}]|http/i, `${code} never leaks markup or an address`);
  }
  assert.equal(G.errorText('weird_code_from_the_future'), G.errorText('failed'));
  assert.equal(G.rowsOf({ ok: false, reason: 'weird' }, NOW).reason, 'failed');
  assert.equal(G.rowsOf({ ok: true }, NOW).ok, false, 'an answer without a list is not a list');
  assert.equal(G.rowsOf(null, NOW).ok, false);
});

// ---- S3/S12: availability ---------------------------------------------------------------
test('S3 available(): true ONLY on a connected status; no_client, signed_out and reconnect leave no icon', () => {
  assert.deepEqual(G.STATUSES, ['no_client', 'signed_out', 'connected', 'reconnect']);
  for (const state of G.STATUSES) assert.equal(G.available(state), state === 'connected', state);
  for (const bad of [null, undefined, 'Connected', ' connected', '', 1, true, {}, { state: 'connected' }]) {
    assert.equal(G.available(bad), false, JSON.stringify(bad));
  }
  assert.deepEqual(G.statusAnswer(statusAnswer('reconnect')), { state: 'reconnect' });
  assert.equal(G.statusAnswer({ ok: false, reason: 'keychain' }), null);
  assert.equal(G.statusAnswer({ ok: true, state: 'spam' }), null, 'an unknown state is not a connection');
  assert.deepEqual(G.statusPayload(), { action: 'status' });
});

// ---- S6: the plain-text body ------------------------------------------------------------
test('S6 body: text with **bold** and lists becomes plain blocks; markup never becomes markup', () => {
  assert.deepEqual(G.bodyBlocks('Hola **Álvaro**:\n- versión 3\n- antes del viernes'), [
    { kind: 'p', runs: [{ text: 'Hola ', bold: false }, { text: 'Álvaro', bold: true }, { text: ':', bold: false }] },
    { kind: 'li', runs: [{ text: 'versión 3', bold: false }] },
    { kind: 'li', runs: [{ text: 'antes del viernes', bold: false }] },
  ]);
  assert.deepEqual(G.bodyBlocks('  \n\n '), []);
  assert.deepEqual(G.bodyBlocks(null), []);
  assert.deepEqual(G.bodyBlocks('<b>hola</b>'), [{ kind: 'p', runs: [{ text: '<b>hola</b>', bold: false }] }], 'HTML is text here');
  assert.deepEqual(G.bodyBlocks('*no* es negrita'), [{ kind: 'p', runs: [{ text: '*no* es negrita', bold: false }] }]);
  assert.deepEqual(G.bodyBlocks('• viñeta'), [{ kind: 'li', runs: [{ text: 'viñeta', bold: false }] }]);
  assert.deepEqual(G.bodyBlocks('**a** y **b**'),
    [{ kind: 'p', runs: [{ text: 'a', bold: true }, { text: ' y ', bold: false }, { text: 'b', bold: true }] }]);
});

test('S6 clean(): bidi overrides and zero-width marks never reach the screen', () => {
  // U+202A-U+202E, U+2066-U+2069, U+200E/F: a sender could reorder what the row seems to say («fdp.exe» drawn as «exe.pdf»)
  assert.equal(G.clean('Presupuesto\u202E 300'), 'Presupuesto 300');
  assert.equal(G.clean('Hola\u2066mundo\u2069'), 'Holamundo');
  assert.equal(G.clean('\u200Ea\u200Fb'), 'ab');
  assert.equal(G.rowView({ id: 'x', from: 'Ana\u202E', subject: 'Acta\u202C', snippet: 'nada\u2067' }, NOW).from, 'Ana');
  assert.equal(G.rowView({ id: 'x', from: 'Ana', subject: 'Acta\u202C' }, NOW).subject, 'Acta');
});

// ---- S6/S7: link chips and the confirmation before a foreign domain ----------------------
test('S6 link chips: the chip shows the REAL domain, never the anchor text', () => {
  const chip = G.linkView({ text: 'Ver el documento compartido', url: 'https://docs.google.com/document/d/1', domain: 'docs.google.com', sameAsSender: false });
  assert.equal(chip.label, 'docs.google.com');
  assert.equal(chip.url, 'https://docs.google.com/document/d/1');
  assert.equal(chip.sameAsSender, false);
  assert.equal(G.linkView({ url: 'javascript:alert(1)', domain: 'x.test', sameAsSender: true }), null, 'a non-http link is not a chip');
  assert.equal(G.linkView(null), null);
  const noDomain = G.linkView({ url: 'https://mail.example.test/x', sameAsSender: true });
  assert.equal(noDomain.label, 'mail.example.test', 'without a host-supplied domain the URL\'s own host is shown');
  assert.ok(G.detailView(detailAnswer.detail, NOW).links.length <= G.MAX_LINKS);
  assert.equal(G.MAX_LINKS, 30);
});

test('D4 chip domain: the chip shows the URL\'s own host, never the `domain` string the host sent beside it', () => {
  // the host field is ignored for display: the domain the human reads comes from the URL, lowercased, `www.` stripped
  assert.equal(G.linkView({ url: 'https://docs.google.com/document/d/1', domain: 'lie.test', sameAsSender: false }).label, 'docs.google.com');
  assert.equal(G.linkView({ url: 'https://WWW.EstudioLua.es/q4', domain: 'lie.test' }).label, 'estudiolua.es');
  assert.equal(G.linkView({ url: 'https://www.google.com/x' }).label, 'google.com');
  assert.equal(G.linkView({ url: 'https://sub.example.test/x', domain: 'example.test' }).label, 'sub.example.test');
  assert.equal(G.linkView({ url: 'https://example.test:8443/x' }).label, 'example.test', 'the port is not part of the domain');
  assert.equal(G.linkView({ url: 'https://example.test/x', domain: '' }).label, 'example.test');
  // `sameAsSender` keeps being the host's verdict — it is not re-derived from the domain string
  assert.equal(G.linkView({ url: 'https://bit.ly/3x', domain: 'estudiolua.es', sameAsSender: false }).sameAsSender, false);
  assert.equal(G.linkView({ url: 'https://estudiolua.es/q4', domain: 'bit.ly', sameAsSender: true }).label, 'estudiolua.es');
  const ask = G.openAction({ url: 'https://bit.ly/3x', domain: 'estudiolua.es', sameAsSender: false }, 'lucia@estudiolua.es');
  assert.equal(ask.domain, 'bit.ly', 'the question names the domain the human is really going to');
  assert.equal(ask.text, 'Este enlace va a bit.ly, no a estudiolua.es · ¿Abrirlo igual?');
  // the opened message paints those chips, so the lie never reaches the screen either
  const detail = G.messageAnswer({ ok: true, detail: { ...detailAnswer.detail, links: [{ url: 'https://real.test/x', domain: 'lie.test', sameAsSender: false }] } }, NOW);
  assert.deepEqual(detail.detail.links.map(l => l.label), ['real.test']);
});

test('S7 confirmation: the sender\'s own domain opens directly, another domain asks first, non-http never opens', () => {
  const opened = [];
  const f = answers([statusAnswer('connected')]);
  const { ctl } = G.makeCard({ invoke: f.invoke, now: () => NOW, open: url => opened.push(url) });
  const own = { text: 'Hoja', url: 'https://estudiolua.es/q4', domain: 'estudiolua.es', sameAsSender: true };
  const other = { text: 'Ver', url: 'https://bit.ly/3x', domain: 'bit.ly', sameAsSender: false };
  assert.deepEqual(ctl.openLink(own, 'lucia.perez@estudiolua.es'), { kind: 'open', url: 'https://estudiolua.es/q4' });
  assert.deepEqual(opened, ['https://estudiolua.es/q4'], 'the sender\'s own domain goes straight through the shared opener');
  const ask = ctl.openLink(other, 'lucia.perez@estudiolua.es');
  assert.equal(ask.kind, 'confirm');
  assert.equal(ask.domain, 'bit.ly');
  assert.equal(ask.url, 'https://bit.ly/3x');
  assert.equal(ask.text, 'Este enlace va a bit.ly, no a estudiolua.es · ¿Abrirlo igual?');
  assert.deepEqual(opened, ['https://estudiolua.es/q4'], 'nothing opens before the human says yes');
  assert.deepEqual(ctl.pendingView(), ask, 'the row that asks is drawn from the pending link');
  assert.equal(ctl.confirmPending(), true);
  assert.deepEqual(opened, ['https://estudiolua.es/q4', 'https://bit.ly/3x']);
  assert.equal(ctl.pendingView(), null, 'asking once is enough');
  assert.equal(ctl.confirmPending(), false);
  assert.deepEqual(G.CONFIRM, { yes: 'Abrir', no: 'Cancelar' });
  // Cancelar opens nothing and clears the question
  ctl.openLink(other, 'lucia.perez@estudiolua.es');
  assert.equal(ctl.cancelPending(), true);
  assert.equal(ctl.pendingView(), null);
  assert.equal(opened.length, 2);
  // a link without the host's verdict is never treated as the sender's
  assert.equal(ctl.openLink({ url: 'https://evil.test/x', domain: 'evil.test' }, 'a@estudiolua.es').kind, 'confirm');
  assert.equal(ctl.openLink({ url: 'https://evil.test/x', domain: 'evil.test', sameAsSender: 'true' }, 'a@estudiolua.es').kind, 'confirm');
  // non-http and credential-carrying URLs never reach the opener
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<b>x</b>', 'http://u:p@example.test/', '', null]) {
    assert.equal(ctl.openLink({ url: bad, sameAsSender: true }, 'a@b.test').kind, 'refuse', String(bad));
  }
  assert.equal(ctl.openLink(null, 'a@b.test').kind, 'refuse');
  assert.equal(opened.length, 2, 'a refused link never opens anything');
  assert.equal(G.openAction({ url: 'https://mail.estudiolua.es/x', domain: 'mail.estudiolua.es', sameAsSender: true }, 'ana@estudiolua.es').kind, 'open',
    'a subdomain of the sender counts as the sender\'s (the host decides, the card copies)');
  assert.equal(G.confirmText('bit.ly', 'estudiolua.es'), 'Este enlace va a bit.ly, no a estudiolua.es · ¿Abrirlo igual?');
  assert.equal(G.confirmText('bit.ly', ''), 'Este enlace va a bit.ly · ¿Abrirlo igual?');
  assert.equal(G.senderDomain('lucia.perez@estudiolua.es'), 'estudiolua.es');
  assert.equal(G.senderDomain('nope'), '');
});

// ---- S6: the opened message --------------------------------------------------------------
test('S6 detail: sender, subject, plain body, truncation notice and the chips of its links', () => {
  const view = G.messageAnswer(detailAnswer, NOW);
  assert.equal(view.ok, true);
  const d = view.detail;
  assert.equal(d.from, 'Lucía Pérez');
  assert.equal(d.address, 'lucia.perez@estudiolua.es');
  assert.equal(d.initials, 'L');
  assert.equal(d.subject, 'Presupuesto Q4');
  assert.equal(d.when, '09:31');
  assert.equal(d.replySubject, 'Re: Presupuesto Q4');
  assert.equal(d.bodyTruncated, false);
  assert.deepEqual(d.links.map(l => l.label), ['docs.google.com', 'estudiolua.es']);
  assert.equal(d.blocks.length, 3);
  assert.equal(d.blocks[0].runs[1].bold, true);
  const truncated = G.messageAnswer({ ok: true, detail: { ...detailAnswer.detail, bodyTruncated: true } }, NOW);
  assert.equal(truncated.detail.bodyTruncated, true);
  assert.equal(G.messageAnswer({ ok: false, reason: 'forbidden' }, NOW).ok, false);
  assert.match(G.messageAnswer({ ok: false, reason: 'forbidden' }, NOW).message, /permiso/);
  assert.equal(G.messageAnswer({ ok: true }, NOW).ok, false, 'no detail, no card');
});

// ---- S2/S5: the host verbs the card sends ------------------------------------------------
test('S2 reply: «Responder» sends the closed reply verb (the HOST opens the mail client, never the page)', async () => {
  const f = answers([{ ok: true, opened: true }]);
  const { ctl } = G.makeCard({ invoke: f.invoke, now: () => NOW, open: () => {} });
  const r = await ctl.reply('id0');
  assert.equal(r.ok, true);
  assert.equal(r.opened, true);
  assert.deepEqual(f.payloads(), [{ action: 'reply', id: 'id0' }]);
  const refused = answers([{ ok: false, reason: 'invalid' }]);
  const other = G.makeCard({ invoke: refused.invoke, now: () => NOW, open: () => {} }).ctl;
  assert.equal((await other.reply('id0')).ok, false);
  const never = answers([]);
  const bad = G.makeCard({ invoke: never.invoke, now: () => NOW, open: () => {} }).ctl;
  for (const id of ['', 'a/b', '../etc', null, 5]) assert.equal((await bad.reply(id)).ok, false, String(id));
  assert.deepEqual(never.payloads(), [], 'a refused id never reaches the host');
  assert.deepEqual(G.messagePayload('a_b-1'), { action: 'message', id: 'a_b-1' });
  assert.equal(G.messagePayload('a b'), null);
  assert.equal(G.messagePayload('x'.repeat(G.MAX_ID + 1)), null);
});

test('S5 seen: the visit is stamped with the page clock, once per focus session, and never by a failure or a detail', async () => {
  const f = pendingHost(undefined, { autoSeen: false });
  const { ctl } = G.makeCard({ invoke: f.invoke, now: () => NOW, open: () => {} });
  // loading the list is not a visit any more (D2): the stamp belongs to the first paint of the session
  const load = ctl.inbox('nuevos');
  await flush();
  assert.deepEqual(f.actions(), ['inbox'], 'a load alone stamps nothing');
  await f.answer('inbox', inboxAnswer(4));
  assert.equal((await load).ok, true);
  assert.deepEqual(f.actions(), ['inbox'], 'the controller never stamps on its own');
  assert.equal(await ctl.markSeen(), false, 'no focus session, no visit');
  assert.deepEqual(f.actions(), ['inbox'], 'and nothing is asked of the host');
  ctl.beginSession();
  const stamp = ctl.markSeen();
  await flush();
  assert.deepEqual(f.actions(), ['inbox', 'seen']);
  assert.deepEqual(f.take('seen').payload, { action: 'seen', atMs: NOW });
  await f.answer('seen', { ok: true, lastSeenMs: NOW });
  assert.equal(await stamp, true);
  assert.equal(await ctl.markSeen(), false, 'one visit per focus session, not one per paint');
  assert.deepEqual(f.actions(), ['inbox', 'seen']);
  // a stamp the host refused is retried on the next paint of the same session
  ctl.endSession();
  ctl.beginSession();
  const retry = ctl.markSeen();
  await flush();
  await f.answer('seen', { ok: false, reason: 'prefs' });
  assert.equal(await retry, false, 'a failed stamp is not counted as done');
  const again = ctl.markSeen();
  await flush();
  assert.deepEqual(f.pending(), ['seen'], 'so the next paint asks again');
  await f.answer('seen', { ok: true, lastSeenMs: NOW });
  assert.equal(await again, true);
  assert.equal(await ctl.markSeen(), false);
  // the clock is the page's; a bad clock sends nothing and stamps nothing
  const badClock = G.makeCard({ invoke: f.invoke, now: () => 0, open: () => {} }).ctl;
  badClock.beginSession();
  assert.equal(await badClock.markSeen(), false);
  // reading one message is not a visit
  const detail = pendingHost();
  const third = G.makeCard({ invoke: detail.invoke, now: () => NOW, open: () => {} }).ctl;
  third.beginSession();
  const read = third.openMessage('id0');
  await flush();
  await detail.answer('message', detailAnswer);
  assert.equal((await read).ok, true);
  assert.deepEqual(detail.actions(), ['message'], 'reading one message is not a visit');
  assert.deepEqual(G.seenPayload(NOW), { action: 'seen', atMs: NOW });
  for (const bad of [0, -1, 1.5, null, 'now', NaN]) assert.equal(G.seenPayload(bad), null, String(bad));
});

test('S1 status: the card is available only after the host answered connected, and the icon count is «nuevos»', async () => {
  const f = answers([statusAnswer('no_client'), statusAnswer('connected'), inboxAnswer(4), statusAnswer('reconnect')]);
  const { ctl, def } = G.makeCard({ invoke: f.invoke, now: () => NOW, open: () => {} });
  assert.equal(ctl.available(), false, 'before the host answers there is nothing to show');
  assert.equal(await ctl.status(), 'no_client');
  assert.equal(ctl.available(), false);
  assert.equal(def.available(), false);
  assert.equal(await ctl.status(), 'connected');
  assert.equal(ctl.available(), true);
  assert.equal(def.available(), true);
  await ctl.inbox();
  assert.equal(def.badge(), 4, 'the icon counts the mail that is new since the last visit');
  assert.equal(await ctl.status(), 'reconnect');
  assert.equal(ctl.available(), false, 'a dead connection hides the icon; Ajustes says what to do');
  assert.equal(def.badge(), 0, 'no connection, no counter');
  assert.deepEqual(f.payloads().map(p => p.action), ['status', 'status', 'inbox', 'status']);
  // a host that throws or says something unknown is not a connection
  const boom = G.makeCard({ invoke: async () => { throw new Error('no ipc'); }, now: () => NOW, open: () => {} }).ctl;
  assert.equal(await boom.status(), null);
  assert.equal(boom.available(), false);
  assert.equal(G.makeCard({ now: () => NOW }).ctl.available(), false);
});

// ---- D1: the icon's counter while the card is not the one being looked at --------------------
test('D1 badge: a counts-only read keeps «nuevos» fresh without stamping a visit and without moving the card\'s filter', async () => {
  const f = pendingHost();
  const { ctl, def } = G.makeCard({ invoke: f.invoke, now: () => NOW, open: () => {} });
  const first = ctl.refreshCounts();
  await flush();
  assert.deepEqual(f.actions(), [], 'no connection: the badge asks the host for nothing');
  assert.equal(await first, 0);
  const status = ctl.status();
  await flush();
  await f.answer('status', statusAnswer('connected'));
  assert.equal(await status, 'connected');
  assert.equal(def.badge(), 0, 'connected but nobody has read the counters yet');
  const read = ctl.refreshCounts();
  await flush();
  assert.deepEqual(f.take('inbox').payload, { action: 'inbox', filter: 'nuevos' }, 'the icon reads the NEW counters');
  await f.answer('inbox', inboxAnswer(7));
  assert.equal(await read, 7);
  assert.equal(def.badge(), 7, 'the icon shows the new count without the card ever being opened');
  assert.equal(f.count('seen'), 0, 'a badge read is not a visit');
  // the filter the card is showing is untouched: the badge read is not a list load
  const imp = ctl.inbox('importantes');
  await flush();
  await f.answer('inbox', inboxAnswer(2));
  await imp;
  assert.equal(ctl.filter(), 'importantes');
  const readAgain = ctl.refreshCounts();
  await flush();
  assert.deepEqual(f.take('inbox').payload, { action: 'inbox', filter: 'nuevos' }, 'the counters never depend on the shown filter');
  await f.answer('inbox', inboxAnswer(9));
  assert.equal(await readAgain, 9);
  assert.equal(ctl.filter(), 'importantes', 'the badge read never moves the card');
  assert.equal(def.badge(), 9);
  // a failed read keeps the number it had: a counter never falls to 0 on a network hiccup
  const bad = ctl.refreshCounts();
  await flush();
  await f.answer('inbox', { ok: false, reason: 'network' });
  assert.equal(await bad, 9);
  assert.equal(def.badge(), 9);
  assert.equal(f.count('seen'), 0);
});

// ---- D2/D3/D6: the painted card, driven through the real paintCard and the real mount ----------
test('D2 seen: the visit is stamped once per focus session, after the rows are painted; a refresh, a filter switch and a stale answer never stamp', async () => {
  const order = [];
  await withDom(async dom => {
    const f = pendingHost(order);
    const { ctl } = G.makeCard({ invoke: f.invoke, now: () => NOW, open: () => {} });
    if (typeof ctl.beginSession === 'function') ctl.beginSession(); // the session the mount opens; tolerant so the RED is behavioural
    const el = dom.mk('section');
    const off = G.paintCard(el, ctl);
    await flush();
    assert.deepEqual(f.actions(), ['inbox'], 'the first paint loads the list and stamps nothing yet');
    await f.answer('inbox', inboxAnswer(3));
    assert.deepEqual(order, ['inbox', 'paint', 'seen'], 'the visit is stamped AFTER the rows are on screen');
    // the 60 s refresh of the mount paints again and is not a visit
    off.refresh();
    await flush();
    await f.answer('inbox', inboxAnswer(1));
    assert.equal(f.count('seen'), 1, 'a periodic refresh never moves the mark');
    // switching filter is not a visit either
    const chip = dom.match(el, '.gm-flt').find(b => b.dataset.filter === 'importantes');
    assert.ok(chip, 'the four filters are on screen');
    chip.fire('click', { isTrusted: true });
    await flush();
    assert.deepEqual(f.take('inbox').payload, { action: 'inbox', filter: 'importantes' });
    await f.answer('inbox', inboxAnswer(0));
    assert.equal(f.count('seen'), 1, 'switching filters never empties «Nuevos»');
    // a superseded answer neither paints nor stamps
    const paintsBefore = dom.log.filter(w => w === 'paint').length;
    off.refresh();
    await flush();
    off.refresh();
    await flush();
    const racing = f.calls.filter(c => !c.done && c.payload && c.payload.action === 'inbox');
    assert.equal(racing.length, 2, 'two loads are in flight');
    const [stale, fresh] = racing;
    fresh.done = true; fresh.resolve(inboxAnswer(2)); await flush();
    stale.done = true; stale.resolve(inboxAnswer(5)); await flush();
    assert.equal(dom.log.filter(w => w === 'paint').length, paintsBefore + 1, 'the stale answer never paints');
    assert.equal(f.count('seen'), 1, 'a stale answer is not a visit');
    assert.equal(dom.find(el, '.gm-new').textContent, '2 nuevos', 'the head shows the answer that really won');
    // closing and re-opening the card is a new session, so the next visit is stamped again
    off();
    if (typeof ctl.beginSession === 'function') ctl.beginSession();
    const el2 = dom.mk('section');
    const off2 = G.paintCard(el2, ctl);
    await flush();
    await f.answer('inbox', inboxAnswer(4));
    assert.equal(f.count('seen'), 2, 'coming back to the card is a new visit');
    off2();
  }, order);
});

test('D3 tickets: a periodic refresh never discards a message that is being fetched', async () => {
  await withDom(async dom => {
    const f = pendingHost();
    const { ctl } = G.makeCard({ invoke: f.invoke, now: () => NOW, open: () => {} });
    const el = dom.mk('section');
    const off = G.paintCard(el, ctl);
    await flush();
    await f.answer('inbox', inboxAnswer(2));
    rowButton(dom, el, 'id0').fire('click', { isTrusted: true });
    await flush();
    assert.deepEqual(f.pending(), ['message'], 'the message is being fetched');
    off.refresh(); // the 60 s timer fires in the middle of that fetch
    await flush();
    if (f.pending().includes('inbox')) await f.answer('inbox', inboxAnswer(2));
    await f.answer('message', detailAnswer);
    const page = dom.find(el, '.gm-msg');
    assert.equal(page.hidden, false, 'the message that was in flight is the one painted');
    assert.equal(dom.find(el, '.gm-subj').textContent, 'Presupuesto Q4');
    assert.equal(dom.find(el, '.gm-from').textContent, 'Lucía Pérez');
    off();
  });
});

test('D6 pending: painting a message drops a link question that was still waiting for an answer', async () => {
  await withDom(async dom => {
    const opened = [];
    const f = pendingHost();
    const { ctl } = G.makeCard({ invoke: f.invoke, now: () => NOW, open: url => opened.push(url) });
    const el = dom.mk('section');
    const off = G.paintCard(el, ctl);
    await flush();
    await f.answer('inbox', inboxAnswer(2));
    rowButton(dom, el, 'id0').fire('click', { isTrusted: true });
    await flush();
    await f.answer('message', detailAnswer);
    const foreign = dom.match(el, '.gm-lnk')[0]; // docs.google.com: not the sender's domain
    assert.ok(foreign, 'the foreign link is a chip');
    foreign.fire('click', { isTrusted: true });
    assert.ok(ctl.pendingView(), 'the chip of another domain asks first');
    assert.equal(dom.find(el, '.gm-cf').hidden, false, 'and the question is on screen');
    // another message is painted (the rows are hidden by then, so this is the handler seam of the test)
    rowButton(dom, el, 'id1').fire('click', { isTrusted: true });
    await flush();
    await f.answer('message', detailAnswer);
    assert.equal(ctl.pendingView(), null, 'painting a message never keeps a link question alive');
    assert.equal(dom.find(el, '.gm-cf').hidden, true);
    assert.equal(ctl.confirmPending(), false, 'and the old question can no longer open anything');
    assert.deepEqual(opened, []);
    off();
  });
});

test('D1 badge, mounted island: the icon counts «nuevos» on the status cadence, with the card never focused and no visit stamped', async () => {
  let reads = 0;
  const boot = bootIsland(payload => {
    if (payload.action === 'status') return statusAnswer('connected');
    reads += 1;
    return inboxAnswer(reads === 1 ? 4 : 7);
  });
  await flush();
  await flush();
  assert.equal(boot.count('status'), 1, 'the island asks who it is when it is shown');
  assert.equal(boot.count('inbox'), 1, 'and reads the NEW counters for the icon');
  assert.equal(boot.count('seen'), 0, 'the icon read is not a visit');
  assert.equal(boot.def.badge(), 4, 'the icon counts the new mail without the card ever being focused');
  // Cost: the status read is cheap (keychain only) and stays on STATUS_MS, but the counters are a full inbox read on Google's API:
  // they follow their own, slower cadence, never the 15 s status one.
  await boot.timers.advance(G.STATUS_MS);
  assert.equal(boot.count('status'), 2, 'the connection is read again on the status cadence');
  assert.equal(boot.count('inbox'), 1, 'but the inbox is NOT read again that soon');
  assert.equal(boot.def.badge(), 4, 'so the number has not moved yet');
  await boot.timers.advance(G.COUNTS_MS - G.STATUS_MS);
  assert.equal(boot.count('inbox'), 2, 'the counters are read again on their own cadence');
  assert.equal(boot.def.badge(), 7, 'and it keeps counting: the number is not frozen at the first read');
  assert.ok(boot.refreshes() >= 2, 'the row repaints when the number moves');
  assert.equal(boot.count('seen'), 0, 'still never a visit');
  assert.equal(boot.dom.log.filter(w => w === 'paint').length, 0, 'and nothing was painted: the card stays closed');
});

test('pagehide stops every timer the card owns: status, list and icon counters', async () => {
  const boot = bootIsland(payload => (payload.action === 'status' ? statusAnswer('connected') : inboxAnswer(3)));
  await flush();
  await flush();
  const el = boot.dom.mk('section');
  boot.def.mount(el);
  await flush();
  await flush();
  assert.ok(boot.timers.jobs.size >= 3, 'status, list and counters timers are running');
  boot.win.fire('pagehide');
  await flush();
  assert.equal(boot.timers.jobs.size, 0, 'pagehide leaves no timer behind (a leaked counters timer would keep reading the inbox)');
  const reads = boot.count('inbox');
  await boot.timers.advance(G.COUNTS_MS * 3);
  assert.equal(boot.count('inbox'), reads, 'and nothing reads the inbox afterwards');
});

test('D3 polling: hiding the window stops the list timer and showing it again starts it once more', async () => {
  const boot = bootIsland(payload => (payload.action === 'status' ? statusAnswer('connected') : inboxAnswer(2)));
  await flush();
  assert.equal(typeof boot.def.mount, 'function');
  const el = boot.dom.mk('section');
  boot.def.mount(el);
  await flush();
  await flush();
  const painted = boot.paints();
  assert.equal(painted, 1, 'the focused card loads and paints the list');
  await boot.timers.advance(G.REFRESH_MS);
  assert.equal(boot.paints(), painted + 1, 'the list refreshes every minute while the card is on screen');
  // the window is hidden: nothing polls
  const before = boot.paints();
  boot.dom.doc.hidden = true;
  boot.dom.doc.fire('visibilitychange');
  await flush();
  await boot.timers.advance(G.REFRESH_MS * 2);
  assert.equal(boot.paints(), before, 'a hidden window polls nothing');
  // and shown again: one refresh now and the timer runs again from here
  boot.dom.doc.hidden = false;
  boot.dom.doc.fire('visibilitychange');
  await flush();
  await flush();
  const shown = boot.paints();
  assert.equal(shown, before + 1, 'showing the window refreshes the list once');
  await boot.timers.advance(G.REFRESH_MS);
  assert.equal(boot.paints(), shown + 1, 'and the timer is back: polling survives hide then show');
});

// ---- S12: the registration contract, against the real registry --------------------------
test('S12 registration: registerCard accepts it; with no connection there is no icon, no card and no sample row', async () => {
  S._reset();
  const connected = answers([statusAnswer('signed_out')]);
  const first = G.makeCard({ invoke: connected.invoke, now: () => NOW, open: () => {} });
  assert.equal(first.def.id, 'gmail');
  assert.equal(first.def.label, 'Gmail');
  assert.equal(first.def.icon, 'mail');
  assert.equal(typeof first.def.mount, 'function');
  assert.equal(typeof first.def.badge, 'function');
  const off = S.registerCard(first.def);
  assert.deepEqual(S.row(), [], 'not connected: no icon, so the island is the usual Nusa');
  await first.ctl.status();
  assert.deepEqual(S.row(), [], 'signed_out is still no connection');
  off();
  assert.deepEqual(S.row(), []);

  const live = answers([statusAnswer('connected'), inboxAnswer(4)]);
  const second = G.makeCard({ invoke: live.invoke, now: () => NOW, open: () => {} });
  S.registerCard(second.def);
  assert.deepEqual(S.row(), [], 'registered but still unanswered: no icon yet');
  await second.ctl.status();
  const row = S.row();
  assert.deepEqual(row.map(it => it.id), ['koda', 'gmail']);
  assert.equal(row[1].label, 'Gmail', 'the icon says Gmail, not a sample inbox');
  assert.equal(row[1].icon, 'mail');
  assert.equal(row[1].num, 2);
  assert.equal(row[1].badge, 0, 'nothing new until the inbox answers');
  await second.ctl.inbox('nuevos');
  assert.equal(S.row()[1].badge, 4);
  S._reset();
});

// ---- source hygiene (S3, S5, S6) ---------------------------------------------------------
test('S6 hygiene: textContent only, no remote image, no navigation, no storage, only gmail_action', () => {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  assert.doesNotMatch(code, /<img|createElement\('img'\)|new Image|background-image|<svg[^>]*href/);
  assert.doesNotMatch(code, /window\.open|fetch\(|XMLHttpRequest|WebSocket|localStorage|sessionStorage|document\.cookie/);
  assert.doesNotMatch(code, /['"`]prefs_action['"`]|integration_action|resend/i, 'no prefs and no other integration: the card has ONE verb');
  assert.match(code, /'gmail_action'/);
  assert.match(code, /open_chat_url/, 'links leave through the existing validated opener');
  assert.doesNotMatch(code, /['"`]#[0-9a-fA-F]{3,8}['"`]|rgba?\(/, 'the colours live in the stylesheet');
  assert.match(code, /isTrusted (?:===|!==) true/, 'synthetic events never act');
  assert.doesNotMatch(code, /lucia|estudiolua|Presupuesto Q4|Xataka/, 'no sample mail in the source');
  assert.doesNotMatch(code, /Marcar como leído|markAsRead|mark_read|addLabelIds|removeLabelIds/i, 'S5: read only, nothing marks mail as read');
  assert.match(code, /label === 'settings'/, 'the settings window runs the same page: the card stays inert there');
  assert.match(code, /setInterval\(|REFRESH_MS/, 'the card refreshes while it is mounted');
  assert.match(code, /clearInterval\(/, 'and stops its timers when it unmounts');
  assert.equal(G.REFRESH_MS, 60000);
  assert.equal(G.STATUS_MS, 15000);
  assert.equal(G.COUNTS_MS, 60000, 'the icon counters cost a full inbox read: one a minute at most');
  assert.ok(G.COUNTS_MS >= 4 * G.STATUS_MS, 'and never on the status cadence');
  assert.doesNotMatch(css, /<img|url\(|@import/i, 'the card ships no image and no remote font');
});

test('wiring: index.html loads the card and its stylesheet once, next to the row; packaging ships both', () => {
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  assert.equal((html.match(/src="gmail-view\.js"/g) || []).length, 1);
  assert.equal((html.match(/href="gmail-view\.css"/g) || []).length, 1);
  assert.ok(html.indexOf('src="gmail-view.js"') > html.indexOf('src="spotify-view.js"'), 'after the Spotify card it follows');
  assert.ok(html.indexOf('src="gmail-view.js"') < html.indexOf('src="island.js"'), 'before the island boots');
  assert.ok(html.indexOf('href="gmail-view.css"') > html.indexOf('href="island-nusa.css"'), 'after the Nusa styles it refines');
  const L = require(path.join(__dirname, '..', 'packaging', 'lib.cjs'));
  assert.ok(L.FRONTEND_FILES.includes('gmail-view.js'));
  assert.ok(L.FRONTEND_FILES.includes('gmail-view.css'));
  const mount = fs.readFileSync(path.join(frontend, 'island-shortcuts-mount.js'), 'utf8');
  assert.match(mount, /mail: \{ d: \[/, 'the icon row can paint the `mail` icon the card registers');
  assert.match(src, /registerCard\(/, 'the card registers itself in the shared shell');
  assert.match(src, /id: 'gmail', label: 'Gmail', icon: 'mail'/);
});

(async () => {
  // every failing check is reported, not just the first: a RED run of this file is the evidence of each defect at once
  const failed = [];
  for (const [name, fn] of queue) {
    try { await fn(); passed += 1; } catch (e) { failed.push([name, e]); }
  }
  if (failed.length) {
    for (const [name, e] of failed) {
      const frames = String((e && e.stack) || '').split('\n').filter(l => /gmail-view-check\.cjs:/.test(l)).slice(0, 2);
      console.error(`FAIL: ${name}\n  ${String((e && e.message) || e).split('\n').join('\n  ')}${frames.length ? `\n  at ${frames.join(' / ').trim()}` : ''}`);
    }
    console.error(`gmail-view-check: ${passed} passed, ${failed.length} failed`);
    process.exit(1);
  }
  console.log(`gmail-view-check: ${passed} checks ok`);
})();
