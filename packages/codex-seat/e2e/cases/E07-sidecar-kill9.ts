/**
 * E07 —— kill -9 sidecar，launchd 必须把它拉回来。
 *
 * 环境：私有 relay（随机端口 ≠19800）+ 真 codex + **真 launchd**，
 * 测试 label 恒为 `com.aster.codex-seat.e2e-<4hex>`（harness 里有硬校验，
 * 只要不是这个形状就拒绝执行），结束必 uninstall + bootout。
 * **绝不碰 com.aster.mesh-* 三个生产 job。**
 *
 * 数字：kill -9 之后 ≤60s 拿到新 instanceId；nodeId / mainThreadId 不变；ping 的 [seen] ≤2000ms。
 * 变异（external 红门）：先 `launchctl bootout` 再 kill -9 —— 席位必须**回不来**，
 * 否则说明「它是被别的什么东西拉起来的」，这个 case 根本没在测 launchd。
 */
import fs from "node:fs"
import path from "node:path"

import { extractNonce, parseReceipt } from "../../src/contracts.js"
import { readPidFile } from "../../src/proc/pidfile.js"
import { defaultSysProcOps } from "../../src/proc/ops.js"
import {
  assertNoE2ELaunchdLeftovers,
  launchdInstall,
  launchdBootout,
  launchdLoaded,
  launchdUninstall,
} from "../lib/launchd.js"
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
  writeEvidence,
} from "../lib/script-case.js"
import { hex, waitFor } from "../lib/util.js"

const SEEN_BUDGET_MS = 2000
const RECOVER_BUDGET_MS = 60_000

