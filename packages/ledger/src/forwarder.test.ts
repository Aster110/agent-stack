/**
 * D1Forwarder 单测 —— 云端冷层异步转发 + 热层保留清理。
 * 设计：features/展示面mesh-console与D1冷层-设计-2026-08-27.md §3 契约 / §6 施工条款。
 *
 * 纪律：**全程 mock fetch + 临时库**，一个真实网络端点都不碰，生产 ledger.db 一个字节不动。
 *
 * 覆盖的硬语义：
 *  ① 双 env 缺省 = 完全关闭 = 零行为；② 按表游标只在 2xx 后推进；
 *  ③ 失败指数退避 1s→60s cap；④ 部分失败不丢行不跳游标；⑤ 幂等重发安全；
 *  ⑥ 清理三纪律（先转发后删 / 只删 ledger_messages / 7 天窗口）——负例是重点；
 *  ⑦ 旁路铁律：转发怎么炸都不影响投影写路径。
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { LedgerUplinkEvent, MeshMessage } from "@cc-mesh/protocol"
import { LedgerStore } from "./store.js"
import { Projector } from "./projector.js"
import {
  D1Forwarder, forwarderFromEnv, resolveIngestUrl, packBatches,
  DEFAULT_FORWARD_BATCH, DEFAULT_MAX_BACKOFF_MS, DEFAULT_RETENTION_DAYS,
  RETENTION_TABLES, FORWARD_TABLES, STREAM_TABLES, SNAPSHOT_TABLES,
} from "./forwarder.js"
import type { FetchInit, FetchResponseLike } from "./forwarder.js"

const URL_BASE = "https://mesh-console.example.workers.dev"
const TOKEN = "ingest-token-测试用"
const T0 = "2026-08-27T10:00:00+08:00"
const DAY = 86_400_000

// ===== mock fetch =====

interface Call { url: string; init: FetchInit; body: any }

class MockFetch {
  calls: Call[] = []
  /** 队列里有就按队列出，空了用 fallback。 */
  queue: Array<number | Error> = []
  fallback: number | Error = 200
  /** 每次响应体（默认走契约形状）。 */
  bodyFor: (call: Call) => string = (c) => JSON.stringify({
    ok: true,
    data: { applied: Object.fromEntries((c.body.batches ?? []).map((b: any) => [b.table, b.rows.length])) },
  })

  readonly impl = async (url: string, init: FetchInit): Promise<FetchResponseLike> => {
    let body: any = null
    try { body = JSON.parse(init.body) } catch { /* 让断言去发现 */ }
    const call: Call = { url, init, body }
    this.calls.push(call)
    const next = this.queue.length > 0 ? this.queue.shift()! : this.fallback
    if (next instanceof Error) throw next
    return { status: next, text: async () => this.bodyFor(call) }
  }

  last(): Call { return this.calls[this.calls.length - 1] }
  /** 最近一次请求里某表发了哪些行。 */
  rowsOf(table: string, i = this.calls.length - 1): any[] {
    return (this.calls[i]?.body?.batches ?? []).find((b: any) => b.table === table)?.rows ?? []
  }
  tablesOf(i = this.calls.length - 1): string[] {
    return (this.calls[i]?.body?.batches ?? []).map((b: any) => b.table)
  }
  totalRows(i = this.calls.length - 1): number {
    return (this.calls[i]?.body?.batches ?? []).reduce((n: number, b: any) => n + b.rows.length, 0)
  }
}

// ===== 夹具 =====

function mkMsg(id: string, over: Partial<MeshMessage> = {}): MeshMessage {
  return {
    id, from: "mini:cc-w1", to: "macbook:cc-main", type: "chat",
    payload: "hi", createdAt: T0, ...over,
  } as MeshMessage
}

function evMsg(id: string, srcSeq: number, over: Partial<MeshMessage> = {}): LedgerUplinkEvent {
  return { kind: "message", msg: mkMsg(id, over), status: "delivered", priority: "normal", srcSeq }
}

function seedMessages(store: LedgerStore, n: number, prefix = "m"): void {
  for (let i = 1; i <= n; i++) {
    store.insertMessageIfAbsent({
      id: `${prefix}${i}`, from: "mini:cc-w1", to: "macbook:cc-main", type: "chat",
      payload: `正文-${i}`, createdAt: T0, srcRelay: "r-a", srcSeq: i,
    })
  }
}

/** 八张表各来一行（多表批 + 清理负例都要用）。 */
function seedAllTables(store: LedgerStore): void {
  seedMessages(store, 1)
  store.insertQuotaSnapshot({
    probedAt: T0, host: "mini", source: "codex", accountFp: "chatgpt-abc",
    plan: "pro", status: "ok", pct5h: 3, pct7d: 17, resets5h: null, resets7d: null,
    envelope: JSON.stringify({ schema_version: "1" }),
  })
  store.upsertAccount({ accountFp: "chatgpt-abc", vendor: "openai", plan: "pro", label: "主号" })
  store.upsertSeat({ seatId: "mini/w1", device: "mini", agentKind: "codex", accountFp: "chatgpt-abc", active: true })
  store.upsertTask({
    taskId: "t1", title: "活", project: "P62", fromNode: "macbook:cc-main",
    toNode: "mini:cc-w1", pickReason: "explicit", status: "dispatched", createdAt: T0,
  })
  store.insertEvent({ kind: "relay_online", device: "mini", nodeId: null, detail: { nodes: 1 } })
  const todo = store.applyCcTodoChange({
    schemaVersion: 1,
    uid: "ctd-forwarder-fixture",
    legacyId: "f99-forwarder-fixture",
    category: "cc",
    status: "pending",
    project: "P65",
    dependsOn: [],
    createdAt: T0,
    updatedAt: "2026-08-27T10:00:01+08:00",
    baseRevision: 0,
    opId: "op-forwarder-fixture",
    originDevice: "fixture",
    contentDigest: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  })
  assert.equal(todo.outcome, "applied", "夹具必须真实 seed cc_todo_items + cc_todo_changes")
}

