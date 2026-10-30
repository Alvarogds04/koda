#!/bin/sh
# Copies Abito's window-context extension into the user's GNOME Shell extensions folder.
# It does NOT enable it: that is your decision (see docs/desktop/context-extension.md).
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
uuid=abito-context@abito
dest="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$uuid"
mkdir -p "$dest"
cp "$here/$uuid/metadata.json" "$here/$uuid/extension.js" "$dest/"
echo "Copied to $dest"
echo "To turn it on:  gnome-extensions enable $uuid   (on Wayland, log out and in once after the first copy)"
echo "To remove it:   gnome-extensions disable $uuid && rm -r '$dest'"
