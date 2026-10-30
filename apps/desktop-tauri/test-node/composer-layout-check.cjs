'use strict';
/* #422 — the composer must stay usable after a file is attached. The strip
   (#chat-attachments, flex-basis:100%) lives INSIDE the #chat-composer flex row:
   if that row cannot wrap, the strip eats the row and crushes the draft box.
   CSS contract only (no browser): the declarations of each selector across
   style.css + chat-markdown.css, in cascade order. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(__dirname, '..', 'frontend');
const css = ['style.css', 'chat-markdown.css'].map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
function decls(sel) {
  const out = {};
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!m[1].split(',').map(s => s.trim()).includes(sel)) continue;
    for (const d of m[2].split(';')) { const i = d.indexOf(':'); if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).replace('!important', '').trim(); }
  }
  return out;
}
let failed = 0;
const test = (n, f) => { try { f(); console.log('PASS ' + n); } catch (e) { failed++; console.error('FAIL ' + n + ': ' + e.message); } };

test('composer row wraps, so the full-width strip takes its own line', () => {
  assert.equal(decls('#chat-composer')['flex-wrap'], 'wrap');
});
test('strip sits after the clip button (order) so draft, send and clip stay on the first line', () => {
  const strip = Number(decls('#chat-attachments').order), clip = Number(decls('#chat-attach').order);
  assert.ok(strip > clip, `strip order ${strip} must exceed clip order ${clip}`);
  assert.equal(decls('#chat-attachments')['flex-basis'], '100%');
});
test('many chips cannot push the composer out of the fixed-height window', () => {
  const s = decls('#chat-attachments');
  assert.match(s['max-height'] || '', /^\d+px$/);
  assert.equal(s['overflow-y'], 'auto');
  assert.equal(s['min-width'], '0');
});
test('long names ellipsize inside the chip', () => {
  const n = decls('.composer-attachment-name');
  assert.equal(n['text-overflow'], 'ellipsis');
  assert.equal(n['min-width'], '0');
});
test('chip remove keeps a 44px touch target', () => {
  assert.ok(decls('.composer-attachment-remove').position === 'relative');
  const hit = decls('.composer-attachment-remove::after');
  assert.equal(hit.position, 'absolute');
  assert.equal(hit.inset, '-11px');
});
test('draft box keeps a usable width next to send and clip', () => {
  assert.equal(decls('#chat-input').flex, '1');
  assert.equal(decls('#chat-input')['min-width'], '0');
});
if (failed) { console.error(failed + ' failed'); process.exit(1); }
