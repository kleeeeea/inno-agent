#!/usr/bin/env bash
# 根据/Users/l/other_git_repos/inno-agent/QUICKSTART.md 实现
set -euo pipefail

cd "$(dirname "$0")"

# 端口可通过第一个参数指定，默认 3000
PORT="${1:-3000}"

# pnpm/node 由 nvm 提供；有的终端 pane 没加载 nvm，会导致 which pnpm 静默失败 + set -e 直接退出
# （现象：脚本无任何输出、退出码 1）。这里主动加载 nvm 兜底
if ! command -v pnpm >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
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
# pnpm 找不到就回退 npm（本仓库本来就是 npm workspaces，package-lock.json 在）
if command -v pnpm >/dev/null 2>&1; then
  PKG=pnpm
elif command -v npm >/dev/null 2>&1; then
  PKG=npm
  echo "未找到 pnpm，回退使用 npm"
else
  echo "错误：pnpm 和 npm 都不在 PATH（这个终端没加载 nvm？先执行：source ~/.nvm/nvm.sh）"
  exit 1
fi
echo "使用包管理器：$(command -v "$PKG")"
# 安装依赖（会从 npm 拉 Pi SDK；lockfile 没变时秒级完成）
"$PKG" install

# 编译 backend + 前端（约 15s）：dist 已存在时默认跳过，改了代码后用 BUILD=1 强制重新编译
if [ "${BUILD:-0}" = "1" ] || [ ! -f apps/inno-agent/dist/server.js ] || [ ! -f apps/inno-agent/web/dist/index.html ]; then
  "$PKG" run build
else
  echo "跳过编译（dist 已存在）；改了代码请用 BUILD=1 bash install_run.sh 重新编译"
fi

# 初始化 runtime / workspace 目录和配置
mkdir -p runtime/config runtime/data runtime/skills workspace
if [ ! -f runtime/config/config.json ]; then
  cp config.example.json runtime/config/config.json
  echo "已生成 runtime/config/config.json，请编辑其中的 providers[*].apiKey"
fi
if grep -q '"apiKey": *"replace-me"' runtime/config/config.json 2>/dev/null; then
  echo "警告：runtime/config/config.json 的 apiKey 还是占位符 replace-me，agent 将无法调用模型"
fi

# 端口占用预检查，避免启动到一半才报 EADDRINUSE：占用时直接 kill 掉占用进程
if lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "端口 ${PORT} 已被占用，kill 掉占用进程："
  lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN
  lsof -nP -tiTCP:"${PORT}" -sTCP:LISTEN | xargs kill 2>/dev/null || true
  sleep 1
  # 还没退出就强杀
  if lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
    lsof -nP -tiTCP:"${PORT}" -sTCP:LISTEN | xargs kill -9 2>/dev/null || true
    sleep 1
  fi
fi

echo "启动服务："
echo "  Web UI：  http://localhost:${PORT}"
echo "  健康检查：http://localhost:${PORT}/health"

# 直接跑编译产物，避免 pnpm -> npm 转发参数时多出一个字面量 "--"
exec node apps/inno-agent/dist/server.js --home ./runtime --workspace ./workspace --port "${PORT}"
