/**
 * 一条 app-server 连接（换行分隔 JSON-RPC 2.0）。这里用内存双工管道打，不起进程——
 * 起进程的那份在 real-client.test.ts。
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"

import { JSONRPC_METHOD_NOT_FOUND } from "../contracts.js"
import { AppServerConnection, type ConnectionEvent, type ConnTransport } from "./connection.js"

/** 假子进程：stdin/stdout 是我们能读能写的内存管道 */
class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid = 12345
  /** 客户端写给"服务端"的整行 */
  readonly written: string[] = []

  constructor() {
    super()
    let buf = ""
    this.stdin.on("data", (d: Buffer) => {
      buf += d.toString("utf8")
      for (;;) {
        const i = buf.indexOf("\n")
        if (i === -1) break
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (line.trim()) this.written.push(line)
      }
    })
  }

  /** 服务端 → 客户端 */
  say(raw: string): void {
    this.stdout.write(raw)
  }
  sayJson(obj: unknown): void {
    this.stdout.write(`${JSON.stringify(obj)}\n`)
  }
  asTransport(): ConnTransport {
    return this as unknown as ConnTransport
  }
}

function lastWritten(c: FakeChild): any {
  return JSON.parse(c.written[c.written.length - 1]!)
}

async function tick(ms = 5): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

describe("AppServerConnection：请求/应答", () => {
  it("request 发出的是合法 JSON-RPC，id 自增", async () => {
    const c = new FakeChild()
    const conn = new AppServerConnection(c.asTransport())
    const p1 = conn.request("initialize", { a: 1 }, 1000)
    await tick()
    const m1 = lastWritten(c)
    assert.equal(m1.jsonrpc, "2.0")
    assert.equal(m1.method, "initialize")
    assert.deepEqual(m1.params, { a: 1 })

    const p2 = conn.request("thread/start", { cwd: "/tmp" }, 1000)
    await tick()
    const m2 = lastWritten(c)
    assert.equal(m2.id > m1.id, true, "id 必须自增")

    c.sayJson({ jsonrpc: "2.0", id: m1.id, result: { ok: 1 } })
    c.sayJson({ jsonrpc: "2.0", id: m2.id, result: { ok: 2 } })
    assert.deepEqual((await p1).result, { ok: 1 })
    assert.deepEqual((await p2).result, { ok: 2 })
    await conn.shutdown(1)
  })

  it("params 为 undefined 时不写 params 键（account/rateLimits/read）", async () => {
    const c = new FakeChild()
    const conn = new AppServerConnection(c.asTransport())
    void conn.request("account/rateLimits/read", undefined, 100)
    await tick()
    assert.equal(Object.prototype.hasOwnProperty.call(lastWritten(c), "params"), false)
    await conn.shutdown(1)
  })

  it("超时不抛，走 {error}（调用方全是换路分支）", async () => {
    const c = new FakeChild()
    const conn = new AppServerConnection(c.asTransport())
    const r = await conn.request("thread/start", {}, 20)
    assert.equal(typeof r.error?.message, "string")
    assert.match(String(r.error?.message), /20ms/)
    await conn.shutdown(1)
  })

  it("错误应答原样透出 code", async () => {
    const c = new FakeChild()
    const conn = new AppServerConnection(c.asTransport())
    const p = conn.request("turn/start", {}, 500)
    await tick()
    c.sayJson({ jsonrpc: "2.0", id: lastWritten(c).id, error: { code: -32600, message: "missing field `type`" } })
    const r = await p
    assert.equal(r.error?.code, -32600)
    await conn.shutdown(1)
  })
})

describe("AppServerConnection：分帧", () => {
  it("banner 行（非 JSON）不打断协议", async () => {
    const c = new FakeChild()
    const conn = new AppServerConnection(c.asTransport())
    const p = conn.request("initialize", {}, 500)
    await tick()
    const id = lastWritten(c).id
    c.say("codex app-server listening\n")
    c.sayJson({ jsonrpc: "2.0", id, result: { codexHome: "/h" } })
    assert.deepEqual((await p).result, { codexHome: "/h" })
    await conn.shutdown(1)
  })

  it("一条 JSON 被切成两半也能拼回来", async () => {
    const c = new FakeChild()
    const conn = new AppServerConnection(c.asTransport())
    const p = conn.request("initialize", {}, 500)
    await tick()
    const id = lastWritten(c).id
    const full = JSON.stringify({ jsonrpc: "2.0", id, result: { codexHome: "/split" } })
    c.say(full.slice(0, 10))
    await tick()
    c.say(`${full.slice(10)}\n`)
    assert.deepEqual((await p).result, { codexHome: "/split" })
    await conn.shutdown(1)
  })

  it("一次写进来两条通知，两条都要收到", async () => {
    const c = new FakeChild()
    const seen: string[] = []
    const conn = new AppServerConnection(c.asTransport())
    conn.onEvent((ev) => {
      if (ev.kind === "notification") seen.push(ev.method)
    })
    c.say(
      `${JSON.stringify({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "t1", turn: { id: "u1" } } })}\n` +
        `${JSON.stringify({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "t1", turnId: "u1", item: { type: "agentMessage", text: "x" } } })}\n`,
    )
    await tick(20)
    assert.deepEqual(seen, ["turn/started", "item/completed"])
    await conn.shutdown(1)
  })
})

