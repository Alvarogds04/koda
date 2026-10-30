'use strict';
// HU-042 (S7-S9, S16): Pi's own yes/no confirmations (ctx.ui.confirm, e.g. gentle-pi's «Allow guarded forced git branch
// deletion?») are answerable from Abito OR the terminal; the first answer wins and the other side is withdrawn.
// Human decision (verbatim option chosen): «Cualquier confirmación sí/no que no sea sensible». Sensitive ones never
// leave the terminal. Everything here runs against a fake ui/controller.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installConfirmRouter, isSensitiveConfirm } = require('../native-ask.cjs');

const TITLE = 'Allow guarded forced git branch deletion?';
const PREVIEW = 'git branch -D feature/old-spike';

function rig({ available = true, hasUI = true } = {}) {
  const abito = { asks: [], signals: [], resolvers: [] };
  const controller = {
    canAsk: () => available,
    structured: () => false,
    ask: (request, ctx, signal) => new Promise(resolve => {
      abito.asks.push(request); abito.signals.push(signal); abito.resolvers.push(resolve);
      signal.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true });
    }),
  };
  const term = { calls: [], resolvers: [], notes: [] };
  const original = function confirm(title, message, opts) {
    term.calls.push({ title, message, opts });
    return new Promise(resolve => {
      term.resolvers.push(resolve);
      opts?.signal?.addEventListener('abort', () => resolve(false), { once: true }); // Pi: abort ⇒ undefined ⇒ false
    });
  };
  const ui = { confirm: original, notify: (m, t) => term.notes.push([m, t]) };
  const ctx = { hasUI, ui, cwd: '/tmp/x', sessionManager: { getSessionId: () => 's' } };
  return { abito, controller, term, ui, ctx, original };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const install = (r, env = {}) => installConfirmRouter({ ctx: r.ctx, controller: r.controller, env });

test('island «Sí» first: confirm resolves true, the terminal dialog is withdrawn', async () => {
  const r = rig(); install(r);
  const run = r.ui.confirm(TITLE, PREVIEW); await tick();
  const sent = r.abito.asks[0];
  assert.equal(sent.kind, 'approval'); assert.equal(sent.allowFreeText, false);
  assert.deepEqual(sent.options.map(o => [o.value, o.label]), [['yes', 'Sí'], ['no', 'No']]);
  assert.equal(sent.text, `${TITLE}\n${PREVIEW}`, 'title + preview VERBATIM: the human sees exactly what they approve');
  assert.equal(r.term.calls.length, 1, 'the terminal always asks too');
  r.abito.resolvers[0]({ status: 'answered', answer: { type: 'option', value: 'yes' } });
  assert.equal(await run, true);
  assert.equal(r.term.calls[0].opts.signal.aborted, true, 'terminal withdrawn');
  assert.match(r.term.notes.at(-1)[0], /Koda.*Sí/);
});

test('island «No» first: confirm resolves false, terminal withdrawn', async () => {
  const r = rig(); install(r);
  const run = r.ui.confirm(TITLE, PREVIEW); await tick();
  r.abito.resolvers[0]({ status: 'answered', answer: { type: 'option', value: 'no' } });
  assert.equal(await run, false);
  assert.equal(r.term.calls[0].opts.signal.aborted, true);
});

test('island human cancel is a «no», never approval', async () => {
  const r = rig(); install(r);
  const run = r.ui.confirm(TITLE, PREVIEW); await tick();
  r.abito.resolvers[0]({ status: 'human_cancelled' });
  assert.equal(await run, false);
});

test('terminal answers first: its value wins, the island question is withdrawn, a late island «Sí» changes nothing', async () => {
  for (const answer of [true, false]) {
    const r = rig(); install(r);
    const run = r.ui.confirm(TITLE, PREVIEW); await tick();
    r.term.resolvers[0](answer);
    assert.equal(await run, answer);
    assert.equal(r.abito.signals[0].aborted, true, 'question_cancel: the broker is aborted');
    r.abito.resolvers[0]({ status: 'answered', answer: { type: 'option', value: 'yes' } }); await tick();
  }
});

