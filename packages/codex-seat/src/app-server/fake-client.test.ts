/**
 * FakeAppServerClient：内存假引擎。B/C 线的单测与 E16 用它。
 * scenario 格式文档在 fake-scenario.ts 顶部注释，这里只钉行为。
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { perThreadConfigOverride } from "../contracts.js"
import { FakeAppServerClient } from "./fake-client.js"
import { DEFAULT_SCENARIO, loadScenario, parseScenario } from "./fake-scenario.js"

describe("scenario 装载", () => {
  it("缺省 scenario 能直接跑通一轮", async () => {
    const c = new FakeAppServerClient({})
    await c.start()
    const th = await c.threadStart({ cwd: "/tmp" })
    const h = await c.turnStart({ threadId: th.threadId, text: "hi", nonce: "n", msgId: "m", timeoutMs: 2000 })
    await h.started
    const out = await h.done
    assert.equal(out.status, "completed")
    await c.stop()
  })

  it("CODEX_SEAT_FAKE_SCENARIO 支持内联 JSON", () => {
    const s = loadScenario({ CODEX_SEAT_FAKE_SCENARIO: '{"version":1,"initializeMs":42}' })
    assert.equal(s.initializeMs, 42)
  })

  it("CODEX_SEAT_FAKE_SCENARIO 支持文件路径", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-seat-scn-"))
    const f = path.join(dir, "s.json")
    fs.writeFileSync(f, JSON.stringify({ version: 1, initializeMs: 7 }))
    assert.equal(loadScenario({ CODEX_SEAT_FAKE_SCENARIO: f }).initializeMs, 7)
  })

  it("没设 env 就用缺省", () => {
    assert.deepEqual(loadScenario({}), DEFAULT_SCENARIO)
  })

  it("坏 JSON 要抛，不要静默退回缺省（否则 case 会假绿）", () => {
    assert.throws(() => loadScenario({ CODEX_SEAT_FAKE_SCENARIO: "{not json" }))
  })

  it("未知字段照单收下（前向兼容），已知字段补默认值", () => {
    const s = parseScenario({ version: 1, somethingNew: true } as any)
    assert.equal(s.initializeMs >= 0, true)
    assert.equal(Array.isArray(s.turns), true)
  })
})

describe("FakeAppServerClient：基本形态", () => {
  it("kind=fake，info() 在 start 前是 null", async () => {
    const c = new FakeAppServerClient({})
    assert.equal(c.kind, "fake")
    assert.equal(c.info(), null)
    assert.equal(c.isAlive(), false)
    const info = await c.start()
    assert.equal(c.isAlive(), true)
    assert.equal(info.pgid, info.pid)
    assert.equal(info.initializeMs >= 0, true)
    await c.stop()
    assert.equal(c.isAlive(), false)
  })

  it("threadStart 记住 cwd 与 config；loadedThreads 列出来", async () => {
    const c = new FakeAppServerClient({})
    await c.start()
    const cfg = perThreadConfigOverride("dev:cx-0001", "server:brain")
    const a = await c.threadStart({ cwd: "/w/a", config: cfg })
    const b = await c.threadStart({ cwd: "/w/b" })
    assert.notEqual(a.threadId, b.threadId)
    assert.deepEqual(c.threadConfig(a.threadId), cfg)
    assert.deepEqual((await c.loadedThreads()).sort(), [a.threadId, b.threadId].sort())
    const rs = await c.threadResume({ threadId: a.threadId, cwd: "/w/a" })
    assert.equal(rs.resumed, true)
    await c.stop()
  })

  it("failStart / fail-thread-start 故障都走失败路径", async () => {
    const c1 = new FakeAppServerClient({ scenario: { failStart: "no engine" } })
    await assert.rejects(() => c1.start(), /no engine/)

    const c2 = new FakeAppServerClient({ faults: new Set(["fail-thread-start"]) })
    await c2.start()
    await assert.rejects(() => c2.threadStart({ cwd: "/tmp" }), /fail-thread-start/)
    await c2.stop()
  })

  it("engine-down 故障：start 直接抛", async () => {
    const c = new FakeAppServerClient({ faults: new Set(["engine-down"]) })
    await assert.rejects(() => c.start(), /engine-down/)
  })
})

describe("FakeAppServerClient：编排一轮", () => {
  it("按 steps 顺序出事件，最后 completed", async () => {
    const c = new FakeAppServerClient({
      scenario: {
        defaultTurn: {
          startedAfterMs: 1,
          steps: [
            { afterMs: 1, event: { type: "item.completed", itemType: "mcpToolCall", server: "node_repl", tool: "js", status: "completed" } },
            { afterMs: 1, event: { type: "token.usage", usage: { total: { totalTokens: 100, inputTokens: 90, cachedInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 }, last: { totalTokens: 100, inputTokens: 90, cachedInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 }, modelContextWindow: 1000 } } },
          ],
          completeAfterMs: 2,
          outcome: { status: "completed", finalText: "FAKE-DONE" },
        },
      },
    })
    const seen: string[] = []
    c.onEvent((e) => seen.push(e.type === "raw" ? e.method : e.type))
    await c.start()
    const th = await c.threadStart({ cwd: "/tmp" })
    const h = await c.turnStart({ threadId: th.threadId, text: "go", nonce: "n", msgId: "m", timeoutMs: 2000 })
    const st = await h.started
    assert.equal(typeof st.turnId, "string")
    const out = await h.done
    assert.equal(out.status, "completed")
    if (out.status === "completed") assert.equal(out.finalText, "FAKE-DONE")
    for (const t of ["turn.started", "item.completed", "token.usage", "turn.completed"]) {
      assert.equal(seen.includes(t), true, `缺事件 ${t}`)
    }
    // raw 计数也要有，B 的证据表按 raw 方法名统计
    assert.equal(seen.includes("turn/started"), true)
    assert.equal(seen.includes("turn/completed"), true)
    await c.stop()
  })

  it("turns 数组按顺序消费，用完退回 defaultTurn", async () => {
    const c = new FakeAppServerClient({
      scenario: {
        turns: [
          { startedAfterMs: 0, completeAfterMs: 1, outcome: { status: "completed", finalText: "first" } },
          { startedAfterMs: 0, completeAfterMs: 1, outcome: { status: "failed", message: "second boom" } },
        ],
        defaultTurn: { startedAfterMs: 0, completeAfterMs: 1, outcome: { status: "completed", finalText: "rest" } },
      },
    })
    await c.start()
    const th = await c.threadStart({ cwd: "/tmp" })
    const run = async () => {
      const h = await c.turnStart({ threadId: th.threadId, text: "x", nonce: "n", msgId: "m", timeoutMs: 2000 })
      return h.done
    }
    const o1 = await run()
    const o2 = await run()
    const o3 = await run()
    assert.equal(o1.status === "completed" && o1.finalText, "first")
    assert.equal(o2.status, "failed")
    assert.equal(o3.status === "completed" && o3.finalText, "rest")
    await c.stop()
  })

  it("match.textIncludes 选中对应的脚本", async () => {
    const c = new FakeAppServerClient({
      scenario: {
        turns: [
          { match: { textIncludes: "whoami" }, startedAfterMs: 0, completeAfterMs: 1, outcome: { status: "completed", finalText: "I-AM-WORKER" } },
        ],
        defaultTurn: { startedAfterMs: 0, completeAfterMs: 1, outcome: { status: "completed", finalText: "generic" } },
      },
    })
    await c.start()
    const th = await c.threadStart({ cwd: "/tmp" })
    const h1 = await c.turnStart({ threadId: th.threadId, text: "please whoami now", nonce: "n", msgId: "m", timeoutMs: 2000 })
    assert.equal((await h1.done).status === "completed" && (await h1.done as any).finalText, "I-AM-WORKER")
    const h2 = await c.turnStart({ threadId: th.threadId, text: "hello", nonce: "n", msgId: "m2", timeoutMs: 2000 })
    assert.equal((await h2.done as any).finalText, "generic")
    await c.stop()
  })

  it("crash 步骤：连接丢失 → engine.lost + done=lost", async () => {
    const c = new FakeAppServerClient({
      scenario: {
        defaultTurn: {
          startedAfterMs: 0,
          steps: [{ afterMs: 5, crash: "fake engine died" }],
          completeAfterMs: 60_000,
          outcome: { status: "completed", finalText: "never" },
        },
      },
    })
    const lost: string[] = []
    c.onEvent((e) => {
      if (e.type === "engine.lost") lost.push(e.reason)
    })
    await c.start()
    const th = await c.threadStart({ cwd: "/tmp" })
    const h = await c.turnStart({ threadId: th.threadId, text: "x", nonce: "n", msgId: "m", timeoutMs: 5000 })
    const out = await h.done
    assert.equal(out.status, "lost")
    assert.deepEqual(lost, ["fake engine died"])
    assert.equal(c.isAlive(), false)
    await c.stop()
  })

  it("超时：completeAfterMs 大于 timeoutMs → done=timeout", async () => {
    const c = new FakeAppServerClient({
      scenario: { defaultTurn: { startedAfterMs: 0, completeAfterMs: 5000, outcome: { status: "completed", finalText: "late" } } },
    })
    await c.start()
    const th = await c.threadStart({ cwd: "/tmp" })
    const h = await c.turnStart({ threadId: th.threadId, text: "x", nonce: "n", msgId: "m", timeoutMs: 60 })
    const out = await h.done
    assert.equal(out.status, "timeout")
    await c.stop()
  })

  it("interrupt() → done=interrupted", async () => {
    const c = new FakeAppServerClient({
      scenario: { defaultTurn: { startedAfterMs: 0, completeAfterMs: 60_000, outcome: { status: "completed", finalText: "x" } } },
    })
    await c.start()
    const th = await c.threadStart({ cwd: "/tmp" })
    const h = await c.turnStart({ threadId: th.threadId, text: "x", nonce: "n", msgId: "m", timeoutMs: 30_000 })
    await h.started
    await h.interrupt()
    assert.equal((await h.done).status, "interrupted")
    await c.stop()
  })

  it("drop-turn-started 故障：started 不 resolve", async () => {
    const c = new FakeAppServerClient({
      faults: new Set(["drop-turn-started"]),
      scenario: { defaultTurn: { startedAfterMs: 0, completeAfterMs: 5000, outcome: { status: "completed", finalText: "x" } } },
    })
    await c.start()
    const th = await c.threadStart({ cwd: "/tmp" })
    const h = await c.turnStart({ threadId: th.threadId, text: "x", nonce: "n", msgId: "m", timeoutMs: 80 })
    let resolved = false
    void h.started.then(() => { resolved = true }, () => {})
    const out = await h.done
    assert.equal(out.status, "timeout")
    assert.equal(resolved, false)
    await c.stop()
  })
})

describe("FakeAppServerClient：ServerRequest（E16 的机制）", () => {
  const e16Scenario = {
    defaultTurn: {
      startedAfterMs: 1,
      steps: [{ afterMs: 1, serverRequest: { method: "x/unknown/request" } }],
      waitForServerRequestReply: true,
      completeAfterMs: 1,
      outcome: { status: "completed" as const, finalText: "E16-OK" },
    },
  }

  it("未知 ServerRequest 被默认分支应答 → 那一轮能收尾", async () => {
    const c = new FakeAppServerClient({ scenario: e16Scenario })
    const replied: string[] = []
    c.onEvent((e) => {
      if (e.type === "server.request") replied.push(e.replied)
    })
    await c.start()
    const th = await c.threadStart({ cwd: "/tmp" })
    const h = await c.turnStart({ threadId: th.threadId, text: "x", nonce: "n", msgId: "m", timeoutMs: 3000 })
    const out = await h.done
    assert.equal(out.status, "completed")
    assert.deepEqual(replied, ["default-32601"])
    await c.stop()
  })

  it("drop-serverrequest-default：不回 → 那一轮挂到超时（红门证明它测到了东西）", async () => {
    const c = new FakeAppServerClient({ scenario: e16Scenario, faults: new Set(["drop-serverrequest-default"]) })
    const replied: string[] = []
    c.onEvent((e) => {
      if (e.type === "server.request") replied.push(e.replied)
    })
    await c.start()
    const th = await c.threadStart({ cwd: "/tmp" })
    const h = await c.turnStart({ threadId: th.threadId, text: "x", nonce: "n", msgId: "m", timeoutMs: 150 })
    const out = await h.done
    assert.equal(out.status, "timeout")
    assert.deepEqual(replied, ["dropped"])
    await c.stop()
  })

  it("表里的 ServerRequest 不受该故障影响", async () => {
    const c = new FakeAppServerClient({
      faults: new Set(["drop-serverrequest-default"]),
      scenario: {
        defaultTurn: {
          startedAfterMs: 0,
          steps: [{ afterMs: 0, serverRequest: { method: "execCommandApproval" } }],
          waitForServerRequestReply: true,
          completeAfterMs: 1,
          outcome: { status: "completed" as const, finalText: "ok" },
        },
      },
    })
    const replied: string[] = []
    c.onEvent((e) => {
      if (e.type === "server.request") replied.push(e.replied)
    })
    await c.start()
    const th = await c.threadStart({ cwd: "/tmp" })
    const h = await c.turnStart({ threadId: th.threadId, text: "x", nonce: "n", msgId: "m", timeoutMs: 2000 })
    assert.equal((await h.done).status, "completed")
    assert.deepEqual(replied, ["table"])
    await c.stop()
  })
})

describe("FakeAppServerClient：运维接口", () => {
  it("rateLimits / account / compact 走 scenario 给的值", async () => {
    const c = new FakeAppServerClient({
      scenario: {
        rateLimits: {
          rateLimits: { limitId: "codex", limitName: "Codex", planType: "pro", primary: { usedPercent: 33, windowDurationMins: 300, resetsAt: 1_800_000_000 }, secondary: null },
          byLimitId: [],
          sampledAt: "2026-09-02T00:00:00.000Z",
        },
        account: { type: "chatgpt", email: "x@y.z", planType: "pro" },
        compact: { ms: 1, ok: true },
      },
    })
    await c.start()
    const s = await c.rateLimits()
    assert.equal(s.rateLimits?.primary?.usedPercent, 33)
    const a = await c.account()
    assert.equal(a.type, "chatgpt")
    assert.equal(a.email, "x@y.z")
    const th = await c.threadStart({ cwd: "/tmp" })
    const cp = await c.compact(th.threadId, 1000)
    assert.equal(cp.ok, true)
    assert.equal(
      c.events().some((e) => e.type === "context.compacted"),
      true,
      "compact 成功要发 context.compacted（E20 的判据）",
    )
    await c.stop()
  })
})
