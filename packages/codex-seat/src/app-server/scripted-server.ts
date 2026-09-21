/**
 * 脚本化的假 app-server —— **测试夹具，不参与生产路径**。
 *
 * 它是一个真进程，说真的换行分隔 JSON-RPC 2.0，所以能验到假引擎验不到的东西：
 * 分帧、进程组、pid 文件、env 隔离、连接丢失。跑法：
 *
 *   CODEX_SCRIPTED_SCRIPT=<script.json> CODEX_SCRIPTED_TRACE=<trace.jsonl> \
 *     node dist/src/app-server/scripted-server.js app-server --listen stdio:// ...
 *
 * 测试侧一般再包一层 `#!/bin/sh` wrapper（**不用 exec**），复刻
 * `/opt/homebrew/bin/codex`(node wrapper) → rust 本体 的两层结构：只杀 wrapper
 * 会留孤儿，杀进程组才干净。
 *
 * trace.jsonl 每行一条：
 *   {"t":"env", argv, meshNode, meshDelegator, meshId, cwd, pid}
 *   {"t":"child", pid}                     // spawnChild 起的孙子进程
 *   {"t":"recv", method, id, params}       // 收到的每条客户端消息
 *   {"t":"serverRequestReply", id, reply}  // 客户端对我们的 ServerRequest 的应答
 */
import { spawn } from "node:child_process"
import fs from "node:fs"

// ---------------------------------------------------------------------------
// 脚本格式
// ---------------------------------------------------------------------------

export interface ScriptedItem {
  type: string
  text?: string
  server?: string
  tool?: string
  status?: string
  [k: string]: unknown
}

export interface ScriptedTurn {
  emitStarted?: boolean
  startedAfterMs?: number
  items?: ScriptedItem[]
  tokenUsage?: boolean
  completedAfterMs?: number
  status?: "completed" | "failed" | "interrupted"
  errorMessage?: string
  /** 收到 turn/interrupt 时立刻以 interrupted 收尾 */
  interruptible?: boolean
  /** turn/started 之后向客户端发一条 ServerRequest */
  serverRequest?: { method: string } | null
}

export interface ScriptedServerScript {
  banner?: string
  codexHome?: string
  /** 起一个 `sleep 300` 孙子进程，用来验进程组 kill */
  spawnChild?: boolean
  ignoreSigterm?: boolean
  /** 到点直接 exit(1)，模拟引擎中途死掉 */
  exitAfterMs?: number | null
  failThreadStart?: string | null
  failThreadResume?: string | null
  failTurnStart?: { code: number; message: string } | null
  /** 前几次提交被独立 Compact turn 占用；模拟 ACK 前到达的外来通知。 */
  compactBusyAttempts?: number
  turnAckDelayMs?: number
  dropCompleted?: boolean
  turn: ScriptedTurn
}

const VERSION_LINE = "codex-cli 0.0.0-scripted"

// ---------------------------------------------------------------------------
// 运行（只在被当成入口执行时跑；被 import 时只导出类型）
// ---------------------------------------------------------------------------

