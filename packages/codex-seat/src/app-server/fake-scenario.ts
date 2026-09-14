/**
 * ============================================================================
 * FakeAppServerClient 的剧本（scenario）格式 —— **Lane B/C 只读，不改**
 * ============================================================================
 *
 * 用途：`CODEX_SEAT_ENGINE=fake` + `CODEX_SEAT_FAKE_SCENARIO=<json|路径>` 让 e2e/单测
 * 用内存假引擎跑，不烧模型额度、不依赖 GUI 会话。E16（未知 ServerRequest）与所有需要
 * "引擎按我说的时序出事件"的用例都靠它。
 *
 * `CODEX_SEAT_FAKE_SCENARIO` 的值：`{` 开头当**内联 JSON**，否则当**文件路径**。
 * 解析失败一律抛（不静默退回默认——否则 case 会假绿）。字段全部可省，省了走默认值。
 *
 * ---------------------------------------------------------------------------
 * 顶层
 * ---------------------------------------------------------------------------
 * {
 *   "version": 1,
 *   "initializeMs": 5,              // start() 的假握手耗时（也是 EngineInfo.initializeMs）
 *   "codexHome": "/tmp/fake-codex-home",
 *   "codexVersion": "codex-cli 0.0.0-fake",
 *   "failStart": null,              // 字符串 → start() 抛这个消息
 *   "threadStartMs": 1,             // thread/start 的假耗时（ThreadInfo.opMs）
 *   "threadResumeMs": 1,
 *   "failThreadStart": null,        // 字符串 → threadStart() 抛
 *   "failThreadResume": null,
 *   "loadedThreads": [],            // 额外塞进 loadedThreads() 的 id（真开的 thread 自动在内）
 *   "rateLimits": { …RateLimitsSnapshot… },
 *   "account": { "type": "chatgpt", "email": null, "planType": "pro" },
 *   "compact": { "ms": 1, "ok": true, "error": null },
 *   "turns": [ …TurnScript… ],      // 按序消费；带 match 的优先按内容命中
 *   "defaultTurn": { …TurnScript… } // turns 用完/没命中时用它
 * }
 *
 * ---------------------------------------------------------------------------
 * TurnScript：一轮的时间线
 * ---------------------------------------------------------------------------
 * {
 *   "match": { "textIncludes": "whoami" },  // 可选。命中的脚本优先于顺序消费
 *   "startedAfterMs": 1,        // 多久后发 turn/started（null = 永不发，等价 drop-turn-started）
 *   "steps": [                  // 每步的 afterMs 是**相对上一步**的延迟，从 started 时刻起算
 *     { "afterMs": 1, "event": { "type": "item.completed", "itemType": "mcpToolCall",
 *                                "server": "node_repl", "tool": "js", "status": "completed" } },
 *     { "afterMs": 1, "event": { "type": "token.usage", "usage": { …ThreadTokenUsage… } } },
 *     { "afterMs": 0, "serverRequest": { "method": "x/unknown/request" } },
 *     { "afterMs": 0, "crash": "fake engine died" }   // 连接丢失：engine.lost + 在途 turn 变 lost
 *   ],
 *   "waitForServerRequestReply": false,  // true = 有 ServerRequest 没被应答就不许收尾
 *                                        //        （E16 红门：drop-serverrequest-default 下挂到超时）
 *   "completeAfterMs": 2,       // 最后一步之后多久发 turn/completed
 *   "outcome": { "status": "completed", "finalText": "…" }
 *               // 或 { "status": "failed", "message": "…" } / { "status": "interrupted" }
 * }
 *
 * event 里的 threadId / turnId 由假引擎自己填，剧本不用写。
 * 可用的 event.type：item.completed / token.usage / thread.status / turn.error /
 *                    mcp.startup / rate.limits / context.compacted
 *
 * ---------------------------------------------------------------------------
 * 与故障注入的关系（`CODEX_SEAT_ALLOW_FAULTS=1` 才生效）
 * ---------------------------------------------------------------------------
 * - `drop-turn-started`          → 无论剧本怎么写都不发 turn/started
 * - `drop-serverrequest-default` → 未知 ServerRequest 不应答（表里的照答）
 * - `engine-down`                → start() 直接抛
 * - `fail-thread-start`          → threadStart() 直接抛
 */
