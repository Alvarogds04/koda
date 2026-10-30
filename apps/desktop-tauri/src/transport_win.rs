//! Windows named-pipe notice receiver — T2/S3/S6. Public twin of
//! `transport.rs` (Unix UDS + SO_PEERCRED); main.rs needs no changes.
//!
//! Same observable contract as the Unix receiver, different kernel gate:
//!
//! * Endpoint: local byte-mode pipe
//!   `\\.\pipe\abito-notice-<SID>-<32 hex instance>` ([`crate::winipc`]).
//!   The FIRST server instance is created with `FILE_FLAG_FIRST_PIPE_INSTANCE`
//!   and stays the listener for the whole server lifetime (name-squat guard);
//!   replacement listener instances never carry the flag.
//! * DACL: explicit protected owner-only `O:<SID>D:P(A;;GA;;;<SID>)` plus
//!   `PIPE_REJECT_REMOTE_CLIENTS` — remote clients are refused at the kernel.
//! * Owner check on the wire: before the ready line or ANY payload is
//!   processed, `GetNamedPipeClientProcessId` (>0) opens the client process
//!   and its token user SID must equal ours; every API failure refuses
//!   (fail closed). The process handle is kept so a recycled pid cannot
//!   impersonate an admitted client.
//! * Discovery metadata (`pipe`/`pid`/`sid`/`v`) is published atomically with
//!   an explicit protected owner-only ACL under
//!   `%LOCALAPPDATA%\Abito\notices\endpoint.json`; there is NO arbitrary env
//!   override on Windows. `close()` removes it only when it still names us.
//! * Same protocol, quotas and question semantics as `transport.rs`
//!   (`protocol`, `question`, `questioncmd` helpers are reused verbatim):
//!   handshake/idle deadlines, frame + batch caps, rate quota, `CONNECTIONS`
//!   cap, human-only answers written to the asking connection's origin,
//!   bounded revocation on write failure.
//! * Bounded cancellable reads AND writes: every server handle is opened
//!   `FILE_FLAG_OVERLAPPED`; reads are Peek-gated overlapped `ReadFile`s with
//!   deadlines, writes are overlapped with a 500 ms bound, and shutdown
//!   cancels pending I/O before closing — no join can hang.
//! * Terminal origin (HU-065): the verified pipe client's pid is resolved through
//!   the Windows process table (`sessionterm_win`); an origin exists only when a
//!   terminal host is among its ancestors (the hook's chain when the relay is the
//!   client), otherwise `None` — never invented — and «Ver» says it does not know.

use crate::protocol::{self, Message};
use crate::question::{self, Admission, HumanAnswer, Inbound, QuestionSlot, ResolutionStatus};
use crate::questioncmd::NativeTransition;
use crate::sessionterm::Origin;
pub use crate::transport_view::{
    DeliveryState, FormItemView, HumanReplyError, PendingQuestionView, PreviewScan, QuestionDeliveryView,
    QuestionOptionView, QuestionOutcome, QuestionSnapshot, TransportError, TransportOptions,
    INSTALLED_RUNTIME_LEAF, RESERVED_RUNTIME_NAMES, SOCKET_DIR_ENV,
};
use std::collections::{HashMap, HashSet};
use std::io::ErrorKind;
use std::os::windows::io::{AsRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use windows_sys::Win32::Foundation::{GetLastError, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT, ERROR_IO_PENDING, ERROR_OPERATION_ABORTED, ERROR_PIPE_CONNECTED};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult};
use windows_sys::Win32::System::Pipes::{ConnectNamedPipe, DisconnectNamedPipe};
use windows_sys::Win32::System::Threading::WaitForSingleObject;

/// No transcript: at most eight unacknowledged, text-free delivery receipts.
const DELIVERY_LIMIT: usize = 8;
const WRITE_TIMEOUT: Duration = Duration::from_millis(500);
/// Overlapped wait slice while no client has connected yet (shutdown bound).
const ACCEPT_SLICE: u32 = 50;

