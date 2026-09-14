/**
 * 进程组停止。
 *
 * 为什么不是 `child.kill()`：`/opt/homebrew/bin/codex` 是个 node wrapper，
 * 杀它不杀 rust 本体（实测本体 ppid 变 1 成孤儿，还抓着 thread-writer-lock）。
 * 所以停引擎永远 `kill(-pgid)`，spawn 时必须 `detached:true`（pgid = pid）。
 *
 * 自杀护栏：`kill(-pgid)` 打到自己所在的组就是自杀。写这套时真的自杀过一次
 * （探针脚本里 pgid 取成了当前 shell 的组，整条命令 exit 144）。所以这里硬拦。
 */
import type { SysProcOps } from "./ops.js"
import { defaultSysProcOps } from "./ops.js"

export class SelfKillError extends Error {}

export interface StopGroupOptions {
  /** TERM 之后等多久再 KILL，缺省 2000ms（设计稿 §6 优雅退出） */
  graceMs?: number
  pollMs?: number
  /** 故障注入 kill-wrapper-only：只杀 wrapper pid，留 rust 本体做孤儿（E08） */
  wrapperOnly?: boolean
  ops?: SysProcOps
  /** 覆盖「自己所在组」的判定（单测用） */
  selfPgid?: number | null
}

export interface StopGroupResult {
  mode: "group" | "wrapper-only"
  /** TERM 没送走、升级到了 KILL */
  escalated: boolean
  /** 收尾时组里还有没有进程 */
  alive: boolean
  waitedMs: number
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function groupAlive(pgid: number, ops: SysProcOps = defaultSysProcOps): boolean {
  if (!Number.isFinite(pgid) || pgid <= 1) return false
  return ops.groupPids(pgid).length > 0
}

export async function stopProcessGroup(
  pid: number,
  pgid: number,
  ops: SysProcOps = defaultSysProcOps,
  opts: StopGroupOptions = {},
): Promise<StopGroupResult> {
  const o = opts.ops ?? ops
  const graceMs = opts.graceMs ?? 2000
  const pollMs = opts.pollMs ?? 50

  if (opts.wrapperOnly) {
    // 故意的坏行为：只杀 wrapper。E08 靠它造出孤儿，再验孤儿清扫真的会动手。
    o.kill(pid, "SIGKILL")
    await sleep(Math.min(graceMs, 300))
    return { mode: "wrapper-only", escalated: false, alive: o.isAlive(pid), waitedMs: Math.min(graceMs, 300) }
  }

  if (!Number.isFinite(pgid) || pgid <= 1) {
    throw new SelfKillError(`拒绝 kill(-${pgid})：pgid<=1 是 init/整个会话`)
  }
  const selfPgid = opts.selfPgid !== undefined ? opts.selfPgid : o.pgidOf(process.pid)
  if (selfPgid != null && selfPgid === pgid) {
    throw new SelfKillError(`拒绝 kill(-${pgid})：那是本进程自己所在的进程组`)
  }

  const t0 = Date.now()
  o.killGroup(pgid, "SIGTERM")
  while (Date.now() - t0 < graceMs) {
    if (!groupAlive(pgid, o)) {
      return { mode: "group", escalated: false, alive: false, waitedMs: Date.now() - t0 }
    }
    await sleep(pollMs)
  }
  if (!groupAlive(pgid, o)) {
    return { mode: "group", escalated: false, alive: false, waitedMs: Date.now() - t0 }
  }
  o.killGroup(pgid, "SIGKILL")
  await sleep(Math.min(pollMs * 4, 300))
  return { mode: "group", escalated: true, alive: groupAlive(pgid, o), waitedMs: Date.now() - t0 }
}
