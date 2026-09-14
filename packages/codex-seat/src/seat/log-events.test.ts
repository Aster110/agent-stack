import test from "node:test"
import assert from "node:assert/strict"

import { countSeatLogEvents } from "./log-events.js"

// 真实格式：seat.ts 的 defaultFileLogger 写的是 {"at":…,"event":"…",…}
const REAL_SIDECAR_LOG = [
  `{"at":"2026-09-02T17:29:08.372Z","event":"seat-start","nodeId":"e2edev:e2e-0179","instanceId":"i1","engineUp":true,"faults":[]}`,
  `{"at":"2026-09-02T17:29:08.480Z","event":"engine-up","pid":41337,"pgid":41337,"codexVersion":"codex-cli 0.151.0"}`,
  `{"at":"2026-09-02T17:29:09.001Z","event":"thread-started","nodeId":"e2edev:e2e-0179","threadId":"01a0","opMs":88}`,
  `{"at":"2026-09-02T17:29:10.113Z","event":"turn-window","nonce":"n1","threadId":"01a0","wallMs":1200,"status":"completed"}`,
  `{"at":"2026-09-02T17:29:10.120Z","event":"turn-window","nonce":"n2","threadId":"01a0","wallMs":900,"status":"completed"}`,
  "",
  `{"at":"2026-09-02T17:29:11.000Z","event":"seat-s`, // 崩溃点截断的半行
].join("\n")

test("log-events: 真实格式的 sidecar 日志必须数出非零计数", () => {
  // 注入验红：把 SEAT_LOG_EVENT_KEYS 改回只认 "ev" → 这里全 0，本条立刻红。
  const c = countSeatLogEvents(REAL_SIDECAR_LOG)
  assert.equal(c["seat-start"], 1)
  assert.equal(c["engine-up"], 1)
  assert.equal(c["thread-started"], 1)
  assert.equal(c["turn-window"], 2, "同名事件要累加")
  assert.ok(Object.values(c).some((n) => n > 0), "非零计数：这正是 evidenceReallyRan 要的活证据")
  assert.equal(Object.keys(c).length, 4, "截断的半行不许算进去")
})

test("log-events: 字段名不对（既不是 event 也不是 ev）就必须是空 —— 尺子不许自己编数", () => {
  const wrong = [
    `{"at":"t","evt":"seat-start"}`,
    `{"at":"t","name":"engine-up"}`,
    `{"at":"t","message":"turn-window"}`,
  ].join("\n")
  assert.deepEqual(countSeatLogEvents(wrong), {})
})

test("log-events: 历史字段 ev 仍然认（老日志不该突然变成空）", () => {
  assert.deepEqual(countSeatLogEvents(`{"ev":"legacy"}\n{"ev":"legacy"}`), { legacy: 2 })
})

test("log-events: 空文本 / 非 JSON 行 / 没有事件名的行 → 空", () => {
  assert.deepEqual(countSeatLogEvents(""), {})
  assert.deepEqual(countSeatLogEvents("这不是 JSON\nplain text"), {})
  assert.deepEqual(countSeatLogEvents(`{"at":"t"}\n{"event":""}\n{"event":123}`), {})
})
