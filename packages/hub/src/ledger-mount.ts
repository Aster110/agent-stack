/**
 * Hub 侧的账本挂载层 —— hub.ts 只认这一个接缝，账本实现全在 @cc-mesh/ledger。
 *
 * 组件化承诺（设计 §3.1）：将来把 ledger 拆成独立进程或换托管 DB，只重写本文件，
 * hub.ts 的调用点（ingest / recordEvent / sweepNow / close）不动。
 *
 * 两条部署纪律写死在这里：
 * 1. **懒加载**：better-sqlite3 是原生模块，服务器上编译失败是真实可能。静态 import
 *    会让 Hub 连路由都起不来（= 整张网瘫）。这里 try/catch 懒加载，账本挂不上就吼一嗓子
 *    继续裸跑——Hub 的第一职责是路由，记账是第二职责。
 * 2. **无 token 不开 HTTP**：:19901 朝公网，宁可没有读 API 也不开裸口（设计 §8.2）。
 */
import type { DeviceInventory } from "@cc-mesh/protocol"
import type {
  LedgerStore, LedgerHttpInstance, SweepResult, EventInput, IngestResult,
  D1Forwarder, ForwarderOptions, LedgerHttpExtension,
} from "@cc-mesh/ledger"
import type { LedgerUplinkEvent } from "@cc-mesh/protocol"

/** 冷层转发配置（store/quiet 由挂载层补）。不传 = 不转发。 */
export type HubForwarderOptions = Omit<ForwarderOptions, "store" | "quiet">

export interface HubLedgerOptions {
  /** SQLite 文件路径。缺省 ~/.ccmesh/ledger.db（由 index.ts 解析）。 */
  dbPath?: string
  /** 读 API 端口。缺省 LEDGER_HTTP_PORT(19901)；0 = 随机（测试用）。 */
  httpPort?: number
  /** 读 API 的 Bearer token（复用 HUB_TOKEN）。空 → 不起 HTTP。 */
  token?: string
  /** 派单多久没回且设备离线就算孤儿。缺省 30min。 */
  orphanTimeoutMs?: number
  /** 孤儿扫描周期。缺省 60s（unref，不挡进程退出）。 */
  sweepIntervalMs?: number
  /**
   * D1 冷层转发（展示面设计 §6）。**不传 = 完全不转发**——
   * s3 上不设 CONSOLE_INGEST_* 就是零行为零回归。
   */
  forwarder?: HubForwarderOptions
  /** 静默日志（测试用）。 */
  quiet?: boolean
  /** Authenticated HTTP extension mounted into the shared Ledger server. */
  httpExtension?: LedgerHttpExtension
}

export interface LedgerMount {
  store: LedgerStore
  /** 读 API 实际端口；没起 HTTP 时为 null。 */
  httpPort: number | null
  /** 冷层转发句柄；没配 CONSOLE_INGEST_* 或起不来时为 null。 */
  forwarder: D1Forwarder | null
  /**
   * 消费一批上行账本事件。返回该回给 relay 的 ack 游标；
   * 返回 null = 这批没吃下（整批已回滚），**调用方不得 ack**，等 relay 重传。
   */
  ingest(events: LedgerUplinkEvent[], srcRelay: string): number | null
  recordEvent(input: EventInput): void
  sweepNow(nowMs?: number): SweepResult
  close(): Promise<void>
}

export const DEFAULT_ORPHAN_TIMEOUT_MS = 30 * 60_000
export const DEFAULT_SWEEP_INTERVAL_MS = 60_000

export interface LedgerMountHooks {
  /** 实时在线视图（Hub 内存 relays）。 */
  presence: () => DeviceInventory[]
  /** 某 deviceId 此刻是否有 relay 连着。 */
  isDeviceOnline: (deviceId: string) => boolean
}

