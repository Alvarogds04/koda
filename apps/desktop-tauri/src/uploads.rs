//! #343 — chat file attachments: validate, then copy into the app's OWN
//! workspace directory. The island page never touches file bytes and never
//! names a storage path: it sends either a dropped path (`chat_attach`,
//! Rust reads and copies) or raw bytes (`chat_attach_data`, the picker) and
//! receives back `{id, name, mime, size}` or a safe Spanish error.
//!
//! Policy, enforced here before anything is written:
//! - allowlist by CONTENT (magic bytes), never by extension: PNG, JPEG,
//!   WebP, GIF; UTF-8 text without NUL/control characters is `text/plain`;
//! - size: 10 MiB per file, 32,000 Unicode scalars per text file,
//!   5 attachments per turn (enforced at submit);
//! - storage: `<effective workspace>/uploads/` under the daemon's island
//!   (`ABITO_ISLAND_DIR` or `~/.abito-island`; `config.json` may point the
//!   workspace elsewhere). Files are created with a generated name — the
//!   caller's name is sanitized into a display name only, never a path.
//! - a REJECTED file leaves nothing behind: everything is validated before
//!   the first write, and a failed write removes its temp file. There is no
//!   state and no counter in this module: rejecting is side-effect free.

use std::fs;
use std::hash::{BuildHasher, Hasher};
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use crate::chat::{valid_attachment_id, Attachment, ChatError};

/// Hard size cap for one attached file.
pub const MAX_FILE_BYTES: usize = 10 * 1024 * 1024;
/// Inline cap for one text file (what prompt building may read back).
pub const MAX_TEXT_SCALARS: usize = 32_000;

/// Total bytes the uploads directory may hold (R22: no unbounded growth).
pub const MAX_TOTAL_BYTES: u64 = 512 * 1024 * 1024;
/// A `tmp-*` leftover older than this is a crashed write, never a live one.
pub const STALE_TMP_SECS: u64 = 60;

/// Bytes currently held by regular files directly inside `dir`.
pub fn dir_bytes(dir: &Path) -> u64 {
    fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .filter_map(|e| fs::symlink_metadata(e.path()).ok())
                .filter(|m| m.is_file())
                .map(|m| m.len())
                .sum()
        })
        .unwrap_or(0)
}

