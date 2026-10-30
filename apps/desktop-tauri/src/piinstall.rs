//! HU-046 (human, verbatim option chosen: «Botón «Instalar Pi» (recomendado)»): Abito's chat runs on Pi. When Pi is missing the
//! human can press «Instalar Pi»; this module is the pure, bounded core of what that press runs. It executes exactly
//! `node <npm-cli.js> install -g @earendil-works/pi-coding-agent` with the Node Abito already discovered: no shell, no `.cmd` shim,
//! no PATH lookup of the program, no argument and no URL from the page, a minimal environment, a hard time limit. It never elevates
//! (no sudo, no UAC): if the npm prefix is not writable the install fails with a plain reason. Success is decided by running Pi
//! discovery again, never by npm's exit code alone.
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::Value;

/// The only package this module ever installs.
pub const PACKAGE: &str = "@earendil-works/pi-coding-agent";
/// Rust owns the one URL it may open when Node.js is missing; the page never supplies it.
pub const NODE_URL: &str = "https://nodejs.org/";
/// A global npm install downloads a package tree: generous, but bounded.
pub const INSTALL_LIMIT: Duration = Duration::from_secs(300);
/// npm prints a lot while installing; Abito never shows it (only the closed reasons below), so this only bounds memory.
pub const OUTPUT_CAP: usize = 256 * 1024;

/// The closed vocabulary of why an install did not end with Pi usable. The page shows fixed Spanish sentences for these;
/// raw npm output never reaches it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    /// Node.js is not installed: the button opens nodejs.org instead.
    NodeMissing,
    /// Node is there but its bundled npm was not found next to it.
    NpmMissing,
    /// The install did not finish inside the time limit.
    Timeout,
    /// npm could not be started, or exited with an error (typically a prefix the user may not write to).
    InstallFailed,
    /// npm said it succeeded but Abito's discovery still does not find Pi (a custom npm prefix): Pi is NOT marked installed.
    NotFoundAfter,
    /// Another install is already running.
    Busy,
    /// Pi is installed and discovery finds it, but the chat host could not be started: reopening Abito is the way forward.
    HostFailed,
    /// The human pressed «Abrir nodejs.org» but Node.js is there now: nothing is opened and nothing is installed.
    NodeAppeared,
    /// HU-069: the official Node.js download failed (network, size limit, or an address outside nodejs.org's distribution folder).
    DownloadFailed,
    /// HU-069: the download does not match the hash published in SHASUMS256.txt; it was deleted and nothing was installed.
    ChecksumMismatch,
    /// HU-069: the Linux archive holds an entry that could leave its folder; nothing was extracted.
    UnsafeArchive,
    /// HU-069 (Linux): the system `tar` / `xz` needed to unpack the official archive is missing.
    TarMissing,
    XzMissing,
    /// HU-069: this OS or CPU has no official Node.js build Abito can fetch.
    Unsupported,
}
impl Reason {
    pub fn code(self) -> &'static str {
        match self {
            Self::NodeMissing => "node_missing", Self::NpmMissing => "npm_missing", Self::Timeout => "timeout",
            Self::InstallFailed => "install_failed", Self::NotFoundAfter => "not_found_after", Self::Busy => "busy", Self::HostFailed => "host_failed", Self::NodeAppeared => "node_appeared",
            Self::DownloadFailed => "node_download_failed", Self::ChecksumMismatch => "node_checksum_mismatch", Self::UnsafeArchive => "node_unsafe_archive",
            Self::TarMissing => "tar_missing", Self::XzMissing => "xz_missing", Self::Unsupported => "node_unsupported",
        }
    }
    /// What the human reads. Fixed text: nothing from npm, the page or the filesystem is interpolated.
    pub fn say(self) -> &'static str {
        match self {
            Self::NodeMissing => "Falta Node.js. Instalalo desde nodejs.org y volvé a Koda.",
            Self::NpmMissing => "Se encontró Node.js pero no su npm. Reinstalá Node.js desde nodejs.org y volvé a Koda.",
            Self::Timeout => "La instalación de Pi tardó demasiado y se canceló. Probá de nuevo.",
            Self::InstallFailed => "No se pudo instalar Pi. Si Node.js está en una carpeta del sistema, instalalo desde una terminal con permisos o configurá una carpeta propia para npm.",
            Self::NotFoundAfter => "npm terminó, pero Koda no encuentra Pi todavía. Reabrí Koda; si sigue igual, revisá la carpeta global de npm.",
            Self::Busy => "Ya hay una instalación de Pi en curso.",
            Self::HostFailed => "Pi se instaló, pero el chat no pudo arrancar. Reabrí Koda.",
            Self::NodeAppeared => "Node.js ya está instalado. Tocá «Instalar Pi».",
            Self::DownloadFailed => "No se pudo descargar Node.js desde nodejs.org. Revisá tu conexión y probá de nuevo.",
            Self::ChecksumMismatch => "La descarga de Node.js no coincide con la huella publicada por nodejs.org. Se descartó y no se instaló nada.",
            Self::UnsafeArchive => "El archivo de Node.js trae contenido que no es seguro de abrir. No se instaló nada.",
            Self::TarMissing => "Falta el programa «tar» en tu sistema, que Koda necesita para abrir Node.js. Instalá el paquete «tar» de tu distribución y probá de nuevo.",
            Self::XzMissing => "Falta el programa «xz» en tu sistema, que Koda necesita para abrir Node.js. Instalá el paquete «xz» (xz-utils) de tu distribución y probá de nuevo.",
            Self::Unsupported => "No hay un Node.js oficial para este sistema que Koda pueda descargar. Instalalo desde nodejs.org.",
        }
    }
}

