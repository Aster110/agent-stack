/**
 * RealAppServerClient —— `IAppServerClient` 的真引擎实现。
 *
 * 抽自 wechat-cc-channel `codex-app-server.ts`（ensure/startWithBackoff/startOnce/
 * killOrphan `:727-866`、resolveThread `:541-561`），剥掉：log/logError import（改注入式
 * logger）、`contracts.js` 的 AgentEvent 词表、`CodexExecAgent` 降级、`CC2WECHAT_*` env、
 * `clientInfo:"cc2wechat"`（改 `CLIENT_NAME`）、写死的 pid 路径（改参数）。
 *
 * 三条不能忘的实测事实：
 * 1. bypass 必须**每轮** turn/start 带（camelCase tagged union，写成
 *    `{mode:"danger-full-access"}` 会 -32600 missing field `type`），不是进程级 `-c`。
 * 2. 进程用 `detached:true` 起成独立进程组，停止 `kill(-pgid)`：
 *    `/opt/homebrew/bin/codex` 是 node wrapper，只杀它会留 rust 孤儿。
 * 3. 署名只经 `thread/start|resume` 的 `config` 透传（`perThreadConfigOverride`），
 *    进程级 env 必须 `scrubProcessEnv()`——覆盖失效时退化成"发不出去"，
 *    永远不会冒充席位。
 *
 * 退避语义（与契约 `start()` 的"幂等"并存）：`start()` **只试一次**。失败后记账并推后
 * `nextAttemptAt`，在退避窗口内再调 `start()` 会立刻抛（不是睡在那里），这样 Lane B
 * 才能马上回 `[failed] engine-unavailable` 而不是把主循环堵死。退避表 1s/5s/30s/60s…
 */
