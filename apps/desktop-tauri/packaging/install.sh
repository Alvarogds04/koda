#!/bin/sh
# Abito (Tauri) — one-command user install of a STAGED build (M4 format A).
#
#   sh install.sh <stage-dir> [--prefix DIR] [--project-root DIR] [--applications-dir DIR]
#   sh install.sh --uninstall [--prefix DIR] [--applications-dir DIR]
#
# <stage-dir> is what packaging/build.cjs stages (dist/abito-island/<version>) or a
# copy of it (artifacts/abito-island-<version>-<commit>). POSIX sh, no dependencies
# beyond Node (PATH then /usr/bin/node), coreutils + sha256sum (or shasum).
# Keep install.sh beside lib.cjs. No root, no network.
#
# Order of work (nothing is touched until step 1 passes):
#   1. VERIFY: receipt.json is read and EVERY file is re-hashed against it; the
#      stage must hold exactly the expected files (no extras, no symlinks), the
#      receipt must name this app's identity, a git HEAD and a clean tree.
#   2. Install binary, launcher, icon (+ the .desktop template and receipt.json, so
#      the installed copy can be re-verified with packaging/verify.cjs) into
#      PREFIX; each file lands via temp-file + rename, so a RUNNING binary can be
#      replaced and an interrupted install never leaves a half-written file.
#   3. Write ~/.local/share/applications/com.abitog.AbitoTauri.desktop with
#      @INSTALL_DIR@ resolved and Exec=env ABITO_PROJECT_ROOT=<project root> "<launcher>"
#      (the one variable the closed launcher accepts).
#
# Defaults (documented):
#   PREFIX        $XDG_DATA_HOME/abito-island, i.e. ~/.local/share/abito-island
#   APPLICATIONS  $XDG_DATA_HOME/applications, i.e. ~/.local/share/applications
#   PROJECT ROOT  required: --project-root DIR (the folder your agent sessions run in;
#                 the island derives its project id from this directory).
#
# Idempotent: reinstalling over itself (or from the installed dir) is a no-op that
# succeeds. --uninstall removes exactly the installed files and the .desktop, and
# the install dir only when it is then empty. It never touches the Preview or
# com.abitog.Abito roots.
set -eu
umask 022

ID="com.abitog.AbitoTauri"
DESKTOP="$ID.desktop"
# Node is also the installed host runtime. PATH first, canonical fallback only.
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { [ ! -x /usr/bin/node ] || NODE=/usr/bin/node; }
[ -n "$NODE" ] || { echo 'install.sh: node missing (PATH, /usr/bin/node)' >&2; exit 1; }
LIB="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/lib.cjs"
FILES="$("$NODE" -e 'process.stdout.write(require(process.argv[1]).STAGED.join(" "))' "$LIB")"
EXEC_FILES="abito-island abito-island-launcher"

die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }
note() { printf '%s\n' "$*"; }

usage() {
  cat <<'USAGE'
Abito (Tauri) one-command installer (user-local, no root, no network).

  sh install.sh <stage-dir> [--prefix DIR] [--project-root DIR] [--applications-dir DIR]
  sh install.sh --uninstall [--prefix DIR] [--applications-dir DIR]

  <stage-dir>           staged build: dist/abito-island/<version> or a copy of it
                        (artifacts/abito-island-<version>-<commit>)
  --prefix DIR          install dir (default: ~/.local/share/abito-island)
  --project-root DIR    (required) ABITO_PROJECT_ROOT written into the launcher entry:
                        the folder your agent sessions run in
  --applications-dir D  where the .desktop goes (default: ~/.local/share/applications)
  --uninstall           remove the installed files and the .desktop entry
  -h, --help            this text

Node (PATH then /usr/bin/node) and the sibling lib.cjs are required.
Every shipped file, including desktop-daemon/src, is recursively re-hashed
against receipt.json BEFORE anything is installed; no symlinks or extras. Any
mismatch aborts without touching the system. Reinstalling is safe (idempotent).
USAGE
}

# ---- arguments ---------------------------------------------------------------
[ -n "${HOME:-}" ] || die "HOME is not set"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
PREFIX="$DATA_HOME/abito-island"
APPS="$DATA_HOME/applications"
ROOT=""
STAGE=""
UNINSTALL=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --uninstall) UNINSTALL=1 ;;
    --prefix) [ "$#" -ge 2 ] || die "--prefix needs a directory"; PREFIX="$2"; shift ;;
    --project-root) [ "$#" -ge 2 ] || die "--project-root needs a directory"; ROOT="$2"; shift ;;
    --applications-dir) [ "$#" -ge 2 ] || die "--applications-dir needs a directory"; APPS="$2"; shift ;;
    -*) die "unknown option: $1 (see --help)" ;;
    *) [ -z "$STAGE" ] || die "only one stage directory is accepted"; STAGE="$1" ;;
  esac
  shift
