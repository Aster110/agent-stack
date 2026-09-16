/**
 * ack 游标上界钳制 — 2026-09-05/08 claude-main 静默失聪事故的回归测试
 *
 * 事故复盘（一句话）：
 *   门铃 state 文件里的 `since` 是**门铃 phase 的起始 epoch**，/api/sync 的 `since`
 *   是**seq 游标**——两个东西**重名但不同物**。一条「试试 since>head 会怎样」的诊断
 *   curl 把 17 亿的 epoch 喂进了 seq 游标；而游标推进是「取 max 防倒退」的，
 *   于是坏状态被**永久焊死**：`mesh send` 一路返回 accepted、消息照常入库，
 *   但 `WHERE seq > 1788622349` 永远为空，席位聋了 5 天。
 *
 * 不变量：`last_ack_seq <= MAX(seq)`。超出 head 是**物理上不可能**的状态——
 * seq 由本机 MAX(seq)+1 赋值，消息必须先拿到 seq 才可能被投递。
 *
 * 本文件的断言分三类：
 *   1. 闸本身（store.ack 写时钳 / /api/sync 入口钳）
 *   2. **对得上事故的端到端断言**：游标被投毒后，节点还收不收得到消息
 *      ——只测「数字被钳住了」不算数，要测「人还听得见」。
 *   3. 存量脏行必须被自检**点名**（只报不改）：自动钳到 head 会把焊死期间积压的
 *      消息静默丢光，是拿一个静默失败换另一个静默失败。
 * 另含一条反向护栏：钳制**不许**削掉原有的「防倒退」。
 */
import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { Store } from "./store.js"
import { createServer } from "./server.js"
import { MeshEventBus } from "./events.js"
import type { MeshMessage } from "@cc-mesh/protocol"
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import Database from "better-sqlite3"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

/** 事故里真实写进游标的那个值（2026-09-05 08:32:29 PDT 的 epoch 秒）。 */
const POISON_EPOCH = 1788622349

