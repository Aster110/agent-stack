/**
 * WebSocketUplink 测试 — 启动真实 WS server（port 0）
 *
 * 覆盖：
 * - connect 成功后 isConnected() true，立即发送 register
 * - send(msg) 在未连接时返回 false
 * - send(msg) 连接后以 UplinkMessage{type:"message"} 序列化发送
 * - onMessage 收到 DownlinkMessage{type:"message"} 时触发回调（仅解包为 MeshMessage）
 * - 断开后 5s setTimeout 重连
 * - disconnect 后不再重连
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { WebSocketServer, WebSocket } from "ws"
import type { AddressInfo } from "node:net"
import { WebSocketUplink, resolveHubToken } from "./websocket.js"
import type { UplinkMessage, DownlinkMessage, MeshMessage, RelayRegistration, DeviceInventory } from "@cc-mesh/protocol"

function mkReg(relayId: string): RelayRegistration {
  return { relayId, deviceId: relayId, nodes: [], connectedAt: new Date().toISOString() }
}

async function startServer(opts?: { ackMode?: "delivered" | "queued" | "none" }): Promise<{
  wss: WebSocketServer
  url: string
  received: Array<{ ws: WebSocket; msg: UplinkMessage }>
  close: () => Promise<void>
}> {
  const ackMode = opts?.ackMode ?? "delivered"
  const wss = new WebSocketServer({ port: 0 })
  await new Promise<void>((r) => wss.once("listening", () => r()))
  const port = (wss.address() as AddressInfo).port
  const received: Array<{ ws: WebSocket; msg: UplinkMessage }> = []
  wss.on("connection", (ws) => {
    ws.on("message", (data) => {
      const msg = JSON.parse(String(data)) as UplinkMessage
      received.push({ ws, msg })
      if (msg.type === "message" && ackMode !== "none") {
        ws.send(JSON.stringify({ type: ackMode, msgId: msg.msg.id } as DownlinkMessage))
      }
    })
  })
  return {
    wss,
    url: `ws://localhost:${port}`,
    received,
    close: () => new Promise((r) => wss.close(() => r())),
  }
}

describe("WebSocketUplink", () => {
  it("connect 后立即发送 register + isConnected()=true", async () => {
    const srv = await startServer()
    const uplink = new WebSocketUplink({
      hubUrl: srv.url,
      getRegistration: () => mkReg("relay-1"),
    })
    await uplink.connect()
    // 给服务端接收 register 的时间
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(uplink.isConnected(), true)
    assert.ok(srv.received.length >= 1)
    assert.equal(srv.received[0].msg.type, "register")
    if (srv.received[0].msg.type === "register") {
      assert.equal(srv.received[0].msg.relay.relayId, "relay-1")
    }

    await uplink.disconnect()
    await srv.close()
  })

  it("未连接时 send() 返回 false", async () => {
    const uplink = new WebSocketUplink({
      hubUrl: "ws://localhost:1",
      getRegistration: () => mkReg("relay-x"),
    })
    const msg: MeshMessage = {
      id: "m1", from: "a", to: "b", type: "chat", payload: "x", createdAt: new Date().toISOString(),
    }
    const ok = await uplink.send(msg)
    assert.equal(ok, false)
  })

  it("send(msg) 以 UplinkMessage{type:message} 序列化发送", async () => {
    const srv = await startServer()
    const uplink = new WebSocketUplink({
      hubUrl: srv.url,
      getRegistration: () => mkReg("relay-snd"),
    })
    await uplink.connect()
    await new Promise((r) => setTimeout(r, 50))

    const msg: MeshMessage = {
      id: "m-send", from: "macbook:cc-a", to: "mini:cc-b",
      type: "chat", payload: "hello", createdAt: new Date().toISOString(),
    }
    const ok = await uplink.send(msg)
    assert.equal(ok, true)
    await new Promise((r) => setTimeout(r, 50))

    const msgMsgs = srv.received.filter((r) => r.msg.type === "message")
    assert.equal(msgMsgs.length, 1)
    if (msgMsgs[0].msg.type === "message") {
      assert.equal(msgMsgs[0].msg.msg.id, "m-send")
      assert.equal(msgMsgs[0].msg.msg.payload, "hello")
    }

    await uplink.disconnect()
    await srv.close()
  })

  it("send(msg) Hub 回 queued 时返回 false", async () => {
    const srv = await startServer({ ackMode: "queued" })
    const uplink = new WebSocketUplink({
      hubUrl: srv.url,
      getRegistration: () => mkReg("relay-q"),
      ackTimeoutMs: 500,
    })
    await uplink.connect()
    await new Promise((r) => setTimeout(r, 30))
    const msg: MeshMessage = {
      id: "m-q", from: "mac:a", to: "mini:nonexistent",
      type: "chat", payload: "x", createdAt: new Date().toISOString(),
    }
    const ok = await uplink.send(msg)
    assert.equal(ok, false)
    await uplink.disconnect()
    await srv.close()
  })

  it("send(msg) Hub 无 ack 时超时返回 false", async () => {
    const srv = await startServer({ ackMode: "none" })
    const uplink = new WebSocketUplink({
      hubUrl: srv.url,
      getRegistration: () => mkReg("relay-t"),
      ackTimeoutMs: 100,
    })
    await uplink.connect()
    await new Promise((r) => setTimeout(r, 30))
    const msg: MeshMessage = {
      id: "m-t", from: "mac:a", to: "mini:z",
      type: "chat", payload: "x", createdAt: new Date().toISOString(),
    }
    const start = Date.now()
    const ok = await uplink.send(msg)
    assert.equal(ok, false)
    assert.ok(Date.now() - start >= 100)
    await uplink.disconnect()
    await srv.close()
  })

  it("onMessage 回调在收到 DownlinkMessage{type:message} 时触发，payload 为 MeshMessage", async () => {
    const srv = await startServer()
    const uplink = new WebSocketUplink({
      hubUrl: srv.url,
      getRegistration: () => mkReg("relay-recv"),
    })
    const received: MeshMessage[] = []
    uplink.onMessage((m) => received.push(m))
    await uplink.connect()
    await new Promise((r) => setTimeout(r, 50))

    const serverWs = srv.received[0].ws
    const down: DownlinkMessage = {
      type: "message",
      msg: {
        id: "inbound-1", from: "mini:cc-b", to: "macbook:cc-a",
        type: "chat", payload: "hi back", createdAt: new Date().toISOString(),
      },
    }
    serverWs.send(JSON.stringify(down))
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(received.length, 1)
    assert.equal(received[0].id, "inbound-1")
    assert.equal(received[0].payload, "hi back")

    await uplink.disconnect()
    await srv.close()
  })

  it("onDevices 回调在收到 DownlinkMessage{type:devices} 时触发，并缓存最新 devices", async () => {
    const srv = await startServer()
    const uplink = new WebSocketUplink({
      hubUrl: srv.url,
      getRegistration: () => mkReg("relay-devices"),
    })
    const received: DeviceInventory[][] = []
    uplink.onDevices((devices) => received.push(devices))
    await uplink.connect()
    await new Promise((r) => setTimeout(r, 50))

    const serverWs = srv.received[0].ws
    const down: DownlinkMessage = {
      type: "devices",
      devices: [
        {
          deviceId: "computer2",
          relayId: "computer2-123",
          nodes: [],
          updatedAt: new Date().toISOString(),
        },
      ],
    }
    serverWs.send(JSON.stringify(down))
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(received.length, 1)
    assert.equal(received[0][0].deviceId, "computer2")
    assert.equal(uplink.getDevices()[0].relayId, "computer2-123")

    await uplink.disconnect()
    await srv.close()
  })

  it("requestSpawn 发送 spawn 请求，并在收到 spawn_result 时返回结果", async () => {
    const srv = await startServer()
    const uplink = new WebSocketUplink({
      hubUrl: srv.url,
      getRegistration: () => mkReg("relay-spawn"),
    })
    await uplink.connect()
    await new Promise((r) => setTimeout(r, 50))

    const pending = uplink.requestSpawn("computer2", { agent: "tcx" })
    await new Promise((r) => setTimeout(r, 50))
    const spawnReq = srv.received.find((r) => r.msg.type === "spawn")
    assert.ok(spawnReq)
    if (spawnReq?.msg.type === "spawn") {
      assert.equal(spawnReq.msg.targetDevice, "computer2")
      assert.equal(spawnReq.msg.spawn.agent, "tcx")
      spawnReq.ws.send(JSON.stringify({
        type: "spawn_result",
        requestId: spawnReq.msg.requestId,
        result: { ok: true, data: { nodeId: "computer2:cc-new" } },
      } satisfies DownlinkMessage))
    }

    const result = await pending
    assert.equal(result.ok, true)
    assert.equal((result.data as any).nodeId, "computer2:cc-new")

    await uplink.disconnect()
    await srv.close()
  })

  it("onSpawnRequest 收到远端 spawn 后执行回调并发送 spawn_result", async () => {
    const srv = await startServer()
    const uplink = new WebSocketUplink({
      hubUrl: srv.url,
      getRegistration: () => mkReg("relay-worker"),
    })
    uplink.onSpawnRequest(async (_requestId, _replyRelayId, spawn) => ({
      ok: true,
      data: { echoedAgent: spawn.agent },
    }))
    await uplink.connect()
    await new Promise((r) => setTimeout(r, 50))

    const serverWs = srv.received[0].ws
    serverWs.send(JSON.stringify({
      type: "spawn",
      requestId: "spawn-r1",
      replyRelayId: "relay-lead",
      spawn: { agent: "tcx" },
    } satisfies DownlinkMessage))
    await new Promise((r) => setTimeout(r, 50))

    const resultMsg = srv.received.find((r) => r.msg.type === "spawn_result")
    assert.ok(resultMsg)
    if (resultMsg?.msg.type === "spawn_result") {
      assert.equal(resultMsg.msg.requestId, "spawn-r1")
      assert.equal(resultMsg.msg.targetRelayId, "relay-lead")
      assert.equal((resultMsg.msg.result.data as any).echoedAgent, "tcx")
    }

    await uplink.disconnect()
    await srv.close()
  })

  it("断开后 ~5s 内自动重连（测试用 200ms 重连间隔）", async () => {
    const srv = await startServer()
    const uplink = new WebSocketUplink({
      hubUrl: srv.url,
      getRegistration: () => mkReg("relay-rc"),
      reconnectMs: 200,
    })
    await uplink.connect()
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(srv.received.filter((r) => r.msg.type === "register").length, 1)

    // 服务端强制断开
    srv.received[0].ws.terminate()
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(uplink.isConnected(), false)

    // 等待重连
    await new Promise((r) => setTimeout(r, 500))
    assert.equal(uplink.isConnected(), true, "应已自动重连")
    // 重连后再次发送 register
    assert.ok(
      srv.received.filter((r) => r.msg.type === "register").length >= 2,
      "重连后应重新发送 register",
    )

    await uplink.disconnect()
    await srv.close()
  })

  it("disconnect() 后不再重连，且不再发送 register", async () => {
    const srv = await startServer()
    const uplink = new WebSocketUplink({
      hubUrl: srv.url,
      getRegistration: () => mkReg("relay-dc"),
      reconnectMs: 100,
    })
    await uplink.connect()
    await new Promise((r) => setTimeout(r, 50))
    const registersBeforeDc = srv.received.filter((r) => r.msg.type === "register").length

    await uplink.disconnect()
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(uplink.isConnected(), false)
    const registersAfterDc = srv.received.filter((r) => r.msg.type === "register").length
    assert.equal(
      registersAfterDc, registersBeforeDc,
      "disconnect 后不应再发送 register（验证无重连）",
    )

    await srv.close()
  })

  it("sendRegistration(nodes) 发送 register 消息，含传入的 nodes 列表", async () => {
    const srv = await startServer()
    const uplink = new WebSocketUplink({
      hubUrl: srv.url,
      getRegistration: () => mkReg("relay-sr"),
    })
    await uplink.connect()
    await new Promise((r) => setTimeout(r, 50))
    const beforeCount = srv.received.filter((r) => r.msg.type === "register").length

    const nodes = [
      { nodeId: "macbook:cc-x", deviceId: "macbook", shortId: "cc-x",
        role: "main" as const, description: "", capabilities: [] },
      { nodeId: "macbook:cc-y", deviceId: "macbook", shortId: "cc-y",
        role: "worker" as const, description: "", capabilities: [] },
    ]
    await (uplink as any).sendRegistration(nodes)
    await new Promise((r) => setTimeout(r, 50))

    const registers = srv.received.filter((r) => r.msg.type === "register")
    assert.equal(registers.length, beforeCount + 1, "应新增一条 register 消息")
    const last = registers[registers.length - 1].msg
    if (last.type === "register") {
      assert.equal(last.relay.relayId, "relay-sr")
      assert.equal(last.relay.nodes.length, 2)
      assert.equal(last.relay.nodes[0].nodeId, "macbook:cc-x")
      assert.equal(last.relay.nodes[1].nodeId, "macbook:cc-y")
    }

    await uplink.disconnect()
    await srv.close()
  })

  it("sendRegistration 未连接时不抛错，且不发送消息", async () => {
    const uplink = new WebSocketUplink({
      hubUrl: "ws://localhost:1",
      getRegistration: () => mkReg("relay-off"),
    })
    await assert.doesNotReject(async () => {
      await (uplink as any).sendRegistration([])
    })
  })

  it("sendRegistration 幂等：多次调用用同一节点列表不出错", async () => {
    const srv = await startServer()
    const uplink = new WebSocketUplink({
      hubUrl: srv.url,
      getRegistration: () => mkReg("relay-idem"),
    })
    await uplink.connect()
    await new Promise((r) => setTimeout(r, 50))
    const before = srv.received.filter((r) => r.msg.type === "register").length

    const nodes = [
      { nodeId: "macbook:cc-i", deviceId: "macbook", shortId: "cc-i",
        role: "main" as const, description: "", capabilities: [] },
    ]
    await (uplink as any).sendRegistration(nodes)
    await (uplink as any).sendRegistration(nodes)
    await new Promise((r) => setTimeout(r, 50))

    const after = srv.received.filter((r) => r.msg.type === "register").length
    assert.equal(after, before + 2, "两次 sendRegistration 应对应两条 register 消息（服务端幂等）")

    await uplink.disconnect()
    await srv.close()
  })

  // ===== D29: 双向 WS frame ping/pong 心跳 =====
  //
  // 这组守护测试验证：
  //   1. relay 端按 MESH_PING_INTERVAL_MS 周期发 ws frame ping
  //   2. server 自动回 pong 时,isConnected() 持续为真
  //   3. server 拒绝回 pong 时,relay 在 MESH_PONG_TIMEOUT_MS 后 terminate + reconnect
  //   4. disconnect() 清理 ping interval,无 timer leak

  function withEnv(env: Record<string, string>, fn: () => Promise<void>): () => Promise<void> {
    return async () => {
      const originals: Record<string, string | undefined> = {}
      for (const k of Object.keys(env)) {
        originals[k] = process.env[k]
        process.env[k] = env[k]
      }
      try {
        await fn()
      } finally {
        for (const k of Object.keys(originals)) {
          if (originals[k] === undefined) delete process.env[k]
          else process.env[k] = originals[k]
        }
      }
    }
  }

  it("ping interval: relay 连上后按间隔发 ws frame ping(server 端 ws.on('ping') 收到)", withEnv(
    { MESH_PING_INTERVAL_MS: "150", MESH_PONG_TIMEOUT_MS: "5000" },
    async () => {
      const srv = await startServer()
      let pingCount = 0
      srv.wss.on("connection", (ws) => {
        ws.on("ping", () => { pingCount += 1 })
      })
      const uplink = new WebSocketUplink({
        hubUrl: srv.url,
        getRegistration: () => mkReg("relay-ping"),
      })
      await uplink.connect()
      await new Promise((r) => setTimeout(r, 600))  // 600ms / 150ms ≈ 3-4 次

      assert.ok(pingCount >= 3, `应至少收到 3 次 ws ping,实际 ${pingCount}`)

      await uplink.disconnect()
      await srv.close()
    },
  ))

  it("pong 接收: server 自动回 pong 时,isConnected() 持续为真", withEnv(
    { MESH_PING_INTERVAL_MS: "100", MESH_PONG_TIMEOUT_MS: "1000" },
    async () => {
      const srv = await startServer()  // 默认 autoPong=true,server 自动回
      const uplink = new WebSocketUplink({
        hubUrl: srv.url,
        getRegistration: () => mkReg("relay-pong"),
      })
      await uplink.connect()
      await new Promise((r) => setTimeout(r, 600))  // 跑 6 次 ping/pong 循环

      assert.equal(uplink.isConnected(), true, "正常 ping/pong 期间 isConnected 必须为真")

      await uplink.disconnect()
      await srv.close()
    },
  ))

  it("pong 超时: server 不回 pong 时,relay terminate + 触发重连", withEnv(
    { MESH_PING_INTERVAL_MS: "100", MESH_PONG_TIMEOUT_MS: "300" },
    async () => {
      // 关掉 server 端的 autoPong,让 client 等不到 pong
      const wss = new WebSocketServer({ port: 0, autoPong: false })
      await new Promise<void>((r) => wss.once("listening", () => r()))
      const port = (wss.address() as { port: number }).port
      let connectionCount = 0
      wss.on("connection", () => { connectionCount += 1 })

      const uplink = new WebSocketUplink({
        hubUrl: `ws://localhost:${port}`,
        getRegistration: () => mkReg("relay-timeout"),
        reconnectMs: 100,  // 加快重连观察
      })
      await uplink.connect()
      assert.equal(connectionCount, 1, "首次 connect 应建立 1 个连接")

      // 等 pong-timeout(300ms) + 重连(100ms) + 缓冲
      await new Promise((r) => setTimeout(r, 800))

      assert.ok(connectionCount >= 2, `pong 超时后应自动重连,connectionCount 实际 ${connectionCount}`)

      await uplink.disconnect()
      await new Promise<void>((r) => wss.close(() => r()))
    },
  ))

  it("disconnect 清理 ping interval(防 timer leak)", withEnv(
    { MESH_PING_INTERVAL_MS: "100", MESH_PONG_TIMEOUT_MS: "5000" },
    async () => {
      const srv = await startServer()
      let pingCount = 0
      srv.wss.on("connection", (ws) => {
        ws.on("ping", () => { pingCount += 1 })
      })
      const uplink = new WebSocketUplink({
        hubUrl: srv.url,
        getRegistration: () => mkReg("relay-cleanup"),
      })
      await uplink.connect()
      await new Promise((r) => setTimeout(r, 350))
      const beforeDisconnect = pingCount

      await uplink.disconnect()
      await new Promise((r) => setTimeout(r, 400))  // disconnect 后再观察

      assert.equal(pingCount, beforeDisconnect, "disconnect 后不应再发任何 ping")

      await srv.close()
    },
  ))

  it("DownlinkMessage{type:delivered|queued|pong} 不触发 onMessage 回调", async () => {
    const srv = await startServer()
    const uplink = new WebSocketUplink({
      hubUrl: srv.url,
      getRegistration: () => mkReg("relay-ack"),
    })
    const received: MeshMessage[] = []
    uplink.onMessage((m) => received.push(m))
    await uplink.connect()
    await new Promise((r) => setTimeout(r, 50))

    const serverWs = srv.received[0].ws
    const downs: DownlinkMessage[] = [
      { type: "delivered", msgId: "x-1" },
      { type: "queued", msgId: "x-2" },
      { type: "pong" },
    ]
    for (const d of downs) serverWs.send(JSON.stringify(d))
    await new Promise((r) => setTimeout(r, 80))

    assert.equal(received.length, 0, "ACK/控制帧不应解包给业务 onMessage 回调")

    await uplink.disconnect()
    await srv.close()
  })
})

// ===== Hub 鉴权 token：register 消息携带 token（含重连）=====
describe("WebSocketUplink token 鉴权", () => {
  const TOKEN = "test-token-abc"

  it("传 token → 首次 register 消息带上 token", async () => {
    const srv = await startServer()
    const uplink = new WebSocketUplink({
      hubUrl: srv.url,
      getRegistration: () => mkReg("relay-tok"),
      token: TOKEN,
    })
    await uplink.connect()
    await new Promise((r) => setTimeout(r, 50))

    const reg = srv.received.find((r) => r.msg.type === "register")
    assert.ok(reg)
    if (reg?.msg.type === "register") {
      assert.equal(reg.msg.token, TOKEN)
      assert.equal(reg.msg.relay.relayId, "relay-tok")
    }
    await uplink.disconnect()
    await srv.close()
  })

  it("不传 token → register 消息不带 token 字段（向后兼容）", async () => {
    const srv = await startServer()
    const uplink = new WebSocketUplink({
      hubUrl: srv.url,
      getRegistration: () => mkReg("relay-notok"),
    })
    await uplink.connect()
    await new Promise((r) => setTimeout(r, 50))

    const reg = srv.received.find((r) => r.msg.type === "register")
    assert.ok(reg)
    if (reg?.msg.type === "register") {
      assert.equal(reg.msg.token, undefined, "无 token 时不应带 token 字段")
    }
    await uplink.disconnect()
    await srv.close()
  })

  it("重连后重发的 register 仍带 token（token 存在实例上）", async () => {
    const srv = await startServer()
    const uplink = new WebSocketUplink({
      hubUrl: srv.url,
      getRegistration: () => mkReg("relay-tok-rc"),
      token: TOKEN,
      reconnectMs: 200,
    })
    await uplink.connect()
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(srv.received.filter((r) => r.msg.type === "register").length, 1)

    // 服务端强制断开 → 触发重连
    srv.received[0].ws.terminate()
    await new Promise((r) => setTimeout(r, 500))

    const registers = srv.received.filter((r) => r.msg.type === "register")
    assert.ok(registers.length >= 2, "重连后应重发 register")
    for (const r of registers) {
      if (r.msg.type === "register") {
        assert.equal(r.msg.token, TOKEN, "每次（含重连）register 都应带 token")
      }
    }
    await uplink.disconnect()
    await srv.close()
  })

  it("sendRegistration(nodes) 也带上 token", async () => {
    const srv = await startServer()
    const uplink = new WebSocketUplink({
      hubUrl: srv.url,
      getRegistration: () => mkReg("relay-tok-sr"),
      token: TOKEN,
    })
    await uplink.connect()
    await new Promise((r) => setTimeout(r, 50))

    const nodes = [
      { nodeId: "macbook:cc-x", deviceId: "macbook", shortId: "cc-x",
        role: "main" as const, description: "", capabilities: [] },
    ]
    await (uplink as any).sendRegistration(nodes)
    await new Promise((r) => setTimeout(r, 50))

    const registers = srv.received.filter((r) => r.msg.type === "register")
    const last = registers[registers.length - 1].msg
    if (last.type === "register") {
      assert.equal(last.token, TOKEN)
      assert.equal(last.relay.nodes.length, 1)
    }
    await uplink.disconnect()
    await srv.close()
  })
})

describe("resolveHubToken（token 来源优先级：env > 文件 > 无）", () => {
  it("env MESH_HUB_TOKEN 优先，且 trim 首尾空白", () => {
    const tok = resolveHubToken({
      env: { MESH_HUB_TOKEN: "  env-tok  " },
      homeDir: "/nonexistent-home-should-not-be-read",
    })
    assert.equal(tok, "env-tok")
  })

  it("env 空/空白 → 落到 ~/.ccmesh/hub-token 文件（trim）", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccmesh-tok-"))
    fs.mkdirSync(path.join(home, ".ccmesh"), { recursive: true })
    fs.writeFileSync(path.join(home, ".ccmesh", "hub-token"), "  file-tok\n")
    try {
      assert.equal(resolveHubToken({ env: {}, homeDir: home }), "file-tok")
      assert.equal(resolveHubToken({ env: { MESH_HUB_TOKEN: "   " }, homeDir: home }), "file-tok")
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it("env 空 + 文件不存在 → undefined（行为不变）", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccmesh-notok-"))
    try {
      assert.equal(resolveHubToken({ env: {}, homeDir: home }), undefined)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it("env 与文件同时存在 → 取 env", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccmesh-both-"))
    fs.mkdirSync(path.join(home, ".ccmesh"), { recursive: true })
    fs.writeFileSync(path.join(home, ".ccmesh", "hub-token"), "file-tok")
    try {
      assert.equal(resolveHubToken({ env: { MESH_HUB_TOKEN: "env-wins" }, homeDir: home }), "env-wins")
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it("空文件（trim 后为空）→ undefined", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccmesh-empty-"))
    fs.mkdirSync(path.join(home, ".ccmesh"), { recursive: true })
    fs.writeFileSync(path.join(home, ".ccmesh", "hub-token"), "   \n")
    try {
      assert.equal(resolveHubToken({ env: {}, homeDir: home }), undefined)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

// ===== 云端账本 M1：ledger 帧收发（B2 的线上接缝）=====
describe("WebSocketUplink — ledger 上行 / ledger_ack 下行", () => {
  const sampleEvents = [
    {
      kind: "message" as const,
      msg: { id: "lm-1", from: "macbook:cc-a", to: "@ledger", type: "quota_report" as any, payload: "{}", createdAt: new Date().toISOString(), seq: 7 },
      status: "delivered" as const,
      priority: "normal" as const,
      srcSeq: 7,
    },
  ]

  it("sendLedger 以 UplinkMessage{type:ledger, relayId, events} 发出", async () => {
    const srv = await startServer()
    const uplink = new WebSocketUplink({ hubUrl: srv.url, getRegistration: () => mkReg("relay-ledger") })
    await uplink.connect()
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(uplink.sendLedger("relay-ledger", sampleEvents), true)
    await new Promise((r) => setTimeout(r, 50))

    const frame = srv.received.find((x) => x.msg.type === "ledger")
    assert.ok(frame, "Hub 应收到 ledger 帧")
    if (frame && frame.msg.type === "ledger") {
      assert.equal(frame.msg.relayId, "relay-ledger")
      assert.equal(frame.msg.events.length, 1)
      assert.equal(frame.msg.events[0].srcSeq, 7)
      assert.equal(frame.msg.events[0].msg.to, "@ledger")
    }

    await uplink.disconnect()
    await srv.close()
  })

  it("未连接时 sendLedger 返回 false（本地库继续当队列）", () => {
    const uplink = new WebSocketUplink({ hubUrl: "ws://localhost:1", getRegistration: () => mkReg("relay-off") })
    assert.equal(uplink.sendLedger("relay-off", sampleEvents), false)
  })

  it("收到 downlink ledger_ack → 触发 onLedgerAck(upToSeq)", async () => {
    const srv = await startServer()
    const uplink = new WebSocketUplink({ hubUrl: srv.url, getRegistration: () => mkReg("relay-ack") })
    const acks: number[] = []
    uplink.onLedgerAck((upToSeq) => acks.push(upToSeq))
    await uplink.connect()
    await new Promise((r) => setTimeout(r, 50))

    srv.received[0].ws.send(JSON.stringify({ type: "ledger_ack", upToSeq: 42 } as DownlinkMessage))
    await new Promise((r) => setTimeout(r, 50))

    assert.deepEqual(acks, [42])
    await uplink.disconnect()
    await srv.close()
  })

  it("没注册 onLedgerAck 时收到 ledger_ack 不炸（老 relay 行为兼容）", async () => {
    const srv = await startServer()
    const uplink = new WebSocketUplink({ hubUrl: srv.url, getRegistration: () => mkReg("relay-noack") })
    await uplink.connect()
    await new Promise((r) => setTimeout(r, 50))

    srv.received[0].ws.send(JSON.stringify({ type: "ledger_ack", upToSeq: 9 } as DownlinkMessage))
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(uplink.isConnected(), true, "连接仍健康")

    await uplink.disconnect()
    await srv.close()
  })
})
