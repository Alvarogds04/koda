'use strict';
// Public desktop facade only: no DOM implementation pins or live sockets.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ID = '3f2b8a40-1c2d-4e5f-8a6b-7c8d9e0f1a2b';
const source = fs.readFileSync(path.join(__dirname, '../frontend/desktop.js'), 'utf8');
(async () => {
  const calls = [];
  const window = { __TAURI__: { core: { invoke: async (command, args) => {
    calls.push({command, args});
    if (args.payload.kind === 'unknown') throw {code:'denied',message:'Denied: unknown notice kind'};
    return {state:'expanded'};
  } } } };
  vm.runInNewContext(source, {window});
  assert.equal(typeof window.desktop.click, 'function', 'the public facade must offer typed notice click');
  for (const kind of ['question', 'finished']) {
    const result = await window.desktop.click({id:ID,kind, index:0, extra:'ignored'});
    assert.deepEqual(result, {state:'expanded'});
    assert.equal(JSON.stringify(calls.at(-1)), JSON.stringify({command:'desktop_action',args:{payload:{action:'click',id:ID,kind}}}));
  }
  await assert.rejects(window.desktop.click({id:ID,kind:'unknown'}), {code:'denied',message:'Denied: unknown notice kind'});
  assert.deepEqual(calls.map(c => c.args.payload.action), ['click','click','click']);
  await window.desktop.dismiss();
  await window.desktop.expand();
  await window.desktop.choose(1);
  assert.equal(JSON.stringify(calls.slice(3)), JSON.stringify([
    {command:'desktop_action',args:{payload:{action:'dismiss'}}},
    {command:'desktop_action',args:{payload:{action:'expand'}}},
    {command:'desktop_action',args:{payload:{action:'choose',index:1}}},
  ]));
  assert(!calls.some(c => ['allow','deny','answer','decline'].includes(c.args.payload.action)));
  // #437: the per-row × dismisses an EXACT notice id; the argument-free call is
  // unchanged above (the pinned M2 shape). The id is passed through as-is:
  // Rust validates it (parse_dismiss) and refuses an unknown one with zero mutation.
  const DISMISS_ID = '3f2b8a40-1c2d-4e5f-8a6b-7c8d9e0f1a2b';
  await window.desktop.dismiss(DISMISS_ID);
  assert.equal(JSON.stringify(calls.at(-1)), JSON.stringify({command:'desktop_action',args:{payload:{action:'dismiss',id:DISMISS_ID}}}));
  assert(Object.isFrozen(window.desktop));
  // #336 U5: the additive autoClose verb rides the SAME single desktop_action
  // gate — one argument-free payload, nothing else (L17: one pinned assertion).
  await window.desktop.autoClose();
  assert.equal(JSON.stringify(calls.at(-1)), JSON.stringify({command:'desktop_action',args:{payload:{action:'autoClose'}}}));
  // Structural native-adapter readback complements (does not replace) Cargo's
  // public parser/planner tests. No native app or shared transport is started.
  const main = fs.readFileSync(path.join(__dirname, '../src/main.rs'), 'utf8');
  const command = main.slice(main.indexOf('async fn desktop_action('), main.indexOf('fn log_click_denied('));
  assert(command.indexOf('bridge::sender_ok(') < command.indexOf('bridge::parse_click('));
  assert(command.indexOf('bridge::parse_click(') < command.indexOf('state.rate.lock()'));
  assert(command.indexOf('bridge::parse_click(') < command.indexOf('bridge::validate_payload('));
  const click = main.slice(main.indexOf('fn dispatch_click('), main.indexOf('fn click_native_current('));
  assert(click.includes('bridge::route_click(') && click.includes('questionhost::with_question_click('));
  assert(click.includes('desktop::plan_click_open('));
  assert(!/approval::|dispatch_verb\(|dispatch_action\(/.test(click), 'click must not reuse authority-bearing legacy expansion');
  assert(click.indexOf('publish(app, state)') < click.indexOf('app.emit("desktop:notice-open"'));
  assert(click.includes('click_native_current(state, generation)'), 'native application is fenced');
  assert(click.includes('ensure_island_window(app)'), 'clicks use the fixed-window funnel');
  assert(!click.includes('std::thread::spawn'), 'there is no deferred native resize to fence');
  assert(main.includes('desktop::click_plan_is_current('));
  process.stdout.write('notice-click-check: 6 facade groups + native wiring checks passed\n');
})().catch(error => { process.stderr.write(`${error.stack || String(error)}\n`); process.exitCode = 1; });
