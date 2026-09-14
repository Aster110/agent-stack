import { execFile } from "node:child_process"
import type { ITerminal, SpawnResult } from "./interface.js"

function runOsascript(script: string, timeout = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], { timeout }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

function escapeForAppleScript(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

function buildWriteAndSubmitScript(escapedText: string): string {
  return `
    tell aSession
      write text "${escapedText}" newline NO
    end tell
    tell application "iTerm2" to activate
    delay 0.1
    tell application "System Events"
      key code 36
    end tell
  `
}

export function buildFastInjectScript(sessionId: string, text: string, windowId: string): string {
  const escaped = escapeForAppleScript(text)
  const sid = escapeForAppleScript(sessionId)
  const wid = escapeForAppleScript(windowId)
  const submit = buildWriteAndSubmitScript(escaped)
  return `
    tell application "iTerm2"
      repeat with aWindow in windows
        if (id of aWindow) as text is "${wid}" then
          repeat with aTab in tabs of aWindow
            repeat with aSession in sessions of aTab
              if unique ID of aSession is "${sid}" then
                select aSession
                ${submit}
                return "ok"
              end if
            end repeat
          end repeat
        end if
      end repeat
    end tell
    return "not_found"
  `
}

export function buildSlowInjectScript(sessionId: string, text: string): string {
  const escaped = escapeForAppleScript(text)
  const sid = escapeForAppleScript(sessionId)
  const submit = buildWriteAndSubmitScript(escaped)
  return `
    tell application "iTerm2"
      repeat with aWindow in windows
        repeat with aTab in tabs of aWindow
          repeat with aSession in sessions of aTab
            if unique ID of aSession is "${sid}" then
              select aSession
              ${submit}
              return "ok"
            end if
          end repeat
        end repeat
      end repeat
    end tell
    return "not_found"
  `
}

export class ITermTerminal implements ITerminal {
  /**
   * inject: 快路径 + 慢路径模式
   * 快路径：如果有 windowId hint，先在该 window 里找 session
   * 慢路径：全局遍历所有 window/tab/session
   */
  async inject(sessionId: string, text: string, hint?: { windowId?: string }): Promise<boolean> {
    // 快路径：在指定 window 中查找
    // 这里不能把 CR 当普通文本写进去。对 Codex / Claude 这类 TUI，
    // 更稳的做法是：正文 newline NO，然后单独发送一个空 write 触发 submit。
    if (hint?.windowId) {
      const fastScript = buildFastInjectScript(sessionId, text, hint.windowId)
      try {
        const result = await runOsascript(fastScript)
        if (result.trim() === "ok") return true
      } catch {
        // 快路径失败，继续慢路径
      }
    }

    // 慢路径：全局遍历
    const slowScript = buildSlowInjectScript(sessionId, text)
    try {
      const result = await runOsascript(slowScript)
      return result.trim() === "ok"
    } catch {
      return false
    }
  }

  async spawn(cmd: string, opts?: { mode?: "tab" | "window"; cwd?: string }): Promise<SpawnResult> {
    const mode = opts?.mode ?? "tab"
    const escapedCmd = escapeForAppleScript(cmd)

    // 构建完整命令：如果指定了 cwd，先 cd
    let fullCmd = escapedCmd
    if (opts?.cwd) {
      const escapedCwd = escapeForAppleScript(opts.cwd)
      fullCmd = `cd \\"${escapedCwd}\\" && ${escapedCmd}`
    }

    const script = mode === "window"
      ? `
        tell application "iTerm2"
          set newWindow to (create window with default profile)
          tell current session of current tab of newWindow
            write text "${fullCmd}"
          end tell
          return (id of newWindow as text) & "," & (unique id of current session of current tab of newWindow)
        end tell
      `
      : `
        tell application "iTerm2"
          set w to current window
          tell w
            set newTab to (create tab with default profile)
            tell current session of newTab
              write text "${fullCmd}"
            end tell
          end tell
          return (id of w as text) & "," & (unique id of current session of newTab)
        end tell
      `

    const result = await runOsascript(script, 10000)
    // iTerm 返回格式如 "5179, ,, D9CDB4DE-..." — 过滤空白取首尾
    const parts = result.trim().split(",").map(s => s.trim()).filter(Boolean)
    return {
      sessionId: parts.length > 1 ? parts[parts.length - 1] : result.trim(),
      windowId: parts[0] ?? "",
    }
  }

  async isAlive(sessionId: string): Promise<boolean> {
    const sid = escapeForAppleScript(sessionId)
    const script = `
      tell application "iTerm2"
        repeat with aWindow in windows
          repeat with aTab in tabs of aWindow
            repeat with aSession in sessions of aTab
              if unique ID of aSession is "${sid}" then
                return "alive"
              end if
            end repeat
          end repeat
        end repeat
      end tell
      return "dead"
    `
    try {
      const result = await runOsascript(script)
      return result.trim() === "alive"
    } catch {
      return false
    }
  }

  async close(sessionId: string): Promise<void> {
    const sid = escapeForAppleScript(sessionId)
    const script = `
      tell application "iTerm2"
        repeat with aWindow in windows
          repeat with aTab in tabs of aWindow
            repeat with aSession in sessions of aTab
              if unique ID of aSession is "${sid}" then
                tell aSession to close
                return "ok"
              end if
            end repeat
          end repeat
        end repeat
      end tell
      return "not_found"
    `
    try {
      await runOsascript(script)
    } catch {
      // session 可能已经关闭，忽略
    }
  }

  async getCurrentSession(): Promise<{ sessionId: string; windowId?: string } | null> {
    const script = `
      tell application "iTerm2"
        return (id of current window as text) & "," & (unique id of current session of current window)
      end tell
    `
    try {
      const result = await runOsascript(script)
      const parts = result.trim().split(",")
      if (parts.length < 2) return null
      return {
        windowId: parts[0]?.trim(),
        sessionId: parts.slice(1).join(",").trim(),
      }
    } catch {
      return null
    }
  }
}
