//! K2-13 T2c-5 (S8, S15): what the speech module answers when the environment names NO absolute data folder.
//!
//! A test binary of its own ON PURPOSE: this file's single test clears the process environment (HOME, XDG_DATA_HOME,
//! LOCALAPPDATA, USERPROFILE), which no other test in the same process may observe. Cargo runs each test binary in its
//! own process, so nothing else is affected.
use abito_island::speech;

#[test]
fn with_no_data_folder_the_read_only_speech_queries_answer_instead_of_panicking() {
    // No absolute folder can be found from here: the Windows chain (LOCALAPPDATA, USERPROFILE) and the Linux/macOS one
    // (XDG_DATA_HOME, HOME) are both empty. A shipped Koda must answer, never abort — this is the state a Windows GUI
    // app started without a profile, or a stripped-down launcher, actually produces.
    for name in ["HOME", "XDG_DATA_HOME", "LOCALAPPDATA", "USERPROFILE"] {
        std::env::remove_var(name);
    }
    assert!(speech::try_data_dir().is_err(), "no absolute folder is left in the environment");
    assert_eq!(speech::try_models_dir(), None);
    // The read-only queries the app runs at startup and in Ajustes → Voz: «nothing installed», not a panic.
    assert!(!speech::is_ready(), "the dictation model is not ready when there is nowhere to look for it");
    assert_eq!(speech::status().parakeet, speech::ModelState::Missing);
    assert!(!speech::wake::VAD.is_present(), "the Silero detector is missing, never a panic");
}
