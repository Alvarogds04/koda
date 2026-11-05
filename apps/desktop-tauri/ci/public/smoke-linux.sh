#!/bin/sh
# Koda desktop (Tauri) — Linux installer smoke (K2-01 / T3a, spec S2).
#
# What it proves, on the SHIPPED binary (no `probe` feature) installed the way a
# user installs it, on a disposable Linux machine:
#   (a) install    packaging/build.cjs stages an offline release build and
#                  packaging/install.sh verifies every hash against receipt.json
#                  and installs it into a PRIVATE prefix (never ~/.local).
#   (b) start      the INSTALLED launcher (abito-island-launcher, started exactly
#                  as the generated .desktop Exec line starts it) reaches the
#                  app-owned daemon ready line and publishes the notice socket.
#   (c-island)     the island window is mapped on the private X display with the
#                  native stage size from src/geometry.rs and _NET_WM_STATE_ABOVE.
#   (c-tray)       the island log has no «tray unavailable:» and the REAL exported
#                  AppIndicator DBusMenu carries its four labels (labels read by
#                  packaging/validate/tray.py). Choosing a menu item is NOT asserted
#                  here: «Ocultar»/«Mostrar Koda» change app state a black-box smoke
#                  cannot observe reliably, and the probe build already proves that
#                  scene (bandeja-menu) from inside the page.
#   (d) notice     the INSTALLED desktop-harness/bin/abito-hook.cjs receives a
#                  Claude «Stop» payload and the island log carries EXACTLY one
#                  content-free «island: settled notice accepted» line (src/protocol.rs
#                  SETTLED_NOTICE_LOG_LINE) — the same proof ci/public/smoke-windows.ps1
#                  and smoke-macos-installed.py run.
#
# Registered human gaps (NOT proven here, by construction):
#   * answering a question through the shipped binary (needs a human answering);
#   * seeing the tray icon with your own eyes;
#   * the in-page compact-pill measurement (288x32): only the probe build can read
#     the page. This smoke asserts the native stage (geometry::ISLAND_WINDOW) the
#     compact view is drawn in, plus always-on-top.
#
# Usage:
#   sh smoke-linux.sh --app <repo>/apps/desktop-tauri --work <empty dir> --pi <pi bin> \
#     --runtime-archive <koda-runtime-linux-x64.tar.gz>
#
#   --app   the desktop-tauri crate checkout. It must be a CLEAN git tree: build.cjs
#           refuses uncommitted product bytes (crate + shipped daemon/harness).
#           For a local proof build from a scratch worktree and invoke this script
#           from OUTSIDE that tree:
#             git -C <repo> worktree add --detach "$(mktemp -d)" HEAD
#   --work  private, disposable directory this smoke owns. It must be EMPTY (two
#           runs never share state); it is created here and KEPT for its logs.
#           It must NOT sit under a world-writable or symlinked ancestor
#           (/tmp, /var/tmp): the island's socket policy rejects a world-writable
#           directory chain. $RUNNER_TEMP on GitHub-hosted runners is fine; on a
#           laptop use e.g. "$HOME/.cache/koda-smoke".
#   --pi    a real Pi CLI. The app-owned daemon refuses to start without one
#           (`island host: no_daemon (pi_missing)`), exactly like a user machine.
#           CI installs the pinned Pi (PI_VERSION in .github/workflows/ci.yml) and
#           passes "$(command -v pi)". No model call is ever made.
#   --runtime-archive  the bundled runtime archive (pinned Node 22 + Pi) built by
#           `node packaging/runtime/build-runtime.cjs --target linux-x64 --archive`
#           (K2-02, decision A): build.cjs stages it and install.sh verifies its
#           sha256 against receipt.json and its tar members before extracting it
#           to PREFIX/runtime — with NO Node on the machine required for that.
#
# Environment the caller provides:
#   SHERPA_ONNX_LIB_DIR  directory with the pinned sherpa-onnx static libs (the
#                        archive + sha256 the ci.yml rust job fetches). The cargo
#                        build itself is --offline --locked; without this variable
#                        sherpa-onnx-sys would download its prebuilt archive.
#
# apt packages needed BEYOND the ci.yml rust job (libwebkit2gtk-4.1-dev
# libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev libpulse-dev
# libasound2-dev libdbus-1-dev xvfb dbus-x11):
#   openbox           the window manager (always-on-top is a WM state)
#   x11-utils         xprop, xwininfo
#   dbus              dbus-daemon itself (dbus-x11 only ships dbus-launch)
#   python3-gi        packaging/validate/tray.py reads the real DBusMenu
#   gir1.2-glib-2.0   its GLib/Gio typelibs
#   procps            pgrep, used to reap this run's process tree
#
# Isolation: nothing of your session is touched. Every directory the run writes to
# lives under --work, the display is a fresh Xvfb (never :0), the bus is a fresh
# dbus-daemon, HOME and XDG_* are rewritten, and the whole process tree this
# script starts is killed on exit, success or failure. It keeps working when you
# are already running Koda/Abito: the app's single-instance lock lives on this
# private bus. Never run it as root.
set -eu
umask 077

