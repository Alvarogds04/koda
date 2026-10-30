#!/usr/bin/python3
"""Drive the real exported AppIndicator DBusMenu on the PRIVATE bus only."""
import importlib
import json
import os
import re
import sys

Gio = importlib.import_module('gi.repository.Gio')
GLib = importlib.import_module('gi.repository.GLib')

assert os.environ['DISPLAY'].split('.')[0] != ':0'
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
def call(name, obj, iface, method, args=None):
    return bus.call_sync(name, obj, iface, method, args, None, Gio.DBusCallFlags.NONE, 2500, None).unpack()
try:
    names = call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames')[0]
    found = None
    for name in names:
        if not name.startswith(':'):
            continue
        # Discover the real libappindicator-generated object, not a guessed id.
        pending = [('/org', 0)]
        while pending and found is None:
            obj, depth = pending.pop()
            try:
                xml = call(name, obj, 'org.freedesktop.DBus.Introspectable', 'Introspect')[0]
                if re.search(r'<interface name="com\.canonical\.dbusmenu"', xml):
                    layout = call(name, obj, 'com.canonical.dbusmenu', 'GetLayout', GLib.Variant('(iias)', (0, -1, [])))[1]
                    found = (name, obj, layout)
                elif depth < 6:
                    pending.extend((obj + '/' + child, depth + 1) for child in re.findall(r'<node name="([A-Za-z0-9_]+)"', xml))
            except GLib.Error:
                pass
        if found:
            break
    if found is None:
        raise RuntimeError('no se encontró el DBusMenu real de Abito')
    name, obj, layout = found
    rows = []
    def visit(node):
        ident, props, children = node
        rows.append((ident, props.get('label', '')))
        for child in children:
            visit(child)
    visit(layout)
    labels = [label.replace('_', '') for _, label in rows]
    expected = ['Mostrar Koda', 'Ocultar', 'Arrancar al iniciar sesión', 'Salir']
    assert all(x in labels for x in expected), labels
    if len(sys.argv) > 1:
        target = {'hide':'Ocultar', 'show':'Mostrar Koda', 'autostart':'Arrancar al iniciar sesión'}[sys.argv[1]]
        ident = next(i for i, label in rows if label.replace('_','') == target)
        call(name, obj, 'com.canonical.dbusmenu', 'Event', GLib.Variant('(isvu)', (ident, 'clicked', GLib.Variant('i', 0), 0)))
    print(json.dumps({'ok':True,'labels':labels,'action':sys.argv[1:] }))
except Exception as e:
    print(json.dumps({'ok':False,'reason':str(e)}))
