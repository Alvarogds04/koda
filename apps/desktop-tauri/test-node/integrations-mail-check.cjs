'use strict';
/* #370 F103 — pure checks for frontend/integrations-mail.js (the Mail service
   card: a read-list, an open message and a compose form inside the island).
   FAKE data only: no network, no accounts, no tokens. Sending is NOT wired: it
   returns a closed «no conectado» refusal and changes nothing.
   Run: node apps/desktop-tauri/test-node/integrations-mail-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const M = require(path.join(frontend, 'integrations-mail.js'));

let passed = 0;
const queue = [];
const test = (name, fn) => { queue.push([name, fn]); };
const store0 = () => M.storeFromFrame(M.fakeFrame());
const goodDraft = () => ({ to: 'ana@example.com', subject: 'Hola', body: 'Texto de ejemplo.' });

// ---- frame / store ----------------------------------------------------------
test('fake frame: closed shape, marked fake, accepted by its own validator', () => {
  const f = M.fakeFrame();
  assert.equal(f.type, 'mail');
  assert.equal(f.schema, M.SCHEMA);
  assert.equal(f.fake, true);
  assert.ok(f.messages.length > 0 && f.messages.length <= M.MAX_MESSAGES);
  assert.ok(M.storeFromFrame(f));
  assert.deepEqual(M.fakeFrame(), M.fakeFrame(), 'deterministic');
});

test('storeFromFrame: malformed frames are refused whole', () => {
  const ok = M.fakeFrame();
  const m = ok.messages[0];
  const cases = [null, {}, [], 'x', 7,
    { ...ok, type: 'other' }, { ...ok, schema: 'foreign/1' }, { ...ok, fake: 'yes' },
    { ...ok, messages: 'x' }, { ...ok, token: 't' },
    { ...ok, messages: Array.from({ length: M.MAX_MESSAGES + 1 }, (_, i) => ({ ...m, id: `x${i}` })) },
    { ...ok, messages: [m, { ...m }] }, // duplicate id
    { ...ok, messages: [{ ...m, id: '__proto__' }] }, { ...ok, messages: [{ ...m, id: '' }] },
    { ...ok, messages: [{ ...m, from: '' }] }, { ...ok, messages: [{ ...m, from: 'x'.repeat(M.MAX_FROM + 1) }] },
    { ...ok, messages: [{ ...m, subject: 'x'.repeat(M.MAX_SUBJECT + 1) }] },
    { ...ok, messages: [{ ...m, body: 'x'.repeat(M.MAX_BODY + 1) }] },
    { ...ok, messages: [{ ...m, read: 1 }] }, { ...ok, messages: [{ ...m, minutesAgo: -1 }] },
    { ...ok, messages: [{ ...m, url: 'https://x' }] }, { ...ok, messages: [null] }];
  for (const bad of cases) assert.equal(M.storeFromFrame(bad), null, JSON.stringify(bad).slice(0, 80));
});

test('store is frozen; nothing is open at the start', () => {
  const s = store0();
  assert.ok(Object.isFrozen(s) && Object.isFrozen(s.messages));
  for (const msg of s.messages) assert.ok(Object.isFrozen(msg));
  assert.equal(s.openId, null);
});

// ---- read-list + open message -------------------------------------------------
test('view: list rows in order with unread count, ago, bounded preview; banner is loud', () => {
  const v = M.view(store0());
  assert.equal(v.fake, true);
  assert.match(v.banner, /datos de ejemplo/i);
  assert.equal(v.rows.length, store0().messages.length);
  assert.equal(v.unread, v.rows.filter(r => !r.read).length);
  for (const r of v.rows) { assert.ok(r.preview.length <= M.MAX_PREVIEW); assert.match(r.ago, /^(ahora|hace )/); }
  assert.equal(v.open, null);
  const real = M.view(M.storeFromFrame({ ...M.fakeFrame(), fake: false }));
  assert.equal(real.banner, null);
  assert.equal(M.view(null), null);
});

test('openMessage: opens one message WITHOUT marking it read (NotchBuddy has an explicit button); setRead marks it; unknown ids change nothing', () => {
  const s = store0();
  const unreadId = s.messages.find(x => !x.read).id;
  const opened = M.openMessage(s, unreadId);
  assert.equal(opened.openId, unreadId);
  assert.equal(opened.messages.find(x => x.id === unreadId).read, false, 'opening is not reading');
  const marked = M.setRead(opened, unreadId);
  assert.equal(marked.messages.find(x => x.id === unreadId).read, true);
  assert.equal(marked.openId, unreadId);
  assert.equal(M.setRead(opened, 'nope'), null); assert.equal(M.setRead({}, unreadId), null);
  assert.equal(s.messages.find(x => x.id === unreadId).read, false, 'the old store is untouched');
  const v = M.view(opened);
  assert.equal(v.open.id, unreadId);
  assert.equal(typeof v.open.body, 'string');
  assert.equal(M.view(marked).unread, M.view(s).unread - 1);
  for (const bad of ['nope', '', '__proto__', 'constructor', null, undefined, 7]) assert.equal(M.openMessage(s, bad), null, String(bad));
  assert.equal(M.openMessage({}, unreadId), null);
});

test('closeMessage returns to the list and keeps the read state', () => {
  const s = store0();
  const id = s.messages[0].id;
  const closed = M.closeMessage(M.openMessage(s, id));
  assert.equal(closed.openId, null);
  assert.equal(M.closeMessage(M.setRead(M.openMessage(s, id), id)).messages.find(x => x.id === id).read, true);
  assert.equal(M.closeMessage({}), null);
});

// ---- compose form model --------------------------------------------------------
test('createDraft: empty, frozen, three closed fields', () => {
  const d = M.createDraft();
  assert.deepEqual(d, { to: '', subject: '', body: '' });
  assert.ok(Object.isFrozen(d));
});

test('setField: closed fields, strings only, bounded; rejected input leaves the draft untouched', () => {
  const d = M.createDraft();
  const next = M.setField(d, 'to', 'ana@example.com');
  assert.equal(next.to, 'ana@example.com');
  assert.equal(d.to, '', 'immutable');
  for (const [f, v] of [['cc', 'x'], ['__proto__', 'x'], ['to', 5], ['to', null],
    ['to', 'x'.repeat(M.MAX_TO + 1)], ['subject', 'x'.repeat(M.MAX_SUBJECT + 1)], ['body', 'x'.repeat(M.MAX_BODY + 1)]]) {
    assert.equal(M.setField(d, f, v), null, `${f}`);
  }
  assert.equal(M.setField({ to: 1 }, 'to', 'a'), null, 'not a draft');
});

test('validateDraft: like NotchBuddy only the recipient is required; each rule reports its own Spanish error', () => {
  assert.deepEqual(M.validateDraft(goodDraft()), { ok: true, errors: {} });
  const e = (over) => M.validateDraft({ ...goodDraft(), ...over });
  assert.equal(e({ to: '' }).errors.to, 'Falta el destinatario.');
  for (const bad of ['ana', 'ana@', '@example.com', 'a b@example.com', 'ana@example', 'a@b@c.com', 'ana@example.com, bob@example.com', 'ana@example.com\n']) {
    assert.equal(e({ to: bad }).errors.to, 'El destinatario no es una dirección válida.', JSON.stringify(bad));
  }
  assert.equal(e({ to: '  ana@example.com ' }).ok, true, 'surrounding spaces are forgiven');
  assert.equal(e({ subject: '   ' }).ok, true, 'an empty subject falls back to the file name or «File» in Rust');
  assert.equal(e({ body: '' }).ok, true, 'an empty body is sent as one space');
  assert.equal(e({ subject: 'a\nb' }).errors.subject, 'El asunto no admite saltos de línea ni caracteres de control.');
  assert.equal(e({ body: 'ok\nlínea\ttab' }).ok, true, 'the body keeps newlines and tabs');
  assert.equal(e({ body: 'a\u0000b' }).errors.body, 'El mensaje contiene caracteres de control.');
  const all = M.validateDraft(M.createDraft());
  assert.equal(all.ok, false);
  assert.deepEqual(Object.keys(all.errors), ['to']);
  assert.equal(M.validateDraft(null).ok, false);
  assert.equal(M.validateDraft({ to: 1, subject: 2, body: 3 }).ok, false);
});

const answers = (a) => { const calls = []; return { calls, invoke: (cmd, args) => { calls.push([cmd, args]); return a instanceof Error ? Promise.reject(a) : Promise.resolve(a); } }; };

test('send: a valid draft goes through mail_action with the closed payload and reports success', async () => {
  const f = answers({ ok: true });
  const r = await M.send(Object.freeze(goodDraft()), null, f.invoke);
  assert.deepEqual(r, { ok: true, message: 'Mensaje enviado.' });
  assert.deepEqual(f.calls, [['mail_action', { payload: { action: 'send', to: 'ana@example.com', subject: 'Hola', body: 'Texto de ejemplo.' } }]]);
  assert.ok(Object.isFrozen(r));
});

test('send: the attachment rides as {name,data} and the recipient is trimmed', async () => {
  const f = answers({ ok: true });
  await M.send({ ...goodDraft(), to: ' ana@example.com ' }, { name: 'r.txt', data: 'QQ==' }, f.invoke);
  assert.deepEqual(f.calls[0][1].payload.attachment, { name: 'r.txt', data: 'QQ==' });
  assert.equal(f.calls[0][1].payload.to, 'ana@example.com');
});

test('send: an invalid draft reports validation and never calls the host', async () => {
  const f = answers({ ok: true });
  const r = await M.send(M.createDraft(), null, f.invoke);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid');
  assert.ok(r.errors.to);
  assert.equal((await M.send(null, null, f.invoke)).reason, 'invalid');
  assert.equal(f.calls.length, 0);
});

test('send: every refusal has its own Spanish message; a thrown or off-shape answer is a plain failure', async () => {
  const msg = async (a) => (await M.send(goodDraft(), null, answers(a).invoke));
  for (const reason of ['not_configured', 'smtp_config', 'no_sender', 'keychain_unavailable', 'rejected', 'network']) {
    const r = await msg({ ok: false, reason });
    assert.equal(r.ok, false); assert.equal(r.reason, reason); assert.ok(r.message.length > 10, reason);
  }
  assert.match((await msg({ ok: false, reason: 'no_sender' })).message, /remitente/i);
  assert.equal((await msg(new Error('x'))).reason, 'failed');
  assert.equal((await msg({ ok: true, extra: 1 })).reason, 'failed');
  assert.equal((await msg({ ok: false, reason: 'weird' })).reason, 'failed');
  assert.equal((await msg(null)).reason, 'failed');
  assert.equal((await M.send(goodDraft(), null, undefined)).reason, 'failed');
});

test('attachmentFromFile: bounded by size, name and base64 of the bytes', () => {
  const ok = M.attachmentFromBytes('../r.txt', new Uint8Array([65]));
  assert.deepEqual(ok, { name: 'r.txt', data: 'QQ==' });
  assert.equal(M.attachmentFromBytes('a', new Uint8Array(0)), null);
  assert.equal(M.attachmentFromBytes('a', { length: M.MAX_ATTACHMENT_BYTES + 1 }), null);
  assert.equal(M.attachmentFromBytes('', new Uint8Array([1])), null);
});

// ---- live inbox (IMAP via mail_action) -------------------------------------------------------
const liveAnswer = () => ({ ok: true, messages: [
  { uid: 7, from: 'Ana', address: 'ana@example.com', subject: 'Hola', preview: 'Texto', minutesAgo: 4, read: false },
  { uid: 5, from: 'Bruno', address: 'bruno@example.com', subject: 'Re: algo', preview: 'Otro', minutesAgo: 90, read: true }] });

test('inboxFromAnswer: a closed answer becomes a real (not fake) frame plus a private id→uid/address map', () => {
  const r = M.inboxFromAnswer(liveAnswer());
  assert.equal(r.frame.fake, false);
  assert.deepEqual(r.frame.messages.map(m => m.id), ['u7', 'u5']);
  assert.ok(M.storeFromFrame(r.frame), 'accepted by the store validator');
  assert.deepEqual(r.meta.u7, { uid: 7, address: 'ana@example.com' });
  assert.equal(r.frame.messages[0].body, 'Texto');
  assert.equal(M.view(M.storeFromFrame(r.frame)).banner, null);
  const bad = a => assert.equal(M.inboxFromAnswer(a), null, JSON.stringify(a).slice(0, 70));
  bad(null); bad({ ok: true }); bad({ ok: true, messages: 'x' }); bad({ ok: true, messages: [], extra: 1 });
  bad({ ok: true, messages: Array.from({ length: M.MAX_MESSAGES + 1 }, (_, i) => ({ ...liveAnswer().messages[0], uid: i + 1 })) });
  for (const over of [{ uid: 0 }, { uid: 1.5 }, { uid: '7' }, { from: '' }, { address: 5 }, { read: 'no' }, { minutesAgo: -1 }, { token: 1 }])
    bad({ ok: true, messages: [{ ...liveAnswer().messages[0], ...over }] });
  bad({ ok: true, messages: [liveAnswer().messages[0], liveAnswer().messages[0]] });
  assert.deepEqual(M.inboxFromAnswer({ ok: true, messages: [] }).frame.messages, []);
});

test('loadInbox: asks the host for the inbox; refusals have their own Spanish message; throws are plain failures', async () => {
  const f = answers(liveAnswer());
  const ok = await M.loadInbox(f.invoke);
  assert.equal(ok.ok, true);
  assert.deepEqual(f.calls, [['mail_action', { payload: { action: 'inbox' } }]]);
  for (const reason of ['imap_not_configured', 'imap_config', 'imap_auth', 'imap_tls', 'imap_network', 'imap_protocol', 'keychain_unavailable']) {
    const r = await M.loadInbox(answers({ ok: false, reason }).invoke);
    assert.equal(r.ok, false); assert.equal(r.reason, reason); assert.ok(r.message.length > 10, reason);
  }
  assert.match((await M.loadInbox(answers({ ok: false, reason: 'imap_not_configured' }).invoke)).message, /IMAP/);
  assert.equal((await M.loadInbox(answers(new Error('x')).invoke)).reason, 'failed');
  assert.equal((await M.loadInbox(answers({ ok: false, reason: 'weird' }).invoke)).reason, 'failed');
  assert.equal((await M.loadInbox(answers({ ok: true, messages: [{}] }).invoke)).reason, 'failed');
  assert.equal((await M.loadInbox(undefined)).reason, 'failed');
});

test('markRead / reply / openClient send exactly the closed payloads', async () => {
  const f = answers({ ok: true });
  assert.equal((await M.markRead(f.invoke, 7)).ok, true);
  assert.equal((await M.reply(f.invoke, 'ana@example.com', 'Hola')).ok, true);
  assert.equal((await M.openClient(f.invoke)).ok, true);
  assert.deepEqual(f.calls.map(c => c[1].payload), [
    { action: 'mark_read', uid: 7 }, { action: 'reply', to: 'ana@example.com', subject: 'Hola' }, { action: 'open_client' }]);
  for (const bad of [0, -1, 1.5, '7', null, 2 ** 32]) assert.equal((await M.markRead(f.invoke, bad)).ok, false, String(bad));
  assert.equal((await M.reply(f.invoke, 'nope', 'x')).ok, false);
  assert.equal(f.calls.length, 3, 'invalid input never reaches the host');
  assert.equal((await M.markRead(answers(new Error('x')).invoke, 7)).ok, false);
});

// ---- source hygiene ---------------------------------------------------------------
test('source: textContent only, only the closed mail_action, no window.open, no raw colours, mount inert', () => {
  const src = fs.readFileSync(path.join(frontend, 'integrations-mail.js'), 'utf8');
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  assert.doesNotMatch(src, /window\.open|fetch\(|XMLHttpRequest|WebSocket|localStorage|open_chat_url/);
  assert.match(src, /mail_action/);
  assert.doesNotMatch(src.slice(src.indexOf('function mount')), /fakeFrame/, 'the live card never shows invented mail');
  assert.doesNotMatch(src, /NOT WIRED|no conectado/i);
  assert.match(src, /getElementById\('integrations-mail'\)/);
  assert.match(src, /if \(!host\) return/);
  assert.match(src, /isTrusted !== true/, 'synthetic events never act');
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, ''), /['"`]#[0-9a-fA-F]{3,8}['"`]|rgba?\(/);
});

test('render (DOM-guarded): list, open message and compose form; invalid view hides the host', () => {
  if (typeof document === 'undefined') return;
  const host = document.createElement('div');
  const s = store0();
  M.render(host, M.view(s), M.createDraft(), null);
  assert.equal(host.hidden, false);
  assert.ok(host.querySelector('.ml-fake').textContent.includes('datos de ejemplo'));
  assert.equal(host.querySelectorAll('.ml-row').length, s.messages.length);
  assert.ok(host.querySelector('form.ml-compose'));
  M.render(host, M.view(M.openMessage(s, s.messages[0].id)), M.createDraft(), null);
  assert.ok(host.querySelector('.ml-open'));
  M.render(host, null, M.createDraft(), null);
  assert.equal(host.hidden, true);
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); passed += 1; } catch (e) { console.error(`FAIL: ${name}`); throw e; }
  }
  console.log(`integrations-mail-check: ${passed} checks ok`);
})();
