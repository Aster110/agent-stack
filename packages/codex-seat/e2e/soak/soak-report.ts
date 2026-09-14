/**
 * E19 —— soak 结论生成器：把 `soak.jsonl` 变成一份 EvidenceRecord。
 *
 * 判据（设计稿 §10 E19，数字写死，不写"合理范围内"）：
 *   · seen 成功率 100%
 *   · seen p95 < 3000ms
 *   · RSS「不单调涨」：不存在 ≥20 个连续严格递增样本，
 *     且末 6h 均值 ≤ 首 6h 均值 × 1.3
 *
 * 为什么不用「末值 < 阈值」：内存高但平的进程没问题，缓慢单调爬的才是泄漏。
 * 阈值定的是**形状**，不是绝对值。
 */
import fs from "node:fs"

import { seatPaths, type EvidenceRecord } from "../../src/contracts.js"
import { buildEvidence, writeEvidence, reportAndExit, assertion } from "../lib/script-case.js"
import type { SoakSample } from "./soak-ping.js"

export const SEEN_P95_BUDGET_MS = 3000
export const MONOTONIC_RUN_LIMIT = 20
export const TAIL_HEAD_RATIO_LIMIT = 1.3
const SIX_HOURS_MS = 6 * 60 * 60 * 1000

export function readSamples(file: string): SoakSample[] {
  const out: SoakSample[] = []
  let raw = ""
  try {
    raw = fs.readFileSync(file, "utf-8")
  } catch {
    return out
  }
  for (const line of raw.split("\n")) {
    const s = line.trim()
    if (!s.startsWith("{")) continue
    try {
      out.push(JSON.parse(s) as SoakSample)
    } catch { /* 截断行 */ }
  }
  return out
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null
  const v = [...values].sort((a, b) => a - b)
  const idx = Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1))
  return v[idx]!
}

/** 最长连续严格递增段的长度 */
export function longestStrictlyIncreasingRun(values: readonly number[]): number {
  let best = values.length > 0 ? 1 : 0
  let cur = values.length > 0 ? 1 : 0
  for (let i = 1; i < values.length; i++) {
    if (values[i]! > values[i - 1]!) cur++
    else cur = 1
    if (cur > best) best = cur
  }
  return best
}

export interface SoakVerdict {
  samples: number
  seenOk: number
  seenRate: number
  seenP95: number | null
  rssRunLen: number
  headMeanKb: number | null
  tailMeanKb: number | null
  ratio: number | null
  monotonicOk: boolean
  ratioOk: boolean
}

export function analyze(samples: readonly SoakSample[]): SoakVerdict {
  const seenValues = samples.map((s) => s.seenMs).filter((x): x is number => x != null)
  const seenOk = samples.filter((s) => s.ok).length
  const rss = samples.map((s) => (s.sidecarRssKb ?? 0) + (s.engineRssKb ?? 0)).filter((x) => x > 0)

  const t = (s: SoakSample) => new Date(s.at).getTime()
  const first = samples.length > 0 ? t(samples[0]!) : 0
  const last = samples.length > 0 ? t(samples[samples.length - 1]!) : 0
  const head = samples.filter((s) => t(s) - first <= SIX_HOURS_MS).map((s) => (s.sidecarRssKb ?? 0) + (s.engineRssKb ?? 0)).filter((x) => x > 0)
  const tail = samples.filter((s) => last - t(s) <= SIX_HOURS_MS).map((s) => (s.sidecarRssKb ?? 0) + (s.engineRssKb ?? 0)).filter((x) => x > 0)
  const mean = (a: readonly number[]) => (a.length > 0 ? a.reduce((x, y) => x + y, 0) / a.length : null)
  const headMean = mean(head)
  const tailMean = mean(tail)
  const ratio = headMean && tailMean ? tailMean / headMean : null
  const runLen = longestStrictlyIncreasingRun(rss)

  return {
    samples: samples.length,
    seenOk,
    seenRate: samples.length > 0 ? seenOk / samples.length : 0,
    seenP95: percentile(seenValues, 95),
    rssRunLen: runLen,
    headMeanKb: headMean,
    tailMeanKb: tailMean,
    ratio,
    monotonicOk: runLen < MONOTONIC_RUN_LIMIT,
    ratioOk: ratio == null || ratio <= TAIL_HEAD_RATIO_LIMIT,
  }
}

