/**
 * RealAppServerClient 打真子进程（脚本化假 app-server），验的是进程与协议这两件真事：
 *   - 进程组：wrapper(sh) → node(假 app-server) → sleep(孙子)，stop() 之后一个都不许剩
 *   - 协议：initialize 握手、config 原样透传、每轮 bypass、turn 生命周期、连接丢失
 *
 * 每个用例都打印用时与事件计数（LANES §2.7：禁止空转报绿）。
 */
import { after, describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { APP_SERVER_BASE_ARGS, CLIENT_NAME, TURN_BYPASS, perThreadConfigOverride } from "../contracts.js"
import { isOurAppServerCmd, seatTagArgs } from "../proc/orphans.js"
import { buildAppServerArgs } from "../proc/spawn.js"
import { RealAppServerClient } from "./real-client.js"
import type { ScriptedServerScript } from "./scripted-server.js"
import { defaultProcOps } from "./proc.js"

const NODE = process.execPath
/** 编译产物里假 app-server 的位置（本文件也在 dist/src/app-server/ 下） */
const SCRIPTED = path.join(__dirname, "scripted-server.js")

interface Rig {
  dir: string
  bin: string
  trace: string
  pidFile: string
  cwd: string
}

function rig(tag: string, script: ScriptedServerScript): Rig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `codex-seat-rc-${tag}-`))
  const scriptPath = path.join(dir, "script.json")
  const trace = path.join(dir, "trace.jsonl")
  fs.writeFileSync(scriptPath, JSON.stringify(script))
  const bin = path.join(dir, "codex")
  // 故意**不用 exec**：sh 留着当 wrapper，复刻 /opt/homebrew/bin/codex(node wrapper) → rust 本体 的两层结构。
  // 只杀 wrapper 会留孤儿，这正是要测的。
  fs.writeFileSync(
    bin,
    `#!/bin/sh\nCODEX_SCRIPTED_SCRIPT='${scriptPath}' CODEX_SCRIPTED_TRACE='${trace}' '${NODE}' '${SCRIPTED}' "$@"\n`,
    { mode: 0o755 },
  )
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `codex-seat-cwd-${tag}-`))
  return { dir, bin, trace, pidFile: path.join(dir, "app-server.pid"), cwd }
}

function traceLines(r: Rig): any[] {
  if (!fs.existsSync(r.trace)) return []
  return fs
    .readFileSync(r.trace, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
}

function received(r: Rig, method: string): any[] {
  return traceLines(r).filter((x) => x.t === "recv" && x.method === method)
}

/**
 * 起过的 client 都登记进来：任何一个用例断言失败提前退出时，子进程的 stdio 管道
 * 会把 node 的事件循环钉住，整个测试文件永远不结束（实测踩过：--test-timeout=0
 * 下就是无输出地挂死）。收尾钩子兜底关掉。
 */
const openClients: RealAppServerClient[] = []
after(async () => {
  for (const c of openClients) {
    try {
      await c.stop()
    } catch {
      /* 已经关了 */
    }
  }
})

function client(r: Rig, extra: Partial<ConstructorParameters<typeof RealAppServerClient>[0]> = {}): RealAppServerClient {
  const c = new RealAppServerClient({
    cwd: r.cwd,
    bin: r.bin,
    pidFile: r.pidFile,
    initializeTimeoutMs: 8000,
    threadOpTimeoutMs: 8000,
    shutdownGraceMs: 300,
    seat: "e2e-test",
    instanceId: "test-instance",
    ...extra,
  })
  openClients.push(c)
  return c
}

async function until(pred: () => boolean, ms: number, label: string): Promise<void> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (pred()) return
    await new Promise((res) => setTimeout(res, 20))
  }
  throw new Error(`等 ${label} 超过 ${ms}ms`)
}

