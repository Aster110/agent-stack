import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { deliverDownlinkMessage } from "./downlink.js"
import { Registry } from "./registry.js"
import { Store } from "./store.js"
import { MeshEventBus } from "./events.js"
import type { ITerminal } from "./terminal/interface.js"
import type { LocalNode, MeshMessage, NodeIdentity } from "@cc-mesh/protocol"
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

  async spawn(): Promise<any> { throw new Error("not used") }
  async isAlive(): Promise<boolean> { return true }
  async close(): Promise<void> {}
  async getCurrentSession(): Promise<null> { return null }
}

function node(shortId = "cc-a"): LocalNode {
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
    pid: 123,
    lastSeen: new Date().toISOString(),
    status: "idle",
  }
}

function msg(to = "macbook:cc-a"): MeshMessage {
  return {
    id: "msg-1",
    from: "mini:main",
    to,
    type: "chat",
    payload: "hello",
    createdAt: new Date().toISOString(),
  }
}

describe("deliverDownlinkMessage", () => {
  it("注入成功时保留节点", async () => {
    const registry = new Registry()
    const term = new MockTerminal()
    const n = node()
    registry.register(n)

    const result = await deliverDownlinkMessage({
      msg: msg(),
      registry,
      terminal: term,
    })

    assert.equal(result.delivered, true)
    assert.equal(registry.get(n.identity.nodeId), n)
    assert.equal(term.injectLog.length, 1)
  })

  it("注入失败时移除陈旧节点并同步 Hub 注册表", async () => {
    const registry = new Registry()
    const term = new MockTerminal()
    term.injectReturn = false
    const n = node()
    registry.register(n)
    const removed: string[] = []
    const sent: NodeIdentity[][] = []

    const result = await deliverDownlinkMessage({
      msg: msg(),
      registry,
      terminal: term,
      removeNode: (nodeId) => { removed.push(nodeId) },
      sendRegistration: async (nodes) => { sent.push(nodes) },
    })

    assert.equal(result.delivered, false)
    assert.equal(registry.get(n.identity.nodeId), undefined)
    assert.deepEqual(removed, [n.identity.nodeId])
    assert.equal(sent.length, 1)
    assert.deepEqual(sent[0], [])
  })
})

// ===== 方案 B PR1：downlink pull 守卫（审计发现 2 止血）=====
function pullNode(shortId = "cc-pull"): LocalNode {
  return {
    identity: {
      nodeId: `macbook:${shortId}`,
      deviceId: "macbook",
      shortId,
      role: "worker",
      description: "",
      capabilities: [],
      deliveryMode: "sse-pull",
    },
    sessionId: `nopane-macbook:${shortId}`,
    pid: 123,
    lastSeen: new Date().toISOString(),
    status: "idle",
  }
}

