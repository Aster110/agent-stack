// E21 复用 nodeId 不重放历史（真 relay + 假引擎）
//
// 现场复刻 2026-09-02 computer2 事故：同一个 nodeId 上已经躺着 30 条历史（含一条 [ctl:spawn]
// 控制消息和一条普通派单），然后**同名**新席位上线。事故当天它把 263 条历史当新派单执行了，
// 8 条消息进了真实节点，还起了一轮真 Computer Use。
//
// 阈值（主档，全部在「新席位起来后静置 4s」这一窗口内量）：
//   引擎 turn.started = 0；探针收到 0 条消息（非回执尤其是 0）；relay 上没有多出 cx-* worker；
//   state.cursor == 起席位前 relay 报的头；WAL 里没有 started（fetched 也不该有）
//   然后再发一条**新**消息必须正常 [done] —— 防止「靠把席位搞死来通过」的假绿
// 变异：--mutate=replayHistory（红门）= config.sync.replayHistory=true + fault disable-birth-age-gate
//   → 至少 1 条历史被投给引擎（实际是 29 条普通派单各起一轮 + 那条 ctl:spawn 真去拉 worker）
//
// 引擎用假的就够：要验的是「席位拉不拉历史」，跟模型是不是真的无关；真引擎只会让 30 条历史
// 在红门档烧掉半小时额度，换不来任何额外证据。

import fs from "node:fs"

import { E2E_DEVICE_ID } from "../lib/relay.js"
import type { WalEntry } from "../../src/contracts.js"
import { engineFor, envFor, mergeEvents, rolloutBytes, type CaseFn } from "../lib/case.js"
import { sleep, waitFor } from "../lib/util.js"

/** 历史条数：必须 > 熔断阈值 20，才能顺带证明「防线 1 正常时防线 3 根本轮不到触发」。 */
const HISTORY_N = 30
/** 静置观察窗：席位 sync.timeoutSec=5，4s 内它至少拨过一轮长轮询。 */
const QUIET_MS = 4000

function readWal(file: string): WalEntry[] {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as WalEntry)
  } catch {
    return [] // 一条都没写过时文件根本不存在——那正是主档期待的样子
  }
}

