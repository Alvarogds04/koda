'use strict';
// K2 T1 · S2 (last clause) / S3 / S4 · Ajustes › Teléfono (Android) is LIVE.
// The old page (#503 S24, option A) was implemented but inert and said «no disponible en la versión 0.2» with no QR; the human's
// D4 decision replaces it with the minimal page on the same skeleton: switch, estado, pasos, QR, link copiable y desemparejar.
// Everything this page shows comes from the host (`phone_link_action` + the `phone:state` event), and the link starts OFF (S3):
// it opens a port on the LAN, so nothing here may turn it on by itself. The QR is an <img> whose pixels are the host's SVG,
// base64-encoded — never innerHTML, never a code the page invents.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test, all, text, dom, Element, base, load } = require('./settings-designs-check.cjs');

const OFF = { enabled: false, running: false, port: 47821, host: null, name: 'koda', link: null, qrSvg: null, clients: 0, error: null };
const LINK = 'abito://pair?v=1&h=192.168.1.7&p=47821&t=token-de-prueba&fp=0123456789abcdef';
// The host builds the markup (an accent included: the encoding must be UTF-8, not btoa's Latin-1).
const QR = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="3" height="3" fill="#000"/><desc>código</desc></svg>';
const ON = { ...OFF, enabled: true, running: true, host: '192.168.1.7', link: LINK, qrSvg: QR };

const words = e => text(e).replace(/\s+/g, ' ').trim();
const byId = (ui, id) => all(ui).find(e => e.attrs.id === id);
const buttons = ui => all(ui).filter(e => e.tagName === 'button');
const click = (ui, word) => {
  const b = buttons(ui).find(e => e.textContent === word);
  assert(b, `button «${word}» missing`);
  return b;
};
const sw = ui => all(ui).find(e => String(e.className).split(' ').includes('switch'));
const usageSwitch = ui => all(ui).find(e => String(e.className).split(' ').includes('switch') && e.attrs['aria-label'] === 'Uso de los planes');
const qrImg = ui => all(ui).find(e => e.tagName === 'img');
const qrBox = ui => all(ui).find(e => String(e.className) === 'phone-qr');
const linkField = ui => byId(ui, 'phone-link');
const confirmBox = ui => byId(ui, 'phone-unlink-confirm');
const linkRow = ui => all(ui).find(e => String(e.className) === 'phone-link');
const statusWords = ui => words(byId(ui, 'phone-status'));
const tick = () => new Promise(r => setImmediate(r));

const ctx = hero => ({ hero, status: { prefs: { key: 'right_ctrl' }, platform: 'linux' }, navigate() {}, set onLeave(_) {} });

/** Mounts the page against a fake host: the two closed commands, one event, and a clipboard that records what it got.
 * `phone_link_action` is the link; `prefs_action` is the same channel every other Ajustes switch uses, and the only
 * thing the phone page asks it for is its own switch (`phoneUsage`, S11). */
async function mount(initial = OFF, options = {}) {
  dom();
  const listened = new Map(), calls = [], prefsCalls = [], copied = [];
  Object.defineProperty(global, 'navigator', { configurable: true, value: { userAgent: 'Linux', clipboard: { writeText: async v => { copied.push(v); } } } });
  global.window = { __TAURI__: { event: { listen: async (name, fn) => { const set = listened.get(name) ?? new Set(); listened.set(name, set); set.add(fn); return () => set.delete(fn); } } } };
  const { setInvoke } = await load('flow-shim.js');
  const { hero } = await load('hero.js');
  let status = initial, refused = null, usage = options.phoneUsage === true;
  const prefsRefused = options.prefsRefused ?? null, saveRefused = options.saveRefused ?? null;
  setInvoke(async (cmd, args) => {
    assert.deepEqual(Object.keys(args ?? {}), ['payload'], 'exactly one payload key');
    if (cmd === 'prefs_action') {
      prefsCalls.push(structuredClone(args.payload));
      if (prefsRefused) throw prefsRefused;
      if (args.payload.action === 'view') return { phoneUsage: usage };
      assert.deepEqual(Object.keys(args.payload), ['action', 'phone_usage'], 'closed schema: action + the boolean');
      assert.equal(args.payload.action, 'set_phone_usage', 'the phone page writes only its own preference');
      if (saveRefused) throw saveRefused;
      usage = args.payload.phone_usage === true;
      return { phoneUsage: usage };
    }
    assert.equal(cmd, 'phone_link_action', 'the link has one closed command');
    assert.deepEqual(Object.keys(args.payload), ['action'], 'closed schema: nothing but the action');
    calls.push(structuredClone(args.payload));
    if (refused) throw refused;
    if (args.payload.action === 'enable') status = { ...ON };
    if (args.payload.action === 'disable') status = { ...OFF };
    if (args.payload.action === 'unlink') status = { ...ON, clients: 0 };
    return structuredClone(status);
  });
  const { phonePage } = await load('pages.js');
  const page = new Element('div');
  await phonePage(page, ctx(hero));
  return {
    page, calls, prefsCalls, copied,
    usage: () => usage,
    push: next => { status = { ...next }; for (const fn of [...(listened.get('phone:state') ?? [])]) fn({ payload: structuredClone(status) }); },
    flush: tick,
  };
}

