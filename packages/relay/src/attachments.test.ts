/** Relay 附件上传/物化红测：固定 Hub origin、完整性校验、断点与安全 cache。 */
import { afterEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http, { type Server } from "node:http"
import type { AddressInfo } from "node:net"
import type { ImageAttachmentManifest, MeshMessage } from "@cc-mesh/protocol"
import { AttachmentManager, formatAttachmentsForDelivery } from "./attachments.js"

const TOKEN = "relay-test-token"
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
)
const SHA = createHash("sha256").update(PNG).digest("hex")
const NOW = Date.parse("2026-08-28T12:00:00.000Z")
const JPEG = Buffer.concat([Buffer.from("ffd8ffe000104a46494600010100000100010000", "hex"),
  Buffer.from([0xff, 0xc0, 0, 17, 8, 0, 6, 0, 8, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]), Buffer.from("ffd9", "hex")])
const JPEG_SHA = createHash("sha256").update(JPEG).digest("hex")
function jpegManifest(): ImageAttachmentManifest {
  return manifest({ id: `att-${JPEG_SHA}`, mime: "image/jpeg", size: JPEG.length, sha256: JPEG_SHA, width: 8, height: 6, storageRef: `hub-blob:${JPEG_SHA}` })
}

function manifest(over: Partial<ImageAttachmentManifest> = {}): ImageAttachmentManifest {
  return {
    version: 1, id: `att-${SHA}`, kind: "image", mime: "image/png", size: PNG.length,
    sha256: SHA, width: 1, height: 1, storageRef: `hub-blob:${SHA}`,
    createdAt: new Date(NOW - 1_000).toISOString(), expiresAt: new Date(NOW + 60_000).toISOString(),
    ...over,
  }
}

