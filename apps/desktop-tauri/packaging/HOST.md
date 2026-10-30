# App-owned island host

The user-local Linux install includes `desktop-daemon/` beside `abito-island`.
The first instance starts `node desktop-daemon/src/cli.cjs run --app-owned` during
Tauri setup. A second instance does not reach setup and creates no second host.
No service, global installation, downloaded runtime, or new `ABITO_*` override is
introduced. The existing private-root override is for disposable development runs;
the production launcher still accepts only `ABITO_PROJECT_ROOT`.

## Lifetime and supervisor boundaries

**The app never restarts the host, so app→host has no restart loop, and the daemon
alone owns the bounded backoff for pi.** Pi's delay is capped, not its number of
restart attempts. Host failure leaves the island alive; a settings refresh uses the
existing `no_daemon` path. Restart the app to start a new host.

On Linux the direct child receives `PR_SET_PDEATHSIG(SIGKILL)` before exec. The
post-prctl parent PID check closes the fork/parent-death race. This is the hard
crash/SIGKILL protection; stdin EOF is an additional graceful lifetime lease.
Normal exit, SIGINT and SIGTERM close the lease, terminate the owned process group,
wait up to five seconds, then kill the group **and direct child**, and poll reap
for at most one additional second. No unconditional `wait()` can hang app exit.
If the kernel cannot reap yet, parent-death protection remains active at app exit.
`Command::spawn` waits for its exec/error handshake: successful spawn has already
completed `pre_exec`; there is no post-spawn-before-setpgid window. The direct PID
fallback instead protects against a host escaping its original process group.
The adversarial regression test exercises precisely that case with SIGTERM ignored.
Kernel SIGKILL cannot remove
`session.json`; the next daemon validates whether the recorded process is alive
before using it. A stale handoff is not a live connection.

macOS uses the existing stdin lease, kqueue sentinel, and daemon parent-pid
watch instead of Linux's parent-death signal. This change does not modify those
lifetime mechanisms. Windows support is maintained separately.

## Runtime discovery

The app tries the inherited session PATH first (absolute entries only), then:

| Runtime | Canonical fallback order |
|---|---|
| Node | `/usr/local/bin/node`, `/usr/bin/node` |
| Pi | `$HOME/.local/bin/pi`, `/usr/local/bin/pi`, `/usr/bin/pi` |

The session PATH normally contains `~/.local/bin`; the scrubbed test PATH does
not. Both paths are tested. Only discovered runtime directories not already in
PATH are appended to the **child** environment. No login shell, broad disk search,
or parent environment change occurs. SDK package resolution can thus find the
same Pi installation even with a scrubbed PATH. The daemon still isolates Pi and
SDK credentials from the user's own agent directory.

Startup failures reach stderr and the existing `agent:state` channel as
`connection: "no_daemon"` plus `last_error: {code, n: 1}`. Closed local codes are
`node_missing`, `pi_missing`, `host_missing`, `host_spawn_failed`, and
`host_platform_unsupported`. No paths, raw exceptions or secrets enter this state.
The settings and island views name missing Node or Pi and show installation
advice (`nodejs.org` or `npm install -g @earendil-works/pi-coding-agent`). Unknown
startup errors retain the existing generic disconnected state.

This unsandboxed user-local installation intentionally does not bundle Node or Pi.
A hermetic runtime bundle becomes necessary if distribution is sandboxed: a
Flatpak cannot execute the host's Node. The other Abito Flatpak is not modified.

## macOS app bundle

Build from `apps/desktop-tauri` with:

```sh
npx --yes @tauri-apps/cli@2 build --ci --bundles app,dmg \
  --config "$(node packaging/macos-config.cjs)" -- --locked
```

The config generator uses `DAEMON_FILES`, `HARNESS_FILES` and `PI_FILES` from `lib.cjs` as
an exact source-to-resource map. Tauri copies them into
`Contents/Resources/desktop-daemon`, `Contents/Resources/desktop-harness` and `Contents/Resources/desktop-pi`.
The host looks there before the debug-only source fallback. The daemon's existing
sibling lookup also finds the hook installer there; no separate hook override is
needed. Linux still uses the directories adjacent to the executable.

