// E16 未知 ServerRequest（真 relay + **假引擎**）
//
// 剧本（Lane A 的 fake-scenario 格式）：turn/started 之后发一条 `x/unknown/request`，
// 并且 waitForServerRequestReply=true —— 没人应答就不许收尾。
// 阈值：[done] ≤5s；server.request{replied:"default-32601"} 计数 1
// 变异：--mutate = drop-serverrequest-default（红门，turn.timeoutMs=5000）→ [failed] timeout、无 done
//
// 这个 case 守的是 answerForServerRequest 的**默认分支**：删掉它，未知请求就永远没人回，
// 一轮对话会静静挂死到超时——线上表现是「席位收到消息、发了 seen、然后没有下文」。

import type { FakeScenarioInput } from "../../src/app-server/fake-scenario.js"
import type { Receipt } from "../../src/contracts.js"
import { envFor, mergeEvents, type CaseFn } from "../lib/case.js"

const TURN_TIMEOUT_MS = 5000

export const E16: CaseFn = async (ctx) => {
  const isMutate = ctx.mutate === ""
  const scenario: FakeScenarioInput = {
    defaultTurn: {
      startedAfterMs: 5,
      steps: [{ afterMs: 5, serverRequest: { method: "x/unknown/request" } }],
      waitForServerRequestReply: true,
      completeAfterMs: 10,
      outcome: { status: "completed", finalText: "答完了" },
    },
  }
  const seat = ctx.seat({
    engine: "fake",
    scenario,
    faults: isMutate ? ["drop-serverrequest-default"] : [],
    configPatch: { turn: { timeoutMs: TURN_TIMEOUT_MS } },
  })
  await seat.start()

  const n = `${ctx.nonce}u`
  const t0 = Date.now()
  await ctx.probe.send(seat.nodeId, `问一个会触发未知 ServerRequest 的问题 nonce=${n}`)

  let doneMs = Number.POSITIVE_INFINITY
  let failed: Extract<Receipt, { kind: "failed" }> | null = null
  try {
    const rec = await ctx.probe.wait(
      (r) => (r.kind === "done" || r.kind === "failed") && r.nonce === n,
      TURN_TIMEOUT_MS + 15_000, "done 或 failed",
    )
    if (rec.receipt!.kind === "done") doneMs = rec.atMs - t0
    else failed = rec.receipt as Extract<Receipt, { kind: "failed" }>
  } catch { /* 两个都没等到 */ }

  const events = seat.events()
  ctx.a.lte("[done] 耗时 ms", doneMs, 5000)
  ctx.a.eq("默认分支应答 -32601 的次数", events["server.request:default-32601"] ?? 0, 1)
  ctx.a.eq("没有失败回执", failed?.reason ?? null, null)

  if (isMutate) {
    // 红门下顺带记下「它是因为超时挂死而红」，而不是别的毛病
    ctx.note(`变异下终态：${failed ? `failed reason=${failed.reason}` : "什么都没收到"}；` +
      `server.request 计数=${events["server.request"] ?? 0}，default-32601 计数=${events["server.request:default-32601"] ?? 0}`)
  }

  return {
    mutation: isMutate
      ? { fault: "drop-serverrequest-default", expectedRed: true, note: `红门：不回 -32601 → turn 挂到 ${TURN_TIMEOUT_MS}ms 超时` }
      : null,
    events: mergeEvents(seat, ctx.probe, { "mesh.sent": 1 }),
    env: envFor("fake"), codexVersion: seat.engineInfo().codexVersion,
    instanceId: seat.state()?.instanceId ?? null,
    rolloutBytesBefore: null, rolloutBytesAfter: null,
  }
}
