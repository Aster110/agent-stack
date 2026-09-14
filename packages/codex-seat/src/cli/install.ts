/**
 * `codex-seat install|uninstall`。
 *
 * 计划（纯函数）与执行（副作用）分开：`--dry-run` 打印的就是真跑的那份，
 * 不会出现「dry-run 说得好听、真跑另一套」。
 *
 * 红线写死在计划里：只碰 `com.aster.codex-seat.<seat>` / `codex-seat-<seat>.service`，
 * 永远不 bootout `com.aster.mesh-*`（那是 relay 监督器和席位监督器，掀了整个蚁群没）。
 */
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { launchdLabel, seatPaths, systemdUnitName } from "../contracts.js"
import {
  buildSupervisorContext,
  renderLaunchdPlist,
  renderSystemdUnit,
  type SupervisorContext,
} from "./templates.js"

export type SupervisorKind = "launchd" | "systemd"

export interface InstallPlan {
  kind: SupervisorKind
  label: string
  targetPath: string
  content: string
  /** 按序执行；失败即停 */
  commands: string[][]
  /** 只提示不执行的（比如 linger 需要 sudo 或交互） */
  hints: string[]
}

export interface PlanInstallInput {
  seat: string
  platform: NodeJS.Platform
  uid: number
  ctx: SupervisorContext
  homeDir?: string
}

export function planInstall(i: PlanInstallInput): InstallPlan {
  const home = i.homeDir ?? i.ctx.home
  if (i.platform === "darwin") {
    const label = launchdLabel(i.seat)
    const targetPath = path.join(home, "Library", "LaunchAgents", `${label}.plist`)
    return {
      kind: "launchd",
      label,
      targetPath,
      content: renderLaunchdPlist(i.ctx),
      commands: [
        // 幂等：先把可能存在的旧代踢掉（没有就报错，忽略）
        ["launchctl", "bootout", `gui/${i.uid}/${label}`],
        ["launchctl", "bootstrap", `gui/${i.uid}`, targetPath],
        ["launchctl", "enable", `gui/${i.uid}/${label}`],
      ],
      hints: [
        `日志：${path.join(seatPaths(i.seat, home).logDir, "stderr.log")}`,
        `查看：launchctl print gui/${i.uid}/${label}`,
      ],
    }
  }
  const unit = systemdUnitName(i.seat)
  const targetPath = path.join(home, ".config", "systemd", "user", unit)
  return {
    kind: "systemd",
    label: unit,
    targetPath,
    content: renderSystemdUnit(i.ctx),
    commands: [
      ["loginctl", "enable-linger", process.env.USER ?? "aster"],
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", unit],
    ],
    hints: [
      "没有 linger 的话，注销就把 --user 单元一起带走（席位随之消失）",
      `日志：journalctl --user -u ${unit} -f`,
    ],
  }
}

export interface UninstallPlan {
  kind: SupervisorKind
  label: string
  commands: string[][]
  removePaths: string[]
  hints: string[]
}

export interface PlanUninstallInput {
  seat: string
  platform: NodeJS.Platform
  uid: number
  homeDir?: string
}

export function planUninstall(i: PlanUninstallInput): UninstallPlan {
  const home = i.homeDir ?? os.homedir()
  if (i.platform === "darwin") {
    const label = launchdLabel(i.seat)
    return {
      kind: "launchd",
      label,
      commands: [["launchctl", "bootout", `gui/${i.uid}/${label}`]],
      removePaths: [path.join(home, "Library", "LaunchAgents", `${label}.plist`)],
      // 席位目录（state/wal/config/rollout 关联）保留：换名 runbook 靠它搬家
      hints: [`席位目录保留：${seatPaths(i.seat, home).home}`],
    }
  }
  const unit = systemdUnitName(i.seat)
  return {
    kind: "systemd",
    label: unit,
    commands: [
      ["systemctl", "--user", "disable", "--now", unit],
      ["systemctl", "--user", "daemon-reload"],
    ],
    removePaths: [path.join(home, ".config", "systemd", "user", unit)],
    hints: [`席位目录保留：${seatPaths(i.seat, home).home}`],
  }
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

export interface ExecResult {
  cmd: string
  ok: boolean
  output: string
}

function run(cmd: string[], tolerant: boolean): ExecResult {
  const line = cmd.join(" ")
  try {
    const out = execFileSync(cmd[0]!, cmd.slice(1), { encoding: "utf-8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] })
    return { cmd: line, ok: true, output: out.trim() }
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message?: string }
    const output = String(e.stderr ?? e.message ?? "").trim()
    return { cmd: line, ok: tolerant, output }
  }
}

export function executeInstallPlan(plan: InstallPlan): ExecResult[] {
  fs.mkdirSync(path.dirname(plan.targetPath), { recursive: true })
  const tmp = `${plan.targetPath}.tmp-${process.pid}`
  fs.writeFileSync(tmp, plan.content, { encoding: "utf-8", mode: 0o644 })
  fs.renameSync(tmp, plan.targetPath)

  const results: ExecResult[] = []
  for (const cmd of plan.commands) {
    // bootout / enable-linger / enable 都可能因为「本来就没装 / 已经开了」失败，容忍；
    // bootstrap / enable --now 是真动作，失败要报出来
    const tolerant =
      cmd.includes("bootout") ||
      cmd.includes("enable-linger") ||
      (cmd.includes("enable") && !cmd.includes("--now"))
    const r = run(cmd, tolerant)
    results.push(r)
    if (!r.ok) break
  }
  return results
}

export function executeUninstallPlan(plan: UninstallPlan): ExecResult[] {
  const results: ExecResult[] = []
  for (const cmd of plan.commands) results.push(run(cmd, true))
  for (const p of plan.removePaths) {
    try {
      fs.rmSync(p, { force: true })
      results.push({ cmd: `rm ${p}`, ok: true, output: "" })
    } catch (err) {
      results.push({ cmd: `rm ${p}`, ok: false, output: String(err) })
    }
  }
  return results
}

export function contextForSeat(seat: string, workingDir: string, homeDir?: string): SupervisorContext {
  return buildSupervisorContext({ seat, workingDir, homeDir })
}
