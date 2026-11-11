#!/usr/bin/env bash
# Assemble the Desktop-side plugin (mirror + the bridge files it carries into WSL) and copy it to the Windows test
# folder that Desktop installs with link:. After copying, Desktop must be fully restarted for the new code to load.
#   mirror/transport/  client.mjs (Desktop half), daemon.mjs + mux.mjs (copied into WSL by setup.mjs)
#   mirror/agent/      the WSL half of the plugin (copied into WSL and added to the desktop-wsl profile)
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
dest="${1:-/mnt/c/Users/S/dsh-wsl-test/mirror}"
m="$here/experiments/mirror/mirror"
mkdir -p "$m/transport" "$m/agent"
cp "$here"/experiments/transport/{mux.mjs,client.mjs,daemon.mjs} "$m/transport/"
cp "$here"/experiments/mirror/agent/{index.mjs,broker.mjs,package.json,cordis.patch.yml} "$m/agent/"
mkdir -p "$dest/transport" "$dest/agent"
cp "$m"/*.mjs "$m"/{client.js,package.json,cordis.patch.yml} "$dest/"
cp "$m"/transport/* "$dest/transport/"
cp "$m"/agent/* "$dest/agent/"
echo "copied to $dest"
