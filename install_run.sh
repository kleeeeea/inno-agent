#!/usr/bin/env bash
# 根据/Users/l/other_git_repos/inno-agent/QUICKSTART.md 实现
set -euo pipefail

cd "$(dirname "$0")"

# 端口可通过第一个参数指定，默认 3000
PORT="${1:-3000}"

which pnpm
# 安装依赖（会从 npm 拉 Pi SDK；lockfile 没变时秒级完成）
pnpm install

# 编译 backend + 前端（约 15s）：dist 已存在时默认跳过，改了代码后用 BUILD=1 强制重新编译
if [ "${BUILD:-0}" = "1" ] || [ ! -f apps/inno-agent/dist/server.js ] || [ ! -f apps/inno-agent/web/dist/index.html ]; then
  pnpm run build
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

# 端口占用预检查，避免启动到一半才报 EADDRINUSE
if lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "错误：端口 ${PORT} 已被占用："
  lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN
  echo "换个端口运行：bash install_run.sh $((PORT + 1))"
  exit 1
fi

echo "启动服务："
echo "  Web UI：  http://localhost:${PORT}"
echo "  健康检查：http://localhost:${PORT}/health"

# 直接跑编译产物，避免 pnpm -> npm 转发参数时多出一个字面量 "--"
exec node apps/inno-agent/dist/server.js --home ./runtime --workspace ./workspace --port "${PORT}"
