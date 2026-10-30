use super::*;

// --- derive: the §10.3 matrix ------------------------------------------------

#[test]
fn connected_with_nothing_pending_is_idle() {
    assert_eq!(derive("connected", false, false, false), TrayState::Idle);
}

#[test]
fn working_is_a_turn_in_flight_over_a_good_connection() {
    assert_eq!(derive("working", false, false, false), TrayState::Working);
    // the transport failing still wins: the app cannot see anything reliably
    assert_eq!(derive("working", false, false, true), TrayState::Disconnected);
}

#[test]
fn every_not_connected_value_is_disconnected() {
    for connection in [
        "", "no_daemon", "not_connected", "outdated", "unavailable", "error",
        "connecting", "Connected", "connected ", "working-x",
    ] {
        assert_eq!(
            derive(connection, false, false, false),
            TrayState::Disconnected,
            "{connection:?} is not a live connection: fail closed"
        );
    }
    // the local transport failing is honest disconnection even when connected
    assert_eq!(derive("connected", false, false, true), TrayState::Disconnected);
}

#[test]
fn a_pending_card_or_question_wins_over_everything() {
    for connection in ["connected", "working", "no_daemon", "error", ""] {
        assert_eq!(
            derive(connection, true, false, false),
            TrayState::NeedsAttention,
            "pending card over {connection:?}"
        );
        assert_eq!(
            derive(connection, false, true, false),
            TrayState::NeedsAttention,
            "pending question over {connection:?}"
        );
        // even with the transport gone: the human must decide
        assert_eq!(
            derive(connection, true, false, true),
            TrayState::NeedsAttention,
            "attention over {connection:?} with transport down"
        );
    }
}

#[test]
fn the_state_names_are_the_contracted_vocabulary() {
    assert_eq!(TrayState::Idle.as_str(), "idle");
    assert_eq!(TrayState::Working.as_str(), "working");
    assert_eq!(TrayState::NeedsAttention.as_str(), "needs-attention");
    assert_eq!(TrayState::Disconnected.as_str(), "disconnected");
}

#[test]
fn index_round_trip_and_unknown_fails_closed() {
    for state in [
        TrayState::Idle,
        TrayState::Working,
        TrayState::NeedsAttention,
        TrayState::Disconnected,
    ] {
        assert_eq!(TrayState::from_index(state.to_index()), state);
    }
    for unknown in [4u8, 99, 255] {
        assert_eq!(TrayState::from_index(unknown), TrayState::Disconnected, "{unknown}");
    }
}

// --- HU-056: the tray icon is Koda Chibi, one pose per state, in the native cells ---

const STATES: [TrayState; 4] = [
    TrayState::Idle,
    TrayState::Working,
    TrayState::NeedsAttention,
    TrayState::Disconnected,
];

#[test]
fn every_glyph_is_a_square_rgba_cell_and_deterministic_in_every_size() {
    for state in STATES {
        for cell in [16u32, 24, 32] {
            let a = glyph_rgba_sized(state, cell);
            assert_eq!(a, glyph_rgba_sized(state, cell), "{state:?} {cell}");
            assert_eq!((a.width, a.height), (cell, cell));
            assert_eq!(a.rgba.len(), (cell * cell * 4) as usize);
        }
    }
}

#[test]
fn the_platform_glyph_uses_the_platform_cell() {
    let cell = koda_cell_for_platform();
    assert!([16, 24, 32].contains(&cell));
    if cfg!(target_os = "linux") {
        assert_eq!(cell, 24, "Linux trays scale down from the 24 px cell");
    } else {
        assert_eq!(cell, 32, "macOS (16 pt @2x) and Windows (200 %) get the 32 px cell");
    }
    for state in STATES {
        let g = glyph_rgba(state);
        assert_eq!((g.width, g.height), (cell, cell));
    }
}

#[test]
fn the_four_glyphs_are_pairwise_distinct_in_every_size() {
    for cell in [16u32, 24, 32] {
        for (i, a) in STATES.iter().enumerate() {
            for b in &STATES[i + 1..] {
                assert_ne!(
                    glyph_rgba_sized(*a, cell),
                    glyph_rgba_sized(*b, cell),
                    "{a:?} and {b:?} must differ at {cell} px"
                );
            }
        }
    }
}

