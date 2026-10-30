//! «Entrenar mi voz»: the user says «OK Abito» a few times; each recording goes through the
//! same VAD + Parakeet path as the live listener, and Abito keeps how THIS person's phrase is
//! transcribed (normalised text only, never audio). The learned spellings are extra accepted
//! spellings under the same safety rules as the built-in ones (see `wake::match_wake_with`).
use serde::{Deserialize, Serialize};
use std::path::Path;

use super::wake::{NAMES, OK_WORDS};
use crate::voiceintent::normalise;

pub const TARGET: usize = 5;
pub const MAX_NAMES: usize = 6;
pub const MAX_LEADS: usize = 4;
pub const FILE: &str = "voice-training.json";
/// A spelling must be heard in at least this many recordings to be kept.
const MIN_SEEN: usize = 2;

/// Everyday words that must never become a wake spelling or a lead word.
pub(crate) const COMMON: &[&str] = &[
    "hola", "bonito", "aqui", "abrir", "abrigo", "abril", "okupa", "vale", "habia", "habla", "hablar", "hacer", "hace", "tengo", "monje",
    "musica", "pausa", "tiempo", "gracias", "bueno", "bien", "hasta", "hacia", "claro", "listo", "ahora", "mismo", "cosa", "casa", "abajo", "arriba",
    "adios", "ayuda", "abre", "cierra", "hello", "thanks", "okay", "great", "right", "habit",
];
/// Words that cannot be the lead of the phrase: they open ordinary sentences.
const STOP_LEADS: &[&str] = &[
    "el", "la", "los", "las", "un", "una", "mi", "tu", "su", "de", "del", "que", "y", "o", "a", "en", "es", "se", "me", "te", "lo", "no", "si", "con", "por", "para",
    "the", "and", "my", "your", "of", "to", "is", "in", "pon", "hola", "vale", "como", "pero", "muy", "ya",
];

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Learned {
    /// Extra accepted spellings of the name («gavito»).
    pub names: Vec<String>,
    /// Words that, right before a name, count as the «OK» («yes avito»).
    pub leads: Vec<String>,
    /// The whole phrases heard repeatedly; one alone in a segment is a bare wake.
    pub phrases: Vec<String>,
}

impl Learned {
    pub fn is_empty(&self) -> bool {
        self.names.is_empty() && self.leads.is_empty() && self.phrases.is_empty()
    }
}

fn plain_word(w: &str) -> bool {
    !w.is_empty() && w.chars().all(|c| c.is_alphabetic() && c.is_ascii())
}

fn valid_name(w: &str) -> bool {
    let n = w.chars().count();
    plain_word(w) && (5..=12).contains(&n) && !COMMON.contains(&w) && !OK_WORDS.contains(&w) && w.ends_with("oda") && !super::words::NEVER_KODA.contains(&w)
}

fn valid_lead(w: &str) -> bool {
    let n = w.chars().count();
    plain_word(w) && (2..=8).contains(&n) && !STOP_LEADS.contains(&w) && !COMMON.contains(&w) && !OK_WORDS.contains(&w)
}

/// Splits a normalised phrase into (lead, name) when it looks like a wake phrase. A name split
/// in two short words («ya vito») is learned joined; the matcher already joins such pairs.
fn parts(text: &str) -> Option<(Option<String>, String)> {
    let words: Vec<&str> = text.split_whitespace().collect();
    if words.is_empty() || words.len() > 3 {
        return None;
    }
    let last = *words.last()?;
    if words.len() >= 2 {
        let prev = words[words.len() - 2];
        let joined = format!("{prev}{last}");
        if prev.chars().count() <= 2 && !OK_WORDS.contains(&prev) && !STOP_LEADS.contains(&prev) && valid_name(&joined) {
            let lead = (words.len() == 3).then(|| words[0].to_string());
            return Some((lead, joined));
        }
    }
    if !valid_name(last) {
        return None;
    }
    let lead = (words.len() >= 2).then(|| words[words.len() - 2].to_string());
    Some((lead, last.to_string()))
}

