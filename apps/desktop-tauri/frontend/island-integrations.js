'use strict';
/* #489 — the island cards of the integration pills (n8n, Vercel; more services follow), as Coucou's views/integrations.ts.
   Adapted from Coucou windows/src/views/integrations.ts @71b773f, Copyright (c) 2026 Louis Raillé, MIT. Own DOM builders
   (textContent only), Spanish copy, Coucou's .int-* classes (island-integrations.css).

   Wire (src/integrationshost.rs, island window ONLY):
     invoke('integration_action', {payload:{action:'view'}})                      -> {updates:{<pillId>:Update}}
     invoke('integration_action', {payload:{action:'refresh', id:'integration_n8n'}})
     event 'integration:update' -> Update {id, data, error, event:{success,label,detail}|null}
   The host polls only declared pills with a saved key, so no update means «not set up / nothing yet».
   The card shows while a pill is focused: document event 'abito:integration-focus' {detail:{id}} (null clears).
   Pure view-model first (Node-testable), then the browser-only mount at the tail (house pattern). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = Object.freeze(api); return; }
  root.AbitoIntegrationCard = Object.freeze(api);
  mount(api);
})(typeof self !== 'undefined' ? self : this, () => {
  const IDS = Object.freeze(['integration_n8n', 'integration_vercel', 'integration_stripe', 'integration_resend', 'integration_notion', 'integration_calcom']);
  const NAMES = Object.freeze({ integration_n8n: 'n8n', integration_vercel: 'Vercel', integration_stripe: 'Stripe', integration_resend: 'Resend', integration_notion: 'Notion', integration_calcom: 'Cal.com' });
  const COLORS = Object.freeze({ integration_n8n: '#F29B38', integration_vercel: '#7C5CFF', integration_stripe: '#0570DE', integration_resend: '#22C55E', integration_notion: '#E8E8E8', integration_calcom: '#C9956A' });
  const KINDS = Object.freeze({ integration_n8n: 'Workflow', integration_vercel: 'Despliegues', integration_stripe: 'Pagos', integration_resend: 'Correos', integration_notion: 'Recientes', integration_calcom: 'Agenda' });
  const GREEN = '#22C55E', RED = '#F4505E';
  const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const clean = (v, max = 200) => (typeof v === 'string' ? [...v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim()].slice(0, max).join('') : '');
  const text = (v, max = 2000) => (typeof v === 'string' ? [...v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')].slice(0, max).join('') : '');

  /** «hace 3 min» as Coucou's timeAgo. */
  function timeAgo(value, now = Date.now()) {
    const at = typeof value === 'number' ? value : Date.parse(String(value));
    const diff = (now - at) / 1000;
    if (!Number.isFinite(diff)) return '';
    if (diff < 60) return 'ahora';
    if (diff < 3600) return Math.floor(diff / 60) + ' min';
    if (diff < 86400) return Math.floor(diff / 3600) + ' h';
    return Math.floor(diff / 86400) + ' d';
  }

  /** Only a vercel.app deployment host leaves the page (the host re-validates again). */
  function vercelUrl(host) {
    if (typeof host !== 'string' || !host || host.length > 300 || /[\s\u0000-\u001f\u007f/@:?#\\]/.test(host)) return null;
    return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.vercel\.app$/i.test(host) ? 'https://' + host.toLowerCase() : null;
  }

  /** An Update (possibly absent) → the closed view the renderer draws. Never a guess: off-shape is «sin datos». */
  function dataView(id, update, now = Date.now()) {
    const base = { id, kind: 'idle', error: '', status: 'Sin datos todavía', name: NAMES[id] || id };
    if (!IDS.includes(id) || !isObject(update) || update.id !== id) return base;
    if (typeof update.error === 'string' && update.error) return { ...base, kind: 'error', error: clean(update.error), status: clean(update.error) };
    const data = isObject(update.data) ? update.data : {};
    if (id === 'integration_vercel') {
      const rows = (Array.isArray(data.deployments) ? data.deployments : []).filter(isObject).slice(0, 3).map(d => ({
        project: clean(d.projectName, 80), state: clean(d.state, 12), ok: d.state === 'READY',
        ago: timeAgo(d.createdAt, now), commit: clean(d.commitMessage, 200), branch: clean(d.branch, 80), url: vercelUrl(d.url),
      }));
      return rows.length ? { ...base, kind: 'list', rows } : base;
    }
    if (id === 'integration_stripe') {
      const cents = n => (Number.isFinite(n) ? n : 0) / 100;
      const payments = (Array.isArray(data.payments) ? data.payments : []).filter(isObject).slice(0, 3).map(p => ({
        text: clean(p.description, 80) || 'Pago', ok: p.status === 'succeeded', amount: '+' + cents(p.amount).toFixed(2), ago: timeAgo(p.createdAt, now),
      }));
      return { ...base, kind: 'payments', balance: cents(data.balance).toFixed(2), currency: clean(data.currency, 3).toUpperCase() || 'EUR', payments };
    }
    if (id === 'integration_resend') {
      const rows = (Array.isArray(data.emails) ? data.emails : []).filter(isObject).slice(0, 3).map((e, i) => ({
        to: clean(Array.isArray(e.to) && typeof e.to[0] === 'string' ? e.to[0] : '?', 80).split('@')[0] || '?', ok: e.lastEvent === 'delivered',
        ago: timeAgo(e.createdAt, now), subject: i === 0 ? clean(e.subject, 120) : '',
      }));
      return rows.length ? { ...base, kind: 'emails', rows, total: Number.isFinite(data.total) ? data.total : null } : base;
    }
    if (id === 'integration_notion') {
      const rows = (Array.isArray(data.pages) ? data.pages : []).filter(isObject).slice(0, 3).map(p => ({
        title: clean(p.title, 100) || 'Sin título', emoji: clean(p.emoji, 4), ago: timeAgo(p.lastEditedAt, now), url: notionUrl(p.url),
      }));
      return rows.length ? { ...base, kind: 'pages', rows } : base;
    }
    if (id === 'integration_calcom') {
      const rows = (Array.isArray(data.bookings) ? data.bookings : []).filter(isObject)
        .map(b => ({ at: Date.parse(String(b.start)), title: clean(b.title, 100) || 'Reunión' })).filter(b => Number.isFinite(b.at))
        .sort((a, b) => a.at - b.at).slice(0, 3).map(b => ({ when: whenOf(b.at), title: b.title }));
      return { ...base, kind: 'bookings', rows };
    }
    const ev = isObject(update.event) ? update.event : null;
    if (!ev && typeof data.workflow !== 'string') return base;
    return {
      ...base, kind: 'workflow', ok: ev ? ev.success === true : data.status === 'success',
      workflow: clean(ev ? ev.label : data.workflow, 120) || 'Workflow', detail: ev ? text(ev.detail) : '',
    };
  }
  const TARGETS = Object.freeze(['https://n8n.io','https://vercel.com','https://stripe.com','https://resend.com','https://www.notion.so','https://cal.com']);
  const openTarget = id => TARGETS[IDS.indexOf(id)] || null;
  function view(id, update, now = Date.now()) {
    const current = isObject(update) && update.id === id ? update : null;
    if (current?.state === 'missing_key') return {id,name:NAMES[id],kind:'missing_key',status:'Falta configurar la clave en Ajustes',error:''};
    const stale = current?.state === 'stale' || (Number.isFinite(current?.updatedAt) && now-current.updatedAt > (['integration_notion','integration_calcom'].includes(id)?600000:120000));
    const result = dataView(id, stale ? {...current,error:null} : current, now);
    return {...result,stale,refreshing:current?.state === 'refreshing',error:stale?clean(current?.error):result.error};
  }
  function calendarView(bookings, mode, at, selected) {
    const d=new Date(at), day=Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate());
    const start=mode==='day'?day:day-((d.getUTCDay()+6)%7)*86400000;
    const days=Array.from({length:mode==='day'?1:7},(_,i)=>start+i*86400000);
    const rows=(Array.isArray(bookings)?bookings:[]).filter(isObject).slice(0,100)
      .map(b=>({id:clean(String(b.id),80),at:Date.parse(b.start),title:clean(b.title,100)||'Reunión',attendee:clean(b.attendeeName,100),notes:text(b.attendeeNotes)}))
      .filter(b=>Number.isFinite(b.at)&&b.at>=start&&b.at<start+days.length*86400000).sort((a,b)=>a.at-b.at);
    return {days,rows,detail:rows.find(b=>b.id===selected)||null};
  }
  /** Only https pages on notion.so / notion.site leave the island (the host re-validates). */
  function notionUrl(raw) {
    if (typeof raw !== 'string' || !raw || raw.length > 2000 || /[\s\u0000-\u001f\u007f]/.test(raw)) return null;
    let u; try { u = new URL(raw); } catch { return null; }
    return u.protocol === 'https:' && !u.username && !u.password && /(^|\.)notion\.(so|site)$/.test(u.hostname) ? u.href : null;
  }
  const pad = n => String(n).padStart(2, '0');
  const whenOf = ms => { const d = new Date(ms); return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const STATE_LABEL = Object.freeze({ READY: 'Listo', CANCELED: 'Cancelado', ERROR: 'Error' });
  return { calendarView, openTarget, IDS, NAMES, COLORS, KINDS, notionUrl, GREEN, RED, view, timeAgo, vercelUrl, STATE_LABEL, clean };
});

