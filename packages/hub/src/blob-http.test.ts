/** Hub 临时图片 Blob HTTP 面红测：仅 localhost 随机端口 + 临时目录。 */
import { afterEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHub, type HubInstance } from "./hub.js"
import { attachmentsFromEnv } from "./index.js"

const TOKEN = "test-only-hub-token"
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
)
const PNG_RED = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP8z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
)

interface JsonResponse { ok: boolean; data?: { manifest?: any }; error?: string }

function auth(token = TOKEN): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

async function upload(base: string, bytes = PNG, mime = "image/png", ttl = 60): Promise<Response> {
  return fetch(`${base}/api/blobs`, {
    method: "POST",
    headers: { ...auth(), "Content-Type": mime, "X-Attachment-Ttl": String(ttl) },
    body: bytes,
  })
}

describe("Hub blob HTTP", () => {
  const hubs: HubInstance[] = []
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(hubs.splice(0).map((h) => h.close()))
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  async function start(extra: Record<string, unknown> = {}): Promise<{
    hub: HubInstance
    server: NonNullable<HubInstance["attachments"]>
    base: string
    root: string
  }> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccmesh-blob-http-"))
    roots.push(root)
    const hub = await createHub({
      port: 0,
      ledger: { dbPath: path.join(root, "ledger.db"), token: TOKEN, httpPort: 0, quiet: true },
      attachments: {
        rootDir: path.join(root, "blobs"),
      maxBytes: 1024, quotaBytes: 4096, maxPixels: 100, defaultTtlSeconds: 60,
      ...extra,
      },
    })
    hubs.push(hub)
    assert.ok(hub.ledger?.httpPort)
    assert.ok(hub.attachments, "createHub attachments 必须完成真实挂载")
    assert.equal(hub.attachments.httpPort, hub.ledger.httpPort, "Blob 必须扩展同一个 Ledger HTTP server")
    return { hub, server: hub.attachments, base: `http://127.0.0.1:${hub.attachments.httpPort}`, root }
  }

  it("合法 PNG 上传生成完整 manifest；同内容二次上传去重", async () => {
    const { base, root } = await start()
    const first = await upload(base)
    assert.equal(first.status, 201)
    const one = await first.json() as JsonResponse
    const second = await upload(base)
    assert.equal(second.status, 200, "去重命中返回 200，不重复写")
    const two = await second.json() as JsonResponse
    assert.deepEqual(two.data?.manifest, one.data?.manifest)
    const m = one.data?.manifest
    assert.equal(m.kind, "image")
    assert.equal(m.mime, "image/png")
    assert.equal(m.size, PNG.length)
    assert.match(m.sha256, /^[a-f0-9]{64}$/)
    assert.equal(m.id, `att-${m.sha256}`)
    assert.equal(m.storageRef, `hub-blob:${m.sha256}`)
    assert.deepEqual([m.width, m.height], [1, 1])
    const files = fs.readdirSync(root, { recursive: true }).filter((x) => String(x).endsWith(".blob"))
    assert.equal(files.length, 1, "内容寻址只落一份正文")
  })

  it("无/错 Bearer 均拒绝上传与下载，且 token 不进入错误正文", async () => {
    const { base } = await start()
    const noToken = await fetch(`${base}/api/blobs`, { method: "POST", headers: { "Content-Type": "image/png" }, body: PNG })
    const badToken = await fetch(`${base}/api/blobs`, { method: "POST", headers: { ...auth("wrong"), "Content-Type": "image/png" }, body: PNG })
    assert.equal(noToken.status, 401)
    assert.equal(badToken.status, 401)
    assert.equal((await badToken.text()).includes("wrong"), false)
    const ok = await (await upload(base)).json() as JsonResponse
    const id = ok.data?.manifest?.id
    assert.equal((await fetch(`${base}/api/blobs/${id}`)).status, 401)
    assert.equal((await fetch(`${base}/api/blobs/${id}`, { headers: auth("wrong") })).status, 401)
  })

  it("GET/HEAD 与单段 Range 可恢复下载，字节保持一致", async () => {
    const { base } = await start()
    const doc = await (await upload(base)).json() as JsonResponse
    const id = doc.data?.manifest?.id
    const head = await fetch(`${base}/api/blobs/${id}`, { method: "HEAD", headers: auth() })
    assert.equal(head.status, 200)
    assert.equal(Number(head.headers.get("content-length")), PNG.length)
    const cut = Math.floor(PNG.length / 2)
    const first = await fetch(`${base}/api/blobs/${id}`, { headers: { ...auth(), Range: `bytes=0-${cut - 1}` } })
    const rest = await fetch(`${base}/api/blobs/${id}`, { headers: { ...auth(), Range: `bytes=${cut}-` } })
    assert.equal(first.status, 206)
    assert.equal(rest.status, 206)
    assert.equal(first.headers.get("content-range"), `bytes 0-${cut - 1}/${PNG.length}`)
    assert.equal(rest.headers.get("content-range"), `bytes ${cut}-${PNG.length - 1}/${PNG.length}`)
    const finalBytes = Buffer.concat([Buffer.from(await first.arrayBuffer()), Buffer.from(await rest.arrayBuffer())])
    assert.equal(finalBytes.length, PNG.length)
    assert.deepEqual(finalBytes, PNG)

    for (const range of [`bytes=${PNG.length}-`, "bytes=9-3", "bytes=0-1,3-4", "items=0-1"]) {
      const invalid = await fetch(`${base}/api/blobs/${id}`, { headers: { ...auth(), Range: range } })
      assert.equal(invalid.status, 416, `${range} 必须是 416`)
      assert.equal(invalid.headers.get("content-range"), `bytes */${PNG.length}`)
      assert.equal((await invalid.arrayBuffer()).byteLength, 0)
    }
  })

  it("超字节、伪 MIME、非法 MIME 与像素炸弹分别拒绝且不落 blob", async () => {
    const { base, root } = await start({ maxBytes: PNG.length, maxPixels: 10 })
    assert.equal((await upload(base, Buffer.concat([PNG, Buffer.from([0])]))).status, 413)
    assert.equal((await upload(base, Buffer.from("not an image"), "image/png")).status, 415)
    assert.equal((await upload(base, PNG, "image/jpeg")).status, 415)
    assert.equal((await upload(base, PNG, "image/svg+xml")).status, 415)
    const huge = Buffer.from(PNG)
    huge.writeUInt32BE(1000, 16)
    huge.writeUInt32BE(1000, 20)
    assert.equal((await upload(base, huge, "image/png")).status, 422)
    const files = fs.readdirSync(root, { recursive: true }).filter((x) => String(x).endsWith(".blob"))
    assert.equal(files.length, 0)
  })

  it("总存储配额先清过期，再对新内容返回 507；重复内容不重复计费", async () => {
    let clock = Date.parse("2026-08-28T12:00:00.000Z")
    const { base, root } = await start({ maxBytes: 1024, quotaBytes: PNG_RED.length, now: () => clock })
    assert.equal((await upload(base)).status, 201)
    assert.equal((await upload(base)).status, 200, "同 sha 去重不得重复占配额")
    assert.equal((await upload(base, PNG_RED)).status, 507)

    clock += 61_000
    assert.equal((await upload(base, PNG_RED)).status, 201, "配额判断前必须清走过期 PNG")
    const files = fs.readdirSync(root, { recursive: true }).filter((x) => String(x).endsWith(".blob"))
    assert.equal(files.length, 1)
  })

  it("并发上传同一 SHA 只原子落盘一次、只计一次配额", async () => {
    const { base, root } = await start({ maxBytes: 1024, quotaBytes: PNG.length })
    const responses = await Promise.all(Array.from({ length: 8 }, () => upload(base)))
    const statuses = responses.map((r) => r.status)
    assert.equal(statuses.filter((s) => s === 201).length, 1, JSON.stringify(statuses))
    assert.equal(statuses.filter((s) => s === 200).length, 7, JSON.stringify(statuses))
    assert.equal(statuses.includes(507), false, "同 SHA 竞态不得重复计费后误报配额满")
    const docs = await Promise.all(responses.map((r) => r.json() as Promise<JsonResponse>))
    assert.equal(new Set(docs.map((d) => JSON.stringify(d.data?.manifest))).size, 1)
    const files = fs.readdirSync(root, { recursive: true }).filter((x) => String(x).endsWith(".blob"))
    assert.equal(files.length, 1)
  })

  it("TTL 到期 GET=410，sweep 删除正文；无 token 配置 fail-closed", async () => {
    let clock = Date.parse("2026-08-28T12:00:00.000Z")
    const { base, server, root } = await start({ now: () => clock })
    const doc = await (await upload(base, PNG, "image/png", 1)).json() as JsonResponse
    const id = doc.data?.manifest?.id
    clock += 1_001
    assert.equal((await fetch(`${base}/api/blobs/${id}`, { headers: auth() })).status, 410)
    assert.equal(server.sweepExpired(clock), 1)
    assert.equal(fs.readdirSync(root, { recursive: true }).some((x) => String(x).endsWith(".blob")), false)

    const noTokenRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ccmesh-blob-no-token-"))
    roots.push(noTokenRoot)
    const noToken = await createHub({
      port: 0,
      ledger: { dbPath: path.join(noTokenRoot, "ledger.db"), httpPort: 0, quiet: true },
      attachments: { rootDir: path.join(noTokenRoot, "blobs") },
    })
    hubs.push(noToken)
    assert.equal(noToken.ledger?.httpPort, null)
    assert.equal(noToken.attachments, null, "没有共享 HTTP/token 时附件必须 fail-closed")
  })

  it("Hub close 同时关闭共享 Ledger/Blob HTTP 端口", async () => {
    const { hub, base } = await start()
    assert.equal((await fetch(`${base}/api/ledger/accounts`, { headers: auth() })).status, 200)
    assert.equal((await upload(base)).status, 201)
    await hub.close()
    hubs.splice(hubs.indexOf(hub), 1)
    await assert.rejects(() => fetch(`${base}/api/ledger/accounts`, { headers: auth() }))
    await assert.rejects(() => fetch(`${base}/api/blobs/att-${"a".repeat(64)}`, { headers: auth() }))
  })

  it("路径穿越/绝对路径/恶意 id 全部拒绝，不读 root 外文件", async () => {
    const { base, root } = await start()
    const sentinel = path.join(path.dirname(root), `sentinel-${path.basename(root)}`)
    fs.writeFileSync(sentinel, "TOP-SECRET")
    try {
      for (const id of ["..%2Fsentinel", "%2Fetc%2Fpasswd", "att-..", "https:%2F%2Fevil.invalid%2Fx"]) {
        const r = await fetch(`${base}/api/blobs/${id}`, { headers: auth() })
        assert.ok([400, 404].includes(r.status), `${id} 应被拒绝，实际 ${r.status}`)
        assert.equal((await r.text()).includes("TOP-SECRET"), false)
      }
    } finally {
      fs.rmSync(sentinel, { force: true })
    }
  })
})

