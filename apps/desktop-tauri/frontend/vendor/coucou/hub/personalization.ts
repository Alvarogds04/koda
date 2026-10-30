// Abito-owned migration of settings.js/runIntent and pill-settings.js, using literal MIT hub controls.
// Active pills adapted from Coucou src/settings/main.ts activePillsSection @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT.
import { h, clear } from '../views/dom.js';
import { pillDefinition } from '../core/pills.js';
import { t } from './i18n-es.js';
import { notchSection, notchRow, notchTipRow, notchTipSection, infoTip } from './notch.js';
import { card, row, select, toggle } from './ui.js';
import { action, field, note, section, trusted, session, preserveFocus } from './runtime.js';
declare const AbitoClay: { create(svg: SVGSVGElement, options: any): any };
function colors(V: any, A: any, prefs: any, identities: any[], save: any) {
  // #503 S19 (screen validation): the rows belong INSIDE the card; appending them to the section left an empty card above them.
  const rows: HTMLElement[] = [];
  for (const r of V.colorRows(prefs, identities, A)) {
    const options = h('div', { class: 'palette', role: 'group', 'aria-label': `Color de ${r.name}` });
    // The upstream palette class is an anchored popover; for an always-visible row use
    // the upstream segmented container, keeping literal .swatch/.on on its buttons.
    options.className = 'hub-segmented';
    for (const hex of A.HEX_PALETTE) {
      const o = { color: hex, label: A.label(hex), aria: `${r.name}: ${A.label(hex)}`, selected: A.normalizeChosenColor(r.color) === hex };
      const b = action(o.label, () => save({ action: 'set_avatar_color', identity: r.id, color: o.color }));
      b.className = o.selected ? 'swatch on' : 'swatch'; b.textContent = ''; b.title = o.label;
      b.setAttribute('id', `identity-${r.id}-${o.color}`); b.setAttribute('aria-label', o.aria); b.setAttribute('aria-pressed', String(o.selected));
      b.style.setProperty('background', hex);
      options.append(b);
    }
    rows.push(row(r.name, r.label, options));
  }
  return section('Colores de identidad', ...rows);
}

export async function renderAppearance({ invoke, listen, V, S, A }: any) {
  const s = session(invoke, listen), { root, call, work, watch, message } = s;
  let prefs: any = {}, store: any = null;
  let queue = Promise.resolve();
  const save = (p: any) => work(() => { queue = queue.catch(() => {}).then(() => call('prefs_action', p)); return queue; }, next => { prefs = next; message.textContent = 'Guardado.'; paint(); });
  function paint() {
    const restore = preserveFocus(root); clear(root);
    const theme = V.themeView(prefs), pick = trusted(select(theme.options.map((o: any) => [o.id, o.label]), theme.mode, value => save({ action: 'set_theme', theme: value })));
    pick.setAttribute('id', 'appearance-theme'); pick.setAttribute('aria-label', 'Tema');
    root.append(section('Tema', row('Tema', null, pick)), colors(V, A, prefs, [{id:A.PRINCIPAL_ID,name:'Koda'}, ...S.identityView(store).identities], save), section('Movimiento', row('Animación reducida', 'No disponible en esta ventana')), message);
    if (S.identityView(store).kind !== 'ready') root.append(note('Colores de especialistas no disponibles: no se pudieron cargar sus identidades.'));
    restore();
  }
  paint(); watch('prefs:state', p => { prefs = p; paint(); }); watch('specialists:state', p => { store = p; paint(); });
  work(() => call('prefs_action', {action:'view'}), p => { prefs = p; paint(); });
  work(() => call('specialists_action', {action:'view'}), p => { store = p; paint(); });
  return s.finish();
}

