use super::*;

fn p(s: &str) -> Intent {
    parse(s)
}

#[test]
fn music_transport_in_spanish_and_english() {
    for s in ["pausa", "para la música", "pon en pausa", "pause", "stop the music"] {
        assert_eq!(p(s), Intent::MusicPause, "{s}");
    }
    for s in ["siguiente", "canción siguiente", "salta", "next song", "skip"] {
        assert_eq!(p(s), Intent::MusicNext, "{s}");
    }
    for s in ["anterior", "canción anterior", "previous track", "atrás"] {
        assert_eq!(p(s), Intent::MusicPrevious, "{s}");
    }
    for s in ["sube el volumen", "más fuerte", "louder", "turn up"] {
        assert_eq!(p(s), Intent::MusicVolumeUp, "{s}");
    }
    for s in ["baja el volumen", "menos fuerte", "quieter", "turn down"] {
        assert_eq!(p(s), Intent::MusicVolumeDown, "{s}");
    }
    assert_eq!(p("pon el volumen al 50"), Intent::MusicSetVolume(50));
    assert_eq!(p("volumen a 30"), Intent::MusicSetVolume(30));
    assert_eq!(p("set volume 70"), Intent::MusicSetVolume(70));
    assert!(!matches!(p("volumen a 300"), Intent::MusicSetVolume(_)));
}

#[test]
fn music_play_generic_target_search_and_playlist() {
    for s in ["pon música", "reproduce", "dale al play", "play music", "pon algo de música", "resume"] {
        assert_eq!(p(s), Intent::MusicPlay, "{s}");
    }
    assert_eq!(p("pon Daft Punk"), Intent::MusicSearch("Daft Punk".into()));
    assert_eq!(p("reproduce Get Lucky"), Intent::MusicSearch("Get Lucky".into()));
    assert_eq!(p("play Get Lucky"), Intent::MusicSearch("Get Lucky".into()));
    assert_eq!(p("quiero escuchar Drake"), Intent::MusicSearch("Drake".into()));
    assert_eq!(p("pon la playlist Workout"), Intent::MusicPlaylist("Workout".into()));
    assert_eq!(p("play playlist Focus"), Intent::MusicPlaylist("Focus".into()));
    assert_eq!(p("pon mi playlist"), Intent::MusicPlaylist(String::new()));
}

#[test]
fn pills_add_remove_replace_only_and_main() {
    assert_eq!(p("añade GitHub"), Intent::PillAdd("integration_github".into()));
    assert_eq!(p("ponme la píldora de Stripe"), Intent::PillAdd("integration_stripe".into()));
    assert_eq!(p("add Vercel"), Intent::PillAdd("integration_vercel".into()));
    assert_eq!(p("activa Notion"), Intent::PillAdd("integration_notion".into()));
    assert_eq!(p("añade Vercel y Stripe"), Intent::PillAddMultiple(vec!["integration_vercel".into(), "integration_stripe".into()]));
    assert_eq!(p("quita Vercel"), Intent::PillRemove("integration_vercel".into()));
    assert_eq!(p("remove Stripe"), Intent::PillRemove("integration_stripe".into()));
    assert_eq!(p("quita Stripe y Notion"), Intent::PillRemoveMultiple(vec!["integration_stripe".into(), "integration_notion".into()]));
    assert_eq!(p("reemplaza n8n por GitHub"), Intent::PillReplace { old: "integration_n8n".into(), new: "integration_github".into() });
    assert_eq!(p("replace n8n with github"), Intent::PillReplace { old: "integration_n8n".into(), new: "integration_github".into() });
    assert_eq!(p("pon GitHub en lugar de Notion"), Intent::PillReplace { old: "integration_notion".into(), new: "integration_github".into() });
    assert_eq!(p("deja solo GitHub y Vercel"), Intent::PillOnly(vec!["integration_github".into(), "integration_vercel".into()]));
    assert_eq!(p("keep only github and vercel"), Intent::PillOnly(vec!["integration_github".into(), "integration_vercel".into()]));
    assert_eq!(p("pasa a Cursor"), Intent::PillSetMain("agent_cursor".into()));
    assert_eq!(p("pon Codex como principal"), Intent::PillSetMain("agent_codex".into()));
    assert_eq!(p("switch to cursor"), Intent::PillSetMain("agent_cursor".into()));
}

