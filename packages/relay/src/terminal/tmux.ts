import { execFile } from "node:child_process"
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ITerminal, SpawnResult } from "./interface.js"

// mesh 运行时临时目录。
// 为什么不用 os.tmpdir()（2026-06-28 EACCES 根治）：relay 常被 tmux/launchd 启动，
// 那种上下文里进程 $TMPDIR 不全，os.tmpdir() 会解析到 macOS 受限的
// /var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T（uid-0 fallback），relay 以普通
// 用户身份 writeFileSync 直接 EACCES → inject 写不出临时文件、所有消息静默发不出去。
// 统一落到家目录下的 ~/.ccmesh/tmp（relay 必以用户身份跑，一定可写）。
const MESH_TMP = join(homedir(), ".ccmesh", "tmp")
try {
  mkdirSync(MESH_TMP, { recursive: true })
} catch {
  /* 已存在/建不出都不在此致命，后续 writeFileSync 会把真实错误抛出来 */
}

function run(cmd: string, args: string[], timeout = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * agent TUI 的输入提示符。不同 agent / 不同版本用不同字符：
 *   ❯ (U+276F) — claude Code，以及早期 codex
 *   › (U+203A) — codex 0.147.0（2026-08-26 测试设备实测）
 * 只认其中一种会让另一种的"prompt 就绪 / 未提交"判断永远失灵。
 */
export const AGENT_PROMPT_CHARS = ["❯", "›"] as const

/**
 * agent 空闲时渲染在输入行里的占位提示（不是用户输入）。
 * codex 0.147.0 空闲行长这样：`› Ask Codex to do anything`。
 * 不剥掉它，空闲的 codex 会被判成"有未提交内容"，触发多余的补 Enter。
 */
export const IDLE_PLACEHOLDERS = ["Ask Codex to do anything"] as const

/** 找最后一个 agent 提示符的位置；没有返回 -1。 */
export function lastPromptIndex(text: string): number {
  let idx = -1
  for (const ch of AGENT_PROMPT_CHARS) {
    const i = text.lastIndexOf(ch)
    if (i > idx) idx = i
  }
  return idx
}

/**
 * 判断 capture-pane 输出里提示符后是否还有未提交内容。
 *
 * 用途：inject 后自检 — 老版 claude TUI（2.1.78 等）100ms SUBMIT_DELAY 不够，
 * paste-buffer 后立刻 send-keys Enter 会被吞，文本停留在输入行未提交。
 *
 * 算法：
 *   - 去 ANSI 控制码后找最后一个提示符（见 AGENT_PROMPT_CHARS）
 *   - 取提示符后的内容，剥掉空白和 TUI 边框字符
 *   - 残留 > 3 字符 = 未提交
 *
 * 找不到提示符的（cat / 普通 shell / 非 TUI）一律返回 false，
 * inject 不重试，等价老行为，对非 TUI 场景零影响。
 */
export function hasUnsubmittedPrompt(paneText: string): boolean {
  const clean = paneText.replace(/\x1b\[[\d;?]*[a-zA-Z]/g, "")
  const idx = lastPromptIndex(clean)
  if (idx === -1) return false
  // 只看提示符所在这一行。codex 在输入行下面还渲染一行状态栏（模型 · 工作目录），
  // 跨行取会把状态栏当成"用户没提交的输入"，让空闲的 codex 永远判为未提交。
  // 多行 paste 的第一行必有内容，只看一行不影响 true 的判定。
  const lineEnd = clean.indexOf("\n", idx + 1)
  let after = lineEnd === -1 ? clean.slice(idx + 1) : clean.slice(idx + 1, lineEnd)
  // 空闲时输入行显示的是灰色占位提示，不是真输入
  for (const ph of IDLE_PLACEHOLDERS) after = after.split(ph).join("")
  after = after.replace(/[\s│┌─┐├└┘╭╰╮╯⏵⏷·]/g, "")
  return after.length > 3
}

export class TmuxTerminal implements ITerminal {
  private static readonly SUBMIT_DELAY_MS = 100
  private static readonly SUBMIT_VERIFY_DELAY_MS = 800
  private static readonly SUBMIT_RETRY_MAX = 2

  /**
   * inject: paste-buffer with **explicit** bracketed-paste markers
   *
   * 历史 / 为什么不用 send-keys -l 或裸 paste-buffer：
   *   - 单纯 send-keys -l：text 里的 \n 会被当 Enter 直接提交，多行 bootstrap
   *     被切成多次 prompt，claude 处理乱掉
   *   - 单纯 paste-buffer：tmux 是否自动包裹 bracketed-paste 取决于版本/
   *     OS/终端协商。macOS local tmux 不包裹，老节点（旧 claude 版本）
   *     paste 也能触发提交；但 Linux/WSL 上 claude 2.1.119+ TUI 不响应不
   *     带 marker 的 paste（输入框拿到字但不提交）
   *
   * 解决：自己把 \e[200~...\e[201~ 包进 buffer 文件里，paste-buffer 时连
   * marker 一起进 pty。任何认 bracketed-paste 的 TUI（claude / codex / 现代
   * bash）都会把整段当一次 paste 处理：内部 \n 不触发提交、整段保留在输入
   * 缓冲；再 send-keys Enter 才正式提交。
   *
   * 不认 bracketed-paste 的目标（cat / dumb shell）：marker 字节会以 0x1B [
   * 200 ~ 形式落进流，看起来奇怪但不影响后续命令执行（控制字符大多无视觉）。
   */
  async inject(sessionId: string, text: string): Promise<boolean> {
    const tmpFile = join(MESH_TMP, `mesh-inject-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
    try {
      const wrapped = `\x1b[200~${text}\x1b[201~`
      writeFileSync(tmpFile, wrapped, "utf-8")
      await run("tmux", ["load-buffer", tmpFile])
      await run("tmux", ["paste-buffer", "-t", sessionId])
      // TUI 类竞态守护：paste 完立刻 Enter 会被吞（Codex / Claude Code 都遇过）
      await sleep(TmuxTerminal.SUBMIT_DELAY_MS)
      await run("tmux", ["send-keys", "-t", sessionId, "Enter"])
      // Submit 自检 + 补 Enter：老版 claude TUI（如 2.1.78）100ms 仍可能吞掉首次 Enter，
      // 文本停在输入行。capture-pane 看 ❯ 后是否清空，没清就再 Enter。
      // hasUnsubmittedPrompt 在非 ❯ TUI 上恒返 false，等价老行为，零回归。
      for (let i = 0; i < TmuxTerminal.SUBMIT_RETRY_MAX; i++) {
        await sleep(TmuxTerminal.SUBMIT_VERIFY_DELAY_MS)
        const pane = await run("tmux", ["capture-pane", "-t", sessionId, "-p", "-S", "-10"])
        if (!hasUnsubmittedPrompt(pane)) break
        await run("tmux", ["send-keys", "-t", sessionId, "Enter"])
      }
      return true
    } catch (err) {
      // honest failure：tmux inject 失败绝不静默吞——记录 sessionId + 原因，
      // 否则上层只看到 delivered=false 却无从排查（历史踩坑 §14/§16 同源）。
      console.error(`[mesh] tmux inject failed (session=${sessionId}):`, err)
      return false
    } finally {
      try { unlinkSync(tmpFile) } catch {}
    }
  }

  async spawn(cmd: string, opts?: { mode?: "tab" | "window"; cwd?: string }): Promise<SpawnResult> {
    // tmux 没有 tab/window 区分，统一创建新 session
    const sessionName = `mesh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

    // 起持久 shell（session 根进程 = 用户默认 shell，命令执行完 shell 仍在）。
    const args = ["new-session", "-d", "-s", sessionName]
    if (opts?.cwd) {
      args.push("-c", opts.cwd)
    }
    await run("tmux", args)

    // 在持久 shell 里执行启动命令，复用 inject 的健壮提交：bracketed-paste + 显式
    // send-keys Enter + ❯ 自检补 Enter，临时文件落 ~/.ccmesh/tmp 绕开 EACCES。
    //
    // spawn 失效的真正根因（2026-06-28 定位，曾误判为 paste 时序）：旧实现 writeFileSync
    //   临时文件落 os.tmpdir()，relay 被 tmux/launchd 启动时该路径是 macOS uid-0 受限
    //   目录 → EACCES → load-buffer 没文件可读 → paste 空内容 → wrapper 命令凭空蒸发、
    //   worker 起不来。修复收口在 inject 的 MESH_TMP。
    //
    // 为什么不用 `new-session ... <cmd>` 让命令当 session 根进程：一次性命令（echo 等）
    //   退出后 session 立即关闭，破坏"持久 shell 里跑命令"的语义、不可测；wrapper 场景
    //   仅因末尾 exec claude 常驻而侥幸可用，不可依赖。
    await this.inject(sessionName, cmd)

    return { sessionId: sessionName }
  }

  async isAlive(sessionId: string): Promise<boolean> {
    try {
      await run("tmux", ["has-session", "-t", sessionId])
      return true
    } catch {
      return false
    }
  }

  /**
   * 身份指纹：`session_name|pane_current_path|pane_current_command`。
   *
   * has-session 只回答「这个**名字**在不在」。session 被 kill 后别人建个同名的，
   * 它照样说 true——所以验活挡不住「名字还在、里面换人了」。这里多取 cwd 和
   * 前台进程名，三者一起才勉强钉得住「还是不是当初那个 pane」。
   * 取不到（session 没了 / tmux 没跑）返回 null，绝不抛。
   */
  async identity(sessionId: string): Promise<string | null> {
    try {
      const out = await run("tmux", [
        "display-message", "-p", "-t", sessionId,
        "#{session_name}|#{pane_current_path}|#{pane_current_command}",
      ])
      const fp = out.trim()
      return fp.length > 0 ? fp : null
    } catch {
      return null
    }
  }

  async close(sessionId: string): Promise<void> {
    try {
      await run("tmux", ["kill-session", "-t", sessionId])
    } catch {
      // session 可能已经关闭
    }
  }

  /**
   * notify: tmux display-message 状态栏短提示
   * - 不进 REPL buffer，不打断主 cc 当前任务
   * - -d 3000 = 3s 后消失；失败静默返回 false（不抛）
   * - 对控制字符做基本脱敏（display-message 的文本参数允许含格式串，避免 \n/\r 破坏 status line）
   */
  async notify(sessionId: string, text: string): Promise<boolean> {
    const safe = text.replace(/[\r\n]/g, " ").slice(0, 200)
    try {
      await run("tmux", ["display-message", "-d", "3000", "-t", sessionId, safe])
      return true
    } catch {
      return false
    }
  }

  async getCurrentSession(): Promise<{ sessionId: string; windowId?: string } | null> {
    // 如果在 tmux 内，通过 TMUX_PANE 环境变量获取
    const pane = process.env.TMUX_PANE
    if (!pane) return null

    try {
      // 获取当前 pane 所属的 session name
      const result = await run("tmux", ["display-message", "-p", "#{session_name}"])
      const sessionName = result.trim()
      if (!sessionName) return null
      return { sessionId: sessionName }
    } catch {
      return null
    }
  }
}
