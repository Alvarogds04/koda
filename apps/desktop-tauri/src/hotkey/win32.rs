//! The Win32 side of the hotkey: a thread-own `RegisterHotKey` grab held by a
//! dedicated pump thread, reporting presses. Everything here is best effort and
//! never panics: a collision is `Status::Taken`, any other registration failure
//! is `Status::Unsupported`, and a failed attempt leaves nothing registered.
//!
//! The mirror of `x11.rs` on purpose (same `GrabEvent`/`status()`/`stop()`
//! contract). The pump thread registers with `hwnd = NULL` (a thread hotkey),
//! so the WM_HOTKEY messages arrive in ITS queue and `UnregisterHotKey` runs on
//! the owning thread, as the API requires. `stop()` wakes the pump with a
//! `WM_QUIT` posted to its thread id (collected in the start handshake, so it
//! is never guessed) and joins: a rebind can never race an unregister.
#[cfg(windows)]
use super::{Combo, Status};
#[cfg(windows)]
use std::sync::atomic::{AtomicU8, Ordering};
#[cfg(windows)]
use std::sync::mpsc;
#[cfg(windows)]
use std::sync::Arc;
#[cfg(windows)]
use std::thread::JoinHandle;
#[cfg(windows)]
use windows_sys::Win32::Foundation::{GetLastError, ERROR_HOTKEY_ALREADY_REGISTERED};
#[cfg(windows)]
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    RegisterHotKey, UnregisterHotKey, MOD_NOREPEAT,
};
#[cfg(windows)]
use windows_sys::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, GetMessageW, PostThreadMessageW, TranslateMessage, MSG, WM_HOTKEY, WM_QUIT,
};

// The state codes mirror x11.rs so `status()` maps the same way on both seams.
#[cfg(windows)]
const S_ACTIVE: u8 = 1;
#[cfg(windows)]
const S_TAKEN: u8 = 2;
#[cfg(windows)]
const S_INVALID: u8 = 3;
#[cfg(windows)]
const S_UNSUPPORTED: u8 = 4;

/// A key press delivered to the host. Each backend owns its event type (the
/// X11 seam has `x11::GrabEvent`, the portal its own); the win32 twin matches
/// that shape so a rebind reads the same on both sides.
#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrabEvent {
    Pressed,
}

/// A live Win32 global-hotkey grab. `None` in the host means no shortcut is
/// held; a present value may still be `Taken`/`Unsupported` — the status is the
/// honest part, kept in an atomic exactly like the X11 seam does.
#[cfg(windows)]
pub struct Grabber {
    status: Arc<AtomicU8>,
    /// The pump thread's Win32 thread id, from the handshake; only meaningful
    /// together with `thread: Some(..)`, which only exists when registration
    /// was attempted on that thread.
    thread_id: u32,
    thread: Option<JoinHandle<()>>,
}

#[cfg(windows)]
impl Grabber {
    /// Register `combo` on a dedicated pump thread. `hotkey_id` identifies the
    /// grab in the system (WM_HOTKEY carries it back in wParam). Blocks only
    /// until the registration RESULT is known — the same synchronous contract
    /// as `x11::Grabber::start`: on return, `status()` is final.
    pub fn start(
        hotkey_id: u32,
        combo: Combo,
        on_event: impl Fn(GrabEvent) + Send + 'static,
    ) -> Grabber {
        let status = Arc::new(AtomicU8::new(S_UNSUPPORTED));
        if combo.validate().is_err() {
            status.store(S_INVALID, Ordering::SeqCst);
            return Grabber { status, thread_id: 0, thread: None };
        }
        // The handshake carries (final status code, pump thread id). A thread
        // that FAILED to register exits at once: no pump, no wake-up needed.
        let (tx, rx) = mpsc::channel::<(u8, u32)>();
        let pump_status = status.clone();
        let thread = std::thread::spawn(move || {
            let tid = unsafe { windows_sys::Win32::System::Threading::GetCurrentThreadId() };
            // SAFETY: thread-own registration on THIS thread's queue; a NULL
            // hwnd is the documented thread-hotkey form, and the combo was
            // validated above to carry a real modifier (never steals typing).
            let ok = unsafe {
                RegisterHotKey(
                    std::ptr::null_mut(),
                    hotkey_id as i32,
                    combo.win_modifiers() | MOD_NOREPEAT,
                    combo.win_vk(),
                )
            };
            let code = if ok != 0 {
                S_ACTIVE
            } else if unsafe { GetLastError() } == ERROR_HOTKEY_ALREADY_REGISTERED {
                S_TAKEN
            } else {
                S_UNSUPPORTED
            };
            pump_status.store(code, Ordering::SeqCst);
            let _ = tx.send((code, tid));
            if code != S_ACTIVE {
                return; // nothing registered: nothing to pump or release
            }
            // SAFETY: `msg` is valid local storage; GetMessageW with a NULL
            // hwnd and a 0..0 filter walks this thread's queue. `on_event` is
            // the caller's Send 'static closure, run on the pump thread.
            let mut msg: MSG = unsafe { std::mem::zeroed() };
            loop {
                let got = unsafe { GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) };
                if got <= 0 {
                    break; // WM_QUIT (stop()) or a fatal queue error
                }
                if msg.message == WM_HOTKEY && msg.wParam == hotkey_id as usize {
                    on_event(GrabEvent::Pressed);
                } else {
                    unsafe {
                        TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                }
            }
            // SAFETY: unregister on the OWNING thread before it exits.
            unsafe { UnregisterHotKey(std::ptr::null_mut(), hotkey_id as i32) };
        });
        let (code, tid) = rx.recv().unwrap_or((S_UNSUPPORTED, 0));
        if code != S_ACTIVE {
            // The pump is already gone (or never needed); join reaps it.
            let _ = thread.join();
            return Grabber { status, thread_id: 0, thread: None };
        }
        Grabber { status, thread_id: tid, thread: Some(thread) }
    }

    pub fn status(&self) -> Status {
        match self.status.load(Ordering::SeqCst) {
            S_ACTIVE => Status::Active,
            S_TAKEN => Status::Taken,
            S_INVALID => Status::Invalid,
            _ => Status::Unsupported,
        }
    }

    /// Wake the pump (WM_QUIT to its thread queue), which unregisters on its
    /// own thread before exiting; join so a rebind never races the release.
    pub fn stop(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        if let Some(t) = self.thread.take() {
            // SAFETY: `thread_id` came from the pump itself in the handshake,
            // never a guess; a posted WM_QUIT to a thread that already exited
            // simply fails and the join below reaps whatever is left.
            unsafe {
                PostThreadMessageW(self.thread_id, WM_QUIT, 0, 0);
            }
            let _ = t.join();
        }
    }
}

#[cfg(windows)]
impl Drop for Grabber {
    fn drop(&mut self) {
        // A Grabber dropped without stop() must still release the system-wide
        // grab: the pump unregisters itself when its queue drains on WM_QUIT.
        self.shutdown();
    }
}
