/**
 * FakeAppServerClient —— 内存假引擎，`IAppServerClient` 的另一半实现。
 *
 * 它不起进程、不烧模型额度，按 `fake-scenario.ts` 的剧本编排事件序列 / ServerRequest /
 * 延迟 / 崩溃 / tokenUsage。B/C 线的单测与 E16 用它；剧本格式在 fake-scenario.ts 顶部。
 *
 * 它照样跑 `answerForServerRequest` 那张表（含默认 -32601），所以
 * `drop-serverrequest-default` 在假引擎上也能红——E16 靠的就是这一点。
 */
import {
  type AccountInfo,
  type CompactOutcome,
  type EngineEvent,
  type EngineInfo,
  type EngineStopOptions,
  type FaultName,
  type IAppServerClient,
  type RateLimitsSnapshot,
  type ThreadInfo,
  type ThreadResumeRequest,
  type ThreadStartRequest,
  type TurnHandle,
  type TurnOutcome,
  type TurnStartRequest,
} from "../contracts.js"
import { type Logger, noopLogger } from "./logger.js"
import { type FakeScenario, type FakeScenarioInput, type FakeTurnScript, parseScenario, pickTurnScript } from "./fake-scenario.js"
import { tableAnswer } from "./server-request.js"

export interface FakeAppServerClientOptions {
  /** 完整或部分剧本；不给就读 env（由调用方先 loadScenario）或用默认 */
  scenario?: FakeScenarioInput | FakeScenario
  faults?: Set<FaultName>
  logger?: Logger
  now?: () => number
}

interface FakeTurn {
  threadId: string
  turnId: string
  sentAt: number
  startedMs: number | null
  settled: boolean
  timers: NodeJS.Timeout[]
  pendingServerRequests: number
  waitForServerRequestReply: boolean
  outcomeSpec: FakeTurnScript["outcome"]
  finalText: string | null
  resolveStarted: (v: { turnId: string; at: number }) => void
  rejectStarted: (e: Error) => void
  resolveDone: (o: TurnOutcome) => void
}

export class FakeAppServerClient implements IAppServerClient {
  readonly kind = "fake" as const

  private readonly scenario: FakeScenario
  private readonly faults: Set<FaultName>
  private readonly log: Logger
  private readonly now: () => number

  private alive = false
  private engineInfo: EngineInfo | null = null
  private threadSeq = 0
  private turnSeq = 0
  private serverRequestSeq = 90_000
  private readonly threads = new Map<string, { cwd: string; config: Record<string, unknown> | undefined }>()
  private readonly active = new Map<string, FakeTurn[]>()
  private readonly consumedScripts = new Set<number>()
  private readonly handlers = new Set<(ev: EngineEvent) => void>()
  private readonly emitted: EngineEvent[] = []

  constructor(opts: FakeAppServerClientOptions = {}) {
    this.scenario = parseScenario(opts.scenario ?? {})
    this.faults = opts.faults ?? new Set()
    this.log = opts.logger ?? noopLogger
    this.now = opts.now ?? (() => Date.now())
  }

  // ---- 内省（只给测试用，不在 IAppServerClient 里） ------------------------

  /** 至今发过的全部事件（B/C 的断言用） */
  events(): readonly EngineEvent[] {
    return this.emitted
  }
  threadConfig(threadId: string): Record<string, unknown> | undefined {
    return this.threads.get(threadId)?.config
  }
  scenarioSnapshot(): FakeScenario {
    return this.scenario
  }

  // ---- 生命周期 -----------------------------------------------------------

  isAlive(): boolean {
    return this.alive
  }
  info(): EngineInfo | null {
    return this.engineInfo
  }

  async start(): Promise<EngineInfo> {
    if (this.alive && this.engineInfo) return this.engineInfo
    if (this.faults.has("engine-down")) throw new Error("engine-down 故障注入：引擎不启动、不重试")
    if (this.scenario.failStart) throw new Error(this.scenario.failStart)
    await this.delay(this.scenario.initializeMs)
    this.alive = true
    this.engineInfo = {
      pid: process.pid,
      pgid: process.pid,
      codexHome: this.scenario.codexHome,
      codexBin: "<fake>",
      codexVersion: this.scenario.codexVersion,
      startedAt: new Date(this.now()).toISOString(),
      initializeMs: this.scenario.initializeMs,
    }
    return this.engineInfo
  }