export const E21: CaseFn = async (ctx) => {
  const kind = engineFor("fake")
  const isMutate = ctx.mutate === "replayHistory"

  // 席位对象在 constructor 里就把名字与 config 定下来了（还没起进程）——
  // 拿到名字才能在它上线**之前**往同一个 nodeId 灌历史。
  const seat = ctx.seat({
    engine: kind,
    faults: isMutate ? ["disable-birth-age-gate"] : [],
    scenario: { defaultTurn: { startedAfterMs: 2, completeAfterMs: 5, outcome: { status: "completed", finalText: "不该被执行" } } },
    ...(isMutate
      ? { configPatch: { sync: { timeoutSec: 5, limit: 100, replayHistory: true } } }
      : {}),
  })
  const seatNodeId = `${E2E_DEVICE_ID}:${seat.seat}`

  // 1) 占位注册：这个 nodeId「以前就在 relay 上」（复用老名字的现场），
  //    /api/send 也只认在线节点。席位随后用同 shortId 重注册，收件箱与游标一并继承。
  await ctx.probe.client.register({ shortId: seat.seat, role: "main", description: "e2e 旧席位占位（同名 nodeId）", pid: process.pid })

  // 2) 灌历史：28 条普通派单 + 1 条 [ctl:spawn] 控制消息 + 1 条「像真派单」的正文。
  //    ctl:spawn 是最毒的一条——它不经模型、由 sidecar 直接执行，会真去 relay 上注册一个 worker。
  const ctlNonce = `${ctx.nonce}ctl`
  const dispatchNonce = `${ctx.nonce}job`
  for (let i = 1; i <= HISTORY_N - 2; i++) {
    await ctx.probe.send(seatNodeId, `旧派单 ${i}：只回复一行 ok nonce=${ctx.nonce}h${i}`)
  }
  await ctx.probe.send(seatNodeId, `[ctl:spawn] role=worker cwd=${seat.cwd} agent=codex nonce=${ctlNonce} desc=e2e 陈年 spawn`)
  await ctx.probe.send(seatNodeId, `请向 server:brain 报到并回执 nonce=${dispatchNonce}`)

  // 3) 起席位之前记下 relay 头（不传 since 的只读 sync：relay 不 ack，纯读）
  const headBefore = (await ctx.probe.client.sync({ nodeId: seatNodeId, timeoutSec: 0, limit: 500 })).nextSince
  ctx.a.gte("灌进去的历史条数（夹具自检：0 条的话本 case 什么也没测）", headBefore, HISTORY_N)

  // 4) 同名新席位上线
  await seat.start()
  const before = rolloutBytes(seat, kind)
  const probeBaseline = ctx.probe.received.length

  // 5) 静置观察窗：红门档会在这几秒里把历史一条条跑起来
  if (isMutate) {
    try { await waitFor(() => (seat.events()["turn.started"] ?? 0) >= 1, QUIET_MS, "红门档：历史被投给引擎") } catch { /* 没跑起来就让断言去红 */ }
  }
  await sleep(QUIET_MS)

  const events = seat.events()
  const wal = readWal(seat.paths.wal)
  const st = seat.state()
  const workerNodes = (await ctx.probe.client.nodes()).filter((n) => n.shortId.startsWith("cx-"))

  ctx.a.eq("引擎 turn.started 计数", events["turn.started"] ?? 0, 0)
  ctx.a.eq("探针收到的非回执消息数", ctx.probe.received.slice(probeBaseline).filter((r) => r.receipt == null).length, 0)
  ctx.a.eq("探针收到的消息总数（历史一条都不该产生回执）", ctx.probe.received.length - probeBaseline, 0)
  ctx.a.eq("陈年 [ctl:spawn] 没有真去拉 worker（relay 上的 cx-* 节点数）", workerNodes.length, 0)
  ctx.a.eq("state.cursor 锚在 relay 头", st?.cursor ?? null, headBefore)
  ctx.a.ok("state.cursorAnchoredAt 有值", Boolean(st?.cursorAnchoredAt), st?.cursorAnchoredAt ?? null, "非空 ISO")
  ctx.a.eq("WAL 里 started 条数", wal.filter((e) => e.op === "started").length, 0)
  ctx.a.eq("WAL 里 fetched 条数（历史连落盘都不该落）", wal.filter((e) => e.op === "fetched").length, 0)
  ctx.a.eq("席位没有被熔断（防线 1 生效时防线 3 根本轮不到）", st?.paused ?? null, null)

  // 6) 活性对照：**新**消息必须照常跑通。没有这一步，「把席位搞死」也能让上面全绿。
  const liveNonce = `${ctx.nonce}live`
  await ctx.probe.send(seat.nodeId, `新派单：只回复一行 ok nonce=${liveNonce}`)
  let liveMs = Number.POSITIVE_INFINITY
  const t0 = Date.now()
  try {
    await waitFor(() => ctx.probe.byNonce(liveNonce, "done").length > 0, 15_000, "[done] 活性对照")
    liveMs = Date.now() - t0
  } catch { /* 让断言去红 */ }
  ctx.a.lte("锚定之后新消息仍然通（[done] 耗时 ms）", liveMs, 15_000)
  ctx.a.eq("这一轮之后引擎 turn.started 恰为 1（只有那条新消息）", seat.events()["turn.started"] ?? 0, 1)

  ctx.note(`历史 ${HISTORY_N} 条（含 1 条 ctl:spawn）；relay 头 ${headBefore}；席位游标 ${String(st?.cursor)}`)
  return {
    mutation: isMutate
      ? {
        fault: "disable-birth-age-gate",
        expectedRed: true,
        note: "红门：config.sync.replayHistory=true + 关掉年龄闸 → 游标从 0 起、历史照投，turn.started ≥1 必红",
      }
      : null,
    // 零 turn 不是靠 events 空转蒙混：history.seeded / relay.head 是本次真跑出来的数量
    events: mergeEvents(seat, ctx.probe, { "history.seeded": HISTORY_N, "relay.head": headBefore }),
    env: envFor(kind),
    codexVersion: seat.engineInfo().codexVersion,
    instanceId: seat.state()?.instanceId ?? null,
    rolloutBytesBefore: before,
    rolloutBytesAfter: rolloutBytes(seat, kind),
  }
}
