# Managed Pi extension installation

Linux/macOS Settings → Agents → Pi uses the same app-owned adapter, preview/hash, human click, per-target lock and audit as the other installers. Pi and the chat daemon need not be running. Restart Pi after installing, updating or removing the extension.

The only target is `~/.pi/agent/extensions/koda-island/`. `--settings`, `--timeout-sec` and interactive `--apply` are not supported for Pi. The row always warns that a different `PI_CODING_AGENT_DIR` is not covered; installing the default is not evidence that a custom-dir session loads it.

```text
koda-hook install pi --user [--remove] --json
koda-hook install pi --user [--remove] --json --apply-plan <shown-hash> --audit-dir <private-audit-dir>
```

Apply remains restricted to the app-owned adapter context; these are protocol examples, not a terminal bypass. Windows returns `unsupported_platform` before reads or writes. The old terminal installer shares Windows filesystem limitations and is not a workaround.

## Ownership and replacement

The shipped `desktop-pi/pi-extension.ts` becomes `index.ts`, with `adapter.cjs`, `config.cjs`, `native-ask.cjs`, `questions.cjs`, `security.cjs` and `windows-transport.cjs` — seven files, no ask tool of its own (K3-04: every question uses Pi's generic mechanism). Pi supplies its own API modules; there are no npm downloads. Linux receipts, macOS resources and Windows staging include this closed payload (shipping it does not enable Windows installation).

`.abito-manifest.json` has schema `abito-pi-extension/1` and an exact filename→SHA-256 map. A foreign directory, unknown entry, modified owned file, symlink, hard-linked file, unsafe owner/mode or missing payload refuses. Preview writes nothing. The shown hash binds current manifest/content and bundled replacement bytes; apply recomputes it under the shared lock.

Exactly two closed listings are accepted. The previous release's payload had one more file (`ask-tool.cjs`, removed in K3-04), so a folder with those eight files and a manifest listing those eight is still a verified Koda install, not a foreign one: at the old name (`abito-island`) it is retired into the backup flow, at the current name (`koda-island`) it is upgraded in place, and `--remove` takes it out. Every hash is checked against that folder's own manifest exactly as for the current seven, and the folder's entries and its manifest must describe the same listing: eight files with a seven-entry manifest, a changed byte, or any extra entry is still refused.

Missing default parent directories are created privately only during confirmed apply. Backups, staging and quarantine live only in the private fixed `~/.pi/agent/abito-backups/` directory, outside Pi's auto-discovered `extensions/`. The plan binds this root, and differing filesystem devices refuse instead of copying. A complete private directory is staged and verified there before rename. An existing owned directory is backed up before replacement; removal moves only a verified owned directory to its backup. An older unchanged owned payload can be upgraded. A failed replacement restores the saved directory when possible; an un-restorable result is explicitly `restore_failed` and retains the backup. After success, only older unchanged manifest-identified Abito backups are pruned; the latest backup is kept. Unknown or user-modified entries and quarantined evidence are preserved. Post-publication verification failure quarantines the new bytes outside discovery and restores the prior directory. No recursive deletion of arbitrary files is used; unrelated extensions are preserved. Pi's `rollback` field is null because the shared file-oriented shell commands do not apply to directories.

These checks protect ownership and shown-plan consistency, not against another malicious process with the same uid. A crash between backup and publication can leave the backup/stage for manual recovery. No live Pi reload is attempted, and no Windows runtime installation is claimed.

## Evidence

`test/install-pi.test.cjs` runs the public CLI in private packaged-layout fixtures. With `PI_CODING_AGENT_ROOT` set to an installed Pi package, it also loads the installed `index.ts` through Pi's real extension loader without starting a session or contacting a model/provider. This proves relocated module loading, not an interactive session or native UI click.
