// E03 游标不重放不丢（真 relay + 假引擎）
//
// 前置：先把席位的 shortId 占上（让 /api/send 认它在线）→ 一次性投 5 条 → 再起席位，
//       保证 5 条落在**同一批** sync 里，崩溃点因此是确定的（k=5），不是碰运气。
// 阈值：5 个 done、5 个互不相同的 nonce、每个 nonce 恰 1 seen 1 done，≤120s
// 变异：
//   --mutate            红门 crash-after-ack-before-started,disable-wal-replay → done<5
//   --mutate=dedup      红门 crash-after-fetch-before-ack,disable-msgid-dedup  → done>5 或 nonce 重复
//   --mutate=resilience 故障行为 crash-after-ack-before-started → 重启后仍然 5/5

import { E2E_DEVICE_ID } from "../lib/relay.js"
import { engineFor, envFor, mergeEvents, rolloutBytes, type CaseFn } from "../lib/case.js"
import { waitFor } from "../lib/util.js"

const N = 5

export const E03: CaseFn = async (ctx) => {
  // 主席位 2026-09-02 裁定：本档「假引擎档即可」。要验的三件事（WAL 先写后 ack、
  // 重放、msgId 去重）全在 sidecar 层，跟模型是不是真的无关；4 个档 ×5 条消息用真引擎
  // 要烧 20 轮，占掉全轮预算的近一半，换不来任何额外证据。
  const kind = engineFor("fake")
  const mode = ctx.mutate
  const faults =
    mode === "" ? ["crash-after-ack-before-started", "disable-wal-replay"]
      : mode === "dedup" ? ["crash-after-fetch-before-ack", "disable-msgid-dedup"]
        : mode === "resilience" ? ["crash-after-ack-before-started"]
          : []
  // 重启那一代不能再带崩溃故障（否则永远起不来）；行为类故障必须留着，否则红门测不到东西。
  const restartFaults = faults.filter((f) => !f.startsWith("crash-"))

  const nonces = Array.from({ length: N }, (_, i) => `${ctx.nonce}n${i + 1}`)
  const seat = ctx.seat({
    engine: kind,
    scenario: { defaultTurn: { completeAfterMs: 5, outcome: { status: "completed", finalText: "ok" } } },
    // 本档的夹具**故意**把 5 条消息投在席位起来之前（要它们落在同一批，崩溃点才确定）。
    // 防重放三道防线（2026-09-02 computer2 事故后）默认会把这种「比席位还老的历史」整段跳过，
    // 于是这里必须显式开两个开关：这正是它们存在的意义——重放历史只能是**明说**的选择。
    // 关掉它们不影响本档要验的东西（WAL 先写后 ack / 重放 / msgId 去重全在闸之后）。
    configPatch: { sync: { timeoutSec: 5, limit: 100, replayHistory: true, acceptMessagesOlderThanSeat: true } },
  })
  const seatNodeId = `${E2E_DEVICE_ID}:${seat.seat}`

  // 先占位注册：/api/send 只认在线节点。席位随后用同 shortId 重注册，收件箱与游标都继承。
  await ctx.probe.client.register({ shortId: seat.seat, role: "main", description: "e2e placeholder", pid: process.pid })
  for (const n of nonces) {
    await ctx.probe.send(seatNodeId, `任务 nonce=${n} —— 只回复一行：ok ${n}`)
  }

  await seat.start({ faults })
  if (faults.some((f) => f.startsWith("crash-"))) {
    const code = await seat.waitExit(30_000)
    ctx.a.ok("故障注入让席位真的崩了（exit 70/71）", code === 70 || code === 71, code, "70 或 71")
    ctx.note(`崩溃退出码 ${code}，随后以 faults=[${restartFaults.join(",")}] 重启一次`)
    await seat.start({ faults: restartFaults })
  }
  const before = rolloutBytes(seat, kind)

  // 等到 5 个 done 或超时；红门档就是要它等不满。
  const deadlineMs = 120_000
  try {
    await waitFor(() => ctx.probe.receipts("done").length >= N, deadlineMs, `${N} 个 done`, 100)
  } catch { /* 红门档预期在这里超时 */ }

  const doneReceipts = ctx.probe.receipts("done")
  const doneNonces = doneReceipts.map((r) => ("nonce" in r ? r.nonce : ""))
  const uniq = new Set(doneNonces)
  ctx.a.eq("done 总数", doneReceipts.length, N)
  ctx.a.eq("互不相同的 done nonce 数", uniq.size, N)
  for (const n of nonces) {
    ctx.a.eq(`nonce=${n} 的 done 计数`, ctx.probe.byNonce(n, "done").length, 1)
    ctx.a.eq(`nonce=${n} 的 seen 计数`, ctx.probe.byNonce(n, "seen").length, 1)
  }

  const after = rolloutBytes(seat, kind)
  const mutation = mode == null ? null : {
    fault: faults.join(","),
    expectedRed: mode === "" || mode === "dedup",
    note: mode === "resilience" ? "故障行为：崩了也要靠 WAL 补回 5/5" : "红门：变异必须让 done 数对不上",
  }
  return {
    mutation,
    events: mergeEvents(seat, ctx.probe, { "mesh.sent": N }),
    env: envFor(kind), codexVersion: seat.engineInfo().codexVersion,
    instanceId: seat.state()?.instanceId ?? null,
    rolloutBytesBefore: before, rolloutBytesAfter: after,
  }
}