describe("deliverDownlinkMessage — pull 守卫", () => {
  function tmpDb(): string {
    return path.join(os.tmpdir(), `mesh-downlink-pull-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  }

  it("pull 目标：不注入、不驱逐，落库 + emit msg:send(accepted)", async () => {
    const registry = new Registry()
    const term = new MockTerminal()
    const store = new Store(tmpDb())
    const bus = new MeshEventBus()
    const events: any[] = []
    bus.on("msg:send", (d) => events.push(d))
    const unreg: any[] = []
    bus.on("node:unregister", (d) => unreg.push(d))

    const n = pullNode()
    registry.register(n)

    const m = msg(n.identity.nodeId)
    const result = await deliverDownlinkMessage({
      msg: m,
      registry,
      terminal: term,
      saveMessage: (mm) => store.saveMessageIfAbsent(mm),
      events: bus,
    })

    assert.equal(result.delivered, false)
    assert.equal(result.reason, "pull-accepted")
    assert.equal(term.injectLog.length, 0, "pull 目标绝不注入")
    assert.ok(registry.get(n.identity.nodeId), "pull 目标投递失败也不驱逐")
    assert.equal(unreg.length, 0, "不应 emit node:unregister")
    // 落库
    const inbox = store.getInbox(n.identity.nodeId)
    assert.equal(inbox.length, 1)
    assert.equal(inbox[0].payload, "hello")
    // 门铃
    const bell = events.find((e) => e.to === n.identity.nodeId)
    assert.ok(bell, "应 emit msg:send 门铃")
    assert.equal(bell.status, "accepted")
    store.close()
  })

  it("同一 msg.id 着陆两次只落一行（uplink retry 幂等）", async () => {
    const registry = new Registry()
    const term = new MockTerminal()
    const store = new Store(tmpDb())
    const bus = new MeshEventBus()
    const n = pullNode("cc-pull2")
    registry.register(n)

    const m = msg(n.identity.nodeId)
    await deliverDownlinkMessage({ msg: m, registry, terminal: term, saveMessage: (mm) => store.saveMessageIfAbsent(mm), events: bus })
    await deliverDownlinkMessage({ msg: m, registry, terminal: term, saveMessage: (mm) => store.saveMessageIfAbsent(mm), events: bus })

    const inbox = store.getInbox(n.identity.nodeId)
    assert.equal(inbox.length, 1, "重复着陆同 id 只一行")
    store.close()
  })

  it("inject 目标行为一字不动：注入成功保留节点（回归）", async () => {
    const registry = new Registry()
    const term = new MockTerminal()
    const n = node("cc-inj-dl") // 无 deliveryMode → 缺省 inject
    registry.register(n)
    const result = await deliverDownlinkMessage({ msg: msg(n.identity.nodeId), registry, terminal: term })
    assert.equal(result.delivered, true)
    assert.equal(term.injectLog.length, 1, "inject 目标仍注入")
    assert.ok(registry.get(n.identity.nodeId))
  })
})

// ===== 跨机着陆同一性（真环境 E2E bug 回归）=====
// 不变量：对端落库 = saveMessageIfAbsent(原件)，id/type/meta/replyTo/payload 一字不改，只一行；
//         注入正文仍带 [mesh:<from>] 前缀（前缀从发端搬到收端，pane 看到的字节不变）。
describe("deliverDownlinkMessage — 跨机原件同一性", () => {
  function tmpDb2(): string {
    return path.join(os.tmpdir(), `mesh-downlink-ident-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  }

  function taskMsg(to: string): MeshMessage {
    return {
      id: "msg-1787833328553-0-tvjf-unknown",
      from: "computer1:cc-brain",
      to,
      type: "task",
      payload: "把 M2 跨机链路验通",
      createdAt: "2026-08-27T12:22:08.553Z",
      meta: { _task: { title: "E2E-M2-跨机试单", project: "P62", pickReason: "explicit" } },
    }
  }

  it("pull 目标着陆：库里就是原 id/type/meta，只一行，getInbox 看得到 task", async () => {
    const registry = new Registry()
    const term = new MockTerminal()
    const store = new Store(tmpDb2())
    const n = pullNode("cc-e2e-probe")
    registry.register(n)
    const m = taskMsg(n.identity.nodeId)

    const r = await deliverDownlinkMessage({
      msg: m, registry, terminal: term,
      saveMessage: (mm) => store.saveMessageIfAbsent(mm),
    })
    assert.equal(r.reason, "pull-accepted")

    const inbox = store.getInbox(n.identity.nodeId)
    assert.equal(inbox.length, 1, "只一行")
    assert.equal(inbox[0].id, "msg-1787833328553-0-tvjf-unknown", "id 绝不重铸")
    assert.equal(inbox[0].type, "task", "type 不能退化成 chat —— pull worker 靠它认派单")
    assert.deepEqual(inbox[0].meta, { _task: { title: "E2E-M2-跨机试单", project: "P62", pickReason: "explicit" } })
    assert.equal(inbox[0].payload, "把 M2 跨机链路验通", "payload 原文，不含 [mesh:] 前缀")
    assert.equal(inbox[0].from, "computer1:cc-brain")
    store.close()
  })

  it("inject 目标着陆：注入正文带 [mesh:<from>] 前缀（跨机 pane 字节不变），库里存原文", async () => {
    const registry = new Registry()
    const term = new MockTerminal()
    const store = new Store(tmpDb2())
    const n = node("cc-inj-ident")
    registry.register(n)
    const m = taskMsg(n.identity.nodeId)

    await deliverDownlinkMessage({
      msg: m, registry, terminal: term,
      saveMessage: (mm) => store.saveMessageIfAbsent(mm),
    })

    assert.equal(term.injectLog.length, 1)
    assert.equal(
      term.injectLog[0].text,
      "[mesh:computer1:cc-brain] 把 M2 跨机链路验通",
      "注入正文 = [mesh:原发送方] + 原文",
    )
    const row = store.getMessagesSinceSeq(0, 10).find((x) => x.id === m.id)!
    assert.equal(row.payload, "把 M2 跨机链路验通", "落库的是原文，不是注入用的带前缀文本")
    assert.equal(row.type, "task")
    store.close()
  })

  it("同一原件重复着陆仍只一行（uplink retry 幂等，且不重铸 id）", async () => {
    const registry = new Registry()
    const term = new MockTerminal()
    const store = new Store(tmpDb2())
    const n = pullNode("cc-e2e-dup")
    registry.register(n)
    const m = taskMsg(n.identity.nodeId)

    await deliverDownlinkMessage({ msg: m, registry, terminal: term, saveMessage: (mm) => store.saveMessageIfAbsent(mm) })
    await deliverDownlinkMessage({ msg: m, registry, terminal: term, saveMessage: (mm) => store.saveMessageIfAbsent(mm) })

    const rows = store.getMessagesSinceSeq(0, 10).filter((x) => x.id === m.id)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].type, "task")
    store.close()
  })
})

