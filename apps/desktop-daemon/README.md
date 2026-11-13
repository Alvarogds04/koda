# Abito desktop daemon — island agent engine (U1)

The island chat is a full agent, not a direct model call: this package supervises the
installed `pi` running `--mode rpc` as a child process inside a private island, with an
Abito identity, isolated environment, session privacy, request correlation, crash
restart with bounded backoff, and clean stops. Plain Node CJS: one runtime
dependency (`@mtcute/node`, the Telegram client library, K2-13), and it ships inside
the bundled runtime folder, never from this package (see «The Telegram client
library» below).

Status: U1–U4 implemented (runtime, profiles, island transport, config/CLI/daemon). The installed `pi` on this machine is the default
runtime and was smoke-verified offline (`start` → `get_state` → `stop` against the
real binary in a temp island); tests themselves still use a fake agent so they never
depend on an install or a provider.

## App-owned startup

The Linux Tauri app starts this host as its direct child with
`node src/cli.cjs run --app-owned`. The flag adds a stdin lifetime lease: EOF
requests shutdown, including EOF received during startup. Plain `run` retains its
foreground SIGINT/SIGTERM behavior; `status`, `stop` and config commands are unchanged.
Like Gentle Dot's `close()` (`daemon.ts:410-458`), EOF, SIGINT/SIGTERM and `stop` act at
once even while the engine is still starting: the server closes and `session.json` is
withdrawn immediately, never after that first start settles, and the starting engine is
asked to stop at once (its stdin closed). The PROCESS exits when that starting engine
answers or the stop timers fire (`stopTimeoutMs`, 5 s → SIGTERM, two seconds later →
SIGKILL), so a real engine still loading can keep the process alive for a few seconds after
`session.json` is already gone — the same shape as Gentle Dot's `close()`.

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

Everything private lives under one root: `~/.koda` by default, moved with
`KODA_ISLAND_DIR` (tests and embeddings use this). Created with mode `0700`, owned by
the current user:

| Path | Purpose |
|---|---|
| `<root>/home/` | The engine's private `HOME`, with the XDG tree (`.config`, `.cache`, `.local/share`, `.local/state`) under it; `<root>/home/.engram/` holds the private memory store |
| `<root>/agent/` | The installed pi's agent directory (`PI_CODING_AGENT_DIR`); no user Pi settings, extensions or auth are reused |
| `<root>/sessions/` | Private RPC sessions (`--session-dir` is always passed explicitly) |
| `<root>/workspace/` | The engine's owned default workspace; its `.engram/config.json` pins the memory project `koda` |
| `<root>/uploads-staging/` | K2-05: chat attachments the user has uploaded but not yet sent, written by the DAEMON (`src/uploads.cjs`; 0700 dir per id, 0600 files, generated ids), outside the engine's workspace |
| `<root>/workspace/uploads/` | K2-05: attachments of an ACCEPTED send, moved here from `uploads-staging` by the daemon (the Tauri app never writes uploads) — the agent reads them as workspace files |
| `<root>/tmp/` | Private `TMPDIR` |
| `<root>/identity.md` | The Abito identity file, regenerated from `identity.md` (mode `0600`) before every spawn |
| `<root>/state.json` | The open session file, persisted for continuity across crash restarts (mode `0600`) |
| `<root>/config.json` | User config (U4, section below; mode `0600`) |
| `<root>/runtime/` | `session.json` host handoff (published once the server listens, before the engine is ready: K2-05 boot order), the `p-XXXXXX/s` socket (U4), the `launches.jsonl` ledger (#390) and the `interrupted.json` record (#385) |

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
- `KODA_MEMORY_PROJECT=koda` — the memory project pin
- `ENGRAM_PORT` → Koda's private memory port (`7439`; `KODA_ENGRAM_PORT` in the parent env
  overrides it for tests/embeddings), `ENGRAM_BIN` → the pinned Engram binary the bundled
  runtime ships, `ENGRAM_NO_UPDATE_CHECK=1` — the private memory never phones home. The
  parent's `ENGRAM_URL`, `ENGRAM_DATA_DIR` and `ENGRAM_PORT` are never inherited: Koda's
  memory is ALWAYS private (no user-store mode), so the user's own Engram server and store
  (`7437`/`7438`, `~/.engram`) are never read, probed or written

The user's git identity is the only piece of the real home that crosses the boundary.

## API (for U2/U3)