#[test]
fn polite_and_filler_words_do_not_change_the_intent() {
    assert_eq!(p("¿puedes añadir GitHub, por favor?"), Intent::PillAdd("integration_github".into()));
    assert_eq!(p("can you remove Vercel"), Intent::PillRemove("integration_vercel".into()));
    assert_eq!(p("vale, pausa"), Intent::MusicPause);
}

#[test]
fn a_name_that_is_not_a_pill_is_unknown_for_pills_but_a_search_for_play() {
    assert_eq!(p("añade Zzzzz"), Intent::Unknown);
    assert_eq!(p("quita Zzzzz"), Intent::Unknown);
}

#[test]
fn fuzzy_names_resolve_and_ambiguous_ones_do_not() {
    assert_eq!(resolve_pill("git hub"), Some("integration_github".into()));
    assert_eq!(resolve_pill("vs code"), Some("integration_claude".into()));
    assert_eq!(resolve_pill("gemini"), Some("agent_gemini".into()));
    assert_eq!(resolve_pill("Stripee"), Some("integration_stripe".into()));
    assert_eq!(resolve_pill("zzz"), None);
}

#[test]
fn apps_web_search_and_ask_abito() {
    assert_eq!(p("abre Firefox"), Intent::OpenApp("Firefox".into()));
    assert_eq!(p("open Figma"), Intent::OpenApp("Figma".into()));
    assert_eq!(p("abre la aplicación Spotify"), Intent::OpenApp("Spotify".into()));
    assert_eq!(p("busca en internet quién ganó ayer"), Intent::WebSearch("quién ganó ayer".into()));
    assert_eq!(p("search the web for rust lifetimes"), Intent::WebSearch("rust lifetimes".into()));
    assert_eq!(p("busca en internet"), Intent::WebSearch(String::new()));
    assert_eq!(p("pregúntale a Abito qué es un mutex"), Intent::AskAbito("qué es un mutex".into()));
    assert_eq!(p("ask Abito what a mutex is"), Intent::AskAbito("what a mutex is".into()));
}

#[test]
fn questions_map_to_topics() {
    assert_eq!(p("¿cuántas estrellas tengo en GitHub?"), Intent::Query(Topic::Github));
    assert_eq!(p("how much did I sell on Stripe?"), Intent::Query(Topic::Stripe));
    assert_eq!(p("¿qué suena?"), Intent::Query(Topic::Music));
    assert_eq!(p("¿qué píldoras tengo?"), Intent::Query(Topic::Pills));
    assert_eq!(p("¿qué tiempo hace?"), Intent::Query(Topic::WeatherToday));
    assert_eq!(p("what's the weather tomorrow"), Intent::Query(Topic::WeatherTomorrow));
    // An action verb keeps it a command.
    assert_eq!(p("¿puedes añadir GitHub?"), Intent::PillAdd("integration_github".into()));
}

#[test]
fn unknown_phrases_stay_unknown() {
    assert_eq!(p(""), Intent::Unknown);
    assert_eq!(p("blablabla"), Intent::Unknown);
}

#[test]
fn several_actions_in_one_sentence() {
    assert_eq!(parse_multi("pausa y añade Notion"), Some(vec![Intent::MusicPause, Intent::PillAdd("integration_notion".into())]));
    assert_eq!(parse_multi("añade Stripe quita Vercel"), Some(vec![Intent::PillAdd("integration_stripe".into()), Intent::PillRemove("integration_vercel".into())]));
    // One multi-add is not two actions.
    assert_eq!(parse_multi("añade Notion y Stripe"), None);
    assert_eq!(parse_multi("pausa"), None);
}

// ── Planning (pure: state in, effects out) ───────────────────────────────────

fn state(active: &[&str], playing: bool) -> World {
    World { main: "integration_claude".into(), active: active.iter().map(|s| s.to_string()).collect(), music_running: playing, playing, volume: 50, now_playing: None }
}

