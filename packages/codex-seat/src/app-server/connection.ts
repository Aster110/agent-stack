/**
 * 一条 app-server 连接。抽自 wechat-cc-channel codex-app-server.ts:205-376，改动：
 *   - 传输面从 `ChildProcess` 抽象成 `ConnTransport`（单测可以用内存管道打）
 *   - 订阅从"按 threadId 挂 handler"改成单一事件流 `ConnectionEvent`，
 *     threadId 由 `notificationThreadId()` 解析后随事件带出（`thread/started`
 *     的 id 藏在 `params.thread.id`，老写法会把它当广播）
 *   - 连接丢失从 `__connection_lost__` 哨兵方法名改成显式 `{kind:"lost"}` 事件
 *   - 加了两个引擎层故障注入：`drop-serverrequest-default`、`drop-turn-started`
 *
 * 协议要点（全部实测，别凭印象改）：
 * - 换行分隔 JSON-RPC 2.0，不是 LSP 的 Content-Length 分帧
 * - 服务端发过来的 ServerRequest **必须应答**，不答那一轮永远挂着
 * - 请求不 reject，失败也走 `{error}`——调用方全是"失败就换条路"的分支
 */
import type { EventEmitter } from "node:events"

import type { FaultName } from "../contracts.js"
import { type Logger, noopLogger } from "./logger.js"
import { answerForServerRequest, tableAnswer } from "./server-request.js"
import { LineSplitter, classifyFrame, encodeFrame, notificationThreadId } from "./wire.js"

export const SHUTDOWN_GRACE_MS = 2_000
const STDERR_TAIL_MAX = 2_000

export interface RpcResult {
  result?: any
  error?: { code: number; message: string }
}

/** ChildProcess 天然满足；单测用内存管道假装。 */
export interface ConnTransport extends EventEmitter {
  readonly stdin: NodeJS.WritableStream | null
  readonly stdout: NodeJS.ReadableStream | null
  readonly stderr: NodeJS.ReadableStream | null
  readonly pid?: number | undefined
  kill?(signal?: NodeJS.Signals): boolean
}

export type ServerRequestDisposition = "table" | "default-32601" | "dropped"

export type ConnectionEvent =
  | { kind: "notification"; method: string; params: any; threadId: string | null }
  | { kind: "server-request"; method: string; id: number | string; replied: ServerRequestDisposition }
  | { kind: "lost"; reason: string }

export interface AppServerConnectionOptions {
  faults?: Set<FaultName>
  logger?: Logger
  onEvent?: (ev: ConnectionEvent) => void
  /** 收到 stderr 时也抄一份出去（席位写 log/app-server.stderr.log） */
  onStderr?: (chunk: string) => void
}

export class AppServerConnection {
  /** initialize 回包里的 codexHome，起完由调用方填 */
  codexHome = ""
  alive = true

  private nextId = 1
  private readonly pending = new Map<number, (r: RpcResult) => void>()
  private readonly handlers = new Set<(ev: ConnectionEvent) => void>()
  private readonly splitter = new LineSplitter()
  private readonly faults: Set<FaultName>
  private readonly log: Logger
  private stderrTail = ""
  private deadReason = ""
  private exitWaiters: Array<() => void> = []

  constructor(
    readonly transport: ConnTransport,
    opts: AppServerConnectionOptions = {},
  ) {
    this.faults = opts.faults ?? new Set()
    this.log = opts.logger ?? noopLogger
    if (opts.onEvent) this.handlers.add(opts.onEvent)
    this.onStderrChunk = opts.onStderr ?? null
    this.attach()
  }

  private readonly onStderrChunk: ((chunk: string) => void) | null

  get pid(): number | undefined {
    return this.transport.pid
  }

  get lostReason(): string {
    return this.deadReason
  }

  onEvent(handler: (ev: ConnectionEvent) => void): () => void {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  /**
   * 请求不 reject，失败也走 `{error}`。到处 try/catch 只会让上层控制流长得像迷宫。
   * `params === undefined` 时整个 params 键不写（协议上 `account/rateLimits/read` 就是这样）。
   */
  request(method: string, params: unknown, timeoutMs: number): Promise<RpcResult> {
    return new Promise<RpcResult>((resolve) => {
      if (!this.alive) {
        resolve({ error: { code: -1, message: this.deadReason || "app-server 已退出" } })
        return
      }
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ error: { code: -2, message: `${method} 超过 ${timeoutMs}ms 没有回应` } })
      }, timeoutMs)
      if (typeof timer.unref === "function") timer.unref()

