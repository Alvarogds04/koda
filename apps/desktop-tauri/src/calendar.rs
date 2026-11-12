//! K2-11 S2/S5: the user's calendar from a private ICS subscription URL (decision 9a).
//! Pure half: URL check, ICS parser, recurrence expansion and the refresh cache. The URL is a
//! secret (it grants read access to the calendar): it lives in the keychain as
//! `calendar-ics-url`, is fetched only over HTTPS, and never reaches a log, an answer or IPC.
//! Read-only: descriptions, attendees and organisers are dropped while parsing; the island gets
//! title, location and times only.
use serde::ser::{Serialize, SerializeStruct, Serializer};
use serde_json::{json, Value};

#[cfg(test)]
#[path = "calendar_tests.rs"]
mod tests;

/// Keychain entry holding the subscription URL.
pub const KEY: &str = "calendar-ics-url";
/// At most this many occurrences go to the island.
pub const MAX_OCCURRENCES: usize = 50;
/// Downloaded calendars larger than this are refused.
pub const MAX_ICS_BYTES: usize = 5 * 1024 * 1024;
/// Parsed events kept from one calendar.
const MAX_EVENTS: usize = 20_000;
/// Candidate dates a single recurrence may walk before giving up.
const MAX_STEPS: usize = 40_000;
/// Text fields are cut to this many characters.
const MAX_TEXT: usize = 200;
/// A fresh answer is served from the cache for this long.
pub const MAX_AGE_MS: u64 = 5 * 60 * 1000;

// ── Dates ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Date {
    pub y: i32,
    pub m: u32,
    pub d: u32,
}

fn days_in_month(y: i32, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        _ => 28,
    }
}

impl Date {
    pub fn new(y: i32, m: u32, d: u32) -> Self {
        Date { y, m, d }
    }
    fn valid(self) -> bool {
        (1..=12).contains(&self.m) && self.d >= 1 && self.d <= days_in_month(self.y, self.m)
    }
    /// Days since 1970-01-01 (Howard Hinnant's days_from_civil).
    fn days(self) -> i64 {
        let y = i64::from(self.y) - i64::from(self.m <= 2);
        let era = y.div_euclid(400);
        let yoe = y - era * 400;
        let m = i64::from(self.m);
        let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + i64::from(self.d) - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        era * 146_097 + doe - 719_468
    }
    fn from_days(z: i64) -> Self {
        let z = z + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z - era * 146_097;
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
        let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
        Date { y: (yoe + era * 400 + i64::from(m <= 2)) as i32, m, d }
    }
    pub fn from_unix_ms(ms: u64) -> Self {
        Date::from_days((ms / 86_400_000) as i64)
    }
    pub fn add_days(self, n: i64) -> Self {
        Date::from_days(self.days() + n)
    }
    /// 0 = Monday … 6 = Sunday.
    fn weekday(self) -> u32 {
        (self.days() + 3).rem_euclid(7) as u32
    }
    pub fn date_string(self) -> String {
        format!("{:04}-{:02}-{:02}", self.y, self.m, self.d)
    }
}

/// The dates fetched for "today and tomorrow": any time zone's today and tomorrow fit in it.
/// The page keeps the ones that are today or tomorrow in the user's own zone.
pub fn window(today_utc: Date) -> (Date, Date) {
    (today_utc.add_days(-1), today_utc.add_days(3))
}

/// One point in time as the calendar wrote it: a date, an optional wall time and its zone
/// (`UTC`, an IANA-like TZID, or none for floating/all-day).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stamp {
    pub date: Date,
    pub time: Option<(u32, u32, u32)>,
    pub tz: Option<String>,
}

impl Stamp {
    pub fn date_string(&self) -> String {
        self.date.date_string()
    }
    fn key(&self) -> (Date, Option<(u32, u32, u32)>) {
        (self.date, self.time)
    }
    fn on(&self, date: Date) -> Stamp {
        Stamp { date, time: self.time, tz: self.tz.clone() }
    }
    fn plus_seconds(&self, secs: i64) -> Stamp {
        let Some((h, m, s)) = self.time else {
            return Stamp { date: self.date.add_days(secs.div_euclid(86_400)), time: None, tz: self.tz.clone() };
        };
        let total = i64::from(h * 3600 + m * 60 + s) + secs;
        let t = total.rem_euclid(86_400) as u32;
        Stamp { date: self.date.add_days(total.div_euclid(86_400)), time: Some((t / 3600, t / 60 % 60, t % 60)), tz: self.tz.clone() }
    }
    fn seconds_until(&self, other: &Stamp) -> i64 {
        let secs = |s: &Stamp| s.date.days() * 86_400 + s.time.map_or(0, |(h, m, x)| i64::from(h * 3600 + m * 60 + x));
        secs(other) - secs(self)
    }
}

