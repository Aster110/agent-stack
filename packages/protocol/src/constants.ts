// 端口
export const RELAY_HTTP_PORT = 19800
export const RELAY_WS_PORT = 19801
export const HUB_WS_PORT = 19900
export const HUB_HTTP_PORT = 19901

// 路径
export const RELAY_BASE_URL = `http://localhost:${RELAY_HTTP_PORT}`
export const API_PREFIX = "/api"

// 超时
export const HEARTBEAT_INTERVAL_MS = 30_000   // 心跳间隔 30s
export const NODE_TIMEOUT_MS = 120_000        // 节点超时 2min
export const DELEGATE_TIMEOUT_S = 600         // delegate 默认 10min
export const SPAWN_WAIT_MS = 8_000            // spawn 后等待 cc 启动

// 设备 ID 配置文件路径
export const DEVICE_CONFIG_PATH = "~/.ccmesh/device.json"

// 云端账本（Ledger）
export const LEDGER_SINK = "@ledger"          // 记账哨兵收件人：router 只落库不投递
export const LEDGER_HTTP_PORT = HUB_HTTP_PORT // 账本读 API 与 Hub HTTP 同口（:19901）
export const LEDGER_SYNC_BATCH = 100          // 游标同步单批上限
export const LEDGER_SYNC_DEBOUNCE_MS = 2_000  // 写后合并窗口
export const LEDGER_SYNC_INTERVAL_MS = 30_000 // 兜底定时同步
