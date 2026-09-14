#!/usr/bin/env bash
# Generic cc-mesh agent wrapper: register node, run launcher command, unregister.

set -euo pipefail

ROLE="${1:-worker}"
DESC="${2:-mesh-worker}"
PROJECT_DIR="${3:-$HOME}"
LAUNCHER="${4:-${MESH_LAUNCHER:-cc}}"
SHORT_ID="${MESH_SHORT_ID:-cc-$(openssl rand -hex 2)}"
RELAY_URL="${MESH_RELAY_URL:-http://localhost:19800}"

launcher_cmd() {
  case "$LAUNCHER" in
    cc)
      printf '%s\n' "claude --dangerously-skip-permissions"
      ;;
    cc-fable)
      printf '%s\n' "claude --dangerously-skip-permissions --model 'claude-fable-5[1m]'"
      ;;
    code)
      printf '%s\n' "claude --dangerously-skip-permissions"
      ;;
    cx)
      printf '%s\n' "command codex --dangerously-bypass-approvals-and-sandbox"
      ;;
    codex)
      printf '%s\n' "command codex --dangerously-bypass-approvals-and-sandbox"
      ;;
    *)
      echo "unknown launcher: $LAUNCHER" >&2
      return 1
      ;;
  esac
}

current_session_id() {
  if [[ -n "${TMUX:-}" ]]; then
    tmux display-message -p '#{session_name}' 2>/dev/null || true
  elif [[ -n "${ITERM_SESSION_ID:-}" ]]; then
    local raw="$ITERM_SESSION_ID"
    printf '%s\n' "${raw##*:}"
  fi
}

SESSION_ID="${MESH_SESSION_ID:-$(current_session_id)}"
[[ -n "$SESSION_ID" ]] || SESSION_ID="unknown"
PID="$$"
NODE_ID=""
CONTEXT_DIR="$HOME/.ccmesh/context"
CONTEXT_FILE=""

write_context_file() {
  mkdir -p "$CONTEXT_DIR"
  CONTEXT_FILE="$CONTEXT_DIR/${SESSION_ID}.json"
  python3 - "$CONTEXT_FILE" "$NODE_ID" "$SESSION_ID" "${MESH_DELEGATOR_NODE:-}" "$PROJECT_DIR" "$LAUNCHER" "$ROLE" "$DESC" <<'PY'
import json
import sys
from pathlib import Path

(
    context_file,
    worker_node_id,
    session_id,
    lead_node_id,
    project_dir,
    launcher,
    role,
    description,
) = sys.argv[1:]

Path(context_file).write_text(
    json.dumps(
        {
            "worker_node_id": worker_node_id,
            "session_id": session_id,
            "lead_node_id": lead_node_id,
            "project_dir": project_dir,
            "launcher": launcher,
            "role": role,
            "description": description,
        },
        ensure_ascii=False,
        indent=2,
    )
    + "\n",
    encoding="utf-8",
)
PY
}

send_bootstrap_registered() {
  [[ -n "${MESH_DELEGATOR_NODE:-}" ]] || return 0
  python3 - "$NODE_ID" "$SESSION_ID" "$ROLE" "$MESH_DELEGATOR_NODE" <<'PY' | \
    curl --noproxy "*" -sf \
      -H "Content-Type: application/json" \
      -H "X-Mesh-Node: $NODE_ID" \
      -X POST "$RELAY_URL/api/send" \
      -d @- >/dev/null 2>&1 || return 1
import json
import sys

worker_node_id, session_id, role, lead_node_id = sys.argv[1:]
print(json.dumps({
    "to": lead_node_id,
    "message": f"[bootstrap][registered] worker={worker_node_id} session={session_id} role={role}",
}, ensure_ascii=False))
PY
}

# --- 死亡取证 ---------------------------------------------------------------
# 席位会静默死掉且不留线索（computer2 codex-main 45 分钟内死三次，零证据）。
# 退出时落一条取证记录：退出码 / 信号 / 进程链 / 系统资源 / pane 尾部（脱敏后有限行）。
# 取证是**旁路**：脚本不在、跑挂了、超时，一律不许影响 wrapper 本身（本文件 set -e）。
FORENSICS_SCRIPT="${MESH_FORENSICS_SCRIPT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/mesh-seat-forensics.sh}"
REAPER_PID=""
DEATH_SIGNAL=""
CLEANED=0

forensics() {
  [[ -f "$FORENSICS_SCRIPT" ]] || return 0
  bash "$FORENSICS_SCRIPT" "$@" >/dev/null 2>&1 || true
  return 0
}

