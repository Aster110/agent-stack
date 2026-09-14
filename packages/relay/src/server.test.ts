/**
 * Server 测试 — HTTP API 集成测试
 *
 * 职责：Express HTTP 服务器，暴露 REST API 给 CLI 和其他节点
 * 用 fetch 直接打 HTTP 请求测试
 *
 * TDD：Server 尚未实现
 */
import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "./server.js"
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import type { ITerminal, SpawnResult } from "./terminal/interface.js"
import os from "node:os"
import path from "node:path"
import fs from "node:fs"
import type { DeviceInventory } from "@cc-mesh/protocol"
import { MeshEventBus } from "./events.js"

// ===== Mock Terminal =====
class MockTerminal implements ITerminal {
  injectLog: Array<{ sessionId: string; text: string; hint?: { windowId?: string } }> = []
  spawnLog: Array<{ cmd: string; opts?: { mode?: "tab" | "window"; cwd?: string } }> = []
  notifyLog: Array<{ sessionId: string; text: string }> = []
  notifyShouldThrow = false
  private spawnCounter = 0

  async inject(sessionId: string, text: string, hint?: { windowId?: string }): Promise<boolean> {
    this.injectLog.push({ sessionId, text, hint })
    return true
  }

  async spawn(cmd: string, opts?: { mode?: "tab" | "window"; cwd?: string }): Promise<SpawnResult> {
    this.spawnCounter++
    this.spawnLog.push({ cmd, opts })
    return { sessionId: `mock-session-${this.spawnCounter}`, windowId: `mock-window-${this.spawnCounter}` }
  }

  async isAlive(_sessionId: string): Promise<boolean> { return true }
  async close(_sessionId: string): Promise<void> {}
  async getCurrentSession(): Promise<{ sessionId: string; windowId?: string } | null> { return null }

  async notify(sessionId: string, text: string): Promise<boolean> {
    if (this.notifyShouldThrow) throw new Error("notify boom")
    this.notifyLog.push({ sessionId, text })
    return true
  }
}

let server: Server
let baseUrl: string
let dbPath: string
let mockTerminal: MockTerminal
let profileHome: string
let devices: DeviceInventory[]
let remoteSpawnCalls: Array<{ targetDevice: string; spawn: Record<string, unknown> }>

async function api(method: string, apiPath: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; data: any }> {
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", ...headers },
  }
  if (body) opts.body = JSON.stringify(body)
  const res = await fetch(`${baseUrl}${apiPath}`, opts)
  const data = await res.json().catch(() => null)
  return { status: res.status, data }
}

