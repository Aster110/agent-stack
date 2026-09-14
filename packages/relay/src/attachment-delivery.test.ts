/** Relay send/sync/downlink 附件集成红测；所有服务均为 localhost:0。 */
import { afterEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import type { ImageAttachmentManifest, MeshMessage } from "@cc-mesh/protocol"
import { MAX_IMAGE_BYTES, MAX_IMAGE_TTL_SECONDS } from "@cc-mesh/protocol"
import { createServer } from "./server.js"
import type { MeshServer } from "./server.js"
import { MeshEventBus } from "./events.js"
import type { ITerminal } from "./terminal/interface.js"

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
)
const SHA = createHash("sha256").update(PNG).digest("hex")
const FIXED_NOW = Date.parse("2026-08-28T12:00:00.000Z")
const EXPECTED_SYNC_MAX_LIMIT = 100
const EXPECTED_MATERIALIZE_CONCURRENCY = 4

function manifest(): ImageAttachmentManifest {
  return {
    version: 1, id: `att-${SHA}`, kind: "image", mime: "image/png", size: PNG.length,
    sha256: SHA, width: 1, height: 1, storageRef: `hub-blob:${SHA}`,
    createdAt: new Date(FIXED_NOW - 1_000).toISOString(), expiresAt: new Date(FIXED_NOW + 60_000).toISOString(),
  }
}

class Terminal implements ITerminal {
  injected: string[] = []
  async inject(_sessionId: string, text: string): Promise<boolean> { this.injected.push(text); return true }
  async spawn(): Promise<any> { throw new Error("not used") }
  async isAlive(): Promise<boolean> { return true }
  async close(): Promise<void> {}
  async getCurrentSession(): Promise<null> { return null }
}

