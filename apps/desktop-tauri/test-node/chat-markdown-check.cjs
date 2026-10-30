'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(__dirname, '../frontend/chat-markdown.js');
// Before implementation the public baseline is plain text; RED evaluates every rule.
const M = fs.existsSync(file) ? require(file) : {
  blocks: s => [{ kind: 'paragraph', text: s }], inline: s => [{ kind: 'text', text: s }],
  safeWebUrl: () => null, render: (el, s) => { el.textContent = s; },
};
class Node {
  constructor(tag = '#text', text = '') { this.tagName = tag; this.children = []; this.value = text; this.attributes = {}; this.events = {}; this.style = {}; this.className = ''; }
  set textContent(s) { this.children = []; this.value = String(s); }
  get textContent() { return this.value + this.children.map(n => n.textContent).join(''); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.value = ''; this.children = nodes; }
  setAttribute(k, v) { this.attributes[k] = v; }
  addEventListener(k, f) { this.events[k] = f; }
  set innerHTML(_) { throw Error('HTML sink forbidden'); }
}
const doc = { createElement: t => new Node(t), createTextNode: t => new Node('#text', t) };
const all = n => [n, ...n.children.flatMap(all)];
let passed = 0, failed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log('PASS ' + name); } catch (e) { failed++; console.error('FAIL ' + name + ': ' + e.message); } };
test('blocks: headings 1-6 require a space, otherwise paragraph', () => {
  for (let n = 1; n <= 6; n++) assert.deepEqual(M.blocks('#'.repeat(n) + ' Title'), [{ kind: 'heading', level: n, text: 'Title' }]);
  for (const s of ['#no-space', 'plain']) assert.deepEqual(M.blocks(s), [{ kind: 'paragraph', text: s }]);
});
test('blocks: fenced language, flat item indentation, quote and exact rules', () => {
  assert.deepEqual(M.blocks('####### capped'), [{kind:'heading',level:6,text:'capped'}]);
  assert.deepEqual(M.blocks('one\ntwo\n\nnext'), [{kind:'paragraph',text:'one\ntwo'}, {kind:'paragraph',text:'next'}]);
  assert.deepEqual(M.blocks('12.\titem'), [{kind:'item',indent:0,marker:'12.',text:'item'}]);
  assert.deepEqual(M.blocks('```js\na < b\n```'), [{ kind: 'code', lang: 'js', text: 'a < b' }]);
  for (const mark of ['-', '*', '+', '12.']) assert.deepEqual(M.blocks('   ' + mark + ' item'), [{ kind: 'item', indent: 1, marker: mark, text: 'item' }]);
  assert.deepEqual(M.blocks('> q\n>\n---\n***\n___'), [{kind:'quote',text:'q'}, {kind:'quote',text:''}, ...Array.from({length:3}, () => ({kind:'rule'}))]);
});
test('inline: single regex grammar and snake_case boundary', () => {
  assert.deepEqual(M.inline('`c` **b** __b__ *e* _e_').filter(t => t.kind !== 'text').map(t => [t.kind,t.text]), [['code','c'],['bold','b'],['bold','b'],['em','e'],['em','e']]);
  assert.deepEqual(M.inline('snake_case_name'), [{kind:'text',text:'snake_case_name'}]);
  for (const s of ['**unfinished', '[bad](missing', '`unfinished']) assert.equal(M.inline(s).map(t => t.text).join(''), s);
});
test('bare greater-than is an empty quote in parser and public DOM renderer', () => {
  assert.deepEqual(M.blocks('>'), [{kind:'quote',text:''}]);
  const n = new Node('li'); M.render(n, '>', {document:doc});
  assert.equal(n.children.length, 1); assert.equal(n.children[0].tagName, 'blockquote');
  assert.equal(n.children[0].textContent, '');
});
test('pinned quote requires greater-than space or exactly bare greater-than in parser and DOM', () => {
  for (const [source, kind, tag, text] of [['>text', 'paragraph', 'p', '>text'], ['> text', 'quote', 'blockquote', 'text'], ['>', 'quote', 'blockquote', '']]) {
    assert.deepEqual(M.blocks(source), [{kind, text}]);
    const n = new Node('li'); M.render(n, source, {document:doc});
    assert.equal(n.children.length, 1); assert.equal(n.children[0].tagName, tag);
    assert.equal(n.children[0].textContent, text);
    assert.equal(all(n).some(x => ['a','button','script','img'].includes(x.tagName)), false);
  }
});
test('safe links are real anchors; every click prevents frontend navigation, only trusted activation calls host', () => {
  assert.equal(M.safeWebUrl('https://example.test/a'), 'https://example.test/a');
  assert.equal(M.safeWebUrl('http://example.test'), 'http://example.test/');
  const n = new Node('li'); const calls=[]; M.render(n, '[go](https://example.test/a)', { document: doc, openUrl: u => calls.push(u) });
  const a = all(n).find(x => x.tagName === 'a'); assert.ok(a); assert.equal(a.textContent, 'go');
  assert.equal(a.attributes.href, 'https://example.test/a');
  let prevented=0;
  a.events.click({ isTrusted: false, preventDefault: () => { prevented++; } }); assert.deepEqual(calls, []); assert.equal(prevented,1);
  a.events.click({ isTrusted: true, preventDefault: () => { prevented++; } }); assert.deepEqual(calls, ['https://example.test/a']); assert.equal(prevented,2);
  assert.equal(all(n).some(x => x.tagName === 'button'), false);
});
test('hostile HTML, event handlers, unsafe URLs and unsupported images stay inert', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///tmp/x', 'not-url']) {
    assert.equal(M.safeWebUrl(url), null);
    const n = new Node('li'); const s = `[x](${url})`; M.render(n, s, { document: doc });
    assert.equal(n.textContent, s); assert.equal(all(n).some(x => x.tagName === 'button' || x.tagName === 'a'), false);
  }
  for (const s of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '[broken](url', '![alt](https://example.test/x)']) {
    const n = new Node('li'); M.render(n, s, { document: doc }); assert.equal(n.textContent, s);
    assert.equal(all(n).some(x => ['script','img','a','button'].includes(x.tagName)), false);
  }
});
test('code copy is trusted-only, no HTML sink, clipboard failure remains bounded', () => {
  const n = new Node('li'); const calls=[];
  M.render(n, '```js\n<x>\n```', { document: doc, copyCode: s => calls.push(s) });
  const b = all(n).find(x => x.tagName === 'button'); assert.ok(b);
  b.events.click({isTrusted:false}); assert.deepEqual(calls, []);
  b.events.click({isTrusted:true}); assert.deepEqual(calls, ['<x>']);
  assert.equal(all(n).find(x => x.tagName === 'code').textContent, '<x>');
});
test('partial to complete renders replace content without changing the row', () => {
  const n = new Node('li'); M.render(n, '**par', {document:doc}); assert.equal(n.textContent, '**par');
  M.render(n, '**partial**', {document:doc}); assert.equal(n.textContent, 'partial'); assert.ok(all(n).some(x => x.tagName === 'strong'));
});
test('shipping and chat integration: markdown before consumers, no CSP relaxation', () => {
  const html = fs.readFileSync(path.join(__dirname,'../frontend/index.html'),'utf8');
  assert.ok(html.includes('href="chat-markdown.css"'));
  assert.ok(html.indexOf('src="chat-markdown.js"') >= 0 && html.indexOf('src="chat-markdown.js"') < html.indexOf('src="chat.js"'));
  const chat = fs.readFileSync(path.join(__dirname,'../frontend/chat.js'),'utf8');
  assert.match(chat, /AbitoChatMarkdown/); assert.match(chat, /invoke\('open_chat_url'/);
  assert.equal(require('../packaging/lib.cjs').FRONTEND_FILES.includes('chat-markdown.js'), true);
  assert.equal(require('../packaging/lib.cjs').FRONTEND_FILES.includes('chat-markdown.css'), true);
  if(fs.existsSync(file)) assert.doesNotMatch(fs.readFileSync(file,'utf8'), /innerHTML|window\.open|\(\?</);
});
console.log(`${passed} markdown checks passed; ${failed} failed`); process.exitCode = failed ? 1 : 0;
