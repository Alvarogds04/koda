//! Koda's own consent dialog (S6): a native yes/no owned by the app, never the webview, whose
//! default button is the refusing one. Refusing is the default: the refusing button, Return,
//! Escape, closing, aborting, a dialog that cannot be shown, a dialog nobody answers before its
//! deadline, and any answer not recognized here refuse. Allowing takes choosing the allowing button
//! on purpose: a click, or moving the keyboard focus to it first where the platform lets that
//! happen (Windows).
//!
//! Adapted from Gentle Dot `apps/desktop/src-tauri/src/alert.rs`,
//! Copyright (c) Gentleman Programming, MIT (see THIRD-PARTY-NOTICES in apps/desktop-daemon).
//! Koda asks one question with it (may Koda look at the user's window for the next 30 minutes, S6);
//! Gentle Dot's per-approval plumbing for computer control, and its "kept out of captures while it
//! is open" bookkeeping, are not copied: Koda captures one window BY HANDLE, so a dialog of Koda's
//! can only reach a fallback screen copy, and there it keeps itself out with
//! `WDA_EXCLUDEFROMCAPTURE` like every other Koda window.
//!
//! macOS: an `NSAlert` run modally on the main thread, asked from a worker thread that waits for
//! the answer. The refusing button is added first (`NSAlertFirstButtonReturn`) with Return as its
//! key equivalent; the allowing button is second and has none, so no key allows. Only the second
//! button's response allows; `abortModal` (a stale dialog dismissed elsewhere) answers
//! `NSModalResponseAbort`, which refuses. An `NSAlert` modal session cannot be ended from another
//! thread, so macOS has no deadline: until the human answers, the capture waits and nothing is
//! granted.
//!
//! Windows: a task dialog whose default button is the refusing one, so Return right after it opens
//! refuses; Escape and closing answer `IDCANCEL`, and only the allowing button's own id allows. The
//! keyboard can still reach the allowing button on purpose (Tab or the arrow keys, then Return or
//! Space), as a click does, so the dialog works without a mouse. The dialog's own timer presses its
//! refusing button once its deadline passes, or as soon as another thread asks it to
//! (`OpenDialog::refuse`): no other thread ever touches its window.
//!
//! Tauri's dialog plugin is not used: its buttons put the allowing label in the slot rfd makes the
//! default, so Return would allow.

use std::time::Instant;

/// The `NSAlert` response of the refusing button, added first (`NSAlertFirstButtonReturn`).
pub const REFUSE_RESPONSE: isize = 1000;
/// The `NSAlert` response of the allowing button, added second (`NSAlertSecondButtonReturn`).
pub const ALLOW_RESPONSE: isize = 1001;

/// The Windows task dialog's button ids: the refusing one is the default.
pub const TASK_REFUSE_ID: i32 = 2000;
pub const TASK_ALLOW_ID: i32 = 2001;

/// What the dialog says (S6). The 30 minutes are the consent session's (`session::SESSION_MS`).
pub const TITLE: &str = "Koda";
pub const MESSAGE: &str = "Allow Koda to see your window for 30 minutes?";

/// How long a Windows dialog nobody answers stays open before it refuses by itself.
pub const GRANT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// The two buttons of a yes/no alert.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Choice {
    pub allow: &'static str,
    pub refuse: &'static str,
}

/// The one choice Koda asks: Allow / Deny, with Deny as the refusing default.
pub const GRANT: Choice = Choice { allow: "Allow", refuse: "Deny" };

impl Choice {
    /// The `NSAlert` buttons in the order they are added: the first is the default (Return).
    pub fn alert_buttons(&self) -> [&'static str; 2] {
        [self.refuse, self.allow]
    }

    /// True only for the allowing button's response; `None` is an alert that never ran.
    pub fn allows_response(&self, response: Option<isize>) -> bool {
        self.allow != self.refuse && response == Some(ALLOW_RESPONSE)
    }

    /// True only for the allowing button's id (Windows); `None` is a dialog that failed to show.
    pub fn allows_task_button(&self, button: Option<i32>) -> bool {
        self.allow != self.refuse && button == Some(TASK_ALLOW_ID)
    }
}

