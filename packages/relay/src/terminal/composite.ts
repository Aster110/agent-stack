import type { ITerminal, SpawnResult } from "./interface.js"

/**
 * UUID v4 标准格式（8-4-4-4-12 hex，大小写无关）
 * 例：9A7D37B4-1A2B-4C3D-8E4F-1234567890AB
 *
 * 严格精确：第一段必须 8 位 hex，避免 foo-1234-... 这种误判
 */
const UUID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/

function isITermSession(sessionId: string): boolean {
  return UUID_RE.test(sessionId)
}

export interface CompositeTerminalOptions {
  tmux: ITerminal
  iterm: ITerminal
  /** spawn / getCurrentSession 走哪个后端（session_id 不可用时用默认） */
  defaultSpawn: "tmux" | "iterm"
}

/**
 * CompositeTerminal — 按 session_id 格式动态路由到 Tmux 或 iTerm 后端
 *
 * 路由规则：
 * - session_id 匹配 UUID 正则 → iTermTerminal
 * - 其他（mesh-xxx / cc2w-xxx / 纯字符串） → TmuxTerminal
 * - spawn / getCurrentSession 无 session_id 参考，用 defaultSpawn
 *
 * 解决场景：主 cc 跑 iTerm2（UUID session_id），worker 跑 tmux（mesh-xxx session_id），
 * 单后端二选一时 worker → 主 cc 的 inject 会走错后端静默失败。
 */
export class CompositeTerminal implements ITerminal {
  private readonly tmux: ITerminal
  private readonly iterm: ITerminal
  private readonly defaultBackend: ITerminal
  private readonly defaultSpawnName: "tmux" | "iterm"

  constructor(opts: CompositeTerminalOptions) {
    this.tmux = opts.tmux
    this.iterm = opts.iterm
    this.defaultSpawnName = opts.defaultSpawn
    this.defaultBackend = opts.defaultSpawn === "iterm" ? opts.iterm : opts.tmux
  }

  private pickFor(sessionId: string): { backend: ITerminal; name: "tmux" | "iterm" } {
    if (isITermSession(sessionId)) return { backend: this.iterm, name: "iterm" }
    return { backend: this.tmux, name: "tmux" }
  }

  async inject(sessionId: string, text: string, hint?: { windowId?: string }): Promise<boolean> {
    const { backend, name } = this.pickFor(sessionId)
    console.log(`[composite] inject → ${name} (session=${sessionId})`)
    return backend.inject(sessionId, text, hint)
  }

  async spawn(cmd: string, opts?: { mode?: "tab" | "window"; cwd?: string }): Promise<SpawnResult> {
    console.log(`[composite] spawn → ${this.defaultSpawnName} (default)`)
    return this.defaultBackend.spawn(cmd, opts)
  }

  async isAlive(sessionId: string): Promise<boolean> {
    const { backend } = this.pickFor(sessionId)
    return backend.isAlive(sessionId)
  }

  supportsIdentity(sessionId: string): boolean {
    const { backend } = this.pickFor(sessionId)
    return typeof backend.identity === "function"
  }

  async identity(sessionId: string): Promise<string | null> {
    const { backend } = this.pickFor(sessionId)
    if (typeof backend.identity !== "function") return null
    return backend.identity(sessionId)
  }

  async close(sessionId: string): Promise<void> {
    const { backend } = this.pickFor(sessionId)
    return backend.close(sessionId)
  }

  async getCurrentSession(): Promise<{ sessionId: string; windowId?: string } | null> {
    return this.defaultBackend.getCurrentSession()
  }

  async notify(sessionId: string, text: string): Promise<boolean> {
    const { backend } = this.pickFor(sessionId)
    if (typeof backend.notify === "function") {
      return backend.notify(sessionId, text)
    }
    return false
  }
}
