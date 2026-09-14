// 假 relay：单测用的 node:http 服务器，只实现席位真正打的那几个口。
// 语义**照抄** packages/relay/src/server.ts：
//   - POST /api/register        → { ok, data:{ nodeId: "<deviceId>:<shortId>" } }
//   - GET  /api/sync            → since 显式且 > 游标才 ack；返回 seq>since 的批；无消息则停车到 timeout
//   - POST /api/send            → from 取 X-Mesh-Node 头，缺省 "<deviceId>:relay"
//   - DELETE /api/register/:id  → 404 if unknown
//   - GET  /api/status          → { ok, data:{ nodes:[{identity,…}], deviceId } }
// 可注入：延迟、指定路径返回错误码、直接断连（测退避）。

import http from "node:http"
import type { AddressInfo } from "node:net"
import type { MeshMessage } from "@cc-mesh/protocol"

export interface FakeRelayNode {
  nodeId: string
  shortId: string
  role: string
  description: string
  deliveryMode: string
  pid: number
  lastSyncAt: string | null
}

export interface FakeRelaySyncRecord {
  nodeId: string
  since: number | null
  timeoutSec: number
  limit: number
  at: number
}

export interface FakeRelaySendRecord {
  msgId: string
  from: string
  to: string
  message: string
  type: string
  replyTo?: string
  at: number
}

export class FakeRelay {
  readonly nodes = new Map<string, FakeRelayNode>()
  readonly inbox = new Map<string, MeshMessage[]>()
  readonly cursors = new Map<string, number>()
  readonly syncs: FakeRelaySyncRecord[] = []
  readonly sends: FakeRelaySendRecord[] = []
  readonly registers: Array<Record<string, unknown>> = []
  /** 注入：对某个路径前缀返回该状态码 */
  failWith: { pathPrefix: string; status: number; body?: string } | null = null
  /** 注入：收到请求直接断连（模拟 relay 挂了） */
  hangUp = false
  latencyMs = 0

  private seq = 0
  private server!: http.Server
  private constructor(readonly deviceId: string) {}

  static async start(deviceId = "e2edev"): Promise<FakeRelay> {
    const relay = new FakeRelay(deviceId)
    relay.server = http.createServer((req, res) => { void relay.handle(req, res) })
    await new Promise<void>((resolve) => relay.server.listen(0, "127.0.0.1", resolve))
    return relay
  }

  get port(): number { return (this.server.address() as AddressInfo).port }
  get url(): string { return `http://127.0.0.1:${this.port}` }

  /**
   * 把一条消息塞进某节点的收件箱（等价于别人给它 send）。返回 msgId。
   *
   * `createdAt` 可显式指定：年龄闸（防线 2）判的就是它，测「出生前的历史消息」时必须能造老时间戳。
   * 真 relay 的 createdAt 由入库时刻决定，测试里只能自己埋。
   */
  deliver(to: string, from: string, payload: string, type = "chat", replyTo?: string, id?: string, createdAt?: string): string {
    this.seq++
    const msg: MeshMessage = {
      id: id ?? `msg-${Date.now()}-${this.seq}`,
      from,
      to,
      type: type as MeshMessage["type"],
      payload,
      ...(replyTo ? { replyTo } : {}),
      createdAt: createdAt ?? new Date().toISOString(),
      seq: this.seq,
    }
    const box = this.inbox.get(to) ?? []
    box.push(msg)
    this.inbox.set(to, box)
    return msg.id
  }

