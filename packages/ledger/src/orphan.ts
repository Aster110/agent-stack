/**
 * 孤儿任务扫描 — 设计 §6.3 第三条（北极星 UU3 落地）。
 *
 * 判据是**两个条件的与**：派出去太久 AND 目标设备现在不在线。
 * 只满足"久"不标——worker 可能就是在慢慢干；只满足"不在线"也不标——刚断线可能马上重连。
 *
 * 纯函数：定时器、presence 来源都在调用方（Hub），这里只吃 store + 一个在线判定回调，
 * 所以能不起 WS 不起进程直接单测。
 */
import type { LedgerStore } from "./store.js"

export interface SweepResult {
  /** 本次新标为 orphaned 的 taskId 列表。 */
  orphaned: string[]
  /** 扫过的 dispatched 任务数（排障用）。 */
  scanned: number
}

/** nodeId → deviceId：取冒号前段；没有冒号就是整串。 */
export function deviceOf(nodeId: string): string {
  const i = nodeId.indexOf(":")
  return i < 0 ? nodeId : nodeId.slice(0, i)
}

export function sweep(
  store: LedgerStore,
  isDeviceOnline: (deviceId: string) => boolean,
  timeoutMs: number,
  nowMs: number = Date.now(),
): SweepResult {
  const pending = store.listTasks({ status: "dispatched", limit: 5000 })
  const orphaned: string[] = []
  for (const task of pending) {
    if (!task.toNode) continue                       // 不知道派给谁，判不了
    if (!task.createdAt) continue
    const startedMs = Date.parse(task.createdAt)
    if (Number.isNaN(startedMs)) continue            // 时间戳坏了，宁可不标也不误伤
    if (nowMs - startedMs <= timeoutMs) continue     // 还在窗口内

    const device = deviceOf(task.toNode)
    if (isDeviceOnline(device)) continue             // 人还在，只是慢

    if (!store.markTaskOrphaned(task.taskId)) continue  // 并发下已被别人标过
    store.insertEvent({
      kind: "orphan_marked",
      device,
      nodeId: task.toNode,
      detail: {
        taskId: task.taskId,
        dispatchedAt: task.createdAt,
        ageMs: nowMs - startedMs,
        timeoutMs,
      },
      ts: new Date(nowMs).toISOString(),
    })
    orphaned.push(task.taskId)
  }
  return { orphaned, scanned: pending.length }
}
