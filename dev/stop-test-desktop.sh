#!/usr/bin/env bash
# Stop the test "Desktop" and wait for the fake WSL side to exit (it leaves 5 s after the last Desktop).
set -euo pipefail
source "$(dirname "$0")/env.sh"
pids="$(desk_pids)"
[ -n "$pids" ] && kill $pids
for _ in $(seq 1 30); do
  ps -eo args | grep -qF "$FAKE_HOME/.dsh-wsl/bridge/transport/daemon.mjs --serve" || break
  sleep 1
done
exit 0