/// R22 startup sweep: remove `tmp-*` files a crash left behind once they are
/// older than `older_than_secs`. Only regular `tmp-` files are touched.
pub fn sweep_stale_tmp(dir: &Path, older_than_secs: u64) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.filter_map(|e| e.ok()) {
        if !entry.file_name().to_string_lossy().starts_with("tmp-") {
            continue;
        }
        let Ok(meta) = fs::symlink_metadata(entry.path()) else { continue };
        let age = meta.modified().ok().and_then(|m| m.elapsed().ok()).map_or(0, |d| d.as_secs());
        if meta.is_file() && age >= older_than_secs {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// A stored file name the page may reference: `<16hex>-<sanitized name>`.
/// This is the ONLY name submit validation accepts, and it is only ever
/// resolved INSIDE the uploads directory.
pub fn valid_stored_name(name: &str) -> bool {
    let (id, rest) = match name.split_once('-') {
        Some(parts) => parts,
        None => return false,
    };
    valid_attachment_id(&format!("a-{id}")) && sanitize_name(rest) == rest
}

fn random_hex() -> String {
    // Two independent hasher seeds: no dependencies, no shared counter.
    // 16 hex chars exactly: the low 32 bits of each seed.
    let a = std::collections::hash_map::RandomState::new().build_hasher().finish();
    let b = std::collections::hash_map::RandomState::new().build_hasher().finish();
    format!("{:08x}{:08x}", (a >> 32) as u32, (b & 0xFFFF_FFFF) as u32)
}

/// Detect the MIME type from CONTENT. `None` = not on the allowlist.
pub fn detect_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.is_empty() {
        return None;
    }
    const PNG: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    if bytes.starts_with(PNG) {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if is_plain_text(bytes) {
        return Some("text/plain");
    }
    None
}

/// Plain text: valid UTF-8, no NUL, and the only control characters are
/// LF, TAB and CR. Bounded: at most [`MAX_TEXT_SCALARS`] Unicode scalars.
pub fn is_plain_text(bytes: &[u8]) -> bool {
    let text = match std::str::from_utf8(bytes) {
        Ok(t) => t,
        Err(_) => return false,
    };
    if text.chars().count() > MAX_TEXT_SCALARS {
        return false;
    }
    text.chars()
        .all(|c| !c.is_control() || c == '\n' || c == '\t' || c == '\r')
}

/// Sanitize a DISPLAY name: basename of any separator style, control
/// characters stripped, path-significant and unusual characters folded to
/// `_`, leading/trailing dots and spaces removed, bounded to 80 chars,
/// never empty and never a dot name. The result is never used as a path
/// component on its own (the stored name prefixes it with a generated id).
pub fn sanitize_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let mut out = String::new();
    for c in base.chars().filter(|c| !c.is_control()) {
        if c.is_alphanumeric() || matches!(c, ' ' | '.' | '_' | '-' | '(' | ')') {
            out.push(c);
        } else {
            out.push('_');
        }
    }
    let trimmed: String = out.trim_matches(|c| c == '.' || c == ' ').to_string();
    let mut bounded: String = trimmed.chars().take(80).collect();
    if bounded.is_empty() {
        bounded = "archivo".to_string();
    }
    bounded
}

fn invalid(why: &str) -> ChatError {
    ChatError::invalid_input(why)
}

/// Validate and store one file into `dir`. NOTHING is written when the
/// file is rejected: every check runs before the first write, and a failed
/// write removes its temp file. The module keeps no state.
pub fn attach(dir: &Path, raw_name: &str, bytes: &[u8]) -> Result<Attachment, ChatError> {
    attach_with_cap(dir, raw_name, bytes, MAX_TOTAL_BYTES)
}

/// [`attach`] with an explicit total-bytes cap for the directory (R22).
pub fn attach_with_cap(dir: &Path, raw_name: &str, bytes: &[u8], total_cap: u64) -> Result<Attachment, ChatError> {
    if bytes.is_empty() {
        return Err(invalid("El archivo está vacío."));
    }
    if bytes.len() > MAX_FILE_BYTES {
        return Err(invalid("El archivo supera el límite de 10 MB."));
    }
    let Some(mime) = detect_mime(bytes) else {
        return Err(invalid(
            "Ese tipo de archivo no está permitido: se aceptan imágenes (PNG, JPEG, WebP, GIF) o texto.",
        ));
    };
    if dir_bytes(dir).saturating_add(bytes.len() as u64) > total_cap {
        return Err(invalid("La carpeta de archivos adjuntos está llena: se alcanzó el límite de espacio."));
    }
    let name = sanitize_name(raw_name);
    let id = random_hex();
    let stored = format!("{id}-{name}");
    fs::create_dir_all(dir).map_err(|_| invalid("No se pudo preparar la carpeta de archivos adjuntos."))?;
    #[cfg(unix)]
    {
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    }
    let temp = dir.join(format!("tmp-{id}"));
    let write = || -> std::io::Result<()> {
        fs::write(&temp, bytes)?;
        #[cfg(unix)]
        fs::set_permissions(&temp, fs::Permissions::from_mode(0o600))?;
        fs::rename(&temp, dir.join(&stored))
    };
    if let Err(_e) = write() {
        let _ = fs::remove_file(&temp); // never leave a partial file behind
        return Err(invalid("No se pudo guardar el archivo adjunto."));
    }
    Ok(Attachment {
        id: format!("a-{id}"),
        name,
        mime: mime.to_string(),
        size: bytes.len() as u64,
        file: stored,
    })
}

/// A workspace path the app accepts as its own: absolute, no `..`
/// component, existing directory. Mirrors the daemon's validateWorkspace
/// shape; the daemon still owns the island's own deeper checks.
pub fn valid_workspace(path: &Path) -> bool {
    if !path.is_absolute() || !path.is_dir() {
        return false;
    }
    path.components().all(|c| !matches!(c, std::path::Component::ParentDir))
}

/// The uploads directory inside the island's EFFECTIVE workspace:
/// `config.json`'s `workspace` when it is a valid own directory, otherwise
/// the island's owned default `<island>/workspace`. The directory is
/// created (0700) on demand.
pub fn attachments_dir(island_root: &Path) -> Result<PathBuf, ChatError> {
    // Never create the island root itself: it belongs to the daemon. A
    // missing island means the attachments workspace does not exist yet.
    if !island_root.is_dir() {
        return Err(invalid(
            "La carpeta de trabajo de Koda todavía no existe: abrí el chat cuando el motor esté disponible.",
        ));
    }
    let config = island_root.join("config.json");
    let configured = fs::read(&config).ok().and_then(|bytes| {
        serde_json::from_slice::<serde_json::Value>(&bytes).ok()
    }).and_then(|v| {
        v.get("workspace").and_then(serde_json::Value::as_str).map(PathBuf::from)
    });
    let workspace = match configured {
        Some(w) if valid_workspace(&w) => w,
        _ => island_root.join("workspace"),
    };
    let dir = workspace.join("uploads");
    fs::create_dir_all(&dir)
        .map_err(|_| invalid("No se pudo preparar la carpeta de archivos adjuntos."))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    }
    sweep_stale_tmp(&dir, STALE_TMP_SECS);
    Ok(dir)
}