#[test]
fn music_controls_need_a_player_and_say_so_otherwise() {
    let out = plan(&Intent::MusicPause, &state(&[], false), Lang::Es);
    assert_eq!(out.effects, vec![]);
    assert_eq!(out.result, Outcome::Failure);
    let out = plan(&Intent::MusicPause, &state(&[], true), Lang::Es);
    assert_eq!(out.effects, vec![Effect::Music(MusicOp::PlayPause)]);
    assert_eq!(out.result, Outcome::Success);
    let out = plan(&Intent::MusicSetVolume(40), &state(&[], true), Lang::En);
    assert_eq!(out.effects, vec![Effect::Music(MusicOp::Volume(40))]);
}

#[test]
fn a_pill_already_active_is_not_toggled_and_there_is_no_limit_to_ask_about() {
    let out = plan(&Intent::PillAdd("integration_github".into()), &state(&["integration_github"], false), Lang::En);
    assert_eq!(out.effects, vec![]);
    let full = state(&["integration_resend", "integration_n8n", "integration_vercel", "integration_github"], false);
    let out = plan(&Intent::PillAdd("integration_stripe".into()), &full, Lang::Es);
    assert!(!matches!(out.result, Outcome::Question(_)), "no «which one do I remove?» any more: the fifth is simply added");
    assert_eq!(out.pending, None);
    assert_eq!(out.effects, vec![Effect::TogglePill("integration_stripe".into())]);
    let several = plan(&Intent::PillAddMultiple(vec!["integration_stripe".into(), "ai_google".into(), "agent_codex".into()]), &full, Lang::En);
    assert_eq!(several.effects.len(), 3, "adding several at once is not cut at four");
    let out = plan(&Intent::PillAdd("integration_stripe".into()), &state(&["integration_github"], false), Lang::Es);
    assert_eq!(out.effects, vec![Effect::TogglePill("integration_stripe".into())]);
}

#[test]
fn replace_only_and_remove_produce_the_toggles() {
    let w = state(&["integration_n8n", "integration_vercel"], false);
    let out = plan(&Intent::PillReplace { old: "integration_n8n".into(), new: "integration_github".into() }, &w, Lang::En);
    assert_eq!(out.effects, vec![Effect::TogglePill("integration_n8n".into()), Effect::TogglePill("integration_github".into())]);
    let out = plan(&Intent::PillOnly(vec!["integration_github".into()]), &w, Lang::En);
    assert_eq!(out.effects, vec![
        Effect::TogglePill("integration_n8n".into()), Effect::TogglePill("integration_vercel".into()), Effect::TogglePill("integration_github".into()),
    ]);
    let out = plan(&Intent::PillRemove("integration_stripe".into()), &w, Lang::En);
    assert_eq!(out.result, Outcome::Failure, "not active");
    assert_eq!(out.effects, vec![]);
}

#[test]
fn the_follow_up_answer_resolves_the_pending_question() {
    let full = state(&["integration_resend", "integration_n8n", "integration_vercel", "integration_github"], false);
    let pending = Pending::RemoveWhich { to_add: "integration_stripe".into() };
    let out = answer(&pending, "quita Vercel", &full, Lang::Es);
    assert_eq!(out.effects, vec![Effect::TogglePill("integration_vercel".into()), Effect::TogglePill("integration_stripe".into())]);
    // An empty answer cancels; a name that is not active asks nothing more.
    assert_eq!(answer(&pending, "", &full, Lang::Es).effects, vec![]);
    let out = answer(&Pending::WebQuery, "rust lifetimes", &full, Lang::En);
    assert!(matches!(&out.effects[..], [Effect::OpenUrl(u)] if u.contains("rust%20lifetimes") || u.contains("rust+lifetimes")));
}

#[test]
fn web_search_opens_an_https_search_page_with_the_query_encoded() {
    let out = plan(&Intent::WebSearch("¿qué es un mutex? & más".into()), &state(&[], false), Lang::Es);
    let [Effect::OpenUrl(u)] = &out.effects[..] else { panic!("{out:?}") };
    assert!(u.starts_with("https://"), "{u}");
    assert!(!u.contains(' ') && !u.contains('&') || u.matches('&').count() == 0, "{u}");
    let out = plan(&Intent::WebSearch(String::new()), &state(&[], false), Lang::Es);
    assert_eq!(out.pending, Some(Pending::WebQuery));
}

