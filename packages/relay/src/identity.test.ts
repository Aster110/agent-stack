/**
 * 身份指纹比对 — 分级判定
 * 样板取自主脑 server:brain 实测值。
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { compareIdentity, parseIdentity } from "./identity.js"

// 主脑 server:brain 实测：session 名 brain / cwd project / 前台 codex
const BRAIN = "brain|/home/example/workspace/project|codex"
// codex 自愈循环重启的瞬间，前台短暂变成 bash
const BRAIN_RESTARTING = "brain|/home/example/workspace/project|bash"

describe("parseIdentity", () => {
  it("拆出三元组", () => {
    assert.deepEqual(parseIdentity(BRAIN), {
      sessionName: "brain", cwd: "/home/example/workspace/project", command: "codex",
    })
  })
  it("字段数不对 → null", () => {
    assert.equal(parseIdentity("brain|/only/two"), null)
    assert.equal(parseIdentity("brain"), null)
    assert.equal(parseIdentity("a|b|c|d"), null)
  })
  it("非字符串 → null", () => {
    assert.equal(parseIdentity(null), null)
    assert.equal(parseIdentity(undefined), null)
  })
})

describe("compareIdentity", () => {
  it("完全一致 → match", () => {
    assert.equal(compareIdentity(BRAIN, BRAIN), "match")
  })

  it("只有前台进程名不同 → soft-mismatch（codex 自愈重启的瞬时态）", () => {
    // 这一条是关键：整串比对会把它判成换人，主脑在自愈期间就彻底收不到消息了
    assert.equal(compareIdentity(BRAIN, BRAIN_RESTARTING), "soft-mismatch")
  })

  it("session 名不同 → hard-mismatch（真被顶替）", () => {
    assert.equal(
      compareIdentity(BRAIN, "other|/home/example/workspace/project|codex"),
      "hard-mismatch",
    )
  })

  it("cwd 不同 → hard-mismatch（同名 session 但明显是别人）", () => {
    assert.equal(
      compareIdentity(BRAIN, "brain|/home/someone/other-repo|codex"),
      "hard-mismatch",
    )
  })

  it("cwd 和 command 都变 → hard-mismatch（cwd 一票否决，不给软重试）", () => {
    assert.equal(
      compareIdentity(BRAIN, "brain|/home/someone/other-repo|bash"),
      "hard-mismatch",
    )
  })

  it("格式陌生 → hard-mismatch（不因看不懂就放行）", () => {
    assert.equal(compareIdentity(BRAIN, "some-old-format"), "hard-mismatch")
    assert.equal(compareIdentity("some-old-format", BRAIN), "hard-mismatch")
  })

  it("两边都是同一个陌生格式且相等 → match", () => {
    assert.equal(compareIdentity("legacy-fp", "legacy-fp"), "match")
  })
})
