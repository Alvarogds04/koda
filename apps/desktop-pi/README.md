# Ask a human through the local Abito island

This directory is the **Pi-side producer**, not a desktop app. The explicit `abito_ask` tool sends a typed question to an opted-in local receiver and awaits the human's answer as its tool result. Tool permissions, provider consent and ordinary chat are **not intercepted or replaced**. Pi's own ask tools (`ask_user_choice`, and `ask_user_question` with exactly one single-select question) are answerable from Abito too: see *Answering Pi's native ask tools from Abito* below.

**Verified layers:** offline Pi extension loading and fake-socket unit tests; the opt-in cross-integration below compiles and runs the **real Rust UDS receiver with the real Node producer**, without a GUI. **Not verified here:** rendered island/trusted UI clicks, a live model choosing the tool, or live Pi/provider turn duration. The receiver/UI belong to the `apps/desktop-tauri/` workstream, which this directory does not modify.

**Three-agent reference:** what reaches the island per question kind, where it can be answered, what happens when it is answered in the terminal, installation and timeouts for Claude Code, Codex and Pi side by side: [`docs/desktop/agent-questions.md`](../../docs/desktop/agent-questions.md). Open product decisions (the `ABITO_QUESTIONS` default, the Pi installer proposal) are in [`docs/desktop/pi-question-parity-audit.md`](../../docs/desktop/pi-question-parity-audit.md); the hook side lives in [`apps/desktop-harness/README.md`](../desktop-harness/README.md).

## Install and enable

Abito ships the closed Pi runtime beside its harness. On Linux/macOS, **Settings → Agents → Pi → Install** previews and installs it into `~/.pi/agent/extensions/abito-island/index.ts` without downloading dependencies. Restart Pi afterwards. The row reflects this extension's manifest, never a running session or the presence of Pi itself.

Only the default `~/.pi/agent` directory is supported. A Pi session using another `PI_CODING_AGENT_DIR` will not load this installation; the row always states that limitation. Windows automatic installation remains explicitly unavailable, and the terminal installer is not a workaround.

Other opt-in loading mechanisms (not managed by the Settings installer):

| How | Command / location | Useful for |
| --- | --- | --- |
| One invocation | `pi -e /abs/path/apps/desktop-pi/pi-extension.ts` | Trying it without touching any Pi setting. |
| User extensions | copy this directory to `~/.pi/agent/extensions/abito-island/` (entry `index.ts`) | Every Pi session of this user. |
| Project extensions | copy it to `<project>/.pi/extensions/abito-island/` | One repository, with Pi's project trust. |

Pi loads TypeScript directly (jiti), so no build step is needed. Only the Pi API and Node builtins are imported; there
are no npm dependencies. The managed installer uses an exact eight-file manifest, refuses foreign/modified/unlisted files and symlinks, binds the shown hash to the current and bundled bytes, and makes a directory backup before replacement/removal. It never recursively removes unrelated files. See [the installer contract](../desktop-harness/docs/PI-INSTALL.md).

Questions are ON by default (level 3): Pi's `ask_user_choice` / `ask_user_question` and `abito_ask` reach the island
with no environment variable. Set `ABITO_QUESTIONS=0` in the environment Pi runs in to keep the island notice-only.

## Quick path — a new receiver only

Use an already installed Pi; no package installation, downloads, service or keys are needed. From the repository root:

```sh
node --test apps/desktop-pi/test/*.test.cjs

# Set these to the NEW receiver's private root and the endpoint it prints.
# Do not use the installed app's root for this verification.
ABITO_SOCKET_DIR=/absolute/private/new-root \
ABITO_DESKTOP_SOCKET=/absolute/private/new-root/p-abc123/s \
ABITO_QUESTIONS=1 \
pi -e "$PWD/apps/desktop-pi/pi-extension.ts"
```

The example endpoint is a placeholder. An explicit `ABITO_DESKTOP_SOCKET` is used verbatim, and the only other source
is the **published handoff** of a running island (`<runtime>/endpoint.json`, see *Stable endpoint handoff*): this
extension never creates, chmods, unlinks or scans runtime directories, and it never hunts for a socket. Explicit `-e`
loads the extension for that Pi invocation without editing Pi settings. Do not load both this adapter and the legacy
adapter in the same session.

**Compatibility warning:** enable `ABITO_QUESTIONS=1` or `2` **only against a new QP/1 receiver at a separate root**. Against an old receiver, `questions_hello` is rejected and the shared socket closes. This interrupts **not only questions but also notices**. Conversely, the old Pi adapter destroys its connection on any byte after `ready`; a new receiver must never send `questions_ready` to an unsubscribed producer. Do not experiment against the installed app.

## Windows notice transport

On Windows, discovery uses `%LOCALAPPDATA%\\Abito\\notices\\endpoint.json`;
`ABITO_SOCKET_DIR` is a Unix-only setting. An explicit `ABITO_DESKTOP_SOCKET`
must instead name an absolute, normalized Windows `endpoint.json`, not a pipe.
No UID or `/proc` lookup is performed.

The producer launches `abito-notice-relay.exe`, never a direct Node pipe
connection. The native relay verifies the private metadata ACL and actual
server PID/SID before forwarding any protocol byte. Missing/rejected helpers
leave the island unavailable; they never imply a human answer or bypass
terminal decisions. Unix socket validation and framing are unchanged.

Helper lookup uses only the installed sibling executable, the canonical
`%LOCALAPPDATA%\\Programs\\abito-island` installation, or the fixed sibling
`desktop-tauri/target/debug` development build. It never searches PATH or CWD,
and rejects a symlink in the executable slot. An externally copied Pi extension
requires the canonical install or its own trusted sibling helper; arbitrary
custom installation directories are not discovered automatically.

## Configuration and socket ownership (Unix)

| Variable | Meaning and default |
| --- | --- |
| `ABITO_DESKTOP_SOCKET` | Optional explicit endpoint `<root>/p-XXXXXX/s`. When set it wins and `endpoint.json` is never read. Absent: the endpoint published by the running island is used (see *Stable endpoint handoff*). Absent **and** no valid handoff: no connection, no fallback, no scanning. |
| `ABITO_SOCKET_DIR` | Allowed runtime root, and the root the handoff file is read from. Default `$XDG_RUNTIME_DIR/abito-island` (falling back to `/run/user/<uid>/abito-island`): the Tauri island's own leaf, exactly where it binds. The Electron production root `abito-desktop` and the Preview root `abito-desktop-preview` are NOT defaults: set them explicitly. |
| `ABITO_QUESTIONS` | Absent: level 3 (default). `0`: notice-only. `1`: minimal QP/1. `2`: QP/1 plus negotiated native-transition busy reasons. `3`: level 2 plus the negotiated `structured` capability (multiSelect, questionnaires, larger limits; see *Structured questions*). All other values are invalid; there is no second boolean flag. Claude Code has **no** equivalent switch: its hooks always ask once installed, so `0` here is a Pi-only default and an open product decision (see the parity audit). |
| `ABITO_QUESTION_TIMEOUT_MS` | Default deadline duration `300000` ms. Integer decimal `30000..900000`; a call's `timeoutMs` overrides it within the same bounds. |
| `PI_CODING_AGENT_ROOT` | Tests only: installed Pi package directory for offline real-loader verification when the `pi` launcher cannot be found on PATH. |