const OK_TURN: ScriptedServerScript["turn"] = {
  emitStarted: true,
  startedAfterMs: 5,
  items: [{ type: "agentMessage", text: "SCRIPTED-OK" }],
  tokenUsage: true,
  completedAfterMs: 10,
  status: "completed",
}

describe("RealAppServerClient：启动与进程", () => {
  it("start() 起进程组、initialize 握手、写 pid 文件（带 cmdline）", async () => {
    const t0 = Date.now()
    const r = rig("start", { turn: OK_TURN, spawnChild: true })
    const c = client(r)
    const info = await c.start()
    assert.equal(info.pid > 0, true)
    assert.equal(info.pgid, info.pid, "detached 启动 → pgid = pid")
    assert.equal(info.codexHome.length > 0, true)
    assert.equal(info.initializeMs >= 0, true)
    assert.equal(info.codexBin, r.bin)
    assert.match(String(info.codexVersion), /scripted/)

    const pf = JSON.parse(fs.readFileSync(r.pidFile, "utf8"))
    assert.equal(pf.pid, info.pid)
    assert.equal(pf.pgid, info.pgid)
    assert.match(pf.cmdline, /app-server/)
    assert.equal(pf.instanceId, "test-instance")

    // initialize 的 clientInfo 必须是新名字，不许再叫 cc2wechat
    const init = received(r, "initialize")[0]
    assert.equal(init.params.clientInfo.name, CLIENT_NAME)
    assert.equal(init.params.capabilities.requestAttestation, false)
    // initialized 通知必须发出去
    await until(() => received(r, "initialized").length === 1, 3000, "initialized 通知")

    // argv 必须是冻结的 APP_SERVER_BASE_ARGS（含 -c notify=[]）
    const env = traceLines(r).find((x) => x.t === "env")
    assert.deepEqual(env.argv.slice(0, APP_SERVER_BASE_ARGS.length), [...APP_SERVER_BASE_ARGS])
    // 席位标签必须是**最后一对**：孤儿谓词 isOurAppServerCmd 按它认人，
    // 没有它，findOrphans() 在自己起的引擎面前也是瞎的（只剩 pid 文件一条线索）。
    assert.deepEqual(env.argv.slice(-2), seatTagArgs("e2e-test", "test-instance"))
    assert.deepEqual(env.argv, buildAppServerArgs("e2e-test", "test-instance"))
    assert.equal(isOurAppServerCmd([r.bin, ...env.argv].join(" "), "e2e-test"), true, "自己起的引擎必须认得出是自己的")
    assert.equal(isOurAppServerCmd([r.bin, ...env.argv].join(" "), "someone-else"), false, "别人席位的标签一律不认")

    await c.stop()
    console.log(`[start] ${Date.now() - t0}ms pid=${info.pid} initializeMs=${info.initializeMs}`)
  })

  it("start() 幂等：已活着直接返回同一个 pid", async () => {
    const r = rig("idem", { turn: OK_TURN })
    const c = client(r)
    const a = await c.start()
    const b = await c.start()
    assert.equal(a.pid, b.pid)
    await c.stop()
  })

  it("进程级 env 被 scrub：MESH_NODE / MESH_DELEGATOR_NODE / MESH_ID 一个都不许进子进程", async () => {
    const r = rig("scrub", { turn: OK_TURN })
    const c = client(r, {
      env: { ...process.env, MESH_NODE: "computer2:codex-main", MESH_DELEGATOR_NODE: "server:brain", MESH_ID: "zzz" },
    })
    await c.start()
    const env = traceLines(r).find((x) => x.t === "env")
    assert.equal(env.meshNode, null)
    assert.equal(env.meshDelegator, null)
    assert.equal(env.meshId, null)
    await c.stop()
  })

  it("stop() 杀整个进程组：wrapper、node、孙子进程一个不剩", async () => {
    const t0 = Date.now()
    const r = rig("group", { turn: OK_TURN, spawnChild: true })
    const c = client(r)
    const info = await c.start()
    await until(() => traceLines(r).some((x) => x.t === "child"), 4000, "孙子进程起来")
    const grand = traceLines(r).find((x) => x.t === "child").pid as number
    assert.equal(defaultProcOps.isAlive(grand), true, "前提：孙子进程确实活着（先证明这把尺子量得出东西）")

    await c.stop()
    await until(() => !defaultProcOps.isAlive(info.pid) && !defaultProcOps.isAlive(grand), 4000, "进程组清空")
    assert.equal(defaultProcOps.isAlive(info.pid), false)
    assert.equal(defaultProcOps.isAlive(grand), false, "孙子进程还活着 = 只杀了 wrapper")
    assert.equal(fs.existsSync(r.pidFile), false, "pid 文件要删掉")
    console.log(`[group-kill] ${Date.now() - t0}ms wrapper=${info.pid} grandchild=${grand}`)
  })

  it("wrapperOnly（E08 变异）只杀 wrapper —— 孙子进程活下来，正是进程组 kill 存在的理由", async () => {
    const r = rig("wrapper-only", { turn: OK_TURN, spawnChild: true })
    const c = client(r)
    const info = await c.start()
    await until(() => traceLines(r).some((x) => x.t === "child"), 4000, "孙子进程起来")
    const grand = traceLines(r).find((x) => x.t === "child").pid as number

    await c.stop({ wrapperOnly: true, graceMs: 200 })
    assert.equal(defaultProcOps.isAlive(grand), true, "wrapperOnly 下孙子必须还在（否则这个变异没测到东西）")

    // 收摊：把这一组彻底清掉，别给别的用例留脏
    try {
      process.kill(-info.pgid, "SIGKILL")
    } catch {
      /* 已经没了 */
    }
    await until(() => !defaultProcOps.isAlive(grand), 4000, "手工清孤儿")
  })

  it("engine-down 故障：不 spawn、直接抛，不重试", async () => {
    const r = rig("engine-down", { turn: OK_TURN })
    const c = client(r, { faults: new Set(["engine-down"]) })
    await assert.rejects(() => c.start(), /engine-down/)
    assert.equal(traceLines(r).length, 0, "一个进程都不许起")
    assert.equal(c.isAlive(), false)
  })

  it("起之前先收孤儿：pid 文件里指向活着的 app-server 会被进程组清掉", async () => {
    const r = rig("orphan", { turn: OK_TURN })
    const c1 = client(r)
    const first = await c1.start()
    // 模拟 sidecar 被 SIGKILL：不 stop，直接换一个 client 起（pid 文件还在）
    const c2 = client(r)
    const second = await c2.start()
    assert.notEqual(second.pid, first.pid)
    await until(() => !defaultProcOps.isAlive(first.pid), 4000, "旧引擎被收尸")
    await c2.stop()
  })
})

