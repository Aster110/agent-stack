#!/usr/bin/env bash
# mesh-relay-supervisor.sh —— relay 本体的外部监督（P2）
#
# 为什么存在
# ----------
# 2026-08-29 演练途中撞见 relay 进程 44262 **自己死了**：
#   ~06:36 pane_pid=44262 还活着；06:42 pid 文件里仍是 44262 但进程没了。
#   它**没走 shutdown()**（否则 relayPidFile 会被 unlink）⇒ uncaughtException → exit(1)，或被 SIGKILL。
#   崩溃报告、统一日志均无匹配。**连"它死过"这件事，都要靠 pid 文件与进程对不上才推得出来。**
# 席位有死亡取证、有监督器；relay 两样都没有，而它是整个 mesh 的单点。
#
# 🔴 顺序纪律（主脑 seq742 定，本脚本的骨架就是它）
#   **先取证，后有限恢复。禁止无限看门狗掩盖根因。**
#   一个只会重启的看门狗，会把"relay 每小时死一次"变成一条谁也不会去查的平滑曲线。
#   所以：判死 → 先落档 → 再恢复 → 且恢复次数有熔断上限。
#
# 判活取四个信号（缺一不可，各自能抓到不同的死法）
#   ① pid 文件里的进程还在吗          —— 抓"死透了"
#   ② 进程启动时刻和上次记的一样吗    —— 抓"背着我们死过又被别人拉起来了"
#   ③ tmux pane 还在吗                —— 抓"进程在但宿主 pane 没了"
#   ④ 127.0.0.1:19800/api/status 200？—— 抓"进程在、端口在，但已经不干活了"
#   只看 ① 会漏掉后三种；只看 ④ 会把一次网络抖动当成死亡。
#
# 用法
#   mesh-relay-supervisor.sh ensure    # launchd 每 tick 调这个
#   mesh-relay-supervisor.sh status    # 人看的现状（只读）
#   mesh-relay-supervisor.sh probe     # 只判活并打印判据，不做任何恢复（只读）
set -uo pipefail

# 与席位监督器同款的环境净化：$TMUX 会把 tmux 命令带到调用者所在的 server 上去。
# 例外只有显式的 MESH_SUPERVISOR_TMUX_TMPDIR（测试用），环境里飘来的 TMUX_TMPDIR 一律不认。
if [ -n "${MESH_SUPERVISOR_TMUX_TMPDIR:-}" ]; then
  unset TMUX TMUX_PANE
  export TMUX_TMPDIR="$MESH_SUPERVISOR_TMUX_TMPDIR"
else
  unset TMUX TMUX_PANE TMUX_TMPDIR
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CCMESH_DIR="${CCMESH_DIR:-$HOME/.ccmesh}"
PID_FILE="${MESH_RELAY_PID_FILE:-$CCMESH_DIR/relay.pid}"
RELAY_SESSION="${MESH_RELAY_SESSION:-mesh-relay}"
RELAY_URL="${MESH_RELAY_URL:-http://127.0.0.1:19800}"
DEATHS_LOG="${MESH_RELAY_DEATHS_LOG:-$CCMESH_DIR/relay-deaths.log}"
STATE_DIR="$CCMESH_DIR/relay-supervisor"
MESH_CLI="${MESH_CLI:-$HERE/../packages/cli/mesh.sh}"
REDACT="${MESH_REDACT:-$HERE/mesh_redact.py}"

# 恢复节流。数字取自主脑 seq742。
BACKOFF_BASE_S="${MESH_RELAY_BACKOFF_BASE_S:-60}"
BACKOFF_MAX_S="${MESH_RELAY_BACKOFF_MAX_S:-1800}"
BREAKER_WINDOW_S="${MESH_RELAY_BREAKER_WINDOW_S:-3600}"
BREAKER_MAX="${MESH_RELAY_BREAKER_MAX:-6}"
# 「进程活着但 HTTP 不通」不立刻判死：可能只是一次抖动。连着这么多 tick 不通才动手。
HUNG_TICKS_BEFORE_ACT="${MESH_RELAY_HUNG_TICKS:-3}"

