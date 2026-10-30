//! Unix-domain-socket receiver for the Pi → desktop notice transport — unit
//! M2.
//!
//! Port of `transport.cjs` (read-only legacy source) plus the receiver wiring
//! of `main.cjs`:
//! - same endpoint naming: `<runtime>/p-XXXXXX/s` (six alphanumerics from
//!   `mkdtemp`), same `ABITO_DESKTOP_SOCKET=…` line on stdout,
//! - same permissions and owner rules: runtime + generated dir 0700, socket
//!   0600, no symlink anywhere in the chain, world-writable parents refused,
//! - same quotas: [`protocol::CONNECTIONS`] clients, per-connection frame
//!   rate, handshake/idle deadlines, batch cap (pure half in [`protocol`]),
//! - owner check on the wire: the connecting peer's uid must equal ours
//!   (SO_PEERCRED — the Tauri counterpart of the legacy file-uid checks),
//! - stale/foreign paths are never removed: cleanup verifies dir and socket
//!   inode identity (dev/ino + is-socket) before unlinking, exactly like
//!   `transport.cjs close()`,
//! - the installed Preview's reserved roots (`$XDG_RUNTIME_DIR/abito-desktop`
//!   and `…-preview`) are refused outright — detection is read-only and this
//!   receiver never touches a socket it did not create.
//!
//! Env overrides:
//! - `ABITO_SOCKET_DIR` — transport runtime root for tests/probe (absolute,
//!   normalized, never a reserved Preview root).
//!
//! Legacy note: `transport.cjs` kept a private `NoticeStore` as a pre-filter
//! before `onNotice`. Its `accept()` is a deterministic function of the frame
//! sequence, and `main.cjs` re-accepted every event in its own store anyway,
//! so the single store at the snapshot boundary (app state) reproduces the
//! observable behaviour — same dedupe, same queue, same decisions.

use std::collections::{HashMap, HashSet};
use std::io::{ErrorKind, Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::protocol::{self, Message};
use crate::question::{self, Admission, HumanAnswer, Inbound, QuestionSlot, ResolutionStatus};
use crate::questioncmd::NativeTransition;
pub use crate::transport_view::{
    DeliveryState, FormItemView, HumanReplyError, PendingQuestionView, PreviewScan, QuestionDeliveryView,
    QuestionOptionView, QuestionOutcome, QuestionSnapshot, TransportError, TransportOptions,
    INSTALLED_RUNTIME_LEAF, RESERVED_RUNTIME_NAMES, SOCKET_DIR_ENV,
};

/// No transcript: at most eight unacknowledged, text-free delivery receipts.
const DELIVERY_LIMIT: usize = 8;
const WRITE_TIMEOUT: Duration = Duration::from_millis(500);

#[derive(Clone)]
struct QuestionOrigin { stream: Arc<UnixStream>, writer: Arc<Mutex<UnixStream>> }
struct Delivery { connection: u64, view: QuestionDeliveryView, expected: ResolutionStatus }
#[derive(Default)]
struct Questions {
    slot: QuestionSlot, origins: HashMap<u64, QuestionOrigin>, deliveries: Vec<Delivery>,
    ready: HashSet<u64>, failed_writes: HashSet<u64>, notice: Option<QuestionOutcome>,
    terminal_origins: HashMap<String, crate::sessionterm::Origin>,
}
impl Questions {
    fn prune_terminal_origins(&mut self) {
        self.terminal_origins.retain(|id, _| self.slot.queue().filter(|a| a.question().id() == id).count() == 1);
    }
    fn snapshot(&self) -> QuestionSnapshot {
        let view = |active: &question::Active| {
            let q = active.question();
            PendingQuestionView { id: q.id().into(), kind: q.kind(), text: q.text().into(),
                options: q.options().iter().enumerate().map(|(index, o)| QuestionOptionView {
                    index, label: o.label().into(), description: o.description().into(),
                }).collect(), allow_free_text: q.allow_free_text(), expires_at: q.expires_at(),
                agent: q.agent().into(), agent_label: q.agent_label(),
                project_name: q.project_name().map(str::to_owned),
                multi_select: q.multi_select(), free_text_max: q.free_text_max(),
                form: q.form().map(|items| items.iter().map(|i| FormItemView {
                    header: i.header().into(), text: i.text().into(), multi_select: i.multi_select(), allow_free_text: i.allow_free_text(),
                    options: i.options().iter().enumerate().map(|(index, o)| QuestionOptionView {
                        index, label: o.label().into(), description: o.description().into() }).collect(),
                }).collect()) }
        };
        let pending = self.slot.active().map(view);
        // Everyone waiting BEHIND the one shown, oldest first (the head is `pending`).
        let queued: Vec<PendingQuestionView> = self.slot.queue().skip(1).map(view).collect();
        QuestionSnapshot { pending, queued_count: queued.len(), queued, deliveries: self.deliveries.iter().map(|d| d.view.clone()).collect(),
            ready_connections: self.ready.len(), notice: self.notice, native_transition: NativeTransition::Idle }
    }
    /// No expiry wire reply is necessary. Frozen producer deadline only; no
    /// answer/default and no serialization failure can retain private text.
    fn prune(&mut self, now: u64) -> bool {
        // Every pending question keeps its OWN deadline, shown or waiting.
        let expired = self.slot.due(now);
        let before = self.deliveries.len();
        self.deliveries.retain(|d| now < d.view.expires_at);
        let lost = before != self.deliveries.len();
        if lost { self.notice = Some(QuestionOutcome::AckLost); }
        for connection in &expired {
            self.slot.disconnect(*connection); self.origins.remove(connection);
        }
        if !expired.is_empty() { self.notice = Some(QuestionOutcome::Expired); }
        self.prune_terminal_origins();
        !expired.is_empty() || lost
    }
    fn revoke(&mut self, connection: u64, outcome: QuestionOutcome) -> bool {
        let pending = self.slot.disconnect(connection);
        if pending { self.origins.remove(&connection); }
        self.prune_terminal_origins();
        let before = self.deliveries.len();
        self.deliveries.retain(|d| d.connection != connection);
        let changed = pending || before != self.deliveries.len();
        if changed { self.notice = Some(outcome); }
        changed
    }
    /// The caller holds the single question mutex throughout this function.
    /// The writer closure is also the deterministic partial-write test seam.
    fn human_with(&mut self, id: &str, answer: Option<HumanAnswer>, now: u64,
        write: impl FnOnce(&QuestionOrigin, &[u8]) -> std::io::Result<()>) -> Result<(), HumanReplyError> {
        let active = self.slot.active().filter(|a| a.question().id() == id)
            .ok_or(HumanReplyError::Validation(question::Error::NotLive))?;
        let connection = active.connection_id();
        let identity = active.identity().clone();
        let expiry = active.question().expires_at();
        let expected = if answer.is_some() { ResolutionStatus::Answered } else { ResolutionStatus::HumanCancelled };
        let prepared = match answer {
            Some(answer) => self.slot.prepare_answer(connection, &identity, id, answer, now),
            None => self.slot.prepare_decline(connection, &identity, id, now),
        }.map_err(HumanReplyError::Validation)?;
        let origin = self.origins.get(&connection).expect("live question origin").clone();
        if write(&origin, prepared.line()).is_err() {
            // Delivery might already have happened: never restore or retry.
            self.failed_writes.insert(connection);
            self.revoke(connection, QuestionOutcome::OutcomeUnknown);
            let _ = origin.stream.shutdown(std::net::Shutdown::Both);
            return Err(HumanReplyError::OutcomeUnknown);
        }
        self.slot.commit_delivery(prepared).expect("same locked generation");
        self.origins.remove(&connection);
        self.terminal_origins.remove(id);
        self.deliveries.push(Delivery { connection, expected,
            view: QuestionDeliveryView { id: id.into(), expires_at: expiry, state: DeliveryState::Sent } });
        self.notice = Some(QuestionOutcome::Sent);
        Ok(())
    }
}

fn write_line(writer: &Mutex<UnixStream>, line: &[u8]) -> std::io::Result<()> {
    let mut writer = writer.lock().expect("origin writer lock");
    writer.set_write_timeout(Some(WRITE_TIMEOUT))?;
    writer.write_all(line)
}

// --- path / runtime policy (fs-free, unit-tested) ---------------------------

fn uid() -> u32 {
    // SAFETY: getuid has no preconditions.
    unsafe { libc::getuid() }
}

/// Absolute AND normalized in the JS `path.normalize` sense: no `//`, no
/// `.`, no `..` segments, no trailing slash (packaged.cjs/adapter.cjs
/// reject anything else before any filesystem work).
fn is_absolute_normalized(text: &str) -> bool {
    if !text.starts_with('/') {
        return false;
    }
    text.split('/')
        .skip(1)
        .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

/// `p-[a-zA-Z0-9]{6}` — the exact generated directory name shape
/// (transport.cjs line 48 / packaged.cjs endpoint rule).
fn is_generated_dir_name(name: &str) -> bool {
    match name.strip_prefix("p-") {
        Some(rest) => rest.len() == 6 && rest.bytes().all(|byte| byte.is_ascii_alphanumeric()),
        None => false,
    }
}

/// Reserved-root check (packaged.cjs `IDENTITIES`): true when `path` IS or
/// LIES UNDER `/run/user/<uid>/abito-desktop` or `…/abito-desktop-preview`.
/// Those belong to the installed Preview — never touch, unlink or connect.
pub fn runtime_allowed(path: &Path, xdg_runtime_dir: Option<&str>) -> bool {
    let base = match xdg_runtime_dir {
        Some(value) => PathBuf::from(value),
        None => PathBuf::from(format!("/run/user/{}", uid())),
    };
    !RESERVED_RUNTIME_NAMES.iter().any(|name| {
        let root = base.join(name);
        path == root || path.starts_with(&root)
    })
}

/// Resolve the runtime root: `ABITO_SOCKET_DIR` override (absolute,
/// normalized, never reserved) or the default `<crate>/.runtime`.
pub fn resolve_runtime_from(
    override_dir: Option<&str>,
    default: &Path,
    xdg_runtime_dir: Option<&str>,
) -> Result<PathBuf, TransportError> {
    let path = match override_dir {
        Some(text) => {
            if !is_absolute_normalized(text) {
                return Err(TransportError::InvalidOverride);
            }
            PathBuf::from(text)
        }
        None => default.to_path_buf(),
    };
    if !runtime_allowed(&path, xdg_runtime_dir) {
        return Err(TransportError::ReservedPreviewRoot);
    }
    Ok(path)
}

/// Build-tree path baked by cargo — compiled ONLY into debug (dev) builds. A
/// release/packaged binary carries no pointer to the source tree at all.
#[cfg(debug_assertions)]
fn dev_manifest_dir() -> Option<&'static str> {
    option_env!("CARGO_MANIFEST_DIR")
}
#[cfg(not(debug_assertions))]
fn dev_manifest_dir() -> Option<&'static str> {
    None
}

