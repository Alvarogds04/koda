#!/usr/bin/env python3
"""K2-01a installer smoke for macOS: the app INSTALLED from the .dmg, not the build tree.

Usage: python3 ci/public/smoke-macos-installed.py <path/to/Koda.dmg> <work-dir>
<work-dir>/home/.npm-global must already hold Pi and a `node` link in bin/ (same layout as smoke-macos.py).

Prints one line per criterion part and exits non-zero if any part fails:
  (a) install: mount the .dmg read-only, copy the .app with ditto into <work-dir>/Applications, detach;
  (b) start:   the INSTALLED binary, Finder-minimal environment, reaches «koda-daemon: running»
               and publishes its endpoint handoff;
  (c-island)   the installed app owns an on-screen window with a real size, read from the window server
               (CGWindowListCopyWindowInfo through JXA: owner pid, bounds and on-screen state need no
               Accessibility or Screen Recording permission);
  (c-tray)     the tray was constructed (no «tray unavailable:» in the log). This is NOT proof that a
               person sees the menu-bar icon: that stays a registered human gap;
  (d) notice:  a Claude Code `Stop` through the INSTALLED hook reaches the island, which logs exactly one
               content-free «island: settled notice accepted» line (same proof as smoke-windows.ps1).
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

APP_ID = "com.abitog.Koda"
# K2-03: the island's one content-free line per accepted settled notice (src/protocol.rs SETTLED_NOTICE_LOG_LINE).
SETTLED_LINE = "island: settled notice accepted"
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


# Window-server query for one pid: owner pid, bounds and on-screen state only (no titles, no pixels), so no
# Accessibility or Screen Recording permission is involved. Prints a JSON list of the pid's windows.
WINDOWS_JXA = """
ObjC.import('CoreGraphics');
function run(argv) {
  const pid = Number(argv[0]);
  const all = ObjC.deepUnwrap(ObjC.castRefToObject(
    $.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, $.kCGNullWindowID))) || [];
  return JSON.stringify(all.filter(w => w.kCGWindowOwnerPID === pid).map(w => ({
    layer: w.kCGWindowLayer, onscreen: !!w.kCGWindowIsOnscreen, bounds: w.kCGWindowBounds })));
}
"""


def island_windows(pid):
    """The on-screen windows with a real size owned by pid, plus the raw query output for the log."""
    run = subprocess.run(["/usr/bin/osascript", "-l", "JavaScript", "-e", WINDOWS_JXA, str(pid)],
                         capture_output=True, text=True, timeout=30)
    if run.returncode != 0:
        return [], f"osascript exit {run.returncode}: {run.stderr.strip()[:300]}"
    try:
        windows = json.loads(run.stdout)
    except ValueError:
        return [], f"unreadable window list: {run.stdout[:300]!r}"
    shown = [w for w in windows if w.get("onscreen") and (w.get("bounds") or {}).get("Width", 0) > 0
             and (w.get("bounds") or {}).get("Height", 0) > 0]
    return shown, run.stdout.strip()[:600]


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
    island_data = home / "Library/Application Support" / APP_ID
    if island_data.exists():
        sys.exit(f"refusing to smoke against existing island data: {island_data}")

    # (a) install the way a person does: from the dmg into an Applications folder.
    try:
        app = install(dmg, work / "Applications")
        binary = app / "Contents/MacOS/koda"
        hook = app / "Contents/Resources/desktop-harness/bin/koda-hook.cjs"
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
    if not env.get("TMPDIR"):
        sys.exit("TMPDIR is not set: a Finder launch always has one, so this runner is not a normal macOS session")
    runtime = pathlib.Path(os.path.realpath(env["TMPDIR"])) / "koda"
    log_path = work / "installed-island.log"

    with log_path.open("w") as log:
        process = subprocess.Popen([str(binary)], cwd="/", env=env, stdout=log, stderr=subprocess.STDOUT,
                                   start_new_session=True)
        try:
            # (b) the installed app starts its daemon and publishes the handoff hooks and Pi read.
            ready = wait_for(lambda: "koda-daemon: running (pid " in log_path.read_text(), 90)
            handoff = runtime / "endpoint.json"
            published = wait_for(handoff.is_file, 30)
            alive = process.poll() is None
            report("b", ready and published and alive,
                   f"daemon ready={ready}, endpoint.json published={published}, app alive={alive}")

            # (c-island) the window server shows an on-screen window of the installed app.
            found = []
            raw = ""

            def has_window():
                nonlocal found, raw
                found, raw = island_windows(process.pid)
                return bool(found)

            shown = alive and wait_for(has_window, 30)
            report("c-island", shown, f"installed app owns {len(found)} on-screen window(s): {found[:2]}" if shown
                   else f"no on-screen window owned by pid {process.pid}; window server said: {raw}")

            # (c-tray) tray constructed; whether a person sees the menu-bar icon is a registered human gap.
            text = log_path.read_text()
            tray_ok = alive and "tray unavailable:" not in text
            report("c-tray", tray_ok, "tray constructed (no «tray unavailable:»); seeing the menu-bar icon stays a human gap"
                   if tray_ok else "the log reports «tray unavailable:» or the app exited")

            # (d) a Claude Code Stop through the INSTALLED hook becomes exactly one content-free island log line
            # (src/protocol.rs SETTLED_NOTICE_LOG_LINE); hook exit and silence alone are not proof.
            workspace = work / "workspace"
            workspace.mkdir()
            payload = json.dumps({"hook_event_name": "Stop", "cwd": str(workspace),
                                  "session_id": "k2-01a-installed-stop", "stop_hook_active": False})
            hook_run = subprocess.run([str(node), str(hook), "claude", "stop"], input=payload, env=env,
                                      capture_output=True, text=True, timeout=60)
            contract = hook_run.returncode == 0 and hook_run.stdout == "" and hook_run.stderr == ""

            def settled_count():
                return log_path.read_text().splitlines().count(SETTLED_LINE)

            seen = contract and wait_for(lambda: settled_count() >= 1, 30)
            if seen:
                time.sleep(2)  # a duplicate acceptance would land right behind the first
            accepted = seen and settled_count() == 1
            report("d", accepted, "installed hook -> island accepted exactly one settled notice" if accepted else
                   f"hook exit={hook_run.returncode} stdout={hook_run.stdout[:200]!r} stderr={hook_run.stderr[:200]!r}, "
                   f"«{SETTLED_LINE}» lines={settled_count()}")
        finally:
            process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, 9)
                process.wait()
    print(log_path.read_text(), flush=True)
    return 0 if all(results) and len(results) == 5 else 1


if __name__ == "__main__":
    sys.exit(main())