APP=''
WORK=''
PI=''
RUNTIME_ARCHIVE=''
REASON=''

say() { printf '%s\n' "$*"; }
pass() { printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*"; }
die() { printf 'smoke-linux: %s\n' "$*" >&2; exit 2; }

usage() { sed -n '29,53p' "$0"; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --app) [ "$#" -ge 2 ] || die "--app needs a directory"; APP=$2; shift 2 ;;
    --work) [ "$#" -ge 2 ] || die "--work needs a directory"; WORK=$2; shift 2 ;;
    --pi) [ "$#" -ge 2 ] || die "--pi needs an executable"; PI=$2; shift 2 ;;
    --runtime-archive) [ "$#" -ge 2 ] || die "--runtime-archive needs a file"; RUNTIME_ARCHIVE=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

[ -n "$APP" ] || die "--app is required (see --help)"
[ -n "$WORK" ] || die "--work is required (see --help)"
[ -n "$PI" ] || die "--pi is required (see --help)"
[ -n "$RUNTIME_ARCHIVE" ] || die "--runtime-archive is required: run packaging/runtime/build-runtime.cjs --archive first (see --help)"

# ---------------------------------------------------------------- preflight --
[ "$(id -u)" -ne 0 ] || die "this is a user-local install; do not run it as root"

MISSING=''
for tool in node cargo rustc Xvfb openbox xprop xwininfo dbus-daemon python3 stat pgrep git sha256sum mktemp; do
  command -v "$tool" >/dev/null 2>&1 || MISSING="$MISSING $tool"
done
[ -z "$MISSING" ] || die "missing tools:$MISSING — install the apt packages listed in this script's header"
python3 -c 'import gi' >/dev/null 2>&1 || die "python3 cannot import gi: install python3-gi and gir1.2-glib-2.0"

[ -d "$APP" ] || die "--app is not a directory: $APP"
APP=$(cd "$APP" && pwd -P)
[ -f "$APP/packaging/build.cjs" ] && [ -f "$APP/packaging/install.sh" ] || die "--app is not apps/desktop-tauri: $APP"
[ -f "$APP/packaging/validate/tray.py" ] || die "--app lacks packaging/validate/tray.py: $APP"
[ -f "$APP/src/geometry.rs" ] || die "--app lacks src/geometry.rs: $APP"

[ -x "$PI" ] || die "--pi is not an executable: $PI"
PI=$(cd "$(dirname "$PI")" && pwd -P)/$(basename "$PI")
PI_DIR=$(dirname "$PI")

