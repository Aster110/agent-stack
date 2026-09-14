/**
 * D1Forwarder —— 热层账本（s3 ledger.db）→ 云端冷层（CF Worker + D1）的异步游标转发，
 * 外加热层的保留清理。
 *
 * 设计：features/展示面mesh-console与D1冷层-设计-2026-08-27.md §3（/ingest 契约）+ §6（本模块条款）。
 *
 * 五句话说清语义：
 *  1. **默认不存在**。`CONSOLE_INGEST_URL` + `CONSOLE_INGEST_TOKEN` 两个 env 缺任何一个 =
 *     完全关闭 = 一个定时器不装、一个请求不发、一行不删。s3 上不设 env 就是零回归。
 *  2. **旁路，不是管道**。转发跑在自己的定时器上，LedgerSync 的投影写路径对它零依赖零等待——
 *     投影器写完即返回，转发挂了、慢了、云端 500 了，热层照记不误。
 *  3. **两类表两套策略**（2026-08-27 主 cc 仲裁）：
 *     - **流水表**（ledger_messages / quota_snapshots / events，只 INSERT 不 UPDATE）
 *       走 rowid 游标增量，云端 `INSERT OR IGNORE`；
 *     - **快照表**（tasks / seats / accounts，会被 UPDATE）**整表全量推**，云端 `INSERT OR REPLACE`。
 *       行游标对可变行天生失效——rowid 不随 UPDATE 变，只转一次的话
 *       task 的 dispatched→replied 永远到不了云端，看板的状态机着色就是死的。
 *  4. **只有 2xx 才算数**。流水表失败不推游标、快照表失败不记 digest，原地重发同一批
 *     （云端幂等，重发不产生脏数据），失败次数换指数退避 1s→60s 封顶。
 *  5. **先转发后删**。清理只碰 ledger_messages，且只删「已确认落 D1」且「超出 7 天热窗口」的行。
 *     seats / accounts / tasks 连被传进删除函数的资格都没有。
 */
import { createHash } from "node:crypto"
import type { LedgerStore, ForwardableTable } from "./store.js"
import { FORWARDABLE_TABLES } from "./store.js"

// ===== 常量 =====

/** 冷层要的全量六表（复用 store 的白名单，避免两处漂移）。 */
export const FORWARD_TABLES = FORWARDABLE_TABLES
export type ForwardTable = ForwardableTable

/**
 * **流水表**：只追加不改写 → rowid 游标增量推，转过的行永不重发。
 * （quota_snapshots / events 都是 AUTOINCREMENT 追加；ledger_messages 是 INSERT OR IGNORE。）
 */
export const STREAM_TABLES: readonly ForwardTable[] = [
  "ledger_messages", "quota_snapshots", "events", "cc_todo_changes",
]

/**
 * **快照表**：行会被 UPDATE（task 关单、seat 改配、account 改标签）→ **整表全量推**。
 * 行数几十级，成本可忽略；换来的是云端状态永远跟得上热层。
 * 靠内容 digest 去重：库里没变就一个请求都不发，不烧 D1 的每日写额度。
 */
export const SNAPSHOT_TABLES: readonly ForwardTable[] = ["tasks", "seats", "accounts", "cc_todo_items"]

/**
 * **唯一允许被保留清理触碰的表**（设计 §6 删除三纪律 ①）。
 * 这是常量不是配置项：seats（席位）/ accounts（油箱清单）/ tasks（调度算法的训练数据）
 * 都是小表且不可再生，任何情况下都不删。events / quota_snapshots 本期也不清。
 */
export const RETENTION_TABLES: readonly ForwardTable[] = ["ledger_messages"]

