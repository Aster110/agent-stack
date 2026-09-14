/**
 * 图片附件协议红测。
 *
 * 这里冻结 manifest 的可序列化契约与安全边界；不接受 URL/路径，不接受过期、
 * 超限或形状不完整的数据。图片正文绝不能出现在 manifest 中。
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { ImageAttachmentManifest, SendRequest } from "./types.js"
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_TTL_SECONDS,
  validateImageAttachmentManifest,
  validateImageAttachmentManifests,
} from "./attachments.js"

const SHA = "a".repeat(64)
const NOW = Date.parse("2026-08-28T12:00:00.000Z")

function manifest(over: Partial<ImageAttachmentManifest> = {}): ImageAttachmentManifest {
  return {
    version: 1,
    id: `att-${SHA}`,
    kind: "image",
    mime: "image/png",
    size: 68,
    sha256: SHA,
    width: 1,
    height: 1,
    storageRef: `hub-blob:${SHA}`,
    createdAt: new Date(NOW - 1_000).toISOString(),
    expiresAt: new Date(NOW + 60_000).toISOString(),
    ...over,
  }
}

describe("ImageAttachmentManifest", () => {
  it("类型可挂在 SendRequest.attachments，且不改变无附件请求", () => {
    const oldRequest: SendRequest = { to: "mini:cc-b", message: "hello" }
    const imageRequest: SendRequest = { ...oldRequest, attachments: [manifest()] }
    assert.equal(oldRequest.attachments, undefined)
    assert.equal(imageRequest.attachments?.[0]?.storageRef, `hub-blob:${SHA}`)
  })

  it("合法 manifest 原样通过，且没有正文、token、URL 或本地路径字段", () => {
    const got = validateImageAttachmentManifest(manifest(), { nowMs: NOW })
    assert.deepEqual(got, manifest())
    const serialized = JSON.stringify(got)
    for (const forbidden of ["base64", "data:", "token", "localPath", "http://", "https://"]) {
      assert.equal(serialized.includes(forbidden), false, `manifest 不得含 ${forbidden}`)
    }
  })

  it("拒绝 URL、路径穿越、绝对路径及 id/sha/storageRef 不一致", () => {
    const bad = [
      manifest({ storageRef: "https://evil.invalid/a.png" }),
      manifest({ storageRef: "hub-blob:../secret" }),
      manifest({ storageRef: "/tmp/secret.png" }),
      manifest({ id: "att-../secret" }),
      manifest({ id: `att-${"b".repeat(64)}` }),
      manifest({ storageRef: `hub-blob:${"b".repeat(64)}` }),
      manifest({ sha256: "ABC" }),
    ]
    for (const value of bad) {
      assert.throws(() => validateImageAttachmentManifest(value, { nowMs: NOW }))
    }
  })

  it("拒绝过期、未来 createdAt、超长 TTL、超限字节和非法 MIME/像素", () => {
    const bad = [
      manifest({ expiresAt: new Date(NOW).toISOString() }),
      manifest({ createdAt: new Date(NOW + 1_000).toISOString() }),
      manifest({ expiresAt: new Date(NOW + (MAX_IMAGE_TTL_SECONDS + 1) * 1_000).toISOString() }),
      manifest({ size: MAX_IMAGE_BYTES + 1 }),
      manifest({ mime: "image/svg+xml" as "image/png" }),
      manifest({ mime: "image/jpeg" as "image/png" }),
      manifest({ mime: "image/gif" as "image/png" }),
      manifest({ mime: "image/webp" as "image/png" }),
      manifest({ width: 100_000, height: 100_000 }),
    ]
    for (const value of bad) {
      assert.throws(() => validateImageAttachmentManifest(value, { nowMs: NOW }))
    }
  })

  it("每消息图片数上限严格执行", () => {
    const max = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE }, () => manifest())
    assert.equal(validateImageAttachmentManifests(max, { nowMs: NOW }).length, max.length)
    assert.throws(() => validateImageAttachmentManifests([...max, manifest()], { nowMs: NOW }))
  })

  it("只接受字段完整的普通对象，并拒绝额外/危险字段", () => {
    const required = [
      "version", "id", "kind", "mime", "size", "sha256", "storageRef", "createdAt", "expiresAt",
    ] as const
    for (const key of required) {
      const value = { ...manifest() } as Record<string, unknown>
      delete value[key]
      assert.throws(() => validateImageAttachmentManifest(value, { nowMs: NOW }), `缺 ${key} 必须拒绝`)
    }
    for (const value of [
      null,
      undefined,
      [],
      "manifest",
      { ...manifest(), extra: true },
      { ...manifest(), localPath: "/tmp/leak.png" },
      { ...manifest(), url: "https://evil.invalid/a.png" },
      Object.assign(Object.create(null), manifest()),
    ]) {
      assert.throws(() => validateImageAttachmentManifest(value, { nowMs: NOW }))
    }
  })

  it("整数、枚举与时间字段使用严格类型和规范 ISO 顺序", () => {
    const bad = [
      manifest({ version: 2 as 1 }),
      manifest({ kind: "file" as "image" }),
      manifest({ size: 0 }),
      manifest({ size: 1.5 }),
      manifest({ size: Number.NaN }),
      manifest({ size: Number.POSITIVE_INFINITY }),
      manifest({ width: 0 }),
      manifest({ width: 1.2 }),
      manifest({ height: -1 }),
      manifest({ createdAt: "2026-08-28 11:59:59" }),
      manifest({ createdAt: "not-a-date" }),
      manifest({ expiresAt: "2026-08-28T12:01:00+00:00" }),
      manifest({ expiresAt: new Date(NOW - 2_000).toISOString() }),
      { ...manifest(), width: "1" },
      { ...manifest(), height: null },
    ]
    for (const value of bad) {
      assert.throws(() => validateImageAttachmentManifest(value, { nowMs: NOW }))
    }
  })

  it("manifest 列表自身也必须是数组，且不得用 undefined 项绕过校验", () => {
    for (const value of [null, {}, "one", [manifest(), undefined]]) {
      assert.throws(() => validateImageAttachmentManifests(value, { nowMs: NOW }))
    }
  })
})
