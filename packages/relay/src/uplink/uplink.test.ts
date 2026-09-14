/**
 * Uplink 测试 — IUplink 接口契约测试
 *
 * IUplink 抽象 "到远端 relay 的连接"，实际实现（WebSocket/HTTP SSE 等）以后再做。
 * 这里用 MockUplink 锁定接口契约。
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { IUplink } from "./interface.js"
import type { MeshMessage } from "@cc-mesh/protocol"

class MockUplink implements IUplink {
  private connected = false
  private handler: ((msg: MeshMessage) => void) | null = null
  sent: MeshMessage[] = []
  sendReturn = true

  async connect(): Promise<void> { this.connected = true }
  async disconnect(): Promise<void> { this.connected = false }
  isConnected(): boolean { return this.connected }
  async send(msg: MeshMessage): Promise<boolean> {
    if (!this.connected) return false
    this.sent.push(msg)
    return this.sendReturn
  }
  onMessage(cb: (msg: MeshMessage) => void): void { this.handler = cb }
  // test hook: simulate inbound
  simulate(msg: MeshMessage) { this.handler?.(msg) }
}

function fakeMsg(overrides: Partial<MeshMessage> = {}): MeshMessage {
  return {
    id: "msg-1",
    from: "macbook:cc-a",
    to: "mini:cc-b",
    type: "chat",
    payload: "hi",
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

describe("IUplink 接口契约（MockUplink）", () => {
  it("connect / disconnect 切换 isConnected 状态", async () => {
    const up = new MockUplink()
    assert.equal(up.isConnected(), false)
    await up.connect()
    assert.equal(up.isConnected(), true)
    await up.disconnect()
    assert.equal(up.isConnected(), false)
  })

  it("未连接时 send 返回 false", async () => {
    const up = new MockUplink()
    const ok = await up.send(fakeMsg())
    assert.equal(ok, false)
  })

  it("已连接时 send 返回 true 且记录消息", async () => {
    const up = new MockUplink()
    await up.connect()
    const ok = await up.send(fakeMsg({ payload: "hello" }))
    assert.equal(ok, true)
    assert.equal(up.sent.length, 1)
    assert.equal(up.sent[0].payload, "hello")
  })

  it("onMessage 注册回调后可收到 inbound 消息", async () => {
    const up = new MockUplink()
    const received: MeshMessage[] = []
    up.onMessage((m) => received.push(m))
    await up.connect()
    up.simulate(fakeMsg({ id: "msg-x", payload: "inbound" }))
    assert.equal(received.length, 1)
    assert.equal(received[0].id, "msg-x")
    assert.equal(received[0].payload, "inbound")
  })
})
