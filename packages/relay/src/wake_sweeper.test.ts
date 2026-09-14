/**
 * WakeSweeper 测试 — 水平触发补铃（缺口 G2）
 *
 * 病：现有 wake 是**纯边沿触发**——只在消息落地那一瞬判一次。以下情形铃声永久丢失：
 *   ① hook exec 失败/超时（只 console.warn 一行）
 *   ② 消息落在门铃死亡后的 90s presence 新鲜窗内（hasActiveConsumer 的 freshness 腿
 *      仍判"有人"→ 不响铃；此后再无新消息就永远停驻）
 *   ③ porter 的 SSE 恰好断线重连中（wake:needed 无重放，错过即丢）
 *
 * 药：relay 内定时对账循环，把 SSE 的 at-most-once 提升为系统级 at-least-once。
 * 判据只看**库里的事实**（直发 backlog > 0）与 presence，跟"有没有收到过事件"无关，
 * 所以上面三种丢铃都会在最多一个 sweep 周期后被补上。
 *
 * 零模型 turn：全程 SQLite 查询 + 内存判定，一个模型 API 都不碰。
 */
import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import {
  WakeSweeper,
  WAKE_SWEEP_INTERVAL_MS,
  WAKE_SWEEP_BASE_COOLDOWN_MS,
  WAKE_SWEEP_MAX_COOLDOWN_MS,
  type SweepableRegistry,
  type SweepableStore,
} from "./wake_sweeper.js"
import { WakeHook } from "./wake.js"
import { MeshEventBus } from "./events.js"
import type { LocalNode } from "@cc-mesh/protocol"

// ===== 假件 =====

function pullNode(shortId: string): LocalNode {
  return {
    identity: {
      nodeId: `macbook:${shortId}`,
      deviceId: "macbook",
      shortId,
      role: "worker",
      description: "",
      capabilities: [],
      deliveryMode: "pull",
    },
    sessionId: `nopane-macbook:${shortId}`,
    pid: 1,
    lastSeen: new Date().toISOString(),
    status: "idle",
  }
}

function injectNode(shortId: string): LocalNode {
  return {
    identity: {
      nodeId: `macbook:${shortId}`,
      deviceId: "macbook",
      shortId,
      role: "worker",
      description: "",
      capabilities: [],
      // 无 deliveryMode → 缺省 inject
    },
    sessionId: `sess-${shortId}`,
    pid: 1,
    lastSeen: new Date().toISOString(),
    status: "idle",
  }
}

class FakeRegistry implements SweepableRegistry {
  nodes: LocalNode[] = []
  active = new Set<string>()
  parked = new Map<string, number>()
  getAll(): LocalNode[] { return this.nodes }
  hasActiveConsumer(nodeId: string): boolean { return this.active.has(nodeId) }
  getParkedCount(nodeId: string): number { return this.parked.get(nodeId) ?? 0 }
}

class FakeStore implements SweepableStore {
  backlog = new Map<string, number>()
  cursor = new Map<string, number>()
  /** 记下被问过的 (nodeId, sinceSeq)，用来断言 sweeper 是按游标问的 */
  calls: Array<{ nodeId: string; sinceSeq: number }> = []
  getAckCursor(nodeId: string): number { return this.cursor.get(nodeId) ?? 0 }
  countDirectBacklog(nodeId: string, sinceSeq: number): number {
    this.calls.push({ nodeId, sinceSeq })
    return this.backlog.get(nodeId) ?? 0
  }
}

function fakeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

interface Rig {
  registry: FakeRegistry
  store: FakeStore
  wake: WakeHook
  sweeper: WakeSweeper
  clock: ReturnType<typeof fakeClock>
  fired: Array<{ nodeId: string; parkedCount: number }>
}

function rig(opts: { enabled?: boolean } = {}): Rig {
  const clock = fakeClock()
  const registry = new FakeRegistry()
  const store = new FakeStore()
  const bus = new MeshEventBus()
  const fired: Array<{ nodeId: string; parkedCount: number }> = []
  bus.on("wake:needed", (d) => fired.push(d))
  const wake = new WakeHook({
    enabled: opts.enabled !== false,
    events: bus,
    now: clock.now,
    // 去抖窗设 0：本文件测的是 sweeper 自己的退避，别让 WakeHook 的 60s 去抖抢戏
    // （两者叠加的组合行为另有一条专门用例）
    debounceMs: 0,
  })
  const sweeper = new WakeSweeper({ registry, store, wake, now: clock.now })
  return { registry, store, wake, sweeper, clock, fired }
}

