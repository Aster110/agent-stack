/**
 * Lane C —— 进程层单测（先红后绿）。
 *
 * 这一层的全部价值是**别杀错人**：
 *   - ChatGPT.app 自己的 app-server 命令行与我们的基线参数逐字重合
 *     （实测 2026-09-02 computer2：`/Applications/ChatGPT.app/Contents/Resources/codex app-server --listen stdio://`），
 *     所以「命令行含 app-server」这个谓词会直接误杀用户正在用的 ChatGPT。
 *   - kill 掉 npm wrapper 不杀 rust 本体（实测本体 ppid 变 1 成孤儿），所以只能杀进程组。
 *   - `kill(-pgid)` 打到自己所在的进程组 = 自杀（写这套时真的自杀过一次，exit 144）。
 *
 * 谓词的阳性对照（"这把尺子量得出东西"）在 e2e E08 里用真 app-server 做；
 * 这里用实测抓下来的真实命令行字符串做定型。
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  parsePsTable,
  type ProcInfo,
  type SysProcOps,
} from "./ops.js"
import {
  SEAT_TAG_KEY,
  seatTag,
  seatTagArgs,
  isOurAppServerCmd,
  findOrphans,
} from "./orphans.js"
import {
  parsePidFile,
  serializePidFile,
  checkPidFile,
  type PidFileRecord,
} from "./pidfile.js"
import { stopProcessGroup, groupAlive, SelfKillError } from "./group.js"

// 实测样本（computer2 2026-09-02，`ps -axo pid=,ppid=,pgid=,command=`）
const CHATGPT_PLAIN =
  "/Applications/ChatGPT.app/Contents/Resources/codex app-server --listen stdio://"
const CHATGPT_CODEMODE =
  '/Applications/ChatGPT.app/Contents/Resources/codex -c features.code_mode_host=true app-server --analytics-default-enabled -c mcp_servers.codex_app={"command"="/x"}'
const OUR_WRAPPER =
  'node /opt/homebrew/bin/codex app-server --listen stdio:// -c notify=[] -c codex_seat.tag="e2e-ab12/7f3c9a01"'
const OUR_RUST =
  '/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex app-server --listen stdio:// -c notify=[] -c codex_seat.tag="e2e-ab12/7f3c9a01"'
const OTHER_SEAT =
  'node /opt/homebrew/bin/codex app-server --listen stdio:// -c notify=[] -c codex_seat.tag="codex-main/aaaabbbb"'
// mini / computer1 的 codex-main2：config.codex.bin 直接指 ChatGPT.app 内置的 codex（0.152.1）。
// 于是「我们的进程」与「ChatGPT 自己的进程」共用同一条二进制路径 —— 只有席位标签能把它俩分开。
const OUR_VIA_CHATGPT_BIN =
  '/Applications/ChatGPT.app/Contents/Resources/codex app-server --listen stdio:// -c notify=[] -c codex_seat.tag="codex-main2/7f3c9a01"'
const OTHER_SEAT_VIA_CHATGPT_BIN =
  '/Applications/ChatGPT.app/Contents/Resources/codex app-server --listen stdio:// -c notify=[] -c codex_seat.tag="codex-main/aaaabbbb"'

function fakeOps(procs: ProcInfo[]): SysProcOps & { killed: Array<{ target: number; signal: string }> } {
  const killed: Array<{ target: number; signal: string }> = []
  const live = new Map(procs.map((p) => [p.pid, p]))
  return {
    killed,
    isAlive: (pid) => live.has(pid),
    cmdline: (pid) => live.get(pid)?.command ?? null,
    kill(pid, signal) {
      killed.push({ target: pid, signal })
      if (signal === "SIGKILL") live.delete(pid)
    },
    pgidOf: (pid) => live.get(pid)?.pgid ?? null,
    list: () => [...live.values()],
    killGroup(pgid, signal) {
      killed.push({ target: -pgid, signal })
      if (signal === "SIGKILL") for (const p of [...live.values()]) if (p.pgid === pgid) live.delete(p.pid)
    },
    groupPids: (pgid) => [...live.values()].filter((p) => p.pgid === pgid).map((p) => p.pid),
  }
}

describe("ps 表解析", () => {
  it("拆出 pid/ppid/pgid，命令行原样保留（含空格与等号）", () => {
    const out = [
      " 60315 60314 60283 " + OUR_WRAPPER,
      "  4320  2320  2320 " + CHATGPT_PLAIN,
      "",
    ].join("\n")
    const rows = parsePsTable(out)
    assert.equal(rows.length, 2)
    assert.deepEqual(
      { pid: rows[0]!.pid, ppid: rows[0]!.ppid, pgid: rows[0]!.pgid },
      { pid: 60315, ppid: 60314, pgid: 60283 },
    )
    assert.equal(rows[0]!.command, OUR_WRAPPER)
    assert.equal(rows[1]!.pid, 4320)
  })

  it("丢掉表头/垃圾行而不是崩", () => {
    assert.deepEqual(parsePsTable("PID PPID PGID COMMAND\nnot a row\n"), [])
  })
})

describe("席位标签", () => {
  it("标签形如 codex_seat.tag=\"<seat>/<instanceId>\"，args 带 -c", () => {
    assert.equal(seatTag("codex-main", "abc123"), `${SEAT_TAG_KEY}="codex-main/abc123"`)
    assert.deepEqual(seatTagArgs("codex-main", "abc123"), ["-c", `${SEAT_TAG_KEY}="codex-main/abc123"`])
  })
})

describe("孤儿谓词（这一节红了就说明会误杀 ChatGPT）", () => {
  it("认得出自己席位的 wrapper 与 rust 本体", () => {
    assert.equal(isOurAppServerCmd(OUR_WRAPPER, "e2e-ab12"), true)
    assert.equal(isOurAppServerCmd(OUR_RUST, "e2e-ab12"), true)
  })

  it("绝不认 ChatGPT.app 自己的 app-server（两种真实命令行）", () => {
    assert.equal(isOurAppServerCmd(CHATGPT_PLAIN, "e2e-ab12"), false)
    assert.equal(isOurAppServerCmd(CHATGPT_CODEMODE, "e2e-ab12"), false)
  })

  it("带本席位标签的就是我们的，哪怕二进制在 ChatGPT.app 里（标签优先于路径）", () => {
    const ours = `${CHATGPT_PLAIN} -c ${SEAT_TAG_KEY}="e2e-ab12/deadbeef"`
    assert.equal(isOurAppServerCmd(ours, "e2e-ab12"), true)
  })

  it("不认别的席位的进程", () => {
    assert.equal(isOurAppServerCmd(OTHER_SEAT, "e2e-ab12"), false)
  })

  it("没有 app-server 子命令的 codex 进程不算（比如 codex exec）", () => {
    assert.equal(
      isOurAppServerCmd(`node /opt/homebrew/bin/codex exec -c ${SEAT_TAG_KEY}="e2e-ab12/x"`, "e2e-ab12"),
      false,
    )
  })

  it("席位名是别人 tag 的前缀时不误伤（e2e-ab 不该匹配 e2e-ab12）", () => {
    assert.equal(isOurAppServerCmd(OUR_WRAPPER, "e2e-ab"), false)
  })
})

/**
 * mini / computer1 的 `codex-main2` 把 `codex.bin` 指到了 `/Applications/ChatGPT.app/Contents/Resources/codex`
 * （0.152.1）。老实现在这里做的是**路径级硬否决**（含 ChatGPT.app 就一律不认），
 * 于是这两台席位自己起的 app-server 也被否掉 —— `status` 的 orphans 恒为 0、RUNBOOK §4.2 的清理路径整条失效，
 * 而且失效方式是「一切正常」，没有任何报错。这就是坏尺子伪装成发现。
 *
 * 改成**席位标签优先**：命令行里带我们注入的 `codex_seat.tag="<seat>/<instanceId>"` 就是我们的进程，
 * 二进制在哪都认；只有**无标签**的命令行才走路径否决 —— ChatGPT.app 自己起的 app-server 从不带这个 tag
 * （它的两条真实命令行 CHATGPT_PLAIN / CHATGPT_CODEMODE 就在上面，逐字抄自 ps），所以保护一点没丢。
 */
