# Windows security boundary — notice receiver, relay, daemon pipe (S6/L6)

Status for v0.1.x. Owner decision **L6**: the Node daemon pipe keeps Windows'
default DACL for this version; the Rust NOTICE receiver and the relay have the
full same-user gate. A Rust-owned same-user-only daemon broker is a documented
follow-up.

## Notice receiver (`transport_win.rs`) — fully user-only

- **Endpoint**: local byte-mode pipe `\\.\pipe\abito-notice-<SID>-<32 hex>`.
  The 128-bit instance comes from `BCryptGenRandom`. `PIPE_REJECT_REMOTE_CLIENTS`
  refuses any non-local client at the kernel.
- **DACL**: explicit protected `O:<SID>D:P(A;;GA;;;<SID>)` — owner-only
  generic-all, no inheritance. No SYSTEM/Administrators/Everyone entry.
- **Overlapped I/O and cancellation (B1/B2)**: every pipe handle (server and
  client) is opened `FILE_FLAG_OVERLAPPED`; every Connect/Read/Write carries
  an OVERLAPPED. Bounded waits that expire CANCEL and then DRAIN: the caller
  waits for the kernel to complete the very same OVERLAPPED
  (`GetOverlappedResult`, wait=TRUE) before any OVERLAPPED, event, buffer or
  handle is dropped or reused. Immediate completions (`ERROR_PIPE_CONNECTED`,
  synchronous Read/Write) are recognized and never wait on an event that
  would never be signalled. Shutdown cancels per-handle (`cancel_io`); each
  issuing thread observes the abort through its own event wait and drains
  before returning — an `Arc` liveness rule guarantees no issuing thread can
  be gone while a cancellation is in flight. This is a completeness rule
  about the OS I/O model, not a performance or ordering guarantee: an aborted
  operation may still have moved bytes before it was cancelled.
- **First-instance guard**: the first server handle is created with
  `FILE_FLAG_FIRST_PIPE_INSTANCE` and stays a listener for the whole server
  lifetime; a squatter that created the name first makes our creation FAIL
  (we never join a foreign server, and nobody can join ours). Replacement
  listener instances never carry the flag.
- **Client proof BEFORE the ready line or any payload**:
  `GetNamedPipeClientProcessId` (>0, API failure refuses) → the client process
  is opened and its token user SID must equal ours. The process handle stays
  open for the connection's life, so a recycled pid cannot inherit an
  admission. A foreign user gets a disconnect, never a decode.
- **Discovery metadata**: `%LOCALAPPDATA%\Abito\notices\endpoint.json`,
  `{v,pipe,pid,sid}` (closed key set; the pipe name must embed the same SID),
  written atomically (temp + `MoveFileExW`) where the temp file is CREATED
  with the explicit protected owner-only DACL in its `SECURITY_ATTRIBUTES`
  (B3) — the DACL exists at file creation, before a single byte is written,
  and the handle is non-inheritable, so no other user can open the file, not
  even transiently. Symlink/reparse-point/directory targets are refused;
  pre-existing temp files are never deleted (only the one the call itself
  created). There is **no** environment-variable path override on Windows;
  the location is canonical and the directory chain is ACL-verified.
  `close()` removes it only when it still names exactly our pipe and pid.

## Relay (`abito-notice-relay`)

Small stdio⇄pipe forwarder, no GUI. Before forwarding ANY byte it verifies:
the metadata file is a regular file (never a symlink) with a private parent
and an owner-only DACL (anything broader is refused — including SYSTEM or
Administrators entries, because we always publish exactly the owner); the
metadata pid is alive and runs as our user (stale metadata refuses; there is
no direct-connection fallback); and the connected pipe's
`GetNamedPipeServerProcessId` equals the metadata pid with that process's
token SID equal to ours. Forwarding is bounded (EOF, 5 s handshake, 30 s idle;
protocol heartbeats keep live sessions alive).

## Node daemon pipe — accepted caveat (L6)

The Node daemon creates its named pipe with Node's **default DACL**
(SYSTEM, Administrators and Creator Owner full control; Everyone and Anonymous
read). The island's client (`agentconn_win.rs`) still verifies the server's
pid + user SID from `session.json` before sending the secret, and the daemon
answers nothing before validating the launch token. Ordinary other local users
can open a read-only connection under that default DACL; they cannot normally
write a hello. Each unauthenticated connection is dropped within **2 seconds**,
but repeated opens can still consume resources or delay legitimate connections.
This timeout is not a guarantee against denial of service. No application data
is sent before authentication. This is accepted for v0.1.x by L6; the
follow-up is a Rust-owned same-user-only broker (the `winipc` helpers here —
SDDL server creation, pid+SID proof, owner-only file ACLs — are the building
blocks).

## Daemon token file and runtime discovery

`abito-private-session.exe` receives at most 4097 bytes on stdin and rejects
payloads over 4096 bytes before parsing or writing. Tokens never appear in its
arguments, environment, or diagnostics. It writes only `runtime/session.json`
inside `%LOCALAPPDATA%\Abito` (or an explicitly confined child root), using the
same creation-time owner-only DACL and atomic replacement as notice metadata.
The Windows CLI and daemon reject out-of-root overrides before creating state;
the native writer repeats the check. The island reader checks the session
file's own owner-only DACL, regular/non-reparse type and 4096-byte size bound,
then verifies the connected server PID and SID before sending the token.

Windows startup discovers `node.exe` and the installed npm package's validated
Pi JavaScript entry point. It does not execute `.cmd` shims or launch a shell.
Missing dependencies use the existing `node_missing` / `pi_missing` codes and
an actionable stderr message; the installed helpers must sit beside the island
executable. Native daemon integration proof is pending until its Windows CI
step passes; passing cross-compilation alone is not that proof.

## Known limits (honest test surface)

- The different-user receiver tests need an OS token fixture; what CI proves
  today is the same-user full path, the squat guard, metadata ACL rules, the
  relay pre-flight (right pid, wrong server pid, stale metadata, broadened
  ACL), the B1/B2 I/O discipline (timeout+drain then safe handle reuse,
  prompt idle-accept close, concurrent overlapped read/write on one handle)
  and the B3 creation-time owner-only DACL. The `client_admitted` verdict
  (including its fail-closed API-failure arm) is tested at policy level; a
  real distinct-user probe is runner-only CI work, not a local guarantee.
- Terminal origin (the «Ver» → focus the asking terminal feature) is a
  `/proc`-based Unix capability; on Windows the receiver never invents an
  origin and `origin_for` returns `None`.
