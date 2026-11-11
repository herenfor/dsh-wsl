#!/usr/bin/env bash
# Copy the Desktop-side test plugin (mirror + its transport client) to the Windows test folder that Desktop installs
# with link:. After copying, Desktop must be fully restarted for the new code to load.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
dest="${1:-/mnt/c/Users/S/dsh-wsl-test/mirror}"
cp "$here/experiments/transport/mux.mjs" "$here/experiments/transport/client.mjs" "$here/experiments/mirror/mirror/transport/"
mkdir -p "$dest/transport"
cp "$here"/experiments/mirror/mirror/{index.mjs,merge.mjs,routes.mjs,settings.mjs,plugins.mjs,paths.mjs,client.js,package.json,cordis.patch.yml} "$dest/"
cp "$here"/experiments/mirror/mirror/transport/{mux.mjs,client.mjs} "$dest/transport/"
echo "copied to $dest"
