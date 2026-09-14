/**
 * 孤儿 app-server 的识别与清理。
 *
 * 为什么谓词必须这么严：
 *   实测（computer2 2026-09-02）ChatGPT.app 自己就在跑
 *     `/Applications/ChatGPT.app/Contents/Resources/codex app-server --listen stdio://`
 *   —— 与我们的 `APP_SERVER_BASE_ARGS` 逐字重合。谁要是拿「命令行含 app-server」当判据去清孤儿，
 *   第一次清就会把 aster 正在用的 ChatGPT 干掉。
 *
 * 判据（**席位标签优先**，顺序有意义）：
 *   1. 有 `app-server` 子命令；
 *   2. 带我们自己打的席位标签 `codex_seat.tag="<seat>/<instanceId>"` → 就是我们的进程，
 *      **二进制在哪都认**（实测 codex 对未知 -c 键既不报错也不告警，退出码 0；
 *      标签在 wrapper 与 rust 本体的 `ps -o command=` 里都看得到）；
 *   3. 无我方标签时才走路径级硬否决：命令行含 `/Applications/ChatGPT.app/` 一律不碰。
 *
 * 为什么第 2 步必须排在路径否决前面：
 *   mini 与 computer1 的 `codex-main2` 把 `codex.bin` 直接指到
 *   `/Applications/ChatGPT.app/Contents/Resources/codex`（0.152.1）—— 我们自己起的引擎与 ChatGPT 自己的
 *   共用同一条二进制路径。路径级硬否决在那两台上会把**我们自己的进程**也否掉，孤儿检测恒为 0、
 *   RUNBOOK §4.2 的清理路径整条失效，而且失效方式是「一切正常」，没有任何报错。
 *   保护并没有因此变弱：ChatGPT.app 自己起的 app-server 从不带这个 tag（见 proc.test.ts 里逐字抄自 ps 的两条真命令行）。
 *
 * 谓词的阳性对照在 e2e E08：先起一个真的带标签的 app-server，证明这把尺子量得出东西，
 * 再去断言「没有孤儿」。反过来（先断言 0 再说没问题）就是坏尺子伪装成发现。
 */
import type { ProcInfo, SysProcOps } from "./ops.js"
import { defaultSysProcOps } from "./ops.js"

export const SEAT_TAG_KEY = "codex_seat.tag"
/** 路径级硬否决：**无我方席位标签**的 ChatGPT.app app-server 一律不碰（有标签的是我们自己起的，见下） */
export const CHATGPT_APP_MARKER = "/Applications/ChatGPT.app/"

export function seatTag(seat: string, instanceId: string): string {
  return `${SEAT_TAG_KEY}="${seat}/${instanceId}"`
}

/** 追加到 app-server 参数末尾。codex 对未知 -c 键静默接受（实测 exit 0、stderr 空）。 */
export function seatTagArgs(seat: string, instanceId: string): string[] {
  return ["-c", seatTag(seat, instanceId)]
}

/** 只按席位匹配（不管是哪一代 instanceId） */
export function seatTagPrefix(seat: string): string {
  return `${SEAT_TAG_KEY}="${seat}/`
}

export function isOurAppServerCmd(cmd: string, seat: string): boolean {
  if (!cmd) return false
  if (!/(^|\s)app-server(\s|$)/.test(cmd)) return false
  // ① 席位标签优先：这标签只有我们自己注入（spawn.ts buildAppServerArgs），认它不认路径
  if (cmd.includes(seatTagPrefix(seat))) return true
  // ② 无我方标签 + ChatGPT.app 路径 = aster 自己的 ChatGPT，硬否决（挡在任何后续放宽判据前面）
  if (cmd.includes(CHATGPT_APP_MARKER)) return false
  // ③ 其余无标签进程（别的席位、别人的 codex）一律不认领
  return false
}

export interface OrphanCandidate {
  pid: number
  pgid: number
  cmd: string
}

export interface FindOrphansOptions {
  seat: string
  ops?: SysProcOps
  /** 当前引擎的进程组（它不是孤儿） */
  excludePgid?: number | null
  /** 额外豁免的 pid（缺省含自己与父进程） */
  excludePids?: number[]
}

export function findOrphans(opts: FindOrphansOptions): OrphanCandidate[] {
  const ops = opts.ops ?? defaultSysProcOps
  const exclude = new Set<number>(opts.excludePids ?? [process.pid, process.ppid])
  const rows: ProcInfo[] = ops.list()
  const out: OrphanCandidate[] = []
  for (const p of rows) {
    if (exclude.has(p.pid)) continue
    if (opts.excludePgid != null && p.pgid === opts.excludePgid) continue
    if (!isOurAppServerCmd(p.command, opts.seat)) continue
    out.push({ pid: p.pid, pgid: p.pgid, cmd: p.command })
  }
  return out
}

export interface SweepResult {
  found: OrphanCandidate[]
  swept: OrphanCandidate[]
  survivors: OrphanCandidate[]
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * 清孤儿：整组 TERM → 宽限 → 整组 KILL → 复查。
 * 返回 survivors 非空 = 没清干净，调用方要报出来而不是当没事。
 */
export async function sweepOrphans(
  opts: FindOrphansOptions & { graceMs?: number },
): Promise<SweepResult> {
  const ops = opts.ops ?? defaultSysProcOps
  const graceMs = opts.graceMs ?? 300
  const found = findOrphans(opts)
  if (found.length === 0) return { found, swept: [], survivors: [] }

  const pgids = [...new Set(found.map((o) => o.pgid))].filter((g) => g > 1)
  const selfPgid = ops.pgidOf(process.pid)
  for (const g of pgids) {
    if (selfPgid != null && g === selfPgid) continue // 自杀护栏
    ops.killGroup(g, "SIGTERM")
  }
  await sleep(graceMs)
  for (const g of pgids) {
    if (selfPgid != null && g === selfPgid) continue
    if (ops.groupPids(g).length > 0) ops.killGroup(g, "SIGKILL")
  }
  await sleep(Math.min(graceMs, 200))

  const survivors = findOrphans(opts)
  const survivorPids = new Set(survivors.map((s) => s.pid))
  return { found, swept: found.filter((o) => !survivorPids.has(o.pid)), survivors }
}
