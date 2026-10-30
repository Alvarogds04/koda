# Abito desktop daemon — island agent engine (U1)

The island chat is a full agent, not a direct model call: this package supervises the
installed `pi` running `--mode rpc` as a child process inside a private island, with an
Abito identity, isolated environment, session privacy, request correlation, crash
restart with bounded backoff, and clean stops. Plain Node CJS, zero runtime
dependencies.

Status: U1–U4 implemented (runtime, profiles, island transport, config/CLI/daemon). The installed `pi` on this machine is the default
runtime and was smoke-verified offline (`start` → `get_state` → `stop` against the
real binary in a temp island); tests themselves still use a fake agent so they never
depend on an install or a provider.

## App-owned startup

The Linux Tauri app starts this host as its direct child with
`node src/cli.cjs run --app-owned`. The flag adds a stdin lifetime lease: EOF
requests shutdown, including EOF received during startup. Plain `run` retains its
foreground SIGINT/SIGTERM behavior; `status`, `stop` and config commands are unchanged.

Generic CLI failures append a bounded diagnostic with an allowlisted error name/code
and a fixed, path-redacted category. Unknown exception details are omitted, not
printed after best-effort redaction: they may contain tokens or account data. The
app-owned daemon inherits the island's stderr; it does not create a separate daemon.log.

On Windows, read-only `status` is healthy only after the fixed sibling
`abito-private-session.exe --verify` proves session-file owner/ACL, pipe-server
PID/SID and authenticated hello→ready. Node does not send the token before that
native proof, and status never cleans up the session file. Missing/failed helpers
fail closed. `stop` still refuses an unconfirmed Windows PID; status proof does
not grant signal/kill authority.

**The app never restarts the host, so app→host has no restart loop, and the daemon
alone owns the bounded backoff for pi.** This means a capped retry delay, not a
fixed retry count. App-side host crashes degrade through `no_daemon`; app shutdown
disables engine restarts. Linux crash protection, discovery order, recursive
packaging receipts and the non-Linux limitation are documented in
[`../desktop-tauri/packaging/HOST.md`](../desktop-tauri/packaging/HOST.md).

## Island layout

Everything private lives under one root: `~/.abito-island` by default, moved with
`ABITO_ISLAND_DIR` (tests and embeddings use this). Created with mode `0700`, owned by
the current user:

| Path | Purpose |
|---|---|
| `<root>/home/` | The engine's private `HOME`, with the XDG tree (`.config`, `.cache`, `.local/share`, `.local/state`) under it |
| `<root>/agent/` | The installed pi's agent directory (`PI_CODING_AGENT_DIR`); no user Pi settings, extensions or auth are reused |
| `<root>/sessions/` | Private RPC sessions (`--session-dir` is always passed explicitly) |
| `<root>/workspace/` | The engine's owned default workspace; its `.engram/config.json` pins the memory project `abito-island` |
| `<root>/workspace/uploads/` | #343: chat file attachments, written by the Tauri app (0700 dir, 0600 files, generated names) — the agent reads them as workspace files |
| `<root>/tmp/` | Private `TMPDIR` |
| `<root>/identity.md` | The Abito identity file, regenerated from `identity.md` (mode `0600`) before every spawn |
| `<root>/state.json` | The open session file, persisted for continuity across crash restarts (mode `0600`) |
| `<root>/config.json` | User config (U4, section below; mode `0600`) |
| `<root>/runtime/` | `session.json` host handoff, the `p-XXXXXX/s` socket (U4), the `launches.jsonl` ledger (#390) and the `interrupted.json` record (#385) |

Path checks fail closed: any symlink component, any world-writable component without
the sticky bit, any component owned by a foreign user, or an island root owned by
someone else (including root) is refused. An existing island root is tightened to
`0700`.

Private file writes go through `writePrivateFile(target, content, { mode })`
(exported for U2/U4): the parent directory must be private, an existing target must
be a regular non-symlink file owned by the current user (a symlinked target is
refused and its victim left untouched), content lands in an `O_EXCL|O_NOFOLLOW`
temp file renamed over the target, and the result is exactly the requested mode
(`0600` by default). The identity file and `.engram/config.json` use this helper.

## Child environment

The child gets an allowlisted environment — `PATH`, `USER`, `LOGNAME`, `SHELL`,
`LANG`/`LC_*`, `TZ`, `TERM`, `COLORTERM`, `GIT_CONFIG_GLOBAL` — plus explicit
overrides. Parent provider keys, every inherited `PI_*` variable, session state and
foreign agent homes never reach the child. Explicitly set:

- `HOME` → island home; `TMPDIR` → island tmp; `XDG_*` → under the island home
- `PI_CODING_AGENT_DIR` → island agent dir (the supported override; the `--home` flag
  is not a supported pi CLI flag and is never used)
- `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0` — the engine runs
  offline; no model catalog refreshes, no version check, no telemetry
- `GIT_CONFIG_GLOBAL` → the user's real `~/.gitconfig` when it exists, so git
  identity works without exposing the real `HOME`
- `ABITO_MEMORY_PROJECT=abito-island` — the memory project pin

The user's git identity is the only piece of the real home that crosses the boundary.

## API (for U2/U3)

```js
const { AgentEngine } = require("@abito/desktop-daemon/runtime.cjs");

const engine = new AgentEngine({
  command: "pi",              // configurable executable; never a direct model HTTP client
  root: "~/.abito-island",    // island root
  identityPath: "identity.md" // source identity copied into the island before each spawn
});
await engine.start();                          // stopped -> starting -> ready
const res = await engine.request({ type: "get_state" });  // correlated, timeout-bounded
engine.on("event", (record) => {});            // agent session events
engine.on("status", ({ state }) => {});        // stopped | starting | ready | restarting
engine.on("exit", ({ code, signal }) => {});
engine.send({ type: "extension_ui_response" }); // records without a response
await engine.stop();                           // disables restarts, terminates gracefully then SIGKILL
```

Behavior details:

- **Framing**: strict JSONL split on LF bytes only (`JsonlDecoder`); U+2028/U+2029
  inside JSON strings never split records; `readline` is deliberately not used. An
  unframed record over `maxRecordBytes` (default 1 MiB) is discarded whole — never
  buffered, parsed or logged — with a size-only diagnostic; the engine keeps running.
- **Diagnostics hygiene**: malformed records, non-object records and oversize
  discards are logged without any of the child's raw content; stdin errors are
  swallowed; only the agent's own stderr text is forwarded.
- **Correlation**: every command gets an engine-unique id; responses resolve by id;
  per-request timeouts reject with `agent did not answer <type> within N ms`.
- **Bounded full turns (OD027 adaptation)**: an accepted prompt starts a monotonic
  `performance.now()` deadline before it is written. The prompt response is only
  an ACK; `agent_settled` is full completion. Default `turnTimeoutMs` is 300,000 ms,
  `maxTurnIterations` is 32 **observed `turn_start` signals**, and `abortGraceMs`
  is 2,000 ms. These positive-integer constructor options are technical Abito
  defaults, not upstream-proven values, public wire fields, CLI flags or saved config.
  The clock includes tools, steering and waits for extension UI; none reset it.
  Deltas, tools, `agent_start`, `agent_end` and `turn_end` are not iteration starts.
  Abort is conservative: it fires **on the 32nd start**, not after 32 completed cycles.
- **Cancellation and ambiguous ACK loss**: expiry or explicit abort immediately
  closes admission/output/asks, sends one Pi abort, and keeps `engine.busy` true
  through recovery. An abort ACK never frees the turn. After settlement or the
  2-second grace, the owned child is killed and replaced through the existing
  supervisor; a cancelled child is always recycled before another prompt, even
  when it settles cooperatively. Child-identity guards discard its late callbacks.
  The private session is reopened, but prompts/partial answers are never replayed.
  Lost prompt ACKs are treated as ambiguous and use the same fail-closed cutoff,
  not a retry. Healthy natural settlement clears the timer without recycling.
  Idle abort still reaches Pi, and new conversations remain refused while busy.
- **Session reset/switch admission**: `new_session`/`switch_session` acquire a
  single-flight busy gate before writing. The socket's `new_conversation` does
  the same before awaiting Pi, so send/profile/workspace/config changes keep their
  existing busy rejection without writes, queues or replay. Ordinary `get_state`
  reads remain available. A successful ACK is followed by an owned-session
  identity check through `get_state` before the gate is released. Timeout, lost
  ACK, failed response or child failure never prove the reset was unapplied:
  admission stays closed while the owned child is cut off and a replacement
  reopens the last verified session. The reset is never automatically retried.
  Stop/generation changes invalidate stale reset continuations. Cancelled/reset
  recovery pins the last verified owned session: a replacement that merely ACKs
  reopening but reports another identity stays busy/unavailable, never ready.
- **Limit of proof**: Pi reports events asynchronously and processes abort
  cooperatively. Observation/cutoff cannot guarantee a hard provider-call or tool
  side-effect ceiling or undo completed effects. One daemon has one current Pi
  session shared by its clients, not independent concurrent thread engines.
  OD027's inventory records only a source reference
  (`opendots-upstream/src/server/dot-agent.ts:32-33`,
  `625452e06cde74cb25b0ce319e2c1be0488f5a5f`); this implements a Pi adaptation,
  **not AG-UI/TanStack support or upstream runtime parity**.
- **Exit**: all pending requests reject with `agent exited (...)`.
- **Crash restart**: after a child that had reached `ready` exits unexpectedly, the
  engine respawns with exponential bounded backoff (default 1s, 2s, 4s, 8s, 16s, 30s,
  repeating; reset after 30s of stable uptime). A first `start()` that never becomes
  ready fails to the caller instead of restarting in the background. One
  initialization owns startup failure and one restart timer owns the next attempt;
  startup close never independently schedules a duplicate retry. No live child
  can be overwritten by another spawn. Stop awaits the owned initialization and
  clears its pending restart timer, without changing the backoff policy.
- **Session continuity**: the open session file from `get_state` is persisted to
  `<root>/state.json` on every spawn; after a crash restart, a persisted path is
  reopened with `switch_session` only when it is inside the island sessions dir,
  a regular non-symlink file owned by the current user. Anything else is ignored.
- **Stop**: `stop()` ends stdin, then SIGTERM after `stopTimeoutMs`, then SIGKILL; it
  disables restarts, clears turn/deadline/grace timers, and later requests reject with `engine is not ready`.
- **Spawn args**: `--mode rpc --session-dir <island sessions> --append-system-prompt
  <island identity.md>` (plus configurable command/extra args).

## Memory

The owned default workspace carries `.engram/config.json` with
`project_name: "abito-island"`, and the child env pins `ABITO_MEMORY_PROJECT`. A
user-preferred working folder (`workspacePath` option) is only used as the spawn
`cwd`: nothing is ever written there. **Known enforcement limit (see U4 section)**: for an
arbitrary workspace the pin travels only via explicit env and the identity prompt —
Engram's per-folder config is not written to user folders, so the engine cannot yet
guarantee the project pin if a folder has its own `.engram/config.json`.

## Multi-Space access per Dot (#376, policy only — enforcement dormant)

`src/spaces.cjs` is the PURE policy module for granting a specialist Dot access to several
Spaces: a closed list of bounded plain-text names (≤ 8, each ≤ 80 chars, no control
characters) on top of its own default Space name. A dot that carries no Space fields at all is
UNRESTRICTED, which is exactly the behaviour before #376. The module never spawns, reads,
writes or talks to the engine, and it caches nothing: the caller supplies a `grantsFor(dotId)`
resolver and the module calls it ONCE per check, so revoking a Space takes effect on the very
next tool use without restarting the daemon or the engine.

**CALL-SITE CONTRACT (for #418 / #374).** Nothing calls this module yet: enforcement is
dormant until the tool-use path exists. When it does, on every tool use that names a Space the
caller MUST (1) resolve the tool use's target Space, leaving `space` unset for unscoped tool
uses (always allowed, out of policy scope); (2) call
`checkToolUse(grantsFor, { dotId, space })` with a resolver that re-reads the dot's CURRENT
grants from the live specialists store, never a snapshot taken at session start; and (3) refuse
the tool use with the returned closed `reason` (`dot_unknown` or `space_not_granted`) without
mutating any stored value or counter. Grants data itself is declarative and fails closed on
load (`normalizeGrants`): hostile entries are dropped, never executed; duplicates collapse to
the first occurrence; over-cap lists are truncated.

## Testing

```sh
cd apps/desktop-daemon && npm test
# or from the repo root:
node --test apps/desktop-daemon/test/isolation.test.cjs apps/desktop-daemon/test/runtime.test.cjs
```

Tests run a fake RPC agent (`test/fixtures/fake-agent.cjs`) with `process.execPath`:
no providers, no network, no dependency on an installed pi. Coverage: island layout
and permissions, symlink/world-writable/foreign-owner refusal, private atomic file
writes (0600 enforcement, symlinked identity/config refusal with victim intact), env
allowlist and explicit overrides, argv plumbing (private session dir and identity),
chunked JSONL with Unicode line separators intact, malformed and oversized record
discards without raw content, interleaved request correlation, request timeout, crash
restart with backoff, session continuity via switch_session (and refusal of session
paths outside the island), pending rejection on exit, and stop-without-restart.

`test/turn-budget.test.cjs` additionally drives a controllable offline child
(`test/fixtures/turn-agent.cjs`) and the authenticated Unix socket: prompt ACK
without settlement expires; steering does not reset the deadline; 31 starts plus
many tool/delta/end events stay admitted, while the 32nd start cancels; abort ACK,
missing ACK and early settlement all require child replacement; session continuity,
healthy settlement, explicit abort/new conversation, crash/stop, ask closure and
invalid-frame no-write/no-action behavior are checked. Delayed reset/switch tests
also assert public daemon busy/error codes, rejected-action/config counters,
verified post-reset prompt identity, failed/lost-ACK/crashed reset recovery without
retry, and stop/old-generation teardown. A separate recovery mismatch assertion
keeps admission closed when reopen is unconfirmed; a first-reopen-crash regression
checks exactly three spawns, restored identity, no prompt replay, and no children
or runtime timeouts after stop. The suite is registered in `npm test`.
Run it separately with
`node --test apps/desktop-daemon/test/turn-budget.test.cjs` from the repo root.

POSIX only: ownership and mode checks use `lstat`/`chmod` semantics that do not apply
on Windows.

## Attribution

Structure, framing and supervision adapted from the Gentle Dot daemon (MIT); see
THIRD-PARTY-NOTICES.md.

## Accounts, authentication and profiles (U2)

- `src/auth.cjs` — `AccountManager`: named accounts under `<island>/accounts/<id>/`
  (private `auth.json` written only by the SDK helper, public `account.json`
  without secrets). Native login runs in a short-lived `src/sdk-helper.mjs`
  child in a clean environment (no provider keys, no `PI_*`); one login flow at
  a time (`auth_busy`), bounded prompt/flow timeouts, `cancel` kills the child.
  Events: `auth_prompt`, `auth_event`, `auth_done` (never carry answers or keys).
  The SDK is resolved via the `sdkModule` option / `ABITO_SDK_MODULE`; the user's
  Pi credentials are never imported.
- `src/profiles.cjs` — `ProfileStore`: role profiles `{id,label,role,accountId,provider,modelId,thinkingLevel}`.
  `select` copies one credential into the owned `agent/auth.json` (0600), restarts
  the engine, then `set_model`/`set_thinking_level`; refused while busy; any
  failure restores all files and restarts a running engine so memory matches disk. Nothing is activated implicitly.
- DTOs expose no key, token, header, `baseUrl` or env; errors are generic.
- `ProfileStore.deactivate()` undoes an activation (same lock, journal, busy guard and rollback; the refreshed credential is saved back first). With no active profile it does nothing.
- Provider settings over the wire (v0.2): `account_create|remove|logout|status`, `profile_save|remove|deactivate` and `auth_state`; schemas and the setup sequence are in [docs/PROTOCOL.md](docs/PROTOCOL.md).
- Local models (v0.2): `local_account_create` / `local_endpoint_set` connect Ollama, LM Studio, llama.cpp or vLLM as an account with no secret on the wire. Loopback only (`localhost`, `127.0.0.0/8`, `[::1]`) with an explicit path such as `http://127.0.0.1:11434/v1`; remote endpoints are intentionally unsupported. The hostname `localhost` is resolved by the Pi client at request time (it trusts the host resolver); `127.0.0.1` or `[::1]` is recommended; plain http means traffic never leaves the machine. `local_endpoint_set` also re-enables a logged-out local account. The endpoint stays in the account's private `models.json` (0600) and a fixed non-secret placeholder key; see [docs/PROTOCOL.md](docs/PROTOCOL.md).
- Global pause (#379): the closed `set_paused{paused}` verb stops all admission — no new agent turns (`send`/`steer`/`new_conversation` refused with `error{paused}`), no process-spawning tool/connector calls (`agent_connect`, `connectors_list`, `agents_list` refused); `abort` and `agent_disconnect` (stopping work) and every read-only verb stay allowed. Pausing while a turn runs interrupts it through the engine's cancellation path (#378): a sanitized toast explains the pause, the child is recycled, the session reopens and no prompt is replayed. The switch is persisted as the strict boolean `paused` key in `config.json` and restored at the next boot; `ready.state`, `agent_state` and `status` carry it. Details in [docs/PROTOCOL.md](docs/PROTOCOL.md).
- Live interruption (#378): when the user's access for the running agent is revoked (`account_logout` of the account backing the active profile) or the pause turns on, the in-flight turn yields at the next safe point with a fixed, engine-text-free closed event; the logout is applied only after the safe point (bounded wait; on timeout it answers `busy` and the credential is untouched). Details in [docs/PROTOCOL.md](docs/PROTOCOL.md).
- Custom gateway provider (HU-041): `custom_account_create {label, baseUrl, accountId?}`, `custom_endpoint_set {accountId, baseUrl}` and `custom_models_refresh {accountId}` configure a LiteLLM / OpenAI-compatible gateway (for example `https://gateway.example/v1`). Each replies `account` (DTO adds `custom: true`; the Base URL is never on the wire) and broadcasts `accounts`. Base URL: `https` or `http` only for a literal loopback address (`127.0.0.0/8`, `[::1]`), no userinfo/query/fragment/escapes. The API key goes through the existing `auth_start {method:"api_key"}` / `auth_reply` (masked transient input) into the account's private `auth.json`; there is no second store. `custom_models_refresh` (and `custom_endpoint_set` while signed in) do one bounded `GET <baseUrl>/models` with the bearer key: no redirects followed (any 3xx fails, same-origin too), 10 s, 256 KiB, 128 models, 200-char ids; failures are `error{failed}` and keep the previous `models.json`. While a key is stored the host cannot be changed (sign out first). No automatic fallback, model start or switch. Control characters (including TAB, DEL and CR/LF) in a custom provider's API key are refused up front, before any side effect (the prompt stays open for a retry). `profile_save` / `profile_select` / `role_select` work for a custom account like any other once models have been discovered and the model is one of them; otherwise activation is refused and no file is touched.

  **Guarded Pi transport (T6a-2).** Pi's `models.json` cannot give a provider a per-call `fetch`, and the SDK's default one follows redirects, so activating a custom profile installs, through the same journaled activation/rollback as the credential, ONE fixed versioned extension (`<agent>/extensions/abito-custom-provider.js`, byte-identical `TEMPLATE` from `src/custom-provider-extension.cjs`, no user data in code) plus validated runtime data (`<agent>/custom-provider.json`, 0600: provider id, Base URL, model ids — never the key, which Pi resolves from the private `auth.json`). The extension re-validates that data, registers only that provider and delegates to the SDK's own `openai-completions` stream with a guarded `fetch`: scheme+host+port+path pinned to the configured Base URL (`POST …/chat/completions`, `GET …/models` only), HTTPS or literal-loopback HTTP, `redirect:"manual"`, every 3xx refused (same-origin included, body cancelled, nothing followed or retried), bounded header wait/idle time and response bytes (inference limits, named once in the template's `LIMITS`: **300 s** to the first response header, **300 s** idle between stream chunks, **64 MiB** response cap — generous on purpose because local/self-hosted models can be slow to load and to think, so a stalled gateway is given up on after 5 minutes; user/Pi cancellation aborts the in-flight request immediately and does not wait for these; model discovery is a separate, stricter policy: **10 s**, **256 KiB**, 128 models), and errors reduced to fixed key-free phrases. The account's `models.json` entry is never projected for a custom provider (it would use the unguarded transport); selecting any other profile or deactivating removes the extension and runtime data, and a failed activation restores them exactly. No global preload/fetch wrapper is used and other providers are unaffected. Key storage: `auth.json` is 0600 in a 0700 directory on POSIX; the daemon's Windows owner-only ACL coverage for these files has not been verified, so no Windows guarantee is claimed.


## Island protocol (U3)

`src/server.cjs` exports `IslandServer` (local 0600 Unix socket in a 0700 dir, token handshake,
bounded JSONL) and `src/protocol.cjs` the pure codec/translation. Wire format, frame table and
limits: [docs/PROTOCOL.md](docs/PROTOCOL.md). History replay is not implemented; the CLI is in the U4 section.

## User config, CLI and host handoff (U4)

### Run it

```sh
abito-island-daemon run                      # foreground; Ctrl-C / SIGTERM / SIGINT stop it gracefully
abito-island-daemon status                   # sanitized JSON (never the token); exit 3 if not running
abito-island-daemon stop                     # SIGTERM to the pid in session.json, ownership-checked
abito-island-daemon config get               # effective config
abito-island-daemon config set-workspace /abs/dir
abito-island-daemon config set-hotkey Ctrl+Alt+Space   # or --clear; persisted only, no engine restart
```

(`node src/cli.cjs ...` without installing the `bin`.) Exit codes: `0` ok, `1` error
(config errors print only `invalid config: <field>`), `2` usage, `3` not running.
There is no auto-start and no service unit: the host (Tauri) starts `run` itself.
`stop` and `status` only act on a process whose identity is confirmed: it must be alive,
owned by the current user, have the exact start time (`procStart`, field 22 of
`/proc/<pid>/stat`, raw ticks) the daemon recorded in `session.json`, and a command line
of this daemon. Any mismatch, missing `procStart` or unreadable `/proc` fails closed:
nothing is signalled (a same-user `node .../cli.cjs` that merely sits at a recorded pid
is never killed). A `session.json` of a confirmed-dead pid is stale and removed; one
whose pid cannot be confirmed is left alone.
On `run`, a synchronous `exit` handler removes `session.json` (token and pid compared)
after abnormal exits such as an uncaught error. SIGKILL (or a power loss) cannot be
handled, so the file survives it; the next `status`/`stop` classifies it as stale and
unlinks it. `stop` is a graceful SIGTERM, not a crash path.

### `config.json` (`<island>/config.json`, 0600, all keys optional)

| Key | Type | Meaning |
|---|---|---|
| `workspace` | absolute path | Engine cwd. Must exist, be a directory owned by you, have no `..` and no symlink anywhere in the path, and not be the island root or inside it (the island's own `workspace/` is the only exception). Default: `<island>/workspace` |
| `command` | string | Executable name (`[A-Za-z0-9._+-]`) or absolute path; default `pi`. Never a shell string |
| `thinking` | string | Default thinking level (`off…max`), applied each time the engine becomes ready (skipped when `profile` is set: the profile owns it) |
| `profile` | string | Saved profile id activated at start |
| `mcpConfigPath` | absolute path | Private MCP source, see below |
| `connectorsCommand` | absolute path | ABSOLUTE, normalized path (`path.normalize(x) === x`, no `..`) of the installed `abito-connectors` binary; the host sets it. **No default and no bare names** (PATH lookup would let a planted binary run): unset → `connectors_list` answers `unavailable` and nothing executes. The binary is trusted code run as the user (`config.json` is `0600`, fail-closed). Checked before every spawn: regular file after realpath, executable, owned by you or root, not group/world-writable, secure parent chain. Invalid → `invalid config: connectorsCommand` |
| `connectorsDir` | absolute path | Directory holding `connectors.json`, passed as `status --dir`. Clean absolute path (no `..`, no NUL); default `<island>/connectors`. Created `0700` by the daemon the first time `connectors_list` runs (symlinks and foreign owners are refused); invalid → `invalid config: connectorsDir` |
| `hookInstallerBin` | absolute path | ABSOLUTE normalized path of `apps/desktop-harness/bin/abito-hook.cjs` (no default): enables `agent_connect`/`agent_disconnect`. Unset → every agent `unavailable`, nothing executes. Checked before every spawn: regular non-symlink file owned by you/root, not group/world-writable (a 664 checkout is refused), secure parents. Invalid → `invalid config: hookInstallerBin` |
| `connectorHostBin` | absolute path | ABSOLUTE normalized path of the `abito-connector-host` binary (no default; read at daemon start, changes require daemon restart). Unset → no supervisor is created and nothing executes. **Stricter than `connectorsCommand` and `hookInstallerBin`:** the configured path itself must be a regular, non-symlink executable (a symlinked install must configure the real path), owned by you or root, with no group/world-write or setuid/setgid/sticky bits. Every parent directory up to `/` must be a non-symlink owned by you or root and not group/world-writable; root-owned sticky world-writable ancestors such as `/tmp` may be traversed, but the binary's own directory must not be writable by group/world. The exact checked path is executed and rechecked immediately before every spawn. Invalid → `invalid config: connectorHostBin` |
| `hotkey` | string | Global show/hide combo, stored only (the X11 capture lives elsewhere). Grammar: 1+ distinct modifiers `Ctrl`/`Alt`/`Shift`/`Super` joined by `+`, then ONE key: ASCII letter/digit, `F1`–`F24`, or `Space Enter Tab Escape Backspace Delete Insert Home End PageUp PageDown Up Down Left Right`. Case-insensitive input, canonical `Ctrl+Alt+Shift+Super+<Key>`; bare key, duplicates, whitespace/control/non-ASCII, > 40 chars are rejected as `invalid config: hotkey`. Changing it never restarts the engine; `config get` prints `null` when unset; `status` includes it. An invalid `hotkey` already on disk (hand edit) is inert: it is ignored on read paths (`run`, `config get`, `set-workspace` keep working; `status.hotkeyInvalid: true`, `config get` prints `hotkey: invalid (ignored)` on stderr, never the value) and is dropped on the next `set-workspace`/`set-hotkey` rewrite. Writes stay strict |
| `paused` | boolean | Global pause switch (#379), written only by the `set_paused` protocol verb (no CLI key): strict boolean, `false` removes the key; a hand-edited non-boolean is `invalid config: paused`. Restored at the next daemon boot; `status.paused` reflects the live state |

**Connectors (`connectors_list`).** Additive, read-only: the daemon runs the connectors CLI (5 s timeout, 256 KiB cap, private HOME, no `PI_*`/provider keys, no retries), revalidates its output against an allowlist and replies a sanitized `connectors` frame (see `docs/PROTOCOL.md`). The data are the PERSISTED `connectors.json` values, not live: no pending approvals or mutation actions are carried by this frame. Live control is separate (H2c below). DTOs never contain a connector secret or capability. `status.connectorsAvailable` is true only when a connectors view is actually wired (a valid `connectorsCommand` is configured). One snapshot spawns TWO processes (`catalog` + `status`), each in its own process group killed whole on timeout/oversize/failure; the 1 s minimum interval is per snapshot. The child gets a fixed `PATH=/usr/bin:/bin`. The daemon emits at most 128 connectors / 32 catalog entries and a frame of at most 200 KiB, otherwise `failed` (never truncated). Both keys are read at daemon start.

**Agent hooks (`agents_list`, `agent_connect`, `agent_disconnect`).** Additive (see `docs/PROTOCOL.md`, "Agents frames"): the island connects/disconnects the Claude Code and Codex hooks, notify-only weekly recap (`recap`, «Resumen semanal») and Claude status-line relay (`statusline`, «Uso del plan (relay)») with a button. Recap only counts activity (no command text, path or prompt kept); the status-line relay preserves and prints an existing status line. Both use `~/.claude/settings.json`, backup first, marker-only removal and a required shown plan hash. The status-line installer also saves/restores `~/.abito/statusline-previous.json` (0600), as in its interactive flow. `src/agents.cjs` drives the harness installer (`install <claude|codex|recap|statusline> --user ... --json`, then `--apply-plan <hash> --audit-dir <island>/audit`) as a subprocess with an allowlisted env (`PATH`, the REAL `HOME`, `LANG`, `ABITO_ISLAND_EXE` = the daemon's node: installer guard (i) becomes "the parent is the daemon's node"), 10 s group-killed timeout, 256 KiB stdout cap, stderr never surfaced. One operation at a time globally (`busy`), `agents_list` cached 1 s. The `plan_hash` the island showed is the only plan that can be applied (otherwise `plan_changed`, nothing written). `status.agentsAvailable` is true when `hookInstallerBin` is configured.

**Connector host supervisor (H2a/H2b; internal API only).** With `connectorHostBin`, the daemon starts one Rust host after the engine. The host's stdout/stderr are drained and never retained or logged; its environment is only `PATH=/usr/bin:/bin`, `HOME=<island>/home`, and optional `LANG`. `status.connectorHost` is `unavailable`, `stopped`, `starting`, `ready` or `restarting`; `status.connectorHostAvailable` is true only while ready. A failed host start is fail-closed for connectors and does not prevent the daemon/server from running.

**Connector host trust limits (honest).** The binary is checked twice, immediately before every spawn, and the same path is then executed; the handoff the host publishes is accepted only when its pid is a live (not zombie, not exited) DIRECT child of this daemon whose start time (`/proc/<pid>/stat` field 22) equals the one recorded when it was spawned. Those checks are **check-then-use** (TOCTOU) and are NOT claimed to be eliminated: a process of the SAME user that can write the binary's directory could still replace the file in the microseconds between the last check and `exec`. The directory rules above are what make that swap require write access to a directory only the user (or root) controls; truly closing the window needs `fexecve` on an already-opened descriptor, which Node does not expose. The same-uid trust model applies throughout (any process of the user can also read `<island>/runtime/session.json`). On teardown the daemon stops the connector host before the engine and island server, allowing the host to remove `<island>/connectors/mcp-source.json` before the daemon removes the MCP projection.

The host MUST be spawned as the daemon's **direct child**, with no shell, wrapper, detached process or process-group indirection:

```js
spawn(hostPath, ['--island', islandDir, '--parent', String(process.pid)], {stdio:['ignore','pipe','pipe'], detached:false, shell:false})
```

`--parent` makes the host verify the real direct parent and exit when that parent changes or dies. It is mandatory: under systemd user sessions an orphan can be adopted by the user's child subreaper, so checking for adoption by PID 1 is not enough; a parent can also die before the host's `main` captures it. Exit 1 means refused startup, exit 2 means invalid CLI usage. The supervisor validates the private `connector-host.json` handoff and socket before hello/ready, uses bounded crash backoff, acknowledges shutdown before waiting for exit, and verifies `/proc` start ticks before signaling a stuck PID. The per-launch token and all control replies stay internal; H2a/H2b add **no** `island-agent/1` frames. The host's `failedClosed` state field is only the connector store's rollback-degraded flag: `failedClosed:false` is not proof that the build has a real keyring or transport. The daemon must never present `failedClosed:false` as “connectors work”; host-process readiness does not establish connector functionality. The existing field name is retained for compatibility and must not be inverted or reinterpreted.

When `mcpConfigPath` is unset the daemon intentionally does not point the engine at the host source. H2c/M6 decide that integration. A human or installer must explicitly configure `mcpConfigPath` to `<island>/connectors/mcp-source.json` when that source is to be projected.

**Invariants.** `agent_connect`/`agent_disconnect` and all `connectors_*` control commands are reachable ONLY through the authenticated `island-agent/1` channel: no MCP tool, engine tool or CLI path triggers them; they are rate-limited by the per-client limiter; each agent apply is audited by the installer (`<island>/audit/hook-installs.jsonl`, no content). **Honest same-uid limit:** the channel token is in `<island>/runtime/session.json` (0600), so any process of the same user that can read it (the Abito engine agent, Claude Code and Codex included) can send these frames; closing that needs the daemon launched by the island with an inherited socket (security follow-up, not done). The endpoint handoff rules enforced by the harness are specified below. Codex also needs a trust review in `/hooks`.

**Live connector controls (H2c).** `connectors_pending`, `connectors_approve`, `connectors_deny`, `connectors_connect`, `connectors_disconnect` and `connectors_mode` use the supervised Rust host over the authenticated socket; there is no CLI/MCP/engine shortcut. Pending previews are sensitive, deadline-relative and truncation-aware; setup secrets use only the existing `auth_prompt`/`auth_reply` flow, never a values map on `connectors_connect`. `read_and_send` requires the island's human confirmation; the daemon does not pre-approve it. The shipped host remains fail-closed (`connect` → `unavailable`); provider OAuth is unsupported. See [docs/PROTOCOL.md](docs/PROTOCOL.md#connectors-control-frames-h2c) for exact schemas, errors, limits and the same-UID approval risk.

#### Endpoint handoff consumed by harness hooks

An explicit `ABITO_DESKTOP_SOCKET` wins after endpoint-shape validation and means `endpoint.json` is not read. Otherwise runtime selection is ordered: `ABITO_SOCKET_DIR` (if set, it must be absolute, normalized and non-root), else `$XDG_RUNTIME_DIR/abito-island` only when `XDG_RUNTIME_DIR` is absolute, normalized and non-root, else `/run/user/<uid>/abito-island`.

The reader accepts `<runtime>/endpoint.json` only as a regular, non-symlink file owned by you, mode exactly `0600` including no special bits, one hard link, and at most 4096 bytes. Its complete text must equal `JSON.stringify(parsed)` or that exact compact JSON plus one LF; the object has exactly `v`, `endpoint`, `pid`, with `v: 1`. Duplicate keys, escaped key names, pretty printing, extra whitespace and CRLF are rejected. The Rust producer in `apps/desktop-tauri/src/handoff.rs` writes compact one-line `serde_json` followed by LF (`{"endpoint":"<..>","pid":N,"v":1}\n`); the `v,endpoint,pid` key order is accepted as well.

The `pid` must be positive, `/proc/<pid>` must exist, and `/proc/<pid>/stat` must be readable within 512 bytes. The state is parsed after the last `)`; `Z` (zombie), `X`, malformed and unreadable states fail closed. The optional `procStart` key (decimal string, field 22 of `/proc/<pid>/stat`) is verified when present: a different value is a recycled pid and the handoff is refused; a malformed value or an unreadable start time fails closed. Without the key the check is existence/alive only, so pid reuse stays a residual risk until the island writes it (Tauri lane switch `WRITE_PROC_START`).

The endpoint must be exactly `<runtime>/p-<6 alphanumeric>/s`, at most 107 bytes, and a Unix socket. `readHandoff` invokes the same `verifyEndpoint` chain checks as the client: every directory component is `lstat`-checked, non-symlink, owned by you or root, and not world-writable; `<runtime>` and the `p-` directory must be yours and exactly `0700`. The socket must be yours and exactly `0600`, not a symlink. This rules out a runtime under world-writable `/tmp`. The client checks before connect and rechecks the socket device/inode after connect; path re-pointing from handoff to connect is bounded by that dev/ino re-check, not eliminated. Same-uid processes remain trusted and can manipulate same-owner paths. Resolution does not connect, scan, or fall back; stale or unsafe handoffs mean unavailable.

Fail-closed: unknown keys, wrong types, a non-private (`go+rwx`) / symlinked /
foreign-owned / oversized file are all rejected as `invalid config: <field>` (value
never echoed) and the daemon refuses to start. Writes go through `writePrivateFile`
(atomic, 0600).

### Environment

| Variable | Effect |
|---|---|
| `ABITO_ISLAND_DIR` | island root (default `~/.abito-island`) |
| `ABITO_WORKSPACE` | overrides `workspace` from the file; validated identically (analogue of `GENTLE_DOT_WORKSPACE`) |
| `ABITO_MEMORY_PROJECT` | set by the engine to `abito-island` for the child; with the identity prompt it is the memory pin |
| `ABITO_SDK_MODULE` | SDK entry for the auth helper (U2) |
| `ABITO_E2E_PI=1` | enables `test/e2e-real.test.cjs` |

### Changing the workspace (restart semantics)

`config set-workspace` / `Daemon.setWorkspace()` validates first (a rejected path
changes nothing), then persists atomically. A change **requires an engine restart and
preserves nothing of the old session path**: `state.json` is reset to `{}` before the
engine restarts, so the new engine starts a fresh conversation and never reopens a
session created for another folder (the old session files stay in `<island>/sessions`).
The running daemon keeps its server, socket and token; only the engine child restarts
(clients see `agent_state: restarting` → `ready`). It is refused while a turn is
running (`busy`). The CLI signals a live daemon with SIGHUP to apply it. SIGHUP
(`Daemon.applyConfig()`) restarts the engine when the effective cwd (an explicit engine
`cwd` option, else the workspace, else the island workspace), `command` or
`mcpConfigPath` changed; the MCP projection is rewritten (and validated first) on a
`mcpConfigPath` change. `thinking` applies at the next engine start. `profile` is read
at daemon start only; change it at runtime with the `profile_select` request (a selected
profile also wins over the `thinking` default across restarts). When
`ABITO_WORKSPACE` is set it wins: the file is still updated but nothing restarts
(`overriddenByEnv: true`).

### Memory pin for arbitrary workspaces

The daemon **never writes `.engram` into your folder**. The pin is `ABITO_MEMORY_PROJECT`
+ the identity prompt. It does detect (read-only) a conflicting
`<workspace>/.engram/config.json` whose `project_name` is not `abito-island` and
reports `memoryPinConflict: true` in `Daemon.status()` and `abito-island-daemon status`.
Whether Engram prefers that folder file over the env pin is Engram's behavior, not
guaranteed here: treat the warning as "memories may land in the other project".

### Host handoff: `<island>/runtime/session.json`

```json
{ "protocol": "island-agent/1", "endpoint": "<island>/runtime/p-XXXXXX/s", "token": "<per-launch>", "pid": 1234, "procStart": "98765", "startedAt": 1700000000000, "ppid": 1200 }
```

Mode `0600`, written atomically after the socket listens, removed on stop (and on abnormal exits the process can observe; after SIGKILL it is stale and cleaned by `status`/`stop`). `procStart` is the daemon's own /proc start time, used to confirm identity. `ppid` (added by R8) is the boot-time parent pid, used to detect reparenting: a daemon whose current ppid is 1 OR differs from the recorded one is classified orphaned; on non-/proc platforms the check is skipped (no orphan detection). Legacy sessions without `ppid` keep the old ppid-1-only rule. The token
is generated per launch, lives only in memory and in this file, and is never logged
or printed by `status`. The Tauri host should: spawn `abito-island-daemon run`; wait
for `session.json` (parse; check `protocol`, `pid` alive); connect to the Unix socket
`endpoint`; send `{"type":"hello","protocol":"island-agent/1","token":...}` within 3 s
(see [docs/PROTOCOL.md](docs/PROTOCOL.md)); hand frames to the WebView **without** the
token or the endpoint; on exit re-read `session.json` (a new launch means a new
 token). Stop with SIGTERM to `pid` or `abito-island-daemon stop`.

### Interrupted work record: `<island>/runtime/interrupted.json` (#385 OD066)

A graceful stop records the work it is about to lose so it can be seen after a
restart. The record is taken BEFORE `server.close()` drops the clients and closes
the asks, while the state still exists, and only when something was actually
interrupted (a running turn and/or open asks); a clean stop writes nothing.

```json
{ "at": 1700000000000, "pid": 1234, "procStart": "98765", "turnActive": true, "asks": [{ "id": "u1", "kind": "select", "title": "Pick" }], "consumed": false }
```

Mode `0600`, written atomically through `writePrivateFile` (refuses symlinks and
non-regular files), never carrying a token nor prompt content. It is EVIDENCE,
never authority, mirroring `launches.jsonl`: exactly ONE record is kept (the
newest stop wins, the file is replaced, never appended), it is never deleted, and
a boot that starts well only marks it `consumed: true`. A record left
unconsumed by an abnormal exit (SIGKILL, power loss) survives and is marked
consumed by the next successful boot. ANY failure to write or mark it is logged
and skipped: a broken record never blocks a teardown nor a boot. The app-side
approvals (Rust host) are not part of this record; they are aborted at quit by
the host itself.

### Optional MCP (proxy-only)

If `mcpConfigPath` names a private (0600, regular, non-symlink, owned) file, only a
validated projection reaches the engine, written to `<island>/agent/mcp.json`:

```json
{ "mcpServers": { "<id>": { "type": "http", "url": "http://127.0.0.1:<port>/<id>", "headers": { "Authorization": "Bearer <capability>" } } } }
```

Accepted: only `type` (`http`), `url` (plain `http` to `127.0.0.1`/`localhost`/`[::1]`,
no URL credentials) and exactly one header `Authorization: Bearer <literal>`. **The
whole file is rejected** (daemon refuses to start) on any `command`/`args`/`env`/`cwd`/
`oauth`, non-loopback URL, other header, `${VAR}` / `!cmd` indirection, other
top-level key. No file configured → an empty projection is written so a stale one
never lingers. Pi natively reads `<PI_CODING_AGENT_DIR>/mcp.json` (docs/mcp.md), and
the engine's agent dir is the island's, so no extra flag or invention is needed. The
user's own `~/.pi/agent/mcp.json` is never read. Changing `mcpConfigPath` takes effect
at the next daemon start. Pi still decides exposure (default `codemode`).

### Security notes and known limits

- Island, runtime dir and socket dir are 0700, socket and files 0600; per-launch token.
- `session.json` is a bearer secret for the local user only; keep the island on a local, private disk.
- `abito-island-daemon stop`/`status` rely on `/proc` (start time, uid, cmdline) to confirm the daemon; without `/proc` they fail closed and refuse to signal.
- MCP source entries are written as the WHATWG-normalized URL; server ids `__proto__`, `constructor`, `prototype` are rejected.
- `config.json` reads apply the same secure-path checks as writes (a symlinked island directory is refused).
- A workspace validated at start can be swapped for a symlink later (TOCTOU between validation and spawn); the engine runs as you, with your permissions, in that folder.
- The engine is not a sandbox: the agent has your user's file access inside the chosen workspace and beyond.
- No history replay; MCP projection is read once at start; no auto-start; POSIX only.
- Tests: `npm test` (fake agent). `ABITO_E2E_PI=1 node --test test/e2e-real.test.cjs` starts the installed pi offline (no prompt, no model call).

Attribution: structure adapted from the Gentle Dot daemon (MIT, © 2026 Gentleman Programming); see THIRD-PARTY-NOTICES.md.

## Hardening notes (switch journal, serialized selection, credential modes)

- **Switch journal**: profile activation writes `<agent>/.switch.json` (`{from, to, startedAt}`) before touching `auth.json` and deletes it after the active-account marker is persisted. If a journal survives a crash, the next `ProfileStore` start (or the next activation) compares `auth.json` with the stored credentials of `from` and `to`, repairs the marker, and never runs the refresh write-back. If it cannot decide, no account is active (fail closed).
- **Serialized selection**: `profile_select`/`role_select` run one at a time; while one is in flight the agent reports `busy` and `send`, `steer`, `new_conversation` and further selections are refused with `busy`.
- **Credential modes**: the SDK creates each account `auth.json` at 0600; after every login, enroll and logout the daemon re-asserts 0600 (file) and 0700 (account dir), refusing symlinks and foreign owners. The helper's `device-id` file is created via O_EXCL|O_NOFOLLOW temp + rename and a symlinked one is refused.

## MCP projection lifecycle

`agent/mcp.json` carries the MCP Bearer capability, so it follows `runtime/session.json`: it exists only while the daemon runs.

- Regenerated from the user's `mcpConfigPath` source on every start (empty projection when unset) and on a `mcpConfigPath` change.
- Deleted on clean stop (after the engine stops), on `process.on('exit')` and when a boot fails. Deletion only unlinks a regular, non-symlink file owned by the user.
- After `SIGKILL` it remains until the next start overwrites it (known limit; it cannot be handled).
- pi run without the daemon has no MCP proxy.
- The token at rest lives in the user's source file plus this transient projection. It is never copied into `session.json`, which only holds the island socket token.

## Agent hooks catalogue (#361)

`hooks_preview` / `hooks_install` / `hooks_remove` (island-agent/1) manage the Abito island hooks of
claude-code, codex, recap and statusline (delegated to the AgentsManager) plus gemini-cli, copilot-cli, opencode, amp and cursor
(`src/agent-hooks.cjs`, self-owned marker-tagged artifacts, notify-only). Preview is read-only; install and
remove require the exact `plan_hash` shown, back everything up first and refuse foreign or unsafe targets.
Frames, invariants, sources and UNVERIFIED items: [`../../tests/PROTOCOL.md`](../../tests/PROTOCOL.md).
