// 探针节点 e2edev:e2e-probe：pull 注册、自己的游标、只收回执。
// 它是 e2e 的「发送方 + 收件人」：nonce 从这里发出去，[seen]/[done]/[failed]/[rejected]
// 也回到这里——断言全部基于**探针真的收到了什么**，不看席位自己的日志（自证式证据陷阱）。

import type { MeshMessage } from "@cc-mesh/protocol"
import { parseReceipt, type Receipt } from "../../src/contracts.js"
import { MeshClient } from "../../src/mesh/mesh-client.js"
import { sleep, waitFor } from "./util.js"

/** 探针的 shortId。席位 allowlist 要按它放行（原 e2e/laneC/harness.ts，2026-09-02 集成时折进来）。 */
export const PROBE_SHORT_ID = "e2e-probe"

export interface Received {
  msg: MeshMessage
  receipt: Receipt | null
  atMs: number
}

export class Probe {
  readonly received: Received[] = []
  private cursor = 0
  private running = true
  private loopPromise: Promise<void> = Promise.resolve()
  private abort = new AbortController()

  private constructor(readonly nodeId: string, readonly client: MeshClient, readonly shortId: string) {}

  static async start(relayUrl: string, shortId = "e2e-probe"): Promise<Probe> {
    const client = new MeshClient(relayUrl)
    const { nodeId } = await client.register({ shortId, role: "worker", description: "codex-seat e2e probe", pid: process.pid })
    const p = new Probe(nodeId, client, shortId)
    p.loopPromise = p.loop()
    return p
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const batch = await this.client.sync({ nodeId: this.nodeId, since: this.cursor, timeoutSec: 5, limit: 100 }, this.abort.signal)
        for (const m of [...batch.messages].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))) {
          this.received.push({ msg: m, receipt: parseReceipt(m.payload), atMs: Date.now() })
        }
        this.cursor = batch.nextSince
      } catch {
        if (!this.running) return
        await sleep(200)
      }
    }
  }

  receipts(kind?: Receipt["kind"]): Receipt[] {
    return this.received
      .map((r) => r.receipt)
      .filter((r): r is Receipt => r != null && (kind == null || r.kind === kind))
  }

  byNonce(nonce: string, kind?: Receipt["kind"]): Received[] {
    return this.received.filter((r) => r.receipt != null && "nonce" in r.receipt && r.receipt.nonce === nonce && (kind == null || r.receipt.kind === kind))
  }

  /** 等一条满足条件的回执，返回它与到达时刻。 */
  async wait(pred: (r: Receipt, rec: Received) => boolean, timeoutMs: number, label: string): Promise<Received> {
    return await waitFor(() => this.received.find((rec) => rec.receipt != null && pred(rec.receipt, rec)), timeoutMs, label, 20)
  }

  /** 拉到 pred 满足（或超时）为止，返回见过的全部原始消息。Lane C 的脚本式 case 用。 */
  async collect(pred: (all: MeshMessage[]) => boolean, timeoutMs: number): Promise<MeshMessage[]> {
    const t0 = Date.now()
    for (;;) {
      const all = this.received.map((r) => r.msg)
      if (pred(all) || Date.now() - t0 > timeoutMs) return all
      await sleep(25)
    }
  }

  /** 给某个节点发一条带 nonce 的消息，返回 { msgId, sentAtMs }。 */
  async send(to: string, text: string): Promise<{ msgId: string; sentAtMs: number }> {
    const r = await this.client.send({ from: this.nodeId, to, message: text })
    return { msgId: r.msgId, sentAtMs: Date.now() }
  }

  async stop(): Promise<void> {
    this.running = false
    this.abort.abort()
    await this.loopPromise.catch(() => {})
  }
}
