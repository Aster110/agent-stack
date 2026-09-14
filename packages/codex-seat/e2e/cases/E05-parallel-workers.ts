// E05 多 worker 并行（真 relay + 真 codex）
//
// ⚠️ 判据经主席位 2026-09-02 裁定改写：原「两 worker 各 sleep 8、总墙钟 <14s」作废——
//    Lane A 实测真模型一轮「说一句 → sleep 8 → 再说一句」要 16–24s，14s 连单轮都装不下。
//    改用**结构判据**（与 A 的 E01 同款），墙钟只留一个不含模型速度假设的绝对上限：
//      (a) 两个 turn/started 都在各自 turn/start 发出后 ≤100ms
//      (b) 两 turn 的执行窗口有重叠，且并行墙钟 < 两轮串行墙钟之和 × 0.75
//      (c) 并行墙钟绝对上限 30000ms
//    变异对照（single-thread-routing，两条全挤主 thread）额外验串行签名：
//      第二条的 turn/started 晚于第一条的 turn/completed，且总墙钟 ≥ 两轮单独墙钟之和 × 0.9
//
// 裁定 2：thread/start 冷启会偶发 5s（MCP 还在起），所以先跑一条**不计时的预热消息**，
//        再开始量 started 延迟。

import type { Receipt } from "../../src/contracts.js"
import { engineFor, envFor, mergeEvents, rolloutBytes, type CaseFn } from "../lib/case.js"
import { waitFor } from "../lib/util.js"

const SLEEP_SEC = 8
const STARTED_LATENCY_MAX_MS = 100
const PARALLEL_RATIO_MAX = 0.75
const SERIAL_RATIO_MIN = 0.9
const WALL_CAP_MS = 30_000

interface TurnWindow {
  nonce: string
  threadId: string
  startAtMs: number
  startedAtMs: number | null
  endAtMs: number
  startedLatencyMs: number | null
  wallMs: number
}

function windows(seat: { logLines(): Array<Record<string, unknown>> }): TurnWindow[] {
  return seat.logLines().filter((l) => l.event === "turn-window") as unknown as TurnWindow[]
}

