//! #463: run the compiled MIT vendor checks under plain Node, offline.
//! A missing runner must never read as green.

use std::path::Path;
use std::process::Command;

#[test]
fn coucou_vendor_checks_pass() {
    let node = Command::new("node").arg("--version").output();
    assert!(
        node.as_ref().is_ok_and(|out| out.status.success()),
        "node is required to run test-node/coucou-vendor-check.cjs and was not found on PATH: {node:?}"
    );
    let harness = Path::new(env!("CARGO_MANIFEST_DIR")).join("test-node/coucou-vendor-check.cjs");
    let out = Command::new("node")
        .arg(&harness)
        .output()
        .expect("spawn node");
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        out.status.success(),
        "coucou-vendor-check failed:\n{stdout}\n{stderr}"
    );
    assert!(stdout.contains("PASS coucou-vendor:"), "{stdout}");
}