/// The per-user runtime base directory. Linux: `$XDG_RUNTIME_DIR` as given (validated by the
/// callers). macOS has no XDG dir: the per-user temp dir from `confstr(_CS_DARWIN_USER_TEMP_DIR)`,
/// canonicalized (`/var` is a symlink to `/private/var`, and `directory_chain` rejects symlinks).
#[cfg(target_os = "linux")]
fn runtime_base_env() -> Option<String> {
    std::env::var("XDG_RUNTIME_DIR").ok()
}
#[cfg(target_os = "macos")]
fn runtime_base_env() -> Option<String> {
    let mut buffer = [0 as libc::c_char; 1024];
    // SAFETY: the buffer pointer and its length describe one writable allocation.
    let length = unsafe { libc::confstr(libc::_CS_DARWIN_USER_TEMP_DIR, buffer.as_mut_ptr(), buffer.len()) };
    if length == 0 || length > buffer.len() {
        return None;
    }
    // SAFETY: confstr NUL-terminates within `length` bytes on success.
    let text = unsafe { std::ffi::CStr::from_ptr(buffer.as_ptr()) }.to_str().ok()?.to_owned();
    let canonical = std::fs::canonicalize(text.trim_end_matches('/')).ok()?;
    canonical.to_str().map(str::to_owned)
}

/// Longest endpoint path `bind` accepts: `sockaddr_un.sun_path` is 108 bytes on Linux and 104 on
/// macOS, both including the terminating NUL.
#[cfg(target_os = "linux")]
pub const SUN_PATH_MAX: usize = 107;
#[cfg(target_os = "macos")]
pub const SUN_PATH_MAX: usize = 103;

/// Pure choice of the default root. `Some(manifest)` = dev layout
/// (`<crate>/.runtime`, the one the legacy app used); `None` = installed
/// layout `$XDG_RUNTIME_DIR/abito-island`, which needs an absolute,
/// normalized XDG dir and otherwise refuses (no invented location).
pub fn default_runtime_for(
    xdg_runtime_dir: Option<&str>,
    dev_manifest: Option<&str>,
) -> Result<PathBuf, TransportError> {
    if let Some(manifest) = dev_manifest {
        return Ok(Path::new(manifest).join(".runtime"));
    }
    let xdg = xdg_runtime_dir
        .filter(|text| is_absolute_normalized(text))
        .ok_or(TransportError::NoRuntimeRoot)?;
    Ok(Path::new(xdg).join(INSTALLED_RUNTIME_LEAF))
}

/// Default runtime root: dev layout in debug builds, the installed own leaf
/// in release builds (never the source tree).
pub fn default_runtime() -> Result<PathBuf, TransportError> {
    let xdg = runtime_base_env();
    default_runtime_for(xdg.as_deref(), dev_manifest_dir())
}

/// Runtime root for this process (`ABITO_SOCKET_DIR` or the default).
pub fn resolve_runtime() -> Result<PathBuf, TransportError> {
    let override_dir = std::env::var(SOCKET_DIR_ENV).ok();
    let default = default_runtime()?;
    let xdg = runtime_base_env();
    resolve_runtime_from(override_dir.as_deref(), &default, xdg.as_deref())
}

// --- filesystem rules (transport.cjs lines 11-44) ---------------------------

/// Walk every component from `/` down: directory, not symlink, owned by root
/// or us, never world-writable (`stat.mode & 0o002`).
pub fn directory_chain(target: &Path) -> Result<(), TransportError> {
    let owner = uid();
    let resolved = if target.is_absolute() {
        target.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(TransportError::Io)?
            .join(target)
    };
    let text = resolved.to_string_lossy().into_owned();
    let mut current = PathBuf::from("/");
    for segment in text.split('/').filter(|part| !part.is_empty()) {
        current.push(segment);
        let metadata = std::fs::symlink_metadata(&current).map_err(TransportError::Io)?;
        let file_type = metadata.file_type();
        if !file_type.is_dir() // lstat: a symlink is never a directory
            || file_type.is_symlink()
            || (metadata.uid() != 0 && metadata.uid() != owner)
            || (metadata.mode() & 0o002) != 0
        {
            return Err(TransportError::UnsafeDirectoryChain);
        }
    }
    Ok(())
}

/// `directory_chain` + exact `0700` + ours; returns the lstat metadata.
pub fn private_directory(target: &Path) -> Result<std::fs::Metadata, TransportError> {
    directory_chain(target)?;
    let metadata = std::fs::symlink_metadata(target).map_err(TransportError::Io)?;
    if metadata.uid() != uid() || (metadata.mode() & 0o7777) != 0o700 {
        return Err(TransportError::PrivateDirectoryRequired);
    }
    Ok(metadata)
}

