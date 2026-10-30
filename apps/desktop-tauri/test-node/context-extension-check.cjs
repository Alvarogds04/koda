'use strict';
// #487: the GNOME Shell extension and the Rust reader (src/contextwin.rs) agree on the D-Bus
// contract, and the extension stays read-only and local.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.join(__dirname, '..');
const dir = path.join(root, 'gnome-extension', 'abito-context@abito');
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8'));
const js = fs.readFileSync(path.join(dir, 'extension.js'), 'utf8');
const rs = fs.readFileSync(path.join(root, 'src', 'contextwin.rs'), 'utf8');
const rsConst = (n) => new RegExp(`pub const ${n}: &str = "([^"]+)"`).exec(rs)[1];

assert.strictEqual(meta.uuid, 'abito-context@abito');
assert.strictEqual(path.basename(dir), meta.uuid, 'directory name must equal the uuid');
assert.ok(meta['shell-version'].includes('50'), 'GNOME 50 is declared');
assert.strictEqual(rsConst('BUS_NAME'), 'org.abito.Context');
assert.ok(js.includes(`const BUS_NAME = '${rsConst('BUS_NAME')}'`));
assert.ok(js.includes(`const OBJECT_PATH = '${rsConst('OBJECT_PATH')}'`));
assert.ok(js.includes(`<interface name="${rsConst('INTERFACE')}">`));
assert.ok(js.includes(`<method name="${rsConst('METHOD')}">`));
assert.ok(js.includes('type="a(sss)"'));
assert.ok(js.includes(`${rsConst('METHOD')}()`));
// local, and read-only EXCEPT ONE method (v2, ActivateByPid): it may only RAISE the window of one pid. Nothing
// else may act on windows, spawn, or reach the network, and no window id or pid ever leaves the extension.
for (const bad of ['kill', 'GLib.spawn', 'Soup', 'Gio.Subprocess', 'win.get_id', 'get_stable_sequence', 'move_', 'eval(']) {
  assert.ok(!js.includes(bad), `extension must not use ${bad}`);
}
// the two acting/pid-reading calls exist ONLY inside ActivateByPid
const outside = js.replace(/ActivateByPid\(pid\) \{[\s\S]*?\n    \}\n/, '');
for (const acting of ['activate(', 'get_pid']) {
  assert.ok(js.includes(acting), `${acting} is used by ActivateByPid`);
  assert.ok(!outside.includes(acting), `${acting} must not appear outside ActivateByPid`);
}
assert.strictEqual(meta.version, 2, 'a changed contract is a new extension version');
assert.ok(js.includes('<method name="ActivateByPid">') && js.includes('type="u" direction="in" name="pid"') && js.includes('type="b" direction="out" name="activated"'));
// it never answers with anything but a boolean: no pid, id, title or geometry
const body = /ActivateByPid\(pid\) \{([\s\S]*?)\n    \}\n/.exec(js)[1];
const returns = [...body.matchAll(/return ([^;]*);/g)].map(m => m[1].trim());
assert.ok(returns.length >= 2 && returns.every(r => r === '[true]' || r === '[false]'), `only [true] / [false]: ${returns}`);
assert.ok(/Copyright \(c\) 2026 Louis Raillé, MIT/.test(js), 'citation present');
assert.ok(js.includes('<method name="GetWindowAt">'), 'additive point query');
assert.ok(js.includes('type="a(sssiiii)"'), 'one geometry tuple, no ids');
assert.ok(js.includes('direction="in" name="x"') && js.includes('direction="in" name="y"'));
assert.ok(js.includes('GetWindowAt(x, y)'));
assert.ok(js.includes('get_window_actors') && js.includes('sort_windows_by_stacking'));
assert.ok(js.includes('minimized') && js.includes('showing_on_its_workspace'));
assert.ok(js.includes("includes('abito')"), 'skip own windows before selecting');
assert.ok(js.includes('get_frame_rect'));
for (const bad of ['win.focus(', 'win.delete(', '.change_workspace(', '.resize(']) assert.ok(!js.includes(bad), bad);
// Exercise the real method with a Shell fake: bottom-to-top stacking, no window mutations.
const vm = require('node:vm');
const ctx = { Extension: class {}, Shell: { WindowTracker: { get_default: () => ({ get_window_app: w => w.app }) } } };
vm.createContext(ctx);
vm.runInContext(js.replace(/^import .*;$/gm, '').replace('export default class', 'globalThis.Ext = class'), ctx);
const windowAt = new ctx.Ext();
const make = (id, name, title, x = 10) => ({
  app: { get_id: () => id, get_name: () => name },
  get_wm_class: () => id, get_title: () => title, is_skip_taskbar: () => false,
  showing_on_its_workspace: () => true, located_on_workspace: () => true, minimized: false,
  get_frame_rect: () => ({ x, y: 20, width: 100, height: 80 }),
});
let windows = [make('firefox', 'Firefox', 'bottom'), make('code', 'Code', 'top'), make('com.abito', 'Abito', 'own')];
ctx.global = { workspace_manager: { get_active_workspace: () => 'current' },
  get_window_actors: () => windows.map(meta_window => ({ meta_window })),
  display: { sort_windows_by_stacking: ws => ws } };
const query = (x, y) => JSON.parse(JSON.stringify(windowAt.GetWindowAt(x, y)));
assert.deepEqual(query(10, 20), [[['code', 'Code', 'top', 10, 20, 100, 80]]]);
assert.deepEqual(query(110, 20), [[]]);
assert.deepEqual(query(10, 100), [[]]);
windows[1].minimized = true;
assert.equal(query(50, 50)[0][0][1], 'Firefox');
windows[1].minimized = false;
windows[1].is_skip_taskbar = () => true;
assert.equal(query(50, 50)[0][0][1], 'Firefox');
windows[1].is_skip_taskbar = () => false;
windows[1].showing_on_its_workspace = () => false;
assert.equal(query(50, 50)[0][0][1], 'Firefox');
windows[1].showing_on_its_workspace = () => true;
windows[1].located_on_workspace = () => false;
assert.equal(query(50, 50)[0][0][1], 'Firefox');
windows = [make('unknown', '  ', 'empty'), make('other', 'Other', 'outside', 200)];
assert.deepEqual(query(50, 50), [[]]);
console.log('context-extension-check ok (9 point-query cases)');
