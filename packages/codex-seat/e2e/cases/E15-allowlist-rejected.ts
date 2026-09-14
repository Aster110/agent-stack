// E15: registered internal peers are reachable; routing does not grant new user authority.
// Keep the filename for runner compatibility. The old allowlist mutation is retired.
import { MeshClient } from "../../src/mesh/mesh-client.js"
import type { Receipt } from "../../src/contracts.js"
import { engineFor, envFor, mergeEvents, rolloutBytes, type CaseFn } from "../lib/case.js"
import { hex, parseReceiptSafe, waitFor } from "../lib/util.js"

export const E15: CaseFn = async (ctx) => {
  if (ctx.mutate !== null) throw new Error("E15 旧名单变异已退役；请运行正常 E15，不支持 --mutate")
  const kind = engineFor("real")
  const n = `${ctx.nonce}x`
  const seat = ctx.seat({
    engine: kind,
    scenario: { defaultTurn: { completeAfterMs: 5, outcome: { status: "completed", finalText: n } } },
  })
  await seat.start()
  const before = rolloutBytes(seat, kind)
  const peer = new MeshClient(ctx.relay.url)
  const { nodeId: peerId } = await peer.register({
    shortId: `peer-${hex(2)}`, role: "worker", description: "e2e internal peer", pid: process.pid,
  })
  await peer.send({ from: peerId, to: seat.nodeId, message: `只回复 ${n}，无需执行其他动作。nonce=${n}` })
  const inbox: Array<Receipt | null> = []
  let cursor = 0
  await waitFor(async () => {
    const batch = await peer.sync({ nodeId: peerId, since: cursor, timeoutSec: 1, limit: 50 })
    for (const message of batch.messages) inbox.push(parseReceiptSafe(message.payload))
    cursor = batch.nextSince
    // An old-policy rejection is an assertion failure, not a misleading timeout.
    return inbox.some((r) => r && "nonce" in r && r.nonce === n && ["done", "failed", "rejected"].includes(r.kind))
  }, 60_000, "内部 peer 终态", 50)

  const events = seat.events()
  const done = inbox.filter((r): r is Extract<Receipt, { kind: "done" }> => r?.kind === "done" && r.nonce === n)
  ctx.a.eq("内部 peer 未被旧名单拒绝", inbox.filter((r) => r?.kind === "rejected").length, 0)
  ctx.a.eq("同一 nonce 完成一次", done.length, 1)
  ctx.a.ok("最终正文包含随机 nonce", done[0]?.body.includes(n) === true, done[0]?.body ?? null, n)
  ctx.a.ok("内部 sender 进入引擎", (events["turn.started"] ?? 0) >= 1, events["turn.started"] ?? 0, ">= 1")
  return {
    mutation: null, events: mergeEvents(seat, ctx.probe, { "mesh.sent": 1, "peer.received": inbox.length }),
    env: envFor(kind), codexVersion: seat.engineInfo().codexVersion,
    instanceId: seat.state()?.instanceId ?? null,
    rolloutBytesBefore: before, rolloutBytesAfter: rolloutBytes(seat, kind),
  }
}
