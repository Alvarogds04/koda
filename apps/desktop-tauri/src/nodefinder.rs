//! HU-069 (human rule 12, verbatim in AGENTS.md): Abito finds Node.js, and anything installed next to it, where a user's machine keeps
//! it WITHOUT relying on the GUI PATH (Finder/Explorer/desktop launchers do not load `.zshrc`, `nvm`, `fnm`...). One bounded, shell-free
//! lookup, the same on Linux, macOS and Windows: only the directory LAYOUTS differ. A version manager's install must satisfy
//! [`MIN_NODE`] (what Pi itself requires), otherwise the next candidate wins. Nothing here runs a program or reads outside the
//! well-known directories; the caller still checks that the final file is executable.
use std::{fs, io::Read, path::{Path, PathBuf}};

const MAX_VERSIONS: usize = 128;
/// Pi (`@earendil-works/pi-coding-agent`) declares `engines.node >=22.19.0`.
pub const MIN_NODE: (u32, u32, u32) = (22, 19, 0);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Os { Linux, Mac, Windows }
impl Os {
    pub fn current() -> Os { if cfg!(windows) { Os::Windows } else if cfg!(target_os = "macos") { Os::Mac } else { Os::Linux } }
}

/// The environment the lookup may read; every field is an explicit input so any OS layout is testable anywhere.
#[derive(Clone, Debug, Default)]
pub struct Env {
    pub home: Option<PathBuf>,
    pub nvm_dir: Option<PathBuf>, pub volta_home: Option<PathBuf>, pub fnm_dir: Option<PathBuf>,
    pub app_data: Option<PathBuf>, pub local_app_data: Option<PathBuf>, pub program_files: Option<PathBuf>,
    pub nvm_home: Option<PathBuf>, pub nvm_symlink: Option<PathBuf>,
}
impl Env {
    pub fn from_process() -> Env {
        let var = |k: &str| std::env::var_os(k).map(PathBuf::from).filter(|p| p.is_absolute());
        let home = var("HOME").or_else(|| if cfg!(windows) { var("USERPROFILE") } else { None });
        Env { home, nvm_dir: var("NVM_DIR"), volta_home: var("VOLTA_HOME"), fnm_dir: var("FNM_DIR"), app_data: var("APPDATA"),
            local_app_data: var("LOCALAPPDATA"), program_files: var("ProgramFiles"), nvm_home: var("NVM_HOME"), nvm_symlink: var("NVM_SYMLINK") }
    }
}

/// Directories that may hold `node` (and the global npm bins such as `pi`), best first. Existence is checked; executability is not.
/// Homebrew and `/usr/*` locations are NOT here: the caller owns those (they are plain absolute paths, no manager involved).
pub fn candidate_dirs(os: Os, env: &Env) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut push = |d: Option<PathBuf>| if let Some(d) = d { if d.is_absolute() && !dirs.contains(&d) { dirs.push(d) } };
    let home = env.home.clone().filter(|h| h.is_absolute());
    let unix = os != Os::Windows;
    if unix {
        // HU-069 T2 (Linux): the official build Abito unpacked for the user (see `nodeinstall`).
        if let Some(h) = &home { push(Some(h.join(".local/bin"))); push(Some(h.join(".npm-global/bin"))); }
    }
    // Volta: shims live in <VOLTA_HOME>/bin.
    push(env.volta_home.clone().or_else(|| match os {
        Os::Windows => env.local_app_data.as_ref().map(|d| d.join("Volta")),
        _ => home.as_ref().map(|h| h.join(".volta")),
    }).map(|v| v.join("bin")));
    // Windows Volta installs also drop shims under %LOCALAPPDATA%\Volta\bin; the `.volta` home form is checked as well.
    if os == Os::Windows { push(home.as_ref().map(|h| h.join(".volta").join("bin"))); }
    // Last among the managers on purpose: a Node the user installs later (nvm, Volta, fnm) must win over this one, which Abito never updates.
    // nvm (unix): $NVM_DIR or ~/.nvm.
    if unix {
        let root = env.nvm_dir.clone().or_else(|| home.as_ref().map(|h| h.join(".nvm")));
        push(root.and_then(|r| nvm_bin(&r)));
    }
    // fnm: $FNM_DIR, ~/.local/share/fnm, ~/Library/Application Support/fnm (mac), %APPDATA%\fnm (Windows).
    let mut fnm_roots: Vec<PathBuf> = env.fnm_dir.iter().cloned().collect();
    match os {
        Os::Windows => fnm_roots.extend(env.app_data.iter().map(|d| d.join("fnm"))),
        Os::Mac => { if let Some(h) = &home { fnm_roots.push(h.join("Library/Application Support/fnm")); fnm_roots.push(h.join(".local/share/fnm")); } }
        Os::Linux => { if let Some(h) = &home { fnm_roots.push(h.join(".local/share/fnm")); } }
    }
    for root in fnm_roots {
        let versions = root.join("node-versions");
        push(newest_dir(&versions, |inst| if unix { inst.join("installation/bin") } else { inst.join("installation") }));
    }
    if os == Os::Linux { if let Some(h) = &home { push(Some(h.join(".local/share/abito/node/bin"))); } }
    if os == Os::Windows {
        // nvm-windows: %NVM_SYMLINK% is the ACTIVE version; %NVM_HOME% (default %APPDATA%\nvm) holds every installed one.
        push(env.nvm_symlink.clone());
        push(env.nvm_home.clone().or_else(|| env.app_data.as_ref().map(|d| d.join("nvm"))).and_then(|r| newest_dir(&r, |v| v.to_path_buf())));
        push(env.program_files.as_ref().map(|d| d.join("nodejs")));
    }
    dirs
}

