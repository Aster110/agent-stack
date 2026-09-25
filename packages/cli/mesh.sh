#!/usr/bin/env bash
# mesh — cc-mesh CLI（纯 curl 封装）
# 用法: mesh <command> [args]

set -euo pipefail

RELAY="${MESH_RELAY_URL:-http://localhost:19800}/api"
NODE="${MESH_NODE:-}"
PID_FILE="$HOME/.ccmesh/relay.pid"
RELAY_SESSION="${MESH_RELAY_SESSION:-mesh-relay}"
RELAY_LOG="${MESH_RELAY_LOG:-/tmp/mesh-relay.log}"
HUB_URL_FILE="$HOME/.ccmesh/hub-url"
LEDGER_URL_FILE="$HOME/.ccmesh/ledger-url"
HUB_TOKEN_FILE="$HOME/.ccmesh/hub-token"
CURL=(curl --noproxy "*" -sf)
LEDGER_JSON=0

# Hub 地址解析：env MESH_HUB_URL > ~/.ccmesh/hub-url 文件（一行 ws:// 地址）> 空（禁用 Hub，纯本机模式）
hub_url() {
  if [[ -n "${MESH_HUB_URL+x}" ]]; then
    printf '%s' "$MESH_HUB_URL"
    return 0
  fi
  if [[ -f "$HUB_URL_FILE" ]]; then
    head -n 1 "$HUB_URL_FILE" | tr -d '[:space:]'
    return 0
  fi
  printf ''
}

# ===== 云端账本（Ledger）客户端 =====
# 读 API 在 Hub 旁的 :19901（设计 §7）。CLI 是薄客户端：只管解析地址、带 token、排表。
# 地址优先级：env MESH_LEDGER_URL > ~/.ccmesh/ledger-url（单行 URL）> http://127.0.0.1:19901
ledger_url() {
  local u=""
  if [[ -n "${MESH_LEDGER_URL:-}" ]]; then
    u="$MESH_LEDGER_URL"
  elif [[ -f "$LEDGER_URL_FILE" ]]; then
    u="$(head -n 1 "$LEDGER_URL_FILE" | tr -d '[:space:]')"
  fi
  [[ -z "$u" ]] && u="http://127.0.0.1:19901"
  printf '%s' "${u%/}"
}

# token 优先级：env MESH_HUB_TOKEN > ~/.ccmesh/hub-token（与 relay 连 Hub 同一个 token）
hub_token() {
  if [[ -n "${MESH_HUB_TOKEN:-}" ]]; then
    printf '%s' "$MESH_HUB_TOKEN"
    return 0
  fi
  if [[ -f "$HUB_TOKEN_FILE" ]]; then
    local t
    t="$(head -n 1 "$HUB_TOKEN_FILE" | tr -d '[:space:]')"
    if [[ -n "$t" ]]; then
      printf '%s' "$t"
      return 0
    fi
  fi
  return 1
}

urlenc() {
  python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"
}

# qs_add <当前query> <key> <value> —— value 为空则原样返回（不拼空参数）
qs_add() {
  local q="$1" k="$2" v="${3:-}"
  if [[ -z "$v" ]]; then
    printf '%s' "$q"
    return 0
  fi
  local enc
  enc="$(urlenc "$v")"
  if [[ -z "$q" ]]; then
    printf '%s=%s' "$k" "$enc"
  else
    printf '%s&%s=%s' "$q" "$k" "$enc"
  fi
}

# ledger_get <path> [query] —— GET 云端账本，Bearer token 必带，HTTP 错误给人话
ledger_get() {
  local api_path="$1"
  local query="${2:-}"
  local token
  if ! token="$(hub_token)"; then
    cat >&2 <<EOF
错误: 找不到 Hub token —— 云端账本 API 必须带 Bearer token。
  放一行 token 到:  $HUB_TOKEN_FILE
  或临时设环境变量: export MESH_HUB_TOKEN=<token>
  （和 relay 连 Hub 用的是同一个 token，s3 Hub 部署时生成）
EOF
    exit 1
  fi
  local url
  url="$(ledger_url)$api_path"
  [[ -n "$query" ]] && url="$url?$query"

  local resp
  resp="$(curl --noproxy '*' -s -m 15 -w $'\n%{http_code}' \
    -H "Authorization: Bearer $token" "$url")" || {
    echo "错误: 请求云端账本失败: $url" >&2
    exit 1
  }
  local code="${resp##*$'\n'}"
  local body="${resp%$'\n'*}"
  case "$code" in
    # ⚠️ 变量后面紧跟中文标点一律 ${} 包起来：bash 3.2(macOS 自带)会把多字节标点的
    #    首字节当成变量名的一部分，$code）→ "code?: unbound variable"，报错路径直接哑火。
    200) printf '%s' "$body" ;;
    000) echo "错误: 连不上云端账本 ${url}（Hub 没起？地址不对？可设 MESH_LEDGER_URL 或写 ${LEDGER_URL_FILE}）" >&2; exit 1 ;;
    401|403) echo "错误: 云端账本拒绝了 token（HTTP ${code}）。检查 ${HUB_TOKEN_FILE} 是否与 Hub 一致" >&2; exit 1 ;;
    404) echo "错误: 云端账本没有这个端点（HTTP 404）: ${url} —— Hub 版本可能还没带 Ledger API" >&2; exit 1 ;;
    *) echo "错误: 云端账本返回 HTTP ${code}" >&2; [[ -n "$body" ]] && echo "$body" >&2; exit 1 ;;
  esac
}

