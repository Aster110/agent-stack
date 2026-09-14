/**
 * P65 Module A — cc-todo 个人任务域热层契约（先测后写）。
 *
 * 注意：这里的 cc_todo_* 与 mesh dispatch `tasks` 是两个领域。测试故意同时
 * 放一条 dispatch task，确保个人 todo 的 apply/resolve 不会污染调度账本。
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import Database from "better-sqlite3"
import { LedgerStore } from "./store.js"

const ITEMS_COLUMNS = [
  "uid", "legacy_id", "category", "status", "project", "depends_on",
  "created_at", "updated_at", "revision", "last_op_id", "origin_device",
  "content_digest", "title_preview", "recorded_at",
  // P142 T1：脱敏后的正文 + 归属（老库由 addColumnIfMissing 补列）
  "title", "note", "output", "type", "assigned_to", "task_id", "content_private",
].sort()

/** P142 之前的 DDL（老库长什么样）——迁移测试用它造"旧库"，别从 store.ts 现行 DDL 抄。 */
const LEGACY_ITEMS_DDL = `
  CREATE TABLE IF NOT EXISTS cc_todo_items (
    uid TEXT PRIMARY KEY,
    legacy_id TEXT NOT NULL,
    category TEXT NOT NULL,
    status TEXT NOT NULL,
    project TEXT,
    depends_on TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revision INTEGER NOT NULL,
    last_op_id TEXT NOT NULL,
    origin_device TEXT NOT NULL,
    content_digest TEXT NOT NULL,
    title_preview TEXT,
    recorded_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT PRIMARY KEY,
    title TEXT,
    project TEXT,
    from_node TEXT,
    to_node TEXT,
    seat_id TEXT,
    account_fp TEXT,
    pick_reason TEXT,
    status TEXT NOT NULL,
    created_at TEXT,
    replied_at TEXT,
    reply_msg_id TEXT,
    created_at_utc TEXT
  );
`

const CHANGES_COLUMNS = [
  "seq", "uid", "op_id", "base_revision", "revision", "outcome",
  "body_hash", "content_digest", "origin_device", "changed_at", "detail",
  "recorded_at",
].sort()

interface TodoChange {
  schemaVersion: 1
  uid: string
  legacyId: string
  category: "cc" | "aster"
  status: string
  project: string | null
  dependsOn: string[]
  createdAt: string
  updatedAt: string
  baseRevision: number
  opId: string
  originDevice: string
  contentDigest: string
  shareTitlePreview?: boolean
  titlePreview?: string
  title?: string
  note?: string
  output?: string
  type?: string
  assignedTo?: string
  taskId?: string
  contentPrivate?: boolean
}

interface ApplyResult {
  outcome:
    | "applied" | "duplicate" | "tamper" | "converged" | "conflict" | "future" | "resolved"
    | "resolve_unknown" | "resolve_not_conflict" | "resolve_cross_uid"
    | "resolve_stale" | "resolve_future" | "resolve_consumed"
  item: null | Record<string, any>
  change: Record<string, any>
}

interface TodoStoreContract {
  applyCcTodoChange(input: TodoChange): ApplyResult
  getCcTodoItem(uid: string): Record<string, any> | null
  listCcTodoChanges(filter: { since?: number; limit?: number; uid?: string }): Array<Record<string, any>>
  resolveCcTodoConflict(input: TodoChange & { resolvesOpId: string }): ApplyResult
}

function domain(store: LedgerStore): TodoStoreContract {
  const candidate = store as unknown as Partial<TodoStoreContract>
  assert.equal(typeof candidate.applyCcTodoChange, "function", "LedgerStore 缺 applyCcTodoChange")
  assert.equal(typeof candidate.getCcTodoItem, "function", "LedgerStore 缺 getCcTodoItem")
  assert.equal(typeof candidate.listCcTodoChanges, "function", "LedgerStore 缺 listCcTodoChanges")
  assert.equal(typeof candidate.resolveCcTodoConflict, "function", "LedgerStore 缺 resolveCcTodoConflict")
  return candidate as TodoStoreContract
}

function change(over: Partial<TodoChange> = {}): TodoChange {
  return {
    schemaVersion: 1,
    uid: "ctd_test_01",
    legacyId: "f99-1",
    category: "cc",
    status: "pending",
    project: "P65",
    dependsOn: [],
    createdAt: "2026-08-28T20:00:00.000Z",
    updatedAt: "2026-08-28T20:00:01.000Z",
    baseRevision: 0,
    opId: "op-mini-001",
    originDevice: "mini",
    contentDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ...over,
  }
}

