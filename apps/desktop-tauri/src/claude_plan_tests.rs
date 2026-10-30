use super::*;
use std::os::unix::fs::{symlink, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

const NOW_MS: i64 = 1_800_000_000_000;

fn scratch(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("abito-claudeplan-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn put(dir: &Path, text: &str, mode: u32) {
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true).truncate(true).mode(mode);
    std::io::Write::write_all(&mut o.open(dir.join(FILE)).unwrap(), text.as_bytes()).unwrap();
}

fn good(at: i64) -> String {
    format!(
        r#"{{"v":1,"at":{at},"five_hour":{{"used_percentage":12.5,"resets_at":1800003600}},"seven_day":{{"used_percentage":40,"resets_at":1800500000}}}}"#
    )
}

#[test]
fn a_fresh_channel_gives_the_two_windows_in_millis() {
    let d = scratch("fresh");
    put(&d, &good(NOW_MS - 1000), 0o600);
    let v = read_at(&d, NOW_MS).expect("plan");
    assert_eq!(v["fiveHour"]["usedPct"], 12.5);
    assert_eq!(v["fiveHour"]["resetsAt"], 1_800_003_600_000i64);
    assert_eq!(v["sevenDay"]["usedPct"], 40.0);
    assert_eq!(v["updatedAt"], NOW_MS - 1000);
}

#[test]
fn data_older_than_ten_minutes_is_unknown() {
    let d = scratch("stale");
    put(&d, &good(NOW_MS - 10 * 60 * 1000 - 1), 0o600);
    assert!(read_at(&d, NOW_MS).is_none());
    put(&d, &good(NOW_MS - 10 * 60 * 1000), 0o600);
    assert!(read_at(&d, NOW_MS).is_some());
    // a timestamp from the future is not believed either
    put(&d, &good(NOW_MS + 60_000), 0o600);
    assert!(read_at(&d, NOW_MS).is_none());
    // ...but the status-line process and the island may read clocks a few ms apart (HU-062 clock skew)
    for ahead in [20, 200, crate::protocol::CLOCK_SKEW_MS as i64] {
        put(&d, &good(NOW_MS + ahead), 0o600);
        assert!(read_at(&d, NOW_MS).is_some(), "{ahead} ms ahead");
    }
    put(&d, &good(NOW_MS + crate::protocol::CLOCK_SKEW_MS as i64 + 1), 0o600);
    assert!(read_at(&d, NOW_MS).is_none());
}

#[test]
fn a_symlink_an_oversize_file_or_loose_modes_are_refused() {
    let d = scratch("refuse");
    let real = d.join("real.json");
    std::fs::write(&real, good(NOW_MS)).unwrap();
    symlink(&real, d.join(FILE)).unwrap();
    assert!(read_at(&d, NOW_MS).is_none());
    std::fs::remove_file(d.join(FILE)).unwrap();
    put(&d, &format!("{} {}", good(NOW_MS), " ".repeat(5000)), 0o600);
    assert!(read_at(&d, NOW_MS).is_none());
    std::fs::remove_file(d.join(FILE)).unwrap();
    put(&d, &good(NOW_MS), 0o644);
    assert!(read_at(&d, NOW_MS).is_none());
    std::fs::set_permissions(d.join(FILE), std::fs::Permissions::from_mode(0o600)).unwrap();
    assert!(read_at(&d, NOW_MS).is_some());
    assert!(read_at(&d.join("missing"), NOW_MS).is_none());
}

#[test]
fn malformed_or_extra_content_is_unknown() {
    let d = scratch("shape");
    for bad in [
        "not json",
        "[]",
        r#"{"v":2,"at":1800000000000,"five_hour":{"used_percentage":1,"resets_at":1800003600}}"#,
        r#"{"v":1,"at":1800000000000}"#,
        r#"{"v":1,"at":1800000000000,"five_hour":{"used_percentage":-1,"resets_at":1800003600}}"#,
        r#"{"v":1,"at":1800000000000,"five_hour":{"used_percentage":1,"resets_at":1800003600000}}"#,
        r#"{"v":1,"at":1800000000000,"five_hour":{"used_percentage":"1","resets_at":1800003600}}"#,
    ] {
        put(&d, bad, 0o600);
        assert!(read_at(&d, NOW_MS).is_none(), "{bad}");
    }
    // unknown extra keys are dropped, never forwarded
    put(&d, r#"{"v":1,"at":1800000000000,"cwd":"/secret","five_hour":{"used_percentage":1,"resets_at":1800003600,"x":1}}"#, 0o600);
    let v = read_at(&d, NOW_MS).unwrap();
    assert!(v.get("cwd").is_none());
    assert!(v["fiveHour"].get("x").is_none());
}
