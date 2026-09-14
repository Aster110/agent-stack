// SpyEngine：**不是第二个假引擎**，只是套在任意 IAppServerClient 外面的观察装饰器。
//
// 为什么需要它：Lane A 的 FakeAppServerClient 只内省 events()/threadConfig()，而席位层要断言的是
// 「同一 thread 上有没有并发 turn」「超时有没有真的 interrupt」「compact 调了几次」「thread/start
// 带的 developerInstructions 是不是 worker 版」——这些是**调用侧**的事实，装饰器抓最准，也不用
// 在引擎里塞测试专用字段（Lane A 的文件一个字都不改）。

import type {
  AccountInfo,
  CompactOutcome,
  EngineEvent,
  EngineInfo,
  EngineStopOptions,
  IAppServerClient,
  RateLimitsSnapshot,
  ThreadInfo,
  ThreadResumeRequest,
  ThreadStartRequest,
  TurnHandle,
  TurnStartRequest,
} from "../../contracts.js"

export class SpyEngine implements IAppServerClient {
  readonly threadStarts: ThreadStartRequest[] = []
  readonly threadResumes: ThreadResumeRequest[] = []
  readonly turnCalls: TurnStartRequest[] = []
  readonly interrupts: Array<{ threadId: string; turnId: string | null }> = []
  readonly compactCalls: string[] = []
  /** 同一 thread 上出现第二个未收尾的 turn = 席位层的串行队列漏了 */
  readonly concurrencyViolations: string[] = []
  maxConcurrentTurns = 0
  stopCalls = 0

  private readonly threadInfo = new Map<string, { config?: Record<string, unknown>; instructions?: string }>()
  private readonly activeOnThread = new Map<string, string>()
  private readonly handlers = new Set<(ev: EngineEvent) => void>()
  private unsubInner: (() => void) | null = null
  private running = 0

  constructor(private readonly inner: IAppServerClient) {}

  get kind(): "real" | "fake" { return this.inner.kind }

  configOf(threadId: string): Record<string, unknown> | undefined { return this.threadInfo.get(threadId)?.config }
  instructionsOf(threadId: string): string | undefined { return this.threadInfo.get(threadId)?.instructions }

  async start(): Promise<EngineInfo> { return await this.inner.start() }
  async stop(opts?: EngineStopOptions): Promise<void> { this.stopCalls++; return await this.inner.stop(opts) }
  isAlive(): boolean { return this.inner.isAlive() }
  info(): EngineInfo | null { return this.inner.info() }
  async loadedThreads(): Promise<string[]> { return await this.inner.loadedThreads() }
  async rateLimits(): Promise<RateLimitsSnapshot> { return await this.inner.rateLimits() }
  async account(): Promise<AccountInfo> { return await this.inner.account() }
  /**
   * 事件订阅走自己的一份 handler 表（转发 inner 的 + 允许测试注入）。
   * 为什么要能注入：`engine.lost` 是真引擎的 stdio 断了才发的，假引擎自然产生不出来，
   * 而「引擎中途换代之后 state.engine 有没有回填」正好只有这条路径能验。
   */
  onEvent(handler: (ev: EngineEvent) => void): () => void {
    this.handlers.add(handler)
    this.unsubInner ??= this.inner.onEvent((ev) => this.emit(ev))
    return () => { this.handlers.delete(handler) }
  }

  /** 测试钩子：注入一条引擎事件 */
  emit(ev: EngineEvent): void {
    for (const h of [...this.handlers]) h(ev)
  }

  /** 测试钩子：让底层引擎真的「死掉」，再报 engine.lost —— 下一次 start() 就是新的一代 */
  async simulateEngineDeath(reason = "test-kill"): Promise<void> {
    await this.inner.stop()
    this.emit({ type: "engine.lost", reason })
  }

  async threadStart(req: ThreadStartRequest): Promise<ThreadInfo> {
    this.threadStarts.push(req)
    const info = await this.inner.threadStart(req)
    this.threadInfo.set(info.threadId, {
      ...(req.config ? { config: req.config } : {}),
      ...(req.developerInstructions ? { instructions: req.developerInstructions } : {}),
    })
    return info
  }

  async threadResume(req: ThreadResumeRequest): Promise<ThreadInfo> {
    this.threadResumes.push(req)
    const info = await this.inner.threadResume(req)
    const prev = this.threadInfo.get(info.threadId) ?? {}
    this.threadInfo.set(info.threadId, {
      ...prev,
      ...(req.config ? { config: req.config } : {}),
      ...(req.developerInstructions ? { instructions: req.developerInstructions } : {}),
    })
    return info
  }

  async turnStart(req: TurnStartRequest): Promise<TurnHandle> {
    this.turnCalls.push(req)
    const prior = this.activeOnThread.get(req.threadId)
    if (prior) this.concurrencyViolations.push(`${req.threadId} 上 ${prior} 还没收尾，又来了 ${req.msgId}`)
    const handle = await this.inner.turnStart(req)
    this.activeOnThread.set(req.threadId, req.msgId)
    this.running++
    this.maxConcurrentTurns = Math.max(this.maxConcurrentTurns, this.running)
    const release = (): void => {
      if (this.activeOnThread.get(req.threadId) === req.msgId) {
        this.activeOnThread.delete(req.threadId)
        this.running--
      }
    }
    void handle.done.then(release, release)
    return {
      ...handle,
      interrupt: async () => {
        this.interrupts.push({ threadId: req.threadId, turnId: handle.turnId })
        await handle.interrupt()
      },
    }
  }

  async turnInterrupt(threadId: string, turnId: string): Promise<void> {
    this.interrupts.push({ threadId, turnId })
    await this.inner.turnInterrupt(threadId, turnId)
  }

  async compact(threadId: string, timeoutMs: number): Promise<CompactOutcome> {
    this.compactCalls.push(threadId)
    return await this.inner.compact(threadId, timeoutMs)
  }
}
