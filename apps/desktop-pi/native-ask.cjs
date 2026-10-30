'use strict';
// Native ask interception (path B: gentle-pi is NOT touched). Pi's own `ask_user_choice` and `ask_user_question`
// are answered from Abito OR the terminal; the first answer wins and the other side is withdrawn. The `tool_call`
// hook BLOCKS the native call with the exact text the native tool would have returned, so the model sees a tool
// error carrying the right words (a blocked call cannot be rewritten into a success through the public API).
// Anything uncertain is NOT intercepted: the native tool then runs untouched.
//
// A request is a list of ITEMS (one for ask_user_choice / a plain question, one to four for a questionnaire).
// Abito answers the whole request at once; the terminal asks the items in order. Partial answers are never mixed:
// whoever finishes first provides ALL the answers, the other side is discarded.
const { normalizeRequest } = require('./questions.cjs');

const CHOICE = 'ask_user_choice', QUESTIONNAIRE = 'ask_user_question';
const OTHER_ROW = 'Other…', CUSTOM_ROW = 'Type something.', DONE_ROW = 'Done';

// SECURITY: what stays terminal-only is decided by the SAME classifier as the HU-042 confirm route (sensitiveText, defined
// below) in its 'ask' mode, plus a few hard markers. A false positive only means the native terminal dialog runs as today.
const isSensitive = value => typeof value === 'string' && isSensitiveAsk([value], false);
// gentle-ai review consent envelopes: refused wherever they appear in the call (keys, values, texts).
// separators and case are ignored: «consent-binding», «Consent_Binding», «gentle-ai.review_integration» all count.
const CONSENT_MARKER = /consentbinding|gentleaireviewintegration/;
const hasConsentMarker = value => CONSENT_MARKER.test(JSON.stringify(value).toLowerCase().replace(/[^a-z0-9]/g, ''));
// Values that read as plain words (`yes-once`, `main`, `dev_2`); opaque ids, hex, JSON or digit runs do not.
const PLAIN_VALUE = /^[A-Za-z][A-Za-z0-9]*(?:[-_ .][A-Za-z0-9]+)*$/;
const plainValue = v => typeof v === 'string' && v.length <= 32 && PLAIN_VALUE.test(v) &&
  !/\d{4,}/.test(v) && !/^[0-9a-f]{12,}$/i.test(v) && !isSensitive(v);

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = v => (typeof v === 'string' ? v : null);
const rowOf = c => (c.description ? `${c.label} — ${c.description}` : c.label);

// ---- what is asked --------------------------------------------------------------------------------------
// plan = { items, form, simple, scan, render(answers), cancelled }
//  item = { title, question, header, choices[{label, description, value?}], multi, free, freeRow }
//  answers[i] = {kind:'option',index} | {kind:'options',indexes,text?} | {kind:'custom',text}
function planChoice(input) {
  if (!isObject(input) || !Array.isArray(input.options)) return null;
  const question = str(input.question);
  if (question === null) return null;
  const choices = [];
  for (const o of input.options) {
    if (!isObject(o) || str(o.label) === null || str(o.description) === null || !plainValue(o.value)) return null;
    choices.push({ label: o.label, description: o.description, value: o.value });
  }
  const item = { title: question, question, header: '', choices, multi: false, free: input.allowCustomResponse === true, freeRow: OTHER_ROW };
  return {
    items: [item], form: false, simple: true,
    scan: [question, ...choices.flatMap(c => [c.label, c.description])],
    render: ([a]) => (a.kind === 'custom' ? `User responded: ${a.text}`
      : `User selected: ${a.index + 1}. ${choices[a.index].label} (value: ${choices[a.index].value})`),
    cancelled: 'User cancelled the choice',
  };
}