/// Prepare the runtime root (chain check, mkdir 0700, private check).
pub fn prepare_runtime(runtime: &Path) -> Result<PathBuf, TransportError> {
    let parent = runtime.parent().ok_or(TransportError::UnexpectedEndpoint)?;
    directory_chain(parent)?;
    match std::fs::DirBuilder::new().mode(0o700).create(runtime) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
        Err(error) => return Err(TransportError::Io(error)),
    }
    private_directory(runtime)?;
    Ok(runtime.to_path_buf())
}

/// `verifyEndpoint`: exact `<runtime>/p-XXXXXX/s` shape, both dirs private,
/// endpoint an owned 0600 socket and not a symlink.
pub fn verify_endpoint(endpoint: &Path, runtime: &Path) -> Result<(), TransportError> {
    let endpoint_text = endpoint.to_str().ok_or(TransportError::UnexpectedEndpoint)?;
    let runtime_text = runtime.to_str().ok_or(TransportError::UnexpectedEndpoint)?;
    if !endpoint.is_absolute()
        || !is_absolute_normalized(endpoint_text)
        || !runtime.is_absolute()
        || !is_absolute_normalized(runtime_text)
    {
        return Err(TransportError::UnexpectedEndpoint);
    }
    let parent = endpoint.parent().ok_or(TransportError::UnexpectedEndpoint)?;
    let grandparent = parent.parent().ok_or(TransportError::UnexpectedEndpoint)?;
    if grandparent != Path::new(runtime_text) {
        return Err(TransportError::UnexpectedEndpoint);
    }
    if endpoint.file_name().map(|name| name == "s") != Some(true) {
        return Err(TransportError::UnexpectedEndpoint);
    }
    let generated = parent
        .file_name()
        .map(|name| is_generated_dir_name(&name.to_string_lossy()))
        .unwrap_or(false);
    if !generated {
        return Err(TransportError::UnexpectedEndpoint);
    }
    private_directory(runtime)?;
    private_directory(parent)?;
    let metadata = std::fs::symlink_metadata(endpoint).map_err(TransportError::Io)?;
    let file_type = metadata.file_type();
    if !file_type.is_socket()
        || file_type.is_symlink()
        || metadata.uid() != uid()
        || (metadata.mode() & 0o7777) != 0o600
    {
        return Err(TransportError::UnsafeSocket);
    }
    Ok(())
}

// --- detection (read-only) ---------------------------------------------------

/// List socket files directly under `root` (presence only — a stale socket
/// and a live one look identical without connecting, which we never do).
pub fn detect_sockets(root: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else {
        return found;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy().into_owned();
        if !is_generated_dir_name(&name) {
            continue;
        }
        // lstat only: a symlinked p- dir is never followed.
        let Ok(directory) = std::fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if !directory.file_type().is_dir() || directory.file_type().is_symlink() {
            continue;
        }
        let endpoint = entry.path().join("s");
        let Ok(socket) = std::fs::symlink_metadata(&endpoint) else {
            continue;
        };
        if socket.file_type().is_socket() && !socket.file_type().is_symlink() {
            found.push(endpoint);
        }
    }
    found.sort();
    found
}

/// Read-only scan of the two reserved Preview roots (report in the probe).
pub fn preview_scan() -> Vec<PreviewScan> {
    let base = runtime_base_env().unwrap_or_else(|| format!("/run/user/{}", uid()));
    RESERVED_RUNTIME_NAMES
        .iter()
        .map(|name| {
            let root = format!("{base}/{name}");
            PreviewScan {
                root: root.clone(),
                sockets: detect_sockets(Path::new(&root))
                    .iter()
                    .map(|path| path.display().to_string())
                    .collect(),
                // detection reports presence only: live-vs-stale is not
                // guessed, because guessing would mean connecting — never.
            }
        })
        .collect()
}

// --- the receiver ------------------------------------------------------------

struct Client {
    identified: bool,
    stream: Arc<UnixStream>,
}

struct Inner {
    endpoint: PathBuf,
    runtime: PathBuf,
    directory: PathBuf,
    directory_dev: u64,
    directory_ino: u64,
    /// (dev, ino) of the socket we bound — cleanup refuses any other.
    socket_id: Option<(u64, u64)>,
    running: AtomicBool,
    closed: AtomicBool,
    next_id: AtomicU64,
    clients: Mutex<HashMap<u64, Client>>,
    listener: Mutex<Option<std::thread::JoinHandle<()>>>,
    handlers: Mutex<Vec<std::thread::JoinHandle<()>>>,
    project: String,
    handshake_ms: u64,
    idle_ms: u64,
    /// Legacy `transport.cjs` kept its own `NoticeStore` as the gate for
    /// `onNotice`: only an accepted `settled` reaches the app (heartbeats,
    /// dedupe and the queue are filtered here first, exactly as before).
    store: Mutex<protocol::NoticeStore>,
    on_notice: Box<dyn Fn(Message) + Send + Sync>,
    terminal_origins: Mutex<HashMap<String, crate::sessionterm::Origin>>,
    resolve_origin: Box<dyn Fn(&crate::sessionterm::ProcInfo) -> Option<crate::sessionterm::Origin> + Send + Sync>,
    on_connections: Box<dyn Fn(u32) + Send + Sync>,
    on_failure: Box<dyn Fn(protocol::TransportFailure) + Send + Sync>,
    reporting: Mutex<()>,
    questions: Mutex<Questions>,
    on_question_change: Box<dyn Fn() + Send + Sync>,
}

impl Inner {
    fn question_changed(&self) {
        // Observer panics cannot kill the expiry worker or poison live state.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (self.on_question_change)()));
    }
    fn expire_questions(&self) {
        {
            let mut store = self.store.lock().expect("transport notice store");
            let notices = store.snapshot(now_ms());
            self.terminal_origins.lock().expect("terminal origins").retain(|id, _|
                notices.iter().filter(|n| &n.id == id).count() == 1);
        }
        let changed = self.questions.lock().expect("questions lock").prune(now_ms());
        if changed { self.question_changed(); }
    }
    /// `transport.cjs report()`: clients that completed the handshake.
    fn report(&self) { self.report_failure(None); }
    fn report_failure(&self, failure: Option<protocol::TransportFailure>) {
        // Serialize count + failure publication against concurrent reconnects.
        let _reporting = self.reporting.lock().expect("reporting lock");
        let identified = self
            .clients
            .lock()
            .expect("clients lock")
            .values()
            .filter(|client| client.identified)
            .count() as u32;
        if let Some(failure) = failure { (self.on_failure)(failure); }
        (self.on_connections)(identified);
    }
}

/// A bound receiver. `close()` (or dropping it) performs the identity-checked
/// cleanup; it is idempotent.
pub struct Transport {
    inner: Arc<Inner>,
}

impl Transport {
    /// Host-only lookup. Unknown, ambiguous, expired and already-removed ids never fall back.
    pub fn origin_for(&self, request: &crate::focushost::OriginRequest) -> Option<crate::sessionterm::Origin> {
        if !self.inner.running.load(Ordering::SeqCst) { return None; }
        match request.kind {
            crate::focushost::OriginKind::Notice => {
                let mut store = self.inner.store.lock().expect("transport notice store");
                let notices = store.snapshot(now_ms());
                let mut origins = self.inner.terminal_origins.lock().expect("terminal origins");
                origins.retain(|id, _| notices.iter().filter(|n| &n.id == id).count() == 1);
                origins.get(&request.id).cloned()
            }
            crate::focushost::OriginKind::Pending => {
                let q = self.inner.questions.lock().expect("questions lock");
                // Read-only here: the expiry worker owns pruning + publishing its transition.
                let now = now_ms();
                if q.slot.queue().filter(|a| a.question().id() == request.id && a.question().expires_at() > now).count() != 1 { return None; }
                q.terminal_origins.get(&request.id).cloned()
            }
        }
    }
    /// The app owns visible notice dismissal; synchronize that lifecycle without publishing identities.
    pub fn forget_notice_origins(&self, ids: &[String]) {
        self.inner.terminal_origins.lock().expect("terminal origins").retain(|id, _| !ids.contains(id));
    }

