# Dictation: build requirements (#467)

Dictation uses `sherpa-onnx` 1.13.8 (Apache-2.0) with the `static` feature.
Its build script (`sherpa-onnx-sys` 1.13.8) needs the **prebuilt static
libraries** `sherpa-onnx-v1.13.8-linux-x64-static-lib` (contains onnxruntime):

- Online: it downloads them from
  `https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-linux-x64-static-lib.tar.bz2`
  into its cache. Nothing else is needed.
- Offline / reproducible packaging: download that archive once, extract it,
  and point the build at its `lib/` directory:

  ```sh
  export SHERPA_ONNX_LIB_DIR=/path/to/sherpa-onnx-v1.13.8-linux-x64-static-lib/lib
  cargo build --release
  ```

  (`SHERPA_ONNX_ARCHIVE_DIR` pointing at a directory that holds the `.tar.bz2`
  also works.) Pin the archive's SHA-256 in the packaging recipe. Since K2-13
  this archive is only what the crate's build script needs to exist: the
  libraries that get **linked** come from the TTS-free archive `build.rs`
  stages (next section), and that one is fetched by `build.rs` from the public
  GitHub release on its first build in a fresh `target/` and cached in
  `target/sherpa-onnx-no-tts/archives`. "Offline" therefore covers cargo (which
  runs with `--offline`, so no crates.io access) and this crate archive, not
  `build.rs`'s one-time, sha256-verified download.

The speech model itself (Parakeet TDT 0.6B v3 int8, ~670 MB) is **not** part of
the build: it is downloaded at runtime, only when the user asks, from Hugging
Face at a pinned revision, verified by size and SHA-256 (`src/speech/mod.rs`),
into `$XDG_DATA_HOME/abito/Models`.

`reqwest` is pinned to 0.12 (ring + webpki-roots TLS) because 0.13's rustls
needs aws-lc-rs and rustls-platform-verifier.

## No espeak-ng in the shipped binaries (K2-13, S8/S15; decisions L22/L23)

The archive above also carries the text-to-speech path: `piper_phonemize`,
`espeak-ng` (GPL-3.0) and the `ucd` tables, and sherpa-onnx-sys links all
thirteen libraries. Koda only *recognises* speech (Parakeet, Whisper, Silero
VAD, the dictation wake word); nothing in `src/speech` or
`src/bin/abito-transcribe.rs` synthesises it. So `abito-island` and
`abito-transcribe` link the same upstream v1.13.8 release built with
`-DSHERPA_ONNX_ENABLE_TTS=OFF` instead:

- `packaging/sherpa-onnx-no-tts.sha256` pins the TTS-free archive and its
  SHA-256 for `linux-x64` and `win-x64`.
- `build.rs` downloads it once (public GitHub release, ~22 MB on Linux), checks
  the SHA-256 against that pin and unpacks only `lib/*.a` / `lib/*.lib` into
  `target/sherpa-onnx-no-tts/lib`. A mismatch, a failed download or an archive
  without native libraries fails the build instead of falling back.
- `.cargo/config.toml` replaces sherpa-onnx-sys's link list for this crate with
  the same ten archives minus the three TTS ones, and points the link at that
  directory. `static:-bundle=` is what makes it work: the archives are resolved
  by the linker at the final link, not packed into the crate's rlib, so the
  staged directory is the one that is actually linked.
- **The configuration is not optional.** Cargo reads a config file from the
  current directory and its ancestors, never from the manifest directory, so
  `cargo build --manifest-path apps/desktop-tauri/Cargo.toml` started anywhere
  else would find neither the link list nor the `[env] KODA_NO_TTS_LINK = "1"`
  marker in that same file — and would link the TTS build silently. `build.rs`
  panics on `linux-x64` and `win-x64` when the marker is missing and says to
  build from `apps/desktop-tauri`. Everything that ships already does:
  `packaging/build.cjs` runs cargo with the crate as its working directory, and
  so does the Windows container (`xbuild.sh` mounts the crate at `/abito/src`).
