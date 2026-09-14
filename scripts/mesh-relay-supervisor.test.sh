#!/usr/bin/env bash
# mesh-relay-supervisor.sh 的验收测试。
#
# 全程对着一个**假 relay**跑：独立 tmux server（MESH_SUPERVISOR_TMUX_TMPDIR）、
# 独立端口上的假 /api/status、独立 pid 文件、假 mesh CLI。
# 真 relay 与真席位一根汗毛都不碰 —— 并且末尾会**核对**这一点。
#
# （P0 纪律：不在默认 tmux server 上跑 relay 相关的全量测试。这里连假 relay 都关在隔离 server 里。）
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUP="$HERE/mesh-relay-supervisor.sh"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "期望[$3] 实际[$2]"; fi; }
has()  { if printf '%s' "$2" | grep -q "$3"; then ok "$1"; else bad "$1" "输出里找不到 $3：${2:0:200}"; fi; }
hasnt(){ if printf '%s' "$2" | grep -q "$3"; then bad "$1" "不该出现却出现了：$3"; else ok "$1"; fi; }

# ── 基线：真 relay / 真席位现状，收尾逐字比对 ──
baseline_sessions="$(tmux list-sessions -F '#{session_name}' 2>/dev/null | sort | tr '\n' ',')"
baseline_relay=""
[ -f "$HOME/.ccmesh/relay.pid" ] && baseline_relay="$(ps -p "$(cat "$HOME/.ccmesh/relay.pid")" -o lstart= 2>/dev/null)"

ISO="$(mktemp -d /tmp/relsup-iso-XXXX)"
BOX="$(mktemp -d /tmp/relsup-box-XXXX)"
PORT=$(( 21000 + ($$ % 3000) ))
FAKE_SESSION="test-relay-$$"

cleanup() {
  TMUX_TMPDIR="$ISO" tmux kill-server 2>/dev/null
  [ -f "$BOX/http.pid" ] && kill "$(cat "$BOX/http.pid")" 2>/dev/null
  rm -rf "$ISO" "$BOX"
}
trap cleanup EXIT

mkdir -p "$BOX/ccmesh"

# ── 假 HTTP：可以被开关，用来造「进程在但服务不通」的 hung 形态 ──
cat > "$BOX/fakehttp.py" <<'PY'
import http.server, json, sys
PORT = int(sys.argv[1])
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/api/status"):
            body = json.dumps({"data": {"nodes": [{"id": "n1"}, {"id": "n2"}], "uplink": "connected"}}).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
        else:
            self.send_response(404); self.end_headers()
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", PORT), H).serve_forever()
PY

start_fake_http() { python3 "$BOX/fakehttp.py" "$PORT" & echo $! > "$BOX/http.pid"; sleep 1; }
stop_fake_http()  { [ -f "$BOX/http.pid" ] && { kill "$(cat "$BOX/http.pid")" 2>/dev/null; rm -f "$BOX/http.pid"; sleep 0.5; }; }

# ── 假 relay 进程：住在隔离 tmux server 的一个 session 里 ──
# pane 里故意写一句**含密钥形态的文本**，用来验「落档前真的脱敏了」。
start_fake_relay() {
  TMUX_TMPDIR="$ISO" tmux new-session -d -s "$FAKE_SESSION" \
    "echo 'ANTHROPIC_API_KEY=sk-ant-FAKEKEY0123456789abcdef'; echo 'relay listening'; sleep 600"
  sleep 1
  TMUX_TMPDIR="$ISO" tmux list-panes -t "$FAKE_SESSION" -F '#{pane_pid}' 2>/dev/null | head -1 > "$BOX/ccmesh/relay.pid"
}
kill_fake_relay() {
  local p; p="$(cat "$BOX/ccmesh/relay.pid" 2>/dev/null)"
  [ -n "$p" ] && kill -9 "$p" 2>/dev/null
  TMUX_TMPDIR="$ISO" tmux kill-session -t "$FAKE_SESSION" 2>/dev/null
  sleep 0.5
}