mkdir -p "$STATE_DIR" 2>/dev/null || true

log() { printf '%s [relay-sup] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

STATE_FILE="$STATE_DIR/observed"        # 上次看到的 pid 与启动时刻
HUNG_FILE="$STATE_DIR/hung_count"
BACKOFF_FILE="$STATE_DIR/backoff"       # <连续恢复次数> <上次恢复时刻>
BREAKER_FILE="$STATE_DIR/restarts"      # 每行一个恢复时刻（epoch）
BREAKER_TRIPPED="$STATE_DIR/breaker_tripped"

# ---------------------------------------------------------------- 判活四信号
OBS_PID=""; OBS_START=""; OBS_PANE=""; OBS_HTTP=""; OBS_PIDFILE=""

probe() {
  OBS_PIDFILE=""; OBS_PID=""; OBS_START=""; OBS_PANE=""; OBS_HTTP=""
  [ -f "$PID_FILE" ] && OBS_PIDFILE="$(cat "$PID_FILE" 2>/dev/null | tr -d '[:space:]')"

  # ① + ② 进程与启动时刻。lstart 是**唯一**能区分「一直是它」和「死了又被拉起来」的东西：
  #    pid 会被复用，光看 pid 相同不能证明没换过人。
  if [ -n "$OBS_PIDFILE" ] && kill -0 "$OBS_PIDFILE" 2>/dev/null; then
    OBS_PID="$OBS_PIDFILE"
    OBS_START="$(ps -p "$OBS_PID" -o lstart= 2>/dev/null | sed 's/^ *//;s/ *$//')"
  fi

  # ③ tmux pane
  if tmux has-session -t "$RELAY_SESSION" 2>/dev/null; then
    OBS_PANE="$(tmux list-panes -t "$RELAY_SESSION" -F '#{pane_pid}' 2>/dev/null | head -1)"
  fi

  # ④ HTTP。--noproxy 是硬要求：本机装着全局代理时，不带它会把 127.0.0.1 也送去代理，
  #    然后拿一个和 relay 毫无关系的响应回来（或超时），判死判活全错。
  OBS_HTTP="$(curl -s --noproxy '*' --max-time 5 -o /dev/null -w '%{http_code}' "$RELAY_URL/api/status" 2>/dev/null)"
  [ -z "$OBS_HTTP" ] && OBS_HTTP="000"
}

# 判决：alive / dead / hung / restarted-externally
verdict() {
  if [ -z "$OBS_PID" ]; then
    echo "dead"; return
  fi
  local prev_pid="" prev_start=""
  if [ -f "$STATE_FILE" ]; then
    prev_pid="$(sed -n '1p' "$STATE_FILE" 2>/dev/null)"
    prev_start="$(sed -n '2p' "$STATE_FILE" 2>/dev/null)"
  fi
  # 背着我们换过人：pid 变了，或 pid 同但启动时刻变了（pid 复用）
  if [ -n "$prev_pid" ] && { [ "$prev_pid" != "$OBS_PID" ] || [ "$prev_start" != "$OBS_START" ]; }; then
    echo "restarted-externally"; return
  fi
  if [ "$OBS_HTTP" != "200" ]; then
    echo "hung"; return
  fi
  echo "alive"
}

save_observed() { printf '%s\n%s\n' "$OBS_PID" "$OBS_START" > "$STATE_FILE"; }

# ---------------------------------------------------------------- 取证（先于恢复）
# 🔴 隐私红线，比取证价值优先：
#   · **绝不取 argv**（relay 的命令行可能带 token/URL 口令）
#   · pane 只取尾部有限行，且**先脱敏再落盘**（走 mesh_redact.py，与席位取证同一套规则）
#   · 日志 0600
record_death() {
  local kind="$1"
  local pane_tail="[]" hits=0

  if [ -n "$OBS_PANE" ] || tmux has-session -t "$RELAY_SESSION" 2>/dev/null; then
    local raw
    raw="$(tmux capture-pane -t "$RELAY_SESSION" -p -S -"${MESH_RELAY_PANE_LINES:-20}" 2>/dev/null || true)"
    if [ -n "$raw" ] && [ -x "$REDACT" ]; then
      local red
      red="$(printf '%s' "$raw" | python3 "$REDACT" 2>/dev/null)"
      pane_tail="$(printf '%s' "$red" | python3 -c 'import json,sys; print(json.dumps([l for l in sys.stdin.read().splitlines() if l.strip()][-20:], ensure_ascii=False))' 2>/dev/null || echo '[]')"
    elif [ -n "$raw" ]; then
      # 脱敏模块不可用 → **宁可不留 pane，也不留没脱敏的 pane**
      pane_tail='["[OMITTED: mesh_redact.py 不可用，拒绝落未脱敏内容]"]'
    fi
  fi

  local load mem_free disk_free proc_n
  load="$(uptime 2>/dev/null | sed -n 's/.*load averages*: *//p' | tr -s ' ' | tr ' ' ',' | tr -d '\n')"
  mem_free="$(vm_stat 2>/dev/null | /usr/bin/awk '/Pages free/{gsub(/\./,"",$3); print int($3*4096/1048576)}')"
  disk_free="$(df -m "$HOME" 2>/dev/null | /usr/bin/awk 'NR==2{print $4}')"
  proc_n="$(ps ax 2>/dev/null | wc -l | tr -d ' ')"

  umask 077
  python3 - "$kind" "$pane_tail" <<PYEOF >> "$DEATHS_LOG" 2>/dev/null
import json, sys, time
kind = sys.argv[1]
try:
    pane = json.loads(sys.argv[2])
except Exception:
    pane = []
rec = {
    "schema": "relay-death/1",
    "event": kind,
    "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    "ts_epoch": int(time.time()),
    "host": "$(hostname)",
    "session": "$RELAY_SESSION",
    # 判据原样留档 —— 事后要能重演当时的判断，而不是只看到一个结论
    "signals": {
        "pid_file_content": "$OBS_PIDFILE" or None,
        "process_alive_pid": "$OBS_PID" or None,
        "process_started_at": "$OBS_START" or None,
        "tmux_pane_pid": "$OBS_PANE" or None,
        "http_status": "$OBS_HTTP",
    },
    # pid 文件与真实进程的偏差 —— 上次那场静默死亡就是靠它才被发现的
    "pid_file_discrepancy": (
        "pid 文件有 $OBS_PIDFILE 但该进程不存在"
        if "$OBS_PIDFILE" and not "$OBS_PID" else
        ("无 pid 文件" if not "$OBS_PIDFILE" else None)
    ),
    "resources": {
        "load": "$load" or None,
        "mem_free_mb": int("$mem_free") if "$mem_free".isdigit() else None,
        "disk_free_mb": int("$disk_free") if "$disk_free".isdigit() else None,
        "proc_count": int("$proc_n") if "$proc_n".isdigit() else None,
    },
    "pane_tail_redacted": pane,
    "pane_tail_lines": len(pane),
    # 显式声明没采什么，免得未来有人以为"取证里没有 = 没发生"
    "not_collected": ["argv", "env", "tokens", "prompts"],
}
print(json.dumps(rec, ensure_ascii=False))
PYEOF
  chmod 600 "$DEATHS_LOG" 2>/dev/null || true
  log "已落死亡档（kind=${kind}）→ $DEATHS_LOG"
}

# ---------------------------------------------------------------- 熔断 + 退避
now_s() { date +%s; }

breaker_tripped() {
  [ -f "$BREAKER_TRIPPED" ]
}

# 1 小时内恢复超过 BREAKER_MAX 次 → 熔断停手。
# 这条就是「禁止无限看门狗掩盖根因」的落点：relay 反复死说明有根因，
# 一直把它拉起来只会让问题变成一条谁也不会去查的平滑曲线。
breaker_check_and_record() {
  local now cutoff kept=0
  now="$(now_s)"; cutoff=$(( now - BREAKER_WINDOW_S ))
  local tmp="$BREAKER_FILE.tmp"
  : > "$tmp"
  if [ -f "$BREAKER_FILE" ]; then
    while read -r t; do
      case "$t" in ''|*[!0-9]*) continue;; esac
      if [ "$t" -ge "$cutoff" ]; then echo "$t" >> "$tmp"; kept=$(( kept + 1 )); fi
    done < "$BREAKER_FILE"
  fi
  if [ "$kept" -ge "$BREAKER_MAX" ]; then
    mv "$tmp" "$BREAKER_FILE"
    printf '%s\n' "$now" > "$BREAKER_TRIPPED"
    log "🔴 熔断：过去 $(( BREAKER_WINDOW_S / 60 )) 分钟内已恢复 ${kept} 次（上限 ${BREAKER_MAX}）。"
    log "    停止自动恢复。relay 反复死 = 有根因，继续重启只会把它藏起来。"
    log "    查 ${DEATHS_LOG}，处理完后删掉 $BREAKER_TRIPPED 解除。"
    return 1
  fi
  echo "$now" >> "$tmp"
  mv "$tmp" "$BREAKER_FILE"
  return 0
}

