#!/usr/bin/env bash
# wake-porter-doorbell.sh — porter（同机哨兵会话）的门铃（架构定稿 §5.3）
#
# porter 是什么、为什么需要它：
#   外部进程**没有**直接叫醒冷 app 会话的通道（五路全封死：机外无 ccd CLI、
#   冷会话没有 UDS sock、claude -p 拿不到 app 私有凭证、深链只认 session=last、
#   computer-use 自点被平台安全红线硬拒）。唯一活着的原语 `send_message(local_id)`
#   只存在于**同机另一个活着的 app 会话**体内。porter 就是那个会话。
#
# 它挂这个脚本当门铃：长连 relay 的 SSE，只在 wake:needed 事件命中时退出，
# 从而唤醒 porter 一个 turn；porter 再去 poke 冷席位。
# 空闲期零 turn——SSE 的 15s 心跳是**注释行**（`: heartbeat`），不含 "wake:needed"，
# 过滤器不命中，进程不退出，会话不醒。
#
# 用法: wake-porter-doorbell.sh [NODE_ID_FILTER]
#   NODE_ID_FILTER  可选：只关心某个席位的 wake:needed（不给 = 全收）
#
# 环境:
#   MESH_RELAY_URL          缺省 http://localhost:19800
#   MESH_PORTER_STATE       状态文件，缺省 ~/.ccmesh/porter-doorbell.state
#   MESH_PORTER_SPEED_TIME  死线判定秒数，缺省 45（>15s 心跳间隔）
#
# 退出码:
#   0  收到 wake:needed → stdout = 那一行事件 JSON，porter 醒来处理
#   1  用法错
#
# ⚠️ stdout 纪律同 mesh-doorbell.sh：只有命中事件那一行走 stdout，
#    重连/退避日志一律 stderr。
#
# ⚠️ porter **不注册为 mesh 节点**（不进 registry）→ 它永远不会成为 wake 的目标，
#    结构上排除「唤醒唤醒者」的递归。这条别改。
#
# bash 3.2 兼容。
set -u

FILTER="${1:-}"
RELAY_URL="${MESH_RELAY_URL:-http://localhost:19800}"
STATE_FILE="${MESH_PORTER_STATE:-$HOME/.ccmesh/porter-doorbell.state}"
SPEED_TIME="${MESH_PORTER_SPEED_TIME:-45}"

mkdir -p "$(dirname "$STATE_FILE")" 2>/dev/null || true
log() { echo "[porter-doorbell] $*" >&2; }

write_state() {
  printf '{"ts":%s,"phase":"%s","reconnects":%s,"filter":"%s"}\n' \
    "$(date +%s)" "$1" "$2" "$FILTER" > "$STATE_FILE" 2>/dev/null || true
}

OUT="$(mktemp -t porter-bell.XXXXXX)"
trap 'rm -f "$OUT"' EXIT INT TERM

reconnects=0
backoff=1

# 一次监听：管道后台跑，命中即写 $OUT。返回 0=命中 1=断线。
#
# 为什么要轮询文件而不是直接 wait 管道：grep -m1 命中后自己退了，但上游 curl
# 要等到**下一次写**才吃到 SIGPIPE——SSE 的下一次写就是 15s 后的心跳。
# 直接 wait 管道 = 命中后还要干等最多 15s 才唤醒 porter。轮询 + 主动收尸，
# 命中到出货 ≤0.5s。
listen_once() {
  : > "$OUT"
  if [ -n "$FILTER" ]; then
    # 两级过滤：先认事件名，再认 nodeId（-F 定长字符串，nodeId 只当数据）
    ( curl -sN --noproxy '*' \
        --speed-limit 1 --speed-time "$SPEED_TIME" \
        "${RELAY_URL}/api/events" 2>/dev/null \
        | grep --line-buffered '"wake:needed"' \
        | grep --line-buffered -m1 -F "$FILTER" > "$OUT" ) &
  else
    # --speed-limit 1 --speed-time N：连续 N 秒字节流速低于 1B/s 就判死线断开。
    # relay 每 15s 写一行 `: heartbeat` 注释——那正是这条死线判定要吃的活体信号：
    # 心跳还在 = 连接活着；心跳停了 45s = relay 死了或链路断了，别傻挂着。
    # 注释行不含 "wake:needed"，过滤不命中 → 进程不退出 → 会话不醒 → 空闲期零 turn。
    ( curl -sN --noproxy '*' \
        --speed-limit 1 --speed-time "$SPEED_TIME" \
        "${RELAY_URL}/api/events" 2>/dev/null \
        | grep --line-buffered -m1 '"wake:needed"' > "$OUT" ) &
  fi
  pipe_pid=$!

  while kill -0 "$pipe_pid" 2>/dev/null; do
    if [ -s "$OUT" ]; then
      pkill -P "$pipe_pid" 2>/dev/null
      kill "$pipe_pid" 2>/dev/null
      wait "$pipe_pid" 2>/dev/null
      return 0
    fi
    sleep 0.5
  done
  wait "$pipe_pid" 2>/dev/null
  [ -s "$OUT" ] && return 0
  return 1
}

while : ; do
  write_state "listening" "$reconnects"

  if listen_once; then
    # 命中了就交货退出（唯一一次 stdout）
    write_state "fired" "$reconnects"
    cat "$OUT"
    exit 0
  fi

  # 没命中就是断线（SSE 正常态是永不返回）→ 静默退避重连，不出声、不产生 turn
  reconnects=$(( reconnects + 1 ))
  write_state "reconnecting" "$reconnects"
  log "SSE 断开（第 ${reconnects} 次），${backoff}s 后重连"
  sleep "$backoff"
  backoff=$(( backoff * 2 ))
  [ "$backoff" -gt 30 ] && backoff=30
done
