import { WebSocketServer, WebSocket } from "ws"
import type { AddressInfo } from "node:net"
import { HUB_WS_PORT, validateImageAttachmentManifests } from "@cc-mesh/protocol"
import type {
  UplinkMessage, DownlinkMessage, RelayRegistration, NodeIdentity, DeviceInventory,
} from "@cc-mesh/protocol"
import type { IAuth } from "./auth.js"
import { NoAuth } from "./auth.js"
import { mountLedger } from "./ledger-mount.js"
import type { HubLedgerOptions, LedgerMount } from "./ledger-mount.js"
import { BlobStore } from "./attachments.js"
import type { HubAttachmentOptions, HubAttachmentMount } from "./attachments.js"

// D29: 心跳配置(独立读 env,不依赖 relay 的 paths.ts)
function pingIntervalMs(): number {
  const n = parseInt(process.env.MESH_PING_INTERVAL_MS ?? "30000", 10)
  return Number.isFinite(n) && n >= 100 ? n : 100
}
function pongTimeoutMs(): number {
  const n = parseInt(process.env.MESH_PONG_TIMEOUT_MS ?? "60000", 10)
  return Number.isFinite(n) && n >= 200 ? n : 200
}

export interface HubOptions {
  port?: number
  auth?: IAuth
  /**
   * 云端账本（设计 §3）。**不传 = 完全的现行为**——Hub 保持纯内存路由，
   * 一行账不记、一个端口不开。传了才建库、起 :19901 读 API、开孤儿扫描。
   */
  ledger?: HubLedgerOptions
  attachments?: HubAttachmentOptions
}

export interface HubInstance {
  port: number
  close(): Promise<void>
  getNodeLocation(nodeId: string): string | undefined
  /** 账本挂载句柄；没开账本（或账本加载失败）时为 null。 */
  ledger: LedgerMount | null
  /** Blob HTTP extension; null unless Ledger HTTP and token are both active. */
  attachments: HubAttachmentMount | null
}

interface RelayEntry {
  relayId: string
  deviceId: string
  ws: WebSocket
  nodes: NodeIdentity[]
}

