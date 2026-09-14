/** P65 Module A — cc_todo_* 热层到 D1 的转发契约（全程 mock fetch）。 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { LedgerStore } from "./store.js"
import {
  D1Forwarder, FORWARD_TABLES, STREAM_TABLES, SNAPSHOT_TABLES, RETENTION_TABLES,
} from "./forwarder.js"
import type { FetchInit, FetchResponseLike } from "./forwarder.js"

interface Call { url: string; init: FetchInit; body: any }

class MockFetch {
  calls: Call[] = []
  queue: Array<number | Error> = []
  fallback = 200

  readonly impl = async (url: string, init: FetchInit): Promise<FetchResponseLike> => {
    const call = { url, init, body: JSON.parse(init.body) }
    this.calls.push(call)
    const next = this.queue.length ? this.queue.shift()! : this.fallback
    if (next instanceof Error) throw next
    return { status: next, text: async () => JSON.stringify({ ok: next >= 200 && next < 300 }) }
  }

  rows(table: string, call = this.calls.at(-1)): any[] {
    return call?.body?.batches?.find((b: any) => b.table === table)?.rows ?? []
  }
}

function seedTodo(store: LedgerStore, over: Record<string, unknown> = {}): void {
  const fn = (store as any).applyCcTodoChange
  assert.equal(typeof fn, "function", "LedgerStore 缺 applyCcTodoChange")
  fn.call(store, {
    schemaVersion: 1,
    uid: "ctd_fwd_01",
    legacyId: "f99-4",
    category: "cc",
    status: "pending",
    project: "P65",
    dependsOn: [],
    createdAt: "2026-08-28T22:00:00.000Z",
    updatedAt: "2026-08-28T22:00:01.000Z",
    baseRevision: 0,
    opId: "op-fwd-001",
    originDevice: "mini",
    contentDigest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    ...over,
  })
}

function forwarder(store: LedgerStore, mf: MockFetch): D1Forwarder {
  return new D1Forwarder({
    store,
    url: "https://mesh-console.example.test",
    token: "test-ingest-token",
    fetchImpl: mf.impl,
    quiet: true,
    batch: 100,
  })
}

function tableRows(store: LedgerStore, table: string): Array<Record<string, unknown>> {
  return store.readAllRows(table).map((x) => x.row)
}

describe("cc-todo D1Forwarder · strict table routing", () => {
  it("cc_todo_changes 是 ignore stream；cc_todo_items 是 replace snapshot；没有别名表", () => {
    assert.deepEqual([...FORWARD_TABLES].sort(), [
      "accounts", "cc_todo_changes", "cc_todo_items", "events", "ledger_messages",
      "quota_snapshots", "seats", "tasks",
    ].sort())
    assert.ok((STREAM_TABLES as readonly string[]).includes("cc_todo_changes"))
    assert.ok(!(STREAM_TABLES as readonly string[]).includes("cc_todo_items"))
    assert.ok((SNAPSHOT_TABLES as readonly string[]).includes("cc_todo_items"))
    assert.ok(!(SNAPSHOT_TABLES as readonly string[]).includes("cc_todo_changes"))
    assert.ok(!(RETENTION_TABLES as readonly string[]).includes("cc_todo_items"))
    assert.ok(!(RETENTION_TABLES as readonly string[]).includes("cc_todo_changes"))
    for (const forbidden of ["personal_tasks", "personal_task_changes", "cc_todos"]) {
      assert.ok(!(FORWARD_TABLES as readonly string[]).includes(forbidden), `禁止别名表 ${forbidden}`)
    }
  })

  it("两表发出的列集合与热层 DDL 逐字一致，且不混入 dispatch tasks", async () => {
    const store = new LedgerStore(":memory:")
    seedTodo(store)
    store.upsertTask({
      taskId: "dispatch-keep", title: "dispatch fixture", project: "P62", fromNode: "a", toNode: "b",
      pickReason: "explicit", status: "dispatched", createdAt: "2026-08-28T22:00:00.000Z",
    })
    const mf = new MockFetch()
    const fwd = forwarder(store, mf)

    await fwd.flushOnce()
    const change = mf.rows("cc_todo_changes")[0]
    assert.deepEqual(Object.keys(change).sort(), store.columnNames("cc_todo_changes").sort())
    assert.equal(mf.rows("tasks").length, 0, "stream 轮不得夹带 dispatch snapshot")

    mf.calls.length = 0
    await fwd.flushSnapshotsOnce()
    const item = mf.rows("cc_todo_items")[0]
    assert.deepEqual(Object.keys(item).sort(), store.columnNames("cc_todo_items").sort())
    assert.ok(!JSON.stringify(item).includes("dispatch-keep"))
    assert.equal(store.getTask("dispatch-keep")?.status, "dispatched")
    store.close()
  })
})

describe("cc-todo D1Forwarder · 2xx watermark/retry", () => {
  it("changes stream 非 2xx 不推进水位；下一轮原批重试；2xx 后才推进", async () => {
    const store = new LedgerStore(":memory:")
    seedTodo(store)
    const mf = new MockFetch()
    mf.queue = [503, 200]
    const fwd = forwarder(store, mf)

    const bad = await fwd.flushOnce()
    assert.equal(bad.ok, false)
    assert.equal(store.getForwardWatermark("cc_todo_changes"), 0)
    const firstRows = mf.rows("cc_todo_changes", mf.calls[0])
    assert.equal(firstRows.length, 1)

    const good = await fwd.flushOnce()
    assert.equal(good.ok, true)
    const retried = mf.rows("cc_todo_changes", mf.calls[1])
    assert.deepEqual(retried, firstRows, "失败后必须重试同一 audit 行")
    assert.ok(store.getForwardWatermark("cc_todo_changes") > 0)
    store.close()
  })

  it("items snapshot 失败不记 digest；下一轮完整重推；2xx 后 unchanged", async () => {
    const store = new LedgerStore(":memory:")
    seedTodo(store)
    const mf = new MockFetch()
    mf.queue = [500, 200]
    const fwd = forwarder(store, mf)

    const bad = await fwd.flushSnapshotsOnce()
    assert.equal(bad.ok, false)
    const firstRows = mf.rows("cc_todo_items", mf.calls[0])
    assert.equal(firstRows.length, 1)

    const good = await fwd.flushSnapshotsOnce()
    assert.equal(good.ok, true)
    assert.deepEqual(mf.rows("cc_todo_items", mf.calls[1]), firstRows)
    const unchanged = await fwd.flushSnapshotsOnce()
    assert.equal(unchanged.reason, "unchanged")
    assert.equal(mf.calls.length, 2, "成功后 digest 命中，不再打 D1")
    store.close()
  })

  it("真 conflict→resolve 只改变 cc_todo 两路；dispatch tasks 存储字节与已记 digest 均不变", async () => {
    const store = new LedgerStore(":memory:")
    store.upsertTask({
      taskId: "dispatch-byte-lock", title: "dispatch fixture", project: "P62",
      fromNode: "a", toNode: "b", pickReason: "explicit", status: "dispatched",
      createdAt: "2026-08-28T22:00:00.000Z",
    })
    const dispatchBefore = JSON.stringify(tableRows(store, "tasks"))
    seedTodo(store)
    const mf = new MockFetch()
    const fwd = forwarder(store, mf)

    await fwd.flushOnce()
    await fwd.flushSnapshotsOnce()
    const baselineTasks = mf.calls.flatMap((call) => mf.rows("tasks", call))
    assert.equal(JSON.stringify(baselineTasks), dispatchBefore, "首轮 dispatch snapshot 字节必须等于库中原字节")
    mf.calls.length = 0

    const d = store as any
    const conflict = d.applyCcTodoChange({
      schemaVersion: 1,
      uid: "ctd_fwd_01",
      legacyId: "f99-4",
      category: "cc",
      status: "doing",
      project: "P65",
      dependsOn: [],
      createdAt: "2026-08-28T22:00:00.000Z",
      updatedAt: "2026-08-28T22:00:02.000Z",
      baseRevision: 0,
      opId: "op-fwd-conflict",
      originDevice: "air",
      contentDigest: "sha256:6666666666666666666666666666666666666666666666666666666666666666",
    })
    assert.equal(conflict.outcome, "conflict")
    const resolved = d.resolveCcTodoConflict({
      schemaVersion: 1,
      uid: "ctd_fwd_01",
      legacyId: "f99-4",
      category: "cc",
      status: "doing",
      project: "P65",
      dependsOn: [],
      createdAt: "2026-08-28T22:00:00.000Z",
      updatedAt: "2026-08-28T22:00:03.000Z",
      baseRevision: 1,
      opId: "op-fwd-resolve",
      originDevice: "mini",
      contentDigest: "sha256:6666666666666666666666666666666666666666666666666666666666666666",
      resolvesOpId: "op-fwd-conflict",
    })
    assert.equal(resolved.outcome, "resolved")
    assert.equal(JSON.stringify(tableRows(store, "tasks")), dispatchBefore)

    const stream = await fwd.flushOnce()
    assert.equal(stream.ok, true)
    assert.deepEqual(mf.calls.flatMap((call) => mf.rows("cc_todo_changes", call)).map((x) => x.outcome), [
      "conflict", "resolved",
    ])
    assert.equal(mf.calls.flatMap((call) => mf.rows("tasks", call)).length, 0)
    mf.calls.length = 0

    const snapshot = await fwd.flushSnapshotsOnce()
    assert.equal(snapshot.ok, true)
    assert.equal(mf.calls.flatMap((call) => mf.rows("cc_todo_items", call)).length, 1)
    assert.equal(mf.calls.flatMap((call) => mf.rows("tasks", call)).length, 0, "tasks digest 未变不得重推")
    assert.equal(JSON.stringify(tableRows(store, "tasks")), dispatchBefore)
    store.close()
  })
})
