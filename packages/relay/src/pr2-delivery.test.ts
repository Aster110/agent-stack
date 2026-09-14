/**
 * PR2 契约测试 — deliveryMode 收敛 inject|pull + 投递归一(InjectPump) + downlink store-first
 *
 * 对应 features/sync单原语 §6.2/§6.3/§9-PR2：
 *   - register 收敛映射：sse-pull/native-api/poll-only/未知 → pull；缺省 → inject；pull 保持
 *   - send → 前 native-api 形态节点：accepted（unsupported-actuator 不再产生），消息可经 sync 取到
 *   - 同 sender 并发连发全部落库（genMessageId 碰撞回归 pin）
 *   - downlink inject 目标也走 store-first 落库（跨机归一，A3 公理）
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createServer, type MeshServer } from "./server.js"
import { deliverDownlinkMessage } from "./downlink.js"
import { Registry } from "./registry.js"
import { Store } from "./store.js"
import { MeshEventBus } from "./events.js"
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import type { ITerminal, SpawnResult } from "./terminal/interface.js"
import type { LocalNode, MeshMessage } from "@cc-mesh/protocol"
import os from "node:os"
import path from "node:path"
import fs from "node:fs"

class MockTerminal implements ITerminal {
  injectReturn = true
  injectLog: Array<{ sessionId: string; text: string }> = []
  async inject(sessionId: string, text: string): Promise<boolean> {
    this.injectLog.push({ sessionId, text })
    return this.injectReturn
  }
  async spawn(): Promise<SpawnResult> { return { sessionId: "mock", windowId: "mock" } }
  async isAlive(): Promise<boolean> { return true }
  async close(): Promise<void> {}
  async getCurrentSession(): Promise<null> { return null }
  async notify(): Promise<boolean> { return true }
}

async function createTestServer() {
  const db = path.join(os.tmpdir(), `mesh-pr2-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const term = new MockTerminal()
  const bus = new MeshEventBus()
  const app: MeshServer = createServer({ dbPath: db, deviceId: "macbook", terminal: term, events: bus } as any)
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s))
  })
  const base = `http://localhost:${(server.address() as AddressInfo).port}`
  const close = async () => {
    await new Promise<void>((r) => server.close(() => r()))
    for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(db + ext) } catch {} }
  }
  return { base, term, close }
}

async function httpGet(base: string, p: string) {
  const res = await fetch(`${base}${p}`)
  return { status: res.status, data: await res.json().catch(() => null) as any }
}
async function httpPost(base: string, p: string, body?: unknown, headers?: Record<string, string>) {
  const res = await fetch(`${base}${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, data: await res.json().catch(() => null) as any }
}

async function statusMode(base: string, nodeId: string): Promise<string | undefined> {
  const { data } = await httpGet(base, "/api/status")
  const n = (data.data.nodes as any[]).find((x) => x.identity.nodeId === nodeId)
  return n?.identity.deliveryMode
}

describe("PR2: register deliveryMode 收敛 inject|pull", () => {
  it("sse-pull / native-api / poll-only / 未知值 → pull;缺省 → inject;pull 保持", async () => {
    const t = await createTestServer()
    try {
      const cases: Array<[string, string | undefined, string]> = [
        ["c-sse", "sse-pull", "pull"],
        ["c-nat", "native-api", "pull"],
        ["c-pol", "poll-only", "pull"],
        ["c-unk", "weird-future-mode", "pull"],
        ["c-pul", "pull", "pull"],
      ]
      for (const [shortId, mode, expect] of cases) {
        const r = await httpPost(t.base, "/api/register", { shortId, pid: 1, role: "worker", description: "t", deliveryMode: mode })
        assert.equal(r.status, 200, `register ${mode} 应放行(无 pane 不要求 sessionId)`)
        assert.equal(await statusMode(t.base, r.data.data.nodeId), expect, `${mode} 应收敛为 ${expect}`)
      }
      // 缺省 → inject(需要真 sessionId)
      const inj = await httpPost(t.base, "/api/register", { shortId: "c-inj", sessionId: "sess-1", pid: 1, role: "worker", description: "t" })
      assert.equal(await statusMode(t.base, inj.data.data.nodeId), "inject")
    } finally { await t.close() }
  })
})

describe("PR2: unsupported-actuator 消亡", () => {
  it("send → 前 native-api 形态节点:accepted,消息落库可 sync 取到", async () => {
    const t = await createTestServer()
    try {
      const r = await httpPost(t.base, "/api/register", { shortId: "nat1", pid: 1, role: "worker", description: "t", deliveryMode: "native-api" })
      const nodeId = r.data.data.nodeId as string
      const s = await httpPost(t.base, "/api/send", { to: nodeId, message: "hello-nat" }, { "x-mesh-node": "macbook:tester" })
      assert.equal(s.data.data.status, "accepted", "native-api 收敛 pull 后应 accepted 而非 unsupported-actuator")
      const sync = await httpGet(t.base, `/api/sync?nodeId=${encodeURIComponent(nodeId)}&timeout=0`)
      assert.equal(sync.data.data.messages.length, 1)
      assert.equal(sync.data.data.messages[0].payload, "hello-nat")
      assert.equal(t.term.injectLog.length, 0, "pull 形态绝不注入")
    } finally { await t.close() }
  })
})

describe("PR2: genMessageId 碰撞回归 pin", () => {
  it("同 sender 并发连发 5 条全部落库、sync 全取到", async () => {
    const t = await createTestServer()
    try {
      const r = await httpPost(t.base, "/api/register", { shortId: "burst1", pid: 1, role: "worker", description: "t", deliveryMode: "pull" })
      const nodeId = r.data.data.nodeId as string
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          httpPost(t.base, "/api/send", { to: nodeId, message: `burst-${i}` }, { "x-mesh-node": "macbook:same-sender" })),
      )
      for (const x of results) assert.equal(x.data.ok, true)
      const ids = new Set(results.map((x) => x.data.data.msgId))
      assert.equal(ids.size, 5, "5 条消息 id 必须唯一")
      const sync = await httpGet(t.base, `/api/sync?nodeId=${encodeURIComponent(nodeId)}&timeout=0&limit=100`)
      assert.equal(sync.data.data.messages.length, 5, "同 sender 同毫秒连发不得静默折叠")
    } finally { await t.close() }
  })
})

describe("PR2: downlink 跨机着陆归一(store-first)", () => {
  function node(shortId: string, deliveryMode?: any): LocalNode {
    return {
      identity: { nodeId: `macbook:${shortId}`, deviceId: "macbook", shortId, role: "worker", description: "", capabilities: [], ...(deliveryMode ? { deliveryMode } : {}) },
      sessionId: deliveryMode ? `nopane-macbook:${shortId}` : `sess-${shortId}`,
      pid: 1, lastSeen: new Date().toISOString(), status: "idle",
    } as LocalNode
  }
  function msg(to: string): MeshMessage {
    return { id: `msg-dl-${Math.random().toString(36).slice(2)}`, from: "computer2:cc-remote", to, type: "chat", payload: "cross-machine", createdAt: new Date().toISOString() } as MeshMessage
  }

  it("inject 目标:store-first 落库 + 注入成功 + 节点保留", async () => {
    const registry = new Registry()
    const term = new MockTerminal()
    const dbPath = path.join(os.tmpdir(), `mesh-pr2-dl-${Date.now()}.db`)
    const store = new Store(dbPath)
    const bus = new MeshEventBus()
    try {
      const n = node("dl-inj")
      registry.register(n)
      const m = msg(n.identity.nodeId)
      const result = await deliverDownlinkMessage({
        msg: m, registry, terminal: term, events: bus,
        saveMessage: (mm) => store.saveMessageIfAbsent(mm),
      })
      assert.equal(result.delivered, true)
      assert.equal(term.injectLog.length, 1, "inject 目标仍注入")
      assert.ok(registry.get(n.identity.nodeId), "注入成功节点保留")
      const inbox = store.getInbox(n.identity.nodeId, {})
      assert.equal(inbox.length, 1, "跨机 inject 消息也必须 store-first 落库(A3)")
      assert.equal(inbox[0]!.id, m.id)
    } finally {
      for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(dbPath + ext) } catch {} }
    }
  })
})
