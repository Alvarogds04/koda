//! #372: run the composer keyboard checks (`tests/composer-ime-check.cjs`),
//! which drive the REAL `frontend/chat.js` over a fake DOM, under plain `node`
//! (no npm, no network). Skips loudly when node is absent.

use std::path::Path;
use std::process::Command;

#[test]
fn frontend_chat_composer_ime_checks_pass() {
    if Command::new("node").arg("--version").output().is_err() {
        eprintln!("SKIPPED: node unavailable — composer-ime-check not run");
        return;
    }
    let harness = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/composer-ime-check.cjs");
    let out = Command::new("node").arg(&harness).output().expect("spawn node");
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(out.status.success(), "composer-ime-check failed:\n{stdout}\n{stderr}");
    assert!(stdout.contains("passed"), "{stdout}");
}