function mount(api) {
  // abito-pausa: integrations are paused in this version — the service cards never mount nor call integration_action
  if (window.AbitoPaused && window.AbitoPaused.paused('integrations')) return;
  const doc = typeof document === 'object' ? document : null;
  const root = typeof window === 'object' ? window : null;
  if (!doc || !root) return;
  const capsule = doc.getElementById('capsule');
  const overview = doc.getElementById('overview-view');
  const leftCard = overview && overview.querySelector('.card-left');
  if (!capsule || !leftCard) return;
  const internals = root.__TAURI_INTERNALS__;
  const label = internals && internals.metadata && internals.metadata.currentWindow && internals.metadata.currentWindow.label;
  const invoke = (root.__TAURI__ && root.__TAURI__.core && root.__TAURI__.core.invoke) || (internals && internals.invoke);
  const listen = root.__TAURI__ && root.__TAURI__.event && root.__TAURI__.event.listen;
  if (!invoke || label === 'settings') return;

  const host = doc.createElement('div'); host.className = 'int-host'; host.hidden = true; leftCard.append(host);
  let focus = null, detail = false, calMode='week', calDate=Date.now(), calSelected=null, rendered=null; const updates = {}, refreshing = new Set();
  const onScreen = () => {
    const d = capsule.dataset;
    return d.phase === 'expanded' && d.view === 'overview' && !d.card && d.settings !== 'open' &&
      !['pending', 'expired', 'outcome'].includes(d.question) && d.noticeView !== 'notices' && !doc.hidden;
  };
  const el = (tag, cls, txt) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (txt) n.textContent = txt; return n; };
  const dot = color => { const n = el('i', 'dot'); n.style.background = color; return n; };
  const head = (color, name, kind) => { const h = el('div', 'int-head'); h.append(dot(color), el('b', '', name), el('span', '', kind)); return h; };
  const back = () => { const b = el('button', 'int-back', '‹'); b.type = 'button'; b.setAttribute('aria-label', 'Volver'); b.addEventListener('click', e => { if (e.isTrusted === true) { detail = false; draw(); } }); return b; };
  const more = () => { const b = el('button', 'int-more', '…'); b.type = 'button'; b.title = 'Detalles'; b.addEventListener('click', e => { if (e.isTrusted === true) { detail = true; draw(); } }); return b; };
  const badge = (ok, txt) => { const c = ok ? api.GREEN : api.RED; const b = el('span', 'int-badge', txt); b.style.color = c; b.style.background = c + '24'; return b; };
  const open = url => { if (url) invoke('open_chat_url', { payload: { url } }).then(()=>doc.dispatchEvent(new CustomEvent('abito:integration-opened',{detail:{url}})),()=>{}); };

  function card(v) {
    const c = el('div', 'int-card');
    if (v.id === 'integration_vercel') {
      c.append(head('#7C5CFF', 'Vercel', 'Despliegues'));
      if (v.kind !== 'list') { c.append(statusLine(v)); return c; }
      const rows = el('div', 'int-rows');
      v.rows.forEach((r, i) => {
        const row = el('div', i === 0 ? 'int-row first' : 'int-row');
        row.append(dot(r.ok ? api.GREEN : api.RED), el('span', 'int-name', r.project), el('span', 'int-ago', r.ago));
        if (i === 0) row.append(more());
        rows.append(row);
      });
      c.append(rows); return c;
    }
    if(v.id==='integration_calcom' && v.kind==='bookings') return calendarCard(c,v);
    if (v.id !== 'integration_n8n') return simpleCard(c, v);
    c.append(head('#F29B38', 'n8n', 'Workflow'));
    if (v.kind !== 'workflow') { c.append(statusLine(v)); return c; }
    const pill = el('button', 'int-pill'); pill.type = 'button';
    const color = v.ok ? api.GREEN : api.RED;
    pill.style.background = color + '1a'; pill.style.borderColor = color + '38';
    pill.append(dot(color), el('span', 'int-name', v.workflow), el('span', '', '…'));
    pill.addEventListener('click', e => { if (e.isTrusted === true) { detail = true; draw(); } });
    const actions = el('div', 'int-actions'); actions.append(pill); c.append(actions); return c;
  }
  function calendarCard(c,v) {
    c.append(head(api.COLORS[v.id],v.name,'Agenda · UTC'));
    const model=api.calendarView(updates[v.id]?.data?.bookings,calMode,calDate,calSelected);
    c.dataset.calendar=calSelected&&model.detail?'detail':calMode;
    const action=(label,fn)=>{
      const b=el('button','int-link',label);b.type='button';
      b.addEventListener('click',e=>{e.stopPropagation();if(e.isTrusted===true){fn();draw();}});return b;
    };
    const nav=el('div','int-actions');
    nav.append(action('‹',()=>{calDate-=(calMode==='day'?1:7)*86400000;calSelected=null;}),
      action('Semana',()=>{calMode='week';calSelected=null;}),action('Día',()=>{calMode='day';calSelected=null;}),
      action('›',()=>{calDate+=(calMode==='day'?1:7)*86400000;calSelected=null;}));c.append(nav);
    if(model.detail) {
      const b=model.detail;
      c.append(el('b','int-name',b.title),el('div','int-status',new Date(b.at).toISOString().slice(0,16).replace('T',' ')+' UTC'),
        el('div','int-status',b.attendee||'Sin invitado'),el('div','int-status',b.notes),action('Volver a la agenda',()=>{calSelected=null;}));
      return c;
    }
    const days=el('div','int-actions');
    for(const day of model.days) days.append(action(new Date(day).toISOString().slice(5,10),()=>{calDate=day;calMode='day';}));c.append(days);
    if(!model.rows.length)c.append(el('div','int-empty','No hay llamadas agendadas'));
    for(const b of model.rows) c.append(action(b.title+' · '+new Date(b.at).toISOString().slice(11,16),()=>{calSelected=b.id;}));
    return c;
  }
  function simpleCard(c, v) {
    let extra = null;
    if (v.kind === 'emails' && v.total !== null) { extra = el('span', 'int-total'); extra.append(el('i', 'pulse'), el('span', '', String(v.total))); }
    const h = head(api.COLORS[v.id], v.name, api.KINDS[v.id]); if (extra) h.append(extra); c.append(h);
    const rows = el('div', v.kind === 'emails' ? 'int-rows' : 'int-rows tight');
    if (v.kind === 'payments') {
      const bal = el('div', 'int-balance'); bal.append(el('span', '', v.balance), el('i', '', v.currency)); c.append(bal);
      for (const p of v.payments) { const r = el('div', 'int-row'); const amt = el('span', 'int-amount', p.amount); amt.style.color = '#22c55e'; r.append(dot(p.ok ? api.GREEN : api.RED), el('span', 'int-name', p.text), amt, el('span', 'int-ago', p.ago)); rows.append(r); }
    } else if (v.kind === 'emails') {
      v.rows.forEach((e, i) => { const r = el('div', i === 0 ? 'int-row first' : 'int-row'); r.append(dot(e.ok ? api.GREEN : api.RED), el('span', 'int-name', e.to), el('span', 'int-ago', e.ago)); if (e.subject) r.append(el('span', 'int-sub', e.subject)); rows.append(r); });
    } else if (v.kind === 'pages') {
      for (const p of v.rows) {
        const b = el('button', 'int-page'); b.type = 'button';
        b.append(el('span', 'int-emoji', p.emoji || '▤'), el('span', 'int-name', p.title), el('span', 'int-ago', p.ago));
        b.addEventListener('click', e => { if (e.isTrusted === true) open(p.url); });
        rows.append(b);
      }
    } else if (v.kind === 'bookings') {
      if (!v.rows.length) rows.append(el('div', 'int-empty', 'No hay llamadas agendadas'));
      for (const b of v.rows) { const r = el('div', 'int-row'); r.append(dot('#C9956A'), el('span', 'int-time', b.when), el('span', 'int-name', b.title)); rows.append(r); }
    } else { c.append(statusLine(v)); return c; }
    c.append(rows); return c;
  }
  function statusLine(v) {
    const s = el('div', 'int-status'); s.append(dot(v.kind === 'error' ? api.RED : '#6B7079'), el('span', '', v.status)); return s;
  }
  function detailCard(v) {
    const c = el('div', 'int-card detail'), h = el('div', 'int-detail-head');
    if (v.id === 'integration_vercel') {
      const d = v.rows[0];
      h.append(back(), dot(d.ok ? api.GREEN : api.RED), el('b', '', d.project), badge(d.ok, api.STATE_LABEL[d.state] || 'Error'));
      const body = el('div', 'int-detail-body');
      if (d.commit) body.append(el('div', 'int-commit', d.commit));
      const meta = el('div', 'int-meta'); if (d.branch) meta.append(el('span', '', d.branch)); meta.append(el('span', '', 'hace ' + d.ago)); body.append(meta);
      if (d.url) { const l = el('button', 'int-link', d.url.slice(8)); l.type = 'button'; l.addEventListener('click', e => { if (e.isTrusted === true) open(d.url); }); body.append(l); }
      c.append(h, body); return c;
    }
    h.append(back(), dot(v.ok ? api.GREEN : api.RED), el('b', '', v.workflow), badge(v.ok, v.ok ? 'Éxito' : 'Falló'));
    c.append(h, v.detail ? el('pre', 'int-detail-text', v.detail) : el('div', 'int-status', v.ok ? 'Completado correctamente.' : 'No hay detalles del error.'));
    return c;
  }
  function draw() {
    const show = api.IDS.includes(focus) && onScreen();
    host.hidden = !show;
    if (show) { if(overview.dataset.integration!=='on') overview.dataset.integration = 'on'; if(capsule.dataset.integration!=='on') capsule.dataset.integration = 'on'; }
    else { delete overview.dataset.integration; delete capsule.dataset.integration; }
    if (!show) { detail = false; rendered=null; return; }
    const v = api.view(focus, updates[focus]);
    v.refreshing = refreshing.has(focus);
    // Same-value lifecycle writes and snapshots for other services are not
    // content changes. Detaching a pressed button loses its trusted click.
    const calendar=focus==='integration_calcom' ? [calMode,api.calendarView(updates[focus]?.data?.bookings,calMode,calDate,calSelected)] : null;
    const next=JSON.stringify([v,detail,calendar]);
    if(next===rendered) return;
    rendered=next;
    const hasDetail = (v.kind === 'list') || (v.kind === 'workflow');
    host.replaceChildren(detail && hasDetail ? detailCard(v) : card(v));
    host.dataset.state = v.refreshing ? 'refreshing' : v.kind === 'missing_key' ? 'missing_key' : v.stale ? 'stale' : v.kind === 'error' ? 'error' : 'ready';
    if (v.stale) host.append(el('div','int-status','Datos anteriores · '+(v.error || 'pendiente de actualizar')));
    const id=focus, actions = el('div','int-actions');
    const refresh = el('button','int-link',v.refreshing?'Actualizando…':'Actualizar'); refresh.type='button'; refresh.disabled=v.refreshing;
    refresh.addEventListener('click',e=>{e.stopPropagation(); if(e.isTrusted===true) refreshFocus(id);});
    const link = el('button','int-link','Abrir '+api.NAMES[focus]); link.type='button';
    link.addEventListener('click',e=>{e.stopPropagation(); if(e.isTrusted===true) open(api.openTarget(id));});
    actions.append(refresh,link); host.append(actions);
  }
  async function refreshFocus(id) {
    if (!api.IDS.includes(id) || refreshing.has(id)) return;
    refreshing.add(id); draw();
    try {
      await new Promise(resolve=>requestAnimationFrame(resolve));
      const r=await invoke('integration_action',{payload:{action:'refresh',id}});
      for(const u of Object.values(r?.updates || {})) setUpdate(u);
    } catch {
      updates[id]={...updates[id],id,state:updates[id]?.updatedAt?'stale':'error',error:'No se pudo actualizar la integración.'};
    } finally {refreshing.delete(id);draw();}
  }
  let announced='';
  const announce = () => {
    const ids=Object.keys(updates).filter(id=>!['missing_key','error'].includes(updates[id]?.state));
    const key=ids.join('|'); if(key===announced) return; announced=key;
    doc.dispatchEvent(new CustomEvent('abito:integration-seen',{detail:{ids}}));
  };
  const setUpdate = u => {
    if (!u || typeof u.id !== 'string' || !api.IDS.includes(u.id)) return;
    updates[u.id] = u; announce(); draw();
    if (u.event && typeof u.event === 'object') doc.dispatchEvent(new CustomEvent('abito:integration-badge', { detail: { id: u.id } }));
  };
  doc.addEventListener('abito:integration-focus', e => {
    const id = e && e.detail && typeof e.detail.id === 'string' ? e.detail.id : null;
    const changed=id!==focus;
    if (changed) detail = false; focus = id; draw();
    if (changed && focus && onScreen()) void refreshFocus(focus);
  });
  if (listen) listen('integration:update', e => setUpdate(e && e.payload)).catch(() => {});
  invoke('integration_action', { payload: { action: 'view' } }).then(r => { for (const u of Object.values((r && r.updates) || {})) if (u && api.IDS.includes(u.id)) updates[u.id] = u; announce(); draw(); }, () => {});
  doc.addEventListener('visibilitychange', draw);
  if (typeof MutationObserver !== 'undefined') new MutationObserver(draw).observe(capsule, { attributes: true, attributeFilter: ['data-phase', 'data-view', 'data-settings', 'data-card', 'data-question', 'data-notice-view'] });
}
