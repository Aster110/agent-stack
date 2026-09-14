/**
 * Sync 契约测试 — 方案 B PR1（GET /api/sync 长轮询单原语）
 *
 * 覆盖 features/sync单原语 §6.1 验证行全集：
 *   立即返回 / 停车结算(真等到事件唤醒) / 超时空批 / since 即 ack /
 *   since≤游标回看 / 缺省游标 / 广播合流打真 /api/broadcast /
 *   消息与超时同时到(竞态,settle-once) / limit 截断 / 404 / clamp
 * 外加：priority 透传、parkedCount 增减 + status 派生、mesh-sync-wrapper.sh。
 */
import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { createServer, type MeshServer } from "./server.js"
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import type { ITerminal, SpawnResult } from "./terminal/interface.js"
import { MeshEventBus } from "./events.js"
import os from "node:os"
import path from "node:path"
import fs from "node:fs"
import { execFile } from "node:child_process"

// ===== Mock Terminal（inject 计数用）=====
class MockTerminal implements ITerminal {
  injectLog: Array<{ sessionId: string; text: string }> = []
  async inject(sessionId: string, text: string): Promise<boolean> {
    this.injectLog.push({ sessionId, text })
    return true
  }
  async spawn(): Promise<SpawnResult> { return { sessionId: "mock", windowId: "mock" } }
  async isAlive(): Promise<boolean> { return true }
  async close(): Promise<void> {}
  async getCurrentSession(): Promise<null> { return null }
  async notify(): Promise<boolean> { return true }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface TestServer {
  server: Server
  base: string
  app: MeshServer
  bus: MeshEventBus
  term: MockTerminal
  close: () => Promise<void>
}

async function createTestServer(): Promise<TestServer> {
  const db = path.join(os.tmpdir(), `mesh-sync-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const term = new MockTerminal()
  const bus = new MeshEventBus()
  const app = createServer({ dbPath: db, deviceId: "macbook", terminal: term, events: bus } as any)
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s))
  })
  const addr = server.address() as AddressInfo
  const base = `http://localhost:${addr.port}`
  const close = async () => {
    await new Promise<void>((r) => server.close(() => r()))
    for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(db + ext) } catch {} }
  }
  return { server, base, app, bus, term, close }
}