describe("codex.bin 指 ChatGPT.app 内置版时（mini/computer1 codex-main2）", () => {
  it("① ChatGPT.app 路径 + 我们的标签 → 认（否则这两台的孤儿检测恒为 0）", () => {
    assert.equal(isOurAppServerCmd(OUR_VIA_CHATGPT_BIN, "codex-main2"), true)
  })

  it("② ChatGPT.app 路径 + 无标签 → 拒（原保护必须保留，别杀 aster 的 ChatGPT）", () => {
    assert.equal(isOurAppServerCmd(CHATGPT_PLAIN, "codex-main2"), false)
    assert.equal(isOurAppServerCmd(CHATGPT_CODEMODE, "codex-main2"), false)
  })

  it("③ 别的席位的标签 → 拒（npm 路径和 ChatGPT.app 路径都一样）", () => {
    assert.equal(isOurAppServerCmd(OTHER_SEAT, "codex-main2"), false)
    assert.equal(isOurAppServerCmd(OTHER_SEAT_VIA_CHATGPT_BIN, "codex-main2"), false)
  })

  it("扫描层：认得出上一代 ChatGPT.app-bin 孤儿，同时放过 ChatGPT 自己", () => {
    const procs: ProcInfo[] = [
      { pid: 100, ppid: 1, pgid: 100, command: OUR_VIA_CHATGPT_BIN }, // 当代引擎
      { pid: 200, ppid: 1, pgid: 200, command: OUR_VIA_CHATGPT_BIN }, // 上一代真孤儿
      { pid: 4320, ppid: 2320, pgid: 2320, command: CHATGPT_PLAIN }, // aster 的 ChatGPT
      { pid: 4321, ppid: 2320, pgid: 2320, command: CHATGPT_CODEMODE },
      { pid: 300, ppid: 1, pgid: 300, command: OTHER_SEAT_VIA_CHATGPT_BIN },
    ]
    const found = findOrphans({ seat: "codex-main2", ops: fakeOps(procs), excludePgid: 100, excludePids: [] })
    assert.deepEqual(found.map((o) => o.pid), [200])
  })
})

