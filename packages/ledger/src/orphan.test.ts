/**
 * 孤儿扫描单测 — 设计 §6.3 第三条（北极星 UU3 落地）。
 * 纯函数：(store, isDeviceOnline, timeoutMs, nowMs) → 标记结果，无定时器无 IO。
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { LedgerStore } from "./store.js"
import { sweep } from "./orphan.js"

const T0 = "2026-08-27T10:00:00+08:00"
const t0ms = Date.parse(T0)
const HOUR = 3600_000

function withTask(status = "dispatched", toNode = "mini:cc-w1", createdAt = T0): LedgerStore {
  const store = new LedgerStore(":memory:")
  store.upsertTask({ taskId: "t1", title: "活", project: "P62", fromNode: "macbook:cc-main", toNode, pickReason: "explicit", status, createdAt })
  return store
}

describe("orphan.sweep", () => {
  it("设备在线 → 超时也不标（人还在，只是慢）", () => {
    const store = withTask()
    const r = sweep(store, () => true, 30 * 60_000, t0ms + 5 * HOUR)
    assert.deepEqual(r.orphaned, [])
    assert.equal(store.getTask("t1")!.status, "dispatched")
    assert.equal(store.listEvents({ kind: "orphan_marked" }).length, 0)
    store.close()
  })

  it("设备离线但没超时 → 不标（给重连留窗口）", () => {
    const store = withTask()
    const r = sweep(store, () => false, 30 * 60_000, t0ms + 10 * 60_000)
    assert.deepEqual(r.orphaned, [])
    assert.equal(store.getTask("t1")!.status, "dispatched")
    store.close()
  })

  it("设备离线 + 超时 → orphaned + events 记 orphan_marked", () => {
    const store = withTask()
    const seen: string[] = []
    const r = sweep(store, (d) => { seen.push(d); return false }, 30 * 60_000, t0ms + HOUR)
    assert.deepEqual(r.orphaned, ["t1"])
    assert.equal(store.getTask("t1")!.status, "orphaned")
    assert.deepEqual(seen, ["mini"])       // nodeId 冒号前段 = deviceId
    const [ev] = store.listEvents({ kind: "orphan_marked" })
    assert.equal(ev.nodeId, "mini:cc-w1")
    assert.equal(ev.device, "mini")
    assert.equal((ev.detail as Record<string, unknown>).taskId, "t1")
    store.close()
  })

  it("只扫 dispatched：replied / orphaned / failed 一律不动", () => {
    for (const st of ["replied", "orphaned", "failed", "done"]) {
      const store = withTask(st)
      const r = sweep(store, () => false, 0, t0ms + 10 * HOUR)
      assert.deepEqual(r.orphaned, [], `status=${st} 不该被标`)
      assert.equal(store.getTask("t1")!.status, st)
      store.close()
    }
  })

  it("to_node 无冒号 → 整串当 deviceId", () => {
    const store = withTask("dispatched", "solo-node")
    const seen: string[] = []
    sweep(store, (d) => { seen.push(d); return false }, 0, t0ms + HOUR)
    assert.deepEqual(seen, ["solo-node"])
    store.close()
  })

  it("重复 sweep 幂等：第二次不再重复标记也不再记事件", () => {
    const store = withTask()
    sweep(store, () => false, 30 * 60_000, t0ms + HOUR)
    const r2 = sweep(store, () => false, 30 * 60_000, t0ms + 2 * HOUR)
    assert.deepEqual(r2.orphaned, [])
    assert.equal(store.listEvents({ kind: "orphan_marked" }).length, 1)
    store.close()
  })

  it("created_at 不可解析 → 跳过，不误伤", () => {
    const store = withTask("dispatched", "mini:cc-w1", "不是时间")
    const r = sweep(store, () => false, 0, t0ms + 10 * HOUR)
    assert.deepEqual(r.orphaned, [])
    store.close()
  })

  it("to_node 为空 → 跳过", () => {
    const store = new LedgerStore(":memory:")
    store.upsertTask({ taskId: "t1", title: "活", project: null, fromNode: "a", toNode: null, pickReason: "explicit", status: "dispatched", createdAt: T0 })
    const r = sweep(store, () => false, 0, t0ms + 10 * HOUR)
    assert.deepEqual(r.orphaned, [])
    store.close()
  })
})
