#!/usr/bin/env node
/**
 * `codex-seat` CLI 入口（launchd/systemd 直接跑的就是它的 `run`）。
 *
 * 退出码走冻结契约 `EXIT_CODES`：0 正常 / 2 用法 / 3 缺配置 / 4 relay 不可达 / 5 引擎不健康。
 * 托管器只认退出码，别在这里 `process.exit(1)` 敷衍。
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { EXIT_CODES, defaultDeviceId, seatNodeId, seatPaths, type CliCommand } from "../contracts.js"
import { parseCli, USAGE } from "./args.js"
import { ConfigError, configPathFor, defaultSeatConfig, loadSeatConfig, writeSeatConfig } from "./config.js"
import {
  contextForSeat,
  executeInstallPlan,
  executeUninstallPlan,
  planInstall,
  planUninstall,
} from "./install.js"
import { buildStatusReport, formatStatusTable, statusExitCode } from "./status.js"
import { CursorAnchorError, runSeat } from "../seat/seat.js"
import { MeshClient } from "../mesh/mesh-client.js"
import { StateStore, initialState } from "../state/state-store.js"
import { readPidFile } from "../proc/pidfile.js"
import { defaultSysProcOps as sysOps } from "../proc/ops.js"
import { defaultSysProcOps } from "../proc/ops.js"
import { findOrphans } from "../proc/orphans.js"
import { supervisorIsLoaded } from "./status.js"

const DEFAULT_CWD = process.cwd()

function out(s: string): void {
  process.stdout.write(`${s}\n`)
}
function errOut(s: string): void {
  process.stderr.write(`${s}\n`)
}

async function cmdInit(c: Extract<CliCommand, { cmd: "init" }>, configOverride: string | null): Promise<number> {
  const file = configPathFor(c.seat, configOverride)
  if (fs.existsSync(file) && !c.force) {
    errOut(`配置已存在：${file}（要覆盖加 --force）`)
    return EXIT_CODES.usage
  }
  const cwd = c.cwd ?? DEFAULT_CWD
  if (!fs.existsSync(cwd)) {
    errOut(`--cwd 目录不存在：${cwd}`)
    return EXIT_CODES.usage
  }
  const p = seatPaths(c.seat)
  fs.mkdirSync(p.logDir, { recursive: true, mode: 0o700 })
  writeSeatConfig(file, defaultSeatConfig(c.seat, cwd))
  out(`已写配置：${file}`)

  // state.json：**显式写明游标未锚定（null）**，不是 0。
  // 2026-09-02 computer2：init 写出 cursor=0 + 复用老 nodeId → /api/sync?since=0 把 263 条历史
  // 全吐回来，席位把 5 天前的三条旧指令当新派单执行了。null 让首启自己锚到 relay 头。
  // 已存在的 state.json 一律不动（哪怕 --force）：里头的游标/mainThreadId 都是承重件。
  if (fs.existsSync(p.state)) {
    out(`已有 state.json，保持不动：${p.state}（游标与主 thread 都是承重件）`)
  } else {
    const deviceId = defaultDeviceId()
    const st = initialState({ seat: c.seat, nodeId: seatNodeId(deviceId, c.seat), deviceId, instanceId: "init" })
    new StateStore(p.state).save(st)
    out(`已写状态：${p.state}（cursor=null 未锚定，首启自动锚到 relay 头，不消费历史）`)
  }
  out(`席位目录：${p.home}`)
  out(`下一步：codex-seat install --seat ${c.seat}`)
  return EXIT_CODES.ok
}

/**
 * `resume-cursor` —— 防线 3 熔断后的人工解锁（唯一出口，故意只能人来按）。
 *
 * 熔断时那一批消息原样躺在 relay 上、游标一步没推。人核对完「这些确实是该跳过的历史」之后，
 * 用它把游标顶到 relay 头（--to head）或指定 seq，并清掉 paused。
 * 前提是 sidecar 已停：它在跑的时候会覆写 state.json，改了也白改（要硬来加 --force）。
 */
