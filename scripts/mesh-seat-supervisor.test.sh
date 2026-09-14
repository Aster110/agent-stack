#!/usr/bin/env bash
# mesh-seat-supervisor.sh 的验收测试。
#
# 全程关在**隔离 tmux server** 里跑（MESH_SUPERVISOR_TMUX_TMPDIR），
# 默认 server 上的真席位和 relay 一根汗毛都不碰 —— 并且最后会**核对**这一点，
# 不是嘴上保证。（本仓 2026-08-28 刚被「测试打死生产席位」教育过一次。）
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUP="$HERE/mesh-seat-supervisor.sh"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "期望[$3] 实际[$2]"; fi; }

# ── 基线：默认 server 上现在有什么（收尾要逐字比对）──
baseline_sessions="$(tmux list-sessions -F '#{session_name}' 2>/dev/null | sort | tr '\n' ',')"
baseline_relay=""
[ -f "$HOME/.ccmesh/relay.pid" ] && baseline_relay="$(ps -p "$(cat "$HOME/.ccmesh/relay.pid")" -o lstart= 2>/dev/null)"

ISO="$(mktemp -d /tmp/sup-iso-XXXX)"
SANDBOX="$(mktemp -d /tmp/sup-box-XXXX)"
cleanup() {
  TMUX_TMPDIR="$ISO" tmux kill-server 2>/dev/null
  rm -rf "$ISO" "$SANDBOX"
}
trap cleanup EXIT

mkdir -p "$SANDBOX/ccmesh" "$SANDBOX/proj"
CONF="$SANDBOX/seats.conf"
DEATHS="$SANDBOX/ccmesh/seat-deaths.log"

# 假 wrapper：不注册不联网，只把自己挂住，模拟一个活着的席位。
FAKE_WRAPPER="$SANDBOX/fake-wrapper.sh"
cat > "$FAKE_WRAPPER" <<'EOF'
#!/usr/bin/env bash
echo "fake seat up: role=$1 desc=$2 dir=$3 launcher=$4"
sleep 600
EOF
chmod +x "$FAKE_WRAPPER"

# 一定会失败的 wrapper：用来验退避（不是验「能起来」，是验「起不来时不刷屏」）
DOOMED_WRAPPER="$SANDBOX/doomed-wrapper.sh"
cat > "$DOOMED_WRAPPER" <<'EOF'
#!/usr/bin/env bash
exit 3
EOF
chmod +x "$DOOMED_WRAPPER"

printf 'seat-alpha\tseat\t测试席位\t%s\tcodex\n' "$SANDBOX/proj" > "$CONF"

run_sup() {
  MESH_SUPERVISOR_TMUX_TMPDIR="$ISO" \
  CCMESH_DIR="$SANDBOX/ccmesh" \
  MESH_SEATS_CONF="$CONF" \
  MESH_SEAT_DEATHS_LOG="$DEATHS" \
  MESH_AGENT_WRAPPER="${WRAPPER_OVERRIDE:-$FAKE_WRAPPER}" \
  MESH_SEAT_MIN_HEALTHY_S="${MIN_HEALTHY:-120}" \
  MESH_SEAT_BACKOFF_BASE_S="${BACKOFF_BASE:-60}" \
    bash "$SUP" "$@" 2>&1
}

iso_sessions() { TMUX_TMPDIR="$ISO" tmux list-sessions -F '#{session_name}' 2>/dev/null | sort | tr '\n' ','; }

echo "== 隔离环境自检（不先证隔离，后面的绿都不算数）=="
TMUX_SEEN="$(MESH_SUPERVISOR_TMUX_TMPDIR="$ISO" CCMESH_DIR="$SANDBOX/ccmesh" MESH_SEATS_CONF="$CONF" bash "$SUP" enumerate 2>&1 | grep -c 'mesh-relay' || true)"
check "监督器在隔离 server 里看不见生产的 mesh-relay" "$TMUX_SEEN" "0"

echo "== 1. 席位不在 → 记档 + 重建 =="
out="$(run_sup ensure)"
check "重建后席位在世" "$(iso_sessions)" "mesh-seat-seat-alpha,"
if grep -q '"event":"supervisor-absent"' "$DEATHS" 2>/dev/null; then
  ok "缺席被写进取证链（supervisor-absent）"
else
  bad "缺席未写进取证链" "$(cat "$DEATHS" 2>/dev/null | head -2)"
fi
# 顺序很关键：缺席记录必须在重建**之前**写，否则事后翻日志看不出断过
if [ "$(grep -c '"event":"supervisor-absent"' "$DEATHS")" = "1" ]; then
  ok "缺席记录只写一条（没有每 tick 重复刷）"
else
  bad "缺席记录条数不对" "$(grep -c '"event":"supervisor-absent"' "$DEATHS")"
