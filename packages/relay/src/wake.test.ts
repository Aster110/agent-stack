/**
 * WakeHook 测试 — 温唤醒接缝（任务2，只做接缝不做完整唤醒器）
 *
 * 语义：投递给 pull 节点时若该节点没有活跃消费者（没人挂长轮询），则
 *   ① 往事件总线发 wake:needed（含 nodeId / parkedCount）——SSE 订阅者能看到
 *   ② 若 env MESH_WAKE_HOOK 设了，exec 它并追加 nodeId 参数，fire-and-forget
 * 同一节点 60 秒去抖；env 缺省不设 = 只发事件不 exec（零风险）。
 */
import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import {
  WakeHook,
  WAKE_DEBOUNCE_MS,
  WAKE_GLOBAL_WINDOW_MS,
  WAKE_GLOBAL_HOURLY_MAX,
  type WakeAuditEntry,
} from "./wake.js"
import { MeshEventBus } from "./events.js"

type WakeEvent = { nodeId: string; parkedCount: number }

/** 收集 wake:needed 事件的探针 */
function busWithProbe(): { bus: MeshEventBus; seen: WakeEvent[] } {
  const bus = new MeshEventBus()
  const seen: WakeEvent[] = []
  bus.on("wake:needed", (d) => seen.push(d))
  return { bus, seen }
}

/** 假时钟：手动推进，去抖测试不靠 sleep */
function fakeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