async function cmdResumeCursor(c: Extract<CliCommand, { cmd: "resume-cursor" }>, configOverride: string | null): Promise<number> {
  const cfg = loadSeatConfig(c.seat, configOverride)
  const p = seatPaths(c.seat)
  const store = new StateStore(p.state)
  const st = store.load()
  if (!st) {
    errOut(`读不到 state.json：${p.state}（席位还没起过？）`)
    return EXIT_CODES.configMissing
  }

  const pid = readPidFile(p.sidecarPid)
  if (pid && sysOps.isAlive(pid.pid) && !c.force) {
    errOut(`sidecar 还活着（pid=${pid.pid}）：它会覆写 state.json，改了等于没改。`)
    errOut(`先停：launchctl bootout gui/$(id -u)/com.aster.codex-seat.${c.seat}    再跑本命令（真要硬来加 --force）`)
    return EXIT_CODES.usage
  }

  let target: number
  if (c.to === "head") {
    // 只读 sync（不传 since → relay 不 ack）问头在哪。节点没注册就拿不到，让人显式给 seq。
    try {
      const batch = await new MeshClient(cfg.relayUrl).sync({ nodeId: st.nodeId, timeoutSec: 0, limit: cfg.sync.limit })
      target = batch.nextSince
      if (batch.messages.length >= cfg.sync.limit) {
        out(`注意：relay 一次只给了 ${batch.messages.length} 条（limit），头可能还在后面；`)
        out(`      要一次到底就先 sqlite3 ~/.ccmesh/db/mesh.db 'SELECT max(seq) FROM messages;' 再 --to <seq>`)
      }
    } catch (err) {
      errOut(`问不到 relay 头（${cfg.relayUrl}）：${String(err)}`)
      errOut(`relay 不可达或该 nodeId 没注册时，用 --to <seq> 显式给游标`)
      return EXIT_CODES.relayUnreachable
    }
  } else {
    target = c.to
  }

  const before = { cursor: st.cursor, paused: st.paused }
  st.cursor = target
  st.cursorAnchoredAt = new Date().toISOString()
  st.cursorAnchorSeq = target
  st.paused = null
  store.save(st)

  out(`席位 ${c.seat}（${st.nodeId}）`)
  out(`  游标 ${before.cursor ?? "未锚定"} → ${target}`)
  out(`  熔断 ${before.paused ? `${before.paused.reason}（单批 ${before.paused.batchSize} 条 / ${before.paused.staleCount} 条出生前）` : "无"} → 已清除`)
  out(`  下一步：launchctl kickstart -k gui/$(id -u)/com.aster.codex-seat.${c.seat}，然后 status 看 wal(in-flight) 应为 0`)
  return EXIT_CODES.ok
}

async function cmdInstall(c: Extract<CliCommand, { cmd: "install" }>, configOverride: string | null): Promise<number> {
  const cfg = loadSeatConfig(c.seat, configOverride)
  const ctx = contextForSeat(c.seat, cfg.cwd)
  if (!fs.existsSync(ctx.cliEntry)) {
    errOut(`CLI 入口不存在：${ctx.cliEntry}（先 pnpm --filter @cc-mesh/codex-seat build）`)
    return EXIT_CODES.configMissing
  }
  fs.mkdirSync(seatPaths(c.seat).logDir, { recursive: true, mode: 0o700 })
  const plan = planInstall({ seat: c.seat, platform: process.platform, uid: os.userInfo().uid, ctx })

  out(`托管器：${plan.kind}  label：${plan.label}`)
  out(`模板落点：${plan.targetPath}`)
  for (const cmd of plan.commands) out(`  $ ${cmd.join(" ")}`)
  for (const h of plan.hints) out(`  · ${h}`)
  if (c.dryRun) {
    out("--- 渲染结果 ---")
    out(plan.content)
    return EXIT_CODES.ok
  }

  for (const r of executeInstallPlan(plan)) {
    out(`  ${r.ok ? "✓" : "✗"} ${r.cmd}${r.output ? `  ${r.output.slice(0, 200)}` : ""}`)
    if (!r.ok) return EXIT_CODES.engineFailed
  }

  // 等 ≤30s：state.json 的 instanceId 变了 + relay 里有这个节点
  const before = readInstanceId(c.seat)
  const deadline = Date.now() + 30_000
  let report = await buildStatusReport({ seat: c.seat, config: cfg })
  while (Date.now() < deadline) {
    report = await buildStatusReport({ seat: c.seat, config: cfg })
    const after = report.instanceId
    if (after && after !== before && report.relay.registered) break
    await new Promise((r) => setTimeout(r, 1000))
  }
  out("")
  out(formatStatusTable(report))
  return statusExitCode(report)
}

