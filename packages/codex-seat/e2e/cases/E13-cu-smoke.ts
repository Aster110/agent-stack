/**
 * E13 —— Computer Use smoke（CU 的 REPL MCP 真的拉起来了）。
 *
 * 只做**只读探查**：`js_reset` → `import('@oai/sky')` → `sky.listApps()` → 回 `nonce-<count>`。
 * 🔴 不截图、不导航、不点击、不开浏览器 —— CU 在本 case 里只用来证明 MCP 通了。
 *
 * 实测事实（2026-09-02 computer2 codex-cli 0.151.0，这个 case 前后被坑了三次，逐条记下来）：
 *   1. **server 自报名是 `cua_repl`**，不是配置键里的 `node_repl`（工具来自插件
 *      `unified-computer-use@openai-bundled`）。提示词里写 "node_repl"，模型找不到这个工具，
 *      会一声不吭地按"我没有工具"作答 —— 于是 baseline 和变异长得一模一样，这个 case 什么都没测到。
 *   2. **`-c` 关不掉它**：`mcp_servers.node_repl.enabled=false`、`features.js_repl=false`、
 *      `plugins."unified-computer-use@openai-bundled".enabled=false` 三种都实测过，
 *      工具照样在、模型照样调。契约 `FAULT_NAMES` 里 `disable-node-repl` 描述的那个开关**是无效的**。
 *   3. 唯一验证有效的关法：把 `CODEX_HOME` 指到一个**只有 auth.json、没有 config.toml** 的目录，
 *      MCP 一个都不加载（实测模型回 PROBE-NOTOOL，mcpToolCall=0）。本 case 的红门用的就是它。
 *   4. `@oai/sky` 导出的是 `{ sky }`，且**没有** `listApps()`；提示词写死 API 名会让模型空转到报 0。
 *
 * 数字：≤180s；mcpToolCall 计数 ≥4，其中 status=completed ≥3。
 * 变异（红门，external）：CODEX_HOME 换成只有 auth.json 的裸目录 → mcpToolCall 必须为 0，case 必须红。
 *
 * 证据用**两个独立源**对齐：sidecar 自己记的 `mcpToolCall` 日志行，和 rollout 文件里的 `mcp__<server>`。
 * 只信自己写的计数器 = 自己给自己开证明。
 */
import fs from "node:fs"
import path from "node:path"

import { parseReceipt } from "../../src/contracts.js"
import { strippedCodexHome } from "../lib/orphan.js"
import { Probe } from "../lib/probe.js"
import { startPrivateRelay } from "../lib/relay.js"
import {
  REAL_CODEX_HOME,
  assertion,
  buildEvidence,
  logEventCounts,
  makeSeatEnv,
  parseMutateArg,
  readState,
  reportAndExit,
  rolloutBytesFor,
  startSeatProcess,
  writeEvidence,
} from "../lib/script-case.js"
import { hex, waitFor } from "../lib/util.js"

const CASE_BUDGET_MS = 180_000
const MIN_MCP_TOOL_CALLS = 4
const MIN_MCP_COMPLETED = 3
/** 服务端自报名（配置键叫 node_repl，自报叫 cua_repl —— 两个都认） */
const REPL_SERVERS = ["cua_repl", "node_repl"]

/**
 * 提示词说明：第一版写死了 `sky.listApps()`，实测该模块导出的是 `{ sky }` 且没有这个方法，
 * 模型在那儿反复试错 19 次最后报 0 —— case 红在提示词上，跟 CU 通不通没关系。
 * 所以这里**不写死 API 名**，让模型自己用 `Object.keys` 探，只要求它最后报一个数字。
 */
const PROMPT = (nonce: string): string => [
  "只用 cua_repl 这个 MCP 工具做只读探查（工具名 js_reset / js），不要截图、不要导航、不要点任何东西：",
  "1) 调用 js_reset 重置 REPL；",
  "2) 执行 `const m = await import('@oai/sky')`；",
  "3) 用 `nodeRepl.write(Object.keys(m))` / `Object.keys(m.sky)` 自己探出「列出当前运行的 app」的那个方法名（可能叫 listApps / apps / getApps / runningApps 之类），别猜，探到为止；",
  "4) 调用它拿到列表，取长度。",
  `最后只回一行：${nonce}-<那个长度数字>，别的什么都不要说。探不出来就回 ${nonce}-0。`,
].join("\n")

