/**
 * `codex-seat status` —— 把四个事实源合并成一张 `StatusReport`：
 *   state.json（席位自己记的）、relay /api/status（网络怎么看它）、
 *   进程死活（ps，不信 pid 文件的一面之词）、ledger-cache.json（额度与 Hub 可达性）。
 *
 * 四个源都可能撒谎，所以每一个都不能省。特别是 relay：pull 节点在 /api/status 里
 * 「未 sync 即 offline」，只看 state.json 会以为自己活得好好的。
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  EXIT_CODES,
  RECENT_MSG_IDS_MAX,
  CONTRACT_VERSION,
  defaultDeviceId,
  foldWal,
  launchdLabel,
  seatNodeId,
  seatPaths,
  systemdUnitName,
  activeFaults,
  type FaultName,
  type LedgerCache,
  type SeatConfig,
  type StateFile,
  type StatusReport,
  type WalEntry,
} from "../contracts.js"
import { defaultSysProcOps, type SysProcOps } from "../proc/ops.js"
import { findOrphans } from "../proc/orphans.js"
import { readPidFile } from "../proc/pidfile.js"

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

export interface WalCounts {
  fetched: number
  started: number
  completed: number
  failed?: number
  rejected?: number
}

/** 按折叠后的相位计数（done 的不算在途）。 */
export function walCounts(entries: readonly WalEntry[]): WalCounts {
  const out: WalCounts = { fetched: 0, started: 0, completed: 0 }
  for (const f of foldWal(entries).values()) {
    if (f.phase === "fetched") out.fetched++
    else if (f.phase === "started" || f.phase === "observing") out.started++
    else if (f.phase === "completed") out.completed++
    else if (f.phase === "failed") out.failed = (out.failed ?? 0) + 1
    else if (f.phase === "rejected") out.rejected = (out.rejected ?? 0) + 1
  }
  return out
}

export function threadsFromState(state: StateFile | null): StatusReport["threads"] {
  if (!state) return []
  const out: StatusReport["threads"] = [
    { nodeId: state.nodeId, threadId: state.mainThreadId, kind: "seat", activeTurn: null, lastDoneAt: state.lastDoneAt },
  ]
  for (const w of Object.values(state.workers ?? {})) {
    out.push({ nodeId: w.nodeId, threadId: w.threadId, kind: "worker", activeTurn: null, lastDoneAt: null })
  }
  return out
}

export function statusExitCode(r: StatusReport): number {
  if (!r.relay.registered) return EXIT_CODES.relayUnreachable
  if (!r.engine.alive || !r.sidecar.alive) return EXIT_CODES.engineFailed
  // 熔断中：进程都活着、relay 也认得它，但它一条消息都不消费。
  // 这时候还报 0，脚本和人都会以为席位好着——那正是这道闸最不该出的错。
  if (r.paused) return EXIT_CODES.pausedReplayStorm
  return EXIT_CODES.ok
}

function row(k: string, v: string): string {
  return `${k.padEnd(18)} | ${v}`
}

export function formatStatusTable(r: StatusReport): string {
  const lines: string[] = []
  lines.push(`codex-seat ${r.seat}  (contract v${r.contractVersion})`)
  lines.push("-".repeat(72))
  lines.push(row("nodeId", r.nodeId))
  lines.push(row("instanceId", r.instanceId ?? "-"))
  lines.push(row("codex", r.codexVersion ?? "-"))
  lines.push(row("sidecar", `pid=${r.sidecar.pid ?? "-"} alive=${r.sidecar.alive} supervised=${r.sidecar.supervised} loaded=${r.sidecar.supervisorLoaded}`))
  lines.push(row("engine", `pid=${r.engine.pid ?? "-"} pgid=${r.engine.pgid ?? "-"} alive=${r.engine.alive} since=${r.engine.startedAt ?? "-"}`))
  lines.push(row("relay", `${r.relay.url} registered=${r.relay.registered} lastSync=${r.relay.lastSyncAt ?? "-"} cursor=${r.relay.cursor ?? "未锚定"} anchored=${r.relay.anchoredAt ?? "-"}`))
  if (r.paused) {
    lines.push(row("⚠ PAUSED", `paused-${r.paused.reason}  at=${r.paused.at} node=${r.paused.nodeId}`))
    lines.push(row("", `单批 ${r.paused.batchSize} 条、其中 ${r.paused.staleCount} 条早于席位出生 → 整批未执行、游标未推进`))
    lines.push(row("", `核对后解锁：codex-seat resume-cursor --seat ${r.seat} --to head（或 --to ${r.paused.observedNextSince}）`))
  }
  lines.push(row("wal(in-flight)", `fetched=${r.wal.fetched} started=${r.wal.started} completed=${r.wal.completed} failed=${r.wal.failed ?? 0} rejected=${r.wal.rejected ?? 0}`))
  lines.push(row("last seen/done", `${r.lastSeenAt ?? "-"} / ${r.lastDoneAt ?? "-"}`))
  lines.push(row("hub", `stale=${r.hub.stale} lastOk=${r.hub.lastOkAt ?? "-"}${r.hub.lastError ? ` err=${r.hub.lastError}` : ""}`))
  const rl = r.rateLimits?.rateLimits
  lines.push(row("quota", rl
    ? `primary=${rl.primary?.usedPercent ?? "-"}% secondary=${rl.secondary?.usedPercent ?? "-"}% plan=${rl.planType ?? "-"}`
    : "-"))
  lines.push(row("orphans", `${r.orphans.length}${r.orphans.length > 0 ? ` ⚠ ${r.orphans.map((o) => o.pid).join(",")}` : ""}`))
  if (r.faults.length > 0) lines.push(row("FAULTS", r.faults.join(",")))
  lines.push("")
  lines.push("threads:")
  if (r.threads.length === 0) lines.push("  (none)")
  for (const t of r.threads) {
    lines.push(`  [${t.kind}] ${t.nodeId}  thread=${t.threadId ?? "-"}  lastDone=${t.lastDoneAt ?? "-"}`)
  }
  if (r.orphans.length > 0) {
    lines.push("")
    lines.push("orphan app-server（按本席位标签认领，二进制路径不参与判定）:")
    for (const o of r.orphans) lines.push(`  pid=${o.pid} pgid=${o.pgid} ${o.cmd.slice(0, 100)}`)
  }
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// 汇总（依赖全部可注入 → 单测不碰真 relay / 真进程）
// ---------------------------------------------------------------------------

export interface StatusInputs {
  seat: string
  config: SeatConfig
  homeDir?: string
  deviceId?: string
  ops?: SysProcOps
  fetchJson?: (url: string) => Promise<any>
  platform?: NodeJS.Platform
  supervisorLoaded?: () => boolean
  env?: NodeJS.ProcessEnv
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T
  } catch {
    return null
  }
}