Observed packaged identities are **production `com.abitog.Abito` → `abito-desktop`**, and **technical Preview `com.abitog.Abito.Preview` → `abito-desktop-preview`**, both below `/run/user/<uid>/`. These names are not interchangeable. The loader's default is the Tauri island's own leaf (`abito-island`); the two Electron roots above need an explicit `ABITO_SOCKET_DIR`. Development roots, including a receiver's `.runtime`, require an explicit override; no arbitrary endpoint is used to infer a trusted root.

Paths must be absolute and normalized: no `..`, repeated separators, trailing slash, NUL or root `/`. Endpoint names use exactly six ASCII alphanumerics after `p-`; endpoint byte length is at most 107. Root and generated directory must be owned by the current Linux UID and exactly `0700`; socket must be owned by that UID and exactly `0600`. Every ancestor is a non-symlink directory owned by root or this UID, not world-writable. Endpoint ownership, mode and inode are checked before and after connecting. Configuration resolution is read-only. Invalid configuration fails closed without registering the extension's tools/transport.

Owner-only files are a local trust boundary, **not an attestation of the human or process**. A malicious same-UID process can impersonate a receiver. The real receiver must check peer UID and scope and expose no automatic-answer path. `source: "human"` is a protocol claim, not proof; actual human origin must be enforced by the island's trusted-click gate.

## The tool and the waiting turn

`abito_ask` is `model-only`, not callable from codemode. Its parameters are:

```json
{
  "kind": "question",
  "text": "Which route should we use?",
  "options": [
    {"value":"route-a","label":"Route A","description":"First route"},
    {"value":"route-b","label":"Route B","description":"Second route"}
  ],
  "allowFreeText": true,
  "timeoutMs": 300000
}
```

- `kind`, `text`, `options` are required. `allowFreeText` defaults to false; `timeoutMs` defaults to configuration. Unknown fields are invalid.
- Common questions have 2–4 options, or `options: []` with `allowFreeText: true`. Choices **and** free text are permitted together ("Other answer"). Neither is invalid.
- `kind: "approval"` requires **exactly two unique opaque tokens**, never free text. Yes/no is represented by two explicit options, not an inferred boolean or label. No extra "always allow" option. These requests **do not authorize Pi tools or backend proposals** by themselves.
- Question text is 1–500 Unicode code points; labels 1–60; required descriptions 0–160. Text/labels must not be whitespace-only. Plain text may include newline/tab; other ASCII control characters are refused. Option values match `[A-Za-z0-9_-]{1,128}` and are unique. Values are never inferred from display labels or indexes.
- Answer text must be non-whitespace, 1–2000 Unicode code points **and** fit the byte cap below. It is preserved as entered, not used to interpret a token or approve a permission.

### Several options and questionnaires (structured, level 3)

With `ABITO_QUESTIONS=3` and a receiver that negotiates `structured:1`, `abito_ask` also takes the shape Claude Code's `AskUserQuestion` uses, so the island's «casillas + Hecho» (S7) and «pasos + resumen» (S8) are reachable from Pi:

```json
{"questions":[
  {"header":"Ruta","question":"¿Qué ruta usamos?","options":[{"label":"A","description":"…"},{"label":"B"}]},
  {"header":"Extras","question":"¿Qué extras?","multiSelect":true,"allowFreeText":true,"options":[{"label":"Tests"},{"label":"Docs"},{"label":"CI"}]}
]}
```

- `questions[1..4]`: each `header` (≤32), `question`, `options` (2–4, `label` required, `description`/`value` optional — missing values are synthesised `o1..o4`), `multiSelect`, `allowFreeText`. One frame, one queue slot, ONE answer per step, all-or-nothing. `kind`, `options` and `allowFreeText` stay out of a questionnaire; `text` is an optional title (default: the headers joined).
- One question with several ticked options: the classic shape plus `multiSelect: true` (2–4 options).
- The result text is the usual JSON plus `selected: [{header?, question?, selected:[labels…], text?}]` — every ticked option, in the order given, with the labels, one entry per step. `details.answer` keeps the wire answer (`form` / `options` / `option`).
- A single legacy question is byte-for-byte what it was: same parameters, same result text.
- Without level 3 a questionnaire or `multiSelect` is refused BEFORE anything is sent (`invalid_request`, `reasonCode: structured_unavailable`, text names `ABITO_QUESTIONS=3`); with no connection at all it is `unavailable`. Never a downgrade to a different question. Structured limits (text 2000, label 120, description 400) apply only on a structured connection; on a legacy one the old 500/60/160 are enforced by the broker.
- Mapping and answer reporting live in `ask-tool.cjs` (`test/ask-tool.test.cjs`); the wire already carried all of it (`questions.cjs`, `question.rs`).

**The tool blocks its own execution while awaiting a reply.** Pi receives the result of that exact call, never a later injected chat message. Other tools in a parallel tool batch may still run; this is not a process-wide scheduler lock. No endpoint, missing socket, unfinished handshake or missing capability returns `unavailable` immediately rather than waiting the question deadline. There is **no terminal fallback**; the tool description tells the agent it may ask through normal chat instead.

The producer admits one live call within its session; another returns `busy` immediately. The receiver enforces **one live question globally, across sessions**, rejecting every second request with `busy`: **no queue, no replay**. Approval cards are a separate lane with visual priority; a card must not cancel a question, and a question must not cover a card.

The producer owns the deadline. Expiration returns `expired`, with **no answer, default or implicit denial/approval**. AbortSignal, end of the owning turn, shutdown or session replacement cancel the live call; disconnect ends it without replay. Every accepted reply is checked against the current session/project and the original deadline even if a timer callback was delayed. A late, duplicate, foreign-session or invalid response never decides the next question.

## Stable endpoint handoff (P2)

