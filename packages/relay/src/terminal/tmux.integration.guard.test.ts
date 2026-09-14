/**
 * tmux 集成测试的**静态守卫** —— 不起 tmux，纯读源码。
 *
 * 为什么要有它：tmux.integration.test.ts 的隔离一旦被拆掉，代价是**全机 mesh 席位
 * 连同 relay 本体被杀光**（2026-08-28 真实发生过）。那种失效没有安全的观测窗口——
 * 等你发现的时候，能告诉你出事的那些进程已经死了。
 * 所以守卫必须在**不执行**被守护代码的前提下成立，只能读源码。
 *
 * 三条不变量，破一条就红：
 *   ① 集成测试必须在模块级把 TMUX_TMPDIR 指向隔离目录（服务器级隔离）
 *   ② 集成测试里不许出现「列会话 + 前缀匹配 + kill」这个组合（通杀事故的原句）
 *   ③ kill-server 只允许出现在隔离收尾函数里，不得散落别处
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

/**
 * 守卫读的是 **.ts 源码**，但它自己是从 dist/ 跑的（tsc → CommonJS，所以这里用 __dirname
 * 而不是 import.meta.url）。两个位置都试：
 *   dist/terminal/  → ../../src/terminal/tmux.integration.test.ts
 *   src/terminal/   → ./tmux.integration.test.ts（将来若改用 tsx 直跑源码）
 * 找不到就**报错而不是跳过**——守卫静默跳过等于没有守卫。
 */