import type { AccountInfo, RateLimitsSnapshot, ThreadTokenUsage } from "../contracts.js"
import fs from "node:fs"

export interface FakeMatch {
  textIncludes?: string
}

export type FakeEventSpec =
  | { type: "item.completed"; itemType: string; server?: string | null; tool?: string | null; status?: string | null }
  | { type: "token.usage"; usage: ThreadTokenUsage }
  | { type: "thread.status"; status: "notLoaded" | "idle" | "active" | "systemError" }
  | { type: "turn.error"; message: string; willRetry?: boolean }
  | { type: "mcp.startup"; name: string; status: string }
  | { type: "rate.limits"; snapshot: RateLimitsSnapshot }
  | { type: "context.compacted" }

export type FakeTurnStep =
  | { afterMs: number; event: FakeEventSpec }
  | { afterMs: number; serverRequest: { method: string; id?: number } }
  | { afterMs: number; crash: string }

export type FakeTurnOutcome =
  | { status: "completed"; finalText?: string | null }
  | { status: "failed"; message?: string }
  | { status: "interrupted" }

export interface FakeTurnScript {
  match: FakeMatch | null
  startedAfterMs: number | null
  steps: FakeTurnStep[]
  waitForServerRequestReply: boolean
  completeAfterMs: number
  outcome: FakeTurnOutcome
}

/** 剧本是人手写的 JSON：每个字段都可省。这是 `FakeScenario` 的深度可选版。 */
export interface FakeTurnScriptInput {
  match?: FakeMatch | null
  startedAfterMs?: number | null
  steps?: FakeTurnStep[]
  waitForServerRequestReply?: boolean
  completeAfterMs?: number
  outcome?: FakeTurnOutcome
}

export interface FakeScenarioInput {
  version?: 1
  initializeMs?: number
  codexHome?: string
  codexVersion?: string | null
  failStart?: string | null
  threadStartMs?: number
  threadResumeMs?: number
  failThreadStart?: string | null
  failThreadResume?: string | null
  loadedThreads?: string[]
  rateLimits?: Partial<RateLimitsSnapshot>
  account?: Partial<AccountInfo>
  compact?: { ms?: number; ok?: boolean; error?: string | null }
  turns?: FakeTurnScriptInput[]
  defaultTurn?: FakeTurnScriptInput
  /** 未知字段照单收下（前向兼容） */
  [k: string]: unknown
}

export interface FakeScenario {
  version: 1
  initializeMs: number
  codexHome: string
  codexVersion: string | null
  failStart: string | null
  threadStartMs: number
  threadResumeMs: number
  failThreadStart: string | null
  failThreadResume: string | null
  loadedThreads: string[]
  rateLimits: RateLimitsSnapshot
  account: AccountInfo
  compact: { ms: number; ok: boolean; error: string | null }
  turns: FakeTurnScript[]
  defaultTurn: FakeTurnScript
}

/** 默认剧本里的采样时间写死，`loadScenario({})` 才能与 DEFAULT_SCENARIO 深比较相等。 */
export const FAKE_SAMPLED_AT = "1970-01-01T00:00:00.000Z"

const DEFAULT_TURN: FakeTurnScript = {
  match: null,
  startedAfterMs: 1,
  steps: [],
  waitForServerRequestReply: false,
  completeAfterMs: 2,
  outcome: { status: "completed", finalText: "fake-ok" },
}

function num(v: unknown, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : dflt
}
function str(v: unknown, dflt: string): string {
  return typeof v === "string" ? v : dflt
}
function strOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null
}