/** 单批行数上限（云端 >500 行拒收 413，留足余量）。 */
export const DEFAULT_FORWARD_BATCH = 200
/** 快照表整表读的内存护栏；撞上了说明这张"小表"该改增量了，会吼一嗓子。 */
export const DEFAULT_SNAPSHOT_MAX_ROWS = 50_000
/** 兜底轮询周期：没人写也定期看一眼有没有漏的。 */
export const DEFAULT_FORWARD_INTERVAL_MS = 10_000
/** 写后 debounce：一波写风暴合并成一批。 */
export const DEFAULT_FORWARD_DEBOUNCE_MS = 2_000
/** 一批成功且还有积压时，隔多久接着排下一批。 */
export const DEFAULT_DRAIN_DELAY_MS = 50
export const DEFAULT_MIN_BACKOFF_MS = 1_000
export const DEFAULT_MAX_BACKOFF_MS = 60_000
/** 单次 POST 超时：卡死的连接不许把转发循环钉住。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
export const DEFAULT_RETENTION_DAYS = 7
/** 清理每日一次（设计 §6 纪律 ③）。 */
export const DEFAULT_CLEANUP_INTERVAL_MS = 24 * 3600_000
/** watermark.source：云端 ingest_watermarks 的主键。 */
export const DEFAULT_WATERMARK_SOURCE = "s3-hub"

const MAX_FAILURE_EXPONENT = 40

// ===== 类型 =====

export interface FetchInit {
  method: string
  headers: Record<string, string>
  body: string
  signal?: AbortSignal
}

export interface FetchResponseLike {
  status: number
  text?: () => Promise<string>
}

/** 窄化的 fetch 口子：测试注假，生产用全局 fetch（Node 18+ 自带，不引 undici 依赖）。 */
export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponseLike>

export interface RetentionOptions {
  /** 缺省 false —— 对账通过前绝不开（设计 §7 部署顺序第 6 步）。 */
  enabled?: boolean
  /** 热窗口天数，缺省 7。 */
  days?: number
  /** 清理周期，缺省 24h。 */
  intervalMs?: number
}

export interface ForwarderOptions {
  store: LedgerStore
  /** 云端基址（会自动补 /ingest）。空 → 整体关闭。 */
  url: string
  /** Bearer token。空 → 整体关闭。 */
  token: string
  batch?: number
  intervalMs?: number
  debounceMs?: number
  drainDelayMs?: number
  minBackoffMs?: number
  maxBackoffMs?: number
  timeoutMs?: number
  source?: string
  /** 快照表最快多久检查一次（本地 digest 比对，没变不发请求）。缺省 = intervalMs。 */
  snapshotIntervalMs?: number
  snapshotMaxRows?: number
  retention?: RetentionOptions
  fetchImpl?: FetchLike
  quiet?: boolean
}

export type FlushReason = "disabled" | "stopped" | "busy" | "empty" | "http" | "network" | "sent"

export interface FlushResult {
  ok: boolean
  /** 本批实际发出的行数。 */
  sent: number
  /** 每表发了几行。 */
  tables: Partial<Record<ForwardTable, number>>
  status?: number
  reason: FlushReason
}

export type SnapshotReason =
  | "disabled" | "stopped" | "busy" | "throttled" | "unchanged" | "http" | "network" | "sent"

export interface SnapshotResult {
  ok: boolean
  /** 本轮全量推出去的行数（快照表内容没变时为 0，且不发请求）。 */
  sent: number
  tables: Partial<Record<ForwardTable, number>>
  /** 实际发了几个请求（表大到装不下一批时会分块）。 */
  requests: number
  status?: number
  reason: SnapshotReason
}

export type CleanupReason = "disabled" | "no-watermark" | "done"

export interface CleanupResult {
  deleted: number
  /** 本次授权删除所用的行游标（= 已确认落 D1 的最大 rowid）。 */
  watermark: number
  /** 时间下界（早于它的才删）。 */
  cutoff: string | null
  dbSizeBytes: number
  reason: CleanupReason
}

export interface ForwarderEnvConfig {
  url: string
  token: string
  retention: { enabled: boolean; days: number }
}

// ===== 纯函数 =====

/** 基址 → ingest 端点。尾斜杠归一，已经指到 /ingest 就不重复拼。 */
export function resolveIngestUrl(base: string): string {
  const trimmed = (base ?? "").trim().replace(/\/+$/, "")
  if (!trimmed) return ""
  return trimmed.endsWith("/ingest") ? trimmed : `${trimmed}/ingest`
}

