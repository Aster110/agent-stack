#!/usr/bin/env bash
# E10 —— 冷启动（重启机器后席位自己回来）。
#
# ⚠️ **本轮只写不执行**：这个 case 要重启整台机器，必须 aster 在场、主席位授权。
#    重启会掀掉 relay、所有 tmux 席位、正在跑的活。别顺手跑。
#
# 怎么用（两段）：
#   1) 重启**之前**：bash E10-cold-boot.sh baseline <seat>   # 存基线到 ~/.ccmesh/codex-seat/<seat>/e10-baseline.json
#   2) 登录**之后**：bash E10-cold-boot.sh verify <seat>     # 120s 内验四件事，写证据 JSON
#
# 判据（设计稿 §10）：登录后 ≤120s
#   · launchctl 已加载 com.aster.codex-seat.<seat>
#   · sidecar 进程在（pid 文件 + ps 双证）
#   · relay /api/status 里有该节点
#   · ping 的 [seen] ≤2000ms
set -uo pipefail

MODE="${1:-}"
SEAT="${2:-}"
[ -n "$MODE" ] && [ -n "$SEAT" ] || { echo "用法: $0 baseline|verify <seat>" >&2; exit 2; }

HOME_DIR="${HOME}"
SEAT_DIR="$HOME_DIR/.ccmesh/codex-seat/$SEAT"
LABEL="com.aster.codex-seat.$SEAT"
RELAY="${MESH_RELAY_URL:-http://127.0.0.1:19800}"
CURL=(curl --noproxy '*' -s -m 5)
OUT_DIR="${CODEX_SEAT_E2E_OUT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../evidence" 2>/dev/null && pwd || echo /tmp)}"
BUDGET_S=120

now_iso() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

case "$MODE" in
  baseline)
    mkdir -p "$SEAT_DIR"
    {
      printf '{"at":"%s","label":"%s",' "$(now_iso)" "$LABEL"
      printf '"launchctl":"%s",' "$(launchctl list | grep -c "$LABEL" || true)"
      printf '"state":%s}' "$(cat "$SEAT_DIR/state.json" 2>/dev/null || echo null)"
    } > "$SEAT_DIR/e10-baseline.json"
    echo "基线已存：$SEAT_DIR/e10-baseline.json"
    echo "现在可以重启机器。登录后跑：bash $0 verify $SEAT"
    ;;

  verify)
    BASE="$SEAT_DIR/e10-baseline.json"
    [ -f "$BASE" ] || { echo "没有基线文件 $BASE —— 重启前先跑 baseline" >&2; exit 3; }
    T0="$(date +%s)"
    OLD_INSTANCE="$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print((d.get("state") or {}).get("instanceId") or "")' "$BASE")"
    NODE_ID="$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print((d.get("state") or {}).get("nodeId") or "")' "$BASE")"

    loaded=0; sidecar=0; registered=0; seen_ms=-1; instance=""
    while [ $(( $(date +%s) - T0 )) -lt $BUDGET_S ]; do
      launchctl list | grep -q "$LABEL" && loaded=1
      PID="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("pid",""))' "$SEAT_DIR/sidecar.pid" 2>/dev/null || echo "")"
      [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null && sidecar=1
      instance="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("instanceId",""))' "$SEAT_DIR/state.json" 2>/dev/null || echo "")"
      "${CURL[@]}" "$RELAY/api/status" | grep -q "$NODE_ID" && registered=1
      [ "$loaded" = 1 ] && [ "$sidecar" = 1 ] && [ "$registered" = 1 ] && break
      sleep 3
    done
    ELAPSED=$(( $(date +%s) - T0 ))

    NONCE="E10-$(head -c3 /dev/urandom | xxd -p)"
    if [ "$registered" = 1 ]; then
      SEND_AT="$(python3 -c 'import time;print(int(time.time()*1000))')"
      "${CURL[@]}" -X POST "$RELAY/api/send" -H 'content-type: application/json' \
        -H "x-mesh-node: $(hostname -s | tr '[:upper:]' '[:lower:]'):claude-main" \
        -d "{\"to\":\"$NODE_ID\",\"message\":\"请只回 ok。nonce=$NONCE\"}" >/dev/null
      # 收 [seen] 要有个收件端；这里退化成看席位日志里的 seen 时间戳
      for _ in $(seq 1 20); do
        if grep -q "$NONCE" "$SEAT_DIR/log/stdout.log" 2>/dev/null; then
          seen_ms=$(( $(python3 -c 'import time;print(int(time.time()*1000))') - SEND_AT ))
          break
        fi
        sleep 1
      done
    fi

    mkdir -p "$OUT_DIR"
    F="$OUT_DIR/E10-$(now_iso | tr ':' '-').json"
    cat > "$F" <<JSON
{
  "case": "E10",
  "nonce": "$NONCE",
  "startedAt": "$(now_iso)",
  "wallMs": $(( ELAPSED * 1000 )),
  "events": {"launchctl.loaded": $loaded, "sidecar.alive": $sidecar, "relay.registered": $registered},
  "rolloutBytesBefore": null,
  "rolloutBytesAfter": null,
  "assertions": [
    {"name":"≤120s launchctl 已加载","pass": $([ "$loaded" = 1 ] && echo true || echo false),"actual": $loaded,"expected": 1},
    {"name":"≤120s sidecar 进程在","pass": $([ "$sidecar" = 1 ] && echo true || echo false),"actual": $sidecar,"expected": 1},
    {"name":"≤120s relay 里有该节点","pass": $([ "$registered" = 1 ] && echo true || echo false),"actual": $registered,"expected": 1},
    {"name":"instanceId 换了新的（说明是冷启新起的）","pass": $([ -n "$instance" ] && [ "$instance" != "$OLD_INSTANCE" ] && echo true || echo false),"actual": "$instance","expected": "!= $OLD_INSTANCE"},
    {"name":"ping [seen] ≤2000ms","pass": $([ "$seen_ms" -ge 0 ] && [ "$seen_ms" -le 2000 ] && echo true || echo false),"actual": $seen_ms,"expected": "<=2000"}
  ],
  "mutation": null,
  "notes": "冷启动人工档：重启前 baseline，登录后 verify。elapsed=${ELAPSED}s",
  "passed": $([ "$loaded" = 1 ] && [ "$sidecar" = 1 ] && [ "$registered" = 1 ] && echo true || echo false),
  "lane": "C",
  "phase": "manual",
  "env": {"relay": "real", "appServer": "real"},
  "contractVersion": "1",
  "codexVersion": null,
  "hostname": "$(hostname)",
  "instanceId": "$instance"
}
JSON
    echo "证据：$F"
    cat "$F"
    ;;

  *) echo "用法: $0 baseline|verify <seat>" >&2; exit 2 ;;
esac
