// The states to capture. Each side gets a page-side script that drives the real app into the state.
// Sizes are Coucou's own window size for that state (island window 720x320, settings window 1100x720).
const ISLAND = { w: 720, h: 320 };
const SETTINGS = { w: 1100, h: 720 };

// ── Coucou side: hook events, exactly what Claude Code / Codex send ──
const cHook = (o) => `__vcEmit('hook', ${JSON.stringify(o)});`;
const cStart = (a) => cHook({ hook_event_name: 'SessionStart', session_id: a.sessionId, cwd: a.cwd, ...(a.id === 'codex' ? { coucou_agent: 'codex' } : {}) })
  + cHook({ hook_event_name: 'UserPromptSubmit', session_id: a.sessionId, cwd: a.cwd, prompt: a.prompt, ...(a.id === 'codex' ? { coucou_agent: 'codex' } : {}) })
  + cHook({ hook_event_name: 'PreToolUse', session_id: a.sessionId, cwd: a.cwd, tool_name: a.tool, tool_input: a.toolInput, ...(a.id === 'codex' ? { coucou_agent: 'codex' } : {}) });
const cAll = (f) => f.agents.map(cStart).join('\n');
const cCompact = () => `__vcCoucou.island.setMode('compact');`;

// ── Abito side: host snapshots ──
const aSet = (scn, view) => `__vcAbitoSet(${scn}); window.__islandSetState(${JSON.stringify(view)}); setTimeout(() => __vcAbitoSet({}), 1200);`;