describe("RealAppServerClient：thread 与 turn", () => {
  it("thread/start 把 config 原样透传（署名唯一注入点），developerInstructions 也带上", async () => {
    const r = rig("thread", { turn: OK_TURN })
    const c = client(r)
    await c.start()
    const cfg = perThreadConfigOverride("computer2:cx-ab12", "server:brain")
    const info = await c.threadStart({
      cwd: r.cwd,
      developerInstructions: "你是 worker",
      config: cfg,
      ephemeral: false,
    })
    assert.equal(info.threadId.length > 0, true)
    assert.equal(info.resumed, false)
    assert.equal(info.opMs >= 0, true)

    const p = received(r, "thread/start")[0].params
    assert.deepEqual(p.config, cfg, "config 必须一字不改地透传")
    assert.equal(p.developerInstructions, "你是 worker")
    assert.equal(p.cwd, r.cwd)
    await c.stop()
  })

  it("thread/resume 带 threadId + config，resumed=true", async () => {
    const r = rig("resume", { turn: OK_TURN })
    const c = client(r)
    await c.start()
    const started = await c.threadStart({ cwd: r.cwd })
    const cfg = perThreadConfigOverride("computer2:codex-main2")
    const resumed = await c.threadResume({ threadId: started.threadId, cwd: r.cwd, config: cfg })
    assert.equal(resumed.threadId, started.threadId)
    assert.equal(resumed.resumed, true)
    const p = received(r, "thread/resume")[0].params
    assert.equal(p.threadId, started.threadId)
    assert.deepEqual(p.config, cfg)
    await c.stop()
  })

  it("thread/start 失败要抛（B 才知道该报 thread-start-failed）", async () => {
    const r = rig("thread-fail", { turn: OK_TURN, failThreadStart: "no disk" })
    const c = client(r)
    await c.start()
    await assert.rejects(() => c.threadStart({ cwd: r.cwd }), /no disk/)
    await c.stop()
  })

  it("turn 生命周期：started 早于 completed，finalText 拿得到，每轮都带 bypass", async () => {
    const t0 = Date.now()
    const r = rig("turn", { turn: OK_TURN })
    const c = client(r)
    const evTypes: string[] = []
    c.onEvent((e) => evTypes.push(e.type === "raw" ? e.method : e.type))
    await c.start()
    const th = await c.threadStart({ cwd: r.cwd })
    const h = await c.turnStart({ threadId: th.threadId, text: "hi", nonce: "n1", msgId: "m1", timeoutMs: 8000 })
    const started = await h.started
    assert.equal(typeof started.turnId, "string")
    const out = await h.done
    assert.equal(out.status, "completed")
    if (out.status === "completed") {
      assert.equal(out.finalText, "SCRIPTED-OK")
      assert.equal(out.startedMs >= 0, true)
      assert.equal(out.wallMs >= out.startedMs, true)
    }

    const tp = received(r, "turn/start")[0].params
    assert.equal(tp.approvalPolicy, TURN_BYPASS.approvalPolicy)
    assert.deepEqual(tp.sandboxPolicy, TURN_BYPASS.sandboxPolicy)
    assert.deepEqual(tp.input[0], { type: "text", text: "hi", text_elements: [] })

    // 事件表：raw 方法名与映射后的类型都要有
    for (const m of ["thread/started", "turn/started", "item/completed", "thread/tokenUsage/updated", "turn/completed"]) {
      assert.equal(evTypes.includes(m), true, `缺 raw 事件 ${m}`)
    }
    for (const m of ["turn.started", "item.completed", "token.usage", "turn.completed"]) {
      assert.equal(evTypes.includes(m), true, `缺映射事件 ${m}`)
    }
    await c.stop()
    console.log(`[turn] ${Date.now() - t0}ms events=${evTypes.length}`)
  })

  it("图片随同一轮 turn/start 以原生 localImage 输入送达：正文在前，图片按给定顺序跟在后面", async () => {
    const r = rig("turn-images", { turn: OK_TURN })
    const c = client(r)
    await c.start()
    const th = await c.threadStart({ cwd: r.cwd })
    const first = path.join(r.dir, "first.jpg")
    const second = path.join(r.dir, "second.png")
    const h = await c.turnStart({ threadId: th.threadId, text: "看图 [图片1] [图片2]", images: [first, second], nonce: "n-img", msgId: "m-img", timeoutMs: 8000 })
    assert.equal((await h.done).status, "completed")
    const input = received(r, "turn/start")[0].params.input
    assert.deepEqual(input, [
      { type: "text", text: "看图 [图片1] [图片2]", text_elements: [] },
      { type: "localImage", path: first },
      { type: "localImage", path: second },
    ])
    // 没有图片时报文形状与旧版逐字节一致：不出现空的附加项。
    const plain = await c.turnStart({ threadId: th.threadId, text: "纯文字", nonce: "n-plain", msgId: "m-plain", timeoutMs: 8000 })
    assert.equal((await plain.done).status, "completed")
    assert.deepEqual(received(r, "turn/start")[1].params.input, [{ type: "text", text: "纯文字", text_elements: [] }])
    await c.stop()
  })

  it("turn/start 被拒（-32600）→ done = rejected，不是抛异常", async () => {
    const r = rig("turn-reject", { turn: OK_TURN, failTurnStart: { code: -32600, message: "missing field `type`" } })
    const c = client(r)
    await c.start()
    const th = await c.threadStart({ cwd: r.cwd })
    const h = await c.turnStart({ threadId: th.threadId, text: "hi", nonce: "n", msgId: "m", timeoutMs: 4000 })
    const out = await h.done
    assert.equal(out.status, "rejected")
    if (out.status === "rejected") assert.equal(out.code, -32600)
    await c.stop()
  })

  it("turn/completed status=failed → done = failed，带错误正文", async () => {
    const r = rig("turn-failed", {
      turn: { ...OK_TURN, status: "failed", errorMessage: "model exploded" },
    })
    const c = client(r)
    await c.start()
    const th = await c.threadStart({ cwd: r.cwd })
    const h = await c.turnStart({ threadId: th.threadId, text: "hi", nonce: "n", msgId: "m", timeoutMs: 4000 })
    const out = await h.done
    assert.equal(out.status, "failed")
    if (out.status === "failed") assert.match(out.message, /model exploded/)
    await c.stop()
  })

  it("drop-turn-started 故障：started 不来 → 到点超时（E01 红门的机制）", async () => {
    const t0 = Date.now()
    // 这一轮**不许自然收尾**：turn/started 被吞之后，唯一的出路必须是墙钟超时
    const r = rig("drop-started", { turn: { ...OK_TURN, completedAfterMs: 60_000, interruptible: false } })
    const c = client(r, { faults: new Set(["drop-turn-started"]) })
    await c.start()
    const th = await c.threadStart({ cwd: r.cwd })
    const h = await c.turnStart({ threadId: th.threadId, text: "hi", nonce: "n", msgId: "m", timeoutMs: 400 })
    let startedResolved = false
    void h.started.then(
      () => {
        startedResolved = true
      },
      () => {},
    )
    const out = await h.done
    assert.equal(out.status, "timeout")
    assert.equal(startedResolved, false, "started 绝不能 resolve")
    // 超时要真的发了 turn/interrupt，不能让那轮在后台烧
    await until(() => received(r, "turn/interrupt").length >= 1, 2000, "turn/interrupt 发出")
    await c.stop()
    console.log(`[drop-turn-started] ${Date.now() - t0}ms`)
  })

  it("多 thread 并行：两轮各走各的 threadId，不串台", async () => {
    const r = rig("parallel", { turn: { ...OK_TURN, startedAfterMs: 5, completedAfterMs: 120 } })
    const c = client(r)
    await c.start()
    const a = await c.threadStart({ cwd: r.cwd })
    const b = await c.threadStart({ cwd: r.cwd })
    assert.notEqual(a.threadId, b.threadId)
    const t0 = Date.now()
    const [ha, hb] = await Promise.all([
      c.turnStart({ threadId: a.threadId, text: "A", nonce: "na", msgId: "ma", timeoutMs: 5000 }),
      c.turnStart({ threadId: b.threadId, text: "B", nonce: "nb", msgId: "mb", timeoutMs: 5000 }),
    ])
    const [oa, ob] = await Promise.all([ha.done, hb.done])
    const wall = Date.now() - t0
    assert.equal(oa.status, "completed")
    assert.equal(ob.status, "completed")
    assert.equal(ha.threadId, a.threadId)
    assert.equal(hb.threadId, b.threadId)
    assert.equal(wall < 400, true, `并行墙钟应远小于串行 240ms×2，实际 ${wall}ms`)
    await c.stop()
    console.log(`[parallel] wall=${wall}ms`)
  })

  it("引擎中途死掉：在途 turn 变 lost，并发 engine.lost 事件", async () => {
    const r = rig("lost", { turn: { ...OK_TURN, completedAfterMs: 60_000 }, exitAfterMs: 300 })
    const c = client(r)
    const lost: string[] = []
    c.onEvent((e) => {
      if (e.type === "engine.lost") lost.push(e.reason)
    })
    await c.start()
    const th = await c.threadStart({ cwd: r.cwd })
    const h = await c.turnStart({ threadId: th.threadId, text: "hi", nonce: "n", msgId: "m", timeoutMs: 30_000 })
    const out = await h.done
    assert.equal(out.status, "lost")
    assert.equal(lost.length >= 1, true)
    assert.equal(c.isAlive(), false)
    await c.stop()
  })

  it("interrupt() 发的是 turn/interrupt 请求，不是杀进程", async () => {
    const r = rig("interrupt", { turn: { ...OK_TURN, completedAfterMs: 60_000, interruptible: true } })
    const c = client(r)
    await c.start()
    const th = await c.threadStart({ cwd: r.cwd })
    const h = await c.turnStart({ threadId: th.threadId, text: "hi", nonce: "n", msgId: "m", timeoutMs: 30_000 })
    await h.started
    await h.interrupt()
    const out = await h.done
    assert.equal(out.status, "interrupted")
    assert.equal(received(r, "turn/interrupt").length >= 1, true)
    assert.equal(c.isAlive(), true, "打断不许把进程带走")
    await c.stop()
  })
})

