# Ask Koda about my window (K2-06)

When you ask Koda in the chat about the window you are using («¿qué dice este error?», «resumime esta página»),
Koda can take **one picture of that window** and show it to the model that answers, if the model can see images.
It is a tool of the agent (`screenshot_my_window`, seen by the agent as `mcp__computer__screenshot_my_window`), not
something Koda does in the background. Nothing is captured unless you ask, the option is on, and you allowed it.

Status: merged in `release/0.2` (K2-06). Design source and decisions: «igual a Gentle Dot» (its `computer`
feature, MIT). What was and was not verified is at the end.

## The pieces

```text
chat → engine (Gentle Shell, run by the daemon) ──MCP over loopback + bearer──▶ Koda host (Rust, this app)
        │                                                                          │ rules, consent, capture
        └ extension koda-window-capture.js (prunes old images, blocks without vision)
```

1. **Host: a loopback MCP server** (`apps/desktop-tauri/src/windowcapture/`, `server.rs`, `mcp.rs`). It listens on
   `127.0.0.1` on an ephemeral port, accepts only `POST /mcp` from a loopback peer with the launch's bearer token
   (32 random bytes, compared in constant time, kept in memory only), bodies up to 64 KiB, a 5 s read deadline. It has
   exactly one tool, `screenshot_my_window`.
2. **Daemon projection.** The app starts the daemon with `KODA_WINDOW_MCP_URL` and `KODA_WINDOW_MCP_TOKEN`
   in its environment. The daemon writes them into the engine's private `<island>/agent/mcp.json` (mode `0600`) as
   the server `computer`, and nothing else is reachable that way (`apps/desktop-daemon/README.md`, «Optional MCP»).
3. **Engine extension** `<island>/agent/extensions/koda-window-capture.js` (installed by the daemon, a copy of Gentle
   Dot's `screenshot-context`, MIT): of all screenshots in a long conversation only the **last** travels as an image
   (earlier ones become a one-line note), and when the model has no image input the tool is **blocked before any
   capture** with: «Your current model cannot see images. Choose a model with image input (vision) in Koda's model
   settings and ask again.»

## The rules and where each one is enforced

All of them are enforced in the Rust host (`mcp.rs`), in this order, before a pixel is read:

| Rule | What it does | Where |
| --- | --- | --- |
| **S3 off switch** | Ajustes → Chat → «Dejar que Koda vea mi ventana». **Off by default.** Read at every call. Off: nothing is asked, nothing is captured, and the tool answers that it is turned off in the settings. | pref `window_capture` (`prefs.rs`), `mcp.rs` `screenshot()` |
| **S6 consent session** | The first capture asks «Allow Koda to see your window for 30 minutes?». Allow starts a 30-minute session (`SESSION_MS`); during it no new question; after it, it asks again. Deny by default, and any failure to show the dialog is a denial (fail closed). Two simultaneous calls ask once. | `session.rs`, `host.rs`, `alert.rs`, `consent_gtk.rs` |
| **S5 refusal list** | The window chosen is checked **before** it is captured, against Gentle Dot's list for the platform, and refused if it matches. Koda's own windows are never chosen (they are skipped when picking, and are on the list too). | `blocklist.rs` |
| **No vision** | See above: blocked in the engine extension, before any capture. | `koda-window-capture.js` (`window-capture.cjs`) |

The S5 list (matching by app id or name, helper-prefixed ids and `.exe/.app/.desktop` stems included):

- **macOS:** System Settings, SecurityAgent, loginwindow, UserNotificationCenter, LocalAuthentication,
  CoreServicesUIAgent, Keychain Access, Passwords, 1Password, Bitwarden, Dashlane, LastPass.
- **Windows:** Settings, Control Panel, Windows Security, User Account Control, CredentialUIBroker, LogonUI, LockApp,
  Credential Manager, 1Password, Bitwarden, Dashlane, LastPass, KeePass, KeePassXC, and **any app Windows cannot
  identify**.
- **Linux:** Settings, authorization dialogs (polkit agents, `gcr-prompter`, keyring prompts), the lock screen,
  «Passwords and Keys» (seahorse, KWallet), 1Password, Bitwarden, Dashlane, LastPass, KeePass, KeePassXC.

Consent dialog per system: **macOS** an `NSAlert` (no deadline: the capture waits for your answer), **Windows** a
`TaskDialog` (120 s), **Linux** a GTK dialog with Deny as the default button (120 s, it closes itself as Deny).

What the agent is told when something is missing (the strings the tool returns, in English; the agent answers you in
your language): not allowed → «The user did not allow Koda to look at their window. Nothing was captured.»; switch off
→ «Looking at the user's window is turned off in Koda's settings. Nothing was captured. Tell the user they can turn it
on in Ajustes → Chat → «Dejar que Koda vea mi ventana».»; no other window → «Koda found no other window to look at.
Ask the user to bring the window they mean to the front and try again.»; refused app → «Koda does not look at …: it
can show passwords or system prompts. Nothing was captured.»; no screen permission → «Koda does not have the screen
recording permission, so it cannot see the window. … Then ask again.» (on macOS it names System Settings → Privacy &
Security → Screen Recording and says macOS asks again after every Koda update).

## Which window

The **topmost window that is not Koda's** (the window you were looking at when you switched to the chat). There is no
focus history on macOS or Windows; on GNOME the extension returns the most recently focused one.

## Per operating system

- **Linux, GNOME on Wayland:** through Koda's own GNOME extension (`gnome-extension/abito-context@abito`, v4):
  `PickWindow` and `CaptureWindow` over the session bus, gated by Koda's launch token. See
  [context-extension.md](context-extension.md), including its **Known limits**. The extension is yours to
  install (`install.sh`) and enable.
- **Linux, X11:** `x11rb` (with the composite extension), no extension needed. Used when the session is really X11.
- **Linux, anything else** (Wayland without the extension): **no capture.** The system screenshot portal is
  deliberately **not used**: it gives no app identity, so the refusal list could not be applied. Koda says so: «Koda
  cannot tell which app a window belongs to without its GNOME extension, so it will not capture it. Turn on Koda's
  GNOME extension (log out and in once) or use an X11 session.»
- **macOS:** ScreenCaptureKit by window id, **macOS 14 (Sonoma) or later**. It needs the **Screen Recording**
  permission; macOS asks again after an update of Koda, and Koda tells you what to do. No paid signing is involved.
- **Windows:** `PrintWindow` with the full-content flag; a black frame falls back to a screen copy (`BitBlt`) of the
  window's frame; a hung window is never asked to paint (screen copy instead); `GdiFlush` before reading the bitmap.
  A window Windows cannot identify is refused.

## What is NOT verified live

Verified in tests and CI (logic, protocol, the fake extension on a private bus, X11 on a private Xvfb, compile on all
three systems): the rules above, the loopback server, the consent session, the refusal list, the projection and the
extension's pruning and no-vision guard.

**Not run live by the authors, and waiting for a human test** (`odd/evidence/k2-06/TEST-HUMANO.md`): the real GNOME
Shell extension in a live session, macOS (ScreenCaptureKit, the permission, the `NSAlert`), Windows (`PrintWindow`, the
`TaskDialog`, black-frame detection), the GTK dialog on screen, and the whole flow with a **vision model** answering
about the picture.

## 0.3 debt

The GNOME extension's remaining hardening (a gate that can be empty after a late extension or a Shell restart; the
token travelling in clear on the session bus and the capture methods checking only the token; three methods that are
not gated; a reconnect that can wrongly say «otro programa») is not done in 0.2. It is listed, with what each means,
in [context-extension.md](context-extension.md#known-limits-03-debt).
