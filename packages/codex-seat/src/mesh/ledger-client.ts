// ILedgerClient：直连 Hub 账本 :19901 登记 durable seat。
//
// 密钥纪律（CLAUDE.md 红线）：token 只从 tokenFile 读，**不进日志、不进错误信息、不进 mesh**。
// 所以这里抛的错只带 HTTP 状态码与响应体片段，永不回显请求头。

import fs from "node:fs"

import { MeshHttpError, type ILedgerClient, type LedgerSeatUpsert } from "../contracts.js"
import { makeAgents, requestJson } from "./http.js"

export class LedgerClient implements ILedgerClient {
  private readonly agents = makeAgents()

  constructor(
    readonly ledgerUrl: string,
    readonly tokenFile: string,
    private readonly timeoutMs = 5000,
  ) {}

  private readToken(): string {
    // 读失败要报「读不到 token 文件」，但不许把内容/路径以外的东西带出去。
    const raw = fs.readFileSync(this.tokenFile, "utf8")
    const token = raw.trim()
    if (!token) throw new Error(`hub token file is empty: ${this.tokenFile}`)
    return token
  }

  async upsertSeat(input: LedgerSeatUpsert): Promise<void> {
    const token = this.readToken()
    const path = "/api/ledger/seats"
    const r = await requestJson({
      method: "PUT",
      url: `${this.ledgerUrl.replace(/\/+$/, "")}${path}`,
      timeoutMs: this.timeoutMs,
      headers: { authorization: `Bearer ${token}` },
      body: input,
    }, this.agents)
    if (r.status < 200 || r.status >= 300) {
      // 只带状态码 + 响应体片段（MeshHttpError 自己截 200 字），请求头一个字都不带。
      throw new MeshHttpError(r.status, r.text, path)
    }
    const j = r.json as { ok?: boolean; error?: string } | null
    if (j && j.ok === false) throw new MeshHttpError(r.status, j.error ?? "ledger rejected", path)
  }
}
