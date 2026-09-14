/**
 * B6 投影器 — 消息流 → tasks / quota_snapshots / accounts 结构化视图。
 *
 * 设计：features/云端账本与调度接口-设计-2026-08-27.md §6.3。
 *
 * 三条铁律：
 * 1. **单管道多投影**：一切账目都是 message 事件，语义全在这里分流。要记新账 =
 *    加一个 type + 加一个投影分支，同步管道零改动。
 * 2. **幂等**：只有"这条消息是新插入的"才跑下游投影。跨机消息发收两端都会上报同一
 *    id，重放/重试也常见——否则会重复写 quota 快照、把已关的单打回 dispatched。
 * 3. **任务状态永远由投影推出**，agent 不直写。agent 忘了或挂了，账还是对的。
 */
import { LEDGER_SINK } from "@cc-mesh/protocol"
import type { LedgerUplinkEvent, MeshMessage } from "@cc-mesh/protocol"
import type { LedgerStore } from "./store.js"

export interface IngestResult {
  /** 本批 srcSeq 最大值（Hub 据此回 ledger_ack；空批 = 0）。 */
  maxSrcSeq: number
  /** 真正新插入 ledger_messages 的条数（重复上报不计）。 */
  inserted: number
}

export interface ParsedQuota {
  probedAt: string
  host: string | null
  source: string | null
  accountFp: string
  plan: string | null
  status: string | null
  pct5h: number | null
  pct7d: number | null
  resets5h: string | null
  resets7d: string | null
  envelope: string
}

const TASK_TITLE_MAX = 80
const DEFAULT_PICK_REASON = "unknown"

/**
 * 解析额度探针 envelope（契约见 scripts/quota-probe/quota_common.py::envelope）。
 * 解析不了就抛——调用方转成 events(kind=quota_parse_error)，绝不让一条脏账拖垮整批。
 *
 * pct_5h / pct_7d 拍平规则：同 kind 有多个桶（codex 多 limitId）时取 **used_percent 最大**
 * 的那个——闸门关心的是"最先撞墙的那扇窗"。resets_* 跟着被选中的桶走。
 * kind=7d_scoped（按模型的专项周限）**不并入 pct_7d**：语义不同，原文在 envelope 里可查。
 */
export function parseQuotaEnvelope(payload: string | null | undefined): ParsedQuota {
  if (typeof payload !== "string" || payload.trim().length === 0) {
    throw new Error("empty quota payload")
  }
  let env: unknown
  try {
    env = JSON.parse(payload)
  } catch (err) {
    throw new Error(`quota payload is not JSON: ${(err as Error).message}`)
  }
  if (env === null || typeof env !== "object" || Array.isArray(env)) {
    throw new Error("quota envelope must be a JSON object")
  }
  const e = env as Record<string, unknown>
  const accountFp = typeof e.account_id === "string" ? e.account_id.trim() : ""
  if (!accountFp) throw new Error("quota envelope missing account_id")
  const source = typeof e.source === "string" ? e.source : null
  if (!source) throw new Error("quota envelope missing source")

  const limits = Array.isArray(e.limits) ? (e.limits as unknown[]) : []
  const p5 = pickWorst(limits, "5h")
  const p7 = pickWorst(limits, "7d")

  return {
    probedAt: typeof e.probed_at === "string" ? e.probed_at : new Date().toISOString(),
    host: typeof e.host === "string" ? e.host : null,
    source,
    accountFp,
    plan: typeof e.plan_type === "string" ? e.plan_type : null,
    status: typeof e.status === "string" ? e.status : null,
    pct5h: p5.pct,
    pct7d: p7.pct,
    resets5h: p5.resetsAt,
    resets7d: p7.resetsAt,
    envelope: payload,
  }
}

function pickWorst(limits: unknown[], kind: string): { pct: number | null; resetsAt: string | null } {
  let pct: number | null = null
  let resetsAt: string | null = null
  for (const raw of limits) {
    if (raw === null || typeof raw !== "object") continue
    const lim = raw as Record<string, unknown>
    if (lim.kind !== kind) continue
    const v = Number(lim.used_percent)
    if (!Number.isFinite(v)) continue
    if (pct === null || v > pct) {
      pct = v
      resetsAt = typeof lim.resets_at === "string" ? lim.resets_at : null
    }
  }
  return { pct, resetsAt }
}

/** 从 msg.meta._task 抽派单信封（键名 camel/snake 都认，M2 定死前保持宽容）。 */
function taskEnvelope(msg: MeshMessage): Record<string, unknown> {
  const meta = msg.meta
  if (!meta || typeof meta !== "object") return {}
  const t = (meta as Record<string, unknown>)._task
  return t && typeof t === "object" && !Array.isArray(t) ? (t as Record<string, unknown>) : {}
}

function str(env: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = env[k]
    if (typeof v === "string" && v.length > 0) return v
  }
  return null
}

export class Projector {
  constructor(private readonly store: LedgerStore) {}

