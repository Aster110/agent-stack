// M2 deployment regressions: real JSON-RPC child process, isolated from M1 seat tests.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { RealAppServerClient } from "./real-client.js"
import type { ScriptedServerScript } from "./scripted-server.js"

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)) }

async function rig(script: Partial<ScriptedServerScript>, wait: boolean | ((ms: number) => Promise<void>) = true, requestTimeoutMs = 8000) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-seat-compact-"))
  const trace = path.join(dir, "trace.jsonl")
  const scriptPath = path.join(dir, "script.json")
  fs.writeFileSync(scriptPath, JSON.stringify({
    turn: { emitStarted: true, startedAfterMs: 5, items: [{ type: "agentMessage", text: "BUSINESS-OK" }], completedAfterMs: 80 },
    ...script,
  }))
  const bin = path.join(dir, "codex")
  fs.writeFileSync(bin,
    `#!/bin/sh\nCODEX_SCRIPTED_SCRIPT='${scriptPath}' CODEX_SCRIPTED_TRACE='${trace}' '${process.execPath}' '${path.join(__dirname, "scripted-server.js")}' "$@"\n`,
    { mode: 0o755 },
  )
  const client = new RealAppServerClient({
    cwd: dir, bin, pidFile: path.join(dir, "app-server.pid"),
    initializeTimeoutMs: 8000, threadOpTimeoutMs: requestTimeoutMs, shutdownGraceMs: 300,
    seat: "compact-test", instanceId: "compact-test-instance",
    // Compress retry waits through the existing clock seam so one deadline test
    // can cover several attempts without depending on the production backoff value.
    ...(wait ? { sleep: typeof wait === "function" ? wait : (ms: number) => delay(Math.min(ms, 25)) } : {}),
  })
  const received = (method: string): Array<{ params: Record<string, any> }> =>
    (fs.existsSync(trace) ? fs.readFileSync(trace, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [])
      .filter((frame) => frame.t === "recv" && frame.method === method)
  try {
    await client.start()
    const thread = await client.threadStart({ cwd: dir })
    return {
      client, thread, received,
      close: async () => { await client.stop(); fs.rmSync(dir, { recursive: true, force: true }) },
    }
  } catch (error) {
    await client.stop()
    fs.rmSync(dir, { recursive: true, force: true })
    throw error
  }
}

test("business RPC timeout keeps process alive, original request registered, and accepts late ACK/result", async () => {
  const r = await rig({ turnAckDelayMs: 250 }, true, 40)
  try {
    const events: string[] = []
    r.client.onEvent((e) => events.push(e.type))
    const handle = await r.client.turnStart({ threadId: r.thread.threadId, text: "late", nonce: "late", msgId: "late", timeoutMs: 0 })
    await delay(120)
    assert.ok(events.includes("request.unresponsive"))
    assert.equal(r.client.isAlive(), true)
    process.kill(r.client.info()!.pid, 0)
    assert.equal(r.received("turn/interrupt").length, 0)
    const outcome = await handle.done
    assert.equal(outcome.status, "completed")
    assert.equal(outcome.status === "completed" && outcome.finalText, "BUSINESS-OK")
    assert.equal(r.received("turn/start").length, 1)
    assert.equal(r.received("turn/interrupt").length, 0)
  } finally { await r.close() }
})

test("read-only recovery finds a pre-ACK submission by durable task marker and reads a lost terminal notification", async () => {
  const r = await rig({ turnAckDelayMs: 250, dropCompleted: true }, true, 40)
  try {
    await r.client.turnStart({ threadId: r.thread.threadId, text: "recover [mesh-task-id:original-task]", nonce: "recover", msgId: "original-task", timeoutMs: 0 })
    await delay(130)
    const result = await r.client.readTurn(r.thread.threadId, "unknown", "original-task")
    assert.equal(result.status, "completed")
    assert.equal(result.status === "completed" && result.finalText, "BUSINESS-OK")
    assert.equal(await r.client.readTurn(r.thread.threadId, "unknown", "other-task").then((r) => r.status), "unknown")
    assert.equal(r.received("turn/start").length, 1)
    assert.equal(r.received("turn/interrupt").length, 0)
  } finally { await r.close() }
})

