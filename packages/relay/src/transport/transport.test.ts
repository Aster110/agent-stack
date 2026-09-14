/**
 * Transport 测试 — LocalTransport 单元测试
 *
 * ITransport 抽象统一 "消息投递" 动作：本地走 terminal.inject，远端走 uplink。
 * LocalTransport 只支持 type:"local"，收到 type:"remote" 应拒绝。
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { LocalTransport } from "./local.js"
import type { ITerminal, SpawnResult } from "../terminal/interface.js"

class MockTerminal implements ITerminal {
  injectLog: Array<{ sessionId: string; text: string; hint?: { windowId?: string } }> = []
  injectReturn = true

  async inject(sessionId: string, text: string, hint?: { windowId?: string }): Promise<boolean> {
    this.injectLog.push({ sessionId, text, hint })
    return this.injectReturn
  }
  async spawn(_cmd: string, _opts?: { mode?: "tab" | "window"; cwd?: string }): Promise<SpawnResult> {
    return { sessionId: "mock", windowId: "mock" }
  }
  async isAlive(_sessionId: string): Promise<boolean> { return true }
  async close(_sessionId: string): Promise<void> {}
  async getCurrentSession(): Promise<{ sessionId: string; windowId?: string } | null> { return null }
}

describe("LocalTransport", () => {
  it("deliver(type:local) 成功时调用 terminal.inject 返回 delivered:true + method:terminal", async () => {
    const term = new MockTerminal()
    const transport = new LocalTransport(term)
    const result = await transport.deliver(
      { type: "local", sessionId: "sess-x", hint: { windowId: "win-1" } },
      "hello",
    )
    assert.equal(result.delivered, true)
    assert.equal(result.method, "terminal")
    assert.equal(term.injectLog.length, 1)
    assert.equal(term.injectLog[0].sessionId, "sess-x")
    assert.equal(term.injectLog[0].text, "hello")
    assert.deepEqual(term.injectLog[0].hint, { windowId: "win-1" })
  })

  it("deliver(type:local) 当 terminal.inject 返回 false 时返回 delivered:false", async () => {
    const term = new MockTerminal()
    term.injectReturn = false
    const transport = new LocalTransport(term)
    const result = await transport.deliver({ type: "local", sessionId: "sess-y" }, "msg")
    assert.equal(result.delivered, false)
    assert.equal(result.method, "terminal")
  })

  it("deliver(type:remote) 不支持 — 返回 delivered:false", async () => {
    const term = new MockTerminal()
    const transport = new LocalTransport(term)
    const result = await transport.deliver(
      { type: "remote", deviceId: "mini", nodeId: "mini:cc-x" },
      "hi",
    )
    assert.equal(result.delivered, false)
    assert.equal(term.injectLog.length, 0, "terminal.inject should not be called for remote")
  })
})
