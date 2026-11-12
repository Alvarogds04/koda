//! K2-06 «Preguntarle a Koda por mi ventana»: the host side of the window capture tool.
//!
//! Adapted from Gentle Dot `apps/desktop/src-tauri/src/computer/{blocklist,session,mcp,server}.rs`,
//! Copyright (c) Gentleman Programming, MIT (see THIRD-PARTY-NOTICES in apps/desktop-daemon).
//! Gentle Dot captures a whole display on macOS/Windows and has no Linux backend; Koda captures
//! one window chosen through `contextwin` (never the island) on every OS.
pub mod blocklist;
pub mod session;
pub mod mcp;
pub mod image;
#[cfg(target_os = "linux")]
pub mod x11;
// S8: GNOME Wayland through Koda's own extension, the system screenshot portal, and the order
// they are tried in (that order is `linux`).
#[cfg(target_os = "linux")]
pub mod gnome;
#[cfg(target_os = "linux")]
pub mod portal;
#[cfg(target_os = "linux")]
pub mod linux;
pub mod server;
#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(windows)]
pub mod win;
/// Native consent dialog (S6) on macOS (NSAlert) and Windows (TaskDialog), copied from Gentle Dot `alert.rs`.
#[cfg(any(target_os = "macos", windows))]
pub mod alert;
/// Linux consent dialog (GTK, the app's own).
#[cfg(target_os = "linux")]
pub mod consent_gtk;
pub mod host;