impl Serialize for Stamp {
    fn serialize<S: Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        let mut st = ser.serialize_struct("Stamp", 3)?;
        st.serialize_field("date", &self.date.date_string())?;
        st.serialize_field("time", &self.time.map(|(h, m, s)| format!("{h:02}:{m:02}:{s:02}")))?;
        st.serialize_field("tz", &self.tz)?;
        st.end()
    }
}

// ── URL ──────────────────────────────────────────────────────────────────────

/// The subscription URL to fetch, or None. `webcal://` becomes `https://`; plain `http`,
/// other schemes, embedded credentials and whitespace inside are refused.
pub fn subscription_url(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > crate::secrets::MAX_VALUE_BYTES || raw.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return None;
    }
    let lower = raw.to_ascii_lowercase();
    let rest = if lower.starts_with("https://") {
        &raw[8..]
    } else if lower.starts_with("webcal://") {
        &raw[9..]
    } else {
        return None;
    };
    let host_part = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host_part.is_empty() || host_part.contains('@') {
        return None;
    }
    Some(format!("https://{rest}"))
}

// ── Parser ───────────────────────────────────────────────────────────────────

/// Wall time (h, m, s).
type Clock = (u32, u32, u32);
/// An instance's identity inside its series: date and optional wall time.
type Slot = (Date, Option<Clock>);
/// Property parameters, upper-cased names.
type Params = Vec<(String, String)>;
/// One content line: name, parameters, raw value.
type Prop = (String, Params, String);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Freq {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Rule {
    freq: Freq,
    interval: i64,
    count: Option<usize>,
    until: Option<Stamp>,
    /// (ordinal, weekday 0=Mon): ordinal 0 means "every".
    by_day: Vec<(i32, u32)>,
    by_month_day: Vec<i32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Event {
    uid: String,
    title: String,
    location: Option<String>,
    start: Stamp,
    end: Option<Stamp>,
    duration: Option<i64>,
    /// Some(None) = a rule this parser cannot expand: only the first instance is shown.
    rule: Option<Option<Rule>>,
    exdates: Vec<Slot>,
    recurrence_id: Option<Stamp>,
    cancelled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotACalendar;

fn unfold(text: &str) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for raw in text.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if let Some(cont) = line.strip_prefix([' ', '\t']) {
            if let Some(last) = lines.last_mut() {
                last.push_str(cont);
                continue;
            }
        }
        lines.push(line.to_string());
    }
    lines
}

/// `NAME;P=v;P="v":value` → (NAME upper-cased, params, value).
fn split_line(line: &str) -> Option<(String, Params, &str)> {
    let mut quoted = false;
    let colon = line.char_indices().find(|&(_, c)| {
        if c == '"' {
            quoted = !quoted;
        }
        c == ':' && !quoted
    })?.0;
    let (head, value) = (&line[..colon], &line[colon + 1..]);
    let mut parts = head.split(';');
    let name = parts.next()?.trim().to_ascii_uppercase();
    let params = parts
        .filter_map(|p| p.split_once('='))
        .map(|(k, v)| (k.trim().to_ascii_uppercase(), v.trim().trim_matches('"').to_string()))
        .collect();
    Some((name, params, value))
}

fn unescape(value: &str) -> String {
    let mut out = String::new();
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n') | Some('N') => out.push('\n'),
                Some(other) => out.push(other),
                None => {}
            }
        } else {
            out.push(c);
        }
    }
    out.chars().take(MAX_TEXT).collect()
}

fn num(s: &str) -> Option<u32> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

fn parse_date(v: &str) -> Option<Date> {
    if v.len() != 8 {
        return None;
    }
    let d = Date::new(num(&v[..4])? as i32, num(&v[4..6])?, num(&v[6..8])?);
    d.valid().then_some(d)
}

