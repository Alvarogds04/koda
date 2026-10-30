# Abito icon sources

Abito's application icon is Koda's face on the notch-black rounded tile (HU-074, design
`design/hu-074-icono-koda/01-cara-fondo-negro.html`). It is generated, never edited by hand:

    python3 icons/src/make-koda-icons.py          # from apps/desktop-tauri, needs Pillow
    python3 icons/src/make-koda-icons.py --check  # exit 1 if a committed icon is stale

The input is the sheet the island animates, `frontend/koda/koda-chibi-32.png`, at the `respirar`
row read from `frontend/koda-catalog.js`, frame 0. The head is scaled with nearest-neighbour at an
integer factor, so the pixel art stays sharp. Outputs:

- `icons/icon.icns`: macOS .app, 16–512 plus @2x (up to 1024), with Apple's ~80/1024 margin.
- `icons/icon-macos.png`: 512×512 preview of the macOS variant.
- `icons/icon.png`: 256×256 full-bleed tile (Linux launcher and window icon).
- `icons/icon.ico`: 16, 24, 32, 48, 64, 128 and 256 px full-bleed tile (Windows exe and installer).

The tray keeps its own state glyphs (`src/tray.rs`, HU-056); these files are the application icon only.
