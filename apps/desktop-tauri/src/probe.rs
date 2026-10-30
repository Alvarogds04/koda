//! `ABITO_PROBE=1` (or `--probe`) read-back script for unit M1a.
//!
//! The probe drives the SAME core handlers the pointer commands use — press,
//! drag, release/snap, toggle — programmatically. It is NOT a real pointer:
//! every line printed here says so. After each step it waits for the window
//! manager to apply the change, then prints a JSON line with the ACTUAL
//! getters (outer_position, inner_size, scale_factor, is_always_on_top,
//! is_decorated, work area) next to the values we REQUESTED, plus frontend
//! evidence (SVG element count rendered by clay-engine, zero canvas).
//! Exits only this process.

use std::thread::sleep;
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::Emitter;
use tauri::{AppHandle, Manager};

use abito_island::core::{screen_at, ReleaseOutcome, WindowIo};
use abito_island::geometry;
use crate::{apply_plan, main_window, refresh_work_area, store_requested, AppState, TauriIo};

const NO_POINTER: &str =
    "none — the probe drives the same core handlers programmatically; no real pointer events are used";

fn emit(value: &serde_json::Value) {
    use std::io::Write;
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}

/// Wait until the WM reports the requested inner size, bounded.
fn wait_for_size(app: &AppHandle, want: (i32, i32), timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        let Some(win) = main_window(app) else { return false };
        let got = win
            .inner_size()
            .map(|s| (s.width as i32, s.height as i32))
            .unwrap_or((0, 0));
        if got == want {
            return true;
        }
        sleep(Duration::from_millis(50));
    }
    false
}

fn readback(app: &AppHandle, step: &str) {
    let Some(win) = main_window(app) else { return };
    let state = app.state::<AppState>();
    let wa = abito_island::workarea::current(&win);
    let pos = win.outer_position().ok().map(|p| (p.x, p.y));
    let size = win.inner_size().ok().map(|s| (s.width as i32, s.height as i32));
    let scale = win.scale_factor().ok();
    let always_on_top = win.is_always_on_top().ok();
    let decorated = win.is_decorated().ok();
    let (rpos, rsize, raction) = {
        let req = state.requested.lock().expect("requested lock");
        (req.pos, req.size, req.action.clone())
    };
    // Raw X11 ground truth for our own window (read-only): disambiguates the
    // Tauri getters from what the WM actually applied.
    // FIX-B: identified by _NET_WM_PID == our pid (title secondary); a
    // failure is printed as `x11_window_error`, never replaced by a guess.
    let found = abito_island::workarea::x11_find_own_window(abito_island::workarea::WINDOW_TITLE);
    let x11_error = found.as_ref().err().map(|e| e.as_str());
    let x11win = found.ok();
    let x11json = x11win.as_ref().map(|w| {
        json!({
            "id": format!("0x{:x}", w.id),
            "geometry": [w.x, w.y, w.w, w.h],
            "border": w.border,
            "gtk_frame_extents": w.frame_extents,
            "net_wm_state_above": w.wm_state_above,
            "wm_class": w.wm_class,
        })
    });
    emit(&json!({
        "step": step,
        "pointer_input": NO_POINTER,
        "actual": {
            "outer_position": pos.map(|p| [p.0, p.1]),
            "inner_size": size.map(|s| [s.0, s.1]),
            "scale_factor": scale,
            "is_always_on_top": always_on_top,
            "is_decorated": decorated,
            "work_area": [wa.rect.x, wa.rect.y, wa.rect.w, wa.rect.h],
            "work_area_source": wa.source,
            "work_area_x11_raw": wa.x11.map(|r| [r.x, r.y, r.w, r.h]),
            "work_area_monitor_raw": wa.monitor.map(|r| [r.x, r.y, r.w, r.h]),
            "x11_window": x11json,
            "x11_window_error": x11_error,
            "x11_window_match": "_NET_WM_PID == own pid, title secondary",
        },
        "requested": {
            "position": rpos.map(|p| [p.0, p.1]),
            "size": rsize.map(|s| [s.0, s.1]),
            "action": raction,
        },
        "match": {
            "position": pos.is_some() && pos == rpos,
            "size": size.is_some() && size == rsize,
        },
        // X-server truth: what mutter actually applied for our request.
        "match_x11": {
            "position": x11win.as_ref().map_or(serde_json::Value::Null, |w| {
                serde_json::Value::from(Some((w.x, w.y)) == rpos)
            }),
            "size": x11win.as_ref().map_or(serde_json::Value::Null, |w| {
                serde_json::Value::from(Some((w.w, w.h)) == rsize)
            }),
        },
    }));
}

/// Move the pointer (as a screen point) from its current position to `target`
/// in 10 simulated steps, going through `Core::drag` each time — exactly the
/// handler the webview's `drag_move` command calls.
fn simulated_drag(app: &AppHandle, area: geometry::Rect, target: (f64, f64)) {
    let state = app.state::<AppState>();
    let Some(win) = main_window(app) else { return };
    let io = TauriIo(&win);
    let scale = io.scale();
    for i in 1..=10 {
        // Interpolate screen points and convert to client coordinates. The
        // island itself stays fixed while the shared handler records travel.
        let (ox, oy) = io.outer_position();
        let start = screen_at(&io, (50.0, 20.0));
        let t = i as f64 / 10.0;
        let screen = (
            start.0 + (target.0 - start.0) * t,
            start.1 + (target.1 - start.1) * t,
        );
        let client = ((screen.0 - ox as f64) / scale, (screen.1 - oy as f64) / scale);
        let moved = {
            let mut core = state.core.lock().expect("core lock");
            core.drag(&io, area, client)
        };
        if let Some(pos) = moved {
            store_requested(&state, "drag", Some(pos), None);
        }
        sleep(Duration::from_millis(40));
    }
}

/// Bounded native verification only: real view paths, no model turn or input injection.
fn fixed_window_evidence(app: &AppHandle) {
    let state = app.state::<AppState>();
    for step in ["fixed_compact", "fixed_overview", "fixed_chat", "fixed_compact_again"] {
        match step {
            "fixed_overview" => { let _ = crate::dispatch_action(app, &state, abito_island::bridge::Action::Expand, None); }
            "fixed_chat" => crate::chathost::switch_view(app, &state, true),
            "fixed_compact_again" => { let _ = crate::dispatch_action(app, &state, abito_island::bridge::Action::Close, None); }
            _ => {}
        }
        sleep(Duration::from_secs(3));
        readback(app, step);
        state.chat_probe.lock().expect("chat probe lock").clear();
        let _ = main_window(app).map(|win| win.eval("(()=>{const r=document.getElementById('island').getBoundingClientRect();window.__TAURI__.core.invoke('record_chat_evidence',{evidence:{visible:[r.width,r.height],phase:document.getElementById('capsule').dataset.phase}});})()"));
        let lines = wait_chat_lines(app, 1, Duration::from_secs(3));
        emit(&json!({"step": step, "page_readback": lines}));
    }
}

pub fn run(app: AppHandle) {
    let launch_mode = std::env::var("ABITO_PROBE_VALIDATE").unwrap_or_default();
    if launch_mode == "island" || launch_mode.starts_with("startup-") {
        sleep(Duration::from_millis(900));
        let name = match launch_mode.as_str() {
            "startup-manual" => "ajustes-arranque-manual",
            "startup-login" => "ajustes-arranque-login",
            _ => "ajustes-arranque-apagado",
        };
        let visible = app.get_webview_window("settings").is_some_and(|w| w.is_visible().unwrap_or(false));
        let enabled = crate::settingshost::voice_prefs_snapshot(&app).open_settings_at_launch();
        let expected = launch_mode == "startup-manual";
        capture_visual(&app, name);
        emit(&json!({"step":"validation_observation","name":name,"observation":{
            "ok":visible == expected && enabled == (launch_mode != "island"),
            "visible":visible,"enabled":enabled,"expected":expected,"reason":"ventana de ajustes al arrancar"}}));
        if launch_mode.starts_with("startup-") { crate::quit_clean(&app); return; }
    }
    if std::env::var("ABITO_PROBE_VALIDATE").as_deref() == Ok("island") {
        island_validation(&app);
        crate::quit_clean(&app);
        return;
    }
    if std::env::var("ABITO_PROBE_FIXED_WINDOW").as_deref() == Ok("1") {
        sleep(Duration::from_secs(3));
        fixed_window_evidence(&app);
        crate::quit_clean(&app);
        return;
    }
    emit(&json!({
        "probe": "abito M1b geometry/state + bridge read-back",
        "pointer_input": NO_POINTER,
        "sequence": ["start", "simulated_drag_near_bottom", "release_snap_bottom", "expand", "collapse", "drag_to_top_snap", "facade_evidence", "frontend_evidence", "transport_evidence", "overview_visual_evidence", "approval_evidence", "a11y_evidence", "chat_open", "chat_evidence", "models_evidence", "chat_back_to_overview", "chat_collapse"],
        "gdk_backend": std::env::var("GDK_BACKEND").unwrap_or_else(|_| "unset".into()),
    }));

    let state = app.state::<AppState>();
    sleep(Duration::from_millis(1500));
    motion_diag(&app, "start");

    // Wait for the webview's evidence command (clay-engine rendered, no canvas).
    let mut evidence = None;
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if let Some(e) = state.evidence.lock().expect("evidence lock").clone() {
            evidence = Some(e);
            break;
        }
        sleep(Duration::from_millis(100));
    }
    sleep(Duration::from_millis(100));

    // 1. Wait for the fixed native window to settle, then read honest getters.
    let scale0 = main_window(&app).and_then(|win| win.scale_factor().ok()).unwrap_or(1.0);
    let compact = geometry::scaled_size(geometry::ISLAND_WINDOW, scale0);
    let overview = compact;
    let settled = wait_for_size(&app, compact, Duration::from_secs(6));
    if !settled {
        emit(&json!({"step": "start", "warning": "compact size did not settle within 6s"}));
    }
    sleep(Duration::from_millis(200));
    readback(&app, "start");

    // 2. simulated drag to a point near the bottom of the work area.
    let area = refresh_work_area(&app, &state);
    let Some(win) = main_window(&app) else { return };
    let io = TauriIo(&win);
    let press_client = (50.0, 20.0);
    {
        let mut core = state.core.lock().expect("core lock");
        core.press(&io, press_client);
    }
    let target = (
        area.x as f64 + area.w as f64 / 2.0,
        area.bottom() as f64 - 24.0,
    );
    simulated_drag(&app, area, target);
    sleep(Duration::from_millis(200)); // WM applies the last move
    readback(&app, "simulated_drag_near_bottom");

    // 3. A long pointer gesture cancels; it must neither move nor toggle.
    let client = {
        let (ox, oy) = io.outer_position();
        let s = io.scale();
        ((target.0 - ox as f64) / s, (target.1 - oy as f64) / s)
    };
    let outcome = {
        let mut core = state.core.lock().expect("core lock");
        core.release(&io, area, client, false)
    };
    if outcome != ReleaseOutcome::Cancelled {
        emit(&json!({"step": "release_snap_bottom", "unexpected": format!("{outcome:?}")}));
    }
    sleep(Duration::from_millis(300));
    readback(&app, "release_snap_bottom");

    // 4. Expand inside the same top-centred native window.
    let plan = {
        let mut core = state.core.lock().expect("core lock");
        core.toggle(&io, area)
    };
    apply_plan(&app, &state, plan);
    let applied = wait_for_size(&app, overview, Duration::from_secs(3));
    sleep(Duration::from_millis(200));
    readback(&app, "expand");
    if !applied {
        emit(&json!({"step": "expand", "warning": "window did not reach overview size within 3s"}));
    }

    // 5. Collapse changes the visible island and input shape only.
    let plan = {
        let mut core = state.core.lock().expect("core lock");
        core.toggle(&io, area)
    };
    apply_plan(&app, &state, plan);
    let applied = wait_for_size(&app, compact, Duration::from_secs(3));
    sleep(Duration::from_millis(200));
    readback(&app, "collapse");
    if !applied {
        emit(&json!({"step": "collapse", "warning": "window did not return to compact size within 3s"}));
    }

    // 6. Another long gesture is cancelled without native placement changes.
    let area = refresh_work_area(&app, &state);
    {
        let mut core = state.core.lock().expect("core lock");
        core.press(&io, press_client);
    }
    let target = (
        area.x as f64 + area.w as f64 / 2.0,
        area.y as f64 + 12.0,
    );
    simulated_drag(&app, area, target);
    let client = {
        let (ox, oy) = io.outer_position();
        let s = io.scale();
        ((target.0 - ox as f64) / s, (target.1 - oy as f64) / s)
    };
    let outcome = {
        let mut core = state.core.lock().expect("core lock");
        core.release(&io, area, client, false)
    };
    if outcome != ReleaseOutcome::Cancelled {
        emit(&json!({"step": "drag_to_top_snap", "unexpected": format!("{outcome:?}")}));
    }
    sleep(Duration::from_millis(300));
    readback(&app, "drag_to_top_snap");

    // 7. facade evidence: exercise `window.desktop` through the REAL webview
    //    IPC path — verbs list, one typed rejection of an invalid call, a
    //    rate-limit rejection burst, onState event delivery, and the page
    //    URL/label the command-side sender gate actually sees. The JS reports
    //    back through record_facade_evidence; nothing here is synthesised.
    if let Err(e) = win.eval(FACADE_JS) {
        emit(&json!({"step": "facade_evidence", "eval_failed": e.to_string()}));
    }
    let mut facade: Option<serde_json::Value> = None;
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if let Some(v) = state.facade.lock().expect("facade lock").clone() {
            facade = Some(v);
            break;
        }
        sleep(Duration::from_millis(100));
    }
    let mut expected_verbs: Vec<&str> = abito_island::bridge::ACTIONS.to_vec();
    expected_verbs.push("onState"); // the one facade-only subscription verb
    expected_verbs.sort_unstable();
    let expected_json = serde_json::json!(expected_verbs);
    let observed_verbs = facade.as_ref().and_then(|f| f.get("verbs")).cloned();
    // M3: `choose` must be WIRED — its rejection while no request stands is
    // the typed `denied` (Electron's `Denied`), never `not-yet-wired`.
    let choose_wired_denied = facade.as_ref()
        .and_then(|f| f.get("choose"))
        .and_then(|choice| choice.get("code"))
        == Some(&serde_json::json!("denied"));
    emit(&json!({
        "step": "facade_evidence",
        "expected_verbs": expected_json,
        "verbs_match_preload": observed_verbs.as_ref() == Some(&expected_json),
        "choose_wired_denied": choose_wired_denied,
        "timed_out": facade.is_none(),
        "evidence": facade,
    }));

    // 8. frontend evidence from the webview command.
    emit(&json!({
        "step": "frontend_evidence",
        "pointer_input": "produced by the webview itself via the record_frontend_evidence command",
        "svg_elements_rendered_by_clay_engine": evidence.as_ref().map(|e| e.svgs),
        "canvas_elements": evidence.as_ref().map(|e| e.canvases),
        "clay_revision": evidence.as_ref().map(|e| e.revision.as_str()),
        "received": evidence.is_some(),
    }));

    // 9. transport evidence (M2): the probe itself acts as the Pi producer
    //    against OUR OWN receiver (default `.runtime` or the ABITO_SOCKET_DIR
    //    override this process owns): hello → ready → ONE settled frame, then
    //    the notice count read back through the real snapshot path. The
    //    installed Preview's reserved socket roots are DETECTED read-only —
    //    never connected, never unlinked.
    transport_evidence(&app);

    // 9b. overview visual evidence (UI.1): PNGs of the overview scenes on a
    //     known background (opt-in: ABITO_PROBE_VISUAL=1). Driven through the
    //     same host paths the real lanes use; nothing here approves by itself.
    overview_visual_evidence(&app);

    // 10. approval evidence (M3): the lane already runs against the
    //     in-process fake backend (env override set at startup), so this
    //     performs the human's explicit choice and reads card/bridgeStatus
    //     back through the REAL snapshot path before and after.
    //     With ABITO_PROBE_VISUAL=1 the visual scenes already consumed the
    //     (sticky) card, so approval/a11y are skipped there: they have their
    //     own non-visual run, and this keeps the visual run reaching chat/models.
    let visual_run = std::env::var("ABITO_PROBE_VISUAL").as_deref() == Ok("1");
    if !visual_run {
        approval_evidence(&app);
    }

    // 10b. accessibility (Q1): the overview's controls measured in the
    //      webview, the notice live region, and keyboard focus: the window
    //      must NOT be focused by start or restore (no focus stealing).
    if !visual_run {
        a11y_evidence(&app);
    }

    // 11. chat (U1): overview -> chat in the SAME window (752x340 read back
    //     from the X server), one turn through the REAL `chat_action` IPC
    //     against an in-process FAKE local router (the real router and any
    //     provider are never contacted by the probe), then an unreachable
    //     target to prove the honest "unavailable" with no fallback, then
    //     back to the overview and collapse.
    if visual_run {
        notification_scenes(&app);
        hotkey_evidence(&app);
        settings_scenes(&app, &std::env::var("ABITO_PROBE_SETTINGS_TAG").unwrap_or_else(|_| "sin-motor".into()));
        column_transition_scenes(&app);
        hotkey_hide_from_views(&app);
        panel_open_timing(&app);
        native_resize_flash_scene(&app);
    }
    chat_evidence(&app);

    // Close the receiver before the hard exit: identity-checked unlink of the
    // socket this process created (never a foreign path).
    crate::close_transport(&app);
    // Release the single-instance D-Bus name before skipping RunEvent::Exit
    // via process::exit, so a later instance is never mistaken for a live one.
    tauri_plugin_single_instance::destroy(&app);
    std::process::exit(0); // exits only this app
}

/// M2 transport read-back: one real UnixStream round trip to the receiver
/// this process bound, plus the snapshot state it produced. Prints one JSON
/// line (`transport_evidence`).
#[cfg(unix)]
fn transport_evidence(app: &AppHandle) {
    use std::io::{Read, Write};
    use std::os::unix::net::UnixStream;

    let state = app.state::<AppState>();
    let scans = abito_island::transport::preview_scan();
    let endpoint = state
        .transport
        .lock()
        .expect("transport lock")
        .as_ref()
        .map(|transport| transport.endpoint().to_path_buf());
    let mut line = json!({
        "step": "transport_evidence",
        "pointer_input": NO_POINTER,
        "socket_dir_env": std::env::var(abito_island::transport::SOCKET_DIR_ENV).ok(),
        "endpoint": endpoint.as_ref().map(|path| path.display().to_string()),
        "socket_dir_owned_by_this_process": true,
        "project": state.project.clone(),
        "unavailable": state.unavailable.load(std::sync::atomic::Ordering::SeqCst),
        "preview_roots_detected_only": scans.iter().map(|scan| json!({
            "root": scan.root,
            "sockets_detected": scan.sockets,
            "connected_or_removed": false,
        })).collect::<Vec<_>>(),
        "frames_sent": 0,
        "ready_ok": false,
        "notice_count": 0,
        "connections_while_connected": serde_json::Value::Null,
        "connections_after_disconnect": serde_json::Value::Null,
        "error": serde_json::Value::Null,
    });
    let Some(endpoint) = endpoint else {
        line["error"] = json!("receiver unavailable (see startup log)");
        emit(&line);
        return;
    };
    let attempt = (|| -> Result<(u32, bool, usize, Option<u32>, Option<u32>), String> {
        let mut stream =
            UnixStream::connect(&endpoint).map_err(|error| format!("connect: {error}"))?;
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .map_err(|error| format!("read timeout: {error}"))?;
        let project = state.project.clone();
        let hello = json!({"v":1, "type":"hello", "project":project,
                           "sessionId":"probe-session", "at": crate::now_ms() as u64});
        let mut frames = 0u32;
        stream
            .write_all(format!("{hello}\n").as_bytes())
            .map_err(|error| format!("write hello: {error}"))?;
        frames += 1;
        let mut buffer = [0u8; 128];
        let ready_ok = match stream.read(&mut buffer) {
            Ok(count) => &buffer[..count] == abito_island::protocol::READY_LINE,
            Err(error) => return Err(format!("read ready: {error}")),
        };
        if !ready_ok {
            return Ok((frames, false, 0, None, None));
        }
        let settled = json!({"v":1, "type":"settled", "project":project,
                             "sessionId":"probe-session", "at": crate::now_ms() as u64,
                             "id":"probe-1"});
        stream
            .write_all(format!("{settled}\n").as_bytes())
            .map_err(|error| format!("write settled: {error}"))?;
        frames += 1;
        let while_connected = state.connections.load(std::sync::atomic::Ordering::SeqCst);
        // Read the notice back through the REAL snapshot path (same function
        // every desktop:state event and the `snapshot` verb use).
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut notice_count;
        loop {
            let snapshot = crate::build_snapshot(app, &state);
            notice_count = snapshot
                .get("notices")
                .and_then(serde_json::Value::as_array)
                .map(|notices| notices.len())
                .unwrap_or(0);
            if notice_count >= 1 || Instant::now() >= deadline {
                break;
            }
            sleep(Duration::from_millis(50));
        }
        drop(stream);
        // The disconnect is reported asynchronously by the receiver thread.
        let deadline = Instant::now() + Duration::from_secs(1);
        let mut after = state.connections.load(std::sync::atomic::Ordering::SeqCst);
        while after != 0 && Instant::now() < deadline {
            sleep(Duration::from_millis(50));
            after = state.connections.load(std::sync::atomic::Ordering::SeqCst);
        }
        Ok((frames, ready_ok, notice_count, Some(while_connected), Some(after)))
    })();
    match attempt {
        Ok((frames, ready_ok, notice_count, while_connected, after)) => {
            line["frames_sent"] = json!(frames);
            line["ready_ok"] = json!(ready_ok);
            line["notice_count"] = json!(notice_count);
            line["connections_while_connected"] = json!(while_connected);
            line["connections_after_disconnect"] = json!(after);
        }
        Err(error) => line["error"] = json!(error),
    }
    // The `dismiss` verb (wired with M2): run the same dispatch the command
    // funnel uses after validation, and read the count back. Wired means the
    // first notice disappears — a not-yet-wired rejection would show here.
    if line
        .get("notice_count")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0)
        >= 1
    {
        let count_notices = |app: &AppHandle| {
            crate::build_snapshot(app, app.state::<AppState>().inner())
                .get("notices")
                .and_then(serde_json::Value::as_array)
                .map(|notices| notices.len())
                .unwrap_or(0)
        };
        let before = count_notices(app);
        let outcome =
            crate::dispatch_verb(app, &state, abito_island::bridge::Action::Dismiss, None);
        let after = count_notices(app);
        line["dismiss"] = json!({
            "dispatched_ok": outcome.is_ok(),
            "error": outcome.as_ref().err().map(|error| serde_json::to_value(error).unwrap_or_default()),
            "notices_before": before,
            "notices_after": after,
        });
    } else {
        line["dismiss"] = json!({ "skipped": "no notice to dismiss" });
    }
    emit(&line);
}

