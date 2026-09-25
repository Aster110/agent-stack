import { DoorbellMonitor } from "./doorbell.js"
import express, { type Express } from "express"
import type { NextFunction, Request, Response } from "express"
import { Store } from "./store.js"
import type { MessagePriority } from "./store.js"
import { Registry, PRESENCE_FRESH_MS } from "./registry.js"
import { Router } from "./router.js"
import { WakeHook, WAKE_GLOBAL_HOURLY_MAX, type WakeAuditEntry } from "./wake.js"
import { deliverDownlinkMessage, type DownlinkDeliveryResult } from "./downlink.js"
import { compareIdentity } from "./identity.js"
import type { ITerminal } from "./terminal/interface.js"
import type { ITransport, DeliveryTarget, DeliveryResult } from "./transport/interface.js"
import {
  parseNodeId, genNodeId, genShortId, genMessageId, now, normalizeDeliveryMode, LEDGER_SINK,
  MAX_IMAGE_BYTES, MAX_IMAGE_TTL_SECONDS, DEFAULT_IMAGE_TTL_SECONDS, MAX_IMAGE_PIXELS,
  IMAGE_ATTACHMENT_MIMES, isImageAttachmentMime, sniffImageAttachment,
  validateImageAttachmentManifests,
} from "@cc-mesh/protocol"
import { deliverToLocalNode, formatDelivery } from "./delivery/inject-pump.js"
import { DirectDispatcher, DispatchError } from "./dispatch.js"
import path from "node:path"
import fs from "node:fs"
import type { MeshMessage, MessageType, LocalNode, NodeIdentity, DeviceInventory } from "@cc-mesh/protocol"
import type { DispatchTask, DispatchResult, SeatPick } from "@cc-mesh/protocol"
import type { MeshEventBus, MeshEventName } from "./events.js"
import type { TtydManager } from "./ttyd.js"
import { loadAgentProfile } from "./profile.js"
import { sendRetryCount } from "./paths.js"
import { AGENT_PROMPT_CHARS } from "./terminal/tmux.js"
import type { AttachmentClient } from "./attachments.js"
import { formatAttachmentsForDelivery } from "./attachments.js"

export interface ServerOptions {
  dbPath?: string
  doorbellTtlMs?: number
  doorbellProbeMs?: number
  doorbellWakeMs?: number
  deviceId: string
  terminal: ITerminal
  spawnReadyTimeoutMs?: number
  profileHome?: string
  getDevices?: () => DeviceInventory[]
  getDevicesSource?: () => "hub" | "cache"
  requestRemoteSpawn?: (targetDevice: string, spawn: Record<string, unknown>) => Promise<{ ok: boolean; data?: unknown; error?: string }>
  transport?: ITransport
  events?: MeshEventBus
  ttyd?: TtydManager
  /** 温唤醒接缝；不给就按 env MESH_WAKE / MESH_WAKE_HOOK 现造一个（测试可注入假的） */
  wake?: WakeHook
  /** 身份软不匹配时的重试间隔 ms（缺省 env MESH_IDENTITY_RETRY_MS 或 3000；测试传 0） */
  identityRetryMs?: number
  uplink?: {
    sendListenerStatus?(listeners: import("@cc-mesh/protocol").ListenerStatus[]): void
    isConnected(): boolean
    sendRegistration(nodes: NodeIdentity[]): Promise<void>
  }
  attachmentManager?: AttachmentClient
  attachmentLimits?: { maxBytes?: number; maxTtlSeconds?: number; defaultTtlSeconds?: number; maxPixels?: number }
  attachmentNow?: () => number
  /** All runtime subprocess execution goes through this seam; attachments never invoke it. */
  commandRunner?: (file: string, args?: readonly string[]) => Promise<{ code: number; stdout?: string; stderr?: string }>
}

export type MeshServer = Express & {
  registry: Registry
  doorbell: DoorbellMonitor
  publishListeners: () => void
  closeDoorbell: () => void
  store: Store
  spawnLocal: (body: Record<string, unknown>) => Promise<{ ok: boolean; data?: unknown; error?: string }>
  /** 启动时从 SQLite 恢复进内存的节点数（给 index.ts 打启动日志用） */
  restoredNodeCount: number
  /**
   * 温唤醒器（本机 send 与跨机 downlink 共用的**同一个**实例）。
   * 暴露出来是给 wake sweeper 共用——sweeper 补铃必须走它，才受同一份
   * 去抖表 / 全局限速窗约束。
   */
  wake: WakeHook
  /**
   * 跨机消息着陆入口（index.ts 的 uplink.onMessage 调它）。
   *
   * 为什么是服务器方法而不是让 index.ts 自己拼参数：缺口 G1 的全部内容就是
   * 「wake 接缝在，但跨机这条线上没人把它接进去」。把组装收到闭包里，
   * 调用方**结构上没机会漏传** wake / store / registry 中的任何一个。
   */
  deliverDownlink: (msg: MeshMessage) => Promise<DownlinkDeliveryResult>
}

export const SYNC_MAX_LIMIT = 100
export const MAX_ATTACHMENT_MATERIALIZE_CONCURRENCY = 4

// priority 归一：仅接受 urgent|normal|bulk，缺省/非法一律 normal（只存储透传，无调度）。
function normalizePriority(raw: unknown): MessagePriority {
  return raw === "urgent" || raw === "bulk" || raw === "normal" ? raw : "normal"
}

