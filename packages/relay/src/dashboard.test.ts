/**
 * Dashboard HTTP 端点 + SSE + ttyd 控制端点测试
 * TDD: 端点尚未实现
 */
import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "./server.js"
import { MeshEventBus } from "./events.js"
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import type { ITerminal, SpawnResult } from "./terminal/interface.js"
import os from "node:os"
import path from "node:path"
import fs from "node:fs"

class MockTerminal implements ITerminal {
  async inject() { return true }
  async spawn(_cmd: string): Promise<SpawnResult> { return { sessionId: "s", windowId: "w" } }
  async isAlive() { return true }
  async close() {}
  async getCurrentSession() { return null }
}

class MockTtyd {
  started: string[] = []
  stopped: string[] = []
  ports = new Map<string, number>()
  private counter = 0
  async start(sessionId: string): Promise<number> {
    const existing = this.ports.get(sessionId)
    if (existing != null) return existing
    this.counter++
    this.started.push(sessionId)
    const port = 7681 + this.counter
    this.ports.set(sessionId, port)
    return port
  }
  async stop(sessionId: string): Promise<void> {
    this.stopped.push(sessionId)
    this.ports.delete(sessionId)
  }
  getPort(sessionId: string): number | null {
    return this.ports.get(sessionId) ?? null
  }
  async shutdown(): Promise<void> { this.ports.clear() }
}

let server: Server
let baseUrl: string
let dbPath: string
let bus: MeshEventBus
let ttyd: MockTtyd

async function call(method: string, p: string, body?: unknown, headers?: Record<string, string>) {
  const opts: RequestInit = { method, headers: { "Content-Type": "application/json", ...headers } }
  if (body) opts.body = JSON.stringify(body)
  const res = await fetch(`${baseUrl}${p}`, opts)
  return res
}

describe("Dashboard — HTML + SSE + ttyd 控制端点", () => {
  before(async () => {
    dbPath = path.join(os.tmpdir(), `mesh-dash-test-${Date.now()}.db`)
    bus = new MeshEventBus()
    ttyd = new MockTtyd()
    const app = createServer({
      dbPath,
      deviceId: "macbook",
      terminal: new MockTerminal(),
      events: bus,
      ttyd: ttyd as any,
    } as any)
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s))
    })
    const addr = server.address() as AddressInfo
    baseUrl = `http://localhost:${addr.port}`
  })

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    try { fs.unlinkSync(dbPath) } catch {}
    try { fs.unlinkSync(dbPath + "-wal") } catch {}
    try { fs.unlinkSync(dbPath + "-shm") } catch {}
  })

  it("GET /dashboard 返回 200 + HTML", async () => {
    const res = await call("GET", "/dashboard")
    assert.equal(res.status, 200)
    const ct = res.headers.get("content-type") ?? ""
    assert.ok(ct.includes("text/html"), `content-type should be html, got ${ct}`)
    const body = await res.text()
    assert.ok(body.includes("<html") || body.includes("<!DOCTYPE"), "body should contain HTML")
  })

  it("GET /api/events 返回 200 + content-type: text/event-stream，推送 node:register 载荷", async () => {
    const ctrl = new AbortController()
    const res = await fetch(`${baseUrl}/api/events`, { signal: ctrl.signal })
    assert.equal(res.status, 200)
    const ct = res.headers.get("content-type") ?? ""
    assert.ok(ct.includes("text/event-stream"), `content-type: ${ct}`)
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()

    async function readWithin(ms: number): Promise<string> {
      const { value } = await Promise.race([
        reader.read(),
        new Promise<{ value: Uint8Array | undefined }>((resolve) =>
          setTimeout(() => resolve({ value: undefined }), ms)
        ),
      ])
      if (!value) throw new Error(`no SSE chunk within ${ms}ms`)
      return decoder.decode(value)
    }

    // 给 SSE 端点一点时间注册监听器
    await new Promise((r) => setTimeout(r, 50))
    bus.emit("node:register", { node: { identity: { nodeId: "macbook:cc-evt-test" } } as any })

    // 读到包含 data: 载荷为止，最多读 3 次（可能前面是 heartbeat :comment）
    let buf = ""
    for (let i = 0; i < 3 && !buf.includes("node:register"); i++) {
      buf += await readWithin(1000)
    }
    assert.ok(buf.includes("data:"), `期望 data: 帧，实际 ${buf.slice(0, 80)}`)
    assert.ok(buf.includes("node:register"), `期望载荷含事件名，实际 ${buf.slice(0, 120)}`)
    assert.ok(buf.includes("macbook:cc-evt-test"), "期望载荷含 nodeId")

    ctrl.abort()
    try { await reader.cancel() } catch {}
  })

  it("POST /api/terminal/ttyd/:sessionId 返回 port", async () => {
    const res = await call("POST", "/api/terminal/ttyd/cc-mesh-main")
    assert.equal(res.status, 200)
    const data = await res.json() as any
    assert.equal(data.ok, true)
    assert.equal(typeof data.data.port, "number")
    assert.ok(ttyd.started.includes("cc-mesh-main"))
  })

  it("POST /api/terminal/ttyd/:sessionId 重复返回相同 port（mock 幂等）", async () => {
    const r1 = await (await call("POST", "/api/terminal/ttyd/cc-idem")).json() as any
    const r2 = await (await call("POST", "/api/terminal/ttyd/cc-idem")).json() as any
    assert.equal(r1.data.port, r2.data.port)
  })

  it("DELETE /api/terminal/ttyd/:sessionId 返回 ok 且 getPort 变 null", async () => {
    await call("POST", "/api/terminal/ttyd/cc-to-stop")
    assert.ok(ttyd.getPort("cc-to-stop") != null)
    const res = await call("DELETE", "/api/terminal/ttyd/cc-to-stop")
    assert.equal(res.status, 200)
    const data = await res.json() as any
    assert.equal(data.ok, true)
    assert.ok(ttyd.stopped.includes("cc-to-stop"))
    assert.equal(ttyd.getPort("cc-to-stop"), null)
  })
})

