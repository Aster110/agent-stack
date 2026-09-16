#!/usr/bin/env bash
# mesh-doorbell.sh — 默认 exec 绑定席位/实例的 SSE 读取与 ACK 门铃。
# Bash(run_in_background:true) 调用；只有业务提示输出一次并退出。
# 以下长轮询说明只适用于 --drain / MESH_DOORBELL_LEGACY_SYNC=1。
#
# 治的病（已实证发生，不是假设）：
#   relay 升级重启 → SSE/长连接断 → 门铃进程退出 → **无人知晓**。
#   此后 `mesh send` 照样返回 accepted、消息照常入库，但永远没人取。
#   静默是最毒的部分——所以这个壳的两件事就是「自己爬起来」和「爬不起来就喊人」。
#
# 用法: mesh-doorbell.sh NODE_ID [--drain]
#   NODE_ID   完整 nodeId（device:shortId）
#   --drain   补拉模式：把停驻的消息一次全取出来打印，不停车，取空即 exit 0
#
# 环境:
#   MESH_RELAY_URL             relay 基址，缺省 http://localhost:19800
#   MESH_DOORBELL_STATE        状态文件，缺省 ~/.ccmesh/doorbell-<shortId>.state
#   MESH_DOORBELL_ALERT_AFTER_S 断线连续超此秒数报警一次，缺省 600
#   MESH_DOORBELL_FEISHU       1=报警（缺省），0=不报警（测试用）
#   MESH_DOORBELL_PROBE_S      健康探测间隔秒，缺省 30
#   MESH_DOORBELL_MAX_WAIT     内核止损秒数，缺省 2592000（30 天）
#   MESH_LARK_CLI              lark-cli 路径，缺省 /usr/local/bin/lark-cli（飞书报警统一走 lark-cli，2026-09-08 起）
#   MESH_LARK_TO               收件人 open_id，缺省 = lark-cli 当前登录用户
#   MESH_TELLME                测试注入的假发送器（node 脚本，argv: 标题 正文 颜色）；空 = 走 lark-cli
#
# 退出码契约（Monitor 就认这三个，别加第四个）:
#   0  有货：stdout = 内核原样输出（PARKED_SECONDS 行 + 整批 JSON）→ 会话醒来处理 + 重挂
#   2  需重注册（relay 回非 2xx，如 404）→ 会话醒来重注册 + 重挂
#   1  用法错 / 前置条件不满足（不该发生；发生了就是配置问题）
#
# ⚠️ stdout 纪律（铁律）：除「有货」那一次透传外，任何重连/退避/报警日志
#    **只写 stderr 与状态文件**。stdout 是 Monitor 的判定面，脏一行就可能假醒，
#    假醒 = 白烧一个模型 turn，而这套设计的全部意义就是空闲期零 turn。
#
# ⚠️ 健康探测只走 /api/status（只读）。**绝不可**用 /api/sync 探测——
#    /api/sync 入口即 registry.touchSync()，旁观者一探测就把 lastSyncAt 刷新鲜，
#    伪造 presence 并压制之后 90s 内所有真 wake（架构定稿 §7.2 硬禁令）。
#
# bash 3.2 兼容（macOS 默认）：不用关联数组 / ${var^^} / mapfile。
set -u
# Default path is the bound SSE reader. Legacy long-poll is explicit only.
if [ "${2:-}" != "--drain" ] && [ "${MESH_DOORBELL_LEGACY_SYNC:-0}" != "1" ]; then
  exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/mesh-sse-doorbell.mjs" "$@"
fi

NODE_ID="${1:-}"
MODE="${2:-}"
if [ -z "$NODE_ID" ]; then
  echo "usage: mesh-doorbell.sh NODE_ID [--drain]" >&2
  exit 1
fi

RELAY_URL="${MESH_RELAY_URL:-http://localhost:19800}"
ALERT_AFTER_S="${MESH_DOORBELL_ALERT_AFTER_S:-600}"
FEISHU="${MESH_DOORBELL_FEISHU:-1}"
PROBE_S="${MESH_DOORBELL_PROBE_S:-30}"
# 缺省 30 天，不是 wrapper 的 6h：exit 3 会白醒会话一个 turn（4 次/天的纯空转），
# 违反零闲时 turn 红线。止损观测由下面的带外报警承担，不靠周期性放弃。
MAX_WAIT="${MESH_DOORBELL_MAX_WAIT:-2592000}"
LARK="${MESH_LARK_CLI:-/usr/local/bin/lark-cli}"
LARK_TO="${MESH_LARK_TO:-}"
SENDER_OVERRIDE="${MESH_TELLME:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KERNEL="${MESH_SYNC_WRAPPER:-$SCRIPT_DIR/mesh-sync-wrapper.sh}"

# 文件名安全：shortId 段来自注册请求体，是外部可控输入，不许直接当路径用。
SHORT_ID="${NODE_ID##*:}"
SAFE_ID="$(printf '%s' "$SHORT_ID" | tr -c 'A-Za-z0-9._-' '_')"
STATE_FILE="${MESH_DOORBELL_STATE:-$HOME/.ccmesh/doorbell-${SAFE_ID}.state}"
mkdir -p "$(dirname "$STATE_FILE")" 2>/dev/null || true