export const E05: CaseFn = async (ctx) => {
  const kind = engineFor("real")
  const isMutate = ctx.mutate === ""
  const seat = ctx.seat({
    engine: kind,
    faults: isMutate ? ["single-thread-routing"] : [],
    scenario: { defaultTurn: { startedAfterMs: 5, completeAfterMs: SLEEP_SEC * 1000, outcome: { status: "completed", finalText: "slept" } } },
  })
  await seat.start()
  const before = rolloutBytes(seat, kind)

  // ---- 预热（不计时）：让 app-server 的 MCP 启动完，thread/start 从冷 5s 落到热 80ms ----
  const warm = `${ctx.nonce}warm`
  await ctx.probe.send(seat.nodeId, `预热一轮，只回复一行：warm nonce=${warm}`)
  await ctx.probe.wait((r) => r.kind === "done" && r.nonce === warm, 180_000, "预热 done")
  ctx.note("已用一条不计时的预热消息把引擎带热（裁定 2）")

  // ---- 拉两个 worker ----
  const workers: string[] = []
  for (const tag of ["w1", "w2"]) {
    const n = `${ctx.nonce}${tag}`
    const t0 = Date.now()
    await ctx.probe.send(seat.nodeId, `[ctl:spawn] role=worker cwd=${seat.cwd} agent=codex nonce=${n} desc=e2e ${tag}`)
    const ready = await ctx.probe.wait((r) => r.kind === "bootstrap-ready" && r.nonce === n, 60_000, `${tag} ready`)
    ctx.a.lte(`${tag} 从 spawn 到 ready 的 ms`, ready.atMs - t0, 30_000)
    workers.push((ready.receipt as Extract<Receipt, { kind: "bootstrap-ready" }>).node)
  }
  ctx.a.eq("拉起了两个不同的 worker", new Set(workers).size, 2)

  const before2 = windows(seat).length
  const taskNonces = workers.map((_, i) => `${ctx.nonce}t${i + 1}`)
  const tSend = Date.now()
  await Promise.all(workers.map((w, i) =>
    ctx.probe.send(w, `请在 shell 里执行 sleep ${SLEEP_SEC}，完成后只回复一行：slept nonce=${taskNonces[i]}`),
  ))
  // 变异档下有可能有人拿不到终态；这里不许抛——抛了证据里就只剩一句 case-threw，
  // 红门就成了「不知道为什么红」。等不到就记下来，照常量它已有的窗口。
  const terminals = await Promise.all(taskNonces.map((n) =>
    ctx.probe.wait((r) => (r.kind === "done" || r.kind === "failed") && r.nonce === n, 120_000, `任务 ${n} 的终态`)
      .then(() => true).catch(() => false),
  ))
  const parallelWall = Date.now() - tSend
  ctx.a.eq("两条任务都拿到终态", terminals.filter(Boolean).length, 2)

  const ws = windows(seat).slice(before2).filter((w) => taskNonces.includes(w.nonce))
  ctx.a.eq("两条任务都留下了 turn 执行窗口", ws.length, 2)
  if (ws.length !== 2) {
    return finish(ctx, seat, kind, before, isMutate, workers.length + 3)
  }
  const [a, b] = [...ws].sort((x, y) => x.startAtMs - y.startAtMs) as [TurnWindow, TurnWindow]

  // (a) turn/started 延迟（热态引擎）
  for (const w of ws) {
    ctx.a.lte(`nonce=${w.nonce} 的 turn/started 延迟 ms`, w.startedLatencyMs ?? Number.POSITIVE_INFINITY, STARTED_LATENCY_MAX_MS)
  }

  // (b) 窗口重叠 + 并行墙钟 < 串行和 × 0.75
  const overlapMs = Math.min(a.endAtMs, b.endAtMs) - Math.max(a.startAtMs, b.startAtMs)
  const serialSum = a.wallMs + b.wallMs
  ctx.a.ok("两 turn 的执行窗口有重叠", overlapMs > 0, overlapMs, "> 0")
  ctx.a.lte("并行墙钟 / 串行和", Number((parallelWall / serialSum).toFixed(3)), PARALLEL_RATIO_MAX)
  // (c) 绝对上限
  ctx.a.lte("并行墙钟绝对上限 ms", parallelWall, WALL_CAP_MS)
  ctx.note(`parallelWall=${parallelWall}ms serialSum=${serialSum}ms overlap=${overlapMs}ms ratio=${(parallelWall / serialSum).toFixed(3)}`)

  if (isMutate) {
    // 变异下两条被挤进同一个 thread：额外验「串行签名」，证明它是**因为串行**而红，不是别的毛病。
    ctx.a.ok("变异下两条落在同一个 thread", a.threadId === b.threadId, { a: a.threadId, b: b.threadId }, "相同")
    ctx.a.ok("第二条的 turn/started 晚于第一条的 turn/completed",
      (b.startedAtMs ?? b.startAtMs) >= a.endAtMs, { bStarted: b.startedAtMs, aEnd: a.endAtMs }, "b.started >= a.end")
    ctx.a.gte("总墙钟 / 两轮单独墙钟之和", Number((parallelWall / serialSum).toFixed(3)), SERIAL_RATIO_MIN)
  }

  return finish(ctx, seat, kind, before, isMutate, workers.length + 3)
}

function finish(
  ctx: Parameters<CaseFn>[0],
  seat: ReturnType<Parameters<CaseFn>[0]["seat"]>,
  kind: "real" | "fake",
  before: number | null,
  isMutate: boolean,
  sent: number,
): ReturnType<CaseFn> extends Promise<infer R> ? R : never {
  return {
    mutation: isMutate
      ? { fault: "single-thread-routing", expectedRed: true, note: "红门：全挤主 thread → 窗口不重叠、比值超 0.75" }
      : null,
    events: mergeEvents(seat, ctx.probe, { "mesh.sent": sent }),
    env: envFor(kind),
    codexVersion: seat.engineInfo().codexVersion,
    instanceId: seat.state()?.instanceId ?? null,
    rolloutBytesBefore: before,
    rolloutBytesAfter: rolloutBytes(seat, kind),
  } as never
}

void waitFor
