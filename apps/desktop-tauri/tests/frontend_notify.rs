//! UI.1: N6: run the notification view-model checks
//! (`test-node/notify-view-check.cjs`) and the #266 incoming-event reveal
//! checks (`test-node/notification-reveal-check.cjs`) under plain `node` (no
//! npm, no network). Fails when node is absent: a missing runner must never
//! read as green.

use std::path::Path;
use std::process::Command;

fn run_node_check(name: &str) {
    let node = Command::new("node").arg("--version").output();
    assert!(
        node.as_ref().is_ok_and(|out| out.status.success()),
        "node is required to run test-node/{name} and was not found on PATH: {node:?}"
    );
    let harness = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("test-node/{name}"));
    let out = Command::new("node")
        .arg(&harness)
        .output()
        .expect("spawn node");
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(out.status.success(), "{name} failed:\n{stdout}\n{stderr}");
    assert!(stdout.contains("passed"), "{stdout}");
}

#[test]
fn notify_view_pure_checks_pass() {
    run_node_check("notify-view-check.cjs");
}

#[test]
fn notification_reveal_pure_checks_pass() {
    run_node_check("notification-reveal-check.cjs");
}
