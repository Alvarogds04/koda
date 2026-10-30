//! #341 — local, append-only conversation history. No provider configuration is stored.
//! Callers serialize mutations. JSONL is authoritative; the atomic index is only a cache.
use crate::chat::{ChatError, FinishReason, ProfileRef, Turn, TurnState};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub const PAGE_SIZE: usize = 25;
pub const MAX_PAGE_SIZE: usize = 50;
const MAX_RECORD_BYTES: usize = 256 * 1024;
// Native IDs must also be exact in the WebView's numeric paging/sort operations.
const MAX_TURN_NUMBER: u64 = 9_007_199_254_740_991;
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SpecialistRef {
    pub id: String,
    pub name: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Summary {
    pub id: String,
    pub title: String,
    pub specialist: Option<SpecialistRef>,
    pub created_at: u64,
    pub last_activity: u64,
    pub turns: usize,
}
#[derive(Debug)]
pub struct Page {
    pub turns: Vec<Turn>,
    pub before: Option<u64>,
    pub skipped: usize,
}
#[derive(Debug)]
pub struct Store {
    dir: PathBuf,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredTurn {
    number: u64,
    user_text: String,
    reply: String,
    state: String,
    seq: u64,
    finish_reason: Option<String>,
    error: Option<StoredError>,
    trimmed_turns: usize,
    profile_id: String,
    profile_revision: u64,
    /// #343: attachment metadata (never content). Old records without the
    /// key still load, and plain turns write NO key at all — the historical
    /// record shape is preserved byte for byte (shape pin in the tests).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    attachments: Vec<StoredAttachment>,
    /// #418: tool-call receipts and approval decisions. Same optional-key
    /// pattern: plain turns write NO key; old records load with none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    tool_calls: Vec<StoredToolCall>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    approvals: Vec<StoredApproval>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredToolCall {
    call_id: String,
    name: String,
    state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    summary: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredApproval {
    request_id: String,
    operation: String,
    decision: String,
}
fn word<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_value(v).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
}
impl StoredToolCall {
    fn from_call(c: &crate::chat::ToolCall) -> io::Result<Self> {
        if !c.valid() {
            return Err(invalid());
        }
        Ok(Self { call_id: c.call_id.clone(), name: c.name.clone(), state: word(&c.state), summary: c.summary.clone() })
    }
    fn into_call(self) -> io::Result<crate::chat::ToolCall> {
        use crate::chat::ToolState;
        let state = match self.state.as_str() {
            "running" => ToolState::Running,
            "done" => ToolState::Done,
            "failed" => ToolState::Failed,
            _ => return Err(invalid()),
        };
        let call = crate::chat::ToolCall { call_id: self.call_id, name: self.name, state, summary: self.summary };
        if call.valid() { Ok(call) } else { Err(invalid()) }
    }
}
impl StoredApproval {
    fn from_decision(a: &crate::chat::ApprovalDecision) -> io::Result<Self> {
        if !a.valid() {
            return Err(invalid());
        }
        Ok(Self { request_id: a.request_id.clone(), operation: a.operation.clone(), decision: word(&a.decision) })
    }
    fn into_decision(self) -> io::Result<crate::chat::ApprovalDecision> {
        use crate::chat::Decision;
        let decision = match self.decision.as_str() {
            "approved" => Decision::Approved,
            "denied" => Decision::Denied,
            "expired" => Decision::Expired,
            _ => return Err(invalid()),
        };
        let item = crate::chat::ApprovalDecision { request_id: self.request_id, operation: self.operation, decision };
        if item.valid() { Ok(item) } else { Err(invalid()) }
    }
}
/// Metadata only: the file content stays in the island's uploads directory
/// and is re-read (re-validated) when a prompt is built.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredAttachment {
    id: String,
    name: String,
    mime: String,
    size: u64,
    file: String,
}
impl StoredAttachment {
    fn from_attachment(a: &crate::chat::Attachment) -> io::Result<Self> {
        if !crate::chat::valid_attachment_id(&a.id)
            || !crate::uploads::valid_stored_name(&a.file)
            || a.file != format!("{}-{}", &a.id[2..], a.name)
            || a.name.is_empty()
            || a.mime.is_empty()
            || a.size == 0
        {
            return Err(invalid());
        }
        Ok(Self {
            id: a.id.clone(),
            name: a.name.clone(),
            mime: a.mime.clone(),
            size: a.size,
            file: a.file.clone(),
        })
    }
    fn into_attachment(self) -> io::Result<crate::chat::Attachment> {
        if !crate::chat::valid_attachment_id(&self.id)
            || !crate::uploads::valid_stored_name(&self.file)
            || self.file != format!("{}-{}", &self.id[2..], self.name)
            || self.name.is_empty()
            || self.mime.is_empty()
            || self.size == 0
        {
            return Err(invalid());
        }
        Ok(crate::chat::Attachment {
            id: self.id,
            name: self.name,
            mime: self.mime,
            size: self.size,
            file: self.file,
        })
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredError {
    code: String,
    safe_message: String,
    retryable: bool,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
enum Record {
    #[serde(rename = "created")]
    Created {
        v: u8,
        id: String,
        specialist: Option<SpecialistRef>,
        at: u64,
    },
    #[serde(rename = "turn")]
    Turn { v: u8, at: u64, turn: StoredTurn },
}
fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "Invalid conversation history")
}
pub fn valid_id(id: &str) -> bool {
    id.starts_with("c-")
        && (4..=80).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}
fn number(id: &str) -> Option<u64> {
    id.strip_prefix("t-")?.parse().ok().filter(|n| *n > 0 && *n <= MAX_TURN_NUMBER)
}
fn title(text: &str) -> String {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut title: String = normalized.chars().take(80).collect();
    if normalized.chars().count() > 80 {
        title.push('…');
    }
    title
}
impl StoredTurn {
    fn from_turn(t: &Turn) -> io::Result<Self> {
        let n = number(&t.turn_id).ok_or_else(invalid)?;
        crate::chat::validate_text(&t.user_text).map_err(|_| invalid())?;
        if t.reply.chars().count() > crate::chat::RESPONSE_MAX_SCALARS {
            return Err(invalid());
        }
        Ok(Self {
            number: n,
            user_text: t.user_text.clone(),
            reply: t.reply.clone(),
            state: serde_json::to_value(t.state)
                .unwrap()
                .as_str()
                .unwrap()
                .into(),
            seq: t.seq,
            finish_reason: t
                .finish
                .map(|f| serde_json::to_value(f).unwrap().as_str().unwrap().into()),
            error: t.error.as_ref().map(|e| StoredError {
                code: e.code.clone(),
                safe_message: e.safe_message.clone(),
                retryable: e.retryable,
            }),
            trimmed_turns: t.trimmed_turns,
            profile_id: t.profile.profile_id.clone(),
            profile_revision: t.profile.revision,
            attachments: t
                .attachments
                .iter()
                .map(StoredAttachment::from_attachment)
                .collect::<io::Result<Vec<_>>>()?,
            tool_calls: t.tool_calls.iter().map(StoredToolCall::from_call).collect::<io::Result<Vec<_>>>()?,
            approvals: t.approvals.iter().map(StoredApproval::from_decision).collect::<io::Result<Vec<_>>>()?,
        })
    }
    fn into_turn(self, id: &str) -> io::Result<Turn> {
        if self.number == 0 || self.number > MAX_TURN_NUMBER
            || crate::chat::validate_text(&self.user_text).is_err()
            || self.reply.chars().count() > crate::chat::RESPONSE_MAX_SCALARS
        {
            return Err(invalid());
        }
        // A process restart never resumes inference; interrupted turns are shown as cancelled.
        let state = match self.state.as_str() {
            "completed" => TurnState::Completed,
            "error" => TurnState::Error,
            "cancelled" | "queued" | "thinking" | "streaming" | "waiting_approval" => {
                TurnState::Cancelled
            }
            _ => return Err(invalid()),
        };
        let finish = match self.finish_reason.as_deref() {
            Some("stop") => Some(FinishReason::Stop),
            Some("limit") => Some(FinishReason::Limit),
            Some("cancelled") => Some(FinishReason::Cancelled),
            None => None,
            _ => return Err(invalid()),
        };
        let attachments = self
            .attachments
            .into_iter()
            .map(StoredAttachment::into_attachment)
            .collect::<io::Result<Vec<_>>>()?;
        let tool_calls = self.tool_calls.into_iter().map(StoredToolCall::into_call).collect::<io::Result<Vec<_>>>()?;
        let approvals = self.approvals.into_iter().map(StoredApproval::into_decision).collect::<io::Result<Vec<_>>>()?;
        Ok(Turn {
            turn_id: format!("t-{}", self.number),
            request_id: format!("{id}/r-{}", self.number),
            client_request_id: String::new(),
            user_text: self.user_text,
            reply: self.reply,
            state,
            seq: self.seq,
            finish: if state == TurnState::Cancelled {
                Some(FinishReason::Cancelled)
            } else {
                finish
            },
            error: self.error.map(|e| ChatError {
                code: e.code,
                safe_message: e.safe_message,
                retryable: e.retryable,
            }),
            profile: ProfileRef {
                profile_id: self.profile_id,
                revision: self.profile_revision,
                lane_id: "conversation".into(),
            },
            trimmed_turns: self.trimmed_turns,
            attachments,
            tool_calls,
            approvals,
        })
    }
}
fn private_file(path: &Path, write: bool, create: bool) -> io::Result<File> {
    let mut o = OpenOptions::new();
    o.read(true).write(write).create_new(create);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let f = o.open(path)?;
    let m = f.metadata()?;
    if !m.is_file() {
        return Err(invalid());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if m.uid() != unsafe { libc::getuid() } || m.mode() & 0o077 != 0 {
            return Err(invalid());
        }
    }
    Ok(f)
}
fn directory(dir: &Path) -> io::Result<()> {
    // Reject symlink ancestors as well as the leaf; never chmod an unrelated directory.
    for p in dir.ancestors() {
        if let Ok(m) = fs::symlink_metadata(p) {
            if !m.is_dir() || m.file_type().is_symlink() {
                return Err(invalid());
            }
        }
    }
    if !dir.exists() {
        let mut b = fs::DirBuilder::new();
        b.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            b.mode(0o700);
        }
        b.create(dir)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let m = fs::metadata(dir)?;
        if m.uid() != unsafe { libc::getuid() } || m.mode() & 0o077 != 0 {
            return Err(invalid());
        }
    }
    Ok(())
}
fn sync_directory(dir: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        File::open(dir)?.sync_all()?;
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
    }
    Ok(())
}
/// Bounded allocation even for corrupt files containing a huge unterminated line.
fn read_record(reader: &mut impl BufRead) -> io::Result<Option<Vec<u8>>> {
    let mut out = Vec::new();
    let mut seen = false;
    let mut oversized = false;
    loop {
        let buf = reader.fill_buf()?;
        if buf.is_empty() {
            break;
        }
        seen = true;
        let end = buf.iter().position(|b| *b == b'\n');
        let len = end.map_or(buf.len(), |n| n + 1);
        if out.len() + len <= MAX_RECORD_BYTES && !oversized {
            out.extend_from_slice(&buf[..len]);
        } else {
            oversized = true;
            out.clear();
        }
        reader.consume(len);
        if end.is_some() {
            break;
        }
    }
    Ok(seen.then_some(out))
}
impl Store {
    pub fn open(dir: &Path) -> io::Result<Self> {
        directory(dir)?;
        Ok(Self {
            dir: dir.to_owned(),
        })
    }
    fn path(&self, id: &str) -> io::Result<PathBuf> {
        if !valid_id(id) {
            return Err(invalid());
        }
        Ok(self.dir.join(format!("{id}.jsonl")))
    }
    fn scan(
        &self,
        id: &str,
        before: Option<u64>,
        keep: usize,
    ) -> io::Result<(Summary, BTreeMap<u64, Turn>, usize)> {
        let mut reader = BufReader::new(private_file(&self.path(id)?, false, false)?);
        let mut summary: Option<Summary> = None;
        let mut turns = BTreeMap::new();
        let mut skipped = 0;
        let mut numbers = BTreeSet::new();
        let mut first = u64::MAX;
        while let Some(bytes) = read_record(&mut reader)? {
            let record = serde_json::from_slice::<Record>(&bytes);
            match record {
                Ok(Record::Created {
                    v: 1,
                    id: stored,
                    specialist,
                    at,
                }) if stored == id && summary.is_none() => {
                    summary = Some(Summary {
                        id: id.into(),
                        title: "Nueva conversación".into(),
                        specialist,
                        created_at: at,
                        last_activity: at,
                        turns: 0,
                    });
                }
                Ok(Record::Turn { v: 1, at, turn }) if summary.is_some() => {
                    let n = turn.number;
                    if let Ok(t) = turn.into_turn(id) {
                        let s = summary.as_mut().unwrap();
                        s.last_activity = s.last_activity.max(at);
                        numbers.insert(n);
                        if n <= first {
                            first = n;
                            s.title = title(&t.user_text);
                        }
                        // Only the requested page's message text stays in memory. Counting IDs
                        // is cheap; large histories do not allocate every message on each read.
                        if keep > 0 && before.is_none_or(|b| n < b) {
                            turns.insert(n, t);
                            if turns.len() > keep {
                                turns.pop_first();
                            }
                        }
                    } else {
                        skipped += 1;
                    }
                }
                _ => skipped += 1,
            }
        }
        let mut summary = summary.ok_or_else(invalid)?;
        summary.turns = numbers.len();
        Ok((summary, turns, skipped))
    }
    pub fn create(&mut self, specialist: Option<SpecialistRef>, now: u64) -> io::Result<Summary> {
        if specialist
            .as_ref()
            .is_some_and(|s| s.id.is_empty() || s.id.len() > 128 || s.name.chars().count() > 80)
        {
            return Err(invalid());
        }
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| invalid())?
            .as_nanos();
        let id = format!(
            "c-{stamp}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        );
        let mut f = private_file(&self.path(&id)?, true, true)?;
        Self::write_record(
            &mut f,
            &Record::Created {
                v: 1,
                id: id.clone(),
                specialist,
                at: now,
            },
        )?;
        sync_directory(&self.dir)?;
        let summary = self.scan(&id, None, 0)?.0;
        // Index failure never rolls back durable JSONL; readers rebuild from the authoritative files.
        self.index()?;
        Ok(summary)
    }
    fn write_record(f: &mut File, record: &Record) -> io::Result<()> {
        let mut bytes = serde_json::to_vec(record)?;
        bytes.push(b'\n');
        if bytes.len() > MAX_RECORD_BYTES {
            return Err(invalid());
        }
        f.seek(SeekFrom::End(0))?;
        f.write_all(&bytes)?;
        f.flush()?;
        f.sync_all()
    }
    pub fn append(&mut self, id: &str, turn: &Turn, now: u64) -> io::Result<()> {
        let stored = StoredTurn::from_turn(turn)?;
        self.scan(id, None, 0)?;
        let mut f = private_file(&self.path(id)?, true, false)?;
        let len = f.metadata()?.len();
        if len > 0 {
            f.seek(SeekFrom::End(-1))?;
            let mut last = [0];
            f.read_exact(&mut last)?;
            if last[0] != b'\n' {
                f.seek(SeekFrom::End(0))?;
                f.write_all(b"\n")?;
            }
        }
        Self::write_record(
            &mut f,
            &Record::Turn {
                v: 1,
                at: now,
                turn: stored,
            },
        )?;
        self.index()
    }
    pub fn list(&self) -> io::Result<(Vec<Summary>, usize)> {
        let mut summaries = Vec::new();
        let mut skipped = 0;
        for entry in fs::read_dir(&self.dir)? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let Some(id) = name.strip_suffix(".jsonl") else {
                continue;
            };
            match self.scan(id, None, 0) {
                Ok((s, _, n)) => {
                    summaries.push(s);
                    skipped += n;
                }
                Err(_) => skipped += 1,
            }
        }
        summaries.sort_by(|a, b| {
            b.last_activity
                .cmp(&a.last_activity)
                .then_with(|| b.id.cmp(&a.id))
        });
        Ok((summaries, skipped))
    }
    pub fn page(&self, id: &str, before: Option<u64>, limit: usize) -> io::Result<Page> {
        if limit == 0 || before == Some(0) {
            return Err(invalid());
        }
        let (_, all, skipped) = self.scan(id, before, limit.min(MAX_PAGE_SIZE) + 1)?;
        let mut selected: Vec<(u64, Turn)> = all.into_iter().rev().collect();
        let older = selected.len() > limit.min(MAX_PAGE_SIZE);
        if older {
            selected.pop();
        }
        selected.reverse();
        let before = if older {
            selected.first().map(|(n, _)| *n)
        } else {
            None
        };
        Ok(Page {
            turns: selected.into_iter().map(|(_, t)| t).collect(),
            before,
            skipped,
        })
    }
    pub fn summary(&self, id: &str) -> io::Result<Summary> {
        self.scan(id, None, 0).map(|(s, _, _)| s)
    }
    fn index(&self) -> io::Result<()> {
        let (items, skipped) = self.list()?;
        static TEMP: AtomicU64 = AtomicU64::new(0);
        let temp = self.dir.join(format!(
            "index-{}-{}.tmp",
            std::process::id(),
            TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        let result = (|| {
            let mut file = private_file(&temp, true, true)?;
            serde_json::to_writer(
                &mut file,
                &serde_json::json!({"v": 1, "conversations": items, "skipped": skipped}),
            )?;
            file.flush()?;
            file.sync_all()?;
            fs::rename(&temp, self.dir.join("index.json"))?;
            sync_directory(&self.dir)
        })();
        if temp.exists() {
            let _ = fs::remove_file(&temp);
        }
        result
    }
}
#[cfg(test)]
#[path = "conversations_tests.rs"]
mod tests;
