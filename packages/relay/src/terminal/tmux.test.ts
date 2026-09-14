/**
 * tmux 模块的纯函数单元测试。集成测试见 tmux.integration.test.ts。
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { hasUnsubmittedPrompt } from "./tmux.js"

describe("hasUnsubmittedPrompt", () => {
  it("没有 ❯ 提示符 → false（不是 claude/codex TUI）", () => {
    assert.equal(hasUnsubmittedPrompt(""), false)
    assert.equal(hasUnsubmittedPrompt("$ ls -la\nhello\nworld"), false)
  })

  it("❯ 后空白 → false（已提交）", () => {
    assert.equal(hasUnsubmittedPrompt("❯ "), false)
    assert.equal(hasUnsubmittedPrompt("❯\n"), false)
    assert.equal(hasUnsubmittedPrompt("history\n❯ \n"), false)
  })

  it("❯ 后只有 ANSI 控制码 → false", () => {
    assert.equal(hasUnsubmittedPrompt("❯ \x1b[36m\x1b[0m"), false)
  })

  it("❯ 后只有 TUI 边框字符 → false", () => {
    assert.equal(hasUnsubmittedPrompt("❯ │\n┌────┐\n└────┘"), false)
    assert.equal(hasUnsubmittedPrompt("❯ ╭───╮"), false)
  })

  it("❯ 后有用户输入残留 → true（未提交）", () => {
    assert.equal(hasUnsubmittedPrompt("❯ hello world"), true)
    assert.equal(
      hasUnsubmittedPrompt("history\n❯ 回一句话证明你活着"),
      true,
    )
  })

  it("多个 ❯ 时只看最后一个", () => {
    // 历史里有过 ❯，最新一行的 ❯ 是空的 → 已提交
    const hist = [
      "❯ 第一条命令",
      "[output]",
      "❯ ",
    ].join("\n")
    assert.equal(hasUnsubmittedPrompt(hist), false)

    // 最新一行 ❯ 后有残留
    const dirty = [
      "❯ 老命令",
      "[output]",
      "❯ 没提交的新内容",
    ].join("\n")
    assert.equal(hasUnsubmittedPrompt(dirty), true)
  })

  it("ANSI 包裹的 ❯ 不影响识别", () => {
    // claude TUI 实际经常会染色 ❯
    assert.equal(
      hasUnsubmittedPrompt("\x1b[36m❯\x1b[0m \x1b[32m未提交内容\x1b[0m"),
      true,
    )
    assert.equal(hasUnsubmittedPrompt("\x1b[36m❯\x1b[0m "), false)
  })

  // codex 0.147.0 的 TUI 用 › (U+203A) 当提示符，不是 ❯ (U+276F)。
  // 只认 ❯ 会让 codex worker 的"未提交自检"永远返回 false，补 Enter 逻辑失效。
  // 下面两段是 2026-08-26 从测试设备 codex 实测 capture-pane 抄来的真实形态。
  it("codex 的 › 提示符后空白 → false（已提交）", () => {
    const idle = [
      "› Ask Codex to do anything",
      "  gpt-5.6-sol default · ~/AIproject/polyverse_samantha",
    ].join("\n")
    assert.equal(hasUnsubmittedPrompt(idle), false)
  })

  it("codex 的 › 提示符后有残留 → true（未提交）", () => {
    const pending = [
      "│ permissions: YOLO mode                      │",
      "╰─────────────────────────────────────────────╯",
      "› 请只回复这一行：PROBE-ALIVE-CHECK。不要做任何其他事。",
    ].join("\n")
    assert.equal(hasUnsubmittedPrompt(pending), true)
  })

  it("两种提示符混排时取最后出现的那个", () => {
    assert.equal(hasUnsubmittedPrompt("❯ 老的已提交\n› 新的没提交"), true)
    assert.equal(hasUnsubmittedPrompt("› 老的没提交\n❯ "), false)
  })
})
