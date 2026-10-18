#!/usr/bin/env bash
# Watch mode: recompile on change and restart the server. Uses the local mongod.
set -euo pipefail
cd "$(dirname "$0")/.."
tsc -p tsconfig.build.json
tsc -p tsconfig.build.json -w --preserveWatchOutput &
trap 'kill 0' EXIT
node --enable-source-maps --watch-path=dist dist/main.js
