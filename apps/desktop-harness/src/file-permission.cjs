'use strict';
// Claude-only file consent. No file contents are read: previews come exclusively from the hook input.
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
function describeFilePermission(name, input, cwd) {
  if (!['Write', 'Edit', 'MultiEdit'].includes(name)) return null;
  const base = { filePreview: true, text: name, lossy: true, reason: 'solicitud no representable' };
  try {
    if (!object(input) || typeof input.file_path !== 'string' || !input.file_path || input.file_path.includes('\0')) return base;
    const raw = input.file_path;
    const normalized = path.resolve(cwd, raw);
    if (Buffer.byteLength(normalized) > MAX_PATH_BYTES) return { ...base, reason: 'ruta recortada' };
    if (unsafe(raw) || /[\t\n\r]/.test(raw) || secret(normalized)) return { ...base, reason: 'ruta no segura (secretos ocultos)' };
    const text = `${name}: ${quote(normalized)}`;
    let real;
    try { real = canonical(normalized); } catch { return { ...base, text, reason: 'ruta no verificable' }; }
    if (!inside(cwd, normalized) || !inside(fs.realpathSync(cwd), real)) return { ...base, text, reason: 'fuera de la carpeta de sesión' };
    if (sensitivePath(normalized) || sensitivePath(real) || real !== normalized) return { ...base, text, reason: 'ruta sensible o redirigida' };
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
    const preview = name === 'Write' ? `contenido: ${quote(shown[0])}` : edits.map((e, i) =>
      `${i + 1}. ${quote(shown[i * 2])} → ${quote(shown[i * 2 + 1])}; ${e.replace_all === true ? 'todas las coincidencias' : 'una coincidencia'}`).join('; ');
    const full = `${text}; ${preview}`;
    // Reserve room for Spanish asker/fallback, also accounting for JSON escape expansion.
    if ([...full].length > (trimmed ? 350 : 390) || Buffer.byteLength(full) > 1200) return { ...base, text, reason: 'vista previa recortada' };
    return { filePreview: true, text: full, lossy: trimmed, ...(trimmed ? { reason: 'contenido recortado (8 líneas / 160 bytes)' } : {}) };
  } catch { return base; }
}
module.exports = { describeFilePermission, inside, sensitivePath, secret, canonical, MAX_LINES, MAX_BYTES, MAX_PATH_BYTES, MAX_EDITS };
