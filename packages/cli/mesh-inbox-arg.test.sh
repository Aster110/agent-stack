#!/usr/bin/env bash
# cmd_inbox: 传入的 nodeId 参数应优先于 MESH_NODE env。
# 修 ${NODE:-${1:-}}（env 优先，反直觉）→ ${1:-${NODE:-}}（传参优先，env 兜底）。
# 老 bug：export MESH_NODE=A 后 `mesh inbox B` 会查 A 的箱子（dogfood 抓到）。
# 注意：inbox 请求仍带 X-Mesh-Node: $MESH_NODE header（请求者身份），
#       但 URL 的 nodeId（查谁的箱子）必须是传参值——断言只看 URL nodeId。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MESH_SH="$SCRIPT_DIR/mesh.sh"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# fake curl：把全部 args（含 URL）写文件，返回固定空箱
cat > "$TMP_DIR/curl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" > "$MESH_TEST_ARGS"
printf '{"ok":true,"data":{"messages":[]}}\n'
EOF
chmod +x "$TMP_DIR/curl"
ARGS_FILE="$TMP_DIR/args.txt"

# ===== 段1：传 nodeId 参数 + MESH_NODE 设成别的 → URL nodeId 应是传参值 =====
env PATH="$TMP_DIR:$PATH" MESH_TEST_ARGS="$ARGS_FILE" \
  MESH_RELAY_URL="http://relay.test" MESH_NODE="dev:cc-env" \
  bash "$MESH_SH" inbox "dev:cc-arg" >/dev/null
grep -q "nodeId=dev%3Acc-arg" "$ARGS_FILE" || { echo "FAIL 段1: URL nodeId 非传参 args=$(cat "$ARGS_FILE")"; exit 1; }
grep -q "nodeId=dev%3Acc-env" "$ARGS_FILE" && { echo "FAIL 段1: URL nodeId 用了 env 而非传参 args=$(cat "$ARGS_FILE")"; exit 1; }
echo "✓ 段1: inbox 传 nodeId 优先于 MESH_NODE env（URL nodeId=传参）"

# ===== 段2：不传参数 → 用 MESH_NODE 兜底（不破原行为） =====
: > "$ARGS_FILE"
env PATH="$TMP_DIR:$PATH" MESH_TEST_ARGS="$ARGS_FILE" \
  MESH_RELAY_URL="http://relay.test" MESH_NODE="dev:cc-env" \
  bash "$MESH_SH" inbox >/dev/null
grep -q "nodeId=dev%3Acc-env" "$ARGS_FILE" || { echo "FAIL 段2: 不传参未用 MESH_NODE args=$(cat "$ARGS_FILE")"; exit 1; }
echo "✓ 段2: inbox 不传参用 MESH_NODE 兜底"

# ===== 段3：既不传参也无 MESH_NODE → 报错退出（不静默查空） =====
set +e
env -u MESH_NODE PATH="$TMP_DIR:$PATH" MESH_TEST_ARGS="$ARGS_FILE" \
  MESH_RELAY_URL="http://relay.test" \
  bash "$MESH_SH" inbox >/dev/null 2>"$TMP_DIR/e3.err"
STATUS=$?
set -e
test "$STATUS" -ne 0 || { echo "FAIL 段3: 应非零退出"; exit 1; }
echo "✓ 段3: 无参无 env → 报错退出(exit $STATUS)"

echo "ALL PASS: mesh-inbox-arg"