/// The highest `vX.Y.Z` directory under `root` that satisfies [`MIN_NODE`], mapped through `bin`; `None` when the folder is missing,
/// has more than [`MAX_VERSIONS`] entries (fails closed instead of scanning unbounded) or nothing qualifies.
fn newest_dir(root: &Path, bin: impl Fn(&Path) -> PathBuf) -> Option<PathBuf> {
    let entries: Vec<_> = fs::read_dir(root).ok()?.take(MAX_VERSIONS + 1).collect();
    if entries.len() > MAX_VERSIONS { return None }
    entries.into_iter().filter_map(|entry| {
        let entry = entry.ok()?;
        let name = entry.file_name();
        let v = version(name.to_str()?)?;
        if v < MIN_NODE { return None }
        let dir = bin(&entry.path());
        dir.is_dir().then_some((v, dir))
    }).max_by_key(|(v, _)| *v).map(|(_, dir)| dir)
}

/// Back-compat shape used by the unix lookup: `candidates("node"|"pi", home)` = the manager directories joined with the name.
pub fn candidates(name: &str, os: Os, env: &Env) -> Vec<PathBuf> {
    if !matches!(name, "node" | "pi") { return Vec::new() }
    let file = if os == Os::Windows && name == "node" { "node.exe" } else { name };
    candidate_dirs(os, env).into_iter().map(|d| d.join(file)).collect()
}

fn version(text: &str) -> Option<(u32, u32, u32)> {
    let mut parts = text.strip_prefix('v').unwrap_or(text).split('.');
    let mut number = || {
        let part = parts.next()?;
        if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) { return None }
        part.parse::<u32>().ok()
    };
    let tuple = (number()?, number()?, number()?);
    if parts.next().is_some() { return None }
    Some(tuple)
}

fn alias(path: &Path) -> Option<String> {
    if !fs::symlink_metadata(path).ok()?.is_file() { return None }
    let mut bytes = Vec::new();
    fs::File::open(path).ok()?.take(257).read_to_end(&mut bytes).ok()?;
    if bytes.len() > 256 { return None }
    Some(String::from_utf8(bytes).ok()?.trim().to_owned())
}

