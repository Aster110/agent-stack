#!/usr/bin/env bash
# E2E: sse-pull 端到端（真 relay 子进程，独立端口/独立 HOME/独立 db）
#
# 覆盖验收 E1/E2/E3/E4/E5 + SSE 断线自愈：
#   E1 起真 relay + 注册 sse-pull 节点 + curl -N /api/events 连上
#   E2 send → accepted + emit msg:send{to} + GET inbox?since 拿正文
#   E3 连发 60 条(>50) 按游标补拉全部不丢
#   E4 POST ack 推进游标 → 再拉只得新，已 ack 不重复
#   E5 真 tmux inject 节点 send → capture-pane 见 [mesh:from] text（零回归活证据）
#   断线自愈：SSE 断后正文仍可按 inbox 游标拉到（at-least-once）
#
# 红线：绝不碰生产 19800 / ~/.ccmesh/db/mesh.db。
# 隔离手段：HOME=<tmp> → meshHome/pidPath/dbPath 全落 tmp；端口随机且断言 !=19800。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELAY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_INDEX="$RELAY_DIR/dist/index.js"

if [[ ! -f "$DIST_INDEX" ]]; then
  echo "错误: 未找到 $DIST_INDEX，请先 cd packages/relay && pnpm build" >&2
  exit 1
fi

CURL=(curl --noproxy "*" -s)

# 安全组 JSON：用 jq -n 注入字符串，避免 bash 引号串味 python dict 字面量
jbody() { jq -nc "$@"; }
# URL-encode nodeId（含冒号）
uenc() { python3 -c "import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))" "$1"; }

TMP_HOME="$(mktemp -d)"
TMP_DB="$(mktemp -u)/e2e-mesh.db"
mkdir -p "$(dirname "$TMP_DB")"
EVENTS_LOG="$(mktemp)"
EVENTS2_LOG="$(mktemp)"
TMUX_SESSION="mesh-e2e-$$"
RELAY_PID=""
CURL_PID=""
CURL2_PID=""
FAILED=0

cleanup() {
  [[ -n "$CURL_PID" ]] && kill "$CURL_PID" 2>/dev/null
  [[ -n "$CURL2_PID" ]] && kill "$CURL2_PID" 2>/dev/null
  [[ -n "$RELAY_PID" ]] && kill "$RELAY_PID" 2>/dev/null
  tmux kill-session -t "$TMUX_SESSION" 2>/dev/null
  rm -rf "$TMP_HOME"
  rm -f "$TMP_DB" "$TMP_DB-wal" "$TMP_DB-shm" "$EVENTS_LOG" "$EVENTS2_LOG"
  rm -rf "$(dirname "$TMP_DB")"
}
trap cleanup EXIT

fail() { echo "✗ FAIL: $*" >&2; FAILED=1; }
ok()   { echo "✓ $*"; }

# ===== 选空闲端口（断言 !=19800，绝不撞生产） =====
PORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("",0));print(s.getsockname()[1]);s.close()')"
if [[ "$PORT" == "19800" ]]; then
  PORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("",0));print(s.getsockname()[1]);s.close()')"
fi
[[ "$PORT" != "19800" ]] || { echo "拒绝使用生产端口 19800" >&2; exit 1; }
BASE="http://localhost:$PORT/api"

# ===== 起真 relay 子进程（隔离 HOME + db + deviceId，无 HUB → LocalTransport） =====
env -u MESH_HUB_URL \
  HOME="$TMP_HOME" \
  MESH_DB_PATH="$TMP_DB" \
  MESH_DEVICE_ID="e2edev" \
  RELAY_HTTP_PORT="$PORT" \
  node "$DIST_INDEX" >"$TMP_HOME/relay.log" 2>&1 &
RELAY_PID=$!

# 轮询健康
healthy=0
for _ in $(seq 1 30); do
  if "${CURL[@]}" "$BASE/status" >/dev/null 2>&1; then healthy=1; break; fi
  sleep 0.5
