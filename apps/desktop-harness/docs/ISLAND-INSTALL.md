# Island install mode (`--json` / `--apply-plan`)

The island (Tauri lane) installs and removes the Abito hooks of Claude Code and Codex, the weekly-recap hooks and the Claude status-line relay **without a terminal**. The human's confirmation is the **trusted click** on the diff the island shows. The TTY installers (`install <harness> --apply`, typed word) are unchanged and independent.

Two calls, both direct children of Abito's Node adapter (or compatibility daemon), on Linux/macOS:

```
1. node bin/abito-hook.cjs install <claude|codex|recap|statusline> --user [--remove] --json
2. node bin/abito-hook.cjs install <claude|codex|recap|statusline> --user [same args] --apply-plan <plan_hash> --audit-dir <abs dir> --json
```

`--timeout-sec N` is optional for Claude/Codex only (never recap/statusline).
`--settings <abs path>` may replace `--user` (tests, non-default locations). Order of flags is free. `--timeout-sec` and `--remove` are mutually exclusive, as in the TTY installer.

**Guarantee: exactly what was shown is applied.** `plan_hash` binds the target, the original bytes (sha256 + size), the exact bytes that would be written, the timeout, the node path, the hook script path and `INSTALLER_VERSION`. The apply step recomputes the plan from scratch and refuses (exit 70, `plan_changed`) on any difference.

Pi uses this same guarded JSON protocol with a directory payload rather than a settings-file patch; see [Managed Pi installation](PI-INSTALL.md). It accepts only `pi --user [--remove] --json` with the optional shown-plan/audit pair. No custom target or timeout is accepted. Restart Pi after a change.

## Output rules

**stdout is authoritative.** The island parses the JSON line on stdout, not the exit code alone. In JSON mode the CLI ignores a broken stdout pipe (EPIPE) and installs crash handlers: a stray crash after the verdict is known exits silently with the code that matches the JSON that was (or would have been) printed (0 for success); a crash before any verdict prints the single fixed line `{"schema":"abito-hook-install/1","ok":false,"code":"internal","message":"internal error"}` (best effort) and exits 70. No stack trace ever reaches stderr.

In JSON mode stdout is **exactly one JSON line** (terminated by `\n`), stderr is **empty**, for success and for every refusal. Refusals never contain file content or paths found in the file.

### Preview (`--json`) — writes nothing, any caller, no TTY

```json
{"schema":"abito-hook-install/1","ok":true,"mode":"preview","harness":"claude","action":"install",
 "target":"/abs/settings.json","exists":true,"changed":true,
 "entries":[{"event":"PermissionRequest","op":"add"},{"event":"Stop","op":"add"}],
 "backup_path":"/abs/settings.json.abito-backup-<UTC>",
 "diff":{"lines":["@@ -1 +1 @@","+ ..."],"hidden":0,"outside_hooks_changed_lines":0},
 "requires_trust_review":false,"plan_hash":"<64 lowercase hex>","notes":["..."]}
```

| field | type / bounds |
|---|---|
| `schema` | always `"abito-hook-install/1"` |
| `ok` | `true` |
| `mode` | `"preview"` |
| `harness` | `"claude"`, `"codex"`, `"recap"` or `"statusline"` |
| `action` | `"install"` or `"remove"` |
| `target` | absolute normalized settings path |
| `exists` | bool: the target file exists |
| `changed` | bool: the plan would modify (or create) the file; `false` = nothing to do |
| `entries` | Claude/Codex: `PermissionRequest`, `Stop`; recap: `UserPromptSubmit`, `PostToolUse`, `Stop`; statusline: exactly `statusLine`. Ordered; `op` in `add`, `replace`, `remove`, `keep` (`keep` includes removal when no marker exists) |
| `backup_path` | string or `null` (`null` when nothing changes or the file is new). The timestamp is **planned**; the one used at apply is the apply-time UTC time |
| `diff.lines` | at most **200** strings, each at most **300** characters, control characters (C0, DEL, C1, U+2028/2029) replaced by `?`; `[]` when unchanged. First line is a `@@` header, then context (` `), `-` and `+` lines |
| `diff.hidden` | integer >= 0: diff lines not shown. **`diff.hidden > 0` (or any line altered by sanitizing: control characters replaced by `?`, lines cut at 300 characters) means the preview is NOT fully human-reviewable: the island must warn and disable the 1-click apply in that case.** |
| `diff.outside_hooks_changed_lines` | integer, always `0` by construction (computed, not assumed) |
| `requires_trust_review` | `true` for `codex` + `install`, otherwise `false` |
| `plan_hash` | 64 lowercase hex |
| `notes` | fixed strings (no file content) |