function planQuestionnaire(input) {
  if (!isObject(input) || !Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 4) return null;
  const items = [], scan = [];
  for (const q of input.questions) {
    if (!isObject(q) || str(q.question) === null || str(q.header) === null || [...q.header].length > 32 || !Array.isArray(q.options)) return null;
    const choices = [];
    for (const o of q.options) {
      if (!isObject(o) || str(o.label) === null) return null;
      choices.push({ label: o.label, description: str(o.description) ?? '' });
    }
    items.push({ title: `${q.header}: ${q.question}`, question: q.question, header: q.header, choices, multi: q.multiSelect === true, free: true, freeRow: CUSTOM_ROW });
    scan.push(q.question, q.header, ...q.options.flatMap(o => [o.label, o.description, o.preview].filter(v => typeof v === 'string')));
  }
  const body = (item, a) => {
    if (a.kind === 'option') return item.choices[a.index].label;
    if (a.kind === 'custom') return `(custom) ${a.text}`;
    const picked = a.indexes.map(i => item.choices[i].label);
    if (a.kind === 'options') return a.text === undefined ? `selected: ${picked.join(', ')}`
      : picked.length ? `(custom) ${a.text} — selected: ${picked.join(', ')}` : `(custom) ${a.text}`;
    return `(custom) ${a.text}`;
  };
  return {
    items, form: items.length > 1, simple: items.length === 1 && !items[0].multi, scan,
    render: answers => answers.map((a, i) => `${i + 1}. ${items[i].question} — ${body(items[i], a)}`).join('\n'),
    cancelled: 'User cancelled the questionnaire',
  };
}

// ---- telling the human what happened -----------------------------------------------------------------------
// Pi paints a blocked call with gentle-pi's own renderResult, which prints «Cancelled» when the result carries no
// selection (a block yields `details: {}`), and the public API cannot change that row: `tool_result` does not run
// for blocked calls and the live row is drawn from `tool_execution_end`. So the human is told who answered and what
// with ONE info notification (a dim line under the row). Display only: never persisted, never seen by the model.
const NOTE_MAX = 200;
const clip = text => (text.length <= NOTE_MAX ? text : `${text.slice(0, NOTE_MAX - 1)}…`);
function summarize(plan, answers) {
  const one = (item, a) => {
    if (a.kind === 'option') return item.choices[a.index].label;
    if (a.kind === 'custom') return a.text;
    return [...a.indexes.map(i => item.choices[i].label), ...(a.text === undefined ? [] : [a.text])].join(', ');
  };
  if (plan.items.length === 1) return one(plan.items[0], answers[0]);
  return answers.map((a, i) => `${plan.items[i].header || i + 1}: ${one(plan.items[i], a)}`).join(' · ');
}
function tell(ctx, text) {
  try { if (typeof ctx?.ui?.notify === 'function') ctx.ui.notify(clip(text), 'info'); } catch { /* display only */ }
}

// ---- the Abito side ---------------------------------------------------------------------------------------
// Synthetic values o1..o4, never the originals; Abito's own text/size rules decide eligibility.
const synth = choices => choices.map((c, i) => ({ value: `o${i + 1}`, label: c.label, description: c.description }));
function abitoRequest(plan, structured) {
  let request;
  if (plan.simple) {
    const [item] = plan.items;
    request = { kind: 'question', text: item.question, allowFreeText: item.free, options: synth(item.choices) };
  } else {
    if (!structured) return null;
    if (plan.form) {
      request = { kind: 'question', text: plan.items.length === 1 ? plan.items[0].question : plan.items.map(i => i.header).join(' · '), options: [], allowFreeText: false,
        questions: plan.items.map(i => ({ header: i.header, text: i.question, options: synth(i.choices), multiSelect: i.multi, allowFreeText: i.free })) };
    } else {
      const [item] = plan.items;
      request = { kind: 'question', text: item.question, allowFreeText: item.free, options: synth(item.choices), multiSelect: true };
    }
  }
  try { normalizeRequest(request, undefined, structured); } catch { return null; }
  return request;
}

const indexOfSynth = (v, n) => { const m = typeof v === 'string' ? /^o([1-4])$/.exec(v) : null; return m && Number(m[1]) <= n ? Number(m[1]) - 1 : -1; };
// One Abito answer for one item, checked against what was asked. null = does not fit.
function decodeItem(item, a) {
  if (!isObject(a)) return null;
  if (item.multi) {
    if (a.type !== 'options' || !Array.isArray(a.values)) return null;
    const indexes = a.values.map(v => indexOfSynth(v, item.choices.length));
    if (indexes.some(i => i < 0) || new Set(indexes).size !== indexes.length) return null;
    if (a.text !== undefined && !(item.free && typeof a.text === 'string' && a.text.trim())) return null;
    if (!indexes.length && a.text === undefined) return null;
    return { kind: 'options', indexes: [...indexes].sort((x, y) => x - y), ...(a.text === undefined ? {} : { text: a.text }) };
  }
  if (a.type === 'option') { const i = indexOfSynth(a.value, item.choices.length); return i < 0 ? null : { kind: 'option', index: i }; }
  if (a.type === 'text' && item.free && typeof a.text === 'string' && a.text.trim()) return { kind: 'custom', text: a.text };
  return null;
}
function decodeAbito(plan, a) {
  if (plan.form) {
    if (!isObject(a) || a.type !== 'form' || !Array.isArray(a.answers) || a.answers.length !== plan.items.length) return null;
    const out = plan.items.map((item, i) => decodeItem(item, a.answers[i]));
    return out.every(Boolean) ? out : null;
  }
  const one = decodeItem(plan.items[0], a);
  return one ? [one] : null;
}