# ── 假 mesh CLI：只认 `relay start`，行为 = 重新拉起假 relay ──
cat > "$BOX/fake-mesh.sh" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "relay" ] && [ "\$2" = "start" ]; then
  TMUX_TMPDIR="$ISO" tmux new-session -d -s "$FAKE_SESSION" "echo relay-restarted; sleep 600" 2>/dev/null
  sleep 1
  TMUX_TMPDIR="$ISO" tmux list-panes -t "$FAKE_SESSION" -F '#{pane_pid}' 2>/dev/null | head -1 > "$BOX/ccmesh/relay.pid"
  echo "$(date +%s)" >> "$BOX/started.log"
fi
EOF
chmod +x "$BOX/fake-mesh.sh"

DEATHS="$BOX/ccmesh/relay-deaths.log"

run_sup() {
  MESH_SUPERVISOR_TMUX_TMPDIR="$ISO" \
  CCMESH_DIR="$BOX/ccmesh" \
  MESH_RELAY_PID_FILE="$BOX/ccmesh/relay.pid" \
  MESH_RELAY_SESSION="$FAKE_SESSION" \
  MESH_RELAY_URL="http://127.0.0.1:$PORT" \
  MESH_RELAY_DEATHS_LOG="$DEATHS" \
  MESH_CLI="$BOX/fake-mesh.sh" \
  MESH_RELAY_BACKOFF_BASE_S="${BACKOFF_BASE:-0}" \
  MESH_RELAY_BREAKER_MAX="${BREAKER_MAX:-6}" \
  MESH_RELAY_HUNG_TICKS="${HUNG_TICKS:-3}" \
    bash "$SUP" "$@" 2>&1
}

echo "== 0. 隔离自检（不先证隔离，后面的绿都不算数）=="
start_fake_http
start_fake_relay
out="$(run_sup probe)"
has "监督器看到的是假 relay 不是真的" "$out" "判决         : alive"
real_pid="$(cat "$HOME/.ccmesh/relay.pid" 2>/dev/null)"
fake_pid="$(cat "$BOX/ccmesh/relay.pid")"
if [ "$real_pid" != "$fake_pid" ]; then ok "假 relay pid($fake_pid) ≠ 真 relay pid($real_pid)"; else bad "指到真 relay 上了" ""; fi

echo "== 1. alive → 不记档、不恢复 =="
run_sup ensure >/dev/null 2>&1
check "alive 时不产生死亡档" "$([ -f "$DEATHS" ] && wc -l < "$DEATHS" | tr -d ' ' || echo 0)" "0"
check "alive 时没调用恢复" "$([ -f "$BOX/started.log" ] && wc -l < "$BOX/started.log" | tr -d ' ' || echo 0)" "0"

echo "== 2. dead → **先取证再恢复**，且恢复走既有 CLI 路径 =="
kill_fake_relay
out="$(run_sup ensure)"
check "写了 1 条死亡档" "$([ -f "$DEATHS" ] && wc -l < "$DEATHS" | tr -d ' ' || echo 0)" "1"
check "调用了既有启动路径" "$([ -f "$BOX/started.log" ] && wc -l < "$BOX/started.log" | tr -d ' ' || echo 0)" "1"
rec="$(tail -1 "$DEATHS")"
has "死亡档记了判据 signals"      "$rec" '"signals"'
# 🔴 这条是「取证必须发生在恢复之前」的**直接判据**，不是靠外部顺序假设。
#    若取证被挪到 recover 之后，那时 pid 文件已经指向新进程、偏差为 null ——
#    档还在、键还在，但内容变成了「恢复后的状态」，等于什么都没记下来。
#    所以不能只断言键存在，要断言它**记住了当时那个死状**。
if printf '%s' "$rec" | python3 -c 'import json,sys
d=json.load(sys.stdin).get("pid_file_discrepancy")
sys.exit(0 if isinstance(d,str) and "该进程不存在" in d else 1)' 2>/dev/null; then
  ok "pid 文件偏差记的是死时状态（证明取证早于恢复）"
