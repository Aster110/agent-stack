#!/bin/bash
# mesh-doorbell-watchdog.sh — alert-only 门铃看门狗（不重生、不 ack、不碰 relay 写面）
set -u
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin

NODE_ID="${MESH_WATCHDOG_NODE:-$(hostname -s | tr '[:upper:]' '[:lower:]'):claude-main}"
RELAY_SIG="${MESH_WATCHDOG_RELAY_SIG:-19800/api/events}"
STATE="${MESH_WATCHDOG_STATE:-$HOME/.ccmesh/doorbell-watchdog.state}"
GRACE_S="${MESH_WATCHDOG_GRACE_S:-180}"
REPEAT_S="${MESH_WATCHDOG_REPEAT_S:-3600}"
LARK="${MESH_LARK_CLI:-/usr/local/bin/lark-cli}"   # 飞书告警统一走 lark-cli（2026-09-08 起；tell-me/send.js 已归档）
LARK_TO="${MESH_LARK_TO:-}"                         # 收件人 open_id；空 = lark-cli 当前登录用户
SENDER_OVERRIDE="${MESH_TELLME:-}"                  # 测试注入的假发送器（node 脚本，argv: 标题 正文 颜色）；空 = 走 lark-cli
NODEBIN="${MESH_NODE_BIN:-/usr/local/bin/node}"
NOW=$(/bin/date +%s)

mkdir -p "$(dirname "$STATE")" 2>/dev/null || true

# --- 判活：独立 listener 状态，只读，无消息/探针 ACK ---
count_doorbell() {
  # Read the relay's authenticated SSE receipts; process existence is not liveness.
  /usr/bin/curl -fsS --noproxy '*' --max-time 5 "${MESH_RELAY_URL:-http://127.0.0.1:19800}/api/status" 2>/dev/null \
    | /usr/bin/jq -r --arg id "$NODE_ID" '[.data.nodes[]? | select(.identity.nodeId == $id) | .listener.state | select(. == "listening" or . == "waking")] | length' 2>/dev/null
}
# --- 闸：App 后端在不在（aster 主动关 App 时不该报警） ---
count_app() {
  /bin/ps -axo pid=,command= | /usr/bin/awk -v me="$$" '
    $1 != me && index($0, "claude-code/") > 0 && index($0, "MacOS/claude") > 0 { n++ } END { print n+0 }'
}
# --- 死因分类器（只读 harness 输出文件末行，找不到就 unknown） ---
classify() {
  local newest="" f
  for f in $(/usr/bin/find /private/tmp/claude-501 -maxdepth 4 -path '*/tasks/b*.output' \
             -type f -mtime -2 2>/dev/null); do
    /usr/bin/grep -aq "$NODE_ID" "$f" 2>/dev/null || continue
    [ -z "$newest" ] && newest="$f"
    [ "$f" -nt "$newest" ] && newest="$f"
  done
  [ -z "$newest" ] && { echo "unknown"; return; }
  /usr/bin/tail -c 200 "$newest" | /usr/bin/tr -d '\000' | /usr/bin/grep -a '^\[' | /usr/bin/tail -1
}

read_state() { [ -f "$STATE" ] && /bin/cat "$STATE" || echo '{"phase":"ok","since":0,"alerts":0,"last_alert":0}'; }
jget() { /usr/bin/jq -r "$1 // empty" 2>/dev/null; }

