#!/usr/bin/env bash
# mesh-seat-forensics.test.sh — 席位死亡取证的单元/集成测试
#
# 跑法: bash scripts/mesh-seat-forensics.test.sh
# 依赖: bash / python3。**不需要 relay、不需要真 tmux、不联网**。
#
# 沙箱纪律（照抄 wake-scripts.test.sh 的口径）：
#   - 全程 HOME 指向 mktemp 沙箱，落盘只落沙箱
#   - tmux 全程用 PATH 上的假货，**一次都不碰真 tmux**
#     （生产 relay 跑在 tmux session `cc-mesh-relay` 里，碰它 = 敲掉主力通道）
#   - 不打任何端口，不 curl，不注册节点 → 生产注册表零影响
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/scripts/mesh-seat-forensics.sh"
WRAPPER="$ROOT/scripts/mesh-agent-wrapper.sh"

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/seatforensics.XXXXXX")"
[ -n "$SANDBOX" ] && [ -d "$SANDBOX" ] || { echo "沙箱建不出来，拒绝继续（防 rm -rf 空变量）" >&2; exit 1; }
export HOME="$SANDBOX/home"
mkdir -p "$HOME"

pass=0
fail=0
ok()   { echo "  ✓ $1"; pass=$(( pass + 1 )); }
bad()  { echo "  ✗ $1" >&2; fail=$(( fail + 1 )); }
note() { echo "    · $1"; }

cleanup() {
  # 只杀本测试自己起的假进程，绝不 pkill 泛匹配
  [ -n "${VICTIM_PID:-}" ] && kill -9 "$VICTIM_PID" 2>/dev/null
  [ -n "${REAPER_PID:-}" ] && kill -9 "$REAPER_PID" 2>/dev/null
  [ -n "${VICTIM2_PID:-}" ] && kill -9 "$VICTIM2_PID" 2>/dev/null
  [ -n "${REAPER2_PID:-}" ] && kill -9 "$REAPER2_PID" 2>/dev/null
  rm -rf "$SANDBOX"
  return 0
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# 假 tmux：capture-pane 吐固定文件内容，其余子命令一律成功但不做事。
# 装在 PATH 最前面 —— 保证整套测试碰不到真 tmux。
# ---------------------------------------------------------------------------
FAKEBIN="$SANDBOX/bin"
mkdir -p "$FAKEBIN"
cat > "$FAKEBIN/tmux" <<'SH'
#!/usr/bin/env bash
case "${1:-}" in
  capture-pane)  cat "${MESH_TEST_PANE_FILE:-/dev/null}" ;;
  has-session)   [ "${MESH_TEST_SESSION_ALIVE:-1}" = "1" ] || exit 1 ;;
  list-sessions) echo "fake-session: 1 windows (created now)" ;;
  *)             exit 0 ;;
esac
SH
chmod +x "$FAKEBIN/tmux"
export PATH="$FAKEBIN:$PATH"

LOG="$HOME/.ccmesh/seat-deaths.log"
STATE_DIR="$HOME/.ccmesh/seat-forensics"
export MESH_FORENSICS_LOG="$LOG"
export MESH_FORENSICS_STATE_DIR="$STATE_DIR"

# 读最后一条记录的某个 JSON 路径
lastrec() {
  python3 - "$LOG" "$1" <<'PY' 2>/dev/null
import json, sys
path = sys.argv[2].split(".")
try:
    line = [l for l in open(sys.argv[1], encoding="utf-8") if l.strip()][-1]
except Exception:
    sys.exit(1)
cur = json.loads(line)
for p in path:
    if isinstance(cur, list):
        cur = cur[int(p)]
    else:
        cur = cur.get(p)
    if cur is None:
        print("")
        sys.exit(0)
print(cur if not isinstance(cur, (dict, list)) else json.dumps(cur, ensure_ascii=False))
PY
}

reclines() { grep -c . "$LOG" 2>/dev/null | tr -d ' '; }

