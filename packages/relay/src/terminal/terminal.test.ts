/**
 * Terminal API 测试 — relay 三原子操作（spawn / inject / close）+ 辅助端点
 *
 * 用 mock ITerminal 实现，不依赖真实 iTerm/tmux
 * 风格对齐 server.test.ts
 */
import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "../server.js"
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import type { ITerminal, SpawnResult } from "./interface.js"
import os from "node:os"
import path from "node:path"
import fs from "node:fs"

// ===== Mock Terminal =====
class MockTerminal implements ITerminal {
  spawnLog: Array<{ cmd: string; opts?: { mode?: "tab" | "window"; cwd?: string } }> = []
  injectLog: Array<{ sessionId: string; text: string; hint?: { windowId?: string } }> = []
  closeLog: string[] = []
  aliveSessions: Set<string> = new Set(["sess-alive-1", "sess-alive-2", "sess-close-cleanup"])
  private spawnCounter = 0

  async inject(sessionId: string, text: string, hint?: { windowId?: string }): Promise<boolean> {
    const alive = this.aliveSessions.has(sessionId)
    if (alive) this.injectLog.push({ sessionId, text, hint })
    return alive
  }

  async spawn(cmd: string, opts?: { mode?: "tab" | "window"; cwd?: string }): Promise<SpawnResult> {
    this.spawnCounter++
    this.spawnLog.push({ cmd, opts })
    return {
      sessionId: `mock-session-${this.spawnCounter}`,
      windowId: `mock-window-${this.spawnCounter}`,
    }
  }

  async isAlive(sessionId: string): Promise<boolean> {
    return this.aliveSessions.has(sessionId)
  }

  async close(sessionId: string): Promise<void> {
    this.closeLog.push(sessionId)
    this.aliveSessions.delete(sessionId)
  }

  async getCurrentSession(): Promise<{ sessionId: string; windowId?: string } | null> {
    return { sessionId: "current-sess-001", windowId: "current-win-001" }
  }
}

let server: Server
let baseUrl: string
let dbPath: string
let mockTerminal: MockTerminal

async function api(method: string, apiPath: string, body?: unknown): Promise<{ status: number; data: any }> {
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  }
  if (body) opts.body = JSON.stringify(body)
  const res = await fetch(`${baseUrl}${apiPath}`, opts)
  const data = await res.json().catch(() => null)
  return { status: res.status, data }
}

