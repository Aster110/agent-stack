/**
 * WakeSweeper — 水平触发补铃（缺口 G2）
 *
 * 现有 wake 是**纯边沿触发**：只在消息落地那一瞬判定一次。铃丢了就永远不再响：
 *   - hook exec 失败/超时（只有一行 console.warn）；
 *   - 消息落在门铃死亡后的 90s presence 新鲜窗内（hasActiveConsumer 的 freshness
 *     腿仍判「有人」→ 不响铃，此后再无新消息就永远停驻）；
 *   - porter 的 SSE 恰好在断线重连中（wake:needed 是广播、无重放，错过即丢）；
 *   - relay 重启把去抖表清空前后的夹缝。
 *
 * 这里做的事只有一件：**定期拿库里的事实对账**——
 *   「这个 pull 节点的直发积压 > 0，而且没人接货」→ 补一次铃。
 * 判据完全不依赖「有没有收到过事件」，所以上面四种丢铃都会在最多一个 sweep
 * 周期后被补上。系统语义由此从 at-most-once 升到 **at-least-once**。
 *
 * 三条设计约束：
 * 1. **零模型 turn**：全程 SQLite COUNT + 内存判定，一个模型 API 都不碰。
 *    空闲期它每 2 分钟醒一次，但那是 node 定时器，不是会话 turn。
 * 2. **不绕过任何既有闸门**：补铃走 wake.notify，去抖/全局限速/总开关照旧生效。
 * 3. **自己再加一道闸**：per-node 指数退避（120s 起，×2，封顶 1800s）。
 *    死透的席位不会被每 2 分钟摇一次——那是唤醒风暴的另一种形态。
 *    节点排空或消费者恢复即复位。
 *
 * 内存态（退避账）重启即清。语义安全：重启后最坏多响一次铃，而铃是幂等的。
 */
import { normalizeDeliveryMode } from "@cc-mesh/protocol"
import type { LocalNode } from "@cc-mesh/protocol"
import type { WakeHook } from "./wake.js"

/** 对账周期：2 分钟。丢的铃最多迟这么久被补上。 */
export const WAKE_SWEEP_INTERVAL_MS = 120_000

/** per-node 退避起步值。 */
export const WAKE_SWEEP_BASE_COOLDOWN_MS = 120_000

/** per-node 退避封顶：半小时。再久就该靠带外报警喊人了。 */
export const WAKE_SWEEP_MAX_COOLDOWN_MS = 1_800_000

/** sweeper 只需要 Registry 的这三个能力（窄接口 = 测试不用搭真注册表）。 */
export interface SweepableRegistry {
  getAll(): LocalNode[]
  hasActiveConsumer(nodeId: string): boolean
  getParkedCount(nodeId: string): number
}

/** sweeper 只需要 Store 的这两个能力。 */
export interface SweepableStore {
  getAckCursor(nodeId: string): number
  countDirectBacklog(nodeId: string, sinceSeq: number): number
}

export interface WakeSweeperOptions {
  registry: SweepableRegistry
  store: SweepableStore
  wake: WakeHook
  /** 对账周期，缺省 WAKE_SWEEP_INTERVAL_MS */
  intervalMs?: number
  /** 退避起步，缺省 WAKE_SWEEP_BASE_COOLDOWN_MS */
  baseCooldownMs?: number
  /** 退避封顶，缺省 WAKE_SWEEP_MAX_COOLDOWN_MS */
  maxCooldownMs?: number
  /** 时钟注入点（测试用假时钟） */
  now?: () => number
  /** 日志注入点 */
  log?: (msg: string) => void
}

export interface SweepReport {
  /** 这一轮扫了几个 pull 节点 */
  scanned: number
  /** 这一轮真补了铃的节点（notify 返回 true 的） */
  rang: string[]
}

interface NodeState {
  /** 上次真补铃的时刻；null = 还没补过，可立即补 */
  lastAttemptAt: number | null
  /** 下次补铃前要等多久 */
  cooldownMs: number
  /** 已经补过几次（写进审计流水，看得出这个节点叫了多久还没醒） */
  attempt: number
}