# ledger_render <优先列,逗号分隔> —— stdin 收 JSON，排成表。
# 只打印数据里真实存在的优先列（Hub 侧字段增删不会把 CLI 打挂）；一列都没命中就用首行的全部键。
# LEDGER_JSON=1（--json）则原样美化输出。
# ⚠️ 必须用 python3 -c "$LEDGER_RENDER_PY"：`python3 - <<PY` 会把 heredoc 当 stdin，
#    管道进来的 JSON 就被吃掉了（render 读到空、上游 printf 撞 SIGPIPE，整条命令 141 退出）。
LEDGER_RENDER_PY='
import json
import sys

prefer = [c for c in sys.argv[1].split(",") if c]
as_json = sys.argv[2] == "1"
raw = sys.stdin.read().strip()
if not raw:
    print("(空响应)")
    raise SystemExit(0)
try:
    doc = json.loads(raw)
except json.JSONDecodeError:
    print(raw)
    raise SystemExit(0)

if as_json:
    print(json.dumps(doc, ensure_ascii=False, indent=2))
    raise SystemExit(0)

if isinstance(doc, dict) and doc.get("ok") is False:
    print("错误: %s" % doc.get("error", doc), file=sys.stderr)
    raise SystemExit(1)

def extract(node):
    if isinstance(node, list):
        return node
    if isinstance(node, dict):
        for key in ("data", "rows", "items", "messages", "tasks", "agents", "quota", "snapshots", "events"):
            if key in node:
                return extract(node[key])
        return [node]
    return [node]

rows = [r for r in extract(doc) if isinstance(r, dict)]
if not rows:
    print("(无数据)")
    raise SystemExit(0)

def dig(row, col):
    # 支持点路径：quota.pct5h → row["quota"]["pct5h"]（Hub 的 agents 行把额度嵌在 quota 里）
    node = row
    for part in col.split("."):
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node

def has(row, col):
    node = row
    for part in col.split("."):
        if not isinstance(node, dict) or part not in node:
            return False
        node = node[part]
    return True

cols = [c for c in prefer if any(has(r, c) for r in rows)]
if not cols:
    cols = list(rows[0].keys())

def cell(v):
    if v is None:
        return "-"
    if isinstance(v, bool):
        return "true" if v else "false"   # 不然 python 的 True/False 直接漏进表里
    if isinstance(v, (dict, list)):
        v = json.dumps(v, ensure_ascii=False)
    s = str(v).replace("\n", " ").replace("\t", " ")
    return s[:57] + "..." if len(s) > 60 else s

table = [cols] + [[cell(dig(r, c)) for c in cols] for r in rows]
widths = [max(len(row[i]) for row in table) for i in range(len(cols))]
for i, row in enumerate(table):
    print("  ".join(v.ljust(widths[j]) for j, v in enumerate(row)).rstrip())
    if i == 0:
        print("  ".join("-" * w for w in widths))
print("\n%d 行" % len(rows))
'

ledger_render() {
  python3 -c "$LEDGER_RENDER_PY" "$1" "${LEDGER_JSON:-0}"
}

cmd_quota() {
  local query=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --account) query="$(qs_add "$query" account "${2:-}")"; shift 2 ;;
      --history) query="$(qs_add "$query" history 1)"; shift ;;
      --json)    LEDGER_JSON=1; shift ;;
      *) echo "错误: 未知参数 '$1'（用法: mesh quota [--account <fp>] [--history] [--json]）" >&2; exit 1 ;;
    esac
  done
  ledger_get /api/ledger/quota "$query" \
    | ledger_render "host,source,accountFp,plan,status,pct5h,pct7d,resets5h,resets7d,probedAt"
}

cmd_tasks() {
  local query=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --status)  query="$(qs_add "$query" status "${2:-}")"; shift 2 ;;
      --project) query="$(qs_add "$query" project "${2:-}")"; shift 2 ;;
      --since)   query="$(qs_add "$query" since "${2:-}")"; shift 2 ;;
      --todo)    query="$(qs_add "$query" todoUid "${2:-}")"; shift 2 ;;
      --json)    LEDGER_JSON=1; shift ;;
      *) echo "错误: 未知参数 '$1'（用法: mesh tasks [--status s] [--project p] [--since t] [--todo uid] [--json]）" >&2; exit 1 ;;
    esac
  done
  ledger_get /api/ledger/tasks "$query" \
    | ledger_render "taskId,title,project,fromNode,toNode,seatId,status,pickReason,createdAt,repliedAt,replyMsgId,todoUid"
}

cmd_agents() {
  local query=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --json) LEDGER_JSON=1; shift ;;
      *) echo "错误: 未知参数 '$1'（用法: mesh agents [--json]）" >&2; exit 1 ;;
    esac
  done
  ledger_get /api/ledger/agents "$query" \
    | ledger_render "seatId,device,agentKind,online,active,delivery,accountFp,quota.pct5h,quota.pct7d,capabilities,nodes,updatedAt"
}

