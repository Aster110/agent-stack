/**
 * 只读 HTTP API 单测 — 设计 §7 契约 + §8 安全（Bearer token 必带）。
 * M0 验收 ③：无 token 401、错 token 401。
 */
import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { LedgerStore } from "./store.js"
import { Projector } from "./projector.js"
import { startLedgerHttp, type LedgerHttpInstance } from "./http.js"
import { CODEX_ENVELOPE, CLAUDE_ENVELOPE, mkMsg, mkEvent, mkQuotaMsg } from "./testdata.js"
import type { DeviceInventory, MeshMessage } from "@cc-mesh/protocol"

const TOKEN = "s3cr3t-token"

let store: LedgerStore
let server: LedgerHttpInstance
let base: string

const devices: DeviceInventory[] = [{
  deviceId: "mini",
  relayId: "relay-mini",
  nodes: [{ nodeId: "mini:cc-w1", deviceId: "mini", shortId: "cc-w1", role: "worker", description: "", capabilities: [] }],
  updatedAt: "2026-08-27T10:00:00+08:00",
}]

async function get(pathname: string, token: string | null = TOKEN): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {}
  if (token !== null) headers.Authorization = `Bearer ${token}`
  const res = await fetch(base + pathname, { headers })
  return { status: res.status, body: await res.json().catch(() => null) }
}

async function put(pathname: string, payload: unknown, token: string | null = TOKEN): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (token !== null) headers.Authorization = `Bearer ${token}`
  const res = await fetch(base + pathname, { method: "PUT", headers, body: JSON.stringify(payload) })
  return { status: res.status, body: await res.json().catch(() => null) }
}

before(async () => {
  store = new LedgerStore(":memory:")
  const proj = new Projector(store)

  const task = mkMsg({ id: "t1", from: "macbook:cc-main", to: "mini:cc-w1", type: "task", payload: "干活", createdAt: "2026-08-27T10:00:00+08:00", meta: { _task: { title: "干活", project: "P62", pickReason: "explicit" } } })
  const done = mkMsg({ id: "r1", from: "mini:cc-w1", to: "macbook:cc-main", type: "result", payload: "完事", replyTo: "t1", createdAt: "2026-08-27T10:30:00+08:00" })
  const task2 = mkMsg({ id: "t2", from: "macbook:cc-main", to: "computer2:cc-w9", type: "task", payload: "另一个活", createdAt: "2026-08-27T11:00:00+08:00", meta: { _task: { title: "另一个活", project: "P81", pickReason: "explicit", todoUid: "todo-uid-t2" } } })
  const chat = mkMsg({ id: "c1", from: "macbook:cc-main", to: "mini:cc-w1", type: "chat", payload: "在吗", createdAt: "2026-08-27T09:00:00+08:00" })

  proj.ingest([
    mkEvent(chat, { srcSeq: 1 }), mkEvent(task, { srcSeq: 2 }),
    mkEvent(done, { srcSeq: 3 }), mkEvent(task2, { srcSeq: 4 }),
    mkEvent(mkQuotaMsg("q1", CODEX_ENVELOPE, { createdAt: "2026-08-27T12:00:00+08:00" }), { srcSeq: 5 }),
    mkEvent(mkQuotaMsg("q2", CLAUDE_ENVELOPE, { createdAt: "2026-08-27T13:00:00+08:00" }), { srcSeq: 6 }),
  ], "relay-A")
  store.insertEvent({ kind: "relay_online", device: "mini", nodeId: null, detail: { nodes: 1 }, ts: "2026-08-27T09:59:00+08:00" })
  store.upsertSeat({ seatId: "mini/w1", device: "mini", agentKind: "codex", accountFp: "chatgpt-9f8e7d6c5b4a", capabilities: ["P62"], delivery: "inject", active: true })
  store.upsertSeat({ seatId: "computer2/w9", device: "computer2", agentKind: "claude-cli", accountFp: "claude-abc123def456", capabilities: ["P81"], delivery: "pull", active: true })

  server = await startLedgerHttp({ store, token: TOKEN, port: 0, presence: () => devices })
  base = `http://127.0.0.1:${server.port}`
})

after(async () => { await server.close(); store.close() })

