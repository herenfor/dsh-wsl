#!/usr/bin/env bash
# Assemble the Desktop-side plugin package: copy the bridge files it carries into WSL next to it. Run before
# `npm publish` in experiments/mirror/mirror (and before sync-windows.sh, which runs this first).
#   mirror/transport/  client.mjs (Desktop half), daemon.mjs + mux.mjs (copied into WSL by setup.mjs)
#   mirror/agent/      the WSL half of the plugin (copied into WSL and added to the desktop-wsl profile)
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
m="$here/experiments/mirror/mirror"
mkdir -p "$m/transport" "$m/agent"
cp "$here"/experiments/transport/{mux.mjs,client.mjs,daemon.mjs} "$m/transport/"
cp "$here"/experiments/mirror/agent/{index.mjs,broker.mjs,package.json,cordis.patch.yml} "$m/agent/"
echo "assembled $m"