Finder's minimal PATH is supported: macOS checks the user's `.local/bin`,
`.npm-global/bin`, `.volta/bin`, and selected NVM version, then Homebrew
`/opt/homebrew/bin` and the existing system locations. NVM uses the exact version
named by `.nvm/alias/default` (at most one extra alias file, including `lts/name`).
If unavailable, it selects the highest numeric `vMAJOR.MINOR.PATCH/bin` under
`.nvm/versions/node`; enumeration is capped at 128 entries and alias reads at
256 bytes. No shell, glob expansion, or recursive alias resolution is used.
Overflow yields no NVM candidate. Absolute inherited PATH entries still win.
Node/Pi are not bundled; arbitrary custom prefixes and fnm require PATH setup.
GUI installs on macOS/Windows use the canonical home directory only when
`ABITO_PROJECT_ROOT` is absent (HOME on macOS, USERPROFILE on Windows). Explicit
invalid settings still fail, debug roots remain unchanged, and Linux still
requires its launcher-provided setting.

`ci/public/preview-macos.yml` tests on standard `macos-26`, builds the unsigned
app/dmg, and runs `smoke-macos.py` with a minimal OS-only environment. It verifies
both daemon readiness and notice transport startup, then missing-Pi advice with
notices still available. The smoke script refuses non-CI hosts and installs no
hooks. Logs and bundles are uploaded even on a failed smoke. The matching
`release-macos.yml` uses the identical bundle config. CI execution does not prove
Finder interaction, Gatekeeper acceptance, or a human-installed Mac launch.

## Recursive verification envelope

`lib.cjs` declares every shipped file in `STAGED`, including each daemon source,
package metadata, identity and third-party notice. `receipt.files` is the exact
flattened map of relative path → SHA-256. The declared directories are exactly
`desktop-daemon` and `desktop-daemon/src`. Recursive enumeration rejects extra
files, missing files, extra empty directories, symlinks anywhere, writable files
and receipt key drift. Every shipped file is hashed. Directory entries themselves
have no content hash but must match the declared layout and safe modes.

The daemon source list includes `src/connector-host.cjs` and
`src/connector-host-client.cjs`: they are required at module load even when
`connectorHostBin` is unset. Omitting either breaks the packaged CLI before it
can report status. `test-node/host-stage-check.cjs` runs the staged CLI's public
`status` command with an isolated, absent island: exit 3, empty stdout, and exactly
`abito-island-daemon: not running` on stderr (with one LF), with no island created
and all receipt hashes unchanged. It then removes each module from its disposable
stage in turn and proves that the CLI fails rather than falling back to the source
checkout. This checks runtime module closure, not a release build or live connector
functionality; the Rust connector-host binary is not bundled by this source-list
change and must still be explicitly configured if installed later.

The installer now needs Node and its sibling `lib.cjs`; the former standalone
flat-file shell envelope intentionally becomes a recursive closed-set envelope.
It verifies before touching installation state, checks destination ancestor chains
and rejects undeclared installed entries. Each installed file retains temp-copy,
re-hash, then same-directory rename atomicity. This is **per-file** atomicity, not
an all-files transaction. The application desktop directory may retain other apps.
Uninstall removes only declared files and prunes owned directories only when empty.

Tests in `test-node/install-check.cjs` exercise daemon-file tampering, extra and
missing nested files, file/directory symlinks, an extra empty directory, receipt
key drift, and a malicious destination directory; rejected stages create no
install directory, and rejected reinstallation preserves the previous binary.
Existing launcher allowlist, idempotent reinstall and running-binary replacement
checks remain in place.

## Evidence sequencing

No dirty official stage is allowed. `build.cjs` checks both the desktop crate and
shipped daemon sources for clean committed bytes before cargo or staging. Before
the parent's commit, a hand-assembled disposable stage can demonstrate the file
layout, receipt fields and verifier/installer behavior but is **not** release
provenance. Official build, user-local install and installed-app UI/chat evidence
must wait for that commit. Do not fabricate `provenance.clean` for a release.
