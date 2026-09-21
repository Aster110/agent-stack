// Lane B — 席位主循环单测：注册/路由/回执时机/串行与并行/白名单/控制消息/WAL 恢复/对账/compact/退出。
// 全部对着假 relay（真 HTTP）+ 假引擎跑，无 codex、无生产 relay。

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  parseReceipt,
  perThreadConfigOverride,
  seatPaths,
  type FailReason,
  type Receipt,
  type SeatConfig,
  type StateFile,
  type ThreadTokenUsage,
  type WalEntry,
} from "../contracts.js"
import { FakeAppServerClient } from "../app-server/index.js"
import type { FakeScenarioInput } from "../app-server/fake-scenario.js"
import { SpyEngine } from "./fakes/spy-engine.js"
import { FakeRelay, type FakeRelaySendRecord } from "./fakes/fake-relay.js"
import { runSeat, type SeatHandle, type SeatLogRecord } from "./seat.js"
import { resolveSeatConfig } from "./config.js"

const SEAT = "e2e-t001"
const PROBE = "e2edev:probe"

interface Harness {
  relay: FakeRelay
  engine: SpyEngine
  seat: SeatHandle
  home: string
  config: SeatConfig
  logs: SeatLogRecord[]
  exits: number[]
  nodeId: string
  wal(): WalEntry[]
  state(): StateFile
  stop(): Promise<void>
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }

/** 造一份「上下文占比 = ratio」的 tokenUsage（E20 触发条件的单测版） */
function usageForRatio(ratio: number): ThreadTokenUsage {
  const win = 258_400
  const total = Math.round(win * ratio)
  const b = { totalTokens: total, inputTokens: total, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }
  return { total: b, last: b, modelContextWindow: win }
}

