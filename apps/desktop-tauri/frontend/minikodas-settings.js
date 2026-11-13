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
   - The MODEL STATE of the local transcription model is drawn (T6b-3, artboard 06 frames 5-6): «Falta · N MB»,
     «Descargar», the progress and «Instalado · N MB». The island already knows and downloads it, so the page only reads
     `voice_action {action:'status'}`, listens to its `voice-model` event and asks for a download on a CLICK. A download
     is a large transfer over the network: it never starts on its own, and the page never sends a URL, a path or a file
     name — only the catalog id it read from the status reply.
   - NOT here: the per-Minikoda model selector of artboard 06 lives with artboards 04/05 (the list and the creation card).
     The page draws what the island reports about the local model and nothing more: the daemon's `local: available|unavailable`
     (the bundled helper) keeps today's note, so a missing helper is never blamed on the model.
   - The closed host verbs are the existing `agent_action` (src/agentclient.rs's allowlist) and the existing `voice_action`
     (src/voicehost.rs, admitted for the main window). The page asks eight `agent_action` verbs, `voice_action {action:'status'}`
     and — only from a click — `{action:'download_model'}` and `{action:'model_download', id}`. Nothing else.

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
    telegram_session_invalid: 'Telegram cerró esa sesión (o la revocaste desde el teléfono). La sesión guardada ya no sirve: volvé a conectar.',
    telegram_cancelled: 'El pedido se canceló. Podés empezar de nuevo cuando quieras.',
    telegram_login_other_connection: 'El ingreso lo empezó otra ventana y sólo esa puede terminarlo. Cerrá la otra ventana de Ajustes y volvé a conectar desde acá.',
    telegram_failed: 'Telegram no completó el pedido. Probá de nuevo en un momento.',
    telegram_forget_failed: 'La cuenta quedó desconectada, pero no se pudo borrar la sesión guardada del llavero de tu sistema. Probá de nuevo en un momento o borrala a mano.',
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
   * The folded `telegram` view + the host's two booleans → what the card draws. The step is derived from the daemon's
   * state and nothing else: the page never claims a step the daemon did not reach. `credentials` says the three values
   * exist in the keychain; `stored` says the session THIS connection received really went in (F3) — the host resolves the
   * «nothing arrived, the stored session is the one in use» case itself, so the page only ever sees a boolean.
   */
  function telegramView(view, credentials, stored) {
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
      sessionStored: stored === true,
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
  /**
   * What «conectado» means for the keychain, from the HOST's own verdict (`telegramSessionStored`), never from the fact that
   * the daemon says connected: storing the session can fail (a locked keychain, a session too long for one entry) and the
   * old card claimed it had worked anyway.
   */
  function connectedSentence(stored) {
    return stored === true
      ? 'Telegram conectado. La sesión quedó en el llavero de tu sistema.'
      : 'Conectado, pero no se pudo guardar la sesión en el llavero: al reiniciar tendrás que entrar de nuevo.';
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
  // ---- the transcription model's own state (T6b-3, artboard 06 frames 5-6) -------------------------------------
  // The island already knows and downloads the model. `voice_action {action:'status'}` (src/voicehost.rs status_json)
  // answers with the voice detector's and Parakeet's ModelState — `{state:'missing'}`, `{state:'downloading',fraction}`,
  // `{state:'ready'}` or `{state:'failed',error}` (src/speech/mod.rs ModelState) — plus the catalog with each `sizeMb`.
  // The detector is fetched by the id-less `{action:'download_model'}` (src/speech/wake.rs download) and a catalog entry
  // by `{action:'model_download', id}` (src/speech/mod.rs download_model). Transcription needs BOTH (src/speech/transcribe.rs
  // returns ModelMissing when the model or the detector is absent), so «Instalado» is said only when both are there.
  /** src/speech/catalog.rs DEFAULT_MODEL: the only local transcription model (S18), and the id the page may ask for. */
  const PARAKEET = 'parakeet-tdt-0.6b-v3-int8';
  /** The bound the host applies to a catalog id (frontend/settings-app.js too): never a URL, a path or a file name. */
  const MODEL_ID = /^[a-z0-9][a-z0-9.-]{0,39}$/;
  const MODEL_STATES = Object.freeze(['missing', 'downloading', 'ready', 'failed', 'unknown']);
  /** How long a download may go without a `voice-model` event before the card stops claiming it is progressing. */
  const MODEL_STALL_MS = 180000;
  const MB_MAX = 100000;
  // The host reports a failure as FREE TEXT (`ModelState::Failed { error }`, the downloader's own message), so a network
  // failure, a checksum mismatch and a full disk cannot be told apart from here: ONE sentence names the likely causes and
  // the host's text is never shown, parsed or copied.
  const MODEL_SENTENCES = Object.freeze({
    missing: 'Falta el modelo de transcripción: todavía no está descargado en esta PC.',
    downloading: 'Se está descargando el modelo. Mientras falta, los Minikodas que traen videos esperan: no hay transcripción a medias.',
    ready: 'Parakeet y el detector de voz están instalados en esta PC.',
    failed: 'La descarga del modelo no terminó. Puede haber sido la conexión o el espacio en disco: probá de nuevo.',
    stalled: 'La descarga del modelo dejó de avanzar y Koda no recibió novedades durante tres minutos: probá de nuevo.',
    unknown: 'No se pudo leer el estado del modelo de transcripción.',
  });
  /** A size in MB the island reported, or null: nothing is drawn from a guess. */
  const megabytes = value => (Number.isInteger(value) && value > 0 && value <= MB_MAX ? value : null);
  /** One ModelState → `{kind}` / `{kind, fraction}`, or null when it is not one of the four the host sends. */
  function modelState(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const kind = value.state;
    if (kind === 'missing' || kind === 'ready' || kind === 'failed') return { kind };
    if (kind !== 'downloading') return null;
    const raw = typeof value.fraction === 'number' && Number.isFinite(value.fraction) ? value.fraction : 0;
    return { kind, fraction: Math.min(1, Math.max(0, raw)) };
  }
  /** The catalog entry the page may ask for, read from the reply: it has to BE the local model and look like an id. */
  function modelEntry(reply) {
    const speech = reply && typeof reply === 'object' ? reply.speech : null;
    const models = speech && typeof speech === 'object' && Array.isArray(speech.models) ? speech.models : null;
    if (!models) return null;
    for (const row of models) {
      if (!row || typeof row !== 'object') continue;
      const id = row.id;
      // `id !== PARAKEET` is the whole allowlist (S18 has one local model); the regex is belt and braces so a URL, a path
      // or a file name can never travel even if the island's own list were wrong.
      if (typeof id !== 'string' || id !== PARAKEET || !MODEL_ID.test(id)) continue;
      return Object.freeze({ id, sizeMb: megabytes(row.sizeMb) });
    }
    return null;
  }
  function modelViewOf(state, extra) {
    const sizeMb = extra && Number.isInteger(extra.sizeMb) ? extra.sizeMb : null;
    const percent = state === 'downloading' && Number.isInteger(extra.percent) ? extra.percent : null;
    const doneMb = state === 'downloading' && Number.isInteger(extra.doneMb) ? extra.doneMb : null;
    const size = sizeMb === null ? '' : ` · ${sizeMb} MB`;
    const stalled = extra && extra.stalled === true;
    return Object.freeze({
      state,
      sizeMb,
      percent,
      doneMb,
      parakeetReady: extra && extra.parakeetReady === true,
      vadReady: extra && extra.vadReady === true,
      canDownload: state === 'missing',
      canRetry: state === 'failed',
      stalled,
      // the artboard's wording: «Falta · N MB» / «Descargando · N %» / «Instalado · N MB» / «Falló»
      pill: state === 'missing' ? `Falta${size}` : state === 'ready' ? `Instalado${size}` : state === 'downloading' ? `Descargando · ${percent} %` : state === 'failed' ? 'Falló' : '',
      // and the progress line, without the speed text the artboard draws and nobody reports
      detail: state === 'downloading' ? (sizeMb === null ? `${percent} %` : `${percent} % · ${doneMb} de ${sizeMb} MB`) : '',
      sentence: state === 'failed' ? (stalled ? MODEL_SENTENCES.stalled : MODEL_SENTENCES.failed) : MODEL_SENTENCES[state] || MODEL_SENTENCES.unknown,
    });
  }
  /**
   * The status reply (+ how long since the last `voice-model` event) → the small closed view the card draws. Anything the
   * host did not say clearly is `unknown`; the host's own error text is never read.
   */
  function modelView(reply, options) {
    const parakeet = modelState(reply && reply.parakeet);
    const detector = modelState(reply && reply.vad);
    if (!parakeet || !detector) return modelViewOf('unknown', {});
    const entry = modelEntry(reply);
    const parakeetReady = parakeet.kind === 'ready';
    const vadReady = detector.kind === 'ready';
    const vadMb = megabytes(reply && reply.downloadMb);
    const waited = options && typeof options.waitedMs === 'number' && Number.isFinite(options.waitedMs) && options.waitedMs > 0 ? options.waitedMs : 0;
    // the size of what is still to come: the model while it lacks, the detector when only the detector lacks
    const sizeMb = parakeetReady ? (vadReady ? (entry ? entry.sizeMb : null) : vadMb) : entry ? entry.sizeMb : null;
    const moving = parakeet.kind === 'downloading' ? parakeet : detector.kind === 'downloading' ? detector : null;
    const ready = parakeetReady && vadReady;
    const facts = { sizeMb, parakeetReady, vadReady };
    if (moving) {
      const total = parakeet.kind === 'downloading' ? (entry ? entry.sizeMb : null) : vadMb;
      const percent = Math.min(100, Math.max(0, Math.round(moving.fraction * 100)));
      // a download that went quiet past the budget is a failure with a retry, never an endless «descargando»
      if (waited >= MODEL_STALL_MS) return modelViewOf('failed', { ...facts, sizeMb: total, stalled: true });
      const done = total === null ? null : Math.min(total, Math.round(moving.fraction * total));
      return modelViewOf('downloading', { ...facts, sizeMb: total, percent, doneMb: done });
    }
    if (parakeet.kind === 'failed' || detector.kind === 'failed') return modelViewOf('failed', facts);
    if (ready) return modelViewOf('ready', { ...facts, sizeMb: entry ? entry.sizeMb : null });
    return modelViewOf('missing', facts);
  }
  /** `{action:'model_download', id}` for the local model, or null: the id is always the one read from the reply. */
  function modelDownloadPayload(reply) {
    const view = modelView(reply);
    if (view.parakeetReady || (view.state !== 'missing' && view.state !== 'failed')) return null;
    const entry = modelEntry(reply);
    return entry ? Object.freeze({ action: 'model_download', id: entry.id }) : null;
  }
  /** `{action:'download_model'}`: the voice detector, the fixed id-less verb (src/speech/wake.rs download). */
  function vadDownloadPayload(reply) {
    const view = modelView(reply);
    if (view.vadReady || (view.state !== 'missing' && view.state !== 'failed')) return null;
    return Object.freeze({ action: 'download_model' });
  }
  /**
   * Everything one click asks for, in order, or null when there is nothing to ask — and also null when the reply does not
   * carry the catalog entry, so a URL, a path or an unknown id can never produce a host call at all.
   */
  function downloadPayloads(reply) {
    if (!modelEntry(reply)) return null;
    const model = modelDownloadPayload(reply);
    const vad = vadDownloadPayload(reply);
    const out = [];
    if (model) out.push(model);
    if (vad) out.push(vad);
    return out.length ? Object.freeze(out) : null;
  }

  /**
   * What a click on the model button must do, from the last status reply and how long the page has heard nothing.
   * `download`: the closed payloads, built from the host's own catalog entry. `reread`: the host still calls the download
   * «in flight» but the card already says it failed (the stall budget passed), so the click asks for the status again and
   * never starts a second download behind a download the host may still be running. `none`: nothing honest to ask.
   */
  function modelClickAction(reply, waitedMs) {
    const view = modelView(reply, { waitedMs });
    if (view.state === 'failed' && view.stalled) return Object.freeze({ kind: 'reread' });
    const payloads = downloadPayloads(reply);
    return payloads ? Object.freeze({ kind: 'download', payloads }) : Object.freeze({ kind: 'none' });
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
    errorSentence, telegramView, accountLine, connectedSentence,
    apiIdProblem, apiHashProblem, phoneProblem, codeProblem, passwordProblem, modelProblem,
    loginStartPayload, codePayload, passwordPayload,
    PARAKEET, MODEL_STATES, MODEL_STALL_MS, MODEL_SENTENCES, modelView, modelEntry,
    modelDownloadPayload, vadDownloadPayload, downloadPayloads, modelClickAction,
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
  // The model state comes from the island's own closed voice verb (src/voicehost.rs voice_action): no new command.
  const callVoice = payload => invoke('voice_action', { payload });
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };

  let agentState = null;
  let credentials = false;
  let sessionStored = false;
  let telegram = api.telegramView(null, false);
  let transcription = api.transcriptionView(null, []);
  let note = null;        // { tone: 'go'|'sun'|'red', say } — a sentence of OURS
  let busy = false;
  // The number of the login in flight. The phone FIELD is emptied as soon as the login starts, so «Pedir otro» needs this
  // copy; it is dropped when the login ends. The field's placeholder is an example, never a number to dial.
  let loginPhone = '';
  // the model state: the last status reply, and when the last sign of life from a download arrived (the stall budget)
  let modelStatus = null;
  let modelAsked = false;   // the card has asked the island at least once: before that, nothing is claimed
  let modelWait = 0;
  let modelTimer = 0;
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
    if (key === 'password') { field.type = 'password'; field.autocomplete = 'off'; field.maxLength = api.PASSWORD_MAX; field.placeholder = 'Tu contraseña de dos pasos'; }
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
  // The local model's own state (artboard 06 frames 5-6): the pill and «Descargar» ride on the local option, the progress
  // and the explanation sit under the group. A download is a large transfer: it only ever leaves on a click.
  const modelAct = el('span', 'srow-actions');
  const modelPill = el('span', 'snote', ''); modelPill.id = 'transcription-model-pill';
  const modelBtn = el('button', 'sbtn', 'Descargar'); modelBtn.type = 'button'; modelBtn.id = 'transcription-model-download';
  modelBtn.setAttribute('aria-describedby', 'transcription-model-note');
  modelAct.append(modelPill, modelBtn);
  localRow.append(modelAct);
  // No `role="status"` here on purpose: the section already has its one live region (`#minikodas-live`), and a progress
  // line that changes with every chunk would be announced over and over.
  const trModelNote = el('p', 'snote'); trModelNote.id = 'transcription-model-note';
  const trLocalNote = el('p', 'snote'); trLocalNote.id = 'transcription-local-note';
  const trProblem = el('p', 'snote'); trProblem.id = 'transcription-problem'; trProblem.setAttribute('role', 'status');
  tr.append(group, trModelNote, trLocalNote, trProblem);
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
  /**
   * The model row, drawn from the pure view of the last status reply. The only clock here is the stall budget: the view
   * stops saying «descargando» once no `voice-model` event has arrived in `MODEL_STALL_MS`, so nothing spins forever.
   */
  function modelNow() {
    return api.modelView(modelStatus, { waitedMs: modelWait ? Date.now() - modelWait : 0 });
  }
  function paintModel() {
    const v = modelNow();
    // Before the first answer (and with the card still hidden) nothing is drawn: an unseen card does not claim a failure.
    if (!modelAsked) {
      modelPill.hidden = true;
      trModelNote.hidden = true;
      modelBtn.hidden = true;
      return;
    }
    modelPill.textContent = v.pill;
    modelPill.hidden = !v.pill;
    // the progress line while it downloads, the honest sentence otherwise (missing, failed, unreadable)
    trModelNote.textContent = v.detail || v.sentence;
    trModelNote.hidden = !trModelNote.textContent;
    // «Descargar» when it lacks, «Reintentar» after a failure, nothing when it is installed or unreadable
    modelBtn.hidden = !(v.canDownload || v.canRetry);
    modelBtn.textContent = v.canRetry ? 'Reintentar' : 'Descargar';
    modelBtn.disabled = busy;
    if (v.state === 'downloading') armModelWatch();
  }
  /** One timer, re-armed by each event: the page never polls the host for progress. */
  function armModelWatch() {
    clearTimeout(modelTimer);
    modelTimer = 0;
    if (modelNow().state !== 'downloading') return;
    // What is LEFT of the budget since the last sign of life: arming a fresh one on every repaint would let an unrelated
    // event (the agent's state, say) postpone the stall forever.
    modelTimer = setTimeout(() => {
      modelTimer = 0;
      paint();
    }, Math.max(0, api.MODEL_STALL_MS - (Date.now() - modelWait)));
  }
  /** A status reply, or the payload of the island's `voice-model` event (the same JSON, src/voicehost.rs). */
  function applyModel(reply) {
    if (!reply || typeof reply !== 'object') return;
    modelStatus = reply;
    modelAsked = true;
    modelWait = Date.now();     // progress resets the stall budget, because it is a sign of life
    paint();
  }
  function paint() {
    paintTelegram();
    paintTranscription();
    paintModel();
  }

  // ---- talking to the host ------------------------------------------------------------------------------------
  function apply(next) {
    if (!next || typeof next !== 'object') return;
    agentState = next;
    credentials = next.telegramCredentials === true;
    sessionStored = next.telegramSessionStored === true;
    telegram = api.telegramView(next.telegram, credentials, sessionStored);
    // N6: the kept number belongs to a login IN FLIGHT. The folded step is null only once the account is connected, so this
    // drops it when a login succeeds, including one another window completed. A login that ends back at «disconnected»
    // keeps it until the next telegram_login_start overwrites it; that is harmless because «Pedir otro» is only enabled at
    // the code step, where the number is the one of the login in flight.
    if (telegram.step === null) loginPhone = '';
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
      // F3: the keychain sentence is the host's verdict, never the fact that the daemon says connected
      note = { tone: telegram.sessionStored ? 'go' : 'sun', say: api.connectedSentence(telegram.sessionStored) };
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
      if (telegram.connected || payload.action === 'telegram_logout') loginPhone = '';
      paint();
    }, error => {
      busy = false; clearTimeout(timer);
      // a rejected request must not leave a secret sitting in the page either
      if (payload.action === 'telegram_login_password') stepNodes.password.field.value = '';
      if (payload.action === 'telegram_login_code') stepNodes.code.field.value = '';
      if (payload.action === 'telegram_login_start') { stepNodes.phone.field.value = ''; hashInput.value = ''; }
      if (payload.action === 'telegram_login_start' || payload.action === 'telegram_logout') loginPhone = '';
      // F8: the host refuses with a CLOSED code (e.g. a logout whose keychain delete failed). Our sentence for that code,
      // never the host's or the keychain's own text, and the generic one when the code is one we do not know.
      const code = error && typeof error.code === 'string' ? error.code : '';
      note = { tone: 'red', say: code ? api.errorSentence(code, null) : 'No se pudo completar el pedido.' };
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
    loginPhone = payload.phone;
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
    const payload = api.loginStartPayload(idInput.value, hashInput.value, loginPhone);
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
  // The download: a real click, and only the closed payloads the pure builder produced from the status reply we read
  // (the catalog id and the id-less detector verb). Nothing else is ever sent.
  modelBtn.addEventListener('click', e => {
    if (e.isTrusted !== true) return;
    // The button rides on the local option, which is a <label>: without this, the click would also pick the radio and save
    // the setting. The default action of the click is cancelled, the download itself is not.
    e.preventDefault();
    const action = api.modelClickAction(modelStatus, modelWait ? Date.now() - modelWait : 0);
    if (action.kind === 'reread') {
      // a stalled download: ask the host what it says now; a real failure or a missing model comes back as a state with its own button
      callVoice({ action: 'status' }).then(reply => { modelWait = Date.now(); applyModel(reply); }, () => { modelStatus = null; paint(); });
      return;
    }
    const payloads = action.kind === 'download' ? action.payloads : null;
    if (!payloads) {
      // nothing we could honestly ask for: no id read from the island, or nothing to download
      note = { tone: 'sun', say: api.MODEL_SENTENCES.unknown };
      paint();
      return;
    }
    modelWait = Date.now();
    note = { tone: 'sun', say: api.MODEL_SENTENCES.downloading };
    paint();
    let chain = Promise.resolve();
    for (const payload of payloads) {
      chain = chain.then(() => callVoice(payload).then(applyModel, error => {
        // the host refuses with a CLOSED code (src/voicehost.rs err), never with free text
        const code = error && typeof error.code === 'string' ? error.code : '';
        note = { tone: 'red', say: code ? api.errorSentence(code, null) : api.MODEL_SENTENCES.failed };
        paint();
      }));
    }
  });

  if (listen) {
    const fail = name => error => console.error(`minikodas: live ${name} events unavailable`, error);
    listen('agent:state', e => apply(e && e.payload)).catch(fail('agent:state'));
    listen('voice-model', e => applyModel(e && e.payload)).catch(fail('voice-model'));
  }
  // The read happens when the card is SHOWN, never at island start: the island page loads with Ajustes closed, and a
  // hidden card has no business opening the daemon's socket. The panel re-appends this section on its own tab
  // (settings.js re-appends it, it never rebuilds it), so the observer sees exactly the transitions that matter.
  let shown = false;
  function read() {
    call({ action: 'view' }).then(next => { shown = true; apply(next); }, () => {
      live.textContent = 'No se pudo leer el estado de Telegram ni el de la transcripción.';
    });
    // the model state is read once, here, when the card is shown: a hidden card has no business asking, and nothing polls
    modelAsked = true;
    callVoice({ action: 'status' }).then(applyModel, () => { modelStatus = null; paint(); });
  }
  const observer = new MutationObserver(() => { if (!host.hidden && !shown) read(); else if (host.hidden) shown = false; });
  observer.observe(host, { attributes: true, attributeFilter: ['hidden'] });
  if (!host.hidden) read();
  paint();
}