# 取文件权限（GNU/BSD stat 的 -f 语义相反，一律走 python，别赌哪个 stat 在 PATH 上）
permof() { python3 -c 'import os,sys;print(oct(os.stat(sys.argv[1]).st_mode & 0o777)[2:])' "$1" 2>/dev/null; }


echo "=== 席位死亡取证测试（沙箱 ${SANDBOX}）==="
echo

# ---------------------------------------------------------------------------
echo "[T0] 脚本存在且可执行"
# ---------------------------------------------------------------------------
[ -f "$SCRIPT" ] && ok "scripts/mesh-seat-forensics.sh 存在" || { bad "脚本不存在：$SCRIPT"; echo; echo "=== 结果: pass=$pass fail=$fail ==="; exit 1; }
[ -x "$SCRIPT" ] && ok "脚本有执行位" || bad "脚本没有执行位"

# ---------------------------------------------------------------------------
echo "[T1] death：落一条 JSONL 记录，含退出码/时间/session/nodeId"
# ---------------------------------------------------------------------------
bash "$SCRIPT" death \
  --session "mesh-t1-sess" --node-id "computer2:cc-t1" --short-id "cc-t1" \
  --role worker --launcher codex --pid "$$" --exit-code 137 >/dev/null 2>&1
rc=$?
[ "$rc" = "0" ] && ok "death 退出码 0（取证绝不把 wrapper 拖下水）" || bad "death exit=$rc"
[ -s "$LOG" ] && ok "日志文件已生成" || bad "日志文件没生成：$LOG"
[ "$(reclines)" = "1" ] && ok "恰好一行（JSONL）" || bad "行数=$(reclines)，应为 1"
[ "$(lastrec event)" = "death" ] && ok "event=death" || bad "event=$(lastrec event)"
[ "$(lastrec exit_code)" = "137" ] && ok "退出码入档" || bad "exit_code=$(lastrec exit_code)"
[ "$(lastrec session)" = "mesh-t1-sess" ] && ok "session 入档" || bad "session=$(lastrec session)"
[ "$(lastrec node_id)" = "computer2:cc-t1" ] && ok "nodeId 入档" || bad "node_id=$(lastrec node_id)"
[ -n "$(lastrec ts)" ] && ok "时间戳入档（$(lastrec ts)）" || bad "缺 ts"
[ -n "$(lastrec host)" ] && ok "主机名入档" || bad "缺 host"

# ---------------------------------------------------------------------------
echo "[T2] 退出码 → 信号推断（>128 视为被信号砍死）"
# ---------------------------------------------------------------------------
[ "$(lastrec signal)" = "KILL" ] && ok "137 → signal=KILL" || bad "137 推出来 signal=$(lastrec signal)"
[ "$(lastrec killed_by_signal)" = "True" ] && ok "killed_by_signal=true" || bad "killed_by_signal=$(lastrec killed_by_signal)"

bash "$SCRIPT" death --session s --pid "$$" --exit-code 129 >/dev/null 2>&1
[ "$(lastrec signal)" = "HUP" ] && ok "129 → signal=HUP（tmux kill-session 的签名）" || bad "129 推出来 signal=$(lastrec signal)"
bash "$SCRIPT" death --session s --pid "$$" --exit-code 0 >/dev/null 2>&1
[ "$(lastrec killed_by_signal)" = "False" ] && ok "exit 0 → 不是信号死" || bad "exit 0 被误判成信号死"

# ---------------------------------------------------------------------------
echo "[T3] 进程链：pane → wrapper → launcher 的 pid 链"
# ---------------------------------------------------------------------------
CHAIN="$(lastrec proc_chain)"
echo "$CHAIN" | grep -q '"pid"' && ok "proc_chain 有条目" || bad "proc_chain 为空：$CHAIN"
echo "$CHAIN" | grep -q "\"pid\": $$" && ok "链首是传入的 pid（$$）" || bad "链首不是 $$：$CHAIN"
echo "$CHAIN" | grep -q '"ppid"' && ok "每级带 ppid（链条串得起来）" || bad "缺 ppid"
echo "$CHAIN" | grep -q '"comm"' && ok "每级带进程名" || bad "缺 comm"
n="$(python3 -c 'import json,sys;print(len(json.loads(sys.argv[1])))' "$CHAIN" 2>/dev/null || echo 0)"
[ "${n:-0}" -ge 2 ] && ok "链至少 2 级（$n 级，一路走到 init）" || bad "链只有 ${n} 级"

