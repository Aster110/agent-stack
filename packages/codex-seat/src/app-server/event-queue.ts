/**
 * 通知是推过来的、消费是拉的，中间要一个不丢事件的缓冲。
 * 抽自 wechat-cc-channel codex-app-server.ts:161-192，泛型化。
 */
export class EventQueue<T> {
  private items: T[] = []
  private closed = false
  private waiter: (() => void) | null = null

  get size(): number {
    return this.items.length
  }

  get isClosed(): boolean {
    return this.closed
  }

  push(event: T): void {
    if (this.closed) return
    this.items.push(event)
    this.wake()
  }

  close(): void {
    this.closed = true
    this.wake()
  }

  async *drain(): AsyncGenerator<T> {
    for (;;) {
      while (this.items.length > 0) yield this.items.shift()!
      if (this.closed) return
      await new Promise<void>((resolve) => {
        this.waiter = resolve
      })
    }
  }

  private wake(): void {
    const w = this.waiter
    this.waiter = null
    w?.()
  }
}
