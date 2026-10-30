use super::*;
use crate::voicecmd::{Gender, Output};
use crate::voiceintent::Lang;
use serde_json::json;

#[test]
fn text_is_sanitised_and_capped_before_it_reaches_any_engine() {
    assert_eq!(sanitise("  hola\u{0}\n mundo  "), "hola mundo");
    assert_eq!(sanitise(&"a".repeat(1000)).chars().count(), MAX_SPOKEN);
    assert_eq!(sanitise("   "), "");
}

#[test]
fn the_system_voice_command_never_lets_text_become_an_option() {
    let a = spd_args("--help; rm -rf /", Lang::Es, Gender::Female);
    let sep = a.iter().position(|x| x == "--").expect("options end before the text");
    assert_eq!(a[sep + 1], "--help; rm -rf /");
    assert_eq!(a.len(), sep + 2, "the text is the last, single argument");
    assert!(a.windows(2).any(|w| w == ["-l", "es"]));
    assert!(a.windows(2).any(|w| w == ["-t", "female1"]));
    let a = spd_args("hello", Lang::En, Gender::Male);
    assert!(a.windows(2).any(|w| w == ["-l", "en"]));
    assert!(a.windows(2).any(|w| w == ["-t", "male1"]));
}

#[test]
fn the_engine_follows_the_choice_and_never_uses_elevenlabs_without_a_key() {
    assert_eq!(engine_for(Output::Off, true), Engine::None);
    assert_eq!(engine_for(Output::System, true), Engine::System);
    assert_eq!(engine_for(Output::ElevenLabs, false), Engine::System, "no key → system voice, never a network call");
    assert_eq!(engine_for(Output::ElevenLabs, true), Engine::ElevenLabs);
}

#[test]
fn an_elevenlabs_voice_is_picked_by_gender_preferring_english() {
    let voices = json!({"voices":[
        {"voice_id":"a","name":"Ana","labels":{"gender":"female","language":"es"}},
        {"voice_id":"b","name":"Bea","labels":{"gender":"female","language":"en"}},
        {"voice_id":"c","name":"Carl","labels":{"gender":"male","accent":"american","age":"old"}},
        {"voice_id":"d","name":"Dan","labels":{"gender":"male","accent":"british","age":"young"}},
    ]});
    assert_eq!(pick_voice(&voices, Gender::Female), Some(("b".into(), "Bea".into())));
    assert_eq!(pick_voice(&voices, Gender::Male), Some(("d".into(), "Dan".into())), "a young male voice first");
    assert_eq!(pick_voice(&json!({"voices":[]}), Gender::Female), None);
    assert_eq!(pick_voice(&json!({}), Gender::Female), None);
    // A voice id that could change the URL is refused.
    let evil = json!({"voices":[{"voice_id":"../x?y=1","name":"E","labels":{"gender":"female"}}]});
    assert_eq!(pick_voice(&evil, Gender::Female), None);
}

#[test]
fn the_elevenlabs_request_is_https_to_the_official_host_with_raw_pcm() {
    let (url, body) = tts_request("voice123", "hola");
    assert!(url.starts_with("https://api.elevenlabs.io/v1/text-to-speech/voice123"), "{url}");
    assert!(url.contains("output_format=pcm_22050"), "{url}");
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["text"], "hola");
    assert_eq!(v["model_id"], "eleven_flash_v2_5");
    assert_eq!(PLAY_RAW_ARGS, ["-q", "-t", "raw", "-f", "S16_LE", "-r", "22050", "-c", "1"]);
}

struct Fake {
    system: std::cell::RefCell<Vec<String>>,
    eleven: std::cell::RefCell<Vec<String>>,
    eleven_ok: bool,
}
impl Voices for Fake {
    fn system(&self, text: &str, _l: Lang, _g: Gender) -> bool { self.system.borrow_mut().push(text.into()); true }
    fn eleven(&self, text: &str, _g: Gender) -> bool { self.eleven.borrow_mut().push(text.into()); self.eleven_ok }
}

#[test]
fn speaking_falls_back_to_the_system_voice_when_elevenlabs_fails() {
    let f = Fake { system: Default::default(), eleven: Default::default(), eleven_ok: false };
    assert!(speak(&f, "hola", Lang::Es, Gender::Female, Engine::ElevenLabs));
    assert_eq!(f.eleven.borrow().len(), 1);
    assert_eq!(f.system.borrow().as_slice(), ["hola"]);
}

#[test]
fn off_and_empty_text_say_nothing() {
    let f = Fake { system: Default::default(), eleven: Default::default(), eleven_ok: true };
    assert!(!speak(&f, "hola", Lang::Es, Gender::Female, Engine::None));
    assert!(!speak(&f, "  \n", Lang::Es, Gender::Female, Engine::System));
    assert!(f.system.borrow().is_empty() && f.eleven.borrow().is_empty());
}
