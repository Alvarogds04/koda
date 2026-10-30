//! The GNOME custom-keybindings route against a FAKE `gsettings` (a shell script over a temp dir).
//! The real dconf of the session is never read or written.
#![cfg(unix)]
use abito_island::hotkey::gnome::{self, Gsettings};
use abito_island::hotkey::{Combo, HotkeyConfig, Status, Target};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

const FAKE: &str = r#"#!/bin/sh
# state: $FAKE_GS/<schema-with-path>/<key>; system accelerators: $FAKE_GS/_sys/<schema>
d="$(dirname "$0")"; echo "$*" >> "$d/calls.log"
safe() { printf '%s' "$1" | tr '/:' '__'; }
case "$1" in
  get) f="$d/$(safe "$2")/$3"; if [ -f "$f" ]; then cat "$f"; elif [ "$3" = custom-keybindings ]; then echo "@as []"; else echo "''"; fi ;;
  set) mkdir -p "$d/$(safe "$2")"; printf '%s' "$4" > "$d/$(safe "$2")/$3" ;;
  reset) rm -f "$d/$(safe "$2")/$3" ;;
  list-recursively) f="$d/_sys/$2"; [ -f "$f" ] && cat "$f"; exit 0 ;;
  *) exit 2 ;;
esac
"#;

struct Fake { dir: PathBuf, gs: Gsettings }
impl Fake {
    fn new() -> Fake {
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!("abito-fakegs-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        std::fs::create_dir_all(dir.join("_sys")).unwrap();
        // ONE script written once per process (a script rewritten while another test forks hits ETXTBSY);
        // each test gets a symlink to it and the script keeps its state next to the symlink.
        static SCRIPT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
        let script = SCRIPT.get_or_init(|| {
            let p = std::env::temp_dir().join(format!("abito-fakegs-script-{}", std::process::id()));
            std::fs::write(&p, FAKE).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
            p
        });
        let bin = dir.join("gsettings");
        std::os::unix::fs::symlink(script, &bin).unwrap();
        Fake { gs: Gsettings::with_binary(&bin), dir }
    }
    fn key(&self, schema_path: &str, key: &str) -> Option<String> {
        std::fs::read_to_string(self.dir.join(schema_path.replace(['/', ':'], "_")).join(key)).ok()
    }
    fn list(&self) -> String { self.key(gnome::MEDIA_KEYS, "custom-keybindings").unwrap_or_default() }
    fn seed_list(&self, list: &str) {
        let d = self.dir.join(gnome::MEDIA_KEYS.replace(['/', ':'], "_")); std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("custom-keybindings"), list).unwrap();
    }
    fn seed_foreign(&self, path: &str, binding: &str) {
        let d = self.dir.join(format!("{}:{}", "org.gnome.settings-daemon.plugins.media-keys.custom-keybinding", path).replace(['/', ':'], "_"));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("binding"), format!("'{binding}'")).unwrap();
        std::fs::write(d.join("command"), "'foreign-cmd'").unwrap();
    }
    fn seed_system(&self, schema: &str, accel: &str) {
        std::fs::write(self.dir.join("_sys").join(schema), format!("{schema} switch-windows ['{accel}']\n")).unwrap();
    }
    fn calls(&self) -> String { std::fs::read_to_string(self.dir.join("calls.log")).unwrap_or_default() }
}
impl Drop for Fake { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.dir); } }

const EXE: &str = "/home/u/.local/bin/abito-island";
fn all() -> gnome::Wanted { Target::ALL.into_iter().map(|t| (t, HotkeyConfig::default_for(t).combo)).collect() }
fn entry(t: Target, key: &str, f: &Fake) -> Option<String> {
    f.key(&format!("org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:{}", gnome::entry_path(t)), key)
}
fn status(r: &[(Target, Status)], t: Target) -> Status { r.iter().find(|(x, _)| *x == t).unwrap().1 }

#[test]
fn first_run_writes_one_entry_per_target_with_name_command_and_binding() {
    let f = Fake::new();
    let r = gnome::sync(&f.gs, Path::new(EXE), &all());
    assert!(r.iter().all(|(_, s)| *s == Status::Active), "{r:?}");
    for t in Target::ALL {
        assert_eq!(entry(t, "command", &f).as_deref(), Some(format!("'{EXE} --action {}'", t.id()).as_str()));
        assert_eq!(entry(t, "binding", &f).as_deref(), Some(format!("'{}'", gnome::gnome_binding(&HotkeyConfig::default_for(t).combo)).as_str()));
        assert_eq!(entry(t, "name", &f).as_deref(), Some(format!("'{}'", t.description()).as_str()));
    }
    assert_eq!(entry(Target::ToggleIsland, "binding", &f).as_deref(), Some("'<Primary><Alt>a'"));
    assert_eq!(quoted(&f.list()).len(), 9);
}
fn quoted(s: &str) -> Vec<String> { gnome::quoted_strings(s) }

#[test]
fn other_custom_keybindings_survive_untouched_and_keep_their_place() {
    let f = Fake::new();
    let foreign = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom0/";
    f.seed_list(&format!("['{foreign}']"));
    f.seed_foreign(foreign, "<Super>e");
    gnome::sync(&f.gs, Path::new(EXE), &all());
    let list = quoted(&f.list());
    assert_eq!(list[0], foreign, "the human's entry stays first");
    assert_eq!(list.len(), 10);
    assert_eq!(f.key(&format!("org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:{foreign}"), "command").as_deref(), Some("'foreign-cmd'"));
    assert!(!f.calls().lines().any(|l| (l.starts_with("set ") || l.starts_with("reset ")) && l.contains("custom-keybinding:") && l.contains("custom0")), "never writes a foreign entry:\n{}", f.calls());
}

