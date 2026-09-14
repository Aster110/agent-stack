/**
 * TmuxTerminal 集成测试 — 用真实 tmux 验证 5 个 ITerminal 方法
 *
 * 前置条件：tmux 已安装且可用
 * 风格对齐 terminal.test.ts：node:test + assert/strict
 *
 * ⚠️⚠️ 这个文件出过一次很贵的事故，改它之前必须读完这段 ⚠️⚠️
 *
 * 2026-08-28：本文件的 after() 钩子曾在**生产 tmux server** 上执行
 *   `list-sessions` → `startsWith("mesh-")` → `kill-session`。
 * 真实席位的名字恰恰就是 `mesh-<ts36>-<rand4>`，relay 自己也活在 `mesh-relay` 里
 * （那个 session 的 pane pid == ~/.ccmesh/relay.pid）。
 * ⇒ **在这台机上跑一次集成测试 = 把全机 mesh 席位连同 relay 本体一起杀光。**
 * 当时误判成「relay restart 连坐」，查了很久才落到这一行 startsWith 上。
 *
 * 现在的两道防线，**任何一道都不许拆**：
 *
 *  ① 服务器级隔离：模块加载时把 TMUX_TMPDIR 指到一个临时目录。
 *     tmux 按 $TMUX_TMPDIR 决定 socket 落点 ⇒ 不同目录 = **不同 tmux server**。
 *     选它而不是给每条命令加 `-L` 的理由：`tmux.ts` 里的 execFile **没传 env**，
 *     继承 process.env ⇒ 一个环境变量把**生产代码自己发出的 tmux 调用**也一并罩住了；
 *     而 `-L` 只能罩住测试文件里手写的那几条，漏一条就前功尽弃。
 *
 *  ② 清理只按**精确清单**，永不按前缀匹配。见 killTrackedSessions()。
 *
 * 还有一个 static 检查在 tmux.integration.guard.test.ts 里盯着这两条，
 * 它不跑 tmux，纯读源码 —— 因为防线①一旦失效，能发现的时候席位已经死了。
 */
import { describe, it, before, after, afterEach } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, execSync } from "node:child_process"
import { mkdtempSync, writeFileSync, existsSync, unlinkSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TmuxTerminal } from "./tmux.js"

// ===== 防线①：把本进程的所有 tmux 调用赶进独立 server =====
// 先把原值留住 —— 哨兵用例要故意回到**生产 server** 上验证「我们没碰它」。
const ORIGINAL_TMUX_TMPDIR = process.env.TMUX_TMPDIR
const ORIGINAL_TMUX = process.env.TMUX
const ORIGINAL_TMUX_PANE = process.env.TMUX_PANE

// 落在 /tmp 而不是 os.tmpdir()：macOS 的 tmpdir() 是 /var/folders/xx/……/T 这种长路径，
// tmux 还要在后面接 /default，很容易顶爆 unix socket 的 sun_path 上限（约 104 字节），
// 报出来的错还跟隔离八竿子打不着。短前缀在这里是功能需求，不是洁癖。
const ISOLATED_TMUX_TMPDIR = mkdtempSync("/tmp/mesh-tmux-it-")

// 🔴🔴 顺序敏感：先 delete TMUX，再设 TMUX_TMPDIR。两件事都必须在**任何 tmux 调用之前**。
//
// 只设 TMUX_TMPDIR 是**不够的** —— 这不是推理，是实测出来的：
//
//   $ TMUX=/tmp/tmux-501/sentserver,15543,0 TMUX_TMPDIR=/tmp/iso tmux new-session -d -s probe
//   $ tmux -L sentserver list-sessions     → parent-sentinel, probe   ← 会话落在了 TMUX 指的 server
//   $ TMUX_TMPDIR=/tmp/iso tmux list-sessions
//                                          → error: no such file      ← 隔离 server 根本没被创建
//
//   $ env -u TMUX TMUX_TMPDIR=/tmp/iso tmux new-session -d -s probe-fixed
//   $ tmux -L sentserver list-sessions     → parent-sentinel（干净）
//   $ TMUX_TMPDIR=/tmp/iso list-sessions   → probe-fixed              ← 删掉 TMUX 才真隔离
//
// **$TMUX 压过 TMUX_TMPDIR。** 而这恰恰是最危险的场景：mesh 席位本身就是 tmux pane，
// 谁在席位里跑一次这套测试，$TMUX 就指着生产 server，整套隔离等于不存在 —— 事故原样重演。
//
// TMUX_PANE 实测不影响 socket 选择（带着它建的会话仍落在隔离 server），
// 但 tmux.ts 的 getCurrentSession() 读它来判断「是否在 tmux 内」；
// 留着会让它对着隔离 server 问一个不存在的 pane。一并清掉，语义才自洽。
delete process.env.TMUX
delete process.env.TMUX_PANE
process.env.TMUX_TMPDIR = ISOLATED_TMUX_TMPDIR