done
if [[ "$healthy" != "1" ]]; then
  echo "relay 未就绪，日志：" >&2; cat "$TMP_HOME/relay.log" >&2; exit 1
fi
ok "E1: relay 起在端口 $PORT (PID $RELAY_PID, db=$TMP_DB)"

# ===== 注册 sse-pull 节点（省略 sessionId） =====
REG="$("${CURL[@]}" -H "Content-Type: application/json" -X POST "$BASE/register" \
  -d '{"shortId":"cc-e2e-pull","pid":111,"role":"worker","description":"sse-pull e2e","deliveryMode":"sse-pull"}')"
PULL_NODE="$(printf '%s' "$REG" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['nodeId'])")"
[[ -n "$PULL_NODE" ]] || { fail "注册 sse-pull 节点失败: $REG"; exit 1; }
# /api/status 该节点 sessionId 为 nopane- 占位
SESS="$("${CURL[@]}" "$BASE/status" | python3 -c "import sys,json
d=json.load(sys.stdin)
n=[x for x in d['data']['nodes'] if x['identity']['nodeId']=='$PULL_NODE'][0]
print(n['sessionId'])")"
case "$SESS" in
  nopane-*) ok "E1: sse-pull 节点占位 sessionId=$SESS（nopane- 前缀）" ;;
  *) fail "E1: sse-pull 占位 sessionId 应为 nopane- 前缀，实际 $SESS" ;;
esac

# ===== 挂 curl -N /api/events（门铃 watcher） =====
"${CURL[@]}" -N "$BASE/events" >"$EVENTS_LOG" 2>/dev/null &
CURL_PID=$!
connected=0
for _ in $(seq 1 20); do
  if grep -q ": connected" "$EVENTS_LOG" 2>/dev/null; then connected=1; break; fi
  sleep 0.2
done
[[ "$connected" == "1" ]] && ok "E1: curl -N /api/events 收到首帧 ': connected'" || fail "E1: 未收到 SSE connected 首帧"

# ===== E2: send → accepted + emit msg:send{to} + inbox?since 拿正文 =====
SEND="$("${CURL[@]}" -H "Content-Type: application/json" -H "X-Mesh-Node: e2edev:cc-sender" \
  -X POST "$BASE/send" -d "$(jbody --arg to "$PULL_NODE" '{to:$to,message:"hello e2e body"}')")"
STATUS="$(printf '%s' "$SEND" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['status'])")"
[[ "$STATUS" == "accepted" ]] && ok "E2: send 返回 status=accepted" || fail "E2: send 应 accepted, 实际 $STATUS"

# SSE 门铃：events.log 落地一条 msg:send 含 data.to==PULL_NODE
sleep 0.5
RING="$(python3 - "$EVENTS_LOG" "$PULL_NODE" <<'PY'
import sys,json
log=open(sys.argv[1]).read().splitlines()
target=sys.argv[2]
found=False
for line in log:
    if not line.startswith("data: "): continue
    try:
        obj=json.loads(line[len("data: "):])
    except Exception:
        continue
    if obj.get("event")=="msg:send" and obj.get("data",{}).get("to")==target:
        found=True
print("yes" if found else "no")
PY
)"
[[ "$RING" == "yes" ]] && ok "E2: SSE 门铃 emit msg:send{to=$PULL_NODE}" || fail "E2: 未在 SSE 收到 msg:send 门铃"

# inbox?since=0 拿裸正文（不含 [mesh:] 前缀，前缀只在投递路径）
BODY="$("${CURL[@]}" "$BASE/inbox?nodeId=$(uenc "$PULL_NODE")&since=0" | python3 -c "import sys,json
d=json.load(sys.stdin)
ms=[m for m in d['data']['messages'] if m['payload']=='hello e2e body']
print('found' if ms else 'missing')
print(ms[0].get('seq') if ms else '')
print('hasprefix' if (ms and ms[0]['payload'].startswith('[mesh:')) else 'noprefix')")"
read -r FOUND SEQ PFX <<<"$(printf '%s' "$BODY" | tr '\n' ' ')"
[[ "$FOUND" == "found" ]] && ok "E2: inbox?since=0 拿到正文(seq=$SEQ)" || fail "E2: inbox 未取到正文"
[[ "$PFX" == "noprefix" ]] && ok "E2: inbox 正文为裸 payload（无 [mesh:] 前缀）" || fail "E2: inbox 正文不应带 [mesh:] 前缀"

