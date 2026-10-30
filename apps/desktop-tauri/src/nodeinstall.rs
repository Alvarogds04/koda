//! HU-069 T2 (human, verbatim option chosen: «Descargar el instalador oficial de Node con un clic (recomendado)»; rule 12 in AGENTS.md).
//! When no usable Node exists, ONE click downloads the official build from nodejs.org and verifies it against `SHASUMS256.txt`
//! (same https origin; the GPG signature of that file is not checked: no verifier ships with Abito), then:
//!   * macOS / Windows: the official `.pkg` / `.msi` is saved in a private folder and OPENED for the human (Abito never runs it);
//!   * Linux: the official `.tar.xz` is validated entry by entry and extracted with the system `tar` into
//!     `<data>/node` (a user folder, no sudo). Abito's discovery looks there (see `nodefinder`).
//! Nothing here takes a URL, a path or a version from the page; every URL is built from the constants below and must start with
//! [`DIST_BASE`]. The network and the program runner are injected so the whole flow is tested offline.
use crate::nodefinder::{Os, MIN_NODE};
use crate::piinstall::Reason;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

/// Node 22 LTS line (Pi needs >= 22.19): `latest-v22.x` always lists the newest 22.x files and their hashes.
pub const DIST_BASE: &str = "https://nodejs.org/dist/latest-v22.x/";
pub const SHASUMS_MAX: u64 = 256 * 1024;
pub const ARTIFACT_MAX: u64 = 400 * 1024 * 1024;
const TAR_LIMIT: Duration = Duration::from_secs(300);
const LISTING_CAP: usize = 8 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Arch { X64, Arm64 }
impl Arch {
    pub fn current() -> Option<Arch> {
        match std::env::consts::ARCH { "x86_64" => Some(Arch::X64), "aarch64" => Some(Arch::Arm64), _ => None }
    }
    fn tag(self) -> &'static str { match self { Arch::X64 => "x64", Arch::Arm64 => "arm64" } }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind { Tarball, Pkg, Msi }

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Artifact { pub name: String, pub sha256: String, pub kind: Kind, pub version: (u32, u32, u32) }
impl Artifact {
    pub fn url(&self) -> String { format!("{DIST_BASE}{}", self.name) }
    /// `node-v22.1.2-linux-x64` for a tarball: the single top folder every entry must live in.
    pub fn root(&self) -> Option<&str> { self.name.strip_suffix(".tar.xz") }
}

/// Network and program runner, injected. `get` streams `url` into `sink` and fails (closed reason) past `max` bytes.
pub trait Env {
    fn get(&self, url: &str, max: u64, sink: &mut dyn Write) -> Result<(), Reason>;
    /// Run `program` with a fixed argv, no shell; return its stdout. `Err` = could not run or non-zero exit.
    fn run(&self, program: &Path, args: &[String], cwd: Option<&Path>) -> Result<Vec<u8>, Reason>;
    fn exists(&self, program: &Path) -> bool { program.is_file() }
}

pub fn sha256_hex(bytes: &[u8]) -> String { hex(&Sha256::digest(bytes)) }
fn hex(bytes: &[u8]) -> String { bytes.iter().map(|b| format!("{b:02x}")).collect() }
fn file_sha256(path: &Path) -> Result<String, Reason> {
    let mut file = std::fs::File::open(path).map_err(|_| Reason::DownloadFailed)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|_| Reason::DownloadFailed)?;
        if n == 0 { break }
        hasher.update(&buf[..n]);
    }
    Ok(hex(&hasher.finalize()))
}

fn version(text: &str) -> Option<(u32, u32, u32)> {
    let mut parts = text.strip_prefix('v')?.split('.');
    let mut n = || { let p = parts.next()?; if p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()) { return None } p.parse::<u32>().ok() };
    let v = (n()?, n()?, n()?);
    parts.next().is_none().then_some(v)
}

