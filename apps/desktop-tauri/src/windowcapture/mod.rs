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
pub mod server;
