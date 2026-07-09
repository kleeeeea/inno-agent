#!/usr/bin/env bash
# 在 install_run.sh 启动的后端（默认 :3000）基础上，起一个实时更新（Vite HMR）的前端。
# 用法：
#   bash run_realtime_updating_client.sh            # 前端跑在 5173
#   bash run_realtime_updating_client.sh 5174       # 换个前端端口
#   bash run_realtime_updating_client.sh 5174 3001  # 后端不在 3000 时指定后端端口
set -euo pipefail

cd "$(dirname "$0")"

WEB_PORT="${1:-5173}"
BACKEND_PORT="${2:-3000}"

# npm/node 由 nvm 提供；有的终端 pane 没加载 nvm 会找不到 npm，这里主动加载兜底
if ! command -v npm >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
  set +u  # nvm.sh 里有未定义变量，临时关掉 -u
  . "$HOME/.nvm/nvm.sh"
  set -u
fi
# nvm 的 default alias 坏掉（指向未安装版本）时 nvm.sh 不会把 node 加进 PATH，
# 直接把已安装的最新 node 的 bin 目录塞进 PATH 兜底
if ! command -v npm >/dev/null 2>&1; then
  NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"
  if [ -n "${NODE_BIN}" ]; then
    export PATH="${NODE_BIN}:${PATH}"
    echo "PATH 里没有 node/npm，已兜底使用：${NODE_BIN}"
  fi
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "错误：npm 不在 PATH（nvm 没装或没装任何 node 版本）"
  exit 1
fi

# 前提检查：后端必须已经在跑（先 bash install_run.sh）
if ! curl -sf "http://localhost:${BACKEND_PORT}/health" >/dev/null 2>&1; then
  echo "错误：后端 http://localhost:${BACKEND_PORT}/health 没响应"
  echo "请先在另一个终端运行：bash install_run.sh ${BACKEND_PORT}"
  exit 1
fi

# 前端端口占用预检查：占用时直接 kill 掉占用进程
if lsof -nP -iTCP:"${WEB_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "端口 ${WEB_PORT} 已被占用，kill 掉占用进程："
  lsof -nP -iTCP:"${WEB_PORT}" -sTCP:LISTEN
  lsof -nP -tiTCP:"${WEB_PORT}" -sTCP:LISTEN | xargs kill 2>/dev/null || true
  sleep 1
  # 还没退出就强杀
  if lsof -nP -iTCP:"${WEB_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
    lsof -nP -tiTCP:"${WEB_PORT}" -sTCP:LISTEN | xargs kill -9 2>/dev/null || true
    sleep 1
  fi
fi

echo "启动实时更新前端（Vite dev server，改 web/src 下的代码即时热更新）："
echo "  前端开发页： http://localhost:${WEB_PORT}"
echo "  API 代理到： http://localhost:${BACKEND_PORT}"

# 注意：仓库是 npm workspaces（没有 pnpm-workspace.yaml），vite 装在根 node_modules，
# 必须用 npm --workspace 从根目录跑，才能找到 vite 可执行文件
# INNO_BACKEND_PORT：vite.config.ts 里 /api、/health 代理目标读这个环境变量（默认 3000）
# --strictPort：端口被抢时直接报错而不是静默换端口
INNO_BACKEND_PORT="${BACKEND_PORT}" exec npm --workspace inno-agent-web run dev -- --port "${WEB_PORT}" --strictPort
