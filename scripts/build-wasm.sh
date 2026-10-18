#!/usr/bin/env bash
# Build the Rust engine to WebAssembly and generate JS bindings for the web app.
set -euo pipefail
cd "$(dirname "$0")/.."
PROFILE="${PROFILE:-release}"
FLAG=$([ "$PROFILE" = "release" ] && echo "--release" || echo "")
cargo build -p engine-wasm --target wasm32-unknown-unknown $FLAG
wasm-bindgen --target web --out-dir apps/web/src/engine/pkg \
  "target/wasm32-unknown-unknown/$PROFILE/engine_wasm.wasm"
echo "wasm -> apps/web/src/engine/pkg"
