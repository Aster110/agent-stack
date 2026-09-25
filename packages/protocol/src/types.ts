// ===== 投递形态（回合制可达性投递） =====
// PR2 收敛:运行时只剩两种可达性——
// - inject: relay 直接 paste-buffer 写文本 + Enter 唤醒（tmux/Ghostty-里-tmux）
// - pull:   端点自取（GET /api/sync 长轮询带正文），relay 落库 + emit msg:send
// sse-pull / native-api 为遗留注册值(PR#1 四态)，入口(register)与读取(store)统一经
// normalizeDeliveryMode 归一为 pull;类型保留仅为兼容旧数据/旧客户端。
// 缺省语义 = inject（老节点不声明时按 inject 兜底）。
export type DeliveryMode = "inject" | "pull" | "sse-pull" | "native-api"

// ===== 节点身份 =====
export interface NodeIdentity {
  nodeId: string        // 全局唯一: {deviceId}:{shortId}
  deviceId: string      // 设备标识: "macbook" / "mini" / "us-cloud-1"
  shortId: string       // 本地短 ID: "cc-a1b2"
  role: NodeRole
  description: string
  capabilities: string[]
  deliveryMode?: DeliveryMode  // 缺省 = inject
}

export type NodeRole = "main" | "worker" | "service"

export interface ListenerStatus {
  nodeId: string
  state: "listening" | "waking" | "lost" | "unknown"
  instanceId: string | null
  connected: boolean
  lastAckAt: string | null
  lastSyncAt: string | null
  lastExecutionStartedAt: string | null
  observedAt: string
  expiresAt: string | null
  validForMs: number
}

export interface DeviceInventory {
  deviceId: string
  relayId: string
  nodes: NodeIdentity[]
  updatedAt: string
  listeners?: ListenerStatus[]
}

// ===== 本地节点（relay 内部用） =====
export interface LocalNode {
  identity: NodeIdentity
  sessionId: string     // iTerm2 session ID（用于注入）
  pid: number           // cc 进程 PID（用于检活）
  lastSeen: string      // ISO 8601
  status: "idle" | "busy"
  /**
   * inject 形态的**身份指纹**，注册时采样：
   *   `session_name|pane_current_path|pane_current_command`
   *
   * 为什么需要它：sessionId 存的是 tmux **session 名**，不是 pane id。
   * session 被 kill 后别的进程建个同名 session，`has-session` 照样返回 true——
   * 只验活会把消息喂进陌生 pane，静默且无回执。恢复态节点首次投递前拿它比对。
   * 老库/不支持取指纹的终端为 undefined（此时只验活，见 relay 的投递前校验）。
   */
  identityFp?: string
}

// ===== 消息格式 =====
export interface MeshMessage {
  id: string            // msg-{timestamp}-{fromNodeId}
  from: string          // 发送方 nodeId
  to: string            // 接收方 nodeId（"*" = 广播；"@ledger" = 记账哨兵，只落库不投递）
  type: MessageType
  payload: string
  replyTo?: string
  createdAt: string     // ISO 8601
  ttl?: number          // 存活秒数
  seq?: number          // 单调自增游标序号（store 分配；getInbox 带 since 时返回，供端点补拉/ack）
  meta?: Record<string, unknown>  // 结构化元数据（如派单 _task 信封）。只进库/上账本，注入终端时不带——正文永远只有 payload
}

/** Whitelisted image types; bytes travel unchanged, so the manifest names the real type. */
export type ImageAttachmentMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif"

/** Image attachment manifest (PNG/JPEG/WebP/GIF). Blob bytes and credentials never travel here. */
export interface ImageAttachmentManifest {
  version: 1
  id: string
  kind: "image"
  mime: ImageAttachmentMime
  size: number
  sha256: string
  width?: number
  height?: number
  storageRef: string
  createdAt: string
  expiresAt: string
}

// 消息优先级（store 存储列 + dispatch 透传；调度行为 v2+ 才用）
export type MessagePriority = "urgent" | "normal" | "bulk"

// 已知消息类型（有运行时语义/投影规则的）。
export type KnownMessageType =
  | "task"
  | "result"
  | "chat"
  | "inject"
  | "broadcast"
  | "system"
  | "quota_report"   // 额度探针 → @ledger 哨兵（Hub 投影成 quota_snapshots）
// 开放 union（2026-08-27，Ledger 接缝）：type 实践上是自由字符串——单管道多投影，
// 新账目 = 新 type + Hub 新投影函数，不必回来改协议。`string & {}` 保住字面量自动补全。
export type MessageType = KnownMessageType | (string & {})