function tableBytes(store: LedgerStore, table: string): string {
  return JSON.stringify(store.readAllRows(table).map((x) => x.row))
}

describe("cc-todo LedgerStore · migration/schema", () => {
  it("只新增 cc_todo_items snapshot 与 cc_todo_changes audit stream", () => {
    const store = new LedgerStore(":memory:")
    const names = store.tableNames()
    assert.ok(names.includes("cc_todo_items"), "缺 cc_todo_items")
    assert.ok(names.includes("cc_todo_changes"), "缺 cc_todo_changes")
    assert.ok(names.includes("tasks"), "dispatch tasks 旧表不能被替换")
    assert.deepEqual(store.columnNames("cc_todo_items").sort(), ITEMS_COLUMNS)
    assert.deepEqual(store.columnNames("cc_todo_changes").sort(), CHANGES_COLUMNS)
    // P142 起 title/note/output 正文（脱敏后）允许上云；条件/路径/凭据字段仍然永不进表
    for (const forbidden of [
      "ready_condition", "done_condition", "trigger_condition",
      "readyCondition", "doneCondition", "triggerCondition", "local_path", "localPath", "token",
    ]) {
      assert.ok(!store.columnNames("cc_todo_items").includes(forbidden), `snapshot 不得含私密列 ${forbidden}`)
      assert.ok(!store.columnNames("cc_todo_changes").includes(forbidden), `audit 不得含私密列 ${forbidden}`)
    }
    store.close()
  })

  it("临时文件库 close/reopen 两次迁移幂等，两领域 snapshot/revision/audit 均不丢", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-todo-ledger-migrate-"))
    const dbPath = path.join(dir, "ledger.db")
    try {
      let store = new LedgerStore(dbPath)
      store.upsertTask({
        taskId: "dispatch-persist", title: "dispatch fixture", project: "P62",
        fromNode: "a", toNode: "b", pickReason: "explicit", status: "dispatched",
        createdAt: "2026-08-28T19:59:00.000Z",
      })
      const d = domain(store)
      d.applyCcTodoChange(change())
      d.applyCcTodoChange(change({
        opId: "op-persist-conflict", status: "doing",
        contentDigest: "sha256:abababababababababababababababababababababababababababababababab",
      }))
      d.resolveCcTodoConflict({
        ...change({
          baseRevision: 1, opId: "op-persist-resolve", status: "doing",
          contentDigest: "sha256:abababababababababababababababababababababababababababababababab",
        }),
        resolvesOpId: "op-persist-conflict",
      })
      const dispatchBefore = store.getTask("dispatch-persist")
      store.close()

      for (let reopen = 0; reopen < 2; reopen++) {
        store = new LedgerStore(dbPath)
        assert.deepEqual(store.columnNames("cc_todo_items").sort(), ITEMS_COLUMNS)
        assert.deepEqual(store.columnNames("cc_todo_changes").sort(), CHANGES_COLUMNS)
        assert.deepEqual(store.getTask("dispatch-persist"), dispatchBefore)
        assert.equal(domain(store).getCcTodoItem("ctd_test_01")?.revision, 2)
        assert.equal(domain(store).getCcTodoItem("ctd_test_01")?.status, "doing")
        assert.deepEqual(
          domain(store).listCcTodoChanges({ since: 0 }).map((x) => x.outcome),
          ["applied", "conflict", "resolved"],
        )
        store.close()
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("cc-todo LedgerStore · CAS/idempotency/audit", () => {
  it("baseRevision=0 首次 apply → revision=1；snapshot metadata-only；audit=applied", () => {
    const store = new LedgerStore(":memory:")
    const d = domain(store)
    const r = d.applyCcTodoChange(change())
    assert.equal(r.outcome, "applied")
    assert.equal(r.item?.revision, 1)
    assert.equal(r.item?.uid, "ctd_test_01")
    assert.equal(r.change.outcome, "applied")
    assert.equal(d.listCcTodoChanges({ since: 0 }).length, 1)

    const raw = JSON.stringify(store.readAllRows("cc_todo_items").map((x) => x.row))
    for (const sentinel of ["PRIVATE_FULL_TITLE", "/Users/test/private", "sk-test-not-real"]) {
      assert.ok(!raw.includes(sentinel), `热层 snapshot 泄漏 ${sentinel}`)
    }
    store.close()
  })

  it("同 opId + 同规范 body → duplicate success，不增 revision，但追加 duplicate 审计", () => {
    const store = new LedgerStore(":memory:")
    const d = domain(store)
    const input = change()
    assert.equal(d.applyCcTodoChange(input).outcome, "applied")
    const dup = d.applyCcTodoChange({ ...input })
    assert.equal(dup.outcome, "duplicate")
    assert.equal(d.getCcTodoItem(input.uid)?.revision, 1)
    assert.deepEqual(d.listCcTodoChanges({ since: 0 }).map((x) => x.outcome), ["applied", "duplicate"])
    store.close()
  })

  it("同 opId + 不同规范 body → tamper；snapshot 不变；追加 tamper 审计", () => {
    const store = new LedgerStore(":memory:")
    const d = domain(store)
    const input = change()
    d.applyCcTodoChange(input)
    const bad = d.applyCcTodoChange({ ...input, status: "done", contentDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" })
    assert.equal(bad.outcome, "tamper")
    assert.equal(d.getCcTodoItem(input.uid)?.status, "pending")
    assert.equal(d.getCcTodoItem(input.uid)?.revision, 1)
    assert.equal(d.listCcTodoChanges({ since: 0 }).at(-1)?.outcome, "tamper")
    store.close()
  })

  it("规范化 hash 不受 JSON key 插入顺序影响；uid 必须进入 hash", () => {
    const store = new LedgerStore(":memory:")
    const d = domain(store)
    const input = change()
    assert.equal(d.applyCcTodoChange(input).outcome, "applied")

    const reordered = {
      contentDigest: input.contentDigest,
      originDevice: input.originDevice,
      opId: input.opId,
      baseRevision: input.baseRevision,
      updatedAt: input.updatedAt,
      createdAt: input.createdAt,
      dependsOn: [...input.dependsOn],
      project: input.project,
      status: input.status,
      category: input.category,
      legacyId: input.legacyId,
      uid: input.uid,
      schemaVersion: input.schemaVersion,
    } satisfies TodoChange
    assert.equal(d.applyCcTodoChange(reordered).outcome, "duplicate")
    const firstTwo = d.listCcTodoChanges({ since: 0 }).slice(0, 2)
    assert.equal(firstTwo[0].bodyHash, firstTwo[1].bodyHash, "同规范 body 的 hash 必须一致")

    const before = tableBytes(store, "cc_todo_items")
    const crossUid = d.applyCcTodoChange({ ...input, uid: "ctd_test_other" })
    assert.equal(crossUid.outcome, "tamper", "同 opId 跨 uid 不是 duplicate")
    assert.equal(d.getCcTodoItem("ctd_test_other"), null)
    assert.equal(tableBytes(store, "cc_todo_items"), before)
    assert.notEqual(d.listCcTodoChanges({ since: 0 }).at(-1)?.bodyHash, firstTwo[0].bodyHash)
    store.close()
  })

  it("落后 baseRevision 但 snapshot 已相同 → converged；不制造 revision", () => {
    const store = new LedgerStore(":memory:")
    const d = domain(store)
    const first = change()
    d.applyCcTodoChange(first)
    const converged = d.applyCcTodoChange({ ...first, opId: "op-air-002", originDevice: "air", updatedAt: "2026-08-28T20:00:02.000Z" })
    assert.equal(converged.outcome, "converged")
    assert.equal(d.getCcTodoItem(first.uid)?.revision, 1)
    assert.equal(d.listCcTodoChanges({ since: 0 }).at(-1)?.outcome, "converged")
    store.close()
  })

  it("落后 baseRevision + 不同 snapshot → conflict；updatedAt 更新也不得 LWW", () => {
    const store = new LedgerStore(":memory:")
    const d = domain(store)
    const first = change()
    d.applyCcTodoChange(first)
    const conflict = d.applyCcTodoChange({
      ...first,
      opId: "op-air-003",
      originDevice: "air",
      status: "done",
      updatedAt: "2099-01-01T00:00:00.000Z",
      contentDigest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    })
    assert.equal(conflict.outcome, "conflict")
    assert.equal(d.getCcTodoItem(first.uid)?.status, "pending", "禁止按 updatedAt 静默覆盖")
    assert.equal(d.listCcTodoChanges({ since: 0 }).at(-1)?.outcome, "conflict")
    store.close()
  })

  it("baseRevision 超前 → future；snapshot 不变；追加 future 审计", () => {
    const store = new LedgerStore(":memory:")
    const d = domain(store)
    d.applyCcTodoChange(change())
    const future = d.applyCcTodoChange(change({ baseRevision: 9, opId: "op-mini-future", status: "doing" }))
    assert.equal(future.outcome, "future")
    assert.equal(d.getCcTodoItem("ctd_test_01")?.revision, 1)
    assert.equal(d.listCcTodoChanges({ since: 0 }).at(-1)?.outcome, "future")
    store.close()
  })

  it("resolve 必须显式引用 conflict op，成功生成新 revision 与 resolved 审计", () => {
    const store = new LedgerStore(":memory:")
    const d = domain(store)
    d.applyCcTodoChange(change())
    d.applyCcTodoChange(change({ opId: "op-air-conflict", status: "doing", contentDigest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" }))

    const resolved = d.resolveCcTodoConflict({
      ...change({ baseRevision: 1, opId: "op-mini-resolve", status: "doing", contentDigest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" }),
      resolvesOpId: "op-air-conflict",
    })
    assert.equal(resolved.outcome, "resolved")
    assert.equal(resolved.item?.revision, 2)
    assert.equal(resolved.item?.status, "doing")
    assert.equal(resolved.change.outcome, "resolved")
    assert.equal(resolved.change.detail?.resolvesOpId, "op-air-conflict")
    store.close()
  })

  it("resolve unknown/non-conflict/cross-uid/stale/future 均拒绝且 snapshot/revision 不变、审计精确", () => {
    const store = new LedgerStore(":memory:")
    const d = domain(store)
    d.applyCcTodoChange(change())
    d.applyCcTodoChange(change({
      opId: "op-resolve-conflict", status: "doing",
      contentDigest: "sha256:1212121212121212121212121212121212121212121212121212121212121212",
    }))
    d.applyCcTodoChange(change({
      uid: "ctd_other", legacyId: "f99-other", opId: "op-other-snapshot",
    }))
    const before = tableBytes(store, "cc_todo_items")

    const cases: Array<{ expected: ApplyResult["outcome"]; input: TodoChange & { resolvesOpId: string } }> = [
      {
        expected: "resolve_unknown",
        input: { ...change({ baseRevision: 1, opId: "op-resolve-unknown" }), resolvesOpId: "op-missing" },
      },
      {
        expected: "resolve_not_conflict",
        input: { ...change({ baseRevision: 1, opId: "op-resolve-applied" }), resolvesOpId: "op-mini-001" },
      },
      {
        expected: "resolve_cross_uid",
        input: {
          ...change({ uid: "ctd_other", legacyId: "f99-other", baseRevision: 1, opId: "op-resolve-cross" }),
          resolvesOpId: "op-resolve-conflict",
        },
      },
      {
        expected: "resolve_stale",
        input: { ...change({ baseRevision: 0, opId: "op-resolve-stale" }), resolvesOpId: "op-resolve-conflict" },
      },
      {
        expected: "resolve_future",
        input: { ...change({ baseRevision: 2, opId: "op-resolve-future" }), resolvesOpId: "op-resolve-conflict" },
      },
    ]
    for (const c of cases) {
      const r = d.resolveCcTodoConflict(c.input)
      assert.equal(r.outcome, c.expected)
      assert.equal(r.change.outcome, c.expected)
      assert.equal(r.change.detail?.resolvesOpId, c.input.resolvesOpId)
      assert.equal(tableBytes(store, "cc_todo_items"), before, `${c.expected} 不得改 snapshot`)
      assert.equal(d.getCcTodoItem("ctd_test_01")?.revision, 1)
    }
    assert.deepEqual(d.listCcTodoChanges({ since: 0 }).map((x) => x.outcome), [
      "applied", "conflict", "applied", "resolve_unknown", "resolve_not_conflict",
      "resolve_cross_uid", "resolve_stale", "resolve_future",
    ])
    store.close()
  })

  it("resolve exact duplicate 幂等；同 op tamper 与 conflict 二次消费拒绝，revision 固定", () => {
    const store = new LedgerStore(":memory:")
    const d = domain(store)
    d.applyCcTodoChange(change())
    d.applyCcTodoChange(change({
      opId: "op-consume-conflict", status: "doing",
      contentDigest: "sha256:3434343434343434343434343434343434343434343434343434343434343434",
    }))
    const resolve = {
      ...change({
        baseRevision: 1, opId: "op-consume-resolve", status: "doing",
        contentDigest: "sha256:3434343434343434343434343434343434343434343434343434343434343434",
      }),
      resolvesOpId: "op-consume-conflict",
    }
    assert.equal(d.resolveCcTodoConflict(resolve).outcome, "resolved")
    const resolvedBytes = tableBytes(store, "cc_todo_items")
    assert.equal(d.getCcTodoItem(resolve.uid)?.revision, 2)

    assert.equal(d.resolveCcTodoConflict({ ...resolve }).outcome, "duplicate")
    assert.equal(tableBytes(store, "cc_todo_items"), resolvedBytes)
    assert.equal(d.resolveCcTodoConflict({ ...resolve, status: "done" }).outcome, "tamper")
    assert.equal(tableBytes(store, "cc_todo_items"), resolvedBytes)
    assert.equal(d.resolveCcTodoConflict({ ...resolve, opId: "op-consume-second" }).outcome, "resolve_consumed")
    assert.equal(tableBytes(store, "cc_todo_items"), resolvedBytes)
    assert.equal(d.getCcTodoItem(resolve.uid)?.revision, 2)

    assert.deepEqual(d.listCcTodoChanges({ since: 0 }).map((x) => x.outcome), [
      "applied", "conflict", "resolved", "duplicate", "tamper", "resolve_consumed",
    ])
    store.close()
  })

  it("个人 todo apply/resolve 对 dispatch tasks 行数与内容零污染", () => {
    const store = new LedgerStore(":memory:")
    store.upsertTask({
      taskId: "dispatch-keep", title: "dispatch fixture", project: "P62", fromNode: "a", toNode: "b",
      pickReason: "explicit", status: "dispatched", createdAt: "2026-08-28T20:00:00.000Z",
    })
    const before = store.getTask("dispatch-keep")
    const d = domain(store)
    d.applyCcTodoChange(change())
    assert.deepEqual(store.getTask("dispatch-keep"), before)
    assert.equal(store.listTasks({}).length, 1)
    store.close()
  })
})

describe("cc-todo LedgerStore · P142 正文上云 / 归属 / 老库迁移", () => {
  it("P142 之前的老库打开即补列：旧 item/task 行一字不丢，新列读回为缺失/false/null", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-todo-ledger-p142-"))
    const dbPath = path.join(dir, "ledger.db")
    try {
      const legacy = new Database(dbPath)
      legacy.exec(LEGACY_ITEMS_DDL)
      legacy.prepare(`INSERT INTO cc_todo_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        "ctd_legacy", "f1-1", "cc", "doing", "P65", "[]", "2026-08-01T00:00:00.000Z",
        "2026-08-02T00:00:00.000Z", 3, "op-legacy", "mini", "sha256:" + "1".repeat(64), "legacy preview",
        "2026-08-02T00:00:01.000Z",
      )
      legacy.prepare(`INSERT INTO tasks (task_id, title, status, created_at, created_at_utc) VALUES (?, ?, ?, ?, ?)`)
        .run("task-legacy", "老派单", "replied", "2026-08-01T10:00:00+08:00", "2026-08-01T02:00:00.000Z")
      legacy.close()

      for (let reopen = 0; reopen < 2; reopen++) {
        const store = new LedgerStore(dbPath)
        assert.deepEqual(store.columnNames("cc_todo_items").sort(), ITEMS_COLUMNS)
        assert.ok(store.columnNames("tasks").includes("todo_uid"))
        const item = domain(store).getCcTodoItem("ctd_legacy")!
        assert.equal(item.revision, 3)
        assert.equal(item.status, "doing")
        assert.equal(item.titlePreview, "legacy preview")
        for (const key of ["title", "note", "output", "type", "assignedTo", "taskId", "contentPrivate"]) {
          assert.ok(!(key in item), `老行的 ${key} 必须缺失，不能回 null`)
        }
        const raw = store.readAllRows("cc_todo_items")[0].row
        assert.equal(raw.content_private, 0)
        assert.equal(raw.title, null)
        const task = store.getTask("task-legacy")!
        assert.equal(task.status, "replied")
        assert.equal(task.title, "老派单")
        assert.equal(task.todoUid, null)
        store.close()
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("正文/归属字段落 snapshot 并原样读回；contentPrivate 只在为真时出现", () => {
    const store = new LedgerStore(":memory:")
    const d = domain(store)
    const full = d.applyCcTodoChange(change({
      title: "写契约文档", note: "备注", output: "docs/契约.md", type: "审批",
      assignedTo: "server:brain", taskId: "server:brain-msg-001",
    }))
    assert.equal(full.outcome, "applied")
    assert.equal(full.item?.title, "写契约文档")
    assert.equal(full.item?.note, "备注")
    assert.equal(full.item?.output, "docs/契约.md")
    assert.equal(full.item?.type, "审批")
    assert.equal(full.item?.assignedTo, "server:brain")
    assert.equal(full.item?.taskId, "server:brain-msg-001")
    assert.ok(!("contentPrivate" in full.item!), "非私密条目不回 contentPrivate:false")
    const row = store.readAllRows("cc_todo_items")[0].row
    assert.equal(row.title, "写契约文档")
    assert.equal(row.assigned_to, "server:brain")
    assert.equal(row.task_id, "server:brain-msg-001")
    assert.equal(row.content_private, 0)

    const priv = d.applyCcTodoChange(change({ uid: "ctd_private", legacyId: "f99-9", opId: "op-priv", contentPrivate: true }))
    assert.equal(priv.outcome, "applied")
    assert.equal(priv.item?.contentPrivate, true)
    for (const key of ["title", "note", "output", "type", "assignedTo", "taskId"]) {
      assert.ok(!(key in priv.item!), `私密条目不得有 ${key}`)
    }
    assert.equal(store.readAllRows("cc_todo_items").find((x) => x.row.uid === "ctd_private")!.row.content_private, 1)

    // 后续快照不带正文 = 正文被清（snapshot 语义：每次 PUT 都是当前全量可共享字段）
    const cleared = d.applyCcTodoChange(change({ baseRevision: 1, opId: "op-clear", status: "doing" }))
    assert.equal(cleared.outcome, "applied")
    assert.ok(!("title" in cleared.item!))
    store.close()
  })

  it("stale baseRevision：正文相同才算 converged，正文不同是真 conflict", () => {
    const store = new LedgerStore(":memory:")
    const d = domain(store)
    assert.equal(d.applyCcTodoChange(change({ title: "A" })).outcome, "applied")
    const same = d.applyCcTodoChange(change({ title: "A", opId: "op-same", originDevice: "air", updatedAt: "2026-08-28T20:00:09.000Z" }))
    assert.equal(same.outcome, "converged")
    const differ = d.applyCcTodoChange(change({ title: "B", opId: "op-differ", originDevice: "air" }))
    assert.equal(differ.outcome, "conflict")
    assert.equal(d.getCcTodoItem("ctd_test_01")?.title, "A", "conflict 不得覆盖 current snapshot")
    store.close()
  })

  it("tasks.todo_uid 落库 + listTasks({todoUid}) 过滤", () => {
    const store = new LedgerStore(":memory:")
    store.upsertTask({
      taskId: "t-with", title: "带归属", fromNode: "a", toNode: "b", pickReason: "explicit",
      status: "dispatched", createdAt: "2026-09-11T10:00:00+08:00", todoUid: "11111111-1111-4111-8111-111111111111",
    })
    store.upsertTask({
      taskId: "t-without", title: "无归属", fromNode: "a", toNode: "b", pickReason: "explicit",
      status: "dispatched", createdAt: "2026-09-11T10:01:00+08:00",
    })
    assert.equal(store.getTask("t-with")?.todoUid, "11111111-1111-4111-8111-111111111111")
    assert.equal(store.getTask("t-without")?.todoUid, null)
    assert.deepEqual(store.listTasks({ todoUid: "11111111-1111-4111-8111-111111111111" }).map((t) => t.taskId), ["t-with"])
    assert.equal(store.listTasks({}).length, 2)
    store.close()
  })
})

export { ITEMS_COLUMNS, CHANGES_COLUMNS }