```js
const { AgentEngine } = require("@abito/desktop-daemon/runtime.cjs");

const engine = new AgentEngine({
  command: "pi",              // configurable executable; never a direct model HTTP client
  root: "~/.koda",    // island root
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
  Idle abort still reaches Pi, and the island's conversation reset stays refused
  outright (`conversations_off`) — busy or not.
- **Session reset/switch admission**: `new_session`/`switch_session` acquire a
  single-flight busy gate before writing. The socket's `new_conversation` is refused
  outright (`conversations_off`, one continuous chat) before every gate and never
  awaits Pi, so send/profile/workspace/config changes keep their
  existing busy rejection without writes, queues or replay. Ordinary `get_state`
  reads remain available. A successful ACK is followed by an owned-session
  identity check through `get_state` before the gate is released. Timeout, lost
  ACK, failed response or child failure never prove the reset was unapplied:
  admission stays closed while the owned child is cut off and a replacement
  reopens the last verified session. The reset is never automatically retried.
  Stop/generation changes invalidate stale reset continuations. Cancelled/reset
  recovery reopens the session saved in `state.json` exactly like a boot (there is
  no separate «recovery» session, Gentle Dot keeps none): a replacement that merely
  ACKs reopening but reports another identity stays busy/unavailable, never ready;
  a saved session whose file the engine never wrote is skipped (K2-05 F1, below).
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
  repeating; reset after 30s of stable uptime). K2-05 boot order (Gentle Dot
  `supervisor.ts` start + `daemon.ts:477-481`): a first `start()` whose spawned child
  never becomes ready rejects to the caller (the daemon logs `agent failed to start: …;
  retrying`) AND the restart policy keeps retrying with the same backoff; only a spawn
  that could not even be prepared (the private identity file refused) stays `stopped`. One
  initialization owns startup failure and one restart timer owns the next attempt;
  startup close never independently schedules a duplicate retry. No live child
  can be overwritten by another spawn. Stop awaits the owned initialization and
  clears its pending restart timer, without changing the backoff policy.
- **Session continuity**: the open session file from `get_state` is persisted to
  `<root>/state.json` on every spawn; after a crash restart, a persisted path is
  reopened with `switch_session` only when it is inside the island sessions dir,
  a regular non-symlink file owned by the current user. Anything else is ignored.
  K2-05 (L44, L51): the reopen of the saved conversation, at boot, after a crash and after
  a cut-off turn or reset, is Gentle Dot's (`supervisor.ts:311-330` `spawnAndInitialize`):
  `get_state`; when the saved file differs from the engine's boot session AND exists
  (Gentle Dot's `existsSync(wanted)`; here the owned-file rule above), `switch_session` to
  it; then `get_state` again,
  and only that answer is adopted and written to `state.json`. ANY error kills the child
  (no late switch can land), `state.json` is left as it was, and the restart backoff
  spawns a fresh child that tries again, with no attempt limit, until one reopens the
  saved conversation or `stop()` is called. No other session is ever adopted while the
  saved file is there, so a restart before the first message cannot lose it. A saved
  session whose file does not exist is skipped, never waited for (K2-05 F1: with no
  account the engine refuses the first prompt and never writes its session file; before,
  every replacement refused to start with «agent recovery session is unavailable» and
  the engine stayed not ready until the app restarted). At boot, a
  failed reopen rejects `start()` like any first-start failure and the same retry runs
  (Gentle Dot's daemon logs it and keeps serving). Two deviations: the boot reopen's `switch_session` gets the rotation
  switch's budget (`requestTimeoutMs`, default 300 s) instead of Gentle Dot's 30 s,
  because Windows CI 43025727185 showed the real engine's switch can take longer there;
  and a switch the engine ACKs without applying is an error (Gentle Dot's `refreshSession`
  would adopt the other session and overwrite the saved pointer).
- **Known gap shared with Gentle Dot (K2-05 F2, kept for parity)**: a rotation that falls
  back to `new_session` saves the fresh session and its chain in `state.json`, but the
  engine writes that session's file only with its first message. A restart right after
  the fallback, before the next message, finds no file to reopen, boots an empty session
  and loses the chain link to the earlier conversation (its files stay on disk). Gentle
  Dot (`rotation.ts:212-214`) has the same window.
- **Stop**: `stop()` ends stdin, then SIGTERM after `stopTimeoutMs`, then SIGKILL; it
  disables restarts, clears turn/deadline/grace timers, and later requests reject with `engine is not ready`.
- **Spawn args**: `--mode rpc --session-dir <island sessions> --append-system-prompt
  <island identity.md>` (plus configurable command/extra args).

## Memory

Koda's memory is ALWAYS private — Gentle Dot's private mode is the only mode (K2-05 T1c,
human decision L11: «esto sería un engram propio que tuviera aparte del que tenemos aquí»):

- **Store**: inside the island. The engine's `HOME` is `<island>/home` and the child env
  sets no `ENGRAM_DATA_DIR`, so Engram defaults its store to `<island>/home/.engram` —
  exactly where Gentle Dot's private mode puts it. The user's own `~/.engram` is never
  read or written.
- **Server**: on Koda's OWN port `7439` (one above Gentle Dot's private port `7438`, which
  is itself one above Engram's default `7437` — no collision with the user's servers).
  `KODA_ENGRAM_PORT` overrides it for tests/embeddings.
- **Binary**: only the pinned Engram binary the bundled runtime ships (`engramBin` in
  `koda-runtime.json`). The former user-binary resolution order (a parent `ENGRAM_BIN`,
  the login shell, the known install dirs) is gone.
- **Project**: `koda` (the owned workspace's `.engram/config.json` and the
  `KODA_MEMORY_PROJECT` + identity pin, unchanged).
- **Lifecycle**: the daemon confirms the private port is EMPTY before the engine spawns and
  owns cleanup only then — a pre-existing listener is never claimed, an unknown port state
  refuses ownership (logged, engine still starts), and on daemon stop the listener is
  verified to be Koda's own (the island's `.instance-id` + `GET /health`) with a stable PID
  before any SIGTERM. A server that is not Koda's is never touched.
- **Not migrated**: memories saved by Koda 0.1 in the user's own Engram stay there and are
  NOT migrated into the island store (human decision L11). The island memory starts empty.

The owned default workspace carries `.engram/config.json` with
`project_name: "koda"`, and the child env pins `KODA_MEMORY_PROJECT`. A
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
  The SDK is resolved via the `sdkModule` option / `KODA_SDK_MODULE`; the user's
  Pi credentials are never imported.
- `src/profiles.cjs` — `ProfileStore`: role profiles `{id,label,role,accountId,provider,modelId,thinkingLevel}`.
  `select` copies one credential into the owned `agent/auth.json` (0600), restarts
  the engine, then `set_model`/`set_thinking_level`; refused while busy; any
  failure restores all files and restarts a running engine so memory matches disk. Nothing is activated implicitly.
- DTOs expose no key, token, header, `baseUrl` or env; errors are generic.
- `ProfileStore.deactivate()` undoes an activation (same lock, journal, busy guard and rollback; the refreshed credential is saved back first). With no active profile it does nothing.
- Provider settings over the wire (v0.2): `account_create|remove|logout|status`, `profile_save|remove|deactivate` and `auth_state`; schemas and the setup sequence are in [docs/PROTOCOL.md](docs/PROTOCOL.md).
- Local models (v0.2): `local_account_create` / `local_endpoint_set` connect Ollama, LM Studio, llama.cpp or vLLM as an account with no secret on the wire. Loopback only (`localhost`, `127.0.0.0/8`, `[::1]`) with an explicit path such as `http://127.0.0.1:11434/v1`; remote endpoints are intentionally unsupported. The hostname `localhost` is resolved by the Pi client at request time (it trusts the host resolver); `127.0.0.1` or `[::1]` is recommended; plain http means traffic never leaves the machine. `local_endpoint_set` also re-enables a logged-out local account. The endpoint stays in the account's private `models.json` (0600) and a fixed non-secret placeholder key; see [docs/PROTOCOL.md](docs/PROTOCOL.md).
- Global pause (#379): the closed `set_paused{paused}` verb stops all admission — no new agent turns (`send`/`steer` refused with `error{paused}`; the island's `new_conversation` stays refused with `conversations_off` before every gate, pause included), no process-spawning tool/connector calls (`agent_connect`, `connectors_list`, `agents_list` refused); `abort` and `agent_disconnect` (stopping work) and every read-only verb stay allowed. Pausing while a turn runs interrupts it through the engine's cancellation path (#378): a sanitized toast explains the pause, the child is recycled, the session reopens and no prompt is replayed. The switch is persisted as the strict boolean `paused` key in `config.json` and restored at the next boot; `ready.state`, `agent_state` and `status` carry it. Details in [docs/PROTOCOL.md](docs/PROTOCOL.md).
- Live interruption (#378): when the user's access for the running agent is revoked (`account_logout` of the account backing the active profile) or the pause turns on, the in-flight turn yields at the next safe point with a fixed, engine-text-free closed event; the logout is applied only after the safe point (bounded wait; on timeout it answers `busy` and the credential is untouched). Details in [docs/PROTOCOL.md](docs/PROTOCOL.md).
- Custom gateway provider (HU-041): `custom_account_create {label, baseUrl, accountId?}`, `custom_endpoint_set {accountId, baseUrl}` and `custom_models_refresh {accountId}` configure a LiteLLM / OpenAI-compatible gateway (for example `https://gateway.example/v1`). Each replies `account` (DTO adds `custom: true`; the Base URL is never on the wire) and broadcasts `accounts`. Base URL: `https` or `http` only for a literal loopback address (`127.0.0.0/8`, `[::1]`), no userinfo/query/fragment/escapes. The API key goes through the existing `auth_start {method:"api_key"}` / `auth_reply` (masked transient input) into the account's private `auth.json`; there is no second store. `custom_models_refresh` (and `custom_endpoint_set` while signed in) do one bounded `GET <baseUrl>/models` with the bearer key: no redirects followed (any 3xx fails, same-origin too), 10 s, 256 KiB, 128 models, 200-char ids; failures are `error{failed}` and keep the previous `models.json`. While a key is stored the host cannot be changed (sign out first). No automatic fallback, model start or switch. Control characters (including TAB, DEL and CR/LF) in a custom provider's API key are refused up front, before any side effect (the prompt stays open for a retry). `profile_save` / `profile_select` / `role_select` work for a custom account like any other once models have been discovered and the model is one of them; otherwise activation is refused and no file is touched.

  **Guarded Pi transport (T6a-2).** Pi's `models.json` cannot give a provider a per-call `fetch`, and the SDK's default one follows redirects, so activating a custom profile installs, through the same journaled activation/rollback as the credential, ONE fixed versioned extension (`<agent>/extensions/abito-custom-provider.js`, byte-identical `TEMPLATE` from `src/custom-provider-extension.cjs`, no user data in code) plus validated runtime data (`<agent>/custom-provider.json`, 0600: provider id, Base URL, model ids — never the key, which Pi resolves from the private `auth.json`). The extension re-validates that data, registers only that provider and delegates to the SDK's own `openai-completions` stream with a guarded `fetch`: scheme+host+port+path pinned to the configured Base URL (`POST …/chat/completions`, `GET …/models` only), HTTPS or literal-loopback HTTP, `redirect:"manual"`, every 3xx refused (same-origin included, body cancelled, nothing followed or retried), bounded header wait/idle time and response bytes (inference limits, named once in the template's `LIMITS`: **300 s** to the first response header, **300 s** idle between stream chunks, **64 MiB** response cap — generous on purpose because local/self-hosted models can be slow to load and to think, so a stalled gateway is given up on after 5 minutes; user/Pi cancellation aborts the in-flight request immediately and does not wait for these; model discovery is a separate, stricter policy: **10 s**, **256 KiB**, 128 models), and errors reduced to fixed key-free phrases. The account's `models.json` entry is never projected for a custom provider (it would use the unguarded transport); selecting any other profile or deactivating removes the extension and runtime data, and a failed activation restores them exactly. No global preload/fetch wrapper is used and other providers are unaffected. Key storage: `auth.json` is 0600 in a 0700 directory on POSIX; the daemon's Windows owner-only ACL coverage for these files has not been verified, so no Windows guarantee is claimed.


## Island protocol (U3)

`src/server.cjs` exports `IslandServer` (local 0600 Unix socket in a 0700 dir, token handshake,
bounded JSONL) and `src/protocol.cjs` the pure codec/translation. Wire format, frame table and
limits: [docs/PROTOCOL.md](docs/PROTOCOL.md). The client cap is 4 (settings window + chat + one
reconnect overlap + the daemon's own health probe): it counts clients that completed their
handshake and is enforced when a connection's own `hello` is validated — never at connect time —
so `abito-island-daemon status` still classifies the daemon healthy while the settings window and
the chat are both connected. No outbound line ever carries a lone UTF-16 surrogate (replaced with
U+FFFD by the single outbound encoder), and every chunk/clip of outbound text cuts on whole code
points; a history message whose text was clipped carries `clipped: true`. History is served by `get_history` and `get_earlier` (see docs/PROTOCOL.md, History frames); the CLI is in the U4 section.

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
| `hookInstallerBin` | absolute path | ABSOLUTE normalized path of `apps/desktop-harness/bin/koda-hook.cjs` (no default): enables `agent_connect`/`agent_disconnect`. Unset → every agent `unavailable`, nothing executes. Checked before every spawn: regular non-symlink file owned by you/root, not group/world-writable (a 664 checkout is refused), secure parents. Invalid → `invalid config: hookInstallerBin` |
| `connectorHostBin` | absolute path | ABSOLUTE normalized path of the `abito-connector-host` binary (no default; read at daemon start, changes require daemon restart). Unset → no supervisor is created and nothing executes. **Stricter than `connectorsCommand` and `hookInstallerBin`:** the configured path itself must be a regular, non-symlink executable (a symlinked install must configure the real path), owned by you or root, with no group/world-write or setuid/setgid/sticky bits. Every parent directory up to `/` must be a non-symlink owned by you or root and not group/world-writable; root-owned sticky world-writable ancestors such as `/tmp` may be traversed, but the binary's own directory must not be writable by group/world. The exact checked path is executed and rechecked immediately before every spawn. Invalid → `invalid config: connectorHostBin` |
| `hotkey` | string | Global show/hide combo, stored only (the X11 capture lives elsewhere). Grammar: 1+ distinct modifiers `Ctrl`/`Alt`/`Shift`/`Super` joined by `+`, then ONE key: ASCII letter/digit, `F1`–`F24`, or `Space Enter Tab Escape Backspace Delete Insert Home End PageUp PageDown Up Down Left Right`. Case-insensitive input, canonical `Ctrl+Alt+Shift+Super+<Key>`; bare key, duplicates, whitespace/control/non-ASCII, > 40 chars are rejected as `invalid config: hotkey`. Changing it never restarts the engine; `config get` prints `null` when unset; `status` includes it. An invalid `hotkey` already on disk (hand edit) is inert: it is ignored on read paths (`run`, `config get`, `set-workspace` keep working; `status.hotkeyInvalid: true`, `config get` prints `hotkey: invalid (ignored)` on stderr, never the value) and is dropped on the next `set-workspace`/`set-hotkey` rewrite. Writes stay strict |
| `paused` | boolean | Global pause switch (#379), written only by the `set_paused` protocol verb (no CLI key): strict boolean, `false` removes the key; a hand-edited non-boolean is `invalid config: paused`. Restored at the next daemon boot; `status.paused` reflects the live state |

**Connectors (`connectors_list`).** Additive, read-only: the daemon runs the connectors CLI (5 s timeout, 256 KiB cap, private HOME, no `PI_*`/provider keys, no retries), revalidates its output against an allowlist and replies a sanitized `connectors` frame (see `docs/PROTOCOL.md`). The data are the PERSISTED `connectors.json` values, not live: no pending approvals or mutation actions are carried by this frame. Live control is separate (H2c below). DTOs never contain a connector secret or capability. `status.connectorsAvailable` is true only when a connectors view is actually wired (a valid `connectorsCommand` is configured). One snapshot spawns TWO processes (`catalog` + `status`), each in its own process group killed whole on timeout/oversize/failure; the 1 s minimum interval is per snapshot. The child gets a fixed `PATH=/usr/bin:/bin`. The daemon emits at most 128 connectors / 32 catalog entries and a frame of at most 200 KiB, otherwise `failed` (never truncated). Both keys are read at daemon start.

**Agent hooks (`agents_list`, `agent_connect`, `agent_disconnect`).** Additive (see `docs/PROTOCOL.md`, "Agents frames"): the island connects/disconnects the Claude Code and Codex hooks and the Claude status-line relay (`statusline`, «Uso del plan (relay)») with a button; `recap` is no longer an agent id and is refused like any unknown id. The status-line relay preserves and prints an existing status line, uses `~/.claude/settings.json`, backs up first, removes by marker only and requires a shown plan hash. The status-line installer also saves/restores `~/.abito/statusline-previous.json` (0600), as in its interactive flow. `src/agents.cjs` drives the harness installer (`install <claude|codex|statusline> --user ... --json`, then `--apply-plan <hash> --audit-dir <island>/audit`) as a subprocess with an allowlisted env (`PATH`, the REAL `HOME`, `LANG`, `KODA_ISLAND_EXE` = the daemon's node: installer guard (i) becomes "the parent is the daemon's node"), 10 s group-killed timeout, 256 KiB stdout cap, stderr never surfaced. One operation at a time globally (`busy`), `agents_list` cached 1 s. The `plan_hash` the island showed is the only plan that can be applied (otherwise `plan_changed`, nothing written). `status.agentsAvailable` is true when `hookInstallerBin` is configured.

**Legacy Recap cleanup (K2-03).** Recap (the weekly summary) was removed in 0.2. At every start the daemon calls `removeLegacyRecap()` (`src/agents.cjs`, off the boot path, not awaited): it previews the removal-only installer profile `install recap --user --remove` (`apps/desktop-harness/src/install-recap.cjs`) and applies it only when something would be removed — dated backup first, marker-only removal, audited. It logs fixed strings only; a refusal writes nothing and is retried next start. TODO: remove one version after K2-03.

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

An explicit `KODA_DESKTOP_SOCKET` wins after endpoint-shape validation and means `endpoint.json` is not read. Otherwise runtime selection is ordered: `KODA_SOCKET_DIR` (if set, it must be absolute, normalized and non-root), else `$XDG_RUNTIME_DIR/koda` only when `XDG_RUNTIME_DIR` is absolute, normalized and non-root, else `/run/user/<uid>/koda`.

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
| `KODA_ISLAND_DIR` | island root (default `~/.koda`) |
| `KODA_WORKSPACE` | overrides `workspace` from the file; validated identically (analogue of `GENTLE_DOT_WORKSPACE`) |
| `KODA_MEMORY_PROJECT` | set by the engine to `koda` for the child; with the identity prompt it is the memory pin |
| `KODA_SDK_MODULE` | SDK entry for the auth helper (U2) |
| `KODA_E2E_PI=1` | enables `test/e2e-real.test.cjs` |

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
`KODA_WORKSPACE` is set it wins: the file is still updated but nothing restarts
(`overriddenByEnv: true`).

### Memory pin for arbitrary workspaces

The daemon **never writes `.engram` into your folder**. The pin is `KODA_MEMORY_PROJECT`
+ the identity prompt. It does detect (read-only) a conflicting
`<workspace>/.engram/config.json` whose `project_name` is not `koda` and
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
at the next daemon start or on SIGHUP (see above: the projection is rewritten and the engine restarts).
Pi still decides exposure (default `codemode`).

**Window-capture server (K2-06).** Independently of `mcpConfigPath`, when the environment carries
`KODA_WINDOW_MCP_URL` and `KODA_WINDOW_MCP_TOKEN` (set by the Tauri app for its own child: a loopback
`http` endpoint and a per-launch bearer token) the projection also holds one server with id `computer`,
validated like any other entry; with only one of the two variables, or an unsafe value, nothing is
projected and one fixed log line says so (never the token). The daemon installs
`<root>/agent/extensions/koda-window-capture.js` (a fixed template: only the last screenshot stays an
image; the tool is blocked before any capture when the model has no image input). Details:
`docs/desktop/window-capture.md`.

### Security notes and known limits

- Island, runtime dir and socket dir are 0700, socket and files 0600; per-launch token.
- `session.json` is a bearer secret for the local user only; keep the island on a local, private disk.
- `abito-island-daemon stop`/`status` rely on `/proc` (start time, uid, cmdline) to confirm the daemon; without `/proc` they fail closed and refuse to signal.
- MCP source entries are written as the WHATWG-normalized URL; server ids `__proto__`, `constructor`, `prototype` are rejected.
- `config.json` reads apply the same secure-path checks as writes (a symlinked island directory is refused).
- A workspace validated at start can be swapped for a symlink later (TOCTOU between validation and spawn); the engine runs as you, with your permissions, in that folder.
- The engine is not a sandbox: the agent has your user's file access inside the chosen workspace and beyond.
- History is replayed by paging (`get_history` / `get_earlier`, see PROTOCOL.md); the MCP projection is rewritten on SIGHUP when `mcpConfigPath` changes; no auto-start; POSIX only.
- Tests: `npm test` (fake agent). `KODA_E2E_PI=1 node --test test/e2e-real.test.cjs` starts the installed pi offline (no prompt, no model call).

Attribution: structure adapted from the Gentle Dot daemon (MIT, © 2026 Gentleman Programming); see THIRD-PARTY-NOTICES.md.

## Hardening notes (switch journal, serialized selection, credential modes)

- **Switch journal**: profile activation writes `<agent>/.switch.json` (`{from, to, startedAt}`) before touching `auth.json` and deletes it after the active-account marker is persisted. If a journal survives a crash, the next `ProfileStore` start (or the next activation) compares `auth.json` with the stored credentials of `from` and `to`, repairs the marker, and never runs the refresh write-back. If it cannot decide, no account is active (fail closed).
- **Serialized selection**: `profile_select`/`role_select` run one at a time; while one is in flight the agent reports `busy` and `send`, `steer` and further selections are refused with `busy` (the island's `new_conversation` stays refused with `conversations_off`, as always).
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
claude-code, codex and statusline (delegated to the AgentsManager) plus gemini-cli, copilot-cli, opencode, amp and cursor
(`src/agent-hooks.cjs`, self-owned marker-tagged artifacts, notify-only). Preview is read-only; install and
remove require the exact `plan_hash` shown, back everything up first and refuse foreign or unsafe targets. K2-04
(S2/S4): the Koda 0.1 artifacts (`abito-island-hooks/1`, `abito-island*` names) are recognised as ours, retired into the
same backup flow on install and removed on remove, so each client keeps exactly one artifact and one card per notice.
Frames, invariants, sources and UNVERIFIED items: [`../../tests/PROTOCOL.md`](../../tests/PROTOCOL.md).

## The Telegram client library (K2-13)

Reading Telegram channels with the user's own account (S6) needs a client library: **`@mtcute/node` 0.32.8**, pinned
exactly here (with every `@mtcute/*` package it pulls frozen by `overrides`) and pinned to the same version in
`../desktop-tauri/packaging/runtime/package.json`. Evidence and the library comparison: `odd/evidence/k2-13-spike/`.

**Nothing ships from this package.** The bytes travel inside the bundled runtime folder Koda already installs and
verifies (`S6`; decided by the human, K2-13 L41), because that is the one npm tree every installer verifies, extracts and
writes licence notices for:

- installed: `<runtime>/node_modules/@mtcute/node` (`<prefix>/runtime`, `Contents/Resources/runtime` on macOS);
- development: `npm ci` in this package (no install scripts needed) puts it in `node_modules/`, and ordinary Node
  resolution finds it — `npm test` never needs it, because the tests inject a fake client.

The Telegram module resolves the library in that order: beside the Node the daemon runs on (`<folder>/node_modules`),
then beside its own package (`../runtime/node_modules`), then by ordinary Node resolution; if none of them has it, the
Telegram frames answer `unavailable` instead of crashing the daemon.

**No native addon.** mtcute's `better-sqlite3` is replaced by Koda's empty stub
(`../desktop-tauri/packaging/runtime/stubs/better-sqlite3`, wired as a `file:` dependency in both `package.json` files,
exactly as `overrides` cannot express in npm 9). The daemon always passes `MemoryStorage`, so the `SqliteStorage` that
would load the addon is never constructed; the stub throws if it ever is, and mtcute's crypto is WASM. The build fails
if a `.node` file appears under `@mtcute`, `@fuman` or `better-sqlite3`
(`packaging/runtime/build-runtime.cjs` `assertNoNativeAddons`), and `apps/desktop-tauri/test-node/telegram-deps-check.cjs`
keeps both pins, the stub and the licences in step.

### Login and the session (S10, S20)

`src/minikodas/telegram.cjs` is the daemon's one Telegram client. The login happens in Ajustes over the island protocol
(`docs/PROTOCOL.md`, «Telegram frames»): `telegram_login_start{apiId, apiHash, phone}` asks Telegram for a code,
`telegram_login_code{code}` delivers it, and `telegram_login_password{password}` answers a two-step login. Every answer is
a frame; nothing is read from a terminal, and a refused code or password leaves the login where it was so the person can
try again.

**The session is a credential and never touches the disk.** The client is always built with mtcute's `MemoryStorage`
(the wrapper refuses a caller-supplied storage, and a test proves that no `client.session` — mtcute's own default — or
sqlite file can appear in the working directory or `HOME`). When a login finishes, or when restoring rotates the session,
the daemon replies `telegram_session{session}` to the connection that asked, and only to that connection: the island
stores it in the OS keychain and hands it back at start with `telegram_session_restore{apiId, apiHash, session}`. An
unchanged session is never echoed back.

`apiHash`, the phone, the code, the password and the session never appear in a log line, a broadcast, «Hoy» or an error.
Failures are closed codes with a fixed Spanish sentence (`telegram_flood_wait` carries `retryAfterMinutes`, e.g.
«Telegram pidió esperar 4 minutos»); Telegram's own text is never forwarded because it can echo the phone number. A
revoked session answers `telegram_session_invalid` and disconnects instead of pretending to be connected. The global
pause refuses the login frames (they change the account's state) but keeps answering status, the start-up restore and
`telegram_logout`: revoking a session is an account-safety action, like `agent_disconnect`. A login belongs to the
connection that started it, so another window can neither answer its code nor replace the flow
(`telegram_login_other_connection`). The library's own logging is passed level 0 (OFF) explicitly, so a
`MTCUTE_LOG_LEVEL` in the environment can never make mtcute print phone numbers, codes or payloads to the daemon's
stdio; a display name longer than the frame's 80 chars is clipped where the account is stored.

**Island contract.** The island must store the session in the keychain, must never write it to a file, must never echo it
back inside another frame, and after `telegram_logout` must delete its keychain entry (the daemon already revoked the auth
key on Telegram when it could reach it).

## Minikodas (K2-13)

A Minikoda is a small helper that runs a recipe on its own. Code: `src/minikodas/`.

**Recipe** (`recipe.cjs`, strict validation; anything unknown or out of range is refused, never repaired):
`{id, name, when, reads, kit, prompt, model, never}`.
- `when`: exactly one of `{manual: true}`, `{everyMs}` (≥ 60 s) or `{at: ISO date}` (future, ≤ 1 year).
- `reads`: `{source}`, a descriptor. Before each run the daemon prepares the source's content and hands it to the Minikoda only through `source_read`. A plain-text descriptor reads `<island>/minikodas/sources/<id>.txt`; `telegram:@canal` (or `telegram:t.me/canal`) reads that public Telegram channel with the user's own account (see «A Telegram channel as the source»). The descriptor is validated **when the Minikoda is created**: a channel typed without the prefix (`@canal`, `t.me/canal`) is refused there with a Spanish sentence («para leer un canal de Telegram hace falta el prefijo «telegram:»») instead of being stored as a text file name and read as empty on every run, and so is a malformed `telegram:` value.
- `kit`: names from the closed catalogue `source_read`, `inbox_propose`.
- `prompt`: the Minikoda's specialised prompt. It is appended after Koda's fixed base rules.
- `model`: `{provider, id, accountId}`. It must come from an account Koda already has (`accounts/`): the account must exist, be signed in, serve that provider and offer that model. A provider served by two accounts needs `accountId`. Without a choice, the model is the chat's current model (the active profile).
- `never`: must be exactly `buy, sell, send, delete`.

### A Telegram channel as the source (S6)

`reads.source` is `telegram:@canal` (also accepted: `telegram:canal`, `telegram:t.me/canal`, `telegram:https://t.me/canal`).
Anything else after `telegram:` is refused **when the Minikoda is created** (`recipe.cjs` asks `telegram-source.cjs` for the
grammar), so a typo never becomes a text source read as empty at run time; a channel typed without the prefix is refused
there too. Implementation: `src/minikodas/telegram-source.cjs`.

- **Read by its `@username`, and almost nothing is cached.** Each run asks for the channel by its username
  (`getHistory("@canal")`): mtcute resolves it once per client and caches the result in its own storage, so
  `contacts.resolveUsername` is spent once per daemon lifetime, not once per run. The Minikoda's private state
  `<island>/minikodas/telegram/<id>.json` (0600) holds only `{version: 2, channel, lastSeenId}`. It deliberately does
  **not** cache the `accessHash`: JSON has no 64-bit integer and mtcute's TL writer reads `.low`/`.high`, so a hash
  stored as a string would reach Telegram as access hash 0 and every later run would have to re-resolve the channel
  after `CHANNEL_INVALID` (`telegram-source.test.cjs` pins this with the library's own writer). A username mtcute cached
  before the channel changed hands is resolved again, once.
- **Only what is new.** Each run asks for posts newer than the stored `lastSeenId` (`getHistory({minId})`), reading at
  most 20 posts; the first run reads the latest 5. The marker moves **only when the run succeeded** (`commit()` runs
  after the result reaches «Hoy»): a failed run reads the same posts again instead of skipping them.
- **Text.** The posts arrive oldest → newest, each as `[id] texto`, inside `Canal @canal: N publicaciones nuevas.`, capped
  at 60 000 chars. That text is what `source_read` returns; the Minikoda never sees the channel itself.
- **Media.** Video (round video notes and GIF animations included), audio and voice messages are downloaded with
  `downloadAsNodeStream` into the run's private folder `<island>/minikodas/media/<run>/` (folder 0700, files 0600) —
  but only after Telegram's own metadata says the file is **≤ 200 MB and ≤ 3 hours**; a bigger or longer one, or one
  whose size Telegram does not report, is skipped with a note in the text. Photos and documents are ignored, and
  content-protected (noforwards) media is skipped with a note. `FILE_REFERENCE_EXPIRED` refetches that one message **in
  its channel** (`getMessages("@canal", [id])`: mtcute's media objects carry no `.chat`) and retries the download once,
  never in a loop.
- **`source.media` is the contract with the transcription step.** `prepare()` resolves
  `{text, media: [{path, mimeType, durationSec, messageId, kind}], commit}`. Nothing is transcribed on this branch and
  the post text says exactly that («video de 95 s, adjunto; todavía sin transcribir»). The run's media folder is removed
  as soon as the run ends — success, engine failure, timeout or cancel (`TelegramSource.removeRun`, called by
  `service.cjs` in a `finally`) — so a video per run never accumulates in the island.
  **Merge note (`feat/k2-13-transcribe`):** the transcription step is what reconnects the two. It consumes
  `source.media`, attaches each transcript to its `messageId` and then calls the same `removeRun(runId)`; it runs while
  the folder still exists (before the `finally`). Until that merge, deleting in the `finally` is the correct end state:
  nothing reads those files after the run.
- **Failures are «Hoy» errors, never silence.** A long `FLOOD_WAIT` (mtcute absorbs ≤ 10 s), no connected account, an
  invalid channel or a revoked session fail the run with `reason: "source"` and the Spanish sentence from
  `telegram.cjs` («Telegram pidió esperar 5 minutos», «No hay ninguna cuenta de Telegram conectada»). There is no retry
  loop, and the media downloaded so far are removed.

**Store** (`service.cjs`): `<island>/minikodas/recipes.json` (0600, dir 0700). Creating a Minikoda takes two steps. `createDraft` stores a validated draft that never runs; only `approveCreate` makes it `active` and arms its schedule (S1: «solo lo crea si lo apruebo»).

**Summary of a draft** (`summary.cjs`, S1/S7): `createDraft`'s reply and `minikoda_get` of a draft carry `summary {sections: [{key, title, text}], text}`, the plain-language «qué entendió» shown before the user approves: «Cuándo corre» (a mano / cada N minutos u horas / a una hora, in UTC), «Qué lee» (the source descriptor), «Qué hace» (the task text), «Dónde te lo muestra» («Hoy»), «Qué nunca hará solo» (the `never` verbs and the fact that such an action waits for approval) and «Con qué modelo» (S7: the account's visible label plus the model id, or «el mismo del chat»). It is deterministic: built only from the validated recipe, with no model call. Every field is one plain line — Unicode format characters (bidi, zero-width), control characters and breaks are stripped — and capped in bytes (512 per section, 3600 for the block). It never carries the accountId, a credential, a path or prompt internals. Getting it activates nothing: only `approveCreate` does. Frames and caps: `docs/PROTOCOL.md` «Minikodas and «Hoy» frames».

**Runner** (`runner.cjs`): every run is a supervised `pi --mode rpc` child (`AgentEngine`) in the Minikoda's own private root, `<island>/minikodas/engines/<id>/`. That root has its own HOME, agent dir, sessions, tmp and workspace. It is never the chat engine's root and never shared between Minikodas. Before each run the chosen model is projected into that agent dir, using the same files profile activation writes for the chat: one credential, the account's `models.json` and the defaults. A custom gateway is served by the guarded custom-provider extension, passed explicitly with `-e` (the reduced profile's `-ne` turns off the auto-loaded `agent/extensions/`). Every run starts a fresh session. The copied `auth.json` is removed after every run, once the write-back below has completed, and when the copy step fails. The only exception is a copy whose write-back failed (see below): it stays in the Minikoda root until it is written back.
- **Credential copy and write-back (S11, decision «1a»; `credentials.cjs`).**
  - Copy-in: the run gets the freshest copy of the account's credential. That is the account store's, or the chat's live `agent/auth.json` when the chat's active profile uses the same account and provider and both hold OAuth tokens, the chat's expiring later (the chat refreshes there and saves back to the account only on a profile switch). An API key always comes from the account store.
  - Lifetime gate (F-B): an OAuth session is copied in only when it outlives the run timeout plus 6 minutes (5 minutes plus a 1-minute margin), so the Minikoda's engine never has to refresh it while the chat may be refreshing the same refresh token. The daemon has no refresh path of its own (the SDK helper only signs in and out), so a session closer to expiry is not copied: the run fails as `model_unavailable` and «Hoy» says «la sesión de <cuenta> vence pronto; abrí el chat para renovarla».
  - Write-back: the Minikoda's copy is untrusted (its engine could rewrite it). After the run (any outcome) it goes back to the account store and, when the chat's active profile uses that account, to the chat's live `agent/auth.json` only as a refresh of the OAuth token that was copied in. The copied-in credential must be OAuth. The account store, and the chat file when it is targeted, must hold OAuth for that provider now: an API key is never replaced and logout is never undone. The new token must expire strictly later than the copied-in one and than what each side holds now, and at most one year from now. Only `type`, `access`, `refresh`, `expires` and the fields the copied-in credential already had are written.
  - Locking: every read and write takes the same lock directories the SDK's credential store uses (`<dir>/auth.json.lock`, chat dir first, then account dir) and writes atomically (temp + rename, 0600). The chat engine re-reads `auth.json` when its revision changes, so it picks the new token up on its next request. A leftover profile-switch journal leaves the chat side alone.
  - Failed write-back (F-C): a write-back that cannot take the lock (20 s) keeps the Minikoda's copy. The kept copy is written back before that Minikoda's next run, when the daemon starts again (runs wait for it) and before a delete. While it still fails, `minikoda_delete` answers `failed` and leaves the Minikoda, its schedule and its copy in place.
  - Engine stop (F-D): a run's engine gets 20 s to exit after its stdin closes before SIGTERM (SIGKILL 2 s later), so an OAuth refresh in flight (bounded at 15 s by the SDK) can save its rotated token. The engine's turn-recycle SIGKILL (2 s after a cancelled turn) does not apply in practice: the runner calls `stop()` as soon as a turn is cancelled, which cancels the recycle. In a narrow race the engine can settle its cancelled turn before `stop()` runs; it is then killed at once. A refresh in flight at that moment, or one that outlasts the 20 s grace, is lost. The lifetime gate keeps such a refresh from starting in the first place.
- Reduced profile: `-ne -e src/minikodas/kit-extension.js --no-mcp --no-skills --no-prompt-templates --no-themes --no-context-files --tools <kit> --model <provider>/<id>`, plus `GENTLE_PI_AGENTS=0` in the child env.
- Closed kit, two layers:
  - `--tools` = kit, so the model is only shown the kit;
  - the extension's `tool_call` guard blocks any tool outside `MINIKODA_KIT`.
  - Tested: `bash` is refused and never runs, and a negative control proves the marker does appear when both layers allow it.
- The engine command is injectable (`engine: {command, commandArgs, env}`); the daemon passes the chat's own command, which in release/0.2 is Koda's bundled Gentle Shell (K2-05), so a Minikoda runs on the same engine («usamos el motor de gentle shell»). The engine keeps the same flags, `GENTLE_PI_AGENTS=0` and `--tools` = kit. The PoC measured that `-ne`/`--no-skills` do not remove Gentle's own core, and that only `--tools` keeps its tools away from the model (`odd/evidence/k2-13-poc/gentle-shell-round/`).
- Runs never overlap per Minikoda (a second launch answers `running`). At most two run at once overall, and a run whose video is still being transcribed **holds its slot**: the 2-concurrent-runs rule counts it. Every run's engine is bounded by a timeout (default 300 s) whose clock starts only when the engine starts, after any transcription (S17).
- A crash, a timeout, a start failure, an unavailable model or a cancelled run (daemon stop, delete, the global pause turning on) is a **failed run**. It lands in «Hoy» as an `error` item and in `lastRun`. It is never silent and never respawned. The proposals the kit parked before the failure are stored as pending in «Hoy» too, and the error item says so (S13: «3 si guardalo como pendiente, aunque avise al usuario que fallo»).
- Proposal `target`: one plain line. Unicode format characters (bidi overrides such as U+202E, zero-width characters) are stripped; a line break or control character is refused by the kit and discarded by the runner.
- Proposals are read only from the file the kit wrote (re-validated: buy/sell/send). The model's text is never parsed for proposals.

**Scheduler** (`scheduler.cjs`): Koda's own timer.
- `everyMs` repeats; `at` fires once and is marked `firedAt`, so a restart never fires it again; `manual` never fires by itself.
- A tick that lands while the previous run is still going is skipped, never queued.
- The global pause (#379) skips ticks and refuses launches; turning it on also cancels the Minikodas that are running (failed runs, reason `paused`).
- A one-time `at` run that is due while paused, busy or already running never comes back, so it lands in «Hoy» as an `error` item («no se hizo»). Repeating ticks just skip.

**Known limits**:
- The agent runs as the same OS user as the daemon. The kit cannot reach the «Hoy» store or the daemon token: no kit tool reads files, and those live outside the engine root. Any same-uid process can still read them, though. Running the agent as another OS user is K2-14 criterion 3.
- Left for later (verifier mwdat8g0, not implemented): `hoy_approve` is still accepted while the global pause is on.
- Tests use `test/fixtures/minikodas/fake-pi.cjs`, a fake `pi --mode rpc` that loads the real kit extension and mimics Pi's tool selection and `tool_call` blocking. The real-Pi proof of the two layers is the PoC (`odd/evidence/k2-13-poc/poc-minikodas/evidence/`).

**Video and audio posts: transcription** (K2-13 S6-S9, S15, S16, S17, S18; `transcribe.cjs`, `transcribe-setting.cjs`):
- A source may hand a run `{text, media: [files]}`. Each media file must be a regular file inside the run's own folder `<island>/minikodas/media/<runId>/`. It is transcribed, deleted, and its transcript is appended to what `source_read` returns. The media never reaches the model. The folder is removed after the run.
- **Setting** (global, `config.json` key `transcription`, frames `transcription_get`/`transcription_set`):
  - `{mode: "local-parakeet", language}`: the default. Parakeet v3 int8 on this computer, no network. The language is always fixed.
  - `{mode: "remote", language, remote: {accountId, model}}`: an OpenAI-compatible (custom gateway) account Koda already has, e.g. NaN with model `whisper`. The Base URL and the key are that account's own; the setting never holds them. `language` defaults to `es`.
  - **S18 «pues usamos solo ese modelo»: Parakeet is the only local model.** The local `local-whisper-turbo` option of the first build is gone: the validator, the `transcription` frames and Ajustes no longer offer it, and a stale frame is answered `bad_request`. A `config.json` still saying `local-whisper-turbo` is migrated to `{mode: "local-parakeet", language}` when it is read (`migrateTranscriptionSetting`), so an island written by that build keeps working; only the removed mode is migrated, every other invalid value stays a config error.
- **Tools.** Both are bundled, found at fixed paths beside the daemon package and never on PATH:
  - ffmpeg: `<install>/runtime/ffmpeg[.exe]`, a pinned LGPL build (`apps/desktop-tauri/packaging/runtime/ffmpeg.sha256`).
  - The helper: `<install>/koda-transcribe[.exe]`, the island crate's sherpa-onnx helper. It shares dictation's model store and Silero VAD (`apps/desktop-tauri/docs/dictation-build.md`).
  - Both are spawned with `shell:false` and a fixed argv. ffmpeg only opens `file:` input, in a closed list of containers (no playlists, no network) and decodes only the audio codecs those containers carry (`-codec_whitelist`: AAC, Opus, Vorbis, MP3/MP2, FLAC, ALAC, AC-3/E-AC-3 and the PCM variants; never a video or text decoder).
  - **macOS: ffmpeg is not bundled in this version** (pending for the Mac session), so every media transcription there fails with `ffmpeg_unavailable`.
- **Local path.** ffmpeg extracts 16 kHz mono 16-bit WAV, then `koda-transcribe transcribe --model … --language … <wav>` runs. Its VAD segments are capped at 25 s. A model that is not downloaded is `model_missing`; the daemon never downloads models.
- **Remote path.** The WAV is cut into ≤ 175 s mono OGG/Opus chunks (refused above 24 MB). Each chunk is POSTed to `{base}/audio/transcriptions` (`model`, `language`, `response_format=json`, bearer key). Only the JSON `.text` is read, and the chunks are joined in order. A redirect is never followed, a 401/403 is `remote_auth`, and responses are bounded.
- **Bounds.** At most 3 h of audio, **30 min per transcription** (`TRANSCRIPTION_BUDGET_MS`, one named constant shared by the local and the remote path), 180 s per remote request, and 20 media per run. Cancelling the run (pause, delete, daemon stop) kills the running ffmpeg or helper.
- **S17 «1 lo que recomiendas»: transcription has its own budget.** Those 30 min do not count toward the run's 300 s engine budget: that clock starts only once the engine starts, after the transcript is ready. When the 30 min run out, the ffmpeg/helper/remote request is killed, the temp media and the transcription's work folder are deleted by the usual cleanup, the Minikoda's engine never starts, and «Hoy» gets an `error` item that says so: «La corrida de «X» falló (transcripción: el video tardó más de 30 minutos en transcribirse; no se resumió).»
- **Cleanup.** Work files live in `<island>/minikodas/transcribe/<uuid>/` and are removed after every transcription. The media is deleted after its audio is extracted, and again in `finally`. A killed ffmpeg or helper must be gone before its folder is removed (Windows keeps it busy until the process really exits), so the runner waits for the child's `close` and the removal retries a few short times: a cleanup failure is logged and never replaces the error that ended the transcription. On `start()` the service also sweeps what a previous daemon left in `<island>/minikodas/media/` and `<island>/minikodas/transcribe/`, only inside those two folders and never through a symlink.
- **Never logged:** the key, the media path, the media content, the transcript. ffmpeg's and the helper's stderr is drained and dropped.
- **Failures** are a «Hoy» `error` item that says why (`transcripción: el modelo local no está descargado`, …). The Minikoda's engine never starts.

**YouTube links in a post** (K2-13 S19; `youtube.cjs`). «de youtube nada más» (L32) + «2a» (L33): a video link is read from YouTube itself, and only when it really is a YouTube video.
- **Which links**: `youtube.com/watch?v=`, `youtube.com/shorts/`, `youtu.be/` (`www.` and `m.` accepted), parsed strictly with `new URL` and a video id that must match `^[A-Za-z0-9_-]{11}$`. Every other site — and other YouTube shapes such as playlists, channels or `/embed` — is ignored. At most **three different videos per run**; the rest are reported in «Hoy» («leyó como mucho 3 videos de YouTube: N video(s) más del post quedaron sin leer»). A repeated link is one video.
- **Subtitles first**: `yt-dlp --skip-download --write-subs` (manual tracks) or `--write-auto-subs` (YouTube's automatic captions) `--sub-format vtt --sub-langs <lang>`, where the language is the video's own (`info.language`) and only then the setting's. The VTT is converted to plain text: no timings, no cue numbers, no inline tags, and YouTube's rolling captions are folded (the repeated line is dropped, a line that only grows the previous one replaces it).
- **Then the audio**: only when the video has no subtitles Koda could use, `-f bestaudio/best --max-filesize 200M` downloads the audio and the SAME transcription service (Parakeet by default, or the setting's remote account) transcribes it, inside the SAME 30-minute budget (S17). The metadata call runs first, so a video longer than **3 hours** is refused before anything is downloaded.
- **The text** joins the source behind a short marker: `[Video de YouTube <url> · subtítulos de YouTube]` or `[Video de YouTube <url> · transcripto]`.
- **Safety**: yt-dlp is the bundled `<install>/runtime/yt-dlp[.exe]` (never PATH, see `packaging/runtime/ytdlp.sha256`), spawned with `shell:false` and a fixed argv that carries `--ignore-config --no-playlist --no-exec --no-cache-dir --no-remote-components --socket-timeout --retries`, plus a per-call timeout. YouTube extraction needs a JavaScript runtime (only `deno` is enabled by default in yt-dlp), so the argv also carries `--js-runtimes node:<install>/runtime/node[.exe]`: Koda's own bundled Node, by absolute path — never a Node from PATH. Without it yt-dlp refuses most videos («This video is not available»), which is exactly what the real run showed. The URL is always `https://www.youtube.com/watch?v=<validated id>`: nothing from the post is ever passed through. No cookies, no browser profile, no plugins. Cancelling the run (pause, delete, daemon stop) kills the child, and the work folder `<island>/minikodas/youtube/<uuid>/` is removed in `finally` on success and on failure (and swept at `start()` like the other work folders).
- **Failures** become «Hoy» `error` items in Spanish — «el video no está disponible (es privado, fue eliminado o tiene restricciones)», «el video dura más de 3 horas», «el audio del video supera los 200 MB», «el video no tiene subtítulos ni audio que se pudiera descargar» — and the Minikoda still reads the rest of the post. A cancelled run or the 30-minute budget running out still ends it (S17), like a failing transcription.
- **macOS**: neither ffmpeg nor yt-dlp is bundled yet (pending for the Mac session), so every link answers `youtube_unavailable` and the post is read without the video.
- **Update the pin often.** YouTube breaks yt-dlp regularly, so a release that stops extracting is expected: refresh `packaging/runtime/ytdlp.sha256` (tag, both sha256 from the release `SHA2-256SUMS`, and the two licence texts) and regenerate the runtime, instead of shipping a binary that no longer works. The licence situation — yt-dlp is Unlicense, but its official standalone builds also carry GNU Readline (GPL-3.0-or-later) and mutagen (GPL-2.0-or-later) — and the source-access record are in the root `THIRD-PARTY-NOTICES.md`.

**«Hoy» and approve-later** (`hoy.cjs`, frames in `docs/PROTOCOL.md` «Minikodas and «Hoy» frames»):
- `<island>/minikodas/hoy/hoy.jsonl` holds every item `{id, minikoda, kind: result|proposal|error, text, action?, target?, status: pending|approved|rejected, createdAt}`. The list is built from this file only, never from the model's text.
- A proposal executes only on `hoy_approve {id}`. In K2-13 «execute» means: mark the item `approved`, append one line to `approved.jsonl` and broadcast `hoy_approved`. **There is no real buy, sell or send integration yet.**
- No PIN (human decision L17): `hoy_approve {id}` approves. Approvals run one at a time, so a proposal executes exactly once even when two approvals arrive together (a second approve is refused with `not_pending`). The decision is persisted before the execution record. Reject never executes.
- Same-uid limit: any process of the user that holds the session token (`runtime/session.json`, readable by every same-uid process) can approve a proposal. A separate OS user for the agent is K2-14 criterion 3.
