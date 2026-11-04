#!/bin/sh
# Koda desktop (Tauri) — Linux installer smoke WITHOUT Node and WITHOUT Pi (K2-02 T5, S1 + S3).
#
# Runs AFTER ci/public/smoke-linux.sh in the same job, on the same disposable
# GitHub-hosted runner, and only there. It proves the story's promise: on a machine
# with no Node.js and no Pi at all, the shipped Linux package installs and its
# app-owned daemon runs on Koda's OWN bundled Node and Pi.
#
#   (q) quarantine  every node/npm/npx/pi/corepack on PATH (all `which -a` hits) and
#                   the runner toolcache's node are moved out of reach with sudo, and
#                   `command -v node` / `command -v pi` must then fail. NOTHING IS
#                   RESTORED: the runner is disposable and the job ends here.
#   (i) install     packaging/install.sh installs the stage built by the previous
#                   smoke into a fresh private prefix — with no Node on the machine.
#   (s) start       the INSTALLED launcher, under a GUI-like environment and under
#                   `strace -f -e trace=connect`, reaches «abito-island-daemon:
#                   running». The daemon only says that after the bundled Pi answered
#                   its first RPC `get_state` (a model-free round-trip). Its process
#                   image (/proc/<pid>/exe) must be <prefix>/runtime/node.
#   (t) status      the installed `daemon status` (run by <prefix>/runtime/node) exits 0.
#   (n) network     every connect() of the launched tree goes to a local socket or a
#                   loopback address; none to pi.dev or any other host (S3). The trace also
#                   records execve: it must show the bundled node exec-ing Pi's CLI (so the
#                   window covers Pi's start-up), then PI_CHECK_WINDOW more seconds are observed.
#
# Usage:
#   sh smoke-linux-no-node.sh --app <repo>/apps/desktop-tauri --stage <stage dir> --work <empty dir>
#
#   --stage  the stage packaging/build.cjs produced (it carries koda-runtime-linux-x64.tar.gz
#            and its receipt); the previous smoke builds it under <its work>/stage.
#   --work   an EMPTY private directory for this smoke's prefix, home and logs.
#
# Needs: sudo (hosted runner), strace, Xvfb, openbox, dbus-daemon, xprop, sha256sum.
set -eu
umask 077

APP=''
STAGE=''
WORK=''
say() { printf '%s\n' "$*"; }
pass() { printf 'PASS %s\n' "$*"; }
die() { printf 'smoke-linux-no-node: %s\n' "$*" >&2; exit 2; }
failx() { printf 'FAIL %s\n' "$*"; diag; exit 1; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --app) [ "$#" -ge 2 ] || die "--app needs a directory"; APP=$2; shift 2 ;;
    --stage) [ "$#" -ge 2 ] || die "--stage needs a directory"; STAGE=$2; shift 2 ;;
    --work) [ "$#" -ge 2 ] || die "--work needs a directory"; WORK=$2; shift 2 ;;
    -h|--help) sed -n '2,31p' "$0"; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

# Destructive for the machine's own Node: ONLY a disposable GitHub-hosted runner, checked before anything else.
if [ "${GITHUB_ACTIONS:-}" != true ] || [ "${RUNNER_ENVIRONMENT:-}" != github-hosted ]; then
  die "refusing to run: this smoke removes the machine's Node and Pi; it only runs on a disposable GitHub-hosted runner (GITHUB_ACTIONS=true, RUNNER_ENVIRONMENT=github-hosted)"
fi
[ -n "$APP" ] && [ -n "$STAGE" ] && [ -n "$WORK" ] || die "--app, --stage and --work are required (see --help)"
[ -f "$STAGE/receipt.json" ] && [ -f "$STAGE/koda-runtime-linux-x64.tar.gz" ] || die "--stage holds no receipt.json + koda-runtime-linux-x64.tar.gz: $STAGE"
[ ! -e "$WORK" ] || [ -z "$(ls -A "$WORK")" ] || die "--work must be empty or absent: $WORK"
for tool in strace Xvfb openbox dbus-daemon xprop sha256sum sudo readlink pgrep; do
  command -v "$tool" >/dev/null 2>&1 || die "required tool missing: $tool"
done
APP=$(cd "$APP" && pwd -P)
STAGE=$(cd "$STAGE" && pwd -P)
mkdir -p "$WORK"
WORK=$(cd "$WORK" && pwd -P)

PREFIX="$WORK/installed"
APPS="$WORK/applications"
PROJECT="$WORK/project"
SMOKE_HOME="$WORK/home"
XDG_RUNTIME="$WORK/run"
SMOKE_TMP="$WORK/tmp"
QUARANTINE="$WORK/quarantine"
for dir in "$APPS" "$PROJECT" "$SMOKE_HOME" "$XDG_RUNTIME" "$SMOKE_TMP" "$WORK/config" "$WORK/data" "$WORK/cache" "$WORK/state" "$QUARANTINE"; do
  mkdir -p "$dir"; chmod 700 "$dir"
