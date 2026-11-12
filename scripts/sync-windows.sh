#!/usr/bin/env bash
# Development only: assemble the Desktop-side plugin and copy it to a Windows test folder that a Desktop installs with
# link:. After copying, Desktop must be fully restarted for the new code to load. A Desktop that installed the plugin
# from npm does not use this folder. The folder is always given: copying over a folder some Desktop still links to
# replaces the plugin that Desktop runs.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
dest="${1:?usage: scripts/sync-windows.sh <Windows test folder a Desktop links to, e.g. /mnt/c/Users/<you>/dsh-wsl-test/mirror>}"
m="$here/experiments/mirror/mirror"
"$here/scripts/assemble.sh" > /dev/null
mkdir -p "$dest/transport" "$dest/agent" "$dest/locale"
cp "$m"/*.mjs "$m"/{client.js,package.json,cordis.patch.yml,icon.svg,README.md,README.zh.md,LICENSE} "$dest/"
cp "$m"/locale/*.json "$dest/locale/"
cp "$m"/transport/* "$dest/transport/"
cp "$m"/agent/* "$dest/agent/"
echo "copied to $dest"
