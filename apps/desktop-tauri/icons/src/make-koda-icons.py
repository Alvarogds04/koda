#!/usr/bin/env python3
"""Build Abito's application icons from Koda's sprite sheet (HU-074, design A «Cara de Koda en negro»).

The drawing is not duplicated: the input is the same sheet the island animates
(`frontend/koda/koda-chibi-32.png`, row `respirar`, frame 0). The script crops Koda's head
(ears, eyes, whiskers), scales it with nearest-neighbour at an integer factor so the pixel art
stays sharp, and centres it on Abito's notch black rounded tile.

Outputs (same paths the packaging already reads):
- icons/icon.icns      macOS .app, 16–1024 px, Apple's ~80/1024 margin around the tile
- icons/icon-macos.png 512 px preview of the macOS variant
- icons/icon.png       256 px, full-bleed tile (Linux launcher and window icon)
- icons/icon.ico       16, 24, 32, 48, 64, 128, 256 px, full-bleed tile (Windows exe and installer)

Usage (from apps/desktop-tauri):  python3 icons/src/make-koda-icons.py [--check]
--check regenerates in memory and exits 1 if any committed file differs (pure function of the sheet).
Requires Pillow.
"""
from __future__ import annotations

import io
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw

CRATE = Path(__file__).resolve().parents[2]
SHEET = CRATE / "frontend/koda/koda-chibi-32.png"
ICONS = CRATE / "icons"
CELL = 32
CATALOG = CRATE / "frontend/koda-catalog.js"
TILE = (17, 17, 20, 255)  # notch black (#111114), as on the artboard
MASTER = 1024


def respirar_row() -> int:
    """The row comes from the catalog the island uses, so a reordered sheet cannot pick the wrong pose."""
    found = re.search(r'"respirar":\{"row":(\d+)', CATALOG.read_text(encoding="utf-8"))
    if found is None:
        raise SystemExit("make-koda-icons: no respirar row in frontend/koda-catalog.js")
    return int(found.group(1))


def head() -> Image.Image:
    sheet = Image.open(SHEET).convert("RGBA")
    row = respirar_row()
    cell = sheet.crop((0, row * CELL, CELL, row * CELL + CELL))
    box = cell.getbbox()
    if box is None:
        raise SystemExit("make-koda-icons: Koda's respirar frame is empty in the sheet")
    left, top, right, bottom = box
    # The upper 11/20 of Koda's body box is the head: ears, eyes, whiskers.
    return cell.crop((left, top, right, top + (bottom - top) * 11 // 20))


def tile(size: int, margin: int, pad_ratio: float = 0.12, radius_ratio: float = 0.22) -> Image.Image:
    """Koda's head on a rounded black tile of `size - 2*margin`, centred in a `size` canvas."""
    src = head()
    inner = size - 2 * margin
    scale = max(1, int(inner * (1 - 2 * pad_ratio)) // max(src.size))
    face = src.resize((src.width * scale, src.height * scale), Image.Resampling.NEAREST)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    mask = Image.new("L", (inner, inner), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, inner - 1, inner - 1), int(inner * radius_ratio), fill=255)
    out.paste(Image.new("RGBA", (inner, inner), TILE), (margin, margin), mask)
    out.alpha_composite(face, ((size - face.width) // 2, (size - face.height) // 2))
    return out


def build() -> dict[str, bytes]:
    full = tile(MASTER, 0)
    mac = tile(MASTER, 80)
    files: dict[str, bytes] = {}

    def png(im: Image.Image) -> bytes:
        buf = io.BytesIO()
        im.save(buf, "PNG", optimize=False)
        return buf.getvalue()

    files["icon.png"] = png(full.resize((256, 256), Image.Resampling.LANCZOS))
    files["icon-macos.png"] = png(mac.resize((512, 512), Image.Resampling.LANCZOS))
    buf = io.BytesIO()
    full.save(buf, "ICO", sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])
    files["icon.ico"] = buf.getvalue()
    buf = io.BytesIO()
    mac.save(buf, "ICNS")
    files["icon.icns"] = buf.getvalue()
    return files


def main() -> int:
    files = build()
    if "--check" in sys.argv:
        stale = [name for name, data in files.items() if (ICONS / name).read_bytes() != data]
        if stale:
            print("make-koda-icons: stale icons: " + ", ".join(stale), file=sys.stderr)
            return 1
        print("make-koda-icons: icons match Koda's sheet")
        return 0
    for name, data in files.items():
        (ICONS / name).write_bytes(data)
        print(f"wrote icons/{name} ({len(data)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
