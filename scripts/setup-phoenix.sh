#!/usr/bin/env bash
# setup-phoenix.sh — Start Arize Phoenix server for pi-phoenix-learning
#
# Usage:
#   ./scripts/setup-phoenix.sh              # start Phoenix server
#   ./scripts/setup-phoenix.sh --daemon     # start in background
#   ./scripts/setup-phoenix.sh --stop       # stop running server
#   ./scripts/setup-phoenix.sh --status     # check if running

set -euo pipefail

PHOENIX_PORT="${PHOENIX_PORT:-6006}"
PHOENIX_HOST="0.0.0.0"
PHOENIX_LOG_DIR="${PHOENIX_LOG_DIR:-/tmp/phoenix-logs}"
PID_FILE="/tmp/phoenix-server.pid"

# Try to find phoenix binary
find_phoenix() {
  # Check common locations
  for cmd in \
    "$(which phoenix 2>/dev/null)" \
    "$(command -v phoenix 2>/dev/null)" \
    "/root/docs_config_memo/.venv/bin/phoenix" \
    "$HOME/.local/bin/phoenix"; do
    if [ -n "$cmd" ] && [ -x "$cmd" ]; then
      echo "$cmd"
      return 0
    fi
  done

  # Try pip-installed
  if python3 -c "import phoenix" 2>/dev/null; then
    echo "phoenix"
    return 0
  fi

  return 1
}

start_phoenix() {
  local daemon="${1:-false}"

  local phoenix
  phoenix=$(find_phoenix) || {
    echo "❌ Phoenix not found. Install with:"
    echo "   pip install arize-phoenix"
    echo "   # or"
    echo "   uv tool install arize-phoenix"
    exit 1
  }

  mkdir -p "$PHOENIX_LOG_DIR"

  echo "🚀 Starting Phoenix server on http://localhost:$PHOENIX_PORT ..."

  if [ "$daemon" = "true" ]; then
    nohup "$phoenix" serve \
      --port "$PHOENIX_PORT" \
      --host "$PHOENIX_HOST" \
      > "$PHOENIX_LOG_DIR/phoenix.log" 2>&1 &
    local pid=$!
    echo "$pid" > "$PID_FILE"
    echo "✅ Phoenix started (PID: $pid)"
    echo "   Logs: $PHOENIX_LOG_DIR/phoenix.log"
    echo "   UI:   http://localhost:$PHOENIX_PORT"
  else
    exec "$phoenix" serve \
      --port "$PHOENIX_PORT" \
      --host "$PHOENIX_HOST"
  fi
}

stop_phoenix() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid=$(cat "$PID_FILE")
    if kill "$pid" 2>/dev/null; then
      echo "✅ Phoenix stopped (PID: $pid)"
    else
      echo "⚠️  Phoenix not running (stale PID file)"
    fi
    rm -f "$PID_FILE"
  else
    # Try pkill
    if pkill -f "phoenix serve" 2>/dev/null; then
      echo "✅ Phoenix stopped"
    else
      echo "ℹ️  Phoenix is not running"
    fi
  fi
}

status_phoenix() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      echo "✅ Phoenix is running (PID: $pid)"
      echo "   UI: http://localhost:$PHOENIX_PORT"
      return 0
    else
      echo "⚠️  Stale PID file (process $pid not running)"
      rm -f "$PID_FILE"
    fi
  fi

  if curl -sf "http://localhost:$PHOENIX_PORT/health" > /dev/null 2>&1; then
    echo "✅ Phoenix is running on http://localhost:$PHOENIX_PORT"
    return 0
  fi

  echo "❌ Phoenix is not running"
  return 1
}

# ── Main ──────────────────────────────────────────────────────────────────────

case "${1:-}" in
  --daemon|-d)
    start_phoenix true
    ;;
  --stop)
    stop_phoenix
    ;;
  --status)
    status_phoenix
    ;;
  --help|-h)
    echo "Usage: $0 [--daemon|--stop|--status|--help]"
    echo ""
    echo "  (no args)   Start Phoenix server (foreground)"
    echo "  --daemon    Start Phoenix in background"
    echo "  --stop      Stop running Phoenix server"
    echo "  --status    Check if Phoenix is running"
    echo "  --help      Show this help"
    exit 0
    ;;
  "")
    start_phoenix false
    ;;
  *)
    echo "❌ Unknown option: $1"
    echo "Usage: $0 [--daemon|--stop|--status|--help]"
    exit 1
    ;;
esac
