/**
 * 进程工具：二进制解析、pid 文件、孤儿收尸。
 *
 * 两条实测教训写死在这里：
 * 1. **`codex` 在交互 shell 里是个会 `cd` 的函数**（computer2 实测：
 *    `codex () { cd ~/AIproject/coding-harness && command codex --dangerously-... }`）。
 *    所以解析二进制**只扫 PATH 目录里的真实可执行文件**，绝不 `sh -c` / `which` / `command -v`。
 * 2. **`/opt/homebrew/bin/codex` 是 node wrapper**（symlink 到 `@openai/codex/bin/codex.js`），
 *    它再 spawn rust 本体。只 `kill` wrapper 会留下 ppid=1 的 rust 孤儿抓着
 *    `~/.codex/thread-writer-locks/*.lock`，下次 resume 撞锁。所以**一律杀进程组**。
 */
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

import { CODEX_BIN_FALLBACK } from "../contracts.js"
import { type Logger, noopLogger } from "./logger.js"

export const ORPHAN_KILL_GRACE_MS = 300

// ---------------------------------------------------------------------------
// ProcOps：可替换的系统调用面（Lane C 集成时换成 src/proc 的实现，接口不变）
// ---------------------------------------------------------------------------

export interface ProcOps {
  isAlive(pid: number): boolean
  cmdline(pid: number): string | null
  /** 进程组 id；拿不到返回 null */
  pgid(pid: number): number | null
  kill(pid: number, signal: NodeJS.Signals): void
  /** kill(-pgid, sig)：整组一起走 */
  killGroup(pgid: number, signal: NodeJS.Signals): void
}

export const defaultProcOps: ProcOps = {
  isAlive(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch (err) {
      // EPERM = 进程在，只是不归我们；当作活着
      return (err as NodeJS.ErrnoException)?.code === "EPERM"
    }
  },
  cmdline(pid) {
    try {
      return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf-8" }).trim()
    } catch {
      return null
    }
  },
  pgid(pid) {
    try {
      const out = execFileSync("ps", ["-p", String(pid), "-o", "pgid="], { encoding: "utf-8" }).trim()
      const n = Number.parseInt(out, 10)
      return Number.isFinite(n) ? n : null
    } catch {
      return null
    }
  },
  kill(pid, signal) {
    try {
      process.kill(pid, signal)
    } catch {
      /* 已经没了 */
    }
  },
  killGroup(pgid, signal) {
    try {
      process.kill(-pgid, signal)
    } catch {
      /* 已经没了 */
    }
  },
}

// ---------------------------------------------------------------------------
// codex 二进制解析（决策 4）
// ---------------------------------------------------------------------------

export type CodexBinSource = "config" | "path" | "fallback"
export interface CodexBinResolution {
  bin: string
  source: CodexBinSource
}

function isExecutableFile(p: string): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false
    fs.accessSync(p, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * `config.codex.bin` > PATH 里的 `codex`（npm 装的 wrapper）> ChatGPT.app 内置。
 *
 * PATH 是**自己按目录扫的**，不经任何 shell：交互 shell 里那个会 cd 的 `codex` 函数
 * 一旦被触发，app-server 的 cwd 就悄悄跑到别的仓去了。
 */
export function resolveCodexBin(opts: {
  configBin?: string | null
  env?: NodeJS.ProcessEnv
  fallback?: string
}): CodexBinResolution {
  const configBin = opts.configBin?.trim()
  if (configBin) return { bin: configBin, source: "config" }

  const rawPath = opts.env?.PATH ?? ""
  for (const dir of rawPath.split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, "codex")
    if (isExecutableFile(candidate)) return { bin: candidate, source: "path" }
  }
  return { bin: opts.fallback ?? CODEX_BIN_FALLBACK, source: "fallback" }
}

/** `codex --version`，拿不到返回 null。不经 shell。 */
export function readCodexVersion(bin: string, timeoutMs = 5_000): string | null {
  try {
    const out = execFileSync(bin, ["--version"], { encoding: "utf-8", timeout: timeoutMs, stdio: ["ignore", "pipe", "ignore"] })
    const line = out.trim().split("\n")[0]?.trim()
    return line && line.length > 0 ? line : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// pid 文件
// ---------------------------------------------------------------------------

export interface EnginePidFile {
  pid: number
  /** detached 启动 → pgid = pid；停止必须 kill(-pgid) */
  pgid: number
  startedAt: string
  /** 写入时的命令行；pid 复用时用来判定"还是不是同一个进程" */
  cmdline: string
  instanceId: string | null
}

export function writePidFile(file: string, rec: EnginePidFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, JSON.stringify(rec), { encoding: "utf-8", mode: 0o600 })
  // writeFileSync 的 mode 只在**新建**时生效；已存在的文件要显式改
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* 只读文件系统等：不致命 */
  }
}

