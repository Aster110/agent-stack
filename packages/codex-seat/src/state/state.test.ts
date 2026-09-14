// Lane B — state.json 原子写 + wal.jsonl 追加/折叠/压缩 的单测。
// 先红纪律：每条断言旁的「注入」注释写明为了看它变红，实现里改坏了什么。

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { atomicWriteFileSync, readJsonSync } from "./atomic.js"
import { WalStore } from "./wal.js"
import { StateStore, initialState, rememberMsgIds } from "./state-store.js"
import type { WalEntry } from "../contracts.js"

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-seat-state-"))
}

function walEntry(over: Partial<WalEntry> & Pick<WalEntry, "op" | "msgId">): WalEntry {
  return {
    seq: 1,
    to: "dev:seat",
    from: "dev:probe",
    nonce: "n0001",
    at: new Date().toISOString(),
    ...over,
  }
}

test("atomic: 写入后目标文件内容完整", () => {
  const dir = tmpdir()
  const f = path.join(dir, "deep", "state.json")
  atomicWriteFileSync(f, JSON.stringify({ a: 1 }))
  assert.equal(fs.readFileSync(f, "utf8"), '{"a":1}')
  assert.deepEqual(readJsonSync<{ a: number }>(f), { a: 1 })
})

test("atomic: 二次写入必须换 inode（证明走的是 rename 而不是原地截断覆盖）", () => {
  // 注入：把 atomicWriteFileSync 实现换成 fs.writeFileSync(file, data) → inode 不变 → 红
  const dir = tmpdir()
  const f = path.join(dir, "state.json")
  atomicWriteFileSync(f, "one")
  const ino1 = fs.statSync(f).ino
  atomicWriteFileSync(f, "two")
  const ino2 = fs.statSync(f).ino
  assert.notEqual(ino1, ino2, "原子写必须 rename 换 inode，读者要么看到旧文件要么看到新文件")
  assert.equal(fs.readFileSync(f, "utf8"), "two")
})

test("atomic: 写完不留 .tmp 残渣", () => {
  // 注入：删掉 rename 只留临时文件 → 残渣断言红
  const dir = tmpdir()
  const f = path.join(dir, "state.json")
  atomicWriteFileSync(f, "x")
  const residue = fs.readdirSync(dir).filter((n) => n !== "state.json")
  assert.deepEqual(residue, [], `目录里不该有临时文件：${residue.join(",")}`)
})

test("atomic: readJsonSync 对不存在/坏 JSON 返回 null", () => {
  const dir = tmpdir()
  assert.equal(readJsonSync(path.join(dir, "nope.json")), null)
  fs.writeFileSync(path.join(dir, "bad.json"), "{oops")
  assert.equal(readJsonSync(path.join(dir, "bad.json")), null)
})

test("wal: append 立刻可被另一个句柄读到（不许攒在内存里）", () => {
  // 注入：把 append 改成推进内存数组、close 时才落盘 → 红
  const dir = tmpdir()
  const wal = new WalStore(path.join(dir, "wal.jsonl"))
  wal.append(walEntry({ op: "fetched", msgId: "m1" }))
  const raw = fs.readFileSync(path.join(dir, "wal.jsonl"), "utf8")
  assert.equal(raw.trim().split("\n").length, 1)
  assert.match(raw, /"msgId":"m1"/)
  wal.close()
})

test("wal: readAll 容忍被截断的最后一行（崩溃点 P1/P2 的现场）", () => {
  // 注入：去掉 JSON.parse 的 try/catch → 抛异常 → 红
  const dir = tmpdir()
  const file = path.join(dir, "wal.jsonl")
  const wal = new WalStore(file)
  wal.append(walEntry({ op: "fetched", msgId: "m1", seq: 1 }))
  wal.append(walEntry({ op: "fetched", msgId: "m2", seq: 2 }))
  wal.append(walEntry({ op: "fetched", msgId: "m3", seq: 3 }))
  wal.close()
  const size = fs.statSync(file).size
  fs.truncateSync(file, size - 12) // 砍掉最后一行的尾巴

  const back = new WalStore(file)
  const entries = back.readAll()
  assert.equal(entries.length, 2, "半行必须丢弃，前面完整的行必须留住")
  assert.deepEqual(entries.map((e: { msgId: string }) => e.msgId), ["m1", "m2"])
  back.close()
})

test("wal: fold 给出每条消息的相位，终态折叠成 done", () => {
  const dir = tmpdir()
  const wal = new WalStore(path.join(dir, "wal.jsonl"))
  wal.append(walEntry({ op: "fetched", msgId: "a", seq: 1 }))
  wal.append(walEntry({ op: "fetched", msgId: "b", seq: 2 }))
  wal.append(walEntry({ op: "started", msgId: "b", seq: 2, threadId: "t1", turnId: "u1" }))
  wal.append(walEntry({ op: "fetched", msgId: "c", seq: 3 }))
  wal.append(walEntry({ op: "started", msgId: "c", seq: 3, threadId: "t1", turnId: "u2" }))
  wal.append(walEntry({ op: "completed", msgId: "c", seq: 3, finalText: "hello" }))
  wal.append(walEntry({ op: "fetched", msgId: "d", seq: 4 }))
  wal.append(walEntry({ op: "receipted", msgId: "d", seq: 4 }))

  const folded = wal.fold()
  assert.equal(folded.get("a")!.phase, "fetched")
  assert.equal(folded.get("b")!.phase, "started")
  assert.equal(folded.get("c")!.phase, "completed")
  assert.equal(folded.get("c")!.finalText, "hello")
  assert.equal(folded.get("d")!.phase, "done")
  wal.close()
})

