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

This package carries no other third-party runtime or test dependencies.
