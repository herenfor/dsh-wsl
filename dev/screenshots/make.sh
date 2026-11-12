#!/usr/bin/env bash
# Retake the README screenshots (dark theme, zh and en) into docs/screenshots. Test environment only, never the real
# Desktop. Needs the demo data described in dev/README.md and Playwright's chromium headless shell (dev/shot.mjs).
#   dev/screenshots/make.sh          all sets
#   dev/screenshots/make.sh main     only home, picker, plugins, detail   (also: first, bot)
# The DS Bot shot runs against mock-llm.mjs: the replies are scripted, the command it runs in WSL is real. The READMEs
# say so under the screenshots; keep that note if you change the script.
set -euo pipefail
source "$(dirname "$0")/../env.sh"
OUT="$DESK_HOME/shots"; mkdir -p "$OUT"
CONFIG="$DESK_HOME/.dsh-wsl/config.json"
MOCK_PORT="${MOCK_PORT:-47900}"
BOT_SESSIONS="$FAKE_HOME/.dsh/sessions/-$(printf %s "$FAKE_HOME/.dsh/bot/workspace" | tr / -)--"
only="${1:-all}"
export DEEPSEEK_API_KEY=sk-demo-not-a-real-key

# Put back what the run changes: the test Desktop's config.json and the fake DS Bot data (with the workspace list).
[ -f "$CONFIG" ] && cp "$CONFIG" "$OUT/config.json.before"
rm -rf "$OUT/dsbot-backup"; mkdir -p "$OUT/dsbot-backup"
[ -d "$FAKE_HOME/.dsh/bot" ] && cp -a "$FAKE_HOME/.dsh/bot" "$OUT/dsbot-backup/bot"
[ -d "$BOT_SESSIONS" ] && cp -a "$BOT_SESSIONS" "$OUT/dsbot-backup/sessions"
# The WSL Host lists each workspace's sessions here; without it Chief would come back outside the DS Bot folder.
[ -f "$FAKE_HOME/.dsh/storages/workspace.json" ] && cp "$FAKE_HOME/.dsh/storages/workspace.json" "$OUT/dsbot-backup/workspace.json"
mock=""
restore() {
  "$DEV_DIR/stop-test-desktop.sh"
  [ -n "$mock" ] && kill "$mock" 2>/dev/null || true
  if [ -f "$OUT/config.json.before" ]; then cp "$OUT/config.json.before" "$CONFIG"; else rm -f "$CONFIG"; fi
  if [ -d "$OUT/dsbot-backup/bot" ]; then rm -rf "$FAKE_HOME/.dsh/bot"; cp -a "$OUT/dsbot-backup/bot" "$FAKE_HOME/.dsh/bot"; fi
  if [ -d "$OUT/dsbot-backup/sessions" ]; then rm -rf "$BOT_SESSIONS"; cp -a "$OUT/dsbot-backup/sessions" "$BOT_SESSIONS"; fi
  if [ -f "$OUT/dsbot-backup/workspace.json" ]; then cp "$OUT/dsbot-backup/workspace.json" "$FAKE_HOME/.dsh/storages/workspace.json"; fi
}
trap restore EXIT

mode() { mkdir -p "$(dirname "$CONFIG")"; if [ "$1" = none ]; then rm -f "$CONFIG"; else echo "{\"mode\":\"$1\"}" > "$CONFIG"; fi; }
shoot() { # <lang> <set> [first wait ms]
  node "$DEV_DIR/screenshots/steps.mjs" "$1" "$2" > "$OUT/steps-$1-$2.json"
  DARK=1 LOCALE="$1" PRELOAD="$DEV_DIR/preload-wsl.js" FIRST_WAIT="${3:-15000}" \
    node "$DEV_DIR/shot.mjs" "http://127.0.0.1:$DESK_PORT/?token=$token" "$OUT" "$OUT/steps-$1-$2.json" > "$OUT/result-$1-$2.json"
  echo "shot $1 $2"
}

if [ "$only" = all ] || [ "$only" = main ]; then
  mode reuse; token="$("$DEV_DIR/start-test-desktop.sh")"
  for l in zh en; do shoot "$l" main 25000; done
fi
if [ "$only" = all ] || [ "$only" = first ]; then
  mode none; token="$("$DEV_DIR/start-test-desktop.sh")"
  for l in zh en; do shoot "$l" first; done
fi
if [ "$only" = all ] || [ "$only" = bot ]; then
  mode reuse
  node "$DEV_DIR/screenshots/mock-llm.mjs" "$MOCK_PORT" "$OUT/mock.log" & mock=$!
  for l in zh en; do
    "$DEV_DIR/stop-test-desktop.sh"
    rm -f "$FAKE_HOME/.dsh/bot/state.json"; rm -rf "$BOT_SESSIONS"/session-*   # a fresh Main Bot greets in $l
    curl -sf "http://127.0.0.1:$MOCK_PORT/__lang/$l" > /dev/null
    token="$(DEEPSEEK_BASE_URL="http://127.0.0.1:$MOCK_PORT/anthropic" "$DEV_DIR/start-test-desktop.sh")"
    shoot "$l" bot 25000
  done
fi

for f in "$OUT"/{home,picker,plugins,detail,setup,bot}-{zh,en}.webp; do [ -f "$f" ] && cp "$f" "$REPO_DIR/docs/screenshots/"; done
echo "copied into docs/screenshots; look at them before committing (git diff --stat docs/screenshots)"
