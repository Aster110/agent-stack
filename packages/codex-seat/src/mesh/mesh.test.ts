// Lane B — IMeshClient / ILedgerClient 单测（对着假 relay 打真 HTTP）。

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { MeshHttpError } from "../contracts.js"
import { MeshClient } from "./mesh-client.js"
import { LedgerClient } from "./ledger-client.js"
import { FakeRelay } from "../seat/fakes/fake-relay.js"

async function withRelay<T>(fn: (relay: FakeRelay) => Promise<T>): Promise<T> {
  const relay = await FakeRelay.start()
  try { return await fn(relay) } finally { await relay.stop() }
}

test("mesh: register 一律以 pull 形态注册，返回 relay 给的 nodeId", async () => {
  // 注入：把 deliveryMode 写成 "inject" → 断言红（席位没 pane，inject 形态消息永远进不来）
  await withRelay(async (relay) => {
    const mesh = new MeshClient(relay.url)
    const { nodeId } = await mesh.register({ shortId: "e2e-ab12", role: "main", description: "codex-seat", pid: 4242 })
    assert.equal(nodeId, "e2edev:e2e-ab12")
    const body = relay.registers[0]!
    assert.equal(body.deliveryMode, "pull")
    assert.equal(body.shortId, "e2e-ab12")
    assert.equal(body.role, "main")
    assert.equal(body.pid, 4242)
    assert.equal(body.description, "codex-seat")
  })
})

test("mesh: sync 把 since/timeout/limit 都带上，并按 seq 升序返回批", async () => {
  // 注入：sync 不传 since → relay 永不 ack → 每轮重投同一批（本测断言 since 落在 query 上）
  await withRelay(async (relay) => {
    const mesh = new MeshClient(relay.url)
    const { nodeId } = await mesh.register({ shortId: "server", role: "main", description: "d", pid: 1 })
    relay.deliver(nodeId, "e2edev:probe", "one")
    relay.deliver(nodeId, "e2edev:probe", "two")

    const batch = await mesh.sync({ nodeId, since: 0, timeoutSec: 1, limit: 100 })
    assert.equal(batch.messages.length, 2)
    assert.deepEqual(batch.messages.map((m: { payload: string }) => m.payload), ["one", "two"])
    assert.equal(batch.nextSince, 2)
    const rec = relay.syncs.at(-1)!
    assert.equal(rec.since, 0)
    assert.equal(rec.timeoutSec, 1)
    assert.equal(rec.limit, 100)
  })
})

test("mesh: 传 since > 游标就是销账——下一轮不再重投同一批", async () => {
  await withRelay(async (relay) => {
    const mesh = new MeshClient(relay.url)
    const { nodeId } = await mesh.register({ shortId: "s2", role: "main", description: "d", pid: 1 })
    relay.deliver(nodeId, "e2edev:probe", "one")
    const first = await mesh.sync({ nodeId, since: 0, timeoutSec: 1, limit: 100 })
    assert.equal(first.messages.length, 1)
    const second = await mesh.sync({ nodeId, since: first.nextSince, timeoutSec: 0, limit: 100 })
    assert.equal(second.messages.length, 0)
    assert.equal(relay.cursors.get(nodeId), 1)
  })
})

test("mesh: 未注册节点 sync → MeshHttpError(404)，连不上 → 普通 Error", async () => {
  // 注入：把所有非 2xx 都包成普通 Error → 调用方分不清「该重注册」和「该退避」→ 断言红
  await withRelay(async (relay) => {
    const mesh = new MeshClient(relay.url)
    await assert.rejects(
      () => mesh.sync({ nodeId: "e2edev:ghost", timeoutSec: 0, limit: 10 }),
      (err: unknown) => err instanceof MeshHttpError && err.status === 404,
    )
  })
  const dead = new MeshClient("http://127.0.0.1:1")
  await assert.rejects(
    () => dead.sync({ nodeId: "x:y", timeoutSec: 0, limit: 10 }),
    (err: unknown) => err instanceof Error && !(err instanceof MeshHttpError),
  )
})

test("mesh: send 的署名走 X-Mesh-Node 头，type/replyTo 进 body", async () => {
  // 注入：把 from 写进 body 而不是 X-Mesh-Node 头 → relay 会兜底成 <device>:relay → 断言红
  await withRelay(async (relay) => {
    const mesh = new MeshClient(relay.url)
    await mesh.register({ shortId: "seat", role: "main", description: "d", pid: 1 })
    await mesh.register({ shortId: "probe", role: "worker", description: "d", pid: 2 })
    const r = await mesh.send({
      from: "e2edev:seat", to: "e2edev:probe",
      message: "[done] nonce=abcd node=e2edev:seat thread=t ms=5\nhi",
      type: "result", replyTo: "msg-1",
    })
    assert.match(r.msgId, /^msg-/)
    const rec = relay.sends.at(-1)!
    assert.equal(rec.from, "e2edev:seat", "署名必须是席位/worker，不能退化成 relay 兜底")
    assert.equal(rec.type, "result")
    assert.equal(rec.replyTo, "msg-1")
  })
})