# 🔴 命令行参数绝不入档（args 里可能有任务正文/密钥）
echo "$CHAIN" | grep -q '"args"\|"command"\|"cmdline"' && bad "proc_chain 记了完整命令行（泄漏面）" || ok "proc_chain 不记完整命令行（只记 comm）"

# ---------------------------------------------------------------------------
echo "[T4] 系统资源摘要：够判断是不是资源型死亡"
# ---------------------------------------------------------------------------
SYS="$(lastrec system)"
echo "$SYS" | grep -q 'load' && ok "system 含负载" || bad "system 缺 load：$SYS"
echo "$SYS" | grep -q 'mem_' && ok "system 含内存" || bad "system 缺内存：$SYS"
echo "$SYS" | grep -q 'proc_count' && ok "system 含进程总数" || bad "system 缺 proc_count"
echo "$SYS" | grep -q 'disk_free_mb' && ok "system 含磁盘余量（盘满也会杀进程）" || bad "system 缺 disk_free_mb"

# ---------------------------------------------------------------------------
echo "[T5] 🔴 脱敏真的生效：假 token / 邮箱 / Bearer 一个都不许落盘"
# ---------------------------------------------------------------------------
PANE="$SANDBOX/pane-secrets.txt"
cat > "$PANE" <<'PANEEOF'
$ curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.ZmFrZXBheWxvYWRmYWtl.c2lnbmF0dXJlZmFrZQ" https://api.example.com # gitleaks:allow -- synthetic redaction fixture
export ANTHROPIC_API_KEY=sk-ant-api03-FAKEFAKEfakefake0123456789abcdefghijklmnopqrstuvwxyzAA
GITHUB_TOKEN=ghp_FAKE0123456789abcdefghijABCDEFGHIJ
联系人 aster.test@example.com 已通知
password=hunter2SuperSecretValue99
db url: postgres://dbuser:dbSecretPass99@db.internal:5432/mesh
指纹 3f7a9c1b2d4e6f8a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a
AWS key AKIAIOSFODNN7EXAMPLE 已轮换
手机号 13800138000 待核
MY_CUSTOM_TOKEN=zzTopSecretNoKnownPrefixHere
无名长随机串 Qx7bK2mNp9vRt4wZ8cLf3jHd
[ERROR] tmux pane vanished, seat died
PANEEOF
export MESH_TEST_PANE_FILE="$PANE"

: > "$LOG"
MESH_FORENSICS_PANE_LINES=40 bash "$SCRIPT" death \
  --session "mesh-t5" --node-id "computer2:cc-t5" --pid "$$" --exit-code 137 >/dev/null 2>&1

leaked=0
check_absent() {
  if grep -qF "$1" "$LOG" 2>/dev/null; then bad "泄漏：$2 原文落盘了"; leaked=1
  else ok "已剔除：$2"; fi
}
check_absent "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" "JWT / Bearer token"
check_absent "sk-ant-api03-FAKEFAKEfakefake0123456789abcdefghijklmnopqrstuvwxyzAA" "sk-ant API key"
check_absent "ghp_FAKE0123456789abcdefghijABCDEFGHIJ" "GitHub PAT"
check_absent "aster.test@example.com" "邮箱"
check_absent "hunter2SuperSecretValue99" "password= 赋值"
check_absent "dbSecretPass99" "URL 内嵌口令"
check_absent "3f7a9c1b2d4e6f8a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a" "长随机 hex 串"
check_absent "AKIAIOSFODNN7EXAMPLE" "AWS access key id"
check_absent "13800138000" "长数字串（手机号/卡号）"
# 下划线拼接的环境变量名（\b 在 `_TOKEN` 前不成立，最常见的泄漏形态）
check_absent "zzTopSecretNoKnownPrefixHere" "下划线环境变量赋值（MY_CUSTOM_TOKEN=）"
# 既无已知前缀、也无关键字提示的裸随机串，只能靠泛化启发式兜住
check_absent "Qx7bK2mNp9vRt4wZ8cLf3jHd" "无名长随机串（24 字符字母数字混排）"

