import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import type { ImageAttachmentManifest, MeshMessage } from "@cc-mesh/protocol"
import { IMAGE_ATTACHMENT_EXT, sniffImageAttachment, validateImageAttachmentManifest } from "@cc-mesh/protocol"

export interface AttachmentManagerOptions {
  hubHttpBase: string
  token: string
  cacheDir: string
  fetchImpl?: typeof fetch
  now?: () => number
  maxRetries?: number
  fetchTimeoutMs?: number
}

export interface MaterializedAttachment {
  localPath?: string
  error?: string
}

export interface AttachmentClient {
  upload(bytes: Buffer, mime: string, ttlSeconds?: number): Promise<ImageAttachmentManifest>
  materialize(manifest: ImageAttachmentManifest): Promise<MaterializedAttachment>
}

export async function formatAttachmentsForDelivery(
  text: string,
  msg: MeshMessage,
  manager?: Pick<AttachmentClient, "materialize">,
): Promise<string> {
  const raw = (msg.meta as any)?.attachments
  if (!Array.isArray(raw) || raw.length === 0) return text
  if (!manager) return `${text}\n[attachment unavailable: not configured]`
  const lines: string[] = []
  for (const item of raw) {
    try {
      const got = await manager.materialize(item as ImageAttachmentManifest)
      lines.push(got.localPath ? `[attachment] ${got.localPath}` : `[attachment unavailable: ${got.error ?? "unavailable"}]`)
    } catch {
      lines.push("[attachment unavailable: invalid manifest]")
    }
  }
  return `${text}\n${lines.join("\n")}`
}

export class AttachmentManager {
  private readonly base: URL
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly retries: number
  private readonly cacheDir: string
  private readonly fetchTimeoutMs: number
  private readonly materializeFlights = new Map<string, Promise<MaterializedAttachment>>()

