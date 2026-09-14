/**
 * E01 —— 引擎回归（真 codex，无 relay）。Lane A / integration。
 *
 *   node dist/src/app-server/e01.js                    # 正常档
 *   node dist/src/app-server/e01.js --mutate           # 红门：drop-turn-started 必须让它红
 *   node dist/src/app-server/e01.js --mutate=serverrequest
 *                                                      # 故障行为检查：drop-serverrequest-default
 *                                                      # 下 assertions 仍须全过（真引擎的
 *                                                      # ServerRequest 都在表里）
 *
 * 断言（数字全部来自设计稿 §10 E01 / contracts.ts `ENGINE_BASELINE_MS`，不写"合理时间内"）：
 *   initialize ≤ 272ms、thread/start ≤ 312ms、turn/started ≤ 100ms、
 *   两 thread 各跑 `sleep 8` 总墙钟 < 14s 且各自 ≥ 8s、
 *   `kill -9` 整个进程组后 thread/resume ≤ 100ms 且答得出重启前埋的 8 位暗号、
 *   事件集 ⊇ {thread/started, turn/started, item/completed, thread/tokenUsage/updated, turn/completed}、
 *   `account/rateLimits/read` 的 usedPercent 是整数、mcp `node_repl` 达 ready、
 *   rollout 字节增长。
 *
 * 模型 turn 预算：正常档 4 轮（暗号 1 + 并行 2 + 重启回忆 1），变异档 1 轮。
 * cwd 是一次性空临时目录——dangerFullAccess 下模型会翻 cwd 抄答案，暗号绝不能落盘。
 * **不碰 relay(:19800)、不碰 tmux 席位、不开 --remote-control、不截图、不用 CU。**
 */
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  CONTRACT_VERSION,
  type EngineEvent,
  type EvidenceAssertion,
  type EvidenceRecord,
  engineThresholdMs,
  evidenceReallyRan,
  perThreadConfigOverride,
} from "../contracts.js"
import { RealAppServerClient } from "./real-client.js"

/**
 * 并行墙钟上限。**设计稿 §10 E01 原写 14000ms，实测不成立**：真模型跑完
 * 「说一句 → 执行 sleep 8 → 再说一句」一轮要 17–24s（2026-09-02 computer2 实测
 * A=21.7s / B=17.1s），14s 连单轮都装不下，与并行与否无关。
 * 这里改成 30000ms（实测最坏 23.7s + ~27% 余量），并**另加两条更强的结构判据**
 * （overlap-ratio 与 started 双快），它们不受模型时延影响：
 *   - 墙钟 < (两轮 ms 之和)×0.75  → 真重叠了（串行时必然 ≥ 和）
 *   - 两轮的 startedMs 都 ≤ turnStarted 阈值 → 引擎没把第二轮排队
 * 设计稿 §10 的 14000 需要按此回改（E05 同款假设，Lane B 会撞同一堵墙）。
 */
const PARALLEL_WALL_LIMIT_MS = 30_000
/** 串行时墙钟必然 ≥ 两轮之和；留 25% 余量后仍小于和，才算真重叠 */
const PARALLEL_OVERLAP_RATIO = 0.75
const SLEEP_SECONDS = 8
const SLEEP_MIN_MS = 8_000
const STARTED_WAIT_MS = 10_000 // 红门：drop-turn-started 下等 started 最多 10s 就判红
const TURN_TIMEOUT_MS = 180_000
const MCP_READY_WAIT_MS = 30_000
/** 冷态 resume 的粗上界：整组 kill -9 重启后那一发只验「没卡死」，精确基线由热态那次守 */
const COLD_RESUME_MAX_MS = 5_000
const NODE_REPL = "node_repl"

type MutateMode = "none" | "started" | "serverrequest"

interface Ctx {
  assertions: EvidenceAssertion[]
  events: Record<string, number>
}

function record(ctx: Ctx, name: string, actual: unknown, expected: unknown, pass: boolean): boolean {
  ctx.assertions.push({ name, pass, actual, expected })
  console.log(`${pass ? "  ok  " : "  FAIL"} ${name}  actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`)
  return pass
}

function countEvent(ctx: Ctx, ev: EngineEvent): void {
  const key = ev.type === "raw" ? ev.method : ev.type
  ctx.events[key] = (ctx.events[key] ?? 0) + 1
}

function nonce8(): string {
  return crypto.randomBytes(6).toString("base64url").replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toUpperCase()
}

