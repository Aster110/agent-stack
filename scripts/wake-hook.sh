#!/usr/bin/env bash
# wake-hook.sh — MESH_WAKE_HOOK 指向它（架构定稿 §7.1）
#
# 它**不负责唤醒**。唤醒是 porter 的活（porter 收 SSE 的 wake:needed，
# 在会话内调 ccd send_message 叫醒冷席位）。这个脚本负责另外三件事：
#   ① 验证：T+120s 后看席位到底醒没醒、门铃重挂没有
#   ② 带外报警：没醒/半醒就发飞书——**用独立于 mesh/relay/app 三者的通道**。
#      通道聋了的时候用同一通道报警等于没报，这是 W2 带外看门狗的同源立意。
#   ③ 审计：结果写 @ledger 流水，wake_id 串起因果链
#
# relay 的调用契约（wake.ts）：nodeId 是**最后一个 argv**；wake_id 走 env MESH_WAKE_ID。
#
# ⚠️ 为什么立刻 fork 再退出：relay 的 execFile 给 hook 设了 10s 硬超时
#    （WAKE_EXEC_TIMEOUT_MS），而验证要等 120s。所以父进程只做「查映射 + 起后台验证工 +
#    立刻退出」，验证工 nohup 脱钩活下去。父进程毫秒级返回，永远碰不到那 10s 闸。
#
# ⚠️ 硬禁令（§7.2）：本脚本任何路径**不得**调用 /api/sync。
#    /api/sync 入口即 registry.touchSync()——旁观者一探测就把 lastSyncAt 刷新鲜，
#    ①伪造 presence（status 显示 idle）②hasActiveConsumer 变 true，压制之后 90s 内
#    所有真 wake。探测一律走只读 /api/status。这条违反了整个机制静默失效。
#
# 用法:
#   wake-hook.sh <nodeId>              # relay 调这个（快进快出）
#   wake-hook.sh --verify <nodeId>     # 后台验证工（内部用，别手工调）
#
# 环境:
#   MESH_RELAY_URL        缺省 http://localhost:19800
#   MESH_WAKE_MAP         缺省 ~/.ccmesh/wake-map.json
#   MESH_WAKE_VERIFY_S    验证等待秒数，缺省 120
#   MESH_WAKE_ALERT_MIN_GAP_S 同节点报警最小间隔，缺省 1800（30min）
#   MESH_WAKE_FEISHU      1=报警（缺省），0=不报警（测试用）
#   MESH_WAKE_ID          relay 注入的因果链串号
#   MESH_LARK_CLI         lark-cli 路径，缺省 /usr/local/bin/lark-cli（飞书报警统一走 lark-cli，2026-09-08 起）
#   MESH_LARK_TO          收件人 open_id，缺省 = lark-cli 当前登录用户
#   MESH_TELLME           测试注入的假发送器（node 脚本，argv: 标题 正文 颜色）；空 = 走 lark-cli
#
# bash 3.2 兼容。
set -u

RELAY_URL="${MESH_RELAY_URL:-http://localhost:19800}"
WAKE_MAP="${MESH_WAKE_MAP:-$HOME/.ccmesh/wake-map.json}"
VERIFY_S="${MESH_WAKE_VERIFY_S:-120}"
ALERT_GAP_S="${MESH_WAKE_ALERT_MIN_GAP_S:-1800}"
FEISHU="${MESH_WAKE_FEISHU:-1}"
WAKE_ID="${MESH_WAKE_ID:-unknown}"
LARK="${MESH_LARK_CLI:-/usr/local/bin/lark-cli}"
LARK_TO="${MESH_LARK_TO:-}"
SENDER_OVERRIDE="${MESH_TELLME:-}"
SESSIONS_DIR="${MESH_SESSIONS_DIR:-$HOME/.claude/sessions}"
SOCKS_DIR="${MESH_SOCKS_DIR:-/tmp/cc-socks}"

log() { echo "[wake-hook] $*" >&2; }

# ---------------------------------------------------------------------------
# JSON 读取一律走 node + argv（nodeId 是外部可控输入，绝不拼进任何被解释的字符串）
# ---------------------------------------------------------------------------
map_get() {
  # $1=nodeId $2=key → stdout=值；exit 3=无该节点 exit 4=无该字段 exit 2=文件坏
  node -e '
    const fs = require("fs")
    const [, file, nodeId, key] = process.argv
    let m
    try { m = JSON.parse(fs.readFileSync(file, "utf8")) } catch (e) { process.exit(2) }
    const entry = m && m[nodeId]
    if (!entry) process.exit(3)
    const v = entry[key]
    if (v == null) process.exit(4)
    process.stdout.write(String(v))
  ' "$WAKE_MAP" "$1" "$2" 2>/dev/null
}

