/**
 * Hub 单元测试 — 用真实 WS 连接（port 0）
 *
 * Hub 职责：
 * - 接受 WS 连接，处理 UplinkMessage（register / message / ping）
 * - GlobalRegistry：记录 relayId → nodes 映射（内存 Map）
 * - 消息路由：收到 {type:"message", msg} 时，按 msg.to 找到对应 relay，下发 DownlinkMessage
 *   - 成功路由 → 发送方收到 {type:"delivered", msgId}
 *   - 目标不存在 → 发送方收到 {type:"queued", msgId}（Phase 2.1 不实际排队）
 *   - to:"*" → 广播到所有其他 relay，不回发送方
 * - ping 回 pong
 * - 连接断开时清理注册
 */
import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import WebSocket from "ws"
import { createHub, type HubInstance } from "./hub.js"
import { NoAuth, TokenAuth, type IAuth } from "./auth.js"
import { authFromEnv } from "./index.js"
import type {
  UplinkMessage, DownlinkMessage, MeshMessage, RelayRegistration, NodeIdentity,
} from "@cc-mesh/protocol"

function mkNode(nodeId: string, deviceId: string): NodeIdentity {
  const [, shortId] = nodeId.split(":")
  return { nodeId, deviceId, shortId, role: "main", description: "", capabilities: [] }
}
function mkReg(relayId: string, deviceId: string, nodeIds: string[]): RelayRegistration {
  return {
    relayId,
    deviceId,
    nodes: nodeIds.map((id) => mkNode(id, deviceId)),
    connectedAt: new Date().toISOString(),
  }
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.once("open", () => resolve(ws))
    ws.once("error", reject)
  })
}

function send(ws: WebSocket, msg: UplinkMessage): void {
  ws.send(JSON.stringify(msg))
}

/** 收集某个 ws 的所有 downlink 消息到数组（立即注册 handler，避免 miss）。 */
function collect(ws: WebSocket): DownlinkMessage[] {
  const buf: DownlinkMessage[] = []
  ws.on("message", (data) => buf.push(JSON.parse(String(data))))
  return buf
}

/** 轮询等待 predicate 为 true，优于裸 setTimeout。 */
async function waitFor(
  pred: () => boolean,
  { timeoutMs = 1000, stepMs = 10 }: { timeoutMs?: number; stepMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, stepMs))
  }
  if (!pred()) throw new Error(`waitFor 超时（${timeoutMs}ms）`)
}

/** 等 ws 的 close code；超时返回 -1（避免鉴权回归时测试永久挂起）。 */
function closeCodeWithin(ws: WebSocket, timeoutMs = 2000): Promise<number> {
  return new Promise<number>((resolve) => {
    const t = setTimeout(() => resolve(-1), timeoutMs)
    ws.once("close", (code) => { clearTimeout(t); resolve(code) })
  })
}

