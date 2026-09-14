/**
 * Hub × 账本挂载测试（真实 WS + 真实 SQLite 临时库 + 真实 HTTP）。
 *
 * M0 验收线：
 * - ④ 老 relay 零回归：不传 opts.ledger → Hub 一点不变（这是既有 29 个测试的前提）
 * - uplink {type:"ledger"} → ledger_ack(upToSeq) + 消息入云端账本
 * - B8 presence：register → relay_online，断开 → relay_offline
 * - ③ 读 API 无/错 token 401
 * - 孤儿扫描用 Hub 内存 relays 判在线
 * - close() 收干净（端口释放、timer 清、库句柄关）
 */
import { describe, it, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import WebSocket from "ws"
import { createHub, type HubInstance, type HubOptions } from "./hub.js"
import { ledgerFromEnv, forwarderFromEnv } from "./index.js"
import type { UplinkMessage, DownlinkMessage, MeshMessage, RelayRegistration, LedgerUplinkEvent } from "@cc-mesh/protocol"

const TOKEN = "hub-token-for-ledger"
const tmpDirs: string[] = []
const hubs: HubInstance[] = []

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-ledger-"))
  tmpDirs.push(dir)
  return path.join(dir, "ledger.db")
}

function mkReg(relayId: string, deviceId: string, nodeIds: string[]): RelayRegistration {
  return {
    relayId,
    deviceId,
    nodes: nodeIds.map((id) => ({ nodeId: id, deviceId, shortId: id.split(":")[1] ?? id, role: "worker" as const, description: "", capabilities: [] })),
    connectedAt: new Date().toISOString(),
  }
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.once("open", () => resolve(ws))
    ws.once("error", reject)
  })
}

function collect(ws: WebSocket): DownlinkMessage[] {
  const buf: DownlinkMessage[] = []
  ws.on("message", (d) => buf.push(JSON.parse(String(d))))
  return buf
}

function send(ws: WebSocket, msg: UplinkMessage): void { ws.send(JSON.stringify(msg)) }

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时")
    await new Promise((r) => setTimeout(r, 10))
  }
}

function mkMsg(over: Partial<MeshMessage> & Pick<MeshMessage, "id">): MeshMessage {
  return { from: "mini:cc-w1", to: "macbook:cc-main", type: "chat", payload: "hi", createdAt: "2026-08-27T10:00:00+08:00", ...over } as MeshMessage
}

function ev(msg: MeshMessage, srcSeq: number): LedgerUplinkEvent {
  return { kind: "message", msg, status: "delivered", priority: "normal", srcSeq }
}

async function startHub(ledger?: HubOptions["ledger"]): Promise<HubInstance> {
  const hub = await createHub({ port: 0, ledger })
  hubs.push(hub)
  return hub
}

after(async () => {
  for (const h of hubs) { try { await h.close() } catch { /* noop */ } }
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
})

describe("不传 ledger = 现行为（M0 验收 ④ 零回归）", () => {
  it("hub.ledger 为 null，不建库不开口", async () => {
    const hub = await startHub()
    assert.equal(hub.ledger, null)
  })

  it("register / message 路由照常", async () => {
    const hub = await startHub()
    const a = await connect(`ws://localhost:${hub.port}`)
    const buf = collect(a)
    send(a, { type: "register", relay: mkReg("r-a", "mini", ["mini:cc-w1"]) })
    await waitFor(() => buf.some((m) => m.type === "devices"))
    send(a, { type: "message", msg: mkMsg({ id: "m1", to: "mini:cc-w1" }) })
    await waitFor(() => buf.some((m) => m.type === "delivered"))
    a.close()
  })

  it("老 relay 发 ledger 帧（不该发但兼容）→ 静默丢弃，不崩不 ack", async () => {
    const hub = await startHub()
    const a = await connect(`ws://localhost:${hub.port}`)
    const buf = collect(a)
    send(a, { type: "register", relay: mkReg("r-a", "mini", ["mini:cc-w1"]) })
    await waitFor(() => buf.some((m) => m.type === "devices"))
    send(a, { type: "ledger", relayId: "r-a", events: [ev(mkMsg({ id: "m1" }), 1)] })
    send(a, { type: "ping" })
    await waitFor(() => buf.some((m) => m.type === "pong"))
    assert.equal(buf.filter((m) => m.type === "ledger_ack").length, 0)
    a.close()
  })
})

