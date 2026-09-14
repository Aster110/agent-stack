/** P65 Module A — Hub :19901 cc-todo HTTP 契约（本地随机端口，无真实网络/D1）。 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { LedgerStore } from "./store.js"
import { startLedgerHttp } from "./http.js"

const TOKEN = "unit-test-ledger-token"
const TODO_BODY_MAX = 64 * 1024
const TITLE_PREVIEW_MAX = 160
const ITEM_KEYS = [
  "uid", "legacyId", "category", "status", "project", "dependsOn",
  "createdAt", "updatedAt", "revision", "lastOpId", "originDevice",
  "contentDigest", "recordedAt",
].sort()
const ITEM_KEYS_WITH_PREVIEW = [...ITEM_KEYS, "titlePreview"].sort()

function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    uid: "ctd_http_01",
    legacyId: "f99-2",
    category: "cc",
    status: "pending",
    project: "P65",
    dependsOn: [],
    createdAt: "2026-08-28T21:00:00.000Z",
    updatedAt: "2026-08-28T21:00:01.000Z",
    baseRevision: 0,
    opId: "op-http-001",
    originDevice: "mini",
    contentDigest: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    ...over,
  }
}

async function withServer(fn: (ctx: { base: string; store: LedgerStore }) => Promise<void>): Promise<void> {
  const store = new LedgerStore(":memory:")
  const server = await startLedgerHttp({ store, token: TOKEN, port: 0, host: "127.0.0.1" })
  try {
    await fn({ base: `http://127.0.0.1:${server.port}`, store })
  } finally {
    await server.close()
    store.close()
  }
}

async function request(base: string, method: string, path: string, body?: unknown, token: string | null = TOKEN) {
  const headers: Record<string, string> = {}
  if (token !== null) headers.Authorization = `Bearer ${token}`
  let raw: string | undefined
  if (body !== undefined) {
    headers["content-type"] = "application/json"
    raw = typeof body === "string" ? body : JSON.stringify(body)
  }
  const res = await fetch(base + path, { method, headers, body: raw })
  const responseText = await res.text()
  let responseBody: any = null
  try { responseBody = JSON.parse(responseText) } catch { /* exact raw body is still available */ }
  return { status: res.status, body: responseBody, raw: responseText }
}

function tableBytes(store: LedgerStore, table: string): string {
  return JSON.stringify(store.readAllRows(table).map((x) => x.row))
}

function collection(body: any): { changes: any[]; items: any[]; nextSince: number } {
  assert.deepEqual(Object.keys(body).sort(), ["changes", "items", "nextSince", "ok"].sort())
  assert.equal(body.ok, true)
  assert.ok(Array.isArray(body.changes))
  assert.ok(Array.isArray(body.items))
  assert.ok(Number.isSafeInteger(body.nextSince) && body.nextSince >= 0)
  const changeUids = [...new Set(body.changes.map((x: any) => x.uid))].sort()
  const itemUids = [...new Set(body.items.map((x: any) => x.uid))].sort()
  assert.equal(body.items.length, itemUids.length, "collection items 每个 uid 只能有一份 current snapshot")
  assert.deepEqual(itemUids, changeUids, "Set(changes.uid) 必须精确等于 Set(items.uid)")
  return body
}

/** P142 起 title/note/output（脱敏后）允许出现；条件/路径/凭据字段与敏感 sentinel 仍永不出现。 */
function assertNoPrivateLeak(value: unknown): void {
  const raw = JSON.stringify(value)
  for (const forbidden of [
    '"readyCondition":', '"doneCondition":', '"triggerCondition":', '"localPath":', '"token":',
    "/Users/demo/private", "sk-test-not-real",
  ]) assert.ok(!raw.includes(forbidden), `collection 泄漏 ${forbidden}`)
}