describe("attachmentsFromEnv / index 装配", () => {
  it("缺 token 或显式关闭时 fail-closed；合法配置才返回 Hub attachment mount", () => {
    assert.equal(attachmentsFromEnv({} as NodeJS.ProcessEnv), undefined)
    assert.equal(attachmentsFromEnv({ HUB_TOKEN: "token", ATTACHMENTS_DISABLED: "1" } as NodeJS.ProcessEnv), undefined)
    assert.equal(attachmentsFromEnv({ HUB_TOKEN: " ", ATTACHMENT_BLOB_DIR: "/tmp/should-not-open" } as NodeJS.ProcessEnv), undefined)

    const got = attachmentsFromEnv({
      HUB_TOKEN: " shared-token ",
      ATTACHMENT_BLOB_DIR: "~/mesh-test-blobs",
      ATTACHMENT_MAX_BYTES: "2048",
      ATTACHMENT_QUOTA_BYTES: "8192",
      ATTACHMENT_MAX_PIXELS: "1000",
      ATTACHMENT_DEFAULT_TTL_SECONDS: "120",
    } as NodeJS.ProcessEnv)!
    assert.deepEqual(got, {
      rootDir: path.join(os.homedir(), "mesh-test-blobs"),
      maxBytes: 2048,
      quotaBytes: 8192,
      maxPixels: 1000,
      defaultTtlSeconds: 120,
    })
    assert.equal(Object.hasOwn(got, "token"), false, "附件配置复用 Ledger HTTP token，不复制秘密")
    assert.equal(Object.hasOwn(got, "port"), false, "附件配置不得另开监听端口")
  })

  it("非法数字回落安全默认值，不接受负数/小数/NaN", () => {
    const got = attachmentsFromEnv({
      HUB_TOKEN: "token",
      ATTACHMENT_MAX_BYTES: "-1",
      ATTACHMENT_QUOTA_BYTES: "1.5",
      ATTACHMENT_MAX_PIXELS: "NaN",
      ATTACHMENT_DEFAULT_TTL_SECONDS: "0",
    } as NodeJS.ProcessEnv)!
    for (const key of ["maxBytes", "quotaBytes", "maxPixels", "defaultTtlSeconds"] as const) {
      assert.equal(Number.isSafeInteger(got[key]) && got[key]! > 0, true, `${key} 必须回落正整数默认值`)
    }
  })
})