function mkFwd(store: LedgerStore, fetchImpl: MockFetch["impl"], extra: Record<string, unknown> = {}): D1Forwarder {
  return new D1Forwarder({ store, url: URL_BASE, token: TOKEN, fetchImpl, quiet: true, ...extra } as any)
}

// ===== A. 关闭态：双 env 缺省 = 零行为零回归 =====

describe("D1Forwarder · 关闭态（零行为零回归）", () => {
  it("forwarderFromEnv：双缺省 → null", () => {
    assert.equal(forwarderFromEnv({} as NodeJS.ProcessEnv), null)
  })

  it("forwarderFromEnv：只给一半 → null（fail-closed，宁可不转发也不半开）", () => {
    assert.equal(forwarderFromEnv({ CONSOLE_INGEST_URL: URL_BASE } as NodeJS.ProcessEnv), null)
    assert.equal(forwarderFromEnv({ CONSOLE_INGEST_TOKEN: TOKEN } as NodeJS.ProcessEnv), null)
  })

  it("forwarderFromEnv：空白串等同没设", () => {
    assert.equal(forwarderFromEnv({ CONSOLE_INGEST_URL: "   ", CONSOLE_INGEST_TOKEN: "  " } as NodeJS.ProcessEnv), null)
  })

  it("forwarderFromEnv：双设 → 配置（url/token 做 trim），清理默认关", () => {
    const cfg = forwarderFromEnv({
      CONSOLE_INGEST_URL: `  ${URL_BASE}  `, CONSOLE_INGEST_TOKEN: `  ${TOKEN} `,
    } as NodeJS.ProcessEnv)!
    assert.equal(cfg.url, URL_BASE)
    assert.equal(cfg.token, TOKEN)
    assert.equal(cfg.retention.enabled, false, "清理必须显式开（对账通过后才开）")
  })

  it("forwarderFromEnv：LEDGER_RETENTION_DAYS 正数才开清理，非法值不开", () => {
    const on = forwarderFromEnv({
      CONSOLE_INGEST_URL: URL_BASE, CONSOLE_INGEST_TOKEN: TOKEN, LEDGER_RETENTION_DAYS: "7",
    } as NodeJS.ProcessEnv)!
    assert.equal(on.retention.enabled, true)
    assert.equal(on.retention.days, 7)

    for (const bad of ["0", "-1", "毁灭吧", ""]) {
      const cfg = forwarderFromEnv({
        CONSOLE_INGEST_URL: URL_BASE, CONSOLE_INGEST_TOKEN: TOKEN, LEDGER_RETENTION_DAYS: bad,
      } as NodeJS.ProcessEnv)!
      assert.equal(cfg.retention.enabled, false, `LEDGER_RETENTION_DAYS=${bad} 不该开清理`)
    }
  })

  it("空 url/token 构造 → enabled=false：flush/cleanup/start 全零行为，fetch 一次没调", async () => {
    const store = new LedgerStore(":memory:")
    seedMessages(store, 3)
    const mf = new MockFetch()
    const fwd = new D1Forwarder({ store, url: "", token: "", fetchImpl: mf.impl, quiet: true })

    assert.equal(fwd.enabled, false)
    fwd.start()
    fwd.notifyWrite()
    const r = await fwd.flushOnce()
    assert.equal(r.ok, false)
    assert.equal(r.reason, "disabled")
    assert.equal(fwd.cleanupOnce(Date.now() + 99 * DAY).reason, "disabled")

    assert.equal(mf.calls.length, 0, "关闭态一个请求都不该发")
    assert.equal(store.getForwardWatermark("ledger_messages"), 0, "关闭态不许写游标")
    assert.equal(store.listMessages({}).length, 3, "关闭态一行都不许删")
    fwd.stop()
    store.close()
  })
})

// ===== B. URL 拼接 =====

describe("D1Forwarder · ingest URL 拼接", () => {
  it("基址补 /ingest；尾斜杠不产生双斜杠；已带 /ingest 不重复拼", () => {
    assert.equal(resolveIngestUrl(URL_BASE), `${URL_BASE}/ingest`)
    assert.equal(resolveIngestUrl(`${URL_BASE}/`), `${URL_BASE}/ingest`)
    assert.equal(resolveIngestUrl(`${URL_BASE}///`), `${URL_BASE}/ingest`)
    assert.equal(resolveIngestUrl(`${URL_BASE}/ingest`), `${URL_BASE}/ingest`)
    assert.equal(resolveIngestUrl(`${URL_BASE}/ingest/`), `${URL_BASE}/ingest`)
  })
})

// ===== C. 契约形状 + 游标推进 =====

