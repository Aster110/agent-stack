import type { ITerminal } from "../terminal/interface.js"
import type { IUplink } from "../uplink/interface.js"
import type { ITransport, DeliveryTarget, DeliveryResult } from "./interface.js"
import type { MeshMessage } from "@cc-mesh/protocol"
import { genMessageId, now } from "@cc-mesh/protocol"

export interface CompositeTransportOptions {
  deviceId: string
}

export class CompositeTransport implements ITransport {
  constructor(
    private terminal: ITerminal,
    private uplink: IUplink,
    private opts: CompositeTransportOptions,
  ) {}

  async deliver(target: DeliveryTarget, text: string, msg?: MeshMessage): Promise<DeliveryResult> {
    if (target.type === "local") {
      const ok = await this.terminal.inject(target.sessionId, text, target.hint)
      return { delivered: ok, method: "terminal" }
    }
    // remote
    if (!this.uplink.isConnected()) {
      return { delivered: false, method: "uplink", error: "uplink not connected" }
    }
    // 跨机同一性铁律：有原件就原样转发——id/from/type/replyTo/meta/payload 一个字节都不许改。
    // 对端 downlink 着陆走 saveMessageIfAbsent(同 id 幂等)，全网这条消息永远只有一个身份。
    // 注入用的 [mesh:<from>] 前缀不进 payload，由收端投递时现加（payload 存的是原文）。
    //
    // 没原件才回落到"用 text 合成一条"——只剩老调用方会走，语义上是"匿名文本投递"。
    const wire: MeshMessage = msg ?? {
      id: genMessageId(this.opts.deviceId),
      from: this.opts.deviceId,
      to: target.nodeId,
      type: "chat",
      payload: text,
      createdAt: now(),
    }
    const ok = await this.uplink.send(wire)
    return { delivered: ok, method: "uplink" }
  }
}
