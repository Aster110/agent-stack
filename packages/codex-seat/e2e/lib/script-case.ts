/**
 * 脚本式 case 的支架：私有 HOME 的席位环境、前台席位进程、状态/日志读取、证据构建与打印。
 *
 * 原 `e2e/laneC/harness.ts`，2026-09-02 集成时折进 lib/。
 * 跟 `lib/case.ts` 的区别：那边是 runner 驱动的 `withCase()` 骨架（E02..E06 等），
 * 这边是自带 `main()`、自己写证据自己退出的脚本式 case（E07/E08/E09/E13/E14/E18）。
 *
 * 隔离红线（抄 packages/relay/e2e/sse-pull.e2e.test.sh）：
 *   随机端口且断言 ≠19800、HOME=<tmp>、MESH_DB_PATH=<tmp>、MESH_DEVICE_ID=e2edev、无 MESH_HUB_URL。
 *   **绝不碰生产 :19800、默认 tmux server、com.aster.mesh-* 三个 launchd job。**
 *
 * ⚠️ `hex()` 的单位：lib/util.ts 的 `hex(n)` 出 **2n** 个十六进制字符，
 *    原 harness 的 `hex(n)` 出 **n** 个。所以搬过来时 `hex(4)`→`hex(2)`、`hex(6)`→`hex(3)`，
 *    产物长度与原来逐字相同 —— 别"修"回去：席位名的 4 hex 是 `assertSafeLabel` 的硬校验形状。
 */
import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  CONTRACT_VERSION,
  evidenceReallyRan,
  seatPaths,
  type E2ECaseId,
  type EvidenceAssertion,
  type EvidenceRecord,
  type EvidenceMutation,
  type SeatConfig,
} from "../../src/contracts.js"
import { defaultSeatConfig } from "../../src/cli/config.js"
import { countSeatLogEvents } from "../../src/seat/log-events.js"
import { outDir } from "./evidence.js"
import { PROBE_SHORT_ID } from "./probe.js"
import { E2E_DEVICE_ID, type PrivateRelay } from "./relay.js"
import { hex } from "./util.js"

/** 进程起来时的真实 HOME（后面 makeSeatEnv 会把 HOME 换成私有 tmp，这里先存下来） */
export const REAL_HOME = os.homedir()
export const REAL_CODEX_HOME = process.env.CODEX_HOME ?? path.join(REAL_HOME, ".codex")

/** 被测席位名恒为 e2e-<4hex>：跟生产席位（codex-main / codex-main2）永不重名 */
export function e2eSeatName(): string {
  return `e2e-${hex(2)}`
}

// ---------------------------------------------------------------------------
// 路径（从 dist/e2e/lib/script-case.js 往上数）
// ---------------------------------------------------------------------------

export function repoRoot(): string {
  // dist/e2e/lib/script-case.js → 包根 → 仓库根
  return path.resolve(__dirname, "..", "..", "..", "..", "..")
}

export function packageRoot(): string {
  return path.resolve(__dirname, "..", "..", "..")
}

// ---------------------------------------------------------------------------
// 席位环境（私有 HOME + 配置）
// ---------------------------------------------------------------------------

export interface SeatEnv {
  seat: string
  home: string
  cwd: string
  config: SeatConfig
  configPath: string
  paths: ReturnType<typeof seatPaths>
  nodeId: string
}