The island binds a fresh `<runtime>/p-XXXXXX/s` on every start. So local consumers (agent hooks) need not export `ABITO_SOCKET_DIR`/`ABITO_DESKTOP_SOCKET` by hand, the island publishes **one stable file** after the bind and removes it on exit:

`<runtime>/endpoint.json` — `runtime` is `ABITO_SOCKET_DIR` or the default `/run/user/<uid>/abito-island` of the installed app.

```json
{"v":1,"endpoint":"/run/user/1000/abito-island/p-AbC123/s","pid":12345}
```

- Mode `0600`, one line, closed key set (`v`, `endpoint`, `pid`), written to a temp file and `rename`d: a reader never sees a partial file.
- Each start overwrites it with the new endpoint. On a clean exit the island removes it, but **only if it still names its own endpoint** (a newer instance's file survives); a symlink or a foreign file is never touched.
- **A consumer must not trust it blindly.** Refuse the file unless: it is a regular file you own (not a symlink, ≤ 4096 bytes), `v` is `1`, `endpoint` has the exact shape `<runtime>/p-<6 alphanumerics>/s`, `pid` is alive (`/proc/<pid>`), and the endpoint is a socket. A crashed island (SIGKILL) leaves the file behind, which is why the pid and socket checks exist. The Rust reference is `handoff::read`.
- It is a **pointer, not authority**: you still connect to the socket, which checks the peer uid, and the QP/1 handshake above still applies. An explicit `ABITO_DESKTOP_SOCKET` keeps winning when set.
- Not published (and never a fallback to some other socket) when the runtime root is not a private `0700` directory of the current user.

### How this producer consumes it

`config.cjs#readHandoff` mirrors the harness reader check for check (`apps/desktop-harness/src/config.cjs`); the two
apps never require each other, so the code is a copy, not an import. It refuses the file unless **all** of these hold:

- regular file, not a symlink, one hard link, mode exactly `0600`, owned by you, at most 4096 bytes;
- text is canonical compact JSON — `JSON.stringify(parsed)` or that plus one `\n` — with the closed key set
  `v,endpoint,pid` or `v,endpoint,pid,procStart`, `v` exactly `1`, `pid` a safe positive integer;
- the named endpoint passes the whole private-chain check (every directory a non-symlink owned by you or root and not
  world-writable; `<runtime>` and `p-XXXXXX` yours and exactly `0700`; the socket yours, exactly `0600`, not a
  symlink);
- the pid is alive and its `/proc/<pid>/stat` state is not `Z`/`X`; when `procStart` is present it must equal field 22
  of that file, so a recycled pid is refused, and a malformed value or an unreadable start time fails closed.

Any failure yields **no connection** (never a scan, never another root). The resolution runs on **every connection
attempt**, not once at startup: a hook process is short-lived, while a Pi session outlives an island restart and each
start binds a new `p-XXXXXX/s`. A session that starts before the island, or that survives its restart, therefore
reconnects on the ordinary retry interval instead of staying dead. `ABITO_DESKTOP_SOCKET` short-circuits all of it.

Reading the handoff never creates, chmods or unlinks anything, and it never connects; the `0600`/`0700` rules above
still decide whether the socket is usable.

## What reaches the island, by question kind

| Question kind | Path | Needs |
| --- | --- | --- |
| Notice «`<project>` Pi terminó» | `agent_settled` → `settled`, with optional `projectName` + `agent` display keys | a connection (level 0 is enough) |
| One question, 2–4 options, single choice | `abito_ask`, or Pi's `ask_user_choice` / single-question `ask_user_question` raced against the terminal | `ABITO_QUESTIONS>=1` |
| One question, free text (with or without options) | `abito_ask` with `allowFreeText` | `ABITO_QUESTIONS>=1` |
| Approval (exactly two opaque tokens, no free text) | `abito_ask` `kind:"approval"` | `ABITO_QUESTIONS>=1` |
| One question, several ticked options | `abito_ask` `multiSelect: true` | `ABITO_QUESTIONS=3` + `structured:1` receiver |
| 1–4 questions with steps and a summary (Claude Code's `AskUserQuestion` shape) | `abito_ask` `questions[]`, or a native multi-question `ask_user_question` raced at level 3 | `ABITO_QUESTIONS=3` + `structured:1` receiver |
| Pi's own yes/no confirmation (`ctx.ui.confirm`, e.g. gentle-pi's «Allow guarded forced git branch deletion?») | raced against the terminal, first answer wins (see below) | `ABITO_QUESTIONS>=1` |
| Sensitive confirmations (credentials, tokens, keys, passwords, login/OAuth/auth, consent, provider consent, permission grants, review/RDD consent, maintenance authorization, opaque tokens), and every select/input/editor prompt | **nothing** — not intercepted, the terminal dialog runs untouched | — |

The island's «Ver» / *Abrir terminal* on a notice is host-owned (`focus_host {origin:'notice', id}`) and does not
depend on which producer sent the frame, so a Pi notice behaves exactly like a Claude Code one.

## QP/1 wire contract

Canonical TypeScript interfaces: [`protocol.ts`](protocol.ts). Runtime validation/lifecycle: [`questions.cjs`](questions.cjs), framing and handshake: [`adapter.cjs`](adapter.cjs).

### Handshake without changing notice v1

The legacy frames keep their **exact field set and serialization order**:

```json
{"v":1,"type":"hello","project":"<64-lowercase-hex>","sessionId":"<session>","at":1760000000000}
{"v":1,"type":"ready"}
{"v":1,"type":"heartbeat","project":"<64-lowercase-hex>","sessionId":"<session>","at":1760000010000}
{"v":1,"type":"settled","project":"<64-lowercase-hex>","sessionId":"<session>","at":1760000020000,"id":"<uuid>"}
```

**Optional display keys (S10, additive).** A `settled` frame may carry two more keys, always together:
`"projectName":"<basename of the cwd, 1-64 of [A-Za-z0-9._ -]>"` and `"agent":"<slug [a-z0-9][a-z0-9._-]{0,31}>"`. The island shows
«<projectName> <agent label> terminó» on the finished card; the label is derived from the slug, never trusted as sent. They are display text
only — `project` (the path hash) is informational, not an island-folder access filter. Same-user sessions from any folder are accepted; frames and replies remain bound to the project/session established by their own hello. The receiver accepts exactly the base key set OR the base set plus these two; any other
key, a lone key, or a value outside the format refuses the whole frame (`Invalid schema or scope`), so old frames stay valid. This adapter
sends them only after the receiver answered `questions_ready` (the extended protocol); with the flag off the frame is the exact legacy set.

Every JSON frame ends in `\n`. `ready` is **exactly** `{"v":1,"type":"ready"}\n`. With the flag off, no QP/1 bytes are sent. With `ABITO_QUESTIONS=1`, **after ready**, Pi sends:

```json
{"v":1,"type":"questions_hello","project":"<project>","sessionId":"<session>","at":1760000000000,"questionVersion":1}
```

Only a subscribed receiver replies with **this exact minimal key set**:

```json
{"v":1,"type":"questions_ready","questionVersion":1}
```

At level `2`, the producer declares an additional **closed capability** in that QP handshake (notice v1 is untouched):

```json
{"v":1,"type":"questions_hello","project":"<project>","sessionId":"<session>","at":1760000000000,"questionVersion":1,"busyReason":1}
{"v":1,"type":"questions_ready","questionVersion":1,"busyReason":1}
```

`busyReason:1` is required in the level-2 confirmation, not an unsolicited announcement. A level-1 producer must receive the minimal ready and simple busy frames: no additional keys. Missing/wrong/unrequested capability confirmation fails explicitly as `unsupported_receiver`; it never silently falls back to level 1. Configuration level `2` is **not** `questionVersion:2`; it negotiates a QP/1 capability.

### Compatibility in both directions

The integrated receiver supports both QP/1 levels; capability declaration and receiver acceptance ship together. There is **no published minimal-only QP receiver**. Rows involving such a receiver remain **fake-only evidence from `busy-reason.test.cjs`, not real-Rust evidence**; do not read this table as a deployed-version claim. If a minimal receiver is ever published, a separate pinned real-version test is required then. These levels keep exact-key validation evolvable later:

| Producer → receiver | Outcome / receiver → producer |
| --- | --- |
| Legacy notice-only or new level 0 → legacy or advanced receiver | Exact notice v1 bytes, no question subscription, no unsolicited QP ready. |
| Previous/minimal QP producer or new level 1 → advanced receiver | Minimal `questions_hello` / `questions_ready`; system busy is exactly the previous frame, **without busyReason**, even during native transition/degradation. |
| New level 1 → minimal QP receiver | Same minimal handshake and simple busy; no extra field in either direction. |
| New level 2 → advanced receiver | Declaration and confirmation both include literal `busyReason:1`. Receiver may add the closed reason enum **only** to system/busy closures. |
| New level 2 → minimal QP receiver | Rejects extra hello or returns a missing confirmation: explicit `unsupported_receiver`, root named, notices stop too; no downgrade/reconnect hidden. |
| Any QP level → legacy notice-only receiver | Unsupported handshake on the shared socket; never activate against the installed app. |

No question may be sent until both handshakes finish. Transport and QP capability handshakes each have a 3000 ms limit. Drop/timeout after `questions_hello` but before `questions_ready` reports `unsupported_receiver`, including the selected root: the receiver did not support/complete this question handshake. **No silent downgrade, no retry with the flag off, no automatic reconnect after that negotiation failure.** Notices on this connection stop too. A fresh Pi session can try again after the human corrects the receiver selection. Ordinary notice-only reconnects retain the legacy 5000 ms retry interval; a question is never replayed.

### Exact new frames

Except `questions_ready` (minimal or capability-confirming), each frame has the base keys **`v`, `type`, `project`, `sessionId`, `at`**, plus the keys below. Keys are required unless explicitly marked optional below; no unlisted keys. Each new frame has **`questionVersion: 1`**, distinct from transport `v: 1`.

| Direction/type | Additional keys and types | Semantics |
| --- | --- | --- |
| Pi → island `questions_hello` | `questionVersion: 1`, optional `busyReason: 1` at level 2 only | Explicit capability subscription, once per connection. Ready confirms exactly the requested capability. |
| Pi → island `question` | `questionVersion`, `id: UUID-v4`, `kind: "question"\|"approval"`, `text: string`, `options: [{value:string,label:string,description:string}]`, `allowFreeText: boolean`, `expiresAt: integer` | One tool invocation, producer-owned epoch-ms deadline. Request `timeoutMs` is not sent; `expiresAt - at` is the duration. |
| Island → Pi `answer` | `questionVersion`, `id`, `source: "human"`, `answer: union below` | A human response to this exact live ID on the originating connection. |
| Island → Pi `question_closed` | `questionVersion`, `id`, `source: "human"\|"system"`, `reason: "cancelled"\|"busy"\|"expired"`, optional `busyReason: "native_transition_busy"\|"native_transition_degraded"` | Busy detail is legal **only with negotiated level 2, source system and reason busy**. Any unknown value or other combination is a protocol error. Human "Do not answer": only `cancelled` with human source. Receiver admission failure: `busy` with system source. System cancellation contains no decision. Receiver expiry cannot advance the producer deadline; before it, this reason is rejected; at/after it, producer expiry wins. |
| Pi → island `question_cancel` | `questionVersion`, `id`, `reason: "cancelled"\|"expired"` | Remove the question and inform the human, not an answer. |
| Pi → island `question_resolved` | `questionVersion`, `id`, `status: "answered"\|"human_cancelled"` | Acknowledges producer consumption, **without answer text**. Emitted after consumption; never retried, even if write fails. |
| Pi → island `question_answer_rejected` | `questionVersion`, `id`, `reason: "not_live"\|"invalid_answer"\|"scope_mismatch"` | Visible rejection; does not consume any different live question. A malformed/missing non-UUID id produces only a local diagnostic, never reflected on the wire. |

### Optional agent identity on `question` (P1)

The `question` frame accepts one extra **optional** key, `agent`: a short slug naming who is asking. Absent means `"pi"`, so every existing producer is byte-for-byte unchanged and needs no release.

- Shape: `[a-z0-9][a-z0-9._-]{0,31}` (lowercase ASCII, 1–32 chars, no spaces, controls, markup or path separators). A present value that is not a string, is empty, or breaks the shape **refuses the whole frame** (no silent fallback to `pi`; an explicit `null` is refused too).
- Display: the island shows `<Agent> pregunta`. Known slugs have their own spelling (`pi` → Pi, `claude-code` → Claude Code, `codex` → Codex, `opencode` → OpenCode); any other valid slug is title-cased (`gemini-cli` → Gemini Cli).
- Only `question` carries it; every other frame keeps its closed key set. It changes **nothing** about scope, the one-live-question rule, answers or approvals: identity is a label, never an authorization.

```json
{"v":1,"type":"question","questionVersion":1,"project":"<project>","sessionId":"<session>","at":1760000000000,"id":"<uuid>","kind":"question","text":"…","options":[],"allowFreeText":true,"expiresAt":1760000030000,"agent":"claude-code"}
```

Answer union, **exactly one shape**, no extra keys:

```json
{"type":"option","value":"route-b"}
{"type":"text","text":"A different route"}
```

`option.value` must equal a token in the emitted options; free text is valid only when that question permits it. There is no boolean, index, model-origin response or timer-origin response.

The project is SHA-256 of the canonical real working-directory path, not a display name. Session identifiers follow the legacy ASCII session-token rule (1–128 characters, alphanumeric first/last, alphanumeric/dot/underscore/hyphen inside). `at` and `expiresAt` are integer epoch milliseconds on the same host. Replies must match project/session/id, have `at >= question.at`, not be in the future, and be no older than 15000 ms. Frames must belong to the same socket as the question.

### Bounds, rejection and delivery

- Legacy hello/heartbeat/settled remain capped at **512 bytes**. QP/1 frames are capped at **4096 UTF-8 bytes**, excluding the final newline. Incoming buffered batch cap is **32768 bytes**, with at most **120 complete frames/minute**. Heartbeat default is 10000 ms.
- Byte limits win over character limits. For example, 2000 `界` characters satisfy the text character bound but exceed 4096 bytes before envelope overhead: reject, do not truncate. The UI must measure the **complete serialized envelope**, not only the text.
- The parser accepts fragmented/coalesced frames, rejects invalid UTF-8, oversize batches/frames, malformed JSON, unknown message types and invalid/duplicate capabilities by closing the connection. This ends any pending question **immediately** as `protocol_error` / `invalid_frame`, not a wait until deadline. A plain socket disconnect still returns `disconnected`.
- Recognized reply types referring to the **pending ID** with wrong scope, keys, token, source, age, text or illegal/unnegotiated busy detail are rejected visibly **and immediately end that call as `protocol_error`**, with no answer. Cancellation/rejection writes are best-effort; Pi's error result is immediate even if those writes fail. After the authoritative deadline, expiry wins. Reply IDs not live are rejected as `not_live`, including double-clicks and replies to a prior question.
- Live state is cleared **synchronously before** acknowledgement, diagnostic callbacks or Promise continuation. A second reply cannot re-decide. Failed/missing ACK never rolls back consumption. No transport write is retried as a human answer.

## Tool results and errors

The tool always returns Pi's normal `{content, details, isError}` structure. `details` contains the result below. Only `answered` has an `answer`; its content includes exactly that opaque token or free text. All other outcomes say explicitly **"No human answer"**, are marked `isError: true`, and must not be interpreted as a human decision.

| `details.status` | Additional data / meaning |
| --- | --- |
| `answered` | `id`, `answer: {type:"option",value}\|{type:"text",text}`; `isError: false`. A human-picked denial token is still a successful delivery, not a tool failure. |
| `expired` | `id`; no one answered within the producer's deadline. |
| `cancelled` | `id` if emitted; owning tool/turn/session or system canceled. |
| `human_cancelled` | `id`; human explicitly selected "Do not answer", not "deny". |
| `disconnected` | `id`; connection or write failed, no replay. |
| `session_changed` | `id` if emitted; never deliver to the wrong active session/project. |
| `busy` | `id` if receiver rejected an emitted question; no id for local second-call rejection. Optional `reasonCode: "native_transition_busy"\|"native_transition_degraded"` only from a negotiated receiver closure. The model-facing error says the island is adjusting its window or cannot verify its size and explicitly suggests **normal chat instead**. No queue or invented human answer. |
| `protocol_error` | `id`, `reasonCode: "invalid_answer"\|"scope_mismatch"\|"invalid_frame"`; pending call terminated immediately on protocol violation, never waits until the deadline. Model-facing text states the protocol error and suggests normal chat. |
| `unavailable` | No connected/capable receiver at invocation, or question feature off; immediate failure. Agent may ask in ordinary chat instead. |
| `unsupported_receiver` | `runtime`; explicit QP handshake failed at that root; notices also stopped. No downgrade. |
| `invalid_request` | Invalid shape, deadline, tokens, approval count, text or complete outgoing frame size. Nothing emitted. |

Local diagnostics contain only question ID and reason, never question/answer text or options. Observer exceptions cannot block expiry. Unsupported-handshake messages include the root as requested for troubleshooting. No conversation history, screen data, credentials or desktop content is attached. Text is not persisted by this producer beyond Pi's normal tool transcript.

## Receiver/UI obligations — not implemented here

- During `compact_resize_inflight`, reject new requests immediately as system/busy. After the receiver's declared transition TTL without native acknowledgement, reject as degraded rather than assuming an unknown window size is safe. This producer does not set the receiver's TTL or resize state: those belong to the app. Send `busyReason` **only** when the originating producer negotiated level 2. No native-state transition may fabricate a human decision.
- Enforce **one live question globally**; second requests from any session receive system `question_closed` / `busy` immediately and visibly. No queue, replay, auto-answer or default.
- Only an actual trusted human click (`event.isTrusted === true`) on that question's controls emits a response. Never synthesize this property, accept chat as an answer, or expose a model/other-agent answer route. Render text with `textContent`, not HTML. Permission cards remain visually distinct and prioritized; a question does not grant backend permission.
- Bind UI submissions to question ID and session, not to "whatever question is currently visible". Consume once under the same lock as writing the originating connection. Lock controls while sending. A partial/uncertain write is **outcome unknown**, not permission to retry or restore a decision button.
- Show "Response sent" only as a pending delivery until `question_resolved`. ACK loss does not prove failure or permit a new answer. Never claim a backend action happened merely because a token reached Pi.
- **Independently discard the question at its deadline or connection closure**, even if `question_cancel`/ACK was lost. Show a visible expiry/disconnect notice. A lost frame must not leave a live-looking card forever. Escape may hide the view, not answer or cancel it.
- Rejections (`question_answer_rejected`) must be visible; do not apply a stale response to the next card. No new WebView permissions are required by this producer.

## Headless real Rust ↔ Node integration

From the repository root, using the already installed Cargo/Node and cached dependencies:

```sh
sh apps/desktop-pi/scripts/test-real-receiver.sh
```

This is an opt-in integration test, **not a fake receiver, Pi/model session, or UI test**. It builds `apps/desktop-tauri/tests/question_producer.rs` against the actual `abito_island::transport` library and launches `test-node/pi-question-producer.cjs`, which loads this producer's real config, adapter and `QuestionBroker`. Only Pi's registration/context and the human host are simulated. Every observed socket write still goes to the real UDS unchanged; no manufactured ready, answer or ACK is substituted.

The runner uses `cargo test --offline --locked`, a target directory in this checkout, and a fresh private `ABITO_SOCKET_DIR` in this checkout. It removes `DISPLAY`, `WAYLAND_DISPLAY`, `DBUS_SESSION_BUS_ADDRESS`, `XAUTHORITY` and `XDG_SESSION_TYPE` from the child environment. No Tauri entry point, GTK initialization, X server, native window, display capture, provider or service is launched. Linking the app's cached GTK/Tauri dependencies does not create a window. Missing cached dependencies or tools fail explicitly: **no downloads, fallback or silent skip**.

Each Rust fixture exclusively creates a `0700` runtime leaf, checks its base stays canonical inside this checkout, and binds its real owned `0600` socket. The host calls the real Rust `Transport::answer`; that simulates a human answer at the trusted host API, **not an `isTrusted` WebView click**. Rust verifies the real `question_resolved` receipt disappears **while the originating Node connection is still open**, so disconnect cleanup cannot masquerade as successful ACK consumption. Fixture cleanup uses receiver close and non-recursive directory removal; an interrupted/nonempty root is preserved and reported, never recursively deleted.

### Real compatibility/admission matrix

Observed in the authorized own-worktree integration based on `main@5624ef0`: **5/5 Rust integration tests green** (10 matrix scenarios), **0 ignored**, plus **25/25 producer tests green, 0 skips**. The initial missing-fixture RED and a test-only private-field compile error were corrected; the final command and `git diff --check` passed. No production Rust/Node code was changed by this integration unit.

These cases run against the **current integrated Rust receiver**, in both wire directions:

| Case / Node → real Rust | Real Rust → Node and host assertion |
| --- | --- |
| Level 1 `hello` + minimal `questions_hello` + question | Exact minimal ready; simulated host selection returns exactly `opaque-real-B` to that Node call; real ACK clears receipt once, before disconnect. |
| Level 2 capability declaration + question | Exact ready with `busyReason:1`; same real host answer and ACK round trip. No downgrade. |
| Level 1 during native transition and degraded state | Real receiver sends **exactly nine closure keys**, plain system/busy without `busyReason`; Node returns plain busy, no answer and no ACK. |
| Level 2 during native transition and degraded state | Real receiver sends ten closure keys including negotiated `native_transition_busy` / `native_transition_degraded`; Node returns matching `reasonCode` and the actual model-facing normal-chat suggestion. No human decision or ACK. Native states use the real barrier with a deterministic test clock/inert resize callback, never a window. |
| Flag off / level 0 | Exact v1 hello/heartbeat/settled field set, order, newline and ≤512-byte body; real receiver emits only ready, no unsolicited QP capability. `abito_ask` returns unavailable and notice delivery remains live. |
| Two real Node sessions at each QP level | Global second question gets plain busy routed to its own ID/session, no native detail or ACK; the first question stays live and its subsequent answer/ACK routes only to its owner. |
| Real producer in a foreign real working directory | Its real hash differs from the receiver project; Rust closes before ready, no admission/notices, Node returns unavailable rather than inventing an answer. |
| Same-UID cross-origin/session probes while real owner waits | Additional UDS probe connections, even with a cloned session label, cannot cancel/ACK/reject the owner's ID. A wrong-session frame closes the probe; the real owner's pending ID survives and its eventual real response/ACK succeeds once. These probes are adversarial test inputs, not substitutes for either real component. |

Scope limits: different operating-system UID rejection is **not exercised** (no privilege changes/sudo). The historical level-2 → minimal-only receiver row is **still fake-only**, as agreed with the parent: there is no real published peer for it. No old code is materialized or fake called a real receiver. Rendered UI, trusted clicks and a live model/provider turn remain separate checks.

## Troubleshooting `unavailable`

`abito_ask` returning «No human answer: unavailable» means no connection was ever established; nothing was sent and
nothing is queued. It is **not** an answer, a denial or an expiry. Check, in this order:

1. **The level switch.** With `ABITO_QUESTIONS` absent or `0` the producer asks the island nothing, so every question
   is `unavailable` while notices still work. Export `ABITO_QUESTIONS=1` (or `3`) in the environment Pi itself runs in:
   a value exported in another terminal or only in your shell profile does not reach an already running session.
2. **Islands that are running.** The default root is `$XDG_RUNTIME_DIR/abito-island`, the Tauri island's own leaf. The
   Electron production root (`abito-desktop`) and the Preview root (`abito-desktop-preview`) are different leaves: if
   that is the app you are using, set `ABITO_SOCKET_DIR` explicitly. There is no cross-root fallback by design.
3. **The handoff.** `ls -l "$XDG_RUNTIME_DIR/abito-island/endpoint.json"` must show a `0600` regular file owned by you
   with a live `pid` naming a `<runtime>/p-XXXXXX/s` socket. A crashed island leaves the file behind; a restart rewrites
   it. Pi re-reads it on every retry, so a session started before the island connects within one retry interval
   (5 s by default) — no restart of Pi needed.
4. **Explicit override.** If `ABITO_DESKTOP_SOCKET` is set, it is used verbatim and `endpoint.json` is ignored; an
   endpoint from an older island instance fails the socket check and yields `unavailable`. Unset it to use the handoff.
5. **Handshake level.** A receiver without the negotiated capability answers `unsupported_receiver` (naming the root)
   and notices stop too; that is not `unavailable` and there is no silent downgrade. Level `0`/`1` against an old
   receiver is the documented compatibility hazard: set `ABITO_QUESTIONS=0` there.
6. **Not injected wrong.** An invalid configuration (`ABITO_SOCKET_DIR` not absolute/normalized, a malformed
   `ABITO_QUESTIONS`, an out-of-bounds `ABITO_QUESTION_TIMEOUT_MS`) makes the extension register **nothing** — no
   `abito_ask` tool at all, so the model cannot even report `unavailable`.

`busy`, `expired`, `cancelled`, `human_cancelled`, `disconnected`, `protocol_error` and `invalid_request` are
different outcomes with different meanings; see the next section. Only `answered` carries a human decision.

The same failure looks different for Claude Code on purpose: its hook runs concurrently with Claude's own dialog, so
any result other than a real human island answer must be **empty stdout** — Claude then keeps its dialog in charge —
and it prints `Abito island unavailable. Answer in the terminal.` on stderr instead of inventing a decision. Pi blocks
its own tool call, so it reports the failure to the model instead.

## Verification and remaining checks

Run `node --test apps/desktop-pi/test/*.test.cjs`. The fake receiver uses real AF_UNIX sockets under this directory only, cleans its own temporary paths, and never contacts installed roots. Tests cover level-1 QP handshake/busy bytes unchanged in both directions, negotiated level-2 transition/degraded reasons through the real Pi-loaded tool's model-facing content, unsupported level without downgrade, immediate protocol errors for illegal/unnegotiated detail, unchanged legacy bytes with flag off, config/security, opt-in failure without downgrade, busy, deadline boundaries, cancellation/disconnect/session changes, duplicate/stale/foreign/invalid answers, explicit human non-response, text-only, two-token approvals, multibyte byte limits and ACK loss. The offline loader test uses the **installed Pi loader** without launching a model/session or discovering ambient extensions. It explicitly skips when Pi cannot be located; do not call that skip proof of compatibility.

Observed final producer verification (this change, on a clean worktree): **76 tests, 75 pass, 0 fail, 1 skipped** — the
skip is the offline loader check (`Installed Pi not found; set PI_CODING_AGENT_ROOT`) and is **not** proof of
compatibility. The new `test/handoff.test.cjs` covers the endpoint handoff: absent `ABITO_DESKTOP_SOCKET` resolves the
published endpoint; an explicit one still wins and never opens the file; a stale pid, wrong owner, `0644` file, foreign
root, bad endpoint shape, zombie state, recycled `procStart`, extra key, symlinked file or missing socket each yield no
connection; and a real Pi session connects to an island that started **after** Pi, and again to a **restarted** one
with a new endpoint under the same root. The earlier integration matrix above is unchanged and still headless
host/wire evidence, not real-island-click evidence. Native review is disabled by clone-local RDD policy. No live
provider turn, installed socket or screenshot was exercised.

Next human verification, only on the new root: load this extension, have a session call `abito_ask`, choose an option, enter permitted text, click "Do not answer", wait for expiry, disconnect, and attempt a double click/second session. Verify Pi sees exactly the matching result and the island shows the proper closure/rejection without altering permission cards. Verify the intended model actually selects `abito_ask`; merely registering it does not redirect other prompts.

## Lo que el humano debe decidir

The handshake, one-global-question admission, no queue/defaults, exactly two approval tokens, free-text support and default/bounded expiry above are the **current parent-confirmed contract**, not unanswered choices. Remaining decisions and gaps are:

1. **Which Pi prompts should use `abito_ask`?** Explicit calls, plus the native `ask_user_choice` / single-question
   `ask_user_question` race described below. Nothing else is redirected, and that must not be simulated by observing
   assistant prose.
2. **The `ABITO_QUESTIONS` default.** Claude Code has questions **on** once its hooks are installed (no equivalent
   switch in `apps/desktop-harness`), while Pi defaults to `0`, notice-only. Raising it is a product decision, not a
   documentation fix: level ≥ 1 changes the shared socket's handshake, and a receiver that does not support it stops
   notices too. Options: keep `0` and document `1|3` (today), default to `1`, or default to `3` (full Claude Code
   `AskUserQuestion` parity). See the parity audit.
3. **Pi tool permissions and provider-owned consent:** *superseded for yes/no confirmations (HU-042).* Human decision,
   verbatim option chosen: «Cualquier confirmación sí/no que no sea sensible». Any non-sensitive `ctx.ui.confirm` is
   now raced with Abito (see «Answering Pi's yes/no confirmations from Abito» below). Provider-owned consent,
   credentials and every other sensitive confirm stay terminal-only, and select/input/editor prompts are untouched.
   Claude Code has its own permission path (`PermissionRequest` hook); this is Pi's equivalent for plain yes/no.
4. **Installation:** Pi has no installer and this extension is not shipped with the installed app. The change needed
   (ship the producer, add `install pi`, refuse to touch anything else) is described as a proposal in
   [`docs/desktop/pi-question-parity-audit.md`](../../docs/desktop/pi-question-parity-audit.md). How each agent is
   installed and enabled today is in [`docs/desktop/agent-questions.md`](../../docs/desktop/agent-questions.md).
5. **Local text and Pi context:** authorize which question/answer text may cross the local UDS. Once returned to Pi it enters the session's tool transcript. If that session uses a cloud model, that provider can receive the answer on a subsequent request just as it would receive text typed in Pi. This extension itself makes no cloud/model/paid calls, and tests are entirely offline.
6. **Deployment and verification:** choose the new receiver root and when to activate QP/1. The installed default is preserved but must not be used for this experiment. Rendered UI/trusted clicks, visible global `busy`, priority with permission cards and provider turn-duration behavior remain human verification, not proven by these fake or headless host/wire tests.


## Answering Pi's native ask tools from Abito

When Abito is connected, a call to Pi's own `ask_user_choice` (gentle-pi), or to `ask_user_question` with **exactly one single-select question**, is raced between Abito and the terminal. The question reaches Abito through the same queue as `abito_ask` (agent «Pi» plus the project name). **The first human answer wins; the other side is withdrawn** (`question_cancel` to Abito, an abort signal to the terminal dialog) and is never applied twice. gentle-pi is **not modified**: this is a generic `tool_call` hook (`native-ask.cjs`).

**Trade-offs (read before enabling in your workflow):**

- The hook *blocks* the native call and returns the text the native tool would have produced (`User selected: 2. Beta (value: ...)`, `User responded: ...`, `User cancelled the choice`, or the questionnaire's numbered line). Pi's public API cannot turn a blocked call into a success, so the model sees a **tool error** that carries the correct words.
- The tool row in Pi's terminal keeps reading **«Cancelled»**: it is drawn by gentle-pi's own `renderResult`, which prints that for a result without a selection, and a blocked call carries none (`tool_result` does not run for blocked calls; the live row is drawn from `tool_execution_end`). To avoid the confusion the hook posts **one info notification** right after the decision, a dim line under the row: `Respondido en Abito: Beta`, `Respondido en la terminal: Alpha`, `Cancelado en Abito`; questionnaires read `Route: Beta · Extras: One, Three` (cut at 200 characters). It is display only: not persisted, not shown to the model.
- The terminal side is Pi's **plain select** (plus an input for `Other…` / `Type something.`), not gentle-pi's richer choice list. Option descriptions are folded into the row text.
- gentle-pi's human-answer **receipts are not recorded** for intercepted prompts (`subscribeHumanAnswers` observers see nothing).
- `ask_user_question` with several questions or `multiSelect` is raced too **only at level 3 with a receiver that granted `structured`**; without it, or with any invalid shape, it is left alone: terminal only, natively. In the terminal a questionnaire is asked question by question (multiSelect as toggle rounds ending in «Done»); Abito answers all questions at once. **Whoever finishes first provides ALL the answers**: a partial terminal answer is discarded when Abito wins, never mixed in.

**Safety rules:**

- Option values are mapped to synthetic `o1..o4` for Abito and back; the original values never leave Pi.
- **Consent and authorization prompts are never answerable from Abito.** Not intercepted (the native dialog runs untouched) when the question, labels, descriptions or previews mention consent, authorization, grant, decline, permission, token, binding, envelope, provider, credentials or secrets, or when any option value does not look like a plain word (opaque ids, hex, long digit runs, JSON, `granted`/`declined`). When in doubt, it is not intercepted.
- Abito absent, disconnected, busy (queue full or another question live), or an input outside Abito's limits: **not intercepted at all**. If Abito fails mid-race (expiry, disconnect), the terminal dialog keeps waiting indefinitely; nothing is ever auto-answered.
- `ABITO_NATIVE_ASK=0` disables the interception entirely.

## Answering Pi's yes/no confirmations from Abito

Human decision (HU-042), verbatim option chosen: «Cualquier confirmación sí/no que no sea sensible».

Any `ctx.ui.confirm(title, message)` raised by Pi or by another extension (for example gentle-pi's bash guard: «Allow guarded forced git branch deletion?») reaches Abito as an approval card from «Pi» with the session's project name, options **Sí** / **No**. **The first human answer wins; the other side is withdrawn.** gentle-pi is not modified: when the session starts, the extension wraps the confirm of Pi's shared UI object once (`installConfirmRouter` in `native-ask.cjs`) and restores the original on `session_shutdown`. Only `confirm` is wrapped, never `select`, `input` or `editor`.

**What is sent:** the title and the message **verbatim** (no redaction), so you approve exactly what Pi showed. A confirm is not routed, and the terminal dialog runs untouched, when the title is empty or longer than 200 characters, or when the message is longer than 1200 characters or 12 lines. It is also not routed when any character cannot be shown honestly. Allowed are printable ASCII, a line break in the message, a few punctuation marks (¿ ¡ « » · ° – — ‘ ’ “ ” …) and accented Latin letters (á, ñ, ü…). Everything else is refused: look-alike letters from other scripts, fullwidth forms, invisible or format characters, combining marks, tabs, non-breaking spaces and control characters.

**Safety rules:**

- **Sensitive confirmations never leave the terminal.** The check is a denylist that fails closed, applied to the title and the message after normalising them: accents removed, lower case, look-alike characters accepted for each letter (`0`→o, `1`→i/l, `2`→z, `3`→e, `4`/`@`→a, `5`/`$`→s, `6`/`9`→g, `7`/`+`→t, `8`→b, `(`/`<`→c, …) and spaces, dots, dashes and underscores removed, so `pass word`, `log_in`, `t0ken`, `6rant` or `ReviewRDD` still match. It covers credentials (*creds*), tokens, keys (*clave*, *llave*, and compounds such as `privatekey`, `keystore`, `keyfile`, `keygen`; only `keyboard` is let through), API keys, passwords (*pwd*), passcodes, passkeys, PINs, secrets, keychains, login/sign-in (*logging in*, *iniciar/abrir sesión*), OAuth, auth/authorization/authentication, consent (*consentimiento*), provider consent, permission grants, gentle-ai review/RDD consent, maintenance authorization, MFA/OTP and cookies. It also covers credentials inside an address (`user:token@host`, `//token@host`, and the percent-encoded `%40`/`%3A`), known secret shapes (`sk-…`, `sk_…`, `ghp_…`, `xoxb-…`, AWS keys, `Bearer …`), and opaque ids or tokens of 12 or more characters, including ones split by dashes, slashes or spaces.
- **Only an explicit «Sí» approves.** «No» and a human cancel from Abito answer no. Expiry, busy, disconnect, an unknown answer or any error **decides nothing**: the terminal keeps waiting and decides. If the caller's own signal aborts, both sides are withdrawn and the answer is no.
- No UI, Abito not connected or busy: the confirm is not routed.
- `ABITO_NATIVE_CONFIRM=0` disables it entirely.

A confirm answered from Abito posts one info line in Pi's terminal, `Respondido en Abito: Sí` or `Respondido en Abito: No`.

**Limits (read before relying on it):**

- A denylist cannot prove completeness: a sensitive prompt written in a way nobody anticipated could still reach Abito. The card always shows the exact text Pi showed, and nothing is approved without your explicit «Sí» click. Before the checks, encoded text is read as what it encodes (`%XX`, HTML entities, `\uXXXX`), letters drawn with symbols are read as letters (`|<` k, `|2` r, `|\|` n, `|v|` m, `\/` v, `|>` p), and a word with one letter replaced by up to three symbols still matches.
- The check errs toward the terminal, so some ordinary confirms stay terminal-only. Examples: `npm run preview` (contains *review*), `$(pwd)`, `auth.spec.ts`, `--login`, `tokenizer`, `monkey` (*key*), `secretary`, `providers`, and short hashes or camel-case names such as `a1b2c3d4e5f6` or `ImportPipeline2`. These behave exactly as before this change: you answer them in the terminal.
- Not verified yet: the card as rendered in the live island, Pi's RPC mode, and a session reload that creates a new extension runner (covered by reading Pi's code, not by a test). The last round of filter fixes (encoded text, symbol-drawn letters, symbol runs) was not independently re-reviewed.

## Structured questions (level 3)

`ABITO_QUESTIONS=3` adds `structured: 1` to `questions_hello`. The receiver must echo `structured: 1` in `questions_ready` (exact key set; anything else is a capability error, never a silent downgrade). Only then do these apply, **per connection**; levels 0-2 and every old frame are byte-for-byte unchanged, and a receiver that did not negotiate it closes the connection on a structured field.

| Rule | Plain (levels 1-2) | Structured (level 3) |
| --- | --- | --- |
| Frame cap | 4096 bytes | 16384 bytes |
| Question text / option label / option description | 500 / 60 / 160 chars | 2000 / 120 / 400 chars |
| Free-text answer | 2000 chars | 4000 chars |
| `multiSelect: true` (2-4 options, kind `question`, not combinable with `questions`) | refused | answer `{"type":"options","values":[...],"text"?}`: distinct offered values; `text` only when `allowFreeText`; at least one value or a text |
| `questions: [...]` (1-4 items `{header (<=32), text, options (2-4), multiSelect?, allowFreeText?}`; top-level `options` is `[]`, no top-level `allowFreeText`/`multiSelect`) | refused | one queue slot; answer `{"type":"form","answers":[one entry per question]}`; **all or nothing**: a wrong count or any invalid entry refuses the whole answer |

The island answers through three closed commands: `answer` (unchanged), `answer_many {id, indexes}` and `answer_form {id, answers:[{index}|{indexes,text?}|{text}]}`. The view exposes `multi_select`, `form` and `free_text_max` per question.
