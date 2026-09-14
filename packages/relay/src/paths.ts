import os from "node:os"
import path from "node:path"

export const MESH_DIRNAME = ".ccmesh"

export function meshHome(home: string = os.homedir()): string {
  return path.join(home, MESH_DIRNAME)
}

export function dbPath(home: string = os.homedir()): string {
  const override = process.env.MESH_DB_PATH
  if (override && override.length > 0) return override
  return path.join(meshHome(home), "db", "mesh.db")
}

export function pidPath(home: string = os.homedir()): string {
  return path.join(meshHome(home), "relay.pid")
}

export function contextDir(home: string = os.homedir()): string {
  return path.join(meshHome(home), "context")
}

export function profilesDir(home: string = os.homedir()): string {
  return path.join(meshHome(home), "agents")
}

export function cacheDir(home: string = os.homedir()): string {
  return path.join(meshHome(home), "cache")
}

function readPositiveInt(envKey: string, defaultMs: number, minMs: number): number {
  const raw = process.env[envKey]
  if (!raw) return defaultMs
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n < minMs) return minMs
  return n
}

/**
 * relay → hub WS frame ping 间隔（D29）。
 * 默认 30s。最小 100ms（仅供测试,生产从不用这么短）。
 * 4090 跨境弱网建议 systemd env 调到 20000。
 */
export function pingIntervalMs(): number {
  return readPositiveInt("MESH_PING_INTERVAL_MS", 30000, 100)
}

/**
 * pong 超时阈值（D29）。lastPongAt 超过此值即认为 ws 假连接,terminate + 重连。
 * 默认 60s（ping 间隔 2 倍,容错 2 次心跳）。最小 200ms（测试用）。
 */
export function pongTimeoutMs(): number {
  return readPositiveInt("MESH_PONG_TIMEOUT_MS", 60000, 200)
}

/**
 * mesh send 失败的重试次数（D29，仅 uplink/remote 分支生效）。
 * 默认 1 次重试；0 禁用。负数/非法值兜底 0。
 */
export function sendRetryCount(): number {
  const raw = process.env.MESH_SEND_RETRY
  if (!raw) return 1
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 0) return 0
  return n
}