  async stop(_opts?: EngineStopOptions): Promise<void> {
    this.alive = false
    this.engineInfo = null
    for (const [, list] of [...this.active]) {
      for (const t of [...list]) {
        this.settle(t, { status: "interrupted", turnId: t.turnId, wallMs: this.now() - t.sentAt })
      }
    }
    this.active.clear()
  }

  // ---- thread ------------------------------------------------------------

  async threadStart(req: ThreadStartRequest): Promise<ThreadInfo> {
    this.requireAlive()
    if (this.faults.has("fail-thread-start")) throw new Error("fail-thread-start 故障注入：thread/start 一律失败")
    if (this.scenario.failThreadStart) throw new Error(this.scenario.failThreadStart)
    await this.delay(this.scenario.threadStartMs)
    const id = `fake-th-${++this.threadSeq}`
    this.threads.set(id, { cwd: req.cwd, config: req.config })
    this.emitRaw("thread/started")
    return { threadId: id, cwd: req.cwd, model: "fake-model", resumed: false, opMs: this.scenario.threadStartMs }
  }

  async threadResume(req: ThreadResumeRequest): Promise<ThreadInfo> {
    this.requireAlive()
    if (this.scenario.failThreadResume) throw new Error(this.scenario.failThreadResume)
    await this.delay(this.scenario.threadResumeMs)
    this.threads.set(req.threadId, { cwd: req.cwd, config: req.config })
    return { threadId: req.threadId, cwd: req.cwd, model: "fake-model", resumed: true, opMs: this.scenario.threadResumeMs }
  }

  async loadedThreads(): Promise<string[]> {
    this.requireAlive()
    return [...new Set([...this.threads.keys(), ...this.scenario.loadedThreads])]
  }

  async compact(threadId: string, _timeoutMs: number): Promise<CompactOutcome> {
    this.requireAlive()
    await this.delay(this.scenario.compact.ms)
    if (!this.scenario.compact.ok) {
      return { ok: false, wallMs: this.scenario.compact.ms, error: this.scenario.compact.error ?? "compact failed" }
    }
    this.emitRaw("thread/compacted")
    this.emit({ type: "context.compacted", threadId, turnId: `fake-tu-${this.turnSeq}` })
    return { ok: true, wallMs: this.scenario.compact.ms }
  }

  // ---- turn --------------------------------------------------------------

  async turnStart(req: TurnStartRequest): Promise<TurnHandle> {
    this.requireAlive()
    const { script, index } = pickTurnScript(this.scenario, req.text, this.consumedScripts)
    if (index >= 0) this.consumedScripts.add(index)

    const turnId = `fake-tu-${++this.turnSeq}`
    let resolveStarted!: (v: { turnId: string; at: number }) => void
    let rejectStarted!: (e: Error) => void
    const started = new Promise<{ turnId: string; at: number }>((res, rej) => {
      resolveStarted = res
      rejectStarted = rej
    })
    void started.catch(() => {})
    let resolveDone!: (o: TurnOutcome) => void
    const done = new Promise<TurnOutcome>((res) => {
      resolveDone = res
    })

    const t: FakeTurn = {
      threadId: req.threadId,
      turnId,
      sentAt: this.now(),
      startedMs: null,
      settled: false,
      timers: [],
      pendingServerRequests: 0,
      waitForServerRequestReply: script.waitForServerRequestReply,
      outcomeSpec: script.outcome,
      finalText: script.outcome.status === "completed" ? (script.outcome.finalText ?? null) : null,
      resolveStarted,
      rejectStarted,
      resolveDone,
    }
    const list = this.active.get(req.threadId) ?? []
    list.push(t)
    this.active.set(req.threadId, list)

    const handle: TurnHandle = {
      threadId: req.threadId,
      turnId,
      started,
      done,
      interrupt: async () => {
        this.settle(t, { status: "interrupted", turnId, wallMs: this.now() - t.sentAt })
      },
    }

    this.schedule(t, script)

    if (req.timeoutMs > 0) {
      this.arm(t, req.timeoutMs, () => {
        this.settle(t, { status: "timeout", turnId, wallMs: this.now() - t.sentAt })
      })
    }
    return handle
  }

