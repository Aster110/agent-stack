/**
 * E19 —— 48h soak 的采样器（每次调用打一发 nonce ping，把一条样本追加到 soak.jsonl）。
 *
 * ⚠️ **本轮只写不执行**：它跑在**生产**席位和**生产** relay（:19800）上，
 *    每 10 分钟一发、连跑 48h。启动由主席位另派（见 README.md）。
 *
 * 一条样本：{at, nonce, seenMs|null, doneMs|null, sidecarRssKb, engineRssKb, engineCount, ok}
 * RSS 取 sidecar 进程 + 引擎**整个进程组**（wrapper + rust 本体两个都要算，只算一个会低估一半）。
 * 另记 {threadId, rolloutBytes}：证据的第三证据是 rollout 增长，48h 后 soak-report 靠它证明
 * 「这 288 轮是真模型跑的」，不然 evidenceReallyRan() 永远 false、报告永远退出 1。
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  defaultDeviceId,
  extractNonce,
  parseReceipt,
  seatNodeId,
  seatPaths,
  type StateFile,
} from "../../src/contracts.js"
import { loadSeatConfig } from "../../src/cli/config.js"
import { readPidFile } from "../../src/proc/pidfile.js"
import { defaultSysProcOps } from "../../src/proc/ops.js"
import { rolloutBytesFor } from "../lib/script-case.js"

export interface SoakSample {
  at: string
  nonce: string
  seenMs: number | null
  doneMs: number | null
  sidecarRssKb: number | null
  engineRssKb: number | null
  engineProcCount: number
  instanceId: string | null
  /** 席位主 thread（换了 thread，rollout 文件也换，报告要按 thread 分段比） */
  threadId?: string | null
  /** 主 thread rollout 文件字节数（evidenceReallyRan 的第三证据） */
  rolloutBytes?: number | null
  ok: boolean
  note?: string
}

const SEEN_BUDGET_MS = 3000
const DONE_BUDGET_MS = 120_000
/** 单发 HTTP 的硬超时。没有它，relay 卡住 = 这个 ping 永不退出，
 *  launchd 同 Label 不并发 → 整个 48h soak 从此静默停摆（只剩一条永远跑不完的样本）。 */
const HTTP_TIMEOUT_MS = 15_000

function jfetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })
}