[ -f "$RUNTIME_ARCHIVE" ] || die "--runtime-archive is not a file: $RUNTIME_ARCHIVE"
[ "$(basename "$RUNTIME_ARCHIVE")" = "koda-runtime-linux-x64.tar.gz" ] || die "--runtime-archive must be named koda-runtime-linux-x64.tar.gz: $(basename "$RUNTIME_ARCHIVE")"
RUNTIME_ARCHIVE=$(cd "$(dirname "$RUNTIME_ARCHIVE")" && pwd -P)/$(basename "$RUNTIME_ARCHIVE")

[ -n "${SHERPA_ONNX_LIB_DIR:-}" ] || die "SHERPA_ONNX_LIB_DIR is required: point it at the pinned sherpa-onnx static libs (the archive the ci.yml rust job fetches and sha256-checks)"
[ -d "$SHERPA_ONNX_LIB_DIR" ] || die "SHERPA_ONNX_LIB_DIR is not a directory: $SHERPA_ONNX_LIB_DIR"

# install.sh accepts these strings inside a .desktop Exec line: keep the shapes.
path_shape_ok() {
  case "$1" in /*) ;; *) return 1 ;; esac
  case "$1" in *[!A-Za-z0-9_./-]*) return 1 ;; esac
  case "$1" in *//*|*/./*|*/../*|*/.|*/..|*/) return 1 ;; esac
  [ "$1" != "/" ]
}

# The island refuses a world-writable or symlinked ancestor chain (transport.rs
# directory_chain). /tmp and /var/tmp are world-writable, so --work cannot live there.
chain_safe() {
  rest=$1
  cur=''
  while [ -n "$rest" ]; do
    case "$rest" in
      */*) segment=${rest%%/*}; rest=${rest#*/} ;;
      *) segment=$rest; rest='' ;;
    esac
    [ -n "$segment" ] || continue
    cur="$cur/$segment"
    [ -d "$cur" ] || { REASON="$cur is not a directory"; return 1; }
    [ -L "$cur" ] && { REASON="$cur is a symlink"; return 1; }
    mode=$(stat -c %a "$cur" 2>/dev/null || echo 0)
    case "$mode" in
      *[2367]) REASON="$cur is world-writable (mode $mode)"; return 1 ;;
    esac
  done
  return 0
}