  async turnInterrupt(threadId: string, turnId: string): Promise<void> {
    const t = (this.active.get(threadId) ?? []).find((x) => x.turnId === turnId)
    if (t) this.settle(t, { status: "interrupted", turnId, wallMs: this.now() - t.sentAt })
  }

  // ---- 账号 / 额度 --------------------------------------------------------

  async rateLimits(): Promise<RateLimitsSnapshot> {
    this.requireAlive()
    return { ...this.scenario.rateLimits, sampledAt: new Date(this.now()).toISOString() }
  }

  async account(): Promise<AccountInfo> {
    this.requireAlive()
    return { ...this.scenario.account }
  }

  // ---- 事件 --------------------------------------------------------------

  onEvent(handler: (ev: EngineEvent) => void): () => void {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  // ---- 内部 --------------------------------------------------------------

  private requireAlive(): void {
    if (!this.alive) throw new Error("fake app-server is not running（先 start()）")
  }

  private delay(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve()
    return new Promise((r) => setTimeout(r, ms))
  }

  private arm(t: FakeTurn, ms: number, fn: () => void): void {
    const timer = setTimeout(fn, Math.max(0, ms))
    if (typeof timer.unref === "function") timer.unref()
    t.timers.push(timer)
  }

  private schedule(t: FakeTurn, script: FakeTurnScript): void {
    const dropStarted = this.faults.has("drop-turn-started")
    const startAt = script.startedAfterMs
    let cursor = startAt ?? 0

    if (startAt != null && !dropStarted) {
      this.arm(t, startAt, () => {
        if (t.settled) return
        t.startedMs = this.now() - t.sentAt
        this.emitRaw("turn/started")
        this.emit({ type: "turn.started", threadId: t.threadId, turnId: t.turnId, at: this.now() })
        t.resolveStarted({ turnId: t.turnId, at: this.now() })
      })
    }

    for (const step of script.steps) {
      cursor += Math.max(0, step.afterMs ?? 0)
      const at = cursor
      this.arm(t, at, () => {
        if (t.settled) return
        if ("crash" in step) {
          this.crash(step.crash)
          return
        }
        if ("serverRequest" in step) {
          this.deliverServerRequest(t, step.serverRequest.method, step.serverRequest.id ?? this.serverRequestSeq++)
          return
        }
        this.emitSpec(t, step.event)
      })
    }

    cursor += Math.max(0, script.completeAfterMs)
    this.arm(t, cursor, () => {
      if (t.settled) return
      // ServerRequest 没被应答就不许收尾——真引擎也是这样卡住的（E16 红门）
      if (t.waitForServerRequestReply && t.pendingServerRequests > 0) return
      this.complete(t)
    })
  }

  private deliverServerRequest(t: FakeTurn, method: string, id: number): void {
    const fromTable = tableAnswer(method)
    if (!fromTable && this.faults.has("drop-serverrequest-default")) {
      t.pendingServerRequests++
      this.emitRaw(method)
      this.emit({ type: "server.request", method, id, replied: "dropped" })
      return
    }
    this.emitRaw(method)
    this.emit({ type: "server.request", method, id, replied: fromTable ? "table" : "default-32601" })
  }

  private emitSpec(t: FakeTurn, spec: FakeEventSpecLoose): void {
    switch (spec.type) {
      case "item.completed":
        this.emitRaw("item/completed")
        this.emit({
          type: "item.completed",
          threadId: t.threadId,
          turnId: t.turnId,
          itemType: spec.itemType,
          server: spec.server ?? null,
          tool: spec.tool ?? null,
          status: spec.status ?? null,
        })
        return
      case "token.usage":
        this.emitRaw("thread/tokenUsage/updated")
        this.emit({ type: "token.usage", threadId: t.threadId, turnId: t.turnId, usage: spec.usage })
        return
      case "thread.status":
        this.emitRaw("thread/status/changed")
        this.emit({ type: "thread.status", threadId: t.threadId, status: spec.status })
        return
      case "turn.error":
        this.emitRaw("error")
        this.emit({
          type: "turn.error",
          threadId: t.threadId,
          turnId: t.turnId,
          message: spec.message,
          willRetry: spec.willRetry === true,
        })
        return
      case "mcp.startup":
        this.emitRaw("mcpServer/startupStatus/updated")
        this.emit({ type: "mcp.startup", name: spec.name, status: spec.status })
        return
      case "rate.limits":
        this.emitRaw("account/rateLimits/updated")
        this.emit({ type: "rate.limits", snapshot: spec.snapshot })
        return
      case "context.compacted":
        this.emitRaw("thread/compacted")
        this.emit({ type: "context.compacted", threadId: t.threadId, turnId: t.turnId })
        return
      default:
        this.log.log("warn", "fake-unknown-event-spec", { spec: JSON.stringify(spec).slice(0, 120) })
    }
  }

  private complete(t: FakeTurn): void {
    const wallMs = this.now() - t.sentAt
    this.emitRaw("turn/completed")
    const spec = t.outcomeSpec
    if (spec.status === "failed") {
      this.emit({
        type: "turn.completed",
        threadId: t.threadId,
        turnId: t.turnId,
        status: "failed",
        finalText: null,
        errorMessage: spec.message ?? "fake failure",
        durationMs: wallMs,
        at: this.now(),
      })
      this.settle(t, { status: "failed", turnId: t.turnId, message: spec.message ?? "fake failure", wallMs })
      return
    }
    if (spec.status === "interrupted") {
      this.emit({
        type: "turn.completed",
        threadId: t.threadId,
        turnId: t.turnId,
        status: "interrupted",
        finalText: null,
        errorMessage: null,
        durationMs: wallMs,
        at: this.now(),
      })
      this.settle(t, { status: "interrupted", turnId: t.turnId, wallMs })
      return
    }
    this.emit({
      type: "turn.completed",
      threadId: t.threadId,
      turnId: t.turnId,
      status: "completed",
      finalText: t.finalText,
      errorMessage: null,
      durationMs: wallMs,
      at: this.now(),
    })
    this.settle(t, {
      status: "completed",
      turnId: t.turnId,
      finalText: t.finalText,
      wallMs,
      startedMs: t.startedMs ?? wallMs,
    })
  }

  private crash(reason: string): void {
    this.alive = false
    this.engineInfo = null
    this.emit({ type: "engine.lost", reason })
    for (const [, list] of [...this.active]) {
      for (const t of [...list]) {
        this.settle(t, { status: "lost", turnId: t.turnId, reason, wallMs: this.now() - t.sentAt })
      }
    }
    this.active.clear()
  }

  private settle(t: FakeTurn, outcome: TurnOutcome): void {
    if (t.settled) return
    t.settled = true
    for (const timer of t.timers) clearTimeout(timer)
    t.timers = []
    const list = this.active.get(t.threadId)
    if (list) {
      const i = list.indexOf(t)
      if (i >= 0) list.splice(i, 1)
      if (list.length === 0) this.active.delete(t.threadId)
    }
    if (t.startedMs == null) t.rejectStarted(new Error(`fake turn 未发 turn/started 就终态：${outcome.status}`))
    t.resolveDone(outcome)
  }

  private emitRaw(method: string): void {
    this.emit({ type: "raw", method })
  }

  private emit(ev: EngineEvent): void {
    this.emitted.push(ev)
    for (const h of [...this.handlers]) {
      try {
        h(ev)
      } catch (err) {
        this.log.log("error", "fake-event-handler-threw", { err: err instanceof Error ? err.message : String(err) })
      }
    }
  }
}

/** 剧本里的 event 是 JSON 写的，字段可能缺；这里放宽成结构化联合的宽松版 */
type FakeEventSpecLoose = any
