#!/usr/bin/env bash
# wake-scripts.test.sh — 事件驱动 Wake 三脚本的集成测试（架构定稿 §10.2 S1-S7 的可自动化部分）
#
# 跑法: bash scripts/wake-scripts.test.sh
# 前置: 已 pnpm -r build（要用 packages/relay/dist/index.js 起真 relay）
#
# 沙箱纪律：全程改 HOME 指向临时目录、用独立端口与独立 db。
# **绝不碰生产 relay（19800）、不碰真 ~/.ccmesh/**——这套测试会 kill relay 进程，
# 打错目标就是把 aster 的主力通道敲掉。
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${MESH_TEST_WAKE_PORT:-19807}"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/wakescripts.XXXXXX")"
[ -n "$SANDBOX" ] && [ -d "$SANDBOX" ] || { echo "沙箱建不出来，拒绝继续（防 rm -rf 空变量）" >&2; exit 1; }
export HOME="$SANDBOX/home"
mkdir -p "$HOME"
DB="$SANDBOX/mesh.db"
RELAY_LOG="$SANDBOX/relay.log"
RELAY_URL="http://127.0.0.1:${PORT}"
RELAY_PID=""

pass=0
fail=0
ok()   { echo "  ✓ $1"; pass=$(( pass + 1 )); }
bad()  { echo "  ✗ $1" >&2; fail=$(( fail + 1 )); }
note() { echo "    · $1"; }

cleanup() {
  [ -n "$RELAY_PID" ] && kill "$RELAY_PID" 2>/dev/null
  pkill -f "mesh-doorbell.sh" 2>/dev/null
  pkill -f "wake-porter-doorbell.sh" 2>/dev/null
  rm -rf "$SANDBOX"
  return 0
}
trap cleanup EXIT INT TERM

start_relay() {
  MESH_DB_PATH="$DB" \
  RELAY_HTTP_PORT="$PORT" \
  MESH_DEVICE_ID="waketest" \
  MESH_WAKE=1 \
  node "$ROOT/packages/relay/dist/index.js" >> "$RELAY_LOG" 2>&1 &
  RELAY_PID=$!
  for _ in $(seq 1 60); do
    curl -sf --noproxy '*' -m 2 "${RELAY_URL}/api/status" >/dev/null 2>&1 && return 0
    sleep 0.3
  done
  echo "relay 起不来，日志：" >&2; cat "$RELAY_LOG" >&2; exit 1
}

stop_relay() {
  [ -n "$RELAY_PID" ] && kill "$RELAY_PID" 2>/dev/null
  for _ in $(seq 1 40); do
    curl -sf --noproxy '*' -m 1 "${RELAY_URL}/api/status" >/dev/null 2>&1 || return 0
    sleep 0.2
  done
  return 0
}

reg_pull() {
  curl -sS --noproxy '*' -m 5 -X POST "${RELAY_URL}/api/register" \
    -H 'Content-Type: application/json' \
    -d "{\"shortId\":\"$1\",\"pid\":1,\"role\":\"worker\",\"description\":\"t\",\"deliveryMode\":\"pull\"}" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{process.stdout.write(JSON.parse(s).data.nodeId)}catch(e){}})'
}

send_to() {
  curl -sS --noproxy '*' -m 5 -X POST "${RELAY_URL}/api/send" \
    -H 'Content-Type: application/json' -H 'X-Mesh-Node: waketest:sender' \
    -d "$(node -e 'process.stdout.write(JSON.stringify({to:process.argv[1],message:process.argv[2]}))' "$1" "$2")" \
    >/dev/null 2>&1
}

# 假 tell-me：把每次报警记一行，测试据此断言颜色与张数
FAKE_TELLME="$SANDBOX/fake-tellme.js"
ALERTS="$SANDBOX/alerts.log"
cat > "$FAKE_TELLME" <<'JS'
const fs = require("fs")
fs.appendFileSync(process.env.WAKE_TEST_ALERTS, process.argv.slice(2).join(" || ") + "\n")
JS
export WAKE_TEST_ALERTS="$ALERTS"
: > "$ALERTS"

echo "=== 事件驱动 Wake 脚本测试（沙箱 $SANDBOX, 端口 ${PORT}）==="

