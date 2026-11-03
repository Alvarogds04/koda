#!/usr/bin/env python3
"""K2-01a installer smoke for macOS: the app INSTALLED from the .dmg, not the build tree.

Usage: python3 ci/public/smoke-macos-installed.py <path/to/Koda.dmg> <work-dir>
<work-dir>/home/.npm-global must already hold Pi and a `node` link in bin/ (same layout as smoke-macos.py).

Prints one line per criterion part and exits non-zero if any part fails:
  (a) install: mount the .dmg read-only, copy the .app with ditto into <work-dir>/Applications, detach;
  (b) start:   the INSTALLED binary, Finder-minimal environment, reaches «abito-island-daemon: running»
               and publishes its endpoint handoff;
  (c) tray:    the tray was constructed (no «tray unavailable:» in the log). This is NOT proof that a
               person sees the island or the menu-bar icon: that stays a registered human gap;
  (d) notice:  a Claude Code `Stop` through the INSTALLED hook reaches the island, which persists exactly
               one turn (same proof as smoke-windows.ps1).
Answering a question through the shipped app is not machine-checked here (registered human gap).
Gatekeeper is not exercised: the copy is not quarantined, as in any unsigned CI build.
Only disposable GitHub-hosted macOS runners are supported; never run it on a person's Mac.
"""
import json
import os
import pathlib
import subprocess
import sys
import time

APP_ID = "com.abitog.AbitoTauri"
results = []


def report(part, ok, detail):
    results.append(ok)
    print(f"{'PASS' if ok else 'FAIL'} ({part}) {detail}", flush=True)


def wait_for(predicate, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.5)
    return predicate()


def install(dmg, applications):
    mount = applications.parent / "dmg-mount"
    mount.mkdir()
    subprocess.run(["/usr/bin/hdiutil", "attach", "-readonly", "-nobrowse", "-noautoopen",
                    "-mountpoint", str(mount), str(dmg)], check=True, stdout=subprocess.DEVNULL)
    try:
        apps = sorted(mount.glob("*.app"))
        if len(apps) != 1:
            raise AssertionError(f"expected one .app in the dmg, found {[a.name for a in apps]}")
        applications.mkdir()
        target = applications / apps[0].name
        subprocess.run(["/usr/bin/ditto", str(apps[0]), str(target)], check=True)
    finally:
        subprocess.run(["/usr/bin/hdiutil", "detach", str(mount)], check=False, stdout=subprocess.DEVNULL)
    return target


def main():
    if sys.platform != "darwin" or os.environ.get("GITHUB_ACTIONS") != "true":
        sys.exit("smoke-macos-installed requires a disposable macOS GitHub Actions runner")
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    dmg = pathlib.Path(sys.argv[1]).resolve()
    work = pathlib.Path(sys.argv[2]).resolve()
    home = work / "home"
    node = home / ".npm-global/bin/node"
    if not dmg.is_file() or not node.exists() or not (home / ".npm-global/bin/pi").exists():
        sys.exit(f"missing input: dmg={dmg.is_file()} node={node.exists()} under {home}")
    recap = home / "Library/Application Support" / APP_ID / "recap.json"
    if recap.exists():
        sys.exit(f"refusing to smoke against existing island data: {recap}")

    # (a) install the way a person does: from the dmg into an Applications folder.
    try:
        app = install(dmg, work / "Applications")
        binary = app / "Contents/MacOS/abito-island"
        hook = app / "Contents/Resources/desktop-harness/bin/abito-hook.cjs"
        daemon = app / "Contents/Resources/desktop-daemon/src/cli.cjs"
        missing = [p.name for p in (binary, hook, daemon) if not p.is_file()]
        report("a", not missing, f"installed {app} from {dmg.name}" if not missing else f"installed app lacks {missing}")
    except (subprocess.CalledProcessError, AssertionError) as error:
        report("a", False, f"install from dmg failed: {error}")
        return 1
    if missing:
        return 1

    # Finder-minimal environment: no project, socket, dev, agent or probe overrides. TMPDIR is the session's own
    # (/var/folders/... behind the /var -> /private/var link), exactly what a Finder launch gets.
    env = {"HOME": str(home), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}
    for key in ("USER", "LOGNAME", "TMPDIR"):
        if key in os.environ:
            env[key] = os.environ[key]
    runtime = pathlib.Path(os.path.realpath(env.get("TMPDIR", "/tmp"))) / "abito-island"
    log_path = work / "installed-island.log"

    with log_path.open("w") as log:
        process = subprocess.Popen([str(binary)], cwd="/", env=env, stdout=log, stderr=subprocess.STDOUT,
                                   start_new_session=True)
        try:
            # (b) the installed app starts its daemon and publishes the handoff hooks and Pi read.
            ready = wait_for(lambda: "abito-island-daemon: running (pid " in log_path.read_text(), 90)
            handoff = runtime / "endpoint.json"
            published = wait_for(handoff.is_file, 30)
            alive = process.poll() is None
            report("b", ready and published and alive,
                   f"daemon ready={ready}, endpoint.json published={published}, app alive={alive}")

            # (c) tray constructed; whether a person sees it is a registered human gap.
            text = log_path.read_text()
            tray_ok = alive and "tray unavailable:" not in text
            report("c", tray_ok, "tray constructed (no «tray unavailable:»); visual island/menu-bar check stays a human gap"
                   if tray_ok else "the log reports «tray unavailable:» or the app exited")

            # (d) a Claude Code Stop through the INSTALLED hook becomes exactly one persisted island turn.
            workspace = work / "workspace"
            workspace.mkdir()
            payload = json.dumps({"hook_event_name": "Stop", "cwd": str(workspace),
                                  "session_id": "k2-01a-installed-stop", "stop_hook_active": False})
            hook_run = subprocess.run([str(node), str(hook), "claude", "stop"], input=payload, env=env,
                                      capture_output=True, text=True, timeout=60)
            contract = hook_run.returncode == 0 and hook_run.stdout == "" and hook_run.stderr == ""

            def one_turn():
                try:
                    return len(json.loads(recap.read_text()).get("turns", [])) == 1
                except (OSError, ValueError):
                    return False

            persisted = contract and wait_for(one_turn, 30)
            report("d", persisted, "installed hook -> island persisted exactly one turn" if persisted else
                   f"hook exit={hook_run.returncode} stdout={hook_run.stdout[:200]!r} stderr={hook_run.stderr[:200]!r}, "
                   f"recap exists={recap.exists()}")
        finally:
            process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, 9)
                process.wait()
    print(log_path.read_text(), flush=True)
    return 0 if all(results) and len(results) == 4 else 1


if __name__ == "__main__":
    sys.exit(main())