describe("孤儿扫描", () => {
  const procs: ProcInfo[] = [
    { pid: 100, ppid: 1, pgid: 100, command: OUR_WRAPPER },
    { pid: 101, ppid: 100, pgid: 100, command: OUR_RUST },
    { pid: 200, ppid: 1, pgid: 200, command: OUR_RUST }, // 上一代留下的真孤儿
    { pid: 4320, ppid: 2320, pgid: 2320, command: CHATGPT_PLAIN },
    { pid: 300, ppid: 1, pgid: 300, command: OTHER_SEAT },
  ]

  it("排除当前引擎进程组，只留上一代", () => {
    const found = findOrphans({ seat: "e2e-ab12", ops: fakeOps(procs), excludePgid: 100 })
    assert.deepEqual(found.map((o) => o.pid), [200])
  })

  it("不给 excludePgid 时两组都算孤儿，但永远不含 ChatGPT/别的席位", () => {
    const found = findOrphans({ seat: "e2e-ab12", ops: fakeOps(procs) })
    assert.deepEqual(found.map((o) => o.pid).sort((a, b) => a - b), [100, 101, 200])
  })

  it("excludePids 里的 pid 不算孤儿（自己/父进程）", () => {
    const found = findOrphans({ seat: "e2e-ab12", ops: fakeOps(procs), excludePids: [200] })
    assert.equal(found.some((o) => o.pid === 200), false)
  })
})

