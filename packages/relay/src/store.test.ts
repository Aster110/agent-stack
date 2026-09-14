/**
 * Store 测试 — SQLite 持久化层
 *
 * 职责：消息存取、节点注册/查询/心跳、KV 黑板读写
 * 使用临时 DB 文件，测试完清理
 */
import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { Store } from "./store.js"
import type { MeshMessage, LocalNode } from "@cc-mesh/protocol"
import Database from "better-sqlite3"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

function tmpDb(): string {
  return path.join(os.tmpdir(), `mesh-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
}

function makeNode(overrides: Partial<LocalNode> & { identity?: Partial<LocalNode["identity"]> } = {}): LocalNode {
  const defaults: LocalNode = {
    identity: {
      nodeId: "macbook:cc-a1b2",
      deviceId: "macbook",
      shortId: "cc-a1b2",
      role: "worker",
      description: "test node",
      capabilities: [],
    },
    sessionId: "sess-001",
    pid: 12345,
    lastSeen: new Date().toISOString(),
    status: "idle",
  }
  return {
    ...defaults,
    ...overrides,
    identity: { ...defaults.identity, ...(overrides.identity ?? {}) },
  }
}

let msgCounter = 0
function makeMsg(overrides: Partial<MeshMessage> = {}): MeshMessage {
  msgCounter++
  return {
    id: `msg-${Date.now()}-test-${msgCounter}-${Math.random().toString(36).slice(2, 6)}`,
    from: "macbook:cc-a1b2",
    to: "macbook:cc-c3d4",
    type: "chat",
    payload: "hello",
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

describe("Store — Messages", () => {
  let store: Store
  let dbPath: string

  before(() => {
    dbPath = tmpDb()
    store = new Store(dbPath)
  })

  after(() => {
    store.close()
    try { fs.unlinkSync(dbPath) } catch {}
    try { fs.unlinkSync(dbPath + "-wal") } catch {}
    try { fs.unlinkSync(dbPath + "-shm") } catch {}
  })

  it("saveMessage + getInbox 能存取消息", () => {
    const msg = makeMsg({ id: "msg-1", to: "node-A" })
    store.saveMessage(msg)
    const inbox = store.getInbox("node-A")
    assert.equal(inbox.length, 1)
    assert.equal(inbox[0].id, "msg-1")
    assert.equal(inbox[0].payload, "hello")
  })

  it("getInbox 返回广播消息（to='*'）", () => {
    const msg = makeMsg({ id: "msg-broadcast", to: "*" })
    store.saveMessage(msg)
    const inbox = store.getInbox("any-node")
    const found = inbox.find(m => m.id === "msg-broadcast")
    assert.ok(found, "广播消息应出现在任意节点的收件箱")
  })

  // 排序语义由 created_at DESC 改为 seq ASC（游标补拉需单调升序）。
  // msg1 先存 → seq 更小 → ASC 下排在前。
  it("getInbox 按 seq ASC 排序（插入顺序）", () => {
    const msg1 = makeMsg({ id: "msg-old", to: "node-sort-test", createdAt: "2026-01-01T00:00:00Z" })
    const msg2 = makeMsg({ id: "msg-new", to: "node-sort-test", createdAt: "2026-03-01T00:00:00Z" })
    store.saveMessage(msg1)
    store.saveMessage(msg2)
    const inbox = store.getInbox("node-sort-test")
    // 过滤掉广播消息，只看直接发给 node-sort-test 的
    const direct = inbox.filter(m => m.to === "node-sort-test")
    assert.equal(direct[0].id, "msg-old", "seq ASC：先存的 msg-old 排在前")
    assert.equal(direct[1].id, "msg-new")
  })

  it("getInbox 受 limit 限制", () => {
    for (let i = 0; i < 5; i++) {
      store.saveMessage(makeMsg({ id: `msg-limit-${i}`, to: "node-C" }))
    }
    const inbox = store.getInbox("node-C", { limit: 3 })
    assert.equal(inbox.length, 3)
  })

  it("updateMessageStatus 更新状态", () => {
    const msg = makeMsg({ id: "msg-status-test", to: "node-D" })
    store.saveMessage(msg, "submitted")
    store.updateMessageStatus("msg-status-test", "delivered")
    // 直接用 db.prepare 查 raw 数据验证 status 实际变成了 "delivered"
    const db = new Database(dbPath, { readonly: true })
    const row = db.prepare("SELECT status, delivered_at FROM messages WHERE id = ?").get("msg-status-test") as any
    db.close()
    assert.equal(row.status, "delivered")
    assert.ok(row.delivered_at, "delivered_at 应该被设置")
  })

  it("saveMessage 相同 id 会覆盖（INSERT OR REPLACE）", () => {
    const msg1 = makeMsg({ id: "msg-dup", to: "node-E", payload: "v1" })
    const msg2 = makeMsg({ id: "msg-dup", to: "node-E", payload: "v2" })
    store.saveMessage(msg1)
    store.saveMessage(msg2)
    const inbox = store.getInbox("node-E")
    const found = inbox.filter(m => m.id === "msg-dup")
    assert.equal(found.length, 1)
    assert.equal(found[0].payload, "v2")
  })

  // ===== 补充：getInbox 隔离性 =====
  it("getInbox 隔离性：发给 node-X 的消息不出现在 node-Y 的 inbox", () => {
    const msg = makeMsg({ id: "msg-isolation", to: "node-X", payload: "only for X" })
    store.saveMessage(msg)
    const inboxY = store.getInbox("node-Y")
    const found = inboxY.find(m => m.id === "msg-isolation")
    assert.equal(found, undefined, "node-Y 不应看到发给 node-X 的消息")
  })

  // ===== 补充：空 payload 消息正常存取 =====
  it("空 payload 消息正常存取", () => {
    const msg = makeMsg({ id: "msg-empty-payload", to: "node-F", payload: "" })
    store.saveMessage(msg)
    const inbox = store.getInbox("node-F")
    const found = inbox.find(m => m.id === "msg-empty-payload")
    assert.ok(found)
    assert.equal(found.payload, "")
  })
})

describe("Store — Nodes", () => {
  let store: Store
  let dbPath: string

  before(() => {
    dbPath = tmpDb()
    store = new Store(dbPath)
  })

  after(() => {
    store.close()
    try { fs.unlinkSync(dbPath) } catch {}
    try { fs.unlinkSync(dbPath + "-wal") } catch {}
    try { fs.unlinkSync(dbPath + "-shm") } catch {}
  })

  it("saveNode + getNode 能存取节点", () => {
    const node = makeNode()
    store.saveNode(node)
    const got = store.getNode("macbook:cc-a1b2")
    assert.ok(got)
    assert.equal(got.identity.nodeId, "macbook:cc-a1b2")
    assert.equal(got.identity.role, "worker")
    assert.equal(got.sessionId, "sess-001")
    assert.equal(got.pid, 12345)
  })

  it("getNode 不存在返回 undefined", () => {
    const got = store.getNode("nonexistent:cc-0000")
    assert.equal(got, undefined)
  })

  it("getAllNodes 返回所有节点", () => {
    const node2 = makeNode({
      identity: { nodeId: "mini:cc-e5f6", deviceId: "mini", shortId: "cc-e5f6", role: "main", description: "mini node", capabilities: [] },
      sessionId: "sess-002",
      pid: 54321,
    })
    store.saveNode(node2)
    const all = store.getAllNodes()
    assert.ok(all.length >= 2)
    const ids = all.map(n => n.identity.nodeId)
    assert.ok(ids.includes("macbook:cc-a1b2"))
    assert.ok(ids.includes("mini:cc-e5f6"))
  })

  it("removeNode 删除节点", () => {
    store.removeNode("mini:cc-e5f6")
    const got = store.getNode("mini:cc-e5f6")
    assert.equal(got, undefined)
  })

  it("updateHeartbeat 更新 lastSeen", async () => {
    const before_ = store.getNode("macbook:cc-a1b2")
    assert.ok(before_)
    const oldLastSeen = before_.lastSeen
    // 等 10ms 确保时间戳不同
    await new Promise(resolve => setTimeout(resolve, 10))
    store.updateHeartbeat("macbook:cc-a1b2")
    const after_ = store.getNode("macbook:cc-a1b2")
    assert.ok(after_)
    assert.ok(after_.lastSeen > oldLastSeen, "lastSeen 应该严格大于旧值")
  })

  it("saveNode 相同 nodeId 会覆盖", () => {
    const node = makeNode({ status: "busy" })
    store.saveNode(node)
    const got = store.getNode("macbook:cc-a1b2")
    assert.ok(got)
    assert.equal(got.status, "busy")
  })

  // ===== B1: deliveryMode 持久化往返 =====
  it("saveNode→getNode 往返保留 deliveryMode=sse-pull", () => {
    const node = makeNode({
      identity: { nodeId: "macbook:cc-pull", deviceId: "macbook", shortId: "cc-pull", role: "worker", description: "pull node", capabilities: [], deliveryMode: "sse-pull" },
      sessionId: "nopane-macbook:cc-pull",
    })
    store.saveNode(node)
    const got = store.getNode("macbook:cc-pull")
    assert.ok(got)
    assert.equal(got.identity.deliveryMode, "pull", "PR2:store 读写侧归一 sse-pull→pull")
  })

  it("saveNode 不带 deliveryMode→getNode 读回 inject 缺省", () => {
    // makeNode 默认 identity 无 deliveryMode
    const node = makeNode({
      identity: { nodeId: "macbook:cc-default", deviceId: "macbook", shortId: "cc-default", role: "worker", description: "default node", capabilities: [] },
    })
    store.saveNode(node)
    const got = store.getNode("macbook:cc-default")
    assert.ok(got)
    assert.equal(got.identity.deliveryMode, "inject", "缺省应读回 inject（?? 'inject' 兜底）")
  })
})

// ===== A3: nodes 表迁移 — 老行（delivery_mode 列缺失/NULL）零回归 =====
describe("Store — Nodes 迁移（delivery_mode 列）", () => {
  let dbPath: string

  before(() => {
    dbPath = tmpDb()
  })

  after(() => {
    try { fs.unlinkSync(dbPath) } catch {}
    try { fs.unlinkSync(dbPath + "-wal") } catch {}
    try { fs.unlinkSync(dbPath + "-shm") } catch {}
  })

  it("老 nodes 行(delivery_mode 列为 NULL)读回 inject 不失活", () => {
    // 模拟「老库」：手建一个不含 delivery_mode 列的 nodes 表 + 插一行
    const raw = new Database(dbPath)
    raw.exec(`
      CREATE TABLE nodes (
        node_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        short_id TEXT NOT NULL,
        session_id TEXT,
        pid INTEGER,
        role TEXT NOT NULL,
        description TEXT DEFAULT '',
        status TEXT DEFAULT 'idle',
        registered_at TEXT NOT NULL,
        last_seen TEXT NOT NULL
      );
    `)
    raw.prepare(`
      INSERT INTO nodes (node_id, device_id, short_id, session_id, pid, role, description, status, registered_at, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("macbook:cc-old", "macbook", "cc-old", "sess-old", 999, "main", "old node", "idle", new Date().toISOString(), new Date().toISOString())
    raw.close()

    // new Store 触发 migrate（应补列），读回老行
    const store = new Store(dbPath)
    try {
      const got = store.getNode("macbook:cc-old")
      assert.ok(got, "老节点应仍可读出（未失活）")
      assert.equal(got.identity.deliveryMode, "inject", "老行 delivery_mode NULL → 读回 inject")
      assert.equal(got.sessionId, "sess-old")
      assert.equal(got.identity.role, "main")
    } finally {
      store.close()
    }
  })

  it("迁移幂等：同一 dbPath 二次 new Store 不 throw duplicate column", () => {
    // 第一次已在上一个 it 里 new 过；这里再连两次确认幂等
    const s1 = new Store(dbPath)
    s1.close()
    assert.doesNotThrow(() => {
      const s2 = new Store(dbPath)
      s2.close()
    }, "ALTER TABLE ADD COLUMN 重复执行不能抛 duplicate column")
  })
})

