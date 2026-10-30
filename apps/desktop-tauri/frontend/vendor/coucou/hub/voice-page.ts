// Adapted from Coucou src/hub/pages/voice.ts @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT.
// Abito: the page is live through the closed `voice_action` command; keys stay in the keychain.
import { h } from '../views/dom.js';
import { card, row as plainRow, button, label, divider, toggle, segmented } from './ui.js';
import { t } from './i18n-es.js';
import { trusted } from './runtime.js';
import { infoTip } from './notch.js';
// 0.2.1 (S7, L2): a row's explanation is an ⓘ beside its title, not standing text under it.
const row = (title: string, detail: string | null, ...trailing: (HTMLElement | null)[]) =>
  detail && detail !== 'No disponible todavía' && detail !== 'No disponible' ? plainRow(title, null, infoTip(detail, `Más información: ${title}`), ...trailing) : plainRow(title, detail, ...trailing);
import { VoiceBridge, FlowBridge } from './flow-shim.js';
import type { HubContext } from './shell.js';

export async function voicePage(page: HTMLElement, ctx: HubContext) {
  let alive = true, st = await VoiceBridge.status();
  ctx.onLeave = () => { alive = false; };
  const message = h('div', { class: 'hub-note', role: 'status' });
  const apply = (next: any) => { if (alive && next) { st = next; draw(); } };
  const work = async (fn: () => Promise<any>) => {
    try { apply(await fn()); }
    catch { if (alive) { message.textContent = 'No se pudo completar. No se anuncia ningún cambio como guardado.'; } }
  };
  const save = (change: (p: any) => void) => work(() => { const p = { ...st!.prefs }; change(p); return VoiceBridge.setPrefs(p); });
  const box = h('div', {});
  // #503 S22 (Opción A): a live status banner on top. Every word comes from the REAL status (listening, models, error);
  // nothing is inferred from the preference alone.
  const banner = h('div', { id: 'voice-status', class: 'voice-status', role: 'status', 'aria-live': 'polite' });
  page.append(ctx.hero('voice', 'OK Koda', t('Say « OK Koda », then ask anything: add a pill, play music, the weather, an email to prepare.')), banner, box);
  function paintBanner() {
    banner.replaceChildren();
    const k = st?.vad?.state ?? 'missing', p = st?.parakeet?.state ?? 'missing';
    const [kind, icon, word] = !st ? ['unknown', '·', 'No disponible todavía']
      : st.error ? ['error', '✗', `Error: ${st.error}`]
      : (k === 'downloading' || p === 'downloading') ? ['busy', '…', 'Descargando modelos']
      : k !== 'ready' || p !== 'ready' ? ['error', '✗', 'Falta descargar los modelos']
      : st.prefs.enabled && st.listening ? ['on', '●', 'Escuchando']
      : st.prefs.enabled ? ['busy', '…', 'Activando']
      : ['off', '○', 'Apagado'];
    banner.className = `voice-status ${kind}`;
    banner.append(h('span', { class: 'state-ico', 'aria-hidden': 'true', text: icon }), h('span', { class: 'state-word', text: word }));
  }
  function modelControl(): HTMLElement {
    const el = h('div', { style: 'display:flex;align-items:center;gap:8px' });
    const k = st?.vad?.state ?? 'missing', p = st?.parakeet?.state ?? 'missing';
    const fraction = k === 'downloading' ? st!.vad.fraction : p === 'downloading' ? st!.parakeet.fraction : 0;
    if (k === 'downloading' || p === 'downloading') {
      const percent = Math.round(Math.max(0, Math.min(1, fraction ?? 0)) * 100);
      el.append(h('div', { class: 'hub-progress' }, h('i', { style: `width:${percent}%` })), h('span', { class: 'hub-note', text: `${percent} %` }));
    } else if (k === 'ready' && p === 'ready') {
      el.append(h('span', { class: 'hub-note', style: 'color:var(--hub-green)', text: `✓ ${t('Installed')}` }),
        trusted(button(t('Remove the models'), () => void work(VoiceBridge.remove), '', true)));
    } else {
      const err = st?.vad?.error ?? st?.parakeet?.error;
      if (err) el.append(h('span', { class: 'hub-note', text: err, title: err, style: 'max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }));
      el.append(trusted(button(err ? t('Retry') : t('Download'), () => void work(async () => {
        const next = await VoiceBridge.download();
        // The command is transcribed by Parakeet: ask for it too if it is missing (same closed dictation contract).
        if (p === 'missing' || p === 'failed') await FlowBridge.download();
        return next;
      }), 'primary')));
    }
    return el;
  }
  // «Entrenar mi voz»: the user says «OK Koda» TARGET times; the host hears each one through the live path.
  let hearing = false, training = false;
  function trainingCard(): HTMLElement {
    const tr = st?.training ?? { recorded: 0, target: 5, active: false, last: null, learned: {} };
    const learned = tr.learned ?? {};
    const phrases: string[] = [...(learned.phrases ?? []), ...(learned.names ?? [])].filter((x, i, a) => a.indexOf(x) === i);
    const ready = st?.vad?.state === 'ready' && st?.parakeet?.state === 'ready';
    const step = (fn: () => Promise<any>) => async () => { hearing = true; draw(); try { await work(fn); } finally { hearing = false; if (alive) draw(); } };
    const status = h('div', { id: 'voice-train-status', class: 'hub-note', role: 'status', 'aria-live': 'polite' });
    const controls = h('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap' });
    const done = tr.recorded >= tr.target;
    if (!ready) status.textContent = 'Primero descargá los modelos.';
    else if (hearing) status.textContent = `Escuchando… decí «OK Koda» (${Math.min(tr.recorded + 1, tr.target)}/${tr.target})`;
    else if (training || tr.active) {
      status.textContent = done ? `Listo ${tr.recorded}/${tr.target}. Guardá para que Koda te reconozca.`
        : tr.recorded === 0 ? `Decí «OK Koda» (1/${tr.target}).` : `Entendí: «${tr.last ?? ''}» — ${tr.recorded}/${tr.target}. Decilo otra vez.`;
    } else if (phrases.length) status.textContent = `Entendí: ${phrases.map(p => `«${p}»`).join(', ')} — listo`;
    else status.textContent = `Decí «OK Koda» ${tr.target} veces y Koda aprende cómo te entiende a vos. El audio no se guarda.`;
    if (ready && !hearing) {
      if (!(training || tr.active)) {
        controls.append(trusted(button('Entrenar mi voz', () => { training = true; void step(() => VoiceBridge.trainRecord())(); }, 'primary')));
        if (phrases.length) controls.append(trusted(button('Borrar entrenamiento', () => void work(VoiceBridge.trainReset), '', true)));
      } else {
        if (!done) controls.append(trusted(button('Grabar', () => void step(() => VoiceBridge.trainRecord())(), 'primary')));
        else controls.append(trusted(button('Guardar', () => void work(async () => { const next = await VoiceBridge.trainFinish(); training = false; return next; }), 'primary')));
        if (tr.recorded > 0) controls.append(trusted(button('Repetir la última', () => void work(VoiceBridge.trainUndo), '', true)));
        controls.append(trusted(button('Cancelar', () => void work(async () => { const next = await VoiceBridge.trainCancel(); training = false; return next; }), '', true)));
      }
    }
    return card(row('Entrenar mi voz', 'Koda aprende cómo se transcribe TU «OK Koda». Solo se guarda el texto, en este equipo.', controls), status);
  }
  // Ajustes → Voz, the Handy way: the language (Spanish by default), the models with size / languages /
  // state, and the custom words. Downloads are explicit; the one in use cannot be deleted.
  const LANG_NAMES: Record<string, string> = { es: 'Español', en: 'English', fr: 'Français', de: 'Deutsch', it: 'Italiano', pt: 'Português', ca: 'Català', auto: 'Automático' };
  function speechCard(): HTMLElement {
    const sp = st?.speech;
    if (!sp) return card(row('Modelo de voz', 'No disponible todavía'));
    const apply = (change: (s: any) => void) => void work(() => { const s = { language: sp.language, model: sp.model, words: [...sp.words] }; change(s); return VoiceBridge.setSpeech(s); });
    const lang = trusted(h('select', { id: 'voice-language', 'aria-label': 'Idioma de la voz' })) as HTMLSelectElement;
    for (const code of sp.languages as string[]) lang.append(h('option', { value: code, text: LANG_NAMES[code] ?? code, ...(code === sp.language ? { selected: 'selected' } : {}) }));
    lang.value = sp.language;
    lang.addEventListener('change', () => apply(s => { s.language = lang.value; }));
    const active = (sp.models as any[]).find(m => m.active);
    const langNote = h('div', { class: 'hub-note', text: active && !active.forcesLanguage ? `${active.name} elige el idioma solo y no admite fijarlo: para fijar el español usá un modelo Whisper.` : 'El idioma queda fijo: Koda no adivina otro.' });
    const list = h('div', { id: 'voice-models', style: 'display:flex;flex-direction:column;gap:6px' });
    for (const m of sp.models as any[]) {
      const downloading = m.state?.state === 'downloading';
      const pct = Math.round(Math.max(0, Math.min(1, m.state?.fraction ?? 0)) * 100);
      const state = m.active ? 'En uso' : downloading ? `Descargando ${pct} %` : m.installed ? 'Descargado' : m.state?.state === 'failed' ? `Falló: ${m.state.error}` : 'Sin descargar';
      const actions = h('div', { style: 'display:flex;gap:6px;align-items:center' });
      if (downloading) actions.append(trusted(button('Cancelar', () => void work(() => VoiceBridge.modelCancel(m.id)), '', true)));
      else if (!m.installed) actions.append(trusted(button(`Descargar ${m.sizeMb} MB`, () => void work(() => VoiceBridge.modelDownload(m.id)), 'primary')));
      else {
        if (!m.active) actions.append(trusted(button('Usar este', () => apply(s => { s.model = m.id; }), 'primary')));
        if (!m.active) actions.append(trusted(button('Borrar', () => void work(() => VoiceBridge.modelDelete(m.id)), '', true)));
      }
      list.append(row(`${m.name} · ${m.sizeMb} MB`, `${m.note} Idiomas: ${(m.languages as string[]).join(', ')}. Licencia: ${m.license}. ${state}.`, actions));
    }
    const words = trusted(h('textarea', { id: 'voice-words', rows: '3', 'aria-label': 'Palabras personalizadas', placeholder: 'Una por línea. «Abito» ya está incluida.', text: (sp.words as string[]).join('\n') })) as HTMLTextAreaElement;
    words.addEventListener('change', () => apply(s => { s.words = words.value.split('\n').map(w => w.trim()).filter(Boolean); }));
    return card(row('Idioma', 'El que escucha Koda para «OK Koda» y el dictado.', lang), langNote, divider(), list, divider(),
      row('Palabras personalizadas', 'Nombres o términos que Koda corrige al transcribir, además de «Koda».', words));
  }
  function draw() {
    box.replaceChildren();
    paintBanner();
    if (!st) { box.append(card(row(t('Dictation is off'), 'No disponible'))); return; }
    const output = segmented([['system', t('System voice')], ['elevenlabs', 'ElevenLabs'], ['off', t('Text only')]] as any, st.prefs.output, (v: any) => void save(p => { p.output = v; }));
    trusted(output);
    const sensitivity = trusted(h('input', { type: 'range', min: '0', max: '100', step: '5', value: String(st.prefs.sensitivity ?? 50), class: 'hub-range', 'aria-label': t('Wake-word sensitivity') })) as HTMLInputElement;
    sensitivity.addEventListener('change', () => void save(p => { p.sensitivity = Math.max(0, Math.min(100, Math.round(Number(sensitivity.value)))); }));
    const value = h('span', { id: 'voice-sensitivity-value', class: 'voice-sensitivity-value', text: `${st.prefs.sensitivity ?? 50} %` });
    sensitivity.setAttribute('aria-describedby', 'voice-sensitivity-value');
    sensitivity.addEventListener('input', () => { value.textContent = `${Math.max(0, Math.min(100, Math.round(Number(sensitivity.value))))} %`; });
    // «Probar» is a READ of the status: it never opens the microphone and says so (a real hearing test needs the wake loop).
    const result = h('div', { id: 'voice-probe-result', class: 'hub-note', role: 'status', 'aria-live': 'polite' });
    const probe = trusted(button('Consultar estado', () => void (async () => {
      let now: any = null; try { now = await VoiceBridge.status(); } catch { now = null; }
      if (!alive) return; if (now) { st = now; paintBanner(); }
      const live = now?.prefs?.enabled && now?.listening, pct = now?.prefs?.sensitivity ?? st?.prefs.sensitivity ?? 50;
      result.textContent = now ? `Sensibilidad ${pct} %. Ahora: ${live ? 'Escuchando' : now.prefs.enabled ? 'Activando' : 'Apagado'}. No se abrió el micrófono.` : 'No se pudo comprobar el estado.';
    })(), '', true));
    const privacy = h('details', { id: 'voice-privacy', class: 'voice-privacy' }, h('summary', { text: 'Privacidad' }),
      h('div', { class: 'hub-note', text: t('Your voice never leaves this computer: Parakeet turns it into text here. Only the words after « OK Koda » go to Anthropic with your Claude key, and to ElevenLabs if you picked it for the answers.') }),
      h('div', { class: 'hub-note', text: t('An email is never sent by Koda: your mail app opens with it written, and you send it.') }));
    box.append(
      label('Activación'),
      card(row(t('Listen for « OK Koda »'), t('The microphone stays open; only what follows « OK Koda » goes further.'), trusted(toggle(st.prefs.enabled, on => void save(p => { p.enabled = on; })))), divider(),
        row(t('Parakeet, on your computer'), t('Hears « OK Koda » here, without the internet.'), modelControl()), divider(),
        row(t('Wake-word sensitivity'), t('Higher hears « OK Koda » more easily, and mishears more.'), sensitivity, value, probe), result),
      label('Respuestas'), card(row(t('Koda answers out loud'), null, output)),
      // L2 «OK Koda: A · Avanzado desplegable»: the shared recognition model, language and training sit behind one fold.
      h('details', { id: 'voice-advanced', class: 'voice-advanced' }, h('summary', { text: 'Avanzado' }),
        label('Reconocimiento'), speechCard(), label('Entrenamiento'), trainingCard()),
      label('Privacidad'), card(privacy),
      message);
    if (st.error) message.textContent = st.error;
  }
  draw();
  const listen = (window as any).__TAURI__?.event?.listen;
  if (listen) {
    const off = await listen('voice-model', (e: any) => { if (alive && e?.payload) apply(e.payload); });
    const prev = ctx.onLeave; ctx.onLeave = () => { prev?.(); off(); };
  }
}