export function createServer(opts: ServerOptions): MeshServer {
  const { deviceId, terminal, transport, events, ttyd, uplink, attachmentManager } = opts
  const spawnReadyTimeoutMs = opts.spawnReadyTimeoutMs ?? 60_000
  const commandRunner = opts.commandRunner ?? (async (file: string, args: readonly string[] = []) => {
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    const result = await promisify(execFile)(file, [...args])
    return { code: 0, stdout: result.stdout, stderr: result.stderr }
  })
  const store = new Store(opts.dbPath)
  const registry = new Registry()
  const doorbell = new DoorbellMonitor(opts.doorbellTtlMs, opts.doorbellWakeMs, Date.now, opts.dbPath && opts.dbPath !== ':memory:' ? opts.dbPath + '.doorbell-fences.json' : undefined)
  const listenerSnapshot = () => registry.getAll()
    .filter(n => normalizeDeliveryMode(n.identity.deliveryMode) === 'pull')
    .map(n => doorbell.status(n.identity.nodeId, registry.getLastSyncAt(n.identity.nodeId) ?? null))
  const publishListeners = () => uplink?.sendListenerStatus?.(listenerSnapshot())
  const listenerTimer = setInterval(publishListeners, opts.doorbellProbeMs ?? 15_000)
  listenerTimer.unref()
  events?.on('msg:send', data => { doorbell.message(data.to, data.msgId) })
  events?.on('node:unregister', data => { doorbell.forget(data.nodeId); publishListeners() })
  const router = new Router(registry, deviceId)
  let activeMaterializations = 0
  const materializeQueue: Array<() => void> = []
  const drainMaterializeQueue = (): void => {
    while (activeMaterializations < MAX_ATTACHMENT_MATERIALIZE_CONCURRENCY && materializeQueue.length > 0) {
      activeMaterializations++
      materializeQueue.shift()?.()
    }
  }
  const materializeBounded = (manifest: any): Promise<{ localPath?: string; error?: string }> =>
    new Promise((resolve) => {
      materializeQueue.push(() => {
        Promise.resolve(attachmentManager?.materialize(manifest) ?? { error: "unavailable" })
          .then(resolve, () => resolve({ error: "unavailable" }))
          .finally(() => {
            activeMaterializations--
            drainMaterializeQueue()
          })
      })
      drainMaterializeQueue()
    })

  // ===== 重启恢复注册表 =====
  // 注册信息一直都落 store 的 nodes 表，但重启后内存注册表是空的——
  // pull 节点（GUI Claude app）于是全体失联且不自知：消息落库没人醒，
  // 它自己 /api/sync 还被回 404 node not registered。这里把身份读回来。
  // 只恢复身份不恢复 presence（语义红线见 Registry.restoreAll）。
  // 逃生阀：MESH_REGISTRY_RESTORE=0 → 回到旧行为（空表启动）。
  const restoredNodeCount = process.env.MESH_REGISTRY_RESTORE === "0"
    ? 0
    : registry.restoreAll(store.getAllNodes())

  // 温唤醒接缝：**默认整个关闭**（aster 要求先过目再启用）。
  // MESH_WAKE=1 才开；不设 = 既不广播 wake:needed、也不 exec，零行为零回归。
  // 开了之后再看 MESH_WAKE_HOOK：不设就只广播事件不起进程。
  const wakeEnabled = process.env.MESH_WAKE === "1"
  const wake = opts.wake ?? new WakeHook({
    enabled: wakeEnabled,
    events,
    hookCommand: process.env.MESH_WAKE_HOOK,
    globalHourlyMax: Number(process.env.MESH_WAKE_GLOBAL_HOURLY_MAX) || WAKE_GLOBAL_HOURLY_MAX,
    audit: (entry) => writeWakeAudit(entry),
  })

  /**
   * wake 审计流水（缺口 G4：wake 的结果原本只有一行 console.warn，出事查无对证）。
   *
   * 复用 @ledger 哨兵管道：落库即 delivered、不投递、不走 uplink，
   * 收件人 "@ledger" 不匹配任何门铃过滤（/api/sync 的停车监听只认
   * `to === 自己` 或 `to === '*'`），所以写审计**不会 settle 任何停车连接**，
   * 也不会出现在任何节点的 getInbox 里。既有 ledger_sync 会把它自动上云。
   *
   * 逃生阀 MESH_WAKE_AUDIT=0。写失败只记日志——记账是旁路，不是主路。
   */
  function writeWakeAudit(entry: WakeAuditEntry): void {
    if (process.env.MESH_WAKE_AUDIT === "0") return
    const from = `${deviceId}:relay`
    const row: MeshMessage = {
      id: genMessageId(from),
      from,
      to: LEDGER_SINK,
      type: "wake_audit",
      payload: JSON.stringify({
        wake_id: entry.wakeId,
        node_id: entry.nodeId,
        decision: entry.decision,
        source: entry.source,
        parked_count: entry.parkedCount,
        hook: entry.hook,
        ...(entry.backlog != null ? { backlog: entry.backlog } : {}),
        ...(entry.attempt != null ? { attempt: entry.attempt } : {}),
      }),
      createdAt: now(),
    }
    store.saveMessage(row, "delivered", "normal")
    events?.emit("msg:send", { msgId: row.id, from: row.from, to: row.to, status: "delivered" })
  }

  // ===== 恢复态 inject 节点的身份校验（投递前验活 + 验身份）=====
  // sessionId 存的是 tmux **会话名**，不是 pane id：session 被 kill 后别人建个同名的，
  // has-session 照样 true。只验活会把消息喂进陌生 pane —— 静默、不可见、无回执。
  // 主脑是唯一本体，喂错 pane = 指令进黑洞，比"显示成在线"严重一个量级。
  const identityRetryMs = opts.identityRetryMs
    ?? (Number(process.env.MESH_IDENTITY_RETRY_MS) || 3000)

  function supportsIdentity(sessionId: string): boolean {
    if (typeof terminal.identity !== "function") return false
    const capability = terminal.supportsIdentity
    if (typeof capability === "function") {
      return capability.call(terminal, sessionId)
    }
    return true
  }

  async function fingerprintOf(sessionId: string): Promise<string | null> {
    if (!supportsIdentity(sessionId)) return null
    const identity = terminal.identity
    if (typeof identity !== "function") return null
    try {
      return await identity.call(terminal, sessionId)
    } catch {
      return null
    }
  }

  /** 放行 = true；拦下（消息落库不投）= false。 */
  async function ensureInjectIdentity(target: LocalNode): Promise<boolean> {
    const nodeId = target.identity.nodeId
    if (normalizeDeliveryMode(target.identity.deliveryMode) !== "inject") return true
    if (registry.isInjectVerified(nodeId)) return true
    // 终端没有取指纹的能力（iTerm2 等）→ 验不了就别拦，维持旧行为
    if (!supportsIdentity(target.sessionId)) {
      registry.markInjectVerified(nodeId)
      return true
    }

    const deny = (reason: string): boolean => {
      registry.markInjectMismatch(nodeId, reason)
      console.warn(
        `[mesh] identity mismatch: node=${nodeId} session=${JSON.stringify(target.sessionId)} ` +
        `${reason} —— 消息落库不投`,
      )
      return false
    }

    const current = await fingerprintOf(target.sessionId)
    if (current == null) return deny("session 不存在（验活失败）")

    const stored = target.identityFp
    if (!stored) {
      // 老库/升级前注册的节点没有基线：没法比对身份，但 session 活着。
      // 拦下来会让所有老节点集体失联，所以只验活放行，并**补录**基线——
      // 下次重启就是完整校验了。
      registry.markInjectVerified(nodeId)
      target.identityFp = current
      store.saveNode(target)
      console.warn(`[mesh] identity 基线缺失，按验活放行并补录: node=${nodeId}`)
      return true
    }

    let verdict = compareIdentity(stored, current)
    if (verdict === "soft-mismatch") {
      // 只有前台进程名对不上 —— 很可能正踩在 codex 自愈重启的窗口上（短暂是 bash）。
      // 先 warn + 等一下重取，连续两次不匹配才降级。
      console.warn(
        `[mesh] identity warn: node=${nodeId} 前台进程名不匹配（可能正在自愈重启），` +
        `${identityRetryMs}ms 后重试一次`,
      )
      await new Promise((r) => setTimeout(r, identityRetryMs))
      const retry = await fingerprintOf(target.sessionId)
      if (retry == null) return deny("重试时 session 已不存在")
      verdict = compareIdentity(stored, retry)
      if (verdict === "soft-mismatch") return deny("连续两次前台进程名不匹配")
    }
    if (verdict === "hard-mismatch") return deny("会话名/工作目录不匹配（同名但已换人）")

    registry.markInjectVerified(nodeId)
    return true
  }

  const app = express()
  const attachmentMaxBytes = opts.attachmentLimits?.maxBytes ?? MAX_IMAGE_BYTES
  const attachmentMaxTtl = opts.attachmentLimits?.maxTtlSeconds ?? MAX_IMAGE_TTL_SECONDS
  const attachmentDefaultTtl = opts.attachmentLimits?.defaultTtlSeconds ?? DEFAULT_IMAGE_TTL_SECONDS
  const attachmentMaxPixels = opts.attachmentLimits?.maxPixels ?? MAX_IMAGE_PIXELS
  app.post("/api/attachments", express.raw({ type: () => true, limit: attachmentMaxBytes }), async (req: Request, res: Response) => {
    if (!attachmentManager) {
      res.status(503).json({ ok: false, error: "attachments unavailable" })
      return
    }
    const mime = (req.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase()
    if (!isImageAttachmentMime(mime)) {
      res.status(415).json({ ok: false, error: `unsupported image type; allowed: ${IMAGE_ATTACHMENT_MIMES.join(", ")}` })
      return
    }
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
    if (body.length > attachmentMaxBytes) {
      res.status(413).json({ ok: false, error: "attachment too large" })
      return
    }
    // Bytes are forwarded unchanged, so the declared type must be what the magic bytes say.
    const sniffed = sniffImageAttachment(body)
    if (!sniffed || sniffed.mime !== mime) {
      res.status(415).json({ ok: false, error: "image bytes do not match the declared type" })
      return
    }
    const { width, height } = sniffed
    if (width * height > attachmentMaxPixels) {
      res.status(422).json({ ok: false, error: "image pixel limit exceeded" })
      return
    }
    const rawTtl = req.headers["x-attachment-ttl"]
    const ttl = rawTtl == null || rawTtl === "" ? attachmentDefaultTtl : Number(rawTtl)
    if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > attachmentMaxTtl) {
      res.status(400).json({ ok: false, error: "invalid attachment TTL" })
      return
    }
    try {
      const manifest = await attachmentManager.upload(body, mime, ttl)
      res.status(201).json({ ok: true, data: { manifest } })
    } catch {
      res.status(502).json({ ok: false, error: "attachment upload unavailable" })
    }
  })
  app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    if (req.path === "/api/attachments" && err?.type === "entity.too.large") {
      res.status(413).json({ ok: false, error: "attachment too large" })
      return
    }
    next(err)
  })
  app.use(express.json())

  // 本地投递(形态分派)已收口到 delivery/inject-pump.deliverToLocalNode(方案 B PR2):
  // handler 只读终态 delivered|accepted|failed;unsupported-actuator 不再产生。

  // msg 是跨机原件：必须一路带到 uplink，否则 transport 只能拿 text 现造一条
  // （id 重铸 / type 退化 chat / meta 丢失），全网同一性就断了。
  async function deliverRemote(to: string, text: string, msg: MeshMessage): Promise<DeliveryResult> {
    if (!transport) {
      return { delivered: false, method: "uplink", error: "no transport configured" }
    }
    const { deviceId: targetDeviceId } = parseNodeId(to)
    return transport.deliver({ type: "remote", deviceId: targetDeviceId, nodeId: to }, text, msg)
  }

  // formatDelivery（[mesh:<from>] 前缀）已上移 delivery/inject-pump——
  // 收端 downlink 着陆也要用同一个函数加前缀，不能各写一份。

  // ===== Register =====
  app.post("/api/register", async (req: Request, res: Response) => {
    const { shortId, sessionId, pid, role, description } = req.body
    // deliveryMode 收敛(PR2):入口即归一 inject|pull——旧值(sse-pull/native-api/poll-only/未知)永收,映射为 pull。
    const deliveryMode = normalizeDeliveryMode(req.body.deliveryMode)

    // sessionId 必填规则按 deliveryMode 分派：
    // - inject（含缺省）：必须有真 pane，缺 sessionId 仍 400。
    // - sse-pull / native-api：端点无 pane，sessionId 可省 → 生成 nopane-<nodeId> 占位。
    const needsRealSession = deliveryMode === "inject"
    if (!shortId || pid == null || !role || (needsRealSession && !sessionId)) {
      res.status(400).json({ ok: false, error: "missing required fields: shortId, sessionId, pid, role" })
      return
    }

    const nodeId = genNodeId(deviceId, shortId)
    // 无 pane 形态：占位 sessionId 强制 nopane-<nodeId> 前缀，
    // 保证 pickFor 永不被喂到真 pane（下游 inject 守卫也会拦 nopane-）。
    const effectiveSessionId = sessionId ?? `nopane-${nodeId}`
    // inject 节点注册时采一次身份指纹（session_name|cwd|前台进程）。
    // 这是**唯一**能拿到"当初那个 pane 长什么样"的时刻——重启后只能拿它比对。
    const identityAvailable = deliveryMode === "inject" && sessionId
      ? supportsIdentity(sessionId)
      : false
    const identityFp = identityAvailable && sessionId
      ? await fingerprintOf(sessionId)
      : null

    const node: LocalNode = {
      identity: {
        nodeId,
        deviceId,
        shortId,
        role,
        description: description ?? "",
        capabilities: [],
        deliveryMode,
      },
      sessionId: effectiveSessionId,
      pid,
      lastSeen: now(),
      status: "idle",
      ...(identityFp ? { identityFp } : {}),
    }

    registry.register(node)
    if (deliveryMode === "inject" && sessionId && !identityAvailable) {
      console.warn(
        `[mesh] identity unavailable: node=${nodeId} session=${JSON.stringify(sessionId)} ` +
        `—— 仅验活、无持久指纹`,
      )
    } else if (deliveryMode === "inject" && sessionId && identityFp == null) {
      registry.markInjectMismatch(nodeId, "session 不存在（注册身份失败）")
    }
    store.saveNode(node)
    events?.emit("node:register", { node })
    if (uplink?.isConnected()) {
      await uplink.sendRegistration(registry.getAll().map((n) => n.identity))
    }
    res.json({ ok: true, data: { nodeId } })
  })

  // ===== Unregister =====
  app.delete("/api/register", async (_req: Request, res: Response) => {
    const removedNodeIds = registry.getAll().map((node) => node.identity.nodeId)
    for (const nodeId of removedNodeIds) {
      registry.unregister(nodeId)
      store.removeNode(nodeId)
      wake.forget(nodeId)
      events?.emit("node:unregister", { nodeId })
    }
    if (uplink?.isConnected()) {
      await uplink.sendRegistration([])
    }
    res.json({ ok: true, data: { removedNodeIds } })
  })

  app.delete("/api/register/:nodeId", async (req: Request, res: Response) => {
    const nodeId = req.params.nodeId as string
    const node = registry.get(nodeId)
    if (!node) {
      res.status(404).json({ ok: false, error: "node not found" })
      return
    }
    registry.unregister(nodeId)
    store.removeNode(nodeId)
    wake.forget(nodeId)
    events?.emit("node:unregister", { nodeId })
    if (uplink?.isConnected()) {
      await uplink.sendRegistration(registry.getAll().map((n) => n.identity))
    }
    res.json({ ok: true })
  })

  // ===== Heartbeat =====
  app.post("/api/heartbeat", (req: Request, res: Response) => {
    const { nodeId } = req.body
    if (!nodeId) {
      res.status(400).json({ ok: false, error: "missing nodeId" })
      return
    }
    const node = registry.get(nodeId)
    if (!node) {
      res.status(404).json({ ok: false, error: "node not found" })
      return
    }
    registry.heartbeat(nodeId)
    store.updateHeartbeat(nodeId)
    res.json({ ok: true })
  })

  // ===== Status =====
  // presence 派生（方案 B PR1，只改非 inject 节点的显示 status，不删节点）：
  //   parked>0 → idle；否则 lastSync 距今 <90s → idle；否则 offline。
  // inject 节点 status 逻辑一字不动（沿用 registry 内 node.status）。
  // 判定收口到 registry.hasActiveConsumer——wake:needed 用的是同一个函数，
  // 保证「这里显示 offline」和「那边该唤醒」永远是同一件事，不会两处漂移。
  app.get("/api/status", (_req: Request, res: Response) => {
    const nodes = registry.getAll().map((n) => {
      const mode = normalizeDeliveryMode(n.identity.deliveryMode)
      if (mode === "inject") {
        // 恢复态 inject 节点在身份校验通过前不许显示在线——和 pull 节点"未 sync 即 offline"
        // 同一条红线：恢复的是身份，不是在线状态。
        const verified = registry.isInjectVerified(n.identity.nodeId)
        if (verified) return { ...n, identityVerified: true }
        const mismatch = registry.getInjectMismatch(n.identity.nodeId)
        return {
          ...n,
          status: "offline",
          identityVerified: false,
          ...(mismatch ? { identityMismatch: mismatch } : {}),
        }
      }
      const nodeId = n.identity.nodeId
      const parkedCount = registry.getParkedCount(nodeId)
      const lastSyncAt = registry.getLastSyncAt(nodeId)
      const derived = registry.hasActiveConsumer(nodeId, PRESENCE_FRESH_MS) ? "idle" : "offline"
      return { ...n, status: derived, parkedCount, lastSyncAt: lastSyncAt ?? null, listener: doorbell.status(nodeId, lastSyncAt ?? null) }
    })
    const uplink = opts.transport && "uplink" in opts.transport
      ? { connected: (opts.transport as any).uplink?.isConnected?.() ?? false }
      : null
    res.json({ ok: true, data: { nodes, deviceId, uplink } })
  })

  app.get("/api/devices", (_req: Request, res: Response) => {
    const devices = opts.getDevices?.() ?? []
    const source = opts.getDevicesSource?.() ?? "cache"
    res.json({ ok: true, data: { devices, source } })
  })

  async function spawnLocal(body: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    const { role, mode, projectDir, wrapperPath, description, agent, delegatorNodeId } = body

    if (!agent) {
      return { ok: false, error: "missing required field: agent" }
    }

    let profile
    try {
      profile = loadAgentProfile(agent as string, opts.profileHome)
    } catch (err: any) {
      return { ok: false, error: err.message ?? "invalid agent profile" }
    }
    if (!profile) {
      return { ok: false, error: `unknown agent: ${agent}` }
    }

    const shortId = genShortId()
    const nodeId = genNodeId(deviceId, shortId)
    const effRole = (role as string | undefined) ?? "worker"
    const effMode = (mode as "tab" | "window" | undefined) ?? "tab"
    const effLauncher = profile.launcher
    const cwd = (projectDir as string | undefined) ?? profile.cwd
    const wrapper = (wrapperPath as string | undefined)
      ?? path.resolve(__dirname, "../../../scripts/mesh-agent-wrapper.sh")
    const desc = (description as string | undefined) ?? "mesh-worker"

    const esc = (s: string) => s.replace(/'/g, `'\\''`)
    const delegatorEnv = delegatorNodeId ? ` MESH_DELEGATOR_NODE='${esc(delegatorNodeId as string)}'` : ""
    const cmd = `MESH_SHORT_ID='${esc(shortId)}' MESH_LAUNCHER='${esc(effLauncher)}'${delegatorEnv} bash '${esc(wrapper)}' '${esc(effRole)}' '${esc(desc)}' '${esc(cwd)}' '${esc(effLauncher)}'`
    const spawnResult = await terminal.spawn(cmd, { mode: effMode, cwd })
    const sessionId = spawnResult.sessionId
    const windowId = spawnResult.windowId

    let registered = false
    const waitReadyUntil = Date.now() + spawnReadyTimeoutMs
    do {
      if (registry.findByShortId(shortId)) {
        registered = true
        break
      }
      await new Promise((r) => setTimeout(r, Math.min(1000, Math.max(1, spawnReadyTimeoutMs))))
    } while (Date.now() < waitReadyUntil)

    const bootstrapText = `你是 cc-mesh worker。现在**唯一任务**：**调用 Bash 工具**执行下面这条命令，发出 ready 信号。

事实：
- worker_node_id: ${nodeId}
- session_id: ${sessionId}
- role: ${effRole}
${delegatorNodeId ? `- lead_node_id: ${delegatorNodeId}` : "- lead_node_id: <missing>"}

wrapper 已自动向 lead 发送 [bootstrap][registered]。接下来 **ready 必须你亲自通过 Bash tool call 发出**——不是输出"已发送"文字、不是复述命令、不是用 echo 占位。是**真的**调 Bash 工具跑这一条：

${delegatorNodeId
  ? `mesh send ${delegatorNodeId} "[bootstrap][ready] worker=${nodeId} session=${sessionId} role=${effRole}"`
  : `echo "missing lead_node_id; cannot send bootstrap ready"`}

⚠️ 如果你只是在回复里写"好的，已发送 ready"，lead 收不到信号，整个 spawn 链路会断。**现在就用 Bash 工具执行**，不要等。只使用完整 nodeId，禁止用 shortId / role。

执行完停止。不要读业务文件、不要复述 scope、不要开始任务。等主 cc 下发正式 dispatch（会通过 REPL inject 到你对话窗），看到再往下做。
`

    let ready = false
    if (effMode !== "window" && sessionId.startsWith("mesh-")) {
      for (let i = 0; i < 30; i++) {
        try {
          const { stdout = "" } = await commandRunner("tmux", ["capture-pane", "-t", sessionId, "-p"])
          // 认全部已知 agent 提示符：codex 0.147.0 用 › 而不是 ❯，只认 ❯ 会让
          // 这个循环空转满 30 秒、ready 永远为 false，然后照样往还没接管 stdin
          // 的 pane 里灌 bootstrap。
          if (AGENT_PROMPT_CHARS.some((ch) => stdout.includes(ch))) {
            ready = true
            break
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 1000))
      }
    }

    // ❯ 出现 ≠ TUI stdin 立刻可读：实测 claude 2.1.119 在 Linux/WSL 下会吞
    // 掉第一波 paste 字节（input handler 初始化 race —— TUI 已经渲染输入框
    // 但内部还没订阅 stdin）。同样的 inject 一会儿后再调就没事。
    //
    // 策略：先等 5 秒，再 double-inject——第一次被吞了不要紧，等 2s 让
    // claude 把 input 缓冲清干净，第二次进。claude 输入框被第二次 inject
    // 覆盖，最终就是一份完整 bootstrap。
    //
    // 5s 是 ❯ 渲染到 input 真正激活的下界（实测 4090 WSL 5-10s）。Mac 节点
    // 也走这个路径，但它们 paste 不丢，相当于第一次就成功（第二次只是覆盖
    // 同样内容，无害；多花 2s 而已）。
    await new Promise((r) => setTimeout(r, 5000))
    await terminal.inject(sessionId, bootstrapText, windowId ? { windowId } : undefined)
    await new Promise((r) => setTimeout(r, 2000))
    const delivered = await terminal.inject(
      sessionId,
      bootstrapText,
      windowId ? { windowId } : undefined,
    )

    return {
      ok: true,
      data: {
        nodeId,
        shortId,
        sessionId,
        windowId,
        registered,
        promptReady: ready,
        bootstrapDelivered: delivered,
      },
    }
  }

  // 发送方 shortId 提取：parseNodeId 支持 "device:short" 也支持裸 short
  function shortIdOf(nodeId: string): string {
    const parts = nodeId.split(":")
    return parts.length > 1 ? parts[parts.length - 1]! : nodeId
  }

  // 投递目标校验：必须是完整 nodeId（"deviceId:shortId"）。
  // 远端 nodeId 透传（由 uplink 判定可达），本地 nodeId 必须在 registry 中。
  // 不再支持 role / shortId 别名——多 cc 并存时 role 非唯一，别名会窜节点。
  function validateFullNodeId(to: string): string | null {
    if (!to.includes(":")) return null
    const parsed = parseNodeId(to)
    if (parsed.deviceId !== deviceId) return to
    return registry.get(to) ? to : null
  }

  // 本地投递成功后触发 tmux 状态栏通知（opt-out via MESH_NOTIFY=0）。
  // 对 iTerm 等没有 notify 方法的终端自动跳过；失败静默不影响 send。
  async function maybeNotify(target: LocalNode, fromNodeId: string): Promise<void> {
    if (process.env.MESH_NOTIFY === "0") return
    if (!terminal.notify) return
    try {
      await terminal.notify(target.sessionId, `📬 mesh: from ${shortIdOf(fromNodeId)}`)
    } catch {
      // notify 失败不影响 send
    }
  }

  // 投递内核：落库 → 路由 → 投递 → 回写终态 → 发事件。
  // /api/send 与 /api/dispatch 共用同一条路径——派单不是第二套管道，
  // 只是"给 send 穿了件任务马甲"，所以账本同步/审计/游标全自动复用（设计 §6.2）。
  // notFound=true 时由调用方决定 HTTP 码（send/dispatch 都回 404）。
  type SubmitResult = { status: string; notFound: boolean }
  async function submitMessage(msg: MeshMessage, priority: MessagePriority): Promise<SubmitResult> {
    // 记账哨兵 @ledger（设计 §4.3）：只落库不投递——不注入终端、不广播、不走 uplink。
    // 对哨兵而言落库即送达，故 status 直接 delivered（不留一堆永远 submitted 的假未决行）。
    // 它不是节点，registry 里永远查不到，所以必须在 route 之前截住。
    if (msg.to === LEDGER_SINK) {
      store.saveMessage(msg, "delivered", priority)
      events?.emit("msg:send", { msgId: msg.id, from: msg.from, to: msg.to, status: "delivered" })
      return { status: "delivered", notFound: false }
    }

    // priority 只存储、只透传（缺省/非法值 → normal）；V1 无调度行为。
    store.saveMessage(msg, "submitted", priority)

    const result = router.route(msg)
    const deliveryFrom = msg.from === `${deviceId}:relay` ? undefined : msg.from
    const deliveryText = result.action === "local" && normalizeDeliveryMode(result.target.identity.deliveryMode) === "inject"
      ? await formatAttachmentsForDelivery(formatDelivery(deliveryFrom, msg.payload), msg, attachmentManager)
      : formatDelivery(deliveryFrom, msg.payload)
    if (result.action === "local") {
      // 恢复态 inject 节点：投递前先验活 + 验身份。不通过就落库不投（status=queued），
      // 绝不把消息喂进一个同名的陌生 pane。
      if (!(await ensureInjectIdentity(result.target))) {
        store.updateMessageStatus(msg.id, "queued")
        events?.emit("msg:send", { msgId: msg.id, from: msg.from, to: msg.to, status: "queued" })
        return { status: "queued", notFound: false }
      }
      // how 全下沉 deliverToLocalNode(delivery/inject-pump)，handler 只读终态——形态 if-else 不进 handler（G4）。
      const outcome = await deliverToLocalNode(result.target, deliveryText, { terminal, transport })
      // PR2:unsupported-actuator 不再产生(native-api 收敛 pull → accepted),三终态全部落库。
      store.updateMessageStatus(msg.id, outcome)

      // ===== 温唤醒判定（任务2）=====
      // accepted = pull 形态，消息只是落了库，得有人来取。没人挂长轮询就该叫醒它。
      //
      // 采样放在门铃**之前**：events.emit 是同步的，停车中的 sync 会当场 settle 并把
      // parkedCount 减到 0，采样晚一步读到的就是「已经被服务过」的残局。
      // 今天这一步换个顺序也不会出错——markParked 同时会写 lastSyncAt，停车又被
      // clamp 在 55s 内，所以 parked>0 的节点必然 lastSync 新鲜，freshness 那一路会
      // 兜住。但那是两个不相干实现细节碰巧对上的巧合，不是 wake 判定该依赖的东西：
      // 采样在前，判定就只跟「消息落地那一刻的状态」有关。
      // parkedAtDecision 因此在触发时恒为 0（needsWake 蕴含 parked==0），
      // 它记的是触发条件本身，将来放宽判定规则时才会出现非 0 值。
      const parkedAtDecision = registry.getParkedCount(msg.to)
      const needsWake = outcome === "accepted" && !registry.hasActiveConsumer(msg.to)

      events?.emit("msg:send", { msgId: msg.id, from: msg.from, to: msg.to, status: outcome })
      if (needsWake) wake.notify(msg.to, parkedAtDecision)
      if (outcome === "delivered") {
        events?.emit("msg:delivered", { msgId: msg.id })
        await maybeNotify(result.target, msg.from)
      }
      return { status: outcome, notFound: false }
    }
    if (result.action === "uplink") {
      // D29: uplink (跨机) 分支加 retry。心跳 60s 窗口 + reconnect 5s gap 期间
      // 仍可能踩 stale ws,自动重试 1 次能盖住跨境弱网偶发投递失败。
      // local 分支不重试 (terminal inject fail 通常是 tmux session 真死)。
      const retries = sendRetryCount()
      let delivered = false
      for (let i = 0; i <= retries; i++) {
        const r = await deliverRemote(msg.to, deliveryText, msg)
        delivered = r.delivered
        if (delivered) break
        if (i < retries) await new Promise((r) => setTimeout(r, 1000))
      }
      const finalStatus = delivered ? "delivered" : "failed"
      store.updateMessageStatus(msg.id, finalStatus as any)
      events?.emit("msg:send", { msgId: msg.id, from: msg.from, to: msg.to, status: finalStatus })
      if (delivered) events?.emit("msg:delivered", { msgId: msg.id })
      return { status: finalStatus, notFound: false }
    }
    if (result.action === "broadcast") {
      for (const target of result.targets) {
        await deliverToLocalNode(target, deliveryText, { terminal, transport })
      }
      store.updateMessageStatus(msg.id, "delivered")
      events?.emit("msg:send", { msgId: msg.id, from: msg.from, to: msg.to, status: "delivered" })
      events?.emit("msg:delivered", { msgId: msg.id })
      return { status: "delivered", notFound: false }
    }
    store.updateMessageStatus(msg.id, "failed")
    events?.emit("msg:send", { msgId: msg.id, from: msg.from, to: msg.to, status: "failed" })
    return { status: "failed", notFound: true }
  }

  // ===== Send =====
  app.post("/api/send", async (req: Request, res: Response) => {
    const fromNodeId = req.headers["x-mesh-node"] as string | undefined
    const effectiveFrom = fromNodeId ?? `${deviceId}:relay`
    const { to, message, type, replyTo, priority, attachments } = req.body

    if (!to || !message) {
      res.status(400).json({ ok: false, error: "missing required fields: to, message" })
      return
    }

    // @ledger 是账本入口不是节点：跳过 nodeId 形态校验，其余照常（type 自由字符串，如 quota_report）。
    const resolved = to === LEDGER_SINK ? LEDGER_SINK : validateFullNodeId(to)
    if (!resolved) {
      res.status(400).json({
        ok: false,
        error: `target must be full nodeId (device:shortId) and online, got: ${to}`,
      })
      return
    }

    let validatedAttachments
    try {
      validatedAttachments = attachments === undefined
        ? undefined
        : validateImageAttachmentManifests(attachments, { nowMs: opts.attachmentNow?.() ?? Date.now() })
    } catch (err: any) {
      res.status(400).json({ ok: false, error: err?.message ?? "invalid attachments" })
      return
    }

    const msg: MeshMessage = {
      id: genMessageId(effectiveFrom),
      from: effectiveFrom,
      to: resolved,
      type: (type as MessageType) ?? "chat",
      payload: message,
      ...(replyTo !== undefined ? { replyTo } : {}),
      createdAt: now(),
      ...(validatedAttachments ? { meta: { attachments: validatedAttachments } } : {}),
    }

    const outcome = await submitMessage(msg, normalizePriority(priority))
    if (outcome.notFound) {
      res.status(404).json({ ok: false, error: "target not found" })
      return
    }
    res.json({ ok: true, data: { msgId: msg.id, status: outcome.status } })
  })

  // ===== Dispatch（M2 派单接缝：主脑 / CLI / 微信 / 将来 web 全打这一个口）=====
  // v1 = DirectDispatcher：显式指定席位的直达投递，pick.reason 恒 explicit。
  // 升级调度算法只换 pick() 实现，这个 handler 一行不改（设计 §6）。
  const dispatcher = new DirectDispatcher(validateFullNodeId)
  app.post("/api/dispatch", async (req: Request, res: Response) => {
    const fromNodeId = req.headers["x-mesh-node"] as string | undefined
    const { title, payload, to, project, constraints, todoUid } = req.body ?? {}

    if (typeof title !== "string" || title.trim() === "") {
      res.status(400).json({ ok: false, error: "missing required field: title" })
      return
    }
    if (typeof payload !== "string" || payload === "") {
      res.status(400).json({ ok: false, error: "missing required field: payload" })
      return
    }

    const task: DispatchTask = { title, payload, to, project, constraints, ...(typeof todoUid === "string" && todoUid !== "" ? { todoUid } : {}) }
    let pick: SeatPick
    try {
      pick = dispatcher.pick(task)
    } catch (err: any) {
      const status = err instanceof DispatchError ? err.status : 500
      res.status(status).json({ ok: false, error: err?.message ?? "dispatch failed" })
      return
    }

    const msg: MeshMessage = {
      id: genMessageId(fromNodeId ?? "unknown"),
      from: fromNodeId ?? "unknown",
      to: pick.nodeId,
      type: "task",
      // payload 是原文：注入终端的就是它，不包任何信封——
      // 任务元数据走 meta（只进库/上账本），别污染 worker 看到的正文。
      payload,
      createdAt: now(),
      meta: {
        _task: {
          title,
          ...(typeof project === "string" && project !== "" ? { project } : {}),
          pickReason: pick.reason,
          ...(typeof todoUid === "string" && todoUid !== "" ? { todoUid } : {}),
        },
      },
    }

    const outcome = await submitMessage(msg, normalizePriority(constraints?.priority))
    if (outcome.notFound) {
      res.status(404).json({ ok: false, error: "target not found" })
      return
    }
    const result: DispatchResult = { taskId: msg.id, msgId: msg.id, pick }
    res.json({ ok: true, data: { ...result, status: outcome.status } })
  })

  // ===== Inbox（游标补拉：?since=<seq> 只取 seq>since，按 seq ASC） =====
  app.get("/api/inbox", (req: Request, res: Response) => {
    const nodeId = req.query.nodeId as string | undefined
    if (!nodeId) {
      res.status(400).json({ ok: false, error: "missing nodeId query parameter" })
      return
    }
    const sinceRaw = req.query.since as string | undefined
    const since = sinceRaw != null ? Number(sinceRaw) : undefined
    const opts = since != null && !Number.isNaN(since) ? { since } : {}
    const messages = store.getInbox(nodeId, opts)
    res.json({ ok: true, data: { messages } })
  })

  // ===== Ack（推进 per-node 游标；销账已消费消息，防重投） =====
  app.post("/api/ack", (req: Request, res: Response) => {
    const { nodeId, upTo } = req.body
    if (!nodeId || upTo == null) {
      res.status(400).json({ ok: false, error: "missing required fields: nodeId, upTo" })
      return
    }
    const upToSeq = Number(upTo)
    if (Number.isNaN(upToSeq)) {
      res.status(400).json({ ok: false, error: "upTo must be a number (seq)" })
      return
    }
    store.ack(nodeId, upToSeq)
    res.json({ ok: true, data: { nodeId, cursor: store.getAckCursor(nodeId) } })
  })

  // ===== Sync（方案 B 单原语：门铃 + 取货 + 销账一个动词，长轮询）=====
  // GET /api/sync?nodeId=&since=&timeout=<0..55,默认55>&limit=<默认100>
  //  - since 缺省 = 服务端 ack 游标（客户端零状态崩溃恢复）
  //  - since 显式 > 游标 → 先 store.ack（推进游标，单调 MAX），再取
  //  - since 显式 ≤ 游标 → 不动游标，照常取 seq>since（回看重读）
  //  - 有 seq>since 消息 → 立即返回整批（≤limit，seq ASC）
  //  - 无消息 → 停车：先订阅 msg:send → 再查一次（防 lost-wakeup）→ 再停；
  //    事件/超时/连接 close 三路 settle-once + clearTimeout；事件只当门铃，结算重查取整批
  //  - timeout=0 → 立即空批返回（探测语义）
  app.get("/api/sync", async (req: Request, res: Response) => {
    const nodeId = req.query.nodeId as string | undefined
    if (!nodeId) {
      res.status(400).json({ ok: false, error: "missing nodeId query parameter" })
      return
    }
    if (!registry.get(nodeId)) {
      res.status(404).json({ ok: false, error: "node not registered" })
      return
    }

    // 每次 sync 刷新 lastSyncAt（presence 派生用）。
    registry.touchSync(nodeId)

    // limit：正整数，缺省 100。
    const limitRaw = req.query.limit as string | undefined
    const limitNum = limitRaw != null ? Number(limitRaw) : 100
    const limit = Number.isFinite(limitNum) && limitNum > 0
      ? Math.min(SYNC_MAX_LIMIT, Math.floor(limitNum))
      : SYNC_MAX_LIMIT

    // timeout：clamp 0..55，缺省 55。
    const timeoutRaw = req.query.timeout as string | undefined
    const timeoutNum = timeoutRaw != null ? Number(timeoutRaw) : 55
    const timeoutSec = Number.isFinite(timeoutNum) ? Math.max(0, Math.min(55, Math.floor(timeoutNum))) : 55

    // since 解析 + 即 ack 语义。
    //
    // ⚠️ 入口钳制（2026-09-05/08 claude-main 失聪事故）：显式 since 先钳到 head。
    // 这个端点长得像只读 GET，实则 `since > 游标` 即**写**游标（store.ack）。事故正是
    // 一条「试试 since>head 会返回空批还是报错」的诊断 curl 把 epoch 写进了 seq 游标
    // ——探测行为本身成了投毒。store.ack 里已有写闸，这里再钳一道是因为 since 还兼任
    // **本次请求 getInbox 的过滤下界**：只钳写不钳读的话，游标干净了，这一拨仍会被
    // 荒谬的 since 坑成空批（假装「没消息」）。钳到 head 后最坏退化成「从 head 读」。
    const head = store.headSeq()
    const cursor = store.getAckCursor(nodeId)
    const sinceRaw = req.query.since as string | undefined
    let since: number
    if (sinceRaw != null && sinceRaw !== "" && !Number.isNaN(Number(sinceRaw))) {
      since = Math.min(Number(sinceRaw), head)
      if (since > cursor) store.ack(nodeId, since) // 显式且 > 游标 → 推进游标（销账），再取
    } else {
      since = cursor // 缺省 = 服务端游标
    }

    const startedAt = Date.now()
    const respond = async (messages: MeshMessage[]): Promise<void> => {
      const maxSeq = messages.reduce((m, x) => Math.max(m, x.seq ?? 0), since)
      const derived = await Promise.all(messages.map(async (message) => {
        const raw = (message.meta as any)?.attachments
        if (!Array.isArray(raw) || raw.length === 0) return message
        const attachments = await Promise.all(raw.map(async (item: any) => {
          try {
            const validated = validateImageAttachmentManifests([item], { nowMs: opts.attachmentNow?.() ?? Date.now() })[0]!
            const got = await materializeBounded(validated)
            return { ...validated, ...(got.localPath ? { localPath: got.localPath } : { error: got.error ?? "unavailable" }) }
          } catch { return { ...item, error: "unavailable" } }
        }))
        return { ...message, meta: { ...message.meta, attachments } }
      }))
      res.json({
        ok: true,
        data: { messages: derived, nextSince: Math.max(maxSeq, since), parkedMs: Date.now() - startedAt },
      })
    }

    // 立即返回：有 seq>since 消息。
    const first = store.getInbox(nodeId, { since, limit })
    if (first.length > 0) {
      await respond(first)
      return
    }
    // timeout=0：立即空批返回。
    if (timeoutSec === 0) {
      await respond([])
      return
    }
    // 无事件总线无法真停车 → 诚实降级为空批返回（不假装长轮询）。
    if (!events) {
      await respond([])
      return
    }

    // ===== 停车：先订阅 → 再查 → 再停 =====
    // nid：把已窄化的 nodeId 固化成 string（供下面 arrow 闭包捕获，避免 undefined 联合）。
    const nid: string = nodeId
    let settled = false
    let parked = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const onMsg = (data: { to: string }): void => {
      // 门铃：只认发给本节点（直发）或广播（to='*'）的 msg:send。
      if (data.to === nid || data.to === "*") void settle()
    }
    const cleanup = (): void => {
      if (timer) clearTimeout(timer)
      events.off("msg:send", onMsg)
      req.off("close", onClose)
    }
    const settle = async (): Promise<void> => {
      if (settled) return
      settled = true
      cleanup()
      if (parked) {
        registry.unmarkParked(nid)
        parked = false
      }
      // 事件不带批正文——结算时重查 getInbox 取整批。
      await respond(store.getInbox(nid, { since, limit }))
    }
    const onClose = (): void => {
      if (settled) return
      settled = true
      cleanup()
      if (parked) {
        registry.unmarkParked(nid)
        parked = false
      }
      // 连接已断，不再响应。
    }

    // 1) 先订阅门铃。
    events.on("msg:send", onMsg)
    // 2) 再查一次——覆盖「订阅前落库」的消息，关掉 lost-wakeup 窗口。
    const recheck = store.getInbox(nodeId, { since, limit })
    if (recheck.length > 0) {
      await settle()
      return
    }
    // 3) 真停车：计数 +1，挂超时 + 连接 close 清理。
    parked = true
    registry.markParked(nodeId)
    timer = setTimeout(() => { void settle() }, timeoutSec * 1000)
    req.on("close", onClose)
  })

  // ===== Broadcast =====
  app.post("/api/broadcast", async (req: Request, res: Response) => {
    const fromNodeId = req.headers["x-mesh-node"] as string | undefined
    const { message, type } = req.body

    if (!message) {
      res.status(400).json({ ok: false, error: "missing required field: message" })
      return
    }

    const msg: MeshMessage = {
      id: genMessageId(fromNodeId ?? "unknown"),
      from: fromNodeId ?? "unknown",
      to: "*",
      type: (type as MessageType) ?? "broadcast",
      payload: message,
      createdAt: now(),
    }

    store.saveMessage(msg)

    const deliveryText = formatDelivery(fromNodeId, message)
    const result = router.route(msg)
    if (result.action === "broadcast") {
      for (const target of result.targets) {
        await deliverToLocalNode(target, deliveryText, { terminal, transport })
      }
    }

    store.updateMessageStatus(msg.id, "delivered")
    // 审计发现 1：补 emit msg:send（to='*'）——否则停车的 sync 收广播要等满一个超时窗，
    // 判据 7 对广播失效。除此 emit 外，broadcast 行为一字不改。
    events?.emit("msg:send", { msgId: msg.id, from: msg.from, to: "*", status: "delivered" })
    res.json({ ok: true, data: { msgId: msg.id } })
  })

  // ===== Spawn (三原子：spawn → wait_ready → inject bootstrap) =====
  app.post("/api/spawn", async (req: Request, res: Response) => {
    try {
      const targetDevice = req.body.targetDevice as string | undefined
      if (targetDevice && targetDevice !== deviceId) {
        if (!opts.requestRemoteSpawn) {
          res.status(501).json({ ok: false, error: "remote spawn not configured" })
          return
        }
        const remote = await opts.requestRemoteSpawn(targetDevice, req.body as Record<string, unknown>)
        res.status(remote.ok ? 200 : 502).json(remote)
        return
      }

      const result = await spawnLocal(req.body as Record<string, unknown>)
      res.status(result.ok ? 200 : 400).json(result)
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message ?? "spawn failed" })
    }
  })

  // ===== KV List =====
  app.get("/api/kv", (_req: Request, res: Response) => {
    const list = store.kvList()
    res.json({ ok: true, data: list })
  })

  // ===== KV Get =====
  app.get("/api/kv/:key", (req: Request, res: Response) => {
    const key = req.params.key as string
    const entry = store.kvGet(key)
    if (!entry) {
      res.status(404).json({ ok: false, error: "key not found" })
      return
    }
    res.json({ ok: true, data: entry })
  })

  // ===== KV Put =====
  app.put("/api/kv/:key", (req: Request, res: Response) => {
    const key = req.params.key as string
    const { value, updatedBy } = req.body
    const nodeId = (req.headers["x-mesh-node"] as string | undefined) ?? updatedBy ?? "unknown"

    if (value == null) {
      res.status(400).json({ ok: false, error: "missing required field: value" })
      return
    }

    store.kvSet(key, value, nodeId)
    res.json({ ok: true })
  })

  // ===== KV Delete =====
  app.delete("/api/kv/:key", (req: Request, res: Response) => {
    const key = req.params.key as string
    store.kvDel(key)
    res.json({ ok: true })
  })

  // ===== Terminal: Direct Inject =====
  app.post("/api/terminal/inject", async (req: Request, res: Response) => {

    const { sessionId, text, windowId } = req.body
    if (!sessionId || !text) {
      res.status(400).json({ ok: false, error: "missing required fields: sessionId, text" })
      return
    }
    try {
      const ok = await terminal.inject(sessionId, text, windowId ? { windowId } : undefined)
      res.json({ ok, data: { delivered: ok } })
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message ?? "inject failed" })
    }
  })

  // ===== Terminal: Current Session =====
  app.get("/api/terminal/current", async (_req: Request, res: Response) => {

    try {
      const session = await terminal.getCurrentSession()
      res.json({ ok: true, data: session })
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message ?? "getCurrentSession failed" })
    }
  })

  // ===== Terminal: Is Alive =====
  app.get("/api/terminal/alive/:sessionId", async (req: Request, res: Response) => {

    try {
      const alive = await terminal.isAlive(req.params.sessionId as string)
      res.json({ ok: true, data: { alive } })
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message ?? "isAlive failed" })
    }
  })

  // ===== Terminal: Close =====
  app.post("/api/terminal/close", async (req: Request, res: Response) => {

    const { sessionId } = req.body
    if (!sessionId) {
      res.status(400).json({ ok: false, error: "missing required field: sessionId" })
      return
    }
    try {
      await terminal.close(sessionId)
      const removedNodeIds: string[] = []
      for (const node of registry.getAll()) {
        if (node.sessionId === sessionId) {
          const nodeId = node.identity.nodeId
          registry.unregister(nodeId)
          store.removeNode(nodeId)
          wake.forget(nodeId)
          removedNodeIds.push(nodeId)
          events?.emit("node:unregister", { nodeId })
        }
      }
      if (removedNodeIds.length > 0 && uplink?.isConnected()) {
        await uplink.sendRegistration(registry.getAll().map((n) => n.identity))
      }
      res.json({ ok: true, data: { removedNodeIds } })
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message ?? "close failed" })
    }
  })

  // ===== Terminal: Spawn =====
  app.post("/api/terminal/spawn", async (req: Request, res: Response) => {

    const { cmd, mode, cwd } = req.body
    if (!cmd) {
      res.status(400).json({ ok: false, error: "missing required field: cmd" })
      return
    }
    try {
      const result = await terminal.spawn(cmd, { mode, cwd })
      res.json({ ok: true, data: result })
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message ?? "spawn failed" })
    }
  })

  // ===== Terminal: Peek (capture tmux screen) =====
  app.get("/api/terminal/peek/:sessionId", async (req: Request, res: Response) => {
    const sessionId = req.params.sessionId as string
    const lines = Number(req.query.lines ?? 50)
    try {
      const { stdout = "" } = await commandRunner("tmux", ["capture-pane", "-t", sessionId, "-p", "-S", `-${lines}`])
      res.json({ ok: true, data: { sessionId, lines: stdout.split("\n"), lineCount: stdout.split("\n").length } })
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message ?? "peek failed" })
    }
  })

  // ===== Dashboard HTML =====
  app.get("/dashboard", (_req: Request, res: Response) => {
    const candidates = [
      path.resolve(__dirname, "dashboard.html"),
      path.resolve(__dirname, "../src/dashboard.html"),
    ]
    for (const p of candidates) {
      try {
        const html = fs.readFileSync(p, "utf-8")
        res.setHeader("Content-Type", "text/html; charset=utf-8")
        res.send(html)
        return
      } catch {}
    }
    res.status(500).send("dashboard.html not found")
  })

  // Dedicated transport receipt: never calls sync, heartbeat, Store.ack or registration.
  for (const action of ['ack', 'execution'] as const) {
    app.post(`/api/doorbell/${action}`, (req: Request, res: Response) => {
      const node = registry.get(req.body?.nodeId)
      if (!node || normalizeDeliveryMode(node.identity.deliveryMode) !== 'pull') {
        res.status(404).json({ ok: false, error: 'pull node not registered' }); return
      }
      const ok = action === 'ack' ? doorbell.ack(req.body) : doorbell.started(req.body)
      if (!ok) { res.status(409).json({ ok: false, error: 'stale or invalid doorbell receipt' }); return }
      publishListeners()
      res.json({ ok: true, data: doorbell.status(req.body.nodeId, registry.getLastSyncAt(req.body.nodeId) ?? null) })
    })
  }

  // ===== SSE 事件流 =====
  if (events) {
    const EVENT_NAMES: MeshEventName[] = [
      "node:register",
      "node:unregister",
      "msg:send",
      "msg:delivered",
      "uplink:status",
      "wake:needed",
    ]
    app.get("/api/events", (req: Request, res: Response) => {
      const { nodeId, instanceId } = req.query
      const bound = nodeId !== undefined || instanceId !== undefined
      if (bound) {
        if (typeof nodeId !== 'string' || typeof instanceId !== 'string' || !/^[a-zA-Z0-9-]{8,100}$/.test(instanceId)) {
          res.status(400).json({ ok: false, error: 'nodeId and instanceId required' }); return
        }
        const node = registry.get(nodeId)
        if (!node) { res.status(404).json({ ok: false, error: 'node not registered' }); return }
        if (normalizeDeliveryMode(node.identity.deliveryMode) !== 'pull' || !doorbell.canBind(nodeId, instanceId)) {
          res.status(409).json({ ok: false, error: 'non-pull node or superseded instance' }); return
        }
      }
      res.setHeader("Content-Type", "text/event-stream")
      res.setHeader("Cache-Control", "no-cache")
      res.setHeader("Connection", "keep-alive")
      res.flushHeaders?.()
      res.write(": connected\n\n")

      if (bound) {
        const id = nodeId as string
        const send = (event: string, data: Record<string, unknown>) => {
          if (!res.destroyed) res.write(`data: ${JSON.stringify({ event, data })}\n\n`)
        }
        const binding = doorbell.bind(id, instanceId as string, send, () => res.end())
        const timer = setInterval(() => doorbell.probe(id), opts.doorbellProbeMs ?? 15_000)
        req.on('close', () => {
          clearInterval(timer); doorbell.disconnect(id, binding.connectionId); publishListeners()
        })
        doorbell.probe(id)
        // Subscribe before this read; backlog is a hint, never a cursor advance.
        if (store.countDirectBacklog(id, store.getAckCursor(id)) > 0) doorbell.message(id)
        publishListeners()
        return
      }
      const subs: Array<{ event: MeshEventName; fn: (data: any) => void }> = []
      for (const event of EVENT_NAMES) {
        const fn = (data: any) => {
          try {
            res.write(`data: ${JSON.stringify({ event, data })}\n\n`)
          } catch {}
        }
        events.on(event, fn)
        subs.push({ event, fn })
      }

      const heartbeat = setInterval(() => {
        try { res.write(": heartbeat\n\n") } catch {}
      }, 15000)

      req.on("close", () => {
        clearInterval(heartbeat)
        for (const { event, fn } of subs) events.off(event, fn)
      })
    })
  }

  // ===== ttyd 控制 =====
  if (ttyd) {
    app.post("/api/terminal/ttyd/:sessionId", async (req: Request, res: Response) => {
      const sessionId = req.params.sessionId as string
      try {
        const port = await ttyd.start(sessionId)
        res.json({ ok: true, data: { port, sessionId } })
      } catch (err: any) {
        res.status(500).json({ ok: false, error: err.message ?? "ttyd start failed" })
      }
    })

    app.delete("/api/terminal/ttyd/:sessionId", async (req: Request, res: Response) => {
      const sessionId = req.params.sessionId as string
      try {
        await ttyd.stop(sessionId)
        res.json({ ok: true })
      } catch (err: any) {
        res.status(500).json({ ok: false, error: err.message ?? "ttyd stop failed" })
      }
    })
  }

  // Expose internals for index.ts (cleanup timer, graceful shutdown)
  /**
   * 跨机着陆（Hub → uplink.onMessage → 这里）。
   *
   * 组装收口在闭包里：wake / registry / store / terminal / uplink 一个都漏不掉。
   * 缺口 G1 之所以能存在整整一个版本，就是因为这些参数原本在 index.ts 里手拼——
   * 手拼就一定会漏，而漏了本机测试还全绿。
   */
  async function deliverDownlink(msg: MeshMessage): Promise<DownlinkDeliveryResult> {
    return deliverDownlinkMessage({
      msg,
      registry,
      terminal,
      events,
      wake,
      removeNode: (nodeId) => store.removeNode(nodeId),
      sendRegistration: uplink ? (nodes) => uplink.sendRegistration(nodes) : undefined,
      // pull 目标着陆走 store-first（id 幂等），uplink retry 不产生重复行
      saveMessage: (m) => store.saveMessageIfAbsent(m),
      attachmentManager,
    })
  }

  const meshServer = app as MeshServer
  meshServer.doorbell = doorbell
  meshServer.publishListeners = publishListeners
  meshServer.closeDoorbell = () => { clearInterval(listenerTimer); doorbell.close() }
  meshServer.registry = registry
  meshServer.store = store
  meshServer.spawnLocal = spawnLocal
  meshServer.restoredNodeCount = restoredNodeCount
  meshServer.wake = wake
  meshServer.deliverDownlink = deliverDownlink

  return meshServer
}