test("wal: compact 丢掉 done、留下未闭环的，且文件真的变小", () => {
  // 注入：compact 里把 phase!=="done" 的过滤条件写反 → 留 done 丢未闭环 → 红
  const dir = tmpdir()
  const file = path.join(dir, "wal.jsonl")
  const wal = new WalStore(file)
  for (let i = 0; i < 20; i++) {
    wal.append(walEntry({ op: "fetched", msgId: `done-${i}`, seq: i }))
    wal.append(walEntry({ op: "receipted", msgId: `done-${i}`, seq: i }))
  }
  wal.append(walEntry({ op: "fetched", msgId: "live", seq: 99 }))
  const sizeBefore = fs.statSync(file).size
  const kept = wal.compact()
  const sizeAfter = fs.statSync(file).size
  assert.equal(kept, 1)
  assert.ok(sizeAfter < sizeBefore, `压缩后应更小：${sizeAfter} < ${sizeBefore}`)

  const back = new WalStore(file)
  const folded = back.fold()
  assert.deepEqual([...folded.keys()], ["live"])
  assert.equal(folded.get("live")!.phase, "fetched")
  back.close()
  wal.close()
})

test("wal: compact 之后还能继续 append（句柄没被写坏）", () => {
  const dir = tmpdir()
  const file = path.join(dir, "wal.jsonl")
  const wal = new WalStore(file)
  wal.append(walEntry({ op: "fetched", msgId: "x", seq: 1 }))
  wal.append(walEntry({ op: "receipted", msgId: "x", seq: 1 }))
  wal.compact()
  wal.append(walEntry({ op: "fetched", msgId: "y", seq: 2 }))
  wal.close()
  const back = new WalStore(file)
  assert.deepEqual(back.readAll().map((e: { msgId: string }) => e.msgId), ["y"])
  back.close()
})

test("state: save/load 往返 + 原子（inode 变化）", () => {
  const dir = tmpdir()
  const store = new StateStore(path.join(dir, "state.json"))
  const st = initialState({ seat: "e2e-abcd", nodeId: "e2edev:e2e-abcd", deviceId: "e2edev", instanceId: "inst-1" })
  store.save(st)
  const ino1 = fs.statSync(path.join(dir, "state.json")).ino
  st.cursor = 42
  st.mainThreadId = "t-main"
  store.save(st)
  const ino2 = fs.statSync(path.join(dir, "state.json")).ino
  assert.notEqual(ino1, ino2)

  const loaded = new StateStore(path.join(dir, "state.json")).load()
  assert.ok(loaded)
  assert.equal(loaded.cursor, 42)
  assert.equal(loaded.mainThreadId, "t-main")
  assert.equal(loaded.nodeId, "e2edev:e2e-abcd")
})

test("state: recentMsgIds 上限 1000 且保留最新", () => {
  // 注入：把 slice(-RECENT_MSG_IDS_MAX) 写成 slice(0, RECENT_MSG_IDS_MAX) → 保留最旧 → 红
  const st = initialState({ seat: "s", nodeId: "d:s", deviceId: "d", instanceId: "i" })
  for (let i = 0; i < 1200; i++) rememberMsgIds(st, [`m-${i}`])
  assert.equal(st.recentMsgIds.length, 1000)
  assert.equal(st.recentMsgIds.at(-1), "m-1199")
  assert.equal(st.recentMsgIds[0], "m-200")
  assert.ok(!st.recentMsgIds.includes("m-0"))
})

test("state: 坏掉的 state.json 不炸，load 返回 null（让席位重建）", () => {
  const dir = tmpdir()
  fs.writeFileSync(path.join(dir, "state.json"), "not json at all")
  assert.equal(new StateStore(path.join(dir, "state.json")).load(), null)
})

test("state: 新建的 state 游标是 null（未锚定），不是 0 —— 0 会让复用 nodeId 的席位重放全部历史", () => {
  // 先红注入：把 initialState 的 cursor 写回 0（2026-09-02 computer2 事故当天的行为）→ 本 case 红
  const st = initialState({ seat: "s", nodeId: "d:s", deviceId: "d", instanceId: "i" })
  assert.equal(st.cursor, null)
  assert.equal(st.cursorAnchoredAt, null)
  assert.equal(st.cursorAnchorSeq, null)
  assert.equal(st.paused, null)
  assert.match(st.createdAt, /^\d{4}-\d{2}-\d{2}T/)
})

test("state: 老 state.json（没有 createdAt/cursorAnchoredAt）读得出来，且 cursor 是数字就当已锚定", () => {
  const dir = tmpdir()
  const file = path.join(dir, "state.json")
  fs.writeFileSync(file, JSON.stringify({
    version: 1, contractVersion: "2", seat: "s", nodeId: "d:s", deviceId: "d",
    mainThreadId: null, workers: {}, cursor: 1364, instanceId: "i", startedAt: "2026-09-01T00:00:00.000Z",
    lastSeenAt: null, lastDoneAt: null, recentMsgIds: [], codexVersion: null, engine: null,
  }))
  const st = new StateStore(file).load()
  assert.ok(st)
  assert.equal(st.cursor, 1364, "老文件的游标必须原样保留（重新锚定会跳过在途消息）")
  assert.equal(st.createdAt, "2026-09-01T00:00:00.000Z", "没有 createdAt 就退回 startedAt 当出生时刻")
  assert.equal(st.paused, null)
})