- The bytes of the staged files are checked too, not only the link list:
  `packaging/lib.cjs verifyStage` and `packaging/windows/stage-win.cjs --check`
  stream `abito-island[.exe]` and `abito-transcribe[.exe]` and fail on an
  `espeak_` or `piper_phonemize` string, so a staged build from the wrong
  directory can never be packaged.

Consequences worth knowing:

- **Nothing espeak-ng, piper_phonemize or ucd ships on Linux or Windows**, so
  the notices need no GPL-3.0 entry for them. The `espeak-ng` *tool* on a
  developer's machine is unrelated and is never used by Koda.
- `SHERPA_ONNX_LIB_DIR` / `SHERPA_ONNX_ARCHIVE_DIR` still tell the crate where
  its own (TTS) archive is, so its build script has nothing to download, but
  that archive is no longer linked. `build.rs` downloads its own pinned
  TTS-free archive once per fresh `target/` (public GitHub release, sha256
  checked, then cached), so no workflow change was needed for it either.
- **macOS is not covered yet**: `.cargo/config.toml` has no `apple-darwin`
  table and `build.rs` prints a warning, so `osx-arm64` keeps the crate's link
  list (espeak-ng included) until the Mac session takes the same three steps
  with the `osx-arm64-static-no-tts-lib` archive (decisions L12, L23).
- Verify a build with `nm -a target/debug/abito-transcribe | grep -c espeak_`
  (must be `0`); `node test-node/sherpa-tts-free-check.cjs` pins the wiring and
  scans the newest rlib and the built binaries (`target/debug`,
  `target/release`, `target-ship/release` and the Windows `dist/`) for
  espeak/piper bytes.
- Bumping `sherpa-onnx` means updating the version inside the two archive names
  in the pin file (the check compares them with `Cargo.lock`).

## Minikodas: `abito-transcribe` (K2-13, S8/S15/S16)

`src/bin/abito-transcribe.rs` is a second binary of this crate: batch
speech-to-text for the Minikodas, spawned by the daemon (`shell:false`, fixed
argv). It links the same `sherpa-onnx` crate, so it needs the same
`SHERPA_ONNX_LIB_DIR` / `SHERPA_ONNX_ARCHIVE_DIR` as the island
(`cargo build --bin abito-transcribe`). It carries its own static onnxruntime,
so it adds roughly the size of the speech engine to each installer.

It shares dictation's catalog, model store (`$XDG_DATA_HOME/abito/Models`) and
Silero VAD; a user who already downloaded Parakeet for dictation downloads
nothing more.

```text
abito-transcribe transcribe [--model parakeet-tdt-0.6b-v3-int8|whisper-turbo] [--language es|en|…]
                            [--timeout-sec N] [--max-seconds N] <absolute 16 kHz mono WAV>
abito-transcribe status   [--model ID]   # {model, present, vad, downloadMb}; reads the disk only
abito-transcribe download [--model ID]   # the catalog's pinned, size + SHA-256 checked download
```

- Models: Parakeet v3 int8 (default) or Whisper turbo int8. Whisper always
  gets a fixed language (`language_required` otherwise); it never guesses.
- Input: a regular file (a symlink, directory or FIFO is `bad_input`), 16 kHz
  mono 16-bit PCM or 32-bit float WAV (`bad_audio` otherwise). The daemon's
  bundled ffmpeg produces it.
- Segmentation: Silero VAD (threshold 0.5, min silence 0.5 s, min speech
  0.25 s, 20 s detector cap), then every segment is cut again so that no
  stretch longer than 25 s reaches the model. sherpa's Whisper drops audio after
  30 s, and Silero's own cap is not strict (evidence
  `odd/evidence/k2-13-stt/`).
