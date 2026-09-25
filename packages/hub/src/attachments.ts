import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import type http from "node:http"
import type { ImageAttachmentManifest } from "@cc-mesh/protocol"
import {
  DEFAULT_IMAGE_TTL_SECONDS, IMAGE_ATTACHMENT_MIMES, MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, MAX_IMAGE_TTL_SECONDS,
  isImageAttachmentMime, sniffImageAttachment,
} from "@cc-mesh/protocol"

export interface HubAttachmentOptions {
  rootDir: string
  maxBytes?: number
  quotaBytes?: number
  maxPixels?: number
  defaultTtlSeconds?: number
  maxTtlSeconds?: number
  now?: () => number
  sweepIntervalMs?: number
}

export interface HubAttachmentMount {
  httpPort: number
  sweepExpired(nowMs?: number): number
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  })
  res.end(text)
}

/** The stored bytes are served unchanged, so the declared type must match the magic bytes. */
function imageDimensions(bytes: Buffer, declared: string, maxPixels: number): { width: number; height: number } {
  const sniffed = sniffImageAttachment(bytes)
  if (!sniffed || sniffed.mime !== declared) {
    throw Object.assign(new Error("image bytes do not match the declared type"), { status: 415 })
  }
  if (sniffed.width * sniffed.height > maxPixels) {
    throw Object.assign(new Error("image pixel limit exceeded"), { status: 422 })
  }
  return { width: sniffed.width, height: sniffed.height }
}

function readRaw(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) tooLarge = true
      else chunks.push(Buffer.from(chunk))
    })
    req.on("end", () => tooLarge
      ? reject(Object.assign(new Error("attachment too large"), { status: 413 }))
      : resolve(Buffer.concat(chunks)))
    req.on("error", reject)
  })
}

