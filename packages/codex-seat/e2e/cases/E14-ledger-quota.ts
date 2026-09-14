/**
 * E14 —— 额度进账本。
 *
 * 🔴 **绝不连生产 Hub（192.0.2.1:19901）**：本 case 起一个本地假 Hub（node:http）收 PUT。
 *    假 Hub 只记录「有没有 Bearer 头」，**永不记录、永不打印 token 本身**。
 *
 * 数字：≤30s 收到 `PUT /api/ledger/seats`，字段
 *   seatId=`<device>/<seat>`、device、agentKind=`codex-app-server`、delivery=`pull`、active=true、
 *   accountFp 匹配 `^chatgpt-([0-9a-f]{12}|unknown)$`；
 *   relay 的 `@ledger` 收件箱有 `quota_report`，`limits[].kind ∈ {5h,7d,5h_scoped,7d_scoped}`、`used_percent` 是整数；
 *   `ledger-cache.json.stale=false`。
 * 变异（故障行为，expectedRed=false）：`hub-unreachable` → `stale=true`、`lastError` 非空、
 *   status 里 `hub.stale=true`（缺任一就红）。
 */
import fs from "node:fs"

import { buildStatusReport } from "../../src/cli/status.js"
import { defaultDeviceId, parseReceipt, seatLedgerId, type LedgerCache } from "../../src/contracts.js"
import { startFakeHub } from "../lib/fake-hub.js"
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
import { hex, waitFor } from "../lib/util.js"

const PUT_BUDGET_MS = 30_000
const ACCOUNT_FP_RE = /^chatgpt-([0-9a-f]{12}|unknown)$/
const QUOTA_KINDS = new Set(["5h", "7d", "5h_scoped", "7d_scoped", "other"])

