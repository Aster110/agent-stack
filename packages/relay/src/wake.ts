/**
 * WakeHook — 温唤醒接缝（第一块砖，**只做接缝不做完整唤醒器**）
 *
 * 场景：消息投给 pull 模式节点（GUI Claude app 这类没有 pane 的端点）时，
 * 若此刻没有活跃消费者（没人挂 /api/sync 长轮询、上次 sync 也已陈旧），
 * 消息只会静静躺在库里——没人醒，也没人知道该醒。
 *
 * 这里做两件小事，都不含「怎么唤醒」的知识：
 *   ① 往事件总线广播 wake:needed（nodeId + parkedCount），SSE 订阅者自己决定怎么办
 *   ② 若 env MESH_WAKE_HOOK 设了，exec 它并把 nodeId 作为**最后一个参数**追加，
 *      fire-and-forget，失败只记日志
 *
 * 缺省不设 MESH_WAKE_HOOK = 只发事件、一个进程都不起 → 零风险。
 *
 * 安全：**永不走 shell**。nodeId 的 shortId 段来自 POST /api/register 的请求体，
 * 是外部可控输入；shell=true 就是命令注入洞。hookCommand 按空白拆成 argv
 * （允许固定参数，如 "/usr/bin/osascript /path/wake.scpt"），nodeId 永远只是
 * argv 里的一个元素，不可能被解释成命令。
 */
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import type { MeshEventBus } from "./events.js"

/** 同一节点的唤醒去抖窗：60 秒内重复投递不重复触发。 */
export const WAKE_DEBOUNCE_MS = 60_000

/** 全局限速的滚动窗口：1 小时。 */
export const WAKE_GLOBAL_WINDOW_MS = 3_600_000

/** 全局限速缺省额度：滚动 1h 内最多 12 次真触发。 */
export const WAKE_GLOBAL_HOURLY_MAX = 12

/** hook 子进程的硬超时——唤醒脚本卡死不许攒进程。 */
const WAKE_EXEC_TIMEOUT_MS = 10_000

/** 这次 notify 是谁引出来的（审计流水靠它区分边沿触发与补铃）。 */
export type WakeSource = "send" | "downlink" | "sweep"

export type WakeDecision = "fired" | "suppressed_global_cap"

/**
 * 一条 wake 审计流水。缺口 G4：原本 wake 的结果只有一行 console.warn，
 * 出了事查无对证。这些行由接线处落到 @ledger 哨兵（落库即 delivered、不投递、
 * 不触发任何门铃），经既有 ledger_sync 自动上云。
 */
export interface WakeAuditEntry {
  /** 因果链的串号：同一次唤醒的 relay 行 / hook 行 / porter 行共用它 */
  wakeId: string
  nodeId: string
  parkedCount: number
  decision: WakeDecision
  source: WakeSource
  /** 是否真起了 hook 进程（没配 MESH_WAKE_HOOK 就是 false） */
  hook: boolean
  /** sweeper 补铃专有：这次对账看到多少条积压 */
  backlog?: number
  /** sweeper 补铃专有：这是第几次补（1 起） */
  attempt?: number
}

export interface WakeNotifyContext {
  source?: WakeSource
  backlog?: number
  attempt?: number
}

export interface WakeHookOptions {
  /**
   * 总开关。relay 里由 env `MESH_WAKE=1` 决定，**默认关**——
   * 关着的时候 notify() 直接返回 false：不广播事件、不起进程，零行为零回归。
   * 这里默认 true 是为了让显式 new WakeHook({...}) 的调用方（含单测）拿到的是
   * "我要一个唤醒器"的直觉语义；是否启用的策略判断留在接线处。
   */
  enabled?: boolean
  /** 事件总线；不给就只 exec 不广播（两条腿互相独立） */
  events?: MeshEventBus
  /** 唤醒命令，通常来自 env MESH_WAKE_HOOK。空/空白 = 没配 */
  hookCommand?: string
  /** 去抖窗，缺省 WAKE_DEBOUNCE_MS */
  debounceMs?: number
  /**
   * 全局限速：滚动 1h 内真触发次数达到它就一律压制。缺省 WAKE_GLOBAL_HOURLY_MAX(12)。
   * <=0 = 不限速（逃生阀）。
   *
   * 为什么去抖不够：去抖只管单节点。100 个冷节点同时来信 = 100 次真触发 =
   * 100 个 hook 进程 + 100 次 poke，每次 poke 都烧一个模型 turn。
   */
  globalHourlyMax?: number
  /** 时钟注入点（测试用假时钟，不靠 sleep 测去抖） */
  now?: () => number
  /** 进程启动注入点（测试用 spy，不真起进程） */
  run?: (bin: string, args: string[], opts?: { env?: Record<string, string> }) => void
  /** 日志注入点 */
  log?: (msg: string) => void
  /** 审计流水注入点（接线处把它写进 @ledger）。抛异常只记日志，不冒泡。 */
  audit?: (entry: WakeAuditEntry) => void
}

export class WakeHook {
  private lastFiredAt = new Map<string, number>()
  /** 滚动窗内每次真触发的时间戳（升序），用于全局限速 */
  private firedAt: number[] = []
  private readonly argv: string[]
  private readonly debounceMs: number
  private readonly globalHourlyMax: number
  private readonly now: () => number
  private readonly run: (bin: string, args: string[], opts?: { env?: Record<string, string> }) => void
  private readonly log: (msg: string) => void
  private readonly enabled: boolean

