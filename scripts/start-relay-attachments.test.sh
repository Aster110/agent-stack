#!/usr/bin/env bash
# Full runtime seam: start-relay.sh -> relay index -> token/url files -> POST /api/attachments.
# Every mutable/runtime resource is isolated from the production relay.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REAL_TMUX="$(command -v tmux)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ccmesh-attachment-runtime.XXXXXX")"
TEST_HOME="$TMP_ROOT/home"
TEST_BIN="$TMP_ROOT/bin"
SESSION="cc-mesh-attachment-test-$$"
TMUX_SOCKET="cc-mesh-attachment-test-$$"
RELAY_LOG="$TMP_ROOT/relay.log"
HUB_LOG="$TMP_ROOT/hub.log"
TOKEN="runtime-file-token-$RANDOM-$$"

free_port() {
  node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
}

RELAY_PORT="$(free_port)"
HUB_HTTP_PORT="$(free_port)"
HUB_WS_PORT="$(free_port)"
HUB_PID=""

cleanup() {
  "$REAL_TMUX" -L "$TMUX_SOCKET" kill-server 2>/dev/null || true
  if [[ -n "$HUB_PID" ]]; then kill "$HUB_PID" 2>/dev/null || true; wait "$HUB_PID" 2>/dev/null || true; fi
  relay_pid="$(lsof -tiTCP:"$RELAY_PORT" -sTCP:LISTEN 2>/dev/null || true)"
  [[ -z "$relay_pid" ]] || kill "$relay_pid" 2>/dev/null || true
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

mkdir -p "$TEST_HOME/.ccmesh" "$TEST_BIN"
chmod 700 "$TEST_HOME/.ccmesh"
printf 'ws://127.0.0.1:%s\n' "$HUB_WS_PORT" > "$TEST_HOME/.ccmesh/hub-url"
printf 'http://127.0.0.1:%s/\n' "$HUB_HTTP_PORT" > "$TEST_HOME/.ccmesh/ledger-url"
printf '%s\n' "$TOKEN" > "$TEST_HOME/.ccmesh/hub-token"
chmod 600 "$TEST_HOME/.ccmesh/hub-token"

# start-relay.sh calls plain `tmux`; this PATH shim puts it on a private socket and
# unsets an outer TMUX so the test can safely run from inside a tmux-managed agent.
cat > "$TEST_BIN/tmux" <<'SHIM'
#!/usr/bin/env bash
unset TMUX
exec "$MESH_TEST_REAL_TMUX" -L "$MESH_TEST_TMUX_SOCKET" "$@"
SHIM
chmod +x "$TEST_BIN/tmux"

TEST_ATTACHMENT_HUB_PORT="$HUB_HTTP_PORT" \
TEST_ATTACHMENT_HUB_TOKEN="$TOKEN" \
node "$ROOT/scripts/fixtures/fake-attachment-hub.mjs" > "$HUB_LOG" 2>&1 &
HUB_PID=$!

for _ in $(seq 1 100); do
  grep -q '^READY$' "$HUB_LOG" 2>/dev/null && break
  kill -0 "$HUB_PID" 2>/dev/null || { echo "fake attachment Hub exited" >&2; exit 1; }
  sleep 0.05
done
grep -q '^READY$' "$HUB_LOG"

status() {
  curl --noproxy '*' -sf "http://127.0.0.1:$RELAY_PORT/api/status"
}

wait_for_status() {
  for _ in $(seq 1 160); do
    status >/dev/null 2>&1 && return 0
    sleep 0.05
  done
  return 1
}

pid_for_port() {
  lsof -tiTCP:"$RELAY_PORT" -sTCP:LISTEN 2>/dev/null | head -n 1
}

run_start() {
  local ordinal="$1"
  HOME="$TEST_HOME" \
  PATH="$TEST_BIN:$PATH" \
  MESH_TEST_REAL_TMUX="$REAL_TMUX" \
  MESH_TEST_TMUX_SOCKET="$TMUX_SOCKET" \
  MESH_RELAY_SESSION="$SESSION" \
  MESH_RELAY_LOG="$RELAY_LOG" \
  RELAY_HTTP_PORT="$RELAY_PORT" \
  RELAY_HTTP_HOST="127.0.0.1" \
  MESH_DEVICE_ID="attachment-runtime-test" \
  bash "$ROOT/scripts/start-relay.sh" --force > "$TMP_ROOT/start-$ordinal.out" 2>&1
  wait_for_status || { echo "relay failed readiness after start $ordinal" >&2; exit 1; }
  "$REAL_TMUX" -L "$TMUX_SOCKET" has-session -t "$SESSION"
}

# One cold start and two force restarts lock in file fallback after process recreation.
run_start 1
pid1="$(pid_for_port)"; [[ -n "$pid1" ]]
run_start 2
pid2="$(pid_for_port)"; [[ -n "$pid2" && "$pid2" != "$pid1" ]]
run_start 3
pid3="$(pid_for_port)"; [[ -n "$pid3" && "$pid3" != "$pid2" ]]

python3 - "$TMP_ROOT/test.png" <<'PY'
import base64, pathlib, sys
pathlib.Path(sys.argv[1]).write_bytes(base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
))
PY

status > "$TMP_ROOT/status.json"
http_code="$(curl --noproxy '*' -sS -o "$TMP_ROOT/attachment.json" -w '%{http_code}' \
  -H 'Content-Type: image/png' -X POST "http://127.0.0.1:$RELAY_PORT/api/attachments" \
  --data-binary "@$TMP_ROOT/test.png")"
[[ "$http_code" == "201" ]] || { echo "POST /api/attachments returned $http_code" >&2; exit 1; }
jq -e '.ok == true and .data.manifest.mime == "image/png" and (.data.manifest.storageRef | startswith("hub-blob:"))' \
  "$TMP_ROOT/attachment.json" >/dev/null

"$REAL_TMUX" -L "$TMUX_SOCKET" list-panes -t "$SESSION" \
  -F 'session=#{session_name} command=#{pane_current_command} start=#{pane_start_command}' > "$TMP_ROOT/tmux-pane.txt"

# The secret may be read from the 0600 token file, but must not escape through any
# user-visible/runtime surface. grep -q deliberately does not print leaked bytes.
for surface in \
  "$TMP_ROOT/start-1.out" "$TMP_ROOT/start-2.out" "$TMP_ROOT/start-3.out" \
  "$RELAY_LOG" "$HUB_LOG" "$TMP_ROOT/status.json" "$TMP_ROOT/attachment.json" "$TMP_ROOT/tmux-pane.txt"; do
  if grep -Fq "$TOKEN" "$surface"; then
    echo "attachment token leaked through $(basename "$surface")" >&2
    exit 1
  fi
done

listeners="$(lsof -tiTCP:"$RELAY_PORT" -sTCP:LISTEN 2>/dev/null | wc -l | tr -d ' ')"
[[ "$listeners" == "1" ]]
[[ "$RELAY_PORT" != "19800" ]]
[[ "$SESSION" != "cc-mesh-relay" ]]

echo "PASS start-relay attachment runtime integration (isolated tmux, cold start + 2 restarts)"
