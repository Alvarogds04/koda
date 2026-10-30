use super::*;

#[test]
fn the_answer_to_the_question_is_picked_out_of_the_conversation() {
    let stream = concat!(
        r#"{"id":1,"result":{"userAgent":"codex"}}"#, "\n",
        "not json at all\n",
        r#"{"method":"account/updated","params":{}}"#, "\n",
        r#"{"id":2,"result":{"rateLimits":{"primary":{"usedPercent":12.5,"resetsAt":1900000000}}}}"#, "\n",
        r#"{"id":3,"result":{}}"#, "\n",
    );
    let result = first_answer(stream.as_bytes()).unwrap();
    assert_eq!(result["rateLimits"]["primary"]["usedPercent"], 12.5);
}

#[test]
fn an_error_a_closed_stream_or_a_flood_is_no_answer() {
    assert!(first_answer(r#"{"id":2,"error":{"message":"not signed in"}}"#.as_bytes()).is_none());
    assert!(first_answer(r#"{"id":1,"result":{}}"#.as_bytes()).is_none());
    assert!(first_answer(&b""[..]).is_none());
    let huge = "x".repeat(MAX_LINE + 10);
    assert!(first_answer(format!("{huge}\n{}\n", r#"{"id":2,"result":{}}"#).as_bytes()).is_none());
    // Many short lines add up too.
    let chatter = format!("{}\n", "y".repeat(1000)).repeat(MAX_TOTAL / 1000 + 10);
    assert!(first_answer(chatter.as_bytes()).is_none());
}

#[test]
fn only_the_limits_reach_the_webview() {
    let result = json!({
        "rateLimits": { "planType": "plus" },
        "rateLimitResetCredits": { "availableCount": 1 },
        "account": { "email": "me@example.com" }
    });
    let kept = limits_only(&result);
    assert_eq!(kept["rateLimits"]["planType"], "plus");
    assert_eq!(kept["rateLimitResetCredits"]["availableCount"], 1);
    assert!(kept.get("account").is_none());
}

#[test]
fn newest_node_first_like_the_mac() {
    let mut v = vec!["v9.12.0", "v20.1.0", "v18.20.4", "v20.11.1"];
    v.sort_by(|a, b| compare_versions(b, a));
    assert_eq!(v, ["v20.11.1", "v20.1.0", "v18.20.4", "v9.12.0"]);
}

#[test]
fn only_executable_absolute_candidates_are_returned() {
    for c in candidates() {
        assert!(c.is_absolute() && c.is_file(), "{c:?}");
    }
}

#[cfg(unix)]
#[test]
fn a_fake_codex_on_path_is_asked_and_only_limits_come_back() {
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!("abito-codex-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let exe = dir.join("codex");
    std::fs::write(
        &exe,
        "#!/bin/sh\nread a; read b; read c\necho '{\"id\":1,\"result\":{}}'\necho '{\"id\":2,\"result\":{\"rateLimits\":{\"planType\":\"plus\"},\"account\":{\"email\":\"x\"}}}'\n",
    )
    .unwrap();
    std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
    // The PATH is passed in, never set on the process: other tests run in parallel and spawn `node` through it.
    let got = read_with(Some(dir.clone().into_os_string()));
    let _ = std::fs::remove_dir_all(&dir);
    let got = got.expect("answer");
    assert_eq!(got["rateLimits"]["planType"], "plus");
    assert!(got.get("account").is_none());
}

#[test]
fn reading_codex_limits_never_changes_the_process_path() {
    // candidates_in, not read_with: read_with takes the process-wide BUSY guard, and a parallel call here made the
    // fake-codex test above read «busy» (None) about 4 runs in 6.
    let before = std::env::var_os("PATH");
    let _ = candidates_in(Some(std::ffi::OsString::from("/nonexistent-abito-dir")));
    assert_eq!(std::env::var_os("PATH"), before);
}
