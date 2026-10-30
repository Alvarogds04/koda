'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const main = read('src/main.rs');
const checks = {
  'F1 idle shutdown polling is bounded to two wakeups per second': () => {
    const watcher = main.split('fn spawn_shutdown_watcher(')[1].split('// ---')[0];
    assert.match(watcher, /sleep\(Duration::from_millis\(500\)\)/);
    assert.doesNotMatch(watcher, /from_millis\(50\)/);
    assert.match(watcher, /SHUTDOWN_SIGNAL.load/);
  },
  'G1 main window lookup is optional and never panics': () => {
    assert.match(main, /fn main_window\(app: &AppHandle\) -> Option<WebviewWindow>/);
    assert.doesNotMatch(main, /expect\("main window must exist"\)/);
    assert.doesNotMatch(main, /let win = main_window\([^;\n]+\);/);
  },
  'G2 character locks and drop targets cannot panic': () => {
    const character = read('src/characterhost.rs').split('#[cfg(test)]')[0];
    assert.doesNotMatch(character, /\.lock\(\)\.unwrap\(\)|target\.unwrap\(\)/);
  },
  'G3 question frame identity fails closed': () => {
    const transport = read('src/transport.rs');
    assert.doesNotMatch(transport, /expect\("identified"\)/);
    assert.match(transport, /let Some\(bound\) = identity.as_ref\(\) else/);
  },
  'G4 absent opener is a typed denial': () => {
    assert.doesNotMatch(main, /expect\("validated opener spawned"\)/);
    assert.match(main, /child.ok_or_else\(\|\| BridgeError::denied\("external opener unavailable"\)\)/);
  },
};
let failed = 0;
for (const [name, check] of Object.entries(checks)) {
  try { check(); console.log('PASS', name); }
  catch (error) { failed++; console.error('FAIL', name, error.message.split('\n')[0]); }
}
if (failed) process.exitCode = 1;