/// A request to refuse the dialog on screen (Windows), set from another thread and acted on by the
/// dialog's own timer. Off Windows it holds nothing: no other platform refuses a dialog this way.
#[derive(Default)]
pub struct OpenDialog(#[cfg(windows)] std::sync::atomic::AtomicBool);

impl OpenDialog {
    /// Asks the dialog on screen, if one is, to refuse (Windows; elsewhere nothing). Its next timer
    /// tick, within about 200 ms, presses its refusing button.
    pub fn refuse(&self) {
        #[cfg(windows)]
        self.0.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Whether a dialog's timer should press its refusing button now: a refusal was asked for, or its
/// deadline has passed.
pub fn refuse_due(requested: bool, deadline: Option<Instant>, now: Instant) -> bool {
    requested || deadline.is_some_and(|deadline| now >= deadline)
}

/// The consent question (S6), asked from a worker thread: may Koda look at the user's window for the
/// next 30 minutes? Blocks until it is answered or (Windows) refuses itself after `GRANT_TIMEOUT`.
pub fn ask_grant(app: &tauri::AppHandle) -> bool {
    ask_tracked(app, TITLE, MESSAGE, GRANT, None, Some(Instant::now() + GRANT_TIMEOUT))
}

/// Shows the alert and waits for the answer. Blocks, so it never runs on the main thread (there it
/// refuses at once).
pub fn ask(app: &tauri::AppHandle, title: &str, message: &str, choice: Choice) -> bool {
    ask_tracked(app, title, message, choice, None, None)
}

/// `ask`, letting `open` refuse the dialog from another thread (`OpenDialog::refuse`) and refusing
/// it by itself once `deadline` passes (Windows).
pub fn ask_tracked(
    app: &tauri::AppHandle,
    title: &str,
    message: &str,
    choice: Choice,
    open: Option<&OpenDialog>,
    deadline: Option<Instant>,
) -> bool {
    #[cfg(target_os = "macos")]
    {
        let _ = (open, deadline);
        macos::ask(app, title, message, choice)
    }
    #[cfg(windows)]
    {
        let _ = app;
        windows::ask(title, message, choice, open, deadline)
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::Choice;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSAlert, NSAlertStyle, NSApplication};
    use objc2_foundation::NSString;

    pub fn ask(app: &tauri::AppHandle, title: &str, message: &str, choice: Choice) -> bool {
        if MainThreadMarker::new().is_some() {
            eprintln!("koda: a consent dialog was asked on the main thread, so it was refused");
            return false;
        }
        let (answer, answered) = std::sync::mpsc::channel();
        let (title, message) = (title.to_owned(), message.to_owned());
        let scheduled = app.run_on_main_thread(move || {
            let response = MainThreadMarker::new().map(|mtm| run(mtm, &title, &message, choice));
            let _ = answer.send(response);
        });
        if scheduled.is_err() {
            return false;
        }
        // The task dropped without running (the app is quitting) reads as no answer.
        choice.allows_response(answered.recv().ok().flatten())
    }

    fn run(mtm: MainThreadMarker, title: &str, message: &str, choice: Choice) -> isize {
        let alert = NSAlert::new(mtm);
        alert.setAlertStyle(NSAlertStyle::Warning);
        alert.setMessageText(&NSString::from_str(title));
        alert.setInformativeText(&NSString::from_str(message));
        let [refuse, allow] = choice.alert_buttons();
        alert.addButtonWithTitle(&NSString::from_str(refuse)).setKeyEquivalent(&NSString::from_str("\r"));
        alert.addButtonWithTitle(&NSString::from_str(allow)).setKeyEquivalent(&NSString::from_str(""));
        // Koda is an accessory app; without this the alert can open behind the front app.
        #[allow(deprecated)]
        NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
        alert.runModal()
    }
}

#[cfg(windows)]
mod windows {
    use super::{refuse_due, Choice, OpenDialog, TASK_ALLOW_ID, TASK_REFUSE_ID};
    use std::mem::{size_of, zeroed};
    use std::ptr::null_mut;
    use std::sync::atomic::Ordering;
    use windows_sys::core::HRESULT;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows_sys::Win32::UI::Controls::{
        TaskDialogIndirect, TASKDIALOGCONFIG, TASKDIALOG_BUTTON, TDF_ALLOW_DIALOG_CANCELLATION, TDF_CALLBACK_TIMER,
        TDF_SIZE_TO_CONTENT, TDM_CLICK_BUTTON, TDN_CREATED, TDN_TIMER, TD_WARNING_ICON,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        PostMessageW, SetForegroundWindow, SetWindowDisplayAffinity, SetWindowPos, HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE,
        WDA_EXCLUDEFROMCAPTURE,
    };

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(Some(0)).collect()
    }

    /// What the callback is given: where a refusal is asked for, and when to refuse by itself.
    struct Watch<'a> {
        open: Option<&'a OpenDialog>,
        deadline: Option<std::time::Instant>,
    }

    /// Called only from the dialog's own callback, where `hwnd` is its live window.
    fn press_refuse(hwnd: HWND) {
        // SAFETY: a plain message to the dialog's live window.
        if unsafe { PostMessageW(hwnd, TDM_CLICK_BUTTON as u32, TASK_REFUSE_ID as WPARAM, 0) } == 0 {
            eprintln!("koda: a consent dialog could not be refused: {}", std::io::Error::last_os_error());
        }
    }

    /// Raises the dialog above the app the human is looking at, keeps it out of every screen
    /// capture (S1 pixels must never contain Koda's own dialog), and presses its refusing button
    /// when a refusal was asked for or its deadline passed (the timer ticks about every 200 ms).
    /// Everything here runs on the dialog's thread, during a notification, while its window lives.
    unsafe extern "system" fn on_event(hwnd: HWND, notification: u32, _: WPARAM, _: LPARAM, data: isize) -> HRESULT {
        // SAFETY: `data` is the `Watch` borrowed by `ask`, alive for the whole dialog.
        let watch = unsafe { &*(data as *const Watch) };
        if notification == TDN_TIMER as u32 {
            let requested = watch.open.is_some_and(|open| open.0.load(Ordering::SeqCst));
            if refuse_due(requested, watch.deadline, std::time::Instant::now()) {
                press_refuse(hwnd);
            }
        }
        if notification == TDN_CREATED as u32 {
            // SAFETY: `hwnd` is the dialog's live window during the notification.
            unsafe {
                SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
                SetForegroundWindow(hwnd);
                if SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE) == 0 {
                    eprintln!("koda: the consent dialog may show in a screen capture");
                }
            }
        }
        0
    }

    pub fn ask(
        title: &str,
        message: &str,
        choice: Choice,
        open: Option<&OpenDialog>,
        deadline: Option<std::time::Instant>,
    ) -> bool {
        // A refusal asked for an earlier dialog is not this one's. One asked for while this dialog
        // was still opening is only lost when the earlier caller had already timed out, and then
        // this dialog's own deadline refuses it.
        if let Some(open) = open {
            open.0.store(false, Ordering::SeqCst);
        }
        let watch = Watch { open, deadline };
        let (title, message) = (wide(title), wide(message));
        let (allow, refuse) = (wide(choice.allow), wide(choice.refuse));
        let buttons = [
            TASKDIALOG_BUTTON { nButtonID: TASK_ALLOW_ID, pszButtonText: allow.as_ptr() },
            TASKDIALOG_BUTTON { nButtonID: TASK_REFUSE_ID, pszButtonText: refuse.as_ptr() },
        ];
        // SAFETY: every pointer in the config outlives the modal call that reads it.
        unsafe {
            let mut config: TASKDIALOGCONFIG = zeroed();
            config.cbSize = size_of::<TASKDIALOGCONFIG>() as u32;
            config.dwFlags = TDF_ALLOW_DIALOG_CANCELLATION | TDF_SIZE_TO_CONTENT;
            if deadline.is_some() || open.is_some() {
                config.dwFlags |= TDF_CALLBACK_TIMER;
            }
            config.pszWindowTitle = title.as_ptr();
            config.pszContent = message.as_ptr();
            config.Anonymous1.pszMainIcon = TD_WARNING_ICON;
            // No common buttons: the only two buttons are ours, so the only ids that come back are
            // TASK_ALLOW_ID, TASK_REFUSE_ID, or IDCANCEL for Escape and closing.
            config.cButtons = buttons.len() as u32;
            config.pButtons = buttons.as_ptr();
            config.nDefaultButton = TASK_REFUSE_ID;
            config.pfCallback = Some(on_event);
            config.lpCallbackData = &watch as *const Watch as isize;
            let mut pressed = 0i32;
            let shown = TaskDialogIndirect(&config, &mut pressed, null_mut(), null_mut());
            choice.allows_task_button((shown >= 0).then_some(pressed))
        }
    }
}

#[cfg(test)]
#[path = "alert_tests.rs"]
mod tests;