Timestamps are **excluded** from `plan_hash` (the backup name is chosen at apply time). `--remove` also deletes a matcher group that our removal left empty, so a user `matcher` key on such a group is lost with it. `plan_hash` = sha256 (hex) of the canonical JSON (keys sorted, no whitespace) of `{schema, harness, action, target, original:{exists, sha256, size}, result_sha256, timeoutSec, execPath, binPath, installerVersion}`. `result_sha256` is the sha256 of the exact bytes to be written, or `""` when `changed` is `false`. A non-existent original is `{exists:false, sha256:"", size:0}`. Deterministic: identical state gives identical hashes. `INSTALLER_VERSION` is a constant in `src/install-ui.cjs` (`abito-hook-installer/1`).

### Apply (`--apply-plan <hash> --audit-dir <abs dir> --json`)

Requires `--json` and `--audit-dir`; mutually exclusive with `--apply`; `--audit-dir` without `--apply-plan` is also a usage error. The hash must be 64 lowercase hex (else exit 64).

```json
{"schema":"abito-hook-install/1","ok":true,"mode":"applied","harness":"codex","action":"install",
 "target":"/abs/hooks.json","plan_hash":"<hex>","changed":true,
 "backup":"/abs/hooks.json.abito-backup-<UTC>",
 "rollback":"cp -p '/abs/hooks.json.abito-backup-<UTC>' '/abs/hooks.json'",
 "entries":[{"event":"PermissionRequest","op":"add"},{"event":"Stop","op":"add"}],
 "requires_trust_review":true}
```

- `backup`: absolute path (mode 0600, byte-identical to the original) or `null` (new file, or nothing changed).
- `rollback`: `cp -p '<backup>' '<target>'` (single-quote escaped), or `rm -- '<target>'` for a file that did not exist, or `null` when `changed` is `false`.
- `changed:false` (idempotent re-apply): ok, no write, no backup. It is still audited.
- `"audit":"result_not_recorded"` is added when the result line could not be appended (the apply is NOT undone).

### Refusal

`{"schema":"abito-hook-install/1","ok":false,"code":"<code>","message":"<fixed text>"}`

| exit | code | meaning |
|---|---|---|
| 0 | | ok |
| 64 | `usage` | bad or conflicting arguments, malformed hash, `--apply` with `--json`, `--apply-plan` without `--json`/`--audit-dir`, `HOME` problems for `--user` |
| 65 | `refused` | input/settings file refused (symlink, not a regular file, not owned, not strict JSON, not valid UTF-8, too large, duplicate keys in `hooks`, lossy number, directory missing, ...) |
| 70 | `plan_changed` | recomputed plan differs from the hash (file, args, harness or paths changed; also the loser of a concurrent apply) |
| 65 | `not_writable` | the settings directory refuses creating the lock (EACCES/EPERM); nothing was written |
| 70 | `busy` | another apply held the per-target lock for 10 s (or a fresh planted file/symlink sits at the lock path) |
| 70 | `verification_failed` / `restore_failed` / `apply_failed` | write or post-write verification failed; the previous file was restored (`restore_failed`: could not, the backup is intact) |
| 70 | `internal` | unexpected failure; nothing was written |
| 73 | `audit_unavailable` | audit trail could not be opened/appended; **nothing was written to the settings file** |
| 77 | `not_island` | island guards failed; nothing was read or written |
| 77 | `unsupported_platform` | automatic installation is unavailable on this platform (anything but Linux, macOS and Windows); no target/audit/lock/backup reads or writes |
| 65 | `unsafe_target` | Windows only: the settings file or its folder is not private to the current user (owner / DACL), goes through a link or junction, or is otherwise unsafe; nothing was written |
| 65 | `install_unverified` | Windows only: the installed native helper or a bundled script does not match the install manifest (`abito-install.json`); nothing was read or written |

## Apply sequence (what the CLI does, in order)