// ---- the terminal side ------------------------------------------------------------------------------------
// One item through ctx.ui.select / ctx.ui.input. undefined = cancelled; the shared signal aborts every dialog.
async function askItem(ctx, item, signal) {
  const display = item.choices.map(rowOf);
  if (!item.multi) {
    const picked = await ctx.ui.select(item.title, item.free ? [...display, item.freeRow] : display, { signal });
    if (picked === undefined || signal.aborted) return undefined;
    if (item.free && picked === item.freeRow) {
      const text = await ctx.ui.input(item.title, 'Type your response', { signal });
      return text === undefined || signal.aborted ? undefined : { kind: 'custom', text };
    }
    const index = display.indexOf(picked);
    return index < 0 ? undefined : { kind: 'option', index };
  }
  // multiSelect: toggle rounds, like gentle-pi's own RPC dialogs; «Done» (or every row on) commits.
  const toggled = display.map(() => false);
  const cap = Math.max(32, display.length + 4);
  for (let round = 0; round < cap; round++) {
    const rows = display.map((row, i) => `${toggled[i] ? '[x]' : '[ ]'} ${row}`);
    const picked = await ctx.ui.select(item.title, [...rows, ...(item.free ? [item.freeRow] : []), DONE_ROW], { signal });
    if (picked === undefined || signal.aborted) return undefined;
    const indexes = () => toggled.flatMap((on, i) => (on ? [i] : []));
    if (picked === DONE_ROW) return { kind: 'options', indexes: indexes() };
    if (item.free && picked === item.freeRow) {
      const text = await ctx.ui.input(item.title, 'Type your response', { signal });
      return text === undefined || signal.aborted ? undefined : { kind: 'options', indexes: indexes(), text };
    }
    const at = rows.indexOf(picked);
    if (at < 0) return undefined; // unrecognised answer: never commit a partial state
    toggled[at] = !toggled[at];
    if (toggled.every(Boolean)) return { kind: 'options', indexes: indexes() };
  }
  return undefined;
}

// One race. Resolves with {kind:'done', answers} | {kind:'cancelled'} | {kind:'fallthrough'}.
// Abito failing (busy, expired, disconnected...) never answers and never ends the race: the terminal dialogs keep
// waiting indefinitely. Only a human decision from either side decides, and always for ALL the items at once.
function race({ controller, ctx, plan, request }) {
  return new Promise(resolve => {
    let decided = false;
    const abito = new AbortController(), terminal = new AbortController();
    const finish = (selection, winner) => {
      if (decided) return;
      decided = true;
      ctx.signal?.removeEventListener('abort', onRunAborted);
      if (winner !== 'abito') abito.abort();
      if (winner !== 'terminal') terminal.abort();
      resolve({ ...selection, by: winner });
    };
    const onRunAborted = () => finish({ kind: 'cancelled' });
    if (ctx.signal?.aborted) { resolve({ kind: 'cancelled' }); return; }
    ctx.signal?.addEventListener('abort', onRunAborted, { once: true });

    Promise.resolve(controller.ask(request, ctx, abito.signal)).then(result => {
      if (decided || !result) return;
      if (result.status === 'human_cancelled') { finish({ kind: 'cancelled' }, 'abito'); return; }
      if (result.status !== 'answered') return; // failure: the terminal keeps waiting
      const answers = decodeAbito(plan, result.answer);
      if (answers) finish({ kind: 'done', answers }, 'abito');
    }, () => {});

    (async () => {
      const answers = [];
      for (const item of plan.items) {
        const a = await askItem(ctx, item, terminal.signal);
        if (decided || terminal.signal.aborted) return;
        if (a === undefined) { finish({ kind: 'cancelled' }, 'terminal'); return; }
        answers.push(a);
      }
      finish({ kind: 'done', answers }, 'terminal');
    })().catch(() => finish({ kind: 'fallthrough' }, 'terminal')); // the terminal cannot ask: let the native tool run
  });
}

