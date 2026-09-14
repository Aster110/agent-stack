/**
 * 注入式 logger。引擎层不认识 sidecar 的 jsonl 日志器，也不许直接 console——
 * 席位跑在 launchd 下，stdout 是给 supervisor 看的。Lane B/C 传自己的实现进来。
 */

export type LogLevel = "debug" | "info" | "warn" | "error"

export interface Logger {
  log(level: LogLevel, event: string, fields?: Record<string, unknown>): void
}

/** 默认什么都不记：单测/库调用不该往任何地方写字。 */
export const noopLogger: Logger = {
  log() {
    /* 故意为空 */
  },
}

/** 调试用：一行一条 JSON 到 stderr（stdout 留给 JSON-RPC 之外的调用方）。 */
export function stderrLogger(minLevel: LogLevel = "info"): Logger {
  const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }
  return {
    log(level, event, fields) {
      if (order[level] < order[minLevel]) return
      process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), level, event, ...fields })}\n`)
    },
  }
}
