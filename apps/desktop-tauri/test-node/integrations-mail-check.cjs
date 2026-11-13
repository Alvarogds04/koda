'use strict';
/* K2-10 T4 (S4, S8, S10, S11) — pure checks for frontend/integrations-mail.js, which is now the
   GMAIL SETUP card of Ajustes → Conexiones: paste the user's own desktop client, «Guardar»,
   «Conectar con Google» (begin + poll every second), «Desconectar», the state line and the help
   block of S10 (publish the own app, the unverified warning, free).
   No network, no accounts, no tokens: every call goes to a fake `gmail_action` and its answers are
   the closed shapes src/gmailcmd.rs produces.
   Run: node apps/desktop-tauri/test-node/integrations-mail-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const frontend = path.join(__dirname, '..', 'frontend');
const M = require(path.join(frontend, 'integrations-mail.js'));

const ID = '123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com';
const SECRET = 'GOCSPX-abcDEF_123-xyz';

let passed = 0;
const queue = [];
const test = (name, fn) => { queue.push([name, fn]); };
const src = fs.readFileSync(path.join(frontend, 'integrations-mail.js'), 'utf8');
// The prose may legitimately NAME what was removed (S8); the code must not carry it.
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

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

// ---- the pasted client (S4) --------------------------------------------------------------
test('setClientPayload: only a Google desktop client id, the secret is optional and never trimmed', () => {
  assert.deepEqual(M.setClientPayload(ID, ''), { action: 'set_client', clientId: ID });
  assert.deepEqual(M.setClientPayload(`  ${ID}  `, ''), null, 'pasted whitespace is the page\'s problem: it never reaches the host silently');
  assert.deepEqual(M.setClientPayload(ID, SECRET), { action: 'set_client', clientId: ID, clientSecret: SECRET });
  assert.deepEqual(M.setClientPayload(ID, undefined), { action: 'set_client', clientId: ID });
  for (const bad of ['', '   ', 'nope', 'ana@example.com', `${ID}.extra`, 'x'.repeat(M.MAX_CLIENT_ID + 1), `${ID}\n`, null, 5, {}]) {
    assert.equal(M.setClientPayload(bad, ''), null, JSON.stringify(bad));
  }
  for (const bad of ['se cret', 'a\nb', 'x'.repeat(M.MAX_SECRET + 1), 5]) {
    assert.equal(M.setClientPayload(ID, bad), null, JSON.stringify(bad));
  }
  assert.equal(M.CLIENT_SUFFIX, '.apps.googleusercontent.com');
});

// ---- closed answers ----------------------------------------------------------------------
test('statusAnswer: the four states with a masked id and hasSecret, and nothing else', () => {
  const ok = { ok: true, state: 'connected', clientId: '123456…', hasSecret: true };
  assert.deepEqual(M.statusAnswer(ok), { state: 'connected', clientId: '123456…', hasSecret: true });
  assert.deepEqual(M.statusAnswer({ ok: true, state: 'no_client', clientId: null, hasSecret: false }), { state: 'no_client', clientId: null, hasSecret: false });
  for (const state of M.STATES) assert.ok(M.statusAnswer({ ok: true, state, clientId: null, hasSecret: false }), state);
  const bad = a => assert.equal(M.statusAnswer(a), null, JSON.stringify(a));
  bad(null); bad({}); bad({ ok: false, reason: 'network' }); bad({ ok: true, state: 'spam', hasSecret: false });
  bad({ ok: true, state: 'connected' }); bad({ ok: true, state: 'connected', clientId: null, hasSecret: 'yes' });
  bad({ ok: true, state: 'connected', clientId: ID, hasSecret: true }); // a whole client id never comes back
  bad({ ok: true, state: 'connected', clientId: '123456…\n', hasSecret: true });
  assert.equal(M.STATES.length, 4);
});

test('flowAnswer: waiting with or without a browser, done, none — the URL is only Google\'s', () => {
  assert.deepEqual(M.flowAnswer({ ok: true, state: 'waiting', browserOpened: true }), { state: 'waiting', browserOpened: true, authUrl: null });
  assert.deepEqual(M.flowAnswer({ ok: true, state: 'waiting' }), { state: 'waiting', browserOpened: null, authUrl: null }, 'a poll answers waiting with nothing else');
  const manual = { ok: true, state: 'waiting', browserOpened: false, authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x' };
  assert.deepEqual(M.flowAnswer(manual), { state: 'waiting', browserOpened: false, authUrl: manual.authUrl });
  assert.deepEqual(M.flowAnswer({ ok: true, state: 'done' }), { state: 'done', browserOpened: null, authUrl: null });
  assert.deepEqual(M.flowAnswer({ ok: true, state: 'none' }), { state: 'none', browserOpened: null, authUrl: null });
  const bad = a => assert.equal(M.flowAnswer(a), null, JSON.stringify(a));
  bad(null); bad({ ok: true, state: 'waiting', browserOpened: 'si' });
  bad({ ok: true, state: 'waiting', browserOpened: false, authUrl: 'https://evil.test/auth' });
  bad({ ok: true, state: 'waiting', browserOpened: false, authUrl: 'javascript:alert(1)' });
  bad({ ok: true, state: 'waiting', browserOpened: false, authUrl: 5 });
  bad({ ok: true, state: 'finished' }); bad({ ok: false, reason: 'network' });
});

// ---- the one closed verb -----------------------------------------------------------------
test('status: asks for the closed action and says each state in Spanish', async () => {
  for (const [state, label] of Object.entries(M.STATE_LABELS)) {
    const f = answers([{ ok: true, state, clientId: state === 'no_client' ? null : '123456…', hasSecret: state !== 'no_client' }]);
    const r = await M.status(f.invoke);
    assert.equal(r.ok, true, state);
    assert.equal(r.state, state);
    assert.equal(r.label, label, state);
    assert.deepEqual(f.payloads(), [{ action: 'status' }]);
  }
  assert.equal(M.STATE_LABELS.no_client, 'Sin configurar');
  assert.equal(M.STATE_LABELS.signed_out, 'Sin conectar');
  assert.equal(M.STATE_LABELS.connected, 'Conectado');
  assert.equal(M.STATE_LABELS.reconnect, 'Volvé a conectar Gmail');
  const refused = await M.status(answers([{ ok: false, reason: 'keychain' }]).invoke);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'keychain');
  assert.match(refused.message, /llavero/);
  assert.equal((await M.status(answers([{ ok: true, nope: 1 }]).invoke)).reason, 'failed');
  assert.equal((await M.status(answers([null]).invoke)).reason, 'failed');
  assert.equal((await M.status(undefined)).reason, 'failed');
});

test('saveClient: an invalid field never reaches the host; a valid one does, and the answer is the state', async () => {
  const f = answers([{ ok: true, state: 'signed_out', clientId: '123456…', hasSecret: true }]);
  const r = await M.saveClient(f.invoke, ID, SECRET);
  assert.equal(r.ok, true);
  assert.equal(r.state, 'signed_out');
  assert.deepEqual(f.payloads(), [{ action: 'set_client', clientId: ID, clientSecret: SECRET }]);
  const none = answers([{ ok: true, state: 'signed_out', clientId: '123456…', hasSecret: false }]);
  await M.saveClient(none.invoke, ID, '');
  assert.deepEqual(none.payloads(), [{ action: 'set_client', clientId: ID }], 'an empty secret is not sent');
  const refusal = answers([]);
  const invalid = await M.saveClient(refusal.invoke, 'not-a-client', '');
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, 'invalid');
  assert.match(invalid.message, /apps\.googleusercontent\.com/);
  assert.equal(refusal.calls.length, 0, 'the host is never asked with an invalid client');
});

test('begin / poll / cancel ask exactly the closed actions', async () => {
  const f = answers([
    { ok: true, state: 'waiting', browserOpened: true },
    { ok: true, state: 'waiting' },
    { ok: true, state: 'none' },
  ]);
  assert.equal((await M.begin(f.invoke)).state, 'waiting');
  assert.equal((await M.poll(f.invoke)).state, 'waiting');
  assert.equal((await M.cancel(f.invoke)).ok, true);
  assert.deepEqual(f.payloads(), [{ action: 'begin' }, { action: 'poll' }, { action: 'cancel' }]);
});

test('connect: begin, poll every second, and stop on done', async () => {
  const f = answers([
    { ok: true, state: 'waiting', browserOpened: true },
    { ok: true, state: 'waiting' },
    { ok: true, state: 'waiting' },
    { ok: true, state: 'done' },
  ]);
  const waits = [];
  const r = await M.connect(f.invoke, { wait: ms => { waits.push(ms); return Promise.resolve(); }, now: () => 0 });
  assert.equal(r.ok, true);
  assert.equal(r.state, 'done');
  assert.deepEqual(f.payloads().map(p => p.action), ['begin', 'poll', 'poll', 'poll']);
  assert.deepEqual(waits, [M.POLL_MS, M.POLL_MS, M.POLL_MS]);
  assert.equal(M.POLL_MS, 1000);
  assert.equal(M.POLL_TIMEOUT_MS, 600000);
});

test('connect: an error ends it and cancels; a cancelled flow is not a success; ten minutes is the cap', async () => {
  const failed = answers([{ ok: true, state: 'waiting', browserOpened: true }, { ok: false, reason: 'network' }]);
  const error = await M.connect(failed.invoke, { wait: () => Promise.resolve(), now: () => 0 });
  assert.equal(error.ok, false);
  assert.equal(error.reason, 'network');
  assert.equal(failed.payloads().at(-1).action, 'cancel', 'an abandoned flow is released');
  const gone = answers([{ ok: true, state: 'waiting', browserOpened: true }, { ok: true, state: 'none' }]);
  const cancelled = await M.connect(gone.invoke, { wait: () => Promise.resolve(), now: () => 0 });
  assert.equal(cancelled.reason, 'cancelled');
  assert.equal((await M.connect(answers([{ ok: false, reason: 'no_client' }]).invoke, { wait: () => Promise.resolve(), now: () => 0 })).reason, 'no_client');
  // Ten minutes of waiting, then it gives up honestly (it never polls for ever).
  let t = 0;
  const waiting = host(() => ({ ok: true, state: 'waiting', browserOpened: true }));
  let wait = () => Promise.resolve();
  const stuck = await M.connect(waiting.invoke, { wait: () => { t += M.POLL_MS; return wait(); }, now: () => t });
  assert.equal(stuck.ok, false);
  assert.equal(stuck.reason, 'timeout');
  assert.match(stuck.message, /10 minutos/);
  assert.equal(waiting.payloads().filter(p => p.action === 'poll').length, M.POLL_TIMEOUT_MS / M.POLL_MS);
  assert.equal(waiting.payloads().at(-1).action, 'cancel');
});

test('forget: forgets the credential and lands on «Sin configurar»', async () => {
  const f = answers([{ ok: true, state: 'no_client' }]);
  const r = await M.forget(f.invoke);
  assert.equal(r.ok, true);
  assert.equal(r.state, 'no_client');
  assert.equal(r.label, 'Sin configurar');
  assert.deepEqual(f.payloads(), [{ action: 'forget' }]);
  const refused = await M.forget(answers([{ ok: false, reason: 'keychain' }]).invoke);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'keychain');
});

test('every refusal has its own Spanish message; an unknown code is a plain failure', async () => {
  assert.ok(M.MESSAGES.no_client.length > 10);
  for (const code of ['denied', 'expired', 'rejected', 'scope_missing', 'network', 'port_busy', 'rate_limited', 'server', 'prefs']) {
    assert.ok(M.MESSAGES[code] && M.MESSAGES[code].length > 15, code);
  }
  const weird = await M.status(answers([{ ok: false, reason: 'weird_code_from_the_future' }]).invoke);
  assert.equal(weird.reason, 'failed');
  assert.equal(weird.message, M.MESSAGES.failed);
  assert.equal((await M.status(answers([{ ok: false, reason: 'failed' }]).invoke)).reason, 'failed');
});

// ---- S10: the help that makes the own app work -------------------------------------------
test('S10: the help guides to publish the app, explains the unverified warning and says it is free', () => {
  const help = M.HELP_STEPS.join('\n');
  assert.match(help, /Publicar app/i, 'it must say «Publicar app»');
  assert.match(help, /no verificó esta app/);
  assert.match(help, /Configuración avanzada/);
  assert.match(help, /no seguro/);
  assert.match(help, /gratis/);
  assert.match(help, /App de escritorio/);
  assert.match(help, /gmail\.readonly/);
  assert.match(help, /Gmail API/);
  assert.match(help, /Externo/);
  assert.match(help, /no vence/, 'publishing is what keeps the connection alive');
  assert.match(M.HELP_TITLE, /gratis/i);
  assert.match(M.HELP_FOOT, /llavero/);
  assert.ok(M.HELP_STEPS.length >= 6 && M.HELP_STEPS.every(s => s.length > 20 && !/[\u0000-\u001f]/.test(s)), 'plain, complete sentences');
});

// ---- S8: what this card no longer offers --------------------------------------------------
test('S8: IMAP, SMTP and Resend are gone, and so are composing and «marcar como leído» (S5)', () => {
  for (const gone of [/\bIMAP\b/i, /\bSMTP\b/i, /\bResend\b/i, /['"`]mail_action['"`]/, /mark_read|['"`]markread['"`]|el\('button'[^)]*Marcar como leído/, /integrations-email/, /adjunt/i]) {
    assert.doesNotMatch(code, gone, String(gone));
  }
  assert.doesNotMatch(code, /<form[^>]*ml-compose|compose/i, 'no compose form: the island mail is read-only');
});

// ---- source hygiene ----------------------------------------------------------------------
test('source: textContent only, only gmail_action, no browser storage, mount inert, trusted gestures', () => {
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  assert.doesNotMatch(src, /window\.open|fetch\(|XMLHttpRequest|WebSocket|localStorage|sessionStorage/);
  assert.match(src, /gmail_action/);
  assert.doesNotMatch(src, /['"`]mail_action['"`]|integration_action/);
  assert.match(src, /getElementById\('integrations-mail'\)/);
  assert.match(src, /if \(!host\) return/);
  assert.match(src, /isTrusted !== true/, 'synthetic events never act');
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, ''), /['"`]#[0-9a-fA-F]{3,8}['"`]|rgba?\(/);
  assert.doesNotMatch(src, /Datos de ejemplo|fakeFrame/i, 'this card is live: no invented mail');
  assert.match(src, /type = 'password'/, 'the secret is typed masked');
  assert.match(src, /idInput\.value = /, 'the fields are drawn from the model, never from a stored secret');
  assert.match(src, /draft: \{ id: '', secret: '' \}/, 'the typed client and secret are dropped once they are saved');
  assert.match(src, /addEventListener\('input'/, 'a repaint never loses what is being typed');
});

// ---- renderer (DOM only) -----------------------------------------------------------------
test('render: state line, the two fields, save/connect/disconnect and the help block', () => {
  if (typeof document === 'undefined') return;
  const hostNode = document.createElement('section');
  M.render(hostNode, { state: 'no_client', clientId: null, hasSecret: false });
  assert.equal(hostNode.hidden, false);
  assert.match(hostNode.querySelector('.ml-unread').textContent, /Sin configurar/);
  assert.equal(hostNode.querySelector('input[name="clientId"]').value, '');
  assert.equal(hostNode.querySelector('input[name="clientSecret"]').value, '');
  M.render(hostNode, { state: 'no_client', draft: { id: 'abc', secret: 'GOCSPX-x' } });
  assert.equal(hostNode.querySelector('input[name="clientId"]').value, 'abc');
  assert.equal(hostNode.querySelector('input[name="clientSecret"]').value, 'GOCSPX-x', 'while typing, the field keeps what was typed');
  M.render(hostNode, { state: 'signed_out', clientId: '123456…', hasSecret: true, draft: { id: '', secret: '' } });
  assert.equal(hostNode.querySelector('input[name="clientSecret"]').value, '', 'after saving, the secret is gone from the DOM');
  assert.equal(hostNode.querySelector('input[name="clientSecret"]').type, 'password');
  assert.ok(hostNode.querySelector('button[data-action="save"]'));
  const connect = hostNode.querySelector('button[data-action="connect"]');
  assert.ok(connect && connect.disabled, 'without a saved client there is nothing to connect');
  assert.equal(hostNode.querySelector('button[data-action="forget"]'), null);
  assert.ok(hostNode.querySelector('details.mail-help'), 'the S10 help is there');
  assert.ok(hostNode.querySelectorAll('details.mail-help li').length >= 6);

  M.render(hostNode, { state: 'connected', clientId: '123456…', hasSecret: true });
  assert.match(hostNode.querySelector('.ml-unread').textContent, /^Conectado$/);
  assert.ok(hostNode.querySelector('button[data-action="connect"]:not([disabled])'));
  assert.ok(hostNode.querySelector('button[data-action="forget"]'));
  const text = hostNode.textContent;
  assert.match(text, /123456…/);
  assert.doesNotMatch(text, new RegExp(ID.slice(6)), 'only the masked prefix is drawn');
  assert.doesNotMatch(text, /GOCSPX/, 'a secret is never drawn');

  M.render(hostNode, { state: 'signed_out', connecting: true, clientId: '123456…', hasSecret: false });
  assert.ok(hostNode.querySelector('button[data-action="cancel"]'), 'while waiting there is a «Cancelar»');
  assert.equal(hostNode.querySelector('button[data-action="connect"]'), null);
  assert.equal(hostNode.querySelector('button[data-action="forget"]'), null);

  M.render(hostNode, { state: 'reconnect', clientId: '123456…', hasSecret: false, note: { ok: false, text: 'Google rechazó la conexión.' } });
  assert.match(hostNode.querySelector('.ml-unread').textContent, /Volvé a conectar Gmail/);
  assert.equal(hostNode.querySelector('[role="status"]').textContent, 'Google rechazó la conexión.');

  M.render(hostNode, { state: 'signed_out', clientId: '123456…', hasSecret: false, authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x' });
  assert.match(hostNode.querySelector('[data-field="authUrl"]').textContent, /^https:\/\/accounts\.google\.com\//);
});

// ---- T6 (S3): the card left the sample-data group ----------------------------------------
// It used to sit under «Servicios · Datos de ejemplo» while being the one LIVE card of Ajustes. It now has its own heading and its
// own section, still inside #connections-more (the wrapper settings.js re-appends on the Conexiones tab).
test('T6 S3: #integrations-mail has its own section and heading, out of «Servicios · Datos de ejemplo»', () => {
  const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  assert.equal((html.match(/src="integrations-mail\.js"/g) || []).length, 1, 'loaded once');
  assert.equal((html.match(/id="integrations-mail"/g) || []).length, 1, 'one container: the mount contract is unchanged');
  assert.equal((html.match(/integrations-email/g) || []).length, 0, 'the fake «Correo» card, its script and its section are gone');
  assert.equal(fs.existsSync(path.join(frontend, 'integrations-email.js')), false, 'and its file with them');
  assert.equal(fs.existsSync(path.join(__dirname, 'integrations-email-check.cjs')), false, 'nor its check');
  const group = /<div id="connections-more"[^>]*>([\s\S]*?)<!-- \/connections-more -->/.exec(html);
  assert.ok(group, 'the wrapper the settings render re-appends is still there');
  const body = group[1];
  const at = body.indexOf('<section id="integrations-mail" hidden></section>');
  const sample = body.indexOf('Servicios · Datos de ejemplo');
  assert.ok(at > 0, 'the live card travels with the wrapper');
  assert.ok(sample > 0 && at < sample, 'it comes BEFORE the sample-data group, so it is not read as an example');
  assert.match(body.slice(0, at), /<h3 class="ssection">Correo · Gmail<\/h3>/, 'its own heading precedes it');
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); passed += 1; } catch (e) { console.error(`FAIL: ${name}`); throw e; }
  }
  console.log(`integrations-mail-check: ${passed} checks ok`);
})();