/// DATE or DATE-TIME value, with the TZID parameter when there is one.
fn parse_stamp(params: &[(String, String)], value: &str) -> Option<Stamp> {
    let value = value.trim();
    let tzid = params.iter().find(|(k, _)| k == "TZID").map(|(_, v)| v.clone()).filter(|v| !v.is_empty());
    if value.len() == 8 {
        return Some(Stamp { date: parse_date(value)?, time: None, tz: None });
    }
    let (date, rest) = value.split_once('T')?;
    let (clock, utc) = match rest.strip_suffix('Z') {
        Some(c) => (c, true),
        None => (rest, false),
    };
    if clock.len() != 6 {
        return None;
    }
    let (h, m, s) = (num(&clock[..2])?, num(&clock[2..4])?, num(&clock[4..6])?);
    if h > 23 || m > 59 || s > 60 {
        return None;
    }
    let tz = if utc { Some("UTC".to_string()) } else { tzid.map(|t| t.chars().take(MAX_TEXT).collect()) };
    Some(Stamp { date: parse_date(date)?, time: Some((h, m, s.min(59))), tz })
}

/// ISO 8601 duration as used by iCalendar: `[+-]P[nW][nD][T[nH][nM][nS]]`, in seconds.
fn parse_duration(v: &str) -> Option<i64> {
    let v = v.trim();
    let (sign, v) = match v.strip_prefix('-') {
        Some(rest) => (-1, rest),
        None => (1, v.strip_prefix('+').unwrap_or(v)),
    };
    let v = v.strip_prefix('P')?;
    let (mut total, mut digits, mut in_time) = (0i64, String::new(), false);
    for c in v.chars() {
        match c {
            '0'..='9' => digits.push(c),
            'T' => in_time = true,
            'W' | 'D' | 'H' | 'M' | 'S' => {
                let n: i64 = digits.parse().ok()?;
                digits.clear();
                total += n * match (c, in_time) {
                    ('W', false) => 604_800,
                    ('D', false) => 86_400,
                    ('H', true) => 3600,
                    ('M', true) => 60,
                    ('S', true) => 1,
                    _ => return None,
                };
            }
            _ => return None,
        }
    }
    digits.is_empty().then_some(sign * total)
}

fn weekday_code(s: &str) -> Option<u32> {
    ["MO", "TU", "WE", "TH", "FR", "SA", "SU"].iter().position(|d| *d == s).map(|p| p as u32)
}

/// RRULE → Some(rule) when this parser expands it exactly, None when it cannot.
fn parse_rule(value: &str) -> Option<Rule> {
    let mut rule = Rule { freq: Freq::Daily, interval: 1, count: None, until: None, by_day: Vec::new(), by_month_day: Vec::new() };
    let mut freq = None;
    for part in value.split(';').filter(|p| !p.is_empty()) {
        let (k, v) = part.split_once('=')?;
        match k.to_ascii_uppercase().as_str() {
            "FREQ" => {
                freq = Some(match v.to_ascii_uppercase().as_str() {
                    "DAILY" => Freq::Daily,
                    "WEEKLY" => Freq::Weekly,
                    "MONTHLY" => Freq::Monthly,
                    "YEARLY" => Freq::Yearly,
                    _ => return None,
                })
            }
            "INTERVAL" => rule.interval = i64::from(num(v)?.max(1)),
            "COUNT" => rule.count = Some(num(v)? as usize),
            "UNTIL" => rule.until = Some(parse_stamp(&[], v)?),
            "WKST" => {}
            "BYDAY" => {
                for d in v.split(',') {
                    let d = d.trim().to_ascii_uppercase();
                    let (ord, code) = d.split_at(d.len().checked_sub(2)?);
                    let ord: i32 = if ord.is_empty() { 0 } else { ord.trim_start_matches('+').parse().ok()? };
                    rule.by_day.push((ord, weekday_code(code)?));
                }
            }
            "BYMONTHDAY" => {
                for d in v.split(',') {
                    let n: i32 = d.trim().parse().ok()?;
                    if n == 0 || n.abs() > 31 {
                        return None;
                    }
                    rule.by_month_day.push(n);
                }
            }
            _ => return None,
        }
    }
    rule.freq = freq?;
    let ordinals = rule.by_day.iter().any(|&(o, _)| o != 0);
    let supported = match rule.freq {
        Freq::Daily => rule.by_day.is_empty() && rule.by_month_day.is_empty(),
        Freq::Weekly => !ordinals && rule.by_month_day.is_empty(),
        Freq::Monthly => rule.by_day.is_empty() || rule.by_month_day.is_empty(),
        Freq::Yearly => rule.by_day.is_empty() && rule.by_month_day.is_empty(),
    };
    supported.then_some(rule)
}