describe("Dashboard — 未配置 events/ttyd 时端点应拒绝", () => {
  let s2: Server
  let url2: string
  let db2: string

  before(async () => {
    db2 = path.join(os.tmpdir(), `mesh-dash-off-test-${Date.now()}.db`)
    const app = createServer({
      dbPath: db2,
      deviceId: "macbook",
      terminal: new MockTerminal(),
      // 不传 events、不传 ttyd
    } as any)
    s2 = await new Promise<Server>((resolve) => {
      const x = app.listen(0, () => resolve(x))
    })
    const addr = s2.address() as AddressInfo
    url2 = `http://localhost:${addr.port}`
  })

  after(async () => {
    await new Promise<void>((resolve) => s2.close(() => resolve()))
    try { fs.unlinkSync(db2) } catch {}
    try { fs.unlinkSync(db2 + "-wal") } catch {}
    try { fs.unlinkSync(db2 + "-shm") } catch {}
  })

  it("未配置 events：GET /api/events 返回 404 或 501", async () => {
    const res = await fetch(`${url2}/api/events`)
    assert.ok(res.status === 404 || res.status === 501, `期望 404/501，实际 ${res.status}`)
    try { await res.body?.cancel() } catch {}
  })

  it("未配置 ttyd：POST /api/terminal/ttyd/:sid 返回 404 或 501", async () => {
    const res = await fetch(`${url2}/api/terminal/ttyd/cc-x`, { method: "POST" })
    assert.ok(res.status === 404 || res.status === 501, `期望 404/501，实际 ${res.status}`)
  })

  it("未配置 ttyd：DELETE /api/terminal/ttyd/:sid 返回 404 或 501", async () => {
    const res = await fetch(`${url2}/api/terminal/ttyd/cc-x`, { method: "DELETE" })
    assert.ok(res.status === 404 || res.status === 501, `期望 404/501，实际 ${res.status}`)
  })
})
