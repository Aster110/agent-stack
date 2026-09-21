/**
 * LedgerStore — 云端账本存储（SQLite WAL，六张表）。
 *
 * 设计：features/云端账本与调度接口-设计-2026-08-27.md §3.2。
 * 迁移纪律照抄 relay/src/store.ts：CREATE TABLE IF NOT EXISTS 打底 +
 * addColumnIfMissing（pragma table_info 预检）做增量列，重复启动幂等。
 *
 * 时间纪律（北极星 UU7）：
 * - 上游给的时间（created_at / probed_at / ts）**原样存**——探针和 relay 都已带时区偏移，
 *   改写会丢掉"那台机器当时几点"的排障信息。
 * - Hub 自己盖的 recorded_at 一律 UTC ISO8601。
 * - 排序/范围查询用的是额外的 *_utc 归一列（写入时 JS 算好）：带偏移的 ISO 串做字符串
 *   比较是错的（"10:00+08:00" > "03:00Z" 但两者同一时刻），不能直接 ORDER BY 原列。
 */
import Database from "better-sqlite3"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

// ===== 行类型 =====

export interface LedgerMessageInput {
  id: string
  from: string
  to: string
  type: string
  payload?: string | null
  meta?: Record<string, unknown> | null
  replyTo?: string | null
  priority?: string | null
  status?: string | null
  createdAt: string
  srcRelay: string
  srcSeq?: number | null
}

export interface LedgerMessageRow {
  id: string
  from: string
  to: string
  type: string
  payload: string | null
  meta: Record<string, unknown> | null
  replyTo: string | null
  priority: string | null
  status: string | null
  createdAt: string
  srcRelay: string
  srcSeq: number | null
  recordedAt: string
}

export interface TaskInput {
  taskId: string
  title: string | null
  project?: string | null
  fromNode: string | null
  toNode: string | null
  seatId?: string | null
  accountFp?: string | null
  pickReason: string
  status: string
  createdAt: string
  /** P142 T2：派单关联的个人 todo uid（来自 meta._task.todoUid）。 */
  todoUid?: string | null
}

export interface TaskRow {
  taskId: string
  title: string | null
  project: string | null
  fromNode: string | null
  toNode: string | null
  seatId: string | null
  accountFp: string | null
  pickReason: string | null
  status: string
  createdAt: string | null
  repliedAt: string | null
  replyMsgId: string | null
  todoUid: string | null
}

export interface QuotaInput {
  probedAt: string
  host: string | null
  source: string | null
  accountFp: string
  plan?: string | null
  status?: string | null
  pct5h: number | null
  pct7d: number | null
  resets5h: string | null
  resets7d: string | null
  envelope: string
}

export interface QuotaRow extends Omit<QuotaInput, "plan" | "status"> {
  id: number
  plan: string | null
  status: string | null
  recordedAt: string
}

export interface AccountInput {
  accountFp: string
  vendor?: string | null
  plan?: string | null
  label?: string | null
  note?: string | null
}

export interface AccountRow {
  accountFp: string
  vendor: string | null
  plan: string | null
  label: string | null
  note: string | null
  updatedAt: string
}

export interface SeatInput {
  seatId: string
  device: string
  agentKind?: string | null
  accountFp?: string | null
  capabilities?: unknown[] | Record<string, unknown> | null
  delivery?: string | null
  active?: boolean | null
}

export interface SeatRow {
  seatId: string
  device: string
  agentKind: string | null
  accountFp: string | null
  capabilities: unknown
  delivery: string | null
  active: boolean
  updatedAt: string
}

export interface EventInput {
  kind: string
  device?: string | null
  nodeId?: string | null
  detail?: unknown
  ts?: string
}

export interface EventRow {
  id: number
  ts: string
  kind: string
  device: string | null
  nodeId: string | null
  detail: unknown
  recordedAt: string
}

export interface MessageFilter {
  from?: string
  to?: string
  type?: string
  since?: string
  limit?: number
}

export const DEFAULT_MESSAGE_LIMIT = 100

/**
 * 允许被 D1Forwarder 按行游标读走的表（= 冷层要的全量六表）。
 *
 * 这是**白名单不是参数**：readRowsAfter 会把表名直接拼进 SQL（SQLite 不支持表名占位符），
 * 白名单是唯一的注入闸门。要加表，改这里，别改调用方。
 */
export const FORWARDABLE_TABLES = [
  "ledger_messages", "quota_snapshots", "tasks", "seats", "accounts", "events",
  "cc_todo_changes", "cc_todo_items",
] as const
export type ForwardableTable = (typeof FORWARDABLE_TABLES)[number]

/** 一行待转发的原样表行 + 它的本地行游标（rowid）。 */
export interface ForwardRow {
  /** 本地 rowid，游标推进的依据；**不会**出现在 row 里（不能污染发给 D1 的行对象）。 */
  cursor: number
  /** 表行原样：键 = DDL 列名（snake_case），值 = 原值（payload/envelope 全文不截断）。 */
  row: Record<string, unknown>
}

export interface ForwardWatermarkRow {
  table: string
  seq: number
  updatedAt: string
}

/** 内部游标列别名——取名够怪，保证不会撞上任何真实列。 */
const ROWID_ALIAS = "__mesh_rowid"

// ===== 工具 =====

/** ISO8601（可带任意时区偏移）→ UTC ISO；解析不了就用 fallback。 */
function toUtcIso(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? fallback : new Date(ms).toISOString()
}

function nowUtc(): string {
  return new Date().toISOString()
}

function jsonOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null
  try { return JSON.stringify(value) } catch { return null }
}

function parseJson<T>(raw: unknown): T | null {
  if (typeof raw !== "string" || raw.length === 0) return null
  try { return JSON.parse(raw) as T } catch { return null }
}

export interface CcTodoChangeInput {
  schemaVersion: 1
  uid: string
  legacyId: string
  category: "cc" | "aster"
  status: string
  project: string | null
  dependsOn: string[]
  createdAt: string
  updatedAt: string
  baseRevision: number
  opId: string
  originDevice: string
  contentDigest: string
  shareTitlePreview?: boolean
  titlePreview?: string
  // P142 T1：脱敏后的正文（缺省 = 客户端未上传/已省略）。contentPrivate=true 时以上正文一律不得出现。
  title?: string
  note?: string
  output?: string
  type?: string
  assignedTo?: string
  taskId?: string
  contentPrivate?: boolean
}

export interface CcTodoResolveInput extends CcTodoChangeInput { resolvesOpId: string }

export type CcTodoOutcome =
  | "applied" | "duplicate" | "tamper" | "converged" | "conflict" | "future" | "resolved"
  | "resolve_unknown" | "resolve_not_conflict" | "resolve_cross_uid"
  | "resolve_stale" | "resolve_future" | "resolve_consumed"

export interface CcTodoItem {
  uid: string
  legacyId: string
  category: "cc" | "aster"
  status: string
  project: string | null
  dependsOn: string[]
  createdAt: string
  updatedAt: string
  revision: number
  lastOpId: string
  originDevice: string
  contentDigest: string
  titlePreview?: string
  /** P142 T1：正文镜像（列为 NULL 时字段缺失，不回 null）；contentPrivate 只在为真时出现。 */
  title?: string
  note?: string
  output?: string
  type?: string
  assignedTo?: string
  taskId?: string
  contentPrivate?: boolean
  recordedAt: string
}

export interface CcTodoChange {
  seq: number
  uid: string
  opId: string
  baseRevision: number
  revision: number
  outcome: CcTodoOutcome
  bodyHash: string
  contentDigest: string
  originDevice: string
  changedAt: string
  detail: null | Record<string, unknown>
  recordedAt: string
}

export interface CcTodoApplyResult {
  outcome: CcTodoOutcome
  item: CcTodoItem | null
  change: CcTodoChange
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key]
      if (child !== undefined) out[key] = stableValue(child)
    }
    return out
  }
  return value
}

function canonicalHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex")}`
}

// ===== Store =====

export class LedgerStore {
  private db: Database.Database

  constructor(dbPath?: string) {
    const resolved = dbPath ?? path.join(process.cwd(), "ledger.db")
    if (resolved !== ":memory:") {
      fs.mkdirSync(path.dirname(resolved), { recursive: true })
    }
    this.db = new Database(resolved)
    if (resolved !== ":memory:") this.db.pragma("journal_mode = WAL")
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      -- 消息流水（聊天记录/派单/回报的全文账）
      CREATE TABLE IF NOT EXISTS ledger_messages (
        id TEXT PRIMARY KEY,
        "from" TEXT NOT NULL,
        "to" TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT,
        reply_to TEXT,
        priority TEXT,
        status TEXT,
        created_at TEXT NOT NULL,
        src_relay TEXT NOT NULL,
        src_seq INTEGER,
        recorded_at TEXT NOT NULL
      );

      -- 额度快照流水（投影自 type=quota_report 消息）
      CREATE TABLE IF NOT EXISTS quota_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        probed_at TEXT NOT NULL,
        host TEXT,
        source TEXT,
        account_fp TEXT NOT NULL,
        plan TEXT,
        status TEXT,
        pct_5h REAL,
        pct_7d REAL,
        resets_5h TEXT,
        resets_7d TEXT,
        envelope TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );

      -- 账号总账（人工/半自动维护；投影只补 vendor/plan，不覆盖人写的 label/note）
      CREATE TABLE IF NOT EXISTS accounts (
        account_fp TEXT PRIMARY KEY,
        vendor TEXT,
        plan TEXT,
        label TEXT,
        note TEXT,
        updated_at TEXT
      );

      -- 席位登记（机器 × 席位 × 账号）
      CREATE TABLE IF NOT EXISTS seats (
        seat_id TEXT PRIMARY KEY,
        device TEXT NOT NULL,
        agent_kind TEXT,
        account_fp TEXT,
        capabilities TEXT,
        delivery TEXT,
        active INTEGER DEFAULT 1,
        updated_at TEXT
      );

