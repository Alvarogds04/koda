//! The rules the GNOME extension's capture must obey (S8): what Koda will read back from it and
//! what the extension must declare. The D-Bus contract itself is in tests/windowcapture_gnome.rs.
use super::*;
use std::os::unix::fs::PermissionsExt;

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("koda-gnome-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("a scratch directory");
    dir
}

fn png_of(width: u32, height: u32, rgb: [u8; 3]) -> Vec<u8> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(&rgb.repeat((width * height) as usize)).unwrap();
    }
    out
}

#[test]
fn a_capture_from_outside_the_private_directory_is_never_read() {
    let root = scratch("outside");
    let dir = root.join(DIR_NAME);
    std::fs::create_dir(&dir).unwrap();
    let elsewhere = root.join("someone-elses.png");
    std::fs::write(&elsewhere, png_of(2, 1, [1, 2, 3])).unwrap();
    let error = read_private_png(&dir, &elsewhere, MAX_PNG_BYTES).unwrap_err();
    assert!(matches!(&error, CaptureError::Failed(why) if why.contains("outside the private")), "{error:?}");
    assert!(elsewhere.exists(), "a file Koda was not handed by its own extension is never touched");
    // `..` does not climb out of the check either.
    let climbing = dir.join("../someone-elses.png");
    assert!(read_private_png(&dir, &climbing, MAX_PNG_BYTES).is_err(), "{climbing:?}");
    // A bare relative name is refused: the extension always answers an absolute path.
    assert!(read_private_png(&dir, Path::new("shot.png"), MAX_PNG_BYTES).is_err());
}

#[test]
fn a_symlink_is_never_followed() {
    let root = scratch("symlink");
    let dir = root.join(DIR_NAME);
    std::fs::create_dir(&dir).unwrap();
    let real = root.join("real.png");
    std::fs::write(&real, png_of(2, 1, [1, 2, 3])).unwrap();
    let link = dir.join("link.png");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let error = read_private_png(&dir, &link, MAX_PNG_BYTES).unwrap_err();
    assert!(matches!(&error, CaptureError::Failed(why) if why.contains("will not read")), "{error:?}");
    assert!(real.exists() && link.symlink_metadata().unwrap().file_type().is_symlink());
}

#[test]
fn a_capture_that_is_not_a_png_is_refused() {
    let root = scratch("notpng");
    let dir = root.join(DIR_NAME);
    std::fs::create_dir(&dir).unwrap();
    let file = dir.join("window.png");
    std::fs::write(&file, b"<html>not a screenshot</html>").unwrap();
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
    let error = read_private_png(&dir, &file, MAX_PNG_BYTES).unwrap_err();
    assert!(matches!(&error, CaptureError::Failed(why) if why.contains("not a PNG")), "{error:?}");
}

#[test]
fn an_oversized_capture_is_refused() {
    let root = scratch("oversize");
    let dir = root.join(DIR_NAME);
    std::fs::create_dir(&dir).unwrap();
    let file = dir.join("window.png");
    let mut bytes = png_of(8, 8, [9, 9, 9]);
    bytes.resize(4096, 0);
    std::fs::write(&file, &bytes).unwrap();
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
    let error = read_private_png(&dir, &file, 1024).unwrap_err();
    assert!(matches!(&error, CaptureError::Failed(why) if why.contains("too large")), "{error:?}");
    assert!(read_private_png(&dir, &file, MAX_PNG_BYTES).is_ok(), "the same file under the cap is fine");
}

#[test]
fn a_capture_other_users_can_read_is_refused() {
    let root = scratch("mode");
    let dir = root.join(DIR_NAME);
    std::fs::create_dir(&dir).unwrap();
    let file = dir.join("window.png");
    std::fs::write(&file, png_of(2, 1, [4, 5, 6])).unwrap();
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
    let error = read_private_png(&dir, &file, MAX_PNG_BYTES).unwrap_err();
    assert!(matches!(&error, CaptureError::Failed(why) if why.contains("other users")), "{error:?}");
    // 0600 is what the extension writes, and it is read.
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert!(read_private_png(&dir, &file, MAX_PNG_BYTES).is_ok());
}