async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 5000, label = "condition"): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v as T
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor 超时(${timeoutMs}ms): ${label}`)
    await sleep(5)
  }
}

function receipts(relay: FakeRelay, to = PROBE): Receipt[] {
  return relay.receiptsTo(to).map((s) => parseReceipt(s.message)).filter((r): r is Receipt => r != null)
}

function receiptRecords(relay: FakeRelay, to = PROBE): Array<{ rec: FakeRelaySendRecord; r: Receipt }> {
  const out: Array<{ rec: FakeRelaySendRecord; r: Receipt }> = []
  for (const rec of relay.receiptsTo(to)) {
    const r = parseReceipt(rec.message)
    if (r) out.push({ rec, r })
  }
  return out
}

async function start(opts: {
  scenario?: FakeScenarioInput
  faults?: string
  configPatch?: Partial<SeatConfig>
  home?: string
  engine?: SpyEngine
  relay?: FakeRelay
  preState?: (home: string, paths: ReturnType<typeof seatPaths>) => void
} = {}): Promise<Harness> {
  const home = opts.home ?? fs.mkdtempSync(path.join(os.tmpdir(), "codex-seat-home-"))
  const relay = opts.relay ?? await FakeRelay.start()
  const engineFaults = new Set((opts.faults ?? "").split(",").map((x) => x.trim()).filter(Boolean) as any[])
  const engine = opts.engine ?? new SpyEngine(new FakeAppServerClient({ scenario: opts.scenario ?? {}, faults: engineFaults as any }))
  const paths = seatPaths(SEAT, home)
  fs.mkdirSync(paths.home, { recursive: true })
  opts.preState?.(home, paths)

  const config = resolveSeatConfig({
    seat: SEAT,
    cwd: home,
    relayUrl: relay.url,
    hub: { ledgerUrl: "http://127.0.0.1:1", tokenFile: path.join(home, "hub-token"), intervalSec: 300, enabled: false },
    allowlist: { extra: ["*:probe"], disableDefaults: true },
    sync: { timeoutSec: 1, limit: 100 },
    turn: { timeoutMs: 10_000 },
    ...opts.configPatch,
  })
  const logs: SeatLogRecord[] = []
  const exits: number[] = []
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (opts.faults) { env.CODEX_SEAT_ALLOW_FAULTS = "1"; env.CODEX_SEAT_FAULT = opts.faults }
  else { delete env.CODEX_SEAT_ALLOW_FAULTS; delete env.CODEX_SEAT_FAULT }

  const seat = await runSeat(config, {
    engine, env, homeDir: home,
    log: (r) => logs.push(r),
    exit: (code) => { exits.push(code) },
    installSignalHandlers: false,
  })
  return {
    relay, engine, seat, home, config, logs, exits, nodeId: seat.nodeId,
    // 一条都没写过时 wal.jsonl 根本不存在（WalStore 首次 append 才开文件）——那也是一种被断言的事实
    wal: () => (fs.existsSync(paths.wal) ? fs.readFileSync(paths.wal, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as WalEntry) : []),
    state: () => JSON.parse(fs.readFileSync(paths.state, "utf8")) as StateFile,
    stop: async () => { await seat.stop("test"); await relay.stop() },
  }
}

// ---------------------------------------------------------------------------

test("legacy timeout WAL survives two restarts, deduplicates confirmation, and recovers late result", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-seat-recovery-"))
  const paths = seatPaths(SEAT, home)
  const at = new Date().toISOString()
  const common = { msgId: "legacy-timeout", seq: 9, to: `e2edev:${SEAT}`, from: PROBE, nonce: "oldtimeout", at }
  seedWal(paths, [
    { ...common, op: "fetched", payload: "must never resubmit" },
    { ...common, op: "started", threadId: "original-thread", turnId: "original-turn" },
    { ...common, op: "failed", reason: "timeout", detail: "turn exceeded 1800000ms" },
  ])
  seedState(paths, { cursor: 9 })
  const h1 = await start({ home })
  await waitFor(() => receipts(h1.relay).some((r) => r.kind === "observation"))
  assert.equal(h1.engine.turnCalls.length, 0)
  await h1.stop()
  const engine = new SpyEngine(new FakeAppServerClient({ scenario: {} }))
  const reads: string[][] = []
  engine.readTurn = async (threadId, turnId) => {
    reads.push([threadId, turnId])
    return { status: "completed", turnId, finalText: "RECOVERED-LATE", wallMs: 0, startedMs: 0 }
  }
  const h2 = await start({ home, engine })
  try {
    const done = await waitFor(() => receiptRecords(h2.relay).find((r) => r.r.kind === "done"))
    assert.equal(done.rec.replyTo, "legacy-timeout")
    assert.match(done.rec.message, /RECOVERED-LATE/)
    assert.deepEqual(reads, [["original-thread", "original-turn"]])
    assert.equal(receipts(h2.relay).filter((r) => r.kind === "observation").length, 0)
    assert.equal(engine.turnCalls.length, 0)
    assert.equal(h2.wal().filter((r) => r.op === "observing").length, 1)
  } finally { await h2.stop() }
})

// 2026-09-21 air2 事故：两条旧 timeout（旧 sidecar 已 interrupt 的 turn）挂在活的主 thread 上，
// 升级后被折成 observing 放进 recovering，runTurn 对同 thread 一律等待 → 新消息永远起不了 turn；
// 且每 5 秒 thread/read 一次 8 GB rollout。任务保持 observing 是对的，占锁与反复重读是错的。
test("legacy interrupted turn on the live thread keeps observing, releases the lock and re-reads with backoff", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-seat-legacy-live-"))
  const paths = seatPaths(SEAT, home)
  const at = new Date().toISOString()
  const common = { msgId: "legacy-live", seq: 9, to: `e2edev:${SEAT}`, from: PROBE, nonce: "legacylive", at }
  seedWal(paths, [
    { ...common, op: "fetched", payload: "must never resubmit" },
    { ...common, op: "started", threadId: "live-thread", turnId: "legacy-turn" },
    { ...common, op: "failed", reason: "timeout", detail: "turn exceeded 1800000ms" },
  ])
  // cursor 0: the fake relay numbers fresh deliveries from seq 1, a seeded cursor of 9 would hide the new task
  // resumableThreads: without it the seat starts a fresh thread and the legacy entry would not share it
  seedState(paths, { cursor: 0, mainThreadId: "live-thread", resumableThreads: ["live-thread"] })
  const engine = new SpyEngine(new FakeAppServerClient({ scenario: {} }))
  const reads: string[][] = []
  engine.readTurn = async (threadId, turnId) => { reads.push([threadId, turnId]); return { status: "interrupted", turnId, wallMs: 0 } }
  const h = await start({ home, engine })
  try {
    await waitFor(() => receipts(h.relay).some((r) => r.kind === "observation" && r.state === "awaiting_confirmation"))
    await waitFor(() => h.logs.find((l) => l.event === "recovery-thread-released" && l.msgId === "legacy-live" && l.snapshot === "interrupted"))
    const task = h.relay.deliver(h.nodeId, PROBE, "after-upgrade nonce=afterupgrade")
    const done = await waitFor(() => receiptRecords(h.relay).find((r) => r.r.kind === "done"))
    assert.equal(done.rec.replyTo, task)
    assert.equal(h.engine.turnCalls.length, 1)
    assert.equal(h.engine.turnCalls[0].threadId, "live-thread")
    assert.equal(h.engine.interrupts.length, 0)
    // the legacy task is still observing: no terminal receipt, still counted, WAL untouched beyond observing/observation-sent
    assert.equal(receiptRecords(h.relay).filter((r) => r.rec.replyTo === "legacy-live" && r.r.kind !== "observation").length, 0)
    assert.equal(receipts(h.relay).filter((r) => r.kind === "observation").length, 1)
    assert.equal((await h.seat.status()).wal.started, 1)
    assert.equal(h.wal().filter((e) => e.msgId === "legacy-live" && (e.op === "submitting" || e.op === "completed" || e.op === "receipted")).length, 0)
    // re-reads back off instead of firing every 5 s tick: after ~5.5 s exactly two reads
    // (t0 and the next tick), and the last deferral already waits a full tick more.
    await sleep(5_500)
    assert.equal(reads.length, 2)
    assert.deepEqual(reads[0], ["live-thread", "legacy-turn"])
    const deferrals = h.logs.filter((l) => l.event === "recovery-read-deferred" && l.msgId === "legacy-live")
    assert.deepEqual(deferrals.map((l) => l.retryInMs), [0, 5_000])
    assert.equal(h.logs.filter((l) => l.event === "recovery-thread-released").length, 1)
  } finally { await h.stop() }
})

test("recovered turn missing from the thread releases the lock; a failed thread read keeps holding and backs off", async () => {
  const seed = (dir: string): string => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), dir))
    const paths = seatPaths(SEAT, home)
    const common = { msgId: "legacy-live", seq: 9, to: `e2edev:${SEAT}`, from: PROBE, nonce: "legacylive", at: new Date().toISOString() }
    seedWal(paths, [
      { ...common, op: "fetched", payload: "must never resubmit" },
      { ...common, op: "started", threadId: "live-thread", turnId: "legacy-turn" },
      { ...common, op: "failed", reason: "timeout", detail: "turn exceeded 1800000ms" },
    ])
    seedState(paths, { cursor: 0, mainThreadId: "live-thread", resumableThreads: ["live-thread"] })
    return home
  }
  // not-found: the turn is not on the thread at all → nothing to steer → lock released
  const e1 = new SpyEngine(new FakeAppServerClient({ scenario: {} }))
  const reads1: string[][] = []
  e1.readTurn = async (threadId, turnId) => { reads1.push([threadId, turnId]); return { status: "unknown", reason: "not-found" } }
  const h1 = await start({ home: seed("codex-seat-legacy-notfound-"), engine: e1 })
  try {
    await waitFor(() => h1.logs.find((l) => l.event === "recovery-thread-released" && l.snapshot === "not-found"))
    const task = h1.relay.deliver(h1.nodeId, PROBE, "after-upgrade nonce=afterupgrade2")
    const done = await waitFor(() => receiptRecords(h1.relay).find((r) => r.r.kind === "done"))
    assert.equal(done.rec.replyTo, task)
    assert.deepEqual(reads1, [["live-thread", "legacy-turn"]])
    assert.equal((await h1.seat.status()).wal.started, 1)
  } finally { await h1.stop() }
  // read-error: we know nothing → keep holding the thread, but retry with backoff instead of every tick
  const e2 = new SpyEngine(new FakeAppServerClient({ scenario: {} }))
  const reads2: string[][] = []
  e2.readTurn = async (threadId, turnId) => { reads2.push([threadId, turnId]); return { status: "unknown", reason: "read-error" } }
  const h2 = await start({ home: seed("codex-seat-legacy-readerror-"), engine: e2 })
  try {
    await waitFor(() => h2.logs.find((l) => l.event === "recovery-read-deferred" && l.reason === "read-error"))
    const task = h2.relay.deliver(h2.nodeId, PROBE, "after-upgrade nonce=afterupgrade3")
    await sleep(400)
    assert.equal(e2.turnCalls.length, 0)
    assert.equal(h2.wal().some((e) => e.msgId === task && e.op === "submitting"), false)
    assert.deepEqual(reads2, [["live-thread", "legacy-turn"]])
    assert.equal(h2.logs.some((l) => l.event === "recovery-thread-released"), false)
  } finally { await h2.stop() }
})

test("activity after observation restores running and confirmation remains once", async () => {
  const h = await start({ configPatch: { turn: { timeoutMs: 50 } }, scenario: { defaultTurn: { completeAfterMs: 300 } } })
  try {
    h.relay.deliver(h.nodeId, PROBE, "activity nonce=activity1")
    await waitFor(() => receipts(h.relay).some((r) => r.kind === "observation" && r.state === "awaiting_confirmation"))
    const started = h.wal().find((e) => e.op === "started")!
    h.engine.emit({ type: "item.completed", threadId: started.threadId!, turnId: started.turnId!, itemType: "commandExecution", server: null, tool: null, status: "completed" })
    await waitFor(() => receipts(h.relay).some((r) => r.kind === "observation" && r.state === "running"))
    await waitFor(() => receipts(h.relay).some((r) => r.kind === "done"))
    assert.equal(h.wal().filter((e) => e.op === "observing").length, 1)
    assert.equal(h.engine.interrupts.length, 0)
  } finally { await h.stop() }
})

test("confirmation terminal snapshot resolves original task before missing notification; late notification cannot duplicate done", async () => {
  const engine = new SpyEngine(new FakeAppServerClient({ scenario: { defaultTurn: { completeAfterMs: 300 } } }))
  engine.readTurn = async (_threadId, turnId) => ({ status: "completed", turnId, finalText: "snapshot-result", wallMs: 70, startedMs: 5 })
  const h = await start({ engine, configPatch: { turn: { timeoutMs: 50 } } })
  try {
    const task = h.relay.deliver(h.nodeId, PROBE, "snapshot nonce=snapshot")
    const done = await waitFor(() => receiptRecords(h.relay).find((r) => r.r.kind === "done"), 250)
    assert.equal(done.rec.replyTo, task)
    assert.match(done.rec.message, /snapshot-result/)
    await sleep(350)
    assert.equal(receipts(h.relay).filter((r) => r.kind === "done").length, 1)
    assert.equal(engine.interrupts.length, 0)
  } finally { await h.stop() }
})

test("WAL observation written before crash retries missing receipt without resubmitting business input", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-seat-observation-outbox-"))
  const paths = seatPaths(SEAT, home)
  const common = { msgId: "outbox-task", seq: 9, to: `e2edev:${SEAT}`, from: PROBE, nonce: "outbox", at: new Date().toISOString() }
  seedWal(paths, [{ ...common, op: "fetched", payload: "original" }, { ...common, op: "submitting", threadId: "t-original" }, { ...common, op: "observing", threadId: "t-original" }])
  seedState(paths, { cursor: 9 })
  const h = await start({ home })
  try {
    await waitFor(() => receiptRecords(h.relay).find((r) => r.r.kind === "observation"))
    assert.equal(h.engine.turnCalls.length, 0)
    assert.equal(h.wal().filter((e) => e.op === "observing").length, 1)
    assert.equal(h.wal().filter((e) => e.op === "observation-sent").length, 1)
    assert.equal((await h.seat.status()).wal.started, 1)
  } finally { await h.stop() }
})

test("failed late-result delivery remains completed in WAL and is sent after restart", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-seat-result-outbox-"))
  const relay = await FakeRelay.start()
  const h = await start({ home, relay, configPatch: { turn: { timeoutMs: 50 } }, scenario: { defaultTurn: { completeAfterMs: 180, outcome: { status: "completed", finalText: "durable-late" } } } })
  const task = relay.deliver(h.nodeId, PROBE, "late nonce=lateoutbox")
  await waitFor(() => receipts(relay).some((r) => r.kind === "observation"))
  relay.failWith = { pathPrefix: "/api/send", status: 503 }
  await waitFor(() => h.wal().some((e) => e.op === "completed" && e.msgId === task))
  await sleep(30)
  assert.equal(h.wal().some((e) => e.op === "receipted" && e.msgId === task), false)
  await h.stop()
  const h2 = await start({ home })
  try {
    const done = await waitFor(() => receiptRecords(h2.relay).find((r) => r.r.kind === "done"))
    assert.equal(done.rec.replyTo, task)
    assert.match(done.rec.message, /durable-late/)
    assert.equal(h2.engine.turnCalls.length, 0)
  } finally { await h2.stop() }
})

test("seat: 以 pull 形态注册主席位，主 thread 带 developerInstructions 与 MESH_NODE 覆盖", async () => {
  // 注入：thread/start 不传 config（等价 fault disable-thread-env-override）→ 署名断言红
  const h = await start()
  try {
    assert.equal(h.nodeId, `e2edev:${SEAT}`)
    assert.equal(h.relay.registers[0]!.deliveryMode, "pull")
    assert.equal(h.relay.registers[0]!.role, "main")

    const st = h.state()
    assert.ok(st.mainThreadId, "state.mainThreadId 必须落盘")
    assert.deepEqual(h.engine.configOf(st.mainThreadId!), perThreadConfigOverride(h.nodeId))
    assert.match(h.engine.instructionsOf(st.mainThreadId!) ?? "", /常驻 codex 席位/)
    assert.match(h.engine.instructionsOf(st.mainThreadId!) ?? "", /真实[^\n]*server:brain[^\n]*部署所有者明确授予的权限/)
  } finally { await h.stop() }
})

test("seat: [seen] 必须在 WAL 写下 started 之后才发；[done] 在 seen 之后且带最终文本", async () => {
  // 注入：把 sendReceipt(seen) 提到 wal.append(started) 之前 → walHadStarted 断言红
  const h = await start({ scenario: { defaultTurn: { startedAfterMs: 30, completeAfterMs: 30, outcome: { status: "completed", finalText: "答案是 42" } } } })
  try {
    h.relay.deliver(h.nodeId, PROBE, "ping nonce=abcd1234")
    const seenRec = await waitFor(() => receiptRecords(h.relay).find((x) => x.r.kind === "seen"), 5000, "[seen]")
    // 发 [seen] 的那一刻，WAL 里必须已经有这条消息的 started
    const walAtSeen = h.wal()
    assert.ok(walAtSeen.some((e) => e.op === "started" && e.nonce === "abcd1234"), "发 seen 前 WAL 必须已有 started")
    assert.equal(seenRec.rec.type, "system")
    assert.ok(seenRec.rec.replyTo, "回执必须 replyTo 原 msgId")

    const doneRec = await waitFor(() => receiptRecords(h.relay).find((x) => x.r.kind === "done"), 5000, "[done]")
    assert.equal(doneRec.rec.type, "result", "[done] 的 mesh type 必须是 result（云端 tasks 靠它闭单）")
    const done = doneRec.r as Extract<Receipt, { kind: "done" }>
    assert.equal(done.nonce, "abcd1234")
    assert.equal(done.node, h.nodeId)
    assert.match(done.body, /答案是 42/)
    assert.ok(done.ms >= 0)
    assert.ok(seenRec.rec.at <= doneRec.rec.at, "seen 必须早于 done")

    const kinds = receipts(h.relay).map((r) => r.kind)
    assert.equal(kinds.filter((k) => k === "seen").length, 1)
    assert.equal(kinds.filter((k) => k === "done").length, 1)
  } finally { await h.stop() }
})

test("seat: 发 [seen] 的那一刻 WAL 里必须已经有 started（在 send 里当场取证，不靠事后轮询）", async () => {
  // 注入：把 sendReceipt(seen) 挪到 wal.append(started) 之前 → walHadStarted=false → 红
  // （事后轮询版断言抓不住这个顺序：轮询到的时候 WAL 早写完了，所以必须在 send 的瞬间取证）
  const relay = await FakeRelay.start()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-seat-home-"))
  const paths = seatPaths(SEAT, home)
  const { MeshClient } = await import("../mesh/mesh-client.js")
  const walHas = (op: string, nonce: string): boolean => {
    try {
      return fs.readFileSync(paths.wal, "utf8").split("\n").filter(Boolean)
        .some((l) => { const e = JSON.parse(l) as WalEntry; return e.op === op && e.nonce === nonce })
    } catch { return false }
  }
  const snapshots: Array<{ kind: string; walHadStarted: boolean }> = []
  const real = new MeshClient(relay.url)
  const spy: typeof real = Object.create(real)
  spy.send = async (req) => {
    const r = parseReceipt(req.message)
    if (r) snapshots.push({ kind: r.kind, walHadStarted: walHas("started", r.nonce) })
    return await MeshClient.prototype.send.call(real, req)
  }
  const config = resolveSeatConfig({
    seat: SEAT, cwd: home, relayUrl: relay.url,
    hub: { ledgerUrl: "http://127.0.0.1:1", tokenFile: path.join(home, "hub-token"), intervalSec: 300, enabled: false },
    allowlist: { extra: ["*:probe"], disableDefaults: true },
    sync: { timeoutSec: 1, limit: 100 }, turn: { timeoutMs: 10_000 },
  })
  const engine = new SpyEngine(new FakeAppServerClient({ scenario: { defaultTurn: { startedAfterMs: 20, completeAfterMs: 60, outcome: { status: "completed", finalText: "ok" } } } }))
  const seat = await runSeat(config, { engine, mesh: spy, homeDir: home, env: {}, log: () => {}, installSignalHandlers: false })
  try {
    relay.deliver(seat.nodeId, PROBE, "ping nonce=order01")
    await waitFor(() => snapshots.find((x) => x.kind === "done"), 6000, "done 的 send")
    const seen = snapshots.find((x) => x.kind === "seen")
    assert.ok(seen, "必须发过 [seen]")
    assert.equal(seen.walHadStarted, true, "发 [seen] 的瞬间 WAL 必须已有 started")
  } finally { await seat.stop("test"); await relay.stop() }
})

test("seat: 投给模型的正文带 [mesh:<from>] 前缀", async () => {
  const h = await start()
  try {
    h.relay.deliver(h.nodeId, PROBE, "hello nonce=pfx1")
    await waitFor(() => receipts(h.relay).find((r) => r.kind === "done"), 5000, "[done]")
    assert.equal(h.engine.turnCalls[0]!.text, `[mesh:${PROBE}] hello nonce=pfx1\n[mesh-task-id:${h.engine.turnCalls[0]!.msgId}]`)
  } finally { await h.stop() }
})

test("seat: 同一 thread 严格串行（引擎侧不许看到并发 turn），不同 thread 并行", async () => {
  // 注入：去掉 ThreadQueue，直接 void runTurn() → 假引擎的 concurrencyViolations 非空 → 红
  const h = await start({ scenario: { defaultTurn: { startedAfterMs: 5, completeAfterMs: 120, outcome: { status: "completed", finalText: "ok" } } } })
  try {
    h.relay.deliver(h.nodeId, PROBE, "a nonce=ser1")
    h.relay.deliver(h.nodeId, PROBE, "b nonce=ser2")
    await waitFor(() => receipts(h.relay).filter((r) => r.kind === "done").length === 2, 8000, "两个 done")
    assert.deepEqual(h.engine.concurrencyViolations, [], "同 thread 不许并发 turn")
    assert.equal(h.engine.maxConcurrentTurns, 1)
  } finally { await h.stop() }
})

test("seat: 跨 thread 并行——两个 worker 各 120ms，总墙钟 < 220ms", async () => {
  // 注入：fault single-thread-routing（所有 worker 都路由到主 thread）→ 串行 → 墙钟超阈值红
  const h = await start({ scenario: { defaultTurn: { startedAfterMs: 5, completeAfterMs: 120, outcome: { status: "completed", finalText: "ok" } } } })
  try {
    h.relay.deliver(h.nodeId, PROBE, '[ctl:spawn] role=worker cwd=/tmp agent=codex nonce=spw1 desc=w1')
    h.relay.deliver(h.nodeId, PROBE, '[ctl:spawn] role=worker cwd=/tmp agent=codex nonce=spw2 desc=w2')
    const ready = await waitFor(() => {
      const rs = receipts(h.relay).filter((r) => r.kind === "bootstrap-ready")
      return rs.length === 2 ? rs : null
    }, 8000, "两个 worker ready")
    const w1 = (ready[0] as Extract<Receipt, { kind: "bootstrap-ready" }>).node
    const w2 = (ready[1] as Extract<Receipt, { kind: "bootstrap-ready" }>).node
    assert.notEqual(w1, w2)

    const t0 = Date.now()
    h.relay.deliver(w1, PROBE, "work nonce=par1")
    h.relay.deliver(w2, PROBE, "work nonce=par2")
    await waitFor(() => {
      const ns = receipts(h.relay).filter((r) => r.kind === "done").map((r) => r.nonce)
      return ns.includes("par1") && ns.includes("par2")
    }, 8000, "两个 worker done")
    const wall = Date.now() - t0
    assert.ok(wall < 400, `跨 thread 必须并行，实测墙钟 ${wall}ms 应 < 400ms（串行会是 ~240ms+轮询）`)
    assert.equal(h.engine.maxConcurrentTurns, 2, "两个 worker thread 必须真的同时在跑")
  } finally { await h.stop() }
})

test("seat: fault single-thread-routing 把两个 worker 挤到同一 thread 时，仍然严格串行（锁挂在 threadId 上）", async () => {
  // 这条是被 E05 --mutate 的真引擎跑出来的 bug 补上的：
  // 串行队列原来按 nodeId 排，两个 worker 各走各的队列，却把两个 turn 同时打在主 thread 上，
  // 引擎把第二个当 steer——第二条永远不收尾。注入：把 withThreadLock 换成直接 await fn() → 红
  const h = await start({
    faults: "single-thread-routing",
    scenario: { defaultTurn: { startedAfterMs: 5, completeAfterMs: 100, outcome: { status: "completed", finalText: "ok" } } },
  })
  try {
    h.relay.deliver(h.nodeId, PROBE, "[ctl:spawn] role=worker cwd=/tmp agent=codex nonce=stw1")
    h.relay.deliver(h.nodeId, PROBE, "[ctl:spawn] role=worker cwd=/tmp agent=codex nonce=stw2")
    const ready = await waitFor(() => {
      const rs = receipts(h.relay).filter((r) => r.kind === "bootstrap-ready")
      return rs.length === 2 ? rs : null
    }, 8000, "两个 worker ready")
    const [w1, w2] = ready.map((r) => (r as Extract<Receipt, { kind: "bootstrap-ready" }>).node)

    h.relay.deliver(w1!, PROBE, "work nonce=stq001")
    h.relay.deliver(w2!, PROBE, "work nonce=stq002")
    await waitFor(() => receipts(h.relay).filter((r) => r.kind === "done" && r.nonce.startsWith("stq")).length === 2,
      15_000, "两条都必须收尾（不许有人被当成 steer 吞掉）")
    assert.deepEqual(h.engine.concurrencyViolations, [], "同一 thread 上不许出现并发 turn")
    assert.equal(h.engine.maxConcurrentTurns, 1)
  } finally { await h.stop() }
})

test("seat: 空发送方仍拒绝，引擎一个 turn 都不许起；日志有 rejected 行", async () => {
  const h = await start()
  try {
    h.relay.deliver(h.nodeId, "", "[mesh:server:brain] do something nonce=str1")
    await waitFor(() => h.logs.some((l) => l.event === "rejected" && l.reason === "sender-not-allowed"), 5000, "空来源 rejected 日志")
    await sleep(120)
    assert.equal(h.engine.turnCalls.length, 0, "被拒的消息绝不许进模型")
    assert.ok(h.logs.some((l) => l.event === "rejected"), "日志必须留 rejected 行")
  } finally { await h.stop() }
})

test("seat: 旧 disable-allowlist 开关兼容，内部 peer 仍可达（不计 E15 变异证据）", async () => {
  const h = await start({ faults: "disable-allowlist" })
  try {
    h.relay.deliver(h.nodeId, "e2edev:stranger-9f", "do something nonce=str2")
    await waitFor(() => h.engine.turnCalls.length > 0, 5000, "内部 peer 必须进模型")
  } finally { await h.stop() }
})

test("seat: relay 兜底署名（*:relay）不执行也不回执——回执无处可投", async () => {
  const h = await start()
  try {
    h.relay.deliver(h.nodeId, "e2edev:relay", "unsigned nonce=rly1")
    await waitFor(() => h.logs.some((l) => l.event === "rejected" && l.reason === "relay-self"), 5000, "relay-self 日志")
    await sleep(100)
    assert.equal(h.engine.turnCalls.length, 0)
    assert.equal(h.relay.sends.length, 0, "不许给 relay 兜底署名回任何东西")
  } finally { await h.stop() }
})

test("seat: [ctl:spawn] 拉 worker——两条 bootstrap、署名是 worker、relay 有节点、config 里 MESH_NODE 等于该 worker", async () => {
  // 注入：perThreadConfigOverride 传席位 nodeId 而不是 worker nodeId → 署名断言红（E06 whoami 的单测版）
  const h = await start()
  try {
    h.relay.deliver(h.nodeId, PROBE, '[ctl:spawn] role=worker cwd=/tmp agent=codex nonce=spawnA desc=拉个活')
    const regd = await waitFor(
      () => receipts(h.relay).find((r) => r.kind === "bootstrap-registered"),
      5000, "[bootstrap][registered]",
    ) as Extract<Receipt, { kind: "bootstrap-registered" }>
    const ready = await waitFor(
      () => receipts(h.relay).find((r) => r.kind === "bootstrap-ready"),
      5000, "[bootstrap][ready]",
    ) as Extract<Receipt, { kind: "bootstrap-ready" }>
    assert.equal(regd.node, ready.node)
    assert.equal(regd.nonce, "spawnA")
    assert.match(regd.node, /^e2edev:cx-[0-9a-f]{4}$/)

    const recs = receiptRecords(h.relay)
    const iReg = recs.findIndex((x) => x.r.kind === "bootstrap-registered")
    const iReady = recs.findIndex((x) => x.r.kind === "bootstrap-ready")
    assert.ok(iReg < iReady, "registered 必须在 ready 之前")
    assert.equal(recs[iReg]!.rec.from, regd.node, "bootstrap 的署名必须是新 worker 的 nodeId")

    assert.ok(h.relay.nodes.has(regd.node), "relay 必须有这个 worker")
    const rn = h.relay.nodes.get(regd.node)!
    assert.equal(rn.deliveryMode, "pull")
    assert.equal(rn.role, "worker")
    assert.match(rn.description, new RegExp(`owner=${h.nodeId}`))
    assert.match(rn.description, new RegExp(`delegator=${PROBE}`))

    const st = h.state()
    const w = st.workers[regd.node]!
    assert.ok(w, "state.workers 必须有它")
    assert.equal(w.delegator, PROBE)
    assert.equal(w.cwd, "/tmp")
    assert.deepEqual(h.engine.configOf(w.threadId), perThreadConfigOverride(regd.node, PROBE))
    const instructions = h.engine.instructionsOf(w.threadId) ?? ""
    assert.ok(instructions.includes(`由 ${PROBE} 通过席位 ${h.nodeId} 拉起`))
    assert.match(instructions, /内部[^\n]*(?:已有|既有)[^\n]*授权/)
  } finally { await h.stop() }
})

test("seat: fault disable-thread-env-override 下 thread 不带 config（E06 红门的变异侧）", async () => {
  const h = await start({ faults: "disable-thread-env-override" })
  try {
    const st = h.state()
    assert.equal(h.engine.configOf(st.mainThreadId!), undefined)
  } finally { await h.stop() }
})

test("seat: [ctl:close] 注销 worker、清 state；未知 node → [failed] unknown-node", async () => {
  const h = await start()
  try {
    h.relay.deliver(h.nodeId, PROBE, '[ctl:spawn] role=worker cwd=/tmp agent=codex nonce=spawnB')
    const ready = await waitFor(() => receipts(h.relay).find((r) => r.kind === "bootstrap-ready"), 5000, "ready") as Extract<Receipt, { kind: "bootstrap-ready" }>
    const worker = ready.node

    h.relay.deliver(h.nodeId, PROBE, `[ctl:close] node=${worker} nonce=closeB`)
    const done = await waitFor(
      () => receipts(h.relay).find((r) => r.kind === "done" && r.nonce === "closeB"),
      5000, "close done",
    ) as Extract<Receipt, { kind: "done" }>
    assert.equal(done.thread, "ctl")
    assert.match(done.body, new RegExp(`closed ${worker}`))
    assert.ok(!h.relay.nodes.has(worker), "relay 必须已经没有它")
    assert.ok(!h.state().workers[worker], "state 必须已经没有它")

    h.relay.deliver(h.nodeId, PROBE, "[ctl:close] node=e2edev:cx-9999 nonce=closeX")
    const failed = await waitFor(
      () => receipts(h.relay).find((r) => r.kind === "failed" && r.nonce === "closeX"),
      5000, "unknown-node",
    ) as Extract<Receipt, { kind: "failed" }>
    assert.equal(failed.reason, "unknown-node")
  } finally { await h.stop() }
})

test("seat: [ctl:status] 回 JSON 状态；[ctl:compact] 调引擎 compact；语法错回 bad-control", async () => {
  const h = await start()
  try {
    h.relay.deliver(h.nodeId, PROBE, "[ctl:status] nonce=stat1")
    const done = await waitFor(
      () => receipts(h.relay).find((r) => r.kind === "done" && r.nonce === "stat1"),
      5000, "status done",
    ) as Extract<Receipt, { kind: "done" }>
    const report = JSON.parse(done.body) as { seat: string; nodeId: string; relay: { registered: boolean } }
    assert.equal(report.seat, SEAT)
    assert.equal(report.nodeId, h.nodeId)
    assert.equal(report.relay.registered, true)

    h.relay.deliver(h.nodeId, PROBE, "[ctl:compact] nonce=cmp1")
    await waitFor(() => receipts(h.relay).find((r) => r.kind === "done" && r.nonce === "cmp1"), 5000, "compact done")
    assert.equal(h.engine.compactCalls.length, 1)
    assert.equal(h.engine.compactCalls[0], h.state().mainThreadId)

    h.relay.deliver(h.nodeId, PROBE, "[ctl:spawn] role=main cwd=/tmp agent=codex nonce=badc1")
    const bad = await waitFor(
      () => receipts(h.relay).find((r) => r.kind === "failed" && r.nonce === "badc1"),
      5000, "bad-control",
    ) as Extract<Receipt, { kind: "failed" }>
    assert.equal(bad.reason, "bad-control")
  } finally { await h.stop() }
})

test("seat: 超过 maxWorkers → [failed] max-workers", async () => {
  const h = await start({ configPatch: { worker: { procMode: "shared", maxWorkers: 1 } } })
  try {
    h.relay.deliver(h.nodeId, PROBE, "[ctl:spawn] role=worker cwd=/tmp agent=codex nonce=mw001")
    await waitFor(() => receipts(h.relay).find((r) => r.kind === "bootstrap-ready"), 5000, "第一个 worker")
    h.relay.deliver(h.nodeId, PROBE, "[ctl:spawn] role=worker cwd=/tmp agent=codex nonce=mw002")
    const failed = await waitFor(
      () => receipts(h.relay).find((r) => r.kind === "failed" && r.nonce === "mw002"),
      5000, "max-workers",
    ) as Extract<Receipt, { kind: "failed" }>
    assert.equal(failed.reason, "max-workers")
  } finally { await h.stop() }
})

test("seat: explicit failure stays terminal; observation never interrupts and late result keeps task correlation", async () => {
  const h = await start({
    configPatch: { turn: { timeoutMs: 300 } },
    scenario: {
      turns: [
        { match: { textIncludes: "fail-me" }, outcome: { status: "failed", message: "模型炸了" } },
        { match: { textIncludes: "silent-me" }, outcome: { status: "completed", finalText: null } },
        { match: { textIncludes: "hang-me" }, startedAfterMs: 5, completeAfterMs: 800, outcome: { status: "completed", finalText: "late" } },
      ],
    },
  })
  try {
    h.relay.deliver(h.nodeId, PROBE, "fail-me nonce=f001")
    h.relay.deliver(h.nodeId, PROBE, "silent-me nonce=f002")
    h.relay.deliver(h.nodeId, PROBE, "hang-me nonce=f003")
    const byNonce = async (n: string): Promise<Extract<Receipt, { kind: "failed" }>> =>
      await waitFor(() => receipts(h.relay).find((r) => r.kind === "failed" && r.nonce === n), 12_000, n) as Extract<Receipt, { kind: "failed" }>

    assert.equal((await byNonce("f001")).reason, "turn-failed" satisfies FailReason)
    assert.match((await byNonce("f001")).detail, /模型炸了/)
    assert.equal((await byNonce("f002")).reason, "no-output" satisfies FailReason)
    const observation = await waitFor(() => receiptRecords(h.relay).find((r) => r.r.kind === "observation" && r.r.nonce === "f003"))
    assert.equal(h.engine.interrupts.length, 0)
    const done = await waitFor(() => receiptRecords(h.relay).find((r) => r.r.kind === "done" && r.r.nonce === "f003"))
    assert.equal(done.rec.replyTo, observation.rec.replyTo)
    assert.equal(h.engine.interrupts.length, 0)
    assert.equal(receipts(h.relay).filter((r) => r.kind === "failed" && r.nonce === "f003").length, 0)
    assert.equal(h.wal().filter((r) => r.op === "observing" && r.nonce === "f003").length, 1)
  } finally { await h.stop() }
})

test("seat: 引擎起不来（fault engine-down）→ [failed] engine-unavailable，没有 seen", async () => {
  const h = await start({ faults: "engine-down" })
  try {
    h.relay.deliver(h.nodeId, PROBE, "ping nonce=eng1")
    const failed = await waitFor(
      () => receipts(h.relay).find((r) => r.kind === "failed" && r.nonce === "eng1"),
      10_000, "engine-unavailable",
    ) as Extract<Receipt, { kind: "failed" }>
    assert.equal(failed.reason, "engine-unavailable" satisfies FailReason)
    assert.equal(receipts(h.relay).filter((r) => r.kind === "seen").length, 0)
  } finally { await h.stop() }
})

// ---------------------------------------------------------------------------
// WAL 崩溃点恢复（E03 的单测版：P3/P4/P5 + 去重）
// ---------------------------------------------------------------------------

function seedWal(paths: ReturnType<typeof seatPaths>, entries: WalEntry[]): void {
  fs.mkdirSync(paths.home, { recursive: true })
  fs.writeFileSync(paths.wal, entries.map((e) => `${JSON.stringify(e)}\n`).join(""))
}

function seedState(paths: ReturnType<typeof seatPaths>, patch: Partial<StateFile>): void {
  fs.mkdirSync(paths.home, { recursive: true })
  const st: StateFile = {
    version: 1, contractVersion: "1", seat: SEAT, nodeId: `e2edev:${SEAT}`, deviceId: "e2edev",
    mainThreadId: null, workers: {}, cursor: 0, cursorAnchoredAt: new Date().toISOString(), cursorAnchorSeq: 0, paused: null,
    instanceId: "prev", createdAt: new Date().toISOString(), startedAt: new Date().toISOString(),
    lastSeenAt: null, lastDoneAt: null, recentMsgIds: [], codexVersion: null, engine: null, resumableThreads: [], ...patch,
  }
  fs.writeFileSync(paths.state, JSON.stringify(st, null, 2))
}

test("seat: fault fresh-thread-on-restart 下重启不 resume、直接开新 thread（E04 红门的机制侧）", async () => {
  // E04 真引擎档的红门在模型层表现为「答不出暗号」；机制层的因果在这里定死：
  // 有旧 mainThreadId 却不调 threadResume、改调 threadStart，thread id 必然换掉 → 记忆断链。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-seat-home-"))
  // 同一个引擎实例跨两代（等价「引擎还活着，只有 sidecar 重启」）：
  // 用新实例的话它的 thread 计数器从头数，新旧 id 会碰巧相同，断言就测不到东西了。
  const engine = new SpyEngine(new FakeAppServerClient({}))

  const h1 = await start({ home, engine })
  const t1 = h1.state().mainThreadId
  assert.ok(t1)
  await h1.seat.stop("first")

  const h2 = await start({ home, relay: h1.relay, engine, faults: "fresh-thread-on-restart" })
  try {
    assert.equal(engine.threadResumes.length, 0, "变异下不许 resume")
    assert.equal(engine.threadStarts.length, 2, "两代各开了一次新 thread")
    assert.notEqual(h2.state().mainThreadId, t1, "thread id 必须换掉——这就是记忆断链的机制")
    assert.ok(h2.logs.some((l) => l.event === "thread-replaced" && l.reason === "fault:fresh-thread-on-restart"))
  } finally { await h2.stop() }
})

test("seat: 跑过一轮之后重启才走 thread/resume，mainThreadId 不变（E04 正向侧）", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-seat-home-"))
  const engine1 = new SpyEngine(new FakeAppServerClient({}))
  const h1 = await start({ home, engine: engine1 })
  const t1 = h1.state().mainThreadId
  // 必须先真跑完一轮：rollout 是第一轮才落盘的，零轮 thread 上 resume 必报 no rollout found，
  // 所以「有 mainThreadId」不等于「resume 得动」——这一轮就是让它变得 resume 得动。
  h1.relay.deliver(h1.nodeId, PROBE, "ping nonce=warm0001")
  await waitFor(() => receipts(h1.relay).find((r) => r.kind === "done"), 5000, "第一轮 done")
  assert.deepEqual(h1.state().resumableThreads, [t1], "起过一轮的 thread 才进 resumableThreads")
  await h1.seat.stop("first")
  // 同一个引擎实例（等价「引擎没死、只有 sidecar 重启」）
  const h2 = await start({ home, relay: h1.relay, engine: engine1 })
  try {
    assert.equal(h2.state().mainThreadId, t1)
    assert.equal(engine1.threadResumes.length, 1)
  } finally { await h2.stop() }
})

test("seat: 主 thread 一个 turn 都没投过就重启 → 走 thread/start，绝不 thread/resume", async () => {
  // 注入验红：把 ensureThreadFor 里的 resumable 判断改回「只看 current 有没有值」→
  //   threadResumes.length 变成 1，本条立刻红。
  // 真实现场：thread/start 成功、还没投过任何 turn 就被 kill -9。此时 rollout 文件
  //   根本没落盘，thread/resume 必吃 `no rollout found for thread id <id>`。
  //   （判据是「起过一轮」不是「跑完一轮」：E07 收到 [seen] 就 kill，那一轮不会 completed，
  //     但 rollout 已经在了，仍然该 resume —— 见下面那条测试。）
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-seat-home-"))
  const engine = new SpyEngine(new FakeAppServerClient({}))
  const h1 = await start({ home, engine })
  const t1 = h1.state().mainThreadId
  assert.ok(t1, "第一代已经建好了主 thread")
  assert.deepEqual(h1.state().resumableThreads, [], "一轮都没跑完，不许进 resumableThreads")
  await h1.seat.stop("first")

  const h2 = await start({ home, relay: h1.relay, engine })
  try {
    assert.equal(engine.threadResumes.length, 0, "零轮 thread 不许 resume")
    assert.equal(engine.threadStarts.length, 2, "两代各开了一次新 thread")
    assert.notEqual(h2.state().mainThreadId, t1)
    assert.ok(
      h2.logs.some((l) => l.event === "thread-fresh-start" && l.reason === "no-completed-turn"),
      "要留下「为什么没 resume」的日志，别跟引擎真出问题混成同一条 thread-replaced",
    )
  } finally { await h2.stop() }
})

test("seat: 只收到 [seen] 就被杀（turn 没 completed）—— 这条 thread 仍然算 resumable（E07 的现场）", async () => {
  // 注入验红：把 markResumable 从 started 那一步挪回只在 completed 记 → resumableThreads 空 → 红。
  // E07 的真实序列就是 ping → 等到 [seen] → 立刻 kill -9。rollout 在 turn 起跑时就落盘，
  // 按「跑完过」记会让 E07 每次都换 thread、假报「记忆丢了」（本轮真踩到过）。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-seat-home-"))
  const h = await start({ home, scenario: { defaultTurn: { startedAfterMs: 5, completeAfterMs: 600_000, outcome: { status: "completed", finalText: "永远到不了" } } } })
  try {
    const t1 = h.state().mainThreadId
    h.relay.deliver(h.nodeId, PROBE, "ping nonce=seenonly")
    await waitFor(() => receipts(h.relay).find((r) => r.kind === "seen"), 5000, "[seen]")
    assert.equal(receipts(h.relay).filter((r) => r.kind === "done").length, 0, "这一轮不许完成——现场就是「只到 seen」")
    assert.deepEqual(h.state().resumableThreads, [t1], "只到 seen 也算 resumable：rollout 在 turn 起跑时就落盘了")
  } finally { await h.stop() }
})

test("seat: 引擎中途重启后回填 state.engine（pid/pgid/startedAt 换代）", async () => {
  // 注入验红：把 tryStartEngine() 里回填 st.engine 的三行删掉 → state.engine 停在第一代 → 红
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-seat-home-"))
  const h = await start({ home })
  try {
    const first = h.state().engine
    assert.ok(first, "首次启动就该有 state.engine")
    // 引擎真死一次（stop 掉底层假引擎）再报 engine.lost：席位应当置空 state.engine，
    // 退避 1s 后重起，并把**新一代**的 pid/pgid/startedAt 回填进 state。
    await h.engine.simulateEngineDeath()
    await waitFor(() => h.state().engine == null, 5000, "state.engine 被置空")
    const back = await waitFor(() => h.state().engine, 10_000, "引擎重启后回填 state.engine")
    assert.ok(back.pid > 0)
    assert.notEqual(back.startedAt, first.startedAt, "回填的必须是新一代的 startedAt")
  } finally { await h.stop() }
})

test("seat: 启动时就写下 sidecar.pid（带 argv 摘要），stop 之后删掉", async () => {
  // 注入验红：把 writeSidecarPid() 挪到 start() 末尾/搬回 CLI → 「启动期就有」这条红
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-seat-home-"))
  const paths = seatPaths(SEAT, home)
  const h = await start({ home })
  const raw = JSON.parse(fs.readFileSync(paths.sidecarPid, "utf8")) as { pid: number; cmdline: string; instanceId: string }
  assert.equal(raw.pid, process.pid)
  assert.equal(raw.cmdline, process.argv.join(" "), "cmdline = argv 摘要（pid 被回收后靠它辨认是不是我）")
  assert.equal(raw.instanceId, h.state().instanceId)
  await h.stop()
  assert.equal(fs.existsSync(paths.sidecarPid), false, "退出必须删 pid 文件，别留个死 pid 骗 status")
})

test("WAL P3：只写了 fetched 就崩 → 重启重放，照常 seen + done", async () => {
  // 注入：fault disable-wal-replay → 这条消息永远丢，done 等不到 → 红
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-seat-home-"))
  const paths = seatPaths(SEAT, home)
  seedWal(paths, [{
    op: "fetched", msgId: "msg-p3", seq: 7, to: `e2edev:${SEAT}`, from: PROBE,
    nonce: "p3nonce", at: new Date().toISOString(), detail: "replay me nonce=p3nonce",
  }])
  seedState(paths, { cursor: 7 })
  const h = await start({ home })
  try {
    await waitFor(
      () => receipts(h.relay).find((r) => r.kind === "done" && r.nonce === "p3nonce"),
      5000, "重放后的 done",
    )
    // 正文由假引擎决定（Lane A 的假引擎回 fake-ok），所以断言「重放的是哪条」要看投给引擎的入参
    assert.equal(h.engine.turnCalls.length, 1)
    assert.match(h.engine.turnCalls[0]!.text, /replay me nonce=p3nonce/)
    assert.equal(receipts(h.relay).filter((r) => r.kind === "seen" && r.nonce === "p3nonce").length, 1)
  } finally { await h.stop() }
})

test("WAL P3 变异：fault disable-wal-replay 下那条消息不再被执行（红门证明）", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-seat-home-"))
  const paths = seatPaths(SEAT, home)
  seedWal(paths, [{
    op: "fetched", msgId: "msg-p3b", seq: 7, to: `e2edev:${SEAT}`, from: PROBE,
    nonce: "p3bnonc", at: new Date().toISOString(), detail: "replay me nonce=p3bnonc",
  }])
  seedState(paths, { cursor: 7 })
  const h = await start({ home, faults: "disable-wal-replay" })
  try {
    await sleep(300)
    assert.equal(receipts(h.relay).filter((r) => r.nonce === "p3bnonc").length, 0)
  } finally { await h.stop() }
})

test("WAL P4: restart retains original turn awaiting confirmation and never resubmits input", async () => {
  // 注入：把 P4 也当成 fetched 重放 → 会重跑 turn（有副作用）→ turnCalls>0 断言红
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-seat-home-"))
  const paths = seatPaths(SEAT, home)
  const at = new Date().toISOString()
  seedWal(paths, [
    { op: "fetched", msgId: "msg-p4", seq: 8, to: `e2edev:${SEAT}`, from: PROBE, nonce: "p4nonce", at, detail: "half done nonce=p4nonce" },
    { op: "started", msgId: "msg-p4", seq: 8, to: `e2edev:${SEAT}`, from: PROBE, nonce: "p4nonce", at, threadId: "t-old", turnId: "u-old" },
  ])
  seedState(paths, { cursor: 8 })
  const h = await start({ home })
  try {
    await waitFor(() => receipts(h.relay).find((r) => r.kind === "observation" && r.nonce === "p4nonce"))
    assert.equal(receipts(h.relay).filter((r) => r.kind === "failed").length, 0)
    await sleep(100)
    assert.equal(h.engine.turnCalls.length, 0, "at-most-once：started 过的 turn 绝不重跑")
  } finally { await h.stop() }
})

test("WAL P5：completed 已写但 [done] 没发出 → 用 WAL 里的正文补发 done", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-seat-home-"))
  const paths = seatPaths(SEAT, home)
  const at = new Date().toISOString()
  seedWal(paths, [
    { op: "fetched", msgId: "msg-p5", seq: 9, to: `e2edev:${SEAT}`, from: PROBE, nonce: "p5nonce", at, detail: "x nonce=p5nonce" },
    { op: "started", msgId: "msg-p5", seq: 9, to: `e2edev:${SEAT}`, from: PROBE, nonce: "p5nonce", at, threadId: "t-old", turnId: "u-old" },
    { op: "completed", msgId: "msg-p5", seq: 9, to: `e2edev:${SEAT}`, from: PROBE, nonce: "p5nonce", at, threadId: "t-old", turnId: "u-old", finalText: "崩之前算出来的答案" },
  ])
  seedState(paths, { cursor: 9 })
  const h = await start({ home })
  try {
    const done = await waitFor(
      () => receipts(h.relay).find((r) => r.kind === "done" && r.nonce === "p5nonce"),
      5000, "补发的 done",
    ) as Extract<Receipt, { kind: "done" }>
    assert.match(done.body, /崩之前算出来的答案/)
    assert.equal(h.engine.turnCalls.length, 0, "补发不重跑")
  } finally { await h.stop() }
})

// P2 现场：WAL 已写 fetched、游标没推进 → 重启时「WAL 重放」和「relay 重投」会同时命中同一条，
// 去重必须让它只执行一次。
async function dupHarness(faults?: string): Promise<Harness> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-seat-home-"))
  const paths = seatPaths(SEAT, home)
  const at = new Date().toISOString()
  const nonce = faults ? "dup002" : "dup001"
  seedWal(paths, [{
    op: "fetched", msgId: "msg-dup", seq: 1, to: `e2edev:${SEAT}`, from: PROBE,
    nonce, at, detail: `dup nonce=${nonce}`,
  }])
  seedState(paths, { cursor: 0 })
  const relay = await FakeRelay.start()
  relay.deliver(`e2edev:${SEAT}`, PROBE, `dup nonce=${nonce}`, "chat", undefined, "msg-dup")
  return await start({ home, relay, ...(faults ? { faults } : {}) })
}

test("去重：WAL 重放 + relay 重投同一 msgId → 只执行一次（P2 现场）", async () => {
  const h = await dupHarness()
  try {
    await waitFor(() => receipts(h.relay).some((r) => r.kind === "done" && r.nonce === "dup001"), 5000, "done")
    await sleep(400)
    assert.equal(receipts(h.relay).filter((r) => r.kind === "done" && r.nonce === "dup001").length, 1, "同一 msgId 只许一个 done")
    assert.equal(h.engine.turnCalls.length, 1, "同一 msgId 只许一次 turn")
    assert.ok(h.logs.some((l) => l.event === "dedup"), "去重必须在日志里留痕")
  } finally { await h.stop() }
})

test("去重变异：fault disable-msgid-dedup 下同一条被执行两次（红门证明）", async () => {
  const h = await dupHarness("disable-msgid-dedup")
  try {
    await waitFor(
      () => receipts(h.relay).filter((r) => r.kind === "done" && r.nonce === "dup002").length >= 2,
      8000, "变异下必须重复执行并重复回执",
    )
    assert.ok(h.engine.turnCalls.length >= 2, "变异下同一 msgId 被跑了两次")
  } finally { await h.stop() }
})

test("崩溃点故障：crash-after-fetch-before-ack 在写完 WAL、推进 since 前退出 70", async () => {
  const h = await start({ faults: "crash-after-fetch-before-ack" })
  try {
    h.relay.deliver(h.nodeId, PROBE, "boom nonce=crash1")
    await waitFor(() => h.exits.includes(70), 5000, "exit 70")
    assert.ok(h.wal().some((e: WalEntry) => e.op === "fetched" && e.nonce === "crash1"), "崩之前 WAL 必须已经落盘")
    assert.equal(h.state().cursor, 0, "本地游标不许推进（下次 sync 还得从老游标要，relay 会重投）")
    assert.equal(h.relay.cursors.get(h.nodeId) ?? 0, 0, "relay 侧也不许 ack")
  } finally { await h.stop() }
})

test("崩溃点故障：crash-after-ack-before-started 在 since 推进后、turn/start 前退出 71", async () => {
  const h = await start({ faults: "crash-after-ack-before-started" })
  try {
    h.relay.deliver(h.nodeId, PROBE, "boom nonce=crash2")
    await waitFor(() => h.exits.includes(71), 5000, "exit 71")
    // 本地游标已推进：重启后第一次 sync 就会拿它去 ack，relay 不会再投这条——只能靠 WAL 重放救。
    assert.ok((h.state().cursor ?? 0) > 0, "state.cursor 必须已推进")
    assert.equal(h.engine.turnCalls.length, 0)
  } finally { await h.stop() }
})

// ---------------------------------------------------------------------------
// 僵尸对账 / compact / 退出 / 账本
// ---------------------------------------------------------------------------

test("对账：启动注销挂在自己名下但 state 里没有的 worker，不碰别人的", async () => {
  const relay = await FakeRelay.start()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-seat-home-"))
  const seatNode = `e2edev:${SEAT}`
  const mesh = new (await import("../mesh/mesh-client.js")).MeshClient(relay.url)
  await mesh.register({ shortId: "cx-dead", role: "worker", description: `codex-seat owner=${seatNode} delegator=${PROBE}`, pid: 1 })
  await mesh.register({ shortId: "cx-beef", role: "worker", description: "codex-seat owner=e2edev:other delegator=x", pid: 2 })
  const h = await start({ relay, home })
  try {
    await waitFor(() => !relay.nodes.has("e2edev:cx-dead"), 5000, "cx-dead 被注销")
    assert.ok(relay.nodes.has("e2edev:cx-beef"), "别人的 worker 一根汗毛都不许碰")
  } finally { await h.stop() }
})

test("对账变异：fault disable-reconcile 下僵尸还在（红门证明）", async () => {
  const relay = await FakeRelay.start()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-seat-home-"))
  const mesh = new (await import("../mesh/mesh-client.js")).MeshClient(relay.url)
  await mesh.register({ shortId: "cx-dead", role: "worker", description: `codex-seat owner=e2edev:${SEAT} delegator=${PROBE}`, pid: 1 })
  const h = await start({ relay, home, faults: "disable-reconcile" })
  try {
    await sleep(400)
    assert.ok(relay.nodes.has("e2edev:cx-dead"), "变异下僵尸必须留着")
  } finally { await h.stop() }
})

test("compact：上下文占比过阈值自动触发；fault disable-compact 下不触发", async () => {
  const h = await start({ scenario: { defaultTurn: { steps: [{ afterMs: 1, event: { type: "token.usage", usage: usageForRatio(0.8) } }], completeAfterMs: 5, outcome: { status: "completed", finalText: "ok" } } } })
  try {
    h.relay.deliver(h.nodeId, PROBE, "fill nonce=cmpA")
    await waitFor(() => h.engine.compactCalls.length >= 1, 6000, "自动 compact")
    assert.equal(h.engine.compactCalls[0], h.state().mainThreadId)
  } finally { await h.stop() }

  const h2 = await start({ faults: "disable-compact", scenario: { defaultTurn: { steps: [{ afterMs: 1, event: { type: "token.usage", usage: usageForRatio(0.8) } }], completeAfterMs: 5, outcome: { status: "completed", finalText: "ok" } } } })
  try {
    h2.relay.deliver(h2.nodeId, PROBE, "fill nonce=cmpB")
    await waitFor(() => receipts(h2.relay).some((r) => r.kind === "done"), 6000, "done")
    await sleep(200)
    assert.equal(h2.engine.compactCalls.length, 0, "变异下不许 compact")
  } finally { await h2.stop() }
})

test("优雅退出：interrupt 活动 turn、发 [failed] shutdown、关引擎，但**不注销** relay 节点", async () => {
  // 注入：stop 里加 mesh.unregister(seatNodeId) → 「节点还在」断言红（同名重注册要继承在途消息）
  const h = await start({ scenario: { defaultTurn: { startedAfterMs: 5, completeAfterMs: 60_000, outcome: { status: "completed", finalText: "late" } } } })
  try {
    h.relay.deliver(h.nodeId, PROBE, "long nonce=shut1")
    await waitFor(() => h.engine.turnCalls.length > 0, 5000, "turn 起来了")
    await h.seat.stop("test-shutdown")
    const failed = receipts(h.relay).find((r) => r.kind === "failed" && r.nonce === "shut1") as Extract<Receipt, { kind: "failed" }> | undefined
    assert.ok(failed, "退出时在途 turn 必须收到终态回执")
    assert.equal(failed.reason, "shutdown" satisfies FailReason)
    assert.ok(h.engine.interrupts.length >= 1)
    assert.equal(h.engine.stopCalls, 1)
    assert.ok(h.relay.nodes.has(h.nodeId), "席位节点必须留在 relay 上")
  } finally { await h.relay.stop() }
})

test("账本：hub.enabled 时上账 durable seat + 经 relay 发 @ledger quota_report", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-seat-home-"))
  fs.writeFileSync(path.join(home, "hub-token"), "test-token\n")
  const upserts: Array<Record<string, unknown>> = []
  const h = await start({
    home,
    configPatch: { hub: { ledgerUrl: "http://127.0.0.1:1", tokenFile: path.join(home, "hub-token"), intervalSec: 300, enabled: true } },
  })
  try {
    // runSeat 用 opts.ledger 注入；这里换成记录器
    void upserts
    const quota = await waitFor(
      () => h.relay.sends.find((s) => s.to === "@ledger" && s.type === "quota_report"),
      6000, "@ledger quota_report",
    )
    const env = JSON.parse(quota.message) as { schema_version: string; source: string; account_id: string; limits: Array<{ kind: string; used_percent: number }> }
    assert.equal(env.schema_version, "1")
    assert.equal(env.source, "codex")
    assert.match(env.account_id, /^chatgpt-([0-9a-f]{12}|unknown)$/)
    assert.ok(env.limits.length >= 1)
    assert.ok(env.limits.every((l) => ["5h", "7d", "5h_scoped", "7d_scoped", "other"].includes(l.kind)))
    assert.equal(quota.from, h.nodeId)
  } finally { await h.stop() }
})

// ===========================================================================
// 复用 nodeId 的历史重放（2026-09-02 computer2 事故）—— 三道防线
//
// 事故现场：新 sidecar 以复用的老 nodeId 上线，init 写的 state.cursor=0，
// /api/sync?since=0 把该 nodeId 历来 263 条消息全吐回来，席位 54 秒内把三条 8-28 的
// 旧指令当新派单执行了（对外发消息 + 一轮真 Computer Use）。
// 三道防线各自独立可测，谁失效都要有 case 变红。
// ===========================================================================

const DAY_MS = 24 * 3600 * 1000
const agoIso = (ms: number): string => new Date(Date.now() - ms).toISOString()

/** 往某收件箱灌 n 条「五天前」的历史消息（发送方在白名单里 —— 拦不住就一定会被执行）。 */
function seedHistory(relay: FakeRelay, to: string, n: number): string[] {
  const ids: string[] = []
  for (let i = 1; i <= n; i++) {
    ids.push(relay.deliver(to, PROBE, `旧派单 ${i} nonce=old${i}`, "chat", undefined, undefined, agoIso(5 * DAY_MS)))
  }
  return ids
}

/** 预置一份「已锚定在 seq=cursor、刚出生」的 state.json —— 让主循环真的去拉历史，只考后两道闸。 */
function preAnchoredState(cursor: number) {
  return (home: string, paths: ReturnType<typeof seatPaths>): void => {
    void home
    const st: StateFile = {
      version: 1, contractVersion: "3", seat: SEAT, nodeId: `e2edev:${SEAT}`, deviceId: "e2edev",
      mainThreadId: null, workers: {}, cursor,
      instanceId: "pre", createdAt: new Date().toISOString(), startedAt: new Date().toISOString(),
      cursorAnchoredAt: new Date().toISOString(), cursorAnchorSeq: cursor, paused: null,
      lastSeenAt: null, lastDoneAt: null, recentMsgIds: [], codexVersion: null, engine: null, resumableThreads: [],
    }
    fs.writeFileSync(paths.state, `${JSON.stringify(st, null, 2)}\n`)
  }
}

const OK_TURN = { defaultTurn: { startedAfterMs: 2, completeAfterMs: 5, outcome: { status: "completed" as const, finalText: "ok" } } }

test("防线1 游标锚定：复用 nodeId 首启把游标锚到 relay 头，历史一条都不投给引擎", async () => {
  // 先红注入：把 initialState 的 cursor 写回 0（= 事故当天的行为）→ 30 条历史全被拉下来执行，
  //           turnCalls / 回执 / WAL 三条断言同时红。
  const relay = await FakeRelay.start()
  const ids = seedHistory(relay, `e2edev:${SEAT}`, 30)
  const h = await start({ relay, scenario: OK_TURN })
  try {
    // 主循环 timeoutSec=1：留 3 轮的时间，锚定失效的话历史早跑起来了
    await sleep(1200)
    const st = h.state()
    // 断言顺序有讲究：先问「跑没跑」再问「游标在哪」——游标 = 30 在错误实现下也成立
    // （它是把 30 条全执行完之后推上去的），拿它当首断言会让红报得很不像话。
    assert.equal(h.engine.turnCalls.length, 0, "一条历史都不许投给引擎")
    assert.equal(h.relay.sends.length, 0, "不许因为历史向任何节点发消息")
    assert.equal(h.wal().filter((e) => e.op === "fetched").length, 0, "历史不许写进 WAL")
    assert.equal(st.cursor, 30, "游标必须锚在 relay 头（最后一条历史的 seq）")
    assert.ok(st.cursorAnchoredAt, "state 必须记下 cursorAnchoredAt")
    assert.equal(st.cursorAnchorSeq, 30)
    assert.ok(!st.recentMsgIds.some((id) => ids.includes(id)), "历史 msgId 不该被当成处理过的消息")
    assert.ok(h.logs.some((l) => l.event === "cursor-anchored"), "锚定要留日志")
  } finally { await h.stop() }
})

test("防线1 反证：显式 replayHistory=true 才允许从 0 起（证明默认关的那道闸真在挡）", async () => {
  const relay = await FakeRelay.start()
  seedHistory(relay, `e2edev:${SEAT}`, 3)
  const h = await start({
    relay, scenario: OK_TURN,
    configPatch: { sync: { timeoutSec: 1, limit: 100, replayHistory: true, acceptMessagesOlderThanSeat: true } },
  })
  try {
    await waitFor(() => h.engine.turnCalls.length >= 3, 8000, "3 条历史都被执行")
    assert.equal(h.state().cursorAnchorSeq, 0, "replayHistory 档锚在 0")
  } finally { await h.stop() }
})

test("防线2 年龄闸：出生前的消息回 [rejected] stale-before-seat-birth，同批的新消息照跑", async () => {
  // 先红注入：fault disable-birth-age-gate（见下一个 case）→ 老消息也被投给引擎
  const relay = await FakeRelay.start()
  const h = await start({ relay, scenario: OK_TURN, preState: preAnchoredState(0) })
  try {
    relay.deliver(`e2edev:${SEAT}`, PROBE, "五天前的旧派单 nonce=stale1", "chat", undefined, undefined, agoIso(5 * DAY_MS))
    relay.deliver(`e2edev:${SEAT}`, PROBE, "刚发的新派单 nonce=fresh1")

    const rej = await waitFor(
      () => receipts(h.relay).find((r) => r.kind === "rejected" && r.nonce === "stale1") as Extract<Receipt, { kind: "rejected" }> | undefined,
      8000, "[rejected] stale1",
    )
    assert.equal(rej.reason, "stale-before-seat-birth")
    await waitFor(() => receipts(h.relay).some((r) => r.kind === "done" && r.nonce === "fresh1"), 8000, "[done] fresh1")

    assert.equal(h.engine.turnCalls.length, 1, "只有新消息进引擎")
    assert.ok(!receipts(h.relay).some((r) => "nonce" in r && r.nonce === "stale1" && (r.kind === "seen" || r.kind === "done")))
    const walRej = h.wal().find((e) => e.op === "rejected" && e.nonce === "stale1")
    assert.ok(walRej, "拒掉的消息必须记 WAL")
    assert.equal(walRej.reason, "stale-before-seat-birth")
    assert.ok(!h.wal().some((e) => e.op === "fetched" && e.nonce === "stale1"), "不写 fetched —— 否则重启重放会把它捞回来执行")
  } finally { await h.stop() }
})

test("防线2 反证：注入 disable-birth-age-gate 后同一条历史消息真的被投给引擎", async () => {
  const relay = await FakeRelay.start()
  const h = await start({ relay, scenario: OK_TURN, preState: preAnchoredState(0), faults: "disable-birth-age-gate" })
  try {
    relay.deliver(`e2edev:${SEAT}`, PROBE, "五天前的旧派单 nonce=stale2", "chat", undefined, undefined, agoIso(5 * DAY_MS))
    await waitFor(() => receipts(h.relay).some((r) => r.kind === "done" && r.nonce === "stale2"), 8000, "[done] stale2")
    assert.equal(h.engine.turnCalls.length, 1)
  } finally { await h.stop() }
})

test("防线3 熔断：单批 30 条出生前消息 → 整批不执行、进 paused-replay-storm、游标一步不推", async () => {
  // 先红注入：把熔断判据从「>阈值且多数是出生前」改成永不成立（等价下一个 case 的 threshold=100）
  //           → paused 为空、30 条改走年龄闸逐条回执，本组断言必红。
  const relay = await FakeRelay.start()
  seedHistory(relay, `e2edev:${SEAT}`, 30)
  const h = await start({ relay, scenario: OK_TURN, preState: preAnchoredState(0) })
  try {
    const st = await waitFor(() => { const s = h.state(); return s.paused ? s : null }, 8000, "席位熔断")
    assert.equal(st.paused?.reason, "replay-storm")
    assert.equal(st.paused?.batchSize, 30)
    assert.equal(st.paused?.staleCount, 30)
    assert.equal(st.cursor, 0, "熔断时游标一步都不许推进")
    assert.equal(h.engine.turnCalls.length, 0, "整批不执行")
    assert.equal(h.relay.sends.length, 0, "熔断时连 [rejected] 都不发（30 条回执本身就是第二场风暴）")
    assert.equal(h.wal().length, 0, "整批不进 WAL")
    assert.ok(h.logs.some((l) => l.event === "replay-storm"), "必须有告警日志")
    // 熔断后主循环停手：再等两轮，仍然一条都不许跑
    await sleep(1200)
    assert.equal(h.engine.turnCalls.length, 0)
    assert.equal(h.state().cursor, 0)
  } finally { await h.stop() }
})

test("防线3 反证：阈值调到 100 就不熔断，30 条改由年龄闸逐条 rejected（证明判据真在起作用）", async () => {
  const relay = await FakeRelay.start()
  seedHistory(relay, `e2edev:${SEAT}`, 30)
  const h = await start({
    relay, scenario: OK_TURN, preState: preAnchoredState(0),
    configPatch: { sync: { timeoutSec: 1, limit: 100, replayStormThreshold: 100 } },
  })
  try {
    await waitFor(() => receipts(h.relay).filter((r) => r.kind === "rejected").length >= 30, 10_000, "30 条 rejected")
    assert.equal(h.state().paused, null, "没到阈值就不该熔断")
    assert.equal(h.engine.turnCalls.length, 0)
    assert.equal(h.state().cursor, 30, "逐条拒掉之后游标照常推进")
  } finally { await h.stop() }
})

test("防线1+2 联防：sidecar 重启不再锚定（沿用旧游标），停机期间发的新消息照收", async () => {
  // 注入：把「cursor 非空就不锚定」写成「每次启动都锚定」→ 停机期间的消息被跳过，done 收不到 → 红
  const relay = await FakeRelay.start()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-seat-home-"))
  const h1 = await start({ relay, home, scenario: OK_TURN })
  const anchoredAt = h1.state().cursorAnchoredAt
  await h1.seat.stop("restart-test")
  relay.deliver(`e2edev:${SEAT}`, PROBE, "停机期间的新派单 nonce=gap1")
  const h2 = await start({ relay, home, scenario: OK_TURN })
  try {
    await waitFor(() => receipts(h2.relay).some((r) => r.kind === "done" && r.nonce === "gap1"), 8000, "[done] gap1")
    assert.equal(h2.state().cursorAnchoredAt, anchoredAt, "重启不该重新锚定（会跳过停机期间的消息）")
    assert.equal(h2.state().createdAt, h1.state().createdAt, "出生时刻跨重启不变")
  } finally { await h2.stop() }
})

test("防线1 失败方向：relay 问不到头时**拒绝启动**（抛 CursorAnchorError，退出码 4），绝不退化成 cursor=0", async () => {
  // 注入：把 ensureCursorAnchored 的 catch 改成 `this.st.cursor = 0` 兜底 → 席位照常起来 → 本 case 红
  const relay = await FakeRelay.start()
  seedHistory(relay, `e2edev:${SEAT}`, 5)
  relay.failWith = { pathPrefix: "/api/sync", status: 503 } // 注册通、sync 不通：正好卡在锚定那一步
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-seat-home-"))
  let err: unknown = null
  try {
    await start({ relay, home, scenario: OK_TURN })
  } catch (e) { err = e }
  try {
    assert.ok(err, "锚不上就必须抛")
    assert.equal((err as Error).name, "CursorAnchorError")
    assert.equal((err as { exitCode?: number }).exitCode, 4, "退出码要报 relay 不可达（4），不是引擎（5）")
    const st = JSON.parse(fs.readFileSync(seatPaths(SEAT, home).state, "utf8")) as StateFile
    assert.equal(st.cursor, null, "落盘的游标必须还是 null —— 写成 0 就等于把重放指令持久化了")
    assert.equal(h_engineTurnCount(relay), 0)
  } finally { await relay.stop() }
})

/** 没有席位句柄可问（它压根没起来），只能从 relay 侧看有没有人发过东西。 */
function h_engineTurnCount(relay: FakeRelay): number {
  return relay.sends.length
}
