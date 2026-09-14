/**
 * inject 节点的身份指纹比对。
 *
 * 指纹三元组：`session_name|pane_current_path|pane_current_command`
 * 样板（主脑 server:brain）：`brain|/home/example/workspace/project|codex`
 *
 * 为什么不是整串相等：codex 外面套着 while 自愈循环（崩了自己重启），
 * **重启那一瞬 pane_current_command 会短暂变成 bash 而不是 codex**。
 * 整串比对会把这个正常的瞬时态判成"节点被顶替"，于是主脑在自愈期间收不到任何消息——
 * 本来是防黑洞的机制，反倒自己造了个黑洞。
 *
 * 所以按字段分级：
 *   session_name / cwd  —— 严格匹配。它们不因重启变化，一旦变了就是真换了人。
 *   command             —— 软匹配。不一致先当瞬时态，重试一次再判。
 */

export type IdentityVerdict = "match" | "hard-mismatch" | "soft-mismatch"

export interface IdentityParts {
  sessionName: string
  cwd: string
  command: string
}

/** 拆三元组；字段数不对（老格式/脏数据）返回 null，由调用方降级成整串比对。 */
export function parseIdentity(fp: string | null | undefined): IdentityParts | null {
  if (typeof fp !== "string") return null
  const parts = fp.split("|")
  if (parts.length !== 3) return null
  const [sessionName, cwd, command] = parts
  if (!sessionName) return null
  return { sessionName, cwd: cwd ?? "", command: command ?? "" }
}

/**
 * 比对存档指纹与当前指纹。
 * 任一侧拆不出三元组 → 退回整串比对（相等即 match，否则 hard-mismatch），
 * 不因为格式陌生就放行。
 */
export function compareIdentity(stored: string, current: string): IdentityVerdict {
  if (stored === current) return "match"

  const a = parseIdentity(stored)
  const b = parseIdentity(current)
  if (!a || !b) return "hard-mismatch"

  // 会话名 / 工作目录：重启不会变，变了就是真的换了人
  if (a.sessionName !== b.sessionName) return "hard-mismatch"
  if (a.cwd !== b.cwd) return "hard-mismatch"

  // 只剩前台进程名不同 —— 可能正踩在 codex 自愈重启的窗口上，给它一次重试机会
  return "soft-mismatch"
}
