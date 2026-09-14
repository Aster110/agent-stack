#!/usr/bin/env node
// E2E 入口：node dist/e2e/run.js <CASE|all> [--mutate[=mode]]
//
// 判绿规则（LANES §6）：
//   无变异           → assertions 全过
//   红门 expectedRed=true  → 变异**必须**让 case 红（跑绿了 = 这个 case 什么也没测到，禁止合并）
//   故障行为检查 expectedRed=false → 变异下 assertions 仍须全过
// 另外每份证据都要过 evidenceReallyRan()：墙钟>0、事件计数非空、真引擎 rollout 增长。

import { spawn } from "node:child_process"
import path from "node:path"

import type { E2ECaseId } from "../src/contracts.js"
import { withCase, type CaseFn } from "./lib/case.js"
import { writeEvidence } from "./lib/evidence.js"

import { E02 } from "./cases/E02-register-and-receipts.js"
import { E03 } from "./cases/E03-cursor-no-loss.js"
import { E04 } from "./cases/E04-resume-thread.js"
import { E05 } from "./cases/E05-parallel-workers.js"
import { E06 } from "./cases/E06-spawn-worker.js"
import { E12 } from "./cases/E12-reconcile-zombies.js"
import { E15 } from "./cases/E15-allowlist-rejected.js"
import { E16 } from "./cases/E16-unknown-server-request.js"
import { E20 } from "./cases/E20-context-compact.js"
import { E21 } from "./cases/E21-reused-nodeid-no-replay.js"

const CASES: Partial<Record<E2ECaseId, CaseFn>> = { E02, E03, E04, E05, E06, E12, E15, E16, E20, E21 }
const LANE_B_ORDER: E2ECaseId[] = ["E02", "E03", "E04", "E05", "E06", "E12", "E15", "E16", "E20", "E21"]

/**
 * Lane C 的 case 是**独立可执行脚本**（自己起 launchd / 私有 tmux / 假 Hub，自己写证据、
 * 自己判红门），不走 withCase 骨架。集成后由这里代跑：spawn 它的编译产物、把退出码原样带回来。
 * 别把它们改写成 CaseFn —— 那几件事（真 launchd 装卸、kill -9 自己）在同进程里做不了。
 */
const LANE_C_SCRIPTS: Partial<Record<E2ECaseId, string>> = {
  E07: "E07-sidecar-kill9.js",
  E08: "E08-kill-rust-body.js",
  E09: "E09-tmux-kill-server.js",
  E13: "E13-cu-smoke.js",
  E14: "E14-ledger-quota.js",
}
const LANE_C_ORDER: E2ECaseId[] = ["E07", "E08", "E09", "E13", "E14"]
const ALL_ORDER: E2ECaseId[] = [...LANE_B_ORDER, ...LANE_C_ORDER]

function parseArgs(argv: string[]): { cases: E2ECaseId[]; mutate: string | null } {
  const positional = argv.filter((a) => !a.startsWith("--"))
  const mutateArg = argv.find((a) => a === "--mutate" || a.startsWith("--mutate="))
  const mutate = mutateArg == null ? null : (mutateArg === "--mutate" ? "" : mutateArg.slice("--mutate=".length))
  const which = (positional[0] ?? "").toUpperCase()
  if (!which) throw new Error("用法: node dist/e2e/run.js <E02|…|all> [--mutate[=mode]]")
  if (which === "ALL") return { cases: ALL_ORDER, mutate }
  if (!(which in CASES) && !(which in LANE_C_SCRIPTS)) {
    throw new Error(`没有 ${which}，可选：${ALL_ORDER.join(",")}`)
  }
  return { cases: [which as E2ECaseId], mutate }
}

