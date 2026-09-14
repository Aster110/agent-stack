/**
 * E09 —— tmux kill-server 对新席位零影响。
 *
 * 背景：2026-08-28 全灭事故的结构成因是「席位和 relay 共用同一台 tmux server，谁掀了 server 谁全灭」
 * （P62 bugs/席位被测试前缀通杀.md）。app-server 席位根本不住 tmux —— 本 case 就是把这件事钉死。
 *
 * 🔴 隔离红线：整场只用**私有 tmux server**（`tmux -L e2e-<4hex>`）。
 *    **绝不对默认 server 执行 kill-server** —— relay 和现有席位都在那台上。
 *    脚本里凡是 tmux 调用都强制带 `-L`，并且在执行 kill-server 前硬校验 socket 名是 e2e- 前缀。
 *
 * 阳性对照：私有 server 里先起一个一次性会话。kill-server 之后
 *   · 对照会话必须**死**（证明这一刀真的落下去了，不是打空气）
 *   · 席位 ping 的 [seen] ≤2000ms、sidecar pid 不变（证明它跟 tmux 无关）
 * 没有对照，「席位还活着」什么也证明不了 —— 可能压根没杀成。
 */
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

import { parseReceipt } from "../../src/contracts.js"
import { readPidFile } from "../../src/proc/pidfile.js"
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
// 护栏函数（强制 -L + socket 名硬校验）住在 lib/tmux.ts；
// 本文件里读默认 server 的 execFileSync 是**只读对照**，故意不走护栏，留在原地。
import { tmux } from "../lib/tmux.js"
import { hex, sleep, waitFor } from "../lib/util.js"

const SEEN_BUDGET_MS = 2000