async function within<T>(promise: Promise<T>, timeoutMs = 500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`operation exceeded ${timeoutMs}ms hard test bound`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

describe("AttachmentManager", () => {
  const roots: string[] = []
  const servers: Server[] = []
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  function manager(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}): { manager: AttachmentManager; root: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccmesh-relay-att-"))
    roots.push(root)
    return {
      root,
      manager: new AttachmentManager({
        hubHttpBase: "http://127.0.0.1:29999", token: TOKEN, cacheDir: root,
        fetchImpl, now: () => NOW, maxRetries: 1, ...extra,
      }),
    }
  }

  it("上传只发 raw bytes 到固定 Hub，Bearer 不进入返回 manifest", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init: init ?? {} })
      return new Response(JSON.stringify({ ok: true, data: { manifest: manifest() } }), {
        status: 201, headers: { "Content-Type": "application/json" },
      })
    }
    const { manager: m } = manager(fetchImpl as typeof fetch)
    const got = await m.upload(PNG, "image/png", 60)
    assert.deepEqual(got, manifest())
    assert.equal(calls[0]?.url, "http://127.0.0.1:29999/api/blobs")
    assert.equal(calls[0]?.init.method, "POST")
    assert.equal((calls[0]?.init.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`)
    assert.deepEqual(Buffer.from(calls[0]?.init.body as Uint8Array), PNG)
    assert.equal(JSON.stringify(got).includes(TOKEN), false)
  })

  it("合法下载校验后原子物化到 cache 内安全路径", async () => {
    const fetchImpl = async (): Promise<Response> => new Response(PNG, {
      status: 200,
      headers: { "Content-Type": "image/png", "Content-Length": String(PNG.length) },
    })
    const { manager: m, root } = manager(fetchImpl as typeof fetch)
    const got = await m.materialize(manifest())
    assert.equal(got.error, undefined)
    assert.ok(got.localPath)
    assert.equal(fs.realpathSync(got.localPath!).startsWith(fs.realpathSync(root) + path.sep), true)
    assert.deepEqual(fs.readFileSync(got.localPath!), PNG)
    assert.equal(fs.readdirSync(root).some((x) => x.endsWith(".part")), false)
  })

  it("JPEG 原字节按声明 MIME 物化为 .jpg，字节与 SHA 与原图一致；MIME 或魔数不符判完整性失败", async () => {
    const ok = manager((async (): Promise<Response> => new Response(JPEG, {
      status: 200, headers: { "Content-Type": "image/jpeg", "Content-Length": String(JPEG.length) },
    })) as typeof fetch)
    const got = await ok.manager.materialize(jpegManifest())
    assert.equal(got.error, undefined)
    assert.match(got.localPath!, /att-[a-f0-9]{64}\.jpg$/)
    assert.deepEqual(fs.readFileSync(got.localPath!), JPEG)
    assert.equal(createHash("sha256").update(fs.readFileSync(got.localPath!)).digest("hex"), JPEG_SHA)
    assert.equal(ok.manager.sweepExpired(NOW + 120_000), 1, "TTL 清理同样覆盖 .jpg 缓存")
    assert.equal(fs.existsSync(got.localPath!), false)
    for (const [bytes, type] of [[JPEG, "image/png"], [PNG, "image/jpeg"]] as const) {
      const bad = manager((async (): Promise<Response> => new Response(bytes, {
        status: 200, headers: { "Content-Type": type, "Content-Length": String(bytes.length) },
      })) as typeof fetch, { maxRetries: 0 })
      const res = await bad.manager.materialize(jpegManifest())
      assert.equal(res.localPath, undefined)
      assert.equal(res.error, "integrity")
    }
  })

  it("篡改/截断下载不暴露 localPath，并清理 .part", async () => {
    for (const bytes of [Buffer.from("tampered"), PNG.subarray(0, PNG.length - 1)]) {
      const fetchImpl = async (): Promise<Response> => new Response(bytes, {
        status: 200,
        headers: { "Content-Type": "image/png", "Content-Length": String(bytes.length) },
      })
      const { manager: m, root } = manager(fetchImpl as typeof fetch, { maxRetries: 0 })
      const got = await m.materialize(manifest())
      assert.equal(got.localPath, undefined)
      assert.match(got.error ?? "", /integrity|sha|size|mime/i)
      assert.equal(fs.readdirSync(root).some((x) => x.endsWith(".part")), false)
    }
  })

  it("过期/URL/path storageRef 在发网络前拒绝，关闭 SSRF 与路径穿越", async () => {
    let calls = 0
    const fetchImpl = async (): Promise<Response> => { calls++; return new Response(PNG) }
    const { manager: m } = manager(fetchImpl as typeof fetch)
    const bad = [
      manifest({ expiresAt: new Date(NOW).toISOString() }),
      manifest({ storageRef: "https://evil.invalid/p.png" }),
      manifest({ storageRef: "hub-blob:../secret" }),
      manifest({ storageRef: "/etc/passwd" }),
      manifest({ id: "att-../../secret" }),
    ]
    for (const value of bad) {
      const got = await m.materialize(value)
      assert.equal(got.localPath, undefined)
      assert.ok(got.error)
    }
    assert.equal(calls, 0, "非法 manifest 不得触发任何 fetch")
  })

  it("截断后以 Range 续传；重试耗尽时明确 unavailable", async () => {
    const cut = Math.floor(PNG.length / 2)
    const ranges: Array<string | null> = []
    let attempt = 0
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers)
      ranges.push(headers.get("Range"))
      attempt++
      if (attempt === 1) {
        return new Response(PNG.subarray(0, cut), {
          status: 200,
          headers: { "Content-Type": "image/png", "Content-Length": String(PNG.length) },
        })
      }
      return new Response(PNG.subarray(cut), {
        status: 206,
        headers: {
          "Content-Type": "image/png",
          "Content-Length": String(PNG.length - cut),
          "Content-Range": `bytes ${cut}-${PNG.length - 1}/${PNG.length}`,
        },
      })
    }
    const { manager: m } = manager(fetchImpl as typeof fetch)
    const ok = await m.materialize(manifest())
    assert.ok(ok.localPath)
    assert.deepEqual(ranges, [null, `bytes=${cut}-`])
    assert.deepEqual(fs.readFileSync(ok.localPath!), PNG, "续传最终文件必须逐字节等于原 PNG")

    let downAttempts = 0
    const alwaysDown = async (): Promise<Response> => { downAttempts++; throw new Error("hub down") }
    const { manager: down } = manager(alwaysDown as typeof fetch, { maxRetries: 1 })
    const failed = await down.materialize(manifest())
    assert.equal(failed.localPath, undefined)
    assert.equal(failed.error, "unavailable")
    assert.equal(downAttempts, 2, "总尝试次数必须精确为首次 + maxRetries")
  })

  it("upload/materialize 每次 fetch 都带超时 AbortSignal，卡住时有界重试并降级正文", async () => {
    let calls = 0
    let aborts = 0
    const signals: AbortSignal[] = []
    const startedAborted: boolean[] = []
    const hangingFetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls++
      const signal = init?.signal
      assert.ok(signal instanceof AbortSignal, "每次 fetch 必须携带 AbortSignal")
      startedAborted.push(signal.aborted)
      const previous = signals.at(-1)
      if (previous) {
        assert.equal(previous.aborted, true, "开始下一次重试前，前一次 signal 必须已最终 abort")
        assert.notEqual(signal, previous, "每次重试必须新建 AbortSignal，禁止复用已 abort 的 signal")
      }
      signals.push(signal)
      return new Promise<Response>((_resolve, reject) => {
        const onAbort = () => { aborts++; reject(new Error("fetch aborted by attachment timeout")) }
        if (signal.aborted) onAbort()
        else signal.addEventListener("abort", onAbort, { once: true })
      })
    }
    const { manager: m } = manager(hangingFetch as typeof fetch, {
      fetchTimeoutMs: 20,
      maxRetries: 1,
    })

    await assert.rejects(() => within(m.upload(PNG, "image/png", 60)), /abort|timeout|unavailable/i)
    assert.equal(calls, 2, "内容寻址上传允许首次 + 1 次有界重试")
    assert.equal(aborts, 2)

    const materialized = await within(m.materialize(manifest()))
    assert.deepEqual(materialized, { error: "unavailable" })
    assert.equal(calls, 4, "物化同样只能首次 + 1 次有界重试")
    assert.equal(aborts, 4)

    const msg: MeshMessage = {
      id: "timeout-body", from: "computer2:cc-source", to: "mini:cc-target", type: "chat",
      payload: "正文不能丢", createdAt: new Date(NOW).toISOString(), meta: { attachments: [manifest()] },
    }
    const delivery = await within(formatAttachmentsForDelivery("正文不能丢", msg, m))
    assert.match(delivery, /^正文不能丢/)
    assert.match(delivery, /attachment unavailable/i)
    assert.equal(calls, 6)
    assert.equal(aborts, 6)
    assert.deepEqual(startedAborted, Array(6).fill(false), "每次 fetch 开始时 signal 必须尚未 aborted")
    assert.equal(new Set(signals).size, signals.length, "每次 fetch attempt 必须拥有独立 signal")
    assert.equal(signals.every((signal) => signal.aborted), true)
  })

  it("错误 Content-Range 不得拼接或暴露路径，重试次数精确", async () => {
    const cut = Math.floor(PNG.length / 2)
    for (const contentRange of [
      `bytes ${cut + 1}-${PNG.length - 1}/${PNG.length}`,
      `bytes ${cut}-${PNG.length - 1}/${PNG.length + 1}`,
      `bytes ${cut}-${PNG.length}/${PNG.length}`,
      "garbage",
    ]) {
      let attempts = 0
      const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        attempts++
        const range = new Headers(init?.headers).get("Range")
        if (!range) {
          return new Response(PNG.subarray(0, cut), {
            status: 200,
            headers: { "Content-Type": "image/png", "Content-Length": String(PNG.length) },
          })
        }
        return new Response(PNG.subarray(cut), {
          status: 206,
          headers: {
            "Content-Type": "image/png",
            "Content-Length": String(PNG.length - cut),
            "Content-Range": contentRange,
          },
        })
      }
      const { manager: m, root } = manager(fetchImpl as typeof fetch, { maxRetries: 1 })
      const failed = await m.materialize(manifest())
      assert.equal(failed.localPath, undefined, contentRange)
      assert.match(failed.error ?? "", /integrity|range|unavailable/i)
      assert.equal(attempts, 2, `${contentRange}: 只能首次 + 1 次重试`)
      assert.equal(fs.readdirSync(root).some((x) => x.endsWith(".part")), false)
    }
  })

  it("两台 Relay 经一个临时 Hub 跨机传图，各自 cache 独立且字节一致", async () => {
    let stored = Buffer.alloc(0)
    const hub = http.createServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401).end(); return }
      if (req.method === "POST" && req.url === "/api/blobs") {
        const chunks: Buffer[] = []
        req.on("data", (c) => chunks.push(Buffer.from(c)))
        req.on("end", () => {
          stored = Buffer.concat(chunks)
          res.writeHead(201, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ ok: true, data: { manifest: manifest() } }))
        })
        return
      }
      if (req.method === "GET" && req.url === `/api/blobs/att-${SHA}`) {
        res.writeHead(200, { "Content-Type": "image/png", "Content-Length": String(stored.length) })
        res.end(stored)
        return
      }
      res.writeHead(404).end()
    })
    await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", resolve))
    servers.push(hub)
    const base = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`
    const sender = manager(fetch, { hubHttpBase: base }).manager
    const receiverState = manager(fetch, { hubHttpBase: base })
    const uploaded = await sender.upload(PNG, "image/png", 60)
    const received = await receiverState.manager.materialize(uploaded)
    assert.ok(received.localPath)
    assert.deepEqual(fs.readFileSync(received.localPath!), PNG)
    assert.notEqual(path.dirname(received.localPath!), path.dirname((await sender.materialize(uploaded)).localPath!))
  })

  it("同 SHA 并发物化 single-flight，只下载一次并共享最终安全路径", async () => {
    let fetchCalls = 0
    const fetchImpl = async (): Promise<Response> => {
      fetchCalls++
      await new Promise((resolve) => setTimeout(resolve, 25))
      return new Response(PNG, {
        status: 200,
        headers: { "Content-Type": "image/png", "Content-Length": String(PNG.length) },
      })
    }
    const { manager: m, root } = manager(fetchImpl as typeof fetch, { maxRetries: 0 })
    const results = await Promise.all(Array.from({ length: 12 }, () => m.materialize(manifest())))
    assert.equal(fetchCalls, 1, "同 SHA 并发必须复用一个在飞下载")
    assert.equal(results.every((item) => item.error === undefined && item.localPath), true)
    assert.equal(new Set(results.map((item) => item.localPath)).size, 1)
    const finalPath = results[0]!.localPath!
    assert.equal(fs.realpathSync(finalPath).startsWith(fs.realpathSync(root) + path.sep), true)
    assert.deepEqual(fs.readFileSync(finalPath), PNG)
    assert.equal(fs.readdirSync(root).some((name) => name.endsWith(".part")), false)
  })

  it("同 SHA 并发失败共享结算；flight 必须清理，下一次可重新 fetch 成功", async () => {
    let fetchCalls = 0
    let fail = true
    const fetchImpl = async (): Promise<Response> => {
      fetchCalls++
      await new Promise((resolve) => setTimeout(resolve, 20))
      if (fail) throw new Error("temporary hub outage")
      return new Response(PNG, {
        status: 200,
        headers: { "Content-Type": "image/png", "Content-Length": String(PNG.length) },
      })
    }
    const { manager: m, root } = manager(fetchImpl as typeof fetch, { maxRetries: 0 })
    const failed = await Promise.all(Array.from({ length: 8 }, () => m.materialize(manifest())))
    assert.equal(fetchCalls, 1, "同 SHA 并发失败也只能共享一个在飞 fetch")
    assert.deepEqual(failed, Array.from({ length: 8 }, () => ({ error: "unavailable" })))
    assert.equal(fs.readdirSync(root).some((name) => name.endsWith(".part")), false)

    fail = false
    const retried = await m.materialize(manifest())
    assert.equal(fetchCalls, 2, "失败 flight 结算后必须从 map 删除，后续调用才能重新 fetch")
    assert.ok(retried.localPath)
    assert.deepEqual(fs.readFileSync(retried.localPath!), PNG)
  })

  it("本地 cache 到期 sweep 删除文件，不保留隐私残片", async () => {
    let clock = NOW
    const fetchImpl = async (): Promise<Response> => new Response(PNG, {
      status: 200,
      headers: { "Content-Type": "image/png", "Content-Length": String(PNG.length) },
    })
    const state = manager(fetchImpl as typeof fetch, { now: () => clock })
    const got = await state.manager.materialize(manifest())
    assert.ok(got.localPath && fs.existsSync(got.localPath))
    clock = Date.parse(manifest().expiresAt) + 1
    assert.equal(state.manager.sweepExpired(clock), 1)
    assert.equal(fs.existsSync(got.localPath!), false)
  })
})