async function readSseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs = 500,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`SSE read timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

describe("Relay attachment delivery", () => {
  const servers: Server[] = []
  const apps: MeshServer[] = []
  const roots: string[] = []
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))))
    for (const app of apps.splice(0)) {
      try { app.store.close() } catch { /* already closed */ }
    }
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  async function start(
    materializeError?: string,
    limits: Record<string, unknown> = {},
    materializeImpl?: (manifest: ImageAttachmentManifest) => Promise<{ localPath?: string; error?: string }>,
  ) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccmesh-att-delivery-"))
    roots.push(root)
    const dbPath = path.join(root, "mesh.db")
    const terminal = new Terminal()
    const uploadCalls: Buffer[] = []
    const uploadTtls: number[] = []
    const materializeCalls: ImageAttachmentManifest[] = []
    const attachmentManager = {
      async upload(bytes: Buffer, mime: string, ttl: number): Promise<ImageAttachmentManifest> {
        assert.equal(mime, "image/png")
        uploadCalls.push(Buffer.from(bytes))
        uploadTtls.push(ttl)
        return manifest()
      },
      async materialize(m: ImageAttachmentManifest): Promise<{ localPath?: string; error?: string }> {
        materializeCalls.push(m)
        if (materializeImpl) return materializeImpl(m)
        return materializeError ? { error: materializeError } : { localPath: `/tmp/ccmesh-safe/${m.id}.png` }
      },
    }
    const events = new MeshEventBus()
    const app = createServer({
      dbPath, deviceId: "mini", terminal, attachmentManager, events,
      attachmentLimits: limits,
      attachmentNow: () => FIXED_NOW,
    } as any)
    apps.push(app)
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s))
    })
    servers.push(server)
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return { app, base, terminal, uploadCalls, uploadTtls, materializeCalls }
  }

  async function register(base: string, shortId: string, deliveryMode: "pull" | "inject") {
    const body: Record<string, unknown> = {
      shortId, pid: 123, role: "worker", description: "test", deliveryMode,
    }
    if (deliveryMode === "inject") body.sessionId = `sess-${shortId}`
    const r = await fetch(`${base}/api/register`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    })
    assert.equal(r.status, 200)
    return `mini:${shortId}`
  }

  it("POST /attachments 接收 raw bytes；/send 只把 manifest 写 meta，消息库不含图片正文", async () => {
    const ts = await start()
    const target = await register(ts.base, "cc-pull", "pull")
    const up = await fetch(`${ts.base}/api/attachments`, {
      method: "POST", headers: { "Content-Type": "image/png" }, body: PNG,
    })
    assert.equal(up.status, 201)
    const uploaded = (await up.json() as any).data.manifest
    assert.deepEqual(ts.uploadCalls, [PNG])
    const sent = await fetch(`${ts.base}/api/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Mesh-Node": "mini:cc-source" },
      body: JSON.stringify({ to: target, message: "正文必须保留", attachments: [uploaded] }),
    })
    assert.equal(sent.status, 200)
    const [row] = ts.app.store.getInbox(target)
    assert.equal(row.payload, "正文必须保留")
    assert.deepEqual((row.meta as any).attachments, [manifest()])
    const serialized = JSON.stringify(row)
    assert.equal(serialized.includes(PNG.toString("base64")), false)
    assert.equal(serialized.includes(PNG.toString("latin1")), false)
  })

  it("Relay 上传入口在调用 Hub 前执行字节、PNG MIME 与 TTL 上限", async () => {
    const ts = await start(undefined, { maxBytes: PNG.length, maxTtlSeconds: 60, defaultTtlSeconds: 30 })
    const cases: Array<{ body: Buffer; mime: string; ttl?: string; status: number }> = [
      { body: Buffer.concat([PNG, Buffer.from([0])]), mime: "image/png", status: 413 },
      { body: PNG, mime: "image/jpeg", status: 415 },
      { body: PNG, mime: "text/plain", status: 415 },
      { body: PNG, mime: "image/png", ttl: "0", status: 400 },
      { body: PNG, mime: "image/png", ttl: "1.5", status: 400 },
      { body: PNG, mime: "image/png", ttl: "61", status: 400 },
      { body: PNG, mime: "image/png", ttl: "NaN", status: 400 },
    ]
    for (const c of cases) {
      const headers: Record<string, string> = { "Content-Type": c.mime }
      if (c.ttl != null) headers["X-Attachment-Ttl"] = c.ttl
      const r = await fetch(`${ts.base}/api/attachments`, {
        method: "POST", headers, body: c.body as unknown as BodyInit,
      })
      assert.equal(r.status, c.status, JSON.stringify(c))
    }
    assert.equal(ts.uploadCalls.length, 0, "入口非法数据不得触发 Hub 上传")

    const ok = await fetch(`${ts.base}/api/attachments`, {
      method: "POST",
      headers: { "Content-Type": "image/png", "X-Attachment-Ttl": "60" },
      body: PNG,
    })
    assert.equal(ok.status, 201)
    assert.deepEqual(ts.uploadCalls, [PNG])
    assert.deepEqual(ts.uploadTtls, [60])
    assert.ok(MAX_IMAGE_BYTES >= PNG.length)
    assert.ok(MAX_IMAGE_TTL_SECONDS >= 60)
  })

  it("pull 离线不消费时消息保留；稍后 sync 得正文 + 派生 localPath，且不回写库", async () => {
    const ts = await start()
    const target = await register(ts.base, "cc-later", "pull")
    const m = manifest()
    await fetch(`${ts.base}/api/send`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Mesh-Node": "mini:cc-source" },
      body: JSON.stringify({ to: target, message: "later body", attachments: [m] }),
    })
    assert.equal(ts.app.store.getInbox(target).length, 1, "未 sync 前消息保留")
    const sync = await fetch(`${ts.base}/api/sync?nodeId=${encodeURIComponent(target)}&since=0&timeout=0`)
    const doc = await sync.json() as any
    assert.equal(doc.data.messages[0].payload, "later body")
    assert.equal(doc.data.messages[0].meta.attachments[0].localPath, `/tmp/ccmesh-safe/${m.id}.png`)
    assert.equal(ts.materializeCalls.length, 1)
    assert.equal((ts.app.store.getInbox(target)[0].meta as any).attachments[0].localPath, undefined, "派生路径不得持久化")
  })

  it("/api/sync 对客户端超大 limit 施加 100 条硬上限", async () => {
    const ts = await start()
    const target = await register(ts.base, "cc-bounded-sync", "pull")
    const total = EXPECTED_SYNC_MAX_LIMIT + 5
    for (let i = 0; i < total; i++) {
      const sha = i.toString(16).padStart(64, "0")
      const m: ImageAttachmentManifest = {
        ...manifest(), id: `att-${sha}`, sha256: sha, storageRef: `hub-blob:${sha}`,
      }
      ts.app.store.saveMessage({
        id: `bounded-${i}`, from: "computer2:cc-source", to: target, type: "chat",
        payload: `body-${i}`, createdAt: new Date(FIXED_NOW).toISOString(), meta: { attachments: [m] },
      }, "accepted")
    }

    const response = await fetch(
      `${ts.base}/api/sync?nodeId=${encodeURIComponent(target)}&since=0&timeout=0&limit=999999999`,
    )
    assert.equal(response.status, 200)
    const doc = await response.json() as any
    assert.equal(doc.data.messages.length, EXPECTED_SYNC_MAX_LIMIT, "MVP sync 单批硬上限锁为 100")
    assert.equal(ts.materializeCalls.length, EXPECTED_SYNC_MAX_LIMIT)
    assert.equal(doc.data.messages.every((msg: any) => msg.meta.attachments[0].localPath), true)
    assert.equal(ts.app.store.getInbox(target).length, total, "sync 限流不得删除未返回的消息")
  })

  it("/api/sync 多消息×多附件使用全局调度器，活动 materialize 不超过 4", async () => {
    let active = 0
    let maxActive = 0
    const ts = await start(undefined, {}, async (m) => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active--
      return { localPath: `/tmp/ccmesh-safe/${m.id}.png` }
    })
    const target = await register(ts.base, "cc-concurrency-sync", "pull")
    const messageCount = 6
    const attachmentsPerMessage = 4
    for (let i = 0; i < messageCount; i++) {
      const attachments = Array.from({ length: attachmentsPerMessage }, (_, j): ImageAttachmentManifest => {
        const sha = (1000 + i * attachmentsPerMessage + j).toString(16).padStart(64, "0")
        return { ...manifest(), id: `att-${sha}`, sha256: sha, storageRef: `hub-blob:${sha}` }
      })
      ts.app.store.saveMessage({
        id: `concurrent-${i}`, from: "computer2:cc-source", to: target, type: "chat",
        payload: `body-${i}`, createdAt: new Date(FIXED_NOW).toISOString(), meta: { attachments },
      }, "accepted")
    }

    const response = await fetch(
      `${ts.base}/api/sync?nodeId=${encodeURIComponent(target)}&since=0&timeout=0&limit=${messageCount}`,
    )
    assert.equal(response.status, 200)
    const doc = await response.json() as any
    assert.equal(doc.data.messages.length, messageCount)
    assert.equal(ts.materializeCalls.length, messageCount * attachmentsPerMessage)
    assert.equal(maxActive <= EXPECTED_MATERIALIZE_CONCURRENCY, true, `全局物化并发硬上限=4，实际=${maxActive}`)
    assert.equal(maxActive > 1, true, "实现应有界并行，而不是意外完全串行")
    assert.equal(doc.data.messages.every((msg: any) => (
      msg.meta.attachments.length === attachmentsPerMessage
      && msg.meta.attachments.every((item: any) => item.localPath)
    )), true)
  })

  it("下载失败时 pull 仍返回正文并标 attachment unavailable", async () => {
    const ts = await start("unavailable")
    const target = await register(ts.base, "cc-down", "pull")
    await fetch(`${ts.base}/api/send`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Mesh-Node": "mini:cc-source" },
      body: JSON.stringify({ to: target, message: "正文不丢", attachments: [manifest()] }),
    })
    const doc = await (await fetch(`${ts.base}/api/sync?nodeId=${encodeURIComponent(target)}&since=0&timeout=0`)).json() as any
    assert.equal(doc.data.messages[0].payload, "正文不丢")
    assert.equal(doc.data.messages[0].meta.attachments[0].localPath, undefined)
    assert.equal(doc.data.messages[0].meta.attachments[0].error, "unavailable")
  })

  it("SSE 只发门铃摘要，不包含 payload、manifest、localPath 或图片字节", async () => {
    const ts = await start()
    const target = await register(ts.base, "cc-sse", "pull")
    const abort = new AbortController()
    const sse = await fetch(`${ts.base}/api/events`, { signal: abort.signal })
    assert.match(sse.headers.get("content-type") ?? "", /text\/event-stream/)
    const reader = sse.body!.getReader()
    try {
      await readSseChunk(reader) // : connected
      const body = "SSE_SECRET_BODY"
      const sent = await fetch(`${ts.base}/api/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Mesh-Node": "mini:cc-source" },
        body: JSON.stringify({ to: target, message: body, attachments: [manifest()] }),
      })
      assert.equal(sent.status, 200)

      let wire = ""
      const deadline = Date.now() + 1_000
      while (!wire.includes("msg:send") && Date.now() < deadline) {
        const next = await readSseChunk(reader, Math.max(1, deadline - Date.now()))
        if (next.done) break
        wire += Buffer.from(next.value).toString("utf8")
      }
      assert.match(wire, /msg:send/)
      for (const forbidden of [body, SHA, "hub-blob:", "localPath", PNG.toString("base64"), PNG.toString("latin1")]) {
        assert.equal(wire.includes(forbidden), false, `SSE 不得含 ${forbidden.slice(0, 24)}`)
      }
    } finally {
      abort.abort()
      await reader.cancel().catch(() => undefined)
    }
  })

  it("/send 在落库前拒绝伪造 URL/path manifest 与超图片数", async () => {
    const ts = await start()
    const target = await register(ts.base, "cc-guard", "pull")
    const forged = { ...manifest(), storageRef: "https://evil.invalid/p.png" }
    for (const attachments of [[forged], Array.from({ length: 5 }, () => manifest())]) {
      const r = await fetch(`${ts.base}/api/send`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Mesh-Node": "mini:cc-source" },
        body: JSON.stringify({ to: target, message: "must not store", attachments }),
      })
      assert.equal(r.status, 400)
    }
    assert.equal(ts.app.store.getInbox(target).length, 0)
    assert.equal(ts.materializeCalls.length, 0)
  })

  it("inject 附件成功/失败都保留旧正文格式，并附加路径或 unavailable 提示", async () => {
    for (const error of [undefined, "integrity"] as const) {
      const ts = await start(error)
      const target = await register(ts.base, `cc-inject-${error ?? "ok"}`, "inject")
      const incoming: MeshMessage = {
        id: `msg-${error ?? "ok"}`, from: "computer2:cc-source", to: target, type: "chat",
        payload: "hello", createdAt: new Date().toISOString(), meta: { attachments: [manifest()] },
      }
      const result = await ts.app.deliverDownlink(incoming)
      assert.equal(result.delivered, true)
      assert.match(ts.terminal.injected[0]!, /^\[mesh:computer2:cc-source\] hello/)
      if (error) assert.match(ts.terminal.injected[0]!, /attachment.*unavailable/i)
      else assert.match(ts.terminal.injected[0]!, /\/tmp\/ccmesh-safe\/att-/)
    }
  })

  it("本机 POST /send→inject 在附件成功/失败时都注入正文并返回 delivered", async () => {
    for (const error of [undefined, "integrity"] as const) {
      const ts = await start(error)
      const target = await register(ts.base, `cc-local-${error ?? "ok"}`, "inject")
      const response = await fetch(`${ts.base}/api/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Mesh-Node": "mini:cc-source" },
        body: JSON.stringify({ to: target, message: "local body", attachments: [manifest()] }),
      })
      assert.equal(response.status, 200)
      const doc = await response.json() as any
      assert.deepEqual(Object.keys(doc).sort(), ["data", "ok"])
      assert.equal(doc.ok, true)
      assert.deepEqual(Object.keys(doc.data).sort(), ["msgId", "status"])
      assert.match(doc.data.msgId, /^msg-/)
      assert.equal(doc.data.status, "delivered")
      assert.equal(ts.terminal.injected.length, 1)
      assert.match(ts.terminal.injected[0]!, /^\[mesh:mini:cc-source\] local body/)
      if (error) assert.match(ts.terminal.injected[0]!, /attachment.*unavailable/i)
      else assert.match(ts.terminal.injected[0]!, /\/tmp\/ccmesh-safe\/att-/)
      const [stored] = ts.app.store.getInbox(target)
      assert.deepEqual((stored.meta as any).attachments, [manifest()])
      assert.equal(JSON.stringify(stored).includes("localPath"), false)
      assert.equal(JSON.stringify(stored).includes("unavailable"), false)
    }
  })

  it("无附件旧客户端 send/sync 与 inject 保持精确 shape，且无图片外发钩子", async () => {
    const ts = await start()
    const target = await register(ts.base, "cc-old", "pull")
    const legacySend = await fetch(`${ts.base}/api/send`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Mesh-Node": "mini:cc-source" },
      body: JSON.stringify({ to: target, message: "legacy" }),
    })
    assert.equal(legacySend.status, 200)
    const legacySendDoc = await legacySend.json() as any
    assert.deepEqual(Object.keys(legacySendDoc).sort(), ["data", "ok"])
    assert.equal(legacySendDoc.ok, true)
    assert.deepEqual(Object.keys(legacySendDoc.data).sort(), ["msgId", "status"])
    assert.match(legacySendDoc.data.msgId, /^msg-/)
    assert.equal(legacySendDoc.data.status, "accepted")
    const doc = await (await fetch(`${ts.base}/api/sync?nodeId=${encodeURIComponent(target)}&since=0&timeout=0`)).json() as any
    assert.equal(doc.data.messages[0].payload, "legacy")
    assert.equal(Object.hasOwn(doc.data.messages[0], "meta"), false)
    assert.deepEqual(Object.keys(doc.data.messages[0]).sort(), [
      "createdAt", "from", "id", "payload", "priority", "seq", "to", "type",
    ])
    assert.equal(ts.materializeCalls.length, 0)

    const injectTarget = await register(ts.base, "cc-old-inject", "inject")
    const oldWire: MeshMessage = {
      id: "legacy-wire", from: "computer2:legacy", to: injectTarget, type: "chat",
      payload: "legacy inject", createdAt: "2026-08-28T12:00:00.000Z",
    }
    const result = await ts.app.deliverDownlink(oldWire)
    assert.deepEqual(result, { delivered: true })
    assert.equal(ts.terminal.injected.at(-1), "[mesh:computer2:legacy] legacy inject")
    assert.equal(ts.materializeCalls.length, 0, "无附件不得触发图片下载或 cc2wechat 外发")
  })
})
