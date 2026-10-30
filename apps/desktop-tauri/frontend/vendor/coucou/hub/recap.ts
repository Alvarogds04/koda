// Adapted from Coucou src/settings/main.ts recapRows @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT.
// Abito recap_cmd.rs: only prefs, set_enabled{enabled}, clear. No generic save.
import { h } from '../views/dom.js';
import { toggle } from './ui.js';
import { notchRow as row, infoTip } from './notch.js';
import { session, trusted } from './runtime.js';
import { t } from './i18n-es.js';
export async function renderRecapRows({invoke,listen,timers}:any) {
  const s=session(invoke,listen,timers),{root,call,work}=s;
  root.style.setProperty('display','contents');
  let known=false,enabled=false,busy=false;
  const feedback=h('span',{class:'hint'});
  const refresh=()=>{sw.classList.toggle('on',enabled);sw.setAttribute('aria-pressed',String(enabled));(sw as HTMLButtonElement).disabled=!known||busy;clear.disabled=!known||busy;};
  const sw=trusted(toggle(false,next=>{
    if(!known||busy||!s.alive())return;
    busy=true;refresh();
    work(()=>call('recap_action',{action:'set_enabled',enabled:next}),result=>{
      if(result?.ok!==true)throw Error('unconfirmed');enabled=next;
    },()=>{feedback.textContent='No se pudo guardar.';}).finally(()=>{busy=false;refresh();});
  }));sw.setAttribute('id','hub-recap');sw.setAttribute('aria-label',t('Weekly recap'));
  const clear=trusted(h('button',{id:'hub-recap-clear',class:'danger',text:t('Clear history')})) as HTMLButtonElement;
  clear.addEventListener('click',e=>{
    if(!e.isTrusted||!known||busy||!s.alive())return;
    busy=true;refresh();feedback.textContent='';
    work(()=>call('recap_action',{action:'clear'}),result=>{
      if(result?.ok!==true)throw Error('unconfirmed');feedback.textContent=t('History cleared.');
      s.later(()=>{feedback.textContent='';},2400);
    },()=>{feedback.textContent='No se pudo borrar el historial.';}).finally(()=>{busy=false;refresh();});
  });
  root.append(row(t('Weekly recap'),sw,infoTip(t('Keep a history of my coding sessions')+'. '+t('Counts and project names only — never commands, files or prompts. Kept on this computer for 12 weeks.'),'Más información: Resumen semanal')),
    row('',clear,feedback));
  refresh();
  work(()=>call('recap_action',{action:'prefs'}),prefs=>{
    if(typeof prefs?.enabled!=='boolean')return;known=true;enabled=prefs.enabled;refresh();
  },()=>{feedback.textContent='No disponible todavía';});
  return s.finish();
}