/// The closed payload of the command: exactly `{"action":"status"|"run"|"open_node"|"install_node"|"check_node"}`. `open_node` is its own action so the
/// node-missing button can never start an install.
pub fn parse_action(payload: &Value) -> Option<&'static str> {
    let obj = payload.as_object()?;
    if obj.len() != 1 { return None; }
    match obj.get("action")?.as_str()? { "status" => Some("status"), "run" => Some("run"), "open_node" => Some("open_node"), "install_node" => Some("install_node"), "check_node" => Some("check_node"), _ => None }
}

/// npm's own CLI script, found next to the discovered Node and never through PATH or a `.cmd` shim:
/// `<node dir>/node_modules/npm/bin/npm-cli.js` (Windows, official layout) or `<prefix>/lib/node_modules/npm/bin/npm-cli.js`
/// (Linux/macOS, where `node` lives in `<prefix>/bin`). The script must be a regular file.
pub fn npm_cli(node: &Path) -> Option<PathBuf> {
    let real = std::fs::canonicalize(node).ok()?;
    let dir = real.parent()?;
    let tail = Path::new("node_modules").join("npm").join("bin").join("npm-cli.js");
    [dir.join(&tail), dir.parent()?.join("lib").join(&tail)].into_iter()
        .find(|p| std::fs::symlink_metadata(p).is_ok_and(|m| m.is_file()))
        .map(plain_path)
}
/// Windows `canonicalize` yields the `\\?\C:\...` verbatim form; Node and npm scripts handle the plain drive path best, so drop the prefix
/// for ordinary drive paths (UNC and anything else is returned as is).
fn plain_path(p: PathBuf) -> PathBuf {
    let text = p.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if rest.len() > 2 && rest.as_bytes()[1] == b':' => PathBuf::from(rest),
        _ => p,
    }
}

/// Exactly the arguments handed to Node. Fixed: nothing here comes from outside.
pub fn argv(npm_cli: &Path) -> Vec<String> {
    vec![npm_cli.to_string_lossy().into_owned(), "install".into(), "-g".into(), PACKAGE.into()]
}

/// The environment npm runs in: a short allowlist copied from the app's own, with PATH rebuilt from absolute entries and the
/// discovered Node's directory FIRST (npm's scripts spawn `node`). Nothing else is inherited: no NODE_OPTIONS, no `npm_config_*`.
pub fn env(node: &Path, vars: &[(String, String)]) -> Vec<(String, String)> {
    const ALLOW: [&str; 22] = ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "SystemRoot", "TEMP", "TMP", "TMPDIR", "LANG",
        "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "ProgramFiles",
        "PATHEXT", "ComSpec", "COMSPEC"];
    let mut out: Vec<(String, String)> = vars.iter().filter(|(k, _)| ALLOW.contains(&k.as_str())).cloned().collect();
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(dir) = node.parent() { dirs.push(dir.to_owned()); }
    if let Some((_, path)) = vars.iter().find(|(k, _)| k.eq_ignore_ascii_case("PATH")) {
        for d in std::env::split_paths(path).filter(|d| d.is_absolute()) { if !dirs.contains(&d) { dirs.push(d); } }
    }
    if let Ok(joined) = std::env::join_paths(dirs) { out.push(("PATH".into(), joined.to_string_lossy().into_owned())); }
    out
}

