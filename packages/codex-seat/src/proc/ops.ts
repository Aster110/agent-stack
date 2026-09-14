/**
 * 进程原语。`ProcOps` 三件套与 `wechat-cc-channel` 上游同形（Lane A 的默认实现就是它），
 * 集成时 Lane A 把 `defaultProcOps` 换成这里的 `defaultSysProcOps`，**接口不加不减**。
 * 进程组相关的能力放在 `SysProcOps extends ProcOps` 里，避免动 A 的签名。
 */
import { execFileSync } from "node:child_process"

/** 与 wechat-cc-channel/src/v6/agents/codex-app-server.ts 的 ProcOps 逐字同形 */
export interface ProcOps {
  isAlive(pid: number): boolean
  cmdline(pid: number): string | null
  kill(pid: number, signal: NodeJS.Signals): void
}

export interface ProcInfo {
  pid: number
  ppid: number
  pgid: number
  command: string
}

export interface SysProcOps extends ProcOps {
  /** 进程所在组；进程没了返回 null */
  pgidOf(pid: number): number | null
  /** 全表快照（ps -axo pid=,ppid=,pgid=,command=） */
  list(): ProcInfo[]
  /** kill(-pgid, sig)：整组。杀 wrapper 不杀 rust 本体是已知坑，所以停引擎永远走这个。 */
  killGroup(pgid: number, signal: NodeJS.Signals): void
  groupPids(pgid: number): number[]
}

const PS_ROW_RE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S.*)$/

/** 纯函数：`ps -axo pid=,ppid=,pgid=,command=` 的输出 → 行表。垃圾行丢弃不抛。 */
export function parsePsTable(stdout: string): ProcInfo[] {
  const out: ProcInfo[] = []
  for (const line of stdout.split("\n")) {
    const m = PS_ROW_RE.exec(line)
    if (!m) continue
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), command: m[4]! })
  }
  return out
}

function ps(args: string[]): string {
  try {
    // maxBuffer 调大：ChatGPT.app 那条命令行单行就 1KB+
    return execFileSync("ps", args, { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 })
  } catch {
    return ""
  }
}

export const defaultSysProcOps: SysProcOps = {
  isAlive(pid) {
    if (!Number.isFinite(pid) || pid <= 1) return false
    try {
      process.kill(pid, 0)
      return true
    } catch (err) {
      // EPERM = 进程在但不是我们的；仍然算「活着」
      return (err as NodeJS.ErrnoException)?.code === "EPERM"
    }
  },
  cmdline(pid) {
    const out = ps(["-p", String(pid), "-o", "command="]).trim()
    return out.length > 0 ? out : null
  },
  kill(pid, signal) {
    if (!Number.isFinite(pid) || pid <= 1) return
    try {
      process.kill(pid, signal)
    } catch {
      /* 已经没了 */
    }
  },
  pgidOf(pid) {
    const out = ps(["-p", String(pid), "-o", "pgid="]).trim()
    const n = Number.parseInt(out, 10)
    return Number.isFinite(n) && n > 0 ? n : null
  },
  list() {
    return parsePsTable(ps(["-axo", "pid=,ppid=,pgid=,command="]))
  },
  killGroup(pgid, signal) {
    if (!Number.isFinite(pgid) || pgid <= 1) return
    try {
      process.kill(-pgid, signal)
    } catch {
      /* 组已经空了 */
    }
  },
  groupPids(pgid) {
    return defaultSysProcOps.list().filter((p) => p.pgid === pgid).map((p) => p.pid)
  },
}

/** 兼容 Lane A 的窄接口别名 */
export const defaultProcOps: ProcOps = defaultSysProcOps
