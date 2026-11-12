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

#[test]
fn a_dialog_nobody_answers_refuses() {
    // The main thread never runs the job: no answer inside the deadline is a refusal (fail closed).
    let (_tx, rx) = std::sync::mpsc::channel::<gtk::ResponseType>();
    assert!(!answer(&rx, std::time::Duration::from_millis(20)));
}
