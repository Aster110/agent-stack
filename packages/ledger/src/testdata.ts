/**
 * 测试夹具（非 .test.js，不会被 node --test 当测试跑）。
 *
 * 两个 quota envelope 是**真实探针输出**：用 scripts/quota-probe/fixtures/ 里的
 * 原始供应商 JSON 喂 probe_claude.parse_usage / probe_codex.parse_rate_limits
 * 生成，只把 account_id / host / probed_at 换成确定值以便断言。
 * 契约来源：scripts/quota-probe/quota_common.py::envelope()。
 */
import type { MeshMessage, LedgerMessageEvent } from "@cc-mesh/protocol"

/** claude 探针真实 envelope（三个窗口：5h 23% / 7d 61% / 7d_scoped 88%）。 */
export const CLAUDE_ENVELOPE = {
  schema_version: "1",
  source: "claude",
  host: "computer1",
  account_id: "claude-abc123def456",
  probed_at: "2026-08-27T10:15:00+08:00",
  status: "ok",
  plan_type: null,
  limits: [
    { kind: "5h", bucket: "session", model: null, used_percent: 23, window_minutes: 300, resets_at: "2026-08-26T08:00:00-07:00" },
    { kind: "7d", bucket: "weekly_all", model: null, used_percent: 61, window_minutes: 10080, resets_at: "2026-08-31T17:00:00-07:00" },
    { kind: "7d_scoped", bucket: "weekly_scoped", model: "Claude Opus 4.8", used_percent: 88, window_minutes: 10080, resets_at: "2026-08-31T17:00:00-07:00" },
  ],
  extra: { extra_usage: { is_enabled: true, used_credits: 1250 } },
}

/** codex 探针真实 envelope（7d 14% / 5h 42% / 7d_scoped 7%，plan_type=pro）。 */
export const CODEX_ENVELOPE = {
  schema_version: "1",
  source: "codex",
  host: "computer3",
  account_id: "chatgpt-9f8e7d6c5b4a",
  probed_at: "2026-08-27T10:20:00+08:00",
  status: "ok",
  plan_type: "pro",
  limits: [
    { kind: "7d", bucket: "codex", model: null, used_percent: 14, window_minutes: 10080, resets_at: "2026-09-01T07:13:29-07:00" },
    { kind: "5h", bucket: "codex_bengalfox", model: "GPT-5.3-Codex-Spark", used_percent: 42, window_minutes: 300, resets_at: "2026-08-26T16:17:48-07:00" },
    { kind: "7d_scoped", bucket: "codex_bengalfox", model: "GPT-5.3-Codex-Spark", used_percent: 7, window_minutes: 10080, resets_at: "2026-09-02T11:17:48-07:00" },
  ],
  extra: { credits: { has_credits: false, unlimited: false, balance: "0" }, reset_credits_available: 1 },
}

/** status=unavailable 的探针 envelope（limits 空，仍是合法账目）。 */
export const UNAVAILABLE_ENVELOPE = {
  schema_version: "1",
  source: "claude",
  host: "computer2",
  account_id: "claude-unknown",
  probed_at: "2026-08-27T10:25:00+08:00",
  status: "unavailable",
  plan_type: null,
  limits: [],
  reason: "no oauth token in keychain",
}

let seqCounter = 0

export function mkMsg(over: Partial<MeshMessage> & Pick<MeshMessage, "id">): MeshMessage {
  return {
    from: "macbook:cc-a1",
    to: "mini:cc-b2",
    type: "chat",
    payload: "hi",
    createdAt: "2026-08-27T10:00:00+08:00",
    ...over,
  } as MeshMessage
}

export function mkEvent(
  msg: MeshMessage,
  over: Partial<Omit<LedgerMessageEvent, "kind" | "msg">> = {},
): LedgerMessageEvent {
  return {
    kind: "message",
    msg,
    status: "delivered",
    priority: "normal",
    srcSeq: over.srcSeq ?? ++seqCounter,
    ...over,
  }
}

/** 构造一条 quota_report 消息（payload = envelope JSON 字符串，to=@ledger）。 */
export function mkQuotaMsg(
  id: string,
  envelope: unknown,
  over: { from?: string; createdAt?: string } = {},
): MeshMessage {
  return mkMsg({
    id,
    from: over.from ?? "macbook:quota",
    to: "@ledger",
    type: "quota_report" as MeshMessage["type"],
    payload: typeof envelope === "string" ? envelope : JSON.stringify(envelope),
    ...(over.createdAt ? { createdAt: over.createdAt } : {}),
  })
}