describe("D1Forwarder · /ingest 契约与游标推进", () => {
  it("请求形状 = §3 契约：POST /ingest + Bearer + {batches,watermark}", async () => {
    const store = new LedgerStore(":memory:")
    seedMessages(store, 2)
    const mf = new MockFetch()
    const fwd = mkFwd(store, mf.impl)

    const r = await fwd.flushOnce()
    assert.equal(r.ok, true)
    assert.equal(r.sent, 2)

    const call = mf.last()
    assert.equal(call.url, `${URL_BASE}/ingest`)
    assert.equal(call.init.method, "POST")
    assert.equal(call.init.headers.Authorization, `Bearer ${TOKEN}`)
    assert.match(call.init.headers["Content-Type"], /application\/json/)
    assert.ok(Array.isArray(call.body.batches))
    assert.equal(call.body.watermark.source, "s3-hub")
    assert.equal(typeof call.body.watermark.seq, "number")
    store.close()
  })

  it("行对象 = 表行原样（snake_case 全文，payload 不瘦身），且不夹带内部游标字段", async () => {
    const store = new LedgerStore(":memory:")
    store.insertMessageIfAbsent({
      id: "m1", from: "a", to: "b", type: "quota_report", payload: "很长的原文".repeat(50),
      meta: { _task: { title: "T" } }, replyTo: null, priority: "urgent", status: "delivered",
      createdAt: T0, srcRelay: "r-a", srcSeq: 42,
    })
    const mf = new MockFetch()
    await mkFwd(store, mf.impl).flushOnce()

    const [row] = mf.rowsOf("ledger_messages")
    assert.equal(row.id, "m1")
    assert.equal(row.src_seq, 42, "列名必须是 DDL 的 snake_case（D1 照抄 DDL）")
    assert.equal(row.src_relay, "r-a")
    assert.equal(row.payload, "很长的原文".repeat(50), "冷层要的就是原始数据，不许截断")
    assert.ok(typeof row.recorded_at === "string")
    for (const forbidden of ["__rowid", "__mesh_rowid", "rowid", "_cursor"]) {
      assert.ok(!(forbidden in row), `内部游标字段 ${forbidden} 不该进请求体`)
    }
    assert.deepEqual(
      Object.keys(row).sort(),
      store.columnNames("ledger_messages").sort(),
      "流水表也推 SELECT * 全行（D1 那边是照抄的同一份 DDL）",
    )
    store.close()
  })

  it("2xx → 游标推进到本批最大行游标；再 flush 只发新行", async () => {
    const store = new LedgerStore(":memory:")
    seedMessages(store, 3)
    const mf = new MockFetch()
    const fwd = mkFwd(store, mf.impl)

    await fwd.flushOnce()
    assert.deepEqual(mf.rowsOf("ledger_messages").map((r: any) => r.id), ["m1", "m2", "m3"])
    assert.equal(store.getForwardWatermark("ledger_messages"), 3)

    seedMessages(store, 5)                      // m1..m3 已存在（INSERT OR IGNORE），新增 m4/m5
    await fwd.flushOnce()
    assert.deepEqual(mf.rowsOf("ledger_messages").map((r: any) => r.id), ["m4", "m5"], "已确认的不重发")
    assert.equal(store.getForwardWatermark("ledger_messages"), 5)
    store.close()
  })

  it("批不超过上限，剩下的留下一轮（默认 200）", async () => {
    assert.equal(DEFAULT_FORWARD_BATCH, 200)
    const store = new LedgerStore(":memory:")
    seedMessages(store, 7)
    const mf = new MockFetch()
    const fwd = mkFwd(store, mf.impl, { batch: 3 })

    assert.equal((await fwd.flushOnce()).sent, 3)
    assert.equal(mf.totalRows(), 3)
    assert.deepEqual(mf.rowsOf("ledger_messages").map((r: any) => r.id), ["m1", "m2", "m3"])
    assert.equal((await fwd.flushOnce()).sent, 3)
    assert.equal((await fwd.flushOnce()).sent, 1)
    assert.equal((await fwd.flushOnce()).reason, "empty")
    store.close()
  })

  it("无新行 → 不发空批", async () => {
    const store = new LedgerStore(":memory:")
    const mf = new MockFetch()
    const r = await mkFwd(store, mf.impl).flushOnce()
    assert.equal(r.sent, 0)
    assert.equal(r.reason, "empty")
    assert.equal(mf.calls.length, 0)
    store.close()
  })

  it("四张流水表走游标增量，每表独立；快照表不掺和进来", async () => {
    const store = new LedgerStore(":memory:")
    seedAllTables(store)
    const mf = new MockFetch()
    const fwd = mkFwd(store, mf.impl)

    const r = await fwd.flushOnce()
    assert.equal(r.sent, STREAM_TABLES.length)
    assert.deepEqual(mf.tablesOf().sort(), [...STREAM_TABLES].sort())
    for (const t of STREAM_TABLES) {
      assert.equal(store.getForwardWatermark(t), 1, `${t} 游标该推进到 1`)
    }
    for (const t of SNAPSHOT_TABLES) {
      assert.equal(store.getForwardWatermark(t), 0, `${t} 是快照表，不该有游标`)
    }
    assert.equal((await fwd.flushOnce()).reason, "empty", "流水全推完就没得发了")
    store.close()
  })

  it("两类表加起来正好是八表，不重不漏", () => {
    assert.deepEqual([...STREAM_TABLES, ...SNAPSHOT_TABLES].sort(), [...FORWARD_TABLES].sort())
    for (const t of STREAM_TABLES) assert.ok(!(SNAPSHOT_TABLES as readonly string[]).includes(t))
  })

  it("watermark.seq 跟 ledger_messages 游标走；本批没消息时用上次已知值（单调不倒退）", async () => {
    const store = new LedgerStore(":memory:")
    seedMessages(store, 2)
    const mf = new MockFetch()
    const fwd = mkFwd(store, mf.impl)

    await fwd.flushOnce()
    assert.equal(mf.last().body.watermark.seq, 2)

    store.insertEvent({ kind: "relay_online", device: "mini", detail: null })   // 只有 events 有新行
    await fwd.flushOnce()
    assert.deepEqual(mf.tablesOf(), ["events"])
    assert.equal(mf.last().body.watermark.seq, 2, "没消息就报上次的消息游标，绝不用别表的行号顶替")
    store.close()
  })
})

// ===== D. 失败与指数退避 =====

