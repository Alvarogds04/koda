//! Custom words, the Handy way: a fuzzy post-correction of the transcript towards the words the
//! user cares about («Abito» is always one of them). Spanish speakers get «Habito», «Yavito»,
//! «Yavita», «ya vito»… from the recognizer; this turns the near spellings back into the word.
//!
//! Adapted from Handy src-tauri/src/audio_toolkit/text.rs (`apply_custom_words`) @ main,
//! Copyright (c) 2025 CJ Pais, MIT: the n-gram window (up to three words, never across a
//! punctuation boundary), the length guard and the "phonetic match boosts the score" idea.
//! Handy's Soundex is English-only, so a small Spanish phonetic key replaces it.
use super::train::COMMON;
use super::wake::{levenshtein, OK_WORDS};
use crate::voiceintent::normalise;

pub const MAX_WORDS: usize = 50;
const MAX_WORD_CHARS: usize = 40;
/// Always corrected towards, with the stricter guard below.
pub const BUILT_IN: &str = "Koda";
/// Conservative: only near spellings of the built-in word (score 0 = exact, 1 = anything).
const BUILT_IN_THRESHOLD: f64 = 0.3;
const USER_THRESHOLD: f64 = 0.4;
/// Real Spanish words that sound like «Koda» and must NEVER be rewritten into it nor wake the app (human 30-oct: «solo koda»;
/// measured against a corpus of everyday phrases in `koda_word_tests`). «Koda» has four letters, so an edit-distance match alone
/// would catch a good part of the dictionary: the corrector below only ever accepts the exact spellings in `KODA_HEARD`.
pub(crate) const NEVER_KODA: &[&str] = &[
    "toda", "todo", "todas", "todos", "soda", "moda", "boda", "roda", "joda", "poda", "coca", "copa", "coma", "cola", "cosa",
    "toca", "toma", "codo", "cada", "cote", "dota", "nota", "bota", "rota", "gota", "mota", "coda", "cota",
];
/// How the recogniser writes «Koda» (it often hears a hard «c» for the «k»). Only these exact spellings are corrected; «coda» is here
/// because it is the transcription of the name, and it is only ever rewritten when it is the first word followed by a comma and a
/// command (the vocative), never in the middle of a sentence («una coda»): see `correct`.
pub(crate) const KODA_HEARD: &[&str] = &["koda", "qoda", "kouda", "kodá", "codá", "kodda"];

fn key(word: &str) -> String {
    normalise(word).chars().filter(|c| c.is_ascii_alphanumeric()).collect()
}

/// A rough Spanish sound-alike key: silent h, b/v/w alike, a leading y or h dropped, a final
/// vowel (o/a/e) alike («yavito» ≈ «yavita» ≈ «abito»).
fn phonetic(k: &str) -> String {
    let mut s: String = k.chars().filter(|c| *c != 'h').map(|c| if matches!(c, 'v' | 'w') { 'b' } else { c }).collect();
    if let Some(rest) = s.strip_prefix('y') {
        s = rest.to_string();
    }
    if s.ends_with(['o', 'a', 'e']) {
        s.pop();
        s.push('_');
    }
    s
}

fn split_punct(word: &str) -> (&str, &str, &str) {
    let start = word.char_indices().find(|(_, c)| c.is_alphanumeric()).map(|(i, _)| i).unwrap_or(word.len());
    let end = word.char_indices().rev().find(|(_, c)| c.is_alphanumeric()).map(|(i, c)| i + c.len_utf8()).unwrap_or(start);
    (&word[..start], &word[start..end], &word[end..])
}

fn preserve_case(original: &str, replacement: &str) -> String {
    let letters: Vec<char> = original.chars().filter(|c| c.is_alphabetic()).collect();
    if letters.len() > 1 && letters.iter().all(|c| c.is_uppercase()) {
        replacement.to_uppercase()
    } else {
        replacement.to_string()
    }
}

fn score(candidate: &str, target: &str) -> Option<f64> {
    let (a, b) = (candidate.chars().count(), target.chars().count());
    let max = a.max(b) as f64;
    if (a.abs_diff(b) as f64) > (max * 0.25).max(2.0) {
        return None;
    }
    let lev = levenshtein(candidate, target) as f64 / max;
    Some(if phonetic(candidate) == phonetic(target) { lev * 0.3 } else { lev })
}