describe("cc-todo HTTP · auth/body/whitelist", () => {
  it("PUT/GET/resolve 三面都先 Bearer 鉴权；错/缺 token 只回 401", async () => {
    await withServer(async ({ base }) => {
      const routes: Array<[string, string, unknown?]> = [
        ["PUT", "/api/ledger/cc-todos/ctd_http_01", payload()],
        ["GET", "/api/ledger/cc-todos?since=0&limit=10"],
        ["POST", "/api/ledger/cc-todos/ctd_http_01/resolve", { ...payload(), resolvesOpId: "op-conflict" }],
      ]
      for (const [method, path, body] of routes) {
        const missing = await request(base, method, path, body, null)
        const wrong = await request(base, method, path, body, "wrong")
        assert.equal(missing.status, 401, `${method} ${path} missing token`)
        assert.equal(wrong.status, 401, `${method} ${path} wrong token`)
        assert.deepEqual(missing.body, { ok: false, error: "unauthorized" })
        assert.deepEqual(wrong.body, { ok: false, error: "unauthorized" })
      }
    })
  })

  it("401 不回显请求私密正文/token；个人 todo 表保持零写入", async () => {
    await withServer(async ({ base, store }) => {
      const sentinel = "sk-test-SENSITIVE_401_SENTINEL /Users/private/401"
      const r = await request(base, "PUT", "/api/ledger/cc-todos/ctd_http_01", {
        ...payload(), shareTitlePreview: true, titlePreview: sentinel,
      }, "wrong-token-SENSITIVE_401_SENTINEL")
      assert.equal(r.status, 401)
      assert.deepEqual(r.body, { ok: false, error: "unauthorized" })
      assert.ok(!r.raw.includes("SENSITIVE_401_SENTINEL"))
      assert.equal(store.readAllRows("cc_todo_items").length, 0)
      assert.equal(store.readAllRows("cc_todo_changes").length, 0)
    })
  })

  it("个人 todo body 64 KiB 边界接受，64 KiB+1 返回 413 且超限请求零落库", async () => {
    await withServer(async ({ base, store }) => {
      const json = JSON.stringify(payload())
      assert.ok(Buffer.byteLength(json) < TODO_BODY_MAX)
      const tooLarge = json + " ".repeat(TODO_BODY_MAX + 1 - Buffer.byteLength(json))
      const rejected = await request(base, "PUT", "/api/ledger/cc-todos/ctd_http_01", tooLarge)
      assert.equal(Buffer.byteLength(tooLarge), TODO_BODY_MAX + 1)
      assert.equal(rejected.status, 413)
      assert.deepEqual(rejected.body, { ok: false, error: "body_too_large" })
      assert.equal(store.readAllRows("cc_todo_items").length, 0)
      assert.equal(store.readAllRows("cc_todo_changes").length, 0)

      const exact = json + " ".repeat(TODO_BODY_MAX - Buffer.byteLength(json))
      assert.equal(Buffer.byteLength(exact), TODO_BODY_MAX)
      const accepted = await request(base, "PUT", "/api/ledger/cc-todos/ctd_http_01", exact)
      assert.equal(accepted.status, 201)
      assert.equal(store.readAllRows("cc_todo_items").length, 1)
      assert.equal(store.readAllRows("cc_todo_changes").length, 1)
    })
  })

  it("拒绝未知字段和本地条件/路径/凭据字段，整次请求零落库（正文字段见 P142 用例）", async () => {
    await withServer(async ({ base, store }) => {
      for (const forbidden of [
        { token: "sk-test-not-real" },
        { readyCondition: "private ready" }, { doneCondition: "private done" },
        { triggerCondition: "private trigger" }, { localPath: "/Users/demo/private/input" },
        { ready_condition: "private ready" }, { done_condition: "private done" },
        { trigger_condition: "private trigger" }, { local_path: "/Users/demo/private/input" },
        { arbitraryLegacyField: "must stay local" },
      ]) {
        const r = await request(base, "PUT", "/api/ledger/cc-todos/ctd_http_01", { ...payload(), ...forbidden })
        assert.equal(r.status, 400, `应拒绝 ${Object.keys(forbidden)[0]}`)
      }
      assert.equal(store.readAllRows("cc_todo_items").length, 0)
      assert.equal(store.readAllRows("cc_todo_changes").length, 0)
    })
  })

  it("schema/version/uid/CAS 字段严格校验，path uid 与 body uid 必须一致", async () => {
    await withServer(async ({ base, store }) => {
      const badBodies = [
        payload({ schemaVersion: 2 }),
        payload({ category: "dispatch" }),
        payload({ dependsOn: "f1-1" }),
        payload({ baseRevision: -1 }),
        payload({ updatedAt: "not-a-date" }),
        payload({ contentDigest: "raw-private-content" }),
      ]
      for (const bad of badBodies) {
        assert.equal((await request(base, "PUT", "/api/ledger/cc-todos/ctd_http_01", bad)).status, 400)
      }
      assert.equal((await request(base, "PUT", "/api/ledger/cc-todos/other_uid", payload())).status, 400)
      assert.equal(store.readAllRows("cc_todo_items").length, 0)
    })
  })

  it("titlePreview 仅显式 opt-in；safe preview/160边界保留，161拒绝", async () => {
    await withServer(async ({ base, store }) => {
      const noOpt = await request(base, "PUT", "/api/ledger/cc-todos/ctd_http_01", {
        ...payload(), titlePreview: "safe preview",
      })
      assert.equal(noOpt.status, 400)

      const safe = await request(base, "PUT", "/api/ledger/cc-todos/ctd_http_01", {
        ...payload({ opId: "op-http-safe" }), shareTitlePreview: true, titlePreview: "safe preview",
      })
      assert.equal(safe.status, 201)
      assert.equal(safe.body.data.item.titlePreview, "safe preview")
      assert.ok(tableBytes(store, "cc_todo_items").includes("safe preview"))

      const boundary = "p".repeat(TITLE_PREVIEW_MAX)
      const atLimit = await request(base, "PUT", "/api/ledger/cc-todos/ctd_http_02", {
        ...payload({ uid: "ctd_http_02", legacyId: "f99-3", opId: "op-http-preview-160" }),
        shareTitlePreview: true, titlePreview: boundary,
      })
      assert.equal(atLimit.status, 201)
      assert.equal(atLimit.body.data.item.titlePreview, boundary)

      const overLimit = await request(base, "PUT", "/api/ledger/cc-todos/ctd_http_03", {
        ...payload({ uid: "ctd_http_03", legacyId: "f99-4", opId: "op-http-preview-161" }),
        shareTitlePreview: true, titlePreview: "p".repeat(TITLE_PREVIEW_MAX + 1),
      })
      assert.equal(overLimit.status, 400)
      assert.equal((store as any).getCcTodoItem("ctd_http_03"), null)
    })
  })

  it("敏感 sentinel 真进入请求后被省略，items/changes/HTTP response 全阴性", async () => {
    await withServer(async ({ base, store }) => {
      const sentinel = "SENSITIVE_PREVIEW_SENTINEL_sk-test-abcdef /Users/demo/private"
      const sensitive = await request(base, "PUT", "/api/ledger/cc-todos/ctd_http_01", {
        ...payload({ opId: "op-http-sensitive" }),
        shareTitlePreview: true,
        titlePreview: sentinel,
      })
      assert.equal(sensitive.status, 201)
      assert.ok(!sensitive.body.data.item.titlePreview, "敏感 preview 必须省略")
      for (const haystack of [
        sensitive.raw,
        tableBytes(store, "cc_todo_items"),
        tableBytes(store, "cc_todo_changes"),
      ]) {
        assert.ok(!haystack.includes("SENSITIVE_PREVIEW_SENTINEL"))
        assert.ok(!haystack.includes("/Users/demo/private"))
      }
    })
  })

  it("恶意/残缺 percent-encoded uid 在 PUT/resolve 都返回 400，不冒泡 500", async () => {
    await withServer(async ({ base }) => {
      for (const [method, path, body] of [
        ["PUT", "/api/ledger/cc-todos/%E0%A4%A", payload()],
        ["POST", "/api/ledger/cc-todos/%ZZ/resolve", { ...payload(), resolvesOpId: "op-conflict" }],
      ] as const) {
        const r = await request(base, method, path, body)
        assert.equal(r.status, 400, `${method} ${path}`)
        assert.deepEqual(r.body, { ok: false, error: "invalid_uid" })
      }
    })
  })
})

