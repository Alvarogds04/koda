'use strict';
/* K2-13 T6b-3 (S7, S10, S16, S18, S20) — Ajustes → Minikodas: Telegram and the transcription setting.
   Design: design/k2-13-minikodas/06-ajustes-telegram.html (artboards 04/05/06 approved by the human, L42), mapped onto the
   Ajustes panel's own components (`.ssec`, `.ssection`, `.srow`, `.sfield`, `.sbtn`, `.snote`, `.sform`) and its tokens:
   no new colour, no new type step, no new IPC command.

   WHAT LIVES HERE AND WHAT DOES NOT:
   - Telegram (S10): the api_id and the api_hash are typed here, the account is connected HERE (phone → code → 2FA) and the
     session is stored by the HOST in the OS keychain. This page never receives the session, never stores the api hash, the
     code or the password beyond the field that holds them, and clears every secret field as soon as it is sent.
   - Transcription (S7/S16/S18): Parakeet on this PC is the only local option and the default; «Con una cuenta» is the
     alternative, with a configured OpenAI-compatible account and a model id. There is no Whisper option and no download
     setting (S18/S19).
   - NOT here: the per-Minikoda model selector of artboard 06 lives with artboards 04/05 (the list and the creation card).
     The model-missing / downloading state of the artboard is not drawn either: the daemon reports only
     `local: available|unavailable` (the bundled helper), never a download progress, so the page does not invent one.
   - The one closed host verb is the existing `agent_action` (src/agentclient.rs's allowlist): the page can ask eight
     verbs and nothing else.

   Loaded as a classic script (window.AbitoMinikodas) and by test-node/minikodas-settings-check.cjs through
   `module.exports`. Text only (textContent, never innerHTML); the outcome of a command is a sentence of OURS chosen from
   the daemon's closed code, never its free text. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = Object.freeze(api); return; }
  root.AbitoMinikodas = Object.freeze(api);
  mount(api);
})(typeof self !== 'undefined' ? self : this, () => {
  // ---- the daemon's own bounds (protocol.cjs TELEGRAM_LIMITS and transcribe-setting.cjs) ----------------------
  const API_ID_MAX = 2147483647;
  const CODE_MAX = 32;
  const PASSWORD_MAX = 1024;
  const MODEL_MAX = 200;
  const HASH = /^[0-9a-f]{32}$/;
  const PHONE = /^\+[1-9]\d{6,14}$/;
  const ACCOUNT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
  const CONTROL = /[\u0000-\u001f\u007f]/;
  /** S18: the only local mode. `local-whisper-turbo` is gone from the contract, so it is gone from here too. */
  const MODES = Object.freeze(['local-parakeet', 'remote']);
  const LANGUAGES = Object.freeze(['es', 'en', 'fr', 'de', 'it', 'pt', 'ca']);
  const STATES = Object.freeze(['disconnected', 'awaiting_code', 'awaiting_password', 'connected']);

  // ---- what the human reads -----------------------------------------------------------------------------------
  // One sentence of OURS per closed code (PROTOCOL.md): the daemon's own text is never shown as-is.
  const SENTENCES = Object.freeze({
    telegram_unavailable: 'Telegram todavía no está disponible en esta instalación. Probá de nuevo cuando Koda termine de arrancar.',
    telegram_already_connected: 'Ya hay una cuenta de Telegram conectada. Desconectala antes de conectar otra.',
    telegram_not_awaiting_code: 'El pedido del código ya no está esperando. Tocá «Conectar» para empezar de nuevo.',
    telegram_not_awaiting_password: 'La contraseña de dos pasos ya no se está esperando. Tocá «Conectar» para empezar de nuevo.',
    telegram_credentials_invalid: 'Telegram no aceptó el api_id o el api_hash: revisalos en my.telegram.org.',
    telegram_code_invalid: 'El código no es el correcto o ya venció. Podés pedir otro y probar de nuevo.',
    telegram_password_invalid: 'La contraseña de dos pasos no es la correcta.',
    telegram_password_required: 'Tu cuenta tiene contraseña de dos pasos: escribila para terminar de conectar.',
    telegram_session_invalid: 'Telegram cerró esa sesión (o la revocaste desde el teléfono). Las credenciales guardadas se borraron: volvé a conectar.',
    telegram_cancelled: 'El pedido se canceló. Podés empezar de nuevo cuando quieras.',
    telegram_login_other_connection: 'El ingreso lo empezó otra ventana y sólo esa puede terminarlo. Cerrá la otra ventana de Ajustes y volvé a conectar desde acá.',
    telegram_failed: 'Telegram no completó el pedido. Probá de nuevo en un momento.',
    paused: 'Koda está en pausa: quitá la pausa y volvé a intentar.',
    unavailable: 'El motor de Koda no está disponible ahora mismo.',
    bad_request: 'Faltó un dato o no tenía el formato esperado. Revisalo y probá de nuevo.',
    failed: 'No se pudo completar.',
  });
  const MAX_MINUTES = 1440;
  /** The sentence for one closed code. `telegram_flood_wait` says the minutes the daemon reported (1–1440). */
  function errorSentence(code, telegram) {
    if (typeof code !== 'string' || code === '') return SENTENCES.failed;
    if (code === 'telegram_flood_wait') {
      const minutes = telegram && Number.isInteger(telegram.retryAfterMinutes) ? telegram.retryAfterMinutes : 0;
      const n = minutes >= 1 && minutes <= MAX_MINUTES ? minutes : 0;
      return n ? `Telegram pidió esperar ${n} ${n === 1 ? 'minuto' : 'minutos'}.` : 'Telegram pidió esperar un rato antes de volver a intentar.';
    }
    return Object.prototype.hasOwnProperty.call(SENTENCES, code) ? SENTENCES[code] : SENTENCES.failed;
  }

  // ---- the Telegram card's state ------------------------------------------------------------------------------
  /**
   * The folded `telegram` view + the host's boolean → what the card draws. The step is derived from the daemon's state and
   * nothing else: the page never claims a step the daemon did not reach.
   */
  function telegramView(view, credentials) {
    const state = view && STATES.includes(view.state) ? view.state : 'disconnected';
    const account = view && view.account && typeof view.account.name === 'string'
      ? { name: view.account.name, username: typeof view.account.username === 'string' ? view.account.username : null }
      : null;
    const step = state === 'awaiting_code' ? 'code' : state === 'awaiting_password' ? 'password' : state === 'disconnected' ? 'phone' : null;
    return Object.freeze({
      state,
      connected: state === 'connected',
      step,
      account,
      credentials: credentials === true,
      // the notice the daemon attached (Koda's own Spanish sentence, e.g. a FLOOD_WAIT), bounded and control-free
      notice: view && typeof view.notice === 'string' && view.notice.length > 0 && view.notice.length <= 300 && !CONTROL.test(view.notice) ? view.notice : '',
      minutes: view && Number.isInteger(view.retryAfterMinutes) && view.retryAfterMinutes >= 1 && view.retryAfterMinutes <= MAX_MINUTES ? view.retryAfterMinutes : 0,
    });
  }
  /** `Álvaro · @alvaro` / `Álvaro`, never a phone number (the daemon does not send one) and never a bare username. */
  function accountLine(account) {
    if (!account || typeof account.name !== 'string' || !account.name.trim()) return '';
    return account.username ? `${account.name} · @${account.username}` : account.name;
  }

  // ---- field validation: the same rules the host and the daemon apply -----------------------------------------
  function apiIdProblem(text) {
    const raw = String(text == null ? '' : text).trim();
    if (!/^\d{1,10}$/.test(raw)) return 'Sólo números.';
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < 1 || n > API_ID_MAX) return 'Ese api_id no es válido.';
    return '';
  }
  function apiHashProblem(text) {
    const raw = String(text == null ? '' : text).trim();
    if (!HASH.test(raw)) return 'El api_hash son 32 caracteres en minúscula (0-9, a-f).';
    return '';
  }
  function phoneProblem(text) {
    const raw = String(text == null ? '' : text).replace(/[\s()-]/g, '');
    if (!PHONE.test(raw)) return 'Poné el número con el código de país, como +5491155554321.';
    return '';
  }
  function codeProblem(text) {
    const raw = String(text == null ? '' : text).trim();
    if (!raw || raw.length > CODE_MAX || CONTROL.test(raw)) return 'Escribí el código que llegó al teléfono.';
    return '';
  }
  function passwordProblem(text) {
    const raw = String(text == null ? '' : text) || '';
    if (!raw || raw.length > PASSWORD_MAX || CONTROL.test(raw)) return 'Escribí tu contraseña de dos pasos.';
    return '';
  }

  /** The three fields of `telegram_login_start` (the api pair and the phone), or null when one of them is wrong. */
  function loginStartPayload(apiId, apiHash, phone) {
    if (apiIdProblem(apiId) || apiHashProblem(apiHash) || phoneProblem(phone)) return null;
    return { action: 'telegram_login_start', apiId: Number(String(apiId).trim()), apiHash: String(apiHash).trim(), phone: String(phone).replace(/[\s()-]/g, '') };
  }
  function codePayload(code) {
    return codeProblem(code) ? null : { action: 'telegram_login_code', code: String(code).trim() };
  }
  function passwordPayload(password) {
    return passwordProblem(password) ? null : { action: 'telegram_login_password', password: String(password) };
  }

  // ---- the transcription card ----------------------------------------------------------------------------------
  /** Only a configured OpenAI-compatible (custom) account can transcribe remotely; anything else is not offered. */
  function accountsForTranscription(accounts) {
    const list = Array.isArray(accounts) ? accounts : [];
    const rows = list.filter(a => a && a.provider === 'custom' && a.configured === true && typeof a.accountId === 'string' && ACCOUNT_ID.test(a.accountId));
    const seen = new Set();
    return rows.filter(a => (seen.has(a.accountId) ? false : seen.add(a.accountId))).map(a => ({ accountId: a.accountId, label: typeof a.label === 'string' && a.label.trim() ? a.label : a.accountId }));
  }
  function modelProblem(text) {
    const raw = String(text == null ? '' : text).trim();
    if (!raw || raw.length > MODEL_MAX || CONTROL.test(raw)) return 'Escribí el modelo de esa cuenta (por ejemplo whisper).';
    return '';
  }
  /** The folded `transcription` view + the accounts to offer → what the card draws. Parakeet is the default (S16/S18). */
  function transcriptionView(view, accounts) {
    const setting = view && view.setting && typeof view.setting === 'object' ? view.setting : null;
    const mode = setting && MODES.includes(setting.mode) ? setting.mode : 'local-parakeet';
    const language = setting && LANGUAGES.includes(setting.language) ? setting.language : 'es';
    const remote = setting && setting.remote && typeof setting.remote.accountId === 'string'
      ? { accountId: setting.remote.accountId, model: typeof setting.remote.model === 'string' ? setting.remote.model : '' }
      : null;
    return Object.freeze({
      mode,
      language,
      remote,
      options: accountsForTranscription(accounts),
      // `null` until the daemon answers: the page never claims the helper is there before being told
      local: view && typeof view.local === 'string' ? view.local : null,
      ffmpeg: view && typeof view.ffmpeg === 'string' ? view.ffmpeg : null,
    });
  }
  /** `transcription_set`, validated as the host and the daemon validate it, or null. */
  function transcriptionPayload(mode, language, accountId, model) {
    if (!MODES.includes(mode)) return null;
    const lang = LANGUAGES.includes(language) ? language : 'es';
    if (mode === 'local-parakeet') return { action: 'transcription_set', setting: { mode, language: lang } };
    if (typeof accountId !== 'string' || !ACCOUNT_ID.test(accountId) || modelProblem(model)) return null;
    return { action: 'transcription_set', setting: { mode, language: lang, remote: { accountId, model: String(model).trim() } } };
  }

  const JOINED = /\s+/g;
  /** The account / notice lines are trimmed and collapsed so a long label cannot break the row's height. */
  const oneLine = text => String(text == null ? '' : text).replace(JOINED, ' ').trim().slice(0, 120);

  return Object.freeze({
    API_ID_MAX, CODE_MAX, PASSWORD_MAX, MODEL_MAX, MODES, LANGUAGES, STATES, SENTENCES,
    errorSentence, telegramView, accountLine,
    apiIdProblem, apiHashProblem, phoneProblem, codeProblem, passwordProblem, modelProblem,
    loginStartPayload, codePayload, passwordPayload,
    accountsForTranscription, transcriptionView, transcriptionPayload, oneLine,
  });
});