/** 回到生产 server 的 env（只给哨兵用例；正常路径一律不碰）。 */
function productionServerEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  const restore = (key: "TMUX_TMPDIR" | "TMUX" | "TMUX_PANE", original: string | undefined): void => {
    if (original === undefined) delete env[key]
    else env[key] = original
  }
  restore("TMUX_TMPDIR", ORIGINAL_TMUX_TMPDIR)
  restore("TMUX", ORIGINAL_TMUX)
  restore("TMUX_PANE", ORIGINAL_TMUX_PANE)
  return env
}

/** 进程退出前把 env 还原成进来时的样子（同进程内还有别的测试文件在跑）。 */
function restoreProcessEnv(): void {
  const put = (key: "TMUX_TMPDIR" | "TMUX" | "TMUX_PANE", original: string | undefined): void => {
    if (original === undefined) delete process.env[key]
    else process.env[key] = original
  }
  put("TMUX_TMPDIR", ORIGINAL_TMUX_TMPDIR)
  put("TMUX", ORIGINAL_TMUX)
  put("TMUX_PANE", ORIGINAL_TMUX_PANE)
}

// ===== tmux 可用性检查 =====
let tmuxAvailable = false
try {
  execFileSync("tmux", ["-V"], { timeout: 3000 })
  tmuxAvailable = true
} catch {
  // tmux not available
}

// 收集所有测试中创建的 session，afterEach 统一清理
const createdSessions: string[] = []

function killSession(sessionId: string): void {
  try {
    execFileSync("tmux", ["kill-session", "-t", sessionId], { timeout: 3000 })
  } catch {
    // already dead — idempotent
  }
}

function sessionExists(sessionId: string): boolean {
  try {
    execFileSync("tmux", ["has-session", "-t", sessionId], { timeout: 3000 })
    return true
  } catch {
    return false
  }
}

function capturePane(sessionId: string): string {
  try {
    return execFileSync("tmux", ["capture-pane", "-t", sessionId, "-p"], {
      timeout: 3000,
      encoding: "utf-8",
    })
  } catch {
    return ""
  }
}

// 等待 capture-pane 中出现指定文本（轮询）
async function waitForContent(
  sessionId: string,
  needle: string,
  timeoutMs = 3000,
): Promise<string> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const content = capturePane(sessionId)
    if (content.includes(needle)) return content
    await new Promise((r) => setTimeout(r, 100))
  }
  return capturePane(sessionId)
}

// 本文件生命周期内**由我们亲手创建**的 session 全集（含 afterEach 已清掉的），
// 兜底清理只认这份清单。
const everCreatedSessions = new Set<string>()

/**
 * 防线②：兜底清理**只按精确清单**，绝不按前缀扫。
 *
 * 🔴 这里曾经写的是 `list-sessions` + `startsWith("mesh-")` + kill —— 那正是通杀事故的原句。
 * 「扫一遍把漏网的都清掉」听起来比逐个记名字稳，实际是把**别人的 session** 也算进了自己的账。
 * 测试没有资格枚举它没创建过的东西。要兜底，就兜自己那份清单。
 */
function killTrackedSessions(): void {
  for (const name of everCreatedSessions) {
    killSession(name)
  }
  everCreatedSessions.clear()
}

