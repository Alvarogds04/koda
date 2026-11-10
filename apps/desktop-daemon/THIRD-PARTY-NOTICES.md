# Third-party notices

## Gentle Dot (adapted code)

Parts of this package are adapted from the Gentle Dot project
(`packages/daemon`: `supervisor.ts`, `isolation.ts`, `jsonl.ts`, `rotation.ts`,
`conversations.ts` (projection half) and `presentation.ts`/`uploads.ts` (via the
projection), `white-label.ts`, and the product identity document `identity.md`), used as the
MIT-licensed reference for the supervised isolated RPC runtime, fail-closed
private directory checks, strict JSONL framing, transparent session rotation
(hidden handoff message, session-file chains, 20 MB / 10 compaction limits),
the read-only history projection over the rotated session chain (`pageHistory`,
`historyFromMessages`, `describeTool`, `splitAttachments`; K2-05 T4 U1),
the user-facing white-label rewriting of internal names, and the
product-identity approach.

- Files adapted: `src/isolation.cjs` (including the engine-home marker logic
  from `claimEngineHome` and the private memory lifecycle from
  `privateMemory`/`listeningPid`/`memoryHealth`), `src/runtime.cjs` (in part,
  including the bundled default-engine resolution from `bundledGentleShell` and
  the session chains from the supervisor's session persistence),
  `src/rotation.cjs` (from `src/rotation.ts`), `src/conversations.cjs` (from the
  projection half of `src/conversations.ts` plus `describeTool`/`textOf` from
  `src/presentation.ts` and `splitAttachments` from `src/uploads.ts`),
  `src/white-label.cjs`, `test/fixtures` and `identity.md`
  (text), `README.md` (in part)
- Changes: rewritten in plain Node CJS with no third-party dependencies; Koda
  identity, island paths, environment allowlist and fail-closed path rules differ
  from the original; supervision state machine and JSONL framing closely follow
  the original; Koda's memory is ALWAYS private (no user-store mode: the store
  lives in the island home, the port is Koda's own 7439, and only the bundled
  binary is resolved — Gentle Dot's user-binary order is not ported); the
  hidden-name list adds Koda's own internal names (Abito, Pi).

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

This package carries no other third-party runtime or test dependencies.
