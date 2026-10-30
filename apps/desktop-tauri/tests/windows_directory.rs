#![cfg(windows)]
//! Real ACL coverage for the shared daemon/receiver directory boundary.
use abito_island::{transport::{self, TransportOptions}, winipc};
use std::path::{Path, PathBuf};
use windows_sys::Win32::{
    Foundation::LocalFree,
    Security::{Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, ConvertSecurityDescriptorToStringSecurityDescriptorW, ConvertSidToStringSidW, GetNamedSecurityInfoW, SE_FILE_OBJECT, SDDL_REVISION_1}, DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES},
    Storage::FileSystem::CreateDirectoryW,
};
fn wide(text: &str) -> Vec<u16> { text.encode_utf16().chain(Some(0)).collect() }
fn create_with_sddl(path: &Path, sddl: &str) {
    let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    assert_ne!(unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(wide(sddl).as_ptr(), SDDL_REVISION_1, &mut sd, std::ptr::null_mut()) }, 0);
    let attributes = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: sd, bInheritHandle: 0 };
    let ok = unsafe { CreateDirectoryW(wide(&path.to_string_lossy()).as_ptr(), &attributes) };
    let error = std::io::Error::last_os_error();
    unsafe { LocalFree(sd.cast()); }
    assert_ne!(ok, 0, "create fixture: {error}");
}
fn sddl(path: &Path) -> String {
    let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    let flags = OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
    let mut owner = std::ptr::null_mut();
    assert_eq!(unsafe { GetNamedSecurityInfoW(wide(&path.to_string_lossy()).as_ptr(), SE_FILE_OBJECT, flags, &mut owner, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), &mut sd) }, 0);
    let mut owner_text = std::ptr::null_mut();
    assert_ne!(unsafe { ConvertSidToStringSidW(owner, &mut owner_text) }, 0);
    let mut owner_len = 0;
    while unsafe { *owner_text.add(owner_len) } != 0 { owner_len += 1; }
    let owner_sid = String::from_utf16(unsafe { std::slice::from_raw_parts(owner_text, owner_len) }).unwrap();
    unsafe { LocalFree(owner_text.cast()); }
    let mut text = std::ptr::null_mut();
    let ok = unsafe { ConvertSecurityDescriptorToStringSecurityDescriptorW(sd, SDDL_REVISION_1, flags, &mut text, std::ptr::null_mut()) };
    unsafe { LocalFree(sd.cast()); }
    assert_ne!(ok, 0);
    let mut len = 0;
    while unsafe { *text.add(len) } != 0 { len += 1; }
    let result = String::from_utf16(unsafe { std::slice::from_raw_parts(text, len) }).unwrap();
    unsafe { LocalFree(text.cast()); }
    format!("owner={owner_sid};{result}")
}
struct Fixture(PathBuf);
impl Fixture {
    fn new(tag: &str) -> Self {
        let root = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("{tag}-{}-{}", std::process::id(), winipc::ffi::random_instance_hex().unwrap()));
        std::fs::create_dir_all(&root).unwrap();
        let sid = winipc::ffi::current_user_sid().unwrap();
        winipc::ffi::set_owner_only_acl(&root, &sid).unwrap();
        Self(root)
    }
}
impl Drop for Fixture { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
#[test]
fn runner_acl_is_accepted_without_rewriting_existing_directory() {
    let fixture = Fixture::new("runner-acl");
    let root = fixture.0.join("runtime");
    let sid = winipc::ffi::current_user_sid().unwrap();
    create_with_sddl(&root, &format!("O:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;{sid})"));
    let before = sddl(&root);
    assert!(winipc::ffi::directory_private(&root, &sid, false), "daemon directory policy");
    let receiver = transport::create_transport(TransportOptions::new(&root, "acl-test")).expect("receiver shares daemon policy");
    receiver.close().unwrap();
    assert_eq!(sddl(&root), before, "existing ACL must not be rewritten");
}
#[test]
fn users_read_and_null_dacl_are_refused_by_daemon_and_receiver_without_writes() {
    let fixture = Fixture::new("unsafe-acl");
    let sid = winipc::ffi::current_user_sid().unwrap();
    for (name, descriptor) in [
        ("users", format!("O:{sid}D:P(A;;FA;;;{sid})(A;;FR;;;BU)")),
        ("null", format!("O:{sid}D:NO_ACCESS_CONTROL")),
    ] {
        let root = fixture.0.join(name);
        create_with_sddl(&root, &descriptor);
        let before = sddl(&root);
        assert!(!winipc::ffi::directory_private(&root, &sid, false), "daemon must reject {name}");
        assert!(!winipc::ffi::directory_private(&root, &sid, true), "strict metadata policy must reject {name}");
        assert!(transport::create_transport(TransportOptions::new(&root, "acl-test")).is_err(), "receiver must reject {name}");
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
        assert_eq!(sddl(&root), before, "rejected ACL must not be rewritten");
    }
}
#[test]
fn newly_created_directories_are_protected_user_and_system_only() {
    let fixture = Fixture::new("new-private");
    let sid = winipc::ffi::current_user_sid().unwrap();
    let abito = fixture.0.join("Abito");
    for leaf in ["notices", "runtime"] {
        let target = abito.join(leaf);
        winipc::ffi::prepare_runtime(&target, &sid).expect("atomic private creation");
        for dir in [&abito, &target] {
            assert!(winipc::ffi::directory_private(dir, &sid, false));
            let descriptor = sddl(dir);
            assert!(descriptor.starts_with(&format!("owner={sid};")), "{descriptor}");
            assert!(descriptor.contains("D:P"), "protected: {descriptor}");
            assert!(descriptor.contains(";;;SY)"), "SYSTEM: {descriptor}");
            assert!(!descriptor.contains(";;;BA)"), "no administrators ACE added: {descriptor}");
        }
    }
}
#[test]
fn broad_profile_ancestor_is_not_rewritten_and_child_is_private() {
    let fixture = Fixture::new("profile-ancestor");
    let sid = winipc::ffi::current_user_sid().unwrap();
    let parent = fixture.0.join("profile");
    create_with_sddl(&parent, &format!("O:{sid}D:P(A;OICI;FA;;;{sid})(A;OICI;FR;;;BU)"));
    let before = sddl(&parent);
    assert!(!winipc::ffi::directory_private(&parent, &sid, false));
    let target = parent.join("private-child");
    winipc::ffi::prepare_runtime(&target, &sid).expect("profile ACL does not prevent private child creation");
    assert_eq!(sddl(&parent), before);
    assert!(winipc::ffi::directory_private(&target, &sid, false));
    assert!(!sddl(&target).contains(";;;BU)"));
    let receiver = transport::create_transport(TransportOptions::new(&target, "acl-test")).unwrap();
    receiver.close().unwrap();
}

#[test]
fn junction_ancestors_are_refused_without_touching_target() {
    let fixture = Fixture::new("junction");
    let sid = winipc::ffi::current_user_sid().unwrap();
    let real = fixture.0.join("real");
    winipc::ffi::prepare_runtime(&real, &sid).unwrap();
    let link = fixture.0.join("link");
    let output = std::process::Command::new("cmd.exe").args(["/C", "mklink", "/J"]).arg(&link).arg(&real).output().unwrap();
    assert!(output.status.success());
    assert!(!winipc::ffi::directory_private(&link, &sid, false));
    assert!(winipc::ffi::prepare_runtime(&link.join("notices"), &sid).is_err());
    assert_eq!(std::fs::read_dir(&real).unwrap().count(), 0);
    std::fs::remove_dir(&link).unwrap();
}
