/**
 * 敌意环境 E2E —— 在「父进程带着一个指向真实 tmux server 的 $TMUX」这种最危险的场景下，
 * 验证 tmux.integration.test.ts 的隔离仍然守得住。
 *
 * 为什么非要有这一条：
 *   TMUX_TMPDIR 单独用是**顶不住 $TMUX 的**。实测（命令级证据）：
 *     TMUX=<某 server>,pid,0  TMUX_TMPDIR=<隔离目录>  tmux new-session …
 *     → 会话落在 $TMUX 指的那个 server 上，隔离目录连创建都没创建。
 *   而 **mesh 席位本身就是 tmux pane**，席位里 $TMUX 天然指着生产 server。
 *   也就是说：最可能跑这套测试的地方，恰恰是隔离最容易失效的地方。
 *
 *   集成测试自己是在模块加载时 delete process.env.TMUX 的 —— 那段代码只在
 *   「进程启动时 env 里真有 TMUX」时才起作用，而正常开发机上根本没有。
 *   所以不造一个敌意父环境，那行 delete 是**永远不会被执行到的死代码**，
 *   出没出错谁也不知道。这个文件就是去把它执行到。
 *
 * 做法：起一个专用 -L 哨兵 server（不碰真生产），把它的 socket 拼成 $TMUX 传给子进程，
 * 子进程跑真集成测试的一个子集，跑完核对哨兵的 session / server pid / 启动时刻三样都没变。
 */
import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"

// 哨兵 server 用独立 socket 名，绝不落到默认 server 上 —— 这个文件自己也要守规矩。
const SENTINEL_SOCKET_NAME = `mesh-hostile-sentinel-${process.pid}`
const SENTINEL_SESSION = "hostile-parent-sentinel"

/** 被测目标：编译后的集成测试。找不到就红，不静默跳过。 */
const INTEGRATION_TEST_JS = join(__dirname, "tmux.integration.test.js")

let tmuxAvailable = false
try {
  execFileSync("tmux", ["-V"], { timeout: 3000 })
  tmuxAvailable = true
} catch {
  // tmux not available
}

function sentinelTmux(args: string[]): string {
  return execFileSync("tmux", ["-L", SENTINEL_SOCKET_NAME, ...args], {
    timeout: 5000,
    encoding: "utf-8",
  })
}

function killSentinelServer(): void {
  try {
    sentinelTmux(["kill-server"])
  } catch {
    // 本来就没起
  }
}

