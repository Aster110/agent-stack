import type { ITerminal } from "../terminal/interface.js"
import type { ITransport, DeliveryTarget, DeliveryResult } from "./interface.js"

export class LocalTransport implements ITransport {
  constructor(private terminal: ITerminal) {}

  async deliver(target: DeliveryTarget, text: string): Promise<DeliveryResult> {
    if (target.type === "local") {
      const ok = await this.terminal.inject(target.sessionId, text, target.hint)
      return { delivered: ok, method: "terminal" }
    }
    return { delivered: false, method: "terminal", error: "LocalTransport does not support remote targets" }
  }
}
