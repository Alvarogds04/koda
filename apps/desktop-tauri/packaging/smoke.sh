#!/bin/sh
# Versioned smoke run of a STAGED binary (never an installed one). Own window
# only, private short roots under $HOME/.m4s-smoke, removed afterwards. The
# probe flags are deliberately set here, NOT through the launcher (it refuses
# them). The SHIPPED binary has no probe: smoke the `--smoke-variant` build
# (same commit + `probe` feature). Usage: packaging/smoke.sh <smoke-dir>
# (needs DISPLAY/XAUTHORITY)
set -eu
stage="${1:?usage: smoke.sh <smoke-variant dir>}"
root="$HOME/.m4s-smoke"
mkdir -m 700 "$root" "$root/project"
# A run killed by the timeout leaves our own `p-XXXXXX/s` socket behind: remove
# exactly that shape (never anything else), then the private dirs.
cleanup() {
  for d in "$root"/sock/p-??????; do [ -d "$d" ] && { rm -f "$d/s"; rmdir "$d"; }; done 2>/dev/null || true
  rmdir "$root/sock" 2>/dev/null || true
  rmdir "$root/project" "$root" 2>/dev/null || true
}
trap cleanup EXIT
GDK_BACKEND=x11 ABITO_PROBE=1 ABITO_PROJECT_ROOT="$root/project" ABITO_SOCKET_DIR="$root/sock" \
  timeout -s KILL 70 "$stage/abito-island" > "$root/probe.log" 2>&1 || true
grep -o '"ready_ok":[a-z]*\|"notice_count":[0-9]*\|"connections_while_connected":[0-9]*\|"svg_elements_rendered_by_clay_engine":[0-9]*\|"canvas_elements":[0-9]*' "$root/probe.log"
rm -f "$root/probe.log"
