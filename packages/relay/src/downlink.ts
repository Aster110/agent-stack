import type { MeshMessage, NodeIdentity } from "@cc-mesh/protocol"
import { normalizeDeliveryMode } from "@cc-mesh/protocol"
import type { Registry } from "./registry.js"
import type { ITerminal } from "./terminal/interface.js"
import type { MeshEventBus } from "./events.js"
import { deliverToLocalNode, formatDelivery } from "./delivery/inject-pump.js"
import type { WakeHook } from "./wake.js"
import type { AttachmentClient } from "./attachments.js"
import { formatAttachmentsForDelivery } from "./attachments.js"

export interface DownlinkDeliveryOptions {
  msg: MeshMessage
  registry: Registry
  terminal: ITerminal
  removeNode?: (nodeId: string) => void
  sendRegistration?: (nodes: NodeIdentity[]) => Promise<void>
  events?: MeshEventBus
  /**
   * 幂等落库（方案 B PR2 归一）：跨机着陆一律 store-first（A3 公理，inject 目标也落库），
   * 按 msg.id INSERT OR IGNORE（uplink 有 retry，防重复行）。由 index.ts 注入 store.saveMessageIfAbsent。
   */
  saveMessage?: (msg: MeshMessage) => void
  /**
   * 温唤醒器（缺口 G1）。**必须与本机 send 路径共用同一个实例**——
   * 各持一份就各有一份去抖表和一份全局限速窗，同一节点会被两条路径各响一次铃。
   * 由 server.ts 的 createServer 闭包统一持有，经 app.deliverDownlink 注入。
   */
  wake?: WakeHook
  attachmentManager?: Pick<AttachmentClient, "materialize">
}

export interface DownlinkDeliveryResult {
  delivered: boolean
  reason?: "missing-node" | "inject-failed" | "pull-accepted"
}

export async function deliverDownlinkMessage(opts: DownlinkDeliveryOptions): Promise<DownlinkDeliveryResult> {
  const node = opts.registry.get(opts.msg.to)
  if (!node) return { delivered: false, reason: "missing-node" }

  // PR2 归一：跨机着陆与本机同一条投递路径——
  // ① store-first(A3 公理):投递动作前先落库(id 幂等,uplink retry 不产生重复行);
  //    inject 目标也落库,消息从此可审计、pane 死后可经 sync 补拉。
  // ② 分派收口 deliverToLocalNode:pull → accepted(门铃唤醒停车 sync);inject → 注入。
  //    downlink 自身零形态知识。
  //
  // 落库的是**原件本身**(id/type/replyTo/meta/payload 一字不改)——跨机同一性的落点:
  // 发端投原件、收端 INSERT OR IGNORE 同 id,全网这条消息只有一个身份,
  // 云端账本两端上报天然合成一行,worker 回 result 的 replyTo 也能对上原 task_id。
  opts.saveMessage?.(opts.msg)

  // 注入正文现加 [mesh:<from>] 前缀:前缀是投递装饰,不是消息内容,所以不进 payload、不跨机传。
  // (老实现由发端把前缀塞进 payload 送出去,对端库里存的就是带前缀的脏正文。)
  const baseDeliveryText = formatDelivery(opts.msg.from, opts.msg.payload)
  const deliveryText = normalizeDeliveryMode(node.identity.deliveryMode) === "inject"
    ? await formatAttachmentsForDelivery(baseDeliveryText, opts.msg, opts.attachmentManager)
    : baseDeliveryText

  let outcome: "delivered" | "accepted" | "failed"
  try {
    outcome = await deliverToLocalNode(node, deliveryText, { terminal: opts.terminal })
  } catch {
    outcome = "failed"
  }

  // ===== 温唤醒判定（缺口 G1）=====
  // 【两处判定必须同构：改这里必改 server.ts:505-509，反之亦然】
  //
  // 病史：wake 判定原本只接在本机 send 路径上，而跨机来信走的是这里。
  // 于是「server:brain 跨机派信给 computer2 的 Claude App 席位」永远不会触发唤醒——
  // 恰好是这套机制的正题场景。本机自测全绿、生产静默失效。
  //
  // 采样放在 emit **之前**：events.emit 是同步的，停车中的 sync 会当场 settle
  // 并把 parkedCount 减到 0，采样晚一步读到的就是「已经被服务过」的残局。
  // （今天真 Registry 里 markParked 同时会刷 lastSyncAt，freshness 那条腿会替它
  //   兜住——但那是两个不相干实现细节碰巧对上的巧合，不是判定该依赖的东西。）
  const parkedAtDecision = opts.registry.getParkedCount(opts.msg.to)
  const needsWake = outcome === "accepted" && !opts.registry.hasActiveConsumer(opts.msg.to)

  opts.events?.emit("msg:send", {
    msgId: opts.msg.id,
    from: opts.msg.from,
    to: opts.msg.to,
    status: outcome,
  })

  if (needsWake) opts.wake?.notify(opts.msg.to, parkedAtDecision, { source: "downlink" })

  if (outcome === "accepted") return { delivered: false, reason: "pull-accepted" }
  if (outcome === "delivered") return { delivered: true }

  // inject 失败:驱逐陈旧节点 + 同步 Hub 注册表(语义保留,只可能发生在 inject 形态)。
  opts.registry.unregister(node.identity.nodeId)
  opts.removeNode?.(node.identity.nodeId)
  opts.events?.emit("node:unregister", { nodeId: node.identity.nodeId })
  await opts.sendRegistration?.(opts.registry.getAll().map((n) => n.identity))
  return { delivered: false, reason: "inject-failed" }
}