#[test]
fn the_private_directory_lives_under_the_runtime_directory_and_nowhere_else() {
    assert_eq!(private_dir(Some("/run/user/1000")), Ok(PathBuf::from("/run/user/1000").join(DIR_NAME)));
    assert_eq!(private_dir(Some("/run/user/1000/")), Ok(PathBuf::from("/run/user/1000").join(DIR_NAME)));
    // A world-readable or shared place (a temp dir, an empty answer) is not a private directory.
    assert!(matches!(private_dir(Some("")), Err(CaptureError::Unsupported(_))));
    assert!(matches!(private_dir(Some("/tmp")), Err(CaptureError::Unsupported(_))));
}

#[test]
fn a_png_becomes_rgba_pixels() {
    let rgb = decode_png(&png_of(2, 2, [10, 20, 30])).unwrap();
    assert_eq!((rgb.width, rgb.height, rgb.bgra), (2, 2, false));
    assert_eq!(rgb.data.len(), 2 * 2 * 4);
    assert_eq!(&rgb.data[..4], &[10, 20, 30, 255], "RGB is widened with an opaque alpha");

    let mut rgba = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut rgba, 1, 1);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(&[1, 2, 3, 4]).unwrap();
    }
    let decoded = decode_png(&rgba).unwrap();
    assert_eq!(&decoded.data[..], &[1, 2, 3, 4], "RGBA is passed through");

    // A 16-bit or palette image is not what the compositor hands over: refused, never guessed.
    let mut deep = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut deep, 1, 1);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Sixteen);
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(&[0, 1, 0, 2, 0, 3]).unwrap();
    }
    assert!(matches!(decode_png(&deep), Err(CaptureError::Unsupported(_))));
    assert!(matches!(decode_png(b"not a png at all"), Err(CaptureError::Failed(_))));
}

#[test]
fn the_extension_declares_the_capture_methods_the_client_calls() {
    let ext = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/gnome-extension/abito-context@abito/extension.js")).unwrap();
    // Register: Koda's own per-launch token, bound to the connection that registered it.
    assert!(ext.contains("<method name=\"Register\">"), "the registration method exists");
    assert!(ext.contains("import {TokenGate} from './token.js';"), "the token gate is its own module");
    // PickWindow: the token in, then the window Koda is asked about as an opaque id plus what the
    // model is told. Picking is gated too: it reveals the app and the title of the window.
    assert!(ext.contains("<method name=\"PickWindow\">"), "the picking method exists");
    assert!(ext.contains("type=\"s\" direction=\"in\" name=\"token\""), "picking needs the token");
    assert!(ext.contains("type=\"t\" direction=\"out\" name=\"id\""), "the id is an opaque uint64");
    assert!(ext.contains("type=\"s\" direction=\"out\" name=\"app_id\""));
    assert!(ext.contains("type=\"s\" direction=\"out\" name=\"title\""));
    // CaptureWindow: one id and the token in, a private file path out.
    assert!(ext.contains("<method name=\"CaptureWindow\">"), "the capture method exists");
    assert!(ext.contains("type=\"t\" direction=\"in\" name=\"id\""));
    assert!(ext.contains("type=\"s\" direction=\"out\" name=\"path\""));
    // No caller sniffing survives: a process named «koda» without the token is refused, and an
    // unreadable command line is no longer a reason to trust anybody.
    for gone in ["KODA_PROCESS_NAMES", "/proc/", "cmdline", "_callerIsKoda"] {
        assert!(!ext.contains(gone), "{gone} is gone: only the token identifies the caller");
    }
    assert!(ext.contains("org.abito.Context.NotAllowed"), "an unregistered caller is refused by name");
    // The methods that were already there are untouched.
    for kept in ["GetRecentWindows", "GetWindowAt", "ActivateByPid"] {
        assert!(ext.contains(kept), "{kept} is still there");
    }
    // Never world-readable, never anywhere else, never a shell.
    assert!(ext.contains("koda-capture"), "the private directory is named");
    assert!(ext.contains("FileCreateFlags.PRIVATE"), "the file is created private");
    assert!(ext.contains("0o700") || ext.contains("0o600"), "the modes are explicit");
    assert!(!ext.contains("eval(") && !ext.contains("spawn"), "no code or process execution");
    // Full-window paint through the compositor API GNOME 45-50 ships.
    assert!(ext.contains("paint_to_content"), "the window actor is painted");
    assert!(ext.contains("composite_to_stream"), "the shell encodes the PNG");
    let meta: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/gnome-extension/abito-context@abito/metadata.json")).unwrap()).unwrap();
    assert_eq!(meta["version"], 4, "a changed contract is a new extension version");
}