# 脱敏不能把整段吃光——非敏感的报错行必须留着，否则取证没意义
grep -q "tmux pane vanished" "$LOG" && ok "非敏感报错行保留（取证仍有价值）" || bad "脱敏过头，连报错行都没了"
grep -q "REDACTED" "$LOG" && ok "留下 [REDACTED] 痕迹（能看出剔过什么）" || bad "没有脱敏痕迹标记"
[ "$(lastrec redacted)" = "True" ] && ok "记录自述 redacted=true" || bad "redacted=$(lastrec redacted)"
hits="$(lastrec redaction_hits)"
[ "${hits:-0}" -ge 8 ] && ok "redaction_hits=${hits}（命中数可审计）" || bad "redaction_hits=${hits}，太少"

# ---------------------------------------------------------------------------
echo "[T6] pane 尾部有限行 + 单行限长"
# ---------------------------------------------------------------------------
python3 -c 'print("\n".join("line-%d %s" % (i, "x"*400) for i in range(500)))' > "$SANDBOX/pane-long.txt"
export MESH_TEST_PANE_FILE="$SANDBOX/pane-long.txt"
: > "$LOG"
MESH_FORENSICS_PANE_LINES=12 MESH_FORENSICS_PANE_LINE_CHARS=80 \
  bash "$SCRIPT" death --session "mesh-t6" --pid "$$" --exit-code 1 >/dev/null 2>&1
n="$(python3 -c 'import json,sys;print(len(json.loads(sys.argv[1])))' "$(lastrec pane_tail)" 2>/dev/null || echo -1)"
[ "$n" = "12" ] && ok "pane_tail 恰好 12 行（有限行）" || bad "pane_tail 行数=${n}，应为 12"
maxlen="$(python3 -c 'import json,sys;print(max((len(x) for x in json.loads(sys.argv[1])), default=0))' "$(lastrec pane_tail)" 2>/dev/null || echo 9999)"
[ "${maxlen:-9999}" -le 80 ] && ok "单行 ≤80 字符（截断生效，maxlen=${maxlen}）" || bad "单行超限：$maxlen"
grep -q "line-499" "$LOG" && ok "取的是尾部（最后一行在）" || bad "取的不是尾部"
grep -q "line-0 " "$LOG" && bad "把开头也捞进来了" || ok "开头没捞（只要尾部）"

# PANE_LINES=0 → 整段不采
: > "$LOG"
MESH_FORENSICS_PANE_LINES=0 bash "$SCRIPT" death --session "mesh-t6b" --pid "$$" --exit-code 1 >/dev/null 2>&1
[ "$(lastrec pane_tail)" = "[]" ] && ok "PANE_LINES=0 → 完全不采 pane（最保守档可用）" || bad "PANE_LINES=0 还是采了：$(lastrec pane_tail)"

# ---------------------------------------------------------------------------
echo "[T7] 文件权限 600"
# ---------------------------------------------------------------------------
perm="$(permof "$LOG")"
[ "$perm" = "600" ] && ok "seat-deaths.log 权限 600" || bad "权限=${perm}，应为 600"

# 即使被人改成 644，下次写入要纠回来
chmod 644 "$LOG"
bash "$SCRIPT" death --session "mesh-t7" --pid "$$" --exit-code 1 >/dev/null 2>&1
perm="$(permof "$LOG")"
[ "$perm" = "600" ] && ok "权限被改宽后自动纠回 600" || bad "没纠回来，权限=$perm"