  /**
   * 消费一批上行账本事件。整批一个事务：中途抛错则全批回滚，Hub 不回 ack，
   * relay 游标不前进，下次重传——宁可重放（幂等）也不能假前进丢账。
   */
  ingest(events: LedgerUplinkEvent[], srcRelay: string): IngestResult {
    if (!Array.isArray(events) || events.length === 0) return { maxSrcSeq: 0, inserted: 0 }
    return this.store.transaction(() => {
      let maxSrcSeq = 0
      let inserted = 0
      for (const ev of events) {
        if (!ev || ev.kind !== "message" || !ev.msg || typeof ev.msg.id !== "string") continue
        const seq = Number(ev.srcSeq)
        if (Number.isFinite(seq) && seq > maxSrcSeq) maxSrcSeq = seq
        if (this.applyMessage(ev, srcRelay)) inserted++
      }
      return { maxSrcSeq, inserted }
    })
  }

  /** 返回是否新插入（重复上报 → false，下游投影全部跳过）。 */
  private applyMessage(ev: Extract<LedgerUplinkEvent, { kind: "message" }>, srcRelay: string): boolean {
    const msg = ev.msg
    const isNew = this.store.insertMessageIfAbsent({
      id: msg.id,
      from: msg.from,
      to: msg.to,
      type: msg.type,
      payload: msg.payload ?? null,
      meta: (msg.meta as Record<string, unknown> | undefined) ?? null,
      replyTo: msg.replyTo ?? null,
      priority: ev.priority ?? null,
      status: ev.status ?? null,
      createdAt: msg.createdAt,
      srcRelay,
      srcSeq: Number.isFinite(Number(ev.srcSeq)) ? Number(ev.srcSeq) : null,
    })
    if (!isNew) return false

    switch (msg.type) {
      case "task": this.projectTask(msg); break
      case "result": this.projectResult(msg); break
      default:
        // 自由字符串 type（quota_report 等）走哨兵语义；其余只进 ledger_messages。
        if (String(msg.type) === "quota_report" && msg.to === LEDGER_SINK) this.projectQuota(msg)
        break
    }
    return true
  }

  /** type=task → tasks 行 status=dispatched（+ 乱序补偿：回执先到的立刻关单）。 */
  private projectTask(msg: MeshMessage): void {
    const env = taskEnvelope(msg)
    const title = str(env, "title") ?? (msg.payload ?? "").slice(0, TASK_TITLE_MAX)
    this.store.upsertTask({
      taskId: msg.id,
      title,
      project: str(env, "project"),
      fromNode: msg.from,
      toNode: msg.to,
      seatId: str(env, "seatId", "seat_id"),
      accountFp: str(env, "accountFp", "account_fp"),
      pickReason: str(env, "pickReason", "pick_reason", "reason") ?? DEFAULT_PICK_REASON,
      status: "dispatched",
      createdAt: msg.createdAt,
      // P142 T2：派单 ↔ 个人 todo 归属。缺省 null（老单 / 未带 --todo 的派单）。
      todoUid: str(env, "todoUid", "todo_uid"),
    })
    // 乱序补偿：跨 relay 上行没有全局顺序，result 可能比 task 先到云端。
    // task 落地时回查已在账的 result，有就直接关单——否则这单会永远停在 dispatched，
    // 60s 后还会被孤儿扫描误标 orphaned。
    const existing = this.store.findResultsReplyingTo(msg.id)
    if (existing.length > 0) {
      const first = existing[0]
      this.store.markTaskReplied(msg.id, first.id, first.createdAt)
    }
  }

  /** type=result 且 replyTo 命中 task → replied。没命中就什么也不做，等 task 到了补偿。 */
  private projectResult(msg: MeshMessage): void {
    if (!msg.replyTo) return
    if (!this.store.getTask(msg.replyTo)) return
    this.store.markTaskReplied(msg.replyTo, msg.id, msg.createdAt)
  }

  /** type=quota_report 且 to=@ledger → quota_snapshots + accounts。解析失败只记事件，不崩。 */
  private projectQuota(msg: MeshMessage): void {
    let parsed: ParsedQuota
    try {
      parsed = parseQuotaEnvelope(msg.payload)
    } catch (err) {
      this.store.insertEvent({
        kind: "quota_parse_error",
        device: msg.from.split(":")[0] || null,
        nodeId: msg.from,
        detail: { msgId: msg.id, error: (err as Error).message },
        ts: msg.createdAt,
      })
      return
    }
    this.store.insertQuotaSnapshot({
      probedAt: parsed.probedAt,
      host: parsed.host,
      source: parsed.source,
      accountFp: parsed.accountFp,
      plan: parsed.plan,
      status: parsed.status,
      pct5h: parsed.pct5h,
      pct7d: parsed.pct7d,
      resets5h: parsed.resets5h,
      resets7d: parsed.resets7d,
      envelope: parsed.envelope,
    })
    // vendor 用探针的 source（codex|claude）；label/note 是人写的，COALESCE 保护不被覆盖。
    this.store.upsertAccount({
      accountFp: parsed.accountFp,
      vendor: parsed.source,
      plan: parsed.plan,
    })
  }
}
