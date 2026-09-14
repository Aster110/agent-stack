/**
 * DirectDispatcher 单测（M2）—— 选座逻辑独立于 HTTP 层。
 * 验收对应设计 §6.2：缺 to 拒绝；有 to 原样返回 + reason=explicit。
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { DirectDispatcher, DispatchError } from "./dispatch.js"
import type { DispatchTask } from "@cc-mesh/protocol"

function task(overrides: Partial<DispatchTask> = {}): DispatchTask {
  return { title: "跑一遍回归", payload: "pnpm test", ...overrides }
}

describe("DirectDispatcher.pick", () => {
  it("task.to 存在 → 返回 nodeId + reason=explicit", () => {
    const pick = new DirectDispatcher().pick(task({ to: "macbook:cc-a1b2" }))
    assert.deepEqual(pick, { nodeId: "macbook:cc-a1b2", reason: "explicit" })
  })

  it("v1 不填 seatId / accountFp（席位表是 v2 的事）", () => {
    const pick = new DirectDispatcher().pick(task({ to: "mini:cc-x" }))
    assert.equal(pick.seatId, undefined)
    assert.equal(pick.accountFp, undefined)
  })

  it("缺 to → 抛 DispatchError(400)", () => {
    assert.throws(
      () => new DirectDispatcher().pick(task()),
      (err: unknown) => err instanceof DispatchError && err.status === 400 && /missing required field: to/.test((err as Error).message),
    )
  })

  it("to 是空白字符串 → 同样拒绝（不当成合法目标）", () => {
    assert.throws(() => new DirectDispatcher().pick(task({ to: "   " })), DispatchError)
  })

  it("经 resolver 解析目标：pick.nodeId 是解析后的值", () => {
    const dispatcher = new DirectDispatcher((to) => (to === "worker" ? "macbook:cc-w0rk" : null))
    assert.equal(dispatcher.pick(task({ to: "worker" })).nodeId, "macbook:cc-w0rk")
  })

  it("resolver 判不可达（返回 null）→ 抛 DispatchError(400)，消息带原始 to", () => {
    const dispatcher = new DirectDispatcher(() => null)
    assert.throws(
      () => dispatcher.pick(task({ to: "ghost:cc-dead" })),
      (err: unknown) => err instanceof DispatchError && /ghost:cc-dead/.test((err as Error).message),
    )
  })

  it("resolver 只被调用一次（不重复查 registry）", () => {
    let calls = 0
    const dispatcher = new DirectDispatcher((to) => { calls++; return to })
    dispatcher.pick(task({ to: "macbook:cc-a1b2" }))
    assert.equal(calls, 1)
  })
})