#[test]
fn every_glyph_is_visible_koda_on_a_transparent_background() {
    for state in STATES {
        for cell in [16u32, 24, 32] {
            let g = glyph_rgba_sized(state, cell);
            let alphas: Vec<u8> = g.rgba.iter().skip(3).step_by(4).copied().collect();
            let opaque = alphas.iter().filter(|&&a| a == 255).count();
            let clear = alphas.iter().filter(|&&a| a == 0).count();
            assert!(opaque > (cell * cell / 5) as usize, "{state:?} {cell}: Koda is drawn ({opaque} opaque px)");
            assert!(clear > 0, "{state:?} {cell}: the corners stay transparent");
            assert!(alphas.iter().all(|&a| a == 0 || a == 255), "{state:?} {cell}: pixel art has no soft edges");
        }
    }
}

#[test]
fn an_unknown_cell_falls_back_to_the_32_px_frame() {
    assert_eq!(glyph_rgba_sized(TrayState::Idle, 20), glyph_rgba_sized(TrayState::Idle, 32));
}

// --- HU-048: the tray menu, one spec for every platform ------------------------
// Human, verbatim: «que abito salga en los iconos oculto abajo a la derecha de windows». The tray existed only on Unix (Linux + macOS);
// Windows had none. The menu is the SAME on every platform except one item: «Arrancar al iniciar sesión» exists only where the autostart
// toggle really works (a desktop entry on Linux/macOS today; Windows has no Run-key implementation, so the item is omitted, not faked).

#[test]
fn the_menu_with_autostart_is_the_one_linux_and_macos_have_always_had() {
    assert_eq!(menu_spec(true), vec![
        MenuEntry::Item("tray-show", "Mostrar Koda"),
        MenuEntry::Item("tray-hide", "Ocultar"),
        MenuEntry::Separator,
        MenuEntry::Check("tray-autostart", "Arrancar al iniciar sesión"),
        MenuEntry::Separator,
        MenuEntry::Item("tray-quit", "Salir"),
    ]);
}

#[test]
fn without_autostart_the_item_and_its_separator_are_gone_and_nothing_else_changes() {
    assert_eq!(menu_spec(false), vec![
        MenuEntry::Item("tray-show", "Mostrar Koda"),
        MenuEntry::Item("tray-hide", "Ocultar"),
        MenuEntry::Separator,
        MenuEntry::Item("tray-quit", "Salir"),
    ]);
}

#[test]
fn every_menu_has_show_hide_and_quit_and_ids_are_unique_and_closed() {
    for autostart in [true, false] {
        let spec = menu_spec(autostart);
        let ids: Vec<&str> = spec.iter().filter_map(|e| match e { MenuEntry::Item(id, _) | MenuEntry::Check(id, _) => Some(*id), MenuEntry::Separator => None }).collect();
        for needed in ["tray-show", "tray-hide", "tray-quit"] { assert!(ids.contains(&needed), "{needed} (autostart={autostart})"); }
        assert_eq!(ids.contains(&"tray-autostart"), autostart);
        let unique: std::collections::BTreeSet<&str> = ids.iter().copied().collect();
        assert_eq!(unique.len(), ids.len(), "no duplicate id");
        assert!(ids.iter().all(|id| id.starts_with("tray-") && id.bytes().all(|b| b.is_ascii_lowercase() || b == b'-')), "{ids:?}");
        assert!(!matches!(spec.first(), Some(MenuEntry::Separator)) && !matches!(spec.last(), Some(MenuEntry::Separator)), "no separator at either end");
        assert!(spec.windows(2).all(|w| !(w[0] == MenuEntry::Separator && w[1] == MenuEntry::Separator)), "no two separators in a row");
    }
}

#[test]
fn the_quit_item_is_always_last_so_a_human_can_always_leave() {
    for autostart in [true, false] { assert_eq!(menu_spec(autostart).last(), Some(&MenuEntry::Item("tray-quit", "Salir"))); }
}