/// The artifact this machine needs, taken from `SHASUMS256.txt` (`<64 hex>  <file name>` lines). A line whose hash is not 64 hex digits,
/// whose name is not exactly the expected shape, or whose version is below [`MIN_NODE`] is never used. Highest version wins.
pub fn pick_artifact(shasums: &str, os: Os, arch: Arch) -> Result<Artifact, Reason> {
    let mut best: Option<Artifact> = None;
    for line in shasums.lines() {
        let mut it = line.split_whitespace();
        let (Some(hash), Some(name), None) = (it.next(), it.next(), it.next()) else { continue };
        if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) { continue }
        let Some(rest) = name.strip_prefix("node-") else { continue };
        let (ver, kind) = match os {
            Os::Linux => match rest.strip_suffix(&format!("-linux-{}.tar.xz", arch.tag())) { Some(v) => (v, Kind::Tarball), None => continue },
            Os::Mac => match rest.strip_suffix(".pkg") { Some(v) => (v, Kind::Pkg), None => continue },
            Os::Windows => match rest.strip_suffix(&format!("-{}.msi", arch.tag())) { Some(v) => (v, Kind::Msi), None => continue },
        };
        let Some(v) = version(ver) else { continue };
        if v < MIN_NODE || v.0 != 22 { continue }
        if best.as_ref().is_none_or(|b| v > b.version) {
            best = Some(Artifact { name: name.to_owned(), sha256: hash.to_owned(), kind, version: v });
        }
    }
    best.ok_or(Reason::Unsupported)
}

/// Validate `tar -tvf` output (GNU format) BEFORE anything is extracted. Every entry must be a regular file, a directory or a symlink,
/// live under `root/`, have no absolute path and no `..`; a symlink target must be relative and stay inside `root/`.
/// Anything unparsable fails closed.
pub fn validate_listing(listing: &str, root: &str) -> Result<(), Reason> {
    let bad = Reason::UnsafeArchive;
    let mut any = false;
    // Every symlink seen so far (archive-relative, components). No later entry may pass THROUGH one, and no target may either:
    // that is what turns a chain of harmless-looking links into a write outside the root (JD-A-001).
    let mut links: Vec<Vec<String>> = Vec::new();
    let through_link = |parts: &[String], links: &[Vec<String>]| (1..parts.len()).any(|n| links.iter().any(|l| l.as_slice() == &parts[..n]));
    for line in listing.lines().filter(|l| !l.trim().is_empty()) {
        any = true;
        let kind = line.chars().next().ok_or(bad)?;
        if !matches!(kind, '-' | 'd' | 'l') { return Err(bad) }
        let mut fields = line.splitn(6, char::is_whitespace);
        // GNU tar -tv: perms owner/group size date time name — runs of spaces are possible, so skip empty fields.
        let mut rest = line;
        for _ in 0..5 {
            rest = rest.trim_start();
            rest = rest.split_once(char::is_whitespace).ok_or(bad)?.1;
        }
        let _ = fields.next();
        let rest = rest.trim_start();
        if rest.matches(" -> ").count() > 1 || (kind != 'l' && rest.contains(" -> ")) { return Err(bad) }
        let (name, target) = match rest.split_once(" -> ") { Some((n, t)) => (n, Some(t)), None => (rest, None) };
        if kind != 'l' && target.is_some() { return Err(bad) }
        if kind == 'l' && target.is_none() { return Err(bad) }
        let name_path = safe_relative(name).ok_or(bad)?;
        if name_path.components().next().and_then(|c| c.as_os_str().to_str()) != Some(root) { return Err(bad) }
        let name_parts: Vec<String> = name_path.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
        if through_link(&name_parts, &links) { return Err(bad) }
        if let Some(target) = target {
            let t = Path::new(target);
            if t.is_absolute() || target.is_empty() { return Err(bad) }
            // resolve against the link's own folder, depth counted from the archive top
            let mut at: Vec<String> = name_parts[..name_parts.len() - 1].to_vec();
            for c in t.components() {
                match c {
                    Component::Normal(n) => at.push(n.to_string_lossy().into_owned()),
                    Component::CurDir => {}
                    Component::ParentDir => { at.pop(); }
                    _ => return Err(bad),
                }
                if at.is_empty() { return Err(bad) } // left the root folder
                if through_link(&at, &links) || links.iter().any(|l| *l == at) { return Err(bad) } // a link resolved through (or onto) another link
            }
            links.push(name_parts);
        }
    }
    if any { Ok(()) } else { Err(bad) }
}
fn safe_relative(name: &str) -> Option<PathBuf> {
    if name.is_empty() || name.contains('\0') || name.contains('\\') { return None }
    let p = Path::new(name.trim_end_matches('/'));
    if p.is_absolute() { return None }
    let mut out = PathBuf::new();
    for c in p.components() {
        match c { Component::Normal(s) => out.push(s), _ => return None }
    }
    (!out.as_os_str().is_empty()).then_some(out)
}

