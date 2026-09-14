import Database from "better-sqlite3"
import type { MeshMessage, MessageStatus, LocalNode } from "@cc-mesh/protocol"
import { now, normalizeDeliveryMode } from "@cc-mesh/protocol"
import path from "node:path"
import fs from "node:fs"

// 消息优先级（方案 B PR1：只存储、只透传，V1 无调度行为——为指挥平面预留 schema）。
// 2026-08-27 类型上移 protocol（Ledger 接缝要跨包用），此处 re-export 保持既有 import 路径不变。
export type { MessagePriority } from "@cc-mesh/protocol"
import type { MessagePriority } from "@cc-mesh/protocol"

// getInbox 返回的行——在 MeshMessage 之上带 priority（协议类型不动，priority 是 relay 本地关注点）。
export type StoredMessage = MeshMessage & { priority: MessagePriority }

// getMessagesSinceSeq 返回的行——账本同步要的三样全带齐：正文 + 落库时的 status/priority + 本机 seq。
export type LedgerRow = MeshMessage & { priority: MessagePriority; status: MessageStatus; seq: number }

/** meta → TEXT 列：undefined/null 存 NULL（不存字符串 "null"）；不可序列化对象降级 NULL，不让写库爆。 */
function serializeMeta(meta: MeshMessage["meta"]): string | null {
  if (meta == null) return null
  try {
    return JSON.stringify(meta)
  } catch {
    return null
  }
}

