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
  const invoke = async (_command, {payload:p}) => {
    calls.push(structuredClone(p));
    if(p.action === 'history') return pages.shift() || {conversation_id:p.conversation_id,turns:[],before:null,skipped:0};
    return structuredClone(state);
  };
  const sandbox={document,console,structuredClone,crypto:{getRandomValues:b=>b},setTimeout:()=>0,clearTimeout(){},requestAnimationFrame:f=>f(),CustomEvent:class{constructor(type,o){this.type=type;this.detail=o.detail;}},DOMParser:class{parseFromString(){return {documentElement:null};}},__TAURI__:{core:{invoke},event:{listen:async(k,f)=>{listeners[k]=f;}}}};
  sandbox.window=sandbox; sandbox.self=sandbox; vm.createContext(sandbox);
  for(const file of ['chat-view.js','chat.js']) vm.runInContext(fs.readFileSync(path.join(frontend,file),'utf8'),sandbox,{filename:file});
  document.getElementById('capsule').dataset.view='chat'; document.getElementById('capsule').dataset.phase='expanded'; await settle();
  return {nodes,document,calls,pages,fire,settle,push:async s=>{state={...state,...s}; listeners['chat:state']({payload:state});await settle();},el:id=>document.getElementById(id)};
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
  await check('Existing send wiring still invokes submit with exact draft',async()=>{
    const p=await page();p.el('chat-input').value='hello';p.fire(p.el('chat-input'),{type:'input'});p.fire(p.el('chat-composer'),{type:'submit'});await p.settle();assert.equal(p.calls.find(x=>x.action==='submit').text,'hello');
  });
  console.log(`conversations-check: ${passed} passed`);
})().catch(e=>{console.error(e);process.exitCode=1;});