fn fetch_to_file(env: &dyn Env, url: &str, max: u64, path: &Path) -> Result<(), Reason> {
    if !url.starts_with(DIST_BASE) { return Err(Reason::DownloadFailed) }
    let result = (|| {
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(path).map_err(|_| Reason::DownloadFailed)?;
        env.get(url, max, &mut file)?;
        file.sync_all().map_err(|_| Reason::DownloadFailed)
    })();
    if result.is_err() { let _ = std::fs::remove_file(path); }
    result
}

/// A private (0700 on Unix) directory created fresh under `parent`; never reuses an existing one.
pub fn private_dir(parent: &Path, prefix: &str) -> Result<PathBuf, Reason> {
    std::fs::create_dir_all(parent).map_err(|_| Reason::DownloadFailed)?;
    set_private(parent);
    static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let dir = parent.join(format!("{prefix}-{}-{nanos}-{}", std::process::id(), N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
    std::fs::create_dir(&dir).map_err(|_| Reason::DownloadFailed)?;
    set_private(&dir);
    Ok(dir)
}
fn set_private(dir: &Path) {
    #[cfg(unix)]
    { use std::os::unix::fs::PermissionsExt; let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)); }
    #[cfg(not(unix))]
    { let _ = dir; }
}

/// Download `SHASUMS256.txt`, pick this machine's artifact.
pub fn plan(env: &dyn Env, os: Os, arch: Arch, scratch: &Path) -> Result<Artifact, Reason> {
    let path = scratch.join("SHASUMS256.txt");
    fetch_to_file(env, &format!("{DIST_BASE}SHASUMS256.txt"), SHASUMS_MAX, &path)?;
    let text = std::fs::read_to_string(&path).map_err(|_| Reason::DownloadFailed)?;
    pick_artifact(&text, os, arch)
}

/// Download the artifact into `dir` and prove its SHA-256. A mismatch deletes the file.
pub fn download_verified(env: &dyn Env, artifact: &Artifact, dir: &Path) -> Result<PathBuf, Reason> {
    let path = dir.join(&artifact.name);
    fetch_to_file(env, &artifact.url(), ARTIFACT_MAX, &path)?;
    if file_sha256(&path)? != artifact.sha256 { let _ = std::fs::remove_file(&path); return Err(Reason::ChecksumMismatch) }
    Ok(path)
}

/// Re-prove the hash right before the file is handed to the OS (the folder is private, but this closes the window anyway).
pub fn reverify(artifact: &Artifact, path: &Path) -> Result<(), Reason> {
    if file_sha256(path)? == artifact.sha256 { Ok(()) } else { Err(Reason::ChecksumMismatch) }
}

fn system_tool(env: &dyn Env, name: &str) -> Option<PathBuf> {
    ["/usr/bin", "/bin"].iter().map(|d| Path::new(d).join(name)).find(|p| env.exists(p))
}

