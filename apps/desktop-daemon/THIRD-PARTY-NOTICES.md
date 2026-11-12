# Third-party notices

## Gentle Dot (adapted code)

Parts of this package are adapted from the Gentle Dot project
(`packages/daemon`: `supervisor.ts`, `isolation.ts`, `jsonl.ts`, and the product
identity document `identity.md`), used as the MIT-licensed reference for the
supervised isolated RPC runtime, fail-closed private directory checks, strict JSONL
fring, and product-identity approach.

- Files adapted: `src/isolation.cjs`, `src/runtime.cjs` (in part), `test/fixtures` and
  `identity.md` (concept), `README.md` (in part)
- Changes: rewritten in plain Node CJS with no third-party dependencies; Abito
  identity, island paths, environment allowlist and fail-closed path rules differ from
  the original; supervision state machine and JSONL framing closely follow the
  original.

Gentle Dot is distributed under the MIT License:

```text
MIT License

Copyright (c) 2026 Gentleman Programming

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Coucou (mechanics only)

The published bundle uses Coucou’s MECHANICS only: the MIT-licensed code,
Copyright (c) 2026 Louis Raillé. Mochi’s look, sounds, icons and images are
not used (Coucou `LICENSE-ASSETS.md`); Abito keeps its own clay character and
ports no Coucou assets.

Coucou is distributed under the MIT License:

```text
MIT License

Copyright (c) 2026 Louis Raillé

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## @mtcute/node (Telegram client library, K2-13)

This package declares one runtime dependency, `@mtcute/node` 0.32.8 (MIT, https://github.com/mtcute/mtcute), which reads
Telegram channels with the user's own account. **Its bytes do not ship from this package**: they travel inside the
bundled runtime folder (`apps/desktop-tauri/packaging/runtime`), which is the one npm tree the installers verify, extract
and write licence notices for. The built folder's `THIRD-PARTY-NOTICES.md` lists that whole tree package by package,
generated at build time (and the build fails rather than ship a package whose licence text it cannot produce).

The 19 packages this pin adds carry no copyleft in the code it runs: `@mtcute/{core,node,wasm,html-parser,markdown-parser}` and
`@mtcute/{file-id,tl-runtime}` (MIT, https://github.com/mtcute/mtcute), `@fuman/{io,net,node,utils}` (MIT,
https://github.com/teidesu/fuman) with every version pinned exactly (0.0.23) and checked against both lockfiles,
`@types/events`, `htmlparser2` and `dom-serializer` (MIT), `domelementtype`, `domhandler`, `domutils` and `entities`
4.5.0/7.0.1 (BSD-2-Clause), and **`long` 5.3.2 (Apache-2.0, https://github.com/dcodeIO/long.js)**, which
`@mtcute/tl-runtime` uses to write 64-bit TL values such as a channel's `accessHash`. Every one of them ships its own
licence file, which the built folder's notices point at; `packaging/runtime/licenses/Apache-2.0.txt` is the canonical
text kept for anything whose own file is missing.

`better-sqlite3` is **not** shipped and never loaded: this package always passes mtcute's `MemoryStorage` (the Telegram
session is a credential and is never written to disk, S20), so the `SqliteStorage` that would load its native addon is
never constructed. The runtime folder ships Koda's empty stub in its place
(`packaging/runtime/stubs/better-sqlite3`, MIT, this repository).

This package carries no other third-party runtime or test dependencies.
