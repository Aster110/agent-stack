#!/usr/bin/env bash
# D2: mesh register --delivery sse-pull 放开 unknown-session 校验，body 带 deliveryMode。
# 对照组：不带 --delivery / --delivery inject 仍保留 unknown → exit 1（零回归）。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MESH_SH="$SCRIPT_DIR/mesh.sh"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# fake curl：捕获 args 和 -d body，返回固定 ok 响应
cat > "$TMP_DIR/curl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" > "$MESH_TEST_ARGS"
for ((i = 1; i <= $#; i++)); do
  if [[ "${!i}" == "-d" ]]; then
    j=$((i + 1))
    printf '%s\n' "${!j}" > "$MESH_TEST_BODY"
  fi
done
printf '{"ok":true,"data":{"nodeId":"test:self"}}\n'
EOF
chmod +x "$TMP_DIR/curl"

ARGS_FILE="$TMP_DIR/args.txt"
BODY_FILE="$TMP_DIR/body.json"

# ===== 段1：--delivery sse-pull 在 unknown session 下放行 + body 带 deliveryMode =====
rm -f "$BODY_FILE"
env -u TMUX -u TMUX_PANE -u ITERM_SESSION_ID -u MESH_SESSION_ID \
  PATH="$TMP_DIR:$PATH" \
  MESH_TEST_ARGS="$ARGS_FILE" \
  MESH_TEST_BODY="$BODY_FILE" \
  MESH_RELAY_URL="http://relay.test" \
  bash "$MESH_SH" register --delivery sse-pull foo worker desc

python3 - "$ARGS_FILE" "$BODY_FILE" <<'PY'
import json, sys
args = open(sys.argv[1]).read()
body = json.load(open(sys.argv[2]))
assert "http://relay.test/api/register" in args, args
assert body["shortId"] == "foo", body
assert body["role"] == "worker", body
assert body["deliveryMode"] == "sse-pull", body
# sessionId 不应是 unknown：缺省占位 nopane- 或省略
assert body.get("sessionId") != "unknown", body
PY
echo "✓ 段1: --delivery sse-pull 放行 unknown + body.deliveryMode=sse-pull"

# ===== 段2：对照组 — 不带 --delivery 仍 exit 1（unknown 拒绝） =====
rm -f "$BODY_FILE"
set +e
env -u TMUX -u TMUX_PANE -u ITERM_SESSION_ID -u MESH_SESSION_ID \
  PATH="$TMP_DIR:$PATH" \
  MESH_TEST_ARGS="$ARGS_FILE" \
  MESH_TEST_BODY="$BODY_FILE" \
  MESH_RELAY_URL="http://relay.test" \
  bash "$MESH_SH" register foo >"$TMP_DIR/c1.out" 2>"$TMP_DIR/c1.err"
STATUS=$?
set -e
test "$STATUS" -ne 0
grep -q "sessionId=unknown" "$TMP_DIR/c1.err"
( [[ ! -f "$BODY_FILE" ]] || [[ ! -s "$BODY_FILE" ]] )
echo "✓ 段2a: 不带 --delivery 仍拒绝 unknown (exit $STATUS)"

# --delivery inject 也仍拒绝
rm -f "$BODY_FILE"
set +e
env -u TMUX -u TMUX_PANE -u ITERM_SESSION_ID -u MESH_SESSION_ID \
  PATH="$TMP_DIR:$PATH" \
  MESH_TEST_ARGS="$ARGS_FILE" \
  MESH_TEST_BODY="$BODY_FILE" \
  MESH_RELAY_URL="http://relay.test" \
  bash "$MESH_SH" register --delivery inject foo >"$TMP_DIR/c2.out" 2>"$TMP_DIR/c2.err"
STATUS=$?
set -e
test "$STATUS" -ne 0
grep -q "sessionId=unknown" "$TMP_DIR/c2.err"
echo "✓ 段2b: --delivery inject 仍拒绝 unknown (exit $STATUS)"

# ===== 段3：--delivery 任意位置都被解析，不被当 shortId =====
rm -f "$BODY_FILE"
env -u TMUX -u TMUX_PANE -u ITERM_SESSION_ID -u MESH_SESSION_ID \
  PATH="$TMP_DIR:$PATH" \
  MESH_TEST_ARGS="$ARGS_FILE" \
  MESH_TEST_BODY="$BODY_FILE" \
  MESH_RELAY_URL="http://relay.test" \
  bash "$MESH_SH" register --session server --delivery sse-pull foo worker d

python3 - "$BODY_FILE" <<'PY'
import json, sys
body = json.load(open(sys.argv[1]))
assert body["shortId"] == "foo", ("shortId 被串位", body)
assert body["role"] == "worker", body
assert body["deliveryMode"] == "sse-pull", body
assert body["sessionId"] == "server", body
PY
echo "✓ 段3: --session + --delivery 混用，shortId/role/deliveryMode 解析正确"

echo "ALL PASS: mesh-delivery-flag"
