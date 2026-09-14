/**
 * B3 Ledger 读 API — 设计 §7 契约 + §8 安全。
 *
 * 全部 GET 只读（唯一的写口是 PUT /api/ledger/seats：席位登记表得有人填），
 * 全部要求 `Authorization: Bearer <token>`，token 用恒定时间比较。
 *
 * 安全默认值：**没有 token 就拒绝启动**。:19901 是公网口，宁可 Hub 起不来账本 API
 * 也不能在公网开一个裸的全网聊天记录接口（设计 §8.2）。
 *
 * 用 node:http 裸写，不引 express——Hub 部署包越薄越好，这里只有 7 条路由。
 */
import http from "node:http"
import { timingSafeEqual } from "node:crypto"
import type { AddressInfo } from "node:net"
import type { DeviceInventory } from "@cc-mesh/protocol"
import { LEDGER_HTTP_PORT } from "@cc-mesh/protocol"
import type { CcTodoChangeInput, CcTodoOutcome, CcTodoResolveInput, LedgerStore, QuotaRow } from "./store.js"

export interface LedgerHttpOptions {
  store: LedgerStore
  /** Bearer token（Hub 复用 HUB_TOKEN）。空 → 拒绝启动。 */
  token: string
  port?: number
  host?: string
  /** 实时在线视图（Hub 内存 relays）。不注入 → agents 端点里一律 offline。 */
  presence?: () => DeviceInventory[]
  /** Optional authenticated routes mounted on the same HTTP server. */
  extension?: LedgerHttpExtension
}

export type LedgerHttpExtension = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
) => boolean | Promise<boolean>

export interface LedgerHttpInstance {
  port: number
  close(): Promise<void>
}

const MAX_BODY_BYTES = 1_000_000
const CC_TODO_MAX_BODY_BYTES = 64 * 1024
const CC_TODO_TITLE_PREVIEW_MAX = 160
/**
 * P142 T1 正文字段上限（按 code point 计）。契约：
 * 2-Projects/P65-cc-todo-cli/03-正文上云与归属联结-契约-2026-09-11.md
 */
const CC_TODO_CONTENT_LIMITS: ReadonlyArray<readonly [key: string, max: number]> = [
  ["title", 500], ["note", 4000], ["output", 4000], ["type", 64], ["assignedTo", 200], ["taskId", 200],
]

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8")
  const bb = Buffer.from(b, "utf8")
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
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

function num(v: string | null): number | undefined {
  if (v === null) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function str(v: string | null): string | undefined {
  return v === null || v === "" ? undefined : v
}

function truthy(v: string | null): boolean {
  return v !== null && v !== "" && v !== "0" && v.toLowerCase() !== "false"
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on("data", (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

function readLimitedBody(req: http.IncomingMessage, maxBytes: number): Promise<{ raw: string; tooLarge: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        tooLarge = true
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => resolve({ raw: Buffer.concat(chunks).toString("utf8"), tooLarge }))
    req.on("error", reject)
  })
}

const CC_TODO_FIELDS = new Set([
  "schemaVersion", "uid", "legacyId", "category", "status", "project", "dependsOn",
  "createdAt", "updatedAt", "baseRevision", "opId", "originDevice", "contentDigest",
  "shareTitlePreview", "titlePreview",
  // P142 T1：脱敏后的正文 + 归属；contentPrivate=true 时正文一律不得携带
  "title", "note", "output", "type", "assignedTo", "taskId", "contentPrivate",
])

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value))
}

function isSensitivePreview(value: string): boolean {
  return /(?:sk-[a-z0-9_-]+|\/(?:Users|home|private)\/|-----BEGIN [A-Z ]+PRIVATE KEY-----|(?:bearer|token|password|secret|api[_-]?key)\s*[:=])/i
    .test(value)
}