describe("鉴权", () => {
  it("无 Authorization 头 → 401", async () => {
    const r = await get("/api/ledger/accounts", null)
    assert.equal(r.status, 401)
    assert.equal(r.body.ok, false)
  })

  it("错 token → 401", async () => {
    assert.equal((await get("/api/ledger/accounts", "wrong")).status, 401)
  })

  it("token 对但格式不是 Bearer → 401", async () => {
    const res = await fetch(base + "/api/ledger/accounts", { headers: { Authorization: TOKEN } })
    assert.equal(res.status, 401)
  })

  it("每个端点都挡（不是只挡首屏）", async () => {
    for (const p of ["/api/ledger/agents", "/api/ledger/quota", "/api/ledger/messages", "/api/ledger/tasks", "/api/ledger/events", "/api/ledger/accounts", "/api/ledger/seats"]) {
      assert.equal((await get(p, null)).status, 401, `${p} 未挡`)
    }
    assert.equal((await put("/api/ledger/seats", { seatId: "x/y", device: "x" }, null)).status, 401)
  })

  it("未知路径 → 404（带 token 也一样）", async () => {
    assert.equal((await get("/api/ledger/nope")).status, 404)
  })
})

describe("GET /api/ledger/messages", () => {
  it("200 + created_at 倒序", async () => {
    const r = await get("/api/ledger/messages")
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.deepEqual(r.body.data.map((m: any) => m.id), ["q2", "q1", "t2", "r1", "t1", "c1"])
  })

  it("from / to / type / since / limit 过滤", async () => {
    assert.deepEqual((await get("/api/ledger/messages?type=task")).body.data.map((m: any) => m.id), ["t2", "t1"])
    assert.deepEqual((await get("/api/ledger/messages?to=mini:cc-w1")).body.data.map((m: any) => m.id), ["t1", "c1"])
    assert.deepEqual((await get("/api/ledger/messages?from=mini:cc-w1")).body.data.map((m: any) => m.id), ["r1"])
    assert.deepEqual((await get("/api/ledger/messages?limit=2")).body.data.map((m: any) => m.id), ["q2", "q1"])
    const since = (await get("/api/ledger/messages?since=2026-08-27T10:30:00%2B08:00")).body.data
    assert.ok(since.every((m: any) => Date.parse(m.createdAt) >= Date.parse("2026-08-27T10:30:00+08:00")))
  })

  it("缺省 limit=100", async () => {
    assert.equal((await get("/api/ledger/messages")).body.limit, 100)
  })
})

describe("GET /api/ledger/tasks", () => {
  it("全量 + status/project/since 过滤", async () => {
    const all = (await get("/api/ledger/tasks")).body.data
    assert.equal(all.length, 2)
    assert.deepEqual((await get("/api/ledger/tasks?status=replied")).body.data.map((t: any) => t.taskId), ["t1"])
    assert.deepEqual((await get("/api/ledger/tasks?project=P81")).body.data.map((t: any) => t.taskId), ["t2"])
    assert.deepEqual((await get("/api/ledger/tasks?since=2026-08-27T10:30:00%2B08:00")).body.data.map((t: any) => t.taskId), ["t2"])
  })

  it("P142：行带 todoUid（无联结为 null），?todoUid= 精确过滤", async () => {
    const all = (await get("/api/ledger/tasks")).body.data
    assert.equal(all.find((t: any) => t.taskId === "t2").todoUid, "todo-uid-t2")
    assert.equal(all.find((t: any) => t.taskId === "t1").todoUid, null)
    assert.deepEqual((await get("/api/ledger/tasks?todoUid=todo-uid-t2")).body.data.map((t: any) => t.taskId), ["t2"])
    assert.deepEqual((await get("/api/ledger/tasks?todoUid=nope")).body.data, [])
  })
})

describe("GET /api/ledger/quota", () => {
  it("缺省每账号最新一条", async () => {
    const r = await get("/api/ledger/quota")
    assert.equal(r.status, 200)
    assert.equal(r.body.data.length, 2)
    const codex = r.body.data.find((q: any) => q.source === "codex")
    assert.equal(codex.pct5h, 42)
    assert.equal(codex.accountFp, "chatgpt-9f8e7d6c5b4a")
  })

  it("?account 过滤", async () => {
    const r = await get("/api/ledger/quota?account=claude-abc123def456")
    assert.equal(r.body.data.length, 1)
    assert.equal(r.body.data[0].source, "claude")
  })

  it("?history=1 给全序列", async () => {
    const r = await get("/api/ledger/quota?history=1")
    assert.equal(r.body.data.length, 2)
    assert.equal(r.body.history, true)
  })
})