/// Parses VEVENTs. Err when the text is not an iCalendar at all.
pub fn parse_ics(text: &str) -> Result<Vec<Event>, NotACalendar> {
    let lines = unfold(text);
    if !lines.iter().any(|l| l.trim().eq_ignore_ascii_case("BEGIN:VCALENDAR")) {
        return Err(NotACalendar);
    }
    let mut events = Vec::new();
    let mut current: Option<(Vec<Prop>, usize)> = None;
    for line in &lines {
        let Some((name, params, value)) = split_line(line) else { continue };
        match (name.as_str(), value.trim().to_ascii_uppercase().as_str()) {
            ("BEGIN", "VEVENT") => current = Some((Vec::new(), 0)),
            // Nested components (VALARM) do not override the event's own properties.
            ("BEGIN", _) => {
                if let Some((_, depth)) = current.as_mut() {
                    *depth += 1;
                }
            }
            ("END", "VEVENT") => {
                if let Some((props, _)) = current.take() {
                    if let Some(event) = build_event(&props) {
                        events.push(event);
                        if events.len() >= MAX_EVENTS {
                            break;
                        }
                    }
                }
            }
            ("END", _) => {
                if let Some((_, depth)) = current.as_mut() {
                    *depth = depth.saturating_sub(1);
                }
            }
            _ => {
                if let Some((props, 0)) = current.as_mut() {
                    props.push((name, params, value.to_string()));
                }
            }
        }
    }
    Ok(events)
}

fn build_event(props: &[Prop]) -> Option<Event> {
    let get = |n: &str| props.iter().find(|(k, _, _)| k == n);
    let (_, sp, sv) = get("DTSTART")?;
    let start = parse_stamp(sp, sv)?;
    let mut exdates = Vec::new();
    for (_, p, v) in props.iter().filter(|(k, _, _)| k == "EXDATE") {
        for one in v.split(',') {
            if let Some(s) = parse_stamp(p, one) {
                exdates.push(s.key());
            }
        }
    }
    Some(Event {
        uid: get("UID").map(|(_, _, v)| v.trim().to_string()).unwrap_or_default(),
        title: get("SUMMARY").map(|(_, _, v)| unescape(v)).unwrap_or_default(),
        location: get("LOCATION").map(|(_, _, v)| unescape(v)).filter(|l| !l.trim().is_empty()),
        end: get("DTEND").and_then(|(_, p, v)| parse_stamp(p, v)),
        duration: get("DURATION").and_then(|(_, _, v)| parse_duration(v)),
        rule: get("RRULE").map(|(_, _, v)| parse_rule(v)),
        exdates,
        recurrence_id: get("RECURRENCE-ID").and_then(|(_, p, v)| parse_stamp(p, v)),
        cancelled: get("STATUS").is_some_and(|(_, _, v)| v.trim().eq_ignore_ascii_case("CANCELLED")),
        start,
    })
}

// ── Expansion ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Occurrence {
    pub title: String,
    pub location: Option<String>,
    pub all_day: bool,
    pub start: Stamp,
    pub end: Stamp,
}

impl Serialize for Occurrence {
    fn serialize<S: Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        let mut st = ser.serialize_struct("Occurrence", 5)?;
        st.serialize_field("title", &self.title)?;
        st.serialize_field("location", &self.location)?;
        st.serialize_field("allDay", &self.all_day)?;
        st.serialize_field("start", &self.start)?;
        st.serialize_field("end", &self.end)?;
        st.end()
    }
}

/// Days of `month` (y, m) a monthly rule selects, ascending.
fn month_days(rule: &Rule, first: Date, y: i32, m: u32) -> Vec<u32> {
    let dim = days_in_month(y, m);
    let mut days: Vec<u32> = if !rule.by_month_day.is_empty() {
        rule.by_month_day.iter().filter_map(|&n| {
            let d = if n > 0 { n } else { dim as i32 + 1 + n };
            (d >= 1 && d as u32 <= dim).then_some(d as u32)
        }).collect()
    } else if !rule.by_day.is_empty() {
        let mut out = Vec::new();
        for &(ord, wd) in &rule.by_day {
            let matching: Vec<u32> = (1..=dim).filter(|&d| Date::new(y, m, d).weekday() == wd).collect();
            match ord {
                0 => out.extend(matching),
                n if n > 0 => out.extend(matching.get(n as usize - 1)),
                n => out.extend(matching.len().checked_sub(n.unsigned_abs() as usize).and_then(|i| matching.get(i))),
            }
        }
        out
    } else {
        if first.d <= dim { vec![first.d] } else { vec![] }
    };
    days.sort_unstable();
    days.dedup();
    days
}

