import { existsSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { ITermTerminal } from "./iterm.js"
import { TmuxTerminal } from "./tmux.js"
import { CompositeTerminal } from "./composite.js"
import type { ITerminal } from "./interface.js"
import { NoTerminal } from "./none.js"

function defaultHasTmux(): boolean {
  try {
    execFileSync("which", ["tmux"], { timeout: 3000 })
    return true
  } catch {
    return false
  }
}

function defaultHasITerm(): boolean {
  return process.platform === "darwin" && existsSync("/Applications/iTerm.app")
}

function resolveCompositeDefault(): "tmux" | "iterm" {
  const v = (process.env.MESH_COMPOSITE_DEFAULT_SPAWN ?? "tmux").toLowerCase()
  return v === "iterm" ? "iterm" : "tmux"
}

/**
 * 可选的探测函数覆盖（用于测试）。不传等价于走真实 which/existsSync。
 */
export interface TerminalProbes {
  hasTmux?: () => boolean
  hasITerm?: () => boolean
}

export function createTerminal(probes?: TerminalProbes): ITerminal {
  const hasTmux = probes?.hasTmux ?? defaultHasTmux
  const hasITerm = probes?.hasITerm ?? defaultHasITerm
  const env = process.env.MESH_TERMINAL

  if (env) {
    switch (env) {
      case "none":
        return new NoTerminal()
      case "tmux":
        if (!hasTmux()) throw new Error("MESH_TERMINAL=tmux but tmux is not installed")
        console.log("[mesh-relay] terminal backend: TmuxTerminal (env: MESH_TERMINAL=tmux)")
        return new TmuxTerminal()
      case "iterm":
        if (!hasITerm()) throw new Error("MESH_TERMINAL=iterm but iTerm2 is not available (macOS only)")
        console.log("[mesh-relay] terminal backend: ITermTerminal (env: MESH_TERMINAL=iterm)")
        return new ITermTerminal()
      case "composite": {
        if (!hasITerm()) throw new Error("MESH_TERMINAL=composite requires iTerm2 (macOS)")
        if (!hasTmux()) throw new Error("MESH_TERMINAL=composite requires tmux installed")
        const defaultSpawn = resolveCompositeDefault()
        console.log(`[mesh-relay] terminal backend: CompositeTerminal (env: MESH_TERMINAL=composite, defaultSpawn=${defaultSpawn})`)
        return new CompositeTerminal({
          tmux: new TmuxTerminal(),
          iterm: new ITermTerminal(),
          defaultSpawn,
        })
      }
      default:
        throw new Error(`MESH_TERMINAL="${env}" is not valid. Use "none", "tmux", "iterm", or "composite".`)
    }
  }

  // Auto-detect：
  // - iTerm + tmux 都有 → Composite（defaultSpawn=tmux）
  // - 仅 iTerm → ITermTerminal
  // - 仅 tmux → TmuxTerminal
  if (hasITerm() && hasTmux()) {
    console.log("[mesh-relay] terminal backend: CompositeTerminal (auto-detected, defaultSpawn=tmux)")
    return new CompositeTerminal({
      tmux: new TmuxTerminal(),
      iterm: new ITermTerminal(),
      defaultSpawn: "tmux",
    })
  }
  if (hasITerm()) {
    console.log("[mesh-relay] terminal backend: ITermTerminal (auto-detected)")
    return new ITermTerminal()
  }
  if (hasTmux()) {
    console.log("[mesh-relay] terminal backend: TmuxTerminal (auto-detected)")
    return new TmuxTerminal()
  }
  throw new Error("No terminal backend available. Need iTerm2 (macOS) or tmux.")
}
