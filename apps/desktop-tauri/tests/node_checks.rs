//! K3-05 T5 (odd/tasks/k3-05-test-cleanup.md S5): the node-script integration checks.
//!
//! Fourteen one-test binaries used to hold these: each one spawned `node` on a `.cjs` harness, asserted exit 0 and
//! looked for a marker in its stdout. Cargo links one test crate per `tests/*.rs`, so fourteen files meant fourteen
//! links for the same four lines of Rust. They now live here, one module per original file, and only the duplicated
//! runner is shared.
//!
//! Nothing about the checks changed: every test keeps its name, its script path, its marker and its node-absent
//! policy — the ones that fail loudly when `node` is missing still fail, and the two that skip loudly still skip
//! (`check` versus `check_skippable`). Module names say which file a test came from.

use std::path::Path;
use std::process::Command;

/// Runs `<manifest>/<script>` under plain `node` and asserts exit 0 plus `marker` in stdout.
fn check_script(script: &str, marker: &str) {
    let harness = Path::new(env!("CARGO_MANIFEST_DIR")).join(script);
    let out = Command::new("node").arg(&harness).output().expect("spawn node");
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(out.status.success(), "{script} failed:\n{stdout}\n{stderr}");
    assert!(stdout.contains(marker), "{stdout}");
}

/// Fails when node is absent: a missing runner must never read as green.
fn check(script: &str, marker: &str) {
    let node = Command::new("node").arg("--version").output();
    assert!(
        node.as_ref().is_ok_and(|out| out.status.success()),
        "node is required to run {script} and was not found on PATH: {node:?}"
    );
    check_script(script, marker);
}

/// Skips loudly when node is absent.
fn check_skippable(script: &str, marker: &str) {
    if Command::new("node").arg("--version").output().is_err() {
        eprintln!("SKIPPED: node unavailable — {script} not run");
        return;
    }
    check_script(script, marker);
}

/// #384: the pure avatar-colour contract checks (`test-node/avatar-colors-check.cjs`) under plain `node` (no npm, no
/// network). Fails when node is absent.
mod frontend_avatar_colors {
    use super::check;

    #[test]
    fn frontend_avatar_colors_checks_pass() {
        check("test-node/avatar-colors-check.cjs", "passed");
    }
}

/// #372: the composer keyboard checks (`tests/composer-ime-check.cjs`), which drive the REAL `frontend/chat.js` over a
/// fake DOM, under plain `node` (no npm, no network). Skips loudly when node is absent.
mod frontend_chat_composer {
    use super::check_skippable;

    #[test]
    fn frontend_chat_composer_ime_checks_pass() {
        check_skippable("tests/composer-ime-check.cjs", "passed");
    }
}

/// U1: the pure frontend chat-view checks (`test-node/chat-view-check.cjs`) under plain `node` (no npm, no network).
/// Skips loudly when node is absent. (K2-05 U5c: the model picker and its wiring check are gone; the read-only model
/// line is covered by chat-view-check.)
mod frontend_chat_view {
    use super::check_skippable;

    #[test]
    fn frontend_chat_view_pure_checks_pass() {
        check_skippable("test-node/chat-view-check.cjs", "passed");
    }
}

/// #463: the compiled MIT vendor checks under plain Node, offline. A missing runner must never read as green.
mod frontend_coucou_vendor {
    use super::check;

    #[test]
    fn coucou_vendor_checks_pass() {
        check("test-node/coucou-vendor-check.cjs", "PASS coucou-vendor:");
    }
}

/// UI.1 N6: the notification view-model checks (`test-node/notify-view-check.cjs`) and the #266 incoming-event reveal
/// checks (`test-node/notification-reveal-check.cjs`) under plain `node` (no npm, no network). Fails when node is
/// absent.
mod frontend_notify {
    use super::check;

    #[test]
    fn notify_view_pure_checks_pass() {
        check("test-node/notify-view-check.cjs", "passed");
    }

    #[test]
    fn notification_reveal_pure_checks_pass() {
        check("test-node/notification-reveal-check.cjs", "passed");
    }
}

/// UI.1: the pure overview view-model + icon checks (`test-node/overview-view-check.cjs`) under plain `node` (no npm,
/// no network). Fails when node is absent.
mod frontend_overview {
    use super::check;

    #[test]
    fn frontend_overview_pure_checks_pass() {
        check("test-node/overview-view-check.cjs", "passed");
    }
}

/// #345: public pure model checks, plain Node, no webview or provider calls.
mod frontend_pills {
    use super::check;

    #[test]
    fn pill_catalog_checks_pass() {
        check("test-node/pill-catalog-check.cjs", "# fail 0");
    }

    #[test]
    fn pill_dom_checks_pass() {
        check("test-node/pills-check.cjs", "# fail 0");
    }
}

/// #306: the settings view-model checks (`test-node/settings-view-check.cjs`) under plain `node` (no npm, no network).
/// Fails when node is absent.
mod frontend_settings {
    use super::check;

    #[test]
    fn settings_view_checks_pass() {
        check("test-node/settings-view-check.cjs", "passed");
    }
}

/// #313: the sound wiring checks (`test-node/sound-wiring-check.cjs`) under plain `node` (no npm, no network). Fails
/// when node is absent.
mod frontend_sound {
    use super::check;

    #[test]
    fn sound_wiring_checks_pass() {
        check("test-node/sound-wiring-check.cjs", "passed");
    }
}

/// #327: the specialists view-model checks (`test-node/specialists-view-check.cjs`) under plain `node` (no npm, no
/// network). Fails when node is absent.
mod frontend_specialists {
    use super::check;

    #[test]
    fn specialists_view_checks_pass() {
        check("test-node/specialists-view-check.cjs", "passed");
    }
}

/// #380: the theme controller checks (`test-node/theme-check.cjs`) under plain `node` (no npm, no network). Fails when
/// node is absent.
mod frontend_theme {
    use super::check;

    #[test]
    fn theme_checks_pass() {
        check("test-node/theme-check.cjs", "passed");
    }
}

/// M4: the packaging gates and launcher behaviour checks (`test-node/packaging-check.cjs`) under plain `node` (no npm,
/// no network). Fails when node is absent.
mod packaging {
    use super::check;

    #[test]
    fn packaging_checks_pass() {
        check("test-node/packaging-check.cjs", "passed");
    }
}

/// P3: the self-cleaning temp dir checks (`test-node/tmpdirs-check.cjs`) under plain `node` (no npm, no network). Fails
/// when node is absent.
mod tmpdirs {
    use super::check;

    #[test]
    fn tmpdirs_checks_pass() {
        check("test-node/tmpdirs-check.cjs", "passed");
    }
}

/// N9: the installer behaviour checks (`test-node/install-check.cjs`) under plain `node` (no npm, no network). Fails
/// when node is absent.
///
/// Unix only: `packaging/install.sh` is the Linux installer (POSIX sh, POSIX paths). Its Windows twin is the NSIS
/// payload check `test-node/windows-runtime-check.cjs` plus the installed smokes in `ci/public/smoke-windows*.ps1`.
/// The original file was gated with a crate-level `#![cfg(unix)]`; on a module that gate has to sit here, or the whole
/// merged binary would vanish on Windows.
#[cfg(unix)]
mod install_script {
    use super::check;

    #[test]
    fn install_script_checks_pass() {
        check("test-node/install-check.cjs", "passed");
    }
}
