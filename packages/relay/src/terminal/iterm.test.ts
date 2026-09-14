import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { buildFastInjectScript, buildSlowInjectScript } from "./iterm.js"

describe("ITermTerminal inject AppleScript", () => {
  it("fast path uses newline NO and a real Return key event to submit", () => {
    const script = buildFastInjectScript(
      "ABCDEF12-3456-7890-ABCD-EF1234567890",
      "hello \"codex\"",
      "5179",
    )
    assert.match(script, /write text "hello \\"codex\\"" newline NO/)
    assert.match(script, /select aSession/)
    assert.match(script, /tell application "System Events"/)
    assert.match(script, /delay 0\.1/)
    assert.match(script, /key code 36/)
    assert.doesNotMatch(script, /ASCII character 13/)
  })

  it("slow path uses the same submit sequence", () => {
    const script = buildSlowInjectScript(
      "ABCDEF12-3456-7890-ABCD-EF1234567890",
      "multi\nline",
    )
    assert.match(script, /write text "multi\nline" newline NO/)
    assert.match(script, /select aSession/)
    assert.match(script, /tell application "System Events"/)
    assert.match(script, /delay 0\.1/)
    assert.match(script, /key code 36/)
    assert.doesNotMatch(script, /ASCII character 13/)
  })
})
