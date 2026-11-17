//! K2-11 S2/S5: ICS subscription URL, parser and recurrence expansion (pure, no network).
use super::*;
use serde_json::json;

fn ics(body: &str) -> String {
    format!("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//fixture//EN\r\n{body}END:VCALENDAR\r\n")
}

fn titles(list: &[Occurrence]) -> Vec<String> {
    list.iter().map(|o| format!("{} {}", o.title, o.start.date_string())).collect()
}

#[test]
fn subscription_url_accepts_https_and_webcal_only_without_credentials() {
    assert_eq!(subscription_url("https://calendar.google.com/calendar/ical/x/private-abc/basic.ics").as_deref(),
        Some("https://calendar.google.com/calendar/ical/x/private-abc/basic.ics"));
    assert_eq!(subscription_url("webcal://p01-caldav.icloud.com/published/2/abc").as_deref(),
        Some("https://p01-caldav.icloud.com/published/2/abc"));
    assert_eq!(subscription_url("  https://example.com/a.ics\n").as_deref(), Some("https://example.com/a.ics"));
    for bad in ["http://example.com/a.ics", "ftp://example.com/a.ics", "file:///etc/passwd", "https://user:pw@example.com/a.ics",
        "https://", "not a url", "", "https://exa mple.com/a.ics"] {
        assert_eq!(subscription_url(bad), None, "{bad}");
    }
}

#[test]
fn parses_timed_utc_tzid_floating_and_all_day_events_with_unfolded_escaped_text() {
    let text = ics("BEGIN:VEVENT\r\nUID:1\r\nSUMMARY:Stand\r\n  up\\, daily\r\nDTSTART:20261112T093000Z\r\nDTEND:20261112T094500Z\r\nLOCATION:Sala 2\\nPiso 3\r\nDESCRIPTION:secret notes\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:2\r\nSUMMARY:Médico\r\nDTSTART;TZID=\"Europe/Madrid\":20261113T170000\r\nDURATION:PT1H30M\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:3\r\nSUMMARY:Cumple\r\nDTSTART;VALUE=DATE:20261113\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:4\r\nSUMMARY:Floating\r\nDTSTART:20261112T200000\r\nEND:VEVENT\r\n");
    let events = parse_ics(&text).unwrap();
    let out = occurrences(&events, Date::new(2026, 11, 12), Date::new(2026, 11, 13));
    let v = serde_json::to_value(&out).unwrap();
    assert_eq!(v[0], json!({"title":"Stand up, daily","location":"Sala 2\nPiso 3","allDay":false,
        "start":{"date":"2026-11-12","time":"09:30:00","tz":"UTC"},"end":{"date":"2026-11-12","time":"09:45:00","tz":"UTC"}}));
    assert_eq!(v[1]["start"], json!({"date":"2026-11-12","time":"20:00:00","tz":null}));
    assert_eq!(v[1]["end"], v[1]["start"]);
    assert_eq!(v[2], json!({"title":"Cumple","location":null,"allDay":true,
        "start":{"date":"2026-11-13","time":null,"tz":null},"end":{"date":"2026-11-14","time":null,"tz":null}}));
    assert_eq!(v[3]["title"], "Médico");
    assert_eq!(v[3]["start"], json!({"date":"2026-11-13","time":"17:00:00","tz":"Europe/Madrid"}));
    assert_eq!(v[3]["end"], json!({"date":"2026-11-13","time":"18:30:00","tz":"Europe/Madrid"}));
    assert!(!v.to_string().contains("secret notes"), "descriptions never leave the host");
}

#[test]
fn window_keeps_events_overlapping_it_and_drops_cancelled_ones() {
    let text = ics("BEGIN:VEVENT\r\nUID:a\r\nSUMMARY:Old\r\nDTSTART:20261101T090000Z\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:b\r\nSUMMARY:Trip\r\nDTSTART;VALUE=DATE:20261110\r\nDTEND;VALUE=DATE:20261114\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:c\r\nSUMMARY:Gone\r\nSTATUS:CANCELLED\r\nDTSTART:20261112T090000Z\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:d\r\nSUMMARY:Later\r\nDTSTART:20261120T090000Z\r\nEND:VEVENT\r\n");
    let out = occurrences(&parse_ics(&text).unwrap(), Date::new(2026, 11, 12), Date::new(2026, 11, 13));
    assert_eq!(titles(&out), vec!["Trip 2026-11-10"]);
}