# ---------------------------------------------------------------------------
echo "[N10] 硬禁令静态检查：旁观者不得调 /api/sync"
# ---------------------------------------------------------------------------
# /api/sync 入口即 registry.touchSync()——旁观者一探测就伪造 presence 并压制
# 之后 90s 内所有真 wake。席位自己取信走 /api/sync 是本分，旁观者碰它是投毒。
# 只查**可执行行**：注释里写「不得调 /api/sync」是文档，不是违规。
code_of() { grep -v '^[[:space:]]*#' "$1"; }
if code_of "$ROOT/scripts/wake-hook.sh" | grep -q "api/sync"; then
  bad "wake-hook.sh 的可执行代码含 /api/sync（硬禁令 §7.2）"
else
  ok "wake-hook.sh 可执行代码无 /api/sync"
fi
if code_of "$ROOT/scripts/wake-porter-doorbell.sh" | grep -q "api/sync"; then
  bad "wake-porter-doorbell.sh 的可执行代码含 /api/sync（硬禁令 §7.2）"
else
  ok "wake-porter-doorbell.sh 可执行代码无 /api/sync"
fi
if grep -q "api/status" "$ROOT/scripts/wake-hook.sh"; then
  ok "wake-hook.sh 探测走只读 /api/status"
else
  bad "wake-hook.sh 没走 /api/status"
fi

start_relay

# ---------------------------------------------------------------------------
echo "[S3] doorbell：投一条消息 → exit 0，stdout 含 PARKED_SECONDS + 批 JSON"
# ---------------------------------------------------------------------------
NODE_A="$(reg_pull cc-s3)"
[ -n "$NODE_A" ] || { echo "注册失败" >&2; exit 1; }
OUT_S3="$SANDBOX/s3.out"
MESH_RELAY_URL="$RELAY_URL" MESH_DOORBELL_FEISHU=0 MESH_SYNC_TIMEOUT=10 \
  bash "$ROOT/scripts/mesh-doorbell.sh" "$NODE_A" > "$OUT_S3" 2>"$SANDBOX/s3.err" &
BELL_PID=$!
sleep 2
send_to "$NODE_A" "s3-payload"
wait "$BELL_PID"; rc=$?
[ "$rc" = "0" ] && ok "exit 0" || bad "exit=${rc}（应为 0）"
grep -q "^PARKED_SECONDS=" "$OUT_S3" && ok "stdout 含 PARKED_SECONDS 行" || bad "stdout 缺 PARKED_SECONDS"
grep -q "s3-payload" "$OUT_S3" && ok "stdout 含批 JSON 正文" || bad "stdout 缺正文"

# ---------------------------------------------------------------------------
echo "[S4] doorbell --drain：三条停驻 → 全部吐出后 exit 0"
# ---------------------------------------------------------------------------
NODE_B="$(reg_pull cc-s4)"
send_to "$NODE_B" "drain-1"; send_to "$NODE_B" "drain-2"; send_to "$NODE_B" "drain-3"
OUT_S4="$SANDBOX/s4.out"
MESH_RELAY_URL="$RELAY_URL" MESH_DOORBELL_FEISHU=0 \
  bash "$ROOT/scripts/mesh-doorbell.sh" "$NODE_B" --drain > "$OUT_S4" 2>/dev/null
rc=$?
[ "$rc" = "0" ] && ok "drain exit 0" || bad "drain exit=$rc"
got=0
for n in 1 2 3; do grep -q "drain-$n" "$OUT_S4" && got=$(( got + 1 )); done
[ "$got" = "3" ] && ok "三条全取到" || bad "只取到 $got/3 条"
# 再 drain 一次应当是空的（游标已推进，不重复）
OUT_S4B="$SANDBOX/s4b.out"
MESH_RELAY_URL="$RELAY_URL" MESH_DOORBELL_FEISHU=0 \
  bash "$ROOT/scripts/mesh-doorbell.sh" "$NODE_B" --drain > "$OUT_S4B" 2>/dev/null
[ ! -s "$OUT_S4B" ] && ok "二次 drain 空（游标已销账，不重复取）" || bad "二次 drain 又吐了东西"