cmd_log() {
  local query=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --to)    query="$(qs_add "$query" to "${2:-}")"; shift 2 ;;
      --from)  query="$(qs_add "$query" from "${2:-}")"; shift 2 ;;
      --type)  query="$(qs_add "$query" type "${2:-}")"; shift 2 ;;
      --since) query="$(qs_add "$query" since "${2:-}")"; shift 2 ;;
      --limit) query="$(qs_add "$query" limit "${2:-}")"; shift 2 ;;
      --json)  LEDGER_JSON=1; shift ;;
      *) echo "错误: 未知参数 '$1'（用法: mesh log [--to x] [--from x] [--type t] [--since t] [--limit n] [--json]）" >&2; exit 1 ;;
    esac
  done
  ledger_get /api/ledger/messages "$query" \
    | ledger_render "createdAt,from,to,type,payload,status,priority,srcRelay,srcSeq,id"
}

dispatch_usage() {
  cat <<'EOF'
用法: mesh dispatch --to <node> --title <标题> [--project <p>] [--todo <uid>] <任务正文>

选项:
  --to <full-nodeId>   目标席位（v1 必填：显式直达，不猜席位）
  --title <标题>        任务标题（进 meta，不进 worker 正文）
  --project <p>         项目号（可选，进 meta）
  --todo <uid>          关联的 cc-todo uid（可选，进 meta._task.todoUid → 账本 tasks.todo_uid，
                        手机端按它把派单归到个人任务下；uid 看 cc-todo get <id>）
  --help / -h           查看本帮助

说明:
  打的是本机 relay 的 POST /api/dispatch —— 与 mesh send 同一条投递路径，
  区别只是 type=task + meta._task 信封（标题/项目/选座理由），
  worker 看到的正文就是 <任务正文> 原文，一个字不多。
  返回 {taskId, msgId, pick}；taskId 就是云端 tasks 表的主键。
EOF
}

cmd_dispatch() {
  local to="" title="" project="" todo="" payload=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --help|-h) dispatch_usage; exit 0 ;;
      --to)      to="${2:-}"; shift 2 ;;
      --title)   title="${2:-}"; shift 2 ;;
      --project) project="${2:-}"; shift 2 ;;
      --todo)    todo="${2:-}"; shift 2 ;;
      *)
        if [[ -z "$payload" ]]; then payload="$1"; else payload="$payload $1"; fi
        shift
        ;;
    esac
  done
  [[ -z "$to" ]] && { echo "错误: 缺少 --to <full-nodeId>（v1 派单必须显式指定目标）" >&2; exit 1; }
  [[ -z "$title" ]] && { echo "错误: 缺少 --title <标题>" >&2; exit 1; }
  [[ -z "$payload" ]] && { echo "错误: 缺少任务正文（payload）" >&2; exit 1; }

  local body
  body="$(MESH_D_TITLE="$title" MESH_D_PAYLOAD="$payload" MESH_D_TO="$to" MESH_D_PROJECT="$project" \
    MESH_D_TODO="$todo" python3 - <<'PY'
import json
import os

body = {
    "title": os.environ["MESH_D_TITLE"],
    "payload": os.environ["MESH_D_PAYLOAD"],
    "to": os.environ["MESH_D_TO"],
}
if os.environ.get("MESH_D_PROJECT"):
    body["project"] = os.environ["MESH_D_PROJECT"]
if os.environ.get("MESH_D_TODO"):
    body["todoUid"] = os.environ["MESH_D_TODO"]
print(json.dumps(body, ensure_ascii=False))
PY
  )"
  "${CURL[@]}" "${H[@]}" -X POST "$RELAY/dispatch" -d "$body"
  echo
}