/** Mounts with a host that refuses every call, the way a Windows/macOS build or a missing command answers. */
async function mountRefused(message) {
  dom();
  const { setInvoke } = await load('flow-shim.js');
  const { hero } = await load('hero.js');
  const { phonePage } = await load('pages.js');
  setInvoke(async cmd => { throw new Error(cmd === 'prefs_action' ? 'prefs_action not found' : message); });
  const page = new Element('div');
  await phonePage(page, ctx(hero));
  return page;
}

const mine = [];
const register = (name, fn) => { mine.push([name, fn]); test(name, fn); };

register('K2 T1/S4 Teléfono: the page is live — the switch follows the host and starts OFF with no QR (S3)', async () => {
  const { page, calls } = await mount();
  assert.deepEqual(calls, [{ action: 'status' }], 'a status read on mount, nothing else');
  assert(byId(page, 'phone-status')); assert.equal(byId(page, 'phone-status').attrs.role, 'status');
  assert.equal(statusWords(page), '○ Apagado', 'off is said in words');
  assert.equal(sw(page).attrs['aria-pressed'], 'false', 'the switch reads the host, not its own optimism');
  assert(!String(sw(page).className).split(' ').includes('on'));
  assert.equal(sw(page).disabled, false, 'a live switch is not inert');
  assert.equal(qrImg(page), undefined, 'no QR while the link is off: nothing is fabricated');
  assert.equal(linkRow(page).hidden, true, 'no link row to copy from while there is no link');
});

register('K2 T1/S4 Teléfono: the switch calls enable and disable — and only those two verbs', async () => {
  const { page, calls, flush } = await mount();
  sw(page).fire('click', false); await flush(); assert.deepEqual(calls, [{ action: 'status' }], 'a synthetic click changes nothing');
  calls.length = 0;
  sw(page).fire('click'); await flush();
  assert.deepEqual(calls.splice(0), [{ action: 'enable' }]);
  assert.equal(sw(page).attrs['aria-pressed'], 'true');
  assert.equal(statusWords(page), '● Escuchando en 192.168.1.7:47821');
  sw(page).fire('click'); await flush();
  assert.deepEqual(calls.splice(0), [{ action: 'disable' }]);
  assert.equal(sw(page).attrs['aria-pressed'], 'false');
  assert.equal(statusWords(page), '○ Apagado');
});