// ===== M3: messages 游标(seq) + ack 销账 =====
describe("Store — messages seq 游标 + ack（E3/E4/A3）", () => {
  let store: Store
  let dbPath: string

  before(() => {
    dbPath = tmpDb()
    store = new Store(dbPath)
  })

  after(() => {
    store.close()
    try { fs.unlinkSync(dbPath) } catch {}
    try { fs.unlinkSync(dbPath + "-wal") } catch {}
    try { fs.unlinkSync(dbPath + "-shm") } catch {}
  })

  // 读取 messages 表某行的 seq（readonly 直查）
  function rawSeq(id: string): number | null {
    const db = new Database(dbPath, { readonly: true })
    const row = db.prepare("SELECT seq FROM messages WHERE id = ?").get(id) as any
    db.close()
    return row ? row.seq : null
  }
  function rawAcked(id: string): number | null {
    const db = new Database(dbPath, { readonly: true })
    const row = db.prepare("SELECT acked FROM messages WHERE id = ?").get(id) as any
    db.close()
    return row ? row.acked : null
  }

  it("saveMessage 自动分配单调自增 seq（连存3条 seq 严格递增）", () => {
    store.saveMessage(makeMsg({ id: "seq-1", to: "node-seq" }))
    store.saveMessage(makeMsg({ id: "seq-2", to: "node-seq" }))
    store.saveMessage(makeMsg({ id: "seq-3", to: "node-seq" }))
    const s1 = rawSeq("seq-1")!, s2 = rawSeq("seq-2")!, s3 = rawSeq("seq-3")!
    assert.ok(s1 < s2 && s2 < s3, `seq 应严格递增, got ${s1},${s2},${s3}`)
  })

  it("getInbox(since) 只返回 seq>since 的消息且按 seq ASC", () => {
    store.saveMessage(makeMsg({ id: "cur-1", to: "node-cursor" }))
    store.saveMessage(makeMsg({ id: "cur-2", to: "node-cursor" }))
    store.saveMessage(makeMsg({ id: "cur-3", to: "node-cursor" }))
    const page1 = store.getInbox("node-cursor")
    const direct = page1.filter(m => m.to === "node-cursor")
    const cur = (direct[direct.length - 1] as any).seq as number
    const page2 = store.getInbox("node-cursor", { since: cur })
    const direct2 = page2.filter(m => m.to === "node-cursor")
    assert.equal(direct2.length, 0, "since=末条 seq 后应无新直发消息")
    // 用更小的 since 验证升序与过滤
    const firstSeq = (direct[0] as any).seq as number
    const page3 = store.getInbox("node-cursor", { since: firstSeq })
    const direct3 = page3.filter(m => m.to === "node-cursor")
    assert.ok(direct3.every(m => (m as any).seq > firstSeq), "只返回 seq>since")
    for (let i = 1; i < direct3.length; i++) {
      assert.ok((direct3[i] as any).seq > (direct3[i - 1] as any).seq, "结果按 seq ASC")
    }
  })

  it("getInbox 默认 since=0 时按 seq ASC 返回全部（修 DESC LIMIT 50 截断）", () => {
    for (let i = 0; i < 60; i++) {
      store.saveMessage(makeMsg({ id: `bulk-${i}`, to: "node-bulk" }))
    }
    const inbox = store.getInbox("node-bulk", { since: 0 })
    const direct = inbox.filter(m => m.to === "node-bulk")
    assert.equal(direct.length, 60, ">50 条不应被 LIMIT 50 截断")
    for (let i = 1; i < direct.length; i++) {
      assert.ok((direct[i] as any).seq > (direct[i - 1] as any).seq, "按 seq 升序")
    }
    assert.ok((direct[0] as any).seq <= (direct[1] as any).seq)
  })

  it("getInbox(since) 仍包含广播 to='*' 且广播也参与 seq 游标", () => {
    store.saveMessage(makeMsg({ id: "g-direct", to: "node-G" }))
    store.saveMessage(makeMsg({ id: "g-bcast", to: "*" }))
    const inbox = store.getInbox("node-G", { since: 0 })
    assert.ok(inbox.find(m => m.id === "g-direct"), "直发应出现")
    const bcast = inbox.find(m => m.id === "g-bcast")
    assert.ok(bcast, "广播应出现在 node-G inbox")
    const bcastSeq = (bcast as any).seq as number
    const inbox2 = store.getInbox("node-G", { since: bcastSeq })
    assert.ok(!inbox2.find(m => m.id === "g-bcast"), "since=广播 seq 后广播不再重复返回")
  })

  // ===== E4: ack 推进游标 =====
  it("ack(nodeId, seq) 推进游标后 getInbox(since=游标) 不再返回已 ack 消息", () => {
    store.saveMessage(makeMsg({ id: "ack-1", to: "node-ack" }))
    store.saveMessage(makeMsg({ id: "ack-2", to: "node-ack" }))
    store.saveMessage(makeMsg({ id: "ack-3", to: "node-ack" }))
    const inbox = store.getInbox("node-ack").filter(m => m.to === "node-ack")
    const cur = (inbox[inbox.length - 1] as any).seq as number
    store.ack("node-ack", cur)
    const after = store.getInbox("node-ack", { since: store.getAckCursor("node-ack") }).filter(m => m.to === "node-ack")
    assert.ok(after.every(m => (m as any).seq > cur), "ack 后只得 seq>cur 的新消息")
    assert.ok(!after.find(m => m.id === "ack-1"), "已 ack 的不重复")
  })

  it("ack 落 acked 标记：被 ack 的消息行 acked 列被置位（按 seq 截止）", () => {
    const ids = ["am-1", "am-2", "am-3", "am-4", "am-5"]
    for (const id of ids) store.saveMessage(makeMsg({ id, to: "node-ackmark" }))
    const inbox = store.getInbox("node-ackmark").filter(m => m.to === "node-ackmark")
    const ackPoint = (inbox[2] as any).seq as number  // ack 到第3条
    store.ack("node-ackmark", ackPoint)
    for (const m of inbox) {
      const seq = (m as any).seq as number
      const acked = rawAcked(m.id)
      if (seq <= ackPoint) assert.ok(acked === 1 || acked != null && acked !== 0, `seq<=ack点的 ${m.id} acked 应置位`)
      else assert.ok(acked === 0 || acked == null, `seq>ack点的 ${m.id} acked 不应置位`)
    }
  })

  it("ack 单调不回退：用更小 seq 调 ack 不把游标拉回", () => {
    store.saveMessage(makeMsg({ id: "mono-1", to: "node-mono" }))
    store.saveMessage(makeMsg({ id: "mono-2", to: "node-mono" }))
    store.saveMessage(makeMsg({ id: "mono-3", to: "node-mono" }))
    const inbox = store.getInbox("node-mono").filter(m => m.to === "node-mono")
    const high = (inbox[inbox.length - 1] as any).seq as number
    const low = (inbox[0] as any).seq as number
    store.ack("node-mono", high)
    store.ack("node-mono", low)  // 倒退 ack
    assert.equal(store.getAckCursor("node-mono"), high, "游标取 max，不被拉回")
    const after = store.getInbox("node-mono", { since: store.getAckCursor("node-mono") }).filter(m => m.to === "node-mono")
    assert.ok(after.every(m => (m as any).seq > high), "仍只返回 seq>high")
  })

  it("ack 不存在的 nodeId 不抛错（容错幂等）", () => {
    assert.doesNotThrow(() => store.ack("never-seen-node", 999))
  })

  it("saveMessage 同 id 覆盖(INSERT OR REPLACE)后 seq 不回退（不破坏游标单调）", () => {
    store.saveMessage(makeMsg({ id: "dup-seq", to: "node-dupseq", payload: "v1" }))
    const seqBefore = rawSeq("dup-seq")!
    // 之后再存别的消息推高 seq，再覆盖 dup-seq
    store.saveMessage(makeMsg({ id: "other-1", to: "node-dupseq" }))
    store.saveMessage(makeMsg({ id: "dup-seq", to: "node-dupseq", payload: "v2" }))
    const inbox = store.getInbox("node-dupseq").filter(m => m.id === "dup-seq")
    assert.equal(inbox.length, 1, "同 id 仍只 1 行")
    assert.equal(inbox[0].payload, "v2")
    const seqAfter = rawSeq("dup-seq")!
    assert.ok(seqAfter >= seqBefore, `覆盖后 seq 不回退, before=${seqBefore} after=${seqAfter}`)
  })
})

