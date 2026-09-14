#!/usr/bin/env bash
# start-relay.sh — 一键启动本地 relay，可选 Hub uplink
# 用法：bash scripts/start-relay.sh
#
# 可覆盖的环境变量：
#   MESH_HUB_URL      Hub 地址；不设则读 ~/.ccmesh/hub-url 文件；都没有 = 禁用 Hub（纯本机模式）
#   MESH_DEVICE_ID    默认 hostname -s（小写）
#   MESH_TERMINAL     默认 tmux
#   RELAY_HTTP_PORT   默认 19800
#   MESH_RELAY_SESSION 默认 cc-mesh-relay

set -e

if [ -n "${MESH_HUB_URL+x}" ]; then
  HUB_URL="$MESH_HUB_URL"
elif [ -f "$HOME/.ccmesh/hub-url" ]; then
  HUB_URL="$(head -n 1 "$HOME/.ccmesh/hub-url" | tr -d '[:space:]')"
else
  HUB_URL=""
fi
DEVICE_ID="${MESH_DEVICE_ID:-$(hostname -s | tr '[:upper:]' '[:lower:]')}"
# MESH_TERMINAL 不设默认值，让 relay 自己 auto-detect：
#   iTerm+tmux 都有 → CompositeTerminal（MacBook 混合场景，按 UUID 格式 dispatch）
#   仅 tmux → TmuxTerminal（Linux 云端/computer2/Mini）
#   仅 iTerm → ITermTerminal
# 如显式需要单后端，外部导出 MESH_TERMINAL=tmux 即可 override
TERMINAL="${MESH_TERMINAL:-}"
PORT="${RELAY_HTTP_PORT:-19800}"
LOG="${MESH_RELAY_LOG:-/tmp/mesh-relay.log}"
SESSION="${MESH_RELAY_SESSION:-cc-mesh-relay}"

cd "$(dirname "$0")/.."

# 幂等 guard：relay 已在跑就直接退出（传 --force 强制重启）
if [ "${1:-}" != "--force" ]; then
  if curl -sm 2 --noproxy '*' "http://localhost:$PORT/api/status" >/dev/null 2>&1; then
    echo "→ relay 已在跑 (port $PORT)，status:"
    curl -sm 2 --noproxy '*' "http://localhost:$PORT/api/status"
    echo
    echo "   如需重启：bash scripts/start-relay.sh --force"
    exit 0
  fi
fi

# 编译产物检查
if [ ! -f packages/relay/dist/index.js ]; then
  echo "→ relay 未编译，运行 pnpm -r build"
  pnpm -r build
fi

# 关闭旧 relay（--force 或端口占用但无响应）
if [ "${1:-}" = "--force" ]; then
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  rm -f "$HOME/.ccmesh/relay.pid" 2>/dev/null || true
fi

OLD_PID=$(lsof -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null || true)
if [ -n "$OLD_PID" ]; then
  echo "→ 关闭旧 relay (pid=$OLD_PID)"
  kill $OLD_PID 2>/dev/null || true
  sleep 2
fi

# 启动
echo "→ 启动 relay"
echo "   device_id : $DEVICE_ID"
echo "   hub_url   : $HUB_URL"
echo "   terminal  : ${TERMINAL:-<auto-detect>}"
echo "   port      : $PORT"
echo "   log       : $LOG"
echo "   tmux      : $SESSION"

quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

cmd="env MESH_HUB_URL=$(quote "$HUB_URL") MESH_DEVICE_ID=$(quote "$DEVICE_ID") RELAY_HTTP_PORT=$(quote "$PORT")"
if [ -n "$TERMINAL" ]; then
  cmd="$cmd MESH_TERMINAL=$(quote "$TERMINAL")"
fi
cmd="$cmd node packages/relay/dist/index.js > $(quote "$LOG") 2>&1"

if ! command -v tmux >/dev/null 2>&1; then
  echo "错误: tmux 未安装，无法托管 relay" >&2
  exit 1
fi

tmux new-session -d -s "$SESSION" -c "$(pwd)" "$cmd"

sleep 3
echo
echo "=== relay 日志 ==="
cat "$LOG"
echo
echo "=== status ==="
curl -sm 3 --noproxy '*' "http://localhost:$PORT/api/status" || echo "(curl 失败)"
echo
