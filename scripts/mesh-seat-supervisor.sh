#!/usr/bin/env bash
# mesh-seat-supervisor.sh —— 常驻席位的看护进程（P1 生命周期解耦）
#
# 它解决什么
# ----------
# 席位（tmux session）和 relay 本体**共用同一台 tmux server**。谁掀了那台 server，
# 席位和 relay 一起没。2026-08-28 就是这么全灭的（集成测试的前缀通杀，见
# P62 bugs/席位被测试前缀通杀.md）。P0 已经把那个具体成因修掉了，
# 但「共用一台 server」这个结构没变 —— 下一个掀桌子的动作还会造成同样的后果。
#
# 本脚本是**额外的生命周期解耦，不是根因修复**（主脑原话）：
# 由 launchd 定期唤醒，发现席位不在就重建。席位从此不依赖任何人的善意存活，
# 死了会在一个 tick 内自己回来。
#
# 为什么是 bash 不是 node
# ----------------------
#   1. launchd 下 node 系 CLI 有 PATH 静默挂的老坑（PATH 只有系统四目录 → env: node）。
#   2. 更要紧：监督器**不能依赖被监督系统的构建产物**。dist 编译坏了、依赖装挂了，
#      正是最需要它工作的时候。它只用 tmux + curl，两个都在系统里。
#
# 为什么席位必须留在默认 tmux server 上
# ------------------------------------
# relay 的注入是 `tmux send-keys -t <session>`，**不带 -L**（packages/relay/src/terminal/tmux.ts）。
# 把席位挪到专用 socket 上，relay 就够不着它了 —— 那需要把 socket 名一路穿进生产接口，
# 超出 P1「额外解耦」的范围。所以这里的策略是**自动恢复**，不是物理隔离。
#
# 用法
# ----
#   mesh-seat-supervisor.sh ensure       # launchd 每 tick 调这个：巡检 + 按需重建
#   mesh-seat-supervisor.sh enumerate    # 升级/维护前：列出在世席位并告警（只读）
#   mesh-seat-supervisor.sh status       # 人看的现状
#
# 席位清单：${MESH_SEATS_CONF}（缺省 ~/.ccmesh/supervised-seats.conf），TAB 分隔：
#   name<TAB>role<TAB>description<TAB>project_dir<TAB>launcher
set -uo pipefail

# ── 今天刚学的一课：$TMUX 压过 TMUX_TMPDIR ──
# 若有人从某个 tmux pane 里手工跑本脚本，$TMUX 会把所有命令带到**那个** server 上去。
# 监督器管的永远是默认 server 上的席位（relay 注入够得着的那台），所以先把继承来的
# 这几个变量清干净，让「从哪跑」不再影响「管哪台」。
#
# 例外只有一个：MESH_SUPERVISOR_TMUX_TMPDIR。**必须显式设**这个专用名字才会生效，
# 环境里飘来的 TMUX_TMPDIR 一律不认。这样两件事同时成立：
#   · 生产路径：无论从哪跑，永远管默认 server（不会被调用者的环境带偏）
#   · 测试路径：能把整个监督器关进隔离 tmux server 里验，不碰真席位
# 一开始写的是无条件 unset，结果自己写出了个**没法测的东西**——不留这道缝，
# 验它就只能拿生产 server 当靶子。
if [ -n "${MESH_SUPERVISOR_TMUX_TMPDIR:-}" ]; then
  unset TMUX TMUX_PANE
  export TMUX_TMPDIR="$MESH_SUPERVISOR_TMUX_TMPDIR"
else
  unset TMUX TMUX_PANE TMUX_TMPDIR
fi

CCMESH_DIR="${CCMESH_DIR:-$HOME/.ccmesh}"
SEATS_CONF="${MESH_SEATS_CONF:-$CCMESH_DIR/supervised-seats.conf}"
STATE_DIR="$CCMESH_DIR/supervisor"
DEATHS_LOG="${MESH_SEAT_DEATHS_LOG:-$CCMESH_DIR/seat-deaths.log}"
RELAY_URL="${MESH_RELAY_URL:-http://localhost:19800}"
WRAPPER="${MESH_AGENT_WRAPPER:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/mesh-agent-wrapper.sh}"
DEVICE="$(hostname -s | tr '[:upper:]' '[:lower:]')"

