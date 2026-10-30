# Windows installer payload

From `apps/desktop-tauri`, run `sh packaging/windows/xbuild.sh package` with the existing cross-build image. Host Node stages the runtime before the container build; Node is not required in the image. This command does not install or launch Abito.

`node packaging/windows/stage-runtime.cjs [--out DIRECTORY]` copies exactly `DAEMON_FILES`, `HARNESS_FILES` and `PI_FILES` exported by `packaging/lib.cjs`, defaulting to gitignored `dist/windows-runtime`. It generates `runtime.nsh` from those same lists. Existing unknown entries and symlinks are rejected rather than removed. `--help` describes the CLI.

The installer contains these sibling executables:

- `abito-island.exe`
- `abito-notice-relay.exe`
- `abito-private-session.exe`

`abito-private-session --verify` performs a read-only native status check using the same canonical root as publication: strict session-file ACL/owner, live daemon PID, pipe server PID/SID, then authenticated hello→ready. It accepts no path argument, never prints a token, writes nothing, and returns only a silent exit code (0 verified, 1 refused). `--help` describes both modes. Windows daemon CLI `status` uses this fixed sibling helper instead of a Node-only pipe probe; failure or a missing helper is not healthy. This does not authorize `stop` to signal a bare Windows PID.

The closed `desktop-daemon`, `desktop-harness` and `desktop-pi` directories live beside them. Shipping the Pi payload does not enable automatic extension installation on Windows; that remains explicitly unavailable. Node and Pi remain external runtime prerequisites, not bundled dependencies.

For native Windows packaging, stage with Node, copy the three built executables to `dist`, and invoke NSIS with `VERSION`, `BINDIR`, `ICON`, and `OUTDIR`. `RUNTIMEDIR` defaults to `${BINDIR}\windows-runtime`; the native workflow passes it explicitly. NSIS source paths, including the generated `File` entries, use backslashes. The generated include is BOM-free ASCII with LF line endings and drives both native and cross packaging. Before native compilation, CI prints the runtime directory argument, staged file list, and include header to distinguish missing payloads from NSIS path resolution failures.

Windows daemon and receiver directories share one privacy policy: the owner is the current user or BUILTIN\\Administrators, and every understood ACL principal is the current user, SYSTEM or BUILTIN\\Administrators. NULL DACLs, other principals, unknown ACE types and reparse-point paths are refused. Rust creates missing directories with a protected user+SYSTEM DACL and explicit current-user ownership at creation; it never rewrites an existing directory ACL. Existing profile ancestors outside the canonical Abito directory need to be real directories, not match Abito's private ACL. Endpoint metadata and daemon session files retain their stricter current-user-only policy.

Uninstall deletes only listed payload files and `uninstall.exe`, then removes empty owned directories deepest first. It does not recursively delete directories or remove unrelated files or island user configuration. The per-user shortcut and uninstall registry entry are removed.

After packaging, `node packaging/windows/stage-win.cjs` records hashes for all three executables, the setup executable, staged runtime and generated include, plus packaging/runtime/frontend source inputs. `node packaging/windows/stage-win.cjs --check` checks the exact receipt sets and hashes against the current artifacts and inputs, and rejects stale runtime copies. This is provenance checking, **not** proof that Windows installation or runtime launch works; the native CI install smoke supplies that evidence.

Local contract test: `node test-node/windows-runtime-check.cjs`. It stages an isolated payload, checks require closure and install/delete equivalence, exercises preservation of unrelated files, and runs the receipt CLI with tampered artifacts and inputs.

## Native preview smoke

`ci/public/preview-windows.yml` refuses non-GitHub-hosted runners before checkout or tool setup. It parses both PowerShell scripts before any account operation, executes native policy/receiver/daemon and real foreign-user tests, builds the release installer, then invokes `ci/public/smoke-windows.ps1 -Setup <setup.exe>`. NSIS is reused from the runner when available; only a disposable hosted runner may use the pinned 3.11 Chocolatey fallback.

The smoke installs silently in a fresh runner-temp directory and compares every installed file to the staged payload. The main launch leaves `ABITO_PROJECT_ROOT` absent to exercise the installed `USERPROFILE` fallback; a second launch supplies a normalized absolute Windows root. Explicit roots accept drive-absolute and UNC paths, rejecting relative paths, dot segments, empty segments and invalid/trailing Windows filename characters. Failures print bounded island/daemon stderr and directory ACL metadata, never session/token/config contents. It installs real Pi into an isolated npm prefix, starts the installed island, checks authenticated installed daemon status, and sends a Claude Stop event through the installed hook and native relay. Success requires a persisted island recap turn, not merely hook process success. Separate child environments assert the exact missing-Pi and missing-Node messages while the notice receiver still starts. Uninstall must remove every shipped file while preserving an unrelated fixture and island recap data. Logs are uploaded even on failure; no recursive profile cleanup runs.

`node test-node/windows-ci-check.cjs` checks guard placement structurally. It does not replace native PowerShell parsing or the full Windows smoke.
