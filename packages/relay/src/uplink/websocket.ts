import { WebSocket } from "ws"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Agent as HttpAgent } from "node:http"
import type { Agent as HttpsAgent } from "node:https"
import type {
  MeshMessage, UplinkMessage, DownlinkMessage, RelayRegistration, NodeIdentity, DeviceInventory, MeshResponse, SpawnRequest,
  LedgerUplinkEvent,
} from "@cc-mesh/protocol"
import type { IUplink } from "./interface.js"
import { pingIntervalMs, pongTimeoutMs, meshHome } from "../paths.js"

export interface WebSocketUplinkOptions {
  hubUrl: string
  getRegistration: () => RelayRegistration
  reconnectMs?: number
  ackTimeoutMs?: number
  /**
   * 可选 HTTP proxy agent。传入后，WebSocket 通过该 agent 出网。
   * 典型用法：CN 节点或 WSL 节点需要走 Clash 代理连跨境 Hub 时，
   * 在 bootstrap 层 (`index.ts`) 按 env 构造 agent 注入。
   * 不传 = 直连，行为不变。
   */
  agent?: HttpAgent | HttpsAgent
  /**
   * 可选 Hub 鉴权 token。传入后，register 消息（含重连时重发）都会带上。
   * 存在 opts 上（构造时保存），重连走 openOnce→sendRegister 时自动重新读取。
   * 不传 = 不带 token，行为不变（Hub 若是 NoAuth 仍放行）。
   * token 来源解析见 {@link resolveHubToken}。
   */
  token?: string
}

/**
 * 解析 relay 连 Hub 用的鉴权 token，优先级：
 *   1. env MESH_HUB_TOKEN（trim 后非空）
 *   2. 文件 ~/.ccmesh/hub-token（trim 后非空）
 *   3. 无 → undefined（行为不变）
 * 注入 env / homeDir 便于测试，绝不打印 token 值。
 */
export function resolveHubToken(opts: { env?: NodeJS.ProcessEnv; homeDir?: string } = {}): string | undefined {
  const env = opts.env ?? process.env
  const fromEnv = env.MESH_HUB_TOKEN?.trim()
  if (fromEnv && fromEnv.length > 0) return fromEnv

  const home = opts.homeDir ?? os.homedir()
  const tokenFile = path.join(meshHome(home), "hub-token")
  try {
    const fromFile = fs.readFileSync(tokenFile, "utf8").trim()
    if (fromFile.length > 0) return fromFile
  } catch {
    // 文件不存在/不可读 → 无 token（行为不变）
  }
  return undefined
}

export class WebSocketUplink implements IUplink {
  private ws: WebSocket | null = null
  private shouldReconnect = false
  private reconnectTimer: NodeJS.Timeout | null = null
  private messageCb: ((m: MeshMessage) => void) | null = null
  private devicesCb: ((devices: DeviceInventory[]) => void) | null = null
  private spawnCb: ((requestId: string, replyRelayId: string, spawn: SpawnRequest) => Promise<MeshResponse>) | null = null
  private ledgerAckCb: ((upToSeq: number) => void) | null = null
  private devices: DeviceInventory[] = []
  private readonly reconnectMs: number
  private readonly ackTimeoutMs: number
  private pendingAcks = new Map<string, { resolve: (ok: boolean) => void; timer: NodeJS.Timeout }>()
  private pendingSpawn = new Map<string, { resolve: (result: MeshResponse) => void; timer: NodeJS.Timeout }>()
  // D29 心跳:lastPongAt 0 = 未启动；> 0 = 最后一次收 pong 的时间戳
  private lastPongAt = 0
  private pingTimer: NodeJS.Timeout | null = null

  constructor(private opts: WebSocketUplinkOptions) {
    this.reconnectMs = opts.reconnectMs ?? 5000
    this.ackTimeoutMs = opts.ackTimeoutMs ?? 5000
  }

  async connect(): Promise<void> {
    this.shouldReconnect = true
    await this.openOnce()
  }