describe("RealAppServerClient：运维接口", () => {
  it("rateLimits() 映射顶层桶与 byLimitId，usedPercent 原样", async () => {
    const r = rig("ratelimits", { turn: OK_TURN })
    const c = client(r)
    await c.start()
    const snap = await c.rateLimits()
    assert.equal(snap.rateLimits?.primary?.usedPercent, 12)
    assert.equal(snap.rateLimits?.primary?.windowDurationMins, 300)
    assert.equal(snap.rateLimits?.planType, "pro")
    assert.equal(snap.byLimitId.length >= 1, true)
    assert.equal(snap.byLimitId.some((b) => b.limitId === "codex"), true, "byLimitId 的键要回填成 limitId")
    assert.equal(typeof snap.sampledAt, "string")
    await c.stop()
  })

  it("account() 只取类型/plan，email 原样返回给调用方去算指纹", async () => {
    const r = rig("account", { turn: OK_TURN })
    const c = client(r)
    await c.start()
    const a = await c.account()
    assert.equal(a.type, "chatgpt")
    assert.equal(a.planType, "pro")
    await c.stop()
  })

  it("loadedThreads() 取 result.data", async () => {
    const r = rig("loaded", { turn: OK_TURN })
    const c = client(r)
    await c.start()
    const th = await c.threadStart({ cwd: r.cwd })
    const list = await c.loadedThreads()
    assert.equal(list.includes(th.threadId), true)
    await c.stop()
  })

  it("compact() 发 thread/compact/start 并量墙钟", async () => {
    const r = rig("compact", { turn: OK_TURN })
    const c = client(r)
    await c.start()
    const th = await c.threadStart({ cwd: r.cwd })
    const out = await c.compact(th.threadId, 4000)
    assert.equal(out.ok, true)
    assert.equal(out.wallMs >= 0, true)
    assert.equal(received(r, "thread/compact/start")[0].params.threadId, th.threadId)
    await c.stop()
  })

  it("引擎没起来就 turnStart 要抛，不能静默挂住", async () => {
    const r = rig("notstarted", { turn: OK_TURN })
    const c = client(r)
    await assert.rejects(
      () => c.turnStart({ threadId: "t", text: "x", nonce: "n", msgId: "m", timeoutMs: 100 }),
      /not running/i,
    )
  })
})