describe("AppServerConnection：通知按 threadId 路由", () => {
  it("事件带上解析出来的 threadId；thread/started 从 params.thread.id 取", async () => {
    const c = new FakeChild()
    const conn = new AppServerConnection(c.asTransport())
    const got: Array<{ m: string; t: string | null }> = []
    conn.onEvent((ev) => {
      if (ev.kind === "notification") got.push({ m: ev.method, t: ev.threadId })
    })
    c.sayJson({ jsonrpc: "2.0", method: "thread/started", params: { thread: { id: "A" } } })
    c.sayJson({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "B", turn: { id: "u" } } })
    c.sayJson({ jsonrpc: "2.0", method: "account/rateLimits/updated", params: { rateLimits: {} } })
    await tick(20)
    assert.deepEqual(got, [
      { m: "thread/started", t: "A" },
      { m: "turn/started", t: "B" },
      { m: "account/rateLimits/updated", t: null },
    ])
    await conn.shutdown(1)
  })

  it("退订之后不再收到", async () => {
    const c = new FakeChild()
    const conn = new AppServerConnection(c.asTransport())
    let n = 0
    const off = conn.onEvent(() => {
      n++
    })
    c.sayJson({ jsonrpc: "2.0", method: "warning", params: {} })
    await tick(10)
    off()
    c.sayJson({ jsonrpc: "2.0", method: "warning", params: {} })
    await tick(10)
    assert.equal(n, 1)
    await conn.shutdown(1)
  })
})

describe("AppServerConnection：ServerRequest 必须应答", () => {
  it("表里的方法照表回，事件标 replied=table", async () => {
    const c = new FakeChild()
    const evs: ConnectionEvent[] = []
    const conn = new AppServerConnection(c.asTransport(), { onEvent: (e) => evs.push(e) })
    c.sayJson({ jsonrpc: "2.0", id: 77, method: "execCommandApproval", params: {} })
    await tick(20)
    const reply = lastWritten(c)
    assert.equal(reply.id, 77)
    assert.deepEqual(reply.result, { decision: "approved" })
    const ev = evs.find((e) => e.kind === "server-request")
    assert.equal(ev && ev.kind === "server-request" && ev.replied, "table")
    await conn.shutdown(1)
  })

  it("未知方法回 -32601（沉默 = 那一轮永久挂死）", async () => {
    const c = new FakeChild()
    const evs: ConnectionEvent[] = []
    const conn = new AppServerConnection(c.asTransport(), { onEvent: (e) => evs.push(e) })
    c.sayJson({ jsonrpc: "2.0", id: 88, method: "x/unknown/request", params: {} })
    await tick(20)
    const reply = lastWritten(c)
    assert.equal(reply.id, 88)
    assert.equal(reply.error.code, JSONRPC_METHOD_NOT_FOUND)
    const ev = evs.find((e) => e.kind === "server-request")
    assert.equal(ev && ev.kind === "server-request" && ev.replied, "default-32601")
    await conn.shutdown(1)
  })

  it("故障注入 drop-serverrequest-default：只吞默认分支，表里的照样回", async () => {
    const c = new FakeChild()
    const evs: ConnectionEvent[] = []
    const conn = new AppServerConnection(c.asTransport(), {
      faults: new Set(["drop-serverrequest-default"]),
      onEvent: (e) => evs.push(e),
    })
    c.sayJson({ jsonrpc: "2.0", id: 91, method: "x/unknown/request", params: {} })
    await tick(20)
    assert.equal(c.written.length, 0, "未知请求被吞：一个字节都不许回")
    assert.equal(
      evs.some((e) => e.kind === "server-request" && e.replied === "dropped"),
      true,
    )

    c.sayJson({ jsonrpc: "2.0", id: 92, method: "execCommandApproval", params: {} })
    await tick(20)
    assert.equal(lastWritten(c).id, 92, "表里的方法不受故障影响")
    await conn.shutdown(1)
  })
})

describe("AppServerConnection：故障注入 drop-turn-started", () => {
  it("引擎吞掉 turn/started，其余通知照旧", async () => {
    const c = new FakeChild()
    const seen: string[] = []
    const conn = new AppServerConnection(c.asTransport(), { faults: new Set(["drop-turn-started"]) })
    conn.onEvent((ev) => {
      if (ev.kind === "notification") seen.push(ev.method)
    })
    c.sayJson({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "t", turn: { id: "u" } } })
    c.sayJson({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "t", turn: { id: "u", status: "completed" } } })
    await tick(20)
    assert.deepEqual(seen, ["turn/completed"])
    await conn.shutdown(1)
  })
})

describe("AppServerConnection：连接丢失", () => {
  it("子进程 exit → 在途 request 立刻拿到 error，并发 lost 事件", async () => {
    const c = new FakeChild()
    const evs: ConnectionEvent[] = []
    const conn = new AppServerConnection(c.asTransport(), { onEvent: (e) => evs.push(e) })
    const p = conn.request("turn/start", {}, 10_000)
    await tick()
    c.stderr.write("boom\n")
    await tick()
    c.emit("exit", 1, null)
    const r = await p
    assert.equal(typeof r.error?.message, "string")
    assert.match(String(r.error?.message), /code=1/)
    assert.equal(conn.alive, false)
    const lost = evs.find((e) => e.kind === "lost")
    assert.equal(!!lost, true)
    assert.match(lost && lost.kind === "lost" ? lost.reason : "", /boom/, "stderr 尾巴要带进 reason 便于定位")
  })

  it("已死的连接再 request 立刻 error，不挂住", async () => {
    const c = new FakeChild()
    const conn = new AppServerConnection(c.asTransport())
    c.emit("exit", 0, null)
    await tick()
    const r = await conn.request("x", {}, 10_000)
    assert.equal(!!r.error, true)
  })

  it("lost 只发一次（exit 后再来 error 事件不重复）", async () => {
    const c = new FakeChild()
    let n = 0
    const conn = new AppServerConnection(c.asTransport(), {
      onEvent: (e) => {
        if (e.kind === "lost") n++
      },
    })
    c.emit("exit", 1, null)
    c.emit("error", new Error("later"))
    await tick(10)
    assert.equal(n, 1)
  })
})