log() { echo "[doorbell] $*" >&2; }

# 状态文件：单行 JSON。phase = dialing | parked | down
write_state() {
  # $1=phase $2=since(该 phase 起始 epoch) $3=alerts
  printf '{"ts":%s,"node":"%s","phase":"%s","since":%s,"alerts":%s}\n' \
    "$(date +%s)" "$NODE_ID" "$1" "$2" "$3" > "$STATE_FILE" 2>/dev/null || true
}

# 卡片 JSON（与旧 tell-me 卡片同构：彩色标题 + markdown 正文 + 时间脚注）。
# 标题/正文来自外部输入，一律走 node + argv，不拼进任何被解释的字符串。
lark_card() {
  # $1=标题 $2=正文 $3=颜色 → stdout=卡片 JSON
  node -e '
    const [, t, c, color] = process.argv
    process.stdout.write(JSON.stringify({
      header: { title: { content: "📌 " + t, tag: "plain_text" }, template: color || "blue" },
      elements: [
        { tag: "markdown", content: c },
        { tag: "note", elements: [{ tag: "plain_text", content: "⏰ " + new Date().toLocaleString("zh-CN") }] },
      ],
    }))
  ' "$1" "$2" "${3:-blue}" 2>/dev/null
}

# 收件人：MESH_LARK_TO 优先；否则 lark-cli 当前登录用户的 open_id（auth status 只读本地 token，不联网）
lark_to() {
  [ -n "$LARK_TO" ] && { printf '%s' "$LARK_TO"; return 0; }
  "$LARK" auth status 2>/dev/null | node -e '
    let raw = ""
    process.stdin.on("data", (d) => { raw += d })
    process.stdin.on("end", () => { try { process.stdout.write(JSON.parse(raw).userOpenId || "") } catch (e) {} })
  ' 2>/dev/null
}

feishu() {
  # $1=标题 $2=正文 $3=颜色 —— lark-cli bot 发送给配置的用户。纯 CLI、零模型：报警是 curl 级动作，不产生 turn。
  # stdout 纪律：lark-cli 的全部输出都被 grep -q 吃掉，一个字节都不进 Monitor 的判定面。
  [ "$FEISHU" = "1" ] || return 0
  if [ -n "$SENDER_OVERRIDE" ]; then
    [ -f "$SENDER_OVERRIDE" ] || { log "自定义发送器不存在，跳过报警: $SENDER_OVERRIDE"; return 0; }
    node "$SENDER_OVERRIDE" "$1" "$2" "$3" >/dev/null 2>&1 || log "飞书报警发送失败（自定义发送器，不影响门铃）"
    return 0
  fi
  [ -x "$LARK" ] || { log "lark-cli 不存在，跳过报警: $LARK"; return 0; }
  to="$(lark_to)"
  [ -n "$to" ] || { log "lark-cli 无登录用户，跳过报警（可设 MESH_LARK_TO）"; return 0; }
  card="$(lark_card "$1" "$2" "$3")"
  [ -n "$card" ] || { log "卡片构造失败，跳过报警"; return 0; }
  "$LARK" im +messages-send --as bot --user-id "$to" --msg-type interactive --content "$card" 2>&1 \
    | grep -q '"message_id"' || log "飞书报警发送失败（不影响门铃）"
}

# ===========================================================================
# --drain：补拉模式（醒来后把停驻消息一次取干净）
#
# 走 timeout=0 探测语义，逐批打印，取空即退。不停车、不长挂。
# 游标是免费的：/api/sync 缺省 since=服务端 ack 游标，显式 since>游标即销账，
# 所以席位死多久都一样，醒来第一拨从游标处整批续传，不丢不重。
# ===========================================================================
if [ "$MODE" = "--drain" ]; then
  since=""
  batches=0
  while : ; do
    set -- -sS --noproxy '*' -G "${RELAY_URL}/api/sync" \
      --data-urlencode "nodeId=${NODE_ID}" \
      --data-urlencode "timeout=0" \
      -m 30 -w $'\n%{http_code}'
    [ -n "$since" ] && set -- "$@" --data-urlencode "since=${since}"

    resp="$(curl "$@" 2>/dev/null)"
    if [ $? -ne 0 ]; then
      log "drain: 连接失败，已取 ${batches} 批"
      exit 2
    fi
    http_code="${resp##*$'\n'}"
    body="${resp%$'\n'*}"
    case "$http_code" in
      2[0-9][0-9]) : ;;
      *) echo "[doorbell] drain: HTTP ${http_code} — 可能未注册" >&2; echo "$body" >&2; exit 2 ;;
    esac

    case "$body" in
      *'"messages":[],"nextSince"'*) break ;;   # 取空，收工
    esac

    printf '%s\n' "$body"
    batches=$(( batches + 1 ))
    next="$(printf '%s' "$body" | grep -o '"nextSince":[0-9]*' | head -1 | sed 's/.*://')"
    # 游标没前进 = 服务端没有更多可推进的东西，别原地打转
    [ -z "$next" ] && break
    [ "$next" = "$since" ] && break
    since="$next"
    [ "$batches" -ge 500 ] && { log "drain: 批数封顶 500，停"; break; }
  done
  log "drain 完成，共 ${batches} 批"
  exit 0
