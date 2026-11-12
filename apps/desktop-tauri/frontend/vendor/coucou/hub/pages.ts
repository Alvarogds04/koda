// Adapted from Coucou src/hub/pages/{dictation,insights,words,styles,flowsettings,voice}.ts @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT.
// Abito: inert first-slice layouts for the pages still waiting on their host — plus the LIVE «Teléfono Android» page (K2 T1),
// which talks to the host only through the closed `PhoneBridge`. No Flow/voice commands or capture side effects here.
import { h, clear } from '../views/dom.js';
import { card, row, button, keyLabel, label, divider, toggle, segmented } from './ui.js';
import { notchRow, notchHint } from './notch.js';
import { t } from './i18n-es.js';
import { glowCard, emptyState } from './hero.js';
import { mount, modelsControl } from './dictation-pages.js';
import { PhoneBridge, PrefsBridge, type PhoneStatus } from './flow-shim.js';
import { trusted } from './runtime.js';
import type { FlowPageRenderer, PageId } from './shell.js';
const definitions: Record<string, [string, string | null, string]> = {
  voice: ['OK Koda', 'Say « OK Koda », then ask anything: add a pill, play music, the weather, an email to prepare.', 'Enable'],
};
// K2 T1 · S2 (last clause) / S3 / S4: Ajustes › Teléfono Android is LIVE and minimal on the #503 S24 skeleton — switch, estado,
// pasos, QR, link copiable y desemparejar. The link opens a port on the LAN, so it starts OFF (S3): nothing on this page turns it on
// by itself. Every word comes from the host (`phone_link_action`, then the `phone:state` event); when the host cannot answer, the page
// says THAT instead of showing an «off» it did not read. The QR is an <img> whose pixels are the host's own SVG, base64-encoded:
// there is no markup sink here, and no verification code, because the link protocol has none.
const PHONE_PORT = 47821;
const PHONE_ERRORS: Record<string, string> = {
  keystore: 'No se pudo guardar la clave del enlace en el llavero de tu sesión.',
  port_in_use: `El puerto ${PHONE_PORT} ya está ocupado por otro programa.`,
  tls: 'No se pudo preparar la conexión cifrada con el teléfono.',
  unsupported: 'No disponible en este sistema',
};
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** Base64 of the UTF-8 bytes: `btoa` alone garbles every accent the SVG carries. */
function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    out += B64[a >> 2] + B64[((a & 3) << 4) | ((b ?? 0) >> 4)] +
      (b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]) +
      (c === undefined ? '=' : B64[c & 63]);
  }
  return out;
}
const phoneReason = (error: unknown) => String((error as any)?.message ?? error ?? '');
/** «unsupported», or the command simply not being there (Windows and macOS build without it). */
const phoneUnsupported = (reason: string) => /unsupported|not found|unknown command/i.test(reason);
const phones = (n: number) => (n === 1 ? '1 teléfono conectado' : `${n} teléfonos conectados`);

