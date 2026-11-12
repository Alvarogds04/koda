//! Linux consent dialog (S6, S8). Gentle Dot asks with a native dialog owned by the app (macOS
//! `NSAlert`, Windows task dialog) and has none on Linux; Koda uses the GTK it already links, so
//! the dialog is the app's own, never the webview and never `zenity`/`kdialog`.
//!
//! Same semantics as Gentle Dot's `alert.rs` (MIT, Copyright (c) Gentleman Programming): Deny is
//! the default button, Escape, closing, an error and a dialog nobody answers refuse; only choosing
//! Allow on purpose allows.
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;
use std::time::Duration;

pub const QUESTION: &str = "Allow Koda to see your window for 30 minutes?";
/// A dialog nobody answers refuses once this passes.
pub const DEADLINE: Duration = Duration::from_secs(120);

pub fn allows(response: gtk::ResponseType) -> bool {
    response == gtk::ResponseType::Accept
}

/// Settles the dialog exactly once: the first of the human's answer and the deadline wins, sends
/// whether it allows, and closes the dialog. Anything after that (a late click, the timer after an
/// answer) does nothing, so a late Allow can never grant and the dialog is never closed twice.
fn settle(settled: &AtomicBool, response: gtk::ResponseType, tx: &Sender<bool>, close: impl FnOnce()) {
    if settled.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = tx.send(allows(response));
    close();
}

/// Only one consent dialog at a time, also after a timeout: a second request waits for the first to
/// be settled and closed instead of stacking another dialog on top of it.
fn one_at_a_time<T>(f: impl FnOnce() -> T) -> T {
    static OPEN: Mutex<()> = Mutex::new(());
    let _held = OPEN.lock().unwrap_or_else(|e| e.into_inner());
    f()
}

/// Asks from a worker thread; the dialog runs on the GTK main thread without blocking it, and the
/// app closes it as Deny when `DEADLINE` passes. `false` on anything but Allow.
pub fn ask_grant(app: &tauri::AppHandle) -> bool {
    use gtk::prelude::*;
    one_at_a_time(|| {
        let (tx, rx) = mpsc::channel::<bool>();
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
            let settled = Rc::new(AtomicBool::new(false));
            {
                let (settled, tx) = (settled.clone(), tx.clone());
                dialog.connect_response(move |dialog, response| {
                    let dialog = dialog.clone();
                    settle(&settled, response, &tx, move || dialog.close());
                });
            }
            {
                let dialog = dialog.clone();
                gtk::glib::timeout_add_local_once(DEADLINE, move || {
                    let closing = dialog.clone();
                    settle(&settled, gtk::ResponseType::Cancel, &tx, move || closing.close());
                });
            }
            dialog.show();
        });
        queued.is_ok() && rx.recv_timeout(DEADLINE + Duration::from_secs(10)).unwrap_or(false)
    })
}

#[cfg(test)]
#[path = "consent_gtk_tests.rs"]
mod tests;