function readWal(file: string): WalEntry[] {
  try {
    const lines = fs.readFileSync(file, "utf-8").split("\n")
    const out: WalEntry[] = []
    for (const l of lines) {
      const s = l.trim()
      if (!s) continue
      try {
        out.push(JSON.parse(s) as WalEntry)
      } catch {
        /* 截断的最后一行：忽略 */
      }
    }
    return out.slice(-RECENT_MSG_IDS_MAX * 4)
  } catch {
    return []
  }
}

export async function defaultFetchJson(url: string): Promise<any> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 5000)
  try {
    const res = await fetch(url, { signal: ctl.signal })
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

export function supervisorIsLoaded(seat: string, platform: NodeJS.Platform = process.platform): boolean {
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process")
  try {
    if (platform === "darwin") {
      const out = execFileSync("launchctl", ["list"], { encoding: "utf-8", timeout: 5000 })
      return out.includes(launchdLabel(seat))
    }
    const out = execFileSync("systemctl", ["--user", "list-units", "--all", "--no-legend"], { encoding: "utf-8", timeout: 5000 })
    return out.includes(systemdUnitName(seat))
  } catch {
    return false
  }
}

export async function buildStatusReport(i: StatusInputs): Promise<StatusReport> {
  const home = i.homeDir ?? os.homedir()
  const p = seatPaths(i.seat, home)
  const ops = i.ops ?? defaultSysProcOps
  const platform = i.platform ?? process.platform
  const env = i.env ?? process.env

  const state = readJson<StateFile>(p.state)
  const cache = readJson<LedgerCache>(p.ledgerCache)
  const wal = walCounts(readWal(p.wal))

  const deviceId = i.deviceId ?? state?.deviceId ?? i.config.deviceId ?? defaultDeviceId()
  const nodeId = state?.nodeId ?? seatNodeId(deviceId, i.seat)

  const sidecarPid = readPidFile(p.sidecarPid)
  const enginePid = readPidFile(p.appServerPid)
  const engineAlive = enginePid ? ops.isAlive(enginePid.pid) : false

  // relay：拿不到就是 registered=false，别抛（status 本来就是给「出问题时」用的）
  let registered = false
  let lastSyncAt: string | null = null
  try {
    const doc = await (i.fetchJson ?? defaultFetchJson)(`${i.config.relayUrl.replace(/\/$/, "")}/api/status`)
    const nodes: any[] = doc?.data?.nodes ?? []
    const me = nodes.find((n) => n?.identity?.nodeId === nodeId)
    registered = Boolean(me)
    lastSyncAt = me?.lastSyncAt ?? null
  } catch {
    registered = false
  }

  const orphans = findOrphans({
    seat: i.seat,
    ops,
    excludePgid: enginePid?.pgid ?? null,
  }).map((o) => ({ pid: o.pid, pgid: o.pgid, cmd: o.cmd }))

  const supervised: StatusReport["sidecar"]["supervised"] =
    platform === "darwin" ? "launchd" : platform === "linux" ? "systemd" : "none"

  return {
    seat: i.seat,
    nodeId,
    instanceId: state?.instanceId ?? null,
    contractVersion: state?.contractVersion ?? CONTRACT_VERSION,
    codexVersion: state?.codexVersion ?? null,
    sidecar: {
      pid: sidecarPid?.pid ?? null,
      alive: sidecarPid ? ops.isAlive(sidecarPid.pid) : false,
      supervised,
      supervisorLoaded: (i.supervisorLoaded ?? (() => supervisorIsLoaded(i.seat, platform)))(),
    },
    engine: {
      pid: enginePid?.pid ?? null,
      pgid: enginePid?.pgid ?? null,
      alive: engineAlive,
      startedAt: state?.engine?.startedAt ?? enginePid?.startedAt ?? null,
    },
    threads: threadsFromState(state),
    relay: {
      url: i.config.relayUrl, registered, lastSyncAt,
      cursor: state ? state.cursor : null,
      anchoredAt: state?.cursorAnchoredAt ?? null,
    },
    wal,
    rateLimits: cache?.rateLimits ?? null,
    hub: { lastOkAt: cache?.lastOkAt ?? null, stale: cache?.stale ?? true, lastError: cache?.lastError ?? null },
    orphans,
    faults: [...activeFaults(env)] as FaultName[],
    lastSeenAt: state?.lastSeenAt ?? null,
    lastDoneAt: state?.lastDoneAt ?? null,
    paused: state?.paused ?? null,
  }
}

export function statusLogPathHint(seat: string, homeDir?: string): string {
  return path.join(seatPaths(seat, homeDir).logDir, "stderr.log")
}