export async function createHub(opts: HubOptions = {}): Promise<HubInstance> {
  const port = opts.port ?? HUB_WS_PORT
  const auth = opts.auth ?? new NoAuth()
  const wss = new WebSocketServer({ port })
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", () => resolve())
    wss.once("error", reject)
  })
  const actualPort = (wss.address() as AddressInfo).port

  // relayId → entry
  const relays = new Map<string, RelayEntry>()
  // nodeId → relayId
  const nodeIndex = new Map<string, string>()
  // ws → relayId（用于 close 清理）
  const wsToRelay = new WeakMap<WebSocket, string>()

  function isDeviceOnline(deviceId: string): boolean {
    for (const entry of relays.values()) if (entry.deviceId === deviceId) return true
    return false
  }

  // 账本挂载（不传 opts.ledger = 一点不碰，现行为原样）
  const blobStore = opts.attachments && opts.ledger?.token?.trim()
    ? new BlobStore(opts.attachments)
    : null
  const ledger: LedgerMount | null = opts.ledger
    ? await mountLedger(
      { ...opts.ledger, ...(blobStore ? { httpExtension: blobStore.handleHttp } : {}) },
      { presence: currentDevices, isDeviceOnline },
    )
    : null
  if (!ledger?.httpPort && blobStore) blobStore.close()
  const attachments: HubAttachmentMount | null = ledger?.httpPort && blobStore
    ? { httpPort: ledger.httpPort, sweepExpired: (nowMs?: number) => blobStore.sweepExpired(nowMs) }
    : null

  function send(ws: WebSocket, msg: DownlinkMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  function currentDevices(): DeviceInventory[] {
    const updatedAt = new Date().toISOString()
    return Array.from(relays.values()).map((entry) => ({
      deviceId: entry.deviceId,
      relayId: entry.relayId,
      nodes: entry.nodes,
      updatedAt,
    }))
  }

  function broadcastDevices(): void {
    const devices = currentDevices()
    for (const entry of relays.values()) {
      send(entry.ws, { type: "devices", devices })
    }
  }

  async function handleRegister(ws: WebSocket, reg: RelayRegistration, token?: string): Promise<void> {
    let ok = false
    try {
      ok = await auth.verify(token, reg.relayId)
    } catch {
      ws.close(4001, "auth error")
      return
    }
    if (!ok) {
      ws.close(4001, "auth failed")
      return
    }
    // 同 relayId 重连：覆盖旧记录
    const prev = relays.get(reg.relayId)
    if (prev) for (const n of prev.nodes) nodeIndex.delete(n.nodeId)

    relays.set(reg.relayId, { relayId: reg.relayId, deviceId: reg.deviceId, ws, nodes: reg.nodes })
    wsToRelay.set(ws, reg.relayId)
    for (const n of reg.nodes) nodeIndex.set(n.nodeId, reg.relayId)
    // B8 presence 事件：上下线是"当时为什么"的上下文（孤儿判定、排障时间线都靠它）
    ledger?.recordEvent({
      kind: "relay_online",
      device: reg.deviceId,
      nodeId: null,
      detail: { relayId: reg.relayId, nodes: reg.nodes.length, reconnect: Boolean(prev) },
    })
    broadcastDevices()
  }

  /**
   * B2 上行账本批。**要求该连接已 register 成功**（= 过了 auth）才准写账；
   * 没注册就不 ack —— relay 的游标只在收到 ack 时前进，所以这批会重传，一条不丢。
   */
  function handleLedger(ws: WebSocket, up: Extract<UplinkMessage, { type: "ledger" }>): void {
    if (!ledger) return
    const registeredRelayId = wsToRelay.get(ws)
    if (!registeredRelayId) return
    const upToSeq = ledger.ingest(up.events ?? [], up.relayId || registeredRelayId)
    if (upToSeq === null) return          // 整批回滚了，不能假 ack
    send(ws, { type: "ledger_ack", upToSeq })
  }

  function handleMessage(senderWs: WebSocket, up: Extract<UplinkMessage, { type: "message" }>): void {
    const { msg } = up
    const senderRelayId = wsToRelay.get(senderWs)
    const sender = senderRelayId ? relays.get(senderRelayId) : undefined
    if (!sender || sender.ws !== senderWs) return
    const ownsSender = sender.nodes.some((node) => node.nodeId === msg.from)
      || msg.from === `${sender.deviceId}:relay`
    if (!ownsSender) return
    const attachments = (msg.meta as any)?.attachments
    if (attachments !== undefined) {
      try { validateImageAttachmentManifests(attachments) } catch { return }
    }
    if (msg.to === "*") {
      for (const entry of relays.values()) {
        if (entry.relayId === senderRelayId) continue
        send(entry.ws, { type: "message", msg })
      }
      send(senderWs, { type: "delivered", msgId: msg.id })
      return
    }
    const targetRelayId = nodeIndex.get(msg.to)
    if (!targetRelayId) {
      send(senderWs, { type: "queued", msgId: msg.id })
      return
    }
    const target = relays.get(targetRelayId)
    if (!target) {
      send(senderWs, { type: "queued", msgId: msg.id })
      return
    }
    send(target.ws, { type: "message", msg })
    send(senderWs, { type: "delivered", msgId: msg.id })
  }

  function handleSpawn(senderWs: WebSocket, up: Extract<UplinkMessage, { type: "spawn" }>): void {
    const senderRelayId = wsToRelay.get(senderWs)
    if (!senderRelayId) return
    const target = Array.from(relays.values()).find((entry) => entry.deviceId === up.targetDevice)
    if (!target) {
      send(senderWs, {
        type: "spawn_result",
        requestId: up.requestId,
        result: { ok: false, error: `target device not connected: ${up.targetDevice}` },
      })
      return
    }
    send(target.ws, {
      type: "spawn",
      requestId: up.requestId,
      replyRelayId: senderRelayId,
      spawn: up.spawn,
    })
  }

  function handleSpawnResult(up: Extract<UplinkMessage, { type: "spawn_result" }>): void {
    const target = relays.get(up.targetRelayId)
    if (!target) return
    send(target.ws, {
      type: "spawn_result",
      requestId: up.requestId,
      result: up.result,
    })
  }

  function handleClose(ws: WebSocket): void {
    const relayId = wsToRelay.get(ws)
    if (!relayId) return
    const entry = relays.get(relayId)
    if (entry && entry.ws === ws) {
      for (const n of entry.nodes) nodeIndex.delete(n.nodeId)
      relays.delete(relayId)
      ledger?.recordEvent({
        kind: "relay_offline",
        device: entry.deviceId,
        nodeId: null,
        detail: { relayId, nodes: entry.nodes.length },
      })
      broadcastDevices()
    }
  }

  // D29: 每个连接的 ws frame ping/pong 状态（WeakMap 防内存泄漏）
  const lastPongAt = new WeakMap<WebSocket, number>()
  const pingTimers = new WeakMap<WebSocket, NodeJS.Timeout>()

  wss.on("connection", (ws) => {
    // 启动心跳:周期发 ws frame ping,超时 terminate
    lastPongAt.set(ws, Date.now())
    ws.on("pong", () => { lastPongAt.set(ws, Date.now()) })
    const interval = pingIntervalMs()
    const timeout = pongTimeoutMs()
    const timer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return
      const last = lastPongAt.get(ws) ?? 0
      if (Date.now() - last > timeout) {
        try { ws.terminate() } catch { /* noop */ }
        return
      }
      try { ws.ping() } catch { /* ws 死,close 会处理 */ }
    }, interval)
    pingTimers.set(ws, timer)

    ws.on("message", (data) => {
      let parsed: UplinkMessage
      try { parsed = JSON.parse(String(data)) as UplinkMessage } catch { return }
      switch (parsed.type) {
        case "register": handleRegister(ws, parsed.relay, parsed.token); break
        case "message": handleMessage(ws, parsed); break
        case "spawn": handleSpawn(ws, parsed); break
        case "spawn_result": handleSpawnResult(parsed); break
        case "ledger": handleLedger(ws, parsed); break
        case "ping": send(ws, { type: "pong" }); break
      }
    })
    ws.on("close", () => {
      const t = pingTimers.get(ws)
      if (t) { clearInterval(t); pingTimers.delete(ws) }
      lastPongAt.delete(ws)
      handleClose(ws)
    })
    ws.on("error", () => { /* swallow; close will fire */ })
  })

  return {
    port: actualPort,
    ledger,
    attachments,
    async close() {
      for (const { ws } of relays.values()) {
        try { ws.close() } catch { /* noop */ }
      }
      relays.clear()
      nodeIndex.clear()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      // 账本最后关：timer / :19901 / SQLite 句柄一并收干净，否则测试进程挂着不退
      if (ledger) await ledger.close()
      blobStore?.close()
    },
    getNodeLocation(nodeId: string) {
      return nodeIndex.get(nodeId)
    },
  }
}