#[test]
fn a_combo_used_by_another_keybinding_or_by_gnome_is_taken_not_stolen() {
    let f = Fake::new();
    let foreign = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom0/";
    f.seed_list(&format!("['{foreign}']"));
    f.seed_foreign(foreign, "<Primary><Alt>a");              // clashes with toggleIsland
    f.seed_system("org.gnome.desktop.wm.keybindings", "<Primary><Alt>d"); // clashes with desktopToggle
    let r = gnome::sync(&f.gs, Path::new(EXE), &all());
    assert_eq!(status(&r, Target::ToggleIsland), Status::Taken);
    assert_eq!(status(&r, Target::DesktopToggle), Status::Taken);
    assert_eq!(status(&r, Target::OpenChat), Status::Active);
    assert_eq!(entry(Target::ToggleIsland, "binding", &f), None);
    assert_eq!(entry(Target::DesktopToggle, "command", &f), None);
    assert_eq!(quoted(&f.list()).len(), 1 + 7);
}

#[test]
fn a_disabled_target_loses_only_its_own_entry_and_syncing_twice_is_stable() {
    let f = Fake::new();
    gnome::sync(&f.gs, Path::new(EXE), &all());
    let mut fewer = all();
    fewer.retain(|(t, _)| *t != Target::MuteToggle);
    let r = gnome::sync(&f.gs, Path::new(EXE), &fewer);
    assert_eq!(status(&r, Target::MuteToggle), Status::Disabled);
    assert_eq!(entry(Target::MuteToggle, "binding", &f), None);
    assert_eq!(quoted(&f.list()).len(), 8);
    let before = f.list();
    gnome::sync(&f.gs, Path::new(EXE), &fewer);
    assert_eq!(f.list(), before);
}

#[test]
fn changing_a_combo_rewrites_that_entry() {
    let f = Fake::new();
    gnome::sync(&f.gs, Path::new(EXE), &all());
    let mut w = all();
    w[0].1 = Combo::parse("Ctrl+Shift+N").unwrap();
    let r = gnome::sync(&f.gs, Path::new(EXE), &w);
    assert_eq!(status(&r, Target::ToggleIsland), Status::Active, "{r:?}\n{}", f.calls());
    assert_eq!(entry(Target::ToggleIsland, "binding", &f).as_deref(), Some("'<Primary><Shift>n'"));
}

#[test]
fn remove_all_takes_only_abito_entries_away() {
    let f = Fake::new();
    let foreign = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom0/";
    f.seed_list(&format!("['{foreign}']"));
    f.seed_foreign(foreign, "<Super>e");
    gnome::sync(&f.gs, Path::new(EXE), &all());
    gnome::remove_all(&f.gs);
    assert_eq!(quoted(&f.list()), vec![foreign.to_string()]);
    assert_eq!(entry(Target::ToggleIsland, "command", &f), None);
}

#[test]
fn a_gsettings_that_fails_means_unsupported_and_writes_nothing() {
    let gs = Gsettings::with_binary("/nonexistent/gsettings");
    assert!(!gs.usable());
    let r = gnome::sync(&gs, Path::new(EXE), &all());
    assert!(r.iter().all(|(_, s)| *s == Status::Unsupported));
}

#[test]
fn an_exe_path_that_is_not_one_plain_word_cannot_become_a_command() {
    let f = Fake::new();
    for bad in ["relative/abito", "/opt/my app/abito", "/opt/a'b/abito", "/opt/$HOME/abito", "/opt/a;rm/abito", "/opt/a\nb", ""] {
        assert_eq!(gnome::command_for(Path::new(bad), Target::ToggleIsland), None, "{bad:?}");
    }
    let r = gnome::sync(&f.gs, Path::new("/opt/my app/abito"), &all());
    assert!(r.iter().all(|(_, s)| *s == Status::Unsupported));
    assert_eq!(entry(Target::ToggleIsland, "command", &f), None);
}

#[test]
fn the_ipc_action_accepts_only_the_closed_set_of_catalog_ids() {
    let argv = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    for t in Target::ALL {
        assert_eq!(gnome::parse_action(&argv(&["abito", "--action", t.id()])), Some(t));
    }
    for bad in [&["abito", "--action", "rm -rf"][..], &["abito", "--action", ""], &["abito", "--action", "toggle-island"], &["abito", "--action", "ToggleIsland"],
        &["abito", "--action"], &["abito", "--chat"], &["abito"], &["abito", "--action", "toggleIsland", "extra"], &["abito", "-action", "toggleIsland"]] {
        assert_eq!(gnome::parse_action(&argv(bad)), None, "{bad:?}");
    }
}

#[test]
fn bindings_use_gnome_accelerator_syntax() {
    let b = |s: &str| gnome::gnome_binding(&Combo::parse(s).unwrap());
    assert_eq!(b("Ctrl+Alt+Shift+A"), "<Primary><Alt><Shift>a");
    assert_eq!(b("Super+F8"), "<Super>F8");
    assert_eq!(b("Ctrl+Alt+Space"), "<Primary><Alt>space");
    assert_eq!(b("Ctrl+Alt+Left"), "<Primary><Alt>Left");
    assert_eq!(b("Ctrl+7"), "<Primary>7");
}

#[test]
fn only_a_gnome_desktop_is_detected() {
    assert!(gnome::is_gnome_desktop(Some("ubuntu:GNOME")));
    assert!(gnome::is_gnome_desktop(Some("GNOME")));
    assert!(!gnome::is_gnome_desktop(Some("KDE")));
    assert!(!gnome::is_gnome_desktop(Some("X-Cinnamon")));
    assert!(!gnome::is_gnome_desktop(None));
}
