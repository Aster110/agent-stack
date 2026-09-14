/**
 * 冻结契约的单测——三条线共用的纯函数在这里一次钉死。
 * 变异纪律：先注入漏洞看它红（见 LANES.md §TDD）。
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  CONTRACT_VERSION,
  activeFaults,
  buildSeatInstructions,
  buildWorkerInstructions,
  contextUsedRatio,
  engineThresholdMs,
  evidenceReallyRan,
  extractNonce,
  foldWal,
  formatReceipt,
  isBeforeSeatBirth,
  isReplayStorm,
  syncGuards,
  REPLAY_STORM_THRESHOLD_DEFAULT,
  hasFault,
  isSenderAllowed,
  isValidSeatName,
  isWorkerShortId,
  launchdLabel,
  nonceFromMsgId,
  parseControlMessage,
  parseFaultList,
  parseKeyValues,
  parseReceipt,
  perThreadConfigOverride,
  rateLimitsToEnvelope,
  receiptMessageType,
  scrubProcessEnv,
  seatLedgerId,
  seatNodeId,
  seatPaths,
  splitNodeId,
  type EvidenceRecord,
  type Receipt,
  type WalEntry,
} from "./contracts.js"

describe("nonce", () => {
  it("正文里的 nonce=… 优先", () => {
    assert.equal(extractNonce("ping nonce=ABC-123_x tail", "msg-1"), "ABC-123_x")
  })
  it("没有 nonce 用 msgId 清洗后兜底（冒号/点替换成 _，截 64）", () => {
    const id = "msg-1788338523000-0-ab12-computer2:claude-main"
    const n = extractNonce("no nonce here", id)
    assert.equal(n, nonceFromMsgId(id))
    assert.match(n, /^[A-Za-z0-9_-]{4,64}$/)
    assert.ok(!n.includes(":"))
  })
  it("太短的 nonce 不认（<4）", () => {
    assert.equal(extractNonce("nonce=ab", "msg-xyz"), "msg-xyz")
  })
})

describe("receipt format/parse 往返", () => {
  const cases: Receipt[] = [
    { kind: "seen", nonce: "N1", node: "computer2:codex-main2", thread: "01a0-thread", t: "2026-09-02T10:00:00.000Z" },
    { kind: "done", nonce: "N2", node: "computer2:codex-main2", thread: "01a0-thread", ms: 7031, body: "line1\nline2 [done] fake\n" },
    { kind: "done", nonce: "N2b", node: "computer2:cx-ab12", thread: "ctl", ms: 3, body: "" },
    { kind: "failed", nonce: "N3", node: "computer2:codex-main2", reason: "timeout", detail: "turn exceeded\n30 min   wall" },
    { kind: "rejected", nonce: "N4", node: "computer2:codex-main2", reason: "sender-not-allowed" },
    { kind: "bootstrap-registered", node: "computer2:cx-ab12", nonce: "N5" },
    { kind: "bootstrap-ready", node: "computer2:cx-ab12", nonce: "N5" },
  ]
  for (const r of cases) {
    it(`${r.kind} 往返一致`, () => {
      const text = formatReceipt(r)
      const back = parseReceipt(text)
      assert.ok(back, "parse 应成功")
      if (r.kind === "failed") {
        assert.equal(back.kind, "failed")
        assert.equal((back as any).detail, "turn exceeded 30 min wall") // 压空白
      } else {
        assert.deepEqual(back, r)
      }
    })
  }
  it("逐字格式：seen 一行、done 头行+正文", () => {
    assert.equal(
      formatReceipt({ kind: "seen", nonce: "N", node: "d:s", thread: "t", t: "T" }),
      "[seen] nonce=N node=d:s thread=t t=T",
    )
    assert.equal(
      formatReceipt({ kind: "done", nonce: "N", node: "d:s", thread: "t", ms: 12.6, body: "hello" }),
      "[done] nonce=N node=d:s thread=t ms=13\nhello",
    )
  })
  it("非回执返回 null；[done] 缺 ms 不认", () => {
    assert.equal(parseReceipt("hello world"), null)
    assert.equal(parseReceipt("[done] nonce=N node=d:s thread=t"), null)
    assert.equal(parseReceipt("[seen] nonce=N node=d:s"), null)
  })
  it("回执消息 type：done→result（云端闭单），其余 system", () => {
    assert.equal(receiptMessageType("done"), "result")
    assert.equal(receiptMessageType("seen"), "system")
    assert.equal(receiptMessageType("rejected"), "system")
  })
})

describe("control message", () => {
  it("spawn 全字段 + desc 吃到行尾", () => {
    const c = parseControlMessage('[ctl:spawn] role=worker cwd=/Users/example/workspace/project agent=codex nonce=SP-1 desc=修 bug 42 然后回报')
    assert.deepEqual(c, { kind: "spawn", role: "worker", cwd: "/Users/example/workspace/project", agent: "codex", nonce: "SP-1", desc: "修 bug 42 然后回报" })
  })
  it("带引号的 cwd（含空格）", () => {
    const c = parseControlMessage('[ctl:spawn] cwd="/tmp/my dir" agent=tcx nonce=SP-2')
    assert.equal(c?.kind, "spawn")
    assert.equal((c as any).cwd, "/tmp/my dir")
    assert.equal((c as any).desc, "")
  })
  it("spawn 缺 nonce / 相对 cwd / role 非 worker → invalid", () => {
    assert.equal(parseControlMessage("[ctl:spawn] cwd=/tmp agent=codex")?.kind, "invalid")
    assert.equal(parseControlMessage("[ctl:spawn] cwd=tmp agent=codex nonce=SP-3")?.kind, "invalid")
    assert.equal(parseControlMessage("[ctl:spawn] role=main cwd=/tmp agent=codex nonce=SP-3")?.kind, "invalid")
  })
  it("close/status/compact", () => {
    assert.deepEqual(parseControlMessage("[ctl:close] node=computer2:cx-ab12 nonce=C-01"), { kind: "close", node: "computer2:cx-ab12", nonce: "C-01" })
    assert.deepEqual(parseControlMessage("[ctl:close] node=computer2:cx-ab12"), { kind: "close", node: "computer2:cx-ab12", nonce: null })
    assert.deepEqual(parseControlMessage("[ctl:status]"), { kind: "status", nonce: null })
    assert.deepEqual(parseControlMessage("[ctl:status] nonce=ST-1"), { kind: "status", nonce: "ST-1" })
    assert.deepEqual(parseControlMessage("[ctl:compact]"), { kind: "compact", node: null, nonce: null })
    assert.deepEqual(parseControlMessage("[ctl:compact] node=computer2:cx-ab12 nonce=CP-1"), { kind: "compact", node: "computer2:cx-ab12", nonce: "CP-1" })
  })
  it("不是控制消息 → null；只看第一行", () => {
    assert.equal(parseControlMessage("普通消息 nonce=X-1"), null)
    assert.equal(parseControlMessage("[mesh:server:brain] [ctl:status]"), null) // 前缀必须被剥掉后再喂
    assert.equal(parseControlMessage("[ctl:status] nonce=A-1\n第二行 nonce=B-2")?.kind, "status")
  })
  it("parseKeyValues 转义引号", () => {
    assert.deepEqual(parseKeyValues('a="x \\"y\\" z" b=1'), { a: 'x "y" z', b: "1" })
  })
})

describe("内部来源路由（v5，旧 allowlist 配置兼容）", () => {
  const ctx = { seatNodeId: "computer2:codex-main2", workerNodeIds: ["computer2:cx-ab12"], extra: ["*:e2e-probe", "mini:ops-box"], disableDefaults: false }
  it("默认放行：server:brain、任意设备 claude-main/codex-main/codex-main2", () => {
    for (const f of ["server:brain", "computer1:claude-main", "mini:codex-main", "computer2:codex-main2", "workstation:codex-main"]) {
      assert.equal(isSenderAllowed(f, ctx), true, f)
    }
  })
  it("自己、自己拉的 worker、extra 精确与 *:shortId", () => {
    assert.equal(isSenderAllowed("computer2:codex-main2", ctx), true)
    assert.equal(isSenderAllowed("computer2:cx-ab12", ctx), true)
    assert.equal(isSenderAllowed("computer2:e2e-probe", ctx), true)
    assert.equal(isSenderAllowed("server:e2e-probe", ctx), true)
    assert.equal(isSenderAllowed("mini:ops-box", ctx), true)
  })
  it("普通内部 peer 可达；relay 兜底署名与空来源仍拒绝", () => {
    assert.equal(isSenderAllowed("computer2:relay", ctx), false)
    assert.equal(isSenderAllowed("computer2:cx-ffff", ctx), true)
    assert.equal(isSenderAllowed("computer1:claude-worker-4f2a", ctx), true)
    assert.equal(isSenderAllowed("", ctx), false)
    assert.equal(isSenderAllowed("server:brain-inbox", ctx), true)
  })
  it("旧 disableDefaults 不再阻断真实主脑路由", () => {
    const c2 = { ...ctx, disableDefaults: true }
    assert.equal(isSenderAllowed("server:brain", c2), true)
    assert.equal(isSenderAllowed("computer2:e2e-probe", c2), true)
  })
})

describe("决策 2：per-thread env 覆盖 + 进程 env 清洗", () => {
  it("覆盖对象形状固定", () => {
    assert.deepEqual(perThreadConfigOverride("computer2:cx-ab12", "server:brain"), {
      shell_environment_policy: { set: { MESH_NODE: "computer2:cx-ab12", MESH_DELEGATOR_NODE: "server:brain" } },
    })
    assert.deepEqual(perThreadConfigOverride("computer2:codex-main2"), {
      shell_environment_policy: { set: { MESH_NODE: "computer2:codex-main2" } },
    })
  })
  it("进程级 env 不得带任何署名", () => {
    const env = scrubProcessEnv({ PATH: "/bin", MESH_NODE: "x", MESH_DELEGATOR_NODE: "y", MESH_ID: "z", HOME: "/h" })
    assert.deepEqual(env, { PATH: "/bin", HOME: "/h" })
  })
})

describe("WAL 折叠", () => {
  const base = { seq: 1, to: "computer2:codex-main2", from: "server:brain", nonce: "N", at: "t" }
  it("fetched→started→completed→receipted", () => {
    const es: WalEntry[] = [
      { op: "fetched", msgId: "m1", ...base },
      { op: "started", msgId: "m1", ...base, threadId: "T", turnId: "U" },
      { op: "completed", msgId: "m1", ...base, finalText: "ok" },
      { op: "receipted", msgId: "m1", ...base },
      { op: "fetched", msgId: "m2", ...base, seq: 2 },
      { op: "started", msgId: "m3", ...base }, // 孤儿：无 fetched
    ]
    const f = foldWal(es)
    assert.equal(f.get("m1")?.phase, "done")
    assert.equal(f.get("m1")?.finalText, "ok")
    assert.equal(f.get("m2")?.phase, "fetched")
    assert.equal(f.has("m3"), false)
  })
  it("fetched 的 payload 原样透传（重放要拿它重投，不许经 detail 中转被截断）", () => {
    const long = "x".repeat(500)
    const f = foldWal([{ op: "fetched", msgId: "m1", ...base, payload: long }])
    assert.equal(f.get("m1")?.payload, long)
    assert.equal(f.get("m1")?.payload?.length, 500)
  })
  it("没有 payload 的旧 WAL 行仍能折叠（undefined，不炸）", () => {
    const f = foldWal([{ op: "fetched", msgId: "m1", ...base }])
    assert.equal(f.get("m1")?.payload, undefined)
  })
})

describe("faults", () => {
  it("没有 ALLOW 开关一律不生效", () => {
    assert.equal(activeFaults({ CODEX_SEAT_FAULT: "disable-allowlist" }).size, 0)
    assert.equal(hasFault({ CODEX_SEAT_FAULT: "disable-allowlist", CODEX_SEAT_ALLOW_FAULTS: "1" }, "disable-allowlist"), true)
  })
  it("逗号多选 + 未知名忽略", () => {
    const s = activeFaults({ CODEX_SEAT_ALLOW_FAULTS: "1", CODEX_SEAT_FAULT: "engine-down, kill-wrapper-only ,bogus" })
    assert.deepEqual([...s].sort(), ["engine-down", "kill-wrapper-only"])
  })
  it("parseFaultList：证据里的变异串与 env 同写法；external 不是 fault", () => {
    assert.deepEqual(parseFaultList("crash-after-ack-before-started,disable-wal-replay"), ["crash-after-ack-before-started", "disable-wal-replay"])
    assert.deepEqual(parseFaultList("external"), [])
    assert.deepEqual(parseFaultList(null), [])
  })
})

describe("naming / paths", () => {
  it("seat 名校验与 id 派生", () => {
    assert.equal(isValidSeatName("codex-main2"), true)
    assert.equal(isValidSeatName("Codex Main"), false)
    assert.equal(seatNodeId("computer2", "codex-main2"), "computer2:codex-main2")
    assert.equal(seatLedgerId("computer2", "codex-main2"), "computer2/codex-main2")
    assert.equal(launchdLabel("codex-main2"), "com.aster.codex-seat.codex-main2")
    assert.equal(isWorkerShortId("cx-ab12"), true)
    assert.equal(isWorkerShortId("cc-ab12"), false)
    assert.deepEqual(splitNodeId("server:brain"), { deviceId: "server", shortId: "brain" })
  })
  it("目录布局", () => {
    const p = seatPaths("codex-main2", "/home/u")
    assert.equal(p.home, "/home/u/.ccmesh/codex-seat/codex-main2")
    assert.equal(p.wal, "/home/u/.ccmesh/codex-seat/codex-main2/wal.jsonl")
    assert.equal(p.sidecarLog, "/home/u/.ccmesh/codex-seat/codex-main2/log/sidecar.jsonl")
  })
})

describe("上下文占比 / 阈值", () => {
  it("last.totalTokens / window", () => {
    const u = { total: { totalTokens: 1, inputTokens: 1, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }, last: { totalTokens: 180_880, inputTokens: 180_000, cachedInputTokens: 0, outputTokens: 880, reasoningOutputTokens: 0 }, modelContextWindow: 258_400 }
    assert.ok(Math.abs(contextUsedRatio(u, 1) - 0.7) < 1e-6)
    assert.ok(contextUsedRatio({ ...u, modelContextWindow: null }, 258_400) >= 0.7)
  })
  it("E01 阈值 = 2×基线，不低于 100ms", () => {
    assert.equal(engineThresholdMs("turnStarted"), 100)
    assert.equal(engineThresholdMs("initialize"), 272)
  })
})

describe("额度信封", () => {
  it("顶层 5h/7d + 专项桶 *_scoped，resets_at 转 ISO", () => {
    const env = rateLimitsToEnvelope({
      sampledAt: "2026-09-02T10:00:00.000Z",
      rateLimits: { limitId: "codex", limitName: null, planType: "pro", primary: { usedPercent: 17, windowDurationMins: 10080, resetsAt: 1788892172 }, secondary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 1788356532 } },
      byLimitId: [{ limitId: "codex_bengalfox", limitName: "GPT-5.3-Codex-Spark", planType: null, primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: null }, secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: null } }],
    }, { accountFp: "chatgpt-fixture0000", host: "computer2" })
    assert.equal(env.status, "ok")
    assert.equal(env.account_id, "chatgpt-fixture0000")
    assert.deepEqual(env.limits.map((l) => l.kind), ["7d", "5h", "5h_scoped", "7d_scoped"])
    assert.equal(env.limits[0]!.resets_at, new Date(1788892172 * 1000).toISOString())
    assert.equal(env.plan_type, "pro")
  })
})

describe("developerInstructions 模板含关键句", () => {
  it("席位：署名命令、回执由 sidecar 发、真实主脑授权", () => {
    const t = buildSeatInstructions({ nodeId: "computer2:codex-main2", deviceId: "computer2", cwd: "/x", relayUrl: "http://127.0.0.1:19800" })
    assert.ok(t.includes("MESH_NODE=computer2:codex-main2 mesh send"))
    assert.ok(t.includes("[done] 回执"))
    assert.match(t, /真实[^\n]*server:brain[^\n]*部署所有者明确授予的权限/)
  })
  it("worker：保留 delegator 身份，内部协作遵循已有授权", () => {
    const t = buildWorkerInstructions({ nodeId: "computer2:cx-ab12", deviceId: "computer2", cwd: "/x", relayUrl: "u", delegatorNodeId: "server:brain", seatNodeId: "computer2:codex-main2", desc: "修 bug" })
    assert.ok(t.includes("由 server:brain 通过席位 computer2:codex-main2 拉起"))
    assert.match(t, /内部[^\n]*(?:已有|既有)[^\n]*授权/)
    assert.ok(t.includes("任务描述：修 bug"))
  })
})

describe("证据三件套", () => {
  const base: EvidenceRecord = {
    case: "E02", nonce: "N", startedAt: "t", wallMs: 1200, events: { "turn.started": 1 }, rolloutBytesBefore: 100, rolloutBytesAfter: 180,
    assertions: [], mutation: null, notes: "", passed: true, lane: "B", phase: "e2e", env: { relay: "real", appServer: "real" },
    contractVersion: CONTRACT_VERSION, codexVersion: "0.151.0", hostname: "computer2", instanceId: null,
  }
  it("真引擎要求 rollout 增长", () => {
    assert.equal(evidenceReallyRan(base), true)
    assert.equal(evidenceReallyRan({ ...base, rolloutBytesAfter: 100 }), false)
    assert.equal(evidenceReallyRan({ ...base, events: {} }), false)
    assert.equal(evidenceReallyRan({ ...base, wallMs: 0 }), false)
  })
  it("假引擎不看 rollout", () => {
    assert.equal(evidenceReallyRan({ ...base, env: { relay: "fake", appServer: "fake" }, rolloutBytesAfter: null, rolloutBytesBefore: null }), true)
  })
  it("real-idle：零 turn 的真引擎档免 rollout，但墙钟与事件计数一条不减", () => {
    const idle: EvidenceRecord = { ...base, env: { relay: "real", appServer: "real-idle" }, rolloutBytesBefore: null, rolloutBytesAfter: null }
    assert.equal(evidenceReallyRan(idle), true)
    // 豁免只免第三条：空事件、零墙钟照样不算跑过
    assert.equal(evidenceReallyRan({ ...idle, events: {} }), false)
    assert.equal(evidenceReallyRan({ ...idle, wallMs: 0 }), false)
    // 而写成 real 就必须拿得出 rollout 增长（这正是 real-idle 存在的理由）
    assert.equal(evidenceReallyRan({ ...idle, env: { relay: "real", appServer: "real" } }), false)
  })
})

describe("防重放三道防线的纯判据（2026-09-02 computer2 事故）", () => {
  it("syncGuards：老 config.json 缺三个键 → 全按最安全的缺省", () => {
    // 注入：把 `sync.replayHistory === true` 写成 `!== false` → 缺字段变成「允许重放」→ 红
    const g = syncGuards({ timeoutSec: 55, limit: 100 })
    assert.equal(g.replayHistory, false)
    assert.equal(g.acceptMessagesOlderThanSeat, false)
    assert.equal(g.replayStormThreshold, REPLAY_STORM_THRESHOLD_DEFAULT)
    assert.equal(REPLAY_STORM_THRESHOLD_DEFAULT, 20)
  })

  it("syncGuards：字符串 \"true\" 不算开（配置写错要保持关着，不是猜用户想干嘛）", () => {
    const g = syncGuards({ timeoutSec: 55, limit: 100, replayHistory: "true" as unknown as boolean })
    assert.equal(g.replayHistory, false)
  })

  it("syncGuards：阈值 0 / 负数 / 非数字都退回缺省（0 会让每一批都熔断）", () => {
    for (const bad of [0, -1, Number.NaN, "20" as unknown as number]) {
      assert.equal(syncGuards({ timeoutSec: 55, limit: 100, replayStormThreshold: bad }).replayStormThreshold, 20, `${String(bad)}`)
    }
    assert.equal(syncGuards({ timeoutSec: 55, limit: 100, replayStormThreshold: 3 }).replayStormThreshold, 3)
  })

  it("isBeforeSeatBirth：早于出生 = true，同刻/晚于 = false", () => {
    // 注入：把 `<` 写成 `<=` → 同刻那条也被拒 → 红
    const birth = "2026-09-02T18:29:24.000Z"
    assert.equal(isBeforeSeatBirth("2026-08-28T10:00:00.000Z", birth), true)
    assert.equal(isBeforeSeatBirth(birth, birth), false)
    assert.equal(isBeforeSeatBirth("2026-09-02T18:29:25.000Z", birth), false)
  })

  it("isBeforeSeatBirth：时间戳缺失/坏掉一律放行（防线 1 兜着，不做会误伤活消息的闸）", () => {
    assert.equal(isBeforeSeatBirth(null, "2026-09-02T18:29:24.000Z"), false)
    assert.equal(isBeforeSeatBirth(undefined, "2026-09-02T18:29:24.000Z"), false)
    assert.equal(isBeforeSeatBirth("昨天", "2026-09-02T18:29:24.000Z"), false)
    assert.equal(isBeforeSeatBirth("2026-08-28T10:00:00.000Z", "坏掉的出生时刻"), false)
  })

  it("isReplayStorm：超阈值 **且** 多数出生前才熔断，两个条件缺一不可", () => {
    // 注入：把 && 写成 || → 「21 条新消息」这种正常爆发也会被熔断 → 红
    assert.equal(isReplayStorm(263, 263, 20), true, "事故当天的批")
    assert.equal(isReplayStorm(21, 11, 20), true, "刚过半")
    assert.equal(isReplayStorm(21, 10, 20), false, "正好一半不算多数")
    assert.equal(isReplayStorm(20, 20, 20), false, "没超阈值（> 不是 >=）")
    assert.equal(isReplayStorm(100, 0, 20), false, "一条历史都没有的正常大批次")
    assert.equal(isReplayStorm(0, 0, 20), false)
  })

  it("[rejected] 两种 reason 都能原样往返（回执格式是逐字契约）", () => {
    for (const reason of ["sender-not-allowed", "stale-before-seat-birth"] as const) {
      const text = formatReceipt({ kind: "rejected", nonce: "n1234", node: "d:s", reason })
      assert.equal(text, `[rejected] nonce=n1234 node=d:s reason=${reason}`)
      const back = parseReceipt(text)
      assert.deepEqual(back, { kind: "rejected", nonce: "n1234", node: "d:s", reason })
    }
    assert.equal(parseReceipt("[rejected] nonce=n1234 node=d:s reason=whatever"), null, "没定义过的 reason 不许解析成回执")
  })
})
