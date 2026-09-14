#!/usr/bin/env bash
# E18-B —— 在真 Linux（测试设备）上跑 systemd --user 档。
#
# ⚠️ **本轮只写不执行**：要跑请由主席位授权（涉及在生产机上装 --user 单元）。
#
# 🔴 红线：
#   · 席位名恒为 e2e-<4hex>，unit 名 codex-seat-e2e-<4hex>.service，跑完必 disable --now + rm
#   · 绝不碰该机已有的常驻席位与 relay
#   · Hub 用假的
set -euo pipefail

SEAT="e2e-$(head -c2 /dev/urandom | xxd -p)"
UNIT="codex-seat-${SEAT}.service"
REPO="${REPO:-$HOME/AIproject/cc-mesh}"
CLI="$REPO/packages/codex-seat/dist/src/cli/main.js"

[[ "$SEAT" =~ ^e2e-[0-9a-f]{4}$ ]] || { echo "席位名必须是 e2e-<4hex>" >&2; exit 2; }

echo "== 前置：linger（没有它，注销就把 --user 单元带走）=="
loginctl enable-linger "$USER" || echo "（enable-linger 失败，继续，但重启后单元不会自起）"

echo "== init + install =="
node "$CLI" init --seat "$SEAT" --cwd "$HOME" --force
node "$CLI" install --seat "$SEAT"
systemctl --user is-active "$UNIT" || { echo "unit 没起来" >&2; systemctl --user status "$UNIT" --no-pager || true; }

echo "== E07 systemd 版：kill -9 后 Restart=always 必须拉回来 =="
PID="$(systemctl --user show -p MainPID --value "$UNIT")"
echo "MainPID=$PID"
kill -9 "$PID" || true
sleep 15
PID2="$(systemctl --user show -p MainPID --value "$UNIT")"
echo "新 MainPID=$PID2"
[ "$PID2" != "$PID" ] && [ "$PID2" != "0" ] && echo "✓ 拉回来了" || { echo "✗ 没拉回来"; }

node "$CLI" status --seat "$SEAT" || true

echo "== 收尾（必须干净）=="
node "$CLI" uninstall --seat "$SEAT"
systemctl --user disable --now "$UNIT" 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/$UNIT"
systemctl --user daemon-reload
systemctl --user list-units --all | grep -c "codex-seat-e2e-" || echo "（无残留）"