      -- 任务台账（永远由投影推出，不让 agent 直写）
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        title TEXT,
        project TEXT,
        from_node TEXT,
        to_node TEXT,
        seat_id TEXT,
        account_fp TEXT,
        pick_reason TEXT,
        status TEXT NOT NULL,
        created_at TEXT,
        replied_at TEXT,
        reply_msg_id TEXT
      );

      -- 机动事件（上下线/孤儿标记/解析失败……"当时为什么"的上下文）
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL,
        device TEXT,
        node_id TEXT,
        detail TEXT,
        recorded_at TEXT
      );

      CREATE TABLE IF NOT EXISTS cc_todo_items (
        uid TEXT PRIMARY KEY,
        legacy_id TEXT NOT NULL,
        category TEXT NOT NULL,
        status TEXT NOT NULL,
        project TEXT,
        depends_on TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL,
        last_op_id TEXT NOT NULL,
        origin_device TEXT NOT NULL,
        content_digest TEXT NOT NULL,
        title_preview TEXT,
        recorded_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cc_todo_changes (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        uid TEXT NOT NULL,
        op_id TEXT NOT NULL,
        base_revision INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        body_hash TEXT NOT NULL,
        content_digest TEXT NOT NULL,
        origin_device TEXT NOT NULL,
        changed_at TEXT NOT NULL,
        detail TEXT,
        recorded_at TEXT NOT NULL
      );

      -- 冷层转发游标（每表一行）。热层保留清理的唯一授权凭据：
      -- 只有 rowid <= seq 的行才算"已确认落 D1"，才谈得上删。
      CREATE TABLE IF NOT EXISTS forward_watermarks (
        table_name TEXT PRIMARY KEY,
        seq INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
    `)

    // 增量列（老库补列；ALTER ADD COLUMN 无 IF NOT EXISTS，靠 table_info 预检幂等）
    this.addColumnIfMissing("ledger_messages", "meta", "TEXT")            // 结构化元数据（派单 _task 信封）
    this.addColumnIfMissing("ledger_messages", "created_at_utc", "TEXT")  // 排序/范围查询归一列
    this.addColumnIfMissing("quota_snapshots", "probed_at_utc", "TEXT")
    this.addColumnIfMissing("tasks", "created_at_utc", "TEXT")
    this.addColumnIfMissing("events", "ts_utc", "TEXT")
    // P142 T2：派单 ↔ 个人 todo 归属（投影自 meta._task.todoUid；老单留空）
    this.addColumnIfMissing("tasks", "todo_uid", "TEXT")
    // P142 T1：个人 todo 正文上云（客户端脱敏后）。老库补列，旧行留空 = 尚未上传正文。
    this.addColumnIfMissing("cc_todo_items", "title", "TEXT")
    this.addColumnIfMissing("cc_todo_items", "note", "TEXT")
    this.addColumnIfMissing("cc_todo_items", "output", "TEXT")
    this.addColumnIfMissing("cc_todo_items", "type", "TEXT")
    this.addColumnIfMissing("cc_todo_items", "assigned_to", "TEXT")
    this.addColumnIfMissing("cc_todo_items", "task_id", "TEXT")
    this.addColumnIfMissing("cc_todo_items", "content_private", "INTEGER NOT NULL DEFAULT 0")

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_lm_created ON ledger_messages(created_at_utc);
      CREATE INDEX IF NOT EXISTS idx_lm_to ON ledger_messages("to");
      CREATE INDEX IF NOT EXISTS idx_lm_type ON ledger_messages(type);
      CREATE INDEX IF NOT EXISTS idx_lm_reply ON ledger_messages(reply_to);
      CREATE INDEX IF NOT EXISTS idx_qs_account ON quota_snapshots(account_fp, probed_at_utc);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_todo_uid ON tasks(todo_uid);
      CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind, ts_utc);
      CREATE INDEX IF NOT EXISTS idx_cc_todo_changes_uid ON cc_todo_changes(uid, seq);
      CREATE INDEX IF NOT EXISTS idx_cc_todo_changes_op ON cc_todo_changes(op_id, seq);
    `)
  }

  /** 幂等加列：列已存在则跳过，避免 ALTER ADD COLUMN 抛 "duplicate column"。 */
  addColumnIfMissing(table: string, column: string, decl: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (cols.some((c) => c.name === column)) return
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`)
  }

  // ===== 自省（测试/排障用） =====

  tableNames(): string[] {
    return (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
      .map((r) => r.name)
  }

  columnNames(table: string): string[] {
    return (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
  }

  journalMode(): string {
    return String(this.db.pragma("journal_mode", { simple: true })).toLowerCase()
  }

  /** 逻辑库大小（page_count × page_size）。清理后记日志用，:memory: 也有值。 */
  dbSizeBytes(): number {
    const pages = Number(this.db.pragma("page_count", { simple: true }))
    const size = Number(this.db.pragma("page_size", { simple: true }))
    return Number.isFinite(pages) && Number.isFinite(size) ? pages * size : 0
  }

  /**
   * 手动缩库。**任何定时器都不许调这个**（设计 §6 删除三纪律 ③）——
   * VACUUM 要整库重写 + 独占锁，几百 MB 的库能把 Hub 卡住十几秒。
   * 留给人在维护窗口手动跑。
   */
  vacuum(): void {
    this.db.exec("VACUUM")
  }

  /** 让投影器把一批写入包进单事务（部分失败整批回滚，游标不会假前进）。 */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  close(): void {
    try { this.db.close() } catch { /* 已关就算了 */ }
  }

  // ===== 冷层转发：行游标读取 + watermark =====

  /**
   * 按行游标读一批**原样表行**（升序、含全文）。
   *
   * 游标用 rowid 不用 src_seq：src_seq 是**发端 relay 的本地序号**，跨机必然撞号
   * （relay A 的 5 和 relay B 的 5 是两条不同的账）。拿它当全局游标 = 漏转发 + 误删。
   * rowid 是本库的插入序，单调唯一，才是"这行转过没有"的唯一可靠标记。
   */
  readRowsAfter(table: string, afterRowid: number, limit: number): ForwardRow[] {
    if (!(FORWARDABLE_TABLES as readonly string[]).includes(table)) {
      throw new Error(`[ledger] 表 ${table} 不在转发白名单里`)
    }
    const after = Number.isFinite(afterRowid) && afterRowid > 0 ? Math.floor(afterRowid) : 0
    const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 1
    const rows = this.db.prepare(
      `SELECT rowid AS ${ROWID_ALIAS}, * FROM ${table} WHERE rowid > ? ORDER BY rowid ASC LIMIT ?`,
    ).all(after, cap) as Array<Record<string, unknown>>
    return rows.map((raw) => {
      const row = { ...raw }
      const cursor = Number(row[ROWID_ALIAS])
      delete row[ROWID_ALIAS]         // 内部列绝不能混进发给 D1 的行对象（D1 那边没这列）
      return { cursor, row }
    })
  }

  /**
   * 整表读走（快照表全量同步用）。按 rowid 升序，保证同样的库内容产出同样的字节序列——
   * 转发侧靠这个做 digest 去重（内容没变就一个请求都不发，省云端写额度）。
   *
   * `hardLimit` 是防炸内存的护栏，不是业务上限：真撞上了说明这张"小表"已经不小，
   * 该改增量同步了，调用方会吼一嗓子。
   */
  readAllRows(table: string, hardLimit = 50_000): ForwardRow[] {
    return this.readRowsAfter(table, 0, hardLimit)
  }

  /** 某表已确认落 D1 的行游标（没转过 / 脏值 → 0）。 */
  getForwardWatermark(table: string): number {
    const row = this.db.prepare(`SELECT seq FROM forward_watermarks WHERE table_name = ?`).get(table) as
      | { seq: number } | undefined
    const n = Number(row?.seq)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  }

  /** 推进游标。取 max **只进不退**——倒退会把已删的老行段重新翻出来当新账。 */
  setForwardWatermark(table: string, seq: number): void {
    const next = Math.floor(seq)
    if (!Number.isFinite(next) || next < 0) return
    this.db.prepare(`
      INSERT INTO forward_watermarks (table_name, seq, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(table_name) DO UPDATE SET
        seq = MAX(forward_watermarks.seq, excluded.seq),
        updated_at = excluded.updated_at
    `).run(table, next, nowUtc())
  }

  listForwardWatermarks(): ForwardWatermarkRow[] {
    return (this.db.prepare(`SELECT * FROM forward_watermarks ORDER BY table_name ASC`).all() as any[])
      .map((r) => ({ table: r.table_name, seq: Number(r.seq), updatedAt: r.updated_at }))
  }

  /**
   * 热层保留清理——**全仓唯一一条 DELETE**，表名写死在 SQL 里。
   *
   * 三个"与"缺一不可（设计 §6 删除三纪律）：
   * ① 表只能是 ledger_messages（seats/accounts/tasks 是小表 + 调度训练数据，永不删）；
   * ② `rowid <= maxRowid`：只删已确认落 D1 的行，否则 relay 重传老 seq 段会把已删行
   *    复活成"新账"，云端多出幽灵消息；
   * ③ `recorded_at < before`：7 天热窗口内的行一律留着，mesh CLI 和主脑还在读。
   */
  pruneMessages(opts: { maxRowid: number; before: string }): number {
    const maxRowid = Math.floor(opts.maxRowid)
    if (!Number.isFinite(maxRowid) || maxRowid <= 0) return 0
    if (typeof opts.before !== "string" || opts.before.length === 0) return 0
    const info = this.db.prepare(
      `DELETE FROM ledger_messages WHERE rowid <= ? AND recorded_at < ?`,
    ).run(maxRowid, opts.before)
    return info.changes
  }

  // ===== cc-todo personal domain (separate from mesh dispatch tasks) =====

  getCcTodoItem(uid: string): CcTodoItem | null {
    const row = this.db.prepare(`SELECT * FROM cc_todo_items WHERE uid = ?`).get(uid)
    return row ? this.toCcTodoItem(row) : null
  }

  listCcTodoChanges(filter: { since?: number; limit?: number; uid?: string } = {}): CcTodoChange[] {
    const since = Number.isSafeInteger(filter.since) && (filter.since as number) >= 0 ? filter.since as number : 0
    const limit = Number.isSafeInteger(filter.limit) && (filter.limit as number) > 0 ? filter.limit as number : 500
    const rows = filter.uid
      ? this.db.prepare(`SELECT * FROM cc_todo_changes WHERE seq > ? AND uid = ? ORDER BY seq ASC LIMIT ?`)
        .all(since, filter.uid, limit)
      : this.db.prepare(`SELECT * FROM cc_todo_changes WHERE seq > ? ORDER BY seq ASC LIMIT ?`)
        .all(since, limit)
    return (rows as unknown[]).map((row) => this.toCcTodoChange(row))
  }

  applyCcTodoChange(input: CcTodoChangeInput): CcTodoApplyResult {
    return this.transaction(() => {
      const bodyHash = canonicalHash(input)
      const prior = this.db.prepare(`SELECT * FROM cc_todo_changes WHERE op_id = ? ORDER BY seq ASC LIMIT 1`)
        .get(input.opId) as any
      const current = this.getCcTodoItem(input.uid)
      if (prior) {
        const outcome: CcTodoOutcome = prior.body_hash === bodyHash ? "duplicate" : "tamper"
        const change = this.appendCcTodoChange(input, outcome, current?.revision ?? (Number(prior.revision) || 0), bodyHash, null)
        return { outcome, item: current, change }
      }

      const revision = current?.revision ?? 0
      if (input.baseRevision > revision) {
        const change = this.appendCcTodoChange(input, "future", revision, bodyHash, null)
        return { outcome: "future", item: current, change }
      }
      if (input.baseRevision < revision) {
        const outcome: CcTodoOutcome = current && this.ccTodoSnapshotMatches(current, input) ? "converged" : "conflict"
        const change = this.appendCcTodoChange(input, outcome, revision, bodyHash, null)
        return { outcome, item: current, change }
      }

      const item = this.writeCcTodoItem(input, revision + 1)
      const change = this.appendCcTodoChange(input, "applied", item.revision, bodyHash, null)
      return { outcome: "applied", item, change }
    })
  }

  resolveCcTodoConflict(input: CcTodoResolveInput): CcTodoApplyResult {
    return this.transaction(() => {
      const bodyHash = canonicalHash(input)
      const prior = this.db.prepare(`SELECT * FROM cc_todo_changes WHERE op_id = ? ORDER BY seq ASC LIMIT 1`)
        .get(input.opId) as any
      const requestedItem = this.getCcTodoItem(input.uid)
      if (prior) {
        const outcome: CcTodoOutcome = prior.body_hash === bodyHash ? "duplicate" : "tamper"
        const change = this.appendCcTodoChange(input, outcome, requestedItem?.revision ?? (Number(prior.revision) || 0),
          bodyHash, { resolvesOpId: input.resolvesOpId })
        return { outcome, item: requestedItem, change }
      }

      const referenced = this.db.prepare(`SELECT * FROM cc_todo_changes WHERE op_id = ? ORDER BY seq ASC LIMIT 1`)
        .get(input.resolvesOpId) as any
      const referencedItem = referenced ? this.getCcTodoItem(String(referenced.uid)) : null
      const auditRevision = referencedItem?.revision ?? requestedItem?.revision ?? 0
      let rejected: CcTodoOutcome | null = null
      if (!referenced) rejected = "resolve_unknown"
      else if (referenced.uid !== input.uid) rejected = "resolve_cross_uid"
      else if (referenced.outcome !== "conflict") rejected = "resolve_not_conflict"
      else {
        const consumed = (this.db.prepare(`SELECT detail FROM cc_todo_changes WHERE outcome = 'resolved'`).all() as any[])
          .some((row) => parseJson<{ resolvesOpId?: string }>(row.detail)?.resolvesOpId === input.resolvesOpId)
        if (consumed) rejected = "resolve_consumed"
        else if (input.baseRevision < auditRevision) rejected = "resolve_stale"
        else if (input.baseRevision > auditRevision) rejected = "resolve_future"
      }
      if (rejected) {
        const change = this.appendCcTodoChange(input, rejected, auditRevision, bodyHash,
          { resolvesOpId: input.resolvesOpId })
        return { outcome: rejected, item: requestedItem, change }
      }

      const item = this.writeCcTodoItem(input, auditRevision + 1)
      const change = this.appendCcTodoChange(input, "resolved", item.revision, bodyHash,
        { resolvesOpId: input.resolvesOpId })
      return { outcome: "resolved", item, change }
    })
  }

  private writeCcTodoItem(input: CcTodoChangeInput, revision: number): CcTodoItem {
    const recordedAt = nowUtc()
    this.db.prepare(`
      INSERT INTO cc_todo_items
        (uid, legacy_id, category, status, project, depends_on, created_at, updated_at, revision,
         last_op_id, origin_device, content_digest, title_preview, recorded_at,
         title, note, output, type, assigned_to, task_id, content_private)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(uid) DO UPDATE SET
        legacy_id=excluded.legacy_id, category=excluded.category, status=excluded.status,
        project=excluded.project, depends_on=excluded.depends_on, created_at=excluded.created_at,
        updated_at=excluded.updated_at, revision=excluded.revision, last_op_id=excluded.last_op_id,
        origin_device=excluded.origin_device, content_digest=excluded.content_digest,
        title_preview=excluded.title_preview, recorded_at=excluded.recorded_at,
        title=excluded.title, note=excluded.note, output=excluded.output, type=excluded.type,
        assigned_to=excluded.assigned_to, task_id=excluded.task_id, content_private=excluded.content_private
    `).run(input.uid, input.legacyId, input.category, input.status, input.project,
      JSON.stringify(input.dependsOn), input.createdAt, input.updatedAt, revision, input.opId,
      input.originDevice, input.contentDigest, input.titlePreview ?? null, recordedAt,
      input.title ?? null, input.note ?? null, input.output ?? null, input.type ?? null,
      input.assignedTo ?? null, input.taskId ?? null, input.contentPrivate === true ? 1 : 0)
    return this.getCcTodoItem(input.uid) as CcTodoItem
  }

  private appendCcTodoChange(
    input: CcTodoChangeInput,
    outcome: CcTodoOutcome,
    revision: number,
    bodyHash: string,
    detail: Record<string, unknown> | null,
  ): CcTodoChange {
    const recordedAt = nowUtc()
    const info = this.db.prepare(`
      INSERT INTO cc_todo_changes
        (uid, op_id, base_revision, revision, outcome, body_hash, content_digest, origin_device,
         changed_at, detail, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.uid, input.opId, input.baseRevision, revision, outcome, bodyHash,
      input.contentDigest, input.originDevice, input.updatedAt, jsonOrNull(detail), recordedAt)
    const row = this.db.prepare(`SELECT * FROM cc_todo_changes WHERE seq = ?`).get(Number(info.lastInsertRowid))
    return this.toCcTodoChange(row)
  }

  private ccTodoSnapshotMatches(item: CcTodoItem, input: CcTodoChangeInput): boolean {
    const shape = (x: CcTodoItem | CcTodoChangeInput) => ({
      legacyId: x.legacyId, category: x.category, status: x.status, project: x.project,
      dependsOn: x.dependsOn, createdAt: x.createdAt, contentDigest: x.contentDigest,
      titlePreview: x.titlePreview,
      // P142 T1：正文也参与"是否已收敛"判定——正文不同就是真冲突，不能算 converged
      title: x.title, note: x.note, output: x.output, type: x.type,
      assignedTo: x.assignedTo, taskId: x.taskId, contentPrivate: x.contentPrivate === true,
    })
    return canonicalHash(shape(item)) === canonicalHash(shape(input))
  }

  private toCcTodoItem(raw: any): CcTodoItem {
    const item: CcTodoItem = {
      uid: raw.uid, legacyId: raw.legacy_id, category: raw.category, status: raw.status,
      project: raw.project ?? null, dependsOn: parseJson<string[]>(raw.depends_on) ?? [],
      createdAt: raw.created_at, updatedAt: raw.updated_at, revision: Number(raw.revision),
      lastOpId: raw.last_op_id, originDevice: raw.origin_device, contentDigest: raw.content_digest,
      recordedAt: raw.recorded_at,
    }
    if (raw.title_preview !== null && raw.title_preview !== undefined) item.titlePreview = raw.title_preview
    // 正文列：NULL = 未上传/已省略 → 字段缺失（与 titlePreview 同一约定，别回 null 让客户端误判"清空"）
    const content: Array<[keyof CcTodoItem, string]> = [
      ["title", "title"], ["note", "note"], ["output", "output"], ["type", "type"],
      ["assignedTo", "assigned_to"], ["taskId", "task_id"],
    ]
    for (const [key, col] of content) {
      const v = raw[col]
      if (typeof v === "string" && v.length > 0) (item as unknown as Record<string, unknown>)[key] = v
    }
    if (Number(raw.content_private) === 1) item.contentPrivate = true
    return item
  }

  private toCcTodoChange(raw: any): CcTodoChange {
    return {
      seq: Number(raw.seq), uid: raw.uid, opId: raw.op_id, baseRevision: Number(raw.base_revision),
      revision: Number(raw.revision), outcome: raw.outcome, bodyHash: raw.body_hash,
      contentDigest: raw.content_digest, originDevice: raw.origin_device, changedAt: raw.changed_at,
      detail: parseJson<Record<string, unknown>>(raw.detail), recordedAt: raw.recorded_at,
    }
  }

  // ===== ledger_messages =====

  /** 幂等落库：id 已存在则原样不动（跨机两端上报同一 id 天然去重）。返回是否新插入。 */
  insertMessageIfAbsent(input: LedgerMessageInput): boolean {
    const recordedAt = nowUtc()
    const info = this.db.prepare(`
      INSERT OR IGNORE INTO ledger_messages
        (id, "from", "to", type, payload, meta, reply_to, priority, status,
         created_at, created_at_utc, src_relay, src_seq, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id, input.from, input.to, input.type,
      input.payload ?? null,
      jsonOrNull(input.meta),
      input.replyTo ?? null,
      input.priority ?? null,
      input.status ?? null,
      input.createdAt,
      toUtcIso(input.createdAt, recordedAt),
      input.srcRelay,
      input.srcSeq ?? null,
      recordedAt,
    )
    return info.changes > 0
  }

  getMessage(id: string): LedgerMessageRow | null {
    const row = this.db.prepare(`SELECT * FROM ledger_messages WHERE id = ?`).get(id)
    return row ? this.toMessageRow(row) : null
  }

  listMessages(filter: MessageFilter): LedgerMessageRow[] {
    const where: string[] = []
    const args: unknown[] = []
    if (filter.from) { where.push(`"from" = ?`); args.push(filter.from) }
    if (filter.to) { where.push(`"to" = ?`); args.push(filter.to) }
    if (filter.type) { where.push(`type = ?`); args.push(filter.type) }
    if (filter.since) { where.push(`created_at_utc >= ?`); args.push(toUtcIso(filter.since, filter.since)) }
    const limit = Number.isFinite(filter.limit) && (filter.limit as number) > 0
      ? Math.floor(filter.limit as number)
      : DEFAULT_MESSAGE_LIMIT
    const sql = `SELECT * FROM ledger_messages
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY created_at_utc DESC, rowid DESC LIMIT ?`
    return (this.db.prepare(sql).all(...args, limit) as unknown[]).map((r) => this.toMessageRow(r))
  }

  /** 乱序补偿用：找所有 type=result 且 reply_to 命中某 task 的回执（早到晚序）。 */
  findResultsReplyingTo(taskId: string): LedgerMessageRow[] {
    const rows = this.db.prepare(
      `SELECT * FROM ledger_messages WHERE reply_to = ? AND type = 'result' ORDER BY created_at_utc ASC, rowid ASC`,
    ).all(taskId) as unknown[]
    return rows.map((r) => this.toMessageRow(r))
  }

  private toMessageRow(raw: any): LedgerMessageRow {
    return {
      id: raw.id,
      from: raw.from,
      to: raw.to,
      type: raw.type,
      payload: raw.payload ?? null,
      meta: parseJson<Record<string, unknown>>(raw.meta),
      replyTo: raw.reply_to ?? null,
      priority: raw.priority ?? null,
      status: raw.status ?? null,
      createdAt: raw.created_at,
      srcRelay: raw.src_relay,
      srcSeq: raw.src_seq ?? null,
      recordedAt: raw.recorded_at,
    }
  }

  // ===== tasks =====

  /**
   * 建/更任务行。冲突时**只更元数据，不碰 status/replied_\***——
   * 重放派单事件不得把已关的单打回 dispatched（"不靠自觉"原则的存储侧保障）。
   */
  upsertTask(input: TaskInput): void {
    this.db.prepare(`
      INSERT INTO tasks (task_id, title, project, from_node, to_node, seat_id, account_fp,
                         pick_reason, status, created_at, created_at_utc, todo_uid)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        title = excluded.title,
        project = excluded.project,
        from_node = excluded.from_node,
        to_node = excluded.to_node,
        seat_id = excluded.seat_id,
        account_fp = excluded.account_fp,
        pick_reason = excluded.pick_reason,
        created_at = excluded.created_at,
        created_at_utc = excluded.created_at_utc,
        todo_uid = excluded.todo_uid
    `).run(
      input.taskId, input.title, input.project ?? null, input.fromNode, input.toNode,
      input.seatId ?? null, input.accountFp ?? null, input.pickReason, input.status,
      input.createdAt, toUtcIso(input.createdAt, nowUtc()), input.todoUid ?? null,
    )
  }

  markTaskReplied(taskId: string, replyMsgId: string, repliedAt: string): boolean {
    const info = this.db.prepare(
      `UPDATE tasks SET status = 'replied', replied_at = ?, reply_msg_id = ? WHERE task_id = ?`,
    ).run(repliedAt, replyMsgId, taskId)
    return info.changes > 0
  }

  findTaskReplies(taskId: string): LedgerMessageRow[] {
    return (this.db.prepare(`SELECT * FROM ledger_messages WHERE reply_to = ? AND type IN ('system','result') ORDER BY created_at_utc ASC, rowid ASC`).all(taskId) as unknown[]).map((r) => this.toMessageRow(r))
  }

  legacyTimeoutTaskIds(): string[] {
    return (this.db.prepare(`SELECT DISTINCT reply_to AS id FROM ledger_messages WHERE payload LIKE '[failed]%reason=timeout%' AND reply_to IS NOT NULL`).all() as Array<{ id: string }>).map((r) => r.id)
  }

  projectTaskState(taskId: string, state: string, replyMsgId: string | null, repliedAt: string | null): void {
    this.db.prepare(`UPDATE tasks SET status = ?, reply_msg_id = ?, replied_at = ? WHERE task_id = ?`).run(state, replyMsgId, repliedAt, taskId)
  }

  markTaskOrphaned(taskId: string): boolean {
    const info = this.db.prepare(
      `UPDATE tasks SET status = 'orphaned' WHERE task_id = ? AND status = 'dispatched'`,
    ).run(taskId)
    return info.changes > 0
  }

  getTask(taskId: string): TaskRow | null {
    const row = this.db.prepare(`SELECT * FROM tasks WHERE task_id = ?`).get(taskId)
    return row ? toTaskRow(row) : null
  }

  listTasks(filter: { status?: string; project?: string; since?: string; limit?: number; todoUid?: string }): TaskRow[] {
    const where: string[] = []
    const args: unknown[] = []
    if (filter.status) { where.push(`status = ?`); args.push(filter.status) }
    if (filter.project) { where.push(`project = ?`); args.push(filter.project) }
    if (filter.todoUid) { where.push(`todo_uid = ?`); args.push(filter.todoUid) }
    if (filter.since) { where.push(`created_at_utc >= ?`); args.push(toUtcIso(filter.since, filter.since)) }
    const limit = Number.isFinite(filter.limit) && (filter.limit as number) > 0 ? Math.floor(filter.limit as number) : 500
    const sql = `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY created_at_utc DESC, rowid DESC LIMIT ?`
    return (this.db.prepare(sql).all(...args, limit) as unknown[]).map(toTaskRow)
  }

  // ===== quota_snapshots =====

  insertQuotaSnapshot(input: QuotaInput): number {
    const recordedAt = nowUtc()
    const info = this.db.prepare(`
      INSERT INTO quota_snapshots
        (probed_at, probed_at_utc, host, source, account_fp, plan, status,
         pct_5h, pct_7d, resets_5h, resets_7d, envelope, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.probedAt, toUtcIso(input.probedAt, recordedAt), input.host, input.source,
      input.accountFp, input.plan ?? null, input.status ?? null,
      input.pct5h, input.pct7d, input.resets5h, input.resets7d, input.envelope, recordedAt,
    )
    return Number(info.lastInsertRowid)
  }

  /** 每账号最新一条（可按 account 收窄）。 */
  latestQuota(account?: string): QuotaRow[] {
    const args: unknown[] = []
    const extra = account ? "AND q.account_fp = ?" : ""
    if (account) args.push(account)
    const sql = `
      SELECT * FROM quota_snapshots q
      WHERE q.id = (
        SELECT id FROM quota_snapshots q2
        WHERE q2.account_fp = q.account_fp
        ORDER BY q2.probed_at_utc DESC, q2.id DESC LIMIT 1
      )
      ${extra}
      ORDER BY q.account_fp ASC`
    return (this.db.prepare(sql).all(...args) as unknown[]).map(toQuotaRow)
  }

  listQuotaHistory(filter: { account?: string; since?: string; limit?: number }): QuotaRow[] {
    const where: string[] = []
    const args: unknown[] = []
    if (filter.account) { where.push(`account_fp = ?`); args.push(filter.account) }
    if (filter.since) { where.push(`probed_at_utc >= ?`); args.push(toUtcIso(filter.since, filter.since)) }
    const limit = Number.isFinite(filter.limit) && (filter.limit as number) > 0 ? Math.floor(filter.limit as number) : 500
    const sql = `SELECT * FROM quota_snapshots ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY probed_at_utc DESC, id DESC LIMIT ?`
    return (this.db.prepare(sql).all(...args, limit) as unknown[]).map(toQuotaRow)
  }

  // ===== accounts =====

  /** COALESCE 合并：只覆盖本次给了值的字段——投影器补 vendor/plan 时不会抹掉人写的 label/note。 */
  upsertAccount(input: AccountInput): void {
    this.db.prepare(`
      INSERT INTO accounts (account_fp, vendor, plan, label, note, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_fp) DO UPDATE SET
        vendor = COALESCE(excluded.vendor, accounts.vendor),
        plan = COALESCE(excluded.plan, accounts.plan),
        label = COALESCE(excluded.label, accounts.label),
        note = COALESCE(excluded.note, accounts.note),
        updated_at = excluded.updated_at
    `).run(input.accountFp, input.vendor ?? null, input.plan ?? null, input.label ?? null, input.note ?? null, nowUtc())
  }

  listAccounts(): AccountRow[] {
    return (this.db.prepare(`SELECT * FROM accounts ORDER BY account_fp ASC`).all() as any[]).map((r) => ({
      accountFp: r.account_fp,
      vendor: r.vendor ?? null,
      plan: r.plan ?? null,
      label: r.label ?? null,
      note: r.note ?? null,
      updatedAt: r.updated_at,
    }))
  }

  // ===== seats =====

  upsertSeat(input: SeatInput): void {
    this.db.prepare(`
      INSERT INTO seats (seat_id, device, agent_kind, account_fp, capabilities, delivery, active, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(seat_id) DO UPDATE SET
        device = COALESCE(excluded.device, seats.device),
        agent_kind = COALESCE(excluded.agent_kind, seats.agent_kind),
        account_fp = COALESCE(excluded.account_fp, seats.account_fp),
        capabilities = COALESCE(excluded.capabilities, seats.capabilities),
        delivery = COALESCE(excluded.delivery, seats.delivery),
        active = COALESCE(excluded.active, seats.active),
        updated_at = excluded.updated_at
    `).run(
      input.seatId, input.device, input.agentKind ?? null, input.accountFp ?? null,
      jsonOrNull(input.capabilities), input.delivery ?? null,
      input.active === undefined || input.active === null ? null : (input.active ? 1 : 0),
      nowUtc(),
    )
  }

  listSeats(): SeatRow[] {
    return (this.db.prepare(`SELECT * FROM seats ORDER BY seat_id ASC`).all() as any[]).map((r) => ({
      seatId: r.seat_id,
      device: r.device,
      agentKind: r.agent_kind ?? null,
      accountFp: r.account_fp ?? null,
      capabilities: parseJson<unknown>(r.capabilities),
      delivery: r.delivery ?? null,
      active: r.active === null || r.active === undefined ? true : r.active !== 0,
      updatedAt: r.updated_at,
    }))
  }

  // ===== events =====

  insertEvent(input: EventInput): number {
    const recordedAt = nowUtc()
    const ts = input.ts ?? recordedAt
    const info = this.db.prepare(`
      INSERT INTO events (ts, ts_utc, kind, device, node_id, detail, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(ts, toUtcIso(ts, recordedAt), input.kind, input.device ?? null, input.nodeId ?? null,
      jsonOrNull(input.detail), recordedAt)
    return Number(info.lastInsertRowid)
  }

  listEvents(filter: { kind?: string; since?: string; limit?: number }): EventRow[] {
    const where: string[] = []
    const args: unknown[] = []
    if (filter.kind) { where.push(`kind = ?`); args.push(filter.kind) }
    if (filter.since) { where.push(`ts_utc >= ?`); args.push(toUtcIso(filter.since, filter.since)) }
    const limit = Number.isFinite(filter.limit) && (filter.limit as number) > 0 ? Math.floor(filter.limit as number) : 500
    const sql = `SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY ts_utc DESC, id DESC LIMIT ?`
    return (this.db.prepare(sql).all(...args, limit) as any[]).map((r) => ({
      id: r.id,
      ts: r.ts,
      kind: r.kind,
      device: r.device ?? null,
      nodeId: r.node_id ?? null,
      detail: parseJson<unknown>(r.detail),
      recordedAt: r.recorded_at,
    }))
  }
}

function toTaskRow(r: any): TaskRow {
  return {
    taskId: r.task_id,
    title: r.title ?? null,
    project: r.project ?? null,
    fromNode: r.from_node ?? null,
    toNode: r.to_node ?? null,
    seatId: r.seat_id ?? null,
    accountFp: r.account_fp ?? null,
    pickReason: r.pick_reason ?? null,
    status: r.status,
    createdAt: r.created_at ?? null,
    repliedAt: r.replied_at ?? null,
    replyMsgId: r.reply_msg_id ?? null,
    todoUid: r.todo_uid ?? null,
  }
}

function toQuotaRow(r: any): QuotaRow {
  return {
    id: r.id,
    probedAt: r.probed_at,
    host: r.host ?? null,
    source: r.source ?? null,
    accountFp: r.account_fp,
    plan: r.plan ?? null,
    status: r.status ?? null,
    pct5h: r.pct_5h ?? null,
    pct7d: r.pct_7d ?? null,
    resets5h: r.resets_5h ?? null,
    resets7d: r.resets_7d ?? null,
    envelope: r.envelope,
    recordedAt: r.recorded_at,
  }
}