# ---------------------------------------------------------------------------
echo "[T8] 轮转：不无限增长，代数封顶，轮转文件同样 600"
# ---------------------------------------------------------------------------
rm -f "$LOG" "$LOG".*
export MESH_TEST_PANE_FILE="$PANE"
for i in $(seq 1 24); do
  MESH_FORENSICS_MAX_BYTES=2000 MESH_FORENSICS_KEEP=3 MESH_FORENSICS_PANE_LINES=20 \
    bash "$SCRIPT" death --session "mesh-t8-$i" --pid "$$" --exit-code 1 >/dev/null 2>&1
done
[ -f "$LOG.1" ] && ok "轮转发生（.1 存在）" || bad "没轮转"
[ -f "$LOG.3" ] && ok "保留到 .3" || note ".3 不存在（写入量不够，非失败）"
[ -f "$LOG.4" ] && bad "超出 KEEP=3 还留着 .4（会无限增长）" || ok "代数封顶（无 .4）"
size="$(wc -c < "$LOG" | tr -d ' ')"
[ "$size" -lt 12000 ] && ok "活动文件被压在阈值附近（${size}B）" || bad "活动文件涨到 ${size}B，轮转没起作用"
if [ -f "$LOG.1" ]; then
  perm="$(permof "$LOG.1")"
  [ "$perm" = "600" ] && ok "轮转文件也是 600" || bad "轮转文件权限=$perm"
fi

# ---------------------------------------------------------------------------
echo "[T9] birth 记录：出生就留档，死时能算寿命"
# ---------------------------------------------------------------------------
rm -f "$LOG" "$LOG".*
bash "$SCRIPT" birth --session "mesh-t9" --node-id "computer2:cc-t9" --short-id cc-t9 \
  --role worker --launcher codex --pid "$$" --desc "mesh-worker" >/dev/null 2>&1
[ "$(lastrec event)" = "birth" ] && ok "event=birth" || bad "event=$(lastrec event)"
[ -f "$STATE_DIR/mesh-t9.json" ] && ok "出生态落到 state 目录" || bad "state 文件没生成"
sperm="$(permof "$STATE_DIR/mesh-t9.json")"
[ "$sperm" = "600" ] && ok "state 文件也是 600" || bad "state 权限=$sperm"
sleep 1
bash "$SCRIPT" death --session "mesh-t9" --node-id "computer2:cc-t9" --pid "$$" --exit-code 143 >/dev/null 2>&1
up="$(lastrec uptime_s)"
[ -n "$up" ] && [ "$up" != "None" ] && [ "${up%.*}" -ge 1 ] && ok "死时算得出寿命（uptime_s=${up}）" || bad "uptime_s=$up"

# ---------------------------------------------------------------------------
echo "[T10] reaper：SIGKILL 打死 wrapper（trap 根本不跑）也留下记录"
# ---------------------------------------------------------------------------
rm -f "$LOG" "$LOG".*
sleep 120 &
VICTIM_PID=$!
MESH_FORENSICS_REAP_INTERVAL_S=1 \
  bash "$SCRIPT" reap --session "mesh-t10" --node-id "computer2:cc-t10" --pid "$VICTIM_PID" \
  >/dev/null 2>&1 &
REAPER_PID=$!
sleep 1
kill -9 "$VICTIM_PID" 2>/dev/null
VICTIM_PID=""
for _ in $(seq 1 30); do [ -s "$LOG" ] && break; sleep 0.5; done
if [ -s "$LOG" ]; then
  ok "SIGKILL 后 reaper 补了一条记录"
  [ "$(lastrec death_kind)" = "untrapped" ] && ok "标记 death_kind=untrapped（trap 没跑过）" || bad "death_kind=$(lastrec death_kind)"
  [ "$(lastrec session)" = "mesh-t10" ] && ok "记录带正确 session" || bad "session=$(lastrec session)"
