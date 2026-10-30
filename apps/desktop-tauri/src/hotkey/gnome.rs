//! The GNOME-on-Wayland route: GNOME *custom keybindings* (dconf
//! `org.gnome.settings-daemon.plugins.media-keys`). Unlike the XDG GlobalShortcuts portal they never
//! open a confirmation dialog: the human's own settings daemon owns the keys and runs a command when
//! one is pressed. That command is `<this exe> --action <target id>`, which the single-instance
//! plugin hands to the RUNNING island (an existing IPC entry, no new socket).
//!
//! RISK (writes the user's desktop config): Abito only ever touches entries under its own path prefix
//! (`…/custom-keybindings/abito-<id>/`). Every other custom keybinding is read (to detect clashes) and
//! written back byte-for-byte in the list; it is never modified or removed. A combo already used by
//! GNOME or another keybinding is REPORTED (`Status::Taken`), never stolen. The command path is the
//! running executable, validated against a closed character set; the action argument is a closed enum
//! ([`parse_action`]); nothing a page sends reaches either.
use super::{Combo, Key, Status, Target, ALT, CTRL, SHIFT, SUPER};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub const MEDIA_KEYS: &str = "org.gnome.settings-daemon.plugins.media-keys";
const LIST_KEY: &str = "custom-keybindings";
const ENTRY_SCHEMA: &str = "org.gnome.settings-daemon.plugins.media-keys.custom-keybinding";
const BASE: &str = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/";
const OWN_PREFIX: &str = "abito-";
/// Built-in keybinding schemas whose values a new combo must not shadow.
const SYSTEM_SCHEMAS: [&str; 4] = [MEDIA_KEYS, "org.gnome.desktop.wm.keybindings", "org.gnome.shell.keybindings", "org.gnome.mutter.keybindings"];

/// `XDG_CURRENT_DESKTOP` is a `:`-separated list (`ubuntu:GNOME`).
pub fn is_gnome_desktop(xdg_current_desktop: Option<&str>) -> bool {
    xdg_current_desktop.is_some_and(|d| d.split(':').any(|p| p.eq_ignore_ascii_case("gnome")))
}

/// The `--action` argv a keybinding launches: closed set = the catalog ids. Anything else is `None`.
pub fn parse_action(argv: &[String]) -> Option<Target> {
    match argv {
        [_, flag, id] if flag == "--action" => Target::ALL.into_iter().find(|t| t.id() == id),
        _ => None,
    }
}

/// GNOME's accelerator text: `<Primary><Alt><Shift><Super>key`.
pub fn gnome_binding(combo: &Combo) -> String {
    let mut out = String::new();
    for (bit, name) in [(CTRL, "<Primary>"), (ALT, "<Alt>"), (SHIFT, "<Shift>"), (SUPER, "<Super>")] {
        if combo.mods & bit != 0 {
            out.push_str(name);
        }
    }
    match combo.key {
        Key::Letter(c) => out.push(c.to_ascii_lowercase() as char),
        Key::Digit(c) => out.push(c as char),
        Key::F(n) => out.push_str(&format!("F{n}")),
        Key::Space => out.push_str("space"),
        Key::Left => out.push_str("Left"),
        Key::Right => out.push_str("Right"),
    }
    out
}

/// `/abs/path/exe --action toggleIsland`, or `None` when the path could be read as anything but one
/// plain word (relative, spaces, quotes, `$`, control bytes…). Such an exe simply cannot use this route.
pub fn command_for(exe: &Path, target: Target) -> Option<String> {
    let text = exe.to_str()?;
    let safe = text.starts_with('/') && text.len() > 1 && text.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'.' | b'_' | b'-' | b'+'));
    safe.then(|| format!("{text} --action {}", target.id()))
}

pub fn entry_path(target: Target) -> String {
    format!("{BASE}{OWN_PREFIX}{}/", target.id())
}

fn is_own(path: &str) -> bool {
    path.strip_prefix(BASE).is_some_and(|rest| rest.starts_with(OWN_PREFIX))
}

/// GVariant text of a string array, as `gsettings` prints/accepts it.
pub fn format_list(paths: &[String]) -> String {
    if paths.is_empty() {
        return "[]".into();
    }
    format!("[{}]", paths.iter().map(|p| format!("'{p}'")).collect::<Vec<_>>().join(", "))
}

/// Every single-quoted string inside gsettings output (`@as []` → none).
pub fn quoted_strings(text: &str) -> Vec<String> {
    let (mut out, mut cur, mut inside, mut escaped) = (Vec::new(), String::new(), false, false);
    for ch in text.chars() {
        match (inside, escaped, ch) {
            (true, true, c) => { cur.push(c); escaped = false; }
            (true, false, '\\') => escaped = true,
            (true, false, '\'') => { out.push(std::mem::take(&mut cur)); inside = false; }
            (true, false, c) => cur.push(c),
            (false, _, '\'') => inside = true,
            _ => {}
        }
    }
    out
}