// ===== A3: messages 表迁移 — 老表无 seq/acked 列 =====
describe("Store — messages 迁移（seq/acked 列）（A3）", () => {
  let dbPath: string

  before(() => {
    dbPath = tmpDb()
  })

  after(() => {
    try { fs.unlinkSync(dbPath) } catch {}
    try { fs.unlinkSync(dbPath + "-wal") } catch {}
    try { fs.unlinkSync(dbPath + "-shm") } catch {}
  })

  function hasColumn(table: string, col: string): boolean {
    const db = new Database(dbPath, { readonly: true })
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    db.close()
    return cols.some(c => c.name === col)
  }

  it("旧 messages 表无 seq/acked 列：二次 new Store 不报错且补列", () => {
    // 手建【旧 schema】messages 表（只含 9 列，无 seq/acked）+ 插一行老消息
    const raw = new Database(dbPath)
    raw.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        "from" TEXT NOT NULL,
        "to" TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT,
        reply_to TEXT,
        status TEXT DEFAULT 'submitted',
        created_at TEXT NOT NULL,
        delivered_at TEXT
      );
    `)
    raw.prepare(`
      INSERT INTO messages (id, "from", "to", type, payload, reply_to, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("legacy-msg", "macbook:cc-a", "legacy-node", "chat", "old payload", null, "submitted", new Date().toISOString())
    raw.close()

    const store = new Store(dbPath)
    try {
      assert.ok(hasColumn("messages", "seq"), "迁移应补 seq 列")
      assert.ok(hasColumn("messages", "acked"), "迁移应补 acked 列")
    } finally {
      store.close()
    }
    // 第二次 new Store 仍不抛错
    assert.doesNotThrow(() => {
      const s2 = new Store(dbPath)
      s2.close()
    }, "二次迁移幂等")
  })

  it("迁移后老消息仍可被 getInbox 读到（seq 回填非空）", () => {
    const store = new Store(dbPath)
    try {
      const inbox = store.getInbox("legacy-node", { since: 0 })
      const found = inbox.find(m => m.id === "legacy-msg")
      assert.ok(found, "老消息迁移后应仍可读到")
      // readonly 直查 seq 非 NULL
      const db = new Database(dbPath, { readonly: true })
      const row = db.prepare("SELECT seq FROM messages WHERE id = ?").get("legacy-msg") as any
      db.close()
      assert.ok(row.seq != null, "老行 seq 应被回填非空（否则 WHERE seq>since 永久漏掉）")
    } finally {
      store.close()
    }
  })
})