describe("Hub", () => {
  let hub: HubInstance
  let url: string

  before(async () => {
    hub = await createHub({ port: 0 })
    url = `ws://localhost:${hub.port}`
  })
  after(async () => {
    await hub.close()
  })

  it("register 后可通过 getNodeLocation 查到", async () => {
    const ws = await connect(url)
    send(ws, { type: "register", relay: mkReg("relay-A", "macbook", ["macbook:cc-a1"]) })
    await waitFor(() => hub.getNodeLocation("macbook:cc-a1") === "relay-A")
    ws.close()
  })

  it("register / close 后广播 devices snapshot", async () => {
    const wsA = await connect(url)
    const wsB = await connect(url)
    const bufA = collect(wsA)
    const bufB = collect(wsB)

    send(wsA, { type: "register", relay: mkReg("relay-devA", "macbook", ["macbook:cc-a"]) })
    await waitFor(() => bufA.some((m) => m.type === "devices"))
    send(wsB, { type: "register", relay: mkReg("relay-devB", "computer2", ["computer2:cc-b"]) })
    await waitFor(() =>
      bufA.some((m) => m.type === "devices" && m.devices.some((d) => d.deviceId === "computer2")) &&
      bufB.some((m) => m.type === "devices" && m.devices.some((d) => d.deviceId === "macbook"))
    )

    wsB.close()
    await waitFor(() =>
      bufA.some((m) => m.type === "devices" && !m.devices.some((d) => d.deviceId === "computer2"))
    )
    wsA.close()
  })

  it("ping 回 pong", async () => {
    const ws = await connect(url)
    const buf = collect(ws)
    send(ws, { type: "register", relay: mkReg("relay-ping", "macbook", []) })
    send(ws, { type: "ping" })
    await waitFor(() => buf.some((m) => m.type === "pong"))
    ws.close()
  })

  it("定向路由：目标收到 message，发送方收到 delivered ACK", async () => {
    const wsA = await connect(url)
    const wsB = await connect(url)
    const bufA = collect(wsA)
    const bufB = collect(wsB)
    send(wsA, { type: "register", relay: mkReg("relay-A2", "macbook", ["macbook:cc-x"]) })
    send(wsB, { type: "register", relay: mkReg("relay-B2", "mini", ["mini:cc-y"]) })
    await waitFor(() =>
      hub.getNodeLocation("macbook:cc-x") === "relay-A2" &&
      hub.getNodeLocation("mini:cc-y") === "relay-B2"
    )

    const msg: MeshMessage = {
      id: "msg-1", from: "macbook:cc-x", to: "mini:cc-y",
      type: "chat", payload: "hello", createdAt: new Date().toISOString(),
    }
    send(wsA, { type: "message", msg })

    await waitFor(() => bufB.some((m) => m.type === "message" && m.msg.id === "msg-1"))
    await waitFor(() => bufA.some((m) => m.type === "delivered" && m.msgId === "msg-1"))

    const inbound = bufB.find((m) => m.type === "message")!
    if (inbound.type === "message") {
      assert.equal(inbound.msg.to, "mini:cc-y")
      assert.equal(inbound.msg.payload, "hello")
    }
    wsA.close(); wsB.close()
  })

  it("spawn 请求按 targetDevice 路由到目标 relay，并把结果回给发送方 relay", async () => {
    const wsA = await connect(url)
    const wsB = await connect(url)
    const bufA = collect(wsA)
    const bufB = collect(wsB)
    send(wsA, { type: "register", relay: mkReg("relay-SA", "macbook", ["macbook:lead"]) })
    send(wsB, { type: "register", relay: mkReg("relay-SB", "computer2", ["computer2:cc-a"]) })
    await waitFor(() =>
      hub.getNodeLocation("macbook:lead") === "relay-SA" &&
      hub.getNodeLocation("computer2:cc-a") === "relay-SB"
    )

    send(wsA, {
      type: "spawn",
      requestId: "spawn-1",
      targetDevice: "computer2",
      spawn: { agent: "tcx" },
    })
    await waitFor(() => bufB.some((m) => m.type === "spawn" && m.requestId === "spawn-1"))
    const spawnReq = bufB.find((m) => m.type === "spawn")
    if (spawnReq?.type === "spawn") {
      assert.equal(spawnReq.replyRelayId, "relay-SA")
      assert.equal(spawnReq.spawn.agent, "tcx")
    }

    send(wsB, {
      type: "spawn_result",
      requestId: "spawn-1",
      targetRelayId: "relay-SA",
      result: { ok: true, data: { nodeId: "computer2:cc-new" } },
    })
    await waitFor(() => bufA.some((m) => m.type === "spawn_result" && m.requestId === "spawn-1"))
    const result = bufA.find((m) => m.type === "spawn_result")
    if (result?.type === "spawn_result") {
      assert.equal(result.result.ok, true)
      assert.equal((result.result.data as any).nodeId, "computer2:cc-new")
    }

    wsA.close(); wsB.close()
  })

  it("目标不存在：发送方收到 queued，无关 relay 不收消息", async () => {
    const wsA = await connect(url)
    const wsB = await connect(url)
    const bufA = collect(wsA)
    const bufB = collect(wsB)
    send(wsA, { type: "register", relay: mkReg("relay-A3", "macbook", ["macbook:cc-src"]) })
    send(wsB, { type: "register", relay: mkReg("relay-B3", "mini", ["mini:cc-other"]) })
    await waitFor(() => hub.getNodeLocation("mini:cc-other") === "relay-B3")

    const msg: MeshMessage = {
      id: "msg-lost", from: "macbook:cc-src", to: "ghost:cc-nope",
      type: "chat", payload: "x", createdAt: new Date().toISOString(),
    }
    send(wsA, { type: "message", msg })

    await waitFor(() => bufA.some((m) => m.type === "queued" && m.msgId === "msg-lost"))
    assert.equal(
      bufB.filter((m) => m.type === "message").length, 0,
      "无关 relay 不应收到消息",
    )
    wsA.close(); wsB.close()
  })

  it("broadcast (to:*) 转发给所有其他 relay（不回发送方）", async () => {
    const wsA = await connect(url)
    const wsB = await connect(url)
    const wsC = await connect(url)
    const bufA = collect(wsA); const bufB = collect(wsB); const bufC = collect(wsC)
    send(wsA, { type: "register", relay: mkReg("relay-bcA", "macbook", ["macbook:cc-ba"]) })
    send(wsB, { type: "register", relay: mkReg("relay-bcB", "mini", ["mini:cc-bb"]) })
    send(wsC, { type: "register", relay: mkReg("relay-bcC", "cloud", ["cloud:cc-bc"]) })
    await waitFor(() =>
      hub.getNodeLocation("macbook:cc-ba") === "relay-bcA" &&
      hub.getNodeLocation("mini:cc-bb") === "relay-bcB" &&
      hub.getNodeLocation("cloud:cc-bc") === "relay-bcC"
    )

    const msg: MeshMessage = {
      id: "bc-1", from: "macbook:cc-ba", to: "*",
      type: "broadcast", payload: "hey", createdAt: new Date().toISOString(),
    }
    send(wsA, { type: "message", msg })

    await waitFor(() =>
      bufB.some((m) => m.type === "message" && m.msg.id === "bc-1") &&
      bufC.some((m) => m.type === "message" && m.msg.id === "bc-1")
    )
    assert.equal(
      bufA.filter((m) => m.type === "message").length, 0,
      "发送方不应收到回声",
    )
    wsA.close(); wsB.close(); wsC.close()
  })

  it("连接断开时清理该 relay 的节点注册", async () => {
    const ws = await connect(url)
    send(ws, { type: "register", relay: mkReg("relay-gone", "mini", ["mini:cc-gone"]) })
    await waitFor(() => hub.getNodeLocation("mini:cc-gone") === "relay-gone")

    ws.close()
    await waitFor(() => hub.getNodeLocation("mini:cc-gone") === undefined)
  })
})