#[cfg(not(unix))]
fn transport_evidence(_app: &AppHandle) {
    emit(&json!({
        "step": "transport_evidence",
        "status": "not_run",
        "reason": "unavailable on this platform: unix socket read-back",
    }));
}

/// UI.1 visual read-back: the five OVERVIEW scenes on a known background.
/// State is driven through the REAL host paths (transport receiver, fake
/// backend + dispatch funnel the webview's `allow` verb reaches) — never
/// synthesised frontend text. Sequence:
///   sinpi               connections 0, notices 0, no card
///   conectado           one live producer connection (hello → ready)
///   aviso               ONE settled notice from that connection
///   tarjeta-pendiente   healthy bridge + pending card (fresh proposal)
///   tarjeta-resuelta    the human's explicit Allow through dispatch_verb
/// A fresh pending proposal is left served so the later approval_evidence
/// step still exercises its own decision.
fn overview_visual_evidence(app: &AppHandle) {
    if std::env::var("ABITO_PROBE_VISUAL").as_deref() != Ok("1") {
        return; // opt-in: the default probe flow is unchanged
    }
    let state = app.state::<AppState>();
    let card_state = |snapshot: &serde_json::Value| -> String {
        snapshot
            .get("card")
            .and_then(|card| card.get("state"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("none")
            .to_string()
    };

    let mut line = json!({
        "step": "overview_visual_evidence",
        "pointer_input": NO_POINTER,
        "mode": serde_json::Value::Null,
        "states": [],
        "error": serde_json::Value::Null,
    });
    let fake = state.probe_fake.lock().expect("probe fake").clone();
    // Two complementary runs (the lane's selected candidate is STICKY — a
    // served proposal can never legally un-serve, so a clean no-card overview
    // is only reachable when the bridge never became healthy):
    //   no fake  (ABITO_BRIDGE_BASE set from outside → dead origin):
    //             sinpi / conectado / aviso, card is null all run.
    //   fake     (default probe backend): tarjeta-pendiente / -resuelta.
    let card_scenes = fake.is_some();
    line["mode"] = json!(if card_scenes { "card" } else { "sin-tarjeta" });

    let Some(win) = main_window(app) else { return };
    let area = refresh_work_area(app, state.inner());
    let io = TauriIo(&win);
    let scale = io.scale();
    let overview = geometry::scaled_size(geometry::ISLAND_WINDOW, scale);
    let compact = overview;

    // Expand (same core toggle the pointer uses) and let the spring settle.
    let plan = {
        let mut core = state.core.lock().expect("core lock");
        core.toggle(&io, area)
    };
    apply_plan(app, state.inner(), plan);
    wait_for_size(app, overview, Duration::from_secs(3));
    sleep(Duration::from_millis(900));

    if !card_scenes {
        // sin Pi: no connections, no notices, and (this run) no card.
        let snapshot = crate::build_snapshot(app, state.inner());
        if card_state(&snapshot) != "none" {
            line["error"] = json!("expected no card without a reachable bridge");
        }
        sleep(Duration::from_millis(200));
        capture_visual(app, "overview-sinpi");
        capture_poses(app, "grande");
        // i-abierto: the «i» detail open (a real click on the real button).
        let _ = main_window(app).map(|win| win.eval("document.getElementById('notice-info').click()"));
        sleep(Duration::from_millis(300));
        capture_visual(app, "overview-i-abierto");
        let _ = main_window(app).map(|win| win.eval("document.getElementById('notice-info').click()"));
        sleep(Duration::from_millis(300));
        // compacta-sin-puente: no-card run = the approval bridge never became healthy
        // (ABITO_BRIDGE_BASE dead) -> the compact dot carries the RED triangle badge.
        {
            let plan = state.core.lock().expect("core lock").toggle(&io, area);
            apply_plan(app, state.inner(), plan);
            wait_for_size(app, compact, Duration::from_secs(3));
            sleep(Duration::from_millis(500));
            state.chat_probe.lock().expect("chat probe lock").clear();
            let _ = main_window(app).map(|win| win.eval("(async()=>{const f=document.getElementById('compact-flag'); const snap=await window.desktop.snapshot(); await (window.__TAURI__.core.invoke)('record_chat_evidence',{evidence:{phase:'compact_red_badge',bridge:snap.bridgeStatus,unavailable:snap.unavailable,flag_hidden:f.hidden,flag_tone:f.dataset.tone||null,flag_label:f.getAttribute('aria-label'),flag_rect:(r=>[r.x,r.y,r.width,r.height].map(Math.round))(f.getBoundingClientRect())}}); })()"));
            let lines = wait_chat_lines(app, 1, Duration::from_secs(4));
            emit(&json!({"step": "compact_red_badge", "webview": lines}));
            capture_visual(app, "compacta-sin-puente");
            let plan = state.core.lock().expect("core lock").toggle(&io, area);
            apply_plan(app, state.inner(), plan);
            wait_for_size(app, overview, Duration::from_secs(3));
            sleep(Duration::from_millis(700));
        }
        line["states"].as_array_mut().expect("states array").push(json!({
            "name": "sinpi",
            "connections": state.connections.load(std::sync::atomic::Ordering::SeqCst),
            "card": card_state(&snapshot),
        }));

        // conectado: a REAL hello → ready round trip against OUR receiver; the
        // connection count stays 1 while the stream stays open.
        #[cfg(unix)]
        let connected = (|| -> Result<bool, String> {
            use std::io::{Read, Write};
            use std::os::unix::net::UnixStream;
            let endpoint = state
                .transport
                .lock()
                .expect("transport lock")
                .as_ref()
                .map(|transport| transport.endpoint().to_path_buf())
                .ok_or("receiver unavailable")?;
            let mut stream =
                UnixStream::connect(&endpoint).map_err(|error| format!("connect: {error}"))?;
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .map_err(|error| format!("read timeout: {error}"))?;
            let project = state.project.clone();
            let hello = json!({"v":1, "type":"hello", "project":project,
                               "sessionId":"probe-visual", "at": crate::now_ms() as u64});
            stream
                .write_all(format!("{hello}\n").as_bytes())
                .map_err(|error| format!("write hello: {error}"))?;
            let mut buffer = [0u8; 128];
            let count = stream
                .read(&mut buffer)
                .map_err(|error| format!("read ready: {error}"))?;
            if &buffer[..count] != abito_island::protocol::READY_LINE {
                return Ok(false);
            }
            // Keep the stream open across BOTH captures: connected first, then
            // the settled frame for the notice scene.
            sleep(Duration::from_millis(400));
            capture_visual(app, "overview-conectado");
            let settled = json!({"v":1, "type":"settled", "project":project,
                                 "sessionId":"probe-visual", "at": crate::now_ms() as u64,
                                 "id":"probe-visual-1"});
            stream
                .write_all(format!("{settled}\n").as_bytes())
                .map_err(|error| format!("write settled: {error}"))?;
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                let snapshot = crate::build_snapshot(app, state.inner());
                if snapshot["notices"].as_array().map(|n| n.len()).unwrap_or(0) >= 1 {
                    break;
                }
                if Instant::now() >= deadline {
                    return Err("notice did not arrive within 3s".into());
                }
                sleep(Duration::from_millis(50));
            }
            sleep(Duration::from_millis(300));
            capture_visual(app, "overview-aviso");
            drop(stream);
            Ok(true)
        })();
        #[cfg(unix)]
        line["states"].as_array_mut().expect("states array").push(json!({
            "name": "conectado+aviso",
            "ok": connected,
        }));
        #[cfg(not(unix))]
        line["states"].as_array_mut().expect("states array").push(json!({
            "name": "conectado+aviso",
            "not_run": "unavailable on this platform: unix socket read-back",
        }));
    } else {
        // tarjeta-pendiente: serve a FRESH pending proposal (same payload_hash
        // the fake accepts), wait for the REAL snapshot to project it.
        // ABITO_PROBE_VISUAL_DECISION=sent: keep serving the SAME proposal id
        // the lane already selected (sticky), so the fake answers the
        // decision with a real 2xx → the lane's own `Decisión enviada.`
        // (tarjeta-enviada). Default: a different id → 404 → `Sin confirmar`.
        let sent_run = std::env::var("ABITO_PROBE_VISUAL_DECISION").as_deref() == Ok("sent");
        if !sent_run {
            r6_live_evidence(app, state.inner());
        }
        let pending = serde_json::json!({
            "id": format!("proposal_{}", if sent_run { "a" } else { "c" }.repeat(32)),
            "payload_hash": "b".repeat(64),
            "operation": "Prueba M3: propuesta servida por el backend falso",
            "status": "pending",
            "expires_at": "2999-12-31T23:59:59Z",
            "principal": "probe",
            "payload": { "probe": true },
        });
        fake.as_ref().expect("fake").set_proposals(vec![pending]);
        let mut pending_ok = false;
        {
            let deadline = Instant::now() + Duration::from_secs(14);
            while Instant::now() < deadline {
                if card_state(&crate::build_snapshot(app, state.inner())) == "pending" {
                    pending_ok = true;
                    break;
                }
                sleep(Duration::from_millis(100));
            }
        }
        sleep(Duration::from_millis(200));
        capture_visual(app, "overview-tarjeta-pendiente");
        // compacta-espera: same pending card, island collapsed -> sun dot (either fixture mode).
        if pending_ok {
            let plan = state.core.lock().expect("core lock").toggle(&io, area);
            apply_plan(app, state.inner(), plan);
            wait_for_size(app, compact, Duration::from_secs(3));
            sleep(Duration::from_millis(250));
            capture_visual(app, "compacta-espera");
            {
                let st = app.state::<AppState>();
                st.chat_probe.lock().expect("chat probe lock").clear();
                let _ = main_window(app).map(|win| win.eval("(async()=>{const c=document.getElementById('capsule'), f=document.getElementById('compact-flag'); const snap=await window.desktop.snapshot(); await (window.__TAURI__.core.invoke)('record_chat_evidence',{evidence:{phase:'compact_badge',dataset:{...c.dataset},flag_hidden:f.hidden,flag_tone:f.dataset.tone||null,flag_display:getComputedStyle(f).display,flag_rect:(r=>[r.x,r.y,r.width,r.height].map(Math.round))(f.getBoundingClientRect()),island_rect:(r=>[r.x,r.y,r.width,r.height].map(Math.round))(document.getElementById('island').getBoundingClientRect()),card:snap.card}}); })()"));
                let lines = wait_chat_lines(app, 1, Duration::from_secs(4));
                emit(&json!({"step": "compact_badge", "webview": lines}));
            }

            let plan = state.core.lock().expect("core lock").toggle(&io, area);
            apply_plan(app, state.inner(), plan);
            wait_for_size(app, overview, Duration::from_secs(3));
            sleep(Duration::from_millis(900));
        }
        if !sent_run && pending_ok {
            capture_poses(app, "tarjeta");
        }
        line["states"].as_array_mut().expect("states array").push(json!({
            "name": "tarjeta-pendiente",
            "ok": pending_ok,
        }));

        // tarjeta-resuelta: the human's explicit choice through the SAME
        // dispatch funnel the webview's `allow` verb reaches.
        let outcome =
            crate::dispatch_verb(app, state.inner(), abito_island::bridge::Action::Allow, None);
        let resolved_ok = outcome.is_ok();
        {
            let deadline = Instant::now() + Duration::from_secs(3);
            while Instant::now() < deadline {
                let snapshot = crate::build_snapshot(app, state.inner());
                if snapshot["card"]["reason"] == "Decisión enviada." {
                    break;
                }
                sleep(Duration::from_millis(100));
            }
        }
        sleep(Duration::from_millis(200));
        capture_visual(
            app,
            if sent_run {
                "overview-tarjeta-enviada"
            } else {
                "overview-tarjeta-resuelta"
            },
        );
        line["states"].as_array_mut().expect("states array").push(json!({
            "name": if sent_run { "tarjeta-enviada" } else { "tarjeta-resuelta" },
            "dispatched_ok": resolved_ok,
            "error": outcome.as_ref().err().map(|error| serde_json::to_value(error).unwrap_or_default()),
        }));

        // Leave a FRESH pending proposal served so the later
        // approval_evidence step still finds healthy+pending.
        let next = serde_json::json!({
            "id": format!("proposal_{}", "d".repeat(32)),
            "payload_hash": "b".repeat(64),
            "operation": "Prueba M3: propuesta servida por el backend falso",
            "status": "pending",
            "expires_at": "2999-12-31T23:59:59Z",
            "principal": "probe",
            "payload": { "probe": true },
        });
        fake.as_ref().expect("fake").set_proposals(vec![next]);
    }
    let plan = {
        let mut core = state.core.lock().expect("core lock");
        core.toggle(&io, area)
    };
    apply_plan(app, state.inner(), plan);
    wait_for_size(app, compact, Duration::from_secs(3));
    sleep(Duration::from_millis(300));
    emit(&line);
}

/// M3 approval read-back: the lane was started at `setup` against the
/// in-process fake backend (`ABITO_BRIDGE_BASE` override), so this drives
/// the LEGAL gates — expand (legacy requires an open overlay), wait for
/// `healthy` + `pending` — then performs the human's explicit choice
/// through the SAME dispatch funnel the webview's `allow` verb reaches,
/// and reads `card` + `bridgeStatus` back through the REAL snapshot path
/// before and after. The fake's request log proves that NOTHING was
/// written before that click (a notice can never approve) and that
/// `/execute` carried exactly the card's `payload_hash`.
/// #304 diagnosis (read-only): what the SYSTEM tells WebKit about motion, and
/// what the page decides. Reads GtkSettings on the main thread; changes nothing.
fn motion_diag(app: &AppHandle, tag: &str) {
    #[cfg(target_os = "linux")]
    let gtk_value = {
        use gtk::prelude::ObjectExt as _;
        let (tx, rx) = std::sync::mpsc::channel();
        let _ = app.run_on_main_thread(move || {
            let gtk_value = gtk::Settings::default().map(|s| s.property::<bool>("gtk-enable-animations"));
            let _ = tx.send(gtk_value);
        });
        rx.recv_timeout(Duration::from_secs(2)).ok().flatten()
    };
    #[cfg(not(target_os = "linux"))]
    let gtk_value = json!({
        "status": "not_run",
        "reason": "unavailable on this platform: GTK settings read-back",
    });
    let state = app.state::<AppState>();
    state.chat_probe.lock().expect("chat probe lock").clear();
    let Some(page) = main_window(app) else { return };
    let _ = page.eval(
        "(async () => { const invoke = (window.__TAURI__.core.invoke);
          const snap = await window.desktop.snapshot().catch(() => null);
          const ev = { phase: 'motion_diag', media_reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
            data_motion: document.documentElement.dataset.motion || null,
            motion_override: snap ? snap.motionOverride : null,
            clay_status: AbitoClay.statusKind(), clay_osReduced: AbitoClay.osReduced, clay_forced: AbitoClay.forced, clay_frames: AbitoClay.frames,
            chat_transition_duration: getComputedStyle(document.getElementById('chat')).transitionDuration,
            open_chat_transition_duration: getComputedStyle(document.getElementById('open-chat')).transitionDuration };
          await new Promise(r => setTimeout(r, 600)); ev.clay_frames_after = AbitoClay.frames;
          await invoke('record_chat_evidence', { evidence: ev }); })()",
    );
    let lines = wait_chat_lines(app, 1, Duration::from_secs(6));
    emit(&json!({"step": "motion_diag", "tag": tag, "gtk_enable_animations": gtk_value,
        "env_gtk_modules": std::env::var("GTK_MODULES").ok(), "webview": lines}));
}

/// §9.5 motion CERTIFICATION, sampled FROM THE PAGE (no screen capture): a
/// requestAnimationFrame loop records `performance.now()` plus the computed
/// opacity/transform/visibility/display of the animated views and the
/// `document.getAnimations()` count while `action` changes the view.
/// Evidence goes through `record_chat_evidence`; PNG clips are only a glance.
fn sample_motion(app: &AppHandle, name: &str, millis: u64, action: impl FnOnce()) -> Vec<serde_json::Value> {
    let state = app.state::<AppState>();
    state.chat_probe.lock().expect("chat probe lock").clear();
    let Some(page) = main_window(app) else { return Vec::new() };
    // #304: NO gtk-enable-animations toggling any more. Whatever the system tells
    // WebKit (this session reports «reduced»), Abito must animate on its own: the
    // measurement below is taken under the REAL system value, reported here.
    motion_diag(app, name);
    state.chat_probe.lock().expect("chat probe lock").clear();
    let start = format!(
        "(() => {{ const ids = ['chat', 'open-chat', 'notices', 'permission', 'clay', 'models', 'chat-body'];
          const S = {{ name: '{name}', t0: performance.now(), rows: [], viewEvents: [], anims: [] }};
          window.__motion = S; S.muts = [];
          for (const t of ['transitionrun', 'transitionstart', 'transitioncancel', 'transitionend']) document.getElementById('chat').addEventListener(t, e => S.muts.push([Math.round(performance.now() - S.t0), t, e.propertyName]));
          document.addEventListener('island:view', e => S.viewEvents.push([performance.now() - S.t0, e.detail]));
          const tick = () => {{
            const now = performance.now() - S.t0;
            const row = {{ t: now }};
            for (const id of ids) {{ const el = document.getElementById(id); if (!el) continue; const cs = getComputedStyle(el);
              row[id] = [+cs.opacity, cs.transform === 'none' ? 'none' : cs.transform, cs.visibility, cs.display]; }}
            row.r = matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : 0;
            row.v = document.getElementById('capsule').dataset.view + '/' + document.getElementById('capsule').dataset.phase + '/' + (document.getElementById('chat').inert ? 'inert' : 'live');
            S.rows.push(row);
            S.anims.push(document.getAnimations().length);
            if (now < {millis}) requestAnimationFrame(tick); else S.done = true;
          }};
          requestAnimationFrame(tick); }})()"
    );
    let _ = page.eval(start);
    sleep(Duration::from_millis(250)); // a few idle frames before the change
    action();
    sleep(Duration::from_millis(millis + 200));
    let finish = "(async () => { const S = window.__motion; const invoke = (window.__TAURI__.core.invoke);
      const series = id => S.rows.filter(r => r[id]).map(r => [Math.round(r.t), r[id][0], r[id][2], r[id][3], r[id][1], r.v + '/r' + r.r]);
      const out = { phase: 'motion', name: S.name, frames: S.rows.length, view_events: S.viewEvents,
        mean_dt_ms: +(S.rows[S.rows.length - 1].t / S.rows.length).toFixed(1),
        reduced_os: matchMedia('(prefers-reduced-motion: reduce)').matches,
        chat_transition: [getComputedStyle(document.getElementById('chat')).transitionDuration, getComputedStyle(document.getElementById('chat')).transitionDelay, getComputedStyle(document.getElementById('chat')).transitionProperty],
        capsule_view: document.getElementById('capsule').dataset.view, capsule_phase: document.getElementById('capsule').dataset.phase,
        max_animations: Math.max(...S.anims), muts: S.muts.filter(m => m[0] > 200 && m[0] < 520 && !/^clay|^island$/.test(m[1])).slice(0, 40) };
      for (const id of ['chat', 'models', 'chat-body']) {
        const s = series(id);
        out[id + '_distinct_opacities'] = new Set(s.map(r => r[1])).size;
        out[id + '_display_none_frames'] = s.filter(r => r[3] === 'none').length;
        out[id + '_first_fraction_between_0_and_1'] = (s.find(r => r[1] > 0.03 && r[1] < 0.97) || [null])[0];
        const ev0 = S.viewEvents.length ? S.viewEvents[0][0] : 0;
        out[id + '_series'] = s.filter(r => r[0] >= ev0 - 40 && r[0] <= ev0 + 700).slice(0, 60);
      }
      await invoke('record_chat_evidence', { evidence: out }); })()";
    let _ = page.eval(finish);
    wait_chat_lines(app, 1, Duration::from_secs(8))
}

