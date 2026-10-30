// Abito window context — GNOME Shell extension (#487).
//
// Adapted in purpose from Coucou NotchBuddy/Sources/App/WindowContextCapture.swift @71b773f,
// Copyright (c) 2026 Louis Raillé, MIT. Original code, no Coucou files copied.
//
// Exposes on the SESSION bus (name org.abito.Context):
//   GetRecentWindows() -> a(sss)   (app id, app name, title), most recently focused first.
//   GetWindowAt(x, y) -> a(sssiiii)  (the window under a point, geometry for explicit character drags)
//   ActivateByPid(pid) -> b          (v2: bring the window of ONE process to the front)
// Everything but ActivateByPid is read-only. ActivateByPid only raises: it takes a pid, activates the most
// recently focused window whose own pid matches it and answers whether one existed. It never moves, resizes or
// closes anything, runs no code or process, and exposes no window ids, pids or content. Automatic capture is
// opt-in; explicit character drags query geometry on demand.
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const BUS_NAME = 'org.abito.Context';
const OBJECT_PATH = '/org/abito/Context';
const MAX_HISTORY = 8;

const IFACE = `<node>
  <interface name="org.abito.Context">
    <method name="GetRecentWindows">
      <arg type="a(sss)" direction="out" name="windows"/>
    </method>
    <method name="ActivateByPid">
      <arg type="u" direction="in" name="pid"/>
      <arg type="b" direction="out" name="activated"/>
    </method>
    <method name="GetWindowAt">
      <arg type="i" direction="in" name="x"/>
      <arg type="i" direction="in" name="y"/>
      <arg type="a(sssiiii)" direction="out" name="windows"/>
    </method>
  </interface>
</node>`;

export default class AbitoContextExtension extends Extension {
    enable() {
        this._history = []; // Meta.Window, most recent first
        this._unmanaged = new Map(); // window -> signal id
        this._focusId = global.display.connect('notify::focus-window', () => this._remember(global.display.focus_window));
        this._remember(global.display.focus_window);
        this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
        this._dbus.export(Gio.DBus.session, OBJECT_PATH);
        this._ownerId = Gio.bus_own_name_on_connection(
            Gio.DBus.session, BUS_NAME, Gio.BusNameOwnerFlags.NONE, null, null);
    }

    disable() {
        if (this._ownerId) Gio.bus_unown_name(this._ownerId);
        this._ownerId = 0;
        this._dbus?.unexport();
        this._dbus = null;
        if (this._focusId) global.display.disconnect(this._focusId);
        this._focusId = 0;
        for (const [win, id] of this._unmanaged) win.disconnect(id);
        this._unmanaged.clear();
        this._history = [];
    }

    _remember(win) {
        if (!win || win.is_skip_taskbar()) return;
        this._history = this._history.filter(w => w !== win);
        this._history.unshift(win);
        this._history.length = Math.min(this._history.length, MAX_HISTORY);
        if (!this._unmanaged.has(win)) {
            this._unmanaged.set(win, win.connect('unmanaged', () => {
                this._unmanaged.delete(win);
                this._history = this._history.filter(w => w !== win);
            }));
        }
    }

    // Adapted from Coucou NotchBuddy/Sources/App/IslandWindowController.swift @71b773f, Copyright (c) 2026 Louis Raillé, MIT.
    // Meta frame rectangles and the input point are both in stage logical pixels.
    GetWindowAt(x, y) {
        const tracker = Shell.WindowTracker.get_default();
        const windows = global.display.sort_windows_by_stacking(
            global.get_window_actors().map(actor => actor.meta_window)).reverse();
        for (const win of windows) {
            if (win.minimized || win.is_skip_taskbar() || !win.showing_on_its_workspace()
                || !win.located_on_workspace(global.workspace_manager.get_active_workspace())) continue;
            const app = tracker.get_window_app(win);
            const id = app?.get_id() ?? win.get_wm_class() ?? '';
            const name = app?.get_name() ?? win.get_wm_class() ?? '';
            if (`${id} ${name} ${win.get_wm_class() ?? ''}`.toLowerCase().includes('abito') || !name.trim()) continue;
            const r = win.get_frame_rect();
            if (x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height) {
                return [[[id, name, win.get_title() ?? '', r.x, r.y, r.width, r.height]]];
            }
        }
        return [[]];
    }

    // v2. Abito asks this for the terminal that runs the agent session you clicked. The Shell refuses
    // org.gnome.Shell.FocusApp to other clients, and a native Wayland window has no X11 id, so this is the one way
    // to raise it by process. Most recently focused first among windows of that pid; none -> false.
    ActivateByPid(pid) {
        if (!Number.isInteger(pid) || pid <= 0) return [false];
        const windows = global.display.sort_windows_by_stacking(
            global.get_window_actors().map(actor => actor.meta_window)).reverse();
        const candidates = [...this._history, ...windows];
        for (const win of candidates) {
            if (win.get_pid() === pid && !win.is_skip_taskbar()) {
                win.activate(global.get_current_time());
                return [true];
            }
        }
        return [false]; // wrapJSObject wants the out args as a tuple
    }

    GetRecentWindows() {
        const tracker = Shell.WindowTracker.get_default();
        const rows = this._history.map(win => {
            const app = tracker.get_window_app(win);
            return [app?.get_id() ?? win.get_wm_class() ?? '', app?.get_name() ?? win.get_wm_class() ?? '', win.get_title() ?? ''];
        });
        return [rows]; // wrapJSObject wants the out args as a tuple
    }
}