/** 代跑 Lane C 的独立脚本：证据由脚本自己写，这里只看退出码。 */
async function runLaneCScript(caseId: E2ECaseId, mutate: string | null): Promise<boolean> {
  const entry = path.resolve(__dirname, "cases", LANE_C_SCRIPTS[caseId]!)
  const args = mutate == null ? [] : (mutate === "" ? ["--mutate"] : [`--mutate=${mutate}`])
  const label = `${caseId}${args.length > 0 ? ` ${args.join(" ")}` : ""}`
  process.stdout.write(`\n=== ${label} （Lane C 独立脚本） ===\n`)
  const code = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, [entry, ...args], { stdio: "inherit", env: process.env })
    child.on("exit", (c) => resolve(c ?? 1))
    child.on("error", () => resolve(1))
  })
  process.stdout.write(`  => ${code === 0 ? "PASS" : "FAIL"}（exit ${code}）\n`)
  return code === 0
}

async function runOne(caseId: E2ECaseId, mutate: string | null): Promise<boolean> {
  if (LANE_C_SCRIPTS[caseId]) return await runLaneCScript(caseId, mutate)
  const fn = CASES[caseId]!
  const startedAt = new Date().toISOString()
  const t0 = Date.now()
  const label = `${caseId}${mutate == null ? "" : (mutate === "" ? " --mutate" : ` --mutate=${mutate}`)}`
  process.stdout.write(`\n=== ${label} ===\n`)

  let result
  let fatal: string | null = null
  try {
    result = await withCase(caseId, mutate, fn)
  } catch (err) {
    fatal = String((err as Error)?.stack ?? err)
    process.stdout.write(`case 抛异常：${fatal}\n`)
  }
  const wallMs = Date.now() - t0

  const assertions = result?.assertions.list ?? [{ name: "case-threw", pass: false, actual: fatal, expected: "no exception" }]
  const written = writeEvidence({
    caseId,
    nonce: result?.nonce ?? `${caseId.toLowerCase()}fatal`,
    startedAt,
    wallMs,
    events: result?.events ?? {},
    rolloutBytesBefore: result?.rolloutBytesBefore ?? null,
    rolloutBytesAfter: result?.rolloutBytesAfter ?? null,
    assertions,
    mutation: result?.mutation ?? null,
    notes: `${result?.notes ?? ""}${fatal ? ` FATAL: ${fatal.split("\n")[0]}` : ""}`,
    env: result?.env ?? { relay: "real", appServer: "none" },
    codexVersion: result?.codexVersion ?? null,
    instanceId: result?.instanceId ?? null,
    mutateMode: mutate,
  })

  for (const a of assertions) {
    process.stdout.write(`  ${a.pass ? "✓" : "✗"} ${a.name}: actual=${JSON.stringify(a.actual)} expected=${JSON.stringify(a.expected)}\n`)
  }
  // 「它真跑了」的活证据必须打印出来——空转报绿是最贵的假绿。
  process.stdout.write(`  wallMs=${wallMs} events=${JSON.stringify(written.record.events)}\n`)
  if (written.record.mutation) {
    const m = written.record.mutation
    process.stdout.write(`  mutation fault=${m.fault} expectedRed=${m.expectedRed} actualRed=${m.actualRed}\n`)
  }
  process.stdout.write(`  rollout ${written.record.rolloutBytesBefore} → ${written.record.rolloutBytesAfter}\n`)
  process.stdout.write(`  evidence: ${written.file}\n`)
  if (!written.reallyRan) process.stdout.write(`  ✗ evidenceReallyRan=false（墙钟/事件/rollout 缺一 → 不算跑过）\n`)
  const pass = written.record.passed && written.reallyRan
  process.stdout.write(`  => ${pass ? "PASS" : "FAIL"}\n`)
  return pass
}

async function main(): Promise<void> {
  const { cases, mutate } = parseArgs(process.argv.slice(2))
  let allPass = true
  for (const c of cases) allPass = (await runOne(c, mutate)) && allPass
  process.stdout.write(`\n${allPass ? "ALL PASS" : "HAS FAILURE"}: ${cases.join(",")}${mutate == null ? "" : " (mutate)"}\n`)
  process.exit(allPass ? 0 : 1)
}

void main()