may_recover() {
  local now bf fails last wait_s
  now="$(now_s)"
  [ -f "$BACKOFF_FILE" ] || return 0
  read -r fails last < "$BACKOFF_FILE" 2>/dev/null || return 0
  [ -n "${fails:-}" ] && [ -n "${last:-}" ] || return 0
  wait_s=$(( BACKOFF_BASE_S * (1 << (fails > 5 ? 5 : fails)) ))
  [ "$wait_s" -gt "$BACKOFF_MAX_S" ] && wait_s="$BACKOFF_MAX_S"
  if [ $(( now - last )) -lt "$wait_s" ]; then
    log "退避中（第 ${fails} 次恢复后需等 ${wait_s}s，已过 $(( now - last ))s），本 tick 不动"
    return 1
  fi
  return 0
}

note_recovery_attempt() {
  local fails=0
  [ -f "$BACKOFF_FILE" ] && read -r fails _ < "$BACKOFF_FILE" 2>/dev/null
  printf '%s %s\n' "$(( ${fails:-0} + 1 ))" "$(now_s)" > "$BACKOFF_FILE"
}

# ---------------------------------------------------------------- 恢复
recover() {
  if [ ! -f "$MESH_CLI" ]; then
    log "🔴 找不到 mesh CLI：$MESH_CLI —— 不自造启动路径，停手"
    return 1
  fi
  note_recovery_attempt
  log "调用既有启动路径恢复（bash $MESH_CLI relay start）"
  bash "$MESH_CLI" relay start >/dev/null 2>&1
  sleep 3
  probe
  if [ -n "$OBS_PID" ] && [ "$OBS_HTTP" = "200" ]; then
    save_observed
    rm -f "$HUNG_FILE" 2>/dev/null || true
    log "✅ relay 已恢复（pid=$OBS_PID http=${OBS_HTTP}）"
    verify_after_recovery
    return 0
  fi
  log "🔴 恢复后仍不健康（pid='${OBS_PID}' http=${OBS_HTTP}）"
  return 1
}