describe(
  "敌意环境 E2E：父进程带着指向真实 server 的 $TMUX",
  { skip: !tmuxAvailable && "tmux not available" },
  () => {
    let sentinelSocketPath = ""
    let sentinelServerPid = ""

    before(() => {
      killSentinelServer()
      sentinelTmux(["new-session", "-d", "-s", SENTINEL_SESSION, "sleep 300"])
      sentinelServerPid = sentinelTmux(["display-message", "-p", "#{pid}"]).trim()
      // tmux 的 socket 落点：$TMUX_TMPDIR（缺省 /tmp）/tmux-<uid>/<socket 名>
      const tmpdir = process.env.TMUX_TMPDIR || "/tmp"
      sentinelSocketPath = join(tmpdir, `tmux-${process.getuid?.() ?? 0}`, SENTINEL_SOCKET_NAME)
    })

    after(() => {
      killSentinelServer()
    })

    it("哨兵 server 起得来，且 $TMUX 拼得出真实 socket 路径", () => {
      assert.ok(sentinelServerPid, "拿不到哨兵 server 的 pid")
      assert.ok(
        existsSync(sentinelSocketPath),
        `拼出来的 socket 路径不存在：${sentinelSocketPath}。` +
          "路径拼错的话，下面那条 E2E 会因为 $TMUX 无效而**假绿**——它测不到任何东西。",
      )
      assert.ok(existsSync(INTEGRATION_TEST_JS), `找不到被测目标 ${INTEGRATION_TEST_JS}（先 build）`)
    })

    it("子进程带着敌意 $TMUX 跑集成测试，哨兵 server 的 session/pid/启动时刻三样都不变", () => {
      const startedAt = (): string | null => {
        try {
          return execFileSync("ps", ["-p", sentinelServerPid, "-o", "lstart="], {
            timeout: 3000,
            encoding: "utf-8",
          }).trim()
        } catch {
          return null
        }
      }

      const beforeStart = startedAt()
      assert.ok(beforeStart, "哨兵 server 进程在跑之前就不在了")

      // 这就是最危险的形态：$TMUX 指向一个真实存在的 server（站位「生产」）。
      // 若集成测试没有 delete TMUX，它建的每个 session 都会落到这个 server 上，
      // 而它的 kill-server 会把这个 server 整个掀掉 —— 哨兵会当场消失。
      const hostileEnv: NodeJS.ProcessEnv = {
        ...process.env,
        TMUX: `${sentinelSocketPath},${sentinelServerPid},0`,
        TMUX_PANE: "%0",
      }

      // 🔴 必须清掉。本文件自己是被 `node --test` 跑起来的，node 会给测试进程注入
      //   NODE_TEST_CONTEXT=child-v8。{...process.env} 会把它一路传给孙进程，
      //   于是孙进程的 node:test 判定「已经在测试上下文里了」，打一句
      //     Warning: node:test run() is being called recursively … skipping running files
      //   然后**一个测试都不跑、退出码 0**。
      //
      //   这个坑第一次就真的踩了：本用例曾在注入了漏洞的代码上**报绿**——
      //   子进程 55ms 就返回（真跑要 27s），什么都没执行，于是哨兵当然毫发无伤。
      //   一条测不到东西的测试，比没有测试更坏：它会让人以为验过了。
      delete hostileEnv.NODE_TEST_CONTEXT

      const child = spawnSync(
        process.execPath,
        ["--test", "--test-reporter=tap", INTEGRATION_TEST_JS],
        { env: hostileEnv, encoding: "utf-8", timeout: 180_000 },
      )
      const childOut = `${child.stdout ?? ""}${child.stderr ?? ""}`

      // ── 先证「子进程真的跑了」，再谈它的结论 ──
      // 少了这一步，下面所有关于哨兵的断言都可能是在为一个空转的子进程作证。
      assert.doesNotMatch(
        childOut,
        /being called recursively/,
        "🔴 子进程被 node 判定为递归测试上下文，一个用例都没跑（NODE_TEST_CONTEXT 泄漏）。" +
          "此时哨兵当然安然无恙——但这条 E2E 什么都没验到。",
      )
      const passMatch = childOut.match(/^# pass (\d+)$/m)
      assert.ok(passMatch, `🔴 子进程输出里找不到 TAP 汇总行，它多半没真跑：\n${childOut.slice(0, 1500)}`)
      assert.ok(
        Number(passMatch![1]) >= 5,
        `🔴 子进程只跑了 ${passMatch![1]} 个用例（期望 ≥5）。空转的子进程会让本用例假绿。`,
      )

      // 先核对哨兵——这才是本用例真正要证的东西。子进程红不红是次要的。
      const afterStart = startedAt()
      assert.notEqual(
        afterStart,
        null,
        `🔴 哨兵 server (pid=${sentinelServerPid}) 被子进程干掉了 —— ` +
          "隔离在带 $TMUX 的环境下失效，这正是席位里跑测试会重演事故的那条路径",
      )
      assert.equal(
        afterStart,
        beforeStart,
        `🔴 哨兵 server 启动时刻变了（${beforeStart} → ${afterStart}），它被重启过`,
      )

      const sessions = (() => {
        try {
          return sentinelTmux(["list-sessions", "-F", "#{session_name}"])
        } catch {
          return ""
        }
      })()
      assert.ok(
        sessions.includes(SENTINEL_SESSION),
        `🔴 哨兵 session ${SENTINEL_SESSION} 不见了。哨兵 server 上现有：${JSON.stringify(sessions)}`,
      )
      // 反过来也要查：集成测试建的 session 一个都不该出现在这里。
      assert.ok(
        !sessions.includes("mesh-"),
        `🔴 哨兵 server 上出现了 mesh-* session：${JSON.stringify(sessions)}。` +
          "说明集成测试的 spawn 打到了 $TMUX 指的 server 上，隔离没生效。",
      )

      // 哨兵没事之后，才要求子进程本身也是绿的。
      assert.equal(
        child.status,
        0,
        `子进程集成测试未通过（status=${child.status}）：\n${(child.stdout ?? "").slice(-3000)}\n${(child.stderr ?? "").slice(-2000)}`,
      )
    })
  },
)