test('island expired / busy / disconnected / unavailable / error / odd answer: no decision, the terminal keeps waiting and decides', async () => {
  for (const outcome of [{ status: 'expired' }, { status: 'busy' }, { status: 'disconnected' }, { status: 'unavailable' },
    { status: 'protocol_error' }, { status: 'answered', answer: { type: 'option', value: 'maybe' } },
    { status: 'answered', answer: { type: 'text', text: 'yes' } }, { status: 'answered', answer: null }, null, 'reject']) {
    const r = rig(); install(r);
    let settled = false; const run = r.ui.confirm(TITLE, PREVIEW).then(v => { settled = true; return v; }); await tick();
    if (outcome === 'reject') r.abito.resolvers[0](Promise.reject(new Error('x'))); else r.abito.resolvers[0](outcome);
    await tick(); await tick();
    assert.equal(settled, false, `${JSON.stringify(outcome)} must not decide`);
    assert.equal(r.term.calls[0].opts.signal.aborted, false, 'the terminal is still asking');
    r.term.resolvers[0](false);
    assert.equal(await run, false, 'never approval');
  }
});

test('the caller\'s own signal aborting withdraws both sides and resolves false', async () => {
  const r = rig(); install(r);
  const outer = new AbortController();
  const run = r.ui.confirm(TITLE, PREVIEW, { signal: outer.signal, timeout: 5000 }); await tick();
  assert.equal(r.term.calls[0].opts.timeout, 5000, 'the caller\'s timeout still applies to the terminal');
  outer.abort();
  assert.equal(await run, false);
  assert.equal(r.abito.signals[0].aborted, true); assert.equal(r.term.calls[0].opts.signal.aborted, true);
});

test('a non-git, non-sensitive confirm is routed too (no allowlist)', async () => {
  const r = rig(); install(r);
  const run = r.ui.confirm('Restore saved model routing?', 'Replace /work/.pi/models.json with /work/.pi/models.export.json'); await tick();
  assert.equal(r.abito.asks.length, 1);
  r.abito.resolvers[0]({ status: 'answered', answer: { type: 'option', value: 'yes' } });
  assert.equal(await run, true);
});

// One test per denylist class: the confirm is never sent to the island, the original confirm runs UNCHANGED.
const DENIED = {
  credential: ['Store credential?', 'Save the credential for later'],
  'token value': ['Paste your token', 'git push origin main'],
  'key value': ['Enter the SSH key', 'ssh-add'],
  'api key value': ['Enter this API key', 'OPENAI api-key from env'],
  password: ['Reset password?', 'passwd alvaro'],
  secret: ['Delete secret?', 'gh secret delete PROD'],
  login: ['Log in again?', 'pi login anthropic'],
  oauth: ['Start OAuth flow?', 'open https://example.com/authorize'],
  auth: ['Re-auth the provider?', 'gh auth refresh'],
  consent: ['Give consent?', 'The provider asks for consent'],
  consentimiento: ['¿Das tu consentimiento?', 'Pedido del proveedor'],
  'provider consent': ['Provider consent required', 'gentle-ai provider consent'],
  'RDD': ['Start the native check (RDD)?', 'run it now'],
  'review/RDD consent': ['Start native review (RDD)?', 'gentle-ai review start'],
  'maintenance authorization': ['Authorize maintenance?', 'gentle-ai review reclaim'],
  'opaque token': ['Approve this request?', 'binding 3f9a2c81e4b7d6a5f0c1e2d3b4a59687'],
  'userinfo URL': ['Allow guarded git push?', 'git push https://alvaro:ghp@github.com/o/r.git main'],
  'Spanish key/password': ['¿Guardar la clave?', 'contraseña del servidor'],
};
for (const [cls, [title, message]] of Object.entries(DENIED)) {
  test(`sensitive (${cls}): never routed; the original terminal confirm runs unchanged`, async () => {
    assert.equal(isSensitiveConfirm(title, message), true, cls);
    const r = rig(); install(r);
    const opts = { timeout: 1234 };
    const run = r.ui.confirm(title, message, opts); await tick();
    assert.equal(r.abito.asks.length, 0, `${cls}: nothing crosses to Abito`);
    assert.equal(r.term.calls.length, 1); assert.equal(r.term.calls[0].opts, opts, 'the original call is untouched');
    r.term.resolvers[0](true); assert.equal(await run, true, 'the terminal still decides as today');
  });
}

