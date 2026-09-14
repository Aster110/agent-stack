/**
 * Lane C —— soak 判据的纯函数单测。
 *
 * soak 本身 48h 只写不跑，但**判据不能只写不测**：
 * 一个把泄漏判成健康的 analyze()，等于 48 小时白跑。
 * 所以这里用构造数据把三条判据（成功率 / p95 / RSS 形状）逐条打红过。
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  analyze,
  longestStrictlyIncreasingRun,
  percentile,
  MONOTONIC_RUN_LIMIT,
  SEEN_P95_BUDGET_MS,
  TAIL_HEAD_RATIO_LIMIT,
} from "../../e2e/soak/soak-report.js"
import { assertSafeLabel } from "../../e2e/lib/launchd.js"
import { parseMutateArg } from "../../e2e/lib/script-case.js"

const HOUR = 3600_000

function sample(i: number, o: { seenMs?: number | null; rss?: number; t0?: number; ok?: boolean } = {}) {
  const t0 = o.t0 ?? Date.parse("2026-09-01T00:00:00.000Z")
  return {
    at: new Date(t0 + i * 10 * 60_000).toISOString(),
    nonce: `n${i}`,
    seenMs: o.seenMs === undefined ? 100 : o.seenMs,
    doneMs: 2000,
    sidecarRssKb: o.rss ?? 50_000,
    engineRssKb: 0,
    engineProcCount: 2,
    instanceId: "i1",
    ok: o.ok ?? (o.seenMs === undefined ? true : o.seenMs != null && o.seenMs <= 3000),
  }
}

describe("percentile", () => {
  it("p95 取第 ⌈0.95n⌉ 个（1..100 → 95）", () => {
    assert.equal(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95), 95)
  })
  it("空数组返回 null 而不是 0（0 会被误判成「很快」）", () => {
    assert.equal(percentile([], 95), null)
  })
})

describe("最长连续严格递增段", () => {
  it("平的算 1", () => assert.equal(longestStrictlyIncreasingRun([5, 5, 5, 5]), 1))
  it("锯齿不算长段", () => assert.equal(longestStrictlyIncreasingRun([1, 2, 1, 2, 1, 2]), 2))
  it("一路涨算全长", () => assert.equal(longestStrictlyIncreasingRun([1, 2, 3, 4, 5]), 5))
  it("空数组 0", () => assert.equal(longestStrictlyIncreasingRun([]), 0))
})

describe("soak 判据", () => {
  it("全健康：成功率 1、p95 小、RSS 平", () => {
    const v = analyze(Array.from({ length: 300 }, (_, i) => sample(i)))
    assert.equal(v.seenRate, 1)
    assert.equal(v.seenP95! < SEEN_P95_BUDGET_MS, true)
    assert.equal(v.monotonicOk, true)
    assert.equal(v.ratioOk, true)
  })

  it("有一发没 seen → 成功率不足 1", () => {
    const s = Array.from({ length: 100 }, (_, i) => sample(i))
    s[42] = sample(42, { seenMs: null, ok: false })
    assert.equal(analyze(s).seenRate < 1, true)
  })

  it("p95 超预算要看得出来", () => {
    const s = Array.from({ length: 100 }, (_, i) => sample(i, { seenMs: i < 90 ? 100 : 9000 }))
    assert.equal(analyze(s).seenP95! >= SEEN_P95_BUDGET_MS, true)
  })

  it(`RSS 连涨 ${MONOTONIC_RUN_LIMIT} 个样本 → monotonicOk=false`, () => {
    const s = Array.from({ length: 60 }, (_, i) => sample(i, { rss: 50_000 + i * 100 }))
    const v = analyze(s)
    assert.equal(v.rssRunLen >= MONOTONIC_RUN_LIMIT, true)
    assert.equal(v.monotonicOk, false)
  })

  it("RSS 高但平 → 判健康（判的是形状不是绝对值）", () => {
    const v = analyze(Array.from({ length: 100 }, (_, i) => sample(i, { rss: 4_000_000 })))
    assert.equal(v.monotonicOk, true)
    assert.equal(v.ratioOk, true)
  })

  it(`末6h 均值 > 首6h 均值 ×${TAIL_HEAD_RATIO_LIMIT} → ratioOk=false`, () => {
    // 48h，每 10 分钟一个；前 6h 50MB，后面爬到 100MB（比值 2 > 1.3）
    const t0 = Date.parse("2026-09-01T00:00:00.000Z")
    const s = Array.from({ length: 288 }, (_, i) => {
      const elapsed = i * 10 * 60_000
      const rss = elapsed <= 6 * HOUR ? 50_000 : 100_000
      return sample(i, { rss, t0 })
    })
    const v = analyze(s)
    assert.equal(v.ratio! > TAIL_HEAD_RATIO_LIMIT, true)
    assert.equal(v.ratioOk, false)
  })
})

describe("e2e 红线守卫", () => {
  it("只允许 com.aster.codex-seat.e2e-<4hex>", () => {
    assertSafeLabel("com.aster.codex-seat.e2e-ab12")
  })
  it("拒绝生产席位 label", () => {
    assert.throws(() => assertSafeLabel("com.aster.codex-seat.codex-main"))
  })
  it("拒绝 com.aster.mesh-*（掀了整个蚁群没）", () => {
    for (const l of ["com.aster.mesh-relay-supervisor", "com.aster.mesh-seat-supervisor"]) {
      assert.throws(() => assertSafeLabel(l))
    }
  })
})

describe("--mutate 解析", () => {
  it("裸 --mutate", () => assert.deepEqual(parseMutateArg(["--mutate"]), { on: true, mode: null }))
  it("--mutate=sweep", () => assert.deepEqual(parseMutateArg(["--mutate=sweep"]), { on: true, mode: "sweep" }))
  it("没有就是 off", () => assert.deepEqual(parseMutateArg([]), { on: false, mode: null }))
})