    /// The `ABITO_DESKTOP_SOCKET=…` path the producer connects to.
    pub fn endpoint(&self) -> &Path {
        &self.inner.endpoint
    }

    pub fn runtime(&self) -> &Path {
        &self.inner.runtime
    }

    pub fn question_snapshot(&self) -> QuestionSnapshot {
        let (snapshot, changed) = {
            let mut q = self.inner.questions.lock().expect("questions lock");
            let changed = q.prune(now_ms()); (q.snapshot(), changed)
        };
        if changed { self.inner.question_changed(); }
        snapshot
    }
    /// Read-only budget for the matching live slot. No prune, ticket commit,
    /// origin write or private scope is exposed. Send revalidates at its own time.
    pub fn question_text_budget(&self, id: &str, text: &str) -> Result<crate::questioncmd::TextBudget, question::Error> {
        let q = self.inner.questions.lock().expect("questions lock");
        crate::questioncmd::text_budget(&q.slot, id, text, now_ms())
    }
    /// Click-only navigation guard. Fresh clock sampled AFTER admission lock;
    /// no prune/delivery/persistence changes. Callback may commit core/phase,
    /// but MUST NOT publish, reenter transport or call native/window methods.
    pub fn with_question_click<T>(&self, id: &str, operation: impl FnOnce() -> T) -> Result<T, crate::bridge::BridgeError> {
        let q = self.inner.questions.lock().expect("questions lock");
        let now = now_ms();
        if !q.slot.active().is_some_and(|active|
            active.question().id() == id && active.question().expires_at() > now) {
            return Err(crate::bridge::BridgeError::denied("notice is not current"));
        }
        Ok(operation())
    }
    /// Host geometry transaction: admission cannot race the pending check and
    /// inline runtime resize call. This does not await queued backend/WM work.
    /// The closure MUST NOT reenter transport or publish questions.
    /// Conservative: an unpruned expired slot also blocks until normal expiry.
    pub fn with_question_pending<T>(&self, operation: impl FnOnce(bool) -> T) -> T {
        let q = self.inner.questions.lock().expect("questions lock");
        operation(q.slot.active().is_some())
    }
    /// Host-only entry points. UI supplies exactly an id and index/text, never
    /// scope/source/connection or an opaque wire token. Trusted human input must
    /// still be enforced by the later closed IPC/UI gate; this is not attestation.
    pub fn answer(&self, id: &str, index: usize) -> Result<(), HumanReplyError> {
        self.human_reply(id, Some(HumanAnswer::Option { index }))
    }
    pub fn answer_text(&self, id: &str, text: String) -> Result<(), HumanReplyError> {
        self.human_reply(id, Some(HumanAnswer::Text { text }))
    }
    pub fn answer_many(&self, id: &str, indexes: Vec<usize>, text: Option<String>) -> Result<(), HumanReplyError> {
        self.human_reply(id, Some(HumanAnswer::Options { indexes, text }))
    }
    pub fn answer_form(&self, id: &str, answers: Vec<question::ItemAnswer>) -> Result<(), HumanReplyError> {
        self.human_reply(id, Some(HumanAnswer::Form { answers }))
    }
    pub fn decline(&self, id: &str) -> Result<(), HumanReplyError> {
        self.human_reply(id, None)
    }
    fn human_reply(&self, id: &str, answer: Option<HumanAnswer>) -> Result<(), HumanReplyError> {
        let (result, changed) = {
            let mut q = self.inner.questions.lock().expect("questions lock");
            let pruned = q.prune(now_ms());
            let result = q.human_with(id, answer, now_ms(), |origin, line| write_line(&origin.writer, line));
            let changed = pruned || result.is_ok() || result == Err(HumanReplyError::OutcomeUnknown);
            (result, changed)
        };
        if changed { self.inner.question_changed(); }
        result
    }

    /// Legacy `close()`: stop accepting, destroy clients, verify dir + socket
    /// inode identity, unlink only our own socket, rmdir only our own (empty)
    /// dir. Idempotent; foreign paths are never removed.
    pub fn close(&self) -> Result<(), TransportError> {
        if self.inner.closed.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        self.inner.running.store(false, Ordering::SeqCst);
        // 1. stop accepting before sweeping clients, so no client can be
        //    inserted after the sweep (legacy: destroy clients, then close).
        if let Some(handle) = self
            .inner
            .listener
            .lock()
            .expect("listener lock")
            .take()
        {
            join_other_thread(handle);
        }
        let streams: Vec<Arc<UnixStream>> = self
            .inner
            .clients
            .lock()
            .expect("clients lock")
            .values()
            .map(|client| client.stream.clone())
            .collect();
        for stream in streams {
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
        let handlers: Vec<std::thread::JoinHandle<()>> =
            std::mem::take(&mut *self.inner.handlers.lock().expect("handlers lock"));
        for handle in handlers {
            join_other_thread(handle);
        }
        self.inner.terminal_origins.lock().expect("terminal origins").clear();
        self.inner.questions.lock().expect("questions lock").terminal_origins.clear();
        cleanup(
            &self.inner.directory,
            self.inner.directory_dev,
            self.inner.directory_ino,
            &self.inner.endpoint,
            self.inner.socket_id,
        )
    }
}

impl Drop for Transport {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

fn join_other_thread(handle: std::thread::JoinHandle<()>) {
    // A host callback can close/drop the receiver on its own read/expiry
    // thread. Detach only that current handle; shutdown/running=false ensures
    // it finishes on return. Joining ourselves would panic or deadlock.
    if handle.thread().id() != std::thread::current().id() {
        let _ = handle.join();
    }
}

/// Identity-checked cleanup (transport.cjs lines 91-106): only the exact dir
/// and socket this process created may disappear, and the dir must be empty
/// (a foreign file makes rmdir fail — it is kept, never forced).
fn cleanup(
    directory: &Path,
    directory_dev: u64,
    directory_ino: u64,
    endpoint: &Path,
    socket_id: Option<(u64, u64)>,
) -> Result<(), TransportError> {
    let metadata = std::fs::symlink_metadata(directory).map_err(|_| {
        TransportError::CleanupIdentityChanged
    })?;
    if metadata.file_type().is_symlink()
        || metadata.dev() != directory_dev
        || metadata.ino() != directory_ino
    {
        return Err(TransportError::CleanupIdentityChanged);
    }
    if let Some((socket_dev, socket_ino)) = socket_id {
        if let Ok(socket) = std::fs::symlink_metadata(endpoint) {
            if socket.dev() != socket_dev
                || socket.ino() != socket_ino
                || !socket.file_type().is_socket()
            {
                return Err(TransportError::CleanupSocketChanged);
            }
            std::fs::remove_file(endpoint).map_err(TransportError::Io)?;
        }
    }
    std::fs::remove_dir(directory).map_err(TransportError::Io)?;
    Ok(())
}

fn fail_with(
    error: TransportError,
    directory: &Path,
    directory_dev: u64,
    directory_ino: u64,
    endpoint: &Path,
    socket_id: Option<(u64, u64)>,
) -> TransportError {
    // legacy createTransport: `catch { await close(); throw error }` — the
    // original error is what the caller sees.
    if let Err(cleanup_error) = cleanup(directory, directory_dev, directory_ino, endpoint, socket_id) {
        eprintln!("transport startup cleanup refused: {cleanup_error}");
    }
    error
}

/// Node `fs.mkdtempSync(path.join(runtime, 'p-'))`: six alphanumerics after
/// `p-`, directory mode 0700, retry on collision.
fn mkdtemp(runtime: &Path) -> Result<PathBuf, TransportError> {
    const CHARS: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let mut seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos() as u64)
        .unwrap_or(0)
        ^ (u64::from(std::process::id()) << 32);
    for _ in 0..1000 {
        let mut name = String::with_capacity(8);
        name.push_str("p-");
        for _ in 0..6 {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            name.push(CHARS[(seed >> 33) as usize % CHARS.len()] as char);
        }
        let candidate = runtime.join(&name);
        match std::fs::DirBuilder::new().mode(0o700).create(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(TransportError::Io(error)),
        }
    }
    Err(TransportError::Io(std::io::Error::new(
        ErrorKind::AlreadyExists,
        "mkdtemp: no free directory slot",
    )))
}

/// SO_PEERCRED: the peer's uid and pid (None if the kernel refuses the call —
/// then the peer is not admitted: fail closed on the owner check).
#[cfg(target_os = "linux")]
fn peer_credentials(stream: &UnixStream) -> Option<(u32, u32)> {
    use std::os::unix::io::AsRawFd;
    let mut credentials = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            &mut credentials as *mut libc::ucred as *mut libc::c_void,
            &mut length,
        )
    };
    (result == 0 && credentials.pid > 0).then_some((credentials.uid, credentials.pid as u32))
}

