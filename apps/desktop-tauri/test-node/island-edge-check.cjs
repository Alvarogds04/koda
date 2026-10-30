'use strict';
const assert = require('node:assert/strict');
const I = require('../frontend/island-interaction.js');
const facts = extra => ({state:'compact',view:'overview',settled:true,nativeReady:true,
  ...Object.fromEntries(I.BLOCKERS.map(k=>[k,false])),notice:false,pinned:false,...extra});
const mouse = {isTrusted:true,pointerType:'mouse',buttons:0};
function fixture() {
  let now=0, id=0; const jobs=new Map(), changes=[];
  const c=I.createEdgeController({now:()=>now,schedule:(fn,ms)=>{const n=++id;jobs.set(n,{fn,at:now+ms});return n;},cancel:n=>jobs.delete(n),onHidden:v=>changes.push(v)});
  const advance=ms=>{const end=now+ms;for(;;){const next=[...jobs].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>end)break;now=next[1].at;jobs.delete(next[0]);next[1].fn();}now=end;};
  return {c,jobs,changes,advance,early(){const [id,job]=[...jobs][0];jobs.delete(id);job.fn();}};
}
// Diagnostic reasons describe the exact same gate as concealment.
for (const [extra, why] of [
  [{}, 'clear'], [{state:'expanded'}, 'state:expanded'], [{settled:false}, 'unsettled'],
  [{nativeReady:false}, 'native'], ...['question','approval','request','decision','card'].map(k=>[{[k]:true},k]),
  [{pointerInside:true}, 'pointer'],
]) { const d=fixture(); d.c.update(facts(extra)); assert.equal(d.c.snapshot().why,why); }
const f=fixture(); f.c.update(facts()); f.advance(9999); assert.equal(f.c.snapshot().hidden,false);
f.advance(1); assert.equal(f.c.snapshot().hidden,true,'default ten-second idle hides (human: «ocultar a los 10 segundos»)');
f.c.enter(mouse); assert.equal(f.c.snapshot().hidden,false,'pointer wakes immediately');
f.advance(600000); assert.equal(f.c.snapshot().hidden,false,'never hide under pointer');
f.c.leave(mouse); f.c.setPreferences({sound:false,absenceSeconds:30}); f.advance(999); assert.equal(f.c.snapshot().hidden,false);
f.advance(1); assert.equal(f.c.snapshot().hidden,true,'muted compact hides after one second outside');
f.c.alert(); assert.equal(f.c.snapshot().hidden,false,'alert wakes');
// human: «solo lo frena una pregunta pendiente» — a pending question/permission (queued ones are the same flag: the head is pending)
for(const block of ['question','approval','request','decision','card']) {
  const p=fixture();p.c.setPreferences({sound:false,absenceSeconds:5});p.c.update(facts());p.advance(1000);
  p.c.update(facts({[block]:true})); assert.equal(p.c.snapshot().hidden,false,block+' reveals');
  p.advance(600000);assert.equal(p.c.snapshot().hidden,false,block+' prevents hiding');
}
// status notices, the hotkey chip, a stuck «pinned», a draft, a field, a panel, a drag... never keep the island out of the edge
for(const harmless of ['notice','pinned','editing','composing','draft','settings','models','dragging']) {
  const p=fixture();p.c.setPreferences({sound:true,absenceSeconds:10});p.c.update(facts({[harmless]:true}));
  p.advance(9999);assert.equal(p.c.snapshot().hidden,false,harmless+' not yet');
  p.advance(1);assert.equal(p.c.snapshot().hidden,true,harmless+' does not block hiding');
}
{ const p=fixture();p.c.update(facts({view:'chat'}));p.advance(10000);assert.equal(p.c.snapshot().hidden,true,'the stale data-view of a folded island does not block hiding'); }
{ const p=fixture();p.c.update({state:'compact',settled:true,nativeReady:true});p.advance(600000);assert.equal(p.c.snapshot().hidden,false,'a missing ask fact is not permission (fail closed)'); }
{ const p=fixture();p.c.update(facts({question:true}));p.advance(60000);p.c.update(facts());p.advance(9999);assert.equal(p.c.snapshot().hidden,false);p.advance(1);assert.equal(p.c.snapshot().hidden,true,'once the question is answered the full delay restarts'); }
// the setting: whole SECONDS 5..300 (was minutes 1..120)
for(const ok of [5,10,300]) { const p=fixture();p.c.setPreferences({sound:true,absenceSeconds:ok});p.c.update(facts());p.advance(ok*1000-1);assert.equal(p.c.snapshot().hidden,false,ok+'s early');p.advance(1);assert.equal(p.c.snapshot().hidden,true,ok+'s hides'); }
for(const bad of [0,4,301,1.5,'10',null,undefined,NaN,-5]) assert.throws(()=>fixture().c.setPreferences({sound:true,absenceSeconds:bad}),TypeError,String(bad));
assert.throws(()=>fixture().c.setPreferences({sound:true,absenceMinutes:3}),TypeError,'the old minutes field is no longer a preference');
assert.deepEqual(I.EDGE_ABSENCE,{min:5,max:300,default:10});
for(const state of ['expanded','hidden','unknown']) {const p=fixture();p.c.update(facts({state}));p.advance(600000);assert.equal(p.c.snapshot().hidden,false,state);}
const lostLeave=fixture(); lostLeave.c.setPreferences({sound:false,absenceSeconds:5}); lostLeave.c.update(facts()); lostLeave.c.enter(mouse); lostLeave.c.update(facts({pointerInside:false})); lostLeave.advance(1000); assert.equal(lostLeave.c.snapshot().hidden,true,'live hover readback clears stale inside after native remapping');
const early=fixture(); early.c.setPreferences({sound:false,absenceSeconds:5}); early.c.update(facts()); early.advance(999); early.early(); early.advance(1); assert.equal(early.c.snapshot().hidden,true,'early WebKit timer delivery retries only the remaining millisecond');
const p=fixture();p.c.setPreferences({sound:true,absenceSeconds:60});p.c.update(facts());p.advance(30000);p.c.update(facts());p.advance(30000);assert.equal(p.c.snapshot().hidden,true,'snapshot churn cannot postpone absence');
p.c.stop();const before=p.changes.length;p.advance(600000);assert.equal(p.changes.length,before);
console.log('PASS island-edge: absence (seconds), mute, pointer/alert wake, only a pending question blocks, teardown');
