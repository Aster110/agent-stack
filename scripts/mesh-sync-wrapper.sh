#!/usr/bin/env bash
# mesh-sync-wrapper.sh — 方案 B PR1 长轮询收信 wrapper（GUI / 无 pane 节点接入）
#
# 用法: mesh-sync-wrapper.sh NODE_ID [SINCE] [MAX_WAIT_SECONDS]
#   NODE_ID   完整 nodeId（device:shortId）
#   SINCE     起始游标（可空——缺省用服务端 ack 游标）
#   MAX_WAIT  止损秒数，缺省 21600（6h，心跳级成本）
#
# 环境:
#   MESH_RELAY_URL     relay 基址，缺省 http://localhost:19800
#   MESH_SYNC_TIMEOUT  单次长轮询秒数，缺省 55（server 端 clamp 0..55）
#
# 行为契约（对齐 features/sync单原语 §6.4）:
#   有货    → 打印 "PARKED_SECONDS=<秒>" 行 + 整批 JSON 到 stdout，exit 0
#   空批    → 续拨（吸收超时窗，agent 零空醒）
#   连接错  → 退避重拨 1s/2s/4s… 封顶 30s
#   非 2xx（如 404 未注册）→ 打印错误正文到 stderr，exit 2（唤醒 agent 去重注册，
#           禁止当连接错误无限重拨——否则永久空转聋线）
#   MAX_WAIT 到 → exit 3（心跳级止损）
#
# bash 3.2 兼容（macOS 默认）：不用关联数组 / ${var^^} / mapfile 等 bash4 特性。
set -u

NODE_ID="${1:?usage: mesh-sync-wrapper.sh NODE_ID [SINCE] [MAX_WAIT]}"
SINCE="${2:-}"
MAX_WAIT="${3:-21600}"

RELAY_URL="${MESH_RELAY_URL:-http://localhost:19800}"
TIMEOUT="${MESH_SYNC_TIMEOUT:-55}"

start_ts=$(date +%s)
backoff=1

while : ; do
  # 止损：MAX_WAIT 到 → exit 3（在拨号前检查，空批/连接错都受这条闸约束）
  now_ts=$(date +%s)
  if [ $(( now_ts - start_ts )) -ge "$MAX_WAIT" ]; then
    echo "[mesh-sync] MAX_WAIT=${MAX_WAIT}s reached without message, giving up" >&2
    exit 3
  fi

  # 组 curl 参数：-G + --data-urlencode 让 query 正确编码（nodeId 含 ':'）。
  # 复用位置参数当数组（bash 3.2 无关联/命名数组），NODE_ID 等已存入命名变量，可安全 clobber。
  set -- \
    --noproxy '*' -sS -G "${RELAY_URL}/api/sync" \
    --data-urlencode "nodeId=${NODE_ID}" \
    --data-urlencode "timeout=${TIMEOUT}" \
    -m $(( TIMEOUT + 10 )) \
    -w $'\n%{http_code}'
  if [ -n "$SINCE" ]; then
    set -- "$@" --data-urlencode "since=${SINCE}"
  fi

  resp="$(curl --noproxy '*' "$@" 2>/dev/null)"
  rc=$?

  if [ "$rc" -ne 0 ]; then
    # 连接错误（拒连 / 重置 / 无响应超时）→ 退避重拨
    sleep "$backoff"
    backoff=$(( backoff * 2 ))
    [ "$backoff" -gt 30 ] && backoff=30
    continue
  fi
  backoff=1

  # -w 把 http_code 追加在末行；body 是其余部分
  http_code="${resp##*$'\n'}"
  body="${resp%$'\n'*}"

  case "$http_code" in
    2[0-9][0-9]) : ;;  # 2xx 继续处理正文
    *)
      # 非 2xx（如 404——relay 重启后内存注册表清空必现）：带错误正文退出唤醒 agent 去重注册。
      echo "[mesh-sync] HTTP ${http_code} from /api/sync — node likely unregistered, re-register:" >&2
      echo "$body" >&2
      exit 2
      ;;
  esac

  # 判空：Express res.json 紧凑输出，空批的结构位必是 "messages":[],"nextSince"
  # （非空时 [ 与 ] 之间夹着对象，不会命中此序列）。
  case "$body" in
    *'"messages":[],"nextSince"'*)
      # 空批 → 续拨（吸收超时窗，agent 零空醒）
      continue
      ;;
  esac

  # 有货：提取 parkedMs → PARKED_SECONDS 行，打印整批 JSON，exit 0
  parked_ms="$(printf '%s' "$body" | grep -o '"parkedMs":[0-9]*' | head -1 | sed 's/.*://')"
  [ -z "$parked_ms" ] && parked_ms=0
  echo "PARKED_SECONDS=$(( parked_ms / 1000 ))"
  printf '%s\n' "$body"
  exit 0
done
