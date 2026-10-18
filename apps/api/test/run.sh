#!/usr/bin/env bash
# Compile and run the e2e suite. Reuses a local mongod when available instead of downloading one.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -z "${MONGOMS_SYSTEM_BINARY:-}" ] && command -v mongod >/dev/null; then
  export MONGOMS_SYSTEM_BINARY="$(command -v mongod)"
fi
rm -rf dist-test
tsc -p tsconfig.json --outDir dist-test
node --test --test-concurrency=1 'dist-test/test/**/*.e2e.js'
