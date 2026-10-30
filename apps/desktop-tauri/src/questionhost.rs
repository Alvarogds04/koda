//! QP.3a host only. A main-webview sender is not proof of trusted human input;
//! QP.3b must gate gestures. These questions never authorize backend proposals.
use crate::{now_ms, AppState, QUITTING};
use abito_island::bridge::{self, BridgeError};
use abito_island::questioncmd::{self, Command};
use abito_island::transport::HumanReplyError;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager, State};

fn error(code: &str) -> BridgeError {
    BridgeError {
        code: code.into(),
        message: "No se pudo completar la respuesta de Pi.".into(),
    }
}
fn reply_error(e: HumanReplyError) -> BridgeError {
    error(match e {
        HumanReplyError::Validation(e) => questioncmd::error_code(e),
        HumanReplyError::OutcomeUnknown => "outcome_unknown",
    })
}
pub fn question_view(state: &AppState) -> Value {
    let transport = state.transport.lock().expect("transport lock");
    match transport.as_ref() {
        Some(t) => {
            let mut v = serde_json::to_value(t.question_snapshot()).unwrap_or(Value::Null);
            v["available"] = json!(true);
            v
        }
        None => {
            json!({"available":false,"pending":null,"deliveries":[],"ready_connections":0,"notice":null,"native_transition":null})
        }
    }
}
/// Marshal invalidation to the main thread: a command can still hold the host
/// transport guard when the transport invokes its observer. No synchronous
/// reentry, no focus, expansion, text logging or browser persistence.
pub fn invalidate(app: &AppHandle) {
    let scheduler = app.clone();
    // run_on_main_thread may execute inline if already on that thread. Always
    // enqueue from another thread, never while the caller holds host guards.
    std::thread::spawn(move || {
        let handle = scheduler.clone();
        let _ = scheduler.run_on_main_thread(move || {
            if QUITTING.load(Ordering::SeqCst) {
                return;
            }
            let state = handle.state::<AppState>();
            let _ = handle.emit("question:state", question_view(&state));
        });
    });
}
/// Lock order: host transport → questions → core/phase. Never publish question
/// state inside this operation (desktop/chat publication is independent).
pub fn with_pending<T>(state: &AppState, operation: impl FnOnce(bool) -> T) -> T {
    let transport = state.transport.lock().expect("transport lock");
    match transport.as_ref() {
        Some(t) => t.with_question_pending(operation),
        None => operation(false),
    }
}
/// Click-only atomic matching/navigation transaction. Lock order stays host
/// transport → questions → core/phase; publication/native work follows unlock.
pub fn with_question_click<T>(state: &AppState, id: &str, operation: impl FnOnce() -> T) -> Result<T, BridgeError> {
    let transport = state.transport.lock().expect("transport lock");
    let t = transport.as_ref().ok_or_else(|| BridgeError::denied("notice is not current"))?;
    t.with_question_click(id, operation)
}
pub fn pending_error() -> BridgeError {
    BridgeError {
        code: "question_pending".into(),
        message: "Pi espera tu respuesta; la isla permanece abierta.".into(),
    }
}
/// Sender → closed shape/UTF-8 size → original shared chat/models rate → dispatch.
#[tauri::command]
pub async fn question_action(
    app: AppHandle,
    webview: tauri::Webview,
    state: State<'_, AppState>,
    payload: Value,
) -> Result<Value, BridgeError> {
    crate::settingswindow::main_window_only(webview.label())?;
    let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
    bridge::sender_ok(webview.label(), &url)?;
    let command =
        questioncmd::parse_command(&payload).map_err(|e| error(questioncmd::error_code(e)))?;
    state
        .chat_rate
        .lock()
        .expect("chat rate lock")
        .check(now_ms())?;
    if matches!(command, Command::View) {
        return Ok(question_view(&state));
    }
    let handle = app.clone();
    // Origin writes have a bounded deadline; never block WebKit's UI thread.
    tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<AppState>();
        {
            let guard = state.transport.lock().expect("transport lock");
            let t = guard.as_ref().ok_or_else(|| error("unavailable"))?;
            match command {
                Command::Budget { id, text } => {
                    return t
                        .question_text_budget(&id, &text)
                        .map(|b| serde_json::to_value(b).unwrap_or(Value::Null))
                        .map_err(|e| error(questioncmd::error_code(e)))
                }
                Command::Answer { id, index } => t.answer(&id, index),
                Command::Text { id, text } => t.answer_text(&id, text),
                Command::AnswerMany { id, indexes, text } => t.answer_many(&id, indexes, text),
                Command::AnswerForm { id, answers } => t.answer_form(&id, answers),
                Command::Decline { id } => t.decline(&id),
                Command::View => unreachable!(),
            }
            .map_err(reply_error)?;
        }
        Ok(question_view(&state)) // never return a stale view on denied mutation
    })
    .await
    .map_err(|_| error("question_aborted"))?
}