describe("NoAuth", () => {
  it("verify 始终返回 true（无论 token / relayId）", async () => {
    const auth: IAuth = new NoAuth()
    assert.equal(await auth.verify(undefined, "any-relay"), true)
    assert.equal(await auth.verify("bogus", "another-relay"), true)
    assert.equal(await auth.verify("", ""), true)
  })
})

describe("Hub auth 鉴权", () => {
  it("默认无 auth 参数 → 等同 NoAuth，register 正常（向后兼容）", async () => {
    const hub = await createHub({ port: 0 })
    try {
      const ws = await connect(`ws://localhost:${hub.port}`)
      send(ws, { type: "register", relay: mkReg("relay-compat", "macbook", ["macbook:cc-compat"]) })
      await waitFor(() => hub.getNodeLocation("macbook:cc-compat") === "relay-compat")
      ws.close()
    } finally {
      await hub.close()
    }
  })

  it("RejectAuth（verify 返回 false）→ WS 被关闭（code 4001），nodeIndex 无记录", async () => {
    const rejectAuth: IAuth = { async verify() { return false } }
    const hub = await createHub({ port: 0, auth: rejectAuth })
    try {
      const ws = await connect(`ws://localhost:${hub.port}`)
      const closeInfo = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }))
      })
      send(ws, { type: "register", relay: mkReg("relay-reject", "macbook", ["macbook:cc-rej"]) })
      const info = await closeInfo
      assert.equal(info.code, 4001, "应以 4001 关闭")
      assert.equal(hub.getNodeLocation("macbook:cc-rej"), undefined, "拒绝的节点不应注册")
    } finally {
      await hub.close()
    }
  })

  it("SelectiveAuth：只放行特定 relayId，其它被关闭", async () => {
    const calls: Array<{ token: string | undefined; relayId: string }> = []
    const selectiveAuth: IAuth = {
      async verify(token, relayId) {
        calls.push({ token, relayId })
        return relayId === "relay-allow" && token === "good-token"
      },
    }
    const hub = await createHub({ port: 0, auth: selectiveAuth })
    try {
      // allow
      const wsAllow = await connect(`ws://localhost:${hub.port}`)
      send(wsAllow, {
        type: "register",
        relay: mkReg("relay-allow", "macbook", ["macbook:cc-allow"]),
        token: "good-token",
      })
      await waitFor(() => hub.getNodeLocation("macbook:cc-allow") === "relay-allow")

      // deny by relayId
      const wsDeny = await connect(`ws://localhost:${hub.port}`)
      const denyClosed = new Promise<number>((resolve) => {
        wsDeny.once("close", (code) => resolve(code))
      })
      send(wsDeny, {
        type: "register",
        relay: mkReg("relay-deny", "mini", ["mini:cc-deny"]),
        token: "good-token",
      })
      assert.equal(await denyClosed, 4001)
      assert.equal(hub.getNodeLocation("mini:cc-deny"), undefined)

      // deny by bad token
      const wsBadTok = await connect(`ws://localhost:${hub.port}`)
      const badClosed = new Promise<number>((resolve) => {
        wsBadTok.once("close", (code) => resolve(code))
      })
      send(wsBadTok, {
        type: "register",
        relay: mkReg("relay-allow", "macbook", ["macbook:cc-badtok"]),
        token: "wrong",
      })
      assert.equal(await badClosed, 4001)
      assert.equal(hub.getNodeLocation("macbook:cc-badtok"), undefined)

      assert.equal(calls.length, 3, "verify 应被调用 3 次")
      wsAllow.close()
    } finally {
      await hub.close()
    }
  })
})