/**
 * 隔离 server 是本文件私有的，收尾时整个掀掉。
 * 因为①的存在，这条命令打不到生产 server —— 它连那个 socket 都看不见。
 */
function teardownIsolatedServer(): void {
  try {
    execFileSync("tmux", ["kill-server"], { timeout: 3000, stdio: "ignore" })
  } catch {
    // server 本来就没起来 / 已经空了
  }
  try {
    rmSync(ISOLATED_TMUX_TMPDIR, { recursive: true, force: true })
  } catch {
    // 清不掉就算了，是 /tmp 下的空目录
  }
}

describe("TmuxTerminal 集成测试（真实 tmux）", { skip: !tmuxAvailable && "tmux not available" }, () => {
  let terminal: TmuxTerminal

  before(() => {
    terminal = new TmuxTerminal()
  })

  afterEach(() => {
    // 清理所有本轮创建的 session；顺手记进 everCreatedSessions，
    // 好让 after() 的兜底有一份**精确名单**可清，而不必去扫 server。
    for (const sid of createdSessions) {
      everCreatedSessions.add(sid)
      killSession(sid)
    }
    createdSessions.length = 0
  })

  // 兜底：describe 级别 after hook，确保无泄漏（#3 审查意见）
  // ⚠️ 只清自己创建的（防线②），再掀掉私有 server（安全，因为防线①）
  after(() => {
    killTrackedSessions()
    teardownIsolatedServer()
    restoreProcessEnv() // env 是进程级的，同进程里还有别的测试文件要跑
  })

  // ===== spawn =====

  describe("spawn", () => {
    it("正常 spawn 返回 sessionId", async () => {
      const result = await terminal.spawn("echo spawn-test-ok")
      createdSessions.push(result.sessionId)

      assert.ok(result.sessionId, "应返回非空 sessionId")
      assert.ok(result.sessionId.startsWith("mesh-"), "sessionId 应以 mesh- 开头")
    })

    it("spawn 后 tmux session 存在", async () => {
      const result = await terminal.spawn("sleep 30")
      createdSessions.push(result.sessionId)

      assert.ok(sessionExists(result.sessionId), "tmux has-session 应成功")
    })

    it("spawn 带 cwd 参数，session 工作目录正确", async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "tmux-cwd-test-"))
      // 用 marker 文件验证：在 cwd 下创建文件，用 ls 检查
      const marker = `cwd-marker-${Date.now()}.txt`
      writeFileSync(join(tmpDir, marker), "ok", "utf-8")
      // 用 ls <marker> 检查文件是否在当前目录可见
      const result = await terminal.spawn(`ls ${marker}`, { cwd: tmpDir })
      createdSessions.push(result.sessionId)

      const content = await waitForContent(result.sessionId, marker, 3000)
      assert.ok(content.includes(marker), `cwd 下应能看到 ${marker}，实际: ${content.trim()}`)
    })

    it("spawn 的命令在 session 里执行了", async () => {
      const marker = `SPAWN_MARKER_${Date.now()}`
      const result = await terminal.spawn(`echo ${marker}`)
      createdSessions.push(result.sessionId)

      const content = await waitForContent(result.sessionId, marker, 3000)
      assert.ok(content.includes(marker), `应看到 marker ${marker}，实际: ${content.trim()}`)
    })

    // 新增：并发 spawn（#7 审查意见）
    it("并发 spawn 3 个 session，各自独立且 sessionId 不同", async () => {
      const results = await Promise.all([
        terminal.spawn("sleep 30"),
        terminal.spawn("sleep 30"),
        terminal.spawn("sleep 30"),
      ])
      for (const r of results) {
        createdSessions.push(r.sessionId)
      }

      // sessionId 互不相同
      const ids = results.map((r) => r.sessionId)
      assert.equal(new Set(ids).size, 3, "3 个 sessionId 应互不相同")

      // 各自独立存在
      for (const r of results) {
        assert.ok(sessionExists(r.sessionId), `session ${r.sessionId} 应存在`)
      }
    })
  })

  // ===== inject =====

  describe("inject", () => {
    it("注入简单文本，capture-pane 能看到", async () => {
      // 先 spawn 一个 shell
      const result = await terminal.spawn("cat")
      createdSessions.push(result.sessionId)
      await waitForContent(result.sessionId, "", 500) // 等 cat 就绪（#6 审查意见）

      const marker = `INJECT_SIMPLE_${Date.now()}`
      const ok = await terminal.inject(result.sessionId, `${marker}`)
      assert.ok(ok, "inject 应返回 true")

      const content = await waitForContent(result.sessionId, marker, 3000)
      assert.ok(content.includes(marker), `应看到注入文本，实际: ${content.trim()}`)
    })

    it("注入中文 + emoji", async () => {
      const result = await terminal.spawn("cat")
      createdSessions.push(result.sessionId)
      await waitForContent(result.sessionId, "", 500) // 等 cat 就绪

      const text = "你好世界🚀"
      const ok = await terminal.inject(result.sessionId, text)
      assert.ok(ok, "inject 中文+emoji 应返回 true")

      const content = await waitForContent(result.sessionId, "你好世界", 3000)
      assert.ok(content.includes("你好世界"), `应看到中文，实际: ${content.trim()}`)
    })

    it("注入多行文本，同时验证两行内容", async () => {
      const result = await terminal.spawn("cat")
      createdSessions.push(result.sessionId)
      await waitForContent(result.sessionId, "", 500) // 等 cat 就绪

      const line1 = `LINE1_${Date.now()}`
      const line2 = `LINE2_${Date.now()}`
      const multiline = `${line1}\n${line2}`
      const ok = await terminal.inject(result.sessionId, multiline)
      assert.ok(ok, "inject 多行应返回 true")

      // 同时验证 line1 和 line2（#5 审查意见）
      const content = await waitForContent(result.sessionId, line2, 3000)
      assert.ok(content.includes(line1), `应看到第一行，实际: ${content.trim()}`)
      assert.ok(content.includes(line2), `应看到第二行，实际: ${content.trim()}`)
    })

    it("inject 到不存在的 session 返回 false", async () => {
      const ok = await terminal.inject("nonexistent-session-12345", "hello")
      assert.equal(ok, false, "inject 到不存在的 session 应返回 false")
    })

    // 新增：快速连续 inject（#8 审查意见）
    it("快速连续 inject 3 条消息，内容全部出现", async () => {
      const result = await terminal.spawn("cat")
      createdSessions.push(result.sessionId)
      await waitForContent(result.sessionId, "", 500) // 等 cat 就绪

      const m1 = `RAPID1_${Date.now()}`
      const m2 = `RAPID2_${Date.now()}`
      const m3 = `RAPID3_${Date.now()}`

      await terminal.inject(result.sessionId, m1)
      await terminal.inject(result.sessionId, m2)
      await terminal.inject(result.sessionId, m3)

      const content = await waitForContent(result.sessionId, m3, 3000)
      assert.ok(content.includes(m1), `应看到第 1 条: ${m1}`)
      assert.ok(content.includes(m2), `应看到第 2 条: ${m2}`)
      assert.ok(content.includes(m3), `应看到第 3 条: ${m3}`)
    })

    /**
     * 不变式守护：inject 必须在 paste-buffer 之后显式 send-keys Enter 触发提交。
     *
     * 背景：Claude Code TUI（以及普通 shell 对 paste 的处理）把 paste 进来的字符堆在
     * 输入行，不会自动执行。必须 tmux send-keys -t <sess> Enter 才能让 shell/TUI 提交。
     * 如果谁删掉 tmux.ts 里那行 send-keys Enter，静态测试不会察觉——这条测试就是给
     * 那行代码做守护。
     *
     * 判别法：注入一条 shell 命令去 touch 一个唯一 marker 文件。如果 Enter 真触发了，
     * 文件会被 shell 执行命令时创建；如果只 paste 不 send-keys，文本只是堆在输入行，
     * shell 从未见过回车，touch 永远不会执行 → 文件不存在。
     *
     * 用 bash -l（非交互 login shell 会吃 rc 文件 bracketed-paste 设置，导致 paste
     * 单独不执行），既排除 cat 那类 echo-back 干扰，又排除 shell 自己对 paste 换行的
     * 解释差异。
     *
     * 手动验证（#trust-but-verify）：把 tmux.ts 里 `send-keys ... Enter` 那行注释掉，
     * 跑这条测试，断言会红（marker 文件不会被创建）。改回来 → 绿。
     */
    it("inject 之后 send-keys Enter 真的触发了命令执行（Enter 守护）", async () => {
      const markerFile = join(tmpdir(), `mesh-inject-enter-guard-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      // 预防：先确保文件不存在
      try { unlinkSync(markerFile) } catch {}
      assert.ok(!existsSync(markerFile), "前置：marker 文件不应存在")

      // tmux.ts inject 现在显式包 \e[200~...\e[201~（bracketed-paste markers），
      // 让 BPM-aware TUI（claude/codex/zsh/bash 4+）把整段当一次 paste 处理。
      // 不能用 mac 默认的 bash 3.2 跑这个测——它不识别 BPM markers，会把 \e[
      // 当字面字符插进命令行，bash 报"command not found"。换 zsh：mac 原生
      // zsh 5.x 走 readline，能正确剥掉 BPM markers 并把内层文本当用户输入。
      const result = await terminal.spawn("zsh -f")  // -f = 跳过 .zshrc，干净 shell
      createdSessions.push(result.sessionId)
      // 等 zsh 就绪（提示符稳定）
      await new Promise((r) => setTimeout(r, 800))

      // inject 一条 touch 命令——没有尾部换行
      // 如果 tmux.ts 正常 send-keys Enter → shell 收到回车执行 touch → 文件出现
      // 如果没有 send-keys Enter → 字符只停在输入行，touch 永不执行 → 文件永不出现
      const cmd = `touch ${markerFile}`
      const ok = await terminal.inject(result.sessionId, cmd)
      assert.ok(ok, "inject 应返回 true")

      // 轮询等文件出现（最多 3s）
      const start = Date.now()
      while (Date.now() - start < 3000) {
        if (existsSync(markerFile)) break
        await new Promise((r) => setTimeout(r, 100))
      }

      const created = existsSync(markerFile)
      // 清理（幂等）
      try { unlinkSync(markerFile) } catch {}

      assert.ok(
        created,
        `marker 文件 ${markerFile} 应已被创建——说明 Enter 真触发了命令执行。` +
        `如果此处断言失败，检查 TmuxTerminal.inject 是否去掉了 send-keys Enter。`,
      )
    })

    /**
     * TUI 类竞态守护：
     * 某些交互式 TUI（这次联调的 Codex 就像这样）会把 paste 和 submit 分成两个阶段。
     * 如果 paste-buffer 后立刻 send-keys Enter，回车可能在 TUI 仍处于 paste/input 态时
     * 被吞掉；人工再按一次 Enter 又能提交，说明问题更像时序而不是“tmux 发不进回车”。
     *
     * 这里用一个最小 fake TUI 模拟这种行为：
     * - 看到普通字符后，记录最后一个字符到达时间
     * - 只有在 Enter 距离最后一个普通字符 >= 80ms 时，才认为这是一次有效 submit
     *
     * 如果未来有人把 tmux.ts 里的等待删掉，这条测试会红。
     */
    /**
     * 老版 claude TUI（2.1.78 等）的 first-Enter-drop 守护：
     *
     * 现象：paste-buffer + 100ms + send-keys Enter，TUI 仍在消化 paste，首个 Enter 被吞，
     * 文本停在输入行不提交；同样的代码在 2.1.116+ 上没问题。inject() 因此加了"提交自检 +
     * 补 Enter"逻辑——hasUnsubmittedPrompt 看 ❯ 后是否有残留，有就再 send-keys Enter。
     *
     * 这条测试用 node 起一个 fake TUI：
     *   - 启动时输出 `❯ ` 提示符
     *   - 普通字符 echo 出来（让 capture-pane 看到 ❯ 后有残留）
     *   - 第一次 Enter 故意忽略；第二次 Enter 才写 marker 文件并退出
     * 如果 inject() 自检逻辑被删，第二次 Enter 永远不来，marker 文件永不出现 → 测试红。
     */
    it("inject 检测到 ❯ 后未清空,自动补 Enter（first-Enter-drop 守护）", async () => {
      const markerFile = join(tmpdir(), `mesh-inject-retry-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      try { unlinkSync(markerFile) } catch {}
      assert.ok(!existsSync(markerFile), "前置:marker 文件不应存在")

      const script = [
        'const fs=require("node:fs");',
        `const out=${JSON.stringify(markerFile)};`,
        'process.stdout.write("\\u276f ");',  // 输出 ❯ 提示符
        "let enterCount=0;",
        "let inEsc=false;",
        "process.stdin.setRawMode(true);",
        "process.stdin.resume();",
        'process.stdin.on("data",(chunk)=>{',
        "  for (const byte of chunk) {",
        "    const ch=String.fromCharCode(byte);",
        "    if (inEsc) {",
        '      if (/[a-zA-Z~]/.test(ch)) inEsc=false;',  // ESC 序列吃掉
        "      continue;",
        "    }",
        '    if (ch === "\\x1b") { inEsc=true; continue; }',
        '    if (ch === "\\r" || ch === "\\n") {',
        "      enterCount++;",
        "      if (enterCount >= 2) {",
        '        fs.writeFileSync(out, "ok", "utf-8");',
        "        process.exit(0);",
        "      }",
        // 第一次 Enter 故意吞:不写 newline,文本残留在 ❯ 后
        '    } else if (ch >= " ") {',
        "      process.stdout.write(ch);",  // 普通字符 echo 出来,让 capture-pane 看到残留
        "    }",
        "  }",
        "});",
      ].join("")

      const result = await terminal.spawn(`node -e '${script}'`)
      createdSessions.push(result.sessionId)
      await new Promise((r) => setTimeout(r, 600))

      const text = `RETRY_GUARD_${Date.now()}`
      const ok = await terminal.inject(result.sessionId, text)
      assert.ok(ok, "inject 应返回 true")

      // 等 marker 文件出现（最长等 4s——retry loop 总延迟约 800ms*2=1.6s）
      const start = Date.now()
      while (Date.now() - start < 4000) {
        if (existsSync(markerFile)) break
        await new Promise((r) => setTimeout(r, 100))
      }

      const created = existsSync(markerFile)
      try { unlinkSync(markerFile) } catch {}

      assert.ok(
        created,
        `marker 文件 ${markerFile} 应已被创建——说明 inject 自检后补发了第二次 Enter。` +
        `如果此处断言失败，检查 TmuxTerminal.inject 是否保留了 hasUnsubmittedPrompt 自检 + retry。`,
      )
    })

    it("inject 会在 paste 后稍等再 send-keys Enter（TUI race 守护）", async () => {
      const markerFile = join(tmpdir(), `mesh-inject-tui-race-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      try { unlinkSync(markerFile) } catch {}
      assert.ok(!existsSync(markerFile), "前置：marker 文件不应存在")

      const script = [
        'const fs=require("node:fs");',
        `const out=${JSON.stringify(markerFile)};`,
        "let lastCharAt=0;",
        "let seenText=false;",
        "process.stdin.setRawMode(true);",
        "process.stdin.resume();",
        'process.stdin.on("data",(chunk)=>{',
        "  for (const byte of chunk) {",
        "    const ch=String.fromCharCode(byte);",
        '    if (ch === "\\r" || ch === "\\n") {',
        '      if (seenText && Date.now() - lastCharAt >= 80) {',
        '        fs.writeFileSync(out, "ok", "utf-8");',
        "        process.exit(0);",
        "      }",
        "    } else {",
        "      seenText = true;",
        "      lastCharAt = Date.now();",
        "    }",
        "  }",
        "});",
      ].join("")

      const result = await terminal.spawn(`node -e '${script}'`)
      createdSessions.push(result.sessionId)
      await new Promise((r) => setTimeout(r, 600))

      const ok = await terminal.inject(result.sessionId, `TUI_RACE_${Date.now()}`)
      assert.ok(ok, "inject 应返回 true")

      const start = Date.now()
      while (Date.now() - start < 3000) {
        if (existsSync(markerFile)) break
        await new Promise((r) => setTimeout(r, 100))
      }

      const created = existsSync(markerFile)
      try { unlinkSync(markerFile) } catch {}

      assert.ok(
        created,
        `marker 文件 ${markerFile} 应已被创建——说明 inject 对 TUI 类竞态留出了提交窗口。`,
      )
    })
  })

  // ===== isAlive =====

  describe("isAlive", () => {
    it("spawn 后返回 true", async () => {
      const result = await terminal.spawn("sleep 30")
      createdSessions.push(result.sessionId)

      const alive = await terminal.isAlive(result.sessionId)
      assert.equal(alive, true, "刚 spawn 的 session 应 alive")
    })

    it("kill session 后返回 false", async () => {
      const result = await terminal.spawn("sleep 30")
      createdSessions.push(result.sessionId)

      // 直接用 tmux kill
      killSession(result.sessionId)

      const alive = await terminal.isAlive(result.sessionId)
      assert.equal(alive, false, "kill 后应返回 false")
    })

    it("不存在的 session 返回 false", async () => {
      const alive = await terminal.isAlive("totally-fake-session-99999")
      assert.equal(alive, false, "不存在的 session 应返回 false")
    })
  })

  // ===== close =====

  describe("close", () => {
    it("close 后 session 不存在", async () => {
      const result = await terminal.spawn("sleep 30")
      createdSessions.push(result.sessionId) // #1 审查意见：close 测试也要 push，afterEach 幂等

      assert.ok(sessionExists(result.sessionId), "close 前 session 应存在")
      await terminal.close(result.sessionId)
      assert.ok(!sessionExists(result.sessionId), "close 后 session 应不存在")
    })

    it("close 不存在的 session 不报错", async () => {
      // 应该不抛异常
      await terminal.close("nonexistent-session-close-test")
    })

    // 新增：close 后再 inject 返回 false（#9 审查意见）
    it("close 后再 inject 返回 false", async () => {
      const result = await terminal.spawn("sleep 30")
      createdSessions.push(result.sessionId)

      await terminal.close(result.sessionId)
      const ok = await terminal.inject(result.sessionId, "should-fail")
      assert.equal(ok, false, "close 后 inject 应返回 false")
    })
  })

  // ===== 隔离哨兵（回归用，直接对着 2026-08-28 那次通杀事故）=====

  describe("隔离哨兵：生产 tmux server 上的 mesh-* session 必须毫发无伤", () => {
    // 两类哨兵，分别对应事故里真实被杀掉的两种东西：
    //   A 类 = 普通席位，名字形如 mesh-<ts36>-<rand4>（真席位就长这样）
    //   B 类 = relay 自己，名字形如 mesh-relay*（它的 pane 里跑的就是 relay 进程本体）
    // 只要哪天有人把防线①拆了、或者把清理改回前缀扫，这两个都会当场消失。
    const sentinels = [
      `mesh-${Date.now().toString(36)}-snt1`, // A 类：仿真席位名
      `mesh-relay-sentinel-${process.pid}`, // B 类：仿 relay 名
    ]

    function prodTmux(args: string[]): string {
      return execFileSync("tmux", args, {
        timeout: 3000,
        encoding: "utf-8",
        env: productionServerEnv(), // ← 故意打生产 server
      })
    }

    function prodSessionExists(name: string): boolean {
      try {
        prodTmux(["has-session", "-t", name])
        return true
      } catch {
        return false
      }
    }

    /**
     * 真 relay 存活哨兵。仿真哨兵证明的是「清理逻辑不越界」，
     * 这条证明的是**当场那个真的、正跑着的 relay** 没被碰 —— 事故里死的就是它。
     *
     * 判据取 pid + **启动时刻**两样。只看「pid 还在」不够：进程可能被杀了又被
     * 看门狗拉起来，pid 甚至可能复用，看上去一切正常，实际席位全丢了一轮。
     * 启动时刻变了 = 被重启过 = 出事了。
     *
     * relay 没跑（CI、干净机器）时跳过——这是**环境不具备**，不是通过。
     */
    it("真 relay 进程全程没被重启（pid + 启动时刻两端量）", (t) => {
      const pidFile = join(process.env.HOME ?? "", ".ccmesh", "relay.pid")
      if (!existsSync(pidFile)) {
        t.skip("本机没有 ~/.ccmesh/relay.pid，relay 未运行——环境不具备，不算通过")
        return
      }
      const pid = readFileSync(pidFile, "utf-8").trim()

      const startedAt = (): string | null => {
        try {
          return execFileSync("ps", ["-p", pid, "-o", "lstart="], {
            timeout: 3000,
            encoding: "utf-8",
          }).trim()
        } catch {
          return null // 进程不在了
        }
      }

      const before = startedAt()
      if (before === null) {
        t.skip(`relay.pid=${pid} 对应的进程本来就不在——环境不具备，不算通过`)
        return
      }

      // 触发本文件的清理路径（跟仿真哨兵同一个动作）
      killTrackedSessions()

      const after = startedAt()
      assert.notEqual(after, null, `🔴 relay 进程 (pid=${pid}) 在集成测试期间消失了 —— 正是 2026-08-28 事故的形态`)
      assert.equal(
        after,
        before,
        `🔴 relay 进程 (pid=${pid}) 的启动时刻变了（${before} → ${after}）—— 它被杀掉后重启过。` +
          "pid 相同不代表没出事：看门狗会把它拉回来，但那一轮的席位已经全丢了。",
      )
    })

    it("跑完整轮集成测试后，生产 server 上的仿真席位与仿 relay session 都还在", () => {
      // 建哨兵（在生产 server 上）
      for (const name of sentinels) {
        prodTmux(["new-session", "-d", "-s", name, "sleep 120"])
      }
      try {
        for (const name of sentinels) {
          assert.ok(prodSessionExists(name), `哨兵 ${name} 建好后应存在`)
        }

        // 触发本文件的两个清理路径。若任何一个越界打到生产 server，哨兵就没了。
        killTrackedSessions()

        for (const name of sentinels) {
          assert.ok(
            prodSessionExists(name),
            `🔴 哨兵 ${name} 被清理逻辑误杀 —— 隔离已失效，` +
              `这正是 2026-08-28 把全机席位连同 relay 一起打死的那个形态`,
          )
        }

        // 顺带证明隔离确实是双向的：隔离 server 看不见生产 server 的哨兵。
        for (const name of sentinels) {
          assert.ok(
            !sessionExists(name),
            `隔离 server 不应看得见生产 server 的 ${name}（看得见 = 根本没隔离，两边是同一个 server）`,
          )
        }
      } finally {
        // 哨兵是我们建在别人家里的，必须收干净（按精确名字，不扫）
        for (const name of sentinels) {
          try {
            prodTmux(["kill-session", "-t", name])
          } catch {
            // 已经不在了
          }
        }
      }
    })
  })

  // ===== getCurrentSession =====

  describe("getCurrentSession", () => {
    // 拆分为两个 test（#4 审查意见）
    it("非 tmux 环境返回 null", { skip: !!process.env.TMUX_PANE && "当前在 tmux 内，跳过" }, async () => {
      const session = await terminal.getCurrentSession()
      assert.equal(session, null, "不在 tmux 内应返回 null")
    })

    it("tmux 内环境返回有效 session", { skip: !process.env.TMUX_PANE && "当前不在 tmux 内，跳过" }, async () => {
      const session = await terminal.getCurrentSession()
      assert.ok(session, "在 tmux 内应返回非 null")
      assert.ok(session!.sessionId, "应返回 sessionId")
    })
  })
})