/**
 * @param {{ controller?: any, env?: Record<string, string | undefined> }} [options]
 * @returns {(event: any, ctx: any) => Promise<{ block: true, reason: string } | undefined>}
 */
function createNativeAskHandler({ controller, env = process.env } = {}) {
  return async function onToolCall(event, ctx) {
    try {
      if (env.ABITO_NATIVE_ASK === '0' || !event) return undefined;
      const plan = event.toolName === CHOICE ? planChoice(event.input)
        : event.toolName === QUESTIONNAIRE ? planQuestionnaire(event.input) : null;
      if (!plan || hasConsentMarker(event.input) || isSensitiveAsk(plan.scan, plan.items.some(i => i.free))) return undefined;
      for (const item of plan.items) {
        if (new Set(item.choices.map(rowOf)).size !== item.choices.length) return undefined;
        if (item.free && [item.freeRow, DONE_ROW].some(r => item.choices.some(c => rowOf(c) === r))) return undefined;
      }
      if (ctx?.hasUI === false || typeof ctx?.ui?.select !== 'function' || typeof ctx.ui.input !== 'function') return undefined;
      if (!controller || typeof controller.canAsk !== 'function' || !controller.canAsk()) return undefined;
      const request = abitoRequest(plan, typeof controller.structured === 'function' && controller.structured() === true);
      if (!request) return undefined;
      const selection = await race({ controller, ctx, plan, request });
      if (selection.kind === 'fallthrough') return undefined;
      const where = selection.by === 'abito' ? 'Koda' : selection.by === 'terminal' ? 'la terminal' : null;
      if (where && selection.kind === 'done') tell(ctx, `Respondido en ${where}: ${summarize(plan, selection.answers)}`);
      else if (where) tell(ctx, `Cancelado en ${where}`);
      return { block: true, reason: selection.kind === 'done' ? plan.render(selection.answers) : plan.cancelled };
    } catch { return undefined; }
  };
}

// ---- HU-042: Pi's yes/no confirmations (ctx.ui.confirm) --------------------------------------------------
// Human decision (verbatim option chosen): «Cualquier confirmación sí/no que no sea sensible». Any ctx.ui.confirm
// (e.g. gentle-pi's «Allow guarded forced git branch deletion?») is answerable from Abito OR the terminal; the first
// answer wins and the other side is withdrawn. Only confirm (two answers) is wrapped, never select/input/editor.
// SECURITY: the sensitive side is a DENYLIST that fails closed. A match, or a title/preview that cannot be bounded
// and decoded cleanly, means the original terminal confirm runs UNCHANGED and nothing leaves Pi. There is no
// redaction: what is sent is the title + preview verbatim, so the human sees exactly what they approve.
// Abito returns true ONLY on an explicit «Sí» answer; expiry, busy, disconnect or any error never decides.
// SECURITY (hardened after independent verification mvqtg5jk-9-9dt9): two layers, both fail closed.
// 1) SHOWABLE: a text is only sent if every character can be shown honestly — printable ASCII, a closed punctuation set,
//    or a letter that is canonically an ASCII letter plus accents (á, ñ, ü…). This refuses homoglyphs (Cyrillic, fullwidth,
//    ŧ/ø/ı), invisible/format characters (soft hyphen, ZW*, variation selectors, U+FFF9), combining marks, NBSP, tabs and
//    C0/C1 controls, NEL and line/paragraph separators. Refused text means terminal-only, never redaction.
// 2) DENYLIST on a normalised form: accents stripped, lowercased, leetspeak folded (0→o, 1→i/l, 3→e, 4→a, 5→s, 7→t,
//    @→a, $→s, !→i, |→i), separators removed, so «pass word», «log_in», «t0ken» or «ReviewRDD» still match. Plus
//    userinfo, known secret shapes and opaque-token rules on the raw text. False positives only mean the terminal asks.
const CONFIRM_PUNCT = new Set(['¡', '¿', '«', '»', '·', '°', '–', '—', '‘', '’', '“', '”', '…']);
const showableChar = (c, newline) => (c >= ' ' && c <= '~') || (newline && c === '\n') || CONFIRM_PUNCT.has(c) ||
  /^[A-Za-z]\p{M}+$/u.test(c.normalize('NFD'));
