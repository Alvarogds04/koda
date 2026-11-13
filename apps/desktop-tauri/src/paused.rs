//! abito-pausa (human 0.1.2: «vale todo lo que este en pausa se puede ocultar?» → yes; supersedes 26-oct «Visibles en gris
//! y apagadas»): this version works on Chat and Agentes. Every other feature is PAUSED: it is hidden in Ajustes (frontend
//! `hub/shell.ts` PAUSED_PAGES) and switched off INSIDE, here — its
//! background work never starts, whatever its stored preference says. The stored preference is left untouched, so the next
//! version turns a feature back on by flipping one constant. One place, no deleted code.

/// The features of this build. `paused` is the single switch the hosts read at startup.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Feature { Dictation, Voice, Integrations, Spotify, Phone, Mail }

/// Paused in this version (everything that is neither Chat nor Agentes nor the general shell).
/// K2-10 T4 (S11): `Mail` gets its OWN entry and is NOT paused — the island's mail reads the user's
/// own Gmail; the pause of `Integrations` (service cards) is untouched.
pub const fn paused(feature: Feature) -> bool {
    match feature {
        Feature::Dictation | Feature::Voice | Feature::Integrations | Feature::Spotify | Feature::Phone => true,
        Feature::Mail => false,
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

    /// K2-10 T4 (S11): el correo tiene su PROPIA entrada y no está en pausa en esta versión: la
    /// tarjeta de la isla y su ajuste tienen que andar, a diferencia de las de Integraciones.
    #[test]
    fn k2_10_mail_is_not_paused_and_keeps_its_own_entry() {
        assert!(!paused(Feature::Mail), "el correo no se pausa en esta versión");
        assert!(effective(Feature::Mail, true), "un «on» guardado arranca el correo");
        assert!(!effective(Feature::Mail, false), "un «off» guardado se respeta igual");
        assert!(paused(Feature::Integrations), "el resto de Integraciones sigue en pausa");
    }
}
