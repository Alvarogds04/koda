//! S6: only the allowing button allows; every other outcome of a consent dialog refuses.
//!
//! These run where `alert.rs` compiles (macOS and Windows). A task dialog needs the common controls
//! v6 that the app's manifest declares and a test executable has none, so the dialogs themselves are
//! exercised in the app; everything that decides allow/refuse is pure and is checked here.
use super::*;
use std::time::Instant;

#[test]
fn only_the_allowing_buttons_response_allows_an_alert() {
    assert!(GRANT.allows_response(Some(ALLOW_RESPONSE)));
    // The refusing button (also Return), an aborted alert (a stale one dismissed elsewhere), a
    // stopped or cancelled modal session, an OK nobody can press, a button that does not exist, and
    // an alert that never ran: every one refuses.
    for response in [Some(REFUSE_RESPONSE), Some(-1001), Some(-1000), Some(0), Some(1), Some(1002), Some(-1), None] {
        assert!(!GRANT.allows_response(response), "{response:?}");
    }
}

#[test]
fn only_the_allowing_task_buttons_id_allows_a_dialog() {
    assert!(GRANT.allows_task_button(Some(TASK_ALLOW_ID)));
    // The refusing (default) button, Escape or closing (IDCANCEL), the common buttons nobody can
    // press, an unknown id, and a dialog that failed to show all refuse.
    for button in [Some(TASK_REFUSE_ID), Some(2), Some(1), Some(6), Some(7), Some(0), Some(-1), Some(2002), None] {
        assert!(!GRANT.allows_task_button(button), "{button:?}");
    }
    assert_ne!(TASK_ALLOW_ID, TASK_REFUSE_ID);
}

#[test]
fn the_refusing_button_is_added_first_so_it_is_the_default() {
    assert_eq!(GRANT.alert_buttons(), ["Deny", "Allow"]);
    assert_eq!((REFUSE_RESPONSE, ALLOW_RESPONSE), (1000, 1001));
    #[cfg(target_os = "macos")]
    {
        assert_eq!(REFUSE_RESPONSE, objc2_app_kit::NSAlertFirstButtonReturn);
        assert_eq!(ALLOW_RESPONSE, objc2_app_kit::NSAlertSecondButtonReturn);
        assert_eq!(objc2_app_kit::NSModalResponseAbort, -1001);
    }
}

#[test]
fn identical_labels_never_allow() {
    let same = Choice { allow: "OK", refuse: "OK" };
    assert!(!same.allows_response(Some(ALLOW_RESPONSE)));
    assert!(!same.allows_task_button(Some(TASK_ALLOW_ID)));
}

#[test]
fn a_dialogs_timer_refuses_when_asked_or_once_its_deadline_passes() {
    let now = Instant::now();
    let second = std::time::Duration::from_secs(1);
    assert!(!refuse_due(false, None, now));
    assert!(!refuse_due(false, Some(now + second), now));
    assert!(refuse_due(false, Some(now), now));
    assert!(refuse_due(false, Some(now - second), now));
    assert!(refuse_due(true, None, now));
    assert!(refuse_due(true, Some(now + second), now));
}

#[test]
fn the_consent_question_is_kodas_and_not_gentle_dots() {
    assert_eq!(TITLE, "Koda");
    assert_eq!(MESSAGE, "Allow Koda to see your window for 30 minutes?");
    assert_eq!((GRANT.allow, GRANT.refuse), ("Allow", "Deny"));
    // A dialog nobody answers is never an answer: it refuses by itself instead of granting.
    assert!(GRANT_TIMEOUT > std::time::Duration::ZERO);
    // The question promises the same 30 minutes the consent session lasts (S6).
    assert_eq!(crate::windowcapture::session::SESSION_MS, 30 * 60 * 1000);
    assert!(MESSAGE.contains("30 minutes"));
}

#[test]
fn a_refusal_asked_for_by_another_thread_refuses_the_dialog() {
    let open = OpenDialog::default();
    // Off Windows no other thread can end the dialog this way, and the dialog simply waits for the
    // human; the refusal it asks for still reads as due, which is the rule both cases share.
    open.refuse();
    assert!(refuse_due(true, None, Instant::now()));
}