export class WakeSweeper {
  private readonly registry: SweepableRegistry
  private readonly store: SweepableStore
  private readonly wake: WakeHook
  private readonly intervalMs: number
  private readonly baseCooldownMs: number
  private readonly maxCooldownMs: number
  private readonly now: () => number
  private readonly log: (msg: string) => void
  private state = new Map<string, NodeState>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(opts: WakeSweeperOptions) {
    this.registry = opts.registry
    this.store = opts.store
    this.wake = opts.wake
    this.intervalMs = opts.intervalMs ?? WAKE_SWEEP_INTERVAL_MS
    this.baseCooldownMs = opts.baseCooldownMs ?? WAKE_SWEEP_BASE_COOLDOWN_MS
    this.maxCooldownMs = opts.maxCooldownMs ?? WAKE_SWEEP_MAX_COOLDOWN_MS
    this.now = opts.now ?? (() => Date.now())
    this.log = opts.log ?? ((m) => console.warn(m))
  }

  /** 当前在退避账里挂着的节点数（防内存无限增长的可观测点）。 */
  get trackedCount(): number {
    return this.state.size
  }

  get isRunning(): boolean {
    return this.timer != null
  }

  /**
   * 起定时器。返回是否真起来了。
   *
   * 两个前提：wake 总开关开着（关着 sweeper 一条铃都摇不响，起了就是纯空转），
   * 且逃生阀 MESH_WAKE_SWEEP != "0"。自守卫的好处：接线处无脑 start() 即可，
   * 「默认关」这条不变量只在这一个地方判。
   */
  start(): boolean {
    if (this.timer) return false
    if (!this.wake.isEnabled) return false
    if (process.env.MESH_WAKE_SWEEP === "0") return false
    this.timer = setInterval(() => { this.sweepOnce() }, this.intervalMs)
    // 别让对账定时器吊住 relay 的退出
    this.timer.unref?.()
    return true
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  /** 跑一轮对账。异常只记日志——一轮扫挂了不许打死定时器。 */
  sweepOnce(): SweepReport {
    const report: SweepReport = { scanned: 0, rang: [] }
    let alive: Set<string>
    try {
      const nodes = this.registry.getAll()
      alive = new Set<string>()
      for (const node of nodes) {
        const nodeId = node?.identity?.nodeId
        if (!nodeId) continue
        // 只扫 pull：inject/codex 席位的投递终态是 delivered/failed，
        // 结构上产生不了 accepted，也就不存在「消息躺在库里没人取」这回事。
        if (normalizeDeliveryMode(node.identity.deliveryMode) !== "pull") continue
        alive.add(nodeId)
        report.scanned++
        if (this.considerNode(nodeId)) report.rang.push(nodeId)
      }
    } catch (err) {
      this.log(`[mesh] wake sweeper 对账失败: ${(err as Error)?.message ?? err}`)
      return report
    }
    // 注册表里没有的节点从退避账里清掉（节点注销/清理后别攒 key）
    for (const nodeId of [...this.state.keys()]) {
      if (!alive.has(nodeId)) this.state.delete(nodeId)
    }
    return report
  }

  /** 返回是否真补了铃。 */
  private considerNode(nodeId: string): boolean {
    const since = this.store.getAckCursor(nodeId)
    const backlog = this.store.countDirectBacklog(nodeId, since)
    const hasConsumer = this.registry.hasActiveConsumer(nodeId)

    // 排空 或 消费者回来了 → 这一页翻过去，退避复位。
    // 复位很重要：席位醒来处理完一批之后再睡死，下一次积压该立刻响，
    // 不该背着上一轮攒到 1800s 的退避。
    if (backlog === 0 || hasConsumer) {
      this.state.delete(nodeId)
      return false
    }

    const t = this.now()
    const st = this.state.get(nodeId)
    if (st && st.lastAttemptAt != null && t - st.lastAttemptAt < st.cooldownMs) return false

    const attempt = (st?.attempt ?? 0) + 1
    const fired = this.wake.notify(nodeId, this.registry.getParkedCount(nodeId), {
      source: "sweep",
      backlog,
      attempt,
    })
    // 没真响（被去抖 / 被全局限速压制）就不记账：下一轮还该再试，
    // 不然限速期间的退避会白白翻倍，额度放开时反而叫不醒。
    if (!fired) return false

    this.state.set(nodeId, {
      lastAttemptAt: t,
      cooldownMs: Math.min((st?.cooldownMs ?? this.baseCooldownMs) * 2, this.maxCooldownMs),
      attempt,
    })
    return true
  }
}
