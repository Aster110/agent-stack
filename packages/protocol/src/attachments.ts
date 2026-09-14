import type { ImageAttachmentManifest } from "./types.js"

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

  if (value.version !== 1 || value.kind !== "image" || value.mime !== "image/png") {
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
