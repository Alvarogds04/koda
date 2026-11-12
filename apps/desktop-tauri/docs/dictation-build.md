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
  also works.) Pin the archive's SHA-256 in the packaging recipe.

The speech model itself (Parakeet TDT 0.6B v3 int8, ~670 MB) is **not** part of
the build: it is downloaded at runtime, only when the user asks, from Hugging
Face at a pinned revision, verified by size and SHA-256 (`src/speech/mod.rs`),
into `$XDG_DATA_HOME/abito/Models`.

`reqwest` is pinned to 0.12 (ring + webpki-roots TLS) because 0.13's rustls
needs aws-lc-rs and rustls-platform-verifier.

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
  and deletes it. The build must copy it into `dist/` like the other helpers; `xbuild.sh package` does.
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
- **macOS (darwin-arm64).** No ffmpeg and no `abito-transcribe` in this version: no LGPL macOS build exists (pending
  for the Mac session, L12). The daemon reports `ffmpeg: "unavailable"`, and a Minikoda video run fails with a clear
  «Hoy» error.
- **Notices.** `apps/desktop-daemon/THIRD-PARTY-NOTICES.md` (shipped) carries sherpa-onnx (Apache-2.0), ONNX Runtime
  (MIT) and FFmpeg (LGPL, with the source location and offer). The repository root `THIRD-PARTY-NOTICES.md` indexes them.
