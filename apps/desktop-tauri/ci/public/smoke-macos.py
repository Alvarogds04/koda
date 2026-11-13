#!/usr/bin/env python3
"""Smoke the packaged release binary with Finder's minimal PATH, not dev env.

Usage: python3 ci/public/smoke-macos.py /path/to/Abito.app /path/to/isolated-home
Install Pi under <isolated-home>/.npm-global first and link Node in its bin/.
Only disposable GitHub runner homes are supported; never run on a user's app.
"""
import os
import pathlib
import subprocess
import sys
import tempfile
import time

if sys.platform != "darwin" or os.environ.get("GITHUB_ACTIONS") != "true":
    sys.exit("smoke-macos requires a disposable macOS GitHub Actions runner")
app = pathlib.Path(sys.argv[1]).resolve()
home = pathlib.Path(sys.argv[2]).resolve()
binary = app / "Contents/MacOS/abito-island"
pi = home / ".npm-global/bin/pi"
assert binary.is_file() and pi.is_file()
assert (app / "Contents/Resources/desktop-daemon/src/cli.cjs").is_file()
assert (app / "Contents/Resources/desktop-harness/bin/abito-hook.cjs").is_file()
# Standard OS environment only: no project, socket, dev, agent or probe overrides.
env = {"HOME": str(home), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}
for key in ("USER", "LOGNAME", "TMPDIR"):
    if key in os.environ:
        env[key] = os.environ[key]


def launch(name, while_running=None):
    log_path = home / (name + ".log")
    with log_path.open("w") as log:
        process = subprocess.Popen([str(binary)], cwd="/", env=env,
                                   stdout=log, stderr=subprocess.STDOUT)
        try:
            time.sleep(20)
            assert process.poll() is None, f"app exited early: {process.returncode}"
            if while_running:
                while_running(process.pid)
        finally:
            process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                raise AssertionError("app did not shut down within 15 seconds") from None
    text = log_path.read_text()
    print(text, flush=True)
    return text


def endpoint_published(pid):
    # HU-068: the stable handoff Pi and the hooks read to find the island (it used to be a «no receiver» stub here)
    import json
    runtime = pathlib.Path(env.get("TMPDIR") or tempfile.gettempdir()) / "koda"
    handoff = runtime / "endpoint.json"
    assert handoff.is_file(), f"no endpoint.json in {runtime}: {sorted(p.name for p in runtime.iterdir())}"
    assert handoff.stat().st_mode & 0o777 == 0o600, oct(handoff.stat().st_mode)
    data = json.loads(handoff.read_text())
    assert set(data) == {"v", "endpoint", "pid", "procStart"}, data
    assert data["v"] == 1 and data["pid"] == pid, data
    assert pathlib.Path(data["endpoint"]).is_socket(), data
    assert data["procStart"].isdigit(), data
    print("endpoint.json published:", data, flush=True)


healthy = launch("runtime-present", endpoint_published)
assert "endpoint handoff not published" not in healthy, "the handoff must be published on macOS"
assert "abito-island-daemon: running (pid " in healthy, "daemon never became ready"
assert "KODA_DESKTOP_SOCKET=" in healthy, "notice transport never started"
assert "no_daemon" not in healthy and "transport unavailable" not in healthy
# K2-02: an installed Koda ships its own Node and Pi (Contents/Resources/runtime), so hiding the runner's Pi no longer
# makes it «missing»: the daemon starts on the bundled one (smoke-macos-no-node.py proves that with both quarantined).
# Its failure path is a BROKEN bundled runtime: discovery fails closed with bundled_runtime_invalid and the reinstall
# sentence, never falls back to the runner's Node or Pi, and notices keep working (the transport starts apart from the
# daemon). Twin of the Windows broken-runtime case (smoke-windows.ps1, f94afcd).
manifest = app / "Contents/Resources/runtime/koda-runtime.json"
assert manifest.is_file(), f"no bundled runtime manifest at {manifest}"
moved = manifest.with_name("koda-runtime.json.k2-02-smoke-moved")
manifest.rename(moved)
try:
    broken = launch("broken-runtime")
    assert "island host: no_daemon (bundled_runtime_invalid)" in broken, "broken runtime was not identified"
    assert "La instalación de Koda está dañada: volvé a instalar Koda." in broken
    assert "KODA_DESKTOP_SOCKET=" in broken, "notices must work on a broken runtime"
    assert "abito-island-daemon: running" not in broken, "daemon unexpectedly started on a broken bundled runtime"
finally:
    moved.rename(manifest)
print("macOS smoke: bundled daemon + notice transport ready; broken-runtime advice verified")