describe("WakeSweeper — 水平触发补铃（G2）", () => {
  describe("基本对账", () => {
    let r: Rig
    beforeEach(() => { r = rig() })

    it("backlog>0 且无活跃消费者 → 补铃（P5）", () => {
      r.registry.nodes = [pullNode("cc-cold")]
      r.store.backlog.set("macbook:cc-cold", 3)
      const rep = r.sweeper.sweepOnce()
      assert.deepEqual(rep.rang, ["macbook:cc-cold"])
      assert.equal(r.fired.length, 1)
      assert.equal(r.fired[0]!.nodeId, "macbook:cc-cold")
    })

    it("backlog=0 → 不补铃（没积压就没铃可补）", () => {
      r.registry.nodes = [pullNode("cc-empty")]
      r.store.backlog.set("macbook:cc-empty", 0)
      assert.deepEqual(r.sweeper.sweepOnce().rang, [])
      assert.equal(r.fired.length, 0)
    })

    it("有活跃消费者 → 不补铃（门铃活着，别瞎摇人）", () => {
      r.registry.nodes = [pullNode("cc-live")]
      r.store.backlog.set("macbook:cc-live", 5)
      r.registry.active.add("macbook:cc-live")
      assert.deepEqual(r.sweeper.sweepOnce().rang, [])
      assert.equal(r.fired.length, 0)
    })

    it("只扫 pull 形态：inject 节点有积压也不补铃（N1/N2 的 sweeper 版）", () => {
      r.registry.nodes = [injectNode("cc-pane")]
      r.store.backlog.set("macbook:cc-pane", 9)
      assert.deepEqual(r.sweeper.sweepOnce().rang, [])
      assert.equal(r.fired.length, 0)
      assert.equal(r.store.calls.length, 0, "inject 节点连 backlog 都不该去查（白花 SQL）")
    })

    it("backlog 按 ack 游标起算（不是从 0 数全部历史）", () => {
      r.registry.nodes = [pullNode("cc-cursor")]
      r.store.cursor.set("macbook:cc-cursor", 42)
      r.store.backlog.set("macbook:cc-cursor", 1)
      r.sweeper.sweepOnce()
      assert.deepEqual(r.store.calls, [{ nodeId: "macbook:cc-cursor", sinceSeq: 42 }])
    })

    it("多节点一轮扫完：冷的响、热的不响", () => {
      r.registry.nodes = [pullNode("a"), pullNode("b"), pullNode("c")]
      r.store.backlog.set("macbook:a", 1)
      r.store.backlog.set("macbook:b", 1)
      r.store.backlog.set("macbook:c", 0)
      r.registry.active.add("macbook:b")
      assert.deepEqual(r.sweeper.sweepOnce().rang, ["macbook:a"])
    })

    it("parkedCount 如实上报给 wake（排障时看清是不是误判）", () => {
      r.registry.nodes = [pullNode("cc-p")]
      r.store.backlog.set("macbook:cc-p", 1)
      r.registry.parked.set("macbook:cc-p", 0)
      r.sweeper.sweepOnce()
      assert.equal(r.fired[0]!.parkedCount, 0)
    })
  })

  describe("指数退避（防唤醒风暴第二道闸）", () => {
    let r: Rig
    beforeEach(() => {
      r = rig()
      r.registry.nodes = [pullNode("cc-stuck")]
      r.store.backlog.set("macbook:cc-stuck", 2)
    })

    it("第 2/3 次补铃间隔 = 240s / 480s（P6，假时钟）", () => {
      // 第 1 次：无 lastAttempt → 立即响
      assert.deepEqual(r.sweeper.sweepOnce().rang, ["macbook:cc-stuck"])

      // 冷却 = 240s：239s 时还不许响
      r.clock.advance(239_000)
      assert.deepEqual(r.sweeper.sweepOnce().rang, [], "239s 未到 240s 冷却，不许响")
      r.clock.advance(1_000)
      assert.deepEqual(r.sweeper.sweepOnce().rang, ["macbook:cc-stuck"], "第 2 次补铃 @ +240s")

      // 冷却翻倍 = 480s
      r.clock.advance(479_000)
      assert.deepEqual(r.sweeper.sweepOnce().rang, [], "479s 未到 480s 冷却")
      r.clock.advance(1_000)
      assert.deepEqual(r.sweeper.sweepOnce().rang, ["macbook:cc-stuck"], "第 3 次补铃 @ +480s")

      assert.equal(r.fired.length, 3)
    })

    it("退避封顶 1800s（不会无限翻倍成天级哑火）", () => {
      let elapsed = 0
      const ring = (): void => {
        // 一直推进到响为止，记录这次等了多久
        for (let i = 0; i < 100; i++) {
          if (r.sweeper.sweepOnce().rang.length > 0) return
          r.clock.advance(60_000)
          elapsed += 60_000
        }
        assert.fail("补铃从未发生")
      }
      ring() // #1 立即
      const gaps: number[] = []
      for (let k = 0; k < 8; k++) {
        elapsed = 0
        ring()
        gaps.push(elapsed)
      }
      assert.ok(gaps.every((g) => g <= WAKE_SWEEP_MAX_COOLDOWN_MS), `间隔不得超过封顶: ${gaps.join(",")}`)
      assert.equal(gaps[gaps.length - 1], WAKE_SWEEP_MAX_COOLDOWN_MS, "最终稳定在封顶值")
    })

    it("backlog 排空 → 冷却复位（下次积压立刻响，不背着旧退避）", () => {
      r.sweeper.sweepOnce() // #1 响，冷却 240s
      r.store.backlog.set("macbook:cc-stuck", 0)
      r.clock.advance(1_000)
      r.sweeper.sweepOnce() // 排空 → 复位
      // 新积压来了：不用再等 240s
      r.store.backlog.set("macbook:cc-stuck", 1)
      r.clock.advance(1_000)
      assert.deepEqual(r.sweeper.sweepOnce().rang, ["macbook:cc-stuck"], "排空后应复位为立即可响")
    })

    it("消费者恢复 → 冷却复位（门铃回来了就当这一页翻过去）", () => {
      r.sweeper.sweepOnce() // #1 响
      r.registry.active.add("macbook:cc-stuck")
      r.clock.advance(1_000)
      r.sweeper.sweepOnce() // 有消费者 → 复位
      r.registry.active.delete("macbook:cc-stuck")
      r.clock.advance(1_000)
      assert.deepEqual(r.sweeper.sweepOnce().rang, ["macbook:cc-stuck"], "消费者恢复过一次就该复位")
    })

    it("节点消失 → 不再攒它的退避账（内存不许无限长）", () => {
      r.sweeper.sweepOnce()
      assert.equal(r.sweeper.trackedCount, 1)
      r.registry.nodes = []
      r.sweeper.sweepOnce()
      assert.equal(r.sweeper.trackedCount, 0, "注册表里没有的节点必须从退避账里清掉")
    })
  })

  describe("与 WakeHook 的组合（sweeper 不绕过任何既有闸门）", () => {
    it("补铃仍走 wake.notify → 60s 去抖照样生效", () => {
      const clock = fakeClock()
      const registry = new FakeRegistry()
      const store = new FakeStore()
      const bus = new MeshEventBus()
      const fired: unknown[] = []
      bus.on("wake:needed", (d) => fired.push(d))
      // 真去抖窗（60s），sweeper 冷却设 0 让它每轮都想响
      const wake = new WakeHook({ enabled: true, events: bus, now: clock.now })
      const sweeper = new WakeSweeper({ registry, store, wake, now: clock.now, baseCooldownMs: 0, maxCooldownMs: 0 })
      registry.nodes = [pullNode("cc-d")]
      store.backlog.set("macbook:cc-d", 1)

      sweeper.sweepOnce()
      clock.advance(1_000)
      sweeper.sweepOnce()
      clock.advance(1_000)
      sweeper.sweepOnce()
      assert.equal(fired.length, 1, "WakeHook 的去抖必须压住 sweeper 的连续补铃")
    })

    it("wake 总开关关着 → sweeper 一条铃都摇不响（零行为零回归）", () => {
      const r = rig({ enabled: false })
      r.registry.nodes = [pullNode("cc-off")]
      r.store.backlog.set("macbook:cc-off", 5)
      const rep = r.sweeper.sweepOnce()
      assert.deepEqual(rep.rang, [], "notify 返回 false 就不算响")
      assert.equal(r.fired.length, 0)
    })
  })

  describe("生命周期与逃生阀", () => {
    it("wake 关着 → start() 拒绝启动（不留空转定时器）", () => {
      const r = rig({ enabled: false })
      assert.equal(r.sweeper.start(), false)
      assert.equal(r.sweeper.isRunning, false)
    })

    it("MESH_WAKE_SWEEP=0 → start() 拒绝启动（逃生阀）", () => {
      const r = rig()
      const prev = process.env.MESH_WAKE_SWEEP
      process.env.MESH_WAKE_SWEEP = "0"
      try {
        assert.equal(r.sweeper.start(), false)
        assert.equal(r.sweeper.isRunning, false)
      } finally {
        if (prev === undefined) delete process.env.MESH_WAKE_SWEEP
        else process.env.MESH_WAKE_SWEEP = prev
      }
    })

    it("wake 开着 → start() 起定时器，stop() 收干净且可重复调用", () => {
      const r = rig()
      assert.equal(r.sweeper.start(), true)
      assert.equal(r.sweeper.isRunning, true)
      assert.equal(r.sweeper.start(), false, "重复 start 不许起第二个定时器")
      r.sweeper.stop()
      assert.equal(r.sweeper.isRunning, false)
      assert.doesNotThrow(() => r.sweeper.stop())
    })

    it("一轮扫描抛错不许打死定时器（下一轮照跑）", () => {
      const r = rig()
      r.registry.nodes = [pullNode("cc-boom")]
      const logs: string[] = []
      const boom = new WakeSweeper({
        registry: r.registry,
        store: {
          getAckCursor: () => 0,
          countDirectBacklog: () => { throw new Error("db locked") },
        },
        wake: r.wake,
        now: r.clock.now,
        log: (m) => logs.push(m),
      })
      assert.doesNotThrow(() => boom.sweepOnce())
      assert.equal(logs.length, 1)
      assert.match(logs[0]!, /db locked/)
    })

    it("缺省常量：2min 一轮、120s 起步冷却、1800s 封顶", () => {
      assert.equal(WAKE_SWEEP_INTERVAL_MS, 120_000)
      assert.equal(WAKE_SWEEP_BASE_COOLDOWN_MS, 120_000)
      assert.equal(WAKE_SWEEP_MAX_COOLDOWN_MS, 1_800_000)
    })
  })
})