# ===== E3: 连发 60 条(>50) 按游标补拉全部不丢 =====
for i in $(seq 1 60); do
  "${CURL[@]}" -H "Content-Type: application/json" -H "X-Mesh-Node: e2edev:cc-sender" \
    -X POST "$BASE/send" -d "$(jbody --arg to "$PULL_NODE" --arg m "bulk-marker-$i" '{to:$to,message:$m}')" >/dev/null
done
COLLECTED="$(python3 - "$BASE" "$PULL_NODE" <<'PY'
import sys,json,urllib.request,urllib.parse
base=sys.argv[1]; node=sys.argv[2]
cursor=0; markers=set()
def get(since):
    url=f"{base}/inbox?nodeId={urllib.parse.quote(node)}&since={since}"
    req=urllib.request.Request(url)
    with urllib.request.urlopen(req) as r:
        return json.load(r)["data"]["messages"]
for _ in range(20):
    msgs=get(cursor)
    if not msgs: break
    for m in msgs:
        if m["payload"].startswith("bulk-marker-"):
            markers.add(m["payload"])
        if m.get("seq") is not None and m["seq"]>cursor:
            cursor=m["seq"]
print(len(markers))
PY
)"
[[ "$COLLECTED" == "60" ]] && ok "E3: 连发 60 条按游标补拉全部不丢(收集 $COLLECTED)" || fail "E3: 应补拉 60 条, 实际 $COLLECTED"

# ===== E4: POST ack 推进游标 → 再拉只得新, 已 ack 不重复 =====
# 取当前最大游标 c1
C1="$("${CURL[@]}" "$BASE/inbox?nodeId=$(uenc "$PULL_NODE")&since=0" | python3 -c "import sys,json
d=json.load(sys.stdin)
seqs=[m['seq'] for m in d['data']['messages'] if m.get('seq') is not None]
print(max(seqs) if seqs else 0)")"
"${CURL[@]}" -H "Content-Type: application/json" -X POST "$BASE/ack" \
  -d "$(jbody --arg n "$PULL_NODE" --argjson up "$C1" '{nodeId:$n,upTo:$up}')" >/dev/null
# 再发 2 条
for i in 1 2; do
  "${CURL[@]}" -H "Content-Type: application/json" -H "X-Mesh-Node: e2edev:cc-sender" \
    -X POST "$BASE/send" -d "$(jbody --arg to "$PULL_NODE" --arg m "after-ack-$i" '{to:$to,message:$m}')" >/dev/null
done
AFTER="$("${CURL[@]}" "$BASE/inbox?nodeId=$(uenc "$PULL_NODE")&since=$C1" | python3 -c "import sys,json
d=json.load(sys.stdin)
ms=d['data']['messages']
newm=[m['payload'] for m in ms if m['payload'].startswith('after-ack-')]
oldm=[m for m in ms if not m['payload'].startswith('after-ack-')]
print(len(newm))
print(len(oldm))")"
read -r NEWN OLDN <<<"$(printf '%s' "$AFTER" | tr '\n' ' ')"
[[ "$NEWN" == "2" && "$OLDN" == "0" ]] && ok "E4: ack 后 inbox?since=$C1 只得 2 条新, 已 ack 不重复" || fail "E4: 期望 2 新 0 旧, 实际 new=$NEWN old=$OLDN"
# 幂等：再拉一次同结果
AFTER2="$("${CURL[@]}" "$BASE/inbox?nodeId=$(uenc "$PULL_NODE")&since=$C1" | python3 -c "import sys,json
d=json.load(sys.stdin)
print(len([m for m in d['data']['messages'] if m['payload'].startswith('after-ack-')]))")"
[[ "$AFTER2" == "2" ]] && ok "E4: 重复拉取幂等(仍 2 条新)" || fail "E4: 幂等失败, 实际 $AFTER2"