/// §9.5 motion evidence: a short x11grab of OUR window only (matched by
/// `_NET_WM_PID`), written as numbered PNGs `<name>-NN-<stamp>.png`, started
/// BEFORE `action` runs so the transition is inside the clip. Same sand
/// background class as `capture_visual`; no pointer drawn; never the screen.
fn capture_sequence(app: &AppHandle, name: &str, fps: u32, millis: u64, action: impl FnOnce()) {
    if std::env::var("ABITO_PROBE_VISUAL").as_deref() != Ok("1") {
        action();
        return;
    }
    let Some(root) = std::env::var_os("ABITO_SOCKET_DIR") else {
        action();
        return;
    };
    let Some(page) = main_window(app) else { return };
    let Ok(win) = abito_island::workarea::x11_find_own_window(abito_island::workarea::WINDOW_TITLE) else {
        action();
        return;
    };
    let dir = match std::env::var_os("ABITO_PROBE_VISUAL_DIR") {
        Some(custom) => std::path::PathBuf::from(custom),
        None => std::path::Path::new(&root).join("visual"),
    };
    let _ = std::fs::create_dir_all(&dir);
    let stamp = visual_stamp();
    let pattern = dir.join(format!("{name}-%02d-{stamp}.png"));
    let _ = page.eval("document.body.classList.add('probe-capture-bg')");
    sleep(Duration::from_millis(250));
    let display = std::env::var("DISPLAY").unwrap_or_else(|_| ":0".into());
    let child = std::process::Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-y", "-f", "x11grab", "-draw_mouse", "0"])
        .args(["-framerate", &fps.to_string(), "-window_id", &win.id.to_string()])
        .args(["-i", &display, "-t", &format!("{:.2}", millis as f64 / 1000.0)])
        .arg(&pattern)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    sleep(Duration::from_millis(120)); // ffmpeg is grabbing before the action
    action();
    if let Ok(mut child) = child {
        let _ = child.wait();
    }
    let _ = page.eval("document.body.classList.remove('probe-capture-bg')");
    sleep(Duration::from_millis(150));
    emit(&json!({"step": "visual_sequence", "name": name, "fps": fps, "millis": millis, "pattern": pattern.display().to_string()}));
}

/// N6 evidence (opt-in `ABITO_PROBE_VISUAL=1`): REAL QP/1 frames over a real
/// socket to OUR receiver, with the island showing the notification. One
/// connection plays the Pi producer; the human's gesture is the only thing
/// that answers. PNGs on the sand background, one per state.
#[cfg(unix)]
fn notification_scenes(app: &AppHandle) {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::os::unix::net::UnixStream;
    if std::env::var("ABITO_PROBE_VISUAL").as_deref() != Ok("1") {
        return;
    }
    let state = app.state::<AppState>();
    let Some(win) = main_window(app) else { return };
    let Some(endpoint) = state
        .transport
        .lock()
        .expect("transport lock")
        .as_ref()
        .map(|t| t.endpoint().to_path_buf())
    else {
        emit(&json!({"step": "notification_scenes", "error": "receiver unavailable"}));
        return;
    };
    let area = refresh_work_area(app, &state);
    let io = TauriIo(&win);
    let scale = io.scale();
    let overview = geometry::scaled_size(geometry::ISLAND_WINDOW, scale);
    let plan = state.core.lock().expect("core lock").toggle(&io, area);
    apply_plan(app, &state, plan);
    wait_for_size(app, overview, Duration::from_secs(3));
    sleep(Duration::from_millis(900));

    let project = state.project.clone();
    let session = "probe-n6";
    let outcome = (|| -> Result<serde_json::Value, String> {
        let mut stream = UnixStream::connect(&endpoint).map_err(|e| format!("connect: {e}"))?;
        stream.set_read_timeout(Some(Duration::from_secs(3))).ok();
        let send = |stream: &mut UnixStream, v: serde_json::Value| -> Result<(), String> {
            stream.write_all(format!("{v}\n").as_bytes()).map_err(|e| format!("write: {e}"))
        };
        let now = || crate::now_ms() as u64;
        send(&mut stream, json!({"v":1,"type":"hello","project":project,"sessionId":session,"at":now()}))?;
        let mut buf = [0u8; 128];
        let n = stream.read(&mut buf).map_err(|e| format!("ready: {e}"))?;
        if &buf[..n] != abito_island::protocol::READY_LINE {
            return Err("no ready".into());
        }
        send(&mut stream, json!({"v":1,"type":"questions_hello","questionVersion":1,"project":project,"sessionId":session,"at":now()}))?;
        let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
        let mut line = String::new();
        reader.read_line(&mut line).map_err(|e| format!("questions_ready: {e}"))?;
        if !line.contains("questions_ready") {
            return Err(format!("unexpected: {line}"));
        }
        let uuid = |n: u8| format!("3f2b8a4{n}-1c2d-4e5f-8a6b-7c8d9e0f1a2b");
        let question = |id: String, kind: &str, text: &str, options: Vec<(&str, &str, &str)>, free: bool, ttl_ms: u64| {
            json!({"v":1,"type":"question","questionVersion":1,"project":project,"sessionId":session,"at":now(),
                   "id":id,"kind":kind,"text":text,
                   "options":options.iter().map(|(v,l,d)| json!({"value":v,"label":l,"description":d})).collect::<Vec<_>>(),
                   "allowFreeText":free,"expiresAt":now()+ttl_ms})
        };
        let wait_pending = |want: bool| {
            let deadline = Instant::now() + Duration::from_secs(3);
            while Instant::now() < deadline {
                let snapshot = crate::questionhost::question_view(&state);
                if snapshot["pending"].is_object() == want { return true; }
                sleep(Duration::from_millis(50));
            }
            false
        };
        let mut seen = serde_json::Map::new();
        // 3 options (keyboard 1..3)
        send(&mut stream, question(uuid(1), "question", "¿Qué rama uso para el cambio?",
            vec![("opt-1","main",""),("opt-2","develop",""),("opt-3","hotfix","")], false, 300_000))?;
        seen.insert("pending_3".into(), json!(wait_pending(true)));
        sleep(Duration::from_millis(900));
        capture_visual(app, "pregunta-3-opciones");
        // A script click is NOT isTrusted and must never answer (checked here),
        // so the human's choice goes through the host handler directly, like the
        // approval card's `dispatch_verb`: index 1 = the second option.
        let _ = win.eval("document.querySelectorAll('#question-options .q-option')[1].click()");
        sleep(Duration::from_millis(400));
        seen.insert("untrusted_click_answered".into(), json!(!crate::questionhost::question_view(&state)["pending"].is_object()));
        {
            let guard = state.transport.lock().expect("transport lock");
            if let Some(t) = guard.as_ref() {
                let _ = t.answer(&uuid(1), 1);
            }
        }
        sleep(Duration::from_millis(500));
        // the producer answers nothing yet: we capture «Enviada» (neutral)
        capture_visual(app, "pregunta-enviada");
        // producer consumes the answer line
        line.clear();
        reader.read_line(&mut line).map_err(|e| format!("answer: {e}"))?;
        seen.insert("answer_frame_type".into(), json!(serde_json::from_str::<serde_json::Value>(&line).ok().and_then(|v| v["type"].as_str().map(str::to_owned))));
        seen.insert("answer_value".into(), json!(serde_json::from_str::<serde_json::Value>(&line).ok().and_then(|v| v["answer"]["value"].as_str().map(str::to_owned))));
        send(&mut stream, json!({"v":1,"type":"question_resolved","questionVersion":1,"project":project,"sessionId":session,"at":now(),"id":uuid(1),"status":"answered"}))?;
        sleep(Duration::from_millis(700));
        capture_visual(app, "pregunta-recibida");
        // 4 options with descriptions + long label
        send(&mut stream, question(uuid(2), "question", "Elegí cómo seguimos con el despliegue de esta noche",
            vec![("a","Desplegar ahora","sin esperar"),("b","Esperar al lunes",""),("c","Pedir revisión",""),("d","Cancelar todo","")], false, 240_000))?;
        wait_pending(true);
        sleep(Duration::from_millis(900));
        capture_visual(app, "pregunta-4-opciones");
        // Sí / No (approval)
        {
            let guard = state.transport.lock().expect("transport lock");
            if let Some(t) = guard.as_ref() {
                let _ = t.decline(&uuid(2));
            }
        }
        sleep(Duration::from_millis(600));
        line.clear();
        reader.read_line(&mut line).ok();
        send(&mut stream, question(uuid(3), "approval", "¿Borro la rama vieja?", vec![("yes","Sí",""),("no","No","")], false, 180_000))?;
        wait_pending(true);
        sleep(Duration::from_millis(900));
        capture_visual(app, "pregunta-si-no");
        {
            let guard = state.transport.lock().expect("transport lock");
            if let Some(t) = guard.as_ref() {
                let _ = t.decline(&uuid(3));
            }
        }
        sleep(Duration::from_millis(500));
        line.clear();
        reader.read_line(&mut line).ok();
        seen.insert("skip_frame".into(), json!(line.trim().chars().take(160).collect::<String>()));
        capture_visual(app, "pregunta-omitida-enviada"); // the host says «Enviada» until the producer acks
        send(&mut stream, json!({"v":1,"type":"question_resolved","questionVersion":1,"project":project,"sessionId":session,"at":now(),"id":uuid(3),"status":"human_cancelled"}))?;
        sleep(Duration::from_millis(700));
        capture_visual(app, "pregunta-omitida");
        // (a 1-option acknowledgement is NOT expressible in QP/1: 2-4 options or free text only;
        // the wire is the producer lane's, so it is not exercised here)
        // free text only
        send(&mut stream, question(uuid(5), "question", "¿Cómo llamo al nuevo módulo?", vec![], true, 120_000))?;
        wait_pending(true);
        sleep(Duration::from_millis(900));
        let _ = win.eval("(()=>{const t=document.getElementById('question-text'); t.value='registro'; t.dispatchEvent(new Event('input'));})()");
        sleep(Duration::from_millis(700));
        capture_visual(app, "pregunta-texto-libre");
        let _ = win.eval("(()=>{const t=document.getElementById('question-text'); t.value='ñ🙂'.repeat(900); t.dispatchEvent(new Event('input'));})()");
        sleep(Duration::from_millis(800));
        capture_visual(app, "pregunta-texto-muy-largo");
        {
            let guard = state.transport.lock().expect("transport lock");
            if let Some(t) = guard.as_ref() {
                let _ = t.decline(&uuid(5));
            }
        }
        sleep(Duration::from_millis(500));
        line.clear();
        reader.read_line(&mut line).ok();
        // (expiry and a Pi-side cancel are covered by pure behaviour tests: phase=expired and the
        // `cancelled` outcome; waiting 30 s here would only repeat them)
        Ok(serde_json::Value::Object(seen))
    })();
    emit(&json!({"step": "notification_scenes", "result": outcome.clone().unwrap_or_else(|e| json!({"error": e})), "error": outcome.err()}));
    let plan = state.core.lock().expect("core lock").toggle(&io, area);
    apply_plan(app, &state, plan);
    wait_for_size(app, geometry::scaled_size(geometry::ISLAND_WINDOW, scale), Duration::from_secs(3));
}

#[cfg(not(unix))]
fn notification_scenes(_app: &AppHandle) {
    emit(&json!({
        "step": "notification_scenes",
        "status": "not_run",
        "reason": "unavailable on this platform: unix socket read-back",
    }));
}

/// #305 evidence (opt-in visual run): the hotkey's ACTION against the live app. The
/// press is delivered through the same `on_press` the X11 grab calls (the grab itself
/// is proven on a private Xvfb in tests/hotkey_x11.rs; the human's keyboard is never
/// grabbed by a probe). Shows: hide keeps the Pi socket, the chat lane and the model
/// listing alive; the pending-question guard; show restores without taking focus.
fn hotkey_evidence(app: &AppHandle) {
    if std::env::var("ABITO_PROBE_VISUAL").as_deref() != Ok("1") {
        return;
    }
    let state = app.state::<AppState>();
    let Some(win) = main_window(app) else { return };
    let phase = |s: &AppState| format!("{:?}", *s.phase.lock().expect("phase lock"));
    let conns = |s: &AppState| s.connections.load(std::sync::atomic::Ordering::SeqCst);
    let transport_ok = |s: &AppState| s.transport.lock().expect("transport lock").is_some();
    let visible = |w: &tauri::WebviewWindow| w.is_visible().unwrap_or(false);

    // keep one real Pi connection open across hide/show
    #[cfg(unix)]
    let endpoint = state.transport.lock().expect("transport lock").as_ref().map(|t| t.endpoint().to_path_buf());
    #[cfg(unix)]
    let mut stream = endpoint.and_then(|e| {
        use std::io::{Read, Write};
        let mut s = std::os::unix::net::UnixStream::connect(e).ok()?;
        s.set_read_timeout(Some(Duration::from_secs(3))).ok()?;
        let hello = json!({"v":1,"type":"hello","project":state.project.clone(),"sessionId":"probe-hotkey","at":crate::now_ms() as u64});
        s.write_all(format!("{hello}\n").as_bytes()).ok()?;
        let mut b = [0u8; 64];
        let n = s.read(&mut b).ok()?;
        (&b[..n] == abito_island::protocol::READY_LINE).then_some(s)
    });
    sleep(Duration::from_millis(400));
    let before = json!({"phase": phase(&state), "visible": visible(&win), "focused": win.is_focused().unwrap_or(false), "connections": conns(&state), "transport": transport_ok(&state)});

    crate::hotkeyhost::press_on_main(app); // visible -> hide
    sleep(Duration::from_millis(500));
    let hidden = json!({"phase": phase(&state), "visible": visible(&win), "connections": conns(&state), "transport": transport_ok(&state),
        "chat_availability_kept": state.chat.lock().expect("chat lane lock").availability.state});
    // a notice arriving while hidden does not pop it open
    #[cfg(unix)]
    let notice_ok = stream.as_mut().map(|s| {
        use std::io::Write;
        let settled = json!({"v":1,"type":"settled","project":state.project.clone(),"sessionId":"probe-hotkey","at":crate::now_ms() as u64,"id":"probe-hotkey-1"});
        s.write_all(format!("{settled}\n").as_bytes()).is_ok()
    });
    #[cfg(not(unix))]
    let notice_ok = json!({
        "status": "not_run",
        "reason": "unavailable on this platform: unix socket read-back",
    });
    sleep(Duration::from_millis(600));
    let still_hidden = json!({"phase": phase(&state), "visible": visible(&win),
        "notices": crate::build_snapshot(app, &state)["notices"].as_array().map(|n| n.len())});

    crate::hotkeyhost::press_on_main(app); // hidden -> show
    sleep(Duration::from_millis(700));
    let shown = json!({"phase": phase(&state), "visible": visible(&win), "connections": conns(&state), "transport": transport_ok(&state),
        "focused": win.is_focused().unwrap_or(false)});
    capture_visual(app, "atajo-mostrada");
    #[cfg(unix)]
    drop(stream.take());
    emit(&json!({"step": "hotkey_evidence", "before": before, "after_hide": hidden, "notice_sent_while_hidden": notice_ok,
        "after_notice_still_hidden": still_hidden, "after_show": shown}));
}

/// #309 evidence (opt-in visual run): the overview <-> column transition CAUGHT IN FLIGHT, with the
/// native window size observed at each frame. The stage window must hold both views, so a capture
/// taken mid-way never shows a clipped overview or a clipped column.
fn column_transition_scenes(app: &AppHandle) {
    let state = app.state::<AppState>();
    let Some(win) = main_window(app) else { return };
    let area = refresh_work_area(app, &state);
    let io = TauriIo(&win);
    let scale = io.scale();
    let overview = geometry::scaled_size(geometry::ISLAND_WINDOW, scale);
    let column = overview;
    let stage = overview;
    let size = || win.inner_size().map(|s| [s.width, s.height]).unwrap_or([0, 0]);
    let plan = state.core.lock().expect("core lock").toggle(&io, area);
    apply_plan(app, &state, plan);
    wait_for_size(app, overview, Duration::from_secs(3));
    sleep(Duration::from_millis(700));
    capture_visual(app, "columna-0-resumen");
    crate::chathost::switch_view(app, &state, true);
    sleep(Duration::from_millis(260));
    let opening = size();
    capture_visual(app, "columna-1-abriendo");
    let settled = wait_for_size(app, column, Duration::from_secs(4));
    sleep(Duration::from_millis(500));
    capture_visual(app, "columna-2-abierta");
    crate::chathost::switch_view(app, &state, false);
    sleep(Duration::from_millis(200));
    let closing = size();
    capture_visual(app, "columna-3-cerrando");
    let back = wait_for_size(app, overview, Duration::from_secs(4));
    sleep(Duration::from_millis(300));
    capture_visual(app, "columna-4-resumen");
    emit(&json!({
        "step": "column_transition", "scale": scale, "overview": [overview.0, overview.1], "column": [column.0, column.1],
        "stage_expected": [stage.0, stage.1], "native_while_opening": opening, "column_settled": settled,
        "native_while_closing": closing, "overview_settled": back,
    }));
    let plan = state.core.lock().expect("core lock").toggle(&io, area);
    apply_plan(app, &state, plan);
    sleep(Duration::from_millis(700));
}

/// #306 evidence (opt-in visual run): the settings panel in each section, driven through the
/// page's own gear/tabs. The daemon state comes from `ABITO_ISLAND_DIR` (a REAL daemon with a
/// fake agent when the caller started one, or nothing running = honest «Sin motor»).
fn settings_scenes(app: &AppHandle, tag: &str) {
    if std::env::var("ABITO_PROBE_VISUAL").as_deref() != Ok("1") {
        return;
    }
    let state = app.state::<AppState>();
    let Some(win) = main_window(app) else { return };
    let area = refresh_work_area(app, &state);
    let io = TauriIo(&win);
    let scale = io.scale();
    let overview = geometry::scaled_size(geometry::ISLAND_WINDOW, scale);
    let chat_size = overview;
    let plan = state.core.lock().expect("core lock").toggle(&io, area);
    apply_plan(app, &state, plan);
    wait_for_size(app, overview, Duration::from_secs(3));
    sleep(Duration::from_millis(900));
    capture_visual(app, &format!("ajustes-{tag}-engranaje"));
    // the gear (a real click on the real button; the probe page click is the human's gesture stand-in)
    let _ = win.eval("document.dispatchEvent(new CustomEvent('abito:settings-select', { detail: 'open' }))");
    wait_for_size(app, chat_size, Duration::from_secs(3));
    sleep(Duration::from_millis(1400));
    let probe = |js: &str| {
        state.chat_probe.lock().expect("chat probe lock").clear();
        let _ = win.eval(js.to_string());
        wait_chat_lines(app, 1, Duration::from_secs(15))
    };
    // Raw diagnostic FIRST: what does the page get from agent_action? (error text, not a guess)
    state.chat_probe.lock().expect("chat probe lock").clear();
    let _ = win.eval("(async()=>{let r; try { r = await (window.__TAURI__.core.invoke)('agent_action',{payload:{action:'view'}}); r = 'OK:' + JSON.stringify(r).slice(0,200); } catch(e) { r = 'ERR:' + (typeof e === 'string' ? e : JSON.stringify(e)); } await (window.__TAURI__.core.invoke)('record_chat_evidence',{evidence:{phase:'agent_raw', r}}); })()".to_string());
    let raw = wait_chat_lines(app, 1, Duration::from_secs(10));
    emit(&json!({"step": "agent_raw", "webview": raw}));
    for (section, name) in [("accounts", "cuentas"), ("accounts:oauth", "cuentas-suscripcion"), ("accounts:api_key", "cuentas-clave"), ("connectors", "conectores"), ("settings", "ajustes")] {
        // a script click is not a trusted gesture (the tab buttons rightly ignore it), so the probe
        // selects the tab through the panel's one inert seam: a CustomEvent that only changes which
        // section is shown.
        let _ = win.eval(format!("document.dispatchEvent(new CustomEvent('abito:settings-select', {{ detail: '{section}' }}))"));
        sleep(Duration::from_millis(900));
        let lines = probe(&format!(
            "(async()=>{{let direct=null; try {{ direct = await (window.__TAURI__.core.invoke)('agent_action',{{payload:{{action:'view'}}}}); direct = direct.connection; }} catch(e) {{ direct = 'ERR:' + JSON.stringify(e); }}
              const rows=[...document.querySelectorAll('#settings-body .srow')].map(r=>r.textContent.replace(/\\s+/g,' ').trim());
              const sizes=[...document.querySelectorAll('#settings button, #settings input, #settings select')].filter(e=>e.getBoundingClientRect().width>0).map(e=>{{const r=e.getBoundingClientRect(); return [e.id||e.className||e.tagName, Math.round(r.width), Math.round(r.height)];}});
              await (window.__TAURI__.core.invoke)('record_chat_evidence',{{evidence:{{phase:'settings',direct_view:direct,section:'{section}',open:document.getElementById('settings').dataset.open,conn_chip:(c=>c.hidden?null:c.textContent.trim())(document.getElementById('settings-conn')),rows,undersized:sizes.filter(s=>s[1]<44||s[2]<44),count:sizes.length}}}}); }})()"
        ));
        emit(&json!({"step": "settings_section", "tag": tag, "section": section, "webview": lines}));
        capture_visual(app, &format!("ajustes-{tag}-{name}"));
    }
    // PROBE-ONLY evidence with content: a made-up engine state pushed through the same `agent:state` event the
    // page really listens to, so the screens are captured with agents and providers. The shipped binary has no
    // probe feature, so this never runs there.
    let fake = json!({
        "connection": "connected",
        "providers": [{"id":"anthropic","name":"Anthropic","configured":true,"methods":["oauth","api_key"]},
                      {"id":"openai","name":"OpenAI","configured":false,"methods":["oauth","api_key"]},
                      {"id":"groq","name":"Groq","configured":false,"methods":["api_key"]}],
        "accounts": [{"accountId":"anthropic-1","label":"Anthropic","provider":"anthropic","authMethod":"oauth","configured":true}],
        "profiles": {"profiles": [], "active": null},
        "auth": {"flowId": null, "prompt": null, "event": null, "last": null},
        "connectors": {"state": "ready", "items": [{"id":"notion","label":"Notion","mode":"read_only","enabled":true,"configured":true,"status":"connected"},
                                                    {"id":"gmail","label":"Gmail","mode":"read_and_send","enabled":true,"configured":false,"status":"needs_setup"}]},
        "last_error": {"code": null, "n": 0},
        "agents": [{"id":"claude-code","state":"connected","backup":true,"detail":null},
                   {"id":"codex","state":"not_connected","backup":false,"detail":null},
                   {"id":"opencode","state":"unavailable","backup":false,"detail":null}],
    });
    for (detail, name) in [("connectors", "conectores-con-datos"), ("accounts:oauth", "cuentas-suscripcion-con-datos"), ("accounts:api_key", "cuentas-clave-con-datos"), ("accounts", "cuentas-con-datos")] {
        let _ = win.eval(format!("document.dispatchEvent(new CustomEvent('abito:settings-select', {{ detail: '{detail}' }}))"));
        sleep(Duration::from_millis(700));
        let _ = app.emit("agent:state", &fake);
        sleep(Duration::from_millis(700));
        capture_visual(app, &format!("ajustes-{tag}-{name}"));
    }
    sleep(Duration::from_millis(300));
    crate::chathost::switch_view(app, &state, false);
    wait_for_size(app, overview, Duration::from_secs(3));
    let plan = state.core.lock().expect("core lock").toggle(&io, area);
    apply_plan(app, &state, plan);
    wait_for_size(app, geometry::scaled_size(geometry::ISLAND_WINDOW, scale), Duration::from_secs(3));
}

