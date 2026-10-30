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
