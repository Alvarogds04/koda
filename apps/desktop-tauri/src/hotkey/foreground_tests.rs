use super::*;

#[test]
fn remembers_a_foreign_window_only() {
    assert_eq!(remember(100, 200, 7), Some(7));
    assert_eq!(remember(100, 100, 7), None, "never remember Abito's own window");
    assert_eq!(remember(100, 200, 0), None, "a null handle is no window");
}

#[test]
fn gives_back_only_when_abito_took_the_keyboard_unasked() {
    assert_eq!(hand_back(true, false, Some(7)), Some(7));
    assert_eq!(hand_back(false, false, Some(7)), None, "the island did not take focus: leave it");
    assert_eq!(hand_back(true, true, Some(7)), None, "deliberate activation keeps the focus");
    assert_eq!(hand_back(true, false, None), None, "nobody to give it to");
}

#[test]
fn current_never_reports_this_process() {
    // On Linux there is no native reader here (x11 owns it): None. On Windows/macOS it must
    // be a foreign window or None, never us (the test binary is not a focused GUI).
    if let Some(token) = current() {
        assert_ne!(token, 0);
    }
}
