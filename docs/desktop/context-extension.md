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
small Shell extension that exposes exactly that over the **session D-Bus** (name `org.abito.Context`, object
`/org/abito/Context`, interface `org.abito.Context`). This page is the privacy contract of that extension: what it
answers, what it never does, and when Koda asks.

## Methods

| Method | Signature | What it does |
| --- | --- | --- |
| `GetRecentWindows` | `() -> a(sss)` | The last 8 focused windows as `(app id, app name, title)`, most recently focused first. Read-only. |
| `GetWindowAt` | `(x: i, y: i) -> a(sssiiii)` | The top window under a point, with its frame geometry `(x, y, width, height)`, for an explicit character drag. Returns an empty list when no window is there. Read-only. |
| `ActivateByPid` | `(pid: u) -> b` | **v2.** Brings to the front the most recently focused window whose own process id is `pid`, and answers whether one existed. |
| `Register` | `(token: s) -> b` | **v4.** Binds Koda's per-launch token (at least 32 characters) to the calling D-Bus connection. First caller wins; while a live owner holds the binding every other `Register` answers `false`. |
| `PickWindow` | `(token: s) -> (t, s, s, s)` | **v4.** An opaque id, app id, app name and title of the window Koda may look at. Refused with `org.abito.Context.NotAllowed` unless `token` is the registered one. |
| `CaptureWindow` | `(id: t, token: s) -> s` | **v4.** Paints that one window into a private PNG (`$XDG_RUNTIME_DIR/koda-capture`, 0600) and answers its path. Same refusal as `PickWindow`. |

### `Register`, `PickWindow`, `CaptureWindow` (v4)

Koda keeps **one** session-bus connection for the whole life of the island, registers its token on it once when the
capture endpoint starts, and uses it for every pick and capture. The extension releases the binding when that
connection leaves the bus (one bus name watch per live owner, removed on release), so while nobody is bound
`PickWindow` and `CaptureWindow` refuse everything. A program that registers before Koda holds the binding until it
leaves: Koda then captures nothing and tells you another program holds its GNOME extension (restart the session or
Koda). The refusal-by-token is the only gate: no process name or command line is ever consulted.
`GetRecentWindows`, `GetWindowAt` and `ActivateByPid` are not gated.

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
- It exposes no window ids, pids or window content; `GetRecentWindows` and `GetWindowAt` return app id, app name and
  title (and frame geometry for the window under a point).
- Everything but `ActivateByPid` is read-only.
- `GetWindowAt` skips windows of Koda itself and windows without a name. `GetRecentWindows` and `ActivateByPid` skip
  only windows the Shell hides from the taskbar.

## When Koda asks

- **Automatic chat context is opt-in.** Koda calls `GetRecentWindows` only while «Contexto de la ventana activa» is on.
- `GetWindowAt` is called on demand for an explicit window drag and for per-app dictation styles.
- `ActivateByPid` is called when you click an agent session in the island to raise its terminal.

## Verification

`apps/desktop-tauri/src/sessionterm_tests.rs` checks that the extension source keeps this contract (the method
exists, matches only by the window's own pid, has no code or process execution) and that this page names
`ActivateByPid`. `test-node/context-extension-gate-check.cjs` runs the real `extension.js` and `token.js` against fakes
of the Shell and the bus: nothing is picked or captured while nobody is bound or with a wrong token, a second
`Register` is refused while a live owner holds the binding, the binding and its watch go when the owner's bus name
vanishes. `src/windowcapture/gnome_tests.rs` and `tests/windowcapture_gnome.rs` check the Rust side.
