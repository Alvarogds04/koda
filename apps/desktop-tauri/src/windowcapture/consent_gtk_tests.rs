use super::*;

#[test]
fn only_the_allowing_response_allows() {
    assert!(allows(gtk::ResponseType::Accept));
    for refuse in [gtk::ResponseType::Cancel, gtk::ResponseType::Reject, gtk::ResponseType::DeleteEvent, gtk::ResponseType::Close, gtk::ResponseType::None, gtk::ResponseType::Ok, gtk::ResponseType::Yes] {
        assert!(!allows(refuse), "{refuse:?}");
    }
}

#[test]
fn the_question_names_koda_and_thirty_minutes() {
    assert_eq!(QUESTION, "Allow Koda to see your window for 30 minutes?");
    assert_eq!(super::super::session::SESSION_MS, 30 * 60 * 1000);
}

// B3: the dialog is closed by the app itself when its deadline passes, a late Allow does nothing,
// and only one dialog is ever open.
#[test]
fn at_the_deadline_the_dialog_is_closed_as_deny_and_a_late_allow_does_nothing() {
    let settled = std::sync::atomic::AtomicBool::new(false);
    let (tx, rx) = std::sync::mpsc::channel();
    let closed = std::cell::Cell::new(0);
    settle(&settled, gtk::ResponseType::Cancel, &tx, || closed.set(closed.get() + 1)); // the timer
    settle(&settled, gtk::ResponseType::Accept, &tx, || closed.set(closed.get() + 1)); // a late click
    assert_eq!(rx.try_recv(), Ok(false), "the deadline answers Deny");
    assert!(rx.try_recv().is_err(), "the late Allow sends nothing");
    assert_eq!(closed.get(), 1, "closed exactly once");
}

#[test]
fn an_answer_before_the_deadline_wins_and_the_timer_then_does_nothing() {
    let settled = std::sync::atomic::AtomicBool::new(false);
    let (tx, rx) = std::sync::mpsc::channel();
    settle(&settled, gtk::ResponseType::Accept, &tx, || {});
    settle(&settled, gtk::ResponseType::Cancel, &tx, || panic!("must not close twice"));
    assert_eq!(rx.try_recv(), Ok(true));
    assert!(rx.try_recv().is_err());
}

#[test]
fn two_requests_never_have_two_dialogs_open_at_once() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let open = std::sync::Arc::new(AtomicUsize::new(0));
    let peak = std::sync::Arc::new(AtomicUsize::new(0));
    let threads: Vec<_> = (0..4).map(|_| {
        let (open, peak) = (open.clone(), peak.clone());
        std::thread::spawn(move || one_at_a_time(|| {
            let now = open.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(now, Ordering::SeqCst);
            std::thread::sleep(std::time::Duration::from_millis(20));
            open.fetch_sub(1, Ordering::SeqCst);
        }))
    }).collect();
    for t in threads { t.join().unwrap(); }
    assert_eq!(peak.load(Ordering::SeqCst), 1);
}