else
  bad "pid 文件偏差不是死时状态——取证可能被挪到了恢复之后" "$rec"
fi
has "死亡档记了资源摘要"          "$rec" '"resources"'
has "死亡档显式声明未采集项"      "$rec" '"not_collected"'
# ⚠️ 不能直接 grep "argv"：not_collected 列表里**本来就写着** argv
#    （那是"我们故意没采它"的声明，不是采到的数据）。要找的是 argv 作为**键**出现。
if printf '%s' "$rec" | python3 -c 'import json,sys
r=json.load(sys.stdin)
def keys(o,acc):
    if isinstance(o,dict):
        for k,v in o.items(): acc.add(k); keys(v,acc)
    elif isinstance(o,list):
        for v in o: keys(v,acc)
    return acc
bad = keys(r,set()) & {"argv","cmdline","env","command_line"}
sys.exit(1 if bad else 0)' 2>/dev/null; then
  ok "死亡档里没有 argv/env/cmdline 这类键"
else
  bad "死亡档里出现了 argv/env/cmdline 键" "$rec"
fi

echo "== 3. 🔴 pane 落档前必须脱敏 =="
# ⚠️ 这组曾经是**假绿**：原来放在 §2 之后验，而 §2 里 kill_fake_relay 把 tmux session 也杀了，
#    record_death 根本抓不到 pane（pane_tail 恒为 []）——于是它在断言一个
#    **从来不会出现**的密钥不出现，删掉脱敏调用也照样绿。
#    改成走 hung 路径：进程活着、session 活着、只是 HTTP 不通，pane 必然被抓到。
rm -f "$BOX/ccmesh/relay-supervisor/"* 2>/dev/null; : > "$DEATHS"; : > "$BOX/started.log"
# 🔴 必须先杀干净再建：§2 的恢复用假 CLI 重建过同名 session（内容只有 relay-restarted），
#    而 `tmux new-session -s <已存在的名字>` 会**直接失败**，start_fake_relay 就成了 no-op ——
#    于是带密钥的 pane 压根没建出来，脱敏断言又变成在验一个不存在的东西。
#    （这一条就是被上面那句「确实抓到了 pane」的断言顶出来的。）
kill_fake_relay
start_fake_relay          # pane 里有 ANTHROPIC_API_KEY=sk-ant-FAKEKEY...
run_sup ensure >/dev/null 2>&1        # 记下 observed，避免被判成外部重启
stop_fake_http
HUNG_TICKS=1 BACKOFF_BASE=0 run_sup ensure >/dev/null 2>&1   # 门槛设 1，本 tick 就记档
start_fake_http

lines="$(python3 -c 'import json,sys
tot=0
for l in open(sys.argv[1]):
    l=l.strip()
    if not l: continue
    try: tot+=json.loads(l).get("pane_tail_lines",0)
    except Exception: pass
print(tot)' "$DEATHS" 2>/dev/null || echo 0)"
if [ "${lines:-0}" -gt 0 ]; then
  ok "死亡档里确实抓到了 pane（${lines} 行）—— 脱敏断言才有意义"
else
  bad "死亡档里 pane 是空的" "脱敏断言会假绿：它在验一个不存在的东西"
fi
allrec="$(cat "$DEATHS")"
hasnt "死亡档里没有明文密钥" "$allrec" "sk-ant-FAKEKEY"
hasnt "死亡档里没有明文赋值" "$allrec" "ANTHROPIC_API_KEY=sk-ant"
has  "确实经过脱敏（有 REDACTED 标记）" "$allrec" "REDACTED"

