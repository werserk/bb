#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
lab=$(mktemp -d)
trap 'rm -rf -- "$lab"' EXIT
mkdir -p "$lab"/{home,tmp,data}
env -i PATH=/usr/bin:/bin HOME="$lab/home" TMPDIR="$lab/tmp" BB_DATA_DIR="$lab/data" TSX_DISABLE_CACHE=1 npm_config_offline=true NODE_ENV=test node --conditions=source --import ../../node_modules/tsx/dist/loader.mjs dual-proof/run.ts