  constructor(private readonly opts: AttachmentManagerOptions) {
    this.base = new URL(opts.hubHttpBase)
    if (!/^https?:$/.test(this.base.protocol)) throw new Error("Hub HTTP origin must use http(s)")
    this.base.pathname = this.base.pathname.replace(/\/+$/, "") || "/"
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.now = opts.now ?? Date.now
    this.retries = Number.isSafeInteger(opts.maxRetries) && opts.maxRetries! >= 0 ? opts.maxRetries! : 2
    this.fetchTimeoutMs = Number.isSafeInteger(opts.fetchTimeoutMs) && opts.fetchTimeoutMs! > 0
      ? opts.fetchTimeoutMs!
      : 15_000
    this.cacheDir = path.resolve(opts.cacheDir)
    fs.mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 })
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.opts.token}`, ...extra }
  }

  private async fetchOnce<T>(
    url: URL,
    init: RequestInit,
    consume: (response: Response) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error("attachment fetch timeout")), this.fetchTimeoutMs)
    try {
      const response = await this.fetchImpl(url, { ...init, signal: controller.signal })
      return await consume(response)
    } finally {
      clearTimeout(timer)
      // A completed attempt is terminal too: release listeners and make retry-signal state auditable.
      if (!controller.signal.aborted) controller.abort()
    }
  }

  async upload(bytes: Buffer, mime = "image/png", ttlSeconds?: number): Promise<ImageAttachmentManifest> {
    const url = new URL("api/blobs", this.base.href.endsWith("/") ? this.base : `${this.base.href}/`)
    let lastError: unknown
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await this.fetchOnce(url, {
          method: "POST",
          headers: this.headers({
            "Content-Type": mime,
            ...(ttlSeconds == null ? {} : { "X-Attachment-Ttl": String(ttlSeconds) }),
          }),
          body: bytes as unknown as BodyInit,
        }, async (response) => {
          if (!response.ok) throw new Error(`attachment upload failed (${response.status})`)
          const doc = await response.json() as any
          return validateImageAttachmentManifest(doc?.data?.manifest, { nowMs: this.now() })
        })
      } catch (err) { lastError = err }
    }
    const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "unavailable")
    throw new Error(`attachment upload unavailable: ${detail}`)
  }

  private cachePaths(manifest: ImageAttachmentManifest): { final: string; part: string; meta: string } {
    const name = `${manifest.id}.${IMAGE_ATTACHMENT_EXT[manifest.mime]}`
    const final = path.join(this.cacheDir, name)
    const part = `${final}.part`
    const meta = `${final}.json`
    const prefix = `${this.cacheDir}${path.sep}`
    for (const p of [final, part, meta]) if (!path.resolve(p).startsWith(prefix)) throw new Error("unsafe attachment cache path")
    return { final, part, meta }
  }

  materialize(input: ImageAttachmentManifest): Promise<MaterializedAttachment> {
    let manifest: ImageAttachmentManifest
    try { manifest = validateImageAttachmentManifest(input, { nowMs: this.now() }) }
    catch { return Promise.resolve({ error: "invalid manifest" }) }
    const existing = this.materializeFlights.get(manifest.sha256)
    if (existing) return existing
    const flight = this.materializeOne(manifest).finally(() => {
      if (this.materializeFlights.get(manifest.sha256) === flight) {
        this.materializeFlights.delete(manifest.sha256)
      }
    })
    this.materializeFlights.set(manifest.sha256, flight)
    return flight
  }

  private async materializeOne(manifest: ImageAttachmentManifest): Promise<MaterializedAttachment> {
    const p = this.cachePaths(manifest)
    try {
      if (fs.existsSync(p.final)) {
        const bytes = fs.readFileSync(p.final)
        if (this.verify(bytes, manifest)) {
          fs.writeFileSync(p.meta, JSON.stringify({ expiresAt: manifest.expiresAt }), { mode: 0o600 })
          return { localPath: p.final }
        }
        fs.rmSync(p.final, { force: true })
        fs.rmSync(p.meta, { force: true })
      }
      fs.rmSync(p.part, { force: true })
      let networkFailure = false
      let integrityFailure = false
      const url = new URL(`api/blobs/${manifest.id}`, this.base.href.endsWith("/") ? this.base : `${this.base.href}/`)

      for (let attempt = 0; attempt <= this.retries; attempt++) {
        const offset = fs.existsSync(p.part) ? fs.statSync(p.part).size : 0
        try {
          const result = await this.fetchOnce(url, {
            method: "GET",
            headers: this.headers(offset > 0 ? { Range: `bytes=${offset}-` } : {}),
          }, async (response) => {
            const chunk = Buffer.from(await response.arrayBuffer())
            return { response, chunk }
          })
          const { response, chunk } = result
          if (offset === 0 && response.status !== 200) throw new Error(`unexpected status ${response.status}`)
          if (offset > 0 && response.status !== 206) throw Object.assign(new Error("invalid range status"), { integrity: true })
          const mime = (response.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase()
          if (mime !== manifest.mime) throw Object.assign(new Error("mime integrity failure"), { integrity: true })
          if (offset > 0) {
            const parsed = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") ?? "")
            if (!parsed
              || Number(parsed[1]) !== offset
              || Number(parsed[2]) !== offset + chunk.length - 1
              || Number(parsed[3]) !== manifest.size
              || offset + chunk.length > manifest.size) {
              throw Object.assign(new Error("invalid Content-Range"), { integrity: true })
            }
          }
          if (offset + chunk.length > manifest.size) throw Object.assign(new Error("download size integrity failure"), { integrity: true })
          fs.appendFileSync(p.part, chunk, { mode: 0o600 })
          const current = fs.statSync(p.part).size
          if (current < manifest.size) {
            integrityFailure = true
            continue
          }
          const bytes = fs.readFileSync(p.part)
          if (!this.verify(bytes, manifest)) throw Object.assign(new Error("sha or mime integrity failure"), { integrity: true })
          fs.renameSync(p.part, p.final)
          fs.writeFileSync(p.meta, JSON.stringify({ expiresAt: manifest.expiresAt }), { mode: 0o600 })
          return { localPath: p.final }
        } catch (err: any) {
          if (err?.integrity) {
            integrityFailure = true
            break
          }
          networkFailure = true
        }
      }
      fs.rmSync(p.part, { force: true })
      return { error: integrityFailure ? "integrity" : networkFailure ? "unavailable" : "unavailable" }
    } catch {
      fs.rmSync(p.part, { force: true })
      return { error: "integrity" }
    }
  }

  private verify(bytes: Buffer, manifest: ImageAttachmentManifest): boolean {
    return bytes.length === manifest.size
      && sniffImageAttachment(bytes)?.mime === manifest.mime
      && createHash("sha256").update(bytes).digest("hex") === manifest.sha256
  }

  sweepExpired(nowMs = this.now()): number {
    let removed = 0
    for (const name of fs.readdirSync(this.cacheDir)) {
      if (!/^att-[a-f0-9]{64}\.(png|jpg|webp|gif)\.json$/.test(name)) continue
      const meta = path.join(this.cacheDir, name)
      let expired = true
      try { expired = Date.parse(JSON.parse(fs.readFileSync(meta, "utf8")).expiresAt) <= nowMs } catch { /* corrupt = remove */ }
      if (expired) {
        fs.rmSync(meta, { force: true })
        fs.rmSync(meta.slice(0, -5), { force: true })
        removed++
      }
    }
    return removed
  }
}