  constructor(private readonly opts: WakeHookOptions = {}) {
    this.enabled = opts.enabled !== false
    this.argv = (opts.hookCommand ?? "").trim().split(/\s+/).filter((s) => s.length > 0)
    this.debounceMs = opts.debounceMs ?? WAKE_DEBOUNCE_MS
    this.globalHourlyMax = opts.globalHourlyMax ?? WAKE_GLOBAL_HOURLY_MAX
    this.now = opts.now ?? (() => Date.now())
    this.run = opts.run ?? defaultRun
    this.log = opts.log ?? ((m) => console.warn(m))
  }

  /** 唤醒器是否启用（MESH_WAKE=1）。 */
  get isEnabled(): boolean {
    return this.enabled
  }

  /** 配了 hook 命令没有（空白串视同没配）。 */
  get hasHook(): boolean {
    return this.argv.length > 0
  }

  /**
   * 「这个节点需要被唤醒」。返回是否真触发（false = 被去抖或全局限速吞掉）。
   * 去抖同时压住事件和 exec——「不重复触发」就是两条腿都不动。
   *
   * 三道闸的先后有讲究：
   *   总开关 → 同节点去抖 → 全局限速 → 触发
   * 去抖必须在限速**之前**：被去抖吞掉的那次根本不是一次新唤醒，不该消耗全局额度。
   * 被限速压制时**不写去抖时间戳**：压制是全局状态，不该把这个节点单独关小黑屋——
   * 额度一释放它就该能响。
   */
  notify(nodeId: string, parkedCount: number, ctx: WakeNotifyContext = {}): boolean {
    // 总开关关着 = 彻底不动：不广播、不 exec、不记账、连去抖时间戳都不记
    if (!this.enabled) return false
    const t = this.now()
    const last = this.lastFiredAt.get(nodeId)
    if (last != null && t - last < this.debounceMs) return false

    const source = ctx.source ?? "send"
    if (this.isGloballyCapped(t)) {
      this.writeAudit({
        wakeId: randomUUID(),
        nodeId,
        parkedCount,
        decision: "suppressed_global_cap",
        source,
        hook: false,
        backlog: ctx.backlog,
        attempt: ctx.attempt,
      })
      this.log(
        `[mesh] wake 被全局限速压制 (node=${nodeId}, 滚动1h已触发 ${this.firedAt.length}/${this.globalHourlyMax})`,
      )
      return false
    }

    this.lastFiredAt.set(nodeId, t)
    this.firedAt.push(t)
    const wakeId = randomUUID()

    this.opts.events?.emit("wake:needed", { nodeId, parkedCount })

    if (this.hasHook) {
      // fire-and-forget：hook 炸了是 hook 的事，绝不许拖垮这条投递
      try {
        // nodeId 恒为最后一个 argv（外部可控输入只当数据）；
        // wake_id 走 env 而不是 argv——它是我们自己生成的 uuid，走 env 就不用动
        // 「nodeId 是最后一个参数」这条已被测试钉死的契约。
        this.run(this.argv[0]!, [...this.argv.slice(1), nodeId], { env: { MESH_WAKE_ID: wakeId } })
      } catch (err) {
        this.log(`[mesh] wake hook 启动失败 (node=${nodeId}): ${(err as Error)?.message ?? err}`)
      }
    }

    this.writeAudit({
      wakeId,
      nodeId,
      parkedCount,
      decision: "fired",
      source,
      hook: this.hasHook,
      backlog: ctx.backlog,
      attempt: ctx.attempt,
    })
    return true
  }

  /** 节点注销时清掉它的去抖记录，别无限攒 key。 */
  forget(nodeId: string): void {
    this.lastFiredAt.delete(nodeId)
  }

  /** 滚动窗内已用掉的额度（排障/看板用）。 */
  get firedInWindow(): number {
    this.pruneWindow(this.now())
    return this.firedAt.length
  }

  /** 滚动窗剪枝后判断额度是否用尽。globalHourlyMax<=0 = 不限速。 */
  private isGloballyCapped(t: number): boolean {
    if (this.globalHourlyMax <= 0) return false
    this.pruneWindow(t)
    return this.firedAt.length >= this.globalHourlyMax
  }

  private pruneWindow(t: number): void {
    const cutoff = t - WAKE_GLOBAL_WINDOW_MS
    // firedAt 天然升序（now() 单调），从头砍即可
    let i = 0
    while (i < this.firedAt.length && this.firedAt[i]! <= cutoff) i++
    if (i > 0) this.firedAt.splice(0, i)
  }

  private writeAudit(entry: WakeAuditEntry): void {
    if (!this.opts.audit) return
    try {
      this.opts.audit(entry)
    } catch (err) {
      // 记账炸了不许拖垮投递——审计是旁路，不是主路
      this.log(`[mesh] wake 审计写入失败 (node=${entry.nodeId}): ${(err as Error)?.message ?? err}`)
    }
  }
}

/** 真实进程启动：execFile（无 shell），子进程 unref，失败只记日志。 */
function defaultRun(bin: string, args: string[], opts?: { env?: Record<string, string> }): void {
  const child = execFile(
    bin,
    args,
    { timeout: WAKE_EXEC_TIMEOUT_MS, env: { ...process.env, ...(opts?.env ?? {}) } },
    (err) => {
      if (err) console.warn(`[mesh] wake hook 执行失败 (${bin} ${args.join(" ")}): ${err.message}`)
    },
  )
  // 别让唤醒脚本吊住 relay 的退出
  child.unref?.()
}
