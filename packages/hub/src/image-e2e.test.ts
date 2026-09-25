/**
 * 图片附件真链路红测：真实 Hub WS + Hub Blob HTTP + 两个真实 Relay HTTP/Uplink。
 * 全部只绑定 127.0.0.1:0，使用生成的 1x1 PNG 与临时 DB/cache。
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import { createHub, type HubInstance } from "./hub.js"
import { TokenAuth } from "./auth.js"
import { createServer, type MeshServer } from "@cc-mesh/relay/dist/server.js"
import { AttachmentManager } from "@cc-mesh/relay/dist/attachments.js"
import { WebSocketUplink } from "@cc-mesh/relay/dist/uplink/websocket.js"
import { CompositeTransport } from "@cc-mesh/relay/dist/transport/composite.js"
import { MeshEventBus } from "@cc-mesh/relay/dist/events.js"
import { wireRelayUplink } from "@cc-mesh/relay/dist/runtime.js"
import type { ITerminal } from "@cc-mesh/relay/dist/terminal/interface.js"

const TOKEN = "image-e2e-token"
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
)

class NoopTerminal implements ITerminal {
  async inject(): Promise<boolean> { return true }
  async spawn(): Promise<any> { throw new Error("not used") }
  async isAlive(): Promise<boolean> { return true }
  async close(): Promise<void> {}
  async getCurrentSession(): Promise<null> { return null }
}

async function listen(app: MeshServer): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server))
  })
}

function base(server: Server): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
  assert.equal(predicate(), true, message)
}

describe("image attachment two-relay E2E", () => {
  it("通过真实 WS 路由 manifest，并由目标 Relay 安全物化 PNG", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccmesh-image-e2e-"))
    let hub: HubInstance | undefined
    let senderApp: MeshServer | undefined
    let receiverApp: MeshServer | undefined
    let senderHttp: Server | undefined
    let receiverHttp: Server | undefined
    let senderUplink: WebSocketUplink | undefined
    let receiverUplink: WebSocketUplink | undefined
    try {
      hub = await createHub({
        port: 0,
        auth: new TokenAuth(TOKEN),
        ledger: { dbPath: path.join(root, "ledger.db"), token: TOKEN, httpPort: 0, quiet: true },
        attachments: {
          rootDir: path.join(root, "hub-blobs"),
          maxBytes: 1024, quotaBytes: 4096, maxPixels: 100, defaultTtlSeconds: 60,
        },
      })
      assert.ok(hub.attachments)
      assert.equal(hub.attachments.httpPort, hub.ledger?.httpPort, "附件与 Ledger 必须共用 HTTP server")
      const hubHttpBase = `http://127.0.0.1:${hub.attachments.httpPort}`
      const hubUrl = `ws://127.0.0.1:${hub.port}`

      let senderRef: MeshServer
      let receiverRef: MeshServer
      senderUplink = new WebSocketUplink({
        hubUrl, token: TOKEN, reconnectMs: 20, ackTimeoutMs: 1_000,
        getRegistration: () => ({
          relayId: "relay-computer2", deviceId: "computer2", connectedAt: new Date().toISOString(),
          nodes: senderRef.registry.getAll().map((n) => n.identity),
        }),
      })
      receiverUplink = new WebSocketUplink({
        hubUrl, token: TOKEN, reconnectMs: 20, ackTimeoutMs: 1_000,
        getRegistration: () => ({
          relayId: "relay-mini", deviceId: "mini", connectedAt: new Date().toISOString(),
          nodes: receiverRef.registry.getAll().map((n) => n.identity),
        }),
      })

      const senderCache = path.join(root, "sender-cache")
      const receiverCache = path.join(root, "receiver-cache")
      const senderManager = new AttachmentManager({
        hubHttpBase, token: TOKEN, cacheDir: senderCache, fetchImpl: fetch, maxRetries: 1,
      })
      const receiverManager = new AttachmentManager({
        hubHttpBase, token: TOKEN, cacheDir: receiverCache, fetchImpl: fetch, maxRetries: 1,
      })
      const senderEvents = new MeshEventBus()
      const receiverEvents = new MeshEventBus()
      const commandCalls: Array<{ file: string; args: readonly string[] }> = []
      const commandRunner = async (file: string, args: readonly string[] = []): Promise<{ code: number }> => {
        commandCalls.push({ file, args: [...args] })
        throw new Error(`E2E forbids external command execution: ${file}`)
      }
      senderApp = senderRef = createServer({
        dbPath: path.join(root, "sender.db"), deviceId: "computer2", terminal: new NoopTerminal(),
        transport: new CompositeTransport(new NoopTerminal(), senderUplink, { deviceId: "computer2" }),
        uplink: senderUplink, events: senderEvents, attachmentManager: senderManager, commandRunner,
      } as any)
      receiverApp = receiverRef = createServer({
        dbPath: path.join(root, "receiver.db"), deviceId: "mini", terminal: new NoopTerminal(),
        transport: new CompositeTransport(new NoopTerminal(), receiverUplink, { deviceId: "mini" }),
        uplink: receiverUplink, events: receiverEvents, attachmentManager: receiverManager, commandRunner,
      } as any)

      // 与生产 index.ts 共用的接线函数；禁止测试复制一份 onMessage 手工接线。
      wireRelayUplink({ app: senderApp, uplink: senderUplink })
      wireRelayUplink({ app: receiverApp, uplink: receiverUplink })
      await Promise.all([senderUplink.connect(), receiverUplink.connect()])
      senderHttp = await listen(senderApp)
      receiverHttp = await listen(receiverApp)

      const register = async (origin: string, shortId: string): Promise<string> => {
        const r = await fetch(`${origin}/api/register`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shortId, pid: 123, role: "worker", description: "e2e", deliveryMode: "pull" }),
        })
        assert.equal(r.status, 200)
        return (await r.json() as any).data.nodeId
      }
      const source = await register(base(senderHttp), "cc-source")
      const target = await register(base(receiverHttp), "cc-target")
      await waitFor(() => hub!.getNodeLocation(source) === "relay-computer2", "Hub 未登记发送 Relay")
      await waitFor(() => hub!.getNodeLocation(target) === "relay-mini", "Hub 未登记接收 Relay")

      const up = await fetch(`${base(senderHttp)}/api/attachments`, {
        method: "POST", headers: { "Content-Type": "image/png", "X-Attachment-Ttl": "60" }, body: PNG,
      })
      assert.equal(up.status, 201)
      const manifest = (await up.json() as any).data.manifest
      const sent = await fetch(`${base(senderHttp)}/api/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Mesh-Node": source },
        body: JSON.stringify({ to: target, message: "generated test PNG", attachments: [manifest] }),
      })
      assert.equal(sent.status, 200)
      await waitFor(() => receiverApp!.store.getInbox(target).length === 1, "跨 WS downlink 未落接收 Relay")

      const sync = await fetch(`${base(receiverHttp)}/api/sync?nodeId=${encodeURIComponent(target)}&since=0&timeout=0`)
      const doc = await sync.json() as any
      assert.equal(doc.data.messages[0].payload, "generated test PNG")
      const delivered = doc.data.messages[0].meta.attachments[0]
      assert.equal(delivered.error, undefined)
      assert.ok(delivered.localPath)
      assert.equal(fs.realpathSync(delivered.localPath).startsWith(fs.realpathSync(receiverCache) + path.sep), true)
      assert.deepEqual(fs.readFileSync(delivered.localPath), PNG)
      assert.equal(delivered.localPath.startsWith(senderCache), false)
      assert.deepEqual(
        commandCalls,
        [],
        "图片成功链只返回安全 localPath，不得自动执行 cc2wechat 或任何外部命令",
      )

      // 旧客户端不发送 X-Mesh-Node：Relay 必须改用 Hub 已授权的设备系统身份，
      // 不能继续把 "unknown" 送上 WS（Hub 会正确拒绝伪造 sender）。
      const legacySent = await fetch(`${base(senderHttp)}/api/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: target, message: "legacy text without sender header" }),
      })
      assert.equal(legacySent.status, 200)
      const legacySentDoc = await legacySent.json() as any
      assert.deepEqual(Object.keys(legacySentDoc).sort(), ["data", "ok"])
      assert.equal(legacySentDoc.ok, true)
      assert.deepEqual(Object.keys(legacySentDoc.data).sort(), ["msgId", "status"])
      assert.match(legacySentDoc.data.msgId, /^msg-/)
      assert.equal(legacySentDoc.data.status, "delivered")
      await waitFor(() => receiverApp!.store.getInbox(target).length === 2, "旧客户端纯文本未跨 Relay 到达")

      const legacySync = await fetch(
        `${base(receiverHttp)}/api/sync?nodeId=${encodeURIComponent(target)}&since=${doc.data.nextSince}&timeout=0`,
      )
      const legacySyncDoc = await legacySync.json() as any
      assert.equal(legacySyncDoc.data.messages.length, 1)
      const legacyWire = legacySyncDoc.data.messages[0]
      assert.deepEqual(Object.keys(legacyWire).sort(), [
        "createdAt", "from", "id", "payload", "priority", "seq", "to", "type",
      ])
      assert.equal(legacyWire.from, "computer2:relay", "无 header 只能降级到本 Relay 的安全系统身份")
      assert.equal(legacyWire.to, target)
      assert.equal(legacyWire.type, "chat")
      assert.equal(legacyWire.payload, "legacy text without sender header")
      assert.equal(Object.hasOwn(legacyWire, "meta"), false)
      assert.deepEqual(commandCalls, [], "旧纯文本兼容链也不得执行外部命令")

      const senderRaw = Buffer.concat([
        fs.readFileSync(path.join(root, "sender.db")),
        fs.existsSync(path.join(root, "sender.db-wal")) ? fs.readFileSync(path.join(root, "sender.db-wal")) : Buffer.alloc(0),
      ])
      assert.equal(senderRaw.indexOf(PNG), -1, "发送 Relay DB/WAL 不得出现 PNG 正文")
    } finally {
      await Promise.all([closeServer(senderHttp), closeServer(receiverHttp)])
      await Promise.all([
        senderUplink?.disconnect() ?? Promise.resolve(),
        receiverUplink?.disconnect() ?? Promise.resolve(),
      ])
      try { senderApp?.store.close() } catch { /* already closed */ }
      try { receiverApp?.store.close() } catch { /* already closed */ }
      if (hub) await hub.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

