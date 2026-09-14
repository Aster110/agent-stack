#!/usr/bin/env bash
# Regression: mesh devices queries relay /api/devices.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MESH_SH="$SCRIPT_DIR/mesh.sh"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

cat > "$TMP_DIR/curl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" > "$MESH_TEST_ARGS"
printf '{"ok":true,"data":{"source":"hub","devices":[{"deviceId":"computer2","relayId":"computer2-123","nodes":[],"updatedAt":"2026-04-22T00:00:00.000Z"}]}}\n'
EOF
chmod +x "$TMP_DIR/curl"

ARGS_FILE="$TMP_DIR/args.txt"

PATH="$TMP_DIR:$PATH" \
MESH_TEST_ARGS="$ARGS_FILE" \
MESH_RELAY_URL="http://relay.test" \
bash "$MESH_SH" devices >/dev/null

python3 - "$ARGS_FILE" <<'PY'
import sys
args = open(sys.argv[1]).read()
assert "http://relay.test/api/devices" in args, args
PY

echo "✓ mesh devices queries /api/devices"
