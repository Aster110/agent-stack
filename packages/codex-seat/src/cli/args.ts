/**
 * CLI 参数解析。纯函数，不碰 fs/进程 —— 好测，也保证 `main.ts` 里没有藏起来的分支。
 * `CliCommand` / `EXIT_CODES` 是冻结契约；`--config` 不在 CliCommand 里，单独放 `configPath`。
 */
import path from "node:path"

import { EXIT_CODES, isValidSeatName, type CliCommand } from "../contracts.js"

export interface ParsedCli {
  ok: true
  cmd: CliCommand
  /** --config <path>：覆盖 seatPaths().config */
  configPath: string | null
}

export interface ParseError {
  ok: false
  error: string
  exitCode: number
}

const COMMANDS = new Set(["init", "install", "uninstall", "status", "run", "resume-cursor", "help"])

const BOOL_FLAGS = new Set(["--json", "--dry-run", "--force"])
const VALUE_FLAGS = new Set(["--seat", "--cwd", "--config", "--to"])

export const USAGE = `codex-seat —— cc-mesh 常驻 codex 席位（app-server 引擎 + 薄 sidecar）

用法:
  codex-seat init      --seat <name> [--cwd <dir>] [--force]
  codex-seat install   --seat <name> [--dry-run] [--config <file>]
  codex-seat uninstall --seat <name> [--dry-run]
  codex-seat status    --seat <name> [--json] [--config <file>]
  codex-seat run       --seat <name> [--config <file>]
  codex-seat resume-cursor --seat <name> --to head|<seq> [--force] [--config <file>]

席位名: ^[a-z0-9][a-z0-9-]{0,31}$
退出码: 0 正常 / 2 用法错 / 3 缺配置 / 4 relay 不可达 / 5 引擎不健康 / 6 熔断中（重放风暴）

resume-cursor 是防线 3 熔断后的**人工**解锁：把游标顶到 relay 头（--to head）或指定 seq，
清掉 paused。跑之前先停 sidecar（launchctl bootout），否则它会覆写 state.json。`

function err(msg: string): ParseError {
  return { ok: false, error: msg, exitCode: EXIT_CODES.usage }
}

export function parseCli(argv: readonly string[]): ParsedCli | ParseError {
  if (argv.length === 0) return { ok: true, cmd: { cmd: "help" }, configPath: null }
  const head = argv[0]!
  if (head === "--help" || head === "-h" || head === "help") {
    return { ok: true, cmd: { cmd: "help" }, configPath: null }
  }
  if (!COMMANDS.has(head)) return err(`未知命令: ${head}`)

  const flags: Record<string, string | boolean> = {}
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!
    if (BOOL_FLAGS.has(a)) {
      flags[a] = true
      continue
    }
    if (VALUE_FLAGS.has(a)) {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith("--")) return err(`${a} 缺少取值`)
      flags[a] = v
      i++
      continue
    }
    return err(`未知参数: ${a}`)
  }

  const seat = typeof flags["--seat"] === "string" ? flags["--seat"] : null
  if (!seat) return err(`${head} 需要 --seat <name>`)
  if (!isValidSeatName(seat)) return err(`席位名不合法: ${seat}（^[a-z0-9][a-z0-9-]{0,31}$）`)

  const cwd = typeof flags["--cwd"] === "string" ? flags["--cwd"] : null
  if (cwd && !path.isAbsolute(cwd)) return err(`--cwd 必须是绝对路径: ${cwd}`)
  const configPath = typeof flags["--config"] === "string" ? flags["--config"] : null
  if (configPath && !path.isAbsolute(configPath)) return err(`--config 必须是绝对路径: ${configPath}`)

  const toRaw = typeof flags["--to"] === "string" ? flags["--to"] : null
  const json = flags["--json"] === true
  const dryRun = flags["--dry-run"] === true
  const force = flags["--force"] === true

  switch (head) {
    case "init":
      return { ok: true, cmd: { cmd: "init", seat, cwd, force }, configPath }
    case "install":
      return { ok: true, cmd: { cmd: "install", seat, dryRun }, configPath }
    case "uninstall":
      return { ok: true, cmd: { cmd: "uninstall", seat, dryRun }, configPath }
    case "status":
      return { ok: true, cmd: { cmd: "status", seat, json }, configPath }
    case "run":
      return { ok: true, cmd: { cmd: "run", seat }, configPath }
    case "resume-cursor": {
      if (toRaw == null) return err("resume-cursor 需要 --to head|<seq>")
      if (toRaw === "head") return { ok: true, cmd: { cmd: "resume-cursor", seat, to: "head", force }, configPath }
      // 只认非负整数：'-1' / '1.5' / 'tail' 一律拒（游标写错等于静默跳过或重放一段历史）
      if (!/^\d+$/.test(toRaw)) return err(`--to 只能是 head 或非负整数: ${toRaw}`)
      return { ok: true, cmd: { cmd: "resume-cursor", seat, to: Number(toRaw), force }, configPath }
    }
  }
  return err(`未知命令: ${head}`)
}