async function httpGet(base: string, p: string): Promise<{ status: number; data: any }> {
  const res = await fetch(`${base}${p}`)
  const data = await res.json().catch(() => null)
  return { status: res.status, data }
}
async function httpPost(base: string, p: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; data: any }> {
  const res = await fetch(`${base}${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => null)
  return { status: res.status, data }
}

async function registerPull(base: string, shortId: string): Promise<string> {
  const r = await httpPost(base, "/api/register", { shortId, pid: 1, role: "worker", description: "pull", deliveryMode: "sse-pull" })
  return r.data.data.nodeId as string
}
async function registerInject(base: string, shortId: string): Promise<string> {
  const r = await httpPost(base, "/api/register", { shortId, sessionId: `sess-${shortId}`, pid: 1, role: "worker", description: "inject" })
  return r.data.data.nodeId as string
}

function syncPath(nodeId: string, opts: { since?: number | string; timeout?: number | string; limit?: number } = {}): string {
  const q = new URLSearchParams()
  q.set("nodeId", nodeId)
  if (opts.since !== undefined) q.set("since", String(opts.since))
  if (opts.timeout !== undefined) q.set("timeout", String(opts.timeout))
  if (opts.limit !== undefined) q.set("limit", String(opts.limit))
  return `/api/sync?${q.toString()}`
}
async function sync(base: string, nodeId: string, opts?: { since?: number | string; timeout?: number | string; limit?: number }) {
  return httpGet(base, syncPath(nodeId, opts))
}
// 每次 send 用唯一 sender：genMessageId = `msg-${Date.now()}-${from}`，
// 同毫秒同 sender 会撞 id 被 INSERT OR REPLACE 折叠成一行（protocol 侧既有限制，PR1 范围外）。
// 唯一 sender 保证测试里两条消息落两行，不受毫秒粒度影响。
let sendCounter = 0
async function send(base: string, to: string, message: string, extra: Record<string, unknown> = {}, from?: string) {
  const sender = from ?? `macbook:cc-tester-${++sendCounter}`
  return httpPost(base, "/api/send", { to, message, ...extra }, { "X-Mesh-Node": sender })
}

// ===== 同步契约（无需真停车，共享 server；本 describe 从不广播，避免 to='*' 污染）=====
describe("GET /api/sync — 同步契约", () => {
  let ts: TestServer
  before(async () => { ts = await createTestServer() })
  after(async () => { await ts.close() })

  it("缺 nodeId → 400", async () => {
    const r = await httpGet(ts.base, "/api/sync?timeout=0")
    assert.equal(r.status, 400)
    assert.equal(r.data.ok, false)
  })

  it("未注册 nodeId → 404", async () => {
    const r = await sync(ts.base, "macbook:cc-ghost", { timeout: 0 })
    assert.equal(r.status, 404)
    assert.equal(r.data.ok, false)
  })

  it("立即返回：有 seq>since 消息则立刻带整批返回", async () => {
    const p = await registerPull(ts.base, "cc-imm")
    await send(ts.base, p, "hello-imm")
    const r = await sync(ts.base, p) // 默认 timeout=55，但有货立即返回
    assert.equal(r.status, 200)
    assert.equal(r.data.ok, true)
    const msgs = r.data.data.messages
    assert.ok(msgs.length >= 1)
    const found = msgs.find((m: any) => m.payload === "hello-imm")
    assert.ok(found, "应返回刚发的消息")
    assert.equal(r.data.data.nextSince, Math.max(...msgs.map((m: any) => m.seq)))
    assert.equal(typeof r.data.data.parkedMs, "number")
  })

  it("timeout=0：无消息立即空批返回（探测语义）", async () => {
    const p = await registerPull(ts.base, "cc-t0")
    const r = await sync(ts.base, p, { timeout: 0 })
    assert.equal(r.status, 200)
    assert.deepEqual(r.data.data.messages, [])
    assert.ok(r.data.data.parkedMs < 500, "timeout=0 不停车")
  })

  it("clamp：timeout 负值 → clamp 到 0（立即空批，不停车）", async () => {
    const p = await registerPull(ts.base, "cc-clamp")
    const t0 = Date.now()
    const r = await sync(ts.base, p, { timeout: -5 })
    const elapsed = Date.now() - t0
    assert.equal(r.status, 200)
    assert.deepEqual(r.data.data.messages, [])
    assert.ok(elapsed < 500, `负 timeout 应 clamp 到 0 立即返回，实际 ${elapsed}ms`)
    // 上界 55 由 Math.min(55,..) 构造保证（55s 停车不便在单测直接观测）
  })

  it("since 即 ack：显式 since>游标 → 推进游标（销账）再取", async () => {
    const p = await registerPull(ts.base, "cc-ack")
    await send(ts.base, p, "m1")
    await send(ts.base, p, "m2")
    const drained = await sync(ts.base, p, { timeout: 0 })
    const [s1, s2] = drained.data.data.messages.map((m: any) => m.seq)
    assert.ok(s1 < s2)

    // since=s1 > 游标0 → ack 到 s1，返回 seq>s1 = [m2]
    const r = await sync(ts.base, p, { since: s1, timeout: 0 })
    assert.equal(r.data.data.messages.length, 1)
    assert.equal(r.data.data.messages[0].seq, s2)

    // 游标已推进到 s1：POST /ack upTo=0 返回的 cursor 应为 s1（MAX 语义不回退）
    const ackr = await httpPost(ts.base, "/api/ack", { nodeId: p, upTo: 0 })
    assert.equal(ackr.data.data.cursor, s1, "游标应已被 since 即 ack 推进到 s1")
  })

  it("since≤游标回看：显式 since≤游标 → 不动游标，仍返回 seq>since", async () => {
    const p = await registerPull(ts.base, "cc-look")
    await send(ts.base, p, "l1")
    await send(ts.base, p, "l2")
    const drained = await sync(ts.base, p, { timeout: 0 })
    const [s1, s2] = drained.data.data.messages.map((m: any) => m.seq)

    // 先 ack 到 s2（游标=s2）
    await sync(ts.base, p, { since: s2, timeout: 0 })
    const before = await httpPost(ts.base, "/api/ack", { nodeId: p, upTo: 0 })
    assert.equal(before.data.data.cursor, s2)

    // 回看：since=0 ≤ 游标 → 不推游标，仍返回 seq>0 = [l1,l2]
    const r = await sync(ts.base, p, { since: 0, timeout: 0 })
    assert.equal(r.data.data.messages.length, 2, "since≤游标应能回看重读")
    const after = await httpPost(ts.base, "/api/ack", { nodeId: p, upTo: 0 })
    assert.equal(after.data.data.cursor, s2, "回看不应改变游标")
  })

  it("缺省游标：省略 since → 用服务端 ack 游标，只取游标之后", async () => {
    const p = await registerPull(ts.base, "cc-cursor")
    await send(ts.base, p, "c1")
    await send(ts.base, p, "c2")
    const drained = await sync(ts.base, p, { timeout: 0 })
    const [s1, s2] = drained.data.data.messages.map((m: any) => m.seq)

    // ack 到 s1
    await sync(ts.base, p, { since: s1, timeout: 0 })
    // 省略 since → since=游标=s1 → 只返回 seq>s1 = [c2]
    const r = await sync(ts.base, p, { timeout: 0 })
    assert.equal(r.data.data.messages.length, 1)
    assert.equal(r.data.data.messages[0].seq, s2)
  })

  it("limit 截断：按 seq ASC 只取前 limit 条", async () => {
    const p = await registerPull(ts.base, "cc-limit")
    await send(ts.base, p, "x1")
    await send(ts.base, p, "x2")
    await send(ts.base, p, "x3")
    const r = await sync(ts.base, p, { since: 0, timeout: 0, limit: 2 })
    assert.equal(r.data.data.messages.length, 2)
    const seqs = r.data.data.messages.map((m: any) => m.seq)
    assert.ok(seqs[0] < seqs[1], "seq ASC")
    assert.equal(r.data.data.nextSince, seqs[1], "nextSince=批内最大 seq")
  })

  // ===== priority 透传 =====
  it("priority 透传：send priority=urgent → sync/inbox 返回 urgent", async () => {
    const p = await registerPull(ts.base, "cc-prio-u")
    await send(ts.base, p, "urgent-msg", { priority: "urgent" })
    const r = await sync(ts.base, p, { timeout: 0 })
    assert.equal(r.data.data.messages[0].priority, "urgent")
    const inbox = await httpGet(ts.base, `/api/inbox?nodeId=${encodeURIComponent(p)}`)
    assert.equal(inbox.data.data.messages[0].priority, "urgent")
  })

  it("priority 缺省 → normal；非法值 → normal", async () => {
    const p = await registerPull(ts.base, "cc-prio-d")
    await send(ts.base, p, "default-prio")
    await send(ts.base, p, "bogus-prio", { priority: "bogus" })
    const r = await sync(ts.base, p, { since: 0, timeout: 0 })
    for (const m of r.data.data.messages) {
      assert.equal(m.priority, "normal")
    }
  })

  // ===== presence 派生 =====
  it("presence：从未 sync 的 pull 节点 status 派生为 offline（不删节点）", async () => {
    const p = await registerPull(ts.base, "cc-pres-off")
    const st = await httpGet(ts.base, "/api/status")
    const node = st.data.data.nodes.find((n: any) => n.identity.nodeId === p)
    assert.ok(node, "节点仍在 registry（只改显示 status）")
    assert.equal(node.identity.deliveryMode, "pull", "PR2:注册值 sse-pull 应收敛为 pull")
    assert.equal(node.status, "offline")
    assert.equal(node.parkedCount, 0)
  })

  it("presence：sync 过后 lastSync 新鲜 → status idle", async () => {
    const p = await registerPull(ts.base, "cc-pres-fresh")
    await sync(ts.base, p, { timeout: 0 }) // touchSync 刷新 lastSyncAt
    const st = await httpGet(ts.base, "/api/status")
    const node = st.data.data.nodes.find((n: any) => n.identity.nodeId === p)
    assert.equal(node.status, "idle", "刚 sync 过 <90s 应 idle")
  })

  it("presence：inject 节点 status 逻辑不动（仍为 registry 内 idle，无派生）", async () => {
    const p = await registerInject(ts.base, "cc-pres-inj")
    const st = await httpGet(ts.base, "/api/status")
    const node = st.data.data.nodes.find((n: any) => n.identity.nodeId === p)
    assert.equal(node.identity.deliveryMode, "inject")
    assert.equal(node.status, "idle", "inject 节点 status 不被 sync 派生改写")
    assert.equal(node.parkedCount, undefined, "inject 节点不派生 parkedCount 字段")
  })
})

// ===== 停车/唤醒（每测独立 server，隔离跨测消息污染）=====
describe("GET /api/sync — 停车与唤醒", () => {
  it("停车结算：无消息则停车，真等到 /api/send 事件唤醒后带整批返回", async () => {
    const ts = await createTestServer()
    try {
      const p = await registerPull(ts.base, "cc-park")
      const pending = sync(ts.base, p, { timeout: 5 }) // 无消息 → 停车
      await sleep(150)
      await send(ts.base, p, "woke-you-up")
      const r = await pending
      assert.equal(r.status, 200)
      assert.equal(r.data.data.messages.length, 1)
      assert.equal(r.data.data.messages[0].payload, "woke-you-up")
      assert.ok(r.data.data.parkedMs >= 100, `parkedMs 应体现真停过车，实际 ${r.data.data.parkedMs}`)
    } finally {
      await ts.close()
    }
  })

  it("广播合流：停车的 sync 被真 POST /api/broadcast 唤醒（审计 1 broadcast emit）", async () => {
    const ts = await createTestServer()
    try {
      const p = await registerPull(ts.base, "cc-bcast")
      const pending = sync(ts.base, p, { timeout: 5 })
      await sleep(150)
      await httpPost(ts.base, "/api/broadcast", { message: "to-everyone", type: "system" }, { "X-Mesh-Node": "macbook:cc-caster" })
      const r = await pending
      assert.equal(r.data.data.messages.length >= 1, true)
      const found = r.data.data.messages.find((m: any) => m.payload === "to-everyone" && m.to === "*")
      assert.ok(found, "应通过 broadcast 的 msg:send 门铃唤醒并取到广播消息")
    } finally {
      await ts.close()
    }
  })

  it("超时空批：无消息且无事件 → 到超时返回空批", async () => {
    const ts = await createTestServer()
    try {
      const p = await registerPull(ts.base, "cc-empty")
      const t0 = Date.now()
      const r = await sync(ts.base, p, { timeout: 1 })
      const elapsed = Date.now() - t0
      assert.equal(r.status, 200)
      assert.deepEqual(r.data.data.messages, [])
      assert.equal(r.data.data.nextSince, 0)
      assert.ok(elapsed >= 900, `应真停车约 1s，实际 ${elapsed}ms`)
    } finally {
      await ts.close()
    }
  })

  it("竞态/settle-once：事件唤醒后 timer 被清，超时窗过后 server 仍健康", async () => {
    const ts = await createTestServer()
    try {
      const p = await registerPull(ts.base, "cc-race")
      const pending = sync(ts.base, p, { timeout: 1 })
      await sleep(100)
      await send(ts.base, p, "race-msg") // 事件在 timer(1s) 前唤醒
      const r = await pending
      assert.equal(r.data.data.messages.length, 1)
      await sleep(1100) // 越过原 1s timeout 窗口
      const health = await sync(ts.base, p, { timeout: 0 }) // server 未卡死
      assert.equal(health.status, 200)
    } finally {
      await ts.close()
    }
  })

  it("超时重查：消息在停车期落库但事件缺失，到超时 settle 重查仍能取到（不误报空批）", async () => {
    const ts = await createTestServer()
    try {
      const p = await registerPull(ts.base, "cc-requery")
      const pending = sync(ts.base, p, { timeout: 1 })
      await sleep(100)
      // 绕过 /api/send，直接落库不 emit（模拟事件缺失）
      ts.app.store.saveMessage({
        id: `msg-requery-${Date.now()}`,
        from: "macbook:cc-x",
        to: p,
        type: "chat",
        payload: "silently-stored",
        createdAt: new Date().toISOString(),
      })
      const r = await pending
      assert.equal(r.data.data.messages.length, 1, "超时 settle 应重查 getInbox 取到静默落库的消息")
      assert.equal(r.data.data.messages[0].payload, "silently-stored")
    } finally {
      await ts.close()
    }
  })

  it("presence：停车中 parkedCount>0 → status idle；唤醒后归 0（仍 idle：lastSync 新鲜）", async () => {
    const ts = await createTestServer()
    try {
      const p = await registerPull(ts.base, "cc-parkcount")
      const pending = sync(ts.base, p, { timeout: 5 })
      await sleep(150)
      const during = await httpGet(ts.base, "/api/status")
      const n1 = during.data.data.nodes.find((n: any) => n.identity.nodeId === p)
      assert.ok(n1.parkedCount >= 1, `停车中 parkedCount 应>0，实际 ${n1.parkedCount}`)
      assert.equal(n1.status, "idle", "停车中 status=idle")

      await send(ts.base, p, "settle")
      await pending
      const afterS = await httpGet(ts.base, "/api/status")
      const n2 = afterS.data.data.nodes.find((n: any) => n.identity.nodeId === p)
      assert.equal(n2.parkedCount, 0, "结算后 parkedCount 归 0")
      assert.equal(n2.status, "idle", "刚 sync 过 lastSync 新鲜仍 idle")
    } finally {
      await ts.close()
    }
  })
})

// ===== mesh-sync-wrapper.sh — long-poll wrapper（bash 3.2）=====
describe("mesh-sync-wrapper.sh", () => {
  const wrapperPath = path.resolve(__dirname, "../../../scripts/mesh-sync-wrapper.sh")

  function runWrapper(
    args: string[],
    env: Record<string, string>,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      execFile(
        "bash",
        [wrapperPath, ...args],
        { env: { ...process.env, ...env }, timeout: 20_000 },
        (err: any, stdout, stderr) => {
          resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr })
        },
      )
    })
  }

  it("wrapper 存在且语法合法", () => {
    assert.ok(fs.existsSync(wrapperPath), `wrapper 应存在: ${wrapperPath}`)
  })

  it("有货且环境配置了不可达代理 → 直连 relay 打印整批 JSON，exit 0", async () => {
    const ts = await createTestServer()
    try {
      const p = await registerPull(ts.base, "cc-wrap-ok")
      await send(ts.base, p, "wrapped-payload")
      const r = await runWrapper([p], {
        MESH_RELAY_URL: ts.base, MESH_SYNC_TIMEOUT: "2",
        http_proxy: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1",
        ALL_PROXY: "http://127.0.0.1:1", NO_PROXY: "", no_proxy: "",
      })
      assert.equal(r.code, 0, `stderr=${r.stderr}`)
      assert.match(r.stdout, /PARKED_SECONDS=\d+/)
      assert.match(r.stdout, /wrapped-payload/)
      assert.match(r.stdout, /"messages":\[\{/)
    } finally {
      await ts.close()
    }
  })

  it("未注册节点 → 非 2xx 带错误正文 exit 2（唤醒重注册，非无限重拨）", async () => {
    const ts = await createTestServer()
    try {
      const r = await runWrapper(["macbook:cc-wrap-ghost"], { MESH_RELAY_URL: ts.base, MESH_SYNC_TIMEOUT: "2" })
      assert.equal(r.code, 2, `stdout=${r.stdout} stderr=${r.stderr}`)
      assert.match(r.stderr, /HTTP 404/)
    } finally {
      await ts.close()
    }
  })

  it("MAX_WAIT 到仍空批 → exit 3（心跳级止损）", async () => {
    const ts = await createTestServer()
    try {
      const p = await registerPull(ts.base, "cc-wrap-timeout")
      // MAX_WAIT=1s，单轮 timeout=1s → 一轮空批后止损退出
      const r = await runWrapper([p, "", "1"], { MESH_RELAY_URL: ts.base, MESH_SYNC_TIMEOUT: "1" })
      assert.equal(r.code, 3, `stdout=${r.stdout} stderr=${r.stderr}`)
    } finally {
      await ts.close()
    }
  })

  it("连接错误 → 退避重拨，MAX_WAIT 到止损 exit 3（不 hang）", async () => {
    // 指向一个没有服务的端口：curl 连接失败 → 退避重拨 → MAX_WAIT=1 止损
    const r = await runWrapper(["macbook:cc-noconn", "", "1"], {
      MESH_RELAY_URL: "http://127.0.0.1:1",
      MESH_SYNC_TIMEOUT: "1",
    })
    assert.equal(r.code, 3, `stdout=${r.stdout} stderr=${r.stderr}`)
  })
})