echo "== 4. 死亡档权限必须 0600 =="
if [ -f "$DEATHS" ]; then
  # 本机 PATH 里 coreutils 在前，`stat` 是 GNU 版 —— BSD 的 `-f '%Lp'` 在它那里
  # 是"显示文件系统状态"，会吐一堆 File:/ID:/Namelen: 出来。用 python 取，绕开两版差异。
  mode="$(python3 -c 'import os,sys; print(oct(os.stat(sys.argv[1]).st_mode & 0o777)[2:])' "$DEATHS" 2>/dev/null)"
  check "死亡档 mode" "$mode" "600"
fi

echo "== 5. hung（进程在、HTTP 不通）→ 不到门槛不动手 =="
rm -f "$BOX/ccmesh/relay-supervisor/"* 2>/dev/null; : > "$DEATHS"; : > "$BOX/started.log"
run_sup ensure >/dev/null 2>&1     # 先记下当前 observed，避免被判成 restarted-externally
stop_fake_http
out1="$(HUNG_TICKS=3 run_sup ensure)"; out2="$(HUNG_TICKS=3 run_sup ensure)"
has "第 1 次 hung 只计数不动手" "$out1" "未达 3 次门槛"
check "未达门槛时没恢复" "$(wc -l < "$BOX/started.log" | tr -d ' ')" "0"
out3="$(HUNG_TICKS=3 run_sup ensure)"
hasnt "第 3 次不再说「未达门槛」" "$out3" "未达 3 次门槛"
start_fake_http

echo "== 6. restarted-externally → 只记档不干预 =="
rm -f "$BOX/ccmesh/relay-supervisor/"* 2>/dev/null; : > "$DEATHS"; : > "$BOX/started.log"
run_sup ensure >/dev/null 2>&1                 # 记下当前 observed
kill_fake_relay
bash "$BOX/fake-mesh.sh" relay start           # 「别人」把它拉起来了
: > "$BOX/started.log"                         # 这一次不算监督器的恢复
out="$(run_sup ensure)"
has "识别为外部重启" "$out" "已被外部重启"
check "只记档一条" "$(wc -l < "$DEATHS" | tr -d ' ')" "1"
check "没有触发恢复" "$(wc -l < "$BOX/started.log" | tr -d ' ')" "0"
has "记档 event 是 restarted-externally" "$(tail -1 "$DEATHS")" 'restarted-externally'

echo "== 7. 退避：刚恢复过就再死，本 tick 不重复恢复 =="
rm -f "$BOX/ccmesh/relay-supervisor/"* 2>/dev/null; : > "$DEATHS"; : > "$BOX/started.log"
run_sup ensure >/dev/null 2>&1
kill_fake_relay
BACKOFF_BASE=3600 run_sup ensure >/dev/null 2>&1      # 第一次恢复
kill_fake_relay
out="$(BACKOFF_BASE=3600 run_sup ensure)"
has "第二次落进退避" "$out" "退避中"

echo "== 8. 🔴 熔断：窗口内超上限就停手（禁止无限看门狗掩盖根因）=="
rm -f "$BOX/ccmesh/relay-supervisor/"* 2>/dev/null; : > "$DEATHS"
kill_fake_relay; start_fake_relay
run_sup ensure >/dev/null 2>&1        # 预热：记下 observed（这一步本身可能也恢复一次）
: > "$BOX/started.log"                # 计数从这里开始，别把预热那次算进去
# 🔴 判据必须落在**触发熔断的那一 tick 之内**。
#    先前写成「循环跑完后再取基线」，那时多出来的那次恢复已经计入基线了 ——
#    于是把 `breaker_check_and_record || return 0` 的闸拆掉（当轮照样恢复），
#    测试**照样全绿**（实测溜过去了）。
#    真正的discriminator：熔断那一 tick，恢复次数不得增加。
tripped=""; trip_grew=""
for i in 1 2 3 4 5 6 7 8; do
  kill_fake_relay
  before_n="$(wc -l < "$BOX/started.log" | tr -d ' ')"
  o="$(BACKOFF_BASE=0 BREAKER_MAX=3 run_sup ensure)"
  after_n="$(wc -l < "$BOX/started.log" | tr -d ' ')"
  if printf '%s' "$o" | grep -q '熔断'; then
    tripped="$i"
    [ "$before_n" != "$after_n" ] && trip_grew="$before_n→$after_n"
    break
  fi