      this.pending.set(id, (r) => {
        clearTimeout(timer)
        resolve(r)
      })
      this.write({ jsonrpc: "2.0", id, method, params })
    })
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params })
  }

  /** stdin 关 → SIGTERM → 宽限期后 SIGKILL。**只管这一个 pid**；杀进程组是 client 的事。 */
  async shutdown(graceMs = SHUTDOWN_GRACE_MS): Promise<void> {
    if (!this.alive) return
    try {
      this.transport.stdin?.end()
    } catch {
      /* 管道早没了 */
    }
    try {
      this.transport.kill?.("SIGTERM")
    } catch {
      /* 已经没了 */
    }
    const exited = await this.waitExit(graceMs)
    if (!exited) {
      try {
        this.transport.kill?.("SIGKILL")
      } catch {
        /* 已经没了 */
      }
      await this.waitExit(graceMs)
    }
  }

  waitExit(ms: number): Promise<boolean> {
    if (!this.alive) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), ms)
      if (typeof timer.unref === "function") timer.unref()
      this.exitWaiters.push(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  // -------------------------------------------------------------------------

  private attach(): void {
    this.transport.stderr?.on("data", (d: Buffer | string) => {
      const s = typeof d === "string" ? d : d.toString("utf8")
      this.stderrTail = (this.stderrTail + s).slice(-STDERR_TAIL_MAX)
      this.onStderrChunk?.(s)
    })
    this.transport.stdout?.on("data", (d: Buffer | string) => {
      for (const line of this.splitter.push(d)) this.onLine(line)
    })
    this.transport.on("error", (err: Error) => {
      this.die(`spawn 失败: ${err.message}`)
    })
    this.transport.on("exit", (code: number | null, signal: string | null) => {
      for (const line of this.splitter.flush()) this.onLine(line)
      this.die(
        `app-server 退出 code=${code} signal=${signal}${this.stderrTail ? ` stderr=${this.stderrTail.slice(-300)}` : ""}`,
      )
    })
  }

  private onLine(line: string): void {
    const frame = classifyFrame(line)
    switch (frame.kind) {
      case "non-json":
        return
      case "malformed":
        this.log.log("warn", "app-server-malformed-frame", { raw: frame.raw.slice(0, 200) })
        return
      case "unknown":
        this.log.log("debug", "app-server-unknown-frame", { raw: frame.raw.slice(0, 200) })
        return

      case "response": {
        const resolve = typeof frame.id === "number" ? this.pending.get(frame.id) : undefined
        if (resolve) {
          this.pending.delete(frame.id as number)
          resolve({ result: frame.result, error: frame.error })
        }
        return
      }

      case "server-request": {
        // 沉默 = 那一轮永久挂死。故障注入只吞**默认分支**，表里的照答。
        const fromTable = tableAnswer(frame.method)
        if (!fromTable && this.faults.has("drop-serverrequest-default")) {
          this.emit({ kind: "server-request", method: frame.method, id: frame.id, replied: "dropped" })
          return
        }
        const reply = fromTable ?? answerForServerRequest(frame.method)
        this.write({ jsonrpc: "2.0", id: frame.id, ...reply })
        this.emit({
          kind: "server-request",
          method: frame.method,
          id: frame.id,
          replied: fromTable ? "table" : "default-32601",
        })
        return
      }

      case "notification": {
        if (frame.method === "turn/started" && this.faults.has("drop-turn-started")) return
        this.emit({
          kind: "notification",
          method: frame.method,
          params: frame.params,
          threadId: notificationThreadId(frame.method, frame.params),
        })
        return
      }
    }
  }

  private emit(ev: ConnectionEvent): void {
    for (const h of [...this.handlers]) {
      try {
        h(ev)
      } catch (err) {
        this.log.log("error", "connection-handler-threw", { err: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  private write(msg: Parameters<typeof encodeFrame>[0]): void {
    try {
      this.transport.stdin?.write(encodeFrame(msg))
    } catch (err) {
      this.die(`写 stdin 失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private die(reason: string): void {
    if (!this.alive) return
    this.alive = false
    this.deadReason = reason

    for (const [, resolve] of this.pending) resolve({ error: { code: -3, message: reason } })
    this.pending.clear()

    // 正在跑的那些轮要立刻知道后端没了；默认无墙钟超时，不能靠看门狗收尾。
    this.emit({ kind: "lost", reason })

    const waiters = this.exitWaiters
    this.exitWaiters = []
    for (const w of waiters) w()
  }
}