describe("cc-todo HTTP · CAS outcomes/incremental/resolve", () => {
  it("apply 201；duplicate/converged 200；tamper/conflict/future 409，均有审计", async () => {
    await withServer(async ({ base }) => {
      const url = "/api/ledger/cc-todos/ctd_http_01"
      const first = payload()
      let r = await request(base, "PUT", url, first)
      assert.equal(r.status, 201)
      assert.equal(r.body.data.outcome, "applied")
      assert.equal(r.body.data.item.revision, 1)

      r = await request(base, "PUT", url, { ...first })
      assert.equal(r.status, 200)
      assert.equal(r.body.data.outcome, "duplicate")

      r = await request(base, "PUT", url, payload({ opId: "op-converged", originDevice: "air", updatedAt: "2026-08-28T21:00:02.000Z" }))
      assert.equal(r.status, 200)
      assert.equal(r.body.data.outcome, "converged")

      r = await request(base, "PUT", url, payload({ status: "doing" }))
      assert.equal(r.status, 409)
      assert.equal(r.body.error, "op_id_tamper")

      r = await request(base, "PUT", url, payload({ opId: "op-conflict", status: "doing", contentDigest: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" }))
      assert.equal(r.status, 409)
      assert.equal(r.body.error, "revision_conflict")

      r = await request(base, "PUT", url, payload({ opId: "op-future", baseRevision: 9, status: "doing" }))
      assert.equal(r.status, 409)
      assert.equal(r.body.error, "future_revision")

      const changes = await request(base, "GET", "/api/ledger/cc-todos?since=0&limit=20")
      assert.equal(changes.status, 200)
      const page = collection(changes.body)
      assert.deepEqual(page.changes.map((x: any) => x.outcome), [
        "applied", "duplicate", "converged", "tamper", "conflict", "future",
      ])
      assert.deepEqual(page.changes.map((x: any) => x.revision), [1, 1, 1, 1, 1, 1])
      assert.ok(page.changes.every((x: any) => Object.keys(x).sort().join(",") === [
        "baseRevision", "bodyHash", "changedAt", "contentDigest", "detail", "opId",
        "originDevice", "outcome", "recordedAt", "revision", "seq", "uid",
      ].sort().join(",")), "GET audit 行字段集合必须精确")
      assert.equal(page.items.length, 1, "同 uid 多 change 只附一份 current item")
      assert.equal(page.items[0].status, "pending", "conflict/future 不得覆盖 current item")
      assertNoPrivateLeak(page)
    })
  })

  it("同规范 body 不同 key order 为 duplicate；同 opId 跨 uid 为 tamper", async () => {
    await withServer(async ({ base, store }) => {
      const original = payload()
      assert.equal((await request(base, "PUT", "/api/ledger/cc-todos/ctd_http_01", original)).status, 201)
      const reordered = Object.fromEntries(Object.entries(original).reverse())
      const duplicate = await request(base, "PUT", "/api/ledger/cc-todos/ctd_http_01", reordered)
      assert.equal(duplicate.status, 200)
      assert.equal(duplicate.body.data.outcome, "duplicate")
      const before = tableBytes(store, "cc_todo_items")
      const crossUid = await request(base, "PUT", "/api/ledger/cc-todos/ctd_http_other", {
        ...original, uid: "ctd_http_other",
      })
      assert.equal(crossUid.status, 409)
      assert.deepEqual(crossUid.body, { ok: false, error: "op_id_tamper" })
      assert.equal(tableBytes(store, "cc_todo_items"), before)
    })
  })

  it("GET since/limit 返回固定 {changes,items,nextSince}，逐页附 current item，绝不混 dispatch tasks", async () => {
    await withServer(async ({ base, store }) => {
      store.upsertTask({
        taskId: "dispatch-only", title: "dispatch fixture", project: "P62", fromNode: "a", toNode: "b",
        pickReason: "explicit", status: "dispatched", createdAt: "2026-08-28T20:00:00.000Z",
      })
      await request(base, "PUT", "/api/ledger/cc-todos/ctd_http_01", payload())
      await request(base, "PUT", "/api/ledger/cc-todos/ctd_http_02", payload({
        uid: "ctd_http_02", legacyId: "f99-3", opId: "op-http-002",
      }))

      const page1 = await request(base, "GET", "/api/ledger/cc-todos?since=0&limit=1")
      assert.equal(page1.status, 200)
      const first = collection(page1.body)
      assert.equal(first.changes.length, 1)
      assert.equal(first.items.length, 1)
      assert.equal(first.items[0].uid, first.changes[0].uid)
      const page2 = await request(base, "GET", `/api/ledger/cc-todos?since=${first.nextSince}&limit=1`)
      const second = collection(page2.body)
      assert.equal(second.changes.length, 1)
      assert.equal(second.items.length, 1)
      assert.notEqual(second.changes[0].uid, first.changes[0].uid)
      assert.equal(second.items[0].uid, second.changes[0].uid)
      assert.equal(store.listTasks({}).length, 1)
      assert.equal(store.getTask("dispatch-only")?.status, "dispatched")
    })
  })

  it("collection item 字段精确；安全 opt-in preview 可恢复，敏感 preview 必须缺失", async () => {
    await withServer(async ({ base }) => {
      const safePreview = "safe shared preview"
      const sensitivePreview = "SENSITIVE_COLLECTION_PREVIEW_sk-test-abcdef /Users/demo/private"
      assert.equal((await request(base, "PUT", "/api/ledger/cc-todos/ctd_preview_safe", {
        ...payload({ uid: "ctd_preview_safe", legacyId: "f99-preview-safe", opId: "op-preview-safe" }),
        shareTitlePreview: true,
        titlePreview: safePreview,
      })).status, 201)
      assert.equal((await request(base, "PUT", "/api/ledger/cc-todos/ctd_preview_sensitive", {
        ...payload({ uid: "ctd_preview_sensitive", legacyId: "f99-preview-sensitive", opId: "op-preview-sensitive" }),
        shareTitlePreview: true,
        titlePreview: sensitivePreview,
      })).status, 201)

      const response = await request(base, "GET", "/api/ledger/cc-todos?since=0&limit=20")
      assert.equal(response.status, 200)
      const page = collection(response.body)
      const safe = page.items.find((item: any) => item.uid === "ctd_preview_safe")
      const sensitive = page.items.find((item: any) => item.uid === "ctd_preview_sensitive")
      assert.ok(safe)
      assert.ok(sensitive)
      assert.deepEqual(Object.keys(safe).sort(), ITEM_KEYS_WITH_PREVIEW)
      assert.equal(safe.titlePreview, safePreview, "显式共享的安全 preview 必须可由 collection 恢复")
      assert.deepEqual(Object.keys(sensitive).sort(), ITEM_KEYS)
      assert.ok(!("titlePreview" in sensitive), "敏感 preview 必须以字段缺失表示，不能回 null/空串")
      assert.ok(!response.raw.includes(sensitivePreview))
      assertNoPrivateLeak(page)
    })
  })

  it("since=0 bootstrap：页内 uid 去重，done/deleted 保留 snapshot，conflict 附未覆盖 current item", async () => {
    await withServer(async ({ base }) => {
      const conflictUrl = "/api/ledger/cc-todos/ctd_boot_conflict"
      await request(base, "PUT", conflictUrl, payload({ uid: "ctd_boot_conflict", legacyId: "f99-10", opId: "op-boot-1" }))
      await request(base, "PUT", conflictUrl, payload({
        uid: "ctd_boot_conflict", legacyId: "f99-10", opId: "op-boot-conflict",
        status: "doing", contentDigest: "sha256:abababababababababababababababababababababababababababababababab",
      }))
      await request(base, "PUT", "/api/ledger/cc-todos/ctd_boot_done", payload({
        uid: "ctd_boot_done", legacyId: "f99-11", opId: "op-boot-done", status: "done",
      }))
      await request(base, "PUT", "/api/ledger/cc-todos/ctd_boot_deleted", payload({
        uid: "ctd_boot_deleted", legacyId: "f99-12", opId: "op-boot-deleted", status: "deleted",
      }))

      const r = await request(base, "GET", "/api/ledger/cc-todos?since=0&limit=20")
      assert.equal(r.status, 200)
      const page = collection(r.body)
      assert.equal(page.changes.length, 4)
      assert.equal(page.items.length, 3)
      assert.equal(new Set(page.items.map((x: any) => x.uid)).size, 3, "items 必须按 uid 去重")
      const conflictItem = page.items.find((x: any) => x.uid === "ctd_boot_conflict")
      assert.equal(conflictItem.status, "pending", "conflict 请求不得冒充 current snapshot")
      assert.equal(page.items.find((x: any) => x.uid === "ctd_boot_done")?.status, "done")
      assert.equal(page.items.find((x: any) => x.uid === "ctd_boot_deleted")?.status, "deleted")
      assert.equal(page.nextSince, page.changes.at(-1).seq)
      assertNoPrivateLeak(page)
    })
  })

  it("seq1 完整、seq2 missing；GET since=1 → 409 且 nextSince 精确保持 1", async () => {
    await withServer(async ({ base, store }) => {
      await request(base, "PUT", "/api/ledger/cc-todos/ctd_complete", payload({
        uid: "ctd_complete", legacyId: "f99-12", opId: "op-complete-1",
      }))
      await request(base, "PUT", "/api/ledger/cc-todos/ctd_missing", payload({
        uid: "ctd_missing", legacyId: "f99-13", opId: "op-missing-1",
      }))
      ;(store as any).db.prepare("DELETE FROM cc_todo_items WHERE uid = ?").run("ctd_missing")
      const before = store.listCcTodoChanges({ since: 0 }).length
      assert.deepEqual(store.listCcTodoChanges({ since: 0 }).map((x: any) => x.seq), [1, 2])
      const r = await request(base, "GET", "/api/ledger/cc-todos?since=1&limit=20")
      assert.equal(r.status, 409)
      assert.deepEqual(r.body, {
        ok: false, error: "missing_snapshot", missingUids: ["ctd_missing"], nextSince: 1,
      })
      assert.equal(store.listCcTodoChanges({ since: 0 }).length, before, "读失败不得改 audit")
    })
  })

  it("GET 非零 since 空页保持请求 cursor，响应 shape 精确且无旧 data/hasMore", async () => {
    await withServer(async ({ base }) => {
      const r = await request(base, "GET", "/api/ledger/cc-todos?since=37&limit=20")
      assert.equal(r.status, 200)
      assert.deepEqual(r.body, { ok: true, changes: [], items: [], nextSince: 37 })
    })
  })

  it("GET 参数严格：since为非负整数、limit为1..200；未知参数拒绝；写错方法405零审计", async () => {
    await withServer(async ({ base, store }) => {
      for (const path of [
        "/api/ledger/cc-todos?since=-1", "/api/ledger/cc-todos?since=1.5",
        "/api/ledger/cc-todos?since=nope", "/api/ledger/cc-todos?limit=0",
        "/api/ledger/cc-todos?limit=201", "/api/ledger/cc-todos?limit=nope",
        "/api/ledger/cc-todos?unknown=1",
      ]) {
        const r = await request(base, "GET", path)
        assert.equal(r.status, 400, path)
        assert.deepEqual(r.body, { ok: false, error: "invalid_query" })
      }
      assert.equal((await request(base, "GET", "/api/ledger/cc-todos?since=0&limit=200")).status, 200)
      for (const [method, path] of [
        ["PUT", "/api/ledger/cc-todos"],
        ["POST", "/api/ledger/cc-todos/ctd_http_01"],
        ["DELETE", "/api/ledger/cc-todos/ctd_http_01"],
        ["PUT", "/api/ledger/cc-todos/ctd_http_01/resolve"],
      ]) {
        const r = await request(base, method, path, payload())
        assert.equal(r.status, 405, `${method} ${path}`)
        assert.deepEqual(r.body, { ok: false, error: "method_not_allowed" })
      }
      assert.equal(store.readAllRows("cc_todo_changes").length, 0)
    })
  })

  it("resolve 只接受已审计 conflict + 当前 baseRevision，生成 revision=2 resolved audit", async () => {
    await withServer(async ({ base }) => {
      const url = "/api/ledger/cc-todos/ctd_http_01"
      await request(base, "PUT", url, payload())
      await request(base, "PUT", url, payload({
        opId: "op-http-conflict", status: "doing",
        contentDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      }))
      const resolved = await request(base, "POST", `${url}/resolve`, {
        ...payload({
          baseRevision: 1, opId: "op-http-resolve", status: "doing",
          contentDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        }),
        resolvesOpId: "op-http-conflict",
      })
      assert.equal(resolved.status, 200)
      assert.equal(resolved.body.data.outcome, "resolved")
      assert.equal(resolved.body.data.item.revision, 2)

      const changes = await request(base, "GET", "/api/ledger/cc-todos?since=0&limit=20")
      const page = collection(changes.body)
      assert.equal(page.changes.at(-1).outcome, "resolved")
      assert.equal(page.changes.at(-1).detail.resolvesOpId, "op-http-conflict")
    })
  })

  it("baseline 后 owner conflict + foreign resolve_cross_uid：change/item uid 集合必须精确同构", async () => {
    await withServer(async ({ base, store }) => {
      const ownerUrl = "/api/ledger/cc-todos/ctd_cross_owner"
      const foreignUrl = "/api/ledger/cc-todos/ctd_cross_foreign"
      assert.equal((await request(base, "PUT", ownerUrl, payload({
        uid: "ctd_cross_owner", legacyId: "f99-cross-owner", opId: "op-cross-owner-create",
      }))).status, 201)
      assert.equal((await request(base, "PUT", foreignUrl, payload({
        uid: "ctd_cross_foreign", legacyId: "f99-cross-foreign", opId: "op-cross-foreign-create",
      }))).status, 201)
      const baseline = store.listCcTodoChanges({ since: 0 }).at(-1)?.seq
      assert.equal(baseline, 2, "baseline 必须位于两份合法 snapshot 的 create audit 之后")

      const conflict = await request(base, "PUT", ownerUrl, payload({
        uid: "ctd_cross_owner", legacyId: "f99-cross-owner",
        opId: "op-cross-owner-conflict", status: "doing",
        contentDigest: "sha256:9191919191919191919191919191919191919191919191919191919191919191",
      }))
      assert.equal(conflict.status, 409)
      assert.equal(conflict.body.error, "revision_conflict")
      const cross = await request(base, "POST", `${foreignUrl}/resolve`, {
        ...payload({
          uid: "ctd_cross_foreign", legacyId: "f99-cross-foreign", baseRevision: 1,
          opId: "op-cross-foreign-reject",
        }),
        resolvesOpId: "op-cross-owner-conflict",
      })
      assert.equal(cross.status, 409)
      assert.equal(cross.body.error, "conflict_uid_mismatch")

      const response = await request(base, "GET", `/api/ledger/cc-todos?since=${baseline}&limit=20`)
      assert.equal(response.status, 200)
      const page = collection(response.body)
      assert.deepEqual(page.changes.map((x: any) => x.outcome), ["conflict", "resolve_cross_uid"])
      assert.deepEqual([...new Set(page.changes.map((x: any) => x.uid))].sort(), [
        "ctd_cross_foreign", "ctd_cross_owner",
      ])
      assert.deepEqual(page.items.map((x: any) => x.uid).sort(), [
        "ctd_cross_foreign", "ctd_cross_owner",
      ])
      assert.equal(page.nextSince, 4)
      assertNoPrivateLeak(page)
    })
  })

  it("resolve unknown/non-conflict/cross-uid/stale/future 精确报错，snapshot/revision不变且逐条审计", async () => {
    await withServer(async ({ base, store }) => {
      const url = "/api/ledger/cc-todos/ctd_http_01"
      await request(base, "PUT", url, payload())
      await request(base, "PUT", url, payload({
        opId: "op-http-r-conflict", status: "doing",
        contentDigest: "sha256:5656565656565656565656565656565656565656565656565656565656565656",
      }))
      const foreign = await request(base, "PUT", "/api/ledger/cc-todos/ctd_other", payload({
        uid: "ctd_other", legacyId: "f99-other", opId: "op-http-other",
      }))
      assert.equal(foreign.status, 201, "cross-uid 拒绝前 foreign uid 必须已有合法 snapshot")
      const before = tableBytes(store, "cc_todo_items")
      const cases = [
        { path: `${url}/resolve`, body: { ...payload({ baseRevision: 1, opId: "op-r-unknown" }), resolvesOpId: "op-missing" }, status: 404, error: "conflict_not_found" },
        { path: `${url}/resolve`, body: { ...payload({ baseRevision: 1, opId: "op-r-non-conflict" }), resolvesOpId: "op-http-001" }, status: 409, error: "not_a_conflict" },
        { path: "/api/ledger/cc-todos/ctd_other/resolve", body: { ...payload({ uid: "ctd_other", legacyId: "f99-other", baseRevision: 1, opId: "op-r-cross" }), resolvesOpId: "op-http-r-conflict" }, status: 409, error: "conflict_uid_mismatch" },
        { path: `${url}/resolve`, body: { ...payload({ baseRevision: 0, opId: "op-r-stale" }), resolvesOpId: "op-http-r-conflict" }, status: 409, error: "revision_conflict" },
        { path: `${url}/resolve`, body: { ...payload({ baseRevision: 2, opId: "op-r-future" }), resolvesOpId: "op-http-r-conflict" }, status: 409, error: "future_revision" },
      ]
      for (const c of cases) {
        const r = await request(base, "POST", c.path, c.body)
        assert.equal(r.status, c.status)
        assert.deepEqual(r.body, { ok: false, error: c.error })
        assert.equal(tableBytes(store, "cc_todo_items"), before)
        assert.equal((store as any).getCcTodoItem("ctd_http_01")?.revision, 1)
      }
      const audit = await request(base, "GET", "/api/ledger/cc-todos?since=0&limit=20")
      const page = collection(audit.body)
      assert.deepEqual(page.changes.map((x: any) => x.outcome), [
        "applied", "conflict", "applied", "resolve_unknown", "resolve_not_conflict",
        "resolve_cross_uid", "resolve_stale", "resolve_future",
      ])
      assert.deepEqual([...new Set(page.changes.map((x: any) => x.uid))].sort(), ["ctd_http_01", "ctd_other"])
      assert.deepEqual(page.items.map((x: any) => x.uid).sort(), ["ctd_http_01", "ctd_other"])
      assert.ok(page.changes.slice(3).every((x: any) => x.revision === 1))
    })
  })

  it("resolve duplicate成功幂等；同op tamper、同conflict二次消费精确拒绝且不增revision", async () => {
    await withServer(async ({ base, store }) => {
      const url = "/api/ledger/cc-todos/ctd_http_01"
      await request(base, "PUT", url, payload())
      await request(base, "PUT", url, payload({
        opId: "op-http-consume-conflict", status: "doing",
        contentDigest: "sha256:7878787878787878787878787878787878787878787878787878787878787878",
      }))
      const resolvedBody = {
        ...payload({
          baseRevision: 1, opId: "op-http-consume-resolve", status: "doing",
          contentDigest: "sha256:7878787878787878787878787878787878787878787878787878787878787878",
        }),
        resolvesOpId: "op-http-consume-conflict",
      }
      assert.equal((await request(base, "POST", `${url}/resolve`, resolvedBody)).body.data.outcome, "resolved")
      const afterResolve = tableBytes(store, "cc_todo_items")

      const duplicate = await request(base, "POST", `${url}/resolve`, { ...resolvedBody })
      assert.equal(duplicate.status, 200)
      assert.equal(duplicate.body.data.outcome, "duplicate")
      const tamper = await request(base, "POST", `${url}/resolve`, { ...resolvedBody, status: "done" })
      assert.equal(tamper.status, 409)
      assert.deepEqual(tamper.body, { ok: false, error: "op_id_tamper" })
      const consumed = await request(base, "POST", `${url}/resolve`, { ...resolvedBody, opId: "op-http-consume-second" })
      assert.equal(consumed.status, 409)
      assert.deepEqual(consumed.body, { ok: false, error: "conflict_already_resolved" })

      assert.equal(tableBytes(store, "cc_todo_items"), afterResolve)
      assert.equal((store as any).getCcTodoItem("ctd_http_01")?.revision, 2)
      const audit = await request(base, "GET", "/api/ledger/cc-todos?since=0&limit=20")
      const page = collection(audit.body)
      assert.deepEqual(page.changes.map((x: any) => x.outcome), [
        "applied", "conflict", "resolved", "duplicate", "tamper", "resolve_consumed",
      ])
      assert.deepEqual(page.changes.map((x: any) => x.revision), [1, 1, 2, 2, 2, 2])
    })
  })
})

describe("cc-todo HTTP · P142 正文上云 / 私密豁免 / 脱敏省略 / 归属", () => {
  const content = {
    title: "写 P142 契约文档", note: "先 hub 后 CLI", output: "docs/契约.md", type: "审批",
    assignedTo: "server:brain", taskId: "server:brain-1757550000-ab12",
  }

  it("PUT 含正文 → 201 且 item/GET items 镜像全部字段（camelCase），热层落列", async () => {
    await withServer(async ({ base, store }) => {
      const r = await request(base, "PUT", "/api/ledger/cc-todos/ctd_http_01", { ...payload(), ...content })
      assert.equal(r.status, 201, r.raw)
      for (const [key, value] of Object.entries(content)) assert.equal(r.body.data.item[key], value, key)
      assert.ok(!("contentPrivate" in r.body.data.item), "非私密不回 contentPrivate:false")
      const page = collection((await request(base, "GET", "/api/ledger/cc-todos?since=0&limit=20")).body)
      assert.deepEqual(Object.keys(page.items[0]).sort(), [...ITEM_KEYS, ...Object.keys(content)].sort())
      for (const [key, value] of Object.entries(content)) assert.equal(page.items[0][key], value, key)
      const row = store.readAllRows("cc_todo_items")[0].row
      assert.equal(row.title, content.title)
      assert.equal(row.assigned_to, content.assignedTo)
      assert.equal(row.task_id, content.taskId)
      assert.equal(row.content_private, 0)
      assertNoPrivateLeak(page)
    })
  })

  it("contentPrivate=true → 零正文 + item.contentPrivate=true；自称私密却带正文 → 400 零落库", async () => {
    await withServer(async ({ base, store }) => {
      const ok = await request(base, "PUT", "/api/ledger/cc-todos/ctd_http_01", { ...payload(), contentPrivate: true })
      assert.equal(ok.status, 201)
      assert.equal(ok.body.data.item.contentPrivate, true)
      const page = collection((await request(base, "GET", "/api/ledger/cc-todos?since=0&limit=20")).body)
      assert.deepEqual(Object.keys(page.items[0]).sort(), [...ITEM_KEYS, "contentPrivate"].sort())
      const before = tableBytes(store, "cc_todo_items")
      const bad = await request(base, "PUT", "/api/ledger/cc-todos/ctd_http_02", {
        ...payload({ uid: "ctd_http_02", legacyId: "f99-3", opId: "op-priv-bad" }), contentPrivate: true, title: "泄漏",
      })
      assert.equal(bad.status, 400)
      assert.deepEqual(bad.body, { ok: false, error: "invalid_body" })
      assert.equal(tableBytes(store, "cc_todo_items"), before)
      assert.equal(store.readAllRows("cc_todo_changes").length, 1)
      // contentPrivate=false 是合法布尔，等价于未声明
      const explicitFalse = await request(base, "PUT", "/api/ledger/cc-todos/ctd_http_03", {
        ...payload({ uid: "ctd_http_03", legacyId: "f99-4", opId: "op-priv-false" }), contentPrivate: false, title: "公开",
      })
      assert.equal(explicitFalse.status, 201)
      assert.equal(explicitFalse.body.data.item.title, "公开")
      assert.ok(!("contentPrivate" in explicitFalse.body.data.item))
    })
  })

  it("服务端二道脱敏：命中凭据/绝对路径/私钥的正文字段整字段省略，其余字段照收，全面阴性", async () => {
    await withServer(async ({ base, store }) => {
      const r = await request(base, "PUT", "/api/ledger/cc-todos/ctd_http_01", {
        ...payload(),
        title: "SENTINEL_TITLE sk-test-abcdef",
        note: "SENTINEL_NOTE /Users/demo/private/x",
        output: "-----BEGIN RSA PRIVATE KEY----- SENTINEL_OUTPUT",
        type: "提醒",
        assignedTo: "server:brain",
      })
      assert.equal(r.status, 201)
      const item = r.body.data.item
      assert.ok(!("title" in item) && !("note" in item) && !("output" in item), "敏感正文必须以字段缺失表示")
      assert.equal(item.type, "提醒")
      assert.equal(item.assignedTo, "server:brain")
      for (const haystack of [r.raw, tableBytes(store, "cc_todo_items"), tableBytes(store, "cc_todo_changes")]) {
        for (const sentinel of ["SENTINEL_TITLE", "SENTINEL_NOTE", "SENTINEL_OUTPUT", "/Users/demo/private"]) {
          assert.ok(!haystack.includes(sentinel), `泄漏 ${sentinel}`)
        }
      }
    })
  })

  it("长度/类型边界：title 500 / note·output 4000 / type 64 / assignedTo·taskId 200；超限或非字符串 400；空串视同未上传", async () => {
    await withServer(async ({ base, store }) => {
      const cases: Array<[Record<string, unknown>, number]> = [
        [{ title: "标".repeat(500) }, 201], [{ title: "标".repeat(501) }, 400],
        [{ note: "n".repeat(4000) }, 201], [{ note: "n".repeat(4001) }, 400],
        [{ output: "o".repeat(4001) }, 400],
        [{ type: "t".repeat(64) }, 201], [{ type: "t".repeat(65) }, 400],
        [{ assignedTo: "a".repeat(201) }, 400], [{ taskId: "k".repeat(201) }, 400],
        [{ type: 12 }, 400], [{ title: null }, 400], [{ contentPrivate: "yes" }, 400],
      ]
      let n = 0
      for (const [over, status] of cases) {
        n++
        const uid = `ctd_limit_${n}`
        const r = await request(base, "PUT", `/api/ledger/cc-todos/${uid}`, {
          ...payload({ uid, legacyId: `f99-${n}`, opId: `op-limit-${n}` }), ...over,
        })
        assert.equal(r.status, status, `${JSON.stringify(Object.keys(over))}: ${r.raw.slice(0, 80)}`)
        if (status === 400) assert.equal((store as any).getCcTodoItem(uid), null)
      }
      const empty = await request(base, "PUT", "/api/ledger/cc-todos/ctd_empty", {
        ...payload({ uid: "ctd_empty", legacyId: "f99-e", opId: "op-empty" }), title: "有", note: "",
      })
      assert.equal(empty.status, 201)
      assert.equal(empty.body.data.item.title, "有")
      assert.ok(!("note" in empty.body.data.item), "空串正文视同未上传")
    })
  })
})
