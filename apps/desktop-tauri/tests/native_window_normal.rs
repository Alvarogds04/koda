//! Real NORMAL executable regression, deliberately opt-in; never sends input.
#![cfg(target_os = "linux")]
use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use x11rb::{
    connection::Connection,
    protocol::xproto::{AtomEnum, ConnectionExt},
    rust_connection::RustConnection,
};

fn private_dir(path: &Path) {
    if !path.exists() {
        fs::DirBuilder::new().mode(0o700).create(path).unwrap();
    }
    let m = fs::symlink_metadata(path).unwrap();
    assert!(m.is_dir() && !m.file_type().is_symlink());
    assert_eq!(m.mode() & 0o7777, 0o700, "private artifact root");
    assert_eq!(m.uid(), unsafe { libc::getuid() });
}
fn private_file(path: &Path) -> File {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .unwrap()
}

struct OwnProcess(Child, PathBuf);
impl OwnProcess {
    fn stop(&mut self) {
        if self.0.try_wait().ok().flatten().is_some() {
            return;
        }
        // PID + executable identity before signalling only this child.
        let exe =
            fs::read_link(format!("/proc/{}/exe", self.0.id())).expect("own executable identity");
        assert_eq!(exe, self.1, "refuse cleanup of an unexpected executable");
        unsafe {
            libc::kill(self.0.id() as i32, libc::SIGTERM);
        }
        let until = Instant::now() + Duration::from_secs(5);
        while Instant::now() < until {
            if self.0.try_wait().ok().flatten().is_some() {
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
impl Drop for OwnProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

fn preflight() {
    let ps = Command::new("ps")
        .args(["-C", "abito-island", "-o", "pid=,comm="])
        .output()
        .expect("ps");
    assert!(ps.status.code() == Some(0) || ps.status.code() == Some(1));
    assert!(
        ps.stdout.is_empty(),
        "STOP: abito-island already running; no launch permitted"
    );
    let bus = Command::new("dbus-send")
        .args([
            "--session",
            "--print-reply",
            "--dest=org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus.NameHasOwner",
            "string:com.abitog.AbitoTauri.SingleInstance",
        ])
        .output()
        .expect("DBus preflight");
    assert!(bus.status.success());
    assert!(
        String::from_utf8_lossy(&bus.stdout).contains("boolean false"),
        "STOP: single-instance name owned"
    );
}

fn own_window(conn: &RustConnection, root: u32, pid: u32) -> Option<u32> {
    let clients = conn
        .intern_atom(false, b"_NET_CLIENT_LIST")
        .ok()?
        .reply()
        .ok()?
        .atom;
    let pid_atom = conn
        .intern_atom(false, b"_NET_WM_PID")
        .ok()?
        .reply()
        .ok()?
        .atom;
    let reply = conn
        .get_property(false, root, clients, AtomEnum::WINDOW, 0, 4096)
        .ok()?
        .reply()
        .ok()?;
    let own: Vec<_> = reply
        .value32()?
        .filter(|id| {
            conn.get_property(false, *id, pid_atom, AtomEnum::CARDINAL, 0, 1)
                .ok()
                .and_then(|c| c.reply().ok())
                .and_then(|r| r.value32().and_then(|mut v| v.next()))
                == Some(pid)
        })
        .collect();
    assert!(own.len() <= 1, "ambiguous own PID windows");
    own.first().copied()
}
fn number(output: &str, label: &str) -> i32 {
    output
        .lines()
        .find_map(|line| {
            line.trim()
                .strip_prefix(label)
                .and_then(|v| v.trim().parse().ok())
        })
        .expect("xwininfo numeric field")
}

// The native contract is LOGICAL: one 672x340 window for compact, overview and chat.
// Physical scale varies between sessions: real GTK/Tauri factors 2 and 1
// were observed, without attributing the difference to an environment cause.
// Use this run's SDK scale, never fixed physical dimensions. NOAUDIT is a
// separate observer-off check whose factor must come from the same environment's
// preceding SDK audit; ABITO_NATIVE_EXPECT_SCALE does not change GTK scaling.
#[test]
#[ignore = "real display + NORMAL executable; ABITO_NATIVE_NORMAL_TEST=1 opts in"]
fn normal_compact_matches_actual_runtime_scale() {
    assert_eq!(
        std::env::var("ABITO_NATIVE_NORMAL_TEST").as_deref(),
        Ok("1")
    );
    let no_audit = std::env::var("ABITO_NATIVE_NORMAL_NOAUDIT").as_deref() == Ok("1");
    let crate_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let runtime = crate_dir.join(".runtime-probe");
    private_dir(&runtime);
    // Constructor source: transport.rs mkdtemp => p- + SIX alphanumerics,
    // then create_transport appends /s. Check bytes with terminating NUL.
    let endpoint_bytes = runtime.as_os_str().as_encoded_bytes().len() + 1 + 8 + 2;
    assert!(
        endpoint_bytes < 108,
        "AF_UNIX endpoint requires {endpoint_bytes} bytes plus NUL"
    );
    let audit = runtime.join("native-audit");
    private_dir(&audit);
    let run = audit.join(format!(
        "normal-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    private_dir(&run);
    for dir in ["home", "config", "cache", "data"] {
        private_dir(&run.join(dir));
    }
    // Corrupt private selection fails closed to Target=None; chat view must
    // never check a real model or submit a prompt in this fixture.
    writeln!(
        private_file(&run.join("config/models-selection.json")),
        "invalid"
    )
    .unwrap();
    let log_path = run.join("native.jsonl");
    let mut log = private_file(&log_path);
    let mut command = Command::new(env!("CARGO_BIN_EXE_abito-island"));
    command.env_clear();
    for name in [
        "DISPLAY",
        "XAUTHORITY",
        "DBUS_SESSION_BUS_ADDRESS",
        "XDG_RUNTIME_DIR",
        "PATH",
    ] {
        if let Some(v) = std::env::var_os(name) {
            command.env(name, v);
        }
    }
    command
        .env("GDK_BACKEND", "x11")
        .env("ABITO_SOCKET_DIR", &runtime)
        .env("ABITO_MODELS_CONFIG_DIR", run.join("config"))
        .env("HOME", run.join("home"))
        .env("XDG_CONFIG_HOME", run.join("config"))
        .env("XDG_CACHE_HOME", run.join("cache"))
        .env("XDG_DATA_HOME", run.join("data"))
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    if !no_audit {
        command
            .env("ABITO_NATIVE_AUDIT", "1")
            .env("ABITO_NATIVE_VIEW_TEST", "1");
    }
    // No ABITO_PROBE, --probe, scale overrides, login or valid model selection.
    unsafe {
        command.pre_exec(|| {
            libc::umask(0o077);
            Ok(())
        });
    }
    let previous: std::collections::HashSet<_> = fs::read_dir(&runtime)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    preflight(); // immediately before EVERY own launch
    let mut child = OwnProcess(
        command.spawn().expect("NORMAL executable"),
        fs::canonicalize(env!("CARGO_BIN_EXE_abito-island")).unwrap(),
    );
    let pid = child.0.id();
    let stderr = child.0.stderr.take().unwrap();
    let reader = thread::spawn(move || {
        let mut rows = Vec::new();
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if let Some(payload) = line.strip_prefix("ABITO_NATIVE_AUDIT ") {
                let row: Value = serde_json::from_str(payload).expect("audit JSON");
                writeln!(log, "{row}").unwrap();
                log.flush().unwrap();
                rows.push(row);
            }
        }
        rows
    });
    let (conn, screen) = x11rb::connect(None).expect("X11");
    let root = conn.setup().roots[screen].root;
    let started = Instant::now();
    let deadline = started + Duration::from_secs(if no_audit { 4 } else { 15 });
    let mut id = None;
    let mut endpoint = None;
    let mut socket_identity = None;
    let mut samples = Vec::new();
    let states_atom = conn
        .intern_atom(false, b"_NET_WM_STATE")
        .unwrap()
        .reply()
        .unwrap()
        .atom;
    let focused_atom = conn
        .intern_atom(false, b"_NET_WM_STATE_FOCUSED")
        .unwrap()
        .reply()
        .unwrap()
        .atom;
    let mut focused = false;
    while Instant::now() < deadline {
        assert!(
            child.0.try_wait().unwrap().is_none(),
            "NORMAL exited before settling"
        );
        id = own_window(&conn, root, pid).or(id);
        if endpoint.is_none() {
            // Never inspect prior fixture directories. Audit read-back below
            // must prove this NEW inode is the receiver held by our own PID.
            for entry in fs::read_dir(&runtime).unwrap().flatten() {
                let name = entry.file_name();
                if previous.contains(&name) || !name.to_string_lossy().starts_with("p-") {
                    continue;
                }
                let path = entry.path();
                private_dir(&path);
                let socket = path.join("s");
                if let Ok(m) = fs::symlink_metadata(&socket) {
                    use std::os::unix::fs::FileTypeExt;
                    assert!(m.file_type().is_socket());
                    assert_eq!(m.uid(), unsafe { libc::getuid() });
                    assert_eq!(m.mode() & 0o7777, 0o600);
                    assert!(endpoint.is_none(), "multiple new socket leaves");
                    socket_identity = Some([m.dev(), m.ino()]);
                    endpoint = Some(socket);
                }
            }
        }
        if let Some(id) = id {
            let g = conn.get_geometry(id).unwrap().reply().unwrap();
            samples.push([
                started.elapsed().as_millis() as u32,
                g.width as u32,
                g.height as u32,
            ]);
            let states = conn
                .get_property(false, id, states_atom, AtomEnum::ATOM, 0, 64)
                .unwrap()
                .reply()
                .unwrap();
            focused |= states.value32().unwrap().any(|a| a == focused_atom);
        }
        thread::sleep(Duration::from_millis(300));
    }
    let id = id.expect("own _NET_WM_PID window");
    let xwin = Command::new("xwininfo")
        .args(["-id", &format!("0x{id:x}")])
        .output()
        .expect("xwininfo own window");
    assert!(xwin.status.success());
    let raw = String::from_utf8(xwin.stdout).unwrap();
    let actual = [number(&raw, "Width:"), number(&raw, "Height:")];
    let position = [
        number(&raw, "Absolute upper-left X:"),
        number(&raw, "Absolute upper-left Y:"),
    ];
    let workarea_atom = conn
        .intern_atom(false, b"_NET_WORKAREA")
        .unwrap()
        .reply()
        .unwrap()
        .atom;
    let root_area = conn
        .get_property(false, root, workarea_atom, AtomEnum::CARDINAL, 0, 4)
        .unwrap()
        .reply()
        .unwrap();
    let root_area: Vec<u32> = root_area.value32().unwrap().collect();
    if no_audit {
        use x11rb::protocol::xproto::{ImageFormat, ImageOrder};
        let image = conn
            .get_image(
                ImageFormat::Z_PIXMAP,
                id,
                0,
                0,
                actual[0] as u16,
                actual[1] as u16,
                u32::MAX,
            )
            .unwrap()
            .reply()
            .unwrap();
        assert_eq!(conn.setup().image_byte_order, ImageOrder::LSB_FIRST);
        let format = conn
            .setup()
            .pixmap_formats
            .iter()
            .find(|f| f.depth == image.depth)
            .unwrap();
        assert_eq!(format.bits_per_pixel, 32);
        // RGB of OWN drawable only, uncomposited: this is NOT alpha evidence.
        let rgb: Vec<u8> = image
            .data
            .chunks_exact(4)
            .flat_map(|p| [p[2], p[1], p[0]])
            .collect();
        let png = run.join("normal-noaudit-rgb.png");
        let _ = private_file(&png);
        gtk::gdk_pixbuf::Pixbuf::from_mut_slice(
            rgb,
            gtk::gdk_pixbuf::Colorspace::Rgb,
            false,
            8,
            actual[0],
            actual[1],
            actual[0] * 3,
        )
        .savev(&png, "png", &[])
        .unwrap();
    }
    child.stop();
    let rows = reader.join().expect("audit reader");
    preflight(); // also proves process/name cleanup
    let row = rows
        .iter()
        .rev()
        .find(|r| r["stage"] == "timer")
        .cloned()
        .unwrap_or(Value::Null);
    let scale = if no_audit {
        assert!(
            rows.is_empty(),
            "NOAUDIT launch must have no audit flags/output"
        );
        // Expected factor comes from the preceding actual SDK/GTK audit; this
        // test expectation never sets a runtime scale environment variable.
        std::env::var("ABITO_NATIVE_EXPECT_SCALE")
            .unwrap()
            .parse::<f64>()
            .unwrap()
    } else {
        row["tauri_scale"].as_f64().expect("actual Tauri scale")
    };
    let expected = [
        (304.0 * scale).round() as i32,
        (44.0 * scale).round() as i32,
    ];
    let report = json!({"pid": pid, "window": id, "endpoint_bytes": endpoint_bytes,
        "actual": actual, "position": position, "expected": expected,
        "expected_scale": scale, "tauri_scale": row["tauri_scale"], "gtk_scale": row["gtk_scale"],
        "root_workarea": root_area, "samples": samples,
        "last_audit": row, "no_audit": no_audit, "focused": focused});
    writeln!(private_file(&run.join("contract.json")), "{report}").unwrap();
    println!(
        "NORMAL audit: {} actual={actual:?} expected={expected:?} expected_scale={scale} gtk_scale={}",
        run.display(),
        row["gtk_scale"]
    );
    assert!(!focused, "normal launch must not steal focus");
    if !no_audit {
        assert_eq!(row["pid"].as_u64(), Some(pid as u64));
        assert_eq!(
            row["initial_pin"], true,
            "normal frontend must reach initial pin"
        );
        assert_eq!(row["gtk_scale"].as_f64(), Some(scale));
        assert_eq!(row["tauri_inner"], json!(actual), "SDK vs own X11 mismatch");
        assert_eq!(
            row["socket_identity"],
            json!(socket_identity.expect("own private UDS"))
        );
        for (generation, view, logical) in [
            (0, "compact", (304, 44)),
            (1, "overview", (672, 176)),
            (2, "chat", (672, 256)), // #309/#480: the chat island, as wide as the overview; its height follows the work area (1048 logical here)
            (3, "overview", (672, 176)),
            (4, "compact", (304, 44)),
        ] {
            let scene = rows
                .iter()
                .rev()
                .find(|r| r["stage"] == "timer" && r["generation"] == generation)
                .expect("normal IPC must reach and settle every scene");
            let size = [
                (logical.0 as f64 * scale).round() as i32,
                (logical.1 as f64 * scale).round() as i32,
            ];
            assert_eq!(scene["view"], view);
            assert_eq!(scene["tauri_inner"], json!(size));
            assert_eq!(scene["x11"][3], size[0]);
            assert_eq!(scene["x11"][4], size[1]);
            assert_eq!(
                scene["widgets"][0]["request"],
                json!([logical.0, logical.1])
            );
            assert_eq!(scene["resizable"], false);
            assert!(
                samples
                    .iter()
                    .any(|s| s[1] == size[0] as u32 && s[2] == size[1] as u32),
                "external X11 scene"
            );
            println!("NORMAL scene generation={generation} view={view} physical={size:?}");
        }
    }
    let endpoint = endpoint.expect("own socket");
    assert!(!endpoint.exists(), "own socket cleanup");
    assert!(!endpoint.parent().unwrap().exists(), "own leaf cleanup");
    assert_eq!(
        actual, expected,
        "NORMAL compact native contract: logical 304x44 * actual runtime scale"
    );
}
