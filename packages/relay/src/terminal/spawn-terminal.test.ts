/**
 * /api/spawn 委托 terminal.spawn() 测试
 *
 * terminal 是必选依赖，/api/spawn 构建命令后委托 terminal.spawn()。
 *
 * 风格对齐 terminal.test.ts — node:test + assert/strict
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

// ===== Mock Terminal — 记录 spawn 调用 =====
class SpawnTrackingTerminal implements ITerminal {
  spawnLog: Array<{ cmd: string; opts?: { mode?: "tab" | "window"; cwd?: string } }> = []
  private spawnCounter = 0

  async inject(_sessionId: string, _text: string, _hint?: { windowId?: string }): Promise<boolean> { return true }

  async spawn(cmd: string, opts?: { mode?: "tab" | "window"; cwd?: string }): Promise<SpawnResult> {
    this.spawnCounter++
    this.spawnLog.push({ cmd, opts })
    return {
      sessionId: `term-session-${this.spawnCounter}`,
      windowId: `term-window-${this.spawnCounter}`,
    }
  }

  async isAlive(_sessionId: string): Promise<boolean> { return false }
  async close(_sessionId: string): Promise<void> {}
  async getCurrentSession(): Promise<{ sessionId: string; windowId?: string } | null> { return null }
}

// ===== 工具函数 =====
async function api(baseUrl: string, method: string, apiPath: string, body?: unknown): Promise<{ status: number; data: any }> {
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  }
  if (body) opts.body = JSON.stringify(body)
  const res = await fetch(`${baseUrl}${apiPath}`, opts)
  const data = await res.json().catch(() => null)
  return { status: res.status, data }
}

describe("/api/spawn 委托 terminal.spawn()", () => {
  let server: Server
  let baseUrl: string
  let dbPath: string
  let mockTerminal: SpawnTrackingTerminal
  let profileHome: string

  before(async () => {
    dbPath = path.join(os.tmpdir(), `mesh-spawn-terminal-${Date.now()}.db`)
    profileHome = path.join(os.tmpdir(), `mesh-spawn-profile-${Date.now()}`)
    fs.mkdirSync(path.join(profileHome, "agents"), { recursive: true })
    fs.writeFileSync(path.join(profileHome, "agents", "tcx.json"), JSON.stringify({
      name: "tcx",
      launcher: "codex",
      cwd: "/Users/example/workspace/project",
      terminal: "tmux",
      autoInit: true,
    }), "utf8")
    mockTerminal = new SpawnTrackingTerminal()
    const app = createServer({
      dbPath,
      deviceId: "macbook",
      terminal: mockTerminal,
      spawnReadyTimeoutMs: 1,
      profileHome,
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
    try { fs.rmSync(profileHome, { recursive: true, force: true }) } catch {}
  })

  it("POST /api/spawn 基本调用返回 nodeId", async () => {
    const { status, data } = await api(baseUrl, "POST", "/spawn", {
      agent: "tcx",
    })
    assert.equal(status, 200)
    assert.equal(data.ok, true)
    assert.ok(data.data?.nodeId, "应返回 nodeId")
  })

  it("POST /api/spawn 缺少 agent 返回 400", async () => {
    const { status, data } = await api(baseUrl, "POST", "/spawn", {})
    assert.equal(status, 400)
    assert.equal(data.ok, false)
  })

  it("POST /api/spawn mode=window 应传递到 terminal.spawn()", async () => {
    const beforeCount = mockTerminal.spawnLog.length

    const { status, data } = await api(baseUrl, "POST", "/spawn", {
      agent: "tcx",
      mode: "window",
    })
    assert.equal(status, 200)
    assert.equal(data.ok, true)

    const afterCount = mockTerminal.spawnLog.length
    assert.ok(afterCount > beforeCount, "terminal.spawn() should be called")
  })

  it("POST /api/spawn 传递的 mode 参数应到达 terminal", async () => {
    mockTerminal.spawnLog.length = 0

    await api(baseUrl, "POST", "/spawn", {
      agent: "tcx",
      mode: "window",
      projectDir: "/tmp/test-dir",
    })

    assert.ok(mockTerminal.spawnLog.length > 0, "terminal.spawn() should be called")
    const lastSpawn = mockTerminal.spawnLog[mockTerminal.spawnLog.length - 1]
    assert.equal(lastSpawn.opts?.mode, "window", "mode should be 'window'")
    assert.equal(lastSpawn.opts?.cwd, "/tmp/test-dir", "cwd should match projectDir")
  })

  it("POST /api/spawn 返回的 nodeId 格式正确", async () => {
    const { data } = await api(baseUrl, "POST", "/spawn", {
      agent: "tcx",
    })
    const nodeId = data.data?.nodeId as string
    assert.ok(nodeId, "应返回 nodeId")
    // nodeId 格式: deviceId:shortId (例: macbook:cc-a1b2)
    assert.ok(nodeId.includes(":"), `nodeId '${nodeId}' should contain ':'`)
    const [device] = nodeId.split(":")
    assert.equal(device, "macbook", "nodeId 应以 deviceId 开头")
  })

  it("POST /api/spawn 成功后节点应自动注册（端到端）", async () => {
    const { data: spawnData } = await api(baseUrl, "POST", "/spawn", {
      agent: "tcx",
    })
    const nodeId = spawnData.data?.nodeId as string
    const shortId = nodeId?.split(":")[1]

    // 模拟 cc 启动后 register
    if (shortId) {
      await api(baseUrl, "POST", "/register", {
        shortId,
        sessionId: "tmux-e2e-session",
        pid: 12345,
        role: "worker",
        description: "e2e spawn test",
      })

      // 验证节点在 status 中可见
      const { data: statusData } = await api(baseUrl, "GET", "/status")
      const nodes = statusData.data?.nodes ?? []
      const found = nodes.find((n: any) => n.identity?.shortId === shortId)
      assert.ok(found, `node ${shortId} should appear in /api/status after register`)
      assert.equal(found.sessionId, "tmux-e2e-session")
    }
  })
})
