#!/usr/bin/env bash
# start-relay.sh integration tests.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${MESH_TEST_RELAY_PORT:-19802}"
SESSION="cc-mesh-relay-test-$$"
LOG="/tmp/mesh-relay-test-$$.log"

cleanup() {
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  old_pid=$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
  [[ -n "$old_pid" ]] && kill $old_pid 2>/dev/null || true
  rm -f "$LOG"
}
trap cleanup EXIT

status() {
  curl --noproxy "*" -sf "http://localhost:$PORT/api/status"
}

pid_for_port() {
  lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -n 1
}

cleanup

echo "=== start-relay tmux supervision test ==="

MESH_RELAY_SESSION="$SESSION" \
MESH_RELAY_LOG="$LOG" \
RELAY_HTTP_PORT="$PORT" \
MESH_DEVICE_ID="relay-test" \
MESH_HUB_URL="" \
bash "$ROOT/scripts/start-relay.sh" --force

sleep 8
status | python3 -m json.tool
tmux has-session -t "$SESSION"
pid1="$(pid_for_port)"
[[ -n "$pid1" ]] || { echo "relay pid missing after first start" >&2; exit 1; }

echo "first pid: $pid1"

MESH_RELAY_SESSION="$SESSION" \
MESH_RELAY_LOG="$LOG" \
RELAY_HTTP_PORT="$PORT" \
MESH_DEVICE_ID="relay-test" \
MESH_HUB_URL="" \
bash "$ROOT/scripts/start-relay.sh" --force

sleep 3
status | python3 -m json.tool
tmux has-session -t "$SESSION"
pid2="$(pid_for_port)"
[[ -n "$pid2" ]] || { echo "relay pid missing after force restart" >&2; exit 1; }
[[ "$pid1" != "$pid2" ]] || { echo "force restart did not replace relay pid" >&2; exit 1; }

count="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | wc -l | tr -d ' ')"
[[ "$count" == "1" ]] || { echo "expected one listener on $PORT, got $count" >&2; exit 1; }

echo "second pid: $pid2"
echo "✓ start-relay tmux supervision works"
