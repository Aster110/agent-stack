// E12 僵尸对账（真 relay，可假引擎）
//
// 前置：relay 里预置 cx-dead（description owner=<被测席位>）与 cx-beef（owner=other），
//       并给席位预置一个 state.workers 里**真有**的 worker cx-live（也在 relay 里注册）
// 阈值：起席位后 ≤5s，cx-dead 被 DELETE、cx-beef 保留、cx-live 保留
// 变异：--mutate = disable-reconcile（红门）→ cx-dead 还在

import fs from "node:fs"

import { CONTRACT_VERSION, type StateFile } from "../../src/contracts.js"
import { E2E_DEVICE_ID } from "../lib/relay.js"
import { engineFor, envFor, mergeEvents, type CaseFn } from "../lib/case.js"
import { waitFor } from "../lib/util.js"

export const E12: CaseFn = async (ctx) => {
  const kind = engineFor("fake")
  const isMutate = ctx.mutate === ""
  const seat = ctx.seat({ engine: kind })
  const seatNodeId = `${E2E_DEVICE_ID}:${seat.seat}`

  // 预置三个 worker：两个僵尸候选 + 一个「state 里真有」的
  for (const [shortId, owner] of [
    ["cx-dead", seatNodeId],
    ["cx-beef", `${E2E_DEVICE_ID}:other-seat`],
    ["cx-live", seatNodeId],
  ] as const) {
    await ctx.probe.client.register({
      shortId, role: "worker",
      description: `codex-seat owner=${owner} delegator=${ctx.probe.nodeId}`,
      pid: process.pid,
    })
  }

  // state.json 预置 cx-live（有 thread 的真 worker，对账必须放过它）
  const liveNodeId = `${E2E_DEVICE_ID}:cx-live`
  const st: StateFile = {
    version: 1, contractVersion: CONTRACT_VERSION, seat: seat.seat, nodeId: seatNodeId, deviceId: E2E_DEVICE_ID,
    mainThreadId: null,
    workers: {
      [liveNodeId]: {
        nodeId: liveNodeId, threadId: "thread-live", role: "worker", delegator: ctx.probe.nodeId,
        cwd: seat.cwd, createdAt: new Date().toISOString(), procKind: "shared", agent: "codex", cursor: 0,
      },
    },
    cursor: 0, cursorAnchoredAt: new Date().toISOString(), cursorAnchorSeq: 0, paused: null,
    instanceId: "prev", createdAt: new Date().toISOString(), startedAt: new Date().toISOString(),
    lastSeenAt: null, lastDoneAt: null, recentMsgIds: [], codexVersion: null, engine: null,
    resumableThreads: ["thread-live"],
  }
  fs.writeFileSync(seat.paths.state, `${JSON.stringify(st, null, 2)}\n`)

  const t0 = Date.now()
  await seat.start({ faults: isMutate ? ["disable-reconcile"] : [] })

  const deadGoneMs = await waitFor(async () => {
    const ns = await ctx.relay.client.nodes()
    return ns.some((x) => x.shortId === "cx-dead") ? false : Date.now() - t0
  }, 5000, "cx-dead 被注销", 100).catch(() => Number.POSITIVE_INFINITY)

  const nodes = await ctx.relay.client.nodes()
  ctx.a.lte("cx-dead 被注销的耗时 ms", deadGoneMs, 5000)
  ctx.a.ok("cx-beef（别人的 worker）必须保留", nodes.some((x) => x.shortId === "cx-beef"), nodes.map((x) => x.shortId), "含 cx-beef")
  ctx.a.ok("cx-live（state 里真有的）必须保留", nodes.some((x) => x.shortId === "cx-live"), nodes.map((x) => x.shortId), "含 cx-live")
  ctx.a.ok("state.workers 里 cx-live 还在", Boolean(seat.state()?.workers?.[liveNodeId]), Object.keys(seat.state()?.workers ?? {}), [liveNodeId])

  return {
    mutation: isMutate ? { fault: "disable-reconcile", expectedRed: true, note: "红门：不对账，僵尸必然留着" } : null,
    events: mergeEvents(seat, ctx.probe, { "relay.nodes": nodes.length }),
    env: envFor(kind), codexVersion: seat.engineInfo().codexVersion,
    instanceId: seat.state()?.instanceId ?? null,
    rolloutBytesBefore: null, rolloutBytesAfter: null,
  }
}