fn nvm_bin(nvm: &Path) -> Option<PathBuf> {
    let versions = nvm.join("versions/node");
    if let Some(mut value) = alias(&nvm.join("alias/default")) {
        // One additional alias file only; reject absolute paths, traversal and
        // shell syntax. NVM's common lts/<name> aliases are ordinary files.
        if version(&value).is_none() && value.split('/').count() <= 2
            && value.split('/').all(|p| !p.is_empty() && p != "." && p != ".."
                && p.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'*'))) {
            value = alias(&nvm.join("alias").join(&value)).unwrap_or_default();
        }
        if version(&value).is_some_and(|v| v >= MIN_NODE) {
            let name = if value.starts_with('v') { value } else { format!("v{value}") };
            let bin = versions.join(name).join("bin");
            if bin.is_dir() { return Some(bin) }
        }
    }
    newest_dir(&versions, |v| v.join("bin"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf};

    struct Home(PathBuf);
    impl Home {
        fn new() -> Self {
            static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            let path = std::env::temp_dir().join(format!("abito-nodefinder-{}-{}", std::process::id(), N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn dir(&self, rel: &str) -> PathBuf { let d = self.0.join(rel); fs::create_dir_all(&d).unwrap(); d }
        fn env(&self) -> Env { Env { home: Some(self.0.clone()), ..Env::default() } }
        fn nvm(&self, version: &str) -> PathBuf { self.dir(&format!(".nvm/versions/node/{version}/bin")) }
        fn alias(&self, name: &str, value: &str) {
            let path = self.0.join(".nvm/alias").join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, value).unwrap();
        }
    }
    impl Drop for Home { fn drop(&mut self) { fs::remove_dir_all(&self.0).unwrap(); } }
    fn has(list: &[PathBuf], p: &Path) -> bool { list.iter().any(|c| c == p) }

    #[test]
    fn the_friends_mac_nvm_only_node_is_found_without_any_shell_setup() {
        // HU-069: Node 26 exists only under ~/.nvm, no alias, nothing on PATH.
        let home = Home::new();
        let bin = home.nvm("v26.13.0");
        for os in [Os::Mac, Os::Linux] {
            assert!(has(&candidates("node", os, &home.env()), &bin.join("node")), "{os:?}");
            assert!(has(&candidates("pi", os, &home.env()), &bin.join("pi")), "{os:?}: Pi installed by npm sits next to that Node");
        }
    }

    #[test]
    fn linux_finds_the_node_abito_unpacked_in_the_user_folder() {
        let home = Home::new();
        let bin = home.dir(".local/share/abito/node/bin");
        assert!(has(&candidates("node", Os::Linux, &home.env()), &bin.join("node")));
        assert!(has(&candidates("pi", Os::Linux, &home.env()), &bin.join("pi")), "npm -g installs Pi next to it");
    }

    #[test]
    fn nvm_dir_overrides_the_default_location_and_the_alias_must_satisfy_the_minimum() {
        let home = Home::new();
        let custom = home.dir("elsewhere/versions/node/v24.1.0/bin");
        let mut env = home.env();
        env.nvm_dir = Some(home.0.join("elsewhere"));
        assert!(has(&candidates("node", Os::Linux, &env), &custom.join("node")));
        // default alias points at a Node that is too old for Pi: the newest satisfying one wins instead
        let old = home.nvm("v18.20.0");
        let good = home.nvm("v22.19.0");
        home.alias("default", "v18.20.0\n");
        let nvm_only = |list: Vec<PathBuf>| list.into_iter().filter(|p| p.starts_with(home.0.join(".nvm"))).collect::<Vec<_>>();
        assert_eq!(nvm_only(candidates("node", Os::Linux, &home.env())), vec![good.join("node")]);
        assert!(!has(&candidates("node", Os::Linux, &home.env()), &old.join("node")));
        // exactly the minimum qualifies; one patch below does not
        let below = Home::new(); below.nvm("v22.18.9");
        assert!(nvm_only_of(&below).is_empty());
    }
    fn nvm_only_of(home: &Home) -> Vec<PathBuf> { candidates("node", Os::Linux, &home.env()).into_iter().filter(|p| p.starts_with(home.0.join(".nvm"))).collect() }

    #[test]
    fn volta_and_fnm_are_found_on_every_os_with_their_own_layouts() {
        let home = Home::new();
        let volta = home.dir(".volta/bin");
        let fnm_linux = home.dir(".local/share/fnm/node-versions/v22.20.0/installation/bin");
        home.dir(".local/share/fnm/node-versions/v20.0.0/installation/bin");
        let fnm_mac = home.dir("Library/Application Support/fnm/node-versions/v24.2.0/installation/bin");
        assert!(has(&candidates("node", Os::Linux, &home.env()), &volta.join("node")));
        assert!(has(&candidates("node", Os::Linux, &home.env()), &fnm_linux.join("node")));
        assert!(has(&candidates("node", Os::Mac, &home.env()), &fnm_mac.join("node")));
        assert!(!has(&candidates("node", Os::Linux, &home.env()), &fnm_mac.join("node")), "the Application Support root is a mac location");
        assert!(!candidates("node", Os::Mac, &home.env()).iter().any(|p| p.to_string_lossy().contains("v20.0.0")), "too old");
        // explicit VOLTA_HOME / FNM_DIR win over the defaults
        let mut env = home.env();
        env.volta_home = Some(home.0.join("vh")); env.fnm_dir = Some(home.0.join("fd"));
        let fd = home.dir("fd/node-versions/v23.0.0/installation/bin");
        let list = candidates("node", Os::Linux, &env);
        assert!(has(&list, &home.0.join("vh/bin/node")) && has(&list, &fd.join("node")));
    }

    #[test]
    fn windows_layouts_fnm_nvm_windows_volta_and_program_files() {
        let home = Home::new();
        let fnm = home.dir("AppData/Roaming/fnm/node-versions/v22.21.0/installation");
        let nvm_new = home.dir("AppData/Roaming/nvm/v24.0.0");
        home.dir("AppData/Roaming/nvm/v16.0.0");
        let symlink = home.dir("nodejs-link");
        let pf = home.dir("Program Files/nodejs");
        let env = Env { home: Some(home.0.clone()), app_data: Some(home.0.join("AppData/Roaming")), local_app_data: Some(home.0.join("AppData/Local")),
            program_files: Some(home.0.join("Program Files")), nvm_symlink: Some(symlink.clone()), ..Env::default() };
        let list = candidates("node", Os::Windows, &env);
        for want in [fnm.join("node.exe"), nvm_new.join("node.exe"), symlink.join("node.exe"), pf.join("node.exe"), home.0.join("AppData/Local/Volta/bin/node.exe")] {
            assert!(has(&list, &want), "{want:?} in {list:?}");
        }
        assert!(!list.iter().any(|p| p.to_string_lossy().contains("v16.0.0")));
        assert!(!list.iter().any(|p| p.ends_with(".local/bin/node")), "unix-only user bin directories are not Windows locations");
        // the active nvm-windows version (%NVM_SYMLINK%) is tried before the installed-versions folder
        let at = |p: &PathBuf| list.iter().position(|c| c == p).unwrap();
        assert!(at(&symlink.join("node.exe")) < at(&nvm_new.join("node.exe")));
    }

    #[test]
    fn finder_resolves_one_alias_level_then_uses_highest_numeric_version() {
        let home = Home::new();
        let selected = home.nvm("v22.19.1");
        let highest = home.nvm("v22.100.0");
        home.nvm("v9.99.0");
        home.nvm("v999.bad.0");
        home.alias("default", "lts/jod\n");
        home.alias("lts/jod", "22.19.1\n");
        assert_eq!(nvm_bin(&home.0.join(".nvm")), Some(selected));
        // No recursive aliases or shell expressions, even if a matching path exists.
        for value in ["stable", "../../outside", "$(echo v999.0.0)", "v404.0.0"] {
            home.alias("lts/jod", value);
            assert_eq!(nvm_bin(&home.0.join(".nvm")), Some(highest.clone()));
        }
        fs::remove_file(home.0.join(".nvm/alias/default")).unwrap();
        assert_eq!(nvm_bin(&home.0.join(".nvm")), Some(highest));
    }

    #[test]
    fn empty_home_is_bounded_and_never_uses_a_relative_path() {
        let home = Home::new();
        assert_eq!(nvm_bin(&home.0.join(".nvm")), None);
        assert!(candidates("other", Os::Linux, &home.env()).iter().all(|_| false), "only node and pi are looked up");
        let relative = Env { home: Some(PathBuf::from("relative")), nvm_dir: Some(PathBuf::from("rel/nvm")), ..Env::default() };
        assert!(candidates("node", Os::Linux, &relative).is_empty());
        for n in 0..129 { home.nvm(&format!("v30.0.{n}")); }
        assert_eq!(nvm_bin(&home.0.join(".nvm")), None, "overflow fails closed instead of scanning unbounded versions");
    }
}
