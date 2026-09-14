/**
 * Transport 抽象 — 统一消息投递动作。
 * 本地目标走 terminal.inject；远端目标走 uplink（Phase 2+）。
 */
import type { MeshMessage } from "@cc-mesh/protocol"

export type DeliveryTarget =
  | { type: "local"; sessionId: string; hint?: { windowId?: string } }
  | { type: "remote"; deviceId: string; nodeId: string }

export type DeliveryMethod = "terminal" | "uplink"

export interface DeliveryResult {
  delivered: boolean
  method: DeliveryMethod
  error?: string
}

export interface ITransport {
  /**
   * @param text 投递用的正文（inject 形态会带 [mesh:<from>] 前缀）
   * @param msg  **跨机原件**：remote 目标必须带上，uplink 原样转发它。
   *             不带 = 老行为（remote 分支现造一条 MeshMessage）——那条路会把
   *             id 重铸、type 退化成 chat、meta/replyTo 丢光，云端账本一条逻辑
   *             消息变两行、replyTo 对不上 task_id（2026-08-27 真环境 E2E 抓到）。
   *             可选是为了兼容只有 text 的老调用方；local 目标用不上。
   */
  deliver(target: DeliveryTarget, text: string, msg?: MeshMessage): Promise<DeliveryResult>
}
