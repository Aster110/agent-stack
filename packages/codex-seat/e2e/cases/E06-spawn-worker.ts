// E06 spawn 新 worker（真 relay + 真 codex）
//
// 阈值：[bootstrap][registered]/[ready] 均 ≤10s、顺序正确、from = worker nodeId；
//       relay 有该节点（pull、description 含 owner=<seat>）；state.workers 有它；
//       whoami-from：让 worker **不加任何 env 前缀**执行 `mesh send <probe> 'whoami nonce=W'`，
//                   探针收到的 from 必须等于 worker nodeId（决策 2 的硬证据）；
//       [ctl:close] 后 ≤3s relay 里没有它
// 变异：--mutate      红门 disable-thread-env-override → whoami 的 from ≠ worker（退化成 e2edev:relay 或干脆没有）
//       --mutate=fail 故障行为 fail-thread-start → ≤10s [failed] spawn-failed，无 bootstrap、relay 无新节点
//
// 安全前提：SeatProcess 把 MESH_RELAY_URL 指到私有 relay，worker 里的 `mesh send` 绝不会打到 :19800。

import type { Receipt } from "../../src/contracts.js"
import { engineFor, envFor, envIdle, mergeEvents, rolloutBytes, type CaseFn } from "../lib/case.js"
import { waitFor } from "../lib/util.js"

