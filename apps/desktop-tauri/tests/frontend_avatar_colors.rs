//! #384: run the pure avatar-colour contract checks
//! (`test-node/avatar-colors-check.cjs`) under plain `node` (no npm, no
//! network). Fails when node is absent: a missing runner must never read as green.

use std::path::Path;
use std::process::Command;

#[test]
fn frontend_avatar_colors_checks_pass() {
    let node = Command::new("node").arg("--version").output();
    assert!(
        node.as_ref().is_ok_and(|out| out.status.success()),
        "node is required to run test-node/avatar-colors-check.cjs and was not found on PATH: {node:?}"
    );
    let harness = Path::new(env!("CARGO_MANIFEST_DIR")).join("test-node/avatar-colors-check.cjs");
    let out = Command::new("node").arg(&harness).output().expect("spawn node");
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(out.status.success(), "avatar-colors-check failed:\n{stdout}\n{stderr}");
    assert!(stdout.contains("passed"), "{stdout}");
}
