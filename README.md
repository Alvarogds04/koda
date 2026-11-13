# Koda

Koda is a small desktop island for your coding agents. Folded, it is just the circle: click it to open, drag it to move
it anywhere (it remembers the spot). Opened, it shows what **Claude Code**, **Codex**
and **Pi** are doing, and lets you answer their questions and permission requests without switching to the terminal.

> **Status:** first release (0.1). This version works on **Chat** and **Agentes**; dictation, voice wake word, integrations,
> Spotify and the phone link are paused and hidden (see [docs/paused-features.md](docs/paused-features.md)).
> Koda was previously published as **Abito** ([Alvarogds04/abito](https://github.com/Alvarogds04/abito), archived). Koda 0.1.0
> continues Abito 0.3; the version number restarted with the new name.

## Download

Get the latest build from **[Releases](https://github.com/Alvarogds04/koda/releases)**:

| Platform | File | Notes |
| --- | --- | --- |
| Linux x86_64 | `koda-linux-x64.tar.gz` | `tar -xzf koda-linux-x64.tar.gz && sh koda-linux-x64/install.sh koda-linux-x64/abito-island --project-root ~/your-project`, then open **Koda** from the applications menu |
| macOS (Apple Silicon) | `Koda-macos-arm64.dmg` / `.zip` | **not notarized**: open it once, then *System Settings → Privacy & Security → Open Anyway*. Step-by-step guide (Spanish): [docs/mac-guide.es.md](docs/mac-guide.es.md) |
| Windows x64 | `koda-windows-x64-setup.exe` | **unsigned**: SmartScreen → *More info* → *Run anyway* |

The macOS build is ad-hoc signed but not notarized; the Windows build is not signed. They are meant for testing.

**Nothing else to install.** Every installer carries Koda's own Node.js (22, pinned) and Pi (1.4.0, pinned), so the island,
chat and agent hooks work on a machine with neither. Koda always uses its own copies and never changes a Node or Pi you already
have, and it launches Pi offline: no version check, no model-catalog refresh and no telemetry to pi.dev. Their licences ship
next to them in `runtime/THIRD-PARTY-NOTICES.md`. If that bundled runtime is damaged, Koda says «La instalación de Koda está
dañada: volvé a instalar Koda.» instead of falling back to another Node or Pi.

**Upgrading from Abito:** install Koda over it; settings, accounts and agent hooks are kept (internal names are unchanged).
Restart any open Pi session afterwards so it loads the updated extension.

**Upgrading from Koda 0.1 with Recap:** Recap was removed in 0.2. At start Koda takes the old Recap hooks out of
`~/.claude/settings.json` (backup first) and deletes only Recap's own data files; your other hooks and data, and any
recap images you saved, are untouched.

## Windows limitations

Hooks (Claude Code, Codex, Copilot CLI, OpenCode, status-line relay) and the Pi extension can be installed from *Ajustes · Agentes* on Windows. Koda only writes a configuration file or folder that is private to your Windows user (owner = you, no write access for other accounts, no links or junctions), keeps a backup, writes atomically and records a private audit entry. If any check fails, nothing is written and Ajustes says why. Installed files are verified against an install manifest; if you modify the installation, reinstall Koda.

Known limit: a program running as the same Windows user can still race the folder check, and could replace Koda's own files together with their manifest; both are planned fixes and give that program nothing it could not already do by editing your configuration directly.

## Connect your agents

- **Claude Code / Codex:** Koda installs their hooks from *Ajustes → Agentes*.
- **Pi:** install the extension from *Ajustes → Agentes*, or load it by hand with `pi -e apps/desktop-pi/pi-extension.ts`.
  Pi's questions and yes/no confirmations then also appear in the island (credential, token and consent prompts stay in the
  terminal).

Each agent row in *Ajustes → Agentes* works on its own: Claude Code and Codex hooks do not need Pi.

## Repository

| Folder | What it is |
| --- | --- |
| `apps/desktop-tauri` | the island (Tauri 2 + Rust, plain JS frontend) |
| `apps/desktop-daemon` | local daemon for chat, accounts and agent sessions (Node) |
| `apps/desktop-harness` | Claude Code / Codex hook handlers (Node) |
| `apps/desktop-pi` | Pi extension |
| `apps/desktop-sound` | sound engine |
| `assets/koda` | Koda's 42 animations as transparent 512×512 GIF and animated WebP (stickers, wallpapers, avatars): [gallery](assets/koda/README.md) |

Internal names (the `abito-island` binary, `~/.abito-island` data folder, `ABITO_*` variables, the protocol) still carry the
old name; renaming them is planned separately so existing installs keep working.

Build on Linux: `cd apps/desktop-tauri && node packaging/runtime/build-runtime.cjs --target linux-x64 --out /tmp/koda-runtime --archive /tmp/koda-runtime-linux-x64.tar.gz && node packaging/build.cjs --out dist --runtime-archive /tmp/koda-runtime-linux-x64.tar.gz` (the first command downloads the pinned Node and Pi and checks their hashes). Tests: `../../run-node-checks.sh` (Node) and
`cargo test --offline`.

## License

MIT — see [LICENSE](LICENSE). Parts of the frontend are adapted from Coucou (MIT).
