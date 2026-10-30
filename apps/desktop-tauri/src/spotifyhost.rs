//! #470 host: the `spotify_action` command and the `spotify:state` island event.
//!
//! One closed command (see `abito_island::spotify::parse_command`). `view` starts the MPRIS
//! listener and answers the current state; `stop` ends it; the rest drive Spotify. State is
//! pushed with `app.emit("spotify:state", …)` whenever Spotify's player moves. Linux only: other
//! platforms answer `unsupported` (the pill is offered on Linux only).
use abito_island::bridge::{self, BridgeError};
use abito_island::spotify::{self, Action};
use serde_json::{json, Value};
use tauri::{AppHandle, Webview};

fn err(code: &str) -> BridgeError {
    BridgeError {
        code: code.into(),
        message: "No se pudo controlar Spotify.".into(),
    }
}

#[cfg(target_os = "linux")]
fn client(app: &AppHandle) -> &'static spotify::Client {
    use tauri::Emitter;
    static CLIENT: std::sync::OnceLock<spotify::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        let app = app.clone();
        spotify::Client::new(None, move |state| {
            let _ = app.emit(spotify::STATE_EVENT, spotify::with_artwork(state));
        })
    })
}

/// `{"action": …}` closed set: view, stop, play_pause, next, previous, seek, shuffle, repeat,
/// volume. Answers `{ok, state}`; `ok` is false when Spotify is not running or refused.
#[tauri::command]
pub async fn spotify_action(
    app: AppHandle,
    webview: Webview,
    payload: Value,
) -> Result<Value, BridgeError> {
    // #366 F093: the Spotify pill lives in the island; the settings window never drives it.
    crate::settingswindow::main_window_only(webview.label())?;
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    // abito-pausa: Spotify is paused in this version — no D-Bus/MPRIS call
    if abito_island::paused::paused(abito_island::paused::Feature::Spotify) { return Err(err("paused")); }
    let action = spotify::parse_command(&payload).ok_or_else(|| err("invalid_schema"))?;
    run(app, action).await
}

#[cfg(target_os = "linux")]
async fn run(app: AppHandle, action: Action) -> Result<Value, BridgeError> {
    // the D-Bus calls never block the WebView thread
    tauri::async_runtime::spawn_blocking(move || {
        let client = client(&app);
        let ok = match action {
            Action::View => {
                client.start();
                true
            }
            Action::Stop => {
                client.stop();
                true
            }
            control => client.control(control),
        };
        let state = if matches!(action, Action::View) {
            client.refresh().unwrap_or_else(|| client.state())
        } else {
            client.state()
        };
        json!({ "ok": ok, "state": spotify::with_artwork(&state) })
    })
    .await
    .map_err(|_| err("unavailable"))
}

#[cfg(not(target_os = "linux"))]
async fn run(_app: AppHandle, _action: Action) -> Result<Value, BridgeError> {
    Err(err("unsupported"))
}

/// #488: what a voice command needs to know about the player: (running, playing, volume 0..=100, title/artist).
#[cfg(target_os = "linux")]
pub(crate) fn state_of(app: &AppHandle) -> (bool, bool, u8, Option<(String, Option<String>)>) {
    let c = client(app);
    c.start();
    let st = c.refresh().unwrap_or_else(|| c.state());
    voice_view(&serde_json::to_value(&st).unwrap_or(Value::Null))
}

/// Pure projection of the pill state for the voice planner.
pub(crate) fn voice_view(v: &Value) -> (bool, bool, u8, Option<(String, Option<String>)>) {
    let running = v.get("running").and_then(Value::as_bool).unwrap_or(false);
    let playing = v.get("playing").and_then(Value::as_bool).unwrap_or(false);
    let volume = v.get("volume").and_then(Value::as_f64).map(|x| if x <= 1.0 { (x * 100.0).round() } else { x.round() }.clamp(0.0, 100.0) as u8).unwrap_or(50);
    let track = v.get("track").filter(|t| t.is_object()).map(|t| {
        let title = t.get("title").and_then(Value::as_str).unwrap_or("").to_string();
        let artist = t.get("artist").and_then(Value::as_str).filter(|a| !a.is_empty()).map(String::from);
        (title, artist)
    }).filter(|(t, _)| !t.is_empty());
    (running, playing, volume, track)
}

#[cfg(target_os = "linux")]
pub(crate) fn control(app: &AppHandle, action: Action) -> bool {
    client(app).control(action)
}
#[cfg(not(target_os = "linux"))]
pub(crate) fn control(_app: &AppHandle, _action: Action) -> bool {
    false
}

#[cfg(test)]
mod voice_view_tests {
    use super::*;
    #[test]
    fn the_player_state_is_projected_for_the_voice_planner() {
        let v = json!({"running":true,"playing":true,"volume":35,"track":{"title":"Get Lucky","artist":"Daft Punk"}});
        assert_eq!(voice_view(&v), (true, true, 35, Some(("Get Lucky".to_string(), Some("Daft Punk".to_string())))));
        assert_eq!(voice_view(&json!({})), (false, false, 50, None));
    }
}
