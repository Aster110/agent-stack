# e2e cases（Lane C 部分）

| case | 跑法 | 状态 |
|---|---|---|
| E07 kill -9 sidecar | `node dist/e2e/cases/E07-sidecar-kill9.js [--mutate]` | ✅ 真跑（私有 relay + 真 codex + 真 launchd） |
| E08 杀 rust 本体 | `node dist/e2e/cases/E08-kill-rust-body.js [--mutate|--mutate=sweep]` | ✅ 真跑 |
| E09 tmux kill-server | `node dist/e2e/cases/E09-tmux-kill-server.js` | ✅ 真跑（私有 tmux server） |
| E13 CU smoke | `node dist/e2e/cases/E13-cu-smoke.js [--mutate]` | ✅ 真跑（真 node_repl MCP） |
| E14 额度进账本 | `node dist/e2e/cases/E14-ledger-quota.js [--mutate]` | ✅ 真跑（**假 Hub**，绝不连生产 192.0.2.1） |
| E18 Linux 档 | `bash ../linux/run-in-docker.sh` / `bash ../linux/run-workstation.sh` | ⏸ **只写不跑**（computer2 无 docker/colima/podman） |
| E10 冷启动 | `bash E10-cold-boot.sh baseline <seat>` → 重启 → `verify <seat>` | ⏸ **只写不跑**（要重启整机，需 aster 在场 + 主席位授权） |
| E19 48h soak | 见 `../soak/README.md` | ⏸ **只写不跑**（占 48h 共享额度，需主席位授权） |

## 通用

- 证据落 `CODEX_SEAT_E2E_OUT`（缺省 `packages/codex-seat/e2e/evidence/`，gitignored）
- 每份证据必须过 `evidenceReallyRan()`：墙钟 > 0、事件计数非空、真引擎档 rollout 增长
- `--mutate` 是红门或故障行为检查，证据里 `expectedRed` / `actualRed` 必须一致才算通过

## 红线（每个 case 都硬校验）

- relay：随机端口且断言 ≠ 19800，`HOME`/`MESH_DB_PATH` 私有，`MESH_DEVICE_ID=e2edev`
- launchd：label 必须匹配 `com.aster.codex-seat.e2e-<4hex>`（`assertSafeLabel` 拒绝其它形状），**永不碰 `com.aster.mesh-*`**
- tmux：只用 `tmux -L e2e-<4hex>`，**永不对默认 server `kill-server`**
- Hub：只连本地假 Hub，**永不连 192.0.2.1**
- 孤儿清理：谓词按**席位标签优先**（`app-server` × 本席位标签；无标签时才路径否决 `/Applications/ChatGPT.app/`），且每次都先做阳性对照
