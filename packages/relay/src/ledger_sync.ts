/**
 * LedgerSync（B2）—— relay 本地账本 → 云端 Ledger 的游标批量上行。
 * 设计：features/云端账本与调度接口-设计-2026-08-27.md §4.2。
 *
 * 语义三句话：
 *  1. 本地 mesh.db 是一级真相，也是发送队列——离线不丢，靠游标续传（不另建 outbox 表）。
 *  2. 只有收到 Hub 的 `ledger_ack {upToSeq}` 才推进游标；没 ack 就下轮重发同批
 *     （Hub 侧按 msg.id `INSERT OR IGNORE` 幂等，重发不产生重复行）。
 *  3. uplink 断开时本轮直接跳过——不缓存、不重试队列，重连后照样从游标续。
 *
 * 逃生阀：env `MESH_LEDGER_SYNC=0` 整体停用（不装 timer、不发批）。
 */
import {
  LEDGER_SYNC_BATCH,
  LEDGER_SYNC_DEBOUNCE_MS,
  LEDGER_SYNC_INTERVAL_MS,
} from "@cc-mesh/protocol"
import type { LedgerMessageEvent, LedgerUplinkEvent } from "@cc-mesh/protocol"
import type { LedgerRow } from "./store.js"

/** 游标存黑板（复用现成 KV，零新表）。 */
export const LEDGER_CURSOR_KEY = "ledger.sync.cursor"
const CURSOR_UPDATED_BY = "ledger-sync"

/** LedgerSync 只需要 Store 的这三个口（窄接口，测试可注假）。 */
export interface LedgerSyncStore {
  getMessagesSinceSeq(since: number, limit: number): LedgerRow[]
  kvGet(key: string): { value: string } | undefined
  kvSet(key: string, value: string, updatedBy: string): void
}

/** LedgerSync 只需要 uplink 的这三个口（WebSocketUplink 天然满足）。 */
export interface LedgerSyncUplink {
  isConnected(): boolean
  sendLedger(relayId: string, events: LedgerUplinkEvent[]): unknown
  onLedgerAck?(cb: (upToSeq: number) => void): void
}

export interface LedgerSyncOptions {
  store: LedgerSyncStore
  uplink: LedgerSyncUplink
  relayId: string
  batch?: number
  debounceMs?: number
  intervalMs?: number
  /** 注入 env 便于测试逃生阀；缺省读 process.env。 */
  env?: NodeJS.ProcessEnv
}

export class LedgerSync {
  private readonly store: LedgerSyncStore
  private readonly uplink: LedgerSyncUplink
  private readonly relayId: string
  private readonly batch: number
  private readonly debounceMs: number
  private readonly intervalMs: number
  readonly enabled: boolean

  private debounceTimer: NodeJS.Timeout | null = null
  private intervalTimer: NodeJS.Timeout | null = null
  private started = false

  constructor(opts: LedgerSyncOptions) {
    this.store = opts.store
    this.uplink = opts.uplink
    this.relayId = opts.relayId
    this.batch = opts.batch ?? LEDGER_SYNC_BATCH
    this.debounceMs = opts.debounceMs ?? LEDGER_SYNC_DEBOUNCE_MS
    this.intervalMs = opts.intervalMs ?? LEDGER_SYNC_INTERVAL_MS
    const env = opts.env ?? process.env
    this.enabled = env.MESH_LEDGER_SYNC !== "0"
  }

  /** 接线 ack 回调 + 起兜底定时器（unref：账本同步不该把进程钉住不退）。 */
  start(): void {
    if (!this.enabled || this.started) return
    this.started = true
    this.uplink.onLedgerAck?.((upToSeq) => this.handleAck(upToSeq))
    this.intervalTimer = setInterval(() => this.flush(), this.intervalMs)
    this.intervalTimer.unref?.()
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer)
      this.intervalTimer = null
    }
    this.started = false
  }

  /** 每次消息落库后调这个：debounce 合并写风暴，窗口内多次写只发一批。 */
  notifyWrite(): void {
    if (!this.enabled) return
    if (this.debounceTimer) return
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      this.flush()
    }, this.debounceMs)
    this.debounceTimer.unref?.()
  }

  /** 当前游标（KV 里的 seq；未同步过/脏值 → 0）。 */
  cursor(): number {
    const raw = this.store.kvGet(LEDGER_CURSOR_KEY)?.value
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
  }

  /**
   * 发一批：游标之后最多 batch 条，按 seq 升序。
   * 返回实际发出的事件数（0 = 停用/断连/无新行/发送失败）。
   */
  flush(): number {
    if (!this.enabled) return 0
    // 断连本轮跳过——本地库就是队列，重连后从游标续，一条不丢。
    if (!this.uplink.isConnected()) return 0
    const since = this.cursor()
    const rows = this.store.getMessagesSinceSeq(since, this.batch)
    if (rows.length === 0) return 0
    const events: LedgerUplinkEvent[] = rows.map(toLedgerEvent)
    this.uplink.sendLedger(this.relayId, events)
    return events.length
  }

  /**
   * 收到 Hub 的 ledger_ack：游标推进到 max(当前, upToSeq) 并落 KV。
   * 取 max 防倒退（乱序/重复 ack 不把游标拉回去重发一堆已入账的行）。
   * 推进成功后立刻再 flush 一次——把攒着的大 backlog 一批接一批排干，不用等 30s 兜底。
   */
  handleAck(upToSeq: number): void {
    if (!this.enabled) return
    if (!Number.isFinite(upToSeq)) return
    const current = this.cursor()
    const next = Math.max(current, Math.floor(upToSeq))
    if (next <= current) return
    this.store.kvSet(LEDGER_CURSOR_KEY, String(next), CURSOR_UPDATED_BY)
    this.flush()
  }
}

/** 库行 → 上行事件。srcSeq = 本机 messages.seq，是 Hub 回 ack 的对账依据。 */
function toLedgerEvent(row: LedgerRow): LedgerMessageEvent {
  const { status, priority, seq, ...msg } = row
  return { kind: "message", msg: { ...msg, seq }, status, priority, srcSeq: seq }
}
