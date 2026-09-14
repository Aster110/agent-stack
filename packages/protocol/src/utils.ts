import { randomUUID } from "node:crypto"

/** 生成短 ID: cc-xxxx */
export function genShortId(): string {
  return `cc-${randomUUID().slice(0, 4)}`
}

/** 生成全局节点 ID: {deviceId}:{shortId} */
export function genNodeId(deviceId: string, shortId: string): string {
  return `${deviceId}:${shortId}`
}

/** 解析 nodeId → { deviceId, shortId } */
export function parseNodeId(nodeId: string): { deviceId: string; shortId: string } {
  const idx = nodeId.indexOf(":")
  if (idx === -1) return { deviceId: "local", shortId: nodeId }
  return { deviceId: nodeId.slice(0, idx), shortId: nodeId.slice(idx + 1) }
}

// 毫秒内单调序号:同进程同毫秒连发不碰撞(旧格式 msg-<ts>-<from> 同毫秒同 id,
// 叠加 store 的 INSERT OR REPLACE 会静默丢消息)。随机后缀兜跨进程同 from 的极端情况。
let msgSeqInMs = 0
let msgSeqLastMs = 0

/** 生成消息 ID: msg-<ts>-<毫秒内序号>-<随机4位>-<from> */
export function genMessageId(fromNodeId: string): string {
  const ts = Date.now()
  if (ts === msgSeqLastMs) {
    msgSeqInMs++
  } else {
    msgSeqLastMs = ts
    msgSeqInMs = 0
  }
  const rand = Math.random().toString(36).slice(2, 6)
  return `msg-${ts}-${msgSeqInMs.toString(36)}-${rand}-${fromNodeId}`
}

/** ISO 8601 本地时间 */
export function now(): string {
  return new Date().toISOString()
}

// deliveryMode 收敛(方案 B PR2):运行时只有两种可达性——能被注入(inject)/自取(pull)。
// 只有显式 "inject" 或缺省才算 inject;其余一切值(sse-pull/native-api/poll-only/未知)按 pull。
// 保守方向与 downlink pull 守卫一致:宁可少注入,不可对无 pane 端点盲注。
export function normalizeDeliveryMode(mode?: string | null): "inject" | "pull" {
  return mode == null || mode === "inject" ? "inject" : "pull"
}
