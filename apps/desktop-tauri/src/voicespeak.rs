//! Spoken replies: the system voice (speech-dispatcher) by default, and ElevenLabs only
//! when the user chose it AND saved a key. Pure planning here; the host runs the commands.
//! ElevenLabs costs the user money: nothing in this module touches the network, and the
//! tests never do.
//!
//! Adapted from Coucou NotchBuddy Voice/{VoiceSpeaker,ElevenLabsTTS}.swift @71b773f,
//! Copyright (c) 2026 Louis Raillé, MIT.
use crate::voicecmd::{Gender, Output};
use crate::voiceintent::Lang;
use serde_json::Value;

pub const MAX_SPOKEN: usize = 400;
pub const KEY_NAME: &str = "elevenlabs-api-key";
const MODEL: &str = "eleven_flash_v2_5";
/// `aplay` arguments for the raw PCM ElevenLabs returns (22.05 kHz, 16-bit mono).
pub const PLAY_RAW_ARGS: [&str; 9] = ["-q", "-t", "raw", "-f", "S16_LE", "-r", "22050", "-c", "1"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Engine {
    None,
    System,
    ElevenLabs,
}

pub fn engine_for(output: Output, has_key: bool) -> Engine {
    match output {
        Output::Off => Engine::None,
        Output::System => Engine::System,
        Output::ElevenLabs if has_key => Engine::ElevenLabs,
        Output::ElevenLabs => Engine::System,
    }
}

pub fn sanitise(text: &str) -> String {
    let t: String = text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    t.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(MAX_SPOKEN).collect::<String>().trim().to_string()
}

/// `spd-say` arguments. The text comes after `--`, so it can never be read as an option.
pub fn spd_args(text: &str, lang: Lang, gender: Gender) -> Vec<String> {
    let l = match lang { Lang::Es => "es", Lang::En => "en" };
    let v = match gender { Gender::Female => "female1", Gender::Male => "male1" };
    ["-w", "-l", l, "-t", v, "--"].iter().map(|s| s.to_string()).chain(std::iter::once(text.to_string())).collect()
}

fn safe_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The first English voice of the gender (a young one first for a man), else any of the
/// gender, else the first. None when the list is empty or the id is not a plain token.
pub fn pick_voice(voices: &Value, gender: Gender) -> Option<(String, String)> {
    let list = voices.get("voices")?.as_array()?;
    let want = match gender { Gender::Female => "female", Gender::Male => "male" };
    let label = |v: &Value, k: &str| v.get("labels").and_then(|l| l.get(k)).and_then(Value::as_str).map(str::to_lowercase);
    let english = |v: &Value| {
        if let Some(l) = label(v, "language") { return l.starts_with("en"); }
        let a = label(v, "accent").unwrap_or_default();
        a.is_empty() || ["american", "british", "australian", "irish", "english", "us", "uk"].iter().any(|k| a.contains(k))
    };
    let of_gender: Vec<&Value> = list.iter().filter(|v| label(v, "gender").as_deref() == Some(want)).collect();
    let en: Vec<&Value> = of_gender.iter().copied().filter(|v| english(v)).collect();
    let young = (gender == Gender::Male).then(|| en.iter().copied().find(|v| label(v, "age").is_some_and(|a| a.contains("young")))).flatten();
    let v = young.or(en.first().copied()).or(of_gender.first().copied()).or(list.first())?;
    let id = v.get("voice_id")?.as_str()?;
    if !safe_id(id) { return None; }
    Some((id.to_string(), v.get("name").and_then(Value::as_str).unwrap_or(id).to_string()))
}

/// (URL, JSON body) of one text-to-speech call. The voice id must already be a safe token.
pub fn tts_request(voice_id: &str, text: &str) -> (String, String) {
    (
        format!("https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=pcm_22050"),
        serde_json::json!({ "text": text, "model_id": MODEL }).to_string(),
    )
}

/// The two ways of making sound; the host implements them, tests fake them.
pub trait Voices {
    fn system(&self, text: &str, lang: Lang, gender: Gender) -> bool;
    /// False on any failure (no network, quota, bad key): the caller falls back.
    fn eleven(&self, text: &str, gender: Gender) -> bool;
}

/// Speaks `text`. Any ElevenLabs failure falls back to the system voice: Abito never goes silent.
pub fn speak(v: &dyn Voices, text: &str, lang: Lang, gender: Gender, engine: Engine) -> bool {
    let text = sanitise(text);
    if text.is_empty() || engine == Engine::None {
        return false;
    }
    if engine == Engine::ElevenLabs && v.eleven(&text, gender) {
        return true;
    }
    v.system(&text, lang, gender)
}

#[cfg(test)]
#[path = "voicespeak_tests.rs"]
mod tests;