function readInstanceId(seat: string): string | null {
  try {
    return JSON.parse(fs.readFileSync(seatPaths(seat).state, "utf-8")).instanceId ?? null
  } catch {
    return null
  }
}

async function cmdUninstall(c: Extract<CliCommand, { cmd: "uninstall" }>): Promise<number> {
  const plan = planUninstall({ seat: c.seat, platform: process.platform, uid: os.userInfo().uid })
  out(`卸载 ${plan.kind} ${plan.label}`)
  for (const cmd of plan.commands) out(`  $ ${cmd.join(" ")}`)
  for (const p of plan.removePaths) out(`  $ rm -f ${p}`)
  for (const h of plan.hints) out(`  · ${h}`)
  if (c.dryRun) return EXIT_CODES.ok
  for (const r of executeUninstallPlan(plan)) {
    out(`  ${r.ok ? "✓" : "✗"} ${r.cmd}${r.output ? `  ${r.output.slice(0, 160)}` : ""}`)
  }
  return EXIT_CODES.ok
}

async function cmdStatus(c: Extract<CliCommand, { cmd: "status" }>, configOverride: string | null): Promise<number> {
  const cfg = loadSeatConfig(c.seat, configOverride)
  const report = await buildStatusReport({ seat: c.seat, config: cfg })
  out(c.json ? JSON.stringify(report, null, 2) : formatStatusTable(report))
  return statusExitCode(report)
}

async function cmdRun(c: Extract<CliCommand, { cmd: "run" }>, configOverride: string | null): Promise<number> {
  const cfg = loadSeatConfig(c.seat, configOverride)
  // Lane C 把进程层注进 Lane B 的席位核心：孤儿扫描与托管形态都归 src/proc / src/cli 管
  const handle = await runSeat(cfg, {
    installSignalHandlers: true,
    procOps: {
      orphans: async () => findOrphans({ seat: c.seat, ops: defaultSysProcOps }),
      supervision: () => ({
        supervised: process.platform === "darwin" ? "launchd" : process.platform === "linux" ? "systemd" : "none",
        supervisorLoaded: supervisorIsLoaded(c.seat),
      }),
    },
  })
  // sidecar 的 pid 文件由 `runSeat()` 在**启动之前**自己写、退出时自己删（集成时从这里搬走）：
  // 写在 runSeat() 返回之后，整个启动期磁盘上都没有 sidecar.pid，status 会误报席位死了。
  void handle

  // 前台常驻：由 SIGTERM/SIGINT 处理器收摊退出，这里永远不 resolve
  await new Promise<never>(() => {})
  return EXIT_CODES.ok
}

export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseCli(argv)
  if (!parsed.ok) {
    errOut(parsed.error)
    errOut("")
    errOut(USAGE)
    return parsed.exitCode
  }
  const { cmd, configPath } = parsed
  try {
    switch (cmd.cmd) {
      case "help":
        out(USAGE)
        return EXIT_CODES.ok
      case "init":
        return await cmdInit(cmd, configPath)
      case "install":
        return await cmdInstall(cmd, configPath)
      case "uninstall":
        return await cmdUninstall(cmd)
      case "status":
        return await cmdStatus(cmd, configPath)
      case "run":
        return await cmdRun(cmd, configPath)
      case "resume-cursor":
        return await cmdResumeCursor(cmd, configPath)
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      errOut(err.message)
      return err.exitCode
    }
    // 锚不上 relay 就不许起来（否则 since 退化成 0 = 重放全部历史）。
    // 报 4 不报 5：这是 relay 的问题，别把运维支去查引擎。
    if (err instanceof CursorAnchorError) {
      errOut(err.message)
      return err.exitCode
    }
    errOut(`codex-seat 失败: ${(err as Error).stack ?? String(err)}`)
    return EXIT_CODES.engineFailed
  }
}

if (require.main === module) {
  void main(process.argv.slice(2)).then((code) => {
    // run 是前台常驻：正常情况下走不到这里；走到了就是主循环退出，照退出码收摊
    process.exitCode = code
    if (code !== EXIT_CODES.ok) process.exit(code)
  })
}
