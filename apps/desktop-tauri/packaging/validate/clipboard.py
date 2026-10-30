#!/usr/bin/python3
"""Private Xvfb clipboard owner, used in place of wl-copy by the validator only."""
import importlib
import os
import sys

import gi

gi.require_version('Gtk', '3.0')
Gtk = importlib.import_module('gi.repository.Gtk')
Gdk = importlib.import_module('gi.repository.Gdk')

if not os.environ.get('DISPLAY', '').startswith(':') or os.environ['DISPLAY'].split('.')[0] == ':0':
    raise SystemExit('private nonzero DISPLAY required')
if '--read' in sys.argv:
    clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
    sys.stdout.write(clipboard.wait_for_text() or '')
else:
    text = sys.stdin.read()
    read, write = os.pipe()
    if os.fork():
        os.close(write)
        if os.read(read, 1) != b'1':
            raise SystemExit(1)
    else:
        os.close(read)
        clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
        clipboard.set_text(text, -1)
        while Gtk.events_pending():
            Gtk.main_iteration()
        os.write(write, b'1')
        os.close(write)
        clipboard.connect('owner-change', lambda board, event: Gtk.main_quit() if event.owner is None else None)
        Gtk.main()