/**
 * rollout 证据窗口：**按 thread 分段取**。
 * 中途换过主 thread（compact / resume 失败换 id）时 rollout 换文件、字节数会掉下来，
 * 拿全局首尾比就成了「负增长」——那不是引擎没跑，是尺子跨了两个文件在量。
 * 所以只在**最后一个样本所在 thread** 的窗口内比首尾；该窗口不足两点才退回全局首尾。
 */
export function rolloutWindow(samples: readonly SoakSample[]): { before: number | null; after: number | null; threadSwitches: number } {
  const withRoll = samples.filter((s) => typeof s.rolloutBytes === "number")
  let threadSwitches = 0
  for (let i = 1; i < samples.length; i++) {
    if (samples[i]!.threadId && samples[i - 1]!.threadId && samples[i]!.threadId !== samples[i - 1]!.threadId) threadSwitches++
  }
  if (withRoll.length === 0) return { before: null, after: null, threadSwitches }
  const lastThread = withRoll[withRoll.length - 1]!.threadId ?? null
  const sameThread = withRoll.filter((s) => (s.threadId ?? null) === lastThread)
  const win = sameThread.length >= 2 ? sameThread : withRoll
  return { before: win[0]!.rolloutBytes ?? null, after: win[win.length - 1]!.rolloutBytes ?? null, threadSwitches }
}

export function buildSoakEvidence(seat: string, samples: readonly SoakSample[]): EvidenceRecord {
  const v = analyze(samples)
  const roll = rolloutWindow(samples)
  const first = samples.length > 0 ? new Date(samples[0]!.at).getTime() : Date.now()
  const assertions = [
    assertion("样本数 ≥ 24（至少 4 小时）", v.samples >= 24, v.samples, ">=24"),
    assertion("seen 成功率 100%", v.seenRate === 1, `${(v.seenRate * 100).toFixed(1)}%`, "100%"),
    assertion(`seen p95 < ${SEEN_P95_BUDGET_MS}ms`, v.seenP95 != null && v.seenP95 < SEEN_P95_BUDGET_MS, v.seenP95, `<${SEEN_P95_BUDGET_MS}`),
    assertion(`RSS 无 ≥${MONOTONIC_RUN_LIMIT} 连续严格递增`, v.monotonicOk, v.rssRunLen, `<${MONOTONIC_RUN_LIMIT}`),
    assertion(`末6h 均值 ≤ 首6h 均值 ×${TAIL_HEAD_RATIO_LIMIT}`, v.ratioOk, v.ratio, `<=${TAIL_HEAD_RATIO_LIMIT}`),
  ]
  return buildEvidence({
    caseId: "E19",
    nonce: `SOAK-${seat}`,
    startedAt: first,
    events: {
      samples: v.samples,
      seenOk: v.seenOk,
      engineProcSamples: samples.filter((s) => s.engineProcCount > 0).length,
    },
    assertions,
    mutation: null,
    notes: `seat=${seat} headMeanKb=${v.headMeanKb ?? "-"} tailMeanKb=${v.tailMeanKb ?? "-"} ratio=${v.ratio ?? "-"} threadSwitches=${roll.threadSwitches}`,
    env: { relay: "real", appServer: "real" },
    phase: "soak",
    // 第三证据：主 thread 的 rollout 真长了 = 这些 turn 是真模型跑的，不是我们自己日志的自证。
    rolloutBytesBefore: roll.before,
    rolloutBytesAfter: roll.after,
    passed: assertions.every((a) => a.pass),
  })
}

if (require.main === module) {
  const seat = process.argv[2]
  if (!seat) {
    process.stderr.write("用法: node soak-report.js <seat>\n")
    process.exit(2)
  }
  const samples = readSamples(seatPaths(seat).soakLog)
  const rec = buildSoakEvidence(seat, samples)
  // 第二参是 **mutateMode**，不是"给文件名加个后缀"：传 "soak" 会把证据落成
  // `E19-mutate-soak-*.json`，读起来是"E19 的变异档"，可这份 rec.mutation 是 null。
  // soak 与 e2e 档靠 `phase` 字段区分，文件名不该撒这个谎。
  process.exit(reportAndExit(rec, writeEvidence(rec, null)))
}
