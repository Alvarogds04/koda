// Probe-only browser driver. Compiled only through src/probe.rs (feature probe).
// Trusted clicks/keys are requested from the external validator, never injected
// by the app. Native reads and DOM reads are both required for a pass.
(() => {
  if (window.AbitoValidate) return;
  const errors = [];
  addEventListener('error', e => errors.push(String(e.message)));
  addEventListener('unhandledrejection', e => errors.push(String(e.reason)));
  const original = console.error;
  console.error = (...args) => { errors.push(args.map(String).join(' ')); original.apply(console, args); };
  let calls=Promise.resolve();
  const invoke = (command, payload) => {
    const next=calls.then(()=>new Promise(r=>setTimeout(r,120))).then(()=>window.__TAURI__.core.invoke(command,{payload}));
    calls=next.catch(()=>{}); return next;
  };
  const emit = (event, payload) => window.__TAURI__.event.emit(event, payload);
  const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
  async function wait(check, description, ms = 6500) {
    const deadline = performance.now() + ms;
    let value;
    while (performance.now() < deadline) {
      value = await check(); if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`tiempo agotado: ${description}`);
  }
  const visible = el => !!el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0 && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[hidden],[inert]');
  async function click(target) {
    const locate = typeof target === 'function' ? target : () => target;
    let el = typeof target === 'function'
      ? await wait(() => { const e=locate(); return e && !e.disabled && visible(e) && e; }, 'control vivo y visible')
      : locate();
    if (!el || el.disabled) throw new Error('control ausente o deshabilitado');
    el.scrollIntoView({ block: 'center', inline: 'center' }); await frame(); await frame();
    // IPC-backed settings pages may repaint during the two layout frames.
    // Re-resolve selectors; never click a detached switch from a prior render.
    el = locate();
    if (!el || el.disabled) throw new Error('control ausente o deshabilitado');
    const r = el.getBoundingClientRect(), o = window.__validateOrigin;
    if (!visible(el)) throw new Error(`control no visible: ${el.id || el.className}; phase=${byId('capsule')?.dataset.phase}`);
    await emit('validate-input', { kind:'click', x:Math.round(o.x + (r.x+r.width/2)*o.scale), y:Math.round(o.y + (r.y+r.height/2)*o.scale) });
  }
  async function key(key) { await emit('validate-input', { kind:'key', key }); }
  const byId = id => document.getElementById(id);
  async function chatFirst() {
    await invoke('chat_action', {action:'check'});
    await wait(async () => (await invoke('chat_action',{action:'view'})).availability?.state === 'ready', 'modelo falso listo');
    const input = byId('chat-input');
    input.value = 'primera pregunta del validador'; input.dispatchEvent(new Event('input'));
    await wait(() => !byId('chat-send').disabled, 'Enviar habilitado');
    await click(byId('chat-send'));
    const stale = await wait(async () => { const v=await invoke('chat_action',{action:'view'}); return v.active_turn && v; }, 'turno en curso');
    const terminal = await wait(async () => { const v=await invoke('chat_action',{action:'view'}); return !v.active_turn && v.turns.some(t=>t.state==='completed' && t.reply.includes('respuesta del validador')) && v; }, 'respuesta completada', 15000);
    await wait(() => !input.disabled && byId('chat-log').textContent.includes('respuesta del validador'), 'respuesta dibujada');
    window.__validateChat = { stale, terminal };
    const cancel=byId('chat-cancel');
    const observer=new MutationObserver(records=>{
      if(records.some(r=>r.oldValue===null) || !cancel.hidden) window.__validateChat.cancel_was_shown=true;
    });
    observer.observe(cancel,{attributes:true,attributeFilter:['hidden'],attributeOldValue:true});
    window.__validateChat.observer=observer;
    const turn=stale.turns.at(-1);
    window.__validateChat.unlisten=await window.__TAURI__.event.listen('chat:state', e=>{
      const t=e.payload?.turns?.find(t=>t.turn_id===turn.turn_id);
      if(t?.seq!==turn.seq) return;
      window.__validateChat.staleObservation={composer_enabled:!input.disabled,cancel_visible:visible(byId('chat-cancel')),state:byId('chat-state').outerHTML};
    });
    return {ok:true, stale, terminal};
  }
  async function chatSecond() {
    // Rust publishes the captured in-flight snapshot AFTER completed, on the
    // same event lane as a delayed real publisher. An RPC cannot mask it here.
    await frame(); await frame();
    const {stale, terminal,staleObservation,unlisten} = window.__validateChat;
    if(unlisten) unlisten();
    window.__validateChat.observer.disconnect();
    if(window.__validateChat.cancel_was_shown) return {ok:false,reason:'snapshot tardío volvió a mostrar Cancelar (turno en curso)',staleObservation};
    if(!staleObservation) return {ok:false,reason:'no se observó la entrega del snapshot tardío'};
    if(!staleObservation.composer_enabled || staleObservation.cancel_visible) return {ok:false,reason:'snapshot tardío volvió a bloquear el compositor',staleObservation};
    const input=byId('chat-input'), state=byId('chat-state');
    if (input.disabled || state.dataset.kind === 'busy' || visible(byId('chat-cancel'))) return {ok:false,reason:'snapshot tardío volvió a bloquear el compositor',state:state.outerHTML};
    input.value='segunda pregunta en la misma conversación'; input.dispatchEvent(new Event('input'));
    if (byId('chat-send').disabled) return {ok:false,reason:'Enviar sigue bloqueado tras completed',state:state.outerHTML};
    await click(byId('chat-send'));
    const second=await wait(async()=>{const v=await invoke('chat_action',{action:'view'});return !v.active_turn && v.turns.filter(t=>t.state==='completed').length===2 && v;},'segundo turno completado',15000);
    await wait(()=>!input.disabled && !visible(byId('chat-cancel')), 'compositor libre tras segundo turno');
    return {ok:second.conversation_id===terminal.conversation_id,reason:'el segundo mensaje cambió de conversación',conversation_id:second.conversation_id,turns:second.turns,stale_seq:stale.turns.at(-1)?.seq,completed_seq:terminal.turns.at(-1)?.seq,composer_enabled:!input.disabled,staleObservation,state:state.outerHTML};
  }
  async function dictationIdle() {
    const s=await invoke('dictation_action',{action:'status'});
    const prefs=Object.fromEntries(['enabled','key','edge','mic','keepDays','cleanup','defaultStyle'].map(k=>[k,s.prefs[k]]));
    await invoke('dictation_action',{action:'set_prefs',prefs:{...prefs,enabled:true}});
    // The real pill refreshes status on open, with a five-second throttle.
    // Force that PUBLIC lifecycle after enabling, so a hidden pill with a
    // stale disabled status cannot give us a false pass.
    await invoke('desktop_action',{action:'close'});
    await new Promise(resolve=>setTimeout(resolve,5200));
    await invoke('desktop_action',{action:'expand'});
    await new Promise(resolve=>setTimeout(resolve,1000));
    await wait(()=>document.querySelector('.dpill'), 'pill montada');
    await frame(); await frame();
    const pill=document.querySelector('.dpill'), css=getComputedStyle(pill), rect=pill.getBoundingClientRect();
    return {ok:pill.hidden && css.display==='none' && rect.width===0 && rect.height===0,reason:'pill de dictado visible en idle con función habilitada',hidden:pill.hidden,display:css.display,rect:[rect.width,rect.height],phase:byId('capsule').dataset.dictation||'idle'};
  }
  let edgeIdlePrefs;
  async function edgeIdle() {
    edgeIdlePrefs=await invoke('prefs_action',{action:'view'});
    // human decision: «Ocultar tras» is SECONDS (5..300); 5 s keeps the scene short. Restored by edgeWake.
    await invoke('prefs_action',{action:'set_absence_seconds',seconds:5});
    await invoke('prefs_action',{action:'sound_on'});
    await emit('validate-input',{kind:'move',x:20,y:500});
    await invoke('desktop_action',{action:'close'});
    const began=performance.now();
    await wait(()=>byId('capsule').dataset.edgeHidden==='true' && byId('island').getBoundingClientRect().bottom<=8.1,'ausencia de 5 s deja franja',15000);
    const native=await invoke('desktop_action',{action:'snapshot'});
    const elapsed=performance.now()-began;
    return {ok:native.state==='compact' && elapsed>=4000 && elapsed<=15000,elapsed,native:native.state,bottom:byId('island').getBoundingClientRect().bottom};
  }
  async function edgeWake() {
    const o=window.__validateOrigin, r=byId('island').getBoundingClientRect();
    const x=Math.round(o.x+(r.x+r.width/2)*o.scale);
    await emit('validate-input',{kind:'move',x,y:Math.round(o.y+12*o.scale)});
    await new Promise(resolve=>setTimeout(resolve,350));
    const through=byId('capsule').dataset.edgeHidden==='true';
    await emit('validate-input',{kind:'move',x,y:Math.round(o.y+2*o.scale)});
    await wait(()=>byId('capsule').dataset.edgeHidden==='false' && byId('island').getBoundingClientRect().bottom>=31.9,'mouse en franja restaura barra');
    await invoke('prefs_action',{action:'set_absence_seconds',seconds:edgeIdlePrefs.absenceSeconds});
    await invoke('prefs_action',{action:edgeIdlePrefs.sound ? 'sound_on':'sound_off'});
    await emit('validate-input',{kind:'move',x:20,y:500});
    await invoke('desktop_action',{action:'expand'});
    return {ok:through,inputBelowStripPassedThrough:through};
  }
  async function islandHoverPin() {
    const original = await invoke('prefs_action',{action:'view'});
    const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
    const phase = () => byId('capsule').dataset.phase;
    const move = (x,y) => emit('validate-input',{kind:'move',x:Math.round(x),y:Math.round(y)});
    const outside = () => move(20,500);
    const inside = async () => {
      const r=byId('capsule').getBoundingClientRect(), o=window.__validateOrigin;
      await move(o.x+(r.x+r.width/2)*o.scale,o.y+(byId('capsule').dataset.edgeHidden==='true' ? 2 : r.y+8)*o.scale);
    };
    try {
      await invoke('prefs_action',{action:'set_island_interaction',auto_close_seconds:5,open_on_hover:false});
      await outside(); await invoke('desktop_action',{action:'close'});
      await wait(()=>phase()==='compact','compacto antes del hover');
      await inside(); await delay(700);
      const hoverOff=await invoke('desktop_action',{action:'snapshot'});
      await outside();
      await invoke('prefs_action',{action:'set_island_interaction',auto_close_seconds:5,open_on_hover:true});
      await inside();
      // Read native state immediately on the next IPC round trip, not after
      // the spring lands. An enter dwell would still report compact here.
      const entered=await invoke('desktop_action',{action:'snapshot'});
      await wait(()=>phase()==='expanded','hover abre sin dwell');
      await outside(); await delay(200);
      const grace=await invoke('desktop_action',{action:'snapshot'});
      await wait(()=>phase()==='compact','600ms de gracia y animación de cierre');
      await inside(); await wait(()=>phase()==='expanded','segunda entrada abre');
      await click(byId('island-pin'));
      await wait(()=>byId('island-pin').getAttribute('aria-pressed')==='true','pin confirmado');
      await outside(); await delay(5400);
      const held=await invoke('desktop_action',{action:'snapshot'});
      const noCountdown=byId('island-countdown').hidden;
      await click(byId('island-pin'));
      await wait(()=>byId('island-pin').getAttribute('aria-pressed')==='false','desfijado confirmado');
      await outside();
      await wait(()=>!byId('island-countdown').hidden,'cuenta atrás visible');
      await wait(()=>phase()==='compact','cierre tras desfijar',7000);
      const closed=await invoke('desktop_action',{action:'snapshot'});
      await invoke('prefs_action',{action:'sound_off'});
      await wait(()=>byId('capsule').dataset.edgeHidden==='true' && byId('island').getBoundingClientRect().bottom<=8.1,'mute oculta hacia borde');
      const mutedStrip=byId('island').getBoundingClientRect().bottom;
      await inside(); await wait(()=>byId('capsule').dataset.edgeHidden==='false','mouse despierta isla silenciada');
      return {mutedStrip,ok:hoverOff.state==='compact' && entered.state==='expanded' && grace.state==='expanded' && held.state==='expanded' && noCountdown && closed.state==='compact',hoverOff:hoverOff.state,entered:entered.state,grace:grace.state,held:held.state,noCountdown,closed:closed.state,
        coverage:'XTest immediate hover-on/off, leave grace, pin/countdown, mute slides up leaving the 8px zone (24px hidden offset) and pointer wakes it; absence/mask covered in edgeIdle/edgeWake'};
    } finally {
      await outside();
      await invoke('prefs_action',{action:original.sound ? 'sound_on':'sound_off'});
      await invoke('prefs_action',{action:'set_island_interaction',auto_close_seconds:original.autoCloseSeconds,open_on_hover:original.openOnHover});
      await invoke('desktop_action',{action:'expand'});
      await wait(()=>phase()==='expanded','overview restaurado');
    }
  }
  async function sessions() {
    const seen=[byId('overview-view').textContent];
    // Observe actual rendered text during initial asynchronous request and at
    // least two ticker polls; even a transient unavailable message is a failure.
    const observer=new MutationObserver(()=>seen.push(byId('overview-view').textContent));
    observer.observe(byId('overview-view'),{subtree:true,childList:true,characterData:true});
    try {
      await invoke('agent_action',{action:'view'});
      let last;
      try { await wait(async()=>{await invoke('agent_action',{action:'view'});last=await invoke('agent_action',{action:'sessions_list'}); return last.connection==='connected' && Array.isArray(last.sessions?.rows);},'daemon conectado y lista de sesiones',15000); }
      catch { const unavailable=seen.some(t=>t.includes('Sesiones no disponibles')); return {ok:false,reason:unavailable ? 'ticker mostró Sesiones no disponibles con daemon conectado' : 'daemon conectado pero sessions_list no devolvió una lista (no es una lista vacía)',unavailable_seen:unavailable,last}; }
      // Isolation: earlier scenes may leave a main pill (e.g. Claude) that owns the card. Focus the
      // validator's own Pi session through the public mini control before asserting its steps.
      const ownRow=(last.sessions.rows||[]).find(r=>r.tools?.total===2);
      if(ownRow) {
        if(byId('capsule').dataset.phase!=='compact') { await invoke('desktop_action',{action:'close'}); await wait(()=>byId('capsule').dataset.phase==='compact','barra compacta'); }
        const mini=await wait(()=>byId('mini-grid')?.querySelector(`[data-session-id="${ownRow.id}"]`),'mini de la sesión propia');
        await click(mini);
        await invoke('desktop_action',{action:'expand'});
        await wait(()=>byId('capsule').dataset.phase==='expanded','isla expandida');
      }
      const until=performance.now()+4500;
      while(performance.now()<until){ seen.push(byId('overview-view').textContent); await frame(); }
      const s=await invoke('agent_action',{action:'view'});
      const card=byId('overview-view');
      const rows=s.sessions?.rows || [];
      const count=card.querySelector('.who .count');
      const internal=rows.find(r=>r.tools?.total===2);
      const truthfulSteps=!!internal && internal.tools.steps.map(s=>s.name).join(',')==='read,bash' && internal.tools.steps.every(s=>s.state==='done') && count && !count.hidden && count.textContent==='2/2' && card.textContent.includes('read') && card.textContent.includes('bash');
      const external=rows.find(r=>!r.tools);
      const externalHonest=!external || window.AbitoSessionsTicker.feed(window.AbitoSessionsTicker.newMemory(),{state:'ready',rows:[external],truncated:false}).who.count==='';
      return {ok:!seen.some(t=>t.includes('Sesiones no disponibles')) && truthfulSteps && externalHonest,reason:'faltan dos herramientas reales proyectadas y contador 2/2, o se inventan pasos externos',connection:s.connection,rows:s.sessions?.rows,truthfulSteps,externalHonest,observations:seen.length,unavailable_seen:seen.some(t=>t.includes('Sesiones no disponibles')),empty_state:card.textContent};
    } finally { observer.disconnect(); }
  }
  let focusPrefs;
  async function sessionsFocus() {
    focusPrefs=await invoke('prefs_action',{action:'view'});
    const s=await invoke('agent_action',{action:'sessions_list'});
    const own=s.sessions.rows.find(r=>r.tools?.total===2);
    const beta=s.sessions.rows.find(r=>r.kind==='codex' && r.cwd==='proyecto-beta');
    if(!own || !beta) return {ok:false,reason:'faltan los dos proyectos privados',rows:s.sessions.rows};
    // A+E: the centre column names the focused session (the old who-row text is hidden); the SAME focus drives the ↗ jump
    const centreName=()=>byId('overview-view').querySelector('.centre-name')?.textContent||'';
    const who=centreName;
    await invoke('prefs_action',{action:'set_main_pill',id:'agent_codex'});
    await wait(()=>centreName()==='proyecto-beta' && byId('pill-name').textContent==='proyecto-beta','principal Codex cambia el centro');
    const mainReadback=await invoke('prefs_action',{action:'view'});
    await invoke('desktop_action',{action:'close'});
    await wait(()=>byId('capsule').dataset.phase==='compact','barra compacta');
    await click(byId('mini-grid').querySelector(`[data-session-id="${own.id}"]`));
    await invoke('desktop_action',{action:'expand'});
    await wait(()=>who()===own.cwd && byId('capsule').dataset.phase==='expanded' && visible(byId(`pill-choice-${beta.id}`)),'mini enfoca proyecto interno');
    const miniFocused=who();
    await click(byId(`pill-choice-${beta.id}`));
    await wait(()=>who()==='proyecto-beta','píldora enfoca segundo proyecto');
    const jump=byId('session-jump');
    const launchesBefore=window.__validatorTerminalLaunches||0;
    await click(jump);
    await wait(()=>!jump.disabled && (window.__validatorTerminalLaunches||0)>launchesBefore,'el salto pide abrir una terminal (lanzador falso del validador)');
    const launchRequested=(window.__validatorTerminalLaunches||0)===launchesBefore+1 && !byId('pill-live').textContent.includes('No se pudo abrir una terminal');
    const count=byId('overview-view').querySelector('.who .count');
    // human: no placeholder at all — a session without real tool steps shows NO ticker row (and no «Sin pasos…» text)
    const tickerEl=byId('overview-view').querySelector('.ticker');
    const noFakeSteps=count.hidden && (!tickerEl || tickerEl.hidden) && !byId('overview-view').textContent.includes('Sin pasos de herramientas');
    const grid=[...byId('pill-choices').children].map(n=>n.dataset.pillId);
    // A+E: every session is a row of the scrolling blobs column (no 2x2 cap) and the focused one stays, marked pressed
    const focusedRowPressed=byId(`pill-choice-${beta.id}`)?.getAttribute('aria-pressed')==='true';
    return {ok:mainReadback.mainPill==='agent_codex' && miniFocused===own.cwd && noFakeSteps && grid.includes(own.id) && grid.includes(beta.id) && focusedRowPressed && launchRequested && jump.getAttribute('aria-label').includes('Abrir una terminal') && !jump.getAttribute('aria-label').includes('por clase'),mainReadback:mainReadback.mainPill,miniFocused,focused:who(),grid,noFakeSteps,launchRequested,jump:jump.getAttribute('aria-label'),reason:'foco, principal, cuadrícula o salto a terminal no coinciden'};
  }
  async function restoreSessionFocus() {
    if(focusPrefs) await invoke('prefs_action',{action:'set_main_pill',id:focusPrefs.mainPill});
    await invoke('desktop_action',{action:'expand'});
    await wait(()=>byId('capsule').dataset.phase==='expanded' && visible(byId('overview-view')),'overview restaurado');
    return {ok:true};
  }
  async function connection(connected) {
    const word=byId('connection-word');
    const snapshot=await wait(async()=>{const s=await invoke('desktop_action',{action:'snapshot'});return (connected ? s.connections>0 : s.connections===0) && s;},'conexiones nativas Pi');
    // Do not accept the previous disconnected/connected label before its event
    // paints. Check the settled label repeatedly, not merely one early match.
    await new Promise(resolve=>setTimeout(resolve,500));
    const words=[];
    for(let i=0;i<4;i++){words.push(word.textContent);await new Promise(resolve=>setTimeout(resolve,250));}
    return {ok:words.every(w=>connected ? w!=='Sin motor' : w==='Sin motor'),reason:'etiqueta Sin motor no coincide con conexiones reales',word:word.textContent,words,connections:snapshot.connections,aria:byId('connection')?.getAttribute('aria-label')};
  }
  let cyclePrefs;
  async function prepareNoticeCycle() {
    cyclePrefs=await invoke('prefs_action',{action:'view'});
    await invoke('prefs_action',{action:'set_island_interaction',auto_close_seconds:0,open_on_hover:false});
    await invoke('desktop_action',{action:'close'});
    await emit('validate-input',{kind:'move',x:20,y:500});
    await wait(()=>byId('capsule').dataset.phase==='compact','nativo y DOM compactos antes del ciclo');
    return {ok:true};
  }
  async function noticeCycle() {
    const began=performance.now();
    try {
    await wait(()=>byId('capsule').dataset.phase==='expanded' && byId('capsule').dataset.view==='notices' && byId('notice-card-name').textContent==='Ciclo dos','terminado nuevo abre su vista automáticamente');
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,4800-(performance.now()-began))));
    const held=byId('capsule').dataset.view==='notices';
    await wait(()=>byId('capsule').dataset.phase==='compact' && byId('capsule').dataset.view==='overview','terminado vuelve a compacto tras 5.2s',3500);
    const elapsed=performance.now()-began;
    const folded=await invoke('desktop_action',{action:'snapshot'});
    await invoke('prefs_action',{action:'sound_off'});
    // human decision: only a pending question blocks the edge hide, so the retained notices do NOT keep the island out of the edge
    const retainedDoesNotBlockEdge=await wait(()=>byId('capsule').dataset.edgeHidden==='true','avisos retenidos no frenan ocultar',5000).then(()=>true,()=>false);
    await invoke('prefs_action',{action:cyclePrefs.sound ? 'sound_on':'sound_off'});
    await invoke('desktop_action',{action:'expand'});
    await wait(()=>byId('capsule').dataset.phase==='expanded','reabre historial sin reiniciar terminado');
    const historical=byId('capsule').dataset.view==='overview';
    await click(byId('notice-action'));
    await wait(()=>visible(byId('notice-list')),'historial agrupado');
    const before=(await invoke('desktop_action',{action:'snapshot'})).notices.length;
    await click(byId('notice-rows').querySelector('.notice-list-dismiss'));
    await wait(async()=> (await invoke('desktop_action',{action:'snapshot'})).notices.length===before-1,'descarta exactamente una fila');
    await click(byId('notice-clear'));
    await wait(async()=> !(await invoke('desktop_action',{action:'snapshot'})).notices.length,'descarta todos conserva el contrato');
    return {ok:held && elapsed>=5000 && folded.state==='compact' && folded.notices.length>=2 && historical && retainedDoesNotBlockEdge,held,elapsed,native:folded.state,retained:folded.notices.length,historical,retainedDoesNotBlockEdge,groupedDismissal:true};
    } finally {
      await invoke('prefs_action',{action:'set_island_interaction',auto_close_seconds:cyclePrefs.autoCloseSeconds,open_on_hover:cyclePrefs.openOnHover});
      await invoke('prefs_action',{action:cyclePrefs.sound ? 'sound_on':'sound_off'});
    }
  }
  let noticeEdgeSound=true;
  async function prepareNoticeEdge() {
    noticeEdgeSound=(await invoke('prefs_action',{action:'view'})).sound;
    await invoke('prefs_action',{action:'sound_off'});
    byId('chat-input').value=''; byId('chat-input').dispatchEvent(new Event('input')); byId('chat-input').blur();
    await invoke('desktop_action',{action:'expand'});
    await wait(()=>byId('capsule').dataset.phase==='expanded','prepara isla antes del aviso');
    const r=byId('island').getBoundingClientRect(),o=window.__validateOrigin;
    await emit('validate-input',{kind:'move',x:Math.round(o.x+(r.x+r.width/2)*o.scale),y:Math.round(o.y+10*o.scale)});
    await wait(()=>byId('capsule').matches(':hover'),'puntero entra antes de salir');
    await emit('validate-input',{kind:'move',x:20,y:500});
    await wait(()=>!byId('capsule').matches(':hover'),'puntero fuera antes de plegar');
    await invoke('desktop_action',{action:'close'});
    await wait(()=>byId('capsule').dataset.edgeHidden==='true','oculta antes de aviso real');
    return {ok:true};
  }
  async function notice() {
    await wait(()=>byId('notices').textContent.includes('Validador'),'aviso Pi visible');
    await wait(()=>byId('capsule').dataset.edgeHidden==='false' && byId('capsule').dataset.phase==='expanded','aviso real despierta borde');
    await invoke('prefs_action',{action:noticeEdgeSound ? 'sound_on':'sound_off'});
    return {ok:true,text:byId('notices').textContent,edgeRevealed:true};
  }
  async function shortcutDispatch() {
    for(const id of ['openChat','goToAlert','muteToggle','jumpToTerminal']) {
      await invoke('hotkey_action',{id,action:'disable'});
      await invoke('hotkey_action',{id,action:'enable'});
    }
    await invoke('desktop_action',{action:'hide'});
    await key('Ctrl+Alt+space');
    await wait(()=>byId('capsule').dataset.view==='chat' && visible(byId('chat-input')) && document.activeElement===byId('chat-input'),'atajo abre chat oculto con foco');
    const chat=await invoke('chat_action',{action:'view'});
    const before=await invoke('prefs_action',{action:'view'});
    await key('Ctrl+Alt+s');
    const muted=await wait(async()=>{const p=await invoke('prefs_action',{action:'view'});return p.sound!==before.sound && p;},'mute global persistido');
    await wait(()=>byId('toggle-sound').getAttribute('aria-pressed')===String(!muted.sound),'mute dibujado');
    // A second deliberate press, outside the shared X11/portal dedup window.
    await new Promise(resolve=>setTimeout(resolve,300));
    await key('Ctrl+Alt+s');
    await wait(async()=> (await invoke('prefs_action',{action:'view'})).sound===before.sound,'sonido restaurado');
    await key('Ctrl+Alt+Shift+a');
    await wait(()=>byId('notice-live').textContent==='No hay permisos ni preguntas pendientes.','alerta vacía explica que no hay solicitud');
    // The previous scene (sesiones-foco-pildoras) leaves a session focused, and since fc7f679 the shortcut then opens THAT session's own terminal
    // (found from /proc), not the class fixture this scene's native readback expects. Publish «no focused session» through the event island.js
    // already listens to, right before the press (the key is read at press time; the 2 s ticker poll cannot restore it in between).
    document.dispatchEvent(new CustomEvent('abito:sessions-view',{detail:{view:null,focusId:null}}));
    await key('Ctrl+Alt+t');
    // fc7f679: with a session focused the shortcut opens THAT session's terminal («focused-session»); «focused-class» is the plain verb with none
    await wait(()=>['focused-session','focused-class'].includes(byId('capsule').dataset.shortcutTerminal),'terminal confirmó foco (de la sesión enfocada o, sin ella, por clase)');
    // fc7f679: with a session focused (the previous scene leaves one) the shortcut opens THAT session's own terminal, found from /proc; only
    // with none focused is it the class fixture. Say which one happened so the native readback is judged against the right expectation.
    const mode=byId('capsule').dataset.shortcutTerminal;
    return {ok:true,chat_view:chat.view,sound_before:before.sound,sound_after:muted.sound,terminal_mode:mode,class_only:mode==='focused-class',terminal:mode==='focused-session'?'session-key focus_host (the session\'s own terminal); class fixture not expected':'class-based focus_host; native X11 readback follows'};
  }
  // Human (21/10): with no terminal open, «ir a la terminal» opens a new one (55b69b9). The validation
  // build swaps the real spawn for a fake launcher that only counts, so nothing opens on the desktop.
  async function shortcutTerminalAbsent() {
    const before=window.__validatorTerminalLaunches||0;
    await key('Ctrl+Alt+t');
    await wait(()=>['focused-session','focused-class'].includes(byId('capsule').dataset.shortcutTerminal) && (window.__validatorTerminalLaunches||0)>before,'sin terminal abierta, el atajo pide abrir una (lanzador falso)');
    const launched=(window.__validatorTerminalLaunches||0)===before+1;
    return {ok:launched,launches:(window.__validatorTerminalLaunches||0)-before,reason:launched?'':'el atajo no pidió exactamente una terminal'};
  }
  async function shortcutAlert() {
    const before=await wait(async()=>{const v=await invoke('question_action',{action:'view'});return v.pending && v;},'request pendiente');
    await key('Ctrl+Alt+space');
    await wait(()=>byId('capsule').dataset.view==='chat','chat antes de saltar a alerta');
    await key('Ctrl+Alt+Shift+a');
    await wait(()=>byId('capsule').dataset.view==='overview' && visible(byId('question')),'alerta pendiente visible');
    const sound=(await invoke('prefs_action',{action:'view'})).sound;
    await invoke('prefs_action',{action:'sound_off'});
    await emit('validate-input',{kind:'move',x:20,y:500});
    let closeRefused=false;
    try { await invoke('desktop_action',{action:'close'}); }
    catch(error) { if(error.code!=='question_pending') throw error; closeRefused=true; }
    await new Promise(resolve=>setTimeout(resolve,1800));
    const neverConcealed=byId('capsule').dataset.edgeHidden!=='true';
    await invoke('desktop_action',{action:'expand'});
    await wait(()=>byId('capsule').dataset.phase==='expanded' && visible(byId('question')),'tarjeta preservada tras plegar');
    await invoke('prefs_action',{action:sound ? 'sound_on':'sound_off'});
    const after=await invoke('question_action',{action:'view'});
    return {ok:neverConcealed && JSON.stringify(before.pending)===JSON.stringify(after.pending),neverConcealed,closeRefused,before:before.pending,after:after.pending,text:byId('question').textContent};
  }
  async function answerQuestion() {
    const button=await wait(()=>[...document.querySelectorAll('#question-options .q-option')].find(b=>visible(b) && b.textContent.includes('Validar')),'pregunta y opción de Pi');
    const text=byId('question')?.textContent || button.parentElement.textContent;
    await click(button);
    return {ok:true,text,input:'XTest sobre opción real de la isla'};
  }
  async function gear() {
    await invoke('desktop_action',{action:'expand'});
    await new Promise(resolve=>setTimeout(resolve,500));
    await click(visible(byId('open-settings')) ? byId('open-settings') : byId('open-screen-settings'));
    return {ok:true,input:'XTest sobre engranaje público'};
  }
  async function snapshot() {
    return {prefs:await invoke('prefs_action',{action:'view'}),dictation:(await invoke('dictation_action',{action:'status'})).prefs,voice:(await invoke('voice_action',{action:'status'})).prefs};
  }
  // 0.1.2: paused pages are hidden from the menu, so a page is found by its own data-page, never by position.
  const hubButton=page=>document.querySelector(`.hub-side .hub-item[data-page="${page}"]`);
  async function hub(_index, page) { // probe.rs still passes the catalog position; the page id is what finds the button
    const button=hubButton(page);
    if (!button) return {ok:true,hidden:true,page,input:'página en pausa: oculta en el menú'};
    const previous=document.querySelector('.hub-page');
    await click(button);
    await wait(()=>button.classList.contains('on') && document.querySelector('.hub-page')!==previous,'página '+page);
    const root=document.querySelector('.hub-page');
    await wait(()=>root.textContent.trim().length>20 && root.querySelector('button,input,select,textarea'), 'contenido y controles '+page);
    const text=root.textContent;
    if (/No se pudieron (leer|abrir) los ajustes/.test(text)) return {ok:false,reason:'renderer de ajustes mostró su fallback de error',text};
    if ((page==='integrations'||page==='agents') && /install_failed|No se pudo completar/i.test(text)) return {ok:false,reason:'una fila de agente mostró un error de instalación',text};
    const controls=[...root.querySelectorAll('button,input,select,textarea')];
    const before=await snapshot();
    let effect, limitation;
    const buttonByText=t=>[...root.querySelectorAll('button')].find(b=>b.textContent.trim()===t && !b.disabled);
    const assertChanged=async()=>wait(async()=>{const after=await snapshot();return JSON.stringify(before)!==JSON.stringify(after) && after;},'preferencia persistida '+page);
    if(page==='notes'||page==='phone') {
      limitation='página pública renderizada; controles de la función deshabilitados por el producto';
    } else if(page==='dictionary'||page==='snippets') {
      const fields=[...root.querySelectorAll('input,textarea')].filter(e=>!e.disabled);
      fields[0].value=page==='dictionary'?'Validador':'firma validador';
      if(page==='snippets') fields[1].value='Texto privado del validador';
      const b=buttonByText(page==='dictionary'?'Añadir':'Guardar') || buttonByText(page==='dictionary'?'Agregar':'Save') || root.querySelector('button.primary');
      await click(b);
      const action=page==='dictionary'?'words':'snippets';
      effect=await wait(async()=>{const data=await invoke('dictation_action',{action});return JSON.stringify(data).includes(page==='dictionary'?'Validador':'firma validador') && data;},'dato guardado '+page);
    } else if(page==='insights') {
      const segment=root.querySelector('.hub-segmented');
      const target=segment && [...segment.querySelectorAll('button')].find(b=>!b.classList.contains('on'));
      const selected=target.textContent;
      await click(target); await wait(()=>[...document.querySelectorAll('.hub-segmented button')].some(b=>b.textContent===selected && b.classList.contains('on')),'selección de vista '+page);
      effect={selected:target.textContent,observable:'selección visual local; no cambia configuración'};
    } else if(page==='dictation') {
      await click(()=>document.querySelector('.hub-page .switch:not(:disabled)')); effect=await assertChanged();
    } else if(page==='voice') {
      const segment=root.querySelector('.hub-segmented');
      const target=[...segment.querySelectorAll('button')].find(b=>b.textContent.includes('texto')) || segment.querySelector('button:last-child');
      await click(target); effect=await assertChanged();
    } else if(page==='general') {
      const volume=byId('hub-volume');
      const gain=before.prefs.gain;
      await click(volume); await key('Home'); await key('Right');
      const live=await wait(async()=>{const p=await invoke('prefs_action',{action:'view'});return p.gain===.005 && p;},'volumen por teclado real');
      if(byId('hub-motion') || !root.textContent.includes('El movimiento no se puede configurar en Abito.')) throw new Error('control de movimiento inerte o explicación ausente');
      await invoke('prefs_action',{action:'set_sound_gain',gain});
      const startup=()=>byId('hub-autostart');
      await click(startup());
      await wait(async()=> (await invoke('prefs_action',{action:'autostart_view'})).enabled===true,'autoinicio instalado desde General');
      await wait(()=>startup().getAttribute('aria-pressed')==='true','autoinicio reflejado');
      await click(startup());
      await wait(async()=> (await invoke('prefs_action',{action:'autostart_view'})).enabled===false,'autoinicio retirado desde General');
      effect={liveGain:live.gain,motion:'sin interruptor inerte',autostart:'on/off mediante UI',input:'XTest sobre controles reales'};
    } else if(page==='chat') {
      // #503 S26: READ-ONLY by design. This page's buttons restart the engine, log in and log out: a scene must never press them. It
      // compares what the page SHOWS with what the host SAYS: the engine line against the real connection, the cards against the
      // host's own provider list (same filter as the page: only providers that offer a login method).
      const host=await invoke('agent_action',{action:'view'});
      const wantedEngine=host.connection==='connected'?'connected':String(host.connection||'no_daemon');
      const bannerWord={connected:'Motor corriendo',no_daemon:'Sin motor',lost:'Motor caído',refused:'Motor no responde',bad_session:'Sesión no válida',connecting:'Conectando'};
      const banner=await wait(()=>{const e=byId('engine-status');return e && e.textContent.trim() && e;},'línea de estado del motor');
      const expectedWord=bannerWord[wantedEngine]||bannerWord.no_daemon;
      if(!banner.textContent.includes(expectedWord)) return {ok:false,reason:`el motor dice «${expectedWord}» en el host pero la página muestra «${banner.textContent.trim()}»`,host:wantedEngine,text};
      for(const [other,word] of Object.entries(bannerWord)) if(other!==wantedEngine && other!=='connecting' && banner.textContent.includes(word)) return {ok:false,reason:`la página muestra «${word}» pero el host está en «${wantedEngine}»`,host:wantedEngine,text};
      const expectedCards=(host.providers||[]).filter(p=>Array.isArray(p.methods)&&p.methods.length).map(p=>p.id).sort();
      const shownCards=[...root.querySelectorAll('[id^="provider-"]')].map(c=>c.id.replace(/^provider-/,'')).sort();
      if(JSON.stringify(shownCards)!==JSON.stringify(expectedCards)) return {ok:false,reason:'las tarjetas de cuentas no coinciden con la lista del host',expected:expectedCards,shown:shownCards,text};
      effect={page:'chat',engine:wantedEngine,providers:shownCards,observable:'estado del motor y tarjetas leídos del host; ninguna acción pulsada (sin reinicio, sin inicio de sesión)'};
    } else if(page==='styles') {
      const add=[...root.querySelectorAll('select')].find(s=>s.options[0]?.textContent.includes('Añadir') || s.options[0]?.textContent.includes('Agregar') || s.options[0]?.textContent.includes('Add an app'));
      if(!add) throw Error('selector para añadir app ausente');
      add.focus();
      await wait(()=>[...add.options].some(o=>o.textContent==='Writer del validador'),'app GNOME en selector');
      const index=[...add.options].findIndex(o=>o.textContent==='Writer del validador');
      await click(add); await key('Home');
      for(let i=0;i<index;i++) await key('Down');
      await key('Return');
      await wait(async()=> (await invoke('dictation_action',{action:'styles'})).some(s=>s.id==='org.example.writer'),'app GNOME guardada');
      const select=await wait(()=>[...root.querySelectorAll('.hub-row')].find(r=>r.textContent.includes('Writer del validador'))?.querySelector('select'),'estilo por app');
      await click(select); await key('Home'); await key('Down'); await key('Down'); await key('Return');
      effect=await wait(async()=>{const styles=await invoke('dictation_action',{action:'styles'});return styles.some(s=>s.id==='org.example.writer' && s.style==='polished') && styles;},'estilo pulido guardado');
    } else if(page==='privacy') {
      // #503 «reportar fallos»: this switch persists to failure-prefs.json through `failure_action`, not to the prefs the generic
      // snapshot reads. Flip it, wait for the REAL answer of the host, put it back. Never press «Reportar» (it opens a browser).
      const failureView=()=>invoke('failure_action',{action:'view'});
      const start=(await failureView()).enabled;
      await click(()=>document.querySelector('.hub-page .switch:not(:disabled)'));
      await wait(async()=> (await failureView()).enabled===!start,'preferencia persistida privacy (avisos de fallos)');
      await click(()=>document.querySelector('.hub-page .switch:not(:disabled)'));
      await wait(async()=> (await failureView()).enabled===start,'preferencia de avisos de fallos restaurada');
      effect={page:'privacy',noticesWere:start,observable:'interruptor de avisos de fallos cambiado y restaurado, leído de failure_action',input:'XTest sobre el interruptor real'};
    } else if(page==='flowsettings') {
      // Keyboard navigation on a real select produces trusted change events.
      const selects=[...root.querySelectorAll('select')].filter(s=>!s.disabled && s.options.length>1);
      const select=page==='flowsettings'?selects.at(-1):selects[0];
      await click(select); await key('Down'); await key('Return'); effect=await assertChanged();
      if(page==='flowsettings') {
        await click(byId('hub-open-at-launch'));
        await wait(async()=> (await invoke('prefs_action',{action:'view'})).openSettingsAtLaunch===true,'abrir ajustes al iniciar persistido');
      }
    } else {
      const selector=page==='general'?'#hub-sound':page==='shortcuts'?'#shortcut-desktopToggle .switch':'.switch:not(:disabled)';
      const control=root.querySelector(selector);
      if(!control) throw new Error('no se encontró control seguro en '+page);
      await click(control);
      if(page==='shortcuts') effect=await wait(async()=>{const h=await invoke('hotkey_action',{action:'view',id:'desktopToggle'});return h.enabled===false && h;},'atajo desactivado');
      else effect=await assertChanged();
      if(page==='agents') {
        const instructions=byId('abito-instructions');
        if(!instructions || !root.textContent.includes('Se aplican a los próximos mensajes del chat de Abito.')) throw new Error('instrucciones con explicación falsa o ausente');
        instructions.value='Responde en español neutro.';
        await click(buttonByText('Guardar instrucciones'));
        await wait(async()=> (await invoke('prefs_action',{action:'view'})).abitoInstructions===instructions.value,'instrucciones guardadas');
        effect={...effect,instructions:'guardadas para próximos mensajes'};
      }
    }
    // Preferences can repaint the page while installer previews arrive asynchronously.
    // Check the CURRENT full DOM as well, not just the pre-interaction/truncated text.
    const finalText=document.querySelector('.hub-page')?.textContent || '';
    if ((page==='integrations'||page==='agents') && /install_failed|No se pudo completar/i.test(finalText)) return {ok:false,reason:'una fila de agente mostró un error de instalación',text:finalText};
    if (page==='integrations'||page==='agents') document.querySelector('.hub-page')?.scrollIntoView({block:'start'});
    return {ok:true,page,controls:controls.length,text:text.slice(0,500),effect,unverifiable:limitation};
  }
  async function integrationStates(state) {
    if(byId('capsule')?.dataset.phase!=='expanded') await invoke('desktop_action',{action:'expand'});
    const results=[];
    for(const id of AbitoIntegrationCard.IDS) {
      document.dispatchEvent(new CustomEvent('abito:integration-focus',{detail:{id}}));
      await wait(async()=>{
        const native=(await invoke('integration_action',{action:'view'})).updates[id];
        return native?.state===state && document.querySelector('.int-host')?.dataset.state===state;
      },id+' '+state);
      const host=document.querySelector('.int-host');
      if(!visible(host)) throw Error('integración oculta '+id);
      const refresh=[...host.querySelectorAll('button')].find(b=>b.textContent==='Actualizar');
      let sawRefresh=false;
      const observer=new MutationObserver(()=>{if(host.dataset.state==='refreshing') sawRefresh=true;});
      observer.observe(host,{attributes:true,attributeFilter:['data-state']});
      await click(refresh);
      try { await wait(()=>sawRefresh,'refresh visible '+id); }
      catch(error) {const r=refresh.getBoundingClientRect();throw Error(error.message+'; hit='+document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML.slice(0,250)+'; state='+host.dataset.state);}
      finally {observer.disconnect();}
      await wait(()=>document.querySelector('.int-host')?.dataset.state===state,'refresh settled '+id);
      if(state==='ready') {
        const open=[...host.querySelectorAll('button')].find(b=>b.textContent==='Abrir '+AbitoIntegrationCard.NAMES[id]);
        let opened=false;
        const received=e=>{if(e.detail?.url===AbitoIntegrationCard.openTarget(id)) opened=true;};
        document.addEventListener('abito:integration-opened',received);
        try {
          // A real lifecycle snapshot must not detach an unchanged action.
          await invoke('desktop_action',{action:'expand'});
          await frame(); await frame();
          if(!open.isConnected) throw Error('snapshot de isla desprendió Abrir '+id);
          await click(open);await wait(()=>opened,'apertura asentada '+id);
        }
        finally {document.removeEventListener('abito:integration-opened',received);}
      }
      if(id==='integration_calcom' && state==='ready') {
        const button=text=>[...document.querySelectorAll('.int-host button')].find(b=>b.textContent===text);
        await click(button('Día'));
        await wait(()=>document.querySelector('.int-host [data-calendar="day"]'),'agenda diaria');
        const booking=[...document.querySelectorAll('.int-host button')].find(b=>b.textContent.startsWith('fixture ·'));
        await click(booking);
        await wait(()=>document.querySelector('.int-host [data-calendar="detail"]')?.textContent.includes('Validador'),'detalle de reserva');
        if(!document.querySelector('.int-host').textContent.includes('Consulta fixture')) throw Error('faltan notas de reserva');
        await click(button('Volver a la agenda'));
        await wait(()=>document.querySelector('.int-host [data-calendar="day"]'),'volver al día');
        await click(button('Semana'));
        await wait(()=>document.querySelector('.int-host [data-calendar="week"]'),'agenda semanal');
      }
      results.push({id,state,refresh:true,open:state==='ready',calendar:id==='integration_calcom'&&state==='ready'?'week/day/detail':null});
    }
    const host=document.querySelector('.int-host'); if(host) host.scrollTop=0;
    return {ok:true,results};
  }
  async function github() {
    await invoke('desktop_action',{action:'expand'});
    const prefs=await invoke('prefs_action',{action:'view'});
    if(!prefs.declaredPills.includes('integration_github')) await invoke('prefs_action',{action:'toggle_declared_pill',id:'integration_github'});
    const data=await invoke('github_action',{action:'refresh',section:'activity'});
    // The island ignores blob clicks while it is busy (pills-view `onScreen`): right after «pi-pregunta» the answered question's outcome
    // («Recibida») is on screen for 3-4 s and a click then is dropped silently. Wait for the calm overview before choosing the row.
    const calm=()=>{const d=byId('capsule')?.dataset||{};return d.phase==='expanded' && d.view==='overview' && !d.card && d.settings!=='open' && !['pending','expired','outcome'].includes(d.question) && d.noticeView!=='notices';};
    await wait(calm,'isla en calma antes de elegir GitHub',10000);
    let pill;
    try {pill=await wait(()=>{const p=byId('pill-choice-integration_github');return visible(p) && p;},'pill GitHub declarada con gh falso');}
    catch {return {ok:false,reason:'GitHub devuelve datos del gh falso pero la pill declarada no aparece en la isla',data,prefs:await invoke('prefs_action',{action:'view'})};}
    await click(pill);
    // A click that landed in the instant the island turned busy again is repeated once the overview is calm (the row is still there then).
    const card=await wait(async()=>{const c=document.querySelector('.gh-card');if(visible(c) && c.textContent.includes('GitHub') && !c.textContent.includes('Cargando')) return c;const p=byId('pill-choice-integration_github');if(visible(p) && calm()) await click(p);return false;},'tarjeta GitHub desde gh falso',12000);
    const text=card.textContent;
    const stats=await invoke('github_action',{action:'refresh',section:'pulse'});
    // Design 16 (option A): the card IS the PR list with CI state and an explicit [Abrir]; CI of the default branch and activity keep their detail.
    await wait(()=>card.textContent.includes('18') && card.textContent.includes('Fixture PR') && card.querySelector('.gh-row') && card.querySelector('.gh-open'),'lista de PR con estado y Abrir');
    await click(card.querySelector('.gh-ci-main'));
    await wait(()=>card.textContent.includes('main') && card.querySelector('.gh-row'),'detalle CI');
    await click(card.querySelector('.gh-back'));
    await wait(()=>card.querySelector('.gh-spark'),'volver al pulso CI');
    await click(card.querySelector('.gh-spark'));
    await wait(()=>card.textContent.includes('23 repos'),'actividad y repositorios');
    await click(card.querySelector('.gh-back'));
    await wait(()=>card.textContent.includes('Fixture PR') && card.querySelector('.gh-open'),'lista de PR visible para captura');
    // Keep the PR list visible for its native PNG; Spotify releases focus.
    return {ok:data.available===true && data.activity.total===17 && stats.stats.totalStars===18 && stats.stats.totalRepos===23,text,data,stats,details:['PR','CI','activity']};
  }
  async function mail() {
    const answer=await invoke('mail_action',{action:'inbox'});
    return {ok:answer.ok===false && answer.reason==='keychain_unavailable',reason:'correo no explicó la falta de keyring privado',answer,unverifiable:'IMAP/SMTP requieren claves en keyring; sin servicio de secretos privado ni credenciales del usuario'};
  }
  async function sounds() {
    const before=await invoke('sound_action',{action:'list'});
    let changed=false;
    const off=await window.__TAURI__.event.listen('sounds:changed',()=>{changed=true;});
    try {
      const reload=await invoke('sound_action',{action:'reload'});
      await wait(()=>changed,'sounds:changed tras reload');
      // Reload also warms the renderer's 29-cue cache. Do not pile the
      // validator's explicit readbacks onto that same 30 IPC/s window.
      await new Promise(resolve=>setTimeout(resolve,1200));
      const after=await invoke('sound_action',{action:'list'});
      const expected=['peek','open','close','hover','blip','slap','annoyed','dizzy','greet','work','finish','error','approval','question','approve','gulp','tick','send','love','pop','proud','wink','yawn','attach','think','search','rate','sleep','greeting'];
      const catalog=window.AbitoSound.CUE_IDS;
      const context=new AudioContext();
      const decoded=[];
      try {
        for(const name of expected) {
          if(!catalog.includes('snd.'+name) || !after.names.includes(name)) throw new Error('cue ausente: '+name);
          const file=await invoke('sound_action',{action:'read',name});
          const raw=atob(file.data), bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
          await context.decodeAudioData(bytes.buffer); decoded.push(name);
        }
      } finally {await context.close();}
      return {ok:reload.ok===true && decoded.length===29,before,after,changed,decoded,audio:'decodificación privada; no afirma salida audible'};
    } finally {off();}
  }
  async function spotify() {
    const gh=document.querySelector('.gh-card');
    if(visible(gh)) { await click(byId('pill-choice-abito')); await wait(()=>!visible(gh),'GitHub desenfocado antes de Spotify'); }
    const prefs=await invoke('prefs_action',{action:'view'});
    if(!prefs.declaredPills.includes('integration_spotify')) {
      if(prefs.declaredPills.length>=4) await invoke('prefs_action',{action:'toggle_declared_pill',id:prefs.declaredPills[0]});
      await invoke('prefs_action',{action:'toggle_declared_pill',id:'integration_spotify'});
    }
    const card=byId('spotify-card');
    await wait(()=>visible(card) && card.textContent.includes('Fake Song') && card.dataset.playing==='true','MPRIS falso dibujado');
    await click(card.querySelector('[data-action="play_pause"]'));
    await wait(()=>card.dataset.playing==='false','pausa reflejada');
    await click(card.querySelector('[data-action="play_pause"]'));
    await wait(()=>card.dataset.playing==='true','reproducción reflejada');
    await wait(()=>card.dataset.artwork==='local' && card.querySelector('canvas'),'carátula local decodificada');
    const slider=card.querySelector('[aria-label="Posición"]');
    await click(slider);
    await wait(async()=>{const r=await invoke('spotify_action',{action:'view'});return r.state.position>70 && r.state.position<110 && Number(slider.getAttribute('aria-valuenow'))>35;},'seek nativo y DOM asentados');
    const answer=await invoke('spotify_action',{action:'view'});
    return {ok:answer.ok && answer.state.playing && answer.state.track.title==='Fake Song',text:card.textContent,state:answer.state};
  }
  async function spotifyFallback() {
    const card=byId('spotify-card');
    await click(card.querySelector('[data-action="next"]'));
    const r=await invoke('spotify_action',{action:'view'});
    await wait(()=>!card.dataset.artwork && !card.querySelector('canvas'),'URL remota: nota musical sin fetch');
    return {ok:r.state.track.artUrl==='https://unsupported.invalid/cover.png' && r.state.artwork===null};
  }
  async function character(on) {
    const value=on ? await window.__TAURI__.core.invoke('character_fly_out',{anywhere:true}) : await window.__TAURI__.core.invoke('character_fly_home',{forget:true});
    const info=await window.__TAURI__.core.invoke('character_info');
    return {ok:value===true && info.onDesktop===on,info};
  }
  async function hotkeys() {
    await click(hubButton('shortcuts'));
    const ids=['toggleIsland','openChat','goToAlert','jumpToTerminal','nextPill','prevPill','muteToggle','desktopToggle','wardrobeToggle'];
    const payload=(id,action)=>id==='toggleIsland'?{action}:{id,action};
    await wait(()=>ids.every(id=>byId(`shortcut-${id}`)?.querySelector('button')?.disabled===false),'nueve atajos disponibles');
    const views={};
    for(const id of ids) {
      const row=()=>byId(`shortcut-${id}`), sw=()=>row().querySelector('button');
      const before=await invoke('hotkey_action',payload(id,'view'));
      await click(sw());
      // XTest delivery and native config readback can precede the renderer's
      // rebind completion. Check the current DOM AFTER the awaited IPC, never
      // carry a pre-await "not busy" observation into the next trusted click.
      await wait(async()=>{const next=await invoke('hotkey_action',payload(id,'view'));return next.enabled!==before.enabled && sw()?.disabled===false;},`${id}: interruptor guardado`);
      await click(sw());
      await wait(async()=>{const next=await invoke('hotkey_action',payload(id,'view'));return next.enabled===before.enabled && sw()?.disabled===false;},`${id}: restaurado`);
      views[id]=await invoke('hotkey_action',payload(id,'view'));
    }
    // A rejected collision must leave BOTH configurations intact.
    let conflict=false;
    try { await invoke('hotkey_action',{id:'openChat',action:'set',combo:views.toggleIsland.combo}); }
    catch(e) { conflict=e.code==='combo_in_use'; }
    const unchanged=await invoke('hotkey_action',{id:'openChat',action:'view'});
    await wait(()=>!byId('shortcut-reset').disabled,'reset disponible tras cambios de catálogo');
    await click(byId('shortcut-reset'));
    await wait(()=>!byId('shortcut-reset').disabled,'reset de catálogo');
    return {ok:conflict && unchanged.combo===views.openChat.combo && new Set(Object.values(views).map(v=>v.combo)).size===9,views,conflict,unchanged};
  }
  async function recordHotkey() {
    const row=()=>byId('shortcut-toggleIsland'), cap=()=>row().querySelector('.keycap');
    await wait(()=>cap() && !cap().disabled && !byId('shortcut-reset').disabled,'catálogo listo para grabar');
    const before=await invoke('hotkey_action',{action:'view'});
    const chat=await invoke('hotkey_action',{id:'openChat',action:'view'});
    await click(cap()).catch(e=>{throw Error(`iniciar grabación: ${e.message}`);});
    await wait(()=>cap()?.classList.contains('recording'),'grabador listo tras suspender catálogo');
    const suspended=await invoke('hotkey_action',{id:'openChat',action:'view'});
    await key('Ctrl+F8');
    await wait(async()=>!cap()?.disabled && (await invoke('hotkey_action',{action:'view'})).combo==='Ctrl+F8','nueva combinación guardada');
    const rebound=await invoke('hotkey_action',{action:'view'});
    await click(cap()).catch(e=>{throw Error(`iniciar borrado: ${e.message}`);});
    await wait(()=>cap()?.classList.contains('recording'),'grabador para borrar');
    await key('BackSpace');
    await wait(async()=>!cap()?.disabled && (await invoke('hotkey_action',{action:'view'})).combo==='','Backspace borró solo la fila elegida');
    const cleared=await invoke('hotkey_action',{action:'view'});
    const other=await invoke('hotkey_action',{id:'openChat',action:'view'});
    await click(byId('shortcut-reset')).catch(e=>{throw Error(`reset después de borrar: ${e.message}`);});
    await wait(()=>!byId('shortcut-reset').disabled,'reset completo');
    return {ok:suspended.status!=='active' && rebound.combo==='Ctrl+F8' && !cleared.enabled && cleared.combo==='' && other.combo===chat.combo,before,suspended,rebound,cleared,other,coverage:'trusted recording/Backspace and native readback; old-combo dispatch not exercised from settings'};
  }
  async function dictationNavigate(id) {
    const button=hubButton(id);
    if (!button) throw Error(`página en pausa u oculta: ${id}`);
    const previous=document.querySelector('.hub-page');
    await click(button);
    await wait(()=>document.querySelector('.hub-page')!==previous,'navegar a '+id);
    await wait(()=>document.querySelector('.hub-page input, .hub-page button'),'controles de '+id);
  }
  async function dictationRepaste() {
    await dictationNavigate('flowsettings');
    const row=[...document.querySelectorAll('.hub-row')].find(e=>e.textContent.includes('Volver a pegar el último dictado'));
    const button=row?.querySelector('button');
    if (!button || button.disabled) throw Error('falta volver a copiar');
    await click(button);
    await wait(()=>document.body.textContent.includes('Copiado · presiona Ctrl+V'));
    return {ok:true,manualPaste:true};
  }
  async function dictationHistory() {
    await dictationNavigate('dictation');
    await wait(()=>document.body.textContent.includes('Dictado privado del validador'),'entrada sembrada');
    const entry=document.querySelector('.hub-entry');
    const copy=entry?.querySelector('button[title="Copiar"]');
    if (!copy || copy.disabled) throw Error('falta Copiar');
    await click(copy);
    await wait(()=>document.body.textContent.includes('Copiado · presiona Ctrl+V'));
    const remove=entry.querySelector('button[title="Eliminar"]');
    if (!remove) throw Error('falta Eliminar');
    await click(remove);
    await wait(async()=>!(await invoke('dictation_action',{action:'history'})).length,'borrado nativo');
    await wait(()=>!document.querySelector('.hub-entry'),'borrado visible');
    return {ok:true,copied:true,deleted:true};
  }
  async function noModel(page) {
    if(!window.__validatePages.includes(page)) throw Error(`página desconocida: ${page}`);
    const button=hubButton(page);
    if(!button) return {ok:true,hidden:true,page,input:'página en pausa: oculta en el menú'};
    await click(button);
    await wait(()=>document.querySelector('.hub-page')?.textContent.includes('Descargar'),`aviso de modelo ausente ${page}`);
    const status=await invoke(page==='voice'?'voice_action':'dictation_action',{action:'status'});
    const text=document.querySelector('.hub-page').textContent;
    const missing=page==='voice' ? status.vad?.state==='missing' && status.parakeet?.state==='missing' && status.listening===false : JSON.stringify(status).includes('missing');
    return {ok:missing && [...document.querySelectorAll('.hub-page button')].some(b=>b.textContent.includes('Descargar')),reason:'sin modelo no se muestra Descargar o se afirma escucha activa',status,text};
  }
  async function run(expression) {
    let result;
    try { result=await expression(); }
    catch(e) {result={ok:false,reason:typeof e==='string' ? e : (e.code ? JSON.stringify(e) : e.message || String(e))};}
    result.errors=[...errors];
    await emit('validate-result',result);
  }
  async function contextMessage(enabled) {
    await invoke('chat_action',{action:'new'});
    await invoke('prefs_action',{action:'set_window_context',window_context:enabled});
    await invoke('chat_action',{action:'back'});
    await invoke('chat_action',{action:'open'});
    // The host's capture is asynchronous. Native evidence also checks the actual model request.
    await new Promise(r=>setTimeout(r,1000));
    await invoke('chat_action',{action:'submit',text:'Mensaje privado de contexto',client_request_id:'context-'+String(enabled)});
    return wait(async()=>{const v=await invoke('chat_action',{action:'view'});return !v.active_turn && v.turns.some(t=>t.state==='completed') && {ok:true,enabled,turns:v.turns};},'mensaje con contexto completado',15000);
  }
  async function contextMissing(index) {
    const result=await hub(index,'chat');
    const prefs=await invoke('prefs_action',{action:'view'});
    const text=document.querySelector('.hub-page').textContent;
    return {...result,ok:result.ok && prefs.windowContextAvailable===false
      && text.includes('extensión de GNOME no está disponible')
      && text.includes('sh apps/desktop-tauri/gnome-extension/install.sh')
      && text.includes('gnome-extensions enable abito-context@abito')
      && text.includes('cerrar sesión'),availability:prefs.windowContextAvailable,
      instructions:'install.sh, log out/in on Wayland, explicit enable; no install executed'};
  }
  window.AbitoValidate={contextMissing,contextMessage,dictationHistory,dictationRepaste,run,wait,click,key,visible,invoke,chatFirst,chatSecond,dictationIdle,sessions,connection,notice,shortcutDispatch,shortcutTerminalAbsent,shortcutAlert,answerQuestion,gear,hub,github,mail,sounds,spotify,character,hotkeys,recordHotkey,noModel,sessionsFocus,restoreSessionFocus,islandHoverPin,spotifyFallback,integrationStates,prepareNoticeEdge,edgeIdle,edgeWake,prepareNoticeCycle,noticeCycle,action:'new'};
})();
