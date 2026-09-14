/**
 * app-server / sidecar 的 pid 文件。设计稿 §6：JSON `{pid,pgid,startedAt,cmdline,instanceId}`，0600。
 *
 * pid 会被复用。**不校验命令行就敢 kill，迟早误杀别人的进程** —— 上游 killOrphan 已经吃过这一课，
 * 这里把它做成显式的 `checkPidFile` 三态（alive / dead / mismatch），调用方只有 alive 才动手。
 */
import fs from "node:fs"
import path from "node:path"

import type { ProcOps } from "./ops.js"
import { isOurAppServerCmd } from "./orphans.js"

export interface PidFileRecord {
  pid: number
  pgid: number
  startedAt: string
  cmdline: string
  /** 旧格式（裸 pid）没有它 */
  instanceId: string | null
}

export function serializePidFile(rec: PidFileRecord): string {
  return `${JSON.stringify(rec, null, 2)}\n`
}

/** 纯函数。垃圾内容返回 null（文件被截断/手改），不抛。 */
export function parsePidFile(raw: string): PidFileRecord | null {
  const s = raw.trim()
  if (!s) return null
  if (/^\d+$/.test(s)) {
    const pid = Number.parseInt(s, 10)
    if (!Number.isFinite(pid) || pid <= 1) return null
    return { pid, pgid: pid, startedAt: "", cmdline: "", instanceId: null }
  }
  let obj: unknown
  try {
    obj = JSON.parse(s)
  } catch {
    return null
  }
  if (!obj || typeof obj !== "object") return null
  const o = obj as Record<string, unknown>
  const pid = Number(o.pid)
  if (!Number.isFinite(pid) || pid <= 1) return null
  const pgid = Number(o.pgid)
  return {
    pid,
    pgid: Number.isFinite(pgid) && pgid > 1 ? pgid : pid,
    startedAt: typeof o.startedAt === "string" ? o.startedAt : "",
    cmdline: typeof o.cmdline === "string" ? o.cmdline : "",
    instanceId: typeof o.instanceId === "string" ? o.instanceId : null,
  }
}

/** 原子写（tmp + rename），0600，父目录 0700 */
export function writePidFile(file: string, rec: PidFileRecord): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, serializePidFile(rec), { encoding: "utf-8", mode: 0o600 })
  fs.renameSync(tmp, file)
}

export function readPidFile(file: string): PidFileRecord | null {
  try {
    return parsePidFile(fs.readFileSync(file, "utf-8"))
  } catch {
    return null
  }
}

export function clearPidFile(file: string): void {
  try {
    fs.rmSync(file, { force: true })
  } catch {
    /* 没有就算了 */
  }
}

export type PidCheck = "missing" | "dead" | "mismatch" | "alive"

/**
 * @param seat 席位名；命令行必须过 `isOurAppServerCmd`（含本席位标签；标签优先于二进制路径）才算 alive。
 */
export function checkPidFile(rec: PidFileRecord | null, ops: ProcOps, seat: string): PidCheck {
  if (!rec) return "missing"
  if (rec.pid === process.pid) return "mismatch"
  if (!ops.isAlive(rec.pid)) return "dead"
  const cmd = ops.cmdline(rec.pid) ?? ""
  return isOurAppServerCmd(cmd, seat) ? "alive" : "mismatch"
}