/// UI contract §9.1/§9.5 «Abito alive by default»: the R6 in `idle` must be
/// animating on its own (no button), judged with MOVEMENT: engine status +
/// growing frame counter + the body path changing between samples, and six
/// sequential PNGs of the same scene that must differ from each other.
fn r6_live_evidence(app: &AppHandle, state: &AppState) {
    if std::env::var("ABITO_PROBE_VISUAL").as_deref() != Ok("1") {
        return;
    }
    let Some(win) = main_window(app) else { return };
    state.chat_probe.lock().expect("chat probe lock").clear();
    let _ = win.eval(
        "(async () => { const invoke = (window.__TAURI__.core.invoke);
          const ev = { phase: 'r6_live' };
          ev.reduced_os = matchMedia('(prefers-reduced-motion: reduce)').matches;
          ev.status_before = AbitoClay.statusKind();
          ev.frames_before = AbitoClay.frames;
          const clay = document.getElementById('clay');
          const paths = [];
          for (let i = 0; i < 6; i++) { paths.push(clay.querySelector('path') ? clay.querySelector('path').getAttribute('d') : null); await new Promise(r => setTimeout(r, 350)); }
          ev.frames_after = AbitoClay.frames;
          ev.status_after = AbitoClay.statusKind();
          ev.distinct_body_paths = new Set(paths).size;
          ev.animate_buttons = document.querySelectorAll('[id*=animate], [aria-label*=nimar]').length;
          await invoke('record_chat_evidence', { evidence: ev }); })()",
    );
    let lines = wait_chat_lines(app, 1, Duration::from_secs(10));
    emit(&json!({"step": "r6_live_evidence", "webview": lines}));
    // hover pair: the same scene without and with the pointer over the R6
    // (a synthetic event for the page's own handler; no real pointer is used)
    let _ = win.eval("(()=>{const r=document.getElementById('clay').getBoundingClientRect(); window.dispatchEvent(new PointerEvent('pointermove',{clientX:-5,clientY:-5,bubbles:true})); window.__hoverBox=[r.left+r.width/2, r.top+r.height/2];})()");
    sleep(Duration::from_millis(400));
    capture_visual(app, "hover-r6-sin");
    let _ = win.eval("window.dispatchEvent(new PointerEvent('pointermove',{clientX:window.__hoverBox[0],clientY:window.__hoverBox[1],bubbles:true}))");
    sleep(Duration::from_millis(400));
    capture_visual(app, "hover-r6-con");
    let _ = win.eval("window.dispatchEvent(new PointerEvent('pointermove',{clientX:-5,clientY:-5,bubbles:true}))");
    sleep(Duration::from_millis(300));
    // six sequential frames of the same idle scene, fixed ~0.7 s apart
    for i in 0..6 {
        capture_visual(app, &format!("idle-vivo-{i}"));
        sleep(Duration::from_millis(300));
    }
}

/// Seven R6 poses at the overview framing (viewBox 36 32 128 128), one PNG
/// each, BEFORE any setState is wired to real events. Probe-only: a second,
/// non-live engine instance is mounted on a clone of #clay (same size,
/// position and viewBox as the island's character) held in the engine's own
/// `staticPose`; the island's real #clay is hidden for the grab and restored.
/// Nothing in production code changes the pose.
fn capture_poses(app: &AppHandle, suffix: &str) {
    if std::env::var("ABITO_PROBE_VISUAL").as_deref() != Ok("1") {
        return;
    }
    let Some(page) = main_window(app) else { return };
    let _ = page.eval(
        "(() => { const real = document.getElementById('clay');
          const tmp = real.cloneNode(false); tmp.id = 'clay-pose';
          tmp.setAttribute('viewBox', real.getAttribute('viewBox'));
          tmp.style.position = 'absolute'; tmp.style.display = 'block'; tmp.style.transform = 'translateX(-50%)'; tmp.style.pointerEvents = 'none';
          real.after(tmp); real.style.visibility = 'hidden';
          window.__poseInst = AbitoClay.create(tmp, { seed: 505, viewBox: real.getAttribute('viewBox'), live: false, state: 'idle' });
          tmp.setAttribute('viewBox', real.getAttribute('viewBox')); })()",
    );
    sleep(Duration::from_millis(300));
    for state in ["idle", "listen", "think", "speak", "reject", "confirm", "error"] {
        let _ = page.eval(format!(
            "window.__poseInst.staticPose('{state}'); \
             document.getElementById('clay-pose').setAttribute('viewBox', document.getElementById('clay').getAttribute('viewBox'))"
        ));
        sleep(Duration::from_millis(250));
        capture_visual(app, &format!("pose-{state}-{suffix}"));
    }
    let _ = page.eval(
        "(() => { const t = document.getElementById('clay-pose'); if (t) t.remove();
          document.getElementById('clay').style.visibility = ''; delete window.__poseInst; })()",
    );
    sleep(Duration::from_millis(200));
}

fn approval_evidence(app: &AppHandle) {
    let state = app.state::<AppState>();
    let fake = state.probe_fake.lock().expect("probe fake").clone();
    let mut line = json!({
        "step": "approval_evidence",
        "pointer_input": NO_POINTER,
        "base_origin_env": std::env::var(abito_island::approval::BASE_ENV).ok(),
        "fake_backend_spawned": fake.is_some(),
        "decision": serde_json::Value::Null,
        "error": serde_json::Value::Null,
    });
    let Some(fake) = fake else {
        line["error"] = json!(
            "ABITO_BRIDGE_BASE was set from outside: the probe reads snapshots \
             but NEVER decides against a non-probe backend"
        );
        emit(&line);
        return;
    };
    // Legacy gates for an actionable card: open overlay + visible window.
    let Some(win) = main_window(app) else { return };
    let area = refresh_work_area(app, &state);
    let io = TauriIo(&win);
    let plan = {
        let mut core = state.core.lock().expect("core lock");
        core.toggle(&io, area)
    };
    apply_plan(app, &state, plan); // expand
    let mut before = None;
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        let snapshot = crate::build_snapshot(app, &state);
        if snapshot["bridgeStatus"]["state"] == "healthy"
            && snapshot["card"]["state"] == "pending"
        {
            before = Some(snapshot);
            break;
        }
        sleep(Duration::from_millis(100));
    }
    let Some(before) = before else {
        line["error"] = json!("bridge did not reach healthy+pending within 8s");
        line["last_snapshot"] = crate::build_snapshot(app, &state);
        line["requests"] = json!(fake
            .log()
            .iter()
            .map(|entry| json!({"method": entry.method, "path": entry.path}))
            .collect::<Vec<_>>());
        emit(&line);
        return;
    };
    line["bridge_status_before"] = before["bridgeStatus"].clone();
    line["card_before"] = before["card"].clone();
    let posts_before = fake.posts().len();
    line["posts_before_choice"] = json!(posts_before);
    // The human's explicit choice — the same dispatch funnel the webview's
    // `allow` verb reaches after the IPC gate. The probe is neither a
    // pointer nor the renderer: it drives the host handler
    // programmatically, which is exactly what makes "nothing approves by
    // itself" provable (posts_before_choice must be 0).
    let outcome = crate::dispatch_verb(app, &state, abito_island::bridge::Action::Allow, None);
    line["decision"] = json!({
        "dispatched_ok": outcome.is_ok(),
        "error": outcome.as_ref().err().map(|error| serde_json::to_value(error).unwrap_or_default()),
    });
    let after = crate::build_snapshot(app, &state);
    line["bridge_status_after"] = after["bridgeStatus"].clone();
    line["card_after"] = after["card"].clone();
    let log: Vec<serde_json::Value> = fake
        .log()
        .iter()
        .map(|entry| {
            json!({
                "method": entry.method,
                "path": entry.path,
                "session_cookie": entry.session_cookie,
                "x_sb_request": entry.x_sb_request,
                "payload_hash": entry.payload_hash,
            })
        })
        .collect();
    line["requests"] = json!(log);
    let posts_after = fake.posts();
    line["posts_after_choice"] = json!(posts_after.len());
    let card_hash = "b".repeat(64);
    line["execute_payload_hash_matches_card"] = json!(posts_after.iter().any(|entry| {
        entry.path.ends_with("/execute")
            && entry.payload_hash.as_deref() == Some(card_hash.as_str())
    }));
    // collapse back: the probe leaves the island at rest
    let plan = {
        let mut core = state.core.lock().expect("core lock");
        core.toggle(&io, area)
    };
    apply_plan(app, &state, plan);
    emit(&line);
}

/// Driven inside the webview by the probe (step 7). Every call goes through
/// the real `window.desktop` facade / `desktop_action` command path; the
/// report is typed back through `record_facade_evidence`.
const FACADE_JS: &str = r#"(async () => {
  const ev = { verbs: null, snapshot: null, snapshot_error: null, invalid_call: null,
    expand: null, close: null, state_events: 0, last_event_revision: null, rate: null,
    webview_url: location.href,
    webview_label: (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.metadata
      && window.__TAURI_INTERNALS__.metadata.currentWebview
      && window.__TAURI_INTERNALS__.metadata.currentWebview.label) || null };
  const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)
    || (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);
  try {
    ev.verbs = window.desktop ? Object.keys(window.desktop).sort() : null;
    if (window.desktop && typeof window.desktop.onState === 'function') {
      window.desktop.onState(s => { ev.state_events += 1; ev.last_event_revision = s.revision; });
    }
  } catch (e) { ev.verbs_error = String(e); }
  try { ev.snapshot = await window.desktop.snapshot(); } catch (e) { ev.snapshot_error = e; }
  await new Promise(r => setTimeout(r, 150)); // let the onState listener land
  try {
    await invoke('desktop_action', { payload: { action: 'approve-everything' } });
    ev.invalid_call = { rejected: false };
  } catch (e) { ev.invalid_call = { rejected: true, error: e }; }
  try { ev.expand = await window.desktop.expand(); } catch (e) { ev.expand_error = e; }
  await new Promise(r => setTimeout(r, 150));
  try { ev.close = await window.desktop.close(); } catch (e) { ev.close_error = e; }
  // M3: choose is wired — with no standing request it must answer the
  // typed `denied`, not `not-yet-wired` (and it never reaches HTTP).
  try { await window.desktop.choose(0); ev.choose = { rejected: false }; }
  catch (e) { ev.choose = { rejected: true, code: e && e.code, message: e && e.message }; }
  await new Promise(r => setTimeout(r, 1100)); // fresh fixed 1s rate window
  const results = await Promise.all(Array.from({ length: 40 }, () =>
    window.desktop.snapshot().then(() => null, e => e)));
  const rejections = results.filter(r => r !== null);
  ev.rate = { attempts: 40, rejections: rejections.length, first_error: rejections[0] || null };
  try { await invoke('record_facade_evidence', { evidence: ev }); }
  catch (e) { /* probe reports the timeout */ }
})().catch(async e => {
  try {
    const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)
      || (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);
    await invoke('record_facade_evidence', { evidence: { script_error: String(e) } });
  } catch { /* probe reports the timeout */ }
});"#;

/// Wait for the webview to report `n` chat evidence lines.
fn wait_chat_lines(app: &AppHandle, n: usize, timeout: Duration) -> Vec<serde_json::Value> {
    let deadline = Instant::now() + timeout;
    loop {
        let lines = app.state::<AppState>().chat_probe.lock().expect("chat probe lock").clone();
        if lines.len() >= n || Instant::now() >= deadline {
            return lines;
        }
        sleep(Duration::from_millis(100));
    }
}

/// #310 diagnosis: «slow to open some panels». For each panel, time from the (probe) click to the moment the
/// panel shows content, and report which IPC calls ran in between and how long each took.
fn panel_open_timing(app: &AppHandle) {
    let state = app.state::<AppState>();
    let Some(win) = main_window(app) else { return };
    let area = refresh_work_area(app, &state);
    let io = TauriIo(&win);
    if !state.core.lock().expect("core lock").expanded {
        let plan = state.core.lock().expect("core lock").toggle(&io, area);
        apply_plan(app, &state, plan);
        sleep(Duration::from_millis(900));
    }
    crate::chathost::switch_view(app, &state, true);
    sleep(Duration::from_millis(1200));
    state.chat_probe.lock().expect("chat probe lock").clear();
    let js = "(async () => {
      const invoke = window.__TAURI__.core.invoke;
      const calls = [];
      const orig = invoke;
      window.__TAURI__.core.invoke = (cmd, args) => { const t = performance.now(); const p = orig(cmd, args); const done = () => calls.push([cmd, args && args.payload && args.payload.action || '', Math.round(performance.now() - t)]); p.then(done, done); return p; };
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const frames = () => new Promise(r => { let n = 0, last = performance.now(), worst = 0; const f = t => { worst = Math.max(worst, t - last); last = t; if (++n < 30) requestAnimationFrame(f); else r(Math.round(worst)); }; requestAnimationFrame(f); });
      const out = [];
      for (const [name, sel] of [['cuentas', 'open-screen-accounts'], ['conectores', 'open-screen-connectors'], ['ajustes', 'open-screen-settings'], ['modelos', 'chat-models']]) {
        calls.length = 0;
        if (document.getElementById('settings').dataset.open === 'true') document.getElementById('settings-close').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        if (document.getElementById('models').dataset.open === 'true') document.getElementById('models-close').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await wait(500);
        const t0 = performance.now();
        document.dispatchEvent(new CustomEvent('abito:settings-select', { detail: name === 'modelos' ? 'x' : sel.replace('open-screen-', '') }));
        if (name === 'modelos') document.getElementById(sel).click();
        let firstContent = null;
        for (let i = 0; i < 300 && firstContent === null; i++) { const body = document.getElementById(name === 'modelos' ? 'models-list' : 'settings-body'); if (body && body.children.length) firstContent = Math.round(performance.now() - t0); else await new Promise(r => requestAnimationFrame(r)); }
        const worst = await frames();
        await wait(600);
        out.push({ panel: name, first_content_ms: firstContent, worst_frame_ms: worst, calls: calls.map(c => c.join(':')).join(' ') });
      }
      window.__TAURI__.core.invoke = orig;
      await orig('record_chat_evidence', { evidence: { phase: 'panel_timing', panels: out } });
    })()";
    let _ = win.eval(js);
    let lines = wait_chat_lines(app, 1, Duration::from_secs(20));
    emit(&json!({"step": "panel_timing", "webview": lines}));
}

/// A common timeline for the native-resize diagnosis (#310 «flash al cambiar de vista»): Rust marks the
/// moments the host asks for a size, applies it and receives the window's `Resized`; the page marks what it
/// sees. Debug/probe builds only, bounded.
static TIMELINE: std::sync::Mutex<Vec<(u128, String)>> = std::sync::Mutex::new(Vec::new());
pub(crate) fn mark(label: impl Into<String>) {
    if let Ok(mut t) = TIMELINE.lock() {
        if t.len() < 600 {
            t.push((crate::now_ms(), label.into()));
        }
    }
}

/// #310: the human still sees ONE small flash when the view changes (dot → overview → column). The flash lives
/// between the page and the real window, so this scene watches the WINDOW: ffmpeg grabs the X server's pixels
/// of the island's region at 60 fps while the views are walked, and the page and the host write a shared
/// timeline. Frames and timeline are analysed offline (a pre-compositor view: it shows what the X window
/// holds at each instant, not what a Wayland compositor then does with it).
fn native_resize_flash_scene(app: &AppHandle) {
    if std::env::var("ABITO_PROBE_VISUAL").as_deref() != Ok("1") {
        return;
    }
    let Some(root) = std::env::var_os("ABITO_SOCKET_DIR") else { return };
    let dir = match std::env::var_os("ABITO_PROBE_VISUAL_DIR") {
        Some(c) => std::path::PathBuf::from(c),
        None => std::path::Path::new(&root).join("visual"),
    };
    let _ = std::fs::create_dir_all(&dir);
    let tag = std::env::var("ABITO_PROBE_FLASH_TAG").unwrap_or_else(|_| "ahora".into());
    let video = dir.join(format!("flash-{tag}.mkv"));
    let state = app.state::<AppState>();
    let Some(win) = main_window(app) else { return };
    let area = refresh_work_area(app, &state);
    let io = TauriIo(&win);
    // a known beige behind the island for the whole recording: anything that is not beige, island black or
    // island content is an artefact
    let _ = win.eval("document.body.classList.add('probe-capture-bg')");
    let _ = win.eval(r#"(() => { const S = { ev: [], rows: [], gaps: [] }; window.__tl = S;
      const cap = document.getElementById('capsule'), isl = document.getElementById('island');
      addEventListener('resize', () => S.ev.push([Date.now(), 'page resize', innerWidth, innerHeight]));
      document.addEventListener('island:view', e => S.ev.push([Date.now(), 'island:view', e.detail]));
      let last = '', prev = performance.now();
      const tick = now => { const r = isl.getBoundingClientRect();
        const k = innerWidth + 'x' + innerHeight + '|' + Math.round(r.width) + 'x' + Math.round(r.height) + '|' + cap.dataset.view + '/' + cap.dataset.phase;
        if (k !== last) { S.rows.push([Date.now(), innerWidth, innerHeight, Math.round(r.width), Math.round(r.height), cap.dataset.view, cap.dataset.phase]); last = k; }
        if (now - prev > 24) S.gaps.push([Date.now(), Math.round(now - prev)]);
        prev = now; if (!S.stop) requestAnimationFrame(tick); };
      requestAnimationFrame(tick); })()"#);
    // known starting state: COMPACT (the dot). Earlier scenes leave the island expanded.
    if state.core.lock().expect("core lock").expanded {
        if state.core.lock().expect("core lock").chat {
            crate::chathost::switch_view(app, &state, false);
            sleep(Duration::from_millis(900));
        }
        let plan = state.core.lock().expect("core lock").toggle(&io, area);
        apply_plan(app, &state, plan);
        sleep(Duration::from_millis(1500));
    }
    sleep(Duration::from_millis(300));
    let scale = io.scale();
    let w_px = 0i64;
    let (x0, y0) = (0i32, 0i32);
    let display = std::env::var("DISPLAY").unwrap_or_else(|_| ":0".into());
    let start_ms = crate::now_ms();
    // the WHOLE root (a fixed region would read outside the window when it moves/resizes): the window's own
    // geometry is sampled from the X server on a side thread and the frames are cropped to it offline
    let mut rec = std::process::Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-y", "-f", "x11grab", "-draw_mouse", "0", "-framerate", "60",
               "-i", &format!("{display}+0,0"), "-t", "11", "-c:v", "ffv1", "-an"])
        .arg(&video)
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
        .spawn()
        .ok();
    let geom: std::sync::Arc<std::sync::Mutex<Vec<(u128, i32, i32, i32, i32)>>> = Default::default();
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (g2, s2) = (geom.clone(), stop.clone());
    let sampler = std::thread::spawn(move || {
        while !s2.load(std::sync::atomic::Ordering::SeqCst) {
            if let Ok(w) = abito_island::workarea::x11_find_own_window(abito_island::workarea::WINDOW_TITLE) {
                if let Ok(mut g) = g2.lock() {
                    if g.len() < 4000 {
                        g.push((crate::now_ms(), w.x, w.y, w.w, w.h));
                    }
                }
            } else if let Ok(mut g) = g2.lock() {
                if g.len() < 4000 {
                    g.push((crate::now_ms(), -1, -1, -1, -1)); // not found: unmapped or mid-reconfigure
                }
            }
            sleep(Duration::from_millis(4));
        }
    });
    sleep(Duration::from_millis(1200)); // ffmpeg is up and grabbing
    mark("S0 recording steady (compact)");
    TIMELINE.lock().map(|mut t| t.retain(|(ms, _)| *ms >= start_ms)).ok();
    mark("S1 expand: dot -> overview");
    let plan = state.core.lock().expect("core lock").toggle(&io, area);
    apply_plan(app, &state, plan);
    sleep(Duration::from_millis(1700));
    mark("S2 view: overview -> column");
    crate::chathost::switch_view(app, &state, true);
    sleep(Duration::from_millis(2000));
    mark("S3 view: column -> overview");
    crate::chathost::switch_view(app, &state, false);
    sleep(Duration::from_millis(1700));
    mark("S4 collapse: overview -> dot");
    let plan = state.core.lock().expect("core lock").toggle(&io, area);
    apply_plan(app, &state, plan);
    sleep(Duration::from_millis(1800));
    mark("S5 end");
    let _ = win.eval("document.body.classList.remove('probe-capture-bg'); window.__tl.stop = true;");
    if let Some(r) = rec.as_mut() {
        let _ = r.wait();
    }
    stop.store(true, std::sync::atomic::Ordering::SeqCst);
    let _ = sampler.join();
    let geometry: Vec<_> = geom.lock().map(|g| g.iter().map(|(t, x, y, w, h)| json!([*t as u64, x, y, w, h])).collect()).unwrap_or_default();
    state.chat_probe.lock().expect("chat probe lock").clear();
    let _ = win.eval("(window.__TAURI__.core.invoke)('record_chat_evidence', { evidence: { phase: 'flash_timeline', ev: window.__tl.ev, rows: window.__tl.rows, gaps: window.__tl.gaps } })");
    let lines = wait_chat_lines(app, 1, Duration::from_secs(10));
    let host: Vec<_> = TIMELINE.lock().map(|t| t.iter().map(|(ms, l)| json!([*ms as u64, l])).collect()).unwrap_or_default();
    emit(&json!({"step": "flash_timeline", "tag": tag, "video": video.to_string_lossy(), "record_start_ms": start_ms as u64, "grab": [x0, y0, w_px], "window_geometry": geometry,
                 "scale": scale, "host": host, "page": lines}));
}

