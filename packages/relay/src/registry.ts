import type { LocalNode } from "@cc-mesh/protocol"
import { now } from "@cc-mesh/protocol"

/**
 * presence 新鲜窗：距今多久内的 sync 还算「有人在听」。
 * /api/status 的 status 派生和 wake:needed 的触发判定共用它——
 * 两处各写一份阈值必然漂移（一处说 offline、一处不唤醒，节点就永远醒不过来）。
 */
export const PRESENCE_FRESH_MS = 90_000

export class Registry {
  private nodes = new Map<string, LocalNode>()
  // 方案 B PR1：presence 派生用的 sync 侧计数。协议 LocalNode 不动，
  // 这两条 sync 观测态存旁路 Map（parked=当前停车连接数，lastSyncAt=最近一次 sync 时间）。
  private parked = new Map<string, number>()
  private lastSyncAt = new Map<string, string>()
  // inject 节点的身份校验态（内存态，不持久化——每次重启都要重新验一遍）。
  // 在集合里 = 已确认「这个 session 还是当初那个 pane」，可以投。
  private injectVerified = new Set<string>()
  // 最近一次校验失败的原因，只为 /api/status 和排障可见
  private injectMismatch = new Map<string, string>()

  register(node: LocalNode): void {
    this.nodes.set(node.identity.nodeId, node)
    // 刚注册 = 指纹是此刻从活着的 session 上取的，天然已验证
    this.injectVerified.add(node.identity.nodeId)
    this.injectMismatch.delete(node.identity.nodeId)
  }

  unregister(nodeId: string): void {
    this.nodes.delete(nodeId)
    this.parked.delete(nodeId)
    this.lastSyncAt.delete(nodeId)
    this.injectVerified.delete(nodeId)
    this.injectMismatch.delete(nodeId)
  }

  get(nodeId: string): LocalNode | undefined {
    return this.nodes.get(nodeId)
  }

  getAll(): LocalNode[] {
    return Array.from(this.nodes.values())
  }

  heartbeat(nodeId: string): void {
    const node = this.nodes.get(nodeId)
    if (node) {
      node.lastSeen = now()
    }
  }

  cleanup(timeoutMs: number): string[] {
    const cutoff = Date.now() - timeoutMs
    const cleaned: string[] = []
    for (const [nodeId, node] of this.nodes) {
      if (new Date(node.lastSeen).getTime() < cutoff) {
        this.nodes.delete(nodeId)
        this.parked.delete(nodeId)
        this.lastSyncAt.delete(nodeId)
        cleaned.push(nodeId)
      }
    }
    return cleaned
  }

  // ===== sync presence（方案 B PR1）=====

  /** 每次 sync 调用刷新 lastSyncAt（无论立即返回还是停车）。 */
  touchSync(nodeId: string): void {
    this.lastSyncAt.set(nodeId, now())
  }

  /** sync 进入停车：parkedCount +1（并刷新 lastSyncAt）。 */
  markParked(nodeId: string): void {
    this.parked.set(nodeId, (this.parked.get(nodeId) ?? 0) + 1)
    this.lastSyncAt.set(nodeId, now())
  }

  /** sync 结算（事件/超时/断开三路之一）：parkedCount -1（floor 0）。 */
  unmarkParked(nodeId: string): void {
    const next = (this.parked.get(nodeId) ?? 0) - 1
    if (next <= 0) this.parked.delete(nodeId)
    else this.parked.set(nodeId, next)
  }

  getParkedCount(nodeId: string): number {
    return this.parked.get(nodeId) ?? 0
  }

  getLastSyncAt(nodeId: string): string | undefined {
    return this.lastSyncAt.get(nodeId)
  }

  /**
   * 有没有活跃消费者 = 这条消息投下去有没有人当场接。
   * parked>0（真挂着长轮询）或 lastSync 还新鲜（紧凑轮询的客户端，两次 sync 之间
   * 恰好没停车）→ 有人在听；否则没人，投下去只会躺在库里。
   *
   * 这是 presence 的**唯一定义**：/api/status 的 offline 派生与 wake:needed 的触发
   * 判定都走它，保证「显示 offline」和「该被唤醒」永远是同一件事。
   */
  hasActiveConsumer(nodeId: string, freshMs: number = PRESENCE_FRESH_MS): boolean {
    if ((this.parked.get(nodeId) ?? 0) > 0) return true
    const last = this.lastSyncAt.get(nodeId)
    if (last == null) return false
    const t = new Date(last).getTime()
    if (Number.isNaN(t)) return false
    return Date.now() - t < freshMs
  }

  // ===== inject 身份校验态 =====

  /** 这个 inject 节点是否已确认身份（恢复态节点在首次投递校验通过前恒 false）。 */
  isInjectVerified(nodeId: string): boolean {
    return this.injectVerified.has(nodeId)
  }

  /** 校验通过：转 online，之后不再重复敲 tmux。 */
  markInjectVerified(nodeId: string): void {
    this.injectVerified.add(nodeId)
    this.injectMismatch.delete(nodeId)
  }

  /**
   * 校验不过（session 没了 / 同名换人）：保持未验证 → /api/status 派生 offline，
   * 消息只落库不投。不是永久判决——真身回来后下一条消息会重新校验并自愈。
   */
  markInjectMismatch(nodeId: string, reason: string): void {
    this.injectVerified.delete(nodeId)
    this.injectMismatch.set(nodeId, reason)
  }

  getInjectMismatch(nodeId: string): string | undefined {
    return this.injectMismatch.get(nodeId)
  }

  /**
   * 从持久层恢复注册表（relay 重启后调一次）。
   *
   * 治的病：注册表原本只在内存，relay 一重启就空。pull 模式节点（GUI Claude app）
   * 于是全体失联**且不自知**——消息落库没人醒，它自己 sync 还被回 404 node not
   * registered。注册信息本来就落了 nodes 表，缺的只是启动时读回来。
   *
   * 语义红线：
   * - **只恢复身份，不恢复 presence**。parked / lastSyncAt 一律不填，于是 pull 节点
   *   在 /api/status 的派生里自然落到 offline，直到它自己下一次 sync 才转 idle。
   *   恢复 ≠ 宣布在线。
   * - lastSeen / status 原样用库里的值（不是 now()），不伪造「刚刚还活着」。
   * - 已在内存里的同 nodeId 不覆盖：正常启动期恢复先于任何注册，这条是防御性的——
   *   万一恢复晚于一次真注册，新鲜的真注册赢，别被旧库行打回去。
   * - sync 游标不归它管：ack_cursors 本就持久化，身份一恢复老游标自动继续有效。
   *
   * 返回真正进了内存的条数。
   */
  restoreAll(nodes: LocalNode[]): number {
    let restored = 0
    for (const node of nodes) {
      const nodeId = node?.identity?.nodeId
      // 脏行跳过：一行坏数据不该挡住整批恢复（老库/手改容错）
      if (!nodeId) continue
      if (this.nodes.has(nodeId)) continue
      this.nodes.set(nodeId, node)
      restored++
    }
    return restored
  }

  findByShortId(shortId: string): LocalNode | undefined {
    for (const node of this.nodes.values()) {
      if (node.identity.shortId === shortId) return node
    }
    return undefined
  }
}
