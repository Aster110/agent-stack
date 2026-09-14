// E20 上下文膨胀 compact（真 relay + 假引擎推 tokenUsage / 真引擎只验 1 次 compact 后的记忆）
//
// 步骤：循环发填充消息，每轮剧本推高 token.usage 的占比，直到 ≥ compact.thresholdRatio（0.70）
//       → sidecar 触发 thread/compact/start → 断言 compact 真的调过、且 compact 后占比回落
// 阈值：≤40 轮内触发（--turns=<n> 可放宽到 200 的慢档）；compact 调用 ≥1；compact 后占比 <0.5
// 变异：--mutate = disable-compact（红门）→ 一次 compact 都没有，占比一路涨过 0.95
//
// 假引擎档说明：Lane A 的剧本按脚本顺序消费 turns[]，所以占比是**脚本写死的递增序列**，
// 不是模型真烧出来的。真引擎档要烧 ~12k token/轮，超出本轮的 12 轮预算，故默认走假引擎。

import type { FakeScenarioInput, FakeTurnScriptInput } from "../../src/app-server/fake-scenario.js"
import type { ThreadTokenUsage } from "../../src/contracts.js"
import { engineFor, envFor, mergeEvents, type CaseFn } from "../lib/case.js"
import { waitFor } from "../lib/util.js"

const WINDOW = 258_400
const THRESHOLD = 0.7
const MAX_TURNS_DEFAULT = 40

function usage(ratio: number): ThreadTokenUsage {
  const total = Math.round(WINDOW * ratio)
  const b = { totalTokens: total, inputTokens: total, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }
  return { total: b, last: b, modelContextWindow: WINDOW }
}

export const E20: CaseFn = async (ctx) => {
  const kind = engineFor("fake")
  const isMutate = ctx.mutate === ""
  const turnsArg = process.argv.find((a) => a.startsWith("--turns="))
  const maxTurns = turnsArg ? Math.max(2, Number(turnsArg.slice("--turns=".length))) : MAX_TURNS_DEFAULT

  // 每轮把占比推高一格：第 k 轮 ratio = 0.1 + k×0.1，第 7 轮越过 0.70。
  // compact 之后的那一轮回落到 0.25——用来验「compact 后占比 <0.5」。
  const fill: FakeTurnScriptInput[] = []
  for (let k = 1; k <= maxTurns; k++) {
    const ratio = Math.min(0.95, 0.1 + k * 0.1)
    fill.push({
      startedAfterMs: 2,
      steps: [{ afterMs: 2, event: { type: "token.usage", usage: usage(ratio) } }],
      completeAfterMs: 3,
      outcome: { status: "completed", finalText: `filled ${k} ratio=${ratio.toFixed(2)}` },
    })
  }
  // 带 match 的脚本优先于顺序消费（A 的 pickTurnScript），所以埋事实/问事实这两条必须带 match，
  // 否则它们会把填充脚本吃掉，问 F 的那一轮反而推高占比、引出第二次 compact。
  const scenario: FakeScenarioInput = {
    turns: [
      { match: { textIncludes: "请记住这个事实" }, startedAfterMs: 2, completeAfterMs: 3, outcome: { status: "completed", finalText: "记住了" } },
      {
        match: { textIncludes: "刚才那个事实" }, startedAfterMs: 2,
        steps: [{ afterMs: 2, event: { type: "token.usage", usage: usage(0.25) } }],
        completeAfterMs: 3, outcome: { status: "completed", finalText: "事实 F 还在" },
      },
      ...fill,
    ],
    defaultTurn: { startedAfterMs: 2, completeAfterMs: 3, outcome: { status: "completed", finalText: "ok" } },
  }

  const seat = ctx.seat({ engine: kind, scenario, faults: isMutate ? ["disable-compact"] : [] })
  await seat.start()

  // 埋事实
  const nf = `${ctx.nonce}f`
  await ctx.probe.send(seat.nodeId, `请记住这个事实 F。只回复一行：记住了 nonce=${nf}`)
  await ctx.probe.wait((r) => r.kind === "done" && r.nonce === nf, 60_000, "埋事实的 done")

  // 填充直到触发（或耗尽轮数）
  let turnsUsed = 0
  let triggered = false
  for (let k = 1; k <= maxTurns; k++) {
    const n = `${ctx.nonce}p${k}`
    await ctx.probe.send(seat.nodeId, `填充第 ${k} 轮，只回复一行：ok nonce=${n}`)
    await ctx.probe.wait((r) => (r.kind === "done" || r.kind === "failed") && r.nonce === n, 60_000, `填充 ${k} 的终态`)
    turnsUsed = k
    const trig = seat.logLines().filter((l) => l.event === "compact-trigger")
    if (trig.length > 0) {
      triggered = true
      // 等 compact 真的做完
      await waitFor(() => seat.logLines().some((l) => l.event === "compact-done"), 20_000, "compact-done", 50).catch(() => {})
      break
    }
  }

  const trig = seat.logLines().filter((l) => l.event === "compact-trigger")
  const doneLog = seat.logLines().filter((l) => l.event === "compact-done")
  ctx.a.ok("触发过 compact", triggered, trig.length, ">= 1")
  ctx.a.lte("触发所用轮数", turnsUsed, maxTurns)
  ctx.a.gte("compact 完成次数", doneLog.length, 1)
  const trigRatio = trig.length > 0 ? Number(trig[0]!.ratio) : 0
  ctx.a.gte("触发时的上下文占比", trigRatio, THRESHOLD)
  ctx.a.gte("引擎 context.compacted 事件数", seat.events()["context.compacted"] ?? 0, 1)

  // compact 之后再问一次 F：占比必须回落，且照常拿到 done
  const nq = `${ctx.nonce}q`
  await ctx.probe.send(seat.nodeId, `刚才那个事实 F 是什么？只回复一行，带 nonce=${nq}`)
  await ctx.probe.wait((r) => r.kind === "done" && r.nonce === nq, 60_000, "compact 后的 done")
  const after = seat.logLines().filter((l) => l.event === "compact-trigger").length
  ctx.a.eq("compact 之后没有二次触发", after, trig.length)
  const ratios = seat.logLines().filter((l) => l.event === "context-ratio")
  const lastRatio = ratios.length > 0 ? Number(ratios.at(-1)!.ratio) : 1
  ctx.a.lte("compact 之后的上下文占比", lastRatio, 0.5)
  ctx.note(`turnsUsed=${turnsUsed} trigRatio=${trigRatio} compactDone=${doneLog.length} lastRatio=${lastRatio}`)

  return {
    mutation: isMutate ? { fault: "disable-compact", expectedRed: true, note: "红门：不 compact 就永远等不到 compact-trigger/compacted" } : null,
    events: mergeEvents(seat, ctx.probe, { "mesh.sent": turnsUsed + 2 }),
    env: envFor(kind), codexVersion: seat.engineInfo().codexVersion,
    instanceId: seat.state()?.instanceId ?? null,
    rolloutBytesBefore: null, rolloutBytesAfter: null,
  }
}
