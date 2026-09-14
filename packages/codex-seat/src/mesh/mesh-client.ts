// IMeshClient 实现：席位 ↔ 本机 relay 的全部 HTTP。
//
// 三个不许猜错的点：
//  1. 注册形态恒为 pull（席位没有 pane，inject 形态的消息永远送不进来）。
//  2. sync 的 since 就是**销账**：传了且 > 服务端游标 relay 才 ack（server.ts:854-980）。
//     所以只能在「批次已写 WAL」之后才把新的 since 传出去。
//  3. send 的署名走 X-Mesh-Node 头，不是 body 字段；漏了会被 relay 兜底成 <device>:relay，
//     收方白名单直接拒（这也是决策 2 的安全围栏）。

import type { MeshMessage } from "@cc-mesh/protocol"
import {
  MeshHttpError,
  type IMeshClient,
  type RegisterRequest,
  type RelayNodeView,
  type SendRequest,
  type SyncBatch,
  type SyncRequest,
} from "../contracts.js"
import { makeAgents, requestJson } from "./http.js"

export interface MeshClientOptions {
  /** 非长轮询请求的墙钟上限，缺省 10s */
  requestTimeoutMs?: number
}

export class MeshClient implements IMeshClient {
  private readonly agents = makeAgents()
  private readonly requestTimeoutMs: number

  constructor(readonly relayUrl: string, opts: MeshClientOptions = {}) {
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 10_000
  }

  private api(p: string): string {
    return `${this.relayUrl.replace(/\/+$/, "")}/api${p}`
  }

  private unwrap(path: string, r: { status: number; text: string; json: unknown }): unknown {
    if (r.status < 200 || r.status >= 300) throw new MeshHttpError(r.status, r.text, path)
    const j = r.json as { ok?: boolean; data?: unknown; error?: string } | null
    if (j && j.ok === false) throw new MeshHttpError(r.status, j.error ?? r.text, path)
    return j?.data ?? null
  }

  async register(req: RegisterRequest): Promise<{ nodeId: string }> {
    const path = "/register"
    const r = await requestJson({
      method: "POST",
      url: this.api(path),
      timeoutMs: this.requestTimeoutMs,
      body: {
        shortId: req.shortId,
        role: req.role,
        description: req.description,
        pid: req.pid,
        // 席位/worker 都没有 pane：pull 形态，sessionId 交给 relay 生成 nopane- 占位。
        deliveryMode: "pull",
      },
    }, this.agents)
    const data = this.unwrap(path, r) as { nodeId?: string } | null
    if (!data?.nodeId) throw new MeshHttpError(r.status, r.text, path)
    return { nodeId: data.nodeId }
  }

  async unregister(nodeId: string): Promise<void> {
    const path = `/register/${encodeURIComponent(nodeId)}`
    const r = await requestJson({ method: "DELETE", url: this.api(path), timeoutMs: this.requestTimeoutMs }, this.agents)
    this.unwrap(path, r)
  }

  async sync(req: SyncRequest, signal?: AbortSignal): Promise<SyncBatch> {
    const q = new URLSearchParams({
      nodeId: req.nodeId,
      timeout: String(req.timeoutSec),
      limit: String(req.limit),
    })
    if (req.since !== undefined) q.set("since", String(req.since))
    const path = `/sync?${q.toString()}`
    const r = await requestJson({
      method: "GET",
      url: this.api(path),
      // 长轮询：给 relay 的 timeout 再加 10s 余量，网络卡死才由我们兜底。
      timeoutMs: (req.timeoutSec + 10) * 1000,
      ...(signal ? { signal } : {}),
    }, this.agents)
    const data = this.unwrap("/sync", r) as { messages?: MeshMessage[]; nextSince?: number; parkedMs?: number } | null
    return {
      messages: data?.messages ?? [],
      nextSince: data?.nextSince ?? req.since ?? 0,
      parkedMs: data?.parkedMs ?? 0,
    }
  }

  async send(req: SendRequest): Promise<{ msgId: string; status: string }> {
    const path = "/send"
    const r = await requestJson({
      method: "POST",
      url: this.api(path),
      timeoutMs: this.requestTimeoutMs,
      headers: { "X-Mesh-Node": req.from },
      body: {
        to: req.to,
        message: req.message,
        ...(req.type ? { type: req.type } : {}),
        ...(req.replyTo ? { replyTo: req.replyTo } : {}),
      },
    }, this.agents)
    const data = this.unwrap(path, r) as { msgId?: string; status?: string } | null
    return { msgId: data?.msgId ?? "", status: data?.status ?? "" }
  }

  async nodes(): Promise<RelayNodeView[]> {
    const path = "/status"
    const r = await requestJson({ method: "GET", url: this.api(path), timeoutMs: this.requestTimeoutMs }, this.agents)
    const data = this.unwrap(path, r) as { nodes?: Array<Record<string, any>> } | null
    return (data?.nodes ?? []).map((n) => ({
      nodeId: String(n.identity?.nodeId ?? ""),
      shortId: String(n.identity?.shortId ?? ""),
      role: String(n.identity?.role ?? ""),
      description: String(n.identity?.description ?? ""),
      // relay 入口已把 sse-pull/native-api 归一为 pull，这里照实透传。
      deliveryMode: String(n.identity?.deliveryMode ?? ""),
      pid: Number(n.pid ?? 0),
      status: String(n.status ?? ""),
      lastSyncAt: (n.lastSyncAt as string | null) ?? null,
    }))
  }
}