resolve_script_dir() {
  local source="${BASH_SOURCE[0]}"
  while [[ -L "$source" ]]; do
    local dir
    dir="$(cd -P "$(dirname "$source")" && pwd)"
    source="$(readlink "$source")"
    [[ "$source" != /* ]] && source="$dir/$source"
  done
  cd -P "$(dirname "$source")" && pwd
}

relay_dir() {
  local script_dir
  script_dir="$(resolve_script_dir)"
  if [[ -d "$script_dir/../relay/dist" ]]; then
    printf '%s\n' "$(cd "$script_dir/../relay" && pwd)"
    return 0
  fi
  return 1
}

relay_port_pid() {
  lsof -tiTCP:19800 -sTCP:LISTEN 2>/dev/null | head -n 1 || true
}

relay_http_ok() {
  "${CURL[@]}" "$RELAY/status" >/dev/null 2>&1
}

relay_wait_healthy() {
  local attempts="${1:-10}"
  local i=0
  while (( i < attempts )); do
    if relay_http_ok; then
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  return 1
}

relay_session_exists() {
  tmux has-session -t "$RELAY_SESSION" 2>/dev/null
}

relay_help() {
  cat <<EOF
用法: mesh relay <subcommand>

子命令:
  start      启动 relay；若已有健康实例则直接返回
  stop       停止 relay；优先杀 tmux session，再兜底清理 19800 监听
  restart    强制重启 relay，确保吃到最新代码
  status     查看 relay 状态（tmux / port / http）
  logs       查看 relay 最近日志；传 --follow 时 tail -f ${RELAY_LOG}
  help       查看本帮助

约定:
  tmux session: ${RELAY_SESSION}
  log file:     ${RELAY_LOG}
  pid file:     ${PID_FILE}
EOF
}

# 通用 JSON header
H=(-H "Content-Type: application/json")
[[ -n "$NODE" ]] && H+=(-H "X-Mesh-Node: $NODE")

json_body() {
  python3 - "$@" <<'PY'
import json
import sys

args = sys.argv[1:]
if len(args) % 2 != 0:
    raise SystemExit("json_body 需要偶数个参数: key value ...")

body = {}
for i in range(0, len(args), 2):
    key = args[i]
    raw = args[i + 1]
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        value = raw
    body[key] = value

print(json.dumps(body, ensure_ascii=False))
PY
}

usage() {
  cat <<'EOF'
用法: mesh <command> [args]

节点管理:
  init [--session <id>] [id] [role] [desc]
                           注册当前 cc 节点（register 别名）
  register [--session <id>] [id] [role] [desc]
                           注册当前 cc 节点；探测到 unknown 会直接失败
  unregister                注销当前 cc 节点
  heartbeat                 发送心跳
  status                    查看在线节点

消息:
  send <to> <message> [--image <file>]  发送正文，可附最多 4 张图片（PNG/JPEG/WebP/GIF，原字节传输）
  inbox                     查看收件箱
  broadcast <message>       广播消息
  devices                   查看 Hub 同步过来的设备列表
  context [sessionId]       查看 session 级 mesh context 文件

任务:
  spawn --agent <profile> [--on <device>] [--window] [--dir <path>] [--lead <full-nodeId>]
                           创建新 agent 节点（只做喊名+两步握手；派活用 mesh send）
                           查详细: mesh spawn --help
  dispatch --to <node> --title <标题> [--project <p>] [--todo <uid>] <正文>
                           派单（type=task + meta 信封，正文原样投给席位；--todo 联结 cc-todo）
                           查详细: mesh dispatch --help

云端账本（读 Hub :19901 的 Ledger API）:
  quota [--account <fp>] [--history]     各账号最新额度快照
  agents                                 席位 × 在线状态 × 最近额度
  tasks [--status s] [--project p] [--todo uid]  任务台账（--todo 按 cc-todo uid 查归属）
  log [--to x] [--from x] [--type t] [--limit n]
                                         消息流水（--to @ledger 看探针入账）
  以上均支持 --json 出原始 JSON

黑板:
  kv get <key>              读取 KV
  kv set <key> <value>      写入 KV
  kv del <key>              删除 KV
  kv list                   列出所有 KV

Relay 管理:
  relay start               启动 relay 服务
  relay stop                停止 relay 服务
  relay restart             强制重启 relay 服务
  relay status              检查 relay 状态
  relay logs [--follow]     查看 relay 日志
  relay help                查看 relay 子命令帮助

Skill:
  skill install [--force]   安装 /cc-mesh skill 到 ~/.claude/skills/

环境变量:
  MESH_NODE        当前节点 ID（由 wrapper 设置）
  MESH_RELAY_URL   Relay 地址（默认 http://localhost:19800）
  MESH_HUB_URL     Hub 地址（可选；也可写入 ~/.ccmesh/hub-url；不设 = 纯本机模式）
  MESH_LEDGER_URL  云端账本读 API 地址（也可写入 ~/.ccmesh/ledger-url；默认 http://127.0.0.1:19901）
  MESH_HUB_TOKEN   账本 API 的 Bearer token（也可写入 ~/.ccmesh/hub-token）
EOF
}

# 图片类型只看魔数（不信扩展名）；白名单外返回非零。原字节上传，不转码。
image_mime() {
  python3 - "$1" <<'PY'
import sys
with open(sys.argv[1], "rb") as f:
    b = f.read(16)
if b.startswith(b"\x89PNG\r\n\x1a\n"): print("image/png")
elif b.startswith(b"\xff\xd8\xff"): print("image/jpeg")
elif b[:4] == b"RIFF" and b[8:12] == b"WEBP": print("image/webp")
elif b[:6] in (b"GIF87a", b"GIF89a"): print("image/gif")
else: sys.exit(1)
PY
}

cmd_send() {
  local to="${1:?用法: mesh send <to> <message>}"
  shift
  local -a message_parts=()
  local -a images=()
  local message_count=0
  local image_count=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --image)
        [[ -n "${2:-}" ]] || { echo "错误: --image 需要文件" >&2; exit 1; }
        images+=("$2")
        image_count=$((image_count + 1))
        shift 2
        ;;
      *)
        message_parts+=("$1")
        message_count=$((message_count + 1))
        shift
        ;;
    esac
  done
  (( message_count > 0 )) || { echo "错误: 缺少消息内容"; exit 1; }
  local msg="${message_parts[*]}"
  [[ -z "$msg" ]] && { echo "错误: 缺少消息内容"; exit 1; }
  if (( image_count > 4 )); then
    echo "错误: 每条消息最多 4 张图片" >&2
    exit 1
  fi
  local image
  local -a mimes=()
  if (( image_count > 0 )); then
    for image in "${images[@]}"; do
      [[ -f "$image" && -r "$image" ]] || { echo "错误: 图片文件不存在或不可读" >&2; exit 1; }
      local mime
      mime="$(image_mime "$image")" || { echo "错误: 只支持 PNG/JPEG/WebP/GIF 图片（按文件内容判断）" >&2; exit 1; }
      mimes+=("$mime")
    done
  fi

  local -a manifests=()
  local manifest_count=0
  local response manifest
  if (( image_count > 0 )); then
    local i
    for i in "${!images[@]}"; do
      image="${images[$i]}"
      if response=$("${CURL[@]}" -H "Content-Type: ${mimes[$i]}" -X POST "$RELAY/attachments" --data-binary "@$image" 2>/dev/null) \
        && manifest=$(printf '%s' "$response" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps(d["data"]["manifest"],separators=(",",":")))' 2>/dev/null); then
        manifests+=("$manifest")
        manifest_count=$((manifest_count + 1))
      else
        echo "attachment unavailable: 图片上传失败，正文仍会发送" >&2
      fi
    done
  fi

  local body
  if (( manifest_count == 0 )); then
    body=$(python3 - "$to" "$msg" <<'PY'
import json,sys
print(json.dumps({"to":sys.argv[1],"message":sys.argv[2]},ensure_ascii=False,separators=(",",":")))
PY
    )
  else
    body=$(python3 - "$to" "$msg" "${manifests[@]}" <<'PY'
import json,sys
doc={"to":sys.argv[1],"message":sys.argv[2]}
if len(sys.argv)>3:
    doc["attachments"]=[json.loads(x) for x in sys.argv[3:]]
print(json.dumps(doc,ensure_ascii=False,separators=(",",":")))
PY
    )
  fi
  "${CURL[@]}" "${H[@]}" -X POST "$RELAY/send" \
    -d "$body"
  echo
}

cmd_inbox() {
  local node_id="${1:-${NODE:-}}"
  [[ -z "$node_id" ]] && { echo "错误: 未设置 MESH_NODE，也未传入 nodeId"; exit 1; }
  "${CURL[@]}" "${H[@]}" "$RELAY/inbox?nodeId=$(printf '%s' "$node_id" | jq -sRr @uri)"
  echo
}

cmd_status() {
  "${CURL[@]}" "$RELAY/status" | python3 -m json.tool 2>/dev/null || "${CURL[@]}" "$RELAY/status"
  echo
}

cmd_devices() {
  "${CURL[@]}" "$RELAY/devices" | python3 -m json.tool 2>/dev/null || "${CURL[@]}" "$RELAY/devices"
  echo
}

cmd_context() {
  local session_id="${1:-}"
  if [[ -z "$session_id" ]]; then
    if [[ -n "${MESH_SESSION_ID:-}" ]]; then
      session_id="$MESH_SESSION_ID"
    elif [[ -n "${TMUX:-}" ]]; then
      session_id="$(tmux display-message -p '#{session_name}' 2>/dev/null || true)"
    elif [[ -n "${ITERM_SESSION_ID:-}" ]]; then
      session_id="${ITERM_SESSION_ID##*:}"
    fi
  fi
  [[ -n "$session_id" ]] || { echo "错误: 缺少 sessionId，且当前无法自动推断" >&2; exit 1; }
  local context_file="$HOME/.ccmesh/context/${session_id}.json"
  [[ -f "$context_file" ]] || { echo "错误: context 不存在: $context_file" >&2; exit 1; }
  cat "$context_file"
  echo
}

detect_session_id() {
  if [[ -n "${MESH_SESSION_ID:-}" ]]; then
    printf '%s\n' "$MESH_SESSION_ID"
    return 0
  fi
  if [[ -n "${TMUX:-}" ]]; then
    tmux display-message -p '#{session_name}' 2>/dev/null || printf 'unknown\n'
    return 0
  fi
  if [[ -n "${ITERM_SESSION_ID:-}" ]]; then
    printf '%s\n' "${ITERM_SESSION_ID##*:}"
    return 0
  fi
  printf 'unknown\n'
}

cmd_register() {
  local explicit_session=""
  local delivery_mode=""
  # 先剥离 flag（--session / --delivery 可出现在任意位置），剩下的是位置参数
  local positional=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --session)
        explicit_session="${2:-}"
        [[ -z "$explicit_session" ]] && { echo "错误: --session 需要一个 sessionId" >&2; exit 1; }
        shift 2
        ;;
      --delivery)
        delivery_mode="${2:-}"
        [[ -z "$delivery_mode" ]] && { echo "错误: --delivery 需要一个值 (inject/sse-pull/native-api)" >&2; exit 1; }
        shift 2
        ;;
      *)
        positional+=("$1")
        shift
        ;;
    esac
  done
  local short_id="${positional[0]:-cc-$(openssl rand -hex 2)}"
  local role="${positional[1]:-worker}"
  local desc="${positional[2]:-cc node}"
  local session_id="${explicit_session:-$(detect_session_id)}"

  # 非 inject 形态（sse-pull / native-api）：端点无 pane，sessionId 可缺省，
  # unknown 不再拒绝——交给 relay 生成 nopane-<nodeId> 占位（D1）。
  # inject（含缺省不声明）：仍要求真 sessionId，unknown 照旧拒绝（零回归）。
  local is_paneless=0
  if [[ "$delivery_mode" == "sse-pull" || "$delivery_mode" == "native-api" ]]; then
    is_paneless=1
  fi
  if [[ "$session_id" == "unknown" && "$is_paneless" -eq 0 ]]; then
    cat >&2 <<'EOF'
错误: 当前会话的 sessionId=unknown，拒绝注册。
请在目标 tmux/iTerm 交互会话里执行 mesh init/register，
或显式传入：mesh init --session <sessionId> ...
EOF
    exit 1
  fi
  local pid="$$"

  # 组 body：paneless + 无显式 session → 不传 sessionId（relay 生占位）；否则传探测值。
  local body
  if [[ "$is_paneless" -eq 1 && -z "$explicit_session" ]]; then
    body="$(json_body shortId "$short_id" pid "$pid" role "$role" description "$desc" deliveryMode "$delivery_mode")"
  elif [[ -n "$delivery_mode" ]]; then
    body="$(json_body shortId "$short_id" sessionId "$session_id" pid "$pid" role "$role" description "$desc" deliveryMode "$delivery_mode")"
  else
    body="$(json_body shortId "$short_id" sessionId "$session_id" pid "$pid" role "$role" description "$desc")"
  fi
  local response
  response=$("${CURL[@]}" "${H[@]}" -X POST "$RELAY/register" -d "$body")
  echo "$response"
  echo

  # 手动 init 场景：当前 shell 没设 MESH_NODE，printed nodeId 也无法从子进程导出到父 shell。
  # 主动提示用户 export，避免后续 mesh send/spawn/unregister/heartbeat 全链路失败。
  if [[ -z "${MESH_NODE:-}" ]]; then
    local new_node_id
    new_node_id=$(printf '%s' "$response" | python3 -c "import sys,json
try:
    d=json.load(sys.stdin)
    print(d.get('data',{}).get('nodeId',''))
except Exception:
    pass" 2>/dev/null)
    if [[ -n "$new_node_id" ]]; then
      cat >&2 <<EOF

提示: 当前 shell 没有 MESH_NODE 环境变量。
如果要继续用 mesh send / spawn / unregister / heartbeat，请执行：

    export MESH_NODE=$new_node_id

或者一次性：eval "export MESH_NODE=\$(curl -s --noproxy '*' \$MESH_RELAY_URL/api/status | jq -r '.data.nodes[] | select(.sessionId==\"$session_id\") | .identity.nodeId')"

（wrapper 启动的 cc 会自动设好，不需要这一步；手动 init 才需要。）
EOF
    fi
  fi
}

cmd_unregister() {
  [[ -z "$NODE" ]] && { echo "错误: 未设置 MESH_NODE"; exit 1; }
  "${CURL[@]}" "${H[@]}" -X DELETE "$RELAY/register/$(printf '%s' "$NODE" | jq -sRr @uri)"
  echo
}

cmd_heartbeat() {
  [[ -z "$NODE" ]] && { echo "错误: 未设置 MESH_NODE"; exit 1; }
  "${CURL[@]}" "${H[@]}" -X POST "$RELAY/heartbeat" \
    -d "$(json_body nodeId "$NODE")"
  echo
}

cmd_broadcast() {
  local msg="${*:?用法: mesh broadcast <message>}"
  "${CURL[@]}" "${H[@]}" -X POST "$RELAY/broadcast" \
    -d "$(json_body message "$msg")"
  echo
}

spawn_usage() {
  cat <<'EOF'
用法: mesh spawn --agent <profile> [选项]

选项:
  --agent <profile>    agent profile 名（tcc / tcx / tcodex；对应 ~/.ccmesh/agents/<name>.json）—— 必填
  --on <device>        远端设备名（deviceId，默认为对方 hostname 小写），不传则本地起
  --window             新建独立窗口（默认 tab）
  --dir <path>         worker 工作目录（默认读 profile 定义）
  --lead <full-nodeId> 显式指定 lead nodeId；不传则用当前 MESH_NODE
  --help / -h          查看本帮助

职责:
  spawn 只做「喊名 + 两步握手」，不接受 --task：
    1. 返回 worker nodeId + 启动 tmux/iTerm 会话
    2. wrapper 自动向 lead 发 [bootstrap][registered]
    3. agent 用 Bash 工具发 [bootstrap][ready]
  两条 bootstrap 信号经 REPL inject 自动进入你（主 cc）对话窗。

派活（dispatch）是独立的一步——看到 [bootstrap][ready] 之后：
  mesh send <worker-nodeId> "<任务文本>"

⚠️ 不要查 mesh inbox 等 ready——它是 push，看对话窗落字即可。
⚠️ 不要传 --task——CLI 硬拒，历史包袱已废弃。
EOF
}

cmd_spawn() {
  local mode="tab"
  local project_dir=""
  local target_device=""
  local agent=""
  local lead_node=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --help|-h) spawn_usage; exit 0 ;;
      --window) mode="window"; shift ;;
      --on) target_device="${2:-}"; shift 2 ;;
      --agent) agent="${2:-}"; shift 2 ;;
      --dir) project_dir="$2"; shift 2 ;;
      --lead) lead_node="${2:-}"; shift 2 ;;
      *) echo "错误: 未知参数 '$1'（spawn 不再接受 --task / 位置参数；派活请用 mesh send。查 'mesh spawn --help' 看选项）" >&2; exit 1 ;;
    esac
  done
  [[ -z "$agent" ]] && { echo "错误: 缺少 --agent <profile>"; exit 1; }
  if [[ -z "$lead_node" ]]; then
    lead_node="$NODE"
  fi
  [[ -n "$lead_node" ]] || {
    echo "错误: mesh spawn 需要完整 lead nodeId。请在已注册的主窗口内执行，或显式传 --lead <full-nodeId>" >&2
    exit 1
  }

  local body
  body=$(
    MESH_SPAWN_MODE="$mode" \
    MESH_SPAWN_TARGET_DEVICE="$target_device" \
    MESH_SPAWN_AGENT="$agent" \
    MESH_SPAWN_PROJECT_DIR="$project_dir" \
    MESH_SPAWN_DELEGATOR_NODE="$lead_node" \
    python3 - <<'PY'
import json
import os

body = {
    "mode": os.environ["MESH_SPAWN_MODE"],
    "agent": os.environ["MESH_SPAWN_AGENT"],
}

if os.environ["MESH_SPAWN_TARGET_DEVICE"]:
    body["targetDevice"] = os.environ["MESH_SPAWN_TARGET_DEVICE"]
if os.environ["MESH_SPAWN_PROJECT_DIR"]:
    body["projectDir"] = os.environ["MESH_SPAWN_PROJECT_DIR"]
if os.environ["MESH_SPAWN_DELEGATOR_NODE"]:
    body["delegatorNodeId"] = os.environ["MESH_SPAWN_DELEGATOR_NODE"]

print(json.dumps(body, ensure_ascii=False))
PY
  )

  "${CURL[@]}" "${H[@]}" -X POST "$RELAY/spawn" -d "$body"
  echo "提示: spawn 只做握手。收到 [bootstrap][ready] 后，用 mesh send <worker-nodeId> <task-text> 派活。" >&2
}

cmd_kv() {
  local subcmd="${1:?用法: mesh kv <get|set|del|list> [args]}"
  shift
  case "$subcmd" in
    get)
      local key="${1:?用法: mesh kv get <key>}"
      "${CURL[@]}" "$RELAY/kv/$key"
      echo
      ;;
    set)
      local key="${1:?用法: mesh kv set <key> <value>}"
      local value="${2:?用法: mesh kv set <key> <value>}"
      "${CURL[@]}" "${H[@]}" -X PUT "$RELAY/kv/$key" \
        -d "$(json_body value "$value" updatedBy "${NODE:-unknown}")"
      echo
      ;;
    del)
      local key="${1:?用法: mesh kv del <key>}"
      "${CURL[@]}" -X DELETE "$RELAY/kv/$key"
      echo
      ;;
    list)
      "${CURL[@]}" "$RELAY/kv" | python3 -m json.tool 2>/dev/null || "${CURL[@]}" "$RELAY/kv"
      echo
      ;;
    *)
      echo "未知 kv 子命令: $subcmd"
      exit 1
      ;;
  esac
}

cmd_relay() {
  local subcmd="${1:-help}"
  case "$subcmd" in
    start)
      if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        echo "[mesh] relay 已在运行 (PID: $(cat "$PID_FILE"))"
        return 0
      fi
      local live_pid=""
      live_pid="$(relay_port_pid)"
      if [[ -n "$live_pid" ]] && relay_http_ok; then
        mkdir -p "$(dirname "$PID_FILE")"
        printf '%s\n' "$live_pid" > "$PID_FILE"
        echo "[mesh] relay 已在运行 (PID: $live_pid, via port 19800)"
        return 0
      fi
      local rd
      rd="$(relay_dir)" || { echo "[mesh] relay 目录不存在" >&2; exit 1; }
      mkdir -p "$(dirname "$PID_FILE")"
      : > "$RELAY_LOG"
      if relay_session_exists; then
        tmux kill-session -t "$RELAY_SESSION" >/dev/null 2>&1 || true
      fi
      local hub
      hub="$(hub_url)"
      if command -v tmux >/dev/null 2>&1; then
        tmux new-session -d -s "$RELAY_SESSION" "cd '$rd' && MESH_HUB_URL='$hub' exec node dist/index.js >> '$RELAY_LOG' 2>&1"
      else
        cd "$rd"
        MESH_HUB_URL="$hub" nohup node dist/index.js >> "$RELAY_LOG" 2>&1 &
      fi
      sleep 1
      live_pid="$(relay_port_pid)"
      if [[ -n "$live_pid" ]]; then
        printf '%s\n' "$live_pid" > "$PID_FILE"
      fi
      if relay_wait_healthy 10; then
        live_pid="$(relay_port_pid)"
        if [[ -n "$live_pid" ]]; then
          printf '%s\n' "$live_pid" > "$PID_FILE"
        fi
        echo "[mesh] relay 已启动 (PID: ${live_pid:-unknown}, session: $RELAY_SESSION, dir: $rd)"
      else
        echo "[mesh] relay 启动失败" >&2
        [[ -f "$RELAY_LOG" ]] && tail -n 40 "$RELAY_LOG" >&2 || true
        exit 1
      fi
      ;;
    stop)
      if relay_session_exists; then
        tmux kill-session -t "$RELAY_SESSION" >/dev/null 2>&1 || true
        echo "[mesh] relay session 已停止 ($RELAY_SESSION)"
      fi
      if [[ -f "$PID_FILE" ]]; then
        local pid
        pid=$(cat "$PID_FILE")
        if kill -0 "$pid" 2>/dev/null; then
          kill "$pid"
          echo "[mesh] relay 已停止 (PID: $pid)"
        else
          echo "[mesh] relay 进程不存在，清理 PID 文件"
          rm -f "$PID_FILE"
        fi
      fi
      local live_pid=""
      live_pid="$(relay_port_pid)"
      if [[ -n "$live_pid" ]] && kill -0 "$live_pid" 2>/dev/null; then
        kill "$live_pid"
        echo "[mesh] relay 已停止 (PID: $live_pid, via port 19800)"
        rm -f "$PID_FILE"
      elif [[ ! -f "$PID_FILE" ]]; then
        echo "[mesh] relay 未运行（无 PID 文件，19800 也无监听）"
      fi
      ;;
    restart)
      cmd_relay stop
      cmd_relay start
      ;;
    status)
      if relay_http_ok; then
        local live_pid=""
        live_pid="$(relay_port_pid)"
        local session_state="missing"
        if relay_session_exists; then
          session_state="present"
        fi
        if [[ -n "$live_pid" ]]; then
          mkdir -p "$(dirname "$PID_FILE")"
          printf '%s\n' "$live_pid" > "$PID_FILE"
          echo "[mesh] relay 运行中 (PID: $live_pid, tmux: $session_state)"
        else
          echo "[mesh] relay 运行中 (tmux: $session_state)"
        fi
        "${CURL[@]}" "$RELAY/status" | python3 -m json.tool 2>/dev/null || "${CURL[@]}" "$RELAY/status"
      else
        local session_state="missing"
        if relay_session_exists; then
          session_state="present"
        fi
        local live_pid=""
        live_pid="$(relay_port_pid)"
        if [[ -n "$live_pid" ]]; then
          echo "[mesh] relay 端口被占用但 HTTP 不健康 (PID: $live_pid, tmux: $session_state)"
        else
          echo "[mesh] relay 未运行 (tmux: $session_state)"
        fi
      fi
      ;;
    logs)
      local follow="${2:-}"
      if [[ "$follow" == "--follow" || "$follow" == "-f" ]]; then
        touch "$RELAY_LOG"
        tail -f "$RELAY_LOG"
      elif relay_session_exists; then
        tmux capture-pane -pt "$RELAY_SESSION" -S -200
      elif [[ -f "$RELAY_LOG" ]]; then
        tail -n 200 "$RELAY_LOG"
      else
        echo "[mesh] relay 日志不存在: $RELAY_LOG"
      fi
      ;;
    help|-h|--help)
      relay_help
      ;;
    *)
      echo "未知 relay 子命令: $subcmd"
      relay_help
      exit 1
      ;;
  esac
}

cmd_skill() {
  local subcmd="${1:-help}"
  case "$subcmd" in
    install)
      local force=0
      [[ "${2:-}" == "--force" ]] && force=1
      # Use the versioned skill shipped with this release, or an explicit local override.
      local src="${MESH_SKILL_SRC:-$(resolve_script_dir)/../../skills/cc-mesh}"
      if [[ ! -f "$src/SKILL.md" ]]; then
        echo "错误: 未找到 skill 目录: $src" >&2
        exit 1
      fi
      local dest="$HOME/.claude/skills/cc-mesh"
      if [[ -e "$dest" && $force -eq 0 ]]; then
        echo "已存在: ${dest}（覆盖请用 mesh skill install --force）" >&2
        exit 1
      fi
      mkdir -p "$HOME/.claude/skills"
      rm -rf "$dest"
      cp -R "$src" "$dest"
      echo "[mesh] skill 已安装 → ${dest}（来源: ${src}）"
      ;;
    *)
      echo "用法: mesh skill install [--force]   # 安装 /cc-mesh skill 到 ~/.claude/skills/（来源: MESH_SKILL_SRC > 仓内 skills/cc-mesh）"
      ;;
  esac
}

# === 主入口 ===
cmd="${1:-help}"
shift || true

case "$cmd" in
  send)       cmd_send "$@" ;;
  devices)    cmd_devices ;;
  context)    cmd_context "$@" ;;
  inbox)      cmd_inbox "$@" ;;
  status)     cmd_status ;;
  init)       cmd_register "$@" ;;
  register)   cmd_register "$@" ;;
  unregister) cmd_unregister ;;
  heartbeat)  cmd_heartbeat ;;
  broadcast)  cmd_broadcast "$@" ;;
  spawn)      cmd_spawn "$@" ;;
  dispatch)   cmd_dispatch "$@" ;;
  quota)      cmd_quota "$@" ;;
  tasks)      cmd_tasks "$@" ;;
  agents)     cmd_agents "$@" ;;
  log)        cmd_log "$@" ;;
  kv)         cmd_kv "$@" ;;
  relay)      cmd_relay "$@" ;;
  skill)      cmd_skill "$@" ;;
  help|--help|-h) usage ;;
  *)
    echo "未知命令: $cmd"
    usage
    exit 1
    ;;
esac