// 0.2.1 (Integraciones / Agentes split): `part` picks what this renderer draws. 'tools' = the main-tool selector (CLIs only);
// 'island' = the specialists' «En la isla» switches; 'abito' = Abito's instructions and the identity colours.
export async function renderPills({ invoke, listen, V, S, A, P, C, part = 'tools' }: any) {
  const s = session(invoke, listen), { root, call, work, watch, message } = s;
  // Product/Pestañas-activas: keep the selector below for a future release, unreachable for now.
  if (part === 'tools') {
    // Same non-interactive card/row pattern and wording as Notetaker in pages.ts.
    // HU-076: the main-tool selector is not available in this version, so nothing is shown (it used to say so in a card).
    return s.finish();
  }
  let prefs: any = {}, store: any = null, saving = false;
  const listing: any = null;
  let lastKey = '';
  const owned = () => S.storeView(store, listing);
  const agents = () => S.agentsView(store, prefs, A);
  const prefsCall = async (p: any) => { const next = await call('prefs_action', p); if (s.alive()) prefs = next; };
  // Same closed intent planner as legacy settings.js. No API for untrusted DOM events.
  function run(i: any) {
    if (saving || owned().kind !== 'ready') return;
    let plan: (() => Promise<any>) | null = null;
    switch(i.type) {
      case 'set_color': plan = () => prefsCall({action:'set_avatar_color',identity:i.id,color:i.color}); break;
      case 'island_toggle': { const cmd = P.islandToggleCommand(P.islandModel(prefs, agents(), undefined), i.kind, i.id); if (!cmd) return; plan = () => prefsCall(cmd); break; }
      case 'set_abito_instructions': plan = () => prefsCall({action:'set_abito_instructions',text:String(i.text)}); break;
      case 'prefs': plan = () => prefsCall(i.payload); break;
      default: return;
    }
    saving = true;
    // Disable mutations immediately, but preserve text fields across asynchronous publications.
    for (const b of root.querySelectorAll('button')) (b as HTMLButtonElement).disabled = true;
    work(plan!, () => { message.textContent = 'Guardado.'; }).finally(() => { saving = false; lastKey = ''; if (s.alive()) paint(); });
  }
  const principalInstructions = h('textarea',{id:'abito-instructions',class:'hub-input','aria-label':'Instrucciones de Koda'}) as HTMLTextAreaElement;
  let instructionsDraft = false;
  principalInstructions.addEventListener('input',e => { if(e.isTrusted) instructionsDraft = true; });
  function paint() {
    const key = JSON.stringify([prefs.avatarColors,prefs.pillColors,prefs.declaredPills,prefs.mainPill,prefs.islandAgents,prefs.abitoInstructions,store,saving]);
    if (key === lastKey) return; lastKey = key;
    const restore = preserveFocus(root); clear(root);
    // Dormant selector: the tools mount returns above before installing any handlers.
    if (part === 'tools') {
      const cur = P.normalize(prefs), choices = C.mainChoices();
      // 0.2.1 (S3): the main tool offers the CLIs only. A stored Cursor/Antigravity main is kept, shown as a disabled extra option.
      const options = choices.map((d: any) => [d.id,pillDefinition(d.id)?.name || d.name] as [string,string]);
      if (!options.some(([id]) => id === cur.mainPill)) options.push([cur.mainPill, pillDefinition(cur.mainPill)?.name || cur.mainPill]);
      const main = trusted(select(options,cur.mainPill,id => { if(P.chooseMain(cur,id)) run({type:'prefs',payload:{action:'set_main_pill',id}}); })); main.className = ''; main.disabled = saving; main.setAttribute('aria-label','Herramienta principal');
      root.append(notchSection(t('Main tool'), notchTipRow(t('Main tool'), 'Aparece primero en la isla; no instala nada.', main)));
    }
    if (part === 'island') {
      // ONE «En la isla» control for the specialists (S1/T2): the model is a pure read over the two stored lists; the write goes through
      // set_island_agents, so nothing stored changes shape. Pills (agents, services) toggle on their own pages through toggle_declared_pill.
      const m = P.islandModel(prefs, agents());
      const spec = notchTipSection('Especialistas', 'Los especialistas se definen en el código de Koda. Elegí cuáles se ven en la isla (hasta ' + m.specialistsMax + ').');
      const base = owned();
      if (base.kind !== 'ready') spec.append(note(base.persistenceNote || 'Leyendo especialistas…'));
      else {
        spec.append(h('div', { class: 'hint', role: 'status', text: `Especialistas ${m.specialistsOn}/${m.specialistsMax}` }));
        for (const e of m.specialists) {
          const sw = trusted(toggle(e.on, () => run({type:'island_toggle',kind:'specialist',id:e.id})));
          (sw as HTMLButtonElement).disabled = saving || (!e.on && m.specialistsFull); sw.setAttribute('aria-label', `En la isla: ${e.name}`); sw.setAttribute('aria-pressed', String(e.on));
          spec.append(notchRow(e.name, sw));
        }
      }
      root.append(spec);
    }
    if (part === 'abito') {
      if (!instructionsDraft) principalInstructions.value = prefs.abitoInstructions || '';
      principalInstructions.maxLength = S.MAX_INSTRUCTIONS;
      root.append(section('Koda',row('Instrucciones',null,infoTip('Se aplican a los próximos mensajes del chat de Koda.','Más información: Instrucciones'),principalInstructions,action('Guardar instrucciones',() => { run({type:'set_abito_instructions',text:principalInstructions.value}); }))),
        colors(V,A,prefs,[{id:A.PRINCIPAL_ID,name:'Koda'},...S.identityView(store).identities],(p: any) => run({type:'prefs',payload:p})));
    }
    root.append(message); restore();
  }
  paint(); watch('prefs:state',p => {prefs = p;paint();}); watch('specialists:state',p => {store = p;paint();});
  work(() => call('prefs_action',{action:'view'}),p => {prefs = p;paint();});
  work(() => call('specialists_action',{action:'view'}),p => {store = p;paint();});
  return s.finish();
}