describe("账本开着时，老 relay（不发 ledger 帧）零回归 —— M0 验收 ④", () => {
  it("register / 定向路由 / 广播 / ping 全部照旧，且 Hub 自己不替 relay 记账", async () => {
    const hub = await startHub({ dbPath: tmpDb(), token: TOKEN, httpPort: 0, quiet: true })
    const a = await connect(`ws://localhost:${hub.port}`)
    const b = await connect(`ws://localhost:${hub.port}`)
    const bufA = collect(a); const bufB = collect(b)
    send(a, { type: "register", relay: mkReg("r-a", "mini", ["mini:cc-w1"]) })
    send(b, { type: "register", relay: mkReg("r-b", "macbook", ["macbook:cc-main"]) })
    await waitFor(() => bufA.some((m) => m.type === "devices") && bufB.some((m) => m.type === "devices"))

    // 定向：a → macbook:cc-main，b 收到消息、a 收到 delivered
    send(a, { type: "message", msg: mkMsg({ id: "m1", from: "mini:cc-w1", to: "macbook:cc-main" }) })
    await waitFor(() => bufB.some((m) => m.type === "message") && bufA.some((m) => m.type === "delivered"))

    // 广播：a → *，只发给别人
    send(a, { type: "message", msg: mkMsg({ id: "m2", to: "*" }) })
    await waitFor(() => bufB.filter((m) => m.type === "message").length === 2)

    send(a, { type: "ping" })
    await waitFor(() => bufA.some((m) => m.type === "pong"))
    assert.equal(hub.getNodeLocation("macbook:cc-main"), "r-b")

    // 关键：M0 的 Hub **不替 relay 记账**——路由过的消息不自动进账本，
    // 只有 relay 主动上行的 ledger 事件才入库（M1 才开这条流）。
    // 否则 M1 上线时同一条消息会被 Hub 和 relay 各记一次，来源和 srcSeq 全乱。
    assert.equal(hub.ledger!.store.listMessages({}).length, 0)
    a.close(); b.close()
  })
})

