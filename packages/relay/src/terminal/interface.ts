export interface ITerminal {
  inject(sessionId: string, text: string, hint?: { windowId?: string }): Promise<boolean>
  spawn(cmd: string, opts?: { mode?: "tab" | "window"; cwd?: string }): Promise<SpawnResult>
  isAlive(sessionId: string): Promise<boolean>
  close(sessionId: string): Promise<void>
  getCurrentSession(): Promise<{ sessionId: string; windowId?: string } | null>
  /**
   * 可选：对目标 session 弹状态栏短消息（不进 REPL buffer，不打断当前任务）。
   * tmux 用 display-message 实现；iTerm2 等无对应概念的终端可不实现。
   * 失败应返回 false 而非抛异常。
   */
  notify?(sessionId: string, text: string): Promise<boolean>
  /**
   * 可选：取会话的**身份指纹**，用于「这个 session 还是不是当初那个」的比对。
   * tmux 实现取 `session_name|pane_current_path|pane_current_command`。
   *
   * session 不存在 / 取不到 → 返回 null（不抛）。不实现此方法的终端（iTerm2 等）
   * 就没有身份校验能力，relay 会退回「只验活、不拦投递」的旧行为。
   */
  identity?(sessionId: string): Promise<string | null>
  /** 可选：按 session 判断实际路由后端是否具备 identity 能力。 */
  supportsIdentity?(sessionId: string): boolean
}

export interface SpawnResult {
  sessionId: string
  windowId?: string
}