path_shape_ok "$WORK" || die "--work must be an absolute normalized path of [A-Za-z0-9_./-]: $WORK"
case "$WORK" in "$APP"|"$APP"/*) die "--work must be outside --app: $WORK" ;; esac
case "$APP" in "$WORK"/*) die "--work must not contain --app: $WORK" ;; esac
[ "$WORK" != "$HOME" ] || die "--work must not be your home directory"
# sockaddr_un.sun_path is 108 bytes on Linux, NUL included: keep the notice socket
# inside that limit instead of failing later inside the app.
SOCKET_SUFFIX='/run/abito-island/p-XXXXXX/s'
[ $(( ${#WORK} + ${#SOCKET_SUFFIX} )) -le 107 ] || die "--work is too deep: ${#WORK} + ${#SOCKET_SUFFIX} bytes exceeds the 107-byte unix socket limit (use a shorter --work)"

if [ -e "$WORK" ]; then
  [ -d "$WORK" ] || die "--work exists and is not a directory: $WORK"
  [ -z "$(ls -A "$WORK")" ] || die "--work is not empty (two runs never share state): $WORK"
else
  mkdir -p "$WORK" || die "cannot create --work: $WORK"
fi
chmod 700 "$WORK"
chain_safe "$WORK" || die "--work is unusable: $REASON. The island's socket policy rejects world-writable or symlinked ancestors, so /tmp and /var/tmp are not allowed; use e.g. \"\$HOME/.cache/koda-smoke\" or \$RUNNER_TEMP"

# build.cjs refuses uncommitted product bytes; say so before spending a build.
for rel in . ../desktop-daemon ../desktop-harness; do
  where=$(cd "$APP/$rel" && pwd -P)
  dirty=$(git -C "$APP/$rel" status --porcelain --untracked-files=all -- . 2>&1 | head -n 5 || true)
  if [ -n "$dirty" ]; then
    die "the tree is not clean under $where; build.cjs refuses that. Build from a scratch worktree:
  git -C <repo> worktree add --detach \"\$(mktemp -d)\" HEAD
first entries:
$dirty"
  fi
done

NODE_DIR=$(dirname "$(command -v node)")
BASE_PATH="$PI_DIR:$NODE_DIR:/usr/local/bin:/usr/bin:/bin"

SMOKE_HOME="$WORK/home"
XDG_RUNTIME="$WORK/run"
XDG_CONFIG="$WORK/config"
XDG_DATA="$WORK/data"
XDG_CACHE="$WORK/cache"
XDG_STATE="$WORK/state"
SMOKE_TMP="$WORK/tmp"
PREFIX="$WORK/installed"
APPS="$WORK/applications"
PROJECT="$WORK/project"
for dir in "$SMOKE_HOME" "$XDG_RUNTIME" "$XDG_CONFIG" "$XDG_DATA" "$XDG_CACHE" "$XDG_STATE" "$SMOKE_TMP" "$APPS" "$PROJECT"; do
  mkdir -p "$dir"
  chmod 700 "$dir"
done

# The OS-standard environment a GUI launch gets, rebuilt from nothing: no
# DISPLAY/XAUTHORITY/WAYLAND/DBUS of the caller, no ABITO_* override (the launcher
# refuses those and so does this smoke).
smoke_env() {
  env -i \
    PATH="$BASE_PATH" \
    HOME="$SMOKE_HOME" \
    USER="$(id -un)" LOGNAME="$(id -un)" \
    LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC \
    TMPDIR="$SMOKE_TMP" \
    DISPLAY=":$DISPLAY_NUM" \
    DBUS_SESSION_BUS_ADDRESS="$DBUS_ADDRESS" \
    XDG_RUNTIME_DIR="$XDG_RUNTIME" \
    XDG_CONFIG_HOME="$XDG_CONFIG" \
    XDG_DATA_HOME="$XDG_DATA" \
    XDG_CACHE_HOME="$XDG_CACHE" \
    XDG_STATE_HOME="$XDG_STATE" \
    GDK_BACKEND=x11 LIBGL_ALWAYS_SOFTWARE=1 NO_AT_BRIDGE=1 \
    "$@"
}

# The caller's own Koda install must not be touched by this run: presence plus
# mtime+size of the two paths install.sh would write without explicit overrides.
real_state() {
  for path in "$HOME/.local/share/abito-island" "$HOME/.local/share/applications/com.abitog.AbitoTauri.desktop"; do
    if [ -e "$path" ]; then printf '%s=%s;' "$path" "$(stat -c '%Y:%s' "$path")"; else printf '%s=absent;' "$path"; fi
  done
}
REAL_BEFORE=$(real_state)

# The expected island stage size comes from the app's own constants, so the check
# cannot drift from the code. Xvfb has no scaling: logical px == physical px.
EXPECT_W=$(sed -n 's/^pub const ISLAND_WINDOW: (i32, i32) = (\([0-9]*\), \([0-9]*\));$/\1/p' "$APP/src/geometry.rs" | head -n 1)
EXPECT_H=$(sed -n 's/^pub const ISLAND_WINDOW: (i32, i32) = (\([0-9]*\), \([0-9]*\));$/\2/p' "$APP/src/geometry.rs" | head -n 1)
COMPACT=$(sed -n 's/^pub const COMPACT_BAR: (i32, i32) = (\([0-9]*\), \([0-9]*\));$/\1x\2/p' "$APP/src/geometry.rs" | head -n 1)
[ -n "$EXPECT_W" ] && [ -n "$EXPECT_H" ] || die "cannot read ISLAND_WINDOW from $APP/src/geometry.rs"

DISPLAY_NUM=''
DBUS_ADDRESS=''
XVFB_PID=''
DBUS_PID=''
WM_PID=''
ISLAND_PID=''

# ------------------------------------------------------------- process tree --
kill_tree() { # pid signal
  for child in $(pgrep -P "$1" 2>/dev/null || true); do
    kill_tree "$child" "$2"
  done
  kill -"$2" "$1" 2>/dev/null || true
}

cleanup() {
  trap - EXIT INT TERM
  if [ -n "$ISLAND_PID" ]; then
    kill -TERM "$ISLAND_PID" 2>/dev/null || true
    n=0
    while [ "$n" -lt 150 ] && kill -0 "$ISLAND_PID" 2>/dev/null; do sleep 0.1; n=$((n + 1)); done
    kill_tree "$ISLAND_PID" KILL
  fi
  for pid in $WM_PID $DBUS_PID $XVFB_PID; do
    [ -n "$pid" ] && kill_tree "$pid" TERM
  done
  sleep 0.3
  for pid in $WM_PID $DBUS_PID $XVFB_PID; do
    [ -n "$pid" ] && kill_tree "$pid" KILL
  done
  return 0
}
trap cleanup EXIT INT TERM

diag() {
  say ''
  say '--- smoke diagnostics (private paths only, no session/token contents) ---'
  say "work dir: $WORK"
  for log in build.log install.log island.log tray.log hook.stdout.log hook.stderr.log xvfb.log dbus.log openbox.log; do
    [ -f "$WORK/$log" ] || continue
    say "--- $log (tail 40) ---"
    tail -n 40 "$WORK/$log" || true
  done
}

fail_rest() { # $1 = failed part, $2... = not evaluated
  shift
  for label in "$@"; do fail "$label — not evaluated: a previous part failed"; done
}

wait_for() { # seconds description command...
  limit=$1
  description=$2
  shift 2
  end=$(($(date +%s) + limit))
  while :; do
    if "$@" >/dev/null 2>&1; then return 0; fi
    [ "$(date +%s)" -lt "$end" ] || { REASON="timed out after ${limit}s waiting for $description"; return 1; }
    sleep 0.2
  done
}

json_ok() { # reads a {"ok":true|false} document on stdin
  node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{process.exit(JSON.parse(s).ok===true?0:1)}catch(e){process.exit(1)}})' 2>/dev/null
}

# ------------------------------------------------------------------ (a) ------
say "smoke-linux: app=$APP work=$WORK pi=$PI"
say '== (a) install: build.cjs + install.sh into a private prefix'
if ( cd "$APP" && node packaging/build.cjs --out "$WORK/stage" --runtime-archive "$RUNTIME_ARCHIVE" ) > "$WORK/build.log" 2>&1; then
  STAGE=$(find "$WORK/stage/abito-island" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | head -n 1 || true)
  if [ -z "$STAGE" ] || [ ! -f "$STAGE/receipt.json" ]; then
    fail "(a) install — build.cjs produced no stage with a receipt"
    fail_rest "(a)" "(b) start" "(c-island) show" "(c-tray) tray" "(d) notice"
    diag
    exit 1
  fi
  if smoke_env sh "$APP/packaging/install.sh" "$STAGE" --prefix "$PREFIX" --project-root "$PROJECT" --applications-dir "$APPS" > "$WORK/install.log" 2>&1 \
     && grep -q 'Stage verified against receipt.json' "$WORK/install.log" \
     && grep -q "Installed Abito (Tauri) in $PREFIX" "$WORK/install.log" \
     && [ -x "$PREFIX/abito-island" ] && [ -x "$PREFIX/abito-island-launcher" ] \
     && [ -f "$PREFIX/receipt.json" ] && [ -f "$APPS/com.abitog.AbitoTauri.desktop" ] \
     && [ -d "$PREFIX/runtime" ] && [ ! -L "$PREFIX/runtime" ] \
     && [ -x "$PREFIX/runtime/node" ] && [ -x "$PREFIX/runtime/pi" ] \
     && grep -q '"features": "tauri/custom-protocol (no probe)"' "$PREFIX/receipt.json" \
     && [ "$(sha256sum "$STAGE/abito-island" | cut -d' ' -f1)" = "$(sha256sum "$PREFIX/abito-island" | cut -d' ' -f1)" ]; then
    EXEC=$(sed -n 's/^Exec=//p' "$APPS/com.abitog.AbitoTauri.desktop")
    if [ "$EXEC" = "env ABITO_PROJECT_ROOT=$PROJECT \"$PREFIX/abito-island-launcher\"" ]; then
      pass "(a) install: build.cjs staged $(basename "$STAGE") offline with the verified runtime archive (receipt: no probe feature); install.sh re-verified every hash against receipt.json, audited the runtime members, extracted the bundled Node+Pi to $PREFIX/runtime and installed the app in $PREFIX (binary sha256 $(sha256sum "$PREFIX/abito-island" | cut -d' ' -f1))"
    else
      fail "(a) install — the generated .desktop Exec line is not the expected one: $EXEC"
      fail_rest "(a)" "(b) start" "(c-island) show" "(c-tray) tray" "(d) notice"
      diag
      exit 1
    fi
  else
    fail "(a) install — install.sh did not verify+install the stage (see install.log)"
    fail_rest "(a)" "(b) start" "(c-island) show" "(c-tray) tray" "(d) notice"
    diag
    exit 1
  fi
else
  fail "(a) install — build.cjs failed (clean tree? SHERPA_ONNX_LIB_DIR? offline cargo registry?)"
  fail_rest "(a)" "(b) start" "(c-island) show" "(c-tray) tray" "(d) notice"
  diag
  exit 1
fi

# ------------------------------------------------------------------ (b) ------
say '== (b) start: installed launcher -> daemon ready + notice socket'
# Xvfb on an explicit high display: it refuses a display somebody else owns, so
# the caller's session is never touched, and :0 is never used (tray.py refuses it).
XVFB_OK=''
n=91
while [ "$n" -le 120 ]; do
  Xvfb ":$n" -screen 0 1280x900x24 -nolisten tcp -noreset > "$WORK/xvfb.log" 2>&1 &
  XVFB_PID=$!
  sleep 0.5
  if kill -0 "$XVFB_PID" 2>/dev/null; then
    DISPLAY_NUM=$n
    end=$(($(date +%s) + 10))
    while :; do
      if smoke_env xprop -root >/dev/null 2>&1; then XVFB_OK=1; break; fi
      [ "$(date +%s)" -lt "$end" ] || break
      sleep 0.2
    done
    [ -n "$XVFB_OK" ] && break
    kill_tree "$XVFB_PID" TERM
  fi
  XVFB_PID=''
  n=$((n + 1))
done
if [ -z "$XVFB_OK" ]; then
  fail "(b) start — could not start an Xvfb display in :91-:120"
  fail_rest "(b)" "(c-island) show" "(c-tray) tray" "(d) notice"
  diag
  exit 1
fi

dbus-daemon --session --nofork --print-address=1 > "$WORK/dbus.log" 2>&1 &
DBUS_PID=$!
if ! wait_for 15 'the private session bus' grep -q '/' "$WORK/dbus.log"; then
  fail "(b) start — $REASON"
  fail_rest "(b)" "(c-island) show" "(c-tray) tray" "(d) notice"
  diag
  exit 1
fi
DBUS_ADDRESS=$(head -n 1 "$WORK/dbus.log")

smoke_env openbox --sm-disable > "$WORK/openbox.log" 2>&1 &
WM_PID=$!
wm_ready() { smoke_env xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q 'window id # 0x[1-9a-f]'; }
if ! wait_for 20 'the window manager' wm_ready; then
  fail "(b) start — $REASON"
  fail_rest "(b)" "(c-island) show" "(c-tray) tray" "(d) notice"
  diag
  exit 1
fi

# Launch the INSTALLED launcher exactly as the menu entry does (the Exec line the
# installer generated), never the build tree and never with a probe/ABITO override.
smoke_env sh -c "$EXEC" > "$WORK/island.log" 2>&1 &
ISLAND_PID=$!

daemon_ready() { grep -q 'abito-island-daemon: running (pid ' "$WORK/island.log"; }
if ! wait_for 180 'the app-owned daemon ready line' daemon_ready; then
  fail "(b) start — $REASON (island.log has no «abito-island-daemon: running (pid » line)"
  fail_rest "(b)" "(c-island) show" "(c-tray) tray" "(d) notice"
  diag
  exit 1
fi
if grep -q 'island host: no_daemon' "$WORK/island.log"; then
  fail "(b) start — the island reported «island host: no_daemon»"
  fail_rest "(b)" "(c-island) show" "(c-tray) tray" "(d) notice"
  diag
  exit 1
fi
SOCKET=$(sed -n 's/^ABITO_DESKTOP_SOCKET=//p' "$WORK/island.log" | head -n 1)
HANDOFF="$XDG_RUNTIME/abito-island/endpoint.json"
if [ -S "$SOCKET" ] && [ -f "$HANDOFF" ] && [ "$(stat -c %a "$HANDOFF")" = 600 ]; then
  pass "(b) start: the installed launcher started the app-owned daemon (ready line received) and published $HANDOFF (0600) for socket $SOCKET"
else
  fail "(b) start — no notice socket/handoff published (socket='$SOCKET' handoff='$HANDOFF')"
  fail_rest "(b)" "(c-island) show" "(c-tray) tray" "(d) notice"
  diag
  exit 1
fi

# ------------------------------------------------------------ (c-island) ------
say '== (c-island) show: mapped island window, stage size, _NET_WM_STATE_ABOVE'
island_id() {
  list=$(smoke_env xprop -root _NET_CLIENT_LIST 2>/dev/null) || return 1
  ids=$(printf '%s\n' "$list" | sed -n 's/.*window id # //p' | tr ',' ' ')
  for id in $ids; do
    if smoke_env xprop -id "$id" WM_NAME 2>/dev/null | grep -q '"Koda"'; then
      printf '%s' "$id"
      return 0
    fi
  done
  # A window manager that publishes no _NET_CLIENT_LIST still has the window in the
  # tree: accept the app's own class there, so the check never depends on the WM's bookkeeping.
  id=$(smoke_env xwininfo -root -tree 2>/dev/null | grep '"Koda": ("abito-island"' | head -n 1 | sed -n 's/^ *\(0x[0-9a-f]*\) .*/\1/p')
  if [ -n "$id" ]; then
    printf '%s' "$id"
    return 0
  fi
  return 1
}
island_viewable() {
  id=$(island_id) || return 1
  [ -n "$id" ] || return 1
  smoke_env xwininfo -id "$id" 2>/dev/null | grep -q 'Map State: IsViewable'
}