/** rollout 文件：优先用 thread/start 回包里的 path，拿不到就在 sessions 下按 threadId 找。 */
function findRollout(codexHome: string, threadId: string, known: string | null): string | null {
  if (known && fs.existsSync(known)) return known
  const root = path.join(codexHome, "sessions")
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!
    if (depth > 5) continue
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) stack.push({ dir: p, depth: depth + 1 })
      else if (e.isFile() && e.name.includes(threadId)) return p
    }
  }
  return null
}

function fileSize(p: string | null): number | null {
  if (!p) return null
  try {
    return fs.statSync(p).size
  } catch {
    return null
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 等 started，但最多等 waitMs——红门要的就是"等不到就红"，不是永远挂着。 */
async function awaitStarted(
  h: { started: Promise<{ turnId: string; at: number }> },
  waitMs: number,
): Promise<{ ok: true; turnId: string } | { ok: false; reason: string }> {
  let timer: NodeJS.Timeout | null = null
  const timeout = new Promise<{ ok: false; reason: string }>((res) => {
    timer = setTimeout(() => res({ ok: false, reason: `等 turn/started 超过 ${waitMs}ms` }), waitMs)
    if (typeof timer.unref === "function") timer.unref()
  })
  try {
    return await Promise.race([
      h.started.then((s) => ({ ok: true as const, turnId: s.turnId })).catch((e: Error) => ({ ok: false as const, reason: e.message })),
      timeout,
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const mutateArg = argv.find((a) => a.startsWith("--mutate"))
  const mode: MutateMode = !mutateArg
    ? "none"
    : mutateArg === "--mutate" || mutateArg === "--mutate=started"
      ? "started"
      : mutateArg === "--mutate=serverrequest"
        ? "serverrequest"
        : "started"
  const faults = new Set<import("../contracts.js").FaultName>()
  if (mode === "started") faults.add("drop-turn-started")
  if (mode === "serverrequest") faults.add("drop-serverrequest-default")
  // 红门 = 变异必须让 case 红；serverrequest 档是故障行为检查（assertions 仍须全过）
  const expectedRed = mode === "started"

  const runNonce = `E01-${nonce8()}`
  const secret = nonce8()
  const startedAt = new Date().toISOString()
  const t0 = Date.now()
  const ctx: Ctx = { assertions: [], events: {} }

  // dangerFullAccess 下模型会翻 cwd 抄答案：一次性空目录，什么都不写进去
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-seat-e01-"))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-seat-e01-home-"))
  const pidFile = path.join(home, "app-server.pid")
  const instanceId = crypto.randomUUID()

  const mcpStatus = new Map<string, string>()
  const collect = (ev: EngineEvent): void => {
    countEvent(ctx, ev)
    if (ev.type === "mcp.startup") mcpStatus.set(ev.name, ev.status)
  }

  const mkClient = (): RealAppServerClient => {
    const c = new RealAppServerClient({
      cwd,
      pidFile,
      // 席位标签：孤儿谓词按 codex_seat.tag="<seat>/<instanceId>" 认人，不给就退化成 "unknown/…"
      seat: "e01",
      instanceId,
      faults,
      initializeTimeoutMs: 30_000,
      threadOpTimeoutMs: 120_000,
      shutdownGraceMs: 2_000,
    })
    c.onEvent(collect)
    return c
  }

  let client = mkClient()
  let notes = ""
  let rolloutPath: string | null = null
  let rolloutBefore: number | null = null
  let rolloutAfter: number | null = null
  let codexVersion: string | null = null
  let codexHome = ""
  let threadAId = ""

  console.log(`E01 起跑 nonce=${runNonce} mutate=${mode} cwd=${cwd}`)

  try {
    // --- 1. 起引擎 ---------------------------------------------------------
    const info = await client.start()
    codexVersion = info.codexVersion
    codexHome = info.codexHome
    record(ctx, "initialize-ms", info.initializeMs, `<= ${engineThresholdMs("initialize")}`, info.initializeMs <= engineThresholdMs("initialize"))
    record(ctx, "engine-pgid-is-group-leader", info.pgid, info.pid, info.pgid === info.pid)

    // --- 1b. 预热一条**不计时**的 thread（计时规则，设计稿 §10）----------------
    // app-server 刚起来时，第一发 thread/start 要排在 MCP 拉起后面，实测飙到 4165ms
    // （热态只有 83–88ms）—— 拿它去卡 312ms 的热态基线，报出来的是「MCP 启动排队」，
    // 不是 thread/start 慢。所以先开一条一次性 thread 把冷启吃掉，再开被测的 thA 计时。
    //
    // 为什么不是「先等 node_repl ready 再计时」：实测 MCP 不是引擎起来就拉的 —— 引擎空转时
    // 30s 内一条 mcpServer/startupStatus/updated 都不发，等它等于死等（试过，直接超时）。
    // node_repl 的 ready 断言留在第 6 步（那时 thread 和 turn 都跑过了，它才真的报 ready）。
    const warmThread = await client.threadStart({
      cwd,
      developerInstructions: "预热用，不计时，不跑任何 turn",
      config: perThreadConfigOverride("e01:warmup"),
    })
    notes += `预热 thread ${warmThread.threadId.slice(0, 8)} opMs=${warmThread.opMs}（吃冷启，不计时）；`
    ctx.events["thread.warmup"] = 1

    // --- 2. 主 thread（此刻引擎已热）----------------------------------------
    const devInstructions = [
      "你是 codex-seat 的 E01 回归测试对象。回答一律极简：只给要求的那一行，不解释、不寒暄。",
      "被要求执行 shell 命令时必须真的执行，不许跳过、不许假装执行。",
    ].join("\n")
    const thA = await client.threadStart({
      cwd,
      developerInstructions: devInstructions,
      config: perThreadConfigOverride("e01:engine-a"),
    })
    threadAId = thA.threadId
    record(ctx, "thread-start-ms（热态：已预热过一条 thread）", thA.opMs, `<= ${engineThresholdMs("threadStart")}`, thA.opMs <= engineThresholdMs("threadStart"))
    rolloutPath = findRollout(info.codexHome, thA.threadId, client.threadPath(thA.threadId))
    rolloutBefore = fileSize(rolloutPath) ?? 0

    // --- 3. 埋暗号 + 量 turn/started ---------------------------------------
    const h1 = await client.turnStart({
      threadId: thA.threadId,
      text: `记住这个暗号：${secret}。现在只回复这一行：OK-${secret}`,
      nonce: runNonce,
      msgId: `${runNonce}-1`,
      timeoutMs: TURN_TIMEOUT_MS,
    })
    const s1 = await awaitStarted(h1, STARTED_WAIT_MS)
    const startedOk = record(ctx, "turn-started-arrives", s1.ok ? "yes" : s1.reason, "yes", s1.ok)
    if (!startedOk) {
      // 红门命中：那一轮还在后台烧，打断它，别把额度和 rollout 拖下去
      notes = `变异 ${mode} 命中：${s1.ok ? "" : s1.reason}`
      await h1.interrupt().catch(() => {})
      throw new EarlyStop()
    }

    const o1 = await h1.done
    record(ctx, "turn-1-completed", o1.status, "completed", o1.status === "completed")
    if (o1.status === "completed") {
      record(
        ctx,
        "turn-started-ms",
        o1.startedMs,
        `<= ${engineThresholdMs("turnStarted")}`,
        o1.startedMs <= engineThresholdMs("turnStarted"),
      )
      record(ctx, "turn-1-echoes-secret", (o1.finalText ?? "").slice(0, 120), `含 ${secret}`, (o1.finalText ?? "").toUpperCase().includes(secret))
    }

    // --- 4. 两 thread 各跑 sleep 8：证真并行 --------------------------------
    const thB = await client.threadStart({
      cwd,
      developerInstructions: devInstructions,
      config: perThreadConfigOverride("e01:engine-b"),
    })
    const sleepPrompt = (tag: string): string =>
      `用 shell 执行命令 \`sleep ${SLEEP_SECONDS}\`，等它真的返回之后，只回复这一行：SLEPT-${tag}`
    const tPar = Date.now()
    const [hA, hB] = await Promise.all([
      client.turnStart({ threadId: thA.threadId, text: sleepPrompt("A"), nonce: runNonce, msgId: `${runNonce}-2`, timeoutMs: TURN_TIMEOUT_MS }),
      client.turnStart({ threadId: thB.threadId, text: sleepPrompt("B"), nonce: runNonce, msgId: `${runNonce}-3`, timeoutMs: TURN_TIMEOUT_MS }),
    ])
    const [oA, oB] = await Promise.all([hA.done, hB.done])
    const parallelWall = Date.now() - tPar
    record(ctx, "parallel-both-completed", [oA.status, oB.status], ["completed", "completed"], oA.status === "completed" && oB.status === "completed")
    record(ctx, "parallel-wall-ms", parallelWall, `< ${PARALLEL_WALL_LIMIT_MS}`, parallelWall < PARALLEL_WALL_LIMIT_MS)
    const msA = oA.status === "completed" ? oA.wallMs : -1
    const msB = oB.status === "completed" ? oB.wallMs : -1
    record(ctx, "parallel-each-really-slept", [msA, msB], `each >= ${SLEEP_MIN_MS}`, msA >= SLEEP_MIN_MS && msB >= SLEEP_MIN_MS)
    // 结构判据：串行时墙钟必然 ≥ 两轮之和，重叠了才会明显小于和
    const serialFloor = msA + msB
    record(
      ctx,
      "parallel-overlap-ratio",
      { wall: parallelWall, serialFloor },
      `wall < serialFloor * ${PARALLEL_OVERLAP_RATIO}`,
      msA > 0 && msB > 0 && parallelWall < serialFloor * PARALLEL_OVERLAP_RATIO,
    )
    // 引擎没排队：第二轮的 turn/started 与第一轮一样快
    const stA = oA.status === "completed" ? oA.startedMs : Number.POSITIVE_INFINITY
    const stB = oB.status === "completed" ? oB.startedMs : Number.POSITIVE_INFINITY
    record(
      ctx,
      "parallel-both-started-immediately",
      [stA, stB],
      `each <= ${engineThresholdMs("turnStarted")}`,
      stA <= engineThresholdMs("turnStarted") && stB <= engineThresholdMs("turnStarted"),
    )

    // --- 5. 额度接口 -------------------------------------------------------
    const rl = await client.rateLimits()
    const pct = rl.rateLimits?.primary?.usedPercent
    record(ctx, "ratelimits-usedPercent-integer", pct, "integer", typeof pct === "number" && Number.isInteger(pct))

    // --- 6. mcp node_repl 达 ready ------------------------------------------
    // 放在这里（而不是引擎刚起时）：MCP 是被 thread/turn 拉起来的，引擎空转不发启动事件。
    const deadline = Date.now() + MCP_READY_WAIT_MS
    while (mcpStatus.get(NODE_REPL) !== "ready" && Date.now() < deadline) await sleep(200)
    record(ctx, "mcp-node_repl-ready", mcpStatus.get(NODE_REPL) ?? "(没有该 MCP 的启动事件)", "ready", mcpStatus.get(NODE_REPL) === "ready")

    // --- 6b. 热态 thread/resume（守 ENGINE_BASELINE_MS.threadResume 的 46ms 基线）-----
    // 为什么单独量一次：第 7 步那次 resume 是 `kill -9` 整组重启之后的**冷态**，
    // 实测 124 / 3483 / 69 / 2799ms —— 量到的是引擎重启预热抖动，不是 resume 本身，
    // 拿它去卡 100ms 等于用抖动当 bug 报。热态基线必须在引擎已经热、thread 已有 rollout 的
    // 时候量：这里 thA 跑过两轮、rollout 已落盘、MCP 也 ready 了，正是热态。
    // 这一步**不烧模型轮次**（resume 是 RPC，不是 turn）。
    // 顺带钉死一条实测事实（探针 2026-09-02 复现）：resume 打在**没有 rollout** 的 thread 上
    // 必报 `no rollout found for thread id <id>` —— 席位层的 resumableThreads 就是为它存在的。
    const hotResume = await client.threadResume({
      threadId: thA.threadId,
      cwd,
      developerInstructions: devInstructions,
      config: perThreadConfigOverride("e01:engine-a"),
    })
    record(
      ctx, "thread-resume-ms（热态：引擎已热 + thread 已有 rollout）",
      hotResume.opMs, `<= ${engineThresholdMs("threadResume")}`,
      hotResume.opMs <= engineThresholdMs("threadResume"),
    )
    record(ctx, "thread-resume-hot-same-id", hotResume.threadId, thA.threadId, hotResume.threadId === thA.threadId)

    // --- 7. kill -9 整个进程组 → 重启 → resume 续上暗号 ----------------------
    const pgid = info.pgid
    process.kill(-pgid, "SIGKILL")
    const killDeadline = Date.now() + 10_000
    while (client.isAlive() && Date.now() < killDeadline) await sleep(50)
    record(ctx, "engine-lost-after-group-kill", client.isAlive(), false, !client.isAlive())
    // 进程组里一个都不许剩（只杀 wrapper 会留 ppid=1 的 rust 本体）
    let groupResidue = true
    try {
      process.kill(-pgid, 0)
    } catch {
      groupResidue = false
    }
    record(ctx, "process-group-empty", groupResidue, false, !groupResidue)

    // 计时规则（设计稿 §10）：resume 的 92/100ms 基线是**热态**数字。新一代引擎刚起来，
    // node_repl 这类 MCP 还在拉起，此刻量到的是「MCP 启动排队」而不是 resume 本身
    // （实测 124ms vs 热态 46ms）。所以先等新一代 MCP 就绪再计时。
    //
    // 上一代的 ready 必须在 **start() 之前**抹掉：start() 里的 initialize 期间新一代就会
    // 把 mcp.startup ready 发出来，抹在 start() 之后等于把刚到的那条 ready 删掉，
    // 然后死等一条永远不会再来的事件（实测：等满 30s 拿到「新一代没有该 MCP 的启动事件」，
    // resume 反而量成 3483ms）——一个永远等不到的 wait 就是一条测不到东西的测试。
    mcpStatus.delete(NODE_REPL)
    client = mkClient()
    const info2 = await client.start()
    record(ctx, "engine-restarted-new-pid", info2.pid !== info.pid, true, info2.pid !== info.pid)

    const readyDeadline2 = Date.now() + MCP_READY_WAIT_MS
    while (mcpStatus.get(NODE_REPL) !== "ready" && Date.now() < readyDeadline2) await sleep(200)
    // 这一步**只用来把新一代引擎等热**，不作判据 ——
    // 实测（2026-09-02，codex-cli 0.151.0）：`kill -9` 整个进程组之后起的新一代，30s 内
    // 不再发 node_repl 的 mcpServer/startupStatus/updated（gen1 是发的，gen1 的 ready 断言照旧守）。
    // 拿一条我们没有依据要求引擎必发的事件去当红绿灯，红了也说明不了任何问题。
    // 只记进 events + notes，留给后面查（未解决项：新一代为什么不重发启动事件）。
    const readyAfterRestart = mcpStatus.get(NODE_REPL) ?? "(新一代没有该 MCP 的启动事件)"
    ctx.events["mcp.node_repl.ready-after-restart"] = readyAfterRestart === "ready" ? 1 : 0
    notes += `重启后 node_repl 启动状态=${readyAfterRestart}（只用于等热，不作判据）；`

    const resumed = await client.threadResume({
      threadId: thA.threadId,
      cwd,
      developerInstructions: devInstructions,
      config: perThreadConfigOverride("e01:engine-a"),
    })
    // 冷态：整组 kill -9 之后新起的引擎，MCP 还在陆续拉起，这一发天生是冷的
    // （与主席位对 E04 的裁定同口径：只设「没卡死」的粗上界，精确基线归上面那次热态 resume）。
    record(
      ctx, `thread-resume-ms（冷态：kill -9 整组重启后，粗上界 ${COLD_RESUME_MAX_MS}ms）`,
      resumed.opMs, `<= ${COLD_RESUME_MAX_MS}`, resumed.opMs <= COLD_RESUME_MAX_MS,
    )
    record(ctx, "thread-resume-same-id", resumed.threadId, thA.threadId, resumed.threadId === thA.threadId)

    const h4 = await client.turnStart({
      threadId: thA.threadId,
      text: "我在这条对话最开始让你记住的暗号是什么？只回复暗号本身，不要别的字。",
      nonce: runNonce,
      msgId: `${runNonce}-4`,
      timeoutMs: TURN_TIMEOUT_MS,
    })
    const o4 = await h4.done
    record(ctx, "recall-completed", o4.status, "completed", o4.status === "completed")
    record(
      ctx,
      "recall-secret-after-restart",
      o4.status === "completed" ? (o4.finalText ?? "").slice(0, 120) : o4.status,
      `含 ${secret}`,
      o4.status === "completed" && (o4.finalText ?? "").toUpperCase().includes(secret),
    )

    // --- 8. 事件表（协议漂移探测器） -----------------------------------------
    const wanted = ["thread/started", "turn/started", "item/completed", "thread/tokenUsage/updated", "turn/completed"]
    const missing = wanted.filter((m) => (ctx.events[m] ?? 0) === 0)
    record(ctx, "event-table-covered", missing.length === 0 ? "全有" : `缺 ${missing.join(",")}`, "全有", missing.length === 0)

    // --- 9. rollout 增长 ----------------------------------------------------
    rolloutPath = findRollout(info2.codexHome, thA.threadId, client.threadPath(thA.threadId) ?? rolloutPath)
    rolloutAfter = fileSize(rolloutPath)
    record(
      ctx,
      "rollout-bytes-grew",
      { before: rolloutBefore, after: rolloutAfter, path: rolloutPath },
      "after > before",
      rolloutBefore != null && rolloutAfter != null && rolloutAfter > rolloutBefore,
    )
  } catch (err) {
    if (err instanceof EarlyStop) {
      // 红门提前收尾：不是异常，是预期
    } else {
      const msg = err instanceof Error ? `${err.message}` : String(err)
      record(ctx, "no-unexpected-error", msg, "(无异常)", false)
      notes = notes ? `${notes}；异常：${msg}` : `异常：${msg}`
    }
  } finally {
    try {
      await client.stop()
    } catch {
      /* 已经没了 */
    }
    try {
      fs.rmSync(cwd, { recursive: true, force: true })
    } catch {
      /* 临时目录，删不掉不致命 */
    }
  }

  // rollout 兜底：红门档提前退出时也要有个数（真引擎必须能证明 rollout 长了）。
  // 放在 stop() 之后量，确保 codex 已经把这一轮刷进磁盘。
  if (rolloutAfter == null && codexHome && threadAId) {
    rolloutPath = findRollout(codexHome, threadAId, rolloutPath)
    rolloutAfter = fileSize(rolloutPath)
  }

  const wallMs = Date.now() - t0
  const allPass = ctx.assertions.length > 0 && ctx.assertions.every((a) => a.pass)
  // 证据里的 `passed` 口径必须和 Lane B/C 的写入器一致（e2e/lib/evidence.ts、e2e/lib/script-case.ts）：
  //   无变异 / 故障行为档 → assertions 全过
  //   红门档            → **变异真让它红了**才算过（此时 assertions 本来就该有红的）
  // 不统一的话，同一个字段在不同 case 里意思相反，汇总表只能靠人肉记住谁是谁 —— 那就不是机器判了。
  const passed = mode === "none" || !expectedRed ? allPass : !allPass
  const evidence: EvidenceRecord = {
    case: "E01",
    nonce: runNonce,
    startedAt,
    wallMs,
    events: ctx.events,
    rolloutBytesBefore: rolloutBefore,
    rolloutBytesAfter: rolloutAfter,
    assertions: ctx.assertions,
    mutation:
      mode === "none"
        ? null
        : {
            fault: mode === "started" ? "drop-turn-started" : "drop-serverrequest-default",
            expectedRed,
            // actualRed 看的是「assertions 有没有红」，不是 passed —— 红门档下这两个恰好相反
            actualRed: !allPass,
            note: notes || (expectedRed ? "红门：变异必须让 case 红" : "故障行为检查：变异下 assertions 仍须全过"),
          },
    notes,
    passed,
    lane: "A",
    phase: "integration",
    env: { relay: "none", appServer: "real" },
    contractVersion: CONTRACT_VERSION,
    codexVersion,
    hostname: os.hostname(),
    instanceId,
  }

  const outDir = process.env.CODEX_SEAT_E2E_OUT ?? path.join(__dirname, "..", "..", "..", "e2e", "evidence")
  fs.mkdirSync(outDir, { recursive: true })
  const suffix = mode === "none" ? "" : `-mutate-${mode}`
  const file = path.join(outDir, `E01${suffix}-${startedAt.replace(/[:.]/g, "-")}.json`)
  fs.writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`)

  const reallyRan = evidenceReallyRan(evidence)
  console.log(`\nE01 wallMs=${wallMs} events=${JSON.stringify(ctx.events)}`)
  console.log(`rollout ${rolloutBefore} → ${rolloutAfter} (${rolloutPath ?? "未找到"})`)
  console.log(`证据：${file}`)
  console.log(`passed=${passed} reallyRan=${reallyRan}` + (evidence.mutation ? ` mutation=${JSON.stringify(evidence.mutation)}` : ""))

  const gateOk = passed && reallyRan
  if (!gateOk) {
    console.error(mode === "none" || !expectedRed ? "E01 未通过" : "E01 红门没红：这个 case 没测到东西")
    process.exitCode = 1
  }
}

class EarlyStop extends Error {}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