test("mesh: unregister 走 DELETE /api/register/<urlencoded nodeId>", async () => {
  await withRelay(async (relay) => {
    const mesh = new MeshClient(relay.url)
    const { nodeId } = await mesh.register({ shortId: "cx-dead", role: "worker", description: "d", pid: 1 })
    assert.ok(relay.nodes.has(nodeId))
    await mesh.unregister(nodeId)
    assert.ok(!relay.nodes.has(nodeId))
    await assert.rejects(() => mesh.unregister(nodeId), (e: unknown) => e instanceof MeshHttpError && e.status === 404)
  })
})

test("mesh: nodes() 摊平 /api/status 的 identity 视图（对账要用 description/deliveryMode）", async () => {
  await withRelay(async (relay) => {
    const mesh = new MeshClient(relay.url)
    await mesh.register({ shortId: "cx-dead", role: "worker", description: "codex-seat owner=e2edev:seat delegator=x", pid: 7 })
    const nodes = await mesh.nodes()
    const n = nodes.find((x: { shortId: string }) => x.shortId === "cx-dead")!
    assert.equal(n.nodeId, "e2edev:cx-dead")
    assert.equal(n.deliveryMode, "pull")
    assert.match(n.description, /owner=e2edev:seat/)
    assert.equal(n.pid, 7)
  })
})

test("mesh: 本机 relay 请求必须绕过代理 env（HTTP_PROXY 指黑洞也照样通）", async () => {
  // 注入：把 http.request 换成 fetch 且允许 undici 读 env 代理（NODE_USE_ENV_PROXY=1）→ 连黑洞 → 红
  await withRelay(async (relay) => {
    const saved = { ...process.env }
    process.env.HTTP_PROXY = "http://127.0.0.1:1"
    process.env.http_proxy = "http://127.0.0.1:1"
    process.env.HTTPS_PROXY = "http://127.0.0.1:1"
    process.env.ALL_PROXY = "socks5://127.0.0.1:1"
    process.env.NODE_USE_ENV_PROXY = "1"
    try {
      const mesh = new MeshClient(relay.url)
      const { nodeId } = await mesh.register({ shortId: "noproxy", role: "main", description: "d", pid: 1 })
      relay.deliver(nodeId, "e2edev:probe", "through")
      const batch = await mesh.sync({ nodeId, since: 0, timeoutSec: 1, limit: 10 })
      assert.equal(batch.messages[0]?.payload, "through")
    } finally {
      for (const k of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "ALL_PROXY", "NODE_USE_ENV_PROXY"]) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
    }
  })
})

test("mesh: sync 可被 AbortSignal 打断（优雅退出不等 55s）", async () => {
  await withRelay(async (relay) => {
    const mesh = new MeshClient(relay.url)
    const { nodeId } = await mesh.register({ shortId: "abort", role: "main", description: "d", pid: 1 })
    const ac = new AbortController()
    const t0 = Date.now()
    const p = mesh.sync({ nodeId, since: 0, timeoutSec: 55, limit: 10 }, ac.signal)
    setTimeout(() => ac.abort(), 100)
    await assert.rejects(() => p)
    assert.ok(Date.now() - t0 < 5000, "abort 必须立刻返回，不能傻等长轮询超时")
  })
})

test("ledger: PUT /api/ledger/seats 带 Bearer（token 从文件读），错误信息里不许出现 token", async () => {
  // 注入：把 token 拼进 MeshHttpError 的 body 或 header 日志 → 断言红
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-seat-ledger-"))
  const tokenFile = path.join(dir, "hub-token")
  const secret = "hub-token-SUPERSECRET-9999"
  fs.writeFileSync(tokenFile, `${secret}\n`, { mode: 0o600 })

  const seen: Array<{ auth: string | undefined; body: string; method: string; path: string }> = []
  const http = await import("node:http")
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      seen.push({
        auth: req.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
        method: req.method ?? "",
        path: req.url ?? "",
      })
      if (seen.length === 1) { res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}') }
      else { res.writeHead(500, { "content-type": "application/json" }); res.end('{"ok":false,"error":"boom"}') }
    })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const port = (server.address() as { port: number }).port
  try {
    const ledger = new LedgerClient(`http://127.0.0.1:${port}`, tokenFile)
    await ledger.upsertSeat({
      seatId: "e2edev/e2e-ab12", device: "e2edev", agentKind: "codex-app-server",
      accountFp: "chatgpt-000000000000", capabilities: ["codex", "app-server", "spawn"],
      delivery: "pull", active: true,
    })
    assert.equal(seen[0]!.method, "PUT")
    assert.equal(seen[0]!.path, "/api/ledger/seats")
    assert.equal(seen[0]!.auth, `Bearer ${secret}`)
    assert.equal(JSON.parse(seen[0]!.body).seatId, "e2edev/e2e-ab12")

    let msg = ""
    try {
      await ledger.upsertSeat({
        seatId: "e2edev/e2e-ab12", device: "e2edev", agentKind: "codex-app-server",
        accountFp: null, capabilities: [], delivery: "pull", active: true,
      })
    } catch (err) { msg = String((err as Error).message) + String((err as Error).stack ?? "") }
    assert.notEqual(msg, "", "第二次必须抛错")
    assert.ok(!msg.includes(secret), "token 绝不许出现在错误信息里")
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
})
