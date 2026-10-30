//! #467 T11 host: `monitor_action` (`{action:"list"}`, see `monitors`).
//!
//! Reachable from the settings window ON PURPOSE (F093 pin): the monitor picker lives in
//! Ajustes and the answer is read-only display names + geometry; it changes nothing.
use crate::{now_ms, AppState};
use abito_island::bridge::BridgeError;
use abito_island::{monitors, workarea};
use serde_json::Value;
use tauri::{AppHandle, Manager, State};

fn enumerate(app: &AppHandle) -> Vec<workarea::MonitorChoice> {
    let Some(win) = app.get_webview_window("main") else { return Vec::new() };
    win.available_monitors()
        .unwrap_or_default()
        .iter()
        .filter_map(|m| {
            let (pos, size) = (m.position(), m.size());
            let rect = abito_island::geometry::Rect { x: pos.x, y: pos.y, w: size.width as i32, h: size.height as i32 };
            workarea::monitor_key(m.name().map(|n| n.as_str())).map(|key| workarea::MonitorChoice { key, rect })
        })
        .collect()
}

#[tauri::command]
pub async fn monitor_action(
    app: AppHandle,
    webview: tauri::Webview,
    state: State<'_, AppState>,
    payload: Value,
) -> Result<Value, BridgeError> {
    let origin = webview.url().map(|u| u.to_string()).unwrap_or_default();
    let mut rate = state.chat_rate.lock().expect("chat rate lock");
    monitors::monitor_command(webview.label(), &origin, &payload, &mut rate, now_ms(), || {
        monitors::choices(&enumerate(&app))
    })
}
