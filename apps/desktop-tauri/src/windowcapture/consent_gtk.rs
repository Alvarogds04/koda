//! Linux consent dialog (S6, S8). Gentle Dot asks with a native dialog owned by the app (macOS
//! `NSAlert`, Windows task dialog) and has none on Linux; Koda uses the GTK it already links, so
//! the dialog is the app's own, never the webview and never `zenity`/`kdialog`.
//!
//! Same semantics as Gentle Dot's `alert.rs` (MIT, Copyright (c) Gentleman Programming): Deny is
//! the default button, Escape, closing, an error and a dialog nobody answers refuse; only choosing
//! Allow on purpose allows.
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;

pub const QUESTION: &str = "Allow Koda to see your window for 30 minutes?";
/// A dialog nobody answers refuses once this passes.
pub const DEADLINE: Duration = Duration::from_secs(120);

pub fn allows(response: gtk::ResponseType) -> bool {
    response == gtk::ResponseType::Accept
}

fn answer(rx: &Receiver<gtk::ResponseType>, deadline: Duration) -> bool {
    rx.recv_timeout(deadline).map(allows).unwrap_or(false)
}

/// Asks from a worker thread; the dialog runs on the GTK main thread. `false` on anything but Allow.
pub fn ask_grant(app: &tauri::AppHandle) -> bool {
    use gtk::prelude::*;
    let (tx, rx) = mpsc::channel();
    let queued = app.run_on_main_thread(move || {
        let dialog = gtk::MessageDialog::builder()
            .message_type(gtk::MessageType::Question)
            .modal(true)
            .text("Koda")
            .secondary_text(QUESTION)
            .build();
        dialog.add_button("Deny", gtk::ResponseType::Cancel);
        dialog.add_button("Allow", gtk::ResponseType::Accept);
        dialog.set_default_response(gtk::ResponseType::Cancel);
        let response = dialog.run();
        dialog.close();
        let _ = tx.send(response);
    });
    queued.is_ok() && answer(&rx, DEADLINE)
}

#[cfg(test)]
#[path = "consent_gtk_tests.rs"]
mod tests;
