'use strict';
// #341: production chat scripts driven through their public DOM + IPC surface.
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
  let state = { conversation_id:'c-first', active_turn:null, availability:{state:'ready',message:'ready'}, turns:[turn(36),turn(37)], history_before:36 };
  const settle = () => new Promise(resolve=>setImmediate(resolve));
  const invoke = async (_command, {payload:p}) => {
    calls.push(JSON.parse(JSON.stringify(p)));
    if(p.action === 'new') state={...state, conversation_id:'c-new', turns:[],history_before:null};
    if(p.action === 'restore') state={...state,conversation_id:p.conversation_id,turns:[turn(36),turn(37)],history_before:36};
    if(p.action === 'list') return {conversations:[{id:'c-first',title:'<img onerror=evil>',specialist:{name:'Writer'},last_activity:10}],skipped:1};
    if(p.action === 'history') return {conversation_id:p.conversation_id,turns:[turn(34),turn(35)],before:null,skipped:0};
    return JSON.parse(JSON.stringify(state));
  };
  const sandbox={document,console,crypto:{getRandomValues:b=>b},setTimeout:()=>0,clearTimeout(){},requestAnimationFrame:f=>f(),CustomEvent:class{constructor(type,o){this.type=type;this.detail=o.detail;}},DOMParser:class{parseFromString(){return {documentElement:null};}},__TAURI__:{core:{invoke},event:{listen:async(k,f)=>{listeners[k]=f;}}}};
  sandbox.window=sandbox; sandbox.self=sandbox; vm.createContext(sandbox);
  for(const file of ['chat-view.js','chat.js']) vm.runInContext(fs.readFileSync(path.join(frontend,file),'utf8'),sandbox,{filename:file});
  document.getElementById('capsule').dataset.view='chat'; document.getElementById('capsule').dataset.phase='expanded'; await settle();
  return {nodes,document,calls,fire,settle,push:async s=>{state={...state,...s}; listeners['chat:state']({payload:state});await settle();},el:id=>document.getElementById(id)};
}
(async()=>{
  let passed=0;
  async function check(name, fn) { await fn(); passed++; console.log(`ok ${passed} - ${name}`); }
  await check('New button clears draft and visible context; Ctrl+N uses the same IPC and respects IME',async()=>{
    const p=await page(); p.el('chat-input').value='draft'; p.el('chat-create').click();await p.settle();
    assert.equal(p.calls.filter(x=>x.action==='new').length,1);assert.equal(p.el('chat-input').value,'');assert.equal(p.el('chat-log').children.length,1);
    const event=p.fire(p.document,{type:'keydown',key:'n',ctrlKey:true});await p.settle();assert.equal(event.defaultPrevented,true);assert.equal(p.calls.filter(x=>x.action==='new').length,2);
    p.fire(p.document,{type:'keydown',key:'n',ctrlKey:true,isComposing:true});await p.settle();assert.equal(p.calls.filter(x=>x.action==='new').length,2);
  });
  await check('List shows plain title, specialist and activity; selecting restores and closes it',async()=>{
    const p=await page();p.el('chat-conversations').click();await p.settle();assert.equal(p.calls.at(-1).action,'list');assert.equal(p.el('conversations').hidden,false);
    const row=p.el('conversations-list').children[0];assert.ok(row);assert.match(row.children[0].textContent,/<img onerror=evil>/);assert.match(row.children[0].getAttribute('aria-label'),/Writer/);
    row.children[0].click();await p.settle();assert.ok(p.calls.some(x=>x.action==='restore'&&x.conversation_id==='c-first'));assert.equal(p.el('conversations').hidden,true);
  });
  await check('Scroll-up pages older turns, preserves the scroll anchor and does not duplicate snapshots',async()=>{
    const p=await page();const log=p.el('chat-log');Object.defineProperty(log,'scrollHeight',{get:()=>log.children.length*100});log.scrollTop=0;p.fire(log,{type:'scroll'});await p.settle();
    assert.deepEqual(p.calls.find(x=>x.action==='history'),{action:'history',conversation_id:'c-first',before:36});assert.equal(log.children.length,8);assert.equal(log.scrollTop,400);
    await p.push({turns:[turn(36),turn(37)]});assert.equal(log.children.length,8);p.fire(log,{type:'scroll'});await p.settle();assert.equal(p.calls.filter(x=>x.action==='history').length,1);
    p.el('chat-conversations').click();await p.settle();p.el('conversations-list').children[0].children[0].click();await p.settle();assert.equal(log.children.length,4,'reopening the same ID resets loaded presentation pages');
    await p.push({conversation_id:'c-other',turns:[turn(1)],history_before:null});assert.equal(log.children.length,2);
  });
  await check('Existing send wiring still invokes submit with exact draft',async()=>{
    const p=await page();p.el('chat-input').value='hello';p.fire(p.el('chat-input'),{type:'input'});p.fire(p.el('chat-composer'),{type:'submit'});await p.settle();assert.equal(p.calls.find(x=>x.action==='submit').text,'hello');
  });
  const html=fs.readFileSync(path.join(frontend,'index.html'),'utf8');for(const id of ['chat-create','chat-conversations','conversations','conversations-list'])assert.ok(html.includes(`id="${id}"`),id);
  assert.ok(html.indexOf('id="chat-create"')>html.indexOf('id="chat-body"'),'controls cannot live in the calm-state hidden status strip');
  const icons=require('../frontend/icons.js');
  for(const name of ['bubble','clock'])assert.ok(icons.NAMES.includes(name),name);
  console.log(`conversations-check: ${passed} passed`);
})().catch(e=>{console.error(e);process.exitCode=1;});
