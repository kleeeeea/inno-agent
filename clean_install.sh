#!/usr/bin/env bash
# Cleanly reinstall Inno Agent dependencies from the repository root.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

PKG="${PKG:-npm}"
BUILD=true
START_AFTER=false
PORT="${INNO_PORT:-3000}"
WEB_PORT="${INNO_WEB_PORT:-5173}"
CLEAN_DIST=false
RESET_FIRST=true

usage() {
  cat <<USAGE
Usage: ./clean_install.sh [options]

Stops local dev services, removes installed dependencies, reinstalls workspace
dependencies, and builds the project by default. It preserves runtime/config and
workspace data.

Options:
  --pkg npm|pnpm      package manager to use        (default: ${PKG})
  --no-build          install only, skip npm run build
  --clean-dist        also remove build output before building
  --no-reset          do not run reset_error.sh first
  --start             run install_run.sh after install/build
  --port <n>          backend port for reset/start   (default: ${PORT})
  --web-port <n>      Vite port for reset            (default: ${WEB_PORT})
  -h, --help          show this help

Examples:
  ./clean_install.sh
  ./clean_install.sh --no-build
  ./clean_install.sh --clean-dist --start
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pkg) PKG="$2"; shift 2 ;;
    --no-build) BUILD=false; shift ;;
    --clean-dist) CLEAN_DIST=true; shift ;;
    --no-reset) RESET_FIRST=false; shift ;;
    --start) START_AFTER=true; shift ;;
    --port) PORT="$2"; shift 2 ;;
    --web-port) WEB_PORT="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

color() { local c="$1"; shift; printf '\033[%sm%s\033[0m' "$c" "$*"; }
ok() { printf '%s %s\n' "$(color '32' 'OK')" "$*"; }
info() { printf '%s %s\n' "$(color '36' 'INFO')" "$*"; }
warn() { printf '%s %s\n' "$(color '33' 'WARN')" "$*"; }
fail() { printf '%s %s\n' "$(color '31' 'ERR')" "$*"; }

load_node_path() {
  if ! command -v npm >/dev/null 2>&1 && [[ -s "$HOME/.nvm/nvm.sh" ]]; then
    set +u
    # shellcheck disable=SC1090
    . "$HOME/.nvm/nvm.sh"
    set -u
  fi
  if ! command -v npm >/dev/null 2>&1; then
    local node_bin=""
    node_bin="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1 || true)"
    if [[ -n "$node_bin" ]]; then
      export PATH="$node_bin:$PATH"
      info "PATH fallback: $node_bin"
    fi
  fi
}

install_deps() {
  case "$PKG" in
    npm)
      command -v npm >/dev/null 2>&1 || { fail "npm not found"; exit 1; }
      if [[ -f package-lock.json ]]; then
        info "running npm ci"
        npm ci
      else
        info "running npm install"
        npm install
      fi
      ;;
    pnpm)
      command -v pnpm >/dev/null 2>&1 || { fail "pnpm not found"; exit 1; }
      info "running pnpm install --frozen-lockfile"
      pnpm install --frozen-lockfile
      ;;
    *)
      fail "unsupported package manager: $PKG"
      exit 1
      ;;
  esac
}

run_pkg_script() {
  local script="$1"
  case "$PKG" in
    npm) npm run "$script" ;;
    pnpm) pnpm run "$script" ;;
  esac
}

info "clean install root=$ROOT"
load_node_path

if [[ "$RESET_FIRST" == true ]]; then
  if [[ -x "$ROOT/reset_error.sh" ]]; then
    bash "$ROOT/reset_error.sh" --port "$PORT" --web-port "$WEB_PORT" --keep-logs
  else
    warn "reset_error.sh is missing or not executable; skipping reset"
  fi
fi

info "removing installed dependencies"
rm -rf "$ROOT/node_modules" \
       "$ROOT/apps/inno-agent/node_modules" \
       "$ROOT/apps/inno-agent/web/node_modules"

if [[ "$CLEAN_DIST" == true ]]; then
  info "removing build output"
  rm -rf "$ROOT/apps/inno-agent/dist" \
         "$ROOT/apps/inno-agent/web/dist" \
         "$ROOT/dist-electron"
fi

install_deps
ok "dependencies installed"

if [[ "$BUILD" == true ]]; then
  info "running build"
  run_pkg_script build
  ok "build complete"
else
  info "build skipped"
fi

if [[ "$START_AFTER" == true ]]; then
  info "starting backend on port $PORT"
  exec bash "$ROOT/install_run.sh" "$PORT"
fi

ok "clean install complete"
echo "Next:"
echo "  bash install_run.sh ${PORT}"
echo "  bash run_realtime_updating_client.sh ${WEB_PORT} ${PORT}"
