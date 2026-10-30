//! abito-pausa (human 0.1.2: «vale todo lo que este en pausa se puede ocultar?» → yes; supersedes 26-oct «Visibles en gris
//! y apagadas»): this version works on Chat and Agentes. Every other feature is PAUSED: it is hidden in Ajustes (frontend
//! `hub/shell.ts` PAUSED_PAGES) and switched off INSIDE, here — its
//! background work never starts, whatever its stored preference says. The stored preference is left untouched, so the next
//! version turns a feature back on by flipping one constant. One place, no deleted code.

/// The features of this build. `paused` is the single switch the hosts read at startup.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Feature { Dictation, Voice, Integrations, Spotify, Phone }

/// Paused in this version (everything that is neither Chat nor Agentes nor the general shell).
pub const fn paused(feature: Feature) -> bool {
    match feature {
        Feature::Dictation | Feature::Voice | Feature::Integrations | Feature::Spotify | Feature::Phone => true,
    }
}

/// What a host may do with its stored `enabled` preference: a paused feature is never started.
pub const fn effective(feature: Feature, stored_enabled: bool) -> bool { stored_enabled && !paused(feature) }

/// The single Spanish word shown on a paused surface (matches the Ajustes menu tag).
pub const LABEL: &str = "En pausa · próxima versión";

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_non_chat_non_agent_feature_is_paused_and_never_starts_even_if_enabled() {
        for f in [Feature::Dictation, Feature::Voice, Feature::Integrations, Feature::Spotify, Feature::Phone] {
            assert!(paused(f), "{f:?}");
            assert!(!effective(f, true), "{f:?}: a stored «on» must not start a paused feature");
            assert!(!effective(f, false), "{f:?}");
        }
        assert_eq!(LABEL, "En pausa · próxima versión");
    }
}
