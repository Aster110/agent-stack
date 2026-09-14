/**
 * 保活模板渲染（launchd / systemd）。
 *
 * 模板文件在 `packages/codex-seat/templates/`，渲染在这里，两边都不许带故障注入开关。
 * `renderTemplate` 对未替换的 `{{X}}` 直接抛 —— 半渲染的 plist 会被 launchd 静默接受，
 * `launchctl list` 一切正常而席位根本没起来，这是本机吃过的坑。
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { launchdLabel, systemdUnitName, seatPaths } from "../contracts.js"

/** launchd 只给系统四目录；node / codex / mesh 都在 /opt/homebrew/bin */
export const LAUNCHD_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
/** Linux 侧：homebrew 不在，加用户级 bin */
export const SYSTEMD_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

export class UnreplacedPlaceholderError extends Error {}

const PLACEHOLDER_RE = /\{\{([A-Z0-9_]+)\}\}/g

export function renderTemplate(tmpl: string, vars: Record<string, string>): string {
  const out = tmpl.replace(PLACEHOLDER_RE, (_m, key: string) => {
    const v = vars[key]
    if (v === undefined) return `{{${key}}}`
    return v
  })
  const left = [...out.matchAll(PLACEHOLDER_RE)].map((m) => m[1])
  if (left.length > 0) {
    throw new UnreplacedPlaceholderError(`模板还有没替换的占位符: ${[...new Set(left)].join(", ")}`)
  }
  return out
}

export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

export interface SupervisorContext {
  seat: string
  label: string
  unit: string
  nodeBin: string
  cliEntry: string
  workingDir: string
  home: string
  pathEnv: string
  lang: string
  stdoutPath: string
  stderrPath: string
  throttleSec: number
  restartSec: number
}

/** 包根目录：dist/src/cli/templates.js → ../../.. */
export function packageRoot(): string {
  return path.resolve(__dirname, "..", "..", "..")
}

export function templateFile(name: string): string {
  return path.join(packageRoot(), "templates", name)
}

export function cliEntryPath(): string {
  return path.join(packageRoot(), "dist", "src", "cli", "main.js")
}

/**
 * 托管器里写死的 node 路径。
 * `process.execPath` 会解析成 `/opt/homebrew/Cellar/node/25.9.0_2/bin/node` —— 版本号写死在 plist 里，
 * 下次 `brew upgrade node` 席位就起不来了（而 launchctl list 照样绿）。所以优先用稳定符号链接。
 */
export const STABLE_NODE_CANDIDATES = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]

export function resolveStableNodeBin(exists: (p: string) => boolean = (p) => fs.existsSync(p)): string {
  for (const c of STABLE_NODE_CANDIDATES) if (exists(c)) return c
  return process.execPath
}

export interface BuildContextInput {
  seat: string
  workingDir: string
  homeDir?: string
  platform?: NodeJS.Platform
  nodeBin?: string
  cliEntry?: string
}

export function buildSupervisorContext(input: BuildContextInput): SupervisorContext {
  const home = input.homeDir ?? os.homedir()
  const p = seatPaths(input.seat, home)
  const isLinux = (input.platform ?? process.platform) === "linux"
  return {
    seat: input.seat,
    label: launchdLabel(input.seat),
    unit: systemdUnitName(input.seat),
    // process.execPath 永远是绝对路径；launchd/systemd 下没有 PATH 可依赖
    nodeBin: input.nodeBin ?? resolveStableNodeBin(),
    cliEntry: input.cliEntry ?? cliEntryPath(),
    workingDir: input.workingDir,
    home,
    pathEnv: isLinux ? SYSTEMD_PATH : LAUNCHD_PATH,
    lang: "en_US.UTF-8",
    stdoutPath: path.join(p.logDir, "stdout.log"),
    stderrPath: path.join(p.logDir, "stderr.log"),
    throttleSec: 10,
    restartSec: 5,
  }
}

function varsFor(ctx: SupervisorContext, esc: (s: string) => string): Record<string, string> {
  return {
    SEAT: esc(ctx.seat),
    LABEL: esc(ctx.label),
    UNIT: esc(ctx.unit),
    NODE_BIN: esc(ctx.nodeBin),
    CLI_ENTRY: esc(ctx.cliEntry),
    WORKING_DIR: esc(ctx.workingDir),
    HOME_DIR: esc(ctx.home),
    PATH_ENV: esc(ctx.pathEnv),
    LANG: esc(ctx.lang),
    STDOUT_PATH: esc(ctx.stdoutPath),
    STDERR_PATH: esc(ctx.stderrPath),
    THROTTLE_SEC: String(ctx.throttleSec),
    RESTART_SEC: String(ctx.restartSec),
  }
}

/** 生产模板体检：故障开关一个都不许有 */
export function assertNoFaultEnv(rendered: string): void {
  for (const bad of ["CODEX_SEAT_ALLOW_FAULTS", "CODEX_SEAT_FAULT", "--remote-control"]) {
    if (rendered.includes(bad)) throw new Error(`生产模板里出现了 ${bad}`)
  }
}

export function renderLaunchdPlist(ctx: SupervisorContext, tmpl?: string): string {
  const t = tmpl ?? fs.readFileSync(templateFile("launchd.plist.tmpl"), "utf-8")
  const out = renderTemplate(t, varsFor(ctx, xmlEscape))
  assertNoFaultEnv(out)
  return out
}

export function renderSystemdUnit(ctx: SupervisorContext, tmpl?: string): string {
  const t = tmpl ?? fs.readFileSync(templateFile("systemd.service.tmpl"), "utf-8")
  const out = renderTemplate(t, varsFor(ctx, (s) => s))
  assertNoFaultEnv(out)
  return out
}