export function buildStates(f) {
  const claude = f.agents[0];
  const sessions = `{ truncated:false, rows:[
    { id:'s-0123abcd', kind:'claude-code', cwd:${JSON.stringify(f.agents[0].project)}, state:'running', origin:null },
    { id:'s-4567ef01', kind:'codex', cwd:${JSON.stringify(f.agents[1].project)}, state:'running', origin:null } ] }`;
  const expanded = `snapshot:{ state:'expanded' }`;
  const q = f.question;
  const spot = f.spotify;
  const spotState = `{ running:true, installed:true, playing:${spot.playing}, track:{ id:'t1', title:${JSON.stringify(spot.title)}, artist:${JSON.stringify(spot.artist)}, album:${JSON.stringify(spot.album)}, duration:${spot.durationSec} } }`;
  // 1:1 with Coucou's sidebar order (Flow x7, Notch x8); Abito-only pages follow with coucou = null.
  const settingsPages = [
    ['dictation', 'Dictation'], ['notes', 'Notetaker'], ['insights', 'Statistics'], ['dictionary', 'Dictionary'],
    ['snippets', 'Snippets'], ['styles', 'Styles'], ['flowsettings', 'Flow settings'],
    ['general', 'General'], ['pills', 'Active pills'], ['agents', 'Agents'], ['chat', 'Chat'], ['voice', 'OK Coucou (voice)'],
    ['integrations', 'Integrations'], ['phone', 'Android phone'], ['shortcuts', 'Shortcuts'],
    ['accounts', 'Accounts (Abito only)'], ['models', 'Models (Abito only)'], ['appearance', 'Appearance (Abito only)'],
  ];
  const states = [
    { id: 'compact', title: 'Island compact', expected: 'Abito keeps its 32 px disc by owner decision (Coucou: 288x32 bar).', ...ISLAND,
      coucou: { page: 'island', run: cCompact() }, abito: { label: 'main', run: aSet(`{}`, 'compact') } },
    { id: 'overview', title: 'Overview, 2 agents', ...ISLAND,
      coucou: { page: 'island', run: cAll(f) + `__vcCoucou.island.expand('overview');` },
      abito: { label: 'main', run: aSet(`{ ${expanded}, sessions:${sessions} }`, 'overview'), settle: 4500,
        probe: `JSON.stringify({ tickerOn: document.getElementById('overview-view').dataset.ticker || null, tickerText: (document.querySelector('#overview-view .card-left')||{}).innerText, sessionsPolled: window.__vcPolled||0 })` } },
    { id: 'approval', title: 'Approval card (PermissionRequest)', ...ISLAND,
      coucou: { page: 'island', run: cStart(claude) + cHook({ hook_event_name: 'PermissionRequest', request_id: f.approval.requestId, session_id: claude.sessionId, cwd: claude.cwd, tool_name: f.approval.tool, tool_input: { command: f.approval.command } }) },
      abito: { label: 'main', run: aSet(`{ snapshot:{ state:'expanded', card:{ operation:${JSON.stringify(f.approval.tool + ' · ' + f.approval.command)}, expires_at:new Date(Date.now()+100000).toISOString(), reason:null, state:'pending' } } }`, 'overview') } },
    { id: 'question', title: 'Question card', ...ISLAND,
      coucou: { page: 'island', run: cStart(claude) + cHook({ hook_event_name: 'PermissionRequest', request_id: f.question.requestId, session_id: claude.sessionId, cwd: claude.cwd, tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: q.text, options: q.options, multiSelect: false }] } }) },
      abito: { label: 'main', run: aSet(`{ ${expanded}, question:{ available:true, notice:null, revision:2, pending:{ id:__vcAbitoUuid(7), kind:'question', agent:'claude-code', text:${JSON.stringify(q.text)}, options:${JSON.stringify(q.options.map((o, i) => ({ index: i, ...o })))}, allow_free_text:false, expires_at:Date.now()+100000 } } }`, 'overview') } },
    { id: 'notices', title: 'Notices / finished lane', ...ISLAND,
      coucou: { page: 'island', run: cStart(claude) + `__vcCoucou.State.setFocus('integration_claude');` + cHook({ hook_event_name: 'Stop', session_id: claude.sessionId, cwd: claude.cwd, last_assistant_message: f.finished.message }) },
      abito: { label: 'main', run: aSet(`{ ${expanded}, snapshot:{ state:'expanded', notices:[{ id:__vcAbitoUuid(9), kind:'settled', title:'Pi terminó su turno', detail:${JSON.stringify(f.finished.message)}, severity:'info', expiresAt:Date.now()+55000 }] } }`, 'overview') + `__vcEmit('desktop:notice-open', { id: __vcAbitoUuid(9), kind: 'finished' });` } },
    { id: 'spotify', title: 'Spotify now-playing', ...ISLAND,
      coucou: { page: 'island', settings: { activeIntegrations: ['integration_spotify'], mainPill: 'integration_spotify' },
        run: `__vcEmit('spotify', { running:true, installed:true, track:{ id:'t1', title:${JSON.stringify(spot.title)}, artist:${JSON.stringify(spot.artist)}, album:${JSON.stringify(spot.album)}, durationSec:${spot.durationSec}, artUrl:'' }, playing:true, position:${spot.positionSec}, positionAt:Date.now(), shuffle:false, repeat:false, volume:50 });__vcCoucou.State.setFocus('integration_spotify');__vcCoucou.island.expand('overview');` },
      abito: { label: 'main', run: aSet(`{ ${expanded}, spotify:${spotState}, prefs:{ ...__vcAbito.prefs, mainPill:'integration_spotify', declaredPills:['integration_spotify'] } }`, 'overview'), settle: 1500 } },
    // ── L32 zones: usage pill + card, GitHub card, weekly recap, dictation pill ──
    { id: 'usage', title: 'Plan usage pill + card', ...ISLAND,
      coucou: { page: 'island', run: cAll(f) + `const S=__vcCoucou.State; S.settings={...S.settings,showPlanInNotch:true,planRelayInstalled:true}; S.planUsage={updatedAt:Date.now(),fiveHour:{usedPct:42,resetsAt:Date.now()+3600e3},sevenDay:{usedPct:61,resetsAt:Date.now()+2*86400e3}}; S.planDetailIsCodex=false; S.showingPlanDetail=true; __vcCoucou.island.expand('overview'); S.notify();`, settle: 2500 },
      abito: { label: 'main', run: aSet(`{ ${expanded}, sessions:${sessions}, prefs:{ ...__vcAbito.prefs, showPlanInNotch:true } }`, 'overview') + `setTimeout(()=>{const b=[...document.querySelectorAll('.plan-pill')].find(x=>x.style.display!=='none'); if(b) b.click();},2500);`, settle: 4500 } },
    { id: 'github', title: 'GitHub card', ...ISLAND,
      coucou: { page: 'island', settings: { activeIntegrations: ['integration_github'], mainPill: 'integration_github' },
        run: cAll(f) + `__vcEmit('integration',{id:'integration_github',data:__vcGithub(),error:null,event:null}); __vcCoucou.island.expand('overview'); __vcCoucou.State.setFocus('integration_github');`, settle: 2500 },
      abito: { label: 'main', run: aSet(`{ ${expanded}, sessions:${sessions}, prefs:{ ...__vcAbito.prefs, mainPill:'integration_github', declaredPills:['integration_github'] } }`, 'overview'), settle: 4500 } },
    { id: 'recap', title: 'Weekly recap card', ...ISLAND,
      coucou: { page: 'island', run: cAll(f) + `(async()=>{await __vcCoucou.Recap.load(); __vcCoucou.island.expand('recap');})();`, settle: 2500 },
      abito: { label: 'main', run: aSet(`{ ${expanded}, sessions:${sessions} }`, 'overview') + `setTimeout(()=>window.AbitoIslandRecap && window.AbitoIslandRecap.open(),1500);`, settle: 4000 } },
    { id: 'dictation', title: 'Dictation pill (hands-free)', w: 720, h: 140, expected: 'Coucou draws the pill in its own window on a screen edge; Abito draws it in the expanded island header: compare the look, not the %.',
      coucou: { page: 'pill', run: `setTimeout(()=>__vcEmit('pill-bands',[0.2,0.5,0.9,0.4,0.7,0.3,0.8,0.1,0.6]),600);`, settle: 2000 },
      abito: { label: 'main', run: `window.__VC_DICTATION=true; ` + aSet(`{ ${expanded}, sessions:${sessions} }`, 'overview') + `setTimeout(()=>{__vcEmit('dictation:phase',{phase:'locked'});__vcEmit('dictation:bands',{bands:[0.2,0.5,0.9,0.4,0.7,0.3,0.8,0.1,0.6]});},1500);`, settle: 3500 } },
    // ── L37 notices: every notice surface of the island against Coucou's idle / badge / error look ──
    { id: 'notice-down', title: 'Notices · no Pi session connected (idle)', ...ISLAND,
      expected: 'Coucou has no «connection» notion: nothing running is its normal empty state (L37: no red band).',
      coucou: { page: 'island', run: `__vcCoucou.island.expand('overview');`, settle: 2000 },
      abito: { label: 'main', run: aSet(`{ ${expanded}, snapshot:{ state:'expanded', connections:0, notices:[] } }`, 'overview'), settle: 3000 } },
    { id: 'notice-failed', title: 'Notices · receiver failed to start (real error)', ...ISLAND,
      expected: 'The only red: Coucou shows an error as its red ✗ badge / error view.',
      coucou: { page: 'island', run: cAll(f) + cHook({ hook_event_name: 'StopFailure', session_id: f.agents[1].sessionId, cwd: f.agents[1].cwd, coucou_agent: 'codex' }) + `__vcCoucou.island.expand('overview');`, settle: 2500 },
      abito: { label: 'main', run: aSet(`{ ${expanded}, sessions:${sessions}, snapshot:{ state:'expanded', unavailable:true, connections:0, notices:[{ id:__vcAbitoUuid(21), kind:'transport', title:'Avisos caídos', detail:'El canal local de avisos no pudo iniciarse.', severity:'error', at:Date.now(), expiresAt:Date.now()+3.15e11 }] } }`, 'overview'), settle: 3500 } },
    { id: 'notice-single', title: 'Notices · one notice (finished)', ...ISLAND,
      coucou: { page: 'island', run: cAll(f) + cHook({ hook_event_name: 'Stop', session_id: f.agents[1].sessionId, cwd: f.agents[1].cwd, coucou_agent: 'codex', last_assistant_message: 'done' }) + `__vcCoucou.island.expand('overview');`, settle: 2500 },
      abito: { label: 'main', run: aSet(`{ ${expanded}, sessions:${sessions}, snapshot:{ state:'expanded', notices:[{ id:__vcAbitoUuid(22), kind:'settled', title:'Pi terminó su turno', detail:'', severity:'info', at:Date.now()-120000, expiresAt:Date.now()+55000 }] } }`, 'overview'), settle: 3500 } },
    { id: 'notice-warning', title: 'Notices · one warning', ...ISLAND,
      coucou: { page: 'island', run: cAll(f) + cHook({ hook_event_name: 'PermissionRequest', request_id: 'rq-w', session_id: f.agents[1].sessionId, cwd: f.agents[1].cwd, coucou_agent: 'codex', tool_name: 'Bash', tool_input: { command: 'ls' } }) + `__vcCoucou.island.expand('overview');`, settle: 2500 },
      abito: { label: 'main', run: aSet(`{ ${expanded}, sessions:${sessions}, snapshot:{ state:'expanded', notices:[{ id:__vcAbitoUuid(23), kind:'settled', title:'Atajo limitado (sin permiso)', detail:'', severity:'warning', at:Date.now()-30000, expiresAt:Date.now()+55000 }] } }`, 'overview'), settle: 3500 } },
    { id: 'notice-grouped', title: 'Notices · three notices grouped', ...ISLAND,
      coucou: { page: 'island', run: cAll(f) + cHook({ hook_event_name: 'Stop', session_id: f.agents[1].sessionId, cwd: f.agents[1].cwd, coucou_agent: 'codex', last_assistant_message: 'done' }) + `__vcCoucou.island.expand('overview');`, settle: 2500 },
      abito: { label: 'main', run: aSet(`{ ${expanded}, sessions:${sessions}, snapshot:{ state:'expanded', notices:[{ id:__vcAbitoUuid(24), kind:'settled', title:'Pi terminó su turno', detail:'', severity:'info', at:Date.now()-60000, expiresAt:Date.now()+55000 },{ id:__vcAbitoUuid(25), kind:'settled', title:'Pi espera tu decisión', detail:'', severity:'warning', at:Date.now()-30000, expiresAt:Date.now()+55000 },{ id:__vcAbitoUuid(26), kind:'settled', title:'Atajo limitado (sin permiso)', detail:'', severity:'warning', at:Date.now()-10000, expiresAt:Date.now()+55000 }] } }`, 'overview'), settle: 3500 } },
  ];
  // Pages are matched by Coucou's sidebar id (same ids in Abito's window): [data-page] when the shell exposes it, else the sidebar slot of that id.
  const click = (i, id) => `(document.querySelector('[data-page="${id}"]') || document.querySelectorAll('.hub-item')[${i}]).click();`;
  settingsPages.forEach(([id, title], i) => {
    states.push({ id: `settings-${id}`, title: `Settings · ${title}`, ...SETTINGS,
      coucou: i < 15 ? { page: 'settings', run: click(i, id), settle: 1500 } : null,
      abito: { label: 'settings', url: 'settings.html', run: click(i, id), settle: 1500 } });
  });
  // Chat tab of the island (Coucou: prompt view; Abito: chat column).
  states.push({ id: 'chat', title: 'Island chat view', w: 720, h: 330,
    coucou: { page: 'island', run: cAll(f) + `__vcCoucou.island.expand('prompt');` },
    abito: { label: 'main', run: aSet(`{ ${expanded}, sessions:${sessions} }`, 'overview') + `window.__islandSetView('chat', 640, 240);`, settle: 2500 } });
  return states;
}
