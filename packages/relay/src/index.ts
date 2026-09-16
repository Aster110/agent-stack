import os from "node:os"
import fs from "node:fs"
import path from "node:path"
import type { Server } from "node:http"
import { createServer } from "./server.js"
import { createTerminal } from "./terminal/detect.js"
import { LocalTransport } from "./transport/local.js"
import { CompositeTransport } from "./transport/composite.js"
import { WebSocketUplink, resolveHubToken } from "./uplink/websocket.js"
import { buildProxyAgent, readProxyEnv } from "./uplink/proxy.js"
import { MeshEventBus } from "./events.js"
import { TtydManager } from "./ttyd.js"
import { WakeSweeper } from "./wake_sweeper.js"
import { LedgerSync } from "./ledger_sync.js"
import { DeviceRegistryCache } from "./device-registry.js"
import { dbPath, pidPath } from "./paths.js"
import { RELAY_HTTP_PORT, NODE_TIMEOUT_MS } from "@cc-mesh/protocol"
import type { ITransport } from "./transport/interface.js"
import type { RelayRegistration } from "@cc-mesh/protocol"
import { attachmentManagerFromEnv, wireRelayUplink } from "./runtime.js"

const deviceId = process.env.MESH_DEVICE_ID ?? os.hostname().replace(/\.local$/, "").toLowerCase()
const resolvedDbPath = dbPath()

const terminal = createTerminal()
console.log(`[mesh-relay] terminal backend: ${terminal.constructor.name}`)

const hubUrl = process.env.MESH_HUB_URL
const relayId = `${deviceId}-${process.pid}`
const hubToken = hubUrl ? resolveHubToken() : undefined

let transport: ITransport
let uplink: WebSocketUplink | null = null
let ledgerSync: LedgerSync | null = null
const deviceRegistry = new DeviceRegistryCache()

if (hubUrl) {
  const proxyUrl = readProxyEnv()
  let proxyAgent: ReturnType<typeof buildProxyAgent> | undefined
  if (proxyUrl) {
    try {
      proxyAgent = buildProxyAgent(hubUrl, proxyUrl)
    } catch (err) {
      console.error(`[mesh-relay] invalid proxy URL "${proxyUrl}", falling back to direct connect:`, (err as Error).message)
    }
  }

  // token 来源优先级：env MESH_HUB_TOKEN > 文件 ~/.ccmesh/hub-token > 无（见 resolveHubToken）
  uplink = new WebSocketUplink({
    hubUrl,
    getRegistration: (): RelayRegistration => ({
      relayId,
      deviceId,
      nodes: app.registry.getAll().map((n) => n.identity),
      connectedAt: new Date().toISOString(),
    }),
    agent: proxyAgent,
    token: hubToken,
  })
  transport = new CompositeTransport(terminal, uplink, { deviceId })
  console.log(
    `[mesh-relay] uplink → ${hubUrl} (relayId: ${relayId})${proxyAgent ? ` via proxy ${proxyUrl}` : ""}${hubToken ? " [token: set]" : ""}`,
  )
} else {
  transport = new LocalTransport(terminal)
  console.log(`[mesh-relay] transport: LocalTransport (no MESH_HUB_URL)`)
}

const events = new MeshEventBus()
const ttyd = new TtydManager()
const attachmentManager = attachmentManagerFromEnv(process.env, fetch, hubToken)
attachmentManager?.sweepExpired()
const attachmentSweepTimer = attachmentManager
  ? setInterval(() => attachmentManager.sweepExpired(), 60_000)
  : null
attachmentSweepTimer?.unref()

const app = createServer({
  dbPath: resolvedDbPath,
  deviceId,
  terminal,
  transport,
  events,
  ttyd,
  uplink: uplink ?? undefined,
  getDevices: () => deviceRegistry.list(),
  getDevicesSource: () => deviceRegistry.source(),
  requestRemoteSpawn: uplink
    ? async (targetDevice, spawn) => uplink!.requestSpawn(targetDevice, spawn as any)
    : undefined,
  attachmentManager,
})

// 重启恢复（任务1）：注册表从 mesh.db 的 nodes 表读回来。
// 恢复的是身份不是在线状态——pull 节点在 /api/status 里仍是 offline，
// 直到它自己下一次 sync。逃生阀 MESH_REGISTRY_RESTORE=0。
if (app.restoredNodeCount > 0) {
  console.log(`[mesh-relay] 注册表恢复: ${app.restoredNodeCount} 个节点（presence 未恢复，等各自 sync）`)
} else if (process.env.MESH_REGISTRY_RESTORE === "0") {
  console.log(`[mesh-relay] 注册表恢复: 已关闭 (MESH_REGISTRY_RESTORE=0)`)
}

