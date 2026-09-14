/**
 * 分帧 / 帧分类 / 通知路由键 的单测（纯函数，无进程）。
 * 先红纪律：见本目录 README 注释与 LANES.md §2。
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { LineSplitter, classifyFrame, encodeFrame, notificationThreadId } from "./wire.js"

describe("LineSplitter", () => {
  it("一次一行", () => {
    const s = new LineSplitter()
    assert.deepEqual(s.push('{"a":1}\n'), ['{"a":1}'])
  })

  it("一个 chunk 里两条消息都要吐出来", () => {
    const s = new LineSplitter()
    assert.deepEqual(s.push('{"a":1}\n{"b":2}\n'), ['{"a":1}', '{"b":2}'])
  })

  it("一条 JSON 被切成两个 chunk：拼回来再吐", () => {
    const s = new LineSplitter()
    assert.deepEqual(s.push('{"a":'), [])
    assert.deepEqual(s.push('1}\n'), ['{"a":1}'])
  })

  it("CRLF 也算行尾，\\r 不留在正文里", () => {
    const s = new LineSplitter()
    assert.deepEqual(s.push('{"a":1}\r\n'), ['{"a":1}'])
  })

  it("没有换行结尾的尾巴留在缓冲里，flush 才吐", () => {
    const s = new LineSplitter()
    assert.deepEqual(s.push('{"a":1}'), [])
    assert.deepEqual(s.flush(), ['{"a":1}'])
    assert.deepEqual(s.flush(), [])
  })

  it("Buffer 输入也吃", () => {
    const s = new LineSplitter()
    assert.deepEqual(s.push(Buffer.from('{"z":9}\n', "utf8")), ['{"z":9}'])
  })

  it("空行丢掉，不当帧", () => {
    const s = new LineSplitter()
    assert.deepEqual(s.push('\n\n{"a":1}\n'), ['{"a":1}'])
  })
})

describe("encodeFrame", () => {
  it("换行结尾，正文里不含裸换行", () => {
    const line = encodeFrame({ jsonrpc: "2.0", id: 1, method: "x", params: { text: "a\nb" } })
    assert.equal(line.endsWith("\n"), true)
    assert.equal(line.slice(0, -1).includes("\n"), false)
    assert.deepEqual(JSON.parse(line), { jsonrpc: "2.0", id: 1, method: "x", params: { text: "a\nb" } })
  })

  it("params 为 undefined 时整个键不出现（account/rateLimits/read 要求 params 缺席）", () => {
    const line = encodeFrame({ jsonrpc: "2.0", id: 7, method: "account/rateLimits/read", params: undefined })
    assert.equal(line.includes("params"), false)
  })
})

describe("classifyFrame", () => {
  it("有 id 有 result = 应答", () => {
    assert.deepEqual(classifyFrame('{"jsonrpc":"2.0","id":3,"result":{"ok":true}}'), {
      kind: "response",
      id: 3,
      result: { ok: true },
      error: undefined,
    })
  })

  it("result 为 null 也是应答，不是垃圾", () => {
    const f = classifyFrame('{"jsonrpc":"2.0","id":3,"result":null}')
    assert.equal(f.kind, "response")
  })

  it("有 id 有 error = 应答", () => {
    const f = classifyFrame('{"jsonrpc":"2.0","id":4,"error":{"code":-32600,"message":"bad"}}')
    assert.equal(f.kind, "response")
    if (f.kind === "response") assert.equal(f.error?.code, -32600)
  })

  it("有 method 有 id = 服务端请求（必须应答）", () => {
    const f = classifyFrame('{"jsonrpc":"2.0","id":9,"method":"execCommandApproval","params":{"a":1}}')
    assert.equal(f.kind, "server-request")
    if (f.kind === "server-request") {
      assert.equal(f.method, "execCommandApproval")
      assert.equal(f.id, 9)
    }
  })

  it("只有 method = 通知", () => {
    const f = classifyFrame('{"jsonrpc":"2.0","method":"turn/started","params":{"threadId":"t1"}}')
    assert.equal(f.kind, "notification")
    if (f.kind === "notification") assert.equal(f.method, "turn/started")
  })

  it("banner / 日志行不是 JSON，直接忽略", () => {
    assert.equal(classifyFrame("codex app-server listening on stdio").kind, "non-json")
    assert.equal(classifyFrame("").kind, "non-json")
  })

  it("以 { 开头但解析不了 = 坏帧", () => {
    assert.equal(classifyFrame('{"a":').kind, "malformed")
  })

  it("既无 method 也无 result/error = 认不出来", () => {
    assert.equal(classifyFrame('{"id":1}').kind, "unknown")
  })
})

describe("notificationThreadId", () => {
  it("thread/started 的 threadId 在 params.thread.id，不在顶层", () => {
    assert.equal(notificationThreadId("thread/started", { thread: { id: "th-1" } }), "th-1")
  })

  it("turn/started 顶层就有 threadId", () => {
    assert.equal(notificationThreadId("turn/started", { threadId: "th-2", turn: { id: "tu-1" } }), "th-2")
  })

  it("account/rateLimits/updated 是广播，没有 thread", () => {
    assert.equal(notificationThreadId("account/rateLimits/updated", { rateLimits: {} }), null)
  })

  it("mcpServer/startupStatus/updated 的 threadId 可以是 null（进程级启动）", () => {
    assert.equal(
      notificationThreadId("mcpServer/startupStatus/updated", { threadId: null, name: "node_repl", status: "ready" }),
      null,
    )
    assert.equal(
      notificationThreadId("mcpServer/startupStatus/updated", { threadId: "th-3", name: "node_repl", status: "ready" }),
      "th-3",
    )
  })

  it("params 不是对象时返回 null 而不是抛", () => {
    assert.equal(notificationThreadId("whatever", undefined), null)
    assert.equal(notificationThreadId("whatever", "str"), null)
  })
})