function validateCcTodoBody(body: unknown, uid: string, resolve: false): CcTodoChangeInput | null
function validateCcTodoBody(body: unknown, uid: string, resolve: true): CcTodoResolveInput | null
function validateCcTodoBody(body: unknown, uid: string, resolve: boolean): CcTodoChangeInput | CcTodoResolveInput | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null
  const source = body as Record<string, unknown>
  const allowed = resolve ? new Set([...CC_TODO_FIELDS, "resolvesOpId"]) : CC_TODO_FIELDS
  if (Object.keys(source).some((key) => !allowed.has(key))) return null
  if (source.schemaVersion !== 1 || source.uid !== uid) return null
  if (typeof source.uid !== "string" || source.uid.length === 0) return null
  if (typeof source.legacyId !== "string" || source.legacyId.length === 0) return null
  if (source.category !== "cc" && source.category !== "aster") return null
  if (typeof source.status !== "string" || source.status.length === 0) return null
  if (source.project !== null && typeof source.project !== "string") return null
  if (!Array.isArray(source.dependsOn) || !source.dependsOn.every((x) => typeof x === "string")) return null
  if (!isIsoDate(source.createdAt) || !isIsoDate(source.updatedAt)) return null
  if (!Number.isSafeInteger(source.baseRevision) || (source.baseRevision as number) < 0) return null
  if (typeof source.opId !== "string" || source.opId.length === 0) return null
  if (typeof source.originDevice !== "string" || source.originDevice.length === 0) return null
  if (typeof source.contentDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(source.contentDigest)) return null
  if (source.shareTitlePreview !== undefined && typeof source.shareTitlePreview !== "boolean") return null
  if (source.titlePreview !== undefined) {
    if (source.shareTitlePreview !== true || typeof source.titlePreview !== "string") return null
    if ([...source.titlePreview].length > CC_TODO_TITLE_PREVIEW_MAX) return null
  }
  if (resolve && (typeof source.resolvesOpId !== "string" || source.resolvesOpId.length === 0)) return null
  if (source.contentPrivate !== undefined && typeof source.contentPrivate !== "boolean") return null

  const clean = { ...source }
  for (const [key, max] of CC_TODO_CONTENT_LIMITS) {
    const value = source[key]
    if (value === undefined) continue
    if (typeof value !== "string" || [...value].length > max) return null
    // 自称私密却带正文 = 客户端坏了，整次拒绝而不是替它删——别让 bug 靠服务端兜底变成隐性行为
    if (source.contentPrivate === true) return null
    if (value.length === 0) { delete clean[key]; continue }      // 空串视同未上传
    if (isSensitivePreview(value)) delete clean[key]              // 服务端二道脱敏：命中即省略，不打码
  }
  if (typeof clean.titlePreview === "string" && isSensitivePreview(clean.titlePreview)) {
    delete clean.titlePreview
  }
  return clean as unknown as CcTodoChangeInput | CcTodoResolveInput
}

const TODO_ERROR: Record<CcTodoOutcome, { status: number; error: string } | null> = {
  applied: null, duplicate: null, converged: null, resolved: null,
  tamper: { status: 409, error: "op_id_tamper" },
  conflict: { status: 409, error: "revision_conflict" },
  future: { status: 409, error: "future_revision" },
  resolve_unknown: { status: 404, error: "conflict_not_found" },
  resolve_not_conflict: { status: 409, error: "not_a_conflict" },
  resolve_cross_uid: { status: 409, error: "conflict_uid_mismatch" },
  resolve_stale: { status: 409, error: "revision_conflict" },
  resolve_future: { status: 409, error: "future_revision" },
  resolve_consumed: { status: 409, error: "conflict_already_resolved" },
}