// 温唤醒接缝（任务2）：投给没人接货的 pull 节点时广播 wake:needed。
// 总开关是 MESH_WAKE=1；开了之后没设 MESH_WAKE_HOOK = 只发事件不起进程。
// 日志必须反映真实状态——关着的时候说"只广播事件"会让运维以为事件在发。
console.log(
  process.env.MESH_WAKE !== "1"
    ? `[mesh-relay] wake: 关闭（设 MESH_WAKE=1 启用）`
    : process.env.MESH_WAKE_HOOK
      ? `[mesh-relay] wake: 开启，hook ${process.env.MESH_WAKE_HOOK} <nodeId>`
      : `[mesh-relay] wake: 开启，只广播 wake:needed 事件（未设 MESH_WAKE_HOOK）`,
)

// 补铃对账（缺口 G2）：把 SSE 的 at-most-once 提到系统级 at-least-once。
// 它自己守 MESH_WAKE / MESH_WAKE_SWEEP 两道闸——wake 关着就不起定时器，
// 所以这里无脑 start() 即可，「默认关」的判断只在 WakeSweeper.start() 一处。
// 零模型 turn：纯 SQLite COUNT + 内存判定。
const wakeSweeper = new WakeSweeper({ registry: app.registry, store: app.store, wake: app.wake })
console.log(
  wakeSweeper.start()
    ? `[mesh-relay] wake sweeper: 开启（每 2min 对账停驻积压，指数退避补铃）`
    : `[mesh-relay] wake sweeper: 关闭`,
)

// inbound downlink message → 本地投递
if (uplink) {
  wireRelayUplink({
    app,
    uplink,
    onDevices: (devices) => deviceRegistry.update(devices, "hub"),
    onSpawn: async (_requestId, _replyRelayId, spawn) =>
      app.spawnLocal(spawn as unknown as Record<string, unknown>),
  })
  // 云端账本上行（B2）：本地 mesh.db 既是一级真相也是发送队列，
  // 每条消息落库后 debounce 一次批量上行，收到 Hub 的 ledger_ack 才推游标。
  // 断网期间只是发不出去，重连后从游标续传，一条不丢。逃生阀：MESH_LEDGER_SYNC=0。
  ledgerSync = new LedgerSync({ store: app.store, uplink, relayId })
  ledgerSync.start()
  // msg:send 是"消息已落库"的唯一全路径信号（本机 send / 跨机 downlink 着陆 / 广播 / 派单都发它）。
  events.on("msg:send", () => ledgerSync?.notifyWrite())
  console.log(`[mesh-relay] ledger sync: ${ledgerSync.enabled ? "on" : "off (MESH_LEDGER_SYNC=0)"}`)

  const u = uplink
  u.connect()
    .then(() => events.emit("uplink:status", { connected: true, hubUrl }))
    .catch((err) => {
      events.emit("uplink:status", { connected: false, hubUrl })
      console.error(`[mesh-relay] uplink connect failed:`, err?.message ?? err)
    })
}

let server: Server

const port = Number(process.env.RELAY_HTTP_PORT ?? RELAY_HTTP_PORT)
// 默认只绑回环：relay 的 HTTP API 能往 tmux 注入任意文本（等价于任意命令执行），
// 绑 0.0.0.0 意味着同网段任何人都能往你的终端里打字。跨机通信走 Hub uplink，
// 不需要 relay 的 HTTP 口对外可达。确需局域网访问（如别的机器看 dashboard）
// 才显式设 RELAY_HTTP_HOST=0.0.0.0。
const host = process.env.RELAY_HTTP_HOST ?? "127.0.0.1"
server = app.listen(port, host, () => {
  console.log(`[mesh-relay] 已启动 http://${host}:${port} (device: ${deviceId})`)
})

// 定时清理已关闭（cc 不会自己退出，不需要主动清理）
// 以后如需清理，用 isAlive 检活而不是靠 lastSeen 超时
const cleanupTimer = setInterval(() => {
  // noop — 保留 timer 引用供 shutdown 清理
  void 0
}, NODE_TIMEOUT_MS)

const relayPidFile = pidPath()
fs.mkdirSync(path.dirname(relayPidFile), { recursive: true })
fs.writeFileSync(relayPidFile, String(process.pid))

async function shutdown() {
  console.log("[mesh-relay] 正在关闭...")
  clearInterval(cleanupTimer)
  if (attachmentSweepTimer) clearInterval(attachmentSweepTimer)
  wakeSweeper.stop()
  ledgerSync?.stop()
  await ttyd.shutdown()
  if (uplink) await uplink.disconnect()
  app.closeDoorbell()
  app.store.close()
  server.close(() => {
    try { fs.unlinkSync(relayPidFile) } catch {}
    console.log("[mesh-relay] 已关闭")
    process.exit(0)
  })
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
process.on("uncaughtException", (err) => {
  console.error("[mesh-relay] uncaughtException:", err?.stack ?? err)
  process.exit(1)
})
process.on("unhandledRejection", (reason) => {
  console.error("[mesh-relay] unhandledRejection:", reason)
  process.exit(1)
})
process.on("exit", (code) => {
  console.log(`[mesh-relay] process exit code=${code}`)
})