else
  bad "SIGKILL 后没有任何记录（取证漏掉最关键的一类死亡）"
fi
wait "$REAPER_PID" 2>/dev/null
REAPER_PID=""

# ---------------------------------------------------------------------------
echo "[T11] reaper：trap 已经写过了就别重复写"
# ---------------------------------------------------------------------------
rm -f "$LOG" "$LOG".*
sleep 120 &
VICTIM2_PID=$!
MESH_FORENSICS_REAP_INTERVAL_S=1 \
  bash "$SCRIPT" reap --session "mesh-t11" --pid "$VICTIM2_PID" >/dev/null 2>&1 &
REAPER2_PID=$!
sleep 1
# 模拟 trap 正常跑完：写死亡记录（会打 reaped 标）
bash "$SCRIPT" death --session "mesh-t11" --pid "$VICTIM2_PID" --exit-code 0 >/dev/null 2>&1
kill -TERM "$VICTIM2_PID" 2>/dev/null
VICTIM2_PID=""
for _ in $(seq 1 30); do kill -0 "$REAPER2_PID" 2>/dev/null || break; sleep 0.5; done
kill -0 "$REAPER2_PID" 2>/dev/null && { kill -9 "$REAPER2_PID" 2>/dev/null; bad "reaper 不退出"; } || ok "reaper 认标退出"
REAPER2_PID=""
[ "$(reclines)" = "1" ] && ok "只有 trap 那一条，reaper 没重复写" || bad "记录 $(reclines) 条，重复了"

# ---------------------------------------------------------------------------
echo "[T12] 绝不把 wrapper 拖下水：任何异常都 exit 0 且不抛"
# ---------------------------------------------------------------------------
MESH_FORENSICS_LOG="/proc/nonexistent/nope.log" bash "$SCRIPT" death --session x --pid "$$" --exit-code 1 >/dev/null 2>&1
[ "$?" = "0" ] && ok "日志路径不可写 → 仍 exit 0" || bad "不可写路径把脚本搞崩了"
bash "$SCRIPT" death >/dev/null 2>&1
[ "$?" = "0" ] && ok "参数全缺 → 仍 exit 0" || bad "缺参数把脚本搞崩了"
bash "$SCRIPT" bogus-subcommand >/dev/null 2>&1
[ "$?" = "0" ] && ok "未知子命令 → 仍 exit 0" || bad "未知子命令非 0"

# MESH_FORENSICS=0 全局关停
rm -f "$LOG"
MESH_FORENSICS=0 bash "$SCRIPT" death --session x --pid "$$" --exit-code 1 >/dev/null 2>&1
[ ! -f "$LOG" ] && ok "MESH_FORENSICS=0 → 一个字节都不落" || bad "关停开关无效"