  receiptsTo(nodeId: string): FakeRelaySendRecord[] {
    return this.sends.filter((s) => s.to === nodeId)
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.server.closeAllConnections?.()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  private stopping = false

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (this.hangUp) { req.socket.destroy(); return }
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs))
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`)
    if (this.failWith && url.pathname.startsWith(this.failWith.pathPrefix)) {
      res.writeHead(this.failWith.status, { "content-type": "application/json" })
      res.end(this.failWith.body ?? JSON.stringify({ ok: false, error: "injected failure" }))
      return
    }
    const body = await readBody(req)

    if (req.method === "POST" && url.pathname === "/api/register") {
      const b = JSON.parse(body || "{}") as Record<string, unknown>
      this.registers.push(b)
      const shortId = String(b.shortId ?? "")
      const nodeId = `${this.deviceId}:${shortId}`
      this.nodes.set(nodeId, {
        nodeId,
        shortId,
        role: String(b.role ?? "worker"),
        description: String(b.description ?? ""),
        deliveryMode: String(b.deliveryMode ?? "inject"),
        pid: Number(b.pid ?? 0),
        lastSyncAt: null,
      })
      return json(res, 200, { ok: true, data: { nodeId } })
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/register/")) {
      const nodeId = decodeURIComponent(url.pathname.slice("/api/register/".length))
      if (!this.nodes.has(nodeId)) return json(res, 404, { ok: false, error: "node not found" })
      this.nodes.delete(nodeId)
      return json(res, 200, { ok: true })
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      const nodes = [...this.nodes.values()].map((n) => ({
        identity: {
          nodeId: n.nodeId, deviceId: this.deviceId, shortId: n.shortId,
          role: n.role, description: n.description, capabilities: [], deliveryMode: n.deliveryMode,
        },
        sessionId: `nopane-${n.nodeId}`,
        pid: n.pid,
        lastSeen: new Date().toISOString(),
        status: "idle",
        lastSyncAt: n.lastSyncAt,
      }))
      return json(res, 200, { ok: true, data: { nodes, deviceId: this.deviceId, uplink: null } })
    }

    if (req.method === "POST" && url.pathname === "/api/send") {
      const b = JSON.parse(body || "{}") as Record<string, unknown>
      const from = (req.headers["x-mesh-node"] as string | undefined) ?? `${this.deviceId}:relay`
      const to = String(b.to ?? "")
      if (!to || b.message == null) return json(res, 400, { ok: false, error: "missing to/message" })
      const msgId = this.deliver(to, from, String(b.message), String(b.type ?? "chat"), b.replyTo as string | undefined)
      this.sends.push({
        msgId, from, to,
        message: String(b.message),
        type: String(b.type ?? "chat"),
        ...(b.replyTo ? { replyTo: String(b.replyTo) } : {}),
        at: Date.now(),
      })
      return json(res, 200, { ok: true, data: { msgId, status: to.startsWith("@") ? "delivered" : "accepted" } })
    }

    if (req.method === "GET" && url.pathname === "/api/sync") {
      const nodeId = url.searchParams.get("nodeId")
      if (!nodeId) return json(res, 400, { ok: false, error: "missing nodeId" })
      if (!this.nodes.has(nodeId)) return json(res, 404, { ok: false, error: "node not registered" })
      const node = this.nodes.get(nodeId)!
      node.lastSyncAt = new Date().toISOString()

      const sinceRaw = url.searchParams.get("since")
      const cursor = this.cursors.get(nodeId) ?? 0
      let since = cursor
      if (sinceRaw != null && sinceRaw !== "" && !Number.isNaN(Number(sinceRaw))) {
        since = Number(sinceRaw)
        if (since > cursor) this.cursors.set(nodeId, since)
      }
      const timeoutSec = Math.max(0, Math.min(55, Number(url.searchParams.get("timeout") ?? 55)))
      const limit = Math.max(1, Number(url.searchParams.get("limit") ?? 100))
      this.syncs.push({ nodeId, since: sinceRaw == null ? null : Number(sinceRaw), timeoutSec, limit, at: Date.now() })

      const startedAt = Date.now()
      const pick = (): MeshMessage[] =>
        (this.inbox.get(nodeId) ?? []).filter((m) => (m.seq ?? 0) > since).slice(0, limit)

      // 客户端断连（abort / 进程被 kill）必须立刻结束停车，否则 server.close() 会一直等它。
      let clientGone = false
      res.on("close", () => { clientGone = true })
      req.on("aborted", () => { clientGone = true })

      let messages = pick()
      const deadline = startedAt + timeoutSec * 1000
      while (messages.length === 0 && Date.now() < deadline && !clientGone && !this.stopping) {
        await new Promise((r) => setTimeout(r, 20))
        messages = pick()
      }
      if (clientGone) { res.destroy(); return }
      const maxSeq = messages.reduce((m, x) => Math.max(m, x.seq ?? 0), since)
      return json(res, 200, {
        ok: true,
        data: { messages, nextSince: Math.max(maxSeq, since), parkedMs: Date.now() - startedAt },
      })
    }

    return json(res, 404, { ok: false, error: "not found" })
  }
}

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  const s = JSON.stringify(payload)
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s) })
  res.end(s)
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}
