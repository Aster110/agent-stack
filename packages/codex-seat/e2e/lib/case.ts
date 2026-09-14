// case 的公共上下文与骨架。每个 case 只写「前置 / 步骤 / 数字阈值 / 变异」，
// 私有 relay、探针、证据、清理都在这儿一次性做掉。

import type { E2ECaseId, EvidenceMutation } from "../../src/contracts.js"
import { startPrivateRelay, type PrivateRelay } from "./relay.js"
import { Probe } from "./probe.js"
import { Assertions } from "./evidence.js"
import { SeatProcess, type SeatProcOptions } from "./seat-proc.js"
import { hex } from "./util.js"

export interface CaseContext {
  caseId: E2ECaseId
  /** null = 无变异；"" = 主红门（--mutate）；其它 = --mutate=<mode> */
  mutate: string | null
  relay: PrivateRelay
  probe: Probe
  a: Assertions
  nonce: string
  /** 起一个被测席位子进程（自动登记，结束统一清理） */
  seat(opts?: Partial<SeatProcOptions>): SeatProcess
  note(s: string): void
}

export interface CaseOutcome {
  /** actualRed 由 runner 按 assertions 结果填，case 只声明 fault/expectedRed */
  mutation: Omit<EvidenceMutation, "actualRed"> | null
  events: Record<string, number>
  env: { relay: "real" | "fake" | "none"; appServer: "real" | "real-idle" | "fake" | "none" }
  codexVersion: string | null
  instanceId: string | null
  rolloutBytesBefore: number | null
  rolloutBytesAfter: number | null
}

export type CaseFn = (ctx: CaseContext) => Promise<CaseOutcome>

export interface CaseRunResult extends CaseOutcome {
  assertions: Assertions
  nonce: string
  notes: string
}

export async function withCase(caseId: E2ECaseId, mutate: string | null, fn: CaseFn): Promise<CaseRunResult> {
  const relay = await startPrivateRelay()
  const seats: SeatProcess[] = []
  const notes: string[] = []
  let probe: Probe | null = null
  try {
    probe = await Probe.start(relay.url)
    const a = new Assertions()
    const nonce = `${caseId.toLowerCase()}${hex(3)}`
    const ctx: CaseContext = {
      caseId, mutate, relay, probe, a, nonce,
      seat: (opts = {}) => {
        const s = new SeatProcess({ relayUrl: relay.url, ...opts })
        seats.push(s)
        return s
      },
      note: (s) => notes.push(s),
    }
    const outcome = await fn(ctx)
    return { ...outcome, assertions: a, nonce, notes: notes.join(" | ") }
  } finally {
    for (const s of seats) await s.stop().catch(() => {})
    await probe?.stop().catch(() => {})
    await relay.stop().catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// 引擎档位与「它真跑了」的活证据
// ---------------------------------------------------------------------------

import path from "node:path"
import { dirBytes } from "./util.js"

export type EngineKind = "real" | "fake"

/**
 * case 设计档位 vs 实际档位：CODEX_SEAT_E2E_ENGINE 可以把真引擎档降级成假引擎跑（干跑验管道）。
 * 降级会如实写进 evidence.env.appServer——不许拿假引擎的绿冒充真引擎的绿。
 */
export function engineFor(designed: EngineKind): EngineKind {
  const o = process.env.CODEX_SEAT_E2E_ENGINE
  if (o === "real" || o === "fake") return o
  return designed
}

export function envFor(kind: EngineKind): { relay: "real"; appServer: "real" | "fake" } {
  return { relay: "real", appServer: kind === "real" ? "real" : "fake" }
}

/**
 * 「本档设计上零 turn」的真引擎档：引擎是真的（起了或故意起不来），但没有任何模型轮次，
 * 所以 rollout 不可能增长。写 real-idle 而不是 none/fake —— 后者是拿假档位绕开举证，
 * 前者是如实说明「真引擎、零 turn」。墙钟与事件计数照样要拿得出来。
 */
export function envIdle(kind: EngineKind): { relay: "real"; appServer: "real-idle" | "fake" } {
  return { relay: "real", appServer: kind === "real" ? "real-idle" : "fake" }
}

/** 真引擎的 rollout 目录字节数（evidenceReallyRan 的第三证据）。假引擎返回 null。 */
export function rolloutBytes(seat: SeatProcess, kind: EngineKind): number | null {
  if (kind !== "real") return null
  const home = seat.engineInfo().codexHome
  if (!home) return null
  return dirBytes(path.join(home, "sessions"))
}

/** 引擎事件计数 + mesh 侧活动计数（引擎起不来的档也必须有非空计数，否则证据判「没跑」）。 */
export function mergeEvents(seat: SeatProcess, probe: Probe, extra: Record<string, number> = {}): Record<string, number> {
  return { ...seat.events(), "mesh.received": probe.received.length, ...extra }
}
