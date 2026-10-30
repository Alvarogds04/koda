use super::*;

const HOME: &str = "/home/dev";
const USER: &str = "alvaro";
fn r(t: &str) -> String { redact(t, HOME, USER) }

#[test]
fn redacts_known_secret_prefixes() {
    for secret in ["sk-ant-api03-AbCdEfGhIjKlMnOpQrSt", "sk-proj1234567890abcdef", "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        "github_pat_11ABCDEFG0abcdefghij", "xoxb-1234-5678-abcdefg", "AKIAIOSFODNN7EXAMPLE", "AIzaSyA-abcdefghijklmnopqrstuv",
        "ya29.a0AfH6SMBxxxxxxxxxxxx", "hf_abcdefghijklmnopqrstu", "re_AbCdEfGh12345678", "npm_abcdefghijklmnopqrstuvwx",
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcDEF123"] {
        let out = r(&format!("failed with key {secret} while loading"));
        assert!(!out.contains(secret), "leaked {secret}: {out}");
        assert!(out.contains("<secret>"), "{out}");
        assert!(out.starts_with("failed with key ") && out.ends_with(" while loading"), "{out}");
    }
}

#[test]
fn redacts_bearer_and_key_value_secrets_but_keeps_the_key_name() {
    let out = r("Authorization: Bearer abc.def-ghi");
    assert!(!out.contains("abc.def-ghi") && out.contains("Authorization"), "{out}");
    let out = r(r#"{"api_key":"hunter2hunter2","model":"x"}"#);
    assert!(!out.contains("hunter2") && out.contains("api_key") && out.contains(r#""model":"x""#), "{out}");
    let out = r("password=swordfish token: abcd1234 secret = \"zzz\" other=fine");
    assert!(!out.contains("swordfish") && !out.contains("abcd1234") && !out.contains("zzz"), "{out}");
    assert!(out.contains("other=fine"), "{out}");
}

#[test]
fn high_entropy_strings_are_redacted_but_plain_words_paths_and_short_hashes_stay() {
    let blob = "Zk3Jf9QxL2mV8pTrWb6YcNd4HsGa7UeX1oIq5KvB";
    let out = r(&format!("odd {blob} value"));
    assert!(!out.contains(blob) && out.contains("<secret>"), "{out}");
    let keep = "panicked at src/voicehost.rs:120:9 fingerprint=3fa9c01b7d2e internationalization-configuration-management";
    assert_eq!(r(keep), keep);
}

#[test]
fn redacts_oauth_codes_and_url_credentials() {
    let out = r("callback http://127.0.0.1:8080/cb?code=4%2F0AbCdEf&state=xyz123&scope=mail more");
    assert!(!out.contains("4%2F0AbCdEf") && !out.contains("xyz123"), "{out}");
    assert!(out.contains("scope=mail") && out.contains("<ip>:8080/cb"), "{out}");
    let out = r("fetch https://user:pw0rd@example.test/x?access_token=aaa&id_token=bbb ok");
    assert!(!out.contains("pw0rd") && !out.contains("aaa") && !out.contains("bbb"), "{out}");
}

#[test]
fn home_path_becomes_tilde_and_other_users_homes_too() {
    assert_eq!(r("open /home/dev/Apps/x/y.rs failed"), "open ~/Apps/x/y.rs failed");
    assert_eq!(r("open /home/maria/f and /Users/Bob/g and C:\\Users\\Eve\\h"), "open ~/f and ~/g and ~\\h");
    assert_eq!(r("home=/home/dev"), "home=~");
}

#[test]
fn user_name_is_replaced_as_a_whole_word_case_insensitively() {
    let out = r("user Alvaro logged in as alvaro; alvarogds stays? no: ALVARO");
    assert!(!out.to_lowercase().contains("alvaro;") && !out.contains("Alvaro") && !out.contains("ALVARO"), "{out}");
    assert!(out.contains("<user>"), "{out}");
    assert_eq!(r("nombre alvarado"), "nombre alvarado");
    assert_eq!(redact("nothing here", HOME, ""), "nothing here"); // an empty user name must not match everywhere
}

#[test]
fn emails_are_redacted() {
    let out = r("sent to alice.b+tag@mail.example.com and Bob@Corp.io today");
    assert_eq!(out, "sent to <email> and <email> today");
}

#[test]
fn conversation_content_never_reaches_the_report_log() {
    let lines = vec![
        "INFO daemon started".to_owned(),
        "chat: user said: my diagnosis is private".to_owned(),
        "DEBUG transcript=hola abito escribí a mi madre".to_owned(),
        "WARN prompt: dime algo".to_owned(),
        "ERROR conversation 42 failed to load".to_owned(),
        "ERROR voice model load failed".to_owned(),
    ];
    let kept = safe_log_lines(&lines, HOME, USER, 50);
    assert_eq!(kept, vec!["INFO daemon started", "ERROR voice model load failed"]);
}

#[test]
fn log_tail_is_capped_to_the_last_n_lines_and_long_lines_are_cut() {
    let lines: Vec<String> = (0..80).map(|i| format!("line {i}")).collect();
    let kept = safe_log_lines(&lines, HOME, USER, 50);
    assert_eq!(kept.len(), 50);
    assert_eq!(kept[0], "line 30");
    assert_eq!(kept[49], "line 79");
    let long = vec!["x ".repeat(400)];
    assert!(safe_log_lines(&long, HOME, USER, 50)[0].chars().count() <= 301);
}

#[test]
fn fingerprint_is_stable_and_ignores_volatile_parts() {
    let a = fingerprint("island", "voice-load", "failed to load /home/dev/m/x.onnx after 120 ms (pid 4411) at 0x7ffd1234");
    let b = fingerprint("island", "voice-load", "failed to load /home/maria/m/x.onnx after 87 ms (pid 9) at 0x55aa00ff");
    assert_eq!(a, b);
    assert_eq!(a.len(), 12);
    assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    assert_ne!(a, fingerprint("daemon", "voice-load", "failed to load /home/dev/m/x.onnx after 120 ms (pid 4411) at 0x7ffd1234"));
    assert_ne!(a, fingerprint("island", "agent-down", "failed to load /home/dev/m/x.onnx after 120 ms (pid 4411) at 0x7ffd1234"));
    assert_ne!(a, fingerprint("island", "voice-load", "a different error entirely"));
}

fn record() -> FailureRecord {
    record_failure("voice", "model-load-failed", Reason::ModelLoadFailed(ModelError::MissingFile), Some(2), None,
        &Env { version: "0.2.0".into(), os: "Ubuntu 24.04".into(), session: "wayland".into(), home: HOME.into(), user: USER.into() }, 1_700_000_000)
}

#[test]
fn report_has_every_s2_field_and_is_redacted() {
    let rep = build_report(&record(), &["INFO ok".to_owned(), "ERROR in /home/dev/x".to_owned()], HOME, USER);
    for needle in ["0.2.0", "Ubuntu 24.04", "wayland", "voice", "model-load-failed", "voice model failed to load: missing file (2)", &fingerprint_of(&record()), "INFO ok", "ERROR in ~/x"] {
        assert!(rep.body.contains(needle), "missing {needle}: {}", rep.body);
    }
    assert!(!rep.body.contains("sk-ant") && !rep.body.contains("alvaro"), "{}", rep.body);
    assert!(rep.title.contains("voice") && rep.title.contains(&fingerprint_of(&record())), "{}", rep.title);
    assert!(!rep.title.contains("alvaro") && rep.title.len() <= 120);
}

#[test]
fn issue_url_is_encoded_targets_the_public_repo_and_carries_labels() {
    let IssueUrl::Url(u) = issue_url("[crash] a b", "line1\nüñ & = ? #x") else { panic!("short text must fit") };
    assert!(u.starts_with("https://github.com/Alvarogds04/abito/issues/new?title="), "{u}");
    assert!(u.contains("title=%5Bcrash%5D%20a%20b") && u.contains("&body=line1%0A%C3%BC%C3%B1%20%26%20%3D%20%3F%20%23x"), "{u}");
    assert!(u.ends_with("&labels=bug%2Cauto-report"), "{u}");
    assert!(u.is_ascii());
}

#[test]
fn too_long_text_is_not_sent_in_the_url() {
    assert_eq!(issue_url("t", &"a".repeat(MAX_URL_LEN)), IssueUrl::TooLong);
    let IssueUrl::Url(u) = issue_url("t", &"a".repeat(1000)) else { panic!() };
    assert!(u.len() <= MAX_URL_LEN);
    // multibyte text expands 6x when encoded: the cap is on the ENCODED length
    assert_eq!(issue_url("t", &"ü".repeat(MAX_URL_LEN / 4)), IssueUrl::TooLong);
}

#[test]
fn search_url_points_at_the_repo_issue_search_with_the_fingerprint() {
    assert_eq!(search_url("3fa9c01b7d2e"), "https://github.com/Alvarogds04/abito/issues?q=is%3Aissue%203fa9c01b7d2e");
    assert!(!search_url("a b&c").contains("a b&c"));
}

#[test]
fn records_round_trip_through_the_local_store_and_dedupe_by_fingerprint() {
    let dir = std::env::temp_dir().join(format!("abito-failure-{}-{}", std::process::id(), line!()));
    let _ = std::fs::remove_dir_all(&dir);
    assert!(load_all(&dir).is_empty());
    let rec = record();
    store(&dir, &rec).unwrap();
    store(&dir, &rec).unwrap();
    let all = load_all(&dir);
    assert_eq!(all.len(), 1, "the same fingerprint is one failure, repeated");
    assert_eq!(all[0].record, rec);
    assert_eq!(all[0].count, 2);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_corrupt_store_is_ignored_not_fatal() {
    let dir = std::env::temp_dir().join(format!("abito-failure-{}-{}", std::process::id(), line!()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(STORE_FILE), "not json\n{\"x\":1}\n").unwrap();
    assert!(load_all(&dir).is_empty());
    store(&dir, &record()).unwrap();
    assert_eq!(load_all(&dir).len(), 1);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn multibyte_text_next_to_path_like_prefixes_never_panics() {
    assert_eq!(r("describí acá qué pasó: C:\\Users\\Eve\\ñ y ñandú"), "describí acá qué pasó: ~\\ñ y ñandú");
    assert_eq!(r("é:ü ü"), "é:ü ü");
}

#[test]
fn each_listed_prefix_is_redacted_on_its_own() {
    for secret in ["ghp_0123456789abcdefghijABCDEFGHIJ", "gho_0123456789abcdefghijABCDEFGHIJ", "github_pat_11AAAAAAA0abcdefghijklmnop_QRSTUV",
        "glpat-abcdefghij0123456789", "xoxb-111111111111-222222222222-abcdefABCDEF", "AIzaSyD-abcdefghijklmnopqrstuvwxyz01234"] {
        for wrap in ["{}", "token {} end", "\"{}\"", "({})", "x={}", "{}."] {
            let text = wrap.replace("{}", secret);
            let out = r(&text);
            assert!(!out.contains(&secret[..12]), "leaked {secret} in {text:?}: {out}");
        }
    }
}

#[test]
fn ipv4_addresses_are_redacted_including_private_and_tailnet_ranges() {
    for ip in ["8.8.8.8", "192.168.1.20", "10.0.0.5", "172.16.4.9", "100.64.0.1", "100.101.102.103", "127.0.0.1"] {
        assert_eq!(r(&format!("connect to {ip}:1725 failed")), "connect to <ip>:1725 failed", "{ip}");
        assert_eq!(r(&format!("http://{ip}/x")), "http://<ip>/x", "{ip}");
    }
    assert_eq!(r("Abito 0.2.0 build 1.2.3 at 12:34:56"), "Abito 0.2.0 build 1.2.3 at 12:34:56", "versions and times stay");
}

#[test]
fn ipv6_addresses_are_redacted_but_rust_paths_and_times_stay() {
    for ip in ["::1", "fe80::1ff:fe23:4567:890a", "2001:db8::8a2e:370:7334", "2001:0db8:0000:0000:0000:ff00:0042:8329", "fd7a:115c:a1e0::1", "::ffff:192.168.1.1"] {
        assert_eq!(r(&format!("bind {ip} refused")), "bind <ip> refused", "{ip}");
        assert_eq!(r(&format!("http://[{ip}]:80/")), "http://[<ip>]:80/", "{ip}");
    }
    let keep = "panicked in std::io::Error and core::fmt::Display at 12:34:56 deadbeef::cafe_fn";
    assert_eq!(r(keep), keep);
}

#[test]
fn tailnet_and_local_hostnames_are_redacted() {
    for host in ["alvaro-pc.tail1234.ts.net", "ubuntu.local", "nas.lan", "db.internal", "router.home.arpa", "Mi-PC.TS.NET"] {
        assert_eq!(r(&format!("resolve {host} failed")), "resolve <host> failed", "{host}");
        assert_eq!(r(&format!("https://{host}:8443/api")), "https://<host>:8443/api", "{host}");
    }
    assert_eq!(r("see github.com and example.org"), "see github.com and example.org");
}

#[test]
fn the_machines_own_hostname_is_redacted() {
    let host = std::fs::read_to_string("/proc/sys/kernel/hostname").unwrap_or_default().trim().to_owned();
    if host.len() < 3 || host == "localhost" { return; } // nothing distinctive to hide on this machine
    let out = r(&format!("host {host} unreachable, also {}", host.to_uppercase()));
    assert!(!out.to_lowercase().contains(&host.to_lowercase()), "{out}");
    assert!(out.contains("<host>"), "{out}");
}

fn env() -> Env { Env { version: "0.2.0".into(), os: "Ubuntu".into(), session: "x11".into(), home: HOME.into(), user: USER.into() } }

#[test]
fn every_field_and_the_whole_record_are_bounded() {
    let big = "ñ".repeat(10_000);
    let e = Env { version: big.clone(), os: big.clone(), session: big.clone(), home: HOME.into(), user: USER.into() };
    let rec = record_failure(&big, &big, Reason::AgentLost, Some(i64::MAX), Some((&big, u32::MAX)), &e, 1);
    let line = serde_json::to_string(&rec).unwrap();
    assert!(line.len() <= RECORD_MAX_BYTES, "{} bytes", line.len());
    for f in [&rec.version, &rec.os, &rec.session] { assert!(f.chars().count() <= FIELD_MAX + 1); }
    // a record that is still too big (built by hand) is refused, never written
    let dir = tmpdir("big");
    let mut hand = rec.clone();
    hand.message = "x".repeat(RECORD_MAX_BYTES * 2);
    assert!(store(&dir, &hand).is_err());
    assert!(load_all(&dir).is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn store_tightens_the_modes_of_an_existing_dir_and_file() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tmpdir("modes");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(dir.join(STORE_FILE), "").unwrap();
    std::fs::set_permissions(dir.join(STORE_FILE), std::fs::Permissions::from_mode(0o644)).unwrap();
    store(&dir, &record()).unwrap();
    let mode = |p: std::path::PathBuf| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(dir.clone()), 0o700);
    assert_eq!(mode(dir.join(STORE_FILE)), 0o600);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_permission_error_is_reported_not_swallowed() {
    // a path whose parent is a FILE cannot become a directory; and a store we cannot chmod must not be written silently
    let dir = tmpdir("perm");
    std::fs::create_dir_all(&dir).unwrap();
    let blocker = dir.join("blocker");
    std::fs::write(&blocker, "x").unwrap();
    assert!(store(&blocker.join("sub"), &record()).is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_short_home_never_eats_the_start_of_a_longer_path() {
    assert_eq!(redact("/home/dev/x /home/a/y", "/home/a", ""), "~/x ~/y");
    assert_eq!(redact("home=/home/a", "/home/a", ""), "home=~");
    assert_eq!(redact("/home/ab/z", "/home/a", ""), "~/z", "another user's home is still hidden by the generic rule");
}

// ---- structural exclusion (verifier round 2, point 1)

const CHAT: &str = "dime algo sobre mi madre y mi diagnóstico: hola abito, mandale un mail a mi jefe";

fn everything(rec: &FailureRecord, dir: &std::path::Path) -> String {
    let rep = build_report(rec, &[], HOME, USER);
    let raw = std::fs::read_to_string(dir.join(STORE_FILE)).unwrap_or_default();
    let IssueUrl::Url(url) = issue_url(&rep.title, &rep.body) else { panic!("fits") };
    format!("{}\n{}\n{raw}\n{url}\n{}", rep.title, rep.body, serde_json::to_string(rec).unwrap())
}

#[test]
fn a_report_call_cannot_carry_free_text_anywhere() {
    let dir = tmpdir("structural");
    // the only inputs are closed codes and numbers; hostile process/step strings are reduced to "unknown"
    note(&dir, CHAT, CHAT, Reason::AgentNoAnswer, Some(7));
    let all = load_all(&dir);
    assert_eq!(all.len(), 1);
    let text = everything(&all[0].record, &dir);
    for leaked in ["madre", "diagnóstico", "jefe", "dime", "hola"] {
        assert!(!text.contains(leaked), "leaked {leaked}: {text}");
    }
    assert_eq!((all[0].record.process.as_str(), all[0].record.step.as_str()), ("unknown", "unknown"));
    assert_eq!(all[0].record.message, "agent daemon did not answer (7)");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_panic_keeps_only_its_kind_and_file_line() {
    let env = env();
    let rec = record_from_panic("island", &format!("called `Result::unwrap()` on an `Err` value: ParseError(\"{CHAT}\")"), Some(("/home/dev/Apps/x/src/chat.rs", 7)), &env, 1);
    assert_eq!(rec.step, "panic");
    assert_eq!(rec.message, "panic: unwrap on an Err value at src/chat.rs:7");
    for payload in [CHAT.to_owned(), format!("assertion failed: {CHAT}"), format!("index out of bounds: the len is 3 but the index is 5 {CHAT}"), format!("attempt to add with overflow {CHAT}"), format!("explicit panic {CHAT}")] {
        let rec = record_from_panic("island", &payload, Some(("src/a.rs", 1)), &env, 1);
        for leaked in ["madre", "diagnóstico", "jefe", "dime", "hola"] { assert!(!rec.message.contains(leaked), "{payload:?} -> {}", rec.message); }
        assert!(valid_message(&rec.message), "{}", rec.message);
    }
    let no_loc = record_from_panic("island", "explicit panic", None, &env, 1);
    assert_eq!(no_loc.message, "panic: explicit panic");
}

#[test]
fn stored_records_with_arbitrary_text_are_not_trusted_on_load_or_in_the_report() {
    let dir = tmpdir("untrusted");
    std::fs::create_dir_all(&dir).unwrap();
    let mut rec = record();
    rec.message = format!("conversation 9: {CHAT}");
    std::fs::write(dir.join(STORE_FILE), format!("{}\n", serde_json::to_string(&rec).unwrap())).unwrap();
    assert!(load_all(&dir).is_empty(), "a record whose message is not one of ours is dropped");
    let rep = build_report(&rec, &[], HOME, USER);
    assert!(!rep.body.contains("madre") && !rep.body.contains("conversation 9"), "{}", rep.body);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn every_closed_reason_composes_a_valid_message() {
    for r in Reason::all() {
        let m = compose(&r, Some(-1), Some(("src/x.rs", 3)));
        assert!(valid_message(&m), "{m}");
        assert!(valid_message(&compose(&r, None, None)));
    }
    for bad in ["", "boom", "agent daemon did not answer (x)", "agent daemon did not answer at ../../etc/passwd:1", "agent daemon did not answer\nextra", "agent daemon did not answer (1) at src/a b.rs:1"] {
        assert!(!valid_message(bad), "{bad:?}");
    }
}

// ---- case-insensitive prefixes (point 2)

#[test]
fn prefixes_match_case_insensitively() {
    for secret in ["GhP_0123456789abcdefghijABCDEFGHIJ", "GHP_0123456789abcdefghijABCDEFGHIJ", "gHo_0123456789abcdefghijABCDEFGHIJ", "Github_PAT_11AAAAAAA0abcdefghijklmnop",
        "GlPat-abcdefghij0123456789", "XOXB-111111111111-222222222222-abcdefABCDEF", "Xoxp-111111111111-abcdef", "aiza-not-it-but AIZAsyD-abcdefghijklmnopqrstuvwxyz01234", "aizaSyD-abcdefghijklmnopqrstuvwxyz01234",
        "SK-ANT-api03-AbCdEfGhIjKlMnOpQrSt", "Sk-proj1234567890abcdef", "akiaiosfodnn7example", "Eyjhbgcioijiuzi1nij9.abcdefghijklmnopqrstu", "HF_abcdefghijklmnopqrstu", "NPM_abcdefghijklmnopqrstuvwx", "Ya29.a0AfH6SMBxxxxxxxxxxxx"] {
        let out = r(&format!("key {secret} end"));
        assert!(out.contains("<secret>") && !out.contains(&secret[secret.len().saturating_sub(10)..]), "leaked {secret}: {out}");
    }
}

// ---- percent-encoding (point 3), the pure decoder

#[test]
fn percent_decoding_is_bounded_and_stops_when_stable() {
    assert_eq!(percent_decode_bounded("%2Fhome%2Fdev"), "/home/dev");
    assert_eq!(percent_decode_bounded("dev%40example.com"), "dev@example.com");
    assert_eq!(percent_decode_bounded("sk%2Dant%2Dapi03%2DAbCdEf"), "sk-ant-api03-AbCdEf");
    assert_eq!(percent_decode_bounded("%252Fhome"), "/home", "double-encoded");
    assert_eq!(percent_decode_bounded("%2525252Fhome"), "%2Fhome", "at most 3 passes");
    assert_eq!(percent_decode_bounded("100% sure %zz %4"), "100% sure %zz %4", "invalid sequences stay");
    assert_eq!(percent_decode_bounded("plain text"), "plain text");
    assert_eq!(percent_decode_bounded("%F0%9F"), "\u{FFFD}", "invalid utf-8 never panics");
}

fn tmpdir(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("abito-failure-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

// ---- round 3

#[test]
fn process_and_step_are_a_closed_allowlist() {
    let e = env();
    for (p, st) in [("island", "panic"), ("daemon", "daemon-start"), ("daemon", "daemon-exited"), ("island", "agent-refused"), ("island", "agent-no-answer"),
        ("island", "agent-lost"), ("voice", "model-load-failed"), ("island", "manual-report")] {
        let rec = record_failure(p, st, Reason::Manual, None, None, &e, 1);
        assert_eq!((rec.process.as_str(), rec.step.as_str()), (p, st));
    }
    for bad in ["alvaro", "Alvaro", "maria-pc", "island2", "ISLAND", "island ", "voz"] {
        let rec = record_failure(bad, bad, Reason::Manual, None, None, &e, 1);
        assert_eq!((rec.process.as_str(), rec.step.as_str()), ("unknown", "unknown"), "{bad}");
    }
}

#[test]
fn load_all_drops_stored_records_whose_process_or_step_is_not_on_the_allowlist() {
    let dir = tmpdir("allowlist");
    std::fs::create_dir_all(&dir).unwrap();
    let mut good = record();
    let mut bad_p = record(); bad_p.process = "alvaro".into();
    let mut bad_s = record(); bad_s.step = "alvaro".into();
    let unknown = { let mut r = record(); r.process = "unknown".into(); r.step = "unknown".into(); r };
    good.at_secs = 1;
    let text: String = [&good, &bad_p, &bad_s, &unknown].iter().map(|r| serde_json::to_string(r).unwrap() + "\n").collect();
    std::fs::write(dir.join(STORE_FILE), text).unwrap();
    let all = load_all(&dir);
    assert!(all.iter().all(|s| s.record.process != "alvaro" && s.record.step != "alvaro"), "{all:?}");
    assert_eq!(all.len(), 2, "the good record and the explicit unknown one");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn only_crate_source_paths_keep_their_location() {
    let e = env();
    let msg = |f: &str| record_failure("island", "panic", Reason::Panic(PanicKind::Explicit), None, Some((f, 3)), &e, 1).message;
    assert_eq!(msg("src/voicehost.rs"), "panic: explicit panic at src/voicehost.rs:3");
    assert_eq!(msg("/home/x/y/src/flow/mod.rs"), "panic: explicit panic at src/flow/mod.rs:3");
    for bad in ["src/Dev.rs", "src/my-file.rs", "src/a b.rs", "lib.rs", "/home/dev/notes.txt", "src/.rs", "src/a.RS", "src/ñ.rs", "src/../x.rs", "tests/a.rs", ""] {
        assert_eq!(msg(bad), "panic: explicit panic", "{bad:?}");
    }
}

#[test]
fn a_source_path_that_contains_the_user_name_or_a_secret_loses_its_location() {
    let e = env();
    let rec = record_failure("island", "panic", Reason::Panic(PanicKind::Explicit), None, Some(("src/alvaro.rs", 9)), &e, 1);
    assert_eq!(rec.message, "panic: explicit panic", "{}", rec.message);
    let rec = record_failure("island", "panic", Reason::Panic(PanicKind::Explicit), None, Some(("src/sk_live_abcdefghij.rs", 9)), &e, 1);
    assert_eq!(rec.message, "panic: explicit panic");
    let rec = record_failure("island", "panic", Reason::Panic(PanicKind::Explicit), None, Some(("src/chat.rs", 9)), &e, 1);
    assert_eq!(rec.message, "panic: explicit panic at src/chat.rs:9");
}

#[test]
fn leftover_escapes_after_the_bounded_decode_are_neutralized() {
    assert_eq!(neutralize_escapes("a%2Fb"), "a%<enc>b");
    assert_eq!(neutralize_escapes("%41%zz%4"), "%<enc>%zz%4", "only real %XX escapes");
    assert_eq!(neutralize_escapes("no escapes 100%"), "no escapes 100%");
    // 4-level encoding of '/': three passes leave one escape behind
    assert_eq!(neutralize_escapes(&percent_decode_bounded("%2525252Fhome")), "%<enc>home");
}