/// Linux: verify, validate every entry, extract into a private temp folder under `data`, then swap it in as `<data>/node`.
/// Returns the final `<data>/node` folder. The temp folder is always removed.
pub fn install_tarball(env: &dyn Env, artifact: &Artifact, data: &Path) -> Result<PathBuf, Reason> {
    let root = artifact.root().ok_or(Reason::Unsupported)?;
    let tar = system_tool(env, "tar").ok_or(Reason::TarMissing)?;
    system_tool(env, "xz").ok_or(Reason::XzMissing)?;
    // The listing parser reads GNU's column layout; any other tar (bsdtar...) is refused with its own reason instead of a false «unsafe».
    let version = env.run(&tar, &["--version".into()], None).map_err(|_| Reason::TarMissing)?;
    if !String::from_utf8_lossy(&version).contains("GNU tar") { return Err(Reason::TarMissing) }
    let tmp = private_dir(data, "node-tmp")?;
    let result = (|| {
        let file = download_verified(env, artifact, &tmp)?;
        let file_arg = file.to_string_lossy().into_owned();
        let listing = env.run(&tar, &["--numeric-owner".into(), "-tvJf".into(), file_arg.clone()], Some(&tmp)).map_err(|_| Reason::UnsafeArchive)?;
        validate_listing(&String::from_utf8_lossy(&listing), root)?;
        reverify(artifact, &file)?; // the bytes that were listed are the bytes extracted
        let out = tmp.join("x");
        std::fs::create_dir(&out).map_err(|_| Reason::InstallFailed)?;
        env.run(&tar, &["-xJf".into(), file_arg, "-C".into(), out.to_string_lossy().into_owned(), "--no-same-owner".into(), "--no-same-permissions".into()], Some(&tmp))
            .map_err(|_| Reason::InstallFailed)?;
        let extracted = out.join(root);
        if !std::fs::metadata(extracted.join("bin/node")).is_ok_and(|m| m.is_file()) { return Err(Reason::InstallFailed) }
        let dest = data.join("node");
        let old = tmp.join("previous");
        if dest.exists() { std::fs::rename(&dest, &old).map_err(|_| Reason::InstallFailed)?; }
        if std::fs::rename(&extracted, &dest).is_err() {
            if old.exists() { let _ = std::fs::rename(&old, &dest); }
            return Err(Reason::InstallFailed);
        }
        Ok(dest)
    })();
    force_remove(&tmp);
    result
}
/// Remove a tree even when an archive left directories without owner write permission.
fn force_remove(dir: &Path) {
    #[cfg(unix)]
    fn open_up(dir: &Path) {
        use std::os::unix::fs::PermissionsExt;
        let Ok(meta) = std::fs::symlink_metadata(dir) else { return };
        if !meta.is_dir() { return }
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        if let Ok(entries) = std::fs::read_dir(dir) { for e in entries.flatten() { open_up(&e.path()); } }
    }
    #[cfg(unix)]
    open_up(dir);
    let _ = std::fs::remove_dir_all(dir);
}

/// The `bin` folder of the user-folder install; the finder looks here on Linux.
pub fn linux_node_bin(data: &Path) -> PathBuf { data.join("node").join("bin") }