/// Read a dropped path with the cap applied BEFORE reading: oversize and
/// non-regular files are refused without buffering their bytes.
pub fn read_dropped(path: &Path) -> Result<(String, Vec<u8>), ChatError> {
    let raw = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    // symlink_metadata: a symlink is refused, never followed.
    // symlink_metadata: a symlink is refused, never followed.
    let meta = fs::symlink_metadata(path)
        .map_err(|_| invalid("No se pudo leer el archivo arrastrado."))?;
    if !meta.is_file() {
        return Err(invalid("Eso no es un archivo."));
    }
    if meta.len() as usize > MAX_FILE_BYTES {
        return Err(invalid("El archivo supera el límite de 10 MB."));
    }
    let bytes = fs::read(path)
        .map_err(|_| invalid("No se pudo leer el archivo arrastrado."))?;
    Ok((raw, bytes))
}

/// Longest a native drop stays claimable.
pub const DROP_TTL_MS: u64 = 60_000;
/// Most native-dropped paths held at once.
pub const DROP_CAP: usize = 16;

/// Paths the OS reported through the native drag-drop event: short-lived,
/// bounded and one-shot. `chat_attach` only honours a member of this set.
#[derive(Default)]
pub struct DropSet {
    entries: Vec<(PathBuf, u64)>,
}

