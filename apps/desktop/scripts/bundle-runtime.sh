#!/usr/bin/env bash
# Fills apps/desktop/runtime/ with what the packaged app runs locally, for the machine it is built on:
#   node/      a Node.js runtime (>= 22.13, for node:sqlite)
#   api/       the API, built, with its production dependencies
#   mcp/       the MCP server agents start, with its dependencies (run through tsx)
#   docs/agent the prompts and manual the API reads
#   web/       the editor build, served by the API for agents' headless editors
#   ffmpeg/    ffmpeg + ffprobe (static builds), for native export and clip decoding
# Run from anywhere; `tauri build` calls it. Override downloads with NODE_DIR=/path/to/node-root or
# FFMPEG_DIR=/path/with/ffmpeg+ffprobe. NODE_VERSION picks the Node release to download.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT="$ROOT/apps/desktop/runtime"
NODE_VERSION="${NODE_VERSION:-24.11.1}"
PNPM="${PNPM:-pnpm}"

os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin) platform=darwin ;;
  Linux) platform=linux ;;
  MINGW* | MSYS* | CYGWIN*) platform=win ;;
  *) echo "unsupported OS: $os" >&2; exit 1 ;;
esac
case "$arch" in
  arm64 | aarch64) cpu=arm64 ;;
  x86_64 | amd64) cpu=x64 ;;
  *) echo "unsupported CPU: $arch" >&2; exit 1 ;;
esac

echo "runtime for $platform-$cpu → $OUT"
find "$OUT" -mindepth 1 -maxdepth 1 ! -name .gitignore -exec rm -rf {} +
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# --- Node.js ---
if [ -n "${NODE_DIR:-}" ]; then
  cp -R "$NODE_DIR" "$OUT/node"
else
  if [ "$platform" = win ]; then
    name="node-v$NODE_VERSION-win-$cpu"
    curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$name.zip" -o "$tmp/node.zip"
    unzip -q "$tmp/node.zip" -d "$tmp"
  else
    name="node-v$NODE_VERSION-$platform-$cpu"
    curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$name.tar.xz" -o "$tmp/node.tar.xz"
    tar -xJf "$tmp/node.tar.xz" -C "$tmp"
  fi
  mkdir -p "$OUT/node"
  # Only the runtime: npm, headers and docs stay out of the app.
  if [ "$platform" = win ]; then
    cp "$tmp/$name/node.exe" "$OUT/node/"
  else
    mkdir -p "$OUT/node/bin"
    cp "$tmp/$name/bin/node" "$OUT/node/bin/"
  fi
  cp "$tmp/$name/LICENSE" "$OUT/node/LICENSE"
fi

# --- API and MCP server, with production dependencies only ---
"$PNPM" --dir "$ROOT" --filter @motionily/api build
# Hoisted: real folders, no symlinks into .pnpm (Tauri copies resources without links or dot folders).
export npm_config_node_linker=hoisted
"$PNPM" --dir "$ROOT" --filter @motionily/api deploy --prod --legacy "$OUT/api"
"$PNPM" --dir "$ROOT" --filter @motionily/mcp-server deploy --prod --legacy "$OUT/mcp"
unset npm_config_node_linker
# .bin holds symlinks only (nothing runs through them).
rm -rf "$OUT/api/node_modules/.bin" "$OUT/mcp/node_modules/.bin"
# onnxruntime-node ships every OS's binaries (~290 MB): keep this one's.
ort_os=$([ "$platform" = win ] && echo win32 || echo "$platform")
for dir in "$OUT"/api/node_modules/onnxruntime-node/bin/napi-v*; do
  find "$dir" -mindepth 1 -maxdepth 1 ! -name "$ort_os" -exec rm -rf {} +
  find "$dir/$ort_os" -mindepth 1 -maxdepth 1 ! -name "$cpu" -exec rm -rf {} + 2>/dev/null || true
done
# The MCP server is TypeScript run by tsx: deploy copies its sources with the package.
test -f "$OUT/mcp/src/index.ts"

mkdir -p "$OUT/docs"
cp -R "$ROOT/docs/agent" "$OUT/docs/agent"

# The editor build (`tauri build` makes it first): the API serves it so agents' headless editors
# open the editor on the API's own origin.
test -f "$ROOT/apps/web/dist/index.html"
cp -R "$ROOT/apps/web/dist" "$OUT/web"

# --- ffmpeg + ffprobe (GPL static builds from ffmpeg-static's GitHub releases; see THIRD_PARTY.md) ---
FFMPEG_RELEASE="${FFMPEG_RELEASE:-b6.1.1}"
mkdir -p "$OUT/ffmpeg"
exe=""
[ "$platform" = win ] && exe=".exe"
if [ -n "${FFMPEG_DIR:-}" ]; then
  cp "$FFMPEG_DIR/ffmpeg$exe" "$FFMPEG_DIR/ffprobe$exe" "$OUT/ffmpeg/"
else
  target=$([ "$platform" = win ] && echo "win32-$cpu" || echo "$platform-$cpu")
  for tool in ffmpeg ffprobe; do
    curl -fsSL "https://github.com/eugeneware/ffmpeg-static/releases/download/$FFMPEG_RELEASE/$tool-$target.gz" | gunzip > "$OUT/ffmpeg/$tool$exe"
  done
  curl -fsSL "https://github.com/eugeneware/ffmpeg-static/releases/download/$FFMPEG_RELEASE/$target.LICENSE" -o "$OUT/ffmpeg/LICENSE"
fi
chmod +x "$OUT"/ffmpeg/* 2>/dev/null || true

du -sh "$OUT"/* | sed "s#$OUT/##"
