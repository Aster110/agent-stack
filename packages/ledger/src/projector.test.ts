/**
 * 投影器单测 — 消息流 → tasks / quota_snapshots / accounts 视图。
 * 设计 §6.3；M0 验收 ①②。
 *
 * 覆盖：task 开 / result 关 / result 先到 task 后到（乱序补偿）/
 *       同批重复 id 只一行 + ack 单调 / quota fixture 解析 + 坏 payload 不崩 / 未知 type 只进 messages。
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { LedgerStore } from "./store.js"
import { Projector, parseQuotaEnvelope } from "./projector.js"
import { CLAUDE_ENVELOPE, CODEX_ENVELOPE, UNAVAILABLE_ENVELOPE, mkMsg, mkEvent, mkQuotaMsg } from "./testdata.js"
import type { MeshMessage } from "@cc-mesh/protocol"

function fresh(): { store: LedgerStore; proj: Projector } {
  const store = new LedgerStore(":memory:")
  return { store, proj: new Projector(store) }
}

function taskMsg(id: string, over: Partial<MeshMessage> = {}): MeshMessage {
  return mkMsg({
    id, from: "macbook:cc-main", to: "mini:cc-w1", type: "task",
    payload: "去把 P62 的账本写了",
    createdAt: "2026-08-27T10:00:00+08:00",
    ...over,
  })
}

describe("Projector · task 开单", () => {
  it("observation/legacy timeout are nonterminal; late results and explicit failures retain original task", () => {
    const { store, proj } = fresh()
    const send = (id: string, payload: string, type: "system" | "result" = "system", task = "long") => proj.ingest([mkEvent(mkMsg({ id, type, payload, from: "mini:cc-w1", to: "macbook:cc-main", replyTo: task, createdAt: `2026-09-20T00:00:${String(Number(id.replace(/\D/g, ""))).padStart(2, "0")}Z` }))], "r")
    send("r01", "[failed] nonce=n node=mini:cc-w1 reason=timeout detail=turn exceeded 1800000ms")
    proj.ingest([mkEvent(taskMsg("long"))], "r")
    assert.equal(store.getTask("long")!.status, "awaiting_confirmation")
    assert.equal(store.getTask("long")!.repliedAt, null)
    store.projectTaskState("long", "failed", "r01", "old")
    new Projector(store)
    assert.equal(store.getTask("long")!.status, "awaiting_confirmation", "startup normalizes legacy stored timeout failures")
    send("r02", "[observation] nonce=n node=mini:cc-w1 thread=t turn=u state=running")
    assert.equal(store.getTask("long")!.status, "running")
    send("r03", "[observation] nonce=n node=mini:cc-w1 thread=t turn=u state=awaiting_confirmation")
    assert.equal(store.getTask("long")!.status, "awaiting_confirmation")
    send("r04", "late result", "result")
    send("r05", "[observation] nonce=n node=mini:cc-w1 thread=t turn=u state=awaiting_confirmation")
    send("r05", "[observation] nonce=n node=mini:cc-w1 thread=t turn=u state=awaiting_confirmation")
    assert.equal(store.getTask("long")!.status, "replied")
    assert.equal(store.getTask("long")!.replyMsgId, "r04")
    store.projectTaskState("long", "replied", "already-pruned-receipt", "2026-09-19T00:00:00Z")
    proj.ingest([mkEvent(taskMsg("pruned"))], "r")
    store.projectTaskState("pruned", "replied", "already-pruned-receipt", "2026-09-19T00:00:00Z")
    send("r07", "[observation] nonce=n node=mini:cc-w1 thread=t turn=u state=awaiting_confirmation", "system", "pruned")
    assert.equal(store.getTask("pruned")!.status, "replied")
    proj.ingest([mkEvent(taskMsg("explicit"))], "r")
    send("r06", "[failed] nonce=n node=mini:cc-w1 reason=interrupted detail=executor cancelled", "system", "explicit")
    assert.equal(store.getTask("explicit")!.status, "failed")
    store.close()
  })
  it("type=task → tasks 行 status=dispatched，元数据从 meta._task 取", () => {
    const { store, proj } = fresh()
    const msg = taskMsg("t1", {
      meta: { _task: { title: "写云端账本", project: "P62", pickReason: "explicit", seatId: "mini/w1", accountFp: "chatgpt-1" } },
    })
    const r = proj.ingest([mkEvent(msg, { srcSeq: 5 })], "relay-A")
    assert.equal(r.maxSrcSeq, 5)

    const t = store.getTask("t1")!
    assert.equal(t.status, "dispatched")
    assert.equal(t.title, "写云端账本")
    assert.equal(t.project, "P62")
    assert.equal(t.pickReason, "explicit")
    assert.equal(t.seatId, "mini/w1")
    assert.equal(t.accountFp, "chatgpt-1")
    assert.equal(t.fromNode, "macbook:cc-main")
    assert.equal(t.toNode, "mini:cc-w1")
    assert.equal(t.createdAt, "2026-08-27T10:00:00+08:00")
    store.close()
  })

  it("缺 meta：title=payload 前 80 字符、pick_reason=unknown", () => {
    const { store, proj } = fresh()
    const long = "x".repeat(200)
    proj.ingest([mkEvent(taskMsg("t1", { payload: long }))], "relay-A")
    const t = store.getTask("t1")!
    assert.equal(t.title, "x".repeat(80))
    assert.equal(t.title!.length, 80)
    assert.equal(t.pickReason, "unknown")
    assert.equal(t.project, null)
    store.close()
  })

  it("P142：meta._task.todoUid → tasks.todo_uid；缺省 null（老派单不受影响）", () => {
    const { store, proj } = fresh()
    proj.ingest([
      mkEvent(taskMsg("t-todo", { meta: { _task: { title: "联结", pickReason: "explicit", todoUid: "11111111-1111-4111-8111-111111111111" } } })),
      mkEvent(taskMsg("t-plain", { meta: { _task: { title: "无联结", pickReason: "explicit" } } })),
      mkEvent(taskMsg("t-snake", { meta: { _task: { title: "蛇形也认", todo_uid: "22222222-2222-4222-8222-222222222222" } } })),
    ], "relay-A")
    assert.equal(store.getTask("t-todo")!.todoUid, "11111111-1111-4111-8111-111111111111")
    assert.equal(store.getTask("t-plain")!.todoUid, null)
    assert.equal(store.getTask("t-snake")!.todoUid, "22222222-2222-4222-8222-222222222222")
    assert.deepEqual(store.listTasks({ todoUid: "11111111-1111-4111-8111-111111111111" }).map((t) => t.taskId), ["t-todo"])
    store.close()
  })

  it("task 消息本身也进 ledger_messages", () => {
    const { store, proj } = fresh()
    proj.ingest([mkEvent(taskMsg("t1"))], "relay-A")
    assert.equal(store.getMessage("t1")!.type, "task")
    store.close()
  })
})

describe("Projector · result 关单", () => {
  it("result 带 replyTo 命中 task → replied + replied_at + reply_msg_id", () => {
    const { store, proj } = fresh()
    proj.ingest([mkEvent(taskMsg("t1"))], "relay-A")
    const res = mkMsg({
      id: "r1", from: "mini:cc-w1", to: "macbook:cc-main", type: "result",
      payload: "干完了", replyTo: "t1", createdAt: "2026-08-27T10:30:00+08:00",
    })
    proj.ingest([mkEvent(res)], "relay-B")

    const t = store.getTask("t1")!
    assert.equal(t.status, "replied")
    assert.equal(t.repliedAt, "2026-08-27T10:30:00+08:00")
    assert.equal(t.replyMsgId, "r1")
    store.close()
  })

  it("result 无 replyTo → 只进 messages，不建 task", () => {
    const { store, proj } = fresh()
    const res = mkMsg({ id: "r1", type: "result", payload: "野生回执" })
    proj.ingest([mkEvent(res)], "relay-B")
    assert.equal(store.listTasks({}).length, 0)
    assert.ok(store.getMessage("r1"))
    store.close()
  })

  it("result 的 replyTo 没命中任何 task → 不崩、不建行（等 task 到）", () => {
    const { store, proj } = fresh()
    const res = mkMsg({ id: "r1", type: "result", replyTo: "nope", payload: "x" })
    proj.ingest([mkEvent(res)], "relay-B")
    assert.equal(store.listTasks({}).length, 0)
    store.close()
  })
})

describe("Projector · 乱序补偿（result 先到、task 后到）", () => {
  it("跨 relay 乱序：先收 result 再收 task，task 落地时立刻标 replied", () => {
    const { store, proj } = fresh()
    const res = mkMsg({
      id: "r1", from: "mini:cc-w1", to: "macbook:cc-main", type: "result",
      payload: "干完了", replyTo: "t1", createdAt: "2026-08-27T10:30:00+08:00",
    })
    proj.ingest([mkEvent(res)], "relay-B")
    assert.equal(store.listTasks({}).length, 0)          // 还没 task

    proj.ingest([mkEvent(taskMsg("t1"))], "relay-A")     // task 姗姗来迟
    const t = store.getTask("t1")!
    assert.equal(t.status, "replied")
    assert.equal(t.replyMsgId, "r1")
    assert.equal(t.repliedAt, "2026-08-27T10:30:00+08:00")
    store.close()
  })

  it("乱序补偿只认 type=result（chat 带同 replyTo 不算关单）", () => {
    const { store, proj } = fresh()
    proj.ingest([mkEvent(mkMsg({ id: "c1", type: "chat", replyTo: "t1", payload: "在吗" }))], "relay-B")
    proj.ingest([mkEvent(taskMsg("t1"))], "relay-A")
    assert.equal(store.getTask("t1")!.status, "dispatched")
    store.close()
  })

  it("同批内乱序（result 在前 task 在后）也能关上", () => {
    const { store, proj } = fresh()
    const res = mkMsg({ id: "r1", type: "result", replyTo: "t1", payload: "ok", createdAt: "2026-08-27T10:30:00+08:00" })
    proj.ingest([mkEvent(res, { srcSeq: 1 }), mkEvent(taskMsg("t1"), { srcSeq: 2 })], "relay-A")
    assert.equal(store.getTask("t1")!.status, "replied")
    store.close()
  })
})

describe("Projector · 幂等与游标", () => {
  it("同批重复 id 只留一行，tasks 也只一行", () => {
    const { store, proj } = fresh()
    const msg = taskMsg("t1")
    const r = proj.ingest([mkEvent(msg, { srcSeq: 1 }), mkEvent(msg, { srcSeq: 2 })], "relay-A")
    assert.equal(store.listMessages({}).length, 1)
    assert.equal(store.listTasks({}).length, 1)
    assert.equal(r.maxSrcSeq, 2)
    store.close()
  })

  it("跨机两端上报同一 id（发端+收端两个 relay）云端只一行", () => {
    const { store, proj } = fresh()
    const msg = mkMsg({ id: "m1", payload: "跨机消息" })
    proj.ingest([mkEvent(msg, { srcSeq: 11 })], "relay-A")   // 发端上报
    proj.ingest([mkEvent(msg, { srcSeq: 3 })], "relay-B")    // 收端上报同一条
    const rows = store.listMessages({})
    assert.equal(rows.length, 1)
    assert.equal(rows[0].srcRelay, "relay-A")
    store.close()
  })

  it("重放已关单的 task 事件不会把 status 打回 dispatched", () => {
    const { store, proj } = fresh()
    const msg = taskMsg("t1")
    proj.ingest([mkEvent(msg)], "relay-A")
    proj.ingest([mkEvent(mkMsg({ id: "r1", type: "result", replyTo: "t1", payload: "ok", createdAt: "2026-08-27T10:30:00+08:00" }))], "relay-A")
    assert.equal(store.getTask("t1")!.status, "replied")
    proj.ingest([mkEvent(msg, { srcSeq: 99 })], "relay-A")   // 重放
    assert.equal(store.getTask("t1")!.status, "replied")
    store.close()
  })

  it("maxSrcSeq 取批内最大值；空批返回 0", () => {
    const { store, proj } = fresh()
    assert.equal(proj.ingest([], "relay-A").maxSrcSeq, 0)
    const r = proj.ingest([
      mkEvent(mkMsg({ id: "a" }), { srcSeq: 4 }),
      mkEvent(mkMsg({ id: "b" }), { srcSeq: 9 }),
      mkEvent(mkMsg({ id: "c" }), { srcSeq: 6 }),
    ], "relay-A")
    assert.equal(r.maxSrcSeq, 9)
    store.close()
  })

  it("status / priority 落库", () => {
    const { store, proj } = fresh()
    proj.ingest([mkEvent(mkMsg({ id: "m1" }), { status: "queued", priority: "urgent" })], "relay-A")
    const row = store.getMessage("m1")!
    assert.equal(row.status, "queued")
    assert.equal(row.priority, "urgent")
    store.close()
  })
})

describe("Projector · quota_report 投影", () => {
  it("claude 真实 envelope → quota_snapshots 拍平 + accounts upsert", () => {
    const { store, proj } = fresh()
    proj.ingest([mkEvent(mkQuotaMsg("q1", CLAUDE_ENVELOPE))], "relay-A")

    const [q] = store.latestQuota()
    assert.equal(q.accountFp, "claude-abc123def456")
    assert.equal(q.source, "claude")
    assert.equal(q.host, "computer1")
    assert.equal(q.status, "ok")
    assert.equal(q.probedAt, "2026-08-27T10:15:00+08:00")
    assert.equal(q.pct5h, 23)
    assert.equal(q.pct7d, 61)          // 7d_scoped(88) 不混进 7d 总量桶
    assert.equal(q.resets5h, "2026-08-26T08:00:00-07:00")
    assert.equal(q.resets7d, "2026-08-31T17:00:00-07:00")
    assert.deepEqual(JSON.parse(q.envelope).extra, CLAUDE_ENVELOPE.extra)   // 原文全存

    const [acc] = store.listAccounts()
    assert.equal(acc.accountFp, "claude-abc123def456")
    assert.equal(acc.vendor, "claude")
    store.close()
  })

  it("codex 真实 envelope → plan 落 accounts、多桶取最满的那个", () => {
    const { store, proj } = fresh()
    proj.ingest([mkEvent(mkQuotaMsg("q1", CODEX_ENVELOPE))], "relay-A")
    const [q] = store.latestQuota()
    assert.equal(q.accountFp, "chatgpt-9f8e7d6c5b4a")
    assert.equal(q.plan, "pro")
    assert.equal(q.pct5h, 42)
    assert.equal(q.pct7d, 14)
    assert.equal(store.listAccounts()[0].plan, "pro")
    store.close()
  })

  it("status=unavailable（limits 空）→ 照记，pct 为 null", () => {
    const { store, proj } = fresh()
    proj.ingest([mkEvent(mkQuotaMsg("q1", UNAVAILABLE_ENVELOPE))], "relay-A")
    const [q] = store.latestQuota()
    assert.equal(q.status, "unavailable")
    assert.equal(q.pct5h, null)
    assert.equal(q.pct7d, null)
    assert.equal(store.listEvents({ kind: "quota_parse_error" }).length, 0)
    store.close()
  })

  it("坏 payload 不崩：消息照记 + events 记 quota_parse_error", () => {
    const { store, proj } = fresh()
    const bad = ["{不是 JSON", "null", "[]", JSON.stringify({ source: "codex" })]  // 最后一个缺 account_id
    bad.forEach((p, i) => proj.ingest([mkEvent(mkQuotaMsg(`q${i}`, p))], "relay-A"))

    assert.equal(store.listMessages({ type: "quota_report" }).length, bad.length)  // 一条不丢
    assert.equal(store.latestQuota().length, 0)
    const errs = store.listEvents({ kind: "quota_parse_error" })
    assert.equal(errs.length, bad.length)
    assert.ok(String((errs[0].detail as Record<string, unknown>).error).length > 0)
    store.close()
  })

  it("quota_report 但 to≠@ledger → 只进 messages，不投影（哨兵语义）", () => {
    const { store, proj } = fresh()
    const msg = mkQuotaMsg("q1", CODEX_ENVELOPE)
    proj.ingest([mkEvent({ ...msg, to: "macbook:cc-main" })], "relay-A")
    assert.equal(store.latestQuota().length, 0)
    assert.ok(store.getMessage("q1"))
    store.close()
  })

  it("同一账号两次上报 → 两条快照，latest 取最新 probed_at", () => {
    const { store, proj } = fresh()
    proj.ingest([mkEvent(mkQuotaMsg("q1", CODEX_ENVELOPE))], "relay-A")
    proj.ingest([mkEvent(mkQuotaMsg("q2", { ...CODEX_ENVELOPE, probed_at: "2026-08-27T11:20:00+08:00", limits: [{ kind: "5h", used_percent: 77, resets_at: null }] }))], "relay-A")
    assert.equal(store.listQuotaHistory({ account: "chatgpt-9f8e7d6c5b4a" }).length, 2)
    assert.equal(store.latestQuota()[0].pct5h, 77)
    store.close()
  })
})

describe("Projector · 未知 type", () => {
  it("未知 type 只进 ledger_messages，不碰任何视图表", () => {
    const { store, proj } = fresh()
    proj.ingest([mkEvent(mkMsg({ id: "x1", type: "heartbeat" as MeshMessage["type"], payload: "{}" }))], "relay-A")
    assert.ok(store.getMessage("x1"))
    assert.equal(store.listTasks({}).length, 0)
    assert.equal(store.latestQuota().length, 0)
    assert.equal(store.listEvents({}).length, 0)
    store.close()
  })
})

describe("parseQuotaEnvelope · 纯函数", () => {
  it("多个 5h 桶取 used_percent 最大者（闸门看最满的窗）", () => {
    const parsed = parseQuotaEnvelope(JSON.stringify({
      source: "codex", account_id: "a1", status: "ok", probed_at: "t", host: "h",
      limits: [
        { kind: "5h", used_percent: 12, resets_at: "A" },
        { kind: "5h", used_percent: 80, resets_at: "B" },
      ],
    }))
    assert.equal(parsed.pct5h, 80)
    assert.equal(parsed.resets5h, "B")
  })

  it("非法输入抛错（由调用方转 quota_parse_error）", () => {
    assert.throws(() => parseQuotaEnvelope("{"))
    assert.throws(() => parseQuotaEnvelope("[]"))
    assert.throws(() => parseQuotaEnvelope(JSON.stringify({ source: "codex" })))
    assert.throws(() => parseQuotaEnvelope(JSON.stringify({ account_id: "a" })))
  })
})