describe("D1Forwarder · 失败处理与指数退避", () => {
  it("非 2xx → 游标一格不动，下轮重发同一批（不丢行）", async () => {
    const store = new LedgerStore(":memory:")
    seedMessages(store, 3)
    const mf = new MockFetch()
    mf.queue = [500]
    const fwd = mkFwd(store, mf.impl)

    const bad = await fwd.flushOnce()
    assert.equal(bad.ok, false)
    assert.equal(bad.status, 500)
    assert.equal(store.getForwardWatermark("ledger_messages"), 0, "非 2xx 绝不推游标")

    const good = await fwd.flushOnce()
    assert.equal(good.ok, true)
    assert.deepEqual(mf.rowsOf("ledger_messages").map((r: any) => r.id), ["m1", "m2", "m3"], "重发必须是同一批")
    assert.equal(store.getForwardWatermark("ledger_messages"), 3)
    store.close()
  })

  it("网络抛异常 → 同样不推游标，也不把进程带崩", async () => {
    const store = new LedgerStore(":memory:")
    seedMessages(store, 2)
    const mf = new MockFetch()
    mf.fallback = new Error("ECONNREFUSED 云端不通")
    const fwd = mkFwd(store, mf.impl)

    const r = await fwd.flushOnce()
    assert.equal(r.ok, false)
    assert.equal(r.reason, "network")
    assert.equal(store.getForwardWatermark("ledger_messages"), 0)
    store.close()
  })

  it("401（token 错）也走退避，不静默推游标", async () => {
    const store = new LedgerStore(":memory:")
    seedMessages(store, 1)
    const mf = new MockFetch()
    mf.fallback = 401
    const fwd = mkFwd(store, mf.impl)

    assert.equal((await fwd.flushOnce()).ok, false)
    assert.equal(store.getForwardWatermark("ledger_messages"), 0)
    assert.ok(fwd.backoffMs() > 0)
    store.close()
  })

  it("退避序列 1s→2s→4s…→60s 封顶", async () => {
    const store = new LedgerStore(":memory:")
    seedMessages(store, 1)
    const mf = new MockFetch()
    mf.fallback = 503
    const fwd = mkFwd(store, mf.impl)

    const seen: number[] = []
    for (let i = 0; i < 8; i++) {
      await fwd.flushOnce()
      seen.push(fwd.backoffMs())
    }
    assert.deepEqual(seen, [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000])
    assert.equal(DEFAULT_MAX_BACKOFF_MS, 60000)
    store.close()
  })

  it("一次成功 → 退避归零（不带着惩罚进正常节奏）", async () => {
    const store = new LedgerStore(":memory:")
    seedMessages(store, 2)
    const mf = new MockFetch()
    mf.queue = [500, 500]
    const fwd = mkFwd(store, mf.impl)

    await fwd.flushOnce(); await fwd.flushOnce()
    assert.equal(fwd.backoffMs(), 2000)
    await fwd.flushOnce()
    assert.equal(fwd.backoffMs(), 0)
    store.close()
  })

  it("部分失败：多表批整体挂 → 流水表游标一个都不许动", async () => {
    const store = new LedgerStore(":memory:")
    seedAllTables(store)
    const mf = new MockFetch()
    mf.fallback = 502
    const fwd = mkFwd(store, mf.impl)

    assert.equal((await fwd.flushOnce()).ok, false)
    for (const t of STREAM_TABLES) {
      assert.equal(store.getForwardWatermark(t), 0, `${t} 不该在整批失败后推进`)
    }

    mf.fallback = 200
    assert.equal((await fwd.flushOnce()).sent, STREAM_TABLES.length, "重发把四张流水表整批补上，一行不丢")
    store.close()
  })
})

// ===== E. 幂等重发安全 =====

describe("D1Forwarder · 幂等重发安全", () => {
  it("2xx 但 applied 全 0（云端全判重复）→ 照样推进游标，不卡死在同一批", async () => {
    const store = new LedgerStore(":memory:")
    seedMessages(store, 2)
    const mf = new MockFetch()
    mf.bodyFor = () => JSON.stringify({ ok: true, data: { applied: { ledger_messages: 0 } } })
    const fwd = mkFwd(store, mf.impl)

    assert.equal((await fwd.flushOnce()).ok, true)
    assert.equal(store.getForwardWatermark("ledger_messages"), 2, "applied=0 是幂等去重的正常结果，不是失败")
    store.close()
  })

  it("2xx 但响应体不是 JSON → 仍按成功处理（判据只有 2xx）", async () => {
    const store = new LedgerStore(":memory:")
    seedMessages(store, 1)
    const mf = new MockFetch()
    mf.bodyFor = () => "<html>某个反代插了一脚</html>"
    const fwd = mkFwd(store, mf.impl)

    assert.equal((await fwd.flushOnce()).ok, true)
    assert.equal(store.getForwardWatermark("ledger_messages"), 1)
    store.close()
  })

  it("同一批重发两次 → 请求体逐字节相同（云端 INSERT OR IGNORE 天然去重）", async () => {
    const store = new LedgerStore(":memory:")
    seedMessages(store, 3)
    const mf = new MockFetch()
    mf.queue = [500, 500]
    const fwd = mkFwd(store, mf.impl)

    await fwd.flushOnce()
    await fwd.flushOnce()
    assert.equal(mf.calls[0].init.body, mf.calls[1].init.body)
    store.close()
  })

  it("游标只进不退：外部把游标写高了，flush 不会把老行翻出来重发", async () => {
    const store = new LedgerStore(":memory:")
    seedMessages(store, 5)
    store.setForwardWatermark("ledger_messages", 5)
    store.setForwardWatermark("ledger_messages", 2)          // 试图倒退
    assert.equal(store.getForwardWatermark("ledger_messages"), 5)

    const mf = new MockFetch()
    assert.equal((await mkFwd(store, mf.impl).flushOnce()).reason, "empty")
    store.close()
  })
})

// ===== E2. 快照表全量同步（2026-08-27 主 cc 仲裁） =====