/// Start dates of a rule, in order, from the event's first date up to `to` (inclusive).
fn rule_dates(rule: &Rule, first: Date, to: Date, mut keep: impl FnMut(Date) -> bool) {
    let mut steps = 0usize;
    match rule.freq {
        Freq::Daily => {
            let mut d = first;
            while d <= to && steps < MAX_STEPS {
                if !keep(d) {
                    return;
                }
                d = d.add_days(rule.interval);
                steps += 1;
            }
        }
        Freq::Weekly => {
            let week0 = first.add_days(-i64::from(first.weekday()));
            let days: Vec<u32> = if rule.by_day.is_empty() { vec![first.weekday()] } else { rule.by_day.iter().map(|&(_, w)| w).collect() };
            let mut week = week0;
            while week <= to && steps < MAX_STEPS {
                for wd in 0..7 {
                    let d = week.add_days(wd);
                    if d >= first && d <= to && days.contains(&(wd as u32)) && !keep(d) {
                        return;
                    }
                }
                week = week.add_days(7 * rule.interval);
                steps += 1;
            }
        }
        Freq::Monthly | Freq::Yearly => {
            let (mut y, mut m) = (first.y, first.m);
            let step_months = if rule.freq == Freq::Yearly { 12 * rule.interval } else { rule.interval };
            while Date::new(y, m, 1) <= to && steps < MAX_STEPS {
                for d in month_days(rule, first, y, m) {
                    let date = Date::new(y, m, d);
                    if date >= first && date <= to && !keep(date) {
                        return;
                    }
                }
                let next = i64::from(m) - 1 + step_months;
                y += next.div_euclid(12) as i32;
                m = next.rem_euclid(12) as u32 + 1;
                steps += 1;
            }
        }
    }
}

/// Occurrences that touch any date in `[from, to]`, sorted by date, all-day first, then time.
pub fn occurrences(events: &[Event], from: Date, to: Date) -> Vec<Occurrence> {
    // Instances that a RECURRENCE-ID event moved or cancelled.
    let moved: Vec<(&str, Slot)> =
        events.iter().filter_map(|e| Some((e.uid.as_str(), e.recurrence_id.as_ref()?.key()))).collect();
    let mut out = Vec::new();
    for event in events {
        let all_day = event.start.time.is_none();
        let length = match (&event.end, event.duration) {
            (Some(end), _) => event.start.seconds_until(end).max(0),
            (None, Some(secs)) => secs.max(0),
            (None, None) if all_day => 86_400,
            _ => 0,
        };
        let mut push = |start: Stamp| {
            let end = start.plus_seconds(length);
            let last = if all_day && length > 0 { end.date.add_days(-1) } else { end.date };
            if !event.cancelled && start.date <= to && last >= from {
                out.push(Occurrence { title: event.title.clone(), location: event.location.clone(), all_day, start, end });
            }
        };
        match &event.rule {
            Some(Some(rule)) if event.recurrence_id.is_none() => {
                let mut seen = 0usize;
                rule_dates(rule, event.start.date, to, |date| {
                    let start = event.start.on(date);
                    if let Some(until) = &rule.until {
                        let past = match until.time { Some(_) => start.key() > until.key(), None => date > until.date };
                        if past {
                            return false;
                        }
                    }
                    seen += 1;
                    if rule.count.is_some_and(|c| seen > c) {
                        return false;
                    }
                    let key = start.key();
                    let skipped = event.exdates.contains(&key)
                        || event.exdates.iter().any(|(d, t)| t.is_none() && *d == date)
                        || moved.iter().any(|(uid, k)| *uid == event.uid && *k == key);
                    if !skipped {
                        push(start);
                    }
                    true
                });
            }
            _ => push(event.start.clone()),
        }
    }
    out.sort_by(|a, b| {
        (a.start.date, !a.all_day, a.start.time, &a.title).cmp(&(b.start.date, !b.all_day, b.start.time, &b.title))
    });
    out.truncate(MAX_OCCURRENCES);
    out
}