/// #310 diagnosis: the human opens the island, works in the chat or in a settings screen and presses the
/// shortcut AGAIN expecting it to hide. Press it from each view (the same entry point the X11 grab and the
/// portal's `Activated` use) and report phase and real visibility.
fn hotkey_hide_from_views(app: &AppHandle) {
    let state = app.state::<AppState>();
    let Some(win) = main_window(app) else { return };
    let area = refresh_work_area(app, &state);
    let io = TauriIo(&win);
    let phase = |s: &AppState| format!("{:?}", *s.phase.lock().expect("phase lock"));
    let visible = |w: &tauri::WebviewWindow| w.is_visible().unwrap_or(false);
    let mut rows = Vec::new();
    for view in ["overview", "chat", "settings-screen", "chat-just-opened"] {
        // make sure we start visible and expanded in the right view
        if phase(&state) == "Hidden" {
            crate::hotkeyhost::press_on_main(app);
            sleep(Duration::from_millis(700));
        }
        if !state.core.lock().expect("core lock").expanded {
            let plan = state.core.lock().expect("core lock").toggle(&io, area);
            apply_plan(app, &state, plan);
            sleep(Duration::from_millis(900));
        }
        if view != "overview" {
            crate::chathost::switch_view(app, &state, true);
            sleep(Duration::from_millis(if view == "chat-just-opened" { 120 } else { 1200 }));
        }
        if view == "settings-screen" {
            let _ = win.eval("document.dispatchEvent(new CustomEvent('abito:settings-select', { detail: 'accounts' }))");
            sleep(Duration::from_millis(700));
        }
        let before = json!({"phase": phase(&state), "visible": visible(&win), "expanded": state.core.lock().expect("core lock").expanded, "chat": state.core.lock().expect("core lock").chat});
        crate::hotkeyhost::press_on_main(app);
        sleep(Duration::from_millis(900));
        let after = json!({"phase": phase(&state), "visible": visible(&win)});
        rows.push(json!({"from": view, "before": before, "after_press": after}));
        if phase(&state) != "Hidden" {
            // a second press, to see whether it toggles the other way or stays visible
            crate::hotkeyhost::press_on_main(app);
            sleep(Duration::from_millis(900));
            rows.push(json!({"from": view, "second_press": {"phase": phase(&state), "visible": visible(&win)}}));
        }
    }
    emit(&json!({"step": "hotkey_hide_views", "rows": rows}));
    if phase(&state) == "Hidden" {
        crate::hotkeyhost::press_on_main(app);
        sleep(Duration::from_millis(700));
    }
}

/// #310 diagnosis (opt-in visual run): what the page DOES to the chat while a message is sent. The page
/// watches itself frame by frame — rows destroyed and recreated, the log and composer boxes, any frame in
/// which the visible chat is partly transparent or missing — and reports counts, not pictures.
fn send_flicker_diagnosis(app: &AppHandle) {
    if std::env::var("ABITO_PROBE_VISUAL").as_deref() != Ok("1") {
        return;
    }
    let state = app.state::<AppState>();
    let Some(page) = main_window(app) else { return };
    state.chat_probe.lock().expect("chat probe lock").clear();
    let start = "(() => { const S = { t0: performance.now(), frames: [], removed: 0, added: 0, replaced: 0, logWrites: 0, firstRowIds: [] };
      window.__flick = S;
      const log = document.getElementById('chat-log');
      new MutationObserver(ms => { for (const m of ms) { S.removed += m.removedNodes.length; S.added += m.addedNodes.length; if (m.removedNodes.length && m.addedNodes.length) S.replaced++; S.logWrites++; } })
        .observe(log, { childList: true });
      let prev = null;
      const tick = () => {
        const now = performance.now() - S.t0;
        const c = document.getElementById('chat'), i = document.getElementById('chat-input'), l = document.getElementById('chat-log');
        const cs = getComputedStyle(c);
        const rows = [...l.children].map(x => Math.round(x.getBoundingClientRect().top));
        const f = { t: Math.round(now), op: +cs.opacity, vis: cs.visibility, inh: i.getBoundingClientRect().height | 0, lh: l.getBoundingClientRect().height | 0,
          n: l.children.length, sc: Math.round(l.scrollTop), sh: l.scrollHeight, rows0: rows[0] === undefined ? null : rows[0], active: document.activeElement && document.activeElement.id };
        S.frames.push(f); prev = f;
        if (now < 2600) requestAnimationFrame(tick); else S.done = true;
      };
      requestAnimationFrame(tick); })()";
    let _ = page.eval(start);
    sleep(Duration::from_millis(300));
    let _ = page.eval("(window.__TAURI__.core.invoke)('chat_action', { payload: { action: 'submit', text: 'mensaje de diagnóstico', client_request_id: 'req-flick-0001' } })");
    sleep(Duration::from_millis(3000));
    let finish = "(async () => { const S = window.__flick; const invoke = (window.__TAURI__.core.invoke);
      const F = S.frames; let jumpsRow0 = 0, jumpsLog = 0, jumpsInput = 0, dips = 0, focusLoss = 0, scrollBack = 0, maxGap = 0;
      for (let k = 1; k < F.length; k++) {
        const a = F[k - 1], b = F[k];
        if (a.rows0 !== null && b.rows0 !== null && Math.abs(a.rows0 - b.rows0) > 1) jumpsRow0++;
        if (Math.abs(a.lh - b.lh) > 1) jumpsLog++;
        if (Math.abs(a.inh - b.inh) > 1) jumpsInput++;
        if (b.op < 1 || b.vis !== 'visible') dips++;
        if (a.active === 'chat-input' && b.active !== 'chat-input') focusLoss++;
        if (b.sc + 2 < a.sc) scrollBack++;
        maxGap = Math.max(maxGap, b.t - a.t);
      }
      const rowCounts = []; for (const f of F) if (rowCounts[rowCounts.length - 1] !== f.n) rowCounts.push(f.n);
      await invoke('record_chat_evidence', { evidence: { phase: 'flicker', frames: F.length, log_removed: S.removed, log_added: S.added, log_replaced: S.replaced,
        log_writes: S.logWrites, row0_jumps: jumpsRow0, log_height_jumps: jumpsLog, composer_height_jumps: jumpsInput, chat_opacity_dips: dips,
        focus_losses: focusLoss, scroll_back_moves: scrollBack, max_frame_gap_ms: Math.round(maxGap), row_count_sequence: rowCounts } }); })()";
    let _ = page.eval(finish);
    let lines = wait_chat_lines(app, 1, Duration::from_secs(10));
    emit(&json!({"step": "send_flicker", "webview": lines}));
}

fn chat_evidence(app: &AppHandle) {
    use abito_island::chatlane::{self, Target};
    use abito_island::fakemodel::{closed_port, FakeModel, FakeModelConfig, Reply};
    use abito_island::localmodel::LocalEndpoint;

    let state = app.state::<AppState>();
    let fake = FakeModel::start(FakeModelConfig {
        reply: Reply::Stream {
            reasoning: true,
            pieces: vec!["Hola, ".into(), "soy Abito ".into(), "(modelo local falso del probe).".into()],
            finish: "stop",
            gap_ms: 60,
        },
        ..Default::default()
    });
    let fake_target = |origin: &str| Target {
        endpoint: LocalEndpoint::parse(origin).expect("loopback origin"),
        alias: "Abito-gpt".into(),
        profile: chatlane::default_target().profile,
        max_output: 128,
    };
    // Probe-only registry: the verified local route is replaced by the
    // in-process fake (same profile id/alias), so the U2 gate admits it and
    // the real router is never contacted by the probe.
    let fake_origin: &'static str = Box::leak(fake.origin().into_boxed_str());
    let original_registry = state.models_registry.lock().expect("models registry lock").clone();
    *state.models_registry.lock().expect("models registry lock") = original_registry
        .iter()
        .map(|e| if e.profile_id == "local-abito-gpt" {
            abito_island::models::Entry { origin: fake_origin, ..*e }
        } else { *e })
        .collect();
    *state.chat_target.lock().expect("chat target lock") = Some(fake_target(&fake.origin()));

    let Some(win) = main_window(app) else { return };
    let io = TauriIo(&win);
    let scale = io.scale();
    let area = refresh_work_area(app, &state);
    let overview = geometry::scaled_size(geometry::ISLAND_WINDOW, scale);
    let chat_size = overview;
    let compact = overview;

    // expand (overview), then the `open` verb of the chat lane
    let plan = state.core.lock().expect("core lock").toggle(&io, area);
    apply_plan(app, &state, plan);
    wait_for_size(app, overview, Duration::from_secs(3));
    sleep(Duration::from_millis(400));
    crate::chathost::switch_view(app, &state, true);
    let opened = wait_for_size(app, chat_size, Duration::from_secs(3));
    sleep(Duration::from_millis(900)); // spring settles; availability check lands
    readback(app, "chat_open");
    if !opened {
        emit(&json!({"step": "chat_open", "warning": "window did not reach the chat size within 3s"}));
    }

    capture_visual(app, "chat-vacio");
    // §9.5 view change: overview -> chat -> overview, as clips (the view enters
    // after a 160 ms delay with a short spring; it exits in 160 ms).
    capture_sequence(app, "movimiento-vista-salida", 25, 1200, || {
        crate::chathost::switch_view(app, &state, false);
        wait_for_size(app, overview, Duration::from_secs(3));
    });
    capture_sequence(app, "movimiento-vista-entrada", 25, 1400, || {
        crate::chathost::switch_view(app, &state, true);
        wait_for_size(app, chat_size, Duration::from_secs(3));
    });
    sleep(Duration::from_millis(600));
    // CERTIFICATION: the same two view changes sampled from the page itself.
    // Warm-up (probe-only): after flipping gtk-enable-animations the first style
    // change of the session can still snap; run one page-driven round trip first.
    {
        let Some(page) = main_window(app) else { return };
        let _ = page.eval("window.__islandSetView('overview', 720, 240)");
        sleep(Duration::from_millis(500));
        let _ = page.eval("window.__islandSetView('chat', 720, 240)");
        sleep(Duration::from_millis(700));
    }
    let lines = sample_motion(app, "vista-salida", 1400, || {
        crate::chathost::switch_view(app, &state, false);
        wait_for_size(app, overview, Duration::from_secs(3));
    });
    emit(&json!({"step": "motion_sample", "scene": "vista-salida", "webview": lines}));
    let lines = sample_motion(app, "vista-entrada", 1600, || {
        crate::chathost::switch_view(app, &state, true);
        wait_for_size(app, chat_size, Duration::from_secs(3));
    });
    emit(&json!({"step": "motion_sample", "scene": "vista-entrada", "webview": lines}));
    // DIAGNOSTIC: the same view change driven only by the page (no native resize).
    let Some(page) = main_window(app) else { return };
    let lines = sample_motion(app, "vista-salida-solo-pagina", 1200, || {
        let _ = page.eval("window.__islandSetView('overview', 720, 240)");
    });
    emit(&json!({"step": "motion_sample", "scene": "vista-salida-solo-pagina", "webview": lines}));
    let _ = page.eval("window.__islandSetView('chat', 720, 240)");
    sleep(Duration::from_millis(700));
    // DIAGNOSTIC 2: native exit AGAIN, now that page-driven ones already ran
    // (is the snap a first-use artefact or the native route itself?).
    let lines = sample_motion(app, "vista-salida-nativa-2", 1200, || {
        crate::chathost::switch_view(app, &state, false);
        wait_for_size(app, overview, Duration::from_secs(3));
    });
    emit(&json!({"step": "motion_sample", "scene": "vista-salida-nativa-2", "webview": lines}));
    crate::chathost::switch_view(app, &state, true);
    wait_for_size(app, chat_size, Duration::from_secs(3));
    sleep(Duration::from_millis(700));
    sleep(Duration::from_millis(400));
    if let Err(e) = win.eval(CHAT_JS_SEND) {
        emit(&json!({"step": "chat_evidence", "eval_failed": e.to_string()}));
    }
    let lines = wait_chat_lines(app, 1, Duration::from_secs(20));
    sleep(Duration::from_millis(300));
    capture_visual(app, "chat-respondio");
    send_flicker_diagnosis(app);
    // now an unreachable local target: honest unavailable, no fallback
    let completions_before = fake.completions();
    // the registered local route goes down (registry + target follow it)
    let down_origin: &'static str =
        Box::leak(format!("http://127.0.0.1:{}", closed_port()).into_boxed_str());
    *state.models_registry.lock().expect("models registry lock") = original_registry
        .iter()
        .map(|e| if e.profile_id == "local-abito-gpt" {
            abito_island::models::Entry { origin: down_origin, ..*e }
        } else { *e })
        .collect();
    *state.chat_target.lock().expect("chat target lock") = Some(fake_target(down_origin));
    if let Err(e) = win.eval(CHAT_JS_DOWN) {
        emit(&json!({"step": "chat_evidence", "eval_failed": e.to_string()}));
    }
    let lines = if !lines.is_empty() { wait_chat_lines(app, 2, Duration::from_secs(20)) } else { lines };
    sleep(Duration::from_millis(300));
    capture_visual(app, "chat-modelo-caido");
    let seen: Vec<_> = fake.seen().iter().map(|s| json!({"method": s.method, "path": s.path})).collect();
    emit(&json!({
        "step": "chat_evidence",
        "pointer_input": "the webview drives the REAL chat_action IPC itself; no pointer events",
        "chat_visible": [geometry::chat_visible(area.h, scale).0, geometry::chat_visible(area.h, scale).1],
        "chat_native": [geometry::ISLAND_WINDOW.0, geometry::ISLAND_WINDOW.1],
        "fake_local_router": fake.origin(),
        "fake_requests": seen,
        "fake_requests_detail": "the GETs before the POST are the open-chat availability check and the turn preflight; no inference besides the one POST",
        "fake_completions_total": fake.completions(),
        "fake_completions_while_target_down": fake.completions() - completions_before,
        "webview": lines,
        "timed_out": lines.len() < 2,
    }));

    // models step reads the fake router again (registry points at it)
    *state.models_registry.lock().expect("models registry lock") = original_registry
        .iter()
        .map(|e| if e.profile_id == "local-abito-gpt" {
            abito_island::models::Entry { origin: fake_origin, ..*e }
        } else { *e })
        .collect();
    // One source of truth for the port: the target (header/aria) follows the
    // registry the listing is built from again, so both show the SAME origin
    // (the old PNG mixed the dead `down` port with the live fake).
    *state.chat_target.lock().expect("chat target lock") = Some(fake_target(fake_origin));
    let models_seen_before = fake.seen().len();
    // 12. models (U2): the picker panel of the same chat view, driven by the
    //     webview through the REAL models_action IPC. `refresh` reads only
    //     metadata (/health, /v1/models, /props, /slots) from the registry's
    //     selectable LOCAL router — never inference, never a diagnostic port.
    //     The probe keeps the selection in memory (no config file written).
    state.chat_probe.lock().expect("chat probe lock").clear();
    // Re-check availability against the repointed (live fake) target so the
    // chat state is fresh, not the stale answer from the closed port.
    let _ = win.eval("(window.__TAURI__.core.invoke)('chat_action', { payload: { action: 'check' } })");
    sleep(Duration::from_millis(600));
    let visual = std::env::var("ABITO_PROBE_VISUAL").as_deref() == Ok("1");
    if visual {
        let _ = win.eval("window.__abitoProbeHold = 3500");
    }
    if let Err(e) = win.eval(MODELS_JS) {
        emit(&json!({"step": "models_evidence", "eval_failed": e.to_string()}));
    }
    if visual {
        sleep(Duration::from_millis(2200)); // panel open + listing rendered, before JS closes it
        capture_visual(app, "modelos-elegido");
    }
    let lines = wait_chat_lines(app, 1, Duration::from_secs(20));
    emit(&json!({
        "step": "models_evidence",
        "pointer_input": "the webview drives the REAL models_action IPC itself; no pointer events",
        "persisted_config_dir": crate::modelshost::config_dir(app).map(|d| d.display().to_string()),
        "fake_requests_during_models": fake.seen()[models_seen_before..]
            .iter().map(|s| format!("{} {}", s.method, s.path)).collect::<Vec<_>>(),
        "fake_completions_total": fake.completions(),
        "webview": lines,
        "timed_out": lines.is_empty(),
    }));

    chat_state_scenes(app);
    // back to the overview (same window shrinks to 752x200), then collapse
    crate::chathost::switch_view(app, &state, false);
    let back = wait_for_size(app, overview, Duration::from_secs(3));
    sleep(Duration::from_millis(200));
    readback(app, "chat_back_to_overview");
    if !back {
        emit(&json!({"step": "chat_back_to_overview", "warning": "did not return to the overview size within 3s"}));
    }
    let plan = state.core.lock().expect("core lock").toggle(&io, area);
    apply_plan(app, &state, plan);
    wait_for_size(app, compact, Duration::from_secs(3));
    sleep(Duration::from_millis(200));
    readback(app, "chat_collapse");
    capture_visual(app, "compacta-calma");
    // restore the production target for the (exiting) process
    *state.models_registry.lock().expect("models registry lock") = original_registry;
    *state.chat_target.lock().expect("chat target lock") = Some(chatlane::default_target());
    fake.shutdown();
}