done

# ---- path safety (these strings end up inside a .desktop Exec line) ---------------
# Absolute, normalized, only [A-Za-z0-9_./-]: no spaces, quotes, %, $, backticks,
# backslashes, '|' or '&', so nothing needs escaping in sed or in the Exec field.
safe_path() {
  case "$1" in /*) ;; *) return 1 ;; esac
  case "$1" in *[!A-Za-z0-9_./-]*) return 1 ;; esac
  case "$1" in *//*|*/./*|*/../*|*/.|*/..|*/) return 1 ;; esac
  [ "$1" != "/" ]
}
# The installed Electron apps' identities and runtime roots are never ours.
not_foreign() {
  case "$1" in
    *com.abitog.Abito|*com.abitog.Abito/*|*com.abitog.Abito.*|*abito-desktop*|*.var/app*) return 1 ;;
  esac
}
check_dir_arg() { # name value
  safe_path "$2" || die "$1 must be an absolute, normalized path made of [A-Za-z0-9_./-]: $2"
  not_foreign "$2" || die "$1 points at an installed Abito/Preview root, refusing: $2"
}
check_dir_arg "--prefix" "$PREFIX"
check_dir_arg "--applications-dir" "$APPS"
[ "$PREFIX" != "$HOME" ] || die "--prefix must not be your home directory"
[ "$PREFIX" != "$APPS" ] || die "--prefix and --applications-dir must differ"

sha_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else die "sha256sum (or shasum) is required to verify the stage"
  fi
}

refresh_desktop_db() {
  if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database "$APPS" >/dev/null 2>&1 || true; fi
}

# ---- uninstall ------------------------------------------------------------------------
if [ "$UNINSTALL" -eq 1 ]; then
  [ -z "$STAGE" ] || die "--uninstall takes no stage directory"
  removed=""
  for f in $FILES receipt.json; do
    if [ -e "$PREFIX/$f" ] || [ -L "$PREFIX/$f" ]; then rm -f "$PREFIX/$f"; removed="$removed $f"; fi
  done
  if [ -e "$APPS/$DESKTOP" ] || [ -L "$APPS/$DESKTOP" ]; then rm -f "$APPS/$DESKTOP"; removed="$removed $DESKTOP(applications)"; fi
  rmdir "$PREFIX/desktop-daemon/src" "$PREFIX/desktop-daemon" "$PREFIX/desktop-harness/bin" "$PREFIX/desktop-harness/src" "$PREFIX/desktop-harness" "$PREFIX/desktop-pi" "$PREFIX" 2>/dev/null || true
  refresh_desktop_db
  if [ -n "$removed" ]; then note "Removed:$removed"; else note "Nothing to remove (not installed under $PREFIX)."; fi
  if [ -d "$PREFIX" ]; then note "Kept $PREFIX: it still holds files that are not ours."; fi
  note "The installed Abito/Preview apps were not touched."
  exit 0
fi

# ---- 1. VERIFY FIRST --------------------------------------------------------------------
[ -n "$STAGE" ] || { usage >&2; exit 2; }
[ -n "$ROOT" ] || die "--project-root DIR is required (the folder your agent sessions run in)"
safe_path "$ROOT" || die "--project-root must be an absolute, normalized path made of [A-Za-z0-9_./-]: $ROOT"
[ -d "$ROOT" ] || die "--project-root is not a directory: $ROOT (pass --project-root DIR)"
[ -d "$STAGE" ] && [ ! -L "$STAGE" ] || die "stage is not a directory: $STAGE"
STAGE="$(cd "$STAGE" && pwd -P)"
RECEIPT="$STAGE/receipt.json"
[ -f "$RECEIPT" ] && [ ! -L "$RECEIPT" ] || die "no receipt.json in $STAGE"

# Recursive, closed-set verification; no symlinks, including empty extra dirs.
"$NODE" -e 'const L=require(process.argv[1]); const p=L.verifyStage(process.argv[2]); if(p.length){console.error(p.join("\n"));process.exit(1)}' "$LIB" "$STAGE" || die "stage verification failed: nothing was installed"

grep -q "^  \"identifier\": \"$ID\",\$" "$RECEIPT" || die "receipt identifier is not $ID"
grep -q '^    "head": "[0-9a-f]\{40\}",$' "$RECEIPT" || die "receipt carries no git HEAD"
grep -q '^    "clean": true,$' "$RECEIPT" || die "receipt does not attest a clean tree"

# the "files" block: one `"name": "sha256"` line per file, nothing else
block="$(awk '/^  "files": \{$/{f=1;next} f&&/^  \}/{f=0} f' "$RECEIPT")"
[ -n "$block" ] || die "receipt has no files block"
parsed="$(printf '%s\n' "$block" | sed -n 's/^    "\([^"]*\)": "\([0-9a-f]\{64\}\)",\{0,1\}$/\1 \2/p')"
[ "$(printf '%s\n' "$block" | wc -l)" -eq "$(printf '%s\n' "$parsed" | wc -l)" ] || die "receipt files block is malformed"
[ "$(printf '%s\n' "$parsed" | wc -l)" -eq "$(printf '%s\n' $FILES | wc -l)" ] || die "receipt lists a different set of files"
for f in $FILES; do
  want="$(printf '%s\n' "$parsed" | sed -n "s|^$(printf '%s' "$f" | sed 's/[.]/\\./g') \\([0-9a-f]\\{64\\}\\)\$|\\1|p")"
  [ -n "$want" ] || die "receipt has no hash for $f"
  got="$(sha_of "$STAGE/$f")"
  [ "$got" = "$want" ] || die "HASH MISMATCH for $f (receipt $want, file $got): nothing was installed"
done
note "Stage verified against receipt.json ($STAGE)."
# Applications may contain unrelated desktop entries, so validate its ancestor
# chain only; PREFIX must not contain any undeclared installed entry.
"$NODE" -e 'const L=require(process.argv[1]);const fs=require("node:fs"),path=require("node:path");const p=L.checkInstalledLayout(process.argv[2]);for(let d=path.resolve(process.argv[3]);;d=path.dirname(d)){try{if(fs.lstatSync(d).isSymbolicLink())p.push(d+" is a symlink")}catch(e){if(e.code!=="ENOENT")throw e}if(path.dirname(d)===d)break}if(p.length){console.error(p.join("\n"));process.exit(1)}' "$LIB" "$PREFIX" "$APPS" || die "unsafe installed layout: nothing was installed"

# ---- 2. stage everything in temp files next to the targets, re-verify, then rename -----------
TMP_SUFFIX=".new.$$"
cleanup() {
  for f in $FILES receipt.json; do rm -f "$PREFIX/$f$TMP_SUFFIX" 2>/dev/null || true; done
  rm -f "$APPS/.new.$$.$DESKTOP" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# the .desktop is generated and validated BEFORE any file is replaced
mkdir -p "$PREFIX" "$APPS"
sed -e "s|^Exec=.*|Exec=env ABITO_PROJECT_ROOT=$ROOT \"$PREFIX/abito-island-launcher\"|" \
    -e "s|@INSTALL_DIR@|$PREFIX|g" "$STAGE/$DESKTOP" > "$APPS/.new.$$.$DESKTOP"
if grep -q '@INSTALL_DIR@' "$APPS/.new.$$.$DESKTOP"; then die "unresolved @INSTALL_DIR@ in the .desktop"; fi
if command -v desktop-file-validate >/dev/null 2>&1; then
  desktop-file-validate "$APPS/.new.$$.$DESKTOP" || die "the generated .desktop is not valid"
fi

for f in $FILES receipt.json; do
  mkdir -p "$(dirname "$PREFIX/$f")"
  cp "$STAGE/$f" "$PREFIX/$f$TMP_SUFFIX"
  case " $EXEC_FILES " in *" $f "*) chmod 755 "$PREFIX/$f$TMP_SUFFIX" ;; *) chmod 644 "$PREFIX/$f$TMP_SUFFIX" ;; esac
done
# TOCTOU guard: what was copied is what the receipt names
for f in $FILES; do
  want="$(printf '%s\n' "$parsed" | sed -n "s|^$(printf '%s' "$f" | sed 's/[.]/\\./g') \\([0-9a-f]\\{64\\}\\)\$|\\1|p")"
  [ "$(sha_of "$PREFIX/$f$TMP_SUFFIX")" = "$want" ] || die "the copy of $f changed while installing: aborting before replacing anything"
done
chmod 644 "$APPS/.new.$$.$DESKTOP"

for f in $FILES receipt.json; do mv -f "$PREFIX/$f$TMP_SUFFIX" "$PREFIX/$f"; done
mv -f "$APPS/.new.$$.$DESKTOP" "$APPS/$DESKTOP"
refresh_desktop_db

# ---- 3. report ----------------------------------------------------------------------------------
note ""
note "Installed Abito (Tauri) in $PREFIX"
for f in $FILES; do printf '  %-34s %s\n' "$f" "$(sha_of "$PREFIX/$f")"; done
note "  (+ receipt.json, so the install can be re-verified with packaging/verify.cjs)"
note "Menu entry: $APPS/$DESKTOP  — «Abito (Tauri)»"
note "Project root: $ROOT"
note ""
note "Launch:"
note "  from the app menu: Abito (Tauri)"
note "  from a terminal:   ABITO_PROJECT_ROOT=$ROOT $PREFIX/abito-island-launcher"
note "  (the launcher takes no arguments and refuses every other ABITO_* variable)"
note "Reinstall: run this command again. Uninstall: sh install.sh --uninstall"
note "The installed Abito/Preview apps were not touched."
