#!/usr/bin/env bash
# mesh.sh register 在 tmux 下的集成测试
# TDD: 预期当前 mesh.sh register 在 tmux 下 sessionId 为 "unknown"
#       后续改代码让它识别 tmux session name
#
# 依赖: tmux, curl, jq
# 用法: bash packages/cli/mesh-register-tmux.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MESH_SH="$SCRIPT_DIR/mesh.sh"
RELAY_PORT="${MESH_RELAY_PORT:-19800}"
RELAY_URL="http://localhost:$RELAY_PORT"
TMUX_SESSION="mesh-test-reg-$$"
CURL=(curl --noproxy "*" -sf)

# ===== 颜色 =====
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass=0
fail=0
skip=0

ok()   { pass=$((pass+1)); echo -e "${GREEN}✓${NC} $1"; }
fail() { fail=$((fail+1)); echo -e "${RED}✗${NC} $1"; }
skip() { skip=$((skip+1)); echo -e "${YELLOW}⊘${NC} $1 (skipped)"; }

wait_status_for_short_id() {
  local short_id="$1"
  local waited=0
  local status_json="{}"
  while [[ $waited -lt 30 ]]; do
    status_json=$("${CURL[@]}" "$RELAY_URL/api/status" 2>/dev/null || echo '{}')
    if echo "$status_json" | jq -e ".data.nodes[] | select(.identity.shortId == \"$short_id\")" >/dev/null 2>&1; then
      printf '%s\n' "$status_json"
      return 0
    fi
    sleep 0.1
    waited=$((waited+1))
  done
  printf '%s\n' "$status_json"
  return 1
}

# ===== 前置检查 =====

if ! command -v tmux &>/dev/null; then
  echo "tmux not found, skipping all tests"
  exit 0
fi

if ! command -v jq &>/dev/null; then
  echo "jq not found, skipping all tests"
  exit 0
fi

# 检查 relay 是否在跑
relay_alive=false
if "${CURL[@]}" "$RELAY_URL/api/status" &>/dev/null; then
  relay_alive=true
fi

cleanup() {
  tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
  tmux kill-session -t "mesh-test-multi-$$" 2>/dev/null || true
}
trap cleanup EXIT

echo "=== mesh.sh register tmux integration tests ==="
echo "relay: $RELAY_URL (alive=$relay_alive)"
echo ""

# ===== Test 1: tmux 下 register 的 sessionId 不应为 "unknown" =====

if [[ "$relay_alive" != "true" ]]; then
  skip "T1: register in tmux session — relay not running"
else
  # 创建 tmux session
  tmux new-session -d -s "$TMUX_SESSION" -x 120 -y 40

  # 在 tmux 里执行 register
  SHORT_ID="test-tmux-$(openssl rand -hex 2)"
  tmux send-keys -t "$TMUX_SESSION" \
    "MESH_RELAY_URL=$RELAY_URL bash $MESH_SH register $SHORT_ID && echo __REG_DONE__" Enter

  # 等待注册完成（最多 5 秒）
  waited=0
  reg_done=false
  while [[ $waited -lt 50 ]]; do
    pane_output=$(tmux capture-pane -t "$TMUX_SESSION" -p 2>/dev/null || true)
    # 需要匹配 2 次：一次是 echo 命令本身，一次是输出
    count=$(echo "$pane_output" | grep -c "__REG_DONE__" || true)
    if [[ "$count" -ge 2 ]]; then
      reg_done=true
      break
    fi
    sleep 0.1
    waited=$((waited+1))
  done

  if [[ "$reg_done" != "true" ]]; then
    fail "T1: register in tmux — timed out waiting for register to complete"
  else
    # 查 /api/status 找到注册的节点
    status_json=$(wait_status_for_short_id "$SHORT_ID" || true)
    registered_session=$(echo "$status_json" | jq -r \
      ".data.nodes[] | select(.identity.shortId == \"$SHORT_ID\") | .sessionId" 2>/dev/null || echo "")

    if [[ -z "$registered_session" ]]; then
      fail "T1: register in tmux — node not found in /api/status"
    elif [[ "$registered_session" == "unknown" ]]; then
      # TDD: 预期当前实现会失败——tmux 下 ITERM_SESSION_ID 不存在，回退到 "unknown"
      fail "T1: register in tmux — sessionId is 'unknown' (expected: '$TMUX_SESSION')"
      echo -e "  ${YELLOW}→ TDD: mesh.sh 需要检测 tmux 环境并用 tmux session name 作为 sessionId${NC}"
    elif [[ "$registered_session" == "$TMUX_SESSION" ]]; then
      ok "T1: register in tmux — sessionId matches tmux session name '$TMUX_SESSION'"
    else
      fail "T1: register in tmux — sessionId='$registered_session', expected='$TMUX_SESSION'"
    fi

    # 清理注册的节点
    node_id=$(echo "$status_json" | jq -r \
      ".data.nodes[] | select(.identity.shortId == \"$SHORT_ID\") | .identity.nodeId" 2>/dev/null || echo "")
    if [[ -n "$node_id" ]]; then
      "${CURL[@]}" -X DELETE "$RELAY_URL/api/register/$(python3 -c "import urllib.parse; print(urllib.parse.quote('$node_id'))")" &>/dev/null || true
    fi
  fi

  tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