export function makeSeatEnv(
  relay: PrivateRelay,
  opts: { seat?: string; hubUrl?: string; hubEnabled?: boolean; extraArgs?: string[]; codexHome?: string } = {},
): SeatEnv {
  const seat = opts.seat ?? e2eSeatName()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `codex-seat-home-${seat}-`))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `codex-seat-cwd-${seat}-`))
  const p = seatPaths(seat, home)
  fs.mkdirSync(p.logDir, { recursive: true, mode: 0o700 })
  const cfg = defaultSeatConfig(seat, cwd)
  cfg.deviceId = E2E_DEVICE_ID
  cfg.relayUrl = relay.url
  // 引擎必须用**真** CODEX_HOME：auth.json 和 mcp_servers.node_repl 都在那儿。
  // 私有 HOME 只隔离席位自己的 config/state/wal/log，不隔离 codex 凭据（隔了就没法跑真引擎）。
  cfg.codex.home = opts.codexHome ?? REAL_CODEX_HOME
  if (opts.extraArgs) cfg.codex.extraArgs = [...opts.extraArgs]
  cfg.allowlist.extra = [`*:${PROBE_SHORT_ID}`]
  cfg.hub.enabled = opts.hubEnabled ?? false
  if (opts.hubUrl) cfg.hub.ledgerUrl = opts.hubUrl
  cfg.hub.tokenFile = path.join(home, ".ccmesh", "hub-token")
  cfg.hub.intervalSec = 10
  cfg.turn.timeoutMs = 180_000
  cfg.sync.timeoutSec = 5
  fs.mkdirSync(path.dirname(cfg.hub.tokenFile), { recursive: true, mode: 0o700 })
  fs.writeFileSync(cfg.hub.tokenFile, "e2e-fake-token\n", { mode: 0o600 })
  fs.writeFileSync(p.config, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 })
  return { seat, home, cwd, config: cfg, configPath: p.config, paths: p, nodeId: `${E2E_DEVICE_ID}:${seat}` }
}

export function cliMain(): string {
  return path.join(packageRoot(), "dist", "src", "cli", "main.js")
}

export interface SeatProc {
  proc: ChildProcess
  stop(): void
}

/** 直接前台跑 sidecar（不经托管器）。E08/E13/E14 用。 */
export function startSeatProcess(env: SeatEnv, extraEnv: NodeJS.ProcessEnv = {}): SeatProc {
  const logFd = fs.openSync(path.join(env.paths.logDir, "run.log"), "a")
  const proc = spawn(process.execPath, [cliMain(), "run", "--seat", env.seat], {
    env: { ...process.env, HOME: env.home, ...extraEnv },
    stdio: ["ignore", logFd, logFd],
    detached: true, // 独立进程组：停的时候能整组带走，不留孤儿
  })
  return {
    proc,
    stop() {
      try {
        if (proc.pid) process.kill(-proc.pid, "SIGTERM")
      } catch { /* 已经没了 */ }
      try {
        fs.closeSync(logFd)
      } catch { /* ignore */ }
    },
  }
}

export function readState(env: SeatEnv): any | null {
  try {
    return JSON.parse(fs.readFileSync(env.paths.state, "utf-8"))
  } catch {
    return null
  }
}

export function readRunLog(env: SeatEnv): string {
  try {
    return fs.readFileSync(path.join(env.paths.logDir, "run.log"), "utf-8")
  } catch {
    return ""
  }
}

/**
 * 从 sidecar 的 JSONL 日志里统计事件（证据 events 的来源之一）。
 * 前台跑落在 run.log，launchd 托管跑落在 plist 的 StandardOutPath（stdout.log）—— 两个都要读，
 * 只读一个就会在托管档下拿到空 events，然后「它真跑了」的证据凭空消失。
 */
export function logEventCounts(env: SeatEnv): Record<string, number> {
  // 三个来源都读：前台档写 run.log，launchd 托管档写 plist 的 StandardOutPath（stdout.log），
  // 而席位自己的结构化日志一律进 sidecar.jsonl —— 原先只读前两个、且认错了字段名（ev vs event），
  // 于是这把尺子一直返回 {}。计数逻辑已抽成 src/seat/log-events.ts 的纯函数，那边有单测作证。
  const parts = [readRunLog(env)]
  for (const f of [path.join(env.paths.logDir, "stdout.log"), env.paths.sidecarLog]) {
    try { parts.push(fs.readFileSync(f, "utf-8")) } catch { /* 该档没有这个文件 */ }
  }
  return countSeatLogEvents(parts.join("\n"))
}

/**
 * 真引擎的 rollout 字节（`evidenceReallyRan()` 三证据之一）。
 * 文件是 `<CODEX_HOME>/sessions/<Y>/<M>/<D>/rollout-<ts>-<threadId>.jsonl`。
 * 拿不到就返回 null —— 但真引擎档下 null 会让证据判定不通过，这是故意的：
 * 「模型真的跑过一轮」必须有独立于我们自己日志的物证。
 *
 * **codexHome 必须传席位真正在用的那个**（`env.config.codex.home`）。E13 的红门档把
 * CODEX_HOME 换成了只含 auth.json 的裸目录，写死 REAL_CODEX_HOME 就会在错误的目录里
 * 找不到文件、返回 null —— 那不是「模型没跑」，是尺子量错了地方，
 * 而它长得跟真发现一模一样（坏掉的工具会伪装成发现）。
 */
