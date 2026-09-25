import type { ImageAttachmentManifest, ImageAttachmentMime } from "./types.js"

/** Image types carried byte-for-byte (never transcoded). Anything else is refused at every hop. */
export const IMAGE_ATTACHMENT_MIMES: readonly ImageAttachmentMime[] = ["image/png", "image/jpeg", "image/webp", "image/gif"]
/** Cache/file extension per whitelisted type. */
export const IMAGE_ATTACHMENT_EXT: Readonly<Record<ImageAttachmentMime, string>> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
}

export function isImageAttachmentMime(value: unknown): value is ImageAttachmentMime {
  return typeof value === "string" && (IMAGE_ATTACHMENT_MIMES as readonly string[]).includes(value)
}

/**
 * The real type and dimensions of an image from its magic bytes (PNG, JPEG, WebP, GIF); null for
 * anything else, including truncated headers. Declared Content-Type and file names are never trusted.
 */
export function sniffImageAttachment(b: Uint8Array): { mime: ImageAttachmentMime; width: number; height: number } | null {
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength)
  const out = (mime: ImageAttachmentMime, width: number, height: number) => width > 0 && height > 0 ? { mime, width, height } : null
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a && buf.toString("latin1", 12, 16) === "IHDR") {
    return out("image/png", buf.readUInt32BE(16), buf.readUInt32BE(20))
  }
  if (buf.length >= 10 && (buf.toString("latin1", 0, 6) === "GIF87a" || buf.toString("latin1", 0, 6) === "GIF89a")) {
    return out("image/gif", buf.readUInt16LE(6), buf.readUInt16LE(8))
  }
  if (buf.length >= 16 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") {
    const chunk = buf.toString("latin1", 12, 16)
    if (chunk === "VP8X" && buf.length >= 30) return out("image/webp", buf.readUIntLE(24, 3) + 1, buf.readUIntLE(27, 3) + 1)
    if (chunk === "VP8 " && buf.length >= 30 && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
      return out("image/webp", buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff)
    }
    if (chunk === "VP8L" && buf.length >= 25 && buf[20] === 0x2f) {
      const bits = buf.readUInt32LE(21)
      return out("image/webp", (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
    }
    return null
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let i = 2
    while (i + 3 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue }
      const marker = buf[i + 1]!
      if (marker === 0xff) { i++; continue }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
      if (marker === 0xd9 || marker === 0xda) return null
      const len = buf.readUInt16BE(i + 2)
      if (len < 2) return null
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        if (i + 9 > buf.length) return null
        return out("image/jpeg", buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5))
      }
      i += 2 + len
    }
  }
  return null
}

export const MAX_ATTACHMENTS_PER_MESSAGE = 4
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_IMAGE_TTL_SECONDS = 7 * 24 * 60 * 60
export const DEFAULT_IMAGE_TTL_SECONDS = 24 * 60 * 60
export const MAX_IMAGE_PIXELS = 25_000_000

const SHA_RE = /^[a-f0-9]{64}$/
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const FIELDS = new Set([
  "version", "id", "kind", "mime", "size", "sha256", "width", "height",
  "storageRef", "createdAt", "expiresAt",
])
const REQUIRED = [
  "version", "id", "kind", "mime", "size", "sha256", "storageRef", "createdAt", "expiresAt",
] as const

export interface AttachmentValidationOptions {
  nowMs?: number
  maxBytes?: number
  maxTtlSeconds?: number
  maxPixels?: number
}

function positiveSafeInt(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${name} must be a positive safe integer`)
  return value as number
}

function iso(value: unknown, name: string): number {
  if (typeof value !== "string" || !ISO_RE.test(value)) throw new Error(`${name} must be canonical ISO`)
  const ms = Date.parse(value)
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) throw new Error(`${name} must be canonical ISO`)
  return ms
}

export function validateImageAttachmentManifest(
  input: unknown,
  opts: AttachmentValidationOptions = {},
): ImageAttachmentManifest {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new Error("attachment manifest must be a plain object")
  }
  const value = input as Record<string, unknown>
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !FIELDS.has(key)) throw new Error(`unknown attachment field: ${String(key)}`)
  }
  for (const key of REQUIRED) if (!Object.hasOwn(value, key)) throw new Error(`missing attachment field: ${key}`)

  if (value.version !== 1 || value.kind !== "image" || !isImageAttachmentMime(value.mime)) {
    throw new Error("unsupported attachment version, kind, or mime")
  }
  if (typeof value.sha256 !== "string" || !SHA_RE.test(value.sha256)) throw new Error("invalid sha256")
  const sha = value.sha256
  if (value.id !== `att-${sha}` || value.storageRef !== `hub-blob:${sha}`) throw new Error("attachment identity mismatch")

  positiveSafeInt(value.size, "size")
  if ((value.size as number) > (opts.maxBytes ?? MAX_IMAGE_BYTES)) throw new Error("attachment too large")
  if (Object.hasOwn(value, "width")) positiveSafeInt(value.width, "width")
  if (Object.hasOwn(value, "height")) positiveSafeInt(value.height, "height")
  if (typeof value.width === "number" && typeof value.height === "number") {
    if (value.width * value.height > (opts.maxPixels ?? MAX_IMAGE_PIXELS)) throw new Error("image pixel limit exceeded")
  }

  const created = iso(value.createdAt, "createdAt")
  const expires = iso(value.expiresAt, "expiresAt")
  const nowMs = opts.nowMs ?? Date.now()
  if (created > nowMs) throw new Error("createdAt is in the future")
  if (expires <= nowMs || expires <= created) throw new Error("attachment expired")
  if (expires - created > (opts.maxTtlSeconds ?? MAX_IMAGE_TTL_SECONDS) * 1000) throw new Error("attachment TTL too long")
  return input as ImageAttachmentManifest
}

export function validateImageAttachmentManifests(
  input: unknown,
  opts: AttachmentValidationOptions = {},
): ImageAttachmentManifest[] {
  if (!Array.isArray(input)) throw new Error("attachments must be an array")
  if (input.length > MAX_ATTACHMENTS_PER_MESSAGE) throw new Error(`maximum ${MAX_ATTACHMENTS_PER_MESSAGE} attachments`)
  return Array.from(input, (item) => validateImageAttachmentManifest(item, opts))
}