// ===== D29: hub 端 WS frame ping/pong 心跳 =====
describe("Hub heartbeat (D29)", () => {
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

  it("hub 对每个 client 主动发 ws frame ping(client 收到)", withEnv(
    { MESH_PING_INTERVAL_MS: "150", MESH_PONG_TIMEOUT_MS: "5000" },
    async () => {
      const hub = await createHub({ port: 0 })
      try {
        const ws = await connect(`ws://localhost:${hub.port}`)
        let pingCount = 0
        ws.on("ping", () => { pingCount += 1 })
        await new Promise((r) => setTimeout(r, 600))  // 600ms / 150ms ≈ 3-4 次
        assert.ok(pingCount >= 3, `client 应至少收到 3 次 hub 发的 ping,实际 ${pingCount}`)
        ws.close()
      } finally {
        await hub.close()
      }
    },
  ))

  it("client 不回 pong 时 hub terminate ws → handleClose 清 device registry", withEnv(
    { MESH_PING_INTERVAL_MS: "150", MESH_PONG_TIMEOUT_MS: "300" },
    async () => {
      const hub = await createHub({ port: 0 })
      try {
        // autoPong: false → 此 client 收到 ping 不自动回 pong
        const ws = new WebSocket(`ws://localhost:${hub.port}`, { autoPong: false })
        await new Promise<void>((r, j) => { ws.once("open", () => r()); ws.once("error", j) })
        send(ws, { type: "register", relay: mkReg("relay-stale", "stale-dev", ["stale-dev:cc-x"]) })
        await waitFor(() => hub.getNodeLocation("stale-dev:cc-x") === "relay-stale")

        // 等 pongTimeout(300ms) + 一次 interval(150ms) 让 hub 检测并 terminate
        await waitFor(
          () => hub.getNodeLocation("stale-dev:cc-x") === undefined,
          { timeoutMs: 1500 },
        )
        // 走到这里说明 device 已被清,断言通过
        try { ws.close() } catch { /* already terminated */ }
      } finally {
        await hub.close()
      }
    },
  ))

  it("client 正常自动回 pong 时 hub 不清 device", withEnv(
    { MESH_PING_INTERVAL_MS: "150", MESH_PONG_TIMEOUT_MS: "400" },
    async () => {
      const hub = await createHub({ port: 0 })
      try {
        const ws = await connect(`ws://localhost:${hub.port}`)  // 默认 autoPong=true
        send(ws, { type: "register", relay: mkReg("relay-alive", "alive-dev", ["alive-dev:cc-y"]) })
        await waitFor(() => hub.getNodeLocation("alive-dev:cc-y") === "relay-alive")

        // 跑 4 个 ping/pong 周期(600ms),期间 hub 应持续收到 pong,device 不被清
        await new Promise((r) => setTimeout(r, 600))
        assert.equal(hub.getNodeLocation("alive-dev:cc-y"), "relay-alive", "正常 pong 期间 device 不应被清")

        ws.close()
      } finally {
        await hub.close()
      }
    },
  ))
})

// ===== TokenAuth：固定 token 鉴权（公网安全前置门）=====
describe("TokenAuth", () => {
  it("verify: 空 token（undefined / 空串）→ false", async () => {
    const auth = new TokenAuth("test-token-abc")
    assert.equal(await auth.verify(undefined, "relay-x"), false)
    assert.equal(await auth.verify("", "relay-x"), false)
  })

  it("verify: 错 token → false", async () => {
    const auth = new TokenAuth("test-token-abc")
    assert.equal(await auth.verify("wrong-token", "relay-x"), false)
  })

  it("verify: 对 token → true", async () => {
    const auth = new TokenAuth("test-token-abc")
    assert.equal(await auth.verify("test-token-abc", "relay-x"), true)
  })

  it("verify: 长度不等的错 token 不抛错（timingSafeEqual 前必须挡长度）", async () => {
    const auth = new TokenAuth("test-token-abc")
    await assert.doesNotReject(async () => {
      assert.equal(await auth.verify("x", "relay-x"), false)
      assert.equal(await auth.verify("test-token-abc-longer-than-expected", "relay-x"), false)
      assert.equal(await auth.verify("超长的非 ASCII 错误 token 值 aaaaaaaaaaaaaaaa", "relay-x"), false)
    })
  })
})

