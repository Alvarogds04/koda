'use strict';
// Best-effort, fail-closed secret redaction for a shell command that is shown on the island.
// Every secret is replaced by the fixed marker `[REDACTED]`. Pure functions, no I/O, no throws.
// Linear-time by construction: lookbehind-anchored starts, bounded quantifiers on any run that can
// restart at every position, and manual scanners for values (no nested/ambiguous quantifiers).
// See docs/REDACTION.md for the pattern list, the known gaps and the false-positive policy.
const MARKER = '[REDACTED]';
const MAX_PASSES = 6;

// Documented pattern list (ids are stable; docs/REDACTION.md mirrors it).
const PATTERNS = Object.freeze([
  { id: 'pem', group: 'f', description: '-----BEGIN ... PRIVATE KEY----- through END (or end of string if unterminated)' },
  { id: 'url-userinfo', group: 'd', description: 'scheme://user:pass@host -> scheme://[REDACTED]@host' },
  { id: 'url-param', group: 'd', description: 'query/fragment parameters whose name contains token|key|secret|sig|password|passwd|pwd|auth|credential|session|jwt, or is exactly code' },
  { id: 'http-header', group: 'c', description: 'Authorization / Proxy-Authorization / Cookie / Set-Cookie and any NAME: whose name contains key|token|secret|auth|sig|pass|cred|session|csrf|jwt|cookie: value up to the closing quote or end of line' },
  { id: 'bearer-basic', group: 'c', description: 'bare "Bearer <tok>" and "Basic <b64>"' },
  { id: 'curl-user', group: 'c', description: 'curl-style -u/-U/--user/--proxy-user value (only when curl|wget|xh|http|lftp|ncftp|aria2c|httpie appears)' },
  { id: 'json-key', group: 'a', description: '"secretish-name": value inside JSON bodies (also \\"name\\": in shell-escaped JSON)' },
  { id: 'secret-flag', group: 'b', description: '--password|--passwd|--pass|--passphrase|--passin|--passout|--token|--api-key|--apikey|--secret|--auth|--access-token|--client-secret|--key|--credential(s) (also -pass, -passin, -key ...) and compounds like --my-token, in "--flag value" and "--flag=value" forms; a value starting with "-" is treated as the next flag and left alone' },
  { id: 'login-p', group: 'b', description: '-p <value> / -p<value> when "login" or "sshpass" appears (docker login -p, sshpass -p)' },
  { id: 'db-attached', group: 'b', description: '-p<value> / -P<value> attached to mysql|mariadb|mysqldump|mysqladmin|mysqlpump|psql|pg_dump|pg_dumpall|pg_restore|mongo|mongosh|redis-cli|sqlplus; such commands are also lossy' },
  { id: 'env-assignment', group: 'a', description: 'NAME=VALUE where NAME contains KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE (case-insensitive); value bare, single/double quoted or $\'..\'' },
  { id: 'token-shapes', group: 'e', description: 'sk-*, sk-ant-*, ghp_/gho_/ghu_/ghs_/ghr_*, github_pat_*, glpat-*, xox[abprs]-*, AKIA/ASIA*, AIza*, npm_*, pypi-*, SG.*.*, JWT eyJ*.*.*' },
  { id: 'hex-run', group: 'e', description: 'any run of >= 32 hex characters' },
  { id: 'cookie-flag', group: 'c', description: 'curl-style -b / --cookie value (only with curl|wget|xh|http|https|httpie ... in the command)' },
  { id: 'httpie-auth', group: 'c', description: 'httpie/xh -a user:pass (only when http|https|xh|httpie appears; --auth is covered by secret-flag)' },
  { id: 'sql-connect', group: 'b', description: 'user/pass[@db] connect strings when sqlplus|sqlcl|rman appears: becomes [REDACTED][@db]' },
  { id: 'token-subcommand', group: 'b', description: 'positional value after set-access-token-holder|print-access-token|print-identity-token|get-access-token|set-identity-token' },
  { id: 'token-word', group: 'b', description: 'the unquoted word right after a standalone word token|secret|password|passwd|apikey|api-key (e.g. login token VALUE); a value starting with - is left alone' },
  { id: 'base64-run', group: 'e', description: 'any run of >= 40 base64/base64url characters; a run containing "/" only when it mixes lower, upper and digits (so ordinary paths survive)' },
]);

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE)/i;
const HEADER_NAME = /(key|token|secret|auth|sig|pass|cred|session|csrf|jwt|cookie)/i;
const PARAM_NAME = /(token|key|secret|sig|password|passwd|pwd|auth|credential|session|jwt)|^code$/i;
const CURL_CTX = /(?<![A-Za-z0-9_.-])(?:curl|wget|xh|lftp|ncftp|aria2c|httpie|https|http)(?![A-Za-z0-9_:-])/i;
const LOGIN_CTX = /(?<![A-Za-z0-9_.-])(?:login|sshpass)(?![A-Za-z0-9_-])/i;
const DB_TOOLS = new Set(['mysql', 'mariadb', 'mysqldump', 'mysqladmin', 'mysqlpump', 'psql', 'pg_dump', 'pg_dumpall',
  'pg_restore', 'mongo', 'mongosh', 'redis-cli', 'sqlplus']);

