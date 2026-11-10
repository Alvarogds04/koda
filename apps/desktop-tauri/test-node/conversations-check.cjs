'use strict';
// #341 → K2-05 T4 U4: production chat scripts driven through their public DOM + IPC surface. One continuous chat
// (L3/L4/L11): no conversation list, no «new», no specialists; earlier turns load by scrolling up or with «Cargar anteriores».
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const frontend = path.join(__dirname, '..', 'frontend');
const turn = n => ({ turn_id: `t-${n}`, user_text: `question ${n}`, reply: `reply ${n}`, state: 'completed', seq: 2 });
async function page() {
  const nodes = new Map(), calls = [], listeners = {};
  const fire = (el, event) => { event.preventDefault = () => { event.defaultPrevented = true; }; for (const fn of el.listeners[event.type] || []) fn(event); return event; };
  let document;
  const make = (id = null, tag = 'div') => {
    const e = { id, tagName: tag.toUpperCase(), dataset: {}, attributes: {}, listeners: {}, children: [], hidden: false, disabled: false, value: '', scrollTop: 0, scrollHeight: 1000, clientHeight: 300, style: {},
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      setAttribute(k,v) { this.attributes[k] = String(v); }, getAttribute(k) { return this.attributes[k] || null; }, removeAttribute(k) { delete this.attributes[k]; },
      addEventListener(k,fn) { (this.listeners[k] ||= []).push(fn); },
      append(...items) { for (const n of items) { n.parent = this; this.children.push(n); } }, appendChild(n) { this.append(n); return n; },
      prepend(...items) { for (const n of items) n.parent = this; this.children.unshift(...items); },
      replaceChildren(...items) { this.children = []; this.append(...items); },
      remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this),1); },
      querySelector(sel) { return sel === 'li.empty' ? this.children.find(n => n.className === 'empty') || null : null; }, querySelectorAll() { return []; },
      focus() { document.activeElement = this; }, blur() { document.activeElement = null; }, click() { return fire(this,{type:'click',detail:0}); },
    };
    let text = ''; Object.defineProperty(e,'textContent',{get:()=> text, set:v=>{text=String(v); e.children=[];}});
    Object.defineProperty(e,'lastElementChild',{get:()=>e.children.at(-1)}); return e;
  };
  document = { ...make(), activeElement: null, body: make(), getElementById(id) { if (!nodes.has(id)) nodes.set(id,make(id)); return nodes.get(id); }, createElement: tag=>make(null,tag), importNode:n=>n, dispatchEvent(e) { fire(this,e); } };
  const pages = [];
  let state = { conversation_id:'c-koda', active_turn:null, availability:{state:'ready',message:'ready'}, turns:[turn(36),turn(37)], history_before:36 };
  const settle = () => new Promise(resolve=>setImmediate(resolve));
  let hostAnswer=null;
  const invoke = async (_command, {payload:p}) => {
    calls.push(structuredClone(p));
    if(hostAnswer){const a=hostAnswer(p,clock);if(a!==undefined)return a;}
    if(p.action === 'history') return pages.shift() || {conversation_id:p.conversation_id,turns:[],before:null,skipped:0};
    return structuredClone(state);
  };
  // a controllable clock: timers fire only when the test advances it
  let clock=1000000,timerId=0;const timers=[];
  const advance=async ms=>{clock+=ms;for(;;){const due=timers.filter(t=>t.at<=clock).sort((a,b)=>a.at-b.at)[0];if(!due)break;timers.splice(timers.indexOf(due),1);due.fn();await settle();}};
  const sandbox={document,console,structuredClone,crypto:{getRandomValues:b=>b},Date:{now:()=>clock},setTimeout:(fn,ms)=>{timers.push({fn,at:clock+(Number(ms)||0),id:++timerId});return timerId;},clearTimeout(id){const at=timers.findIndex(t=>t.id===id);if(at>=0)timers.splice(at,1);},requestAnimationFrame:f=>f(),CustomEvent:class{constructor(type,o){this.type=type;this.detail=o.detail;}},DOMParser:class{parseFromString(){return {documentElement:null};}},__TAURI__:{core:{invoke},event:{listen:async(k,f)=>{listeners[k]=f;}}}};
  sandbox.window=sandbox; sandbox.self=sandbox; vm.createContext(sandbox);
  for(const file of ['chat-view.js','chat.js']) vm.runInContext(fs.readFileSync(path.join(frontend,file),'utf8'),sandbox,{filename:file});
  document.getElementById('capsule').dataset.view='chat'; document.getElementById('capsule').dataset.phase='expanded'; await settle();
  return {nodes,document,calls,pages,fire,settle,advance,setInvoke:f=>{hostAnswer=f;},push:async s=>{state={...state,...s}; listeners['chat:state']({payload:state});await settle();},el:id=>document.getElementById(id)};
}
(async()=>{
  let passed=0;
  async function check(name, fn) { await fn(); passed++; console.log(`ok ${passed} - ${name}`); }
  const chatSrc=fs.readFileSync(path.join(frontend,'chat.js'),'utf8');
  const html=fs.readFileSync(path.join(frontend,'index.html'),'utf8');
  const page2=(n,before)=>({conversation_id:'c-koda',turns:[turn(n),turn(n+1)],before,skipped:0});
  await check('one continuous chat: the page never calls new/new_with/list/restore, and Ctrl+N does nothing',async()=>{
    // the chat verb set only (`action(...)` = chat_action; modelsAction({action:'list'}) is the model picker's own closed verb)
    for(const verb of ['new','new_with','list','restore'])assert.doesNotMatch(chatSrc,new RegExp(`\\baction\\(\\{\\s*action:\\s*'${verb}'`),verb);
    assert.doesNotMatch(chatSrc,/createConversation|conversationRows|specialistRows|conversationsPanel/);
    const p=await page();p.el('chat-input').value='draft';
    const event=p.fire(p.document,{type:'keydown',key:'n',ctrlKey:true});await p.settle();
    assert.notEqual(event.defaultPrevented,true,'Ctrl+N is not taken');assert.equal(p.el('chat-input').value,'draft','the draft stays');
    assert.deepEqual(p.calls.map(c=>c.action).filter(a=>['new','new_with','list','restore'].includes(a)),[],JSON.stringify(p.calls));
  });
  await check('no saved-conversations dialog, no «Hablar con…», no «+»/clock buttons, no Ctrl+N help',async()=>{
    for(const id of ['conversations','conversations-list','conversations-close','conversations-note','specialists-list','specialists-title','chat-create','chat-conversations'])assert.ok(!html.includes(`id="${id}"`),id);
    assert.ok(!html.includes('Hablar con'));assert.ok(!html.includes('Ctrl+N'));
    assert.ok(html.indexOf('id="chat-load-earlier"')>html.indexOf('id="chat-history-controls"'),'«Cargar anteriores» lives in the history row');
  });
  await check('F2: a cursor published AFTER the first view still pages older turns on scroll-up (the id never changes)',async()=>{
    const p=await page();await p.push({history_before:null});
    await p.push({history_before:36});
    const log=p.el('chat-log');Object.defineProperty(log,'scrollHeight',{get:()=>log.children.length*100});
    p.pages.push(page2(34,null));log.scrollTop=0;p.fire(log,{type:'scroll'});await p.settle();
    assert.deepEqual(p.calls.find(x=>x.action==='history'),{action:'history',conversation_id:'c-koda',before:36});
    assert.equal(log.children.length,8);assert.equal(log.scrollTop,400,'the same message stays under the eye');
    await p.push({turns:[turn(36),turn(37)]});assert.equal(log.children.length,8,'a live push never duplicates loaded pages');
    p.fire(log,{type:'scroll'});await p.settle();assert.equal(p.calls.filter(x=>x.action==='history').length,1,'nothing older: no more requests');
  });
  await check('«Cargar anteriores» is a visible keyboard control that pages without scrolling and hides at the start of the chat',async()=>{
    const p=await page();const b=p.el('chat-load-earlier');const log=p.el('chat-log');log.scrollTop=500;
    assert.equal(b.hidden,false,'shown while older turns exist');
    p.pages.push(page2(34,34),page2(32,null));
    b.click();await p.settle();
    assert.deepEqual(p.calls.filter(x=>x.action==='history').map(x=>x.before),[36]);
    assert.equal(b.hidden,false);b.click();await p.settle();
    assert.deepEqual(p.calls.filter(x=>x.action==='history').map(x=>x.before),[36,34],'the next page uses the cursor the last page returned');
    assert.equal(b.hidden,true,'nothing older: the control goes away');
    assert.equal(log.children.length,12);
  });
  await check('a sliding live window never drops loaded history: turns that leave the window stay on the page',async()=>{
    const p=await page();p.pages.push(page2(34,null));p.el('chat-load-earlier').click();await p.settle();
    await p.push({turns:[turn(37),turn(38)],history_before:37});
    const log=p.el('chat-log');assert.equal(log.children.length,10,'34..38 all still drawn');
    assert.equal(p.el('chat-load-earlier').hidden,true,'the loaded pages already reach the start');
  });
  // ---- K2-05 T4 S2 paging redesign: the re-verifier's cases against the real chat.js + chat-view.js -----------------
  // The fake host answers exactly what chatclient.rs ChatHost answers for DAEMON-shaped pages (conversations.cjs
  // pageHistory: ids s0-<i>, at most `max(end)` messages and 192 KiB counted back from the end, hasEarlier = more
  // before): a turn id is its prompt's record position, a page answer carries only the WHOLE turns of that one daemon
  // page and the daemon's own cursor (its first prompt), a page that is only a lone reply answers no turn but moves
  // the cursor, and that reply completes the last turn of the next page. Never «exactly 50 turns».
  const daemonChat=(total,{max=()=>48,noReply=()=>false,big=()=>0,ask=()=>0}={})=>{
    const log=[];
    const q=k=>`q${k}`+(ask(k)?' '+'p'.repeat(ask(k)):'');
    for(let k=0;k<total;k++){log.push({role:'user',text:q(k)});if(!noReply(k))log.push({role:'assistant',text:`r${k}`+(big(k)?' '+'x'.repeat(big(k)):'')});}
    const msg=i=>({id:`s0-${i+1}`,role:log[i].role,text:log[i].text});
    const pos=id=>Number(id.slice(3))+1, idAt=p=>`s0-${p-1}`;
    const page=end=>{let from=end,bytes=0;while(from>0&&end-from<max(end)){const size=JSON.stringify(msg(from-1)).length;if(from<end&&bytes+size>192*1024)break;bytes+=size;from--;}return {messages:Array.from({length:end-from},(_,j)=>msg(from+j)),hasEarlier:from>0};};
    const heads=new Map();
    const rows=(messages,hasEarlier,answered)=>{
      const first=messages.findIndex(m=>m.role==='user');let cursor=null;
      if(first<0){if(hasEarlier&&messages.length){heads.set(messages[0].id,messages.map(m=>m.text).join('\n\n'));cursor=pos(messages[0].id);}return {turns:[],cursor};}
      if(hasEarlier)cursor=pos(messages[first].id);
      const turns=[];let prev=null;
      for(const m of messages.slice(first)){
        if(m.role==='user')turns.push({turn_id:`t-${pos(m.id)}`,user_text:m.text,reply:'',state:'completed',seq:2});
        else if(prev&&prev.role==='user'&&pos(m.id)===pos(prev.id)+1)turns.at(-1).reply=m.text;
        prev=m;
      }
      const last=messages.at(-1);
      if(answered&&heads.has(answered)&&last.role==='user'&&pos(answered)===pos(last.id)+1)turns.at(-1).reply=heads.get(answered);
      return {turns,cursor};
    };
    const newest=()=>{const p=page(log.length);const {turns,cursor}=rows(p.messages,p.hasEarlier,null);const cut=Math.max(0,turns.length-50);
      return {turns:turns.slice(cut),history_before:cut?Number(turns[cut].turn_id.slice(2)):cursor};};
    const earlier=before=>{const id=idAt(before);const p=page(Number(id.slice(3))-1);const {turns,cursor}=rows(p.messages,p.hasEarlier,id);return {conversation_id:'c-koda',turns,before:cursor,skipped:0};};
    const expected=Array.from({length:total},(_,k)=>noReply(k)?[q(k)]:[q(k),`r${k}`+(big(k)?' '+'x'.repeat(big(k)):'')]).flat();
    return {newest,earlier,expected};
  };
  // the page wired to a daemon chat; rows on screen, in DOM order
  async function pagedChat(chat){
    const p=await page();
    const stamps=[];
    p.setInvoke((q,now)=>{if(q.action!=='history'||q.before===null)return undefined;stamps.push(now);return chat.earlier(q.before);});
    await p.push(chat.newest());
    const log=p.el('chat-log');Object.defineProperty(log,'scrollHeight',{get:()=>log.children.length*100});
    const rows=()=>log.children.filter(li=>li.className!=='empty').map(li=>li.textContent);
    const reads=()=>p.calls.filter(c=>c.action==='history');
    // scroll to the top and let the coalescing timer fire: one page per scroll
    const up=async()=>{log.scrollTop=0;p.fire(log,{type:'scroll'});await p.advance(V.PAGE_GAP_MS);};
    const toTop=async label=>{let guard=0;while(!p.el('chat-load-earlier').hidden){assert.ok(++guard<=4*chat.expected.length,`${label}: paging terminates`);await up();}};
    return {p,log,rows,reads,up,toTop,stamps};
  }
  const V=require(path.join(frontend,'chat-view.js'));
  const uneven=end=>[48,47,45,48,31,48][end%6];
  const some=k=>k%7===3||k%11===5;
  await check('S2: 600 turns, 48-message and uneven daemon pages: up to the first turn and back down, twice — every turn once, in order, own reply, no gap',async()=>{
    for(const [label,opts] of [['48/page',{}],['48/page some unanswered',{noReply:some}],['uneven',{max:uneven,noReply:some}]]){
      for(const pass of [1,2]){
        const chat=daemonChat(600,opts);const c=await pagedChat(chat);
        assert.deepEqual(c.rows(),chat.expected.slice(chat.expected.length-c.rows().length),`${label} pass ${pass}: the newest window`);
        await c.toTop(`${label} pass ${pass}`);
        assert.deepEqual(c.rows(),chat.expected,`${label} pass ${pass}: every turn once, in order, each reply under its own question`);
        assert.equal(c.p.el('chat-new').hidden,false,'away from the newest message: «Ir al final» is offered');
        // back down to the newest: everything stays loaded (Gentle Dot keeps it), so no request and no gap
        const before=c.reads().length;
        for(let top=0;top<=c.log.scrollHeight;top+=300){c.log.scrollTop=top;c.p.fire(c.log,{type:'scroll'});}
        await c.p.advance(V.PAGE_GAP_MS);
        assert.equal(c.reads().length,before,'scrolling down needs no request');
        assert.equal(c.p.el('chat-new').hidden,true,'at the bottom «Ir al final» goes away');
        assert.deepEqual(c.rows(),chat.expected,`${label} pass ${pass}: still every turn once, in order, after the way down`);
      }
    }
  });
  await check('S2: one-message daemon pages (lone replies) still advance and every reply stays under its own question',async()=>{
    const chat=daemonChat(72,{max:end=>end===144?48:1});const c=await pagedChat(chat);
    await c.toTop('one-message pages');
    assert.deepEqual(c.rows(),chat.expected);
  });
  await check('S2: a newest page holding only a lone reply (prompt ~9 KB, reply ~190 KB) still offers and pages the history',async()=>{
    const chat=daemonChat(3,{max:()=>100,big:k=>k===2?185*1024:0,ask:k=>k===2?9*1024:0});
    const view=chat.newest();assert.deepEqual(view.turns,[],'the daemon\'s newest page is the lone reply');assert.ok(view.history_before,'with a cursor');
    const c=await pagedChat(chat);
    assert.equal(c.p.el('chat-load-earlier').hidden,false,'«Cargar anteriores» is offered');
    await c.toTop('lone newest reply');
    assert.deepEqual(c.rows(),chat.expected);
  });
  await check('S2: a reconnect (the same window pushed again) while a page is in flight never shifts or repeats the run',async()=>{
    const chat=daemonChat(350,{noReply:some});const c=await pagedChat(chat);
    for(let k=0;k<4;k++)await c.up();
    let release;const held=new Promise(r=>{release=r;});
    c.p.setInvoke(q=>q.action==='history'&&q.before!==null?held.then(()=>chat.earlier(q.before)):undefined);
    c.log.scrollTop=0;c.p.fire(c.log,{type:'scroll'});await c.p.advance(V.PAGE_GAP_MS);
    await c.p.push({connection:'lost',turns:[]});await c.p.push(chat.newest()); // the newest page arrives again
    release();await c.p.settle();await c.p.settle();
    c.p.setInvoke(q=>q.action==='history'&&q.before!==null?chat.earlier(q.before):undefined);
    await c.toTop('after the reconnect');
    assert.deepEqual(c.rows(),chat.expected,'every turn once, in order, never renumbered');
  });
  await check('S2: a fast 1,500-turn pass stays inside the island read share (≤100 per minute) and a send goes through at the end',async()=>{
    const chat=daemonChat(1500,{noReply:some});const c=await pagedChat(chat);
    let guard=0;
    while(!c.p.el('chat-load-earlier').hidden){ // the reader flings the wheel: a scroll event every 16 ms
      assert.ok(++guard<200000,'paging terminates');
      c.log.scrollTop=0;c.p.fire(c.log,{type:'scroll'});await c.p.advance(16);
    }
    assert.deepEqual(c.rows(),chat.expected,'every turn once, in order');
    for(let top=c.log.scrollHeight;top>=0;top-=50){c.log.scrollTop=top;c.p.fire(c.log,{type:'scroll'});await c.p.advance(16);}
    for(let top=0;top<=c.log.scrollHeight;top+=50){c.log.scrollTop=top;c.p.fire(c.log,{type:'scroll'});await c.p.advance(16);}
    const pages=c.stamps.length;
    const perMinute=Math.max(...c.stamps.map(t=>c.stamps.filter(s=>s>=t&&s<t+60000).length));
    console.log(`  1,500 turns: ${pages} page requests for the whole up-and-down pass, at most ${perMinute} in any minute`);
    assert.ok(perMinute<=100,`inside the read share of the island's 120/min (20 reserved for send/abort): ${perMinute}`);
    assert.equal(c.reads().length,pages,'one request per daemon page, nothing more');
    c.p.setInvoke(()=>undefined);
    c.p.el('chat-input').value='al final';c.p.fire(c.p.el('chat-input'),{type:'input'});c.p.fire(c.p.el('chat-composer'),{type:'submit'});await c.p.settle();
    assert.equal(c.p.calls.filter(x=>x.action==='submit').length,1,'the send goes out');
  });
  await check('S2: «Ir al final» has a real name and the page announces leaving and reaching the newest message',async()=>{
    assert.match(html,/<button id="chat-new"[^>]*aria-label="Ir al final"/);
    const chat=daemonChat(120);const c=await pagedChat(chat);
    const live=c.p.el('chat-live');
    await c.up();
    assert.equal(c.p.el('chat-new').hidden,false);assert.match(live.textContent,/Ya no estás viendo lo último/);
    c.p.el('chat-new').click();await c.p.settle();
    assert.equal(c.p.el('chat-new').hidden,true);assert.match(live.textContent,/Estás viendo lo último/);
    assert.equal(c.log.scrollTop,c.log.scrollHeight,'the log is at the newest message');
  });
  await check('Existing send wiring still invokes submit with exact draft',async()=>{
    const p=await page();p.el('chat-input').value='hello';p.fire(p.el('chat-input'),{type:'input'});p.fire(p.el('chat-composer'),{type:'submit'});await p.settle();assert.equal(p.calls.find(x=>x.action==='submit').text,'hello');
  });
  console.log(`conversations-check: ${passed} passed`);
})().catch(e=>{console.error(e);process.exitCode=1;});