describe("authFromEnv（Hub bootstrap 按 env 选 auth）", () => {
  it("HUB_TOKEN 未设 → NoAuth（不带 token 也放行，向后兼容）", async () => {
    const auth = authFromEnv({})
    assert.ok(auth instanceof NoAuth)
    assert.equal(await auth.verify(undefined, "r"), true)
    assert.equal(await auth.verify("anything", "r"), true)
  })

  it("HUB_TOKEN 空串 / 纯空白 → NoAuth（向后兼容）", async () => {
    assert.ok(authFromEnv({ HUB_TOKEN: "" }) instanceof NoAuth)
    assert.ok(authFromEnv({ HUB_TOKEN: "   " }) instanceof NoAuth)
    assert.equal(await authFromEnv({ HUB_TOKEN: "" }).verify(undefined, "r"), true)
  })

  it("HUB_TOKEN 非空 → TokenAuth（挡空/错、放行对，且 trim 首尾空白）", async () => {
    const auth = authFromEnv({ HUB_TOKEN: "  secret-xyz  " })
    assert.ok(auth instanceof TokenAuth)
    assert.equal(await auth.verify(undefined, "r"), false)
    assert.equal(await auth.verify("nope", "r"), false)
    assert.equal(await auth.verify("secret-xyz", "r"), true)
  })
})

// 真实 createHub + 真实 register 线格式（与 relay sendRegister 产出一致）打通鉴权闭环
describe("Hub + TokenAuth 集成（真实 createHub）", () => {
  const TOKEN = "test-token-abc"

  it("不带 token 连 TokenAuth Hub → close(4001)，节点不注册", async () => {
    const hub = await createHub({ port: 0, auth: new TokenAuth(TOKEN) })
    try {
      const ws = await connect(`ws://localhost:${hub.port}`)
      const closed = closeCodeWithin(ws)
      // 线格式与真实 relay sendRegister(无 token) 完全一致：{type:"register", relay}
      send(ws, { type: "register", relay: mkReg("relay-notok", "macbook", ["macbook:cc-notok"]) })
      assert.equal(await closed, 4001, "无 token 应被 4001 关闭")
      assert.equal(hub.getNodeLocation("macbook:cc-notok"), undefined)
    } finally {
      await hub.close()
    }
  })

  it("带错 token → close(4001)，节点不注册", async () => {
    const hub = await createHub({ port: 0, auth: new TokenAuth(TOKEN) })
    try {
      const ws = await connect(`ws://localhost:${hub.port}`)
      const closed = closeCodeWithin(ws)
      send(ws, {
        type: "register",
        relay: mkReg("relay-badtok", "macbook", ["macbook:cc-badtok"]),
        token: "wrong-token",
      })
      assert.equal(await closed, 4001, "错 token 应被 4001 关闭")
      assert.equal(hub.getNodeLocation("macbook:cc-badtok"), undefined)
    } finally {
      await hub.close()
    }
  })

  it("带对 token → 注册成功，Hub 设备视图（getNodeLocation + devices 快照）可见该 relay", async () => {
    const hub = await createHub({ port: 0, auth: new TokenAuth(TOKEN) })
    try {
      const ws = await connect(`ws://localhost:${hub.port}`)
      const buf = collect(ws)
      send(ws, {
        type: "register",
        relay: mkReg("relay-oktok", "macbook", ["macbook:cc-oktok"]),
        token: TOKEN,
      })
      await waitFor(() => hub.getNodeLocation("macbook:cc-oktok") === "relay-oktok")
      await waitFor(() =>
        buf.some((m) => m.type === "devices" && m.devices.some((d) => d.relayId === "relay-oktok")),
      )
      ws.close()
    } finally {
      await hub.close()
    }
  })

  it("HUB_TOKEN 未设时 authFromEnv → NoAuth：不带 token 也能注册（向后兼容 e2e）", async () => {
    const hub = await createHub({ port: 0, auth: authFromEnv({}) })
    try {
      const ws = await connect(`ws://localhost:${hub.port}`)
      send(ws, { type: "register", relay: mkReg("relay-compat2", "macbook", ["macbook:cc-compat2"]) })
      await waitFor(() => hub.getNodeLocation("macbook:cc-compat2") === "relay-compat2")
      ws.close()
    } finally {
      await hub.close()
    }
  })
})
