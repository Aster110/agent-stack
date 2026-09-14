/**
 * LedgerSync 测试（M1）—— 游标批量上行。
 * uplink 全 mock（Hub / packages/ledger 由 Worker A 并行建，这里一行都不依赖）；
 * store 用真 Store + 临时 db（取数口的 SQL 语义也要被覆盖）。
 *
 * 覆盖设计 §4.2 的四条硬语义：
 *  ① 批按 seq 升序、srcSeq 对齐本机 seq；② 只有 ack 才推进游标；
 *  ③ 没 ack 下轮重发同批；④ 断连不发（本地库当队列，重连续传一条不丢）。
 */
import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { Store } from "./store.js"
import { LedgerSync, LEDGER_CURSOR_KEY } from "./ledger_sync.js"
import type { LedgerUplinkEvent, MeshMessage } from "@cc-mesh/protocol"
import { LEDGER_SINK } from "@cc-mesh/protocol"

class MockUplink {
  connected = true
  sent: Array<{ relayId: string; events: LedgerUplinkEvent[] }> = []
  ackCb: ((upToSeq: number) => void) | null = null

  isConnected(): boolean { return this.connected }
  sendLedger(relayId: string, events: LedgerUplinkEvent[]): boolean {
    this.sent.push({ relayId, events })
    return true
  }
  onLedgerAck(cb: (upToSeq: number) => void): void { this.ackCb = cb }
  /** 模拟 Hub 回 downlink ledger_ack */
  ack(upToSeq: number): void { this.ackCb?.(upToSeq) }
  lastBatch(): LedgerUplinkEvent[] { return this.sent[this.sent.length - 1]?.events ?? [] }
}

