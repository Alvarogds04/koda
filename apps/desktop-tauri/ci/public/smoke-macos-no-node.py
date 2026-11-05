#!/usr/bin/env python3
"""K2-02 T5 (S1): macOS installer smoke WITHOUT Node and WITHOUT Pi on the machine.

Usage: python3 ci/public/smoke-macos-no-node.py <path/to/Koda.dmg> <empty work-dir>

Runs AFTER the existing installed smoke in the same job, on the same disposable GitHub-hosted macOS runner, and
only there (it removes the runner's Node; nothing is restored):
  (q) quarantine: every node/npm/npx/pi/corepack on PATH (`which -a`), the runner toolcache's node and the
      Homebrew / /usr/local copies are moved out of reach with sudo; `command -v node` and `command -v pi` must
      then fail in a fresh login-free shell;
  (i) install: the .app is copied from the read-only mounted .dmg with ditto (what a person does);
  (s) start: the INSTALLED binary with a Finder-minimal environment (PATH=/usr/bin:/bin:/usr/sbin:/sbin, a
      private HOME) reaches «abito-island-daemon: running»: the daemon only says that after Koda's own Pi answered
      its first RPC get_state (a model-free round-trip). The daemon process's executable must be
      <App>.app/Contents/Resources/runtime/node (`ps -o comm=`);
  (t) status: the installed `daemon status`, run by that bundled node, reports running:true.
S3 (no pi.dev) is proven for macOS by apps/desktop-daemon/test/pi-offline.test.cjs in the node-suites job (real
Pi 1.4.0 launched with Koda's environment and a network recorder); macOS has no free connect() tracer usable here.
"""
import contextlib
import os
import pathlib
import shutil
import subprocess
import sys
import time


def report(part, ok, detail):
    print(f"{'PASS' if ok else 'FAIL'} ({part}) {detail}", flush=True)
    if not ok:
        sys.exit(1)


def wait_for(predicate, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.5)
    return predicate()


def main():
    # Destructive for the machine's own Node: ONLY a disposable GitHub-hosted runner, checked before anything else.
    if sys.platform != "darwin" or os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted":
        sys.exit("smoke-macos-no-node: refusing to run: it removes the machine's Node and Pi; only a disposable "
                 "GitHub-hosted macOS runner (GITHUB_ACTIONS=true, RUNNER_ENVIRONMENT=github-hosted)")
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    dmg = pathlib.Path(sys.argv[1]).resolve()
    work = pathlib.Path(sys.argv[2]).resolve()
    if not dmg.is_file():
        sys.exit(f"no dmg: {dmg}")
    if work.exists() and any(work.iterdir()):
        sys.exit(f"work dir must be empty or absent: {work}")
    quarantine = work / "quarantine"
    home = work / "home"
    for d in (quarantine, home):
        d.mkdir(parents=True, exist_ok=True)
        d.chmod(0o700)

    # (q) quarantine
    moved = []
    for tool in ("node", "npm", "npx", "pi", "corepack"):
        hits = subprocess.run(["/usr/bin/which", "-a", tool], capture_output=True, text=True).stdout.split()
        for hit in dict.fromkeys(hits):
            if os.path.lexists(hit):
                subprocess.run(["sudo", "mv", hit, str(quarantine / hit.replace("/", "_"))], check=True)
                moved.append(hit)
    toolcache = os.environ.get("RUNNER_TOOL_CACHE")
    if toolcache and os.path.isdir(os.path.join(toolcache, "node")):
        subprocess.run(["sudo", "mv", os.path.join(toolcache, "node"), str(quarantine / "toolcache-node")], check=True)
        moved.append(os.path.join(toolcache, "node"))
    for canonical in ("/opt/homebrew/bin/node", "/usr/local/bin/node", "/opt/homebrew/bin/pi", "/usr/local/bin/pi"):
        if os.path.lexists(canonical):
            subprocess.run(["sudo", "mv", canonical, str(quarantine / canonical.replace("/", "_"))], check=True)
            moved.append(canonical)
    probe = subprocess.run(["/bin/sh", "-c", "command -v node; command -v pi"], capture_output=True, text=True,
                           env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(home)})
    still = [line for line in probe.stdout.split() if line]
    left = [c for c in ("/opt/homebrew/bin/node", "/usr/local/bin/node") if os.path.lexists(c)]
    report("q", not still and not left and shutil.which("node") is None and shutil.which("pi") is None,
           f"no node and no pi on PATH or in Homebrew//usr/local ({len(moved)} entries moved; nothing is restored)"
           if not still and not left else f"still reachable: {still + left}")

    # (i) install from the dmg, the way a person does
    mount = work / "dmg-mount"
    mount.mkdir()
    applications = work / "Applications"
    subprocess.run(["/usr/bin/hdiutil", "attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", str(mount), str(dmg)],
                   check=True, stdout=subprocess.DEVNULL)
    try:
        apps = sorted(mount.glob("*.app"))
        report("i", len(apps) == 1, f"one .app in the dmg ({[a.name for a in apps]})")
        applications.mkdir()
        app = applications / apps[0].name
        subprocess.run(["/usr/bin/ditto", str(apps[0]), str(app)], check=True)
    finally:
        subprocess.run(["/usr/bin/hdiutil", "detach", str(mount)], check=False, stdout=subprocess.DEVNULL)
    runtime_node = app / "Contents/Resources/runtime/node"
    try:
        bundled_ok = runtime_node.is_file() and os.access(runtime_node, os.X_OK)
    except OSError as error:
        bundled_ok = False
        print(f"cannot inspect {runtime_node}: {error}", flush=True)
    report("i", bundled_ok, f"installed {app} with its bundled {runtime_node.name}")

    # (s) start with a Finder-minimal environment
    env = {"HOME": str(home), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}
    for key in ("USER", "LOGNAME", "TMPDIR"):
        if key in os.environ:
            env[key] = os.environ[key]
    log_path = work / "island.log"
    with log_path.open("w") as log:
        process = subprocess.Popen([str(app / "Contents/MacOS/abito-island")], cwd="/", env=env, stdout=log,
                                   stderr=subprocess.STDOUT, start_new_session=True)
    try:
        ready = wait_for(lambda: "abito-island-daemon: running (pid " in log_path.read_text(), 180)
        text = log_path.read_text()
        report("s", ready and "island host: no_daemon" not in text,
               "the daemon reported running" if ready else f"no daemon ready line; log tail: {text[-1500:]}")
        pid = text.split("abito-island-daemon: running (pid ", 1)[1].split(")", 1)[0]
        comm = subprocess.run(["/bin/ps", "-o", "comm=", "-p", pid], capture_output=True, text=True).stdout.strip()
        report("s", os.path.realpath(comm) == os.path.realpath(str(runtime_node)),
               f"the app-owned daemon (pid {pid}) runs on {comm}, expected {runtime_node}")

        # (t) status through the bundled node
        status = subprocess.run([str(runtime_node), str(app / "Contents/Resources/desktop-daemon/src/cli.cjs"), "status"],
                                env=env, capture_output=True, text=True, timeout=60)
        report("t", status.returncode == 0 and '"running":true' in status.stdout,
               "installed daemon status: running:true" if status.returncode == 0 else f"status exit {status.returncode}: {status.stderr[-500:]}")
    finally:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, 15)
    print("PASS smoke-macos-no-node: installed and ran on the bundled Node + Pi with no Node and no Pi on the machine", flush=True)


if __name__ == "__main__":
    main()
