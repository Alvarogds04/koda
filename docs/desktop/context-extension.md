# Koda window context: the GNOME Shell extension

Source: `apps/desktop-tauri/gnome-extension/abito-context@abito/` (`extension.js`, `token.js`, `metadata.json`).
Extension version **4**; GNOME Shell 45 to 50. A changed contract is a new extension version.

## Installing it

`sh apps/desktop-tauri/gnome-extension/install.sh` copies **every file of the extension folder** (today `metadata.json`,
`extension.js` and `token.js`) into `$XDG_DATA_HOME/gnome-shell/extensions/abito-context@abito/` (default
`~/.local/share/...`). `extension.js` imports `token.js`: a copy without it does not load at all, so the installer
never lists files by hand, and `test-node/context-extension-install-check.cjs` runs it into a temporary data
directory and checks that every imported module arrived. It does not enable the extension: that is yours
(`gnome-extensions enable abito-context@abito`; on Wayland, log out and in once after the first copy).

On GNOME Wayland no other process can read which window you were using or raise a window by itself, so Koda ships a
small Shell extension that exposes that over the **session D-Bus** (name `org.abito.Context`, object
`/org/abito/Context`, interface `org.abito.Context`): which windows you used, raising a window, and (v4, only when you
ask Koda about your window) a picture of one window. This page is the privacy contract of that extension: what it
answers, what it never does, when Koda asks and its known limits. The feature as a whole is in
[window-capture.md](window-capture.md).

## Methods

| Method | Signature | What it does |
| --- | --- | --- |
| `GetRecentWindows` | `() -> a(sss)` | The last 8 focused windows as `(app id, app name, title)`, most recently focused first. Read-only. |
| `GetWindowAt` | `(x: i, y: i) -> a(sssiiii)` | The top window under a point, with its frame geometry `(x, y, width, height)`, for an explicit character drag. Returns an empty list when no window is there. Read-only. |
| `ActivateByPid` | `(pid: u) -> b` | **v2.** Brings to the front the most recently focused window whose own process id is `pid`, and answers whether one existed. |
| `Register` | `(token: s) -> b` | **v4.** Binds Koda's per-launch token (at least 32 characters) to the calling D-Bus connection. First caller wins; while a live owner holds the binding every other `Register` answers `false`. |
| `PickWindow` | `(token: s) -> (t, s, s, s)` | **v4.** An opaque id, app id, app name and title of the most recently focused window that is not Koda's and has a name. The id is random, issued by the extension per window (a weak reference; never the Shell's own window id) and means nothing outside it. Refused with `org.abito.Context.NotAllowed` unless `token` is the registered one. |
| `CaptureWindow` | `(id: t, token: s) -> s` | **v4.** Resolves an id `PickWindow` issued (anything else fails with `org.abito.Context.CaptureFailed`), paints that one window into a private PNG (`$XDG_RUNTIME_DIR/koda-capture`, directory 0700, file 0600) and answers its path, never the pixels. Same refusal as `PickWindow`. |

### `Register`, `PickWindow`, `CaptureWindow` (v4)

Koda keeps **one** session-bus connection for the whole life of the island, registers its token on it once when the
capture endpoint starts, and uses it for every pick and capture. The extension releases the binding when that
connection leaves the bus (one bus name watch per live owner, removed on release), so while nobody is bound
`PickWindow` and `CaptureWindow` refuse everything. A program that registers before Koda holds the binding until it
leaves, and the token it registered is a WORKING token: that program can pick and capture through the extension
(the extension cannot tell who is on the other end). Koda, which cannot register, then captures nothing and tells you
another program holds its GNOME extension (restart the session or Koda). The refusal-by-token is the only gate: no
process name or command line is ever consulted. `GetRecentWindows`, `GetWindowAt` and `ActivateByPid` are not gated.
See «Known limits» below.

### `ActivateByPid` (v2)

Koda asks this for the terminal that runs the agent session you clicked. The Shell refuses `org.gnome.Shell.FocusApp`
to other clients, and a native Wayland window has no X11 id, so raising by process id is the one way to do it.

