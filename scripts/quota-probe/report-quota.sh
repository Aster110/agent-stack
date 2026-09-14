#!/usr/bin/env bash
# report-quota.sh — 把额度探针 JSON 通过 mesh relay 记进云端账本
#
# 走本机 relay：POST http://localhost:19800/api/send
# body: {"to":"@ledger","type":"quota_report","message":"<探针JSON字符串>"}
#
# 默认收件人是记账哨兵 @ledger（不是某个 agent）：relay 遇到它只落库不投递，
# LedgerSync 再把它和普通消息一起游标上行到云端 Ledger，Hub 投影器按 type 分流
# 写 quota_snapshots。想同时通知主脑就再发一份 --to <主脑nodeId>。
# 设计：docs/UNIFIED-RUNTIME.md §4.3/§5
#
# 默认 --dry-run：只打印将要发的 URL + body，不真发（此刻 relay 可能没起、主脑节点还不存在）。
#
# 「不丢数据」具体指两条，别当成万能保证：
#   1. 探针 status=unavailable（退出码 1）→ 照样组 body 上报，不静默死。
#      没凭证/没登录本身就是要送上去的情报，云端靠它知道这台机采不到额度。
#   2. --send 时 relay 不可达 → 把 body 打到 stdout 而非报错（exit 0），人工可捞。
# 探针吐不出可解析信封（空/非 JSON）则是真故障：立刻报错退出，不发空 body。
#
# 用法:
#   bash report-quota.sh --source codex                 # dry-run，跑 codex 探针并打印将发内容
#   bash report-quota.sh --source claude --send         # 真发（relay 不可达则优雅降级）
#   bash report-quota.sh --input probe.json             # 用现成 JSON，不跑探针（- 表示 stdin）
#   bash report-quota.sh --source codex --to macbook:cc-brain --from computer2-quota
#
# 选项:
#   --source codex|claude   跑哪个探针（未给 --input 时必填）
#   --input FILE            用现成探针 JSON（- = stdin），跳过跑探针
#   --from NODE             上报方节点名（默认 <hostname>-quota）
#   --to NODE              收件人（默认 @ledger 记账哨兵；也可传主脑完整 nodeId）
#   --type TYPE            mesh 消息类型（默认 quota_report）
#   --relay URL           relay 地址（默认 http://localhost:19800）
#   --dry-run             只打印不发（默认）
#   --send                真发
#   --raw                 透传给探针，附原始额度快照
#   --timeout N           探针/请求超时秒（默认 100）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="${PYTHON:-python3}"

SOURCE=""
INPUT=""
FROM_NODE="$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')-quota"
TO_NODE="@ledger"
MSG_TYPE="quota_report"
RELAY="http://localhost:19800"
MODE="dry-run"
RAW=""
TIMEOUT="100"

while [ $# -gt 0 ]; do
  case "$1" in
    --source)  SOURCE="$2"; shift 2;;
    --input)   INPUT="$2"; shift 2;;
    --from)    FROM_NODE="$2"; shift 2;;
    --to)      TO_NODE="$2"; shift 2;;
    --type)    MSG_TYPE="$2"; shift 2;;
    --relay)   RELAY="$2"; shift 2;;
    --dry-run) MODE="dry-run"; shift;;
    --send)    MODE="send"; shift;;
    --raw)     RAW="--raw"; shift;;
    --timeout) TIMEOUT="$2"; shift 2;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) echo "未知参数: $1" >&2; exit 2;;
  esac
done

# 1) 取探针 JSON
#
# 探针退出码语义（见各探针 main()）：status=ok → 0，status=unavailable → 1。
# 「不可用」是**正常业务结果**（这台机没登录 / 凭证过期），必须照样上报——
# 云端账本正是靠这条 unavailable 才知道某台机的额度采不到。
# 但本脚本开着 `set -euo pipefail`：命令替换一返回非零就当场终止，
# 过去探针一 unavailable 整个脚本静默死、零输出、快照凭空蒸发
# （2026-08-27 实测 claude 分支——本机 keychain 里 claudeAiOauth 已不在）。
# 所以这里显式接住退出码，成败只看**有没有吐出可解析的信封**，不看退出码。
if [ -n "$INPUT" ]; then
  if [ "$INPUT" = "-" ]; then
    PROBE_JSON="$(cat)"
  else
    PROBE_JSON="$(cat "$INPUT")"
  fi