export async function run(argv: readonly string[]): Promise<number> {
  const mutate = parseMutateArg(argv)
  const startedAt = Date.now()
  const nonce = `E09-${hex(3)}`
  const assertions = []
  const events: Record<string, number> = {}
  let notes = ""
  const socket = `e2e-${hex(2)}`
  let rolloutBefore = 0
  let rolloutAfter: number | null = null

  const relay = await startPrivateRelay()
  const env = makeSeatEnv(relay)
  const seat = startSeatProcess(env)
  try {
    const probe = await Probe.start(relay.url)
    const st1 = await waitFor(() => {
      const s = readState(env)
      return s?.mainThreadId ? s : null
    }, 90_000, "席位就绪", 500)
    const pidBefore = readPidFile(env.paths.sidecarPid)?.pid ?? null
    rolloutBefore = rolloutBytesFor(st1.mainThreadId, env.config.codex.home ?? undefined) ?? 0
    process.stdout.write(`[E09] seat=${env.seat} sidecarPid=${pidBefore} tmuxSocket=${socket}\n`)

    // ── 阳性对照：私有 server 上的一次性会话 ─────────────────────────────
    const control = `oneshot-${hex(2)}`
    tmux(socket, ["new-session", "-d", "-s", control, "sleep 600"], false)
    const listedBefore = tmux(socket, ["list-sessions", "-F", "#{session_name}"])
    assertions.push(assertion("阳性对照会话建起来了", listedBefore.includes(control), listedBefore, `含 ${control}`))
    events["tmux.control.sessions.before"] = listedBefore.split("\n").filter(Boolean).length

    // 默认 server 的现状留证（只读，不动它）
    let defaultSessions = ""
    try {
      defaultSessions = execFileSync("tmux", ["list-sessions", "-F", "#{session_name}"], { encoding: "utf-8", timeout: 10_000 }).trim()
    } catch {
      defaultSessions = ""
    }
    const defaultBefore = defaultSessions.split("\n").filter(Boolean)
    events["tmux.default.sessions.before"] = defaultBefore.length

    // ── 掀私有 server ────────────────────────────────────────────────────
    tmux(socket, ["kill-server"])
    await sleep(1500)
    const listedAfter = tmux(socket, ["list-sessions", "-F", "#{session_name}"])
    const controlDead = !listedAfter.includes(control)
    assertions.push(assertion("阳性对照：一次性会话被 kill-server 干掉了（这一刀真落下去了）", controlDead, listedAfter.slice(0, 120), `不含 ${control}`))
    events["tmux.control.dead"] = controlDead ? 1 : 0

    // ── 席位毫发无损 ─────────────────────────────────────────────────────
    const pidAfter = readPidFile(env.paths.sidecarPid)?.pid ?? null
    assertions.push(assertion("sidecar pid 不变（席位不住 tmux）", pidAfter === pidBefore && pidAfter != null, pidAfter, pidBefore))

    const t0 = Date.now()
    await probe.send(env.nodeId, `请只回 ok。nonce=${nonce}`)
    const all = await probe.collect((a) => a.some((m) => parseReceipt(String(m.payload ?? ""))?.kind === "seen"), 20_000)
    const seen = all.filter((m) => parseReceipt(String(m.payload ?? ""))?.kind === "seen")
    const seenMs = Date.now() - t0
    assertions.push(assertion("kill-server 之后 ping 仍收到 [seen]", seen.length >= 1, seen.length, ">=1"))
    assertions.push(assertion("[seen] ≤2000ms", seenMs <= SEEN_BUDGET_MS, seenMs, `<=${SEEN_BUDGET_MS}`))

    // 默认 server 一根汗毛没动
    let defaultAfterRaw = ""
    try {
      defaultAfterRaw = execFileSync("tmux", ["list-sessions", "-F", "#{session_name}"], { encoding: "utf-8", timeout: 10_000 }).trim()
    } catch {
      defaultAfterRaw = ""
    }
    const defaultAfter = defaultAfterRaw.split("\n").filter(Boolean)
    assertions.push(assertion(
      "默认 tmux server 的会话一个没少（我们没碰它）",
      defaultBefore.every((s) => defaultAfter.includes(s)),
      defaultAfter, defaultBefore,
    ))

    // rollout 是每轮落盘的，等这一轮 [done] 再量，不然量到的是半截
    await probe.collect((a) => a.some((m) => parseReceipt(String(m.payload ?? ""))?.kind === "done"), 90_000)
    Object.assign(events, logEventCounts(env))
    events["seat.ready"] = 1
    rolloutAfter = rolloutBytesFor(st1.mainThreadId, env.config.codex.home ?? undefined)
  } catch (e) {
    notes += `异常: ${String((e as Error).message ?? e)}；`
    assertions.push(assertion("跑完没抛异常", false, String((e as Error).message ?? e), "no throw"))
    Object.assign(events, logEventCounts(env))
  } finally {
    try {
      tmux(socket, ["kill-server"])
    } catch { /* 已经掀了 */ }
    // kill-server 只杀进程，socket 文件会留在 /tmp/tmux-<uid>/ 里当垃圾。
    // 名字形状再校验一遍才删 —— 这个目录里还住着 `default`（relay 和旧席位在上面）。
    if (/^e2e-[0-9a-f]{4}$/.test(socket)) {
      const sock = path.join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${process.getuid?.() ?? 501}`, socket)
      try {
        fs.rmSync(sock, { force: true })
      } catch { /* 没有就算了 */ }
    }
    seat.stop()
    await relay.stop()
  }

  assertions.push(assertion(
    "rollout 增长（模型真跑过）",
    rolloutAfter != null && rolloutAfter > rolloutBefore,
    { before: rolloutBefore, after: rolloutAfter }, "after > before",
  ))

  const allPass = assertions.every((a) => a.pass)
  const rec = buildEvidence({
    caseId: "E09",
    nonce,
    startedAt,
    events,
    assertions,
    // 阳性对照本身就是这个 case 的变异：一次性会话必死
    mutation: { fault: "external", expectedRed: false, actualRed: !allPass, note: `私有 tmux server ${socket} 的一次性会话必死，席位必活` },
    notes: `${notes}seat=${env.seat} socket=${socket}${mutate.on ? "（--mutate 对本 case 无额外含义：阳性对照即变异）" : ""}`,
    env: { relay: "real", appServer: "real" },
    instanceId: readState(env)?.instanceId ?? null,
    codexVersion: readState(env)?.codexVersion ?? null,
    rolloutBytesBefore: rolloutBefore,
    rolloutBytesAfter: rolloutAfter,
    passed: allPass,
  })
  const file = writeEvidence(rec, mutate.on ? (mutate.mode ?? "external") : null)
  return reportAndExit(rec, file)
}

if (require.main === module) {
  void run(process.argv.slice(2)).then((c) => process.exit(c))
}
