//! The macOS side of the global shortcut (HU-053): a Carbon `RegisterEventHotKey` grab.
//!
//! Chosen over a CGEventTap because it needs NO permission (no Accessibility, no Input
//! Monitoring): the system itself delivers only our own combo. Nothing here ever prompts.
//! Honest limits: a combo another app already holds is `Taken`; macOS 15 refuses Option-only and
//! Option+Shift-only combos for this API (the default Ctrl+Alt+A is not affected), which shows up
//! as `Unsupported`. Same `status()`/`stop()` contract as the win32 and x11 seams.
//!
//! Threading: the Carbon event handler is installed on the application event target, so presses
//! arrive on the main thread's run loop. Registration is done by the host ON the main thread
//! (see `hotkeyhost_windows.rs`); `Drop` releases from whatever thread owns the grab, which the
//! Event Manager tolerates for these two calls.
#[cfg(target_os = "macos")]
mod imp {
    use crate::hotkey::{Combo, Status};
    use std::ffi::c_void;

    type OsStatus = i32;
    const NO_ERR: OsStatus = 0;
    /// eventHotKeyExistsErr (CarbonEventsCore.h): the combo is held by another registration.
    const EXISTS_ERR: OsStatus = -9878;
    const CLASS_KEYBOARD: u32 = u32::from_be_bytes(*b"keyb");
    const HOT_KEY_PRESSED: u32 = 5;
    const SIGNATURE: u32 = u32::from_be_bytes(*b"abit");

    #[repr(C)]
    struct EventTypeSpec { event_class: u32, event_kind: u32 }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct HotKeyId { signature: u32, id: u32 }

    type Handler = extern "C" fn(*mut c_void, *mut c_void, *mut c_void) -> OsStatus;

    #[link(name = "Carbon", kind = "framework")]
    extern "C" {
        fn GetApplicationEventTarget() -> *mut c_void;
        fn InstallEventHandler(target: *mut c_void, handler: Handler, count: u32,
            types: *const EventTypeSpec, user: *mut c_void, out: *mut *mut c_void) -> OsStatus;
        fn RemoveEventHandler(handler: *mut c_void) -> OsStatus;
        fn RegisterEventHotKey(code: u32, mods: u32, id: HotKeyId, target: *mut c_void,
            options: u32, out: *mut *mut c_void) -> OsStatus;
        fn UnregisterEventHotKey(hotkey: *mut c_void) -> OsStatus;
    }

    /// What the C callback gets back: the caller's closure, leaked until `Drop`.
    type OnPress = Box<dyn Fn() + Send + 'static>;

    extern "C" fn trampoline(_call: *mut c_void, _event: *mut c_void, user: *mut c_void) -> OsStatus {
        if !user.is_null() {
            // SAFETY: `user` is the `*const OnPress` installed by `start`, alive until `Drop`
            // removes the handler (after which Carbon never calls this again).
            let f = unsafe { &*(user as *const OnPress) };
            f();
        }
        NO_ERR
    }

    /// A live Carbon grab. `status` may be `Taken`/`Unsupported` with nothing registered.
    pub struct Grabber {
        status: Status,
        hotkey: *mut c_void,
        handler: *mut c_void,
        on_press: *mut OnPress,
    }

    // SAFETY: the raw pointers are opaque Carbon refs plus a Box<dyn Fn + Send>; they are only
    // used to release the registration, which Carbon allows from any thread.
    unsafe impl Send for Grabber {}

    impl Grabber {
        /// Register `combo`. Call on the main thread so presses reach the app run loop.
        pub fn start(hotkey_id: u32, combo: Combo, on_press: impl Fn() + Send + 'static) -> Grabber {
            let none = |status| Grabber { status, hotkey: std::ptr::null_mut(), handler: std::ptr::null_mut(), on_press: std::ptr::null_mut() };
            if combo.validate().is_err() { return none(Status::Invalid); }
            let boxed: *mut OnPress = Box::into_raw(Box::new(Box::new(on_press) as OnPress));
            let spec = EventTypeSpec { event_class: CLASS_KEYBOARD, event_kind: HOT_KEY_PRESSED };
            let mut handler = std::ptr::null_mut();
            // SAFETY: `spec` outlives the call; `boxed` is released below or in Drop.
            let installed = unsafe {
                InstallEventHandler(GetApplicationEventTarget(), trampoline, 1, &spec, boxed as *mut c_void, &mut handler)
            };
            if installed != NO_ERR {
                // SAFETY: never handed to Carbon.
                drop(unsafe { Box::from_raw(boxed) });
                return none(Status::Unsupported);
            }
            let mut hotkey = std::ptr::null_mut();
            // SAFETY: plain registration; the out-pointer is valid local storage.
            let code = unsafe {
                RegisterEventHotKey(combo.mac_keycode(), combo.mac_modifiers(),
                    HotKeyId { signature: SIGNATURE, id: hotkey_id }, GetApplicationEventTarget(), 0, &mut hotkey)
            };
            if code != NO_ERR {
                // SAFETY: the handler was installed above; remove it before freeing its user data.
                unsafe { RemoveEventHandler(handler); drop(Box::from_raw(boxed)); }
                return none(if code == EXISTS_ERR { Status::Taken } else { Status::Unsupported });
            }
            Grabber { status: Status::Active, hotkey, handler, on_press: boxed }
        }

        pub fn status(&self) -> Status { self.status }

        pub fn stop(self) { drop(self); }
    }

    impl Drop for Grabber {
        fn drop(&mut self) {
            // SAFETY: each pointer is released exactly once and nulled.
            unsafe {
                if !self.hotkey.is_null() { UnregisterEventHotKey(self.hotkey); self.hotkey = std::ptr::null_mut(); }
                if !self.handler.is_null() { RemoveEventHandler(self.handler); self.handler = std::ptr::null_mut(); }
                if !self.on_press.is_null() { drop(Box::from_raw(self.on_press)); self.on_press = std::ptr::null_mut(); }
            }
        }
    }
}

#[cfg(target_os = "macos")]
pub use imp::Grabber;