/// The token gate is plain JavaScript with no GNOME imports, so node can run it here: the exact
/// rules the extension relies on, checked without a Shell. A missing node is a loud failure, never
/// a silent skip.
#[test]
fn the_token_gate_admits_only_the_token_it_bound_once() {
    let module = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("gnome-extension/abito-context@abito/token.js");
    let source = std::fs::read_to_string(&module).unwrap_or_else(|e| panic!("{} must exist: {e}", module.display()));
    assert!(!source.contains("gi://"), "the gate is pure JavaScript: no GNOME imports");
    let script = r#"
import {pathToFileURL} from 'node:url';
const {TokenGate} = await import(pathToFileURL(process.argv[1]).href);
const gate = new TokenGate();
const long = n => 'a'.repeat(n);
const answers = {};
answers.nothingBoundRefused = gate.check(long(64)) === false;
answers.noTokenRefused = gate.check() === false;
answers.nullTokenRefused = gate.check(null) === false;
answers.numberTokenRefused = gate.check(1234) === false;
answers.emptyTokenRefused = gate.check('') === false;
answers.shortTokenNotRegistered = gate.register(long(31), ':1.4') === false;
answers.nonStringNotRegistered = gate.register(1234, ':1.4') === false;
answers.emptyTokenNotRegistered = gate.register('', ':1.4') === false;
answers.noOwnerNotRegistered = gate.register(long(64), '') === false;
answers.firstRegistrationAccepted = gate.register(long(64), ':1.7') === true;
answers.wrongTokenRefused = gate.check('b'.repeat(64)) === false;
answers.sameLengthWrongTokenRefused = gate.check('a'.repeat(63) + 'b') === false;
answers.longerTokenRefused = gate.check(long(65)) === false;
answers.shorterTokenRefused = gate.check(long(63)) === false;
answers.secondRegistrationRefused = gate.register('c'.repeat(64), ':1.8') === false;
answers.otherTokenRefusedWhileBound = gate.check('c'.repeat(64)) === false;
gate.release(':1.9');
answers.releaseByAnotherOwnerChangesNothing = gate.check(long(64)) === true;
answers.rightTokenAccepted = gate.check(long(64)) === true;
gate.release(':1.7');
answers.releasedTokenRefused = gate.check(long(64)) === false;
answers.afterReleaseANewRegistrationWorks = gate.register('d'.repeat(64), ':1.10') === true;
answers.newTokenAccepted = gate.check('d'.repeat(64)) === true;
answers.previousTokenRefusedAfterTheNewRegistration = gate.check(long(64)) === false;
console.log(JSON.stringify(answers));
"#;
    let output = std::process::Command::new("node")
        .args(["--input-type=module", "-e", script, module.to_str().expect("a UTF-8 module path")])
        .output()
        .unwrap_or_else(|e| panic!("node is required to check the extension's token gate (no skip): {e}"));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "node could not load {}: {stderr}", module.display());
    let stdout = String::from_utf8_lossy(&output.stdout);
    let answers: serde_json::Value = serde_json::from_str(stdout.trim()).unwrap_or_else(|e| panic!("the gate answered nothing usable ({e}): {stdout}{stderr}"));
    for rule in [
        "nothingBoundRefused",
        "noTokenRefused",
        "nullTokenRefused",
        "numberTokenRefused",
        "emptyTokenRefused",
        "shortTokenNotRegistered",
        "nonStringNotRegistered",
        "emptyTokenNotRegistered",
        "noOwnerNotRegistered",
        "firstRegistrationAccepted",
        "wrongTokenRefused",
        "sameLengthWrongTokenRefused",
        "longerTokenRefused",
        "shorterTokenRefused",
        "secondRegistrationRefused",
        "otherTokenRefusedWhileBound",
        "releaseByAnotherOwnerChangesNothing",
        "rightTokenAccepted",
        "releasedTokenRefused",
        "afterReleaseANewRegistrationWorks",
        "newTokenAccepted",
        "previousTokenRefusedAfterTheNewRegistration",
    ] {
        assert_eq!(answers[rule], serde_json::Value::Bool(true), "{rule}: {stdout}{stderr}");
    }
}

