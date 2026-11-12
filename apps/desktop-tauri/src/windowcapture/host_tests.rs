use super::*;
use super::super::mcp::*;

struct D;
impl Desktop for D {
    fn pick_target(&self) -> Result<Target, CaptureError> { Err(CaptureError::NoWindow) }
    fn capture(&self, _: &Target) -> Result<Shot, CaptureError> { Err(CaptureError::NoWindow) }
}
struct Q;
impl Dialogs for Q { fn ask_grant(&self) -> bool { false } }

#[test]
fn before_start_the_daemon_gets_nothing_and_after_it_gets_a_loopback_url_and_a_token() {
    assert!(daemon_env().is_empty());
    assert!(start(Arc::new(D), Arc::new(Q), Arc::new(|| false)));
    let env = daemon_env();
    assert_eq!(env.len(), 2);
    assert_eq!(env[0].0, ENV_URL);
    assert!(env[0].1.starts_with("http://127.0.0.1:") && env[0].1.ends_with("/mcp"));
    assert_eq!(env[1].0, ENV_TOKEN);
    // The daemon's MCP_BEARER rule: 8-512 chars of [A-Za-z0-9._~+/=-].
    assert!(env[1].1.len() >= 8 && env[1].1.chars().all(|c| c.is_ascii_alphanumeric()));
    // A second start keeps the same endpoint (one per launch).
    assert!(start(Arc::new(D), Arc::new(Q), Arc::new(|| false)));
    assert_eq!(daemon_env(), env);
}