/* ---- browser only: the card, mounted into #minikodas-settings ---------------------------------------------- */
function mount(api) {
  const host = document.getElementById('minikodas-settings');
  if (!host) return;
  const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)
    || (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) || null;
  const listen = (window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen) || null;
  if (!invoke) return;
  const call = payload => invoke('agent_action', { payload });
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };

  let agentState = null;
  let credentials = false;
  let telegram = api.telegramView(null, false);
  let transcription = api.transcriptionView(null, []);
  let note = null;        // { tone: 'go'|'sun'|'red', say } — a sentence of OURS
  let busy = false;
  let waitedError = 0;    // the last_error counter we have already answered
  let lastSent = null;    // { action, at } of the command in flight, for the honest timeout
  let timer = 0;

  // ---- the static skeleton (built once: every later update writes text or toggles `hidden`) -------------------
  const tg = el('section', 'ssec'); tg.id = 'minikodas-telegram'; tg.append(el('h3', 'ssection', 'Telegram'));
  tg.append(el('p', 'snote', 'Koda lee los canales con tu cuenta, no con un bot: un bot no puede leer un canal donde no lo metieron. Para eso Telegram pide dos datos de una app tuya.'));

  const pairForm = el('form', 'sform'); pairForm.noValidate = true; pairForm.id = 'telegram-pair';
  const idLabel = el('label', 'srow-sub', 'api_id'); idLabel.htmlFor = 'telegram-api-id';
  const idInput = el('input', 'sfield'); idInput.id = 'telegram-api-id'; idInput.type = 'text'; idInput.inputMode = 'numeric';
  idInput.autocomplete = 'off'; idInput.spellcheck = false; idInput.maxLength = 10; idInput.setAttribute('aria-describedby', 'telegram-pair-problem');
  const hashLabel = el('label', 'srow-sub', 'api_hash'); hashLabel.htmlFor = 'telegram-api-hash';
  const hashInput = el('input', 'sfield'); hashInput.id = 'telegram-api-hash'; hashInput.type = 'password';
  hashInput.autocomplete = 'off'; hashInput.spellcheck = false; hashInput.maxLength = 32; hashInput.setAttribute('aria-describedby', 'telegram-pair-problem');
  const showHash = el('button', 'sbtn', 'Mostrar'); showHash.type = 'button'; showHash.setAttribute('aria-pressed', 'false');
  const connectBtn = el('button', 'sbtn primary', 'Conectar'); connectBtn.type = 'button';
  // label above its field, the two pairs side by side (the artboard's own arrangement), and the actions at the end
  const field = (label, input) => { const column = el('span', 'srow-titles'); column.append(label, input); return column; };
  const pairActions = el('span', 'srow-actions'); pairActions.append(showHash, connectBtn);
  pairForm.append(field(idLabel, idInput), field(hashLabel, hashInput), pairActions);
  const pairProblem = el('p', 'snote'); pairProblem.id = 'telegram-pair-problem'; pairProblem.setAttribute('role', 'status');
  tg.append(pairForm, pairProblem);
  tg.append(el('p', 'snote', 'Los sacás en my.telegram.org › API development tools: entrás con tu teléfono, creás una app y te da los dos. Koda los guarda en el llavero del sistema, junto con la sesión.'));

  // the three steps, drawn before they are reached (the artboard's promise: nobody is surprised halfway)
  const steps = el('ol', 'srow-titles'); steps.id = 'telegram-steps'; steps.setAttribute('aria-label', 'Cómo se conecta tu cuenta');
  const stepNodes = {};
  for (const [key, title, hint] of [
    ['phone', 'Tu teléfono', 'Con el código de país, como lo usás en Telegram.'],
    ['code', 'El código', 'Telegram manda un código al teléfono (o a la app, si la tenés abierta).'],
    ['password', 'Dos pasos', 'Sólo si tu cuenta tiene contraseña de dos pasos.'],
  ]) {
    const li = el('li', 'srow'); li.id = `telegram-step-${key}`; li.dataset.step = key;
    const head = el('span', 'srow-titles'); head.append(el('b', 'srow-title', title), el('span', 'srow-sub', hint));
    li.append(head);
    const field = el('input', 'sfield');
    field.id = `telegram-${key}-input`;
    field.autocomplete = 'off'; field.spellcheck = false;
    if (key === 'phone') { field.type = 'tel'; field.inputMode = 'tel'; field.placeholder = '+5491155554321'; field.maxLength = 20; }
    if (key === 'code') { field.type = 'text'; field.inputMode = 'numeric'; field.maxLength = api.CODE_MAX; field.placeholder = 'Código'; }
    if (key === 'password') { field.type = 'password'; field.autocomplete = 'current-password'; field.maxLength = api.PASSWORD_MAX; field.placeholder = 'Tu contraseña de dos pasos'; }
    field.setAttribute('aria-label', `Telegram: ${title}`);
    const act = el('span', 'srow-actions');
    const submit = el('button', 'sbtn primary', key === 'code' ? 'Entrar' : key === 'password' ? 'Entrar' : 'Pedir código');
    submit.type = 'button'; submit.id = `telegram-${key}-send`;
    act.append(submit);
    if (key === 'code') {
      // «Pedir otro» re-sends the phone: the daemon's refused-code path keeps the login where it was.
      const again = el('button', 'sbtn', 'Pedir otro'); again.type = 'button'; again.id = 'telegram-code-again';
      act.append(again);
    }
    li.append(field, act);
    steps.append(li);
    stepNodes[key] = { li, field, submit };
  }
  const stepsWrap = el('div', ''); stepsWrap.id = 'telegram-steps-wrap'; stepsWrap.append(steps);

  // connected
  const connectedRow = el('div', 'srow'); connectedRow.id = 'telegram-connected';
  const connectedText = el('span', 'srow-titles');
  const connectedName = el('b', 'srow-title', '');
  const connectedSub = el('span', 'srow-sub', 'La sesión vive en el llavero de tu sistema.');
  connectedText.append(connectedName, connectedSub);
  const disconnect = el('button', 'sbtn', 'Desconectar'); disconnect.type = 'button'; disconnect.id = 'telegram-disconnect';
  const connectedAct = el('span', 'srow-actions'); connectedAct.append(disconnect);
  connectedRow.append(connectedText, connectedAct);

  // the visible Telegram-API note (S10): what is being used, what it implies and where it is cut
  const apiNote = el('p', 'snote');
  apiNote.id = 'telegram-api-note';
  apiNote.textContent = 'Koda usa la API de Telegram, no un bot: los términos de Telegram piden que la app sea tuya y que la sesión quede en tu equipo. Por eso los datos se piden acá y la sesión vive en el llavero del sistema, nunca en un archivo. Si desconfiás, podés desconectar cuando quieras y Telegram cierra la sesión.';
  tg.append(stepsWrap, connectedRow, apiNote);

  // transcription
  const tr = el('section', 'ssec'); tr.id = 'minikodas-transcription'; tr.append(el('h3', 'ssection', 'Transcripción de los videos'));
  tr.append(el('p', 'snote', 'Cuando un canal publica un video —o un enlace de YouTube—, Koda lo transcribe antes de resumirlo. En esta PC se hace con Parakeet, la única opción local.'));
  const group = el('div', 'srow'); group.id = 'transcription-options'; group.setAttribute('role', 'radiogroup'); group.setAttribute('aria-label', 'Cómo se transcriben los videos');
  const localRow = el('label', 'srow'); localRow.id = 'transcription-local-row';
  const localRadio = el('input', ''); localRadio.type = 'radio'; localRadio.name = 'transcription-mode'; localRadio.value = 'local-parakeet'; localRadio.id = 'transcription-local';
  const localText = el('span', 'srow-titles');
  const localTitle = el('b', 'srow-title', 'En esta PC · Parakeet'); localTitle.id = 'transcription-local-title';
  localText.append(localTitle, el('span', 'srow-sub', 'Rápido y recomendado: no sale nada de tu equipo. El mismo motor del dictado.'));
  localRow.append(localRadio, localText);
  const remoteRow = el('label', 'srow'); remoteRow.id = 'transcription-remote-row';
  const remoteRadio = el('input', ''); remoteRadio.type = 'radio'; remoteRadio.name = 'transcription-mode'; remoteRadio.value = 'remote'; remoteRadio.id = 'transcription-remote';
  const remoteText = el('span', 'srow-titles');
  remoteText.append(el('b', 'srow-title', 'Con una cuenta'), el('span', 'srow-sub', 'Usa la cuota de una cuenta compatible con OpenAI que ya tengas configurada.'));
  const remoteFields = el('span', 'srow-actions'); remoteFields.id = 'transcription-remote-fields';
  const accountSelect = el('select', 'sfield'); accountSelect.id = 'transcription-account'; accountSelect.setAttribute('aria-label', 'Cuenta para transcribir');
  const modelInput = el('input', 'sfield'); modelInput.id = 'transcription-model'; modelInput.type = 'text'; modelInput.maxLength = api.MODEL_MAX;
  modelInput.autocomplete = 'off'; modelInput.spellcheck = false; modelInput.placeholder = 'whisper'; modelInput.setAttribute('aria-label', 'Modelo de transcripción de esa cuenta');
  remoteFields.append(accountSelect, modelInput);
  remoteRow.append(remoteRadio, remoteText, remoteFields);
  group.append(localRow, remoteRow);
  const trLocalNote = el('p', 'snote'); trLocalNote.id = 'transcription-local-note';
  const trProblem = el('p', 'snote'); trProblem.id = 'transcription-problem'; trProblem.setAttribute('role', 'status');
  tr.append(group, trLocalNote, trProblem);
  tr.append(el('p', 'snote', 'La transcripción tiene su propio límite de 30 minutos por corrida: no gasta los 5 minutos del Minikoda. Si un video no termina a tiempo, se cancela, se borra el audio temporal y «Hoy» te avisa que era demasiado largo.'));

  // the one live region of the whole section
  const live = el('p', 'snote'); live.id = 'minikodas-live'; live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite');
  host.append(tg, tr, live);

  // ---- painting ------------------------------------------------------------------------------------------------
  function paintTelegram() {
    const t = telegram;
    idInput.disabled = t.connected || busy;
    hashInput.disabled = t.connected || busy;
    showHash.disabled = t.connected;
    connectBtn.disabled = t.connected || busy;
    connectBtn.textContent = t.connected ? 'Conectado' : 'Conectar';
    // the pair stays visible while a login is in flight so a typo can be fixed before starting over
    stepsWrap.hidden = t.connected;
    connectedRow.hidden = !t.connected;
    for (const key of ['phone', 'code', 'password']) {
      const node = stepNodes[key];
      const current = t.step === key;
      node.li.dataset.state = t.connected || t.step === null ? 'done' : current ? 'now' : (key === 'password' && t.step === 'code') || (key === 'code' && t.step === 'password') ? 'pending' : 'pending';
      node.li.setAttribute('aria-current', current ? 'step' : 'false');
      node.li.hidden = t.connected;
      node.field.disabled = !current || busy;
      node.submit.disabled = !current || busy;
      if (key === 'code') stepNodes.code.li.querySelector('#telegram-code-again').disabled = !current || busy;
      node.li.dataset.current = current ? 'true' : 'false';
    }
    connectedName.textContent = api.oneLine(api.accountLine(t.account)) || 'Tu cuenta de Telegram';
    disconnect.disabled = busy;
    // the outcome: our sentence for the closed code, or the daemon's own notice (bounded, and never free text of Telegram)
    const say = note && note.say ? note.say : t.notice || (t.minutes ? api.errorSentence('telegram_flood_wait', { retryAfterMinutes: t.minutes }) : '');
    live.textContent = say;
    live.dataset.tone = note && note.tone ? note.tone : t.notice ? 'sun' : '';
    // a stored triple with no session in the daemon is an honest wait, not a silent one
    if (!note && t.state === 'disconnected' && t.credentials) live.textContent = 'Guardamos tu sesión de Telegram: Koda la está restaurando.';
  }
  function paintTranscription() {
    const v = transcription;
    localRadio.checked = v.mode === 'local-parakeet';
    remoteRadio.checked = v.mode === 'remote';
    localRadio.disabled = busy;
    remoteRadio.disabled = busy;
    remoteFields.hidden = v.mode !== 'remote';
    // accounts
    const wanted = v.remote ? v.remote.accountId : v.options.length ? v.options[0].accountId : '';
    const options = v.options.length ? v.options : wanted ? [{ accountId: wanted, label: wanted }] : [];
    accountSelect.textContent = '';
    if (!options.length) accountSelect.append(el('option', '', 'Sin cuentas compatibles configuradas'));
    for (const o of options) {
      const option = el('option', '', api.oneLine(o.label));
      option.value = o.accountId;
      option.selected = o.accountId === wanted;
      accountSelect.append(option);
    }
    accountSelect.disabled = busy || !options.length;
    const wantedModel = v.remote && v.remote.accountId === accountSelect.value ? v.remote.model : '';
    if (document.activeElement !== modelInput) modelInput.value = wantedModel;
    modelInput.disabled = busy || !options.length;
    // the local state: only what the daemon said, never an invented download
    trLocalNote.textContent = v.local === 'available'
      ? 'Parakeet está instalado en esta PC.'
      : v.local === 'unavailable'
        ? 'La transcripción local no está disponible en esta instalación: los Minikodas que traigan videos van a avisar ese problema en «Hoy».'
        : '';
    trLocalNote.hidden = !trLocalNote.textContent;
    trProblem.textContent = v.options.length ? '' : 'Para «Con una cuenta» necesitás una cuenta compatible con OpenAI en Ajustes › Conexiones.';
    trProblem.hidden = !trProblem.textContent;
  }
  function paint() {
    paintTelegram();
    paintTranscription();
  }

  // ---- talking to the host ------------------------------------------------------------------------------------
  function apply(next) {
    if (!next || typeof next !== 'object') return;
    agentState = next;
    credentials = next.telegramCredentials === true;
    telegram = api.telegramView(next.telegram, credentials);
    transcription = api.transcriptionView(next.transcription, next.accounts);
    const error = next.last_error && Number.isInteger(next.last_error.n) ? next.last_error : null;
    if (error && error.n > waitedError) {
      waitedError = error.n;
      // an answer arrived: the sentence is the daemon's closed code, never its text
      if ((lastSent && /^telegram_|^transcription_/.test(lastSent.action)) || !lastSent) {
        note = { tone: error.code === 'telegram_session_invalid' ? 'red' : 'sun', say: api.errorSentence(error.code, telegram) };
      }
    }
    if (lastSent && telegram.connected && lastSent.action !== 'telegram_logout') {
      note = { tone: 'go', say: 'Telegram conectado. La sesión quedó en el llavero de tu sistema.' };
    }
    if (lastSent && lastSent.action === 'telegram_logout' && !telegram.connected) {
      note = { tone: 'go', say: 'Desconectado. La sesión guardada se borró de este equipo.' };
    }
    paint();
  }
  function send(payload, okSay) {
    if (busy || !payload) return;
    busy = true;
    waitedError = agentState && agentState.last_error && Number.isInteger(agentState.last_error.n) ? agentState.last_error.n : waitedError;
    lastSent = { action: payload.action, at: Date.now() };
    note = null;
    if (okSay) note = { tone: 'go', say: okSay };
    paint();
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!busy) return;
      busy = false;
      note = { tone: 'sun', say: 'El motor de Koda no respondió. Probá de nuevo.' };
      paint();
    }, 6000);
    call(payload).then(next => {
      busy = false; clearTimeout(timer);
      apply(next);
      // secrets leave the page as soon as they travelled (a failed login too)
      if (payload.action === 'telegram_login_password') stepNodes.password.field.value = '';
      if (payload.action === 'telegram_login_code') stepNodes.code.field.value = '';
      if (payload.action === 'telegram_login_start') stepNodes.phone.field.value = '';
      // a successful connect means the stored pair is no longer needed on screen
      if (payload.action !== 'telegram_login_start' && telegram.connected) { hashInput.value = ''; idInput.value = ''; }
      paint();
    }, () => {
      busy = false; clearTimeout(timer);
      note = { tone: 'red', say: 'No se pudo completar el pedido.' };
      paint();
    });
  }

  showHash.addEventListener('click', e => {
    if (e.isTrusted !== true) return;
    const hidden = hashInput.type === 'password';
    hashInput.type = hidden ? 'text' : 'password';
    showHash.textContent = hidden ? 'Ocultar' : 'Mostrar';
    showHash.setAttribute('aria-pressed', hidden ? 'true' : 'false');
  });
  // «Conectar» validates the api pair and moves to the phone: the login itself starts when the phone is sent.
  connectBtn.addEventListener('click', e => {
    if (e.isTrusted !== true) return;
    const problem = api.apiIdProblem(idInput.value) || api.apiHashProblem(hashInput.value);
    pairProblem.textContent = problem;
    idInput.setAttribute('aria-invalid', api.apiIdProblem(idInput.value) ? 'true' : 'false');
    hashInput.setAttribute('aria-invalid', api.apiHashProblem(hashInput.value) ? 'true' : 'false');
    if (problem) return;
    stepNodes.phone.field.focus();
    note = { tone: 'go', say: 'Ahora el teléfono: Telegram te va a mandar un código.' };
    paint();
  });
  stepNodes.phone.submit.addEventListener('click', e => {
    if (e.isTrusted !== true) return;
    const payload = api.loginStartPayload(idInput.value, hashInput.value, stepNodes.phone.field.value);
    pairProblem.textContent = payload ? '' : api.phoneProblem(stepNodes.phone.field.value) || api.apiHashProblem(hashInput.value);
    if (!payload) return;
    send(payload, 'Te mandamos el código: escribilo acá abajo.');
    stepNodes.code.field.focus();
  });
  stepNodes.code.submit.addEventListener('click', e => {
    if (e.isTrusted !== true) return;
    const payload = api.codePayload(stepNodes.code.field.value);
    if (!payload) { note = { tone: 'sun', say: api.codeProblem(stepNodes.code.field.value) }; paint(); return; }
    send(payload, '');
    stepNodes.password.field.focus();
  });
  stepNodes.code.li.querySelector('#telegram-code-again').addEventListener('click', e => {
    if (e.isTrusted !== true) return;
    const payload = api.loginStartPayload(idInput.value, hashInput.value, stepNodes.phone.field.value || stepNodes.phone.field.placeholder);
    if (payload) send(payload, 'Pedimos otro código.');
  });
  stepNodes.password.submit.addEventListener('click', e => {
    if (e.isTrusted !== true) return;
    const payload = api.passwordPayload(stepNodes.password.field.value);
    if (!payload) { note = { tone: 'sun', say: api.passwordProblem(stepNodes.password.field.value) }; paint(); return; }
    send(payload, '');
  });
  disconnect.addEventListener('click', e => {
    if (e.isTrusted !== true) return;
    send({ action: 'telegram_logout' }, 'Desconectando…');
  });
  function saveTranscription() {
    const mode = remoteRadio.checked ? 'remote' : 'local-parakeet';
    const payload = api.transcriptionPayload(mode, transcription.language, accountSelect.value, modelInput.value);
    if (!payload) {
      trProblem.textContent = mode === 'remote' ? api.modelProblem(modelInput.value) || 'Elegí una cuenta configurada.' : '';
      trProblem.hidden = !trProblem.textContent;
      return;
    }
    send(payload, mode === 'remote' ? 'Transcripción: con una cuenta.' : 'Transcripción: Parakeet en esta PC.');
  }
  localRadio.addEventListener('change', e => { if (e.isTrusted !== false) saveTranscription(); });
  remoteRadio.addEventListener('change', e => { if (e.isTrusted === false) return; saveTranscription(); });
  accountSelect.addEventListener('change', e => { if (e.isTrusted !== false) saveTranscription(); });
  modelInput.addEventListener('change', e => { if (e.isTrusted !== false) saveTranscription(); });

  if (listen) {
    const fail = name => error => console.error(`minikodas: live ${name} events unavailable`, error);
    listen('agent:state', e => apply(e && e.payload)).catch(fail('agent:state'));
  }
  // The read happens when the card is SHOWN, never at island start: the island page loads with Ajustes closed, and a
  // hidden card has no business opening the daemon's socket. The panel re-appends this section on its own tab
  // (settings.js re-appends it, it never rebuilds it), so the observer sees exactly the transitions that matter.
  let shown = false;
  function read() {
    call({ action: 'view' }).then(next => { shown = true; apply(next); }, () => {
      live.textContent = 'No se pudo leer el estado de Telegram ni el de la transcripción.';
    });
  }
  const observer = new MutationObserver(() => { if (!host.hidden && !shown) read(); else if (host.hidden) shown = false; });
  observer.observe(host, { attributes: true, attributeFilter: ['hidden'] });
  if (!host.hidden) read();
  paint();
}
