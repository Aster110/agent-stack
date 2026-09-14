/**
 * E08 —— 杀 rust 本体，引擎必须自己回来且**不留孤儿**。
 *
 * 为什么这个 case 存在：`/opt/homebrew/bin/codex` 是 node wrapper 包着 rust 本体
 * （实测 `ps` 里两行同 pgid，rust 的 ppid = wrapper）。只杀 wrapper 会把本体留成 ppid=1 的孤儿，
 * 它还抓着 `~/.codex/thread-writer-locks/<threadId>.lock`。所以停引擎永远 `kill(-pgid)`。
 *
 * 实测坑（2026-09-02 本 case 抓出来的，写给 Lane A/B）：
 *   `thread/resume` 在该 thread **一轮都没跑过**时会失败：`no rollout found for thread id <id>`。
 *   rollout 文件是第一轮才落盘的。所以本 case 必须**先 ping 一轮**再杀引擎，
 *   否则「重启后 mainThreadId 不变」这条断言必然红，而且红的原因跟进程管理毫无关系。
 *
 * 又一个实测事实（第一版 case 被它坑过）：**我们自己起的引擎，只杀 wrapper 是杀得死本体的** ——
 * sidecar 持着 stdio 管道，wrapper 一死 node 把管道关了，本体收到 EOF 自己退。
 * 所以要造出真孤儿，必须让本体的 stdin 永远不 EOF（`plantOrphanAppServer` 用一个读写都打开的 FIFO）。
 * 这条很重要：拿「只杀 wrapper」当造孤儿手段而不验证，会得到一个永远绿、什么也没测的 case。
 *
 * 谓词的**阳性对照**（这把尺子量得出东西）：种一个 FIFO 撑住的真孤儿，
 * 证明 `findOrphans()` 抓得到它、`sweepOrphans()` 清得掉它，再去断言「现在没有孤儿」。
 *
 * 「哪一代引擎在跑」一律读 **app-server.pid 文件**，不读 `state.json.engine` ——
 * 实测 Lane B 的席位核心只在 `start()` 时写一次 `st.engine`，引擎中途重启不回填，
 * 拿 state 当判据会得到「引擎没回来」的假红（这条已在报告里作为集成缺口提出）。
 * pid 文件是引擎层每次 spawn 都写的，是这一层的真事实源。
 *
 * 数字：杀本体后 ≤20s 引擎重启且 pgid 变化；旧 pgid 组清空；孤儿 ≤30s 清零；ping 通。
 * 变异：
 *   `--mutate`       = 谓词/清扫的阳性对照（expectedRed=false，全部断言仍须过）
 *   `--mutate=sweep` = `disable-orphan-sweep` 红门：种真孤儿后引擎重启，sidecar 不清 → 30s 后孤儿仍在 → 必须红
 */
import fs from "node:fs"
import path from "node:path"

import { parseReceipt } from "../../src/contracts.js"
import { readPidFile } from "../../src/proc/pidfile.js"
import { defaultSysProcOps } from "../../src/proc/ops.js"
import { findOrphans, isOurAppServerCmd, CHATGPT_APP_MARKER, seatTagPrefix } from "../../src/proc/orphans.js"
import { sweepOrphans } from "../../src/proc/orphans.js"
import { stopProcessGroup } from "../../src/proc/group.js"
import { plantOrphanAppServer } from "../lib/orphan.js"
import { Probe } from "../lib/probe.js"
import { startPrivateRelay } from "../lib/relay.js"
import {
  assertion,
  buildEvidence,
  logEventCounts,
  makeSeatEnv,
  parseMutateArg,
  readState,
  reportAndExit,
  rolloutBytesFor,
  startSeatProcess,
  writeEvidence,
} from "../lib/script-case.js"
import { hex, sleep, waitFor } from "../lib/util.js"

const RESTART_BUDGET_MS = 20_000
const ORPHAN_CLEAR_BUDGET_MS = 30_000

