#!/usr/bin/env bash
# The whole cross-host scan (docs/cross-host-scan.md) in the test environment: start the test Desktop in reuse mode,
# list every method, ask the read-only ones on each side, try the setting writes, print the summary. Results go to
# $DESK_HOME/scan (inventory.json, probe.json, dynamic.json, summary.txt). Test environment only.
#   dev/scan/run.sh            everything
#   dev/scan/run.sh read       without the writes (dynamic.mjs)
# dynamic.mjs puts every setting back itself; as a second guard this script keeps copies of the test Desktop's
# config.json and the profiles' cordis.patch.yml and copies them back after stopping, if they changed.
set -euo pipefail
source "$(dirname "$0")/../env.sh"
OUT="$DESK_HOME/scan"; mkdir -p "$OUT/backup"
CONFIG="$DESK_HOME/.dsh-wsl/config.json"
PATCHES=("$DESK_HOME/.dsh/profiles/web/cordis.patch.yml" "$FAKE_HOME/.dsh/profiles/desktop-wsl/cordis.patch.yml" "$FAKE_HOME/.dsh/profiles/web/cordis.patch.yml")
only="${1:-all}"
export DEEPSEEK_API_KEY=sk-demo-not-a-real-key

[ -f "$CONFIG" ] && cp "$CONFIG" "$OUT/backup/config.json"
for i in "${!PATCHES[@]}"; do [ -f "${PATCHES[$i]}" ] && cp "${PATCHES[$i]}" "$OUT/backup/patch-$i.yml"; done
restore() {
  "$DEV_DIR/stop-test-desktop.sh"
  if [ -f "$OUT/backup/config.json" ]; then cp "$OUT/backup/config.json" "$CONFIG"; else rm -f "$CONFIG"; fi
  for i in "${!PATCHES[@]}"; do
    b="$OUT/backup/patch-$i.yml"
    if [ -f "$b" ] && ! cmp -s "$b" "${PATCHES[$i]}"; then cp "$b" "${PATCHES[$i]}"; echo "put back ${PATCHES[$i]}" >&2; fi
  done
}
trap restore EXIT

mkdir -p "$(dirname "$CONFIG")"; echo '{"mode":"reuse"}' > "$CONFIG"
SETTLE="${SETTLE:-20}" "$DEV_DIR/start-test-desktop.sh" > "$DESK_HOME/token"
node "$DEV_DIR/scan/inventory.mjs" "$OUT/inventory.json" > "$OUT/inventory.txt"
HOME="$FAKE_HOME" node "$DEV_DIR/scan/probe.mjs" "$OUT/inventory.json" "$OUT/probe.json" 2> "$OUT/probe.log"
rm -f "$OUT/dynamic.json"
[ "$only" = read ] || HOME="$FAKE_HOME" node "$DEV_DIR/scan/dynamic.mjs" "$OUT/dynamic.json" 2> "$OUT/dynamic.log"
node "$DEV_DIR/scan/summary.mjs" "$OUT" | tee "$OUT/summary.txt"
echo "results in $OUT (inventory.txt lists the methods that never reach the WSL Host)" >&2
