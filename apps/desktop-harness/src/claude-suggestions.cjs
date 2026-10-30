'use strict';
// Permission updates are capabilities, not UI text. Keep the frozen original separate from the
// derived QP/1 options; never reconstruct an update from a label or an island answer.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { sensitivePath, secret, canonical } = require('./file-permission.cjs');
const { sanitizeText } = require('./projection.cjs');
const plain = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const exact = (v, keys) => plain(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const string = v => typeof v === 'string' && v.length > 0 && v.length <= 4096;
const list = v => Array.isArray(v) && v.length > 0 && v.length <= 8;
function freeze(v) {
  if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); }
  return v;
}
function safePath(raw, cwd) {
  const expanded = raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw;
  const p = path.resolve(cwd, expanded);
  try { return !sensitivePath(expanded) && !sensitivePath(p) && !secret(p) && canonical(p) === p; } catch { return false; }
}
function planSuggestions(data, detail) {
  const out = [];
  const entries = data.permission_suggestions;
  if (detail.lossy || data.tool_name.startsWith('mcp__') || !Array.isArray(entries) || entries.length > 32) return out;
  const input = data.tool_input;
  let target, directory;
  if (data.tool_name === 'Bash') {
    target = input.command;
    // No redacted/hidden text can authorize a durable capability. Check every shell word using
    // the file-preview sensitivity policy too (including relative dot-directories and symlinks).
    if (detail.text !== `Bash: ${target}` || secret(target) || /[\\"'$`{}]/.test(target) ||
      target.split(/[\s=:;&|()<>]+/).filter(Boolean).some(word => !safePath(word, data.cwd))) return out;
    const match = /^cd (\/[^\s*?\[\]{}]+)$/.exec(target);
    if (match && safePath(match[1], data.cwd)) {
      try { if (fs.statSync(match[1]).isDirectory()) directory = match[1]; } catch { /* not a directory */ }
    }
  } else if (detail.filePreview) target = path.resolve(data.cwd, input.file_path);
  else return out;
  const seen = new Set();
  for (const entry of entries) {
    if (!plain(entry) || !['session', 'localSettings'].includes(entry.destination)) continue;
    let shown;
    if (entry.type === 'addRules' && exact(entry, ['type', 'rules', 'behavior', 'destination']) && entry.behavior === 'allow' && list(entry.rules)) {
      if (!entry.rules.every(r => exact(r, ['toolName', 'ruleContent']) && r.toolName === data.tool_name && string(r.ruleContent) &&
        (r.ruleContent === target || (detail.filePreview && r.ruleContent === '/' + target)))) continue;
      // Equality, never glob interpretation or prefix matching. A directory-wide /** is NOT the
      // same permission as the file on the card. Claude's //absolute form may name that same file.
      shown = entry.rules.map(r => r.ruleContent).join('; ');
    } else if (entry.type === 'addDirectories' && exact(entry, ['type', 'directories', 'destination']) && list(entry.directories) && directory &&
      entry.directories.every(d => string(d) && d === directory)) shown = entry.directories.join('; ');
    else if (entry.type === 'setMode' && exact(entry, ['type', 'mode', 'destination']) && entry.mode === 'acceptEdits') shown = 'acceptEdits: aceptar ediciones automáticamente';
    else continue;
    // Do not silently alter a permission while describing it. Controls/spoofing and overlong
    // descriptions drop this extra, never the main allow/deny pair. No home contraction here.
    if (sanitizeText(shown, { max: 4096, home: null }) !== shown) continue;
    const where = entry.destination === 'session' ? 'solo esta sesión' : 'se guarda en .claude/settings.local.json';
    const description = `Aprobar y no volver a preguntar por «${shown}» (${where})`;
    if ([...description].length > 160) continue;
    const key = JSON.stringify([entry.type, entry.destination, shown]);
    if (seen.has(key)) continue;
    seen.add(key);
    let original;
    try { original = freeze(JSON.parse(JSON.stringify(entry))); } catch { continue; }
    out.push(Object.freeze({ original, option: Object.freeze({ value: `allow_suggestion_${out.length + 1}`,
      label: 'Aprobar y no volver a preguntar', description }) }));
    if (out.length === 2) break;
  }
  return Object.freeze(out);
}
function suggestionOutput(plan, result) {
  if (result?.status !== 'answered' || result.answer?.type !== 'option') return null;
  const selected = plan.find(e => e.option.value === result.answer.value);
  if (!selected) return null;
  return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: {
    behavior: 'allow', updatedPermissions: [selected.original] } } }) + '\n', stderr: '', exitCode: 0 };
}
module.exports = { planSuggestions, suggestionOutput };