function tmpDb(): string {
  return path.join(os.tmpdir(), `mesh-clamp-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
}
function cleanup(dbPath: string): void {
  for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(dbPath + ext) } catch {} }
}

let msgCounter = 0
function makeMsg(to: string, text: string): MeshMessage {
  return {
    id: `clamp-${Date.now()}-${++msgCounter}`,
    from: "macbook:cc-sender",
    to,
    type: "chat",
    payload: text,
    createdAt: new Date().toISOString(),
  } as MeshMessage
}

// ===========================================================================
// Store 层：写时钳 + 读时钳
// ===========================================================================
describe("Store.ack — 游标上界钳制（不可能值不得落库）", () => {
  let dbPath: string
  let store: Store

  before(() => { dbPath = tmpDb(); store = new Store(dbPath) })
  after(() => { store.close(); cleanup(dbPath) })

  it("epoch 级 upToSeq 不得把游标推过 head", () => {
    const node = "macbook:cc-poison"
    store.saveMessage(makeMsg(node, "p1"))
    store.saveMessage(makeMsg(node, "p2"))
    const head = store.headSeq()

    store.ack(node, POISON_EPOCH)

    const cursor = store.getAckCursor(node)
    assert.ok(
      cursor <= head,
      `游标 ${cursor} 必须 <= head ${head}——超出 head 是物理上不可能的状态`,
    )
    assert.notEqual(cursor, POISON_EPOCH, "epoch 绝不许原样落进 seq 游标")
  })

  it("【事故断言】游标被投毒后，节点仍收得到后续消息（不许静默失聪）", () => {
    const node = "macbook:cc-deaf"
    store.saveMessage(makeMsg(node, "old"))
    store.ack(node, POISON_EPOCH) // 投毒

    // 投毒之后来的新消息——事故里这一条永远取不到
    store.saveMessage(makeMsg(node, "after-poison"))

    const got = store.getInbox(node, { since: store.getAckCursor(node) })
      .filter((m) => m.to === node)
    assert.equal(got.length, 1, "投毒后仍必须能取到新消息，取不到就是失聪")
    assert.equal(got[0]!.payload, "after-poison")
  })

  it("存量脏值必须被自检点名（只报不改，不许偷偷钳掉）", () => {
    const node = "macbook:cc-legacy"
    store.saveMessage(makeMsg(node, "legacy-pending"))

    // 绕过写闸，直接把事故当时的脏行塞进库——模拟「加闸之前就已经坏了的老库」
    const raw = new Database(dbPath)
    raw.prepare(`
      INSERT INTO ack_cursors (node_id, last_ack_seq) VALUES (?, ?)
      ON CONFLICT(node_id) DO UPDATE SET last_ack_seq = excluded.last_ack_seq
    `).run(node, POISON_EPOCH)
    const stored = (raw.prepare("SELECT last_ack_seq AS v FROM ack_cursors WHERE node_id = ?").get(node) as any).v
    raw.close()
    assert.equal(stored, POISON_EPOCH, "前提：库里确实是脏值（否则这条测试什么都没测）")

    const flagged = store.findImpossibleCursors().find((c) => c.nodeId === node)
    assert.ok(flagged, "不可能游标必须被自检点名——事故的要害就是它全程一声不吭")
    assert.equal(flagged!.lastAckSeq, POISON_EPOCH)
    assert.ok(flagged!.headSeq < POISON_EPOCH)

    // 故意不自愈：钳到 head 会把焊死期间积压的消息当作「已收」静默丢掉
    // （事故里就是 seq 6620/6621 那两条）。续点必须由人判断。
    assert.equal(store.getAckCursor(node), POISON_EPOCH, "读时不许偷偷改写生效游标")
  })

  it("写闸生效后，ack() 再也造不出不可能游标", () => {
    const node = "macbook:cc-noimposs"
    store.saveMessage(makeMsg(node, "n1"))
    store.ack(node, POISON_EPOCH)
    store.ack(node, Number.MAX_SAFE_INTEGER)
    assert.equal(
      store.findImpossibleCursors().find((c) => c.nodeId === node),
      undefined,
      "写闸之后不该再有新的不可能游标产生",
    )
  })

  it("反向护栏：钳制不许削掉「防倒退」——小值仍推不动游标", () => {
    const node = "macbook:cc-mono"
    store.saveMessage(makeMsg(node, "m1"))
    store.saveMessage(makeMsg(node, "m2"))
    store.saveMessage(makeMsg(node, "m3"))
    const inbox = store.getInbox(node).filter((m) => m.to === node)
    const low = (inbox[0] as any).seq as number
    const high = (inbox[inbox.length - 1] as any).seq as number

    store.ack(node, high)
    store.ack(node, low) // 乱序/重放的倒退 ack
    assert.equal(store.getAckCursor(node), high, "游标仍取 max，倒退 ack 不把它拉回")
  })

  it("合法 ack（upToSeq <= head）不受钳制影响，仍精确销账", () => {
    const node = "macbook:cc-legit"
    store.saveMessage(makeMsg(node, "a"))
    store.saveMessage(makeMsg(node, "b"))
    const inbox = store.getInbox(node).filter((m) => m.to === node)
    const mid = (inbox[0] as any).seq as number

    store.ack(node, mid)
    assert.equal(store.getAckCursor(node), mid, "合法值应原样生效，闸是 no-op")
    const rest = store.getInbox(node, { since: store.getAckCursor(node) })
      .filter((m) => m.to === node)
    assert.equal(rest.length, 1, "只剩 mid 之后的一条")
  })
})

// ===========================================================================
// 端到端：复现事故那条诊断 curl，断言链路没被它打聋
// ===========================================================================
describe("GET /api/sync — 荒谬 since 不得毒死游标（事故端到端回归）", () => {
  let dbPath: string
  let server: Server
  let base: string

  before(async () => {
    dbPath = tmpDb()
    const app = createServer({
      dbPath,
      deviceId: "macbook",
      events: new MeshEventBus(),
    } as any)
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s))
    })
    base = `http://localhost:${(server.address() as AddressInfo).port}`
  })
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()))
    cleanup(dbPath)
  })

  const post = async (p: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${p}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
    return { status: res.status, data: await res.json().catch(() => null) }
  }
  const get = async (p: string) => {
    const res = await fetch(`${base}${p}`)
    return { status: res.status, data: await res.json().catch(() => null) }
  }

  it("【事故复现】since=<epoch> 的诊断 GET 之后，节点仍能收到新消息", async () => {
    const reg = await post("/api/register", {
      shortId: "cc-incident", pid: 1, role: "worker",
      description: "incident regression", deliveryMode: "sse-pull",
    })
    const nodeId = reg.data.data.nodeId as string

    // 事故原样：一条看似只读的 GET，实则 since>游标即写游标。
    const probe = await get(`/api/sync?nodeId=${encodeURIComponent(nodeId)}&since=${POISON_EPOCH}&timeout=0`)
    assert.equal(probe.status, 200)

    // 投毒之后发一条——事故里这条永远送不到。
    await post("/api/send", { to: nodeId, message: "post-poison-payload" }, { "X-Mesh-Node": "macbook:cc-probe" })

    const r = await get(`/api/sync?nodeId=${encodeURIComponent(nodeId)}&timeout=0`)
    assert.equal(r.status, 200)
    assert.equal(
      r.data.data.messages.length, 1,
      "投毒后发的消息必须仍能取到——取不到就是事故复发（send 返回 accepted 但永远没人收）",
    )
    assert.equal(r.data.data.messages[0].payload, "post-poison-payload")

    // nextSince 也不许把 epoch 传染回客户端（drain 循环会拿它当下一轮 since）。
    assert.ok(
      r.data.data.nextSince < POISON_EPOCH,
      `nextSince ${r.data.data.nextSince} 不许是 epoch 量级——否则客户端下一轮把毒又喂回来`,
    )
  })

  it("POST /api/ack 报的 cursor 不许超过 head", async () => {
    const reg = await post("/api/register", {
      shortId: "cc-ackcap", pid: 1, role: "worker",
      description: "ack cap", deliveryMode: "sse-pull",
    })
    const nodeId = reg.data.data.nodeId as string
    await post("/api/send", { to: nodeId, message: "x" }, { "X-Mesh-Node": "macbook:cc-probe2" })

    const r = await post("/api/ack", { nodeId, upTo: POISON_EPOCH })
    assert.equal(r.status, 200)
    assert.ok(
      r.data.data.cursor < POISON_EPOCH,
      `/api/ack 回报的 cursor ${r.data.data.cursor} 不许是 epoch 量级`,
    )
  })
})