# ---------------------------------------------------------------------------
echo "[T13] wrapper 接线（静态检查）"
# ---------------------------------------------------------------------------
[ -f "$WRAPPER" ] || bad "wrapper 不存在"
grep -q "mesh-seat-forensics.sh" "$WRAPPER" && ok "wrapper 引用了取证脚本" || bad "wrapper 没接取证"
# HUP 是 tmux kill-session / kill-server 的默认信号；不 trap 它 = 注册记录变僵尸
grep -qE "^trap .*\bHUP\b" "$WRAPPER" && ok "wrapper trap 了 HUP（tmux kill-session 走这条）" || bad "wrapper 没 trap HUP —— 僵尸注册的老路"
grep -qE "^trap .*\bTERM\b" "$WRAPPER" && ok "wrapper trap 了 TERM" || bad "wrapper 没 trap TERM"
grep -q "forensics" "$WRAPPER" && ok "wrapper 有取证调用点" || bad "wrapper 无取证调用点"
# ---------------------------------------------------------------------------
echo "[T14] 取证绝不炸 wrapper（行为测试，不是眼看 grep）"
# ---------------------------------------------------------------------------
# 手法：把 wrapper 里的 forensics() 函数原样抠出来，喂一个必崩的取证脚本，在 set -e 下调用
FXFN="$SANDBOX/fxfn.sh"
python3 - "$WRAPPER" "$FXFN" <<'EXTRACT'
import sys
src = open(sys.argv[1], encoding="utf-8").read().splitlines()
start = next(i for i, l in enumerate(src) if l.startswith("forensics() {"))
end = next(i for i in range(start + 1, len(src)) if src[i] == "}")
open(sys.argv[2], "w", encoding="utf-8").write("\n".join(src[start:end + 1]) + "\n")
EXTRACT
if [ -s "$FXFN" ]; then
  ok "从 wrapper 抠出 forensics() 函数体"
  BOOM="$SANDBOX/boom.sh"
  printf '#!/usr/bin/env bash\nexit 42\n' > "$BOOM"; chmod +x "$BOOM"
  {
    echo 'set -euo pipefail'
    echo "FORENSICS_SCRIPT=\"$BOOM\""
    cat "$FXFN"
    echo 'forensics death --session x'
    echo 'echo SURVIVED'
  } > "$SANDBOX/fxharness.sh"
  out="$(bash "$SANDBOX/fxharness.sh" 2>/dev/null)"
  [ "$out" = "SURVIVED" ] && ok "取证脚本 exit 42 也不炸 wrapper（set -e 下活着走完）" || bad "取证失败把 wrapper 带崩了（out=$out）"
  {
    echo 'set -euo pipefail'
    echo "FORENSICS_SCRIPT=\"$SANDBOX/does-not-exist.sh\""
    cat "$FXFN"
    echo 'forensics death --session x'
    echo 'echo SURVIVED'
  } > "$SANDBOX/fxharness2.sh"
  out2="$(bash "$SANDBOX/fxharness2.sh" 2>/dev/null)"
  [ "$out2" = "SURVIVED" ] && ok "取证脚本缺失也不炸 wrapper" || bad "缺脚本把 wrapper 带崩了（out=$out2）"
else
  bad "抠不出 forensics() 函数体"
fi

# ---------------------------------------------------------------------------
echo "[T15] 真跑一遍 wrapper：birth + death 都落档，且注销照常"
# ---------------------------------------------------------------------------
# 安全边界：假 curl（不打任何端口）+ 不存在的 launcher（launcher_cmd 返 1 → bash -lc ""
# 空跑，**绝不会真起 claude/codex**）+ 不在 tmux 内（不建、不杀任何 tmux 会话）。
rm -f "$LOG" "$LOG".*
rm -rf "$STATE_DIR"
CURLLOG="$SANDBOX/curl.log"
cat > "$FAKEBIN/curl" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MESH_TEST_CURL_LOG"
for a in "$@"; do
  [ "$a" = "DELETE" ] && exit 0
done
printf '{"ok":true,"data":{"nodeId":"fxtest:cc-w1"}}\n'
SH
chmod +x "$FAKEBIN/curl"
export MESH_TEST_CURL_LOG="$CURLLOG"
: > "$CURLLOG"

WRAPOUT="$SANDBOX/wrapper.out"
( unset TMUX ITERM_SESSION_ID
  MESH_SHORT_ID="cc-w1" \
  MESH_SESSION_ID="mesh-fxtest" \
  MESH_RELAY_URL="http://127.0.0.1:1" \
  MESH_FORENSICS_LOG="$LOG" \
  MESH_FORENSICS_STATE_DIR="$STATE_DIR" \
  MESH_FORENSICS_REAP_INTERVAL_S=1 \
  bash "$WRAPPER" worker "fx-test-seat" "$SANDBOX" bogus-launcher
) > "$WRAPOUT" 2>&1
wrc=$?
[ "$wrc" = "0" ] && ok "wrapper 走完并正常退出（rc=0）" || bad "wrapper rc=$wrc（取证接线把它搞坏了）"
grep -q "已注册节点: fxtest:cc-w1" "$WRAPOUT" && ok "注册流程没被破坏" || bad "注册流程坏了：$(head -3 "$WRAPOUT")"
grep -q "死亡取证已挂载" "$WRAPOUT" && ok "取证挂载信息可见（运维看得到）" || bad "没打取证挂载信息"
grep -q "DELETE" "$CURLLOG" && ok "退出仍会注销（僵尸注册不复现）" || bad "退出没注销"