# ===== 断线自愈：SSE 断后正文仍可按 inbox 游标拉到 =====
# 记录当前游标 c
CHEAL="$("${CURL[@]}" "$BASE/inbox?nodeId=$(uenc "$PULL_NODE")&since=0" | python3 -c "import sys,json
d=json.load(sys.stdin)
seqs=[m['seq'] for m in d['data']['messages'] if m.get('seq') is not None]
print(max(seqs) if seqs else 0)")"
# kill SSE（模拟断线）
kill "$CURL_PID" 2>/dev/null; CURL_PID=""
# 断线期间发 2 条
for i in 1 2; do
  "${CURL[@]}" -H "Content-Type: application/json" -H "X-Mesh-Node: e2edev:cc-sender" \
    -X POST "$BASE/send" -d "$(jbody --arg to "$PULL_NODE" --arg m "offline-$i" '{to:$to,message:$m}')" >/dev/null
done
HEAL="$("${CURL[@]}" "$BASE/inbox?nodeId=$(uenc "$PULL_NODE")&since=$CHEAL" | python3 -c "import sys,json
d=json.load(sys.stdin)
print(len([m for m in d['data']['messages'] if m['payload'].startswith('offline-')]))")"
[[ "$HEAL" == "2" ]] && ok "E2自愈: SSE 断线期间 2 条仍能按 inbox 游标补拉(0 丢失)" || fail "E2自愈: 断线补拉失败, 实际 $HEAL"

# ===== E5: 真 tmux inject 节点 send → capture-pane 见 [mesh:from] text =====
if command -v tmux >/dev/null 2>&1; then
  tmux new-session -d -s "$TMUX_SESSION" "cat" 2>/dev/null
  sleep 0.3
  if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    REG2="$("${CURL[@]}" -H "Content-Type: application/json" -X POST "$BASE/register" \
      -d "$(jbody --arg s "$TMUX_SESSION" '{shortId:"cc-e2e-tmux",sessionId:$s,pid:222,role:"worker",description:"tmux inject",deliveryMode:"inject"}')")"
    TMUX_NODE="$(printf '%s' "$REG2" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['nodeId'])")"
    FROM="e2edev:cc-tmux-sender"
    SEND2="$("${CURL[@]}" -H "Content-Type: application/json" -H "X-Mesh-Node: $FROM" \
      -X POST "$BASE/send" -d "$(jbody --arg to "$TMUX_NODE" '{to:$to,message:"tmux-payload-xyz"}')")"
    ST2="$(printf '%s' "$SEND2" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['status'])")"
    [[ "$ST2" == "delivered" ]] && ok "E5: inject 节点 send status=delivered" || fail "E5: inject 应 delivered, 实际 $ST2"
    sleep 0.8
    PANE="$(tmux capture-pane -t "$TMUX_SESSION" -p 2>/dev/null)"
    if printf '%s' "$PANE" | grep -q "\[mesh:$FROM\] tmux-payload-xyz"; then
      ok "E5: capture-pane 见 [mesh:$FROM] tmux-payload-xyz（tmux 零回归活证据）"
    else
      fail "E5: capture-pane 未见预期注入文本。pane:
$PANE"
    fi
  else
    echo "⚠ E5 跳过：tmux session 起不来（CI 无 tmux 环境）"
  fi
else
  echo "⚠ E5 跳过：本机无 tmux"
fi

# ===== 收尾汇总 =====
if [[ "$FAILED" == "0" ]]; then
  echo "ALL PASS: sse-pull.e2e"
  exit 0
else
  echo "E2E 有失败项" >&2
  exit 1
fi
