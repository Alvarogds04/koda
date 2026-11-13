// Abito window context — GNOME Shell extension (#487).
//
// Adapted in purpose from Coucou NotchBuddy/Sources/App/WindowContextCapture.swift @71b773f,
// Copyright (c) 2026 Louis Raillé, MIT. Original code, no Coucou files copied.
//
// Exposes on the SESSION bus (name org.abito.Context):
//   GetRecentWindows() -> a(sss)   (app id, app name, title), most recently focused first.
//   GetWindowAt(x, y) -> a(sssiiii)  (the window under a point, geometry for explicit character drags)
//   ActivateByPid(pid) -> b          (v2: bring the window of ONE process to the front)
//   PickWindow(token) -> (t, s, s, s) (v4: id, app id, app name and title of the window Koda may look at)
//   CaptureWindow(id, token) -> s     (v4: paint ONE window into a private PNG and answer its path)
//   Register(token) -> b              (v4: bind Koda's per-launch token to the calling connection)
// Everything but ActivateByPid raises a window, and only ActivateByPid does that and it only raises. Nothing
// here moves, resizes or closes a window, runs code or a process, or sends anything to the network.
//
// TRUST BOUNDARY of PickWindow and CaptureWindow (deliberate, documented in src/windowcapture/gnome.rs too):
// this bus is the user's own, so any process running as this user could call it. What stands in the way is a
// random token Koda makes fresh on every launch and keeps in memory only: Register(token) binds it to the
// caller's D-Bus unique name, and every PickWindow/CaptureWindow must present it or be refused with
// org.abito.Context.NotAllowed (picking is gated too: it reveals an app name and a title). The token is never
// written to disk, never logged and never sent anywhere but here. When the registering connection leaves the
// bus the binding is released, so a new Koda launch can register; FIRST CALLER WINS, so a program that
// registers before Koda holds the extension until it leaves - a denial of service that Koda reports as «another
// program holds Koda's GNOME extension», never a way in. CaptureWindow still takes only an opaque window id,
// paints nothing but that window, writes nowhere except $XDG_RUNTIME_DIR/koda-capture (0700, file 0600) and
// answers only its path. A same-user process that could defeat any of this can already screenshot the session
// itself, so the real boundary is the user.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {TokenGate} from './token.js';

const BUS_NAME = 'org.abito.Context';
const OBJECT_PATH = '/org/abito/Context';
const MAX_HISTORY = 8;
// Captures are written here, under the user's own 0700 runtime directory, and read by Koda at once.
const PRIVATE_DIR = 'koda-capture';

// Shell.Screenshot.composite_to_stream is callback based; the Shell itself promisifies it, and _promisify is a
// no-op when that already happened. Guarded: an older Shell without the method must not break the other methods.
let _canPromiseComposite = true;
try {
    Gio._promisify(Shell.Screenshot, 'composite_to_stream');
} catch (e) {
    _canPromiseComposite = false;
    logError(e, 'Abito: this GNOME Shell cannot encode a window capture');
}

const IFACE = `<node>
  <interface name="org.abito.Context">
    <method name="Register">
      <arg type="s" direction="in" name="token"/>
      <arg type="b" direction="out" name="registered"/>
    </method>
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
    <method name="PickWindow">
      <arg type="s" direction="in" name="token"/>
      <arg type="t" direction="out" name="id"/>
      <arg type="s" direction="out" name="app_id"/>
      <arg type="s" direction="out" name="app_name"/>
      <arg type="s" direction="out" name="title"/>
    </method>
    <method name="CaptureWindow">
      <arg type="t" direction="in" name="id"/>
      <arg type="s" direction="in" name="token"/>
      <arg type="s" direction="out" name="path"/>
    </method>
  </interface>
</node>`;

// The token a call carries, or '' when the caller sent something that is not a string.
function _tokenOf(value) {
    return typeof value === 'string' ? value : '';
}

