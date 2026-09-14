/**
 * E18 里的 E07 Linux 版：容器里没有真的 `systemd --user` 会话，
 * 用一个 shell 循环当 supervisor（`Restart=always` 的最小语义等价物），
 * 验「kill -9 之后进程被拉回来、nodeId/mainThreadId 不变」。
 *
 * ⚠️ 本机（computer2）无容器运行时 —— **只写不跑**。
 * 真 systemd 档走 `run-workstation.sh`（在测试设备上，需主席位授权）。
 */
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

import { parseReceipt } from "../../src/contracts.js"
import { Probe } from "../lib/probe.js"
import { startPrivateRelay } from "../lib/relay.js"
import {
  assertion,
  buildEvidence,
  cliMain,
  logEventCounts,
  makeSeatEnv,
  readState,
  reportAndExit,
  rolloutBytesFor,
  writeEvidence,
} from "../lib/script-case.js"
import { hex, sleep } from "../lib/util.js"

const RECOVER_BUDGET_MS = 60_000

/** shell 循环 supervisor：`while true; do node main.js run --seat X; sleep 5; done` */
function startShellSupervisor(home: string, seat: string, logFile: string) {
  const script = `while true; do "${process.execPath}" "${cliMain()}" run --seat ${seat} >>"${logFile}" 2>&1; sleep 5; done`
  const proc = spawn("/bin/sh", ["-c", script], {
    env: { ...process.env, HOME: home },
    stdio: "ignore",
    detached: true,
  })
  return {
    proc,
    stop() {
      try {
        if (proc.pid) process.kill(-proc.pid, "SIGKILL")
      } catch { /* 没了 */ }
    },
  }
}

export async function run(): Promise<number> {
  const startedAt = Date.now()
  const nonce = `E18-${hex(3)}`
  const assertions = []
  const events: Record<string, number> = {}
  let rolloutBefore = 0
  let rolloutAfter: number | null = null

  const relay = await startPrivateRelay()
  const env = makeSeatEnv(relay)
  const logFile = path.join(env.paths.logDir, "run.log")
  const sup = startShellSupervisor(env.home, env.seat, logFile)
  try {
    const probe = await Probe.start(relay.url)
    const gen1 = await (async () => {
      const deadline = Date.now() + 120_000
      while (Date.now() < deadline) {
        const s = readState(env)
        if (s?.mainThreadId) return s
        await sleep(500)
      }
      throw new Error("席位没起来")
    })()
    rolloutBefore = rolloutBytesFor(gen1.mainThreadId, env.config.codex.home ?? undefined) ?? 0
    await probe.send(env.nodeId, `请只回 ok。nonce=${nonce}-warm`)
    await probe.collect((a) => a.some((m) => parseReceipt(String(m.payload ?? ""))?.kind === "done"), 120_000)

    const pid1 = JSON.parse(fs.readFileSync(env.paths.sidecarPid, "utf-8")).pid as number
    process.kill(pid1, "SIGKILL")

    let gen2: any = null
    const t0 = Date.now()
    while (Date.now() - t0 < RECOVER_BUDGET_MS) {
      const s = readState(env)
      if (s?.instanceId && s.instanceId !== gen1.instanceId) {
        gen2 = s
        break
      }
      await sleep(1000)
    }
    assertions.push(assertion("≤60s 被 supervisor 拉回来（新 instanceId）", Boolean(gen2), gen2?.instanceId ?? null, "新的 instanceId"))
    assertions.push(assertion("nodeId 不变", gen2?.nodeId === gen1.nodeId, gen2?.nodeId ?? null, gen1.nodeId))
    assertions.push(assertion("mainThreadId 不变", gen2?.mainThreadId === gen1.mainThreadId, gen2?.mainThreadId ?? null, gen1.mainThreadId))

    if (gen2) {
      await probe.send(env.nodeId, `请只回 ok。nonce=${nonce}-2`)
      const all = await probe.collect((a) => a.filter((m) => parseReceipt(String(m.payload ?? ""))?.kind === "seen").length >= 2, 60_000)
      assertions.push(assertion("重启后 ping 收到 [seen]", all.filter((m) => parseReceipt(String(m.payload ?? ""))?.kind === "seen").length >= 2, "seen>=2", ">=2"))
    }
    rolloutAfter = rolloutBytesFor(gen1.mainThreadId, env.config.codex.home ?? undefined)
    Object.assign(events, logEventCounts(env))
  } catch (e) {
    assertions.push(assertion("跑完没抛异常", false, String((e as Error).message ?? e), "no throw"))
    Object.assign(events, logEventCounts(env))
  } finally {
    sup.stop()
    await relay.stop()
  }

  assertions.push(assertion("rollout 增长", rolloutAfter != null && rolloutAfter > rolloutBefore, { before: rolloutBefore, after: rolloutAfter }, "after > before"))
  const allPass = assertions.every((a) => a.pass)
  const rec = buildEvidence({
    caseId: "E18",
    nonce,
    startedAt,
    events,
    assertions,
    mutation: null,
    notes: `Linux 档（容器内 shell 循环代 systemd Restart=always）seat=${env.seat}`,
    env: { relay: "real", appServer: "real" },
    instanceId: readState(env)?.instanceId ?? null,
    codexVersion: readState(env)?.codexVersion ?? null,
    rolloutBytesBefore: rolloutBefore,
    rolloutBytesAfter: rolloutAfter,
    passed: allPass,
  })
  return reportAndExit(rec, writeEvidence(rec, "linux"))
}

if (require.main === module) {
  void run().then((c) => process.exit(c))
}