# 重建退避：席位刚建起来就又死，多半是它自己起不来（配置错、命令不存在）。
# 这时候每 tick 重建一次就是**重启风暴**——把 CPU 和日志刷爆，还把真正的报错淹掉。
MIN_HEALTHY_S="${MESH_SEAT_MIN_HEALTHY_S:-120}"   # 活过这么久才算「立住了」，退避清零
BACKOFF_BASE_S="${MESH_SEAT_BACKOFF_BASE_S:-60}"
BACKOFF_MAX_S="${MESH_SEAT_BACKOFF_MAX_S:-1800}"

mkdir -p "$STATE_DIR" 2>/dev/null || true

log() { printf '%s [supervisor] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

session_of() { printf 'mesh-seat-%s' "$1"; }

# 席位是否在世。判据取「session 存在」+「pane 主进程还在」两样。
# 只看 session 存在是不够的：session 可以留着而里面的 shell 已经退了。
seat_alive() {
  local sess="$1" pane_pid
  tmux has-session -t "$sess" 2>/dev/null || return 1
  pane_pid="$(tmux list-panes -t "$sess" -F '#{pane_pid}' 2>/dev/null | head -1)"
  [ -n "$pane_pid" ] && kill -0 "$pane_pid" 2>/dev/null
}

absent_marker() { printf '%s/%s.absent' "$STATE_DIR" "$1"; }

# 把「监督器观察到席位不在」这件事记进同一条取证链。
#
# 🔴 重建**之前**先写。写完才重建 —— 否则新席位的 birth 记录会盖在前面，
#    事后翻日志只看得到「它一直好好的」，看不到中间断过。
#
# 🔴 只在**「在 → 不在」跳变**时记一次，不是每 tick 记一次。
#    这条是 2026-08-29 故障演练当场暴露的：席位在深度退避里躺着时，
#    原实现每分钟写一条 supervisor-absent —— 一天 1440 行，
#    既刷日志，又把真正有价值的那条「第一次发现缺席」淹在噪声里。
#    起止时刻已经由「首条 absent + 其后的 birth」这一对界定清楚了，中间的重复毫无信息量。
record_absence() {
  local name="$1" sess="$2" reason="$3"
  local marker; marker="$(absent_marker "$name")"
  [ -f "$marker" ] && return 0        # 这轮缺席已经记过了
  : > "$marker"
  local server_alive="false"
  tmux list-sessions >/dev/null 2>&1 && server_alive="true"
  printf '{"schema":"seat-death/1","event":"supervisor-absent","ts":"%s","ts_epoch":%s,"host":"%s","session":"%s","node_id":"%s:%s","short_id":"%s","reason":"%s","tmux":{"session_alive":"false","server_alive":"%s"},"detected_by":"mesh-seat-supervisor"}\n' \
    "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$(date +%s)" "$(hostname)" "$sess" \
    "$DEVICE" "$name" "$name" "$reason" "$server_alive" >> "$DEATHS_LOG" 2>/dev/null || true
}

backoff_file() { printf '%s/%s.backoff' "$STATE_DIR" "$1"; }
birth_file()   { printf '%s/%s.born_at' "$STATE_DIR" "$1"; }

# 退避判定：返回 0 = 现在可以重建；1 = 还在冷却里
may_rebuild() {
  local name="$1" now bf fails last_try wait_s
  now="$(date +%s)"
  bf="$(backoff_file "$name")"
  [ -f "$bf" ] || return 0
  # 文件格式： <连续失败次数> <上次重建时刻>
  read -r fails last_try < "$bf" 2>/dev/null || return 0
  [ -n "${fails:-}" ] && [ -n "${last_try:-}" ] || return 0
  wait_s=$(( BACKOFF_BASE_S * (1 << (fails > 5 ? 5 : fails)) ))
  [ "$wait_s" -gt "$BACKOFF_MAX_S" ] && wait_s="$BACKOFF_MAX_S"
  if [ $(( now - last_try )) -lt "$wait_s" ]; then
    log "席位 $name 在退避中（第 ${fails} 次失败后需等 ${wait_s}s，已过 $(( now - last_try ))s），本 tick 不重建"
    return 1
  fi
  return 0
}

note_rebuild_attempt() {
  local name="$1" bf fails now
  now="$(date +%s)"
  bf="$(backoff_file "$name")"
  fails=0
  [ -f "$bf" ] && read -r fails _ < "$bf" 2>/dev/null
  printf '%s %s\n' "$(( ${fails:-0} + 1 ))" "$now" > "$bf"
  printf '%s\n' "$now" > "$(birth_file "$name")"
}

# 席位已经稳住（活过 MIN_HEALTHY_S）→ 清退避账，下次真出事时不必背着旧账等半小时
clear_backoff_if_healthy() {
  local name="$1" born now
  local f; f="$(birth_file "$name")"
  [ -f "$f" ] || return 0
  read -r born < "$f" 2>/dev/null || return 0
  now="$(date +%s)"
  if [ -n "${born:-}" ] && [ $(( now - born )) -ge "$MIN_HEALTHY_S" ]; then
    rm -f "$(backoff_file "$name")" "$f" 2>/dev/null || true
  fi
}

# 刚起来的席位停在**交互提示**上时，喊一嗓子。
#
# 为什么值得单独一道：2026-08-29 亲身踩过。新建的 codex 席位一启动就弹了升级提示
# （0.150.1 → 0.151.0），光标默认停在「1. Update now」。此时往席位投一条消息，
# 注入的回车不是被 codex 当输入收下，而是**把那个提示确认了** ——
# 一次「连通性验活」变成了一次全机 `npm install -g @openai/codex`。
#
# 两个教训都在这里：
#   · 席位「在世」不等于「可用」。它可能正卡在一个等人按键的框里。
#   · 投递返回 delivered 只说明按键进了 pane，**不说明 agent 收到了消息**。
#
# 只报警不代按。代按等于替人做决定，而提示框里可能是任何东西（升级、覆盖、删除）。
warn_if_awaiting_input() {
  local name="$1" sess="$2" tail_txt
  tail_txt="$(tmux capture-pane -t "$sess" -p -S -8 2>/dev/null)" || return 0
  if printf '%s' "$tail_txt" | grep -qE 'Press enter|^[[:space:]]*›[[:space:]]*[0-9]+\.|\(y/N\)|\[Y/n\]|Continue\?'; then
    log "⚠️  席位 $name 疑似停在**交互提示**上。此时投消息，回车会去确认那个提示，"
    log "    而不是被 agent 当输入收下。先 tmux capture-pane -t ${sess} 看清楚再投。"
  fi
}

rebuild_seat() {
  local name="$1" role="$2" desc="$3" dir="$4" launcher="$5" sess
  sess="$(session_of "$name")"

  if [ ! -x "$WRAPPER" ] && [ ! -f "$WRAPPER" ]; then
    log "🔴 找不到 wrapper：$WRAPPER —— 不重建（宁可席位缺着，也不建一个没有取证链的野席位）"
    return 1
  fi
  [ -d "$dir" ] || { log "🔴 席位 $name 的 project_dir 不存在：$dir —— 不重建"; return 1; }

  note_rebuild_attempt "$name"
  # 复用 mesh-agent-wrapper.sh：注册 / 取证 / 注销全在它里面，
  # 监督器只负责「让它跑起来」，不自己另造一套（另造 = 取证链断成两半）。
  MESH_SHORT_ID="$name" MESH_LAUNCHER="$launcher" \
    tmux new-session -d -s "$sess" -c "$dir" \
      "MESH_SHORT_ID='$name' MESH_LAUNCHER='$launcher' bash '$WRAPPER' '$role' '$desc' '$dir' '$launcher'" \
    2>/dev/null
  # 🔴 刚建出来的 session 不能马上判活。
  #   实测：命令秒退（exit 3）的 session，紧接着连探三次 —— **前两次都报「在」且 pane 进程存活**，
  #   第三次 pane_pid 才变空。tmux 拆 session 有个短窗口。
  #   不等这一下，rebuild_seat 会给一个已经死了的席位盖上「✅ 已重建」的章，
  #   于是缺席标记被清、下一 tick 重新记档、退避也判不准 —— 一路错下去。
  #   连探几次而不是只 sleep 一次：中途任何一次判死就立刻收工，别把 tick 时间耗在等一个注定失败的席位上。
  local settled=1 probe
  for probe in 1 2 3 4; do
    sleep 0.5
    if ! seat_alive "$sess"; then settled=0; break; fi
  done

  if [ "$settled" = "1" ]; then
    # 本轮缺席到此结束（紧跟着就是 wrapper 写的 birth 记录）。
    # 标记必须**当场**清，不能等下一轮开头那个 seat_alive 分支：
    # 席位是在同一轮里起来的，等下一轮就意味着「起来 → 又死」这个来回不会被记档。
    rm -f "$(absent_marker "$name")" 2>/dev/null || true
    log "✅ 席位 $name 已重建（session=${sess}）"
    warn_if_awaiting_input "$name" "$sess"
    return 0
  fi
  log "🔴 席位 $name 重建后仍不在世（session=${sess}）"
  return 1
}

cmd_ensure() {
  if [ ! -f "$SEATS_CONF" ]; then
    log "没有席位清单（${SEATS_CONF}），无事可做"
    return 0
  fi
  local name role desc dir launcher sess
  while IFS=$'\t' read -r name role desc dir launcher; do
    case "${name:-}" in ""|\#*) continue;; esac
    sess="$(session_of "$name")"
    if seat_alive "$sess"; then
      # 席位回来了 → 撤掉缺席标记，下次真出事时才会重新记一条
      rm -f "$(absent_marker "$name")" 2>/dev/null || true
      clear_backoff_if_healthy "$name"
      continue
    fi
    log "席位 $name 不在世（session=${sess}）"
    record_absence "$name" "$sess" "session-or-pane-missing"
    may_rebuild "$name" || continue
    rebuild_seat "$name" "${role:-seat}" "${desc:-mesh-seat}" "${dir:-$HOME}" "${launcher:-codex}"
  done < "$SEATS_CONF"
}

# 升级 / 维护前的枚举告警（只读，绝不改任何东西）。
# 存在的意义：让「我要重启 relay / 跑全量测试」这类动作之前，先看见自己会影响到谁。
cmd_enumerate() {
  local n=0
  echo "== 默认 tmux server 上的 mesh-* session =="
  while read -r line; do
    [ -n "$line" ] || continue
    echo "  $line"
    n=$(( n + 1 ))
  done < <(tmux list-sessions -F '#{session_name}  pane_pid=#{pane_pid}  created=#{session_created}' 2>/dev/null | grep '^mesh-' || true)
  [ "$n" -eq 0 ] && echo "  （无）"
  echo
  echo "== relay 本体 =="
  if [ -f "$CCMESH_DIR/relay.pid" ]; then
    local rp; rp="$(cat "$CCMESH_DIR/relay.pid" 2>/dev/null)"
    if kill -0 "$rp" 2>/dev/null; then
      echo "  pid=$rp 在跑，启动于 $(ps -p "$rp" -o lstart= 2>/dev/null | sed 's/^ *//')"
    else
      echo "  pid=$rp 已不在（pid 文件是陈的）"
    fi
  else
    echo "  无 relay.pid"
  fi
  echo
  if [ "$n" -gt 0 ]; then
    echo "⚠️  上面 $n 个 session 都活在**同一台** tmux server 上。"
    echo "   任何 tmux kill-server、或对该 server 的批量清理，会把它们连同 relay 一起带走。"
    echo "   要动 relay 或跑会碰 tmux 的测试，先确认你知道这 $n 个是谁。"
  fi
}

cmd_status() {
  cmd_enumerate
  echo
  echo "== 受监督席位 =="
  if [ ! -f "$SEATS_CONF" ]; then echo "  （无清单：${SEATS_CONF}）"; return 0; fi
  local name role desc dir launcher sess
  while IFS=$'\t' read -r name role desc dir launcher; do
    case "${name:-}" in ""|\#*) continue;; esac
    sess="$(session_of "$name")"
    if seat_alive "$sess"; then
      printf '  %-16s ✅ 在世  session=%s\n' "$name" "$sess"
    else
      printf '  %-16s 🔴 不在  session=%s' "$name" "$sess"
      [ -f "$(backoff_file "$name")" ] && printf '  (退避中: %s)' "$(cat "$(backoff_file "$name")")"
      printf '\n'
    fi
  done < "$SEATS_CONF"
}

case "${1:-ensure}" in
  ensure)    cmd_ensure ;;
  enumerate) cmd_enumerate ;;
  status)    cmd_status ;;
  *) echo "用法: $(basename "$0") {ensure|enumerate|status}" >&2; exit 2 ;;
esac
