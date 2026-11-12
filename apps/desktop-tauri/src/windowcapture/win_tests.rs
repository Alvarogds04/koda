//! S1/S5 on Windows: which window is chosen, and what counts as a black frame. The capture itself
//! needs a Windows desktop and is exercised by the Windows CI job and the human test; everything
//! that decides is pure and is checked here.
use super::*;

fn row(handle: u64, pid: u32, app: &str) -> Row {
    Row {
        handle,
        pid,
        app: app.to_string(),
        title: "a window".into(),
        visible: true,
        minimized: false,
        cloaked: false,
        tool: false,
    }
}

#[test]
fn the_topmost_window_that_is_not_kodas_is_chosen() {
    let own = 400;
    let rows = [row(11, own, "koda"), row(12, 900, "bitwarden"), row(13, 901, "code")];
    let target = pick(own, &rows).unwrap();
    // Koda's own island is never the target, even when it is topmost.
    assert_eq!(target.handle, 12);
    assert_eq!(target.app, "bitwarden");
    // The refusal list gets the executable stem as both id and name, so S5 blocks it before pixels.
    assert_eq!(target.app_id, "bitwarden");
    assert_eq!(crate::windowcapture::blocklist::blocked_reason_on(
        crate::windowcapture::blocklist::Platform::Windows,
        &target.app_id,
        &target.app
    ), Some("Bitwarden"));
}

#[test]
fn unusable_windows_are_skipped() {
    let own = 400;
    let mut minimized = row(20, 900, "code");
    minimized.minimized = true;
    let mut hidden = row(21, 900, "code");
    hidden.visible = false;
    let mut cloaked = row(22, 900, "code");
    cloaked.cloaked = true;
    let mut tool = row(23, 900, "code");
    tool.tool = true;
    let rows = [minimized, hidden, cloaked, tool, row(24, 900, "code")];
    assert_eq!(pick(own, &rows).unwrap().handle, 24);
    // A window of another virtual desktop (cloaked) has no pixels to show: never the target.
    let only_unusable = [rows[0].clone(), rows[2].clone()];
    assert_eq!(pick(own, &only_unusable), Err(CaptureError::NoWindow));
    // Nothing at all is the same answer, not an error the agent cannot explain.
    assert_eq!(pick(own, &[]), Err(CaptureError::NoWindow));
    assert_eq!(pick(own, &[row(0, 900, "code")]), Err(CaptureError::NoWindow));
    assert_eq!(pick(own, &[row(25, 0, "code")]), Err(CaptureError::NoWindow));
}

#[test]
fn a_process_windows_will_not_describe_is_the_blocked_unidentified_app() {
    let target = pick(400, &[row(30, 900, "")]).unwrap();
    assert_eq!(target.app, UNIDENTIFIED);
    assert_eq!(target.app_id, UNIDENTIFIED);
    assert!(crate::windowcapture::blocklist::blocked_reason_on(
        crate::windowcapture::blocklist::Platform::Windows,
        &target.app_id,
        &target.app
    )
    .is_some());
    assert_eq!(app_of("  "), UNIDENTIFIED);
    // A stem with padding keeps its letters: the refusal list matches it as it is.
    assert_eq!(app_of(" keepassxc "), "keepassxc");
}

#[test]
fn a_frame_of_only_black_pixels_is_a_black_frame() {
    assert!(looks_black(&[0, 0, 0, 255, 0, 0, 0, 255]));
    assert!(looks_black(&[0, 0, 0, 0]));
    // Alpha alone does not make a frame usable: a composited window answers with zeros everywhere.
    assert!(!looks_black(&[0, 0, 1, 255]));
    assert!(!looks_black(&[9, 0, 0, 255]));
    // An empty buffer is not a black frame: nothing was copied, so the copy is still tried.
    assert!(!looks_black(&[]));
}

#[test]
fn an_empty_handle_is_a_clean_failure() {
    assert!(matches!(capture_window(0), Err(CaptureError::Failed(_))));
}

#[test]
fn a_window_that_stopped_responding_is_never_asked_to_paint() {
    // PrintWindow would wait on its frozen UI thread; the screen copy needs nothing from it.
    assert!(!asks_the_window_to_paint(true));
    assert!(asks_the_window_to_paint(false));
}

#[test]
fn the_dib_is_flushed_before_its_pixels_are_read() {
    let src = include_str!("win.rs");
    let print = src.find("PrintWindow(hwnd, canvas.memory").unwrap();
    let flush = src[print..].find("GdiFlush()").unwrap() + print;
    let read = src[print..].find("canvas.pixels()").unwrap() + print;
    assert!(flush < read, "PrintWindow: flush before reading");
    let blt = src.find("BitBlt(canvas.memory").unwrap();
    let flush = src[blt..].find("GdiFlush()").unwrap() + blt;
    let read = src[blt..].find("canvas.pixels()").unwrap() + blt;
    assert!(flush < read, "BitBlt: flush before reading");
}
