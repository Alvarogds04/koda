# Integration validator fixture

`integrations.cjs` serves deterministic JSON on 127.0.0.1 only. The native probe
maps every poll to this origin with fixture-only keys. `xdg-open` records targets
inside the private HOME and does not launch a browser. No production service is
called by the integration scene.
