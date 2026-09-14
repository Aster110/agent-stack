/**
 * TtydManager 单元测试 — spawn/kill ttyd 进程，端口分配
 * TDD: ttyd.ts 尚未实现
 *
 * 注入 mock spawn，不真正起 ttyd 进程。
 */
import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { TtydManager } from "./ttyd.js"
import { EventEmitter } from "node:events"

interface FakeChild extends EventEmitter {
  pid: number
  killed: boolean
  kill: (sig?: string) => boolean
  unref: () => void
}

function makeFakeSpawn() {
  const children: Array<{ cmd: string; args: string[]; child: FakeChild }> = []
  let pidCounter = 9000
  const spawnFn = (cmd: string, args: string[], _opts?: any): FakeChild => {
    pidCounter++
    const ee = new EventEmitter() as FakeChild
    ee.pid = pidCounter
    ee.killed = false
    ee.kill = (_sig?: string) => {
      ee.killed = true
      setImmediate(() => ee.emit("exit", 0, null))
      return true
    }
    ee.unref = () => {}
    children.push({ cmd, args, child: ee })
    return ee
  }
  return { spawnFn, children }
}

describe("TtydManager", () => {
  let fake: ReturnType<typeof makeFakeSpawn>
  let mgr: TtydManager

  beforeEach(() => {
    fake = makeFakeSpawn()
    mgr = new TtydManager({ spawnFn: fake.spawnFn as any })
  })

  it("start(sessionId) 返回端口号（7681-8680 范围内）", async () => {
    const port = await mgr.start("cc-mesh-main")
    assert.ok(port >= 7681 && port <= 8680, `port ${port} out of range`)
  })

  it("同一 sessionId 重复 start 返回相同端口，不重复 spawn 也不 kill 旧进程", async () => {
    const p1 = await mgr.start("cc-abc")
    const p2 = await mgr.start("cc-abc")
    assert.equal(p1, p2)
    assert.equal(fake.children.length, 1)
    assert.equal(fake.children[0].child.killed, false, "旧 ttyd 不应被 kill")
  })

  it("不同 sessionId 得到不同端口（hash 不冲突，抽样 50 个）", async () => {
    const ports = new Set<number>()
    for (let i = 0; i < 50; i++) {
      const p = await mgr.start(`sid-${i}`)
      ports.add(p)
    }
    // 允许偶发碰撞，但 50 个里应 >= 48 个唯一
    assert.ok(ports.size >= 48, `期望 hash 几乎无冲突，实际唯一端口 ${ports.size}/50`)
  })

  it("跨实例同 sessionId 返回相同端口（端口函数确定性）", async () => {
    const m1 = new TtydManager({ spawnFn: makeFakeSpawn().spawnFn as any })
    const m2 = new TtydManager({ spawnFn: makeFakeSpawn().spawnFn as any })
    const p1 = await m1.start("deterministic-sid")
    const p2 = await m2.start("deterministic-sid")
    assert.equal(p1, p2, "同一 sessionId 在不同实例应分配到同一端口")
  })

  it("getPort 返回已启动的端口，未启动返回 null", async () => {
    assert.equal(mgr.getPort("never-started"), null)
    const port = await mgr.start("sess-x")
    assert.equal(mgr.getPort("sess-x"), port)
  })

  it("stop 后 getPort 返回 null", async () => {
    await mgr.start("sess-stop")
    assert.ok(mgr.getPort("sess-stop") != null)
    await mgr.stop("sess-stop")
    assert.equal(mgr.getPort("sess-stop"), null)
  })

  it("shutdown 清理所有 ttyd", async () => {
    await mgr.start("a")
    await mgr.start("b")
    await mgr.start("c")
    await mgr.shutdown()
    assert.equal(mgr.getPort("a"), null)
    assert.equal(mgr.getPort("b"), null)
    assert.equal(mgr.getPort("c"), null)
    // 所有子进程都应收到 kill
    for (const { child } of fake.children) {
      assert.equal(child.killed, true)
    }
  })

  it("start 传递正确的 ttyd 参数：-W -p <port> tmux attach -t <sessionId>", async () => {
    const sessionId = "cc-xyz"
    const port = await mgr.start(sessionId)
    assert.equal(fake.children.length, 1)
    const { cmd, args } = fake.children[0]
    assert.equal(cmd, "ttyd")
    assert.ok(args.includes("-W"))
    const pIdx = args.indexOf("-p")
    assert.ok(pIdx >= 0)
    assert.equal(args[pIdx + 1], String(port))
    assert.ok(args.includes("tmux"))
    assert.ok(args.includes("attach"))
    const tIdx = args.indexOf("-t")
    assert.equal(args[tIdx + 1], sessionId)
  })
})