if ! wait_for 60 'the island window titled «Koda»' island_viewable; then
  fail "(c-island) show — $REASON"
  fail_rest "(c-island)" "(c-tray) tray" "(d) notice"
  diag
  exit 1
fi
WIN=$(island_id)
INFO=$(smoke_env xwininfo -id "$WIN")
WIDTH=$(printf '%s\n' "$INFO" | sed -n 's/^ *Width: *\([0-9]*\)$/\1/p')
HEIGHT=$(printf '%s\n' "$INFO" | sed -n 's/^ *Height: *\([0-9]*\)$/\1/p')
ABOVE=$(smoke_env xprop -id "$WIN" _NET_WM_STATE | grep -c '_NET_WM_STATE_ABOVE' || true)
if [ "$ABOVE" -ge 1 ] && [ "$WIDTH" = "$EXPECT_W" ] && [ "$HEIGHT" = "$EXPECT_H" ]; then
  pass "(c-island) show: island window $WIN is mapped viewable at the native stage size ${WIDTH}x${HEIGHT} (src/geometry.rs ISLAND_WINDOW) with _NET_WM_STATE_ABOVE; the ${COMPACT:-288x32} compact pill inside it is only readable from the probe build"
else
  fail "(c-island) show — window $WIN: above=$ABOVE size=${WIDTH}x${HEIGHT} expected ${EXPECT_W}x${EXPECT_H}"
  fail_rest "(c-island)" "(c-tray) tray" "(d) notice"
  diag
  exit 1