export async function run(argv: readonly string[]): Promise<number> {
  const mutate = parseMutateArg(argv)
  const mode = mutate.on ? (mutate.mode ?? "control") : null
  const isSweepGate = mode === "sweep"
  const fault = isSweepGate ? "disable-orphan-sweep" : null
  const startedAt = Date.now()
  const nonce = `E08-${hex(3)}`
  const assertions = []
  const events: Record<string, number> = {}
  let notes = ""
  let rolloutBefore = 0
  let rolloutAfter: number | null = null

  const relay = await startPrivateRelay()
  const env = makeSeatEnv(relay)
  const seat = startSeatProcess(env, fault ? { CODEX_SEAT_ALLOW_FAULTS: "1", CODEX_SEAT_FAULT: fault } : {})
  try {
    const probe = await Probe.start(relay.url)
    const gen1 = await waitFor(() => {
      const s = readState(env)
      const pf = readPidFile(env.paths.appServerPid)
      return pf?.pgid && s?.mainThreadId ? { state: s, pgid: pf.pgid } : null
    }, 90_000, "引擎第一代就绪", 500)
    const pgid1: number = gen1.pgid
    const thread1: string = gen1.state.mainThreadId
    process.stdout.write(`[E08] seat=${env.seat} pgid1=${pgid1} thread=${thread1} mode=${mode ?? "-"}\n`)

    // ── 先跑一轮：让 thread 有 rollout，重启后 resume 才可能成功 ──────────
    await probe.send(env.nodeId, `请只回 ok。nonce=${nonce}-warm`)
    await probe.collect((a) => a.some((m) => parseReceipt(String(m.payload ?? ""))?.kind === "done"), 90_000)
    rolloutBefore = rolloutBytesFor(thread1, env.config.codex.home ?? undefined) ?? 0
    assertions.push(assertion("热身轮之后 rollout 已落盘（resume 的前提）", rolloutBefore > 0, rolloutBefore, ">0"))

    // ── 谓词阳性对照 ───────────────────────────────────────────────────────
    // 注意：判据是**席位标签**，不是二进制路径 —— mini/computer1 的 codex.bin 就指 ChatGPT.app 内置的 codex，
    // 那种机器上「我们的进程」自己就带 ChatGPT.app 路径。要保护的从来只是**没有我方标签**的那些。
    const live = findOrphans({ seat: env.seat, ops: defaultSysProcOps, excludePgid: null, excludePids: [] })
    const tag = seatTagPrefix(env.seat)
    const chatgptHits = live.filter((o) => o.cmd.includes(CHATGPT_APP_MARKER) && !o.cmd.includes(tag))
    assertions.push(assertion("阳性对照：谓词认得出运行中的本席位 app-server", live.length >= 1, live.length, ">=1"))
    assertions.push(assertion("阳性对照：命中里没有无标签的 ChatGPT.app 进程", chatgptHits.length === 0, chatgptHits.map((x) => x.pid), []))
    events["orphan.predicate.positiveControl"] = live.length
    events["gen1.ready"] = 1

    const chatgptRunning = defaultSysProcOps.list()
      .filter((p) => p.command.includes(CHATGPT_APP_MARKER) && p.command.includes("app-server") && !p.command.includes(tag))
    events["chatgpt.appserver.present"] = chatgptRunning.length
    for (const c of chatgptRunning) {
      assertions.push(assertion(
        `ChatGPT.app pid=${c.pid}（无我方标签）不被我们的谓词认领`,
        !isOurAppServerCmd(c.command, env.seat), false, false,
      ))
    }

    // ── 阳性对照：种一个 FIFO 撑住的真孤儿，证明谓词抓得到、清扫清得掉 ──────
    let planted: { pgid: number; wrapperPid: number; fifo: string } | null = null
    if (mode === "control" || isSweepGate) {
      planted = plantOrphanAppServer(env.seat, env.cwd)
      await sleep(3000)
      const before = defaultSysProcOps.list().filter((p) => p.pgid === planted!.pgid)
      assertions.push(assertion("对照组起来了（wrapper + rust 本体）", before.length >= 2, before.length, ">=2"))
      // 只杀 wrapper —— 本体 stdin 接在读写都开的 FIFO 上，永远不 EOF，于是活成孤儿
      defaultSysProcOps.kill(planted.wrapperPid, "SIGKILL")
      const orphan = await waitFor(() => {
        const o = findOrphans({ seat: env.seat, ops: defaultSysProcOps, excludePgid: pgid1, excludePids: [] })
          .filter((x) => x.pgid === planted!.pgid)
        return o.length >= 1 ? o : null
      }, 10_000, "对照组孤儿出现", 200).catch(() => [] as any[])
      assertions.push(assertion("阳性对照：谓词抓到活着的孤儿本体（尺子量得出东西）", orphan.length >= 1, orphan.length, ">=1"))
      events["orphan.control.caught"] = orphan.length

      if (mode === "control") {
        const sw = await sweepOrphans({ seat: env.seat, ops: defaultSysProcOps, excludePgid: pgid1, excludePids: [], graceMs: 500 })
        assertions.push(assertion("阳性对照：清扫之后对照组孤儿归零", sw.survivors.filter((x) => x.pgid === planted!.pgid).length === 0, sw.survivors.map((x) => x.pid), []))
        events["orphan.control.swept"] = sw.swept.length
        notes += "阳性对照：FIFO 撑住 stdin 种真孤儿 → 谓词抓到 → 清扫归零；"
      } else {
        notes += "红门：种真孤儿后靠引擎重启触发清扫，而清扫被 disable-orphan-sweep 关掉 → 孤儿必须留着；"
      }
    }

    // ── 动手 ───────────────────────────────────────────────────────────────
    const groupBefore = defaultSysProcOps.list().filter((p) => p.pgid === pgid1)
    const rust = groupBefore.find((p) => !/(^|\/)node\s/.test(p.command) && p.command.includes("app-server"))
    const wrapper = groupBefore.find((p) => /(^|\/)node\s/.test(p.command))
    process.stdout.write(`[E08] 组内 ${groupBefore.length} 个进程，rust=${rust?.pid ?? "?"} wrapper=${wrapper?.pid ?? "?"}\n`)
    assertions.push(assertion("进程组里能找到 rust 本体（非 node wrapper）", Boolean(rust), rust?.pid ?? null, "pid"))

    if (rust) {
      // 无论哪档都杀本体：这是 case 的主动作（引擎必须自己回来）
      defaultSysProcOps.kill(rust.pid, "SIGKILL")
      notes += `杀 rust 本体 pid=${rust.pid}；`
    }
    void wrapper

    // ── 恢复 ───────────────────────────────────────────────────────────────
    let pgid2: number | null = null
    const t0 = Date.now()
    while (Date.now() - t0 < RESTART_BUDGET_MS) {
      const pf = readPidFile(env.paths.appServerPid)
      if (pf?.pgid && pf.pgid !== pgid1 && defaultSysProcOps.isAlive(pf.pid)) {
        pgid2 = pf.pgid
        break
      }
      await sleep(500)
    }
    const restartMs = Date.now() - t0
    process.stdout.write(`[E08] 引擎重启 ${pgid2 ? `pgid=${pgid2} 用时=${restartMs}ms` : "（没回来）"}\n`)
    assertions.push(assertion("≤20s 引擎重启且 pgid 变化", Boolean(pgid2), pgid2, `!= ${pgid1}`))
    const threadAfter = readState(env)?.mainThreadId ?? null
    assertions.push(assertion("mainThreadId 不变（resume 续上）", threadAfter === thread1, threadAfter, thread1))

    const oldGroup = defaultSysProcOps.list().filter((p) => p.pgid === pgid1)
    assertions.push(assertion("旧 pgid 组已空（无 ppid=1 的 app-server 孤儿）", oldGroup.length === 0, oldGroup.map((p) => p.pid), []))

    const deadline = Date.now() + ORPHAN_CLEAR_BUDGET_MS
    let remaining = findOrphans({ seat: env.seat, ops: defaultSysProcOps, excludePgid: pgid2, excludePids: [] })
    while (Date.now() < deadline && remaining.length > 0) {
      await sleep(1000)
      remaining = findOrphans({ seat: env.seat, ops: defaultSysProcOps, excludePgid: pgid2, excludePids: [] })
    }
    events["orphan.remaining"] = remaining.length
    assertions.push(assertion("≤30s 孤儿清零", remaining.length === 0, remaining.map((o) => o.pid), []))

    if (pgid2) {
      await probe.send(env.nodeId, `请只回 ok。nonce=${nonce}`)
      const all = await probe.collect((a) => a.filter((m) => parseReceipt(String(m.payload ?? ""))?.kind === "seen").length >= 2, 40_000)
      const seen = all.filter((m) => parseReceipt(String(m.payload ?? ""))?.kind === "seen")
      assertions.push(assertion("重启后 ping 收到 [seen]", seen.length >= 2, seen.length, ">=2"))
    }

    rolloutAfter = rolloutBytesFor(readState(env)?.mainThreadId ?? thread1, env.config.codex.home ?? undefined)
    Object.assign(events, logEventCounts(env))
  } catch (e) {
    notes += `异常: ${String((e as Error).message ?? e)}；`
    assertions.push(assertion("跑完没抛异常", false, String((e as Error).message ?? e), "no throw"))
    Object.assign(events, logEventCounts(env))
  } finally {
    seat.stop()
    await sleep(2000)
    // 兜底：本席位标签的残留全清（含种下的对照孤儿；谓词只认自己的，不会误伤 ChatGPT）
    try {
      await sweepOrphans({ seat: env.seat, ops: defaultSysProcOps, excludePgid: null, excludePids: [], graceMs: 500 })
    } catch { /* ignore */ }
    await relay.stop()
  }

  assertions.push(assertion(
    "rollout 增长（模型真跑过）",
    rolloutAfter != null && rolloutAfter > rolloutBefore,
    { before: rolloutBefore, after: rolloutAfter }, "after > before",
  ))

  const allPass = assertions.every((a) => a.pass)
  const rec = buildEvidence({
    caseId: "E08",
    nonce,
    startedAt,
    events,
    assertions,
    mutation: mode
      ? {
          fault: fault ?? "external",
          expectedRed: isSweepGate,
          actualRed: !allPass,
          note: isSweepGate ? "关掉孤儿清扫，孤儿必须留着 → case 必须红" : "谓词/清扫的阳性对照，全部断言仍须过",
        }
      : null,
    notes: `${notes}seat=${env.seat}`,
    env: { relay: "real", appServer: "real" },
    instanceId: readState(env)?.instanceId ?? null,
    codexVersion: readState(env)?.codexVersion ?? null,
    rolloutBytesBefore: rolloutBefore,
    rolloutBytesAfter: rolloutAfter,
    passed: isSweepGate ? !allPass : allPass,
  })
  const file = writeEvidence(rec, mode)
  return reportAndExit(rec, file)
}

if (require.main === module) {
  void run(process.argv.slice(2)).then((c) => process.exit(c))
}