function main(): void {
  const argv = process.argv.slice(2)
  if (argv.includes("--version") || argv.includes("-V")) {
    process.stdout.write(`${VERSION_LINE}\n`)
    process.exit(0)
  }

  const scriptPath = process.env.CODEX_SCRIPTED_SCRIPT
  const tracePath = process.env.CODEX_SCRIPTED_TRACE ?? ""
  const script: ScriptedServerScript = scriptPath
    ? JSON.parse(fs.readFileSync(scriptPath, "utf8"))
    : ({ turn: {} } as ScriptedServerScript)

  const trace = (rec: Record<string, unknown>): void => {
    if (!tracePath) return
    try {
      fs.appendFileSync(tracePath, `${JSON.stringify(rec)}\n`)
    } catch {
      /* 测试夹具，写不进去就算了 */
    }
  }

  trace({
    t: "env",
    argv,
    meshNode: process.env.MESH_NODE ?? null,
    meshDelegator: process.env.MESH_DELEGATOR_NODE ?? null,
    meshId: process.env.MESH_ID ?? null,
    cwd: process.cwd(),
    pid: process.pid,
    codexHome: process.env.CODEX_HOME ?? null,
  })

  if (script.ignoreSigterm) process.on("SIGTERM", () => {})

  if (script.spawnChild) {
    // 同进程组的孙子：只杀 wrapper 时它会活下来，杀进程组时才一起走
    const kid = spawn("/bin/sleep", ["300"], { stdio: "ignore" })
    trace({ t: "child", pid: kid.pid })
  }

  if (script.exitAfterMs != null) {
    setTimeout(() => process.exit(1), script.exitAfterMs)
  }

  const say = (obj: unknown): void => {
    process.stdout.write(`${JSON.stringify(obj)}\n`)
  }
  const notify = (method: string, params: unknown): void => say({ jsonrpc: "2.0", method, params })
  const reply = (id: unknown, result: unknown): void => say({ jsonrpc: "2.0", id, result })
  const replyErr = (id: unknown, code: number, message: string): void =>
    say({ jsonrpc: "2.0", id, error: { code, message } })

  if (script.banner) process.stdout.write(`${script.banner}\n`)

  let threadSeq = 0
  let turnSeq = 0
  let compactBusyAttempts = script.compactBusyAttempts ?? 0
  let srSeq = 90_000
  const threads = new Set<string>()
  const completionTimers = new Map<string, NodeJS.Timeout>()
  const turnThread = new Map<string, string>()
  const turnSnapshots = new Map<string, Record<string, any>>()

  const t = script.turn ?? {}

  function runTurn(threadId: string, turnId: string): void {
    turnThread.set(turnId, threadId)
    const startedAfter = t.startedAfterMs ?? 5
    const emitStarted = t.emitStarted !== false
    setTimeout(() => {
      if (emitStarted) notify("turn/started", { threadId, turn: { id: turnId, status: "inProgress" } })
      for (const item of t.items ?? []) {
        notify("item/completed", { threadId, turnId, item: { id: `it-${turnId}`, ...item }, completedAtMs: Date.now() })
      }
      if (t.tokenUsage !== false) {
        const b = { totalTokens: 1234, inputTokens: 1000, cachedInputTokens: 0, outputTokens: 234, reasoningOutputTokens: 0 }
        notify("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: { total: b, last: b, modelContextWindow: 258_400 } })
      }
      if (t.serverRequest) {
        say({ jsonrpc: "2.0", id: srSeq++, method: t.serverRequest.method, params: {} })
      }
    }, startedAfter)

    const timer = setTimeout(() => {
      completionTimers.delete(turnId)
      const status = t.status ?? "completed"
      const snapshot = turnSnapshots.get(turnId)
      if (snapshot) { snapshot.status = status; snapshot.items.push(...(t.items ?? [])); snapshot.error = status === "failed" ? { message: t.errorMessage ?? "scripted failure" } : null }
      if (script.dropCompleted) return
      notify("turn/completed", {
        threadId,
        turn: {
          id: turnId,
          status,
          error: status === "failed" ? { message: t.errorMessage ?? "scripted failure" } : null,
          items: (t.items ?? []).map((i) => ({ id: `it-${turnId}`, ...i })),
          durationMs: t.completedAfterMs ?? 10,
        },
      })
    }, (t.startedAfterMs ?? 5) + (t.completedAfterMs ?? 10))
    completionTimers.set(turnId, timer)
  }

  function handle(msg: any): void {
    trace({ t: "recv", method: msg.method, id: msg.id, params: msg.params })

    // 客户端对我们发起的 ServerRequest 的应答
    if (msg.method === undefined && msg.id !== undefined) {
      trace({ t: "serverRequestReply", id: msg.id, reply: { result: msg.result, error: msg.error } })
      return
    }
    if (msg.id === undefined) return // 通知（initialized 之类），记完就完

    switch (msg.method) {
      case "initialize":
        reply(msg.id, {
          userAgent: "scripted-app-server",
          codexHome: script.codexHome ?? "/tmp/scripted-codex-home",
          platformFamily: "unix",
          platformOs: process.platform,
        })
        return

      case "thread/start": {
        if (script.failThreadStart) return replyErr(msg.id, -32000, script.failThreadStart)
        const id = `th-${++threadSeq}`
        threads.add(id)
        reply(msg.id, { thread: { id, path: null, cwd: msg.params?.cwd ?? null }, model: "scripted-model", cwd: msg.params?.cwd ?? null })
        notify("thread/started", { thread: { id } })
        return
      }

      case "thread/resume": {
        if (script.failThreadResume) return replyErr(msg.id, -32000, script.failThreadResume)
        const id = String(msg.params?.threadId ?? `th-${++threadSeq}`)
        threads.add(id)
        reply(msg.id, { thread: { id, path: null }, model: "scripted-model", cwd: msg.params?.cwd ?? null })
        return
      }

      case "turn/start": {
        if (script.failTurnStart) return replyErr(msg.id, script.failTurnStart.code, script.failTurnStart.message)
        if (compactBusyAttempts-- > 0) {
          const threadId = String(msg.params?.threadId ?? "")
          const turnId = `compact-${compactBusyAttempts}`
          notify("turn/started", { threadId, turn: { id: turnId, status: "inProgress" } })
          setTimeout(() => notify("turn/completed", { threadId, turn: { id: turnId, status: "completed", items: [] } }), 20)
          return replyErr(msg.id, -32603, "failed to submit turn input: ActiveTurnNotSteerable { turn_kind: Compact }")
        }
        const turnId = `tu-${++turnSeq}`
        const threadId = String(msg.params?.threadId ?? "")
        turnSnapshots.set(turnId, { id: turnId, status: "inProgress", items: [{ type: "userMessage", content: msg.params?.input ?? [] }] })
        if (script.turnAckDelayMs) setTimeout(() => reply(msg.id, { turn: { id: turnId, status: "inProgress", items: [] } }), script.turnAckDelayMs)
        else reply(msg.id, { turn: { id: turnId, status: "inProgress", items: [] } })
        runTurn(threadId, turnId)
        return
      }

      case "turn/interrupt": {
        reply(msg.id, {})
        const turnId = String(msg.params?.turnId ?? "")
        const timer = completionTimers.get(turnId)
        if (t.interruptible && timer) {
          clearTimeout(timer)
          completionTimers.delete(turnId)
          notify("turn/completed", {
            threadId: turnThread.get(turnId) ?? msg.params?.threadId,
            turn: { id: turnId, status: "interrupted", error: null, items: [], durationMs: 1 },
          })
        }
        return
      }

      case "thread/loaded/list":
        reply(msg.id, { data: [...threads], nextCursor: null })
        return

      case "thread/read":
        reply(msg.id, { thread: { id: msg.params?.threadId, turns: [...turnSnapshots.values()].filter((t) => turnThread.get(t.id) === msg.params?.threadId) } })
        return

      case "thread/compact/start":
        reply(msg.id, {})
        notify("thread/compacted", { threadId: msg.params?.threadId, turnId: `tu-${turnSeq}` })
        return

      case "account/rateLimits/read":
        reply(msg.id, {
          rateLimits: {
            limitId: "codex",
            limitName: "Codex",
            planType: "pro",
            primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_800_000_000 },
            secondary: { usedPercent: 34, windowDurationMins: 10_080, resetsAt: 1_800_500_000 },
          },
          rateLimitsByLimitId: {
            codex: {
              limitId: null,
              limitName: "Codex",
              planType: "pro",
              primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_800_000_000 },
              secondary: null,
            },
          },
          rateLimitResetCredits: null,
        })
        return

      case "account/read":
        reply(msg.id, {
          account: { type: "chatgpt", email: "scripted@example.com", planType: "pro" },
          requiresOpenaiAuth: false,
        })
        return

      default:
        replyErr(msg.id, -32601, `scripted server 不认识 ${msg.method}`)
    }
  }

  let buf = ""
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk: string) => {
    buf += chunk
    for (;;) {
      const i = buf.indexOf("\n")
      if (i === -1) break
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line.startsWith("{")) continue
      try {
        handle(JSON.parse(line))
      } catch {
        /* 坏帧忽略 */
      }
    }
  })
  process.stdin.on("end", () => process.exit(0))
}

if (require.main === module) main()
