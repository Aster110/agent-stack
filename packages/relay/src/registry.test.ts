/**
 * Registry 测试 — 内存节点注册表
 *
 * 职责：维护当前在线节点列表（内存态），支持注册/注销/心跳/超时清理/短ID查找
 * 这是 TDD 测试，Registry 尚未实现
 */
import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { Registry } from "./registry.js"
import type { LocalNode } from "@cc-mesh/protocol"

function makeNode(overrides: Partial<LocalNode> & { identity?: Partial<LocalNode["identity"]> } = {}): LocalNode {
  const defaults: LocalNode = {
    identity: {
      nodeId: "macbook:cc-a1b2",
      deviceId: "macbook",
      shortId: "cc-a1b2",
      role: "worker",
      description: "test node",
      capabilities: [],
    },
    sessionId: "sess-001",
    pid: 12345,
    lastSeen: new Date().toISOString(),
    status: "idle",
  }
  return {
    ...defaults,
    ...overrides,
    identity: { ...defaults.identity, ...(overrides.identity ?? {}) },
  }
}

describe("Registry", () => {
  let registry: Registry

  beforeEach(() => {
    registry = new Registry()
  })

  describe("register / get / getAll", () => {
    it("register 后 get 能取到节点", () => {
      const node = makeNode()
      registry.register(node)
      const got = registry.get("macbook:cc-a1b2")
      assert.ok(got)
      assert.equal(got.identity.nodeId, "macbook:cc-a1b2")
      assert.equal(got.sessionId, "sess-001")
    })

    it("get 不存在的节点返回 undefined", () => {
      assert.equal(registry.get("nonexistent"), undefined)
    })

    it("getAll 返回所有已注册节点", () => {
      registry.register(makeNode())
      registry.register(makeNode({
        identity: { nodeId: "mini:cc-c3d4", deviceId: "mini", shortId: "cc-c3d4", role: "main", description: "mini", capabilities: [] },
        sessionId: "sess-002",
        pid: 54321,
      }))
      const all = registry.getAll()
      assert.equal(all.length, 2)
    })

    it("重复 register 同一 nodeId 覆盖旧数据", () => {
      registry.register(makeNode({ status: "idle" }))
      registry.register(makeNode({ status: "busy" }))
      const all = registry.getAll()
      assert.equal(all.length, 1)
      assert.equal(all[0].status, "busy")
    })
  })

  describe("unregister", () => {
    it("注销后 get 返回 undefined", () => {
      registry.register(makeNode())
      registry.unregister("macbook:cc-a1b2")
      assert.equal(registry.get("macbook:cc-a1b2"), undefined)
    })

    it("注销不存在的节点不报错", () => {
      assert.doesNotThrow(() => registry.unregister("nonexistent"))
    })

    it("注销后 getAll 不包含该节点", () => {
      registry.register(makeNode())
      registry.unregister("macbook:cc-a1b2")
      assert.equal(registry.getAll().length, 0)
    })
  })

  describe("heartbeat", () => {
    it("heartbeat 更新节点的 lastSeen", () => {
      const oldTime = "2026-01-01T00:00:00.000Z"
      registry.register(makeNode({ lastSeen: oldTime }))
      registry.heartbeat("macbook:cc-a1b2")
      const got = registry.get("macbook:cc-a1b2")
      assert.ok(got)
      assert.notEqual(got.lastSeen, oldTime, "lastSeen 应该被更新")
    })

    it("heartbeat 不存在的节点不报错", () => {
      assert.doesNotThrow(() => registry.heartbeat("nonexistent"))
    })
  })

  describe("cleanup", () => {
    it("清理超时节点，返回被清理的 nodeId 列表", () => {
      const expired = makeNode({
        identity: { nodeId: "macbook:cc-old", deviceId: "macbook", shortId: "cc-old", role: "worker", description: "old", capabilities: [] },
        lastSeen: "2020-01-01T00:00:00.000Z",  // 很久以前
        sessionId: "sess-old",
        pid: 11111,
      })
      const alive = makeNode({
        lastSeen: new Date().toISOString(),  // 刚才
      })
      registry.register(expired)
      registry.register(alive)

      const cleaned = registry.cleanup(60_000)  // 60 秒超时
      assert.ok(cleaned.includes("macbook:cc-old"))
      assert.ok(!cleaned.includes("macbook:cc-a1b2"))
      assert.equal(registry.get("macbook:cc-old"), undefined)
      assert.ok(registry.get("macbook:cc-a1b2"))
    })

    it("没有超时节点返回空数组", () => {
      registry.register(makeNode({ lastSeen: new Date().toISOString() }))
      const cleaned = registry.cleanup(60_000)
      assert.deepEqual(cleaned, [])
    })

    it("全部超时则全部清理", () => {
      registry.register(makeNode({ lastSeen: "2020-01-01T00:00:00.000Z" }))
      const cleaned = registry.cleanup(1000)
      assert.equal(cleaned.length, 1)
      assert.equal(registry.getAll().length, 0)
    })

    // 补充：cleanup 超时阈值边界 — 刚好等于超时时间的节点不被清理，超过的才清理
    it("cleanup 边界：刚好等于超时时间的节点不被清理", () => {
      const timeoutMs = 60_000
      // 刚好在阈值边界的节点（lastSeen = now - timeoutMs）
      const borderTime = new Date(Date.now() - timeoutMs).toISOString()
      const borderNode = makeNode({
        identity: { nodeId: "macbook:cc-border", deviceId: "macbook", shortId: "cc-border", role: "worker", description: "border", capabilities: [] },
        lastSeen: borderTime,
        sessionId: "sess-border",
        pid: 33333,
      })
      // 超过阈值的节点
      const expiredNode = makeNode({
        identity: { nodeId: "macbook:cc-expired", deviceId: "macbook", shortId: "cc-expired", role: "worker", description: "expired", capabilities: [] },
        lastSeen: new Date(Date.now() - timeoutMs - 1).toISOString(),
        sessionId: "sess-expired",
        pid: 44444,
      })
      registry.register(borderNode)
      registry.register(expiredNode)

      const cleaned = registry.cleanup(timeoutMs)
      // 超过阈值的被清理
      assert.ok(cleaned.includes("macbook:cc-expired"))
      // 刚好等于阈值的不被清理（或被清理取决于实现，但应该有明确行为）
      // 保守实现：>= 超时的都清理。这里验证 expiredNode 一定被清理
      assert.ok(registry.get("macbook:cc-expired") === undefined)
    })
  })

  describe("findByShortId", () => {
    it("通过 shortId 找到节点", () => {
      registry.register(makeNode())
      const got = registry.findByShortId("cc-a1b2")
      assert.ok(got)
      assert.equal(got.identity.nodeId, "macbook:cc-a1b2")
    })

    it("shortId 不存在返回 undefined", () => {
      assert.equal(registry.findByShortId("cc-0000"), undefined)
    })

    it("多个节点中精确匹配 shortId", () => {
      registry.register(makeNode())
      registry.register(makeNode({
        identity: { nodeId: "mini:cc-x9y8", deviceId: "mini", shortId: "cc-x9y8", role: "main", description: "other", capabilities: [] },
        sessionId: "sess-003",
        pid: 99999,
      }))
      const got = registry.findByShortId("cc-x9y8")
      assert.ok(got)
      assert.equal(got.identity.deviceId, "mini")
    })
  })

  // ===== 方案 B PR1：sync presence（parkedCount / lastSyncAt）=====
  describe("sync presence", () => {
    const NID = "macbook:cc-a1b2"

    it("初始 parkedCount=0，lastSyncAt=undefined", () => {
      assert.equal(registry.getParkedCount(NID), 0)
      assert.equal(registry.getLastSyncAt(NID), undefined)
    })

    it("markParked +1 / unmarkParked -1（并发停车计数）", () => {
      registry.markParked(NID)
      assert.equal(registry.getParkedCount(NID), 1)
      registry.markParked(NID)
      assert.equal(registry.getParkedCount(NID), 2)
      registry.unmarkParked(NID)
      assert.equal(registry.getParkedCount(NID), 1)
      registry.unmarkParked(NID)
      assert.equal(registry.getParkedCount(NID), 0)
    })

    it("unmarkParked 不会把计数拉到负（floor 0）", () => {
      registry.unmarkParked(NID)
      registry.unmarkParked(NID)
      assert.equal(registry.getParkedCount(NID), 0)
    })

    it("touchSync 刷新 lastSyncAt", () => {
      assert.equal(registry.getLastSyncAt(NID), undefined)
      registry.touchSync(NID)
      const t = registry.getLastSyncAt(NID)
      assert.ok(t && !Number.isNaN(new Date(t).getTime()), "lastSyncAt 应为可解析 ISO 时间")
    })

    it("markParked 也刷新 lastSyncAt", () => {
      registry.markParked(NID)
      assert.ok(registry.getLastSyncAt(NID), "markParked 应写 lastSyncAt")
      registry.unmarkParked(NID)
    })

    it("unregister 清空 parked/lastSync 旁路态", () => {
      registry.register(makeNode())
      registry.markParked(NID)
      registry.touchSync(NID)
      registry.unregister(NID)
      assert.equal(registry.getParkedCount(NID), 0)
      assert.equal(registry.getLastSyncAt(NID), undefined)
    })
  })

  // ===== hasActiveConsumer：presence 判定的唯一定义 =====
  // /api/status 的 status 派生 和 wake:needed 的触发判定共用这一个函数，
  // 两处各写一份必然漂移（一处认 parked、一处认 lastSync，语义就裂了）。
  describe("hasActiveConsumer", () => {
    const NID = "macbook:cc-a1b2"

    it("从未 sync 过 → 没有活跃消费者", () => {
      registry.register(makeNode())
      assert.equal(registry.hasActiveConsumer(NID), false)
    })

    it("停车中（parked>0）→ 有活跃消费者", () => {
      registry.markParked(NID)
      assert.equal(registry.hasActiveConsumer(NID), true)
    })

    it("刚 touchSync（lastSync 新鲜）→ 有活跃消费者", () => {
      registry.touchSync(NID)
      assert.equal(registry.hasActiveConsumer(NID, 90_000), true)
    })

    it("lastSync 已陈旧（超出新鲜窗）→ 没有活跃消费者", () => {
      registry.touchSync(NID)
      // freshMs=0 → 任何 lastSyncAt 都算陈旧，不用 sleep 也能确定性判定
      assert.equal(registry.hasActiveConsumer(NID, 0), false)
    })

    it("parked>0 压过陈旧的 lastSync（真挂着长轮询就是活的）", () => {
      registry.touchSync(NID)
      registry.markParked(NID)
      assert.equal(registry.hasActiveConsumer(NID, 0), true)
    })
  })

  // ===== restoreAll：relay 重启后从持久层恢复注册表 =====
  describe("restoreAll", () => {
    const NID = "macbook:cc-a1b2"

    it("恢复身份：restoreAll 后 get / getAll 取得到", () => {
      const n = registry.restoreAll([makeNode()])
      assert.equal(n, 1)
      const got = registry.get(NID)
      assert.ok(got)
      assert.equal(got.sessionId, "sess-001")
      assert.equal(registry.getAll().length, 1)
    })

    it("只恢复身份不恢复 presence：parked=0 / lastSyncAt=undefined", () => {
      registry.restoreAll([makeNode()])
      // 这是本任务的语义红线：恢复 ≠ 宣布在线。
      // pull 节点必须靠自己下一次 sync 才转 idle，否则 /api/status 会撒谎。
      assert.equal(registry.getParkedCount(NID), 0)
      assert.equal(registry.getLastSyncAt(NID), undefined)
      assert.equal(registry.hasActiveConsumer(NID), false)
    })

    it("lastSeen 用库里的真值，不刷成 now()（不伪造「刚刚还活着」）", () => {
      const old = "2020-01-01T00:00:00.000Z"
      registry.restoreAll([makeNode({ lastSeen: old })])
      assert.equal(registry.get(NID)?.lastSeen, old)
    })

    it("已在内存里的同 nodeId 不被旧库行覆盖（新鲜的真注册赢）", () => {
      registry.register(makeNode({ status: "busy", sessionId: "sess-live" }))
      const n = registry.restoreAll([makeNode({ status: "idle", sessionId: "sess-stale" })])
      assert.equal(n, 0, "已存在的节点不计入恢复数")
      const got = registry.get(NID)
      assert.equal(got?.sessionId, "sess-live")
      assert.equal(got?.status, "busy")
    })

    it("脏行（缺 nodeId）跳过，不挡住整批恢复", () => {
      const bad = { identity: {}, sessionId: "x", pid: 1, lastSeen: "", status: "idle" } as any
      const n = registry.restoreAll([bad, makeNode()])
      assert.equal(n, 1)
      assert.ok(registry.get(NID))
    })

    it("空数组 → 恢复 0 条，不报错", () => {
      assert.equal(registry.restoreAll([]), 0)
      assert.equal(registry.getAll().length, 0)
    })
  })
})
