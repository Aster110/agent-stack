// E02 注册与两级回执（真 relay + 真 codex）
//
// 前置：私有 relay + 探针 e2edev:e2e-probe + 被测席位 e2e-<4hex>（allowlist.extra=["*:e2e-probe"]）
// 步骤：探针发 `ping nonce=N` → 等 [seen] → 等 [done]
// 阈值：[seen] 自 send 返回起 ≤2000ms；seen 恰 1、done 恰 1、seen 早于 done；
//       [done] 正文含 N；relay /api/status 里该节点 deliveryMode=pull
// 变异：--mutate = engine-down（故障行为，expectedRed=false）：≤10s 收 [failed] engine-unavailable，且没有 seen

import type { Receipt } from "../../src/contracts.js"
import { engineFor, envFor, envIdle, mergeEvents, rolloutBytes, type CaseFn } from "../lib/case.js"

export const E02: CaseFn = async (ctx) => {
  const kind = engineFor("real")
  const isMutate = ctx.mutate === ""
  const nonce = ctx.nonce
  const seat = ctx.seat({
    engine: kind,
    faults: isMutate ? ["engine-down"] : [],
    scenario: { defaultTurn: { completeAfterMs: 5, outcome: { status: "completed", finalText: `pong ${nonce}` } } },
  })
  await seat.start()
  const before = rolloutBytes(seat, kind)

  const text = `ping nonce=${nonce} —— 只回复一行：pong ${nonce}`
  const { sentAtMs } = await ctx.probe.send(seat.nodeId, text)

  if (isMutate) {
    const failed = await ctx.probe.wait(
      (r) => r.kind === "failed" && r.nonce === nonce, 10_000, "[failed] engine-unavailable",
    )
    const r = failed.receipt as Extract<Receipt, { kind: "failed" }>
    ctx.a.eq("failed.reason=engine-unavailable", r.reason, "engine-unavailable")
    ctx.a.lte("failed 到达耗时 ms", failed.atMs - sentAtMs, 10_000)
    ctx.a.eq("引擎起不来时不许有 seen", ctx.probe.receipts("seen").length, 0)
    ctx.note("engine-down 故障行为档：引擎不起也必须给终态回执")
    return {
      mutation: { fault: "engine-down", expectedRed: false, note: "故障行为检查：变异下断言仍须全过" },
      events: mergeEvents(seat, ctx.probe, { "mesh.sent": 1 }),
      // 这一档**故意让 app-server 起不来**（这正是它要验的事），零 turn ⇒ rollout 不可能增长。
      // 主席位裁定：这种档写 real-idle（真引擎档位、设计上零 turn），不许写 none/fake 绕开举证。
      env: envIdle(kind), codexVersion: seat.engineInfo().codexVersion,
      instanceId: seat.state()?.instanceId ?? null,
      rolloutBytesBefore: before, rolloutBytesAfter: rolloutBytes(seat, kind),
    }
  }

  const seen = await ctx.probe.wait((r) => r.kind === "seen" && r.nonce === nonce, 30_000, "[seen]")
  ctx.a.lte("[seen] 自 send 返回起的墙钟 ms", seen.atMs - sentAtMs, 2000)

  // 等**终态**而不是只等 done：引擎真失败时（比如凭据不对）也要立刻现形，
  // 而不是傻等 180s 再报「超时」——那会把「配置错了」误诊成「慢」。
  const done = await ctx.probe.wait((r) => (r.kind === "done" || r.kind === "failed") && r.nonce === nonce, 180_000, "[done] 或 [failed]")
  ctx.a.eq("终态是 done 而不是 failed", done.receipt!.kind, "done")
  if (done.receipt!.kind !== "done") {
    ctx.note(`终态 failed: ${JSON.stringify(done.receipt)}`)
    return {
      mutation: null,
      events: mergeEvents(seat, ctx.probe, { "mesh.sent": 1 }),
      env: envFor(kind), codexVersion: seat.engineInfo().codexVersion,
      instanceId: seat.state()?.instanceId ?? null,
      rolloutBytesBefore: before, rolloutBytesAfter: rolloutBytes(seat, kind),
    }
  }
  const d = done.receipt as Extract<Receipt, { kind: "done" }>
  ctx.a.ok("[done] 正文含 nonce", d.body.includes(nonce), d.body.slice(0, 200), `包含 ${nonce}`)
  ctx.a.eq("[done] 署名是席位 nodeId", d.node, seat.nodeId)
  ctx.a.eq("seen 计数", ctx.probe.byNonce(nonce, "seen").length, 1)
  ctx.a.eq("done 计数", ctx.probe.byNonce(nonce, "done").length, 1)
  ctx.a.ok("seen 早于 done", seen.atMs <= done.atMs, { seen: seen.atMs, done: done.atMs }, "seen <= done")

  const nodes = await ctx.relay.client.nodes()
  const me = nodes.find((n) => n.nodeId === seat.nodeId)
  ctx.a.eq("relay 里该席位 deliveryMode", me?.deliveryMode, "pull")
  ctx.a.eq("relay 里该席位 role", me?.role, "main")

  const after = rolloutBytes(seat, kind)
  if (kind === "real") ctx.a.ok("rollout 字节增长（真引擎真跑过）", (after ?? 0) > (before ?? 0), { before, after }, "after > before")

  return {
    mutation: null,
    events: mergeEvents(seat, ctx.probe, { "mesh.sent": 1 }),
    env: envFor(kind), codexVersion: seat.engineInfo().codexVersion,
    instanceId: seat.state()?.instanceId ?? null,
    rolloutBytesBefore: before, rolloutBytesAfter: after,
  }
}