# /api/status 里该节点的一行 → "lastSyncAt|parkedCount|status"（只读，无副作用）
status_probe() {
  curl -sS --noproxy '*' -m 10 "${RELAY_URL}/api/status" 2>/dev/null | node -e '
    const [, nodeId] = process.argv
    let raw = ""
    process.stdin.on("data", (d) => { raw += d })
    process.stdin.on("end", () => {
      let j
      try { j = JSON.parse(raw) } catch (e) { process.stdout.write("|||"); return }
      const nodes = (j && j.data && j.data.nodes) || []
      const n = nodes.find((x) => x && x.identity && x.identity.nodeId === nodeId)
      if (!n) { process.stdout.write("|||") ; return }
      process.stdout.write([n.lastSyncAt || "", n.parkedCount == null ? "" : n.parkedCount, n.status || ""].join("|"))
    })
  ' "$1"
}

# 判活三证：sessions json 里 cwd+name 匹配 → pid kill -0 → 对应 .sock 存在。
# 三者皆无 = 冷（引擎进程不存在）。回显 "hot" / "cold"。
liveness() {
  # $1=cwd $2=sessionName
  local_pid="$(node -e '
    const fs = require("fs"), path = require("path")
    const [, dir, cwd, name] = process.argv
    let files = []
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")) } catch (e) { process.exit(0) }
    for (const f of files) {
      let j
      try { j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) } catch (e) { continue }
      if (!j) continue
      const cwdOk = !cwd || j.cwd === cwd
      const nameOk = !name || j.name === name
      if (cwdOk && nameOk && j.pid) { process.stdout.write(String(j.pid)); return }
    }
  ' "$SESSIONS_DIR" "${1:-}" "${2:-}" 2>/dev/null)"

  if [ -n "$local_pid" ] && kill -0 "$local_pid" 2>/dev/null; then
    if [ -S "${SOCKS_DIR}/${local_pid}.sock" ]; then
      echo "hot"
      return 0
    fi
    echo "hot"
    return 0
  fi
  echo "cold"
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
  # $1=标题 $2=正文 $3=颜色 —— 带外报警：lark-cli bot 发送给配置的用户（独立于 mesh/relay/app 三者）
  [ "$FEISHU" = "1" ] || { log "飞书已关（MESH_WAKE_FEISHU=0）: $1"; return 0; }
  if [ -n "$SENDER_OVERRIDE" ]; then
    [ -f "$SENDER_OVERRIDE" ] || { log "自定义发送器不存在，跳过报警: $SENDER_OVERRIDE"; return 0; }
    node "$SENDER_OVERRIDE" "$1" "$2" "$3" >/dev/null 2>&1 || log "飞书发送失败（自定义发送器）"
    return 0
  fi
  [ -x "$LARK" ] || { log "lark-cli 不存在，跳过报警: $LARK"; return 0; }
  to="$(lark_to)"
  [ -n "$to" ] || { log "lark-cli 无登录用户，跳过报警（可设 MESH_LARK_TO）"; return 0; }
  card="$(lark_card "$1" "$2" "$3")"
  [ -n "$card" ] || { log "卡片构造失败，跳过报警"; return 0; }
  "$LARK" im +messages-send --as bot --user-id "$to" --msg-type interactive --content "$card" 2>&1 \
    | grep -q '"message_id"' || log "飞书发送失败"
}

# 审计流水 → @ledger（落库即 delivered、不投递、不触发任何门铃）。
# 走 /api/send，不依赖 mesh CLI 是否装了 / 环境变量配没配。
audit() {
  # $1=nodeId $2=verdict $3=note
  body="$(node -e '
    const [, nodeId, wakeId, verdict, note] = process.argv
    process.stdout.write(JSON.stringify({
      to: "@ledger",
      type: "wake_audit",
      message: JSON.stringify({ step: "hook_verify", wake_id: wakeId, node_id: nodeId, verdict, note }),
    }))
  ' "$1" "$WAKE_ID" "$2" "${3:-}" 2>/dev/null)"
  [ -z "$body" ] && return 0
  curl -sS --noproxy '*' -m 10 -X POST "${RELAY_URL}/api/send" \
    -H 'Content-Type: application/json' \
    -H 'X-Mesh-Node: wake-hook' \
    -d "$body" >/dev/null 2>&1 || log "审计写入失败（relay 可能死了；飞书优先，不影响报警）"
}

# 报警去重：同节点最小间隔 ALERT_GAP_S；恢复时清零。
alert_state_file() {
  short="${1##*:}"
  safe="$(printf '%s' "$short" | tr -c 'A-Za-z0-9._-' '_')"
  echo "$HOME/.ccmesh/wake-alert-${safe}.state"
}

should_alert() {
  f="$(alert_state_file "$1")"
  [ -f "$f" ] || return 0
  last="$(cat "$f" 2>/dev/null | tr -cd '0-9')"
  [ -z "$last" ] && return 0
  now_ts="$(date +%s)"
  [ $(( now_ts - last )) -ge "$ALERT_GAP_S" ]
}

mark_alerted() {
  f="$(alert_state_file "$1")"
  mkdir -p "$(dirname "$f")" 2>/dev/null || true
  date +%s > "$f" 2>/dev/null || true
}

clear_alerted() {
  f="$(alert_state_file "$1")"
  [ -f "$f" ] || return 0
  rm -f "$f" 2>/dev/null || true
  return 0
}