const showable = (v, newline) => { for (const c of v) if (!showableChar(c, newline)) return false; return true; };

const CONFIRM_WORDS = ['credential', 'credencial', 'creds', 'token', 'secret', 'password', 'passwd', 'pwd', 'passphrase', 'passcode', 'passkey',
  'contrasena', 'apikey', 'keychain', 'keyring', 'llave', 'login', 'logon', 'loggingin', 'loggedin', 'signin', 'signon', 'sesion',
  'oauth', 'authori', 'authent', 'autoriz', 'autentic', 'consent', 'grant', 'conced', 'permission', 'permiso', 'provider', 'proveedor',
  'review', 'revision', 'binding', 'envelope', 'lineage', 'receipt', 'maintenance', 'mantenimiento', 'reclaim', 'cookie'];
const CONFIRM_SHORT = new Set(['key', 'keys', 'clave', 'claves', 'rdd', 'otp', 'totp', 'mfa', 'auth', 'reauth', 'sso', 'pin']);
// Multi-valued look-alikes: a letter may be written with any of these («6rant», «lo9in», «8inding», «+oken», «(redential»).
const LOOKALIKE = { a: '4@', b: '68', c: '(<{[', d: ')', e: '3', g: '69', h: '#', i: '1!|', l: '1|i', o: '0', p: '>*', s: '5$', t: '7+', z: '2' };
const esc = s => s.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
const wordPattern = w => [...w].map(ch => `[${esc(ch)}${esc(LOOKALIKE[ch] || '')}]`).join('');
// The matchers are built by one function from a word list, so confirm and ask mode share every rule.
function buildMatchers(words) {
  const word = new RegExp(words.map(wordPattern).join('|'));
  // A run of 1-3 symbols inside a word may stand for ONE letter nobody listed («secre|2», «gr4n|2», «0a#th»): for every
  // word of 5+ letters, each position may also be such a run. Matched on a form that keeps every symbol.
  const SYMBOL_RUN = '[^a-z0-9\\s]{1,3}';
  const wild = new RegExp(words.filter(w => w.length >= 5).flatMap(w => [...w].map((_, i) =>
    [...w].map((ch, j) => (j === i ? SYMBOL_RUN : `[${esc(ch)}${esc(LOOKALIKE[ch] || '')}]`)).join(''))).join('|'));
  return { word, wild };
}
const CONFIRM_MATCH = buildMatchers(CONFIRM_WORDS);
const CONFIRM_WORD_RE = CONFIRM_MATCH.word, CONFIRM_WILD_RE = CONFIRM_MATCH.wild;
// ONE rule for ask_user_choice, ask_user_question AND the yes/no confirm (HU-042/HU-052): topic words drop out (permission,
// provider, grant, authori*, review…); words that only matter when
// the user is asked to TYPE a value (token, key, clave, api key) are judged by askedForValue instead.
// «consent» (and so «consentimiento») is NOT a topic word: a consent prompt stays terminal-only in both routes.
const ASK_TOPIC_WORDS = new Set(['permission', 'permiso', 'provider', 'proveedor', 'grant', 'conced', 'authori', 'autoriz', 'review', 'revision']);
const ASK_VALUE_WORDS = new Set(['token', 'apikey', 'llave']);
const ASK_VALUE_SHORT = new Set(['key', 'keys', 'clave', 'claves', 'cle', 'cles']);
// «gentle-ai» (separators are removed before matching, so «gentle ai» / «gentle-ai» both read «gentleai») marks the review / RDD /
// maintenance authorizations, which stay terminal-only; «RDD» is also read straight from the text, because the leetspeak fold
// turns «(RDD)» into «crdd».
const ASK_MATCH = buildMatchers([...CONFIRM_WORDS.filter(w => !ASK_TOPIC_WORDS.has(w) && !ASK_VALUE_WORDS.has(w)), 'gentleai',
  // secret VALUES named in other languages / as codes (nobody is ever asked to type these from the island)
  'passwort', 'senha', 'motdepasse', 'verificationcode', 'securitycode', 'codigodeverificacion', 'codigoverificacion', 'codigodeseguridad']);
