#!/bin/sh
# Abito island launcher (M1a).
#
# GTK/Tao on Wayland cannot position a window absolutely nor keep it
# always-on-top, so the island must run on X11/XWayland. Forcing GDK_BACKEND
# here (and again inside main() when unset) is the heavy constraint of this
# migration — same idea as the Electron preview's --ozone-platform=x11.
set -eu
cd "$(dirname "$0")"
export GDK_BACKEND=x11
exec cargo run -- "$@"
