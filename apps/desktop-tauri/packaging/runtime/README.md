# The runtime folder Koda ships (K2-02) and the daemon's own dependencies (K2-13)

`build-runtime.cjs` builds the folder every installer ships as `runtime/`: Koda's own pinned Node 22 and its own pinned
Pi, so Koda never needs — nor touches — a Node or a Pi installed on the machine. `node.sha256` pins one official Node
archive per shipped target; `package.json` + `package-lock.json` pin every npm package exactly, by sha512.

## Why the Telegram client library ships here

K2-13 reads Telegram channels with the user's own account, and that needs a client library: `@mtcute/node` 0.32.8
(spike: `odd/evidence/k2-13-spike/`, decided by the human as L41). It is the daemon's dependency, but its bytes ship
inside **this** folder rather than as a second tree, because this is the one npm tree every installer already verifies
(sha256 of the archive, member audit), extracts (Linux `install.sh`, Windows `System32\tar.exe`) and writes licence
notices for. A second tree would need new installer payload lists, new closed-set assertions in the CI smoke scripts and
a new npm-install step in CI; this folder needs none of that.

`apps/desktop-daemon/package.json` pins the same version for development (`npm ci` there, nothing ships from it). Both
pins and the stub below are held together by `apps/desktop-tauri/test-node/telegram-deps-check.cjs`.

## No native addon ever ships

mtcute's `better-sqlite3` is its one hard native dependency, and it is never needed: the daemon always passes mtcute's
`MemoryStorage` (S20: the Telegram session is a credential, kept in the OS keychain, never on disk), so the
`SqliteStorage` that would load the addon is never constructed. `stubs/better-sqlite3` is Koda's empty stand-in; it
declares version `12.11.1` so it satisfies mtcute's `^12.10.0` and npm hoists it instead of installing the real package.
mtcute's crypto is WASM (`@mtcute/wasm`), so the tree is the same JS on Linux, macOS and Windows.

`assertNoNativeAddons()` fails the build if a `.node` file appears under `@mtcute`, `@fuman` or `better-sqlite3`, or if
the real better-sqlite3 (rather than Koda's stub) is installed. Pi's own platform prebuilds under
`@earendil-works/pi-tui/native/` predate K2-13 and are outside that scope.

## What the daemon resolves

The daemon looks for `@mtcute/node` beside the Node it runs on (`<folder>/node_modules/@mtcute/node`), then beside its
own package (`<prefix>/runtime/node_modules/@mtcute/node`), and only then by ordinary Node resolution (a development
checkout with `apps/desktop-daemon/node_modules`). See `apps/desktop-daemon/README.md`.

## Cost, measured

`@mtcute` (23 MB), `@fuman` (1.9 MB) and the 8 KB stub add about **2.6 MiB to the compressed archive** every installer
carries, and about 25 MB unpacked in the installed folder. Licences: all MIT/ISC/BSD-2/BSD-3/Apache-2.0, no copyleft;
`THIRD-PARTY-NOTICES.md` in the built folder lists every package with its licence, generated at build time, and the
build fails rather than ship a package whose licence text it cannot produce.
