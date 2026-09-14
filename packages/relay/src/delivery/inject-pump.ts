import { normalizeDeliveryMode } from "@cc-mesh/protocol"
import type { LocalNode } from "@cc-mesh/protocol"
import type { ITerminal } from "../terminal/interface.js"
import type { ITransport } from "../transport/interface.js"

// 本地投递终态（方案 B PR2:unsupported-actuator 不再产生——native-api 收敛进 pull）:
// - delivered: 已注入目标 pane（inject 形态）
// - accepted:  已落库+门铃可达，端点经 /api/sync 自取（pull 形态）
// - failed:    inject 投递失败（pane 死 / sessionId 占位安全拦截）
export type LocalDeliveryOutcome = "delivered" | "accepted" | "failed"

export interface LocalDeliveryActuators {
  terminal: ITerminal
  transport?: ITransport
}

/**
 * 投递正文前缀：给注入的文本加 [mesh:<完整fromNodeId>]——收件 cc 直接看到谁发的，
 * 回信可原样 copy 作 `mesh send <from> "..."`。用完整 nodeId 而非 shortId（shortId 跨设备不唯一）。
 *
 * ⚠️ 前缀只加在**投递路径**上，store 永远存原始 payload。
 * 跨机也一样：发端不再把前缀塞进 payload 送出去（那样对端库里存的就是带前缀的脏正文），
 * 而是发端投原件、**收端注入时现加**——pane 看到的字节不变，两端库里都是干净原文。
 */
export function formatDelivery(fromNodeId: string | undefined, payload: string): string {
  if (!fromNodeId || fromNodeId === "unknown") return payload
  return `[mesh:${fromNodeId}] ${payload}`
}

// 形态知识全收口在这里（G4）:send/broadcast/downlink 一律调本函数，handler 只读终态。
// pull → accepted（正文走 store，门铃走 events，均由调用方保证已就位——store-first 公理 A3）。
// inject → InjectPump:nopane 守卫 + transport/terminal 注入。
export async function deliverToLocalNode(
  target: LocalNode,
  text: string,
  actuators: LocalDeliveryActuators,
): Promise<LocalDeliveryOutcome> {
  if (normalizeDeliveryMode(target.identity.deliveryMode) === "pull") {
    return "accepted"
  }

  // inject:注入前安全断言 sessionId 非空且非 nopane- 占位，
  // 否则直接 failed + 告警，绝不喂进 pickFor / paste-buffer（防占位串污染生产 pane）。
  const sessionId = target.sessionId
  if (!sessionId || sessionId.startsWith("nopane-")) {
    console.warn(
      `[mesh] refuse inject: invalid sessionId for node ${target.identity.nodeId} ` +
      `(deliveryMode=inject, sessionId=${JSON.stringify(sessionId)})`,
    )
    return "failed"
  }

  if (actuators.transport) {
    const r = await actuators.transport.deliver({ type: "local", sessionId }, text)
    return r.delivered ? "delivered" : "failed"
  }
  const ok = await actuators.terminal.inject(sessionId, text)
  return ok ? "delivered" : "failed"
}
