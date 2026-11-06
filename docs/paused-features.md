# Paused features (this version: Chat and Agentes)

Human, 26-oct: «añadir todo el resto de funciones que tenemos como no disponibles y en pausa, excepto el chat y los agentes que es
lo que iremos tocando en esta version y el resto lo trabajaremos en otras versiones mas a futuro», with the chosen option
«Visibles en gris y apagadas».

**Superseded for 0.1.2.** Human: «vale todo lo que este en pausa se puede ocultar?» → yes. Paused features are now **hidden**
instead of greyed: they are not in the Ajustes menu or the island. What happens inside is unchanged (nothing starts, stored
preferences are untouched). A deep link to a paused page (`hub-page`, `abito:hub-select`, the window's initial page) lands on
General, never on a blank page.

| Feature | Ajustes | Island | Inside |
| --- | --- | --- | --- |
| Dictado + Flow pages (Estadísticas, Diccionario, Fragmentos, Estilos, Ajustes de dictado) | hidden | no dictation pill | engine and `CTRL+ALT+v` portal key never start |
| Voice wake word («Koda») | hidden | — | microphone listener never starts |
| Integraciones (GitHub, n8n, Vercel, Stripe, Resend, Notion, Cal.com) | hidden | no rows, no cards | no poller threads, no network |
| Spotify | (a service pill) | no card | `spotify_action` answers `paused` |
| Teléfono Android | hidden | — | the link server never ran in production |

Active: Chat, Agentes (sessions, Sileo questions/permissions/notices, plan usage), General, Atajos, Privacidad.

## Removed in 0.2 (not paused): Recap and Notetaker

The weekly **Recap** and the **Notetaker** placeholder page were removed in Koda 0.2 — they are gone, not paused:
there is no `recap` agent id and no `notes` hub page. What remains is legacy cleanup only:

- At every daemon start, `AgentsManager.removeLegacyRecap()` (`apps/desktop-daemon/src/agents.cjs`) runs the
  REMOVAL-ONLY installer profile `install recap --user --remove` (`apps/desktop-harness/src/install-recap.cjs`;
  install is a usage error) to take the Koda 0.1 recap hooks (`UserPromptSubmit`, `PostToolUse`, `Stop` entries
  calling the deleted `bin/abito-recap-hook.cjs`) out of `~/.claude/settings.json`: dated backup first, marker-only
  removal, fixed log lines; a refusal writes nothing and is retried next start. TODO: remove one version after K2-03.
- At island start (`apps/desktop-tauri/src/legacy_recap.rs`), Koda deletes ONLY `<app_local_data_dir>/recap.json`,
  its `recap.json.corrupt-*` copies in that same dir and `<runtime>/recap-events.jsonl` — always as regular files,
  never a symlink target, never a directory, never recursive. «Koda weekly recap» PNG images the user saved are
  NOT deleted.
- The island logs exactly one content-free stderr line, `island: settled notice accepted`, per accepted settled
  notice; the installer smokes (Linux/macOS/Windows) wait for that line instead of `recap.json`.

**Stored preferences are never rewritten.** A paused feature with its preference «on» simply does not start.

## Turning a feature back on (next version)

Remove it from the three lists — they are pinned against each other by `test-node/paused-features-check.cjs`:

1. `apps/desktop-tauri/src/paused.rs` → `paused()`
2. `apps/desktop-tauri/frontend/paused.js` → `PAUSED`
3. `apps/desktop-tauri/frontend/vendor/coucou/hub/shell.ts` → `ACTIVE_PAGES` (then `node scripts/build-coucou.cjs --hub-only`)

The previous behaviour of each island module stays tested through its `wantedIgnoringPause` export.