export function readPidFile(file: string): EnginePidFile | null {
  let raw: string
  try {
    raw = fs.readFileSync(file, "utf-8")
  } catch {
    return null
  }
  try {
    const o = JSON.parse(raw)
    if (typeof o?.pid !== "number") return null
    return {
      pid: o.pid,
      pgid: typeof o.pgid === "number" ? o.pgid : o.pid,
      startedAt: typeof o.startedAt === "string" ? o.startedAt : "",
      cmdline: typeof o.cmdline === "string" ? o.cmdline : "",
      instanceId: typeof o.instanceId === "string" ? o.instanceId : null,
    }
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

// ---------------------------------------------------------------------------
// 孤儿收尸
// ---------------------------------------------------------------------------

export type OrphanAction = "no-pid-file" | "self" | "dead" | "cmdline-mismatch" | "unsafe-pgid" | "killed"

export interface OrphanSweepResult {
  action: OrphanAction
  pid: number | null
  pgid: number | null
  /** SIGTERM 之后还活着，升级到 SIGKILL */
  escalated: boolean
}

export interface OrphanSweepOptions {
  file: string
  procOps?: ProcOps
  sleep?: (ms: number) => Promise<void>
  graceMs?: number
  /** cmdline 里必须出现的标记；默认 app-server */
  marker?: string
  /** 额外要求现在的 cmdline 与 pid 文件里记的一致（更严的防复用） */
  requireRecordedCmdline?: boolean
  selfPid?: number
  logger?: Logger
}

/**
 * 按 pid 文件收上一代引擎的尸。**任何一步存疑都选择不动手**——
 * 误杀别人的进程比留个孤儿贵得多。
 */
export async function killOrphanFromPidFile(opts: OrphanSweepOptions): Promise<OrphanSweepResult> {
  const ops = opts.procOps ?? defaultProcOps
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const grace = opts.graceMs ?? ORPHAN_KILL_GRACE_MS
  const marker = opts.marker ?? "app-server"
  const selfPid = opts.selfPid ?? process.pid
  const log = opts.logger ?? noopLogger

  const rec = readPidFile(opts.file)
  if (!rec) {
    // 文件不存在或坏了：坏了就顺手删掉，别留着下次再解析一遍
    if (fs.existsSync(opts.file)) clearPidFile(opts.file)
    return { action: "no-pid-file", pid: null, pgid: null, escalated: false }
  }

  const { pid, pgid } = rec
  if (!Number.isFinite(pid) || pid <= 1 || pid === selfPid) {
    clearPidFile(opts.file)
    return { action: "self", pid, pgid, escalated: false }
  }

  if (!ops.isAlive(pid)) {
    clearPidFile(opts.file)
    return { action: "dead", pid, pgid, escalated: false }
  }

  // pid 会被复用。不校验命令行就敢 kill，迟早误杀别人的进程。
  const cmd = ops.cmdline(pid) ?? ""
  const markerOk = cmd.includes(marker)
  const recordedOk = !opts.requireRecordedCmdline || (rec.cmdline.length > 0 && cmd === rec.cmdline)
  if (!markerOk || !recordedOk) {
    log.log("info", "orphan-skip-cmdline-mismatch", { pid, cmd: cmd.slice(0, 80) })
    clearPidFile(opts.file)
    return { action: "cmdline-mismatch", pid, pgid, escalated: false }
  }

  // kill(-1) 会杀掉本用户所有进程；kill 自己的组会连 sidecar 一起带走
  if (!Number.isFinite(pgid) || pgid <= 1 || pgid === selfPid) {
    log.log("warn", "orphan-skip-unsafe-pgid", { pid, pgid })
    return { action: "unsafe-pgid", pid, pgid, escalated: false }
  }

  log.log("info", "orphan-kill", { pid, pgid })
  ops.killGroup(pgid, "SIGTERM")
  await sleep(grace)
  let escalated = false
  if (ops.isAlive(pid)) {
    escalated = true
    ops.killGroup(pgid, "SIGKILL")
    await sleep(grace)
  }
  clearPidFile(opts.file)
  return { action: "killed", pid, pgid, escalated }
}