fi

# ------------------------------------------------------------- (c-tray) ------
say '== (c-tray) tray: real exported DBusMenu with its labels, no «tray unavailable:»'
TRAY="$APP/packaging/validate/tray.py"
if grep -q 'tray unavailable:' "$WORK/island.log"; then
  fail "(c-tray) tray — the island log says «tray unavailable:»"
  fail_rest "(c-tray)" "(d) notice"
  diag
  exit 1
fi
MENU=$(smoke_env python3 "$TRAY" 2>&1 || true)
printf '%s\n' "$MENU" > "$WORK/tray.log"
if printf '%s' "$MENU" | json_ok; then
  pass "(c-tray) tray: no «tray unavailable:» and the real AppIndicator DBusMenu exposed Mostrar Koda / Ocultar / Arrancar al iniciar sesión / Salir ($(printf '%s' "$MENU" | sed -n 's/.*"labels": \[\([^]]*\)\].*/\1/p'))"
else
  fail "(c-tray) tray — the real DBusMenu is missing or lacks its labels: $MENU"
  fail_rest "(c-tray)" "(d) notice"
  diag
  exit 1
fi

# ------------------------------------------------------------------ (d) ------
say '== (d) notice: installed hook «Stop» -> island accepted exactly one settled notice'
SETTLED_LINE='island: settled notice accepted'
settled_count() { grep -c -x -F "$SETTLED_LINE" "$WORK/island.log" || true; }
settled_seen() { [ "$(settled_count)" -ge 1 ]; }

