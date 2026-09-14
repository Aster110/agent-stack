/**
 * Protocol 类型测试 — 回合制可达性投递的类型层断言
 *
 * 这些断言主要靠 tsc 编译通过来机械验证（类型层）；运行期再补一道
 * 白名单数组检查，让 node --test 也能数到。
 * 禁止用 `as any` 绕过类型——一旦绕过就失去意义。
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { MessageStatus, DeliveryMode, NodeIdentity } from "./types.js"

describe("Protocol types — MessageStatus accepted", () => {
  it("MessageStatus 接受 accepted 字面量（类型层 + 运行期）", () => {
    // 类型层：以下赋值若 accepted 不是合法成员，tsc build 会红
    const accepted: MessageStatus = "accepted"
    const queued: MessageStatus = "queued"
    const delivered: MessageStatus = "delivered"
    const statuses: MessageStatus[] = [accepted, queued, delivered]
    // 运行期：accepted 是独立状态，不复用 queued
    assert.notEqual(accepted, queued, "accepted 必须区别于 queued（queued 已被离线排队占用）")
    assert.ok(statuses.includes("accepted"), "数组应含 accepted")
  })
})

describe("Protocol types — DeliveryMode 三态", () => {
  it("DeliveryMode union 只接受 inject/sse-pull/native-api", () => {
    const inject: DeliveryMode = "inject"
    const ssePull: DeliveryMode = "sse-pull"
    const nativeApi: DeliveryMode = "native-api"
    const all: DeliveryMode[] = [inject, ssePull, nativeApi]
    // 运行期白名单：bogus 不在合法集合内
    const whitelist = new Set<string>(["inject", "sse-pull", "native-api"])
    assert.ok(all.every((m) => whitelist.has(m)))
    assert.ok(!whitelist.has("bogus"), "bogus 不是合法 deliveryMode")
    // 下面这行若取消注释应导致 tsc 编译失败（预期 ts-error），保留作文档：
    // const bad: DeliveryMode = "bogus"
  })

  it("NodeIdentity.deliveryMode 可选：不带 / 带 sse-pull 均合法", () => {
    const base: NodeIdentity = {
      nodeId: "macbook:cc-x",
      deviceId: "macbook",
      shortId: "cc-x",
      role: "worker",
      description: "test",
      capabilities: [],
    }
    // 不带 deliveryMode 合法（可选字段）
    const withoutMode: NodeIdentity = { ...base }
    // 带 deliveryMode 合法
    const withMode: NodeIdentity = { ...base, deliveryMode: "sse-pull" }
    assert.equal(withoutMode.deliveryMode, undefined)
    assert.equal(withMode.deliveryMode, "sse-pull")
  })
})
