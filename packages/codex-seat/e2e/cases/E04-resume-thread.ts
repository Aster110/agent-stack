// E04 续旧对话（真 relay + 真 codex）
//
// 步骤：msg1 埋 8 位随机暗号 A → done；SIGKILL 席位 → 重启 → msg2 问暗号 → done 正文含 A
// 阈值：暗号不区分大小写子串命中；state.mainThreadId 前后相同；resume opMs ≤ 100
// 变异：--mutate = fresh-thread-on-restart（红门）→ 重启开新 thread，答不出 A
//
// 档位说明：本 case **只有真引擎档**。Lane A 的假引擎不跨进程留记忆，用它跑等于自证。

import { randomBytes } from "node:crypto"

import type { Receipt } from "../../src/contracts.js"
import { engineFor, envFor, mergeEvents, rolloutBytes, type CaseFn } from "../lib/case.js"

export const E04: CaseFn = async (ctx) => {
  // 只有真引擎档才有「跨进程还记得暗号」这回事——Lane A 的假引擎不留记忆，
  // 所以这个 case 不提供假引擎干跑档（跑了也只是自证）。
  const kind = engineFor("real")
  const isMutate = ctx.mutate === ""
  const secret = randomBytes(4).toString("hex").toUpperCase()   // 8 位
  const seat = ctx.seat({ engine: kind })
  // 被 CODEX_SEAT_E2E_ENGINE=fake 强降级时要一眼看出「不是代码坏了，是这个 case 只有真引擎档」
  ctx.a.ok("本 case 需要真引擎（假引擎没有跨进程记忆，验不了续对话）", kind === "real", kind, "real")

  await seat.start({ faults: isMutate ? ["fresh-thread-on-restart"] : [] })
  const before = rolloutBytes(seat, kind)

  const n1 = `${ctx.nonce}a`
  await ctx.probe.send(seat.nodeId, `记住这个暗号：${secret}。只回复一行：ok nonce=${n1}`)
  await ctx.probe.wait((r) => r.kind === "done" && r.nonce === n1, 180_000, "第一条 done")
  const threadBefore = seat.state()?.mainThreadId ?? null
  ctx.a.ok("第一条之后 mainThreadId 已落盘", threadBefore != null, threadBefore, "非 null")

  await seat.kill9()
  ctx.note("SIGKILL 席位后重启，验 thread/resume 续接")
  await seat.start({ faults: isMutate ? ["fresh-thread-on-restart"] : [] })

  const n2 = `${ctx.nonce}b`
  await ctx.probe.send(seat.nodeId, `我刚才让你记的暗号是什么？只回复暗号本身，带上 nonce=${n2}`)
  const done2 = await ctx.probe.wait((r) => r.kind === "done" && r.nonce === n2, 180_000, "第二条 done")
  const body = (done2.receipt as Extract<Receipt, { kind: "done" }>).body
  ctx.a.ok("重启后仍答得出暗号", body.toLowerCase().includes(secret.toLowerCase()), body.slice(0, 200), `包含 ${secret}`)

  const threadAfter = seat.state()?.mainThreadId ?? null
  ctx.a.eq("mainThreadId 前后相同", threadAfter, threadBefore)

  const resumed = seat.logLines().filter((l) => l.event === "thread-resumed")
  const opMs = resumed.length > 0 ? Number(resumed.at(-1)!.opMs ?? -1) : -1
  ctx.a.ok("重启后走的是 thread/resume", resumed.length >= 1, resumed.length, ">= 1")
  // 主席位裁定 2：重启后的这次 resume 天生是冷的（app-server 刚起、MCP 可能还在启动），
  // 没法先预热再计时，所以这里只设「没卡死」的粗上界，精确的 46ms 基线由 A 的 E01 在热态下守。
  ctx.a.lte("thread/resume opMs（冷启粗上界，精确基线归 E01）", opMs, 5000)
  ctx.note(`resume opMs=${opMs}（冷启，未预热）`)

  const after = rolloutBytes(seat, kind)
  return {
    mutation: isMutate ? { fault: "fresh-thread-on-restart", expectedRed: true, note: "红门：重启开新 thread 就必须答不出暗号" } : null,
    events: mergeEvents(seat, ctx.probe, { "mesh.sent": 2 }),
    env: envFor(kind), codexVersion: seat.engineInfo().codexVersion,
    instanceId: seat.state()?.instanceId ?? null,
    rolloutBytesBefore: before, rolloutBytesAfter: after,
  }
}
