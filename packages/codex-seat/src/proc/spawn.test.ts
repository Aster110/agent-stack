/** Lane C —— 引擎启动参数与二进制解析（先红后绿） */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { APP_SERVER_BASE_ARGS, CODEX_BIN_FALLBACK } from "../contracts.js"
import { buildAppServerArgs, resolveCodexBin } from "./spawn.js"
import { SEAT_TAG_KEY } from "./orphans.js"

describe("app-server 参数", () => {
  it("基线参数原封不动打头，席位标签跟在后面", () => {
    const args = buildAppServerArgs("codex-main", "abc123", [])
    assert.deepEqual(args.slice(0, APP_SERVER_BASE_ARGS.length), [...APP_SERVER_BASE_ARGS])
    assert.deepEqual(args.slice(-2), ["-c", `${SEAT_TAG_KEY}="codex-main/abc123"`])
  })

  it("extraArgs 插在标签之前（标签永远是最后一对，孤儿谓词才好认）", () => {
    const args = buildAppServerArgs("s", "i", ["-c", 'model_reasoning_effort="medium"'])
    assert.equal(args.includes('model_reasoning_effort="medium"'), true)
    assert.deepEqual(args.slice(-2), ["-c", `${SEAT_TAG_KEY}="s/i"`])
  })

  it("绝不含 --remote-control（红线）", () => {
    assert.equal(buildAppServerArgs("s", "i", ["--remote-control"]).includes("--remote-control"), false)
  })
})

describe("codex 二进制解析（决策 4）", () => {
  it("config.codex.bin 优先", () => {
    assert.equal(resolveCodexBin("/tmp/my-codex", { which: () => "/opt/homebrew/bin/codex", exists: () => true }), "/tmp/my-codex")
  })
  it("其次 PATH 里的 codex（用 which，不认交互 shell 的同名函数）", () => {
    assert.equal(resolveCodexBin(null, { which: () => "/opt/homebrew/bin/codex", exists: () => true }), "/opt/homebrew/bin/codex")
  })
  it("最后 ChatGPT.app 内置", () => {
    assert.equal(resolveCodexBin(null, { which: () => null, exists: (p) => p === CODEX_BIN_FALLBACK }), CODEX_BIN_FALLBACK)
  })
  it("全都没有就抛，而不是返回 'codex' 让 spawn 去猜", () => {
    assert.throws(() => resolveCodexBin(null, { which: () => null, exists: () => false }))
  })
})