// ===========================================================================
// 缺口 G1（高危）：跨机着陆路径不触发 wake
//
// 病：wake 判定只接在 server.ts 的**本机 send** 路径上。跨机来信走的是
// deliverDownlinkMessage（Hub → uplink.onMessage → 这里落地），全程没有 wake 判定，
// 连 WakeHook 实例都拿不到。后果精确地落在本 feature 的正题场景上：
//
//     「server:brain 从 server 派信给 computer2 的 Claude App 席位」永远不会触发唤醒。
//
// 而本机 `mesh send` 会。所以本机自测全绿、生产静默失效——最毒的组合。
//
// 判定必须与 server.ts 的本机路径**逐字同构**：
//   needsWake := outcome === "accepted" && !hasActiveConsumer(to)
//   采样(parkedAtDecision) 在 events.emit 之前
// 这两条各有一条用例钉死，防将来重构再退化。
// ===========================================================================
describe("deliverDownlinkMessage — wake 判定（G1）", () => {
  function tmpDb3(): string {
    return path.join(os.tmpdir(), `mesh-downlink-wake-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  }

  /** 只记录 notify 调用的假 WakeHook（不关心它内部怎么去抖/exec） */
  function spyWake() {
    const calls: Array<{ nodeId: string; parkedCount: number; source?: string }> = []
    return {
      calls,
      hook: {
        notify(nodeId: string, parkedCount: number, ctx?: { source?: string }) {
          calls.push({ nodeId, parkedCount, source: ctx?.source })
          return true
        },
      } as any,
    }
  }

  it("跨机着陆冷 pull 节点 → wake.notify 被调，nodeId 正确（P2，G1 定案）", async () => {
    const registry = new Registry()
    const term = new MockTerminal()
    const store = new Store(tmpDb3())
    const w = spyWake()
    const n = pullNode("cc-cross")
    registry.register(n)

    const r = await deliverDownlinkMessage({
      msg: msg(n.identity.nodeId),
      registry,
      terminal: term,
      saveMessage: (mm) => store.saveMessageIfAbsent(mm),
      wake: w.hook,
    })

    assert.equal(r.reason, "pull-accepted")
    assert.deepEqual(w.calls, [{ nodeId: n.identity.nodeId, parkedCount: 0, source: "downlink" }])
    store.close()
  })

  it("跨机着陆时有活跃消费者 → 不唤醒（P3，本来就有人接货）", async () => {
    const registry = new Registry()
    const term = new MockTerminal()
    const store = new Store(tmpDb3())
    const w = spyWake()
    const n = pullNode("cc-cross-parked")
    registry.register(n)
    registry.markParked(n.identity.nodeId) // 真挂着长轮询

    await deliverDownlinkMessage({
      msg: msg(n.identity.nodeId),
      registry,
      terminal: term,
      saveMessage: (mm) => store.saveMessageIfAbsent(mm),
      wake: w.hook,
    })

    assert.equal(w.calls.length, 0)
    store.close()
  })

  it("parkedCount 采样必须早于 emit（P4，与 server.ts:505 同构）", async () => {
    // 病灶复现：events.emit 是同步的，停车中的 sync 会当场 settle 并把 parkedCount
    // 减到 0。采样晚一步读到的就是"已经被服务过"的残局。
    // 这里用手搓 registry 把 parked 与 presence 两条腿拆开，才测得出采样顺序本身
    // （真 Registry 里 markParked 会同时刷 lastSyncAt，freshness 那条腿会替它兜住，
    //   于是顺序错了也看不出来——那是巧合，不是保证）。
    const bus = new MeshEventBus()
    let parked = 2
    const fakeRegistry = {
      get: () => pullNode("cc-order"),
      getParkedCount: () => parked,
      hasActiveConsumer: () => false,
      unregister: () => {},
      getAll: () => [],
    } as any
    // 模拟"本条消息把停车连接 settle 掉了"
    bus.on("msg:send", () => { parked = 0 })

    const w = spyWake()
    await deliverDownlinkMessage({
      msg: msg("macbook:cc-order"),
      registry: fakeRegistry,
      terminal: new MockTerminal(),
      events: bus,
      wake: w.hook,
    })

    assert.equal(w.calls.length, 1)
    assert.equal(w.calls[0]!.parkedCount, 2, "采样必须是 emit 之前的值，不是 settle 后的残局")
  })

  it("跨机着陆 inject 节点 → 不唤醒（inject 结构上产生不了 accepted）", async () => {
    const registry = new Registry()
    const term = new MockTerminal()
    const w = spyWake()
    const n = node("cc-cross-pane")
    registry.register(n)

    const r = await deliverDownlinkMessage({ msg: msg(n.identity.nodeId), registry, terminal: term, wake: w.hook })
    assert.equal(r.delivered, true)
    assert.equal(w.calls.length, 0)
  })

  it("不传 wake（旧调用方）→ 行为一字不变，不崩（向后兼容）", async () => {
    const registry = new Registry()
    const term = new MockTerminal()
    const store = new Store(tmpDb3())
    const n = pullNode("cc-nowake")
    registry.register(n)
    const r = await deliverDownlinkMessage({
      msg: msg(n.identity.nodeId), registry, terminal: term,
      saveMessage: (mm) => store.saveMessageIfAbsent(mm),
    })
    assert.equal(r.reason, "pull-accepted")
    store.close()
  })
})
