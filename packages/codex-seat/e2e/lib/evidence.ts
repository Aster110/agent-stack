// 证据写入器。格式：e2e/EVIDENCE_SCHEMA.json / contracts.EvidenceRecord。
// 纪律：每份必须过 evidenceReallyRan()（墙钟>0、事件计数非空、真引擎 rollout 增长）——
// 「跑了」和「跑绿了」是两回事，没有活证据的绿一律不算数。

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  CONTRACT_VERSION,
  evidenceReallyRan,
  type E2ECaseId,
  type EvidenceAssertion,
  type EvidenceMutation,
  type EvidenceRecord,
} from "../../src/contracts.js"

export class Assertions {
  readonly list: EvidenceAssertion[] = []

  add(name: string, pass: boolean, actual: unknown, expected: unknown): boolean {
    this.list.push({ name, pass, actual, expected })
    return pass
  }

  eq(name: string, actual: unknown, expected: unknown): boolean {
    return this.add(name, Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected), actual, expected)
  }

  ok(name: string, cond: boolean, actual: unknown, expected: unknown = true): boolean {
    return this.add(name, cond, actual, expected)
  }

  /** 数值上界：actual <= max */
  lte(name: string, actual: number, max: number): boolean {
    return this.add(name, actual <= max, actual, `<= ${max}`)
  }

  gte(name: string, actual: number, min: number): boolean {
    return this.add(name, actual >= min, actual, `>= ${min}`)
  }

  match(name: string, actual: string, re: RegExp): boolean {
    return this.add(name, re.test(actual), actual, String(re))
  }

  get allPass(): boolean { return this.list.every((a) => a.pass) }
}

export function outDir(): string {
  const d = process.env.CODEX_SEAT_E2E_OUT || path.resolve(__dirname, "../../../e2e/evidence")
  fs.mkdirSync(d, { recursive: true })
  return d
}

export interface WriteEvidenceInput {
  caseId: E2ECaseId
  nonce: string
  startedAt: string
  wallMs: number
  events: Record<string, number>
  rolloutBytesBefore: number | null
  rolloutBytesAfter: number | null
  assertions: EvidenceAssertion[]
  mutation: Omit<EvidenceMutation, "actualRed"> | null
  notes: string
  env: { relay: "real" | "fake" | "none"; appServer: "real" | "real-idle" | "fake" | "none" }
  codexVersion: string | null
  instanceId: string | null
  mutateMode: string | null
}

export interface WrittenEvidence {
  record: EvidenceRecord
  file: string
  reallyRan: boolean
}

export function writeEvidence(i: WriteEvidenceInput): WrittenEvidence {
  const allPass = i.assertions.every((a) => a.pass)
  const actualRed = !allPass
  const mutation: EvidenceMutation | null = i.mutation ? { ...i.mutation, actualRed } : null
  // 判绿规则（LANES §6）：
  //   无变异           → assertions 全过
  //   红门 expectedRed  → 必须真红（actualRed === true）
  //   故障行为检查      → 变异下 assertions 仍须全过
  const passed = mutation
    ? (mutation.expectedRed ? actualRed : allPass)
    : allPass

  const record: EvidenceRecord = {
    case: i.caseId,
    nonce: i.nonce,
    startedAt: i.startedAt,
    wallMs: i.wallMs,
    events: i.events,
    rolloutBytesBefore: i.rolloutBytesBefore,
    rolloutBytesAfter: i.rolloutBytesAfter,
    assertions: i.assertions,
    mutation,
    notes: i.notes,
    passed,
    lane: "B",
    phase: "e2e",
    env: i.env,
    contractVersion: CONTRACT_VERSION,
    codexVersion: i.codexVersion,
    hostname: os.hostname(),
    instanceId: i.instanceId,
  }
  const suffix = i.mutateMode == null ? "" : (i.mutateMode === "" ? "-mutate" : `-mutate-${i.mutateMode}`)
  const file = path.join(outDir(), `${i.caseId}${suffix}-${i.startedAt.replace(/[:.]/g, "-")}.json`)
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`)
  return { record, file, reallyRan: evidenceReallyRan(record) }
}
