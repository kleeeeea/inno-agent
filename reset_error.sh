#!/usr/bin/env bash
# Reset local Inno Agent dev errors without touching user config or workspace data.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

PORT="${INNO_PORT:-3000}"
WEB_PORT="${INNO_WEB_PORT:-5173}"
INNO_HOME="${INNO_HOME:-./runtime}"
CLEAR_LOGS=true
CLEAR_VITE_CACHE=true

usage() {
  cat <<USAGE
Usage: ./reset_error.sh [options]

Stops local Inno Agent dev processes, frees backend/Vite ports, removes stale pid
files, clears dev caches, and optionally truncates logs. It preserves:
  - runtime/config/config.json
  - runtime/data except log file contents
  - workspace/
  - node_modules/

Options:
  --port <n>         backend port to free       (default: ${PORT})
  --web-port <n>     Vite port to free          (default: ${WEB_PORT})
  --home <path>      runtime home dir           (default: ${INNO_HOME})
  --keep-logs        do not truncate *.log files
  --keep-vite-cache  do not remove Vite cache directories
  -h, --help         show this help

Examples:
  ./reset_error.sh
  ./reset_error.sh --port 3001 --web-port 5174
  ./reset_error.sh --keep-logs
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --web-port) WEB_PORT="$2"; shift 2 ;;
    --home) INNO_HOME="$2"; shift 2 ;;
    --keep-logs) CLEAR_LOGS=false; shift ;;
    --keep-vite-cache) CLEAR_VITE_CACHE=false; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

abs_path() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *) printf '%s\n' "$ROOT/${1#./}" ;;
  esac
}

HOME_ABS="$(abs_path "$INNO_HOME")"
LOG_DIR="$HOME_ABS/logs"
DATA_LOG_DIR="$HOME_ABS/data/log"

color() { local c="$1"; shift; printf '\033[%sm%s\033[0m' "$c" "$*"; }
ok() { printf '%s %s\n' "$(color '32' 'OK')" "$*"; }
info() { printf '%s %s\n' "$(color '36' 'INFO')" "$*"; }
warn() { printf '%s %s\n' "$(color '33' 'WARN')" "$*"; }

pid_alive() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

kill_pidfile() {
  local file="$1"
  local pid=""
  [[ -f "$file" ]] && pid="$(cat "$file" 2>/dev/null || true)"
  if pid_alive "$pid"; then
    info "stopping pid $pid from $file"
    kill "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      pid_alive "$pid" || break
      sleep 0.2
    done
    pid_alive "$pid" && kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$file"
}

free_port() {
  local port="$1"
  local pids=""
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    warn "freeing port $port: $pids"
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    sleep 0.5
    pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "$pids" ]]; then
      # shellcheck disable=SC2086
      kill -9 $pids 2>/dev/null || true
    fi
  fi
}

truncate_logs_in() {
  local dir="$1"
  [[ -d "$dir" ]] || return 0
  while IFS= read -r -d '' file; do
    : > "$file"
  done < <(find "$dir" -type f -name '*.log' -print0)
}

remove_stale_state() {
  mkdir -p "$LOG_DIR"
  kill_pidfile "$LOG_DIR/server.pid"
  kill_pidfile "$LOG_DIR/vite.pid"

  find "$LOG_DIR" -type f \( -name '*.pid' -o -name '*.lock' \) -delete 2>/dev/null || true

  if [[ "$CLEAR_LOGS" == true ]]; then
    truncate_logs_in "$LOG_DIR"
    truncate_logs_in "$DATA_LOG_DIR"
    ok "logs truncated"
  else
    info "keeping logs"
  fi

  if [[ "$CLEAR_VITE_CACHE" == true ]]; then
    rm -rf "$ROOT/node_modules/.vite" \
           "$ROOT/node_modules/.cache/vite" \
           "$ROOT/apps/inno-agent/web/node_modules/.vite" \
           "$ROOT/apps/inno-agent/web/node_modules/.cache/vite"
    ok "Vite cache cleared"
  else
    info "keeping Vite cache"
  fi
}

info "resetting local Inno Agent dev state"
info "root=$ROOT"
info "home=$HOME_ABS"

# Prefer the project orchestrator's stop path when available; then apply local cleanup.
if [[ -x "$ROOT/restart-dev.sh" ]]; then
  bash "$ROOT/restart-dev.sh" stop --mode dev --home "$INNO_HOME" --port "$PORT" --web-port "$WEB_PORT" >/dev/null 2>&1 || true
fi

pkill -f "$ROOT/apps/inno-agent/dist/server.js" 2>/dev/null || true
pkill -f "vite.*--port ${WEB_PORT}" 2>/dev/null || true
free_port "$PORT"
free_port "$WEB_PORT"
remove_stale_state

ok "reset complete"
echo "Next:"
echo "  bash install_run.sh ${PORT}"
echo "  bash run_realtime_updating_client.sh ${WEB_PORT} ${PORT}"