// 注意：以下 describe 是 Phase 1 向后兼容测试 —— 不传 transport，server 直接用 terminal.inject。
// Phase 2.0 引入 ITransport 后这些测试必须继续通过（不传 transport 回退到 terminal）。
describe("Server — HTTP API 集成测试（向后兼容：无 transport）", () => {
  before(async () => {
    dbPath = path.join(os.tmpdir(), `mesh-server-test-${Date.now()}.db`)
    profileHome = path.join(os.tmpdir(), `mesh-profile-home-${Date.now()}`)
    fs.mkdirSync(path.join(profileHome, "agents"), { recursive: true })
    fs.writeFileSync(path.join(profileHome, "agents", "tcx.json"), JSON.stringify({
      name: "tcx",
      launcher: "codex",
      cwd: "/Users/example/workspace/project",
      terminal: "tmux",
      autoInit: true,
    }), "utf8")
    mockTerminal = new MockTerminal()
    remoteSpawnCalls = []
    devices = [
      {
        deviceId: "computer2",
        relayId: "computer2-123",
        nodes: [],
        updatedAt: new Date().toISOString(),
      },
    ]
    const app = createServer({
      dbPath,
      deviceId: "macbook",
      terminal: mockTerminal,
      spawnReadyTimeoutMs: 1,
      profileHome,
      getDevices: () => devices,
      getDevicesSource: () => "hub",
      requestRemoteSpawn: async (targetDevice, spawn) => {
        remoteSpawnCalls.push({ targetDevice, spawn })
        return { ok: true, data: { nodeId: `${targetDevice}:cc-remote`, registered: true } }
      },
    })
    // 用 port 0 让 OS 分配端口
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

  // ===== Register =====

  describe("POST /api/register", () => {
    it("正常注册返回 ok + nodeId", async () => {
      const { status, data } = await api("POST", "/register", {
        shortId: "cc-t001",
        sessionId: "sess-t001",
        pid: 10001,
        role: "worker",
        description: "test worker",
      })
      assert.equal(status, 200)
      assert.equal(data.ok, true)
      assert.ok(data.data?.nodeId)
    })

    it("缺少必填字段返回 400", async () => {
      const { status, data } = await api("POST", "/register", {
        shortId: "cc-bad",
        // 缺 sessionId, pid, role
      })
      assert.equal(status, 400)
      assert.equal(data.ok, false)
    })

    // ===== D1: 注册放开 — 声明 sse-pull 时 sessionId 可选，生成 nopane- 占位 =====
    it("register 声明 sse-pull 省略 sessionId 返回 200 + nopane 占位", async () => {
      const { status, data } = await api("POST", "/register", {
        shortId: "cc-sse1",
        pid: 40001,
        role: "worker",
        description: "sse-pull node",
        deliveryMode: "sse-pull",
        // 不传 sessionId
      })
      assert.equal(status, 200)
      assert.equal(data.ok, true)
      const nodeId = data.data?.nodeId
      assert.ok(nodeId)
      // getNode：占位 sessionId 必须是 nopane-<nodeId> 前缀
      const got = await api("GET", "/status")
      const node = got.data.data.nodes.find((n: any) => n.identity.nodeId === nodeId)
      assert.ok(node, "sse-pull 节点应在 registry")
      assert.equal(node.identity.deliveryMode, "pull", "PR2:注册即归一 sse-pull→pull")
      assert.ok(String(node.sessionId).startsWith("nopane-"), `占位 sessionId 应以 nopane- 开头，实际: ${node.sessionId}`)
      assert.equal(node.sessionId, `nopane-${nodeId}`)
    })

    // ===== A2: 缺省 deliveryMode（老节点）仍按 inject，sessionId 必填 =====
    it("register 缺省 deliveryMode 仍按 inject 要求 sessionId 必填(400)", async () => {
      const { status, data } = await api("POST", "/register", {
        shortId: "cc-old-noss",
        pid: 40002,
        role: "worker",
        description: "old node no session",
        // 不传 deliveryMode、不传 sessionId
      })
      assert.equal(status, 400, "老节点(=inject)缺 sessionId 仍 400")
      assert.equal(data.ok, false)
    })

    it("register 显式 inject 缺 sessionId 返回 400", async () => {
      const { status, data } = await api("POST", "/register", {
        shortId: "cc-inj-noss",
        pid: 40003,
        role: "worker",
        description: "inject no session",
        deliveryMode: "inject",
        // 不传 sessionId
      })
      assert.equal(status, 400, "显式 inject 缺 sessionId 仍 400（放开只认 sse-pull/native-api）")
      assert.equal(data.ok, false)
    })

    it("register 正常 inject 带 sessionId 保存 deliveryMode=inject", async () => {
      const { status, data } = await api("POST", "/register", {
        shortId: "cc-inj-ok",
        sessionId: "sess-inj-ok",
        pid: 40004,
        role: "worker",
        description: "inject ok",
        // 不传 deliveryMode → 缺省 inject
      })
      assert.equal(status, 200)
      const nodeId = data.data?.nodeId
      const got = await api("GET", "/status")
      const node = got.data.data.nodes.find((n: any) => n.identity.nodeId === nodeId)
      assert.ok(node)
      assert.equal(node.identity.deliveryMode, "inject", "缺省落 inject")
      assert.equal(node.sessionId, "sess-inj-ok", "inject 用传入真 sessionId，非 nopane-")
    })

    // 补充：重复注册同一 shortId 覆盖
    it("重复注册同一 shortId 覆盖", async () => {
      const reg1 = await api("POST", "/register", {
        shortId: "cc-dup-reg",
        sessionId: "sess-dup-1",
        pid: 20001,
        role: "worker",
        description: "first",
      })
      assert.equal(reg1.status, 200)
      const nodeId1 = reg1.data.data?.nodeId

      const reg2 = await api("POST", "/register", {
        shortId: "cc-dup-reg",
        sessionId: "sess-dup-2",
        pid: 20002,
        role: "worker",
        description: "second",
      })
      assert.equal(reg2.status, 200)
      const nodeId2 = reg2.data.data?.nodeId
      assert.equal(nodeId1, nodeId2, "同一 shortId 应返回相同 nodeId")
    })
  })

  // ===== Unregister =====

  describe("DELETE /api/register/:nodeId", () => {
    it("正常注销返回 ok", async () => {
      // 先注册
      const reg = await api("POST", "/register", {
        shortId: "cc-del1",
        sessionId: "sess-del1",
        pid: 10002,
        role: "worker",
        description: "to delete",
      })
      const nodeId = reg.data.data?.nodeId

      const { status, data } = await api("DELETE", `/register/${encodeURIComponent(nodeId)}`)
      assert.equal(status, 200)
      assert.equal(data.ok, true)
    })

    it("注销不存在的节点返回 404", async () => {
      const { status, data } = await api("DELETE", "/register/nonexistent:cc-0000")
      assert.equal(status, 404)
      assert.equal(data.ok, false)
    })
  })

  describe("DELETE /api/register", () => {
    it("清空所有注册节点", async () => {
      await api("POST", "/register", {
        shortId: "cc-clear1",
        sessionId: "sess-clear1",
        pid: 11001,
        role: "worker",
        description: "clear one",
      })
      await api("POST", "/register", {
        shortId: "cc-clear2",
        sessionId: "sess-clear2",
        pid: 11002,
        role: "worker",
        description: "clear two",
      })

      const { status, data } = await api("DELETE", "/register")
      assert.equal(status, 200)
      assert.equal(data.ok, true)
      assert.ok(data.data.removedNodeIds.includes("macbook:cc-clear1"))
      assert.ok(data.data.removedNodeIds.includes("macbook:cc-clear2"))

      const after = await api("GET", "/status")
      assert.ok(!after.data.data.nodes.some((n: any) => n.identity.shortId === "cc-clear1"))
      assert.ok(!after.data.data.nodes.some((n: any) => n.identity.shortId === "cc-clear2"))
    })
  })

  // ===== Heartbeat =====

  describe("POST /api/heartbeat", () => {
    it("已注册节点心跳返回 ok", async () => {
      const reg = await api("POST", "/register", {
        shortId: "cc-hb01",
        sessionId: "sess-hb01",
        pid: 10003,
        role: "worker",
        description: "heartbeat test",
      })
      const nodeId = reg.data.data?.nodeId

      const { status, data } = await api("POST", "/heartbeat", { nodeId })
      assert.equal(status, 200)
      assert.equal(data.ok, true)
    })

    it("未注册节点心跳返回 404", async () => {
      const { status, data } = await api("POST", "/heartbeat", { nodeId: "ghost:cc-0000" })
      assert.equal(status, 404)
      assert.equal(data.ok, false)
    })
  })

  // ===== Status =====

  describe("GET /api/status", () => {
    it("返回在线节点列表", async () => {
      const { status, data } = await api("GET", "/status")
      assert.equal(status, 200)
      assert.equal(data.ok, true)
      assert.ok(Array.isArray(data.data?.nodes))
    })
  })

  describe("GET /api/devices", () => {
    it("返回 Hub/缓存同步过来的设备列表", async () => {
      const { status, data } = await api("GET", "/devices")
      assert.equal(status, 200)
      assert.equal(data.ok, true)
      assert.equal(data.data.source, "hub")
      assert.equal(data.data.devices[0].deviceId, "computer2")
    })
  })

  // ===== Send =====

  describe("POST /api/send", () => {
    it("发消息给已注册的本地节点返回 ok", async () => {
      // 先注册发送方
      const regSender = await api("POST", "/register", {
        shortId: "cc-sender",
        sessionId: "sess-sender",
        pid: 10009,
        role: "worker",
        description: "sender",
      })
      const senderId = regSender.data.data?.nodeId

      // 注册接收方
      const reg = await api("POST", "/register", {
        shortId: "cc-recv",
        sessionId: "sess-recv",
        pid: 10010,
        role: "worker",
        description: "receiver",
      })
      const targetId = reg.data.data?.nodeId

      // 用 X-Mesh-Node header 标识发送方，body 不含 from
      const beforeLen = mockTerminal.injectLog.length
      const { status, data } = await api("POST", "/send", {
        to: targetId,
        message: "hello from test",
        type: "chat",
      }, { "X-Mesh-Node": senderId })
      assert.equal(status, 200)
      assert.equal(data.ok, true)
      // 验证 terminal.inject 被调用，且 sessionId 和 message 正确
      assert.ok(mockTerminal.injectLog.length > beforeLen, "terminal.inject should be called")
      const lastInject = mockTerminal.injectLog[mockTerminal.injectLog.length - 1]
      assert.equal(lastInject.sessionId, "sess-recv")
      // 投递 payload 会自动加 [mesh:<完整 fromNodeId>] 前缀
      assert.equal(lastInject.text, `[mesh:${senderId}] hello from test`)
    })

    it("POST /api/send 投递时自动加 [mesh:<fromNodeId>] 前缀", async () => {
      // senderId 已在前一个测试的 beforeEach 注册为 macbook:cc-t001
      // 新建 receiver
      const reg = await api("POST", "/register", {
        shortId: "cc-prefix-recv",
        sessionId: "sess-prefix",
        pid: 10099,
        role: "worker",
        description: "prefix receiver",
      })
      const targetId = reg.data.data?.nodeId as string
      const beforeLen = mockTerminal.injectLog.length
      await api("POST", "/send", {
        to: targetId,
        message: "raw body no prefix",
      }, { "X-Mesh-Node": "macbook:cc-t001" })
      assert.ok(mockTerminal.injectLog.length > beforeLen)
      const lastInject = mockTerminal.injectLog[mockTerminal.injectLog.length - 1]
      assert.ok(
        lastInject.text.startsWith("[mesh:macbook:cc-t001] "),
        `injected text should start with [mesh:<fromNodeId>], got: ${lastInject.text}`,
      )
      assert.ok(lastInject.text.endsWith("raw body no prefix"))
    })

    it("POST /api/send 无 X-Mesh-Node 时不加前缀（保留 payload 原貌）", async () => {
      const reg = await api("POST", "/register", {
        shortId: "cc-noprefix-recv",
        sessionId: "sess-noprefix",
        pid: 10098,
        role: "worker",
        description: "no-prefix receiver",
      })
      const targetId = reg.data.data?.nodeId as string
      const beforeLen = mockTerminal.injectLog.length
      await api("POST", "/send", {
        to: targetId,
        message: "no sender header",
      })  // 不传 X-Mesh-Node
      assert.ok(mockTerminal.injectLog.length > beforeLen)
      const lastInject = mockTerminal.injectLog[mockTerminal.injectLog.length - 1]
      assert.equal(lastInject.text, "no sender header")
    })

    it("发消息给不存在的节点返回错误", async () => {
      const { status, data } = await api("POST", "/send", {
        to: "macbook:cc-ghost",
        message: "hello ghost",
      }, { "X-Mesh-Node": "macbook:cc-t001" })
      // 可能是 404 或 200 + error，取决于实现
      assert.ok(status === 404 || (data.ok === false))
    })

    it("缺少必填字段返回 400", async () => {
      const { status, data } = await api("POST", "/send", {
        // 缺 to, message
      }, { "X-Mesh-Node": "macbook:cc-t001" })
      assert.equal(status, 400)
      assert.equal(data.ok, false)
    })

    // 投递目标必须是完整 nodeId，禁止用 role / shortId 别名
    // 背景：多个 cc 并存时 role=main 不唯一，别名解析会窜到错节点
    it("to 为裸 role（如 'main'）时拒绝投递，返回 400", async () => {
      const regMain = await api("POST", "/register", {
        shortId: "cc-main-probe",
        sessionId: "sess-main-probe",
        pid: 30100,
        role: "main",
        description: "role lookup probe",
      })
      assert.ok(regMain.data.data?.nodeId, "probe main node should register")

      const regSender = await api("POST", "/register", {
        shortId: "cc-probe-sender-role",
        sessionId: "sess-probe-sender-role",
        pid: 30101,
        role: "worker",
        description: "probe sender",
      })
      const senderId = regSender.data.data?.nodeId

      const { status, data } = await api("POST", "/send", {
        to: "main",
        message: "should be rejected",
      }, { "X-Mesh-Node": senderId })
      assert.equal(status, 400)
      assert.equal(data.ok, false)
      assert.match(data.error, /nodeId|完整/, "error should mention nodeId requirement")
    })

    it("to 为裸 shortId（不含冒号）时拒绝投递，返回 400", async () => {
      const regTarget = await api("POST", "/register", {
        shortId: "cc-short-probe",
        sessionId: "sess-short-probe",
        pid: 30200,
        role: "worker",
        description: "shortId lookup probe",
      })
      assert.ok(regTarget.data.data?.nodeId)

      const regSender = await api("POST", "/register", {
        shortId: "cc-probe-sender-short",
        sessionId: "sess-probe-sender-short",
        pid: 30201,
        role: "worker",
        description: "probe sender",
      })
      const senderId = regSender.data.data?.nodeId

      const { status, data } = await api("POST", "/send", {
        to: "cc-short-probe",
        message: "should be rejected",
      }, { "X-Mesh-Node": senderId })
      assert.equal(status, 400)
      assert.equal(data.ok, false)
      assert.match(data.error, /nodeId|完整/)
    })

    // 补充：send 带 replyTo 字段
    it("send 带 replyTo 字段", async () => {
      // 注册接收方
      const reg = await api("POST", "/register", {
        shortId: "cc-reply-recv",
        sessionId: "sess-reply-recv",
        pid: 10011,
        role: "worker",
        description: "reply receiver",
      })
      const targetId = reg.data.data?.nodeId

      const { status, data } = await api("POST", "/send", {
        to: targetId,
        message: "reply to your question",
        type: "result",
        replyTo: "msg-original-123",
      }, { "X-Mesh-Node": "macbook:cc-t001" })
      assert.equal(status, 200)
      assert.equal(data.ok, true)
    })

    // ===== 通知增强（tmux display-message）=====
    // 修复 "worker→主 cc 只写 SQLite 不主动通知" —— 本地投递成功后调用 terminal.notify
    // 让 tmux 状态栏闪消息，给人/cc 立即视觉信号。

    it("本地投递成功后调用 terminal.notify（参数含发送方 shortId + sessionId）", async () => {
      delete process.env.MESH_NOTIFY
      // 注册发送方
      const regSender = await api("POST", "/register", {
        shortId: "cc-ntf-from",
        sessionId: "sess-ntf-from",
        pid: 30001,
        role: "worker",
        description: "notify sender",
      })
      const senderId = regSender.data.data?.nodeId

      // 注册接收方
      const regRecv = await api("POST", "/register", {
        shortId: "cc-ntf-recv",
        sessionId: "sess-ntf-recv",
        pid: 30002,
        role: "worker",
        description: "notify receiver",
      })
      const targetId = regRecv.data.data?.nodeId

      const before = mockTerminal.notifyLog.length
      const { status, data } = await api("POST", "/send", {
        to: targetId,
        message: "汇报：xxx 完成",
      }, { "X-Mesh-Node": senderId })
      assert.equal(status, 200)
      assert.equal(data.ok, true)

      assert.ok(mockTerminal.notifyLog.length > before, "terminal.notify 应被调用")
      const last = mockTerminal.notifyLog[mockTerminal.notifyLog.length - 1]
      assert.equal(last.sessionId, "sess-ntf-recv", "notify 应送达接收方 sessionId")
      assert.ok(last.text.includes("cc-ntf-from"), `notify 文本应含发送方 shortId，实际: ${last.text}`)
    })

    it("MESH_NOTIFY=0 时不调用 terminal.notify", async () => {
      const prev = process.env.MESH_NOTIFY
      process.env.MESH_NOTIFY = "0"
      try {
        const regRecv = await api("POST", "/register", {
          shortId: "cc-ntf-off",
          sessionId: "sess-ntf-off",
          pid: 30003,
          role: "worker",
          description: "notify off receiver",
        })
        const targetId = regRecv.data.data?.nodeId

        const before = mockTerminal.notifyLog.length
        const { status } = await api("POST", "/send", {
          to: targetId,
          message: "应当不通知",
        }, { "X-Mesh-Node": "macbook:cc-ntf-off-src" })
        assert.equal(status, 200)
        assert.equal(mockTerminal.notifyLog.length, before, "MESH_NOTIFY=0 时 notify 不应被调用")
      } finally {
        if (prev === undefined) delete process.env.MESH_NOTIFY
        else process.env.MESH_NOTIFY = prev
      }
    })

    it("notify 抛错不影响 send 成功返回", async () => {
      delete process.env.MESH_NOTIFY
      const regRecv = await api("POST", "/register", {
        shortId: "cc-ntf-err",
        sessionId: "sess-ntf-err",
        pid: 30004,
        role: "worker",
        description: "notify throws",
      })
      const targetId = regRecv.data.data?.nodeId

      mockTerminal.notifyShouldThrow = true
      try {
        const { status, data } = await api("POST", "/send", {
          to: targetId,
          message: "即便 notify 失败也不影响",
        }, { "X-Mesh-Node": "macbook:cc-ntf-err-src" })
        assert.equal(status, 200)
        assert.equal(data.ok, true, "notify 抛错 send 仍应 ok")
      } finally {
        mockTerminal.notifyShouldThrow = false
      }
    })
  })

  // ===== Inbox =====

  describe("GET /api/inbox", () => {
    it("查询收件箱返回消息列表", async () => {
      const { status, data } = await api("GET", "/inbox?nodeId=macbook:cc-recv")
      assert.equal(status, 200)
      assert.equal(data.ok, true)
      assert.ok(Array.isArray(data.data?.messages))
    })

    it("缺少 nodeId 返回 400", async () => {
      const { status, data } = await api("GET", "/inbox")
      assert.equal(status, 400)
      assert.equal(data.ok, false)
    })
  })

  // ===== Broadcast =====

  describe("POST /api/broadcast", () => {
    it("广播消息返回 ok 且 terminal.inject 被调用", async () => {
      const beforeLen = mockTerminal.injectLog.length
      const { status, data } = await api("POST", "/broadcast", {
        message: "broadcast test",
        type: "system",
      }, { "X-Mesh-Node": "macbook:cc-t001" })
      assert.equal(status, 200)
      assert.equal(data.ok, true)
      // broadcast 应对所有在线节点调用 terminal.inject
      assert.ok(mockTerminal.injectLog.length > beforeLen, "terminal.inject should be called for broadcast")
    })

    it("缺少必填字段返回 400", async () => {
      const { status, data } = await api("POST", "/broadcast", {})
      assert.equal(status, 400)
      assert.equal(data.ok, false)
    })
  })

  // ===== Spawn =====

  describe("POST /api/spawn", () => {
    it("spawn 返回新 nodeId 且 terminal.spawn 被调用", async () => {
      const beforeLen = mockTerminal.spawnLog.length
      const { status, data } = await api("POST", "/spawn", {
        agent: "tcx",
        role: "worker",
      })
      assert.equal(status, 200)
      assert.equal(data.ok, true)
      assert.ok(data.data?.nodeId)
      // 验证 terminal.spawn 被调用
      assert.ok(mockTerminal.spawnLog.length > beforeLen, "terminal.spawn should be called")
    })

    it("缺少 agent 返回 400", async () => {
      const { status, data } = await api("POST", "/spawn", {})
      assert.equal(status, 400)
      assert.equal(data.ok, false)
    })

    // 补充：spawn 的 mode/projectDir 参数传递
    it("spawn 传递 mode 和 projectDir 参数", async () => {
      const { status, data } = await api("POST", "/spawn", {
        agent: "tcx",
        role: "worker",
        mode: "window",
        projectDir: "/Users/example/AIproject/cc-mesh",
      })
      assert.equal(status, 200)
      assert.equal(data.ok, true)
      assert.ok(data.data?.nodeId)
      // 验证 mock terminal 收到了参数
      const lastSpawn = mockTerminal.spawnLog[mockTerminal.spawnLog.length - 1]
      assert.equal(lastSpawn.opts?.mode, "window")
      assert.equal(lastSpawn.opts?.cwd, "/Users/example/AIproject/cc-mesh")
    })

    it("spawn 支持 agent=tcx 并使用 profile 默认目录和通用 wrapper", async () => {
      mockTerminal.spawnLog.length = 0
      const { status, data } = await api("POST", "/spawn", {
        agent: "tcx",
        delegatorNodeId: "macbook:lead",
      })
      assert.equal(status, 200)
      assert.equal(data.ok, true)

      const lastSpawn = mockTerminal.spawnLog[mockTerminal.spawnLog.length - 1]
      assert.equal(lastSpawn.opts?.cwd, "/Users/example/workspace/project")
      assert.ok(lastSpawn.cmd.includes("MESH_LAUNCHER='codex'"), "cmd should pass profile launcher to wrapper")
      assert.ok(lastSpawn.cmd.includes("MESH_DELEGATOR_NODE='macbook:lead'"), "cmd should pass delegator node")
      assert.ok(lastSpawn.cmd.includes("/scripts/mesh-agent-wrapper.sh"), "cmd should use generic agent wrapper")
      assert.ok(!lastSpawn.cmd.includes("MESH_BOOTSTRAP_TASK"), "cmd should no longer carry MESH_BOOTSTRAP_TASK env")
      const lastInject = mockTerminal.injectLog[mockTerminal.injectLog.length - 1]
      assert.ok(lastInject.text.includes("worker_node_id:"), "bootstrap should include full worker node id")
      assert.ok(lastInject.text.includes("lead_node_id: macbook:lead"), "bootstrap should mention full lead node id")
      assert.ok(lastInject.text.includes("wrapper 已自动向 lead 发送 [bootstrap][registered]"), "bootstrap should state that wrapper already sent registered")
      assert.ok(lastInject.text.includes('mesh send macbook:lead "[bootstrap][ready]'), "bootstrap should require agent to send ready")
    })

    it("spawn 的 projectDir 会覆盖 profile 默认目录", async () => {
      mockTerminal.spawnLog.length = 0
      const { status, data } = await api("POST", "/spawn", {
        agent: "tcx",
        projectDir: "/tmp/override-cwd",
      })
      assert.equal(status, 200)
      assert.equal(data.ok, true)

      const lastSpawn = mockTerminal.spawnLog[mockTerminal.spawnLog.length - 1]
      assert.equal(lastSpawn.opts?.cwd, "/tmp/override-cwd")
      assert.ok(lastSpawn.cmd.includes("'codex'"), "cmd should include resolved launcher")
      assert.ok(lastSpawn.cmd.includes("'/tmp/override-cwd'"), "cmd should pass overridden cwd")
    })

    it("spawn 遇到未知 agent 返回 400", async () => {
      const { status, data } = await api("POST", "/spawn", {
        agent: "missing-agent",
      })
      assert.equal(status, 400)
      assert.equal(data.ok, false)
    })

    it("spawn 指定 targetDevice 时委托远端 relay，而不是本地解析 profile", async () => {
      remoteSpawnCalls.length = 0
      mockTerminal.spawnLog.length = 0

      const { status, data } = await api("POST", "/spawn", {
        agent: "tcx",
        targetDevice: "computer2",
        delegatorNodeId: "macbook:lead",
      })

      assert.equal(status, 200)
      assert.equal(data.ok, true)
      assert.equal(data.data.nodeId, "computer2:cc-remote")
      assert.equal(remoteSpawnCalls.length, 1)
      assert.equal(remoteSpawnCalls[0].targetDevice, "computer2")
      assert.equal(remoteSpawnCalls[0].spawn.delegatorNodeId, "macbook:lead")
      assert.equal(mockTerminal.spawnLog.length, 0, "本地 terminal.spawn 不应被调用")
    })
  })

  // ===== KV Blackboard =====

  describe("KV /api/kv/:key", () => {
    it("PUT 写入 + GET 读取", async () => {
      const put = await api("PUT", "/kv/test-key", {
        value: "test-value",
        updatedBy: "cc-t001",
      })
      assert.equal(put.status, 200)
      assert.equal(put.data.ok, true)

      const get_ = await api("GET", "/kv/test-key")
      assert.equal(get_.status, 200)
      assert.equal(get_.data.ok, true)
      assert.equal(get_.data.data?.value, "test-value")
    })

    it("GET 不存在的 key 返回 404", async () => {
      const { status, data } = await api("GET", "/kv/nonexistent-key")
      assert.equal(status, 404)
      assert.equal(data.ok, false)
    })

    it("DELETE 删除 key", async () => {
      await api("PUT", "/kv/to-del", { value: "tmp", updatedBy: "cc-t001" })
      const del = await api("DELETE", "/kv/to-del")
      assert.equal(del.status, 200)
      assert.equal(del.data.ok, true)

      const get_ = await api("GET", "/kv/to-del")
      assert.equal(get_.status, 404)
    })

    it("PUT 缺少 value 返回 400", async () => {
      const { status, data } = await api("PUT", "/kv/bad-key", {})
      assert.equal(status, 400)
      assert.equal(data.ok, false)
    })

    it("PUT 用 X-Mesh-Node header 作为 updatedBy", async () => {
      const nodeId = "macbook:cc-kv-header"
      await api("PUT", "/kv/header-test-key", { value: "header-val" }, { "X-Mesh-Node": nodeId })
      const get_ = await api("GET", "/kv/header-test-key")
      assert.equal(get_.status, 200)
      assert.equal(get_.data.data?.updatedBy, nodeId)
    })

    it("PUT X-Mesh-Node 优先于 body updatedBy", async () => {
      await api("PUT", "/kv/header-priority", {
        value: "prio-val",
        updatedBy: "body-node",
      }, { "X-Mesh-Node": "header-node" })
      const get_ = await api("GET", "/kv/header-priority")
      assert.equal(get_.data.data?.updatedBy, "header-node")
    })

    // 补充：GET /api/kv 列出所有 kv
    it("GET /api/kv 列出所有 kv", async () => {
      await api("PUT", "/kv/list-test-a", { value: "a", updatedBy: "cc-t001" })
      await api("PUT", "/kv/list-test-b", { value: "b", updatedBy: "cc-t001" })
      const { status, data } = await api("GET", "/kv")
      assert.equal(status, 200)
      assert.equal(data.ok, true)
      assert.ok(Array.isArray(data.data))
    })
  })
})

// ===== Phase 2.0: Transport 注入 =====
import type { ITransport, DeliveryTarget, DeliveryResult } from "./transport/interface.js"

class MockTransport implements ITransport {
  deliverLog: Array<{ target: DeliveryTarget; text: string }> = []
  result: DeliveryResult = { delivered: true, method: "terminal" }
  // D29: 按顺序返回结果(用于测试 retry);消费完回 result
  resultSequence?: DeliveryResult[]

  async deliver(target: DeliveryTarget, text: string): Promise<DeliveryResult> {
    this.deliverLog.push({ target, text })
    if (this.resultSequence && this.resultSequence.length > 0) {
      return this.resultSequence.shift()!
    }
    return this.result
  }
}

describe("Server — Phase 2.0 Transport 注入", () => {
  let s: Server
  let url: string
  let db: string
  let term: MockTerminal
  let transport: MockTransport

  before(async () => {
    db = path.join(os.tmpdir(), `mesh-server-transport-test-${Date.now()}.db`)
    term = new MockTerminal()
    transport = new MockTransport()
    const app = createServer({
      dbPath: db,
      deviceId: "macbook",
      terminal: term,
      transport,
    } as any)
    s = await new Promise<Server>((resolve) => {
      const x = app.listen(0, () => resolve(x))
    })
    const addr = s.address() as AddressInfo
    url = `http://localhost:${addr.port}/api`
  })

  after(async () => {
    await new Promise<void>((resolve) => s.close(() => resolve()))
    try { fs.unlinkSync(db) } catch {}
    try { fs.unlinkSync(db + "-wal") } catch {}
    try { fs.unlinkSync(db + "-shm") } catch {}
  })

  async function call(method: string, p: string, body?: unknown, headers?: Record<string, string>) {
    const opts: RequestInit = { method, headers: { "Content-Type": "application/json", ...headers } }
    if (body) opts.body = JSON.stringify(body)
    const res = await fetch(`${url}${p}`, opts)
    const data = await res.json().catch(() => null)
    return { status: res.status, data }
  }

  it("/api/send 走 transport.deliver 而不是直接 terminal.inject", async () => {
    const reg = await call("POST", "/register", {
      shortId: "cc-tr-recv",
      sessionId: "sess-tr-recv",
      pid: 30001,
      role: "worker",
      description: "transport receiver",
    })
    const targetId = reg.data.data?.nodeId

    const beforeTerm = term.injectLog.length
    const beforeTr = transport.deliverLog.length
    const { status, data } = await call("POST", "/send", {
      to: targetId,
      message: "via transport",
      type: "chat",
    }, { "X-Mesh-Node": "macbook:cc-tr-sender" })
    assert.equal(status, 200)
    assert.equal(data.ok, true)
    assert.equal(transport.deliverLog.length, beforeTr + 1, "transport.deliver should be called once")
    assert.equal(term.injectLog.length, beforeTerm, "terminal.inject should NOT be called when transport provided")
    const last = transport.deliverLog[transport.deliverLog.length - 1]
    assert.equal(last.target.type, "local")
    if (last.target.type === "local") assert.equal(last.target.sessionId, "sess-tr-recv")
    // transport 收到的 payload 已经加了 [mesh:<fromNodeId>] 前缀
    assert.equal(last.text, "[mesh:macbook:cc-tr-sender] via transport")
  })

  it("/api/send 目标是远端 deviceId 时，transport 收到 type:remote", async () => {
    const { status, data } = await call("POST", "/send", {
      to: "mini:cc-remote",
      message: "uplink route",
    }, { "X-Mesh-Node": "macbook:cc-tr-sender" })
    // 预期：有 transport 时 router 返回 uplink，server 调 transport.deliver({type:"remote", ...})
    assert.equal(status, 200)
    assert.equal(data.ok, true)
    const last = transport.deliverLog[transport.deliverLog.length - 1]
    assert.equal(last.target.type, "remote")
    if (last.target.type === "remote") {
      assert.equal(last.target.deviceId, "mini")
      assert.equal(last.target.nodeId, "mini:cc-remote")
    }
  })

  it("transport.deliver 返回 delivered:false 时 /api/send 响应 status:failed", async () => {
    const reg = await call("POST", "/register", {
      shortId: "cc-tr-fail",
      sessionId: "sess-tr-fail",
      pid: 30003,
      role: "worker",
      description: "fail target",
    })
    const targetId = reg.data.data?.nodeId

    const prev = transport.result
    transport.result = { delivered: false, method: "terminal" }
    try {
      const { status, data } = await call("POST", "/send", {
        to: targetId,
        message: "will fail",
      }, { "X-Mesh-Node": "macbook:cc-tr-sender" })
      // HTTP 仍 200（请求被处理），但 status 字段标记 failed
      assert.equal(status, 200)
      assert.equal(data.ok, true)
      assert.equal(data.data?.status, "failed")
    } finally {
      transport.result = prev
    }
  })

  // ===== D29: send retry once（uplink only） =====

  it("D29 retry: uplink 第一次 false 第二次 true → status: delivered（重试 1 次后成功）", async () => {
    const beforeTr = transport.deliverLog.length
    transport.resultSequence = [
      { delivered: false, method: "terminal" },
      { delivered: true, method: "terminal" },
    ]
    try {
      const { status, data } = await call("POST", "/send", {
        to: "mini:cc-retry-ok",
        message: "retry then ok",
      }, { "X-Mesh-Node": "macbook:cc-tr-sender" })
      assert.equal(status, 200)
      assert.equal(data.data?.status, "delivered", "重试后应 delivered")
      assert.equal(transport.deliverLog.length - beforeTr, 2, "应调用 2 次 deliver(原 1 + 重试 1)")
    } finally {
      transport.resultSequence = undefined
    }
  })

  it("D29 retry: uplink 全程 false → status: failed,共调 2 次(默认 retry=1)", async () => {
    const beforeTr = transport.deliverLog.length
    transport.resultSequence = [
      { delivered: false, method: "terminal" },
      { delivered: false, method: "terminal" },
    ]
    try {
      const { status, data } = await call("POST", "/send", {
        to: "mini:cc-retry-fail",
        message: "always fail",
      }, { "X-Mesh-Node": "macbook:cc-tr-sender" })
      assert.equal(status, 200)
      assert.equal(data.data?.status, "failed")
      assert.equal(transport.deliverLog.length - beforeTr, 2, "MESH_SEND_RETRY=1 默认应调 2 次")
    } finally {
      transport.resultSequence = undefined
    }
  })

  it("D29 retry: MESH_SEND_RETRY=0 → 禁用重试,只调 1 次", async () => {
    const original = process.env.MESH_SEND_RETRY
    process.env.MESH_SEND_RETRY = "0"
    const beforeTr = transport.deliverLog.length
    transport.result = { delivered: false, method: "terminal" }
    try {
      const { status, data } = await call("POST", "/send", {
        to: "mini:cc-retry-zero",
        message: "no retry",
      }, { "X-Mesh-Node": "macbook:cc-tr-sender" })
      assert.equal(status, 200)
      assert.equal(data.data?.status, "failed")
      assert.equal(transport.deliverLog.length - beforeTr, 1, "MESH_SEND_RETRY=0 时只调 1 次")
    } finally {
      transport.result = { delivered: true, method: "terminal" }
      if (original === undefined) delete process.env.MESH_SEND_RETRY
      else process.env.MESH_SEND_RETRY = original
    }
  })

  it("D29 retry: local 分支不重试(terminal inject fail-fast)", async () => {
    const reg = await call("POST", "/register", {
      shortId: "cc-local-fail",
      sessionId: "sess-local-fail",
      pid: 30099,
      role: "worker",
      description: "local fail-fast",
    })
    const targetId = reg.data.data?.nodeId
    const beforeTr = transport.deliverLog.length
    transport.result = { delivered: false, method: "terminal" }
    try {
      const { status, data } = await call("POST", "/send", {
        to: targetId,
        message: "local should not retry",
      }, { "X-Mesh-Node": "macbook:cc-tr-sender" })
      assert.equal(status, 200)
      assert.equal(data.data?.status, "failed")
      assert.equal(transport.deliverLog.length - beforeTr, 1, "local 分支应只调 1 次,不重试")
    } finally {
      transport.result = { delivered: true, method: "terminal" }
    }
  })

  it("/api/broadcast 走 transport.deliver", async () => {
    await call("POST", "/register", {
      shortId: "cc-tr-bcast",
      sessionId: "sess-tr-bcast",
      pid: 30002,
      role: "worker",
      description: "broadcast member",
    })
    const beforeTerm = term.injectLog.length
    const beforeTr = transport.deliverLog.length
    const { status, data } = await call("POST", "/broadcast", {
      message: "broadcast via transport",
      type: "system",
    }, { "X-Mesh-Node": "macbook:cc-tr-sender" })
    assert.equal(status, 200)
    assert.equal(data.ok, true)
    assert.ok(transport.deliverLog.length > beforeTr, "transport.deliver should be called for broadcast")
    assert.equal(term.injectLog.length, beforeTerm, "terminal.inject should NOT be called when transport provided")
  })

  // ===== T2: Hub 节点同步（register/unregister 应触发 uplink.sendRegistration）=====
  it("POST /api/register 成功后调用 uplink.sendRegistration(registry.list())", async () => {
    // 独立 server 以便注入 mock uplink
    const db2 = path.join(os.tmpdir(), `mesh-hub-sync-reg-${Date.now()}.db`)
    const term2 = new MockTerminal()
    const tr2 = new MockTransport()
    const sendRegistrationLog: Array<any[]> = []
    const mockUplink = {
      isConnected: () => true,
      sendRegistration: async (nodes: any[]) => { sendRegistrationLog.push(nodes) },
    }
    const app = createServer({
      dbPath: db2,
      deviceId: "macbook",
      terminal: term2,
      transport: tr2,
      uplink: mockUplink,
    } as any)
    const s2 = await new Promise<Server>((resolve) => {
      const x = app.listen(0, () => resolve(x))
    })
    const addr = s2.address() as AddressInfo
    const u2 = `http://localhost:${addr.port}/api`
    try {
      const res = await fetch(`${u2}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shortId: "cc-hs1", sessionId: "sess-hs1",
          pid: 50001, role: "worker", description: "hub sync",
        }),
      })
      assert.equal(res.status, 200)
      assert.equal(sendRegistrationLog.length, 1, "注册后应调用一次 sendRegistration")
      const nodes = sendRegistrationLog[0]
      assert.ok(Array.isArray(nodes))
      assert.ok(nodes.some((n: any) => n.shortId === "cc-hs1"), "sendRegistration 参数应包含新节点 identity")
    } finally {
      await new Promise<void>((r) => s2.close(() => r()))
      try { fs.unlinkSync(db2) } catch {}
      try { fs.unlinkSync(db2 + "-wal") } catch {}
      try { fs.unlinkSync(db2 + "-shm") } catch {}
    }
  })

  it("DELETE /api/register/:nodeId 成功后调用 uplink.sendRegistration（不含已注销节点）", async () => {
    const db2 = path.join(os.tmpdir(), `mesh-hub-sync-del-${Date.now()}.db`)
    const term2 = new MockTerminal()
    const tr2 = new MockTransport()
    const sendRegistrationLog: Array<any[]> = []
    const mockUplink = {
      isConnected: () => true,
      sendRegistration: async (nodes: any[]) => { sendRegistrationLog.push(nodes) },
    }
    const app = createServer({
      dbPath: db2,
      deviceId: "macbook",
      terminal: term2,
      transport: tr2,
      uplink: mockUplink,
    } as any)
    const s2 = await new Promise<Server>((resolve) => {
      const x = app.listen(0, () => resolve(x))
    })
    const addr = s2.address() as AddressInfo
    const u2 = `http://localhost:${addr.port}/api`
    try {
      const reg = await fetch(`${u2}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shortId: "cc-del-sync", sessionId: "sess-del-sync",
          pid: 50002, role: "worker", description: "del sync",
        }),
      })
      const nodeId = (await reg.json()).data.nodeId
      const beforeDel = sendRegistrationLog.length

      const del = await fetch(`${u2}/register/${encodeURIComponent(nodeId)}`, { method: "DELETE" })
      assert.equal(del.status, 200)
      assert.equal(sendRegistrationLog.length, beforeDel + 1, "注销后应调用一次 sendRegistration")
      const nodes = sendRegistrationLog[sendRegistrationLog.length - 1]
      assert.ok(!nodes.some((n: any) => n.nodeId === nodeId), "sendRegistration 不应再包含已注销节点")
    } finally {
      await new Promise<void>((r) => s2.close(() => r()))
      try { fs.unlinkSync(db2) } catch {}
      try { fs.unlinkSync(db2 + "-wal") } catch {}
      try { fs.unlinkSync(db2 + "-shm") } catch {}
    }
  })

  it("DELETE /api/register 清空后调用 uplink.sendRegistration([])", async () => {
    const db2 = path.join(os.tmpdir(), `mesh-hub-sync-clear-${Date.now()}.db`)
    const term2 = new MockTerminal()
    const tr2 = new MockTransport()
    const sendRegistrationLog: Array<any[]> = []
    const mockUplink = {
      isConnected: () => true,
      sendRegistration: async (nodes: any[]) => { sendRegistrationLog.push(nodes) },
    }
    const app = createServer({
      dbPath: db2,
      deviceId: "macbook",
      terminal: term2,
      transport: tr2,
      uplink: mockUplink,
    } as any)
    const s2 = await new Promise<Server>((resolve) => {
      const x = app.listen(0, () => resolve(x))
    })
    const addr = s2.address() as AddressInfo
    const u2 = `http://localhost:${addr.port}/api`
    try {
      await fetch(`${u2}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shortId: "cc-clear-sync", sessionId: "sess-clear-sync",
          pid: 50004, role: "worker", description: "clear sync",
        }),
      })
      const beforeClear = sendRegistrationLog.length

      const del = await fetch(`${u2}/register`, { method: "DELETE" })
      assert.equal(del.status, 200)
      assert.equal(sendRegistrationLog.length, beforeClear + 1, "清空后应调用一次 sendRegistration")
      assert.deepEqual(sendRegistrationLog[sendRegistrationLog.length - 1], [])
    } finally {
      await new Promise<void>((r) => s2.close(() => r()))
      try { fs.unlinkSync(db2) } catch {}
      try { fs.unlinkSync(db2 + "-wal") } catch {}
      try { fs.unlinkSync(db2 + "-shm") } catch {}
    }
  })

  it("uplink 未连接时 register 不报错也不调 sendRegistration", async () => {
    const db2 = path.join(os.tmpdir(), `mesh-hub-sync-off-${Date.now()}.db`)
    const term2 = new MockTerminal()
    const tr2 = new MockTransport()
    const sendRegistrationLog: Array<any[]> = []
    const mockUplink = {
      isConnected: () => false,
      sendRegistration: async (nodes: any[]) => { sendRegistrationLog.push(nodes) },
    }
    const app = createServer({
      dbPath: db2,
      deviceId: "macbook",
      terminal: term2,
      transport: tr2,
      uplink: mockUplink,
    } as any)
    const s2 = await new Promise<Server>((resolve) => {
      const x = app.listen(0, () => resolve(x))
    })
    const addr = s2.address() as AddressInfo
    const u2 = `http://localhost:${addr.port}/api`
    try {
      const res = await fetch(`${u2}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shortId: "cc-off-sync", sessionId: "sess-off-sync",
          pid: 50003, role: "worker", description: "off",
        }),
      })
      assert.equal(res.status, 200)
      assert.equal(sendRegistrationLog.length, 0, "uplink 未连接时不应调用 sendRegistration")
    } finally {
      await new Promise<void>((r) => s2.close(() => r()))
      try { fs.unlinkSync(db2) } catch {}
      try { fs.unlinkSync(db2 + "-wal") } catch {}
      try { fs.unlinkSync(db2 + "-shm") } catch {}
    }
  })

  it("/api/broadcast 对本地注册节点用 type:local，不自动伪造 remote target（远端广播由 uplink 层自己处理）", async () => {
    const beforeTr = transport.deliverLog.length
    const { status, data } = await call("POST", "/broadcast", {
      message: "scope check",
      type: "system",
    }, { "X-Mesh-Node": "macbook:cc-tr-sender" })
    assert.equal(status, 200)
    assert.equal(data.ok, true)
    const newly = transport.deliverLog.slice(beforeTr)
    for (const entry of newly) {
      assert.equal(entry.target.type, "local", "broadcast 只对本地 registry 节点调 transport，remote 由 uplink 层处理")
    }
  })
})

// ===== M2: deliveryMode 分派 + 安全红线 + 诚实降级 =====
// 无 transport 分支：deliverLocal 直接走 terminal.inject，用 mockTerminal.injectLog 观测。
// 注入 events 观察 msg:send。
describe("Server — M2 deliveryMode 分派 + 安全红线 + 降级", () => {
  let s: Server
  let url: string
  let db: string
  let term: MockTerminal
  let bus: MeshEventBus
  let app: MeshServerLike

  before(async () => {
    db = path.join(os.tmpdir(), `mesh-m2-${Date.now()}.db`)
    term = new MockTerminal()
    bus = new MeshEventBus()
    app = createServer({
      dbPath: db,
      deviceId: "macbook",
      terminal: term,
      events: bus,
    } as any) as unknown as MeshServerLike
    s = await new Promise<Server>((resolve) => {
      const x = (app as any).listen(0, () => resolve(x))
    })
    const addr = s.address() as AddressInfo
    url = `http://localhost:${addr.port}/api`
  })

  after(async () => {
    await new Promise<void>((resolve) => s.close(() => resolve()))
    try { fs.unlinkSync(db) } catch {}
    try { fs.unlinkSync(db + "-wal") } catch {}
    try { fs.unlinkSync(db + "-shm") } catch {}
  })

  async function call(method: string, p: string, body?: unknown, headers?: Record<string, string>) {
    const opts: RequestInit = { method, headers: { "Content-Type": "application/json", ...headers } }
    if (body) opts.body = JSON.stringify(body)
    const res = await fetch(`${url}${p}`, opts)
    const data = await res.json().catch(() => null)
    return { status: res.status, data }
  }

  async function registerSsePull(shortId: string): Promise<string> {
    const reg = await call("POST", "/register", {
      shortId, pid: 1, role: "worker", description: "sse-pull", deliveryMode: "sse-pull",
    })
    return reg.data.data.nodeId
  }

  // ===== B2: sse-pull → accepted + inject 计数 0 =====
  it("sse-pull 节点 send：status=accepted 且 terminal.inject 计数为 0", async () => {
    const targetId = await registerSsePull("cc-m2-pull1")
    const beforeLen = term.injectLog.length
    const { status, data } = await call("POST", "/send", {
      to: targetId, message: "hello pull",
    }, { "X-Mesh-Node": "macbook:cc-m2-sender" })
    assert.equal(status, 200)
    assert.equal(data.data?.status, "accepted", "sse-pull 应返回 accepted（非 delivered/failed）")
    assert.equal(term.injectLog.length, beforeLen, "sse-pull 不应调 terminal.inject")
  })

  it("sse-pull 节点 send：emit msg:send 事件 status=accepted", async () => {
    const targetId = await registerSsePull("cc-m2-pull2")
    const received: any[] = []
    const fn = (d: any) => received.push(d)
    bus.on("msg:send", fn)
    try {
      await call("POST", "/send", {
        to: targetId, message: "ring the bell",
      }, { "X-Mesh-Node": "macbook:cc-m2-sender" })
    } finally {
      bus.off("msg:send", fn)
    }
    const evt = received.find((d) => d.to === targetId)
    assert.ok(evt, "应 emit msg:send 含目标 to")
    assert.equal(evt.status, "accepted", "msg:send 事件 status 应为 accepted")
  })

  // ===== B3: inject → delivered =====
  it("inject 节点 send：走 terminal.inject 且 status=delivered", async () => {
    const reg = await call("POST", "/register", {
      shortId: "cc-m2-inj", sessionId: "sess-recv", pid: 2, role: "worker", description: "inject",
      deliveryMode: "inject",
    })
    const targetId = reg.data.data.nodeId
    const senderId = "macbook:cc-m2-sender"
    const beforeLen = term.injectLog.length
    const { status, data } = await call("POST", "/send", {
      to: targetId, message: "hello inject",
    }, { "X-Mesh-Node": senderId })
    assert.equal(status, 200)
    assert.equal(data.data?.status, "delivered")
    assert.equal(term.injectLog.length, beforeLen + 1, "inject 应调一次 terminal.inject")
    const last = term.injectLog[term.injectLog.length - 1]
    assert.equal(last.sessionId, "sess-recv")
    assert.ok(last.text.startsWith(`[mesh:${senderId}] `), `应带前缀，实际: ${last.text}`)
  })

  // ===== B4: 白名单 — 非 sse-pull 一律走 inject（含缺省兜底） =====
  it("deliverLocal 白名单：缺省 deliveryMode（老节点）→ 走 inject delivered", async () => {
    // 直注一个 identity 无 deliveryMode 的节点，模拟老节点（register 路径会落 inject 缺省，
    // 这里直注让 deliveryMode=undefined，验证 deliverLocal 读取侧 ?? 'inject' 兜底）
    const nodeId = "macbook:cc-m2-legacy"
    app.registry.register({
      identity: { nodeId, deviceId: "macbook", shortId: "cc-m2-legacy", role: "worker", description: "legacy", capabilities: [] },
      sessionId: "sess-legacy", pid: 3, lastSeen: new Date().toISOString(), status: "idle",
    } as any)
    const beforeLen = term.injectLog.length
    const { data } = await call("POST", "/send", {
      to: nodeId, message: "legacy fallback",
    }, { "X-Mesh-Node": "macbook:cc-m2-sender" })
    assert.equal(data.data?.status, "delivered")
    assert.equal(term.injectLog.length, beforeLen + 1, "缺省应走 inject（?? 'inject' 兜底）")
  })

  it("deliverLocal 白名单：显式 inject → 走 inject delivered", async () => {
    const reg = await call("POST", "/register", {
      shortId: "cc-m2-inj2", sessionId: "sess-inj2", pid: 4, role: "worker", description: "inject2",
      deliveryMode: "inject",
    })
    const targetId = reg.data.data.nodeId
    const beforeLen = term.injectLog.length
    const { data } = await call("POST", "/send", {
      to: targetId, message: "explicit inject",
    }, { "X-Mesh-Node": "macbook:cc-m2-sender" })
    assert.equal(data.data?.status, "delivered")
    assert.equal(term.injectLog.length, beforeLen + 1)
  })

  // ===== C1: 安全断言 — 空 sessionId 的 inject 节点 → failed + 告警，绝不调 inject =====
  it("C1：sessionId 为空 → inject 路径 failed+告警，绝不调 terminal.inject", async () => {
    const { mock } = await import("node:test")
    const nodeId = "macbook:cc-m2-empty"
    // 直注一个 deliveryMode=inject 但 sessionId 为空串的节点
    app.registry.register({
      identity: { nodeId, deviceId: "macbook", shortId: "cc-m2-empty", role: "worker", description: "empty", capabilities: [], deliveryMode: "inject" },
      sessionId: "", pid: 5, lastSeen: new Date().toISOString(), status: "idle",
    } as any)
    const beforeLen = term.injectLog.length
    const warnSpy = mock.method(console, "warn", () => {})
    let data: any
    try {
      const r = await call("POST", "/send", {
        to: nodeId, message: "should not inject",
      }, { "X-Mesh-Node": "macbook:cc-m2-sender" })
      data = r.data
    } finally {
      warnSpy.mock.restore()
    }
    assert.equal(data.data?.status, "failed", "空 sessionId 的 inject 应 failed")
    assert.equal(term.injectLog.length, beforeLen, "空 sessionId 绝不调 terminal.inject")
    assert.ok(warnSpy.mock.callCount() >= 1, "应告警一次")
  })

  // ===== C1/C2: nopane- 前缀的 inject 节点 → failed，绝不喂进 inject =====
  it("C1：sessionId 带 nopane- 前缀的 inject 节点 → failed，绝不调 terminal.inject", async () => {
    const { mock } = await import("node:test")
    const nodeId = "macbook:cc-m2-nopane"
    app.registry.register({
      identity: { nodeId, deviceId: "macbook", shortId: "cc-m2-nopane", role: "worker", description: "nopane", capabilities: [], deliveryMode: "inject" },
      sessionId: "nopane-macbook:cc-m2-nopane", pid: 6, lastSeen: new Date().toISOString(), status: "idle",
    } as any)
    const beforeLen = term.injectLog.length
    const warnSpy = mock.method(console, "warn", () => {})
    let data: any
    try {
      const r = await call("POST", "/send", {
        to: nodeId, message: "should not feed paste-buffer",
      }, { "X-Mesh-Node": "macbook:cc-m2-sender" })
      data = r.data
    } finally {
      warnSpy.mock.restore()
    }
    assert.equal(data.data?.status, "failed")
    assert.equal(term.injectLog.length, beforeLen, "nopane- 占位绝不进 terminal.inject")
    assert.ok(warnSpy.mock.callCount() >= 1, "应告警")
  })

  // ===== C2: sse-pull 占位 sessionId 永不被 pickFor 喂到（inject 计数 0） =====
  it("C2：sse-pull 节点 send 时占位 sessionId(nopane-)永不被喂进 inject", async () => {
    const targetId = await registerSsePull("cc-m2-c2")
    const beforeLen = term.injectLog.length
    const { data } = await call("POST", "/send", {
      to: targetId, message: "no inject for placeholder",
    }, { "X-Mesh-Node": "macbook:cc-m2-sender" })
    assert.equal(term.injectLog.length, beforeLen, "占位 sessionId 从未进入 terminal.inject")
    assert.equal(data.data?.status, "accepted")
  })

  // ===== F1(PR2 收敛): native-api → pull → accepted，消息落库可自取 =====
  // unsupported-actuator 不再产生:native-api 归一为 pull,端点经 /api/sync 自取即实时可达。
  it("F1：native-api 节点 send → accepted(收敛进 pull),不注入,消息落库", async () => {
    const reg = await call("POST", "/register", {
      shortId: "cc-m2-native", pid: 7, role: "service", description: "native app",
      deliveryMode: "native-api",
    })
    const targetId = reg.data.data.nodeId
    const beforeLen = term.injectLog.length
    const { status, data } = await call("POST", "/send", {
      to: targetId, message: "queue me only",
    }, { "X-Mesh-Node": "macbook:cc-m2-sender" })
    assert.equal(status, 200)
    assert.equal(data.data?.status, "accepted", "native-api 收敛 pull 后应 accepted")
    assert.equal(term.injectLog.length, beforeLen, "pull 形态不 inject")
    // 消息落库：GET inbox 能查到
    const inbox = await call("GET", `/inbox?nodeId=${encodeURIComponent(targetId)}`)
    const found = inbox.data.data.messages.find((m: any) => m.payload === "queue me only")
    assert.ok(found, "pull 形态消息落库,端点自取")
  })
})

// MeshServer 暴露 registry/store 给测试直注
type MeshServerLike = {
  registry: { register: (node: unknown) => void }
  listen: (...args: any[]) => Server
}

// ===== 云端账本 M1/M2：@ledger 哨兵 + /api/dispatch =====
// 哨兵语义（设计 §4.3）：to=@ledger 只落库不投递——不注入终端、不广播、不走 uplink。
// 派单语义（设计 §6）：type=task + meta._task 信封，payload 原文零污染，与 send 共用投递内核。
describe("Server — @ledger 哨兵 + /api/dispatch（云端账本接缝）", () => {
  let s: Server
  let url: string
  let db: string
  let term: MockTerminal
  let bus: MeshEventBus
  let app: any
  let transportCalls: Array<{ target: any; text: string }>

  before(async () => {
    db = path.join(os.tmpdir(), `mesh-ledger-api-${Date.now()}.db`)
    term = new MockTerminal()
    bus = new MeshEventBus()
    transportCalls = []
    app = createServer({
      dbPath: db,
      deviceId: "macbook",
      terminal: term,
      events: bus,
      transport: {
        async deliver(target: any, text: string) {
          transportCalls.push({ target, text })
          return { delivered: true, method: "uplink" as const }
        },
      },
    } as any)
    s = await new Promise<Server>((resolve) => {
      const x = (app as any).listen(0, () => resolve(x))
    })
    const addr = s.address() as AddressInfo
    url = `http://localhost:${addr.port}/api`
  })

  after(async () => {
    await new Promise<void>((resolve) => s.close(() => resolve()))
    try { fs.unlinkSync(db) } catch {}
    try { fs.unlinkSync(db + "-wal") } catch {}
    try { fs.unlinkSync(db + "-shm") } catch {}
  })

  async function call(method: string, p: string, body?: unknown, headers?: Record<string, string>) {
    const opts: RequestInit = { method, headers: { "Content-Type": "application/json", ...headers } }
    if (body) opts.body = JSON.stringify(body)
    const res = await fetch(`${url}${p}`, opts)
    const data = await res.json().catch(() => null)
    return { status: res.status, data }
  }

  async function registerInject(shortId: string): Promise<string> {
    const reg = await call("POST", "/register", {
      shortId, sessionId: `sess-${shortId}`, pid: 1, role: "worker", description: "inject worker",
    })
    return reg.data.data.nodeId
  }

  function rowOf(msgId: string): any {
    return app.store.getMessagesSinceSeq(0, 1000).find((r: any) => r.id === msgId)
  }

  // ===== @ledger 哨兵 =====

  it("send 到 @ledger：200 + status=delivered（落库即送达）", async () => {
    const { status, data } = await call("POST", "/send", {
      to: "@ledger", message: '{"probe":"codex"}', type: "quota_report",
    }, { "X-Mesh-Node": "macbook:cc-quota" })
    assert.equal(status, 200)
    assert.equal(data.ok, true)
    assert.equal(data.data.status, "delivered")
  })

  it("@ledger 不注入终端、不广播、不走 uplink（只落库）", async () => {
    await registerInject("cc-ldg-bystander")
    const injectBefore = term.injectLog.length
    const transportBefore = transportCalls.length
    await call("POST", "/send", {
      to: "@ledger", message: "记一笔", type: "quota_report",
    }, { "X-Mesh-Node": "macbook:cc-quota" })
    assert.equal(term.injectLog.length, injectBefore, "哨兵消息绝不进 terminal.inject")
    assert.equal(transportCalls.length, transportBefore, "哨兵消息绝不走 uplink/transport")
  })

  it("@ledger 消息落库：type 自由字符串保留，status=delivered，账本取数口可见", async () => {
    const { data } = await call("POST", "/send", {
      to: "@ledger", message: '{"pct_5h":42}', type: "quota_report",
    }, { "X-Mesh-Node": "macbook:cc-quota" })
    const row = rowOf(data.data.msgId)
    assert.ok(row, "getMessagesSinceSeq 必须能取到哨兵行（LedgerSync 就靠它上行）")
    assert.equal(row.to, "@ledger")
    assert.equal(row.type, "quota_report", "type 不收紧校验（quota_report 已在用）")
    assert.equal(row.status, "delivered")
    assert.equal(row.payload, '{"pct_5h":42}')
  })

  it("@ledger 不污染别的节点收件箱", async () => {
    const nodeId = await registerInject("cc-ldg-inbox")
    const { data } = await call("POST", "/send", {
      to: "@ledger", message: "not for you", type: "quota_report",
    }, { "X-Mesh-Node": "macbook:cc-quota" })
    const inbox = await call("GET", `/inbox?nodeId=${encodeURIComponent(nodeId)}`)
    const leaked = inbox.data.data.messages.find((m: any) => m.id === data.data.msgId)
    assert.equal(leaked, undefined, "to=@ledger 不匹配任何节点，也不是广播")
  })

  it("@ledger 照常 emit msg:send（账本同步靠这个信号触发 debounce）", async () => {
    const received: any[] = []
    const fn = (d: any) => received.push(d)
    bus.on("msg:send", fn)
    try {
      await call("POST", "/send", { to: "@ledger", message: "ring", type: "quota_report" },
        { "X-Mesh-Node": "macbook:cc-quota" })
    } finally {
      bus.off("msg:send", fn)
    }
    assert.equal(received.length, 1)
    assert.equal(received[0].to, "@ledger")
    assert.equal(received[0].status, "delivered")
  })

  it("普通节点消息零回归：仍正常投递 + delivered", async () => {
    const nodeId = await registerInject("cc-ldg-normal")
    const before = transportCalls.length
    const { status, data } = await call("POST", "/send", {
      to: nodeId, message: "hello normal",
    }, { "X-Mesh-Node": "macbook:cc-sender" })
    assert.equal(status, 200)
    assert.equal(data.data.status, "delivered")
    assert.equal(transportCalls.length, before + 1, "普通消息照常经投递器出去")
    assert.equal(transportCalls[transportCalls.length - 1].target.type, "local")
  })

  // ===== /api/dispatch =====

  it("缺 to → 400 带 error", async () => {
    const { status, data } = await call("POST", "/dispatch", { title: "干活", payload: "跑测试" })
    assert.equal(status, 400)
    assert.equal(data.ok, false)
    assert.match(data.error, /to/)
  })

  it("缺 title / 缺 payload → 400", async () => {
    const noTitle = await call("POST", "/dispatch", { payload: "x", to: "macbook:cc-x" })
    assert.equal(noTitle.status, 400)
    assert.match(noTitle.data.error, /title/)
    const noPayload = await call("POST", "/dispatch", { title: "t", to: "macbook:cc-x" })
    assert.equal(noPayload.status, 400)
    assert.match(noPayload.data.error, /payload/)
    const blankTitle = await call("POST", "/dispatch", { title: "   ", payload: "x", to: "macbook:cc-x" })
    assert.equal(blankTitle.status, 400)
  })

  it("目标未注册 / 裸 shortId → 400（与 /api/send 同一套目标校验）", async () => {
    const ghost = await call("POST", "/dispatch", { title: "t", payload: "p", to: "macbook:cc-ghost" })
    assert.equal(ghost.status, 400)
    const bare = await call("POST", "/dispatch", { title: "t", payload: "p", to: "cc-ghost" })
    assert.equal(bare.status, 400)
  })

  it("happy path：200 + DispatchResult{taskId=msgId, pick.reason=explicit}", async () => {
    const nodeId = await registerInject("cc-disp-1")
    const { status, data } = await call("POST", "/dispatch", {
      title: "跑回归", payload: "pnpm test", project: "P62",
    }, { "X-Mesh-Node": "macbook:cc-brain" })
    assert.equal(status, 400, "上一行故意不带 to —— 保证 happy path 用例自己不误报")
    const ok = await call("POST", "/dispatch", {
      title: "跑回归", payload: "pnpm test", to: nodeId, project: "P62",
    }, { "X-Mesh-Node": "macbook:cc-brain" })
    assert.equal(ok.status, 200)
    assert.equal(ok.data.ok, true)
    assert.equal(ok.data.data.taskId, ok.data.data.msgId, "taskId 就是派单消息 id")
    assert.deepEqual(ok.data.data.pick, { nodeId, reason: "explicit" })
    assert.equal(ok.data.data.status, "delivered")
  })

  it("消息形状：type=task、payload 原文零污染、meta._task 带 title/project/pickReason", async () => {
    const nodeId = await registerInject("cc-disp-2")
    const payload = "把 P62 的 M1 跑绿\n第二行也要原样保留"
    const { data } = await call("POST", "/dispatch", {
      title: "M1 收口", payload, to: nodeId, project: "P62",
    }, { "X-Mesh-Node": "macbook:cc-brain" })
    const row = rowOf(data.data.msgId)
    assert.ok(row)
    assert.equal(row.type, "task")
    assert.equal(row.payload, payload, "payload 必须是原文，不包任何信封")
    assert.deepEqual(row.meta, { _task: { title: "M1 收口", project: "P62", pickReason: "explicit" } })
    assert.equal(row.from, "macbook:cc-brain")
    assert.equal(row.to, nodeId)
  })

  it("投递到 pane 的正文只有 payload（meta 不进终端）", async () => {
    const nodeId = await registerInject("cc-disp-3")
    const payload = "只注入这一句"
    await call("POST", "/dispatch", { title: "标题不许出现", payload, to: nodeId },
      { "X-Mesh-Node": "macbook:cc-brain" })
    const last = transportCalls[transportCalls.length - 1]
    assert.equal(last.text, `[mesh:macbook:cc-brain] ${payload}`, "只有既有的 [mesh:from] 前缀 + 原文")
    assert.ok(!last.text.includes("标题不许出现"), "meta.title 绝不进投递正文")
    assert.ok(!last.text.includes("_task"), "meta 信封绝不进投递正文")
  })

  it("project 缺省时 meta._task 不带 project 键（不写 null/undefined 噪音）", async () => {
    const nodeId = await registerInject("cc-disp-4")
    const { data } = await call("POST", "/dispatch", { title: "无项目", payload: "p", to: nodeId },
      { "X-Mesh-Node": "macbook:cc-brain" })
    assert.deepEqual(rowOf(data.data.msgId).meta, { _task: { title: "无项目", pickReason: "explicit" } })
  })

  it("constraints.priority 走既有 normalizePriority（合法透传 / 非法回落 normal）", async () => {
    const nodeId = await registerInject("cc-disp-5")
    const urgent = await call("POST", "/dispatch", {
      title: "急件", payload: "p", to: nodeId, constraints: { priority: "urgent" },
    }, { "X-Mesh-Node": "macbook:cc-brain" })
    assert.equal(rowOf(urgent.data.data.msgId).priority, "urgent")

    const junk = await call("POST", "/dispatch", {
      title: "乱填", payload: "p", to: nodeId, constraints: { priority: "超级加急" },
    }, { "X-Mesh-Node": "macbook:cc-brain" })
    assert.equal(rowOf(junk.data.data.msgId).priority, "normal")

    const none = await call("POST", "/dispatch", { title: "不填", payload: "p", to: nodeId },
      { "X-Mesh-Node": "macbook:cc-brain" })
    assert.equal(rowOf(none.data.data.msgId).priority, "normal")
  })

  it("派单消息进目标 inbox（复用 send 的落库/投递路径，不是第二套管道）", async () => {
    const nodeId = await registerInject("cc-disp-6")
    const { data } = await call("POST", "/dispatch", { title: "查收", payload: "task body", to: nodeId },
      { "X-Mesh-Node": "macbook:cc-brain" })
    const inbox = await call("GET", `/inbox?nodeId=${encodeURIComponent(nodeId)}`)
    const found = inbox.data.data.messages.find((m: any) => m.id === data.data.msgId)
    assert.ok(found, "派单消息必须能被目标节点自取")
    assert.equal(found.type, "task")
  })

  it("pull 形态目标：派单返回 accepted（形态分派复用 send 内核）", async () => {
    const reg = await call("POST", "/register", {
      shortId: "cc-disp-pull", pid: 2, role: "worker", description: "pull", deliveryMode: "sse-pull",
    })
    const nodeId = reg.data.data.nodeId
    const before = transportCalls.length
    const { data } = await call("POST", "/dispatch", { title: "给 pull 的活", payload: "p", to: nodeId },
      { "X-Mesh-Node": "macbook:cc-brain" })
    assert.equal(data.data.status, "accepted")
    assert.equal(transportCalls.length, before, "pull 形态不投终端，端点自取")
  })
})

// ===== 跨机派单同一性（真环境 E2E bug 回归）=====
describe("Server — 跨机投递把原件交给 transport（不重铸）", () => {
  let s: Server
  let url: string
  let db: string
  let term: MockTerminal
  let delivered: Array<{ target: any; text: string; msg: any }>

  before(async () => {
    db = path.join(os.tmpdir(), `mesh-remote-ident-${Date.now()}.db`)
    term = new MockTerminal()
    delivered = []
    const app = createServer({
      dbPath: db,
      deviceId: "macbook",
      terminal: term,
      transport: {
        async deliver(target: any, text: string, msg: any) {
          delivered.push({ target, text, msg })
          return { delivered: true, method: "uplink" as const }
        },
      },
    } as any)
    s = await new Promise<Server>((resolve) => {
      const x = (app as any).listen(0, () => resolve(x))
    })
    url = `http://localhost:${(s.address() as AddressInfo).port}/api`
  })

  after(async () => {
    await new Promise<void>((resolve) => s.close(() => resolve()))
    for (const suffix of ["", "-wal", "-shm"]) { try { fs.unlinkSync(db + suffix) } catch {} }
  })

  async function call(method: string, p: string, body?: unknown, headers?: Record<string, string>) {
    const opts: RequestInit = { method, headers: { "Content-Type": "application/json", ...headers } }
    if (body) opts.body = JSON.stringify(body)
    const res = await fetch(`${url}${p}`, opts)
    return { status: res.status, data: await res.json().catch(() => null) }
  }

  it("dispatch 到远端 nodeId：transport 收到原件（type=task + meta + 原 id）", async () => {
    const { status, data } = await call("POST", "/dispatch", {
      title: "E2E-M2-跨机试单", payload: "把 M2 跨机链路验通", to: "workstation:e2e-probe", project: "P62",
    }, { "X-Mesh-Node": "macbook:cc-brain" })

    assert.equal(status, 200)
    assert.equal(delivered.length, 1)
    const sent = delivered[0]
    assert.equal(sent.target.type, "remote")
    assert.ok(sent.msg, "transport 必须拿到原件，否则只能靠 text 重造消息（老 bug）")
    assert.equal(sent.msg.id, data.data.msgId, "跨机发的就是本机落库那条")
    assert.equal(sent.msg.type, "task")
    assert.deepEqual(sent.msg.meta, { _task: { title: "E2E-M2-跨机试单", project: "P62", pickReason: "explicit" } })
    assert.equal(sent.msg.payload, "把 M2 跨机链路验通", "原件 payload 不带前缀")
    assert.equal(sent.text, "[mesh:macbook:cc-brain] 把 M2 跨机链路验通", "text 仍是带前缀的注入文本（老形参不变）")
  })

  it("send 到远端 nodeId：原件同样带过去（chat 也走同一条路）", async () => {
    delivered.length = 0
    const { data } = await call("POST", "/send", {
      to: "workstation:e2e-probe", message: "普通跨机消息", replyTo: "msg-parent-1",
    }, { "X-Mesh-Node": "macbook:cc-brain" })
    const sent = delivered[0]
    assert.equal(sent.msg.id, data.data.msgId)
    assert.equal(sent.msg.type, "chat")
    assert.equal(sent.msg.replyTo, "msg-parent-1", "replyTo 跨机保真——否则云端投影对不上 task_id")
    assert.equal(sent.msg.payload, "普通跨机消息")
  })
})