done
XVFB_PID=''; DBUS_PID=''; WM_PID=''; ISLAND_PID=''

kill_tree() { for child in $(pgrep -P "$1" 2>/dev/null || true); do kill_tree "$child" "$2"; done; kill -"$2" "$1" 2>/dev/null || true; }
cleanup() {
  trap - EXIT INT TERM
  for pid in $ISLAND_PID $WM_PID $DBUS_PID $XVFB_PID; do [ -n "$pid" ] && kill_tree "$pid" TERM; done
  sleep 0.5
  for pid in $ISLAND_PID $WM_PID $DBUS_PID $XVFB_PID; do [ -n "$pid" ] && kill_tree "$pid" KILL; done
  return 0
}
trap cleanup EXIT INT TERM
diag() {
  say '--- diagnostics (private paths only, no session/token contents) ---'
  for log in install.log island.log status.log quarantine.log; do
    [ -f "$WORK/$log" ] || continue
    say "--- $log (tail 40) ---"; tail -n 40 "$WORK/$log" || true
  done
  [ -f "$WORK/connect.trace" ] && { say '--- non-local connect() calls ---'; grep -v 'sa_family=AF_UNIX' "$WORK/connect.trace" | tail -n 20 || true; }
}
wait_for() { # seconds command...
  end=$(($(date +%s) + $1)); shift
  while :; do "$@" >/dev/null 2>&1 && return 0; [ "$(date +%s)" -lt "$end" ] || return 1; sleep 0.25; done
}

# ------------------------------------------------------------------ (q) ------
say '== (q) quarantine every node/npm/npx/pi/corepack on this disposable runner'
{
  for tool in node npm npx pi corepack; do
    # every hit on PATH (several setup-node / npm -g layouts coexist on hosted runners), symlinks included
    for hit in $(which -a "$tool" 2>/dev/null || true); do
      [ -e "$hit" ] || [ -L "$hit" ] || continue
      dest="$QUARANTINE/$(printf '%s' "$hit" | tr '/' '_')"
      sudo mv "$hit" "$dest" && echo "moved $hit"
    done
  done
  # the toolcache keeps whole Node installs that later steps could put back on PATH
  if [ -n "${RUNNER_TOOL_CACHE:-}" ] && [ -d "$RUNNER_TOOL_CACHE/node" ]; then
    sudo mv "$RUNNER_TOOL_CACHE/node" "$QUARANTINE/toolcache-node" && echo "moved $RUNNER_TOOL_CACHE/node"
  fi
  for canonical in /usr/local/bin/node /usr/bin/node /usr/local/bin/pi /usr/bin/pi; do
    if [ -e "$canonical" ] || [ -L "$canonical" ]; then sudo mv "$canonical" "$QUARANTINE/$(printf '%s' "$canonical" | tr '/' '_')" && echo "moved $canonical"; fi
  done
} > "$WORK/quarantine.log" 2>&1
hash -r 2>/dev/null || true
if command -v node >/dev/null 2>&1; then failx "(q) quarantine — node is still reachable: $(command -v node)"; fi
if command -v pi >/dev/null 2>&1; then failx "(q) quarantine — pi is still reachable: $(command -v pi)"; fi
for canonical in /usr/local/bin/node /usr/bin/node; do [ ! -e "$canonical" ] || failx "(q) quarantine — $canonical still exists"; done
pass "(q) quarantine: no node and no pi anywhere on PATH or in the canonical locations ($(grep -c '^moved ' "$WORK/quarantine.log") entries moved; nothing is restored)"

# ------------------------------------------------------------------ (i) ------
say '== (i) install the shipped stage with no Node on the machine'
if sh "$APP/packaging/install.sh" "$STAGE" --prefix "$PREFIX" --applications-dir "$APPS" --project-root "$PROJECT" > "$WORK/install.log" 2>&1 \
   && [ -x "$PREFIX/runtime/node" ] && [ ! -L "$PREFIX/runtime" ] && [ -x "$PREFIX/abito-island-launcher" ]; then
  pass "(i) install: install.sh verified the receipt and the runtime archive and installed into $PREFIX using only the bundled node"
else
  failx "(i) install — install.sh failed or left no $PREFIX/runtime/node"
fi

# ------------------------------------------------------------------ (s) ------
say '== (s) start the installed launcher (GUI-like env, under strace connect())'
smoke_env() {
  env -i PATH=/usr/bin:/bin HOME="$SMOKE_HOME" USER="$(id -un)" LOGNAME="$(id -un)" LANG=C.UTF-8 TZ=UTC \
    TMPDIR="$SMOKE_TMP" DISPLAY=":$DISPLAY_NUM" DBUS_SESSION_BUS_ADDRESS="$DBUS_ADDRESS" XDG_RUNTIME_DIR="$XDG_RUNTIME" \
    XDG_CONFIG_HOME="$WORK/config" XDG_DATA_HOME="$WORK/data" XDG_CACHE_HOME="$WORK/cache" XDG_STATE_HOME="$WORK/state" "$@"
}
DISPLAY_NUM=''; DBUS_ADDRESS=''
n=121
while [ "$n" -le 150 ] && [ -z "$DISPLAY_NUM" ]; do
  Xvfb ":$n" -screen 0 1280x900x24 -nolisten tcp -noreset > "$WORK/xvfb.log" 2>&1 &
  XVFB_PID=$!; sleep 0.5
  if kill -0 "$XVFB_PID" 2>/dev/null; then DISPLAY_NUM=$n; else XVFB_PID=''; n=$((n + 1)); fi
