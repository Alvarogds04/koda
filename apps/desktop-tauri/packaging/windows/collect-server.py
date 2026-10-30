#!/usr/bin/env python3
"""Collect listener for the Abito Windows test VM (unit U5).

The guest never accepts inbound connections and the host has no inbound path to
it (OpenSSH server on Windows is best-effort), so results travel out over HTTP:
vm-poll.ps1 POSTs a JSON body {name, body} here. We bind to the libvirt NAT
gateway address only -- that is the guest-facing host address, not a public one
-- and write each payload into the VM's inbox directory.

Nothing here touches the human's system configuration: it is a plain process the
port session starts and stops.
"""
import argparse
import json
import os
import re
from http.server import BaseHTTPRequestHandler, HTTPServer

SAFE = re.compile(r"[^A-Za-z0-9._-]")
OUT_DIR = "."


def safe_name(name: str) -> str:
    name = (name or "unnamed").strip() or "unnamed"
    name = SAFE.sub("_", name)[:120]
    return name.lstrip(".") or "unnamed"


class Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length else b""
        try:
            payload = json.loads(raw.decode("utf-8", "replace"))
        except json.JSONDecodeError:
            payload = {"name": "raw-body.txt", "body": raw.decode("utf-8", "replace")}
        name = safe_name(str(payload.get("name", "unnamed")))
        body = str(payload.get("body", ""))
        path = os.path.realpath(os.path.join(OUT_DIR, name))
        if not path.startswith(os.path.realpath(OUT_DIR) + os.sep):
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b"name outside inbox\n")
            return
        try:
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(body)
        except OSError as exc:
            print(f"collect: no pude escribir {path}: {exc}", flush=True)
            self.send_response(500)
            self.end_headers()
            self.wfile.write(b"write failed\n")
            return
        print(f"collect: {len(body)} bytes -> {path}", flush=True)
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(b"ok\n")

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        print("collect: " + (format % args), flush=True)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--listen", default="192.168.122.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    global OUT_DIR
    OUT_DIR = args.out
    try:
        os.makedirs(OUT_DIR, exist_ok=True)
    except OSError as exc:
        print(f"collect: no puedo crear {OUT_DIR}: {exc}", flush=True)
        return 1
    print(f"collect: escuchando en {args.listen}:{args.port}, escribiendo en {OUT_DIR}", flush=True)
    HTTPServer((args.listen, args.port), Handler).serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