const RDD_RE = /rdd/;
// “Token:”, “API key =”, “the token is”, “tu clave es” ask for the value without a verb.
const ASK_COLON_RE = /(?:token|key|clave|llave|cle)\s*[:=]/;
const ASK_IS_RE = /(?:token|key|clave|llave)\s+(?:is|es|=)\b/;
const ASK_SHORT = new Set([...CONFIRM_SHORT].filter(w => !ASK_VALUE_SHORT.has(w)));
const ASK_VALUE_RE = new RegExp([...ASK_VALUE_WORDS, 'clave'].map(wordPattern).join('|'));
const ASK_VERB_RE = /(?:^|[^a-z])(?:pega|pegas|pegue|ingresa|ingresas|ingrese|escribe|escribis|escriba|introduce|introduci|introduzca|input|put|share|pon|ponga|pone|digita|digite|tipea|indica|indique|enter|paste|type|provide|dame|dime|manda|mandame|pasa|pasas|pasame|proporciona|proporcione)(?![a-z])/;
// «key» inside a compound (privatekey, keystore, keyfile, keygen, sshkey…); only «keyboard» is let through.
const CONFIRM_KEY_RE = new RegExp(`${wordPattern('key')}(?!${wordPattern('board')})`);
const LEET = { 0: 'o', 2: 'z', 3: 'e', 4: 'a', 5: 's', 6: 'g', 7: 't', 8: 'b', 9: 'g', '@': 'a', $: 's', '!': 'i', '|': 'i', '+': 't', '(': 'c', '<': 'c' };
const stripMarks = v => v.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
// Encoded text is read as what it encodes: %XX (repeatedly, so %2540 → %40 → @), HTML numeric entities, \uXXXX / \xXX.
function decoded(v) {
  let out = v;
  for (let i = 0; i < 3; i++) {
    const next = out.replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#x([0-9a-f]{1,6});?/gi, (_, h) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)))
      .replace(/&#([0-9]{1,7});?/g, (_, d) => String.fromCodePoint(Math.min(Number(d), 0x10ffff)))
      .replace(/\\u\{?([0-9a-f]{4,6})\}?|\\x([0-9a-f]{2})/gi, (_, u, x) => String.fromCodePoint(Math.min(parseInt(u || x, 16), 0x10ffff)));
    if (next === out) break;
    out = next;
  }
  return out;
}
// Letters drawn with several symbols («|<» k, «|2» r, «|\|» n, «|v|» m, «\/» v, «|>» p) become the letter BEFORE separators are
// removed, and every remaining single symbol that stands for a letter is kept for the look-alike patterns.
const ASCII_ART = [[/\|v\||\/\\\/\\|\|\\\/\|/g, 'm'], [/\|\\\|/g, 'n'], [/\\\/\\\//g, 'w'], [/\\\//g, 'v'], [/\|</g, 'k'],
  [/\|2/g, 'r'], [/\|[>*°o]/g, 'p'], [/\|-\|/g, 'h'], [/\|\)/g, 'd']];
const artFold = v => ASCII_ART.reduce((s, [re, ch]) => s.replace(re, ch), v);
const folds = v => {
  const base = stripMarks(v);
  return ['i', 'l'].map(one => base.replace(/[0-9@$!|+(<]/g, c => (c === '1' ? one : LEET[c] ?? c)));
};
const SENSITIVE_RAW = [
  /:\S*@/, /\/\/[^\s/]*@/, /%(?:40|3a)/i,                                        // userinfo (user:token@host, //token@host, %40/%3A)
  /(?:^|[^a-z0-9])(?:sk|pk|rk)[-_][a-z0-9]|gh[pousr]_|github_pat_|xox[abprs]-|AKIA[0-9A-Z]{12}|bearer\s/i, // known secret shapes
  /(?:^|[^a-z0-9])2fa(?:[^a-z0-9]|$)/i,
];
const mixedCase = s => /[a-z]/.test(s) && /[A-Z]/.test(s) && /[0-9]/.test(s);
const opaqueWord = word => {
  for (const run of word.match(/[A-Za-z0-9]+/g) || []) {
    if (run.length >= 12 && mixedCase(run)) return true;                                // mixed-case id
    if (run.length >= 16 && /[0-9]/.test(run) && /[A-Za-z]/.test(run)) return true;     // letter+digit id
    if (run.length >= 12 && /^[0-9a-f]+$/i.test(run) && /[0-9]/.test(run)) return true; // hex / long digits
    if (run.length >= 12 && /[A-Za-z]/.test(run) && (run.match(/[0-9]/g) || []).length >= 3) return true; // lowercase letter+digit id
    if (run.length >= 20) return true;                                                   // letters-only blob
  }
  const joined = word.replace(/[^A-Za-z0-9]/g, '');                                      // split by - _ / + = . ~ :
  if (joined.length >= 16 && joined !== word && /^[0-9a-f]+$/i.test(joined) && /[0-9]/.test(joined)) return true; // dash-split hex
  return joined.length >= 12 && mixedCase(joined);
};
function sensitiveText(raw, ask = false) {
  const v = decoded(raw);
  if (SENSITIVE_RAW.some(re => re.test(v)) || v.split(/\s+/).some(opaqueWord)) return true;
  return sensitiveWords(raw, ask);
}
// The word half alone (denylist words and short words, obfuscation folded). Used on its own for text GLUED together from several
// fields, where an opaque-id or raw-shape check would only find the glue («ExtrasOnefirstTwoThree»).
function sensitiveWords(raw, ask) {
  const v = decoded(raw);
  // compact: decoded, ASCII-art letters folded, accents stripped, lower case, separators removed; every symbol that can
  // stand for a letter (LOOKALIKE) is kept, so nothing that reads as a letter is dropped unread.
  const compact = stripMarks(artFold(v)).replace(/[^a-z0-9@$!|+(<{[)#>*]/g, '');
  if (ask) {
    return ASK_MATCH.word.test(compact) || ASK_MATCH.wild.test(stripMarks(v).replace(/\s+/g, '')) || RDD_RE.test(compact) ||
      folds(v).some(f => f.split(/[^a-z]+/).some(t => ASK_SHORT.has(t)));
  }
  if (CONFIRM_WORD_RE.test(compact) || CONFIRM_KEY_RE.test(compact)) return true;
  if (CONFIRM_WILD_RE.test(stripMarks(v).replace(/\s+/g, ''))) return true;
  return folds(v).some(f => f.split(/[^a-z]+/).some(t => CONFIRM_SHORT.has(t)));
}
// Ask mode: does the text mention a token / key / clave / api key (obfuscation folded like the rest)?
function mentionsValueWord(raw) {
  const v = decoded(raw);
  const compact = stripMarks(artFold(v)).replace(/[^a-z0-9@$!|+(<{[)#>*]/g, '');
  return ASK_VALUE_RE.test(compact) || CONFIRM_KEY_RE.test(compact) ||
    folds(v).some(f => f.split(/[^a-z]+/).some(t => ASK_VALUE_SHORT.has(t)));
}
// ask_user_choice / ask_user_question: `texts` is everything the human would read, `freeText` whether free text is allowed.
// True = terminal-only. Same showable gate and denylist as confirm (ask mode), and a token/key word only counts when the
// text asks to type / paste / enter / provide a value, or when free text is allowed alongside it.
function isSensitiveAsk(texts, freeText) {
  if (!texts.every(t => typeof t === 'string' && showable(t, true))) return true;
  return sensitiveTexts(texts, freeText);
}
// The denylist half alone (the caller has already applied the showable gate that suits its own fields).
function sensitiveTexts(texts, freeText) {
  if (texts.some(t => sensitiveText(t, true))) return true;
  const all = texts.join('\n');
  // a word may be split across the fields the human reads together («Your pass» + «word»): the joined text is read too
  if (texts.length > 1 && (sensitiveWords(texts.join(''), true) || sensitiveWords(all, true))) return true;
  if (!mentionsValueWord(all)) return false;
  if (freeText === true) return true;
  const plain = stripMarks(decoded(all));
  return folds(plain).some(f => ASK_VERB_RE.test(f) || ASK_COLON_RE.test(f) || ASK_IS_RE.test(f));
}
// The yes/no confirm: same rule, no free text. The title is a single line, the message may have several.
const isSensitiveConfirm = (title, message) =>
  typeof title !== 'string' || typeof message !== 'string' || !showable(title, false) || !showable(message, true) ||
  sensitiveTexts([title, message], false);

const CONFIRM_TITLE_MAX = 200, CONFIRM_PREVIEW_MAX = 1200, CONFIRM_PREVIEW_LINES = 12;
const YES_NO = [{ value: 'yes', label: 'Sí', description: '' }, { value: 'no', label: 'No', description: '' }];

// The Abito request for one confirm, or null when it must stay terminal-only.
function confirmRequest(title, message, structured) {
  if (typeof title !== 'string' || typeof message !== 'string') return null;
  if (!title.trim() || [...title].length > CONFIRM_TITLE_MAX) return null;
  if ([...message].length > CONFIRM_PREVIEW_MAX || message.split('\n').length > CONFIRM_PREVIEW_LINES) return null;
  if (isSensitiveConfirm(title, message)) return null; // also refuses anything that is not showable verbatim
  const request = { kind: 'approval', text: message.trim() ? `${title}\n${message}` : title, options: YES_NO.map(o => ({ ...o })), allowFreeText: false };
  try { normalizeRequest(request, undefined, structured); } catch { return null; } // Abito's own size/shape rules
  return request;
}

function raceConfirm({ controller, ctx, ui, original, request, title, message, opts }) {
  return new Promise(resolve => {
    let decided = false;
    const abito = new AbortController(), terminal = new AbortController(), outer = opts?.signal;
    const finish = (value, winner) => {
      if (decided) return;
      decided = true;
      outer?.removeEventListener('abort', onOuterAbort);
      if (winner !== 'abito') abito.abort();
      if (winner !== 'terminal') terminal.abort();
      if (winner === 'abito') tell(ctx, `Respondido en Koda: ${value ? 'Sí' : 'No'}`);
      resolve(value === true);
    };
    const onOuterAbort = () => finish(false, null); // the caller withdrew: both sides go, never approval
    if (outer?.aborted) { resolve(false); return; }
    outer?.addEventListener('abort', onOuterAbort, { once: true });

    let asked;
    try { asked = controller.ask(request, ctx, abito.signal); } catch { asked = undefined; }
    Promise.resolve(asked).then(result => {
      if (decided || !isObject(result)) return;
      if (result.status === 'human_cancelled') { finish(false, 'abito'); return; }
      if (result.status !== 'answered' || !isObject(result.answer) || result.answer.type !== 'option') return; // no decision
      if (result.answer.value === 'yes') finish(true, 'abito');
      else if (result.answer.value === 'no') finish(false, 'abito');
    }, () => {});

    Promise.resolve()
      .then(() => original.call(ui, title, message, { ...(opts || {}), signal: terminal.signal }))
      .then(value => { if (!decided) finish(value === true, 'terminal'); },
        () => { if (!decided) finish(false, 'terminal'); }); // a failing terminal dialog is never approval
  });
}

const CONFIRM_ROUTERS = new WeakMap();
/**
 * Wrap ctx.ui.confirm once per ui object (Pi shares one ui object across extensions until it is rebound).
 * @param {{ ctx?: any, controller?: any, env?: Record<string, string | undefined> }} [options]
 * @returns {() => void} uninstall: restores the original confirm (or turns the wrapper into a pass-through).
 */
function installConfirmRouter({ ctx, controller, env = process.env } = {}) {
  try {
    const ui = ctx?.ui;
    if (env.ABITO_NATIVE_CONFIRM === '0' || !isObject(ui) || typeof ui.confirm !== 'function' || CONFIRM_ROUTERS.has(ui)) return () => {};
    const original = ui.confirm;
    const state = { active: true };
    const wrapper = function confirm(title, message, opts) {
      let request = null;
      try {
        if (state.active && ctx.hasUI === true && controller && typeof controller.canAsk === 'function' && controller.canAsk() === true) {
          request = confirmRequest(title, message, typeof controller.structured === 'function' && controller.structured() === true);
        }
      } catch { request = null; }
      if (!request) return original.call(this ?? ui, title, message, opts); // terminal only, untouched
      return raceConfirm({ controller, ctx, ui, original, request, title, message, opts });
    };
    ui.confirm = wrapper;
    CONFIRM_ROUTERS.set(ui, state);
    return () => {
      if (!state.active) return;
      state.active = false;
      CONFIRM_ROUTERS.delete(ui);
      if (ui.confirm === wrapper) ui.confirm = original;
    };
  } catch { return () => {}; }
}

module.exports = { createNativeAskHandler, isSensitive, planChoice, planQuestionnaire, installConfirmRouter, isSensitiveConfirm, confirmRequest };