/** TEXT 列 → meta：NULL/坏 JSON/非对象一律 undefined（老库与手改容错，读取永不抛）。 */
function parseMeta(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

export class Store {
  private db: Database.Database

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? path.join(process.cwd(), "mesh.db")
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true })
    this.db = new Database(resolvedPath)
    this.db.pragma("journal_mode = WAL")
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        "from" TEXT NOT NULL,
        "to" TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT,
        reply_to TEXT,
        status TEXT DEFAULT 'submitted',
        created_at TEXT NOT NULL,
        delivered_at TEXT
      );

      CREATE TABLE IF NOT EXISTS nodes (
        node_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        short_id TEXT NOT NULL,
        session_id TEXT,
        pid INTEGER,
        role TEXT NOT NULL,
        description TEXT DEFAULT '',
        status TEXT DEFAULT 'idle',
        registered_at TEXT NOT NULL,
        last_seen TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS blackboard (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_by TEXT,
        updated_at TEXT DEFAULT (datetime('now','localtime'))
      );

      -- per-node ack 游标（单调推进，取 max；正文补拉的真相源是 messages.seq）
      CREATE TABLE IF NOT EXISTS ack_cursors (
        node_id TEXT PRIMARY KEY,
        last_ack_seq INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_messages_to ON messages("to");
      CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
    `)

    // 增量列迁移：CREATE TABLE IF NOT EXISTS 不会给已存在的老表加列，
    // 老库（relay 重启重载）需要 ALTER TABLE ADD COLUMN 补列。
    // ALTER ADD COLUMN 无 IF NOT EXISTS，重复执行会抛 duplicate column，
    // 用 pragma table_info 预检保证幂等。
    this.addColumnIfMissing("nodes", "delivery_mode", "TEXT")
    // identity_fp：inject 节点的身份指纹（session_name|cwd|前台进程）。
    // 老库无此列 → 补；老行为 NULL → 读取侧回落 undefined（那些节点只验活不验身份）。
    this.addColumnIfMissing("nodes", "identity_fp", "TEXT")
    // messages 游标 + 销账标记。seq 单调自增（游标补拉），acked 是审计/诚实终态轨。
    this.addColumnIfMissing("messages", "seq", "INTEGER")
    this.addColumnIfMissing("messages", "acked", "INTEGER NOT NULL DEFAULT 0")
    // priority：可选优先级列（方案 B PR1）。旧库/旧行 NULL → 读取侧 COALESCE 回退 'normal'。
    // addColumnIfMissing 用 table_info 预检保证幂等，容错重复启动的 "duplicate column"。
    this.addColumnIfMissing("messages", "priority", "TEXT")
    // meta：结构化元数据 JSON（如派单 _task 信封）。只进库/上账本，注入终端时不带。
    // 老库无此列 → addColumnIfMissing 补；旧行为 NULL → 读取侧回落 undefined。
    this.addColumnIfMissing("messages", "meta", "TEXT")
    // 老库回填：老消息 seq 为 NULL 会被 WHERE seq>since 永久漏掉，
    // 按 created_at + rowid 顺序回填单调 seq（一次性，幂等：只填 NULL 行）。
    this.backfillSeq()
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_seq ON messages(seq);`)
  }

  /** 回填老消息的 seq（NULL → 按 rowid 顺序赋单调值），保证游标可达。 */
  private backfillSeq(): void {
    const nullCount = (this.db.prepare("SELECT COUNT(*) AS c FROM messages WHERE seq IS NULL").get() as any).c as number
    if (nullCount === 0) return
    const base = (this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM messages").get() as any).m as number
    // 按 rowid 升序（= 物理插入顺序）回填，从 base+1 起递增
    const rows = this.db.prepare("SELECT rowid FROM messages WHERE seq IS NULL ORDER BY rowid ASC").all() as Array<{ rowid: number }>
    const upd = this.db.prepare("UPDATE messages SET seq = ? WHERE rowid = ?")
    let next = base + 1
    const tx = this.db.transaction(() => {
      for (const r of rows) {
        upd.run(next, r.rowid)
        next++
      }
    })
    tx()
  }

  /** 幂等加列：列已存在则跳过，避免 ALTER ADD COLUMN 抛 "duplicate column"。 */
  private addColumnIfMissing(table: string, column: string, decl: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (cols.some((c) => c.name === column)) return
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`)
  }

  // ===== Messages =====

  saveMessage(msg: MeshMessage, status: MessageStatus = "submitted", priority: MessagePriority = "normal"): void {
    // 单调自增 seq：id 是 TEXT PRIMARY KEY 不能用 AUTOINCREMENT，
    // 用 MAX(seq)+1 赋值（单机 better-sqlite3 同步执行，无并发竞态）。
    // INSERT OR REPLACE 同 id 也走这条 → seq 只增不退，不破坏游标单调性。
    const nextSeq = ((this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM messages").get() as any).m as number) + 1
    this.db.prepare(`
      INSERT OR REPLACE INTO messages (id, "from", "to", type, payload, reply_to, status, created_at, seq, acked, priority, meta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(msg.id, msg.from, msg.to, msg.type, msg.payload, msg.replyTo ?? null, status, msg.createdAt, nextSeq, priority, serializeMeta(msg.meta))
  }

  /**
   * 幂等落库（downlink 跨机着陆用）：按 id INSERT OR IGNORE——已存在则原样不动
   * （不 bump seq、不改 status/priority）。uplink 有 retry，重复投递不产生重复行。
   * 返回是否新插入（true=新行，false=已存在被忽略）。
   */
  saveMessageIfAbsent(msg: MeshMessage, status: MessageStatus = "submitted", priority: MessagePriority = "normal"): boolean {
    const nextSeq = ((this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM messages").get() as any).m as number) + 1
    const info = this.db.prepare(`
      INSERT OR IGNORE INTO messages (id, "from", "to", type, payload, reply_to, status, created_at, seq, acked, priority, meta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(msg.id, msg.from, msg.to, msg.type, msg.payload, msg.replyTo ?? null, status, msg.createdAt, nextSeq, priority, serializeMeta(msg.meta))
    return info.changes > 0
  }

  /**
   * 游标取数口（LedgerSync 专用）：WHERE seq > since ORDER BY seq ASC LIMIT n。
   * 与 getInbox 的区别：不按收件人过滤——账本要的是本机全量流水（含 @ledger 哨兵行、广播行）。
   * priority 旧行 NULL → COALESCE 'normal'；replyTo/meta 为空一律 undefined（上账本的 JSON 不带 null 噪音）。
   */
  getMessagesSinceSeq(since: number, limit: number): LedgerRow[] {
    const rows = this.db.prepare(`
      SELECT id, "from", "to", type, payload, reply_to as replyTo, created_at as createdAt, seq, status,
             COALESCE(priority, 'normal') as priority, meta
      FROM messages
      WHERE seq > ?
      ORDER BY seq ASC
      LIMIT ?
    `).all(since, limit) as any[]
    return rows.map((r) => {
      const row: LedgerRow = {
        id: r.id,
        from: r.from,
        to: r.to,
        type: r.type,
        payload: r.payload ?? "",
        createdAt: r.createdAt,
        seq: r.seq as number,
        status: r.status as MessageStatus,
        priority: r.priority as MessagePriority,
      }
      if (r.replyTo != null) row.replyTo = r.replyTo
      const meta = parseMeta(r.meta)
      if (meta) row.meta = meta
      return row
    })
  }

  updateMessageStatus(msgId: string, status: MessageStatus): void {
    const deliveredAt = status === "delivered" ? now() : null
    this.db.prepare(`
      UPDATE messages SET status = ?, delivered_at = COALESCE(?, delivered_at) WHERE id = ?
    `).run(status, deliveredAt, msgId)
  }

  // 游标式收件箱：WHERE seq>since（含广播 to='*'），ORDER BY seq ASC（单调升序补拉）。
  // since 缺省 0 → 返回全部；limit 缺省 1000（足够大，不再用 50 截断丢早消息）。
  // 向后兼容：旧 number 第二参不再支持，统一 opts 形态。
  getInbox(nodeId: string, opts: { since?: number; limit?: number } = {}): StoredMessage[] {
    const since = opts.since ?? 0
    const limit = opts.limit ?? 1000
    // priority 用 COALESCE 回退 'normal'（旧行 NULL 兼容——缺省语义 = normal）。
    // meta 一并返回：pull worker 靠它认派单信封（_task 的 title/project/pickReason），
    // 只有 inject 形态才看得到正文——pull 端点只有这一条路拿元数据。
    const rows = this.db.prepare(`
      SELECT id, "from", "to", type, payload, reply_to as replyTo, created_at as createdAt, seq,
             COALESCE(priority, 'normal') as priority, meta
      FROM messages
      WHERE ("to" = ? OR "to" = '*') AND seq > ?
      ORDER BY seq ASC
      LIMIT ?
    `).all(nodeId, since, limit) as any[]
    return rows.map((r) => {
      const meta = parseMeta(r.meta)
      if (r.replyTo == null) delete r.replyTo
      // 没 meta 就不带这个键（别给端点塞 meta:null 噪音）
      if (meta) return { ...r, meta } as StoredMessage
      delete r.meta
      return r as StoredMessage
    })
  }

  // ===== Ack 游标（per-node，单调推进） =====

  /** 推进 node 的 ack 游标到 upToSeq（取 max，防倒退），并把 seq<=upToSeq 的消息标 acked。 */
  ack(nodeId: string, upToSeq: number): void {
    const tx = this.db.transaction(() => {
      // 游标取 max：乱序/重复/倒退 ack 不把游标拉回
      this.db.prepare(`
        INSERT INTO ack_cursors (node_id, last_ack_seq) VALUES (?, ?)
        ON CONFLICT(node_id) DO UPDATE SET last_ack_seq = MAX(last_ack_seq, excluded.last_ack_seq)
      `).run(nodeId, upToSeq)
      // 标记销账：该 node 直发 + 广播，seq<=upToSeq 的置 acked=1
      this.db.prepare(`
        UPDATE messages SET acked = 1
        WHERE ("to" = ? OR "to" = '*') AND seq <= ? AND seq IS NOT NULL
      `).run(nodeId, upToSeq)
    })
    tx()
  }

  /**
   * 游标之后还有多少条**直发**给该节点的消息（wake sweeper 的对账判据）。
   *
   * 与 getInbox 的关键差别：**不含广播**（`to = '*'`）。
   * 架构定稿 G3 定案「广播不触发 wake」——把全网睡眠席位一起摇醒就是唤醒风暴，
   * 而广播语义本就是尽力而为。若这里把广播算进积压，sweeper 会替广播补出 wake 来，
   * 等于从后门推翻 G3。收件箱语义（看得见广播）与积压语义（只数直发）故意不同。
   *
   * 走 idx_messages_to 索引。
   */
  countDirectBacklog(nodeId: string, sinceSeq: number): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS n FROM messages WHERE "to" = ? AND seq > ?
    `).get(nodeId, sinceSeq) as any
    return row ? (row.n as number) : 0
  }

  /** 读 node 的当前 ack 游标（未 ack 过返回 0）。 */
  getAckCursor(nodeId: string): number {
    const row = this.db.prepare("SELECT last_ack_seq FROM ack_cursors WHERE node_id = ?").get(nodeId) as any
    return row ? (row.last_ack_seq as number) : 0
  }

  // ===== Nodes =====

  saveNode(node: LocalNode): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO nodes (node_id, device_id, short_id, session_id, pid, role, description, status, registered_at, last_seen, delivery_mode, identity_fp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      node.identity.nodeId,
      node.identity.deviceId,
      node.identity.shortId,
      node.sessionId,
      node.pid,
      node.identity.role,
      node.identity.description,
      node.status,
      now(),
      node.lastSeen,
      normalizeDeliveryMode(node.identity.deliveryMode),
      node.identityFp ?? null
    )
  }

  removeNode(nodeId: string): void {
    this.db.prepare("DELETE FROM nodes WHERE node_id = ?").run(nodeId)
  }

  updateHeartbeat(nodeId: string): void {
    this.db.prepare("UPDATE nodes SET last_seen = ? WHERE node_id = ?").run(now(), nodeId)
  }

  getAllNodes(): LocalNode[] {
    const rows = this.db.prepare("SELECT * FROM nodes").all() as any[]
    return rows.map(r => ({
      identity: {
        nodeId: r.node_id,
        deviceId: r.device_id,
        shortId: r.short_id,
        role: r.role,
        description: r.description ?? "",
        capabilities: [],
        deliveryMode: normalizeDeliveryMode(r.delivery_mode),
      },
      sessionId: r.session_id,
      pid: r.pid,
      lastSeen: r.last_seen,
      status: r.status,
      // 老行 identity_fp 为 NULL → undefined（那些节点只验活、不验身份）
      ...(r.identity_fp != null ? { identityFp: r.identity_fp as string } : {}),
    }))
  }

  getNode(nodeId: string): LocalNode | undefined {
    const r = this.db.prepare("SELECT * FROM nodes WHERE node_id = ?").get(nodeId) as any
    if (!r) return undefined
    return {
      identity: {
        nodeId: r.node_id,
        deviceId: r.device_id,
        shortId: r.short_id,
        role: r.role,
        description: r.description ?? "",
        capabilities: [],
        deliveryMode: normalizeDeliveryMode(r.delivery_mode),
      },
      sessionId: r.session_id,
      pid: r.pid,
      lastSeen: r.last_seen,
      status: r.status,
      ...(r.identity_fp != null ? { identityFp: r.identity_fp as string } : {}),
    }
  }

  // ===== Blackboard =====

  kvSet(key: string, value: string, updatedBy: string): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO blackboard (key, value, updated_by, updated_at) VALUES (?, ?, ?, datetime('now','localtime'))
    `).run(key, value, updatedBy)
  }

  kvGet(key: string): { value: string; updatedBy: string; updatedAt: string } | undefined {
    return this.db.prepare("SELECT value, updated_by as updatedBy, updated_at as updatedAt FROM blackboard WHERE key = ?").get(key) as any
  }

  kvList(): Array<{ key: string; value: string; updatedBy: string; updatedAt: string }> {
    return this.db.prepare("SELECT key, value, updated_by as updatedBy, updated_at as updatedAt FROM blackboard ORDER BY key").all() as any[]
  }

  kvDel(key: string): void {
    this.db.prepare("DELETE FROM blackboard WHERE key = ?").run(key)
  }

  close(): void {
    this.db.close()
  }
}