/// macOS: `getpeereid` (the LOCAL_PEERCRED query) for the owner check, `LOCAL_PEERPID` for the peer's pid (0 when the
/// kernel will not say: the terminal origin then stays unknown). Any `getpeereid` error means the peer is not admitted.
#[cfg(target_os = "macos")]
fn peer_credentials(stream: &UnixStream) -> Option<(u32, u32)> {
    use std::os::unix::io::AsRawFd;
    let (mut uid, mut gid): (libc::uid_t, libc::gid_t) = (0, 0);
    // SAFETY: the fd is open for the whole call; both out-pointers are valid locals.
    let result = unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) };
    (result == 0).then(|| (uid, crate::sessionterm_mac::peer_pid(stream.as_raw_fd()).unwrap_or(0)))
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0)
}

fn now_ms() -> u64 {
    now_millis() as u64
}

/// Bind a fresh `<runtime>/p-XXXXXX/s`, serve clients on threads, report
/// notices and identified-connection counts through the callbacks.
pub fn create_transport(options: TransportOptions) -> Result<Transport, TransportError> {
    create_transport_observed(options, |_| {})
}

/// Host failure observer, separate from connection counts: normal hook EOF
/// updates presence without inventing a failure. No wire capability is needed.
pub fn create_transport_observed(options: TransportOptions,
    on_failure: impl Fn(protocol::TransportFailure) + Send + Sync + 'static,
) -> Result<Transport, TransportError> {
    create_transport_with_origin_resolver(options, on_failure, crate::sessionterm::capture_peer_origin)
}

/// Host-side injection seam: credentials are always read from the kernel; only resolution is injectable.
pub fn create_transport_with_origin_resolver(options: TransportOptions,
    on_failure: impl Fn(protocol::TransportFailure) + Send + Sync + 'static,
    resolve_origin: impl Fn(&crate::sessionterm::ProcInfo) -> Option<crate::sessionterm::Origin> + Send + Sync + 'static,
) -> Result<Transport, TransportError> {
    let TransportOptions {
        runtime,
        project,
        handshake_ms,
        idle_ms,
        on_notice,
        on_connections,
        on_question_change,
    } = options;

    prepare_runtime(&runtime)?;
    let directory = mkdtemp(&runtime)?;
    let directory_stat = private_directory(&directory)?;
    let (directory_dev, directory_ino) = (directory_stat.dev(), directory_stat.ino());
    let endpoint = directory.join("s");
    let mut socket_id: Option<(u64, u64)> = None;

    // Linux sockaddr_un has a 108-byte field, including the terminating NUL
    // (transport.cjs line 112) — checked after mkdtemp, like the legacy try.
    if endpoint.as_os_str().as_bytes().len() > SUN_PATH_MAX {
        return Err(fail_with(
            TransportError::PathTooLong,
            &directory,
            directory_dev,
            directory_ino,
            &endpoint,
            socket_id,
        ));
    }
    let listener = match UnixListener::bind(&endpoint) {
        Ok(listener) => listener,
        Err(error) => {
            return Err(fail_with(
                TransportError::Io(error),
                &directory,
                directory_dev,
                directory_ino,
                &endpoint,
                socket_id,
            ))
        }
    };
    if let Err(error) =
        std::fs::set_permissions(&endpoint, std::fs::Permissions::from_mode(0o600))
    {
        return Err(fail_with(
            TransportError::Io(error),
            &directory,
            directory_dev,
            directory_ino,
            &endpoint,
            socket_id,
        ));
    }
    // Record the socket identity immediately: every later exit goes through
    // the identity-checked unlink and can never remove a foreign inode.
    match std::fs::symlink_metadata(&endpoint) {
        Ok(metadata) => socket_id = Some((metadata.dev(), metadata.ino())),
        Err(error) => {
            return Err(fail_with(
                TransportError::Io(error),
                &directory,
                directory_dev,
                directory_ino,
                &endpoint,
                socket_id,
            ))
        }
    }
    if let Err(error) = verify_endpoint(&endpoint, &runtime) {
        return Err(fail_with(
            error,
            &directory,
            directory_dev,
            directory_ino,
            &endpoint,
            socket_id,
        ));
    }

    let inner = Arc::new(Inner {
        endpoint: endpoint.clone(),
        runtime: runtime.clone(),
        directory: directory.clone(),
        directory_dev,
        directory_ino,
        socket_id,
        running: AtomicBool::new(true),
        closed: AtomicBool::new(false),
        next_id: AtomicU64::new(1),
        clients: Mutex::new(HashMap::new()),
        listener: Mutex::new(None),
        handlers: Mutex::new(Vec::new()),
        project: project.clone(),
        handshake_ms,
        idle_ms,
        terminal_origins: Mutex::new(HashMap::new()),
        resolve_origin: Box::new(resolve_origin),
        store: Mutex::new(protocol::NoticeStore::new(project)),
        on_notice,
        on_connections,
        on_failure: Box::new(on_failure),
        reporting: Mutex::new(()),
        on_question_change,
        questions: Mutex::new(Questions::default()),
    });

    let accept_inner = inner.clone();
    let spawned = std::thread::Builder::new()
        .name("abito-accept".into())
        .spawn(move || accept_loop(accept_inner, listener));
    let handle = match spawned {
        Ok(handle) => handle,
        Err(error) => {
            return Err(fail_with(
                TransportError::Io(error),
                &directory,
                directory_dev,
                directory_ino,
                &endpoint,
                socket_id,
            ))
        }
    };
    *inner.listener.lock().expect("listener lock") = Some(handle);
    Ok(Transport { inner })
}