export function rolloutBytesFor(threadId: string | null | undefined, codexHome: string = REAL_CODEX_HOME): number | null {
  if (!threadId) return null
  const root = path.join(codexHome, "sessions")
  const stack = [root]
  while (stack.length > 0) {
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
        try {
          return fs.statSync(full).size
        } catch {
          return null
        }
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// 证据
// ---------------------------------------------------------------------------

export interface EvidenceInput {
  caseId: E2ECaseId
  nonce: string
  startedAt: number
  events: Record<string, number>
  assertions: EvidenceAssertion[]
  mutation: EvidenceMutation | null
  notes: string
  env: EvidenceRecord["env"]
  phase?: EvidenceRecord["phase"]
  codexVersion?: string | null
  instanceId?: string | null
  rolloutBytesBefore?: number | null
  rolloutBytesAfter?: number | null
  /** 显式覆盖 passed（红门变异档：case 该红就是红） */
  passed?: boolean
}

export function buildEvidence(i: EvidenceInput): EvidenceRecord {
  const wallMs = Date.now() - i.startedAt
  const allPass = i.assertions.every((a) => a.pass)
  return {
    case: i.caseId,
    nonce: i.nonce,
    startedAt: new Date(i.startedAt).toISOString(),
    wallMs,
    events: i.events,
    rolloutBytesBefore: i.rolloutBytesBefore ?? null,
    rolloutBytesAfter: i.rolloutBytesAfter ?? null,
    assertions: i.assertions,
    mutation: i.mutation,
    notes: i.notes,
    passed: i.passed ?? allPass,
    lane: "C",
    phase: i.phase ?? "e2e",
    env: i.env,
    contractVersion: CONTRACT_VERSION,
    codexVersion: i.codexVersion ?? null,
    hostname: os.hostname(),
    instanceId: i.instanceId ?? null,
  }
}

export function writeEvidence(rec: EvidenceRecord, mutateMode?: string | null): string {
  const dir = outDir()
  fs.mkdirSync(dir, { recursive: true })
  const suffix = mutateMode ? `-mutate-${mutateMode}` : ""
  const file = path.join(dir, `${rec.case}${suffix}-${rec.startedAt.replace(/[:.]/g, "-")}.json`)
  fs.writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`)
  return file
}

/** 打印「它真跑了」的三证据 + 断言表；返回进程退出码 */
export function reportAndExit(rec: EvidenceRecord, file: string): number {
  const ran = evidenceReallyRan(rec)
  process.stdout.write(`\n=== ${rec.case}${rec.mutation ? ` [mutate ${rec.mutation.fault}]` : ""} ===\n`)
  process.stdout.write(`wallMs=${rec.wallMs}  events=${JSON.stringify(rec.events)}\n`)
  for (const a of rec.assertions) {
    process.stdout.write(`  ${a.pass ? "✓" : "✗"} ${a.name}  actual=${JSON.stringify(a.actual)} expected=${JSON.stringify(a.expected)}\n`)
  }
  if (rec.mutation) {
    process.stdout.write(`  mutation expectedRed=${rec.mutation.expectedRed} actualRed=${rec.mutation.actualRed}${rec.mutation.note ? ` (${rec.mutation.note})` : ""}\n`)
  }
  process.stdout.write(`evidenceReallyRan=${ran}  passed=${rec.passed}\n证据: ${file}\n`)
  if (!ran) {
    process.stdout.write("✗ 证据没过 evidenceReallyRan()：墙钟/事件计数/rollout 三证据缺一 —— 这次不算跑过\n")
    return 1
  }
  return rec.passed ? 0 : 1
}

export interface MutateArg {
  on: boolean
  mode: string | null
}

export function parseMutateArg(argv: readonly string[]): MutateArg {
  for (const a of argv) {
    if (a === "--mutate") return { on: true, mode: null }
    if (a.startsWith("--mutate=")) return { on: true, mode: a.slice("--mutate=".length) }
  }
  return { on: false, mode: null }
}

export function assertion(name: string, pass: boolean, actual: unknown, expected: unknown): EvidenceAssertion {
  return { name, pass, actual, expected }
}
