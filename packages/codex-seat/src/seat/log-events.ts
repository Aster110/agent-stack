// sidecar JSONL 日志 → 事件计数。E2E 证据里「它真跑了」的活证据之一。
//
// 为什么单拎成一个纯函数放在 src/（而不是留在 e2e/lib/ 里）：
// 它原先在 e2e 支架里读的是 `o.ev`，而 sidecar 的 logger（seat.ts defaultFileLogger）
// 写的字段叫 `event` —— 于是这把尺子**一直返回空对象**，E07/E14 的 events 全靠各自
// 手写的常量计数撑着，看着有数字，其实一条真日志都没数进去。
// 坏掉的尺子不会报错，它会安静地返回 0，然后长得跟「真的没有事件」一模一样。
// 挪到 src/ 才进得了 `node --test dist/src/**/*.test.js` 的射程，才有人替它作证。

/** 一行日志里当作事件名的字段，按优先级取第一个存在的。 */
export const SEAT_LOG_EVENT_KEYS = ["event", "ev"] as const

/**
 * 从 JSONL 文本里数事件：每行一个 JSON 对象，取 `event`（sidecar 现行字段）
 * 或 `ev`（历史字段）当事件名。非 JSON 行、半行、没有事件名的行一律跳过。
 */
export function countSeatLogEvents(text: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const line of text.split("\n")) {
    const s = line.trim()
    if (!s.startsWith("{")) continue
    let o: Record<string, unknown>
    try {
      o = JSON.parse(s) as Record<string, unknown>
    } catch {
      continue // 崩溃点截断的半行
    }
    for (const k of SEAT_LOG_EVENT_KEYS) {
      const name = o[k]
      if (typeof name === "string" && name.length > 0) {
        out[name] = (out[name] ?? 0) + 1
        break
      }
    }
  }
  return out
}
