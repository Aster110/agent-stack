import path from "node:path"
import os from "node:os"
import { createHub } from "./hub.js"
import { HUB_WS_PORT, LEDGER_HTTP_PORT } from "@cc-mesh/protocol"
import { NoAuth, TokenAuth } from "./auth.js"
import type { IAuth } from "./auth.js"
import type { HubLedgerOptions, HubForwarderOptions } from "./ledger-mount.js"
import type { HubAttachmentOptions } from "./attachments.js"

export { createHub } from "./hub.js"
export type { HubOptions, HubInstance } from "./hub.js"
export type { IAuth } from "./auth.js"
export { NoAuth, TokenAuth } from "./auth.js"
export { mountLedger, DEFAULT_ORPHAN_TIMEOUT_MS, DEFAULT_SWEEP_INTERVAL_MS } from "./ledger-mount.js"
export type { HubLedgerOptions, HubForwarderOptions, LedgerMount } from "./ledger-mount.js"
export type { HubAttachmentOptions, HubAttachmentMount } from "./attachments.js"

/**
 * 按环境变量选择 Hub 鉴权实现。
 * - HUB_TOKEN 非空 → TokenAuth（relay 必须带对 token 才放行）
 * - 未设 / 空 / 纯空白 → NoAuth（向后兼容：现有无 token 部署行为不变）
 * token 做 trim，与 relay 侧 resolveHubToken 的 trim 对齐。
 */
export function authFromEnv(env: NodeJS.ProcessEnv = process.env): IAuth {
  const token = env.HUB_TOKEN?.trim()
  if (token && token.length > 0) return new TokenAuth(token)
  return new NoAuth()
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir()
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2))
  return p
}

function posInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined
}

function strictPosInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined
  const n = Number(raw)
  return Number.isSafeInteger(n) && n > 0 ? n : undefined
}

export function attachmentsFromEnv(env: NodeJS.ProcessEnv = process.env): HubAttachmentOptions | undefined {
  const off = (env.ATTACHMENTS_DISABLED ?? "").trim().toLowerCase()
  if (["1", "true", "yes"].includes(off) || !env.HUB_TOKEN?.trim()) return undefined
  return {
    rootDir: expandHome((env.ATTACHMENT_BLOB_DIR ?? "").trim() || path.join(os.homedir(), ".ccmesh", "blobs")),
    maxBytes: strictPosInt(env.ATTACHMENT_MAX_BYTES) ?? 10 * 1024 * 1024,
    quotaBytes: strictPosInt(env.ATTACHMENT_QUOTA_BYTES) ?? 512 * 1024 * 1024,
    maxPixels: strictPosInt(env.ATTACHMENT_MAX_PIXELS) ?? 25_000_000,
    defaultTtlSeconds: strictPosInt(env.ATTACHMENT_DEFAULT_TTL_SECONDS) ?? 24 * 60 * 60,
  }
}

/**
 * 账本配置的环境变量接线（设计 §3.1 挂载点）。
 *
 * - `LEDGER_DISABLED=1` 逃生阀：**缺省启用**账本，出事一个环境变量退回纯路由 Hub。
 * - `LEDGER_DB` 缺省 `~/.ccmesh/ledger.db`（部署脚本会指到 /opt/cc-mesh-hub/ledger.db）。
 * - `LEDGER_HTTP_PORT` 缺省 19901。
 * - 读 API 的 token **复用 HUB_TOKEN**，不新造一个秘密。没有 HUB_TOKEN → 读 API 不启动。
 */
export function ledgerFromEnv(env: NodeJS.ProcessEnv = process.env): HubLedgerOptions | undefined {
  const off = (env.LEDGER_DISABLED ?? "").trim().toLowerCase()
  if (off === "1" || off === "true" || off === "yes") return undefined
  return {
    dbPath: expandHome((env.LEDGER_DB ?? "").trim() || path.join(os.homedir(), ".ccmesh", "ledger.db")),
    httpPort: posInt(env.LEDGER_HTTP_PORT) ?? LEDGER_HTTP_PORT,
    token: env.HUB_TOKEN?.trim(),
    orphanTimeoutMs: posInt(env.LEDGER_ORPHAN_TIMEOUT_MS),
    forwarder: forwarderFromEnv(env),
  }
}

/**
 * D1 冷层转发的环境变量接线（展示面设计 §6）。
 *
 * - `CONSOLE_INGEST_URL` + `CONSOLE_INGEST_TOKEN` **两个都设**才开；缺任何一个 → undefined
 *   = 完全关闭 = 零行为零回归（半配置 fail-closed，不朝云端打 401）。
 * - `LEDGER_RETENTION_DAYS` 是**第二个开关**：给正数才开热层清理。转发跑通 + 六表对账
 *   一致之后才由人打开（设计 §7 部署顺序第 6 步）。
 *
 * 语义与 `@cc-mesh/ledger` 的 `forwarderFromEnv` 逐条一致（那边有单测，hub 侧有交叉校验测试）。
 * 这里**故意不 import 它**：@cc-mesh/ledger 必须保持懒加载——better-sqlite3 是原生模块，
 * 服务器上编译失败时 Hub 得能退回纯路由裸跑（ledger-mount.ts 顶部纪律 1）。
 */
export function forwarderFromEnv(env: NodeJS.ProcessEnv = process.env): HubForwarderOptions | undefined {
  const url = (env.CONSOLE_INGEST_URL ?? "").trim()
  const token = (env.CONSOLE_INGEST_TOKEN ?? "").trim()
  if (!url || !token) return undefined

  const raw = (env.LEDGER_RETENTION_DAYS ?? "").trim()
  const days = Number(raw)
  const enabled = raw !== "" && Number.isFinite(days) && days > 0
  return { url, token, retention: { enabled, days: enabled ? days : 7 } }
}

// 直接运行时启动 Hub（node dist/index.js）
if (require.main === module) {
  const port = Number(process.env.MESH_HUB_PORT ?? HUB_WS_PORT)
  const auth = authFromEnv()
  const authKind = auth instanceof TokenAuth ? "TokenAuth" : "NoAuth"
  const ledger = ledgerFromEnv()
  const attachments = attachmentsFromEnv()
  createHub({ port, auth, ledger, attachments }).then((hub) => {
    const ledgerKind = !ledger
      ? "disabled"
      : hub.ledger
        ? `on:${ledger.dbPath}${hub.ledger.httpPort ? ` api::${hub.ledger.httpPort}` : " api:off(no HUB_TOKEN)"}`
        : "failed"
    const forwardKind = hub.ledger?.forwarder ? `on(${hub.ledger.forwarder.ingestUrl})` : "off"
    console.log(
      `[cc-mesh-hub] 已启动 ws://localhost:${hub.port} (auth: ${authKind}, ledger: ${ledgerKind}, d1-forward: ${forwardKind})`,
    )
    const shutdown = async () => {
      console.log("[cc-mesh-hub] 正在关闭...")
      await hub.close()
      process.exit(0)
    }
    process.on("SIGINT", shutdown)
    process.on("SIGTERM", shutdown)
  }).catch((err) => {
    console.error("[cc-mesh-hub] 启动失败:", err)
    process.exit(1)
  })
}
