# Shared settings for the dev scripts (sourced, not run). Each can be overridden from the environment.
DEV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$DEV_DIR")"
REAL_HOME="${REAL_HOME:-$HOME}"
# Home of the fake WSL distribution: the WSL side of the test runs here, never in your real home.
FAKE_HOME="${DSH_WSL_DEV_FAKE_HOME:-$REAL_HOME/dshwsl-fh}"
# The test "Desktop": a `dsh web` on Linux standing in for Windows Desktop. Its HOME and DSH_HOME, so what it
# writes as "Windows" (~/.dsh-wsl/config.json, setup-probe.log, bridge.log) stays out of your real ~/.dsh-wsl.
DESK_HOME="${DSH_WSL_DEV_DESK_HOME:-$REAL_HOME/dshwsl-desk}"
DESK_PORT="${DSH_WSL_DEV_PORT:-47102}"
DESK_LOG="$DESK_HOME/desktop.log"
ROUTING_LOG="$DESK_HOME/routing-debug.log"
# The dsh that serves the test Desktop.
DSH_BIN="${DSH_WSL_DEV_DSH:-$(command -v dsh)}"
desk_pids() { ps -eo pid,args | awk -v p="--port $DESK_PORT" 'index($0, "dsh --profile web --no-open --host 127.0.0.1 " p) && !/awk/ {print $1}'; }