// ── Refresh ──────────────────────────────────────────────────────────────────

/// Why the calendar could not be read. Codes are fixed strings: never the URL, never a server text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unavailable {
    NotConfigured,
    BadUrl,
    Unreachable,
    Refused,
    BadAnswer,
}

impl Unavailable {
    pub fn code(self) -> &'static str {
        match self {
            Unavailable::NotConfigured => "not_configured",
            Unavailable::BadUrl => "bad_url",
            Unavailable::Unreachable => "unreachable",
            Unavailable::Refused => "refused",
            Unavailable::BadAnswer => "bad_answer",
        }
    }
}

/// Closed request: exactly `{action:"refresh"}`.
pub fn parse_request(payload: &Value) -> Result<(), crate::bridge::BridgeError> {
    let ok = payload.as_object().is_some_and(|m| m.len() == 1 && m.get("action").and_then(Value::as_str) == Some("refresh"));
    if ok { Ok(()) } else { Err(crate::bridge::BridgeError::denied("invalid calendar request")) }
}

/// Last good answer, bound to a digest of the URL it came from (never the URL itself).
#[derive(Default)]
pub struct Cache {
    source: Option<[u8; 32]>,
    answer: Option<(u64, Value)>,
}

fn digest(url: &str) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    Sha256::digest(url.as_bytes()).into()
}

impl Cache {
    /// `{available:true, events, fetchedAt}` or `{available:false, reason}`. A changed URL drops
    /// the old answer; a failure caches nothing.
    pub fn refresh<F>(&mut self, saved: Option<&str>, now_ms: u64, fetch: F) -> Value
    where
        F: FnOnce(&str) -> Result<String, Unavailable>,
    {
        let answer = (|| {
            let saved = saved.map(str::trim).filter(|s| !s.is_empty()).ok_or(Unavailable::NotConfigured)?;
            let url = subscription_url(saved).ok_or(Unavailable::BadUrl)?;
            let source = digest(&url);
            if self.source != Some(source) {
                self.source = Some(source);
                self.answer = None;
            }
            if let Some((at, value)) = &self.answer {
                if now_ms.saturating_sub(*at) < MAX_AGE_MS {
                    return Ok(value.clone());
                }
            }
            let text = fetch(&url)?;
            let events = parse_ics(&text).map_err(|_| Unavailable::BadAnswer)?;
            let (from, to) = window(Date::from_unix_ms(now_ms));
            let value = json!({ "available": true, "events": occurrences(&events, from, to), "fetchedAt": now_ms });
            self.answer = Some((now_ms, value.clone()));
            Ok(value)
        })();
        answer.unwrap_or_else(|why: Unavailable| {
            if why == Unavailable::NotConfigured {
                self.source = None;
                self.answer = None;
            }
            json!({ "available": false, "reason": why.code() })
        })
    }
}

/// Downloads the calendar over HTTPS only (rustls, every OS). Redirects are followed at most
/// five times and only to https; no proxy; 20 s; at most [`MAX_ICS_BYTES`].
pub fn fetch_ics(url: &str) -> Result<String, Unavailable> {
    fetch_at(url, true)
}

fn fetch_at(url: &str, https_only: bool) -> Result<String, Unavailable> {
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|_| Unavailable::Unreachable)?;
    runtime.block_on(async {
        let policy = reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() >= 5 || (https_only && attempt.url().scheme() != "https") {
                attempt.stop()
            } else {
                attempt.follow()
            }
        });
        let client = reqwest::Client::builder().no_proxy().redirect(policy).https_only(https_only)
            .timeout(std::time::Duration::from_secs(20)).build().map_err(|_| Unavailable::Unreachable)?;
        let mut response = client.get(url).header("User-Agent", "Koda").header("Accept", "text/calendar")
            .send().await.map_err(|_| Unavailable::Unreachable)?;
        let status = response.status().as_u16();
        if matches!(status, 401 | 403 | 404 | 410) {
            return Err(Unavailable::Refused);
        }
        if !response.status().is_success() {
            return Err(Unavailable::Unreachable);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| Unavailable::Unreachable)? {
            if bytes.len() + chunk.len() > MAX_ICS_BYTES {
                return Err(Unavailable::BadAnswer);
            }
            bytes.extend_from_slice(&chunk);
        }
        String::from_utf8(bytes).map_err(|_| Unavailable::BadAnswer)
    })
}