describe("D1Forwarder · 快照表全量同步（tasks / seats / accounts / cc_todo_items）", () => {
  it("首轮四张快照表整表推上去（一个请求装下）", async () => {
    const store = new LedgerStore(":memory:")
    seedAllTables(store)
    const mf = new MockFetch()
    const fwd = mkFwd(store, mf.impl)

    const r = await fwd.flushSnapshotsOnce()
    assert.equal(r.ok, true)
    assert.equal(r.sent, SNAPSHOT_TABLES.length)
    assert.equal(r.requests, 1)
    assert.deepEqual(mf.tablesOf().sort(), [...SNAPSHOT_TABLES].sort())
    assert.equal(mf.rowsOf("tasks")[0].task_id, "t1")
    assert.equal(mf.rowsOf("seats")[0].seat_id, "mini/w1")
    assert.equal(mf.rowsOf("accounts")[0].account_fp, "chatgpt-abc")
    assert.equal(mf.rowsOf("cc_todo_items")[0].uid, "ctd-forwarder-fixture")
    store.close()
  })

  it("推的是 SELECT * 全行——每张快照表的列一个不少（云端 INSERT OR REPLACE 是整行替换，缺列 = 变 NULL）", async () => {
    const store = new LedgerStore(":memory:")
    seedAllTables(store)
    const mf = new MockFetch()
    await mkFwd(store, mf.impl).flushSnapshotsOnce()

    for (const table of SNAPSHOT_TABLES) {
      const row = mf.rowsOf(table)[0]
      assert.ok(row, `${table} 没推出来`)
      assert.deepEqual(
        Object.keys(row).sort(),
        store.columnNames(table).sort(),
        `${table} 推的列必须 == DDL 全列：少一列云端 REPLACE 就把它写成 NULL`,
      )
    }
    store.close()
  })

  it("关单只改 status，其余列必须原样跟着重推（REPLACE 不会把 title/project 抹成 NULL）", async () => {
    const store = new LedgerStore(":memory:")
    store.upsertTask({
      taskId: "t1", title: "把活干完", project: "P62", fromNode: "macbook:cc-main",
      toNode: "mini:cc-w1", seatId: "mini/w1", accountFp: "chatgpt-abc",
      pickReason: "explicit", status: "dispatched", createdAt: T0,
    })
    const mf = new MockFetch()
    const fwd = mkFwd(store, mf.impl)
    await fwd.flushSnapshotsOnce()

    store.markTaskReplied("t1", "r1", "2026-08-27T10:30:00+08:00")
    await fwd.flushSnapshotsOnce()

    const row = mf.rowsOf("tasks")[0]
    assert.equal(row.status, "replied")
    assert.equal(row.reply_msg_id, "r1")
    // 没变的列一个都不能丢：整行替换语义下，"没推 = 被清空"
    assert.equal(row.title, "把活干完")
    assert.equal(row.project, "P62")
    assert.equal(row.from_node, "macbook:cc-main")
    assert.equal(row.to_node, "mini:cc-w1")
    assert.equal(row.seat_id, "mini/w1")
    assert.equal(row.account_fp, "chatgpt-abc")
    assert.equal(row.pick_reason, "explicit")
    assert.equal(row.created_at, T0)
    assert.deepEqual(Object.keys(row).sort(), store.columnNames("tasks").sort())
    store.close()
  })

  it("task 状态 dispatched→replied 后，下一轮推送带上新状态（本次返工的核心诉求）", async () => {
    const store = new LedgerStore(":memory:")
    seedAllTables(store)
    const mf = new MockFetch()
    const fwd = mkFwd(store, mf.impl)

    await fwd.flushSnapshotsOnce()
    assert.equal(mf.rowsOf("tasks")[0].status, "dispatched")

    store.markTaskReplied("t1", "r1", "2026-08-27T10:30:00+08:00")
    const r = await fwd.flushSnapshotsOnce()

    assert.equal(r.ok, true)
    assert.deepEqual(mf.tablesOf(), ["tasks"], "只有变了的那张表被重推")
    const row = mf.rowsOf("tasks")[0]
    assert.equal(row.status, "replied")
    assert.equal(row.reply_msg_id, "r1")
    assert.equal(row.task_id, "t1", "同一主键，云端 INSERT OR REPLACE 覆盖旧行")
    store.close()
  })

  it("orphaned 关单同理会被推上去", async () => {
    const store = new LedgerStore(":memory:")
    seedAllTables(store)
    const mf = new MockFetch()
    const fwd = mkFwd(store, mf.impl)

    await fwd.flushSnapshotsOnce()
    store.markTaskOrphaned("t1")
    await fwd.flushSnapshotsOnce()
    assert.equal(mf.rowsOf("tasks")[0].status, "orphaned")
    store.close()
  })

  it("seats / accounts 改动同样被推（不是只有 tasks 特殊）", async () => {
    const store = new LedgerStore(":memory:")
    seedAllTables(store)
    const mf = new MockFetch()
    const fwd = mkFwd(store, mf.impl)
    await fwd.flushSnapshotsOnce()

    store.upsertSeat({ seatId: "mini/w1", device: "mini", delivery: "sse-pull" })
    await fwd.flushSnapshotsOnce()
    assert.deepEqual(mf.tablesOf(), ["seats"])
    assert.equal(mf.rowsOf("seats")[0].delivery, "sse-pull")

    store.upsertAccount({ accountFp: "chatgpt-abc", label: "换了个名" })
    await fwd.flushSnapshotsOnce()
    assert.deepEqual(mf.tablesOf(), ["accounts"])
    assert.equal(mf.rowsOf("accounts")[0].label, "换了个名")
    store.close()
  })

  it("内容没变 → 一个请求都不发（全量推不能烧穿 D1 每日写额度）", async () => {
    const store = new LedgerStore(":memory:")
    seedAllTables(store)
    const mf = new MockFetch()
    const fwd = mkFwd(store, mf.impl)

    await fwd.flushSnapshotsOnce()
    const after = mf.calls.length
    for (let i = 0; i < 5; i++) {
      assert.equal((await fwd.flushSnapshotsOnce()).reason, "unchanged")
    }
    assert.equal(mf.calls.length, after, "库没动就不该有新请求")
    store.close()
  })

  it("四张表全空 → 零请求（新库不该空转）", async () => {
    const store = new LedgerStore(":memory:")
    const mf = new MockFetch()
    const r = await mkFwd(store, mf.impl).flushSnapshotsOnce()
    assert.equal(r.sent, 0)
    assert.equal(r.requests, 0)
    assert.equal(mf.calls.length, 0)
    store.close()
  })

  it("快照推送失败 → 不记指纹、下轮整表重推；**流水表游标丝毫不受影响**", async () => {
    const store = new LedgerStore(":memory:")
    seedAllTables(store)
    const mf = new MockFetch()
    const fwd = mkFwd(store, mf.impl)

    await fwd.flushOnce()                                  // 流水先推成功
    const before = fwd.watermarks()
    assert.equal(before.ledger_messages, 1)

    mf.fallback = 500
    const bad = await fwd.flushSnapshotsOnce()
    assert.equal(bad.ok, false)
    assert.equal(bad.status, 500)
    assert.deepEqual(fwd.watermarks(), before, "快照挂了不许动流水游标")
    assert.ok(fwd.backoffMs() > 0, "快照失败同样进指数退避")

    mf.fallback = 200
    const good = await fwd.flushSnapshotsOnce()
    assert.equal(good.sent, SNAPSHOT_TABLES.length, "失败那轮的表要整表重推，不留半截")
    store.close()
  })

  it("网络抛异常同样退避，且不动流水游标", async () => {
    const store = new LedgerStore(":memory:")
    seedAllTables(store)
    const mf = new MockFetch()
    mf.fallback = new Error("云端不通")
    const fwd = mkFwd(store, mf.impl)

    const r = await fwd.flushSnapshotsOnce()
    assert.equal(r.ok, false)
    assert.equal(r.reason, "network")
    assert.ok(fwd.backoffMs() > 0)
    assert.equal(store.getForwardWatermark("ledger_messages"), 0)
    store.close()
  })

  it("流水表挂了不挡快照表推送（两条路各走各的）", async () => {
    const store = new LedgerStore(":memory:")
    seedAllTables(store)
    const mf = new MockFetch()
    mf.queue = [503]                                       // 只让流水那一发挂
    const fwd = mkFwd(store, mf.impl)

    assert.equal((await fwd.flushOnce()).ok, false)
    assert.equal(store.getForwardWatermark("ledger_messages"), 0)

    const snap = await fwd.flushSnapshotsOnce()
    assert.equal(snap.ok, true, "流水挂了，快照该照推")
    assert.equal(snap.sent, SNAPSHOT_TABLES.length)
    store.close()
  })

  it("表大到一批装不下 → 分多个请求、每个 ≤batch，全成功才记指纹", async () => {
    const store = new LedgerStore(":memory:")
    for (let i = 1; i <= 7; i++) {
      store.upsertTask({
        taskId: `t${i}`, title: `活${i}`, project: "P62", fromNode: "a", toNode: "b",
        pickReason: "explicit", status: "dispatched", createdAt: T0,
      })
    }
    const mf = new MockFetch()
    const fwd = mkFwd(store, mf.impl, { batch: 3 })

    const r = await fwd.flushSnapshotsOnce()
    assert.equal(r.ok, true)
    assert.equal(r.sent, 7)
    assert.equal(r.requests, 3, "7 行 / 每批 3 = 3 个请求")
    for (let i = 0; i < mf.calls.length; i++) {
      assert.ok(mf.totalRows(i) <= 3, `第 ${i} 个请求超了 batch 上限`)
    }
    const ids = mf.calls.flatMap((_, i) => mf.rowsOf("tasks", i).map((x: any) => x.task_id))
    assert.deepEqual(ids, ["t1", "t2", "t3", "t4", "t5", "t6", "t7"], "分块不许丢行不许重行")

    assert.equal((await fwd.flushSnapshotsOnce()).reason, "unchanged")
    store.close()
  })

  it("分块中途失败 → 整表下轮从头重推（不留半截状态）", async () => {
    const store = new LedgerStore(":memory:")
    for (let i = 1; i <= 7; i++) {
      store.upsertTask({
        taskId: `t${i}`, title: "活", project: null, fromNode: "a", toNode: "b",
        pickReason: "explicit", status: "dispatched", createdAt: T0,
      })
    }
    const mf = new MockFetch()
    mf.queue = [200, 500]                                  // 第二块挂
    const fwd = mkFwd(store, mf.impl, { batch: 3 })

    const bad = await fwd.flushSnapshotsOnce()
    assert.equal(bad.ok, false)
    assert.equal(bad.sent, 3, "只有第一块进去了")

    mf.calls = []
    const good = await fwd.flushSnapshotsOnce()
    assert.equal(good.sent, 7, "重推是整表，不是只补没发的那截")
    store.close()
  })

  it("关闭态 / stop 之后 → 快照同步零行为", async () => {
    const store = new LedgerStore(":memory:")
    seedAllTables(store)
    const mf = new MockFetch()

    const off = new D1Forwarder({ store, url: "", token: "", fetchImpl: mf.impl, quiet: true })
    assert.equal((await off.flushSnapshotsOnce()).reason, "disabled")

    const on = mkFwd(store, mf.impl)
    on.start(); on.stop()
    assert.equal((await on.flushSnapshotsOnce()).reason, "stopped")
    assert.equal(mf.calls.length, 0)
    store.close()
  })

  it("排干高频轮次里快照只推一次（节流闸不让它跟着空转）", async () => {
    const store = new LedgerStore(":memory:")
    seedAllTables(store)
    seedMessages(store, 12)
    const mf = new MockFetch()
    const fwd = mkFwd(store, mf.impl, {
      batch: 2, intervalMs: 5, drainDelayMs: 1, snapshotIntervalMs: 10_000,
    })

    fwd.start()
    await new Promise((r) => setTimeout(r, 120))
    fwd.stop()

    // 数行不数请求：batch 小的时候一次全量推本来就会分块，分块不等于重复推。
    const snapRows = mf.calls.reduce((n, c) =>
      n + (c.body?.batches ?? [])
        .filter((b: any) => (SNAPSHOT_TABLES as readonly string[]).includes(b.table))
        .reduce((s: number, b: any) => s + b.rows.length, 0), 0)
    assert.equal(snapRows, SNAPSHOT_TABLES.length, "节流窗口内四张快照表总共只该被推一遍（每表各一行）")

    const streamRows = mf.calls.reduce((n, c) =>
      n + (c.body?.batches ?? [])
        .filter((b: any) => (STREAM_TABLES as readonly string[]).includes(b.table))
        .reduce((s: number, b: any) => s + b.rows.length, 0), 0)
    assert.ok(streamRows >= 12, `流水表该在同一时间段里反复排干（实际 ${streamRows} 行）`)
    store.close()
  })

  it("packBatches 纯函数：不超上限、不丢行、不产空批", () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ i }))
    assert.deepEqual(packBatches([], 3), [])
    assert.deepEqual(packBatches([{ table: "tasks", rows: [] }], 3), [])

    const packed = packBatches(
      [{ table: "tasks", rows: rows(5) }, { table: "seats", rows: rows(2) }],
      3,
    )
    assert.equal(packed.length, 3)
    for (const req of packed) {
      const n = req.reduce((s, b) => s + b.rows.length, 0)
      assert.ok(n > 0 && n <= 3)
      for (const b of req) assert.ok(b.rows.length > 0, "不许产出空 batch")
    }
    const total = packed.flat().reduce((s, b) => s + b.rows.length, 0)
    assert.equal(total, 7, "一行都不能丢")
  })
})

