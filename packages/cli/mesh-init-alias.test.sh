#!/usr/bin/env bash
# Regression: mesh init is an alias for mesh register.
#
# 环境隔离(2026-08-27 补)：三段都必须 env -u 掉 TMUX / ITERM_SESSION_ID / MESH_SESSION_ID。
# 否则 detect_session_id 会摸到跑测者自己的真会话——段1 拿到的不是 SESSION-UUID，
# 段2 的"unknown 应被拒绝"直接不成立。在 tmux 里跑（agent 的常态）必红，跟被测代码无关。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MESH_SH="$SCRIPT_DIR/mesh.sh"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

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

env -u TMUX -u MESH_SESSION_ID \
PATH="$TMP_DIR:$PATH" \
MESH_TEST_ARGS="$ARGS_FILE" \
MESH_TEST_BODY="$BODY_FILE" \
MESH_RELAY_URL="http://relay.test" \
ITERM_SESSION_ID="w0t1p0:SESSION-UUID" \
bash "$MESH_SH" init self main "current node"

python3 - "$ARGS_FILE" "$BODY_FILE" <<'PY'
import json
import sys

args = open(sys.argv[1]).read()
body = json.load(open(sys.argv[2]))

assert "http://relay.test/api/register" in args, args
assert body["shortId"] == "self", body
assert body["sessionId"] == "SESSION-UUID", body
assert body["role"] == "main", body
assert body["description"] == "current node", body
PY

echo "✓ mesh init aliases register"

# 段1 已经写过 BODY_FILE，清掉再测"拒绝时不发请求"，否则下面的空断言必红（2026-08-27 修）
: > "$BODY_FILE"
set +e
env -u TMUX -u ITERM_SESSION_ID -u MESH_SESSION_ID \
PATH="$TMP_DIR:$PATH" \
MESH_TEST_ARGS="$ARGS_FILE" \
MESH_TEST_BODY="$BODY_FILE" \
MESH_RELAY_URL="http://relay.test" \
bash "$MESH_SH" init background worker "background shell" >"$TMP_DIR/unknown.out" 2>"$TMP_DIR/unknown.err"
STATUS=$?
set -e

test "$STATUS" -ne 0
! test -f "$BODY_FILE" || [[ ! -s "$BODY_FILE" ]]
grep -q "sessionId=unknown" "$TMP_DIR/unknown.err"
grep -q -- "--session" "$TMP_DIR/unknown.err"

echo "✓ mesh init rejects unknown session without explicit override"

env -u TMUX -u ITERM_SESSION_ID -u MESH_SESSION_ID \
PATH="$TMP_DIR:$PATH" \
MESH_TEST_ARGS="$ARGS_FILE" \
MESH_TEST_BODY="$BODY_FILE" \
MESH_RELAY_URL="http://relay.test" \
bash "$MESH_SH" init --session explicit-session self main "explicit current node"

python3 - "$BODY_FILE" <<'PY'
import json
import sys

body = json.load(open(sys.argv[1]))
assert body["shortId"] == "self", body
assert body["sessionId"] == "explicit-session", body
assert body["role"] == "main", body
assert body["description"] == "explicit current node", body
PY

echo "✓ mesh init accepts explicit --session override"