  private openOnce(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = this.opts.agent
        ? new WebSocket(this.opts.hubUrl, { agent: this.opts.agent })
        : new WebSocket(this.opts.hubUrl)
      this.ws = ws
      let settled = false

      ws.once("open", () => {
        settled = true
        this.sendRegister()
        this.startHeartbeat(ws)
        resolve()
      })
      ws.once("error", (err) => {
        if (!settled) {
          settled = true
          reject(err)
        }
      })
      ws.on("message", (data) => this.handleDownlink(data.toString()))
      ws.on("pong", () => { this.lastPongAt = Date.now() })
      ws.on("close", () => {
        this.stopHeartbeat()
        if (this.ws === ws) this.ws = null
        if (this.shouldReconnect) this.scheduleReconnect()
      })
    })
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.shouldReconnect) return
      this.openOnce().catch(() => {
        if (this.shouldReconnect) this.scheduleReconnect()
      })
    }, this.reconnectMs)
  }

  /**
   * 启动心跳：周期发 ws frame ping；若超过 pongTimeoutMs 没收到 pong,主动 terminate
   * (close event 会触发 reconnect)。和 reconnect 一起构成对"ws 假连接"的防御。
   */
  private startHeartbeat(ws: WebSocket): void {
    this.stopHeartbeat()  // 防 leak,先清旧 timer
    this.lastPongAt = Date.now()  // open 起手就视为"刚收过 pong",防止首个 interval 误判
    const interval = pingIntervalMs()
    const timeout = pongTimeoutMs()
    this.pingTimer = setInterval(() => {
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return
      if (Date.now() - this.lastPongAt > timeout) {
        // ws 假连接,主动 terminate;close handler 会清 ping + 触发 reconnect
        try { ws.terminate() } catch { /* noop */ }
        return
      }
      try { ws.ping() } catch { /* ws 死,close 会处理 */ }
    }, interval)
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    this.lastPongAt = 0
  }

  private sendRegister(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const relay = this.opts.getRegistration()
    // token 存在 opts 上，重连走 openOnce→sendRegister 会重新读取，故重连也带 token
    const reg: UplinkMessage = this.opts.token
      ? { type: "register", relay, token: this.opts.token }
      : { type: "register", relay }
    this.ws.send(JSON.stringify(reg))
  }

  async sendRegistration(nodes: NodeIdentity[]): Promise<void> {
    if (!this.isConnected() || !this.ws) return
    const base = this.opts.getRegistration()
    const relay = { relayId: base.relayId, deviceId: base.deviceId, nodes, connectedAt: base.connectedAt }
    const reg: UplinkMessage = this.opts.token
      ? { type: "register", relay, token: this.opts.token }
      : { type: "register", relay }
    this.ws.send(JSON.stringify(reg))
  }

  sendListenerStatus(listeners: import('@cc-mesh/protocol').ListenerStatus[]): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'listener_status', listeners }))
  }

  private handleDownlink(raw: string): void {
    let msg: DownlinkMessage
    try { msg = JSON.parse(raw) as DownlinkMessage } catch { return }
    if (msg.type === "message" && this.messageCb) {
      this.messageCb(msg.msg)
      return
    }
    if (msg.type === "devices") {
      this.devices = msg.devices
      this.devicesCb?.(msg.devices)
      return
    }
    if (msg.type === "spawn") {
      if (!this.spawnCb) return
      this.spawnCb(msg.requestId, msg.replyRelayId, msg.spawn)
        .then((result) => this.sendSpawnResult(msg.requestId, msg.replyRelayId, result))
        .catch((err) => this.sendSpawnResult(msg.requestId, msg.replyRelayId, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }))
      return
    }
    if (msg.type === "spawn_result") {
      const pending = this.pendingSpawn.get(msg.requestId)
      if (pending) {
        clearTimeout(pending.timer)
        this.pendingSpawn.delete(msg.requestId)
        pending.resolve(msg.result)
      }
      return
    }
    if (msg.type === "ledger_ack") {
      // Hub 确认已入账 srcSeq ≤ upToSeq 的事件 → LedgerSync 据此推游标（没 ack 就重发同批）。
      this.ledgerAckCb?.(msg.upToSeq)
      return
    }
    if (msg.type === "delivered" || msg.type === "queued") {
      const pending = this.pendingAcks.get(msg.msgId)
      if (pending) {
        clearTimeout(pending.timer)
        this.pendingAcks.delete(msg.msgId)
        pending.resolve(msg.type === "delivered")
      }
    }
  }

  async disconnect(): Promise<void> {
    this.shouldReconnect = false
    this.stopHeartbeat()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      const ws = this.ws
      this.ws = null
      try { ws.close() } catch { /* noop */ }
    }
    for (const { resolve, timer } of this.pendingAcks.values()) {
      clearTimeout(timer)
      resolve(false)
    }
    this.pendingAcks.clear()
    for (const { resolve, timer } of this.pendingSpawn.values()) {
      clearTimeout(timer)
      resolve({ ok: false, error: "uplink disconnected" })
    }
    this.pendingSpawn.clear()
  }

  isConnected(): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    // D29:lastPongAt=0 说明心跳还没启;>0 时检查是否超 pong-timeout(防 NAT 假连接)
    if (this.lastPongAt === 0) return false
    return Date.now() - this.lastPongAt < pongTimeoutMs()
  }

  async send(msg: MeshMessage): Promise<boolean> {
    if (!this.isConnected() || !this.ws) return false
    const payload: UplinkMessage = { type: "message", msg }
    this.ws.send(JSON.stringify(payload))
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(msg.id)
        resolve(false)
      }, this.ackTimeoutMs)
      this.pendingAcks.set(msg.id, { resolve, timer })
    })
  }

  onMessage(cb: (m: MeshMessage) => void): void {
    this.messageCb = cb
  }

  onDevices(cb: (devices: DeviceInventory[]) => void): void {
    this.devicesCb = cb
  }

  getDevices(): DeviceInventory[] {
    return this.devices
  }

  onSpawnRequest(cb: (requestId: string, replyRelayId: string, spawn: SpawnRequest) => Promise<MeshResponse>): void {
    this.spawnCb = cb
  }

  /**
   * 发一批账本事件（B2 游标上行）。fire-and-forget：不等 ws ack，
   * 对账靠 Hub 回的 downlink `ledger_ack`（没 ack → LedgerSync 下轮重发同批）。
   * 未连接返回 false，让调用方知道这轮没发出去（本地库继续当队列）。
   * ⚠️ 部署顺序：老 Hub 的 switch 无 default，未知 uplink 类型静默丢弃 —— 必须先部署 Hub 再放 relay（设计 §4.4）。
   */
  sendLedger(relayId: string, events: LedgerUplinkEvent[]): boolean {
    if (!this.isConnected() || !this.ws) return false
    const payload: UplinkMessage = { type: "ledger", relayId, events }
    this.ws.send(JSON.stringify(payload))
    return true
  }

  onLedgerAck(cb: (upToSeq: number) => void): void {
    this.ledgerAckCb = cb
  }

  async requestSpawn(targetDevice: string, spawn: SpawnRequest): Promise<MeshResponse> {
    if (!this.isConnected() || !this.ws) return { ok: false, error: "uplink not connected" }
    const requestId = `spawn-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
    const payload: UplinkMessage = { type: "spawn", requestId, targetDevice, spawn }
    this.ws.send(JSON.stringify(payload))
    return new Promise<MeshResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingSpawn.delete(requestId)
        resolve({ ok: false, error: "spawn request timed out" })
      }, 120_000)
      this.pendingSpawn.set(requestId, { resolve, timer })
    })
  }

  private sendSpawnResult(requestId: string, targetRelayId: string, result: MeshResponse): void {
    if (!this.isConnected() || !this.ws) return
    const payload: UplinkMessage = { type: "spawn_result", requestId, targetRelayId, result }
    this.ws.send(JSON.stringify(payload))
  }
}