describe("uplink ledger → 入账 + ack", () => {
  it("ack 的 upToSeq = 批内 srcSeq 最大值，消息真落库", async () => {
    const hub = await startHub({ dbPath: tmpDb(), token: TOKEN, httpPort: 0, quiet: true })
    const a = await connect(`ws://localhost:${hub.port}`)
    const buf = collect(a)
    send(a, { type: "register", relay: mkReg("r-a", "mini", ["mini:cc-w1"]) })
    await waitFor(() => buf.some((m) => m.type === "devices"))

    send(a, {
      type: "ledger",
      relayId: "r-a",
      events: [ev(mkMsg({ id: "m1" }), 3), ev(mkMsg({ id: "m2" }), 9), ev(mkMsg({ id: "m3" }), 5)],
    })
    await waitFor(() => buf.some((m) => m.type === "ledger_ack"))
    const ack = buf.find((m) => m.type === "ledger_ack") as { type: "ledger_ack"; upToSeq: number }
    assert.equal(ack.upToSeq, 9)

    const rows = hub.ledger!.store.listMessages({})
    assert.deepEqual(rows.map((r) => r.id).sort(), ["m1", "m2", "m3"])
    assert.equal(rows[0].srcRelay, "r-a")
    a.close()
  })

  it("重复上报同一批 → 只一行；ack 照常回（幂等 + 游标可续）", async () => {
    const hub = await startHub({ dbPath: tmpDb(), token: TOKEN, httpPort: 0, quiet: true })
    const a = await connect(`ws://localhost:${hub.port}`)
    const buf = collect(a)
    send(a, { type: "register", relay: mkReg("r-a", "mini", ["mini:cc-w1"]) })
    await waitFor(() => buf.some((m) => m.type === "devices"))

    const batch: UplinkMessage = { type: "ledger", relayId: "r-a", events: [ev(mkMsg({ id: "dup" }), 7)] }
    send(a, batch)
    send(a, batch)
    await waitFor(() => buf.filter((m) => m.type === "ledger_ack").length === 2)
    assert.equal(hub.ledger!.store.listMessages({}).length, 1)
    for (const m of buf.filter((m) => m.type === "ledger_ack")) {
      assert.equal((m as { upToSeq: number }).upToSeq, 7)
    }
    a.close()
  })

  it("未 register 的连接发 ledger → 不入账、不 ack（写账必须过 auth）", async () => {
    const hub = await startHub({ dbPath: tmpDb(), token: TOKEN, httpPort: 0, quiet: true })
    const a = await connect(`ws://localhost:${hub.port}`)
    const buf = collect(a)
    send(a, { type: "ledger", relayId: "spoof", events: [ev(mkMsg({ id: "evil" }), 1)] })
    send(a, { type: "ping" })
    await waitFor(() => buf.some((m) => m.type === "pong"))
    assert.equal(buf.filter((m) => m.type === "ledger_ack").length, 0)
    assert.equal(hub.ledger!.store.listMessages({}).length, 0)
    a.close()
  })

  it("task/result 事件走投影，云端 tasks 关单", async () => {
    const hub = await startHub({ dbPath: tmpDb(), token: TOKEN, httpPort: 0, quiet: true })
    const a = await connect(`ws://localhost:${hub.port}`)
    const buf = collect(a)
    send(a, { type: "register", relay: mkReg("r-a", "mini", ["mini:cc-w1"]) })
    await waitFor(() => buf.some((m) => m.type === "devices"))

    const task = mkMsg({ id: "t1", from: "macbook:cc-main", to: "mini:cc-w1", type: "task", payload: "干活", meta: { _task: { title: "干活", project: "P62", pickReason: "explicit" } } })
    const result = mkMsg({ id: "r1", from: "mini:cc-w1", to: "macbook:cc-main", type: "result", payload: "完事", replyTo: "t1", createdAt: "2026-08-27T10:30:00+08:00" })
    send(a, { type: "ledger", relayId: "r-a", events: [ev(task, 1), ev(result, 2)] })
    await waitFor(() => buf.some((m) => m.type === "ledger_ack"))

    const t = hub.ledger!.store.getTask("t1")!
    assert.equal(t.status, "replied")
    assert.equal(t.project, "P62")
    a.close()
  })
})

describe("B8 presence 事件", () => {
  it("register → relay_online；断开 → relay_offline", async () => {
    const hub = await startHub({ dbPath: tmpDb(), token: TOKEN, httpPort: 0, quiet: true })
    const a = await connect(`ws://localhost:${hub.port}`)
    const buf = collect(a)
    send(a, { type: "register", relay: mkReg("r-a", "mini", ["mini:cc-w1", "mini:cc-w2"]) })
    await waitFor(() => buf.some((m) => m.type === "devices"))

    const online = hub.ledger!.store.listEvents({ kind: "relay_online" })
    assert.equal(online.length, 1)
    assert.equal(online[0].device, "mini")
    assert.deepEqual((online[0].detail as Record<string, unknown>).nodes, 2)

    a.close()
    await waitFor(() => hub.ledger!.store.listEvents({ kind: "relay_offline" }).length === 1)
    assert.equal(hub.ledger!.store.listEvents({ kind: "relay_offline" })[0].device, "mini")
  })
})