fi

echo "== 2. 席位在世 → 什么都不做（幂等）=="
before="$(wc -l < "$DEATHS")"
out="$(run_sup ensure)"
after="$(wc -l < "$DEATHS")"
check "在世时不再追加取证记录" "$after" "$before"
check "在世时席位没被重建成第二个" "$(iso_sessions)" "mesh-seat-seat-alpha,"

echo "== 3. 已经健康的席位被杀 → 下一 tick 立刻回来（不走退避）=="
# MIN_HEALTHY=0：让监督器认为这个席位已经「立住了」，从而清掉重建计数。
# 不这么设的话，测试在几秒内建完就杀，在监督器眼里等于「没活到健康期就死了」——
# 那是退避**应该**介入的形态（第 4 组专门验它），不是本组要测的东西。
MIN_HEALTHY=0 run_sup ensure >/dev/null 2>&1     # 观察到在世 → 退避账清零
TMUX_TMPDIR="$ISO" tmux kill-session -t mesh-seat-seat-alpha 2>/dev/null
check "杀掉后确实不在" "$(iso_sessions)" ""
out="$(run_sup ensure)"
check "下一 tick 自动恢复" "$(iso_sessions)" "mesh-seat-seat-alpha,"

echo "== 3b. 长期缺席 → 取证只记一条，不每 tick 刷（演练当场发现的问题）=="
# 用一个必然失败的 wrapper 造「一直起不来」的席位，连跑 3 个 tick，
# 退避设成 0 保证每次都真的尝试重建（否则测的就成了退避而不是记档去重）。
rm -f "$SANDBOX/ccmesh/supervisor/"*.absent "$SANDBOX/ccmesh/supervisor/"*.backoff 2>/dev/null
TMUX_TMPDIR="$ISO" tmux kill-server 2>/dev/null
: > "$DEATHS"
for _ in 1 2 3; do WRAPPER_OVERRIDE="$DOOMED_WRAPPER" BACKOFF_BASE=0 run_sup ensure >/dev/null 2>&1; done
check "连续 3 个 tick 只写 1 条 supervisor-absent" "$(grep -c '"event":"supervisor-absent"' "$DEATHS")" "1"
# 恢复之后再死一次，必须重新记 —— 去重不能变成「永远只记第一次」
WRAPPER_OVERRIDE="$FAKE_WRAPPER" BACKOFF_BASE=0 MIN_HEALTHY=0 run_sup ensure >/dev/null 2>&1  # 起来了
TMUX_TMPDIR="$ISO" tmux kill-session -t mesh-seat-seat-alpha 2>/dev/null                       # 又死了
WRAPPER_OVERRIDE="$DOOMED_WRAPPER" BACKOFF_BASE=0 run_sup ensure >/dev/null 2>&1
check "恢复后再次死亡会重新记一条" "$(grep -c '"event":"supervisor-absent"' "$DEATHS")" "2"

echo "== 4. 起不来的席位 → 退避，不刷屏 =="
TMUX_TMPDIR="$ISO" tmux kill-server 2>/dev/null
rm -f "$SANDBOX/ccmesh/supervisor/"*.backoff "$SANDBOX/ccmesh/supervisor/"*.born_at 2>/dev/null
WRAPPER_OVERRIDE="$DOOMED_WRAPPER" BACKOFF_BASE=3600 run_sup ensure >/dev/null 2>&1
out2="$(WRAPPER_OVERRIDE="$DOOMED_WRAPPER" BACKOFF_BASE=3600 run_sup ensure 2>&1)"
if printf '%s' "$out2" | grep -q '退避中'; then
  ok "第二次 tick 落进退避，不再重建"
else
  bad "退避没生效——这就是重启风暴的形状" "$out2"
fi

echo "== 5. 只读子命令不改东西 =="
snap="$(iso_sessions)"
run_sup enumerate >/dev/null 2>&1
run_sup status    >/dev/null 2>&1
check "enumerate/status 跑完 session 集合不变" "$(iso_sessions)" "$snap"

echo "== 6. 🔴 生产侧毫发无伤（本测试自己的验收）=="
now_sessions="$(tmux list-sessions -F '#{session_name}' 2>/dev/null | sort | tr '\n' ',')"
check "默认 server 的 session 集合与基线逐字一致" "$now_sessions" "$baseline_sessions"
if [ -n "$baseline_relay" ]; then
  now_relay="$(ps -p "$(cat "$HOME/.ccmesh/relay.pid" 2>/dev/null)" -o lstart= 2>/dev/null)"
  check "真 relay 启动时刻逐字一致（没被杀过也没被重启过）" "$now_relay" "$baseline_relay"
else
  echo "  skip 本机 relay 未运行——环境不具备，不算通过"
fi

echo
echo "pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ]