test("snapshot retires pre-ACK handle so the next turn and late first ACK stay independent", async () => {
  const r = await rig({ firstTurnAckDelayMs: 1000 }, true, 40)
  try {
    const first = await r.client.turnStart({ threadId: r.thread.threadId, text: "first [mesh-task-id:first]", nonce: "first", msgId: "first", timeoutMs: 0 })
    await delay(130)
    assert.equal((await r.client.readTurn(r.thread.threadId, "unknown", "first")).status, "completed")
    assert.equal((await first.done).status, "completed")
    const second = await r.client.turnStart({ threadId: r.thread.threadId, text: "second", nonce: "second", msgId: "second", timeoutMs: 0 })
    const result = await Promise.race([second.done, delay(400).then(() => ({ status: "stuck" }))])
    assert.equal(result.status, "completed", "second turn must not wait for old ACK or another observation threshold")
    await delay(1000)
    assert.equal(r.received("turn/start").length, 2)
    assert.equal(r.received("turn/interrupt").length, 0)
    assert.equal(r.client.isAlive(), true)
  } finally { await r.close() }
})

test("Compact busy retries only unaccepted input and binds pre-ACK events to the business turn", async () => {
  const r = await rig({ compactBusyAttempts: 1, turnAckDelayMs: 20 })
  try {
    const handle = await r.client.turnStart({ threadId: r.thread.threadId, text: "one business input", nonce: "n1", msgId: "m1", timeoutMs: 3000 })
    const result = await handle.done
    assert.equal(result.status, "completed")
    const started = await handle.started
    assert.equal(started.turnId, "tu-1", "Compact's started notification cannot claim the business handle")
    if (result.status === "completed") {
      assert.equal(result.turnId, "tu-1")
      assert.equal(result.finalText, "BUSINESS-OK", "Compact's empty completion cannot finish the business request")
    }
    const submissions = r.received("turn/start")
    assert.equal(submissions.length, 2, "one rejected attempt plus exactly one accepted business turn")
    assert.deepEqual(submissions.map((frame) => frame.params.input), [
      [{ type: "text", text: "one business input", text_elements: [] }],
      [{ type: "text", text: "one business input", text_elements: [] }],
    ])
    assert.equal(r.received("turn/interrupt").length, 0)
  } finally { await r.close() }
})

test("Compact retry preserves the original deadline and never interrupts an unaccepted or foreign turn", async () => {
  const r = await rig({ compactBusyAttempts: 100 })
  try {
    const handle = await r.client.turnStart({ threadId: r.thread.threadId, text: "not accepted", nonce: "n2", msgId: "m2", timeoutMs: 200 })
    const result = await handle.done
    assert.equal(result.status, "timeout")
    await assert.rejects(handle.started)
    assert.equal(handle.turnId, null)
    if (result.status === "timeout") {
      assert.equal(result.wallMs >= 180 && result.wallMs < 1000, true, `original 200ms deadline, actual ${result.wallMs}ms`)
    }
    const attempts = r.received("turn/start").length
    assert.equal(attempts >= 2, true, "deadline covers multiple attempts, not only the initial rejection")
    await delay(60)
    assert.equal(r.received("turn/start").length, attempts, "no retry after the original deadline")
    assert.equal(r.received("turn/interrupt").length, 0)
  } finally { await r.close() }
})

test("cancel during Compact wait ends the request without resubmission or interrupting Compact", async () => {
  let enterWait!: () => void
  const waiting = new Promise<void>((resolve) => { enterWait = resolve })
  let releaseWait!: () => void
  const released = new Promise<void>((resolve) => { releaseWait = resolve })
  const r = await rig({ compactBusyAttempts: 100 }, async () => {
    enterWait()
    await released
  })
  try {
    const handle = await r.client.turnStart({ threadId: r.thread.threadId, text: "cancel pending", nonce: "n3", msgId: "m3", timeoutMs: 5000 })
    // A terminal result before sleep is a behavioral failure, not a hanging gate.
    const beforeCancel = await Promise.race([
      waiting.then(() => ({ status: "waiting" as const })),
      handle.done,
    ])
    assert.equal(beforeCancel.status, "waiting", "Compact rejection must enter retry wait before cancellation")
    assert.equal(r.received("turn/start").length, 1)
    await handle.interrupt()
    const result = await handle.done
    assert.equal(result.status, "interrupted")
    await assert.rejects(handle.started)
    assert.equal(handle.turnId, null)

    releaseWait()
    await new Promise<void>((resolve) => setImmediate(resolve))
    // The read-only RPC response is a child-process barrier: trace has consumed
    // any input submitted by the awakened retry before we inspect it or stop.
    await r.client.loadedThreads()
    assert.equal(r.received("turn/start").length, 1, "cancelled input must not be resubmitted after retry sleep wakes")
    assert.equal(r.received("turn/interrupt").length, 0, "foreign Compact belongs to the engine, not this request")
  } finally {
    releaseWait()
    await r.close()
  }
})