export const phonePage: FlowPageRenderer = async (page: HTMLElement, ctx: any) => {
  const life = mount(page, ctx);
  let st: PhoneStatus | null = null, refused = '', busy = false;
  let usageOn = false, usageKnown = false, usageBusy = false;
  const icon = (glyph: string) => h('span', { class: 'state-ico', 'aria-hidden': 'true', text: glyph });
  const status = h('div', { id: 'phone-status', class: 'phone-status', role: 'status', 'aria-live': 'polite' });
  const security = h('div', { id: 'phone-security', class: 'phone-security' },
    notchHint(t('Allow on the phone asks for the fingerprint or the screen lock. Deny does not.')),
    notchHint('Solo escucha en tu red local.'));
  const sw = trusted(toggle(false, (on) => void turn(on)));
  sw.setAttribute('aria-label', 'Enlace con el teléfono');
  sw.setAttribute('aria-pressed', 'false');
  // S11/§11: the plan pills, behind their own switch. It is an Ajustes preference (`set_phone_usage`), so the page
  // reads it from the prefs view and writes it through the same closed `prefs_action` every other switch uses. The
  // link offers `usage` in the NEXT `welcome`: a phone already connected sees the pills after it reconnects.
  const usage = trusted(toggle(false, (on) => void setUsage(on)));
  usage.setAttribute('aria-label', 'Uso de los planes');
  usage.setAttribute('aria-pressed', 'false');
  const steps = h('ol', { id: 'phone-steps', class: 'phone-steps' },
    h('li', { text: 'Abrí Kenai en el teléfono.' }),
    h('li', { text: 'Escaneá el código o pegá el link.' }),
    h('li', { text: 'Listo: tus agentes aparecen en el teléfono.' }));
  const qr = h('div', { class: 'phone-qr' });
  qr.hidden = true;
  const linkField = h('input', { id: 'phone-link', class: 'phone-link-field', type: 'text', readonly: true, 'aria-label': 'Link para emparejar' }) as HTMLInputElement;
  const copyNote = h('span', { class: 'hint', role: 'status' });
  const linkRow = h('div', { class: 'phone-link' }, linkField, trusted(button('Copiar', () => void copyLink())), copyNote);
  linkRow.hidden = true;
  const confirm = h('div', { id: 'phone-unlink-confirm', class: 'phone-confirm', role: 'group' },
    h('span', { text: '¿Desemparejar este teléfono?' }),
    trusted(button('Desemparejar', () => void unpair(), 'danger', true)),
    trusted(button('Cancelar', () => { confirm.hidden = true; }, '', true)));
  confirm.hidden = true;
  const count = h('span', { class: 'hint' });
  const devices = h('div', { id: 'phone-devices', class: 'phone-devices' },
    h('strong', { text: 'Dispositivos' }), count, trusted(button('Desemparejar', () => { confirm.hidden = false; }, 'danger', true)), confirm);
  const message = h('div', { class: 'hub-note', role: 'status' });

  page.append(ctx.hero('phone', t('Android phone'), t('Your agents and their approvals on your Android phone, over your Wi-Fi.')),
    status, security,
    notchHint(t("Send your agents' sessions to Koda for Android and answer permission requests from the phone. Off by default; it only listens on your local network.")),
    notchRow(t('Phone link'), sw),
    notchHint('Muestra en el teléfono cuánto usaste de Claude y Codex.'),
    notchRow('Uso de los planes', usage), steps, qr, linkRow, devices, message);

  function paint() {
    const error = st?.error ?? null;
    const unknown = !st;
    const unsupported = error === 'unsupported' || (unknown && phoneUnsupported(refused));
    const enabled = st?.enabled === true, running = st?.running === true, clients = st?.clients ?? 0;
    // The switch mirrors the host: aria-pressed is the stored state, never the click's optimism.
    sw.setAttribute('aria-pressed', String(enabled));
    sw.classList.toggle('on', enabled);
    (sw as HTMLButtonElement).disabled = unknown || unsupported;
    // The plan switch mirrors the stored preference; until it has been read it stays inert instead of guessing «off».
    usage.setAttribute('aria-pressed', String(usageOn));
    usage.classList.toggle('on', usageOn);
    (usage as HTMLButtonElement).disabled = !usageKnown || usageBusy;
    let glyph = '○', word = 'Apagado';
    if (unknown) { glyph = unsupported ? '·' : '✗'; word = unsupported ? PHONE_ERRORS.unsupported : 'No se pudo leer el estado del enlace.'; }
    else if (error === 'unsupported') { glyph = '·'; word = PHONE_ERRORS.unsupported; }
    else if (error) { glyph = '✗'; word = PHONE_ERRORS[error] ?? 'No se pudo encender el enlace.'; }
    else if (!enabled) { glyph = '○'; word = 'Apagado'; }
    else if (!running) { glyph = '…'; word = 'Encendiendo…'; }
    else if (clients > 0) { glyph = '●'; word = phones(clients); }
    else if (st?.host) { glyph = '●'; word = `Escuchando en ${st.host}:${st.port}`; }
    else { glyph = '●'; word = `Escuchando en el puerto ${st!.port}`; }
    clear(status);
    status.append(icon(glyph), h('span', { class: 'state-word', text: word }));
    // QR: only while the link is really listening and the host handed a link to encode.
    const svg = st?.qrSvg ?? null, link = st?.link ?? null;
    clear(qr);
    if (running && svg) {
      qr.append(h('img', { class: 'phone-qr-img', src: `data:image/svg+xml;base64,${base64Utf8(svg)}`, alt: 'Código QR para emparejar' }));
      qr.hidden = false;
    } else qr.hidden = true;
    if (link && !unsupported) { linkField.value = link; linkRow.hidden = false; }
    else { linkField.value = ''; linkRow.hidden = true; }
    count.textContent = clients > 0 ? phones(clients) : 'Ninguno vinculado.';
  }
  async function turn(on: boolean) {
    if (busy) return;
    busy = true;
    try {
      const next = on ? await PhoneBridge.enable() : await PhoneBridge.disable();
      if (!life.alive()) return;
      if (next) { st = next; refused = ''; message.textContent = ''; }
      paint();
    }
    catch (error) {
      // A failed switch does not become a stored preference: the page goes back to what the host last said.
      if (!life.alive()) return;
      refused = phoneReason(error);
      message.textContent = phoneUnsupported(refused) ? PHONE_ERRORS.unsupported : 'No se pudo cambiar el enlace. No se anuncia ningún cambio como guardado.';
      paint();
    }
    finally { busy = false; }
  }
  async function copyLink() {
    const link = st?.link ?? '';
    if (!link) return;
    const clip = (globalThis as any).navigator?.clipboard;
    if (!clip?.writeText) { copyNote.textContent = 'No se pudo copiar: seleccioná el link y copialo a mano.'; return; }
    try { await clip.writeText(link); copyNote.textContent = 'Copiado.'; }
    catch { copyNote.textContent = 'No se pudo copiar: seleccioná el link y copialo a mano.'; }
  }
  async function setUsage(on: boolean) {
    if (usageBusy || !usageKnown) return;
    usageBusy = true;
    try {
      const view = await PrefsBridge.setPhoneUsage(on);
      if (life.alive() && view) { usageOn = view.phoneUsage === true; message.textContent = ''; }
    }
    catch {
      if (life.alive()) message.textContent = 'No se pudo guardar el uso de los planes. No se anuncia ningún cambio como guardado.';
    }
    finally {
      usageBusy = false;
      if (life.alive()) paint(); // a refused switch goes back to the stored value, never stays optimistic
    }
  }
  async function unpair() {
    try {
      const next = await PhoneBridge.unlink();
      if (!life.alive()) return;
      if (next) { st = next; refused = ''; message.textContent = ''; }
      confirm.hidden = true;
      paint();
    }
    catch {
      if (!life.alive()) return;
      confirm.hidden = true;
      message.textContent = 'No se pudo desemparejar: el teléfono sigue vinculado.';
    }
  }
  paint();
  try {
    const read = await PhoneBridge.status();
    if (read) { st = read; refused = ''; }
  }
  catch (error) { refused = phoneReason(error); }
  try {
    const view = await PrefsBridge.view();
    if (view) { usageOn = view.phoneUsage === true; usageKnown = true; }
  }
  catch { /* a host that cannot answer leaves the plan switch inert rather than showing an «off» nobody stored */ }
  if (!life.alive()) return;
  paint();
  await life.listen('phone:state', (next: PhoneStatus) => { if (!next) return; st = next; refused = ''; message.textContent = ''; paint(); });
};

