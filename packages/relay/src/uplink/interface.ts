/**
 * Uplink 抽象 — 到远端 relay 的连接。
 * 实际实现（WebSocket / HTTP SSE / gRPC）在 Phase 2+ 落地。
 */
import type { MeshMessage } from "@cc-mesh/protocol"

export interface IUplink {
  connect(): Promise<void>
  disconnect(): Promise<void>
  isConnected(): boolean
  send(msg: MeshMessage): Promise<boolean>
  onMessage(cb: (msg: MeshMessage) => void): void
}