test('cannot be bounded or decoded cleanly → terminal only', async () => {
  const cases = [[42, PREVIEW], [TITLE, { cmd: 'x' }], [TITLE, 'line\u0007bell'], ['', PREVIEW], ['x'.repeat(201), PREVIEW],
    [TITLE, 'x'.repeat(1201)], [TITLE, Array.from({ length: 13 }, (_, i) => `line ${i}`).join('\n')], [`${TITLE}\nsecond line`, PREVIEW]];
  for (const [title, message] of cases) {
    const r = rig(); install(r);
    r.ui.confirm(title, message); await tick();
    assert.equal(r.abito.asks.length, 0, JSON.stringify([title, message]).slice(0, 80));
    assert.equal(r.term.calls.length, 1);
  }
});

// Independent security verification (mvqtg5jk-9-9dt9) found these disguised sensitive prompts reaching the island.
// Every one must stay terminal-only: the check normalises (NFKD, marks stripped, separators and leetspeak folded) and
// refuses text it cannot show honestly (invisible/format characters, combining marks, C1 controls, non-Latin letters).
const DISGUISED = [
  ['homoglyph (Cyrillic о)', 'Allow t\u043eken refresh?'], ['fullwidth', 'Allow \uff54\uff4f\uff4b\uff45\uff4e refresh?'],
  ['soft hyphen', 'Allow to\u00adken refresh?'], ['combining grapheme joiner', 'Allow to\u034fken refresh?'],
  ['variation selector', 'Delete\ufe0fbranch'], ['interlinear annotation', 'Delete\ufff9branch'],
  ['decomposed ñ', 'Ingresa la contrase\u0303a'], ['leetspeak', 'Paste t0ken now'], ['symbol leet', 'Enter p@$$word'],
  ['split by space', 'Set pass word now?'], ['split by tab', 'Set pass\tword now?'], ['split by dot', 'Set pass.word now?'],
  ['split credential', 'Enter cre dential'], ['NBSP sign in', 'Sign\u00a0in now?'], ['NBSP log in', 'log\u00a0in again'],
  ['underscore log in', 'log_in now?'], ['underscore sign in', 'sign_in now?'], ['Spanish llave', '¿Pegás la llave privada?'], ['Spanish llave (voseo)', 'Escribís la llave'],
  ['passcode', 'Enter one time passcode?'],
  ['passkey', 'Register a passkey?'], ['NEL', 'Proceed?\u0085next'], ['line separator', 'Proceed?\u2028next'],
  ['short mixed opaque', 'Approve Xk9Qp2mLa7Rb3Tc8Vd1?'], ['dash-split opaque', 'Use AbCd1234EfGh-5678IjKlMnOp?'],
  ['slash-split opaque', 'Use QUJDREVGRzEy/MzQ1Njc4OTAxMj/Z?'], ['letters-only opaque', 'Use abcdefghijklmnopqrstuvwxyzABCD?'],
  ['sk_ underscore', 'Use sk_live_ab12?'], ['userinfo slash in password', 'git push https://alvaro:gh/px@host/r'],
  ['scheme-less userinfo', 'git push alvaro:x@host:r'], ['protocol-relative userinfo', 'fetch //alvaro:x@host/r'],
  ['spaced userinfo', 'git push https://alvaro :x@host/r'],
  // recheck mvqtr7qv-a-z76n — blockers
  ['digit 9 for g', 'Allow lo9in?'], ['digit 8 for b', 'Allow 8inding?'], ['plus for t', 'Paste +oken'], ['paren for c', 'Allow (redential?'], ['angle for c', 'Allow <redential?'],
  ['Inicia sesion', 'Inicia sesion?'], ['Inicia sesión', 'Inicia sesión?'], ['Logging in', 'Logging in again?'],
  ['creds', 'store creds now'], ['pwd', 'enter pwd here'], ['privatekey', 'Paste privatekey'], ['keystore', 'Paste keystore'],
  ['keyfile', 'Paste keyfile'], ['keygen', 'Enter keygen'],
  // recheck mvqtr7qv-a-z76n — advisory, closed too (fail closed)
  ['percent-encoded userinfo', 'Run //alvaro%3Ax%40host'], ['percent-encoded at', 'Run //alvaro%40host'],
  ['15 mixed opaque', 'id Xk9Qp2mLa7Rb3Tc'], ['dash-split short opaque', 'id Xk9-Qp2-mLa7-Rb3'], ['space-split opaque', 'id Xk9Qp2mLa7Rb3 Tc8Vd1'],
  ['letters-only split opaque', 'id abcdefghijklmnopqrstuvw-xyz'], ['Logged in', 'Logged in?'], ['PIN', 'Enter PIN?'], ['Abrir sesión', '¿Abrir sesión?'],
  // final recheck mvqtxdhe-b-l605 — blockers (ASCII-art letters, symbols the compact step dropped)
  ['|< for k in token', 'Paste to|<en'], ['|< for k in key', 'Enter |<3y'], ['|< for k in keychain', 'Open |<3ychain?'],
  ['# in oauth', 'Allow 0a#th?'], ['|> for p', 'Set |>assword?'], ['|* for p', 'Set |*assword?'], ['|2 for r in secret', 'Show secre|2?'],
  ['|v| for m', 'Run |v|aintenance?'], ['|\\| for n in login', 'Allow logi|\\|?'], ['|\\| for n in consent', 'Allow co|\\|sent?'],
  [') for d', 'Show cr3)3nt1al?'],
  // final recheck — advisory, closed (encoded text is decoded before the checks)
  ['percent-encoded o', 'Allow %6Fauth?'], ['percent-encoded p', 'Set %70assword?'], ['double percent-encoded at', 'Run //alvaro%2540host'],
  ['HTML entity userinfo', 'Run //alvaro&#58;x&#64;host'], ['escaped at (literal backslash-u text)', 'Run //alvaro\\u0040host'],
];
for (const [cls, text] of DISGUISED) {
  test(`disguised sensitive (${cls}): never routed`, async () => {
    for (const [title, message] of [[text, 'details'], ['Proceed?', text]]) {
      const r = rig(); install(r);
      r.ui.confirm(title, message); await tick();
      assert.equal(r.abito.asks.length, 0, `${cls}: ${JSON.stringify([title, message])}`);
      assert.equal(r.term.calls.length, 1, 'the terminal still asks');
    }
  });
}