export class BlobStore {
  readonly handleHttp: (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => Promise<boolean>
  private readonly root: string
  private readonly maxBytes: number
  private readonly quotaBytes: number
  private readonly maxPixels: number
  private readonly defaultTtlSeconds: number
  private readonly maxTtlSeconds: number
  private readonly now: () => number
  private readonly timer: NodeJS.Timeout

  constructor(opts: HubAttachmentOptions) {
    this.root = path.resolve(opts.rootDir)
    this.maxBytes = opts.maxBytes ?? MAX_IMAGE_BYTES
    this.quotaBytes = opts.quotaBytes ?? 512 * 1024 * 1024
    this.maxPixels = opts.maxPixels ?? MAX_IMAGE_PIXELS
    this.defaultTtlSeconds = opts.defaultTtlSeconds ?? DEFAULT_IMAGE_TTL_SECONDS
    this.maxTtlSeconds = opts.maxTtlSeconds ?? MAX_IMAGE_TTL_SECONDS
    this.now = opts.now ?? Date.now
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 })
    this.handleHttp = this.route.bind(this)
    this.timer = setInterval(() => this.sweepExpired(), opts.sweepIntervalMs ?? 60_000)
    this.timer.unref()
  }

  private paths(sha: string): { blob: string; meta: string } {
    if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error("invalid blob id")
    const blob = path.join(this.root, `${sha}.blob`)
    const meta = path.join(this.root, `${sha}.json`)
    const prefix = `${this.root}${path.sep}`
    if (!path.resolve(blob).startsWith(prefix) || !path.resolve(meta).startsWith(prefix)) throw new Error("unsafe blob path")
    return { blob, meta }
  }

  private readManifest(sha: string): ImageAttachmentManifest | null {
    try {
      return JSON.parse(fs.readFileSync(this.paths(sha).meta, "utf8")) as ImageAttachmentManifest
    } catch { return null }
  }

  private usage(): number {
    let total = 0
    for (const name of fs.readdirSync(this.root)) {
      if (/^[a-f0-9]{64}\.blob$/.test(name)) {
        try { total += fs.statSync(path.join(this.root, name)).size } catch { /* raced with sweep */ }
      }
    }
    return total
  }

  sweepExpired(nowMs = this.now()): number {
    let removed = 0
    for (const name of fs.readdirSync(this.root)) {
      const match = /^([a-f0-9]{64})\.json$/.exec(name)
      if (!match) continue
      const manifest = this.readManifest(match[1]!)
      if (!manifest || Date.parse(manifest.expiresAt) <= nowMs) {
        const p = this.paths(match[1]!)
        fs.rmSync(p.blob, { force: true })
        fs.rmSync(p.meta, { force: true })
        removed++
      }
    }
    return removed
  }

  close(): void { clearInterval(this.timer) }

  private async route(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    const method = (req.method ?? "GET").toUpperCase()
    const pathname = url.pathname.replace(/\/+$/, "") || "/"
    if (pathname === "/api/blobs" && method === "POST") {
      const declared = Number(req.headers["content-length"] ?? 0)
      if (Number.isFinite(declared) && declared > this.maxBytes) {
        json(res, 413, { ok: false, error: "attachment too large" }); return true
      }
      const mime = (req.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase()
      if (!isImageAttachmentMime(mime)) {
        json(res, 415, { ok: false, error: `unsupported image type; allowed: ${IMAGE_ATTACHMENT_MIMES.join(", ")}` }); return true
      }
      const rawTtl = req.headers["x-attachment-ttl"]
      const ttl = rawTtl == null || rawTtl === "" ? this.defaultTtlSeconds : Number(rawTtl)
      if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > this.maxTtlSeconds) {
        json(res, 400, { ok: false, error: "invalid attachment TTL" }); return true
      }
      try {
        const bytes = await readRaw(req, this.maxBytes)
        const { width, height } = imageDimensions(bytes, mime, this.maxPixels)
        const sha = createHash("sha256").update(bytes).digest("hex")
        const p = this.paths(sha)
        this.sweepExpired()
        const existing = this.readManifest(sha)
        if (existing && fs.existsSync(p.blob)) {
          json(res, 200, { ok: true, data: { manifest: existing } }); return true
        }
        if (this.usage() + bytes.length > this.quotaBytes) {
          json(res, 507, { ok: false, error: "attachment quota exceeded" }); return true
        }
        const createdMs = this.now()
        const manifest: ImageAttachmentManifest = {
          version: 1, id: `att-${sha}`, kind: "image", mime, size: bytes.length,
          sha256: sha, width, height, storageRef: `hub-blob:${sha}`,
          createdAt: new Date(createdMs).toISOString(), expiresAt: new Date(createdMs + ttl * 1000).toISOString(),
        }
        const temp = `${p.blob}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
        fs.writeFileSync(temp, bytes, { mode: 0o600, flag: "wx" })
        try { fs.renameSync(temp, p.blob) } catch (err: any) {
          fs.rmSync(temp, { force: true })
          if (err?.code !== "EEXIST") throw err
        }
        fs.writeFileSync(p.meta, JSON.stringify(manifest), { mode: 0o600 })
        json(res, 201, { ok: true, data: { manifest } })
      } catch (err: any) {
        json(res, err?.status ?? 500, { ok: false, error: err?.message ?? "blob upload failed" })
      }
      return true
    }

    const match = /^\/api\/blobs\/(att-([a-f0-9]{64}))$/.exec(pathname)
    if (!match) {
      if (pathname.startsWith("/api/blobs/")) { json(res, 400, { ok: false, error: "invalid blob id" }); return true }
      return false
    }
    if (method !== "GET" && method !== "HEAD") {
      json(res, 405, { ok: false, error: "method not allowed" }); return true
    }
    const manifest = this.readManifest(match[2]!)
    if (!manifest) { json(res, 404, { ok: false, error: "blob not found" }); return true }
    if (Date.parse(manifest.expiresAt) <= this.now()) { json(res, 410, { ok: false, error: "blob expired" }); return true }
    const p = this.paths(match[2]!)
    let bytes: Buffer
    try { bytes = fs.readFileSync(p.blob) } catch { json(res, 404, { ok: false, error: "blob not found" }); return true }

    let start = 0
    let end = bytes.length - 1
    let status = 200
    const range = req.headers.range
    if (range != null) {
      const r = /^bytes=(\d+)-(\d*)$/.exec(range)
      if (!r) {
        res.writeHead(416, { "content-range": `bytes */${bytes.length}`, "content-length": "0" }); res.end(); return true
      }
      start = Number(r[1]); end = r[2] ? Number(r[2]) : bytes.length - 1
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= bytes.length || end < start || end >= bytes.length) {
        res.writeHead(416, { "content-range": `bytes */${bytes.length}`, "content-length": "0" }); res.end(); return true
      }
      status = 206
    }
    const body = bytes.subarray(start, end + 1)
    res.writeHead(status, {
      "content-type": manifest.mime, "content-length": String(body.length), "accept-ranges": "bytes",
      ...(status === 206 ? { "content-range": `bytes ${start}-${end}/${bytes.length}` } : {}),
      "cache-control": "private, no-store",
    })
    res.end(method === "HEAD" ? undefined : body)
    return true
  }
}