cleanup() {
  local rc=$?
  # 用 if 而不是 `[[ ]] && x`：set -e 下裸 AND-list 的失败语义在不同 bash 版本上
  # 有争议，清理函数是最不能赌的地方。
  if [[ -n "${1:-}" ]]; then rc="$1"; fi
  if [[ "$CLEANED" == "1" ]]; then return 0; fi
  CLEANED=1
  # 先取证再注销：此刻 pane 还在、进程链还串得起来，注销完就什么都取不到了
  forensics death \
    --session "$SESSION_ID" --node-id "$NODE_ID" --short-id "$SHORT_ID" \
    --role "$ROLE" --launcher "$LAUNCHER" --desc "$DESC" --project-dir "$PROJECT_DIR" \
    --pid "$PID" --exit-code "$rc" ${DEATH_SIGNAL:+--signal "$DEATH_SIGNAL"} || true
  if [[ -n "$NODE_ID" ]]; then
    curl --noproxy "*" -sf -X DELETE "$RELAY_URL/api/register/$NODE_ID" >/dev/null 2>&1 || true
  fi
  if [[ -n "$CONTEXT_FILE" && -f "$CONTEXT_FILE" ]]; then
    rm -f "$CONTEXT_FILE" >/dev/null 2>&1 || true
  fi
  # trap 跑过了 → 守尸人没事干了（它自己也会认标退出，这里只是早点收）
  if [[ -n "$REAPER_PID" ]]; then kill "$REAPER_PID" >/dev/null 2>&1 || true; fi
  return 0
}

# 为什么要显式 trap HUP：`tmux kill-session` / `tmux kill-server` / tmux server 崩，
# 给 pane 进程组发的都是 **SIGHUP**。bash 对没 trap 的致命信号是直接被内核干掉，
# **EXIT trap 不会跑** → 不注销 → relay 里留一条僵尸注册记录。
# 这正是 computer2 三次死亡观察到的形态（会话没了、进程没了、注册还在）。
trap 'DEATH_SIGNAL=HUP;  cleanup 129; exit 129' HUP
trap 'DEATH_SIGNAL=INT;  cleanup 130; exit 130' INT
trap 'DEATH_SIGNAL=QUIT; cleanup 131; exit 131' QUIT
trap 'DEATH_SIGNAL=TERM; cleanup 143; exit 143' TERM
trap cleanup EXIT

register_output="$(
  curl --noproxy "*" -sf \
    -H "Content-Type: application/json" \
    -X POST "$RELAY_URL/api/register" \
    -d "$(printf '{"shortId":"%s","sessionId":"%s","pid":%d,"role":"%s","description":"%s"}' \
      "$SHORT_ID" "$SESSION_ID" "$PID" "$ROLE" "$DESC")"
)"
NODE_ID="$(printf '%s' "$register_output" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["nodeId"])' 2>/dev/null || true)"

export MESH_ID="$SHORT_ID"
export MESH_NODE="$NODE_ID"
export MESH_SESSION_NAME="$SESSION_ID"
export MESH_LAUNCHER="$LAUNCHER"
export MESH_DELEGATOR_NODE="${MESH_DELEGATOR_NODE:-}"
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

write_context_file
export MESH_CONTEXT_FILE="$CONTEXT_FILE"

echo "[mesh] 已注册节点: $NODE_ID (launcher=$LAUNCHER, role=$ROLE, session=$SESSION_ID)"
echo "[mesh] 环境已就绪: MESH_NODE=$MESH_NODE"
echo "[mesh] 内部短 ID: $SHORT_ID"
if [[ -n "$MESH_DELEGATOR_NODE" ]]; then
  echo "[mesh] delegator 已注入: MESH_DELEGATOR_NODE=$MESH_DELEGATOR_NODE"
fi
echo "[mesh] context 已写入: $CONTEXT_FILE"

# 出生留档 + 起守尸人。
# 守尸人存在的理由：SIGKILL / tmux kill-server 这类死法 **trap 根本不会跑**，
# 上面那套 trap 一个字都写不出来。守尸人被 nohup 起（忽略 SIGHUP）、disown 掉，
# pane 没了它还活着，盯到 wrapper pid 消失且没有 trap 的落档标记 → 补一条
# death_kind=untrapped。有 birth 无 death = 被 SIGKILL 了，这本身就是最强的线索。
forensics birth \
  --session "$SESSION_ID" --node-id "$NODE_ID" --short-id "$SHORT_ID" \
  --role "$ROLE" --launcher "$LAUNCHER" --desc "$DESC" --project-dir "$PROJECT_DIR" \
  --pid "$PID" || true
if [[ -f "$FORENSICS_SCRIPT" && "${MESH_FORENSICS:-1}" != "0" ]]; then
  nohup bash "$FORENSICS_SCRIPT" reap \
    --session "$SESSION_ID" --node-id "$NODE_ID" --short-id "$SHORT_ID" \
    --role "$ROLE" --launcher "$LAUNCHER" --project-dir "$PROJECT_DIR" \
    --pid "$PID" >/dev/null 2>&1 &
  REAPER_PID=$!
  disown "$REAPER_PID" 2>/dev/null || true
  echo "[mesh] 死亡取证已挂载: $FORENSICS_SCRIPT (reaper pid=$REAPER_PID)"
fi
if send_bootstrap_registered; then
  echo "[mesh] bootstrap registered 已自动发送"
else
  echo "[mesh] bootstrap registered 自动发送失败，后续将由 prompt 补发" >&2
fi

cd "$PROJECT_DIR"
bash -lc "$(launcher_cmd)"