#[test]
fn a_path_that_is_not_a_regular_file_or_is_empty_is_refused() {
    let root = scratch("shape");
    let dir = root.join(DIR_NAME);
    std::fs::create_dir(&dir).unwrap();
    // A directory called like a capture: nothing to read, and reading it is not an image.
    let as_dir = dir.join("window.png");
    std::fs::create_dir(&as_dir).unwrap();
    let error = read_private_png(&dir, &as_dir, MAX_PNG_BYTES).unwrap_err();
    assert!(matches!(&error, CaptureError::Failed(why) if why.contains("not a regular file")), "{error:?}");
    // A FIFO would block a reader forever; it is not a regular file either.
    let empty = dir.join("empty.png");
    std::fs::write(&empty, b"").unwrap();
    std::fs::set_permissions(&empty, std::fs::Permissions::from_mode(0o600)).unwrap();
    let error = read_private_png(&dir, &empty, MAX_PNG_BYTES).unwrap_err();
    assert!(matches!(&error, CaptureError::Failed(why) if why.contains("empty")), "{error:?}");
    // And a capture in a directory that does not exist is a clean failure, never a panic.
    let missing = root.join("nowhere").join("window.png");
    assert!(read_private_png(&dir, &missing, MAX_PNG_BYTES).is_err());
}

// M1: a capture the validator refuses is still the extension's private file: it is always deleted.
#[test]
fn a_refused_capture_is_deleted_and_never_left_in_the_runtime_directory() {
    let dir = scratch("m1-refused");
    let bad = dir.join("not-a-png");
    std::fs::write(&bad, b"hello, not a png").unwrap();
    std::fs::set_permissions(&bad, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert!(read_and_discard(&dir, &bad, 1 << 20).is_err());
    assert!(!bad.exists(), "the refused file must be gone");
}

#[test]
fn an_accepted_capture_is_deleted_after_it_is_read() {
    let dir = scratch("m1-accepted");
    let good = dir.join("shot.png");
    std::fs::write(&good, png_of(2, 2, [1, 2, 3])).unwrap();
    std::fs::set_permissions(&good, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert!(read_and_discard(&dir, &good, 1 << 20).is_ok());
    assert!(!good.exists());
}

#[test]
fn a_path_outside_the_private_directory_is_refused_and_never_deleted() {
    let dir = scratch("m1-dir");
    let other = scratch("m1-other");
    let outside = other.join("precious");
    std::fs::write(&outside, b"mine").unwrap();
    assert!(read_and_discard(&dir, &outside, 1 << 20).is_err());
    assert!(outside.exists(), "a file the extension did not own is never ours to delete");
}

#[test]
fn a_symlink_in_the_directory_is_removed_without_touching_its_target() {
    let dir = scratch("m1-link-dir");
    let other = scratch("m1-link-target");
    let target = other.join("precious");
    std::fs::write(&target, b"mine").unwrap();
    let link = dir.join("link.png");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    assert!(read_and_discard(&dir, &link, 1 << 20).is_err());
    assert!(link.symlink_metadata().is_err(), "the planted link is removed");
    assert!(target.exists(), "its target is never touched");
}

/// One token per launch, always: made in memory, never written anywhere, and what the extension is
/// given - so two launches of Koda never share it, and restarting Koda is a new token.
#[test]
fn the_launch_token_is_one_random_64_hex_token_per_launch() {
    let first = launch_token();
    assert_eq!(first, launch_token(), "the same launch keeps the same token");
    assert_eq!(first.len(), 64, "32 random bytes, hex encoded: {first}");
    assert!(first.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)), "hex only: {first}");
    // The fixed test token is published in this source: it must never be the launch's own.
    assert_ne!(first, TEST_TOKEN, "the test token is not the launch token");
    assert_eq!(TEST_TOKEN.len(), 64, "the test token is a real-shaped token");
}