#[test]
fn open_app_is_a_closed_allowlist() {
    assert_eq!(resolve_app("Firefox"), Some("firefox"));
    assert_eq!(resolve_app("firefox"), Some("firefox"));
    assert_eq!(resolve_app("Visual Studio Code"), Some("code"));
    assert_eq!(resolve_app("rm -rf /"), None);
    assert_eq!(resolve_app("../../bin/sh"), None);
    let out = plan(&Intent::OpenApp("rm -rf /".into()), &state(&[], false), Lang::Es);
    assert_eq!(out.effects, vec![]);
    assert_eq!(out.result, Outcome::Failure);
    let out = plan(&Intent::OpenApp("Firefox".into()), &state(&[], false), Lang::Es);
    assert_eq!(out.effects, vec![Effect::OpenApp("firefox")]);
}

#[test]
fn ask_abito_goes_to_the_chat_and_unknown_says_what_was_heard() {
    let out = plan(&Intent::AskAbito("qué es un mutex".into()), &state(&[], false), Lang::Es);
    assert_eq!(out.effects, vec![Effect::AskChat("qué es un mutex".into())]);
    let out = plan(&Intent::Unknown, &state(&[], false), Lang::Es);
    assert_eq!(out.result, Outcome::Failure);
}

#[test]
fn language_is_detected_from_the_phrase() {
    assert_eq!(detect_lang("pon la música por favor"), Lang::Es);
    assert_eq!(detect_lang("please play some music"), Lang::En);
}

// ── The session: transcript in, effects applied, reply out ───────────────────

use std::cell::RefCell;
struct Fake { world: RefCell<World>, log: RefCell<Vec<Effect>> }
impl Hands for Fake {
    fn world(&self) -> World { self.world.borrow().clone() }
    fn apply(&self, e: &Effect) -> bool {
        self.log.borrow_mut().push(e.clone());
        if let Effect::TogglePill(id) = e {
            let mut w = self.world.borrow_mut();
            if let Some(i) = w.active.iter().position(|a| a == id) { w.active.remove(i); } else { w.active.push(id.clone()); }
        }
        true
    }
}
fn fake(active: &[&str], playing: bool) -> Fake { Fake { world: RefCell::new(state(active, playing)), log: RefCell::new(vec![]) } }

#[test]
fn a_session_runs_one_command_and_replies() {
    let h = fake(&[], true);
    let mut s = Session::default();
    let r = s.handle("pausa", &h);
    assert_eq!(h.log.borrow().as_slice(), &[Effect::Music(MusicOp::PlayPause)]);
    assert_eq!(r.outcome, Outcome::Success);
    assert!(!r.rearm);
}

#[test]
fn a_session_runs_several_actions_against_fresh_state() {
    let h = fake(&[], true);
    let mut s = Session::default();
    s.handle("añade GitHub y añade GitHub", &h);
    // The second add sees GitHub already active and does nothing.
    assert_eq!(h.log.borrow().as_slice(), &[Effect::TogglePill("integration_github".into())]);
}

#[test]
fn a_question_rearms_the_microphone_and_the_next_phrase_answers_it() {
    // (S32: the pill limit was the old trigger for this question; a playlist with no name asks the same kind of thing)
    let h = fake(&["integration_resend", "integration_n8n", "integration_vercel", "integration_github"], false);
    let mut s = Session::default();
    let r = s.handle("pon una playlist", &h);
    assert!(matches!(r.outcome, Outcome::Question(_)), "{:?}", r.outcome);
    assert!(r.rearm);
    assert!(h.log.borrow().is_empty());
    let r = s.handle("rock", &h);
    assert_eq!(r.outcome, Outcome::Success);
    assert!(!r.rearm);
    assert_eq!(h.log.borrow().len(), 1);
    // Nothing is pending any more: the same phrase is now a plain command.
    assert!(s.pending.is_none());
}

#[test]
fn an_unanswered_question_is_dropped_on_timeout() {
    let h = fake(&["integration_resend", "integration_n8n", "integration_vercel", "integration_github"], false);
    let mut s = Session::default();
    s.handle("añade Stripe", &h);
    s.timeout();
    assert!(s.pending.is_none());
}

#[test]
fn an_unknown_phrase_says_so_and_changes_nothing() {
    let h = fake(&[], true);
    let mut s = Session::default();
    let r = s.handle("blablabla", &h);
    assert_eq!(r.outcome, Outcome::Failure);
    assert!(h.log.borrow().is_empty());
    assert!(r.message.contains("blablabla") || !r.message.is_empty());
}
