import path from "node:path"
import os from "node:os"
import fs from "node:fs"
import type { MeshServer } from "./server.js"
import type { WebSocketUplink } from "./uplink/websocket.js"
import { resolveHubToken } from "./uplink/websocket.js"
import type { DeviceInventory, MeshResponse, SpawnRequest } from "@cc-mesh/protocol"
import { AttachmentManager } from "./attachments.js"

export interface WireRelayUplinkOptions {
  app: MeshServer
  uplink: WebSocketUplink
  onDevices?: (devices: DeviceInventory[]) => void
  onSpawn?: (requestId: string, replyRelayId: string, spawn: SpawnRequest) => Promise<MeshResponse>
}

/** The one production/test downlink wiring seam. */
export function wireRelayUplink(opts: WireRelayUplinkOptions): void {
  opts.uplink.onDevices((devices) => opts.onDevices?.(devices))
  opts.uplink.onSpawnRequest((requestId, replyRelayId, spawn) =>
    opts.onSpawn
      ? opts.onSpawn(requestId, replyRelayId, spawn)
      : opts.app.spawnLocal(spawn as unknown as Record<string, unknown>))
  opts.uplink.onMessage((msg) => { void opts.app.deliverDownlink(msg) })
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir()
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2))
  return value
}

export interface AttachmentRuntimeConfigOptions {
  homeDir?: string
  ledgerUrlFile?: string
}

function strictHttpOrigin(raw: string): string | undefined {
  const value = raw.trim()
  if (!value || /[\r\n]/.test(value)) return undefined
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined
    if (parsed.username || parsed.password) return undefined
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) return undefined
    return parsed.origin
  } catch {
    return undefined
  }
}

function attachmentHubOrigin(
  env: NodeJS.ProcessEnv,
  config: AttachmentRuntimeConfigOptions,
): string | undefined {
  let raw: string
  if (Object.prototype.hasOwnProperty.call(env, "MESH_HUB_HTTP_URL")) {
    raw = env.MESH_HUB_HTTP_URL ?? ""
  } else if (Object.prototype.hasOwnProperty.call(env, "MESH_LEDGER_URL")) {
    raw = env.MESH_LEDGER_URL ?? ""
  } else {
    const homeDir = config.homeDir ?? os.homedir()
    const ledgerUrlFile = config.ledgerUrlFile ?? path.join(homeDir, ".ccmesh", "ledger-url")
    try {
      raw = fs.readFileSync(ledgerUrlFile, "utf8")
    } catch {
      return undefined
    }
  }
  return strictHttpOrigin(raw)
}

export function attachmentManagerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  tokenOverride?: string,
  config: AttachmentRuntimeConfigOptions = {},
): AttachmentManager | undefined {
  const off = (env.MESH_ATTACHMENTS_DISABLED ?? "").trim().toLowerCase()
  if (["1", "true", "yes"].includes(off)) return undefined
  const hubHttpBase = attachmentHubOrigin(env, config)
  const token = tokenOverride?.trim() || resolveHubToken({ env, homeDir: config.homeDir })
  const cache = (env.MESH_ATTACHMENT_CACHE_DIR ?? "").trim()
    || path.join(os.homedir(), ".ccmesh", "cache", "attachments")
  if (!hubHttpBase || !token || !cache) return undefined
  try {
    return new AttachmentManager({ hubHttpBase, token, cacheDir: expandHome(cache), fetchImpl })
  } catch { return undefined }
}