// ===== F. 旁路铁律 =====

describe("D1Forwarder · 旁路铁律（转发怎么炸都不动投影写路径）", () => {
  it("fetch 一直抛 → 投影照常入账、账本数据一行不动", async () => {
    const store = new LedgerStore(":memory:")
    const projector = new Projector(store)
    const mf = new MockFetch()
    mf.fallback = new Error("网断了")
    const fwd = mkFwd(store, mf.impl)

    for (let i = 1; i <= 5; i++) {
      const r = projector.ingest([evMsg(`x${i}`, i)], "r-a")
      fwd.notifyWrite()                       // 旁路通知是同步的，不 await 网络
      assert.equal(r.inserted, 1, "转发失效不该影响投影写入")
    }
    assert.equal(store.listMessages({}).length, 5)

    assert.equal((await fwd.flushOnce()).ok, false)
    assert.equal(store.listMessages({}).length, 5, "转发失败不许动账本数据")
    assert.equal(store.getForwardWatermark("ledger_messages"), 0)
    fwd.stop()
    store.close()
  })

  it("请求悬着不 resolve → 投影继续写，且重入保护挡住并发批", async () => {
    const store = new LedgerStore(":memory:")
    const projector = new Projector(store)
    seedMessages(store, 1)
    const hang = new Promise<FetchResponseLike>(() => { /* 永不 resolve */ })
    let started = 0
    const fwd = new D1Forwarder({
      store, url: URL_BASE, token: TOKEN, quiet: true,
      fetchImpl: () => { started++; return hang },
    })

    void fwd.flushOnce()                      // 故意不 await：转发在飞
    await new Promise((r) => setTimeout(r, 10))
    assert.equal(started, 1)

    const r = projector.ingest([evMsg("y1", 9)], "r-a")
    assert.equal(r.inserted, 1, "转发在飞不该挡住投影写入")

    assert.equal((await fwd.flushOnce()).reason, "busy", "同一时刻只允许一批在飞")
    assert.equal(started, 1)
    fwd.stop()
    store.close()
  })

  it("start/stop 幂等；stop 后定时器不再发批", async () => {
    const store = new LedgerStore(":memory:")
    seedMessages(store, 1)
    const mf = new MockFetch()
    const fwd = mkFwd(store, mf.impl, { intervalMs: 5 })

    fwd.start(); fwd.start()
    fwd.stop(); fwd.stop()
    await new Promise((r) => setTimeout(r, 40))
    assert.equal(mf.calls.length, 0, "stop 之后不该再有请求")
    store.close()
  })

  it("stop 之后 flushOnce 歇手：库句柄可能已被 Hub 关掉，不许再碰 store", async () => {
    const store = new LedgerStore(":memory:")
    seedMessages(store, 2)
    const mf = new MockFetch()
    const fwd = mkFwd(store, mf.impl)

    fwd.start()
    fwd.stop()
    assert.equal((await fwd.flushOnce()).reason, "stopped")
    assert.equal(mf.calls.length, 0)
    assert.equal(store.getForwardWatermark("ledger_messages"), 0)
    store.close()
  })

  it("请求在飞时 Hub 关停 → 回来也不推游标（下轮重发，云端幂等去重）", async () => {
    const store = new LedgerStore(":memory:")
    seedMessages(store, 2)
    let release: (r: FetchResponseLike) => void = () => { /* noop */ }
    const gate = new Promise<FetchResponseLike>((res) => { release = res })
    const fwd = new D1Forwarder({
      store, url: URL_BASE, token: TOKEN, quiet: true, fetchImpl: () => gate,
    })

    fwd.start()
    const inflight = fwd.flushOnce()
    await new Promise((r) => setTimeout(r, 10))
    fwd.stop()                                        // Hub 正在退出
    release({ status: 200, text: async () => "{}" })

    assert.equal((await inflight).reason, "stopped")
    assert.equal(store.getForwardWatermark("ledger_messages"), 0, "关停途中不许再动库")
    store.close()
  })

  it("start 后兜底定时器会自动排干积压", async () => {
    const store = new LedgerStore(":memory:")
    seedMessages(store, 2)
    const mf = new MockFetch()
    const fwd = mkFwd(store, mf.impl, { intervalMs: 5, drainDelayMs: 1 })

    fwd.start()
    await new Promise((r) => setTimeout(r, 60))
    fwd.stop()
    assert.ok(mf.calls.length >= 1, "定时器该自己把积压推出去")
    assert.equal(store.getForwardWatermark("ledger_messages"), 2)
    store.close()
  })
})