/**
 * 从 rollout 文件里数 mcpToolCall —— 独立于我们自己的日志的物证。
 * （只看自己写的计数器，等于自己给自己开证明。）
 */
function countMcpToolCallsInRollout(threadId: string | null, codexHome: string = REAL_CODEX_HOME): { total: number; nodeRepl: number; completed: number } {
  if (!threadId) return { total: 0, nodeRepl: 0, completed: 0 }
  // codexHome 必须是席位真正在用的那个：红门档把 CODEX_HOME 换成了裸目录，
  // 在 REAL_CODEX_HOME 里当然一个 rollout 都找不到 —— 那时候的 0 是「找错目录」，
  // 不是「CU 被关掉了」，红门就红得毫无意义。
  const root = path.join(codexHome, "sessions")
  const stack = [root]
  let file: string | null = null
  while (stack.length > 0 && !file) {
    const dir = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.isFile() && e.name.includes(threadId)) {
        file = full
        break
      }
    }
  }
  if (!file) return { total: 0, nodeRepl: 0, completed: 0 }
  // rollout 里工具名写成 `mcp__<server>`（实测：`"mcp__cua_repl"`）
  const text = fs.readFileSync(file, "utf-8")
  const total = (text.match(/mcp__[a-z0-9_]+/gi) ?? []).length
  const nodeRepl = REPL_SERVERS.reduce((acc, srv) => acc + (text.match(new RegExp(`mcp__${srv}`, "g")) ?? []).length, 0)
  // "McpToolCall … status: completed" —— 真的跑成功过，不只是被调用
  let completed = 0
  for (const line of text.split("\n")) {
    if (!line.includes('"McpToolCall"')) continue
    if (REPL_SERVERS.some((s2) => new RegExp(`"server"\\s*:\\s*"${s2}"`).test(line)) && /"status"\s*:\s*"completed"/.test(line)) completed++
  }
  return { total, nodeRepl, completed }
}

