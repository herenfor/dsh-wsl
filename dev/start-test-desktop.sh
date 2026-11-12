#!/usr/bin/env bash
# Start the test "Desktop" (see dev/README.md) and print the page token; open http://127.0.0.1:$DESK_PORT/?token=<token>.
#   dev/start-test-desktop.sh            the WSL side runs in the fake home ($FAKE_HOME)
#   dev/start-test-desktop.sh --real     the WSL side runs in your real home: it replaces your real daemon. Ask first.
# The plugin is linked to this checkout, so changes show after a restart (the plugin asks for one when it is loaded
# more than 60 s after the Host started). The environment passes through, e.g.
#   DEEPSEEK_API_KEY=sk-demo-not-a-real-key   no sign-in dialog, model names shown
#   DEEPSEEK_BASE_URL=http://127.0.0.1:47900/anthropic   models answered by dev/screenshots/mock-llm.mjs
#   SETTLE=0                                   return as soon as the page is served (default waits 8 s for WSL)
set -euo pipefail
source "$(dirname "$0")/env.sh"
target="$FAKE_HOME"; [ "${1:-}" = --real ] && target="$REAL_HOME"

"$DEV_DIR/stop-test-desktop.sh"
mkdir -p "$DESK_HOME" "$FAKE_HOME"
if [ ! -f "$DESK_HOME/.dsh/profiles/web/package.json" ]; then
  echo "first run: creating the test Desktop's profile in $DESK_HOME" >&2
  HOME="$DESK_HOME" DSH_HOME="$DESK_HOME/.dsh" "$DSH_BIN" plugin --profile web add "link:$REPO_DIR/experiments/mirror/mirror" >&2
fi
rm -f "$ROUTING_LOG"
HOME="$DESK_HOME" DSH_HOME="$DESK_HOME/.dsh" REAL_HOME="$REAL_HOME" FAKE_HOME="$target" \
  DSH_WSL_COMMAND="$DEV_DIR/fakewsl/wsl" DSH_WSL_NO_BROKER=1 DSH_WSL_DEBUG="$ROUTING_LOG" \
  setsid nohup "$DSH_BIN" --profile web --no-open --host 127.0.0.1 --port "$DESK_PORT" > "$DESK_LOG" 2>&1 < /dev/null &
for _ in $(seq 1 60); do grep -q "dsh web:" "$DESK_LOG" 2>/dev/null && break; sleep 1; done
grep -q "dsh web:" "$DESK_LOG" || { echo "the test Desktop did not start; see $DESK_LOG" >&2; exit 1; }
sleep "${SETTLE:-8}"
grep -o 'token=[^ ]*' "$DESK_LOG" | tail -1 | cut -d= -f2