fi

# ===== Test 2: 非 tmux 非 iTerm 下 register 应直接失败 =====

if [[ "$relay_alive" != "true" ]]; then
  skip "T2: register outside tmux/iTerm — relay not running"
else
  SHORT_ID2="test-bare-$(openssl rand -hex 2)"
  # 直接在当前 shell 跑（unset iTerm 和 tmux 环境变量）
  err_file="$(mktemp)"
  set +e
  ITERM_SESSION_ID="" TMUX="" TMUX_PANE="" MESH_RELAY_URL="$RELAY_URL" bash "$MESH_SH" register "$SHORT_ID2" > /dev/null 2>"$err_file"
  reg_code=$?
  set -e

  status_json2=$("${CURL[@]}" "$RELAY_URL/api/status" 2>/dev/null || echo '{}')
  bare_session=$(echo "$status_json2" | jq -r \
    ".data.nodes[] | select(.identity.shortId == \"$SHORT_ID2\") | .sessionId" 2>/dev/null || echo "")

  if [[ "$reg_code" -ne 0 ]] && grep -q "sessionId=unknown" "$err_file" && [[ -z "$bare_session" ]]; then
    ok "T2: register outside tmux/iTerm — rejects unknown session and does not create node"
  else
    fail "T2: register outside tmux/iTerm — expected hard failure without registration"
  fi

  rm -f "$err_file"
fi

# ===== Test 3: tmux session name 含特殊字符 =====

if [[ "$relay_alive" != "true" ]]; then
  skip "T3: register in tmux with special session name — relay not running"
else
  SPECIAL_SESSION="mesh-test-multi-$$"
  tmux new-session -d -s "$SPECIAL_SESSION" -x 120 -y 40

  SHORT_ID3="test-special-$(openssl rand -hex 2)"
  tmux send-keys -t "$SPECIAL_SESSION" \
    "MESH_RELAY_URL=$RELAY_URL bash $MESH_SH register $SHORT_ID3 && echo __REG_DONE__" Enter

  waited=0
  reg_done3=false
  while [[ $waited -lt 50 ]]; do
    pane_output=$(tmux capture-pane -t "$SPECIAL_SESSION" -p 2>/dev/null || true)
    count3=$(echo "$pane_output" | grep -c "__REG_DONE__" || true)
    if [[ "$count3" -ge 2 ]]; then
      reg_done3=true
      break
    fi
    sleep 0.1
    waited=$((waited+1))
  done

  if [[ "$reg_done3" != "true" ]]; then
    fail "T3: register in tmux with session '$SPECIAL_SESSION' — timed out"
  else
    status_json3=$(wait_status_for_short_id "$SHORT_ID3" || true)
    special_session_id=$(echo "$status_json3" | jq -r \
      ".data.nodes[] | select(.identity.shortId == \"$SHORT_ID3\") | .sessionId" 2>/dev/null || echo "")

    if [[ "$special_session_id" == "$SPECIAL_SESSION" ]]; then
      ok "T3: register in tmux — sessionId matches special session name '$SPECIAL_SESSION'"
    elif [[ "$special_session_id" == "unknown" ]]; then
      fail "T3: register in tmux with special name — sessionId is 'unknown' (expected: '$SPECIAL_SESSION')"
      echo -e "  ${YELLOW}→ TDD: same root cause as T1${NC}"
    else
      fail "T3: register in tmux — sessionId='$special_session_id', expected='$SPECIAL_SESSION'"
    fi

    # 清理
    node_id3=$(echo "$status_json3" | jq -r \
      ".data.nodes[] | select(.identity.shortId == \"$SHORT_ID3\") | .identity.nodeId" 2>/dev/null || echo "")
    if [[ -n "$node_id3" ]]; then
      "${CURL[@]}" -X DELETE "$RELAY_URL/api/register/$(python3 -c "import urllib.parse; print(urllib.parse.quote('$node_id3'))")" &>/dev/null || true
    fi
  fi

  tmux kill-session -t "$SPECIAL_SESSION" 2>/dev/null || true
fi

# ===== 总结 =====
echo ""
echo "=== Results: ${GREEN}$pass passed${NC}, ${RED}$fail failed${NC}, ${YELLOW}$skip skipped${NC} ==="

[[ $fail -gt 0 ]] && exit 1
exit 0