fn accept_loop(inner: Arc<Inner>, listener: UnixListener) {
    let _ = listener.set_nonblocking(true);
    while inner.running.load(Ordering::SeqCst) {
        inner.expire_questions();
        // The expiry observer may have closed us on this very accept thread.
        if !inner.running.load(Ordering::SeqCst) { break; }
        match listener.accept() {
            Ok((stream, _)) => {
                // Owner check on the wire: same-uid peer only (SO_PEERCRED).
                // The 0600 socket already limits the filesystem side; this is
                // the transport-level counterpart the task asks for.
                let Some((_, peer_pid)) = peer_credentials(&stream).filter(|(owner, _)| *owner == uid()) else {
                    drop(stream);
                    continue;
                };
                // Freeze the kernel peer's birth identity now; resolution rechecks it at event admission.
                let peer = crate::sessionterm::read_peer(peer_pid);
                let id = inner.next_id.fetch_add(1, Ordering::SeqCst);
                let prepared = {
                    let mut clients = inner.clients.lock().expect("clients lock");
                    if clients.len() >= protocol::CONNECTIONS {
                        // legacy line 56: `socket.destroy()` — never counted.
                        None
                    } else {
                        let _ = stream.set_nonblocking(false);
                        let shared = Arc::new(stream);
                        clients.insert(
                            id,
                            Client {
                                identified: false,
                                stream: shared.clone(),
                            },
                        );
                        Some(shared)
                    }
                };
                let Some(stream) = prepared else {
                    continue;
                };
                let thread_inner = inner.clone();
                let spawned = std::thread::Builder::new()
                    .name(format!("abito-client-{id}"))
                    .spawn(move || handle_connection(thread_inner, id, stream, peer));
                match spawned {
                    Ok(handle) => {
                        let mut handlers = inner.handlers.lock().expect("handlers lock");
                        handlers.retain(|handle| !handle.is_finished());
                        handlers.push(handle);
                    }
                    Err(_) => {
                        inner.clients.lock().expect("clients lock").remove(&id);
                        inner.report();
                    }
                }
            }
            Err(ref error) if error.kind() == ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => {
                inner.report_failure(Some(protocol::TransportFailure::Unavailable));
                return;
            }
        }
    }
}

/// Transport-local framing; the legacy protocol module stays byte-for-byte
/// unchanged. Identification allows question negotiation in this buffer;
/// subscription still gates admission and never widens legacy decode.
#[derive(Default)]
struct QuestionFramer { pending: Vec<u8>, structured: bool }
impl QuestionFramer {
    fn push(&mut self, chunk: &[u8], identified: bool) -> Result<protocol::Framed, ()> {
        // After v1 identification, allow a full-size questions_hello as well.
        // This is framing permission, NOT subscription or admission authority.
        // A connection that negotiated `structured:1` may send frames up to STRUCTURED_FRAME_BYTES; the batch
        // bound stays proportionate (two frames). Everyone else keeps the original caps exactly.
        let structured = identified && self.structured;
        let cap = if structured { question::STRUCTURED_FRAME_BYTES } else if identified { question::FRAME_BYTES } else { protocol::FRAME_BYTES };
        let batch = if structured { cap * 2 } else { cap * protocol::BATCH_FACTOR };
        if self.pending.len() + chunk.len() > batch { return Err(()); }
        self.pending.extend_from_slice(chunk);
        let mut frames = Vec::new();
        let mut start = 0;
        let mut legacy_bytes = 0;
        for (end, &byte) in self.pending.iter().enumerate() {
            if byte == b'\n' {
                let frame = &self.pending[start..end];
                // Classification only affects the tighter legacy batch bound.
                // Both real decoders still enforce their original full schema,
                // UTF-8, per-type byte bound and connection/opt-in authority.
                let qp = serde_json::from_slice::<serde_json::Value>(frame).ok()
                    .and_then(|v| v.get("type").and_then(|t| t.as_str()).map(|t| matches!(t,
                        "questions_hello" | "question" | "question_cancel" |
                        "question_resolved" | "question_answer_rejected"))).unwrap_or(false);
                if !qp { legacy_bytes += end + 1 - start; }
                if legacy_bytes > protocol::FRAME_BYTES * protocol::BATCH_FACTOR { return Err(()); }
                frames.push(frame.to_vec()); start = end + 1;
            }
        }
        self.pending.drain(..start);
        let fatal = (self.pending.len() > cap).then_some(protocol::FramingError::OversizedTail);
        Ok(protocol::Framed { frames, fatal })
    }
}

#[allow(clippy::too_many_arguments)] // per-connection negotiation flags travel by reference, as before
fn receive_question(inner: &Inner, connection: u64, identity: &protocol::Identity,
    origin: &QuestionOrigin, peer: Option<&crate::sessionterm::ProcInfo>, subscribed: &mut bool, busy_reason_supported: &mut bool, structured_supported: &mut bool, inbound: Inbound) -> bool {
    if matches!(inbound, Inbound::Hello | Inbound::HelloBusyReason | Inbound::HelloStructured { .. }) {
        let (requested, structured) = match inbound {
            Inbound::HelloBusyReason => (true, false),
            Inbound::HelloStructured { busy_reason } => (busy_reason, true),
            _ => (false, false),
        };
        let ready = question::questions_ready_line(requested, structured);
        if *subscribed || write_line(&origin.writer, &ready).is_err() { return false; }
        *subscribed = true;
        *busy_reason_supported = requested;
        *structured_supported = structured;
        inner.questions.lock().expect("questions lock").ready.insert(connection);
        inner.question_changed();
        return true;
    }
    if !*subscribed { return false; }
    // External /proc/herdr work must never retain the question mutex: answers,
    // expiry and snapshots remain available while the bounded lookup runs.
    let terminal_origin = if matches!(&inbound, Inbound::Question(_)) {
        peer.and_then(|p| (inner.resolve_origin)(p))
    } else { None };
    let (valid, changed) = {
        let mut state = inner.questions.lock().expect("questions lock");
        let now = now_ms();
        let mut changed = state.prune(now);
        let valid = match inbound {
            Inbound::Question(q) => {
                let question_id = q.id().to_string();
                // Capacity is deliberately bounded: admission is busy, never
                // evict a sent receipt early or build an unbounded transcript.
                let duplicate = state.deliveries.iter().any(|d| d.view.id == q.id());
                // Fixed native geometry never blocks admission. Preserve bounded receipts,
                // duplicate rejection and the original minimal global-busy wire reply.
                let admission = if state.deliveries.len() >= DELIVERY_LIMIT || duplicate {
                    question::busy_line(identity, q.id(), now).map(Admission::Busy)
                } else { state.slot.admit(connection, identity, q, now) };
                match admission {
                    Ok(Admission::Accepted) => {
                        if let Some(terminal) = terminal_origin {
                            state.terminal_origins.insert(question_id, terminal);
                        }
                        state.prune_terminal_origins();
                        state.origins.insert(connection, origin.clone()); state.notice = None; changed = true; true
                    }
                    Ok(Admission::Busy(line)) => {
                        state.notice = Some(QuestionOutcome::Busy); changed = true;
                        if write_line(&origin.writer, &line).is_err() {
                            state.revoke(connection, QuestionOutcome::OutcomeUnknown);
                            // Even with no originating slot, failure is uncertain.
                            state.notice = Some(QuestionOutcome::OutcomeUnknown);
                            let _ = origin.stream.shutdown(std::net::Shutdown::Both);
                            false
                        } else { true }
                    }
                    Err(_) => false,
                }
            }
            Inbound::Cancel(cancel) => {
                let too_early = cancel.reason() == question::CancelReason::Expired && (
                    state.slot.queue().any(|a| a.connection_id() == connection && a.question().id() == cancel.id() && now < a.question().expires_at())
                    || state.deliveries.iter().any(|d| d.connection == connection && d.view.id == cancel.id() && now < d.view.expires_at));
                if !too_early {
                    let pending_cancelled = matches!(state.slot.cancel(connection, identity, &cancel, now), Ok(Some(_)));
                    if pending_cancelled { state.origins.remove(&connection); state.terminal_origins.remove(cancel.id()); }
                    let before = state.deliveries.len();
                    state.deliveries.retain(|d| !(d.connection == connection && d.view.id == cancel.id()));
                    let cancelled = pending_cancelled || before != state.deliveries.len();
                    changed |= cancelled;
                    // An unrelated cancel cannot relabel a deadline notice
                    // produced by pruning some other originating connection.
                    if cancelled { state.notice = Some(if cancel.reason() == question::CancelReason::Expired {
                        QuestionOutcome::Expired
                    } else { QuestionOutcome::Cancelled }); }
                }
                true
            }
            Inbound::Resolved(resolved) => {
                if let Some(index) = state.deliveries.iter().position(|d| d.connection == connection && d.view.id == resolved.id() && d.expected == resolved.status()) {
                    state.deliveries.remove(index); changed = true;
                    state.notice = Some(match resolved.status() {
                        ResolutionStatus::Answered => QuestionOutcome::Answered,
                        ResolutionStatus::HumanCancelled => QuestionOutcome::HumanCancelled,
                    });
                }
                true
            }
            Inbound::AnswerRejected(rejected) => {
                if let Some(index) = state.deliveries.iter().position(|d| d.connection == connection && d.view.id == rejected.id()) {
                    state.deliveries.remove(index); changed = true;
                    state.notice = Some(QuestionOutcome::Rejected);
                }
                true
            }
            Inbound::Hello | Inbound::HelloBusyReason | Inbound::HelloStructured { .. } => unreachable!(),
        };
        (valid, changed)
    };
    if changed { inner.question_changed(); }
    valid
}

