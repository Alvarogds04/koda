'use strict';
// File consent for Claude's Write/Edit/MultiEdit and Codex's apply_patch (K2-08 T4). No file contents are read: previews
// come exclusively from the hook input.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { redactCommand, touchesCredentialPath } = require('./redact.cjs');
const MAX_LINES = 8, MAX_BYTES = 160, MAX_PATH_BYTES = 160, MAX_EDITS = 3, MAX_SCAN_BYTES = 4096;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const unsafe = s => /[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cs}\u2028\u2029\x00-\x08\x0b-\x1f\x7f-\x9f]/u.test(s);
// `pathMod` is a test seam (path.win32 on any OS); production always uses the platform's own `path`.
const inside = (root, target, pathMod = path) => { const rel = pathMod.relative(root, target); return rel !== '..' && !rel.startsWith('..' + pathMod.sep) && !pathMod.isAbsolute(rel); };
// Resolve existing ancestors too: a nonexistent destination inside a symlink is not implicitly trusted.
function canonical(target) {
  const suffix = [];
  for (;;) {
    try {
      const st = fs.lstatSync(target);
      if (st.isSymbolicLink()) throw new Error('enlace simbólico');
      return path.join(fs.realpathSync(target), ...suffix);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      const parent = path.dirname(target);
      if (parent === target) throw e;
      suffix.unshift(path.basename(target)); target = parent;
    }
  }
}
// JSON-quoted data cannot manufacture option rows; LF/TAB/CR remain explicit escapes, not layout.
function quote(s) {
  return JSON.stringify(s).replace(/[\p{Cf}\p{Cs}\u2028\u2029\x7f-\x9f]/gu, c =>
    [...c].map(ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0')).join(''));
}
function secret(s) {
  // Same shell pipeline, plus conservative whole-snippet hiding for generic dotenv assignments and
  // secret-looking source-code keys the shell grammar cannot safely delimit (e.g. token = value).
  const r = redactCommand(s);
  return r.redactions > 0 || /(?:^|\n)\s*(?:export\s+)?[A-Za-z_][\w]*\s*=/m.test(s) ||
    /(?:key|token|secret|password|credential|private|authorization)\s*["']?\s*[:=]/i.test(s) || /PRIVATE KEY/.test(s);
}
// Dot-directories that hold credentials or control tooling. Windows: either separator and case-insensitive (NTFS is);
// elsewhere the Unix rule is unchanged ('/' only, case-sensitive). `platform` is a test seam.
const DOT_DIRS = { win32: /(?:^|[\\/])\.(?:ssh|claude|codex|config|git)(?:[\\/]|$)/i, posix: /(?:^|\/)\.(?:ssh|claude|codex|config|git)(?:\/|$)/ };
function sensitivePath(p, platform = process.platform) {
  const home = os.homedir();
  return touchesCredentialPath(p) || inside('/etc', p) ||
    (platform === 'win32' ? DOT_DIRS.win32 : DOT_DIRS.posix).test(p) ||
    (inside(home, p) && path.relative(home, p).startsWith('.'));
}
// The R9 path rules, shared by Claude's Write/Edit/MultiEdit and Codex's apply_patch. `shown: false` means nothing of the
// path may appear on the card (too long, unsafe characters or secret-looking); otherwise `normalized` may be shown and a
// `reason` makes the card lossy (not verifiable, outside the session folder, sensitive or redirected).
function pathVerdict(raw, cwd) {
  const normalized = path.resolve(cwd, raw);
  if (Buffer.byteLength(normalized) > MAX_PATH_BYTES) return { shown: false, reason: 'ruta recortada' };
  if (unsafe(raw) || /[\t\n\r]/.test(raw) || secret(normalized)) return { shown: false, reason: 'ruta no segura (secretos ocultos)' };
  let real;
  try { real = canonical(normalized); } catch { return { shown: true, normalized, reason: 'ruta no verificable' }; }
  if (!inside(cwd, normalized) || !inside(fs.realpathSync(cwd), real)) return { shown: true, normalized, reason: 'fuera de la carpeta de sesión' };
  if (sensitivePath(normalized) || sensitivePath(real) || real !== normalized) return { shown: true, normalized, reason: 'ruta sensible o redirigida' };
  return { shown: true, normalized };
}
function describeFilePermission(name, input, cwd) {
  if (!['Write', 'Edit', 'MultiEdit'].includes(name)) return null;
  const base = { filePreview: true, text: name, lossy: true, reason: 'solicitud no representable' };
  try {
    if (!object(input) || typeof input.file_path !== 'string' || !input.file_path || input.file_path.includes('\0')) return base;
    const verdict = pathVerdict(input.file_path, cwd);
    if (!verdict.shown) return { ...base, reason: verdict.reason };
    const text = `${name}: ${quote(verdict.normalized)}`;
    if (verdict.reason) return { ...base, text, reason: verdict.reason };
    const keys = name === 'Write' ? ['file_path', 'content'] : name === 'Edit' ? ['file_path', 'old_string', 'new_string', 'replace_all'] : ['file_path', 'edits'];
    if (Object.keys(input).some(k => !keys.includes(k))) return { ...base, text };
    const edits = name === 'Write' ? null : name === 'Edit' ? [input] : input.edits;
    if (edits !== null && (!Array.isArray(edits) || !edits.length || edits.length > MAX_EDITS)) return { ...base, text, reason: 'cambios recortados (máximo 3)' };
    let snippets;
    if (name === 'Write') snippets = [input.content];
    else {
      if (edits.some(e => !object(e) || Object.keys(e).some(k => !['old_string', 'new_string', 'replace_all', ...(name === 'Edit' ? ['file_path'] : [])].includes(k)) ||
        (e.replace_all !== undefined && typeof e.replace_all !== 'boolean'))) return { ...base, text };
      snippets = edits.flatMap(e => [e.old_string, e.new_string]);
    }
    if (snippets.some(s => typeof s !== 'string')) return { ...base, text };
    // Never scan an unbounded body or redact a cut secret. Scan ALL snippets before taking a prefix.
    const bytes = snippets.reduce((n, s) => n + Buffer.byteLength(s), 0);
    if (bytes > MAX_SCAN_BYTES) return { ...base, text, reason: 'contenido recortado; vista previa omitida por seguridad (secretos ocultos)' };
    if (snippets.some(secret)) return { ...base, text: `${text}; contenido: [REDACTED] (secretos ocultos)`, reason: 'contenido oculto' };
    if (snippets.some(unsafe)) return { ...base, text, reason: 'contenido no seguro o binario; vista previa omitida' };
    const { trimmed, shown } = cut(snippets);
    const preview = name === 'Write' ? `contenido: ${quote(shown[0])}` : edits.map((e, i) =>
      `${i + 1}. ${quote(shown[i * 2])} → ${quote(shown[i * 2 + 1])}; ${e.replace_all === true ? 'todas las coincidencias' : 'una coincidencia'}`).join('; ');
    return bounded(base, text, `${text}; ${preview}`, trimmed);
  } catch { return base; }
}
// Over the caps (8 lines / 160 bytes in total) every snippet becomes a prefix of the shared budget and the card is lossy.
function cut(snippets) {
  const bytes = snippets.reduce((n, s) => n + Buffer.byteLength(s), 0);
  const trimmed = bytes > MAX_BYTES || snippets.reduce((n, s) => n + s.split('\n').length, 0) > MAX_LINES;
  let remainingBytes = MAX_BYTES, remainingLines = MAX_LINES;
  const shown = snippets.map(s => {
    if (!trimmed) return s;
    const lines = s.split('\n').slice(0, remainingLines).join('\n');
    let prefix = '';
    for (const char of lines) {
      const size = Buffer.byteLength(char);
      if (size > remainingBytes) break;
      prefix += char; remainingBytes -= size;
    }
    remainingLines = Math.max(0, remainingLines - prefix.split('\n').length);
    return prefix;
  });
  return { trimmed, shown };
}
// Reserve room for Spanish asker/fallback, also accounting for JSON escape expansion.
function bounded(base, head, full, trimmed) {
  if ([...full].length > (trimmed ? 350 : 390) || Buffer.byteLength(full) > 1200) return { ...base, text: head, reason: 'vista previa recortada' };
  return { filePreview: true, text: full, lossy: trimmed, ...(trimmed ? { reason: 'contenido recortado (8 líneas / 160 bytes)' } : {}) };
}
// Codex apply_patch (K2-08 T4). The patch format is not officially documented: it is parsed STRICTLY and anything outside
// this grammar is not representable. `*** Begin Patch`, then one or more file sections, then `*** End Patch` (one trailing
// newline allowed). Add: only `+` lines (at least one). Delete: no body. Update: an optional single `*** Move to:`, then hunks;
// a hunk opens with `@@` or `@@ <anchor>` (the first may omit it), holds `+`/`-`/` ` lines with at least one change, and may
// close with `*** End of File`. Returns the file sections, or null.
const PATCH_HEADER = /^\*\*\* (Add|Delete|Update) File: (\S(?:.*\S)?)$/, PATCH_MOVE = /^\*\*\* Move to: (\S(?:.*\S)?)$/;
const PATCH_ANCHOR = /^@@(?: (\S.*))?$/;
function parsePatch(command) {
  const lines = (command.endsWith('\n') ? command.slice(0, -1) : command).split('\n');
  if (lines.length < 3 || lines[0] !== '*** Begin Patch' || lines[lines.length - 1] !== '*** End Patch') return null;
  const files = [];
  const complete = f => !f || (f.op === 'add' ? f.add.length > 0 : f.op === 'delete' ||
    ((f.move !== null || f.hunks.length > 0) && f.hunks.every(h => h.lines.some(l => l.t !== ' '))));
  for (const line of lines.slice(1, -1)) {
    const file = files[files.length - 1], hunk = file && file.hunks[file.hunks.length - 1];
    let m;
    if ((m = PATCH_HEADER.exec(line))) {
      if (!complete(file)) return null;
      files.push({ op: m[1].toLowerCase(), raw: m[2], move: null, hunks: [], add: [] });
    } else if ((m = PATCH_MOVE.exec(line))) {
      if (!file || file.op !== 'update' || file.move !== null || file.hunks.length) return null;
      file.move = m[1];
    } else if ((m = PATCH_ANCHOR.exec(line))) {
      if (!file || file.op !== 'update' || (hunk && !hunk.lines.some(l => l.t !== ' '))) return null;
      file.hunks.push({ anchor: m[1] === undefined ? null : m[1], lines: [], eof: false });
    } else if (line === '*** End of File') {
      if (!hunk || file.op !== 'update' || hunk.eof || !hunk.lines.some(l => l.t !== ' ')) return null;
      hunk.eof = true;
    } else if (/^[-+ ]/.test(line) && file) {
      if (file.op === 'add') { if (line[0] !== '+') return null; file.add.push(line.slice(1)); continue; }
      if (file.op !== 'update' || (hunk && hunk.eof) || (!hunk && file.hunks.length)) return null;
      if (!hunk) file.hunks.push({ anchor: null, lines: [], eof: false });
      file.hunks[file.hunks.length - 1].lines.push({ t: line[0], s: line.slice(1) });
    } else return null;
  }
  return files.length && complete(files[files.length - 1]) ? files : null;
}
// One hunk as the human sees it: the changed span old → new (context between changes included). A hunk with no `-` line only
// says WHERE it lands through its context, so all of it is shown; with no context (and not at the end of the file) it is blind.
function hunkView(h) {
  const changed = h.lines.map((l, i) => l.t !== ' ' ? i : -1).filter(i => i >= 0);
  const removes = h.lines.some(l => l.t === '-'), context = h.lines.some(l => l.t === ' ');
  const span = removes ? h.lines.slice(changed[0], changed[changed.length - 1] + 1) : h.lines;
  return { anchor: h.anchor, eof: h.eof, blind: !removes && !context && !h.eof,
    old: span.filter(l => l.t !== '+').map(l => l.s).join('\n'), neu: span.filter(l => l.t !== '-').map(l => l.s).join('\n') };
}
function describePatchPermission(input, cwd) {
  const base = { filePreview: true, text: 'apply_patch', lossy: true, reason: 'solicitud no representable' };
  try {
    if (!object(input) || Object.keys(input).length !== 1 || typeof input.command !== 'string') return base;
    const command = input.command;
    if (Buffer.byteLength(command) > MAX_SCAN_BYTES) return { ...base, reason: 'parche recortado (máximo 4096 bytes); vista previa omitida' };
    if (unsafe(command)) return { ...base, reason: 'contenido no seguro o binario; vista previa omitida' };
    const files = parsePatch(command);
    if (!files) return base;
    // The same file twice (also through `./`, `a/..`, a Move onto itself or a case variant) is not representable.
    const seen = new Set();
    for (const raw of files.flatMap(f => f.move === null ? [f.raw] : [f.raw, f.move])) {
      const key = path.resolve(cwd, raw).toLowerCase();
      if (seen.has(key)) return base;
      seen.add(key);
    }
    const verdicts = files.map(f => (f.move === null ? [f.raw] : [f.raw, f.move]).map(raw => pathVerdict(raw, cwd)));
    const label = v => v.shown ? quote(v.normalized) : '[ruta oculta]';
    const entry = vs => vs.map(label).join(' → ');
    if (files.length > 1) { // 1a: several files are never approvable; the card lists up to 3
      const more = files.length - MAX_EDITS;
      return { ...base, text: `apply_patch: varios archivos: ${verdicts.slice(0, MAX_EDITS).map(entry).join(', ')}${more > 0 ? ` y ${more} más` : ''}`, reason: 'varios archivos' };
    }
    const [file] = files, [vs] = verdicts;
    const hidden = vs.find(v => !v.shown);
    if (hidden) return { ...base, reason: hidden.reason };
    const head = file.op === 'delete' ? `apply_patch: borrar ${label(vs[0])}` : file.move !== null ? `apply_patch: mover ${entry(vs)}` : `apply_patch: ${label(vs[0])}`;
    const flagged = vs.find(v => v.reason);
    if (flagged) return { ...base, text: head, reason: flagged.reason };
    if (file.hunks.length > MAX_EDITS) return { ...base, text: head, reason: 'cambios recortados (máximo 3)' };
    // Scan EVERY body line (+, -, context, @@ anchors) before anything is cut.
    const views = file.hunks.map(hunkView);
    const scan = file.op === 'add' ? [file.add.join('\n')] : file.hunks.flatMap(h => [h.anchor || '',
      h.lines.filter(l => l.t !== '+').map(l => l.s).join('\n'), h.lines.filter(l => l.t !== '-').map(l => l.s).join('\n')]);
    if (scan.some(secret)) return { ...base, text: `${head}; contenido: [REDACTED] (secretos ocultos)`, reason: 'contenido oculto' };
    if (views.some(v => v.blind)) return { ...base, text: head, reason: 'ubicación del cambio no visible' };
    if (file.op === 'delete' || (file.op === 'update' && !views.length)) return bounded(base, head, head, false);
    const snippets = file.op === 'add' ? scan : views.flatMap(v => [...(v.anchor !== null ? [v.anchor] : []), v.old, v.neu]);
    const { trimmed, shown } = cut(snippets);
    if (file.op === 'add') {
      // L22 D2b: Codex's Add File overwrites a file that already exists, so the card says so (lstat only: no content is read).
      let exists = false;
      try { fs.lstatSync(vs[0].normalized); exists = true; } catch { exists = false; }
      return bounded(base, head, `${head}; ${exists ? 'reemplazar el contenido por' : 'añadir'}: ${quote(shown[0])}`, trimmed);
    }
    let i = 0;
    const parts = views.map(v => `${v.anchor !== null ? `en ${quote(shown[i++])}: ` : ''}${quote(shown[i++])} → ${quote(shown[i++])}${v.eof ? ' (al final del archivo)' : ''}`);
    const hunks = parts.length === 1 ? parts[0] : parts.map((p, n) => `${n + 1}. ${p}`).join('; ');
    return bounded(base, head, `${head}; modificar: ${hunks}`, trimmed);
  } catch { return base; }
}
module.exports = { describeFilePermission, describePatchPermission, inside, sensitivePath, secret, canonical, MAX_LINES, MAX_BYTES, MAX_PATH_BYTES, MAX_EDITS };