/**
 * env → 转发配置。**双缺省（或只给一半）一律返回 null**：半配置比没配置更危险
 * （有 url 没 token 会朝云端打一串 401，有 token 没 url 更是无处可去），fail-closed。
 *
 * 清理是**第二个开关**：`LEDGER_RETENTION_DAYS` 给正数才开。转发跑通、六表对账一致之后
 * 才由人打开——这是"先转发后删"在部署层面的落点。
 */
export function forwarderFromEnv(env: NodeJS.ProcessEnv = process.env): ForwarderEnvConfig | null {
  const url = (env.CONSOLE_INGEST_URL ?? "").trim()
  const token = (env.CONSOLE_INGEST_TOKEN ?? "").trim()
  if (!url || !token) return null

  const raw = (env.LEDGER_RETENTION_DAYS ?? "").trim()
  const days = Number(raw)
  const enabled = raw !== "" && Number.isFinite(days) && days > 0
  return { url, token, retention: { enabled, days: enabled ? days : DEFAULT_RETENTION_DAYS } }
}

const defaultFetch: FetchLike = async (url, init) => {
  const f = (globalThis as {
    fetch?: (u: string, i: unknown) => Promise<{ status: number; text(): Promise<string> }>
  }).fetch
  if (!f) throw new Error("当前 Node 没有全局 fetch（需要 Node 18+）")
  return f(url, init)
}

// ===== Forwarder =====

interface BatchPlan {
  batches: Array<{ table: ForwardTable; rows: Array<Record<string, unknown>> }>
  cursors: Array<[ForwardTable, number]>
  counts: Partial<Record<ForwardTable, number>>
  total: number
  /** 报给云端的 watermark.seq：跟 ledger_messages 游标走（见 collect 注释）。 */
  seq: number
}

export class D1Forwarder {
  readonly enabled: boolean
  readonly ingestUrl: string

  private readonly store: LedgerStore
  private readonly token: string
  private readonly batch: number
  private readonly intervalMs: number
  private readonly debounceMs: number
  private readonly drainDelayMs: number
  private readonly minBackoffMs: number
  private readonly maxBackoffMs: number
  private readonly timeoutMs: number
  private readonly source: string
  private readonly snapshotIntervalMs: number
  private readonly snapshotMaxRows: number
  private readonly retention: Required<RetentionOptions>
  private readonly fetchImpl: FetchLike
  private readonly quiet: boolean

  private flushTimer: NodeJS.Timeout | null = null
  private debounceTimer: NodeJS.Timeout | null = null
  private cleanupTimer: NodeJS.Timeout | null = null
  private started = false
  /** stop() 之后为 true：库句柄随时可能被 Hub 关掉，从此不许再碰 store。 */
  private stopped = false
  private inFlight = false
  private failures = 0
  /** 每张快照表最近一次**推成功**的内容指纹；没变就不再发（省 D1 写额度）。 */
  private readonly snapshotDigests = new Map<ForwardTable, string>()
  /** 快照检查的节流闸（毫秒时间戳）；0 = 下一轮立刻查。 */
  private snapshotDueAt = 0

  constructor(opts: ForwarderOptions) {
    this.store = opts.store
    this.token = (opts.token ?? "").trim()
    this.ingestUrl = resolveIngestUrl(opts.url ?? "")
    this.enabled = Boolean(this.ingestUrl && this.token)

    this.batch = opts.batch ?? DEFAULT_FORWARD_BATCH
    this.intervalMs = opts.intervalMs ?? DEFAULT_FORWARD_INTERVAL_MS
    this.debounceMs = opts.debounceMs ?? DEFAULT_FORWARD_DEBOUNCE_MS
    this.drainDelayMs = opts.drainDelayMs ?? DEFAULT_DRAIN_DELAY_MS
    this.minBackoffMs = opts.minBackoffMs ?? DEFAULT_MIN_BACKOFF_MS
    this.maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.source = opts.source ?? DEFAULT_WATERMARK_SOURCE
    this.snapshotIntervalMs = opts.snapshotIntervalMs ?? this.intervalMs
    this.snapshotMaxRows = opts.snapshotMaxRows ?? DEFAULT_SNAPSHOT_MAX_ROWS
    this.retention = {
      enabled: opts.retention?.enabled ?? false,
      days: opts.retention?.days ?? DEFAULT_RETENTION_DAYS,
      intervalMs: opts.retention?.intervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS,
    }
    this.fetchImpl = opts.fetchImpl ?? defaultFetch
    this.quiet = opts.quiet ?? false
  }

