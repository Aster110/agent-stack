// Deployment-patch M1: transport-confirmed receipts must not create model turns
// or reciprocal receipts. Reuses the existing HTTP relay and engine test seams.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { foldWal, seatPaths, type StateFile, type WalEntry, type WalFolded } from "../contracts.js"
import { WalStore } from "../state/wal.js"
import { FakeAppServerClient } from "../app-server/index.js"
import { FakeRelay } from "./fakes/fake-relay.js"
import { SpyEngine } from "./fakes/spy-engine.js"
import { resolveSeatConfig } from "./config.js"
import { runSeat } from "./seat.js"

const SEAT = "receipt-test"
const PROBE = "e2edev:probe"
// Structural fixture fields let the old code compile; RED must be a behavior
// assertion, not an import/type error because production has not added fields yet.
type TransportWal = WalEntry & { messageType?: string; replyTo?: string }

async function waitForDone(read: () => WalEntry[], ids: string[]): Promise<void> {
  const deadline = Date.now() + 5000
  while (ids.some((id) => foldWal(read()).get(id)?.phase !== "done")) {
    if (Date.now() > deadline) throw new Error(`WAL did not settle: ${ids.join(", ")}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function start(seed: TransportWal[] = []) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-seat-receipts-"))
  const paths = seatPaths(SEAT, home)
  const relay = await FakeRelay.start()
  const engine = new SpyEngine(new FakeAppServerClient({}))
  fs.mkdirSync(paths.home, { recursive: true })
  if (seed.length) {
    fs.writeFileSync(paths.wal, seed.map((entry) => `${JSON.stringify(entry)}\n`).join(""))
    const now = new Date().toISOString()
    const state: StateFile = {
      version: 1, contractVersion: "1", seat: SEAT, nodeId: `e2edev:${SEAT}`, deviceId: "e2edev",
      mainThreadId: null, workers: {}, cursor: Math.max(...seed.map((entry) => entry.seq)),
      cursorAnchoredAt: now, cursorAnchorSeq: 0, paused: null, instanceId: "previous",
      createdAt: now, startedAt: now, lastSeenAt: null, lastDoneAt: null, recentMsgIds: [],
      codexVersion: null, engine: null, resumableThreads: [],
    }
    fs.writeFileSync(paths.state, JSON.stringify(state))
  }
  const config = resolveSeatConfig({
    seat: SEAT, cwd: home, relayUrl: relay.url,
    hub: { ledgerUrl: "http://127.0.0.1:1", tokenFile: path.join(home, "unused"), intervalSec: 300, enabled: false },
    allowlist: { extra: [PROBE], disableDefaults: true },
    sync: { timeoutSec: 1, limit: 100 }, turn: { timeoutMs: 10_000 },
  })
  const env = { ...process.env }
  delete env.CODEX_SEAT_ALLOW_FAULTS
  delete env.CODEX_SEAT_FAULT
  const seat = await runSeat(config, {
    engine, env, homeDir: home, log: () => {}, exit: () => {}, installSignalHandlers: false,
  })
  const wal = (): TransportWal[] => fs.existsSync(paths.wal)
    ? fs.readFileSync(paths.wal, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : []
  return {
    relay, engine, seat, wal,
    stop: async () => { await seat.stop("test"); await relay.stop(); fs.rmSync(home, { recursive: true, force: true }) },
  }
}

const seen = `[seen] nonce=rcpt01 node=${PROBE} thread=th1 t=now`
const done = `[done] nonce=rcpt02 node=${PROBE} thread=th1 ms=1\nfinished\n[seen] is part of the result body`

test("machine receipts: all existing receipt kinds settle without model turns or reciprocal sends", async () => {
  const h = await start()
  try {
    const cases = [
      { body: seen, type: "system" },
      { body: done, type: "result" },
      { body: `[failed] nonce=rcpt03 node=${PROBE} reason=turn-failed detail=failed`, type: "system" },
      { body: `[rejected] nonce=rcpt04 node=${PROBE} reason=sender-not-allowed`, type: "system" },
      { body: `[bootstrap][registered] node=${PROBE} nonce=rcpt05`, type: "system" },
      { body: `[bootstrap][ready] node=${PROBE} nonce=rcpt06`, type: "system" },
    ]
    const ids = cases.map((row, i) => h.relay.deliver(h.seat.nodeId, PROBE, row.body, row.type, `original-${i}`))
    await waitForDone(h.wal, ids)
    assert.equal(h.engine.turnCalls.length, 0, "a received machine receipt must never be submitted as a task")
    assert.deepEqual(h.relay.sends, [], "a receipt must not produce a receipt-of-receipt")
    for (const [i, id] of ids.entries()) {
      const fetched = h.wal().find((entry) => entry.msgId === id && entry.op === "fetched")!
      assert.equal(fetched.messageType, cases[i]!.type)
      assert.equal(fetched.replyTo, `original-${i}`)
      assert.equal(fetched.payload, cases[i]!.body)
      assert.equal(h.wal().filter((entry) => entry.msgId === id && entry.op === "receipted").length, 1)
    }
  } finally { await h.stop() }
})

test("receipt-like tasks: task/chat, missing replyTo, conflicting node, and malformed body all reach the model", async () => {
  const h = await start()
  try {
    const cases = [
      { body: seen, type: "task", replyTo: "original-1" },
      { body: done, type: "chat", replyTo: "original-2" },
      { body: seen, type: "system", replyTo: undefined },
      { body: done, type: "result", replyTo: undefined },
      { body: seen.replace(PROBE, "server:brain"), type: "system", replyTo: "original-3" },
      { body: "[seen] this is a task about receipts", type: "system", replyTo: "original-4" },
    ]
    const ids = cases.map((row) => h.relay.deliver(h.seat.nodeId, PROBE, row.body, row.type, row.replyTo))
    await waitForDone(h.wal, ids)
    assert.deepEqual(h.engine.turnCalls.map((call) => call.msgId), ids, "each ordinary task runs exactly once")
    for (const [i, id] of ids.entries()) {
      assert.equal(h.engine.turnCalls[i]!.text.includes(cases[i]!.body), true, "the complete task body must survive routing")
      assert.deepEqual(h.relay.sends.filter((send) => send.replyTo === id).map((send) => send.type), ["system", "result"])
    }
  } finally { await h.stop() }
})

function fetched(id: string, seq: number, body = seen): TransportWal {
  return {
    op: "fetched", msgId: id, seq, to: `e2edev:${SEAT}`, from: PROBE, nonce: "rcpt01",
    at: new Date().toISOString(), payload: body, messageType: body === done ? "result" : "system", replyTo: `original-${id}`,
  }
}

test("WAL metadata: fetched transport fields survive phase folding, compaction, and reopen", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-seat-receipt-wal-"))
  const file = path.join(home, "wal.jsonl")
  const wal = new WalStore(file)
  try {
    const rows = [fetched("pending", 1), fetched("started", 2), fetched("completed", 3, done)]
    for (const row of rows) wal.append(row)
    // Later events need not repeat metadata; the original fetched envelope owns it.
    wal.append({ ...rows[1]!, op: "started", messageType: undefined, replyTo: undefined, threadId: "old-thread", turnId: "old-turn" } as TransportWal)
    wal.append({ ...rows[2]!, op: "completed", messageType: undefined, replyTo: undefined, finalText: "old answer" } as TransportWal)
    assert.equal(wal.compact(), 3)
    wal.close()
    const reopened = new WalStore(file)
    try {
      const folded = reopened.fold()
      for (const [i, row] of rows.entries()) {
        const actual = folded.get(row.msgId) as WalFolded & { messageType?: string; replyTo?: string }
        assert.equal(actual.phase, ["fetched", "started", "completed"][i])
        assert.equal(actual.messageType, row.messageType)
        assert.equal(actual.replyTo, row.replyTo)
        assert.equal(actual.payload, row.payload)
      }
    } finally { reopened.close() }
  } finally { wal.close(); fs.rmSync(home, { recursive: true, force: true }) }
})

test("WAL restart: fetched/started/completed machine receipts close without replay or recovery replies", async () => {
  const a = fetched("receipt-fetched", 6)
  const b = fetched("receipt-started", 7)
  const c = fetched("receipt-completed", 8, done)
  const h = await start([
    a, b, { ...b, op: "started", messageType: undefined, replyTo: undefined, threadId: "old-thread", turnId: "old-turn" },
    c, { ...c, op: "completed", messageType: undefined, replyTo: undefined, threadId: "old-thread", finalText: "do not send this" },
  ])
  try {
    await waitForDone(h.wal, [a.msgId, b.msgId, c.msgId])
    assert.equal(h.engine.turnCalls.length, 0)
    assert.deepEqual(h.relay.sends, [], "restart must not emit failed/done responses to received receipts")
    for (const row of [a, b, c]) {
      assert.equal(h.wal().filter((entry) => entry.msgId === row.msgId && entry.op === "receipted").length, 1)
    }
  } finally { await h.stop() }
})

test("legacy WAL: receipt-like payload without transport metadata is replayed as the original task", async () => {
  const { messageType: _type, replyTo: _replyTo, ...legacy } = fetched("legacy-task", 9)
  const h = await start([legacy])
  try {
    await waitForDone(h.wal, [legacy.msgId])
    assert.deepEqual(h.engine.turnCalls.map((call) => call.msgId), [legacy.msgId])
    assert.equal(h.engine.turnCalls[0]!.text.includes(seen), true)
    assert.deepEqual(h.relay.sends.map((send) => send.type), ["system", "result"])
  } finally { await h.stop() }
})