/// Webview side of the chat step, phase 1: measure the visible chat and its
/// controls, submit one message through `chat_action`, read the view until
/// the turn ends, and report.
const CHAT_JS_SEND: &str = r#"(async () => {
  const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)
    || (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);
  const rect = id => { const el = document.getElementById(id); if (!el) return null;
    const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };
  const ev = { phase: 'send' };
  try {
    const island = document.getElementById('island').getBoundingClientRect();
    ev.island_visible = [Math.round(island.width), Math.round(island.height)];
    ev.island_radius = getComputedStyle(document.getElementById('island')).borderTopLeftRadius;
    ev.view_attr = document.getElementById('capsule').dataset.view;
    ev.chat_hidden = document.getElementById('chat').inert;
    ev.controls = { back: rect('chat-back'), send: rect('chat-send'), input: rect('chat-input') };
    ev.reduced_motion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    ev.audio_elements = document.querySelectorAll('audio, video').length;
    ev.focus_in_composer_before_typing = document.activeElement === document.getElementById('chat-input');
    const before = await invoke('chat_action', { payload: { action: 'view' } });
    ev.availability_before = before.availability;
    ev.target = before.target;
    ev.producer = before.producer;
    try { await invoke('chat_action', { payload: { action: 'submit', text: 'hola', client_request_id: 'req-probe-0001', model: 'gpt-4' } });
      ev.smuggled_model_rejected = false; } catch (e) { ev.smuggled_model_rejected = e && e.code; }
    ev.accepted = await invoke('chat_action', { payload: { action: 'submit', text: '¿Quién sos?', client_request_id: 'req-probe-0001' } });
    ev.duplicate = await invoke('chat_action', { payload: { action: 'submit', text: '¿Quién sos?', client_request_id: 'req-probe-0001' } });
    const states = [];
    let last = null;
    for (let i = 0; i < 150; i++) {
      last = await invoke('chat_action', { payload: { action: 'view' } });
      const t = last.turns[last.turns.length - 1];
      if (t && states[states.length - 1] !== t.state) states.push(t.state);
      if (t && ['completed', 'error', 'cancelled'].includes(t.state)) break;
      await new Promise(r => setTimeout(r, 40));
    }
    await new Promise(r => setTimeout(r, 200));
    const turn = last.turns[last.turns.length - 1];
    ev.observed_states = states;
    ev.final = { state: turn.state, reply: turn.reply, finish_reason: turn.finish_reason, error: turn.error };
    ev.log_text = document.getElementById('chat-log').textContent;
    ev.status_text = document.getElementById('chat-status').textContent;
    ev.live_text = document.getElementById('chat-live').textContent;
  } catch (e) { ev.script_error = String(e && (e.message || e.code) || e); }
  await invoke('record_chat_evidence', { evidence: ev });
})();"#;

/// Phase 2: the local target is unreachable — `check` must say so, Send must
/// be disabled, and a submit must end `local_model_unavailable`.
const CHAT_JS_DOWN: &str = r#"(async () => {
  const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)
    || (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);
  const ev = { phase: 'target_down' };
  try {
    const checked = await invoke('chat_action', { payload: { action: 'check' } });
    ev.availability = checked.availability;
    await new Promise(r => setTimeout(r, 200));
    const input = document.getElementById('chat-input');
    input.value = 'hola';
    input.dispatchEvent(new Event('input'));
    ev.send_disabled_with_draft = document.getElementById('chat-send').disabled;
    ev.status_text = document.getElementById('chat-status').textContent;
    await invoke('chat_action', { payload: { action: 'submit', text: 'hola', client_request_id: 'req-probe-0002' } });
    let last = null;
    for (let i = 0; i < 100; i++) {
      last = await invoke('chat_action', { payload: { action: 'view' } });
      const t = last.turns[last.turns.length - 1];
      if (t && ['completed', 'error', 'cancelled'].includes(t.state)) break;
      await new Promise(r => setTimeout(r, 40));
    }
    const t = last.turns[last.turns.length - 1];
    ev.final = { state: t.state, reply: t.reply, error: t.error };
    input.value = '';
    input.dispatchEvent(new Event('input'));
  } catch (e) { ev.script_error = String(e && (e.message || e.code) || e); }
  await invoke('record_chat_evidence', { evidence: ev });
})();"#;

/// Chat state scenes (UI.3 evidence, opt-in `ABITO_PROBE_VISUAL=1`): REAL turns
/// through the real `chat_action` IPC against in-process fake local routers
/// (never the real router). One PNG per state on the sand background.
/// The lane conversation is reset between scenes (probe-only).
fn chat_state_scenes(app: &AppHandle) {
    use abito_island::chatlane::{self, Target};
    use abito_island::fakemodel::{FakeModel, FakeModelConfig, Reply};
    use abito_island::localmodel::LocalEndpoint;

    if std::env::var("ABITO_PROBE_VISUAL").as_deref() != Ok("1") {
        return;
    }
    let state = app.state::<AppState>();
    let Some(win) = main_window(app) else { return };
    let registry = state.models_registry.lock().expect("models registry lock").clone();
    let invoke = "(window.__TAURI__.core.invoke)";
    let say = |text: &str, id: &str| {
        format!(
            "{invoke}('chat_action', {{ payload: {{ action: 'submit', text: {}, client_request_id: '{id}' }} }})",
            serde_json::to_string(text).unwrap()
        )
    };
    let reset = |origin: &'static str| {
        *state.models_registry.lock().expect("models registry lock") = registry
            .iter()
            .map(|e| if e.profile_id == "local-abito-gpt" {
                abito_island::models::Entry { origin, ..*e }
            } else { *e })
            .collect();
        *state.chat_target.lock().expect("chat target lock") = Some(Target {
            endpoint: LocalEndpoint::parse(origin).expect("loopback origin"),
            alias: "Abito-gpt".into(),
            profile: chatlane::default_target().profile,
            max_output: 128,
        });
        {
            let mut lane = state.chat.lock().expect("chat lane lock");
            lane.convo = abito_island::chat::Conversation::new("c-island");
            lane.queue_note = None;
        }
        // the models panel (opened by the models step) must not cover the chat
        let _ = win.eval("(()=>{ if (!document.getElementById('models').inert) document.getElementById('models-close').click(); })()");
        let _ = win.eval(format!("{invoke}('chat_action', {{ payload: {{ action: 'check' }} }})"));
        sleep(Duration::from_millis(900));
    };
    let stream = |pieces: Vec<String>, gap_ms: u64, n_ctx: u64, busy: bool| FakeModelConfig {
        n_ctx,
        busy,
        reply: Reply::Stream { reasoning: false, pieces, finish: "stop", gap_ms },
        ..Default::default()
    };
    let cancel_js = format!(
        "(async()=>{{ const v = await {invoke}('chat_action', {{ payload: {{ action: 'view' }} }}); \
         if (v.active_turn) await {invoke}('chat_action', {{ payload: {{ action: 'cancel', turn_id: v.active_turn }} }}); }})()"
    );
    let scene = |cfg: FakeModelConfig, script: Vec<(String, u64, &str)>| {
        let fake = FakeModel::start(cfg);
        let origin: &'static str = Box::leak(fake.origin().into_boxed_str());
        reset(origin);
        for (js, wait_ms, name) in script {
            if !js.is_empty() {
                let _ = win.eval(js);
            }
            sleep(Duration::from_millis(wait_ms));
            if !name.is_empty() {
                capture_visual(app, name);
            }
        }
        fake.shutdown();
    };
    let words = |n: usize| vec!["palabra ".repeat(n)];

    // pensando -> cancelado (head sent, then silence: the turn stays «thinking»)
    scene(
        FakeModelConfig { reply: Reply::StallAfterHead, ..Default::default() },
        vec![
            (say("Contame algo largo", "req-v-0001"), 1300, "chat-pensando"),
            (cancel_js.clone(), 900, "chat-cancelado"),
        ],
    );
    // escribiendo
    scene(
        stream((0..12).map(|i| format!("parte {i} ")).collect(), 500, 65_536, false),
        vec![(say("¿Qué podés hacer?", "req-v-0002"), 1700, "chat-escribiendo")],
    );
    // error de turno
    scene(
        FakeModelConfig { reply: Reply::Status(500), ..Default::default() },
        vec![(say("hola", "req-v-0003"), 1500, "chat-error-turno")],
    );
    // cola (router busy)
    scene(
        stream(vec!["Ya voy ".into(), "terminando.".into()], 900, 65_536, true),
        vec![(say("¿Estás ahí?", "req-v-0004"), 900, "chat-cola")],
    );
    // cortado por largo (response limit 32 000)
    scene(
        FakeModelConfig {
            reply: Reply::Stream { reasoning: false, pieces: vec!["a".repeat(33_000)], finish: "stop", gap_ms: 0 },
            ..Default::default()
        },
        vec![(say("Escribí muchísimo", "req-v-0005"), 2500, "chat-cortado-por-largo")],
    );
    // recortado: tiny context window, several answered turns
    let mut turns = Vec::new();
    for i in 0..5 {
        turns.push((say(&"mensaje largo ".repeat(14), &format!("req-v-01{i}")), 1500, if i == 4 { "chat-recortado" } else { "" }));
    }
    scene(stream(words(8), 0, 700, false), turns);
    // chat largo + «Respuesta nueva» (scrolled up when the answer lands)
    let mut long = Vec::new();
    for i in 0..6 {
        long.push((say(&format!("pregunta {i}"), &format!("req-v-02{i}")), 1100, ""));
    }
    long.push(("document.getElementById('chat-log').scrollTop = 0".to_string(), 300, "chat-largo"));
    long.push((say("una más", "req-v-029"), 1500, "chat-largo-respuesta-nueva"));
    scene(stream(words(10), 0, 65_536, false), long);
    // Muy largo / caracteres no válidos: draft problems, no turn
    scene(
        FakeModelConfig::default(),
        vec![
            ("(()=>{const i=document.getElementById('chat-input'); i.value='x'.repeat(8001); i.dispatchEvent(new Event('input'));})()".into(), 500, "chat-muy-largo"),
            ("(()=>{const i=document.getElementById('chat-input'); i.value='hola\\u0001'; i.dispatchEvent(new Event('input'));})()".into(), 500, "chat-caracteres-no-validos"),
            ("(()=>{const i=document.getElementById('chat-input'); i.value=''; i.dispatchEvent(new Event('input'));})()".into(), 200, ""),
        ],
    );
    // «Ocupado» (router attending another request) and «Bloqueado» (model asleep:
    // sending would load it, so Abito refuses): availability states, no turn.
    scene(
        FakeModelConfig { busy: true, ..Default::default() },
        vec![(String::new(), 400, "chat-ocupado")],
    );
    scene(
        FakeModelConfig { sleeping: true, ..Default::default() },
        vec![(String::new(), 400, "chat-bloqueado")],
    );
    // models list with MORE than 3 rows (extra inventory-only diagnostics, never
    // contacted): the list scrolls, every row keeps its 44px.
    {
        let base = state.models_registry.lock().expect("models registry lock").clone();
        let mut many = base.clone();
        for (n, port) in [11020u16, 11021, 11022, 11023].into_iter().enumerate() {
            let id: &'static str = Box::leak(format!("diag-{port}").into_boxed_str());
            let origin: &'static str = Box::leak(format!("http://127.0.0.1:{port}").into_boxed_str());
            many.push(abito_island::models::Entry {
                profile_id: id,
                revision: 1,
                origin,
                alias: None,
                role: "diagnostic",
                lane_id: "none",
                kind: abito_island::models::Kind::Diagnostic {
                    state: if n % 2 == 0 { "unknown" } else { "unavailable" },
                    note: "Inventario de prueba del probe; no se consulta.",
                },
            });
        }
        *state.models_registry.lock().expect("models registry lock") = many;
        let _ = win.eval("(()=>{ if (document.getElementById('models').inert) document.getElementById('chat-models').click(); })()");
        sleep(Duration::from_millis(1600));
        capture_visual(app, "modelos-lista-larga");
        let _ = win.eval("document.getElementById('models-list').scrollTop = 9999");
        sleep(Duration::from_millis(400));
        capture_visual(app, "modelos-lista-larga-final");
        let _ = win.eval("document.getElementById('models-close').click()");
        sleep(Duration::from_millis(300));
        *state.models_registry.lock().expect("models registry lock") = base;
    }
    // «i» open on the models panel
    scene(
        FakeModelConfig::default(),
        vec![
            ("(()=>{ if (document.getElementById('models').inert) document.getElementById('chat-models').click(); })()".into(), 1500, ""),
            ("document.getElementById('models-info').click()".into(), 500, "modelos-i-abierto"),
            ("document.getElementById('models-close').click()".into(), 300, ""),
        ],
    );
    *state.models_registry.lock().expect("models registry lock") = registry;
    *state.chat_target.lock().expect("chat target lock") = Some(chatlane::default_target());
}

/// Webview side of the models step.
const MODELS_JS: &str = r#"(async () => {
  const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)
    || (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);
  const ev = { phase: 'models' };
  const code = async payload => { try { await invoke('models_action', { payload }); return 'accepted'; }
    catch (e) { return e && e.code; } };
  try {
    document.getElementById('chat-models').click();
    let listing = null;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 100));
      listing = await invoke('models_action', { payload: { action: 'list' } });
      if (listing.revision > 0) break;
    }
    await new Promise(r => setTimeout(r, 200));
    // Visual evidence only (opt-in): hold the panel open while Rust grabs it.
    if (window.__abitoProbeHold) await new Promise(r => setTimeout(r, window.__abitoProbeHold));
    ev.panel_visible = !document.getElementById('models').inert;
    ev.transcript_hidden = getComputedStyle(document.getElementById('chat-body')).display === 'none';
    ev.choice_note = listing.choice_note;
    ev.remote = listing.remote;
    ev.resources_text = listing.resources_text;
    ev.selected = listing.selected;
    ev.profiles = listing.profiles.map(p => ({ profile_id: p.profile_id, origin: p.origin, alias: p.alias,
      selectable: p.selectable, gate: p.gate, context_tokens: p.context_tokens,
      max_output_tokens: p.max_output_tokens, size_bytes: p.size_bytes, vision: p.vision }));
    ev.rendered_rows = Array.from(document.querySelectorAll('#models-list li')).map(li => ({
      text: li.querySelector('.model-text').textContent,
      button: li.querySelector('button').textContent,
      disabled: li.querySelector('button').disabled,
      size: [Math.round(li.querySelector('button').getBoundingClientRect().width),
             Math.round(li.querySelector('button').getBoundingClientRect().height)] }));
    ev.select_diagnostic = await code({ action: 'select', profile_id: 'diag-11014' });
    ev.select_unknown = await code({ action: 'select', profile_id: 'cloud-gpt' });
    ev.smuggled_origin = await code({ action: 'select', profile_id: 'local-abito-gpt', origin: 'http://api.openai.com:80' });
    ev.set_key = await code({ action: 'set_key', key: 'sk-test' });
    const chosen = await invoke('models_action', { payload: { action: 'select', profile_id: 'local-abito-gpt' } });
    ev.selected_after = chosen.selected;
    ev.persisted_after = chosen.persisted;
    const chat = await invoke('chat_action', { payload: { action: 'view' } });
    ev.chat_target_after = chat.target;
    document.getElementById('models-close').click();
    ev.panel_closed = document.getElementById('models').inert;
  } catch (e) { ev.script_error = String(e && (e.message || e.code) || e); }
  await invoke('record_chat_evidence', { evidence: ev });
})();"#;

fn a11y_evidence(app: &AppHandle) {
    let state = app.state::<AppState>();
    let Some(win) = main_window(app) else { return };
    let focused_at_start = win.is_focused().ok();
    crate::restore(app); // the second-instance path, minus the process
    sleep(Duration::from_millis(400));
    let focused_after_restore = win.is_focused().ok();
    let io = TauriIo(&win);
    let area = refresh_work_area(app, &state);
    let plan = state.core.lock().expect("core lock").toggle(&io, area);
    apply_plan(app, &state, plan);
    let scale = io.scale();
    wait_for_size(app, geometry::scaled_size(geometry::ISLAND_WINDOW, scale), Duration::from_secs(3));
    sleep(Duration::from_millis(900));
    state.chat_probe.lock().expect("chat probe lock").clear();
    if let Err(e) = win.eval(A11Y_JS) {
        emit(&json!({"step": "a11y_evidence", "eval_failed": e.to_string()}));
    }
    let lines = wait_chat_lines(app, 1, Duration::from_secs(10));
    state.chat_probe.lock().expect("chat probe lock").clear();
    let focused_after_expand = win.is_focused().ok();
    emit(&json!({
        "step": "a11y_evidence",
        "window_focused_at_start": focused_at_start,
        "window_focused_after_restore": focused_after_restore,
        "window_focused_after_expand": focused_after_expand,
        "focus_note": "tauri.conf focus:false; restore() shows without set_focus; only `--chat` focuses",
        "webview": lines,
        "timed_out": lines.is_empty(),
    }));
    let plan = state.core.lock().expect("core lock").toggle(&io, area);
    apply_plan(app, &state, plan);
    wait_for_size(app, geometry::scaled_size(geometry::ISLAND_WINDOW, scale), Duration::from_secs(3));
    sleep(Duration::from_millis(200));
}

const A11Y_JS: &str = r#"(async () => {
  const invoke = (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)
    || (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);
  const size = el => { const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };
  const rect = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)]; };
  const ev = { phase: 'a11y' };
  for (let i = 0; i < 40 && document.getElementById('capsule').dataset.phase !== 'expanded'; i++)
    await new Promise(r => setTimeout(r, 50));
  await new Promise(r => setTimeout(r, 250)); // opacity transition
  try {
    ev.view = document.getElementById('capsule').dataset.view;
    ev.phase_attr = document.getElementById('capsule').dataset.phase;
    const visible = Array.from(document.querySelectorAll('button')).filter(b => {
      const cs = getComputedStyle(b); const r = b.getBoundingClientRect();
      return !b.hidden && cs.visibility !== 'hidden' && cs.display !== 'none' && r.width > 1 && r.height > 1 &&
        !b.closest('[hidden]') && getComputedStyle(b.closest('section, div, main')).visibility !== 'hidden';
    });
    ev.visible_buttons = visible.map(b => ({ id: b.id, text: b.textContent, size: size(b) }));
    ev.all_visible_at_least_44 = visible.every(b => { const [w, h] = size(b); return w >= 44 && h >= 44; });
    ev.open_chat = { size: size(document.getElementById('open-chat')), rect: rect(document.getElementById('open-chat')) };
    ev.notices_rect = rect(document.getElementById('notices'));
    ev.permission_rect = rect(document.getElementById('permission'));
    ev.dismiss_size = size(document.getElementById('notice-dismiss'));
    ev.notice_live = { role: document.getElementById('notice-live').getAttribute('role'),
      aria_live: document.getElementById('notice-live').getAttribute('aria-live'),
      text: document.getElementById('notice-live').textContent };
    ev.island_toggle = { text: document.getElementById('island-toggle').textContent,
      aria_expanded: document.getElementById('island-toggle').getAttribute('aria-expanded') };
    ev.active_element = document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null;
    ev.document_has_focus = document.hasFocus();
    ev.audio_elements = document.querySelectorAll('audio, video').length;
  } catch (e) { ev.script_error = String(e && (e.message || e.code) || e); }
  await invoke('record_chat_evidence', { evidence: ev });
})();"#;

/// `YYYYMMDD-HHMMSS` stamp (UTC) for visual filenames — no chrono
/// dependency: civil-from-days (Howard Hinnant's algorithm) on top of
/// `SystemTime`.
fn visual_stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    let days = secs.div_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let (y, m) = if m <= 2 { (y + 1, m) } else { (y, m) };
    let sod = secs.rem_euclid(86_400);
    let (h, rem) = (sod / 3600, sod % 3600);
    let (mnt, sec) = (rem / 60, rem % 60);
    format!("{y:04}{m:02}{d:02}-{h:02}{mnt:02}{sec:02}")
}

/// Opt-in visual evidence (`ABITO_PROBE_VISUAL=1` + `ABITO_SOCKET_DIR`):
/// one PNG of OUR window only. ffmpeg `x11grab -window_id <wid>` reads the
/// island window's own drawable (found by `_NET_WM_PID`, FIX-B) — never the
/// root window, the desktop or another client; no pointer drawn; one frame.
/// Files: `<ABITO_SOCKET_DIR>/visual/<name>-<YYYYMMDD-HHMMSS>.png`
/// (gitignored `.runtime*`).
///
/// Known-background contract (UI.1 review): during the grab ONLY, the body
/// gets a solid sand class (`probe-capture-bg`, declared in style.css) so
/// radius, margins and the island contour are visible in the PNG; the class
/// is removed right after and production rendering never carries it.
fn capture_visual(app: &AppHandle, name: &str) {
    if std::env::var("ABITO_PROBE_VISUAL").as_deref() != Ok("1") {
        return;
    }
    let Some(root) = std::env::var_os("ABITO_SOCKET_DIR") else {
        emit(
            &json!({"step": "visual", "name": name, "error": "ABITO_SOCKET_DIR unset: nowhere private to write"}),
        );
        return;
    };
    let _ = app;
    let Some(page) = main_window(app) else { return }; // WebviewWindow, for the body class only
    let win = match abito_island::workarea::x11_find_own_window(abito_island::workarea::WINDOW_TITLE) {
        Ok(w) => w,
        Err(e) => {
            emit(&json!({"step": "visual", "name": name, "error": e.as_str()}));
            return;
        }
    };
    // Optional private output dir (UI.1 evidence); default stays `<root>/visual`.
    let dir = match std::env::var_os("ABITO_PROBE_VISUAL_DIR") {
        Some(custom) => std::path::PathBuf::from(custom),
        None => std::path::Path::new(&root).join("visual"),
    };
    if let Err(e) = std::fs::create_dir_all(&dir) {
        emit(&json!({"step": "visual", "name": name, "error": e.to_string()}));
        return;
    }
    let out = dir.join(format!("{name}-{}.png", visual_stamp()));
    // Known background behind the island for THIS frame only: probe-only
    // body class (declared in style.css), never present in production.
    let _ = page.eval("document.body.classList.add('probe-capture-bg')");
    sleep(Duration::from_millis(250)); // repaint before the grab
    let display = std::env::var("DISPLAY").unwrap_or_else(|_| ":0".into());
    let status = std::process::Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "x11grab",
            "-draw_mouse",
            "0",
        ])
        .args(["-window_id", &win.id.to_string()])
        .args(["-i", &display, "-frames:v", "1"])
        .arg(&out)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .output();
    let (ok, stderr) = match status {
        Ok(o) => (
            o.status.success(),
            String::from_utf8_lossy(&o.stderr).trim().to_string(),
        ),
        Err(e) => (false, e.to_string()),
    };
    let _ = page.eval("document.body.classList.remove('probe-capture-bg')");
    sleep(Duration::from_millis(150)); // repaint back to production look
    emit(&json!({
        "step": "visual",
        "name": name,
        "ok": ok,
        "path": out.display().to_string(),
        "window_id": format!("0x{:x}", win.id),
        "window_geometry": [win.x, win.y, win.w, win.h],
        "source": "x11grab -window_id (own window drawable only, matched by _NET_WM_PID)",
        "error": (!stderr.is_empty()).then_some(stderr),
    }));
}