/// The real network + runner. HTTPS only, no redirects, bounded by size and time. Used by the host; tests use a fake.
pub struct Real;
impl Env for Real {
    fn get(&self, url: &str, max: u64, sink: &mut dyn Write) -> Result<(), Reason> {
        use futures_util::StreamExt;
        if !url.starts_with(DIST_BASE) { return Err(Reason::DownloadFailed) }
        let client = reqwest::Client::builder().https_only(true).redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(20)).read_timeout(Duration::from_secs(60)).timeout(Duration::from_secs(900))
            .user_agent(concat!("Abito/", env!("CARGO_PKG_VERSION"))).build().map_err(|_| Reason::DownloadFailed)?;
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|_| Reason::DownloadFailed)?;
        runtime.block_on(async {
            let response = client.get(url).send().await.map_err(|_| Reason::DownloadFailed)?;
            if response.status().as_u16() != 200 { return Err(Reason::DownloadFailed) }
            if response.content_length().is_some_and(|n| n > max) { return Err(Reason::DownloadFailed) }
            let mut total: u64 = 0;
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|_| Reason::DownloadFailed)?;
                total += chunk.len() as u64;
                if total > max { return Err(Reason::DownloadFailed) }
                sink.write_all(&chunk).map_err(|_| Reason::DownloadFailed)?;
            }
            Ok(())
        })
    }
    fn run(&self, program: &Path, args: &[String], cwd: Option<&Path>) -> Result<Vec<u8>, Reason> {
        // xz is found by tar through PATH: a fixed one, never the app's own.
        let env = [("PATH".to_owned(), "/usr/bin:/bin".to_owned())];
        crate::agents_direct::run_bounded_in(program, args, &env, cwd, TAR_LIMIT, LISTING_CAP).map_err(|_| Reason::InstallFailed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    const NAME: &str = "node-v22.30.1-linux-x64.tar.xz";
    const ROOT: &str = "node-v22.30.1-linux-x64";

    fn scratch(tag: &str) -> PathBuf {
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let d = std::env::temp_dir().join(format!("abito-nodeinstall-{tag}-{}-{}", std::process::id(), N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    /// Offline network: url -> bytes. Also records every URL asked.
    struct Fake { files: HashMap<String, Vec<u8>>, asked: RefCell<Vec<String>>, tools: bool }
    impl Env for Fake {
        fn get(&self, url: &str, max: u64, sink: &mut dyn Write) -> Result<(), Reason> {
            self.asked.borrow_mut().push(url.to_owned());
            let body = self.files.get(url).ok_or(Reason::DownloadFailed)?;
            if body.len() as u64 > max { return Err(Reason::DownloadFailed) }
            sink.write_all(body).map_err(|_| Reason::DownloadFailed)
        }
        fn run(&self, program: &Path, args: &[String], cwd: Option<&Path>) -> Result<Vec<u8>, Reason> {
            Real.run(program, args, cwd)
        }
        fn exists(&self, program: &Path) -> bool { self.tools && program.is_file() }
    }
    fn shasums(entries: &[(&str, &str)]) -> Vec<u8> {
        entries.iter().map(|(h, n)| format!("{h}  {n}\n")).collect::<String>().into_bytes()
    }
    /// A real tarball made by the system tar + xz: bin/node (executable script), lib/node_modules/npm, and a relative symlink.
    fn make_tarball(extra: impl Fn(&Path)) -> Option<Vec<u8>> {
        let work = scratch("mk");
        let top = work.join(ROOT);
        std::fs::create_dir_all(top.join("bin")).unwrap();
        std::fs::create_dir_all(top.join("lib/node_modules/npm/bin")).unwrap();
        std::fs::write(top.join("bin/node"), "#!/bin/sh\necho v22.30.1\n").unwrap();
        std::fs::write(top.join("lib/node_modules/npm/bin/npm-cli.js"), "").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(top.join("bin/node"), std::fs::Permissions::from_mode(0o755)).unwrap();
            std::os::unix::fs::symlink("../lib/node_modules/npm/bin/npm-cli.js", top.join("bin/npm")).unwrap();
        }
        extra(&top);
        let out = work.join("n.tar.xz");
        let ok = std::process::Command::new("tar").args(["-cJf"]).arg(&out).arg("-C").arg(&work).arg(ROOT).status().ok()?.success();
        ok.then(|| std::fs::read(out).unwrap())
    }
    fn linux_env(tarball: Vec<u8>, hash: Option<String>) -> Fake {
        let h = hash.unwrap_or_else(|| sha256_hex(&tarball));
        let mut files = HashMap::new();
        files.insert(format!("{DIST_BASE}SHASUMS256.txt"), shasums(&[(&h, NAME), (&"0".repeat(64), "node-v22.30.1.pkg")]));
        files.insert(format!("{DIST_BASE}{NAME}"), tarball);
        Fake { files, asked: RefCell::new(vec![]), tools: true }
    }
    fn have_tools() -> bool { ["/usr/bin/tar", "/bin/tar"].iter().any(|p| Path::new(p).is_file()) && ["/usr/bin/xz", "/bin/xz"].iter().any(|p| Path::new(p).is_file()) }

    #[test]
    fn the_artifact_is_picked_per_os_from_shasums_and_malformed_lines_are_ignored() {
        let h = |c: char| c.to_string().repeat(64);
        let text = format!(
            "{a}  node-v22.19.0-linux-x64.tar.xz\n{b}  node-v22.30.1-linux-x64.tar.xz\n{c}  node-v22.30.1-linux-arm64.tar.xz\n{d}  node-v22.30.1.pkg\n{e}  node-v22.30.1-x64.msi\n{f}  node-v22.30.1-arm64.msi\n\
             {g}  node-v22.99.0-linux-x64.tar.xz.sig\nzz  node-v22.40.0-linux-x64.tar.xz\n{h2}  node-v22.18.9-linux-x64.tar.xz\n{i}  node-v24.0.0-linux-x64.tar.xz\n{j}  ../node-v22.50.0-linux-x64.tar.xz extra\n",
            a = h('a'), b = h('b'), c = h('c'), d = h('d'), e = h('e'), f = h('f'), g = h('9'), h2 = h('8'), i = h('7'), j = h('6'));
        let linux = pick_artifact(&text, Os::Linux, Arch::X64).unwrap();
        assert_eq!((linux.name.as_str(), linux.sha256.as_str(), linux.kind, linux.version), ("node-v22.30.1-linux-x64.tar.xz", h('b').as_str(), Kind::Tarball, (22, 30, 1)));
        assert_eq!(pick_artifact(&text, Os::Linux, Arch::Arm64).unwrap().name, "node-v22.30.1-linux-arm64.tar.xz");
        assert_eq!(pick_artifact(&text, Os::Mac, Arch::Arm64).unwrap().name, "node-v22.30.1.pkg");
        assert_eq!(pick_artifact(&text, Os::Windows, Arch::X64).unwrap().name, "node-v22.30.1-x64.msi");
        assert_eq!(pick_artifact(&text, Os::Windows, Arch::Arm64).unwrap().name, "node-v22.30.1-arm64.msi");
        assert_eq!(pick_artifact("", Os::Linux, Arch::X64), Err(Reason::Unsupported));
        assert_eq!(linux.url(), "https://nodejs.org/dist/latest-v22.x/node-v22.30.1-linux-x64.tar.xz");
    }

    #[test]
    fn listing_validation_refuses_traversal_absolute_links_and_special_files() {
        let ok = |l: &str| validate_listing(l, ROOT);
        let good = format!("drwxr-xr-x root/root 0 2025-01-01 00:00 {ROOT}/\n-rwxr-xr-x root/root 99 2025-01-01 00:00 {ROOT}/bin/node\nlrwxrwxrwx root/root 0 2025-01-01 00:00 {ROOT}/bin/npm -> ../lib/node_modules/npm/bin/npm-cli.js\n");
        assert_eq!(ok(&good), Ok(()));
        for bad in [
            format!("-rw-r--r-- r/r 1 2025-01-01 00:00 /etc/passwd\n"),
            format!("-rw-r--r-- r/r 1 2025-01-01 00:00 {ROOT}/../evil\n"),
            format!("-rw-r--r-- r/r 1 2025-01-01 00:00 other/file\n"),
            format!("lrwxrwxrwx r/r 0 2025-01-01 00:00 {ROOT}/bin/x -> /etc/passwd\n"),
            format!("lrwxrwxrwx r/r 0 2025-01-01 00:00 {ROOT}/bin/x -> ../../outside\n"),
            format!("lrwxrwxrwx r/r 0 2025-01-01 00:00 {ROOT}/bin/x -> ../..\n"),
            format!("hrwxr-xr-x r/r 0 2025-01-01 00:00 {ROOT}/bin/x link to {ROOT}/bin/y\n"),
            format!("crw-rw-rw- 1/1 0,0 2025-01-01 00:00 {ROOT}/dev\n"),
            format!("-rw-r--r-- r/r 1 2025-01-01 00:00 {ROOT}/a -> b\n"),
            // JD-A-001: a name holding « -> » must not shift the parsed target, and chained links must not climb out
            format!("lrwxrwxrwx r/r 0 2025-01-01 00:00 {ROOT}/x -> a -> ../..\n"),
            format!("lrwxrwxrwx r/r 0 2025-01-01 00:00 {ROOT}/sub/l1 -> ..\nlrwxrwxrwx r/r 0 2025-01-01 00:00 {ROOT}/l2 -> sub/l1/..\n"),
            format!("lrwxrwxrwx r/r 0 2025-01-01 00:00 {ROOT}/d -> bin\n-rw-r--r-- r/r 1 2025-01-01 00:00 {ROOT}/d/PWNED\n"),
            String::new(), "garbage\n".to_owned(),
        ] { assert_eq!(ok(&bad), Err(Reason::UnsafeArchive), "{bad:?}"); }
    }

    // The tarball path is Linux's mechanism (macOS/Windows use the .pkg/.msi path, tested below on every OS; bsdtar is refused by design).
    #[cfg(target_os = "linux")]
    /// JD-A-001 recheck: a PAX owner name with spaces and slashes shifted the columns of `tar -tv`. Owner and group are listed numerically.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_spaced_owner_name_cannot_shift_the_listing_columns() {
        if !have_tools() { return }
        let work = scratch("uname");
        let top = work.join(ROOT);
        std::fs::create_dir_all(top.join("bin")).unwrap();
        std::fs::write(top.join("bin/node"), "x").unwrap();
        let tarball = work.join("n.tar");
        let made = std::process::Command::new("tar").args(["--format=pax", "--owner=a 0 d t R/a/b/c", "--group=g h", "-cf"]).arg(&tarball).arg("-C").arg(&work).arg(ROOT).status().unwrap();
        assert!(made.success());
        let numeric = std::process::Command::new("tar").args(["--numeric-owner", "-tvf"]).arg(&tarball).output().unwrap();
        let text = String::from_utf8_lossy(&numeric.stdout).into_owned();
        assert!(!text.contains("a 0 d t"), "owner printed numerically: {text}");
        assert_eq!(validate_listing(&text, ROOT), Ok(()));
        let named = std::process::Command::new("tar").args(["-tvf"]).arg(&tarball).output().unwrap();
        assert!(String::from_utf8_lossy(&named.stdout).contains("a 0 d t"), "without the flag the spaced name does appear (this is what the flag prevents)");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_one_click_verifies_the_hash_validates_extracts_and_swaps_atomically() {
        if !have_tools() { assert!(std::env::var_os("CI").is_none(), "CI must have tar and xz"); return }
        let tar = make_tarball(|_| {}).unwrap();
        let env = linux_env(tar, None);
        let data = scratch("data");
        let art = plan(&env, Os::Linux, Arch::X64, &data).unwrap();
        // plan() wrote its file inside the data dir given; use a fresh data dir for the install itself
        let dest = install_tarball(&env, &art, &data).unwrap();
        assert_eq!(dest, data.join("node"));
        assert!(dest.join("bin/node").is_file() && dest.join("lib/node_modules/npm/bin/npm-cli.js").is_file());
        #[cfg(unix)]
        { use std::os::unix::fs::PermissionsExt; assert_ne!(std::fs::metadata(dest.join("bin/node")).unwrap().permissions().mode() & 0o111, 0, "node stays executable"); }
        assert!(std::fs::read_dir(&data).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().starts_with("node-tmp")), "the temp folder is gone");
        // discovery now finds it and the npm CLI sits where `piinstall::npm_cli` looks
        assert_eq!(linux_node_bin(&data), dest.join("bin"));
        assert!(crate::piinstall::npm_cli(&dest.join("bin/node")).is_some());
        // a second install replaces the first, never nests it
        std::fs::write(dest.join("old-marker"), "").unwrap();
        install_tarball(&env, &art, &data).unwrap();
        assert!(!data.join("node/old-marker").exists() && data.join("node/bin/node").is_file());
        for url in env.asked.borrow().iter() { assert!(url.starts_with("https://nodejs.org/dist/latest-v22.x/"), "{url}"); }
    }

    // The tarball path is Linux's mechanism (macOS/Windows use the .pkg/.msi path, tested below on every OS; bsdtar is refused by design).
    #[cfg(target_os = "linux")]
    #[test]
    fn a_wrong_hash_stops_before_tar_runs_and_leaves_nothing_behind() {
        if !have_tools() { return }
        let tar = make_tarball(|_| {}).unwrap();
        let env = linux_env(tar, Some("1".repeat(64)));
        let data = scratch("badhash");
        let art = plan(&env, Os::Linux, Arch::X64, &data).unwrap();
        assert_eq!(install_tarball(&env, &art, &data), Err(Reason::ChecksumMismatch));
        assert!(!data.join("node").exists());
        let leftovers: Vec<_> = std::fs::read_dir(&data).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert!(leftovers.iter().all(|n| !n.starts_with("node-tmp")), "{leftovers:?}");
    }

    // The tarball path is Linux's mechanism (macOS/Windows use the .pkg/.msi path, tested below on every OS; bsdtar is refused by design).
    #[cfg(target_os = "linux")]
    #[test]
    fn an_archive_with_an_escaping_symlink_is_refused_even_with_a_valid_hash_and_nothing_is_extracted() {
        if !have_tools() { return }
        #[cfg(unix)]
        {
            let tar = make_tarball(|top| { std::os::unix::fs::symlink("../../../../etc", top.join("bin/escape")).unwrap(); }).unwrap();
            let env = linux_env(tar, None);
            let data = scratch("evil");
            let art = plan(&env, Os::Linux, Arch::X64, &data).unwrap();
            assert_eq!(install_tarball(&env, &art, &data), Err(Reason::UnsafeArchive));
            assert!(!data.join("node").exists());
        }
    }

    #[test]
    fn missing_tar_or_xz_is_a_named_reason_not_a_silent_failure() {
        let tar = vec![1u8, 2, 3];
        let mut env = linux_env(tar, None);
        env.tools = false;
        let data = scratch("tools");
        let art = plan(&env, Os::Linux, Arch::X64, &data).unwrap();
        assert_eq!(install_tarball(&env, &art, &data), Err(Reason::TarMissing));
        assert!(Reason::TarMissing.say().contains("tar") && Reason::XzMissing.say().contains("xz"));
        struct OnlyTar(Fake);
        impl Env for OnlyTar {
            fn get(&self, u: &str, m: u64, s: &mut dyn Write) -> Result<(), Reason> { self.0.get(u, m, s) }
            fn run(&self, p: &Path, a: &[String], c: Option<&Path>) -> Result<Vec<u8>, Reason> { self.0.run(p, a, c) }
            fn exists(&self, p: &Path) -> bool { p.file_name().is_some_and(|n| n == "tar") && p.is_file() }
        }
        if ["/usr/bin/tar", "/bin/tar"].iter().any(|p| Path::new(p).is_file()) {
            let fake = linux_env(vec![1], None);
            assert_eq!(install_tarball(&OnlyTar(fake), &art, &data), Err(Reason::XzMissing));
        }
    }

    #[test]
    fn mac_and_windows_download_only_save_a_verified_installer_in_a_private_folder() {
        for (os, name, ext) in [(Os::Mac, "node-v22.30.1.pkg", "pkg"), (Os::Windows, "node-v22.30.1-x64.msi", "msi")] {
            let body = format!("fake {ext} installer").into_bytes();
            let mut files = HashMap::new();
            files.insert(format!("{DIST_BASE}SHASUMS256.txt"), shasums(&[(&sha256_hex(&body), name)]));
            files.insert(format!("{DIST_BASE}{name}"), body);
            let env = Fake { files, asked: RefCell::new(vec![]), tools: true };
            let data = scratch(ext);
            let art = plan(&env, os, Arch::X64, &data).unwrap();
            let dir = private_dir(&data, "node-installer").unwrap();
            let path = download_verified(&env, &art, &dir).unwrap();
            assert!(path.starts_with(&dir) && path.extension().is_some_and(|e| e == ext));
            #[cfg(unix)]
            { use std::os::unix::fs::PermissionsExt; assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700); }
            assert_eq!(reverify(&art, &path), Ok(()));
            std::fs::write(&path, "tampered").unwrap();
            assert_eq!(reverify(&art, &path), Err(Reason::ChecksumMismatch), "a file swapped after the download is not opened");
        }
    }

    #[test]
    fn only_dist_urls_are_fetched_and_oversized_bodies_are_refused() {
        let env = Fake { files: HashMap::new(), asked: RefCell::new(vec![]), tools: true };
        let dir = scratch("url");
        assert_eq!(fetch_to_file(&env, "https://evil.example/node.pkg", 10, &dir.join("a")), Err(Reason::DownloadFailed));
        assert!(env.asked.borrow().is_empty(), "nothing outside the distribution folder is even asked");
        assert_eq!(fetch_to_file(&env, "http://nodejs.org/dist/latest-v22.x/x", 10, &dir.join("a")), Err(Reason::DownloadFailed));
        let mut files = HashMap::new();
        files.insert(format!("{DIST_BASE}big"), vec![0u8; 100]);
        let env = Fake { files, asked: RefCell::new(vec![]), tools: true };
        assert_eq!(fetch_to_file(&env, &format!("{DIST_BASE}big"), 10, &dir.join("b")), Err(Reason::DownloadFailed));
        assert!(!dir.join("b").exists(), "a failed download leaves no partial file");
    }
}
