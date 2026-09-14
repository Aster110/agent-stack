/**
 * 线协议：**换行分隔的 JSON-RPC 2.0**（不是 LSP 的 Content-Length 分帧）。
 *
 * 这个文件只做字节 ↔ 帧的翻译，不碰进程、不碰状态，好让分帧的边界情况
 * （半包、粘包、CRLF、banner 行）能被单测直接打。
 */

// ---------------------------------------------------------------------------
// 出向
// ---------------------------------------------------------------------------

export interface OutboundFrame {
  jsonrpc: "2.0"
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string }
}

/**
 * 序列化成一行。`params: undefined` 的键会被 JSON.stringify 丢掉——
 * 这正是 `account/rateLimits/read`（协议上 `params: undefined`）需要的行为。
 */
export function encodeFrame(msg: OutboundFrame): string {
  return `${JSON.stringify(msg)}\n`
}

// ---------------------------------------------------------------------------
// 入向：分帧
// ---------------------------------------------------------------------------

/** 增量喂字节，吐出完整的行。跨 chunk 的半条 JSON 会留在缓冲里等下一块。 */
export class LineSplitter {
  private buf = ""

  push(chunk: string | Buffer): string[] {
    this.buf += typeof chunk === "string" ? chunk : chunk.toString("utf8")
    const out: string[] = []
    for (;;) {
      const i = this.buf.indexOf("\n")
      if (i === -1) break
      const line = this.buf.slice(0, i).replace(/\r$/, "")
      this.buf = this.buf.slice(i + 1)
      if (line.length > 0) out.push(line)
    }
    return out
  }

  /** 进程退出时把没有换行结尾的最后一截也交出来。 */
  flush(): string[] {
    const rest = this.buf.replace(/\r$/, "")
    this.buf = ""
    return rest.length > 0 ? [rest] : []
  }
}

// ---------------------------------------------------------------------------
// 入向：帧分类
// ---------------------------------------------------------------------------

export type InboundFrame =
  /** 不是 JSON（banner、日志行）——忽略，别当协议错误 */
  | { kind: "non-json" }
  /** 以 { 开头但解析失败——记一笔，说明对端在吐坏字节 */
  | { kind: "malformed"; raw: string }
  /** 我们发出去的请求的回包 */
  | { kind: "response"; id: number | string; result?: unknown; error?: { code: number; message: string } }
  /** 服务端发起的请求：**必须应答**，不答那一轮永久挂死 */
  | { kind: "server-request"; id: number | string; method: string; params: any }
  /** 单向通知 */
  | { kind: "notification"; method: string; params: any }
  /** 结构认不出来 */
  | { kind: "unknown"; raw: string }

export function classifyFrame(line: string): InboundFrame {
  const s = line.trim()
  if (!s.startsWith("{")) return { kind: "non-json" }
  let msg: any
  try {
    msg = JSON.parse(s)
  } catch {
    return { kind: "malformed", raw: s }
  }
  if (msg == null || typeof msg !== "object") return { kind: "unknown", raw: s }

  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    return { kind: "response", id: msg.id, result: msg.result, error: msg.error }
  }
  if (typeof msg.method === "string" && msg.id !== undefined) {
    return { kind: "server-request", id: msg.id, method: msg.method, params: msg.params ?? {} }
  }
  if (typeof msg.method === "string") {
    return { kind: "notification", method: msg.method, params: msg.params ?? {} }
  }
  return { kind: "unknown", raw: s }
}

// ---------------------------------------------------------------------------
// 通知的路由键
// ---------------------------------------------------------------------------

/**
 * 通知归哪条 thread。
 *
 * 多数通知顶层就有 `threadId`，但 **`thread/started` 没有**——它只有
 * `params.thread`（见 `ThreadStartedNotification { thread: Thread }`）。
 * 只按 `params.threadId` 取会把它当广播，`item/completed` 这类才会串台。
 *
 * 返回 null = 进程级广播（额度更新、无 thread 的 MCP 启动状态、warning…）。
 */
export function notificationThreadId(method: string, params: unknown): string | null {
  if (params == null || typeof params !== "object") return null
  const p = params as Record<string, unknown>
  if (typeof p.threadId === "string" && p.threadId.length > 0) return p.threadId
  const thread = p.thread as { id?: unknown } | undefined
  if (thread && typeof thread.id === "string" && thread.id.length > 0) return thread.id
  return null
}