describe("Terminal API — 三原子操作 + 辅助端点", () => {
  before(async () => {
    dbPath = path.join(os.tmpdir(), `mesh-terminal-test-${Date.now()}.db`)
    mockTerminal = new MockTerminal()
    const app = createServer({
      dbPath,
      deviceId: "macbook",
      terminal: mockTerminal,
    })
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s))
    })
    const addr = server.address() as AddressInfo
    baseUrl = `http://localhost:${addr.port}/api`
  })

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    try { fs.unlinkSync(dbPath) } catch {}
    try { fs.unlinkSync(dbPath + "-wal") } catch {}
    try { fs.unlinkSync(dbPath + "-shm") } catch {}
  })

  // ===== POST /api/terminal/spawn =====

  describe("POST /api/terminal/spawn", () => {
    it("正常 spawn 返回 sessionId + windowId", async () => {
      const { status, data } = await api("POST", "/terminal/spawn", {
        cmd: "claude --dangerously-skip-permissions",
      })
      assert.equal(status, 200)
      assert.equal(data.ok, true)
      assert.ok(data.data?.sessionId, "应返回 sessionId")
      assert.ok(data.data?.windowId, "应返回 windowId")
    })

    it("spawn 传递 mode 和 cwd 参数", async () => {
      const { status, data } = await api("POST", "/terminal/spawn", {
        cmd: "MESH_SESSION_ID=test-123 claude --dangerously-skip-permissions",
        mode: "window",
        cwd: "/Users/example/workspace/project",
      })
      assert.equal(status, 200)
      assert.equal(data.ok, true)
      // 验证 mock 收到了参数
      const lastSpawn = mockTerminal.spawnLog[mockTerminal.spawnLog.length - 1]
      assert.ok(lastSpawn.cmd.includes("MESH_SESSION_ID"), "cmd 应包含 MESH_SESSION_ID 环境变量")
      assert.equal(lastSpawn.opts?.mode, "window")
      assert.equal(lastSpawn.opts?.cwd, "/Users/example/workspace/project")
    })

    it("缺少 cmd 返回 400", async () => {
      const { status, data } = await api("POST", "/terminal/spawn", {})
      assert.equal(status, 400)
      assert.equal(data.ok, false)
    })
  })

  // ===== POST /api/terminal/close =====

  describe("POST /api/terminal/close", () => {
    it("close 后移除同 sessionId 的 registry 节点", async () => {
      const reg = await api("POST", "/register", {
        shortId: "cc-close-1",
        sessionId: "sess-close-cleanup",
        pid: 20001,
        role: "worker",
        description: "close cleanup test",
      })
      assert.equal(reg.status, 200)
      const nodeId = reg.data.data?.nodeId

      const close = await api("POST", "/terminal/close", {
        sessionId: "sess-close-cleanup",
      })
      assert.equal(close.status, 200)
      assert.equal(close.data.ok, true)
      assert.deepEqual(close.data.data?.removedNodeIds, [nodeId])

      const status = await api("GET", "/status")
      const found = (status.data.data?.nodes ?? []).find((n: any) => n.identity?.nodeId === nodeId)
      assert.equal(found, undefined)
    })
  })

  // ===== POST /api/terminal/inject =====

  describe("POST /api/terminal/inject", () => {
    it("注入中文消息到存活 session", async () => {
      const { status, data } = await api("POST", "/terminal/inject", {
        sessionId: "sess-alive-1",
        text: "你好，这是一条中文消息 🚀",
      })
      assert.equal(status, 200)
      assert.equal(data.ok, true)
      assert.equal(data.data?.delivered, true)
      // 验证 mock 收到了中文
      const lastInject = mockTerminal.injectLog[mockTerminal.injectLog.length - 1]
      assert.equal(lastInject.sessionId, "sess-alive-1")
      assert.ok(lastInject.text.includes("中文消息"), "应包含中文内容")
    })

    it("inject 带 windowId hint", async () => {
      await api("POST", "/terminal/inject", {
        sessionId: "sess-alive-2",
        text: "hello with hint",
        windowId: "win-123",
      })
      const lastInject = mockTerminal.injectLog[mockTerminal.injectLog.length - 1]
      assert.equal(lastInject.hint?.windowId, "win-123")
    })

    it("缺少必填字段返回 400", async () => {
      const { status, data } = await api("POST", "/terminal/inject", { sessionId: "sess-1" })
      assert.equal(status, 400)
      assert.equal(data.ok, false)
    })

    it("缺少 sessionId 返回 400", async () => {
      const { status, data } = await api("POST", "/terminal/inject", { text: "hello" })
      assert.equal(status, 400)
      assert.equal(data.ok, false)
    })

    it("inject 到不存活 session 返回 delivered=false", async () => {
      const { status, data } = await api("POST", "/terminal/inject", {
        sessionId: "sess-nonexistent",
        text: "should not deliver",
      })
      assert.equal(status, 200)
      assert.equal(data.data?.delivered, false)
    })

    it("特殊字符注入原样传递", async () => {
      const specialText = 'echo "hello\nworld" \'single\' `back` \\slash'
      const { status } = await api("POST", "/terminal/inject", {
        sessionId: "sess-alive-1",
        text: specialText,
      })
      assert.equal(status, 200)
      const lastInject = mockTerminal.injectLog[mockTerminal.injectLog.length - 1]
      assert.equal(lastInject.text, specialText)
    })
  })

  // ===== GET /api/terminal/alive/:id =====

  describe("GET /api/terminal/alive/:sessionId", () => {
    it("存活的 session 返回 alive=true", async () => {
      const { status, data } = await api("GET", "/terminal/alive/sess-alive-1")
      assert.equal(status, 200)
      assert.equal(data.ok, true)
      assert.equal(data.data?.alive, true)
    })

    it("不存在的 session 返回 alive=false", async () => {
      const { status, data } = await api("GET", "/terminal/alive/sess-nonexistent")
      assert.equal(status, 200)
      assert.equal(data.ok, true)
      assert.equal(data.data?.alive, false)
    })
  })

  // ===== POST /api/terminal/close =====

  describe("POST /api/terminal/close", () => {
    it("正常关闭 session", async () => {
      // 先加入一个可关闭的 session
      mockTerminal.aliveSessions.add("sess-to-close")
      const { status, data } = await api("POST", "/terminal/close", { sessionId: "sess-to-close" })
      assert.equal(status, 200)
      assert.equal(data.ok, true)
      assert.ok(mockTerminal.closeLog.includes("sess-to-close"))
    })

    it("缺少 sessionId 返回 400", async () => {
      const { status, data } = await api("POST", "/terminal/close", {})
      assert.equal(status, 400)
      assert.equal(data.ok, false)
    })

    it("close 后 isAlive 变为 false", async () => {
      const sid = "sess-lifecycle-test"
      mockTerminal.aliveSessions.add(sid)
      // 先确认 alive
      const before = await api("GET", `/terminal/alive/${sid}`)
      assert.equal(before.data?.data?.alive, true)
      // close
      await api("POST", "/terminal/close", { sessionId: sid })
      // 再确认 dead
      const afterClose = await api("GET", `/terminal/alive/${sid}`)
      assert.equal(afterClose.data?.data?.alive, false)
    })
  })

  // ===== GET /api/terminal/current =====

  describe("GET /api/terminal/current", () => {
    it("返回当前 session 信息", async () => {
      const { status, data } = await api("GET", "/terminal/current")
      assert.equal(status, 200)
      assert.equal(data.ok, true)
      assert.ok(data.data?.sessionId, "应返回 sessionId")
      assert.ok(data.data?.windowId, "应返回 windowId")
    })
  })

})