describe("Store — Blackboard (KV)", () => {
  let store: Store
  let dbPath: string

  before(() => {
    dbPath = tmpDb()
    store = new Store(dbPath)
  })

  after(() => {
    store.close()
    try { fs.unlinkSync(dbPath) } catch {}
    try { fs.unlinkSync(dbPath + "-wal") } catch {}
    try { fs.unlinkSync(dbPath + "-shm") } catch {}
  })

  it("kvSet + kvGet 能存取", () => {
    store.kvSet("status", "running", "cc-a1b2")
    const got = store.kvGet("status")
    assert.ok(got)
    assert.equal(got.value, "running")
    assert.equal(got.updatedBy, "cc-a1b2")
    assert.ok(got.updatedAt)
  })

  it("kvGet 不存在返回 undefined", () => {
    const got = store.kvGet("nonexistent-key")
    assert.equal(got, undefined)
  })

  it("kvSet 覆盖已有 key", () => {
    store.kvSet("status", "running", "cc-a1b2")
    store.kvSet("status", "stopped", "cc-c3d4")
    const got = store.kvGet("status")
    assert.ok(got)
    assert.equal(got.value, "stopped")
    assert.equal(got.updatedBy, "cc-c3d4")
  })

  // ===== 补充：KV 覆盖写入验证 value 和 updatedBy 都更新 =====
  it("KV 覆盖写入：PUT 同一 key 两次，验证 value 和 updatedBy 都更新", () => {
    store.kvSet("overwrite-test", "val1", "writer-1")
    store.kvSet("overwrite-test", "val2", "writer-2")
    const got = store.kvGet("overwrite-test")
    assert.ok(got)
    assert.equal(got.value, "val2")
    assert.equal(got.updatedBy, "writer-2")
  })

  it("kvList 返回所有 key 按字母排序", () => {
    store.kvSet("alpha", "1", "cc-a1b2")
    store.kvSet("beta", "2", "cc-a1b2")
    store.kvSet("gamma", "3", "cc-a1b2")
    const list = store.kvList()
    const keys = list.map(kv => kv.key)
    assert.ok(keys.indexOf("alpha") < keys.indexOf("beta"))
    assert.ok(keys.indexOf("beta") < keys.indexOf("gamma"))
  })

  it("kvDel 删除 key", () => {
    store.kvSet("to-delete", "tmp", "cc-a1b2")
    store.kvDel("to-delete")
    const got = store.kvGet("to-delete")
    assert.equal(got, undefined)
  })

  it("kvDel 不存在的 key 不报错", () => {
    assert.doesNotThrow(() => store.kvDel("no-such-key"))
  })
})

