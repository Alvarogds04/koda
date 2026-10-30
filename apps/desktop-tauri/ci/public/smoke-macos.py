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
    runtime = pathlib.Path(env.get("TMPDIR", "/tmp")) / "abito-island"
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
assert "ABITO_DESKTOP_SOCKET=" in healthy, "notice transport never started"
assert "no_daemon" not in healthy and "transport unavailable" not in healthy
# Remove only the disposable install's executable link, leaving Node available.
# Refuse a second globally installed Pi rather than pretending to test absence.
for fallback in ("/opt/homebrew/bin/pi", "/usr/local/bin/pi", "/usr/bin/pi"):
    assert not pathlib.Path(fallback).exists(), f"unexpected runner Pi: {fallback}"
pi.rename(pi.with_name("pi.smoke-disabled"))
try:
    missing = launch("pi-missing")
    assert "pi_missing" in missing, "missing Pi was not identified"
    assert "Falta Pi: instalalo con npm install -g @earendil-works/pi-coding-agent." in missing
    assert "ABITO_DESKTOP_SOCKET=" in missing, "notices must work without Pi"
    assert "abito-island-daemon: running" not in missing
finally:
    pi.with_name("pi.smoke-disabled").rename(pi)
print("macOS smoke: bundled daemon + notice transport ready; missing-Pi advice verified")