function resolveIntegrationSourcePath(): string {
  const candidates = [
    join(__dirname, "..", "..", "src", "terminal", "tmux.integration.test.ts"),
    join(__dirname, "tmux.integration.test.ts"),
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  throw new Error(
    `静态守卫找不到 tmux.integration.test.ts（试过：${candidates.join(" | ")}）。` +
      "文件被移动或改名了 —— 请同步修这里的路径，别让守卫悄悄失效。",
  )
}

function readIntegrationSource(): string {
  return readFileSync(resolveIntegrationSourcePath(), "utf-8")
}

/** 去掉块注释与行注释——不变量说的是**代码**，注释里出现这些词是正常的（本文件就写了一堆）。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
}

/**
 * 两条禁用形状，提成常量供「规则」和「阳性对照」共用 —— 两处各写一份的话，
 * 改了规则忘了改对照，对照就变成在考另一个不存在的规则。
 *
 * ⚠️ `kill[-_]?[Ss]ession` 的这个可选连字符不是凑数：事故原句里调的是驼峰的
 *    `killSession(name)`，第一版规则写死 `kill-session`（带连字符），**根本匹配不上事故原句**。
 *    是下面那个阳性对照把它揪出来的。
 */
const BANNED_PREFIX_THEN_KILL = /startsWith\(\s*["'`]mesh-[\s\S]{0,200}?kill/
const BANNED_ENUMERATE_THEN_KILL = /list-sessions[\s\S]{0,400}?kill[-_]?[Ss]ession/

describe("tmux 集成测试的隔离守卫（静态）", () => {
  it("① 必须在模块级把 TMUX_TMPDIR 指向隔离目录", () => {
    const code = stripComments(readIntegrationSource())

    assert.match(
      code,
      /process\.env\.TMUX_TMPDIR\s*=/,
      "集成测试必须给 process.env.TMUX_TMPDIR 赋值——这是让生产代码自己发出的 tmux 调用" +
        "也落进隔离 server 的唯一手段（tmux.ts 的 execFile 不传 env，继承 process.env）",
    )
    assert.match(
      code,
      /mkdtempSync\(/,
      "隔离目录必须是 mkdtempSync 现开的，不能是写死路径（写死会和并发跑的另一个进程撞同一个 server）",
    )

    // 赋值必须发生在**第一次调用 tmux 之前**，否则前面那几条已经打到生产 server 上了。
    const assignAt = code.search(/process\.env\.TMUX_TMPDIR\s*=/)
    const firstTmuxAt = code.search(/execFileSync\(\s*["']tmux["']/)
    assert.ok(assignAt >= 0, "找不到 TMUX_TMPDIR 赋值")
    assert.ok(firstTmuxAt >= 0, "找不到任何 tmux 调用，守卫的前提变了，请复核本文件")
    assert.ok(
      assignAt < firstTmuxAt,
      `TMUX_TMPDIR 的赋值（偏移 ${assignAt}）必须早于第一次 tmux 调用（偏移 ${firstTmuxAt}）——` +
        "晚一行，那一行就打在生产 server 上了",
    )
  })

  it("①b 必须 delete process.env.TMUX，且同样早于第一次 tmux 调用", () => {
    const code = stripComments(readIntegrationSource())

    // 只设 TMUX_TMPDIR 顶不住 $TMUX —— 实测过：带着 $TMUX 建的会话落在 $TMUX 指的 server 上，
    // 隔离目录连创建都没创建。而 mesh 席位本身就是 tmux pane，席位里 $TMUX 天然指着生产 server。
    // ⇒ 最可能跑这套测试的地方，恰恰是隔离最容易失效的地方。这条不是洁癖，是主路径。
    assert.match(
      code,
      /delete\s+process\.env\.TMUX\b/,
      "🔴 没有 delete process.env.TMUX。$TMUX 压过 TMUX_TMPDIR（实测），" +
        "在 tmux pane 里跑（比如任何一个 mesh 席位）隔离就整个失效。",
    )

    const deleteAt = code.search(/delete\s+process\.env\.TMUX\b/)
    const firstTmuxAt = code.search(/execFileSync\(\s*["']tmux["']/)
    assert.ok(deleteAt >= 0 && firstTmuxAt >= 0, "找不到 delete TMUX 或 tmux 调用，守卫前提变了，请复核")
    assert.ok(
      deleteAt < firstTmuxAt,
      `delete process.env.TMUX（偏移 ${deleteAt}）必须早于第一次 tmux 调用（偏移 ${firstTmuxAt}）——` +
        "晚一行，那一行就打在 $TMUX 指的 server 上了",
    )

    // 删了就得还，否则同进程里后面的测试文件会拿到被改过的 env。
    assert.match(
      code,
      /ORIGINAL_TMUX\b/,
      "delete 了 TMUX 却没把原值留住 —— env 是进程级的，同进程里还有别的测试文件要跑",
    )
  })

  it("② 不许出现「列会话 → 前缀匹配 → kill」这个组合", () => {
    const code = stripComments(readIntegrationSource())

    // 事故原句：list-sessions 拿到全量 → startsWith("mesh-") 挑 → kill。
    //
    // ⚠️ 这条规则**故意收窄**过。第一版直接禁掉 `startsWith("mesh-")` 整个字符串，
    //   结果误伤了 spawn 用例里那句完全正当的断言：
    //     assert.ok(result.sessionId.startsWith("mesh-"), "sessionId 应以 mesh- 开头")
    //   —— 它在检查命名约定，一个 session 都不会杀。
    //   一条老喊狼的守卫，下一个被它挡住的人会直接把它删掉，那才是真正的失守。
    //   所以判据从「出现前缀匹配」改成「**前缀匹配挨着 kill**」和「**枚举挨着 kill**」。
    assert.doesNotMatch(
      code,
      BANNED_PREFIX_THEN_KILL,
      '🔴 startsWith("mesh-") 紧挨着 kill —— 真席位名就是 mesh-<ts36>-<rand4>，relay 自己是 mesh-relay，' +
        "按这个前缀杀等于把全机席位和 relay 一起打死。清理只能按精确清单。",
    )
    assert.doesNotMatch(
      code,
      BANNED_ENUMERATE_THEN_KILL,
      "🔴 列会话与 kill 出现在同一段逻辑里——这就是「扫一遍把漏网的都清掉」的形状。" +
        "测试没有资格枚举它没创建过的 session。",
    )
  })

  /**
   * 阳性对照 —— 守卫自己的守卫。
   *
   * 规则②被收窄过（见上）。收窄是对的，但收窄有个失败模式：**窄到再也抓不住任何东西**，
   * 于是它天天绿着，人人放心，直到事故重演。
   * 所以这里把 2026-08-28 的事故原句原样留下，断言判据**必须**对它报红。
   * 以后谁再调这两条正则，这个用例会立刻告诉他调过头了。
   */
  it("判据对 2026-08-28 的事故原句仍然报红（防止把规则收窄成摆设）", () => {
    const HISTORICAL_ACCIDENT_SNIPPET = `
      function cleanupAllMeshSessions(): void {
        try {
          const output = execFileSync("tmux", ["list-sessions", "-F", "#{session_name}"], {
            timeout: 3000,
            encoding: "utf-8",
          })
          for (const name of output.trim().split("\\n")) {
            if (name.startsWith("mesh-")) {
              killSession(name)
            }
          }
        } catch {}
      }
    `

    assert.match(
      HISTORICAL_ACCIDENT_SNIPPET,
      BANNED_PREFIX_THEN_KILL,
      "判据①已经抓不住事故原句了——规则被收窄过头，等于没有守卫",
    )
    assert.match(
      HISTORICAL_ACCIDENT_SNIPPET,
      BANNED_ENUMERATE_THEN_KILL,
      "判据②已经抓不住事故原句了——规则被收窄过头，等于没有守卫。" +
        "（第一版就栽在这里：事故原句调的是驼峰 killSession，规则却写死了带连字符的 kill-session）",
    )

    // 反过来也要对：正当写法不该被判红，否则守卫会因为老误报而被人删掉。
    const LEGITIMATE_SNIPPET = `
      assert.ok(result.sessionId.startsWith("mesh-"), "sessionId 应以 mesh- 开头")
    `
    assert.doesNotMatch(
      LEGITIMATE_SNIPPET,
      BANNED_PREFIX_THEN_KILL,
      "判据把「断言命名约定」也判红了——误报会让守卫被删，等同失守",
    )
  })

  it("③ kill-server 只能出现在隔离收尾里，且必须有隔离目录兜底", () => {
    const code = stripComments(readIntegrationSource())
    const killServerCount = (code.match(/["']kill-server["']/g) ?? []).length

    assert.ok(
      killServerCount <= 1,
      `kill-server 出现了 ${killServerCount} 次。它只该在 teardownIsolatedServer() 里出现一次；` +
        "散落别处意味着有人在不确定打哪个 server 的地方掀桌子",
    )
    if (killServerCount === 1) {
      assert.match(
        code,
        /function\s+teardownIsolatedServer[\s\S]{0,600}?kill-server/,
        "kill-server 必须写在 teardownIsolatedServer() 内——它安全的前提是「此刻 TMUX_TMPDIR 指着隔离目录」，" +
          "换个地方调用这个前提就不成立了",
      )
    }
  })

  it("④ 集成测试里根本不许出现 list-sessions（连隔离 server 上都不许）", () => {
    const code = stripComments(readIntegrationSource())

    // 有了 TMUX_TMPDIR 隔离，在隔离 server 上 list-sessions 其实是安全的。
    // 仍然一刀切禁掉，理由是**纵深**：隔离一旦失效，list-sessions 就是通杀的第一步。
    // 禁掉这一步，等于在隔离之外再加一道「就算隔离没了也伤不到人」的保险。
    // 集成测试要判断某个 session 在不在，用 has-session（点名问），不用 list-sessions（枚举）。
    assert.doesNotMatch(
      code,
      /list-sessions/,
      "🔴 集成测试里出现了 list-sessions。要判断某个 session 存不存在，用 has-session 点名问；" +
        "枚举全量是通杀的第一步，这里不需要它。",
    )
  })

  it("哨兵用例仍在（它是隔离失效时唯一的运行时报警）", () => {
    const code = readIntegrationSource()
    assert.match(
      code,
      /productionServerEnv\(\)/,
      "哨兵用例要故意打生产 server 来证明「我们没碰它」，靠的就是 productionServerEnv()",
    )
    assert.match(code, /隔离哨兵/, "隔离哨兵 describe 块被删了——静态守卫挡不住运行时才暴露的失效形态")
  })
})
