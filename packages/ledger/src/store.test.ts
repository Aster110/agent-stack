/**
 * LedgerStore 单测 — 六表 DDL、幂等迁移、幂等写入、查询过滤。
 * 设计：features/云端账本与调度接口-设计-2026-08-27.md §3.2。
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { LedgerStore } from "./store.js"

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-test-"))
  return path.join(dir, "ledger.db")
}

describe("LedgerStore · 建表与迁移", () => {
  it("六张表全部建出来", () => {
    const store = new LedgerStore(":memory:")
    const names = store.tableNames()
    for (const t of ["ledger_messages", "quota_snapshots", "accounts", "seats", "tasks", "events"]) {
      assert.ok(names.includes(t), `缺表 ${t}`)
    }
    store.close()
  })

  it("ledger_messages 带 meta 列（JSON 文本）", () => {
    const store = new LedgerStore(":memory:")
    assert.ok(store.columnNames("ledger_messages").includes("meta"))
    store.close()
  })

  it("同一文件重复打开（迁移幂等），老数据不丢", () => {
    const p = tmpDb()
    const a = new LedgerStore(p)
    a.insertMessageIfAbsent({
      id: "m1", from: "x", to: "y", type: "chat", payload: "p",
      createdAt: "2026-08-27T10:00:00+08:00", srcRelay: "r1", srcSeq: 1,
    })
    a.close()
    const b = new LedgerStore(p)      // 二次迁移不得抛
    assert.equal(b.listMessages({}).length, 1)
    b.close()
    fs.rmSync(path.dirname(p), { recursive: true, force: true })
  })

  it("WAL 模式已开", () => {
    const p = tmpDb()
    const store = new LedgerStore(p)
    assert.equal(store.journalMode(), "wal")
    store.close()
    fs.rmSync(path.dirname(p), { recursive: true, force: true })
  })

  it("addColumnIfMissing 幂等：重复加同名列不抛", () => {
    const store = new LedgerStore(":memory:")
    store.addColumnIfMissing("events", "detail", "TEXT")   // 已存在
    store.addColumnIfMissing("events", "brand_new_col", "TEXT")
    store.addColumnIfMissing("events", "brand_new_col", "TEXT")
    assert.ok(store.columnNames("events").includes("brand_new_col"))
    store.close()
  })
})

describe("LedgerStore · ledger_messages", () => {
  it("同 id 重复插入只留一行，返回值区分新旧", () => {
    const store = new LedgerStore(":memory:")
    const row = {
      id: "m1", from: "a", to: "b", type: "chat", payload: "hello",
      createdAt: "2026-08-27T10:00:00+08:00", srcRelay: "relay-A", srcSeq: 7,
    }
    assert.equal(store.insertMessageIfAbsent(row), true)
    assert.equal(store.insertMessageIfAbsent({ ...row, srcRelay: "relay-B", srcSeq: 99 }), false)
    const all = store.listMessages({})
    assert.equal(all.length, 1)
    assert.equal(all[0].srcRelay, "relay-A")   // 先到者为准
    assert.equal(all[0].srcSeq, 7)
    store.close()
  })

  it("recorded_at 是 UTC ISO8601（Z 结尾），created_at 原样保留时区偏移", () => {
    const store = new LedgerStore(":memory:")
    store.insertMessageIfAbsent({
      id: "m1", from: "a", to: "b", type: "chat", payload: "x",
      createdAt: "2026-08-27T10:00:00+08:00", srcRelay: "r", srcSeq: 1,
    })
    const [row] = store.listMessages({})
    assert.match(row.recordedAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)
    assert.equal(row.createdAt, "2026-08-27T10:00:00+08:00")
    store.close()
  })

  it("meta 存 JSON、读回结构体；无 meta 读回 null", () => {
    const store = new LedgerStore(":memory:")
    store.insertMessageIfAbsent({
      id: "m1", from: "a", to: "b", type: "task", payload: "x",
      createdAt: "2026-08-27T10:00:00+08:00", srcRelay: "r", srcSeq: 1,
      meta: { _task: { title: "修 bug" } },
    })
    store.insertMessageIfAbsent({
      id: "m2", from: "a", to: "b", type: "chat", payload: "y",
      createdAt: "2026-08-27T10:00:01+08:00", srcRelay: "r", srcSeq: 2,
    })
    const m1 = store.getMessage("m1")!
    assert.deepEqual(m1.meta, { _task: { title: "修 bug" } })
    assert.equal(store.getMessage("m2")!.meta, null)
    store.close()
  })

  it("listMessages 支持 from/to/type/since/limit 过滤，created_at 倒序", () => {
    const store = new LedgerStore(":memory:")
    const rows = [
      { id: "m1", from: "a", to: "b", type: "chat", createdAt: "2026-08-27T10:00:00+08:00" },
      { id: "m2", from: "a", to: "c", type: "task", createdAt: "2026-08-27T11:00:00+08:00" },
      { id: "m3", from: "z", to: "b", type: "chat", createdAt: "2026-08-27T12:00:00+08:00" },
    ]
    rows.forEach((r, i) => store.insertMessageIfAbsent({ ...r, payload: "", srcRelay: "r", srcSeq: i + 1 }))

    assert.deepEqual(store.listMessages({}).map((r) => r.id), ["m3", "m2", "m1"])
    assert.deepEqual(store.listMessages({ from: "a" }).map((r) => r.id), ["m2", "m1"])
    assert.deepEqual(store.listMessages({ to: "b" }).map((r) => r.id), ["m3", "m1"])
    assert.deepEqual(store.listMessages({ type: "task" }).map((r) => r.id), ["m2"])
    assert.deepEqual(store.listMessages({ since: "2026-08-27T11:00:00+08:00" }).map((r) => r.id), ["m3", "m2"])
    assert.deepEqual(store.listMessages({ limit: 1 }).map((r) => r.id), ["m3"])
    store.close()
  })
})

describe("LedgerStore · tasks / events / quota / accounts / seats", () => {
  it("tasks upsert 不覆盖已有 status，markReplied 生效", () => {
    const store = new LedgerStore(":memory:")
    store.upsertTask({
      taskId: "t1", title: "活儿", project: "P62", fromNode: "a", toNode: "mini:cc-b",
      pickReason: "explicit", status: "dispatched", createdAt: "2026-08-27T10:00:00+08:00",
    })
    store.markTaskReplied("t1", "r1", "2026-08-27T10:05:00+08:00")
    store.upsertTask({
      taskId: "t1", title: "活儿改名", project: "P62", fromNode: "a", toNode: "mini:cc-b",
      pickReason: "explicit", status: "dispatched", createdAt: "2026-08-27T10:00:00+08:00",
    })
    const t = store.getTask("t1")!
    assert.equal(t.status, "replied")      // 冲突时不回退 status
    assert.equal(t.title, "活儿改名")       // 元数据字段照更
    assert.equal(t.replyMsgId, "r1")
    store.close()
  })

  it("listTasks 支持 status/project/since 过滤", () => {
    const store = new LedgerStore(":memory:")
    store.upsertTask({ taskId: "t1", title: "a", project: "P62", fromNode: "x", toNode: "y", pickReason: "explicit", status: "dispatched", createdAt: "2026-08-27T10:00:00+08:00" })
    store.upsertTask({ taskId: "t2", title: "b", project: "P81", fromNode: "x", toNode: "y", pickReason: "explicit", status: "replied", createdAt: "2026-08-27T12:00:00+08:00" })
    assert.deepEqual(store.listTasks({ status: "replied" }).map((t) => t.taskId), ["t2"])
    assert.deepEqual(store.listTasks({ project: "P62" }).map((t) => t.taskId), ["t1"])
    assert.deepEqual(store.listTasks({ since: "2026-08-27T11:00:00+08:00" }).map((t) => t.taskId), ["t2"])
    store.close()
  })

  it("events 追加 + kind/since 过滤", () => {
    const store = new LedgerStore(":memory:")
    store.insertEvent({ kind: "relay_online", device: "mini", nodeId: null, detail: { nodes: 2 }, ts: "2026-08-27T10:00:00+08:00" })
    store.insertEvent({ kind: "orphan_marked", device: "mini", nodeId: "mini:cc-b", detail: { taskId: "t1" }, ts: "2026-08-27T12:00:00+08:00" })
    assert.equal(store.listEvents({}).length, 2)
    assert.deepEqual(store.listEvents({ kind: "orphan_marked" }).map((e) => e.nodeId), ["mini:cc-b"])
    assert.equal(store.listEvents({ since: "2026-08-27T11:00:00+08:00" }).length, 1)
    assert.deepEqual(store.listEvents({ kind: "relay_online" })[0].detail, { nodes: 2 })
    store.close()
  })

  it("quota_snapshots：latest 每账号一条，history 给全序列", () => {
    const store = new LedgerStore(":memory:")
    const base = { host: "h", source: "codex", plan: "pro", status: "ok", pct5h: 10, pct7d: 20, resets5h: null, resets7d: null, envelope: "{}" }
    store.insertQuotaSnapshot({ ...base, accountFp: "acc-1", probedAt: "2026-08-27T10:00:00+08:00" })
    store.insertQuotaSnapshot({ ...base, accountFp: "acc-1", probedAt: "2026-08-27T11:00:00+08:00", pct5h: 55 })
    store.insertQuotaSnapshot({ ...base, accountFp: "acc-2", probedAt: "2026-08-27T09:00:00+08:00" })

    const latest = store.latestQuota()
    assert.equal(latest.length, 2)
    assert.equal(latest.find((q) => q.accountFp === "acc-1")!.pct5h, 55)
    assert.equal(store.listQuotaHistory({ account: "acc-1" }).length, 2)
    assert.equal(store.latestQuota("acc-1").length, 1)
    store.close()
  })

  it("accounts / seats upsert 幂等且可改", () => {
    const store = new LedgerStore(":memory:")
    store.upsertAccount({ accountFp: "chatgpt-1", vendor: "codex", plan: "pro" })
    store.upsertAccount({ accountFp: "chatgpt-1", vendor: "codex", plan: "plus", label: "主号" })
    const accs = store.listAccounts()
    assert.equal(accs.length, 1)
    assert.equal(accs[0].plan, "plus")
    assert.equal(accs[0].label, "主号")

    store.upsertSeat({ seatId: "workstation/xcx", device: "workstation", agentKind: "codex", accountFp: "chatgpt-1", capabilities: ["P62"], delivery: "inject", active: true })
    store.upsertSeat({ seatId: "workstation/xcx", device: "workstation", agentKind: "codex", accountFp: "chatgpt-1", capabilities: ["P62", "P81"], delivery: "inject", active: false })
    const seats = store.listSeats()
    assert.equal(seats.length, 1)
    assert.deepEqual(seats[0].capabilities, ["P62", "P81"])
    assert.equal(seats[0].active, false)
    store.close()
  })

  it("findResultsReplyingTo 只捞 type=result 的回执", () => {
    const store = new LedgerStore(":memory:")
    store.insertMessageIfAbsent({ id: "r1", from: "b", to: "a", type: "result", payload: "done", replyTo: "t1", createdAt: "2026-08-27T10:05:00+08:00", srcRelay: "r", srcSeq: 1 })
    store.insertMessageIfAbsent({ id: "c1", from: "b", to: "a", type: "chat", payload: "?", replyTo: "t1", createdAt: "2026-08-27T10:06:00+08:00", srcRelay: "r", srcSeq: 2 })
    const found = store.findResultsReplyingTo("t1")
    assert.deepEqual(found.map((m) => m.id), ["r1"])
    store.close()
  })
})

describe("LedgerStore · 转发游标与保留清理（D1 冷层用的存储原语）", () => {
  it("建出 forward_watermarks 表，缺省游标为 0", () => {
    const store = new LedgerStore(":memory:")
    assert.ok(store.tableNames().includes("forward_watermarks"))
    assert.deepEqual(store.columnNames("forward_watermarks").sort(), ["seq", "table_name", "updated_at"])
    assert.equal(store.getForwardWatermark("ledger_messages"), 0)
    store.close()
  })

  it("游标取 max 单调推进：倒退写入被无视", () => {
    const store = new LedgerStore(":memory:")
    store.setForwardWatermark("ledger_messages", 10)
    store.setForwardWatermark("ledger_messages", 3)
    assert.equal(store.getForwardWatermark("ledger_messages"), 10)
    store.setForwardWatermark("ledger_messages", 11)
    assert.equal(store.getForwardWatermark("ledger_messages"), 11)
    const rows = store.listForwardWatermarks()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].table, "ledger_messages")
    assert.ok(typeof rows[0].updatedAt === "string")
    store.close()
  })

  it("游标落盘：重开库还在（Hub 重启不重推全量）", () => {
    const p = tmpDb()
    const a = new LedgerStore(p)
    a.setForwardWatermark("events", 7)
    a.close()
    const b = new LedgerStore(p)
    assert.equal(b.getForwardWatermark("events"), 7)
    b.close()
    fs.rmSync(path.dirname(p), { recursive: true, force: true })
  })

  it("readRowsAfter 按行游标升序取原样行，表名走白名单（防注入）", () => {
    const store = new LedgerStore(":memory:")
    for (let i = 1; i <= 3; i++) {
      store.insertMessageIfAbsent({ id: `m${i}`, from: "a", to: "b", type: "chat", payload: `p${i}`, createdAt: "2026-08-27T10:00:00+08:00", srcRelay: "r", srcSeq: i })
    }
    const rows = store.readRowsAfter("ledger_messages", 0, 10)
    assert.deepEqual(rows.map((r) => r.cursor), [1, 2, 3])
    assert.equal(rows[0].row.id, "m1")
    assert.equal(rows[0].row.src_seq, 1, "列名保持 DDL 的 snake_case")
    assert.ok(!("__rowid" in rows[0].row), "内部游标列不许混进行对象")

    assert.deepEqual(store.readRowsAfter("ledger_messages", 2, 10).map((r) => r.row.id), ["m3"])
    assert.equal(store.readRowsAfter("ledger_messages", 0, 2).length, 2)
    assert.throws(() => store.readRowsAfter("sqlite_master", 0, 1), /不在转发白名单/)
    assert.throws(() => store.readRowsAfter("ledger_messages; DROP TABLE seats", 0, 1), /不在转发白名单/)
    store.close()
  })

  it("pruneMessages 只删同时满足「过游标」+「过时间窗」的消息行", () => {
    const store = new LedgerStore(":memory:")
    for (let i = 1; i <= 5; i++) {
      store.insertMessageIfAbsent({ id: `m${i}`, from: "a", to: "b", type: "chat", payload: "x", createdAt: "2026-08-27T10:00:00+08:00", srcRelay: "r", srcSeq: i })
    }
    const future = new Date(Date.now() + 86400_000).toISOString()
    assert.equal(store.pruneMessages({ maxRowid: 0, before: future }), 0, "游标 0 = 一行没确认，不许删")
    assert.equal(store.pruneMessages({ maxRowid: 5, before: "1970-01-01T00:00:00.000Z" }), 0, "时间窗没过，不许删")
    assert.equal(store.pruneMessages({ maxRowid: 2, before: future }), 2)
    assert.deepEqual(store.listMessages({}).map((m) => m.id).sort(), ["m3", "m4", "m5"])
    store.close()
  })

  it("dbSizeBytes 有值；vacuum 是手动口（调了才跑，不报错）", () => {
    const store = new LedgerStore(":memory:")
    for (let i = 1; i <= 50; i++) {
      store.insertMessageIfAbsent({ id: `v${i}`, from: "a", to: "b", type: "chat", payload: "y".repeat(500), createdAt: "2026-08-27T10:00:00+08:00", srcRelay: "r", srcSeq: i })
    }
    const before = store.dbSizeBytes()
    assert.ok(before > 0)
    store.pruneMessages({ maxRowid: 50, before: new Date(Date.now() + 86400_000).toISOString() })
    assert.equal(store.dbSizeBytes(), before, "DELETE 不回收页：这就是要留 VACUUM 手动口的原因")
    store.vacuum()
    assert.ok(store.dbSizeBytes() < before, "手动 VACUUM 才真的缩库")
    store.close()
  })
})
