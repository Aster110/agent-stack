/**
 * @cc-mesh/ledger — 云端账本（B1 存储 + B6 投影器 + B3 只读 API + 孤儿扫描）。
 *
 * 组件化承诺（设计 §3.1）：ledger 是独立包，hub 只是挂载方。将来要拆独立进程或换
 * 托管 DB，只动挂载处，§7 API 契约与 §4 同步协议不动。
 */
export { LedgerStore, DEFAULT_MESSAGE_LIMIT, FORWARDABLE_TABLES } from "./store.js"
export type {
  LedgerMessageInput, LedgerMessageRow, TaskInput, TaskRow,
  QuotaInput, QuotaRow, AccountInput, AccountRow,
  SeatInput, SeatRow, EventInput, EventRow, MessageFilter,
  ForwardableTable, ForwardRow, ForwardWatermarkRow,
  CcTodoChangeInput, CcTodoResolveInput, CcTodoOutcome,
  CcTodoItem, CcTodoChange, CcTodoApplyResult,
} from "./store.js"

export { Projector, parseQuotaEnvelope } from "./projector.js"
export type { IngestResult, ParsedQuota } from "./projector.js"

export { startLedgerHttp, buildAgentsView } from "./http.js"
export type { LedgerHttpOptions, LedgerHttpInstance, LedgerHttpExtension } from "./http.js"

export { sweep, deviceOf } from "./orphan.js"
export type { SweepResult } from "./orphan.js"

export {
  D1Forwarder, forwarderFromEnv, resolveIngestUrl, digestOf, packBatches,
  FORWARD_TABLES, STREAM_TABLES, SNAPSHOT_TABLES, RETENTION_TABLES,
  DEFAULT_FORWARD_BATCH, DEFAULT_FORWARD_INTERVAL_MS, DEFAULT_FORWARD_DEBOUNCE_MS,
  DEFAULT_DRAIN_DELAY_MS, DEFAULT_MIN_BACKOFF_MS, DEFAULT_MAX_BACKOFF_MS,
  DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_RETENTION_DAYS, DEFAULT_CLEANUP_INTERVAL_MS,
  DEFAULT_WATERMARK_SOURCE, DEFAULT_SNAPSHOT_MAX_ROWS,
} from "./forwarder.js"
export type {
  ForwardTable, ForwarderOptions, ForwarderEnvConfig, RetentionOptions,
  FlushResult, FlushReason, SnapshotResult, SnapshotReason, CleanupResult, CleanupReason,
  FetchLike, FetchInit, FetchResponseLike,
} from "./forwarder.js"
