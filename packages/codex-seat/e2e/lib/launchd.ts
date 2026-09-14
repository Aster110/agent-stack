/**
 * launchd 装卸（只碰 e2e-* label，绝不碰 com.aster.mesh-*）。
 *
 * 原 `e2e/laneC/harness.ts`，2026-09-02 集成时折进 lib/。
 */
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { launchdLabel } from "../../src/contracts.js"
import { cliMain, type SeatEnv } from "./script-case.js"
import { sleep } from "./util.js"

const FORBIDDEN_LABEL_RE = /^com\.aster\.mesh-/

export function assertSafeLabel(label: string): void {
  if (FORBIDDEN_LABEL_RE.test(label)) throw new Error(`红线：拒绝操作生产 job ${label}`)
  if (!/^com\.aster\.codex-seat\.e2e-[0-9a-f]{4}$/.test(label)) {
    throw new Error(`红线：e2e 只许操作 com.aster.codex-seat.e2e-<4hex>，收到 ${label}`)
  }
}

export function sh(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; tolerant?: boolean } = {}): string {
  try {
    return execFileSync(cmd, args, { encoding: "utf-8", timeout: 60_000, env: opts.env ?? process.env }).trim()
  } catch (e) {
    if (opts.tolerant) return String((e as any).stderr ?? (e as Error).message ?? "").trim()
    throw e
  }
}

export function launchdInstall(env: SeatEnv): { label: string; plistPath: string } {
  const label = launchdLabel(env.seat)
  assertSafeLabel(label)
  const uid = os.userInfo().uid
  // install 走真 CLI（这正是要验的东西），HOME 指向私有目录 → plist 落在私有 LaunchAgents
  sh(process.execPath, [cliMain(), "install", "--seat", env.seat], { env: { ...process.env, HOME: env.home }, tolerant: true })
  const plistPath = path.join(env.home, "Library", "LaunchAgents", `${label}.plist`)
  if (!fs.existsSync(plistPath)) throw new Error(`install 没写出 plist: ${plistPath}`)
  // CLI 的 install 已经 bootstrap 过了（那正是被测对象）；这里只确认它真在 launchctl 里，
  // 不重复 bootstrap —— 重复一次就多一代 instanceId，把「换代」这个断言搅浑。
  if (!sh("launchctl", ["list"], { tolerant: true }).includes(label)) {
    sh("launchctl", ["bootstrap", `gui/${uid}`, plistPath], { tolerant: true })
  }
  return { label, plistPath }
}

export function launchdBootout(seat: string): void {
  const label = launchdLabel(seat)
  assertSafeLabel(label)
  sh("launchctl", ["bootout", `gui/${os.userInfo().uid}/${label}`], { tolerant: true })
}

export function launchdUninstall(env: SeatEnv): void {
  const label = launchdLabel(env.seat)
  assertSafeLabel(label)
  sh(process.execPath, [cliMain(), "uninstall", "--seat", env.seat], { env: { ...process.env, HOME: env.home }, tolerant: true })
  launchdBootout(env.seat)
}

export function launchdLoaded(seat: string): boolean {
  const label = launchdLabel(seat)
  return sh("launchctl", ["list"], { tolerant: true }).includes(label)
}

/**
 * 收尾自检：`launchctl list | grep e2e` 必须为空。
 * bootout 是异步的 —— 刚 bootout 完那一瞬 `launchctl list` 还会显示一行（退出码 -9），
 * 所以要留几秒重试，不然会拿「还没落地」当「没清干净」报假红。
 */
export function e2eLaunchdLeftovers(): string[] {
  return sh("launchctl", ["list"], { tolerant: true })
    .split("\n")
    .filter((l) => l.includes("codex-seat.e2e-"))
}

export async function assertNoE2ELaunchdLeftovers(waitMs = 10_000): Promise<string[]> {
  const deadline = Date.now() + waitMs
  let left = e2eLaunchdLeftovers()
  while (left.length > 0 && Date.now() < deadline) {
    await sleep(1000)
    left = e2eLaunchdLeftovers()
  }
  return left
}