fn handle_connection(inner: Arc<Inner>, id: u64, stream: Arc<UnixStream>, peer: Option<crate::sessionterm::ProcInfo>) {
    let writer = match stream.try_clone() {
        Ok(writer) => Arc::new(Mutex::new(writer)),
        Err(_) => {
            let _ = stream.shutdown(std::net::Shutdown::Both);
            inner.clients.lock().expect("clients lock").remove(&id); inner.report(); return;
        }
    };
    let origin = QuestionOrigin { stream: stream.clone(), writer };
    let mut subscribed = false;
    let mut busy_reason_supported = false;
    let mut structured_supported = false;
    let mut framer = QuestionFramer::default();
    let mut identity: Option<protocol::Identity> = None;
    let mut quota = protocol::FrameQuota::new(now_millis());
    let handshake_deadline = Instant::now() + Duration::from_millis(inner.handshake_ms);
    // Only a complete, valid message renews the lease (legacy `active()`):
    // partial bytes or invalid frames never move this.
    let mut last_valid: Option<Instant> = None;
    let mut clean_eof = false;
    let mut buffer = [0u8; question::FRAME_BYTES * protocol::BATCH_FACTOR];

    'outer: loop {
        let deadline = match (&identity, last_valid) {
            (None, _) => handshake_deadline,
            (Some(_), Some(valid)) => valid + Duration::from_millis(inner.idle_ms),
            // Unreachable: identity is only set right after a valid frame.
            (Some(_), None) => handshake_deadline,
        };
        let now = Instant::now();
        // A connection that owns a live question is waiting for a HUMAN: the
        // question's own `expiresAt` (expiry worker) bounds it, so the silent
        // idle lease must not tear it down (R24b: a >30 s question was lost).
        let owns_question = identity.is_some() && {
            let q = inner.questions.lock().expect("questions lock");
            let owned = q.slot.queue().any(|a| a.connection_id() == id);
            owned
        };
        if now >= deadline && !owns_question {
            break;
        }
        let remaining = if owns_question {
            Duration::from_millis(500)
        } else {
            (deadline - now).max(Duration::from_millis(1))
        };
        if stream.set_read_timeout(Some(remaining)).is_err() {
            break;
        }
        let mut reader = &*stream; // Read is implemented for &UnixStream
        match reader.read(&mut buffer) {
            Ok(0) => {
                clean_eof = framer.pending.is_empty();
                break;
            }
            Ok(count) => {
                let framed = match framer.push(&buffer[..count], identity.is_some()) {
                    Ok(framed) => framed,
                    Err(_) => break, // batch cap (line 66): destroy
                };
                let mut rejected = false;
                for frame in &framed.frames {
                    // A previous frame's observer may close/drop the receiver.
                    if !inner.running.load(Ordering::SeqCst) { rejected = true; break; }
                    // rate gate BEFORE decode (transport.cjs line 74-75)
                    if quota.check(now_millis()).is_err() {
                        rejected = true;
                        break;
                    }
                    match protocol::decode(frame, &inner.project, identity.as_ref(), now_ms()) {
                        Ok(message) => {
                            last_valid = Some(Instant::now());
                            if identity.is_none() {
                                identity = Some(protocol::Identity {
                                    project: message.project.clone(),
                                    session_id: message.session_id.clone(),
                                    at: message.at,
                                });
                                if write_line(&origin.writer, protocol::READY_LINE).is_err() {
                                    rejected = true;
                                    break;
                                }
                                {
                                    let mut clients =
                                        inner.clients.lock().expect("clients lock");
                                    if let Some(client) = clients.get_mut(&id) {
                                        client.identified = true;
                                    }
                                }
                                inner.report();
                            } else {
                                // `transport.cjs` line 83: the store gates the
                                // callback — heartbeats, dedupe, queue bounds
                                // and the boundary re-validation all run here.
                                // S4/T2: anything the island can focus records the terminal it came from. An `attention`
                                // notice (Codex asking in its own terminal) must resolve exactly like a `settled` one, so
                                // «Ver» → focus_host{origin:'notice'} focuses the Codex terminal and not just any window.
                                let terminal = if message.kind == "settled"
                                    || message.kind == protocol::KIND_ATTENTION
                                {
                                    peer.as_ref().and_then(|p| (inner.resolve_origin)(p))
                                } else {
                                    None
                                };
                                let accepted = {
                                    let mut store =
                                        inner.store.lock().expect("transport notice store");
                                    let accepted = store.accept(&message, now_ms());
                                    let notices = store.snapshot(now_ms());
                                    let mut origins = inner.terminal_origins.lock().expect("terminal origins");
                                    origins.retain(|id, _| notices.iter().filter(|n| &n.id == id).count() == 1);
                                    if accepted {
                                        if let (Some(id), Some(terminal)) = (&message.id, terminal) {
                                            // A duplicate UUID across peers is ambiguous: refuse both, never retarget.
                                            if notices.iter().filter(|n| &n.id == id).count() == 1 {
                                                origins.insert(id.clone(), terminal);
                                            }
                                        }
                                    }
                                    accepted
                                };
                                if accepted {
                                    (inner.on_notice)(message);
                                }
                            }
                        }
                        Err(_) => {
                            let inbound = identity.as_ref().and_then(|bound| question::decode_with(frame, bound, now_ms(), structured_supported).ok());
                            if let Some(inbound) = inbound {
                                let Some(bound) = identity.as_ref() else {
                                    rejected = true;
                                    break;
                                };
                                if receive_question(&inner, id, bound, &origin, peer.as_ref(), &mut subscribed, &mut busy_reason_supported, &mut structured_supported, inbound) {
                                    framer.structured = structured_supported;
                                    last_valid = Some(Instant::now());
                                    continue;
                                }
                            }
                            rejected = true;
                            break; // invalid/unsubscribed question: fail closed
                        }
                    }
                }
                if rejected {
                    break 'outer;
                }
                if framed.fatal.is_some() {
                    break; // oversized tail (line 86): destroy
                }
            }
            Err(ref error)
                if error.kind() == ErrorKind::WouldBlock || error.kind() == ErrorKind::TimedOut =>
            {
                continue; // deadline re-checked at the top of the loop
            }
            Err(_) => break,
        }
    }

    let _ = stream.shutdown(std::net::Shutdown::Both);
    // Never acquire the client map while holding the question lock. A host
    // write may be finishing under that lock; teardown waits, then revokes.
    let (changed, pending) = {
        let mut q = inner.questions.lock().expect("questions lock");
        // Expiry is a normal end, even if EOF races the expiry worker.
        let expired = q.prune(now_ms());
        let pending = q.slot.queue().any(|a| a.connection_id() == id)
            || q.deliveries.iter().any(|d| d.connection == id);
        let failed_write = q.failed_writes.remove(&id);
        let changed = q.revoke(id, QuestionOutcome::Disconnected) || expired;
        (q.ready.remove(&id) || changed, pending || failed_write)
    };
    inner.clients.lock().expect("clients lock").remove(&id);
    if changed { inner.question_changed(); }
    // R16: hook producers are short-lived. Only complete-frame EOF with no
    // live question/unacknowledged answer is graceful. All other exits (bad
    // frame, read/reset/write error, idle deadline, partial EOF, or pending
    // work) remain real failures, including long-lived producers. Receiver
    // shutdown is intentional, not a producer failure. Settled is one-way:
    // its synchronous on_notice callback completes before EOF is observed.
    let failure = (identity.is_some() && inner.running.load(Ordering::SeqCst)
        && (!clean_eof || pending)).then_some(protocol::TransportFailure::ConnectionLost);
    inner.report_failure(failure);
}