// ===== 方案 B PR1：priority 列 + 幂等落库 =====
describe("Store — priority 列（PR1）", () => {
  let store: Store
  let dbPath: string

  before(() => {
    dbPath = tmpDb()
    store = new Store(dbPath)
  })
  after(() => {
    store.close()
    try { fs.unlinkSync(dbPath) } catch {}
    try { fs.unlinkSync(dbPath + "-wal") } catch {}
    try { fs.unlinkSync(dbPath + "-shm") } catch {}
  })

  it("saveMessage 带 priority → getInbox 返回该 priority", () => {
    const msg = makeMsg({ to: "node-prio-1" })
    store.saveMessage(msg, "submitted", "urgent")
    const inbox = store.getInbox("node-prio-1")
    assert.equal(inbox.length, 1)
    assert.equal(inbox[0].priority, "urgent")
  })

  it("saveMessage 缺省 priority → getInbox 返回 normal", () => {
    const msg = makeMsg({ to: "node-prio-2" })
    store.saveMessage(msg)
    const inbox = store.getInbox("node-prio-2")
    assert.equal(inbox[0].priority, "normal")
  })

  it("旧行 priority 为 NULL → COALESCE 回退 normal（旧库兼容）", () => {
    // 直接写一行 priority=NULL 模拟老库数据
    const raw = new Database(dbPath)
    const seq = ((raw.prepare("SELECT COALESCE(MAX(seq),0) AS m FROM messages").get() as any).m as number) + 1
    raw.prepare(`INSERT INTO messages (id, "from", "to", type, payload, status, created_at, seq, acked)
                 VALUES (?, ?, ?, ?, ?, 'submitted', ?, ?, 0)`)
      .run("msg-legacy-null", "macbook:cc-x", "node-prio-3", "chat", "legacy", new Date().toISOString(), seq)
    raw.close()
    const inbox = store.getInbox("node-prio-3")
    assert.equal(inbox.length, 1)
    assert.equal(inbox[0].priority, "normal", "旧 NULL 行应 COALESCE 到 normal")
  })
})

