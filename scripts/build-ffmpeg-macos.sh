#!/bin/sh
# Builds an LGPL-only FFmpeg for macOS (VideoToolbox H.264 + native AAC), statically linked against
# FFmpeg's own libs, and places it where Tauri's externalBin expects it. Needs Xcode Command Line Tools.
# Run from the repo root:  sh scripts/build-ffmpeg-macos.sh
set -eu
VER=9.0.2
TRIPLE=$(rustc -vV | sed -n 's/^host: //p')   # aarch64-apple-darwin or x86_64-apple-darwin
ROOT=$(pwd)
WORK=$(mktemp -d)
cd "$WORK"
curl -fsSLO "https://ffmpeg.org/releases/ffmpeg-$VER.tar.xz"
tar xf "ffmpeg-$VER.tar.xz"
cd "ffmpeg-$VER"
# No --enable-gpl / --enable-nonfree => LGPL v2.1+. Only what satoimo uses is enabled.
./configure --disable-gpl --disable-nonfree --disable-doc --disable-ffplay --disable-ffprobe \
  --disable-network --disable-debug --enable-videotoolbox --enable-audiotoolbox \
  --extra-cflags="-mmacosx-version-min=11.0" --extra-ldflags="-mmacosx-version-min=11.0"
make -j"$(sysctl -n hw.ncpu)"
OUT="$ROOT/src-tauri/binaries"
mkdir -p "$OUT"
cp "$WORK/ffmpeg-$VER/ffmpeg" "$OUT/ffmpeg-$TRIPLE"
cp "$WORK/ffmpeg-$VER.tar.xz" "$OUT/ffmpeg-$VER-source.tar.xz"   # keep the exact source for redistribution
"$OUT/ffmpeg-$TRIPLE" -hide_banner -version | head -3