fi

# ===========================================================================
# 健康探测子进程（断线可观测——本次事故的核心疗法）
#
# 为什么需要它：内核 wrapper 的连接错重拨是**内部**行为（1s→30s 退避，不退出、
# 不出声），壳从外面根本看不见 relay 死了没有。所以另起一条只读探测线，
# 它才是"门铃与 relay 失联"这件事的唯一观测者。
#
# 它只碰 /api/status（只读，无 touchSync 副作用），且所有输出走 stderr。
# ===========================================================================
probe_loop() {
  down_since=0
  alerts=0
  alerted=0
  while : ; do
    code="$(curl -sS --noproxy '*' -o /dev/null -w '%{http_code}' -m 10 "${RELAY_URL}/api/status" 2>/dev/null)"
    if [ "$code" = "200" ]; then
      if [ "$down_since" -ne 0 ]; then
        dur=$(( $(date +%s) - down_since ))
        log "relay 已恢复（失联 ${dur}s）"
        if [ "$alerted" -eq 1 ]; then
          feishu "门铃已自愈" "节点 ${NODE_ID} 与 relay 的连接已恢复（本次失联 $(( dur / 60 )) 分钟）。停驻消息会在下一拨长轮询整批返回。" "green"
        fi
        down_since=0
        alerted=0
      fi
      write_state "parked" "$(date +%s)" "$alerts"
    else
      now_ts="$(date +%s)"
      if [ "$down_since" -eq 0 ]; then
        down_since="$now_ts"
        log "relay 探测失败（http=${code:-none}），开始计时"
      fi
      write_state "down" "$down_since" "$alerts"
      dur=$(( now_ts - down_since ))
      if [ "$dur" -ge "$ALERT_AFTER_S" ] && [ "$alerted" -eq 0 ]; then
        alerted=1
        alerts=$(( alerts + 1 ))
        write_state "down" "$down_since" "$alerts"
        feishu "门铃与 relay 失联" "节点 ${NODE_ID} 已连续 $(( dur / 60 )) 分钟连不上 relay（${RELAY_URL}）。relay 可能死了——此刻发给该席位的消息会静默停驻，无人取信。" "red"
      fi
    fi
    sleep "$PROBE_S"
  done
}

PROBE_PID=""
cleanup() {
  [ -n "$PROBE_PID" ] && kill "$PROBE_PID" 2>/dev/null
  return 0
}
trap cleanup EXIT INT TERM

# 探测子进程的 stdout 一律并进 stderr——它绝不许污染 Monitor 的判定面。
probe_loop >&2 2>&2 &
PROBE_PID=$!

# ===========================================================================
# 主循环：拨号内核 + 崩溃重起
#
# 内核（mesh-sync-wrapper.sh）自带 1s→30s 退避重拨，连接错**不会退出**。
# 所以这里要处理的只有内核自己崩了的情形：记状态、睡 5 秒、重起，不退出、不出声。
# ===========================================================================
write_state "dialing" "$(date +%s)" 0
OUT="$(mktemp -t doorbell.XXXXXX)"
ERRF="$(mktemp -t doorbell-err.XXXXXX)"
trap 'cleanup; rm -f "$OUT" "$ERRF"' EXIT INT TERM

while : ; do
  # 内核 stdout 落临时文件：只有"有货"那一次才原样倒进真 stdout，
  # 其余任何情况下 stdout 一个字节都不产生。
  # stderr 单独落一份：exit 2 时要把 relay 的错误正文透传给会话看。
  bash "$KERNEL" "$NODE_ID" "" "$MAX_WAIT" > "$OUT" 2> "$ERRF"
  rc=$?

  case "$rc" in
    0)
      # 有货：原样透传（PARKED_SECONDS 行 + 整批 JSON），会话醒来处理 + 重挂门铃
      cat "$OUT"
      exit 0
      ;;
    2)
      # 非 2xx（如 404 未注册）：唤醒会话去重注册。注册表持久化后此路径已罕见。
      log "内核报需重注册（exit 2）"
      cat "$ERRF" >&2
      exit 2
      ;;
    3)
      # MAX_WAIT 到（30 天）——正常运行里几乎不会走到。继续拨，别白醒会话。
      log "内核 MAX_WAIT 到期，续拨"
      ;;
    *)
      # 内核自身崩了（bash 异常）：记状态、睡一会儿、重起。不退出、不出声。
      log "内核异常退出 rc=${rc}，5s 后重起"
      write_state "dialing" "$(date +%s)" 0
      sleep 5
      ;;
  esac
done