describe("pid 文件", () => {
  const rec: PidFileRecord = {
    pid: 100,
    pgid: 100,
    startedAt: "2026-09-02T00:00:00.000Z",
    cmdline: OUR_WRAPPER,
    instanceId: "7f3c9a01",
  }

  it("序列化/反序列化往返", () => {
    assert.deepEqual(parsePidFile(serializePidFile(rec)), rec)
  })

  it("认得旧格式（裸 pid 数字），pgid 回落到 pid", () => {
    const got = parsePidFile("100\n")
    assert.equal(got?.pid, 100)
    assert.equal(got?.pgid, 100)
    assert.equal(got?.instanceId, null)
  })

  it("垃圾内容返回 null 而不是抛", () => {
    assert.equal(parsePidFile("{{{"), null)
    assert.equal(parsePidFile(""), null)
    assert.equal(parsePidFile("0"), null)
  })

  it("命令行不匹配 = mismatch（pid 复用防误杀）", () => {
    const ops = fakeOps([{ pid: 100, ppid: 1, pgid: 100, command: "/usr/bin/vim notes.txt" }])
    assert.equal(checkPidFile(rec, ops, "e2e-ab12"), "mismatch")
  })

  it("进程没了 = dead；对得上 = alive；没有记录 = missing", () => {
    assert.equal(checkPidFile(rec, fakeOps([]), "e2e-ab12"), "dead")
    assert.equal(
      checkPidFile(rec, fakeOps([{ pid: 100, ppid: 1, pgid: 100, command: OUR_WRAPPER }]), "e2e-ab12"),
      "alive",
    )
    assert.equal(checkPidFile(null, fakeOps([]), "e2e-ab12"), "missing")
  })
})

describe("进程组停止", () => {
  const live = (): ProcInfo[] => [
    { pid: 100, ppid: 1, pgid: 100, command: OUR_WRAPPER },
    { pid: 101, ppid: 100, pgid: 100, command: OUR_RUST },
  ]

  it("先 TERM 后 KILL，打的是 -pgid 不是 pid", async () => {
    const ops = fakeOps(live())
    const r = await stopProcessGroup(100, 100, ops, { graceMs: 30, pollMs: 5 })
    assert.deepEqual(ops.killed[0], { target: -100, signal: "SIGTERM" })
    assert.equal(ops.killed.some((k) => k.target === -100 && k.signal === "SIGKILL"), true)
    assert.equal(r.escalated, true)
    assert.equal(r.alive, false)
  })

  it("TERM 就退了就不升级到 KILL", async () => {
    const ops = fakeOps(live())
    const orig = ops.killGroup
    ops.killGroup = (pgid, signal) => {
      orig(pgid, signal)
      if (signal === "SIGTERM") for (const p of ops.list()) if (p.pgid === pgid) ops.kill(p.pid, "SIGKILL")
    }
    const r = await stopProcessGroup(100, 100, ops, { graceMs: 200, pollMs: 5 })
    assert.equal(r.escalated, false)
    assert.equal(ops.killed.some((k) => k.target === -100 && k.signal === "SIGKILL"), false)
  })

  it("wrapperOnly 只杀 wrapper pid，rust 本体活着变孤儿（E08 的故障注入）", async () => {
    const ops = fakeOps(live())
    const r = await stopProcessGroup(100, 100, ops, { graceMs: 20, pollMs: 5, wrapperOnly: true })
    assert.equal(r.mode, "wrapper-only")
    assert.equal(ops.killed.every((k) => k.target > 0), true, "不许出现负数目标（那是整组）")
    assert.equal(ops.isAlive(101), true, "rust 本体必须还活着")
  })

  it("拒绝杀自己所在的进程组（写这套时真自杀过一次）", async () => {
    const ops = fakeOps(live())
    await assert.rejects(
      () => stopProcessGroup(process.pid, process.pid, ops, { selfPgid: process.pid }),
      SelfKillError,
    )
  })

  it("拒绝 pgid <= 1（那是 init / 整个会话）", async () => {
    const ops = fakeOps(live())
    await assert.rejects(() => stopProcessGroup(100, 1, ops), SelfKillError)
    await assert.rejects(() => stopProcessGroup(100, 0, ops), SelfKillError)
  })

  it("groupAlive 只看该组还有没有进程", () => {
    const ops = fakeOps(live())
    assert.equal(groupAlive(100, ops), true)
    assert.equal(groupAlive(999, ops), false)
  })
})