1. **Island guards** (exit 77 before anything else is read or written):
   (i) `ABITO_ISLAND_EXE` is set to an absolute path and `realpath(/proc/<ppid>/exe) == realpath(ABITO_ISLAND_EXE)` on Linux (unchanged). On macOS, fixed `/bin/ps -ww -o uid= -o comm= -p <ppid>` must return the current uid and canonical Node executable; failures refuse; timeout 2 s, output bound 8 KiB, no shell;
   (ii) none of `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CODEX_SANDBOX`, `CODEX_SANDBOX_NETWORK_DISABLED`, `CODEX_THREAD_ID`, `CODEX_SESSION_ID`, `PI_SESSION_ID`, `PI_SESSION_FILE`, `OPENCODE`, `OPENCODE_*`, `AI_AGENT`, `GENTLE_PI_SESSION` is present and non-empty. Names are compared **case-insensitively** (`claudecode`, `OpenCode_x` count); an empty or unset value is ignored, any non-empty value counts.
2. Recompute the plan from scratch and compare hashes in constant time (`plan_changed` otherwise). A per-target lock (`.<name>.abito-lock` directory next to the target holding an `owner` file with a random token; released only while the token still matches; stale after 30 s) serializes concurrent applies. A regular file or symlink found at the lock path (lstat, never followed) is unlinked when older than 30 s and means `busy` while younger; then the plan is recomputed once more under the lock.
3. **Audit first, fail closed**: `--audit-dir` must be absolute and normalized; it is created `0700` if missing (its parent must exist); symlinks, foreign owners and group/world-writable directories are refused; `hook-installs.jsonl` is opened `O_APPEND|O_CREAT|O_NOFOLLOW` mode `0600` (must be a regular, single-link, owner-only file) and the `intent` line is appended. Past 1 MiB the file is first rotated to `hook-installs.jsonl.1` (replaced, `0600`; best effort). Any failure on the intent line: exit 73, settings untouched.
4. Apply with the shared installer core: `0600` `O_EXCL` backup (island path: if the usual name is taken, the apply uses `-1`..`-9` suffixes, bounded; the TTY installer keeps its name), atomic temp+rename write, change check (size+mtime+sha256), strict UTF-8, textual patch of the top-level `hooks` member only, post-write verification, honest restore. No TTY, no prompt.
5. Append the `result` line (best effort).
6. Print the single JSON result.

## Audit file format

`<audit-dir>/hook-installs.jsonl`, one JSON object per line, **metadata only** (no file content, no hook commands, no secrets):

```
{"ts":1790000000000,"event":"intent","harness":"claude","action":"install","target":"/abs/settings.json","plan_hash":"<hex>"}
{"ts":1790000000123,"event":"result","plan_hash":"<hex>","ok":true,"code":"applied","backup":"/abs/..abito-backup-..."}
```

Refusals that happen after argument validation (`not_island`, `plan_changed`, `busy`, `not_writable`, ...) additionally append, best effort and only when the audit dir already exists and is valid (it is never created for a refusal), a line that never blocks and never changes the exit code:

```
{"ts":1790000000456,"event":"refused","code":"not_island","plan_hash":"<given hash or null>"}
```

`ts` is epoch milliseconds. Result `code`: `applied`, `noop`, or one of the 70 codes above.

## What the Tauri lane must do

1. Set `ABITO_ISLAND_EXE` to the canonical Node executable of the app-owned adapter that directly spawns the installer.
2. Scrub every agent marker listed above from the child environment (guard (ii) refuses otherwise).
3. The app-owned Node adapter spawns `node bin/abito-hook.cjs install ...` directly (no shell); `ppid` identifies that adapter's Node executable.
4. Run the preview, render `diff.lines` (and `notes`, `requires_trust_review`) to the human, and let the **click** be the confirmation. Store the `plan_hash` the human saw and pass exactly that hash and the same args to the apply.
5. Pass `--audit-dir` (an island-owned `0700` directory) and treat exit 73 as "not installed".
6. On `requires_trust_review: true` (Codex), tell the human to review/trust the hooks in `/hooks`; until then they are inactive. The installer never touches `~/.codex/config.toml`.
7. Handle `plan_changed` by re-previewing and asking again.

## Notify-only Claude integrations

`recap` uses the shared hook planner with its own three-event profile and the sibling
`bin/abito-recap-hook.cjs`. It only counts activity for the weekly recap: no command
text, path or prompt is kept. It never answers a permission request.

