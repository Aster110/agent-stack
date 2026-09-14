/**
 * relay 重启恢复 + 温唤醒接缝 — 集成契约（任务1 / 任务2）
 *
 * 任务1 的坑（今天三台机各中一次）：注册表只在内存，relay 一重启就空。
 * pull 模式节点（GUI Claude app）于是**全体失联且不自知**——消息落库没人醒，
 * /api/sync 直接 404 "node not registered"。注册信息本来就落了 store 的 nodes 表，
 * 缺的只是启动时读回来。
 *
 * 语义红线（本文件逐条钉死）：
 *   - 恢复的节点**不得假装 online**：presence 照既有 lastSeen/sync 逻辑自然演化，
 *     恢复后没 sync 过就是 offline。
 *   - pull 节点的 sync 游标本就持久化（ack_cursors），恢复身份后老游标继续有效。
 *   - 重复注册（同 nodeId 再 POST /api/register）语义保持现状：刷新覆盖。
 *   - unregister 要同步删库 —— 重启后不许诈尸。
 *
 * 任务2：投给「没有活跃消费者」的 pull 节点时广播 wake:needed（60s 去抖）。
 */
import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { createServer, type MeshServer } from "./server.js"
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import type { ITerminal, SpawnResult } from "./terminal/interface.js"
import { CompositeTerminal } from "./terminal/composite.js"
import { MeshEventBus } from "./events.js"
import os from "node:os"
import path from "node:path"
import fs from "node:fs"

class MockTerminal implements ITerminal {
  injectLog: Array<{ sessionId: string; text: string }> = []
  async inject(sessionId: string, text: string): Promise<boolean> {
    this.injectLog.push({ sessionId, text })
    return true
  }
  async spawn(): Promise<SpawnResult> { return { sessionId: "mock", windowId: "mock" } }
  async isAlive(): Promise<boolean> { return true }
  async close(): Promise<void> {}
  async getCurrentSession(): Promise<null> { return null }
  async notify(): Promise<boolean> { return true }

  // ===== 身份指纹（tmux display-message 的替身）=====
  // sessionId → 指纹；映射里没有 = session 已消失（tmux 命令失败）
  identityMap = new Map<string, string>()
  identityCalls: string[] = []
  async identity(sessionId: string): Promise<string | null> {
    this.identityCalls.push(sessionId)
    return this.identityMap.get(sessionId) ?? null
  }
}

/** 不实现 identity() 的终端（iTerm2 等）——验不了身份就不该拦投递。 */
class MockTerminalNoIdentity implements ITerminal {
  injectLog: Array<{ sessionId: string; text: string }> = []
  async inject(sessionId: string, text: string): Promise<boolean> {
    this.injectLog.push({ sessionId, text })
    return true
  }
  async spawn(): Promise<SpawnResult> { return { sessionId: "mock", windowId: "mock" } }
  async isAlive(): Promise<boolean> { return true }
  async close(): Promise<void> {}
  async getCurrentSession(): Promise<null> { return null }
}

/** 显式声明 identity 能力的终端：null/throw 都代表真实身份校验失败，不是旧版缺能力。 */
class ExplicitIdentityTerminal extends MockTerminal {
  constructor(private readonly mode: "map" | "null" | "throw" = "map") {
    super()
  }

  supportsIdentity(): boolean { return true }

  override async identity(sessionId: string): Promise<string | null> {
    this.identityCalls.push(sessionId)
    if (this.mode === "throw") throw new Error("synthetic identity failure")
    if (this.mode === "null") return null
    return this.identityMap.get(sessionId) ?? null
  }
}

interface Booted {
  server: Server
  base: string
  app: MeshServer
  bus: MeshEventBus
  term: MockTerminal
  /** 停机：关 HTTP + 关库句柄（模拟 relay 进程退出，不删库文件） */
  halt: () => Promise<void>
}

/** 在给定 db 上起一台 relay。同一个 dbPath 反复 boot = 反复重启同一台机器。 */
async function boot(db: string, terminal?: ITerminal): Promise<Booted> {
  const term = (terminal ?? new MockTerminal()) as MockTerminal
  const bus = new MeshEventBus()
  const app = createServer({ dbPath: db, deviceId: "macbook", terminal: term, events: bus, identityRetryMs: 0 } as any)
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s))
  })
  const addr = server.address() as AddressInfo
  const halt = async () => {
    await new Promise<void>((r) => server.close(() => r()))
    app.store.close()
  }
  return { server, base: `http://localhost:${addr.port}`, app, bus, term, halt }
}