/// Handy's `apply_custom_words`: every word (or two or three joined words) close enough to one
/// of `words` is replaced by it, keeping the punctuation around and an ALL-CAPS look.
pub fn apply_custom_words(text: &str, words: &[String], threshold: f64) -> String {
    apply(text, words, threshold, |_| true)
}

fn apply(text: &str, words: &[String], threshold: f64, allowed: impl Fn(&str) -> bool) -> String {
    let targets: Vec<(String, &String)> = words.iter().map(|w| (key(w), w)).filter(|(k, _)| k.chars().count() >= 3).collect();
    if targets.is_empty() {
        return text.to_string();
    }
    let parts: Vec<&str> = text.split_whitespace().collect();
    let mut out = vec![];
    let mut i = 0;
    while i < parts.len() {
        let mut best: Option<(usize, &String, f64)> = None;
        for n in (1..=3).rev() {
            if i + n > parts.len() {
                continue;
            }
            // A punctuation mark inside the window closes it.
            if parts[i..i + n - 1].iter().any(|w| !split_punct(w).2.is_empty()) {
                continue;
            }
            // Every word of a joined window has to carry a piece of the target («ya»+«vito»), so
            // a neighbour that merely sits next to the word («usa» before «kubernetis») is left alone.
            let cand: String = parts[i..i + n].iter().map(|w| key(w)).collect();
            let carries = |t: &str| parts[i..i + n].iter().map(|w| key(w)).all(|k| (k.chars().count() <= 2 && !OK_WORDS.contains(&k.as_str())) || k.chars().collect::<Vec<_>>().windows(2).any(|p| t.contains(&p.iter().collect::<String>())));
            if n > 1 && !targets.iter().any(|(t, _)| carries(t)) {
                continue;
            }
            if cand.is_empty() || cand.chars().count() > 50 || !allowed(&cand) {
                continue;
            }
            for (k, w) in &targets {
                if let Some(sc) = score(&cand, k) {
                    if sc < threshold && best.is_none_or(|(_, _, b)| sc < b) {
                        best = Some((n, w, sc));
                    }
                }
            }
        }
        match best {
            Some((n, w, _)) => {
                let (prefix, _, _) = split_punct(parts[i]);
                let (_, _, suffix) = split_punct(parts[i + n - 1]);
                out.push(format!("{prefix}{}{suffix}", preserve_case(parts[i], w)));
                i += n;
            }
            None => {
                out.push(parts[i].to_string());
                i += 1;
            }
        }
    }
    out.join(" ")
}

/// The user's words first, then the built-in «Koda», which never replaces a common word (only its exact known spellings).
pub fn correct(text: &str, user_words: &[String]) -> String {
    let mut user = apply_custom_words(text, user_words, USER_THRESHOLD);
    // «Kota, ¿qué hora es?»: «cota» is also a real word (a height), so only the vocative reading
    // (first word, comma right after, a command following) is the name. «coda» is never the name (see wake::NAMES_VOCATIVE_ONLY).
    if let Some((first, rest)) = user.split_once(' ') {
        if first.ends_with(',') && matches!(key(first).as_str(), "kota" | "cota") && !rest.trim().is_empty() {
            user = format!("{BUILT_IN}, {rest}");
        }
    }
    apply(&user, &[BUILT_IN.to_string()], BUILT_IN_THRESHOLD, |cand| {
        !NEVER_KODA.contains(&cand) && !COMMON.contains(&cand) && KODA_HEARD.contains(&cand)
    })
}

/// Trims, drops duplicates (any case), empties, too short/long words, control characters and
/// the wake «ok», and caps the list.
pub fn clean_words(words: &[String]) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for w in words {
        let w = w.trim();
        let n = w.chars().count();
        if !(3..=MAX_WORD_CHARS).contains(&n) || w.chars().any(char::is_control) || key(w) == "ok" {
            continue;
        }
        if out.iter().any(|o| o.to_lowercase() == w.to_lowercase()) {
            continue;
        }
        out.push(w.to_string());
        if out.len() == MAX_WORDS {
            break;
        }
    }
    out
}