# ===========================================================================
# 后台验证工
# ===========================================================================
if [ "${1:-}" = "--verify" ]; then
  NODE_ID="${2:?--verify 需要 nodeId}"
  CWD="$(map_get "$NODE_ID" cwd)" || CWD=""
  SESSION_NAME="$(map_get "$NODE_ID" sessionName)" || SESSION_NAME=""
  LABEL="$(map_get "$NODE_ID" label)" || LABEL="$NODE_ID"

  # T0 快照（唤醒动作刚发生，这是"动没动"的基线）
  t0="$(status_probe "$NODE_ID")"
  t0_sync="$(printf '%s' "$t0" | cut -d'|' -f1)"
  t0_live="$(liveness "$CWD" "$SESSION_NAME")"
  log "T0 node=${NODE_ID} lastSyncAt=${t0_sync:-none} liveness=${t0_live}"

  sleep "$VERIFY_S"

  t1="$(status_probe "$NODE_ID")"
  t1_sync="$(printf '%s' "$t1" | cut -d'|' -f1)"
  t1_parked="$(printf '%s' "$t1" | cut -d'|' -f2)"
  t1_live="$(liveness "$CWD" "$SESSION_NAME")"
  [ -z "$t1_parked" ] && t1_parked=0

  # lastSyncAt 前进 = 席位真的来取过信了
  moved=0
  [ -n "$t1_sync" ] && [ "$t1_sync" != "$t0_sync" ] && moved=1

  if [ "$moved" = "1" ] && [ "$t1_parked" -gt 0 ]; then
    verdict="a"
    log "verdict=a 唤醒成功且门铃已重挂"
    audit "$NODE_ID" "a" "woke_and_rearmed parked=${t1_parked}"
    clear_alerted "$NODE_ID"
  elif [ "$moved" = "1" ]; then
    verdict="b"
    log "verdict=b 唤醒成功但门铃未重挂"
    audit "$NODE_ID" "b" "woke_no_doorbell"
    if should_alert "$NODE_ID"; then
      mark_alerted "$NODE_ID"
      feishu "唤醒成功但门铃没挂回去" "${LABEL}（${NODE_ID}）已被叫醒并取了信，但 ${VERIFY_S}s 后仍没有停车连接——门铃没重挂，下一条消息还会睡死。让它跑：bash ~/AIproject/cc-mesh/scripts/mesh-doorbell.sh ${NODE_ID}" "orange"
    fi
  elif [ "$t1_live" = "hot" ]; then
    verdict="c"
    log "verdict=c 引擎醒了但没人取信"
    audit "$NODE_ID" "c" "engine_hot_no_sync"
    if should_alert "$NODE_ID"; then
      mark_alerted "$NODE_ID"
      feishu "引擎醒了但没人取信" "${LABEL}（${NODE_ID}）的引擎进程活着，但 ${VERIFY_S}s 内一次 sync 都没有——poke 守则没被执行。去会话里说一句：drain + 重挂门铃。" "red"
    fi
  else
    verdict="d"
    log "verdict=d 唤醒失败（porter 死 / ccd 不可达 / App 整个没了）"
    audit "$NODE_ID" "d" "wake_failed_still_cold"
    if should_alert "$NODE_ID"; then
      mark_alerted "$NODE_ID"
      feishu "自动唤醒失败，需要人" "${LABEL}（${NODE_ID}）在 ${VERIFY_S}s 后仍是冷的：引擎不存在、也没来取信。可能是 porter 会话死了、ccd 原语不可用、或整个 Claude App 退出了（这一档结构上就只能人工兜）。wake_id=${WAKE_ID}" "red"
    fi
  fi
  exit 0
fi

# ===========================================================================
# 父进程：relay 调的就是这条路。查映射 → 起后台验证工 → 立刻退出（远早于 10s 闸）
# ===========================================================================
NODE_ID="${1:-}"
if [ -z "$NODE_ID" ]; then
  echo "usage: wake-hook.sh <nodeId>" >&2
  exit 1
fi

if [ ! -f "$WAKE_MAP" ]; then
  log "wake-map 不存在: $WAKE_MAP"
  feishu "wake 触发了但没有映射表" "relay 要唤醒 ${NODE_ID}，但 ${WAKE_MAP} 不存在——porter 不知道该叫谁。照 scripts/wake-map.example.json 播种一份。" "orange"
  exit 1
fi

if ! map_get "$NODE_ID" localId >/dev/null; then
  log "wake-map 里没有 $NODE_ID 的映射"
  feishu "wake 触发了但没有映射" "relay 要唤醒 ${NODE_ID}，但 ${WAKE_MAP} 里没有它的 localId——porter 叫不动这个席位。补一条映射（播种方法见 agent-seat-bootstrap）。" "orange"
  exit 1
fi

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
# nohup + & ：脱钩活过 relay 的 10s execFile 硬超时。父进程立刻返回。
nohup bash "$SELF" --verify "$NODE_ID" >/dev/null 2>&1 &
log "已起后台验证工 (node=${NODE_ID}, wake_id=${WAKE_ID}, T+${VERIFY_S}s)"
exit 0