/// The `gsettings` binary (injectable: tests pass a fake, never the real dconf).
#[derive(Debug, Clone)]
pub struct Gsettings {
    bin: PathBuf,
}

impl Gsettings {
    pub fn system() -> Gsettings { Gsettings { bin: PathBuf::from("gsettings") } }
    pub fn with_binary(bin: impl Into<PathBuf>) -> Gsettings { Gsettings { bin: bin.into() } }

    fn run(&self, args: &[&str]) -> Option<String> {
        let out = Command::new(&self.bin).args(args).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
    }

    /// Can we read the custom keybindings list at all (GNOME's schema is installed and dconf answers)?
    pub fn usable(&self) -> bool {
        self.run(&["get", MEDIA_KEYS, LIST_KEY]).is_some()
    }

    fn list(&self) -> Option<Vec<String>> {
        self.run(&["get", MEDIA_KEYS, LIST_KEY]).map(|t| quoted_strings(&t))
    }

    fn entry(path: &str) -> String { format!("{ENTRY_SCHEMA}:{path}") }

    fn binding_of(&self, path: &str) -> Option<String> {
        self.run(&["get", &Self::entry(path), "binding"]).and_then(|t| quoted_strings(&t).into_iter().next())
    }

    /// Accelerators bound by GNOME itself (built-in schemas).
    fn system_bindings(&self) -> HashSet<String> {
        SYSTEM_SCHEMAS.iter().filter_map(|s| self.run(&["list-recursively", s])).flat_map(|t| t.lines().flat_map(quoted_strings).collect::<Vec<_>>()).collect()
    }
}

/// What the human wants installed: the enabled, bound targets and their combos.
pub type Wanted = Vec<(Target, Combo)>;

/// Make Abito's own keybinding entries equal `wanted`. Returns the status of every target of the catalog:
/// `Active` (written), `Taken` (the combo belongs to GNOME or another keybinding: nothing written for it),
/// `Disabled` (not wanted: its own entry, if any, was removed), `Unsupported` (GNOME refused / exe unusable).
pub fn sync(gs: &Gsettings, exe: &Path, wanted: &Wanted) -> Vec<(Target, Status)> {
    let Some(current) = gs.list() else { return Target::ALL.into_iter().map(|t| (t, Status::Unsupported)).collect() };
    let foreign: Vec<String> = current.iter().filter(|p| !is_own(p)).cloned().collect();
    let mut taken: HashSet<String> = gs.system_bindings();
    taken.extend(foreign.iter().filter_map(|p| gs.binding_of(p)));
    let mut results = Vec::new();
    let mut keep = Vec::new();
    for target in Target::ALL {
        let path = entry_path(target);
        let Some((_, combo)) = wanted.iter().find(|(t, _)| *t == target) else {
            gs_remove_entry(gs, &path, current.contains(&path));
            results.push((target, Status::Disabled));
            continue;
        };
        let binding = gnome_binding(combo);
        if taken.contains(&binding) {
            gs_remove_entry(gs, &path, current.contains(&path));
            results.push((target, Status::Taken));
            continue;
        }
        let Some(command) = command_for(exe, target) else {
            gs_remove_entry(gs, &path, current.contains(&path));
            results.push((target, Status::Unsupported));
            continue;
        };
        let entry = Gsettings::entry(&path);
        let ok = [("name", format!("'{}'", target.description().replace('\'', ""))), ("command", format!("'{command}'")), ("binding", format!("'{binding}'"))]
            .iter()
            .all(|(key, value)| gs.run(&["set", &entry, key, value]).is_some());
        if ok { keep.push(path); }
        results.push((target, if ok { Status::Active } else { Status::Unsupported }));
    }
    // the list = every foreign entry untouched, in its order, then ours
    let mut next = foreign;
    next.extend(keep);
    if next != current {
        let _ = gs.run(&["set", MEDIA_KEYS, LIST_KEY, &format_list(&next)]);
    }
    results
}

fn gs_remove_entry(gs: &Gsettings, path: &str, present: bool) {
    if present {
        let entry = Gsettings::entry(path);
        for key in ["name", "command", "binding"] {
            let _ = gs.run(&["reset", &entry, key]);
        }
    }
}

/// Take every Abito entry away (uninstall / the human turned the route off). Foreign entries stay.
pub fn remove_all(gs: &Gsettings) {
    let _ = sync(gs, Path::new("/"), &Vec::new());
}