describe("Store — saveMessageIfAbsent 幂等落库（PR1 downlink）", () => {
  let store: Store
  let dbPath: string

  before(() => {
    dbPath = tmpDb()
    store = new Store(dbPath)
  })
  after(() => {
    store.close()
    try { fs.unlinkSync(dbPath) } catch {}
    try { fs.unlinkSync(dbPath + "-wal") } catch {}
    try { fs.unlinkSync(dbPath + "-shm") } catch {}
  })

  it("同一 id 落两次只产生一行（INSERT OR IGNORE），第二次返回 false", () => {
    const msg = makeMsg({ id: "msg-idem-1", to: "node-idem" })
    const first = store.saveMessageIfAbsent(msg)
    const second = store.saveMessageIfAbsent(msg)
    assert.equal(first, true, "首次应新插入")
    assert.equal(second, false, "重复 id 应被 IGNORE")
    const inbox = store.getInbox("node-idem")
    assert.equal(inbox.length, 1, "同 id 只一行")
  })

  it("已存在行不被 IGNORE 覆盖 seq（不 bump 游标）", () => {
    const msg = makeMsg({ id: "msg-idem-2", to: "node-idem2" })
    store.saveMessageIfAbsent(msg)
    const seq1 = store.getInbox("node-idem2")[0].seq
    // 中间插入其它消息推高 MAX(seq)
    store.saveMessage(makeMsg({ to: "node-other" }))
    // 再次幂等落同 id → 应被忽略，seq 不变
    store.saveMessageIfAbsent(msg)
    const seq2 = store.getInbox("node-idem2")[0].seq
    assert.equal(seq2, seq1, "重复落库不应改变已存在行的 seq")
  })
})

