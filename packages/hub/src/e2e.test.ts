/**
 * E2E 测试 — Hub + 多个 relay 模拟（纯 WS client）
 */
import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import WebSocket from "ws"
import { createHub, type HubInstance } from "./hub.js"
import type {
  UplinkMessage, DownlinkMessage, MeshMessage, RelayRegistration,
} from "@cc-mesh/protocol"

function mkReg(relayId: string, deviceId: string, shortIds: string[]): RelayRegistration {
  return {
    relayId,
    deviceId,
    nodes: shortIds.map((s) => ({
      nodeId: `${deviceId}:${s}`, deviceId, shortId: s,
      role: "main" as const, description: "", capabilities: [],
    })),
    connectedAt: new Date().toISOString(),
  }
}

async function connectRelay(url: string, reg: RelayRegistration): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.once("open", () => {
      ws.send(JSON.stringify({ type: "register", relay: reg } satisfies UplinkMessage))
      resolve(ws)
    })
    ws.once("error", reject)
  })
}

function collect(ws: WebSocket): DownlinkMessage[] {
  const buf: DownlinkMessage[] = []
  ws.on("message", (d) => buf.push(JSON.parse(String(d))))
  return buf
}

async function waitFor(
  pred: () => boolean,
  { timeoutMs = 1500, stepMs = 10 }: { timeoutMs?: number; stepMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, stepMs))
  }
  if (!pred()) throw new Error(`waitFor 超时（${timeoutMs}ms）`)
}

describe("E2E: Hub + multi relay clients", () => {
  let hub: HubInstance
  let url: string

  before(async () => {
    hub = await createHub({ port: 0 })
    url = `ws://localhost:${hub.port}`
  })
  after(async () => {
    await hub.close()
  })

  it("跨 relay 消息经 Hub 中转送达", async () => {
    const relayA = await connectRelay(url, mkReg("relay-A", "macbook", ["cc-a"]))
    const relayB = await connectRelay(url, mkReg("relay-B", "mini", ["cc-b"]))
    await waitFor(() =>
      hub.getNodeLocation("macbook:cc-a") === "relay-A" &&
      hub.getNodeLocation("mini:cc-b") === "relay-B"
    )

    const recvB = collect(relayB)
    const msg: MeshMessage = {
      id: "e2e-1", from: "macbook:cc-a", to: "mini:cc-b",
      type: "task", payload: "do thing", createdAt: new Date().toISOString(),
    }
    relayA.send(JSON.stringify({ type: "message", msg } satisfies UplinkMessage))

    await waitFor(() => recvB.some((m) => m.type === "message" && m.msg.id === "e2e-1"))
    relayA.close(); relayB.close()
  })

  it("Promise.all 并发注册 3 个 relay，全部可路由", async () => {
    const [rA, rB, rC] = await Promise.all([
      connectRelay(url, mkReg("relay-p1", "macbook", ["cc-p1"])),
      connectRelay(url, mkReg("relay-p2", "mini", ["cc-p2"])),
      connectRelay(url, mkReg("relay-p3", "cloud", ["cc-p3"])),
    ])
    await waitFor(() =>
      hub.getNodeLocation("macbook:cc-p1") === "relay-p1" &&
      hub.getNodeLocation("mini:cc-p2") === "relay-p2" &&
      hub.getNodeLocation("cloud:cc-p3") === "relay-p3"
    )

    const recvB = collect(rB); const recvC = collect(rC)
    const msg1: MeshMessage = {
      id: "cc-1", from: "macbook:cc-p1", to: "mini:cc-p2",
      type: "chat", payload: "1→2", createdAt: new Date().toISOString(),
    }
    const msg2: MeshMessage = {
      id: "cc-2", from: "macbook:cc-p1", to: "cloud:cc-p3",
      type: "chat", payload: "1→3", createdAt: new Date().toISOString(),
    }
    rA.send(JSON.stringify({ type: "message", msg: msg1 } satisfies UplinkMessage))
    rA.send(JSON.stringify({ type: "message", msg: msg2 } satisfies UplinkMessage))

    await waitFor(() =>
      recvB.some((m) => m.type === "message" && m.msg.id === "cc-1") &&
      recvC.some((m) => m.type === "message" && m.msg.id === "cc-2")
    )
    rA.close(); rB.close(); rC.close()
  })

  it("relay-A 断开后 Hub 清理其节点注册，新 relay-C 可正常工作", async () => {
    const relayA = await connectRelay(url, mkReg("relay-A-fl", "macbook", ["cc-aa"]))
    const relayB = await connectRelay(url, mkReg("relay-B-fl", "mini", ["cc-bb"]))
    await waitFor(() =>
      hub.getNodeLocation("macbook:cc-aa") === "relay-A-fl" &&
      hub.getNodeLocation("mini:cc-bb") === "relay-B-fl"
    )

    relayA.close()
    await waitFor(() => hub.getNodeLocation("macbook:cc-aa") === undefined)
    assert.equal(hub.getNodeLocation("macbook:cc-aa"), undefined)

    const relayC = await connectRelay(url, mkReg("relay-C-fl", "cloud", ["cc-cc"]))
    await waitFor(() => hub.getNodeLocation("cloud:cc-cc") === "relay-C-fl")

    const recvB = collect(relayB)
    const msg: MeshMessage = {
      id: "e2e-2", from: "cloud:cc-cc", to: "mini:cc-bb",
      type: "chat", payload: "from-C", createdAt: new Date().toISOString(),
    }
    relayC.send(JSON.stringify({ type: "message", msg } satisfies UplinkMessage))

    await waitFor(() => recvB.some((m) => m.type === "message" && m.msg.id === "e2e-2"))
    relayB.close(); relayC.close()
  })
})
