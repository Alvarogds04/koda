fn main() {
    // Normal Cargo project: no cargo-tauri CLI. tauri-build validates
    // tauri.conf.json, capabilities and the static frontendDist at build time.
    tauri_build::build()
}