`statusline` uses `install-statusline.cjs` and the sibling `bin/abito-statusline.cjs`.
Only the top-level `statusLine` member is patched (not `hooks`). A user's existing
status line is saved in `~/.abito/statusline-previous.json` (0600); the relay runs it
and prints its output. Marker-only removal restores that saved value, or drops only
our statusLine when no saved value exists. Preview writes neither this file nor the
audit/backup. Apply uses the same guards, hash re-check under the target lock,
audit-before-write, dated backup and verification as the other installers. The saved
line and cleanup behavior are the interactive installer's existing behavior; no new
configuration locations are written. The removal hash binds the restored bytes too.
Interactive `--apply` still requires a TTY and the typed word.

## Honest limits

- Any process of the same uid can already edit `~/.claude/settings.json` by hand, or run this CLI. The guarantee is **"exactly what was shown is applied"** (plan binding plus audit trail), not authentication of the caller.
- The real human confirmation is the trusted click in the island. Guards (i) and (ii) are **defence in depth**, not a security boundary: the marker list is best-effort, and a same-uid process can spawn the island executable's name or edit the environment of its own children.
- Automatic installation is enabled on Linux (`/proc`), macOS (own-uid executable probe) and Windows (HU-047).
- Windows: Node cannot read or set an ACL, so every trust-sensitive fact and write goes through the installed native helper `abito-private-session.exe` (`--check-path`, `--make-dir`, `--write-private <path> --expect none|<sha256>`, `--move`, `--delete`; fixed argv, drive-letter absolute paths only, no UNC or `\\?\` paths). The helper is the installed sibling next to `abito-install.json`, never PATH or cwd, and its sha256 must match that manifest before Node runs it; every bundled script Abito registers (hook, Pi extension files) must match the manifest too. The helper verifies the parent chain (owner = current SID, or BUILTIN\Administrators only for an elevated token; no foreign write ACE; no reparse point on any component), creates the temp file with a protected private DACL at creation, replaces atomically (`MoveFileExW`), and re-verifies the result. The audit file, the apply lock, the status-line side file and the Pi stage/backups all use it. Pi publication across volumes is refused, never copied. Any failed check writes nothing and Ajustes shows the reason (`unsafe_target`, `install_unverified`).
- The helper has ONE resolver (`win-fs.cjs resolveHelper`, shared by the installer, the island parent check and the daemon session publisher): the installed sibling only, never PATH, cwd or a development build, re-hashed against the manifest immediately before every spawn.
- Known residuals on Windows (documented, fix planned; all need code running as the same user, which can already edit these files directly): (M3) the parent-folder check and the following path-based write/move/delete are not one atomic step, so a same-user program can still race the folder between them; the fix is to hold a directory handle through the operation. (M2 residual) Node cannot deny writes to the helper between the final re-hash and the process start. (L2) a refused install can leave an empty folder it created. (L3) two simultaneous applies can both take over a stale lock; the compare-and-swap on every write limits this to lost serialization. (L4) a timed-out installer's child is not tree-killed. (L5) the install folder is user-writable and the manifest is unsigned, so same-user code can replace helper, manifest and scripts together; only the entry script and files read through `readVerified` are hash-checked, not the whole `require` closure.
- Distinct Windows failure codes: `plan_changed` (the file changed under the plan), `apply_failed` (busy or I/O), `unsafe_target`, `install_unverified`.
- The Windows rollback command is not printed (the backup path is reported instead).
- Windows read-only `abito-private-session --parent-check <pid>` and `--check-target <agent-id>` remain the island-guard probes.
- The audit log is append-only by convention (`O_APPEND`), not tamper-proof against the same uid.
- The backup path in the preview is planned; the actual timestamp differs.
- A crash mid-apply can leave orphan `.<name>.abito-tmp-*` files next to the target (and a stale lock for up to 30 s); they are harmless and can be deleted by hand.

## For the daemon (agent_connect)

The daemon (not the island UI directly) may drive this CLI for `agent_connect` / `agent_disconnect`:

- It runs the CLI as a **subprocess** with an **absolute, validated node path and script path** (no shell, no PATH lookup).
- It sets `ABITO_ISLAND_EXE` to **the daemon's own node executable**, so guard (i) becomes "the parent is the daemon's node".
- It scrubs every agent marker (case-insensitively, see guard (ii)) from the child environment.
- `agent_connect` / `agent_disconnect` are reachable **only through the authenticated `island-agent/1` channel**: never through MCP or agent tools, and never through the CLI without these guards.

Honest same-uid limit: any process of the user that can read `<island>/runtime/session.json` can talk to the daemon, including Abito's own engine agent and Claude Code / Codex. Closing that needs the daemon launched by the island with an **inherited socket** (no discoverable session file); it is tracked as a security follow-up.
