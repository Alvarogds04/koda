#!/bin/sh
# Abito (Tauri) — one-command user install of a STAGED build (M4 format A).
#
#   sh install.sh <stage-dir> [--prefix DIR] [--project-root DIR] [--applications-dir DIR]
#   sh install.sh --uninstall [--prefix DIR] [--applications-dir DIR]
#
# <stage-dir> is what packaging/build.cjs stages (dist/abito-island/<version>) or a
# copy of it (artifacts/abito-island-<version>-<commit>). POSIX sh; coreutils +
# tar + sha256sum (or shasum). Keep install.sh beside lib.cjs. No root, no network.
# NO NODE IS REQUIRED, USED OR LOOKED UP on the machine (K2-02, decision A): the
# stage carries the bundled runtime archive (koda-runtime-linux-x64.tar.gz) and the
# `node` extracted from it is what runs the closed-set verification and the host.
#
# Order of work (nothing is replaced until every step passes):
#   1. VERIFY STAGE: receipt.json is parsed in pure sh and EVERY file it lists —
#      including the runtime archive — is re-hashed against it; the receipt must
#      name this app's identity, a git HEAD and a clean tree.
#   2. VERIFY RUNTIME ARCHIVE MEMBERS: `tar -tzf` (names) + `tar -tvzf` (types) list every member; any
#      absolute path, any «..» component and any non-regular/non-directory member
#      (symlink, hardlink, device, fifo) is refused BEFORE extracting anything.
#   3. EXTRACT the runtime into a private (0700) temp dir on the same filesystem
#      as PREFIX (its parent), then use THAT node — never a system Node — to run
#      the lib.cjs closed-set verification (verifyStage + checkInstalledLayout).
#   4. INSTALL binary, launcher, icon, daemon, harness, Pi payload (+ the .desktop
#      template and receipt.json) via temp-file + re-hash + rename, so a RUNNING
#      binary can be replaced and an interrupted install never leaves a half-written
#      file; the extracted runtime moves into place as PREFIX/runtime by atomic
#      rename (an old runtime is moved aside, then removed). On any failure nothing
#      is replaced and every temp dir is removed.
#   5. Write ~/.local/share/applications/com.abitog.AbitoTauri.desktop with
#      @INSTALL_DIR@ resolved and Exec=env ABITO_PROJECT_ROOT=<project root> "<launcher>"
#      (the one variable the closed launcher accepts).
#
# Defaults (documented):
#   PREFIX        $XDG_DATA_HOME/abito-island, i.e. ~/.local/share/abito-island
#   APPLICATIONS  $XDG_DATA_HOME/applications, i.e. ~/.local/share/applications
#   PROJECT ROOT  required: --project-root DIR (the folder your agent sessions run in;
#                 the island derives its project id from this directory).
#
# Idempotent: reinstalling over itself is a no-op that succeeds. --uninstall removes
# exactly the installed files, PREFIX/runtime (only when it is a REAL directory
# directly inside PREFIX — a symlink is left alone) and the .desktop, and the install
# dir only when it is then empty. It never touches the Preview or com.abitog.Abito roots.
set -eu
umask 022

ID="com.abitog.AbitoTauri"
DESKTOP="$ID.desktop"
RUNTIME_ARCHIVE="koda-runtime-linux-x64.tar.gz"
# Closed-set verifier beside this script; run by the EXTRACTED runtime's node.
LIB="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)/lib.cjs"
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
  --uninstall           remove the installed files, PREFIX/runtime and the .desktop entry
  -h, --help            this text

No Node is required on the machine: the stage ships the bundled runtime archive
(koda-runtime-linux-x64.tar.gz). Its sha256 is verified against receipt.json, its
tar members are audited (no absolute paths, no «..», no symlinks/hardlinks/devices),
it is extracted into a private 0700 temp dir, and the extracted `node` is what runs
the closed-set verification. Every shipped file is re-hashed BEFORE anything is
installed; no symlinks or extras. Any mismatch aborts without touching the system.
Reinstalling is safe (idempotent).
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

