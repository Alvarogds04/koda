//! #345: public pure model checks, plain Node, no webview or provider calls.
use std::path::Path;
use std::process::Command;

#[test]
fn pill_catalog_checks_pass() { check("pill-catalog-check.cjs"); }

#[test]
fn pill_dom_checks_pass() { check("pills-check.cjs"); }

fn check(name: &str) {
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("test-node").join(name);
    let out = Command::new("node").arg(script).output().expect("node is required for pills checks");
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(out.status.success(), "pill checks failed: {stdout}\n{stderr}");
    assert!(stdout.contains("# fail 0"), "{stdout}");
}