test('ordinary confirms still reach Abito after normalisation (git, paths, Spanish, gentle-pi «…» previews)', async () => {
  for (const [title, message] of [
    ['Allow guarded forced git branch deletion?', '…git branch -D feature/old-spike'],
    ['Allow guarded git push?', 'git push origin main'], ['Allow guarded git rebase?', 'git rebase -i HEAD~3'],
    ['¿Borrar la rama?', 'git branch -D señal-cañón'], ['Restore saved model routing?', 'Replace /work/.pi/models.json'],
    ['Allow guarded git reset?', 'git reset --hard a1b2c3d'], ['Allow guarded npm publish?', 'npm publish --tag next'],
    ['¿Inicia el servidor?', 'npm run dev -- --port 5173'], ['Allow guarded pi remove?', 'pi remove @scope/ext-2'],
    // the final recheck's «not a false positive» cases, and commands with the symbols the new rules look at
    ['Open the file?', 'cat overview.md interview-notes.md keyboard.json'], ['Allow guarded git push?', 'git commit -m "fix #12" && git push'],
    ['Run the build?', 'npm run build && (cd dist; ls)'], ['Allow guarded git rebase?', 'git log --format="%h %s" | head -5'],
    ['Replace the file?', 'cp ./src/views/list.ts ./src/views/list.bak.ts'],
  ]) {
    const r = rig(); install(r);
    r.ui.confirm(title, message); await tick();
    assert.equal(r.abito.asks.length, 1, JSON.stringify([title, message]));
  }
});

test('no UI, Abito unavailable or opted out → the original confirm, nothing sent', async () => {
  for (const [opt, env] of [[{ hasUI: false }, {}], [{ available: false }, {}], [{}, { ABITO_NATIVE_CONFIRM: '0' }]]) {
    const r = rig(opt); install(r, env);
    r.ui.confirm(TITLE, PREVIEW); await tick();
    assert.equal(r.abito.asks.length, 0, JSON.stringify([opt, env]));
    assert.equal(r.term.calls.length, 1);
  }
});

test('only confirm is wrapped: select, input and editor are untouched', () => {
  const r = rig(); const select = () => {}, input = () => {}, editor = () => {};
  Object.assign(r.ui, { select, input, editor });
  install(r);
  assert.equal(r.ui.select, select); assert.equal(r.ui.input, input); assert.equal(r.ui.editor, editor);
});

test('installs once per ui object, keeps the original, and restores it on uninstall', () => {
  const r = rig();
  const off = install(r); const wrapped = r.ui.confirm;
  assert.notEqual(wrapped, r.original);
  const again = install(r);
  assert.equal(r.ui.confirm, wrapped, 'a second install does not wrap twice');
  again(); assert.equal(r.ui.confirm, wrapped, 'the no-op handle does not unwrap');
  off(); assert.equal(r.ui.confirm, r.original, 'the original confirm is back');
  off(); assert.equal(r.ui.confirm, r.original, 'idempotent');
});

