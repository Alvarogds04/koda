#!/usr/bin/env python3
"""HU-056: cut the static tray frames of Koda Chibi out of the app's sprite sheets.

One raw RGBA file (cell*cell*4 bytes, row-major, straight alpha) per tray state and
sheet cell (16, 24, 32), written to src/tray_koda/. Frame 0 of the Abito state that
matches the tray state. The 16 px sheet lives in design/hu-055-koda/sprites (the app
ships only the 24 and 32 px sheets); pass its path with --sheet16.
    python3 tools/gen-koda-tray.py --sheet16 <path>/koda-chibi-16.png
Requires Pillow. Nothing runs at build time: the generated files are committed inputs
of src/tray.rs.
"""
import argparse
import os
import sys

from PIL import Image

# termino, trabaja, espera, error: rows of the seven Abito states
STATE_ROW = {"idle": 5, "working": 3, "needs-attention": 4, "disconnected": 6}
CRATE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def cut(path, cell, out_dir):
    with Image.open(path) as sheet:
        im = sheet.convert("RGBA")
    for state, row in STATE_ROW.items():
        frame = im.crop((0, row * cell, cell, row * cell + cell))
        target = os.path.join(out_dir, f"{state}-{cell}.rgba")
        try:
            with open(target, "wb") as handle:
                handle.write(frame.tobytes())
        except OSError as err:
            sys.exit(f"gen-koda-tray: cannot write {target}: {err}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sheet16", required=True)
    args = parser.parse_args()
    sheets = {
        16: args.sheet16,
        24: os.path.join(CRATE, "frontend/koda/koda-chibi-24.png"),
        32: os.path.join(CRATE, "frontend/koda/koda-chibi-32.png"),
    }
    out_dir = os.path.join(CRATE, "src/tray_koda")
    try:
        os.makedirs(out_dir, exist_ok=True)
        for cell, path in sheets.items():
            cut(path, cell, out_dir)
    except OSError as err:
        sys.exit(f"gen-koda-tray: {err}")


if __name__ == "__main__":
    main()
