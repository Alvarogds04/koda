# Abito harness core (`apps/desktop-harness`)

Standalone Node CJS package, no runtime dependencies, `private`. It gives **short-lived harness hook processes** (Claude Code, Codex, OpenCode) a safe client for the Abito island over the local QP/1 level-1 socket protocol. The Claude Code and Codex adapters are built (`abito-hook claude <permission-request|session-start|stop>`, `abito-hook codex <permission-request|pre-tool-use|post-tool-use|stop>`, `abito-hook install claude|codex`); the OpenCode adapter (U4) is not. Code is mirrored (copied with a header comment) from `apps/desktop-pi/`; nothing is required across apps.

## Security contract

- **The island never approves or denies for a CLI.** It shows, and relays the human's answer only inside the hook response the CLI itself requested. There is no `approval` kind in this client: `kind` is always `question`, anything else is `invalid_request`.
- Timeout, busy, any error or protocol violation => **no decision**, plus `formatNoDecision()` text ("answer in the terminal"). No default answer, no queue, no automatic "always allow"; Claude-only explicit permission updates are bounded below.
- Endpoint selection and handoff validation are specified in [Endpoint handoff consumed by hooks](#endpoint-handoff-consumed-by-hooks). Resolution is read-only, never scans or connects; no endpoint means unavailable.
- The socket security boundary is the user (same-uid peer credentials, private socket and runtime permissions), not the working folder. The island accepts a valid lowercase 64-hex `project` hash from any folder; it keeps that hash as informational session/question/notice metadata, with no grouping UI. Raw `cwd` is not in the current wire format and is not added.
- Every received frame is validated strictly (project/session/id, `at` window, exact keys, option must have been offered, `source: human`). These project/session comparisons bind replies to the originating connection/question, not to the island's folder. A receiver cannot expire a question early. Freshness, token validation, frame sizes, quotas and endpoint discovery are unchanged.
- Outbound text/labels and incoming free-text answers reject bidi/format/C1 controls and lone surrogates; request fields are snapshotted once before validation.
- Diagnostics carry fixed reason codes only; never question text, option labels, paths or ids.

## Claude PermissionRequest suggestions (R13)

Only Claude's `PermissionRequest` reads `permission_suggestions`. These are permission-update entries, **not an exact list of terminal choices**; Claude's file-edit dialog does not read that array at all. See the [official hook contract](https://code.claude.com/docs/en/hooks#permission-update-entries).

- At most two extras, between **Aprobar una vez** (first/default, the only one-shot safe choice) and **Rechazar**. An extra's description states the exact rule/mode/directory and either **solo esta sesión** or **se guarda en .claude/settings.local.json**. QP/1 has no safe/default fields; the adapter preserves allow-first order and never marks an extra safe.
- Closed schema: only `addRules` with `behavior: allow`, every `toolName` matching the current tool and every `ruleContent` exactly matching the shown command or absolute file path (also Claude's `//absolute` spelling for that same file); `addDirectories` only for an existing absolute directory shown by a simple `cd /directory`; `setMode` only to `acceptEdits` (explicitly labelled automatic edits). No inferred parent-directory permissions or widened globs.
- Only `session` and `localSettings`. Never `projectSettings`, `userSettings`, unknown fields/types, whole-tool rules, `replaceRules`, `removeRules`, `removeDirectories`, or any other mode. Lossy/trimmed, MCP, sensitive/redacted requests get no extras. Bash applies the file-preview sensitive-path policy too; ambiguous quoted/escaped shell paths and redirected/symlink paths get no extras. Main options/outputs are unchanged.
- Input cap: 32 suggestions, 8 rules/directories per entry, 4096 UTF-16 units per rule/path; malformed entries and duplicates are ignored. Extras that cannot be displayed completely within QP/1's 60-code-point label / 160-code-point description limits are dropped, never truncated. Main options remain available.
- Only fixed tokens `allow_suggestion_1` / `allow_suggestion_2` cross back from the island. Selection echoes the deep-frozen original validated entry in `decision.updatedPermissions: [entry]`, never content reconstructed from the card. Raw arrays never go to the island. Withdrawn, unknown, unoffered or out-of-range replies do not allow. Plain allow/deny JSON constants remain byte-identical.
- **Codex:** not applicable any more — Codex never answers, so no suggestion is ever offered or echoed there. `updatedPermissions` stays reserved and rejected upstream; openai/codex PR [#17746](https://github.com/openai/codex/pull/17746) is not released. **Pi untouched:** no upstream suggestion concept; session permissions would be a separate Abito feature.
- **Risk: item 2 (granting persistent permissions from the island).** Tests validate adapter output, not real Claude's application/persistence of echoed `updatedPermissions`; that still needs an explicit live validation. No CLI configuration or running island is modified by this implementation.

## Modules

| File | Purpose |
| --- | --- |
| `src/config.cjs` | `resolveConfig(env, uid)` -> `{runtime, endpoint}`; `ABITO_PROJECT_ROOT` is not read. |
| `src/security.cjs` | `verifyEndpoint(endpoint, runtime)`. |
| `src/identity.cjs` | `projectId(cwd)` (sha256 of realpath); `sessionToken(raw)` (QP token rule, `h-<hash>` fallback). |
| `src/projection.cjs` | `sanitizeText` (also strips bidi/format/C1 controls and lone surrogates), `buildOptions`, `describeTool` (Bash: first token only; file tools: basename only), `describeBash` logic inside `describeToolDetailed` (Bash: full REDACTED command), `describeToolDetailed(name, input)` -> `{text, lossy}` (lossy whenever the short text drops material). |
| `src/redact.cjs` | `redactCommand(cmd)` -> `{text, redactions, spans}` and `PATTERNS`; see `docs/REDACTION.md`. |
| `src/deadline.cjs` | `computeDeadline({cliTimeoutMs, maxMs, marginMs})` (marginMs clamped to >= 1000) -> `ask` (30000..900000) or `notice-only`. |
| `src/client.cjs` | `IslandClient.notify()` / `.ask()` / `.attention()` / `.clearAttention()`, `formatNoDecision()`. |
| `src/hook-common.cjs` | Shared adapter code: `parseArgs`, watchdogs, `toolDescription`, `mapResult`, option sets. |
| `src/claude.cjs` | Claude Code hook adapter: `handleClaudeHook` (`PermissionRequest` for permissions and `AskUserQuestion`, `SessionStart` title cache, `Stop`). |
| `src/claude-suggestions.cjs` | Claude-only closed permission-update allow-list, frozen snapshots and derived options. |
| `src/file-permission.cjs` | Claude-only bounded file previews, normalized path checks and fail-closed file consent. |
| `src/codex.cjs` | Codex hook adapter: `handleCodexHook` — notice only (`apply_patch` always shows the fixed label). |
| `src/install-claude.cjs` | Previewed Claude Code settings installer (`install claude`). |
| `src/install-codex.cjs` | Previewed Codex `hooks.json` installer (`install codex`) — notice-only entries, 5 s timeouts, codex profile over the shared core in `install-claude.cjs`. |
| `src/install-ui.cjs` | Island install mode for Claude/Codex, recap and statusline: `--json` preview with `plan_hash`, `--apply-plan` trusted-click apply with audit trail (see `docs/ISLAND-INSTALL.md`). |
| `bin/abito-hook.cjs` | CLI entry: `abito-hook claude\|codex <event>`, `abito-hook copilot\|opencode permission-request` and `abito-hook install claude\|codex\|copilot\|opencode\|recap\|statusline`; stdin reader, watchdog, last-resort error handlers. |

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

## Environment (Unix)

| Variable | Meaning |
| --- | --- |
| `ABITO_DESKTOP_SOCKET` | Optional explicit endpoint `<root>/p-XXXXXX/s`; wins over the handoff (test receivers). Absent => read `<root>/endpoint.json`. |
| `ABITO_SOCKET_DIR` | Runtime root; default `$XDG_RUNTIME_DIR/abito-island` (absolute, normalized), else `/run/user/<uid>/abito-island`. |

## Endpoint handoff consumed by hooks

An explicit `ABITO_DESKTOP_SOCKET` wins after endpoint-shape validation; when set, the consumer does not read `endpoint.json`. Otherwise runtime selection is ordered: `ABITO_SOCKET_DIR` (if set, it must be absolute, normalized and non-root), else `$XDG_RUNTIME_DIR/abito-island` only when `XDG_RUNTIME_DIR` is absolute, normalized and non-root, else `/run/user/<uid>/abito-island`.

The reader accepts `<runtime>/endpoint.json` only as a regular, non-symlink file owned by you, with mode exactly `0600` (including no special bits), one hard link and at most 4096 bytes. Its complete text must be canonical compact JSON: exactly the keys `v`, `endpoint`, and `pid`, with `v: 1`, and raw text equal to `JSON.stringify(parsed)` or that exact string plus one LF. No duplicate or escaped key names, pretty printing, leading/trailing spaces or CRLF are accepted. The Rust producer in `apps/desktop-tauri/src/handoff.rs` writes compact one-line `serde_json` output plus LF (`{"endpoint":"<..>","pid":N,"v":1}\n`); the compact `v,endpoint,pid` key order is accepted too.

`pid` must be a valid positive pid whose `/proc/<pid>` exists and whose `/proc/<pid>/stat` can be read within 512 bytes; the state field after the last `)` must not be `Z` or `X`. Missing or unreadable state fails closed. The key set is closed: `v`, `endpoint`, `pid` and, optionally, `procStart`. When `procStart` is present it must be a decimal string equal to field 22 of `/proc/<pid>/stat` (the process start time, parsed after the last `)`): a different value means the pid was recycled and the handoff is refused; a malformed value or an unreadable start time fails closed. When it is absent the check stays existence/alive only (the island starts writing it once the Tauri lane flips its `WRITE_PROC_START` switch), so until then pid reuse is the documented residual risk.

`endpoint` must be exactly `<runtime>/p-<6 alphanumeric>/s` (at most 107 bytes) and name a Unix socket. The handoff reader invokes the same `verifyEndpoint` chain check as the client: every directory component is checked with `lstat`, must not be a symlink, must be owned by you or root and must not be world-writable; `<runtime>` and `p-<6 alphanumeric>` must be yours and exactly `0700`. The socket must be yours and exactly `0600`, and not a symlink. Consequently a runtime under world-writable `/tmp` can never host an island. The client also verifies the socket before connect and rechecks its device/inode after connect; a path replacement between handoff reading and connect is bounded by that dev/ino re-check, not eliminated. The trust model is same-uid: another process running as you can manipulate same-owner paths. Resolution itself never connects.

## Statuses

`notify`: `sent | unavailable | unsupported_receiver`.
`attention` / `clearAttention`: `sent | unavailable | unsupported_receiver`. An attention notice is display-only text with no
option and no deadline (Codex); it never occupies the question slot and never counts as a finished turn.
`ask`: `answered{answer} | expired | cancelled | human_cancelled | busy | unavailable | unsupported_receiver | protocol_error | invalid_request`. Only `answered` carries a decision.

## Limits

- One global question in the island, no queue; a second concurrent `ask` on a client returns `busy`.
- Questions: text <=500 code points, 2-4 options (or none with `allowFreeText`), label <=60, description <=160, timeout 30 s..15 min; outbound question frame <=4096 bytes, notices <=512; inbound buffer 32768 bytes, <=120 frames/min.
- Multiple projects from the same user may connect; project hashes are informational, never an island-folder access filter. The `question` frame carries the optional `agent` slug (`claude-code`, `codex`), and a `settled` notice carries `projectName` + `agent`, so the island labels the card with the real agent.
- No heartbeat; handshake timers 3000 ms; sockets are always destroyed; a 500 ms unref'd backstop timer exists, and no other timer outlives the call.

## Not done yet

U4 OpenCode; opt-in real-receiver cross test.

## Copilot CLI and OpenCode adapters

`abito-hook copilot permission-request` answers Copilot's `permissionRequest` hook (`{"behavior":"allow"|"deny"}`; empty output otherwise; exit code always 0 because exit 2 means DENY there; a sandbox-bypass request is never offered `allow`). `abito-hook install copilot` writes ONLY `~/.copilot/hooks/abito-island.json` (Abito owns it). `abito-hook opencode permission-request` is run by the plugin `~/.config/opencode/plugins/abito-island.js` (`abito-hook install opencode`; refuses a file without our marker; remove leaves an inert stub). The plugin kills the hook at its own deadline and copies only an exact `allow|deny` into `output.status`; anything else leaves OpenCode's own prompt. Not covered: OpenCode's `question` tool and Gemini/Amp/Cursor (left out on purpose). **Unverified against real CLIs**: Copilot payload field names for `permissionRequest` (both camelCase and snake_case are read), OpenCode's request fields and per-version `permission.ask` wiring.

## Claude Code adapter

Events: `PermissionRequest` (no matcher: ONE handler dispatches permissions and `AskUserQuestion` by `tool_name`), `SessionStart` (title cache only), `Stop`. `abito-hook claude pre-tool-use` is a usage error — the former `PreToolUse` question path is gone, and the installer removes the Abito-owned `PreToolUse` entry of an older install.

**AskUserQuestion** (`PermissionRequest`): Claude's question tool also fires `PermissionRequest`, which runs **concurrently** with Claude's own terminal dialog and lets the first answer win ([official hook contract](https://code.claude.com/docs/en/hooks)). So the question is in the island and in the terminal at the same time; answering in the terminal cancels this hook process, the socket closes and the island revokes the card (`test/claude-cancel.test.cjs`). On a human island answer the hook prints `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedInput":{...original tool_input,"answers":{"<question text>":"<chosen label>"}}}}}` — `updatedInput` replaces the whole tool input, so the original object is echoed and `answers` added. It answers 1–4 questions, each with 2–4 options and optional `multiSelect`. A single multi-select uses the existing checkbox + **Hecho (N)** view (design 07 A); 2–4 questions travel as ONE questionnaire with steps + summary (design 08 A), ONE queue slot and ONE deadline, not successive independent cards. These shapes negotiate existing QP/1 `structured:1`; an older receiver is not downgraded or auto-answered. Rust and the wire protocol are unchanged. Full three-agent comparison: [`docs/desktop/agent-questions.md`](../../docs/desktop/agent-questions.md).

Answers are keyed by the **original question text** (not the header). Single choices retain their original label; multiple choices use original labels joined with `, ` in the received selection order, e.g. `"Postgres, Redis"`. **Claude multi-select encoding: UNKNOWN** — repository documentation only establishes the single-label string contract. The conservative string encoding is isolated in `claude-ask.cjs#encodeLabels` and needs a real-Claude check (including labels containing commas). All original tool input fields and unrelated existing answers are preserved.

More than four questions, options outside 2–4, duplicate question keys, malformed input, oversized question text, oversized structured labels/descriptions/headers, and multi-select combined with explicit free text or an Other/«Otra cosa…»/«Type something» option fall back to the terminal. Single-select Other remains an ordinary offered label, as before; no free-text editor is enabled. Legacy single-select labels/descriptions keep their existing sanitized display shortening while returning original labels. Timeout, no island, busy, **Omitir**, incomplete/forged answers or any unanswered questionnaire => empty stdout, never partial answers or fabricated defaults; the generic PermissionRequest fallback remains unchanged.

**Non-interactive Claude sessions** (`claude -p`, background subagents) cannot show their own prompt, so an empty hook output there means **deny**. Abito never auto-allows: if you are not at the island in time, those runs are refused.

**Session name.** `SessionStart` stores `session_title` (from `--name` / `/rename`) in `$ABITO_STATE_DIR` (default `~/.local/state/abito-island/claude-titles/<session>`, dir 0700, files 0600, 14-day pruning). Later events label the island with it; without a title the label is the project folder name.

> **WARNING: nothing is installed by default.** Claude Code settings are only touched by the previewed installer below, and only when the human types the confirmation word. Run manually: `node bin/abito-hook.cjs claude <permission-request|stop> [--timeout-sec N]` (JSON on stdin).

**Hook input consumed** (one JSON object on stdin, <= 1 MiB): `hook_event_name` (must match the subcommand: `PermissionRequest` / `SessionStart` / `Stop`), `session_id`, `cwd` (absolute existing directory, else no decision). PermissionRequest also `tool_name`, `tool_input` (projected to the sanitized tool name plus the full secret-redacted Bash command (see Privacy decision) or the bounded file preview described below; MCP tools show the sanitized server and last tool-name segment, `herramienta MCP <server>/<tool>`). `session_id` is only used as a normalized token, never displayed; `permission_suggestions` and `mcp_server` are ignored and never echoed. Stop: `stop_hook_active === true` => no notice; `last_assistant_message` is never read. `transcript_path`, `permission_mode` and Notification events are not used.

**Output.** Stdout is either empty or exactly one line. For a permission, `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}` (human chose *Aprobar una vez*, offered only for lossless requests) or the same with `"behavior":"deny","message":"Denied from the Abito island by the user."` (human chose *Rechazar*). For `AskUserQuestion`, the `allow` + `updatedInput{...questions,"answers"}` line described above. Nothing else is ever emitted: no `updatedPermissions`, `interrupt`, `setMode`, no suggestion echo beyond the frozen entry already described. Exit code is always 0 (never 2), except usage errors (64, nothing on stdout).

**Security rules.** The island never decides: **empty stdout = no decision, the terminal prompt stays in charge** (expired, busy, cancelled by the human, unavailable, old receiver, protocol error, bad input, any internal error all fail open to the CLI's own prompt; that is not an approval). No always-allow option. Question is `kind: question` only, no free text. **Consent rule: `allow` is offered ONLY when the on-screen description is lossless for the request** (the Claude file-preview contract below, or `describeToolDetailed(...).lossy === false`: a `Bash` command that passes the printable single-line ASCII/Latin policy (R22 below), <= 380 code points after redaction, free of shell indirection, credential paths/secret sources and hidden shell syntax inside redacted spans (full definition in `docs/REDACTION.md`), whose input has only the keys `command`, `description`, `timeout`, or an MCP tool whose `tool_input` is an empty plain object; a missing/null/array/primitive `tool_input` and any other tool name are lossy). A lossless `Bash: ls` may deliberately carry the benign `description`/`timeout` fields: they do not change what executes. Anything else (a Bash command with command substitution, interpreter/`-c`/`xargs`/`find -exec`-style indirection, credential or secret sources, or secret-redacted text that may hide shell syntax; other keys; file tools outside the Claude-only preview contract below, any other non-MCP tool, any other tool with input) is lossy. Plain pipes, redirects, `&&` and `;` are NOT lossy by themselves: they are fully visible in the displayed command: the question reads `Claude Code pide permiso para <descripción> (...detalles solo en la terminal; decidir en la terminal)` and offers only `deny` and `terminal` ("Decidir en la terminal" => empty stdout, the CLI prompt decides). An `allow` answer to a question that did not offer it is a protocol error => empty stdout. stderr carries short generic lines only (no question text, commands or paths).

### Permisos de archivos de Claude (R9–R11)

`Write`, `Edit` y `MultiEdit` permiten **Aprobar una vez**, seguido de **Rechazar**, solo si la ruta y todo el cambio caben sin ocultaciones. `Write` muestra el contenido; las ediciones muestran `old_string → new_string`, su orden y si reemplazan una o todas las coincidencias. El contenido se cita como JSON: `\\n`, `\\t` y `\\r` son caracteres explícitos, no filas ni botones nuevos. No se leen contenidos del disco.

- Límites acumulados por solicitud: **8 líneas / 160 bytes UTF-8** entre todos los fragmentos (antes y después cuentan por separado), **3 ediciones**, ruta absoluta normalizada de **160 bytes**. La representación citada tiene un límite adicional de **390 puntos de código / 1200 bytes**, o **350 puntos** si está recortada, reservando espacio para la pregunta QP/1 de 500 puntos y el marco de 4096 bytes.
- Si excede los límites, dice **recortado**, muestra un prefijo solo después de comprobar todos los fragmentos, y ofrece únicamente **Rechazar / Decidir en la terminal**. Por encima de **4096 bytes** de entrada de contenido no se escanea ni muestra ningún prefijo: podría cortar un secreto. También se omite la vista si la representación escapada excede el presupuesto de la tarjeta.
- Se aplica `redactCommand` (la misma canalización de Bash) a cada fragmento completo. Además, cualquier asignación estilo `.env`, clave con apariencia de secreto o bloque de clave privada oculta **todo** el contenido con `[REDACTED] (secretos ocultos)` y prohíbe aprobar. Las heurísticas no detectan todos los secretos arbitrarios: un secreto sin forma reconocible aún puede mostrarse.
- ANSI, controles, bidi, caracteres ignorables/zero-width y sustitutos aislados impiden aprobar; el contenido inseguro se omite, nunca se transforma silenciosamente en un cambio aprobable. Rutas con controles tampoco se muestran. `..` se normaliza; no se abre el archivo. Los ancestros existentes se comprueban con metadatos/`realpath`; rutas redirigidas, enlaces simbólicos, errores de comprobación y rutas fuera del cwd son solo terminal.
- Rutas sensibles: **todo `/etc`**, **cualquier dotfile/directorio oculto bajo home**, componentes **`.ssh`, `.claude`, `.codex`, `.config`, `.git`**, y todos los patrones existentes de `touchesCredentialPath` en `src/redact.cjs` (incluyen `.env`, `.netrc`, `.npmrc`, `.pgpass`, `.aws`, `.gnupg`, credenciales, secretos, certificados/claves y configuraciones de shell). Nunca se muestra contenido de estas rutas.
- Campos desconocidos, tipos inválidos, `NotebookEdit` y herramientas desconocidas siguen sin aprobación. Codex conserva su política previa: los cambios de archivo siguen siendo lossy. Las etiquetas y explicaciones de permisos de ambos agentes están en castellano; los valores `allow`/`deny`/`terminal` y las líneas JSON de decisión no cambian. Bash conserva su proyección y reglas de redacción completas.

**R11, protocolo existente:** al seleccionar terminal, `client.cjs` envía `question_resolved` y cierra la tarjeta antes de devolver stdout vacío. Al vencer el plazo envía `question_cancel` (`expired`); los errores de protocolo pendientes también cancelan. Ya **no** hay que esperar a que el hook termine: `PermissionRequest` corre en paralelo con el diálogo de terminal de Claude, así que el humano puede responder en cualquiera de los dos y gana la primera respuesta. Cuando responde en la terminal, Claude cancela este proceso, la conexión se cierra y la isla retira la tarjeta (probado con un proceso real y un receptor AF_UNIX real en `test/claude-cancel.test.cjs`). No se cambia QP/1.

**Stop** sends one notice (`settled`) and prints nothing. The notice carries the optional display keys `projectName` (basename of the cwd) and `agent` (`claude-code` / `codex`) so the island can say «<project> Claude Code terminó»; a project name or agent outside the wire format simply omits BOTH keys (the notice is still sent).

**Timeout interplay.** The hook runs **concurrently** with Claude's terminal dialog, so the island budget no longer delays the prompt: the human sees both at once and answers where it is convenient. Default `--timeout-sec 35` => island budget `min(35-5, 60)` = 30 s; the island wait for hooks is capped at 60 s regardless of `--timeout-sec`. On expiry the card is withdrawn and the terminal dialog is still there (`question_cancel`, empty stdout). The installer sets the Claude hook `timeout` equal to `--timeout-sec`. A hook timeout under 35 s => notice-only: no question is offered at all, the terminal is the only place to answer. The process exits by itself by the hook timeout (watchdog; 15 s for Stop), and 5 s after start for a missing stdin. `uncaughtException` / `unhandledRejection` handlers exit 0 with empty stdout.

**v0.2 limits.** Notification events are not wired (no matching QP/1 frame) other than `Stop`'s `settled` and Codex's attention notices. One global question: busy => answer in the terminal. The receiver accepts projects from any folder of the same user; malformed project hashes still fail closed. An unavailable receiver prints the generic `Abito island unavailable. Answer in the terminal.` on stderr. Endpoint selection and validation are specified in [Endpoint handoff consumed by hooks](#endpoint-handoff-consumed-by-hooks); a missing or unsafe handoff means unavailable, with no scan or fallback, and an explicit `ABITO_DESKTOP_SOCKET` wins without reading the handoff.

## Installing the Claude Code hook

> **Island mode (no terminal):** `install claude|codex|recap|statusline --user --json` returns a read-only JSON preview with a `plan_hash`; `... --apply-plan <hash> --audit-dir <dir> --json` applies exactly that plan, only when called by the island executable. Contract, guards and limits: [docs/ISLAND-INSTALL.md](docs/ISLAND-INSTALL.md). The TTY flow below is unchanged.

```
node bin/abito-hook.cjs install claude (--settings <abs path> | --user) [--timeout-sec N] [--remove] [--apply]
```

1. **Preview first (default).** Without `--apply` nothing is written (exit 0): it prints the target, whether the file exists, the entries to add/replace/remove, a unified-style diff (max 200 lines; the truncation line says how many lines were hidden), the backup path and `dry run: nothing was written`.
2. **What gets added.** One new matcher group each under `hooks.PermissionRequest` (`command` = absolute `node`, `args` = `[<abs bin/abito-hook.cjs>, claude, permission-request, --timeout-sec N]`, hook `timeout` = N, default 35 — no `matcher`, so the one handler sees every tool and dispatches `AskUserQuestion` by `tool_name`), `hooks.SessionStart` (`... claude session-start`, timeout 5: it only caches the session title) and `hooks.Stop` (`... claude stop`, timeout 15). Any Abito-owned `PreToolUse` entry from an older install (the removed question path) is **removed** in the same pass — removal only, and only of the entry it recognises as its own; the preview reports it as a migration. Nothing else is touched: Claude merges hooks, so existing hooks (e.g. a `SessionStart` herdr hook, other tools' `PermissionRequest` hooks) are preserved untouched. **Only the top-level `hooks` property is patched, textually**: a strict JSON scanner finds its byte span and everything outside it (other keys, big integers like `12345678901234567890`, `1e400`, duplicate unrelated keys, `\u00e9` escapes, key order, CRLF/tab/space indentation, trailing newline) stays byte-identical; the preview ends with `Lines changed outside hooks: 0` and the post-write verification compares the bytes before and after the span. If `hooks` is absent it is inserted as the last member. The installer refuses (exit 65) a non-object or invalid file, a duplicate top-level `hooks` key, and a `hooks` subtree holding duplicate keys or a number that cannot be re-serialized losslessly (non-finite, unsafe integer, extra precision, `-0`). Inside `hooks` only, the subtree is re-serialized (string escapes are normalized). Note: `{"hooks":{}}` becomes `{}` after install + `--remove` (semantically equal), and a one-line file such as `{"a":1}` gains a newline before the closing brace.
3. **Idempotent and removable.** Our entries are recognized by `args` containing this package's absolute `bin/abito-hook.cjs` plus `claude`; installing again replaces them in place (never duplicates); `--remove` deletes our entries and nothing else of yours that has content. Beyond our own entries it may delete, all semantically inert: (a) a user's already EMPTY `hooks.PermissionRequest` / `hooks.SessionStart` / `hooks.Stop` array, (b) a matcher group whose only hook was ours (its `matcher` is lost with it), and (c) the whole `hooks` key when the removal leaves it empty. Everything outside the `hooks` span stays byte-identical.
4. **Always the human.** `--apply` needs an interactive TTY on stdin AND stdout (else exit 77, nothing written, so an agent or script cannot apply) and the human must type exactly `install` (`remove` with `--remove`) + Enter; anything else aborts. The prompt has an absolute timeout of 120 s (a Ctrl-D after typing text yields no line and no close on a TTY): on expiry, input end or input error the answer is empty and the CLI aborts with `aborted: confirmation timed out` (exit 1, nothing written, no backup). Only the install CLI reads `ABITO_INSTALL_PROMPT_TIMEOUT_MS` (clamped 100..600000 ms) to shorten it for tests. There is no default path: `--settings <abs path>` or `--user` (`$HOME/.claude/settings.json`, only when `HOME` is absolute) must be typed.
5. **Safety.** Strict JSON object only, **valid UTF-8 only** (a file whose bytes are not exactly what its UTF-8 decoding re-encodes to, e.g. a Latin-1 `0xE9`, an overlong sequence or a BOM, is refused with exit 65 and fixed message `settings file is not valid UTF-8` so no byte can silently become U+FFFD; valid `é`/emoji are preserved byte-exact, and apply re-checks the bytes around the patched span as Buffers), max 1 MiB, regular non-symlink file owned by you, parent directory owned by you, not world-writable, no symlink in the path (else exit 65). The settings directory must already exist: it is never created (`--user` with no `~/.claude` refuses with exit 65); only the file inside an existing directory may be created. Backup `<settings>.abito-backup-<UTC>` (0600, never overwritten), atomic write (temp + fsync + rename, mode preserved). If the file changed since the preview, nothing is clobbered (exit 70); after writing the result is re-parsed and, if wrong, the backup is restored (exit 70); if the restore itself fails the installer says `could not restore automatically; your original is at <backup>` (exit 70) instead of claiming success. The rollback command is printed: `cp -p <backup> <settings>`. Usage errors: exit 64.
6. **Hook entry format.** The entries use the exec form (`command` + `args`). Its support was confirmed from the installed Claude Code 2.1.289 binary text ("spawned directly with these arguments — no shell") and from the official docs. The Stop hook timeout is fixed at 15 s.
6b. **Endpoint handoff (consumed).** No environment export is needed; see [Endpoint handoff consumed by hooks](#endpoint-handoff-consumed-by-hooks) for the enforced runtime selection, canonical handoff format, pid liveness and private endpoint-chain checks. An explicit `ABITO_DESKTOP_SOCKET` wins without reading the handoff.
7. **Timeout trade-off.** The hook runs **concurrently** with Claude's terminal dialog (the official `PermissionRequest` contract), so a longer island budget no longer delays the prompt: both are on screen at once. The hook `timeout` equals `--timeout-sec` (island budget `min(N-5, 60)` s); on expiry the card is withdrawn and the terminal dialog stays. Under 35 s the hook is notice-only: no island question at all.

## Codex adapter

> **WARNING: nothing is installed by default.** Use the previewed installer below. Run manually: `node bin/abito-hook.cjs codex <permission-request|pre-tool-use|post-tool-use|stop> [--timeout-sec N]` (JSON on stdin); `--timeout-sec` is still accepted for entries written by an older install but buys nothing.

**Notice only** (S4/T2, human decision «Solo aviso para Codex»). Codex's official hook contract ([learn.chatgpt.com/docs/hooks](https://learn.chatgpt.com/docs/hooks)) has `PermissionRequest` running **before** the approval prompt — a hook that waited for an island answer would delay the prompt itself — and plan-mode `request_user_input` can only be observed by `PreToolUse`, never answered ([openai/codex#19328](https://github.com/openai/codex/issues/19328)). So no Codex event produces a decision:

| Codex event | What the island gets |
| --- | --- |
| `PermissionRequest` (any tool) | One notice «Codex te pide permiso» + redacted tool text + «Respondé en la terminal» |
| `PreToolUse` (matcher `request_user_input`, plan-mode questions) | One notice «Codex te pregunta» + the question text + «Respondé en la terminal» |
| `PostToolUse` (any tool) | `attention_clear`: the tool ran, so the prompt it waited on is resolved |
| `Stop` | The `settled` notice, plus `attention_clear` for any pending notice |

Every event returns empty stdout and exit 0 immediately. Never emitted: `hookSpecificOutput`, `decision`, `updatedInput`, `updatedPermissions`, `interrupt`, `decision:block`. There is no option set, no consent rule and no forged-answer path, because nothing is answerable here. The notice is sent synchronously rather than with Codex's `async: true`: a detached process would race the prompt, and the bound is real (1 s connect + 0.5 s handshake ≈ 1.5 s worst case) with the hooks.json entry timeout (5 s, 15 s for `Stop`) as the hard stop. The island also expires an attention notice on its own.

**Projection.** The notice text is the same sanitized, secret-redacted projection the Claude card uses (redacted tool text, 120 characters) plus the fixed tail «Respondé en la terminal». `apply_patch` shows only the fixed label `apply_patch (edición de archivo)`; a plan-mode question tries `question`/`text`/`prompt`/`message` and degrades to the plain tail when unreadable. **`tool_input.description` is deliberately not shown or forwarded** (Codex writes it and it may be model-influenced); `last_assistant_message`, `transcript_path`, `model`, `turn_id` and `permission_mode` are never read.

**Trust and operation.**
- Codex hooks must be reviewed and trusted by the human in `/hooks` before they run; until then they do nothing. **NEVER use `--dangerously-bypass-hook-trust`.**
- The Codex hook command is a shell string (no args array); the installer POSIX single-quotes the absolute node and script paths. It never reads or writes the trust state in `~/.codex/config.toml`.
- Multiple matching hooks run concurrently. Ours never emits a decision, so it cannot override another hook's `deny` or `allow`.
- stdin cap 1 MiB; watchdog; 5 s after start for a missing stdin; stderr carries short generic lines only; usage errors exit 64.

**v0.2 limits.** Multiple same-user projects are accepted; frames stay bound to the project/session of their own `hello`. The endpoint comes from the stable handoff, no export needed, and an explicit `ABITO_DESKTOP_SOCKET` wins without reading it ([Endpoint handoff consumed by hooks](#endpoint-handoff-consumed-by-hooks)). Inside the island a notice is display-only text: it never occupies the single question slot and never counts as a finished turn. Three-agent comparison, including what Codex deliberately cannot do: [`docs/desktop/agent-questions.md`](../../docs/desktop/agent-questions.md).

## Privacy decision: full redacted Bash command

Full redacted command shown by explicit human decision, so `Allow once` works for commands with arguments. Secrets are replaced by `[REDACTED]` (patterns, lossless conditions, known gaps and false-positive policy: `docs/REDACTION.md`). The redacted text travels over the local UDS to the island; raw commands never do. Lossless means the displayed text faithfully represents what runs: printable ASCII/Latin per R22 below, one line, <= 380 code points, no `$(`/backticks/heredoc/interpreter pipes or `-c`/`-e` interpreters/`xargs`/`find -exec`/`eval`/`source`/`sudo`, no credential path or secret source, no literal `[REDACTED]`, and no shell metacharacter (`; & | < > ` $ ( ) { } \`, newline) inside any text that was replaced by `[REDACTED]`; otherwise `deny`/`terminal` only with a fixed reason (`long command`, `special characters`, `touches credential files`, `shell indirection`, `hidden text may contain shell syntax`). Redaction is best effort: a secret in a non-secret-named place can still be visible on the island. `tool_input.description` and `last_assistant_message` are never shown.

### Visible Latin Bash commands (R22)

Claude uses this projection for its cards; Codex uses the same projection for its notice text only (it has no options and no decision JSON any more). The screenshot command `echo "una linea larga para ver cómo se acomoda el texto en la tarjeta de permiso" > ./prueba-isla/tres.txt` still offers **Aprobar una vez / Rechazar** in Claude's card, with the exact redacted command, not an escaped or whitespace-collapsed substitute; in Codex it appears as the redacted detail of the «Codex te pide permiso» notice.

- **Closed allow-list:** printable ASCII U+0020–007E; Latin letters U+00C0–00D6, U+00D8–00F6, U+00F8–00FF (Latin-1 letters only); punctuation U+00A1, U+00AB, U+00BB, U+00BF (`¡ « » ¿`), U+2013–2014 (`– —`), U+2018–2019 (`‘ ’`), U+201C–201D (`“ ”`), U+2026 (`…`). These typographic marks are visible literal arguments, **not** shell quote/dash replacements. No other non-ASCII character is approvable.
- **Confusable review / verifier correction:** all of **U+0100–024F (Latin Extended-A/B)** is now lossy, including `ſ ı ǀ ǁ ǃ Ɩ Ɨ ƒ`: some resemble ASCII letters or shell operators and can hide the apparent command identity (for example `ſudo`). `ª` U+00AA / `º` U+00BA remain excluded: their superscript shapes can resemble `a`/`o` or annotations. `ß` U+00DF is retained as an ordinary German letter with a distinct non-ASCII shape, not an ASCII `s`/`ss`/`B` substitution; likewise `Æ/æ`, `Ø/ø`, `Ð/ð`, `Þ/þ` are retained as visibly distinct Western letters, not shell operators. No folding/transliteration is performed, and font-dependent confusion remains a live-rendering verification risk. Multiplication U+00D7 and division U+00F7 remain excluded. The final ranges above are exhaustive; no Extended letter gets an exception.
- **Updated tests:** the generated `R22 visible Latin/punctuation U+100` through `U+24f` approval cases were replaced by exhaustive `R22 excluded Extended U+100` through `U+24f` denial cases, because visible Latin script alone does not prevent ASCII/operator spoofing. Latin-1 approval cases, the screenshot, NFC, punctuation and wire budgets retain their existing expectations. Added explicit regressions for all eight reported characters and forged-allow tests for the four reported commands. Since the Codex answer path is gone, the Codex rows of that file now assert the single attention notice (no option, no decision) instead of an approval.
- **NFC required, never applied:** the original command must already equal its NFC normalization. Decomposed `o` + U+0301 and all combining marks remain lossy; they are never silently composed into an approvable command. U+0340 etc. do not pass either.
- **Everything outside that list is lossy (`special characters`):** C0/C1 controls (including NUL, TAB, CR, LF, ESC/ANSI/OSC, DEL and U+0085), bidi controls (U+061C, U+200E–200F, U+202A–202E, U+2066–2069), zero-width/format/default-ignorable characters (including U+00AD, U+200B–200D, U+2060–2064, U+FEFF), U+2028–2029, variation selectors U+FE00–FE0F/U+E0100–E01EF, Unicode tags U+E0000–E007F, non-Latin scripts and Latin letters outside the explicit ranges, private-use/unassigned code points, lone surrogates, emoji and unlisted symbols (including ×/÷), and non-ASCII spaces. Default is lossy, not best-effort rendering.
- **Display:** the existing sanitizer preserves allowed accents/punctuation. As before, a lossless Bash command uses the dedicated full-redacted-text path (no escaping, normalization, home collapse or whitespace collapse); lossy previews still use `sanitizeText`. Accents beside a fake “Aprobar una vez” remain command text, never option structure; newline/control attempts stay terminal-only. All indirection, credential-path, hidden-syntax, DB-option, redacted-command-word and literal `[REDACTED]` checks remain in place.
- **UTF-8 wire budget:** `client.cjs` and Rust `question.rs` bound the complete legacy JSON frame to **4096 bytes**, separately from the **500-code-point** text / 60-label / 160-description caps. The existing **380-code-point** Bash display ceiling is unchanged: allowed letters take at most 2 UTF-8 bytes and the listed punctuation at most 3, so the command contributes at most **1140 bytes** before the fixed question/JSON overhead. A long accented command near 4096 raw bytes is already lossy (`long command`), shortened to the existing 300-code-point preview before transmission. Tests send 380/381-code-point cases and 4095/4096/4097-byte commands through both real QP/1 fake receivers and measure the serialized frames in bytes; no wire cap is raised. No change to the 4096-UTF-16-unit scan cap.

**Risk: item 2 (what the island lets the human approve).** Automated coverage checks projection, exact card text, options, forged approval rejection and local QP/1 delivery for Claude. Actual island font/glyph rendering and a fresh live Claude approval remain human verification; no running island/preview or user CLI configuration is touched.

## Tests

`npm test` (node:test, fake receiver over real AF_UNIX sockets under a mkdtemp 0700 directory).

## Notify-only Claude integrations

`install recap --user --json` previews `UserPromptSubmit`, `PostToolUse`, `Stop`
hooks that only count weekly-recap activity (no command text, path or prompt kept).
`install statusline --user --json` previews the single `statusLine` relay, which
keeps an existing status line running and prints it. Both accept
`--apply-plan <hash> --audit-dir <dir> --json` through the shared island layer:
guards, re-plan/hash match, audit, dated backup, verification, marker-only removal.
Their sibling scripts are resolved relative to this package, not supplied by the UI.
The relay saves/restores the old status line in `~/.abito/statusline-previous.json`
(0600), exactly as its interactive installer does. Neither accepts `--timeout-sec`.
Interactive preview / `--apply` (TTY and typed word) remain unchanged. See
[the machine-readable contract](docs/ISLAND-INSTALL.md#notify-only-claude-integrations).

## Installing the Codex hook

> Island (no-terminal) mode works the same way for Codex: see [docs/ISLAND-INSTALL.md](docs/ISLAND-INSTALL.md) (`requires_trust_review: true`). The TTY flow below is unchanged.

```
node bin/abito-hook.cjs install codex (--settings <abs path to hooks.json> | --user) [--timeout-sec N] [--remove] [--apply]
```

Same safety model as the Claude installer (preview by default; `--apply` needs a TTY on stdin AND stdout and the human typing `install`/`remove`, else exit 77; 0600 `O_EXCL` backup; atomic write; change check by size+mtime+sha256; strict UTF-8; only the top-level `hooks` member is patched textually so every other byte is identical; duplicate keys / lossy numbers inside `hooks` are refused; prompt timeout; honest restore messages). `--user` means `$HOME/.codex/hooks.json` (`HOME` absolute and equal to the resolved home, no symlinked `.codex` or `hooks.json`, the `.codex` directory must already exist).

- **Entries.** Notice-only, as described in [Codex adapter](#codex-adapter). One matcher group with no `matcher` (matches every occurrence) is ADDED to `hooks.PermissionRequest`, `hooks.PostToolUse` and `hooks.Stop`, and one group with matcher `request_user_input` to `hooks.PreToolUse`. Codex has no `args` array, so `command` is a shell string: `'<node>' '<bin/abito-hook.cjs>' codex permission-request`, `... codex pre-tool-use`, `... codex post-tool-use` and `... codex stop`, all with `statusMessage` `Abito island`. Entry timeouts are 5 s, and 15 s for `Stop`. No entry carries `--timeout-sec` any more: a notice never waits for an answer. Paths are POSIX single-quoted (`'` becomes `'\''`); a path containing NUL, newline, carriage return or a non-absolute path is refused (exit 65).
- **Third-party hooks preserved.** Existing hooks (e.g. `moshi-hook` on `PermissionRequest`/`SessionStart`/`Stop`/`UserPromptSubmit`) stay as they are; ours is added next to them. Ours is recognized only by the EXACT generated command (node path + `codex permission-request|pre-tool-use|post-tool-use|stop`, nothing before or after), plus the legacy `... codex permission-request --timeout-sec N` entry written by the removed answered path, which re-install replaces. Commands that merely contain our path (echo/grep/env wrappers, `; id` suffixes, other node, unknown subcommands, trailing whitespace) are third-party and never replaced or removed, so `--remove` deletes only ours, even inside a matcher group shared with other hooks.
- **Trust review required.** Codex marks new or changed non-managed hooks as untrusted until you review them in `/hooks`; until then the Abito hooks do nothing. The installer says so in the preview and after apply. Trust state lives in `~/.codex/config.toml`, which the installer never reads or writes, and it never uses or suggests `--dangerously-bypass-hook-trust`.
- **No prompt is skipped.** The island cannot allow anything for Codex: the approval prompt stays in the terminal and the notice only tells you to answer there.

### Install-core guarantees and limits (Claude and Codex installers)

- **Bytes.** Bytes OUTSIDE the top-level `hooks` member are identical after install. INSIDE `hooks`, third-party entries keep their values and key order, but may lose their inline formatting because the member is re-serialized.
- **`--remove`** returns the original semantically, not necessarily byte-identical (re-serialized `hooks`, an emptied `hooks` key or empty arrays may disappear).
- **Matcher groups.** If our entry lives inside a matcher group that has a `matcher`, install keeps that matcher, so the hook may not fire for every event. Behavior is unchanged; review such groups by hand.
- **Timeout.** `--timeout-sec` must be an integer 1..3600; it is validated again when the Codex command string is built.