# ---- temp paths and cleanup (same filesystem as PREFIX: atomic renames) -------------
TMP_SUFFIX=".new.$$"
TMPBASE="$(dirname "$PREFIX")"
RUNTIME_TMP="$TMPBASE/.runtime.new.$$"
RUNTIME_OLD="$TMPBASE/.runtime.old.$$"
cleanup() {
  trap - EXIT INT TERM
  if [ -d "$RUNTIME_TMP" ]; then rm -rf "$RUNTIME_TMP"; fi
  # a crash after the old runtime was moved aside but before the new one moved in:
  # put the old one back, nothing is lost.
  if [ -d "$RUNTIME_OLD" ]; then mv "$RUNTIME_OLD" "$PREFIX/runtime" 2>/dev/null || true; fi
  for f in ${INSTALL_FILES:-} receipt.json; do rm -f "$PREFIX/$f$TMP_SUFFIX" 2>/dev/null || true; done
  rm -f "$APPS/.new.$$.$DESKTOP" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ---- uninstall ------------------------------------------------------------------------
if [ "$UNINSTALL" -eq 1 ]; then
  [ -z "$STAGE" ] || die "--uninstall takes no stage directory"
  # The file list comes from the bundled runtime's node, or from the installed
  # receipt; without either, only what is surely ours is removed.
  UN_FILES=""
  if [ -d "$PREFIX/runtime" ] && [ ! -L "$PREFIX/runtime" ] && [ -f "$PREFIX/runtime/node" ] && [ ! -L "$PREFIX/runtime/node" ]; then
    UN_FILES="$("$PREFIX/runtime/node" -e 'process.stdout.write(require(process.argv[1]).STAGED.join(" "))' "$LIB" 2>/dev/null)" || UN_FILES=""
  elif [ -f "$PREFIX/receipt.json" ] && [ ! -L "$PREFIX/receipt.json" ]; then
    UN_FILES="$(awk '/^  "files": \{$/{f=1;next} f&&/^  \}/{f=0} f' "$PREFIX/receipt.json" | sed -n 's/^    "\([^"]*\)": "\([0-9a-f]\{64\}\)",\{0,1\}$/\1/p')" || UN_FILES=""
  fi
  removed=""
  for f in $UN_FILES receipt.json; do
    if [ -e "$PREFIX/$f" ] || [ -L "$PREFIX/$f" ]; then rm -f "$PREFIX/$f"; removed="$removed $f"; fi
  done
  if [ -e "$APPS/$DESKTOP" ] || [ -L "$APPS/$DESKTOP" ]; then rm -f "$APPS/$DESKTOP"; removed="$removed $DESKTOP(applications)"; fi
  # PREFIX/runtime is removed only when it is a REAL directory directly inside PREFIX.
  if [ -d "$PREFIX/runtime" ] && [ ! -L "$PREFIX/runtime" ]; then
    rm -rf "$PREFIX/runtime"
    removed="$removed runtime/"
  elif [ -L "$PREFIX/runtime" ]; then
    note "Kept $PREFIX/runtime: it is a symlink, not ours to remove."
  fi
  rmdir "$PREFIX/desktop-daemon/src" "$PREFIX/desktop-daemon" "$PREFIX/desktop-harness/bin" "$PREFIX/desktop-harness/src" "$PREFIX/desktop-harness" "$PREFIX/desktop-pi" "$PREFIX" 2>/dev/null || true
  refresh_desktop_db
  if [ -n "$removed" ]; then note "Removed:$removed"; else note "Nothing to remove (not installed under $PREFIX)."; fi
  if [ -d "$PREFIX" ]; then note "Kept $PREFIX: it still holds files that are not ours."; fi
  note "The installed Abito/Preview apps were not touched."
  exit 0
fi

# ---- 1. VERIFY FIRST --------------------------------------------------------------------
for tool in tar awk sed grep cut wc; do
  command -v "$tool" >/dev/null 2>&1 || die "required tool missing: $tool (also needed: sha256sum or shasum)"
done
[ -n "$STAGE" ] || { usage >&2; exit 2; }
[ -n "$ROOT" ] || die "--project-root DIR is required (the folder your agent sessions run in)"
safe_path "$ROOT" || die "--project-root must be an absolute, normalized path made of [A-Za-z0-9_./-]: $ROOT"
[ -d "$ROOT" ] || die "--project-root is not a directory: $ROOT (pass --project-root DIR)"
[ -d "$STAGE" ] && [ ! -L "$STAGE" ] || die "stage is not a directory: $STAGE"
STAGE="$(cd "$STAGE" && pwd -P)"
RECEIPT="$STAGE/receipt.json"
[ -f "$RECEIPT" ] && [ ! -L "$RECEIPT" ] || die "no receipt.json in $STAGE"

grep -q "^  \"identifier\": \"$ID\",\$" "$RECEIPT" || die "receipt identifier is not $ID"
grep -q '^    "head": "[0-9a-f]\{40\}",$' "$RECEIPT" || die "receipt carries no git HEAD"
grep -q '^    "clean": true,$' "$RECEIPT" || die "receipt does not attest a clean tree"

# the "files" block: one `"name": "sha256"` line per file, nothing else
block="$(awk '/^  "files": \{$/{f=1;next} f&&/^  \}/{f=0} f' "$RECEIPT")"
[ -n "$block" ] || die "receipt has no files block"
parsed="$(printf '%s\n' "$block" | sed -n 's/^    "\([^"]*\)": "\([0-9a-f]\{64\}\)",\{0,1\}$/\1 \2/p')"
[ "$(printf '%s\n' "$block" | wc -l)" -eq "$(printf '%s\n' "$parsed" | wc -l)" ] || die "receipt files block is malformed"
names="$(printf '%s\n' "$parsed" | cut -d' ' -f1)"
[ -n "$names" ] || die "receipt lists no files"

# every file the receipt names — the runtime archive included — is hashed here
for f in $names; do
  want="$(printf '%s\n' "$parsed" | sed -n "s|^$(printf '%s' "$f" | sed 's/[.]/\\./g') \\([0-9a-f]\\{64\\}\\)\$|\\1|p")"
  [ -n "$want" ] || die "receipt has no hash for $f"
  [ -f "$STAGE/$f" ] && [ ! -L "$STAGE/$f" ] || die "$f is missing from the stage (or is not a regular file)"
  got="$(sha_of "$STAGE/$f")"
  [ "$got" = "$want" ] || die "HASH MISMATCH for $f (receipt $want, file $got): nothing was installed"
done
ARCHIVE_WANT="$(printf '%s\n' "$parsed" | sed -n "s|^$RUNTIME_ARCHIVE \([0-9a-f]\{64\}\)\$|\1|p")"
[ -n "$ARCHIVE_WANT" ] || die "receipt has no hash for $RUNTIME_ARCHIVE (this installer requires the bundled runtime archive)"

note "Stage verified against receipt.json ($STAGE)."

# ---- 2. runtime archive members: refuse anything but regular files and dirs --------------
# Tar-agnostic (GNU tar on Linux, bsdtar on macOS): member NAMES come from `tar -tzf` (one per line, the same on both),
# member TYPES from the first character of each `tar -tvzf` line (the mode string, the same on both). Never parse the
# -tv columns: their number differs between tars (GNU 5 before the name, bsdtar 8).
names_list="$(tar -tzf "$STAGE/$RUNTIME_ARCHIVE" 2>/dev/null)" || die "cannot list the runtime archive $RUNTIME_ARCHIVE (corrupt, or tar is missing)"
types_list="$(tar -tvzf "$STAGE/$RUNTIME_ARCHIVE" 2>/dev/null | cut -c1)" || die "cannot list the runtime archive $RUNTIME_ARCHIVE (corrupt, or tar is missing)"
[ -n "$names_list" ] || die "the runtime archive $RUNTIME_ARCHIVE is empty"
# Pair each name with its type in ONE linear pass (awk walks the names once; the types are one string, one char per
# member), then audit the pairs in a single loop: linear in the member count (~16 000 for the real runtime).
types="$(printf '%s\n' "$types_list" | tr -d '\n')"
pairs="$(printf '%s\n' "$names_list" | awk -v types="$types" '{ printf "%s %s\n", substr(types, NR, 1), $0 } END { if (NR != length(types)) exit 3 }')" \
  || die "the runtime archive $RUNTIME_ARCHIVE has member names that tar cannot list one per line"
while IFS= read -r pair; do
  first=${pair%"${pair#?}"}
  member=${pair#??}
  case "$first" in
    -|d) ;; # regular file or directory
    *) die "refusing runtime archive member «$member»: not a regular file or directory (symlink/hardlink/device/fifo)" ;;
  esac
  case "$member" in
    /*) die "refusing runtime archive member «$member»: absolute member paths are not allowed" ;;
  esac
  comp=${member#./}
  case "$comp" in
    ..|../*|*/..|*/../*) die "refusing runtime archive member «$member»: «..» components are not allowed" ;;
  esac
  case "$member" in
    .|./|./*) ;; # members are relative to the runtime root (as build-runtime.cjs packs them)
    *) die "refusing runtime archive member «$member»: not relative to the runtime root" ;;
  esac
done <<MEMBERS
$pairs
MEMBERS

# ---- 3. extract into a private temp dir, then verify with THAT node ----------------------
mkdir -p "$TMPBASE" || die "cannot create $TMPBASE"
mkdir -m 700 "$RUNTIME_TMP" || die "cannot create the private runtime temp dir: $RUNTIME_TMP"
got="$(sha_of "$STAGE/$RUNTIME_ARCHIVE")"
[ "$got" = "$ARCHIVE_WANT" ] || die "the runtime archive changed while installing: aborting before extracting anything"
tar -xzf "$STAGE/$RUNTIME_ARCHIVE" -C "$RUNTIME_TMP" || die "cannot extract the runtime archive into $RUNTIME_TMP"
[ -f "$RUNTIME_TMP/node" ] && [ ! -L "$RUNTIME_TMP/node" ] || die "the runtime archive holds no regular node binary"
[ -x "$RUNTIME_TMP/node" ] || die "the extracted node is not executable"

"$RUNTIME_TMP/node" -e 'const L=require(process.argv[1]); const p=L.verifyStage(process.argv[2]); if(p.length){console.error(p.join("\n"));process.exit(1)}' "$LIB" "$STAGE" || die "stage verification failed: nothing was installed"
# Applications may contain unrelated desktop entries, so validate its ancestor
# chain only; PREFIX must not contain any undeclared installed entry (runtime/ aside).
"$RUNTIME_TMP/node" -e 'const L=require(process.argv[1]);const fs=require("node:fs"),path=require("node:path");const p=L.checkInstalledLayout(process.argv[2]);for(let d=path.resolve(process.argv[3]);;d=path.dirname(d)){try{if(fs.lstatSync(d).isSymbolicLink())p.push(d+" is a symlink")}catch(e){if(e.code!=="ENOENT")throw e}if(path.dirname(d)===d)break}if(p.length){console.error(p.join("\n"));process.exit(1)}' "$LIB" "$PREFIX" "$APPS" || die "unsafe installed layout: nothing was installed"

# the closed set is now proven: the receipt names exactly lib.cjs' STAGED files
INSTALL_FILES=""
for f in $names; do [ "$f" = "$RUNTIME_ARCHIVE" ] || INSTALL_FILES="$INSTALL_FILES $f"; done

# ---- 4. stage everything in temp files next to the targets, re-verify, then rename -----------
# the .desktop is generated and validated BEFORE any file is replaced
mkdir -p "$PREFIX" "$APPS"
sed -e "s|^Exec=.*|Exec=env ABITO_PROJECT_ROOT=$ROOT \"$PREFIX/abito-island-launcher\"|" \
    -e "s|@INSTALL_DIR@|$PREFIX|g" "$STAGE/$DESKTOP" > "$APPS/.new.$$.$DESKTOP"
if grep -q '@INSTALL_DIR@' "$APPS/.new.$$.$DESKTOP"; then die "unresolved @INSTALL_DIR@ in the .desktop"; fi
if command -v desktop-file-validate >/dev/null 2>&1; then
  desktop-file-validate "$APPS/.new.$$.$DESKTOP" || die "the generated .desktop is not valid"
fi

for f in $INSTALL_FILES receipt.json; do
  mkdir -p "$(dirname "$PREFIX/$f")"
  cp "$STAGE/$f" "$PREFIX/$f$TMP_SUFFIX"
  case " $EXEC_FILES " in *" $f "*) chmod 755 "$PREFIX/$f$TMP_SUFFIX" ;; *) chmod 644 "$PREFIX/$f$TMP_SUFFIX" ;; esac
done
# TOCTOU guard: what was copied is what the receipt names
for f in $INSTALL_FILES; do
  want="$(printf '%s\n' "$parsed" | sed -n "s|^$(printf '%s' "$f" | sed 's/[.]/\\./g') \\([0-9a-f]\\{64\\}\\)\$|\\1|p")"
  [ "$(sha_of "$PREFIX/$f$TMP_SUFFIX")" = "$want" ] || die "the copy of $f changed while installing: aborting before replacing anything"
done
chmod 644 "$APPS/.new.$$.$DESKTOP"

for f in $INSTALL_FILES receipt.json; do mv -f "$PREFIX/$f$TMP_SUFFIX" "$PREFIX/$f"; done
mv -f "$APPS/.new.$$.$DESKTOP" "$APPS/$DESKTOP"
refresh_desktop_db

# the runtime: atomic rename into place (an old runtime is moved aside, then removed)
if [ -e "$PREFIX/runtime" ] || [ -L "$PREFIX/runtime" ]; then
  if [ -d "$PREFIX/runtime" ] && [ ! -L "$PREFIX/runtime" ]; then
    mv "$PREFIX/runtime" "$RUNTIME_OLD" || die "cannot move the old $PREFIX/runtime aside"
  else
    die "$PREFIX/runtime exists and is not a real directory; refusing to replace it"
  fi
fi
mv "$RUNTIME_TMP" "$PREFIX/runtime" || die "cannot move the extracted runtime into $PREFIX/runtime"
if [ -d "$RUNTIME_OLD" ]; then rm -rf "$RUNTIME_OLD"; fi

# ---- 5. report ----------------------------------------------------------------------------------
note ""
note "Installed Abito (Tauri) in $PREFIX"
for f in $INSTALL_FILES; do printf '  %-34s %s\n' "$f" "$(sha_of "$PREFIX/$f")"; done
note "  (+ receipt.json; runtime/ holds the bundled Node + Pi extracted from the verified $RUNTIME_ARCHIVE)"
note "Menu entry: $APPS/$DESKTOP  — «Abito (Tauri)»"
note "Project root: $ROOT"
note ""
note "Launch:"
note "  from the app menu: Abito (Tauri)"
note "  from a terminal:   ABITO_PROJECT_ROOT=$ROOT $PREFIX/abito-island-launcher"
note "  (the launcher takes no arguments and refuses every other ABITO_* variable)"
note "Reinstall: run this command again. Uninstall: sh install.sh --uninstall"
note "The installed Abito/Preview apps were not touched."