export async function run(argv: readonly string[]): Promise<number> {
  const mutate = parseMutateArg(argv)
  const startedAt = Date.now()
  const nonce = `E13-${hex(3)}`
  const assertions = []
  const events: Record<string, number> = {}
  let notes = ""
  let rolloutBefore = 0
  let rolloutAfter: number | null = null

  const relay = await startPrivateRelay()
  // cwd 是干净的临时目录（makeSeatEnv 已经建好），CU 探查不该依赖仓库内容
  // 红门：CODEX_HOME 换成只有 auth.json 的裸目录 —— 唯一实测有效的 CU 关闭方式
  const env = makeSeatEnv(relay, mutate.on ? { codexHome: strippedCodexHome() } : {})
  const seat = startSeatProcess(env)
  let threadId: string | null = null
  try {
    const probe = await Probe.start(relay.url)
    const st = await waitFor(() => {
      const s = readState(env)
      return s?.mainThreadId ? s : null
    }, 120_000, "席位就绪", 500)
    threadId = st.mainThreadId
    rolloutBefore = rolloutBytesFor(threadId, env.config.codex.home ?? undefined) ?? 0
    process.stdout.write(`[E13] seat=${env.seat} thread=${threadId} cwd=${env.cwd} codexHome=${env.config.codex.home}\n`)

    const t0 = Date.now()
    await probe.send(env.nodeId, PROMPT(nonce))
    const all = await probe.collect(
      (a) => a.some((m) => {
        const r = parseReceipt(String(m.payload ?? ""))
        return r?.kind === "done" || r?.kind === "failed"
      }),
      CASE_BUDGET_MS,
    )
    const wallMs = Date.now() - t0
    const done = all.map((m) => parseReceipt(String(m.payload ?? ""))).find((r) => r?.kind === "done") as
      | { kind: "done"; body: string; ms: number }
      | undefined
    const body = done?.body ?? ""
    process.stdout.write(`[E13] done=${Boolean(done)} wallMs=${wallMs} body=${JSON.stringify(body.slice(0, 200))}\n`)

    const counts = countMcpToolCallsInRollout(threadId, env.config.codex.home ?? undefined)
    events["rollout.mcpToolCall"] = counts.total
    events["rollout.mcpToolCall.repl"] = counts.nodeRepl
    events["rollout.mcpToolCall.completed"] = counts.completed
    // sidecar 日志里的计数只是参考：Lane B 的席位核心用自己的日志格式，
    // 不一定有 mcpToolCall 这一行。**主证据是 rollout**（引擎自己写的，不受我们代码影响）。
    const logCounts = logEventCounts(env)
    const liveMcp = logCounts["mcpToolCall"] ?? 0
    events["live.mcpToolCall"] = liveMcp
    process.stdout.write(`[E13] mcpToolCall rollout=${counts.nodeRepl}/${counts.total} live=${liveMcp}\n`)

    // nonce-<count>：取回答里 nonce 后面的数字
    const m = new RegExp(`${nonce}-(\\d+)`).exec(body)
    const appCount = m ? Number(m[1]) : null

    assertions.push(assertion("≤180s 拿到 [done]", Boolean(done), Boolean(done), true))
    assertions.push(assertion(`rollout 里 mcpToolCall(${REPL_SERVERS.join("|")}) ≥${MIN_MCP_TOOL_CALLS}`, counts.nodeRepl >= MIN_MCP_TOOL_CALLS, counts.nodeRepl, `>=${MIN_MCP_TOOL_CALLS}`))
    // 确定性硬门：CU 真的**执行成功**过若干次（不依赖模型答对 @oai/sky 的 API 名）
    assertions.push(assertion(`rollout 里 status=completed 的 mcpToolCall ≥${MIN_MCP_COMPLETED}（CU 真跑通了）`, counts.completed >= MIN_MCP_COMPLETED, counts.completed, `>=${MIN_MCP_COMPLETED}`))
    // appCount 只当指标记录：@oai/sky 的列举 API 名在本版本上模型探不稳（实测反复报 0），
    // 拿它当硬门会让这个 case 变成掷骰子。见报告里的设计稿修改申请。
    events["appCount"] = appCount ?? -1
    // 红门档下所有 mcp 计数都是 0；补一个恒非零的事件，
    // 免得「事件计数非空」这条三证据把一个**本来就该红**的档误判成"没跑过"
    events["receipt.done"] = done ? 1 : 0
    events["turns"] = 1
    assertions.push(assertion("模型报回了 nonce-<数字>（闭环走通）", appCount != null, appCount, "一个数字"))
    assertions.push(assertion("正文里带回 nonce", body.includes(nonce), body.slice(0, 80), `含 ${nonce}`))

    Object.assign(events, logEventCounts(env))
    rolloutAfter = rolloutBytesFor(threadId, env.config.codex.home ?? undefined)
  } catch (e) {
    notes += `异常: ${String((e as Error).message ?? e)}；`
    assertions.push(assertion("跑完没抛异常", false, String((e as Error).message ?? e), "no throw"))
    Object.assign(events, logEventCounts(env))
  } finally {
    seat.stop()
    await relay.stop()
  }

  assertions.push(assertion(
    "rollout 增长（模型真跑过）",
    rolloutAfter != null && rolloutAfter > rolloutBefore,
    { before: rolloutBefore, after: rolloutAfter }, "after > before",
  ))

  const allPass = assertions.every((a) => a.pass)
  const rec = buildEvidence({
    caseId: "E13",
    nonce,
    startedAt,
    events,
    assertions,
    mutation: mutate.on
      ? { fault: "external", expectedRed: true, actualRed: !allPass, note: "CODEX_HOME 只留 auth.json（唯一实测有效的 CU 关法），mcpToolCall 必须归零" }
      : null,
    notes: `${notes}seat=${env.seat} cwd=${env.cwd} codexHome=${env.config.codex.home}（只读探查 js_reset → js，无截图/导航/点击）`,
    env: { relay: "real", appServer: "real" },
    instanceId: readState(env)?.instanceId ?? null,
    codexVersion: readState(env)?.codexVersion ?? null,
    rolloutBytesBefore: rolloutBefore,
    rolloutBytesAfter: rolloutAfter,
    passed: mutate.on ? !allPass : allPass,
  })
  const file = writeEvidence(rec, mutate.on ? (mutate.mode ?? "external") : null)
  return reportAndExit(rec, file)
}

if (require.main === module) {
  void run(process.argv.slice(2)).then((c) => process.exit(c))
}
