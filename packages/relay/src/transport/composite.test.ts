/**
 * CompositeTransport 测试
 *
 * 职责：
 * - type:"local" → terminal.inject，返回 method:"terminal"
 * - type:"remote" → 构造 MeshMessage 经 uplink.send，返回 method:"uplink"
 * - uplink 未连接或 send 失败时返回 delivered:false
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { CompositeTransport } from "./composite.js"
import type { ITerminal, SpawnResult } from "../terminal/interface.js"
import type { IUplink } from "../uplink/interface.js"
import type { MeshMessage } from "@cc-mesh/protocol"

class MockTerminal implements ITerminal {
  injectLog: Array<{ sessionId: string; text: string; hint?: { windowId?: string } }> = []
  injectReturn = true
  async inject(sessionId: string, text: string, hint?: { windowId?: string }): Promise<boolean> {
    this.injectLog.push({ sessionId, text, hint })
    return this.injectReturn
  }
  async spawn(_c: string, _o?: { mode?: "tab" | "window"; cwd?: string }): Promise<SpawnResult> {
    return { sessionId: "mock" }
  }
  async isAlive(_s: string): Promise<boolean> { return true }
  async close(_s: string): Promise<void> {}
  async getCurrentSession(): Promise<{ sessionId: string; windowId?: string } | null> { return null }
}

class MockUplink implements IUplink {
  connected = true
  sent: MeshMessage[] = []
  sendReturn = true
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  isConnected(): boolean { return this.connected }
  async send(msg: MeshMessage): Promise<boolean> {
    this.sent.push(msg)
    return this.sendReturn
  }
  onMessage(_cb: (m: MeshMessage) => void): void {}
}

describe("CompositeTransport", () => {
  it("local 目标 → terminal.inject，method:terminal", async () => {
    const term = new MockTerminal()
    const uplink = new MockUplink()
    const tx = new CompositeTransport(term, uplink, { deviceId: "macbook" })
    const r = await tx.deliver({ type: "local", sessionId: "s-1" }, "hello")
    assert.equal(r.delivered, true)
    assert.equal(r.method, "terminal")
    assert.equal(term.injectLog.length, 1)
    assert.equal(uplink.sent.length, 0)
  })

  it("local 目标传递 hint", async () => {
    const term = new MockTerminal()
    const tx = new CompositeTransport(term, new MockUplink(), { deviceId: "macbook" })
    await tx.deliver({ type: "local", sessionId: "s-2", hint: { windowId: "w-9" } }, "x")
    assert.deepEqual(term.injectLog[0].hint, { windowId: "w-9" })
  })

  it("remote 目标 → uplink.send MeshMessage，method:uplink", async () => {
    const term = new MockTerminal()
    const uplink = new MockUplink()
    const tx = new CompositeTransport(term, uplink, { deviceId: "macbook" })
    const r = await tx.deliver(
      { type: "remote", deviceId: "mini", nodeId: "mini:cc-b" },
      "payload-text",
    )
    assert.equal(r.delivered, true)
    assert.equal(r.method, "uplink")
    assert.equal(term.injectLog.length, 0)
    assert.equal(uplink.sent.length, 1)
    assert.equal(uplink.sent[0].to, "mini:cc-b")
    assert.equal(uplink.sent[0].payload, "payload-text")
  })

  it("remote + uplink 未连接 → delivered:false，error 非空", async () => {
    const uplink = new MockUplink()
    uplink.connected = false
    const tx = new CompositeTransport(new MockTerminal(), uplink, { deviceId: "macbook" })
    const r = await tx.deliver(
      { type: "remote", deviceId: "mini", nodeId: "mini:cc-z" },
      "msg",
    )
    assert.equal(r.delivered, false)
    assert.equal(r.method, "uplink")
    assert.ok(r.error && r.error.length > 0)
    assert.equal(uplink.sent.length, 0)
  })

  it("remote + uplink.send 返回 false → delivered:false", async () => {
    const uplink = new MockUplink()
    uplink.sendReturn = false
    const tx = new CompositeTransport(new MockTerminal(), uplink, { deviceId: "macbook" })
    const r = await tx.deliver(
      { type: "remote", deviceId: "mini", nodeId: "mini:cc-q" },
      "msg",
    )
    assert.equal(r.delivered, false)
    assert.equal(r.method, "uplink")
  })

  it("local + terminal.inject 返回 false → delivered:false", async () => {
    const term = new MockTerminal()
    term.injectReturn = false
    const tx = new CompositeTransport(term, new MockUplink(), { deviceId: "macbook" })
    const r = await tx.deliver({ type: "local", sessionId: "s-off" }, "x")
    assert.equal(r.delivered, false)
    assert.equal(r.method, "terminal")
  })
})

// ===== 跨机同一性（真环境 E2E 抓到的 bug）=====
// 老实现：remote 分支只拿得到 text，于是现造一条 MeshMessage（新 id / type=chat / 无 meta）
// → 对端落库的是"另一条消息"，云端账本一条逻辑消息两行、按 id 去重失效、replyTo 对不上 task_id。
describe("CompositeTransport — 跨机原件同一性", () => {
  function taskMsg(): MeshMessage {
    return {
      id: "msg-orig-1",
      from: "macbook:cc-brain",
      to: "mini:cc-worker",
      type: "task",
      payload: "干活",
      replyTo: "msg-parent-9",
      createdAt: "2026-08-27T12:00:00.000Z",
      meta: { _task: { title: "跨机试单", project: "P62", pickReason: "explicit" } },
    }
  }

  it("remote 传了原件 → uplink 收到的就是原件（id/type/meta/replyTo/from 全不变）", async () => {
    const uplink = new MockUplink()
    const tx = new CompositeTransport(new MockTerminal(), uplink, { deviceId: "macbook" })
    const original = taskMsg()

    const r = await tx.deliver(
      { type: "remote", deviceId: "mini", nodeId: "mini:cc-worker" },
      "[mesh:macbook:cc-brain] 干活",
      original,
    )

    assert.equal(r.delivered, true)
    assert.equal(uplink.sent.length, 1)
    const sent = uplink.sent[0]
    assert.equal(sent.id, "msg-orig-1", "id 绝不能被重铸")
    assert.equal(sent.type, "task", "type 绝不能退化成 chat")
    assert.equal(sent.from, "macbook:cc-brain", "from 是原发送方，不是本机 deviceId")
    assert.equal(sent.replyTo, "msg-parent-9")
    assert.deepEqual(sent.meta, { _task: { title: "跨机试单", project: "P62", pickReason: "explicit" } })
    assert.equal(sent.payload, "干活", "payload 是原文，不带 [mesh:] 前缀（前缀在对端注入时加）")
    assert.equal(sent.createdAt, "2026-08-27T12:00:00.000Z", "createdAt 保原值")
  })

  it("remote 没传原件 → 保持老行为（合成一条，不炸）", async () => {
    const uplink = new MockUplink()
    const tx = new CompositeTransport(new MockTerminal(), uplink, { deviceId: "macbook" })
    const r = await tx.deliver({ type: "remote", deviceId: "mini", nodeId: "mini:cc-b" }, "legacy-text")
    assert.equal(r.delivered, true)
    assert.equal(uplink.sent[0].payload, "legacy-text")
    assert.equal(uplink.sent[0].type, "chat")
  })

  it("uplink 未连接时不吞原件（不发、不改）", async () => {
    const uplink = new MockUplink()
    uplink.connected = false
    const tx = new CompositeTransport(new MockTerminal(), uplink, { deviceId: "macbook" })
    const original = taskMsg()
    const r = await tx.deliver({ type: "remote", deviceId: "mini", nodeId: "mini:cc-worker" }, "x", original)
    assert.equal(r.delivered, false)
    assert.equal(uplink.sent.length, 0)
    assert.equal(original.id, "msg-orig-1")
  })
})
