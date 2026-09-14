/**
 * MeshEventBus 单元测试 — 关键操作事件总线
 * TDD: events.ts 尚未实现
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { MeshEventBus } from "./events.js"
import type { LocalNode } from "@cc-mesh/protocol"

function makeNode(shortId: string): LocalNode {
  return {
    identity: {
      nodeId: `macbook:${shortId}`,
      deviceId: "macbook",
      shortId,
      role: "worker",
      description: "",
      capabilities: [],
    },
    sessionId: `sess-${shortId}`,
    pid: 1,
    lastSeen: new Date().toISOString(),
    status: "idle",
  }
}

describe("MeshEventBus", () => {
  it("emit node:register → 监听器收到 node 数据", () => {
    const bus = new MeshEventBus()
    const received: any[] = []
    bus.on("node:register", (data) => received.push(data))
    const node = makeNode("cc-n1")
    bus.emit("node:register", { node })
    assert.equal(received.length, 1)
    assert.equal(received[0].node.identity.nodeId, "macbook:cc-n1")
  })

  it("emit msg:send → 监听器收到 msgId/from/to/status", () => {
    const bus = new MeshEventBus()
    const received: any[] = []
    bus.on("msg:send", (data) => received.push(data))
    bus.emit("msg:send", { msgId: "m1", from: "a", to: "b", status: "delivered" })
    assert.equal(received.length, 1)
    assert.equal(received[0].msgId, "m1")
    assert.equal(received[0].from, "a")
    assert.equal(received[0].to, "b")
    assert.equal(received[0].status, "delivered")
  })

  it("多个监听器都收到事件", () => {
    const bus = new MeshEventBus()
    let a = 0, b = 0
    bus.on("node:unregister", () => a++)
    bus.on("node:unregister", () => b++)
    bus.emit("node:unregister", { nodeId: "macbook:cc-x" })
    assert.equal(a, 1)
    assert.equal(b, 1)
  })

  it("removeListener 后不再收到", () => {
    const bus = new MeshEventBus()
    let hits = 0
    const fn = () => hits++
    bus.on("msg:delivered", fn)
    bus.emit("msg:delivered", { msgId: "m1" })
    bus.off("msg:delivered", fn)
    bus.emit("msg:delivered", { msgId: "m2" })
    assert.equal(hits, 1)
  })

  it("监听器异常不影响其他监听器", () => {
    const bus = new MeshEventBus()
    let second = 0
    bus.on("msg:send", () => { throw new Error("boom") })
    bus.on("msg:send", () => { second++ })
    bus.emit("msg:send", { msgId: "m1", from: "a", to: "b", status: "delivered" })
    assert.equal(second, 1, "后续监听器应仍被调用")
  })

  it("uplink:status 事件", () => {
    const bus = new MeshEventBus()
    const received: any[] = []
    bus.on("uplink:status", (d) => received.push(d))
    bus.emit("uplink:status", { connected: true, hubUrl: "wss://hub" })
    assert.equal(received.length, 1)
    assert.equal(received[0].connected, true)
    assert.equal(received[0].hubUrl, "wss://hub")
  })
})
