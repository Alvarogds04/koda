# syntax=docker/dockerfile:1
# Cross-build image for the Abito island on Windows (x86_64-pc-windows-msvc).
#
# Why a container: Tauri 2 supports only the MSVC Windows target, so a Linux
# host needs the Microsoft C headers/libs plus a linker that emits PE images.
# cargo-xwin downloads the Windows SDK (ucrt + msvc CRT + um libs) at build
# time into XWIN_CACHE_DIR; `lld` provides `lld-link` (the MSVC-flavoured
# linker) and `llvm-rc` compiles the Windows resource file (app icon).
#
# Nothing here touches the host: toolchain, rustup target and SDK all live in
# this image and the named volumes the driver mounts.
#
# NSIS is installed so the same image can produce the Windows installer in a
# later step. `.msi` cannot be built here: WiX only runs on Windows.
FROM docker.io/library/rust:1.98-bookworm

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      clang \
      lld \
      llvm \
      nsis \
      ca-certificates \
      curl \
      rsync \
      unzip \
 && rm -rf /var/lib/apt/lists/*

# The one Windows target Tauri supports.
RUN rustup target add x86_64-pc-windows-msvc \
 && rustup component add llvm-tools

# cargo-xwin is the "runner": it stages the SDK and injects the linker flags.
ENV XWIN_CACHE_DIR=/xwin-cache
RUN cargo install --locked cargo-xwin \
 && mkdir -p "$XWIN_CACHE_DIR"

# Build-time sanity gate: the tools the driver depends on must exist in the image.
RUN cargo-xwin --version \
 && rustup target list --installed \
 && (command -v lld-link || ls /usr/bin/*lld*) \
 && command -v makensis

WORKDIR /abito/src
CMD ["cargo", "xwin", "--help"]