export async function run(argv: readonly string[]): Promise<number> {
  const mutate = parseMutateArg(argv)
  const startedAt = Date.now()
  const nonce = `E07-${hex(3)}`
  const assertions = []
  let notes = ""
  const events: Record<string, number> = {}

  const relay = await startPrivateRelay()
  const env = makeSeatEnv(relay)
  let installed = false
  let rolloutBefore = 0
  let rolloutAfter: number | null = null
  let threadId: string | null = null
  try {
    const probe = await Probe.start(relay.url)
    const inst = launchdInstall(env)
    installed = true
    process.stdout.write(`[E07] seat=${env.seat} label=${inst.label} relay=${relay.url}\n`)

    // 第一代起来：state 有 instanceId + mainThreadId，relay 里有节点
    const gen1 = await waitFor(() => {
      const s = readState(env)
      return s?.instanceId && s?.mainThreadId ? s : null
    }, RECOVER_BUDGET_MS, "第一代 sidecar 就绪", 500)
    const pid1 = readPidFile(env.paths.sidecarPid)?.pid ?? null
    threadId = gen1.mainThreadId
    rolloutBefore = rolloutBytesFor(threadId, env.config.codex.home ?? undefined) ?? 0
    process.stdout.write(`[E07] gen1 instanceId=${gen1.instanceId} thread=${gen1.mainThreadId} pid=${pid1} rollout=${rolloutBefore}\n`)

    // ping 1：从 send 返回 200 起算 [seen]
    const t0 = Date.now()
    await probe.send(env.nodeId, `请只回 ok。nonce=${nonce}-1`)
    const got1 = await probe.collect(
      (all) => all.some((m) => parseReceipt(String(m.payload ?? ""))?.kind === "seen"),
      15_000,
    )
    const seen1 = got1.find((m) => parseReceipt(String(m.payload ?? ""))?.kind === "seen")
    const seen1Ms = Date.now() - t0
    assertions.push(assertion("gen1 收到 [seen]", Boolean(seen1), Boolean(seen1), true))
    assertions.push(assertion("gen1 [seen] 用时 ≤2000ms", seen1Ms <= SEEN_BUDGET_MS, seen1Ms, `<=${SEEN_BUDGET_MS}`))

    if (mutate.on) {
      // 红门：把 launchd 那一环摘掉，席位就不该回来
      launchdBootout(env.seat)
      notes += "external mutation: launchctl bootout 后再 kill -9；"
    }

    if (!pid1) throw new Error("拿不到第一代 sidecar pid")
    defaultSysProcOps.kill(pid1, "SIGKILL")
    process.stdout.write(`[E07] kill -9 ${pid1}${mutate.on ? "（已先 bootout）" : ""}\n`)

    // ≤60s 拿到新一代
    let gen2: any = null
    const deadline = Date.now() + RECOVER_BUDGET_MS
    while (Date.now() < deadline) {
      const s = readState(env)
      if (s?.instanceId && s.instanceId !== gen1.instanceId) {
        gen2 = s
        break
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
    const recoverMs = Date.now() - (deadline - RECOVER_BUDGET_MS)
    process.stdout.write(`[E07] gen2=${gen2?.instanceId ?? "(没回来)"} 用时=${recoverMs}ms\n`)

    assertions.push(assertion("≤60s 换代（新 instanceId）", Boolean(gen2), gen2?.instanceId ?? null, "新的 instanceId"))
    assertions.push(assertion("nodeId 不变", gen2?.nodeId === gen1.nodeId, gen2?.nodeId ?? null, gen1.nodeId))
    assertions.push(assertion("mainThreadId 不变（记忆没丢）", gen2?.mainThreadId === gen1.mainThreadId, gen2?.mainThreadId ?? null, gen1.mainThreadId))

    if (gen2) {
      const t1 = Date.now()
      await probe.send(env.nodeId, `请只回 ok。nonce=${nonce}-2`)
      const got2 = await probe.collect(
        (all) => all.filter((m) => parseReceipt(String(m.payload ?? ""))?.kind === "seen").length >= 2,
        20_000,
      )
      const seen2 = got2.filter((m) => {
        const r = parseReceipt(String(m.payload ?? ""))
        return r?.kind === "seen" && extractNonce(String(m.payload), "") === `${nonce}-2`
      })
      const seen2Ms = Date.now() - t1
      assertions.push(assertion("gen2 收到 [seen]", seen2.length >= 1, seen2.length, ">=1"))
      assertions.push(assertion("gen2 [seen] 用时 ≤2000ms", seen2Ms <= SEEN_BUDGET_MS, seen2Ms, `<=${SEEN_BUDGET_MS}`))
    } else {
      assertions.push(assertion("gen2 收到 [seen]", false, "没有第二代", ">=1"))
    }

    Object.assign(events, logEventCounts(env))
    events["launchd.loaded"] = launchdLoaded(env.seat) ? 1 : 0
    events["gen1.ready"] = 1   // 恒非零：红门档下别的计数全是 0，会把「事件非空」这条证据判没
    rolloutAfter = rolloutBytesFor(threadId, env.config.codex.home ?? undefined)
  } catch (e) {
    notes += `异常: ${String((e as Error).message ?? e)}；`
    assertions.push(assertion("跑完没抛异常", false, String((e as Error).message ?? e), "no throw"))
    Object.assign(events, logEventCounts(env))
  } finally {
    if (installed) launchdUninstall(env)
    await relay.stop()
  }

  const leftovers = await assertNoE2ELaunchdLeftovers()
  assertions.push(assertion("收尾无 e2e launchd 残留", leftovers.length === 0, leftovers, []))

  assertions.push(assertion(
    "rollout 增长（模型真跑过）",
    rolloutAfter != null && rolloutAfter > rolloutBefore,
    { before: rolloutBefore, after: rolloutAfter }, "after > before",
  ))

  const allPass = assertions.every((a) => a.pass)
  const rec = buildEvidence({
    caseId: "E07",
    nonce,
    startedAt,
    events,
    assertions,
    mutation: mutate.on
      ? { fault: "external", expectedRed: true, actualRed: !allPass, note: "bootout 后 kill -9 必须回不来" }
      : null,
    notes: `${notes}seat=${env.seat} relay=${relay.url}`,
    env: { relay: "real", appServer: "real" },
    instanceId: readState(env)?.instanceId ?? null,
    codexVersion: readState(env)?.codexVersion ?? null,
    rolloutBytesBefore: rolloutBefore,
    rolloutBytesAfter: rolloutAfter,
    // 红门档：case 红才算通过
    passed: mutate.on ? !allPass : allPass,
  })
  const file = writeEvidence(rec, mutate.on ? (mutate.mode ?? "external") : null)
  cleanupTmp(env.home)
  return reportAndExit(rec, file)
}

function cleanupTmp(dir: string): void {
  try {
    if (dir.includes(path.sep + "codex-seat-home-")) fs.rmSync(dir, { recursive: true, force: true })
  } catch { /* 留着也无所谓 */ }
}

if (require.main === module) {
  void run(process.argv.slice(2)).then((c) => process.exit(c))
}
