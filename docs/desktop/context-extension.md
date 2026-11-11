# Koda window context: the GNOME Shell extension

Source: `apps/desktop-tauri/gnome-extension/abito-context@abito/` (`extension.js`, `metadata.json`).
Extension version **2**; GNOME Shell 45 to 50. A changed contract is a new extension version.

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
exists, matches only by the window's own pid, has no code or process execution), that this page names
`ActivateByPid`, and that `metadata.json` carries version 2.