// ===== 云端账本 M1：meta 列 + getMessagesSinceSeq（LedgerSync 取数口）=====
describe("Store — meta 列（结构化元数据）", () => {
  let store: Store
  let dbPath: string

  before(() => {
    dbPath = tmpDb()
    store = new Store(dbPath)
  })
  after(() => {
    store.close()
    try { fs.unlinkSync(dbPath) } catch {}
    try { fs.unlinkSync(dbPath + "-wal") } catch {}
    try { fs.unlinkSync(dbPath + "-shm") } catch {}
  })

  it("saveMessage 持久化 meta（JSON），getMessagesSinceSeq 解析回对象", () => {
    const msg = makeMsg({ id: "msg-meta-1", to: "node-meta", meta: { _task: { title: "跑测试", pickReason: "explicit" } } })
    store.saveMessage(msg)
    const rows = store.getMessagesSinceSeq(0, 100).filter((r) => r.id === "msg-meta-1")
    assert.equal(rows.length, 1)
    assert.deepEqual(rows[0].meta, { _task: { title: "跑测试", pickReason: "explicit" } })
  })

  it("无 meta → 存 NULL，读回 undefined（不出现 meta:null）", () => {
    const msg = makeMsg({ id: "msg-meta-2", to: "node-meta" })
    store.saveMessage(msg)
    const raw = new Database(dbPath, { readonly: true })
    const row = raw.prepare("SELECT meta FROM messages WHERE id = ?").get("msg-meta-2") as any
    raw.close()
    assert.equal(row.meta, null, "undefined meta 应落 NULL")
    const parsed = store.getMessagesSinceSeq(0, 100).find((r) => r.id === "msg-meta-2")!
    assert.equal(parsed.meta, undefined)
  })

  it("saveMessageIfAbsent 也持久化 meta", () => {
    const msg = makeMsg({ id: "msg-meta-3", to: "node-meta", meta: { src: "downlink" } })
    store.saveMessageIfAbsent(msg)
    const row = store.getMessagesSinceSeq(0, 100).find((r) => r.id === "msg-meta-3")!
    assert.deepEqual(row.meta, { src: "downlink" })
  })

  it("meta 列坏 JSON → 读取降级为 undefined，不抛（老库/手改容错）", () => {
    const raw = new Database(dbPath)
    const seq = ((raw.prepare("SELECT COALESCE(MAX(seq),0) AS m FROM messages").get() as any).m as number) + 1
    raw.prepare(`INSERT INTO messages (id, "from", "to", type, payload, status, created_at, seq, acked, meta)
                 VALUES (?, ?, ?, ?, ?, 'submitted', ?, ?, 0, ?)`)
      .run("msg-meta-bad", "macbook:cc-x", "node-meta", "chat", "x", new Date().toISOString(), seq, "{不是JSON")
    raw.close()
    const row = store.getMessagesSinceSeq(0, 200).find((r) => r.id === "msg-meta-bad")!
    assert.ok(row, "坏 meta 行仍应被取到")
    assert.equal(row.meta, undefined)
  })
})

describe("Store — getMessagesSinceSeq（游标取数）", () => {
  let store: Store
  let dbPath: string

  before(() => {
    dbPath = tmpDb()
    store = new Store(dbPath)
  })
  after(() => {
    store.close()
    try { fs.unlinkSync(dbPath) } catch {}
    try { fs.unlinkSync(dbPath + "-wal") } catch {}
    try { fs.unlinkSync(dbPath + "-shm") } catch {}
  })

  it("跨收件人全量取（不按 to 过滤），按 seq ASC", () => {
    store.saveMessage(makeMsg({ id: "sq-1", to: "node-A" }))
    store.saveMessage(makeMsg({ id: "sq-2", to: "@ledger" }))
    store.saveMessage(makeMsg({ id: "sq-3", to: "*" }))
    const rows = store.getMessagesSinceSeq(0, 100)
    assert.deepEqual(rows.map((r) => r.id), ["sq-1", "sq-2", "sq-3"])
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i].seq > rows[i - 1].seq, "seq 必须严格升序")
    }
  })

  it("since 是开区间（seq > since），limit 截断", () => {
    const all = store.getMessagesSinceSeq(0, 100)
    const firstSeq = all[0].seq
    const after = store.getMessagesSinceSeq(firstSeq, 100)
    assert.equal(after.length, all.length - 1)
    assert.equal(after[0].id, "sq-2")
    assert.equal(store.getMessagesSinceSeq(0, 2).length, 2, "limit 生效")
  })

  it("返回行带 status / priority（旧行 NULL → normal）/ replyTo", () => {
    store.saveMessage(makeMsg({ id: "sq-4", to: "node-B", replyTo: "sq-1" }), "delivered", "urgent")
    const row = store.getMessagesSinceSeq(0, 100).find((r) => r.id === "sq-4")!
    assert.equal(row.status, "delivered")
    assert.equal(row.priority, "urgent")
    assert.equal(row.replyTo, "sq-1")
    const noReply = store.getMessagesSinceSeq(0, 100).find((r) => r.id === "sq-1")!
    assert.equal(noReply.replyTo, undefined, "无 replyTo 应是 undefined 不是 null")
    assert.equal(noReply.priority, "normal")
  })

  it("游标追平后返回空数组", () => {
    const all = store.getMessagesSinceSeq(0, 1000)
    const maxSeq = all[all.length - 1].seq
    assert.deepEqual(store.getMessagesSinceSeq(maxSeq, 1000), [])
  })
})

