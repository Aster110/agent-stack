#!/usr/bin/env bash
# Regression: mesh spawn forwards --on/--agent to relay JSON (no --task anymore).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MESH_SH="$SCRIPT_DIR/mesh.sh"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

cat > "$TMP_DIR/curl" <<'EOF'
#!/usr/bin/env bash
for ((i = 1; i <= $#; i++)); do
  if [[ "${!i}" == "-d" ]]; then
    j=$((i + 1))
    printf '%s\n' "${!j}" > "$MESH_TEST_BODY"
  fi
done
printf '{"ok":true,"data":{"nodeId":"test:cc-launch","shortId":"cc-launch","sessionId":"test-session","registered":false,"promptReady":false,"bootstrapDelivered":false}}\n'
EOF
chmod +x "$TMP_DIR/curl"

BODY_FILE="$TMP_DIR/body.json"
PATH="$TMP_DIR:$PATH" \
MESH_TEST_BODY="$BODY_FILE" \
MESH_RELAY_URL="http://relay.test" \
MESH_NODE="macbook:lead" \
bash "$MESH_SH" spawn --on computer2 --agent tcx --dir /tmp/launcher-cwd

python3 - "$BODY_FILE" <<'PY'
import json
import sys

body = json.load(open(sys.argv[1]))
assert "task" not in body, f"task should not be in body anymore: {body}"
assert body["agent"] == "tcx", body
assert body["targetDevice"] == "computer2", body
assert body["delegatorNodeId"] == "macbook:lead", body
assert body["projectDir"] == "/tmp/launcher-cwd", body
assert body["mode"] == "tab", body
PY

echo "✓ mesh spawn forwards --on/--agent (no --task field)"

if PATH="$TMP_DIR:$PATH" \
MESH_TEST_BODY="$BODY_FILE" \
MESH_RELAY_URL="http://relay.test" \
MESH_NODE="macbook:lead" \
bash "$MESH_SH" spawn --agent tcx --task "legacy task" >/tmp/mesh-spawn-task-deprecated.out 2>/tmp/mesh-spawn-task-deprecated.err; then
  echo "✗ mesh spawn --task should be rejected"
  exit 1
fi

grep -q "未知参数 '--task'" /tmp/mesh-spawn-task-deprecated.err
echo "✓ mesh spawn rejects legacy --task flag"

if PATH="$TMP_DIR:$PATH" \
MESH_TEST_BODY="$BODY_FILE" \
MESH_RELAY_URL="http://relay.test" \
bash "$MESH_SH" spawn --agent tcx >/tmp/mesh-spawn-no-lead.out 2>/tmp/mesh-spawn-no-lead.err; then
  echo "✗ mesh spawn should fail fast without lead node"
  exit 1
fi

grep -q "mesh spawn 需要完整 lead nodeId" /tmp/mesh-spawn-no-lead.err
echo "✓ mesh spawn fails fast without lead node"

PATH="$TMP_DIR:$PATH" \
MESH_TEST_BODY="$BODY_FILE" \
MESH_RELAY_URL="http://relay.test" \
bash "$MESH_SH" spawn --lead macbook:explicit --agent tcx

python3 - "$BODY_FILE" <<'PY'
import json
import sys

body = json.load(open(sys.argv[1]))
assert body["delegatorNodeId"] == "macbook:explicit", body
assert "task" not in body, f"task should not be in body: {body}"
PY

echo "✓ mesh spawn accepts explicit --lead"
