#!/usr/bin/env bash
# Pull the current remote branch, reinstall with npm, and start Inno Agent.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

PORT="${1:-3000}"
REMOTE="${REMOTE:-origin}"
BRANCH="${BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"

echo "root=${ROOT}"
echo "remote=${REMOTE}"
echo "branch=${BRANCH}"
echo "port=${PORT}"

if [ "${PULL:-1}" = "1" ]; then
  git fetch "${REMOTE}" "${BRANCH}"
  git pull --ff-only "${REMOTE}" "${BRANCH}"
else
  echo "跳过 git pull（PULL=0）"
fi

PKG=npm bash "$ROOT/clean_install.sh" --pkg npm --port "$PORT"
PKG=npm exec bash "$ROOT/install_run.sh" "$PORT"