alert() {  # $1=title $2=body $3=color —— lark-cli bot 私聊 aster，卡片语义与旧 tell-me 一致（彩色标题 + markdown 正文 + 时间脚注）
  if [ -n "$SENDER_OVERRIDE" ]; then
    [ -f "$SENDER_OVERRIDE" ] || { echo "[watchdog] 自定义发送器缺失: $SENDER_OVERRIDE" >&2; return 1; }
    [ -x "$NODEBIN" ] || { echo "[watchdog] node 缺失: $NODEBIN" >&2; return 1; }
    "$NODEBIN" "$SENDER_OVERRIDE" "$1" "$2" "$3" >/dev/null 2>&1 \
      || { echo "[watchdog] 告警发送失败（自定义发送器）" >&2; return 1; }
    return 0
  fi
  [ -x "$LARK" ] || { echo "[watchdog] lark-cli 缺失: $LARK" >&2; return 1; }
  local to="$LARK_TO" card out
  [ -z "$to" ] && to="$("$LARK" auth status 2>/dev/null | /usr/bin/jq -r '.userOpenId // empty')"
  [ -n "$to" ] || { echo "[watchdog] lark-cli 无登录用户，不知道发给谁（可设 MESH_LARK_TO）" >&2; return 1; }
  card="$(/usr/bin/jq -cn --arg t "📌 $1" --arg c "$2" --arg color "${3:-blue}" \
      --arg ts "⏰ $(/bin/date '+%Y/%m/%d %H:%M:%S')" \
      '{header:{title:{content:$t,tag:"plain_text"},template:$color},
        elements:[{tag:"markdown",content:$c},{tag:"note",elements:[{tag:"plain_text",content:$ts}]}]}')"
  out="$("$LARK" im +messages-send --as bot --user-id "$to" --msg-type interactive --content "$card" 2>&1)"
  printf '%s' "$out" | /usr/bin/grep -q '"message_id"' \
    || { echo "[watchdog] 告警发送失败（lark-cli）: $(printf '%s' "$out" | /usr/bin/tr '\n' ' ' | /usr/bin/cut -c1-300)" >&2; return 1; }
  echo "[watchdog] $(/bin/date '+%F %T') 告警已发 message_id=$(printf '%s' "$out" | /usr/bin/jq -r '.data.message_id // empty' 2>/dev/null)"
}

S="$(read_state)"
phase="$(printf '%s' "$S" | jget .phase)"; phase="${phase:-ok}"
since="$(printf '%s' "$S" | jget .since)"; since="${since:-0}"
alerts="$(printf '%s' "$S" | jget .alerts)"; alerts="${alerts:-0}"
last="$(printf '%s' "$S" | jget .last_alert)"; last="${last:-0}"

n_bell="$(count_doorbell)"; n_bell="${n_bell:-0}"
n_app="$(count_app)"

if [ "$n_bell" -ge 1 ]; then
  if [ "$phase" != "ok" ] && [ "$alerts" -gt 0 ]; then
    alert "门铃已恢复" "节点 ${NODE_ID} 的 SSE 门铃重新挂上了（本次缺席 $(( (NOW - since) / 60 )) 分钟）。" "green"
  fi
  printf '{"ts":%s,"phase":"ok","since":%s,"alerts":0,"last_alert":0,"app":%s}\n' "$NOW" "$NOW" "$n_app" > "$STATE"
  exit 0
fi

if [ "$n_app" -eq 0 ]; then
  printf '{"ts":%s,"phase":"app-down","since":%s,"alerts":%s,"last_alert":%s,"app":0}\n' \
    "$NOW" "$since" "$alerts" "$last" > "$STATE"
  exit 0
fi

# 首次转入 down（或状态文件损坏）时把计时起点钉在此刻
if [ "$phase" != "down" ] || [ "$since" -eq 0 ]; then
  since="$NOW"; alerts=0; last=0
fi
dur=$(( NOW - since ))
if [ "$dur" -ge "$GRACE_S" ] && { [ "$alerts" -eq 0 ] || [ $(( NOW - last )) -ge "$REPEAT_S" ]; }; then
  cause="$(classify)"
  if alert "门铃掉了（无人取信）" \
      "节点 ${NODE_ID} 的 SSE 门铃已缺席 $(( dur / 60 )) 分钟，Claude App 仍在跑。死因标记：${cause}。此刻发给该席位的 mesh 消息会静默停驻，需要你手动叫醒会话重挂门铃。" \
      "red"; then
    alerts=$(( alerts + 1 )); last="$NOW"
  fi
fi
printf '{"ts":%s,"phase":"down","since":%s,"alerts":%s,"last_alert":%s,"app":%s}\n' \
  "$NOW" "$since" "$alerts" "$last" "$n_app" > "$STATE"
exit 0