export const E06: CaseFn = async (ctx) => {
  const mode = ctx.mutate
  // --mutate=fail 档**故意一个模型 turn 都不跑**（fail-thread-start 在 sidecar 层就把
  // thread/start 拦下了），真引擎下 rollout 不可能增长。契约补了 real-idle 之后就不必再
  // 拿假引擎去绕：引擎照样是真的起，只是零 turn，证据如实写 appServer=real-idle。
  const kind = engineFor("real")
  const faults = mode === "" ? ["disable-thread-env-override"] : mode === "fail" ? ["fail-thread-start"] : []
  const seat = ctx.seat({ engine: kind, faults })
  await seat.start()
  const before = rolloutBytes(seat, kind)

  const n = `${ctx.nonce}s`
  const t0 = Date.now()
  await ctx.probe.send(seat.nodeId, `[ctl:spawn] role=worker cwd=${seat.cwd} agent=codex nonce=${n} desc=e2e worker`)

  if (mode === "fail") {
    const failed = await ctx.probe.wait((r) => r.kind === "failed" && r.nonce === n, 15_000, "[failed] spawn-failed")
    ctx.a.eq("failed.reason", (failed.receipt as Extract<Receipt, { kind: "failed" }>).reason, "spawn-failed")
    ctx.a.lte("spawn 失败回执耗时 ms", failed.atMs - t0, 10_000)
    ctx.a.eq("没有任何 bootstrap 回执", ctx.probe.receipts("bootstrap-registered").length + ctx.probe.receipts("bootstrap-ready").length, 0)
    const nodes = await ctx.relay.client.nodes()
    ctx.a.eq("relay 里没有多出 cx- 节点", nodes.filter((x) => x.shortId.startsWith("cx-")).length, 0)
    ctx.a.eq("state.workers 为空", Object.keys(seat.state()?.workers ?? {}).length, 0)
    return {
      mutation: { fault: "fail-thread-start", expectedRed: false, note: "故障行为：thread/start 挂了也要干净失败，不许留半个 worker" },
      events: mergeEvents(seat, ctx.probe, { "mesh.sent": 1 }),
      env: envIdle(kind), codexVersion: seat.engineInfo().codexVersion,
      instanceId: seat.state()?.instanceId ?? null,
      rolloutBytesBefore: before, rolloutBytesAfter: rolloutBytes(seat, kind),
    }
  }

  const regd = await ctx.probe.wait((r) => r.kind === "bootstrap-registered" && r.nonce === n, 30_000, "[bootstrap][registered]")
  const ready = await ctx.probe.wait((r) => r.kind === "bootstrap-ready" && r.nonce === n, 30_000, "[bootstrap][ready]")
  const worker = (regd.receipt as Extract<Receipt, { kind: "bootstrap-registered" }>).node
  ctx.a.lte("registered 耗时 ms", regd.atMs - t0, 10_000)
  ctx.a.lte("ready 耗时 ms", ready.atMs - t0, 10_000)
  ctx.a.ok("registered 早于 ready", regd.atMs <= ready.atMs, { regd: regd.atMs, ready: ready.atMs }, "registered <= ready")
  ctx.a.eq("两条 bootstrap 指同一个 worker", (ready.receipt as Extract<Receipt, { kind: "bootstrap-ready" }>).node, worker)
  ctx.a.eq("bootstrap 的 mesh from 署名 = worker nodeId", regd.msg.from, worker)
  ctx.a.match("worker nodeId 形态", worker, /^e2edev:cx-[0-9a-f]{4}$/)

  const nodes = await ctx.relay.client.nodes()
  const wn = nodes.find((x) => x.nodeId === worker)
  ctx.a.eq("relay 里 worker 的 deliveryMode", wn?.deliveryMode, "pull")
  ctx.a.match("relay 里 worker 的 description 含 owner", wn?.description ?? "", new RegExp(`owner=${seat.nodeId}`))
  ctx.a.ok("state.workers 里有它", Boolean(seat.state()?.workers?.[worker]), Object.keys(seat.state()?.workers ?? {}), [worker])

  // ---- whoami：决策 2 的硬证据 ----
  const w = `${ctx.nonce}w`
  if (kind === "real") {
    await ctx.probe.send(worker, [
      `请在 shell 里**原样**执行这一条命令（不要加任何环境变量前缀、不要改写）：`,
      `mesh send ${ctx.probe.nodeId} 'whoami nonce=${w}'`,
      `执行完只回复一行：sent`,
    ].join("\n"))
    let got: { from: string } | null = null
    try {
      const rec = await waitFor(
        () => ctx.probe.received.find((r) => r.msg.payload.includes(`whoami nonce=${w}`)),
        90_000, "worker 主动发来的 whoami", 100,
      )
      got = { from: rec.msg.from }
    } catch { /* 变异档预期收不到，或收到但署名不对 */ }
    ctx.a.eq("whoami 的 from = worker nodeId（per-thread MESH_NODE 生效）", got?.from ?? "(未收到)", worker)
  } else {
    // 假引擎不会真去跑 shell：退而求其次，断言 sidecar 真的把 MESH_NODE=<worker> 注进了 thread config。
    // 这是自报口径，强度不如 whoami，仅用于干跑管道；真引擎档以上面那条为准。
    const spawned = seat.logLines().filter((l) => l.event === "worker-spawned")
    ctx.a.eq("worker thread 的 config 覆盖里 MESH_NODE = worker nodeId", spawned.at(-1)?.meshNode ?? "(无)", worker)
    ctx.note("假引擎档：whoami 用日志里的 meshNode 代替（自报口径，强度低于真引擎的探针取证）")
  }

  // ---- ctl:close ----
  const c = `${ctx.nonce}c`
  const tClose = Date.now()
  await ctx.probe.send(seat.nodeId, `[ctl:close] node=${worker} nonce=${c}`)
  const closed = await ctx.probe.wait((r) => r.kind === "done" && r.nonce === c, 20_000, "close 的 done")
  ctx.a.eq("close 回执的 thread 字面量", (closed.receipt as Extract<Receipt, { kind: "done" }>).thread, "ctl")
  const gone = await waitFor(async () => {
    const ns = await ctx.relay.client.nodes()
    return !ns.some((x) => x.nodeId === worker)
  }, 5000, "relay 里 worker 消失", 100).then(() => Date.now() - tClose).catch(() => Number.POSITIVE_INFINITY)
  ctx.a.lte("close 到 relay 无该节点的 ms", gone, 3000)

  const after = rolloutBytes(seat, kind)
  return {
    mutation: mode === "" ? { fault: "disable-thread-env-override", expectedRed: true, note: "红门：不注 MESH_NODE，worker 的署名必然退化" } : null,
    events: mergeEvents(seat, ctx.probe, { "mesh.sent": 3 }),
    env: envFor(kind), codexVersion: seat.engineInfo().codexVersion,
    instanceId: seat.state()?.instanceId ?? null,
    rolloutBytesBefore: before, rolloutBytesAfter: after,
  }
}