// ===== getInbox 带 meta（pull worker 该看到派单元数据）=====
describe("Store — getInbox 返回 meta", () => {
  let store: Store
  let dbPath: string

  before(() => {
    dbPath = tmpDb()
    store = new Store(dbPath)
  })
  after(() => {
    store.close()
    try { fs.unlinkSync(dbPath) } catch {}
    try { fs.unlinkSync(dbPath + "-wal") } catch {}
    try { fs.unlinkSync(dbPath + "-shm") } catch {}
  })

  it("有 meta 的消息 → getInbox 行带解析后的 meta 对象", () => {
    store.saveMessage(makeMsg({ id: "ib-meta-1", to: "node-ib", type: "task", meta: { _task: { title: "T", pickReason: "explicit" } } }))
    const row = store.getInbox("node-ib").find((m) => m.id === "ib-meta-1")!
    assert.equal(row.type, "task")
    assert.deepEqual(row.meta, { _task: { title: "T", pickReason: "explicit" } })
  })

  it("无 meta → undefined（不出现 meta:null）；坏 JSON 也不抛", () => {
    store.saveMessage(makeMsg({ id: "ib-meta-2", to: "node-ib" }))
    assert.equal(store.getInbox("node-ib").find((m) => m.id === "ib-meta-2")!.meta, undefined)

    const raw = new Database(dbPath)
    const seq = ((raw.prepare("SELECT COALESCE(MAX(seq),0) AS m FROM messages").get() as any).m as number) + 1
    raw.prepare(`INSERT INTO messages (id, "from", "to", type, payload, status, created_at, seq, acked, meta)
                 VALUES (?, ?, ?, ?, ?, 'submitted', ?, ?, 0, ?)`)
      .run("ib-meta-bad", "macbook:cc-x", "node-ib", "chat", "x", new Date().toISOString(), seq, "{坏")
    raw.close()
    const bad = store.getInbox("node-ib").find((m) => m.id === "ib-meta-bad")!
    assert.ok(bad)
    assert.equal(bad.meta, undefined)
  })
})

// ===========================================================================
// countDirectBacklog — sweeper 的对账判据（G2）
//
// 语义故意窄：**只数直发**（to == nodeId），不含广播。
// 理由（架构定稿 G3 定案）：广播不触发 wake——把全网睡眠席位一起摇醒就是唤醒风暴，
// 而广播语义本就是尽力而为。若这里把 to='*' 也算进 backlog，sweeper 会替广播
// 补出 wake 来，等于从后门推翻 G3。
// ===========================================================================
describe("Store — countDirectBacklog（sweeper 对账）", () => {
  let store: Store
  let dbPath: string

  before(() => {
    dbPath = tmpDb()
    store = new Store(dbPath)
  })
  after(() => {
    store.close()
    for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(dbPath + ext) } catch {} }
  })

  it("数 seq > sinceSeq 的直发消息", () => {
    store.saveMessage(makeMsg({ to: "macbook:cc-bl" }))
    store.saveMessage(makeMsg({ to: "macbook:cc-bl" }))
    store.saveMessage(makeMsg({ to: "macbook:cc-bl" }))
    assert.equal(store.countDirectBacklog("macbook:cc-bl", 0), 3)
  })

  it("游标之后才算积压：ack 到底 → backlog 归 0", () => {
    const rows = store.getInbox("macbook:cc-bl")
    const maxSeq = rows.reduce((m, r) => Math.max(m, r.seq ?? 0), 0)
    assert.equal(store.countDirectBacklog("macbook:cc-bl", maxSeq), 0)
    // 只 ack 一半
    assert.equal(store.countDirectBacklog("macbook:cc-bl", maxSeq - 1), 1)
  })

  it("广播（to='*'）不计入 backlog —— G3 定案不许从后门复活", () => {
    const before = store.countDirectBacklog("macbook:cc-bcast", 0)
    store.saveMessage(makeMsg({ to: "*", type: "broadcast" }))
    store.saveMessage(makeMsg({ to: "*", type: "broadcast" }))
    assert.equal(store.countDirectBacklog("macbook:cc-bcast", 0), before, "广播行不许让 sweeper 摇人")
    // 对照：getInbox 是看得见广播的（收件箱语义与 backlog 语义故意不同）
    assert.ok(store.getInbox("macbook:cc-bcast").length >= 2, "前提：广播确实对该节点可见")
  })

  it("别家的直发消息不计入（收件人过滤严格相等）", () => {
    store.saveMessage(makeMsg({ to: "macbook:cc-other" }))
    assert.equal(store.countDirectBacklog("macbook:cc-nobody", 0), 0)
  })

  it("从没收过消息的节点 → 0（不抛）", () => {
    assert.equal(store.countDirectBacklog("macbook:cc-ghost", 0), 0)
  })
})