export async function run(argv: readonly string[]): Promise<number> {
  const mutate = parseMutateArg(argv)
  const fault = mutate.on ? "hub-unreachable" : null
  const startedAt = Date.now()
  const nonce = `E14-${hex(3)}`
  const assertions = []
  const events: Record<string, number> = {}
  let notes = ""
  let rolloutBefore = 0
  let rolloutAfter: number | null = null

  const relay = await startPrivateRelay()
  const hub = await startFakeHub()
  const env = makeSeatEnv(relay, { hubEnabled: true, hubUrl: hub.url })
  if (env.config.hub.ledgerUrl.includes("192.0.2.1")) throw new Error("红线：E14 绝不连生产 Hub")
  const seat = startSeatProcess(env, fault ? { CODEX_SEAT_ALLOW_FAULTS: "1", CODEX_SEAT_FAULT: fault } : {})
  try {
    const st = await waitFor(() => {
      const s = readState(env)
      return s?.mainThreadId ? s : null
    }, 120_000, "席位就绪", 500)
    rolloutBefore = rolloutBytesFor(st.mainThreadId, env.config.codex.home ?? undefined) ?? 0
    // 「它真跑了」的事件计数不能只靠 hub.put —— 变异档（hub-unreachable）下它天生是 0，
    // 整个 events 全零会被 evidenceReallyRan() 判成「根本没跑」，红门就成了假红。
    // 这两条都是**真的发生过**才记：席位起来了（state 里有 mainThreadId）、热身轮拿到了 done。
    events["seat.ready"] = 1
    process.stdout.write(`[E14] seat=${env.seat} hub=${hub.url} fault=${fault ?? "-"}\n`)

    // 热身一轮：E14 本身只读 account/rateLimits，不产生 rollout。
    // 但「它真跑了」的三证据要求真引擎档 rollout 增长 —— 所以先跑一轮最短的活，
    // 顺带证明这个席位不是个只会写 JSON 的空壳。
    const probe = await Probe.start(relay.url)
    await probe.send(env.nodeId, `请只回 ok。nonce=${nonce}-warm`)
    const warm = await probe.collect((a) => a.some((m) => parseReceipt(String(m.payload ?? ""))?.kind === "done"), 90_000)
    events["warm.turn.done"] = warm.filter((m) => parseReceipt(String(m.payload ?? ""))?.kind === "done").length

    if (!fault) {
      const put = await waitFor(() => hub.puts.find((p) => p.path.includes("/api/ledger/seats")) ?? null, PUT_BUDGET_MS, "假 Hub 收到 PUT", 500)
      events["hub.put"] = hub.puts.length
      const b = put.body ?? {}
      process.stdout.write(`[E14] PUT body=${JSON.stringify(b)}\n`)
      assertions.push(assertion("seatId = <device>/<seat>", b.seatId === seatLedgerId(env.config.deviceId ?? defaultDeviceId(), env.seat), b.seatId, seatLedgerId(env.config.deviceId ?? defaultDeviceId(), env.seat)))
      assertions.push(assertion("device 正确", b.device === env.config.deviceId, b.device, env.config.deviceId))
      assertions.push(assertion("agentKind=codex-app-server", b.agentKind === "codex-app-server", b.agentKind, "codex-app-server"))
      assertions.push(assertion("delivery=pull", b.delivery === "pull", b.delivery, "pull"))
      assertions.push(assertion("active=true", b.active === true, b.active, true))
      assertions.push(assertion("accountFp 形如 chatgpt-<12hex>|unknown", ACCOUNT_FP_RE.test(String(b.accountFp ?? "")), b.accountFp, ACCOUNT_FP_RE.source))
      assertions.push(assertion("带了 Bearer 头（不记录内容）", put.hasBearer, put.hasBearer, true))
      assertions.push(assertion("PUT body 里不含 token 明文", !JSON.stringify(b).includes("e2e-fake-token"), false, false))

      // relay 的 @ledger 收件箱
      const inbox: any = await waitFor(async () => {
        // lib 的 waitFor 不吞异常（原 harness 的会吞掉继续轮询）—— 这里补回原语义
        try {
          const d: any = await fetch(`${relay.url}/api/inbox?nodeId=${encodeURIComponent("@ledger")}&since=0&limit=50`).then((x) => x.json())
          const msgs: any[] = d?.data?.messages ?? []
          const q = msgs.filter((m) => m.type === "quota_report")
          return q.length > 0 ? q : null
        } catch {
          return null
        }
      }, PUT_BUDGET_MS, "@ledger 收到 quota_report", 1000).catch(() => null)
      events["ledger.quotaReport"] = inbox?.length ?? 0
      assertions.push(assertion("@ledger 收件箱有 quota_report", (inbox?.length ?? 0) >= 1, inbox?.length ?? 0, ">=1"))
      if (inbox && inbox.length > 0) {
        let envlp: any = null
        try {
          envlp = JSON.parse(String(inbox[0].payload))
        } catch { /* 非 JSON */ }
        assertions.push(assertion("信封 schema_version=1 source=codex", envlp?.schema_version === "1" && envlp?.source === "codex", { v: envlp?.schema_version, s: envlp?.source }, { v: "1", s: "codex" }))
        const limits: any[] = envlp?.limits ?? []
        assertions.push(assertion("limits[].kind 都在合法集合里", limits.every((l) => QUOTA_KINDS.has(l.kind)), limits.map((l) => l.kind), [...QUOTA_KINDS]))
        assertions.push(assertion("used_percent 都是整数", limits.every((l) => Number.isInteger(l.used_percent)), limits.map((l) => l.used_percent), "integers"))
        assertions.push(assertion("信封里没有 email 明文", !/@[a-z0-9-]+\.[a-z]{2,}/i.test(JSON.stringify(envlp ?? {})), false, false))
      }

      const cache = await waitFor(() => {
        try {
          return JSON.parse(fs.readFileSync(env.paths.ledgerCache, "utf-8")) as LedgerCache
        } catch {
          return null
        }
      }, 15_000, "ledger-cache 落盘", 500)
      assertions.push(assertion("ledger-cache.stale=false", cache.stale === false, cache.stale, false))
      assertions.push(assertion("ledger-cache 里没有 token 明文", !JSON.stringify(cache).includes("e2e-fake-token"), false, false))
    } else {
      // 变异：把假 Hub 关掉，本地缓存必须标 stale
      await hub.stop()
      notes += "假 Hub 已关闭（hub-unreachable fault 同时生效）；"
      const cache = await waitFor(() => {
        try {
          const c = JSON.parse(fs.readFileSync(env.paths.ledgerCache, "utf-8")) as LedgerCache
          return c.stale === true ? c : null
        } catch {
          return null
        }
      }, PUT_BUDGET_MS, "ledger-cache 标 stale", 500).catch(() => null)
      assertions.push(assertion("ledger-cache.stale=true", cache?.stale === true, cache?.stale ?? null, true))
      assertions.push(assertion("lastError 非空", Boolean(cache?.lastError), cache?.lastError ?? null, "非空"))
      events["hub.put"] = hub.puts.length
      assertions.push(assertion("Hub 不可达时没有成功的 PUT", hub.puts.length === 0, hub.puts.length, 0))

      const report = await buildStatusReport({ seat: env.seat, config: env.config, homeDir: env.home })
      assertions.push(assertion("status 里 hub.stale=true", report.hub.stale === true, report.hub.stale, true))
      assertions.push(assertion("status --json 里不含 token 明文", !JSON.stringify(report).includes("e2e-fake-token"), false, false))
    }

    rolloutAfter = rolloutBytesFor(st.mainThreadId, env.config.codex.home ?? undefined)
    Object.assign(events, logEventCounts(env))
  } catch (e) {
    notes += `异常: ${String((e as Error).message ?? e)}；`
    assertions.push(assertion("跑完没抛异常", false, String((e as Error).message ?? e), "no throw"))
    Object.assign(events, logEventCounts(env))
  } finally {
    seat.stop()
    await hub.stop().catch(() => {})
    await relay.stop()
  }

  assertions.push(assertion(
    "rollout 增长（模型真跑过）",
    rolloutAfter != null && rolloutAfter > rolloutBefore,
    { before: rolloutBefore, after: rolloutAfter }, "after > before",
  ))

  const allPass = assertions.every((a) => a.pass)
  const rec = buildEvidence({
    caseId: "E14",
    nonce,
    startedAt,
    events,
    assertions,
    mutation: fault
      ? { fault, expectedRed: false, actualRed: !allPass, note: "Hub 不可达时必须标 stale + lastError，断言仍须全过" }
      : null,
    notes: `${notes}seat=${env.seat} 假 Hub=${hub.url}（绝不连生产 192.0.2.1）`,
    env: { relay: "real", appServer: "real" },
    instanceId: readState(env)?.instanceId ?? null,
    codexVersion: readState(env)?.codexVersion ?? null,
    rolloutBytesBefore: rolloutBefore,
    rolloutBytesAfter: rolloutAfter,
    passed: allPass,
  })
  const file = writeEvidence(rec, mutate.on ? (mutate.mode ?? "hub-unreachable") : null)
  return reportAndExit(rec, file)
}

if (require.main === module) {
  void run(process.argv.slice(2)).then((c) => process.exit(c))
}
