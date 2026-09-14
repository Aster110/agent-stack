/**
 * 席位配置文件读写与校验：`~/.ccmesh/codex-seat/<seat>/config.json`。
 *
 * 校验不是形式主义：配置错了 launchd 会一直重启一个必然失败的进程（KeepAlive 循环），
 * 日志刷爆而 `launchctl list` 全绿。所以 `install` 前必须先把配置挑穿。
 */
import fs from "node:fs"
import path from "node:path"

import { SEAT_CONFIG_DEFAULTS, isValidSeatName, seatPaths, type SeatConfig } from "../contracts.js"

export class ConfigError extends Error {
  constructor(message: string, readonly exitCode: number) {
    super(message)
  }
}

/**
 * 席位标签**不再**塞进 `codex.extraArgs`（施工期的绕法，2026-09-02 集成时删）。
 * 现在由 `RealAppServerClient` 在 spawn 时统一调 `buildAppServerArgs(seat, instanceId, extraArgs)` 打，
 * 标签恒为 `codex_seat.tag="<seat>/<instanceId>"`，实例级精度，且不管引擎从哪条路径起都有。
 * 走配置塞的老办法只覆盖「读了 config.json」这一条路径，e2e / 直接 new 的路径全漏。
 */
export function defaultSeatConfig(seat: string, cwd: string): SeatConfig {
  // 深拷贝：SEAT_CONFIG_DEFAULTS 是共享常量，直接展开会让两个席位共用同一个 hub 对象
  const d = JSON.parse(JSON.stringify(SEAT_CONFIG_DEFAULTS)) as Omit<SeatConfig, "seat" | "cwd">
  return { ...d, seat, cwd }
}

export type ValidateResult =
  | { ok: true; config: SeatConfig }
  | { ok: false; errors: string[] }

function isHttpUrl(s: unknown): boolean {
  if (typeof s !== "string") return false
  try {
    const u = new URL(s)
    return u.protocol === "http:" || u.protocol === "https:"
  } catch {
    return false
  }
}

/** @param expectSeat 传了就校验 config.seat 与之一致（防 install 装错席位） */
export function validateSeatConfig(raw: unknown, expectSeat?: string): ValidateResult {
  const e: string[] = []
  if (!raw || typeof raw !== "object") return { ok: false, errors: ["config 不是对象"] }
  const c = raw as Record<string, any>

  if (c.version !== 1) e.push(`version 必须是 1，当前 ${JSON.stringify(c.version)}`)
  if (typeof c.seat !== "string" || !isValidSeatName(c.seat)) e.push(`seat 不合法: ${JSON.stringify(c.seat)}`)
  else if (expectSeat && c.seat !== expectSeat) e.push(`seat "${c.seat}" 与 --seat "${expectSeat}" 不一致`)
  if (typeof c.cwd !== "string" || !path.isAbsolute(c.cwd)) e.push(`cwd 必须是绝对路径: ${JSON.stringify(c.cwd)}`)
  if (!isHttpUrl(c.relayUrl)) e.push(`relayUrl 必须是 http(s) URL: ${JSON.stringify(c.relayUrl)}`)

  if (!c.hub || typeof c.hub !== "object") e.push("hub 缺失")
  else {
    if (!isHttpUrl(c.hub.ledgerUrl)) e.push("hub.ledgerUrl 必须是 http(s) URL")
    if (typeof c.hub.tokenFile !== "string" || !path.isAbsolute(c.hub.tokenFile)) e.push("hub.tokenFile 必须是绝对路径")
    if (typeof c.hub.intervalSec !== "number" || c.hub.intervalSec < 10) e.push("hub.intervalSec 至少 10")
    if (typeof c.hub.enabled !== "boolean") e.push("hub.enabled 必须是布尔")
  }

  if (!c.codex || typeof c.codex !== "object") e.push("codex 缺失")
  else {
    if (c.codex.bin != null && (typeof c.codex.bin !== "string" || !path.isAbsolute(c.codex.bin))) {
      e.push("codex.bin 要么 null 要么绝对路径")
    }
    for (const field of ["model", "reasoningEffort"]) {
      if (c.codex[field] != null && (typeof c.codex[field] !== "string" || c.codex[field].trim().length === 0)) {
        e.push(`codex.${field} 要么不写/null，要么是非空字符串`)
      }
    }
    if (!Array.isArray(c.codex.extraArgs)) e.push("codex.extraArgs 必须是数组")
    else if (c.codex.extraArgs.includes("--remote-control")) e.push("codex.extraArgs 里不许有 --remote-control（红线）")
  }

  if (!c.allowlist || !Array.isArray(c.allowlist.extra)) e.push("allowlist.extra 必须是数组")
  if (!c.worker || (c.worker.procMode !== "shared" && c.worker.procMode !== "dedicated")) {
    e.push("worker.procMode 只能是 shared / dedicated")
  }
  if (!c.compact || typeof c.compact.thresholdRatio !== "number" || c.compact.thresholdRatio <= 0 || c.compact.thresholdRatio >= 1) {
    e.push("compact.thresholdRatio 必须在 (0,1)")
  }
  if (!c.sync || typeof c.sync.timeoutSec !== "number" || c.sync.timeoutSec < 0 || c.sync.timeoutSec > 55) {
    e.push("sync.timeoutSec 必须在 [0,55]（relay 会 clamp）")
  } else {
    // 三个防重放开关：**允许缺席**（老 config.json 升上来不该让现役席位起不来），但写了就必须是对的类型。
    // 写成字符串 "false" 会被 `=== true` 判成 false —— 看着像关着，其实是「拼错了没人告诉你」。
    if (c.sync.replayHistory != null && typeof c.sync.replayHistory !== "boolean") {
      e.push("sync.replayHistory 要么不写要么是布尔")
    }
    if (c.sync.acceptMessagesOlderThanSeat != null && typeof c.sync.acceptMessagesOlderThanSeat !== "boolean") {
      e.push("sync.acceptMessagesOlderThanSeat 要么不写要么是布尔")
    }
    if (c.sync.replayStormThreshold != null
      && (typeof c.sync.replayStormThreshold !== "number" || !Number.isInteger(c.sync.replayStormThreshold) || c.sync.replayStormThreshold < 1)) {
      e.push("sync.replayStormThreshold 要么不写要么是 ≥1 的整数")
    }
  }
  if (!c.turn || typeof c.turn.timeoutMs !== "number" || c.turn.timeoutMs < 1000) e.push("turn.timeoutMs 至少 1000")
  if (!c.log || !["debug", "info", "warn", "error"].includes(c.log.level)) e.push("log.level 不合法")

  return e.length > 0 ? { ok: false, errors: e } : { ok: true, config: c as SeatConfig }
}

export function configPathFor(seat: string, override?: string | null, homeDir?: string): string {
  return override ?? seatPaths(seat, homeDir).config
}

export function loadSeatConfig(seat: string, override?: string | null, homeDir?: string): SeatConfig {
  const file = configPathFor(seat, override, homeDir)
  let raw: string
  try {
    raw = fs.readFileSync(file, "utf-8")
  } catch {
    throw new ConfigError(`找不到配置 ${file}，先跑 codex-seat init --seat ${seat}`, 3)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new ConfigError(`配置不是合法 JSON: ${file}（${(err as Error).message}）`, 3)
  }
  const r = validateSeatConfig(parsed, seat)
  if (!r.ok) throw new ConfigError(`配置校验失败 ${file}:\n  - ${r.errors.join("\n  - ")}`, 3)
  return r.config
}

export function writeSeatConfig(file: string, cfg: SeatConfig): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 })
  fs.renameSync(tmp, file)
}