fn ranked(counts: Vec<(String, usize)>, cap: usize) -> Vec<String> {
    let mut v: Vec<(usize, String)> = counts.into_iter().filter(|(_, c)| *c >= MIN_SEEN).map(|(w, c)| (c, w)).collect();
    // Stable: most heard first, ties keep the order of first appearance.
    v.sort_by_key(|e| std::cmp::Reverse(e.0));
    v.into_iter().take(cap).map(|(_, w)| w).collect()
}

fn bump(list: &mut Vec<(String, usize)>, key: &str) {
    match list.iter_mut().find(|(k, _)| k == key) {
        Some(e) => e.1 += 1,
        None => list.push((key.to_string(), 1)),
    }
}

/// What was heard in the recordings, reduced to what is safe to accept from now on.
pub fn learn(transcripts: &[String]) -> Learned {
    let (mut names, mut leads, mut phrases) = (vec![], vec![], vec![]);
    for t in transcripts {
        let text = normalise(t);
        let Some((lead, name)) = parts(&text) else { continue };
        bump(&mut names, &name);
        bump(&mut phrases, &text);
        if let Some(l) = lead.filter(|l| valid_lead(l)) {
            bump(&mut leads, &l);
        }
    }
    Learned {
        names: ranked(names, MAX_NAMES).into_iter().filter(|n| !NAMES.contains(&n.as_str())).collect(),
        leads: ranked(leads, MAX_LEADS),
        phrases: ranked(phrases, MAX_NAMES),
    }
}

/// Re-applies every rule to a stored file, so a hand-edited one cannot loosen the matcher.
fn sanitised(l: Learned) -> Learned {
    let mut out = Learned {
        names: l.names.into_iter().filter(|n| valid_name(n) && !NAMES.contains(&n.as_str())).collect(),
        leads: l.leads.into_iter().filter(|w| valid_lead(w)).collect(),
        phrases: l.phrases.into_iter().filter(|p| normalise(p) == *p && parts(p).is_some()).collect(),
    };
    out.names.truncate(MAX_NAMES);
    out.leads.truncate(MAX_LEADS);
    out.phrases.truncate(MAX_NAMES);
    out
}

pub fn load_in(dir: &Path) -> Learned {
    std::fs::read_to_string(dir.join(FILE)).ok().and_then(|t| serde_json::from_str(&t).ok()).map(sanitised).unwrap_or_default()
}

pub fn save_in(dir: &Path, learned: &Learned) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let text = serde_json::to_string_pretty(learned).map_err(std::io::Error::other)?;
    let tmp = dir.join(format!("{FILE}.tmp"));
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, dir.join(FILE))
}

pub fn reset_in(dir: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(dir.join(FILE)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

/// Listens once through the real microphone path (VAD, then the recognizer).
/// `Ok(None)` is silence; the audio is gone as soon as it is transcribed.
pub trait Recorder {
    fn hear(&self) -> Result<Option<String>, String>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    Heard { text: String, count: usize },
    Silence,
}

/// One training session: up to `TARGET` heard recordings, with undo and cancel.
#[derive(Debug, Default)]
pub struct Trainer {
    heard: Vec<String>,
    active: bool,
}

impl Trainer {
    pub fn active(&self) -> bool {
        self.active
    }

    pub fn recorded(&self) -> usize {
        self.heard.len()
    }

    pub fn last(&self) -> Option<&str> {
        self.heard.last().map(String::as_str)
    }

    pub fn record(&mut self, rec: &dyn Recorder) -> Result<Step, String> {
        if self.heard.len() >= TARGET {
            return Err("already recorded".into());
        }
        self.active = true;
        let heard = rec.hear()?;
        let Some(text) = heard.map(|t| t.trim().to_string()).filter(|t| !normalise(t).is_empty()) else { return Ok(Step::Silence) };
        self.heard.push(text.clone());
        Ok(Step::Heard { text, count: self.heard.len() })
    }

    /// Drops the last recording (to redo it).
    pub fn undo(&mut self) {
        self.heard.pop();
    }

    pub fn cancel(&mut self) {
        self.heard.clear();
        self.active = false;
    }

    pub fn finish(&mut self) -> Result<Learned, String> {
        if self.heard.len() < TARGET {
            return Err(format!("{} of {TARGET} recordings", self.heard.len()));
        }
        let learned = learn(&self.heard);
        self.cancel();
        Ok(learned)
    }
}