Bounded and exact:

- Only a window whose **own pid** matches (`win.get_pid() === pid`); never an arbitrary window id, a title or a
  command line. A pid that is not a positive integer answers `false`.
- Among windows of that pid, the most recently focused first; none -> `false`.
- It only **raises** (`win.activate`). It never moves, resizes, minimises or closes anything.

## What the extension never does

- It never sends data to the network. Its only channel is the session bus, which the user's own session processes can
  reach.
- It runs no code and no process: no `eval`, no spawn.
- It never reveals the Shell's own window ids or any pid. `GetRecentWindows` and `GetWindowAt` return app id, app name
  and title (and frame geometry for the window under a point). Since v4, `PickWindow` returns an opaque id that the
  extension itself issues (random, per window, a weak reference, forgotten when the window closes), and
  `CaptureWindow` returns the path of a private PNG of that one window: window content does leave the Shell, to the
  one program that holds the token, as a file only you can read.
- `ActivateByPid` raises a window; `CaptureWindow` writes the PNG described above. Everything else is read-only, and
  `PickWindow`/`CaptureWindow` are the only methods behind the token.
- `GetWindowAt` and `PickWindow` skip windows of Koda itself and windows without a name. `GetRecentWindows` and
  `ActivateByPid` skip only windows the Shell hides from the taskbar.

## When Koda asks

- **Automatic chat context is opt-in.** Koda calls `GetRecentWindows` only while «Contexto de la ventana activa» is on.
- `GetWindowAt` is called on demand for an explicit window drag and for per-app dictation styles.
- `ActivateByPid` is called when you click an agent session in the island to raise its terminal.
- `Register` is called once when Koda starts (and again if the extension appears or forgets it and Koda next asks).
- `PickWindow` and `CaptureWindow` are called only when you ask Koda about your window in the chat, the option
  «Dejar que Koda vea mi ventana» (Ajustes → Chat, off by default) is on, and a 30-minute permission you granted in
  Koda's own dialog is active; Koda checks the sensitive-app list on what `PickWindow` returns before capturing. With
  the option off, or without a grant, neither is called. See [window-capture.md](window-capture.md).

## Known limits (0.3 debt)

Recorded in the 0.3 backlog; honest about what v4 does not close. The gate lives in the extension, the other rules
(option, consent, refusal list) only in Koda, so these limits matter exactly because they let another program skip
Koda.

- **The gate can be empty.** If the extension appears on the bus after Koda started (enabled later, or the Shell
  restarted while Koda runs), nobody is bound until Koda's next pick: a same-user program that registers in that gap
  gets a working token and can capture. Koda does not yet watch `NameOwnerChanged` of `org.abito.Context`.
- **The token travels in clear on the session bus.** The default bus policy (`/usr/share/dbus-1/session.conf`) allows
  eavesdropping, and `PickWindow`/`CaptureWindow` check only the token, not the sender: a process that reads it from
  the bus while Koda is bound can capture.
- **Three methods are not gated.** `GetRecentWindows`, `GetWindowAt` and `ActivateByPid` answer any process of your
  user without a token: window titles are readable and a window can be brought to the front.
- **Reconnect can say the wrong thing.** After Koda reconnects following a bus error, its own stale binding can make
  it show «otro programa tiene la extensión» although no other program is involved.

The trust model is the same user: anything running as you can already do much of this. These limits narrow what the
extension adds, they are not a sandbox.
## Verification

`apps/desktop-tauri/src/sessionterm_tests.rs` checks that the extension source keeps this contract (the method
exists, matches only by the window's own pid, has no code or process execution) and that this page names
`ActivateByPid`. `test-node/context-extension-gate-check.cjs` runs the real `extension.js` and `token.js` against fakes
of the Shell and the bus: nothing is picked or captured while nobody is bound or with a wrong token, a second
`Register` is refused while a live owner holds the binding, the binding and its watch go when the owner's bus name
vanishes. `src/windowcapture/gnome_tests.rs` and `tests/windowcapture_gnome.rs` check the Rust side.
