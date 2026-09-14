import fs from "node:fs"
import path from "node:path"
import { meshHome } from "./paths.js"

export interface AgentProfile {
  name: string
  launcher: string
  cwd: string
  terminal: "tmux"
  autoInit: boolean
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`profile missing required field: ${field}`)
  }
  return value
}

export function loadAgentProfile(name: string, profileHome = meshHome()): AgentProfile | null {
  const file = path.join(profileHome, "agents", `${name}.json`)
  if (!fs.existsSync(file)) return null

  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
  const profile: AgentProfile = {
    name: assertString(raw.name, "name"),
    launcher: assertString(raw.launcher, "launcher"),
    cwd: assertString(raw.cwd, "cwd"),
    terminal: assertString(raw.terminal, "terminal") as "tmux",
    autoInit: typeof raw.autoInit === "boolean" ? raw.autoInit : (() => { throw new Error("profile missing required field: autoInit") })(),
  }

  if (profile.name !== name) {
    throw new Error(`profile name mismatch: expected ${name}, got ${profile.name}`)
  }
  if (profile.terminal !== "tmux") {
    throw new Error(`agent profile must be tmux-backed: ${name}`)
  }

  return profile
}
