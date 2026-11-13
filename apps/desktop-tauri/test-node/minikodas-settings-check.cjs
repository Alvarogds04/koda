'use strict';
/* K2-13 T6b-3 (S7, S10, S16, S18, S20): Ajustes → Minikodas, the PURE half (frontend/minikodas-settings.js).
   What this check can see without a browser: the closed wire payloads the card can build (never a field the host or the
   daemon would refuse, never a secret that came back from anywhere), the sentences of every closed Telegram code, the step
   the card draws (derived from the daemon's state and nothing else), and the transcription setting (Parakeet only as the
   local mode — S18 — and a remote that needs a configured OpenAI-compatible account).
   Run: node test-node/minikodas-settings-check.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../frontend/minikodas-settings.js');

const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, 'frontend', f), 'utf8');
let passed = 0;
const test = (_name, fn) => { fn(); passed += 1; };

const HASH = '8f3c1d9ae2b74c05d61fa8b3c0e7d294';

// ---- Telegram fields: the host's and the daemon's rules ------------------------------------------------
test('api_id: digits only, inside the daemon bounds', () => {
  assert.equal(M.apiIdProblem('20405128'), '');
  for (const bad of ['', ' ', 'abc', '20 405', '0', '-1', '2147483648', '99999999999', '20.4']) {
    assert.notEqual(M.apiIdProblem(bad), '', `api_id ${JSON.stringify(bad)} must be refused in the page`);
  }
});

test('api_hash: exactly 32 lowercase hex', () => {
  assert.equal(M.apiHashProblem(HASH), '');
  for (const bad of ['', HASH.slice(0, 31), `${HASH}0`, HASH.toUpperCase(), 'z'.repeat(32), HASH.replace('8', 'G')]) {
    assert.notEqual(M.apiHashProblem(bad), '', `api_hash ${JSON.stringify(bad)} must be refused in the page`);
  }
  // a value pasted with spaces around it is trimmed (and the trimmed value is what travels)
  assert.equal(M.apiHashProblem(` ${HASH} `), '');
  assert.equal(M.loginStartPayload(' 20405128 ', ` ${HASH} `, '+5491155554321').apiHash, HASH);
});

test('phone: E.164, spaces and dashes tolerated but never sent', () => {
  assert.equal(M.phoneProblem('+5491155554321'), '');
  assert.equal(M.phoneProblem('+54 9 11 5555-4321'), '', 'a number typed with spaces and dashes is accepted');
  for (const bad of ['', '5491155554321', '+0123456789', '+123456', '+54911555543211234']) {
    assert.notEqual(M.phoneProblem(bad), '', `phone ${JSON.stringify(bad)} must be refused`);
  }
  const payload = M.loginStartPayload('20405128', HASH, '+54 9 11 5555-4321');
  assert.equal(payload.phone, '+5491155554321', 'the phone travels normalised');
});

test('code and 2FA password: bounded, non-empty, control-free', () => {
  assert.equal(M.codeProblem('48121'), '');
  for (const bad of ['', '1'.repeat(33), 'a\u0007b']) assert.notEqual(M.codeProblem(bad), '', `code ${JSON.stringify(bad)}`);
  assert.equal(M.passwordProblem('una frase larga'), '');
  for (const bad of ['', 'x'.repeat(1025), 'a\u0000b']) assert.notEqual(M.passwordProblem(bad), '', 'password refused');
});

// ---- the wire payloads: exactly the closed verbs the host allows ----------------------------------------
test('login_start carries the api pair and the phone, and nothing else', () => {
  assert.deepEqual(M.loginStartPayload('20405128', HASH, '+5491155554321'), {
    action: 'telegram_login_start', apiId: 20405128, apiHash: HASH, phone: '+5491155554321',
  });
  assert.equal(M.loginStartPayload('20405128', HASH, 'nope'), null, 'a refused field refuses the whole payload');
  assert.equal(M.loginStartPayload('x', HASH, '+5491155554321'), null);
});

test('the code and the password payloads are one field each', () => {
  assert.deepEqual(M.codePayload('48121'), { action: 'telegram_login_code', code: '48121' });
  assert.equal(M.codePayload(''), null);
  assert.deepEqual(M.passwordPayload('secreta'), { action: 'telegram_login_password', password: 'secreta' });
  assert.equal(M.passwordPayload(''), null);
});

// ---- the closed codes: one sentence of ours each ---------------------------------------------------------
test('every closed Telegram code has its own sentence, and none of them is the daemon text', () => {
  const codes = ['telegram_unavailable', 'telegram_already_connected', 'telegram_not_awaiting_code', 'telegram_not_awaiting_password',
    'telegram_credentials_invalid', 'telegram_code_invalid', 'telegram_password_invalid', 'telegram_password_required',
    'telegram_session_invalid', 'telegram_cancelled', 'telegram_login_other_connection', 'telegram_failed',
    'telegram_forget_failed',
    'paused', 'unavailable', 'bad_request', 'failed'];
  const said = new Set();
  for (const code of codes) {
    const sentence = M.errorSentence(code, null);
    assert.ok(typeof sentence === 'string' && sentence.length > 10, `${code} must say something`);
    assert.ok(!sentence.includes(code), `${code}: the code is never shown to a person (${sentence})`);
    said.add(sentence);
  }
  assert.equal(said.size, codes.length, 'every code says something different');
  // FLOOD_WAIT: the minutes the daemon reported, and never an invented number
  assert.match(M.errorSentence('telegram_flood_wait', { retryAfterMinutes: 3 }), /esperar 3 minutos/);
  assert.match(M.errorSentence('telegram_flood_wait', { retryAfterMinutes: 1 }), /esperar 1 minuto\b/);
  assert.match(M.errorSentence('telegram_flood_wait', null), /esperar un rato/);
  assert.equal(M.errorSentence('telegram_flood_wait', { retryAfterMinutes: 0 }), M.errorSentence('telegram_flood_wait', null));
  // an unknown code is never echoed
  assert.equal(M.errorSentence('telegram_made_up', null), M.SENTENCES.failed);
  assert.equal(M.errorSentence(null, null), M.SENTENCES.failed);
});

// F8/N4: a logout the daemon accepted but whose keychain delete failed is NOT «sigue conectada»: under the new order the
// account was disconnected FIRST (the daemon was told), and only the saved data could not be removed from the keychain.
test('the logout sentence says the account WAS disconnected and only the keychain delete failed', () => {
  const say = M.errorSentence('telegram_forget_failed', null);
  assert.match(say, /desconectad/, `the account is disconnected under the new order: ${say}`);
  assert.doesNotMatch(say, /sigue conectada|todav[ií]a conectada|no se desconect/, `it must not claim the account is still connected: ${say}`);
  assert.match(say, /llavero/, 'it says what could not be removed');
  assert.match(say, /a mano/, 'and that the leftover can be removed by hand');
  assert.ok(!/[0-9a-f]{32}|AQAA/.test(say), `never a secret: ${say}`);
});

// ---- the card's state ------------------------------------------------------------------------------------
test('the step comes from the daemon state, never from the click', () => {
  const states = [
    [{ state: 'disconnected' }, 'phone'],
    [{ state: 'awaiting_code' }, 'code'],
    [{ state: 'awaiting_password' }, 'password'],
    [{ state: 'connected' }, null],
    [null, 'phone'],
    [{ state: 'invented' }, 'phone'],
  ];
  for (const [view, step] of states) {
    const v = M.telegramView(view, false);
    assert.equal(v.step, step, `${JSON.stringify(view)} -> ${step}`);
    assert.equal(v.connected, view ? view.state === 'connected' : false);
  }
});

test('the account line is the daemon name and username: no phone, no bare username', () => {
  assert.equal(M.accountLine({ name: 'Álvaro', username: 'alvaro' }), 'Álvaro · @alvaro');
  assert.equal(M.accountLine({ name: 'Álvaro', username: null }), 'Álvaro');
  assert.equal(M.accountLine(null), '');
  const view = M.telegramView({ state: 'connected', account: { name: 'Álvaro', username: 'alvaro' } }, true);
  assert.equal(view.credentials, true);
  // the phone is not part of the contract: a frame that smuggled one cannot reach the card
  const smuggled = M.telegramView({ state: 'connected', account: { name: 'A', username: null }, phone: '+5491155554321' }, true);
  assert.equal(JSON.stringify(smuggled).includes('+54911'), false);
});

test('the notice the daemon attaches is bounded and control-free, or it is dropped', () => {
  assert.equal(M.telegramView({ state: 'awaiting_code', notice: 'Telegram pidió esperar 3 minutos.', retryAfterMinutes: 3 }, false).notice, 'Telegram pidió esperar 3 minutos.');
  assert.equal(M.telegramView({ state: 'awaiting_code', notice: 'x'.repeat(301) }, false).notice, '');
  assert.equal(M.telegramView({ state: 'awaiting_code', notice: 'ma\u0007l' }, false).notice, '');
  assert.equal(M.telegramView({ state: 'awaiting_code', retryAfterMinutes: 5000 }, false).minutes, 0);
});

// ---- the keychain is claimed only when the host says it holds the session (F3) ------------------------------
test('the keychain is claimed only when the host answered that the session was really stored', () => {
  const stored = M.connectedSentence(true);
  const notStored = M.connectedSentence(false);
  assert.match(stored, /quedó en el llavero/, `the stored sentence says it: ${stored}`);
  assert.match(notStored, /no se pudo guardar la sesión en el llavero/, `the honest sentence: ${notStored}`);
  assert.match(notStored, /al reiniciar tendrás que entrar de nuevo/, 'and it says what it costs');
  assert.notEqual(stored, notStored);
  for (const say of [stored, notStored]) {
    assert.ok(!/[0-9a-f]{32}|AQAA|api_hash/.test(say), `never a secret and never a field name: ${say}`);
  }
  // the card folds the host's own boolean; a view that does not carry it is «not stored», never an invented success
  assert.equal(M.telegramView({ state: 'connected' }, true, true).sessionStored, true);
  assert.equal(M.telegramView({ state: 'connected' }, true).sessionStored, false);
  assert.equal(M.telegramView({ state: 'connected' }, true, 'yes').sessionStored, false, 'only a true boolean counts');
});

test('the card asks the host before it says anything about the keychain, and shows our sentence for a refused command', () => {
  const src = read('minikodas-settings.js');
  // the old line claimed the keychain on every «connected», without asking: it is gone
  assert.doesNotMatch(src, /note = \{ tone: 'go', say: 'Telegram conectado\./, 'no unconditional claim survives in the card');
  assert.match(src, /api\.connectedSentence\(telegram\.sessionStored\)/, 'the sentence comes from the host’s own flag');
  assert.match(src, /next\.telegramSessionStored === true/, 'the flag is read from the view, strictly');
  // F8: a rejected command carries a closed code, and the card shows OUR sentence for it (never the host or keychain text)
  assert.match(src, /error && typeof error\.code === 'string'/, 'the rejection code is read');
  assert.doesNotMatch(src, /error\.message/, 'the message of a command is never shown as-is');
});

// ---- transcription --------------------------------------------------------------------------------------
test('Parakeet is the only local mode (S18) and it is the default (S16)', () => {
  assert.deepEqual([...M.MODES], ['local-parakeet', 'remote']);
  assert.equal(M.transcriptionView(null, []).mode, 'local-parakeet');
  const removed = M.transcriptionView({ setting: { mode: 'local-whisper-turbo', language: 'es' }, ffmpeg: 'available', local: 'available' }, []);
  assert.equal(removed.mode, 'local-parakeet', 'the removed local Whisper option can never be drawn');
  assert.deepEqual(M.transcriptionPayload('local-parakeet', 'es', 'nan', 'whisper'), M.transcriptionPayload('local-parakeet', 'es'), 'a local mode never carries remote fields');
  assert.deepEqual(M.transcriptionPayload('local-parakeet', 'es'), { action: 'transcription_set', setting: { mode: 'local-parakeet', language: 'es' } });
  assert.equal(M.transcriptionPayload('local-whisper-turbo', 'es', null, null), null, 'the page has no way to even offer it');
});

test('«Con una cuenta» offers only configured OpenAI-compatible accounts and needs a model', () => {
  const accounts = [
    { accountId: 'nan', label: 'NaN', provider: 'custom', configured: true },
    { accountId: 'otra', label: 'Otra', provider: 'custom', configured: false },
    { accountId: 'anthropic', label: 'Anthropic', provider: 'anthropic', configured: true },
    { accountId: 'nan', label: 'NaN repetida', provider: 'custom', configured: true },
    { accountId: 'MAL', label: 'mal', provider: 'custom', configured: true },
    null, 'x',
  ];
  assert.deepEqual(M.accountsForTranscription(accounts), [{ accountId: 'nan', label: 'NaN' }]);
  assert.deepEqual(M.accountsForTranscription(null), []);
  assert.deepEqual(M.transcriptionPayload('remote', 'en', 'nan', 'whisper'), {
    action: 'transcription_set', setting: { mode: 'remote', language: 'en', remote: { accountId: 'nan', model: 'whisper' } },
  });
  assert.equal(M.transcriptionPayload('remote', 'en', 'nan', ''), null, 'a remote without a model is not a setting');
  assert.equal(M.transcriptionPayload('remote', 'en', 'MAL', 'whisper'), null);
  assert.equal(M.transcriptionPayload('remote', 'en', 'nan', 'x'.repeat(201)), null);
  assert.equal(M.transcriptionPayload('remote', 'xx', 'nan', 'whisper').setting.language, 'es', 'an unknown language falls back to the stored default');
});

test('the view carries the tool state the daemon reports and nothing invented', () => {
  const v = M.transcriptionView({ setting: { mode: 'remote', language: 'en', remote: { accountId: 'nan', model: 'whisper' } }, ffmpeg: 'available', local: 'unavailable' }, []);
  assert.equal(v.mode, 'remote');
  assert.deepEqual(v.remote, { accountId: 'nan', model: 'whisper' });
  assert.equal(v.local, 'unavailable');
  assert.equal(v.ffmpeg, 'available');
  assert.equal(M.transcriptionView(null, []).local, null, 'nothing is claimed before the daemon answers');
});

// ---- the source ------------------------------------------------------------------------------------------
test('«Pedir otro» asks for the number the person typed, never for the example in the placeholder', () => {
  const src = read('minikodas-settings.js');
  // the phone field is emptied as soon as the login starts, so a second request must come from a value the card kept
  assert.doesNotMatch(src, /\|\|\s*stepNodes\.phone\.field\.placeholder/, 'the placeholder is an example, not a number to dial');
  assert.doesNotMatch(src, /loginStartPayload\([^)]*\.placeholder/, 'no payload is built from a placeholder');
  assert.match(src, /let loginPhone\b/, 'the number of the login in flight is kept in a closure variable');
  const again = src.slice(src.indexOf("#telegram-code-again').addEventListener"));
  assert.match(again.slice(0, 400), /loginStartPayload\(idInput\.value, hashInput\.value, loginPhone\)/, '«Pedir otro» uses the kept number');
  assert.match(src, /loginPhone = ''/, 'the kept number is dropped when the login ends');
});

test('the card never writes markup, never stores a secret and never names a removed option', () => {
  const src = read('minikodas-settings.js');
  assert.doesNotMatch(src, /\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=|document\.write\(/, 'text only: markup is never written');
  assert.doesNotMatch(src, /local-whisper-turbo\s*[,\]]/, 'S18: the removed local mode is not offered');
  assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB/, 'nothing is persisted by the page');
  assert.doesNotMatch(src, /console\.log\(/, 'no secret in a console line');
  // the api hash starts masked and the 2FA field is a password field
  assert.match(src, /hashInput\.type = 'password'/);
  assert.match(src, /field\.type = 'password'/);
  // the one host verb is the existing closed one
  const verbs = [...src.matchAll(/action: '([a-z_]+)'/g)].map(m => m[1]);
  for (const verb of verbs) {
    assert.match(verb, /^(telegram_login_start|telegram_login_code|telegram_login_password|telegram_logout|transcription_set|view|status|download_model|model_download)$/, `${verb} must be one of the closed verbs`);
  }
  assert.ok(verbs.includes('telegram_login_password'));
  // a secret is cleared as soon as it travelled
  assert.match(src, /stepNodes\.password\.field\.value = ''/, 'the 2FA password leaves the page right after it is sent');
  assert.match(src, /hashInput\.value = ''/, 'the api hash is cleared once the login landed');
});

test('the kept number is dropped whenever the folded step says no login is in progress (N6)', () => {
  const src = read('minikodas-settings.js');
  const from = src.indexOf('function apply(next)');
  assert.ok(from > 0, 'the apply function is found');
  // a daemon-reported ending (another window started the login, the account was already connected, a refused code) never
  // passes through the page's own success paths, so the number must be dropped where the folded step says so
  assert.match(src.slice(from, from + 900), /if \(telegram\.step === null\) loginPhone = ''/, 'the number of a login that is no longer in progress is dropped');
});

test('the container, its script and its tab are wired in index.html and settings.js', () => {
  const html = read('index.html');
  assert.match(html, /<section id="minikodas-settings" hidden><\/section>/);
  assert.match(html, /<script defer src="minikodas-settings\.js"><\/script>/);
  const settings = read('settings.js');
  assert.match(settings, /\$\('minikodas-settings'\)/);
  assert.match(settings, /minikodasGroup\.hidden = screen !== 'minikodas'/, 'the card only shows on its own tab');
  const view = read('settings-view.js');
  assert.match(view, /id: 'minikodas', title: 'Minikodas'/);
});

test('no new design token and no new colour or size literal was added by the card', () => {
  const src = read('minikodas-settings.js');
  for (const banned of [/--[a-z-]+:/, /#[0-9a-fA-F]{3,8}\b/, /rgba?\(/, /\bpx\b/]) {
    assert.doesNotMatch(src, banned, `the card uses the Ajustes components as they are: ${banned}`);
  }
});

// ---- the transcription MODEL STATE (T6b-3, artboard 06 frames 5-6) -----------------------------------------
// The island already knows and downloads the model (src/voicehost.rs): `voice_action {action:'status'}` answers
// `{ vad: <ModelState>, parakeet: <ModelState>, downloadMb: 1, speech: { model, models: [{ id, name, sizeMb, state, ... }] } }`,
// a ModelState is `{state:'missing'|'ready'} | {state:'downloading', fraction:0..1} | {state:'failed', error}`
// (src/speech/mod.rs ModelState, tag = "state"). `{action:'download_model'}` fetches the Silero VAD (src/speech/wake.rs
// download), `{action:'model_download', id}` one catalog entry (src/speech/mod.rs download_model). Transcription needs BOTH
// (src/speech/transcribe.rs run_transcribe returns ModelMissing when the model or the VAD is absent).
const PARAKEET = 'parakeet-tdt-0.6b-v3-int8';
const entry = (id = PARAKEET, sizeMb = 670) => ({ id, name: 'Parakeet v3', sizeMb, languages: ['es', 'en'], forcesLanguage: false, license: 'CC-BY-4.0', note: 'rápido', state: { state: 'missing' }, installed: false, active: true });
const voiceStatus = ({ parakeet = { state: 'missing' }, vad = { state: 'missing' }, models = [entry()], downloadMb = 1 } = {}) => ({
  prefs: { enabled: false, output: 'system', gender: 'female', sensitivity: 50 }, vad, downloadMb, parakeet, listening: false, error: null,
  training: { state: 'idle' }, speech: { language: 'es', model: PARAKEET, words: [], languages: ['es', 'en'], models },
});
const BOTH_READY = { parakeet: { state: 'ready' }, vad: { state: 'ready' } };

test('the model is drawn missing with the size the island reports, never a hard-coded one', () => {
  const v = M.modelView(voiceStatus());
  assert.equal(v.state, 'missing', 'nothing downloaded is «missing»');
  assert.equal(v.sizeMb, 670, 'the size is the one the island reports');
  assert.equal(v.pill, 'Falta · 670 MB', 'the artboard’s wording: «Falta · 612 MB» with the real size');
  assert.equal(v.percent, null, 'nothing is downloading: there is no percentage');
  assert.equal(v.canDownload, true, 'a missing model offers «Descargar»');
  assert.equal(v.canRetry, false);
  assert.match(v.sentence, /[Ff]alta/, 'it says the model is missing');
  // a reply without a usable size still names the state, without inventing megabytes
  const noSize = M.modelView(voiceStatus({ models: [{ id: PARAKEET, name: 'Parakeet v3' }] }));
  assert.equal(noSize.state, 'missing');
  assert.equal(noSize.sizeMb, null);
  assert.equal(noSize.pill, 'Falta');
});

test('«Instalado» means Parakeet AND the voice detector, never Parakeet alone', () => {
  const both = M.modelView(voiceStatus(BOTH_READY));
  assert.equal(both.state, 'ready');
  assert.equal(both.pill, 'Instalado · 670 MB');
  assert.equal(both.canDownload, false, 'an installed model offers no download button');
  assert.equal(both.canRetry, false);
  // Parakeet ready but the Silero VAD absent: transcription fails (transcribe.rs ModelMissing), so this is NOT «instalado»
  const noVad = M.modelView(voiceStatus({ parakeet: { state: 'ready' } }));
  assert.equal(noVad.state, 'missing', 'Parakeet alone cannot transcribe');
  assert.equal(noVad.parakeetReady, true);
  assert.equal(noVad.vadReady, false);
  assert.equal(noVad.sizeMb, 1, 'what is left is the detector, the size the island reports for it');
  assert.equal(noVad.pill, 'Falta · 1 MB');
  assert.equal(noVad.canDownload, true, 'the detector can still be fetched on a click');
  assert.equal(both.parakeetReady && both.vadReady, true);
});

test('downloading: an integer percentage from the reported fraction, clamped', () => {
  const half = M.modelView(voiceStatus({ parakeet: { state: 'downloading', fraction: 0.5 } }));
  assert.equal(half.state, 'downloading');
  assert.equal(half.percent, 50, 'the fraction becomes an integer percentage');
  assert.equal(half.doneMb, 335);
  assert.equal(half.detail, '50 % · 335 de 670 MB', 'the artboard’s progress line, without the speed nobody reports');
  assert.equal(half.pill, 'Descargando · 50 %');
  assert.equal(half.canDownload, false, 'a download in flight is not started twice');
  assert.equal(half.canRetry, false);
  assert.equal(M.modelView(voiceStatus({ parakeet: { state: 'downloading', fraction: 1.7 } })).percent, 100, 'clamped above');
  assert.equal(M.modelView(voiceStatus({ parakeet: { state: 'downloading', fraction: -0.4 } })).percent, 0, 'clamped below');
  assert.equal(M.modelView(voiceStatus({ parakeet: { state: 'downloading', fraction: Number.NaN } })).percent, 0, 'a broken fraction is 0, not NaN');
  assert.equal(M.modelView(voiceStatus({ parakeet: { state: 'downloading' } })).percent, 0, 'no fraction reported is 0');
  assert.equal(M.modelView(voiceStatus({ parakeet: { state: 'downloading', fraction: '0.5' } })).percent, 0, 'a string fraction is not trusted');
  // the detector's own download is shown with its own size
  const vadOnly = M.modelView(voiceStatus({ parakeet: { state: 'ready' }, vad: { state: 'downloading', fraction: 0.5 } }));
  assert.equal(vadOnly.state, 'downloading');
  assert.equal(vadOnly.sizeMb, 1);
  assert.equal(vadOnly.percent, 50);
});

test('a failed download says OUR sentence, offers «Reintentar», and never echoes the host text', () => {
  const hostText = 'ENOSPC: no space left on device, write /home/alvaro/.local/share/abito/.parakeet.part';
  for (const reply of [
    voiceStatus({ parakeet: { state: 'failed', error: hostText } }),
    voiceStatus({ parakeet: { state: 'ready' }, vad: { state: 'failed', error: hostText } }),
  ]) {
    const v = M.modelView(reply);
    assert.equal(v.state, 'failed');
    assert.equal(v.pill, 'Falló');
    assert.equal(v.canRetry, true, 'a failed download offers a retry');
    assert.equal(v.canDownload, false, 'the retry button is the one affordance, not two');
    assert.match(v.sentence, /conexi[oó]n|disco/, `it names the likely causes: ${v.sentence}`);
    const drawn = JSON.stringify(v);
    for (const leaked of ['ENOSPC', '/home', '.part', '.onnx', 'http']) assert.equal(drawn.includes(leaked), false, `the host text never reaches the page: ${leaked}`);
  }
});

test('a download that stops reporting is bounded, not an endless «cargando»', () => {
  assert.ok(Number.isInteger(M.MODEL_STALL_MS) && M.MODEL_STALL_MS >= 60000 && M.MODEL_STALL_MS <= 600000, 'the budget is minutes, not a spin');
  const moving = voiceStatus({ parakeet: { state: 'downloading', fraction: 0.3 } });
  assert.equal(M.modelView(moving, { waitedMs: 0 }).state, 'downloading');
  assert.equal(M.modelView(moving, { waitedMs: M.MODEL_STALL_MS - 1 }).state, 'downloading', 'one millisecond early is still downloading');
  const stalled = M.modelView(moving, { waitedMs: M.MODEL_STALL_MS });
  assert.equal(stalled.state, 'failed', 'silence past the budget is a failure, not progress');
  assert.equal(stalled.canRetry, true);
  assert.match(stalled.sentence, /dej[oó] de avanzar|no (lleg|recib)/, `it says the download went quiet: ${stalled.sentence}`);
  // a nonsense wait is the same as no wait
  for (const waitedMs of [undefined, null, 'x', -5, Number.NaN]) {
    assert.equal(M.modelView(moving, { waitedMs }).state, 'downloading', `waitedMs ${String(waitedMs)} cannot invent a failure`);
  }
  // and a real download in flight is never marked failed by the timer after progress resumed
  assert.equal(M.modelView({ ...moving, parakeet: { state: 'downloading', fraction: 0.6 } }, { waitedMs: 10 }).state, 'downloading');
});

test('anything unusable from the host is «unknown»: never a guess, never a throw', () => {
  const broken = [null, undefined, 'x', 7, [], {}, { parakeet: { state: 'ready' } }, { vad: { state: 'ready' } },
    { parakeet: { state: 'weird' }, vad: { state: 'ready' } }, { parakeet: { state: 'ready' }, vad: null },
    { parakeet: { state: 1 }, vad: { state: 'ready' } }, { parakeet: 'ready', vad: 'ready' }, { error: 'unavailable' }];
  for (const reply of broken) {
    const v = M.modelView(reply);
    assert.equal(v.state, 'unknown', `${JSON.stringify(reply)} is not a state the page can draw`);
    assert.equal(v.canDownload, false, 'an unknown state never offers a download: nothing is known about the model');
    assert.equal(v.canRetry, false);
    assert.equal(v.pill, '');
    assert.match(v.sentence, /estado del modelo/, 'it says the state could not be read');
  }
  // no throw, whatever arrives
  for (const reply of [Object.create(null), { speech: { models: 'x' } }, voiceStatus({ models: null })]) {
    assert.doesNotThrow(() => M.modelView(reply));
  }
  // a malformed status still cannot become a download: the id has to come from the reply
  assert.equal(M.downloadPayloads({ parakeet: { state: 'missing' }, vad: { state: 'missing' } }), null);
});

test('the download payloads are closed: the id read from the reply, and the fixed VAD verb', () => {
  assert.deepEqual([...M.downloadPayloads(voiceStatus())], [
    { action: 'model_download', id: PARAKEET },
    { action: 'download_model' },
  ], 'a missing model asks for both: the model and the detector it needs');
  // only the detector is missing: no second copy of the model
  assert.deepEqual([...M.downloadPayloads(voiceStatus({ parakeet: { state: 'ready' } }))], [{ action: 'download_model' }]);
  // nothing is asked for when everything is there, and never twice while downloading
  assert.equal(M.downloadPayloads(voiceStatus(BOTH_READY)), null);
  assert.equal(M.downloadPayloads(voiceStatus({ parakeet: { state: 'downloading', fraction: 0.2 } })), null, 'a download in flight is not asked for again');
  // a failed one can be asked again, both halves
  assert.equal(M.downloadPayloads(voiceStatus({ parakeet: { state: 'failed', error: 'x' } })).length, 2);
  for (const payload of M.downloadPayloads(voiceStatus())) {
    assert.deepEqual(Object.keys(payload).sort(), payload.action === 'download_model' ? ['action'] : ['action', 'id'], 'nothing but the closed fields travels');
  }
});

test('an id that is not the catalog entry in the reply is refused: no payload, no host call', () => {
  const bad = [
    { why: 'not in the list', models: [] },
    { why: 'another model only', models: [entry('whisper-small-int8', 394)] },
    { why: 'a URL', models: [entry('https://huggingface.co/x/parakeet.onnx')] },
    { why: 'a path', models: [entry('/home/alvaro/Apps/koda/parakeet.onnx')] },
    { why: 'a traversal', models: [entry('../x')] },
    { why: 'dots only', models: [entry('..')] },
    { why: 'empty', models: [entry('')] },
    { why: 'uppercase', models: [entry(PARAKEET.toUpperCase())] },
    { why: 'a number', models: [{ id: 7, name: 'x', sizeMb: 670 }] },
    { why: 'the list is not a list', models: 'x' },
  ];
  for (const { why, models } of bad) {
    const reply = voiceStatus({ models });
    assert.equal(M.modelDownloadPayload(reply), null, `${why}: no model payload`);
    assert.equal(M.downloadPayloads(reply), null, `${why}: no host call at all`);
    // even when only the detector is left, nothing is sent without the id we read from the reply
    assert.equal(M.downloadPayloads({ ...reply, parakeet: { state: 'ready' } }), null, `${why}: still nothing`);
  }
  // the good one still works, and the id is the reply’s own string
  assert.equal(M.modelDownloadPayload(voiceStatus()).id, PARAKEET);
  assert.equal(M.modelDownloadPayload(voiceStatus({ parakeet: { state: 'ready' } })), null, 'an installed model is not downloaded again');
  const vad = M.vadDownloadPayload(voiceStatus());
  assert.deepEqual(vad, { action: 'download_model' }, 'the detector is the fixed id-less verb (src/speech/wake.rs download)');
  assert.equal(M.vadDownloadPayload(voiceStatus(BOTH_READY)), null);
  assert.equal(M.vadDownloadPayload(voiceStatus({ vad: { state: 'downloading', fraction: 0.1 } })), null);
});

test('the card draws the model state from the island and asks for it only on a trusted click', () => {
  const src = read('minikodas-settings.js');
  // a short message per needle, so a failure never dumps the whole page
  const has = (needle, why) => assert.ok(src.includes(needle), `${why}: «${needle}» is missing from the page`);
  assert.equal(/612/.test(src), false, 'the artboard’s size is a drawing: the page shows the reported one');
  assert.equal(/https?:\/\//.test(src), false, 'no URL lives in the page');
  assert.equal(/\.onnx|\.part\b|\.local\/share/.test(src), false, 'no file name and no path lives in the page');
  // the state comes from the pure view, never from a literal
  has('api.modelView(', 'the card draws what modelView returns');
  has("invoke('voice_action'", 'the model state comes from the existing closed voice_action');
  has("callVoice({ action: 'status' })", 'the status is read when the card is shown');
  has("listen('voice-model'", 'and it is updated by the event the island emits (src/voicehost.rs voice-model)');
  // the button: a real click, then the closed payloads, nothing else
  const from = src.indexOf('modelBtn.addEventListener');
  assert.ok(from > 0, 'the download button has its own handler');
  const handler = src.slice(from, from + 2400);
  assert.match(handler, /e\.isTrusted !== true/, 'a synthetic click never downloads the model');
  assert.match(handler, /api\.modelClickAction\(/, 'the payloads come from the pure builder, through the click action');
  assert.match(handler, /action\.kind === 'download' \? action\.payloads : null/, 'only a `download` action carries payloads to the host');
  for (const banned of ['innerHTML', 'location', 'http', 'fetch(']) {
    assert.equal(handler.includes(banned), false, `the click handler never uses ${banned}`);
  }
  // the waiting is bounded by a timer, not by a poll
  has('api.MODEL_STALL_MS', 'the stall budget is the exported constant');
  has('setTimeout(', 'a timer repaints once the budget passes');
  assert.equal(/setInterval\(/.test(src), false, 'no polling loop');
  // TRIANGULATE: re-arming on every repaint would postpone the budget forever (an agent:state event every second is
  // enough), so the timer is armed for what is LEFT of `MODEL_STALL_MS` since the last sign of life.
  assert.match(src, /Math\.max\(0, api\.MODEL_STALL_MS - \(Date\.now\(\) - modelWait\)\)/, 'the timer counts from the last event, not from the last paint');
  // TRIANGULATE: the button lives on the local option, which is a <label>: a click on it would also pick the radio and
  // save the setting. The default action of that click is cancelled.
  assert.match(handler, /e\.preventDefault\(\)/, 'the download click does not also toggle the option it sits on');
});

test('the model sentence is ours in every state, in the artboard’s words', () => {
  const src = read('minikodas-settings.js');
  for (const needle of ['Falta${size}', 'Instalado${size}', "'Descargar'", "'Reintentar'"]) {
    assert.ok(src.includes(needle), `the artboard’s wording «${needle}» is missing`);
  }
  // the downloading line keeps the artboard’s shape and drops the speed nobody reports
  assert.ok(src.includes('% · ${doneMb} de ${sizeMb} MB'), 'the progress line is «N % · M de T MB»');
  assert.equal(/MB\/s/.test(src), false, 'the speed is not drawn: nobody reports it');
});

test('«Reintentar» after a stalled download re-reads the host and never starts a second download', () => {
  const base = {
    prefs: {}, vad: { state: 'ready' }, downloadMb: 1,
    parakeet: { state: 'downloading', fraction: 0.4 },
    speech: { models: [{ id: 'parakeet-tdt-0.6b-v3-int8', sizeMb: 670, state: { state: 'downloading', fraction: 0.4 }, installed: false }] },
  };
  // the host still says «downloading» but the page has heard nothing for longer than the budget: the card says failed/retry
  const stalled = M.modelClickAction(base, M.MODEL_STALL_MS + 1000);
  assert.deepEqual(stalled, { kind: 'reread' }, 'a stalled download asks the host again, it does not guess');
  // while it is still moving, a click on the (hidden) button does nothing
  assert.deepEqual(M.modelClickAction(base, 1000), { kind: 'none' });
  // a real failure or a missing model starts the download with the closed payloads only
  const failed = { ...base, parakeet: { state: 'failed', error: 'x' } };
  const act = M.modelClickAction(failed, 0);
  assert.equal(act.kind, 'download');
  assert.deepEqual(act.payloads, [{ action: 'model_download', id: 'parakeet-tdt-0.6b-v3-int8' }]);
  // a reply with no catalog entry can never produce a call
  assert.deepEqual(M.modelClickAction({ ...failed, speech: { models: [] } }, 0), { kind: 'none' });
  assert.deepEqual(M.modelClickAction(null, 0), { kind: 'none' });
  // nothing in the action carries anything but the closed verbs
  for (const p of act.payloads) assert.ok(['model_download', 'download_model'].includes(p.action));
});

test('the download click goes through modelClickAction', () => {
  const src = read('minikodas-settings.js');
  const handler = src.slice(src.indexOf('modelBtn.addEventListener'));
  assert.match(handler.slice(0, 1400), /api\.modelClickAction\(/, 'the click asks the pure function what to do');
  assert.doesNotMatch(handler.slice(0, 1400), /api\.downloadPayloads\(/, 'the click no longer builds payloads from the raw host state');
});

console.log(`minikodas-settings-check: ${passed} passed`);