import { type ChildProcess, spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import os from "node:os"

import {
  CLIENT_NAME,
  type AccountInfo,
  type CompactOutcome,
  type EngineEvent,
  type EngineInfo,
  type EngineStopOptions,
  type FaultName,
  type IAppServerClient,
  type RateLimitBucket,
  type RateLimitWindow,
  type RateLimitsSnapshot,
  TURN_BYPASS,
  type ThreadInfo,
  type ThreadResumeRequest,
  type ThreadStartRequest,
  type ThreadStatusKind,
  type ThreadTokenUsage,
  type TurnHandle,
  type TurnOutcome,
  type TurnStartRequest,
  scrubProcessEnv,
} from "../contracts.js"
import { buildAppServerArgs } from "../proc/spawn.js"
import { AppServerConnection, type ConnectionEvent } from "./connection.js"
import { type Logger, noopLogger } from "./logger.js"
import {
  type ProcOps,
  clearPidFile,
  defaultProcOps,
  killOrphanFromPidFile,
  readCodexVersion,
  resolveCodexBin,
  writePidFile,
} from "./proc.js"

export const BACKOFF_MS = [1_000, 5_000, 30_000, 60_000]
export const INITIALIZE_TIMEOUT_MS = 30_000
export const THREAD_OP_TIMEOUT_MS = 120_000
export const SHUTDOWN_GRACE_MS = 2_000

export interface RealAppServerClientOptions {
  /** app-server 进程的 cwd（席位主 thread 的 cwd 由 threadStart 单独给） */
  cwd: string
  /** config.codex.bin；null = 按决策 4 解析 */
  bin?: string | null
  /** CODEX_HOME 覆盖；null = 继承 */
  codexHome?: string | null
  extraArgs?: string[]
  pidFile: string
  /** 有就把子进程 stderr 抄一份到这个文件 */
  stderrLogPath?: string | null
  /**
   * 席位名与实例 id：一起拼成命令行标签 `codex_seat.tag="<seat>/<instanceId>"`。
   * 孤儿清理（`src/proc/orphans.ts findOrphans`）靠它认「哪些 app-server 是我起的」——
   * ChatGPT.app 自带的 app-server 命令行与 `APP_SERVER_BASE_ARGS` 逐字重合，
   * 没有这个标签就只能靠 pid 文件，上一代崩掉留下的孤儿一个都找不回来。
   * 缺省值只是让单测能不传；生产路径（seat.ts / CLI）必须显式给。
   */
  seat?: string | null
  instanceId?: string | null
  env?: NodeJS.ProcessEnv
  faults?: Set<FaultName>
  logger?: Logger
  spawnFn?: typeof spawn
  procOps?: ProcOps
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  backoffMs?: number[]
  initializeTimeoutMs?: number
  threadOpTimeoutMs?: number
  shutdownGraceMs?: number
  clientVersion?: string
  /** 起完跑一次 `codex --version`（真引擎 ~100ms）；单测可关 */
  readVersion?: boolean
}

interface ActiveTurn {
  msgId: string
  threadId: string
  turnId: string | null
  sentAt: number
  startedMs: number | null
  finalText: string | null
  lastErrorMessage: string | null
  settled: boolean
  interruptRequested: boolean
  accepted: boolean
  earlyNotifications: Array<Extract<ConnectionEvent, { kind: "notification" }>>
  timer: NodeJS.Timeout | null
  resolveStarted: (v: { turnId: string; at: number }) => void
  rejectStarted: (e: Error) => void
  resolveDone: (o: TurnOutcome) => void
  handle: TurnHandle
}

export class RealAppServerClient implements IAppServerClient {
  readonly kind = "real" as const

  private conn: AppServerConnection | null = null
  private child: ChildProcess | null = null
  private engineInfo: EngineInfo | null = null
  private starting: Promise<EngineInfo> | null = null
  private failures = 0
  private nextAttemptAt = 0
  private stopping = false

  private readonly handlers = new Set<(ev: EngineEvent) => void>()
  private readonly turns = new Map<string, ActiveTurn[]>()
  private readonly threadPaths = new Map<string, string | null>()

  private readonly env: NodeJS.ProcessEnv
  private readonly faults: Set<FaultName>
  private readonly log: Logger
  private readonly spawnFn: typeof spawn
  private readonly procOps: ProcOps
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly backoff: number[]
  /** 没给 instanceId 时自造一个：标签宁可对不上某一代，也不能整个消失 */
  private readonly instanceTag: string

  constructor(private readonly opts: RealAppServerClientOptions) {
    this.instanceTag = opts.instanceId ?? `anon${randomBytes(3).toString("hex")}`
    this.env = opts.env ?? process.env
    this.faults = opts.faults ?? new Set()
    this.log = opts.logger ?? noopLogger
    this.spawnFn = opts.spawnFn ?? spawn
    this.procOps = opts.procOps ?? defaultProcOps
    this.now = opts.now ?? (() => Date.now())
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.backoff = opts.backoffMs ?? BACKOFF_MS
  }

  // ---- 生命周期 -----------------------------------------------------------

  isAlive(): boolean {
    return !!this.conn?.alive
  }

  info(): EngineInfo | null {
    return this.engineInfo
  }

  /** rollout 文件路径（thread/start 回包里的 `thread.path`）；E01 用它量字节增长。 */
  threadPath(threadId: string): string | null {
    return this.threadPaths.get(threadId) ?? null
  }

  async start(): Promise<EngineInfo> {
    if (this.conn?.alive && this.engineInfo) return this.engineInfo
    if (this.starting) return this.starting
    if (this.faults.has("engine-down")) {
      throw new Error("engine-down 故障注入：引擎不启动、不重试")
    }
    const wait = this.nextAttemptAt - this.now()
    if (wait > 0) {
      throw new Error(`app-server 处于退避窗口，${wait}ms 后才允许重试（连续失败 ${this.failures} 次）`)
    }

    this.stopping = false
    this.starting = this.startOnce()
      .then((info) => {
        this.failures = 0
        this.nextAttemptAt = 0
        return info
      })
      .catch((err) => {
        this.failures++
        const step = this.backoff[Math.min(this.failures - 1, this.backoff.length - 1)] ?? 0
        this.nextAttemptAt = this.now() + step
        throw err
      })
      .finally(() => {
        this.starting = null
      })
    return this.starting
  }

  private async startOnce(): Promise<EngineInfo> {
    // 上一代 sidecar 被 SIGKILL 时来不及收尾，会留着还活着的 app-server 抓着
    // ~/.codex/thread-writer-locks/<threadId>.lock，新进程 resume 同一条 thread 会撞锁。
    const sweep = await killOrphanFromPidFile({
      file: this.opts.pidFile,
      procOps: this.procOps,
      sleep: this.sleep,
      logger: this.log,
    })
    if (sweep.action === "killed") this.log.log("info", "orphan-swept", { pid: sweep.pid, pgid: sweep.pgid })

    const resolved = resolveCodexBin({ configBin: this.opts.bin ?? null, env: this.env })
    // 标签由这里统一打（Lane C 的 buildAppServerArgs），不再让调用方往 extraArgs 里塞——
    // 塞 extraArgs 的绕法只覆盖走配置那一条路径，e2e/直接 new 的路径就漏了。
    const args = buildAppServerArgs(this.opts.seat ?? "unknown", this.instanceTag, this.opts.extraArgs ?? [])

    const childEnv = scrubProcessEnv({ ...this.env })
    if (this.opts.codexHome) childEnv.CODEX_HOME = this.opts.codexHome

    const child = this.spawnFn(resolved.bin, args, {
      // detached: 成为新会话/进程组首领（pgid = pid）。停止一律 kill(-pgid)——
      // 只杀 wrapper 会留 ppid=1 的 rust 孤儿。
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.opts.cwd,
      env: childEnv,
    })
    this.child = child

    let stderrSink: ((s: string) => void) | undefined
    if (this.opts.stderrLogPath) {
      const p = this.opts.stderrLogPath
      stderrSink = (s) => {
        try {
          fs.appendFileSync(p, s)
        } catch {
          /* 日志写不进去不该拖垮引擎 */
        }
      }
    }

    const conn = new AppServerConnection(child as unknown as ConstructorParameters<typeof AppServerConnection>[0], {
      faults: this.faults,
      logger: this.log,
      onEvent: (ev) => this.onConnectionEvent(ev),
      onStderr: stderrSink,
    })
    this.conn = conn

    const pid = child.pid ?? 0
    const pgid = pid // detached ⇒ 进程组首领
    const cmdline = `${resolved.bin} ${args.join(" ")}`
    const startedAt = new Date().toISOString()
    if (pid > 0) {
      writePidFile(this.opts.pidFile, { pid, pgid, startedAt, cmdline, instanceId: this.opts.instanceId ?? null })
    }

    const t0 = this.now()
    const init = await conn.request(
      "initialize",
      {
        clientInfo: { name: CLIENT_NAME, title: CLIENT_NAME, version: this.opts.clientVersion ?? "2.0.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      },
      this.opts.initializeTimeoutMs ?? INITIALIZE_TIMEOUT_MS,
    )
    const initializeMs = this.now() - t0
    if (init.error) {
      await this.hardStop(conn, pid, pgid, this.opts.shutdownGraceMs ?? SHUTDOWN_GRACE_MS)
      this.conn = null
      this.child = null
      throw new Error(`initialize 失败: ${init.error.message}`)
    }

    conn.codexHome = typeof init.result?.codexHome === "string" ? init.result.codexHome : ""
    conn.notify("initialized", {})

    const info: EngineInfo = {
      pid,
      pgid,
      codexHome: conn.codexHome,
      codexBin: resolved.bin,
      codexVersion: this.opts.readVersion === false ? null : readCodexVersion(resolved.bin),
      startedAt,
      initializeMs,
    }
    this.engineInfo = info
    this.log.log("info", "engine-started", { pid, pgid, bin: resolved.bin, source: resolved.source, initializeMs })
    return info
  }

  async stop(opts?: EngineStopOptions): Promise<void> {
    this.stopping = true
    const conn = this.conn
    const child = this.child
    const info = this.engineInfo
    this.conn = null
    this.child = null
    this.engineInfo = null
    if (!conn || !info) {
      clearPidFile(this.opts.pidFile)
      return
    }
    const grace = opts?.graceMs ?? this.opts.shutdownGraceMs ?? SHUTDOWN_GRACE_MS

    if (opts?.wrapperOnly) {
      // E08 变异：故意只杀 wrapper pid。孙子进程会活下来——这正是"必须杀进程组"的证明。
      this.procOps.kill(info.pid, "SIGTERM")
      await this.sleep(grace)
      if (this.procOps.isAlive(info.pid)) this.procOps.kill(info.pid, "SIGKILL")
    } else {
      await this.hardStop(conn, info.pid, info.pgid, grace)
    }
    void child
    clearPidFile(this.opts.pidFile)
    this.log.log("info", "engine-stopped", { pid: info.pid, pgid: info.pgid, wrapperOnly: !!opts?.wrapperOnly })
  }

  private async hardStop(conn: AppServerConnection, pid: number, pgid: number, grace: number): Promise<void> {
    try {
      conn.transport.stdin?.end()
    } catch {
      /* 管道早没了 */
    }
    if (pgid > 1) this.procOps.killGroup(pgid, "SIGTERM")
    const exited = await conn.waitExit(grace)
    if (!exited || (pid > 0 && this.procOps.isAlive(pid))) {
      if (pgid > 1) this.procOps.killGroup(pgid, "SIGKILL")
      await conn.waitExit(grace)
    }
  }

  // ---- thread ------------------------------------------------------------

  async threadStart(req: ThreadStartRequest): Promise<ThreadInfo> {
    const conn = this.requireConn()
    const t0 = this.now()
    const r = await conn.request(
      "thread/start",
      {
        cwd: req.cwd,
        developerInstructions: req.developerInstructions,
        // 决策 2：署名的唯一注入点。**原样透传**，我们自己一个字都不加。
        config: req.config,
        model: req.model ?? undefined,
        ephemeral: req.ephemeral ?? undefined,
      },
      this.opts.threadOpTimeoutMs ?? THREAD_OP_TIMEOUT_MS,
    )
    const opMs = this.now() - t0
    if (r.error) throw new Error(`thread/start 失败: ${r.error.message}`)
    const id = r.result?.thread?.id as string | undefined
    if (!id) throw new Error("thread/start 没有返回 thread.id")
    this.threadPaths.set(id, (r.result?.thread?.path as string | undefined) ?? null)
    return { threadId: id, cwd: req.cwd, model: (r.result?.model as string | undefined) ?? null, resumed: false, opMs }
  }

  async threadResume(req: ThreadResumeRequest): Promise<ThreadInfo> {
    const conn = this.requireConn()
    const t0 = this.now()
    const r = await conn.request(
      "thread/resume",
      {
        threadId: req.threadId,
        cwd: req.cwd,
        developerInstructions: req.developerInstructions,
        config: req.config,
        // 常驻席位不需要把历史 turns 全拉回来（rollout 已在磁盘上）
        excludeTurns: true,
      },
      this.opts.threadOpTimeoutMs ?? THREAD_OP_TIMEOUT_MS,
    )
    const opMs = this.now() - t0
    if (r.error) throw new Error(`thread/resume 失败: ${r.error.message}`)
    const id = (r.result?.thread?.id as string | undefined) ?? req.threadId
    this.threadPaths.set(id, (r.result?.thread?.path as string | undefined) ?? this.threadPaths.get(id) ?? null)
    return { threadId: id, cwd: req.cwd, model: (r.result?.model as string | undefined) ?? null, resumed: true, opMs }
  }

  async loadedThreads(): Promise<string[]> {
    const conn = this.requireConn()
    const r = await conn.request("thread/loaded/list", {}, this.opts.threadOpTimeoutMs ?? THREAD_OP_TIMEOUT_MS)
    if (r.error) throw new Error(`thread/loaded/list 失败: ${r.error.message}`)
    return Array.isArray(r.result?.data) ? (r.result.data as string[]) : []
  }

  async compact(threadId: string, timeoutMs: number): Promise<CompactOutcome> {
    const conn = this.requireConn()
    const t0 = this.now()
    const r = await conn.request("thread/compact/start", { threadId }, timeoutMs)
    const wallMs = this.now() - t0
    if (r.error) return { ok: false, wallMs, error: r.error.message }
    return { ok: true, wallMs }
  }

  // ---- turn --------------------------------------------------------------

  async turnStart(req: TurnStartRequest): Promise<TurnHandle> {
    const conn = this.requireConn()

    let resolveStarted!: (v: { turnId: string; at: number }) => void
    let rejectStarted!: (e: Error) => void
    const started = new Promise<{ turnId: string; at: number }>((res, rej) => {
      resolveStarted = res
      rejectStarted = rej
    })
    // 调用方通常 race started 与 done；没人看的那次 reject 不该炸掉进程
    void started.catch(() => {})

    let resolveDone!: (o: TurnOutcome) => void
    const done = new Promise<TurnOutcome>((res) => {
      resolveDone = res
    })

    const at: ActiveTurn = {
      msgId: req.msgId,
      threadId: req.threadId,
      turnId: null,
      sentAt: this.now(),
      startedMs: null,
      finalText: null,
      lastErrorMessage: null,
      settled: false,
      interruptRequested: false,
      accepted: false,
      earlyNotifications: [],
      timer: null,
      resolveStarted,
      rejectStarted,
      resolveDone,
      handle: null as unknown as TurnHandle,
    }
    const handle: TurnHandle = {
      threadId: req.threadId,
      turnId: null,
      started,
      done,
      interrupt: async () => {
        if (at.settled) return
        at.interruptRequested = true
        if (at.turnId) await this.turnInterrupt(at.threadId, at.turnId)
        else this.settle(at, { status: "interrupted", turnId: null, wallMs: this.now() - at.sentAt })
      },
    }
    at.handle = handle

    const list = this.turns.get(req.threadId) ?? []
    list.push(at)
    this.turns.set(req.threadId, list)

    if (req.timeoutMs > 0) {
      at.timer = setTimeout(() => {
        // 打断是发消息，不是杀进程——这个 app-server 上还挂着别人的 thread
        at.interruptRequested = true
        if (at.turnId) void this.turnInterrupt(at.threadId, at.turnId)
        this.settle(at, { status: "timeout", turnId: at.turnId, wallMs: this.now() - at.sentAt })
      }, req.timeoutMs)
      if (typeof at.timer.unref === "function") at.timer.unref()
    }

    // 引擎可能在两轮之间自动 Compact；只重试明确「输入未提交」的 Compact busy。
    // ACK 前的通知暂存，拿到真正业务 turnId 后再归属，避免误认 Compact turn。
    void (async () => {
      while (!at.settled) {
        if (at.interruptRequested) {
          this.settle(at, { status: "interrupted", turnId: null, wallMs: this.now() - at.sentAt })
          return
        }
        at.earlyNotifications = []
        const ack = await conn.request("turn/start", {
          threadId: req.threadId,
          input: [{ type: "text", text: req.text, text_elements: [] }],
          approvalPolicy: TURN_BYPASS.approvalPolicy,
          sandboxPolicy: TURN_BYPASS.sandboxPolicy,
        }, this.opts.threadOpTimeoutMs ?? THREAD_OP_TIMEOUT_MS, req.timeoutMs === 0
          ? () => this.emit({ type: "request.unresponsive", threadId: req.threadId, msgId: req.msgId })
          : undefined)
        if (ack.error) {
          at.earlyNotifications = []
          if (ack.error.code === -32603 && /ActiveTurnNotSteerable\s*\{\s*turn_kind:\s*Compact\s*\}/.test(ack.error.message)) {
            this.log.log("debug", "turn-compact-busy", { threadId: req.threadId, msgId: req.msgId })
            if (!at.settled) await this.sleep(1000)
            continue
          }
          this.settle(at, { status: "rejected", message: ack.error.message, code: ack.error.code })
          return
        }
        const id = ack.result?.turn?.id as string | undefined
        if (!id) throw new Error("turn/start 没有返回 turn.id")
        if (at.settled) {
          if (at.interruptRequested) await this.turnInterrupt(at.threadId, id)
          return
        }
        this.assignTurnId(at, id)
        at.accepted = true
        const early = at.earlyNotifications
        at.earlyNotifications = []
        for (const ev of early) this.applyToTurn(ev)
        if (at.interruptRequested && !at.settled) await this.turnInterrupt(at.threadId, id)
        return
      }
    })().catch((error) => this.settle(at, {
      status: "failed", turnId: at.turnId, message: String(error), wallMs: this.now() - at.sentAt,
    }))

    this.log.log("debug", "turn-start", { threadId: req.threadId, nonce: req.nonce, msgId: req.msgId })
    return handle
  }

  async turnInterrupt(threadId: string, turnId: string): Promise<void> {
    const conn = this.conn
    if (!conn?.alive) return
    // 发的是**请求**（带 id）而不是通知：协议里 turn/interrupt 属于 ClientRequest。
    await conn.request("turn/interrupt", { threadId, turnId }, this.opts.threadOpTimeoutMs ?? THREAD_OP_TIMEOUT_MS)
  }

  async readTurn(threadId: string, turnId: string, msgId?: string): Promise<TurnOutcome | { status: "running"; turnId?: string } | { status: "unknown"; reason?: "not-found" | "read-error" }> {
    const r = await this.requireConn().request("thread/read", { threadId, includeTurns: true }, this.opts.threadOpTimeoutMs ?? THREAD_OP_TIMEOUT_MS)
    if (r.error) return { status: "unknown", reason: "read-error" }
    const matches = (r.result?.thread?.turns ?? []).filter((t: { id: string; items?: Array<{ type: string }> }) => turnId !== "unknown"
      ? t.id === turnId
      : !!msgId && (t.items ?? []).some((i) => i.type === "userMessage" && JSON.stringify(i).includes(`[mesh-task-id:${msgId}]`)))
    const turn = matches.length === 1 ? matches[0] : null
    if (!turn) return { status: "unknown", reason: "not-found" }
    turnId = turn.id
    if (turn.status === "inProgress") return { status: "running", turnId }
    const settleSnapshot = (outcome: TurnOutcome): TurnOutcome => {
      // The seat can release its thread lock after this read. Retire the exact
      // client handle too, otherwise a pre-ACK handle would capture the next
      // turn's notifications as its own early notifications.
      const active = (this.turns.get(threadId) ?? []).find((at) => !at.settled && (at.turnId === turnId || (!at.turnId && !!msgId && at.msgId === msgId)))
      if (active) {
        this.assignTurnId(active, turnId)
        active.accepted = true
        active.startedMs ??= this.now() - active.sentAt
        active.resolveStarted({ turnId, at: this.now() })
        this.settle(active, outcome)
      }
      return outcome
    }
    if (turn.status === "completed") return settleSnapshot({ status: "completed", turnId, finalText: lastAgentMessageOf(turn.items), wallMs: 0, startedMs: 0 })
    if (turn.status === "failed") return settleSnapshot({ status: "failed", turnId, message: turn.error?.message ?? "turn failed", wallMs: 0 })
    if (turn.status === "interrupted") return settleSnapshot({ status: "interrupted", turnId, wallMs: 0 })
    return { status: "unknown" }
  }

  // ---- 账号 / 额度 --------------------------------------------------------

  async rateLimits(): Promise<RateLimitsSnapshot> {
    const conn = this.requireConn()
    const r = await conn.request("account/rateLimits/read", undefined, 10_000)
    if (r.error) throw new Error(`account/rateLimits/read 失败: ${r.error.message}`)
    return mapRateLimits(r.result)
  }

  async account(): Promise<AccountInfo> {
    const conn = this.requireConn()
    const r = await conn.request("account/read", {}, 10_000)
    if (r.error) throw new Error(`account/read 失败: ${r.error.message}`)
    const a = r.result?.account as { type?: string; email?: string | null; planType?: string | null } | null | undefined
    const type: AccountInfo["type"] = a?.type === "chatgpt" ? "chatgpt" : a?.type === "apiKey" ? "apiKey" : "other"
    return { type, email: a?.email ?? null, planType: a?.planType ?? null }
  }

  // ---- 事件 --------------------------------------------------------------

  onEvent(handler: (ev: EngineEvent) => void): () => void {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  private emit(ev: EngineEvent): void {
    for (const h of [...this.handlers]) {
      try {
        h(ev)
      } catch (err) {
        this.log.log("error", "engine-event-handler-threw", { err: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  private onConnectionEvent(ev: ConnectionEvent): void {
    if (ev.kind === "lost") {
      this.emit({ type: "engine.lost", reason: ev.reason })
      const reason = ev.reason
      for (const [, list] of [...this.turns]) {
        for (const at of [...list]) {
          this.settle(at, { status: "lost", turnId: at.turnId, reason, wallMs: this.now() - at.sentAt })
        }
      }
      this.turns.clear()
      if (!this.stopping) this.log.log("error", "engine-lost", { reason: reason.slice(0, 300) })
      return
    }

    if (ev.kind === "server-request") {
      this.emit({ type: "raw", method: ev.method })
      this.emit({ type: "server.request", method: ev.method, id: ev.id, replied: ev.replied })
      return
    }

    // 协议漂移时能定位：原始方法名也计一笔
    this.emit({ type: "raw", method: ev.method })
    const mapped = mapNotification(ev.method, ev.params, ev.threadId, this.now())
    if (mapped) this.emit(mapped)
    this.applyToTurn(ev)
  }

  private applyToTurn(ev: Extract<ConnectionEvent, { kind: "notification" }>): void {
    const threadId = ev.threadId
    if (!threadId) return
    const list = this.turns.get(threadId)
    if (!list || list.length === 0) return
    const turnIdOf = (p: any): string | null =>
      typeof p?.turnId === "string" ? p.turnId : typeof p?.turn?.id === "string" ? p.turn.id : null
    const wanted = turnIdOf(ev.params)
    const awaitingAck = list.find((t) => !t.settled && !t.accepted)
    if (awaitingAck) {
      if (["turn/started", "item/completed", "error", "turn/completed"].includes(ev.method)) awaitingAck.earlyNotifications.push(ev)
      return
    }
    const pick = (): ActiveTurn | undefined =>
      wanted ? list.find((t) => t.turnId === wanted) : list.find((t) => !t.settled && t.accepted)

    switch (ev.method) {
      case "turn/started": {
        const at = wanted ? list.find((t) => t.turnId === wanted) : undefined
        if (!at || !wanted) return
        this.assignTurnId(at, wanted)
        at.startedMs = this.now() - at.sentAt
        at.resolveStarted({ turnId: wanted, at: this.now() })
        return
      }
      case "item/completed": {
        const at = pick()
        if (!at) return
        const item = ev.params?.item as { type?: string; text?: string } | undefined
        if (item?.type === "agentMessage" && typeof item.text === "string") at.finalText = item.text
        return
      }
      case "error": {
        const at = pick()
        if (!at) return
        const message = String(ev.params?.error?.message ?? ev.params?.message ?? "codex 报了一个没有正文的错误")
        at.lastErrorMessage = message
        // willRetry 时 codex 自己会重试；真挂了 turn/completed 会带 failed。
        // 不可重试的错误直接收尾——否则那一轮会吊到超时。
        if (ev.params?.willRetry !== true) {
          this.settle(at, { status: "failed", turnId: at.turnId, message, wallMs: this.now() - at.sentAt })
        }
        return
      }
      case "turn/completed": {
        const at = pick()
        if (!at) return
        const turn = (ev.params?.turn ?? {}) as { id?: string; status?: string; error?: { message?: string }; items?: unknown }
        const turnId = turn.id ?? at.turnId
        const wallMs = this.now() - at.sentAt
        if (turn.status === "interrupted") {
          this.settle(at, { status: "interrupted", turnId: turnId ?? null, wallMs })
          return
        }
        if (turn.status === "failed") {
          const message = turn.error?.message ?? at.lastErrorMessage ?? "turn failed"
          this.settle(at, { status: "failed", turnId: turnId ?? null, message, wallMs })
          return
        }
        const finalText = at.finalText ?? lastAgentMessageOf(turn.items)
        this.settle(at, {
          status: "completed",
          turnId: turnId ?? "",
          finalText,
          wallMs,
          startedMs: at.startedMs ?? wallMs,
        })
        return
      }
      default:
        return
    }
  }

  private assignTurnId(at: ActiveTurn, turnId: string): void {
    if (at.turnId) return
    at.turnId = turnId
    at.handle.turnId = turnId
  }

  private settle(at: ActiveTurn, outcome: TurnOutcome): void {
    if (at.settled) return
    at.settled = true
    if (at.timer) clearTimeout(at.timer)
    at.timer = null
    const list = this.turns.get(at.threadId)
    if (list) {
      const i = list.indexOf(at)
      if (i >= 0) list.splice(i, 1)
      if (list.length === 0) this.turns.delete(at.threadId)
    }
    if (at.startedMs == null) {
      at.rejectStarted(new Error(`turn 未收到 turn/started 就终态：${outcome.status}`))
    }
    at.resolveDone(outcome)
  }

  private requireConn(): AppServerConnection {
    const conn = this.conn
    if (!conn?.alive) throw new Error("app-server is not running（先 start()）")
    return conn
  }
}

// ---------------------------------------------------------------------------
// 纯映射
// ---------------------------------------------------------------------------

/** turn/completed 里 turn.items 是 summary 视图，兜底从里面捞最后一条 agentMessage */
export function lastAgentMessageOf(items: unknown): string | null {
  if (!Array.isArray(items)) return null
  let text: string | null = null
  for (const raw of items) {
    const item = raw as { type?: string; text?: string }
    if (item?.type === "agentMessage" && typeof item.text === "string") text = item.text
  }
  return text
}

function mapWindow(w: any): RateLimitWindow | null {
  if (!w || typeof w !== "object") return null
  return {
    usedPercent: typeof w.usedPercent === "number" ? w.usedPercent : 0,
    windowDurationMins: typeof w.windowDurationMins === "number" ? w.windowDurationMins : null,
    resetsAt: typeof w.resetsAt === "number" ? w.resetsAt : null,
  }
}

export function mapBucket(raw: any, fallbackLimitId: string | null): RateLimitBucket | null {
  if (!raw || typeof raw !== "object") return null
  return {
    limitId: typeof raw.limitId === "string" ? raw.limitId : fallbackLimitId,
    limitName: typeof raw.limitName === "string" ? raw.limitName : null,
    planType: typeof raw.planType === "string" ? raw.planType : null,
    primary: mapWindow(raw.primary),
    secondary: mapWindow(raw.secondary),
  }
}

/** `GetAccountRateLimitsResponse` → `RateLimitsSnapshot`（byLimitId 的键回填成 limitId）。 */
export function mapRateLimits(result: any, sampledAt = new Date().toISOString()): RateLimitsSnapshot {
  const byLimitId: RateLimitBucket[] = []
  const raw = result?.rateLimitsByLimitId
  if (raw && typeof raw === "object") {
    for (const [key, v] of Object.entries(raw)) {
      const b = mapBucket(v, key)
      if (b) byLimitId.push(b)
    }
  }
  return { rateLimits: mapBucket(result?.rateLimits, null), byLimitId, sampledAt }
}

/** JSON-RPC 通知 → EngineEvent；认不出来返回 null（`raw` 已单独计过一笔）。 */
export function mapNotification(method: string, params: any, threadId: string | null, at: number): EngineEvent | null {
  switch (method) {
    case "turn/started":
      if (!threadId || typeof params?.turn?.id !== "string") return null
      return { type: "turn.started", threadId, turnId: params.turn.id, at }

    case "turn/completed": {
      if (!threadId) return null
      const turn = params?.turn ?? {}
      const status = (["completed", "failed", "interrupted", "inProgress"] as const).includes(turn.status)
        ? (turn.status as "completed" | "failed" | "interrupted" | "inProgress")
        : "completed"
      return {
        type: "turn.completed",
        threadId,
        turnId: typeof turn.id === "string" ? turn.id : "",
        status,
        finalText: lastAgentMessageOf(turn.items),
        errorMessage: typeof turn.error?.message === "string" ? turn.error.message : null,
        durationMs: typeof turn.durationMs === "number" ? turn.durationMs : null,
        at,
      }
    }

    case "item/completed": {
      if (!threadId) return null
      const item = params?.item ?? {}
      return {
        type: "item.completed",
        threadId,
        turnId: typeof params?.turnId === "string" ? params.turnId : null,
        itemType: typeof item.type === "string" ? item.type : "unknown",
        server: typeof item.server === "string" ? item.server : null,
        tool: typeof item.tool === "string" ? item.tool : null,
        status: typeof item.status === "string" ? item.status : null,
      }
    }

    case "thread/tokenUsage/updated": {
      if (!threadId || !params?.tokenUsage) return null
      return {
        type: "token.usage",
        threadId,
        turnId: typeof params.turnId === "string" ? params.turnId : "",
        usage: params.tokenUsage as ThreadTokenUsage,
      }
    }

    case "account/rateLimits/updated":
      return {
        type: "rate.limits",
        snapshot: {
          rateLimits: mapBucket(params?.rateLimits, null),
          byLimitId: [],
          sampledAt: new Date(at).toISOString(),
        },
      }

    case "thread/status/changed": {
      if (!threadId) return null
      const kind = params?.status?.type
      const known: ThreadStatusKind[] = ["notLoaded", "idle", "active", "systemError"]
      if (!known.includes(kind)) return null
      return { type: "thread.status", threadId, status: kind as ThreadStatusKind }
    }

    case "thread/compacted":
      if (!threadId) return null
      return { type: "context.compacted", threadId, turnId: typeof params?.turnId === "string" ? params.turnId : "" }

    case "error":
      if (!threadId) return null
      return {
        type: "turn.error",
        threadId,
        turnId: typeof params?.turnId === "string" ? params.turnId : "",
        message: String(params?.error?.message ?? params?.message ?? ""),
        willRetry: params?.willRetry === true,
      }

    case "mcpServer/startupStatus/updated":
      return { type: "mcp.startup", name: String(params?.name ?? ""), status: String(params?.status ?? "") }

    default:
      return null
  }
}

/** 只在 e01/诊断里用：本机 hostname（证据字段） */
export function hostname(): string {
  return os.hostname()
}