# 恢复后核对：uplink / 节点表。
# 🔴 **不得假称 SSE 门铃也恢复了。** 门铃是各会话自己挂的长连接，relay 一重启就断，
#    它的自愈是独立的一层（A 层），本脚本既看不见也管不着。
#    在这里写一句"已恢复"，会让人以为消息通道回来了，而实际上没人在听。
verify_after_recovery() {
  local body
  body="$(curl -s --noproxy '*' --max-time 5 "$RELAY_URL/api/status" 2>/dev/null)"
  local nodes uplink
  nodes="$(printf '%s' "$body" | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin); ns=(d.get("data") or {}).get("nodes") or []
    print(len(ns))
except Exception: print("?")' 2>/dev/null)"
  uplink="$(printf '%s' "$body" | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin); u=(d.get("data") or {}).get("uplink")
    print(u if isinstance(u,str) else ("present" if u else "absent"))
except Exception: print("?")' 2>/dev/null)"
  log "恢复后核对：节点表 ${nodes} 条，uplink=${uplink}"
  log "⚠️  SSE 门铃**不在本脚本职责内**：relay 一重启，各会话挂的长连接就断了。"
  log "    门铃自愈是独立的 A 层，需要各会话自己重挂。别把这里的绿当成消息通道已恢复。"
}