function parseTurn(raw: any, base: FakeTurnScript = DEFAULT_TURN): FakeTurnScript {
  if (!raw || typeof raw !== "object") return { ...base }
  return {
    match: raw.match && typeof raw.match === "object" ? { textIncludes: strOrNull(raw.match.textIncludes) ?? undefined } : null,
    startedAfterMs: raw.startedAfterMs === null ? null : num(raw.startedAfterMs, base.startedAfterMs ?? 1),
    steps: Array.isArray(raw.steps) ? (raw.steps as FakeTurnStep[]) : [],
    waitForServerRequestReply: raw.waitForServerRequestReply === true,
    completeAfterMs: num(raw.completeAfterMs, base.completeAfterMs),
    outcome: raw.outcome && typeof raw.outcome === "object" ? (raw.outcome as FakeTurnOutcome) : base.outcome,
  }
}

/** 深度可选的输入 → 完整剧本。未知字段照单收下（前向兼容），已知字段补默认值。 */
export function parseScenario(raw: FakeScenarioInput | unknown): FakeScenario {
  const r = (raw ?? {}) as any
  return {
    version: 1,
    initializeMs: num(r.initializeMs, 1),
    codexHome: str(r.codexHome, "/tmp/fake-codex-home"),
    codexVersion: r.codexVersion === null ? null : str(r.codexVersion, "codex-cli 0.0.0-fake"),
    failStart: strOrNull(r.failStart),
    threadStartMs: num(r.threadStartMs, 1),
    threadResumeMs: num(r.threadResumeMs, 1),
    failThreadStart: strOrNull(r.failThreadStart),
    failThreadResume: strOrNull(r.failThreadResume),
    loadedThreads: Array.isArray(r.loadedThreads) ? r.loadedThreads.map(String) : [],
    rateLimits:
      r.rateLimits && typeof r.rateLimits === "object"
        ? ({ byLimitId: [], sampledAt: FAKE_SAMPLED_AT, rateLimits: null, ...r.rateLimits } as RateLimitsSnapshot)
        : {
            rateLimits: {
              limitId: "codex",
              limitName: "Codex",
              planType: "pro",
              primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: null },
              secondary: { usedPercent: 2, windowDurationMins: 10_080, resetsAt: null },
            },
            byLimitId: [],
            sampledAt: FAKE_SAMPLED_AT,
          },
    account:
      r.account && typeof r.account === "object"
        ? ({ type: "chatgpt", email: null, planType: null, ...r.account } as AccountInfo)
        : { type: "chatgpt", email: null, planType: "pro" },
    compact: {
      ms: num(r.compact?.ms, 1),
      ok: r.compact?.ok !== false,
      error: strOrNull(r.compact?.error),
    },
    turns: Array.isArray(r.turns) ? r.turns.map((t: unknown) => parseTurn(t)) : [],
    defaultTurn: parseTurn(r.defaultTurn),
  }
}

export const DEFAULT_SCENARIO: FakeScenario = parseScenario({})

/** `CODEX_SEAT_FAKE_SCENARIO`：`{` 开头当内联 JSON，否则当文件路径。坏 JSON 抛。 */
export function loadScenario(env: NodeJS.ProcessEnv): FakeScenario {
  const raw = env.CODEX_SEAT_FAKE_SCENARIO?.trim()
  if (!raw) return parseScenario({})
  const text = raw.startsWith("{") ? raw : fs.readFileSync(raw, "utf-8")
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new Error(`CODEX_SEAT_FAKE_SCENARIO 解析失败：${err instanceof Error ? err.message : String(err)}`)
  }
  return parseScenario(parsed)
}

/**
 * 选这一轮用哪个脚本：先按 `match` 命中，再按顺序消费未用过的无 match 条目，最后 defaultTurn。
 * 返回 `index=-1` 表示用的是 defaultTurn。
 */
export function pickTurnScript(
  scenario: FakeScenario,
  text: string,
  consumed: Set<number>,
): { script: FakeTurnScript; index: number } {
  for (let i = 0; i < scenario.turns.length; i++) {
    if (consumed.has(i)) continue
    const m = scenario.turns[i]!.match
    if (m?.textIncludes && text.includes(m.textIncludes)) return { script: scenario.turns[i]!, index: i }
  }
  for (let i = 0; i < scenario.turns.length; i++) {
    if (consumed.has(i)) continue
    if (scenario.turns[i]!.match) continue
    return { script: scenario.turns[i]!, index: i }
  }
  return { script: scenario.defaultTurn, index: -1 }
}
