export interface LauncherSpec {
  name: string
  agent: "claude" | "codex" | string
  cwd: string
  command: string
}

const BUILTIN_LAUNCHERS: Record<string, LauncherSpec> = {
  cc: {
    name: "cc",
    agent: "claude",
    cwd: "/Users/example/workspace/project",
    command: "claude --dangerously-skip-permissions",
  },
  code: {
    name: "code",
    agent: "claude",
    cwd: "/Users/example/AIproject/coding-harness",
    command: "claude --dangerously-skip-permissions",
  },
  cx: {
    name: "cx",
    agent: "codex",
    cwd: "/Users/example/workspace/project",
    command: "command codex --dangerously-bypass-approvals-and-sandbox",
  },
  codex: {
    name: "codex",
    agent: "codex",
    cwd: "/Users/example/AIproject/coding-harness",
    command: "command codex --dangerously-bypass-approvals-and-sandbox",
  },
}

export function resolveLauncher(name: string | undefined): LauncherSpec | null {
  const key = name ?? "cc"
  return BUILTIN_LAUNCHERS[key] ?? null
}