// ===== wait_ready 逻辑测试 =====
// spawn 后轮询 /api/register 等节点注册，注册后返回 sessionId

describe("wait_ready — spawn 后等待节点注册", () => {
  let waitServer: Server
  let waitUrl: string
  let waitDbPath: string
  let waitTerminal: MockTerminal

  before(async () => {
    waitDbPath = path.join(os.tmpdir(), `mesh-wait-ready-${Date.now()}.db`)
    waitTerminal = new MockTerminal()
    const app = createServer({
      dbPath: waitDbPath,
      deviceId: "macbook",
      terminal: waitTerminal,
    })
    waitServer = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s))
    })
    const addr = waitServer.address() as AddressInfo
    waitUrl = `http://localhost:${addr.port}/api`
  })

  after(async () => {
    await new Promise<void>((resolve) => waitServer.close(() => resolve()))
    try { fs.unlinkSync(waitDbPath) } catch {}
    try { fs.unlinkSync(waitDbPath + "-wal") } catch {}
    try { fs.unlinkSync(waitDbPath + "-shm") } catch {}
  })

  async function waitApi(method: string, apiPath: string, body?: unknown): Promise<{ status: number; data: any }> {
    const opts: RequestInit = {
      method,
      headers: { "Content-Type": "application/json" },
    }
    if (body) opts.body = JSON.stringify(body)
    const res = await fetch(`${waitUrl}${apiPath}`, opts)
    const data = await res.json().catch(() => null)
    return { status: res.status, data }
  }

  /**
   * wait_ready: 轮询 /api/status 等待 shortId 出现
   * 模拟 CLI 端 spawn → poll → ready 的流程
   */
  async function waitReady(shortId: string, timeoutMs: number = 2000): Promise<string | null> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const { data } = await waitApi("GET", "/status")
      if (data?.ok && Array.isArray(data.data?.nodes)) {
        const node = data.data.nodes.find((n: any) => n.identity?.shortId === shortId)
        if (node) return node.sessionId
      }
      await new Promise((r) => setTimeout(r, 50))
    }
    return null
  }

  it("节点注册后 wait_ready 返回 sessionId", async () => {
    // 1. spawn terminal
    const spawn = await waitApi("POST", "/terminal/spawn", {
      cmd: "MESH_SESSION_ID=wait-test-001 claude --dangerously-skip-permissions",
    })
    assert.equal(spawn.status, 200)

    // 2. 模拟新节点注册（正常流程中 cc 启动后自己注册）
    const reg = await waitApi("POST", "/register", {
      shortId: "cc-wait-001",
      sessionId: "sess-wait-001",
      pid: 99901,
      role: "worker",
      description: "wait_ready test node",
    })
    assert.equal(reg.status, 200)

    // 3. wait_ready 应该能找到节点
    const sessionId = await waitReady("cc-wait-001", 1000)
    assert.equal(sessionId, "sess-wait-001")
  })

  it("超时返回 null", async () => {
    // 不注册任何节点，直接 wait
    const result = await waitReady("cc-nonexistent-999", 200)
    assert.equal(result, null)
  })

  it("并发 wait_ready 各自返回正确 sessionId", async () => {
    // 两组 spawn + 延迟注册，并行 waitReady
    await waitApi("POST", "/terminal/spawn", { cmd: "echo concurrent-1" })
    await waitApi("POST", "/terminal/spawn", { cmd: "echo concurrent-2" })

    // 延迟注册两个节点 + 并行等待
    const [sid1, sid2] = await Promise.all([
      waitReady("cc-concurrent-1", 2000),
      waitReady("cc-concurrent-2", 2000),
      (async () => { await new Promise(r => setTimeout(r, 100)); await waitApi("POST", "/register", { shortId: "cc-concurrent-1", sessionId: "sess-concurrent-1", pid: 88801, role: "worker", description: "concurrent test 1" }) })(),
      (async () => { await new Promise(r => setTimeout(r, 150)); await waitApi("POST", "/register", { shortId: "cc-concurrent-2", sessionId: "sess-concurrent-2", pid: 88802, role: "worker", description: "concurrent test 2" }) })(),
    ])
    assert.equal(sid1, "sess-concurrent-1")
    assert.equal(sid2, "sess-concurrent-2")
  })
})
