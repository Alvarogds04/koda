'use strict';
/* T7.3 chat attachments (design isla-chat-att1/att5/atterr/drag): one strip of 28px chips
   (r10, icon, name, ×) between the transcript and the input, an error chip with a red ring
   and one reason line, and a drag-over card «Soltá para adjuntar». Five chips fit in one
   548px row; a long name ellipsizes instead of overflowing. CSS contract only (no browser). */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(__dirname, '..', 'frontend');
const css = ['style.css', 'chat-markdown.css'].map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
function decls(sel) {
  const out = {};
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const group = m[1].replace(/\s+/g, ' ').trim();
    if (group !== sel && !group.split(',').map(s => s.trim()).includes(sel)) continue;
    for (const d of m[2].split(';')) { const i = d.indexOf(':'); if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).replace('!important', '').trim(); }
  }
  return out;
}
let failed = 0;
const test = (n, f) => { try { f(); console.log('PASS ' + n); } catch (e) { failed++; console.error('FAIL ' + n + ': ' + e.message); } };

test('chips are 28px high, r10, on the surface tone (design: strip of 28px chips)', () => {
  const c = decls('.composer-attachment');
  assert.equal(c['min-height'], '28px');
  assert.equal(c['border-radius'], '10px');
  assert.equal(c.background, 'var(--surface)');
  assert.match(c.font, /var\(--fs-caption\)/, '12px caption step, no raw px');
});
test('an error chip wears a red ring and its reason is one muted-red line', () => {
  assert.match(decls('.composer-attachment-error')['box-shadow'] || '', /var\(--red-11\)/);
  const r = decls('.composer-attachment-reason');
  assert.equal(r.color, 'var(--red-11)');
  assert.equal(r['font-size'], 'var(--fs-caption)');
  assert.equal(r['flex-basis'], '100%');
});
test('five chips with a long name cannot overflow the row: wrap, min-width 0, ellipsis, chip max 100%', () => {
  const strip = decls('#chat-attachments');
  assert.equal(strip['flex-wrap'], 'wrap');
  assert.equal(strip['min-width'], '0');
  assert.equal(strip['overflow-x'], 'hidden');
  const chip = decls('.composer-attachment');
  assert.equal(chip['max-width'], '100%');
  assert.equal(chip['min-width'], '0');
  const name = decls('.composer-attachment-name');
  assert.equal(name['text-overflow'], 'ellipsis');
  assert.equal(name['min-width'], '0');
  assert.match(name['max-width'] || '', /^\d+px$/, 'a name is capped so five chips share the 548px row');
  const px = Number(/^(\d+)px$/.exec(name['max-width'])[1]);
  assert.ok(px <= 96, `name cap ${px}px keeps 5 x (icon 20 + name + x 28 + gaps) inside 548px`);
});
test('the size text is not drawn in the chip (design shows icon, name, ×)', () => {
  assert.equal(decls('.composer-attachment-size').display, 'none');
});
test('drag-over: one card «Soltá para adjuntar» replaces the body (design isla-chat-drag)', () => {
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.match(html, /id="chat-drop"[^>]*hidden/);
  assert.match(html, /id="chat-drop"[\s\S]*?Soltá para adjuntar[\s\S]*?Imágenes y texto/);
  const d = decls('#chat-drop');
  assert.match(d.border || '', /2px solid var\(--island-live\)/);
  assert.equal(d['border-radius'], '16px');
  assert.match(fs.readFileSync(path.join(dir, 'chat.js'), 'utf8'), /tauri:\/\/drag-enter[\s\S]*tauri:\/\/drag-leave/);
});
if (failed) { console.error(failed + ' failed'); process.exit(1); }
console.log('chat-attachments-design-check: all passed');