PAYLOAD=$(printf '{"hook_event_name":"Stop","cwd":"%s","session_id":"ci-linux-installed-stop","stop_hook_active":false}' "$PROJECT")
REASON=''
hook_exit=0
printf '%s' "$PAYLOAD" | smoke_env node "$PREFIX/desktop-harness/bin/abito-hook.cjs" claude stop \
  > "$WORK/hook.stdout.log" 2> "$WORK/hook.stderr.log" || hook_exit=$?
if [ "$hook_exit" -ne 0 ]; then
  REASON="the installed hook exited $hook_exit"
elif [ -s "$WORK/hook.stdout.log" ] || [ -s "$WORK/hook.stderr.log" ]; then
  REASON="the installed hook was not silent: stdout='$(cat "$WORK/hook.stdout.log")' stderr='$(cat "$WORK/hook.stderr.log")'"
elif ! wait_for 60 'the island to accept the settled notice' settled_seen; then
  REASON="island.log has no «$SETTLED_LINE» line ($REASON)"
else
  sleep 2 # a duplicate acceptance would land right behind the first
  if [ "$(settled_count)" != 1 ]; then
    REASON="island.log has $(settled_count) «$SETTLED_LINE» lines instead of exactly 1"
  fi
fi
if [ -z "$REASON" ]; then
  pass "(d) notice: the installed hook sent a Claude Stop notice and the island logged exactly one content-free «$SETTLED_LINE» (CLI exit and stdout/stderr alone are not proof; the island's own acceptance is)"
else
  fail "(d) notice — $REASON"
  diag
  exit 1
fi

# ---------------------------------------------------------------- isolation --
REAL_AFTER=$(real_state)
if [ "$REAL_AFTER" != "$REAL_BEFORE" ]; then
  fail "isolation — the caller's REAL install changed ($REAL_BEFORE -> $REAL_AFTER)"
  diag
  exit 1
fi
say "isolation: the caller's own $HOME/.local/share/abito-island and .desktop are byte-identical (mtime+size) before and after"

say ''
say 'smoke-linux: all five parts passed on the shipped binary (S2 a/b/c-island/c-tray/d).'
say "Logs kept in $WORK (delete it yourself)."
exit 0