let msgCounter = 0
function makeMsg(overrides: Partial<MeshMessage> = {}): MeshMessage {
  msgCounter++
  return {
    id: `msg-ls-${Date.now()}-${msgCounter}-${Math.random().toString(36).slice(2, 6)}`,
    from: "macbook:cc-aaaa",
    to: "macbook:cc-bbbb",
    type: "chat",
    payload: "hello",
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

let store: Store
let dbPath: string
let uplink: MockUplink

function newSync(extra: Partial<ConstructorParameters<typeof LedgerSync>[0]> = {}): LedgerSync {
  return new LedgerSync({ store, uplink, relayId: "macbook-4242", batch: 100, debounceMs: 5, intervalMs: 10_000, ...extra })
}

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `mesh-ledger-sync-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  store = new Store(dbPath)
  uplink = new MockUplink()
})

afterEach(() => {
  store.close()
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(dbPath + suffix) } catch {}
  }
})

describe("LedgerSync — 批量取数与上行", () => {
  it("flush 发出 {relayId, events}，events 按 seq 升序、kind=message、srcSeq=本机 seq", () => {
    store.saveMessage(makeMsg({ id: "a" }))
    store.saveMessage(makeMsg({ id: "b" }))
    store.saveMessage(makeMsg({ id: "c" }))
    const sent = newSync().flush()

    assert.equal(sent, 3)
    assert.equal(uplink.sent.length, 1)
    assert.equal(uplink.sent[0].relayId, "macbook-4242")
    const events = uplink.lastBatch()
    assert.deepEqual(events.map((e) => e.msg.id), ["a", "b", "c"])
    for (const e of events) {
      assert.equal(e.kind, "message")
      assert.equal(e.srcSeq, e.msg.seq, "srcSeq 必须等于该行本机 seq")
    }
    for (let i = 1; i < events.length; i++) {
      assert.ok(events[i].srcSeq > events[i - 1].srcSeq, "srcSeq 严格升序")
    }
  })

  it("事件带落库时的 status / priority（Hub 投影要用）", () => {
    store.saveMessage(makeMsg({ id: "p1" }), "delivered", "urgent")
    newSync().flush()
    const e = uplink.lastBatch()[0]
    assert.equal(e.status, "delivered")
    assert.equal(e.priority, "urgent")
  })

  it("meta 随事件上行（派单信封在云端可查）", () => {
    store.saveMessage(makeMsg({ id: "m1", meta: { _task: { title: "T", pickReason: "explicit" } } }))
    newSync().flush()
    assert.deepEqual(uplink.lastBatch()[0].msg.meta, { _task: { title: "T", pickReason: "explicit" } })
  })

  it("@ledger 哨兵消息也进批（账目与消息同一条管道）", () => {
    store.saveMessage(makeMsg({ id: "q1", to: LEDGER_SINK, type: "quota_report" as any }), "delivered")
    newSync().flush()
    const e = uplink.lastBatch()[0]
    assert.equal(e.msg.to, LEDGER_SINK)
    assert.equal(e.msg.type, "quota_report")
  })

  it("单批不超过 batch 上限，剩下的留给下一批", () => {
    for (let i = 0; i < 7; i++) store.saveMessage(makeMsg({ id: `batch-${i}` }))
    const sync = newSync({ batch: 3 })
    assert.equal(sync.flush(), 3)
    assert.deepEqual(uplink.lastBatch().map((e) => e.msg.id), ["batch-0", "batch-1", "batch-2"])
  })

  it("无新消息 → 不发空批", () => {
    assert.equal(newSync().flush(), 0)
    assert.equal(uplink.sent.length, 0)
  })
})

describe("LedgerSync — 游标语义（ack 才推进）", () => {
  it("发出后未 ack → 游标不动，下轮重发同批", () => {
    store.saveMessage(makeMsg({ id: "r1" }))
    store.saveMessage(makeMsg({ id: "r2" }))
    const sync = newSync()

    sync.flush()
    assert.equal(sync.cursor(), 0, "没 ack 不许推游标")
    sync.flush()

    assert.equal(uplink.sent.length, 2)
    assert.deepEqual(uplink.sent[0].events.map((e) => e.msg.id), ["r1", "r2"])
    assert.deepEqual(uplink.sent[1].events.map((e) => e.msg.id), ["r1", "r2"], "重发的必须是同一批")
  })

  it("收到 ledger_ack → 游标推进并落 KV（key/updatedBy 固定），下批从新游标起", () => {
    store.saveMessage(makeMsg({ id: "k1" }))
    store.saveMessage(makeMsg({ id: "k2" }))
    const sync = newSync()
    sync.start()
    sync.flush()

    const upTo = uplink.lastBatch()[1].srcSeq
    uplink.ack(upTo)   // 经 onLedgerAck 回调进来（接线也一起验了）

    assert.equal(sync.cursor(), upTo)
    const kv = store.kvGet(LEDGER_CURSOR_KEY)!
    assert.equal(kv.value, String(upTo))
    assert.equal(kv.updatedBy, "ledger-sync")

    store.saveMessage(makeMsg({ id: "k3" }))
    uplink.sent = []
    sync.flush()
    assert.deepEqual(uplink.lastBatch().map((e) => e.msg.id), ["k3"], "已 ack 的不再重发")
    sync.stop()
  })

  it("ack 推进后自动继续排干下一批（大 backlog 不用等兜底定时）", () => {
    for (let i = 0; i < 5; i++) store.saveMessage(makeMsg({ id: `d-${i}` }))
    const sync = newSync({ batch: 2 })
    sync.start()
    sync.flush()
    assert.deepEqual(uplink.lastBatch().map((e) => e.msg.id), ["d-0", "d-1"])

    uplink.ack(uplink.lastBatch()[1].srcSeq)
    assert.deepEqual(uplink.lastBatch().map((e) => e.msg.id), ["d-2", "d-3"], "ack 后应立刻发下一批")
    sync.stop()
  })

  it("倒退 / 重复 ack 不把游标拉回（取 max）", () => {
    store.saveMessage(makeMsg({ id: "m-1" }))
    store.saveMessage(makeMsg({ id: "m-2" }))
    const sync = newSync()
    sync.flush()
    const upTo = uplink.lastBatch()[1].srcSeq

    sync.handleAck(upTo)
    sync.handleAck(1)
    sync.handleAck(upTo)
    assert.equal(sync.cursor(), upTo)
  })

  it("非法 ack（NaN）被忽略，游标不变", () => {
    store.saveMessage(makeMsg({ id: "n-1" }))
    const sync = newSync()
    sync.handleAck(Number.NaN)
    assert.equal(sync.cursor(), 0)
  })

  it("KV 里是脏值 → 游标当 0（不因脏数据整个停摆）", () => {
    store.kvSet(LEDGER_CURSOR_KEY, "毁灭吧", "手抖的人")
    store.saveMessage(makeMsg({ id: "dirty-1" }))
    const sync = newSync()
    assert.equal(sync.cursor(), 0)
    assert.equal(sync.flush(), 1)
  })
})

describe("LedgerSync — 断连与逃生阀", () => {
  it("uplink 未连接 → 本轮不发（游标不动，消息留在本地队列）", () => {
    store.saveMessage(makeMsg({ id: "off-1" }))
    uplink.connected = false
    const sync = newSync()

    assert.equal(sync.flush(), 0)
    assert.equal(uplink.sent.length, 0)
    assert.equal(sync.cursor(), 0)
  })

  it("断网攒 N 条 → 重连后一批补齐，一条不丢（M1 验收①）", () => {
    const sync = newSync({ batch: 100 })
    uplink.connected = false
    for (let i = 0; i < 12; i++) {
      store.saveMessage(makeMsg({ id: `gap-${i}` }))
      sync.flush()   // 断网期间每次写都试一次，全部落空
    }
    assert.equal(uplink.sent.length, 0)

    uplink.connected = true
    assert.equal(sync.flush(), 12)
    assert.deepEqual(
      uplink.lastBatch().map((e) => e.msg.id),
      Array.from({ length: 12 }, (_, i) => `gap-${i}`),
    )
  })

  it("MESH_LEDGER_SYNC=0 → 整体停用：不发批、不推游标、start 不装定时器", () => {
    store.saveMessage(makeMsg({ id: "kill-1" }))
    const sync = newSync({ env: { MESH_LEDGER_SYNC: "0" } as NodeJS.ProcessEnv })

    assert.equal(sync.enabled, false)
    sync.start()
    assert.equal(sync.flush(), 0)
    sync.notifyWrite()
    sync.handleAck(99)
    assert.equal(uplink.sent.length, 0)
    assert.equal(store.kvGet(LEDGER_CURSOR_KEY), undefined, "停用时不许写游标 KV")
    assert.equal(uplink.ackCb, null, "停用时不该订阅 ack")
  })

  it("env 未设 / 设成别的值 → 默认启用", () => {
    assert.equal(newSync({ env: {} as NodeJS.ProcessEnv }).enabled, true)
    assert.equal(newSync({ env: { MESH_LEDGER_SYNC: "1" } as NodeJS.ProcessEnv }).enabled, true)
  })
})

describe("LedgerSync — 触发时机（debounce + 兜底定时）", () => {
  it("notifyWrite 在窗口内多次调用只发一批（写风暴合并）", async () => {
    const sync = newSync({ debounceMs: 20 })
    for (let i = 0; i < 5; i++) {
      store.saveMessage(makeMsg({ id: `deb-${i}` }))
      sync.notifyWrite()
    }
    assert.equal(uplink.sent.length, 0, "debounce 期间不应立刻发")

    await new Promise((r) => setTimeout(r, 60))
    assert.equal(uplink.sent.length, 1)
    assert.equal(uplink.lastBatch().length, 5, "合并后一批带上窗口内全部消息")
    sync.stop()
  })

  it("兜底定时器周期 flush（没人写也会补同步）", async () => {
    const sync = newSync({ intervalMs: 20 })
    sync.start()
    store.saveMessage(makeMsg({ id: "tick-1" }))

    await new Promise((r) => setTimeout(r, 70))
    assert.ok(uplink.sent.length >= 1, "定时兜底应至少触发一次")
    assert.equal(uplink.lastBatch()[0].msg.id, "tick-1")
    sync.stop()
  })

  it("stop() 后 debounce / 定时都不再触发", async () => {
    const sync = newSync({ debounceMs: 10, intervalMs: 10 })
    sync.start()
    store.saveMessage(makeMsg({ id: "stop-1" }))
    sync.notifyWrite()
    sync.stop()

    await new Promise((r) => setTimeout(r, 50))
    assert.equal(uplink.sent.length, 0)
  })
})
