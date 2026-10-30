#!/bin/sh
# Compile and execute the real Rust library receiver with the real Node producer.
# No Tauri entry point, GUI, X server, model, installed socket or network download.
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/../../.." && pwd -P)
private_root=$(mktemp -d "$root/apps/desktop-pi/.real-XXXXXX")
cleanup() {
  # Rust closes its sockets and removes its exclusively created fixture leaves.
  # Never recursively delete unexpected content after an interrupted test.
  if ! rmdir -- "$private_root"; then
    printf '%s\n' "Preserved nonempty integration root: $private_root" >&2
    return 1
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf '%s\n' "Headless real Rust/Node integration; private ABITO_SOCKET_DIR=$private_root"
env -u DISPLAY -u WAYLAND_DISPLAY -u DBUS_SESSION_BUS_ADDRESS -u XAUTHORITY -u XDG_SESSION_TYPE \
  CARGO_NET_OFFLINE=true \
  CARGO_TARGET_DIR="$root/apps/desktop-tauri/target" \
  ABITO_SOCKET_DIR="$private_root" \
  ABITO_PI_PRODUCER_DIR="$root/apps/desktop-pi" \
  cargo test --manifest-path "$root/apps/desktop-tauri/Cargo.toml" \
    --offline --locked --test question_producer --jobs 2 -- --ignored --test-threads=1
