/**
 * MeshEventBus — relay 关键操作事件总线
 *
 * 事件：
 *   node:register    { node: LocalNode }
 *   node:unregister  { nodeId: string }
 *   msg:send         { msgId, from, to, status }
 *   msg:delivered    { msgId: string }
 *   uplink:status    { connected: boolean, hubUrl?: string }
 *   wake:needed      { nodeId, parkedCount }
 *
 * 监听器抛异常不影响同事件的其他监听器。
 */
import type { LocalNode } from "@cc-mesh/protocol"

export type MeshEventMap = {
  "node:register": { node: LocalNode }
  "node:unregister": { nodeId: string }
  "msg:send": { msgId: string; from: string; to: string; status: string }
  "msg:delivered": { msgId: string }
  "uplink:status": { connected: boolean; hubUrl?: string }
  /**
   * 有消息投给了一个没人接货的 pull 节点——该把它叫醒了。
   * parkedCount 是**判定当时**的采样值（正常就是 0），用于排障时看清是不是误判。
   * 只是「需要唤醒」的信号，怎么唤醒由订阅者 / MESH_WAKE_HOOK 决定。
   */
  "wake:needed": { nodeId: string; parkedCount: number }
}

export type MeshEventName = keyof MeshEventMap
type AnyListener = (data: any) => void

export class MeshEventBus {
  private listeners = new Map<MeshEventName, Set<AnyListener>>()

  on<K extends MeshEventName>(event: K, fn: (data: MeshEventMap[K]) => void): void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(fn as AnyListener)
  }

  off<K extends MeshEventName>(event: K, fn: (data: MeshEventMap[K]) => void): void {
    this.listeners.get(event)?.delete(fn as AnyListener)
  }

  emit<K extends MeshEventName>(event: K, data: MeshEventMap[K]): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const fn of [...set]) {
      try { fn(data) } catch { /* 吞掉，不影响其他监听器 */ }
    }
  }
}
