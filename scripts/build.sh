#!/bin/sh
# Type-check, build and zip the plugin. Uses local node if present, otherwise a node container.
#   scripts/build.sh        -> dist/tracepong-live-panel-<version>.zip
set -e
cd "$(dirname "$0")/.."
if command -v npm >/dev/null 2>&1; then
  [ -d node_modules ] || npm ci
  npm run dist
else
  docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD":/src -w /src node:22-bookworm \
    sh -c '[ -d node_modules ] || npm ci; npm run dist'
fi