/// Run the install. `Ok` only means npm exited 0; the caller must still re-run discovery before calling Pi installed.
pub fn run(node: &Path, npm_cli: &Path, env: &[(String, String)], cwd: Option<&Path>, limit: Duration) -> Result<(), Reason> {
    let started = Instant::now();
    match crate::agents_direct::run_bounded_in(node, &argv(npm_cli), env, cwd, limit, OUTPUT_CAP) {
        Ok(_) => Ok(()),
        Err(_) if started.elapsed() >= limit => Err(Reason::Timeout),
        Err(_) => Err(Reason::InstallFailed),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("abito-piinstall-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }
    /// The Node that runs this very test run, found the way the app finds it (absolute PATH entries only). `node.exe` on Windows: looking for
    /// a file named `node` there finds nothing, and every fake-npm test below used to «skip» and pass without testing anything.
    fn real_node() -> Option<PathBuf> {
        let name = if cfg!(windows) { "node.exe" } else { "node" };
        std::env::split_paths(&std::env::var_os("PATH")?).filter(|d| d.is_absolute()).map(|d| d.join(name)).find(|p| p.is_file())
    }
    /// The same, but a CI run (GitHub sets `CI`) with no Node is a FAILURE, never a silent green: the fake-npm tests are the proof that npm
    /// gets the fixed argv, the filtered environment and the chosen directory. Outside CI a missing Node skips with a message.
    fn need_node() -> Option<PathBuf> {
        let found = real_node();
        if found.is_none() {
            assert!(std::env::var_os("CI").is_none(), "CI has no node on PATH: the fake-npm tests must not skip silently");
            eprintln!("skipped: no node on PATH");
        }
        found
    }
    /// An absolute directory on every platform: «/opt/node/bin» on Unix, «C:\opt\node\bin» on Windows (where «/opt/..» is NOT absolute).
    fn abs(parts: &[&str]) -> PathBuf {
        let mut path = PathBuf::from(if cfg!(windows) { "C:\\" } else { "/" });
        for part in parts { path.push(part); }
        path
    }
    /// What a child needs to start at all: PATH, plus SystemRoot/TEMP on Windows (node.exe can fail to start without SystemRoot).
    fn base_vars() -> Vec<(String, String)> {
        ["PATH", "SystemRoot", "TEMP", "TMP", "TMPDIR"].iter().filter_map(|k| std::env::var(k).ok().map(|v| (k.to_string(), v))).collect()
    }

    #[test]
    fn the_command_payload_is_closed() {
        assert_eq!(parse_action(&json!({"action":"status"})), Some("status"));
        assert_eq!(parse_action(&json!({"action":"run"})), Some("run"));
        assert_eq!(parse_action(&json!({"action":"open_node"})), Some("open_node"), "the node-missing button has its OWN closed action: it never installs");
        for bad in [json!(null), json!({}), json!({"action":"install"}), json!({"action":"run","package":"x"}), json!({"action":"run","url":"https://x"}),
            json!({"action":1}), json!("run"), json!(["run"])] { assert_eq!(parse_action(&bad), None, "{bad}"); }
    }

    #[test]
    fn what_is_run_is_fixed_and_the_one_url_is_nodejs_org() {
        assert_eq!(argv(Path::new("/n/npm-cli.js")), ["/n/npm-cli.js", "install", "-g", "@earendil-works/pi-coding-agent"]);
        assert_eq!(NODE_URL, "https://nodejs.org/");
        assert_eq!(PACKAGE, "@earendil-works/pi-coding-agent");
    }

    #[test]
    fn npm_is_found_next_to_the_discovered_node_never_through_path_or_a_shim() {
        let root = scratch("npm");
        // Linux/macOS layout: <prefix>/bin/node and <prefix>/lib/node_modules/npm/bin/npm-cli.js
        let unix = root.join("unix"); fs::create_dir_all(unix.join("bin")).unwrap(); fs::create_dir_all(unix.join("lib/node_modules/npm/bin")).unwrap();
        fs::write(unix.join("bin/node"), "").unwrap(); fs::write(unix.join("lib/node_modules/npm/bin/npm-cli.js"), "").unwrap();
        assert_eq!(npm_cli(&unix.join("bin/node")).map(|p| p.strip_prefix(plain_path(fs::canonicalize(&unix).unwrap())).unwrap().to_path_buf()),
            Some(PathBuf::from("lib/node_modules/npm/bin/npm-cli.js")));
        // Windows layout: <dir>/node.exe and <dir>/node_modules/npm/bin/npm-cli.js
        let win = root.join("win"); fs::create_dir_all(win.join("node_modules/npm/bin")).unwrap();
        fs::write(win.join("node.exe"), "").unwrap(); fs::write(win.join("node_modules/npm/bin/npm-cli.js"), "").unwrap();
        assert!(npm_cli(&win.join("node.exe")).is_some());
        // a .cmd shim is never what is returned, and a missing script is None
        fs::write(win.join("npm.cmd"), "").unwrap();
        assert!(npm_cli(&win.join("node.exe")).unwrap().extension().is_some_and(|e| e == "js"));
        let bare = root.join("bare"); fs::create_dir_all(&bare).unwrap(); fs::write(bare.join("node"), "").unwrap();
        assert_eq!(npm_cli(&bare.join("node")), None);
        assert_eq!(npm_cli(&root.join("does-not-exist")), None);
        // a directory named npm-cli.js is not a script
        let odd = root.join("odd"); fs::create_dir_all(odd.join("node_modules/npm/bin/npm-cli.js")).unwrap(); fs::write(odd.join("node"), "").unwrap();
        assert_eq!(npm_cli(&odd.join("node")), None);
    }

    #[test]
    fn the_verbatim_windows_prefix_is_dropped_only_for_drive_paths() {
        assert_eq!(plain_path(PathBuf::from(r"\\?\C:\node\npm-cli.js")), PathBuf::from(r"C:\node\npm-cli.js"));
        assert_eq!(plain_path(PathBuf::from(r"\\?\UNC\srv\share\x")), PathBuf::from(r"\\?\UNC\srv\share\x"));
        assert_eq!(plain_path(PathBuf::from("/usr/lib/npm-cli.js")), PathBuf::from("/usr/lib/npm-cli.js"));
    }

    #[test]
    fn the_environment_is_a_short_allowlist_with_the_node_directory_first() {
        let node = abs(&["opt", "node", "bin", "node"]);
        // PATH with one relative entry between two absolute ones, joined with THIS platform's separator
        let path = std::env::join_paths([abs(&["usr", "bin"]), PathBuf::from("relative").join("bin"), abs(&["opt", "x"])]).unwrap().to_string_lossy().into_owned();
        let mut vars: Vec<(String, String)> = [("HOME", "/home/a"), ("NODE_OPTIONS", "--require /evil.js"),
            ("npm_config_prefix", "/evil"), ("NPM_CONFIG_REGISTRY", "https://evil"), ("AWS_SECRET_ACCESS_KEY", "s"), ("HTTPS_PROXY", "http://proxy:8080"), ("LANG", "C")]
            .iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        vars.push(("PATH".to_string(), path));
        let out = env(&node, &vars);
        let get = |k: &str| out.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        assert_eq!(get("HOME"), Some("/home/a")); assert_eq!(get("HTTPS_PROXY"), Some("http://proxy:8080")); assert_eq!(get("LANG"), Some("C"));
        for gone in ["NODE_OPTIONS", "npm_config_prefix", "NPM_CONFIG_REGISTRY", "AWS_SECRET_ACCESS_KEY"] { assert_eq!(get(gone), None, "{gone}"); }
        // proxies in either case, the corporate CA bundle and the Windows lookup variables npm needs to work (verifier advisory)
        let more: Vec<(String, String)> = [("http_proxy", "http://p:1"), ("https_proxy", "http://p:1"), ("no_proxy", "x"), ("NODE_EXTRA_CA_CERTS", "/ca.pem"),
            ("SSL_CERT_FILE", "/ca.pem"), ("PATHEXT", ".EXE"), ("ComSpec", "C:\\Windows\\system32\\cmd.exe")].iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        let kept = env(&node, &more);
        for (k, _) in &more { assert!(kept.iter().any(|(n, _)| n == k), "{k} must reach npm"); }
        let path: Vec<PathBuf> = std::env::split_paths(get("PATH").unwrap()).collect();
        assert_eq!(path[0], abs(&["opt", "node", "bin"]), "the discovered Node comes first");
        assert!(path.iter().all(|p| p.is_absolute()), "a relative PATH entry would run code from the working directory");
        assert!(path.contains(&abs(&["usr", "bin"])) && path.contains(&abs(&["opt", "x"])));
        assert!(!path.iter().any(|p| p.ends_with("relative/bin") || p.ends_with("relative\\bin")), "the relative entry is dropped");
    }

    #[test]
    fn every_reason_has_a_fixed_code_and_a_fixed_sentence() {
        let all = [Reason::NodeMissing, Reason::NpmMissing, Reason::Timeout, Reason::InstallFailed, Reason::NotFoundAfter, Reason::Busy, Reason::HostFailed, Reason::NodeAppeared,
            Reason::DownloadFailed, Reason::ChecksumMismatch, Reason::UnsafeArchive, Reason::TarMissing, Reason::XzMissing, Reason::Unsupported];
        let codes: std::collections::BTreeSet<&str> = all.iter().map(|r| r.code()).collect();
        assert_eq!(codes.len(), all.len(), "codes are distinct");
        for r in all { assert!(r.code().bytes().all(|b| b.is_ascii_lowercase() || b == b'_'), "{r:?}"); assert!(!r.say().is_empty() && r.say().len() < 300, "{r:?}"); }
        assert!(Reason::NodeMissing.say().contains("nodejs.org"));
        assert!(Reason::NodeAppeared.say().contains("Instalar Pi"), "if Node showed up meanwhile the human is sent back to the normal button, nothing is installed");
        assert!(Reason::NotFoundAfter.say().contains("Reabrí"), "a custom prefix is not silently reported as installed");
    }

    /// A fake `npm-cli.js` run by the real Node: it records exactly what it was given, then exits as told. This is the whole
    /// pipeline except the network: spawn without a shell, the fixed argv, the minimal environment, the exit verdict.
    fn fake_npm(dir: &Path, body: &str) -> PathBuf {
        let path = dir.join("npm-cli.js");
        fs::write(&path, body).unwrap();
        path
    }
    #[test]
    fn a_fake_npm_that_succeeds_gets_exactly_the_fixed_arguments_and_environment() {
        let Some(node) = need_node() else { return };
        let dir = scratch("ok");
        let record = dir.join("seen.json");
        let cli = fake_npm(&dir, &format!("require('fs').writeFileSync({:?}, JSON.stringify({{argv: process.argv.slice(2), nodeOptions: process.env.NODE_OPTIONS || null, cfg: process.env.npm_config_prefix || null, home: process.env.HOME || null, cwd: process.cwd()}}));", record));
        let work_dir = scratch("cwd");
        let mut vars = vec![("HOME".to_string(), "/home/test".to_string()), ("NODE_OPTIONS".to_string(), "--max-old-space-size=1".to_string()), ("npm_config_prefix".to_string(), "/evil".to_string())];
        vars.extend(base_vars());
        assert_eq!(run(&node, &cli, &env(&node, &vars), Some(&work_dir), Duration::from_secs(20)), Ok(()));
        let seen: Value = serde_json::from_str(&fs::read_to_string(&record).unwrap()).unwrap();
        assert_eq!(seen["argv"], json!(["install", "-g", "@earendil-works/pi-coding-agent"]));
        assert_eq!(seen["nodeOptions"], Value::Null); assert_eq!(seen["cfg"], Value::Null); assert_eq!(seen["home"], "/home/test");
        assert_eq!(fs::canonicalize(seen["cwd"].as_str().unwrap()).unwrap(), fs::canonicalize(&work_dir).unwrap(), "npm runs in the directory it is given, not wherever the app was launched");
    }
    #[test]
    fn a_fake_npm_that_fails_reads_as_install_failed_and_one_that_hangs_as_timeout() {
        let Some(node) = need_node() else { return };
        let dir = scratch("fail");
        let vars = base_vars();
        let bad = fake_npm(&dir, "console.error('EACCES: permission denied'); process.exit(243);");
        assert_eq!(run(&node, &bad, &env(&node, &vars), None, Duration::from_secs(20)), Err(Reason::InstallFailed));
        let hang = fake_npm(&dir, "setTimeout(() => {}, 60000);");
        let at = Instant::now();
        assert_eq!(run(&node, &hang, &env(&node, &vars), None, Duration::from_millis(600)), Err(Reason::Timeout));
        assert!(at.elapsed() < Duration::from_secs(8), "the hung install is killed, not waited for");
        assert_eq!(run(Path::new("/definitely/not/node"), &bad, &[], None, Duration::from_secs(5)), Err(Reason::InstallFailed), "an unspawnable node is a failure, not a panic");
    }
}