births="$(grep -c '"event": "birth"' "$LOG" 2>/dev/null | tr -d ' ')"
deaths="$(grep -c '"event": "death"' "$LOG" 2>/dev/null | tr -d ' ')"
[ "${births:-0}" = "1" ] && ok "birth 记录 1 条" || bad "birth=${births:-0} 条"
[ "${deaths:-0}" = "1" ] && ok "death 记录 1 条（trap 真的跑了）" || bad "death=${deaths:-0} 条"
[ "$(lastrec node_id)" = "fxtest:cc-w1" ] && ok "死亡档带真实 nodeId（对得上 relay 注册表）" || bad "node_id=$(lastrec node_id)"
[ "$(lastrec death_kind)" = "trapped" ] && ok "death_kind=trapped" || bad "death_kind=$(lastrec death_kind)"
[ "$(lastrec launcher)" = "bogus-launcher" ] && ok "launcher 入档" || bad "launcher=$(lastrec launcher)"
[ -n "$(lastrec uptime_s)" ] && ok "寿命算得出（birth↔death 串上了）" || bad "缺 uptime_s"
# 守尸人不许赖着不走
sleep 3
lingering="$(pgrep -f "mesh-seat-forensics.sh reap --session mesh-fxtest" 2>/dev/null | wc -l | tr -d ' ')"
[ "${lingering:-0}" = "0" ] && ok "守尸人已收（不留孤儿进程）" || { pkill -f "mesh-seat-forensics.sh reap --session mesh-fxtest" 2>/dev/null; bad "守尸人还赖着 ${lingering} 个"; }
rm -f "$FAKEBIN/curl"

# ---------------------------------------------------------------------------
echo "[MUT] 变异测试：把脱敏摘掉 → T5 必须变红"
# ---------------------------------------------------------------------------
MUT="$SANDBOX/mutant.sh"
# 变异手法：让 redact() 直接返回原文（等价于关掉脱敏）
python3 - "$SCRIPT" "$MUT" <<'PY'
import re, sys
src = open(sys.argv[1], encoding="utf-8").read()
mutated = src.replace("def redact(text):", "def redact(text):\n    return text, 0  # MUTANT: 脱敏摘除", 1)
assert mutated != src, "变异点没找到——redact() 的签名变了，测试需要跟着改"
open(sys.argv[2], "w", encoding="utf-8").write(mutated)
PY
if [ -f "$MUT" ]; then
  MUTLOG="$SANDBOX/mutant.log"
  rm -f "$MUTLOG"
  export MESH_TEST_PANE_FILE="$PANE"
  MESH_FORENSICS_LOG="$MUTLOG" MESH_FORENSICS_PANE_LINES=40 \
    bash "$MUT" death --session "mut" --pid "$$" --exit-code 137 >/dev/null 2>&1
  mleak=0
  for s in "sk-ant-api03-FAKEFAKEfakefake0123456789abcdefghijklmnopqrstuvwxyzAA" \
           "aster.test@example.com" \
           "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"; do
    grep -qF "$s" "$MUTLOG" 2>/dev/null && mleak=$(( mleak + 1 ))
  done
  [ "$mleak" = "3" ] && ok "变异体泄漏 3/3 敏感串 → 证明 T5 测的是脱敏本身，不是空断言" \
    || bad "变异体只泄漏 $mleak/3 —— T5 可能是假绿（fixture 无效或变异没生效）"
else
  bad "变异体没生成"
fi

echo
echo "=== 结果: pass=$pass fail=$fail ==="
[ "$fail" = "0" ] || exit 1
