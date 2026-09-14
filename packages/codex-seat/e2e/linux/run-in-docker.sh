#!/usr/bin/env bash
# E18 —— 在容器里跑 Linux 档（E02/E03 + systemd 版 E07）。
#
# ⚠️ 本机（computer2）没有 docker/colima/podman ——**本轮只写不跑**。
#    真跑之前先确认 `docker info` 通，且宿主机的 ~/.codex 里有可用凭据。
#
# 🔴 红线：
#   · CODEX_HOME 只读挂载，镜像里绝不 bake 凭据
#   · relay 用容器内私有端口，绝不连宿主机 :19800
#   · Hub 用假的，绝不连 192.0.2.1
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
IMAGE="${IMAGE:-cc-mesh-codex-seat-e2e:ubuntu24}"
CODEX_HOME_HOST="${CODEX_HOME_HOST:-$HOME/.codex}"

if ! command -v docker >/dev/null 2>&1; then
  echo "跳过：本机没有 docker。E18 需要容器运行时或真 Linux（测试设备）。" >&2
  exit 78   # EX_CONFIG：环境不具备，不是代码红
fi
[ -d "$CODEX_HOME_HOST" ] || { echo "找不到 $CODEX_HOME_HOST" >&2; exit 3; }

echo "== build =="
docker build -t "$IMAGE" -f "$HERE/Dockerfile" "$HERE"

echo "== run =="
docker run --rm -t \
  -v "$REPO":/home/seat/cc-mesh-src:ro \
  -v "$CODEX_HOME_HOST":/home/seat/.codex:ro \
  -e CODEX_SEAT_E2E_OUT=/home/seat/evidence \
  "$IMAGE" bash -lc '
    set -euo pipefail
    cp -r /home/seat/cc-mesh-src /home/seat/cc-mesh
    cd /home/seat/cc-mesh
    pnpm install --offline || pnpm install
    pnpm --filter @cc-mesh/protocol build
    pnpm --filter @cc-mesh/relay build
    pnpm --filter @cc-mesh/codex-seat build
    mkdir -p /home/seat/evidence
    # Lane B 的 case（合并后才有）
    node packages/codex-seat/dist/e2e/cases/E02-*.js || true
    node packages/codex-seat/dist/e2e/cases/E03-*.js || true
    # Lane C：systemd 版保活（容器里没有真 systemd --user 会话，
    # 用 shell 循环代 supervisor，只验「进程被拉回来 + 身份不变」这一段）
    node packages/codex-seat/dist/e2e/linux/e07-systemd.js || true
    ls -la /home/seat/evidence
  '