// End index of a shell word value starting at i: bare chars and quoted chunks until whitespace or ; & | < >.
// An unterminated quote swallows the rest of the string (fail-closed). Linear.
function valueEnd(s, i) {
  const n = s.length;
  while (i < n) {
    if (s.startsWith(MARKER, i)) { i += MARKER.length; continue; }
    const c = s.charCodeAt(i);
    if (c === 36 && s.charCodeAt(i + 1) === 39) {
      let k = i + 2;
      while (k < n && s.charCodeAt(k) !== 39) k += s.charCodeAt(k) === 92 ? 2 : 1;
      if (k >= n) return n;
      i = k + 1; continue;
    }
    if (c === 39) { const j = s.indexOf("'", i + 1); if (j < 0) return n; i = j + 1; continue; }
    if (c === 34) {
      let k = i + 1;
      while (k < n && s.charCodeAt(k) !== 34) k += s.charCodeAt(k) === 92 ? 2 : 1;
      if (k >= n) return n;
      i = k + 1; continue;
    }
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 59 || c === 38 || c === 124 || c === 60 || c === 62) break;
    i++;
  }
  return i;
}
// Shell structure characters: ; & | < > and line breaks. An unquoted secret span must stop at the first one.
const isStruct = c => c === 59 || c === 38 || c === 124 || c === 60 || c === 62 || c === 10 || c === 13;
function clampStruct(s, i, end) {
  while (i < end && !isStruct(s.charCodeAt(i))) i++;
  return i;
}
// Quote state (0 none, 39 single, 34 double) at index idx; monotonic, linear over a whole scan.
function quoteTracker(s) {
  let i = 0, st = 0;
  return idx => {
    while (i < idx) {
      const c = s.charCodeAt(i);
      if (st === 0) { if (c === 92) i++; else if (c === 39 || c === 34) st = c; }
      else if (st === 34) { if (c === 92) i++; else if (c === 34) st = 0; }
      else if (c === 39) st = 0;
      i++;
    }
    return st;
  };
}
const trimEnd = (s, start, end) => { while (end > start && (s[end - 1] === ' ' || s[end - 1] === '\t')) end--; return end; };
// End of a header value: first quote or line break; outside any quote also the first ; & | < >.
function headerEnd(s, i, quoted) {
  const n = s.length, start = i;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 34 || c === 39 || c === 10 || c === 13) break;
    if (!quoted && isStruct(c)) break;
    i++;
  }
  return quoted ? i : trimEnd(s, start, i);
}
function paramEnd(s, i) {
  const n = s.length;
  while (i < n && !/[&#\s"'<>;|`]/.test(s[i])) i++;
  return i;
}
// Value of a JSON member after `"name":`; handles "..." and \"...\" (shell-escaped) and bare scalars.
// `clamp` (the member sits outside any shell quote): an unterminated value stops at the first ; & | < >.
function jsonValueEnd(s, i, clamp) {
  const n = s.length;
  const open = e => { if (!clamp) return n; const c = clampStruct(s, e, n); return trimEnd(s, e, c); };
  if (s.startsWith('\\"', i)) {
    const j = s.indexOf('\\"', i + 2);
    if (j < 0) return open(i + 2);
    if (clamp) { const c = clampStruct(s, i + 2, j); if (c < j) return trimEnd(s, i + 2, c); }
    return j + 2;
  }
  if (s[i] === '"') {
    let k = i + 1;
    while (k < n && s.charCodeAt(k) !== 34) k += s.charCodeAt(k) === 92 ? 2 : 1;
    return k >= n ? open(i + 1) : k + 1;
  }
  // Bare scalar: never starts or ends inside a quoted token. A quote opens a chunk that is consumed up to its
  // closing quote; a quote that cannot close hides only what follows it (the quote itself stays visible).
  while (i < n) {
    if (s.startsWith(MARKER, i)) { i += MARKER.length; continue; }
    const c = s.charCodeAt(i);
    if (c === 39 || c === 34 || (c === 36 && s.charCodeAt(i + 1) === 39)) {
      const dollar = c === 36, esc = dollar || c === 34, q = dollar ? 39 : c;
      let k = i + (dollar ? 2 : 1);
      while (k < n && s.charCodeAt(k) !== q) k += esc && s.charCodeAt(k) === 92 ? 2 : 1;
      if (k >= n) return open(i + (dollar ? 2 : 1));
      i = k + 1; continue;
    }
    if (/[,}\]\s]/.test(s[i])) break;
    i++;
  }
  return i;
}

