/**
 * CompositeTerminal 单测 — 按 session_id 格式动态路由到 Tmux 或 iTerm 后端
 *
 * 用 mock 两个 fake backend（像 terminal.test.ts 的 MockTerminal 那样，记录调用参数）
 * 风格对齐 terminal.test.ts：node:test + assert/strict
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { CompositeTerminal } from "./composite.js"
import type { ITerminal, SpawnResult } from "./interface.js"

// ===== Fake Backend —— 记录所有调用 =====
class FakeBackend implements ITerminal {
  name: string
  injectLog: Array<{ sessionId: string; text: string; hint?: { windowId?: string } }> = []
  spawnLog: Array<{ cmd: string; opts?: { mode?: "tab" | "window"; cwd?: string } }> = []
  isAliveLog: string[] = []
  closeLog: string[] = []
  identityLog: string[] = []
  identityResult: string | null = null
  getCurrentSessionCalls = 0

  constructor(name: string) { this.name = name }

  async inject(sessionId: string, text: string, hint?: { windowId?: string }): Promise<boolean> {
    this.injectLog.push({ sessionId, text, hint })
    return true
  }

  async spawn(cmd: string, opts?: { mode?: "tab" | "window"; cwd?: string }): Promise<SpawnResult> {
    this.spawnLog.push({ cmd, opts })
    return { sessionId: `${this.name}-sess-${this.spawnLog.length}`, windowId: `${this.name}-win-${this.spawnLog.length}` }
  }

  async isAlive(sessionId: string): Promise<boolean> {
    this.isAliveLog.push(sessionId)
    return true
  }

  async close(sessionId: string): Promise<void> {
    this.closeLog.push(sessionId)
  }

  async getCurrentSession(): Promise<{ sessionId: string; windowId?: string } | null> {
    this.getCurrentSessionCalls++
    return { sessionId: `${this.name}-current`, windowId: `${this.name}-current-win` }
  }

  async identity(sessionId: string): Promise<string | null> {
    this.identityLog.push(sessionId)
    return this.identityResult
  }
}

// UUID 示例（标准格式）
const UUID_UPPER = "9A7D37B4-1A2B-4C3D-8E4F-1234567890AB"
const UUID_LOWER = "9a7d37b4-1a2b-4c3d-8e4f-1234567890ab"
const UUID_MIXED = "9a7d37B4-1a2b-4C3D-8e4f-1234567890Ab"

// 非 UUID 示例
const MESH_ID = "mesh-mo8xxx-a1b2"
const CC2W_ID = "cc2w-123abc"
const PLAIN_ID = "sess-foo"
const NEAR_UUID = "foo-1234-5678-90ab-cdef12345678"  // 第一段不是 8 位 hex

describe("CompositeTerminal — 按 session_id 格式动态路由", () => {
  function setup(defaultSpawn: "tmux" | "iterm" = "tmux") {
    const tmux = new FakeBackend("tmux")
    const iterm = new FakeBackend("iterm")
    const composite = new CompositeTerminal({ tmux, iterm, defaultSpawn })
    return { tmux, iterm, composite }
  }

  // ===== (a) inject UUID → 走 iterm =====
  describe("inject 路由", () => {
    it("UUID 大写格式 → 只调 iterm.inject", async () => {
      const { tmux, iterm, composite } = setup()
      await composite.inject(UUID_UPPER, "hello")
      assert.equal(iterm.injectLog.length, 1)
      assert.equal(iterm.injectLog[0].sessionId, UUID_UPPER)
      assert.equal(iterm.injectLog[0].text, "hello")
      assert.equal(tmux.injectLog.length, 0, "tmux.inject 不应被调用")
    })

    // (f) 大小写无关：小写 hex 也判断为 UUID
    it("UUID 小写 hex 格式 → 只调 iterm.inject", async () => {
      const { tmux, iterm, composite } = setup()
      await composite.inject(UUID_LOWER, "hello-lower")
      assert.equal(iterm.injectLog.length, 1)
      assert.equal(iterm.injectLog[0].sessionId, UUID_LOWER)
      assert.equal(tmux.injectLog.length, 0)
    })

    it("UUID 大小写混合 → 只调 iterm.inject", async () => {
      const { tmux, iterm, composite } = setup()
      await composite.inject(UUID_MIXED, "hello-mixed")
      assert.equal(iterm.injectLog.length, 1)
      assert.equal(tmux.injectLog.length, 0)
    })

    // (b) mesh-xxx / 普通字符串 → 只调 tmux
    it("mesh-xxx 格式 → 只调 tmux.inject", async () => {
      const { tmux, iterm, composite } = setup()
      await composite.inject(MESH_ID, "mesh-msg")
      assert.equal(tmux.injectLog.length, 1)
      assert.equal(tmux.injectLog[0].sessionId, MESH_ID)
      assert.equal(iterm.injectLog.length, 0, "iterm.inject 不应被调用")
    })

    it("cc2w-xxx 格式 → 只调 tmux.inject", async () => {
      const { tmux, iterm, composite } = setup()
      await composite.inject(CC2W_ID, "cc2w-msg")
      assert.equal(tmux.injectLog.length, 1)
      assert.equal(iterm.injectLog.length, 0)
    })

    it("普通字符串（sess-foo）→ 只调 tmux.inject", async () => {
      const { tmux, iterm, composite } = setup()
      await composite.inject(PLAIN_ID, "plain-msg")
      assert.equal(tmux.injectLog.length, 1)
      assert.equal(iterm.injectLog.length, 0)
    })

    it("Codex launcher 只要注册的是 tmux sessionId，send 仍走 tmux.inject", async () => {
      const { tmux, iterm, composite } = setup()
      const codexTmuxSession = "mesh-codex-a1b2"
      await composite.inject(codexTmuxSession, "codex-msg")
      assert.equal(tmux.injectLog.length, 1)
      assert.equal(tmux.injectLog[0].sessionId, codexTmuxSession)
      assert.equal(tmux.injectLog[0].text, "codex-msg")
      assert.equal(iterm.injectLog.length, 0, "launcher 名称不影响路由，仍按 sessionId 类型分流")
    })

    it("类 UUID 但第一段不是 8 位 hex（foo-...）→ 只调 tmux.inject", async () => {
      const { tmux, iterm, composite } = setup()
      await composite.inject(NEAR_UUID, "near-uuid-msg")
      assert.equal(tmux.injectLog.length, 1)
      assert.equal(iterm.injectLog.length, 0, "foo-1234-... 不应被识别为 UUID")
    })

    it("inject 带 windowId hint 透传到对应后端", async () => {
      const { tmux, iterm, composite } = setup()
      await composite.inject(UUID_UPPER, "with-hint", { windowId: "w-1" })
      assert.equal(iterm.injectLog[0].hint?.windowId, "w-1")
      assert.equal(tmux.injectLog.length, 0)
    })
  })

  // ===== (c) isAlive 路由 =====
  describe("isAlive 路由", () => {
    it("UUID → iterm.isAlive", async () => {
      const { tmux, iterm, composite } = setup()
      await composite.isAlive(UUID_UPPER)
      assert.deepEqual(iterm.isAliveLog, [UUID_UPPER])
      assert.deepEqual(tmux.isAliveLog, [])
    })

    it("普通名 → tmux.isAlive", async () => {
      const { tmux, iterm, composite } = setup()
      await composite.isAlive(MESH_ID)
      assert.deepEqual(tmux.isAliveLog, [MESH_ID])
      assert.deepEqual(iterm.isAliveLog, [])
    })
  })

  describe("identity 路由", () => {
    async function readIdentity(composite: CompositeTerminal, sessionId: string): Promise<string | null> {
      const identity = (composite as ITerminal).identity
      assert.equal(typeof identity, "function", "CompositeTerminal 必须实现 ITerminal.identity")
      return identity!.call(composite, sessionId)
    }

    it("非 UUID → 与 inject/isAlive 一样只委托 tmux；不受 defaultSpawn 影响", async () => {
      const { tmux, iterm, composite } = setup("iterm")
      tmux.identityResult = "mesh-mo8xxx-a1b2|/work|codex"
      ;(iterm as unknown as { identity?: ITerminal["identity"] }).identity = undefined

      assert.equal(await readIdentity(composite, MESH_ID), tmux.identityResult)
      assert.deepEqual(tmux.identityLog, [MESH_ID])
      assert.deepEqual(iterm.identityLog, [], "另一 backend 无 identity 不能影响实际 tmux backend")
    })

    it("UUID → 与 inject/isAlive 一样只委托 iTerm；另一 backend 无 identity 也能取指纹", async () => {
      const { tmux, iterm, composite } = setup("tmux")
      iterm.identityResult = "iterm-uuid-fingerprint"
      ;(tmux as unknown as { identity?: ITerminal["identity"] }).identity = undefined

      assert.equal(await readIdentity(composite, UUID_UPPER), iterm.identityResult)
      assert.deepEqual(iterm.identityLog, [UUID_UPPER])
      assert.deepEqual(tmux.identityLog, [], "另一 backend 无 identity 不能影响实际 iTerm backend")
    })

    it("同一 Composite 在 UUID/non-UUID 间切换时，identity 每次按当前 session 重新选 backend", async () => {
      const { tmux, iterm, composite } = setup("tmux")
      tmux.identityResult = "tmux-fingerprint"
      iterm.identityResult = "iterm-fingerprint"

      assert.equal(await readIdentity(composite, MESH_ID), "tmux-fingerprint")
      assert.equal(await readIdentity(composite, UUID_LOWER), "iterm-fingerprint")
      assert.equal(await readIdentity(composite, PLAIN_ID), "tmux-fingerprint")
      assert.deepEqual(tmux.identityLog, [MESH_ID, PLAIN_ID])
      assert.deepEqual(iterm.identityLog, [UUID_LOWER])
    })

    it("实际 backend 无 identity → 返回 null，禁止回退到另一 backend 的指纹", async () => {
      const { tmux, iterm, composite } = setup("iterm")
      iterm.identityResult = "wrong-backend-fingerprint"
      ;(tmux as unknown as { identity?: ITerminal["identity"] }).identity = undefined

      assert.equal(await readIdentity(composite, MESH_ID), null)
      assert.deepEqual(iterm.identityLog, [], "禁止从非 inject backend 猜指纹")
    })
  })

  // ===== (d) close 路由 =====
  describe("close 路由", () => {
    it("UUID → iterm.close", async () => {
      const { tmux, iterm, composite } = setup()
      await composite.close(UUID_LOWER)
      assert.deepEqual(iterm.closeLog, [UUID_LOWER])
      assert.deepEqual(tmux.closeLog, [])
    })

    it("普通名 → tmux.close", async () => {
      const { tmux, iterm, composite } = setup()
      await composite.close(MESH_ID)
      assert.deepEqual(tmux.closeLog, [MESH_ID])
      assert.deepEqual(iterm.closeLog, [])
    })
  })

  // ===== (e) spawn 用 defaultSpawn =====
  describe("spawn 用默认后端（不看 session_id）", () => {
    it("defaultSpawn=tmux → spawn 调 tmux.spawn", async () => {
      const { tmux, iterm, composite } = setup("tmux")
      const result = await composite.spawn("echo hi", { cwd: "/tmp" })
      assert.equal(tmux.spawnLog.length, 1)
      assert.equal(tmux.spawnLog[0].cmd, "echo hi")
      assert.equal(tmux.spawnLog[0].opts?.cwd, "/tmp")
      assert.equal(iterm.spawnLog.length, 0)
      assert.ok(result.sessionId.startsWith("tmux-"), `spawn 返回应来自 tmux，实际: ${result.sessionId}`)
    })

    it("defaultSpawn=iterm → spawn 调 iterm.spawn", async () => {
      const { tmux, iterm, composite } = setup("iterm")
      const result = await composite.spawn("echo hi", { mode: "window" })
      assert.equal(iterm.spawnLog.length, 1)
      assert.equal(iterm.spawnLog[0].opts?.mode, "window")
      assert.equal(tmux.spawnLog.length, 0)
      assert.ok(result.sessionId.startsWith("iterm-"))
    })
  })

  // ===== (g) getCurrentSession 用默认后端 =====
  describe("getCurrentSession 用默认后端", () => {
    it("defaultSpawn=tmux → getCurrentSession 走 tmux", async () => {
      const { tmux, iterm, composite } = setup("tmux")
      const cur = await composite.getCurrentSession()
      assert.equal(tmux.getCurrentSessionCalls, 1)
      assert.equal(iterm.getCurrentSessionCalls, 0)
      assert.equal(cur?.sessionId, "tmux-current")
    })

    it("defaultSpawn=iterm → getCurrentSession 走 iterm", async () => {
      const { tmux, iterm, composite } = setup("iterm")
      const cur = await composite.getCurrentSession()
      assert.equal(iterm.getCurrentSessionCalls, 1)
      assert.equal(tmux.getCurrentSessionCalls, 0)
      assert.equal(cur?.sessionId, "iterm-current")
    })
  })
})