  private log(...args: unknown[]): void {
    if (!this.quiet) console.error(...args)
  }

  // ----- 生命周期 -----

  /**
   * 起转发循环 + 清理循环。两个定时器都 unref——记账是第二职责，不该把进程钉住不退。
   * 关闭态调用是彻底的 no-op（不装表、不发请求）。
   */
  start(): void {
    if (!this.enabled || this.started) return
    this.started = true
    this.stopped = false
    this.scheduleFlush(this.intervalMs)
    if (this.retention.enabled) {
      this.cleanupTimer = setInterval(() => {
        try { this.cleanupOnce() } catch (err) { this.log("[ledger-forwarder] 保留清理出错:", errText(err)) }
      }, this.retention.intervalMs)
      this.cleanupTimer.unref?.()
    }
  }

  stop(): void {
    this.started = false
    this.stopped = true
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null }
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null }
    if (this.cleanupTimer) { clearInterval(this.cleanupTimer); this.cleanupTimer = null }
  }

  /**
   * 投影写完之后的**同步**提示（旁路铁律）：只 arm 一个 debounce 定时器就返回，
   * 绝不 await 网络。调用方（Hub 的 ingest）拿到的永远是立即返回。
   */
  notifyWrite(): void {
    if (!this.enabled || !this.started) return
    if (this.debounceTimer) return
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.runOnce().catch(() => { /* 内部已兜底，这里只防未捕获 */ })
    }, this.debounceMs)
    this.debounceTimer.unref?.()
  }

  /** 当前退避时长（0 = 无退避，按正常节奏走）。 */
  backoffMs(): number {
    if (this.failures <= 0) return 0
    return Math.min(this.minBackoffMs * 2 ** (this.failures - 1), this.maxBackoffMs)
  }

  /** 流水表当前游标（排障/对账用）。快照表没有游标概念——它们每轮全量重推。 */
  watermarks(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const t of STREAM_TABLES) out[t] = this.store.getForwardWatermark(t)
    return out
  }

  // ----- 转发 -----

  /**
   * 发一批**流水表**增量。**游标只在收到 2xx 之后推进**，且是"要么整批一起进，要么一格不动"——
   * 不允许部分推进，否则整批重发时会漏掉已跳过的那几张表。
   */
  async flushOnce(): Promise<FlushResult> {
    if (!this.enabled) return { ok: false, sent: 0, tables: {}, reason: "disabled" }
    if (this.stopped) return { ok: false, sent: 0, tables: {}, reason: "stopped" }
    if (this.inFlight) return { ok: false, sent: 0, tables: {}, reason: "busy" }
    this.inFlight = true
    try {
      const plan = this.collect()
      if (plan.total === 0) return { ok: false, sent: 0, tables: {}, reason: "empty" }

      const body = JSON.stringify({
        batches: plan.batches,
        watermark: { source: this.source, seq: plan.seq },
      })

      let status: number
      let res: FetchResponseLike
      try {
        res = await this.fetchImpl(this.ingestUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            Authorization: `Bearer ${this.token}`,
          },
          body,
          signal: makeTimeoutSignal(this.timeoutMs),
        })
        status = res.status
      } catch (err) {
        this.noteFailure()
        this.log(`[ledger-forwarder] 转发失败（网络），${plan.total} 行留在本地队列，${this.backoffMs()}ms 后重试:`, errText(err))
        return { ok: false, sent: 0, tables: {}, reason: "network" }
      }

      if (status < 200 || status >= 300) {
        this.noteFailure()
        const detail = await peekBody(res)
        this.log(`[ledger-forwarder] 转发被拒 HTTP ${status}，${plan.total} 行留在本地队列，${this.backoffMs()}ms 后重试:`, detail)
        return { ok: false, sent: 0, tables: {}, status, reason: "http" }
      }

      // 2xx = 云端收下了。applied 少于 sent 是**幂等去重的正常结果**（跨机同 id 双端上报），
      // 不是失败——按 applied 判失败会让游标永远卡在同一批。
      this.failures = 0
      // 请求在飞的这段时间里 Hub 可能已经在关（库句柄随时没）。这时**不推游标**就好：
      // 下次启动重发同一批，云端按主键去重，零副作用——比对着关掉的库写崩强。
      if (this.stopped) return { ok: false, sent: 0, tables: {}, status, reason: "stopped" }
      for (const [table, cursor] of plan.cursors) this.store.setForwardWatermark(table, cursor)
      return { ok: true, sent: plan.total, tables: plan.counts, status, reason: "sent" }
    } finally {
      this.inFlight = false
    }
  }

  /** 按表游标凑一批**流水表**增量，总行数不超过 batch。 */
  private collect(): BatchPlan {
    const batches: BatchPlan["batches"] = []
    const cursors: Array<[ForwardTable, number]> = []
    const counts: Partial<Record<ForwardTable, number>> = {}
    let remaining = this.batch
    let total = 0

    for (const table of STREAM_TABLES) {
      if (remaining <= 0) break
      const rows = this.store.readRowsAfter(table, this.store.getForwardWatermark(table), remaining)
      if (rows.length === 0) continue
      batches.push({ table, rows: rows.map((r) => r.row) })
      cursors.push([table, rows[rows.length - 1].cursor])
      counts[table] = rows.length
      remaining -= rows.length
      total += rows.length
    }

    // watermark.seq 只报 ledger_messages 的游标：三张流水表的游标各自独立，把别表的行号塞进这个
    // 单值字段会让云端的 ingest_watermarks 忽上忽下，失去"消息流推到哪了"的意义。
    // 本批没有消息行时，报**上次已确认**的消息游标——保证这个值单调不倒退。
    const fromBatch = cursors.find(([t]) => t === "ledger_messages")?.[1]
    const seq = fromBatch ?? this.store.getForwardWatermark("ledger_messages")

    return { batches, cursors, counts, total, seq }
  }

  // ----- 快照表全量同步 -----

  /**
   * 把 tasks / seats / accounts **整表全量**推上去（云端 INSERT OR REPLACE，重复推是安全的）。
   *
   * 为什么全量而不是游标：这三张表的行会被 UPDATE，而 rowid 不随 UPDATE 变——
   * 游标增量只会把每行转一次，task 的 dispatched→replied 永远到不了云端。
   *
   * 为什么不烧额度：每轮先在**本地**算内容 digest，没变就一个请求都不发。
   * 这三张表几分钟才动一次，实际请求量趋近于"变更次数"，不是"轮询次数"。
   *
   * 失败语义：**不记 digest** → 下一轮整表重推；流水表的游标一格都不受影响。
   */
  async flushSnapshotsOnce(): Promise<SnapshotResult> {
    const idle: SnapshotResult = { ok: false, sent: 0, tables: {}, requests: 0, reason: "disabled" }
    if (!this.enabled) return idle
    if (this.stopped) return { ...idle, reason: "stopped" }
    if (this.inFlight) return { ...idle, reason: "busy" }
    this.inFlight = true
    try {
      // 1) 本地读 + 算指纹，挑出真变了的表
      const changed: Array<{ table: ForwardTable; rows: Array<Record<string, unknown>> }> = []
      const pending = new Map<ForwardTable, string>()
      for (const table of SNAPSHOT_TABLES) {
        const all = this.store.readAllRows(table, this.snapshotMaxRows)
        if (all.length >= this.snapshotMaxRows) {
          this.log(`[ledger-forwarder] 快照表 ${table} 已达 ${this.snapshotMaxRows} 行上限——全量推该换成增量了`)
        }
        const rows = all.map((r) => r.row)
        const digest = digestOf(rows)
        if (digest === this.snapshotDigests.get(table)) continue
        pending.set(table, digest)
        changed.push({ table, rows })
      }
      if (changed.length === 0) return { ok: true, sent: 0, tables: {}, requests: 0, reason: "unchanged" }

      // 2) 表清空了也算"变了"，但没行可发——直接记指纹收工（云端不做删除，见 §9 遗留）
      const nonEmpty = changed.filter((c) => c.rows.length > 0)
      if (nonEmpty.length === 0) {
        for (const [t, d] of pending) this.snapshotDigests.set(t, d)
        return { ok: true, sent: 0, tables: {}, requests: 0, reason: "unchanged" }
      }

      // 3) 分块发：常见情况三表几十行一个请求装下；表变大了也不会撞云端的 413
      const requests = packBatches(nonEmpty, this.batch)
      const seq = this.store.getForwardWatermark("ledger_messages")
      const counts: Partial<Record<ForwardTable, number>> = {}
      let sent = 0

      for (const batches of requests) {
        const body = JSON.stringify({ batches, watermark: { source: this.source, seq } })
        let res: FetchResponseLike
        try {
          res = await this.fetchImpl(this.ingestUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              Authorization: `Bearer ${this.token}`,
            },
            body,
            signal: makeTimeoutSignal(this.timeoutMs),
          })
        } catch (err) {
          this.noteFailure()
          this.log(`[ledger-forwarder] 快照表全量推失败（网络），下轮整表重推，${this.backoffMs()}ms 后重试:`, errText(err))
          return { ok: false, sent, tables: counts, requests: requests.length, reason: "network" }
        }
        if (res.status < 200 || res.status >= 300) {
          this.noteFailure()
          this.log(
            `[ledger-forwarder] 快照表全量推被拒 HTTP ${res.status}，下轮整表重推，${this.backoffMs()}ms 后重试:`,
            await peekBody(res),
          )
          return { ok: false, sent, tables: counts, requests: requests.length, status: res.status, reason: "http" }
        }
        for (const b of batches) {
          counts[b.table] = (counts[b.table] ?? 0) + b.rows.length
          sent += b.rows.length
        }
      }

      this.failures = 0
      // 全部块都 2xx 了才记指纹——半截成功不算数，下轮整表重推（云端 REPLACE，重推无害）。
      for (const [t, d] of pending) this.snapshotDigests.set(t, d)
      return { ok: true, sent, tables: counts, requests: requests.length, reason: "sent" }
    } finally {
      this.inFlight = false
    }
  }

  /**
   * 一轮完整转发：先流水增量，再（到点了才查的）快照全量。
   * 快照检查有节流闸，免得存量补传的高频排干把三张表的 digest 算上几百遍；
   * 但**推送失败时清零节流闸**，让重试节奏交回给指数退避。
   */
  private async runOnce(): Promise<{ stream: FlushResult; snapshot: SnapshotResult }> {
    const stream = await this.flushOnce()

    const now = Date.now()
    if (now < this.snapshotDueAt) {
      return { stream, snapshot: { ok: true, sent: 0, tables: {}, requests: 0, reason: "throttled" } }
    }
    this.snapshotDueAt = now + this.snapshotIntervalMs
    const snapshot = await this.flushSnapshotsOnce()
    if (!snapshot.ok && (snapshot.reason === "http" || snapshot.reason === "network")) {
      this.snapshotDueAt = 0
    }
    return { stream, snapshot }
  }

  private noteFailure(): void {
    this.failures = Math.min(this.failures + 1, MAX_FAILURE_EXPONENT)
  }

  private scheduleFlush(delayMs: number): void {
    if (!this.started) return
    this.flushTimer = setTimeout(() => { void this.tick() }, Math.max(0, delayMs))
    this.flushTimer.unref?.()
  }

  private async tick(): Promise<void> {
    this.flushTimer = null
    if (!this.started) return
    let delay = this.intervalMs
    try {
      const { stream } = await this.runOnce()
      // failures 是流水/快照共用的：任一路挂了都进退避（同一个云端口，没必要分两套节奏）。
      if (this.failures > 0) delay = this.backoffMs()
      else if (stream.reason === "busy") delay = this.drainDelayMs
      else if (stream.ok && stream.sent > 0) delay = this.drainDelayMs   // 还有积压就接着排干
    } catch (err) {
      this.log("[ledger-forwarder] 转发循环异常:", errText(err))
      delay = this.backoffMs() || this.intervalMs
    }
    this.scheduleFlush(delay)
  }

  // ----- 保留清理 -----

  /**
   * 热层保留清理（设计 §6 删除三纪律）。三道闸串起来才放行：
   *  ① 清理开关显式打开（对账通过前默认关）；
   *  ② 游标 > 0，即这批行**确认落过 D1**；
   *  ③ 行既在游标之内、又早于 now-Nd。
   * 表名不是参数——底层 `store.pruneMessages` 的 SQL 里写死 ledger_messages，
   * 全仓不存在能删到 seats / accounts / tasks 的代码路径。
   */
  cleanupOnce(nowMs: number = Date.now()): CleanupResult {
    if (!this.enabled || !this.retention.enabled) {
      return { deleted: 0, watermark: 0, cutoff: null, dbSizeBytes: 0, reason: "disabled" }
    }
    const table = RETENTION_TABLES[0]                      // "ledger_messages"，见常量注释
    const watermark = this.store.getForwardWatermark(table)
    if (watermark <= 0) {
      // 一行都没确认落 D1 → 什么都不能删（"先转发后删"）。
      return { deleted: 0, watermark: 0, cutoff: null, dbSizeBytes: this.store.dbSizeBytes(), reason: "no-watermark" }
    }

    const cutoff = new Date(nowMs - this.retention.days * 86_400_000).toISOString()
    const deleted = this.store.pruneMessages({ maxRowid: watermark, before: cutoff })
    const dbSizeBytes = this.store.dbSizeBytes()
    if (deleted > 0) {
      this.log(
        `[ledger-forwarder] 保留清理：${table} 删 ${deleted} 行（游标≤${watermark}，早于 ${cutoff}）；` +
        `DB ${(dbSizeBytes / 1048576).toFixed(2)}MB（未 VACUUM，空间待手动回收）`,
      )
    }
    return { deleted, watermark, cutoff, dbSizeBytes, reason: "done" }
  }
}