describe("读 API 挂在 Hub 上", () => {
  it("无 token 401 / 错 token 401 / 对 token 200 且查得到刚入的账", async () => {
    const hub = await startHub({ dbPath: tmpDb(), token: TOKEN, httpPort: 0, quiet: true })
    assert.ok(hub.ledger!.httpPort && hub.ledger!.httpPort > 0)
    const base = `http://127.0.0.1:${hub.ledger!.httpPort}`

    const a = await connect(`ws://localhost:${hub.port}`)
    const buf = collect(a)
    send(a, { type: "register", relay: mkReg("r-a", "mini", ["mini:cc-w1"]) })
    await waitFor(() => buf.some((m) => m.type === "devices"))
    send(a, { type: "ledger", relayId: "r-a", events: [ev(mkMsg({ id: "m1", payload: "云端可见" }), 1)] })
    await waitFor(() => buf.some((m) => m.type === "ledger_ack"))

    assert.equal((await fetch(`${base}/api/ledger/messages`)).status, 401)
    assert.equal((await fetch(`${base}/api/ledger/messages`, { headers: { Authorization: "Bearer nope" } })).status, 401)
    const ok = await fetch(`${base}/api/ledger/messages`, { headers: { Authorization: `Bearer ${TOKEN}` } })
    assert.equal(ok.status, 200)
    const body: any = await ok.json()
    assert.equal(body.data[0].payload, "云端可见")

    const ag = await (await fetch(`${base}/api/ledger/agents`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json() as any
    assert.deepEqual(ag.data.devices.map((d: any) => d.deviceId), ["mini"])   // presence 真的接进去了
    a.close()
  })

  it("没有 HUB_TOKEN → 读 API 不启动，但账照记（公网不开裸口）", async () => {
    const hub = await startHub({ dbPath: tmpDb(), token: "", httpPort: 0, quiet: true })
    assert.equal(hub.ledger!.httpPort, null)
    const a = await connect(`ws://localhost:${hub.port}`)
    const buf = collect(a)
    send(a, { type: "register", relay: mkReg("r-a", "mini", ["mini:cc-w1"]) })
    await waitFor(() => buf.some((m) => m.type === "devices"))
    send(a, { type: "ledger", relayId: "r-a", events: [ev(mkMsg({ id: "m1" }), 1)] })
    await waitFor(() => buf.some((m) => m.type === "ledger_ack"))
    assert.equal(hub.ledger!.store.listMessages({}).length, 1)
    a.close()
  })
})

describe("孤儿扫描接 Hub 内存 presence", () => {
  it("目标设备连着 → 不标；断开后超时 → orphaned + events", async () => {
    const hub = await startHub({ dbPath: tmpDb(), token: TOKEN, httpPort: 0, orphanTimeoutMs: 1, quiet: true })
    const a = await connect(`ws://localhost:${hub.port}`)
    const buf = collect(a)
    send(a, { type: "register", relay: mkReg("r-a", "mini", ["mini:cc-w1"]) })
    await waitFor(() => buf.some((m) => m.type === "devices"))

    const task = mkMsg({ id: "t1", from: "macbook:cc-main", to: "mini:cc-w1", type: "task", payload: "长活" })
    send(a, { type: "ledger", relayId: "r-a", events: [ev(task, 1)] })
    await waitFor(() => buf.some((m) => m.type === "ledger_ack"))

    assert.deepEqual(hub.ledger!.sweepNow(Date.now()).orphaned, [])   // mini 还连着
    assert.equal(hub.ledger!.store.getTask("t1")!.status, "dispatched")

    a.close()
    await waitFor(() => hub.ledger!.store.listEvents({ kind: "relay_offline" }).length === 1)
    assert.deepEqual(hub.ledger!.sweepNow(Date.now()).orphaned, ["t1"])
    assert.equal(hub.ledger!.store.getTask("t1")!.status, "orphaned")
    assert.equal(hub.ledger!.store.listEvents({ kind: "orphan_marked" }).length, 1)
  })
})

describe("close() 收干净", () => {
  it("关 Hub 后 :ledgerHttpPort 不再监听", async () => {
    const dbPath = tmpDb()
    const hub = await createHub({ port: 0, ledger: { dbPath, token: TOKEN, httpPort: 0, quiet: true } })
    const httpPort = hub.ledger!.httpPort!
    assert.equal((await fetch(`http://127.0.0.1:${httpPort}/api/ledger/accounts`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 200)
    await hub.close()
    await assert.rejects(() => fetch(`http://127.0.0.1:${httpPort}/api/ledger/accounts`, { headers: { Authorization: `Bearer ${TOKEN}` } }))
  })

  it("落盘的库在重开 Hub 后还在（迁移幂等 + 数据留存）", async () => {
    const dbPath = tmpDb()
    const h1 = await createHub({ port: 0, ledger: { dbPath, token: TOKEN, httpPort: 0, quiet: true } })
    h1.ledger!.store.upsertSeat({ seatId: "mini/w1", device: "mini", agentKind: "codex", active: true })
    await h1.close()

    const h2 = await createHub({ port: 0, ledger: { dbPath, token: TOKEN, httpPort: 0, quiet: true } })
    assert.deepEqual(h2.ledger!.store.listSeats().map((s) => s.seatId), ["mini/w1"])
    await h2.close()
  })
})

// ===== D1 冷层转发挂载（展示面设计 §6） =====

interface FwdCall { url: string; init: any; body: any }

class MockIngest {
  calls: FwdCall[] = []
  status = 200
  throwErr: Error | null = null
  readonly impl = async (url: string, init: any) => {
    if (this.throwErr) { this.calls.push({ url, init, body: null }); throw this.throwErr }
    let body: any = null
    try { body = JSON.parse(init.body) } catch { /* noop */ }
    this.calls.push({ url, init, body })
    return { status: this.status, text: async () => JSON.stringify({ ok: true, data: { applied: {} } }) }
  }
  rows(table: string): any[] {
    for (const c of this.calls) {
      const b = (c.body?.batches ?? []).find((x: any) => x.table === table)
      if (b) return b.rows
    }
    return []
  }
  /** 最近一次带该表的请求里的行（快照表每轮全量重推，要看最新那份）。 */
  lastRows(table: string): any[] {
    for (let i = this.calls.length - 1; i >= 0; i--) {
      const b = (this.calls[i].body?.batches ?? []).find((x: any) => x.table === table)
      if (b) return b.rows
    }
    return []
  }
}

function fwdOpts(mock: MockIngest, extra: Record<string, unknown> = {}) {
  return {
    url: "https://mesh-console.test.workers.dev",
    token: "ingest-tok",
    fetchImpl: mock.impl,
    intervalMs: 10,
    debounceMs: 5,
    drainDelayMs: 5,
    ...extra,
  } as any
}

describe("D1 冷层转发挂载", () => {
  it("不配 CONSOLE_INGEST_* → mount.forwarder 为 null，账照记（零行为零回归）", async () => {
    const hub = await startHub({ dbPath: tmpDb(), token: TOKEN, httpPort: 0, quiet: true })
    assert.equal(hub.ledger!.forwarder, null)

    const a = await connect(`ws://localhost:${hub.port}`)
    const buf = collect(a)
    send(a, { type: "register", relay: mkReg("r-a", "mini", ["mini:cc-w1"]) })
    await waitFor(() => buf.some((m) => m.type === "devices"))
    send(a, { type: "ledger", relayId: "r-a", events: [ev(mkMsg({ id: "nf1" }), 1)] })
    await waitFor(() => buf.some((m) => m.type === "ledger_ack"))
    assert.equal(hub.ledger!.store.listMessages({}).length, 1)
    assert.equal(hub.ledger!.store.getForwardWatermark("ledger_messages"), 0, "没开转发就不该有游标")
    a.close()
  })

  it("只配一半（有 URL 没 token）→ 不启动转发", async () => {
    const hub = await startHub({
      dbPath: tmpDb(), token: TOKEN, httpPort: 0, quiet: true,
      forwarder: { url: "https://x.test", token: "" } as any,
    })
    assert.equal(hub.ledger!.forwarder, null)
  })

  it("配齐 → 入账的行被异步推到 /ingest（原样 snake_case 行 + Bearer）", async () => {
    const mock = new MockIngest()
    const hub = await startHub({ dbPath: tmpDb(), token: TOKEN, httpPort: 0, quiet: true, forwarder: fwdOpts(mock) })
    assert.ok(hub.ledger!.forwarder)

    const a = await connect(`ws://localhost:${hub.port}`)
    const buf = collect(a)
    send(a, { type: "register", relay: mkReg("r-a", "mini", ["mini:cc-w1"]) })
    await waitFor(() => buf.some((m) => m.type === "devices"))
    send(a, { type: "ledger", relayId: "r-a", events: [ev(mkMsg({ id: "cold-1", payload: "进冷层" }), 1)] })
    await waitFor(() => buf.some((m) => m.type === "ledger_ack"))

    await waitFor(() => mock.calls.length > 0, 3000)
    assert.equal(mock.calls[0].url, "https://mesh-console.test.workers.dev/ingest")
    assert.equal(mock.calls[0].init.headers.Authorization, "Bearer ingest-tok")
    const row = mock.rows("ledger_messages")[0]
    assert.equal(row.id, "cold-1")
    assert.equal(row.payload, "进冷层")
    assert.equal(row.src_relay, "r-a")

    await waitFor(() => hub.ledger!.store.getForwardWatermark("ledger_messages") > 0, 3000)
    a.close()
  })

  it("派单→回执：云端拿到的 task 行状态跟着变（快照表全量同步的 Hub 级证据）", async () => {
    const mock = new MockIngest()
    const hub = await startHub({ dbPath: tmpDb(), token: TOKEN, httpPort: 0, quiet: true, forwarder: fwdOpts(mock) })
    const a = await connect(`ws://localhost:${hub.port}`)
    const buf = collect(a)
    send(a, { type: "register", relay: mkReg("r-a", "mini", ["mini:cc-w1"]) })
    await waitFor(() => buf.some((m) => m.type === "devices"))

    const task = mkMsg({
      id: "t1", from: "macbook:cc-main", to: "mini:cc-w1", type: "task", payload: "干活",
      meta: { _task: { title: "干活", project: "P62", pickReason: "explicit" } },
    })
    send(a, { type: "ledger", relayId: "r-a", events: [ev(task, 1)] })
    await waitFor(() => mock.lastRows("tasks")[0]?.status === "dispatched", 4000)

    const result = mkMsg({
      id: "r1", from: "mini:cc-w1", to: "macbook:cc-main", type: "result",
      payload: "完事", replyTo: "t1", createdAt: "2026-08-27T10:30:00+08:00",
    })
    send(a, { type: "ledger", relayId: "r-a", events: [ev(result, 2)] })

    // 行游标转发做不到这一步（rowid 不随 UPDATE 变）——这条就是返工的验收线
    await waitFor(() => mock.lastRows("tasks")[0]?.status === "replied", 5000)
    const row = mock.lastRows("tasks")[0]
    assert.equal(row.reply_msg_id, "r1")
    assert.equal(row.title, "干活", "整行重推，没变的列不许丢")
    assert.equal(row.project, "P62")
    a.close()
  })

  it("云端一直不通 → ack 照回、行照落库、游标不动（旁路铁律的 Hub 级证据）", async () => {
    const mock = new MockIngest()
    mock.throwErr = new Error("云端炸了")
    const hub = await startHub({ dbPath: tmpDb(), token: TOKEN, httpPort: 0, quiet: true, forwarder: fwdOpts(mock) })

    const a = await connect(`ws://localhost:${hub.port}`)
    const buf = collect(a)
    send(a, { type: "register", relay: mkReg("r-a", "mini", ["mini:cc-w1"]) })
    await waitFor(() => buf.some((m) => m.type === "devices"))
    for (let i = 1; i <= 5; i++) {
      send(a, { type: "ledger", relayId: "r-a", events: [ev(mkMsg({ id: `dead-${i}` }), i)] })
    }
    await waitFor(() => buf.filter((m) => m.type === "ledger_ack").length === 5, 3000)
    assert.equal(hub.ledger!.store.listMessages({}).length, 5, "转发挂了热层照记")
    assert.equal(hub.ledger!.store.getForwardWatermark("ledger_messages"), 0, "没 2xx 不许推游标")

    // 云端恢复 → 自动续传，一条不丢
    mock.throwErr = null
    await waitFor(() => hub.ledger!.store.getForwardWatermark("ledger_messages") === 5, 5000)
    a.close()
  })

  it("close() 之后转发定时器不再发（库句柄不会被在飞的批撞上）", async () => {
    const mock = new MockIngest()
    const hub = await createHub({
      port: 0,
      ledger: { dbPath: tmpDb(), token: TOKEN, httpPort: 0, quiet: true, forwarder: fwdOpts(mock) },
    })
    const a = await connect(`ws://localhost:${hub.port}`)
    const buf = collect(a)
    send(a, { type: "register", relay: mkReg("r-a", "mini", ["mini:cc-w1"]) })
    await waitFor(() => buf.some((m) => m.type === "devices"))
    send(a, { type: "ledger", relayId: "r-a", events: [ev(mkMsg({ id: "bye-1" }), 1)] })
    await waitFor(() => mock.calls.length > 0, 3000)

    await hub.close()
    const seen = mock.calls.length
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(mock.calls.length, seen, "close 之后不该再有转发请求")
  })
})

describe("ledgerFromEnv / forwarderFromEnv 接线", () => {
  it("双缺省 → 不带 forwarder（零行为）", () => {
    assert.equal(forwarderFromEnv({} as NodeJS.ProcessEnv), undefined)
    assert.equal(ledgerFromEnv({} as NodeJS.ProcessEnv)!.forwarder, undefined)
  })

  it("只配一半 / 空白串 → undefined（fail-closed）", () => {
    assert.equal(forwarderFromEnv({ CONSOLE_INGEST_URL: "https://a.test" } as NodeJS.ProcessEnv), undefined)
    assert.equal(forwarderFromEnv({ CONSOLE_INGEST_TOKEN: "t" } as NodeJS.ProcessEnv), undefined)
    assert.equal(forwarderFromEnv({ CONSOLE_INGEST_URL: " ", CONSOLE_INGEST_TOKEN: " " } as NodeJS.ProcessEnv), undefined)
  })

  it("配齐 → url/token trim；清理默认关，LEDGER_RETENTION_DAYS 正数才开", () => {
    const base = { CONSOLE_INGEST_URL: " https://a.test ", CONSOLE_INGEST_TOKEN: " tok " } as NodeJS.ProcessEnv
    const off = forwarderFromEnv(base)!
    assert.equal(off.url, "https://a.test")
    assert.equal(off.token, "tok")
    assert.equal(off.retention!.enabled, false)

    const on = forwarderFromEnv({ ...base, LEDGER_RETENTION_DAYS: "7" })!
    assert.equal(on.retention!.enabled, true)
    assert.equal(on.retention!.days, 7)
    for (const bad of ["0", "-3", "毁灭吧"]) {
      assert.equal(forwarderFromEnv({ ...base, LEDGER_RETENTION_DAYS: bad })!.retention!.enabled, false, `days=${bad}`)
    }
  })

  it("与 @cc-mesh/ledger 的 forwarderFromEnv 语义逐条一致（防两处漂移）", async () => {
    const { forwarderFromEnv: canonical } = await import("@cc-mesh/ledger")
    const cases: NodeJS.ProcessEnv[] = [
      {},
      { CONSOLE_INGEST_URL: "https://a.test" },
      { CONSOLE_INGEST_TOKEN: "t" },
      { CONSOLE_INGEST_URL: "  ", CONSOLE_INGEST_TOKEN: "  " },
      { CONSOLE_INGEST_URL: " https://a.test/ ", CONSOLE_INGEST_TOKEN: " t " },
      { CONSOLE_INGEST_URL: "https://a.test", CONSOLE_INGEST_TOKEN: "t", LEDGER_RETENTION_DAYS: "7" },
      { CONSOLE_INGEST_URL: "https://a.test", CONSOLE_INGEST_TOKEN: "t", LEDGER_RETENTION_DAYS: "0" },
      { CONSOLE_INGEST_URL: "https://a.test", CONSOLE_INGEST_TOKEN: "t", LEDGER_RETENTION_DAYS: "毁灭吧" },
      { CONSOLE_INGEST_URL: "https://a.test", CONSOLE_INGEST_TOKEN: "t", LEDGER_RETENTION_DAYS: "30" },
    ]
    for (const env of cases) {
      const mine = forwarderFromEnv(env)
      const theirs = canonical(env)
      if (!theirs) {
        assert.equal(mine, undefined, `env=${JSON.stringify(env)} 两边都该关`)
        continue
      }
      assert.ok(mine, `env=${JSON.stringify(env)} 两边都该开`)
      assert.equal(mine!.url, theirs.url)
      assert.equal(mine!.token, theirs.token)
      assert.equal(mine!.retention!.enabled, theirs.retention.enabled)
      assert.equal(mine!.retention!.days, theirs.retention.days)
    }
  })

  it("LEDGER_DISABLED 仍是总闸：账本关了转发也无从谈起", () => {
    assert.equal(ledgerFromEnv({
      LEDGER_DISABLED: "1", CONSOLE_INGEST_URL: "https://a.test", CONSOLE_INGEST_TOKEN: "t",
    } as NodeJS.ProcessEnv), undefined)
  })
})