function tmpDb(tag: string): string {
  return path.join(os.tmpdir(), `mesh-restore-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
}
function rmDb(db: string): void {
  for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(db + ext) } catch {} }
}

async function httpGet(base: string, p: string): Promise<{ status: number; data: any }> {
  const res = await fetch(`${base}${p}`)
  return { status: res.status, data: await res.json().catch(() => null) }
}
async function httpPost(base: string, p: string, body?: unknown, headers?: Record<string, string>) {
  const res = await fetch(`${base}${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, data: await res.json().catch(() => null) }
}
async function httpDelete(base: string, p: string) {
  const res = await fetch(`${base}${p}`, { method: "DELETE" })
  return { status: res.status, data: await res.json().catch(() => null) }
}

async function registerPull(base: string, shortId: string): Promise<string> {
  const r = await httpPost(base, "/api/register", { shortId, pid: 1, role: "worker", description: "pull", deliveryMode: "pull" })
  return r.data.data.nodeId as string
}
async function registerInject(base: string, shortId: string): Promise<string> {
  const r = await httpPost(base, "/api/register", { shortId, sessionId: `sess-${shortId}`, pid: 1, role: "worker", description: "inject" })
  return r.data.data.nodeId as string
}
let sendCounter = 0
async function send(base: string, to: string, message: string) {
  return httpPost(base, "/api/send", { to, message }, { "X-Mesh-Node": `macbook:cc-sender-${++sendCounter}` })
}
async function statusOf(base: string, nodeId: string): Promise<any> {
  const r = await httpGet(base, "/api/status")
  return r.data.data.nodes.find((n: any) => n.identity.nodeId === nodeId)
}

// ===========================================================================
// 任务1：重启恢复
// ===========================================================================
describe("relay 重启 — 注册表从 SQLite 恢复", () => {
  it("重启前注册的 pull 节点，重启后仍在 /api/status 里", async () => {
    const db = tmpDb("basic")
    const a = await boot(db)
    const nodeId = await registerPull(a.base, "cc-gui")
    await a.halt()

    const b = await boot(db)
    try {
      assert.equal(b.app.restoredNodeCount, 1, "启动应恢复 1 个节点")
      const node = await statusOf(b.base, nodeId)
      assert.ok(node, "重启后节点必须还在")
      assert.equal(node.identity.deliveryMode, "pull", "deliveryMode 要跟着恢复")
    } finally {
      await b.halt(); rmDb(db)
    }
  })

  it("恢复的 pull 节点不假装 online：status=offline，parkedCount=0", async () => {
    const db = tmpDb("offline")
    const a = await boot(db)
    const nodeId = await registerPull(a.base, "cc-gui")
    // 重启前让它 sync 一次（lastSyncAt 有值、presence 是 idle）
    await httpGet(a.base, `/api/sync?nodeId=${nodeId}&timeout=0`)
    assert.equal((await statusOf(a.base, nodeId)).status, "idle", "前提：重启前它是 idle")
    await a.halt()

    const b = await boot(db)
    try {
      const node = await statusOf(b.base, nodeId)
      // 这是本任务最关键的一条：恢复的是身份，不是在线状态。
      // lastSyncAt 不跨重启恢复 → 派生回 offline，直到它自己再 sync。
      assert.equal(node.status, "offline", "恢复 ≠ 宣布在线")
      assert.equal(node.parkedCount, 0)
      assert.equal(node.lastSyncAt, null)
    } finally {
      await b.halt(); rmDb(db)
    }
  })

  it("恢复的节点自己 sync 一次后，presence 自然演化回 idle", async () => {
    const db = tmpDb("evolve")
    const a = await boot(db)
    const nodeId = await registerPull(a.base, "cc-gui")
    await a.halt()

    const b = await boot(db)
    try {
      assert.equal((await statusOf(b.base, nodeId)).status, "offline")
      await httpGet(b.base, `/api/sync?nodeId=${nodeId}&timeout=0`)
      assert.equal((await statusOf(b.base, nodeId)).status, "idle", "sync 过就该转 idle")
    } finally {
      await b.halt(); rmDb(db)
    }
  })

  it("痛点回归：重启后 /api/sync 不再 404 node not registered", async () => {
    const db = tmpDb("sync404")
    const a = await boot(db)
    const nodeId = await registerPull(a.base, "cc-gui")
    await a.halt()

    const b = await boot(db)
    try {
      const r = await httpGet(b.base, `/api/sync?nodeId=${nodeId}&timeout=0`)
      assert.equal(r.status, 200, "这就是今天三台机踩的坑：重启后 pull 节点 sync 被 404")
      assert.equal(r.data.ok, true)
    } finally {
      await b.halt(); rmDb(db)
    }
  })

  it("重启前落库的消息，重启后该节点 sync 照样取得到", async () => {
    const db = tmpDb("msg")
    const a = await boot(db)
    const nodeId = await registerPull(a.base, "cc-gui")
    const sent = await send(a.base, nodeId, "重启前发的活")
    assert.equal(sent.data.data.status, "accepted", "pull 形态落库即 accepted")
    await a.halt()

    const b = await boot(db)
    try {
      const r = await httpGet(b.base, `/api/sync?nodeId=${nodeId}&timeout=0`)
      assert.equal(r.status, 200)
      assert.equal(r.data.data.messages.length, 1)
      assert.equal(r.data.data.messages[0].payload, "重启前发的活")
    } finally {
      await b.halt(); rmDb(db)
    }
  })

  it("老 ack 游标跨重启继续有效（恢复身份即接上游标，不重投旧消息）", async () => {
    const db = tmpDb("cursor")
    const a = await boot(db)
    const nodeId = await registerPull(a.base, "cc-gui")
    await send(a.base, nodeId, "第一条")
    const first = await httpGet(a.base, `/api/sync?nodeId=${nodeId}&timeout=0`)
    const nextSince = first.data.data.nextSince as number
    // 显式 ack 到 nextSince，推进服务端游标
    await httpPost(a.base, "/api/ack", { nodeId, upTo: nextSince })
    await a.halt()

    const b = await boot(db)
    try {
      // 缺省 since = 服务端游标 → 不该把「第一条」重投一遍
      const r = await httpGet(b.base, `/api/sync?nodeId=${nodeId}&timeout=0`)
      assert.deepEqual(r.data.data.messages, [], "老游标继续有效，已销账的不重投")
      // 新消息照收
      await send(b.base, nodeId, "重启后的新活")
      const r2 = await httpGet(b.base, `/api/sync?nodeId=${nodeId}&timeout=0`)
      assert.equal(r2.data.data.messages.length, 1)
      assert.equal(r2.data.data.messages[0].payload, "重启后的新活")
    } finally {
      await b.halt(); rmDb(db)
    }
  })

  it("inject 节点也恢复，sessionId / pid / role 原样带回", async () => {
    const db = tmpDb("inject")
    const a = await boot(db)
    a.term.identityMap.set("sess-cc-tmux", "sess-cc-tmux|/work|codex")
    const nodeId = await registerInject(a.base, "cc-tmux")
    await a.halt()

    // 重启后 session 仍在且身份一致 → 校验通过才投得出去
    const term = new MockTerminal()
    term.identityMap.set("sess-cc-tmux", "sess-cc-tmux|/work|codex")
    const b = await boot(db, term)
    try {
      const node = await statusOf(b.base, nodeId)
      assert.ok(node)
      assert.equal(node.sessionId, "sess-cc-tmux")
      assert.equal(node.identity.role, "worker")
      assert.equal(node.identity.deliveryMode, "inject")
      // 恢复后能直接收消息（不用等它自己重新注册）
      const sent = await send(b.base, nodeId, "hi")
      assert.equal(sent.data.data.status, "delivered")
      assert.equal(term.injectLog.length, 1)
    } finally {
      await b.halt(); rmDb(db)
    }
  })

  it("lastSeen 用库里的真值，不刷成重启时刻", async () => {
    const db = tmpDb("lastseen")
    const a = await boot(db)
    const nodeId = await registerPull(a.base, "cc-gui")
    const before = (await statusOf(a.base, nodeId)).lastSeen
    await a.halt()
    await new Promise((r) => setTimeout(r, 15))

    const b = await boot(db)
    try {
      assert.equal((await statusOf(b.base, nodeId)).lastSeen, before, "不许伪造「刚刚还活着」")
    } finally {
      await b.halt(); rmDb(db)
    }
  })

  it("unregister 同步删库 —— 重启后不诈尸", async () => {
    const db = tmpDb("unreg")
    const a = await boot(db)
    const gui = await registerPull(a.base, "cc-gui")
    const other = await registerPull(a.base, "cc-keep")
    await httpDelete(a.base, `/api/register/${gui}`)
    await a.halt()

    const b = await boot(db)
    try {
      assert.equal(b.app.restoredNodeCount, 1, "只该恢复没被注销的那个")
      assert.equal(await statusOf(b.base, gui), undefined, "注销掉的不许复活")
      assert.ok(await statusOf(b.base, other))
    } finally {
      await b.halt(); rmDb(db)
    }
  })

  it("全量 unregister 后重启，注册表是空的", async () => {
    const db = tmpDb("unregall")
    const a = await boot(db)
    await registerPull(a.base, "cc-a")
    await registerInject(a.base, "cc-b")
    await httpDelete(a.base, "/api/register")
    await a.halt()

    const b = await boot(db)
    try {
      assert.equal(b.app.restoredNodeCount, 0)
      assert.equal((await httpGet(b.base, "/api/status")).data.data.nodes.length, 0)
    } finally {
      await b.halt(); rmDb(db)
    }
  })

  it("重复注册语义不变：同 nodeId 再 POST 覆盖刷新，不产生第二个节点", async () => {
    const db = tmpDb("dup")
    const a = await boot(db)
    const nodeId = await registerPull(a.base, "cc-gui")
    // 同 shortId 换个 role/description 再注册一次
    await httpPost(a.base, "/api/register", { shortId: "cc-gui", pid: 999, role: "main", description: "刷新后", deliveryMode: "pull" })
    const nodes = (await httpGet(a.base, "/api/status")).data.data.nodes
    assert.equal(nodes.length, 1, "重复注册不该长出第二个")
    assert.equal(nodes[0].identity.role, "main", "刷新覆盖")
    await a.halt()

    const b = await boot(db)
    try {
      assert.equal(b.app.restoredNodeCount, 1)
      const node = await statusOf(b.base, nodeId)
      assert.equal(node.identity.role, "main", "恢复的是刷新后的那份")
      assert.equal(node.pid, 999)
    } finally {
      await b.halt(); rmDb(db)
    }
  })

  it("恢复之后再注册同一个节点，用的是新鲜数据（真注册赢过旧库行）", async () => {
    const db = tmpDb("freshwins")
    const a = await boot(db)
    await registerPull(a.base, "cc-gui")
    await a.halt()

    const b = await boot(db)
    try {
      const nodeId = await registerPull(b.base, "cc-gui")
      await httpGet(b.base, `/api/sync?nodeId=${nodeId}&timeout=0`)
      assert.equal((await statusOf(b.base, nodeId)).status, "idle")
      assert.equal((await httpGet(b.base, "/api/status")).data.data.nodes.length, 1)
    } finally {
      await b.halt(); rmDb(db)
    }
  })

  it("逃生阀 MESH_REGISTRY_RESTORE=0 → 回到旧行为（空表启动）", async () => {
    const db = tmpDb("escape")
    const a = await boot(db)
    await registerPull(a.base, "cc-gui")
    await a.halt()

    const prev = process.env.MESH_REGISTRY_RESTORE
    process.env.MESH_REGISTRY_RESTORE = "0"
    const b = await boot(db)
    try {
      assert.equal(b.app.restoredNodeCount, 0)
      assert.equal((await httpGet(b.base, "/api/status")).data.data.nodes.length, 0)
    } finally {
      if (prev === undefined) delete process.env.MESH_REGISTRY_RESTORE
      else process.env.MESH_REGISTRY_RESTORE = prev
      await b.halt(); rmDb(db)
    }
  })

  it("空库首次启动：恢复 0 条，不报错", async () => {
    const db = tmpDb("empty")
    const a = await boot(db)
    try {
      assert.equal(a.app.restoredNodeCount, 0)
      assert.equal((await httpGet(a.base, "/api/status")).data.data.nodes.length, 0)
    } finally {
      await a.halt(); rmDb(db)
    }
  })
})

// ===========================================================================
// 恢复态 inject 节点：投递前验活 + 验身份
// ===========================================================================
// relay 存的 sessionId 是 **tmux session 名**，不是 pane id。session 被 kill 之后
// 别的进程建一个同名 session，`tmux has-session` 照样返回 true —— 光验活挡不住。
// 于是恢复态节点的消息会被喂进一个**陌生 pane**：静默、不可见、无回执。
// 主脑（server:brain）是唯一本体，喂错 pane = 指令进黑洞，比「显示成在线」严重一个量级。
//
// 做法：注册时把 `session_name|pane_current_path|pane_current_command` 存成指纹，
// 恢复态节点首次投递前再取一次比对。
const BRAIN_FP = "brain|/home/example/workspace/project|codex"

/** 注册主脑样板节点 server:brain（session 名 brain、cwd project、前台 codex、inject 模式）。 */
async function registerBrain(base: string, term: MockTerminal): Promise<string> {
  term.identityMap.set("brain", BRAIN_FP)
  const r = await httpPost(base, "/api/register", {
    shortId: "brain", sessionId: "brain", pid: 4242, role: "main", description: "主脑",
  })
  return r.data.data.nodeId as string
}

describe("恢复态 inject 节点 — 投递前验活 + 验身份", () => {
  it("① session 消失 → 消息落库不投，节点降为 offline", async () => {
    const db = tmpDb("id-gone")
    const a = await boot(db)
    const nodeId = await registerBrain(a.base, a.term)
    await a.halt()

    // 重启：tmux 里已经没有 brain 这个 session 了
    const term = new MockTerminal()   // identityMap 空 = session 不存在
    const b = await boot(db, term)
    try {
      const r = await send(b.base, nodeId, "重启后派给主脑的活")
      assert.equal(r.data.data.status, "queued", "session 没了不能算投递成功")
      assert.equal(term.injectLog.length, 0, "绝不许往不存在的 session 灌字")
      assert.equal((await statusOf(b.base, nodeId)).status, "offline")
      // 消息仍在库里，没丢
      const inbox = await httpGet(b.base, `/api/inbox?nodeId=${nodeId}`)
      assert.equal(inbox.data.data.messages.length, 1)
      assert.equal(inbox.data.data.messages[0].payload, "重启后派给主脑的活")
    } finally {
      await b.halt(); rmDb(db)
    }
  })

  it("② session 名被复用但身份不符 → 消息落库不投（这就是 has-session 挡不住的洞）", async () => {
    const db = tmpDb("id-mismatch")
    const a = await boot(db)
    const nodeId = await registerBrain(a.base, a.term)
    await a.halt()

    // 重启：brain 这个名字还在，但里面已经是别人了（另一个 cwd、另一个前台进程）
    const term = new MockTerminal()
    term.identityMap.set("brain", "brain|/home/someone/other-repo|bash")
    const b = await boot(db, term)
    try {
      const r = await send(b.base, nodeId, "本该给主脑的机密指令")
      assert.equal(r.data.data.status, "queued")
      assert.equal(term.injectLog.length, 0, "同名陌生 pane 一个字都不许喂")
      assert.equal((await statusOf(b.base, nodeId)).status, "offline")
      assert.equal((await statusOf(b.base, nodeId)).identityVerified, false)
    } finally {
      await b.halt(); rmDb(db)
    }
  })

  it("③ 身份匹配 → 转 online 正常投递", async () => {
    const db = tmpDb("id-match")
    const a = await boot(db)
    const nodeId = await registerBrain(a.base, a.term)
    await a.halt()

    // 重启：主脑还是那个主脑
    const term = new MockTerminal()
    term.identityMap.set("brain", BRAIN_FP)
    const b = await boot(db, term)
    try {
      // 验证前：恢复态 inject 节点不假装在线
      assert.equal((await statusOf(b.base, nodeId)).status, "offline", "没验过就不许显示在线")

      const r = await send(b.base, nodeId, "确认身份后的活")
      assert.equal(r.data.data.status, "delivered")
      assert.equal(term.injectLog.length, 1)
      assert.match(term.injectLog[0]!.text, /确认身份后的活/)

      const node = await statusOf(b.base, nodeId)
      assert.equal(node.status, "idle", "验过就转 online")
      assert.equal(node.identityVerified, true)
    } finally {
      await b.halt(); rmDb(db)
    }
  })

  it("验过一次就不再重复跑 tmux（只在首次投递前验）", async () => {
    const db = tmpDb("id-once")
    const a = await boot(db)
    const nodeId = await registerBrain(a.base, a.term)
    await a.halt()

    const term = new MockTerminal()
    term.identityMap.set("brain", BRAIN_FP)
    const b = await boot(db, term)
    try {
      await send(b.base, nodeId, "第一条")
      const afterFirst = term.identityCalls.length
      await send(b.base, nodeId, "第二条")
      await send(b.base, nodeId, "第三条")
      assert.equal(term.identityCalls.length, afterFirst, "验过就该缓存，别每条消息都敲 tmux")
      assert.equal(term.injectLog.length, 3)
    } finally {
      await b.halt(); rmDb(db)
    }
  })

  it("身份恢复正常后能自愈（不匹配不是永久death sentence）", async () => {
    const db = tmpDb("id-heal")
    const a = await boot(db)
    const nodeId = await registerBrain(a.base, a.term)
    await a.halt()

    const term = new MockTerminal()
    term.identityMap.set("brain", "brain|/tmp/wrong|bash")
    const b = await boot(db, term)
    try {
      assert.equal((await send(b.base, nodeId, "先挡下")).data.data.status, "queued")
      // 真主脑回来了（同名 session 恢复成原来的身份）
      term.identityMap.set("brain", BRAIN_FP)
      assert.equal((await send(b.base, nodeId, "现在能投了")).data.data.status, "delivered")
      assert.equal(term.injectLog.length, 1)
    } finally {
      await b.halt(); rmDb(db)
    }
  })

  it("新注册（非恢复态）节点不被拦：注册时刚取过指纹，直接投", async () => {
    const db = tmpDb("id-fresh")
    const a = await boot(db)
    try {
      const nodeId = await registerBrain(a.base, a.term)
      const callsAfterRegister = a.term.identityCalls.length
      const r = await send(a.base, nodeId, "刚注册就发")
      assert.equal(r.data.data.status, "delivered")
      assert.equal(a.term.identityCalls.length, callsAfterRegister, "刚注册过不用再验一遍")
      assert.equal((await statusOf(a.base, nodeId)).identityVerified, true)
    } finally {
      await a.halt(); rmDb(db)
    }
  })

  it("终端不支持 identity()（iTerm2 等）→ 不拦投递，行为同旧版", async () => {
    const db = tmpDb("id-nosupport")
    const a = await boot(db, new MockTerminalNoIdentity())
    const nodeId = (await httpPost(a.base, "/api/register", {
      shortId: "brain", sessionId: "brain", pid: 1, role: "main", description: "主脑",
    })).data.data.nodeId as string
    await a.halt()

    const term = new MockTerminalNoIdentity()
    const b = await boot(db, term as any)
    try {
      const r = await send(b.base, nodeId, "验不了就别拦")
      assert.equal(r.data.data.status, "delivered")
      assert.equal(term.injectLog.length, 1)
    } finally {
      await b.halt(); rmDb(db)
    }
  })

  it("老库没存过指纹 → 只验活，通过后补录基线", async () => {
    const db = tmpDb("id-backfill")
    // 用不支持 identity 的终端注册 → 库里没有指纹（模拟升级前的老行）
    const a = await boot(db, new MockTerminalNoIdentity())
    const nodeId = (await httpPost(a.base, "/api/register", {
      shortId: "brain", sessionId: "brain", pid: 1, role: "main", description: "主脑",
    })).data.data.nodeId as string
    await a.halt()

    const term = new MockTerminal()
    term.identityMap.set("brain", BRAIN_FP)
    const b = await boot(db, term)
    try {
      // 没有基线就没法比对身份，但 session 活着 —— 拦下来只会让所有老节点集体失联
      const r = await send(b.base, nodeId, "老节点第一条")
      assert.equal(r.data.data.status, "delivered", "没基线时不许把老节点全掐死")
      assert.equal(b.app.store.getNode(nodeId)?.identityFp, BRAIN_FP, "顺手补录基线")
    } finally {
      await b.halt()   // 注意：这里**不能** rmDb —— 下面还要用同一个库验补录结果
    }
    // 补录之后再重启一次：这回就是完整身份校验了
    const term2 = new MockTerminal()
    term2.identityMap.set("brain", "brain|/somewhere/else|bash")
    const c = await boot(db, term2)
    try {
      assert.equal((await send(c.base, nodeId, "冒名顶替")).data.data.status, "queued",
                   "补录过基线，下次重启就挡得住了")
    } finally {
      await c.halt(); rmDb(db)
    }
  })

  it("codex 自愈重启瞬时态：前台暂时是 bash，重试时已恢复 → 放行", async () => {
    // 主脑的 codex 外面套着 while 自愈循环，崩了自己重启。
    // 重启那一瞬 pane_current_command 短暂是 bash——整串比对会把这个正常瞬时态
    // 判成"被顶替"，于是主脑在自愈期间彻底收不到消息。这条钉住不许那样。
    const db = tmpDb("id-transient")
    const a = await boot(db)
    const nodeId = await registerBrain(a.base, a.term)
    await a.halt()

    const term = new MockTerminal()
    term.identityMap.set("brain", "brain|/home/example/workspace/project|bash")   // 重启中
    const b = await boot(db, term)
    try {
      // 第一次取到 bash → soft-mismatch → 重试；重试前 codex 已经起回来了
      let calls = 0
      const orig = term.identity.bind(term)
      term.identity = async (sid: string) => {
        calls++
        if (calls >= 2) term.identityMap.set("brain", BRAIN_FP)
        return orig(sid)
      }
      const r = await send(b.base, nodeId, "自愈期间派的活")
      assert.equal(r.data.data.status, "delivered", "瞬时 bash 不该把主脑掐掉")
      assert.ok(calls >= 2, "软不匹配必须重试一次再判")
      assert.equal(term.injectLog.length, 1)
    } finally {
      await b.halt(); rmDb(db)
    }
  })

  it("连续两次前台进程名都不符 → 才降级（不是一次就判死）", async () => {
    const db = tmpDb("id-twice")
    const a = await boot(db)
    const nodeId = await registerBrain(a.base, a.term)
    await a.halt()

    const term = new MockTerminal()
    term.identityMap.set("brain", "brain|/home/example/workspace/project|bash")   // 一直是 bash
    const b = await boot(db, term)
    try {
      const r = await send(b.base, nodeId, "两次都不符")
      assert.equal(r.data.data.status, "queued")
      assert.equal(term.injectLog.length, 0)
      assert.ok(term.identityCalls.length >= 2, "降级前必须给过一次重试机会")
    } finally {
      await b.halt(); rmDb(db)
    }
  })

  it("cwd 变了 → 立刻降级，不给软重试（那是真换了人）", async () => {
    const db = tmpDb("id-cwd")
    const a = await boot(db)
    const nodeId = await registerBrain(a.base, a.term)
    await a.halt()

    const term = new MockTerminal()
    term.identityMap.set("brain", "brain|/home/someone/other-repo|codex")
    const b = await boot(db, term)
    try {
      const r = await send(b.base, nodeId, "同名不同 cwd")
      assert.equal(r.data.data.status, "queued")
      assert.equal(term.identityCalls.length, 1, "硬不匹配不该浪费一次重试")
    } finally {
      await b.halt(); rmDb(db)
    }
  })

  it("pull 节点不走身份校验（没有 pane 可验）", async () => {
    const db = tmpDb("id-pull")
    const a = await boot(db)
    const nodeId = await registerPull(a.base, "cc-gui")
    await a.halt()

    const term = new MockTerminal()
    const b = await boot(db, term)
    try {
      const r = await send(b.base, nodeId, "给 pull 的活")
      assert.equal(r.data.data.status, "accepted")
      assert.equal(term.identityCalls.length, 0, "pull 节点没 pane，别去敲 tmux")
    } finally {
      await b.halt(); rmDb(db)
    }
  })

  it("指纹随注册落库，重启后读得回来", async () => {
    const db = tmpDb("id-persist")
    const a = await boot(db)
    const nodeId = await registerBrain(a.base, a.term)
    assert.equal(a.app.store.getNode(nodeId)?.identityFp, BRAIN_FP)
    await a.halt()

    const b = await boot(db, new MockTerminal())
    try {
      assert.equal(b.app.store.getNode(nodeId)?.identityFp, BRAIN_FP)
      assert.equal(b.app.registry.get(nodeId)?.identityFp, BRAIN_FP, "恢复进内存的也要带着指纹")
    } finally {
      await b.halt(); rmDb(db)
    }
  })
})

// ===========================================================================
// identity capability 三态：真实无能力兼容 / 隐式或显式支持失败 / 支持成功
// ===========================================================================
describe("inject identity capability 三态 — 注册、SQLite、重启、投递", () => {
  it("真正不支持 identity 的终端：NULL 基线跨重启仍兼容 delivered", async () => {
    const db = tmpDb("id-cap-unsupported")
    const sessionId = "sess-unsupported-capability"
    let running: Booted | undefined
    try {
      const initial = new MockTerminalNoIdentity()
      assert.equal(typeof (initial as ITerminal).identity, "undefined", "前提：终端真正不提供 identity")
      assert.equal(typeof (initial as ITerminal).supportsIdentity, "undefined")
      running = await boot(db, initial)
      const nodeId = await registerInject(running.base, "unsupported-capability")
      assert.equal(running.app.store.getNode(nodeId)?.identityFp, undefined, "无 identity 能力只能持久化 NULL")
      await running.halt()
      running = undefined

      const restored = new MockTerminalNoIdentity()
      assert.equal(typeof (restored as ITerminal).identity, "undefined")
      running = await boot(db, restored)
      assert.equal(running.app.store.getNode(nodeId)?.identityFp, undefined)
      const result = await send(running.base, nodeId, "unsupported compatibility after restart")
      assert.equal(result.data.data.status, "delivered", "真正缺 identity 能力时保持兼容投递")
      assert.equal(restored.injectLog.length, 1)
      assert.equal(restored.injectLog[0]?.sessionId, sessionId)
      assert.equal((await statusOf(running.base, nodeId)).identityVerified, true)
      assert.equal(running.app.store.getNode(nodeId)?.identityFp, undefined, "兼容放行后仍不得伪造指纹")
    } finally {
      if (running) await running.halt()
      rmDb(db)
    }
  })

  it("缺 supportsIdentity hook 但 identity=null：默认视为支持，跨重启必须 queued", async () => {
    const db = tmpDb("id-cap-missing-hook-null")
    const sessionId = "sess-missing-hook-null"
    let running: Booted | undefined
    try {
      const initial = new MockTerminal()
      assert.equal(typeof (initial as ITerminal).supportsIdentity, "undefined", "前提：只缺 capability hook")
      assert.equal(typeof (initial as ITerminal).identity, "function", "已有 identity 方法不能静默降级为 unsupported")
      running = await boot(db, initial)
      const nodeId = await registerInject(running.base, "missing-hook-null")
      assert.equal(running.app.store.getNode(nodeId)?.identityFp, undefined)
      assert.deepEqual(initial.identityCalls, [sessionId], "注册必须实际调用 identity")
      await running.halt()
      running = undefined

      const restored = new MockTerminal()
      running = await boot(db, restored)
      const result = await send(running.base, nodeId, "missing hook null after restart")
      assert.equal(result.data.data.status, "queued", "缺 hook 不能把 identity=null 静默降级为兼容放行")
      assert.deepEqual(restored.identityCalls, [sessionId])
      assert.equal(restored.injectLog.length, 0, "identity=null 不得 inject")
      const status = await statusOf(running.base, nodeId)
      assert.equal(status.identityVerified, false)
      assert.match(status.identityMismatch, /session 不存在|验活失败/)
      assert.equal(running.app.store.getNode(nodeId)?.identityFp, undefined)
    } finally {
      if (running) await running.halt()
      rmDb(db)
    }
  })

  it("supportsIdentity=true 且 identity 返回 null 或抛错：跨重启都 mismatch queued", async () => {
    for (const mode of ["null", "throw"] as const) {
      const db = tmpDb(`id-cap-${mode}`)
      let running: Booted | undefined
      try {
        const initial = new ExplicitIdentityTerminal(mode)
        running = await boot(db, initial)
        const nodeId = await registerInject(running.base, `explicit-${mode}`)
        assert.equal(running.app.store.getNode(nodeId)?.identityFp, undefined)
        await running.halt()
        running = undefined

        const restored = new ExplicitIdentityTerminal(mode)
        running = await boot(db, restored)
        const result = await send(running.base, nodeId, `explicit ${mode} after restart`)
        assert.equal(result.data.data.status, "queued", `supportsIdentity=true + ${mode} 必须判身份失败`)
        assert.equal(restored.injectLog.length, 0, "身份失败不得 inject")
        const status = await statusOf(running.base, nodeId)
        assert.equal(status.identityVerified, false)
        assert.match(status.identityMismatch, /session 不存在|验活失败/)
        assert.equal(running.app.store.getNode(nodeId)?.identityFp, undefined)
      } finally {
        if (running) await running.halt()
        rmDb(db)
      }
    }
  })

  it("supportsIdentity=true 且有值：指纹持久化；重启正确值 verified，错误值 queued", async () => {
    const db = tmpDb("id-cap-value")
    const sessionId = "sess-explicit-value"
    const fingerprint = `${sessionId}|/work|codex`
    let running: Booted | undefined
    try {
      const initial = new ExplicitIdentityTerminal()
      initial.identityMap.set(sessionId, fingerprint)
      running = await boot(db, initial)
      const nodeId = await registerInject(running.base, "explicit-value")
      assert.equal(running.app.store.getNode(nodeId)?.identityFp, fingerprint)
      await running.halt()
      running = undefined

      const matching = new ExplicitIdentityTerminal()
      matching.identityMap.set(sessionId, fingerprint)
      running = await boot(db, matching)
      const delivered = await send(running.base, nodeId, "matching explicit identity")
      assert.equal(delivered.data.data.status, "delivered")
      assert.equal((await statusOf(running.base, nodeId)).identityVerified, true)
      assert.equal(matching.injectLog.length, 1)
      await running.halt()
      running = undefined

      const wrong = new ExplicitIdentityTerminal()
      wrong.identityMap.set(sessionId, `${sessionId}|/other|bash`)
      running = await boot(db, wrong)
      const queued = await send(running.base, nodeId, "wrong explicit identity")
      assert.equal(queued.data.data.status, "queued")
      assert.equal((await statusOf(running.base, nodeId)).identityVerified, false)
      assert.equal(wrong.injectLog.length, 0)
      assert.equal(running.app.store.getNode(nodeId)?.identityFp, fingerprint, "错误指纹不得覆盖 SQLite 基线")
    } finally {
      if (running) await running.halt()
      rmDb(db)
    }
  })
})

// ===========================================================================
// CompositeTerminal：identity 路由必须和 inject/isAlive 是同一 backend
// ===========================================================================
describe("CompositeTerminal identity — SQLite 持久化与重启投递契约", () => {
  it("非 UUID 实际 tmux 有 identity、iTerm 无 identity：落库后正确指纹 verified，错误指纹 queued", async () => {
    const db = tmpDb("composite-id-tmux")
    const sessionId = "mesh-composite-brain"
    const fingerprint = `${sessionId}|/home/example/workspace/project|codex`
    let running: Booted | undefined
    try {
      const initialTmux = new MockTerminal()
      initialTmux.identityMap.set(sessionId, fingerprint)
      const initialIterm = new MockTerminalNoIdentity()
      running = await boot(db, new CompositeTerminal({
        tmux: initialTmux,
        iterm: initialIterm,
        defaultSpawn: "iterm",
      }))
      const registered = await httpPost(running.base, "/api/register", {
        shortId: "composite-brain",
        sessionId,
        pid: 7001,
        role: "main",
        description: "composite tmux identity",
      })
      const nodeId = registered.data.data.nodeId as string
      assert.equal(running.app.store.getNode(nodeId)?.identityFp, fingerprint, "注册指纹必须写入 SQLite")
      assert.deepEqual(initialTmux.identityCalls, [sessionId], "注册必须问实际 tmux backend")
      assert.deepEqual(initialIterm.injectLog, [], "defaultSpawn=iTerm 不得改变 identity 路由")
      await running.halt()
      running = undefined

      const matchingTmux = new MockTerminal()
      matchingTmux.identityMap.set(sessionId, fingerprint)
      const matchingIterm = new MockTerminalNoIdentity()
      running = await boot(db, new CompositeTerminal({
        tmux: matchingTmux,
        iterm: matchingIterm,
        defaultSpawn: "iterm",
      }))
      assert.equal(running.app.store.getNode(nodeId)?.identityFp, fingerprint, "重启后 SQLite 指纹必须保留")
      const delivered = await send(running.base, nodeId, "composite identity verified")
      assert.equal(delivered.data.data.status, "delivered")
      assert.equal((await statusOf(running.base, nodeId)).identityVerified, true)
      assert.equal(matchingTmux.injectLog.length, 1, "正确指纹只投实际 tmux backend")
      assert.equal(matchingIterm.injectLog.length, 0)
      await running.halt()
      running = undefined

      const wrongTmux = new MockTerminal()
      wrongTmux.identityMap.set(sessionId, `${sessionId}|/tmp/wrong|bash`)
      const wrongIterm = new MockTerminalNoIdentity()
      running = await boot(db, new CompositeTerminal({
        tmux: wrongTmux,
        iterm: wrongIterm,
        defaultSpawn: "iterm",
      }))
      const queued = await send(running.base, nodeId, "must not reach reused session")
      assert.equal(queued.data.data.status, "queued")
      assert.equal((await statusOf(running.base, nodeId)).identityVerified, false)
      assert.equal(wrongTmux.injectLog.length, 0, "错误指纹不得 inject")
      assert.equal(wrongIterm.injectLog.length, 0, "不得回退到另一 backend")
      assert.equal(running.app.store.getNode(nodeId)?.identityFp, fingerprint, "错误现场不得覆盖持久基线")
    } finally {
      if (running) await running.halt()
      rmDb(db)
    }
  })

  it("UUID 实际 iTerm 有 identity、tmux 无 identity：注册持久化 iTerm 指纹", async () => {
    const db = tmpDb("composite-id-iterm")
    const sessionId = "9A7D37B4-1A2B-4C3D-8E4F-1234567890AB"
    const fingerprint = "iterm-uuid-fingerprint"
    const tmux = new MockTerminalNoIdentity()
    const iterm = new MockTerminal()
    iterm.identityMap.set(sessionId, fingerprint)
    const ts = await boot(db, new CompositeTerminal({ tmux, iterm, defaultSpawn: "tmux" }))
    try {
      const registered = await httpPost(ts.base, "/api/register", {
        shortId: "composite-iterm",
        sessionId,
        pid: 7002,
        role: "worker",
        description: "composite iterm identity",
      })
      const nodeId = registered.data.data.nodeId as string
      assert.equal(ts.app.store.getNode(nodeId)?.identityFp, fingerprint)
      assert.deepEqual(iterm.identityCalls, [sessionId], "UUID 注册必须问实际 iTerm backend")
      assert.equal(tmux.injectLog.length, 0, "defaultSpawn=tmux 不得改变 identity 路由")
    } finally {
      await ts.halt(); rmDb(db)
    }
  })

  it("UUID 实际 iTerm 无 identity：告警且 NULL 基线跨重启仍兼容 verified，不得探测 tmux 诱饵", async () => {
    const db = tmpDb("composite-id-unavailable")
    const sessionId = "6B27E1A4-8D5C-4F39-A2B7-0C91D6E45F30"
    const decoyFingerprint = `${sessionId}|/tmp/wrong-backend|bash`
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")) }
    let running: Booted | undefined
    try {
      const initialTmux = new MockTerminal()
      initialTmux.identityMap.set(sessionId, decoyFingerprint)
      const initialIterm = new MockTerminalNoIdentity()
      running = await boot(db, new CompositeTerminal({
        tmux: initialTmux,
        iterm: initialIterm,
        defaultSpawn: "tmux",
      }))
      const registered = await httpPost(running.base, "/api/register", {
        shortId: "composite-no-id",
        sessionId,
        pid: 7003,
        role: "worker",
        description: "identity unavailable",
      })
      const nodeId = registered.data.data.nodeId as string
      assert.equal(running.app.store.getNode(nodeId)?.identityFp, undefined, "SQLite identity_fp 必须保持 NULL")
      const warning = warnings.find((line) => line.includes("[mesh] identity unavailable"))
      assert.ok(warning, "inject 注册取不到 identity 必须输出可观测告警")
      assert.match(warning, new RegExp(`node=${nodeId}`))
      assert.match(warning, new RegExp(`session=${JSON.stringify(sessionId)}`))
      assert.match(warning, /仅验活/)
      assert.match(warning, /无持久指纹/)
      assert.deepEqual(initialTmux.identityCalls, [], "UUID 实际走 iTerm，不得读取 tmux 诱饵指纹")
      assert.equal(initialTmux.injectLog.length, 0, "fresh 注册阶段也不得触碰 tmux 诱饵 backend")
      await running.halt()
      running = undefined
      console.warn = originalWarn

      const restoredTmux = new MockTerminal()
      restoredTmux.identityMap.set(sessionId, decoyFingerprint)
      const restoredIterm = new MockTerminalNoIdentity()
      running = await boot(db, new CompositeTerminal({
        tmux: restoredTmux,
        iterm: restoredIterm,
        defaultSpawn: "tmux",
      }))
      assert.equal(running.app.store.getNode(nodeId)?.identityFp, undefined, "重启恢复后 identity_fp 仍须为 NULL")

      const delivered = await send(running.base, nodeId, "compatibility delivery after restart")
      assert.equal(delivered.data.data.status, "delivered", "无 identity 基线跨重启保持兼容放行")
      assert.equal((await statusOf(running.base, nodeId)).identityVerified, true, "兼容验活成功应标 verified")
      assert.equal(running.app.store.getNode(nodeId)?.identityFp, undefined, "兼容投递后不得写入伪指纹")
      assert.equal(restoredIterm.injectLog.length, 1, "UUID 消息只投实际 iTerm backend")
      assert.equal(restoredIterm.injectLog[0].sessionId, sessionId)
      assert.equal(restoredTmux.injectLog.length, 0, "不得向 tmux 诱饵 backend inject")
      assert.equal(restoredTmux.identityCalls.length, 0, "重启验身份也不得读取 tmux 诱饵指纹")
    } finally {
      console.warn = originalWarn
      if (running) await running.halt()
      rmDb(db)
    }
  })
})

// ===========================================================================
// 温唤醒默认关闭（aster 要求先过目再启用）
// ===========================================================================
describe("wake 默认关闭 — 不设 MESH_WAKE 就零行为", () => {
  it("MESH_WAKE 未设 → 投给冷 pull 节点也不广播 wake:needed", async () => {
    const prev = process.env.MESH_WAKE
    delete process.env.MESH_WAKE
    const db = tmpDb("wake-off")
    const ts = await boot(db)
    const fired: unknown[] = []
    ts.bus.on("wake:needed", (d) => fired.push(d))
    try {
      const nodeId = await registerPull(ts.base, "cc-cold")
      const r = await send(ts.base, nodeId, "冷节点收活")
      // 投递本身照常（落库 accepted），只是不唤醒——零行为零回归
      assert.equal(r.data.data.status, "accepted")
      assert.equal(fired.length, 0, "默认必须一条 wake:needed 都不发")
    } finally {
      if (prev === undefined) delete process.env.MESH_WAKE
      else process.env.MESH_WAKE = prev
      await ts.halt(); rmDb(db)
    }
  })
})

// ===========================================================================
// 任务2：wake:needed 接缝
// ===========================================================================
describe("wake:needed — 温唤醒接缝", () => {
  let ts: Booted
  let db: string
  let seen: Array<{ nodeId: string; parkedCount: number }>

  let prevWakeEnv: string | undefined

  before(async () => {
    // 温唤醒默认关闭（aster 要求先过目再启用），测它就得显式开
    prevWakeEnv = process.env.MESH_WAKE
    process.env.MESH_WAKE = "1"
    db = tmpDb("wake")
    ts = await boot(db)
    seen = []
    ts.bus.on("wake:needed", (d) => seen.push(d))
  })
  after(async () => {
    await ts.halt(); rmDb(db)
    if (prevWakeEnv === undefined) delete process.env.MESH_WAKE
    else process.env.MESH_WAKE = prevWakeEnv
  })

  it("投给没有活跃消费者的 pull 节点 → 广播 wake:needed（含 nodeId/parkedCount）", async () => {
    const nodeId = await registerPull(ts.base, "cc-cold")
    const before = seen.length
    const r = await send(ts.base, nodeId, "醒醒，有活")
    assert.equal(r.data.data.status, "accepted")
    const fired = seen.slice(before)
    assert.equal(fired.length, 1)
    assert.equal(fired[0]!.nodeId, nodeId)
    assert.equal(fired[0]!.parkedCount, 0)
  })

  it("同一节点 60 秒内重复投递不重复触发（去抖）", async () => {
    const nodeId = await registerPull(ts.base, "cc-debounce")
    const before = seen.length
    await send(ts.base, nodeId, "第一条")
    await send(ts.base, nodeId, "第二条")
    await send(ts.base, nodeId, "第三条")
    assert.equal(seen.slice(before).length, 1, "三条只该唤醒一次")
  })

  it("投给正挂着长轮询的 pull 节点 → 不唤醒（本来就有人接货）", async () => {
    const nodeId = await registerPull(ts.base, "cc-parked")
    // 真停车：不带 timeout=0，让它挂住
    const parked = fetch(`${ts.base}/api/sync?nodeId=${nodeId}&timeout=5`)
    // 等 sync 真进入停车（parkedCount 变 1）再投
    for (let i = 0; i < 100 && ts.app.registry.getParkedCount(nodeId) === 0; i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    assert.equal(ts.app.registry.getParkedCount(nodeId), 1, "前提：sync 已停车")

    const before = seen.length
    await send(ts.base, nodeId, "有人接货")
    assert.equal(seen.slice(before).length, 0, "有活跃消费者就别瞎唤醒")
    const r = await parked
    await r.json().catch(() => null)
  })

  it("投给 inject 节点 → 不唤醒（inject 直接进 pane，不走唤醒器）", async () => {
    ts.term.identityMap.set("sess-cc-pane", "sess-cc-pane|/work|codex")
    const nodeId = await registerInject(ts.base, "cc-pane")
    const before = seen.length
    const r = await send(ts.base, nodeId, "hi")
    assert.equal(r.data.data.status, "delivered")
    assert.equal(seen.slice(before).length, 0)
  })

  it("重启恢复出来的 pull 节点（offline）收到消息 → 照样唤醒", async () => {
    // 任务1 + 任务2 合流：这正是「relay 重启后 GUI 节点失联」的完整修复路径
    const db2 = tmpDb("wakerestart")
    const a = await boot(db2)
    const nodeId = await registerPull(a.base, "cc-gui")
    await a.halt()

    const b = await boot(db2)
    const fired: Array<{ nodeId: string }> = []
    b.bus.on("wake:needed", (d) => fired.push(d))
    try {
      assert.equal((await statusOf(b.base, nodeId)).status, "offline")
      await send(b.base, nodeId, "重启后派的活")
      assert.equal(fired.length, 1)
      assert.equal(fired[0]!.nodeId, nodeId)
    } finally {
      await b.halt(); rmDb(db2)
    }
  })

  it("wake:needed 在 SSE /api/events 的广播名单里", async () => {
    const nodeId = await registerPull(ts.base, "cc-sse")
    const ctrl = new AbortController()
    const res = await fetch(`${ts.base}/api/events`, { signal: ctrl.signal })
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    // 读掉握手行
    await reader.read()
    await send(ts.base, nodeId, "唤醒我")
    // 一次 send 会连发 msg:send + wake:needed，两条未必挤进同一个 chunk——
    // 累读到看见 wake:needed 为止，别赌 chunk 边界。
    let text = ""
    for (let i = 0; i < 5 && !text.includes("wake:needed"); i++) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += dec.decode(chunk.value, { stream: true })
    }
    ctrl.abort()
    assert.match(text, /wake:needed/, "SSE 订阅者必须收得到 wake:needed")
    assert.match(text, new RegExp(nodeId))
  })
})

// ===========================================================================
// G1 反退化锁：跨机着陆路径必须触发 wake —— 且用的是**同一个** WakeHook 实例
//
// 单测 downlink.test.ts 只证明"deliverDownlinkMessage 收到 wake 就会用"。
// 它证明不了 **relay 真正跑起来的那条线上有没有把 wake 接进去** —— 而 G1 这个
// bug 的全部内容就是"接缝在，没人接"。所以锁要下在组装点上：
// index.ts 里 uplink.onMessage 调的就是 app.deliverDownlink，本节直接打它。
//
// 「同一个实例」这条不是洁癖：如果 index.ts 自己 new 一个 WakeHook 传给 downlink，
// 两条路径各持一份去抖表和一份全局限速窗——同一条消息在本机与跨机两次落地会响两次铃，
// 限速也形同虚设。用「跨路径共享去抖」来钉死单实例，比断言对象相等更贴近真实后果。
// ===========================================================================
describe("G1 — 跨机 downlink 着陆触发 wake（组装点契约）", () => {
  let prevWakeEnv: string | undefined
  before(() => {
    prevWakeEnv = process.env.MESH_WAKE
    process.env.MESH_WAKE = "1"
  })
  after(() => {
    if (prevWakeEnv === undefined) delete process.env.MESH_WAKE
    else process.env.MESH_WAKE = prevWakeEnv
  })

  function downlinkMsg(to: string, id: string) {
    return {
      id,
      from: "server:brain",
      to,
      type: "task" as const,
      payload: "跨机派单",
      createdAt: new Date().toISOString(),
    }
  }

  it("app.deliverDownlink 是 index.ts 的着陆入口（接缝存在）", async () => {
    const db = tmpDb("g1-seam")
    const ts = await boot(db)
    try {
      assert.equal(typeof ts.app.deliverDownlink, "function", "index.ts 靠它落地跨机消息")
      assert.ok(ts.app.wake, "组装点必须把 WakeHook 暴露出来给 sweeper 共用")
    } finally { await ts.halt(); rmDb(db) }
  })

  it("server:brain 跨机派信给冷 pull 席位 → 唤醒（本 feature 的正题场景）", async () => {
    const db = tmpDb("g1-cross")
    const ts = await boot(db)
    const fired: Array<{ nodeId: string; parkedCount: number }> = []
    ts.bus.on("wake:needed", (d) => fired.push(d))
    try {
      const nodeId = await registerPull(ts.base, "cc-app-seat")
      const r = await ts.app.deliverDownlink(downlinkMsg(nodeId, "dl-1"))
      assert.equal(r.reason, "pull-accepted")
      assert.equal(fired.length, 1, "跨机着陆必须唤醒——G1 修复前这里恒为 0")
      assert.equal(fired[0]!.nodeId, nodeId)
      assert.equal(fired[0]!.parkedCount, 0)
      // 消息真落库了（唤醒后 sync 拿得到）
      assert.equal(ts.app.store.getInbox(nodeId).length, 1)
    } finally { await ts.halt(); rmDb(db) }
  })

  it("跨机着陆时有人挂着长轮询 → 不唤醒，且停车方拿到这条消息", async () => {
    const db = tmpDb("g1-parked")
    const ts = await boot(db)
    const fired: unknown[] = []
    ts.bus.on("wake:needed", (d) => fired.push(d))
    try {
      const nodeId = await registerPull(ts.base, "cc-app-live")
      const parked = fetch(`${ts.base}/api/sync?nodeId=${encodeURIComponent(nodeId)}&timeout=5`)
      for (let i = 0; i < 200 && ts.app.registry.getParkedCount(nodeId) === 0; i++) {
        await new Promise((r) => setTimeout(r, 10))
      }
      assert.equal(ts.app.registry.getParkedCount(nodeId), 1, "前提：sync 已停车")

      await ts.app.deliverDownlink(downlinkMsg(nodeId, "dl-2"))
      assert.equal(fired.length, 0, "有活跃消费者就别摇人")
      const body = await (await parked).json()
      assert.equal(body.data.messages.length, 1, "停车方应当场收到跨机来的这条")
      assert.equal(body.data.messages[0].payload, "跨机派单")
    } finally { await ts.halt(); rmDb(db) }
  })

  it("本机 send 与跨机着陆共享去抖 → 60s 内两条只响一次铃（单实例证明）", async () => {
    const db = tmpDb("g1-shared")
    const ts = await boot(db)
    const fired: unknown[] = []
    ts.bus.on("wake:needed", (d) => fired.push(d))
    try {
      const nodeId = await registerPull(ts.base, "cc-app-dedup")
      await send(ts.base, nodeId, "本机来的")           // 第一次响
      await ts.app.deliverDownlink(downlinkMsg(nodeId, "dl-3")) // 跨机来的，去抖窗内
      assert.equal(fired.length, 1, "两条路径若各持一个 WakeHook，这里会是 2")
    } finally { await ts.halt(); rmDb(db) }
  })

  it("跨机着陆 inject 席位 → 不唤醒（inject 结构上产生不了 accepted）", async () => {
    const db = tmpDb("g1-inject")
    const ts = await boot(db)
    const fired: unknown[] = []
    ts.bus.on("wake:needed", (d) => fired.push(d))
    try {
      const nodeId = await registerInject(ts.base, "cc-pane-dl")
      const r = await ts.app.deliverDownlink(downlinkMsg(nodeId, "dl-4"))
      assert.equal(r.delivered, true)
      assert.equal(fired.length, 0)
    } finally { await ts.halt(); rmDb(db) }
  })
})

describe("G1 — MESH_WAKE 未设时跨机着陆零行为（零回归）", () => {
  it("默认关：跨机着陆冷 pull 节点也不发一条 wake:needed", async () => {
    const prev = process.env.MESH_WAKE
    delete process.env.MESH_WAKE
    const db = tmpDb("g1-off")
    const ts = await boot(db)
    const fired: unknown[] = []
    ts.bus.on("wake:needed", (d) => fired.push(d))
    try {
      const nodeId = await registerPull(ts.base, "cc-app-off")
      const r = await ts.app.deliverDownlink({
        id: "dl-off-1", from: "server:brain", to: nodeId, type: "task",
        payload: "跨机派单", createdAt: new Date().toISOString(),
      })
      // 投递本身照常（落库 accepted），只是不唤醒
      assert.equal(r.reason, "pull-accepted")
      assert.equal(ts.app.store.getInbox(nodeId).length, 1)
      assert.equal(fired.length, 0, "默认必须一条 wake:needed 都不发")
    } finally {
      if (prev === undefined) delete process.env.MESH_WAKE
      else process.env.MESH_WAKE = prev
      await ts.halt(); rmDb(db)
    }
  })
})