// Write the PNG into the private directory with a fresh random name. 0600 file, 0700 directory: a window is
// never left where another user could read it.
function _writePrivatePng(bytes) {
    const runtime = GLib.get_user_runtime_dir();
    if (!runtime) throw new Error('this session has no XDG_RUNTIME_DIR to keep a private capture in');
    const dir = GLib.build_filenamev([runtime, PRIVATE_DIR]);
    if (GLib.mkdir_with_parents(dir, 0o700) !== 0) throw new Error(`cannot create the private capture directory ${dir}`);
    // The umask can only narrow 0700; if something widened it, nothing is written there.
    const mode = Gio.File.new_for_path(dir).query_info('unix::mode', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null).get_attribute_uint32('unix::mode');
    if ((mode & 0o077) !== 0) throw new Error(`the private capture directory ${dir} is not private`);
    const name = `window-${GLib.get_monotonic_time()}-${Math.floor(Math.random() * 1e9)}.png`;
    const file = Gio.File.new_for_path(GLib.build_filenamev([dir, name]));
    // PRIVATE creates it 0600; REPLACE_DESTINATION writes beside it and renames atomically.
    const out = file.replace(null, false, Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    try {
        out.write_bytes(bytes, null);
    } finally {
        out.close(null);
    }
    return file.get_path();
}

export default class AbitoContextExtension extends Extension {
    enable() {
        this._history = []; // Meta.Window, most recent first
        this._issued = new Map(); // opaque id this extension issued -> WeakRef(Meta.Window); the Shell's own window id never leaves
        this._issuedOf = new WeakMap(); // Meta.Window -> the opaque id already issued for it
        this._unmanaged = new Map(); // window -> signal id
        this._gate = new TokenGate(); // the launch token Koda registered, if any
        this._watches = []; // bus name watches that release a token when its owner leaves
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
        for (const id of this._watches) Gio.bus_unwatch_name(id);
        this._watches = [];
        this._gate = null;
        if (this._focusId) global.display.disconnect(this._focusId);
        this._focusId = 0;
        for (const [win, id] of this._unmanaged) win.disconnect(id);
        this._unmanaged.clear();
        this._history = [];
        this._issued?.clear();
        this._issued = null;
        this._issuedOf = null;
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

    // v4. Bind Koda's per-launch token to the connection that says it: first caller wins, and the
    // binding is released when that connection leaves the bus, so a new Koda launch can register.
    // `false` is not an error (another registration is live); the answer is what Koda reports on.
    RegisterAsync(params, invocation) {
        const sender = invocation.get_sender() ?? '';
        const registered = this._gate.register(_tokenOf(params[0]), sender);
        if (registered) {
            this._watches.push(Gio.bus_watch_name_on_connection(
                Gio.DBus.session, sender, Gio.BusNameWatcherFlags.NONE, null,
                () => this._gate?.release(sender)));
        }
        invocation.return_value(new GLib.Variant('(b)', [registered]));
    }

    // v4. The window Koda is allowed to look at: the most recently focused one that is not Koda's own,
    // using the same history and the same filter GetWindowAt already applies. No id means «there is
    // none», which is authoritative: the Shell can see every window. Gated like CaptureWindow: this
    // answers an app name and a title.
    PickWindowAsync(params, invocation) {
        if (!this._gate.check(_tokenOf(params[0]))) {
            invocation.return_dbus_error('org.abito.Context.NotAllowed', 'Koda must register its launch token before it may pick a window');
            return;
        }
        const tracker = Shell.WindowTracker.get_default();
        for (const win of this._history) {
            if (win.is_skip_taskbar()) continue;
            const app = tracker.get_window_app(win);
            const id = app?.get_id() ?? win.get_wm_class() ?? '';
            const name = app?.get_name() ?? win.get_wm_class() ?? '';
            if (`${id} ${name} ${win.get_wm_class() ?? ''}`.toLowerCase().includes('abito') || !name.trim()) continue;
            invocation.return_value(new GLib.Variant('(tsss)', [this._issueId(win), id, name, win.get_title() ?? '']));
            return;
        }
        invocation.return_value(new GLib.Variant('(tsss)', [0, '', '', '']));
    }

    // v4. Paint ONE window (covered windows included) into a private PNG and answer its path. Async because
    // the compositor paints into a stream, and because the invocation is answered by hand once the caller's
    // token has been checked.
    CaptureWindowAsync(params, invocation) {
        if (!this._gate.check(_tokenOf(params[1]))) {
            invocation.return_dbus_error('org.abito.Context.NotAllowed', 'Koda must register its launch token before it may capture a window');
            return;
        }
        this._captureWindow(Number(params[0])).then(
            path => invocation.return_value(new GLib.Variant('(s)', [path])),
            error => invocation.return_dbus_error('org.abito.Context.CaptureFailed', error?.message ?? String(error)));
    }

    async _captureWindow(id) {
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error('no window id was given');
        const win = this._windowById(id);
        if (!win) throw new Error('that window is gone');
        const actor = win.get_compositor_private();
        if (!actor) throw new Error('that window is not on screen');
        if (!_canPromiseComposite) throw new Error('this GNOME Shell cannot paint a window');
        // The window actor's own content: what the window shows, whether it is covered or not.
        const texture = actor.paint_to_content(null)?.get_texture();
        if (!texture) throw new Error('that window has nothing to paint');
        const stream = Gio.MemoryOutputStream.new_resizable();
        await Shell.Screenshot.composite_to_stream(texture, 0, 0, -1, -1, 1, null, 0, 0, 1, stream);
        stream.close(null);
        return _writePrivatePng(stream.steal_as_bytes());
    }

    // An opaque id this extension issued in PickWindow: it names the window only inside this extension (the
    // Shell's own window id is never read or sent). The window is looked up through a weak reference, so a
    // window that closed in between is simply gone.
    _windowById(id) {
        return this._issued?.get(id)?.deref() ?? null;
    }

    // One random, non-guessable, positive id per window, reused while the window lives; ids of closed windows
    // are dropped each time a new one is issued so the table stays as small as the open windows.
    _issueId(win) {
        const known = this._issuedOf.get(win);
        if (known) return known;
        for (const [id, ref] of this._issued) {
            if (!ref.deref()) this._issued.delete(id);
        }
        let id;
        do {
            id = GLib.random_int_range(1, 2147483647);
        } while (this._issued.has(id));
        this._issued.set(id, new WeakRef(win));
        this._issuedOf.set(win, id);
        return id;
    }
}