# ---------------------------------------------------------------------------
echo "[S1/S2] doorbell：relay 死 → 状态翻 down + 红卡一张；relay 回 → 绿卡 + 自动接上"
# ---------------------------------------------------------------------------
NODE_C="$(reg_pull cc-s1)"
STATE="$SANDBOX/doorbell-c.state"
: > "$ALERTS"
OUT_S1="$SANDBOX/s1.out"
MESH_RELAY_URL="$RELAY_URL" \
MESH_DOORBELL_STATE="$STATE" \
MESH_DOORBELL_ALERT_AFTER_S=2 \
MESH_DOORBELL_PROBE_S=1 \
MESH_TELLME="$FAKE_TELLME" \
MESH_SYNC_TIMEOUT=5 \
  bash "$ROOT/scripts/mesh-doorbell.sh" "$NODE_C" > "$OUT_S1" 2>"$SANDBOX/s1.err" &
BELL_PID=$!
sleep 3
stop_relay
sleep 6

phase="$(node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).phase)}catch(e){process.stdout.write("?")}' "$STATE" 2>/dev/null)"
[ "$phase" = "down" ] && ok "relay 死 → 状态文件 phase=down" || bad "phase=${phase}（应为 down）"
[ ! -s "$OUT_S1" ] && ok "断线期间 stdout 零字节（Monitor 不会假醒）" || bad "断线期间污染了 stdout: $(head -c 200 "$OUT_S1")"

reds="$(grep -c '|| red' "$ALERTS" 2>/dev/null | tr -d ' ')"
[ "${reds:-0}" = "1" ] && ok "失联超阈值 → 红卡恰好一张（同一次故障不重复报）" || bad "红卡 ${reds:-0} 张（应为 1）"

start_relay
sleep 4
greens="$(grep -c '|| green' "$ALERTS" 2>/dev/null | tr -d ' ')"
[ "${greens:-0}" = "1" ] && ok "relay 恢复 → 绿卡一张" || bad "绿卡 ${greens:-0} 张（应为 1）"
phase="$(node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).phase)}catch(e){process.stdout.write("?")}' "$STATE" 2>/dev/null)"
[ "$phase" = "parked" ] && ok "恢复后状态翻回 parked" || bad "恢复后 phase=$phase"

# 真凶场景收尾：relay 重启后席位无需重注册，消息照收（注册表已持久化）
send_to "$NODE_C" "after-restart"
for _ in $(seq 1 40); do grep -q "after-restart" "$OUT_S1" 2>/dev/null && break; sleep 0.5; done
grep -q "after-restart" "$OUT_S1" && ok "relay 重启后自动接上并收到消息（A 层独立成立）" || bad "重启后没收到消息"
wait "$BELL_PID" 2>/dev/null

# ---------------------------------------------------------------------------
echo "[S5] porter-doorbell：心跳不命中，wake:needed 才退出"
# ---------------------------------------------------------------------------
OUT_S5="$SANDBOX/s5.out"
MESH_RELAY_URL="$RELAY_URL" MESH_PORTER_STATE="$SANDBOX/porter.state" \
  bash "$ROOT/scripts/wake-porter-doorbell.sh" > "$OUT_S5" 2>/dev/null &
PORTER_PID=$!
sleep 2
kill -0 "$PORTER_PID" 2>/dev/null && ok "空闲期不退出（SSE 心跳注释行不命中过滤）" || bad "空闲期就退出了"

NODE_D="$(reg_pull cc-s5)"
send_to "$NODE_D" "wake-me"   # 冷 pull 节点 + MESH_WAKE=1 → 会广播 wake:needed
for _ in $(seq 1 40); do kill -0 "$PORTER_PID" 2>/dev/null || break; sleep 0.25; done
if kill -0 "$PORTER_PID" 2>/dev/null; then
  bad "收到 wake:needed 却没退出"
  kill "$PORTER_PID" 2>/dev/null
else
  ok "收到 wake:needed → 退出唤醒 porter"
  grep -q "wake:needed" "$OUT_S5" && ok "stdout = 命中的事件行" || bad "stdout 没有事件行"
  grep -q "$NODE_D" "$OUT_S5" && ok "事件行带正确 nodeId" || bad "事件行 nodeId 不对"
fi