#[derive(Clone)]
struct QuestionOrigin { stream: Arc<ClientPipe>, writer: Arc<Mutex<Arc<ClientPipe>>> }
struct Delivery { connection: u64, view: QuestionDeliveryView, expected: ResolutionStatus }
#[derive(Default)]
struct Questions {
    slot: QuestionSlot, origins: HashMap<u64, QuestionOrigin>, deliveries: Vec<Delivery>,
    ready: HashSet<u64>, failed_writes: HashSet<u64>, notice: Option<QuestionOutcome>,
    terminal_origins: HashMap<String, Origin>,
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
        let queued: Vec<PendingQuestionView> = self.slot.queue().skip(1).map(view).collect();
        QuestionSnapshot { pending, queued_count: queued.len(), queued, deliveries: self.deliveries.iter().map(|d| d.view.clone()).collect(),
            ready_connections: self.ready.len(), notice: self.notice, native_transition: NativeTransition::Idle }
    }
    /// No expiry wire reply is necessary. Frozen producer deadline only; no
    /// answer/default and no serialization failure can retain private text.
    fn prune(&mut self, now: u64) -> bool {
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
            origin.stream.disconnect();
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

fn write_line(writer: &Mutex<Arc<ClientPipe>>, line: &[u8]) -> std::io::Result<()> {
    let writer = writer.lock().expect("origin writer lock");
    writer.write_bounded(line)
}

// --- endpoint policy ---------------------------------------------------------

/// The per-user metadata root: `%LOCALAPPDATA%\Abito\notices`. There is NO
/// arbitrary env override on Windows (the approved design): the location is
/// canonical and its directory chain is ACL-verified before use.
pub fn resolve_runtime() -> Result<PathBuf, TransportError> {
    let root = crate::winpolicy::island_root(None, std::env::var("LOCALAPPDATA").ok().as_deref())
        .ok_or(TransportError::NoRuntimeRoot)?;
    Ok(root.join(crate::winipc::NOTICES_LEAF))
}

// --- the pipe ----------------------------------------------------------------

/// One admitted client connection. Overlapped handle: reads are Peek-gated
/// overlapped `ReadFile`s, writes overlapped with a hard bound, and
/// `disconnect()` cancels everything pending before the handle closes.
struct ClientPipe { file: std::fs::File, closed: AtomicBool, event: OwnedHandle }

impl ClientPipe {
    fn new(handle: OwnedHandle) -> std::io::Result<Self> {
        let event = crate::winipc::ffi::create_manual_event()?;
        Ok(ClientPipe { file: std::fs::File::from(handle), closed: AtomicBool::new(false), event })
    }
    fn handle(&self) -> HANDLE { self.file.as_raw_handle() as HANDLE }
    /// 0 = EOF (peer gone or shutdown), `TimedOut` at the deadline. Never
    /// blocks past the deadline and never blocks a shutdown.
    fn read_bounded(&self, out: &mut [u8], wait: Duration) -> std::io::Result<usize> {
        if self.closed.load(Ordering::SeqCst) { return Ok(0) }
        match crate::winipc::ffi::read_bounded_overlapped(&self.file, self.event.as_raw_handle() as HANDLE, out, wait) {
            Ok(count) => Ok(count),
            Err(_error) if self.closed.load(Ordering::SeqCst) => Ok(0), // shutdown raced the deadline
            Err(error) => Err(error),
        }
    }
    fn write_bounded(&self, bytes: &[u8]) -> std::io::Result<()> {
        crate::winipc::ffi::write_bounded(self.handle(), bytes, WRITE_TIMEOUT)
    }
    /// Kill the connection: cancel pending I/O, then discard the client's
    /// queued data (the Unix `shutdown(Both)` counterpart).
    ///
    /// B2 note: `cancel_io` cancels ALL pending operations on the handle. Any
    /// operation this connection issued is owned by a thread that still holds
    /// an `Arc<ClientPipe>` and is itself waiting on its own event — the abort
    /// signals that event, so the issuing thread observes the completion and
    /// drains through its own `GetOverlappedResult` before returning. The Arc
    /// guarantees every such thread outlives this call, so no OVERLAPPED,
    /// event or buffer can drop while the kernel still references it.
    fn disconnect(&self) {
        self.closed.store(true, Ordering::SeqCst);
        crate::winipc::ffi::cancel_io(self.handle());
        unsafe { DisconnectNamedPipe(self.handle()) };
    }
}

impl Drop for ClientPipe {
    fn drop(&mut self) {
        self.closed.store(true, Ordering::SeqCst);
        crate::winipc::ffi::cancel_io(self.handle());
        unsafe { DisconnectNamedPipe(self.handle()) };
    }
}

// --- the receiver ------------------------------------------------------------

struct Client {
    identified: bool,
    stream: Arc<ClientPipe>,
    /// Kept-open process handle of the verified client (PID-reuse safety).
    _proof: crate::winipc::ffi::ClientProof,
}

struct Inner {
    endpoint: PathBuf,
    runtime: PathBuf,
    pipe_name: String,
    pid: u32,
    running: AtomicBool,
    closed: AtomicBool,
    next_id: AtomicU64,
    clients: Mutex<HashMap<u64, Client>>,
    /// The current LISTENING instance (not yet connected). The very first one
    /// was created with FILE_FLAG_FIRST_PIPE_INSTANCE and replacements never
    /// are; every handle here lives for the whole server lifetime otherwise.
    listener: Mutex<Option<Arc<OwnedHandle>>>,
    accept: Mutex<Option<std::thread::JoinHandle<()>>>,
    handlers: Mutex<Vec<std::thread::JoinHandle<()>>>,
    project: String,
    handshake_ms: u64,
    idle_ms: u64,
    store: Mutex<protocol::NoticeStore>,
    on_notice: Box<dyn Fn(Message) + Send + Sync>,
    terminal_origins: Mutex<HashMap<String, Origin>>,
    resolve_origin: Box<dyn Fn(&crate::sessionterm::ProcInfo) -> Option<Origin> + Send + Sync>,
    on_connections: Box<dyn Fn(u32) + Send + Sync>,
    on_failure: Box<dyn Fn(protocol::TransportFailure) + Send + Sync>,
    reporting: Mutex<()>,
    questions: Mutex<Questions>,
    on_question_change: Box<dyn Fn() + Send + Sync>,
    own_sid: String,
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
    /// Host-only lookup. Windows never invents a terminal origin, so this
    /// resolves only while a (never-populated) origin is retained; unknown,
    /// ambiguous, expired and already-removed ids never fall back.
    pub fn origin_for(&self, request: &crate::focushost::OriginRequest) -> Option<Origin> {
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

    /// The `\\.\pipe\…` name the producer (or its relay) connects to.
    pub fn endpoint(&self) -> &Path {
        &self.inner.endpoint
    }

    /// `%LOCALAPPDATA%\Abito\notices` — the discovery-metadata root.
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

    /// Stop accepting, disconnect every client, join every thread bounded by
    /// cancellation, then remove the discovery metadata — only when it still
    /// names exactly our pipe and pid. Idempotent.
    pub fn close(&self) -> Result<(), TransportError> {
        if self.inner.closed.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        self.inner.running.store(false, Ordering::SeqCst);
        // 1. cancel the pending overlapped ConnectNamedPipe; the accept loop
        //    also re-checks `running` every ACCEPT_SLICE ms, so the join below
        //    cannot hang on a blocked connect.
        if let Some(listener) = self.inner.listener.lock().expect("listener lock").as_ref() {
            crate::winipc::ffi::cancel_io(listener.as_raw_handle() as HANDLE);
        }
        if let Some(handle) = self.inner.accept.lock().expect("accept lock").take() {
            join_other_thread(handle);
        }
        *self.inner.listener.lock().expect("listener lock") = None;
        // 2. disconnect clients before sweeping so no handler lingers.
        let pipes: Vec<Arc<ClientPipe>> = self
            .inner
            .clients
            .lock()
            .expect("clients lock")
            .values()
            .map(|client| client.stream.clone())
            .collect();
        for pipe in pipes {
            pipe.disconnect();
        }
        let handlers: Vec<std::thread::JoinHandle<()>> =
            std::mem::take(&mut *self.inner.handlers.lock().expect("handlers lock"));
        for handle in handlers {
            join_other_thread(handle);
        }
        self.inner.terminal_origins.lock().expect("terminal origins").clear();
        self.inner.questions.lock().expect("questions lock").terminal_origins.clear();
        // 3. identity-checked metadata removal (never a foreign file).
        crate::winipc::ffi::unpublish_endpoint(&self.inner.runtime, &self.inner.pipe_name, self.inner.pid)
            .map_err(|_| TransportError::CleanupIdentityChanged)
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

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0)
}

fn now_ms() -> u64 {
    now_millis() as u64
}

/// Bind a fresh `\\.\pipe\abito-notice-<SID>-<instance>`, publish the
/// discovery metadata, serve clients on threads, report notices and
/// identified-connection counts through the callbacks.
pub fn create_transport(options: TransportOptions) -> Result<Transport, TransportError> {
    create_transport_observed(options, |_| {})
}

/// Host failure observer, separate from connection counts: normal hook EOF
/// updates presence without inventing a failure. No wire capability is needed.
pub fn create_transport_observed(options: TransportOptions,
    on_failure: impl Fn(protocol::TransportFailure) + Send + Sync + 'static,
) -> Result<Transport, TransportError> {
    create_transport_with_origin_resolver(options, on_failure, |_| None)
}

/// Host-side injection seam (parity with Unix): on Windows the kernel offers
/// no peer identity to resolve — every origin stays `None` unless a host
/// test injects a resolver. Never a wire-supplied identity.
pub fn create_transport_with_origin_resolver(options: TransportOptions,
    on_failure: impl Fn(protocol::TransportFailure) + Send + Sync + 'static,
    resolve_origin: impl Fn(&crate::sessionterm::ProcInfo) -> Option<Origin> + Send + Sync + 'static,
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

    let sid = crate::winipc::ffi::current_user_sid()
        .ok_or(TransportError::Unavailable("Windows user identity unavailable"))?;
    crate::winipc::ffi::prepare_runtime(&runtime, &sid).map_err(TransportError::Io)?;
    // Accept-loop wakeup event, independent of the pipe handles below.
    let event = match crate::winipc::ffi::create_manual_event() {
        Ok(event) => event,
        Err(error) => return Err(TransportError::Io(error)),
    };
    let instance = crate::winipc::ffi::random_instance_hex()
        .ok_or(TransportError::Unavailable("no random source for the pipe instance"))?;
    let name = crate::winipc::pipe_name_for(&sid, &instance).ok_or(TransportError::UnexpectedEndpoint)?;
    // FILE_FLAG_FIRST_PIPE_INSTANCE: creation fails if ANY instance of the
    // name exists — a squatter can never be mistaken for us, and we can never
    // join a foreign server. This handle stays a listener for the server's
    // whole lifetime.
    let listener = match crate::winipc::ffi::create_server_pipe(&name, &sid, true) {
        Ok(listener) => listener,
        Err(error) => return Err(TransportError::Io(error)),
    };
    let pid = crate::winipc::ffi::current_pid();
    let metadata = match crate::winipc::EndpointMeta::new(name.clone(), pid, sid.clone()) {
        Some(meta) => meta,
        None => return Err(fail_with(TransportError::UnexpectedEndpoint, &runtime, &name, pid, listener)),
    };
    // Atomic publish, explicit protected owner-only ACL on the file itself.
    if let Err(error) = crate::winipc::ffi::publish_endpoint(&runtime, &metadata) {
        return Err(fail_with(TransportError::Io(error), &runtime, &name, pid, listener));
    }

    let endpoint = PathBuf::from(&name);
    let inner = Arc::new(Inner {
        endpoint: endpoint.clone(),
        runtime: runtime.clone(),
        pipe_name: name.clone(),
        pid,
        running: AtomicBool::new(true),
        closed: AtomicBool::new(false),
        next_id: AtomicU64::new(1),
        clients: Mutex::new(HashMap::new()),
        listener: Mutex::new(Some(Arc::new(listener))),
        accept: Mutex::new(None),
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
        own_sid: sid,
    });

    let accept_inner = inner.clone();
    let spawned = std::thread::Builder::new()
        .name("abito-accept".into())
        .spawn(move || accept_loop(accept_inner, event));
    let handle = match spawned {
        Ok(handle) => handle,
        Err(error) => {
            // Startup unwind: the listener handle goes first, then the
            // metadata is removed only when it still names us.
            inner.running.store(false, Ordering::SeqCst);
            *inner.listener.lock().expect("listener lock") = None;
            if let Err(cleanup_error) = crate::winipc::ffi::unpublish_endpoint(&runtime, &name, pid) {
                eprintln!("transport startup cleanup refused: {cleanup_error}");
            }
            return Err(TransportError::Io(error));
        }
    };
    *inner.accept.lock().expect("accept lock") = Some(handle);
    Ok(Transport { inner })
}

fn fail_with(
    error: TransportError,
    runtime: &Path,
    pipe_name: &str,
    pid: u32,
    listener: OwnedHandle,
) -> TransportError {
    // Startup unwind: the first-instance handle goes first, then the metadata
    // is removed only when it still names us (the original error is returned).
    drop(listener);
    if let Err(cleanup_error) = crate::winipc::ffi::unpublish_endpoint(runtime, pipe_name, pid) {
        eprintln!("transport startup cleanup refused: {cleanup_error}");
    }
    error
}

/// Accept loop. One listener instance at a time; on every accepted client the
/// NEXT instance (never with the FIRST flag) is created before the client
/// thread starts, so no connection window is ever closed.
fn accept_loop(inner: Arc<Inner>, event: OwnedHandle) {
    while inner.running.load(Ordering::SeqCst) {
        inner.expire_questions();
        // The expiry observer may have closed us on this very accept thread.
        if !inner.running.load(Ordering::SeqCst) { break; }
        let raw = match inner.listener.lock().expect("listener lock").as_ref() {
            Some(listener) => listener.as_raw_handle() as HANDLE,
            None => break,
        };
        let mut connected = false;
        let mut overlapped: windows_sys::Win32::System::IO::OVERLAPPED = unsafe { std::mem::zeroed() };
        overlapped.hEvent = event.as_raw_handle() as HANDLE;
        let status = unsafe { ConnectNamedPipe(raw, &mut overlapped) };
        if status == 0 {
            match unsafe { GetLastError() } {
                ERROR_IO_PENDING => {}
                // A client connected between CreateNamedPipeW and here.
                ERROR_PIPE_CONNECTED => connected = true,
                // Shutdown cancelled the pending connect: an intentional end,
                // never a transport failure.
                ERROR_OPERATION_ABORTED if !inner.running.load(Ordering::SeqCst) => {}
                _ => {
                    inner.report_failure(Some(protocol::TransportFailure::Unavailable));
                    break;
                }
            }
        } else {
            connected = true;
        }
        while !connected {
            if !inner.running.load(Ordering::SeqCst) {
                // B2: cancel AND drain — the kernel must be done with
                // `overlapped` before this iteration's locals drop.
                unsafe { CancelIoEx(raw, &overlapped) };
                let mut written = 0u32;
                unsafe { GetOverlappedResult(raw, &overlapped, &mut written, 1) };
                break;
            }
            match unsafe { WaitForSingleObject(event.as_raw_handle() as HANDLE, ACCEPT_SLICE) } {
                WAIT_OBJECT_0 => connected = true,
                WAIT_TIMEOUT => continue,
                _ => {
                    unsafe { CancelIoEx(raw, &overlapped) };
                    let mut written = 0u32;
                    unsafe { GetOverlappedResult(raw, &overlapped, &mut written, 1) };
                    inner.report_failure(Some(protocol::TransportFailure::Unavailable));
                    break;
                }
            }
        }
        if !connected {
            break;
        }
        // Owner check BEFORE the ready line or any payload: client pid (>0)
        // and process token SID must equal ours; any API failure refuses.
        let proof = crate::winipc::ffi::verified_client(raw, &inner.own_sid);
        // Replacement listener first (no FIRST flag — the name now has a live
        // instance, ours): the connected handle below is consumed.
        let replacement = crate::winipc::ffi::create_server_pipe(&inner.pipe_name, &inner.own_sid, false);
        let connected_handle = match replacement {
            Ok(handle) => {
                let previous = inner.listener.lock().expect("listener lock").replace(Arc::new(handle));
                previous.expect("listener was some")
            }
            Err(error) => {
                eprintln!("transport: listener replacement failed: {error}");
                unsafe { DisconnectNamedPipe(raw) };
                *inner.listener.lock().expect("listener lock") = None;
                inner.report_failure(Some(protocol::TransportFailure::Unavailable));
                break;
            }
        };
        let Some(proof) = proof else {
            // Foreign user or unusable client identity: disconnect, never a
            // ready line, never a decoded payload.
            unsafe { DisconnectNamedPipe(raw) };
            drop(connected_handle);
            continue;
        };
        let connected = match Arc::try_unwrap(connected_handle) {
            Ok(handle) => handle,
            Err(_) => { unsafe { DisconnectNamedPipe(raw) }; continue; } // unreachable: refcount was 1
        };
        let pipe = match ClientPipe::new(connected) {
            Ok(pipe) => Arc::new(pipe),
            Err(_) => { unsafe { DisconnectNamedPipe(raw) }; continue; }
        };
        let client_pid = proof.pid;
        let id = inner.next_id.fetch_add(1, Ordering::SeqCst);
        let prepared = {
            let mut clients = inner.clients.lock().expect("clients lock");
            if clients.len() >= protocol::CONNECTIONS {
                // legacy line 56: `socket.destroy()` — never counted.
                None
            } else {
                clients.insert(
                    id,
                    Client {
                        identified: false,
                        stream: pipe.clone(),
                        _proof: proof,
                    },
                );
                Some(pipe)
            }
        };
        let Some(pipe) = prepared else {
            continue;
        };
        let thread_inner = inner.clone();
        // HU-065: the kernel's pipe-client pid (verified above) and its birth identity from the Windows process
        // table. When the relay is the client, its ancestor chain contains the hook's (never the page's).
        let peer: Option<crate::sessionterm::ProcInfo> = crate::sessionterm::read_peer(client_pid);
        let spawned = std::thread::Builder::new()
            .name(format!("abito-client-{id}"))
            .spawn(move || handle_connection(thread_inner, id, pipe, peer));
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
    *inner.listener.lock().expect("listener lock") = None;
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
    // On Windows the peer origin is None (no /proc): terminal origins stay
    // empty and «Ver» never claims a terminal it cannot prove.
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
                let duplicate = state.deliveries.iter().any(|d| d.view.id == q.id());
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
                            state.notice = Some(QuestionOutcome::OutcomeUnknown);
                            origin.stream.disconnect();
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

fn handle_connection(inner: Arc<Inner>, id: u64, stream: Arc<ClientPipe>, peer: Option<crate::sessionterm::ProcInfo>) {
    let origin = QuestionOrigin { stream: stream.clone(), writer: Arc::new(Mutex::new(stream.clone())) };
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
        match stream.read_bounded(&mut buffer, remaining) {
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
                                // Windows keeps the same shape; the terminal
                                // origin stays None (no /proc, never invented).
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
            Err(ref error) if error.kind() == ErrorKind::TimedOut => {
                continue; // deadline re-checked at the top of the loop
            }
            Err(_) => break,
        }
    }

    stream.disconnect();
    // Never acquire the client map while holding the question lock. A host
    // write may be finishing under that lock; teardown waits, then revokes.
    let (changed, pending) = {
        let mut q = inner.questions.lock().expect("questions lock");
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
    // live question/unacknowledged answer is graceful. All other exits
    // remain real failures. Receiver shutdown is intentional, not a producer
    // failure.
    let failure = (identity.is_some() && inner.running.load(Ordering::SeqCst)
        && (!clean_eof || pending)).then_some(protocol::TransportFailure::ConnectionLost);
    inner.report_failure(failure);
}

/// Read-only scan of the reserved Preview roots: a Unix concept (XDG runtime
/// sockets). Windows owns none — honest empty, never a fake hit.
pub fn preview_scan() -> Vec<PreviewScan> {
    Vec::new()
}