elif [ -n "$SOURCE" ]; then
  case "$SOURCE" in
    codex)  PROBE_SCRIPT="$SCRIPT_DIR/probe_codex.py";;
    claude) PROBE_SCRIPT="$SCRIPT_DIR/probe_claude.py";;
    *) echo "--source 只能是 codex 或 claude" >&2; exit 2;;
  esac
  # 注意：这段必须留在**父 shell**里。包成函数再 `PROBE_JSON="$(run_probe)"` 的话，
  # 函数里的 exit 只杀得死命令替换那个子 shell，父 shell 会揣着空 JSON 继续往下跑。
  set +e
  PROBE_JSON="$("$PY" "$PROBE_SCRIPT" --timeout "$TIMEOUT" $RAW)"
  PROBE_RC=$?
  set -e
  # 空输出 / 非 JSON / 没有 status 字段 = 探针是真炸了（语法错、解释器缺失、崩在半路），
  # 这才叫失败：响亮报错退出，绝不把空 body 当成一次成功上报发出去。
  if ! printf '%s' "$PROBE_JSON" | "$PY" -c \
       'import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
sys.exit(0 if isinstance(d, dict) and "status" in d else 1)' 2>/dev/null; then
    # 变量名一律加花括号：后面紧跟全角「）」时，裸 $PROBE_RC 会把多字节字符
    # 吃进变量名，set -u 下直接 "unbound variable" 把脚本崩在错误处理里。
    echo "❌ 探针未输出可解析的额度信封（exit=${PROBE_RC}）: ${PROBE_SCRIPT}" >&2
    if [ -n "$PROBE_JSON" ]; then
      echo "--- 探针原始输出 ---" >&2
      printf '%s\n' "$PROBE_JSON" >&2
    fi
    exit 1
  fi
else
  echo "必须给 --source codex|claude 或 --input FILE" >&2
  exit 2
fi

# 2) 组装 mesh send body（用 python 安全转义，content 是探针 JSON 的字符串形式）
ENDPOINT="$RELAY/api/send"
BODY="$(FROM_NODE="$FROM_NODE" TO_NODE="$TO_NODE" MSG_TYPE="$MSG_TYPE" \
        "$PY" - "$PROBE_JSON" <<'PYEOF'
import json, os, sys
probe_json = sys.argv[1]
# relay POST /api/send 的契约（server.ts）：body 只认 {to, message, type?,
# replyTo?, priority?}，发送方走 X-Mesh-Node 请求头 —— 不是 body 里的 from。
# 探针 JSON 整个作为 message 正文，接收端解析出来即得完整额度快照。
body = {
    "to": os.environ["TO_NODE"],
    "message": probe_json,
    "type": os.environ["MSG_TYPE"],
}
print(json.dumps(body, ensure_ascii=False))
PYEOF
)"

# 3) dry-run 或真发
if [ "$MODE" = "dry-run" ]; then
  echo "=== DRY-RUN（未发送）==="
  echo "POST $ENDPOINT"
  echo "--- body ---"
  echo "$BODY" | "$PY" -m json.tool --no-ensure-ascii 2>/dev/null || echo "$BODY"
  echo
  echo "--- 等价 curl ---"
  echo "curl -s -X POST '$ENDPOINT' -H 'Content-Type: application/json' -H 'X-Mesh-Node: $FROM_NODE' -d '<上面的 body>'"
  exit 0
fi

# --send：relay 不可达则优雅降级
if ! curl -sm 3 --noproxy '*' "$RELAY/api/status" >/dev/null 2>&1; then
  echo "⚠️  relay 不可达（${RELAY}），未发送。以下是原本要发的 body（未丢失）：" >&2
  echo "$BODY"
  exit 0
fi

RESP="$(curl -s -m "$TIMEOUT" --noproxy '*' -X POST "$ENDPOINT" \
        -H 'Content-Type: application/json' -H "X-Mesh-Node: $FROM_NODE" -d "$BODY" 2>&1)" || {
  echo "⚠️  发送出错，body 未丢失：" >&2
  echo "$BODY"
  exit 0
}
echo "=== 已发送到 $ENDPOINT ==="
echo "relay 响应: $RESP"
