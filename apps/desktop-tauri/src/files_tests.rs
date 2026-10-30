use super::*;
use std::path::{Path, PathBuf};

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("abito-files-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn n8n_url_is_https_or_loopback_http_without_credentials() {
    for good in ["https://n8n.example.com", "https://n8n.example.com:5678/home", "http://localhost:5678",
        "http://127.0.0.1:5678/", "http://[::1]:5678"] {
        assert!(n8n_url(good).is_some(), "{good}");
    }
    for bad in ["", "http://n8n.example.com", "http://192.168.1.5:5678", "ftp://x.test", "file:///etc/passwd",
        "javascript:alert(1)", "https://user:pw@n8n.example.com", "https://x.test/a b", "https://x.test/\n",
        "not a url", "n8n.example.com", "http://localhost.evil.test"] {
        assert!(n8n_url(bad).is_none(), "{bad:?}");
    }
}

#[test]
fn find_on_path_takes_only_absolute_directories_and_executable_files() {
    let a = scratch("path-a");
    let b = scratch("path-b");
    let bin = b.join("code");
    std::fs::write(&bin, b"#!/bin/sh\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        // A non-executable look-alike earlier on the path is skipped.
        std::fs::write(a.join("code"), b"x").unwrap();
    }
    let path = std::env::join_paths([Path::new("relative/dir"), a.as_path(), b.as_path()]).unwrap();
    #[cfg(unix)]
    assert_eq!(find_on_path_in("code", &path), Some(bin));
    assert_eq!(find_on_path_in("definitely-not-here", &path), None);
    assert_eq!(find_on_path_in("../code", &path), None);
    assert_eq!(find_on_path_in("", &path), None);
    let _ = std::fs::remove_dir_all(&a);
    let _ = std::fs::remove_dir_all(&b);
}