function rssKb(pid: number): number | null {
  try {
    const out = require("node:child_process")
      .execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf-8" })
      .trim()
    const n = Number.parseInt(out, 10)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

export async function sample(seat: string, probeShortId = "soak-probe"): Promise<SoakSample> {
  const cfg = loadSeatConfig(seat)
  const p = seatPaths(seat)
  const state = JSON.parse(fs.readFileSync(p.state, "utf-8")) as StateFile
  const relay = cfg.relayUrl.replace(/\/$/, "")
  const target = state.nodeId ?? seatNodeId(cfg.deviceId ?? defaultDeviceId(), seat)
  const nonce = `SOAK-${Date.now().toString(36)}`
  const at = new Date().toISOString()

  // 采样探针自己注册一个 pull 节点收回执（不占用任何生产席位的名字）
  const reg: any = await jfetch(`${relay}/api/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ shortId: probeShortId, role: "worker", description: "codex-seat soak probe", pid: process.pid, deliveryMode: "pull" }),
  }).then((r) => r.json())
  const probeNode: string = reg?.data?.nodeId
  const enc = encodeURIComponent(probeNode)

  // 游标锚在 relay 当前头上再发。**不能从 0 起**：探针的 nodeId 跨 288 次采样复用，
  // `since=0` 会把它历来收到的每一条回执重新吐一遍（48h 后 500+ 条），
  // 于是每一发都要先翻完整本历史才看得见本轮的 [seen] —— seen 延迟被翻页耗时污染，
  // p95 判据量的就不再是席位的响应速度。（同一个坑：2026-09-02 computer2 cursor=0 重放事故。）
  // 不带 since 的 sync = 服务端 ack 游标为起点；带 since 且 > 游标才推进销账。
  let cursor = 0
  for (let i = 0; i < 50; i++) {
    const q = i === 0 ? "" : `&since=${cursor}`
    const d: any = await jfetch(`${relay}/api/sync?nodeId=${enc}&timeout=0&limit=200${q}`).then((r) => r.json())
    const n = Number(d?.data?.nextSince)
    if (Number.isFinite(n)) cursor = Math.max(cursor, n)
    if ((d?.data?.messages ?? []).length === 0) break
  }

  const t0 = Date.now()
  await jfetch(`${relay}/api/send`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mesh-node": probeNode },
    body: JSON.stringify({ to: target, message: `请只回 ok。nonce=${nonce}` }),
  })

  let seenMs: number | null = null
  let doneMs: number | null = null
  let note: string | undefined
  const deadline = Date.now() + DONE_BUDGET_MS
  while (Date.now() < deadline && doneMs == null) {
    const d: any = await jfetch(`${relay}/api/sync?nodeId=${enc}&since=${cursor}&timeout=2&limit=50`).then((r) => r.json())
    cursor = d?.data?.nextSince ?? cursor
    for (const m of d?.data?.messages ?? []) {
      const text = String(m.payload ?? "")
      if (extractNonce(text, "") !== nonce) continue
      const r = parseReceipt(text)
      if (r?.kind === "seen" && seenMs == null) seenMs = Date.now() - t0
      if (r?.kind === "done") doneMs = Date.now() - t0
      // 席位明确拒了/失败了就别再干等满 120s：那 120s 不产出任何信息，
      // 只会让这一发采样把下一个 10 分钟窗口也吃掉，还把失败原因藏起来。
      if (r?.kind === "rejected") { note = `rejected:${r.reason}`; break }
      if (r?.kind === "failed") { note = `failed:${r.reason}`; break }
    }
    if (note) break
  }

  const sidecarPid = readPidFile(p.sidecarPid)?.pid ?? null
  const enginePgid = readPidFile(p.appServerPid)?.pgid ?? null
  const engineProcs = enginePgid ? defaultSysProcOps.list().filter((x) => x.pgid === enginePgid) : []
  const engineRss = engineProcs.reduce((acc, x) => acc + (rssKb(x.pid) ?? 0), 0)

  const threadId = state.mainThreadId ?? null
  const s: SoakSample = {
    at,
    nonce,
    seenMs,
    doneMs,
    sidecarRssKb: sidecarPid ? rssKb(sidecarPid) : null,
    engineRssKb: engineProcs.length > 0 ? engineRss : null,
    engineProcCount: engineProcs.length,
    instanceId: state.instanceId ?? null,
    threadId,
    rolloutBytes: rolloutBytesFor(threadId, cfg.codex.home ?? undefined),
    ok: seenMs != null && seenMs <= SEEN_BUDGET_MS,
    ...(note ? { note } : {}),
  }
  fs.mkdirSync(path.dirname(p.soakLog), { recursive: true })
  fs.appendFileSync(p.soakLog, `${JSON.stringify(s)}\n`)
  return s
}

if (require.main === module) {
  const seat = process.argv[2]
  if (!seat) {
    process.stderr.write("用法: node soak-ping.js <seat>\n")
    process.exit(2)
  }
  void sample(seat).then((s) => {
    process.stdout.write(`${JSON.stringify(s)}\n`)
    process.exit(s.ok ? 0 : 1)
  }).catch((e) => {
    const p = seatPaths(seat)
    const s: SoakSample = {
      at: new Date().toISOString(), nonce: "-", seenMs: null, doneMs: null,
      sidecarRssKb: null, engineRssKb: null, engineProcCount: 0, instanceId: null,
      ok: false, note: String((e as Error).message ?? e).slice(0, 200),
    }
    try {
      fs.mkdirSync(path.dirname(p.soakLog), { recursive: true })
      fs.appendFileSync(p.soakLog, `${JSON.stringify(s)}\n`)
    } catch { /* 连日志都写不了就算了 */ }
    process.stderr.write(`${JSON.stringify(s)}\n`)
    process.exit(1)
  })
}

export const SOAK_HOME_HINT = os.homedir()
