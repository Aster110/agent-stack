// M3: optional model/effort config must survive file validation and seat restart.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { perThreadConfigOverride, seatPaths, type StateFile } from "../contracts.js"
import { defaultSeatConfig, loadSeatConfig, validateSeatConfig, writeSeatConfig } from "../cli/config.js"
import { FakeAppServerClient } from "../app-server/index.js"
import { FakeRelay } from "./fakes/fake-relay.js"
import { SpyEngine } from "./fakes/spy-engine.js"
import { runSeat, type SeatHandle } from "./seat.js"

const SEAT = "model-test"
const PROBE = "e2edev:probe"
type Overrides = { model?: string | null; reasoningEffort?: string | null }
type WireOverrides = { model?: string; model_reasoning_effort?: string }

test("model config validation: optional fields accept missing/null and independent nonempty strings", () => {
  for (const fields of [
    {}, { model: null, reasoningEffort: null }, { model: "gpt-6-astra" },
    { reasoningEffort: "high" }, { model: "gpt-6-astra", reasoningEffort: "high" },
  ]) {
    const config = defaultSeatConfig(SEAT, "/tmp")
    Object.assign(config.codex, fields)
    const result = validateSeatConfig(config, SEAT)
    assert.equal(result.ok, true, JSON.stringify(fields))
    if (result.ok) assert.deepEqual(result.config.codex, config.codex, "validation must preserve explicit values")
  }
})

test("model config validation: empty, whitespace, and wrong-type values identify the invalid field", () => {
  const results: Array<{ field: string; value: unknown; rejected: boolean; fieldError: boolean }> = []
  for (const field of ["model", "reasoningEffort"]) {
    for (const value of ["", "  ", 6]) {
      const config = defaultSeatConfig(SEAT, "/tmp")
      Object.assign(config.codex, { [field]: value })
      const result = validateSeatConfig(config)
      results.push({ field, value, rejected: !result.ok, fieldError: !result.ok && result.errors.some((error) => error.includes(`codex.${field}`)) })
    }
  }
  assert.deepEqual(results, results.map((row) => ({ ...row, rejected: true, fieldError: true })))
})

async function rig() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-seat-model-"))
  const paths = seatPaths(SEAT, home)
  const relay = await FakeRelay.start()
  const engine = new SpyEngine(new FakeAppServerClient({}))
  const handles: SeatHandle[] = []
  const state = (): StateFile => JSON.parse(fs.readFileSync(paths.state, "utf8"))
  const env = { ...process.env }
  delete env.CODEX_SEAT_ALLOW_FAULTS
  delete env.CODEX_SEAT_FAULT
  return {
    engine, relay, state,
    launch: async (fields: Overrides): Promise<SeatHandle> => {
      const config = defaultSeatConfig(SEAT, home)
      config.relayUrl = relay.url
      config.hub.enabled = false
      config.hub.tokenFile = path.join(home, "unused-hub-token")
      config.allowlist = { extra: [PROBE], disableDefaults: true }
      config.sync.timeoutSec = 1
      Object.assign(config.codex, fields)
      writeSeatConfig(paths.config, config)
      // Exercise the same disk validation boundary as the CLI before runSeat.
      const loaded = loadSeatConfig(SEAT, paths.config, home)
      const handle = await runSeat(loaded, {
        engine, env, homeDir: home, log: () => {}, exit: () => {}, installSignalHandlers: false,
      })
      handles.push(handle)
      return handle
    },
    warm: async (handle: SeatHandle): Promise<void> => {
      const id = relay.deliver(handle.nodeId, PROBE, "warm the persisted thread nonce=modelwarm")
      const deadline = Date.now() + 5000
      while (!relay.sends.some((send) => send.replyTo === id && send.type === "result")) {
        if (Date.now() > deadline) throw new Error("warm turn did not finish")
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    },
    close: async () => {
      for (const handle of handles.reverse()) await handle.stop("test-cleanup")
      await relay.stop()
      fs.rmSync(home, { recursive: true, force: true })
    },
  }
}

const cases: Array<{ name: string; before: Overrides; after: Overrides; start: WireOverrides; resume: WireOverrides }> = [
  {
    name: "model only", before: { model: "gpt-5.6-sol" }, after: { model: "gpt-6-astra" },
    start: { model: "gpt-5.6-sol" }, resume: { model: "gpt-6-astra" },
  },
  {
    name: "effort only", before: { reasoningEffort: "low" }, after: { reasoningEffort: "high" },
    start: { model_reasoning_effort: "low" }, resume: { model_reasoning_effort: "high" },
  },
  {
    name: "model and effort", before: { model: "gpt-5.6-sol", reasoningEffort: "low" }, after: { model: "gpt-6-astra", reasoningEffort: "high" },
    start: { model: "gpt-5.6-sol", model_reasoning_effort: "low" }, resume: { model: "gpt-6-astra", model_reasoning_effort: "high" },
  },
  { name: "missing then null defaults", before: {}, after: { model: null, reasoningEffort: null }, start: {}, resume: {} },
]

for (const row of cases) {
  test(`seat model config: ${row.name} reaches start/resume without replacing the warmed thread or identity`, async () => {
    const h = await rig()
    try {
      const first = await h.launch(row.before)
      const original = h.state()
      await h.warm(first)
      await first.stop("config-update")
      const second = await h.launch(row.after)
      const resumed = h.state()

      assert.equal(resumed.mainThreadId, original.mainThreadId)
      assert.equal(second.nodeId, first.nodeId)
      assert.equal(resumed.nodeId, original.nodeId)
      assert.equal(h.engine.threadStarts.length, 1, "updated config must not create a replacement thread")
      assert.equal(h.engine.threadResumes.length, 1)
      assert.equal(h.engine.threadResumes[0]!.threadId, original.mainThreadId)
      assert.deepEqual(h.engine.threadStarts[0]!.config, { ...perThreadConfigOverride(first.nodeId), ...row.start })
      assert.deepEqual(h.engine.threadResumes[0]!.config, { ...perThreadConfigOverride(first.nodeId), ...row.resume })
      assert.equal(h.engine.turnCalls.length, 1, "only the warm task was executed")
    } finally { await h.close() }
  })
}
