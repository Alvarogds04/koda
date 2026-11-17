//! K2-04 T6: where Koda 0.1 kept its data, for the two one-time cleanups that delete 0.1 files on upgrade.
//!
//! The bundle identifier is now `com.abitog.Koda`, so Tauri's `app_data_dir()` and `app_local_data_dir()` point at NEW
//! folders. The 0.1 data lives in the folder named after the OLD identifier, next to the new one (Tauri derives both as
//! `<system base>/<identifier>`). The human decided (13 Nov) that nothing from 0.1 is migrated and the old folder is
//! never copied or moved; the only thing done to it is what K2-03 (Recap) and K2-05 (conversations) already promised:
//! delete their own exact files. This constant is used by those two cleanups and by nothing else: it is not an alias
//! and never a fallback for Koda's own data.

use std::path::{Path, PathBuf};

/// The Koda 0.1 bundle identifier (`tauri.conf.json` before K2-04 T6). READ BY THE TWO 0.1 CLEANUPS ONLY.
pub const LEGACY_APP_IDENTIFIER: &str = "com.abitog.AbitoTauri";

/// The folder the 0.1 used for the same purpose as `current`: the sibling named after the old identifier.
/// `current` is a folder Tauri derived from the CURRENT identifier (its last component is that identifier); anything
/// else (no parent, an unexpected name) returns `None` and the cleanup simply does not run.
pub fn legacy_sibling(current: &Path, current_identifier: &str) -> Option<PathBuf> {
    if current.file_name()?.to_str()? != current_identifier {
        return None;
    }
    Some(current.parent()?.join(LEGACY_APP_IDENTIFIER))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::APP_IDENTIFIER;

    #[test]
    fn the_legacy_identifier_is_pinned_and_differs_from_the_current_one() {
        assert_eq!(LEGACY_APP_IDENTIFIER, "com.abitog.AbitoTauri");
        assert_ne!(LEGACY_APP_IDENTIFIER, APP_IDENTIFIER);
    }

    #[test]
    fn the_legacy_folder_is_the_sibling_of_the_current_one_on_every_os_shape() {
        for base in ["/home/u/.local/share", "/Users/u/Library/Application Support", r"C:\Users\u\AppData\Local"] {
            let current = Path::new(base).join(APP_IDENTIFIER);
            assert_eq!(legacy_sibling(&current, APP_IDENTIFIER), Some(Path::new(base).join("com.abitog.AbitoTauri")));
        }
    }

    #[test]
    fn nothing_is_derived_when_the_folder_is_not_the_one_tauri_derived_from_the_identifier() {
        assert_eq!(legacy_sibling(Path::new("/home/u/.local/share/other"), APP_IDENTIFIER), None);
        assert_eq!(legacy_sibling(Path::new("/"), APP_IDENTIFIER), None);
        assert_eq!(legacy_sibling(Path::new(""), APP_IDENTIFIER), None);
        // the legacy name itself is not "current": never derive a sibling of the old folder
        assert_eq!(legacy_sibling(Path::new("/x/com.abitog.AbitoTauri"), APP_IDENTIFIER), None);
    }

    #[test]
    fn the_legacy_folder_is_never_the_current_one() {
        let current = Path::new("/home/u/.local/share").join(APP_IDENTIFIER);
        assert_ne!(legacy_sibling(&current, APP_IDENTIFIER).unwrap(), current);
    }
}