// Generic head-then-value scanner. decide(match, text) => null | {start, end} (range to replace by MARKER).
function scan(text, head, decide, spans) {
  head.lastIndex = 0;
  let out = '', last = 0, count = 0, m;
  while ((m = head.exec(text)) !== null) {
    if (m[0].length === 0) { head.lastIndex++; continue; }
    const r = decide(m, text);
    if (!r || r.end <= r.start || r.start < last) continue;
    out += text.slice(last, r.start) + MARKER;
    if (text.slice(r.start, r.end) !== MARKER) { count++; spans.push(text.slice(r.start, r.end)); }
    last = r.end;
    if (head.lastIndex < r.end) head.lastIndex = r.end;
  }
  return { text: last === 0 ? text : out + text.slice(last), count };
}
// fn(...) returns the replacement for the WHOLE match; `hidden` (optional) is the part of the match that is
// really replaced (defaults to the whole match) and is recorded as a span.
function sub(text, re, fn, spans, hidden) {
  let count = 0;
  const out = text.replace(re, (...a) => {
    const r = fn(...a);
    if (r !== a[0]) { count++; spans.push(hidden ? hidden(...a) : a[0]); }
    return r;
  });
  return { text: out, count };
}

const PEM_HEAD = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;
const PEM_END = /-----END [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;
const USERINFO = /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]{0,20}:\/\/)[^\s\/?#'"@;&|<>`]{1,256}@/g;
const COOKIE_HEAD = /(?<![A-Za-z0-9_-])(?:--cookie(?:=|[ \t]+)|-b[ \t]*)/g;
const HTTPIE_A = /(?<![A-Za-z0-9_-])-a[ \t]+/g;
const TOKEN_SUB_HEAD = /(?<![A-Za-z0-9_-])(?:set-access-token-holder|print-access-token|print-identity-token|get-access-token|set-identity-token)[ \t]+/g;
const TOKEN_WORD_HEAD = /(?<![A-Za-z0-9_.\/=:-])(?:token|secret|password|passwd|apikey|api-key)[ \t]+/gi;
const SQL_CONN = /(?<![A-Za-z0-9_\/.$#-])([A-Za-z_][A-Za-z0-9_$#.-]{0,40}\/[^\s\/@"';&|<>`]{1,128})(?=@|["']?(?:\s|$|[;&|]))/g;
const HTTPIE_CTX = /(?<![A-Za-z0-9_.-])(?:https?|xh|httpie)(?![A-Za-z0-9_:-])/i;
const SQL_CTX = /(?<![A-Za-z0-9_.-])(?:sqlplus|sqlcl|rman)(?![A-Za-z0-9_:-])/i;
const PARAM_HEAD = /(?<=[?&#])([A-Za-z0-9_.%-]{1,64})=/g;
const HEADER_HEAD = /(?<![A-Za-z0-9-])([A-Za-z0-9-]{1,64})[ \t]*:[ \t]*/g;
const BEARER = /(?<![A-Za-z0-9])(Bearer|Basic)[ \t]+[^\s"']+/gi;
const JSON_HEAD = /\\?"([A-Za-z0-9_.-]{1,64})\\?"[ \t]*:[ \t]*/g;
const FLAG_HEAD = /(?<![A-Za-z0-9_-])--?(?:[a-z0-9-]{0,40}-)?(?:password|passwd|passphrase|passin|passout|pass|token|api-?key|apikey|secret|auth|key|credentials?)(?:-[a-z0-9-]{0,40})?(=|[ \t]+)/gi;
const USER_HEAD = /(?<![A-Za-z0-9_-])(--user|--proxy-user)(=|[ \t]+)|(?<![A-Za-z0-9_-])(-[uU])[ \t]*/g;
const P_HEAD = /(?<![A-Za-z0-9_-])-p(?:[ \t]+|(?=[^\s-]))/g;
const ASSIGN_HEAD = /(?<![A-Za-z0-9_])[A-Za-z_][A-Za-z0-9_]{0,127}=/g;
const TOKEN_SHAPES = [
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/g,
  /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}/g,
  /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/g,
  /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{16,}/g,
  /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}/g,
  /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{30,}/g,
  /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{30,}/g,
  /(?<![A-Za-z0-9])pypi-[A-Za-z0-9_-]{30,}/g,
  /(?<![A-Za-z0-9])SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
  /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];
const HEX_RUN = /[0-9a-fA-F]{32,}/g;
const B64_SLASH = /[A-Za-z0-9+\/_=-]{40,}/g;
const B64_PLAIN = /[A-Za-z0-9+_=-]{40,}/g;

// Tokens of `text` that are -p<value>/-P<value> options of a db tool in the same command segment.
function dbAttachedOptions(text) {
  const found = [];
  const re = /[;&|\n]|[^\s;&|]+/g;
  let inDb = false, m;
  while ((m = re.exec(text)) !== null) {
    const tok = m[0];
    if (tok.length === 1 && ';&|\n'.includes(tok)) { inDb = false; continue; }
    if (DB_TOOLS.has(tok.slice(tok.lastIndexOf('/') + 1))) { inDb = true; continue; }
    if (inDb && /^-[pP][^\s=-]/.test(tok)) found.push({ start: m.index + 2, end: m.index + tok.length });
  }
  return found;
}
const hasDbAttachedOption = text => { try { return dbAttachedOptions(text).length > 0; } catch { return true; } };

// Positional value after a head: skipped when it starts like a flag.
const valueAfter = (m, s) => {
  const start = m.index + m[0].length;
  if (s[start] === '-' && /[A-Za-z-]/.test(s[start + 1] || '')) return null;
  return { start, end: valueEnd(s, start) };
};
function onePass(input, spans) {
  let text = input, total = 0;
  const step = r => { text = r.text; total += r.count; };
  // PEM: through END; unterminated => stop at the first quote or ; & | < > so the rest of the command stays visible.
  {
    const q = quoteTracker(text);
    let out = '', last = 0, count = 0, endAt = -2, m;
    PEM_HEAD.lastIndex = 0;
    while ((m = PEM_HEAD.exec(text)) !== null) {
      if (m.index < last) continue;
      const bodyStart = m.index + m[0].length;
      if (endAt !== -1 && endAt < bodyStart) { PEM_END.lastIndex = bodyStart; const e = PEM_END.exec(text); endAt = e ? e.index + e[0].length : -1; }
      let end;
      if (endAt >= 0) end = endAt;
      else {
        // inside a quote: stop at the closing quote, unless the body is empty (then keep going to the next ; & | < >)
        const inQuote = q(m.index) !== 0;
        end = bodyStart;
        while (end < text.length) {
          const c = text.charCodeAt(end);
          if ((isStruct(c) && c !== 10 && c !== 13) || (inQuote && end > bodyStart && (c === 34 || c === 39))) break;
          end++;
        }
        end = Math.max(trimEnd(text, bodyStart, end), bodyStart);
      }
      out += text.slice(last, m.index) + MARKER;
      if (text.slice(m.index, end) !== MARKER) { count++; spans.push(text.slice(m.index, end)); }
      last = end;
      if (PEM_HEAD.lastIndex < end) PEM_HEAD.lastIndex = end;
    }
    step({ text: last === 0 ? text : out + text.slice(last), count });
  }
  step(sub(text, USERINFO, (m, scheme) => `${scheme}${MARKER}@`, spans, m => m.slice(m.indexOf('://') + 3, -1)));
  step(scan(text, PARAM_HEAD, (m, s) => (PARAM_NAME.test(m[1]) ? { start: m.index + m[0].length, end: paramEnd(s, m.index + m[0].length) } : null), spans));
  step(scan(text, FLAG_HEAD, (m, s) => {
    const start = m.index + m[0].length;
    if (m[1] !== '=' && s[start] === '-' && /[A-Za-z-]/.test(s[start + 1] || '')) return null; // next flag
    return { start, end: valueEnd(s, start) };
  }, spans));
  {
    const q = quoteTracker(text);
    step(scan(text, HEADER_HEAD, (m, s) => {
      if (!HEADER_NAME.test(m[1])) return null;
      const start = m.index + m[0].length;
      return { start, end: headerEnd(s, start, q(m.index) !== 0) };
    }, spans));
  }
  step(sub(text, BEARER, (m, word) => `${word} ${MARKER}`, spans, m => m.slice(m.search(/[ \t]/)).trimStart()));
  {
    const q = quoteTracker(text);
    step(scan(text, JSON_HEAD, (m, s) => {
      if (!SECRET_NAME.test(m[1])) return null;
      const start = m.index + m[0].length;
      const clamp = q(m.index) === 0;
      const end = jsonValueEnd(s, start, clamp);
      // unterminated/clamped escaped value: keep the opening \" visible so the span holds no backslash
      if (clamp && s.startsWith('\\"', start) && !(end > start + 2 && s.startsWith('\\"', end - 2))) return { start: start + 2, end };
      return { start, end };
    }, spans));
  }
  if (CURL_CTX.test(text)) {
    step(scan(text, USER_HEAD, (m, s) => {
      const start = m.index + m[0].length;
      return { start, end: valueEnd(s, start) };
    }, spans));
    step(scan(text, COOKIE_HEAD, valueAfter, spans));
  }
  if (HTTPIE_CTX.test(text)) step(scan(text, HTTPIE_A, valueAfter, spans));
  if (LOGIN_CTX.test(text)) {
    step(scan(text, P_HEAD, (m, s) => {
      const start = m.index + m[0].length;
      return { start, end: valueEnd(s, start) };
    }, spans));
  }
  if (SQL_CTX.test(text)) {
    step(sub(text, SQL_CONN, () => MARKER, spans));
  }
  step(scan(text, TOKEN_SUB_HEAD, valueAfter, spans));
  {
    const q = quoteTracker(text);
    step(scan(text, TOKEN_WORD_HEAD, (m, s) => (q(m.index) !== 0 ? null : valueAfter(m, s)), spans));
  }
  step(scan(text, ASSIGN_HEAD, (m, s) => {
    if (!SECRET_NAME.test(m[0])) return null;
    const start = m.index + m[0].length;
    return { start, end: valueEnd(s, start) };
  }, spans));
  const db = dbAttachedOptions(text);
  if (db.length) {
    let out = '', last = 0;
    for (const { start, end } of db) {
      out += text.slice(last, start) + MARKER;
      if (text.slice(start, end) !== MARKER) { total++; spans.push(text.slice(start, end)); }
      last = end;
    }
    text = out + text.slice(last);
  }
  for (const re of TOKEN_SHAPES) step(sub(text, re, () => MARKER, spans));
  step(sub(text, HEX_RUN, () => MARKER, spans));
  step(sub(text, B64_SLASH, m => (m.includes('/') && /[a-z]/.test(m) && /[A-Z]/.test(m) && /[0-9]/.test(m) ? MARKER : m), spans));
  step(sub(text, B64_PLAIN, () => MARKER, spans));
  return { text, count: total };
}

// Returns {text, redactions, spans}; `spans` are the original substrings that were replaced by the marker.
// Never throws; on any internal error the whole input is hidden (the span is the whole command).
function redactCommand(command) {
  if (typeof command !== 'string') return { text: '', redactions: 0, spans: [] };
  try {
    let text = command, redactions = 0;
    const spans = [];
    for (let i = 0; i < MAX_PASSES; i++) {
      const r = onePass(text, spans);
      redactions += r.count;
      if (r.text === text) break;
      text = r.text;
    }
    return { text, redactions, spans };
  } catch {
    return { text: MARKER, redactions: 1, spans: [command] };
  }
}
// Shell syntax that a hidden span could carry: ; & | < > ` $ ( ) { } \ newline CR. False positives are accepted.
const SHELL_META = /[;&|<>`$(){}\\\n\r]/;
// Quote states before each index of s (and at s.length): 0 none, 1 single, 2 double, 3 $'..'.
function quoteStates(s) {
  const n = s.length, out = new Uint8Array(n + 1);
  let st = 0, i = 0;
  while (i < n) {
    out[i] = st;
    const c = s.charCodeAt(i);
    if (st === 0) {
      if (c === 92) { if (i + 1 < n) out[i + 1] = 0; i += 2; continue; }
      if (c === 39) st = 1; else if (c === 34) st = 2;
      else if (c === 36 && s.charCodeAt(i + 1) === 39) { out[i + 1] = 0; st = 3; i += 2; continue; }
    } else if (st === 1) { if (c === 39) st = 0; }
    else if (c === 92) { if (i + 1 < n) out[i + 1] = st; i += 2; continue; }
    else if ((st === 2 && c === 34) || (st === 3 && c === 39)) st = 0;
    i++;
  }
  out[n] = st;
  return out;
}
const unescapedQuotes = x => {
  let k = 0;
  for (let i = 0; i < x.length; i++) {
    const c = x.charCodeAt(i);
    if (c === 92) i++; else if (c === 39 || c === 34) k++;
  }
  return k;
};
// Quote parity: true when a replaced part of `original` flips the quote state (state at span start != at span end,
// or an odd number of unescaped quotes), or the visible text is not aligned with the display / has other quote state.
// Visible pieces of `redacted` (split on the marker) are located left to right in `original`; the gaps are the spans.
function quoteParityLoss(original, redacted) {
  try {
    const pieces = redacted.split(MARKER);
    if (pieces.length === 1) return redacted !== original;
    const so = quoteStates(original), sd = quoteStates(redacted);
    let o = 0, d = 0;
    for (let k = 0; k < pieces.length; k++) {
      const p = pieces[k];
      let at;
      if (k === 0) at = original.startsWith(p) ? 0 : -1;
      else if (k === pieces.length - 1) at = original.length - p.length >= o && original.endsWith(p) ? original.length - p.length : -1;
      else at = original.indexOf(p, o);
      if (at < 0) return true;
      if (k > 0) {
        if (so[o] !== so[at] || unescapedQuotes(original.slice(o, at)) % 2 === 1) return true;
      }
      for (let j = 0; j <= p.length; j++) if (so[at + j] !== sd[d + j]) return true;
      o = at + p.length; d += p.length + MARKER.length;
    }
    return false;
  } catch { return true; }
}
const hiddenShellSyntax = spans => Array.isArray(spans) && spans.some(x => SHELL_META.test(x));

// ---- losslessness predicates (applied to the ORIGINAL command) ----
const CREDENTIAL_PATHS = [
  /\.ssh/i, /id_rsa/i, /id_ed25519/i, /id_ecdsa/i, /id_dsa/i, /\.env(?![A-Za-z0-9])/i, /\.netrc/i, /\.npmrc/i, /\.pgpass/i,
  /\.aws(?![A-Za-z0-9])/i, /\.gnupg/i, /\.kube\/config/i, /\.docker\/config\.json/i, /\.config\/gh(?![A-Za-z0-9])/i,
  /\/etc\/shadow/i, /\/etc\/sudoers/i, /auth\.json/i, /credential/i,
  /(?<![A-Za-z0-9])secrets?(?![A-Za-z0-9])/, /[_.\/*-]secrets?(?![A-Za-z0-9])/, /\*secret/i, /pip\.conf/i, /(?<![\w.-])printenv(?![\w-])/,
  /(?:^|[;&|])\s*env(?=\s*(?:$|[;&|<>]|(?:-[A-Za-z0-9]+\s*){1,4}(?:$|[;&|<>])))/, /\/proc\/[^\s]*environ/i,
  /(?<![\w-])gh\s+auth\s+token/i, /print-(?:access|identity)-token/i, /find-(?:generic|internet)-password/i, /--login-path/i,
  /\.(?:bashrc|bash_profile|bash_login|profile|zshrc|zprofile|zshenv)(?![A-Za-z0-9_])/i, /\/etc\/(?:profile|bash\.bashrc|environment|zshrc|zshenv)/i,
  /\$\{?SSH_AUTH_SOCK/i, /\.git-credentials/i, /\.gitconfig/i, /kubectl\b[^;&|]*--raw/i, /(?<![\w-])vault\s+(?:read|kv\s+get)/i,
  /(?<![\w-])pass\s+show/i, /(?<![\w-])op\s+read/i, /\.claude(?![A-Za-z0-9])/i, /\.codex(?![A-Za-z0-9])/i,
  /\.abito-island/i, /\.(?:pem|key|p12|pfx)(?![A-Za-z0-9])/i, /cookies/i,
];
const touchesCredentialPath = s => CREDENTIAL_PATHS.some(re => re.test(s));
const INDIRECTION = [
  /\$\(/, /`/, /<\(/, />\(/, /<</,
  /(?<![A-Za-z0-9_.-])(?:eval|sudo|doas|su|pkexec)(?![A-Za-z0-9_-])/i,
  /base64\s+(?:-d|-D|--decode)/i,
  /\|\s*(?:sudo\s+)?(?:env\s+)?(?:\/[\w\/.-]*\/)?(?:sh|bash|zsh|dash|ksh|csh|tcsh|fish|python[0-9.]*|perl|node|ruby|php|lua|pwsh|powershell)(?![A-Za-z0-9_-])/i,
];
const interp = (names, flags) => new RegExp(`(?<![A-Za-z0-9_-])(?:${names})(?:\\s+-[A-Za-z]{1,10}){0,3}?\\s+-[A-Za-z]{0,10}[${flags}](?![A-Za-z0-9_-])`);
const both = (a, b) => s => a.test(s) && b.test(s);
INDIRECTION.push(
  interp('bash|sh|zsh|dash|ksh|fish', 'c'), interp('python[0-9.]*', 'c'), interp('perl', 'eE'), interp('ruby', 'e'), interp('node', 'ep'), interp('php', 'r'),
  /(?<![A-Za-z0-9_-])node\s+--(?:eval|print)(?![A-Za-z0-9_-])/,
  both(/(?<![\w-])(?:awk|gawk|mawk|nawk)(?![\w-])/, /system\s*\(/),
  /(?<![\w-])env(?:\s+\S+){0,10}?\s+(?:\/[\w\/.-]*\/)?(?:sh|bash|zsh|dash|ksh)(?![\w-])/,
  /(?<![\w-])xargs(?![\w-])/,
  both(/(?<![\w-])find(?![\w-])/, /\s-(?:exec|execdir|delete|ok|okdir)(?![\w-])/),
  both(/(?<![\w-])dd(?![\w-])/, /(?<![\w-])of=/),
  both(/(?<![\w-])sed(?![\w-])/, /\s(?:-[A-Za-z]*i[A-Za-z]*|--in-place)(?![\w-])/),
  /(?<![\w-])tee(?:\s+-[A-Za-z-]{1,20}){0,5}\s+[^\s;&|<>-]/,
  /(?<![\w.\/-])source(?![\w-])/, /(?:^|[;&|(])\s*\.\s+\S/,
);
const hasIndirection = s => INDIRECTION.some(t => (typeof t === 'function' ? t(s) : t.test(s)));

module.exports = { redactCommand, PATTERNS, MARKER, touchesCredentialPath, hasIndirection, hasDbAttachedOption, hiddenShellSyntax, quoteParityLoss };