export async function mountLedger(
  opts: HubLedgerOptions,
  hooks: LedgerMountHooks,
): Promise<LedgerMount | null> {
  const log = (...args: unknown[]) => { if (!opts.quiet) console.error(...args) }

  let mod: typeof import("@cc-mesh/ledger")
  try {
    mod = await import("@cc-mesh/ledger")
  } catch (err) {
    log("[cc-mesh-hub] 账本模块加载失败，Hub 以纯路由模式继续:", (err as Error)?.message ?? err)
    return null
  }

  let store: LedgerStore
  try {
    store = new mod.LedgerStore(opts.dbPath)
  } catch (err) {
    log("[cc-mesh-hub] 账本库打不开，Hub 以纯路由模式继续:", (err as Error)?.message ?? err)
    return null
  }
  const projector = new mod.Projector(store)

  let http: LedgerHttpInstance | null = null
  const token = opts.token?.trim() ?? ""
  if (token) {
    try {
      http = await mod.startLedgerHttp({
        store, token, port: opts.httpPort, presence: hooks.presence, extension: opts.httpExtension,
      })
      log(`[cc-mesh-hub] 账本读 API http://0.0.0.0:${http.port} (Bearer)`)
    } catch (err) {
      log("[cc-mesh-hub] 账本读 API 起不来（账本写入不受影响）:", (err as Error)?.message ?? err)
      http = null
    }
  } else {
    log("[cc-mesh-hub] 未设 HUB_TOKEN → 账本读 API 不启动（公网口不开裸 API）；账本仍在记")
  }

  // D1 冷层转发（旁路）：起不来就当没有——热层记账是主职责，冷层保险是次职责。
  let forwarder: D1Forwarder | null = null
  const fwdOpts = opts.forwarder
  if (fwdOpts?.url && fwdOpts?.token) {
    try {
      const f = new mod.D1Forwarder({ ...fwdOpts, store, quiet: opts.quiet })
      if (f.enabled) {
        f.start()
        forwarder = f
        const r = fwdOpts.retention
        log(`[cc-mesh-hub] D1 冷层转发已开 → ${f.ingestUrl}；保留清理 ${r?.enabled ? `${r.days ?? 7} 天` : "关"}`)
      }
    } catch (err) {
      log("[cc-mesh-hub] 冷层转发起不来（热层账本照记）:", (err as Error)?.message ?? err)
      forwarder = null
    }
  } else if (fwdOpts?.url || fwdOpts?.token) {
    // 半配置 fail-closed：宁可不转发，也不朝云端打一串 401。
    log("[cc-mesh-hub] CONSOLE_INGEST_URL / CONSOLE_INGEST_TOKEN 只配了一半 → 冷层转发不启动")
  }

  const orphanTimeoutMs = opts.orphanTimeoutMs ?? DEFAULT_ORPHAN_TIMEOUT_MS
  const sweepNow = (nowMs?: number): SweepResult =>
    mod.sweep(store, hooks.isDeviceOnline, orphanTimeoutMs, nowMs)

  const timer = setInterval(() => {
    try { sweepNow() } catch (err) { log("[cc-mesh-hub] 孤儿扫描出错:", (err as Error)?.message ?? err) }
  }, opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS)
  timer.unref()

  return {
    store,
    httpPort: http?.port ?? null,
    forwarder,
    ingest(events: LedgerUplinkEvent[], srcRelay: string): number | null {
      try {
        const r: IngestResult = projector.ingest(events ?? [], srcRelay)
        // 旁路铁律：只 arm 一个定时器就走（notifyWrite 是同步的），**绝不 await 转发**。
        // 云端不通/慢/500 都不许反噬到 relay 的 ack 时延。try/catch 是第二道保险。
        try { forwarder?.notifyWrite() } catch { /* 转发的毛病绝不外溢到写路径 */ }
        return r.maxSrcSeq
      } catch (err) {
        log("[cc-mesh-hub] 账本入账失败（整批回滚，等 relay 重传）:", (err as Error)?.message ?? err)
        try {
          store.insertEvent({
            kind: "ledger_ingest_error",
            nodeId: srcRelay,
            detail: { error: String((err as Error)?.message ?? err), batch: events?.length ?? 0 },
          })
        } catch { /* 连事件都写不进去就算了，别把 Hub 拖下水 */ }
        return null
      }
    },
    recordEvent(input: EventInput): void {
      try { store.insertEvent(input) } catch (err) {
        log("[cc-mesh-hub] 账本事件写入失败:", (err as Error)?.message ?? err)
      }
    },
    sweepNow,
    async close() {
      clearInterval(timer)
      forwarder?.stop()          // 先停转发，再关库——不能让在飞的批撞上关掉的句柄
      if (http) await http.close()
      store.close()
    },
  }
}
