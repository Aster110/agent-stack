/**
 * Router 测试 — 消息路由器
 *
 * 职责：根据消息目标决定路由策略
 * - 本地投递：to 的 deviceId 等于本机 → local
 * - 广播：to = "*" → broadcast 给所有节点（排除 from）
 * - 远端：to 的 deviceId 不等于本机 → uplink（Phase 2.0+）
 * - 目标不存在 → not_found
 *
 * TDD：Router 尚未实现
 */
import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { Router } from "./router.js"
import { Registry } from "./registry.js"
import type { MeshMessage, LocalNode, RouteResult } from "@cc-mesh/protocol"

function makeNode(nodeId: string, deviceId: string, shortId: string): LocalNode {
  return {
    identity: {
      nodeId,
      deviceId,
      shortId,
      role: "worker",
      description: "test",
      capabilities: [],
    },
    sessionId: `sess-${shortId}`,
    pid: Math.floor(Math.random() * 99999),
    lastSeen: new Date().toISOString(),
    status: "idle",
  }
}

function makeMsg(from: string, to: string): MeshMessage {
  return {
    id: `msg-${Date.now()}-${from}-${Math.random().toString(36).slice(2, 6)}`,
    from,
    to,
    type: "chat",
    payload: "test message",
    createdAt: new Date().toISOString(),
  }
}

describe("Router", () => {
  let registry: Registry
  let router: Router
  const localDeviceId = "macbook"

  beforeEach(() => {
    registry = new Registry()
    router = new Router(registry, localDeviceId)
  })

  describe("本地投递", () => {
    it("to 的 deviceId 等于本机 → action: local + target 节点", () => {
      const target = makeNode("macbook:cc-c3d4", "macbook", "cc-c3d4")
      registry.register(target)

      const msg = makeMsg("macbook:cc-a1b2", "macbook:cc-c3d4")
      const result: RouteResult = router.route(msg)

      assert.equal(result.action, "local")
      assert.ok("target" in result && result.target)
      if (result.action === "local") {
        assert.equal(result.target.identity.nodeId, "macbook:cc-c3d4")
      }
    })

    it("shortId 不带 deviceId 前缀 → not_found（必须完整 nodeId）", () => {
      const target = makeNode("macbook:cc-c3d4", "macbook", "cc-c3d4")
      registry.register(target)

      const msg = makeMsg("macbook:cc-a1b2", "cc-c3d4")
      const result: RouteResult = router.route(msg)
      // shortId 解析后 deviceId 是 "local" 而非 "macbook"，不匹配本机 → not_found
      assert.equal(result.action, "not_found")
    })

    // 补充：消息发给自己（from === to）应正常 local 投递
    it("消息发给自己（from === to）应正常 local 投递", () => {
      const self = makeNode("macbook:cc-a1b2", "macbook", "cc-a1b2")
      registry.register(self)

      const msg = makeMsg("macbook:cc-a1b2", "macbook:cc-a1b2")
      const result: RouteResult = router.route(msg)

      assert.equal(result.action, "local")
      if (result.action === "local") {
        assert.equal(result.target.identity.nodeId, "macbook:cc-a1b2")
      }
    })
  })

  describe("广播", () => {
    it("to='*' → broadcast 给所有节点（排除 from）", () => {
      const node1 = makeNode("macbook:cc-a1b2", "macbook", "cc-a1b2")
      const node2 = makeNode("macbook:cc-c3d4", "macbook", "cc-c3d4")
      const node3 = makeNode("macbook:cc-e5f6", "macbook", "cc-e5f6")
      registry.register(node1)
      registry.register(node2)
      registry.register(node3)

      const msg = makeMsg("macbook:cc-a1b2", "*")
      const result: RouteResult = router.route(msg)

      assert.equal(result.action, "broadcast")
      if (result.action === "broadcast") {
        const targetIds = result.targets.map(t => t.identity.nodeId)
        assert.ok(!targetIds.includes("macbook:cc-a1b2"), "广播不包含发送方")
        assert.ok(targetIds.includes("macbook:cc-c3d4"))
        assert.ok(targetIds.includes("macbook:cc-e5f6"))
        assert.equal(result.targets.length, 2)
      }
    })

    it("广播时只有自己在线 → broadcast targets 为空数组", () => {
      const node1 = makeNode("macbook:cc-a1b2", "macbook", "cc-a1b2")
      registry.register(node1)

      const msg = makeMsg("macbook:cc-a1b2", "*")
      const result: RouteResult = router.route(msg)

      assert.equal(result.action, "broadcast")
      if (result.action === "broadcast") {
        assert.equal(result.targets.length, 0)
      }
    })

    // 补充：广播时 registry 空 → 返回空 targets
    it("广播时 registry 空 → broadcast targets 为空数组", () => {
      const msg = makeMsg("macbook:cc-a1b2", "*")
      const result: RouteResult = router.route(msg)

      assert.equal(result.action, "broadcast")
      if (result.action === "broadcast") {
        assert.equal(result.targets.length, 0)
      }
    })
  })

  describe("远端 uplink 路由", () => {
    it("to 的 deviceId 不等于本机 → action:uplink", () => {
      const msg = makeMsg("macbook:cc-a1b2", "mini:cc-x9y8")
      const result: RouteResult = router.route(msg)

      assert.equal(result.action, "uplink")
    })

    it("远端路由即便对端节点未在本地注册表也返回 uplink（由远端 relay 负责解析）", () => {
      const msg = makeMsg("macbook:cc-a1b2", "cloud-us:cc-nobody")
      const result: RouteResult = router.route(msg)

      assert.equal(result.action, "uplink")
    })
  })

  describe("不存在 / 空目标", () => {
    it("本地 deviceId 匹配但节点不在注册表 → not_found", () => {
      const msg = makeMsg("macbook:cc-a1b2", "macbook:cc-ghost")
      const result: RouteResult = router.route(msg)

      assert.equal(result.action, "not_found")
    })

    // 补充：to 为空字符串 → not_found
    it("to 为空字符串 → not_found", () => {
      const msg = makeMsg("macbook:cc-a1b2", "")
      const result: RouteResult = router.route(msg)

      assert.equal(result.action, "not_found")
    })
  })
})