export function renderUnavailable(page: string): HTMLElement {
  // The guard for a page with no renderer and no host of its own; every page that has one is wired above (the phone link is
  // `phonePage`, and the pause list decides what the menu shows).
  const control = button(t('Enable'), () => {});
  control.disabled = true;
  return card(row('pendiente de conectar', null, control));
}
// L42: the voice model is the SAME Parakeet the dictation uses, so these pages show the real control (download with
// progress, «Instalado», remove) and follow dictation:models; before, a static disabled «Descargar» read as «not installed».
function modelControl(container: HTMLElement, ctx: any): HTMLElement {
  const life = mount(container, ctx);
  return modelsControl(ctx, life);
}
// Pages `settings-app.js` spreads into the shell's flow renderers. `voice` keeps its inert first slice here (the live one is
// `voice-page.ts`, which overrides it) and `phone` is the live page above.
const inertPages: Partial<Record<PageId, FlowPageRenderer>> = Object.fromEntries(
  Object.entries(definitions).map(([page, [title, subtitle, action]]) => [page, (container: HTMLElement, ctx: any) => {
    if (page === 'voice') {
      // Adapted from Coucou src/hub/pages/voice.ts @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT.
      // Full default (voice off / system output) layout, no microphone, model or secret commands.
      const off = toggle(false, () => {}); (off as HTMLButtonElement).disabled = true;
      const download = modelControl(container, ctx);
      const output = segmented([['system', t('System voice')], ['elevenlabs', 'ElevenLabs'], ['off', t('Text only')]], 'system', () => {});
      for (const b of output.querySelectorAll('button')) (b as HTMLButtonElement).disabled = true;
      container.append(ctx.hero('voice', 'OK Koda', t(subtitle!)),
        label(t('Listening')),
        card(row(t('Listen for « OK Koda »'), t('The microphone stays open; only what follows « OK Koda » goes further.'), off), divider(),
          row(t('Parakeet, on your computer'), t('Hears « OK Koda » here, without the internet.'), download)),
        label(t('Answers')), card(row(t('Koda answers out loud'), null, output)),
        label(t('Privacy')), card(
          h('div', {class:'hub-note',text:t('Your voice never leaves this computer: Parakeet turns it into text here. Only the words after « OK Koda » go to Anthropic with your Claude key, and to ElevenLabs if you picked it for the answers.')}), divider(),
          h('div', {class:'hub-note',text:t('An email is never sent by Koda: your mail app opens with it written, and you send it.')})),
        h('div', {class:'hub-note',text:'pendiente de conectar'}));
      return;
    }
    const control = button(t(action), () => {}); control.disabled = true;
    const key = keyLabel(ctx.status.prefs.key, ctx.status.platform);
    container.append(ctx.hero(page, t(title), subtitle ? t(subtitle, { 0: key }) : null, []));
    container.append(h('div', { id: 'settings-root' }, card(row('pendiente de conectar', null, control))));
  }]),
);
export const inactivePages: Partial<Record<PageId, FlowPageRenderer>> = { phone: phonePage, ...inertPages };
