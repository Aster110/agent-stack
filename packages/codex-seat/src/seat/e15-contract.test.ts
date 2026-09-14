// Exercise the E15 case contract and the runner's existing evidence decision,
// using synthetic endpoints; this is not a live relay/Codex acceptance run.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { E15 } from "../../e2e/cases/E15-allowlist-rejected.js"
import { Assertions, writeEvidence } from "../../e2e/lib/evidence.js"
import type { CaseContext } from "../../e2e/lib/case.js"
import { MeshClient } from "../mesh/mesh-client.js"

test("E15 explicitly rejects retired mutation requests before starting a seat", async () => {
  let starts = 0
  for (const mutate of ["", "disable-allowlist"]) {
    const ctx = { mutate, seat: () => { starts++; throw new Error("seat should not start") } } as unknown as CaseContext
    await assert.rejects(E15(ctx), /E15.*退役/)
  }
  assert.equal(starts, 0, "retired mutation must not become a no-op successful run")
})

test("E15 peer success has no inverse mutation; failed routing stays failed in the existing runner", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-seat-e15-contract-"))
  const priorEngine = process.env.CODEX_SEAT_E2E_ENGINE
  const priorOut = process.env.CODEX_SEAT_E2E_OUT
  process.env.CODEX_SEAT_E2E_ENGINE = "fake"
  process.env.CODEX_SEAT_E2E_OUT = dir
  const peer = "unit:peer"
  const nodeId = "unit:seat"
  const nonce = "e15unit"
  const options: Array<Record<string, unknown>> = []
  const sent: Array<{ from: string; to: string }> = []
  t.mock.method(MeshClient.prototype, "register", async () => ({ nodeId: peer }))
  t.mock.method(MeshClient.prototype, "send", async (request: { from: string; to: string }) => { sent.push(request); return { msgId: "request-1", status: "accepted" } })
  t.mock.method(MeshClient.prototype, "sync", async () => ({
    messages: [{ payload: `[done] nonce=${nonce}x node=${nodeId} thread=th1 ms=1\n${nonce}x` }], nextSince: 1,
  }))
  const a = new Assertions()
  const ctx = {
    caseId: "E15", mutate: null, nonce, a, relay: { url: "http://127.0.0.1:1" }, probe: { received: [] }, note: () => {},
    seat: (opts: Record<string, unknown>) => {
      options.push(opts)
      return { nodeId, start: async () => {}, events: () => ({ "turn.started": 1 }), engineInfo: () => ({ codexVersion: "synthetic", codexHome: null }), state: () => ({ instanceId: "unit" }) }
    },
  } as unknown as CaseContext
  try {
    const outcome = await E15(ctx)
    assert.equal(a.allPass, true)
    assert.equal(outcome.mutation, null)
    assert.equal(outcome.env.appServer, "fake")
    assert.deepEqual(options[0]?.faults ?? [], [])
    assert.deepEqual(sent.map(({ from, to }) => ({ from, to })), [{ from: peer, to: nodeId }])
    const evidence = {
      ...outcome, caseId: "E15" as const, nonce, startedAt: new Date().toISOString(), wallMs: 1,
      notes: "synthetic E15 runner unit test", mutateMode: null, env: { relay: "fake" as const, appServer: "fake" as const },
    }
    assert.equal(writeEvidence({ ...evidence, assertions: a.list }).record.passed, true)
    const failed = writeEvidence({ ...evidence, assertions: [{ name: "peer routed", pass: false, actual: "rejected", expected: "done" }] })
    assert.equal(failed.record.passed, false, "routing rejection cannot become an expected-red success")
    assert.equal(failed.record.mutation, null)
  } finally {
    if (priorEngine === undefined) delete process.env.CODEX_SEAT_E2E_ENGINE
    else process.env.CODEX_SEAT_E2E_ENGINE = priorEngine
    if (priorOut === undefined) delete process.env.CODEX_SEAT_E2E_OUT
    else process.env.CODEX_SEAT_E2E_OUT = priorOut
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
