/** Hub WS sender 归属校验红测：未注册连接及伪造 from 不得路由。 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import WebSocket from "ws"
import { createHub } from "./hub.js"
import { TokenAuth } from "./auth.js"
import type { DownlinkMessage, MeshMessage, RelayRegistration, UplinkMessage } from "@cc-mesh/protocol"

function reg(relayId: string, deviceId: string, nodeId: string): RelayRegistration {
  return {
    relayId, deviceId, connectedAt: new Date().toISOString(),
    nodes: [{ nodeId, deviceId, shortId: nodeId.split(":")[1]!, role: "main", description: "", capabilities: [] }],
  }
}

function msg(id: string, from: string): MeshMessage {
  return { id, from, to: "mini:cc-target", type: "chat", payload: "body", createdAt: new Date().toISOString() }
}

async function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.once("open", () => resolve(ws))
    ws.once("error", reject)
  })
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
  assert.equal(predicate(), true, message)
}

function terminate(ws: WebSocket | undefined): void {
  if (!ws) return
  try { ws.terminate() } catch { /* already closed */ }
}

describe("Hub WS sender authorization", () => {
  it("只有已注册 relay 拥有的 from 可路由", async () => {
    const hub = await createHub({ port: 0 })
    let attacker: WebSocket | undefined
    let sender: WebSocket | undefined
    let target: WebSocket | undefined
    let other: WebSocket | undefined
    try {
      const url = `ws://127.0.0.1:${hub.port}`
      attacker = await connect(url)
      sender = await connect(url)
      target = await connect(url)
      other = await connect(url)
      const received: DownlinkMessage[] = []
      target.on("message", (raw) => received.push(JSON.parse(String(raw))))
      target.send(JSON.stringify({ type: "register", relay: reg("relay-target", "mini", "mini:cc-target") } satisfies UplinkMessage))
      sender.send(JSON.stringify({ type: "register", relay: reg("relay-sender", "computer2", "computer2:cc-real") } satisfies UplinkMessage))
      other.send(JSON.stringify({ type: "register", relay: reg("relay-other", "other", "other:cc-real") } satisfies UplinkMessage))
      await waitFor(() => hub.getNodeLocation("computer2:cc-real") === "relay-sender", "sender 注册未完成")
      await waitFor(() => hub.getNodeLocation("mini:cc-target") === "relay-target", "target 注册未完成")
      await waitFor(() => hub.getNodeLocation("other:cc-real") === "relay-other", "other 注册未完成")

      attacker.send(JSON.stringify({ type: "message", msg: msg("unregistered", "computer2:cc-real") } satisfies UplinkMessage))
      sender.send(JSON.stringify({ type: "message", msg: msg("forged", "other:cc-victim") } satisfies UplinkMessage))
      sender.send(JSON.stringify({ type: "message", msg: msg("other-system", "other:relay") } satisfies UplinkMessage))
      sender.send(JSON.stringify({ type: "message", msg: msg("arbitrary-system", "arbitrary:relay") } satisfies UplinkMessage))
      await new Promise((r) => setTimeout(r, 50))
      const forbiddenIds = ["unregistered", "forged", "other-system", "arbitrary-system"]
      assert.equal(received.some((m) => m.type === "message" && forbiddenIds.includes(m.msg.id)), false)

      sender.send(JSON.stringify({ type: "message", msg: msg("owned", "computer2:cc-real") } satisfies UplinkMessage))
      sender.send(JSON.stringify({ type: "message", msg: msg("own-system", "computer2:relay") } satisfies UplinkMessage))
      await waitFor(
        () => ["owned", "own-system"].every((id) => received.some((m) => m.type === "message" && m.msg.id === id)),
        "合法 node/本连接系统 sender 未路由",
      )
    } finally {
      terminate(attacker)
      terminate(sender)
      terminate(target)
      terminate(other)
      await hub.close()
    }
  })

  it("鉴权失败与同 relayId 替换连接会确定性清理归属", async () => {
    const token = "test-ws-token"
    const hub = await createHub({ port: 0, auth: new TokenAuth(token) })
    const sockets: WebSocket[] = []
    try {
      const url = `ws://127.0.0.1:${hub.port}`
      const rejected = await connect(url); sockets.push(rejected)
      const rejectedClose = new Promise<number>((resolve) => rejected.once("close", (code) => resolve(code)))
      rejected.send(JSON.stringify({
        type: "register", relay: reg("relay-bad", "computer2", "computer2:cc-bad"), token: "wrong",
      } satisfies UplinkMessage))
      assert.equal(await rejectedClose, 4001)
      assert.equal(hub.getNodeLocation("computer2:cc-bad"), undefined)

      const old = await connect(url); sockets.push(old)
      old.send(JSON.stringify({
        type: "register", relay: reg("relay-same", "computer2", "computer2:cc-real"), token,
      } satisfies UplinkMessage))
      await waitFor(() => hub.getNodeLocation("computer2:cc-real") === "relay-same", "旧连接未注册")

      const replacement = await connect(url); sockets.push(replacement)
      replacement.send(JSON.stringify({
        type: "register", relay: reg("relay-same", "computer2", "computer2:cc-real"), token,
      } satisfies UplinkMessage))
      await waitFor(() => hub.getNodeLocation("computer2:cc-real") === "relay-same", "替换连接未注册")
      old.terminate()
      await new Promise((r) => setTimeout(r, 30))
      assert.equal(hub.getNodeLocation("computer2:cc-real"), "relay-same", "旧 socket close 不得删掉新归属")

      replacement.terminate()
      await waitFor(() => hub.getNodeLocation("computer2:cc-real") === undefined, "新连接 close 后归属未清理")
    } finally {
      for (const ws of sockets) terminate(ws)
      await hub.close()
    }
  })
})