// ===== 小工具 =====

function errText(err: unknown): string {
  return String((err as Error)?.message ?? err)
}

/**
 * 快照表内容指纹。行序由 `readAllRows` 的 `ORDER BY rowid` 钉死，列序由 `SELECT *` 钉死，
 * 所以同样的库内容永远产出同样的串——库没动就一个请求都不发。
 */
export function digestOf(rows: Array<Record<string, unknown>>): string {
  return createHash("sha1").update(JSON.stringify(rows)).digest("hex")
}

/**
 * 把若干「表 + 全部行」打包成若干个请求，每个请求总行数不超过 batch。
 * 一张表装不下就横跨多个请求（云端逐行 REPLACE，切在哪都无所谓）。
 */
export function packBatches(
  entries: Array<{ table: ForwardTable; rows: Array<Record<string, unknown>> }>,
  batch: number,
): Array<Array<{ table: ForwardTable; rows: Array<Record<string, unknown>> }>> {
  const cap = Number.isFinite(batch) && batch > 0 ? Math.floor(batch) : 1
  const requests: Array<Array<{ table: ForwardTable; rows: Array<Record<string, unknown>> }>> = []
  let current: Array<{ table: ForwardTable; rows: Array<Record<string, unknown>> }> = []
  let used = 0

  for (const entry of entries) {
    let i = 0
    while (i < entry.rows.length) {
      if (used >= cap) {
        requests.push(current)
        current = []
        used = 0
      }
      const slice = entry.rows.slice(i, i + (cap - used))
      current.push({ table: entry.table, rows: slice })
      used += slice.length
      i += slice.length
    }
  }
  if (current.length > 0) requests.push(current)
  return requests
}

function makeTimeoutSignal(ms: number): AbortSignal | undefined {
  try {
    return AbortSignal.timeout(ms)
  } catch {
    return undefined      // 老 runtime 没有就不设超时，别为了超时把转发整个搞挂
  }
}

/** 失败日志里带一小段响应体，帮人一眼看出是 401 还是 400 还是反代插了一脚。 */
async function peekBody(res: FetchResponseLike): Promise<string> {
  try {
    const text = await res.text?.()
    return typeof text === "string" ? text.slice(0, 200) : ""
  } catch {
    return ""
  }
}