done
if [ -n "$tripped" ]; then ok "第 ${tripped} 轮触发熔断（上限 3）"; else bad "熔断没触发——看门狗会无限重启" "$o"; fi
if [ -z "$trip_grew" ]; then
  ok "熔断那一 tick 本身就没再恢复"
else
  bad "熔断那一 tick 仍然恢复了一次（$trip_grew）" "闸只是「下一轮才拦」，等于当轮漏了一次重启"
fi
# 🔴 最硬的那条判据：**总恢复次数不得超过上限**。
#    上面那条按「日志里出现熔断」定位触发时刻，是可以被绕过的 ——
#    把 breaker_check_and_record 的输出重定向掉，熔断日志就不出现在那一 tick，
#    判据整个错位到下一 tick，于是拆了闸也全绿（实测漏掉过两次）。
#    总次数不依赖日志、不依赖时序：闸真拆了，它必然多出一次。
total_rec="$(wc -l < "$BOX/started.log" | tr -d ' ')"
if [ "${total_rec:-0}" -le 3 ]; then
  ok "总恢复次数 ${total_rec} 未超上限 3"
else
  bad "总恢复次数 ${total_rec} 超过上限 3" "熔断闸没真正拦住——看门狗会掩盖根因"
fi
# ⚠️ 只断言日志里出现「熔断」是**不够**的：把 `breaker_check_and_record || return 0`
#    的 `|| return 0` 拆掉（即当轮不停手），下一 tick 顶部那道 breaker_tripped 仍会拦，
#    日志照样有「熔断」字样 —— 测试分辨不出，变异会溜过去（实测溜过去了）。
#    真正要盯的是**恢复次数不再增长**。
recoveries_at_trip="$(wc -l < "$BOX/started.log" | tr -d ' ')"
kill_fake_relay
out="$(BACKOFF_BASE=0 BREAKER_MAX=3 run_sup ensure)"
has "熔断后拒绝再恢复" "$out" "熔断已触发，不恢复"
check "熔断后恢复次数不再增长" "$(wc -l < "$BOX/started.log" | tr -d ' ')" "$recoveries_at_trip"
kill_fake_relay
BACKOFF_BASE=0 BREAKER_MAX=3 run_sup ensure >/dev/null 2>&1
check "再来一轮仍不恢复" "$(wc -l < "$BOX/started.log" | tr -d ' ')" "$recoveries_at_trip"

echo "== 9. 恢复后核对不得假称门铃已恢复 =="
rm -f "$BOX/ccmesh/relay-supervisor/"* 2>/dev/null; : > "$DEATHS"; : > "$BOX/started.log"
start_fake_http
run_sup ensure >/dev/null 2>&1
kill_fake_relay
out="$(BACKOFF_BASE=0 run_sup ensure)"
has "核对了节点表/uplink" "$out" "恢复后核对"
has "显式声明门铃不在职责内" "$out" "SSE 门铃"
hasnt "没有宣称门铃已恢复" "$out" "门铃已恢复"

echo "== 10. 🔴 真 relay / 真席位毫发无伤（本测试自己的验收）=="
now_sessions="$(tmux list-sessions -F '#{session_name}' 2>/dev/null | sort | tr '\n' ',')"
check "默认 server session 集合与基线逐字一致" "$now_sessions" "$baseline_sessions"
if [ -n "$baseline_relay" ]; then
  now_relay="$(ps -p "$(cat "$HOME/.ccmesh/relay.pid" 2>/dev/null)" -o lstart= 2>/dev/null)"
  check "真 relay 启动时刻逐字一致" "$now_relay" "$baseline_relay"
else
  echo "  skip 真 relay 未运行——环境不具备，不算通过"
fi

echo
echo "pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]