#[test]
fn weekly_daily_monthly_and_yearly_rules_expand_with_count_until_and_exdate() {
    let text = ics("BEGIN:VEVENT\r\nUID:w\r\nSUMMARY:Weekly\r\nDTSTART;TZID=Europe/Madrid:20260105T100000\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,TH\r\nEXDATE;TZID=Europe/Madrid:20261112T100000\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:d\r\nSUMMARY:Daily\r\nDTSTART:20261110T080000Z\r\nRRULE:FREQ=DAILY;COUNT=3\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:i\r\nSUMMARY:Every2\r\nDTSTART:20261109T080000Z\r\nRRULE:FREQ=DAILY;INTERVAL=2;UNTIL=20261130T000000Z\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:m\r\nSUMMARY:SecondFri\r\nDTSTART:20260109T120000Z\r\nRRULE:FREQ=MONTHLY;BYDAY=2FR\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:md\r\nSUMMARY:Rent\r\nDTSTART;VALUE=DATE:20250112\r\nRRULE:FREQ=MONTHLY\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:y\r\nSUMMARY:Anniversary\r\nDTSTART;VALUE=DATE:20101113\r\nRRULE:FREQ=YEARLY\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:u\r\nSUMMARY:Ended\r\nDTSTART:20260101T080000Z\r\nRRULE:FREQ=DAILY;UNTIL=20261111T235959Z\r\nEND:VEVENT\r\n");
    // 12-nov-2026 is a Thursday, 13-nov a Friday (the second Friday of November).
    let out = occurrences(&parse_ics(&text).unwrap(), Date::new(2026, 11, 12), Date::new(2026, 11, 13));
    let got = titles(&out);
    assert_eq!(got, vec!["Rent 2026-11-12", "Daily 2026-11-12", "Anniversary 2026-11-13", "Every2 2026-11-13", "SecondFri 2026-11-13"]);
    let rent = out.iter().find(|o| o.title == "Rent").unwrap();
    assert!(rent.all_day);
    assert_eq!(rent.end.date_string(), "2026-11-13");
}

#[test]
fn a_moved_instance_replaces_its_recurring_slot() {
    let text = ics("BEGIN:VEVENT\r\nUID:r\r\nSUMMARY:Sync\r\nDTSTART:20261105T090000Z\r\nDTEND:20261105T093000Z\r\nRRULE:FREQ=WEEKLY\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:r\r\nRECURRENCE-ID:20261112T090000Z\r\nSUMMARY:Sync (moved)\r\nDTSTART:20261113T150000Z\r\nDTEND:20261113T153000Z\r\nEND:VEVENT\r\n");
    let out = occurrences(&parse_ics(&text).unwrap(), Date::new(2026, 11, 12), Date::new(2026, 11, 13));
    let v = serde_json::to_value(&out).unwrap();
    assert_eq!(v.as_array().unwrap().len(), 1);
    assert_eq!(v[0]["title"], "Sync (moved)");
    assert_eq!(v[0]["start"]["time"], "15:00:00");
}

#[test]
fn unsupported_rules_keep_only_the_first_instance_and_output_is_bounded() {
    let text = ics("BEGIN:VEVENT\r\nUID:h\r\nSUMMARY:Hourly\r\nDTSTART:20261112T080000Z\r\nRRULE:FREQ=HOURLY\r\nEND:VEVENT\r\n");
    assert_eq!(titles(&occurrences(&parse_ics(&text).unwrap(), Date::new(2026, 11, 12), Date::new(2026, 11, 13))), vec!["Hourly 2026-11-12"]);
    let many: String = (0..500).map(|i| format!("BEGIN:VEVENT\r\nUID:{i}\r\nSUMMARY:E{i}\r\nDTSTART:20261112T080000Z\r\nEND:VEVENT\r\n")).collect();
    assert_eq!(occurrences(&parse_ics(&ics(&many)).unwrap(), Date::new(2026, 11, 12), Date::new(2026, 11, 13)).len(), MAX_OCCURRENCES);
}

#[test]
fn rejects_text_that_is_not_a_calendar() {
    assert!(parse_ics("<html>login</html>").is_err());
    assert!(parse_ics("").is_err());
    assert_eq!(parse_ics(&ics("")).unwrap().len(), 0);
}

#[test]
fn window_spans_the_day_before_to_three_days_after_the_utc_date() {
    // The page filters "today and tomorrow" in the user's zone; any zone fits in this window.
    assert_eq!(window(Date::from_unix_ms(1_794_441_600_000)), (Date::new(2026, 11, 11), Date::new(2026, 11, 15)));
}

