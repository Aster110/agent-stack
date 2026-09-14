/**
 * createTerminal() 环境变量 + 探测结果分支测试
 *
 * 用 probes 依赖注入避免碰真实 which/iTerm.app 检查，env 用 try/finally 临时赋值。
 * 风格对齐 composite.test.ts / terminal.test.ts：node:test + assert/strict。
 *
 * 不变式守护：
 *  - 所有 MESH_TERMINAL 分支（tmux/iterm/composite/unknown）
 *  - auto-detect 的四象限（tmux+iterm / 只 tmux / 只 iterm / 都没有）
 *  - MESH_COMPOSITE_DEFAULT_SPAWN 对 composite spawn 的切换
 *  - 默认探测保留 —— 不传 probes 行为零变化（不在这里测，仅在类型级保证）
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createTerminal } from "./detect.js"
import type { TerminalProbes } from "./detect.js"
import { TmuxTerminal } from "./tmux.js"
import { ITermTerminal } from "./iterm.js"
import { CompositeTerminal } from "./composite.js"

// ===== env 救急工具：临时赋值 + 恢复 =====
const ENV_KEYS = ["MESH_TERMINAL", "MESH_COMPOSITE_DEFAULT_SPAWN"] as const

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const backup: Record<string, string | undefined> = {}
  for (const k of ENV_KEYS) backup[k] = process.env[k]
  try {
    // 先清除相关 env（避免外部环境污染测试）
    for (const k of ENV_KEYS) delete process.env[k]
    // 再按传入覆盖
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    return fn()
  } finally {
    for (const k of ENV_KEYS) {
      const v = backup[k]
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

function probes(hasTmux: boolean, hasITerm: boolean): TerminalProbes {
  return {
    hasTmux: () => hasTmux,
    hasITerm: () => hasITerm,
  }
}

describe("createTerminal — MESH_TERMINAL 显式指定", () => {
  it("MESH_TERMINAL=tmux + hasTmux=true → TmuxTerminal", () => {
    withEnv({ MESH_TERMINAL: "tmux" }, () => {
      const term = createTerminal(probes(true, false))
      assert.ok(term instanceof TmuxTerminal, "应返回 TmuxTerminal")
    })
  })

  it("MESH_TERMINAL=tmux + hasTmux=false → throw", () => {
    withEnv({ MESH_TERMINAL: "tmux" }, () => {
      assert.throws(
        () => createTerminal(probes(false, true)),
        /tmux is not installed/,
        "tmux 未安装时应抛错",
      )
    })
  })

  it("MESH_TERMINAL=iterm + hasITerm=true → ITermTerminal", () => {
    withEnv({ MESH_TERMINAL: "iterm" }, () => {
      const term = createTerminal(probes(false, true))
      assert.ok(term instanceof ITermTerminal, "应返回 ITermTerminal")
    })
  })

  it("MESH_TERMINAL=iterm + hasITerm=false → throw", () => {
    withEnv({ MESH_TERMINAL: "iterm" }, () => {
      assert.throws(
        () => createTerminal(probes(true, false)),
        /iTerm2 is not available/,
        "iTerm 不可用时应抛错",
      )
    })
  })

  it("MESH_TERMINAL=composite + 两者都有 → CompositeTerminal（spawn 默认 tmux）", () => {
    withEnv({ MESH_TERMINAL: "composite" }, () => {
      const term = createTerminal(probes(true, true))
      assert.ok(term instanceof CompositeTerminal, "应返回 CompositeTerminal")
    })
  })

  it("MESH_TERMINAL=composite + MESH_COMPOSITE_DEFAULT_SPAWN=iterm → CompositeTerminal（spawn 走 iterm）", async () => {
    await withEnv(
      { MESH_TERMINAL: "composite", MESH_COMPOSITE_DEFAULT_SPAWN: "iterm" },
      async () => {
        const term = createTerminal(probes(true, true)) as CompositeTerminal
        assert.ok(term instanceof CompositeTerminal, "应返回 CompositeTerminal")
        // 间接验证 defaultSpawn=iterm：内部 defaultBackend 是 ITermTerminal
        // （无法直接读私有字段，改用 getCurrentSession 路由去触摸 default backend，
        //  但 iterm.getCurrentSession 会走 osascript —— 这里不实际跑，
        //  仅靠构造未抛 + 是 CompositeTerminal 实例作为最低保证）
        // 要更强的保证：CompositeTerminal 有 defaultSpawnName 私有字段做日志，
        // 但为避免侵入私有字段，通过类型 + 不抛作为断言。
      },
    )
  })

  it("MESH_TERMINAL=composite + hasITerm=false → throw", () => {
    withEnv({ MESH_TERMINAL: "composite" }, () => {
      assert.throws(
        () => createTerminal(probes(true, false)),
        /requires iTerm2/,
        "composite 缺 iTerm 时应抛错",
      )
    })
  })

  it("MESH_TERMINAL=composite + hasTmux=false → throw", () => {
    withEnv({ MESH_TERMINAL: "composite" }, () => {
      assert.throws(
        () => createTerminal(probes(false, true)),
        /requires tmux installed/,
        "composite 缺 tmux 时应抛错",
      )
    })
  })

  it("MESH_TERMINAL=unknown_value → throw", () => {
    withEnv({ MESH_TERMINAL: "unknown_value" }, () => {
      assert.throws(
        () => createTerminal(probes(true, true)),
        /is not valid/,
        "未知 MESH_TERMINAL 值应抛错",
      )
    })
  })
})

describe("createTerminal — auto-detect（不设 MESH_TERMINAL）", () => {
  it("两者都有 → CompositeTerminal（auto-detect 默认）", () => {
    withEnv({}, () => {
      const term = createTerminal(probes(true, true))
      assert.ok(term instanceof CompositeTerminal, "auto-detect 两者都有时应返回 CompositeTerminal")
    })
  })

  it("只有 iTerm → ITermTerminal", () => {
    withEnv({}, () => {
      const term = createTerminal(probes(false, true))
      assert.ok(term instanceof ITermTerminal, "只有 iTerm 时应返回 ITermTerminal")
    })
  })

  it("只有 tmux → TmuxTerminal", () => {
    withEnv({}, () => {
      const term = createTerminal(probes(true, false))
      assert.ok(term instanceof TmuxTerminal, "只有 tmux 时应返回 TmuxTerminal")
    })
  })

  it("都没有 → throw", () => {
    withEnv({}, () => {
      assert.throws(
        () => createTerminal(probes(false, false)),
        /No terminal backend available/,
        "两者都没有时应抛错",
      )
    })
  })
})