// ===== G. 保留清理（负例是重点） =====

describe("D1Forwarder · 保留清理三纪律", () => {
  it("清理白名单只有 ledger_messages —— seats/accounts/tasks 连出现的资格都没有", () => {
    assert.deepEqual([...RETENTION_TABLES], ["ledger_messages"])
    const white: readonly string[] = RETENTION_TABLES
    for (const t of ["seats", "accounts", "tasks", "events", "quota_snapshots"]) {
      assert.ok(!white.includes(t), `${t} 绝不允许进清理白名单`)
    }
  })

  it("清理未开 → 一行不删（对账通过前默认关）", () => {
    const store = new LedgerStore(":memory:")
    seedMessages(store, 3)
    store.setForwardWatermark("ledger_messages", 3)
    const mf = new MockFetch()
    const fwd = mkFwd(store, mf.impl)                       // 不给 retention

    const r = fwd.cleanupOnce(Date.now() + 99 * DAY)
    assert.equal(r.reason, "disabled")
    assert.equal(r.deleted, 0)
    assert.equal(store.listMessages({}).length, 3)
    store.close()
  })

  it("先转发后删：游标还是 0（没确认落 D1）→ 一行不删", () => {
    const store = new LedgerStore(":memory:")
    seedMessages(store, 3)
    const mf = new MockFetch()
    const fwd = mkFwd(store, mf.impl, { retention: { enabled: true, days: DEFAULT_RETENTION_DAYS } })

    const r = fwd.cleanupOnce(Date.now() + 99 * DAY)
    assert.equal(r.reason, "no-watermark")
    assert.equal(r.deleted, 0)
    assert.equal(store.listMessages({}).length, 3, "没确认落云端的行绝不允许删")
    store.close()
  })

  it("负例：未过 watermark 的行绝不删（哪怕已经很老）", () => {
    const store = new LedgerStore(":memory:")
    seedMessages(store, 5)
    store.setForwardWatermark("ledger_messages", 2)         // 只确认了前两行
    const mf = new MockFetch()
    const fwd = mkFwd(store, mf.impl, { retention: { enabled: true, days: 7 } })

    const r = fwd.cleanupOnce(Date.now() + 99 * DAY)
    assert.equal(r.deleted, 2)
    assert.deepEqual(store.listMessages({}).map((m) => m.id).sort(), ["m3", "m4", "m5"],
      "游标之后的行必须原地不动——relay 重传老 seq 段会把已删行复活成新账")
    store.close()
  })

  it("负例：7 天内的行绝不删（哪怕已确认落 D1）", () => {
    const store = new LedgerStore(":memory:")
    seedMessages(store, 4)
    store.setForwardWatermark("ledger_messages", 4)
    const mf = new MockFetch()
    const fwd = mkFwd(store, mf.impl, { retention: { enabled: true, days: 7 } })

    const r = fwd.cleanupOnce(Date.now())                   // 刚记的账，全在窗口内
    assert.equal(r.deleted, 0)
    assert.equal(store.listMessages({}).length, 4)

    assert.equal(fwd.cleanupOnce(Date.now() + 6.9 * DAY).deleted, 0, "第 6.9 天还不该动")
    assert.equal(fwd.cleanupOnce(Date.now() + 7.1 * DAY).deleted, 4, "过 7 天窗口才删")
    store.close()
  })

  it("负例：除 ledger_messages 外，其余七张转发表一行都不许被碰", () => {
    const store = new LedgerStore(":memory:")
    seedAllTables(store)
    for (const t of FORWARD_TABLES) store.setForwardWatermark(t, 999999)
    const mf = new MockFetch()
    const fwd = mkFwd(store, mf.impl, { retention: { enabled: true, days: 7 } })

    const r = fwd.cleanupOnce(Date.now() + 99 * DAY)
    assert.equal(r.deleted, 1, "只该删掉那一条消息")
    assert.equal(store.listMessages({}).length, 0)
    assert.equal(store.listSeats().length, 1, "seats 是调度依据，永不删")
    assert.equal(store.listAccounts().length, 1, "accounts 是油箱清单，永不删")
    assert.equal(store.listTasks({}).length, 1, "tasks 是将来调度算法的训练数据，永不删")
    assert.equal(store.listEvents({}).length, 1, "events 是排障上下文，本期不清")
    assert.equal(store.listQuotaHistory({}).length, 1, "quota 历史本期不清（可选项，未开）")
    assert.equal(store.readAllRows("cc_todo_items").length, 1, "个人任务快照不参与热层清理")
    assert.equal(store.readAllRows("cc_todo_changes").length, 1, "个人任务审计流不参与热层清理")
    store.close()
  })

  it("删后报 DB size；**不自动 VACUUM**（手动口另留）", () => {
    const store = new LedgerStore(":memory:")
    seedMessages(store, 50)
    store.setForwardWatermark("ledger_messages", 50)
    let vacuumed = 0
    ;(store as any).vacuum = () => { vacuumed++ }

    const mf = new MockFetch()
    const fwd = mkFwd(store, mf.impl, { retention: { enabled: true, days: 7 } })
    const r = fwd.cleanupOnce(Date.now() + 99 * DAY)

    assert.equal(r.deleted, 50)
    assert.ok(r.dbSizeBytes > 0, "清理结果要带 DB size（日志据此看空间回收）")
    assert.equal(typeof r.cutoff, "string")
    assert.equal(vacuumed, 0, "VACUUM 绝不自动跑")
    store.close()
  })

  it("清理定时器按周期跑（每日一次的可测化）", async () => {
    const store = new LedgerStore(":memory:")
    seedMessages(store, 2)
    store.setForwardWatermark("ledger_messages", 2)
    const mf = new MockFetch()
    const fwd = mkFwd(store, mf.impl, {
      intervalMs: 10_000,
      retention: { enabled: true, days: 0, intervalMs: 5 },   // days=0 只在这条测里用来强制过期
    })

    fwd.start()
    await new Promise((r) => setTimeout(r, 60))
    fwd.stop()
    assert.equal(store.listMessages({}).length, 0, "清理定时器应当真的跑起来")
    store.close()
  })
})