describe("GET /api/ledger/events & /accounts", () => {
  it("events 支持 kind/since", async () => {
    assert.equal((await get("/api/ledger/events")).body.data.length, 1)
    assert.equal((await get("/api/ledger/events?kind=relay_online")).body.data.length, 1)
    assert.equal((await get("/api/ledger/events?kind=orphan_marked")).body.data.length, 0)
  })

  it("accounts 由 quota 投影自动建账", async () => {
    const fps = (await get("/api/ledger/accounts")).body.data.map((a: any) => a.accountFp).sort()
    assert.deepEqual(fps, ["chatgpt-9f8e7d6c5b4a", "claude-abc123def456"])
  })
})

describe("GET /api/ledger/agents（seats × presence × quota 合成）", () => {
  it("在线状态来自注入的 presence 回调", async () => {
    const r = await get("/api/ledger/agents")
    assert.equal(r.status, 200)
    const mini = r.body.data.agents.find((a: any) => a.seatId === "mini/w1")
    const computer2 = r.body.data.agents.find((a: any) => a.seatId === "computer2/w9")
    assert.equal(mini.online, true)
    assert.deepEqual(mini.nodes, ["mini:cc-w1"])
    assert.equal(computer2.online, false)
    assert.deepEqual(computer2.nodes, [])
  })

  it("每个席位挂上它账号的最新额度", async () => {
    const r = await get("/api/ledger/agents")
    const mini = r.body.data.agents.find((a: any) => a.seatId === "mini/w1")
    assert.equal(mini.quota.pct5h, 42)
    assert.equal(mini.quota.accountFp, "chatgpt-9f8e7d6c5b4a")
  })

  it("原始 presence 一并返回（看板要画未登记席位的设备）", async () => {
    const r = await get("/api/ledger/agents")
    assert.deepEqual(r.body.data.devices.map((d: any) => d.deviceId), ["mini"])
  })

  it("没注入 presence 时全部 offline，不崩", async () => {
    const s2 = new LedgerStore(":memory:")
    s2.upsertSeat({ seatId: "x/y", device: "x", agentKind: "codex", accountFp: null, capabilities: [], delivery: null, active: true })
    const srv = await startLedgerHttp({ store: s2, token: TOKEN, port: 0 })
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/ledger/agents`, { headers: { Authorization: `Bearer ${TOKEN}` } })
    const body: any = await res.json()
    assert.equal(body.data.agents[0].online, false)
    assert.equal(body.data.agents[0].quota, null)
    await srv.close(); s2.close()
  })
})

describe("PUT /api/ledger/seats（席位登记）", () => {
  it("写入后 GET 读得到", async () => {
    const r = await put("/api/ledger/seats", {
      seatId: "workstation/xcx", device: "workstation", agentKind: "codex",
      accountFp: "chatgpt-9f8e7d6c5b4a", capabilities: ["P62", "P134"], delivery: "inject", active: true,
    })
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    const seats = (await get("/api/ledger/seats")).body.data
    const s = seats.find((x: any) => x.seatId === "workstation/xcx")
    assert.deepEqual(s.capabilities, ["P62", "P134"])
    assert.equal(s.active, true)
  })

  it("缺 seatId / device → 400", async () => {
    assert.equal((await put("/api/ledger/seats", { device: "x" })).status, 400)
    assert.equal((await put("/api/ledger/seats", { seatId: "x/y" })).status, 400)
  })

  it("坏 JSON → 400", async () => {
    const res = await fetch(base + "/api/ledger/seats", {
      method: "PUT",
      headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: "{ 不是 json",
    })
    assert.equal(res.status, 400)
  })

  it("POST 到只读端点 → 405", async () => {
    const res = await fetch(base + "/api/ledger/messages", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } })
    assert.equal(res.status, 405)
  })
})

describe("startLedgerHttp 守卫", () => {
  it("空 token → 拒绝启动（不给公网开裸 API）", async () => {
    const s2 = new LedgerStore(":memory:")
    await assert.rejects(() => startLedgerHttp({ store: s2, token: "", port: 0 }), /token/i)
    s2.close()
  })
})