describe("WakeHook", () => {
  describe("事件广播", () => {
    it("notify → 发一条 wake:needed，带 nodeId 与 parkedCount", () => {
      const { bus, seen } = busWithProbe()
      const wake = new WakeHook({ events: bus })
      const fired = wake.notify("macbook:cc-gui", 0)
      assert.equal(fired, true)
      assert.equal(seen.length, 1)
      assert.deepEqual(seen[0], { nodeId: "macbook:cc-gui", parkedCount: 0 })
    })

    it("没有事件总线也不报错（events 可选）", () => {
      const wake = new WakeHook({})
      assert.doesNotThrow(() => wake.notify("macbook:cc-gui", 0))
    })
  })

  describe("60 秒去抖（同一节点重复投递不重复触发）", () => {
    let clock: ReturnType<typeof fakeClock>
    let bus: MeshEventBus
    let seen: WakeEvent[]
    let runs: string[][]
    let wake: WakeHook

    beforeEach(() => {
      clock = fakeClock()
      const p = busWithProbe()
      bus = p.bus
      seen = p.seen
      runs = []
      wake = new WakeHook({
        events: bus,
        hookCommand: "/bin/echo",
        now: clock.now,
        run: (bin, args) => { runs.push([bin, ...args]) },
      })
    })

    it("窗口内第二次 notify 被吞（事件和 exec 都不再发）", () => {
      assert.equal(wake.notify("n1", 0), true)
      assert.equal(wake.notify("n1", 0), false)
      clock.advance(WAKE_DEBOUNCE_MS - 1)
      assert.equal(wake.notify("n1", 0), false)
      assert.equal(seen.length, 1, "去抖必须同时压住事件")
      assert.equal(runs.length, 1, "去抖必须同时压住 exec")
    })

    it("过了去抖窗口可以再次触发", () => {
      assert.equal(wake.notify("n1", 0), true)
      clock.advance(WAKE_DEBOUNCE_MS)
      assert.equal(wake.notify("n1", 0), true)
      assert.equal(seen.length, 2)
      assert.equal(runs.length, 2)
    })

    it("去抖是 per-node，不同节点互不影响", () => {
      assert.equal(wake.notify("n1", 0), true)
      assert.equal(wake.notify("n2", 0), true)
      assert.equal(wake.notify("n1", 0), false)
      assert.equal(seen.length, 2)
      assert.deepEqual(seen.map((e) => e.nodeId), ["n1", "n2"])
    })

    it("默认去抖窗就是 60 秒", () => {
      assert.equal(WAKE_DEBOUNCE_MS, 60_000)
    })
  })

  describe("总开关：默认关闭（aster 要求先过目再启用）", () => {
    it("enabled:false → 既不广播事件也不 exec，notify 返回 false", () => {
      const { bus, seen } = busWithProbe()
      const runs: string[][] = []
      const wake = new WakeHook({
        enabled: false, events: bus, hookCommand: "/bin/echo",
        run: (b, a) => runs.push([b, ...a]),
      })
      assert.equal(wake.notify("n1", 0), false)
      assert.equal(seen.length, 0, "关着就一条事件都不许发")
      assert.equal(runs.length, 0, "关着就一个进程都不许起")
      assert.equal(wake.isEnabled, false)
    })

    it("关着时连去抖时间戳都不记（开启后第一次仍能正常触发）", () => {
      const clock = fakeClock()
      const { bus, seen } = busWithProbe()
      const off = new WakeHook({ enabled: false, events: bus, now: clock.now })
      off.notify("n1", 0)
      const on = new WakeHook({ enabled: true, events: bus, now: clock.now })
      assert.equal(on.notify("n1", 0), true)
      assert.equal(seen.length, 1)
    })
  })

  describe("MESH_WAKE_HOOK exec", () => {
    it("env 缺省不设 → 只发事件，绝不 exec（零风险）", () => {
      const { bus, seen } = busWithProbe()
      const runs: string[][] = []
      const wake = new WakeHook({ events: bus, run: (b, a) => runs.push([b, ...a]) })
      assert.equal(wake.notify("macbook:cc-gui", 0), true)
      assert.equal(seen.length, 1, "事件照发")
      assert.equal(runs.length, 0, "没配 hook 就一个进程都不许起")
    })

    it("设了 hook → 以 nodeId 作追加参数调用", () => {
      const runs: string[][] = []
      const wake = new WakeHook({ hookCommand: "/usr/local/bin/wake.sh", run: (b, a) => runs.push([b, ...a]) })
      wake.notify("macbook:cc-gui", 0)
      assert.deepEqual(runs, [["/usr/local/bin/wake.sh", "macbook:cc-gui"]])
    })

    it("hook 带固定参数 → 按空白拆分，nodeId 永远追加在最后", () => {
      const runs: string[][] = []
      const wake = new WakeHook({ hookCommand: "  /usr/bin/osascript  /path/wake.scpt  ", run: (b, a) => runs.push([b, ...a]) })
      wake.notify("macbook:cc-gui", 0)
      // 不走 shell：拆好的 argv 直接 execFile，nodeId 是数据不是命令
      assert.deepEqual(runs, [["/usr/bin/osascript", "/path/wake.scpt", "macbook:cc-gui"]])
    })

    it("hookCommand 是空白串 → 视同没配，不 exec", () => {
      const runs: string[][] = []
      const wake = new WakeHook({ hookCommand: "   ", run: (b, a) => runs.push([b, ...a]) })
      assert.equal(wake.notify("n1", 0), true)
      assert.equal(runs.length, 0)
    })

    it("hook 抛异常只记日志，不冒泡（fire-and-forget 不许拖垮投递）", () => {
      const logs: string[] = []
      const wake = new WakeHook({
        hookCommand: "/bin/false",
        run: () => { throw new Error("spawn ENOENT") },
        log: (m) => logs.push(m),
      })
      let fired: boolean | undefined
      assert.doesNotThrow(() => { fired = wake.notify("macbook:cc-gui", 0) })
      assert.equal(fired, true, "hook 失败不改变「已触发」的判定")
      assert.equal(logs.length, 1)
      assert.match(logs[0]!, /macbook:cc-gui/)
    })

    it("nodeId 里的 shell 元字符原样当参数传，不被解释（无注入面）", () => {
      // nodeId 的 shortId 段来自 POST /api/register 的请求体，是可控输入。
      // 走 shell 就是命令注入洞，所以这里断言它永远只是 argv 的一个元素。
      const runs: string[][] = []
      const wake = new WakeHook({ hookCommand: "/bin/echo", run: (b, a) => runs.push([b, ...a]) })
      const evil = 'macbook:cc-a"; rm -rf /; #'
      wake.notify(evil, 0)
      assert.deepEqual(runs, [["/bin/echo", evil]])
    })

    it("wake_id 走 env 不走 argv（保住「nodeId 永远是最后一个参数」这条契约）", () => {
      // hook 要把因果链串起来就得知道 wake_id，但塞进 argv 会动摇上面那条不变量。
      // env 是纯数据通道：值是我们自己生成的 uuid，没有外部可控字节。
      const calls: Array<{ bin: string; args: string[]; env?: Record<string, string> }> = []
      const wake = new WakeHook({
        hookCommand: "/usr/local/bin/wake-hook.sh",
        run: (bin, args, o) => calls.push({ bin, args, env: o?.env }),
      })
      wake.notify("macbook:cc-gui", 0)
      assert.deepEqual(calls[0]!.args, ["macbook:cc-gui"], "nodeId 仍是唯一且最后一个 argv")
      assert.match(calls[0]!.env!.MESH_WAKE_ID!, /^[0-9a-f-]{36}$/, "wake_id 以 uuid 形态走 env")
    })
  })

  // =========================================================================
  // 全局限速（防唤醒风暴第三道闸，brain 必须项）
  //
  // 去抖只管单节点。100 个冷节点同时来信 → 100 次真触发 → 100 个 hook 进程 +
  // 100 次 poke，每个 poke 都产生模型 turn。滚动 1h 窗口的总量闸是最后一道保险。
  // =========================================================================
  describe("全局限速", () => {
    function capRig(max: number) {
      const clock = fakeClock()
      const { bus, seen } = busWithProbe()
      const runs: string[][] = []
      const audits: WakeAuditEntry[] = []
      const wake = new WakeHook({
        events: bus,
        hookCommand: "/bin/echo",
        now: clock.now,
        run: (b, a) => runs.push([b, ...a]),
        audit: (e) => audits.push(e),
        globalHourlyMax: max,
      })
      return { clock, wake, seen, runs, audits }
    }

    it("1h 内第 13 次触发被压制：不发事件、不起进程（P7）", () => {
      const r = capRig(WAKE_GLOBAL_HOURLY_MAX)
      for (let i = 0; i < WAKE_GLOBAL_HOURLY_MAX; i++) {
        assert.equal(r.wake.notify(`n${i}`, 0), true, `第 ${i + 1} 次该正常触发`)
      }
      assert.equal(r.wake.notify("n-overflow", 0), false, "第 13 次必须被压制")
      assert.equal(r.seen.length, WAKE_GLOBAL_HOURLY_MAX, "压制必须同时压住事件")
      assert.equal(r.runs.length, WAKE_GLOBAL_HOURLY_MAX, "压制必须同时压住 exec")
    })

    it("被压制时写一条 suppressed_global_cap 审计行（G4：不许无声吞掉）", () => {
      const r = capRig(2)
      r.wake.notify("a", 0)
      r.wake.notify("b", 0)
      r.wake.notify("c", 0)
      assert.deepEqual(r.audits.map((e) => e.decision), ["fired", "fired", "suppressed_global_cap"])
      assert.equal(r.audits[2]!.nodeId, "c")
      assert.match(r.audits[2]!.wakeId, /^[0-9a-f-]{36}$/)
    })

    it("滚动窗：1h 前的旧触发不占额度", () => {
      const r = capRig(2)
      r.wake.notify("a", 0)
      r.wake.notify("b", 0)
      assert.equal(r.wake.notify("c", 0), false)
      r.clock.advance(WAKE_GLOBAL_WINDOW_MS)
      assert.equal(r.wake.notify("c", 0), true, "旧的两次已滚出窗口，额度该释放")
    })

    it("压制不写去抖时间戳：额度一释放，同一节点立刻能响", () => {
      const r = capRig(1)
      r.wake.notify("a", 0)
      assert.equal(r.wake.notify("b", 0), false, "被全局闸压住")
      r.clock.advance(WAKE_GLOBAL_WINDOW_MS)
      assert.equal(r.wake.notify("b", 0), true, "压制是全局的，不该把 b 单独关小黑屋")
    })

    it("去抖先于限速：被去抖吞掉的那次不消耗全局额度", () => {
      const r = capRig(2)
      r.wake.notify("a", 0)
      r.wake.notify("a", 0) // 去抖吞掉，不该记账
      assert.equal(r.wake.notify("b", 0), true, "额度只该被真触发消耗")
      assert.equal(r.wake.notify("c", 0), false)
    })

    it("缺省额度 12 次/小时", () => {
      assert.equal(WAKE_GLOBAL_HOURLY_MAX, 12)
      assert.equal(WAKE_GLOBAL_WINDOW_MS, 3_600_000)
    })

    it("globalHourlyMax<=0 → 不限速（逃生阀）", () => {
      const r = capRig(0)
      for (let i = 0; i < 50; i++) assert.equal(r.wake.notify(`n${i}`, 0), true)
    })
  })

  // =========================================================================
  // 审计流水（G4：wake 结果原本只有一行 console.warn，出事查无对证）
  // =========================================================================
  describe("审计注入点", () => {
    it("每次真触发写一条 fired 审计行，带 wake_id / 来源 / 是否起了 hook", () => {
      const audits: WakeAuditEntry[] = []
      const wake = new WakeHook({ hookCommand: "/bin/echo", run: () => {}, audit: (e) => audits.push(e) })
      wake.notify("macbook:cc-gui", 0, { source: "downlink" })
      assert.equal(audits.length, 1)
      assert.equal(audits[0]!.decision, "fired")
      assert.equal(audits[0]!.nodeId, "macbook:cc-gui")
      assert.equal(audits[0]!.source, "downlink")
      assert.equal(audits[0]!.hook, true)
      assert.match(audits[0]!.wakeId, /^[0-9a-f-]{36}$/)
    })

    it("sweeper 来源可带 backlog / attempt（补铃那条流水要看得出为什么补）", () => {
      const audits: WakeAuditEntry[] = []
      const wake = new WakeHook({ audit: (e) => audits.push(e) })
      wake.notify("n1", 0, { source: "sweep", backlog: 7, attempt: 3 })
      assert.equal(audits[0]!.source, "sweep")
      assert.equal(audits[0]!.backlog, 7)
      assert.equal(audits[0]!.attempt, 3)
    })

    it("缺省 source=send（本机 send 路径是最常见来源）", () => {
      const audits: WakeAuditEntry[] = []
      const wake = new WakeHook({ audit: (e) => audits.push(e) })
      wake.notify("n1", 0)
      assert.equal(audits[0]!.source, "send")
    })

    it("被去抖吞掉不写审计（噪音：一分钟内十条消息不该刷十行流水）", () => {
      const clock = fakeClock()
      const audits: WakeAuditEntry[] = []
      const wake = new WakeHook({ now: clock.now, audit: (e) => audits.push(e) })
      wake.notify("n1", 0)
      wake.notify("n1", 0)
      wake.notify("n1", 0)
      assert.equal(audits.length, 1)
    })

    it("总开关关着 → 一行审计都不写（零行为零回归）", () => {
      const audits: WakeAuditEntry[] = []
      const wake = new WakeHook({ enabled: false, audit: (e) => audits.push(e) })
      wake.notify("n1", 0)
      assert.equal(audits.length, 0)
    })

    it("审计回调抛异常不冒泡（记账炸了不许拖垮投递）", () => {
      const logs: string[] = []
      const wake = new WakeHook({ audit: () => { throw new Error("db locked") }, log: (m) => logs.push(m) })
      let fired: boolean | undefined
      assert.doesNotThrow(() => { fired = wake.notify("n1", 0) })
      assert.equal(fired, true, "审计失败不改变「已触发」的判定")
      assert.equal(logs.length, 1)
      assert.match(logs[0]!, /db locked/)
    })
  })
})