# ---------------------------------------------------------------- 主流程
cmd_ensure() {
  probe
  local v; v="$(verdict)"

  case "$v" in
    alive)
      save_observed
      rm -f "$HUNG_FILE" 2>/dev/null || true
      # 健康够久就把退避账清掉（同席位监督器的语义）
      rm -f "$BACKOFF_FILE" 2>/dev/null || true
      ;;
    restarted-externally)
      # 关键能力：抓住「背着我们死过又被别人拉起来」。
      # 上一次静默死亡就是这个形态 —— 若没人记，它连发生过都无从得知。
      log "检测到 relay 已被外部重启（pid=$OBS_PID start=${OBS_START}），仅记档不干预"
      record_death "restarted-externally"
      save_observed
      ;;
    hung)
      local n=0
      [ -f "$HUNG_FILE" ] && read -r n < "$HUNG_FILE" 2>/dev/null
      n=$(( ${n:-0} + 1 ))
      printf '%s\n' "$n" > "$HUNG_FILE"
      log "relay 进程在（pid=${OBS_PID}）但 /api/status=${OBS_HTTP}，连续第 ${n} 次"
      if [ "$n" -lt "$HUNG_TICKS_BEFORE_ACT" ]; then
        log "未达 ${HUNG_TICKS_BEFORE_ACT} 次门槛，先不动（一次抖动不该触发重启）"
        return 0
      fi
      breaker_tripped && { log "🔴 熔断已触发，不恢复。见 $BREAKER_TRIPPED"; return 0; }
      record_death "hung"
      may_recover || return 0
      breaker_check_and_record || return 0
      recover
      ;;
    dead)
      log "relay 判死（pid文件='${OBS_PIDFILE}' 进程=无 pane='${OBS_PANE}' http=${OBS_HTTP}）"
      breaker_tripped && { log "🔴 熔断已触发，不恢复。见 $BREAKER_TRIPPED"; return 0; }
      record_death "dead"          # 🔴 取证在恢复之前，顺序不可调换
      may_recover || return 0
      breaker_check_and_record || return 0
      recover
      ;;
  esac
}

cmd_probe() {
  probe
  local v; v="$(verdict)"
  echo "  判决         : $v"
  echo "  pid 文件     : ${OBS_PIDFILE:-（无）}"
  echo "  存活进程 pid : ${OBS_PID:-（无）}"
  echo "  进程启动时刻 : ${OBS_START:-（无）}"
  echo "  tmux pane pid: ${OBS_PANE:-（无）}"
  echo "  /api/status  : $OBS_HTTP"
}

cmd_status() {
  cmd_probe
  echo
  echo "  死亡档       : $DEATHS_LOG$([ -f "$DEATHS_LOG" ] && echo "（$(wc -l < "$DEATHS_LOG" | tr -d ' ') 条）")"
  echo "  连续 hung    : $([ -f "$HUNG_FILE" ] && cat "$HUNG_FILE" || echo 0)"
  echo "  退避状态     : $([ -f "$BACKOFF_FILE" ] && cat "$BACKOFF_FILE" || echo '无')"
  local n=0; [ -f "$BREAKER_FILE" ] && n="$(wc -l < "$BREAKER_FILE" | tr -d ' ')"
  echo "  近 $(( BREAKER_WINDOW_S / 60 ))min 恢复次数 : $n / $BREAKER_MAX"
  # `cmd && echo` 作为函数最后一句，会让**健康时**的返回值变成 1（cmd 为假）。
  # 一个只读的 status 在系统健康时返回非零，会把调用它的脚本坑掉。
  if breaker_tripped; then
    echo "  🔴 熔断已触发：${BREAKER_TRIPPED}（处理完根因后删掉它解除）"
  fi
  return 0
}

case "${1:-ensure}" in
  ensure) cmd_ensure ;;
  probe)  cmd_probe ;;
  status) cmd_status ;;
  *) echo "用法: $(basename "$0") {ensure|probe|status}" >&2; exit 2 ;;
esac
