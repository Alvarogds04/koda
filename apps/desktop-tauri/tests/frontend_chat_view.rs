//! U1: run the pure frontend chat-view checks (`test-node/chat-view-check.cjs`)
//! and the F024 model-row wiring checks (`test-node/chat-model-picker-check.cjs`)
//! under plain `node` (no npm, no network). Skips loudly when node is absent.

use std::path::Path;
use std::process::Command;

#[test]
fn frontend_chat_view_pure_checks_pass() {
    if Command::new("node").arg("--version").output().is_err() {
        eprintln!("SKIPPED: node unavailable — chat-view-check not run");
        return;
    }
    let harness = Path::new(env!("CARGO_MANIFEST_DIR")).join("test-node/chat-view-check.cjs");
    let out = Command::new("node").arg(&harness).output().expect("spawn node");
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(out.status.success(), "chat-view-check failed:\n{stdout}\n{stderr}");
    assert!(stdout.contains("passed"), "{stdout}");
}

#[test]
fn frontend_chat_model_picker_checks_pass() {
    if Command::new("node").arg("--version").output().is_err() {
        eprintln!("SKIPPED: node unavailable — chat-model-picker-check not run");
        return;
    }
    let harness = Path::new(env!("CARGO_MANIFEST_DIR")).join("test-node/chat-model-picker-check.cjs");
    let out = Command::new("node").arg(&harness).output().expect("spawn node");
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(out.status.success(), "chat-model-picker-check failed:\n{stdout}\n{stderr}");
    assert!(stdout.contains("passed"), "{stdout}");
}