// ===== 消息生命周期 =====
export type MessageStatus =
  | "submitted"   // 已提交到 relay
  | "routed"      // 已路由
  | "delivered"   // 已注入目标终端
  | "accepted"    // 已敲门（emit msg:send 门铃）未注入，端点自取正文（sse-pull）
  | "failed"      // 投递失败
  | "expired"     // 超时
  | "queued"      // 目标离线，云端排队

// ===== 路由结果 =====
export type RouteResult =
  | { action: "local"; target: LocalNode }
  | { action: "broadcast"; targets: LocalNode[] }
  | { action: "uplink" }
  | { action: "not_found" }

// ===== CLI → Relay 命令/响应 =====
export interface MeshCommand {
  action: string
  params: Record<string, unknown>
}

export interface MeshResponse<T = unknown> {
  ok: boolean
  data?: T
  error?: string
}

// ===== 注册请求 =====
export interface RegisterRequest {
  shortId: string
  sessionId: string
  pid: number
  role: NodeRole
  description: string
}

// ===== 发送请求 =====
export interface SendRequest {
  to: string
  message: string
  type?: MessageType
  replyTo?: string
  attachments?: ImageAttachmentManifest[]
}

// ===== Spawn 请求 =====
// 只负责喊名+两步握手，不再带 task——派活由主 cc 在收到 [bootstrap][ready] 后用 mesh send 下发。
export interface SpawnRequest {
  role?: NodeRole
  mode?: "tab" | "window"
  projectDir?: string
  agent?: string
  targetDevice?: string
  delegatorNodeId?: string
  description?: string
}

// ===== Delegate 请求 =====
export interface DelegateRequest {
  task: string
  role?: NodeRole
  mode?: "tab" | "window"
  timeout?: number       // 秒，默认 600
  projectDir?: string
}

// ===== Relay ↔ Hub 通信 =====
export interface RelayRegistration {
  relayId: string
  deviceId: string
  nodes: NodeIdentity[]
  connectedAt: string
}

export type UplinkMessage =
  | { type: "register"; relay: RelayRegistration; token?: string }
  | { type: "message"; msg: MeshMessage }
  | { type: "spawn"; requestId: string; targetDevice: string; spawn: SpawnRequest }
  | { type: "spawn_result"; requestId: string; targetRelayId: string; result: MeshResponse }
  | { type: "listener_status"; listeners: ListenerStatus[] }
  | { type: "ping" }
  | { type: "ledger"; relayId: string; events: LedgerUplinkEvent[] }   // 账本游标同步批（老 Hub 静默丢弃→部署顺序先 Hub 后 relay）

export type DownlinkMessage =
  | { type: "message"; msg: MeshMessage }
  | { type: "delivered"; msgId: string }
  | { type: "queued"; msgId: string }
  | { type: "devices"; devices: DeviceInventory[] }
  | { type: "spawn"; requestId: string; replyRelayId: string; spawn: SpawnRequest }
  | { type: "spawn_result"; requestId: string; result: MeshResponse }
  | { type: "pong" }
  | { type: "ledger_ack"; upToSeq: number }   // Hub 确认收到 srcSeq ≤ upToSeq 的账本事件，relay 据此推游标

// ===== 云端账本（Ledger）：relay 本地账本 → Hub 的游标同步事件 =====
// 设计：features/云端账本与调度接口-设计-2026-08-27.md §4。
// 单管道原则：一切账目（消息/quota_report/自定义 type）都是 message 事件，语义在 Hub 投影层分流。
export interface LedgerMessageEvent {
  kind: "message"
  msg: MeshMessage
  status: MessageStatus
  priority: MessagePriority
  srcSeq: number        // 该 relay 本地 messages.seq（游标对账依据）
}
export type LedgerUplinkEvent = LedgerMessageEvent   // 将来扩展 = 加 union 成员 + Hub 新投影

// ===== 派单接口层（IDispatcher，v1 Direct）=====
// 稳定点只有三处：pick/dispatch 两个动词 + pick.reason 必须记账。升级调度算法只换 pick() 实现。
export interface DispatchTask {
  title: string
  payload: string       // 发给席位的正文（注入终端的就是它，不带信封）
  to?: string           // v1（Direct）必填：显式目标节点——"两方直传"
  project?: string
  todoUid?: string      // P142 T2：关联的 cc-todo uid → meta._task.todoUid → 账本 tasks.todo_uid（归属联结）
  constraints?: { account?: string; deadline?: string; priority?: MessagePriority }
}
export interface SeatPick {
  nodeId: string
  seatId?: string
  accountFp?: string
  reason: string        // v1 恒 "explicit"；将来记"算法为什么这么派"，是调度改进的对照数据
}
export interface DispatchResult {
  taskId: string        // = 派单消息 id（云端 tasks 表主键）
  msgId: string
  pick: SeatPick
}