/// Validator-only island route. Same actions/readback/capture as the long probe;
/// the external harness owns the display, WM and lifetime. No input injection.
#[cfg(target_os = "linux")]
fn island_validation(app: &AppHandle) {
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{ConnectionExt, CreateWindowAux, WindowClass, PropMode, AtomEnum, MapState};
    use x11rb::wrapper::ConnectionExt as _;
    let state = app.state::<AppState>();
    let Some(win) = main_window(app) else { return };
    let timeout = Duration::from_secs(8);
    let wait = |condition: &dyn Fn() -> bool| {
        let end = Instant::now() + timeout;
        while Instant::now() < end {
            if condition() { return true; }
            sleep(Duration::from_millis(50));
        }
        false
    };
    let scene = |name: &str, passed: bool, reason: &str, evidence: serde_json::Value| {
        readback(app, name);
        capture_visual(app, name);
        emit(&json!({"step":"validation_scene", "name":name,
            "verdict":if passed {"pass"} else {"fail"},
            "reason":if passed {serde_json::Value::Null} else {json!(reason)},
            "evidence":evidence}));
    };
    wait(&|| state.evidence.lock().expect("evidence").is_some());
    let scale = win.scale_factor().unwrap_or(1.0);
    let native_size = geometry::scaled_size(geometry::ISLAND_WINDOW, scale);
    let compact_size = wait_for_size(app, native_size, timeout);
    // Visible compact dimensions are measured from the page, not inferred from
    // the fixed native stage (which intentionally holds the expanded island).
    let page_state = |expected: &str| {
        state.chat_probe.lock().expect("chat probe").clear();
        let script = format!(r#"(async()=>{{const end=performance.now()+6000;
          let last="", stable=0; while(performance.now()<end){{
            const c=document.getElementById('capsule'), r=document.getElementById('island').getBoundingClientRect();
            const size=[Math.round(r.width*10),Math.round(r.height*10)].join(','); stable=size===last?stable+1:0;last=size;
            if(c.dataset.phase==={expected:?} && r.width>0 && r.height>0 && stable>=8){{
              await window.__TAURI__.core.invoke('record_chat_evidence',{{evidence:{{phase:c.dataset.phase,visible:[r.width,r.height],fold:(b=>[b.x+b.width/2,b.y+b.height/2])(document.getElementById('header-fold').getBoundingClientRect())}}}});return;
            }} await new Promise(r=>requestAnimationFrame(r));
          }} }})()"#);
        let _ = win.eval(script);
        wait_chat_lines(app, 1, timeout)
    };
    let compact = page_state("compact");
    let visible = compact.first().and_then(|v| v["visible"].as_array());
    let small = visible.map_or(false, |v| (v[0].as_f64().unwrap_or(0.0) - geometry::COMPACT_BAR.0 as f64).abs() <= 0.5 && (v[1].as_f64().unwrap_or(0.0) - geometry::COMPACT_BAR.1 as f64).abs() <= 0.5);
    scene("isla-compacta", compact_size && small, "tamaño compacto no observado", json!({"page":compact,"native_expected":[native_size.0,native_size.1]}));
    let above = wait(&|| abito_island::workarea::x11_find_own_window(abito_island::workarea::WINDOW_TITLE).map(|w| w.wm_state_above == Some(true)).unwrap_or(false));
    scene("isla-siempre-encima", above, "falta _NET_WM_STATE_ABOVE al arrancar", json!({"above":above}));
    let _ = crate::dispatch_action(app, &state, abito_island::bridge::Action::Expand, None);
    let expanded = page_state("expanded");
    scene("isla-expandir", !expanded.is_empty(), "la isla no se expandió", json!({"page":expanded}));
    let _ = crate::dispatch_action(app, &state, abito_island::bridge::Action::Close, None);
    let collapsed = page_state("compact");
    scene("isla-colapsar", !collapsed.is_empty(), "la isla no colapsó", json!({"page":collapsed}));
    let _ = crate::dispatch_action(app, &state, abito_island::bridge::Action::Expand, None);
    let expanded = page_state("expanded");
    if let (Some(point), Ok(pos)) = (expanded.first().and_then(|v|v["fold"].as_array()), win.outer_position()) {
        emit(&json!({"step":"validation_input","kind":"click","x":pos.x+(point[0].as_f64().unwrap_or(0.0)*scale) as i32,"y":pos.y+(point[1].as_f64().unwrap_or(0.0)*scale) as i32}));
    }
    let minimized = page_state("compact");
    scene("isla-minimizar", !minimized.is_empty(), "Minimizar Abito no colapsó la isla", json!({"page":minimized,"input":"XTest click by external validator on real header-fold button"}));

    // Use the identical callback used by X11/portal shortcuts, not a direct show.
    let first_press = Instant::now();
    crate::hotkeyhost::press_on_main(app);
    let hidden = wait(&|| !win.is_visible().unwrap_or(true));
    // Reproduce Mutter's loss of ABOVE on withdrawal deterministically even on
    // Openbox, which may preserve it. Without this the regression can false-pass.
    let _ = win.set_always_on_top(false);
    let result = (|| -> Result<serde_json::Value, String> {
        let (conn, screen) = x11rb::connect(None).map_err(|e| e.to_string())?;
        let root = conn.setup().roots[screen].root;
        let atom = |name: &[u8]| -> Result<u32,String> {
            conn.intern_atom(false,name).map_err(|e|e.to_string())?.reply().map(|r|r.atom).map_err(|e|e.to_string())
        };
        let rival = conn.generate_id().map_err(|e|e.to_string())?;
        conn.create_window(0,rival,root,0,0,1000,700,0,WindowClass::INPUT_OUTPUT,0,
            &CreateWindowAux::new().background_pixel(0x336699)).map_err(|e|e.to_string())?;
        conn.change_property8(PropMode::REPLACE,rival,AtomEnum::WM_NAME,AtomEnum::STRING,b"Abito validator rival").map_err(|e|e.to_string())?;
        conn.map_window(rival).map_err(|e|e.to_string())?;
        conn.flush().map_err(|e|e.to_string())?;
        let stacking = atom(b"_NET_CLIENT_LIST_STACKING")?;
        let stack = || -> Vec<u32> {
            conn.get_property(false,root,stacking,AtomEnum::WINDOW,0,4096).ok()
                .and_then(|c|c.reply().ok()).and_then(|r|r.value32().map(|v|v.collect())).unwrap_or_default()
        };
        let rival_ready = wait(&|| stack().contains(&rival));
        let before = stack();
        // Two deliberate presses, not duplicate reports from two backends.
        wait(&|| first_press.elapsed() >= Duration::from_millis(abito_island::hotkey::PRESS_DEDUP_MS + 50));
        crate::hotkeyhost::press_on_main(app);
        wait(&|| win.is_visible().unwrap_or(false) && abito_island::workarea::x11_find_own_window(abito_island::workarea::WINDOW_TITLE).is_ok());
        let own = abito_island::workarea::x11_find_own_window(abito_island::workarea::WINDOW_TITLE).map_err(|e|e.as_str().to_owned())?.id;
        let mapped = || conn.get_window_attributes(own).ok().and_then(|c|c.reply().ok()).map(|a|a.map_state == MapState::VIEWABLE).unwrap_or(false);
        let on_top = wait(&|| {
            let list = stack();
            let order = match (list.iter().position(|w| *w==own), list.iter().position(|w| *w==rival)) {
                (Some(a),Some(b)) => a>b, _=>false
            };
            mapped() && order && abito_island::workarea::x11_find_own_window(abito_island::workarea::WINDOW_TITLE).map(|w|w.wm_state_above == Some(true)).unwrap_or(false)
        });
        // Keep the rival connection alive until after the capture.
        let evidence = json!({"hidden":hidden,"rival_ready":rival_ready,"rival":rival,"own":own,"stack_before":before,"stack_after":stack(),"mapped":mapped(),"above":abito_island::workarea::x11_find_own_window(abito_island::workarea::WINDOW_TITLE).map(|w|w.wm_state_above == Some(true)).unwrap_or(false),"withdrawal_fixture":"clear ABOVE while hidden, as Mutter does","input":"hotkeyhost::press_on_main, same shortcut callback; not injected keys"});
        scene("isla-atajo-sobre-rival", hidden && rival_ready && on_top, "atajo no restauró la isla mapeada y encima del rival con ABOVE", evidence);
        Ok(json!(true))
    })();
    if let Err(error) = result {
        scene("isla-atajo-sobre-rival", false, &error, json!({"error":error}));
    }
    feature_validation(app);
}

#[cfg(not(target_os = "linux"))]
fn island_validation(_app: &AppHandle) {
    emit(&json!({"step":"validation_scene","name":"isla","verdict":"unverifiable","reason":"requiere X11"}));
}

