'use strict';
// #503 T3 · S24 · 24 Teléfono (Android) → Opción A, with the human's note: «Se queda implementando pero sin QR por que no
// esta disponible esto para la version 0.2». So: the numbered-steps layout, the status line, the verification-code area and
// the devices block are implemented as designed, but there is NO QR and NO fabricated state: nothing in Ajustes can reach
// the phone link in 0.2, so every control is inert and the page says so in words.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, all, text, dom, base, load } = require('./settings-designs-check.cjs');

async function mount() {
  dom();
  const { renderUnavailable } = await load('pages.js');
  return renderUnavailable('phone');
}
const words = e => text(e).replace(/\s+/g, ' ').trim();

test('S24 Teléfono: header status «Esperando», the link switch, and the three numbered steps in the wireframe order', async () => {
  const ui = await mount();
  assert.deepEqual(all(ui).filter(e => e.tagName === 'h2').map(e => words(e)), ['Teléfono Android']);
  const status = all(ui).find(e => e.attrs.id === 'phone-status');
  assert(status); assert.equal(status.attrs.role, 'status'); assert.equal(words(status), '○ No disponible en la versión 0.2');
  assert(all(status).some(e => e.className === 'state-ico' && e.attrs['aria-hidden'] === 'true'));
  assert(words(ui).includes('Enlace con el teléfono'));
  const steps = all(ui).find(e => e.tagName === 'ol' && e.attrs.id === 'phone-steps'); assert(steps, 'a real numbered list');
  assert.deepEqual(steps.children.map(words), ['Abrí Koda en el teléfono.', 'Cuando esté disponible, escaneá el código con el teléfono.', 'Confirmá en el teléfono el código que te mostrará Koda.']);
});

test('S24 Teléfono: NO QR anywhere, no pairing code invented, no device invented; the page says why in words', async () => {
  const ui = await mount();
  assert(!all(ui).some(e => ['canvas', 'img', 'svg', 'image'].includes(e.tagName)), 'no QR image of any kind');
  assert(!all(ui).some(e => e.className && /qr/i.test(e.className) && !e.className.includes('no-qr')), 'no QR element');
  assert(!/\b\d{3} \d{3}\b/.test(words(ui)), 'no verification code is shown: it would be fabricated');
  const code = all(ui).find(e => e.attrs.id === 'phone-code'); assert(code);
  assert(words(code).includes('El código de verificación aparecerá aquí cuando el enlace esté disponible.') && !/\d/.test(words(code)), 'the code area explains itself and holds no digits');
  const why = all(ui).find(e => e.attrs.id === 'phone-no-qr');
  assert(words(why).includes('El emparejamiento con código QR no está disponible en la versión 0.2.'));
  const devices = all(ui).find(e => e.attrs.id === 'phone-devices'); assert(devices);
  assert(words(devices).includes('Dispositivos') && words(devices).includes('Ninguno vinculado.'), 'an honest empty list, not a sample device');
  assert(!words(ui).includes('Pixel'));
});

test('S24 Teléfono: Desvincular exists with its confirmation, and every control is inert (nothing reaches the host)', async () => {
  const ui = await mount();
  const unlink = all(ui).find(e => e.tagName === 'button' && e.textContent === 'Desvincular');
  assert(unlink, 'the designed action is there'); assert(unlink.disabled); assert.equal(unlink.attrs.title, 'No disponible todavía');
  const confirm = all(ui).find(e => e.attrs.id === 'phone-unlink-confirm');
  assert(confirm && confirm.hidden, 'the confirmation exists and is closed'); assert(words(confirm).includes('¿Desvincular este teléfono?'));
  assert(all(confirm).some(e => e.tagName === 'button' && e.textContent === 'Desvincular' && e.disabled) && all(confirm).some(e => e.tagName === 'button' && e.textContent === 'Cancelar' && e.disabled));
  const sw = all(ui).find(e => e.className.split(' ').includes('switch')); assert(sw.disabled && sw.attrs['aria-pressed'] === 'false');
  for (const e of all(ui).filter(e => ['button', 'input', 'select'].includes(e.tagName))) assert.equal(e.disabled, true, `${e.tagName} ${e.textContent || ''} must be inert`);
  for (const ev of ['click', 'change']) { unlink.fire(ev); sw.fire(ev); }
  assert.equal(confirm.hidden, true, 'a click on an inert control opens nothing');
});

test('S24 Teléfono: the security notes are no longer last and faint, and the page imports nothing that could reach the phone link', async () => {
  const ui = await mount();
  const notes = all(ui).find(e => e.attrs.id === 'phone-security'); assert(notes);
  assert(words(notes).includes('Permitir en el teléfono pide la huella o el bloqueo de pantalla.') && words(notes).includes('Denegar no.'));
  assert(words(notes).includes('Solo escucha en tu red local.'));
  const order = ui.children.map(e => e.attrs?.id).filter(Boolean);
  assert(order.indexOf('phone-security') < order.indexOf('phone-steps'), `the security notes come BEFORE the steps, not last and faint: ${order}`);
  const src = fs.readFileSync(path.join(base, 'pages.ts'), 'utf8').split('export function renderUnavailable')[1].split('// Notetaker')[0];
  assert(!/invoke|call\(|phone_link|qr_svg|pairing|fetch\(|innerHTML/.test(src), 'inert by construction: no IPC, no pairing code, no markup sink');
});

test('S24 Teléfono: the hero subtitle keeps «Wi‑Fi» in one piece (non-breaking hyphen), with the same words', async () => {
  const fs = require('node:fs'), pathMod = require('node:path');
  const src = fs.readFileSync(pathMod.join(base, 'i18n-es.ts'), 'utf8');
  const line = src.split('\n').find(l => l.includes('over your Wi-Fi.') && l.includes("': '"));
  assert(line && line.includes('por Wi\\u2011Fi.'), 'the Spanish subtitle uses U+2011');
  const { t } = await import(require('node:url').pathToFileURL(pathMod.join(base, 'i18n-es.js')));
  const es = t('Your agents and their approvals on your Android phone, over your Wi-Fi.');
  assert.equal(es.replace(/[\u2010\u2011]/g, '-'), 'Tus agentes y sus aprobaciones en tu teléfono Android, por Wi-Fi.'); assert(es.includes('\u2011') && !es.includes('Wi-Fi'));
});