register('K2 T1/S4 Teléfono: running shows the QR as an <img> of the host SVG (base64, UTF-8) and the link in a read-only field', async () => {
  const { page } = await mount(ON);
  assert.equal(statusWords(page), '● Escuchando en 192.168.1.7:47821');
  const img = qrImg(page);
  assert(img, 'the QR is there while running');
  assert(img.attrs.src.startsWith('data:image/svg+xml;base64,'), 'a plain <img> src, no markup insert');
  assert.equal(Buffer.from(img.attrs.src.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8'), QR, 'the pixels are exactly the host SVG, accents included');
  assert.equal(img.attrs.alt, 'Código QR para emparejar');
  const field = linkField(page);
  assert(field, 'the link lives in its own field');
  assert.equal(field.value, LINK);
  assert('readonly' in field.attrs, 'read only: the page never edits the host link');
  assert.equal(linkRow(page).hidden, false, 'and it is visible');
  assert.deepEqual(all(qrBox(page)).filter(e => e !== qrBox(page)).map(e => e.tagName), ['img'], 'the QR box holds the host image and nothing drawn by us');
});

register('K2 T1/S4 Teléfono: «Copiar» copies the host link; the status line reports the paired phones', async () => {
  const { page, copied } = await mount({ ...ON, clients: 1 });
  assert.equal(statusWords(page), '● 1 teléfono conectado');
  click(page, 'Copiar').fire('click'); await tick();
  assert.deepEqual(copied, [LINK], 'the clipboard got the link');
  assert(words(page).includes('Copiado'), 'and the page says so');
  const many = await mount({ ...ON, clients: 3 });
  assert.equal(statusWords(many.page), '● 3 teléfonos conectados');
  assert(words(byId(many.page, 'phone-devices')).includes('3 teléfonos conectados'), 'the devices block counts them too');
  const none = await mount();
  assert(words(byId(none.page, 'phone-devices')).includes('Ninguno vinculado.'), 'an honest empty list when nothing is paired');
});

register('K2 T1/S4 Teléfono: «Desemparejar» asks first and only then calls unlink', async () => {
  const { page, calls, flush } = await mount({ ...ON, clients: 1 });
  const box = confirmBox(page);
  assert(box && box.hidden === true, 'the confirmation starts closed');
  assert(words(box).includes('¿Desemparejar este teléfono?'));
  click(page, 'Desemparejar').fire('click'); await flush();
  assert.equal(box.hidden, false, 'the first click opens the confirmation');
  assert.deepEqual(calls.filter(p => p.action === 'unlink'), [], 'and sends nothing yet');
  click(box, 'Cancelar').fire('click', false);
  assert.equal(box.hidden, false, 'an untrusted cancel does nothing');
  click(box, 'Cancelar').fire('click');
  assert.equal(box.hidden, true, 'Cancelar closes it');
  assert.deepEqual(calls.filter(p => p.action === 'unlink'), []);
  click(page, 'Desemparejar').fire('click'); await flush();
  click(box, 'Desemparejar').fire('click', false); await flush();
  assert.deepEqual(calls.filter(p => p.action === 'unlink'), [], 'a synthetic confirm never unpairs');
  click(box, 'Desemparejar').fire('click'); await flush();
  assert.deepEqual(calls.filter(p => p.action === 'unlink'), [{ action: 'unlink' }], 'the confirmation is what sends it');
  assert.equal(box.hidden, true, 'and it closes after');
  assert(words(byId(page, 'phone-devices')).includes('Ninguno vinculado.'), 'no phone is claimed after unpairing');
});

register('K2 T1/S4 Teléfono: errors are said in words per code; «unsupported» disables the switch instead of lying', async () => {
  const busy = await mount({ ...OFF, enabled: true, running: false, error: 'port_in_use' });
  assert.equal(statusWords(busy.page), '✗ El puerto 47821 ya está ocupado por otro programa.');
  const keys = await mount({ ...OFF, enabled: true, running: false, error: 'keystore' });
  assert(statusWords(keys.page).includes('llavero'), statusWords(keys.page));
  const tls = await mount({ ...OFF, enabled: true, running: false, error: 'tls' });
  assert(statusWords(tls.page).includes('cifrada'), statusWords(tls.page));
  const other = await mount({ ...OFF, enabled: true, running: false, error: 'algo-raro' });
  assert.equal(statusWords(other.page), '✗ No se pudo encender el enlace.', 'an unknown code never invents a cause');
  const none = await mount({ ...OFF, error: 'unsupported' });
  assert.equal(statusWords(none.page), '· No disponible en este sistema');
  assert.equal(sw(none.page).disabled, true, 'the switch cannot promise what this system cannot do');
  for (const message of ['unsupported', 'phone_link_action not found']) {
    const page = await mountRefused(message);
    assert.equal(statusWords(page), '· No disponible en este sistema', message);
    assert.equal(sw(page).disabled, true, message);
  }
  const unreachable = await mountRefused('{"code":"nope","message":"No disponible"}');
  assert.equal(statusWords(unreachable), '✗ No se pudo leer el estado del enlace.', 'a host that cannot answer is not reported as «off»');
  assert.equal(sw(unreachable).attrs['aria-pressed'], 'false');
  assert.equal(sw(unreachable).disabled, true, 'nor can the switch be trusted');
});

register('K2 T1 Teléfono: the `phone:state` event repaints the page without asking again', async () => {
  const { page, calls, push } = await mount();
  assert.equal(qrImg(page), undefined);
  push(ON); await tick();
  assert.equal(statusWords(page), '● Escuchando en 192.168.1.7:47821', 'the event carries the same object as the command');
  assert(qrImg(page), 'the QR appears with the event');
  assert.equal(linkField(page).value, LINK);
  push(OFF); await tick();
  assert.equal(qrImg(page), undefined, 'and goes away with it');
  assert.deepEqual(calls, [{ action: 'status' }], 'events never make the page call the host');
});

register('K2 T1/S4 Teléfono: steps, security notes before them, and no «no disponible en la versión 0.2» left behind', async () => {
  const { page } = await mount();
  const steps = byId(page, 'phone-steps');
  assert(steps, 'a real numbered list'); assert.equal(steps.tagName, 'ol');
  assert.deepEqual(steps.children.map(words), ['Abrí Kenai en el teléfono.', 'Escaneá el código o pegá el link.', 'Listo: tus agentes aparecen en el teléfono.']);
  const notes = byId(page, 'phone-security');
  assert(words(notes).includes('Permitir en el teléfono pide la huella o el bloqueo de pantalla.') && words(notes).includes('Denegar no.'));
  assert(words(notes).includes('Solo escucha en tu red local.'));
  assert(page.children.indexOf(notes) < page.children.indexOf(steps), 'the security notes come BEFORE the steps');
  const flat = words(page);
  assert(!/no disponible en la versión 0\.2/i.test(flat), 'the old «no disponible en la versión 0.2» copy is gone');
  for (const gone of ['phone-code', 'phone-no-qr']) assert.equal(byId(page, gone), undefined, `${gone} is gone: the protocol has no verification code`);
  assert(!/\b\d{3} \d{3}\b/.test(flat), 'and no invented verification code');
});

register('K2 T1/S4 Teléfono: no markup sink in the page — the source may not write HTML', () => {
  const src = fs.readFileSync(path.join(base, 'pages.ts'), 'utf8');
  const from = src.indexOf('export const phonePage');
  assert(from > 0, 'the live phone page is in pages.ts');
  const phone = src.slice(from, src.indexOf('export const inactivePages'));
  assert(phone.length > 500);
  assert(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser/.test(phone), 'no HTML sink');
  assert(!/phone_link|qr_svg/.test(phone), 'no raw command strings: it goes through the closed bridge');
  assert(/PhoneBridge/.test(phone), 'the closed bridge carries every call');
  const bridge = fs.readFileSync(path.join(base, 'flow-shim.ts'), 'utf8');
  assert(/invoke\('phone_link_action', \{ payload: \{ action \} \}\)/.test(bridge), 'one command, one closed payload');
  for (const verb of ['status', 'enable', 'disable', 'unlink']) assert(new RegExp(`phoneCall\\('${verb}'\\)`).test(bridge), verb);
});

register('K2 T1: the page is no longer paused in Ajustes, and the shell lists it as active', async () => {
  const { ACTIVE_PAGES, PAUSED_PAGES } = await import(pathToFileURL(path.join(base, 'shell.js')));
  assert(ACTIVE_PAGES.includes('phone'), 'Ajustes must reach Teléfono: S2 «mostrar el QR y el link … en Ajustes › Teléfono Android»');
  assert(!PAUSED_PAGES.includes('phone'));
  const P = require(path.join(__dirname, '..', 'frontend', 'paused.js'));
  assert.equal(P.paused('phone'), false, 'the island/Rust pause list agrees');
  const { inactivePages } = await import(pathToFileURL(path.join(base, 'pages.js')));
  assert.equal(typeof inactivePages.phone, 'function', 'the shell gets the live renderer');
});

register('K2 T1 Teléfono: the hero subtitle keeps «Wi‑Fi» in one piece (non-breaking hyphen), with the same words', async () => {
  const src = fs.readFileSync(path.join(base, 'i18n-es.ts'), 'utf8');
  const line = src.split('\n').find(l => l.includes('over your Wi-Fi.') && l.includes("': '"));
  assert(line && line.includes('por Wi\\u2011Fi.'), 'the Spanish subtitle uses U+2011');
  const { t } = await import(pathToFileURL(path.join(base, 'i18n-es.js')));
  const es = t('Your agents and their approvals on your Android phone, over your Wi-Fi.');
  assert.equal(es.replace(/[\u2010\u2011]/g, '-'), 'Tus agentes y sus aprobaciones en tu teléfono Android, por Wi-Fi.'); assert(es.includes('\u2011') && !es.includes('Wi-Fi'));
});

register('K2 T6/S11 Teléfono: «Uso de los planes» is its own switch, OFF by default, and the click is the stored pref', async () => {
  const { page, calls, prefsCalls, usage, flush } = await mount();
  assert.deepEqual(calls, [{ action: 'status' }], 'the link command is still only read on mount');
  assert.deepEqual(prefsCalls, [{ action: 'view' }], 'the plan switch reads the stored preference, through prefs_action');
  const plan = usageSwitch(page);
  assert(plan, 'the plan switch exists, labelled');
  assert.equal(plan.attrs['aria-pressed'], 'false', 'S11: off by default');
  assert(!String(plan.className).split(' ').includes('on'));
  assert.equal(plan.disabled, false, 'a live switch is not inert');
  assert(words(page).includes('Uso de los planes'), 'the row is labelled in words');
  assert(words(page).includes('Muestra en el teléfono cuánto usaste de Claude y Codex.'), 'and says what it does');
  plan.fire('click', false); await flush();
  assert.deepEqual(prefsCalls, [{ action: 'view' }], 'a synthetic click changes nothing');
  plan.fire('click'); await flush();
  assert.deepEqual(prefsCalls.slice(1), [{ action: 'set_phone_usage', phone_usage: true }], 'the click writes the pref, exactly');
  assert.equal(usage(), true);
  assert.equal(plan.attrs['aria-pressed'], 'true');
  plan.fire('click'); await flush();
  assert.deepEqual(prefsCalls.slice(1), [{ action: 'set_phone_usage', phone_usage: true }, { action: 'set_phone_usage', phone_usage: false }]);
  assert.equal(plan.attrs['aria-pressed'], 'false');
  assert.deepEqual(calls, [{ action: 'status' }], 'the plan switch never touches the link switch');
});

register('K2 T6/S11 Teléfono: a stored «on» paints the switch, and a refused save never becomes an «on»', async () => {
  const stored = await mount(OFF, { phoneUsage: true });
  assert.equal(usageSwitch(stored.page).attrs['aria-pressed'], 'true', 'the page shows what is stored');
  const refused = await mount(OFF, { saveRefused: new Error('save_failed') });
  assert.equal(usageSwitch(refused.page).attrs['aria-pressed'], 'false');
  usageSwitch(refused.page).fire('click'); await tick();
  assert.equal(usageSwitch(refused.page).attrs['aria-pressed'], 'false', 'a refused write goes back to the stored value');
  assert(words(refused.page).includes('No se pudo guardar el uso de los planes. No se anuncia ningún cambio como guardado.'));
  // A host that cannot answer `prefs_action` at all leaves the switch inert instead of claiming «off».
  const none = await mountRefused('phone_link_action not found');
  assert.equal(usageSwitch(none).disabled, true);
});

// The designs suite (settings-designs-check.cjs) requires this file and runs everything it registered; running THIS file must also
// really run its own checks, instead of staying silent and exiting 0.
if (require.main === module) (async () => {
  let failed = 0;
  for (const [name, fn] of mine) {
    try { await fn(); console.log(`ok - ${name}`); }
    catch (e) { failed += 1; console.error(`not ok - ${name}\n`, e); }
  }
  if (failed) process.exitCode = 1;
  else console.log(`PASS settings-designs-phone: ${mine.length} checks (switch, QR, link, unpair, errors, event)`);
})();
