//! U2 integration: model metadata refresh against IN-PROCESS fake routers.
//! Proves the refresh is metadata only (zero inference), reads only
//! SELECTABLE origins (a diagnostic entry's port is never contacted), and
//! the gate distinguishes listed from ready without loading anything.

use abito_island::fakemodel::{closed_port, FakeModel, FakeModelConfig};
use abito_island::models::{self, Entry, Kind};

fn leak(s: String) -> &'static str {
    Box::leak(s.into_boxed_str())
}

fn registry(selectable: &str, diagnostic: &str) -> Vec<Entry> {
    vec![
        Entry {
            profile_id: "local-abito-gpt",
            revision: 1,
            origin: leak(selectable.to_string()),
            alias: Some("Abito-gpt"),
            role: "conversation",
            lane_id: "conversation",
            kind: Kind::Selectable,
        },
        Entry {
            profile_id: "diag-x",
            revision: 1,
            origin: leak(diagnostic.to_string()),
            alias: None,
            role: "diagnostic",
            lane_id: "none",
            kind: Kind::Diagnostic { state: "unknown", note: "test" },
        },
    ]
}

#[test]
fn refresh_reads_metadata_from_selectable_origins_only() {
    let router = FakeModel::start(FakeModelConfig::default());
    let diagnostic = FakeModel::start(FakeModelConfig::default());
    let reg = registry(&router.origin(), &diagnostic.origin());
    let metas = models::read_all(&reg);
    assert_eq!(metas.len(), 1);
    let m = &metas[0].1;
    assert!(m.reachable);
    assert_eq!(m.loaded_alias.as_deref(), Some("Abito-gpt"));
    assert_eq!(m.n_ctx, Some(65_536));
    assert_eq!(router.completions(), 0, "no inference to populate a picker");
    let paths: Vec<String> = router.seen().into_iter().map(|s| format!("{} {}", s.method, s.path)).collect();
    assert_eq!(paths, ["GET /health", "GET /v1/models", "GET /props", "GET /slots"]);
    assert!(diagnostic.seen().is_empty(), "diagnostic ports are never contacted");

    let res = models::read_resources();
    let v = models::listing(&reg, &metas, &res, Some("local-abito-gpt"), 1);
    let p = &v["profiles"][0];
    assert_eq!(p["gate"]["state"], "ready");
    assert_eq!(p["context_tokens"], 65_536);
    assert_eq!(v["profiles"][1]["selectable"], false);
}

#[test]
fn sleeping_router_is_needs_load_and_nothing_is_loaded() {
    let router = FakeModel::start(FakeModelConfig { sleeping: true, ..Default::default() });
    let reg = registry(&router.origin(), &format!("http://127.0.0.1:{}", closed_port()));
    let metas = models::read_all(&reg);
    let res = models::read_resources();
    let g = models::gate("Abito-gpt", &metas[0].1, &res);
    assert_eq!(g.state, "needs_load");
    assert!(!g.can_send());
    assert_eq!(router.completions(), 0);
}

#[test]
fn down_router_is_unavailable_with_one_health_read() {
    let origin = format!("http://127.0.0.1:{}", closed_port());
    let reg = registry(&origin, &origin);
    let metas = models::read_all(&reg);
    assert!(!metas[0].1.reachable);
    let g = models::gate("Abito-gpt", &metas[0].1, &models::read_resources());
    assert_eq!(g.state, "unavailable");
}

#[test]
fn local_resources_are_read_without_privileges() {
    let r = models::read_resources();
    // /proc/meminfo is always readable on Linux; GPU counters may be absent
    assert!(r.mem_total.is_some() && r.mem_available.is_some());
    assert!(!models::resources_text(&r).is_empty());
}

#[cfg(unix)]
#[test]
fn selection_file_is_private_atomic_and_fail_closed() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let dir = std::env::temp_dir().join(format!("abito-models-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(models::read_saved_file(&dir), models::Saved::Absent);
    models::write_saved_file(&dir, "local-abito-gpt").unwrap();
    let file = dir.join(models::SELECTION_FILE);
    assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
    assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(models::read_saved_file(&dir), models::Saved::Selected("local-abito-gpt".into()));
    // no temp leftovers
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
    // group/world readable -> refused
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(models::read_saved_file(&dir), models::Saved::Invalid);
    // a symlink in place of the file -> refused (O_NOFOLLOW)
    std::fs::remove_file(&file).unwrap();
    let target = dir.join("elsewhere.json");
    std::fs::write(&target, models::saved_bytes("local-abito-gpt")).unwrap();
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600)).unwrap();
    symlink(&target, &file).unwrap();
    assert_eq!(models::read_saved_file(&dir), models::Saved::Invalid);
    // a world-writable directory is never written into
    let open = dir.join("open");
    std::fs::create_dir(&open).unwrap();
    std::fs::set_permissions(&open, std::fs::Permissions::from_mode(0o777)).unwrap();
    assert!(models::write_saved_file(&open, "local-abito-gpt").is_err());
    std::fs::remove_dir_all(&dir).unwrap();
}