impl DropSet {
    /// An empty set, usable in a `static`.
    pub const fn new() -> Self {
        DropSet {
            entries: Vec::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    fn prune(&mut self, now_ms: u64) {
        self.entries
            .retain(|(_, at)| now_ms.saturating_sub(*at) <= DROP_TTL_MS);
    }

    /// Remember dropped paths; the oldest are evicted beyond `DROP_CAP`.
    pub fn record(&mut self, paths: Vec<PathBuf>, now_ms: u64) {
        self.prune(now_ms);
        for path in paths {
            self.entries.retain(|(p, _)| *p != path);
            self.entries.push((path, now_ms));
        }
        let excess = self.entries.len().saturating_sub(DROP_CAP);
        if excess > 0 {
            self.entries.drain(..excess);
        }
    }

    /// True once if `path` was dropped and is still fresh; it is removed.
    pub fn consume(&mut self, path: &Path, now_ms: u64) -> bool {
        self.prune(now_ms);
        match self.entries.iter().position(|(p, _)| p == path) {
            Some(i) => {
                self.entries.remove(i);
                true
            }
            None => false,
        }
    }
}

/// Split a raw `chat_attach_data` body into (display name, bytes): a
/// one-line JSON header `{"name":"…"}` (≤1 KiB), LF, then the file bytes.
pub fn split_raw_body(body: &[u8]) -> Result<(String, &[u8]), ChatError> {
    let bad = || invalid("Pedido de archivo inválido.");
    let line_end = body
        .iter()
        .position(|b| *b == b'\n')
        .filter(|i| *i <= 1024)
        .ok_or_else(bad)?;
    let header = std::str::from_utf8(&body[..line_end]).map_err(|_| bad())?;
    let name = serde_json::from_str::<serde_json::Value>(header)
        .map_err(|_| bad())?
        .get("name")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(bad)?
        .to_string();
    Ok((name, &body[line_end + 1..]))
}

// --- read-back for prompt building (#343) ------------------------------------

/// Bounded read of one stored attachment: the name must pass the stored-name
/// grammar and resolve INSIDE `dir`, the size is capped again, and the
/// content is re-validated with the SAME rules the attach command enforced.
fn read_stored(dir: &Path, attachment: &Attachment) -> Option<Vec<u8>> {
    if !valid_stored_name(&attachment.file)
        || attachment.size == 0
        || attachment.size > MAX_FILE_BYTES as u64
    {
        return None;
    }
    let path = dir.join(&attachment.file);
    if !path.starts_with(dir) {
        return None;
    }
    let meta = fs::metadata(&path).ok()?;
    if !meta.is_file() || meta.len() != attachment.size {
        return None;
    }
    fs::read(&path).ok()
}

/// One text attachment's inlined content (re-validated: UTF-8, no control
/// characters, bounded scalars). `None` = the content is not available.
pub fn stored_text(dir: &Path, attachment: &Attachment) -> Option<String> {
    if attachment.mime != "text/plain" {
        return None;
    }
    let bytes = read_stored(dir, attachment)?;
    if !is_plain_text(&bytes) {
        return None;
    }
    String::from_utf8(bytes).ok()
}

/// One image attachment as a `data:` URL (same allowlist, re-detected from
/// content). `None` = the content is not available or no longer matches.
pub fn stored_data_url(dir: &Path, attachment: &Attachment) -> Option<String> {
    use base64::Engine as _;
    let bytes = read_stored(dir, attachment)?;
    let mime = detect_mime(&bytes)?;
    if mime != attachment.mime {
        return None;
    }
    Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// #343: turn the attachment ids a submit references into attachment
/// metadata, resolved ONLY from the uploads directory (the page never sends
/// names, sizes or paths). Each id must match exactly one stored file whose
/// grammar-checked name extends it; the MIME type is re-detected from the
/// content. A missing or ambiguous id is a safe error — nothing is changed.
pub fn resolve_ids(dir: &Path, ids: &[String]) -> Result<Vec<Attachment>, ChatError> {
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        let prefix = format!("{}-", &id[2..]);
        let mut found: Option<Attachment> = None;
        let entries = fs::read_dir(dir)
            .map_err(|_| ChatError::attachment_unavailable())?;
        for entry in entries.filter_map(|e| e.ok()) {
            let file = entry.file_name().to_string_lossy().into_owned();
            if !file.starts_with(&prefix) || !valid_stored_name(&file) {
                continue;
            }
            if found.is_some() {
                return Err(ChatError::attachment_unavailable()); // ambiguous
            }
            let meta = entry.metadata().map_err(|_| ChatError::attachment_unavailable())?;
            if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_FILE_BYTES as u64 {
                return Err(ChatError::attachment_unavailable());
            }
            let bytes = fs::read(entry.path()).map_err(|_| ChatError::attachment_unavailable())?;
            let Some(mime) = detect_mime(&bytes) else {
                return Err(ChatError::attachment_unavailable());
            };
            found = Some(Attachment {
                id: id.clone(),
                name: file[prefix.len()..].to_string(),
                mime: mime.to_string(),
                size: meta.len(),
                file,
            });
        }
        out.push(found.ok_or_else(ChatError::attachment_unavailable)?);
    }
    Ok(out)
}

#[cfg(test)]
#[path = "uploads_tests.rs"]
mod tests;