test('the wrapper never throws: a broken controller falls back to the terminal answer', async () => {
  const r = rig(); r.controller.ask = () => { throw new Error('boom'); }; install(r);
  const run = r.ui.confirm(TITLE, PREVIEW); await tick();
  r.term.resolvers[0](true);
  assert.equal(await run, true);
});

// HU-052: ONE rule for confirm and ask. TOPIC words route; secret VALUE words and consents stay terminal-only (input for input).
test('confirm: topic words are routed, value prompts and consents stay terminal-only (pinned inputs)', () => {
  const pinned = [
    // routed: the topic is a permission / provider / token, nobody is asked to type a secret
    ['¿Qué permisos damos?', '', false], ['¿Permitir que X borre la rama?', '', false], ['Elegir proveedor', '', false],
    ['¿Rotamos el token de la API?', '', false], ['¿Autorizas el despliegue?', '', false], ['Grant access?', '', false],
    ['Review the diff?', '', false], ['Rechazar cambios', '', false], ['Which branch?', '', false], ['Delete the build folder?', 'rm -rf build', false],
    ['Rotate the key', '', false],
    // terminal-only: secrets, value-asking, consents, gentle-ai authorizations, opaque ids, look-alikes
    ['Pega tu contraseña', '', true], ['Enter your API key', '', true], ['Pega tu token de la API', '', true], ['Do you consent?', '', true],
    ['¿Das tu consentimiento?', '', true], ['Start native review (RDD)?', 'gentle-ai review start', true], ['Authorize maintenance?', 'gentle-ai review reclaim', true],
    ['Allow?', 'binding 3f9a2c81e4b7d6a5f0c1e2d3b4a59687', true], ['Pеga', '', true],
  ];
  for (const [t, m, expected] of pinned) assert.equal(isSensitiveConfirm(t, m), expected, t);
});

// HU-052 independent security review (mvr5ku6s-k-kfdp): reproduced bypasses, now closed; each is checked for confirm AND for the ask tools.
test('HU-052 review: split words, other languages, codes, obfuscated gentle-ai/RDD and look-alike ids stay terminal-only', () => {
  const { isSensitive } = require('../native-ask.cjs');
  const denied = [
    ['Enter your pass', 'word:'], ['Gentle', 'AI review?'],                                   // a word split across title and message
    ['Ingresa el código de verificación', ''], ['Código de verificación:', ''], ['Passwort:', ''], ['Mot de passe ?', ''], ['Senha:', ''],
    ['Approve ReviewRDD gate?', ''], ['R.D.D. review', ''], ['gentIe-ai review', ''],       // RDD / gentle-ai, separators and I-for-l
    ['Input your token', ''], ['Put your token here', ''], ['Pon tu clave', ''], ['Digita tu clave', ''], ['API key =', ''], ['The token is', ''], ['Token:', ''],
    ['Approve x7kq9plm2zt4?', ''], ['Use a1b2-c3d4-e5f6-a7b8-c9d0-e1f2?', ''],               // opaque ids outside the first shapes
  ];
  for (const [t, m] of denied) assert.equal(isSensitiveConfirm(t, m), true, JSON.stringify([t, m]));
  assert.equal(isSensitive('Pega tu t0ken'), true);
});

test('HU-052 review: consent markers are found whatever the separators and case (choice, option value, extra field)', async () => {
  const { createNativeAskHandler } = require('../native-ask.cjs');
  assert.equal(typeof createNativeAskHandler, 'function');
  const marker = /consentbinding|gentleaireviewintegration/;
  const folded = v => JSON.stringify(v).toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const v of [{ 'consent-binding': 'x' }, { Consent_Binding: 'x' }, { a: 'gentle-ai.review_integration' }, { a: 'Gentle-AI.Review-Integration' }]) assert.ok(marker.test(folded(v)), JSON.stringify(v));
});

// Accepted by the human's decision (HU-052): a yes/no that only MENTIONS a key or token as a topic is routed; no value can travel in a yes/no.
test('HU-052 decision: a topic mention of a token or key in a yes/no is routed (no value asked)', () => {
  for (const t of ['¿Rotamos el token de la API?', 'Use API key?', 'Clave?', 'Use the token?']) assert.equal(isSensitiveConfirm(t, ''), false, t);
});