done
[ -n "$DISPLAY_NUM" ] || failx "(s) start — no free Xvfb display in :121-:150"
dbus-daemon --session --nofork --print-address=1 > "$WORK/dbus.log" 2>&1 &
DBUS_PID=$!
wait_for 15 grep -q / "$WORK/dbus.log" || failx "(s) start — the private session bus did not start"
DBUS_ADDRESS=$(head -n 1 "$WORK/dbus.log")
smoke_env openbox --sm-disable > "$WORK/openbox.log" 2>&1 &
WM_PID=$!
EXEC=$(sed -n 's/^Exec=//p' "$APPS/com.abitog.AbitoTauri.desktop")
[ -n "$EXEC" ] || failx "(s) start — no Exec line in the installed .desktop entry"
smoke_env strace -f -qq -s 4096 -e trace=connect,execve -o "$WORK/connect.trace" sh -c "$EXEC" > "$WORK/island.log" 2>&1 &
ISLAND_PID=$!
wait_for 180 grep -q 'abito-island-daemon: running (pid ' "$WORK/island.log" \
  || failx "(s) start — no «abito-island-daemon: running (pid » line: the daemon did not start on the bundled runtime"
if grep -q 'island host: no_daemon' "$WORK/island.log"; then failx "(s) start — the island reported «island host: no_daemon»"; fi
DAEMON_PID=$(sed -n 's/.*abito-island-daemon: running (pid \([0-9]*\)).*/\1/p' "$WORK/island.log" | head -n 1)
[ -n "$DAEMON_PID" ] || failx "(s) start — could not read the daemon pid"
DAEMON_EXE=$(readlink "/proc/$DAEMON_PID/exe" || true)
if [ "$DAEMON_EXE" = "$PREFIX/runtime/node" ]; then
  pass "(s) start: the app-owned daemon (pid $DAEMON_PID) runs on $DAEMON_EXE and reported running after the bundled Pi answered get_state"
else
  failx "(s) start — the daemon runs on «$DAEMON_EXE», expected $PREFIX/runtime/node"
fi

# ------------------------------------------------------------------ (t) ------
say '== (t) installed daemon status, run by the bundled node'
if smoke_env "$PREFIX/runtime/node" "$PREFIX/desktop-daemon/src/cli.cjs" status > "$WORK/status.log" 2>&1 \
   && grep -q '"running":true' "$WORK/status.log"; then
  pass "(t) status: the installed daemon status answers running:true"
else
  failx "(t) status — installed daemon status did not report running"
fi

# ------------------------------------------------------------------ (n) ------
say '== (n) network: every connect() is local (S3: never pi.dev)'
# The window covers Pi's whole start-up: the daemon only reports running after Pi answered get_state, and Pi's own
# version check, model-catalog refresh and telemetry would fire at that start-up. The trace must SHOW Pi ran inside it
# (the bundled node exec-ing Pi's CLI), then the tree is observed PI_CHECK_WINDOW more seconds for anything deferred.
PI_CHECK_WINDOW=20
[ -s "$WORK/connect.trace" ] || failx "(n) network — strace recorded nothing (the trace is not running)"
grep -q "execve(\"$PREFIX/runtime/node\".*pi-coding-agent/dist/bundle/cli.js" "$WORK/connect.trace" \
  || failx "(n) network — the trace shows no execve of the bundled node running Pi's CLI: the window did not cover Pi"
sleep "$PI_CHECK_WINDOW"
kill -0 "$ISLAND_PID" 2>/dev/null || failx "(n) network — the launched tree exited during the observation window"
remote=$(grep 'connect(' "$WORK/connect.trace" | grep -v 'sa_family=AF_UNIX' \
  | grep -v 'sin_addr=inet_addr("127\.' | grep -v 'inet_pton(AF_INET6, "::1"' | grep -v 'sa_family=AF_NETLINK' \
  | grep -v 'sa_family=AF_UNSPEC' || true)
if [ -n "$remote" ]; then
  say "$remote" | head -n 20
  failx "(n) network — the launched tree connected to a non-local address (above)"
fi
if grep -q 'pi\.dev' "$WORK/connect.trace" "$WORK/island.log"; then failx "(n) network — pi.dev appears in the trace or the log"; fi
pass "(n) network: $(grep -c 'connect(' "$WORK/connect.trace") connect() calls, all to local sockets or loopback; none to pi.dev or any other host"

say 'PASS smoke-linux-no-node: installed and ran on the bundled Node + Pi with no Node and no Pi on the machine'
