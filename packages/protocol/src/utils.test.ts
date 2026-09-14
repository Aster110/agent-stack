import { test } from "node:test"
import assert from "node:assert/strict"
import { genMessageId } from "./utils.js"

// 回归:同 sender 同毫秒连发 → id 必须唯一。
// 旧实现 msg-${Date.now()}-${from} 在同毫秒碰撞,叠加 store 的 INSERT OR REPLACE 会静默丢前一条。
test("genMessageId: 同 sender 高速连发不碰撞", () => {
  const ids = new Set<string>()
  const N = 10_000
  for (let i = 0; i < N; i++) {
    ids.add(genMessageId("computer1:cc-sender"))
  }
  assert.equal(ids.size, N, "同毫秒内生成的 id 出现重复")
})

test("genMessageId: 保持 msg- 前缀且含 sender(可读性/审计约定)", () => {
  const id = genMessageId("computer1:cc-x")
  assert.ok(id.startsWith("msg-"))
  assert.ok(id.includes("computer1:cc-x"))
})