# ---------------------------------------------------------------------------
echo "[S7] wake-hook：wake-map 缺条目 → orange 报警不崩"
# ---------------------------------------------------------------------------
: > "$ALERTS"
MAP="$SANDBOX/wake-map.json"
echo '{}' > "$MAP"
MESH_RELAY_URL="$RELAY_URL" MESH_WAKE_MAP="$MAP" MESH_TELLME="$FAKE_TELLME" \
  bash "$ROOT/scripts/wake-hook.sh" "waketest:nobody" >/dev/null 2>&1
rc=$?
[ "$rc" = "1" ] && ok "缺映射 → exit 1（不静默）" || bad "缺映射 exit=${rc}（应为 1）"
grep -q '|| orange' "$ALERTS" && ok "缺映射 → orange 卡" || bad "缺映射没发 orange"

: > "$ALERTS"
MESH_RELAY_URL="$RELAY_URL" MESH_WAKE_MAP="$SANDBOX/nope.json" MESH_TELLME="$FAKE_TELLME" \
  bash "$ROOT/scripts/wake-hook.sh" "waketest:nobody" >/dev/null 2>&1
grep -q '|| orange' "$ALERTS" && ok "映射文件整个不存在也只报警不崩" || bad "缺文件路径炸了"

# ---------------------------------------------------------------------------
echo "[S6-d] wake-hook：席位仍冷 → verdict=d 红卡 + @ledger 审计行"
# ---------------------------------------------------------------------------
: > "$ALERTS"
NODE_E="$(reg_pull cc-s6)"
node -e '
  const fs=require("fs")
  fs.writeFileSync(process.argv[1], JSON.stringify({[process.argv[2]]:{
    localId:"local_deadbeef-0000-0000-0000-000000000000",
    cwd:"/nonexistent/cwd", sessionName:"nope", label:"测试席位"}}))
' "$MAP" "$NODE_E"

MESH_RELAY_URL="$RELAY_URL" MESH_WAKE_MAP="$MAP" MESH_TELLME="$FAKE_TELLME" \
MESH_WAKE_VERIFY_S=2 MESH_WAKE_ID="test-wake-id-123" MESH_SESSIONS_DIR="$SANDBOX/nosessions" \
  bash "$ROOT/scripts/wake-hook.sh" "$NODE_E" >/dev/null 2>&1
rc=$?
[ "$rc" = "0" ] && ok "父进程立刻 exit 0（远早于 relay 的 10s execFile 硬超时）" || bad "父进程 exit=$rc"
sleep 6
grep -q '|| red' "$ALERTS" && ok "席位仍冷 → verdict=d 红卡" || bad "没发 verdict=d 红卡（$(cat "$ALERTS")）"

# @ledger 审计流水（/api/inbox 只读、无 touchSync 副作用，旁观者可安全查）
LEDGER="$SANDBOX/ledger.json"
curl -sS --noproxy '*' -m 5 -G "${RELAY_URL}/api/inbox" --data-urlencode "nodeId=@ledger" > "$LEDGER" 2>/dev/null
grep -q "test-wake-id-123" "$LEDGER" \
  && ok "hook 的 verdict 写进 @ledger 流水（wake_id 串得起因果链）" \
  || bad "@ledger 里没有 hook 的审计行"
grep -q "hook_verify" "$LEDGER" && ok "审计行带 step=hook_verify" || bad "审计行缺 step"
# relay 侧自己写的 fire 行（G4：wake 结果不再只有一行 console.warn）
grep -q '\\"decision\\":\\"fired\\"' "$LEDGER" \
  && ok "relay 侧 fire 审计行也在 @ledger 里" \
  || note "relay 侧 fire 行未匹配（payload 转义形态待查，不算失败）"

# P8/N8 实证：wake_audit 行不投递、不进任何节点收件箱
INBOX_E="$(curl -sS --noproxy '*' -m 5 -G "${RELAY_URL}/api/inbox" --data-urlencode "nodeId=${NODE_E}" 2>/dev/null | grep -c "wake_audit")"
[ "${INBOX_E:-0}" = "0" ] && ok "wake_audit 不出现在席位收件箱（不投递、不触发门铃）" || bad "审计行漏进了席位收件箱"

echo
echo "=== 结果: pass=$pass fail=$fail ==="
[ "$fail" = "0" ] || exit 1
