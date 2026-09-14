/**
 * 起 app-server 进程组。
 *
 * 三条实测教训写死在这里：
 *   1. `detached:true` —— 不这么起就没有独立进程组，`kill(-pgid)` 会打到自己身上。
 *   2. 二进制用绝对路径解析 —— 交互 shell 里的 `codex` 是个函数（`command -v codex` 回 `codex`），
 *      脚本里直接喊名字会被劫持。
 *   3. `scrubProcessEnv()` —— 进程级绝不带 MESH_NODE；署名只走 per-thread config 覆盖。
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

import { APP_SERVER_BASE_ARGS, CODEX_BIN_FALLBACK, scrubProcessEnv } from "../contracts.js"
import { seatTagArgs } from "./orphans.js"
import { writePidFile } from "./pidfile.js"

/** 生产参数里绝不允许出现的东西（红线兜底，别指望调用方自觉） */
const FORBIDDEN_ARGS = ["--remote-control"]

export function buildAppServerArgs(seat: string, instanceId: string, extraArgs: readonly string[] = []): string[] {
  const extra = extraArgs.filter((a) => !FORBIDDEN_ARGS.includes(a))
  // 标签必须是最后一对：孤儿谓词按它认人，放中间容易被 extraArgs 挤散
  return [...APP_SERVER_BASE_ARGS, ...extra, ...seatTagArgs(seat, instanceId)]
}

export interface BinProbe {
  which(name: string): string | null
  exists(p: string): boolean
}

export const defaultBinProbe: BinProbe = {
  which(name) {
    try {
      const out = execFileSync("/usr/bin/which", [name], { encoding: "utf-8" }).trim().split("\n")[0] ?? ""
      return out.startsWith("/") ? out : null
    } catch {
      return null
    }
  },
  exists(p) {
    try {
      return fs.statSync(p).isFile()
    } catch {
      return false
    }
  },
}

/** 决策 4：config.codex.bin > PATH 里的 codex > ChatGPT.app 内置。全没有就抛。 */
export function resolveCodexBin(cfgBin: string | null, probe: BinProbe = defaultBinProbe): string {
  if (cfgBin) return cfgBin
  const w = probe.which("codex")
  if (w) return w
  if (probe.exists(CODEX_BIN_FALLBACK)) return CODEX_BIN_FALLBACK
  throw new Error(`找不到 codex 二进制：config.codex.bin 未设、PATH 里没有、${CODEX_BIN_FALLBACK} 也不在`)
}

export interface SpawnEngineOptions {
  seat: string
  instanceId: string
  cwd: string
  /** 缺省按 resolveCodexBin 解析 */
  bin?: string | null
  extraArgs?: readonly string[]
  /** CODEX_HOME 覆盖 */
  codexHome?: string | null
  env?: NodeJS.ProcessEnv
  pidFile: string
  stderrLog?: string | null
}

export interface SpawnedEngine {
  child: ChildProcess
  pid: number
  pgid: number
  bin: string
  args: string[]
  cmdline: string
  startedAt: string
}

export function spawnAppServer(opts: SpawnEngineOptions): SpawnedEngine {
  const bin = opts.bin ?? resolveCodexBin(null)
  const args = buildAppServerArgs(opts.seat, opts.instanceId, opts.extraArgs ?? [])
  const env = scrubProcessEnv({ ...(opts.env ?? process.env) })
  if (opts.codexHome) env.CODEX_HOME = opts.codexHome

  const child = spawn(bin, args, {
    cwd: opts.cwd,
    env,
    detached: true, // ← 独立进程组，stop 才能 kill(-pgid)
    stdio: ["pipe", "pipe", "pipe"],
  })
  if (!child.pid) throw new Error(`spawn ${bin} 没拿到 pid`)

  if (opts.stderrLog) {
    fs.mkdirSync(path.dirname(opts.stderrLog), { recursive: true })
    const s = fs.createWriteStream(opts.stderrLog, { flags: "a" })
    child.stderr?.pipe(s)
  }

  const startedAt = new Date().toISOString()
  const cmdline = [bin, ...args].join(" ")
  // detached 起来的 pgid = pid（POSIX setpgid(0,0)）
  writePidFile(opts.pidFile, { pid: child.pid, pgid: child.pid, startedAt, cmdline, instanceId: opts.instanceId })

  return { child, pid: child.pid, pgid: child.pid, bin, args, cmdline, startedAt }
}

/**
 * `codex --version`。必须把 CODEX_HOME 一起传进去 —— 不传的话它会按 $HOME 去建 helper 目录，
 * 在私有 HOME（临时目录）下会打一行 "Refusing to create PATH aliases…" 的警告到 stderr，
 * 混进 sidecar 日志里看着像出错了。
 */
export function codexVersion(bin: string, codexHome?: string | null): string | null {
  try {
    const env = codexHome ? { ...process.env, CODEX_HOME: codexHome } : process.env
    return execFileSync(bin, ["--version"], { encoding: "utf-8", timeout: 10_000, env }).trim() || null
  } catch {
    return null
  }
}
