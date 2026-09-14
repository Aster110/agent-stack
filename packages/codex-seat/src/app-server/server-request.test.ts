/**
 * ServerRequest 应答表。**这张表漏一个，那一轮就永久挂死**——codex 在等我们回话，
 * 而我们在等 turn/completed。默认分支回 -32601 是 E16 的靶心，删掉必须挂死。
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { JSONRPC_METHOD_NOT_FOUND } from "../contracts.js"
import { SERVER_REQUEST_METHODS, answerForServerRequest, tableAnswer } from "./server-request.js"

describe("answerForServerRequest", () => {
  it("codex 0.151.0 的 ServerRequest 全集都在表里（漏一个 = 那一轮挂死）", () => {
    // 名单来自 `codex app-server generate-ts` 的 ServerRequest 联合体（2026-09-02 实测 0.151.0）
    const fromProtocol = [
      "account/chatgptAuthTokens/refresh",
      "applyPatchApproval",
      "attestation/generate",
      "execCommandApproval",
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
      "item/tool/call",
      "item/tool/requestUserInput",
      "mcpServer/elicitation/request",
    ]
    for (const m of fromProtocol) {
      assert.notEqual(tableAnswer(m), null, `${m} 不在应答表里`)
    }
    assert.deepEqual([...SERVER_REQUEST_METHODS].filter((m) => fromProtocol.includes(m)).sort(), fromProtocol.sort())
  })

  it("审批类一律准（席位全程 bypass）", () => {
    assert.deepEqual(answerForServerRequest("execCommandApproval"), { result: { decision: "approved" } })
    assert.deepEqual(answerForServerRequest("applyPatchApproval"), { result: { decision: "approved" } })
    assert.deepEqual(answerForServerRequest("item/commandExecution/requestApproval"), { result: { decision: "accept" } })
    assert.deepEqual(answerForServerRequest("item/fileChange/requestApproval"), { result: { decision: "accept" } })
  })

  it("需要人当场填表的一律拒，不吊着", () => {
    assert.deepEqual(answerForServerRequest("mcpServer/elicitation/request"), { result: { action: "decline" } })
    assert.deepEqual(answerForServerRequest("item/tool/requestUserInput"), { result: { answers: {} } })
    assert.deepEqual(answerForServerRequest("item/tool/call"), { result: { contentItems: [], success: false } })
  })

  it("席位不持有 ChatGPT 凭据：刷新请求明确回错（在表里，但是 error）", () => {
    const r = answerForServerRequest("account/chatgptAuthTokens/refresh")
    assert.equal(r.error?.code, JSONRPC_METHOD_NOT_FOUND)
    assert.notEqual(tableAnswer("account/chatgptAuthTokens/refresh"), null, "它在表里，replied 应记 table")
  })

  it("currentTime/read 回的是秒级 epoch 整数", () => {
    const r = answerForServerRequest("currentTime/read") as { result: { currentTimeAt: number } }
    assert.equal(Number.isInteger(r.result.currentTimeAt), true)
    assert.equal(Math.abs(r.result.currentTimeAt * 1000 - Date.now()) < 60_000, true)
  })

  it("未知方法走默认分支：-32601，不是沉默", () => {
    assert.equal(tableAnswer("x/unknown/request"), null)
    const r = answerForServerRequest("x/unknown/request")
    assert.equal(r.error?.code, JSONRPC_METHOD_NOT_FOUND)
    assert.equal(typeof r.error?.message, "string")
    assert.equal(r.result, undefined)
  })

  it("默认分支的 message 里带上方法名，便于定位协议漂移", () => {
    const r = answerForServerRequest("some/brand/new/thing")
    assert.match(String(r.error?.message), /some\/brand\/new\/thing/)
  })

  it("不冒充 cc2wechat：message 里不出现旧客户端名", () => {
    const r = answerForServerRequest("x/unknown/request")
    assert.equal(String(r.error?.message).includes("cc2wechat"), false)
  })
})