/// T3/T4 use the real WebViews and real IPC. Only the feature-gated probe
/// includes this driver; XTest remains in the external validator process.
#[cfg(target_os = "linux")]
fn feature_validation(app: &AppHandle) {
    use tauri::Listener;
    use std::sync::{Arc, Mutex};
    use std::io::{BufRead, BufReader};
    use std::os::unix::net::UnixStream;
    use abito_island::fakemodel::{FakeModel, FakeModelConfig, Reply};
    use abito_island::chatlane::{self, Target};
    use abito_island::localmodel::LocalEndpoint;
    let state = app.state::<AppState>();
    let Some(win) = main_window(app) else { return };
    app.add_capability(tauri::ipc::CapabilityBuilder::new("validator-only")
        .windows(["main","settings"]).permission("core:event:allow-emit"))
        .expect("probe-only event evidence");
    // The validator never opens a real terminal on the shared desktop: the ↗
    // button's launch is replaced by a counter the page can read back.
    {
        let page = win.clone();
        abito_island::focushost::validation_launcher::install(move || {
            let _ = page.eval("window.__validatorTerminalLaunches=(window.__validatorTerminalLaunches||0)+1;");
        });
    }
    let result = Arc::new(Mutex::new(None::<serde_json::Value>));
    let sink = result.clone();
    let result_listener = app.listen("validate-result", move |event| {
        *sink.lock().expect("validator result") = serde_json::from_str(event.payload()).ok();
    });
    let input_listener = app.listen("validate-input", |event| {
        if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(event.payload()) {
            value["step"] = json!("validation_input"); emit(&value);
        }
    });
    let install = |page: &tauri::WebviewWindow| {
        let pos = page.inner_position().unwrap_or_default();
        let scale = page.scale_factor().unwrap_or(1.0);
        let _ = page.eval(format!("window.__validateOrigin={{x:{},y:{},scale:{}}};",pos.x,pos.y,scale));
        let _ = page.eval(include_str!("../packaging/validate/browser.js"));
    };
    let run = |page: &tauri::WebviewWindow, expression: &str| -> serde_json::Value {
        let began = Instant::now();
        emit(&json!({"step":"validation_driver_start","expression":expression}));
        install(page);
        *result.lock().expect("validator result") = None;
        state.chat_probe.lock().expect("chat probe").clear();
        let _ = page.eval(format!("try{{window.AbitoValidate.run(async()=>({expression})).catch(e=>window.__TAURI__.core.invoke('record_chat_evidence',{{evidence:{{diagnostic:String(e)}}}}))}}catch(e){{window.__TAURI__.core.invoke('record_chat_evidence',{{evidence:{{diagnostic:String(e),driver:typeof window.AbitoValidate}}}})}}"));
        let end = Instant::now() + Duration::from_secs(if expression.contains("edgeIdle") { 80 } else { 30 });
        while Instant::now() < end {
            if let Some(value) = result.lock().expect("validator result").take() {
                emit(&json!({"step":"validation_driver_result","expression":expression,"elapsed_ms":began.elapsed().as_millis(),"observation":value}));
                return value;
            }
            if let Some(value)=state.chat_probe.lock().expect("chat probe").pop() {
                emit(&json!({"step":"validation_diagnostic","value":value}));
                return json!({"ok":false,"reason":value});
            }
            sleep(Duration::from_millis(40));
        }
        json!({"ok":false,"reason":format!("sin respuesta del navegador: {expression}")})
    };
    // Capture only our private nonzero Xvfb screen. For Settings this also
    // proves the separate window, rather than re-capturing the island.
    let record = |name: &str, observation: serde_json::Value| {
        if let (Ok(display), Ok(dir)) = (std::env::var("DISPLAY"), std::env::var("ABITO_PROBE_VISUAL_DIR")) {
            if display.starts_with(':') && display.split('.').next() != Some(":0") {
                let out = std::path::Path::new(&dir).join(format!("{name}.png"));
                let status = std::process::Command::new("timeout").args(["8s","ffmpeg","-hide_banner","-loglevel","error","-y","-f","x11grab","-draw_mouse","0","-video_size","1280x900","-i",&display,"-frames:v","1"]).arg(&out).output();
                emit(&json!({"step":"visual","name":name,"path":out,"ok":status.as_ref().map(|o|o.status.success()).unwrap_or(false),"source":"private Xvfb only"}));
            }
        }
        emit(&json!({"step":"validation_observation","name":name,"observation":observation}));
    };
    let context_fixture = validator_context::start();
    install(&win);
    let _ = crate::dispatch_action(app, &state, abito_island::bridge::Action::Expand, None);
    sleep(Duration::from_millis(500));
    record("dictado-inactivo", run(&win,"AbitoValidate.dictationIdle()"));
    record("isla-ausencia", run(&win,"AbitoValidate.edgeIdle()"));
    record("isla-borde-regreso", run(&win,"AbitoValidate.edgeWake()"));
    record("isla-hover-pin-ocultar", run(&win,"AbitoValidate.islandHoverPin()"));
    record("sesiones-motor", run(&win,"AbitoValidate.sessions()"));
    record("sesiones-foco-pildoras", run(&win,"AbitoValidate.sessionsFocus()"));
    let _ = run(&win,"AbitoValidate.restoreSessionFocus()");
    record("sin-motor-sin-productor", run(&win,"AbitoValidate.connection(false)"));

    let fake = FakeModel::start(FakeModelConfig {reply:Reply::Stream {reasoning:false,pieces:vec!["respuesta del validador".into()],finish:"stop",gap_ms:600},..Default::default()});
    let origin: &'static str = Box::leak(fake.origin().into_boxed_str());
    {
        let mut registry=state.models_registry.lock().expect("registry");
        for entry in registry.iter_mut() {if entry.profile_id=="local-abito-gpt" {entry.origin=origin;}}
    }
    *state.chat_target.lock().expect("target") = Some(Target {endpoint:LocalEndpoint::parse(origin).expect("loopback"),alias:"Abito-gpt".into(),profile:chatlane::default_target().profile,max_output:128});
    crate::chathost::switch_view(app, &state, true);
    sleep(Duration::from_millis(600));
    let first = run(&win,"AbitoValidate.chatFirst()");
    if first["ok"] == true {
        let _ = app.emit("chat:state", &first["stale"]);
        sleep(Duration::from_millis(250));
        record("chat-segundo-turno",run(&win,"AbitoValidate.chatSecond()"));
    } else { record("chat-segundo-turno",first); }
    let mut context_results = Vec::new();
    for enabled in [false, true, false] {
        use std::sync::atomic::Ordering;
        let reads_before = context_fixture.1.load(Ordering::SeqCst);
        let seen_before = fake.seen().len();
        let mut observation = run(&win, &format!("AbitoValidate.contextMessage({enabled})"));
        let reads_after = context_fixture.1.load(Ordering::SeqCst);
        let seen = fake.seen();
        let body = seen.iter().skip(seen_before).find(|r| r.path == "/v1/chat/completions")
            .and_then(|r| serde_json::from_str::<serde_json::Value>(&r.body).ok()).unwrap_or_default();
        let users = body["messages"].as_array().map(|rows| rows.iter().filter(|r| r["role"] == "user").collect::<Vec<_>>()).unwrap_or_default();
        let first = users.first().map(|r| r["content"].to_string()).unwrap_or_default();
        let prefix = "Context — App: Writer del validador, Window: Documento privado del validador";
        observation["ok"] = json!(observation["ok"] == true && users.len() == 1
            && first.contains("Mensaje privado de contexto")
            && if enabled { first.contains(prefix) && reads_after > reads_before }
                else { !first.contains("Context — App:") && reads_after == reads_before });
        observation["reads_before"] = json!(reads_before);
        observation["reads_after"] = json!(reads_after);
        observation["model_user_message"] = json!(first);
        context_results.push(observation);
    }
    record("chat-contexto-ventana", json!({"ok":context_results.iter().all(|r|r["ok"]==true),"cases":context_results,"url":"unsupported: app/title only (L53 / #483 S3)","source":"fake GNOME extension on private validator bus"}));
    fake.shutdown();
    crate::chathost::switch_view(app, &state, false);
    sleep(Duration::from_millis(500));
    // This is the test producer used by transport_receiver.rs, on the actual
    // receiver endpoint (the ABITO_DESKTOP_SOCKET used by the Pi adapter).
    let producer_began = Instant::now();
    let producer = (|| -> Result<(),String> {
        let endpoint = state.transport.lock().expect("transport").as_ref().map(|t|t.endpoint().to_path_buf()).ok_or("sin receptor")?;
        let stream = UnixStream::connect(endpoint).map_err(|e|e.to_string())?;
        stream.set_read_timeout(Some(Duration::from_secs(4))).map_err(|e|e.to_string())?;
        stream.set_write_timeout(Some(Duration::from_secs(4))).map_err(|e|e.to_string())?;
        let mut reader = BufReader::new(stream.try_clone().map_err(|e|e.to_string())?);
        let producer = validator_producer::Producer::start(stream.try_clone().map_err(|e|e.to_string())?, state.project.clone());
        let read = |reader:&mut BufReader<UnixStream>| -> Result<String,String> {let mut line=String::new();reader.read_line(&mut line).map_err(|e|e.to_string())?;Ok(line)};
        producer.send(json!({"type":"hello"}))?;
        let ready=read(&mut reader)?;
        if ready.as_bytes()!=abito_island::protocol::READY_LINE {return Err(format!("hello: {ready}"));}
        if std::env::var("ABITO_PROBE_VALIDATE_PRODUCER_FAILURE").as_deref() == Ok("1") {
            stream.shutdown(std::net::Shutdown::Both).map_err(|e|e.to_string())?;
            producer.send(json!({"type":"heartbeat"}))?;
        }
        record("sin-motor-con-productor",run(&win,"AbitoValidate.connection(true)"));
        let notice_edge=run(&win,"AbitoValidate.prepareNoticeEdge()");
        producer.send(json!({"type":"settled","id":"validator-notice","projectName":"Validador","agent":"pi"}))?;
        let mut notice=run(&win,"AbitoValidate.notice()");
        notice["edge_before"]=notice_edge.clone();
        notice["ok"]=json!(notice["ok"]==true && notice_edge["ok"]==true);
        record("pi-aviso",notice);
        let cycle_prepared=run(&win,"AbitoValidate.prepareNoticeCycle()");
        producer.send(json!({"type":"settled","id":"validator-cycle-1","projectName":"Ciclo uno","agent":"pi"}))?;
        producer.send(json!({"type":"settled","id":"validator-cycle-2","projectName":"Ciclo dos","agent":"pi"}))?;
        let mut cycle=run(&win,"AbitoValidate.noticeCycle()");
        cycle["prepared"]=cycle_prepared.clone();
        cycle["ok"]=json!(cycle["ok"]==true && cycle_prepared["ok"]==true);
        record("avisos-ciclo",cycle);
        // A private, clearly identified terminal-class fixture, not an actual
        // session. Keep the X11 connection alive through native focus readback.
        use x11rb::connection::Connection;
        use x11rb::protocol::xproto::{ConnectionExt, CreateWindowAux, WindowClass, PropMode, AtomEnum};
        use x11rb::wrapper::ConnectionExt as _;
        let (terminal_conn, screen) = x11rb::connect(None).map_err(|e|e.to_string())?;
        let root = terminal_conn.setup().roots[screen].root;
        let terminal = terminal_conn.generate_id().map_err(|e|e.to_string())?;
        terminal_conn.create_window(0,terminal,root,20,320,340,180,0,WindowClass::INPUT_OUTPUT,0,
            &CreateWindowAux::new().background_pixel(0x223344)).map_err(|e|e.to_string())?;
        terminal_conn.change_property8(PropMode::REPLACE,terminal,AtomEnum::WM_CLASS,AtomEnum::STRING,b"validator-terminal\0XTerm\0").map_err(|e|e.to_string())?;
        terminal_conn.change_property8(PropMode::REPLACE,terminal,AtomEnum::WM_NAME,AtomEnum::STRING,b"Validator terminal class fixture (not a session)").map_err(|e|e.to_string())?;
        terminal_conn.map_window(terminal).map_err(|e|e.to_string())?;
        terminal_conn.flush().map_err(|e|e.to_string())?;
        sleep(Duration::from_millis(400));
        let mut shortcuts=run(&win,"AbitoValidate.shortcutDispatch()");
        let active=abito_island::hotkey::x11::active_window(None);
        shortcuts["terminal_native"]=json!({"expected":terminal,"active":active,"class_only":true});
        shortcuts["ok"]=json!(shortcuts["ok"]==true && active==Some(terminal));
        producer.send(json!({"type":"questions_hello","questionVersion":1}))?;
        let ready=read(&mut reader)?;
        if !ready.contains("questions_ready") {return Err(format!("questions hello: {ready}"));}
        let approval_id="3f2b8a42-1c2d-4e5f-8a6b-7c8d9e0f1a2b";
        producer.send(json!({"type":"question","questionVersion":1,"id":approval_id,"kind":"approval","text":"¿Permitir la operación del validador?","options":[{"value":"allow","label":"Permitir","description":""},{"value":"deny","label":"Denegar","description":""}],"allowFreeText":false,"expiresAt":crate::now_ms() as u64+120_000}))?;
        let approval_alert=run(&win,"AbitoValidate.shortcutAlert()");
        shortcuts["approval_alert"]=approval_alert.clone();
        shortcuts["ok"]=json!(shortcuts["ok"]==true && approval_alert["ok"]==true && approval_alert["after"]["id"]==approval_id);
        // Only the producer retires this fixture; the shortcut never answers it.
        producer.send(json!({"type":"question_cancel","questionVersion":1,"id":approval_id,"reason":"cancelled"}))?;
        let cancel_deadline=Instant::now()+Duration::from_secs(4);
        while !crate::questionhost::question_view(&state)["pending"].is_null() && Instant::now()<cancel_deadline {
            sleep(Duration::from_millis(40));
        }
        let id="3f2b8a41-1c2d-4e5f-8a6b-7c8d9e0f1a2b";
        producer.send(json!({"type":"question","questionVersion":1,"id":id,"kind":"question","text":"¿Validar esta pantalla?","options":[{"value":"validate","label":"Validar","description":""},{"value":"cancel","label":"Cancelar","description":""}],"allowFreeText":false,"expiresAt":crate::now_ms() as u64+120_000}))?;
        let pending_deadline=Instant::now()+Duration::from_secs(4);
        while crate::questionhost::question_view(&state)["pending"].is_null() && Instant::now()<pending_deadline {
            sleep(Duration::from_millis(40));
        }
        let pending_before=crate::questionhost::question_view(&state)["pending"].clone();
        let alert=run(&win,"AbitoValidate.shortcutAlert()");
        let pending_after=crate::questionhost::question_view(&state)["pending"].clone();
        shortcuts["alert"]=alert.clone();
        shortcuts["ok"]=json!(shortcuts["ok"]==true && alert["ok"]==true && pending_before==pending_after && !pending_after.is_null());
        shortcuts["pending_native_before"]=pending_before;
        shortcuts["pending_native_after"]=pending_after;
        drop(terminal_conn);
        sleep(Duration::from_millis(300));
        let absent=run(&win,"AbitoValidate.shortcutTerminalAbsent()");
        shortcuts["ok"]=json!(shortcuts["ok"]==true && absent["ok"]==true);
        shortcuts["terminal_absent"]=absent;
        record("atajos-chat-alerta-terminal-sonido",shortcuts);
        let mut observation=run(&win,"AbitoValidate.answerQuestion()");
        if observation["ok"]==true {
            let answer:serde_json::Value=serde_json::from_str(&read(&mut reader)?).map_err(|e|e.to_string())?;
            observation["ok"]=json!(answer["type"]=="answer" && answer["id"]==id && answer["answer"]["value"]=="validate");
            observation["producer_received"]=answer;
            observation["reason"]=json!("respuesta no llegó al productor Pi");
        }
        record("pi-pregunta",observation);
        Ok(())
    })();
    if let Err(error)=producer {
        emit(&json!({"step":"validation_producer_error","reason":error,"elapsed_ms":producer_began.elapsed().as_millis()}));
    }
    // T5 uses the production IPC and real exported tray menu, never private handlers.
    let github_detail=run(&win,"AbitoValidate.github()");
    record("integracion-github",github_detail.clone());
    record("github-detalle",github_detail);
    record("correo-keyring",run(&win,"AbitoValidate.mail()"));

    // Original silent PCM fixtures, private validator config only. No reference audio.
    let sound_dir=app.path().app_config_dir().expect("private app config").join("sounds");
    std::fs::create_dir_all(&sound_dir).expect("private sounds folder");
    let wav: &[u8]=b"RIFF\x26\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\x40\x1f\x00\x00\x80\x3e\x00\x00\x02\x00\x10\x00data\x02\x00\x00\x00\x00\x00";
    for stem in abito_island::sounds::STEMS {
        std::fs::write(sound_dir.join(format!("{stem}.wav")),wav).expect("private own PCM cue");
    }
    record("sonidos-controles",run(&win,"AbitoValidate.sounds()"));
    record("sonidos-audible",json!({"ok":true,"unverifiable":"sin salida de audio privada: no se puede afirmar que se oye"}));
    #[cfg(target_os="linux")]
    {
        let calls=Arc::new(Mutex::new(Vec::new()));
        let fake=validator_spotify::fake(calls.clone());
        let mut observation=run(&win,"AbitoValidate.spotify()");
        let received=calls.lock().expect("fake calls").clone();
        observation["ok"]=json!(observation["ok"]==true && received.iter().filter(|s|s.as_str()=="PlayPause").count()==2);
        observation["fake_received"]=json!(received);
        record("spotify-reproductor",observation);
        record("spotify-artwork-fallback",run(&win,"AbitoValidate.spotifyFallback()"));
        drop(fake);
    }
    let tray=|action:&str| -> serde_json::Value {
        let output=std::process::Command::new("timeout").args(["12s","/usr/bin/python3"])
            .arg(concat!(env!("CARGO_MANIFEST_DIR"),"/packaging/validate/tray.py")).arg(action).output();
        match output { Ok(out) => serde_json::from_slice(&out.stdout).unwrap_or_else(|_|json!({"ok":false,"reason":String::from_utf8_lossy(&out.stderr)})), Err(e)=>json!({"ok":false,"reason":e.to_string()}) }
    };
    let mut menu=tray("hide");
    sleep(Duration::from_millis(350));
    let hidden=!win.is_visible().unwrap_or(true);
    let shown=tray("show");
    sleep(Duration::from_millis(350));
    menu["ok"]=json!(menu["ok"]==true && shown["ok"]==true && hidden && win.is_visible().unwrap_or(false));
    menu["hidden_after_hide"]=json!(hidden);
    menu["shown_after_show"]=json!(win.is_visible().unwrap_or(false));
    record("bandeja-menu",menu);
    let entry=std::path::PathBuf::from(std::env::var("XDG_CONFIG_HOME").expect("private config")).join("autostart/abito-island.desktop");
    let on=tray("autostart");
    sleep(Duration::from_millis(350));
    let text=std::fs::read_to_string(&entry).unwrap_or_default();
    let off=tray("autostart");
    sleep(Duration::from_millis(350));
    record("autoinicio",json!({"ok":on["ok"]==true && off["ok"]==true && text.lines().any(|s|s=="Name=Koda") && text.contains(" --autostart") && !entry.exists(),"written":text,"removed":!entry.exists(),"on":on,"off":off}));
    let mut character=run(&win,"AbitoValidate.character(true)");
    sleep(Duration::from_millis(250));
    let mapped=app.get_webview_window("character").map(|w|w.is_visible().unwrap_or(false) && w.is_always_on_top().unwrap_or(false)).unwrap_or(false);
    let off=run(&win,"AbitoValidate.character(false)");
    let unmapped=app.get_webview_window("character").is_none_or(|w|!w.is_visible().unwrap_or(true));
    character["ok"]=json!(character["ok"]==true && off["ok"]==true && mapped && unmapped);
    character["mapped_and_above"]=json!(mapped);character["unmapped_after_off"]=json!(unmapped);
    record("personaje-escritorio",character);
    let _ = crate::dispatch_action(app, &state, abito_island::bridge::Action::Expand, None);
    sleep(Duration::from_millis(500));
    let gear=run(&win,"AbitoValidate.gear()");
    let end=Instant::now()+Duration::from_secs(10);
    let settings=loop {
        if let Some(page)=app.get_webview_window("settings") {break Some(page);}
        if Instant::now()>=end {break None;}
        sleep(Duration::from_millis(50));
    };
    let mut gear=gear;
    gear["ok"]=json!(gear["ok"]==true && settings.is_some());
    record("ajustes-engranaje",gear);
    if let Some(page)=settings {
        sleep(Duration::from_millis(1000));
        install(&page);
        let _ = page.eval(concat!("window.__validatePages=",include_str!("../packaging/validate/pages.json"),";"));
        let catalog:serde_json::Value=serde_json::from_str(include_str!("../packaging/validate/pages.json")).expect("page catalog");
        for (index,id) in catalog.as_array().expect("pages").iter().enumerate() {
            let id=id.as_str().expect("page id");
            if id == "flowsettings" {
                let legacy=crate::autostart::desktop_entry(&std::env::current_exe().unwrap()).unwrap().replace(" --autostart", "");
                std::fs::write(&entry,legacy).expect("private legacy autostart fixture");
            }
            let mut observation=run(&page,&format!("AbitoValidate.hub({index},{id:?})"));
            if id == "styles" {
                let effect = validator_context::styles_effect();
                observation["ok"] = json!(observation["ok"]==true && effect["ok"]==true);
                observation["cleanup_stub"] = effect;
            }
            if id == "flowsettings" {
                let migrated=std::fs::read_to_string(&entry).unwrap_or_default().contains(" --autostart");
                observation["legacyAutostartUpgraded"]=json!(migrated);
                observation["ok"]=json!(observation["ok"]==true && migrated);
                let _=crate::trayhost::set_autostart(app,false);
            }
            record(&format!("ajustes-{id}"),observation);
        }
        record("atajos-catalogo",run(&page,"AbitoValidate.hotkeys()"));
        record("atajos-grabar-borrar",run(&page,"AbitoValidate.recordHotkey()"));
        crate::dictationhost::seed_validation(app);
        record("dictado-repegar", run(&page,"AbitoValidate.dictationRepaste()"));
        let mut history = run(&page,"AbitoValidate.dictationHistory()");
        let clipboard = std::process::Command::new("wl-copy").arg("--read").output();
        let copied = clipboard.ok().filter(|o|o.status.success()).map(|o|String::from_utf8_lossy(&o.stdout).into_owned());
        history["clipboard_readback"] = json!(copied);
        history["ok"] = json!(history["ok"] == true && copied.as_deref() == Some("Dictado privado del validador"));
        record("dictado-historial", history);
        record("dictado-sin-modelo",run(&page,"AbitoValidate.noModel('dictation')"));
        record("voz-sin-modelo",run(&page,"AbitoValidate.noModel('voice')"));
        record("voz-reconocimiento",json!({"ok":true,"unverifiable":"sin micrófono ni modelos: dictado real, wake word y reconocimiento no comprobables"}));
        record("ajustes-cuentas-keyring",json!({"ok":true,"unverifiable":"sin servicio de secretos privado; no se leen claves del usuario"}));
        // Release only our fake name, then reload Settings through its normal IPC.
        drop(context_fixture.0);
        let chat_index = catalog.as_array().unwrap().iter().position(|v| v == "chat").unwrap();
        record("ajustes-contexto-sin-extension", run(&page,&format!("AbitoValidate.contextMissing({chat_index})")));
    }
    if let Ok(origin) = std::env::var("ABITO_VALIDATE_INTEGRATIONS") {
        let mut results=Vec::new();
        for mode in ["missing_key","error","ready","stale"] {
            crate::integrationshost::set_validation_fixture(Some(&origin),mode);
            results.push(run(&win,&format!("AbitoValidate.integrationStates({mode:?})")));
        }
        crate::integrationshost::set_validation_fixture(None,"off");
        let opened=std::env::var("HOME").ok().and_then(|h|std::fs::read_to_string(std::path::Path::new(&h).join("opened-urls")).ok()).unwrap_or_default();
        let links=["https://n8n.io","https://vercel.com","https://stripe.com","https://resend.com","https://www.notion.so","https://cal.com"];
        record("integraciones-estados",json!({"ok":results.iter().all(|r|r["ok"]==true) && links.iter().all(|url|opened.lines().any(|line|line.trim_end_matches('/')==*url)),"states":results,"opened":opened,"opener":"private PATH fixture; no browser or external request"}));
        let _ = run(&win,"(()=>{document.dispatchEvent(new CustomEvent('abito:integration-focus',{detail:{id:null}}));return {ok:true};})()");
    }
    app.unlisten(result_listener); app.unlisten(input_listener);
}

// Fake adapted from tests/spotify_mpris.rs and Coucou src-tauri/src/spotify.rs
// @434d6a2b, Copyright (c) 2026 Louis Raillé, MIT. Private validator bus only.
#[cfg(target_os = "linux")]
mod validator_spotify {
use std::time::Duration;
use std::collections::HashMap;
use std::sync::{Arc,Mutex};
use zbus::blocking::{connection, Connection};
use zbus::zvariant::{ObjectPath,OwnedValue,Value};
/// What the fake Spotify remembers and was asked.
struct Fake { calls: Arc<Mutex<Vec<String>>>, art_url: String, playing: bool, position: i64, shuffle: bool, volume: f64, conn: std::sync::OnceLock<Connection> }

#[zbus::interface(name = "org.mpris.MediaPlayer2.Player")]
impl Fake {
    fn play_pause(&mut self) {
        self.calls.lock().unwrap().push("PlayPause".into());
        self.playing = !self.playing;
        self.position += 1_000_000;
        let conn = self.conn.get().unwrap().clone();
        let status = if self.playing { "Playing" } else { "Paused" };
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            let mut changed: HashMap<&str, Value<'_>> = HashMap::new();
            changed.insert("PlaybackStatus", Value::from(status));
            let _ = conn.emit_signal(None::<&str>, "/org/mpris/MediaPlayer2", "org.freedesktop.DBus.Properties", "PropertiesChanged",
                &("org.mpris.MediaPlayer2.Player", changed, Vec::<String>::new()));
        });
    }
    fn next(&mut self) { self.calls.lock().unwrap().push("Next".into()); self.art_url = "https://unsupported.invalid/cover.png".into(); }
    fn previous(&self) { self.calls.lock().unwrap().push("Previous".into()); }
    fn set_position(&mut self, track: ObjectPath<'_>, us: i64) {
        self.calls.lock().unwrap().push(format!("SetPosition {track} {us}"));
        self.position = us;
    }
    #[zbus(property)]
    fn shuffle(&self) -> bool { self.shuffle }
    #[zbus(property)]
    fn set_shuffle(&mut self, on: bool) { self.calls.lock().unwrap().push(format!("Shuffle {on}")); self.shuffle = on; }
    #[zbus(property)]
    fn volume(&self) -> f64 { self.volume }
    #[zbus(property)]
    fn set_volume(&mut self, v: f64) { self.calls.lock().unwrap().push(format!("Volume {v}")); self.volume = v; }
    #[zbus(property)]
    fn loop_status(&self) -> String { "None".into() }
    #[zbus(property)]
    fn set_loop_status(&mut self, v: String) { self.calls.lock().unwrap().push(format!("Loop {v}")); }
    #[zbus(property)]
    fn playback_status(&self) -> String { if self.playing { "Playing" } else { "Paused" }.into() }
    #[zbus(property)]
    fn position(&self) -> i64 { self.position }
    #[zbus(property)]
    fn metadata(&self) -> HashMap<String, OwnedValue> {
        let mut m: HashMap<String, OwnedValue> = HashMap::new();
        m.insert("mpris:trackid".into(), Value::from(ObjectPath::try_from("/com/spotify/track/fake1").unwrap()).try_into().unwrap());
        m.insert("mpris:length".into(), Value::from(180_000_000u64).try_into().unwrap());
        m.insert("xesam:title".into(), Value::from("Fake Song (Live)").try_into().unwrap());
        m.insert("xesam:artist".into(), Value::from(vec!["Fake Artist".to_string(), "Guest".to_string()]).try_into().unwrap());
        m.insert("xesam:album".into(), Value::from("Fake Album").try_into().unwrap());
        m.insert("mpris:artUrl".into(), Value::from(self.art_url.clone()).try_into().unwrap());
        m
    }
}

pub fn fake(calls: Arc<Mutex<Vec<String>>>) -> Connection {
    let conn = connection::Builder::session().unwrap()
        .serve_at("/org/mpris/MediaPlayer2", Fake { calls, art_url: tauri::Url::from_file_path(std::path::PathBuf::from(std::env::var("ABITO_PROBE_VISUAL_DIR").unwrap()).join("spotify-cover.png")).unwrap().to_string(), playing: true, position: 30_000_000, shuffle: false, volume: 0.8, conn: Default::default() })
        .unwrap().name("org.mpris.MediaPlayer2.spotify").unwrap().build().unwrap();
    let iface = conn.object_server().interface::<_, Fake>("/org/mpris/MediaPlayer2").unwrap();
    iface.get().conn.set(conn.clone()).ok();
    conn
}


}


/// Fake extension on the validator's private bus, never the human's Shell.
#[cfg(target_os = "linux")]
mod validator_context {
    use std::sync::{Arc, Mutex, atomic::{AtomicUsize, Ordering}};
    use abito_island::{contextwin, flow::{self, Backend, cleanup, store::{Store, Style}}};
    use serde_json::{json, Value};
    struct Extension(Arc<AtomicUsize>);
    #[zbus::interface(name = "org.abito.Context")]
    impl Extension {
        fn get_recent_windows(&self) -> Vec<(String, String, String)> {
            self.0.fetch_add(1, Ordering::SeqCst);
            vec![("com.abitog.AbitoTauri".into(), "Abito".into(), "Abito".into()),
                ("org.example.Writer.desktop".into(), "Writer del validador".into(), "Documento privado del validador".into())]
        }
    }
    pub fn start() -> (zbus::blocking::Connection, Arc<AtomicUsize>) {
        assert!(std::env::var("HOME").unwrap_or_default().starts_with("/tmp/abito-validate-"), "private validator HOME required");
        assert!(std::env::var("DBUS_SESSION_BUS_ADDRESS").is_ok(), "private bus required");
        let reads = Arc::new(AtomicUsize::new(0));
        let conn = zbus::blocking::connection::Builder::session().unwrap().name(contextwin::BUS_NAME).unwrap()
            .serve_at(contextwin::OBJECT_PATH, Extension(reads.clone())).unwrap().build().unwrap();
        (conn, reads)
    }
    #[derive(Default)]
    struct CleanupStub { styles: Mutex<Vec<Style>>, delivered: Mutex<Vec<String>> }
    impl cleanup::CleanupProvider for CleanupStub {
        fn clean(&self, request: &cleanup::Request<'_>) -> Result<String, String> {
            self.styles.lock().unwrap().push(request.style);
            assert_eq!(request.app, Some("Writer del validador"));
            Ok(match request.style { Style::Polished => "Texto pulido del validador.", _ => "Texto natural del validador." }.into())
        }
    }
    impl Backend for CleanupStub {
        fn model_ready(&self) -> bool { true }
        fn record(&self, _: &str) -> Result<Box<dyn flow::Recording>, String> { Err("no microphone in validator".into()) }
        fn transcribe(&self, _: &[f32]) -> Option<String> { Some("texto privado del validador".into()) }
        fn deliver(&self, text: &str) -> flow::paste::Outcome {
            self.delivered.lock().unwrap().push(text.into()); flow::paste::Outcome::Copied
        }
        fn cleanup_provider(&self) -> Option<&dyn cleanup::CleanupProvider> { Some(self) }
    }
    pub fn styles_effect() -> Value {
        // Load the styles saved by actual Settings IPC, not a fabricated mapping.
        let mut store = Store::load();
        let app = flow::System.foreground_app();
        let matched = app.as_ref().is_some_and(|a| a.0 == "org.example.writer" && store.style_for(Some(&a.0)) == Style::Polished);
        store.prefs.cleanup = true; // private stub: no key, provider, audio or external request
        store.prefs.default_style = Style::Natural;
        let store = Mutex::new(store);
        let backend = CleanupStub::default();
        let notify: flow::Notify = Arc::new(|_| {});
        flow::process(&backend, &store, &notify, &[], 1.0, app.as_ref());
        store.lock().unwrap().app_styles.retain(|s| s.id != "org.example.writer");
        flow::process(&backend, &store, &notify, &[], 1.0, app.as_ref());
        let styles = backend.styles.lock().unwrap();
        let delivered = backend.delivered.lock().unwrap();
        json!({"ok":matched && *styles == vec![Style::Polished, Style::Natural]
            && *delivered == vec!["Texto pulido del validador.", "Texto natural del validador."],
            "app":app,"styles":*styles,"delivered":*delivered,"provider":"private cleanup stub; no Anthropic request or microphone"})
    }
}

#[cfg(target_os = "linux")]
#[path = "../packaging/validate/producer.rs"]
mod validator_producer;