fn one_shot(head: &'static str, body: &'static str) -> (String, std::thread::JoinHandle<()>) {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/private-token/basic.ics", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket.set_read_timeout(Some(std::time::Duration::from_secs(3))).unwrap();
        let mut input = [0; 4096];
        let _ = socket.read(&mut input).unwrap();
        let _ = write!(socket, "HTTP/1.1 {head}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    });
    (url, server)
}

#[test]
fn download_reads_the_body_and_maps_refusals_without_echoing_the_url() {
    let (url, server) = one_shot("200 OK", "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n");
    assert_eq!(fetch_at(&url, false).unwrap(), "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n");
    server.join().unwrap();
    let (url, server) = one_shot("404 Not Found", "");
    assert_eq!(fetch_at(&url, false), Err(Unavailable::Refused));
    server.join().unwrap();
    let (url, server) = one_shot("500 Oops", "");
    assert_eq!(fetch_at(&url, false), Err(Unavailable::Unreachable));
    server.join().unwrap();
    // The real download refuses anything that is not https before a byte leaves the machine.
    assert_eq!(fetch_ics("http://127.0.0.1:1/a.ics"), Err(Unavailable::Unreachable));
}

#[test]
fn cache_serves_fresh_answers_drops_on_url_change_and_never_shows_the_url() {
    let cal = ics("BEGIN:VEVENT\r\nUID:x\r\nSUMMARY:Demo\r\nDTSTART:20261112T100000Z\r\nEND:VEVENT\r\n");
    let now = 1_794_441_600_000; // 2026-11-12T00:00:00Z
    let mut cache = Cache::default();
    let mut calls = 0;
    let a = cache.refresh(Some("webcal://cal.example/private-abc"), now, |u| { calls += 1; assert_eq!(u, "https://cal.example/private-abc"); Ok(cal.clone()) });
    assert_eq!(a["available"], true);
    assert_eq!(a["events"][0]["title"], "Demo");
    assert!(!a.to_string().contains("private-abc"));
    let b = cache.refresh(Some("webcal://cal.example/private-abc"), now + 1000, |_| { calls += 1; Ok(String::new()) });
    assert_eq!(a, b);
    let c = cache.refresh(Some("https://cal.example/other"), now + 2000, |_| { calls += 1; Err(Unavailable::Refused) });
    assert_eq!(c, json!({"available": false, "reason": "refused"}));
    assert_eq!(calls, 2);
    assert_eq!(cache.refresh(None, now, |_| unreachable!()), json!({"available": false, "reason": "not_configured"}));
    assert_eq!(cache.refresh(Some("http://cal.example/x"), now, |_| unreachable!()), json!({"available": false, "reason": "bad_url"}));
    let bad = cache.refresh(Some("https://cal.example/x"), now, |_| Ok("<html>".into()));
    assert_eq!(bad, json!({"available": false, "reason": "bad_answer"}));
}

#[test]
fn request_is_closed_to_refresh() {
    assert!(parse_request(&json!({"action": "refresh"})).is_ok());
    for bad in [json!({}), json!({"action": "refresh", "url": "https://x"}), json!({"action": "set"}), json!("refresh")] {
        assert!(parse_request(&bad).is_err(), "{bad}");
    }
}

#[test]
fn hostile_values_never_panic_and_are_skipped() {
    // Verifier B1/S-1: non-ASCII inside fixed-width fields and overflowing numbers.
    let bodies = [
        "DTSTART:202é011\r\n", "DTSTART:20261112T1é234\r\n",
        "DTSTART:20261112T080000Z\r\nRRULE:FREQ=WEEKLY;BYDAY=éa\r\n",
        "DTSTART:20261112T080000Z\r\nEXDATE:202é011\r\n",
        "DTSTART:20261112T080000Z\r\nRRULE:FREQ=DAILY;UNTIL=202é011\r\n",
        "DTSTART:20261112T080000Z\r\nDURATION:P99999999999999W\r\n",
        "DTSTART:20261112T080000Z\r\nRRULE:FREQ=MONTHLY;BYMONTHDAY=-2147483648\r\n",
        "DTSTART:20261112T080000Z\r\nRRULE:FREQ=YEARLY;INTERVAL=2147483647\r\n",
        "DTSTART:20261112T080000Z\r\nRRULE:FREQ=DAILY;INTERVAL=4294967295;COUNT=4294967295\r\n",
    ];
    for body in bodies {
        let text = ics(&format!("BEGIN:VEVENT\r\nUID:h\r\nSUMMARY:H\r\n{body}END:VEVENT\r\n"));
        let events = parse_ics(&text).unwrap();
        let _ = occurrences(&events, Date::new(2026, 11, 12), Date::new(2026, 11, 13));
    }
}

#[test]
fn many_moved_and_excluded_instances_stay_fast() {
    // Verifier S-2: 3,000 daily series from 1990, each with a moved instance and an EXDATE.
    let mut body = String::new();
    for i in 0..3000 {
        body.push_str(&format!("BEGIN:VEVENT\r\nUID:s{i}\r\nSUMMARY:S{i}\r\nDTSTART:19900101T080000Z\r\nRRULE:FREQ=DAILY\r\nEXDATE:20000101T080000Z\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:s{i}\r\nRECURRENCE-ID:19950101T080000Z\r\nSUMMARY:M{i}\r\nDTSTART:19950102T080000Z\r\nEND:VEVENT\r\n"));
    }
    let events = parse_ics(&ics(&body)).unwrap();
    let started = std::time::Instant::now();
    let out = occurrences(&events, Date::new(2026, 11, 12), Date::new(2026, 11, 13));
    assert_eq!(out.len(), MAX_OCCURRENCES);
    assert!(started.elapsed() < std::time::Duration::from_secs(10), "{:?}", started.elapsed());
}