- Output: ONE JSON line on stdout,
  `{text, segments:[{start,end,text}], model, language, durationSec}`, or
  `{error, message}` with a closed code: `usage` (exit 2), `unknown_model`,
  `language_required`, `model_missing`, `bad_input`, `bad_audio`, `too_long`,
  `timeout`, `engine_failed`, `download_failed` (exit 1). Messages are fixed
  strings; the input path and the transcript are never written to stderr.
- Network: only `download`. `transcribe` with a missing model answers
  `model_missing` and fetches nothing.
- Bounds: audio is streamed in blocks (the memory is the model plus a 60 s VAD
  buffer and one ≤ 25 s segment), `--timeout-sec` (default 3600, max 14400) and
  `--max-seconds` (default 10800, max 21600).
- Tests: `cargo test --lib speech::transcribe_tests` (fake detector and
  recognizer) and `cargo test --test transcribe_cli` (the binary against an
  empty private store). The real model run is opt-in:
  `ABITO_TRANSCRIBE_WAV=<wav> cargo test --test transcribe_cli -- --nocapture`.

### Packaging `abito-transcribe` and ffmpeg (K2-13, S9)

- **Linux.** `packaging/build.cjs` stages `target-ship/release/abito-transcribe` beside `abito-island` (`lib.cjs`
  `STAGED`, executable in `install.sh` `EXEC_FILES`). Uninstall removes it with the other staged files.
- **Windows.** `abito-transcribe.exe` is in `stage-runtime.cjs` `BINARY_FILES`, so the generated NSIS include installs
  and deletes it. `xbuild.sh package` copies it into `dist/` with the other helpers, and so does
  `install-manifest.cjs` on the GitHub runner: `cargo build --release --bins` builds it, the workflow copies only three
  of the four binaries, and `completeBinaries()` (stage-runtime.cjs) stages what is missing in the default `dist/`
  before NSIS runs. No workflow edit is needed for it.
- **ffmpeg.** It ships inside the bundled runtime: `packaging/runtime/build-runtime.cjs` takes the pinned BtbN LGPL
  archive (`packaging/runtime/ffmpeg.sha256`, linux-x64 and win-x64), verifies its sha256, and keeps only
  `bin/ffmpeg[.exe]` and `LICENSE.txt`.
  - It refuses a binary configured with `--enable-gpl` or `--enable-nonfree` (or with no configure string), and a
    licence that is not the LGPL.
  - The archive is downloaded at build time from the BtbN GitHub release; `--ffmpeg-archive <file>` makes it offline.
  - It lands as `runtime/ffmpeg[.exe]` + `runtime/LICENSE.ffmpeg.txt`, with an FFmpeg section (binary URL, sha256,
    source revision and build scripts) in `runtime/THIRD-PARTY-NOTICES.md`.
  - It is removed with the runtime directory. The Windows install manifest pins `runtime/ffmpeg.exe` like
    `runtime/node.exe` (`install-manifest.cjs --runtime`).
  - **Licence record (LGPL-3.0, still open).** Every notice that names FFmpeg also states what is owed and what is
    still missing: a source offer (the exact FFmpeg source at tag `n9.0.2-49-gc179411bbb` plus the
    BtbN/FFmpeg-Builds scripts, on request, for at least three years), and the plain statement that Koda does **not**
    mirror those sources yet, so the mirror has to exist (and be linked from the notices) before a public release
    (LGPL-3.0 section 6). The licence review of FFmpeg's obligations and its AAC/H.264 patent question has **not**
    been done; the notices say so instead of implying it was.
- **macOS (darwin-arm64).** No ffmpeg and no `abito-transcribe` in this version: no LGPL macOS build exists (pending
  for the Mac session, L12). The daemon reports `ffmpeg: "unavailable"`, and a Minikoda video run fails with a clear
  «Hoy» error.
- **Notices.** `apps/desktop-daemon/THIRD-PARTY-NOTICES.md` (shipped) carries sherpa-onnx (Apache-2.0), ONNX Runtime
  (MIT) and FFmpeg (LGPL, with the source location and offer). The repository root `THIRD-PARTY-NOTICES.md` indexes them.
