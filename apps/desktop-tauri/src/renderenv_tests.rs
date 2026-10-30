use super::*;

#[test]
fn the_island_asks_webkit_for_the_renderer_that_does_not_blank_the_window_when_it_shrinks() {
    let set = webkit_env_to_set(&|_| None);
    assert_eq!(set, vec![("WEBKIT_DISABLE_DMABUF_RENDERER", "1")], "one narrow switch, nothing else");
}

#[test]
fn a_value_the_environment_already_carries_is_never_overridden() {
    // a developer (or the probe matrix) choosing explicitly wins over the default
    for present in ["0", "1", "", "anything"] {
        let set = webkit_env_to_set(&|k| (k == "WEBKIT_DISABLE_DMABUF_RENDERER").then(|| present.to_string()));
        assert!(set.is_empty(), "{present:?} was already chosen");
    }
}

#[test]
fn compositing_stays_on_because_disabling_it_unsyncs_animation_from_the_display() {
    let set = webkit_env_to_set(&|_| None);
    assert!(set.iter().all(|(k, _)| *k != "WEBKIT_DISABLE_COMPOSITING_MODE"), "{set:?}");
}

#[test]
fn only_known_webkit_switches_are_ever_set() {
    for (k, v) in webkit_env_to_set(&|_| None) {
        assert!(k.starts_with("WEBKIT_DISABLE_") && ALLOWED_SWITCHES.contains(&k), "{k}");
        assert_eq!(v, "1");
    }
}