export async function startLedgerHttp(opts: LedgerHttpOptions): Promise<LedgerHttpInstance> {
  const token = (opts.token ?? "").trim()
  if (!token) {
    throw new Error("[ledger-http] 拒绝启动：缺 token（:19901 是公网口，不开裸 API）")
  }
  const { store } = opts
  const presence = opts.presence

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      json(res, 500, { ok: false, error: String((err as Error)?.message ?? err) })
    })
  })

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://ledger.local")
    const q = url.searchParams

    // 鉴权先于路由：未授权连"这条路存不存在"都不该知道。
    const auth = req.headers.authorization ?? ""
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim())
    if (!m || !safeEqual(m[1].trim(), token)) {
      json(res, 401, { ok: false, error: "unauthorized" })
      return
    }

    const method = (req.method ?? "GET").toUpperCase()
    const path = url.pathname.replace(/\/+$/, "") || "/"

    if (opts.extension && await opts.extension(req, res, url)) return

    const todoCollection = path === "/api/ledger/cc-todos"
    const todoResolveMatch = /^\/api\/ledger\/cc-todos\/([^/]+)\/resolve$/.exec(path)
    const todoItemMatch = /^\/api\/ledger\/cc-todos\/([^/]+)$/.exec(path)
    if (todoCollection || todoResolveMatch || todoItemMatch) {
      const expectedMethod = todoCollection ? "GET" : todoResolveMatch ? "POST" : "PUT"
      if (method !== expectedMethod) {
        json(res, 405, { ok: false, error: "method_not_allowed" })
        return
      }

      if (todoCollection) {
        if ([...q.keys()].some((key) => key !== "since" && key !== "limit")) {
          json(res, 400, { ok: false, error: "invalid_query" })
          return
        }
        const sinceRaw = q.get("since") ?? "0"
        const limitRaw = q.get("limit") ?? "100"
        if (!/^\d+$/.test(sinceRaw) || !/^\d+$/.test(limitRaw)) {
          json(res, 400, { ok: false, error: "invalid_query" })
          return
        }
        const since = Number(sinceRaw)
        const limit = Number(limitRaw)
        if (!Number.isSafeInteger(since) || since < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
          json(res, 400, { ok: false, error: "invalid_query" })
          return
        }
        const changes = store.listCcTodoChanges({ since, limit })
        const uids = [...new Set(changes.map((change) => change.uid))]
        const items = uids.map((uid) => store.getCcTodoItem(uid))
        const missingUids = uids.filter((_uid, index) => items[index] === null)
        if (missingUids.length > 0) {
          json(res, 409, { ok: false, error: "missing_snapshot", missingUids, nextSince: since })
          return
        }
        json(res, 200, {
          ok: true,
          changes,
          items,
          nextSince: changes.at(-1)?.seq ?? since,
        })
        return
      }

      let uid: string
      try {
        uid = decodeURIComponent((todoResolveMatch ?? todoItemMatch)?.[1] ?? "")
      } catch {
        json(res, 400, { ok: false, error: "invalid_uid" })
        return
      }
      if (!uid || uid.includes("/")) {
        json(res, 400, { ok: false, error: "invalid_uid" })
        return
      }
      const bodyRead = await readLimitedBody(req, CC_TODO_MAX_BODY_BYTES)
      if (bodyRead.tooLarge) {
        json(res, 413, { ok: false, error: "body_too_large" })
        return
      }
      let body: unknown
      try { body = JSON.parse(bodyRead.raw) } catch {
        json(res, 400, { ok: false, error: "invalid_body" })
        return
      }
      if (todoResolveMatch) {
        const input = validateCcTodoBody(body, uid, true)
        if (!input) {
          json(res, 400, { ok: false, error: "invalid_body" })
          return
        }
        const result = store.resolveCcTodoConflict(input)
        const failure = TODO_ERROR[result.outcome]
        if (failure) json(res, failure.status, { ok: false, error: failure.error })
        else json(res, 200, { ok: true, data: result })
        return
      }
      const input = validateCcTodoBody(body, uid, false)
      if (!input) {
        json(res, 400, { ok: false, error: "invalid_body" })
        return
      }
      const result = store.applyCcTodoChange(input)
      const failure = TODO_ERROR[result.outcome]
      if (failure) json(res, failure.status, { ok: false, error: failure.error })
      else json(res, result.outcome === "applied" ? 201 : 200, { ok: true, data: result })
      return
    }

    // 写口：席位登记（registration 表得有人填）
    if (path === "/api/ledger/seats" && method === "PUT") {
      let body: unknown
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        json(res, 400, { ok: false, error: "invalid json body" })
        return
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        json(res, 400, { ok: false, error: "body must be an object" })
        return
      }
      const b = body as Record<string, unknown>
      const seatId = typeof b.seatId === "string" ? b.seatId.trim() : ""
      const device = typeof b.device === "string" ? b.device.trim() : ""
      if (!seatId || !device) {
        json(res, 400, { ok: false, error: "seatId and device are required" })
        return
      }
      store.upsertSeat({
        seatId,
        device,
        agentKind: typeof b.agentKind === "string" ? b.agentKind : null,
        accountFp: typeof b.accountFp === "string" ? b.accountFp : null,
        capabilities: (b.capabilities as unknown[] | undefined) ?? null,
        delivery: typeof b.delivery === "string" ? b.delivery : null,
        active: typeof b.active === "boolean" ? b.active : null,
      })
      json(res, 200, { ok: true, data: store.listSeats().find((s) => s.seatId === seatId) ?? null })
      return
    }

    const READ_ONLY = new Set([
      "/api/ledger/agents", "/api/ledger/quota", "/api/ledger/messages",
      "/api/ledger/tasks", "/api/ledger/events", "/api/ledger/accounts", "/api/ledger/seats",
    ])
    if (READ_ONLY.has(path) && method !== "GET" && method !== "HEAD") {
      json(res, 405, { ok: false, error: `method not allowed: ${method}` })
      return
    }

    switch (path) {
      case "/api/ledger/messages": {
        const limit = num(q.get("limit")) ?? 100
        json(res, 200, {
          ok: true,
          limit,
          data: store.listMessages({
            from: str(q.get("from")), to: str(q.get("to")), type: str(q.get("type")),
            since: str(q.get("since")), limit,
          }),
        })
        return
      }
      case "/api/ledger/tasks": {
        json(res, 200, {
          ok: true,
          data: store.listTasks({
            status: str(q.get("status")), project: str(q.get("project")),
            since: str(q.get("since")), limit: num(q.get("limit")),
            todoUid: str(q.get("todoUid")),
          }),
        })
        return
      }
      case "/api/ledger/quota": {
        const history = truthy(q.get("history"))
        const account = str(q.get("account"))
        const data = history
          ? store.listQuotaHistory({ account, since: str(q.get("since")), limit: num(q.get("limit")) })
          : store.latestQuota(account)
        json(res, 200, { ok: true, history, data })
        return
      }
      case "/api/ledger/events": {
        json(res, 200, {
          ok: true,
          data: store.listEvents({ kind: str(q.get("kind")), since: str(q.get("since")), limit: num(q.get("limit")) }),
        })
        return
      }
      case "/api/ledger/accounts": {
        json(res, 200, { ok: true, data: store.listAccounts() })
        return
      }
      case "/api/ledger/seats": {
        json(res, 200, { ok: true, data: store.listSeats() })
        return
      }
      case "/api/ledger/agents": {
        json(res, 200, { ok: true, data: buildAgentsView(store, presence) })
        return
      }
      default:
        json(res, 404, { ok: false, error: `not found: ${path}` })
    }
  }

  const port = opts.port ?? LEDGER_HTTP_PORT
  const host = opts.host ?? "0.0.0.0"
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, host, () => {
      server.removeListener("error", reject)
      resolve()
    })
  })

  return {
    port: (server.address() as AddressInfo).port,
    close() {
      return new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      })
    },
  }
}

/**
 * `/api/ledger/agents` 合成视图：席位登记（seats）× 实时在线（Hub 内存）× 每账号最新额度。
 * 顺带原样返回 devices——看板要画那些还没登记成席位的机器，否则新机上线在首屏是隐形的。
 */
export function buildAgentsView(store: LedgerStore, presence?: () => DeviceInventory[]) {
  let devices: DeviceInventory[] = []
  try {
    devices = presence ? presence() : []
  } catch {
    devices = []
  }
  const nodesByDevice = new Map<string, string[]>()
  for (const d of devices) {
    const list = nodesByDevice.get(d.deviceId) ?? []
    for (const n of d.nodes ?? []) list.push(n.nodeId)
    nodesByDevice.set(d.deviceId, list)
  }
  const quotaByAccount = new Map<string, QuotaRow>()
  for (const q of store.latestQuota()) quotaByAccount.set(q.accountFp, q)

  const agents = store.listSeats().map((seat) => ({
    ...seat,
    online: nodesByDevice.has(seat.device),
    nodes: nodesByDevice.get(seat.device) ?? [],
    quota: seat.accountFp ? quotaByAccount.get(seat.accountFp) ?? null : null,
  }))
  return { agents, devices, generatedAt: new Date().toISOString() }
}