/** Real Hub (WS + Blob HTTP) and two real Relays, as in the PNG case above; only the image type differs. */
async function twoRelays(root: string) {
  const hub = await createHub({
    port: 0, auth: new TokenAuth(TOKEN),
    ledger: { dbPath: path.join(root, "ledger.db"), token: TOKEN, httpPort: 0, quiet: true },
    attachments: { rootDir: path.join(root, "hub-blobs"), maxBytes: 4096, quotaBytes: 65536, maxPixels: 10_000, defaultTtlSeconds: 60 },
  })
  const hubHttpBase = `http://127.0.0.1:${hub.attachments!.httpPort}`
  const hubUrl = `ws://127.0.0.1:${hub.port}`
  const side = async (deviceId: string) => {
    let ref: MeshServer
    const uplink = new WebSocketUplink({
      hubUrl, token: TOKEN, reconnectMs: 20, ackTimeoutMs: 1_000,
      getRegistration: () => ({ relayId: `relay-${deviceId}`, deviceId, connectedAt: new Date().toISOString(), nodes: ref.registry.getAll().map((n) => n.identity) }),
    })
    const cache = path.join(root, `${deviceId}-cache`)
    const app = ref = createServer({
      dbPath: path.join(root, `${deviceId}.db`), deviceId, terminal: new NoopTerminal(),
      transport: new CompositeTransport(new NoopTerminal(), uplink, { deviceId }), uplink, events: new MeshEventBus(),
      attachmentManager: new AttachmentManager({ hubHttpBase, token: TOKEN, cacheDir: cache, fetchImpl: fetch, maxRetries: 1 }),
      commandRunner: async (file: string) => { throw new Error(`E2E forbids external command execution: ${file}`) },
    } as any)
    wireRelayUplink({ app, uplink })
    await uplink.connect()
    const http = await listen(app)
    const r = await fetch(`${base(http)}/api/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shortId: `cc-${deviceId}`, pid: 123, role: "worker", description: "e2e", deliveryMode: "pull" }),
    })
    const nodeId = (await r.json() as any).data.nodeId as string
    return { app, uplink, http, cache, nodeId, origin: base(http) }
  }
  const sender = await side("computer2")
  const receiver = await side("mini")
  await waitFor(() => hub.getNodeLocation(sender.nodeId) === "relay-computer2" && hub.getNodeLocation(receiver.nodeId) === "relay-mini", "Hub 未登记两端 Relay")
  const close = async () => {
    await Promise.all([closeServer(sender.http), closeServer(receiver.http)])
    await Promise.all([sender.uplink.disconnect(), receiver.uplink.disconnect()])
    for (const app of [sender.app, receiver.app]) { try { app.store.close() } catch { /* closed */ } }
    await hub.close()
  }
  return { hub, sender, receiver, close }
}

describe("image attachment two-relay E2E: whitelisted formats keep their original bytes", () => {
  it("JPEG 与 WebP 经真实 Hub/双 Relay 转发：接收端字节与 SHA-256 和原图一致，扩展名随真实类型", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccmesh-image-e2e-jpeg-"))
    const net = await twoRelays(root)
    try {
      const jpeg = Buffer.concat([Buffer.from("ffd8ffe000104a46494600010100000100010000", "hex"),
        Buffer.from([0xff, 0xc0, 0, 17, 8, 0, 30, 0, 40, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]), Buffer.from("0102030405060708", "hex"), Buffer.from("ffd9", "hex")])
      const webp = Buffer.alloc(40); webp.write("RIFF", 0); webp.writeUInt32LE(32, 4); webp.write("WEBPVP8X", 8); webp.writeUIntLE(63, 24, 3); webp.writeUIntLE(31, 27, 3)
      let since = 0
      for (const [bytes, mime, ext] of [[jpeg, "image/jpeg", "jpg"], [webp, "image/webp", "webp"]] as const) {
        const up = await fetch(`${net.sender.origin}/api/attachments`, { method: "POST", headers: { "Content-Type": mime }, body: bytes as unknown as BodyInit })
        assert.equal(up.status, 201, mime)
        const manifest = (await up.json() as any).data.manifest
        assert.equal(manifest.mime, mime)
        const sent = await fetch(`${net.sender.origin}/api/send`, {
          method: "POST", headers: { "Content-Type": "application/json", "X-Mesh-Node": net.sender.nodeId },
          body: JSON.stringify({ to: net.receiver.nodeId, message: `original ${ext}`, attachments: [manifest] }),
        })
        assert.equal(sent.status, 200)
        await waitFor(() => net.receiver.app.store.getInbox(net.receiver.nodeId).length > (ext === "jpg" ? 0 : 1), `${ext} 未跨 Relay 到达`)
        const doc = await (await fetch(`${net.receiver.origin}/api/sync?nodeId=${encodeURIComponent(net.receiver.nodeId)}&since=${since}&timeout=0`)).json() as any
        since = doc.data.nextSince
        const delivered = doc.data.messages.at(-1).meta.attachments[0]
        assert.equal(delivered.error, undefined)
        assert.equal(delivered.mime, mime)
        assert.ok(delivered.localPath.endsWith(`.${ext}`))
        assert.equal(fs.realpathSync(delivered.localPath).startsWith(fs.realpathSync(net.receiver.cache) + path.sep), true)
        const received = fs.readFileSync(delivered.localPath)
        assert.deepEqual(received, bytes, "接收端逐字节等于原图")
        assert.equal(createHash("sha256").update(received).digest("hex"), manifest.sha256)
      }
    } finally {
      await net.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