// --- tests (fs-free policy; the socket behaviour is integration-tested) ------

#[cfg(test)]
mod tests {
    use super::*;

    fn question_fixture() -> (Questions, UnixStream) {
        let identity = protocol::Identity { project: "a".repeat(64), session_id: "session-1".into(), at: 100_000 };
        let body = serde_json::json!({"v":1,"type":"question","questionVersion":1,"project":identity.project,
            "sessionId":"session-1","at":100_000,"id":"12345678-1234-4abc-8abc-123456789abc",
            "kind":"question","text":"private body","options":[],"allowFreeText":true,"expiresAt":130_000});
        let Inbound::Question(question) = question::decode(body.to_string().as_bytes(), &identity, 100_000).unwrap() else { unreachable!() };
        let (stream, peer) = UnixStream::pair().unwrap();
        let origin = QuestionOrigin { writer: Arc::new(Mutex::new(stream.try_clone().unwrap())), stream: Arc::new(stream) };
        let mut state = Questions::default(); state.slot.admit(7, &identity, question, 100_000).unwrap();
        state.origins.insert(7, origin); (state, peer)
    }
    #[test]
    fn question_partial_write_is_unknown_revoked_and_never_replayed() {
        let (mut state, mut peer) = question_fixture();
        let id = "12345678-1234-4abc-8abc-123456789abc";
        let result = state.human_with(id, Some(HumanAnswer::Text { text: "private answer".into() }), 100_000, |origin, line| {
            origin.writer.lock().unwrap().write_all(&line[..7]).unwrap();
            Err(std::io::Error::new(ErrorKind::BrokenPipe, "injected partial write"))
        });
        assert_eq!(result, Err(HumanReplyError::OutcomeUnknown));
        assert!(state.slot.active().is_none()); assert!(state.origins.is_empty()); assert!(state.deliveries.is_empty());
        assert_eq!(state.notice, Some(QuestionOutcome::OutcomeUnknown));
        assert_eq!(state.human_with(id, None, 100_000, |_, _| panic!("never retry")), Err(HumanReplyError::Validation(question::Error::NotLive)));
        let mut bytes = Vec::new(); peer.read_to_end(&mut bytes).unwrap(); assert_eq!(bytes.len(), 7);
        assert!(!serde_json::to_string(&state.snapshot()).unwrap().contains("private"));
    }
    #[test]
    fn question_encoding_error_keeps_pending_without_touching_writer() {
        let (mut state, _peer) = question_fixture();
        let result = state.human_with("12345678-1234-4abc-8abc-123456789abc",
            Some(HumanAnswer::Text { text: "🙂".repeat(2000) }), 100_000, |_, _| panic!("encode before write"));
        assert_eq!(result, Err(HumanReplyError::Validation(question::Error::FrameTooLarge)));
        assert!(state.slot.active().is_some()); assert!(state.deliveries.is_empty());
    }

    #[test]
    fn question_framing_preserves_legacy_batch_even_after_subscription() {
        let legacy = b"{\"type\":\"heartbeat\"}\n";
        let chunk = legacy.repeat(4096 / legacy.len() + 1);
        assert!(QuestionFramer::default().push(&chunk, true).is_err());
        let qp = b"{\"type\":\"question\"}\n";
        let chunk = qp.repeat(32768 / qp.len());
        assert!(QuestionFramer::default().push(&chunk, true).is_ok());
        assert!(QuestionFramer::default().push(&vec![b'x';32769], true).is_err());
        assert!(QuestionFramer::default().push(&vec![b'x';513], false).unwrap().fatal.is_some());
    }

    #[test]
    fn reserved_preview_roots_are_never_allowed() {
        let xdg = Some("/run/user/1000");
        assert!(!runtime_allowed(Path::new("/run/user/1000/abito-desktop"), xdg));
        assert!(!runtime_allowed(
            Path::new("/run/user/1000/abito-desktop/p-abc123/s"),
            xdg
        ));
        assert!(!runtime_allowed(
            Path::new("/run/user/1000/abito-desktop-preview"),
            xdg
        ));
        // sibling names are NOT reserved (component-wise prefix match)
        assert!(runtime_allowed(
            Path::new("/run/user/1000/abito-desktop-other"),
            xdg
        ));
        assert!(runtime_allowed(
            Path::new("/run/user/1000/abito-desktop-tauri"),
            xdg
        ));
        assert!(runtime_allowed(
            Path::new(
                "/home/dev/Apps/my-project/worktrees/abito-tauri/apps/desktop-tauri/.runtime"
            ),
            xdg
        ));
    }

    #[test]
    fn override_must_be_absolute_and_normalized() {
        let default = Path::new("/home/dev/.runtime");
        // relative or unnormalized overrides fail closed
        for bad in [
            "relative/dir",
            "/has//double",
            "/has/./dot",
            "/has/../up",
            "/trailing/",
        ] {
            let error =
                resolve_runtime_from(Some(bad), default, Some("/run/user/1000")).expect_err(bad);
            assert!(
                matches!(error, TransportError::InvalidOverride),
                "{bad}: {error:?}"
            );
        }
        // an absolute normalized override inside a reserved root is refused
        let error = resolve_runtime_from(
            Some("/run/user/1000/abito-desktop"),
            default,
            Some("/run/user/1000"),
        )
        .expect_err("reserved");
        assert!(
            matches!(error, TransportError::ReservedPreviewRoot),
            "{error:?}"
        );
        // ours resolves, default resolves
        assert_eq!(
            resolve_runtime_from(
                Some("/home/dev/x/.runtime-probe"),
                default,
                Some("/run/user/1000")
            )
            .expect("override"),
            PathBuf::from("/home/dev/x/.runtime-probe")
        );
        assert_eq!(
            resolve_runtime_from(None, default, Some("/run/user/1000")).expect("default"),
            default
        );
    }

    #[test]
    fn default_runtime_is_the_crate_side_runtime_never_a_preview_root() {
        let default = default_runtime().expect("manifest dir is set by cargo");
        assert!(default.ends_with(".runtime"));
        assert!(default.is_absolute());
        assert!(
            runtime_allowed(&default, None),
            "our own default can never be a reserved Preview root"
        );
        // generated dir names follow the legacy `p-XXXXXX` rule
        assert!(is_generated_dir_name("p-0ajNZR"));
        assert!(is_generated_dir_name("p-ABC123"));
        assert!(!is_generated_dir_name("p-abc12"));
        assert!(!is_generated_dir_name("p-abc1234"));
        assert!(!is_generated_dir_name("p-abc!23"));
        assert!(!is_generated_dir_name("other"));
        // absolute+normalized parity with path.normalize
        assert!(is_absolute_normalized("/a/b/c"));
        assert!(!is_absolute_normalized("a/b"));
        assert!(!is_absolute_normalized("/a//b"));
        assert!(!is_absolute_normalized("/a/./b"));
        assert!(!is_absolute_normalized("/a/../b"));
        assert!(!is_absolute_normalized("/a/b/"));
    }
}
